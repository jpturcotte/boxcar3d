// deserializeEvaluationSpec + deserializeFitnessVector — the inverses of the
// evaluation-identity and fitness-vector encodings. Pure: no Rapier, no
// physics anywhere in this file.
//
// VALIDATION-DEPTH CONTRACT (the load-bearing asymmetry): each decoder mirrors
// its SERIALIZER's checks, not the evaluator's. serializeEvaluationSpec
// validates wire shape and finiteness only — it never runs resolveSpec — so
// the spec decoder must accept every stream the encoder can legally produce,
// including specs whose spawn/clearance/friction would be refused at execution
// time. A decoder stricter than its encoder is not an inverse. That case is
// asserted positively below.
//
// The committed a6d04f75 fitness vector is reconstructed WITHOUT re-running
// evaluatePopulation (which tests/population-determinism.test.js already runs
// in the same suite): the snapshot state comes from the physics-free fixture
// builder and the per-member rows come from the imported lock, so this file
// duplicates no digest literal.
//
// Seeds: 20260722 (fixture-A terrain), 20260723 (the declared flat terrain,
// copy-declared from tests/population-evaluation.test.js).

import { describe, test, expect } from 'vitest';
import {
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION, FITNESS_VECTOR_VERSION,
  SPAWN_CLEARANCE, deserializeEvaluationSpec, deserializeFitnessVector,
  serializeEvaluationSpec, serializeFitnessVector,
} from '../src/sim/population-evaluation.js';
import { POPULATION_SNAPSHOT_VERSION, bytesEqual, serializePopulationSnapshot } from '../src/sim/population.js';
import { INTEGRITY_POLICY_VERSION, INTEGRITY_STATUS } from '../src/sim/integrity.js';
import { TERRAIN_DEFAULTS } from '../src/sim/terrain.js';
import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHexOf } from '../src/sim/fnv1a.js';
import { POPULATION_FIXTURE_A, populationEvaluationInputsFor } from '../src/sim/population-fixtures.js';
import { POPULATION_GOLDEN_LOCKS } from '../src/sim/population-locks.js';

const LOCK = POPULATION_GOLDEN_LOCKS[POPULATION_FIXTURE_A.name];

// Copy-declared from tests/population-evaluation.test.js.
const FLAT_TERRAIN = Object.freeze({
  seed: 20260723,
  length: 120,
  craterDensity: 0,
  featureDensity: 0,
  sandCoverage: 0,
  mudCoverage: 0,
  macroAmp: 0,
  microAmp: 0,
  startFlatLength: 60,
});

const resolvedFlat = () => ({
  deterministic: true,
  termination: 'maxSteps',
  maxSteps: 120,
  spawn: { x: -45, z: 0, clearance: SPAWN_CLEARANCE },
  targetWheelSurfaceSpeed: 5,
  wheelFriction: 1,
  terrain: { ...TERRAIN_DEFAULTS, ...FLAT_TERRAIN },
});

// The fixture-A RESOLVED spec, copy-declared (the fixture ships the unresolved
// form; resolveSpec is module-private, and the committed digest is over this).
const resolvedFixtureA = () => ({
  deterministic: true,
  termination: 'maxSteps',
  maxSteps: 300,
  spawn: { x: -44, z: 0, clearance: SPAWN_CLEARANCE },
  targetWheelSurfaceSpeed: 5,
  wheelFriction: 1,
  terrain: { ...TERRAIN_DEFAULTS, seed: 20260722, startFlatLength: 30, startBlendLength: 6 },
});

function assertSpecLeafEqual(actual, expected) {
  expect(actual.deterministic).toBe(expected.deterministic);
  expect(actual.termination).toBe(expected.termination);
  expect(actual.maxSteps).toBe(expected.maxSteps);
  expect(Object.is(actual.spawn.x, expected.spawn.x)).toBe(true);
  expect(Object.is(actual.spawn.z, expected.spawn.z)).toBe(true);
  expect(Object.is(actual.spawn.clearance, expected.spawn.clearance)).toBe(true);
  expect(Object.is(actual.targetWheelSurfaceSpeed, expected.targetWheelSurfaceSpeed)).toBe(true);
  expect(Object.is(actual.wheelFriction, expected.wheelFriction)).toBe(true);
  expect(Object.keys(actual.terrain).sort()).toEqual(Object.keys(expected.terrain).sort());
  for (const k of Object.keys(expected.terrain)) {
    const e = expected.terrain[k];
    const a = actual.terrain[k];
    if (Array.isArray(e)) {
      expect(a, k).toHaveLength(e.length);
      e.forEach((v, i) => expect(Object.is(a[i], v), `${k}[${i}]`).toBe(true));
    } else if (e !== null && typeof e === 'object') {
      expect(Object.keys(a).sort(), k).toEqual(Object.keys(e).sort());
      for (const wk of Object.keys(e)) expect(Object.is(a[wk], e[wk]), `${k}.${wk}`).toBe(true);
    } else {
      expect(Object.is(a, e), k).toBe(true);
    }
  }
}

