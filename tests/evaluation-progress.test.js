// Maximum-progress metrics contract (src/sim/evaluation.js: createProgressState
// + foldProgress + the captureStep wiring): maxForwardDistance /
// stepAtMaxForwardDistance / maxBackwardDistance are derived per-capture from
// the SAME chassis read that feeds the non-finite latch and the trace, so this
// file verifies them INDEPENDENTLY against decoded full-trace bytes — a
// test-local recompute over decodeTraceRecord output, never the helper against
// itself. The metrics are result fields only (they never enter trace bytes),
// so the golden A–D locks are untouched — proven by test:determinism staying
// green with zero re-locks on the commit that added them.
//
// WITNESS TERRAIN (declared): seed 20260724, startFlatLength 80 (pad
// x ∈ [−60, +20], exactly-zero elevation), startBlendLength 6, craters/
// features/zones off per knob. Both witnesses run far inside the pad.
//
// WITNESSES (both flavors):
//  - rollback: fixture-A-shape genotype launched at +6 m/s with REVERSE drive
//    (targetWheelSurfaceSpeed −5, a witnessed signed option) — it coasts
//    forward, the motors brake and reverse it: a guaranteed-by-kinematics
//    INTERIOR maximum with zero terrain dependence. This deliberately
//    supersedes the plan's coast-up-the-blend-grade witness: the grade's
//    sign beyond the blend is seed-dependent fBm, while a reverse-driven
//    launch cannot fail to produce final < max.
//  - reverse-only: same genotype, no launch, reverse drive. MEASURED FINDING
//    (this worktree, Windows, 2026-07-12, BOTH flavors identical): the spawn
//    settle produces ~9.11e-10 m of forward noise at capture 1, so a real
//    reverse-only vehicle's maximum is sub-nanometre POSITIVE, not exactly 0.
//    The exactly-0-at-step-0 semantic is proven at the pure fold level below;
//    the physics witness asserts the measured noise band (< 1e-6 m).
//
// MEASURED (this worktree, Windows, 2026-07-12, both flavors identical):
//  rollback: max 8.4197 m @ step 254, final 4.3854 m (margin 4.034 m),
//            maxBackward 0
//  reverse:  max 9.11e-10 m @ step 1, final −4.4544 m, maxBackward 4.4544 m
//  sled:     max 2.04e-4 m @ step 3 (settle noise), final +6.5e-5 m
// Bands below carry generous cross-platform margin (default flavor is not
// byte-promised across platforms — F10); the EXACT teeth are the same-run
// trace recomputes.

import { describe, test, expect } from 'vitest';
import { createProgressState, foldProgress, runEvaluation } from '../src/sim/evaluation.js';
import { compileAssembly } from '../src/sim/assembly.js';
import { decodeTraceRecord } from '../src/sim/trace.js';
import { FIXTURE_A, evaluationOptionsFor } from '../src/sim/evaluation-fixtures.js';

const FLAVORS = [
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
];

const WITNESS_TERRAIN = Object.freeze({
  seed: 20260724,
  startFlatLength: 80,
  startBlendLength: 6,
  craterDensity: 0,
  featureDensity: 0,
  sandCoverage: 0,
  mudCoverage: 0,
});

// fixture-A-shape genotype — COPY-DECLARED (never imported from the fixture
// module; the copy-declare ruling), radius gene 0.6 -> r 0.5, 2 paired driven
// S0 axles.
function witnessGenotype() {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, node),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [axle(0.2), axle(0.8)],
  };
}

function sledGenotype() {
  const g = witnessGenotype();
  g.axles = [];
  return g;
}

// Test-local recompute over decoded trace bytes — the independent oracle.
// Walks every record, keeps the chassis records of one vehicle, and re-derives
// origin/max/argmax/backward with plain strict comparisons. Trace records are
// written in capture order (a TraceWriter write-time invariant), so the
// step-0 chassis record precedes every dx computation.
function recomputeProgressFromTrace(records, vehicleIndex) {
  let originX = null;
  let lastX = null;
  let max = 0;
  let stepAtMax = 0;
  let backward = 0;
  for (const bytes of records) {
    const rec = decodeTraceRecord(bytes);
    if (rec.vehicleIndex !== vehicleIndex || rec.bodyRole !== 'chassis') continue;
    if (originX === null) {
      if (rec.stepIndex !== 0) throw new Error(`first chassis record at step ${rec.stepIndex}, expected 0`);
      originX = rec.translation.x;
    }
    const dx = rec.translation.x - originX;
    if (dx > max) { max = dx; stepAtMax = rec.stepIndex; }
    if (-dx > backward) backward = -dx;
    lastX = rec.translation.x;
  }
  if (originX === null) throw new Error(`no chassis records for vehicle ${vehicleIndex}`);
  return { originX, lastX, max, stepAtMax, backward };
}

