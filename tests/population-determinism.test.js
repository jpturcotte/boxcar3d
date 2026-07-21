// The population/fitness golden gate (runs under npm test AND the
// cross-platform `npm run test:determinism` matrix): the committed
// population-a-initial-composite locks must reproduce exactly — snapshot,
// initialization-manifest, evaluation-spec, and fitness-vector digests, every
// per-member fitness literal, the deterministic champion, and the champion's
// solo digest-mode trace. tests/browser/population-determinism.test.js
// re-proves the same locks in pinned Chromium.
//
// Assertion discipline: `toBe` against committed literals ONLY. The fitness
// entries are EXACT measured values — this file must never assert a fitness
// FLOOR (a threshold disguised as a determinism lock); behavioral floors
// live in witness tests under npm test. The staleness teeth on fitness are
// RELATIONAL identities (valid === false implies fitness === 0; champion ===
// recomputed argmax-with-lowest-id-tie), never magnitudes.
//
// Re-lock workflow (deliberate changes only): set the stale lock's
// fitnessVectorDigest to null, run this gate — it fails printing the FULL
// measured lock record as paste-ready JSON — paste it into
// src/sim/population-locks.js, get Node green, then pinned Chromium must
// agree before merge.

import { describe, test, expect } from 'vitest';
import { POPULATION_GOLDEN_LOCKS } from '../src/sim/population-locks.js';
import { POPULATION_FIXTURE_A, populationEvaluationInputsFor } from '../src/sim/population-fixtures.js';
import {
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION, FITNESS_VECTOR_VERSION,
  POPULATION_WORLD_MODE, championFromEvaluation, evaluatePopulation,
  selectableChampionFromEvaluation, serializeEvaluationSpec, spawnPoseOnFlatStart,
} from '../src/sim/population-evaluation.js';
import { INTEGRITY_POLICY_VERSION } from '../src/sim/integrity.js';
import { POPULATION_SNAPSHOT_VERSION, bytesEqual, serializePopulationSnapshot } from '../src/sim/population.js';
import { POPULATION_INITIALIZER_VERSION, serializePopulationInitialization } from '../src/sim/population-initializer.js';
import { GENOTYPE_VERSION, compileAssembly, serializeGenotype } from '../src/sim/assembly.js';
import { formatFitnessVectorLockMismatch } from '../src/sim/lock-markers.js';
import { EVALUATION_TRACE_VERSION, RECORD_BYTES, compareCheckpoints } from '../src/sim/trace.js';
import { runEvaluation } from '../src/sim/evaluation.js';
import { createPhysics } from '../src/sim/physics/adapter.js';
import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHex, fnv1aHexOf } from '../src/sim/fnv1a.js';

const LOCK = POPULATION_GOLDEN_LOCKS[POPULATION_FIXTURE_A.name];

function formatDivergence(div) {
  const hex = (c) => (c && c.state !== undefined ? (c.state >>> 0).toString(16).padStart(8, '0') : String(c));
  return `champion trace: first divergent checkpoint index ${div.checkpointIndex} (${div.reason}); `
    + `last agreed step ${div.lastAgreedStepIndex}, first differing step ${div.firstDifferingStepIndex}; `
    + `expected state ${hex(div.expected)} actual ${hex(div.actual)}`;
}

