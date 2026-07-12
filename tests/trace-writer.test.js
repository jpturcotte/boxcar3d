import { describe, test, expect } from 'vitest';
import {
  EVALUATION_TRACE_VERSION, RECORD_BYTES,
  TraceWriter, encodeTraceRecord, compareCheckpoints,
} from '../src/sim/trace.js';
import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHexOf } from '../src/sim/fnv1a.js';

// TraceWriter contract: capture modes, streaming checkpoints, write-time
// canonical-order enforcement, and the no-duplicate terminal checkpoint rule.

function rec(stepIndex, vehicleIndex, bodyRole, axleIndex, wheelIndex, v) {
  const station = bodyRole !== 'chassis';
  return {
    stepIndex,
    vehicleIndex,
    bodyRole,
    axleIndex: station ? axleIndex : null,
    wheelIndex: station ? wheelIndex : null,
    bodyValid: true,
    bodySleeping: false,
    jointState: 'valid',
    terminated: false,
    terminationReason: 'none',
    finiteState: true,
    translation: { x: v, y: v + 0.5, z: -v },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linvel: { x: v * 2, y: 0, z: 0 },
    angvel: { x: 0, y: 0, z: v * 3 },
  };
}

// One S1-shaped vehicle: chassis, then one station (hub before wheel).
function stepBatch(stepIndex, valueBase) {
  return [
    rec(stepIndex, 0, 'chassis', null, null, valueBase),
    rec(stepIndex, 0, 'hub', 0, 0, valueBase + 0.125),
    rec(stepIndex, 0, 'wheel', 0, 0, valueBase + 0.25),
  ];
}

function runWriter(mode, batches, { checkpointInterval = 1 } = {}) {
  const w = new TraceWriter({ mode, checkpointInterval });
  for (const [stepIndex, records] of batches) {
    for (const r of records) w.record(r);
    w.endStep(stepIndex);
  }
  return w.finish();
}

const fiveSteps = () => Array.from({ length: 5 }, (_, s) => [s, stepBatch(s, s * 10)]);

