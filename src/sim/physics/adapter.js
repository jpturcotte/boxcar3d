// PhysicsAdapter — the single seam between simulation logic and Rapier.
//
// Phase 1 fills this in. Scope decisions already made (docs/…spec-v2.md):
//   • Engine: Rapier only (Cannon path deleted — decision D4).
//   • Vehicles: joint-based only; the ray-cast controller is out of scope (O3).
//   • Flavor: default '@dimforge/rapier3d-compat'; seed/replay mode uses
//     '@dimforge/rapier3d-deterministic-compat' (D7).
//   • Stepping: fixed dt = 1/60 via caller-owned accumulator; time scale means
//     more steps, never a larger dt. All sim clocks count steps (F3).
//
// Interface sketch (stabilize during Phase 1 steps 3–6):
//   await createPhysics({ deterministic })      → PhysicsWorld
//   world.addHeightfield(rows, cols, heights, scale)      // [V1] layout test first
//   world.addStatic(desc)                                  // obstacles, walls
//   world.buildVehicle(compiledGenotype)                   // from assembly compiler
//   world.step()                                           // one fixed tick
//   world.readPose(handle, outPositionQuat)                // batched reads (F8)
//   world.dispose()

import { featureGeometry } from '../features.js';
import { wheelMass, hubMassProperties, ASSEMBLY_IR_VERSION } from '../assembly.js';

export const FIXED_DT = 1 / 60;

// --- Collision groups (defined once, here; phase0-refresh §6 item 4).
//
// Rapier packs one u32 per collider: membership bits in the high 16, filter
// (who I may touch) in the low 16. A contact pair forms only if BOTH
// directions pass: (A.mem & B.filter) && (B.mem & A.filter).
//
// Policy matrix (PR #9 consumes CHASSIS_GROUPS/WHEEL_GROUPS verbatim —
// hand-packing is where bidirectional-mask bugs live):
//   ground  (heightfield, walls, features): mem GROUND, filter GROUND|CHASSIS|WHEEL
//   chassis (PR #9): mem CHASSIS, filter GROUND only  — never other vehicles
//   wheels  (PR #9): mem WHEEL,   filter GROUND only  — never own/other chassis
//   hubs    (S1 PR): mem HUB,     filter NOTHING      — collision-inert mass
// Chassis/wheels filtering to GROUND only IS the ghost-vehicle rule (O2/F9a):
// vehicle-vehicle pairs fail in both directions. If a real-vs-ghost split is
// ever wanted (e.g. a traffic mode), retrofit a GROUP_GHOST bit (0x0008
// reserved in spirit, deliberately not shipped — YAGNI) and widen the real
// chassis filter to GROUND|CHASSIS; groups alone cannot express both modes
// today. Note for PR #9+: in per-vehicle sharded eval worlds these groups are
// inert (one vehicle per world); their real consumer is the shared render
// world. Ungrouped colliders default to 0xFFFFFFFF and still collide with
// grouped ground — existing tests and legacy probes are unaffected.
export const GROUP_GROUND = 0x0001;
export const GROUP_CHASSIS = 0x0002;
export const GROUP_WHEEL = 0x0004;
// S1 hub bodies carry a small collider ONLY so mass/inertia read back at
// creation time (colliderless additional-mass bodies read zero until the
// first step — measured, tests/s1-prismatic.test.js). It must touch nothing:
// filter 0 fails the pair test in both directions against every collider,
// ground included. 0x0010 deliberately SKIPS 0x0008, which stays reserved
// for the possible real-vs-ghost split above.
export const GROUP_HUB = 0x0010;
// >>> 0 keeps the pack unsigned once a membership bit reaches 0x8000
// (Rapier expects a u32). Neutral name: setSolverGroups packs identically.
export const packGroups = (membership, filter) => ((membership << 16) | filter) >>> 0;
export const GROUND_GROUPS = packGroups(GROUP_GROUND, GROUP_GROUND | GROUP_CHASSIS | GROUP_WHEEL);
export const CHASSIS_GROUPS = packGroups(GROUP_CHASSIS, GROUP_GROUND);
export const WHEEL_GROUPS = packGroups(GROUP_WHEEL, GROUP_GROUND);
export const HUB_GROUPS = packGroups(GROUP_HUB, 0);

// Legacy-tuned feel: the original ran double Earth gravity on purpose
// (legacy/SALVAGE.md). Keep it as the known-good default; it is a knob.
export const GRAVITY = 20;

// --- Dynamic-body CCD policy (PR #9 finding — read before building vehicles).
//
// Hard CCD (RigidBodyDesc.setCcdEnabled) is INERT against the heightfield in
// rapier 0.19.3: the chassis-drop gate proved that CCD'd cuboids AND balls
// tunnel the floor from ~23 m/s up with exactly the same failure set as
// non-CCD bodies (9/9 identical spawns, tests/chassis-drop.test.js hunt,
// 2026-07-09). What actually catches fast bodies on the floor is soft CCD —
// RigidBodyDesc.setSoftCcdPrediction(distance) — whose predictive contacts
// don't depend on the shape-cast path that fails on heightfields. Policy:
// every dynamic chassis/wheel body sets BOTH
//   .setCcdEnabled(true)                       // shape-cast CCD: convex-vs-convex cover
//   .setSoftCcdPrediction(SOFT_CCD_PREDICTION) // the one that catches the floor
// 1 m of prediction covers one FIXED_DT step at 60 m/s — far beyond any
// speed the corridor can produce; larger values only grow broad-phase cost.
export const SOFT_CCD_PREDICTION = 1;

// Per-body additional solver iterations for vehicle chassis (spec §2:
// evolved assemblies multiply joints, and the chassis is the explosion-prone
// body; phase0-refresh [V2]). Rapier applies the extra iterations to the body
// AND everything interacting with it through contacts or joints, so the S0
// wheels inherit the budget via the chassis joint island — realizeS0Vehicle
// deliberately does NOT set it per wheel body. 4 additional passes (~2× the
// solver default) is the standard articulated-body guidance and costs one
// body's worth per vehicle.
// [V2] VERIFIED locally (2026-07-09) against the installed 0.19.3 typings of
// BOTH flavors: RigidBodyDesc.setAdditionalSolverIterations(iters) is
// chainable and RigidBody.additionalSolverIterations() reads it back
// (node_modules/@dimforge/rapier3d{,-deterministic}-compat/dynamics/
// rigid_body.d.ts). If a future Rapier bump drops it, realizeChassis fails
// loud at the call site — never silently omit the policy.
export const ADDITIONAL_SOLVER_ITERATIONS = 4;

export async function createPhysics({ deterministic = false } = {}) {
  const RAPIER = deterministic
    ? (await import('@dimforge/rapier3d-deterministic-compat')).default
    : (await import('@dimforge/rapier3d-compat')).default;
  await RAPIER.init(); // note: compat pkg prints an upstream deprecation warning internally — cosmetic
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.timestep = FIXED_DT;
  return { RAPIER, world };
}

// --- Terrain realization: the ONLY place that constructs Rapier terrain
// colliders. Callers (terrain generator output, main render) pass plain data;
// RAPIER is injected, never imported here beyond createPhysics.