describe('population lock staleness teeth', () => {
  test('lock set, versions, engine, dt, and internal consistency', async () => {
    expect(Object.keys(POPULATION_GOLDEN_LOCKS)).toEqual([POPULATION_FIXTURE_A.name]);
    expect(LOCK.fixtureVersion).toBe(POPULATION_FIXTURE_A.version);
    expect(LOCK.populationSnapshotVersion).toBe(POPULATION_SNAPSHOT_VERSION);
    expect(LOCK.populationInitializerVersion).toBe(POPULATION_INITIALIZER_VERSION);
    expect(LOCK.fitnessPolicyVersion).toBe(FITNESS_POLICY_VERSION);
    expect(LOCK.fitnessVectorVersion).toBe(FITNESS_VECTOR_VERSION);
    expect(LOCK.integrityPolicyVersion).toBe(INTEGRITY_POLICY_VERSION);
    expect(LOCK.evaluationSpecVersion).toBe(EVALUATION_SPEC_VERSION);
    expect(LOCK.genotypeVersion).toBe(GENOTYPE_VERSION);
    expect(LOCK.traceVersion).toBe(EVALUATION_TRACE_VERSION);
    expect(LOCK.recordBytes).toBe(RECORD_BYTES);
    expect(LOCK.worldMode).toBe(POPULATION_WORLD_MODE);
    expect(LOCK.populationSeed).toBe(POPULATION_FIXTURE_A.populationSeed);
    expect(LOCK.terrainSeed).toBe(POPULATION_FIXTURE_A.terrainConfig.seed);
    expect(LOCK.populationSize).toBe(POPULATION_FIXTURE_A.populationConfig.populationSize);
    expect(LOCK.spawnX).toBe(POPULATION_FIXTURE_A.spawn.x);
    expect(LOCK.maxSteps).toBe(POPULATION_FIXTURE_A.maxSteps);
    expect(LOCK.effectiveDt).toBe(Math.fround(1 / 60));
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    try {
      expect(LOCK.rapierVersion, 'engine changed — re-lock deliberately').toBe(RAPIER.version());
    } finally {
      world.free();
    }
  });

  test('relational fitness identities — never magnitude floors', () => {
    expect(LOCK.individuals.length).toBe(LOCK.populationSize);
    expect(LOCK.orderedIndividualIds).toEqual(LOCK.individuals.map((i) => i.individualId));
    const ids = new Set(LOCK.orderedIndividualIds);
    expect(ids.size).toBe(LOCK.populationSize);
    for (let i = 1; i < LOCK.orderedIndividualIds.length; i += 1) {
      expect(LOCK.orderedIndividualIds[i]).toBeGreaterThan(LOCK.orderedIndividualIds[i - 1]);
    }
    for (const ind of LOCK.individuals) {
      if (!ind.valid) expect(ind.fitness).toBe(0);
    }
    // champion === the total order (greater fitness; VALID over invalid on an
    // exact tie; then lowest individualId), recomputed in-test from the lock's
    // own entries — must match championFromEvaluation's rule.
    let expected = LOCK.individuals[0];
    for (const ind of LOCK.individuals) {
      const better = ind.fitness !== expected.fitness
        ? ind.fitness > expected.fitness
        : (ind.valid !== expected.valid ? ind.valid : ind.individualId < expected.individualId);
      if (better) expected = ind;
    }
    expect(LOCK.champion.individualId).toBe(expected.individualId);
    expect(Object.is(LOCK.champion.fitness, expected.fitness)).toBe(true);
    // Champion trace internal consistency: the terminal checkpoint state IS
    // the digest; counts cohere with the record size.
    const states = LOCK.championTrace.checkpointStates;
    expect(states.length).toBe(LOCK.championTrace.captureCount);
    expect(LOCK.championTrace.captureCount).toBe(LOCK.championTrace.executedSteps + 1);
    expect(fnv1aHexOf(states[states.length - 1])).toBe(LOCK.championTrace.digest);
    expect(LOCK.championTrace.byteCount).toBe(LOCK.championTrace.recordCount * LOCK.recordBytes);
  });
});

