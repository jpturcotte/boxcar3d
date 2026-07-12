// The S1 rough-strip comparative witness + the unconventional-morphology and
// findings-ledger gates. BOTH flavors via describe.each × createPhysics;
// exactness only ever per flavor (F10).
//
// WITNESS TERRAIN (declared; touches NO locked fingerprint): seed 20260714,
//   { startFlatLength: 20, startBlendLength: 6, craterDensity: 0,
//     featureDensity: 0, sandCoverage: 0, mudCoverage: 0 }
// — the pad spans x ∈ [−60, −40], the blend ends at −34, and the DEFAULT
// macro/micro fBm amplitudes ARE the rough strip (±0.2 m micro at ~3 m
// wavelength is wheel-scale forcing for a 0.3 m wheel; no invented terrain).
// The measured segment is chassis x ∈ [−30, +30]: entered only after the
// full terrain envelope, exited before the open east end (maxX guard 55).
//
// WITNESS FIXTURE (declared, repair-stable): spine frame with LOW nodes
// (height gene 0.1 → maxHalfHeight 0.18) carrying SMALL wheels (r 0.3 m —
// R2-legal only because the frame is low) so the fixed 500 N·m power budget
// yields thrust ≈ 1667 N against ≈ 1643 N of weight (thrust/weight ≈ 1.0):
// the seed's start-blend grade stalled a 29% thrust/weight build (the S0-era
// blend-stall finding, re-measured 2026-07-11), and a witness that cannot
// REACH the rough segment measures nothing. Suspension genes: k 4400 N/m,
// c 250 N·s/m, travel 0.4 m, rest 0.23 m → static coordinate ≈ 0.18,
// margins both ways.
//
// THE THREE-WAY COMPARISON (maintainer ruling): (a) the rigid S0 twin —
// same genotype, suspType 0; (b) the MASS-MATCHED S1 — the S1 fixture with
// its chassis density REDUCED by exactly the hub total (the gene is derived
// in-test from the IRs and asserted repair-stable; compiled AND realized
// totals must match); (c) the NATIVE-COST S1 — unmodified, hubs included
// (recorded). The asserted claim is a changed response in the intended
// suspension direction on THIS declared input plus a declared absolute
// forward-progress floor — deliberately NOT "S1 is at least as fast as S0".
//
// MEASURED (this worktree, Windows, 2026-07-11, BOTH flavors byte-identical
// at this seed; bands carry cross-platform margin; 1800-step cap with
// early exit past x = 34):
//             dx     RMS aᵧ  peak aᵧ  contact  q range          anchorErr
//   S0 twin   82.36  8.585   32.12    0.83     —                8.3e-3
//   S1 match  85.38  1.288    5.68    1.00     [0.113, 0.243]   1.2e-3
//   S1 native 85.03  1.172    4.97    1.00     [0.101, 0.237]   1.5e-3
// (RMS/peak = mean-removed chassis acceleration projected on the chassis's
// CURRENT local up via the rotate-oracle, segment samples only; contact =
// fraction of sampled wheel-ground gaps < 0.03 m; limit contacts 0 for both
// S1 runs — the suspension worked mid-travel.) Realized totals: S0 82.1553,
// S1 matched 82.1553 (equal), S1 native 90.6376.
//
// G10/G11 MEASURED: roll-180 lands on its back at y 0.179, coordinates
// [0.118, 0.242] (the springs press the hubs toward the vehicle-local rest —
// world-UP when inverted), anchorErr 3.1e-4, dx −0.051; max topology (25
// bodies / 24 joints) drives +9.50 m in 900 steps, anchorErr 5.4e-4, minQ
// −0.0067 (stop leak); strange mixed asymmetric drives +26.41 m, |z| 0.10;
// solver-pump (undriven all-S1, flat cuboid, 900 steps): vx plateaus at
// −0.327 m/s — the S0 finding's ≈0.33 magnitude, UNCHANGED by S1 (recorded,
// not remediated); mixed radii under travel, RE-MEASURED under the
// per-wheel law: the corridor end state is a GRADE stall and stands
// unchanged (+11.64 m then vxEnd −0.099 at t/w 15.8% — stall thrust is
// driveTorque/r, law-invariant by design; the old record misattributed it
// to the target conflict), while the shared-target CONFLICT itself is
// CLOSED (same IR on flat ground: old-law cruise 4.43 m/s with small
// wheels dragged past the shared target vs per-wheel-law cruise 4.89 m/s
// with every wheel under its own target); R5-cap overlap with S1:
// +5.06 m, no detach, maxSpeed 2.90.
//
// PER-WHEEL SURFACE-SPEED PR NOTE (2026-07-11): the three-way witness and
// the max-topology case PIN their legacy operating points via explicit
// targetWheelSurfaceSpeed literals (3 m/s at r 0.3, 4.2 m/s at r 0.42 —
// both derive ω = EXACTLY the old shared −10 in f64, gains bit-equal), so
// their measured tables above stand verbatim; the remaining cases run the
// new default (5 m/s) and were re-measured where their numbers moved.