// Static heightfield floor. A parentless collider is fixed, so no rigid body is
// needed. `heights` is column-major and `scale` a plain {x,y,z} per [V1].
export function addHeightfield(RAPIER, world, { rows, cols, heights, scale, friction = 1 }) {
  const desc = RAPIER.ColliderDesc.heightfield(rows, cols, heights, scale).setFriction(friction);
  return world.createCollider(desc);
}

// Static box (corridor wall), positioned by its own translation.
export function addStaticBox(RAPIER, world, { half, pos, restitution = 0.1, friction = 0.8 }) {
  const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
    .setTranslation(pos.x, pos.y, pos.z)
    .setRestitution(restitution)
    .setFriction(friction);
  return world.createCollider(desc);
}

// Realize a generated corridor (floor heightfield + the two walls) into a
// world. Group policy is applied here on the created handles — never inside
// the addHeightfield/addStaticBox primitives, which stay group-free for tests
// that build bare colliders (e.g. the twin-heightfield crater probe).
export function addCorridor(RAPIER, world, terrain) {
  const floor = addHeightfield(RAPIER, world, {
    rows: terrain.rows,
    cols: terrain.cols,
    heights: terrain.heights,
    scale: terrain.scale,
    friction: terrain.floorFriction,
  });
  floor.setCollisionGroups(GROUND_GROUPS);
  const walls = terrain.walls.map((w) => {
    const wall = addStaticBox(RAPIER, world, w);
    wall.setCollisionGroups(GROUND_GROUPS);
    return wall;
  });
  return { floor, walls };
}

// Feature realization defaults: seating + material only. Geometry knobs
// (hull vertex count/jitter, ramp thickness) live in features.js and pass
// through — a bad geometry knob throws there, before the world is touched.
const FEATURE_DEFAULTS = {
  embedDepth: 0.05, // metres the governing support point sinks below the surface
  friction: 0.8, // between wallFriction 0.8 and floorFriction 1 — rock, not track
  restitution: 0.05, // features nudge less than walls (wallRestitution 0.1)
};

function validateFeatureOptions(cfg) {
  if (!Number.isFinite(cfg.embedDepth) || cfg.embedDepth < 0 || cfg.embedDepth > 0.2) {
    throw new Error('addFeatures: embedDepth must be a finite number within [0, 0.2]');
  }
  if (!Number.isFinite(cfg.friction) || cfg.friction < 0) {
    throw new Error('addFeatures: friction must be a finite number >= 0');
  }
  if (!Number.isFinite(cfg.restitution) || cfg.restitution < 0 || cfg.restitution > 1) {
    throw new Error('addFeatures: restitution must be a finite number within [0, 1]');
  }
}

// Realize terrain.features as static colliders, seated against the TRUE
// triangulated floor surface (the descriptors' y is placement-grade bilinear —
// terrain.js). Contract:
//   1. ALL validation (options here, geometry knobs in featureGeometry) runs
//      BEFORE the world is touched — invalid input throws with no side effects.
//   2. Assumes a STATICS-ONLY world (floor + walls exist, no dynamic bodies):
//      the single world.step() below builds the query BVH ([V1] — castRay
//      returns null before the first step) and advances one statics-only tick.
//      Callers add dynamic bodies after addCorridorWithFeatures returns.
//   3. Seating rays filter to the floor heightfield only (predicate on the
//      handle), so features seat on the base surface — never on walls or each
//      other — and realization order cannot matter. Overlapping features are
//      accepted terrain character (terrain.js documents the decision).
// Seating rule: a rigid body rests on its HIGHEST support — per sample i,
// bodyY = max_i(surfaceY_i − bottomOffset_i) − embedDepth. Elongated features
// bridge dips (ends touch, middle floats); the governing support point ends
// embedDepth below the surface so nothing floats on a triangulated cell edge.
export function addFeatures(RAPIER, world, terrain, floor, options = {}) {
  const { embedDepth, friction, restitution, ...geometryOptions } = { ...FEATURE_DEFAULTS, ...options };
  validateFeatureOptions({ embedDepth, friction, restitution });
  // Pure pass first: computes every pose AND validates geometry knobs before
  // the world.step() side effect (contract 1).
  const geoms = terrain.features.map((f) => featureGeometry(f, geometryOptions));
  world.step(); // build the query BVH ([V1]); statics-only by contract 2

  const originY = terrain.bounds.maxY + 10;
  const maxToi = originY - (terrain.bounds.minY - 1); // always reaches the deepest crater floor
  const onFloor = (collider) => collider.handle === floor.handle;
  return terrain.features.map((feature, i) => {
    const geom = geoms[i];
    let seat = -Infinity;
    for (const s of geom.supportSamples) {
      const ray = new RAPIER.Ray({ x: feature.x + s.dx, y: originY, z: feature.z + s.dz }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, maxToi, true, undefined, undefined, undefined, undefined, onFloor);
      if (hit === null) {
        // Generator margins keep every support sample inside the field; a miss
        // is a real bug, and Math.max(NaN) would silently poison the pose.
        throw new Error(`addFeatures: seating ray missed the floor for feature ${i} (${feature.type})`);
      }
      seat = Math.max(seat, originY - hit.timeOfImpact - s.bottomOffset);
    }
    const position = { x: feature.x, y: seat - embedDepth, z: feature.z };

    let desc;
    if (geom.shape.kind === 'convexHull') {
      desc = RAPIER.ColliderDesc.convexHull(new Float32Array(geom.shape.points));
      if (desc === null) throw new Error(`addFeatures: degenerate convex hull for feature ${i} (boulder)`);
    } else if (geom.shape.kind === 'cuboid') {
      desc = RAPIER.ColliderDesc.cuboid(geom.shape.hx, geom.shape.hy, geom.shape.hz);
    } else {
      desc = RAPIER.ColliderDesc.capsule(geom.shape.halfHeight, geom.shape.radius);
    }
    desc
      .setTranslation(position.x, position.y, position.z)
      .setRotation(geom.quat)
      .setFriction(friction)
      .setRestitution(restitution)
      .setCollisionGroups(GROUND_GROUPS);
    let collider;
    if (geom.shape.kind === 'convexHull') {
      // The hull is computed lazily inside createCollider (0.19.x): a
      // degenerate point cloud surfaces as an opaque wasm-bindgen throw
      // there, not as a null desc. Fail loud with the F16 diagnosis instead.
      try {
        collider = world.createCollider(desc);
      } catch {
        throw new Error(`addFeatures: degenerate convex hull for feature ${i} (boulder)`);
      }
    } else {
      collider = world.createCollider(desc);
    }
    // Render consumes position/rotation/points/shape (the seated pose does not
    // exist in terrain.features); collider is for tests and later teardown.
    return { feature, collider, position, rotation: geom.quat, points: geom.points, shape: geom.shape };
  });
}

// Full composite corridor: floor + walls + seated features.
export function addCorridorWithFeatures(RAPIER, world, terrain, options = {}) {
  const { floor, walls } = addCorridor(RAPIER, world, terrain);
  const features = addFeatures(RAPIER, world, terrain, floor, options);
  return { floor, walls, features };
}