describe('evaluation spec — round trips', () => {
  test('the 401-byte default walk decodes every field and re-encodes byte-identically', () => {
    const spec = resolvedFlat();
    const bytes = serializeEvaluationSpec(spec);
    expect(bytes.length).toBe(401);
    const decoded = deserializeEvaluationSpec(bytes);
    assertSpecLeafEqual(decoded, spec);
    expect(Object.keys(decoded.terrain)).toHaveLength(33);
    expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
  });

  test('the committed fixture-A spec round-trips (composite terrain, all knobs)', () => {
    const spec = resolvedFixtureA();
    const bytes = serializeEvaluationSpec(spec);
    const decoded = deserializeEvaluationSpec(bytes);
    assertSpecLeafEqual(decoded, spec);
    expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
  });

  test('every declared terrain knob survives — ranges element-wise, weights by key', () => {
    const spec = resolvedFlat();
    const decoded = deserializeEvaluationSpec(serializeEvaluationSpec(spec));
    expect(decoded.terrain.seed).toBe(20260723);
    expect(decoded.terrain.craterRadiusRange).toEqual([...TERRAIN_DEFAULTS.craterRadiusRange]);
    expect(decoded.terrain.logLengthRange).toEqual([...TERRAIN_DEFAULTS.logLengthRange]);
    expect(Object.keys(decoded.terrain.featureTypeWeights)).toEqual(['boulder', 'ramp', 'log']);
    expect(decoded.terrain.featureTypeWeights).toEqual({ ...TERRAIN_DEFAULTS.featureTypeWeights });
  });

  test('non-default legal values round-trip (one mutation per encoded field class)', () => {
    for (const mutate of [
      (s) => { s.maxSteps = 121; },
      (s) => { s.deterministic = false; },
      (s) => { s.spawn = { ...s.spawn, x: -44 }; },
      (s) => { s.wheelFriction = 0.9; },
      (s) => { s.targetWheelSurfaceSpeed = 7.25; },
      (s) => { s.terrain = { ...s.terrain, seed: 20260724 }; },
      (s) => { s.terrain = { ...s.terrain, mudCoverage: 0.01 }; },
      (s) => { s.terrain = { ...s.terrain, logLengthRange: [3, 7.5] }; },
      (s) => { s.terrain = { ...s.terrain, featureTypeWeights: { boulder: 3, ramp: 1, log: 2.5 } }; },
    ]) {
      const spec = resolvedFlat();
      mutate(spec);
      const bytes = serializeEvaluationSpec(spec);
      const decoded = deserializeEvaluationSpec(bytes);
      assertSpecLeafEqual(decoded, spec);
      expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
    }
  });

  test('the decoder returns values AS ENCODED, never re-resolved from current defaults', () => {
    const spec = resolvedFlat();
    spec.terrain = { ...spec.terrain, macroAmp: TERRAIN_DEFAULTS.macroAmp + 0.5 };
    const decoded = deserializeEvaluationSpec(serializeEvaluationSpec(spec));
    expect(decoded.terrain.macroAmp).toBe(TERRAIN_DEFAULTS.macroAmp + 0.5);
    // A knob explicitly RE-SET to the value it already holds is a no-op on the
    // wire — by design: the encoding binds resolved VALUES, not their
    // provenance, so "explicit" and "defaulted" cannot be distinguished and
    // the decoder has nothing to re-resolve.
    const explicit = resolvedFlat();
    explicit.terrain = { ...explicit.terrain, wallFriction: TERRAIN_DEFAULTS.wallFriction };
    expect(bytesEqual(serializeEvaluationSpec(explicit), serializeEvaluationSpec(resolvedFlat()))).toBe(true);
    expect(deserializeEvaluationSpec(serializeEvaluationSpec(explicit)).terrain.wallFriction)
      .toBe(TERRAIN_DEFAULTS.wallFriction);
  });

  test('ENCODER-PRODUCIBLE but execution-invalid streams decode cleanly (the inverse contract)', () => {
    // resolveSpec would reject each of these (clearance band, flat-pad guard,
    // non-negative friction), but serializeEvaluationSpec accepts them — so
    // the decoder must too, or it is not an inverse. Execution validation
    // stays with evaluatePopulation.
    for (const mutate of [
      (s) => { s.spawn = { ...s.spawn, clearance: 0.2 }; }, // outside (0, 0.05]
      (s) => { s.spawn = { ...s.spawn, x: 500 }; }, // far off the flat pad
      (s) => { s.wheelFriction = -1; }, // negative
      (s) => { s.targetWheelSurfaceSpeed = -5; },
    ]) {
      const spec = resolvedFlat();
      mutate(spec);
      const bytes = serializeEvaluationSpec(spec);
      const decoded = deserializeEvaluationSpec(bytes);
      assertSpecLeafEqual(decoded, spec);
      expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
    }
  });

  test('the decoded spec is deep-frozen (a digest already attested it)', () => {
    const decoded = deserializeEvaluationSpec(serializeEvaluationSpec(resolvedFlat()));
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.spawn)).toBe(true);
    expect(Object.isFrozen(decoded.terrain)).toBe(true);
    expect(Object.isFrozen(decoded.terrain.craterRadiusRange)).toBe(true);
    expect(Object.isFrozen(decoded.terrain.featureTypeWeights)).toBe(true);
  });
});

