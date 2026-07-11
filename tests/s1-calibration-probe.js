// S1 suspension calibration probe — the Gate-5 instrument (NOT a test file;
// vitest collects tests/**/*.test.js only, the tests/rotate-oracle.js
// precedent). Run with:
//
//     npm run probe:s1        (= node tests/s1-calibration-probe.js)
//
// Purpose: a DECLARED, ENUMERATED calibration matrix over the provisional
// suspension gene ranges (stiffness [2000, 50000] N/m, damping [0, 5000]
// N·s/m, travel [0, 0.4] m, restLength [0.05, 0.5] m) measured against the
// pinned engine (rapier 0.19.3, both flavors) at gravity 20, FIXED_DT 1/60.
// Every row is a hand-declared literal — no PRNG, no Date, no sampling — so
// any reviewer regenerates the identical table. The table is pasted into the
// S1 PR description; the version decision (bump GENOTYPE_VERSION vs bind
// unchanged) is applied mechanically from it:
//   1. numerical safety — every row finite in BOTH flavors, no unbounded
//      oscillation, no solver blow-up at the declared corners;
//   2. honest units — the isolated rig settles at target ± m·g/k (the [V12]
//      spring-model ruling; exact rows locked in tests/s1-prismatic.test.js);
//   3. evolutionary breadth — the ranges must contain BOTH poor phenotypes
//      (bottoming, wallowing, preload-rigid) and strong ones (mid-travel
//      compliant riders); a range that is degenerate across the whole legal
//      vehicle band would force a re-centering (⇒ version bump + re-lock).
//
// The rigs are RAW Rapier chains (chassis → prismatic → hub → revolute →
// wheel on a flat cuboid floor), deliberately independent of the production
// realizer (which is itself tested against these measurements later) but
// R2-honest: wheel radius ≥ chassis half-height + 0.1, the compiled-corpus
// clearance guarantee, so full compression never beaches the chassis.
//
// Known engine findings this matrix documents (first measured 2026-07-11):
//   - IN-CHAIN CONVERGENCE STARVATION: through the full chain the static sag
//     inflates multiplicatively with damping and sprung:unsprung mass ratio
//     (γ ≈ 4.5 at c=2000 with 2.5 kg unsprung; ≈ 0.1 at 34 kg unsprung; 0 at
//     c=0), while the isolated rig is EXACT. Not a spring-law change — the
//     chassis ADDITIONAL_SOLVER_ITERATIONS=4 policy materially mitigates it
//     (see the extraIters=0 row), and heavier unsprung mass restores honesty.
//   - STOP COMPLIANCE: limit stops leak ≈ 9e-6 m/N of load.
//   - k=0 ∧ c=0 position motors FREEZE the axis (0/0 motor params) — the
//     realizer skips motor config for that phenotype (free slider).
/* eslint no-console: 0 */
import {
  createPhysics, GRAVITY, packGroups, CHASSIS_GROUPS, WHEEL_GROUPS, GROUND_GROUPS,
} from '../src/sim/physics/adapter.js';
import { rotateVector } from './rotate-oracle.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const SQ = Math.sqrt(0.5);
const YAW_90 = { x: 0, y: SQ, z: 0, w: SQ };
const AXIS_DOWN = { x: 0, y: -1, z: 0 };
// Probe-local hub group: membership 0x0010 (0x0008 stays reserved in the
// adapter's documented group plan), filter 0 — collides with NOTHING.
const HUB_GROUPS_PROBE = packGroups(0x0010, 0);

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (v, s) => ({ x: v.x * s, y: v.y * s, z: v.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const f = (n, d = 4) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : String(n));

function coordOf(chassisBody, hubBody, anchor1) {
  const a1w = add(chassisBody.translation(), rotateVector(chassisBody.rotation(), anchor1));
  return dot(sub(hubBody.translation(), a1w), rotateVector(chassisBody.rotation(), AXIS_DOWN));
}

// --- Bench rig: isolated fixed chassis, hanging colliderless hub ------------
async function bench(deterministic, { k, c, target, m, limits = [0, 0.4], model = 'ForceBased', steps = 600 }) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    const anchor = { x: 0.5, y: 0, z: 0.3 };
    const chassis = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 5, 0));
    const hub = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0.5, 4.8, 0.3)
        .setAdditionalMassProperties(m, { x: 0, y: 0, z: 0 }, { x: 0.02 * m, y: 0.02 * m, z: 0.01 * m }, IDENTITY)
    );
    const joint = world.createImpulseJoint(RAPIER.JointData.prismatic(anchor, { x: 0, y: 0, z: 0 }, AXIS_DOWN), chassis, hub, true);
    joint.setLimits(limits[0], limits[1]);
    if (target !== null) {
      joint.configureMotorModel(RAPIER.MotorModel[model]);
      joint.configureMotorPosition(target, k, c);
    }
    let trough = Infinity;
    let peak = -Infinity;
    for (let i = 0; i < steps; i++) {
      world.step();
      const q = coordOf(chassis, hub, anchor);
      if (q < trough) trough = q;
      if (q > peak) peak = q;
    }
    const p = hub.translation();
    return { q: coordOf(chassis, hub, anchor), trough, peak, finite: [p.x, p.y, p.z].every(Number.isFinite) };
  } finally {
    world.free();
  }
}