import { describe, test, expect } from 'vitest';
import {
  GROUND_GROUPS,
  SUSPENSION_AXIS,
  FIXED_DT,
  addCorridor,
  createPhysics,
  projectedPrismaticCoordinate,
  realizeVehicle,
  suspensionAnchorLocal,
} from '../src/sim/physics/adapter.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { GENE_RANGES, compileAssembly, repairGenotype } from '../src/sim/assembly.js';
import { rotateVector } from './rotate-oracle.js';

const WITNESS_SEED = 20260714; // declared; distinct from every other repo seed
const WITNESS_CONFIG = Object.freeze({
  seed: WITNESS_SEED,
  startFlatLength: 20,
  startBlendLength: 6,
  craterDensity: 0,
  featureDensity: 0,
  sandCoverage: 0,
  mudCoverage: 0,
});
// The MOTOR's OWN coordinate: a revolute motor drives the RELATIVE angular
// velocity between its bodies about the joint axis (the parent's local +Z),
// not the wheel body's world ω_z — the only honest observable for the
// driving/braking sign. Parent = the hub for S1 (its drive revolute is
// hub→wheel; the hub co-rotates with the chassis through the prismatic),
// the chassis for S0. World ω_z stays as a diagnostic. (Shared verbatim
// with tests/surface-speed-drive.test.js.)
function motorRelativeOmega(st, chassisBody) {
  const parent = st.suspensionType === 'S1' ? st.hub.body : chassisBody;
  const axis = rotate(parent.rotation(), { x: 0, y: 0, z: 1 });
  const w = st.wheel.body.angvel();
  const p = parent.angvel();
  return (w.x - p.x) * axis.x + (w.y - p.y) * axis.y + (w.z - p.z) * axis.z;
}

const SEG_MIN = -30;
const SEG_MAX = 30;
const SPAWN_X = -44; // on the pad
const STEP_CAP = 1800; // early exit once the chassis passes SEG_MAX + 4
const ANCHOR_BAND = 0.02; // m — measured max 8.3e-3 (the rigid S0 twin)
const ORIGIN = { x: 0, y: 0, z: 0 };
const ROLL_180 = { x: 1, y: 0, z: 0, w: 0 };
const poseOf = (b) => ({ position: b.translation(), rotation: b.rotation() });
const rotate = rotateVector;

const terrain = generateCorridorTerrain(WITNESS_CONFIG);

function witnessGenotype(patch = null) {
  const node = () => ({ gap: 0.5, height: 0.1, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01, over = {}) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.2, width: 0.5, density: 0,
    suspType: 0.5, stiffness: 0.05, damping: 0.05, travel: 1, restLength: 0.4,
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
    axles: [axle(0.2), axle(0.8)],
  };
  if (patch) patch(g, axle);
  return g;
}

// The mass-matched S1: chassis density reduced by exactly the hub total so
// the TOTAL equals the S0 twin's. Derived from the IRs (never hand-guessed):
// targetDensity = (chassisMass − hubsTotal) / chassisVolume, inverted
// through the frameDensity affine range.
function matchedGene(s1IR) {
  const volume = s1IR.mass.chassis / s1IR.chassis.density;
  const targetDensity = (s1IR.mass.chassis - s1IR.mass.hubsTotal) / volume;
  const [lo, hi] = GENE_RANGES.frameDensity;
  return (targetDensity - lo) / (hi - lo);
}

