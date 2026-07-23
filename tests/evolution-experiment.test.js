// The evolution experiment's ONLY CI touchpoint.
//
// THE REGRESSION-ASYMMETRY RULE, restated for this instrument: an experiment is
// not a gate. CI checks the STRUCTURE of the protocol, the ARITHMETIC of every
// metric, and the DECISION LOGIC over hand-authored matrices — and nothing else.
// No fitness magnitude, no diversity magnitude, no timing, and no "the
// population improved" is asserted anywhere in this file. If a future engine, a
// future terrain or a future tuning changes what the experiment OBSERVES, this
// file must stay green.
//
// WHY THIS FILE IS COMMITTED BEFORE THE BROAD RUN. Every test here was written
// and frozen before a single screening run executed. A decision rule tested
// after its inputs are known is a rule fitted to its answer; the protocol's
// whole claim to authority is that its gates were declared first, and this file
// is the executable form of that declaration.
//
// It also pins the property that is easy to lose by accident: importing the
// experiment module must NOT start an experiment.

import { describe, test, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  BASELINE_ARM_ID, CONTROL_ARM_ID, EXPERIMENT_PHASES, EXPERIMENT_RUN_SCHEMA, EXPERIMENT_SCHEMA,
  ADOPTION_RULING, EVIDENCE_DIGEST_KEYS, FORENSIC_SAMPLE, canonicalDigest, evidenceSubset,
  fitnessPlausibilityCeiling, fitnessPlausibilityObservations, forensicCasePlan,
  summarizeEscalationRows, forensicSamplePlans, buildForensicReport,
  readSourceIdentity, resetSmokeWorkspace, shouldRunAsScript,
  SYMMETRY_GENE_THRESHOLD, armIdFor, buildExecutionSchedule, buildExperimentProtocol,
  buildExperimentReport, canonicalJson, confirmDecision, configFromArgs, executeExperimentPhase,
  finalGeneration, geneDistance, geneSpaceDispersion, medianOrNull, pairedComparison,
  pairingCoherence, runScore, screenCandidates, summarizeEvolutionHistory, summarizeFitnessRows,
  validateProtocol,
} from '../scripts/experiment-evolution.js';
import { EVOLUTION_FIXTURE_A, evolutionRunConfigFor } from '../src/sim/evolution-fixtures.js';
import { createEvolutionRun } from '../src/sim/evolution-run.js';
import {
  compileAssembly, deserializeGenotype, genotypeFieldWalk, randomGenotype, repairGenotype,
  serializeGenotype,
} from '../src/sim/assembly.js';
import { Rng } from '../src/sim/prng.js';

// --- Shared helpers ----------------------------------------------------------

/** A fresh, repaired, canonical genotype. */
function genotypeFor(seed) {
  return deserializeGenotype(serializeGenotype(repairGenotype(randomGenotype(new Rng(seed)))));
}

/** The same genotype with its axle list truncated — a controlled topology change. */
function withAxleCount(genotype, count) {
  const copy = deserializeGenotype(serializeGenotype(genotype));
  copy.axles = copy.axles.slice(0, count);
  return deserializeGenotype(serializeGenotype(copy));
}

/** Minimal generation record: only the fields the decision layer reads. */
function generation(overrides = {}) {
  return {
    generationIndex: 0,
    terminalReason: 'none',
    populationSize: 20,
    champion: { individualId: 1, fitness: 10 },
    selectableCount: 20,
    selectableRate: 1,
    uniquenessRatio: 1,
    geneSpaceDispersion: 0.2,
    populationDigest: 'deadbeef',
    ...overrides,
  };
}

/** Minimal run record: only the fields the decision layer reads. */
function runRecord({
  armId, probability, magnitude, replicateIndex, phase = 'screen',
  finalFitness = 10, terminalReason = 'generationLimitReached',
  selectableRate = 1, uniquenessRatio = 1, dispersion = 0.2, baseFitness = 1,
  populationDigest = 'deadbeef',
}) {
  return {
    runId: `${phase}:${armId}:r${replicateIndex}`,
    phase,
    armId,
    probability,
    magnitude,
    replicateIndex,
    summary: {
      terminalReason,
      generations: [
        generation({
          generationIndex: 0,
          champion: baseFitness === null ? null : { individualId: 0, fitness: baseFitness },
          populationDigest,
        }),
        generation({
          generationIndex: 1,
          terminalReason,
          champion: finalFitness === null ? null : { individualId: 1, fitness: finalFitness },
          selectableRate,
          selectableCount: Math.round(selectableRate * 20),
          uniquenessRatio,
          geneSpaceDispersion: dispersion,
          populationDigest,
        }),
      ],
    },
  };
}

/**
 * A full arm's worth of runs. `finalFitness` may be a constant, a per-replicate
 * function, or `null` (no selectable champion).
 *
 * The nullish default is `Object.hasOwn`, NOT `?? 10`: the first draft used the
 * latter, which silently turned an explicit `finalFitness: null` into 10 and
 * made the "a null median is never ranked" test pass against a fully-finite arm.
 * A test helper that cannot express the value under test disables the test
 * without failing it.
 */
function armRuns(armId, probability, magnitude, replicateCount, opts = {}) {
  const out = [];
  for (let r = 0; r < replicateCount; r += 1) {
    const declared = Object.hasOwn(opts, 'finalFitness') ? opts.finalFitness : 10;
    out.push(runRecord({
      armId, probability, magnitude, replicateIndex: r, ...opts,
      finalFitness: typeof declared === 'function' ? declared(r) : declared,
    }));
  }
  return out;
}

// --- 0. The premises the metrics rest on -------------------------------------

describe('experiment: the premises the metrics rest on', () => {
  test('the canonical field walk is a PREFIX-EXTENSION in the axle count', () => {
    // This is exactly what makes an index-aligned gene comparison correct: a
    // genotype with more axles has every path a smaller one has, at the same
    // index, plus a tail. geneDistance's "present on only one side" branch is
    // sound only because of this, so it is asserted rather than assumed.
    for (let n = 1; n < 6; n += 1) {
      const small = genotypeFieldWalk(n);
      const large = genotypeFieldWalk(n + 1);
      expect(large.length).toBeGreaterThan(small.length);
      for (let i = 0; i < small.length; i += 1) {
        expect(large[i].path).toBe(small[i].path);
        expect(large[i].type).toBe(small[i].type);
        expect(large[i].byteOffset).toBe(small[i].byteOffset);
      }
    }
  });

  test('SYMMETRY_GENE_THRESHOLD is bound BEHAVIOURALLY to compileAssembly', () => {
    // assembly.js does not export its boolean gene decoder, so this constant is
    // a copy — and a copied decode rule is precisely the class that let a
    // SUSPENSION_TYPES reorder flip every archived axle while both locks stayed
    // byte-identical. Bind it to the production compiler instead of trusting the
    // literal: a genotype with a NON-NEUTRAL latent asym block must have that
    // asymmetry SUPPRESSED at/above the threshold and EXPRESSED below it.
    //
    // THE DISCRIMINATOR IS A SINGLE AXLE'S centerOffset, not a paired module's
    // sizeBias. Measured while writing this test: with a base radius near the
    // top of the band, repair rule R3b clamps sizeBias to exactly the NEUTRAL
    // factor (f = 1, the always-in-band value its docblock names), so both
    // wheels come out bit-identical on BOTH sides of the threshold and the test
    // would have passed for the wrong reason on one side and failed on the
    // other. centerOffset has no such collapse: symmetry snaps a single wheel to
    // the centerline, so the two sides differ by the whole offset.
    const base = genotypeFor(20260710);
    const single = deserializeGenotype(serializeGenotype(base));
    single.axles = single.axles.slice(0, 1);
    single.axles[0].paired = 0;             // one wheel, placed by centerOffset
    single.axles[0].asym.centerOffset = 1;  // maximally non-neutral

    const belowGene = SYMMETRY_GENE_THRESHOLD - 1e-9;
    const asymmetric = deserializeGenotype(serializeGenotype({ ...single, symmetric: belowGene }));
    const symmetric = deserializeGenotype(serializeGenotype({ ...single, symmetric: SYMMETRY_GENE_THRESHOLD }));

    const zOf = (g) => compileAssembly(g).axles[0].wheels[0].z;

    // Below the threshold the offset is expressed, so the wheel is off-centre.
    expect(zOf(asymmetric)).not.toBe(0);
    // At the threshold symmetry gates it and the wheel snaps to the centreline.
    expect(zOf(symmetric)).toBe(0);
  });
});

// --- 1. Canonical JSON -------------------------------------------------------