// --- Chain rig: dynamic chassis → prismatic → hub → revolute → wheel --------
// R2-honest geometry: chassis half-height 0.1, wheel radius 0.2.
async function chain(deterministic, {
  chassisKg = 100, wheelKg = 2, k = 50000, c = 2000, target = 0.2,
  travel = 0.4, axleX = [0], rot = IDENTITY, extraIters = 4,
  torque = 0, settleSteps = 900, driveSteps = 600, mixedRadii = null,
}) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 25).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUND_GROUPS));
    world.step(); // [V1] query BVH
    const wheelW = 0.1;
    const coord0 = Math.max(0, Math.min(target, travel)); // the quiescent-spawn rule
    const maxWheelR = mixedRadii ? Math.max(...mixedRadii) : 0.2;
    const chassisY = maxWheelR + coord0 + 0.02;
    let desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(0, chassisY, 0).setRotation(rot)
      .setCcdEnabled(true).setSoftCcdPrediction(1);
    if (extraIters > 0) desc = desc.setAdditionalSolverIterations(extraIters);
    const chassis = world.createRigidBody(desc);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.9, 0.1, 0.45).setDensity(chassisKg / (1.8 * 0.2 * 0.9)).setCollisionGroups(CHASSIS_GROUPS),
      chassis
    );
    const stations = [];
    axleX.forEach((ax, axleIdx) => {
      for (const z of [0.6, -0.6]) {
        const wheelR = mixedRadii ? mixedRadii[axleIdx] : 0.2;
        const anchor1 = { x: ax, y: 0, z };
        const hubKg = 0.25 * wheelKg;
        const hubR = 0.4 * wheelR;
        const hubHH = 0.25 * wheelW;
        const stationLocal = add(anchor1, scale(AXIS_DOWN, coord0));
        const stationWorld = add({ x: 0, y: chassisY, z: 0 }, rotateVector(rot, stationLocal));
        const hub = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(stationWorld.x, stationWorld.y, stationWorld.z).setRotation(rot)
            .setCcdEnabled(true).setSoftCcdPrediction(1)
        );
        world.createCollider(
          RAPIER.ColliderDesc.cylinder(hubHH, hubR).setRotation({ x: SQ, y: 0, z: 0, w: SQ })
            .setDensity(hubKg / (Math.PI * hubR * hubR * 2 * hubHH)).setCollisionGroups(HUB_GROUPS_PROBE),
          hub
        );
        const prismatic = world.createImpulseJoint(
          RAPIER.JointData.prismatic(anchor1, { x: 0, y: 0, z: 0 }, AXIS_DOWN), chassis, hub, true
        );
        prismatic.setLimits(0, travel);
        if (k !== 0 || c !== 0) {
          prismatic.configureMotorModel(RAPIER.MotorModel.ForceBased);
          prismatic.configureMotorPosition(target, k, c);
        }
        const wheel = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(stationWorld.x, stationWorld.y, stationWorld.z).setRotation(rot)
            .setCcdEnabled(true).setSoftCcdPrediction(1)
        );
        world.createCollider(
          RAPIER.ColliderDesc.cylinder(wheelW / 2, wheelR).setRotation({ x: SQ, y: 0, z: 0, w: SQ })
            .setDensity(wheelKg / (Math.PI * wheelR * wheelR * wheelW)).setFriction(1).setCollisionGroups(WHEEL_GROUPS),
          wheel
        );
        const revolute = world.createImpulseJoint(
          RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), hub, wheel, true
        );
        stations.push({ anchor1, hub, wheel, revolute });
      }
    });
    for (let i = 0; i < settleSteps; i++) world.step();
    const qs = stations.map((st) => coordOf(chassis, st.hub, st.anchor1));
    const meanQ = qs.reduce((s, q) => s + q, 0) / qs.length;
    const Fw = (chassisKg * GRAVITY) / stations.length;
    const out = {
      qs,
      meanQ,
      kEff: target - meanQ > 1e-4 && meanQ > 1e-4 ? Fw / (target - meanQ) : null,
      chassisY: chassis.translation().y,
      finite: Number.isFinite(chassis.translation().y),
    };
    if (torque > 0) {
      for (const st of stations) {
        st.revolute.configureMotorModel(RAPIER.MotorModel.ForceBased);
        st.revolute.configureMotorVelocity(-10, torque / 10);
        st.hub.wakeUp();
        st.wheel.wakeUp();
      }
      chassis.wakeUp();
      let minQ = Infinity;
      let maxQ = -Infinity;
      let maxTwistZ = 0;
      let maxSwingXY = 0;
      for (let i = 0; i < driveSteps; i++) {
        world.step();
        for (const st of stations) {
          const q = coordOf(chassis, st.hub, st.anchor1);
          if (q < minQ) minQ = q;
          if (q > maxQ) maxQ = q;
          const qc = chassis.rotation();
          const qh = st.hub.rotation();
          const rel = {
            x: qc.w * qh.x - qc.x * qh.w - (qc.y * qh.z - qc.z * qh.y),
            y: qc.w * qh.y - qc.y * qh.w - (qc.z * qh.x - qc.x * qh.z),
            z: qc.w * qh.z - qc.z * qh.w - (qc.x * qh.y - qc.y * qh.x),
            w: qc.w * qh.w + qc.x * qh.x + qc.y * qh.y + qc.z * qh.z,
          };
          const twist = Math.abs(2 * Math.atan2(rel.z, rel.w));
          const swing = 2 * Math.asin(Math.min(1, Math.sqrt(rel.x * rel.x + rel.y * rel.y)));
          if (twist > maxTwistZ) maxTwistZ = twist;
          if (swing > maxSwingXY) maxSwingXY = swing;
        }
      }
      const t = chassis.translation();
      out.dx = rot === YAW_90 ? -t.z : t.x; // forward is body-local +X
      out.vx = chassis.linvel().x;
      out.minQ = minQ;
      out.maxQ = maxQ;
      out.maxTwistZ = maxTwistZ;
      out.maxSwingXY = maxSwingXY;
      out.omega = stations.map((st) => st.wheel.angvel().z);
      out.finite = out.finite && Number.isFinite(t.x);
    }
    return out;
  } finally {
    world.free();
  }
}

