// Feature colliders + collision groups in a real Rapier world, BOTH flavors
// (describe.each × createPhysics — the physics-smoke pattern through the
// adapter seam, per F10: every test declares its seed; exactness is only ever
// asserted per-flavor run-to-run, never across flavors).
//
// Ray probes use predicate filters (collider.handle ===), so overlapping
// features never contaminate each other's assertions; only the drop test
// needs a spatially isolated target.

import { describe, test, expect } from 'vitest';
import {
  CHASSIS_GROUPS,
  GROUP_CHASSIS,
  GROUP_GROUND,
  GROUP_WHEEL,
  GROUND_GROUPS,
  addCorridor,
  addCorridorWithFeatures,
  addFeatures,
  createPhysics,
  packGroups,
} from '../src/sim/physics/adapter.js';
import { featureGeometry } from '../src/sim/features.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';

const SEED = 20260708; // the repo's locked-fingerprint seed
const EMBED = 0.05; // addFeatures default embedDepth
const R = 0.5; // probe sphere radius (matches the terrain-physics gate)

// Full composite realization + one extra step so the query BVH includes the
// feature colliders (they were added after addFeatures' own [V1] step).
async function realize(deterministic) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  const terrain = generateCorridorTerrain({ seed: SEED });
  const built = addCorridorWithFeatures(RAPIER, world, terrain);
  world.step();
  return { RAPIER, world, terrain, ...built };
}

