// The numerical-integrity policy v1 contract (src/sim/integrity.js): the
// versioned vocabulary, the frozen thresholds, the pure fold's exact
// classification semantics (synthetic series — every predicate, ordering, and
// NaN rule pinned without an engine), and the ONLINE ≡ OFFLINE equivalence
// witness: the fold's classification must agree BITWISE with what
// trace-forensics' analyzeTrace derives from the full trace of the SAME run.
//
// REGRESSION ASYMMETRY (the explosion-witness rule): the equivalence tests
// are OUTCOME-AGNOSTIC — they assert the two detectors agree on whatever the
// engine produced, never that a divergence occurs. A future engine that
// converges the reproducer island turns the divergent subject quiet and these
// tests stay green.

import { describe, test, expect } from 'vitest';
import {
  INTEGRITY_POLICY_VERSION, INTEGRITY_REASONS, INTEGRITY_REFERENCE_CAPTURE_DT,
  INTEGRITY_STATUS, INTEGRITY_THRESHOLDS,
  createIntegrityState, dist3, finalizeIntegrity, foldIntegrity, norm3,
} from '../src/sim/integrity.js';
import {
  FORENSIC_THRESHOLD_DEFAULTS, REFERENCE_CAPTURE_DT,
  analyzeTrace, bodyReachMetadataForIR, offlineIntegrityView,
} from '../src/sim/trace-forensics.js';
import { runEvaluation } from '../src/sim/evaluation.js';
import { EVALUATION_TRACE_VERSION, RECORD_BYTES, encodeTraceRecord } from '../src/sim/trace.js';
import { compileAssembly } from '../src/sim/assembly.js';
import { FIXTURE_A, evaluationOptionsFor } from '../src/sim/evaluation-fixtures.js';
import { MINIMAL_REPRODUCER, WITNESS_SPEC, WITNESS_TERRAIN, reproducerGenotype } from '../scripts/explosion-witnesses.js';
import { spawnPoseOnFlatStart } from '../src/sim/population-evaluation.js';

// --- Contract constants --------------------------------------------------------

describe('policy contract', () => {
  test('versioned vocabulary: status and reason codes are fixed, ordered, frozen', () => {
    expect(INTEGRITY_POLICY_VERSION).toBe(1);
    expect(INTEGRITY_STATUS).toEqual(['ok', 'nonFinite', 'numericalDivergence']);
    expect(INTEGRITY_REASONS).toEqual(['nonFinite', 'catastrophicSpeed', 'catastrophicStepDisplacement']);
    expect(Object.isFrozen(INTEGRITY_STATUS)).toBe(true);
    expect(Object.isFrozen(INTEGRITY_REASONS)).toBe(true);
  });

  test('thresholds: exact frozen literals (policy copies, versioned here — not the diagnostic defaults)', () => {
    expect(INTEGRITY_THRESHOLDS).toEqual({
      alertSpeed: 25,
      alertSpeedDelta: 30,
      alertStepDisplacement: 25 / 60,
      catastrophicSpeed: 1000,
      catastrophicStepDisplacement: 1000 / 60,
    });
    expect(Object.isFrozen(INTEGRITY_THRESHOLDS)).toBe(true);
  });

  test('adoption-time agreement with the forensic DIAGNOSTIC defaults (a drift tooth, not an import)', () => {
    // The policy deliberately owns copies; this tooth documents that at
    // adoption the two agree on the shared keys, so a future diagnostic tweak
    // that silently diverges from policy fails HERE, forcing a deliberate
    // decision (either bump the policy or record why they now differ).
    for (const k of Object.keys(INTEGRITY_THRESHOLDS)) {
      expect(INTEGRITY_THRESHOLDS[k], k).toBe(FORENSIC_THRESHOLD_DEFAULTS[k]);
    }
    expect(INTEGRITY_REFERENCE_CAPTURE_DT).toBe(REFERENCE_CAPTURE_DT);
  });

  test('norm3/dist3 are the SHARED arithmetic (trace-forensics imports these)', () => {
    expect(norm3({ x: 3, y: 4, z: 12 })).toBe(13);
    expect(dist3({ x: 1, y: 2, z: 2 }, { x: 0, y: 0, z: 0 })).toBe(3);
  });
});

// --- Pure fold semantics (synthetic series, no engine) ---------------------------

// A synthetic body read (the captureStep shape; only the fields the fold
// consumes need to be present).
const read = ({ x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0, finite = true } = {}) => ({
  finite,
  translation: { x, y, z },
  linvel: { x: vx, y: vy, z: vz },
});

