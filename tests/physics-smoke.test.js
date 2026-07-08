import { describe, test, expect } from 'vitest';

// Verifies [V8] (headless Node execution for CI) and half of [V7]
// (both package flavors resolve and run under this toolchain).
// Cross-PLATFORM determinism is CI's job over time; here we assert
// local run-to-run determinism per flavor.

const FIXED_DT = 1 / 60;

function dropTest(RAPIER) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.1, 10));
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0.2, 3, -0.1).setCcdEnabled(true)
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
  for (let i = 0; i < 240; i++) world.step(); // 4 simulated seconds
  const p = body.translation();
  const result = { x: p.x, y: p.y, z: p.z };
  world.free();
  return result;
}

describe.each([
  ['@dimforge/rapier3d-compat', 'default flavor'],
  ['@dimforge/rapier3d-deterministic-compat', 'deterministic flavor'],
])('%s (%s)', (pkg) => {
  test('initializes headless, cube falls, settles on ground, run-to-run identical', async () => {
    const RAPIER = (await import(pkg)).default;
    await RAPIER.init();

    const a = dropTest(RAPIER);
    // Fell from y=3 and rests on the ground slab (half-extent 0.5 on 0.1 slab ≈ 0.6).
    expect(a.y).toBeLessThan(1.0);
    expect(a.y).toBeGreaterThan(0.3);

    const b = dropTest(RAPIER);
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    expect(b.z).toBe(a.z);
  });
});