describe('evaluation spec — the u8 range-length wire bound', () => {
  test('an over-long range fails loud at the encoder instead of wrapping', () => {
    const spec = resolvedFlat();
    spec.terrain = { ...spec.terrain, craterRadiusRange: Array.from({ length: 256 }, (_, i) => i + 1) };
    expect(() => serializeEvaluationSpec(spec))
      .toThrow(/terrain\.craterRadiusRange\.length \(256 exceeds the u8 wire bound/);
  });
});

describe('evaluation spec — malformed streams fail loud', () => {
  const base = () => serializeEvaluationSpec(resolvedFlat());

  test('an unknown spec version', () => {
    const bytes = base();
    new DataView(bytes.buffer).setUint16(0, 2, true);
    expect(() => deserializeEvaluationSpec(bytes)).toThrow(/at specVersion \(2\)/);
  });

  test('a non-boolean deterministic byte and an unknown termination code', () => {
    const d = base();
    new DataView(d.buffer).setUint8(2, 2);
    expect(() => deserializeEvaluationSpec(d)).toThrow(/at deterministic \(2\)/);
    const t = base();
    new DataView(t.buffer).setUint8(3, 1);
    expect(() => deserializeEvaluationSpec(t)).toThrow(/at termination \(1\)/);
  });

  test('maxSteps 0', () => {
    const bytes = base();
    new DataView(bytes.buffer).setUint32(4, 0, true);
    expect(() => deserializeEvaluationSpec(bytes)).toThrow(/at maxSteps \(0\)/);
  });

  test('a wrong terrain key count', () => {
    for (const n of [0, 32, 34]) {
      const bytes = base();
      new DataView(bytes.buffer).setUint8(48, n);
      expect(() => deserializeEvaluationSpec(bytes), `count ${n}`).toThrow(/at terrainKeyCount/);
    }
  });

  test('a non-finite f64 anywhere in the walk', () => {
    for (const offset of [8, 24, 40, 53]) { // spawn.x, clearance, wheelFriction, terrain.length
      const bytes = base();
      new DataView(bytes.buffer).setFloat64(offset, NaN, true);
      expect(() => deserializeEvaluationSpec(bytes), `offset ${offset}`)
        .toThrow(/population-evaluation: invalid encoded evaluation spec at .*\(NaN\)/);
    }
  });

  test('a lying range length and a malformed weights block', () => {
    // Hand-computed offsets along the declared walk: header+count = 49;
    // seed u32 -> 53; 18 scalar f64 (length..craterDensity) -> 197;
    // craterRadiusRange (1+2x8) -> 214; craterDepthRatioRange -> 231;
    // 5 scalar f64 (zoneFrequency..featureDensity) -> 271 = featureTypeWeights.
    const CRATER_RADIUS_RANGE = 197;
    const WEIGHTS = 271;
    const bytes = base();
    expect(bytes[CRATER_RADIUS_RANGE]).toBe(2); // the range's own length byte
    expect(bytes[WEIGHTS]).toBe(3); // the weights count byte

    for (const bad of [1, 3, 0]) {
      const lying = Uint8Array.from(bytes);
      lying[CRATER_RADIUS_RANGE] = bad;
      expect(() => deserializeEvaluationSpec(lying), `range length ${bad}`)
        .toThrow(/population-evaluation: invalid encoded evaluation spec/);
    }
    const badCount = Uint8Array.from(bytes);
    badCount[WEIGHTS] = 2;
    expect(() => deserializeEvaluationSpec(badCount)).toThrow(/featureTypeWeights\.count \(2\)/);
    const badIndex = Uint8Array.from(bytes);
    badIndex[WEIGHTS + 1] = 2; // the first declared index must be 0
    expect(() => deserializeEvaluationSpec(badIndex)).toThrow(/declaredIndex \(2\)/);
    const swapped = Uint8Array.from(bytes);
    swapped[WEIGHTS + 1] = 1; // 1,1,2 instead of 0,1,2
    expect(() => deserializeEvaluationSpec(swapped)).toThrow(/boulder\.declaredIndex \(1\)/);
  });

  test('truncation and trailing bytes', () => {
    const full = base();
    for (const cut of [0, 1, 2, 4, 48, 49, 400]) {
      expect(() => deserializeEvaluationSpec(full.slice(0, cut)), `cut ${cut}`)
        .toThrow(/population-evaluation: invalid encoded evaluation spec/);
    }
    const extended = new Uint8Array(full.length + 1);
    extended.set(full);
    expect(() => deserializeEvaluationSpec(extended))
      .toThrow(/at evaluationSpec \(1 trailing byte\(s\) at offset 401\)/);
  });

  test('input bytes are not mutated and a subarray view decodes its own window', () => {
    const bytes = base();
    const before = Uint8Array.from(bytes);
    deserializeEvaluationSpec(bytes);
    expect(bytesEqual(bytes, before)).toBe(true);
    const parent = new Uint8Array(16 + bytes.length + 8).fill(0x5a);
    parent.set(bytes, 16);
    const decoded = deserializeEvaluationSpec(parent.subarray(16, 16 + bytes.length));
    assertSpecLeafEqual(decoded, resolvedFlat());
  });
});

// --- Fitness vector ----------------------------------------------------------

// Entry tuple: [individualId, fitness, valid, integrityStatus='ok'].
const synth = (entries, spec = resolvedFlat()) => ({
  spec,
  populationSnapshotDigestState: 0xdeadbeef,
  individuals: entries.map(([individualId, fitness, valid, integrityStatus = 'ok']) => (
    { individualId, fitness, valid, integrityStatus })),
});

function assertVectorLeafEqual(decoded, evaluation, specState) {
  expect(decoded.fitnessVectorVersion).toBe(FITNESS_VECTOR_VERSION);
  expect(decoded.fitnessPolicyVersion).toBe(FITNESS_POLICY_VERSION);
  expect(decoded.integrityPolicyVersion).toBe(INTEGRITY_POLICY_VERSION);
  expect(decoded.snapshotVersion).toBe(POPULATION_SNAPSHOT_VERSION);
  expect(decoded.evaluationSpecVersion).toBe(EVALUATION_SPEC_VERSION);
  expect(decoded.populationSnapshotDigestState).toBe(evaluation.populationSnapshotDigestState);
  if (specState !== undefined) expect(decoded.evaluationSpecDigestState).toBe(specState);
  expect(decoded.individuals).toHaveLength(evaluation.individuals.length);
  evaluation.individuals.forEach((ind, i) => {
    expect(decoded.individuals[i].individualId).toBe(ind.individualId);
    expect(decoded.individuals[i].valid).toBe(ind.valid);
    expect(decoded.individuals[i].integrityStatus).toBe(ind.integrityStatus);
    expect(Object.is(decoded.individuals[i].fitness, ind.fitness), `fitness[${i}]`).toBe(true);
  });
}

describe('fitness vector — the committed contract (reconstructed without physics)', () => {
  const reconstruct = () => {
    const { population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const snapshotState = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population));
    return {
      spec: resolvedFixtureA(),
      populationSnapshotDigestState: snapshotState,
      // All 20 members are integrity-clean in the committed fixture (recorded
      // in population-locks.js), so the lock's rows fully determine the vector.
      individuals: LOCK.individuals.map((m) => ({
        individualId: m.individualId,
        valid: m.valid,
        integrityStatus: 'ok',
        fitness: m.fitness,
      })),
    };
  };

  test('the reconstruction reproduces the committed fitness-vector digest', () => {
    // Read through the imported lock — this file never duplicates the literal.
    const bytes = serializeFitnessVector(reconstruct());
    expect(fnv1aHexOf(fnv1aFold(FNV_OFFSET_BASIS, bytes))).toBe(LOCK.fitnessVectorDigest);
    expect(fnv1aHexOf(fnv1aFold(FNV_OFFSET_BASIS, serializeEvaluationSpec(resolvedFixtureA()))))
      .toBe(LOCK.evaluationSpecDigest);
  });

  test('it decodes to the locked rows and re-encodes byte-identically', () => {
    const evaluation = reconstruct();
    const bytes = serializeFitnessVector(evaluation);
    const decoded = deserializeFitnessVector(bytes);
    assertVectorLeafEqual(decoded, evaluation,
      fnv1aFold(FNV_OFFSET_BASIS, serializeEvaluationSpec(resolvedFixtureA())));
    expect(decoded.individuals.map((m) => m.individualId)).toEqual(LOCK.orderedIndividualIds);
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });
});

