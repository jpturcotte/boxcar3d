// The per-wheel surface-speed BEHAVIORAL witnesses — the proof that the
// phantom common driveshaft is gone from the SHIPPED realizer path: a
// mixed-radius vehicle's wheels each approach their OWN ω_i = −speed/r_i
// (airborne), and the same vehicle that fights itself under the exact old
// shared-ω law drives cleanly under the per-wheel law (grounded, identical
// twins). BOTH flavors via describe.each × createPhysics; exactness only
// ever per flavor (F10).
//
// WITNESS TERRAIN (declared; touches NO locked fingerprint): seed 20260720,
// the s0-drive flat-pad recipe — { startFlatLength: 80, startBlendLength: 6,
// craterDensity: 0, featureDensity: 0, sandCoverage: 0, mudCoverage: 0 }.
// Pad x ∈ [−60, +20] at exactly-zero elevation; every measured run must stay
// inside it (trajectory guard, the s0-drive discipline).
//
// WITNESS FIXTURE (declared, repair-stable, verified against the compiler):
// paired S0 axles with GENUINELY MIXED radii — radius genes 0.2 / 0.8 emit
// r 0.3 / 0.6 m EXACTLY; node height 0.1 (R2 clearance), wheel density 0.1
// (mass band: 17.81 / 71.25 kg), power 1 ⇒ driveTorque 125 N·m per wheel
// (the budget split is untouched by the drive law), total 226.35 kg, stall
// thrust/weight ≈ 0.28 at gravity 20. Per-wheel targets at the default
// 5 m/s: ω = −16.667 / −8.333 rad/s (gains 7.5 / 15). Under the OLD shared
// −10 rad/s target these axles wanted 3 vs 6 m/s surface speeds — the
// recorded S0-era mixed-radius conflict this file closes.
//
// THE OLD-LAW CONTROL (identical twin): realized normally, then every drive
// joint is re-configured through the same raw Rapier motor API with the
// EXACT legacy arithmetic — target −10, gain = driveTorque × (1/|−10|), the
// reciprocal-MULTIPLY shape the old adapter shipped (3/10 ≠ 3·(1/10) in
// f64: a divide would NOT be the old law bit-for-bit).
//
// MEASURED (this worktree, Windows, 2026-07-11, both flavors identical at
// this seed; bands carry cross-platform margin):
//   airborne (chassis held, 240 steps): r 0.3 wheels −16.6666 of −16.667
//     (100.0%), r 0.6 wheels −8.2550 of −8.3333 (99.06%); surface speeds
//     5.0000 / 4.9530; speed −5 mirrors every sign exactly. FINDING: with a
//     FREE chassis the assembly tumbles chaotically under the reaction
//     torque (chassis ω_z swings ±20 rad/s over 6000 steps and ω_rel
//     oscillates AROUND the per-wheel targets — small wheels hit −16.666 by
//     step 60, then the tumble sloshes them) — hence the rig hold.
//   grounded (600 steps): per-wheel law dx +37.72, vxEnd 4.237, wheels
//     −14.74/−14.61 (r 0.3, target −16.67) and −7.03/−7.03 (r 0.6, target
//     −8.33) — every wheel under ITS OWN no-load target; EXACT old law on
//     the identical twin: dx +30.21, vxEnd 3.319, small wheels −11.10/−11.01
//     (dragged PAST the shared −10 — motor braking) vs big wheels
//     −5.58/−5.53 (held far below — motor driving): opposing motor torques
//     at cruise, the fight signature; undriven twin dx −2.47, vxEnd −0.376
//     (the uneven wheel drop rocks it and the free-rolling island never
//     sleeps — the recorded solver-pump-class creep; maxSpeed 1.66 from the
//     drop). Max anchor error across all runs 0.0153 (125 N·m per wheel —
//     hotter joints than the 62.5 N·m s0-drive witness; band 0.03).
//   stability corner (equal r 0.3 at 7.5 m/s ⇒ ω −25, 420 steps): dx
//     +39.55, vxEnd 5.877, maxSpeed 6.49, wheels ≤ |−20.69| (below target),
//     contained. The throwaway preflight measured raw-rig stability to
//     ω −37.5 (both flavors).

