// The canonical 1,000-spawn chassis fall-through gate — Phase 0 success
// criterion #1 (phase0-refresh §5.1 / §6 step 5): zero chassis bodies through
// terrain over 1,000 spawns per Rapier flavor, over the FULL composite terrain
// (heightfield + baked craters + walls + seated feature colliders), chassis
// carrying CHASSIS_GROUPS + CCD exactly as PR #10's compiled vehicles will.
// Supersedes the provisional 20-sphere smoke gate in terrain-physics.test.js
// as the fall-through criterion (that gate stays as a fast Step-1a check).
//
// SCOPE: this is the TERRAIN fall-through gate, not a per-feature obstacle-
// penetration proof. The buried-check lower bound rays the floor heightfield
// only, by design: features overhang (a box legitimately comes to rest UNDER
// a ramp's high end, where the topmost surface is above it), so a topmost-ray
// lower bound would false-fail legitimate poses. Feature collider presence,
// seating, and blocked-drop collision are already proven per-feature by
// feature-physics.test.js (PR #8); this gate proves chassis bodies remain
// captured by the realized composite world and never escape or tunnel.
//
// Two spawn kinds per 50-body batch (both deterministic — every draw comes
// from Rng forks; seeds declared below; F10: the same spawn set runs on each
// flavor and is asserted independently, never compared across flavors — the
// deterministic flavor's bit-exact hash is checklist step 8, not this gate):
//   • 40 rest drops: random pose (yaw + up to ~22° tilt for corner-first
//     impacts) from 12–18 m above the terrain max → impact ≈ 23–28 m/s.
//   • 10 high-velocity CCD probes: flat pose, setLinvel 40–50 m/s downward →
//     impact ≈ 41–52 m/s ≈ 0.68–0.87 m per fixed step, PAST the box's 0.5 m
//     thin dimension. Rest drops physically cannot exceed ~0.47 m/step, which
//     a discrete solver still catches — without this subset the gate would
//     stay green even with CCD disabled. Probes spawn clear of feature discs
//     so they strike the heightfield itself.

import { describe, test, expect } from 'vitest';
import {
  CHASSIS_GROUPS,
  SOFT_CCD_PREDICTION,
  addCorridorWithFeatures,
  createPhysics,
} from '../src/sim/physics/adapter.js';
import { quatMultiply, yawToQuaternion } from '../src/sim/features.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { Rng } from '../src/sim/prng.js';

const TERRAIN_SEED = 20260708; // the repo's locked-fingerprint seed
const SPAWN_SEED = 20260709; // spawn streams — distinct from the terrain seed
const BATCHES = 20;
const BATCH_SIZE = 50; // 20 × 50 = 1,000 spawns per flavor
const REST_DROPS = 40; // k 0..39 rest drops; k 40..49 high-velocity probes
const SETTLE_STEPS = 360; // 6 s at FIXED_DT; longest fall ends by ~step 110
const HX = 0.9;
const HY = 0.25;
const HZ = 0.45; // chassis half extents; thin dimension 2*HY = 0.5 m

// Catch band, both bounds measured at the body CENTER (slope-independent:
// a box flush on a plane keeps its center ≥ HY/cos(tilt) ≈ 0.23–0.28 above
// the surface directly below it in every resting pose, so 0.10 catches any
// sink beyond ~0.15 m — including slow quasi-static sinking — without false-
// failing steep-slope rests the way a lowest-corner-vs-center bound does).
// MEASURED extremes over all 2,000 landings (both flavors are identical — this
// seed is deterministic; the declared seeds, 2026-07-09): min(p.y − floorY)
// = 0.249, max(p.y − surfaceY) = 0.935 (and NOTHING in [0.935, 1.0) — a clean
// gap below the bound), max |x| = 54.9, max |z| = 5.70, and every body had
// come to |linvel| = |angvel| = 0 by step 360. (Those velocities are observed,
// not the assertion: the `settled` check below is a tolerance band, not an
// isSleeping() call — the observed values sit far inside it.) Bounds are set
// from these extremes with margin; changing them is a deliberate re-lock.
const MIN_CLEARANCE = 0.1; // above the FLOOR ray (no overhangs there)
// Above the topmost CHASSIS_GROUPS ray. Legit rests stay low: flat ≈ 0.25,
// wedged against a feature or wall ≤ 0.94 (observed max 0.935). Tightened from
// a looser 2.6: a body perched high on a wall/feature ledge — or bridged
// across a gap — now FAILS instead of passing, since a real bridge/perch sits
// ≥ ~2.2, well clear of the 0.935 population. If a future terrain legitimately
// bridges at this seed it fails loud here, for a deliberate re-lock.
const MAX_CLEARANCE = 1.2;
const TUNNEL_Y = -50; // house free-fall threshold (no physical catcher below)
const RAY_Y = 60;
const RAY_TOI = 200;

