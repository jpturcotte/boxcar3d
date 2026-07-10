// Compiled chassis IRs on the FULL composite terrain, BOTH Rapier flavors
// (describe.each × createPhysics, per F10: seeds declared, exactness only
// ever per-flavor). NOT a new 1,000-spawn gate — PR #9's chassis-drop owns
// the canonical fall-through criterion; this file proves the ASSEMBLY
// pipeline inherits it: compiled chassis (all three families, symmetric +
// asymmetric + repaired-from-violating) stay caught by the terrain, emitted
// bodies carry the full dynamic-body policy, and stripping either soft CCD
// or the collision groups makes the world demonstrably lose the body.
//
// Teeth are the PR #9 pair of rays, generalized to varying bodies (PR #9's
// constants were calibrated for one fixed 0.9/0.25/0.45 box):
//   * floor-only lower ray (floor-handle predicate — overhangs excluded):
//     p.y >= floorY + 0.6 × supports.minFace. Resting flat on any face keeps
//     the origin ~minFace above the contact plane (edge/corner rests only
//     raise it); real burial drives the gap toward zero, so 0.6 keeps teeth.
//   * CHASSIS_GROUPS topmost ray: p.y <= surfaceY + supports.reach + 0.35.
//     A contacting body cannot hold its origin further above its support
//     than its own reach; the margin covers rim-bridging poses.
// MEASURED extremes over this corpus (17 bodies/flavor, both flavors
// IDENTICAL at these seeds, 2026-07-09): min(p.y − floorY) = 0.1867 against
// that body's minFace 0.1945 (ratio 0.96 — the slope-dip class PR #9 saw as
// 0.249 vs 0.25), max(p.y − surfaceY − reach) = −0.1065, max |x| = 42.8,
// max |z| = 5.42, and every body at |linvel| = |angvel| = 0 by step 360.
// The 0.6 factor leaves ~0.07 of margin for cross-platform settle drift on
// the default flavor (CI is Linux, this calibration is Windows); tightening
// it back toward the observed 0.96 is a deliberate re-calibration.

import { describe, test, expect } from 'vitest';
import {
  ADDITIONAL_SOLVER_ITERATIONS,
  CHASSIS_GROUPS,
  GROUP_CHASSIS,
  SOFT_CCD_PREDICTION,
  addCorridorWithFeatures,
  createPhysics,
  packGroups,
  realizeChassis,
} from '../src/sim/physics/adapter.js';
import { quatMultiply, yawToQuaternion } from '../src/sim/features.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { compileAssembly, randomGenotype } from '../src/sim/assembly.js';
import { Rng } from '../src/sim/prng.js';

const TERRAIN_SEED = 20260708; // the repo's locked-fingerprint seed
const ASSEMBLY_SEED = 20260710; // the assembly-corpus seed family
const SPAWN_SEED = 20260712; // spawn streams — distinct from every other seed
const SETTLE_STEPS = 360;
const PROBE_COUNT = 3; // high-velocity CCD subset (PR #9 probe class)
const TUNNEL_Y = -50;
const RAY_Y = 60;
const RAY_TOI = 200;
const MIN_FACE_FACTOR = 0.6;
const CAUGHT_MARGIN = 0.35;

const terrain = generateCorridorTerrain({ seed: TERRAIN_SEED });

// The compiled sub-corpus: 9 seeded random IRs + forced coverage (each
// family, an asymmetric build, and one repaired-from-violating genotype —
// tall frame + tucked wheels, so R2 provably fired before realization).
function corpusIRs() {
  const root = new Rng(ASSEMBLY_SEED);
  const irs = [];
  for (let i = 0; i < 9; i++) irs.push(compileAssembly(randomGenotype(root.fork(i))));
  for (const [fork, familyGene] of [[100, 0.1], [101, 0.5], [102, 0.9]]) {
    const g = randomGenotype(root.fork(fork));
    g.frame.family = familyGene;
    irs.push(compileAssembly(g));
  }
  const asym = randomGenotype(root.fork(103));
  asym.symmetric = 0.1;
  irs.push(compileAssembly(asym));
  const violating = randomGenotype(root.fork(104));
  violating.frame.segments[0].nodes.forEach((n) => { n.height = 1; });
  violating.axles.forEach((a) => { a.radius = 0; });
  irs.push(compileAssembly(violating));
  return irs;
}

// Bounding disc for feature clearance (the chassis-drop formula).
const disc = (f) =>
  f.type === 'boulder' ? f.dims.radius
    : f.type === 'ramp' ? Math.sqrt((f.dims.length / 2) ** 2 + (f.dims.width / 2) ** 2)
      : f.dims.length / 2 + f.dims.radius;

