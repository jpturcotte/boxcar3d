// realizeVehicle's creation-time contract — the S1 kernel gate (s0-kernel's
// sibling; creation-time ONLY, no stepping — dynamics live in s1-sag/s1-drive).
//
// What this file locks, BOTH flavors:
//   * the pure S1 helpers against the independent rotation oracle
//     (tests/rotate-oracle.js — a different quaternion formula, never the
//     production expansion) and against s0WheelTransforms (S0 stations of
//     vehicleWheelTransforms are EXACTLY the S0 kernel's numbers);
//   * exact body/collider/joint counts: all-S0 through realizeVehicle is
//     UNCHANGED from the S0 kernel; each S1 wheel adds exactly +1 hub body,
//     +1 hub collider (the creation-time-readback policy cylinder), and
//     +1 prismatic joint;
//   * groups (HUB_GROUPS touches nothing), dual CCD on hubs AND wheels,
//     solver iterations chassis-only, joint anchors/axes via the oracle,
//     limits readbacks, the quiescent-spawn coordinate (incl. the preload
//     case pinned at the travel stop), hub mass/inertia readbacks vs the
//     STORED compiler records;
//   * vehicle-level covariance at roll-180 (the suspension axis REVERSES in
//     world space — vehicle-local by ruling) plus the direct world-vertical
//     negative;
//   * dispatch gates: all-S0 / all-S1 / mixed both orderings / sled / zero
//     driven / single centerline S1 / asymmetric pair / max topology (25
//     bodies, 24 joints) / S2 + unknown types rejected pre-world /
//     realizeS0Vehicle still rejects S1 AND S2;
//   * tamper + API-drift negatives, all pre-world, counts unchanged;
//   * transactional cleanup at EVERY stage — world-method traps (the
//     s0-kernel Proxy pattern) PLUS joint-configuration-stage traps (the
//     trapped createImpulseJoint returns a proxied joint whose named method
//     throws pre-delegation) — valid because production ledgers every joint
//     BEFORE configuring it.
//
// Tolerances: pure-JS helper math 1e-12-scale; world pose readbacks are f32,
// so bands scale with the WORLD-ANCHOR magnitudes entering a subtraction
// (f32Tol below) — the S0 yaw-90 lesson: a 0.2 m coordinate derived near
// world x = −45 carries x-scale noise, not 0.2-scale noise.

import { describe, test, expect } from 'vitest';
import {
  ADDITIONAL_SOLVER_ITERATIONS,
  HUB_GROUPS,
  WHEEL_GROUPS,
  SUSPENSION_AXIS,
  S0_MOTOR_MODEL_NAME,
  S1_SPRING_MOTOR_MODEL_NAME,
  createPhysics,
  projectedPrismaticCoordinate,
  realizeS0Vehicle,
  realizeVehicle,
  s0WheelTransforms,
  s1SpawnCoordinate,
  s1WheelTransformAt,
  suspensionAnchorLocal,
  vehicleWheelTransforms,
  vehicleWorldAxes,
} from '../src/sim/physics/adapter.js';
import { compileAssembly, repairGenotype } from '../src/sim/assembly.js';
import { rotateVector } from './rotate-oracle.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const SQ = Math.sqrt(0.5);
const YAW_90 = { x: 0, y: SQ, z: 0, w: SQ };
const ROLL_180 = { x: 1, y: 0, z: 0, w: 0 };
const f32Tol = (m) => 1e-6 * Math.max(1, Math.abs(m));
const counts = (world) => [world.bodies.len(), world.colliders.len(), world.impulseJoints.len()];
const rotate = rotateVector;
const poseOf = (body) => ({ position: body.translation(), rotation: body.rotation() });
const ORIGIN = { x: 0, y: 0, z: 0 };

// The canonical fixture family (the s0-kernel/s0-drive shape): spine frame,
// two paired axles at posX01 0.2/0.8 (one axle → centered 0.5). suspType
// genes per axle: 0 → S0, 0.5 → S1, 0.9 → S2. All-0.5 suspension genes
// decode to stiffness 26000 N/m, damping 2500 N·s/m, travel 0.2 m,
// restLength 0.275 m — NOTE restLength > travel: the canonical S1 fixture is
// a PRELOAD phenotype whose quiescent spawn coordinate is the travel stop
// (0.2), a deliberate exercise of the spawn ruling.
function canonicalGenotype(suspTypes = [0.5, 0.5], patch = null) {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const positions = suspTypes.length === 1 ? [0.5] : suspTypes.length === 2 ? [0.2, 0.8] : [0.2, 0.5, 0.8];
  const axle = (posX01, suspType) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  const g = {
    version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, node),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: suspTypes.map((t, i) => axle(positions[i], t)),
  };
  if (patch) patch(g);
  return g;
}

