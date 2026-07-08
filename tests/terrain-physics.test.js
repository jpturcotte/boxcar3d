import { describe, test, expect } from 'vitest';
import { createPhysics, addCorridor, addHeightfield } from '../src/sim/physics/adapter.js';
import { generateCorridorTerrain, craterDepthAt } from '../src/sim/terrain.js';
import { Rng } from '../src/sim/prng.js';

// Terrain realized in a real Rapier world. The generated field is pure JS, so it
// is flavor-independent; we deliberately use the default (non-deterministic-
// compat) flavor via createPhysics(), matching src/main.js. GRAVITY (=20) and
// FIXED_DT come from the adapter.
//
// NOTE: this is a PROVISIONAL Step-1a floor/wall smoke gate — NOT the canonical
// terrain fall-through criterion. That remains the 1,000-spawn chassis-only drop
// test (Phase 0 success #1, checklist step 1b/3), landing with real chassis.
// This smoke gate runs the default flavor only (the field is pure JS, so it is
// flavor-independent); the canonical 1,000-spawn gate SHOULD exercise both
// flavors, the way physics-smoke.test.js does.

const R = 0.5;
const STEPS = 300; // 5 s at 1/60

describe('corridor realized in Rapier (provisional Step-1a catch gate)', () => {
  test('20 seeded spheres land ON the surface band — caught, none tunnel', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: false });
    // Pinned to craterDensity: 0 (Step 1b): this terrain is byte-identical to
    // what the test has always run, so the band assertions keep exactly the
    // strength they were reviewed at — they were calibrated for base-noise
    // slopes, not crater rims, and leaving defaults here would invisibly couple
    // the gate to crater tuning at one arbitrary seed. Crater'd-surface physics
    // is covered by the dedicated crater-probe tests below; the canonical
    // 1,000-spawn gate (step 3) runs full defaults on both flavors.
    const terrain = generateCorridorTerrain({ seed: 4242, craterDensity: 0 });
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
      // The sphere's lowest point is directly below its center at this exact
      // (x,z), so no-penetration forces center.y >= surfaceY + R (minus a little
      // contact-solver slop) — slope-independent. A half-sunk body (center near
      // surfaceY) must FAIL, not just a fully-tunnelled one. Upper bound leaves
      // room for roll/bounce and gentle slopes. (Codex review.)
      expect(p.y).toBeGreaterThan(surfaceY + R - 0.1);
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
      // Inner wall face is at |z| = halfWid, so a contained sphere's CENTER stops
      // ~R short of it: assert |z| < halfWid - R (+ slop), not halfWid + R — the
      // latter would pass a sphere sitting a full radius past the inner face.
      // (Codex review.)
      expect(Math.abs(p.z)).toBeLessThan(halfWid - R + 0.1);
      expect(p.y).toBeGreaterThan(-50); // still in play, not launched out or tunnelled
    }
    world.free();
  });
});

// Step 1b: the crater bake is physically present in the collider. Twin fields
// (default vs craterDensity 0, same seed) as two static heightfields in ONE
// world — static-vs-static pairs generate no contacts, so they are inert to
// each other, and the predicate-filter castRay pattern (proven above) isolates
// whichever floor each probe targets. No new realization surface: only the
// existing addHeightfield seam. One world.step() first, per [V1].
describe('crater bake realized in Rapier (castRay probe, seed 20260708)', () => {
  const SEED = 20260708;

  // Deterministically pick a crater whose probe points only IT influences:
  // largest radius such that the OTHER craters contribute nothing at its
  // center and mid-rim, and NOTHING at all contributes at the outside point
  // (center + (radius+2) along +X, also kept inside the field).
  function chooseIsolatedCrater(terrain) {
    const { length } = terrain.bounds;
    const candidates = terrain.craters
      .filter((c) => {
        const others = terrain.craters.filter((o) => o !== c);
        const outsideX = c.x + c.radius + 2;
        return (
          outsideX <= length / 2 &&
          craterDepthAt(c.x, c.z, others) === 0 &&
          craterDepthAt(c.x + 0.5 * c.radius, c.z, others) === 0 &&
          craterDepthAt(outsideX, c.z, terrain.craters) === 0
        );
      })
      .sort((a, b) => b.radius - a.radius);
    return candidates[0];
  }

  test('castRay: full depth at the center, ~0 outside, intermediate on the rim', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: false });
    const cratered = generateCorridorTerrain({ seed: SEED });
    const flat = generateCorridorTerrain({ seed: SEED, craterDensity: 0 });
    const crateredFloor = addHeightfield(RAPIER, world, cratered);
    const flatFloor = addHeightfield(RAPIER, world, flat);
    world.step(); // build the query BVH ([V1])

    const probeY = (x, z, target) => {
      const ray = new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(
        ray, 100, true, undefined, undefined, undefined, undefined,
        (collider) => collider.handle === target.handle
      );
      return hit === null ? null : 50 - hit.timeOfImpact;
    };

    const c = chooseIsolatedCrater(cratered);
    expect(c).toBeDefined(); // fails loud if the seed has no isolated crater
    const d = (x, z) => probeY(x, z, flatFloor) - probeY(x, z, crateredFloor);
    // Bands, not tight equality: the ray hits Rapier's triangle interpolation of
    // the baked vertices (exact shape is already vertex-pinned in terrain.test.js).
    expect(d(c.x, c.z)).toBeGreaterThan(0.7 * c.depth); // depression is there
    expect(Math.abs(d(c.x + c.radius + 2, c.z))).toBeLessThan(0.02); // zero support outside
    const rim = d(c.x + 0.5 * c.radius, c.z); // mid-rim: smootherstep, not a cliff
    expect(rim).toBeGreaterThan(0.2 * c.depth); // a missing crater fails low
    expect(rim).toBeLessThan(0.8 * c.depth); // a cylinder-cliff bake fails high
    world.free();
  });

  test('a dropped sphere settles on the crater floor band, not the base surface', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: false });
    const cratered = generateCorridorTerrain({ seed: SEED });
    const floor = addHeightfield(RAPIER, world, cratered);
    const c = chooseIsolatedCrater(cratered);
    expect(c).toBeDefined();

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(c.x, 20, c.z).setCcdEnabled(true)
    );
    world.createCollider(RAPIER.ColliderDesc.ball(R), body);
    for (let step = 0; step < STEPS; step++) world.step();

    const p = body.translation();
    const ray = new RAPIER.Ray({ x: p.x, y: 50, z: p.z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(
      ray, 100, true, undefined, undefined, undefined, undefined,
      (collider) => collider.handle === floor.handle
    );
    expect(hit).not.toBeNull();
    const surfaceY = 50 - hit.timeOfImpact;
    // Same surface-band assertion as the 20-sphere gate, but on crater'd ground:
    // the sphere rests ON the local (crater) surface — caught, not tunnelled.
    expect(p.y).toBeGreaterThan(surfaceY + R - 0.1);
    expect(p.y).toBeLessThan(surfaceY + R + 0.6);
    // And it actually sat in the bowl: inside the crater disc, below base level.
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThan(c.radius);
    world.free();
  });
});