const foldSeries = (series, { bodyCount = 1, captureDt = 1 / 60 } = {}) => {
  const state = createIntegrityState(bodyCount, captureDt);
  series.forEach((reads, stepIndex) => foldIntegrity(state, stepIndex, reads));
  return finalizeIntegrity(state);
};

describe('createIntegrityState validation', () => {
  test.each([
    ['bodyCount 0', 0, 1 / 60],
    ['bodyCount negative', -1, 1 / 60],
    ['bodyCount fractional', 1.5, 1 / 60],
    ['captureDt 0', 1, 0],
    ['captureDt NaN', 1, NaN],
    ['captureDt Infinity', 1, Infinity],
    ['captureDt negative', 1, -1 / 60],
  ])('rejects %s loud', (_name, bodyCount, captureDt) => {
    expect(() => createIntegrityState(bodyCount, captureDt)).toThrow(/integrity: invalid/);
  });

  test('a reads array of the wrong length fails loud (never a silent partial fold)', () => {
    const state = createIntegrityState(2, 1 / 60);
    expect(() => foldIntegrity(state, 0, [read()])).toThrow(/reads.length/);
  });
});

describe('classification semantics (pure fold)', () => {
  test('a clean series stays ok with populated observations', () => {
    const r = foldSeries([
      [read()],
      [read({ x: 0.05, vx: 3 })],
      [read({ x: 0.1, vx: 3.2 })],
    ]);
    expect(r.policyVersion).toBe(INTEGRITY_POLICY_VERSION);
    expect(r.status).toBe('ok');
    expect(r.firstFailureStep).toBeNull();
    expect(r.reasons).toEqual([]);
    expect(Object.is(r.observations.peakBodySpeed, 3.2)).toBe(true);
    expect(Object.is(r.observations.peakSpeedDelta, 3)).toBe(true); // 0 -> 3 at step 1
    expect(Object.is(r.observations.peakStepDisplacement, 0.05)).toBe(true);
    expect(r.observations.firstAlertStep).toBeNull();
    expect(r.observations.firstCatastrophicStep).toBeNull();
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.observations)).toBe(true);
    expect(Object.isFrozen(r.reasons)).toBe(true);
  });

  test('a catastrophic SPEED crossing fails at its exact capture with the speed reason', () => {
    const r = foldSeries([
      [read()],
      [read({ vx: 999 })], // alert band, below the failure bound
      [read({ vx: 1000.5 })], // strictly above 1000
    ]);
    expect(r.status).toBe('numericalDivergence');
    expect(r.firstFailureStep).toBe(2);
    expect(r.reasons).toEqual(['catastrophicSpeed']);
    expect(r.observations.firstCatastrophicStep).toBe(2);
    expect(r.observations.firstAlertStep).toBe(1); // 999 m/s crossed the alert band first
  });

  test('a catastrophic DISPLACEMENT crossing (a low-velocity teleport) fails with the displacement reason', () => {
    const r = foldSeries([
      [read()],
      [read({ x: 20, vx: 1 })], // 20 m in one capture at reported 1 m/s
    ]);
    expect(r.status).toBe('numericalDivergence');
    expect(r.firstFailureStep).toBe(1);
    expect(r.reasons).toEqual(['catastrophicStepDisplacement']);
  });

  test('both catastrophic arms at one capture record both reasons, speed first (the documented order)', () => {
    const r = foldSeries([
      [read()],
      [read({ x: 100, vx: 5000 })],
    ]);
    expect(r.status).toBe('numericalDivergence');
    expect(r.reasons).toEqual(['catastrophicSpeed', 'catastrophicStepDisplacement']);
  });

  test('nonFinite BEFORE a later catastrophic: status is the FIRST failure class; later reasons still append', () => {
    const r = foldSeries([
      [read()],
      [read({ finite: false, x: NaN, vx: NaN })],
      [read({ vx: 2000 })],
    ]);
    expect(r.status).toBe('nonFinite');
    expect(r.firstFailureStep).toBe(1);
    expect(r.reasons).toEqual(['nonFinite', 'catastrophicSpeed']);
  });

  test('catastrophic BEFORE a later nonFinite: status stays numericalDivergence; nonFinite appends', () => {
    const r = foldSeries([
      [read()],
      [read({ vx: 2000 })],
      [read({ finite: false, x: NaN, vx: NaN })],
    ]);
    expect(r.status).toBe('numericalDivergence');
    expect(r.firstFailureStep).toBe(1);
    expect(r.reasons).toEqual(['catastrophicSpeed', 'nonFinite']);
    expect(r.observations.firstCatastrophicStep).toBe(1);
  });

  test('the ALERT band alone is an observation, never a failure (the policy-v1 ruling)', () => {
    const r = foldSeries([
      [read()],
      [read({ vx: 30 })], // 30 m/s > alertSpeed 25, far below 1000
      [read({ x: 0.5, vx: 30 })],
    ]);
    expect(r.status).toBe('ok');
    expect(r.reasons).toEqual([]);
    expect(r.observations.firstAlertStep).toBe(1);
    expect(r.observations.firstCatastrophicStep).toBeNull();
  });

  test('a value exactly AT a threshold does not fire (strict >, the analyzeTrace parity rule)', () => {
    const atSpeed = foldSeries([[read({ vx: 1000 })]]);
    expect(atSpeed.status).toBe('ok');
    const atAlert = foldSeries([[read({ vx: 25 })]]);
    expect(atAlert.observations.firstAlertStep).toBeNull();
    const justOver = foldSeries([[read({ vx: 1000.0000000001 })]]);
    expect(justOver.status).toBe('numericalDivergence');
  });

  test('per-capture thresholds scale with captureDt; absolute speed thresholds never do', () => {
    // At dt 1/120 the displacement bound halves (1000/60 * 0.5 ≈ 8.33 m):
    // a 10 m one-capture displacement fails at 1/120 but not at 1/60.
    const series = [[read()], [read({ x: 10, vx: 1 })]];
    expect(foldSeries(series, { captureDt: 1 / 120 }).status).toBe('numericalDivergence');
    expect(foldSeries(series, { captureDt: 1 / 60 }).status).toBe('ok');
    // The absolute speed bound is dt-independent.
    const fast = [[read({ vx: 1001 })]];
    expect(foldSeries(fast, { captureDt: 1 / 120 }).status).toBe('numericalDivergence');
    expect(foldSeries(fast, { captureDt: 1 / 60 }).status).toBe('numericalDivergence');
  });

  test('NaN samples take no peak and fire no predicate; the prev scratch updates UNCONDITIONALLY', () => {
    const r = foldSeries([
      [read({ vx: 2 })],
      [read({ finite: false, x: NaN, vx: NaN })], // NaN capture
      // Delta from the NaN capture is NaN -> fires nothing even though the
      // apparent jump from capture 0 would be enormous.
      [read({ x: 50, vx: 3 })],
      // The NEXT delta is real again (prev was updated with the finite 50).
      [read({ x: 50.5, vx: 3 })],
    ]);
    expect(r.status).toBe('nonFinite'); // from the NaN capture, not any teleport
    expect(r.reasons).toEqual(['nonFinite']);
    expect(r.observations.firstCatastrophicStep).toBeNull();
    // Peaks never absorbed a NaN: the biggest finite delta is 0.5 (exact f64).
    expect(Object.is(r.observations.peakStepDisplacement, 0.5)).toBe(true);
    expect(Object.is(r.observations.peakBodySpeed, 3)).toBe(true);
  });

  test('multi-body: ANY body classifies the vehicle; body order fixes reason order at a shared capture', () => {
    const r = foldSeries([
      [read(), read()],
      // body 0 teleports (displacement), body 1 is over the speed bound —
      // body order puts the displacement reason first at this capture.
      [read({ x: 20, vx: 1 }), read({ vx: 1500 })],
    ], { bodyCount: 2 });
    expect(r.status).toBe('numericalDivergence');
    expect(r.firstFailureStep).toBe(1);
    expect(r.reasons).toEqual(['catastrophicStepDisplacement', 'catastrophicSpeed']);
  });

  test('foldIntegrity returns the state for chaining (the foldProgress convention)', () => {
    const state = createIntegrityState(1, 1 / 60);
    expect(foldIntegrity(state, 0, [read()])).toBe(state);
  });
});