describe('population initializer locks (pure — no physics)', () => {
  test('snapshot and initialization-manifest digests reproduce from a fresh createInitialPopulation', () => {
    const { initialization, population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    expect(fnv1aHex(serializePopulationSnapshot(population))).toBe(LOCK.populationSnapshotDigest);
    expect(fnv1aHex(serializePopulationInitialization(initialization))).toBe(LOCK.populationInitializationDigest);
    expect(population.individuals.map((i) => i.individualId)).toEqual([...LOCK.orderedIndividualIds]);
  });

  test('the champion genotype digest reproduces from the fresh population', () => {
    const { population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const champ = population.individuals.find((i) => i.individualId === LOCK.champion.individualId);
    expect(champ).toBeDefined();
    expect(fnv1aHex(serializeGenotype(champ.genotype))).toBe(LOCK.champion.genotypeDigest);
  });

  test('structural heterogeneity the fixture seed was scanned for (exact sets at this seed)', () => {
    const { initialization, population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A, { keepRaw: true });
    const families = new Set();
    const types = new Set();
    const kinds = new Set();
    const symmetric = new Set();
    const wheelCounts = new Set();
    for (const ind of population.individuals) {
      const ir = compileAssembly(ind.genotype);
      families.add(ir.chassis.family);
      for (const ax of ir.axles) { types.add(ax.suspension.type); kinds.add(ax.kind); }
      symmetric.add(ind.genotype.symmetric >= 0.5);
      wheelCounts.add(ir.axles.flatMap((a) => a.wheels).length);
    }
    expect([...families].sort()).toEqual(['hull', 'ladder', 'spine']);
    expect([...types].sort()).toEqual(['S0', 'S1']);
    expect([...kinds].sort()).toEqual(['paired', 'single']);
    expect([...symmetric].sort()).toEqual([false, true]);
    expect([...wheelCounts].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(initialization.diagnostics.filter((d) => d.wasRepaired).length).toBe(20);
  });
});

describe('population evaluation gate (deterministic flavor)', () => {
  test('two fresh evaluations agree byte-for-byte, and the second matches the committed lock', { timeout: 240000 }, async () => {
    const run = async () => {
      const { population, spec } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
      return evaluatePopulation(population, spec);
    };
    const a = await run();
    const b = await run();
    expect(b.fitnessPolicyVersion).toBe(FITNESS_POLICY_VERSION);
    expect(bytesEqual(a.fitnessVector.bytes, b.fitnessVector.bytes)).toBe(true);
    expect(b.fitnessVector.digest).toBe(a.fitnessVector.digest);
    b.individuals.forEach((ind, i) => {
      expect(Object.is(ind.fitness, a.individuals[i].fitness)).toBe(true);
      expect(ind.valid).toBe(a.individuals[i].valid);
    });

    // The re-lock workflow: a null digest fails loud with the FULL measured
    // record as paste-ready JSON (exact f64s — JSON round-trips doubles).
    if (LOCK.fitnessVectorDigest === null) {
      const champion = championFromEvaluation(b);
      const measured = {
        fitnessVectorDigest: b.fitnessVector.digest,
        evaluationSpecDigest: fnv1aHexOf(fnv1aFold(FNV_OFFSET_BASIS, serializeEvaluationSpec(b.spec))),
        individuals: b.individuals.map((i) => ({
          individualId: i.individualId,
          valid: i.valid,
          fitness: i.fitness,
          stepAtMaxForwardDistance: i.diagnostics.stepAtMaxForwardDistance,
          forwardDistance: i.diagnostics.forwardDistance,
          maxBackwardDistance: i.diagnostics.maxBackwardDistance,
        })),
        champion: { individualId: champion.individualId, fitness: champion.fitness },
      };
      expect.fail(`RE-LOCK ${POPULATION_FIXTURE_A.name} — measured record (paste into src/sim/population-locks.js):\n${JSON.stringify(measured)}`);
    }

    expect(fnv1aHexOf(fnv1aFold(FNV_OFFSET_BASIS, serializeEvaluationSpec(b.spec)))).toBe(LOCK.evaluationSpecDigest);
    // The golden fitness-vector comparison, with the STRUCTURED mismatch
    // marker as its custom message (src/sim/lock-markers.js): on an engine/
    // encoding change this test still FAILS on the real .toBe against the
    // committed lock, and the failure message carries machine-parseable
    // `expected=<lock> actual=<measured>` fields the engine-upgrade
    // adjudicator validates against src/sim/population-locks.js — the lock
    // digest is never copied into the candidate-red inventory.
    expect(
      b.fitnessVector.digest,
      `${formatFitnessVectorLockMismatch(LOCK.fitnessVectorDigest, b.fitnessVector.digest)} — engine or encoding changed; re-lock deliberately via the null-digest workflow`,
    ).toBe(LOCK.fitnessVectorDigest);
    b.individuals.forEach((ind, i) => {
      const locked = LOCK.individuals[i];
      expect(ind.individualId).toBe(locked.individualId);
      expect(ind.valid).toBe(locked.valid);
      expect(Object.is(ind.fitness, locked.fitness), `individual ${ind.individualId} fitness ${ind.fitness} !== locked ${locked.fitness}`).toBe(true);
      expect(ind.diagnostics.stepAtMaxForwardDistance).toBe(locked.stepAtMaxForwardDistance);
      expect(Object.is(ind.diagnostics.forwardDistance, locked.forwardDistance)).toBe(true);
      expect(Object.is(ind.diagnostics.maxBackwardDistance, locked.maxBackwardDistance)).toBe(true);
    });
    const champion = championFromEvaluation(b);
    expect(champion.individualId).toBe(LOCK.champion.individualId);
    expect(Object.is(champion.fitness, LOCK.champion.fitness)).toBe(true);
    // Policy v2 re-attestation: the SELECTION champion (selectable members
    // only) picks the SAME individual — the committed fixture measured
    // 20/20 integrity-clean at the v2 re-lock, so the eligibility filter is
    // a no-op here by measurement, not by assumption.
    const selectable = selectableChampionFromEvaluation(b);
    expect(selectable).not.toBeNull();
    expect(selectable.individualId).toBe(LOCK.champion.individualId);
    expect(selectable.integrityStatus).toBe('ok');
    expect(b.individuals.every((i) => i.integrityStatus === 'ok')).toBe(true);
  });

  test('champion solo digest-mode rerun reproduces the locked trace AND the locked fitness exactly (the isolation sentinel)', { timeout: 240000 }, async () => {
    const { population, spec } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const champ = population.individuals.find((i) => i.individualId === LOCK.champion.individualId);
    const ir = compileAssembly(champ.genotype);
    const r = await runEvaluation({
      deterministic: true,
      terrain: { ...spec.terrain },
      vehicles: [{
        ir,
        spawn: spawnPoseOnFlatStart(ir, spec.spawn),
        targetWheelSurfaceSpeed: spec.targetWheelSurfaceSpeed,
        wheelFriction: 1,
      }],
      maxSteps: spec.maxSteps,
      trace: { mode: 'digest', checkpointInterval: 1 },
    });
    // Diagnostic order: counts -> checkpoints -> digest (the golden-gate
    // convention: a divergence prints its first differing STEP).
    expect(r.trace.recordCount).toBe(LOCK.championTrace.recordCount);
    expect(r.trace.byteCount).toBe(LOCK.championTrace.byteCount);
    expect(r.executedSteps).toBe(LOCK.championTrace.executedSteps);
    const lockCheckpoints = LOCK.championTrace.checkpointStates.map((state, i) => ({ stepIndex: i, state }));
    const div = compareCheckpoints(lockCheckpoints, r.trace.checkpoints);
    expect(div === null ? null : formatDivergence(div)).toBeNull();
    expect(r.trace.digest).toBe(LOCK.championTrace.digest);
    // Under 'isolatedWorlds' the solo rerun IS the evaluator's world for
    // this individual: the locked fitness must reproduce EXACTLY.
    const v = r.vehicles[0];
    expect(v.finite && v.bodies.allValid && v.joints.allValid).toBe(true);
    expect(Object.is(v.maxForwardDistance, LOCK.champion.fitness)).toBe(true);
  });
});
