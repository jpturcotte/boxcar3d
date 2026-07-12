// The Chromium cross-environment determinism gate: the SAME production
// runner, fixtures, trace encoder, hash, and committed golden locks the Node
// suite uses (src/sim/evaluation.js, evaluation-fixtures.js,
// evaluation-locks.js — Vite serves the identical modules), executed in
// Chromium via vitest browser mode + the exact-pinned playwright provider.
// There is NO second simulation loop here — this file is imports plus
// assertions.
//
// Fixtures A, B, AND C run: B is the only fixture with the composite
// defaults on, so the gate transitively proves the integer-noise field,
// crater baking, zone quantiles, feature generation, AND the
// addCorridorWithFeatures statics-step + castRay feature-seating path
// produce bit-identical physics in Chromium — plus both ordinary (A) and
// maximum 25-body/24-joint (C) joint islands under the deterministic flavor.
// It does NOT claim anything about rendering or unrelated browser APIs.
//
// Assertion order is diagnostic order: counts first (the coarsest signal),
// then the committed per-step checkpoint states (the first unequal state
// identifies the first divergent step against the golden Node lock — this is
// why the states are committed), then the final digest.
//
// Excluded from `npm test` by vite.config.js; run via `npm run test:browser`
// (one-time local setup: npx playwright install chromium). No profiler, no
// timing reads, no screenshots — browser wall-clock never touches a digest.

import { describe, test, expect } from 'vitest';
import { runEvaluation } from '../../src/sim/evaluation.js';
import { EVALUATION_FIXTURES, evaluationOptionsFor } from '../../src/sim/evaluation-fixtures.js';
import { EVALUATION_GOLDEN_LOCKS } from '../../src/sim/evaluation-locks.js';
import { compareCheckpoints } from '../../src/sim/trace.js';

// Report the actual browser once, pass or fail (vitest forwards browser
// console output to the terminal, so this lands in CI logs).
console.log(`[browser-gate] ${navigator.userAgent}`);

describe('Chromium reproduces the committed deterministic-flavor locks', () => {
  for (const fx of EVALUATION_FIXTURES) {
    test(`${fx.name}: digest, counts, and every checkpoint state match the golden lock`, async () => {
      const lock = EVALUATION_GOLDEN_LOCKS[fx.name];
      expect(lock.digest, `${fx.name}: lock is null — re-lock in Node first`).not.toBeNull();
      const r = await runEvaluation(evaluationOptionsFor(fx, {
        deterministic: true,
        trace: { mode: 'digest', checkpointInterval: 1 },
      }));
      const env = navigator.userAgent;
      expect(r.trace.recordCount, `${fx.name} [${env}]`).toBe(lock.recordCount);
      expect(r.trace.byteCount, `${fx.name} [${env}]`).toBe(lock.byteCount);
      expect(r.trace.checkpoints.length, `${fx.name} [${env}]`).toBe(lock.checkpointCount);
      const expected = lock.checkpointStates.map((state, i) => ({ stepIndex: i, state }));
      const div = compareCheckpoints(expected, r.trace.checkpoints);
      if (div !== null) {
        const hex = (c) => (c && c.state !== undefined ? (c.state >>> 0).toString(16).padStart(8, '0') : String(c));
        expect.fail(`${fx.name} [${env}]: first divergent checkpoint ${div.checkpointIndex} (${div.reason}); `
          + `last agreed step ${div.lastAgreedStepIndex}, first differing step ${div.firstDifferingStepIndex}; `
          + `expected state ${hex(div.expected)} actual ${hex(div.actual)} — `
          + 'rerun this fixture in Node full-capture mode around that step to identify the body and field');
      }
      expect(r.trace.digest, `${fx.name} [${env}] expected ${lock.digest} actual ${r.trace.digest}`).toBe(lock.digest);
      expect(r.effectiveDt, `${fx.name} [${env}]`).toBe(lock.effectiveDt);
    });
  }
});