// --- Online ≡ offline classification equivalence (pure, codec-fed) ----------------
//
// The SAME synthetic series is fed through BOTH detectors — the online fold
// directly, and the offline pipeline via encodeTraceRecord → analyzeTrace →
// offlineIntegrityView — with no engine anywhere, so every ordering rule
// (class precedence, body-order tie-breaks, reason order) is pinned as an
// arithmetic identity between the two implementations, including the tie
// cases a real run cannot be steered into deterministically.

// Canonical body identities per read index (the runner's order: chassis
// first, then stations — analyzeTrace's report sort reproduces this order).
const TRACE_BODY_IDENTITIES = [
  { bodyRole: 'chassis', axleIndex: null, wheelIndex: null, jointState: 'notApplicable' },
  { bodyRole: 'wheel', axleIndex: 0, wheelIndex: 0, jointState: 'valid' },
];

function traceOfSeries(series) {
  const records = [];
  series.forEach((reads, stepIndex) => {
    reads.forEach((r, bodyIndex) => {
      records.push(encodeTraceRecord({
        stepIndex,
        vehicleIndex: 0,
        ...TRACE_BODY_IDENTITIES[bodyIndex],
        bodyValid: true,
        bodySleeping: false,
        terminated: false,
        terminationReason: 'none',
        finiteState: r.finite,
        translation: r.translation,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        linvel: r.linvel,
        angvel: { x: 0, y: 0, z: 0 },
      }));
    });
  });
  return {
    version: EVALUATION_TRACE_VERSION, mode: 'full', recordBytes: RECORD_BYTES, records,
  };
}