// The max legal topology: 6 paired S1 axles = 12 hubs + 12 wheels + chassis
// = 25 bodies, 24 joints on one island (the R1-recipe spacing so no repair
// rule bites: 6 max-gap nodes span 5 m; radius gene 0.44 → r 0.42 keeps the
// 0.18 posX01 spacing legal AND clears R2 on the 0.32 m-half-height frame;
// frameDensity 0.15 keeps the BIG max-gap frame under the 500 kg R6 cap —
// gene 0.3 would be clamped to ~0.158).
function maxS1Genotype() {
  return canonicalGenotype([0.5, 0.5], (g) => {
    g.frameDensity = 0.15;
    const seg = g.frame.segments[0];
    seg.nodeCount = 1;
    seg.nodes.forEach((n) => { n.gap = 1; });
    const base = g.axles[0];
    g.axles = [0, 0.18, 0.36, 0.54, 0.72, 0.9].map((p) => ({
      ...base, radius: 0.44, posX01: p, asym: { ...base.asym },
    }));
  });
}

const canonicalIR = (suspTypes, patch) => compileAssembly(canonicalGenotype(suspTypes, patch));

// --- Pure helpers vs the oracle (flavor-independent, outside describe.each) --

test('every declared fixture is repair-stable: the genes ARE the phenotype', () => {
  for (const g of [
    canonicalGenotype(),
    canonicalGenotype([0, 0]),
    canonicalGenotype([0, 0.5]),
    canonicalGenotype([0.5, 0]),
    canonicalGenotype([0.5], (gg) => { gg.axles[0].paired = 0; }),
    canonicalGenotype([0.5, 0.5], (gg) => { gg.symmetric = 0.1; gg.axles[0].asym.sizeBias = 0.65; }),
    maxS1Genotype(),
  ]) {
    expect(repairGenotype(g)).toEqual(g);
  }
});

test('suspensionAnchorLocal / s1SpawnCoordinate: the coordinate contract in pure form', () => {
  const ir = canonicalIR();
  const axle = ir.axles[0];
  const wheel = axle.wheels[0];
  expect(suspensionAnchorLocal(axle, wheel)).toEqual({ x: axle.posX, y: 0, z: wheel.z });
  // The canonical suspension block is a preload phenotype: rest 0.275 beyond
  // travel 0.2 → quiescent spawn AT the extension stop.
  expect(axle.suspension.restLength).toBeCloseTo(0.275, 12);
  expect(axle.suspension.travel).toBeCloseTo(0.2, 12);
  expect(s1SpawnCoordinate(axle.suspension)).toBeCloseTo(0.2, 12);
  // In-band rest spawns AT the natural length; degenerate inputs clamp.
  expect(s1SpawnCoordinate({ restLength: 0.14, travel: 0.2 })).toBeCloseTo(0.14, 12);
  expect(s1SpawnCoordinate({ restLength: -1, travel: 0.2 })).toBe(0);
  expect(s1SpawnCoordinate({ restLength: 0.5, travel: 0 })).toBe(0); // zero travel = locked
});

test('vehicleWheelTransforms: S0 stations are EXACTLY s0WheelTransforms; S1 stations drop by the quiescent coordinate along the rotated axis', () => {
  const spawn = { position: { x: -45, y: 2, z: 1 }, rotation: YAW_90 };
  const s0ir = canonicalIR([0, 0]);
  const legacy = s0WheelTransforms(s0ir, spawn);
  vehicleWheelTransforms(s0ir, spawn).forEach((p, k) => {
    expect(p.suspensionType).toBe('S0');
    expect(p.spawnCoordinate).toBeNull();
    expect(p.local).toEqual(legacy[k].local); // exact — same expression
    expect(p.world).toEqual(legacy[k].world);
  });
  const s1ir = canonicalIR();
  vehicleWheelTransforms(s1ir, spawn).forEach((p) => {
    const axle = s1ir.axles[p.axleIndex];
    const wheel = axle.wheels[p.wheelIndex];
    expect(p.suspensionType).toBe('S1');
    expect(p.spawnCoordinate).toBeCloseTo(0.2, 12);
    expect(p.anchorLocal).toEqual(suspensionAnchorLocal(axle, wheel));
    // Oracle cross-check (different rotation formula): world = position +
    // R·(anchor + coord·axis).
    const local = {
      x: p.anchorLocal.x + p.spawnCoordinate * SUSPENSION_AXIS.x,
      y: p.anchorLocal.y + p.spawnCoordinate * SUSPENSION_AXIS.y,
      z: p.anchorLocal.z + p.spawnCoordinate * SUSPENSION_AXIS.z,
    };
    const r = rotate(spawn.rotation, local);
    for (const [got, want] of [
      [p.world.x, spawn.position.x + r.x],
      [p.world.y, spawn.position.y + r.y],
      [p.world.z, spawn.position.z + r.z],
    ]) {
      expect(Math.abs(got - want)).toBeLessThan(1e-12 * Math.max(1, Math.abs(want)) * 100); // two exact formulas, fp-rounding apart
    }
    // And the single-station helper agrees exactly with the plan.
    const t = s1WheelTransformAt(axle, wheel, p.spawnCoordinate, spawn);
    expect(t.world).toEqual(p.world);
    expect(t.local).toEqual(p.local);
  });
});

