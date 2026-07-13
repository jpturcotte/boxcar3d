// The determinism gates (mission §11): same-process fresh-world byte-identity
// for fixtures A–D, default-flavor per-process repeatability, the committed
// golden locks with their staleness teeth and re-lock workflow, and the
// determinism-adjacent teeth (profiler neutrality, capture-mode invariance,
// the f32-backedness one-shot, the ghost-isolation bit-equality lock).
//
// This file plus tests/evaluation-golden.test.js form `npm run
// test:determinism` — the narrow command the CI OS matrix and the Chromium
// job build on. Byte-identity is asserted on the DETERMINISTIC flavor only;
// the default flavor gets per-process repeatability and NO cross-platform
// lock or promise (F10).
//
// MEASURED (this worktree, Windows, 2026-07-11, deterministic flavor; the
// per-wheel surface-speed drive law re-locked B/C and added D — A reproduced):
//   A digest 5a219735 (3005 records), B 02a80181 (6307), C 6b83729e (15025),
//   D e2fc7625 (3005 — the mixed-radius 0.3/0.6 m lock)
//   fround tooth: 39,065/39,065 traced floats of fixture A are exactly
//     f32-representable (Math.fround(v) === v) — Rapier's exposed state is
//     f32-backed; the trace keeps lossless f64 encoding regardless (pre-ruled:
//     if this tooth ever fails, KEEP f64 and record which fields differ here).
//   ghost isolation: vehicle 0's full 3005-record trace is BIT-EQUAL between
//     a solo run and a run sharing its world with an identical ghost — locked
//     below (the worker-sharding equivalence witness).

import { describe, test, expect } from 'vitest';
import { runEvaluation, EVALUATION_TRACE_VERSION } from '../src/sim/evaluation.js';
import { EVALUATION_FIXTURES, FIXTURE_A, evaluationOptionsFor } from '../src/sim/evaluation-fixtures.js';
import { EVALUATION_GOLDEN_LOCKS } from '../src/sim/evaluation-locks.js';
import { RECORD_BYTES, compareCheckpoints, decodeTraceRecord } from '../src/sim/trace.js';
import { fnv1aHexOf } from '../src/sim/fnv1a.js';
import { createPhysics } from '../src/sim/physics/adapter.js';

const DIGEST_TRACE = { mode: 'digest', checkpointInterval: 1 };

// Lock-derived expected checkpoint sequence: interval 1 ⇒ stepIndex k at
// array index k (partial {stepIndex, state} entries — compareCheckpoints
// compares only fields present on both sides).
const lockCheckpoints = (lock) => lock.checkpointStates.map((state, i) => ({ stepIndex: i, state }));

function formatDivergence(fixtureName, div) {
  const hex = (c) => (c && c.state !== undefined ? (c.state >>> 0).toString(16).padStart(8, '0') : String(c));
  return `${fixtureName}: first divergent checkpoint index ${div.checkpointIndex} (${div.reason}); `
    + `last agreed step ${div.lastAgreedStepIndex}, first differing step ${div.firstDifferingStepIndex}; `
    + `expected state ${hex(div.expected)} actual ${hex(div.actual)}`;
}

describe('gate (a): same-process fresh-world byte-identity (deterministic flavor)', () => {
  for (const fx of EVALUATION_FIXTURES) {
    test(`${fx.name}: two fresh worlds agree on digest, every checkpoint, counts, and metrics`, { timeout: 240000 }, async () => {
      const run = () => runEvaluation(evaluationOptionsFor(fx, { deterministic: true, trace: DIGEST_TRACE }));
      const a = await run();
      const b = await run();
      // Diagnostic order (counts → checkpoints → digest): checkpoint
      // localization must run BEFORE the digest assertion so a real
      // divergence prints its first differing step, not a bare digest
      // mismatch. The digest is the final checkpoint state, so the digest
      // assertion is the backstop, not the primary signal.
      expect(b.trace.recordCount).toBe(a.trace.recordCount);
      expect(b.trace.byteCount).toBe(a.trace.byteCount);
      expect(b.executedSteps).toBe(a.executedSteps);
      const div = compareCheckpoints(a.trace.checkpoints, b.trace.checkpoints);
      expect(div === null ? null : formatDivergence(fx.name, div)).toBeNull();
      expect(b.trace.digest).toBe(a.trace.digest);
      // Bitwise-identical physics must produce identical readback metrics too.
      expect(b.vehicles.map((v) => v.forwardDistance)).toEqual(a.vehicles.map((v) => v.forwardDistance));
      expect(b.vehicles.map((v) => v.maxForwardDistance)).toEqual(a.vehicles.map((v) => v.maxForwardDistance));
      expect(b.vehicles.map((v) => v.stepAtMaxForwardDistance)).toEqual(a.vehicles.map((v) => v.stepAtMaxForwardDistance));
      expect(b.vehicles.map((v) => v.maxBackwardDistance)).toEqual(a.vehicles.map((v) => v.maxBackwardDistance));
      expect(b.vehicles.map((v) => v.finalPose)).toEqual(a.vehicles.map((v) => v.finalPose));
      expect(b.vehicles.map((v) => v.finalVelocity)).toEqual(a.vehicles.map((v) => v.finalVelocity));
      expect(b.counts).toEqual(a.counts);
    });
  }
});