// --- The declared matrix -----------------------------------------------------
const BENCH_ROWS = [
  ['B01', { k: 20000, c: 500, target: 0.2, m: 5 }, 'FB honesty light (honest .2050)'],
  ['B02', { k: 20000, c: 500, target: 0.2, m: 50 }, 'FB honesty heavy (honest .2500)'],
  ['B03', { k: 20000, c: 500, target: 0.2, m: 5, model: 'AccelerationBased' }, 'AB light (mass-blind)'],
  ['B04', { k: 20000, c: 500, target: 0.2, m: 50, model: 'AccelerationBased' }, 'AB heavy (mass-blind ⇒ REJECTED)'],
  ['B05', { k: 20000, c: 500, target: 0.2, m: 5000 }, 'huge load clamps at stop'],
  ['B06', { k: 50000, c: 0, target: 0.2, m: 2.5 }, 'max-k undamped light: bounded ring'],
  ['B07', { k: 2000, c: 0, target: 0.2, m: 100 }, 'min-k heavy: droops past stop'],
  ['B08', { k: 20000, c: 5000, target: 0.2, m: 5 }, 'max damping: overdamped, no lock'],
  ['B09', { k: 20000, c: 500, target: 0.5, m: 5, limits: [0, 0.2] }, 'preload: pinned at extension stop'],
  ['B10', { k: 20000, c: 500, target: 0.3, m: 5, limits: [0, 0] }, 'zero travel: locked'],
  ['B11', { k: 0, c: 500, target: 0.2, m: 5, steps: 900 }, 'damper-only: drifts to stop'],
  ['B12', { k: 0, c: 0, target: null, m: 500, steps: 900 }, 'no motor, 10 kN on stop: leak'],
  ['B13', { k: 0, c: 0, target: 0.2, m: 5, steps: 900 }, 'k=0 ∧ c=0 motor: FREEZES (degenerate)'],
];