// Marsaglia unit heading + bounded tilt — the chassis-drop spawn idiom.
function drawUnit2D(s) {
  for (;;) {
    const u = s.range(-1, 1);
    const v = s.range(-1, 1);
    const m = u * u + v * v;
    if (m > 1 || m < 1e-12) continue;
    const inv = 1 / Math.sqrt(m);
    return { cos: u * inv, sin: v * inv };
  }
}

function drawSpawnRotation(s) {
  const yawQ = yawToQuaternion(drawUnit2D(s));
  const axis = drawUnit2D(s);
  const sinHalf = s.range(0, 0.19);
  const cosHalf = Math.sqrt(1 - sinHalf * sinHalf);
  return quatMultiply(yawQ, { x: axis.cos * sinHalf, y: 0, z: axis.sin * sinHalf, w: cosHalf });
}

// Feature-clear spawn by bounded rejection; the body's own reach shrinks the
// z-envelope (walls at |z| = 6) and pads the feature discs — bodies here vary
// in size, unlike PR #9's fixed box.
function clearSpawn(s, reach, index) {
  const zMax = 5.7 - reach;
  for (let attempt = 0; attempt < 64; attempt++) {
    const x = s.range(-45, 45);
    const z = s.range(-Math.min(4.5, zMax), Math.min(4.5, zMax));
    if (terrain.features.every((f) => Math.sqrt((x - f.x) ** 2 + (z - f.z) ** 2) > disc(f) + reach + 1)) {
      return { x, z };
    }
  }
  throw new Error(`assembly-physics: no feature-clear spawn in 64 attempts (spawnSeed ${SPAWN_SEED}, index ${index})`);
}

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('compiled chassis on composite terrain (deterministic=%s, %s)', (deterministic) => {
  test('the corpus settles caught: per-IR teeth, floor ray, topmost ray, containment, settle band', { timeout: 30000 }, async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const { floor } = addCorridorWithFeatures(RAPIER, world, terrain);
      world.step(); // BVH covers the feature colliders before dynamics

      const irs = corpusIRs();
      const root = new Rng(SPAWN_SEED);
      const bodies = [];
      irs.forEach((ir, i) => {
        const s = root.fork(i);
        const { x, z } = clearSpawn(s, ir.chassis.supports.reach, i);
        const y = terrain.bounds.maxY + s.range(6, 10);
        const { body } = realizeChassis(RAPIER, world, ir, {
          position: { x, y, z },
          rotation: drawSpawnRotation(s),
        });
        bodies.push({ ir, body, kind: 'rest', index: i });
      });
      // High-velocity probe subset: flat pose, setLinvel past the thinnest
      // collider dimension per step — the CCD teeth (PR #9 probe class).
      for (let k = 0; k < PROBE_COUNT; k++) {
        const s = root.fork(100 + k);
        const ir = irs[k];
        const { x, z } = clearSpawn(s, ir.chassis.supports.reach, 100 + k);
        const y = terrain.bounds.maxY + s.range(2, 5);
        const { body } = realizeChassis(RAPIER, world, ir, {
          position: { x, y, z },
          rotation: yawToQuaternion(drawUnit2D(s)),
          linvel: { x: 0, y: -s.range(40, 50), z: 0 },
        });
        bodies.push({ ir, body, kind: 'probe', index: 100 + k });
      }

      for (let step = 0; step < SETTLE_STEPS; step++) world.step();

      const surfaceUnder = (x, z) => {
        const ray = new RAPIER.Ray({ x, y: RAY_Y, z }, { x: 0, y: -1, z: 0 });
        const hit = world.castRay(ray, RAY_TOI, true, undefined, CHASSIS_GROUPS);
        return hit === null ? null : RAY_Y - hit.timeOfImpact;
      };
      const floorUnder = (x, z) => {
        const ray = new RAPIER.Ray({ x, y: RAY_Y, z }, { x: 0, y: -1, z: 0 });
        const hit = world.castRay(ray, RAY_TOI, true, undefined, undefined, undefined, undefined, (c) => c.handle === floor.handle);
        return hit === null ? null : RAY_Y - hit.timeOfImpact;
      };

      const failures = [];
      for (const { ir, body, kind, index } of bodies) {
        const p = body.translation();
        const lv = body.linvel();
        const av = body.angvel();
        const finite = [p.x, p.y, p.z].every(Number.isFinite);
        const surfaceY = finite ? surfaceUnder(p.x, p.z) : null;
        const floorY = finite ? floorUnder(p.x, p.z) : null;
        const checks = {
          finite,
          containedX: finite && Math.abs(p.x) < 59.5,
          containedZ: finite && Math.abs(p.z) < 5.9,
          aboveTunnel: finite && p.y > TUNNEL_Y,
          hasSurface: surfaceY !== null,
          hasFloor: floorY !== null,
          notBuried: floorY !== null && p.y >= floorY + MIN_FACE_FACTOR * ir.chassis.supports.minFace,
          caught: surfaceY !== null && p.y <= surfaceY + ir.chassis.supports.reach + CAUGHT_MARGIN,
          settled:
            finite &&
            Math.sqrt(lv.x * lv.x + lv.y * lv.y + lv.z * lv.z) < 0.6 &&
            Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z) < 1.5,
        };
        if (!Object.values(checks).every(Boolean)) {
          failures.push({
            terrainSeed: TERRAIN_SEED,
            assemblySeed: ASSEMBLY_SEED,
            spawnSeed: SPAWN_SEED,
            index,
            kind,
            family: ir.chassis.family,
            supports: ir.chassis.supports,
            final: { x: p.x, y: p.y, z: p.z },
            surfaceY,
            floorY,
            checks,
          });
        }
      }
      expect(failures).toEqual([]);
    } finally {
      world.free();
    }
  });

  test('emitted body carries the full policy: dual CCD, solver iterations, CHASSIS_GROUPS, one dynamic body', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const ir = corpusIRs()[0];
      const before = world.bodies.len();
      const { body, colliders } = realizeChassis(RAPIER, world, ir, { position: { x: 0, y: 5, z: 0 } });
      expect(world.bodies.len()).toBe(before + 1); // exactly ONE dynamic body
      expect(body.isCcdEnabled()).toBe(true);
      expect(body.softCcdPrediction()).toBe(SOFT_CCD_PREDICTION);
      expect(body.additionalSolverIterations()).toBe(ADDITIONAL_SOLVER_ITERATIONS); // [V2]
      expect(colliders).toHaveLength(ir.chassis.colliders.length);
      expect(body.numColliders()).toBe(ir.chassis.colliders.length);
      for (const c of colliders) expect(c.collisionGroups()).toBe(CHASSIS_GROUPS);
      expect(Number.isFinite(body.mass())).toBe(true);
      expect(body.mass()).toBeGreaterThan(0);
    } finally {
      world.free();
    }
  });
});