test('vehicleWorldAxes: the vehicle-local ruling in pure form — roll-180 REVERSES the suspension axis', () => {
  const id = vehicleWorldAxes(IDENTITY);
  expect(id.suspension).toEqual({ x: 0, y: -1, z: 0 });
  expect(id.hinge).toEqual({ x: 0, y: 0, z: 1 });
  const rolled = vehicleWorldAxes(ROLL_180);
  expect(Math.abs(rolled.suspension.y - 1)).toBeLessThan(1e-12); // world UP
  expect(Math.abs(rolled.hinge.z + 1)).toBeLessThan(1e-12); //     hinge flips too
  // Oracle agreement at an arbitrary rotation.
  const q = YAW_90;
  const viaOracle = rotate(q, SUSPENSION_AXIS);
  const viaHelper = vehicleWorldAxes(q).suspension;
  for (const k of ['x', 'y', 'z']) expect(Math.abs(viaHelper[k] - viaOracle[k])).toBeLessThan(1e-12);
});

test('projectedPrismaticCoordinate: recovers a synthetic coordinate through arbitrary poses (oracle-built)', () => {
  const anchor1 = { x: 0.7, y: 0.1, z: -0.4 };
  const q = YAW_90;
  const chassisPose = { position: { x: -45, y: 2, z: 1 }, rotation: q };
  for (const coord of [0, 0.05, 0.2, 0.4]) {
    // Build the hub pose the way the engine would place it, via the ORACLE.
    const local = { x: anchor1.x, y: anchor1.y - coord, z: anchor1.z };
    const r = rotate(q, local);
    const hubPose = {
      position: { x: chassisPose.position.x + r.x, y: chassisPose.position.y + r.y, z: chassisPose.position.z + r.z },
      rotation: q,
    };
    const got = projectedPrismaticCoordinate(chassisPose, hubPose, anchor1, ORIGIN, SUSPENSION_AXIS);
    expect(Math.abs(got - coord)).toBeLessThan(1e-12 * 45 * 100); // pure f64, world-anchor-scaled rounding
  }
});