describe('experiment: canonical JSON', () => {
  test('key order is sorted, so insertion order cannot change a digest', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  test('array order is preserved, because array order IS semantic', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  test.each([
    ['NaN', { x: NaN }],
    ['Infinity', { x: Infinity }],
    ['-Infinity', { x: -Infinity }],
    ['undefined', { x: undefined }],
  ])('%s is REFUSED rather than coerced', (_name, value) => {
    // JSON.stringify turns the first three into `null` and drops the fourth. A
    // digest that cannot tell "absent" from "not a number" attests nothing.
    expect(() => canonicalJson(value)).toThrow(/experiment-evolution/);
  });

  test('-0 and 0 do not share a spelling', () => {
    expect(canonicalJson({ x: -0 })).toBe('{"x":-0}');
    expect(canonicalJson({ x: 0 })).toBe('{"x":0}');
  });

  test('null is a first-class value, not an error', () => {
    expect(canonicalJson({ champion: null })).toBe('{"champion":null}');
  });
});

// --- 2. Pure metrics ---------------------------------------------------------

describe('experiment: medianOrNull', () => {
  test('odd and even lengths use the declared positions', () => {
    expect(medianOrNull([3, 1, 2])).toBe(2);
    expect(medianOrNull([4, 1, 3, 2])).toBe(2.5);
  });

  test('a null ranks BELOW every finite value and drags the median DOWN', () => {
    // The full ascending order is [null, 1, 2, 3, 4, 5]; positions 2 and 3 are
    // 2 and 3, so the median is 2.5 — strictly BELOW the 3 that the same finite
    // values give on their own. A failed replicate must never improve an arm.
    //
    // THE FIRST DRAFT ASSERTED 3.5 HERE, under the title "nulls sort to the TAIL
    // and do not shift a still-finite median" — a title its own assertion
    // falsified, since 3.5 is not 3. It locked in an implementation that ranked
    // null as the LARGEST value. Both the rule and the direction are asserted
    // now, so neither can drift without this failing.
    expect(medianOrNull([5, 4, 3, 2, 1, null])).toBe(2.5);
    expect(medianOrNull([5, 4, 3, 2, 1])).toBe(3);
    expect(medianOrNull([5, 4, 3, 2, 1, null]))
      .toBeLessThan(medianOrNull([5, 4, 3, 2, 1]));
  });

  test('adding a null never RAISES a median, for any finite list', () => {
    // The property, not the example: this is the rule the first draft broke, and
    // an example-only test is what let it through.
    const lists = [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4], [0, 10, 20, 30, 40], [5, 5, 5]];
    for (const list of lists) {
      const withoutNull = medianOrNull(list);
      const withNull = medianOrNull([...list, null]);
      if (withNull !== null) expect(withNull).toBeLessThanOrEqual(withoutNull);
    }
  });

  test('a null ON a median position makes the median null', () => {
    // [null, null, null, 1, 2, 3]; positions 2 and 3 are null and 1.
    expect(medianOrNull([1, 2, 3, null, null, null])).toBeNull();
    expect(medianOrNull([null, null, null])).toBeNull();
  });

  test('medianOrNull and pairedComparison encode the SAME declared rule', () => {
    // Two sites, one rule. They disagreed in the first draft: pairedComparison
    // had it right ("null loses to any finite value") while medianOrNull had it
    // backwards. Bind them together so a future edit to either is caught.
    const arm = [runRecord({ armId: 'x', probability: 0.1, magnitude: 0.1, replicateIndex: 0, finalFitness: null })];
    const ref = [runRecord({ armId: 'y', probability: 0.05, magnitude: 0.05, replicateIndex: 0, finalFitness: 1 })];
    expect(pairedComparison(arm, ref).wins).toBe(0);          // null ranks below
    expect(medianOrNull([1, null])).toBeNull();               // ...and so here
    expect(medianOrNull([1, 2, null])).toBe(1);               // [null, 1, 2] -> 1
  });

  test('an empty list is null, and a non-finite input is refused', () => {
    expect(medianOrNull([])).toBeNull();
    expect(() => medianOrNull([1, NaN])).toThrow(/finite number or null/);
    expect(() => medianOrNull([1, Infinity])).toThrow(/finite number or null/);
  });
});

describe('experiment: gene-space distance', () => {
  const a = genotypeFor(20260732);
  const b = genotypeFor(20260733);

  test('a genotype is at distance 0 from itself and from an identical copy', () => {
    expect(geneDistance(a, a)).toBe(0);
    expect(geneDistance(a, deserializeGenotype(serializeGenotype(a)))).toBe(0);
  });

  test('distance is symmetric and lands in [0, 1]', () => {
    const d = geneDistance(a, b);
    expect(d).toBe(geneDistance(b, a));
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(1);
  });

  test('a TOPOLOGY mismatch charges exactly 1 per unmatched path', () => {
    // Same genes, fewer axles: every shared path is identical, so the whole
    // distance is the unmatched tail — an exact arithmetic identity, not a band.
    const two = withAxleCount(a, 2);
    const one = withAxleCount(a, 1);
    const shared = genotypeFieldWalk(1).filter((e) => e.type === 'f64').length;
    const union = genotypeFieldWalk(2).filter((e) => e.type === 'f64').length;
    expect(geneDistance(two, one)).toBe((union - shared) / union);
  });

  test('dispersion is 0 for a population of identical genotypes', () => {
    const clone = () => ({ individualId: 0, genotype: a });
    const members = [0, 1, 2, 3].map((id) => ({ ...clone(), individualId: id }));
    expect(geneSpaceDispersion(members)).toBe(0);
  });

  test('dispersion is null for a population too small to have a pair', () => {
    expect(geneSpaceDispersion([{ individualId: 0, genotype: a }])).toBeNull();
    expect(geneSpaceDispersion([])).toBeNull();
  });

  test('dispersion is the mean of the pairwise distances, in ascending-id order', () => {
    const members = [
      { individualId: 2, genotype: b },
      { individualId: 0, genotype: a },
      { individualId: 1, genotype: withAxleCount(a, 1) },
    ];
    const g = new Map(members.map((m) => [m.individualId, m.genotype]));
    const expected = (
      geneDistance(g.get(0), g.get(1))
      + geneDistance(g.get(0), g.get(2))
      + geneDistance(g.get(1), g.get(2))
    ) / 3;
    // Exact: the metric sorts a copy by id, so the caller's order cannot change
    // the floating-point accumulation.
    expect(geneSpaceDispersion(members)).toBe(expected);
  });
});

describe('experiment: fitness-row fold', () => {
  const row = (individualId, valid, integrityStatus, fitness) => ({
    individualId, valid, integrityStatus, fitness,
  });

  test('a generation with NO selectable individual has a null champion, not zero', () => {
    const out = summarizeFitnessRows([
      row(0, false, 'ok', 0),
      row(1, true, 'numericalDivergence', 0),
      row(2, true, 'nonFinite', 0),
    ]);
    expect(out.champion).toBeNull();
    expect(out.selectableCount).toBe(0);
    expect(out.quartiles).toBeNull();
    expect(out.validCount).toBe(2);
    expect(out.integrityStatusCounts).toEqual({ ok: 1, nonFinite: 1, numericalDivergence: 1 });
  });

  test('an integrity-failed row is counted but never selectable, however valid', () => {
    const out = summarizeFitnessRows([
      row(0, true, 'numericalDivergence', 0),
      row(1, true, 'ok', 5),
    ]);
    expect(out.champion).toEqual({ individualId: 1, fitness: 5 });
    expect(out.selectableCount).toBe(1);
  });

  test('a tie at the top keeps the LOWEST individual id', () => {
    const out = summarizeFitnessRows([
      row(3, true, 'ok', 9),
      row(7, true, 'ok', 9),
    ]);
    expect(out.champion).toEqual({ individualId: 3, fitness: 9 });
  });

  test('quartiles cover only the selectable rows', () => {
    const out = summarizeFitnessRows([
      row(0, true, 'ok', 1),
      row(1, true, 'ok', 2),
      row(2, true, 'ok', 3),
      row(3, false, 'ok', 0),
    ]);
    expect(out.quartiles).toEqual({ min: 1, q1: 1.5, median: 2, q3: 2.5, max: 3 });
  });
});

describe('experiment: run score', () => {
  const summaryOf = (base, final) => ({
    generations: [
      generation({ champion: base === null ? null : { individualId: 0, fitness: base } }),
      generation({ champion: final === null ? null : { individualId: 1, fitness: final } }),
    ],
  });

  test('a run that ends where it started scores exactly 0', () => {
    expect(runScore(summaryOf(4, 4))).toBe(0);
  });

  test('the score is the log-ratio, so equal RATIOS score equally', () => {
    expect(runScore(summaryOf(1, 3))).toBeCloseTo(Math.log1p(3) - Math.log1p(1), 12);
    expect(runScore(summaryOf(0, 0))).toBe(0);
  });

  test('a missing champion at either endpoint scores null', () => {
    expect(runScore(summaryOf(null, 10))).toBeNull();
    expect(runScore(summaryOf(10, null))).toBeNull();
    expect(runScore(summaryOf(null, null))).toBeNull();
  });

  test('a TERMINAL GENERATION ZERO run scores 0 — first and last are one record', () => {
    const single = { generations: [generation({ champion: { individualId: 0, fitness: 7 } })] };
    expect(finalGeneration(single).champion.fitness).toBe(7);
    expect(runScore(single)).toBe(0);
  });
});

// --- 3. summarizeEvolutionHistory over a REAL artifact ------------------------

describe('experiment: summarizing a real evolution history', () => {
  test('the committed fixture summarizes into a well-formed, finite record',
    { timeout: 240000 }, async () => {
      const run = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
      let result;
      do { result = await run.advance(); } while (result.kind !== 'terminal');
      const summary = summarizeEvolutionHistory(run.historyBytes());

      expect(summary.generationCount).toBe(EVOLUTION_FIXTURE_A.maxGenerations);
      expect(summary.terminalReason).toBe('generationLimitReached');
      // The header ECHOES the fixture's declared numbers: a run record that
      // claims an arm it did not execute is the one silent failure that would
      // corrupt every aggregate.
      expect(summary.header.mutationProbability).toBe(EVOLUTION_FIXTURE_A.mutationProbability);
      expect(summary.header.mutationMagnitude).toBe(EVOLUTION_FIXTURE_A.mutationMagnitude);
      expect(summary.header.populationSize).toBe(EVOLUTION_FIXTURE_A.populationSize);
      expect(summary.evaluation.worldMode).toBe('isolatedWorlds');
      expect(summary.evaluation.executedSteps).toBe(EVOLUTION_FIXTURE_A.maxSteps);
      expect(summary.historyDigest).toMatch(/^[0-9a-f]{64}$/);

      for (const g of summary.generations) {
        expect(g.populationSize).toBe(EVOLUTION_FIXTURE_A.populationSize);
        expect(g.uniqueGenotypeCount).toBeGreaterThan(0);
        expect(g.uniqueGenotypeCount).toBeLessThanOrEqual(g.populationSize);
        expect(g.uniquenessRatio).toBe(g.uniqueGenotypeCount / g.populationSize);
        expect(g.geneSpaceDispersion).toBeGreaterThanOrEqual(0);
        expect(g.geneSpaceDispersion).toBeLessThanOrEqual(1);
        expect(g.selectableCount).toBeLessThanOrEqual(g.validCount);
        expect(g.selectableRate).toBe(g.selectableCount / g.populationSize);
        // Integrity statuses partition the population exactly.
        const statuses = Object.values(g.integrityStatusCounts).reduce((s, v) => s + v, 0);
        expect(statuses).toBe(g.populationSize);
        // Lineage origins partition it too.
        const origins = Object.values(g.lineage.originCounts).reduce((s, v) => s + v, 0);
        expect(origins).toBe(g.populationSize);
        // Morphology histograms are complete counts, not samples.
        const families = Object.values(g.morphology.frameFamily).reduce((s, v) => s + v, 0);
        expect(families).toBe(g.populationSize);
        if (g.champion !== null) expect(Number.isFinite(g.champion.fitness)).toBe(true);
      }

      // Structural coverage, mirroring the determinism gate's own rule: the
      // fixture must actually EXERCISE the mechanism the metrics describe.
      expect(summary.generations[0].lineage.originCounts.initialized)
        .toBe(EVOLUTION_FIXTURE_A.populationSize);
      expect(summary.generations[1].lineage.originCounts.eliteCopy).toBeGreaterThan(0);
      expect(summary.generations[1].lineage.originCounts.continuousMutation).toBeGreaterThan(0);

      // The whole summary must be canonical-JSON-serializable — i.e. free of
      // NaN, Infinity and undefined. That is the contract the evidence digest
      // depends on, and it is checked here rather than discovered at report time.
      expect(() => canonicalJson(summary)).not.toThrow();
    });

  test('a ONE-generation history summarizes: first and last are the same record',
    { timeout: 240000 }, async () => {
      const config = evolutionRunConfigFor(EVOLUTION_FIXTURE_A);
      config.evolution.maxGenerations = 1;
      const run = createEvolutionRun(config);
      let result;
      do { result = await run.advance(); } while (result.kind !== 'terminal');
      const summary = summarizeEvolutionHistory(run.historyBytes());
      expect(summary.generationCount).toBe(1);
      expect(summary.generations[0].terminalReason).toBe('generationLimitReached');
      expect(runScore(summary)).toBe(0);
    });
});

// --- 4. Protocol -------------------------------------------------------------

describe('experiment: the predeclared protocol', () => {
  const protocol = buildExperimentProtocol();

  test('the declared shape is the one the report claims', () => {
    expect(protocol.schema).toBe(EXPERIMENT_SCHEMA);
    expect(protocol.kind).toBe('full');
    expect(protocol.citable).toBe(true);
    expect(protocol.workload.populationSize).toBe(20);
    expect(protocol.workload.maxSteps).toBe(300);
    expect(protocol.workload.deterministic).toBe(true);
    expect(protocol.screen.arms).toHaveLength(26); // control + a 5x5 grid
    expect(protocol.screen.replicates).toHaveLength(6);
    expect(protocol.screen.generations).toBe(30);
    expect(protocol.confirm.replicates).toHaveLength(16);
    expect(protocol.confirm.generations).toBe(60);
    expect(protocol.baselineArmId).toBe(armIdFor(0.05, 0.05));
    expect(protocol.controlArmId).toBe('control');
    expect(protocol.screen.arms.map((a) => a.armId)).toContain(BASELINE_ARM_ID);
    expect(protocol.screen.arms.map((a) => a.armId)).toContain(CONTROL_ARM_ID);
  });

  test('every declared threshold is pinned to its EXACT value', () => {
    // The experiment's whole claim to authority is that these NUMBERS were
    // declared before any result was seen. A test that only proves a threshold
    // exists would let it be quietly relaxed to fit an answer, which is the one
    // way this instrument could lie while staying green.
    expect(protocol.screen.eligibility).toEqual({
      maxNoSelectableParentsTerminationsVsBaseline: 0,
      selectableRateFloorPointsBelowBaseline: 10,
      dispersionFloorFractionOfBaseline: 0.70,
    });
    expect(protocol.confirm.gates).toEqual({
      minPairedWins: 12,
      selectableRateFloorPointsBelowBaseline: 5,
      uniquenessFloorPointsBelowBaseline: 10,
      dispersionFloorFractionOfBaseline: 0.80,
      maxNoSelectableParentsTerminationsVsBaseline: 0,
    });
    expect(protocol.schedulingSeed).toBe(20260788);
    expect(protocol.screen.replicates.map((r) => r.populationSeed))
      .toEqual([20260744, 20260745, 20260746, 20260747, 20260748, 20260749]);
    expect(protocol.screen.replicates.map((r) => r.terrainSeed))
      .toEqual([20260750, 20260751, 20260752, 20260753, 20260754, 20260755]);
    expect(protocol.confirm.replicates[0]).toEqual({
      replicateIndex: 0, populationSeed: 20260756, terrainSeed: 20260772,
    });
    expect(protocol.confirm.replicates[15]).toEqual({
      replicateIndex: 15, populationSeed: 20260771, terrainSeed: 20260787,
    });
  });

  test('each confirmation floor bites EXACTLY at its declared value', () => {
    // Not "a bad value fails" — that only proves a floor exists somewhere. These
    // straddle each declared threshold, so moving any of the three numbers turns
    // one of these assertions red.
    const R = protocol.confirm.replicates.length;
    const gates = protocol.confirm.gates;
    const mk = (armId, p, m, opts) => armRuns(armId, p, m, R, { phase: 'confirm', ...opts });
    const decide = (opts) => confirmDecision(protocol, [
      ...mk('p0.200-m0.200', 0.2, 0.2, { finalFitness: 20, ...opts }),
      ...mk(BASELINE_ARM_ID, 0.05, 0.05, { finalFitness: 10 }),
      ...mk(CONTROL_ARM_ID, 0, 0, { finalFitness: 2 }),
    ], 'p0.200-m0.200');
    const check = (out, name) => out.candidate.checks.find((c) => c.name === name).pass;

    // Baseline sits at selectableRate 1.0; the floor is 5 points below it, i.e.
    // 0.95. NOTE the quantization: the aggregate rate is selectable members over
    // total members, so with a population of 20 it can only take multiples of
    // 1/20. A sub-0.05 epsilon below the floor rounds straight back onto it —
    // measured, and the reason this pair straddles by a whole step rather than
    // by an epsilon. 0.95 is exactly the floor and must PASS; 0.90 is the next
    // representable value below and must FAIL.
    const eps = 1e-9;
    expect(1 - gates.selectableRateFloorPointsBelowBaseline / 100).toBe(0.95);
    expect(check(decide({ selectableRate: 0.95 }), 'aggregateSelectableRate')).toBe(true);
    expect(check(decide({ selectableRate: 0.90 }), 'aggregateSelectableRate')).toBe(false);

    // Baseline uniquenessRatio 1.0; the floor is 10 points below it.
    expect(check(decide({ uniquenessRatio: 1 - gates.uniquenessFloorPointsBelowBaseline / 100 }),
      'medianFinalUniqueness')).toBe(true);
    expect(check(decide({ uniquenessRatio: 1 - gates.uniquenessFloorPointsBelowBaseline / 100 - 0.02 }),
      'medianFinalUniqueness')).toBe(false);

    // Baseline dispersion 0.2; the floor is a FRACTION of it.
    const floor = 0.2 * gates.dispersionFloorFractionOfBaseline;
    expect(check(decide({ dispersion: floor }), 'medianFinalDispersion')).toBe(true);
    expect(check(decide({ dispersion: floor - eps }), 'medianFinalDispersion')).toBe(false);
  });

  test('the protocol is deeply frozen, so no consumer can retune it in place', () => {
    expect(Object.isFrozen(protocol)).toBe(true);
    expect(Object.isFrozen(protocol.confirm.gates)).toBe(true);
    expect(Object.isFrozen(protocol.screen.arms[0])).toBe(true);
    expect(() => { protocol.confirm.gates.minPairedWins = 1; }).toThrow();
  });

  test('the screening and confirmation seed sets are DISJOINT', () => {
    const screen = new Set(protocol.screen.replicates.flatMap((r) => [r.populationSeed, r.terrainSeed]));
    const confirm = new Set(protocol.confirm.replicates.flatMap((r) => [r.populationSeed, r.terrainSeed]));
    for (const seed of confirm) expect(screen.has(seed)).toBe(false);
    expect(screen.size).toBe(12);
    expect(confirm.size).toBe(32);
  });

  test('validateProtocol REFUSES an overlapping confirmation set', () => {
    // The held-out claim is the entire reason confirmation can decide anything.
    const broken = JSON.parse(JSON.stringify(protocol));
    broken.confirm.replicates[0].populationSeed = protocol.screen.replicates[0].populationSeed;
    expect(() => validateProtocol(broken)).toThrow(/BOTH the screening and confirmation sets/);
  });

  test('validateProtocol REFUSES a gate that could never pass', () => {
    const broken = JSON.parse(JSON.stringify(protocol));
    broken.confirm.gates.minPairedWins = protocol.confirm.replicates.length + 1;
    expect(() => validateProtocol(broken)).toThrow(/could never pass/);
  });

  test('the smoke protocol is never citable and carries its own seeds', () => {
    const smoke = buildExperimentProtocol('smoke');
    expect(smoke.citable).toBe(false);
    const full = new Set([
      ...protocol.screen.replicates.flatMap((r) => [r.populationSeed, r.terrainSeed]),
      ...protocol.confirm.replicates.flatMap((r) => [r.populationSeed, r.terrainSeed]),
    ]);
    for (const r of [...smoke.screen.replicates, ...smoke.confirm.replicates]) {
      expect(full.has(r.populationSeed)).toBe(false);
      expect(full.has(r.terrainSeed)).toBe(false);
    }
  });
});

describe('experiment: the execution schedule', () => {
  const protocol = buildExperimentProtocol();
  const schedule = buildExecutionSchedule(protocol, 'screen', protocol.screen.arms);

  test('every arm runs every replicate exactly once, with unique run ids', () => {
    expect(schedule).toHaveLength(protocol.screen.arms.length * protocol.screen.replicates.length);
    expect(new Set(schedule.map((r) => r.runId)).size).toBe(schedule.length);
  });

  test('arms are PAIRED — within a replicate every arm gets the same seeds', () => {
    // This is what makes a paired comparison meaningful: two arms at replicate r
    // differ only in their mutation parameters.
    for (const replicate of protocol.screen.replicates) {
      const rows = schedule.filter((r) => r.replicateIndex === replicate.replicateIndex);
      expect(rows).toHaveLength(protocol.screen.arms.length);
      for (const row of rows) {
        expect(row.populationSeed).toBe(replicate.populationSeed);
        expect(row.terrainSeed).toBe(replicate.terrainSeed);
        expect(row.generations).toBe(protocol.screen.generations);
      }
    }
  });

  test('arm ORDER is permuted per replicate, and is deterministic', () => {
    const orderAt = (i) => schedule.filter((r) => r.replicateIndex === i).map((r) => r.armId);
    // Deterministic: the same protocol rebuilds the same schedule.
    const again = buildExecutionSchedule(protocol, 'screen', protocol.screen.arms);
    expect(again.map((r) => r.runId)).toEqual(schedule.map((r) => r.runId));
    // Permuted: at least one replicate must differ from replicate 0's order, or
    // the shuffle is not doing its job and a fixed arm always runs first.
    const first = orderAt(0);
    const differs = protocol.screen.replicates
      .slice(1)
      .some((r) => orderAt(r.replicateIndex).join(',') !== first.join(','));
    expect(differs).toBe(true);
  });
});

// --- 5. Screening and confirmation decisions ---------------------------------

describe('experiment: screening selection', () => {
  const protocol = buildExperimentProtocol();
  const R = protocol.screen.replicates.length;

  const baseline = () => armRuns(BASELINE_ARM_ID, 0.05, 0.05, R, { finalFitness: 10 });
  const control = () => armRuns(CONTROL_ARM_ID, 0, 0, R, { finalFitness: 5 });

  test('the best-scoring eligible arm becomes the candidate', () => {
    const better = armRuns('p0.100-m0.100', 0.1, 0.1, R, { finalFitness: 20 });
    const out = screenCandidates(protocol, [...baseline(), ...control(), ...better]);
    expect(out.candidateArmId).toBe('p0.100-m0.100');
    expect(out.candidateIsBaseline).toBe(false);
    expect(out.ranking[0]).toBe('p0.100-m0.100');
  });

  test('the CONTROL can never be the candidate, however well it scores', () => {
    // A zero-mutation default would make the parametric operator inert, so the
    // control is excluded by RULE rather than by score.
    const hotControl = armRuns(CONTROL_ARM_ID, 0, 0, R, { finalFitness: 1000 });
    const out = screenCandidates(protocol, [...baseline(), ...hotControl]);
    expect(out.candidateArmId).toBe(BASELINE_ARM_ID);
    expect(out.ranking).not.toContain(CONTROL_ARM_ID);
  });

  test('the baseline is the FALLBACK when no alternative qualifies', () => {
    const worse = armRuns('p0.010-m0.010', 0.01, 0.01, R, { finalFitness: 2 });
    const out = screenCandidates(protocol, [...baseline(), ...control(), ...worse]);
    expect(out.candidateArmId).toBe(BASELINE_ARM_ID);
    expect(out.candidateIsBaseline).toBe(true);
  });

  test.each([
    ['terminations', { terminalReason: 'noSelectableParents' }, 'noSelectableParentsTerminations'],
    ['selectable rate', { selectableRate: 0.5 }, 'selectableRate'],
    ['dispersion', { dispersion: 0.05 }, 'dispersion'],
  ])('a guardrail failure on %s makes an otherwise-winning arm INELIGIBLE',
    (_name, breakage, reason) => {
      const broken = armRuns('p0.200-m0.200', 0.2, 0.2, R, { finalFitness: 100, ...breakage });
      const out = screenCandidates(protocol, [...baseline(), ...control(), ...broken]);
      const arm = out.arms.find((a) => a.armId === 'p0.200-m0.200');
      expect(arm.eligible).toBe(false);
      expect(arm.ineligibleReasons).toContain(reason);
      // And the winning score does NOT rescue it.
      expect(out.candidateArmId).toBe(BASELINE_ARM_ID);
    });

  test('an arm within the declared guardrail margins stays eligible', () => {
    // Baseline sits at rate 1.0 and dispersion 0.2; the floors are 10 points and
    // 70%. These values are inside both, so eligibility must survive.
    const marginal = armRuns('p0.025-m0.025', 0.025, 0.025, R, {
      finalFitness: 30, selectableRate: 0.92, dispersion: 0.15,
    });
    const out = screenCandidates(protocol, [...baseline(), ...control(), ...marginal]);
    const arm = out.arms.find((a) => a.armId === 'p0.025-m0.025');
    expect(arm.eligible).toBe(true);
    expect(out.candidateArmId).toBe('p0.025-m0.025');
  });

  test('ties resolve by LOWER probability, then LOWER magnitude, then arm id', () => {
    // Three arms with identical scores. The declared order must be exercised at
    // every level, because a tie-break that is never tested is a coin flip.
    const tied = [
      ...armRuns('p0.200-m0.010', 0.2, 0.01, R, { finalFitness: 20 }),
      ...armRuns('p0.100-m0.200', 0.1, 0.2, R, { finalFitness: 20 }),
      ...armRuns('p0.100-m0.100', 0.1, 0.1, R, { finalFitness: 20 }),
    ];
    const out = screenCandidates(protocol, [...baseline(), ...control(), ...tied]);
    expect(out.ranking.slice(0, 3)).toEqual(['p0.100-m0.100', 'p0.100-m0.200', 'p0.200-m0.010']);
  });

  test('an arm whose median score is null is never ranked', () => {
    const starved = armRuns('p0.200-m0.200', 0.2, 0.2, R, { finalFitness: null });
    const out = screenCandidates(protocol, [...baseline(), ...control(), ...starved]);
    expect(out.ranking).not.toContain('p0.200-m0.200');
  });

  test('screening without a baseline arm is refused', () => {
    expect(() => screenCandidates(protocol, control())).toThrow(/no baseline arm/);
  });
});

describe('experiment: paired comparison', () => {
  test('a TIE counts as a NON-win', () => {
    const arm = armRuns('x', 0.1, 0.1, 4, { finalFitness: 10 });
    const ref = armRuns('y', 0.05, 0.05, 4, { finalFitness: 10 });
    const out = pairedComparison(arm, ref);
    expect(out.wins).toBe(0);
    expect(out.medianScoreDifference).toBe(0);
  });

  test('a null champion loses to any finite value, and null-vs-null is a tie', () => {
    const arm = [runRecord({ armId: 'x', probability: 0.1, magnitude: 0.1, replicateIndex: 0, finalFitness: null })];
    const ref = [runRecord({ armId: 'y', probability: 0.05, magnitude: 0.05, replicateIndex: 0, finalFitness: 1 })];
    expect(pairedComparison(arm, ref).wins).toBe(0);
    expect(pairedComparison(ref, arm).wins).toBe(1);
    const bothNull = [runRecord({ armId: 'y', probability: 0.05, magnitude: 0.05, replicateIndex: 0, finalFitness: null })];
    expect(pairedComparison(arm, bothNull).wins).toBe(0);
  });

  test('an unpaired replicate is refused rather than silently dropped', () => {
    const arm = armRuns('x', 0.1, 0.1, 3, { finalFitness: 10 });
    const ref = armRuns('y', 0.05, 0.05, 2, { finalFitness: 5 });
    expect(() => pairedComparison(arm, ref)).toThrow(/no reference run to pair with/);
  });
});

describe('experiment: the confirmation decision', () => {
  const protocol = buildExperimentProtocol();
  const R = protocol.confirm.replicates.length; // 16
  const WINS = protocol.confirm.gates.minPairedWins; // 12
  const CANDIDATE = 'p0.200-m0.200';

  const mk = (armId, p, m, opts) => armRuns(armId, p, m, R, { phase: 'confirm', ...opts });

  /** Candidate wins `wins` of the R replicates against a constant baseline. */
  const candidateWinning = (wins, opts = {}) => mk(CANDIDATE, 0.2, 0.2, {
    finalFitness: (r) => (r < wins ? 20 : 5),
    ...opts,
  });
  const baselineFlat = () => mk(BASELINE_ARM_ID, 0.05, 0.05, { finalFitness: 10 });
  const controlWeak = () => mk(CONTROL_ARM_ID, 0, 0, { finalFitness: 2 });

  test('RETUNE when every gate passes', () => {
    const out = confirmDecision(protocol,
      [...candidateWinning(WINS), ...baselineFlat(), ...controlWeak()], CANDIDATE);
    expect(out.decision).toBe('retune');
    expect(out.candidate.passes).toBe(true);
    expect(out.candidate.comparison.wins).toBe(WINS);
    expect(out.resolvedDefaults).toEqual({ probability: 0.2, magnitude: 0.2 });
  });

  test('one win short of the threshold is NOT a retune', () => {
    const out = confirmDecision(protocol,
      [...candidateWinning(WINS - 1), ...baselineFlat(), ...controlWeak()], CANDIDATE);
    expect(out.decision).not.toBe('retune');
    expect(out.candidate.checks.find((c) => c.name === 'pairedWins').pass).toBe(false);
    expect(out.resolvedDefaults).toEqual({ probability: 0.05, magnitude: 0.05 });
  });

  test.each([
    ['aggregateSelectableRate', { selectableRate: 0.8 }],
    ['medianFinalUniqueness', { uniquenessRatio: 0.5 }],
    ['medianFinalDispersion', { dispersion: 0.05 }],
    ['noSelectableParentsTerminations', { terminalReason: 'noSelectableParents' }],
  ])('a candidate that wins on fitness but fails %s is REFUSED', (gateName, breakage) => {
    const out = confirmDecision(protocol,
      [...candidateWinning(R, breakage), ...baselineFlat(), ...controlWeak()], CANDIDATE);
    expect(out.candidate.checks.find((c) => c.name === gateName).pass).toBe(false);
    expect(out.candidate.passes).toBe(false);
    expect(out.decision).not.toBe('retune');
  });

  test('RETAIN VALIDATED when the candidate fails but baseline beats the control', () => {
    const out = confirmDecision(protocol,
      [...candidateWinning(0), ...baselineFlat(), ...controlWeak()], CANDIDATE);
    expect(out.decision).toBe('retainValidated');
    expect(out.baselineVsControl.passes).toBe(true);
  });

  test('RETAIN INCONCLUSIVE when neither claim is supported', () => {
    // Baseline ties the control on every replicate: no candidate win, and no
    // evidence that mutation beat pure selection either.
    const flatControl = mk(CONTROL_ARM_ID, 0, 0, { finalFitness: 10 });
    const out = confirmDecision(protocol,
      [...candidateWinning(0), ...baselineFlat(), ...flatControl], CANDIDATE);
    expect(out.decision).toBe('retainInconclusive');
    expect(out.baselineVsControl.passes).toBe(false);
    expect(out.resolvedDefaults).toEqual({ probability: 0.05, magnitude: 0.05 });
  });

  test('a baseline CANDIDATE means only retainValidated or retainInconclusive is reachable', () => {
    const out = confirmDecision(protocol,
      [...baselineFlat(), ...controlWeak()], BASELINE_ARM_ID);
    expect(out.candidate).toBeNull();
    expect(out.candidateIsBaseline).toBe(true);
    expect(out.decision).toBe('retainValidated');
  });

  test('the CONTROL as candidate is refused outright', () => {
    expect(() => confirmDecision(protocol,
      [...baselineFlat(), ...controlWeak()], CONTROL_ARM_ID)).toThrow(/can never be the candidate/);
  });

  test('a missing control or baseline arm is refused', () => {
    expect(() => confirmDecision(protocol, [...baselineFlat()], BASELINE_ARM_ID))
      .toThrow(/contain no 'control' arm/);
    expect(() => confirmDecision(protocol, [...controlWeak()], BASELINE_ARM_ID))
      .toThrow(/contain no 'p0\.050-m0\.050' arm/);
  });
});

describe('experiment: pairing coherence', () => {
  test('arms sharing a replicate must report an identical generation 0', () => {
    const ok = [
      runRecord({ armId: 'a', probability: 0.1, magnitude: 0.1, replicateIndex: 0, populationDigest: 'aa' }),
      runRecord({ armId: 'b', probability: 0.2, magnitude: 0.2, replicateIndex: 0, populationDigest: 'aa' }),
    ];
    expect(pairingCoherence(ok).every((c) => c.pass)).toBe(true);
  });

  test('a differing generation-0 population is caught — the pairing would be a lie', () => {
    const bad = [
      runRecord({ armId: 'a', probability: 0.1, magnitude: 0.1, replicateIndex: 0, populationDigest: 'aa' }),
      runRecord({ armId: 'b', probability: 0.2, magnitude: 0.2, replicateIndex: 0, populationDigest: 'bb' }),
    ];
    expect(pairingCoherence(bad).every((c) => c.pass)).toBe(false);
  });

  test('a differing generation-0 champion is caught too', () => {
    const bad = [
      runRecord({ armId: 'a', probability: 0.1, magnitude: 0.1, replicateIndex: 0, baseFitness: 1 }),
      runRecord({ armId: 'b', probability: 0.2, magnitude: 0.2, replicateIndex: 0, baseFitness: 2 }),
    ];
    expect(pairingCoherence(bad).every((c) => c.pass)).toBe(false);
  });
});

// --- 6. Argument parsing -----------------------------------------------------

describe('experiment: argument parsing', () => {
  test('the default phase is the smoke phase', () => {
    expect(configFromArgs([])).toEqual({
      phase: 'smoke', workspace: null, out: null, allowDirty: false, json: false,
    });
  });

  test('every declared phase is accepted', () => {
    for (const phase of EXPERIMENT_PHASES) {
      expect(configFromArgs(['--phase', phase]).phase).toBe(phase);
    }
  });

  test.each([
    ['an unknown flag', ['--fast']],
    ['an unknown phase', ['--phase', 'tune']],
    ['a missing phase value', ['--phase']],
    ['a flag where a value belongs', ['--phase', '--json']],
    ['a missing workspace value', ['--workspace']],
  ])('%s is refused loud', (_name, argv) => {
    // Documented-but-unwired options are a real defect class in this repo (the
    // PR #19 P2 finding), so the parser is tested rather than assumed.
    expect(() => configFromArgs(argv)).toThrow(/experiment-evolution/);
  });
});

// --- 6b. The CLI's two dangerous edges ---------------------------------------

describe('experiment: the CLI cannot destroy evidence or run on import', () => {
  test('the smoke reset REFUSES any workspace it cannot prove is a smoke workspace',
    { timeout: 300000 }, async () => {
      // `configFromArgs` defaults the phase to `smoke`, so the first draft's
      // unconditional `rmSync(config.workspace ?? SMOKE_WORKSPACE)` made
      // `--workspace experiment-workspace` — with no --phase at all — a
      // recursive delete of hours-old citable evidence.
      const workspace = mkdtempSync(join(tmpdir(), 'boxcar3d-experiment-'));
      try {
        // A FULL-protocol workspace must survive.
        await executeExperimentPhase({
          phase: 'screen',
          workspace,
          protocol: buildExperimentProtocol('smoke'),
          allowDirty: true,
        });
        const manifestFile = join(workspace, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
        writeFileSync(manifestFile,
          JSON.stringify({ ...manifest, protocol: { ...manifest.protocol, kind: 'full' } }), 'utf8');
        expect(() => resetSmokeWorkspace(workspace)).toThrow(/refusing to clear/);
        expect(existsSync(workspace)).toBe(true);

        // A directory with no manifest at all is refused too: a delete that
        // cannot prove what it is deleting is not one to run twice.
        const bare = mkdtempSync(join(tmpdir(), 'boxcar3d-experiment-bare-'));
        try {
          expect(() => resetSmokeWorkspace(bare)).toThrow(/holds no manifest\.json/);
          expect(existsSync(bare)).toBe(true);
        } finally {
          rmSync(bare, { recursive: true, force: true });
        }

        // A genuine smoke workspace IS cleared, so the smoke phase still works.
        writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8');
        resetSmokeWorkspace(workspace);
        expect(existsSync(workspace)).toBe(false);

        // And a path that does not exist is a no-op, not an error.
        expect(() => resetSmokeWorkspace(join(tmpdir(), 'boxcar3d-does-not-exist'))).not.toThrow();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

  test('the source identity describes THIS repository, whatever the cwd is', () => {
    // The citability gate is "the working tree is clean", and it decides whether
    // a phase may produce citable evidence. Running git without an explicit cwd
    // answered for whatever directory the process was launched from, so the gate
    // could describe — and pass on — a completely unrelated repository.
    //
    // This tooth exists because the sabotage checklist caught its ABSENCE: the
    // fix was applied to the site and nothing enforced it, so reverting the fix
    // left the whole suite green. Fixing an instance without writing the rule as
    // a test is the failure mode CLAUDE.md rounds 8-14 name; it recurred here.
    const original = process.cwd();
    try {
      process.chdir(tmpdir()); // not this repository (and typically not a repo)
      const identity = readSourceIdentity();
      expect(identity.available).toBe(true);
      expect(identity.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof identity.clean).toBe('boolean');
    } finally {
      process.chdir(original);
    }
  });

  test('the run-as-script guard is a TESTED predicate, not an untested string compare', () => {
    // The header claimed "importing must not start an experiment" and nothing
    // asserted it — unenforced prose read as an audited guarantee, the failure
    // mode CLAUDE.md rounds 8-14 name repeatedly. The guard was an inline
    // `process.argv[1].endsWith(...)`, unreachable from a test. It is now a
    // named predicate, so both of its answers are pinned.
    expect(shouldRunAsScript('/repo/scripts/experiment-evolution.js')).toBe(true);
    expect(shouldRunAsScript('C:\\repo\\scripts\\experiment-evolution.js')).toBe(true);
    expect(shouldRunAsScript('/repo/node_modules/.bin/vitest')).toBe(false);
    expect(shouldRunAsScript(undefined)).toBe(false);
    expect(shouldRunAsScript('')).toBe(false);
    // A path that merely CONTAINS the name must not trigger it.
    expect(shouldRunAsScript('/repo/tests/experiment-evolution.js.snap')).toBe(false);
  });

  test('and under THIS runner the guard is false, so the import above was inert', () => {
    // The import at the top of this file has already happened. Had the guard
    // been true, a full smoke experiment would have run during collection.
    expect(shouldRunAsScript(process.argv[1])).toBe(false);
  });
});

// --- 6b2. The CODE that produces the observations, not just the artifact -----

describe('experiment: the observation producers themselves', () => {
  // WHY THIS BLOCK EXISTS. Every tooth written for the round-2 corrections read
  // the COMMITTED JSON — and a committed file cannot change when the source
  // does, so a sabotage pass found six of those fixes completely unenforced.
  // Reading the artifact catches a stale or hand-edited artifact; it says
  // nothing about the code. These exercise the producers directly.

  const row = (over = {}) => ({
    phase: 'screen',
    armId: 'control',
    replicateIndex: 0,
    summary: {
      generations: [
        { champion: { individualId: 0, fitness: 5 } },
        { champion: { individualId: 1, fitness: 500 } },
      ],
    },
    ...over,
  });

  test('the ceiling reads the RESOLVED terrain length, not the module default', () => {
    // With the real protocol both branches agree (its terrain declares no
    // length), so this needs a protocol that overrides it — otherwise the
    // mutation is unobservable, which is exactly what the sabotage pass found.
    const base = buildExperimentProtocol();
    const overridden = JSON.parse(JSON.stringify(base));
    overridden.workload.terrain.length = 400;
    expect(fitnessPlausibilityCeiling(overridden).terrainLength).toBe(400);
    expect(fitnessPlausibilityCeiling(overridden).corridorForwardDistance)
      .toBe(400 / 2 - overridden.workload.spawn.x);
    // ...and the kinematic bound must NOT move with the corridor.
    expect(fitnessPlausibilityCeiling(overridden).kinematicCeiling)
      .toBe(fitnessPlausibilityCeiling(base).kinematicCeiling);
  });

  test('the kinematic ceiling is v*T and does NOT include the corridor', () => {
    const protocol = buildExperimentProtocol();
    const basis = fitnessPlausibilityCeiling(protocol);
    expect(basis.kinematicCeiling).toBe(basis.noLoadSurfaceSpeed * basis.runSeconds);
    expect(basis.kinematicCeiling).toBeLessThan(basis.corridorForwardDistance);
  });

  test('the observation fold PRODUCES a per-arm and generation-zero breakdown', () => {
    const protocol = buildExperimentProtocol();
    const out = fitnessPlausibilityObservations(protocol, [
      row(),
      row({ armId: 'p0.200-m0.200' }),
      row({ replicateIndex: 1, summary: { generations: [{ champion: { individualId: 0, fitness: 5 } }] } }),
    ]);
    expect(Object.keys(out.perArm).sort()).toEqual(['screen:control', 'screen:p0.200-m0.200']);
    expect(out.perArm['screen:control'].championGenerationsOverConservative).toBe(1);
    expect(out.generationZero['screen:r0'].championFitness).toBe(5);
    expect(out.generationZero['screen:r0'].overConservative).toBe(false);
    expect(out.generationZero['screen:r1']).toBeDefined();
  });

  test('distinct champions COLLAPSE a surviving elite; ids would not', () => {
    // A 3-generation run whose champion never changes is ONE individual, even
    // though PR 3 gives every elite copy a fresh id.
    const protocol = buildExperimentProtocol();
    const survivor = {
      phase: 'screen',
      armId: 'control',
      replicateIndex: 0,
      summary: {
        generations: [
          { champion: { individualId: 7, fitness: 500 } },
          { champion: { individualId: 21, fitness: 500 } }, // fresh id, same vehicle
          { champion: { individualId: 34, fitness: 500 } },
        ],
      },
    };
    const out = fitnessPlausibilityObservations(protocol, [survivor]);
    const arm = out.perArm['screen:control'];
    expect(arm.championGenerationsOverConservative).toBe(3); // exposure
    expect(arm.distinctChampionsOverConservative).toBe(1); // prevalence
  });

  test('the forensic case plan ROUTES to the phase it names', () => {
    const protocol = buildExperimentProtocol();
    const arm = protocol.screen.arms.find((a) => a.armId === CONTROL_ARM_ID);
    const screenPlan = forensicCasePlan(protocol, protocol.screen.replicates[2], arm, 'screen');
    const confirmPlan = forensicCasePlan(protocol, protocol.confirm.replicates[2], arm, 'confirm');
    expect(screenPlan.generations).toBe(protocol.screen.generations);
    expect(confirmPlan.generations).toBe(protocol.confirm.generations);
    expect(screenPlan.generations).not.toBe(confirmPlan.generations);
    expect(confirmPlan.populationSeed).toBe(protocol.confirm.replicates[2].populationSeed);
    expect(confirmPlan.phase).toBe('confirm');
    expect(screenPlan.runId).not.toBe(confirmPlan.runId);
  });

  test('the escalation accounting counts only NEWLY-failing individuals', () => {
    const mk = (id, status, alert, peak, dist) => ({
      phase: 'screen',
      populationSeed: 1,
      individualId: id,
      integrityStatus: status,
      firstAlertStep: alert,
      firstCatastrophicStep: null,
      peakBodySpeed: peak,
      maxForwardDistance: dist,
    });
    const out = summarizeEscalationRows([
      mk(0, 'ok', null, 4, 20), // healthy, best -> current champion
      mk(1, 'ok', 12, 300, 50), // alert-band but currently selectable -> NEWLY fails
      mk(2, 'numericalDivergence', 5, 2000, 0), // already unselectable -> NOT new
      mk(3, 'ok', null, 3, 10),
    ]);
    expect(out.individuals).toBe(4);
    expect(out.currentlyUnselectable).toBe(1);
    expect(out.alertBand).toBe(2);
    expect(out.newlyUnselectable).toBe(1); // NOT 2 — the already-failing one is not a new cost
    expect(out.newlyUnselectableBelow50).toBe(0);
  });

  test('the escalation accounting detects a champion change', () => {
    const mk = (id, alert, peak, dist) => ({
      phase: 'screen',
      populationSeed: 1,
      individualId: id,
      integrityStatus: 'ok',
      firstAlertStep: alert,
      firstCatastrophicStep: null,
      peakBodySpeed: peak,
      maxForwardDistance: dist,
    });
    // The top scorer is alert-band, so escalation hands the crown to id 1.
    const changed = summarizeEscalationRows([mk(0, 9, 400, 900), mk(1, null, 4, 20)]);
    expect(changed.generationZeroChampionChanges).toBe(1);
    // Here the top scorer is healthy, so nothing changes.
    const stable = summarizeEscalationRows([mk(0, null, 4, 900), mk(1, null, 4, 20)]);
    expect(stable.generationZeroChampionChanges).toBe(0);
  });

  test('the forensic SAMPLE resolves each case against the phase it declares', () => {
    // The routing at the CALL SITE, not just in the plan builder: a runner that
    // hard-codes 'screen' must redden here.
    const protocol = buildExperimentProtocol();
    const plans = forensicSamplePlans(protocol);
    expect(plans).toHaveLength(FORENSIC_SAMPLE.length);
    for (let i = 0; i < plans.length; i += 1) {
      const { entry, replicate, plan } = plans[i];
      expect(entry).toBe(FORENSIC_SAMPLE[i]);
      expect(plan.phase).toBe(entry.phase);
      const declared = entry.phase === 'confirm' ? protocol.confirm : protocol.screen;
      expect(plan.generations).toBe(declared.generations);
      expect(replicate.populationSeed)
        .toBe(declared.replicates[entry.replicateIndex].populationSeed);
      expect(plan.terrainSeed).toBe(declared.replicates[entry.replicateIndex].terrainSeed);
    }
    // Confirmation cases must really carry the confirmation budget.
    const confirmPlans = plans.filter((p) => p.entry.phase === 'confirm');
    expect(confirmPlans.length).toBeGreaterThan(0);
    for (const p of confirmPlans) expect(p.plan.generations).toBe(protocol.confirm.generations);
  });

  test('the forensic report BUILDER carries provenance and derives its summary', () => {
    const protocol = buildExperimentProtocol();
    const mk = (fitness, alert, plausible) => ({
      armId: 'x', replicateIndex: 0, generationIndex: 1, fitness,
      firstAlertStep: alert, firstCatastrophicStep: null, plausible,
    });
    const out = buildForensicReport({
      protocolDigest: 'abc',
      ceiling: 129,
      rows: [mk(500, 10, false), mk(12, 39, true), mk(5, null, true)],
    });
    expect(out.protocolDigest).toBe('abc');
    expect(out.declaredSample).toBe(FORENSIC_SAMPLE); // not an empty stand-in
    expect(out.declaredSample.length).toBeGreaterThan(0);
    expect(out.summary.overCeiling).toBe(1);
    expect(out.summary.underCeiling).toBe(2);
    expect(out.summary.underCeilingAlertBand).toBe(1); // the 12 m / alert@39 case
    expect(out.rows.map((r) => r.fitness)).toEqual([5, 12, 500]); // sorted
    expect(fitnessPlausibilityCeiling(protocol).conservativeCeiling).toBe(129);
  });

  test('the adoption ruling is pinned in CODE, not only in the committed file', () => {
    expect(ADOPTION_RULING.gateVerdictAdopted).toBe(false);
    expect(ADOPTION_RULING.adoptedDefaults).toEqual({ probability: 0.05, magnitude: 0.05 });
    expect(ADOPTION_RULING.reasonCode).toBe('fitnessSignalContaminated');
    expect(Object.isFrozen(ADOPTION_RULING)).toBe(true);
  });
});

// --- 6c. The committed evidence recomputes to its own conclusions ------------

describe('experiment: the committed evidence', () => {
  const evidence = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'docs',
      'ga-phase-1b-pr4-evolution-experiment-evidence.json'),
    'utf8',
  ));

  test('is a well-formed, citable, single-commit artifact', () => {
    expect(evidence.schema).toBe(EXPERIMENT_SCHEMA);
    expect(evidence.protocolVersion).toBe(1);
    expect(evidence.runs).toHaveLength(204); // 26x6 screening + 3x16 confirmation
    expect(evidence.citable).toBe(true);
    // Every run from ONE clean commit — the property that makes the arms
    // comparable at all. Two commits would mean two experiments averaged.
    expect(evidence.observations.runSources).toHaveLength(1);
    expect(evidence.coherence.every((c) => c.pass)).toBe(true);
  });

  test('recomputes its OWN screening, confirmation and decision from the raw run rows',
    async () => {
      // The acceptance rule: the committed document must be derivable from its
      // own raw rows. Nothing is carried forward from execution, so a hand-edited
      // conclusion cannot survive here.
      const protocol = evidence.protocol;
      const screenRuns = evidence.runs.filter((r) => r.phase === 'screen');
      const confirmRuns = evidence.runs.filter((r) => r.phase === 'confirm');

      const screening = screenCandidates(protocol, screenRuns);
      expect(canonicalJson(screening)).toBe(canonicalJson(evidence.screening));

      const confirmation = confirmDecision(protocol, confirmRuns, screening.candidateArmId);
      expect(canonicalJson(confirmation)).toBe(canonicalJson(evidence.confirmation));
      expect(evidence.decision).toBe(confirmation.decision);
      expect(evidence.resolvedDefaults).toEqual(confirmation.resolvedDefaults);

      // And the digest over the declared deterministic subset.
      const recomputed = await canonicalDigest(evidenceSubset({
        protocol,
        protocolDigest: evidence.protocolDigest,
        runs: evidence.runs,
        screening,
        confirmation,
      }));
      expect(recomputed).toBe(evidence.evidenceDigest);
    });

  test('the digest scope is EXACTLY the declared five keys', () => {
    // Copy-declared, so a change to EVIDENCE_DIGEST_KEYS reddens rather than
    // silently redefining what the committed digest attests.
    expect(EVIDENCE_DIGEST_KEYS.slice().sort())
      .toEqual(['confirmation', 'protocol', 'protocolDigest', 'runs', 'screening']);
    // Timing, machine identity and execution order must be OUTSIDE it.
    for (const excluded of ['observations', 'coherence', 'citable', 'decision']) {
      expect(EVIDENCE_DIGEST_KEYS).not.toContain(excluded);
    }
    expect(() => evidenceSubset({ protocol: 1 })).toThrow(/must carry exactly/);
  });

  test('the KINEMATIC ceiling is a displacement bound; the conservative one is not', () => {
    // The first draft returned `corridor + v*T` and called it the distance a
    // vehicle "could reach", which adds a spatial extent to a time-integral.
    // Displacement in T seconds is bounded by v*T and nothing else. Both are
    // asserted as arithmetic identities so a workload change moves them.
    const basis = evidence.observations.fitnessPlausibility.basis;
    expect(basis.kinematicCeiling).toBe(basis.noLoadSurfaceSpeed * basis.runSeconds);
    expect(basis.conservativeCeiling)
      .toBe(basis.corridorForwardDistance + basis.kinematicCeiling);
    expect(basis.corridorForwardDistance).toBe(basis.terrainLength / 2 - basis.spawnX);
    // The conservative bound is strictly weaker, so counts against it are LOWER
    // bounds. If these ever coincide the distinction has been lost.
    expect(basis.conservativeCeiling).toBeGreaterThan(basis.kinematicCeiling);
    expect(fitnessPlausibilityCeiling(evidence.protocol)).toEqual(basis);
  });

  test('the plausibility counts recompute from the committed generation rows', () => {
    const basis = evidence.observations.fitnessPlausibility.basis;
    for (const [phase, observed] of Object.entries(evidence.observations.fitnessPlausibility.phases)) {
      const runs = evidence.runs.filter((r) => r.phase === phase);
      let generations = 0;
      let overKinematic = 0;
      let overConservative = 0;
      let finalOver = 0;
      for (const run of runs) {
        const gens = run.summary.generations;
        for (const g of gens) {
          generations += 1;
          if (g.champion === null) continue;
          if (g.champion.fitness > basis.kinematicCeiling) overKinematic += 1;
          if (g.champion.fitness > basis.conservativeCeiling) overConservative += 1;
        }
        const last = gens[gens.length - 1].champion;
        if (last !== null && last.fitness > basis.conservativeCeiling) finalOver += 1;
      }
      expect(observed.runs).toBe(runs.length);
      expect(observed.generations).toBe(generations);
      expect(observed.championGenerationsOverKinematic).toBe(overKinematic);
      expect(observed.championGenerationsOverConservative).toBe(overConservative);
      expect(observed.finalChampionsOverConservative).toBe(finalOver);
    }
  });

  test('contamination is broken down PER ARM, so a claim about the control is checkable', () => {
    // THIS TEST EXISTS BECAUSE ITS ABSENCE SHIPPED A FALSE CLAIM. The report
    // asserted "the (0,0) control produced zero over-ceiling champions in any
    // replicate"; the confirmation control has 60. Nothing reddened, because
    // counts existed only per PHASE. The per-arm breakdown is now required to be
    // present and to recompute — the claim is enforced by data, not by prose.
    const basis = evidence.observations.fitnessPlausibility.basis;
    const perArm = evidence.observations.fitnessPlausibility.perArm;
    const armKeys = new Set(evidence.runs.map((r) => `${r.phase}:${r.armId}`));
    expect(new Set(Object.keys(perArm))).toEqual(armKeys);
    for (const [key, observed] of Object.entries(perArm)) {
      const runs = evidence.runs.filter((r) => `${r.phase}:${r.armId}` === key);
      let over = 0;
      const distinct = new Set();
      for (const run of runs) {
        for (const g of run.summary.generations) {
          if (g.champion === null || g.champion.fitness <= basis.conservativeCeiling) continue;
          over += 1;
          distinct.add(`r${run.replicateIndex}:${g.champion.fitness}`);
        }
      }
      expect(observed.championGenerationsOverConservative).toBe(over);
      // Distinct champions collapse a surviving elite; ids do NOT (PR 3 gives
      // every elite copy a fresh id), which is why this is keyed on fitness.
      expect(observed.distinctChampionsOverConservative).toBe(distinct.size);
      expect(observed.distinctChampionsOverConservative)
        .toBeLessThanOrEqual(observed.championGenerationsOverConservative);
    }
  });

  test('generation 0 is recorded PRE-TREATMENT and is shared by every arm', () => {
    // The second half of the false claim was causal: "this is not a property of
    // the initial population". Generation 0 is drawn before any operator acts,
    // so recording it is what makes that claim checkable at all.
    const zero = evidence.observations.fitnessPlausibility.generationZero;
    const basis = evidence.observations.fitnessPlausibility.basis;
    for (const [key, observed] of Object.entries(zero)) {
      const [phase, rep] = key.split(':r');
      const runs = evidence.runs.filter(
        (r) => r.phase === phase && r.replicateIndex === Number(rep),
      );
      expect(runs.length).toBeGreaterThan(0);
      // The pairing identity: every arm at a replicate shares generation 0.
      const fitnesses = new Set(runs.map((r) => r.summary.generations[0].champion.fitness));
      expect(fitnesses.size).toBe(1);
      expect(observed.championFitness).toBe([...fitnesses][0]);
      expect(observed.overKinematic).toBe(observed.championFitness > basis.kinematicCeiling);
      expect(observed.overConservative).toBe(observed.championFitness > basis.conservativeCeiling);
    }
  });

  test('the adoption ruling travels WITH the artifact, not only in prose', () => {
    // The digest-signed citable file said `decision: retune` while every handoff
    // said the retune was declined. A tool reading the machine-readable artifact
    // would have adopted parameters the PR deliberately refused.
    expect(evidence.decision).toBe(evidence.confirmation.decision); // gate verdict, untouched
    expect(evidence.adoption.gateVerdictAdopted).toBe(false);
    expect(evidence.adoption.adoptedDefaults).toEqual({ probability: 0.05, magnitude: 0.05 });
    expect(evidence.adoption.reasonCode).toBe('fitnessSignalContaminated');
    // The disposition is a human ruling, so it must sit OUTSIDE the digest.
    expect(EVIDENCE_DIGEST_KEYS).not.toContain('adoption');
  });

  test('per-run provenance survives into the committed artifact', () => {
    // `citable: true` asserts every run came from one clean commit. That must be
    // re-derivable from the artifact rather than trusted.
    const commits = new Set(evidence.runs.map((r) => r.sourceCommit));
    expect(commits.size).toBe(1);
    expect([...commits][0]).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.runs.every((r) => r.sourceClean === true)).toBe(true);
    expect(evidence.runs.every((r) => r.citable === true)).toBe(true);
    expect(evidence.citable).toBe(true);
  });

  test('runtime is reported PER GENERATION COUNT, not pooled', () => {
    // "median run 16.6 s (30 generations)" was a pooled median over 30- and
    // 60-generation runs — a number describing neither.
    const byCount = evidence.observations.performance.byGenerationCount;
    const timing = evidence.observations.perRunTiming;
    for (const [count, observed] of Object.entries(byCount)) {
      const rows = timing.filter((t) => t.generationCount === Number(count));
      expect(observed.runCount).toBe(rows.length);
      const sorted = rows.map((t) => t.evolveMs).sort((a, b) => a - b);
      expect(observed.evolveMs.min).toBe(sorted[0]);
      expect(observed.evolveMs.max).toBe(sorted[sorted.length - 1]);
      expect(observed.evolveMs.median)
        .toBe(sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
    }
    expect(Object.keys(byCount).length).toBeGreaterThan(1);
    // Timing must NOT be inside the digested subset: a resumed campaign
    // re-executes runs and would otherwise produce a different digest.
    expect(evidence.runs.every((r) => r.evolveMs === undefined)).toBe(true);
  });

  test('every declared forensic case names a real replicate and a real arm', () => {
    // The forensic phase runs physics and is therefore NOT a CI gate — but its
    // case list is pure data, and a case naming a replicate or arm the protocol
    // does not have would fail only when someone ran a 2-minute instrument.
    // Cheap to pin, so it is pinned.
    const protocol = buildExperimentProtocol();
    expect(FORENSIC_SAMPLE.length).toBeGreaterThan(0);
    for (const entry of FORENSIC_SAMPLE) {
      const phase = entry.phase === 'confirm' ? protocol.confirm : protocol.screen;
      expect(['screen', 'confirm']).toContain(entry.phase);
      expect(phase.replicates.some((r) => r.replicateIndex === entry.replicateIndex)).toBe(true);
      expect(protocol.screen.arms.some((a) => a.armId === entry.armId)).toBe(true);
    }
    // BOTH phases must be sampled. The first draft could not express a
    // confirmation case at all, so the phase carrying the strongest positive
    // claim had no re-evaluation evidence.
    expect(new Set(FORENSIC_SAMPLE.map((e) => e.phase))).toEqual(new Set(['screen', 'confirm']));
    // And the zero-mutation control must be among them: it is the arm whose
    // behaviour the report makes a causal claim about.
    expect(FORENSIC_SAMPLE.some((e) => e.armId === CONTROL_ARM_ID)).toBe(true);
    // The sample must span BOTH kinds of replicate, or it could only ever
    // confirm what it was pointed at. The declared split is 3 contaminated and
    // 3 clean; assert it covers more than one replicate either way.
    expect(new Set(FORENSIC_SAMPLE.map((e) => e.replicateIndex)).size).toBeGreaterThanOrEqual(4);
  });

  test('the committed forensic output is internally consistent', () => {
    const forensics = JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'docs',
        'ga-phase-1b-pr4-evolution-forensics.json'),
      'utf8',
    ));
    expect(forensics.schema).toBe('boxcar3d.evolution-experiment-forensics/1');
    expect(forensics.ceiling)
      .toBe(fitnessPlausibilityCeiling(buildExperimentProtocol()).conservativeCeiling);
    // PROVENANCE: the committed file must describe the sample and protocol it
    // was actually produced from, or a stale artifact stays green forever.
    expect(forensics.declaredSample).toEqual(FORENSIC_SAMPLE.map((e) => ({ ...e })));
    expect(forensics.protocolDigest).toBe(evidence.protocolDigest);
    const s = forensics.summary;
    expect(s.sampled).toBe(forensics.rows.length);
    // The counts recompute from the rows — no hand-entered summary.
    const over = forensics.rows.filter((r) => !r.plausible);
    const under = forensics.rows.filter((r) => r.plausible);
    expect(s.overCeiling).toBe(over.length);
    expect(s.underCeiling).toBe(under.length);
    expect(s.underCeilingAlertBand).toBe(under.filter((r) => r.firstAlertStep !== null).length);
    expect(s.overCeilingAllAlertBand).toBe(over.length > 0 && over.every((r) => r.firstAlertStep !== null));
    // `plausible` must agree with the ceiling it claims to apply.
    for (const row of forensics.rows) {
      expect(row.plausible).toBe(row.fitness <= forensics.ceiling);
    }
    // NOT asserted: any peak speed, any alert step, any prevalence. Those are
    // observations of one engine on declared seeds.
  });

  test('the committed escalation-cost measurement is internally consistent', () => {
    const cost = JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'docs',
        'ga-phase-1b-pr4-escalation-cost.json'),
      'utf8',
    ));
    expect(cost.schema).toBe('boxcar3d.evolution-experiment-escalation-cost/1');
    // Scope is stated IN the artifact: this measures the false-POSITIVE side
    // only, on unmutated generation-0 populations. PR-B's acceptance test also
    // needs the false-negative side, which this does not attempt.
    expect(cost.scope).toMatch(/FALSE-POSITIVE/);
    expect(cost.scope).toMatch(/generation-0/);

    const protocol = buildExperimentProtocol();
    const expectedPopulations = protocol.screen.replicates.length + protocol.confirm.replicates.length;
    expect(cost.populations).toBe(expectedPopulations);
    expect(cost.individuals).toBe(expectedPopulations * protocol.workload.populationSize);
    expect(cost.rows).toHaveLength(cost.individuals);

    // Every headline count recomputes from the rows — no hand-entered summary.
    const currently = cost.rows.filter((r) => r.integrityStatus !== 'ok');
    const alert = cost.rows.filter((r) => r.firstAlertStep !== null);
    const newly = cost.rows.filter((r) => r.integrityStatus === 'ok' && r.firstAlertStep !== null);
    expect(cost.currentlyUnselectable).toBe(currently.length);
    expect(cost.alertBand).toBe(alert.length);
    expect(cost.newlyUnselectable).toBe(newly.length);
    // "Newly" must be exactly the alert-band individuals policy v2 still passes.
    expect(cost.newlyUnselectable).toBe(cost.alertBand - alert.filter((r) => r.integrityStatus !== 'ok').length);
    expect(cost.newlyUnselectableBelow50)
      .toBe(newly.filter((r) => r.peakBodySpeed < 50).length);
    // NOT asserted: any peak speed, any percentage, any champion count. Those
    // are observations of one engine on declared seeds.
  });

  // NOTE what is deliberately NOT asserted here: no fitness magnitude, no
  // diversity magnitude, no timing, and no "the candidate won". Those are
  // OBSERVATIONS of one campaign on declared seeds. This block checks that the
  // committed document is internally consistent and self-derivable — a
  // regression in the ANALYSIS, never a lock on the physics.
});

