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
