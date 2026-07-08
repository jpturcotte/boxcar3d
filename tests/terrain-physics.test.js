import { describe, test, expect } from 'vitest';
import { createPhysics, addCorridor } from '../src/sim/physics/adapter.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { Rng } from '../src/sim/prng.js';

// Terrain realized in a real Rapier world. The generated field is pure JS, so it
// is flavor-independent; we deliberately use the default (non-deterministic-
// compat) flavor via createPhysics(), matching src/main.js. GRAVITY (=20) and
// FIXED_DT come from the adapter.
//
// NOTE: this is a PROVISIONAL Step-1a floor/wall smoke gate — NOT the canonical
// terrain fall-through criterion. That remains the 1,000-spawn chassis-only drop
// test (Phase 0 success #1, checklist step 1b/3), landing with real chassis.

const R = 0.5;
const STEPS = 300; // 5 s at 1/60

describe('corridor realized in Rapier (provisional Step-1a catch gate)', () => {
  test('20 seeded spheres land ON the surface band — caught, none tunnel', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: false });
    const terrain = generateCorridorTerrain({ seed: 4242 });
    const { floor } = addCorridor(RAPIER, world, terrain);

    const halfLen = terrain.scale.x / 2; // 60
    const halfWid = terrain.scale.z / 2; // 6
    const marginX = 6;
    const marginZ = 2;
    const rng = new Rng(0xc0ffee);
    const bodies = [];
    for (let i = 0; i < 20; i++) {
      const s = rng.fork(i); // per-body stream (shard-invariant pattern)
      const x = s.range(-halfLen + marginX, halfLen - marginX);
      const z = s.range(-halfWid + marginZ, halfWid - marginZ);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 20, z).setCcdEnabled(true)
      );
      world.createCollider(RAPIER.ColliderDesc.ball(R), body);
      bodies.push(body);
    }

    for (let step = 0; step < STEPS; step++) world.step();

    // Local surface height under a sphere: cast straight down, but only accept
    // the floor collider (ignore the spheres themselves and the walls).
    const surfaceYAt = (x, z) => {
      const ray = new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(
        ray, 100, true, undefined, undefined, undefined, undefined,
        (collider) => collider.handle === floor.handle
      );
      return hit === null ? null : 50 - hit.timeOfImpact;
    };

    for (const body of bodies) {
      const p = body.translation();
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThan(-50); // safety-plane gate (no physical catcher below)
      const surfaceY = surfaceYAt(p.x, p.z);
      expect(surfaceY).not.toBeNull();
      // Resting sphere center sits at surfaceY + R; allow slight penetration and
      // residual roll/bounce, but a tunnelled body would be far below surfaceY.
      expect(p.y).toBeGreaterThan(surfaceY - 0.1);
      expect(p.y).toBeLessThan(surfaceY + R + 0.6);
    }
    world.free();
  });

  test('walls physically contain: laterally-driven spheres stay in the corridor', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: false });
    const terrain = generateCorridorTerrain({ seed: 99 });
    addCorridor(RAPIER, world, terrain);

    const halfWid = terrain.scale.z / 2; // 6
    const shots = [
      { x: 0, z: 0, vz: 30 },
      { x: 20, z: 0, vz: -30 },
      { x: -20, z: 2, vz: 30 },
    ];
    const bodies = shots.map(({ x, z, vz }) => {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 5, z).setLinvel(0, 0, vz).setCcdEnabled(true)
      );
      world.createCollider(RAPIER.ColliderDesc.ball(R), body);
      return body;
    });

    for (let step = 0; step < STEPS; step++) world.step();

    for (const body of bodies) {
      const p = body.translation();
      // Never escapes past a wall (inner face at |z| = halfWid; center stops ~R short).
      expect(Math.abs(p.z)).toBeLessThan(halfWid + R);
      expect(p.y).toBeGreaterThan(-50); // still in play, not launched out or tunnelled
    }
    world.free();
  });
});
