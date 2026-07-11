// The fresh-module gate (mission §11.2): fixture A against the committed
// golden lock, from a SECOND test file.
//
// What this proves — stated narrowly and precisely: FRESH VITEST FILE
// ISOLATION — a fresh module graph and a fresh Rapier world under the
// measured Vitest pool configuration (vitest 3.2.7, this repo's default
// `forks` pool with `isolate: true`: each test file gets its own module
// registry, so this file's dynamic import + RAPIER.init() of the
// deterministic flavor is re-executed rather than shared with
// tests/evaluation-determinism.test.js).
//
// What this does NOT claim: a fresh operating-system process (tinypool may
// recycle worker processes between files — PID evidence was not asserted),
// nor a fresh wasm INSTANTIATION (a PID plus a module nonce cannot establish
// wasm-instance identity without directly instrumenting the package's wasm
// instance). The gate's value is concrete either way: one initialized test
// module cannot carry mutable state into or out of the principal
// repeatability runs — the digest must reproduce from a cold module graph.

import { describe, test, expect } from 'vitest';
import { runEvaluation } from '../src/sim/evaluation.js';
import { FIXTURE_A, evaluationOptionsFor } from '../src/sim/evaluation-fixtures.js';
import { EVALUATION_GOLDEN_LOCKS } from '../src/sim/evaluation-locks.js';
import { compareCheckpoints } from '../src/sim/trace.js';
import { fnv1aHexOf } from '../src/sim/fnv1a.js';

describe('gate (b): fresh-module reproduction of the golden lock', () => {
  test('fixture A reproduces the committed digest and every checkpoint state from a cold module graph', { timeout: 240000 }, async () => {
    const lock = EVALUATION_GOLDEN_LOCKS[FIXTURE_A.name];
    expect(lock.digest).not.toBeNull(); // re-lock in evaluation-determinism.test.js first
    // Internal consistency: the final checkpoint state IS the digest.
    expect(fnv1aHexOf(lock.checkpointStates[lock.checkpointStates.length - 1])).toBe(lock.digest);
    const r = await runEvaluation(evaluationOptionsFor(FIXTURE_A, {
      deterministic: true, trace: { mode: 'digest', checkpointInterval: 1 },
    }));
    expect(r.trace.recordCount).toBe(lock.recordCount);
    expect(r.trace.byteCount).toBe(lock.byteCount);
    const expected = lock.checkpointStates.map((state, i) => ({ stepIndex: i, state }));
    const div = compareCheckpoints(expected, r.trace.checkpoints);
    expect(div === null ? null : `first divergent checkpoint ${div.checkpointIndex} (${div.reason}) at step ${div.firstDifferingStepIndex}`).toBeNull();
    expect(r.trace.digest).toBe(lock.digest);
    expect(r.effectiveDt).toBe(lock.effectiveDt);
  });
});
