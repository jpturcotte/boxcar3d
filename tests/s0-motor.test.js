// The S0 motor-model ruling, locked at the RAW Rapier API level (no adapter
// symbols beyond the existing seam exports) — BOTH flavors via describe.each ×
// createPhysics, per F10 exactness only ever per-flavor. No random draws
// anywhere in this file: every rig is a declared literal, so no seeds.
//
// THE RULING (S0 kernel PR): motors run ForceBased, and the adapter converts
// the IR's torque allocation into Rapier's velocity-servo gain —
//     gain = driveTorque / |targetAngvel|      (gain ≥ 0)
// so the signed law is τ = gain × (targetAngvel − ω) = sign(targetAngvel) ×
// driveTorque × (1 − ω/targetAngvel): the stall MAGNITUDE = driveTorque
// EXACTLY (its sign follows targetAngvel — negative target ⇒ −driveTorque
// stall), τ a linear servo falling to zero at the target speed. Rapier's
// factor is a GAIN derived from the IR torque — driveTorque itself is not
// the gain. This file
// locks the physical relationships that make that conversion honest;
// tests/s0-kernel.test.js locks the same semantics through the shipped
// realizeS0Vehicle path.
//
// Why ForceBased (the model discriminator, airborne bench — fixed chassis,
// one wheel on a revolute, NO ground contact, so no traction/contact/mass
// confounders): with the SAME intended stall torque on wheels of inertia
// I = 2.036 vs 10.31 kg·m² (r 0.3 vs 0.45, same width/density; I ratio 5.06),
//   ForceBased        first-step ω ratio tracks inertia   (measured 4.862)
//   AccelerationBased first-step ω ratio is 1.000 EXACTLY (solver compensates
//                     effective inertia away — its factor is not a torque, so
//                     wheel size would silently rescale thrust; REJECTED)
// The vehicle-level teeth below stay as integrated confirmation only — a
// heavier AccelerationBased vehicle ALSO accelerates less (traction dynamics
// dominate), which is exactly why the airborne rig is the discriminator.
//
// MEASURED (this worktree, Windows, both flavors identical, 2026-07-10; CI is
// Linux — bands carry margin for cross-platform settle drift):
//   bench, torque 100, target −10, r 0.3 unless noted, dt 1/60:
//     FB inertia ratio (r 0.3 vs 0.45)          4.8624   (band [3.5, 5.5])
//     AB inertia ratio                          1.0000   (band ±0.05)
//     FB torque proportionality ω@1 200/100     1.9046   (band [1.7, 2.0])
//     FB target invariance ω@1 @ −5/−10/−20     0.7413/0.7785/0.7982
//                                        spread ≤ 1.08   (band max/min ≤ 1.15)
//     FB α@(ω=target/2) / α@rest                0.5228   (band [0.40, 0.65])
//     FB ω@40 of target −10                     −9.609   (approach band ≥ 0.90×)
//   vehicle (4 wheels r 0.3, flat floor friction 1, braked settle to an
//   asserted ≤0.05 m/s forward baseline, then motor-on + wakeUp; torque per
//   wheel 100 ⇒ gain 10):
//     mass sensitivity vx@15 light/heavy        2.2024   (light 278 kg, heavy
//                                                959 kg; band ≥ 1.5)
//     torque proportionality dx@15 200/100      1.7981   (band [1.6, 2.0])
//     sign: target −10 → dx@240 = +9.473, target +10 → dx@240 = −9.485
//     braked-settle forward baseline at 600     0 (light) / 0.0348 (heavy)
// Diagnostic (NOT asserted — Rapier's discrete-solver trajectory is
// implementation detail): the bench run matches the continuous-time law
// ω(t) = target·(1 − e^(−gain·t/I)) within ~1% at steps 10/30/60.

import { describe, test, expect } from 'vitest';
import {
  CHASSIS_GROUPS,
  GROUND_GROUPS,
  SOFT_CCD_PREDICTION,
  WHEEL_GROUPS,
  createPhysics,
} from '../src/sim/physics/adapter.js';

const W = 0.2; // wheel width (m)
const RHO = 800; // wheel density (kg/m³)
const R_SMALL = 0.3;
const R_LARGE = 0.45; // inertia ratio (0.45/0.3)^4 ≈ 5.06 at equal width/density
const TARGET = -10; // rad/s about local +Z — the forward-drive sign (see sign test)
const TORQUE = 100; // intended stall torque (N·m) per driven wheel
const gainFor = (torque, target) => torque / Math.abs(target); // the S0 conversion under test
const wheelInertia = (r) => 0.5 * Math.PI * r * r * W * RHO * r * r; // solid cylinder about its axis
const Q_Y_TO_Z = { x: Math.sqrt(0.5), y: 0, z: 0, w: Math.sqrt(0.5) }; // +90° about X, trig-free