import { describe, test, expect } from 'vitest';
import {
  addCorridor,
  createPhysics,
  driveMotorForWheel,
  realizeVehicle,
} from '../src/sim/physics/adapter.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { compileAssembly, repairGenotype } from '../src/sim/assembly.js';
import { rotateVector } from './rotate-oracle.js';

const WITNESS_SEED = 20260720; // declared; distinct from every other repo seed
const WITNESS_CONFIG = Object.freeze({
  seed: WITNESS_SEED,
  startFlatLength: 80,
  startBlendLength: 6,
  craterDensity: 0,
  featureDensity: 0,
  sandCoverage: 0,
  mudCoverage: 0,
});
const STEPS = 600;
const SPAWN_X = -45;
const ANCHOR_BAND = 0.03; // m — measured max 0.0153 (this witness runs 125
// N·m per wheel, hotter joints than the 62.5 N·m s0-drive family band 0.02)
const TUNNEL_Y = -50;
const PAD_MIN_X = -60;
const PAD_MAX_X = 20;
const PAD_MARGIN = 1.5;
const AIRBORNE_STEPS = 240; // ≈ 4.7 spin-up time constants for the SLOWEST
// wheel (r 0.6: I ≈ 12.8 kg·m², gain 15 ⇒ τ ≈ 51 steps) — measured 99.06%
// of target for the big wheels, 100.0% for the small, chassis held.
const LEGACY_TARGET = -10; // rad/s — the removed shared-ω law, for the control
const LEGACY_INV = 1 / Math.abs(LEGACY_TARGET);

const rotate = rotateVector;
const terrain = generateCorridorTerrain(WITNESS_CONFIG);

function mixedRadiusGenotype(patch = null) {
  const node = () => ({ gap: 0.5, height: 0.1, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01, radius, over = {}) => ({
    posX01, paired: 1, trackHalf: 0.5, radius, width: 0.5, density: 0.1,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 }, ...over,
  });
  const g = {
    version: 1, hue: 0.25, symmetric: 0.9, power: 1, frameDensity: 0.05,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, node),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [axle(0.2, 0.2), axle(0.8, 0.8)],
  };
  if (patch) patch(g, axle);
  return g;
}

// Realize `ir` in an EMPTY world (no colliders anywhere) and measure each
// wheel's spin RELATIVE to the chassis, projected on the chassis' CURRENT
// local +Z via the independent rotate-oracle. RIG HOLD (pre-step, test-rig
// configuration — the shipped per-wheel motor configuration under test is
// untouched): a FREE assembly tumbles chaotically under the reaction torque
// (see the header finding), so the chassis body is pinned after
// realization — the s0-motor benchWheel discipline applied to the SHIPPED
// motor config.
async function airborneRun(deterministic, ir, { speed } = {}) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    const opts = { position: { x: 0, y: 50, z: 0 } };
    if (speed !== undefined) opts.targetWheelSurfaceSpeed = speed;
    const rec = realizeVehicle(RAPIER, world, ir, opts);
    rec.chassis.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    for (let i = 0; i < AIRBORNE_STEPS; i++) world.step();
    const cr = rec.chassis.body.rotation();
    const axis = rotate(cr, { x: 0, y: 0, z: 1 });
    const ca = rec.chassis.body.angvel();
    return rec.wheels.map((st) => {
      const wa = st.wheel.body.angvel();
      return {
        radius: st.irWheel.radius,
        omegaRel: (wa.x - ca.x) * axis.x + (wa.y - ca.y) * axis.y + (wa.z - ca.z) * axis.z,
      };
    });
  } finally {
    world.free();
  }
}