// --- Chassis realization (PR #10): compiled assembly IR -> ONE dynamic body.
//
// The only place a vehicle chassis enters a world. Applies the full dynamic-
// body policy in one spot so the compiled population inherits exactly the
// setup the chassis-drop gate proved: CHASSIS_GROUPS on every collider, dual
// CCD (hard CCD for convex-vs-convex + soft CCD for the heightfield — the
// PR #9 finding), and ADDITIONAL_SOLVER_ITERATIONS. Contract mirrors
// addFeatures: ALL validation runs before the world is touched; a degenerate
// hull throws the F16 diagnosis (both the null-desc and the lazy
// createCollider paths) and removes the partly-built body so a throw never
// leaves debris in the world.
const finiteVec = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

export function realizeChassis(RAPIER, world, ir, options = {}) {
  const {
    position = { x: 0, y: 0, z: 0 },
    rotation = { x: 0, y: 0, z: 0, w: 1 },
    linvel = { x: 0, y: 0, z: 0 },
  } = options;
  if (!ir || ir.version !== ASSEMBLY_IR_VERSION || !ir.chassis || !Array.isArray(ir.chassis.colliders) || ir.chassis.colliders.length === 0) {
    throw new Error(`realizeChassis: malformed IR (need assembly IR version ${ASSEMBLY_IR_VERSION} and a non-empty chassis.colliders)`);
  }
  if (!Number.isFinite(ir.chassis.density) || !(ir.chassis.density > 0)) {
    throw new Error('realizeChassis: chassis density must be a finite number > 0');
  }
  // Full pre-world shape validation (external review): a zero/negative half-
  // extent, a missing/NaN rotation, or a ragged/non-finite hull cloud would
  // otherwise reach Rapier as a crash or silent-garbage collider. Everything
  // here runs BEFORE createRigidBody, so a rejected IR provably leaves the
  // world untouched (body count asserted by the negatives).
  for (const c of ir.chassis.colliders) {
    if (c.kind === 'cuboid') {
      if (![c.hx, c.hy, c.hz].every((h) => Number.isFinite(h) && h > 0) || ![c.cx, c.cy, c.cz].every(Number.isFinite)) {
        throw new Error('realizeChassis: cuboid collider needs positive finite half-extents and a finite center');
      }
      if (!c.rot || ![c.rot.x, c.rot.y, c.rot.z, c.rot.w].every(Number.isFinite)) {
        throw new Error('realizeChassis: cuboid collider needs a finite rotation quaternion');
      }
    } else if (c.kind === 'convexHull') {
      const pts = c.points;
      if ((!Array.isArray(pts) && !(pts instanceof Float32Array)) || pts.length < 12 || pts.length % 3 !== 0) {
        throw new Error('realizeChassis: convexHull collider needs a flat 3n-length points array with >= 4 points');
      }
      for (let i = 0; i < pts.length; i++) {
        if (!Number.isFinite(pts[i])) throw new Error('realizeChassis: non-finite convexHull point coordinate');
      }
    } else {
      throw new Error(`realizeChassis: unknown collider kind '${c && c.kind}'`);
    }
  }
  if (!finiteVec(position) || !finiteVec(linvel) || !finiteVec(rotation) || !Number.isFinite(rotation.w)) {
    throw new Error('realizeChassis: non-finite spawn pose');
  }

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation(rotation)
      .setLinvel(linvel.x, linvel.y, linvel.z)
      .setCcdEnabled(true)
      .setSoftCcdPrediction(SOFT_CCD_PREDICTION)
      .setAdditionalSolverIterations(ADDITIONAL_SOLVER_ITERATIONS)
  );
  const colliders = [];
  try {
    for (const c of ir.chassis.colliders) {
      let desc;
      if (c.kind === 'cuboid') {
        desc = RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz)
          .setTranslation(c.cx, c.cy, c.cz)
          .setRotation(c.rot);
      } else {
        desc = RAPIER.ColliderDesc.convexHull(new Float32Array(c.points));
        if (desc === null) throw new Error('realizeChassis: degenerate convex hull (F16)');
      }
      desc.setDensity(ir.chassis.density).setCollisionGroups(CHASSIS_GROUPS);
      if (c.kind === 'convexHull') {
        // 0.19.x computes the hull lazily inside createCollider — a
        // degenerate cloud surfaces as an opaque wasm throw here, not as a
        // null desc (the addFeatures F16 pattern).
        try {
          colliders.push(world.createCollider(desc, body));
        } catch {
          throw new Error('realizeChassis: degenerate convex hull (F16)');
        }
      } else {
        colliders.push(world.createCollider(desc, body));
      }
    }
    // Post-create sanity, fail-loud: density × collider volume must yield
    // finite positive mass and finite principal inertia (a zero/NaN inertia
    // body integrates to NaN poses steps later — catch it at the seam).
    const m = body.mass();
    if (!Number.isFinite(m) || !(m > 0)) {
      throw new Error(`realizeChassis: chassis mass ${m} is not finite and positive`);
    }
    const inv = body.invPrincipalInertia();
    if (![inv.x, inv.y, inv.z].every(Number.isFinite)) {
      throw new Error('realizeChassis: non-finite chassis inertia');
    }
  } catch (err) {
    world.removeRigidBody(body); // never leave a half-built chassis behind
    throw err;
  }
  return { body, colliders };
}

// --- S0 wheel/joint/motor kernel (spec §3.2/§3.4) --------------------------
//
// One dynamic cylinder body per IR wheel, one chassis-to-wheel revolute joint
// on the lateral axis, native joint motors — the only sanctioned drive path
// (never setAngvel / direct impulses / pose writes; movement is joint-motor
// causality or nothing).
//
// MOTOR RULING (measured, tests/s0-motor.test.js): Rapier's motor "factor" is
// a velocity-servo GAIN, not a torque — raw law: τ = factor × (targetVel − ω).
// The realizer derives the gain from the IR torque,
//     gain = driveTorque / |targetAngvel|      (gain ≥ 0)
// so the signed law is τ = gain × (targetAngvel − ω) = sign(targetAngvel) ×
// driveTorque × (1 − ω/targetAngvel): the stall MAGNITUDE |τ(ω=0)| = gain ×
// |targetAngvel| = driveTorque EXACTLY (its SIGN follows targetAngvel — with
// the canonical −10 target the signed stall torque is −driveTorque, spinning
// the wheel for +X). driveTorque is thus a literal stall-torque budget in
// magnitude, τ falling linearly to zero at the target speed, and thrust stays
// proportional to each wheel's share of the global power budget. ForceBased
// is required for that reading: on an airborne
// bench, the same driveTorque on wheels of 5.06× inertia produced a 4.86×
// first-step spin ratio under ForceBased (a real torque) but 1.000 under
// AccelerationBased (the solver normalizes effective inertia away — its
// factor is NOT a torque, and wheel size would silently rescale thrust).
// Resolved per flavor from RAPIER.MotorModel by NAME — a bare numeric would
// couple this policy to the enum's current representation, and a Rapier bump
// that drops/renames the member must fail loud, never silently re-map.
export const S0_MOTOR_MODEL_NAME = 'ForceBased';