// --- Airborne bench: fixed chassis, ONE wheel on a revolute about +Z, no
// ground anywhere. The wheel hangs on the joint; the motor is the only thing
// that can spin it, so first-step ω isolates τ/I exactly.
function benchWheel(RAPIER, world, { radius, torque, target, model }) {
  const chassis = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 5, 0));
  world
    .createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.15, 0.45), chassis)
    .setCollisionGroups(CHASSIS_GROUPS); // group-inert vs the wheel either way
  const wheel = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 1));
  world
    .createCollider(RAPIER.ColliderDesc.cylinder(W / 2, radius).setRotation(Q_Y_TO_Z).setDensity(RHO), wheel)
    .setCollisionGroups(WHEEL_GROUPS);
  const joint = world.createImpulseJoint(
    RAPIER.JointData.revolute({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    chassis,
    wheel,
    true
  );
  joint.configureMotorModel(model);
  joint.configureMotorVelocity(target, gainFor(torque, target));
  return wheel;
}

// First-step ω_z: one step from rest, so the servo error is the full target
// and the measured spin is (applied impulse)/I — the τ/I probe.
async function benchOmega1(deterministic, cfg) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    const model = cfg.model === 'AB' ? RAPIER.MotorModel.AccelerationBased : RAPIER.MotorModel.ForceBased;
    const wheel = benchWheel(RAPIER, world, { ...cfg, model });
    world.step();
    return wheel.angvel().z;
  } finally {
    world.free();
  }
}

// --- Vehicle rig: the 4-wheel probe (cuboid chassis, cylinder wheels) on a
// big flat cuboid floor. Motors are configured AFTER a braked settle phase
// (see the solver-pump finding at settleThenDrive), so early-step
// measurements start from an asserted near-zero forward baseline.
const WHEEL_XZ = [
  [-0.6, 0.55],
  [-0.6, -0.55],
  [0.6, 0.55],
  [0.6, -0.55],
];

function buildVehicle(RAPIER, world, { chassisDensity }) {
  world
    .createCollider(RAPIER.ColliderDesc.cuboid(400, 1, 50).setTranslation(0, -1, 0).setFriction(1))
    .setCollisionGroups(GROUND_GROUPS);
  const spawnY = R_SMALL + 0.01;
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, spawnY, 0)
      .setCcdEnabled(true)
      .setSoftCcdPrediction(SOFT_CCD_PREDICTION)
      .setAdditionalSolverIterations(4)
  );
  world
    .createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.15, 0.45).setDensity(chassisDensity), chassis)
    .setCollisionGroups(CHASSIS_GROUPS);
  const bodies = [chassis];
  const joints = [];
  for (const [lx, lz] of WHEEL_XZ) {
    const wheel = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(lx, spawnY, lz)
        .setCcdEnabled(true)
        .setSoftCcdPrediction(SOFT_CCD_PREDICTION)
    );
    world
      .createCollider(RAPIER.ColliderDesc.cylinder(W / 2, R_SMALL).setRotation(Q_Y_TO_Z).setDensity(RHO).setFriction(1), wheel)
      .setCollisionGroups(WHEEL_GROUPS);
    joints.push(
      world.createImpulseJoint(
        RAPIER.JointData.revolute({ x: lx, y: 0, z: lz }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
        chassis,
        wheel,
        true
      )
    );
    bodies.push(wheel);
  }
  return { chassis, bodies, joints };
}

// FINDING (2026-07-10, this rig, both flavors): an awake free-rolling jointed
// vehicle under the chassis ADDITIONAL_SOLVER_ITERATIONS policy shows a
// solver-pump drift — from rest, with NO motor, it self-accelerates to a
// ~0.33 m/s plateau (+X here; without the extra iterations the drift is
// −0.09 m/s and the island sleeps; soft CCD is irrelevant; the magnitude
// shifts with floor extents, i.e. contact-point rounding). It is solver bias,
// not physics, and it never sleeps because the rolling wheels stay above the
// angular sleep threshold. Protocol: settle behind a PARKING BRAKE — the same
// native motor path with target 0 (a pure damper, no state writes) — which
// bounds the residual to ≤ 0.035 m/s (heavy rig; light rig reaches exact 0
// and sleeps), assert that bound, then reconfigure the joints to the real
// drive values and wake. The residual is same-signed as the drive, so it
// inflates the heavy rig's response — the mass-tooth ratio below is an
// UNDERestimate, i.e. the contamination is conservative.
const BRAKE_GAIN = 100; // N·m·s/rad of damping per wheel during settle
const SETTLE_STEPS = 600; // the heavy rig's pump peaks ~0.095 m/s mid-settle, decays after
// Every tooth below samples the chassis FORWARD state (vx/dx), so the rest
// assertion bounds |vx| (measured baseline: 0 light, 0.0348 heavy at step
// 600). The heavy braked rig also keeps a deterministic LATERAL slide
// (vz ≈ 0.103 — braked wheels resist rolling, not sideways solver push);
// it never enters a forward measurement.
const SETTLE_RESIDUAL = 0.05; // m/s, chassis |vx|