const bothDetectors = (series, { bodyCount = 1, captureDt = 1 / 60 } = {}) => ({
  online: foldSeries(series, { bodyCount, captureDt }),
  offline: offlineIntegrityView(analyzeTrace(traceOfSeries(series), { captureDt })),
});

describe('online ≡ offline classification equivalence (pure, codec-fed)', () => {
  const agree = ({ online, offline }) => {
    expect(online.status).toBe(offline.status);
    expect(online.firstFailureStep).toBe(offline.firstFailureStep);
    expect([...online.reasons]).toEqual([...offline.reasons]);
    expect(Object.is(online.observations.peakBodySpeed, offline.observations.peakBodySpeed)).toBe(true);
    expect(Object.is(online.observations.peakSpeedDelta, offline.observations.peakSpeedDelta)).toBe(true);
    expect(Object.is(online.observations.peakStepDisplacement, offline.observations.peakStepDisplacement)).toBe(true);
    expect(online.observations.firstAlertStep).toBe(offline.observations.firstAlertStep);
    expect(online.observations.firstCatastrophicStep).toBe(offline.observations.firstCatastrophicStep);
    return { online, offline };
  };

  test('clean series: both derive ok / null / empty', () => {
    const { online } = agree(bothDetectors([
      [read()],
      [read({ x: 0.05, vx: 3 })],
      [read({ x: 0.1, vx: 3.2 })],
    ]));
    expect(online.status).toBe('ok');
    expect(online.reasons).toEqual([]);
  });

  test('catastrophic BEFORE a later nonFinite: divergence status, both reasons in order', () => {
    const { online } = agree(bothDetectors([
      [read()],
      [read({ vx: 2000 })],
      [read({ finite: false, x: NaN, vx: NaN })],
    ]));
    expect(online.status).toBe('numericalDivergence');
    expect(online.firstFailureStep).toBe(1);
    expect(online.reasons).toEqual(['catastrophicSpeed', 'nonFinite']);
  });

  test('nonFinite BEFORE a later catastrophic: nonFinite status, both reasons in order', () => {
    const { online } = agree(bothDetectors([
      [read()],
      [read({ finite: false, x: NaN, vx: NaN })],
      [read({ vx: 2000 })],
    ]));
    expect(online.status).toBe('nonFinite');
    expect(online.firstFailureStep).toBe(1);
    expect(online.reasons).toEqual(['nonFinite', 'catastrophicSpeed']);
  });

  test('same-capture SAME-BODY tie: catastrophic outranks nonFinite (the intra-body check order)', () => {
    // One capture carries BOTH a catastrophic displacement (finite numbers)
    // and the non-finite flag — the online fold checks catastrophic first.
    const { online } = agree(bothDetectors([
      [read()],
      [read({ finite: false, x: 20, vx: 1 })],
    ]));
    expect(online.status).toBe('numericalDivergence');
    expect(online.firstFailureStep).toBe(1);
    expect(online.reasons).toEqual(['catastrophicStepDisplacement', 'nonFinite']);
  });

  test('same-capture CROSS-BODY tie: body order decides (earlier body nonFinite beats later body catastrophic)', () => {
    const { online } = agree(bothDetectors([
      [read(), read()],
      [read({ finite: false, x: NaN, vx: NaN }), read({ vx: 1500 })],
    ], { bodyCount: 2 }));
    expect(online.status).toBe('nonFinite');
    expect(online.firstFailureStep).toBe(1);
    expect(online.reasons).toEqual(['nonFinite', 'catastrophicSpeed']);
  });

  test('multiple reasons at one capture: speed before displacement (intra-body rank); cross-body reason order follows body order', () => {
    const sameBody = agree(bothDetectors([
      [read()],
      [read({ x: 100, vx: 5000 })],
    ]));
    expect(sameBody.online.reasons).toEqual(['catastrophicSpeed', 'catastrophicStepDisplacement']);
    const crossBody = agree(bothDetectors([
      [read(), read()],
      [read({ x: 20, vx: 1 }), read({ vx: 1500 })],
    ], { bodyCount: 2 }));
    expect(crossBody.online.status).toBe('numericalDivergence');
    expect(crossBody.online.reasons).toEqual(['catastrophicStepDisplacement', 'catastrophicSpeed']);
  });

  test('the captureDt convention holds through the derivation (1/120 halves the displacement bound on BOTH arms)', () => {
    const series = [[read()], [read({ x: 10, vx: 1 })]];
    const at120 = agree(bothDetectors(series, { captureDt: 1 / 120 }));
    expect(at120.online.status).toBe('numericalDivergence');
    const at60 = agree(bothDetectors(series, { captureDt: 1 / 60 }));
    expect(at60.online.status).toBe('ok');
  });
});