describe('gate (c): default flavor', () => {
  test('same-process repeatability only — the digest is per-process/per-platform and is NEVER locked (F10)', { timeout: 120000 }, async () => {
    const run = () => runEvaluation(evaluationOptionsFor(FIXTURE_A, { deterministic: false, trace: DIGEST_TRACE }));
    const a = await run();
    const b = await run();
    // Diagnostic order: checkpoints before the digest backstop.
    const div = compareCheckpoints(a.trace.checkpoints, b.trace.checkpoints);
    expect(div === null ? null : formatDivergence(FIXTURE_A.name, div)).toBeNull();
    expect(b.trace.digest).toBe(a.trace.digest);
    // Deliberately NOT compared against EVALUATION_GOLDEN_LOCKS: the default
    // package may legitimately differ across platforms/architectures.
  });
});

describe('gate (d): golden locks (deterministic flavor)', () => {
  test('lock staleness teeth: versions, record size, step counts, engine version', async () => {
    expect(Object.keys(EVALUATION_GOLDEN_LOCKS).sort())
      .toEqual(EVALUATION_FIXTURES.map((f) => f.name).sort());
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    const engineVersion = RAPIER.version();
    world.free();
    for (const fx of EVALUATION_FIXTURES) {
      const lock = EVALUATION_GOLDEN_LOCKS[fx.name];
      expect(lock.traceVersion, `${fx.name}: trace schema changed — re-lock deliberately`).toBe(EVALUATION_TRACE_VERSION);
      expect(lock.fixtureVersion, `${fx.name}: fixture changed — re-lock deliberately`).toBe(fx.version);
      expect(lock.recordBytes, fx.name).toBe(RECORD_BYTES);
      expect(lock.rapierVersion, `${fx.name}: engine changed — re-lock deliberately`).toBe(engineVersion);
      expect(lock.executedSteps, fx.name).toBe(fx.maxSteps);
      expect(lock.captureCount, fx.name).toBe(fx.maxSteps + 1);
      expect(lock.checkpointCount, fx.name).toBe(lock.captureCount);
      expect(lock.checkpointStates, fx.name).toHaveLength(lock.checkpointCount);
      expect(lock.effectiveDt, fx.name).toBe(Math.fround(1 / 60));
      // Internal consistency: the final checkpoint state IS the digest.
      expect(fnv1aHexOf(lock.checkpointStates[lock.checkpointStates.length - 1]), fx.name).toBe(lock.digest);
    }
  });

  for (const fx of EVALUATION_FIXTURES) {
    test(`${fx.name}: run matches the committed lock (digest, counts, every checkpoint state)`, { timeout: 240000 }, async () => {
      const lock = EVALUATION_GOLDEN_LOCKS[fx.name];
      const r = await runEvaluation(evaluationOptionsFor(fx, { deterministic: true, trace: DIGEST_TRACE }));
      if (lock.digest === null) {
        // The re-lock workflow: paste this record into evaluation-locks.js.
        const measured = {
          fixtureVersion: fx.version,
          traceVersion: EVALUATION_TRACE_VERSION,
          recordBytes: RECORD_BYTES,
          rapierVersion: lock.rapierVersion,
          effectiveDt: r.effectiveDt,
          executedSteps: r.executedSteps,
          captureCount: r.executedSteps + 1,
          checkpointCount: r.trace.checkpoints.length,
          recordCount: r.trace.recordCount,
          byteCount: r.trace.byteCount,
          digest: r.trace.digest,
          checkpointStates: r.trace.checkpoints.map((c) => c.state),
        };
        expect.fail(`RE-LOCK ${fx.name} — measured lock record (paste into src/sim/evaluation-locks.js):\n${JSON.stringify(measured)}`);
      }
      expect(r.trace.recordCount, fx.name).toBe(lock.recordCount);
      expect(r.trace.byteCount, fx.name).toBe(lock.byteCount);
      const div = compareCheckpoints(lockCheckpoints(lock), r.trace.checkpoints);
      expect(div === null ? null : formatDivergence(fx.name, div)).toBeNull();
      expect(r.trace.digest, fx.name).toBe(lock.digest);
    });
  }
});