// The generated corridor is pure, read-only data — safe to share across
// flavors (realization copies the heights into WASM; nothing mutates it).
const terrain = generateCorridorTerrain({ seed: TERRAIN_SEED });

// Bounding disc for feature clearance (same formula as feature-physics.test.js).
const disc = (f) =>
  f.type === 'boulder' ? f.dims.radius
    : f.type === 'ramp' ? Math.sqrt((f.dims.length / 2) ** 2 + (f.dims.width / 2) ** 2)
      : f.dims.length / 2 + f.dims.radius;

// Marsaglia disk rejection → unit {cos, sin} (the terrain.js yaw construction;
// trig-free, and the variable draw count is safe on a per-body fork).
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

// Random yaw ⊗ bounded tilt (≤ ~22°) about a random horizontal axis. All
// sqrt-built: sinHalf is drawn directly, cosHalf = sqrt(1 − sinHalf²), so the
// tilt quaternion is unit by construction; quatMultiply renormalizes.
function drawSpawnRotation(s) {
  const yawQ = yawToQuaternion(drawUnit2D(s));
  const axis = drawUnit2D(s);
  const sinHalf = s.range(0, 0.19);
  const cosHalf = Math.sqrt(1 - sinHalf * sinHalf);
  return quatMultiply(yawQ, { x: axis.cos * sinHalf, y: 0, z: axis.sin * sinHalf, w: cosHalf });
}

// Rest-drop spawn margins: x stays ≥ 8 m from the OPEN heightfield ends at
// x = ±60 (there are no end walls — sliding off would read as a tunnel), and
// starts at the post-envelope line (−50); z keeps the spawn AABB
// (half-diagonal ≈ 1.04) clear of the wall inner faces at z = ±6.
const REST_X = [-49, 52];
const SPAWN_Z = [-4.5, 4.5];
// Probe margins are wider: a 50 m/s impact deflected by a ≤ 24° slope can
// skid up to ~10 m, and probes must strike the bare heightfield, ≥ 2 m clear
// of every feature's bounding disc.
const PROBE_X = [-45, 45];
const PROBE_CLEARANCE = 2;
const PROBE_ATTEMPTS = 64; // bounded: a dense-feature config fails loud, never hangs

// Fixed draw order (rest drop): x, z, drop height, yaw, tilt axis, tilt angle.
function restDropSpawn(s) {
  const x = s.range(REST_X[0], REST_X[1]);
  const z = s.range(SPAWN_Z[0], SPAWN_Z[1]);
  const y = terrain.bounds.maxY + s.range(12, 18); // impact ≈ 23–28 m/s at g = 20
  return { kind: 'rest', x, y, z, rot: drawSpawnRotation(s), vy: 0 };
}

