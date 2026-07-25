// The private capture boundary is reachable only through evaluatePopulation.
// Mocking runEvaluation lets this test prove that one observation-block reading
// backs both the in-memory member and the persisted fitness-vector member.

import {
  describe, expect, test, vi,
} from 'vitest';

const CLEAN = Object.freeze({
  peakBodySpeed: 3.5,
  peakSpeedDelta: 1.25,
  peakStepDisplacement: 0.0625,
  firstAlertStep: null,
  firstCatastrophicStep: null,
});
const SUBSTITUTED = Object.freeze({
  peakBodySpeed: 999.5,
  peakSpeedDelta: 888.25,
  peakStepDisplacement: 77.5,
  firstAlertStep: 4,
  firstCatastrophicStep: null,
});
const observationReads = { count: 0 };

vi.mock('../src/sim/evaluation.js', () => ({
  runEvaluation: async () => ({
    effectiveDt: 0.01666666753590107,
    vehicles: [{
      finite: true,
      bodies: { allValid: true },
      joints: { allValid: true },
      integrity: {
        policyVersion: 1,
        status: 'ok',
        firstFailureStep: null,
        reasons: [],
        get observations() {
          observationReads.count += 1;
          return observationReads.count === 1 ? CLEAN : SUBSTITUTED;
        },
      },
      forwardDistance: 2.5,
      maxForwardDistance: 2.5,
      stepAtMaxForwardDistance: 10,
      maxBackwardDistance: 0,
      origin: { x: 0, y: 0, z: 0 },
      finalPose: { translation: { x: 2.5, y: 0, z: 0 }, rotation: {} },
      finalVelocity: {},
      terminated: null,
      mass: {},
      stationCount: 0,
    }],
  }),
}));

const { deserializeFitnessVector, evaluatePopulation } = await import('../src/sim/population-evaluation.js');
const { createInitialPopulation } = await import('../src/sim/population-initializer.js');

describe('captureEvaluationMemberResult', () => {
  test('one observations reading backs both the member and its persisted attestation', async () => {
    observationReads.count = 0;
    const { population } = createInitialPopulation({ seed: 20260721, populationSize: 1 });
    const evaluation = await evaluatePopulation(population, {
      terrain: {
        seed: 20260722, startFlatLength: 40, craterDensity: 0, featureDensity: 0,
      },
      maxSteps: 10,
      deterministic: true,
      spawn: { x: -44, z: 0 },
    });

    expect(observationReads.count).toBe(1);
    const persisted = deserializeFitnessVector(evaluation.fitnessVector.bytes)
      .individuals[0].integrityObservations;
    expect(persisted.peakBodySpeed).toBe(CLEAN.peakBodySpeed);
    expect(persisted.firstAlertStep).toBeNull();
    expect(persisted.peakBodySpeed).not.toBe(SUBSTITUTED.peakBodySpeed);
    expect(evaluation.individuals[0].integrityObservations.peakBodySpeed)
      .toBe(CLEAN.peakBodySpeed);
  });
});