describe('determinism-adjacent teeth (deterministic flavor)', () => {
  test('profiler neutrality: profilerEnabled does not change the trace digest', { timeout: 120000 }, async () => {
    const digest = async (profile) => (await runEvaluation(
      evaluationOptionsFor(FIXTURE_A, { deterministic: true, trace: DIGEST_TRACE, profile }),
    )).trace.digest;
    expect(await digest(true)).toBe(await digest(false));
    // Semantic non-interference only — profiler COST is measured separately
    // by scripts/bench-physics.js, never inferred from digest equality.
  });

  test('capture-mode invariance: full produces the identical digest and counts as digest mode', { timeout: 120000 }, async () => {
    const d = await runEvaluation(evaluationOptionsFor(FIXTURE_A, { deterministic: true, trace: DIGEST_TRACE }));
    const f = await runEvaluation(evaluationOptionsFor(FIXTURE_A, { deterministic: true, trace: { mode: 'full', checkpointInterval: 1 } }));
    expect(f.trace.digest).toBe(d.trace.digest);
    expect(f.trace.recordCount).toBe(d.trace.recordCount);
    expect(f.trace.byteCount).toBe(d.trace.byteCount);
    expect(f.trace.records).toHaveLength(f.trace.recordCount);
    expect(d.trace.records).toBeNull();
  });

  test('the f32-backedness one-shot: every traced physical float of fixture A satisfies Math.fround(v) === v', { timeout: 120000 }, async () => {
    // Evidence about the ENGINE, not part of the trace encoding: the trace
    // stays lossless f64 regardless (pre-ruled). Measured 2026-07-11: holds
    // for all 39,065 floats. If this ever fails: keep f64, list the violating
    // fields in this header, do NOT quantize the trace to hide it.
    const r = await runEvaluation(evaluationOptionsFor(FIXTURE_A, { deterministic: true, trace: { mode: 'full' } }));
    const violations = new Map();
    let checked = 0;
    for (const bytes of r.trace.records) {
      const rec = decodeTraceRecord(bytes);
      for (const [group, keys] of [['translation', 'xyz'], ['rotation', 'xyzw'], ['linvel', 'xyz'], ['angvel', 'xyz']]) {
        for (const k of keys) {
          const v = rec[group][k];
          checked += 1;
          if (Math.fround(v) !== v) violations.set(`${group}.${k}`, (violations.get(`${group}.${k}`) ?? 0) + 1);
        }
      }
    }
    expect(checked).toBe(r.trace.recordCount * 13);
    expect(Object.fromEntries(violations)).toEqual({});
  });

  test('ghost isolation: vehicle 0 traces bit-equal, solo vs sharing the world with an identical ghost', { timeout: 120000 }, async () => {
    // The worker-sharding equivalence witness (probe-then-lock; measured
    // delta exactly 0): adding a ghost vehicle to a world must not perturb an
    // existing vehicle's trajectory at the BIT level, in every field of every
    // record of every step.
    const solo = await runEvaluation(evaluationOptionsFor(FIXTURE_A, { deterministic: true, trace: { mode: 'full' } }));
    const dual = await runEvaluation(evaluationOptionsFor(FIXTURE_A, {
      deterministic: true, vehicleCount: 2, trace: { mode: 'full' },
    }));
    const captures = FIXTURE_A.maxSteps + 1;
    const perVehicle = 5; // fixture A bodies per vehicle
    expect(solo.trace.recordCount).toBe(captures * perVehicle);
    expect(dual.trace.recordCount).toBe(captures * perVehicle * 2);
    for (let k = 0; k < captures; k += 1) {
      for (let b = 0; b < perVehicle; b += 1) {
        const s = solo.trace.records[k * perVehicle + b];
        const d = dual.trace.records[k * perVehicle * 2 + b]; // vehicle 0 leads each capture batch
        let equal = s.byteLength === d.byteLength;
        for (let i = 0; equal && i < s.byteLength; i += 1) equal = s[i] === d[i];
        if (!equal) {
          expect.fail(`ghost isolation broke at capture ${k}, body ${b}: ${JSON.stringify(decodeTraceRecord(s))} vs ${JSON.stringify(decodeTraceRecord(d))}`);
        }
      }
    }
  });
});
