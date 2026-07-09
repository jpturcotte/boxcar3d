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