// The pad harness (the s0-drive witnessRun discipline on realizeVehicle
// records): place on the pad, run a fixed step count, track anchors/lows/
// speed/trajectory, and read final per-wheel spin. `legacyOverride` arms the
// old-law control: BEFORE the first step, every driven joint is
// re-configured with the exact legacy shared-ω arithmetic.
async function padRun(deterministic, ir, { x = SPAWN_X, steps = STEPS, targetWheelSurfaceSpeed, legacyOverride = false } = {}) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    const { floor } = addCorridor(RAPIER, world, terrain);
    world.step(); // query BVH ([V1])
    const maxR = Math.max(...ir.axles.flatMap((a) => a.wheels).map((w) => w.radius));
    const opts = { position: { x, y: maxR + 0.02, z: 0 } };
    if (targetWheelSurfaceSpeed !== undefined) opts.targetWheelSurfaceSpeed = targetWheelSurfaceSpeed;
    const rec = realizeVehicle(RAPIER, world, ir, opts);
    if (legacyOverride) {
      for (const st of rec.wheels) {
        if (st.irWheel.driven && st.irWheel.driveTorque > 0) {
          // The EXACT old shipped law: reciprocal-multiply, never a divide.
          st.driveJoint.configureMotorVelocity(LEGACY_TARGET, st.irWheel.driveTorque * LEGACY_INV);
        }
      }
    }
    const x0 = rec.chassis.body.translation().x;
    let maxAnchorErr = 0;
    let minBodyY = Infinity;
    let maxSpeed = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    const samples = {};
    for (let i = 1; i <= steps; i++) {
      world.step();
      const cx = rec.chassis.body.translation().x;
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      if (i % 10 === 0) {
        const cp = rec.chassis.body.translation();
        const cr = rec.chassis.body.rotation();
        for (const st of rec.wheels) {
          const a = rotate(cr, st.driveJoint.anchor1());
          const wp = st.wheel.body.translation();
          maxAnchorErr = Math.max(
            maxAnchorErr,
            Math.sqrt((cp.x + a.x - wp.x) ** 2 + (cp.y + a.y - wp.y) ** 2 + (cp.z + a.z - wp.z) ** 2)
          );
          minBodyY = Math.min(minBodyY, wp.y);
        }
        minBodyY = Math.min(minBodyY, cp.y);
        const v = rec.chassis.body.linvel();
        maxSpeed = Math.max(maxSpeed, Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z));
      }
      if (i === 15) samples.vx15 = rec.chassis.body.linvel().x;
    }
    const p = rec.chassis.body.translation();
    const ray = new RAPIER.Ray({ x: p.x, y: 60, z: p.z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 200, true, undefined, undefined, undefined, undefined, (c) => c.handle === floor.handle);
    return {
      seed: WITNESS_SEED,
      finite: [p.x, p.y, p.z].every(Number.isFinite),
      dx: p.x - x0,
      z: p.z,
      vxEnd: rec.chassis.body.linvel().x,
      floorY: hit === null ? null : 60 - hit.timeOfImpact,
      maxAnchorErr,
      minBodyY,
      maxSpeed,
      minX,
      maxX,
      samples,
      wheels: rec.wheels.map((st) => ({
        radius: st.irWheel.radius,
        omegaZ: st.wheel.body.angvel().z,
      })),
    };
  } finally {
    world.free();
  }
}

// --- Fixture proofs (pure, flavor-independent) -------------------------------