const CHAIN_ROWS = [
  ['C01', { c: 0 }, 'baseline honest: γ≈0 at c=0'],
  ['C02', { c: 500 }, 'γ vs damping'],
  ['C03', { c: 2000 }, 'γ vs damping (canonical)'],
  ['C04', { c: 5000 }, 'γ vs damping (max)'],
  ['C05', { c: 2000, wheelKg: 8 }, 'γ vs unsprung mass'],
  ['C06', { c: 2000, wheelKg: 32 }, 'γ vs unsprung mass (heavy ⇒ honest)'],
  ['C07', { chassisKg: 50, c: 2000 }, 'light chassis'],
  ['C08', { chassisKg: 200, c: 2000 }, 'bottoms out (legal poor phenotype)'],
  ['C09', { chassisKg: 500, c: 2000 }, 'heavy: bottoms, finite'],
  ['C10', { c: 2000, extraIters: 0 }, 'WITHOUT the chassis solver-iteration policy'],
  ['C11', { k: 2000, c: 0 }, 'min-k: honest overload → stop'],
  ['C12', { chassisKg: 5, c: 0 }, 'ω·dt≈3.3 stability corner (tiny sprung mass)'],
  ['C13', { c: 2000, rot: YAW_90 }, 'yaw-90: in-chain frame invariance'],
  ['C14', { travel: 0, target: 0.05 }, 'zero travel in-chain: rigid ride'],
  ['C15', { target: 0.5, travel: 0.2 }, 'preload in-chain: rides pinned'],
  ['C16', { c: 2000, torque: 125 }, 'driven: healthy ride'],
  ['C17', { chassisKg: 500, c: 2000, torque: 250 }, 'driven while bottomed (recorded)'],
  ['C18', { chassisKg: 200, k: 25000, c: 1000, axleX: [-0.6, 0.6], torque: 60 }, '4-wheel island health'],
  ['C19', { c: 1000, mixedRadii: [0.2, 0.3], axleX: [-0.6, 0.6], torque: 60 }, 'mixed radii, shared target (G11 record)'],
  ['C20', { target: 0, c: 0 }, 'stop-seated: in-chain stop leak at 1 kN/wheel'],
];

console.log('# S1 calibration matrix — rapier 0.19.3, gravity 20, dt 1/60');
console.log('');
console.log('## Bench rows (isolated rig: fixed base, hanging hub, limits [0,0.4] unless noted)');
console.log('');
console.log('| id | flavor | model | k | c | target | m kg | q_end | trough | peak | finite | note |');
console.log('|----|--------|-------|---|---|--------|------|-------|--------|------|--------|------|');
for (const deterministic of [false, true]) {
  for (const [id, cfg, note] of BENCH_ROWS) {
    const r = await bench(deterministic, cfg);
    console.log(`| ${id} | ${deterministic ? 'det' : 'dflt'} | ${cfg.model === 'AccelerationBased' ? 'AB' : cfg.target === null ? '—' : 'FB'} | ${cfg.k} | ${cfg.c} | ${cfg.target} | ${cfg.m} | ${f(r.q, 5)} | ${f(r.trough, 5)} | ${f(r.peak, 5)} | ${r.finite} | ${note} |`);
  }
}
console.log('');
console.log('## Chain rows (chassis→prismatic→hub→revolute→wheel on flat floor; defaults: 100 kg chassis, 2 kg wheels, k 50000, target 0.2, travel 0.4, one axle = 2 wheels, extraIters 4)');
console.log('');
console.log('| id | flavor | Mchassis | Mwheel | k | c | target | travel | q (per wheel) | kEff N/m | dx | maxTwistZ | maxSwingXY | finite | note |');
console.log('|----|--------|----------|--------|---|---|--------|--------|---------------|----------|----|-----------|------------|--------|------|');
for (const deterministic of [false, true]) {
  for (const [id, cfg, note] of CHAIN_ROWS) {
    const r = await chain(deterministic, cfg);
    const cells = [
      id, deterministic ? 'det' : 'dflt',
      cfg.chassisKg ?? 100, cfg.wheelKg ?? 2, cfg.k ?? 50000, cfg.c ?? 2000,
      cfg.target ?? 0.2, cfg.travel ?? 0.4,
      r.qs.map((q) => f(q, 4)).join(' '),
      r.kEff === null ? '—' : f(r.kEff, 0),
      r.dx === undefined ? '—' : f(r.dx, 2),
      r.maxTwistZ === undefined ? '—' : f(r.maxTwistZ, 3),
      r.maxSwingXY === undefined ? '—' : f(r.maxSwingXY, 3),
      r.finite, note,
    ];
    console.log(`| ${cells.join(' | ')} |`);
  }
}
console.log('');
console.log('Legend: q = projected prismatic coordinate (0 = full compression, positive =');
console.log('extension); kEff = per-wheel chassis load / (target − mean q), the in-chain');
console.log('effective static stiffness (— when bottomed/at-target); dx = forward travel');
console.log('over 600 driven steps; twist/swing = max hub rotation vs chassis about the');
console.log('axle axis / off-axis. The version decision applies the rubric in the header.');