function settleThenDrive(world, { chassis, bodies, joints }, model, { torque, target }) {
  for (const j of joints) {
    j.configureMotorModel(model);
    j.configureMotorVelocity(0, BRAKE_GAIN); // parking brake
  }
  for (let i = 0; i < SETTLE_STEPS; i++) world.step();
  const residual = Math.abs(chassis.linvel().x);
  if (residual >= SETTLE_RESIDUAL) {
    throw new Error(`s0-motor: braked settle left the chassis at vx ${residual} m/s (band ${SETTLE_RESIDUAL})`);
  }
  for (const j of joints) j.configureMotorVelocity(target, gainFor(torque, target));
  for (const b of bodies) b.wakeUp(); // the light rig sleeps at exact rest by ~150 steps
}

// Drive from braked rest and sample chassis vx/dx at fixed step counts.
async function driveRun(deterministic, { chassisDensity, torque, target, model: modelName }, sampleSteps) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    const model = modelName === 'AB' ? RAPIER.MotorModel.AccelerationBased : RAPIER.MotorModel.ForceBased;
    const rig = buildVehicle(RAPIER, world, { chassisDensity });
    settleThenDrive(world, rig, model, { torque, target });
    const x0 = rig.chassis.translation().x;
    const samples = {};
    const last = Math.max(...sampleSteps);
    for (let i = 1; i <= last; i++) {
      world.step();
      if (sampleSteps.includes(i)) {
        samples[i] = { vx: rig.chassis.linvel().x, dx: rig.chassis.translation().x - x0 };
      }
    }
    const wheelMass = Math.PI * R_SMALL * R_SMALL * W * RHO;
    samples.totalMass = rig.chassis.mass() + 4 * wheelMass;
    return samples;
  } finally {
    world.free();
  }
}

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('S0 motor-model ruling (deterministic=%s, %s)', (deterministic) => {
  test('MotorModel enum: ForceBased and AccelerationBased exist and are distinct', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      expect(typeof RAPIER.MotorModel.ForceBased).toBe('number');
      expect(typeof RAPIER.MotorModel.AccelerationBased).toBe('number');
      expect(RAPIER.MotorModel.ForceBased).not.toBe(RAPIER.MotorModel.AccelerationBased);
    } finally {
      world.free();
    }
  });

  test('discriminator: ForceBased first-step ω tracks wheel inertia; AccelerationBased compensates it away', async () => {
    const iRatio = wheelInertia(R_LARGE) / wheelInertia(R_SMALL); // ≈ 5.063
    expect(iRatio).toBeGreaterThan(5);

    const fbSmall = await benchOmega1(deterministic, { radius: R_SMALL, torque: TORQUE, target: TARGET, model: 'FB' });
    const fbLarge = await benchOmega1(deterministic, { radius: R_LARGE, torque: TORQUE, target: TARGET, model: 'FB' });
    const fbRatio = fbSmall / fbLarge;
    // Same intended stall torque ⇒ ω@1 ∝ 1/I under a real torque (measured
    // 4.8624 vs the 5.063 inertia ratio — the gap is the implicit step).
    expect(fbRatio).toBeGreaterThan(3.5);
    expect(fbRatio).toBeLessThan(5.5);

    const abSmall = await benchOmega1(deterministic, { radius: R_SMALL, torque: TORQUE, target: TARGET, model: 'AB' });
    const abLarge = await benchOmega1(deterministic, { radius: R_LARGE, torque: TORQUE, target: TARGET, model: 'AB' });
    const abRatio = abSmall / abLarge;
    // The rejected model's locked failure: inertia-INsensitive (measured
    // 1.0000) — its factor is not a torque.
    expect(Math.abs(abRatio - 1)).toBeLessThan(0.05);
  });

  test('torque proportionality: doubled stall torque roughly doubles first-step ω (ForceBased)', async () => {
    const w1 = await benchOmega1(deterministic, { radius: R_SMALL, torque: TORQUE, target: TARGET, model: 'FB' });
    const w2 = await benchOmega1(deterministic, { radius: R_SMALL, torque: 2 * TORQUE, target: TARGET, model: 'FB' });
    const ratio = w2 / w1; // measured 1.9046 (the shortfall from 2 is the implicit step)
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.0);
  });

  test('target-speed invariance: fixed driveTorque keeps initial stall acceleration across targets (the gain conversion)', async () => {
    const omegas = [];
    for (const target of [-5, -10, -20]) {
      omegas.push(Math.abs(await benchOmega1(deterministic, { radius: R_SMALL, torque: TORQUE, target, model: 'FB' })));
    }
    // gain = torque/|target| rescales the servo so stall torque stays put:
    // measured 0.7413/0.7785/0.7982 (spread 1.077). Without the conversion the
    // raw factor law would spread these by 4×.
    const spread = Math.max(...omegas) / Math.min(...omegas);
    expect(spread).toBeLessThan(1.15);
  });

  test('torque falls with speed: α at half-target ≈ half of α at rest, ω approaches target from below', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const wheel = benchWheel(RAPIER, world, {
        radius: R_SMALL,
        torque: TORQUE,
        target: TARGET,
        model: RAPIER.MotorModel.ForceBased,
      });
      const omega = [0];
      for (let i = 1; i <= 40; i++) {
        world.step();
        omega.push(wheel.angvel().z);
      }
      const alpha = (i) => Math.abs(omega[i] - omega[i - 1]) * 60;
      const half = omega.findIndex((w) => Math.abs(w) >= Math.abs(TARGET) / 2);
      expect(half).toBeGreaterThan(1); // the ramp is resolvable, not a one-step jump
      const ratio = alpha(half) / alpha(1); // measured 0.5228 (theory 0.5 — linear law)
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.65);
      // Approach: |ω| grows monotonically, never crosses the target, and gets
      // close to it — the no-load speed is the target speed.
      for (let i = 1; i <= 40; i++) {
        expect(Math.abs(omega[i])).toBeGreaterThan(Math.abs(omega[i - 1]) - 1e-9);
        expect(Math.abs(omega[i])).toBeLessThan(Math.abs(TARGET) + 1e-6);
      }
      expect(Math.abs(omega[40])).toBeGreaterThan(0.9 * Math.abs(TARGET)); // measured 9.609
    } finally {
      world.free();
    }
  });

  test('vehicle integration: heavier chassis accelerates less under the same driveTorque (mass-sensitivity tooth)', { timeout: 30000 }, async () => {
    const light = await driveRun(deterministic, { chassisDensity: 200, torque: TORQUE, target: TARGET, model: 'FB' }, [15]);
    const heavy = await driveRun(deterministic, { chassisDensity: 1600, torque: TORQUE, target: TARGET, model: 'FB' }, [15]);
    expect(heavy.totalMass / light.totalMass).toBeGreaterThan(3); // the rig contrast is real (278 vs 959 kg)
    const ratio = light[15].vx / heavy[15].vx; // measured 2.2024
    expect(ratio).toBeGreaterThan(1.5);
  });

  test('vehicle integration: driveTorque T vs 2T roughly doubles early displacement (proportionality tooth)', { timeout: 30000 }, async () => {
    const t1 = await driveRun(deterministic, { chassisDensity: 200, torque: TORQUE, target: TARGET, model: 'FB' }, [15]);
    const t2 = await driveRun(deterministic, { chassisDensity: 200, torque: 2 * TORQUE, target: TARGET, model: 'FB' }, [15]);
    const ratio = t2[15].dx / t1[15].dx; // measured 1.7981 (servo saturation trims it below 2 — the law)
    expect(ratio).toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(2.0);
  });

  test('motor sign: negative target angular velocity drives +X, positive drives −X', { timeout: 30000 }, async () => {
    const fwd = await driveRun(deterministic, { chassisDensity: 200, torque: TORQUE, target: TARGET, model: 'FB' }, [240]);
    const rev = await driveRun(deterministic, { chassisDensity: 200, torque: TORQUE, target: -TARGET, model: 'FB' }, [240]);
    expect(fwd[240].dx).toBeGreaterThan(1); // measured +9.473
    expect(rev[240].dx).toBeLessThan(-1); // measured −9.485
  });
});
