// Population-evaluator contract (src/sim/population-evaluation.js): fitness
// policy, spawn placement, the resolved-spec and fitness-vector encodings
// (hand-decoded — never encoder-vs-itself), the fail-loud matrices, champion
// selection, and the light physics witnesses (deterministic flavor; the
// heavier isolation-contract protocol lives in tests/cohort-invariance.test.js
// and the cross-OS narrowed gate in tests/cohort-determinism.test.js).
//
// The spawn-placement tooth is INDEPENDENT by provenance: fixtures A/B/C/D
// declare spawn-y LITERALS that were hand-derived from the placement plan in
// their own PRs — spawnPoseOnFlatStart must reproduce all four from the IRs
// alone (B under its declared 0.0195 clearance).

import { describe, test, expect } from 'vitest';
import {
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION, FITNESS_VECTOR_VERSION,
  POPULATION_WORLD_MODE, SPAWN_CLEARANCE,
  championFromEvaluation, evaluatePopulation, fitnessFromVehicleResult,
  isVehicleResultValid, serializeEvaluationSpec, serializeFitnessVector,
  spawnPoseOnFlatStart,
} from '../src/sim/population-evaluation.js';
import { POPULATION_SNAPSHOT_VERSION, bytesEqual } from '../src/sim/population.js';
import { compileAssembly } from '../src/sim/assembly.js';
import { TERRAIN_DEFAULTS } from '../src/sim/terrain.js';
import { runEvaluation } from '../src/sim/evaluation.js';
import {
  FIXTURE_A, FIXTURE_B, FIXTURE_C, FIXTURE_D,
} from '../src/sim/evaluation-fixtures.js';

// Exact-tree comparator: Object.is at LEAVES only (never on object
// references), key sets must match exactly.
function assertLeafEqual(a, b, path) {
  if (typeof a === 'object' && a !== null) {
    expect(typeof b === 'object' && b !== null, `${path}: expected object`).toBe(true);
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    expect(kb, `${path}: key sets differ`).toEqual(ka);
    for (const k of ka) assertLeafEqual(a[k], b[k], `${path}.${k}`);
    return;
  }
  if (!Object.is(a, b)) expect.fail(`${path}: ${String(a)} !== ${String(b)}`);
}

// Copy-declared genotype shapes (fixture-A / fixture-D outlines).
const frame = (node) => ({
  family: 0.1,
  segments: [{
    nodeCount: 0.5,
    nodes: Array.from({ length: 6 }, node),
    fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
  }],
});
const node05 = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
const node01 = () => ({ gap: 0.5, height: 0.1, halfWidth: 0.5, thickness: 0.5 });

