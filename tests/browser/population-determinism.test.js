// The Chromium population/fitness gate: pinned-browser reproduction of the
// committed population-a-initial-composite locks. There is NO second
// simulation loop here — this file is imports plus assertions (the
// evaluation-determinism browser gate's ruling): the same production modules
// Vite serves to Node run in Chromium and must land the same digests, the
// same per-member fitness literals, and the same champion trace.
//
// Because the fixture keeps the composite terrain defaults ON and evaluates
// per-individual isolated worlds, agreement here transitively proves the
// initializer draw table, the repair pass, the snapshot/manifest/spec/vector
// encodings, spawn placement, and the per-individual physics bit-identical
// in the browser. Nothing is claimed about rendering or the default flavor.

import { describe, test, expect } from 'vitest';
import { POPULATION_GOLDEN_LOCKS } from '../../src/sim/population-locks.js';
import { POPULATION_FIXTURE_A, populationEvaluationInputsFor } from '../../src/sim/population-fixtures.js';
import {
  championFromEvaluation, evaluatePopulation, spawnPoseOnFlatStart,
} from '../../src/sim/population-evaluation.js';
import { serializePopulationSnapshot } from '../../src/sim/population.js';
import { serializePopulationInitialization } from '../../src/sim/population-initializer.js';
import { compileAssembly } from '../../src/sim/assembly.js';
import { runEvaluation } from '../../src/sim/evaluation.js';
import { compareCheckpoints } from '../../src/sim/trace.js';
import { fnv1aHex } from '../../src/sim/fnv1a.js';

const LOCK = POPULATION_GOLDEN_LOCKS[POPULATION_FIXTURE_A.name];

describe('population golden locks (Chromium)', () => {
  test('pure initializer locks: snapshot + initialization digests', () => {
    console.log(`population browser gate on: ${navigator.userAgent}`);
    const { initialization, population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    expect(fnv1aHex(serializePopulationSnapshot(population))).toBe(LOCK.populationSnapshotDigest);
    expect(fnv1aHex(serializePopulationInitialization(initialization))).toBe(LOCK.populationInitializationDigest);
  });

  test('evaluation: fitness-vector digest, every fitness literal by individualId, champion', { timeout: 240000 }, async () => {
    const { population, spec } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const ev = await evaluatePopulation(population, spec);
    expect(ev.fitnessVector.digest).toBe(LOCK.fitnessVectorDigest);
    expect(ev.individuals.length).toBe(LOCK.individuals.length);
    ev.individuals.forEach((ind, i) => {
      const locked = LOCK.individuals[i];
      expect(ind.individualId).toBe(locked.individualId);
      expect(ind.valid).toBe(locked.valid);
      expect(Object.is(ind.fitness, locked.fitness), `individual ${ind.individualId}: ${ind.fitness} !== locked ${locked.fitness}`).toBe(true);
    });
    const champion = championFromEvaluation(ev);
    expect(champion.individualId).toBe(LOCK.champion.individualId);
    expect(Object.is(champion.fitness, LOCK.champion.fitness)).toBe(true);
  });

  test('champion solo digest-mode rerun matches the locked trace', { timeout: 240000 }, async () => {
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
    expect(r.trace.recordCount).toBe(LOCK.championTrace.recordCount);
    const lockCheckpoints = LOCK.championTrace.checkpointStates.map((state, i) => ({ stepIndex: i, state }));
    const div = compareCheckpoints(lockCheckpoints, r.trace.checkpoints);
    expect(
      div === null ? null : `first divergent step ${div.firstDifferingStepIndex} (state ${(div.actual?.state >>> 0).toString(16)}) — capture the full record in Node for forensics`,
    ).toBeNull();
    expect(r.trace.digest).toBe(LOCK.championTrace.digest);
    expect(Object.is(r.vehicles[0].maxForwardDistance, LOCK.champion.fitness)).toBe(true);
  });
});