describe('fitness vector — the additive digest-state input path', () => {
  test('encoding from a decoded record (state only, no spec) is byte-identical', () => {
    const evaluation = synth([[0, 1.5, true], [1, 0, false], [2, 0, true, 'numericalDivergence']]);
    const bytes = serializeFitnessVector(evaluation);
    const decoded = deserializeFitnessVector(bytes);
    expect(decoded.spec).toBeUndefined();
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });

  test('a declared state that AGREES with the spec is accepted; a disagreeing one is refused', () => {
    const evaluation = synth([[0, 1, true]]);
    const state = fnv1aFold(FNV_OFFSET_BASIS, serializeEvaluationSpec(evaluation.spec));
    expect(bytesEqual(
      serializeFitnessVector({ ...evaluation, evaluationSpecDigestState: state }),
      serializeFitnessVector(evaluation),
    )).toBe(true);
    expect(() => serializeFitnessVector({ ...evaluation, evaluationSpecDigestState: (state ^ 1) >>> 0 }))
      .toThrow(/evaluationSpecDigestState.*disagrees with the spec's computed state/);
  });

  test('neither spec nor a canonical-uint32 state fails loud', () => {
    const withoutSpec = synth([[0, 1, true]]);
    delete withoutSpec.spec;
    for (const bad of [undefined, -1, 1.5, 0x100000000, NaN, '7']) {
      const evaluation = bad === undefined ? withoutSpec : { ...withoutSpec, evaluationSpecDigestState: bad };
      expect(() => serializeFitnessVector(evaluation), String(bad))
        .toThrow(/at evaluation\.evaluationSpecDigestState/);
    }
  });
});

describe('fitness vector — synthetic coverage', () => {
  test('selectable positive, selectable zero, and every unselectable gated zero', () => {
    const cases = [
      [[0, 12.484905242919922, true]], // selectable positive (exact f64)
      [[0, 0, true]], // selectable zero
      [[0, 0, false]], // invalid -> gated zero
      [[0, 0, true, 'nonFinite']],
      [[0, 0, true, 'numericalDivergence']],
      [[0, 0, false, 'numericalDivergence']],
      [[0, 8.419723510742188, true], [7, 0, false], [0xffffffff, 0, true, 'nonFinite']],
    ];
    for (const entries of cases) {
      const evaluation = synth(entries);
      const bytes = serializeFitnessVector(evaluation);
      expect(bytes.length).toBe(22 + entries.length * 14);
      const decoded = deserializeFitnessVector(bytes);
      assertVectorLeafEqual(decoded, evaluation);
      expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
    }
  });

  test('every integrity status is representable and decodes to its name', () => {
    for (const status of INTEGRITY_STATUS) {
      const evaluation = synth([[1, 0, status === 'ok', status]]);
      const decoded = deserializeFitnessVector(serializeFitnessVector(evaluation));
      expect(decoded.individuals[0].integrityStatus).toBe(status);
    }
  });

  test('the decoded record and its rows are frozen', () => {
    const decoded = deserializeFitnessVector(serializeFitnessVector(synth([[0, 1, true]])));
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.individuals)).toBe(true);
    expect(Object.isFrozen(decoded.individuals[0])).toBe(true);
  });
});

