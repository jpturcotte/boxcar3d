// The capture boundary behind a persisted fitness-vector member.
//
// WHY THIS FILE EXISTS. `captureEvaluationMemberResult` is private and reachable
// only through `evaluatePopulation`, which runs physics — so the standing
// single-read instrument (tests/single-read.test.js) exempts `evaluatePopulation`
// as `notExercised`, and the boundary had NO tooth. A PR #27 sabotage pass
// confirmed it: replacing the capture's `member.observations` with a second read
// of `v.integrity.observations` left the entire suite green.
//
// That is round 10's standing rule recurring — *a fix no test can redden is not
// a fix* — and the remedy is the same one that round used: reach the private
// seam through the only door it has, with `runEvaluation` mocked so a vehicle
// result can carry an accessor that answers differently on a second read.
//
// The defect is UNREACHABLE in production: `v` is the runner's own result
// object, so nothing can install an accessor on it. The rule is enforced anyway
// — "unreachable today" is exactly how every previous round's defects were
// argued into existence.
//
// Seeds declared: population 20260721, terrain 20260722 (the interop pair).

import {
  describe, test, expect, vi,
} from 'vitest';

const CLEAN = Object.freeze({
  peakBodySpeed: 3.5,
  peakSpeedDelta: 1.25,
  peakStepDisplacement: 0.0625,
  firstAlertStep: null,
  firstCatastrophicStep: null,
});
// What a second read would substitute: a different, ALSO-VALID block. It has to
// be valid, or the encoder would reject it and the test would pass for the wrong
// reason — "it threw" is not the same claim as "it attested the first reading".
const SUBSTITUTED = Object.freeze({
  peakBodySpeed: 999.5,
  peakSpeedDelta: 888.25,
  peakStepDisplacement: 77.5,
  firstAlertStep: 4,
  firstCatastrophicStep: null,
});

const observationReads = { count: 0 };

vi.mock('../src/sim/evaluation.js', () => ({
  runEvaluation: async () => {
    // A minimal vehicle result carrying an ordinary own ACCESSOR on
    // `observations` — plain JavaScript, not a Proxy.
    const integrity = {
      policyVersion: 1,
      status: 'ok',
      firstFailureStep: null,
      reasons: [],
      get observations() {
        observationReads.count += 1;
        return observationReads.count === 1 ? CLEAN : SUBSTITUTED;
      },
    };
    return {
      effectiveDt: 0.01666666753590107,
      vehicles: [{
        finite: true,
        bodies: { allValid: true },
        joints: { allValid: true },
        integrity,
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
    };
  },
}));

const { evaluatePopulation, deserializeFitnessVector } = await import('../src/sim/population-evaluation.js');
const { createInitialPopulation } = await import('../src/sim/population-initializer.js');

describe('captureEvaluationMemberResult — one reading backs the attestation', () => {
  test('a two-faced observations accessor cannot change what the vector attests', async () => {
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

    // THE CLAIM: exactly one read, so there is no second answer to attest.
    expect(observationReads.count, 'the observations block is read exactly once').toBe(1);

    const decoded = deserializeFitnessVector(evaluation.fitnessVector.bytes);
    const persisted = decoded.individuals[0].integrityObservations;
    expect(persisted.peakBodySpeed).toBe(CLEAN.peakBodySpeed);
    expect(persisted.firstAlertStep).toBeNull();
    // The substituted block must appear NOWHERE — not in the bytes, and not in
    // the in-memory row the selection layer would read.
    expect(persisted.peakBodySpeed).not.toBe(SUBSTITUTED.peakBodySpeed);
    expect(evaluation.individuals[0].integrityObservations.peakBodySpeed)
      .toBe(CLEAN.peakBodySpeed);
  });
});