// Drive `ir` from the pad through the rough segment, collecting the witness
// metrics (probe-ported; every metric is declared in the header).
async function roughRun(deterministic, ir, { x = SPAWN_X } = {}) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    const { floor } = addCorridor(RAPIER, world, terrain);
    world.step(); // query BVH ([V1])
    const maxR = Math.max(...ir.axles.flatMap((a) => a.wheels).map((w) => w.radius));
    const s1axle = ir.axles.find((a) => a.suspension.type === 'S1');
    const coord0 = s1axle
      ? Math.max(0, Math.min(s1axle.suspension.restLength, s1axle.suspension.travel))
      : 0;
    // OPERATING-POINT PIN (per-wheel surface-speed PR): this witness's claims
    // are SUSPENSION effects, not drive-law effects, so it declares the
    // surface speed that reproduces the legacy operating point at its r 0.3
    // wheels — 3 m/s ⇒ ω = −3/0.3 rounds to EXACTLY the old shared −10 in
    // f64, gains bit-equal — keeping the whole measured header table valid
    // verbatim. The drive-law witnesses live in tests/surface-speed-drive.test.js.
    const rec = realizeVehicle(RAPIER, world, ir, {
      position: { x, y: maxR + coord0 + 0.02, z: 0 },
      targetWheelSurfaceSpeed: 3,
    });
    const stations = rec.wheels.map((st) => ({
      st,
      anchor: suspensionAnchorLocal(ir.axles[st.axleIndex], st.irWheel),
      travel: ir.axles[st.axleIndex].suspension.travel,
    }));
    let vPrev = rec.chassis.body.linvel();
    const accel = [];
    let minQ = Infinity;
    let maxQ = -Infinity;
    let limitSteps = 0;
    let segSteps = 0;
    let contactHits = 0;
    let contactChecks = 0;
    let maxAnchorErr = 0;
    let minBodyY = Infinity;
    let maxSpeed = 0;
    let maxX = -Infinity;
    for (let i = 1; i <= STEP_CAP; i++) {
      world.step();
      const cp = rec.chassis.body.translation();
      const cr = rec.chassis.body.rotation();
      const v = rec.chassis.body.linvel();
      maxX = Math.max(maxX, cp.x);
      const inSeg = cp.x >= SEG_MIN && cp.x <= SEG_MAX;
      if (inSeg) {
        // Chassis acceleration projected on the CURRENT local up — the
        // independent oracle does the rotation, never the production helper.
        const up = rotate(cr, { x: 0, y: 1, z: 0 });
        const a = {
          x: (v.x - vPrev.x) / FIXED_DT,
          y: (v.y - vPrev.y) / FIXED_DT,
          z: (v.z - vPrev.z) / FIXED_DT,
        };
        accel.push(a.x * up.x + a.y * up.y + a.z * up.z);
        segSteps += 1;
      }
      vPrev = { x: v.x, y: v.y, z: v.z };
      for (const s of stations) {
        if (s.st.suspensionType !== 'S1') continue;
        const q = projectedPrismaticCoordinate(poseOf(rec.chassis.body), poseOf(s.st.hub.body), s.anchor, ORIGIN, SUSPENSION_AXIS);
        if (q < minQ) minQ = q;
        if (q > maxQ) maxQ = q;
        if (inSeg && (q < 5e-3 || q > s.travel - 5e-3)) limitSteps += 1;
      }
      if (i % 10 === 0) {
        for (const s of stations) {
          const aw = rotate(cr, s.anchor);
          if (s.st.suspensionType === 'S1') {
            // Prismatic layer: perpendicular error only (the axis DOF is free)…
            const op = s.st.hub.body.translation();
            const d = { x: op.x - (cp.x + aw.x), y: op.y - (cp.y + aw.y), z: op.z - (cp.z + aw.z) };
            const ax = rotate(cr, SUSPENSION_AXIS);
            const along = d.x * ax.x + d.y * ax.y + d.z * ax.z;
            maxAnchorErr = Math.max(
              maxAnchorErr,
              Math.sqrt((d.x - along * ax.x) ** 2 + (d.y - along * ax.y) ** 2 + (d.z - along * ax.z) ** 2)
            );
            // …revolute layer: hub/wheel center coincidence.
            const wp = s.st.wheel.body.translation();
            maxAnchorErr = Math.max(maxAnchorErr, Math.sqrt((wp.x - op.x) ** 2 + (wp.y - op.y) ** 2 + (wp.z - op.z) ** 2));
            minBodyY = Math.min(minBodyY, op.y, wp.y);
          } else {
            const wp = s.st.wheel.body.translation();
            maxAnchorErr = Math.max(
              maxAnchorErr,
              Math.sqrt((cp.x + aw.x - wp.x) ** 2 + (cp.y + aw.y - wp.y) ** 2 + (cp.z + aw.z - wp.z) ** 2)
            );
            minBodyY = Math.min(minBodyY, wp.y);
          }
        }
        maxSpeed = Math.max(maxSpeed, Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z));
        if (inSeg) {
          // Wheel-ground contact continuity: floor-only downward rays.
          for (const s of stations) {
            const wp = s.st.wheel.body.translation();
            const ray = new RAPIER.Ray({ x: wp.x, y: wp.y + 5, z: wp.z }, { x: 0, y: -1, z: 0 });
            const hit = world.castRay(ray, 50, true, undefined, undefined, undefined, undefined, (c) => c.handle === floor.handle);
            if (hit !== null) {
              contactChecks += 1;
              const floorY = wp.y + 5 - hit.timeOfImpact;
              if (wp.y - s.st.irWheel.radius - floorY < 0.03) contactHits += 1;
            }
          }
        }
      }
      if (cp.x > SEG_MAX + 4) break; // metrics complete; the east end is open
    }
    const mean = accel.reduce((s, a) => s + a, 0) / Math.max(1, accel.length);
    const rms = Math.sqrt(accel.reduce((s, a) => s + (a - mean) * (a - mean), 0) / Math.max(1, accel.length));
    const peak = accel.reduce((m, a) => Math.max(m, Math.abs(a - mean)), 0);
    const p = rec.chassis.body.translation();
    return {
      seed: WITNESS_SEED,
      finite: [p.x, p.y, p.z].every(Number.isFinite),
      dx: p.x - x,
      segSteps,
      rms,
      peak,
      minQ: minQ === Infinity ? null : minQ,
      maxQ: maxQ === -Infinity ? null : maxQ,
      limitFrac: segSteps > 0 ? limitSteps / segSteps : 0,
      contactFrac: contactChecks > 0 ? contactHits / contactChecks : null,
      maxAnchorErr,
      minBodyY,
      maxSpeed,
      maxX,
      realizedTotal: rec.mass.total,
    };
  } finally {
    world.free();
  }
}