// --- Creation-time contracts, both flavors ----------------------------------

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('S1 kernel creation-time contract (deterministic=%s, %s)', (deterministic) => {
  test('the full all-S1 creation contract: counts, groups, CCD, solver policy, anchors, limits, quiescent spawn, hub readbacks', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const ir = canonicalIR();
      const N = ir.chassis.colliders.length;
      const before = counts(world);
      const spawn = { position: { x: 0, y: 2, z: 0 } };
      const rec = realizeVehicle(RAPIER, world, ir, spawn);
      // Counts: chassis + 4 hubs + 4 wheels; N + 4 hub + 4 wheel colliders;
      // 4 prismatics + 4 revolutes.
      expect(counts(world)).toEqual([before[0] + 9, before[1] + N + 8, before[2] + 8]);
      expect(rec.wheels).toHaveLength(4);
      expect(rec.chassis.body.additionalSolverIterations()).toBe(ADDITIONAL_SOLVER_ITERATIONS);
      const placements = vehicleWheelTransforms(ir, { position: spawn.position });
      rec.wheels.forEach((st, k) => {
        const irWheel = ir.axles[st.axleIndex].wheels[st.wheelIndex];
        expect(st.suspensionType).toBe('S1');
        expect(st.irWheel).toBe(irWheel); // reference identity, not a copy
        expect(st.hub.record).toBe(irWheel.hub); // the STORED compiler record
        // Groups: hub touches NOTHING; wheel is WHEEL_GROUPS.
        expect(st.hub.collider.collisionGroups()).toBe(HUB_GROUPS);
        expect(st.wheel.collider.collisionGroups()).toBe(WHEEL_GROUPS);
        // Dual CCD on hubs AND wheels; solver iterations stay chassis-only.
        for (const body of [st.hub.body, st.wheel.body]) {
          expect(body.isCcdEnabled()).toBe(true);
          expect(body.softCcdPrediction()).toBe(1);
          expect(body.additionalSolverIterations()).toBe(0);
        }
        // Hub + wheel spawn COINCIDENT at the quiescent placement, base
        // rotation = chassis rotation.
        const p = placements[k];
        for (const body of [st.hub.body, st.wheel.body]) {
          const t = body.translation();
          expect(Math.abs(t.x - p.world.x)).toBeLessThan(f32Tol(p.world.x));
          expect(Math.abs(t.y - p.world.y)).toBeLessThan(f32Tol(p.world.y));
          expect(Math.abs(t.z - p.world.z)).toBeLessThan(f32Tol(p.world.z));
          const q = body.rotation();
          expect(Math.abs(q.w - 1)).toBeLessThan(1e-6);
        }
        // Hub mass/inertia readback vs the STORED record (the collider
        // exists exactly for this): mass 1e-3 relative; principal inertia as
        // a SORTED set (Rapier reports principal values in the principal
        // frame's ordering — the rotated cylinder's axial value lands on the
        // y slot, measured).
        const hm = st.hub.body.mass();
        expect(Math.abs(hm - st.hub.record.mass)).toBeLessThan(1e-3 * Math.max(1, st.hub.record.mass));
        const inv = st.hub.body.invPrincipalInertia();
        const got = [inv.x, inv.y, inv.z].map((v) => 1 / v).sort((a, b) => a - b);
        const want = [
          st.hub.record.principalInertia.x,
          st.hub.record.principalInertia.y,
          st.hub.record.principalInertia.z,
        ].sort((a, b) => a - b);
        got.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThan(1e-3 * Math.max(1e-3, want[i])));
        // Prismatic anchors: chassis side = the full-compression anchor,
        // hub side = origin. Limits [0, travel] (f32-quantized readback).
        const a1 = st.suspensionJoint.anchor1();
        for (const k2 of ['x', 'y', 'z']) {
          expect(Math.abs(a1[k2] - p.anchorLocal[k2])).toBeLessThan(f32Tol(p.anchorLocal[k2]));
          expect(Math.abs(st.suspensionJoint.anchor2()[k2])).toBeLessThan(1e-6);
        }
        expect(st.suspensionJoint.limitsEnabled()).toBe(true);
        expect(st.suspensionJoint.limitsMin()).toBe(0);
        expect(Math.abs(st.suspensionJoint.limitsMax() - ir.axles[st.axleIndex].suspension.travel)).toBeLessThan(1e-6);
        // Drive revolute: origin-origin on hub/wheel.
        for (const k2 of ['x', 'y', 'z']) {
          expect(Math.abs(st.driveJoint.anchor1()[k2])).toBeLessThan(1e-6);
          expect(Math.abs(st.driveJoint.anchor2()[k2])).toBeLessThan(1e-6);
        }
        // The projected coordinate at creation IS the quiescent spawn
        // coordinate (the canonical preload fixture: the travel stop, 0.2).
        const coord = projectedPrismaticCoordinate(
          poseOf(rec.chassis.body), poseOf(st.hub.body), p.anchorLocal, ORIGIN, SUSPENSION_AXIS
        );
        expect(Math.abs(coord - p.spawnCoordinate)).toBeLessThan(1e-5); // measured ~1e-7 at |pos| ≈ 2
      });
      // REALIZED mass block: readbacks, hubs > 0, total = sum.
      expect(rec.mass.hubs).toBeGreaterThan(0);
      expect(Math.abs(rec.mass.hubs - 4 * ir.axles[0].wheels[0].hub.mass)).toBeLessThan(1e-2);
      expect(rec.mass.total).toBe(rec.mass.chassis + rec.mass.wheels + rec.mass.hubs);
    } finally {
      world.free();
    }
  });

  test('yaw-90 far spawn: anchors coincide and the coordinate reads back within WORLD-ANCHOR-scaled f32 bands', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const ir = canonicalIR();
      const spawn = { position: { x: -45, y: 2, z: 1 }, rotation: YAW_90 };
      const rec = realizeVehicle(RAPIER, world, ir, spawn);
      const band = 8 * f32Tol(45); // world coordinates at |x| ≈ 45; one f32 ULP there ≈ 3.8e-6
      for (const st of rec.wheels) {
        const p = vehicleWheelTransforms(ir, spawn)[rec.wheels.indexOf(st)];
        const coord = projectedPrismaticCoordinate(
          poseOf(rec.chassis.body), poseOf(st.hub.body), p.anchorLocal, ORIGIN, SUSPENSION_AXIS
        );
        expect(Math.abs(coord - p.spawnCoordinate)).toBeLessThan(band);
        // Perpendicular anchor error (prismatic axis coincidence): the
        // separation minus its axis projection.
        const cp = rec.chassis.body.translation();
        const cr = rec.chassis.body.rotation();
        const aw = rotate(cr, p.anchorLocal);
        const hp = st.hub.body.translation();
        const d = { x: hp.x - (cp.x + aw.x), y: hp.y - (cp.y + aw.y), z: hp.z - (cp.z + aw.z) };
        const ax = rotate(cr, SUSPENSION_AXIS);
        const along = d.x * ax.x + d.y * ax.y + d.z * ax.z;
        const perp = Math.sqrt(
          (d.x - along * ax.x) ** 2 + (d.y - along * ax.y) ** 2 + (d.z - along * ax.z) ** 2
        );
        expect(perp).toBeLessThan(band);
      }
    } finally {
      world.free();
    }
  });

  test('roll-180 covariance at creation: the hub sits ABOVE its anchor; a world-vertical substitution would be ~2×coordinate away', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const ir = canonicalIR();
      const spawn = { position: { x: 0, y: 5, z: 0 }, rotation: ROLL_180 };
      const rec = realizeVehicle(RAPIER, world, ir, spawn);
      const placements = vehicleWheelTransforms(ir, spawn);
      rec.wheels.forEach((st, k) => {
        const p = placements[k];
        const hp = st.hub.body.translation();
        // Covariant placement (the oracle): position + R·(anchor + coord·axis).
        const local = { x: p.anchorLocal.x, y: p.anchorLocal.y - p.spawnCoordinate, z: p.anchorLocal.z };
        const r = rotate(ROLL_180, local);
        expect(Math.abs(hp.x - (spawn.position.x + r.x))).toBeLessThan(1e-5);
        expect(Math.abs(hp.y - (spawn.position.y + r.y))).toBeLessThan(1e-5);
        expect(Math.abs(hp.z - (spawn.position.z + r.z))).toBeLessThan(1e-5);
        // The DIRECT NEGATIVE: world-vertical placement would put the hub
        // BELOW the anchor; rolled reality puts it ABOVE by the coordinate.
        const anchorWorld = rotate(ROLL_180, p.anchorLocal);
        expect(hp.y).toBeGreaterThan(spawn.position.y + anchorWorld.y + p.spawnCoordinate - 1e-3);
        const wrongY = spawn.position.y + anchorWorld.y - p.spawnCoordinate;
        expect(Math.abs(hp.y - wrongY)).toBeGreaterThan(2 * p.spawnCoordinate - 1e-3); // measured exactly 2×0.2
      });
    } finally {
      world.free();
    }
  });

  test('dispatch counts: all-S0 UNCHANGED from the S0 kernel; each S1 wheel adds exactly +1 body, +1 collider, +1 joint; mixed both orderings', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const N = canonicalIR([0, 0]).chassis.colliders.length;
      const cases = [
        [canonicalIR([0, 0]), 1 + 4, N + 4, 4, 0], //          all-S0: the S0 kernel's exact counts
        [canonicalIR([0.5, 0.5]), 1 + 8, N + 8, 8, 4], //      all-S1
        [canonicalIR([0, 0.5]), 1 + 6, N + 6, 6, 2], //        mixed S0-then-S1
        [canonicalIR([0.5, 0]), 1 + 6, N + 6, 6, 2], //        mixed S1-then-S0
      ];
      for (const [ir, bodies, colliders, joints, hubCount] of cases) {
        const before = counts(world);
        const rec = realizeVehicle(RAPIER, world, ir, { position: { x: 0, y: 2, z: 0 } });
        expect(counts(world)).toEqual([before[0] + bodies, before[1] + colliders, before[2] + joints]);
        expect(rec.wheels.filter((st) => st.hub !== null)).toHaveLength(hubCount);
        expect(rec.wheels.filter((st) => st.suspensionJoint !== null)).toHaveLength(hubCount);
        // S0 stations expose their resources honestly as null.
        for (const st of rec.wheels) {
          if (st.suspensionType === 'S0') {
            expect(st.hub).toBeNull();
            expect(st.suspensionJoint).toBeNull();
          }
        }
        if (hubCount === 0) expect(rec.mass.hubs).toBe(0);
      }
      // …and the wrapper produces the SAME counts for all-S0 (shared path).
      const before = counts(world);
      realizeS0Vehicle(RAPIER, world, canonicalIR([0, 0]), { position: { x: 0, y: 2, z: 0 } });
      expect(counts(world)).toEqual([before[0] + 5, before[1] + N + 4, before[2] + 4]);
    } finally {
      world.free();
    }
  });

  test('dispatch gates: sled, zero driven, single centerline S1, asymmetric pair, max topology (25 bodies / 24 joints)', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      // Zero axles: the legal sled — chassis only, hubs 0.
      const sled = realizeVehicle(RAPIER, world, canonicalIR([0.5, 0.5], (g) => { g.axles = []; }), {});
      expect(sled.wheels).toEqual([]);
      expect(sled.mass.hubs).toBe(0);
      // Zero driven: free-rolling S1; targetAngvel 0 is accepted (nothing
      // consumes it) — the S0 semantics, unchanged.
      const undriven = realizeVehicle(
        RAPIER, world,
        canonicalIR([0.5, 0.5], (g) => { for (const a of g.axles) a.driven = 0; }),
        { position: { x: 0, y: 2, z: 0 }, targetAngvel: 0 }
      );
      expect(undriven.wheels).toHaveLength(4);
      // Single centerline S1 module: one wheel, one hub, symmetric snap puts
      // it at z = 0.
      const single = realizeVehicle(
        RAPIER, world,
        canonicalIR([0.5], (g) => { g.axles[0].paired = 0; }),
        { position: { x: 10, y: 2, z: 0 } }
      );
      expect(single.wheels).toHaveLength(1);
      expect(Math.abs(single.wheels[0].wheel.body.translation().z)).toBeLessThan(1e-6);
      expect(single.wheels[0].hub).not.toBeNull();
      // Asymmetric S1 pair: two DIFFERENT wheel masses ⇒ two different hub
      // records, each realized to ITS OWN policy mass.
      const asym = realizeVehicle(
        RAPIER, world,
        canonicalIR([0.5, 0.5], (g) => { g.symmetric = 0.1; g.axles[0].asym.sizeBias = 0.65; }),
        { position: { x: 20, y: 2, z: 0 } }
      );
      const [h0, h1] = asym.wheels.slice(0, 2).map((st) => st.hub);
      expect(h0.record.mass).not.toBe(h1.record.mass);
      for (const h of [h0, h1]) {
        expect(Math.abs(h.body.mass() - h.record.mass)).toBeLessThan(1e-3 * Math.max(1, h.record.mass));
      }
      // Max topology: 6 paired S1 axles = 25 bodies, 24 joints, one island.
      const before = counts(world);
      const maxIR = compileAssembly(maxS1Genotype());
      const maxRec = realizeVehicle(RAPIER, world, maxIR, { position: { x: -20, y: 2, z: 0 } });
      const NM = maxIR.chassis.colliders.length;
      expect(counts(world)).toEqual([before[0] + 25, before[1] + NM + 24, before[2] + 24]);
      expect(maxRec.wheels).toHaveLength(12);
    } finally {
      world.free();
    }
  });

  test('S2 and unknown types are rejected pre-world by realizeVehicle; realizeS0Vehicle still rejects S1 AND S2', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const before = counts(world);
      const s2 = canonicalIR([0.9, 0.9]);
      expect(() => realizeVehicle(RAPIER, world, s2, {})).toThrow(/S2 stays legal IR data until its realizer ships/);
      expect(counts(world)).toEqual(before);
      // Mixed with one S2 axle fails the same way (the gate is per-axle).
      const mixedS2 = canonicalIR([0.5, 0.9]);
      expect(() => realizeVehicle(RAPIER, world, mixedS2, {})).toThrow(/realizeVehicle dispatches S0 and S1 only/);
      expect(counts(world)).toEqual(before);
      // A hand-edited unknown type string is not an implicit S0.
      const weird = canonicalIR();
      weird.axles[0].suspension.type = 'S9';
      expect(() => realizeVehicle(RAPIER, world, weird, {})).toThrow(/dispatches S0 and S1 only/);
      expect(counts(world)).toEqual(before);
      // The wrapper keeps its historical S0-only contract verbatim.
      expect(() => realizeS0Vehicle(RAPIER, world, canonicalIR([0.5, 0.5]), {})).toThrow(/S0 kernel realizes only S0/);
      expect(() => realizeS0Vehicle(RAPIER, world, canonicalIR([0.9, 0.9]), {})).toThrow(/S0 kernel realizes only S0/);
      expect(counts(world)).toEqual(before);
    } finally {
      world.free();
    }
  });

  test('tamper negatives: edited hub records, missing records, edited hubsTotal, garbage spring params — all pre-world, counts unchanged', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const before = counts(world);
      const broken = (mutate) => {
        const ir = canonicalIR();
        mutate(ir);
        return ir;
      };
      expect(() => realizeVehicle(RAPIER, world, broken((ir) => { ir.axles[0].wheels[0].hub.mass *= 1.5; }), {}))
        .toThrow(/hub\.mass .* disagrees with the hub policy value/);
      expect(() => realizeVehicle(RAPIER, world, broken((ir) => { ir.axles[0].wheels[0].hub.principalInertia = { ...ir.axles[0].wheels[0].hub.principalInertia, z: 99 }; }), {}))
        .toThrow(/hub\.principalInertia\.z .* disagrees/);
      expect(() => realizeVehicle(RAPIER, world, broken((ir) => { ir.axles[1].wheels[1].hub = null; }), {}))
        .toThrow(/hub record is missing/);
      expect(() => realizeVehicle(RAPIER, world, broken((ir) => { ir.mass.hubsTotal += 1; }), {}))
        .toThrow(/hubsTotal .* disagrees with the stored hub records/);
      expect(() => realizeVehicle(RAPIER, world, broken((ir) => { ir.axles[0].suspension.stiffness = NaN; }), {}))
        .toThrow(/suspension\.stiffness must be a finite number >= 0/);
      expect(() => realizeVehicle(RAPIER, world, broken((ir) => { ir.axles[0].suspension.travel = -0.1; }), {}))
        .toThrow(/suspension\.travel must be a finite number >= 0/);
      expect(() => realizeVehicle(RAPIER, world, broken((ir) => { ir.axles[0].suspension.restLength = Infinity; }), {}))
        .toThrow(/suspension\.restLength must be a finite number >= 0/);
      // The hubless v1 IR shape can never slip through as v2.
      expect(() => realizeVehicle(RAPIER, world, broken((ir) => { ir.version = 1; }), {}))
        .toThrow(/malformed IR/);
      expect(counts(world)).toEqual(before); // zero side effects from any rejection
    } finally {
      world.free();
    }
  });

  test('motor-model names resolve symbolically off the injected RAPIER (both the drive and the S1 spring constant)', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      // The symbolic-enum pin (the s0-kernel:241 discipline, now covering the
      // S1 constant too): both names MUST resolve to numeric MotorModel
      // members. Today S1_SPRING_MOTOR_MODEL_NAME === S0_MOTOR_MODEL_NAME
      // ('ForceBased' — S1 wheel drive reuses the S0 motor), so the adapter's
      // unconditional drive-model resolution ALSO covers the spring model's
      // presence (defense in depth); this pin is what keeps that redundancy
      // honest and would make the adapter's separate spring guard load-bearing
      // the day the two constants diverge.
      expect(typeof RAPIER.MotorModel[S0_MOTOR_MODEL_NAME]).toBe('number');
      expect(typeof RAPIER.MotorModel[S1_SPRING_MOTOR_MODEL_NAME]).toBe('number');
    } finally {
      world.free();
    }
  });

  test('API-drift negatives: a Rapier build missing any piece of the S1 surface fails loud PRE-WORLD', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const ir = canonicalIR();
      const before = counts(world);
      // MotorModel missing ForceBased: the unconditional drive-model
      // resolution fails loud first (it resolves the SAME member the S1
      // spring motor uses, so this one throw covers both the drive and the
      // spring path while the two model-name constants are equal — NOT an
      // isolation of the S1-only branch, which is unreachable-by-design until
      // the constants diverge; the symbolic-pin test above is the real S1
      // spring-model coverage).
      const noForceBased = { ...RAPIER, MotorModel: { ForceBased: undefined, AccelerationBased: 0 } };
      expect(() => realizeVehicle(noForceBased, world, ir, {}))
        .toThrow(/MotorModel\.ForceBased is missing/);
      // The genuinely S1-ISOLATING surface drift (unreachable through the S0
      // path, so these throws are the S1 realizer's own): JointData.prismatic…
      const noPrismatic = { ...RAPIER, JointData: { revolute: RAPIER.JointData.revolute } };
      expect(() => realizeVehicle(noPrismatic, world, ir, {}))
        .toThrow(/JointData\.prismatic is missing/);
      // …and a PrismaticImpulseJoint prototype missing a required method.
      class Gutted {}
      Gutted.prototype.setLimits = () => {};
      Gutted.prototype.configureMotorModel = () => {};
      const noConfigure = { ...RAPIER, PrismaticImpulseJoint: Gutted };
      expect(() => realizeVehicle(noConfigure, world, ir, {}))
        .toThrow(/PrismaticImpulseJoint\.prototype\.configureMotorPosition is missing/);
      expect(counts(world)).toEqual(before);
    } finally {
      world.free();
    }
  });

  test('transactional cleanup: induced failures at EVERY construction stage leave all three counts unchanged', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      // The s0-kernel trapWorld: throw BEFORE delegating on the Nth call of
      // one world method (a post-delegation throw would create an object the
      // realizer never got a handle to).
      const trapWorld = (method, failOn) => {
        let calls = 0;
        return new Proxy(world, {
          get(target, key) {
            const v = target[key];
            if (key === method) {
              return (...args) => {
                calls += 1;
                if (calls === failOn) throw new Error(`induced ${method} #${failOn}`);
                return v.apply(target, args);
              };
            }
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      };
      const s1ir = canonicalIR();
      const mixedIR = canonicalIR([0, 0.5]);
      const N = s1ir.chassis.colliders.length;
      const before = counts(world);
      // All-S1 world-call ordinals — createRigidBody: 1 chassis, 2 hub1,
      // 3 wheel1, 4 hub2…; createCollider: N chassis, N+1 hub1, N+2 wheel1…;
      // createImpulseJoint: 1 prismatic1, 2 revolute1, 3 prismatic2…
      for (const [method, failOn] of [
        ['createRigidBody', 2], //     first hub (chassis-only rollback)
        ['createRigidBody', 3], //     first wheel (hub + prismatic alive)
        ['createRigidBody', 4], //     second hub (a full station alive — the maximal unwind)
        ['createCollider', N + 1], //  first hub collider (hub body tracked, no joint yet)
        ['createCollider', N + 2], //  first wheel collider
        ['createImpulseJoint', 1], //  first prismatic
        ['createImpulseJoint', 2], //  first drive revolute (prismatic + hub + wheel alive)
      ]) {
        expect(() => realizeVehicle(RAPIER, trapWorld(method, failOn), s1ir, {}))
          .toThrow(new RegExp(`induced ${method} #${failOn}`));
        expect(counts(world)).toEqual(before);
      }
      // Mixed vehicle, failing AFTER both topology types exist: joints run
      // 1 rev(S0), 2 rev(S0), 3 prismatic(S1), 4 rev(S1) — kill #4.
      expect(() => realizeVehicle(RAPIER, trapWorld('createImpulseJoint', 4), mixedIR, {}))
        .toThrow(/induced createImpulseJoint #4/);
      expect(counts(world)).toEqual(before);
      // And a later hub in the mixed vehicle (createRigidBody: 1 chassis,
      // 2-3 S0 wheels, 4 hub1, 5 wheel, 6 hub2).
      expect(() => realizeVehicle(RAPIER, trapWorld('createRigidBody', 6), mixedIR, {}))
        .toThrow(/induced createRigidBody #6/);
      expect(counts(world)).toEqual(before);

      // JOINT-CONFIGURATION stages: the trapped createImpulseJoint returns a
      // proxied joint whose named method throws PRE-delegation on its Nth
      // call across all joints — valid because production ledgers every
      // joint BEFORE configuring it, so the unwind must still see it.
      const trapJointMethod = (method, failOn) => {
        let calls = 0;
        return new Proxy(world, {
          get(target, key) {
            const v = target[key];
            if (key === 'createImpulseJoint') {
              return (...args) => {
                const joint = v.apply(target, args);
                return new Proxy(joint, {
                  get(jt, jk) {
                    const jv = jt[jk];
                    if (jk === method) {
                      return (...jargs) => {
                        calls += 1;
                        if (calls === failOn) throw new Error(`induced joint ${method} #${failOn}`);
                        return jv.apply(jt, jargs);
                      };
                    }
                    return typeof jv === 'function' ? jv.bind(jt) : jv;
                  },
                });
              };
            }
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      };
      // Call order per S1 station: prismatic.setLimits, prismatic.
      // configureMotorModel, prismatic.configureMotorPosition, then
      // revolute.configureMotorModel, revolute.configureMotorVelocity.
      for (const [method, failOn] of [
        ['setLimits', 1], //             first prismatic's stops
        ['configureMotorModel', 1], //   the first SPRING model call
        ['configureMotorModel', 2], //   the first DRIVE model call
        ['configureMotorPosition', 2], // the second station's spring target
        ['configureMotorVelocity', 1], // the first drive motor
      ]) {
        expect(() => realizeVehicle(RAPIER, trapJointMethod(method, failOn), s1ir, {}))
          .toThrow(new RegExp(`induced joint ${method} #${failOn}`));
        expect(counts(world)).toEqual(before);
      }
    } finally {
      world.free();
    }
  });

  test('no direct-force / impulse / angular-velocity / post-creation-pose shortcut: the realizer builds bodies and joints ONLY', async () => {
    // Requirement (5) made testable, not just asserted in comments: wrap the
    // world so every RigidBody it creates is a Proxy that THROWS if the
    // realizer calls any forbidden post-creation write — a body pose/velocity
    // is legal ONLY through the desc builder at creation, and all motion must
    // come from joint motors. Reads (.mass()/.invPrincipalInertia() the
    // readback guards need) pass through untouched.
    const FORBIDDEN = new Set([
      'setTranslation', 'setNextKinematicTranslation', 'setRotation', 'setNextKinematicRotation',
      'setLinvel', 'setAngvel', 'applyImpulse', 'applyTorqueImpulse', 'addForce', 'addTorque',
    ]);
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const trapWrites = new Proxy(world, {
        get(target, key) {
          const v = target[key];
          if (key === 'createRigidBody') {
            return (...args) => {
              const body = v.apply(target, args); // creation is legal
              return new Proxy(body, {
                get(b, bk) {
                  if (FORBIDDEN.has(bk)) {
                    return () => { throw new Error(`forbidden post-creation write: RigidBody.${String(bk)}`); };
                  }
                  const bv = b[bk];
                  return typeof bv === 'function' ? bv.bind(b) : bv;
                },
              });
            };
          }
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      // A mixed S0/S1 driven vehicle spawned WITH a linvel exercises every
      // construction path (hub bodies, wheel bodies, both joint types, drive
      // + spring motors, the shared spawn-linvel) — if any of them reached
      // for a post-creation pose/velocity/force write, this throws.
      const built = realizeVehicle(RAPIER, trapWrites, canonicalIR([0, 0.5]), { position: { x: 0, y: 2, z: 0 }, linvel: { x: 1, y: 0, z: 0 } });
      expect(built.wheels).toHaveLength(4);
      expect(built.wheels.some((st) => st.suspensionType === 'S1')).toBe(true);
    } finally {
      world.free();
    }
  });

  test('zero-travel and preload IRs realize at creation time with the ruled semantics', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      // Zero travel: setLimits(0, 0) — engine-safe (measured), locked.
      const lockedIR = canonicalIR([0.5, 0.5], (g) => { for (const a of g.axles) a.travel = 0; });
      const locked = realizeVehicle(RAPIER, world, lockedIR, { position: { x: 0, y: 2, z: 0 } });
      for (const st of locked.wheels) {
        expect(st.suspensionJoint.limitsMax()).toBe(0);
        const axle = lockedIR.axles[st.axleIndex];
        const coord = projectedPrismaticCoordinate(
          poseOf(locked.chassis.body), poseOf(st.hub.body),
          suspensionAnchorLocal(axle, st.irWheel), ORIGIN, SUSPENSION_AXIS
        );
        expect(Math.abs(coord)).toBeLessThan(1e-5); // spawned at the locked point
      }
      // The canonical preload fixture already spawned at its travel stop in
      // the contract test above; here the complementary in-band fixture
      // spawns at its natural length (restLength gene 0.2 → 0.14 < travel).
      const inBand = realizeVehicle(
        RAPIER, world,
        canonicalIR([0.5, 0.5], (g) => { for (const a of g.axles) a.restLength = 0.2; }),
        { position: { x: 10, y: 2, z: 0 } }
      );
      const ir = compileAssembly(canonicalGenotype([0.5, 0.5], (g) => { for (const a of g.axles) a.restLength = 0.2; }));
      const rest = ir.axles[0].suspension.restLength;
      expect(rest).toBeLessThan(ir.axles[0].suspension.travel);
      for (const st of inBand.wheels) {
        const axle = ir.axles[st.axleIndex];
        const coord = projectedPrismaticCoordinate(
          poseOf(inBand.chassis.body), poseOf(st.hub.body),
          suspensionAnchorLocal(axle, st.irWheel), ORIGIN, SUSPENSION_AXIS
        );
        expect(Math.abs(coord - rest)).toBeLessThan(2e-5);
      }
    } finally {
      world.free();
    }
  });
});