function assertMatchesTrace(result, vehicleIndex) {
  const v = result.vehicles[vehicleIndex];
  const t = recomputeProgressFromTrace(result.trace.records, vehicleIndex);
  // Exact (Object.is): the runner's fold and the trace recompute consumed the
  // same states, so any inequality means the fold read something the trace
  // did not (or vice versa).
  expect(Object.is(t.max, v.maxForwardDistance)).toBe(true);
  expect(Object.is(t.stepAtMax, v.stepAtMaxForwardDistance)).toBe(true);
  expect(Object.is(t.backward, v.maxBackwardDistance)).toBe(true);
  // Origin identity: the capture-0 chassis record IS the spawn reference.
  expect(Object.is(t.originX, v.origin.x)).toBe(true);
  // Cross-check the pre-existing metric from the same decoded bytes.
  expect(Object.is(t.lastX - t.originX, v.forwardDistance)).toBe(true);
  return { v, t };
}

// --- Pure fold contract (no physics) ----------------------------------------

describe('progress fold contract (pure)', () => {
  const feed = (samples) => {
    const s = createProgressState();
    samples.forEach((dx, i) => foldProgress(s, i, dx));
    return s;
  };

  test('strict > update: exact ties resolve to the EARLIEST step', () => {
    const s = feed([0, 1.5, 1.5, 0.7]);
    expect(s.maxForwardDistance).toBe(1.5);
    expect(s.stepAtMaxForwardDistance).toBe(1);
  });

  test('capture-0 baseline: a reverse-only sequence scores exactly 0 at step 0', () => {
    const s = feed([0, -0.5, -2, -1]);
    expect(Object.is(s.maxForwardDistance, 0)).toBe(true);
    expect(s.stepAtMaxForwardDistance).toBe(0);
    expect(s.maxBackwardDistance).toBe(2);
  });

  test('all-zero sequence: max 0 at step 0, backward exactly +0 (never -0)', () => {
    const s = feed([0, 0, 0]);
    expect(Object.is(s.maxForwardDistance, 0)).toBe(true);
    expect(s.stepAtMaxForwardDistance).toBe(0);
    // -dx of dx=0 is -0; the > 0 gate must keep the accumulator at +0.
    expect(Object.is(s.maxBackwardDistance, 0)).toBe(true);
  });

  test('negative-zero sample never flips the backward accumulator to -0', () => {
    const s = feed([0, -0]);
    expect(Object.is(s.maxBackwardDistance, 0)).toBe(true);
  });

  test('non-finite samples are skipped, never poison the fold', () => {
    const s = feed([0, 5, NaN, Infinity, -Infinity, 3, -2]);
    expect(s.maxForwardDistance).toBe(5);
    expect(s.stepAtMaxForwardDistance).toBe(1);
    expect(s.maxBackwardDistance).toBe(2);
  });

  test('fold returns its state (chainable) and later smaller samples never move the max', () => {
    const s = createProgressState();
    expect(foldProgress(s, 0, 0)).toBe(s);
    foldProgress(s, 1, 4);
    foldProgress(s, 2, 3.9999999999);
    expect(s.maxForwardDistance).toBe(4);
    expect(s.stepAtMaxForwardDistance).toBe(1);
  });
});

// --- Integration: independent trace verification (both flavors) -------------