// A bounded generic run (pad or flat cuboid) for the G10/G11 cases.
async function boundedRun(deterministic, ir, { x = -50, y = null, rotation = null, steps = 600, flatCuboid = false, targetWheelSurfaceSpeed } = {}) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    if (flatCuboid) {
      world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 25).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUND_GROUPS));
    } else {
      addCorridor(RAPIER, world, terrain);
    }
    world.step();
    const maxR = Math.max(0.01, ...ir.axles.flatMap((a) => a.wheels).map((w) => w.radius));
    const s1axle = ir.axles.find((a) => a.suspension.type === 'S1');
    const coord0 = s1axle
      ? Math.max(0, Math.min(s1axle.suspension.restLength, s1axle.suspension.travel))
      : 0;
    const opts = { position: { x, y: y === null ? maxR + coord0 + 0.02 : y, z: 0 } };
    if (rotation) opts.rotation = rotation;
    if (targetWheelSurfaceSpeed !== undefined) opts.targetWheelSurfaceSpeed = targetWheelSurfaceSpeed;
    const rec = realizeVehicle(RAPIER, world, ir, opts);
    const stations = rec.wheels.map((st) => ({
      st,
      anchor: suspensionAnchorLocal(ir.axles[st.axleIndex], st.irWheel),
    }));
    let minQ = Infinity;
    let maxQ = -Infinity;
    let maxAnchorErr = 0;
    let maxSpeed = 0;
    let maxTwistZ = 0;
    let maxSwingXY = 0;
    for (let i = 1; i <= steps; i++) {
      world.step();
      const cp = rec.chassis.body.translation();
      const cr = rec.chassis.body.rotation();
      for (const s of stations) {
        if (s.st.suspensionType !== 'S1') continue;
        const q = projectedPrismaticCoordinate(poseOf(rec.chassis.body), poseOf(s.st.hub.body), s.anchor, ORIGIN, SUSPENSION_AXIS);
        if (q < minQ) minQ = q;
        if (q > maxQ) maxQ = q;
        // Hub rotation RELATIVE to the chassis, decomposed about the axle:
        // qRel = conj(qChassis) ⊗ qHub; twist = rotation about local z (the
        // free-spinning-looking but prismatic-LOCKED axle DOF — pure
        // constraint deflection, geometrically unobservable on the
        // axisymmetric hub), swing = the x/y part that would TILT the wheel
        // plane.
        const qh = s.st.hub.body.rotation();
        const rel = {
          x: cr.w * qh.x - cr.x * qh.w - (cr.y * qh.z - cr.z * qh.y),
          y: cr.w * qh.y - cr.y * qh.w - (cr.z * qh.x - cr.x * qh.z),
          z: cr.w * qh.z - cr.z * qh.w - (cr.x * qh.y - cr.y * qh.x),
          w: cr.w * qh.w + cr.x * qh.x + cr.y * qh.y + cr.z * qh.z,
        };
        const twist = Math.abs(2 * Math.atan2(rel.z, rel.w));
        const swing = 2 * Math.asin(Math.min(1, Math.sqrt(rel.x * rel.x + rel.y * rel.y)));
        if (twist > maxTwistZ) maxTwistZ = twist;
        if (swing > maxSwingXY) maxSwingXY = swing;
      }
      if (i % 10 === 0) {
        for (const s of stations) {
          if (s.st.suspensionType !== 'S1') continue;
          const aw = rotate(cr, s.anchor);
          const op = s.st.hub.body.translation();
          const d = { x: op.x - (cp.x + aw.x), y: op.y - (cp.y + aw.y), z: op.z - (cp.z + aw.z) };
          const ax = rotate(cr, SUSPENSION_AXIS);
          const along = d.x * ax.x + d.y * ax.y + d.z * ax.z;
          maxAnchorErr = Math.max(
            maxAnchorErr,
            Math.sqrt((d.x - along * ax.x) ** 2 + (d.y - along * ax.y) ** 2 + (d.z - along * ax.z) ** 2)
          );
          const wp = s.st.wheel.body.translation();
          maxAnchorErr = Math.max(maxAnchorErr, Math.sqrt((wp.x - op.x) ** 2 + (wp.y - op.y) ** 2 + (wp.z - op.z) ** 2));
        }
        const v = rec.chassis.body.linvel();
        maxSpeed = Math.max(maxSpeed, Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z));
      }
    }
    const p = rec.chassis.body.translation();
    return {
      finite: [p.x, p.y, p.z].every(Number.isFinite),
      x: p.x,
      y: p.y,
      z: p.z,
      dx: p.x - x,
      vxEnd: rec.chassis.body.linvel().x,
      minQ: minQ === Infinity ? null : minQ,
      maxQ: maxQ === -Infinity ? null : maxQ,
      maxAnchorErr,
      maxSpeed,
      maxTwistZ,
      maxSwingXY,
      wheelOmegaZ: rec.wheels.map((st) => st.wheel.body.angvel().z), // diagnostic (world component)
      wheelMotorOmega: rec.wheels.map((st) => motorRelativeOmega(st, rec.chassis.body)), // the motor's own coordinate
      jointsValid: rec.wheels.every((st) => st.driveJoint.isValid() && (st.suspensionJoint === null || st.suspensionJoint.isValid())),
      counts: [world.bodies.len(), world.impulseJoints.len()],
    };
  } finally {
    world.free();
  }
}