describe('TraceWriter (W1–W9)', () => {
  test('W1: mode none does no work and returns the null envelope', () => {
    const w = new TraceWriter({ mode: 'none' });
    expect(() => w.record({ complete: 'garbage' })).not.toThrow(); // literal early return
    expect(() => w.endStep(0)).not.toThrow();
    expect(w.finish()).toEqual({
      version: EVALUATION_TRACE_VERSION,
      mode: 'none',
      recordBytes: RECORD_BYTES,
      recordCount: null,
      byteCount: null,
      digest: null,
      checkpoints: null,
      records: null,
    });
    expect(() => w.record(stepBatch(0, 0)[0])).toThrow(/after finish/);
  });

  test('W2: digest mode retains no records; digest equals an independent fold', () => {
    const batches = fiveSteps();
    const out = runWriter('digest', batches);
    expect(out.recordCount).toBe(15);
    expect(out.byteCount).toBe(15 * RECORD_BYTES);
    expect(out.records).toBeNull();
    let state = FNV_OFFSET_BASIS;
    for (const [, records] of batches) {
      for (const r of records) state = fnv1aFold(state, encodeTraceRecord(r));
    }
    expect(out.digest).toBe(fnv1aHexOf(state));
    // The digest is order-sensitive at the byte level (why write-time ordering
    // enforcement matters): folding the same two records swapped differs.
    const a = encodeTraceRecord(stepBatch(0, 0)[0]);
    const b = encodeTraceRecord(stepBatch(0, 1)[0]);
    const ab = fnv1aFold(fnv1aFold(FNV_OFFSET_BASIS, a), b);
    const ba = fnv1aFold(fnv1aFold(FNV_OFFSET_BASIS, b), a);
    expect(ab).not.toBe(ba);
  });

  test('W3: full mode produces the identical digest and retains true copies', () => {
    const batches = fiveSteps();
    const digest = runWriter('digest', batches);
    const full = runWriter('full', batches);
    expect(full.digest).toBe(digest.digest);
    expect(full.recordCount).toBe(digest.recordCount);
    expect(full.byteCount).toBe(digest.byteCount);
    expect(full.records).toHaveLength(15);
    const inputs = batches.flatMap(([, records]) => records);
    full.records.forEach((bytes, i) => {
      expect([...bytes]).toEqual([...encodeTraceRecord(inputs[i])]);
    });
    // Scratch-aliasing tooth: stored records must be distinct buffers with
    // distinct content, never fifteen views of one reused scratch.
    expect(full.records[0]).not.toBe(full.records[1]);
    expect([...full.records[0]]).not.toEqual([...full.records[1]]);
    // Folding the returned records reproduces the digest.
    let state = FNV_OFFSET_BASIS;
    for (const bytes of full.records) state = fnv1aFold(state, bytes);
    expect(fnv1aHexOf(state)).toBe(full.digest);
  });

  test('W4: empty trace', () => {
    const out = runWriter('full', []);
    expect(out.digest).toBe('811c9dc5');
    expect(out.recordCount).toBe(0);
    expect(out.byteCount).toBe(0);
    expect(out.records).toEqual([]);
    expect(out.checkpoints).toEqual([]);
  });

  test('W5: interval 1 — one checkpoint per ended step, no duplicated tail, prefix-resumable states', () => {
    const batches = fiveSteps();
    const out = runWriter('digest', batches);
    expect(out.checkpoints).toHaveLength(5); // exactly one per endStep — finish() added nothing
    out.checkpoints.forEach((cp, k) => {
      expect(cp.stepIndex).toBe(k);
      expect(cp.recordCount).toBe((k + 1) * 3);
      expect(cp.byteCount).toBe(cp.recordCount * RECORD_BYTES);
    });
    // Checkpoint k's state equals a fresh writer fed only steps <= k.
    for (let k = 0; k < 5; k += 1) {
      const prefix = runWriter('digest', batches.slice(0, k + 1));
      expect(fnv1aHexOf(out.checkpoints[k].state)).toBe(prefix.digest);
    }
    // Terminal state matches the final digest.
    expect(fnv1aHexOf(out.checkpoints[4].state)).toBe(out.digest);
  });

  test('W6: interval 5 over 12 steps — checkpoints at the 5th and 10th ended steps plus one terminal', () => {
    const batches = Array.from({ length: 12 }, (_, s) => [s, stepBatch(s, s)]);
    const out = runWriter('digest', batches, { checkpointInterval: 5 });
    expect(out.checkpoints.map((c) => c.stepIndex)).toEqual([4, 9, 11]);
    expect(fnv1aHexOf(out.checkpoints[2].state)).toBe(out.digest);
  });

  test('W7: checkpoint localization finds the first divergent step or block', () => {
    const base = fiveSteps().concat(Array.from({ length: 5 }, (_, i) => [i + 5, stepBatch(i + 5, (i + 5) * 10)]));
    const mutated = base.map(([s, records]) => [
      s,
      s === 7 ? records.map((r, j) => (j === 1 ? { ...r, linvel: { ...r.linvel, y: 42 } } : r)) : records,
    ]);
    const a = runWriter('digest', base);
    const b = runWriter('digest', mutated);
    const div = compareCheckpoints(a.checkpoints, b.checkpoints);
    expect(div).toMatchObject({
      checkpointIndex: 7,
      reason: 'state',
      lastAgreedStepIndex: 6,
      firstDifferingStepIndex: 7,
    });
    // Interval 5 brackets the divergence to a block: checkpoints at steps 4
    // and 9 — step 4 agrees, step 9 differs, so the bad step is in (4, 9].
    const a5 = runWriter('digest', base, { checkpointInterval: 5 });
    const b5 = runWriter('digest', mutated, { checkpointInterval: 5 });
    const div5 = compareCheckpoints(a5.checkpoints, b5.checkpoints);
    expect(div5).toMatchObject({ reason: 'state', lastAgreedStepIndex: 4, firstDifferingStepIndex: 9 });
    // A structurally missing record surfaces as recordCount, not state.
    const dropped = base.map(([s, records]) => [s, s === 3 ? records.slice(0, 2) : records]);
    const c = runWriter('digest', dropped);
    expect(compareCheckpoints(a.checkpoints, c.checkpoints)).toMatchObject({
      checkpointIndex: 3,
      reason: 'recordCount',
    });
    // A shorter run surfaces as length.
    const short = runWriter('digest', base.slice(0, 6));
    expect(compareCheckpoints(a.checkpoints, short.checkpoints)).toMatchObject({
      checkpointIndex: 6,
      reason: 'length',
      firstDifferingStepIndex: 6,
    });
    // Identical runs → null.
    expect(compareCheckpoints(a.checkpoints, runWriter('digest', base).checkpoints)).toBeNull();
    // Partial lock-style entries ({stepIndex, state} only) compare cleanly.
    const partial = a.checkpoints.map(({ stepIndex, state }) => ({ stepIndex, state }));
    expect(compareCheckpoints(partial, a.checkpoints)).toBeNull();
    expect(compareCheckpoints(partial, b.checkpoints)).toMatchObject({ checkpointIndex: 7, reason: 'state' });
  });

  test('W8: lifecycle and canonical-order fail-loud', () => {
    // Decreasing step.
    let w = new TraceWriter();
    w.record(rec(5, 0, 'chassis', null, null, 1));
    expect(() => w.record(rec(4, 0, 'chassis', null, null, 1))).toThrow(/out of canonical order/);
    // Exact duplicate key.
    w = new TraceWriter();
    w.record(rec(0, 0, 'chassis', null, null, 1));
    expect(() => w.record(rec(0, 0, 'chassis', null, null, 2))).toThrow(/out of canonical order/);
    // Vehicle 2 before vehicle 1 within a step.
    w = new TraceWriter();
    w.record(rec(0, 2, 'chassis', null, null, 1));
    expect(() => w.record(rec(0, 1, 'chassis', null, null, 1))).toThrow(/out of canonical order/);
    // Wheel before its hub at a station (hub roleCode 1 < wheel roleCode 2).
    w = new TraceWriter();
    w.record(rec(0, 0, 'wheel', 0, 0, 1));
    expect(() => w.record(rec(0, 0, 'hub', 0, 0, 1))).toThrow(/out of canonical order/);
    // Station order: axle-then-wheel — axle 1 before axle 0 throws.
    w = new TraceWriter();
    w.record(rec(0, 0, 'hub', 1, 0, 1));
    expect(() => w.record(rec(0, 0, 'hub', 0, 0, 1))).toThrow(/out of canonical order/);
    // Record for an already-ended step.
    w = new TraceWriter();
    w.record(rec(5, 0, 'chassis', null, null, 1));
    w.endStep(5);
    expect(() => w.record(rec(5, 0, 'hub', 0, 0, 1))).toThrow(/already-ended step/);
    // endStep must advance; endStep behind recorded steps.
    w = new TraceWriter();
    w.endStep(5);
    expect(() => w.endStep(5)).toThrow(/endStep must advance/);
    w = new TraceWriter();
    w.record(rec(4, 0, 'chassis', null, null, 1));
    expect(() => w.endStep(3)).toThrow(/endStep behind recorded steps/);
    // Dead after finish.
    w = new TraceWriter();
    w.finish();
    expect(() => w.record(rec(0, 0, 'chassis', null, null, 1))).toThrow(/after finish/);
    expect(() => w.endStep(0)).toThrow(/after finish/);
    expect(() => w.finish()).toThrow(/after finish/);
    // Constructor validation.
    expect(() => new TraceWriter({ mode: 'digset' })).toThrow(/invalid mode/);
    expect(() => new TraceWriter({ checkpointInterval: 0 })).toThrow(/invalid checkpointInterval/);
    expect(() => new TraceWriter({ checkpointInterval: 2.5 })).toThrow(/invalid checkpointInterval/);
  });

  test('W9: every digest-producing envelope carries count and bytes beside the digest', () => {
    for (const mode of ['digest', 'full']) {
      const out = runWriter(mode, fiveSteps());
      expect(out.version).toBe(EVALUATION_TRACE_VERSION);
      expect(out.recordBytes).toBe(RECORD_BYTES);
      expect(typeof out.digest).toBe('string');
      expect(out.digest).toMatch(/^[0-9a-f]{8}$/);
      expect(out.recordCount).toBe(15);
      expect(out.byteCount).toBe(15 * RECORD_BYTES);
      expect(Array.isArray(out.checkpoints)).toBe(true);
    }
  });
});