// Surface probes, predicate-filtered so overlapping colliders can't
// contaminate each other (same idiom as tests/terrain-physics.test.js).
const downOnto = (RAPIER, world, x, z, target) => {
  const ray = new RAPIER.Ray({ x, y: 60, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, 200, true, undefined, undefined, undefined, undefined, (c) => c.handle === target.handle);
  return hit === null ? null : 60 - hit.timeOfImpact;
};
const upOnto = (RAPIER, world, x, z, target) => {
  const ray = new RAPIER.Ray({ x, y: -40, z }, { x: 0, y: 1, z: 0 });
  const hit = world.castRay(ray, 200, true, undefined, undefined, undefined, undefined, (c) => c.handle === target.handle);
  return hit === null ? null : -40 + hit.timeOfImpact;
};

// Bounding disc for spatial isolation (drop test only — ray tests don't care).
const disc = (f) =>
  f.type === 'boulder' ? f.dims.radius
    : f.type === 'ramp' ? Math.sqrt((f.dims.length / 2) ** 2 + (f.dims.width / 2) ** 2)
      : f.dims.length / 2 + f.dims.radius;
const isIsolated = (f, all) =>
  all.every((o) => o === f || Math.sqrt((f.x - o.x) ** 2 + (f.z - o.z) ** 2) > disc(f) + disc(o) + 1.5);

describe('collision-group constants (pure values)', () => {
  test('packGroups packs membership<<16 | filter, unsigned', () => {
    expect(packGroups(GROUP_GROUND, GROUP_GROUND | GROUP_CHASSIS | GROUP_WHEEL)).toBe(0x00010007);
    expect(packGroups(GROUP_CHASSIS, GROUP_GROUND)).toBe(0x00020001);
    expect(packGroups(GROUP_WHEEL, GROUP_GROUND)).toBe(0x00040001);
    // unsigned even when the future membership uses the top bit
    expect(packGroups(0x8000, 0x0001)).toBe(0x80000001);
  });

  test('GROUND_GROUPS is the packed ground policy', () => {
    expect(GROUND_GROUPS).toBe(0x00010007);
  });
});

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('feature colliders (deterministic=%s, %s)', (deterministic) => {
  test('wiring: floor, walls, and every feature collider carry GROUND_GROUPS', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const terrain = generateCorridorTerrain({ seed: SEED });
      const { floor, walls, features } = addCorridorWithFeatures(RAPIER, world, terrain);
      expect(features).toHaveLength(terrain.features.length);
      expect(features.length).toBeGreaterThan(0);
      for (const c of [floor, ...walls, ...features.map((f) => f.collider)]) {
        expect(c.collisionGroups()).toBe(GROUND_GROUPS);
      }
    } finally {
      world.free();
    }
  });

  test('seating: real collider never buried past embedDepth, and the seating rule embeds the governing support exactly', { timeout: 20000 }, async () => {
    const { RAPIER, world, floor, features } = await realize(deterministic);
    try {
      for (const r of features) {
        const f = r.feature;
        const deltas = [];
        const modeledGaps = []; // bodyY + bottomOffset_i − floorY_i, the analytic underside vs terrain
        for (const s of featureGeometry(f).supportSamples) {
          const bottom = upOnto(RAPIER, world, f.x + s.dx, f.z + s.dz, r.collider);
          const floorY = downOnto(RAPIER, world, f.x + s.dx, f.z + s.dz, floor);
          expect(floorY).not.toBeNull();
          modeledGaps.push(r.position.y + s.bottomOffset - floorY);
          // A lopsided boulder hull may not cover an outer compass sample —
          // an upward ray that misses proves nothing either way. The center
          // ray must hit for every type (the collider exists where placed).
          if (bottom === null) {
            expect(s.dx !== 0 || s.dz !== 0).toBe(true);
            continue;
          }
          deltas.push(bottom - floorY);
        }
        expect(deltas.length).toBeGreaterThan(0);
        // The REAL collider (up-ray) is never buried past the deliberate embed:
        for (const d of deltas) expect(d).toBeGreaterThanOrEqual(-(EMBED + 0.02));
        // The seating RULE, checked exactly: bodyY = max_i(floorY_i − bottomOffset_i)
        // − embed, so min_i(bodyY + bottomOffset_i − floorY_i) == −embed. This one
        // identity catches a floating seat (bodyY too high → value too high) AND an
        // over-sunk seat (too low), for every type — no fragile per-sample up-ray,
        // no thick-slab projection error. (Elongated features still bridge dips:
        // their true lowest footprint corner may embed deeper than embedDepth on a
        // slope — accepted terrain character, verified separately by the footprint
        // scan in the design notes, not asserted here as a per-sample bound.)
        expect(Math.min(...modeledGaps)).toBeCloseTo(-EMBED, 2);
        if (f.type === 'boulder') {
          // Extra tie for boulders: the sample bottomOffset must equal the lowest
          // vertex of the REALIZED hull record (not just a fresh featureGeometry
          // call), proving render/collider consume the same points.
          let minHullY = Infinity;
          for (let i = 1; i < r.points.length; i += 3) minHullY = Math.min(minHullY, r.points[i]);
          expect(featureGeometry(f).supportSamples[0].bottomOffset).toBeCloseTo(minHullY, 12);
        }
      }
    } finally {
      world.free();
    }
  });

  test('presence: every feature stands proud of the floor at its center, within its height budget', { timeout: 20000 }, async () => {
    const { RAPIER, world, floor, features } = await realize(deterministic);
    try {
      for (const r of features) {
        const f = r.feature;
        const top = downOnto(RAPIER, world, f.x, f.z, r.collider);
        const floorY = downOnto(RAPIER, world, f.x, f.z, floor);
        expect(top).not.toBeNull();
        const delta = top - floorY;
        if (f.type === 'boulder') {
          expect(delta).toBeGreaterThan(0.1);
          expect(delta).toBeLessThan(2 * f.dims.radius + 0.2);
        } else if (f.type === 'ramp') {
          expect(delta).toBeGreaterThan(0.1);
          expect(delta).toBeLessThan(f.dims.height + 0.5);
        } else {
          // log at its axis: top - floor = 2r - embed, measured dead-on
          expect(delta).toBeCloseTo(2 * f.dims.radius - EMBED, 1);
        }
      }
    } finally {
      world.free();
    }
  });

  test('a dropped sphere is blocked by an isolated boulder, then settles somewhere solid', { timeout: 20000 }, async () => {
    const { RAPIER, world, terrain, floor, features } = await realize(deterministic);
    try {
      const target = features.find((r) => r.feature.type === 'boulder' && isIsolated(r.feature, terrain.features));
      expect(target).toBeDefined(); // seed 20260708 has two isolated boulders
      const f = target.feature;
      const top = downOnto(RAPIER, world, f.x, f.z, target.collider);
      const floorY = downOnto(RAPIER, world, f.x, f.z, floor);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(f.x, top + 2 + R, f.z).setCcdEnabled(true)
      );
      world.createCollider(RAPIER.ColliderDesc.ball(R), body);
      let yAt40 = null;
      for (let i = 1; i <= 300; i++) {
        world.step();
        if (i === 40) yAt40 = body.translation().y;
      }
      // Blocked: free fall from top+2 reaches the floor band by step ~35
      // (g = 20); at step 40 the sphere must still be held well above it —
      // only the boulder can be holding it (isolated target).
      expect(yAt40).toBeGreaterThan(floorY + R + 0.3);
      // Settled solid: wherever it rolled, it rests in the floor catch band
      // (or higher, if it wedged against something) and never tunneled.
      const p = body.translation();
      expect(p.y).toBeGreaterThan(-50);
      const floorAtRest = downOnto(RAPIER, world, p.x, p.z, floor);
      expect(p.y).toBeGreaterThan(floorAtRest + R - 0.15);
      expect(p.y).toBeLessThan(floorAtRest + R + 2.5);
    } finally {
      world.free();
    }
  });

  // --- Collision-group matrix. The start pad (x = -length/2 + 2) is exactly
  // flat at y = 0 and forced firm, so bands are exact. PAD_X keeps probes
  // clear of every feature (features spawn post-envelope only).
  const PAD_X = -58;

  test('solver positive: a CHASSIS_GROUPS body is caught by grouped ground', { timeout: 20000 }, async () => {
    const { RAPIER, world } = await realize(deterministic);
    try {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(PAD_X, 2, 0).setCcdEnabled(true));
      world.createCollider(RAPIER.ColliderDesc.ball(R), body).setCollisionGroups(CHASSIS_GROUPS);
      for (let i = 0; i < 120; i++) world.step();
      const y = body.translation().y;
      expect(y).toBeGreaterThan(R - 0.1);
      expect(y).toBeLessThan(R + 0.6);
    } finally {
      world.free();
    }
  });

  test('solver negative (the PR #9 ghost proof): filter without GROUND falls through everything', { timeout: 20000 }, async () => {
    const { RAPIER, world } = await realize(deterministic);
    try {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(PAD_X, 2, 0).setCcdEnabled(true));
      // Membership CHASSIS but filter CHASSIS-only: ground pairs fail in one
      // direction, so the floor cannot catch it — it must leave the world.
      world.createCollider(RAPIER.ColliderDesc.ball(R), body).setCollisionGroups(packGroups(GROUP_CHASSIS, GROUP_CHASSIS));
      for (let i = 0; i < 240; i++) world.step();
      expect(body.translation().y).toBeLessThan(-50);
    } finally {
      world.free();
    }
  });

  test('ghost-ghost: two CHASSIS_GROUPS bodies share space without mutual ejection', { timeout: 20000 }, async () => {
    const { RAPIER, world } = await realize(deterministic);
    try {
      const spawn = (y) => {
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(PAD_X, y, 0).setCcdEnabled(true));
        world.createCollider(RAPIER.ColliderDesc.ball(R), body).setCollisionGroups(CHASSIS_GROUPS);
        return body;
      };
      const a = spawn(1.2);
      const b = spawn(2.0); // overlaps a's fall path; ghosts never touch
      for (let i = 0; i < 120; i++) world.step();
      for (const body of [a, b]) {
        const p = body.translation();
        expect(p.y).toBeGreaterThan(R - 0.1);
        expect(p.y).toBeLessThan(R + 0.6); // both rest interpenetrating at the pad
        expect(Math.sqrt((p.x - PAD_X) ** 2 + p.z ** 2)).toBeLessThan(0.3); // no lateral ejection
      }
    } finally {
      world.free();
    }
  });

  test('query path: castRay filterGroups (the real arg, not a predicate) respects the matrix', async () => {
    const { RAPIER, world, floor, features } = await realize(deterministic);
    try {
      const ray = new RAPIER.Ray({ x: PAD_X, y: 10, z: 0 }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 100, true, undefined, CHASSIS_GROUPS);
      expect(hit).not.toBeNull();
      expect(10 - hit.timeOfImpact).toBeCloseTo(0, 1); // the flat pad surface
      // Same ray, filter without GROUND: nothing in the world qualifies.
      expect(world.castRay(ray, 100, true, undefined, packGroups(GROUP_CHASSIS, GROUP_CHASSIS))).toBeNull();
      // Grouped rays see feature colliders too (they are ground):
      const b = features.find((r) => r.feature.type === 'boulder');
      const over = new RAPIER.Ray({ x: b.feature.x, y: 60, z: b.feature.z }, { x: 0, y: -1, z: 0 });
      const grouped = world.castRay(over, 200, true, undefined, CHASSIS_GROUPS);
      const floorOnly = downOnto(RAPIER, world, b.feature.x, b.feature.z, floor);
      expect(grouped).not.toBeNull();
      expect(60 - grouped.timeOfImpact).toBeGreaterThan(floorOnly + 0.05); // hits the boulder before the floor
    } finally {
      world.free();
    }
  });

  test('legacy: an ungrouped (default 0xFFFFFFFF) body still collides with grouped ground', { timeout: 20000 }, async () => {
    const { RAPIER, world } = await realize(deterministic);
    try {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(PAD_X, 2, 0).setCcdEnabled(true));
      world.createCollider(RAPIER.ColliderDesc.ball(R), body);
      for (let i = 0; i < 120; i++) world.step();
      const y = body.translation().y;
      expect(y).toBeGreaterThan(R - 0.1);
      expect(y).toBeLessThan(R + 0.6);
    } finally {
      world.free();
    }
  });

  test('realized poses are run-to-run identical within this flavor', { timeout: 20000 }, async () => {
    const a = await realize(deterministic);
    const b = await realize(deterministic);
    try {
      expect(b.features).toHaveLength(a.features.length);
      for (let i = 0; i < a.features.length; i++) {
        const fa = a.features[i];
        const fb = b.features[i];
        expect(fb.position.x).toBeCloseTo(fa.position.x, 9);
        expect(fb.position.y).toBeCloseTo(fa.position.y, 9);
        expect(fb.position.z).toBeCloseTo(fa.position.z, 9);
        for (const k of ['x', 'y', 'z', 'w']) expect(fb.rotation[k]).toBeCloseTo(fa.rotation[k], 12);
        expect(fb.points).toEqual(fa.points); // pure JS: bit-exact
      }
    } finally {
      a.world.free();
      b.world.free();
    }
  });

  test('adapter knobs fail loud (NaN / non-finite / out-of-range) before the world is stepped', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    // Count real world.step() calls: contract 1 says addFeatures validates
    // EVERY knob before its statics-only BVH step. A body-count proxy is blind
    // here (a premature step on a bodiless world adds nothing); an own-property
    // stub shadows World.step on both Rapier flavors and observes it directly.
    const realStep = world.step.bind(world);
    let steps = 0;
    world.step = (...args) => {
      steps++;
      return realStep(...args);
    };
    try {
      const terrain = generateCorridorTerrain({ seed: SEED });
      const { floor } = addCorridor(RAPIER, world, terrain);
      const throwsWithoutStepping = (opts, re) => {
        const before = steps;
        expect(() => addFeatures(RAPIER, world, terrain, floor, opts)).toThrow(re);
        expect(steps).toBe(before); // no world.step() before the validation throw
      };
      for (const bad of [NaN, -0.1, 0.25, Infinity]) throwsWithoutStepping({ embedDepth: bad }, /embedDepth/);
      for (const bad of [NaN, -1, Infinity]) throwsWithoutStepping({ friction: bad }, /friction/);
      for (const bad of [NaN, -0.1, 1.5, Infinity]) throwsWithoutStepping({ restitution: bad }, /restitution/);
      // Geometry knobs are validated in features.js, which runs BEFORE the step
      // in the correct code, so a bad one must also throw with zero steps:
      throwsWithoutStepping({ boulderVertexCount: 3 }, /boulderVertexCount/);
    } finally {
      world.step = realStep;
      world.free();
    }
  });

  test('a degenerate hull throws instead of silently vanishing (F16)', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const terrain = generateCorridorTerrain({ seed: SEED });
      const { floor } = addCorridor(RAPIER, world, terrain);
      // A subnormal radius collapses every fround'd hull vertex to ±0: Rapier's
      // convexHull returns null for the degenerate point cloud.
      const fake = {
        ...terrain,
        features: [{ type: 'boulder', x: 0, z: 0, y: 0, yaw: { cos: 1, sin: 0 }, dims: { radius: 1e-40 }, seed: 1 }],
      };
      expect(() => addFeatures(RAPIER, world, fake, floor)).toThrow(/degenerate/);
    } finally {
      world.free();
    }
  });
});