function s0PlainGenotype() {
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return { version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3, frame: frame(node05), axles: [axle(0.2), axle(0.8)] };
}
function mixedRadiusGenotype() {
  const axle = (posX01, radius) => ({
    posX01, paired: 1, trackHalf: 0.5, radius, width: 0.5, density: 0.1,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return { version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3, frame: frame(node01), axles: [axle(0.2, 0.2), axle(0.8, 0.8)] };
}
function sledGenotype() {
  return { version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3, frame: frame(node05), axles: [] };
}
function s2Genotype() {
  const g = s0PlainGenotype();
  g.axles[1].suspType = 0.9; // decodes to S2 — legal IR data, unrealizable
  return g;
}

// Canonical-by-construction members (the repaired-clone ownership pattern).
const member = (individualId, genotype) => ({ individualId, genotype: compileAssembly(genotype).genotype });
const popOf = (...members) => ({ snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals: members });

const FLAT_TERRAIN = Object.freeze({
  seed: 20260723,
  startFlatLength: 80,
  startBlendLength: 6,
  craterDensity: 0,
  featureDensity: 0,
  sandCoverage: 0,
  mudCoverage: 0,
});
const baseSpec = () => ({
  terrain: { ...FLAT_TERRAIN },
  maxSteps: 120,
  deterministic: true,
  spawn: { x: -45, z: 0 },
});

// --- Fitness policy (pure) ---------------------------------------------------

describe('fitness policy', () => {
  const vr = (over = {}) => ({
    finite: true,
    bodies: { count: 5, allValid: true, sleepingAtEnd: 0 },
    joints: { count: 4, allValid: true },
    maxForwardDistance: 12.345678901234567,
    ...over,
  });

  test('valid result: fitness IS maxForwardDistance, verbatim f64', () => {
    expect(Object.is(fitnessFromVehicleResult(vr()), 12.345678901234567)).toBe(true);
    expect(isVehicleResultValid(vr())).toBe(true);
  });

  test.each([
    ['non-finite', { finite: false }],
    ['invalid body', { bodies: { count: 5, allValid: false, sleepingAtEnd: 0 } }],
    ['invalid joint', { joints: { count: 4, allValid: false } }],
  ])('%s: fitness is exactly 0 and validity is false', (_name, over) => {
    expect(Object.is(fitnessFromVehicleResult(vr(over)), 0)).toBe(true);
    expect(isVehicleResultValid(vr(over))).toBe(false);
  });
});

// --- Champion selection (pure) -----------------------------------------------

describe('championFromEvaluation', () => {
  const ev = (entries) => ({ individuals: entries.map(([individualId, fitness, valid = true]) => ({ individualId, fitness, valid })) });

  test('strictly greater fitness wins', () => {
    expect(championFromEvaluation(ev([[0, 1], [1, 3], [2, 2]])).individualId).toBe(1);
  });

  test('EXACT fitness tie keeps the lowest individualId — independent of array order', () => {
    expect(championFromEvaluation(ev([[7, 5], [3, 5], [9, 5]])).individualId).toBe(3);
    expect(championFromEvaluation(ev([[9, 5], [7, 5], [3, 5]])).individualId).toBe(3);
  });

  test('an all-invalid population yields the lowest id at fitness 0', () => {
    const c = championFromEvaluation(ev([[4, 0, false], [2, 0, false], [8, 0, false]]));
    expect(c.individualId).toBe(2);
    expect(c.fitness).toBe(0);
    expect(c.valid).toBe(false);
  });

  test('a near-tie one ulp apart is NOT a tie', () => {
    const lo = 5;
    const hi = 5 + Number.EPSILON * 4; // > 5 by ulps
    expect(championFromEvaluation(ev([[1, lo], [2, hi]])).individualId).toBe(2);
  });
});

// --- Spawn placement (pure) --------------------------------------------------

describe('spawnPoseOnFlatStart', () => {
  test('reproduces every fixture\'s HAND-DERIVED spawn-y literal from the IR alone (<= 1 ulp)', () => {
    // The fixtures declare decimal-ROUNDED literals derived by hand from the
    // same placement plan; the helper computes drop + clearance in f64, which
    // can land one ulp off the rounded decimal (measured: A gives
    // 0.5199999999999999 vs the literal 0.52). The coherence claim is
    // <= Number.EPSILON; the helper's own arithmetic is locked EXACTLY below.
    const yOf = (fx, clearance) => spawnPoseOnFlatStart(
      compileAssembly(fx.buildGenotype()),
      { x: fx.spawn.position.x, z: fx.spawn.position.z, clearance },
    ).position.y;
    const cases = [
      [yOf(FIXTURE_A, 0.02), 0.52], // r 0.5 + 0.02
      [yOf(FIXTURE_B, 0.0195), 0.6], // S1 rear ext 0.1805 + r 0.4 + 0.0195
      [yOf(FIXTURE_C, 0.02), 0.64], // preload coord 0.2 + r 0.42 + 0.02
      [yOf(FIXTURE_D, 0.02), 0.62], // max radius 0.6 + 0.02
    ];
    for (const [computed, literal] of cases) {
      expect(Math.abs(computed - literal)).toBeLessThanOrEqual(Number.EPSILON);
    }
    // Exact lock of the helper's own deterministic arithmetic at fixture A.
    expect(yOf(FIXTURE_A, 0.02)).toBe(0.5199999999999999);
  });

  test('zero-axle sled falls back to the chassis AABB bottom', () => {
    const y = spawnPoseOnFlatStart(compileAssembly(sledGenotype()), { x: -45, z: 0 }).position.y;
    // maxHalfHeight 0.3 + SPAWN_CLEARANCE 0.02, exact f64 arithmetic (one
    // ulp above the decimal 0.32 — locked as measured).
    expect(y).toBe(0.32000000000000006);
  });

  test.each([
    ['clearance 0', { x: 0, z: 0, clearance: 0 }],
    ['clearance 0.06 (outside the coherence band)', { x: 0, z: 0, clearance: 0.06 }],
    ['clearance NaN', { x: 0, z: 0, clearance: NaN }],
    ['x non-finite', { x: Infinity, z: 0 }],
    ['z non-finite', { x: 0, z: NaN }],
  ])('rejects %s', (_name, opts) => {
    expect(() => spawnPoseOnFlatStart(compileAssembly(s0PlainGenotype()), opts)).toThrow(/population-evaluation: invalid/);
  });

  test('rejects a wrong-version IR', () => {
    expect(() => spawnPoseOnFlatStart({ version: 1 }, { x: 0, z: 0 })).toThrow(/ir.version/);
  });
});

// --- Encodings (hand-decoded) ------------------------------------------------

describe('evaluation-spec encoding v1', () => {
  const resolved = () => ({
    deterministic: true,
    termination: 'maxSteps',
    maxSteps: 120,
    spawn: { x: -45, z: 0, clearance: SPAWN_CLEARANCE },
    targetWheelSurfaceSpeed: 5,
    wheelFriction: 1,
    terrain: { ...TERRAIN_DEFAULTS, ...FLAT_TERRAIN },
  });

  test('header and terrain walk land at the documented offsets (hand-decoded)', () => {
    const bytes = serializeEvaluationSpec(resolved());
    expect(bytes.length).toBe(401); // 49-byte header+count, 352-byte terrain walk
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(0, true)).toBe(EVALUATION_SPEC_VERSION);
    expect(view.getUint8(2)).toBe(1); // deterministic
    expect(view.getUint8(3)).toBe(0); // termination 'maxSteps'
    expect(view.getUint32(4, true)).toBe(120);
    expect(view.getFloat64(8, true)).toBe(-45);
    expect(view.getFloat64(16, true)).toBe(0);
    expect(view.getFloat64(24, true)).toBe(SPAWN_CLEARANCE);
    expect(view.getFloat64(32, true)).toBe(5);
    expect(view.getFloat64(40, true)).toBe(1);
    expect(view.getUint8(48)).toBe(33); // terrain key count
    expect(view.getUint32(49, true)).toBe(20260723); // seed, first walked key
    expect(view.getFloat64(53, true)).toBe(120); // length
    expect(view.getFloat64(61, true)).toBe(12); // width
  });

  test('ANY resolved knob changes the bytes — the spec never leans on an external fixture version', () => {
    const a = serializeEvaluationSpec(resolved());
    for (const mutate of [
      (s) => { s.maxSteps = 121; },
      (s) => { s.deterministic = false; },
      (s) => { s.spawn = { ...s.spawn, x: -44 }; },
      (s) => { s.wheelFriction = 0.9; },
      (s) => { s.terrain = { ...s.terrain, seed: 20260724 }; },
      (s) => { s.terrain = { ...s.terrain, mudCoverage: 0.01 }; },
      (s) => { s.terrain = { ...s.terrain, logLengthRange: [3, 7.5] }; },
      (s) => { s.terrain = { ...s.terrain, featureTypeWeights: { boulder: 3, ramp: 1, log: 2.5 } }; },
    ]) {
      const s = resolved();
      mutate(s);
      expect(bytesEqual(a, serializeEvaluationSpec(s))).toBe(false);
    }
  });

  test('a terrain object missing a declared knob fails loud (walk/keys drift tooth)', () => {
    const s = resolved();
    s.terrain = { ...s.terrain };
    delete s.terrain.mudCoverage;
    expect(() => serializeEvaluationSpec(s)).toThrow(/diverge from the declared walk/);
  });
});

describe('fitness-vector encoding v1', () => {
  const synth = (entries) => ({
    spec: {
      deterministic: true,
      termination: 'maxSteps',
      maxSteps: 120,
      spawn: { x: -45, z: 0, clearance: SPAWN_CLEARANCE },
      targetWheelSurfaceSpeed: 5,
      wheelFriction: 1,
      terrain: { ...TERRAIN_DEFAULTS, ...FLAT_TERRAIN },
    },
    populationSnapshotDigestState: 0xdeadbeef,
    individuals: entries.map(([individualId, fitness, valid]) => ({ individualId, fitness, valid })),
  });

  test('hand-decoded header + per-individual walk; an invalid 0 is byte-distinct from a valid 0', () => {
    const validZero = serializeFitnessVector(synth([[7, 0, true]]));
    const invalidZero = serializeFitnessVector(synth([[7, 0, false]]));
    expect(validZero.length).toBe(20 + 13);
    const view = new DataView(validZero.buffer, validZero.byteOffset, validZero.byteLength);
    expect(view.getUint16(0, true)).toBe(FITNESS_VECTOR_VERSION);
    expect(view.getUint16(2, true)).toBe(FITNESS_POLICY_VERSION);
    expect(view.getUint16(4, true)).toBe(POPULATION_SNAPSHOT_VERSION);
    expect(view.getUint32(6, true)).toBe(0xdeadbeef);
    expect(view.getUint16(10, true)).toBe(EVALUATION_SPEC_VERSION);
    // offset 12..15: spec digest state (checked nonzero), 16..19: count
    expect(view.getUint32(16, true)).toBe(1);
    expect(view.getUint32(20, true)).toBe(7); // individualId
    expect(view.getUint8(24)).toBe(1); // validity
    expect(view.getFloat64(25, true)).toBe(0);
    // The two vectors differ at EXACTLY the validity byte.
    const diffs = [];
    validZero.forEach((b, i) => { if (b !== invalidZero[i]) diffs.push(i); });
    expect(diffs).toEqual([24]);
  });

  test('exact f64 fitness round-trips bit-for-bit', () => {
    const f = 8.419723510742188;
    const bytes = serializeFitnessVector(synth([[0, f, true]]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(Object.is(view.getFloat64(25, true), f)).toBe(true);
  });

  test('rejects non-ascending individualIds loud (canonical order is the contract)', () => {
    expect(() => serializeFitnessVector(synth([[5, 1, true], [3, 1, true]])))
      .toThrow(/strictly ascending/);
  });
});

// --- Evaluator validation (pre-world, fail-loud) ------------------------------

describe('evaluatePopulation validation', () => {
  const goodPop = () => popOf(member(0, s0PlainGenotype()));

  test.each([
    ['unknown spec key', { ...baseSpec(), maxsteps: 5 }],
    ['missing terrain seed', { ...baseSpec(), terrain: { startFlatLength: 80 } }],
    ['unknown terrain key', { ...baseSpec(), terrain: { ...FLAT_TERRAIN, craterDensitty: 0 } }],
    ['maxSteps 0', { ...baseSpec(), maxSteps: 0 }],
    ['spawn missing', { ...baseSpec(), spawn: undefined }],
    ['spawn.x off the pad', { ...baseSpec(), spawn: { x: 18, z: 0 } }],
    ['spawn.x too close to the pad start', { ...baseSpec(), spawn: { x: -58, z: 0 } }],
    ['unknown spawn key', { ...baseSpec(), spawn: { x: -45, z: 0, y: 1 } }],
    ['unknown hook', { ...baseSpec(), hooks: { onphase: () => {} } }],
    ['non-finite target speed', { ...baseSpec(), targetWheelSurfaceSpeed: NaN }],
    ['negative wheelFriction', { ...baseSpec(), wheelFriction: -1 }],
  ])('rejects %s pre-world', async (_name, spec) => {
    await expect(evaluatePopulation(goodPop(), spec)).rejects.toThrow(/population-evaluation: invalid/);
  });

  test('an imported population with an S2 axle fails LOUD with its individualId and axle path — never silently masked', async () => {
    const p = popOf(member(3, s2Genotype()));
    await expect(evaluatePopulation(p, baseSpec()))
      .rejects.toThrow(/individual 3 axles\[1\].*'S2'.*never silently masked/s);
  });

  test('a non-canonical population is rejected by the shared population gate', async () => {
    const raw = s0PlainGenotype();
    raw.axles[0].radius = 0; // repair moves it
    const p = popOf({ individualId: 0, genotype: raw });
    await expect(evaluatePopulation(p, baseSpec())).rejects.toThrow(/not canonical/);
  });
});

// --- Physics witnesses (deterministic flavor) ---------------------------------

describe('evaluatePopulation (deterministic flavor)', () => {
  test('id-keyed results, isolation contract vs a MANUAL solo run, and input-permutation invariance', { timeout: 240000 }, async () => {
    const a = member(5, s0PlainGenotype());
    const b = member(9, mixedRadiusGenotype());
    const seen = [];
    const spec = { ...baseSpec(), hooks: { onIndividual: (id, i, n) => seen.push([id, i, n]) } };

    const ev = await evaluatePopulation(popOf(a, b), spec);
    expect(ev.worldMode).toBe(POPULATION_WORLD_MODE);
    expect(ev.worldMode).toBe('isolatedWorlds');
    expect(ev.individuals.map((i) => i.individualId)).toEqual([5, 9]);
    expect(seen).toEqual([[5, 0, 2], [9, 1, 2]]);
    for (const ind of ev.individuals) {
      expect(ind.valid).toBe(true);
      expect(Object.is(ind.fitness, ind.diagnostics.maxForwardDistance)).toBe(true);
      expect(ind.fitness).toBeGreaterThan(0);
    }
    expect(ev.fitnessVector.digest).toMatch(/^[0-9a-f]{8}$/);

    // Isolation contract: member 5's diagnostics leaf-equal a MANUAL solo
    // runEvaluation under the same declared inputs.
    const ir = compileAssembly(a.genotype);
    const solo = await runEvaluation({
      deterministic: true,
      terrain: { ...FLAT_TERRAIN },
      vehicles: [{
        ir,
        spawn: spawnPoseOnFlatStart(ir, { x: -45, z: 0 }),
        targetWheelSurfaceSpeed: 5,
        wheelFriction: 1,
      }],
      maxSteps: 120,
      trace: { mode: 'none' },
    });
    const v = solo.vehicles[0];
    assertLeafEqual({
      forwardDistance: v.forwardDistance,
      maxForwardDistance: v.maxForwardDistance,
      stepAtMaxForwardDistance: v.stepAtMaxForwardDistance,
      maxBackwardDistance: v.maxBackwardDistance,
      origin: v.origin,
      finalPose: v.finalPose,
      finalVelocity: v.finalVelocity,
      finite: v.finite,
      terminated: v.terminated,
      bodies: v.bodies,
      joints: v.joints,
      mass: v.mass,
      stationCount: v.stationCount,
    }, ev.individuals[0].diagnostics, 'individual 5');

    // Input order is invisible: reversed input, identical ID-keyed output
    // and identical fitness-vector bytes.
    const reversed = await evaluatePopulation(popOf(b, a), { ...baseSpec() });
    expect(bytesEqual(ev.fitnessVector.bytes, reversed.fitnessVector.bytes)).toBe(true);
    assertLeafEqual(
      ev.individuals.map(({ individualId, fitness, valid }) => ({ individualId, fitness, valid })),
      reversed.individuals.map(({ individualId, fitness, valid }) => ({ individualId, fitness, valid })),
      'permuted individuals',
    );
  });

  test('a zero-axle sled imported into a population evaluates as a valid ~0-fitness individual', { timeout: 240000 }, async () => {
    const ev = await evaluatePopulation(popOf(member(2, sledGenotype())), baseSpec());
    const sled = ev.individuals[0];
    expect(sled.valid).toBe(true); // joints.allValid vacuously true on a sled
    expect(sled.fitness).toBeGreaterThanOrEqual(0);
    expect(sled.fitness).toBeLessThan(0.01); // settle noise only
    expect(sled.diagnostics.stationCount).toBe(0);
  });
});