// --- Fixture proofs (pure, flavor-independent) -------------------------------

test('witness fixtures are repair-stable and the mass-matched S1 equals the S0 twin in CANONICAL total', () => {
  const g = witnessGenotype();
  expect(repairGenotype(g)).toEqual(g);
  const s0g = witnessGenotype((gg) => { for (const a of gg.axles) a.suspType = 0; });
  expect(repairGenotype(s0g)).toEqual(s0g);
  const s1IR = compileAssembly(g);
  const s0IR = compileAssembly(s0g);
  const gene = matchedGene(s1IR);
  const matchedG = witnessGenotype((gg) => { gg.frameDensity = gene; });
  expect(repairGenotype(matchedG)).toEqual(matchedG); // headroom held (gene ≈ 0.0367)
  const matchedIR = compileAssembly(matchedG);
  // The compiled canonical totals match to fp round-off — asserted, never
  // assumed (measured Δ < 1e-13 relative).
  expect(Math.abs(matchedIR.mass.total - s0IR.mass.total)).toBeLessThan(1e-9 * s0IR.mass.total);
  expect(s1IR.mass.total).toBeGreaterThan(s0IR.mass.total); // native carries the hub cost
});

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('S1 rough-strip witness (deterministic=%s, %s)', (deterministic) => {
  test('three-way comparison: the mass-matched S1 changes the ride in the intended direction while making useful forward progress', { timeout: 120000 }, async () => {
    const s1IR = compileAssembly(witnessGenotype());
    const s0IR = compileAssembly(witnessGenotype((gg) => { for (const a of gg.axles) a.suspType = 0; }));
    const matchedIR = compileAssembly(witnessGenotype((gg) => { gg.frameDensity = matchedGene(compileAssembly(witnessGenotype())); }));
    const s0 = await roughRun(deterministic, s0IR);
    const matched = await roughRun(deterministic, matchedIR);
    const native = await roughRun(deterministic, s1IR);
    const diag = JSON.stringify({ s0, matched, native });

    for (const run of [s0, matched, native]) {
      expect(run.finite, diag).toBe(true);
      expect(run.maxAnchorErr, diag).toBeLessThan(ANCHOR_BAND); // measured ≤ 8.3e-3
      expect(run.minBodyY, diag).toBeGreaterThan(-2); // nothing tunnels (measured 0.297)
      expect(run.maxSpeed, diag).toBeLessThan(6); // measured ≤ 3.3
      expect(run.maxX, diag).toBeLessThan(55); // the east end is open
      expect(run.segSteps, diag).toBeGreaterThan(600); // really crossed the segment (measured ≥ 1227)
      expect(run.contactFrac, diag).not.toBeNull();
      // USEFUL forward progress — a declared absolute floor (measured
      // 82–85 m), deliberately NOT a not-slower-than-S0 comparison.
      expect(run.dx, diag).toBeGreaterThan(40);
    }
    // Mass matching held through REALIZATION too (measured equal to f32).
    expect(Math.abs(matched.realizedTotal - s0.realizedTotal), diag).toBeLessThan(1e-3 * s0.realizedTotal);
    expect(native.realizedTotal, diag).toBeGreaterThan(s0.realizedTotal);
    // THE SUSPENSION EFFECT (mass-matched vs rigid, measured ratios 0.150 /
    // 0.177 — bands at 0.5/0.6 carry >3× cross-platform margin):
    expect(matched.rms, diag).toBeLessThan(0.5 * s0.rms);
    expect(matched.peak, diag).toBeLessThan(0.6 * s0.peak);
    // Contact continuity: measured 1.00 vs 0.83.
    expect(matched.contactFrac, diag).toBeGreaterThanOrEqual(0.95);
    expect(matched.contactFrac, diag).toBeGreaterThan(s0.contactFrac);
    // The suspension WORKED (real travel, no limit slamming): measured
    // q ∈ [0.113, 0.243] within [0, 0.4], limitFrac 0.
    expect(matched.minQ, diag).toBeGreaterThan(-0.02);
    expect(matched.maxQ, diag).toBeLessThan(0.42);
    expect(matched.maxQ - matched.minQ, diag).toBeGreaterThan(0.03); // it moved
    expect(matched.limitFrac, diag).toBeLessThan(0.2); // measured 0
    // Native-cost S1: the same direction of effect, RECORDED (its full
    // numbers live in the header table).
    expect(native.rms, diag).toBeLessThan(s0.rms);
  });

  test('a 180°-rolled S1 vehicle realizes, lands on its back, and stays finite with its suspension pressing vehicle-local (world-UP) toward rest', { timeout: 60000 }, async () => {
    const run = await boundedRun(deterministic, compileAssembly(witnessGenotype()), {
      x: -50, y: 1.5, rotation: ROLL_180, steps: 300,
    });
    const diag = JSON.stringify(run);
    expect(run.finite, diag).toBe(true);
    expect(run.jointsValid, diag).toBe(true);
    expect(run.maxAnchorErr, diag).toBeLessThan(ANCHOR_BAND); // measured 3.1e-4
    // Resting inverted ON the pad, essentially where it fell.
    expect(run.y, diag).toBeLessThan(1); // measured 0.179
    expect(Math.abs(run.dx), diag).toBeLessThan(2); // measured −0.051
    // The coordinates stay in-band: the springs hold the hubs toward the
    // vehicle-local rest — which is world-UP now (measured [0.118, 0.242]).
    expect(run.minQ, diag).toBeGreaterThan(-0.02);
    expect(run.maxQ, diag).toBeLessThan(0.42);
  });

  test('the maximum legal topology (6 paired S1 axles = 25 bodies, 24 joints) is stable under the EXISTING chassis solver-iteration policy', { timeout: 60000 }, async () => {
    const maxG = witnessGenotype((g, axle) => {
      g.frameDensity = 0.15;
      const seg = g.frame.segments[0];
      seg.nodeCount = 1;
      seg.nodes.forEach((n) => { n.gap = 1; n.height = 0.5; });
      g.axles = [0, 0.18, 0.36, 0.54, 0.72, 0.9].map((p) => axle(p, { radius: 0.44, density: 0.15 }));
    });
    expect(repairGenotype(maxG)).toEqual(maxG);
    // OPERATING-POINT PIN: 4.2 m/s ⇒ ω = −4.2/0.42 rounds to EXACTLY the old
    // shared −10 at these r 0.42 wheels (the roughRun pin's argument) — the
    // topology claim keeps its measured numbers.
    const run = await boundedRun(deterministic, compileAssembly(maxG), { steps: 900, targetWheelSurfaceSpeed: 4.2 });
    const diag = JSON.stringify(run);
    expect(run.counts, diag).toEqual([25, 24]); // 12 hubs + 12 wheels + chassis; 12 prismatics + 12 revolutes
    expect(run.finite, diag).toBe(true);
    expect(run.jointsValid, diag).toBe(true);
    expect(run.maxAnchorErr, diag).toBeLessThan(ANCHOR_BAND); // measured 5.4e-4
    expect(run.dx, diag).toBeGreaterThan(2); // it DRIVES (measured +9.50)
    expect(run.minQ, diag).toBeGreaterThan(-0.05); // measured −0.0067 (stop leak)
    expect(run.maxQ, diag).toBeLessThan(0.42);
  });

  test('a deliberately strange mixed asymmetric phenotype is finite, bounded, and contract-valid — strange is allowed; invalid is not', { timeout: 60000 }, async () => {
    const strangeG = witnessGenotype((g, axle) => {
      g.symmetric = 0.1;
      g.axles = [
        axle(0.1, { suspType: 0 }), //                                        rigid paired axle
        axle(0.5, { paired: 0, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.8 } }), // off-center single S1
        axle(0.9, { asym: { driveBias: 0.5, sizeBias: 0.65, centerOffset: 0.5 } }), //          asymmetric S1 pair
      ];
    });
    expect(repairGenotype(strangeG)).toEqual(strangeG);
    const run = await boundedRun(deterministic, compileAssembly(strangeG), { steps: 600 });
    const diag = JSON.stringify(run);
    expect(run.finite, diag).toBe(true);
    expect(run.jointsValid, diag).toBe(true);
    expect(run.maxAnchorErr, diag).toBeLessThan(ANCHOR_BAND); // measured 1.4e-3
    // Runs the new 5 m/s default (r 0.3 wheels ⇒ ω ≈ −16.7, was the shared
    // −10): re-measured for the per-wheel surface-speed PR, both flavors.
    expect(run.dx, diag).toBeGreaterThan(15); // measured +41.98 (was +26.41 at the old shared target)
    expect(Math.abs(run.z), diag).toBeLessThan(3); // asymmetric drift, measured 1.93 (was 0.10 — faster wheels drift more; band unchanged)
    expect(run.minQ, diag).toBeGreaterThan(-0.05);
    expect(run.maxQ, diag).toBeLessThan(0.42);
  });

  test('drive-torque reaction: the hub does NOT tilt the wheel plane — the drive path reacts through the prismatic rotational lock', { timeout: 60000 }, async () => {
    // The whole drive torque now reacts wheel → hub → prismatic angular
    // constraint → chassis. Decomposition matters: SWING (hub x/y rotation
    // vs the chassis) would tilt the wheel plane — that is the lock this
    // test guards; TWIST (about the axle z) is bounded constraint
    // deflection on an axisymmetric body, geometrically unobservable, and
    // is RECORDED with a ceiling (measured 0.244 rad at 125 N·m stall
    // transients on rough ground; flat-ground driving measures lower).
    const run = await boundedRun(deterministic, compileAssembly(witnessGenotype()), {
      x: 0, steps: 300, flatCuboid: true,
    });
    const diag = JSON.stringify(run);
    expect(run.finite, diag).toBe(true);
    // The tooth is non-vacuous only if the wheels actually spun under drive.
    expect(Math.min(...run.wheelOmegaZ.map(Math.abs)), diag).toBeGreaterThan(5); // per-wheel target −5/0.3 ≈ −16.7 (was the shared −10) — the tooth stands with more margin
    expect(run.dx, diag).toBeGreaterThan(3); // it drove
    expect(run.maxSwingXY, diag).toBeLessThan(0.15); // measured 0.046 max even on rough terrain
    expect(run.maxTwistZ, diag).toBeLessThan(0.6); // measured ≤ 0.244 at this torque — a ceiling, not a curve
  });

  test('findings ledger: solver-pump under S1 (recorded), mixed radii re-measured (grade stall stands; the shared-target conflict is closed), R5-cap overlap with S1', { timeout: 120000 }, async () => {
    // (1) Solver-pump drift: an awake undriven all-S1 vehicle on a flat
    // cuboid creeps at the S0 finding's magnitude — measured vxEnd −0.327
    // vs the S0 kernel's ≈0.33. S1 does NOT change the finding; fitness
    // still must not assume an undriven vehicle holds still on cuboid
    // ground. Loose bound: an explosion fails, the creep passes.
    const pump = await boundedRun(
      deterministic,
      compileAssembly(witnessGenotype((g) => { for (const a of g.axles) a.driven = 0; })),
      { x: 0, steps: 900, flatCuboid: true }
    );
    const diagPump = JSON.stringify(pump);
    expect(pump.finite, diagPump).toBe(true);
    expect(Math.abs(pump.vxEnd), diagPump).toBeLessThan(1);
    expect(pump.maxSpeed, diagPump).toBeLessThan(1); // measured 0.328
    expect(pump.minQ, diagPump).toBeGreaterThan(-0.02); // suspension stays sane while creeping
    expect(pump.maxQ, diagPump).toBeLessThan(0.42);

    // (2) Mixed radii under suspension travel, RE-MEASURED under the
    // per-wheel law — the old record conflated two mechanisms.
    // (2a) On this corridor the build still stops where it always did
    // (measured under the new law: dx +11.64, vxEnd −0.099, final x −38.4 —
    // ON the start-blend grade): a GRADE stall. This build is t/w 15.8% on
    // the seed whose blend stalled a 29% build (header), and stall thrust
    // is driveTorque/r — preserved BY DESIGN under any drive-target law, so
    // no target law can change this end state. The grade-stall finding
    // STANDS, now correctly attributed.
    const mixedG = witnessGenotype((g, axle) => {
      g.frame.segments[0].nodes.forEach((n) => { n.height = 0.5; });
      g.axles = [axle(0.2, { radius: 0.6, density: 0.15 }), axle(0.8, { radius: 0.44, density: 0.15 })];
    });
    expect(repairGenotype(mixedG)).toEqual(mixedG);
    const mixedIR = compileAssembly(mixedG);
    const mixed = await boundedRun(deterministic, mixedIR, { steps: 600 });
    const diagMixed = JSON.stringify(mixed);
    expect(mixed.finite, diagMixed).toBe(true);
    expect(mixed.jointsValid, diagMixed).toBe(true);
    expect(mixed.dx, diagMixed).toBeGreaterThan(2); // measured +11.64 — crosses the pad, dies on the blend
    expect(Math.abs(mixed.vxEnd), diagMixed).toBeLessThan(0.5); // measured −0.099 — grade-stalled at rest, not exploding
    expect(mixed.maxAnchorErr, diagMixed).toBeLessThan(ANCHOR_BAND);
    // (2b) The shared-target CONFLICT itself is CLOSED — witnessed on FLAT
    // ground where the grade cannot confound, and read from each motor's OWN
    // relative-angular-velocity coordinate (wheelMotorOmega: parent = hub
    // for S1), NOT the wheel body's world ω_z. Same IR, flat cuboid: under
    // the per-wheel law every wheel sits under ITS OWN target (motor-relative
    // r 0.5 → −9.81 of −10.0; r 0.42 → −11.71 of −11.905) and it cruises
    // 4.89 m/s. Station order: [axle0 ×2 (r 0.5), axle1 ×2 (r 0.42)]. The
    // sharp behavioral witness (radius ratio 2×, exact-old-law control twin,
    // driving-vs-braking split) lives in tests/surface-speed-drive.test.js.
    const mixedFlat = await boundedRun(deterministic, mixedIR, { x: 0, steps: 600, flatCuboid: true });
    const diagMixedFlat = JSON.stringify(mixedFlat);
    expect(mixedFlat.finite, diagMixedFlat).toBe(true);
    expect(mixedFlat.jointsValid, diagMixedFlat).toBe(true);
    expect(mixedFlat.dx, diagMixedFlat).toBeGreaterThan(25); // measured +39.39
    expect(mixedFlat.vxEnd, diagMixedFlat).toBeGreaterThan(3); // measured 4.891 — sustained cruise near the 5 m/s no-load surface speed
    for (const [k, omega] of mixedFlat.wheelMotorOmega.entries()) {
      const target = k < 2 ? 10.000000000000002 : 11.904761904761905; // |−5/r| per station
      expect(Math.abs(omega), diagMixedFlat).toBeLessThan(target * 1.05); // no wheel dragged past its OWN no-load target
      expect(Math.abs(omega), diagMixedFlat).toBeGreaterThan(target * 0.75); // engaged, near-cruise (measured 0.98× both axles)
    }

    // (3) The R5 cap-and-accept residual overlap stays stable with S1
    // modules: spacing 0.195 m < combined radii 1.0 m, yet it realizes,
    // drives, and neither detaches nor explodes (measured +5.06 m, maxSpeed
    // 2.90, anchorErr 4.0e-4). The open schema-ruling question from PR #10
    // (are visually-overlapping wheels acceptable for EVOLUTION?) stays
    // open — now with an S1 witness attached.
    const r5G = witnessGenotype((g, axle) => {
      g.frame.segments[0].nodes.forEach((n) => { n.height = 0.5; });
      g.axles = [axle(0.9, { radius: 0.6, density: 0.15 }), axle(0.95, { radius: 0.6, density: 0.15 })];
    });
    const repairedR5 = repairGenotype(r5G);
    expect(repairedR5.axles[0].posX01).toBe(0.9);
    expect(repairedR5.axles[1].posX01).toBe(1);
    const r5IR = compileAssembly(r5G);
    expect(r5IR.axles[1].posX - r5IR.axles[0].posX)
      .toBeLessThan(r5IR.axles[0].wheels[0].radius + r5IR.axles[1].wheels[0].radius);
    const r5 = await boundedRun(deterministic, r5IR, { steps: 300 });
    const diagR5 = JSON.stringify(r5);
    expect(r5.finite, diagR5).toBe(true);
    expect(r5.jointsValid, diagR5).toBe(true);
    expect(r5.maxAnchorErr, diagR5).toBeLessThan(ANCHOR_BAND);
    expect(r5.maxSpeed, diagR5).toBeLessThan(5); // measured 2.90
  });
});
