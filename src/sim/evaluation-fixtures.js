// Declared evaluation fixtures A/B/C — the determinism-gate and benchmark
// vehicle/terrain inputs, shared verbatim by the Node tests, the Chromium
// gate, and scripts/bench-physics.js.
//
// COPY-DECLARE, NEVER IMPORT-SHARE (ruling): each genotype below is a copy of
// a proven-stable source (provenance noted per fixture) with its own version
// field. The sources — the dev scene and the witness tests — keep their own
// copies untouched: coupling the dev scene's tuning to a locked fixture would
// let a cosmetic dev-scene tweak invalidate golden digests, and vice versa.
// A fixture's `version` bumps on ANY change to its genes, terrain, spawn,
// step count, or targetAngvel — the golden locks in evaluation-locks.js bind
// to it.
//
// Seeds are fresh and declared (20260708–14 were taken by earlier locks and
// witnesses): A = 20260715, B = 20260716, C = 20260717.
//
// Spawn positions are DECLARED LITERALS, derived once from the placement plan
// (vehicleWheelTransforms) and pinned by a coherence tooth in
// tests/evaluation.test.js: the lowest wheel bottom must sit within
// (0, 0.05] m of the exactly-flat pad (measured: A 0.02, B 0.0195, C 0.02).
// All fixtures spawn on the pad at z = 0, identity rotation, zero linvel —
// the pad is crater/feature/zone-free by terrain construction, so fixture
// B's composite terrain is safe at its spawn too.

import { compileAssembly } from './assembly.js';

function fail(path, value) {
  throw new Error(`evaluation-fixtures: invalid input at ${path} (${String(value)})`);
}

const IDENTITY_ROTATION = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const freezeSpawn = (position) => Object.freeze({
  position: Object.freeze(position),
  rotation: IDENTITY_ROTATION,
});

// --- Fixture A: ordinary all-S0 on a flat pad --------------------------------
// Genotype: copy of canonicalS0Genotype() (tests/s0-drive.test.js) at its
// defaults — spine frame, 2 paired driven S0 axles, 4 wheels r 0.5, ~596 kg.
function buildGenotypeA() {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, node),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [axle(0.2), axle(0.8)],
  };
}

export const FIXTURE_A = Object.freeze({
  name: 'eval-a-s0-flat',
  version: 1,
  description: 'Ordinary 4-wheel all-S0 vehicle driving an exactly-flat declared pad — the cheapest rigid-kernel baseline.',
  buildGenotype: buildGenotypeA,
  terrainConfig: Object.freeze({
    seed: 20260715,
    startFlatLength: 80, // pad spans x ∈ [−60, +20]; the run stays far inside
    startBlendLength: 6,
    craterDensity: 0,
    featureDensity: 0,
    sandCoverage: 0,
    mudCoverage: 0,
  }),
  spawn: freezeSpawn({ x: -45, y: 0.52, z: 0 }), // max wheel radius 0.5 + 0.02 clearance
  targetAngvel: -10, // == MOTOR_TARGET_ANGVEL, declared as a literal so the fixture is self-contained
  maxSteps: 600,
  expected: Object.freeze({
    bodies: 5, // chassis + 4 S0 wheels
    joints: 4, // 4 drive revolutes
    wheels: 4,
    stations: 4,
    chassisColliders: 3, // measured: spine family, 4 active nodes → 3 beam cuboids
    vehicleColliders: 7, // chassis 3 + wheel cylinders 4 (no hubs)
  }),
});

// --- Fixture B: mixed S0/S1 on the full composite terrain --------------------
// Genotype: copy of the dev-scene mixed build (src/main.js) — S0 front pair,
// S1 rear pair (k ≈ 17.8 kN/m, c ≈ 500 N·s/m, travel 0.3 m, rest ≈ 0.18 m),
// power 1, ~23% thrust/weight. The ONE fixture that keeps every composite
// default ON (craters, features, sand/mud zones), pushing
// addCorridorWithFeatures — its statics-step + castRay feature-seating path —
// through the determinism gate.
function buildGenotypeB() {
  return {
    version: 1, hue: 0.25, symmetric: 0.9, power: 1, frameDensity: 0.1,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, () => ({ gap: 0.5, height: 0.3, halfWidth: 0.5, thickness: 0.5 })),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [
      { // front: rigid S0
        posX01: 0.2, paired: 1, trackHalf: 0.5,
        radius: 0.4, width: 0.5, density: 0.15,
        suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
        driven: 1, share: 0.5,
        asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
      },
      { // rear: S1 vertical spring-damper
        posX01: 0.8, paired: 1, trackHalf: 0.5,
        radius: 0.4, width: 0.5, density: 0.15,
        suspType: 0.5, stiffness: 0.33, damping: 0.1, travel: 0.75, restLength: 0.29,
        driven: 1, share: 0.5,
        asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
      },
    ],
  };
}