describe.each(FLAVORS)('max-progress vs decoded trace (deterministic=%s, %s)', (deterministic) => {
  test('fixture A: metrics recomputed EXACTLY from the full trace', { timeout: 120000 }, async () => {
    const r = await runEvaluation(evaluationOptionsFor(FIXTURE_A, {
      deterministic, trace: { mode: 'full' },
    }));
    const { v } = assertMatchesTrace(r, 0);
    // A forward-driving vehicle's maximum dominates max(0, final).
    expect(v.maxForwardDistance).toBeGreaterThanOrEqual(Math.max(0, v.forwardDistance));
    expect(v.finite).toBe(true);
  });

  test('rollback witness: forward launch + reverse drive -> interior maximum, final < max', { timeout: 120000 }, async () => {
    const r = await runEvaluation({
      deterministic,
      terrain: { ...WITNESS_TERRAIN },
      vehicles: [{
        ir: compileAssembly(witnessGenotype()),
        spawn: { position: { x: -30, y: 0.52, z: 0 }, linvel: { x: 6, y: 0, z: 0 } },
        targetWheelSurfaceSpeed: -5,
      }],
      maxSteps: 480,
      trace: { mode: 'full' },
    });
    const { v } = assertMatchesTrace(r, 0);
    expect(v.finite).toBe(true);
    // The non-vacuous claim: final displacement sits WELL BELOW the maximum
    // (measured margin 4.034 m; band 2 m), and the maximum is interior —
    // attained strictly between the first and last capture.
    expect(v.maxForwardDistance - v.forwardDistance).toBeGreaterThan(2);
    expect(v.stepAtMaxForwardDistance).toBeGreaterThan(0);
    expect(v.stepAtMaxForwardDistance).toBeLessThan(480);
    // Magnitude band (measured 8.4197, generous cross-platform margin).
    expect(v.maxForwardDistance).toBeGreaterThan(5);
    expect(v.maxForwardDistance).toBeLessThan(12);
  });

  test('reverse-only witness: maximum is spawn-settle noise, final strongly negative', { timeout: 120000 }, async () => {
    const r = await runEvaluation({
      deterministic,
      terrain: { ...WITNESS_TERRAIN },
      vehicles: [{
        ir: compileAssembly(witnessGenotype()),
        spawn: { position: { x: 0, y: 0.52, z: 0 } },
        targetWheelSurfaceSpeed: -5,
      }],
      maxSteps: 240,
      trace: { mode: 'full' },
    });
    const { v } = assertMatchesTrace(r, 0);
    expect(v.finite).toBe(true);
    // MEASURED FINDING: not exactly 0 — the 0.02 m spawn settle leaves
    // ~9.11e-10 m of forward noise at capture 1. The exactly-0 semantic is a
    // pure-fold property (above); physics adds sub-nanometre jitter. This is
    // the honest band, NOT a weakened exact assertion: the exact value is
    // still pinned by the trace recompute in assertMatchesTrace.
    expect(v.maxForwardDistance).toBeGreaterThanOrEqual(0);
    expect(v.maxForwardDistance).toBeLessThan(1e-6);
    expect(v.forwardDistance).toBeLessThan(-2);
    expect(v.maxBackwardDistance).toBeGreaterThan(2);
  });

  test('zero-axle sled: fields well-formed and exact vs trace', { timeout: 120000 }, async () => {
    const r = await runEvaluation({
      deterministic,
      terrain: { ...WITNESS_TERRAIN },
      vehicles: [{
        ir: compileAssembly(sledGenotype()),
        spawn: { position: { x: -30, y: 0.32, z: 0 } },
      }],
      maxSteps: 120,
      trace: { mode: 'full' },
    });
    const { v } = assertMatchesTrace(r, 0);
    expect(v.finite).toBe(true);
    expect(v.maxForwardDistance).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(v.stepAtMaxForwardDistance)).toBe(true);
    expect(v.stepAtMaxForwardDistance).toBeGreaterThanOrEqual(0);
    expect(v.stepAtMaxForwardDistance).toBeLessThanOrEqual(120);
    expect(v.maxBackwardDistance).toBeGreaterThanOrEqual(0);
  });

  test('two-vehicle run: each vehicle folds against ITS OWN origin and trace slice', { timeout: 120000 }, async () => {
    const r = await runEvaluation({
      deterministic,
      terrain: { ...WITNESS_TERRAIN },
      vehicles: [
        { // forward-driven
          ir: compileAssembly(witnessGenotype()),
          spawn: { position: { x: -30, y: 0.52, z: 0 } },
          targetWheelSurfaceSpeed: 5,
        },
        { // reverse-driven ghost at the same spawn
          ir: compileAssembly(witnessGenotype()),
          spawn: { position: { x: -30, y: 0.52, z: 0 } },
          targetWheelSurfaceSpeed: -5,
        },
      ],
      maxSteps: 240,
      trace: { mode: 'full' },
    });
    const a = assertMatchesTrace(r, 0).v;
    const b = assertMatchesTrace(r, 1).v;
    expect(a.forwardDistance).toBeGreaterThan(2);
    expect(b.forwardDistance).toBeLessThan(-2);
    expect(b.maxForwardDistance).toBeLessThan(1e-6);
  });
});