describe('negative teeth (default flavor — deterministic single spawns, tunneling is total not statistical)', () => {
  // A flat spine build for the tunneling probes (thin hy — the honest worst
  // case; PR #9 proved shape barely matters from ~23 m/s up).
  function spineIR() {
    const g = randomGenotype(new Rng(ASSEMBLY_SEED).fork(200));
    g.frame.family = 0.1;
    return compileAssembly(g);
  }

  test('stripping soft CCD loses a 45 m/s probe through the heightfield (hard CCD alone is inert — PR #9 finding)', { timeout: 20000 }, async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: false });
    try {
      addCorridorWithFeatures(RAPIER, world, terrain);
      world.step();
      const ir = spineIR();
      const s = new Rng(SPAWN_SEED).fork(300);
      const { x, z } = clearSpawn(s, ir.chassis.supports.reach, 300);
      // realizeChassis always applies the policy, so build the SAME body by
      // hand minus setSoftCcdPrediction — the exact PR #9 removal experiment.
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, terrain.bounds.maxY + 3, z)
          .setLinvel(0, -45, 0)
          .setCcdEnabled(true)
      );
      for (const c of ir.chassis.colliders) {
        const desc = RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz)
          .setTranslation(c.cx, c.cy, c.cz)
          .setDensity(ir.chassis.density);
        desc.setCollisionGroups(CHASSIS_GROUPS);
        world.createCollider(desc, body);
      }
      for (let step = 0; step < 240; step++) world.step();
      expect(body.translation().y).toBeLessThan(TUNNEL_Y); // MUST fall through
    } finally {
      world.free();
    }
  });

  test('stripping the GROUND filter from the groups loses a rest drop (the PR #9 teeth verification)', { timeout: 20000 }, async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: false });
    try {
      addCorridorWithFeatures(RAPIER, world, terrain);
      world.step();
      const ir = spineIR();
      const s = new Rng(SPAWN_SEED).fork(301);
      const { x, z } = clearSpawn(s, ir.chassis.supports.reach, 301);
      const { body, colliders } = realizeChassis(RAPIER, world, ir, {
        position: { x, y: terrain.bounds.maxY + 6, z },
      });
      // GROUND-less filter: membership stays CHASSIS, but the body may only
      // touch other chassis — the floor pair fails in both directions.
      for (const c of colliders) c.setCollisionGroups(packGroups(GROUP_CHASSIS, GROUP_CHASSIS));
      for (let step = 0; step < 240; step++) world.step();
      expect(body.translation().y).toBeLessThan(TUNNEL_Y); // free-falls through everything
    } finally {
      world.free();
    }
  });

  test('degenerate hull IR fails loud and leaves no body behind (both F16-class failure modes)', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: false });
    try {
      const before = world.bodies.len();
      // Mode 1 — hull construction fails outright (all points identical):
      // the null-desc / lazy-createCollider path, the addFeatures F16 twin.
      const identical = { version: 1, chassis: { density: 100, colliders: [{ kind: 'convexHull', points: Array(24).fill(0.5) }] } };
      expect(() => realizeChassis(RAPIER, world, identical, { position: { x: 0, y: 5, z: 0 } }))
        .toThrow(/degenerate convex hull \(F16\)/);
      // Mode 2 — MEASURED 0.19.3 behavior: a COPLANAR cloud does NOT fail
      // hull construction; it builds a zero-volume shape. The post-create
      // mass/inertia sanity assertion is what catches that one.
      const coplanar = [];
      for (let i = 0; i < 8; i++) coplanar.push(0, i * 0.1, (i % 2) * 0.2); // all x = 0
      const flat = { version: 1, chassis: { density: 100, colliders: [{ kind: 'convexHull', points: coplanar }] } };
      expect(() => realizeChassis(RAPIER, world, flat, { position: { x: 0, y: 5, z: 0 } }))
        .toThrow(/mass 0 is not finite and positive/);
      expect(world.bodies.len()).toBe(before); // every half-built body was removed
    } finally {
      world.free();
    }
  });

  test('malformed IR and spawn options fail loud before the world is touched', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: false });
    try {
      const ir = spineIR();
      const before = world.bodies.len();
      expect(() => realizeChassis(RAPIER, world, null)).toThrow(/malformed IR/);
      expect(() => realizeChassis(RAPIER, world, { version: 2, chassis: ir.chassis })).toThrow(/malformed IR/);
      expect(() => realizeChassis(RAPIER, world, { version: 1, chassis: { density: 100, colliders: [] } })).toThrow(/malformed IR/);
      expect(() => realizeChassis(RAPIER, world, { version: 1, chassis: { density: NaN, colliders: ir.chassis.colliders } })).toThrow(/density/);
      expect(() => realizeChassis(RAPIER, world, { version: 1, chassis: { density: 100, colliders: [{ kind: 'sphere' }] } })).toThrow(/unknown collider kind/);
      expect(() => realizeChassis(RAPIER, world, ir, { position: { x: NaN, y: 0, z: 0 } })).toThrow(/spawn pose/);
      // Per-field collider shape rejections (external review hardening) —
      // every one must fire BEFORE createRigidBody, so the final body-count
      // assertion below proves rejection has zero world side effects.
      const cub = (patch) => ({
        version: 1,
        chassis: { density: 100, colliders: [{ kind: 'cuboid', hx: 0.3, hy: 0.2, hz: 0.2, cx: 0, cy: 0, cz: 0, rot: { x: 0, y: 0, z: 0, w: 1 }, ...patch }] },
      });
      expect(() => realizeChassis(RAPIER, world, cub({ hx: 0 }))).toThrow(/positive finite half-extents/);
      expect(() => realizeChassis(RAPIER, world, cub({ hy: -0.1 }))).toThrow(/positive finite half-extents/);
      expect(() => realizeChassis(RAPIER, world, cub({ cz: NaN }))).toThrow(/positive finite half-extents/);
      expect(() => realizeChassis(RAPIER, world, cub({ rot: undefined }))).toThrow(/rotation quaternion/);
      expect(() => realizeChassis(RAPIER, world, cub({ rot: { x: 0, y: 0, z: 0, w: NaN } }))).toThrow(/rotation quaternion/);
      const hull = (points) => ({ version: 1, chassis: { density: 100, colliders: [{ kind: 'convexHull', points }] } });
      expect(() => realizeChassis(RAPIER, world, hull(Array(10).fill(0.5)))).toThrow(/3n-length/); // ragged (10 % 3 != 0)
      expect(() => realizeChassis(RAPIER, world, hull(Array(9).fill(0.5)))).toThrow(/3n-length/); // only 3 points
      const nanHull = Array(24).fill(0.5);
      nanHull[7] = NaN;
      expect(() => realizeChassis(RAPIER, world, hull(nanHull))).toThrow(/non-finite convexHull point/);
      expect(world.bodies.len()).toBe(before); // no side effects from any rejection
    } finally {
      world.free();
    }
  });
});