// --- 7. The filesystem workspace: execution, refusal, and resume -------------

describe('experiment: the resumable workspace', () => {
  const smoke = buildExperimentProtocol('smoke');

  function tempWorkspace() {
    return mkdtempSync(join(tmpdir(), 'boxcar3d-experiment-'));
  }

  test('a smoke phase executes, resumes after an interruption, and produces IDENTICAL evidence',
    { timeout: 300000 }, async () => {
      const workspace = tempWorkspace();
      try {
        await executeExperimentPhase({ phase: 'screen', workspace, protocol: smoke, allowDirty: true });
        await executeExperimentPhase({ phase: 'confirm', workspace, protocol: smoke, allowDirty: true });
        const first = await buildExperimentReport({ workspace, protocol: smoke });

        // Simulate the interruption: drop two completed run records.
        const runsDir = join(workspace, 'runs');
        const files = readdirSync(runsDir).sort();
        expect(files.length).toBeGreaterThan(2);
        rmSync(join(runsDir, files[0]));
        rmSync(join(runsDir, files[files.length - 1]));

        // Resume: exactly the missing runs re-execute, nothing else.
        const resumedScreen = await executeExperimentPhase({
          phase: 'screen', workspace, protocol: smoke, allowDirty: true,
        });
        const resumedConfirm = await executeExperimentPhase({
          phase: 'confirm', workspace, protocol: smoke, allowDirty: true,
        });
        expect(resumedScreen.executed + resumedConfirm.executed).toBe(2);
        expect(resumedScreen.skipped + resumedConfirm.skipped)
          .toBe(resumedScreen.planned + resumedConfirm.planned - 2);

        const second = await buildExperimentReport({ workspace, protocol: smoke });
        // THE RESUME CONTRACT: the canonical evidence is byte-identical. Timing
        // and machine state differ between the two executions by construction,
        // and the digest proves they are outside the evidence.
        expect(second.evidenceDigest).toBe(first.evidenceDigest);
        expect(second.decision).toBe(first.decision);
        expect(canonicalJson(second.runs)).toBe(canonicalJson(first.runs));
        expect(second.citable).toBe(false); // the smoke protocol never is
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

  test('a workspace built under a DIFFERENT protocol is refused, not migrated',
    { timeout: 300000 }, async () => {
      const workspace = tempWorkspace();
      try {
        await executeExperimentPhase({ phase: 'screen', workspace, protocol: smoke, allowDirty: true });
        const other = buildExperimentProtocol('full');
        await expect(executeExperimentPhase({
          phase: 'screen', workspace, protocol: other, allowDirty: true,
        })).rejects.toThrow(/DIFFERENT protocol/);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

  test('a corrupt, mislabelled or foreign run record is refused loud',
    { timeout: 300000 }, async () => {
      const workspace = tempWorkspace();
      try {
        await executeExperimentPhase({ phase: 'screen', workspace, protocol: smoke, allowDirty: true });
        const runsDir = join(workspace, 'runs');
        const file = join(runsDir, readdirSync(runsDir).sort()[0]);
        const good = JSON.parse(readFileSync(file, 'utf8'));

        writeFileSync(file, '{ not json', 'utf8');
        await expect(buildExperimentReport({ workspace, protocol: smoke }))
          .rejects.toThrow(/could not read/);

        writeFileSync(file, JSON.stringify({ ...good, schema: 'something/1' }), 'utf8');
        await expect(buildExperimentReport({ workspace, protocol: smoke }))
          .rejects.toThrow(new RegExp(`not a ${EXPERIMENT_RUN_SCHEMA.replace(/[/.]/g, '\\$&')} record`));

        writeFileSync(file, JSON.stringify({ ...good, protocolDigest: 'x'.repeat(64) }), 'utf8');
        await expect(buildExperimentReport({ workspace, protocol: smoke }))
          .rejects.toThrow(/different protocol digest/);

        writeFileSync(file, JSON.stringify({ ...good, runId: 'screen:control:r99' }), 'utf8');
        await expect(buildExperimentReport({ workspace, protocol: smoke }))
          .rejects.toThrow(/does not match its filename/);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

  test('an INCOMPLETE screening phase cannot produce a report or start confirmation',
    { timeout: 300000 }, async () => {
      const workspace = tempWorkspace();
      try {
        await executeExperimentPhase({ phase: 'screen', workspace, protocol: smoke, allowDirty: true });
        const runsDir = join(workspace, 'runs');
        rmSync(join(runsDir, readdirSync(runsDir).sort()[0]));
        await expect(buildExperimentReport({ workspace, protocol: smoke }))
          .rejects.toThrow(/needs all \d+ screening runs/);
        await expect(executeExperimentPhase({
          phase: 'confirm', workspace, protocol: smoke, allowDirty: true,
        })).rejects.toThrow(/confirmation needs all \d+ screening runs/);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
});
