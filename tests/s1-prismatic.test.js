// Raw prismatic API + the S1 spring-model ruling, at the raw Rapier level —
// no production S1 helpers involved (they land with the adapter commit; this
// file is the engine-behavior ground truth they are tested against later).
//
// What this file locks (measured on BOTH flavors, 2026-07-11, byte-identical
// across flavors on every row — F10: exactness is only ever asserted per
// flavor):
//   1. The full S1 API surface exists and MotorModel resolves symbolically.
//   2. The prismatic coordinate contract: body placement sets the initial
//      coordinate (a hub spawned distance d along the axis from anchor
//      coincidence starts at coordinate d), the position-motor target is an
//      ABSOLUTE coordinate, limits clamp both ends, setLimits(0,0) is
//      engine-safe, and a target beyond the extension limit (preload) sits
//      pinned at the stop as a valid static state.
//   3. Spring honesty ([V12]): under ForceBased the static coordinate is
//      target ± m·g/k EXACTLY on the isolated rig (extension side 0.20500 at
//      5 kg / 0.25000 at 50 kg with k 20000; compression side 0.18000 at
//      20 kg) — stiffness is an honest N/m. AccelerationBased settles BOTH
//      masses at 0.20100 (mass-blind: its "stiffness" is not a spring rate)
//      and is REJECTED. Damping changes decay, not equilibrium.
//   4. Vehicle-local covariance: the suspension axis is interpreted in the
//      body's local frame; at pitch-30 / roll-180 the settled hub lands on
//      the covariant prediction (≤ 1e-6 m measured) while a world-vertical
//      placement would miss by 0.130 / 0.496 m. At roll-180 the hub sits
//      ABOVE the anchor — extension reverses with the vehicle by design.
//   5. The measured engine finding that forces the collider-carrying hub:
//      colliderless additional-mass bodies are dynamics-honest but read
//      mass() = 0 and invPrincipalInertia() = 0 until the FIRST world.step()
//      (both the desc API and the runtime setter), so the mandated
//      creation-time mass cross-check is impossible without a collider.
//
// Tolerance discipline: pose readbacks are f32 at magnitude ~5 (the rig
// base), so coordinate bands here are ≥ 1e-5; solver-settled coordinates get
// measured-then-banded windows (measured values in inline comments).
import { describe, test, expect } from 'vitest';
import { createPhysics, GRAVITY } from '../src/sim/physics/adapter.js';
import { rotateVector } from './rotate-oracle.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const SQ = Math.sqrt(0.5);
const YAW_90 = { x: 0, y: SQ, z: 0, w: SQ };
// pitch 30° about lateral +Z / roll 180° about longitudinal +X — half-angle
// numeric literals (the repo's trig-free quaternion convention).
const PITCH_30 = { x: 0, y: 0, z: 0.25881904510252074, w: 0.9659258262890683 };
const ROLL_180 = { x: 1, y: 0, z: 0, w: 0 };
// The candidate vehicle-local suspension axis: chassis-local DOWN. The
// production constant (SUSPENSION_AXIS) must match this measured contract.
const AXIS_DOWN = { x: 0, y: -1, z: 0 };
const AXIS_UP = { x: 0, y: 1, z: 0 };
const BASE = { x: 0, y: 5, z: 0 };
const ANCHOR = { x: 0.5, y: 0, z: 0.3 };

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (v, s) => ({ x: v.x * s, y: v.y * s, z: v.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (v) => Math.sqrt(dot(v, v));

// Projected prismatic coordinate via the independent rotation oracle (the
// engine exposes NO coordinate readback — verified against both flavors'
// typings; this projection is the only source).
function coordOf(chassisBody, hubBody, anchor1, axis) {
  const a1w = add(chassisBody.translation(), rotateVector(chassisBody.rotation(), anchor1));
  return dot(sub(hubBody.translation(), a1w), rotateVector(chassisBody.rotation(), axis));
}

// Isolated rig: fixed chassis at BASE (rotation `rot`), colliderless hub of
// mass m hanging on one prismatic along the vehicle-local axis. Colliderless
// hubs are fine HERE (dynamics honor the mass; only readback is step-lazy).
async function runRig(deterministic, {
  rot = IDENTITY, axis = AXIS_DOWN, d = 0.2, limits = [0, 0.4],
  target = null, k = 20000, c = 500, m = 5, model = 'ForceBased', steps = 600,
} = {}) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(BASE.x, BASE.y, BASE.z).setRotation(rot)
    );
    const hubLocal = add(ANCHOR, scale(axis, d));
    const hw = add(BASE, rotateVector(rot, hubLocal));
    const hub = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(hw.x, hw.y, hw.z).setRotation(rot)
        .setAdditionalMassProperties(m, { x: 0, y: 0, z: 0 }, { x: 0.02 * m, y: 0.02 * m, z: 0.01 * m }, IDENTITY)
    );
    const joint = world.createImpulseJoint(
      RAPIER.JointData.prismatic(ANCHOR, { x: 0, y: 0, z: 0 }, axis), chassis, hub, true
    );
    if (limits) joint.setLimits(limits[0], limits[1]);
    if (target !== null) {
      joint.configureMotorModel(RAPIER.MotorModel[model]);
      joint.configureMotorPosition(target, k, c);
    }
    const coord0 = coordOf(chassis, hub, ANCHOR, axis);
    let trough = Infinity;
    let peak = -Infinity;
    for (let i = 0; i < steps; i++) {
      world.step();
      const q = coordOf(chassis, hub, ANCHOR, axis);
      if (q < trough) trough = q;
      if (q > peak) peak = q;
    }
    const hp = hub.translation();
    const hv = hub.linvel();
    return {
      coord0,
      coord: coordOf(chassis, hub, ANCHOR, axis),
      trough,
      peak,
      hubWorld: { x: hp.x, y: hp.y, z: hp.z },
      hubSpeed: norm({ x: hv.x, y: hv.y, z: hv.z }),
      limitsRead: [joint.limitsMin(), joint.limitsMax(), joint.limitsEnabled()],
      finite: [hp.x, hp.y, hp.z].every(Number.isFinite),
    };
  } finally {
    world.free();
  }
}

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('S1 raw prismatic + spring model (deterministic=%s, %s)', (deterministic) => {
  test('required API surface exists; MotorModel resolves symbolically', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      expect(typeof RAPIER.JointData.prismatic).toBe('function');
      const proto = RAPIER.PrismaticImpulseJoint.prototype;
      for (const method of ['setLimits', 'configureMotorModel', 'configureMotorPosition', 'configureMotorVelocity', 'limitsMin', 'limitsMax', 'limitsEnabled', 'anchor1', 'anchor2']) {
        expect(typeof proto[method], `PrismaticImpulseJoint.prototype.${method}`).toBe('function');
      }
      // Resolved by NAME off the injected object — never a hard-coded number.
      expect(typeof RAPIER.MotorModel.ForceBased).toBe('number');
      expect(typeof RAPIER.MotorModel.AccelerationBased).toBe('number');
      expect(RAPIER.MotorModel.ForceBased).not.toBe(RAPIER.MotorModel.AccelerationBased);
    } finally {
      world.free();
    }
  });

  test('colliderless mass props are dynamics-honest but read back ZERO until the first step — the finding that forces the collider-carrying hub', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const props = [5, { x: 0, y: 0, z: 0 }, { x: 0.02, y: 0.02, z: 0.01 }, IDENTITY];
      const descBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 50, 0).setAdditionalMassProperties(...props)
      );
      const runtimeBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(3, 50, 0));
      runtimeBody.setAdditionalMassProperties(...props, true);
      // Pre-step: BOTH APIs read zero (measured; the dynamics nevertheless
      // honor the mass — the spring-honesty tests below prove it).
      expect(descBody.mass()).toBe(0);
      expect(runtimeBody.mass()).toBe(0);
      expect(descBody.invPrincipalInertia()).toEqual({ x: 0, y: 0, z: 0 });
      // A collider-carrying body reads back EXACTLY at creation (the S0
      // wheel path) — mass 0.5 from a cylinder r=0.08 half-height 0.025.
      const hubR = 0.08;
      const hubHH = 0.025;
      const colliderBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(6, 50, 0));
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(hubHH, hubR)
          .setRotation({ x: SQ, y: 0, z: 0, w: SQ })
          .setDensity(0.5 / (Math.PI * hubR * hubR * 2 * hubHH)),
        colliderBody
      );
      expect(Math.abs(colliderBody.mass() - 0.5)).toBeLessThan(1e-6 * 0.5);
      // Post-step the colliderless readbacks materialize (measured: exact).
      world.step();
      expect(Math.abs(descBody.mass() - 5)).toBeLessThan(1e-6 * 5);
      const inv = descBody.invPrincipalInertia();
      expect(Math.abs(inv.x - 50)).toBeLessThan(1e-3);
      expect(Math.abs(inv.z - 100)).toBeLessThan(1e-3);
    } finally {
      world.free();
    }
  });

  test('body placement sets the initial coordinate; coincident anchors read zero', async () => {
    // f32 pose readback at base magnitude ~5 → band 1e-5.
    const placed = await runRig(deterministic, { d: 0.15, target: null, limits: null, steps: 0 });
    expect(Math.abs(placed.coord0 - 0.15)).toBeLessThan(1e-5); // measured 0.150000
    const coincident = await runRig(deterministic, { d: 0, target: null, limits: null, steps: 0 });
    expect(Math.abs(coincident.coord0)).toBeLessThan(1e-5); // measured 0.000000
  });

  test('the position-motor target is an ABSOLUTE coordinate, not spawn-relative', async () => {
    const theory = 0.25 + (5 * GRAVITY) / 20000; // 0.25500
    const fromLow = await runRig(deterministic, { d: 0.10, target: 0.25 });
    const fromHigh = await runRig(deterministic, { d: 0.35, target: 0.25 });
    const diag = JSON.stringify({ fromLow: fromLow.coord, fromHigh: fromHigh.coord, theory });
    expect(Math.abs(fromLow.coord - theory), diag).toBeLessThan(2e-3); // measured 0.25500
    expect(Math.abs(fromHigh.coord - theory), diag).toBeLessThan(2e-3); // measured 0.25500
    expect(Math.abs(fromLow.coord - fromHigh.coord), diag).toBeLessThan(5e-4);
  });

  test('spring honesty: ForceBased sag tracks m·g/k on BOTH sides of the target; AccelerationBased is mass-blind (REJECTED)', async () => {
    // Extension side (hub hangs): settle = target + m·g/k.
    const fb5 = await runRig(deterministic, { m: 5, target: 0.2 });
    const fb50 = await runRig(deterministic, { m: 50, target: 0.2 });
    const diag = JSON.stringify({ fb5: fb5.coord, fb50: fb50.coord });
    expect(Math.abs(fb5.coord - 0.205), diag).toBeLessThan(2e-3); // measured 0.20500
    expect(Math.abs(fb50.coord - 0.250), diag).toBeLessThan(2e-3); // measured 0.25000
    // Relational: greater suspended mass ⇒ greater displacement.
    expect(fb50.coord - fb5.coord, diag).toBeGreaterThan(0.040); // theory 0.045
    expect(fb50.coord - fb5.coord, diag).toBeLessThan(0.050);
    // Compression side (axis UP: gravity pulls toward −coordinate): the same
    // law with the sign flipped — settle = target − m·g/k.
    const comp = await runRig(deterministic, { axis: AXIS_UP, m: 20, target: 0.2 });
    expect(Math.abs(comp.coord - 0.18), JSON.stringify(comp)).toBeLessThan(2e-3); // measured 0.18000
    // AccelerationBased: BOTH masses settle at the same coordinate — the
    // declared N/m interpretation is dishonest under it.
    const ab5 = await runRig(deterministic, { m: 5, target: 0.2, model: 'AccelerationBased' });
    const ab50 = await runRig(deterministic, { m: 50, target: 0.2, model: 'AccelerationBased' });
    const abDiag = JSON.stringify({ ab5: ab5.coord, ab50: ab50.coord });
    expect(Math.abs(ab50.coord - ab5.coord), abDiag).toBeLessThan(2e-3); // measured 0.20100 BOTH
  });

  test('stiffness sensitivity: greater k ⇒ less displacement at fixed mass', async () => {
    const soft = await runRig(deterministic, { m: 20, k: 5000, target: 0.2 });
    const stiff = await runRig(deterministic, { m: 20, k: 20000, target: 0.2 });
    const diag = JSON.stringify({ soft: soft.coord, stiff: stiff.coord });
    expect(Math.abs(soft.coord - 0.28), diag).toBeLessThan(3e-3); // measured 0.28000
    expect(Math.abs(stiff.coord - 0.22), diag).toBeLessThan(2e-3); // measured 0.22000
    const ratio = (soft.coord - 0.2) / (stiff.coord - 0.2); // theory 4 (k ratio)
    expect(ratio, diag).toBeGreaterThan(3);
    expect(ratio, diag).toBeLessThan(5);
  });

  test('damping changes oscillation decay, NOT static equilibrium', async () => {
    // Released from d=0.35 toward target 0.2 (m=5, k=20000).
    const undamped = await runRig(deterministic, { d: 0.35, target: 0.2, c: 0 });
    const damped = await runRig(deterministic, { d: 0.35, target: 0.2, c: 2000 });
    const diag = JSON.stringify({
      undamped: { coord: undamped.coord, trough: undamped.trough },
      damped: { coord: damped.coord, trough: damped.trough },
    });
    // Equilibria agree (measured 0.20500 vs 0.20501).
    expect(Math.abs(undamped.coord - damped.coord), diag).toBeLessThan(1e-3);
    // c=0 overshoots deep below equilibrium (measured trough 0.10820)…
    expect(undamped.trough, diag).toBeLessThan(0.16);
    // …c=2000 approaches monotonically (measured trough = settle, 0.20501).
    expect(damped.trough, diag).toBeGreaterThan(damped.coord - 5e-3);
  });

  test('limits enforce both ends; readbacks agree; leakage is load-scaled and bounded', async () => {
    // Extension stop under gravity (no motor): pinned at the max.
    const extended = await runRig(deterministic, { d: 0.15, target: null });
    const diag1 = JSON.stringify(extended);
    // limitsMin/Max read back f32-quantized (0.4 → 0.4000000059604645).
    expect(extended.limitsRead[0], diag1).toBe(0);
    expect(Math.abs(extended.limitsRead[1] - 0.4), diag1).toBeLessThan(1e-6);
    expect(extended.limitsRead[2], diag1).toBe(true);
    expect(Math.abs(extended.coord - 0.4), diag1).toBeLessThan(2e-3); // measured 0.40000
    // Compression stop against a strong motor targeting −0.5: pinned at min.
    const compressed = await runRig(deterministic, { d: 0.15, target: -0.5, k: 50000, c: 1000 });
    expect(compressed.coord, JSON.stringify(compressed)).toBeGreaterThan(-2e-3); // measured 0.00000
    expect(compressed.coord).toBeLessThan(5e-3);
    // Heavy load on the extension stop: leakage scales with load but stays
    // bounded (stop compliance measured ≈ 9e-6 m/N in-chain; the raw hanging
    // rig converges at least as tightly).
    const heavy = await runRig(deterministic, { d: 0.2, target: null, m: 500, steps: 900 });
    const leak = heavy.coord - 0.4;
    expect(leak, JSON.stringify(heavy)).toBeGreaterThan(-1e-3);
    expect(leak, JSON.stringify(heavy)).toBeLessThan(0.05);
    expect(heavy.finite).toBe(true);
  });

  test('preload: a target beyond the extension limit sits pinned at the stop as a STATIC state', async () => {
    const preloaded = await runRig(deterministic, { d: 0.2, target: 0.5, limits: [0, 0.2] });
    const diag = JSON.stringify(preloaded);
    expect(Math.abs(preloaded.coord - 0.2), diag).toBeLessThan(5e-3); // measured 0.20000
    expect(preloaded.hubSpeed, diag).toBeLessThan(0.01); // static, not oscillating
    expect(preloaded.finite).toBe(true);
  });

  test('zero travel (setLimits(0,0)) is engine-safe: a locked suspension', async () => {
    const locked = await runRig(deterministic, { d: 0, target: 0.3, limits: [0, 0] });
    const diag = JSON.stringify(locked);
    expect(Math.abs(locked.coord), diag).toBeLessThan(5e-3); // measured 0.00000
    expect(locked.finite).toBe(true);
  });

  test('a huge load clamps finitely at the stop — limits are real constraints', async () => {
    const crushed = await runRig(deterministic, { d: 0.2, target: 0.2, m: 5000 });
    const diag = JSON.stringify(crushed);
    expect(crushed.coord, diag).toBeGreaterThan(0.39); // measured 0.40000
    expect(crushed.coord, diag).toBeLessThan(0.46);
    expect(crushed.finite).toBe(true);
  });

  test('degenerate spring params: k=0 damper works; k=0,c=0 FREEZES the axis (the measured degeneracy behind the realizer skip-motor rule)', async () => {
    // Damper-only is well-defined: gravity drifts the hub to the extension
    // stop, damped (measured trajectory 0.10 → 0.13 @10 → 0.30 @60 → 0.40).
    const damperOnly = await runRig(deterministic, { d: 0.1, target: 0.2, k: 0, c: 500, steps: 900 });
    expect(damperOnly.finite, JSON.stringify(damperOnly)).toBe(true);
    expect(Math.abs(damperOnly.coord - 0.4), JSON.stringify(damperOnly)).toBeLessThan(5e-3); // measured 0.4000
    // configureMotorPosition(target, 0, 0) is ENGINE-DEGENERATE: the motor
    // params divide 0/0 and the free axis LOCKS — the hub never moves at all
    // (measured: coordinate pinned at the 0.1 spawn for 900 steps, speed 0),
    // which is NOT free-slider semantics. The S1 realizer therefore SKIPS
    // motor configuration when stiffness === 0 && damping === 0 — a spring
    // with no stiffness and no damping IS no motor (the S0 "gain-0 motor ≡
    // no motor" equivalence), giving the phenotype honest free-slider
    // behavior between its stops instead of this silent lock.
    const zeroZero = await runRig(deterministic, { d: 0.1, target: 0.2, k: 0, c: 0, steps: 900 });
    expect(zeroZero.finite, JSON.stringify(zeroZero)).toBe(true);
    expect(Math.abs(zeroZero.coord - zeroZero.coord0), JSON.stringify(zeroZero)).toBeLessThan(1e-3); // frozen at spawn
    expect(zeroZero.hubSpeed, JSON.stringify(zeroZero)).toBeLessThan(1e-6);
    // The TRUE free slider (no motor configured at all) reaches the stop —
    // the semantics the realizer's skip rule preserves.
    const freeSlider = await runRig(deterministic, { d: 0.1, target: null, steps: 900 });
    expect(Math.abs(freeSlider.coord - 0.4), JSON.stringify(freeSlider)).toBeLessThan(5e-3); // measured 0.4000
  });

  test('vehicle-local covariance: the axis rotates with the body; a world-vertical substitution is FAR off at pitch/roll; roll-180 REVERSES extension', async () => {
    for (const [name, rot, wrongMin] of [
      ['identity', IDENTITY, null], // world-vertical coincides at identity — no discrimination
      ['yaw90', YAW_90, null], //     …and yaw preserves Y — no discrimination either
      ['pitch30', PITCH_30, 0.1], //  measured |hub − worldVertical| = 0.130
      ['roll180', ROLL_180, 0.4], //  measured |hub − worldVertical| = 0.496
    ]) {
      const r = await runRig(deterministic, { rot, d: 0.25, target: 0.25, k: 50000, c: 2000 });
      const diag = JSON.stringify({ name, coord: r.coord, hubWorld: r.hubWorld });
      // Covariant prediction: hub = BASE + R·(anchor + coord·axis) — measured
      // agreement ≤ 1e-6 m at every orientation; banded 2e-3 (f32 + settle).
      const covariant = add(BASE, rotateVector(rot, add(ANCHOR, scale(AXIS_DOWN, r.coord))));
      expect(norm(sub(r.hubWorld, covariant)), diag).toBeLessThan(2e-3);
      if (wrongMin !== null) {
        // The DIRECT NEGATIVE: a code path that substituted global −Y for the
        // vehicle-local axis would put the hub here — far from reality.
        const worldVertical = add(add(BASE, rotateVector(rot, ANCHOR)), scale({ x: 0, y: -1, z: 0 }, r.coord));
        expect(norm(sub(r.hubWorld, worldVertical)), diag).toBeGreaterThan(wrongMin);
      }
      if (name === 'roll180') {
        // Extension points world-UP when rolled: the hub sits ABOVE its
        // anchor (measured hub y 5.248 vs anchor world y 5.0).
        const anchorWorldY = add(BASE, rotateVector(rot, ANCHOR)).y;
        expect(r.hubWorld.y, diag).toBeGreaterThan(anchorWorldY + 0.2);
      }
    }
  });
});