test('the mixed-radius witness fixture is repair-stable and emits the declared phenotype', () => {
  const g = mixedRadiusGenotype();
  expect(repairGenotype(g)).toEqual(g);
  const ir = compileAssembly(g);
  // The declared facts the witness claims depend on: genuinely mixed radii
  // (0.3 / 0.6 exactly — the affine decode is exact at these genes) and an
  // untouched budget split (125 N·m per wheel from power 1 over 4 driven).
  expect(ir.axles.map((a) => a.wheels[0].radius)).toEqual([0.3, 0.6]);
  for (const w of ir.axles.flatMap((a) => a.wheels)) expect(w.driveTorque).toBe(125);
  // The per-wheel plans the realizer will derive at the default speed.
  expect(driveMotorForWheel(5, ir.axles[0].wheels[0]).omega).toBeCloseTo(-16.666666666666668, 12);
  expect(driveMotorForWheel(5, ir.axles[1].wheels[0]).omega).toBeCloseTo(-8.333333333333334, 12);
  // The stability-corner twin (equal r 0.3) is repair-stable too.
  const corner = mixedRadiusGenotype((gg, axle) => { gg.axles = [axle(0.2, 0.2), axle(0.8, 0.2)]; });
  expect(repairGenotype(corner)).toEqual(corner);
});

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('per-wheel surface-speed witnesses (deterministic=%s, %s)', (deterministic) => {
  test('airborne per-wheel spin through the shipped realizer: every wheel approaches ITS OWN ω = −speed/r; negation flips every sign', { timeout: 60000 }, async () => {
    const ir = compileAssembly(mixedRadiusGenotype());
    const fwd = await airborneRun(deterministic, ir); // default 5 m/s
    const rev = await airborneRun(deterministic, ir, { speed: -5 });
    const diag = JSON.stringify({ fwd, rev });

    for (const st of fwd) {
      const target = driveMotorForWheel(5, { radius: st.radius, driveTorque: 1 }).omega;
      // Each station near ITS OWN target (measured worst 0.94% off, the r
      // 0.6 wheels at 240 steps; band 3%) and spinning the forward sign.
      expect(st.omegaRel, diag).toBeLessThan(0);
      expect(Math.abs(st.omegaRel - target) / Math.abs(target), diag).toBeLessThan(0.03);
      // Every wheel agrees on the one no-load SURFACE speed (measured
      // 5.0000 / 4.9530; band 3%).
      expect(Math.abs(Math.abs(st.omegaRel * st.radius) - 5) / 5, diag).toBeLessThan(0.03);
    }
    // The phantom driveshaft is GONE: front (r 0.3) and rear (r 0.6) targets
    // differ 2×, and the measured spins follow (measured ratio 2.019).
    const front = fwd.filter((s) => s.radius === 0.3).map((s) => Math.abs(s.omegaRel));
    const rear = fwd.filter((s) => s.radius === 0.6).map((s) => Math.abs(s.omegaRel));
    expect(front, diag).toHaveLength(2);
    expect(rear, diag).toHaveLength(2);
    const ratio = Math.min(...front) / Math.max(...rear);
    expect(ratio, diag).toBeGreaterThan(1.9);
    expect(ratio, diag).toBeLessThan(2.15);
    // Negative speed flips every station's sign, magnitudes unchanged
    // (measured mirror exact to the printed digits; band 1%).
    rev.forEach((st, k) => {
      expect(st.omegaRel, diag).toBeGreaterThan(0);
      expect(Math.abs(st.omegaRel + fwd[k].omegaRel) / Math.abs(fwd[k].omegaRel), diag).toBeLessThan(0.01);
    });
  });

  test('grounded mixed-radius witness: the per-wheel law drives cleanly; the EXACT old shared-ω law fights itself on the identical twin', { timeout: 120000 }, async () => {
    const ir = compileAssembly(mixedRadiusGenotype());
    const undrivenIR = compileAssembly(mixedRadiusGenotype((g) => { for (const a of g.axles) a.driven = 0; }));
    const neu = await padRun(deterministic, ir); // the per-wheel law, defaults
    const control = await padRun(deterministic, ir, { legacyOverride: true }); // exact old law
    const undriven = await padRun(deterministic, undrivenIR);
    const diag = JSON.stringify({ neu, control, undriven });

    for (const run of [neu, control, undriven]) {
      expect(run.finite, diag).toBe(true);
      expect(run.floorY, diag).not.toBeNull();
      expect(run.minBodyY, diag).toBeGreaterThan(TUNNEL_Y);
      expect(run.maxAnchorErr, diag).toBeLessThan(ANCHOR_BAND);
      expect(run.maxSpeed, diag).toBeLessThan(10);
      expect(Math.abs(run.z), diag).toBeLessThan(1);
      expect(run.maxX, diag).toBeLessThan(PAD_MAX_X - PAD_MARGIN);
      expect(run.minX, diag).toBeGreaterThan(PAD_MIN_X + PAD_MARGIN);
    }
    // The per-wheel law makes meaningful positive progress with margin over
    // the undriven twin (measured dx +37.72 vs −2.47 — margin 40.2).
    expect(neu.dx, diag).toBeGreaterThan(20);
    // The undriven twin ROLLS a little: the uneven wheel drop (small wheels
    // hang 0.32 m above the pad at spawn) rocks it, and the free-rolling
    // island never sleeps — the recorded solver-pump-class creep (measured
    // dx −2.47, vxEnd −0.376; cf. the S0/S1 ≈0.33 m/s findings).
    expect(Math.abs(undriven.dx), diag).toBeLessThan(5);
    expect(neu.dx - undriven.dx, diag).toBeGreaterThan(25);
    // Under the per-wheel law NO wheel is dragged past its own no-load
    // target — every motor still drives (or idles), none fights the others
    // (measured 0.88× / 0.84× of target under cruise load; slack 5%).
    for (const w of neu.wheels) {
      const target = driveMotorForWheel(5, { radius: w.radius, driveTorque: 1 }).omega;
      expect(Math.abs(w.omegaZ), diag).toBeLessThan(Math.abs(target) * 1.05);
    }
    // THE CONFLICT, on the identical twin under the exact old law: the small
    // wheel is dragged PAST the shared −10 target (its motor BRAKES) while
    // the big wheel runs far BELOW it (its motor drives) — opposing motor
    // torques at cruise, the recorded fight signature (measured −11.10/
    // −11.01 vs −5.58/−5.53; bands 10.3 and 7.0).
    const ctlSmall = control.wheels.filter((w) => w.radius === 0.3);
    const ctlBig = control.wheels.filter((w) => w.radius === 0.6);
    for (const w of ctlSmall) expect(Math.abs(w.omegaZ), diag).toBeGreaterThan(10.3);
    for (const w of ctlBig) expect(Math.abs(w.omegaZ), diag).toBeLessThan(7.0);
    // And it exhibits the conflict MORE STRONGLY than the per-wheel law:
    // less progress, lower final speed (measured ratios 0.801 and 0.783;
    // relational margin 0.9).
    expect(control.dx, diag).toBeLessThan(0.9 * neu.dx);
    expect(control.vxEnd, diag).toBeLessThan(0.9 * neu.vxEnd);
  });

  test('small-radius/high-surface-speed stability corner: ω = −25 rad/s grounded stays finite, contained, and drives', { timeout: 60000 }, async () => {
    // Equal r 0.3 twin at 7.5 m/s ⇒ per-wheel ω = −25 rad/s — the opened
    // high-spin operating range, held by a permanent tooth (the throwaway
    // preflight measured stability to ω −37.5 on the raw rig).
    const ir = compileAssembly(mixedRadiusGenotype((g, axle) => { g.axles = [axle(0.2, 0.2), axle(0.8, 0.2)]; }));
    const run = await padRun(deterministic, ir, { steps: 420, targetWheelSurfaceSpeed: 7.5 });
    const diag = JSON.stringify(run);
    expect(run.finite, diag).toBe(true);
    expect(run.floorY, diag).not.toBeNull();
    expect(run.minBodyY, diag).toBeGreaterThan(TUNNEL_Y);
    expect(run.maxAnchorErr, diag).toBeLessThan(ANCHOR_BAND);
    expect(run.maxX, diag).toBeLessThan(PAD_MAX_X - PAD_MARGIN);
    expect(run.minX, diag).toBeGreaterThan(PAD_MIN_X + PAD_MARGIN);
    expect(run.dx, diag).toBeGreaterThan(20); // measured +39.55 over 420 steps
    expect(run.maxSpeed, diag).toBeLessThan(10); // measured 6.49
    for (const w of run.wheels) {
      expect(Math.abs(w.omegaZ), diag).toBeLessThan(25 * 1.05); // at/below the no-load target (measured max 20.69)
    }
  });
});