// Signed motor target (rad/s) about the local +Z axle. NEGATIVE spins wheels
// for +X travel: with the axle along +Z, the contact-point velocity is +ωR·x̂,
// so forward needs ω < 0 (locked by the sign test in tests/s0-motor.test.js:
// target −10 → dx +9.47 m, target +10 → the mirror). Magnitude is the legacy
// SALVAGE default (~10 rad/s wheel target). This is the no-load speed; by the
// gain conversion above, changing it does NOT rescale stall torque.
export const MOTOR_TARGET_ANGVEL = -10;

// Firm-baseline wheel-contact friction. Explicit because it is load-bearing
// for traction: Rapier's silent collider default is 0.5, and the corridor
// floor ships friction 1 (TERRAIN_DEFAULTS.floorFriction) — the witness teeth
// are calibrated against this pairing. Zone-dependent friction (sand/mud) is
// deferred to its own PR and will modulate per contact, not this constant.
export const WHEEL_FRICTION = 1;

// Rapier cylinders extend along LOCAL Y; the vehicle axle is local +Z. This
// +90°-about-X quaternion (trig-free: half-angle of 90° has cos = sin = √.5)
// maps the cylinder onto the axle and is applied to the COLLIDER ONLY. The
// wheel RIGID BODY keeps the chassis' base rotation — Rapier's revolute axis
// is ONE vector interpreted in EACH body's local frame, so the two hinge
// frames agree in world space only while the bodies share a base orientation
// (they do, by construction, at any spawn rotation).
export const WHEEL_COLLIDER_ROTATION = Object.freeze({ x: Math.sqrt(0.5), y: 0, z: 0, w: Math.sqrt(0.5) });

// The revolute (hinge/drive) axis: vehicle-local lateral +Z, same meaning in
// the chassis and wheel frames because their base rotations are identical.
export const REVOLUTE_AXIS = Object.freeze({ x: 0, y: 0, z: 1 });

// The S1 suspension extension axis: vehicle-local DOWN, by ruling — the
// suspension is attached to the vehicle and rotates with it (a 180°-rolled
// vehicle's suspension extends world-UP; no world-up correction anywhere).
// One vector, interpreted in EACH joined body's local frame — meaningful
// because chassis, hub, and wheel share the base spawn rotation (the same
// hinge-frame contract as REVOLUTE_AXIS). Coordinate contract (measured,
// tests/s1-prismatic.test.js, phase0-refresh [V11]): coordinate 0 = full
// compression = the S0-safe wheel position {posX, mountY, z}; positive
// coordinate = extension away from the chassis; limits are [0, travel];
// body placement sets the initial coordinate; the position-motor target is
// an ABSOLUTE coordinate.
export const SUSPENSION_AXIS = Object.freeze({ x: 0, y: -1, z: 0 });

// The S1 spring IS the prismatic position motor:
// configureMotorPosition(restLength, stiffness, damping) + setLimits(0,
// travel). ForceBased required ([V12], measured): its static coordinate is
// target ± m·g/k EXACTLY on the isolated rig — stiffness is an honest N/m —
// while AccelerationBased settles 5 kg and 50 kg at the SAME coordinate
// (mass-blind; its "stiffness" is not a spring rate — REJECTED). Resolved
// per flavor by NAME from RAPIER.MotorModel, fail-loud (the
// S0_MOTOR_MODEL_NAME convention).
export const S1_SPRING_MOTOR_MODEL_NAME = 'ForceBased';

