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
import { wheelMass, ASSEMBLY_IR_VERSION } from '../assembly.js';

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
// >>> 0 keeps the pack unsigned once a membership bit reaches 0x8000
// (Rapier expects a u32). Neutral name: setSolverGroups packs identically.
export const packGroups = (membership, filter) => ((membership << 16) | filter) >>> 0;
export const GROUND_GROUPS = packGroups(GROUP_GROUND, GROUP_GROUND | GROUP_CHASSIS | GROUP_WHEEL);
export const CHASSIS_GROUPS = packGroups(GROUP_CHASSIS, GROUP_GROUND);
export const WHEEL_GROUPS = packGroups(GROUP_WHEEL, GROUP_GROUND);

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

// Realize a compiled all-S0 assembly IR: the chassis (via realizeChassis)
// plus one wheel body + revolute joint (+ motor when driven) per IR wheel.
// The name states the supported suspension level — this is NOT a general
// realizeVehicle; S1/S2 dispatch does not exist yet.
//
// Contract (mirrors realizeChassis, extended to a multi-body transaction):
//   1. ALL validation runs before the world is touched. S1/S2 axles are
//      rejected HERE — never in repair/compile, where they stay legal IR data
//      (the 24cd0dd5 corpus lock and the every-suspension-type assertion
//      depend on it) — so an S1/S2 module can never silently realize as a
//      rigid axle.
//   2. A failure after partial construction removes every joint and body this
//      call created (joints first, reverse order, then wheel bodies, then the
//      chassis) — world body/collider/joint counts provably unchanged.
//   3. Wheel bodies carry WHEEL_GROUPS + dual CCD, the SAME base rotation as
//      the chassis (the hinge-frame contract above), and the SAME spawn
//      linvel (a chassis spawned moving with wheels at rest is step-0 joint
//      violence). They do NOT get additional solver iterations — the chassis
//      carries the joint-island budget ([V2] note at the constant).
//   4. Driven wheels with driveTorque > 0 get the ForceBased motor with the
//      documented gain conversion. Undriven or zero-torque wheels get no
//      motor configuration at all — a driven wheel CAN legally carry
//      driveTorque 0 (power gene 0, or a zero share), and a gain-0 motor is
//      behaviorally identical to no motor at every speed, so skipping it is
//      an equivalence, not a deviation from "driven ⇒ motor".
//
// Returns { chassis: { body, colliders }, wheels: [{ axleIndex, wheelIndex,
// body, collider, joint, irWheel }] }. A zero-axle IR realizes chassis-only
// with wheels: [] (the legal sled); zero driven wheels realize free-rolling.
export function realizeS0Vehicle(RAPIER, world, ir, options = {}) {
  const {
    position = { x: 0, y: 0, z: 0 },
    rotation = { x: 0, y: 0, z: 0, w: 1 },
    linvel = { x: 0, y: 0, z: 0 },
    targetAngvel = MOTOR_TARGET_ANGVEL,
    wheelFriction = WHEEL_FRICTION,
  } = options;

  // --- Validation: everything before the world is touched -------------------
  if (!ir || ir.version !== ASSEMBLY_IR_VERSION || !Array.isArray(ir.axles)) {
    throw new Error(`realizeS0Vehicle: malformed IR (need assembly IR version ${ASSEMBLY_IR_VERSION} and an axles array)`);
  }
  // Resolve the motor model by name, fail-loud (the [V2] convention for
  // Rapier bumps): a missing member means the motor API changed and the S0
  // ruling must be re-verified, never silently re-mapped.
  const motorModel = RAPIER.MotorModel ? RAPIER.MotorModel[S0_MOTOR_MODEL_NAME] : undefined;
  if (typeof motorModel !== 'number') {
    throw new Error(`realizeS0Vehicle: RAPIER.MotorModel.${S0_MOTOR_MODEL_NAME} is missing — re-verify the S0 motor ruling against this Rapier build`);
  }
  let anyMotor = false;
  ir.axles.forEach((axle, i) => {
    if (!axle || !Number.isFinite(axle.posX) || !Number.isFinite(axle.mountY)) {
      throw new Error(`realizeS0Vehicle: axles[${i}] needs finite posX and mountY`);
    }
    const type = axle.suspension && axle.suspension.type;
    if (type !== 'S0') {
      throw new Error(`realizeS0Vehicle: axles[${i}].suspension.type '${String(type)}' — the S0 kernel realizes only S0; S1/S2 stay legal IR data and need their own realizer`);
    }
    if (!Array.isArray(axle.wheels) || axle.wheels.length === 0) {
      throw new Error(`realizeS0Vehicle: axles[${i}].wheels must be a non-empty array`);
    }
    axle.wheels.forEach((w, j) => {
      const at = `axles[${i}].wheels[${j}]`;
      if (!w) throw new Error(`realizeS0Vehicle: ${at} is missing`);
      for (const k of ['radius', 'width', 'density', 'mass']) {
        if (!Number.isFinite(w[k]) || !(w[k] > 0)) {
          throw new Error(`realizeS0Vehicle: ${at}.${k} must be a finite number > 0 (${String(w[k])})`);
        }
      }
      if (!Number.isFinite(w.z)) throw new Error(`realizeS0Vehicle: ${at}.z must be finite (${String(w.z)})`);
      if (typeof w.driven !== 'boolean') throw new Error(`realizeS0Vehicle: ${at}.driven must be a boolean (${String(w.driven)})`);
      if (!Number.isFinite(w.driveTorque) || w.driveTorque < 0) {
        throw new Error(`realizeS0Vehicle: ${at}.driveTorque must be a finite number >= 0 (${String(w.driveTorque)})`);
      }
      // The IR computes mass via assembly.js's wheelMass (the ONE π·r²·w·ρ
      // source, shared so this guard can never drift from the formula); a
      // disagreement means hand-edited IR data whose density and mass would
      // realize different physics than the schema promised.
      const derived = wheelMass(w.radius, w.width, w.density);
      if (Math.abs(w.mass - derived) > 1e-9 * Math.max(1, w.mass)) {
        throw new Error(`realizeS0Vehicle: ${at}.mass ${w.mass} disagrees with π·r²·width·density = ${derived}`);
      }
      if (w.driven && w.driveTorque > 0) anyMotor = true;
    });
  });
  if (!finiteVec(position) || !finiteVec(linvel) || !finiteVec(rotation) || !Number.isFinite(rotation.w)) {
    throw new Error('realizeS0Vehicle: non-finite spawn pose');
  }
  // Stricter than realizeChassis: wheel centers are computed by rotating
  // local points with this quaternion, so a non-unit value would silently
  // misplace every wheel relative to Rapier's internally normalized use.
  const norm2 = rotation.x * rotation.x + rotation.y * rotation.y + rotation.z * rotation.z + rotation.w * rotation.w;
  if (Math.abs(norm2 - 1) > 1e-6) {
    throw new Error(`realizeS0Vehicle: spawn rotation must be a unit quaternion (|q|² = ${norm2})`);
  }
  if (!Number.isFinite(targetAngvel)) {
    throw new Error(`realizeS0Vehicle: targetAngvel must be finite (${String(targetAngvel)})`);
  }
  // The gain conversion divides by |targetAngvel| — a zero-target motor
  // request is rejected loud, never divided. A fully undriven IR accepts any
  // finite target (nothing consumes it).
  if (anyMotor && targetAngvel === 0) {
    throw new Error('realizeS0Vehicle: targetAngvel 0 with driven wheels — the gain conversion needs a nonzero no-load speed');
  }
  if (!Number.isFinite(wheelFriction) || wheelFriction < 0) {
    throw new Error(`realizeS0Vehicle: wheelFriction must be a finite number >= 0 (${String(wheelFriction)})`);
  }
  // Derive every motor gain NOW, pre-world: gain = driveTorque / |targetAngvel|
  // (the ruling's conversion). Rejecting only targetAngvel === 0 was not
  // enough — a finite but denormal-tiny target (e.g. Number.MIN_VALUE) sends
  // driveTorque / |target| to Infinity, a non-finite gain that must fail loud
  // HERE, never reach configureMotorVelocity after bodies/joints exist. The
  // validated gains are stored so the construction loop consumes them (one
  // source, never recomputed). No magnitude floor: a large finite gain (e.g.
  // 6.25e9 at target 1e-8) is stable over 600 steps in-probe, so only
  // non-finite is out of domain — matching the "fail loud on garbage, don't
  // over-restrict valid input" convention.
  const invTarget = 1 / Math.abs(targetAngvel);
  const motorGain = new Map();
  for (const axle of ir.axles) {
    for (const w of axle.wheels) {
      if (w.driven && w.driveTorque > 0) {
        const gain = w.driveTorque * invTarget;
        if (!Number.isFinite(gain)) {
          throw new Error(`realizeS0Vehicle: motor gain ${gain} (driveTorque ${w.driveTorque} / |targetAngvel| ${Math.abs(targetAngvel)}) is not finite — targetAngvel is too small`);
        }
        motorGain.set(w, gain);
      }
    }
  }

  // --- Construction (transactional) -----------------------------------------
  const placements = s0WheelTransforms(ir, { position, rotation });
  const chassis = realizeChassis(RAPIER, world, ir, { position, rotation, linvel });
  const wheels = [];
  const createdBodies = [];
  const createdJoints = [];
  try {
    for (const p of placements) {
      const w = ir.axles[p.axleIndex].wheels[p.wheelIndex];
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p.world.x, p.world.y, p.world.z)
          .setRotation(rotation) // base rotation = chassis base rotation (hinge-frame contract)
          .setLinvel(linvel.x, linvel.y, linvel.z)
          .setCcdEnabled(true)
          .setSoftCcdPrediction(SOFT_CCD_PREDICTION)
      );
      createdBodies.push(body);
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
        throw new Error(`realizeS0Vehicle: wheel mass ${m} is not finite and positive`);
      }
      if (Math.abs(m - w.mass) > 1e-3 * Math.max(1, w.mass)) {
        throw new Error(`realizeS0Vehicle: realized wheel mass ${m} drifted from IR mass ${w.mass}`);
      }
      const inv = body.invPrincipalInertia();
      if (![inv.x, inv.y, inv.z].every(Number.isFinite)) {
        throw new Error('realizeS0Vehicle: non-finite wheel inertia');
      }
      const joint = world.createImpulseJoint(
        RAPIER.JointData.revolute(p.local, { x: 0, y: 0, z: 0 }, REVOLUTE_AXIS),
        chassis.body,
        body,
        true
      );
      createdJoints.push(joint);
      const gain = motorGain.get(w); // undefined ⇒ undriven or zero-torque (no motor)
      if (gain !== undefined) {
        joint.configureMotorModel(motorModel);
        // gain validated finite pre-world; stall MAGNITUDE = gain × |targetAngvel|
        // = driveTorque, signed by sign(targetAngvel).
        joint.configureMotorVelocity(targetAngvel, gain);
      }
      wheels.push({ axleIndex: p.axleIndex, wheelIndex: p.wheelIndex, body, collider, joint, irWheel: w });
    }
  } catch (err) {
    // Unwind everything this call created: joints first (reverse), then
    // wheel bodies (their colliders go with them), then the chassis.
    for (let i = createdJoints.length - 1; i >= 0; i--) world.removeImpulseJoint(createdJoints[i], false);
    for (let i = createdBodies.length - 1; i >= 0; i--) world.removeRigidBody(createdBodies[i]);
    world.removeRigidBody(chassis.body);
    throw err;
  }
  return { chassis, wheels };
}