describe('fitness vector — malformed streams fail loud', () => {
  const base = () => serializeFitnessVector(synth([[3, 2.5, true], [9, 0, false]]));
  // Header: vectorVersion@0, policyVersion@2, integrityPolicyVersion@4,
  // snapshotVersion@6, snapshotState@8, specVersion@12, specState@14, count@18.
  // Member i at 22 + 14i: id u32, valid u8, status u8, fitness f64.
  const MEMBER = (i) => 22 + 14 * i;

  test('each of the five header versions must match its current constant', () => {
    for (const [offset, field] of [[0, 'fitnessVectorVersion'], [2, 'fitnessPolicyVersion'],
      [4, 'integrityPolicyVersion'], [6, 'snapshotVersion'], [12, 'evaluationSpecVersion']]) {
      const bytes = base();
      const view = new DataView(bytes.buffer);
      view.setUint16(offset, view.getUint16(offset, true) + 1, true);
      expect(() => deserializeFitnessVector(bytes), field).toThrow(new RegExp(`at ${field} \\(`));
    }
  });

  test('a positive fitness on an unselectable member is REJECTED, never normalized to 0', () => {
    // Flip member 0 to invalid while its 2.5 fitness stays in the bytes.
    const bytes = base();
    new DataView(bytes.buffer).setUint8(MEMBER(0) + 4, 0);
    expect(() => deserializeFitnessVector(bytes))
      .toThrow(/unselectable individual \(valid false, integrity ok\) must have fitness 0, got 2\.5/);
    // Same via the integrity byte.
    const b2 = base();
    new DataView(b2.buffer).setUint8(MEMBER(0) + 5, 2);
    expect(() => deserializeFitnessVector(b2))
      .toThrow(/unselectable individual \(valid true, integrity numericalDivergence\) must have fitness 0/);
  });

  test('duplicate and unordered individual ids', () => {
    const dup = base();
    new DataView(dup.buffer).setUint32(MEMBER(1), 3, true);
    expect(() => deserializeFitnessVector(dup)).toThrow(/must be strictly ascending \(previous 3\)/);
    const unordered = base();
    const view = new DataView(unordered.buffer);
    view.setUint32(MEMBER(0), 9, true);
    view.setUint32(MEMBER(1), 3, true);
    expect(() => deserializeFitnessVector(unordered)).toThrow(/3 must be strictly ascending \(previous 9\)/);
  });

  test('a count that disagrees with the payload length', () => {
    for (const count of [0, 1, 3]) {
      const bytes = base();
      new DataView(bytes.buffer).setUint32(18, count, true);
      expect(() => deserializeFitnessVector(bytes), `count ${count}`)
        .toThrow(/at count \(0\)|at byteLength/);
    }
  });

  test('a malformed validity byte or unknown integrity status', () => {
    const v = base();
    new DataView(v.buffer).setUint8(MEMBER(0) + 4, 2);
    expect(() => deserializeFitnessVector(v)).toThrow(/individuals\[0\]\.valid \(2\)/);
    const s = base();
    new DataView(s.buffer).setUint8(MEMBER(0) + 5, INTEGRITY_STATUS.length);
    expect(() => deserializeFitnessVector(s)).toThrow(/individuals\[0\]\.integrityStatus \(3\)/);
  });

  test('a negative or non-finite fitness', () => {
    for (const f of [-1, -0.5, NaN, Infinity, -Infinity]) {
      const bytes = base();
      new DataView(bytes.buffer).setFloat64(MEMBER(0) + 6, f, true);
      expect(() => deserializeFitnessVector(bytes), String(f)).toThrow(/individuals\[0\]\.fitness/);
    }
  });

  test('truncation and trailing bytes', () => {
    const full = base();
    for (const cut of [0, 1, 12, 18, 21, 22, 30, 35, full.length - 1]) {
      expect(() => deserializeFitnessVector(full.slice(0, cut)), `cut ${cut}`)
        .toThrow(/population-evaluation: invalid encoded fitness vector/);
    }
    const extended = new Uint8Array(full.length + 1);
    extended.set(full);
    expect(() => deserializeFitnessVector(extended)).toThrow(/at byteLength \(51 \(expected 50/);
  });

  test('input bytes are not mutated and a subarray view decodes its own window', () => {
    const bytes = base();
    const before = Uint8Array.from(bytes);
    deserializeFitnessVector(bytes);
    expect(bytesEqual(bytes, before)).toBe(true);
    const parent = new Uint8Array(8 + bytes.length + 8).fill(0x3c);
    parent.set(bytes, 8);
    const decoded = deserializeFitnessVector(parent.subarray(8, 8 + bytes.length));
    expect(decoded.individuals.map((m) => m.individualId)).toEqual([3, 9]);
  });
});