// Rotate v by unit quaternion q — the standard t = 2 q×v expansion (mul/add
// only; sim-ban-safe). Callers guarantee q is unit (realizeS0Vehicle
// validates spawn rotations to 1e-6).
function rotateByQuat(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

// Pure pose math for every wheel a compiled IR emits — no RAPIER, no state.
// The chassis-local wheel center is {axle.posX, axle.mountY, wheel.z}; its
// world center is the spawn translation plus that local point rotated by the
// spawn quaternion. The local point doubles as the chassis-side joint anchor
// (the wheel-side anchor is the wheel body's own origin). Exported so tests
// prove the transform exactly and realizeS0Vehicle provably uses the same
// numbers. Assumes a validated IR and a unit rotation; validation lives in
// realizeS0Vehicle.
export function s0WheelTransforms(ir, { position = { x: 0, y: 0, z: 0 }, rotation = { x: 0, y: 0, z: 0, w: 1 } } = {}) {
  const out = [];
  ir.axles.forEach((axle, axleIndex) => {
    axle.wheels.forEach((wheel, wheelIndex) => {
      const local = { x: axle.posX, y: axle.mountY, z: wheel.z };
      const r = rotateByQuat(rotation, local);
      out.push({
        axleIndex,
        wheelIndex,
        local,
        world: { x: position.x + r.x, y: position.y + r.y, z: position.z + r.z },
      });
    });
  });
  return out;
}

// --- S1 pure pose/coordinate helpers (no RAPIER, no state; the sim ban
// applies — mul/add/min/max only). Tests prove these against the independent
// rotation oracle in tests/rotate-oracle.js, never against themselves.

// The chassis-local FULL-COMPRESSION anchor of one wheel station: the exact
// point s0WheelTransforms calls `local` — {axle.posX, axle.mountY, wheel.z}.
// It is BOTH the S0 revolute chassis-side anchor and the S1 prismatic
// chassis-side anchor: at prismatic coordinate 0 the S1 hub sits exactly
// where the rigid S0 wheel would, so full compression is the proven S0
// envelope and the R2 clearance repair needs no S1 variant (extension only
// ADDS belly clearance).
export function suspensionAnchorLocal(axle, wheel) {
  return { x: axle.posX, y: axle.mountY, z: wheel.z };
}

// The quiescent-spawn coordinate (metres of extension from full compression):
// clamp(restLength, 0, travel). The spring spawns AT its set point (zero
// stored energy) — never at full compression (a birth-launch). Preload
// (restLength > travel) spawns at the extension stop, which IS its static
// state; zero travel returns 0 (a locked suspension).
export function s1SpawnCoordinate(suspension) {
  return Math.min(Math.max(suspension.restLength, 0), suspension.travel);
}

// Hub/wheel center of one S1 station at an ARBITRARY prismatic coordinate
// (metres of extension). The hub origin and the wheel origin coincide by
// construction — both revolute anchors are body origins — so this one point
// is both bodies' centers: local = anchor + coordinate·SUSPENSION_AXIS,
// world = position + rotate(rotation, local). Plain {x,y,z}/{x,y,z,w} data.
export function s1WheelTransformAt(axle, wheel, coordinateM, { position = { x: 0, y: 0, z: 0 }, rotation = { x: 0, y: 0, z: 0, w: 1 } } = {}) {
  const a = suspensionAnchorLocal(axle, wheel);
  const local = {
    x: a.x + coordinateM * SUSPENSION_AXIS.x,
    y: a.y + coordinateM * SUSPENSION_AXIS.y,
    z: a.z + coordinateM * SUSPENSION_AXIS.z,
  };
  const r = rotateByQuat(rotation, local);
  return { local, world: { x: position.x + r.x, y: position.y + r.y, z: position.z + r.z } };
}

// Expected WORLD suspension and hinge axes for a vehicle at base rotation q —
// the pure statement of the vehicle-local ruling: at a 180° roll,
// .suspension points world-UP, and that is correct behavior, not a bug.
export function vehicleWorldAxes(rotation) {
  return {
    suspension: rotateByQuat(rotation, SUSPENSION_AXIS),
    hinge: rotateByQuat(rotation, REVOLUTE_AXIS),
  };
}

// The full spawn placement plan for a mixed S0/S1 IR — the realizeVehicle
// analogue of s0WheelTransforms (which stays exported and untouched; S0
// stations here compute the IDENTICAL expression, pinned bit-equal by test).
// Per wheel, in axle-then-wheel order:
//   { axleIndex, wheelIndex, suspensionType, anchorLocal,
//     spawnCoordinate,   // s1SpawnCoordinate(suspension) for S1, null for S0
//     local, world }     // the body center: S0 wheel, or S1 hub AND wheel
// Assumes a validated IR (realizeVehicle rejects S2/unknown types pre-world
// BEFORE computing placements); non-S1 types get the S0 expression.
export function vehicleWheelTransforms(ir, { position = { x: 0, y: 0, z: 0 }, rotation = { x: 0, y: 0, z: 0, w: 1 } } = {}) {
  const out = [];
  ir.axles.forEach((axle, axleIndex) => {
    axle.wheels.forEach((wheel, wheelIndex) => {
      const suspensionType = axle.suspension.type;
      const anchorLocal = suspensionAnchorLocal(axle, wheel);
      if (suspensionType === 'S1') {
        const spawnCoordinate = s1SpawnCoordinate(axle.suspension);
        const t = s1WheelTransformAt(axle, wheel, spawnCoordinate, { position, rotation });
        out.push({ axleIndex, wheelIndex, suspensionType, anchorLocal, spawnCoordinate, local: t.local, world: t.world });
      } else {
        const r = rotateByQuat(rotation, anchorLocal);
        out.push({
          axleIndex,
          wheelIndex,
          suspensionType,
          anchorLocal,
          spawnCoordinate: null,
          local: anchorLocal,
          world: { x: position.x + r.x, y: position.y + r.y, z: position.z + r.z },
        });
      }
    });
  });
  return out;
}

// The projected prismatic coordinate from two body poses. Rapier 0.19.3
// exposes NO translation readback on prismatic joints (verified against both
// flavors' typings — phase0-refresh [V11]), so this pure projection is the
// ONLY coordinate source:
//   coordinate = dot(R1·axisLocal, (p2 + R2·anchor2Local) − (p1 + R1·anchor1Local))
// with the axis taken in body1's (the chassis's) local frame, matching the
// engine's convention. Poses are plain { position: {x,y,z},
// rotation: {x,y,z,w} } so tests feed body.translation()/rotation() readbacks
// and a HUD feeds live poses. Assumes unit quaternions and a unit axis.
// Tolerance note for consumers: the result is a difference of nearby world
// coordinates, so assertion bands must scale with the WORLD-ANCHOR magnitudes
// entering the subtraction (f32 ULP ~1.2e-7 relative), never with the small
// projected value itself.
export function projectedPrismaticCoordinate(bodyPose1, bodyPose2, anchor1Local, anchor2Local, axisLocal) {
  const a1 = rotateByQuat(bodyPose1.rotation, anchor1Local);
  const a2 = rotateByQuat(bodyPose2.rotation, anchor2Local);
  const dx = bodyPose2.position.x + a2.x - (bodyPose1.position.x + a1.x);
  const dy = bodyPose2.position.y + a2.y - (bodyPose1.position.y + a1.y);
  const dz = bodyPose2.position.z + a2.z - (bodyPose1.position.z + a1.z);
  const axis = rotateByQuat(bodyPose1.rotation, axisLocal);
  return dx * axis.x + dy * axis.y + dz * axis.z;
}

// --- The vehicle realizer: one pre-world validation pass + one transactional
// construction pass, shared by realizeVehicle (explicit S0/S1 dispatch) and
// realizeS0Vehicle (the S0-only compatibility wrapper). Factored, never
// copied: the S0 station path below is the S0 kernel's original statement
// sequence, and for an all-S0 IR the hub/prismatic ledgers stay empty, so
// the wrapper's observable contract — validation order, messages, world-call
// order, rollback order, return shape — is unchanged.

// Validate a COMPLETE IR + options before any world mutation. `label`
// prefixes every message (the wrapper keeps its historical prefix). `s0Only`
// keeps the wrapper's fail-loud contract: any non-S0 axle is rejected with
// the original S0-kernel message — S1/S2 stay legal IR data (the 24cd0dd5
// corpus lock and the every-suspension-type assertion depend on it) and can
// never silently realize as rigid axles through the S0 path.
function validateVehicleIR(RAPIER, ir, options, { label, s0Only }) {
  const {
    position = { x: 0, y: 0, z: 0 },
    rotation = { x: 0, y: 0, z: 0, w: 1 },
    linvel = { x: 0, y: 0, z: 0 },
    targetAngvel = MOTOR_TARGET_ANGVEL,
    wheelFriction = WHEEL_FRICTION,
  } = options;
  if (!ir || ir.version !== ASSEMBLY_IR_VERSION || !Array.isArray(ir.axles)) {
    throw new Error(`${label}: malformed IR (need assembly IR version ${ASSEMBLY_IR_VERSION} and an axles array)`);
  }
  // Resolve the DRIVE motor model by name, fail-loud (the [V2] convention for
  // Rapier bumps): a missing member means the motor API changed and the S0
  // ruling must be re-verified, never silently re-mapped.
  const motorModel = RAPIER.MotorModel ? RAPIER.MotorModel[S0_MOTOR_MODEL_NAME] : undefined;
  if (typeof motorModel !== 'number') {
    throw new Error(`${label}: RAPIER.MotorModel.${S0_MOTOR_MODEL_NAME} is missing — re-verify the S0 motor ruling against this Rapier build`);
  }
  let anyMotor = false;
  let anyS1 = false;
  ir.axles.forEach((axle, i) => {
    if (!axle || !Number.isFinite(axle.posX) || !Number.isFinite(axle.mountY)) {
      throw new Error(`${label}: axles[${i}] needs finite posX and mountY`);
    }
    const type = axle.suspension && axle.suspension.type;
    if (s0Only) {
      if (type !== 'S0') {
        throw new Error(`${label}: axles[${i}].suspension.type '${String(type)}' — the S0 kernel realizes only S0; S1/S2 stay legal IR data and need their own realizer`);
      }
    } else if (type !== 'S0' && type !== 'S1') {
      throw new Error(`${label}: axles[${i}].suspension.type '${String(type)}' — realizeVehicle dispatches S0 and S1 only; S2 stays legal IR data until its realizer ships`);
    }
    if (type === 'S1') {
      anyS1 = true;
      // Spring parameters: reject garbage, never weird-but-physical values.
      // stiffness 0 is a damper with stops; stiffness 0 AND damping 0 is a
      // free slider (handled by the construction-time skip rule — the
      // engine's k=0∧c=0 motor 0/0-freezes the axis, measured); travel 0 is
      // a locked suspension; restLength beyond travel is preload at the
      // stop. All legal phenotypes — evolution's problem, not repair's.
      for (const key of ['stiffness', 'damping', 'travel', 'restLength']) {
        const v = axle.suspension[key];
        if (!Number.isFinite(v) || v < 0) {
          throw new Error(`${label}: axles[${i}].suspension.${key} must be a finite number >= 0 (${String(v)})`);
        }
      }
    }
    if (!Array.isArray(axle.wheels) || axle.wheels.length === 0) {
      throw new Error(`${label}: axles[${i}].wheels must be a non-empty array`);
    }
    axle.wheels.forEach((w, j) => {
      const at = `axles[${i}].wheels[${j}]`;
      if (!w) throw new Error(`${label}: ${at} is missing`);
      for (const k of ['radius', 'width', 'density', 'mass']) {
        if (!Number.isFinite(w[k]) || !(w[k] > 0)) {
          throw new Error(`${label}: ${at}.${k} must be a finite number > 0 (${String(w[k])})`);
        }
      }
      if (!Number.isFinite(w.z)) throw new Error(`${label}: ${at}.z must be finite (${String(w.z)})`);
      if (typeof w.driven !== 'boolean') throw new Error(`${label}: ${at}.driven must be a boolean (${String(w.driven)})`);
      if (!Number.isFinite(w.driveTorque) || w.driveTorque < 0) {
        throw new Error(`${label}: ${at}.driveTorque must be a finite number >= 0 (${String(w.driveTorque)})`);
      }
      // The IR computes mass via assembly.js's wheelMass (the ONE π·r²·w·ρ
      // source, shared so this guard can never drift from the formula); a
      // disagreement means hand-edited IR data whose density and mass would
      // realize different physics than the schema promised.
      const derived = wheelMass(w.radius, w.width, w.density);
      if (Math.abs(w.mass - derived) > 1e-9 * Math.max(1, w.mass)) {
        throw new Error(`${label}: ${at}.mass ${w.mass} disagrees with π·r²·width·density = ${derived}`);
      }
      if (type === 'S1') {
        // The compiler-owned hub record (assembly IR v2). The realizer
        // CONSUMES the stored record; recomputing it through the imported
        // policy here is the tamper guard — it catches a hand-edited record,
        // exactly like the wheelMass check above.
        const hub = w.hub;
        if (!hub || typeof hub !== 'object') {
          throw new Error(`${label}: ${at}.hub record is missing — S1 wheels carry the compiler-owned hub record`);
        }
        const expected = hubMassProperties(w);
        for (const k of ['mass', 'radius', 'halfWidth', 'density']) {
          if (!Number.isFinite(hub[k]) || !(hub[k] > 0)) {
            throw new Error(`${label}: ${at}.hub.${k} must be a finite number > 0 (${String(hub[k])})`);
          }
          if (Math.abs(hub[k] - expected[k]) > 1e-9 * Math.max(1, expected[k])) {
            throw new Error(`${label}: ${at}.hub.${k} ${hub[k]} disagrees with the hub policy value ${expected[k]}`);
          }
        }
        for (const axis of ['x', 'y', 'z']) {
          const v = hub.principalInertia ? hub.principalInertia[axis] : undefined;
          if (!Number.isFinite(v) || !(v > 0)) {
            throw new Error(`${label}: ${at}.hub.principalInertia.${axis} must be a finite number > 0 (${String(v)})`);
          }
          if (Math.abs(v - expected.principalInertia[axis]) > 1e-9 * Math.max(1, expected.principalInertia[axis])) {
            throw new Error(`${label}: ${at}.hub.principalInertia.${axis} ${v} disagrees with the hub policy value ${expected.principalInertia[axis]}`);
          }
        }
      }
      if (w.driven && w.driveTorque > 0) anyMotor = true;
    });
  });
  if (anyS1) {
    // Canonical hub-mass accounting must match the stored records (the
    // ir.mass.hubsTotal tamper guard; same axle-then-wheel float-add order
    // buildIR documents).
    const storedSum = ir.axles.flatMap((ax) => ax.wheels).reduce((s, w) => s + (w.hub ? w.hub.mass : 0), 0);
    const hubsTotal = ir.mass ? ir.mass.hubsTotal : undefined;
    if (!Number.isFinite(hubsTotal) || Math.abs(hubsTotal - storedSum) > 1e-9 * Math.max(1, storedSum)) {
      throw new Error(`${label}: ir.mass.hubsTotal ${String(hubsTotal)} disagrees with the stored hub records' sum ${storedSum}`);
    }
  }
  if (!finiteVec(position) || !finiteVec(linvel) || !finiteVec(rotation) || !Number.isFinite(rotation.w)) {
    throw new Error(`${label}: non-finite spawn pose`);
  }
  // Stricter than realizeChassis: wheel centers are computed by rotating
  // local points with this quaternion, so a non-unit value would silently
  // misplace every wheel relative to Rapier's internally normalized use.
  const norm2 = rotation.x * rotation.x + rotation.y * rotation.y + rotation.z * rotation.z + rotation.w * rotation.w;
  if (Math.abs(norm2 - 1) > 1e-6) {
    throw new Error(`${label}: spawn rotation must be a unit quaternion (|q|² = ${norm2})`);
  }
  if (!Number.isFinite(targetAngvel)) {
    throw new Error(`${label}: targetAngvel must be finite (${String(targetAngvel)})`);
  }
  // The gain conversion divides by |targetAngvel| — a zero-target motor
  // request is rejected loud, never divided. A fully undriven IR accepts any
  // finite target (nothing consumes it).
  if (anyMotor && targetAngvel === 0) {
    throw new Error(`${label}: targetAngvel 0 with driven wheels — the gain conversion needs a nonzero no-load speed`);
  }
  if (!Number.isFinite(wheelFriction) || wheelFriction < 0) {
    throw new Error(`${label}: wheelFriction must be a finite number >= 0 (${String(wheelFriction)})`);
  }
  // Derive every DRIVE motor gain NOW, pre-world: gain = driveTorque /
  // |targetAngvel| (the [V10] ruling — reused VERBATIM by S1 wheels; only
  // the joint the motor lands on differs). Rejecting only targetAngvel === 0
  // was not enough — a finite but denormal-tiny target (e.g.
  // Number.MIN_VALUE) sends driveTorque / |target| to Infinity, a non-finite
  // gain that must fail loud HERE, never reach configureMotorVelocity after
  // bodies/joints exist. The validated gains are stored so the construction
  // loop consumes them (one source, never recomputed). No magnitude floor: a
  // large finite gain (e.g. 6.25e9 at target 1e-8) is stable over 600 steps
  // in-probe, so only non-finite is out of domain.
  const invTarget = 1 / Math.abs(targetAngvel);
  const motorGain = new Map();
  for (const axle of ir.axles) {
    for (const w of axle.wheels) {
      if (w.driven && w.driveTorque > 0) {
        const gain = w.driveTorque * invTarget;
        if (!Number.isFinite(gain)) {
          throw new Error(`${label}: motor gain ${gain} (driveTorque ${w.driveTorque} / |targetAngvel| ${Math.abs(targetAngvel)}) is not finite — targetAngvel is too small`);
        }
        motorGain.set(w, gain);
      }
    }
  }
  // The S1 API surface, verified pre-world whenever any S1 axle exists, so
  // API drift on a future Rapier bump can never fire after the chassis and
  // hubs already exist (the rollback would cover it, but fail-loud-first is
  // the house rule).
  let springModel = null;
  if (anyS1) {
    springModel = RAPIER.MotorModel[S1_SPRING_MOTOR_MODEL_NAME];
    if (typeof springModel !== 'number') {
      throw new Error(`${label}: RAPIER.MotorModel.${S1_SPRING_MOTOR_MODEL_NAME} is missing — re-verify the S1 spring ruling against this Rapier build`);
    }
    if (typeof RAPIER.JointData.prismatic !== 'function') {
      throw new Error(`${label}: RAPIER.JointData.prismatic is missing — re-verify the S1 prismatic ruling against this Rapier build`);
    }
    const proto = RAPIER.PrismaticImpulseJoint ? RAPIER.PrismaticImpulseJoint.prototype : undefined;
    for (const method of ['setLimits', 'configureMotorModel', 'configureMotorPosition']) {
      if (!proto || typeof proto[method] !== 'function') {
        throw new Error(`${label}: PrismaticImpulseJoint.prototype.${method} is missing — re-verify the S1 prismatic ruling against this Rapier build`);
      }
    }
  }
  return { label, position, rotation, linvel, targetAngvel, wheelFriction, motorModel, springModel, motorGain };
}

// Transactional construction over a validated plan. Ledger discipline: every
// created object is pushed IMMEDIATELY on creation — joints BEFORE any
// configuration call on them — so a failure anywhere (including inside
// setLimits/configureMotor*) unwinds cleanly. Rollback order: drive
// revolutes → prismatics → wheel bodies → hub bodies → chassis (every joint
// removed while both its bodies still exist, every body removed after all
// its joints — Rapier's implicit joint-removal-on-body-removal never fires),
// restoring all three world counts exactly.
function constructVehicle(RAPIER, world, ir, v) {
  const { label, position, rotation, linvel, targetAngvel, wheelFriction, motorModel, springModel, motorGain } = v;
  const placements = vehicleWheelTransforms(ir, { position, rotation });
  const chassis = realizeChassis(RAPIER, world, ir, { position, rotation, linvel });
  const wheels = [];
  const createdHubBodies = [];
  const createdWheelBodies = [];
  const createdSuspensionJoints = [];
  const createdDriveJoints = [];
  const ORIGIN = { x: 0, y: 0, z: 0 };
  try {
    for (const p of placements) {
      const axle = ir.axles[p.axleIndex];
      const w = axle.wheels[p.wheelIndex];
      let hub = null;
      let suspensionJoint = null;
      if (p.suspensionType === 'S1') {
        // Hub body: SAME base rotation and SAME spawn linvel as the chassis
        // (a moving chassis with at-rest hubs is step-0 joint violence on
        // the prismatic — the failure class the S0 kernel closed for
        // wheels), placed at the quiescent-spawn coordinate.
        const rec = w.hub; // the stored record, validated against the policy pre-world
        const hubBody = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(p.world.x, p.world.y, p.world.z)
            .setRotation(rotation)
            .setLinvel(linvel.x, linvel.y, linvel.z)
            .setCcdEnabled(true)
            .setSoftCcdPrediction(SOFT_CCD_PREDICTION)
        );
        createdHubBodies.push(hubBody);
        // The hub collider exists ONLY to give the body its policy mass and
        // inertia with a creation-time readback (colliderless additional-
        // mass bodies read ZERO until the first step — measured,
        // tests/s1-prismatic.test.js); HUB_GROUPS touches NOTHING. Same Y→Z
        // rotation as the wheel collider: the hub cylinder is coaxial with
        // the axle.
        const hubCollider = world.createCollider(
          RAPIER.ColliderDesc.cylinder(rec.halfWidth, rec.radius)
            .setRotation(WHEEL_COLLIDER_ROTATION)
            .setDensity(rec.density)
            .setCollisionGroups(HUB_GROUPS),
          hubBody
        );
        const hm = hubBody.mass();
        if (!Number.isFinite(hm) || !(hm > 0)) {
          throw new Error(`${label}: hub mass ${hm} is not finite and positive`);
        }
        if (Math.abs(hm - rec.mass) > 1e-3 * Math.max(1, rec.mass)) {
          throw new Error(`${label}: realized hub mass ${hm} drifted from the IR hub record ${rec.mass}`);
        }
        const hinv = hubBody.invPrincipalInertia();
        if (![hinv.x, hinv.y, hinv.z].every((c) => Number.isFinite(c) && c > 0)) {
          throw new Error(`${label}: hub inverse inertia must be finite and > 0 (a rotation-locked hub would fight the drive path)`);
        }
        // The suspension: chassis→hub prismatic along the vehicle-local
        // axis. Chassis anchor = the full-compression point (the S0 wheel
        // position), hub anchor = the hub origin. LEDGER BEFORE any
        // configuration call.
        suspensionJoint = world.createImpulseJoint(
          RAPIER.JointData.prismatic(p.anchorLocal, ORIGIN, SUSPENSION_AXIS),
          chassis.body,
          hubBody,
          true
        );
        createdSuspensionJoints.push(suspensionJoint);
        const susp = axle.suspension;
        suspensionJoint.setLimits(0, susp.travel); // hard stops: [full compression, full extension]
        if (susp.stiffness !== 0 || susp.damping !== 0) {
          suspensionJoint.configureMotorModel(springModel);
          // The spring: an ABSOLUTE position target. Deliberately UNclamped:
          // restLength > travel presses k·(restLength − travel) into the
          // extension stop — preload, a valid static state.
          suspensionJoint.configureMotorPosition(susp.restLength, susp.stiffness, susp.damping);
        }
        // else: k=0 ∧ c=0 would 0/0-freeze the axis in-engine (measured) —
        // configuring NO motor is the honest free slider between the stops
        // (the S0 "gain-0 motor ≡ no motor" equivalence).
        hub = { body: hubBody, collider: hubCollider, record: rec };
      }
      // Wheel body + collider: the S0 kernel's statements, unchanged; an S1
      // wheel spawns coincident with its hub (origin-origin revolute).
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p.world.x, p.world.y, p.world.z)
          .setRotation(rotation) // base rotation = chassis base rotation (hinge-frame contract)
          .setLinvel(linvel.x, linvel.y, linvel.z)
          .setCcdEnabled(true)
          .setSoftCcdPrediction(SOFT_CCD_PREDICTION)
      );
      createdWheelBodies.push(body);
      const collider = world.createCollider(
        RAPIER.ColliderDesc.cylinder(w.width / 2, w.radius) // Rapier wants the HALF-height
          .setRotation(WHEEL_COLLIDER_ROTATION)
          .setDensity(w.density)
          .setFriction(wheelFriction)
          .setCollisionGroups(WHEEL_GROUPS),
        body
      );
      // Post-create sanity, fail-loud — deliberately mirrors realizeChassis's
      // guard (defense in depth). For a pre-validated cylinder it cannot fire
      // today (Rapier derives the same density·π·r²·width, f32-bounded well
      // under 1e-3), but the same-shaped guard on the chassis DOES catch the
      // coplanar-hull zero-volume case, so the symmetry is kept, not dead
      // code to prune. The 1e-3 relative band vs the IR mass covers f32.
      const m = body.mass();
      if (!Number.isFinite(m) || !(m > 0)) {
        throw new Error(`${label}: wheel mass ${m} is not finite and positive`);
      }
      if (Math.abs(m - w.mass) > 1e-3 * Math.max(1, w.mass)) {
        throw new Error(`${label}: realized wheel mass ${m} drifted from IR mass ${w.mass}`);
      }
      const inv = body.invPrincipalInertia();
      if (![inv.x, inv.y, inv.z].every(Number.isFinite)) {
        throw new Error(`${label}: non-finite wheel inertia`);
      }
      // The drive revolute: S0 hangs the wheel on the CHASSIS at the local
      // anchor; S1 hangs it on the HUB (hub and wheel share a center, so
      // both anchors are body origins). LEDGER BEFORE the motor config.
      const driveJoint = world.createImpulseJoint(
        p.suspensionType === 'S1'
          ? RAPIER.JointData.revolute(ORIGIN, ORIGIN, REVOLUTE_AXIS)
          : RAPIER.JointData.revolute(p.local, ORIGIN, REVOLUTE_AXIS),
        p.suspensionType === 'S1' ? hub.body : chassis.body,
        body,
        true
      );
      createdDriveJoints.push(driveJoint);
      const gain = motorGain.get(w); // undefined ⇒ undriven or zero-torque (no motor)
      if (gain !== undefined) {
        driveJoint.configureMotorModel(motorModel);
        // gain validated finite pre-world; stall MAGNITUDE = gain × |targetAngvel|
        // = driveTorque, signed by sign(targetAngvel). [V10] — unchanged by S1.
        driveJoint.configureMotorVelocity(targetAngvel, gain);
      }
      wheels.push({
        axleIndex: p.axleIndex,
        wheelIndex: p.wheelIndex,
        suspensionType: p.suspensionType,
        hub,
        suspensionJoint,
        wheel: { body, collider },
        driveJoint,
        irWheel: w,
      });
    }
  } catch (err) {
    // Unwind everything this call created, strict reverse dependency order:
    for (let i = createdDriveJoints.length - 1; i >= 0; i--) world.removeImpulseJoint(createdDriveJoints[i], false);
    for (let i = createdSuspensionJoints.length - 1; i >= 0; i--) world.removeImpulseJoint(createdSuspensionJoints[i], false);
    for (let i = createdWheelBodies.length - 1; i >= 0; i--) world.removeRigidBody(createdWheelBodies[i]);
    for (let i = createdHubBodies.length - 1; i >= 0; i--) world.removeRigidBody(createdHubBodies[i]);
    world.removeRigidBody(chassis.body);
    throw err;
  }
  // REALIZED mass readbacks (f32-bounded) — deliberately distinct from the
  // IR's CANONICAL estimates (exact for cuboid families, a documented proxy
  // for hull chassis); wheel and hub bodies were cross-checked against their
  // IR records above.
  const massChassis = chassis.body.mass();
  const massWheels = wheels.reduce((s, st) => s + st.wheel.body.mass(), 0);
  const massHubs = wheels.reduce((s, st) => s + (st.hub ? st.hub.body.mass() : 0), 0);
  return {
    chassis,
    wheels,
    mass: { chassis: massChassis, wheels: massWheels, hubs: massHubs, total: massChassis + massWheels + massHubs },
  };
}