export const FIXTURE_B = Object.freeze({
  name: 'eval-b-mixed-composite',
  version: 1,
  description: 'Mixed S0-front/S1-rear vehicle on the full composite corridor (craters, features, zones all on) — the terrain-path and mixed-dispatch gate.',
  buildGenotype: buildGenotypeB,
  terrainConfig: Object.freeze({
    seed: 20260716,
    startFlatLength: 30, // pad x ∈ [−60, −30]; blend to −24; features/craters start past it
    startBlendLength: 6,
    // Every other knob DELIBERATELY left at TERRAIN_DEFAULTS — composite on.
  }),
  spawn: freezeSpawn({ x: -44, y: 0.6, z: 0 }), // rear S1 drop 0.5805 (coord 0.1805 + r 0.4) + 0.0195 clearance
  targetAngvel: -10,
  maxSteps: 900,
  expected: Object.freeze({
    bodies: 7, // chassis + 2 S0 wheels + 2 hubs + 2 S1 wheels
    joints: 6, // 4 drive revolutes + 2 suspension prismatics
    wheels: 4,
    stations: 4,
    chassisColliders: 3, // measured: same spine layout as A
    vehicleColliders: 9, // chassis 3 + wheels 4 + hub cylinders 2
  }),
});

// --- Fixture C: maximum legal all-S1 topology ---------------------------------
// Genotype: copy of maxS1Genotype() (tests/s1-kernel.test.js) — 6 paired S1
// axles on the max-gap spine = 25 bodies / 24 joints on one island, the
// worst-case structural cost the S1 PR measured. All-0.5 suspension genes are
// the PRELOAD phenotype (rest 0.275 > travel 0.2 → spawn coordinate 0.2).
function buildGenotypeC() {
  const node = () => ({ gap: 1, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.44, width: 0.5, density: 0.15,
    suspType: 0.5, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.15,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 1,
        nodes: Array.from({ length: 6 }, node),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [0, 0.18, 0.36, 0.54, 0.72, 0.9].map(axle),
  };
}

export const FIXTURE_C = Object.freeze({
  name: 'eval-c-max-s1',
  version: 1,
  description: 'Maximum legal topology — 6 paired S1 axles (25 bodies / 24 joints / 12 stations) on a flat declared pad; the structural-cost ceiling fixture.',
  buildGenotype: buildGenotypeC,
  terrainConfig: Object.freeze({
    seed: 20260717,
    startFlatLength: 80,
    startBlendLength: 6,
    craterDensity: 0,
    featureDensity: 0,
    sandCoverage: 0,
    mudCoverage: 0,
  }),
  spawn: freezeSpawn({ x: -45, y: 0.64, z: 0 }), // wheel drop 0.62 (preload coord 0.2 + r 0.42) + 0.02 clearance
  targetAngvel: -10,
  maxSteps: 600,
  expected: Object.freeze({
    bodies: 25, // chassis + 12 hubs + 12 wheels
    joints: 24, // 12 prismatics + 12 drive revolutes
    wheels: 12,
    stations: 12,
    chassisColliders: 5, // measured: max-gap spine, 6 active nodes → 5 beam cuboids
    vehicleColliders: 29, // chassis 5 + wheels 12 + hubs 12
  }),
});

export const EVALUATION_FIXTURES = Object.freeze([FIXTURE_A, FIXTURE_B, FIXTURE_C]);

/**
 * Build a fresh, fully-formed runEvaluation options object for a fixture —
 * the single wiring point shared by the Node determinism tests, the Chromium
 * gate, and the benchmark, so the three consumers cannot drift. Compiles
 * `vehicleCount` FRESH IRs (one compileAssembly per vehicle; the compiler is
 * pure and deterministic). Deliberately does NOT call runEvaluation — callers
 * own flavor/trace/profiler/hook policy.
 */
export function evaluationOptionsFor(fixture, {
  deterministic = false, trace, profile, hooks, vehicleCount = 1,
} = {}) {
  if (typeof fixture !== 'object' || fixture === null || typeof fixture.buildGenotype !== 'function') {
    fail('fixture', fixture);
  }
  if (!Number.isInteger(vehicleCount) || vehicleCount < 1) fail('vehicleCount', vehicleCount);
  const vehicles = Array.from({ length: vehicleCount }, () => ({
    ir: compileAssembly(fixture.buildGenotype()),
    spawn: {
      position: { ...fixture.spawn.position },
      rotation: { ...fixture.spawn.rotation },
    },
    targetAngvel: fixture.targetAngvel,
  }));
  const options = {
    terrain: { ...fixture.terrainConfig },
    vehicles,
    maxSteps: fixture.maxSteps,
  };
  if (deterministic !== undefined) options.deterministic = deterministic;
  if (trace !== undefined) options.trace = trace;
  if (profile !== undefined) options.profile = profile;
  if (hooks !== undefined) options.hooks = hooks;
  return options;
}
