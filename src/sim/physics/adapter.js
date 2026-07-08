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

export const FIXED_DT = 1 / 60;

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

// Realize a generated corridor (floor heightfield + the two walls) into a world.
export function addCorridor(RAPIER, world, terrain) {
  const floor = addHeightfield(RAPIER, world, {
    rows: terrain.rows,
    cols: terrain.cols,
    heights: terrain.heights,
    scale: terrain.scale,
    friction: terrain.floorFriction,
  });
  const walls = terrain.walls.map((w) => addStaticBox(RAPIER, world, w));
  return { floor, walls };
}