// Realize a compiled assembly IR with EXPLICIT per-axle suspension dispatch:
//   S0 → chassis —revolute(REVOLUTE_AXIS)— wheel            (the S0 kernel, unchanged)
//   S1 → chassis —prismatic(SUSPENSION_AXIS)— hub —revolute(REVOLUTE_AXIS)— wheel
//   S2 → rejected pre-world, fail-loud (legal IR data until its own realizer)
// No implicit default-to-S0: an unknown type string is rejected pre-world.
//
// Contract (the S0 kernel contract, extended):
//   1. ALL validation runs before the world is touched — including every S1
//      spring parameter, every stored hub record vs the assembly.js policy,
//      ir.mass.hubsTotal, and the S1 API surface (prototype checks).
//   2. A failure after partial construction unwinds drive joints →
//      suspension joints → wheel bodies → hub bodies → chassis; world
//      body/collider/joint counts provably unchanged. Joints enter the
//      ledger BEFORE they are configured, so a throw inside setLimits/
//      configureMotor* unwinds too.
//   3. Every dynamic body shares the chassis base rotation and spawn linvel
//      (hinge frames agree in world space; step-0 quiescence). Wheels carry
//      WHEEL_GROUPS + dual CCD; hubs carry HUB_GROUPS (touch NOTHING) + dual
//      CCD via a small policy cylinder whose ONLY job is creation-time
//      mass/inertia readback. No body but the chassis gets additional solver
//      iterations — the island inherits the chassis budget ([V2]).
//   4. S1 spring = setLimits(0, travel) + ForceBased
//      configureMotorPosition(restLength, stiffness, damping) on the
//      prismatic; spawn is QUIESCENT at clamp(restLength, 0, travel). Drive
//      motors reuse the S0 [V10] gain conversion unchanged, configured on
//      the hub→wheel revolute for S1 stations.
//   5. NOTHING here (or anywhere) applies forces/impulses, writes angular
//      velocities, or re-poses bodies after creation — suspension and drive
//      are joint-motor causality only.
//
// Returns {
//   chassis: { body, colliders },
//   wheels: [ { axleIndex, wheelIndex, suspensionType,   // one per STATION
//               hub: { body, collider, record } | null,  // null for S0
//               suspensionJoint | null,                  // prismatic; null for S0
//               wheel: { body, collider }, driveJoint, irWheel } ],
//   mass: { chassis, wheels, hubs, total },              // REALIZED readbacks
// }
// (One record per wheel STATION, named `wheels`: "module" already means the
// per-axle IR record, and a paired module owns TWO stations.) A zero-axle IR
// realizes chassis-only (the legal sled); zero driven wheels realize
// free-rolling.
export function realizeVehicle(RAPIER, world, ir, options = {}) {
  const v = validateVehicleIR(RAPIER, ir, options, { label: 'realizeVehicle', s0Only: false });
  return constructVehicle(RAPIER, world, ir, v);
}

// The S0-only compatibility wrapper (the original S0-kernel entry point):
// identical fail-loud contract — any S1/S2 axle is rejected pre-world with
// the original message — and the LEGACY return shape { chassis, wheels:
// [{ axleIndex, wheelIndex, body, collider, joint, irWheel }] }. Existing S0
// tests consume this unchanged; new code should call realizeVehicle.
export function realizeS0Vehicle(RAPIER, world, ir, options = {}) {
  const v = validateVehicleIR(RAPIER, ir, options, { label: 'realizeS0Vehicle', s0Only: true });
  const rec = constructVehicle(RAPIER, world, ir, v);
  return {
    chassis: rec.chassis,
    wheels: rec.wheels.map(({ axleIndex, wheelIndex, wheel, driveJoint, irWheel }) => ({
      axleIndex,
      wheelIndex,
      body: wheel.body,
      collider: wheel.collider,
      joint: driveJoint,
      irWheel,
    })),
  };
}
