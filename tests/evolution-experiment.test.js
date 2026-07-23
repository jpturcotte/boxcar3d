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
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BASELINE_ARM_ID, CONTROL_ARM_ID, EXPERIMENT_PHASES, EXPERIMENT_RUN_SCHEMA, EXPERIMENT_SCHEMA,
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

  test('nulls sort to the TAIL and do not shift a still-finite median', () => {
    // Full list is [1, 2, 3, 4, 5, null]; positions 2 and 3 are 3 and 4.
    expect(medianOrNull([5, 4, 3, 2, 1, null])).toBe(3.5);
  });

  test('a null ON a median position makes the median null', () => {
    // [1, 2, 3, null, null, null]; positions 2 and 3 are 3 and null.
    expect(medianOrNull([1, 2, 3, null, null, null])).toBeNull();
    expect(medianOrNull([null, null, null])).toBeNull();
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