// Fixed draw order (probe): (x, z) rejection pairs, drop height, yaw, speed.
function probeSpawn(s, batch, k) {
  let x = null;
  let z = null;
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    const cx = s.range(PROBE_X[0], PROBE_X[1]);
    const cz = s.range(SPAWN_Z[0], SPAWN_Z[1]);
    if (terrain.features.every((f) => Math.sqrt((cx - f.x) ** 2 + (cz - f.z) ** 2) > disc(f) + PROBE_CLEARANCE)) {
      x = cx;
      z = cz;
      break;
    }
  }
  if (x === null) {
    throw new Error(`chassis-drop: no feature-clear probe spawn in ${PROBE_ATTEMPTS} attempts (spawnSeed ${SPAWN_SEED}, batch ${batch}, index ${k})`);
  }
  const y = terrain.bounds.maxY + s.range(2, 5);
  const rot = yawToQuaternion(drawUnit2D(s)); // flat face down — the honest tunneling worst case
  const vy = -s.range(40, 50); // impact ≈ 41–52 m/s ≈ 0.68–0.87 m/step: only CCD catches this
  return { kind: 'probe', x, y, z, rot, vy };
}

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('chassis fall-through gate (deterministic=%s, %s)', (deterministic) => {
  test.each(Array.from({ length: BATCHES }, (_, b) => b))(
    'batch %i: 50 chassis all caught by the composite terrain',
    { timeout: 20000 },
    async (batch) => {
      const { RAPIER, world } = await createPhysics({ deterministic });
      try {
        // Statics first (addCorridorWithFeatures requires a statics-only world
        // for its internal [V1] step), one extra step so the query BVH covers
        // the feature colliders, and only THEN the dynamic chassis.
        const { floor } = addCorridorWithFeatures(RAPIER, world, terrain);
        world.step();

        const root = new Rng(SPAWN_SEED);
        const bodies = [];
        for (let k = 0; k < BATCH_SIZE; k++) {
          const globalIndex = batch * BATCH_SIZE + k;
          const s = root.fork(globalIndex); // per-spawn stream (rule 1)
          const spawn = k < REST_DROPS ? restDropSpawn(s) : probeSpawn(s, batch, k);
          // Both CCD flavors, per the adapter policy: hard CCD alone is inert
          // against the heightfield in rapier 0.19.3 (bodies tunnel identically
          // with it on or off — the hunt that produced SOFT_CCD_PREDICTION);
          // soft CCD's predictive contacts are what actually catch the floor.
          const body = world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic()
              .setTranslation(spawn.x, spawn.y, spawn.z)
              .setRotation(spawn.rot)
              .setLinvel(0, spawn.vy, 0)
              .setCcdEnabled(true)
              .setSoftCcdPrediction(SOFT_CCD_PREDICTION)
          );
          world.createCollider(RAPIER.ColliderDesc.cuboid(HX, HY, HZ), body).setCollisionGroups(CHASSIS_GROUPS);
          bodies.push({ body, spawn, globalIndex, k });
        }
        expect(bodies).toHaveLength(BATCH_SIZE); // 20 × 50 = the 1,000-spawn criterion

        for (let step = 0; step < SETTLE_STEPS; step++) world.step();

        // Topmost catch surface through the group matrix — the REAL query arg
        // (feature-physics 'query path'): sees floor/walls/features, blind to
        // every chassis ghost, including the probed body itself.
        const surfaceUnder = (x, z) => {
          const ray = new RAPIER.Ray({ x, y: RAY_Y, z }, { x: 0, y: -1, z: 0 });
          const hit = world.castRay(ray, RAY_TOI, true, undefined, CHASSIS_GROUPS);
          return hit === null ? null : RAY_Y - hit.timeOfImpact;
        };
        // Floor heightfield only (predicate on the handle, house idiom) — the
        // overhang-free surface the buried check measures against.
        const floorUnder = (x, z) => {
          const ray = new RAPIER.Ray({ x, y: RAY_Y, z }, { x: 0, y: -1, z: 0 });
          const hit = world.castRay(ray, RAY_TOI, true, undefined, undefined, undefined, undefined, (c) => c.handle === floor.handle);
          return hit === null ? null : RAY_Y - hit.timeOfImpact;
        };

        const failures = [];
        for (const { body, spawn, globalIndex, k } of bodies) {
          const p = body.translation();
          const q = body.rotation();
          const lv = body.linvel();
          const av = body.angvel();
          const finite = [p.x, p.y, p.z, q.x, q.y, q.z, q.w].every(Number.isFinite);
          const surfaceY = finite ? surfaceUnder(p.x, p.z) : null;
          const floorY = finite ? floorUnder(p.x, p.z) : null;
          const checks = {
            finite,
            containedX: finite && Math.abs(p.x) < 59.5, // never reached the open ends
            containedZ: finite && Math.abs(p.z) < 5.9, // walls contain
            aboveTunnel: finite && p.y > TUNNEL_Y,
            hasSurface: surfaceY !== null,
            hasFloor: floorY !== null,
            notBuried: floorY !== null && p.y >= floorY + MIN_CLEARANCE,
            caught: surfaceY !== null && p.y <= surfaceY + MAX_CLEARANCE,
            settled:
              finite &&
              Math.sqrt(lv.x * lv.x + lv.y * lv.y + lv.z * lv.z) < 0.6 &&
              Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z) < 1.5,
          };
          if (!Object.values(checks).every(Boolean)) {
            failures.push({
              terrainSeed: TERRAIN_SEED,
              spawnSeed: SPAWN_SEED,
              batch,
              index: k,
              globalIndex,
              kind: spawn.kind,
              spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
              linvel0: spawn.vy,
              final: { pos: { x: p.x, y: p.y, z: p.z }, rot: { x: q.x, y: q.y, z: q.z, w: q.w } },
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
    }
  );
});