// --- Online ≡ offline equivalence (deterministic flavor, outcome-agnostic) -------

// The FULL agreement contract, via the ONE shared derivation
// (trace-forensics.offlineIntegrityView — the same function probe-integrity
// consumes, so neither the field set nor the classification logic can drift
// between the two sites): status, firstFailureStep, the ordered reasons
// array, and every shared observation, bitwise. Used ONLY to compare the two
// detectors over the same run — never to assert what the engine did.
function expectFullAgreement(online, offline) {
  expect(online.status).toBe(offline.status);
  expect(online.firstFailureStep).toBe(offline.firstFailureStep);
  expect([...online.reasons]).toEqual([...offline.reasons]);
  expect(Object.is(online.observations.peakBodySpeed, offline.observations.peakBodySpeed)).toBe(true);
  expect(Object.is(online.observations.peakSpeedDelta, offline.observations.peakSpeedDelta)).toBe(true);
  expect(Object.is(online.observations.peakStepDisplacement, offline.observations.peakStepDisplacement)).toBe(true);
  expect(online.observations.firstAlertStep).toBe(offline.observations.firstAlertStep);
  expect(online.observations.firstCatastrophicStep).toBe(offline.observations.firstCatastrophicStep);
}

async function equivalenceSubject(runOptions, ir) {
  const r = await runEvaluation({ ...runOptions, trace: { mode: 'full', checkpointInterval: 1 } });
  const online = r.vehicles[0].integrity;
  const analysis = analyzeTrace(r.trace, {
    bodies: bodyReachMetadataForIR(ir),
    captureDt: r.effectiveDt, // the pinned convention: BOTH arms use the engine readback
  });
  const offline = offlineIntegrityView(analysis);
  expectFullAgreement(online, offline);
  return { online, offline };
}

describe('online ≡ offline equivalence (deterministic flavor)', () => {
  test('a healthy committed fixture: both arms agree bitwise (expected quiet)', { timeout: 240000 }, async () => {
    const ir = compileAssembly(FIXTURE_A.buildGenotype());
    const { online } = await equivalenceSubject(
      { ...evaluationOptionsFor(FIXTURE_A), deterministic: true },
      ir,
    );
    // Fixture A is a curated healthy fixture on flat terrain — its integrity
    // block being clean is a behavioral gate on a known-good subject (NOT a
    // must-explode assertion anywhere).
    expect(online.status).toBe('ok');
  });

  test('the committed minimal reproducer: both arms agree bitwise on WHATEVER this engine produces', { timeout: 240000 }, async () => {
    const ir = compileAssembly(reproducerGenotype());
    await equivalenceSubject({
      deterministic: true,
      terrain: { ...WITNESS_TERRAIN, ...MINIMAL_REPRODUCER.terrainOverrides },
      vehicles: [{
        ir,
        spawn: spawnPoseOnFlatStart(ir, { ...WITNESS_SPEC.spawn }),
        targetWheelSurfaceSpeed: WITNESS_SPEC.targetWheelSurfaceSpeed,
        wheelFriction: WITNESS_SPEC.wheelFriction,
      }],
      maxSteps: WITNESS_SPEC.maxSteps,
      termination: 'maxSteps',
    }, ir);
    // Deliberately NO assertion on the outcome: on rapier 0.19.3 this subject
    // diverges (an observation recorded in the probe and the report); on a
    // future engine it may be quiet. Either way both detectors must agree.
  });
});
