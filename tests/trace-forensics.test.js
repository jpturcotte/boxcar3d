// Unit contract for the offline trace-forensics module — PURE (no physics,
// no seeds): every stream is hand-built through the sanctioned
// encodeTraceRecord codec with known injected kinematics, so each assertion
// is against an arithmetic identity, never a solver behavior.

import { describe, test, expect } from 'vitest';
import { EVALUATION_TRACE_VERSION, RECORD_BYTES, encodeTraceRecord } from '../src/sim/trace.js';
import {
  FORENSIC_THRESHOLD_DEFAULTS, TRACE_FORENSICS_SCHEMA,
  analyzeTrace, bodyReachMetadataForIR, scaledThresholds,
} from '../src/sim/trace-forensics.js';

const rec = (stepIndex, overrides = {}) => ({
  stepIndex,
  vehicleIndex: 0,
  bodyRole: 'chassis',
  axleIndex: null,
  wheelIndex: null,
  bodyValid: true,
  bodySleeping: false,
  jointState: 'notApplicable',
  terminated: false,
  terminationReason: 'none',
  finiteState: true,
  translation: { x: 0, y: 0.5, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  linvel: { x: 0, y: 0, z: 0 },
  angvel: { x: 0, y: 0, z: 0 },
  ...overrides,
});

const wheelRec = (stepIndex, overrides = {}) => rec(stepIndex, {
  bodyRole: 'wheel', axleIndex: 0, wheelIndex: 0, jointState: 'valid', ...overrides,
});

const traceOf = (records) => ({
  version: EVALUATION_TRACE_VERSION,
  mode: 'full',
  recordBytes: RECORD_BYTES,
  records: records.map((r) => encodeTraceRecord(r)),
});

describe('trace-forensics', () => {
  // Chassis-only stream: quiet -> sub-alert escalation (steps 4-5) -> speed
  // alert (step 6) -> catastrophe (step 8). Speeds are along +x; translation
  // held still so only the speed/speed-delta predicates fire.
  const vx = [3, 3, 3, 3, 5, 10, 45, 60, 2000, 2000, 2000];
  const escalatingStream = vx.map((x, k) => rec(k, { linvel: { x, y: 0, z: 0 } }));

  test('onset: alert locator, backward causal candidate, catastrophe, ordinary tail', () => {
    const a = analyzeTrace(traceOf(escalatingStream));
    expect(a.schema).toBe(TRACE_FORENSICS_SCHEMA);
    expect(a.stepRange).toEqual({ first: 0, last: 10 });
    // Alert fires on speed 45 > 25 at step 6 — not earlier (5, 10 below;
    // deltas 2 and 5 are under alertSpeedDelta 30).
    expect(a.onset.firstAlertStep).toBe(6);
    expect(a.onset.lastOrdinaryStep).toBe(5);
    // Backward scan: deltas at steps 4 (2), 5 (5), 6 (35) all exceed the
    // causal floor 1; step 3's delta is 0 — the contiguous chain starts at 4.
    expect(a.onset.firstCausalCandidateStep).toBe(4);
    // Catastrophe on speed 2000 > 1000 at step 8.
    expect(a.onset.firstCatastrophicStep).toBe(8);
    expect(a.onset.leadingBody).toEqual({
      vehicleIndex: 0, bodyRole: 'chassis', axleIndex: null, wheelIndex: null,
    });
    expect(a.onset.chassisLagSteps).toBe(0);
    const chassis = a.perBody[0];
    expect(chassis.peakSpeed).toEqual({ value: 2000, step: 8 });
    expect(chassis.peakSpeedDelta).toEqual({ value: 1940, step: 8 });
    expect(chassis.firstAlertStep).toBe(6);
    expect(chassis.firstCatastrophicStep).toBe(8);
    expect(chassis.firstNonFiniteStep).toBeNull();
  });

  test('threshold sensitivity: a discrete jump keeps its alert step in a tight band under x0.5/x2', () => {
    const steps = [0.5, 1, 2].map((f) => analyzeTrace(
      traceOf(escalatingStream),
      { thresholds: scaledThresholds(f) },
    ).onset.firstAlertStep);
    for (const s of steps) {
      expect(s).toBeGreaterThanOrEqual(6);
      expect(s).toBeLessThanOrEqual(8);
    }
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThanOrEqual(2);
  });

  test('a station body leading the chassis is identified with its lag', () => {
    const records = [];
    for (let k = 0; k <= 8; k += 1) {
      const chassisSpeed = k >= 7 ? 50 : 2;
      const wheelSpeed = k >= 5 ? 50 : 2;
      records.push(rec(k, { linvel: { x: chassisSpeed, y: 0, z: 0 } }));
      records.push(wheelRec(k, { linvel: { x: wheelSpeed, y: 0, z: 0 } }));
    }
    const a = analyzeTrace(traceOf(records));
    expect(a.onset.firstAlertStep).toBe(5);
    expect(a.onset.leadingBody).toEqual({
      vehicleIndex: 0, bodyRole: 'wheel', axleIndex: 0, wheelIndex: 0,
    });
    expect(a.onset.chassisLagSteps).toBe(2);
  });

  test('a one-step teleport is catastrophic by displacement even at modest speed', () => {
    const records = [0, 1, 2, 3].map((k) => rec(k, {
      translation: { x: k >= 2 ? 20 : 0, y: 0.5, z: 0 },
      linvel: { x: 5, y: 0, z: 0 },
    }));
    const a = analyzeTrace(traceOf(records));
    // dx = 20 m in one step: > alertStepDisplacement AND
    // > catastrophicStepDisplacement (1000/60).
    expect(a.onset.firstAlertStep).toBe(2);
    expect(a.onset.firstCatastrophicStep).toBe(2);
    expect(a.perBody[0].peakStepDisplacement).toEqual({ value: 20, step: 2 });
  });

  test('non-finite samples latch firstNonFiniteStep and can never take a peak', () => {
    const records = [
      rec(0, { linvel: { x: 2, y: 0, z: 0 } }),
      rec(1, { linvel: { x: 8, y: 0, z: 0 } }),
      rec(2, {
        finiteState: false,
        translation: { x: NaN, y: NaN, z: NaN },
        linvel: { x: NaN, y: NaN, z: NaN },
        angvel: { x: NaN, y: NaN, z: NaN },
      }),
      rec(3, {
        finiteState: false,
        translation: { x: NaN, y: NaN, z: NaN },
        linvel: { x: NaN, y: NaN, z: NaN },
        angvel: { x: NaN, y: NaN, z: NaN },
      }),
    ];
    const a = analyzeTrace(traceOf(records));
    const b = a.perBody[0];
    expect(b.firstNonFiniteStep).toBe(2);
    expect(b.peakSpeed).toEqual({ value: 8, step: 1 });
    expect(b.peakSpeedDelta).toEqual({ value: 6, step: 1 });
  });

  test('tip-speed proxy multiplies |angvel| by the body OWN reach; absent metadata leaves it null', () => {
    const records = [0, 1].map((k) => rec(k, { angvel: { x: 0, y: 0, z: 10 } }));
    const withReach = analyzeTrace(traceOf(records), {
      bodies: [{ vehicleIndex: 0, bodyRole: 'chassis', axleIndex: null, wheelIndex: null, reach: 0.5 }],
    });
    expect(withReach.perBody[0].peakAngularSpeed).toEqual({ value: 10, step: 0 });
    expect(withReach.perBody[0].peakTipSpeed).toEqual({ value: 5, step: 0 });
    const withoutReach = analyzeTrace(traceOf(records));
    expect(withoutReach.perBody[0].peakTipSpeed).toBeNull();
  });

  test('bodyReachMetadataForIR derives conservative bounding radii per station', () => {
    const ir = {
      chassis: { supports: { reach: 1.25 } },
      axles: [{
        index: 0,
        wheels: [{ radius: 0.3, width: 0.4, hub: { radius: 0.1, halfWidth: 0.05 } }],
      }, {
        index: 1,
        wheels: [{ radius: 0.5, width: 0.2, hub: null }],
      }],
    };
    expect(bodyReachMetadataForIR(ir)).toEqual([
      { vehicleIndex: 0, bodyRole: 'chassis', axleIndex: null, wheelIndex: null, reach: 1.25 },
      {
        vehicleIndex: 0, bodyRole: 'hub', axleIndex: 0, wheelIndex: 0,
        reach: Math.sqrt(0.1 * 0.1 + 0.05 * 0.05),
      },
      {
        vehicleIndex: 0, bodyRole: 'wheel', axleIndex: 0, wheelIndex: 0,
        reach: Math.sqrt(0.3 * 0.3 + 0.2 * 0.2),
      },
      {
        vehicleIndex: 0, bodyRole: 'wheel', axleIndex: 1, wheelIndex: 0,
        reach: Math.sqrt(0.5 * 0.5 + 0.1 * 0.1),
      },
    ]);
  });

  test('a fully ordinary stream classifies nothing', () => {
    const records = [0, 1, 2, 3].map((k) => rec(k, {
      translation: { x: k * 0.05, y: 0.5, z: 0 },
      linvel: { x: 3, y: 0, z: 0 },
    }));
    const a = analyzeTrace(traceOf(records));
    expect(a.onset.firstAlertStep).toBeNull();
    expect(a.onset.firstCatastrophicStep).toBeNull();
    expect(a.onset.firstCausalCandidateStep).toBeNull();
    expect(a.onset.leadingBody).toBeNull();
    expect(a.onset.lastOrdinaryStep).toBe(3);
  });

  test('sleep transitions are recorded', () => {
    const records = [0, 1, 2, 3, 4, 5, 6].map((k) => rec(k, {
      bodySleeping: k >= 3 && k <= 5,
    }));
    const b = analyzeTrace(traceOf(records)).perBody[0];
    expect(b.firstSleepingStep).toBe(3);
    expect(b.firstAwakeAfterSleepStep).toBe(6);
  });

  test('fail-loud validation: non-full traces, unknown/invalid thresholds, bad reach metadata', () => {
    const full = traceOf([rec(0)]);
    expect(() => analyzeTrace({ ...full, mode: 'digest', records: null })).toThrow(/full/);
    expect(() => analyzeTrace({ ...full, version: 99 })).toThrow(/version/);
    expect(() => analyzeTrace({ ...full, recordBytes: 64 })).toThrow(/recordBytes/);
    expect(() => analyzeTrace({ ...full, records: [] })).toThrow(/records/);
    expect(() => analyzeTrace(full, { thresholds: { alertVelocity: 1 } })).toThrow(/unknown key/);
    expect(() => analyzeTrace(full, { thresholds: { alertSpeed: 0 } })).toThrow(/alertSpeed/);
    expect(() => analyzeTrace(full, { thresholds: { alertSpeed: NaN } })).toThrow(/alertSpeed/);
    expect(() => analyzeTrace(full, {
      bodies: [{ vehicleIndex: 0, bodyRole: 'chassis', axleIndex: null, wheelIndex: null, reach: 0 }],
    })).toThrow(/reach/);
    expect(() => analyzeTrace(full, {
      bodies: [{ vehicleIndex: 0, bodyRole: 'chassis', axleIndex: null, wheelIndex: null, reach: 1, radius: 2 }],
    })).toThrow(/unknown key/);
  });

  test('scaledThresholds scales every knob and rejects a non-positive factor', () => {
    const doubled = scaledThresholds(2);
    for (const k of Object.keys(FORENSIC_THRESHOLD_DEFAULTS)) {
      expect(doubled[k]).toBe(FORENSIC_THRESHOLD_DEFAULTS[k] * 2);
    }
    expect(() => scaledThresholds(0)).toThrow(/factor/);
    expect(() => scaledThresholds(-1)).toThrow(/factor/);
  });
});
