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
// copy-declared from tests/population-evaluation.test.js), 123456 (the small
// declared manifest seed, copy-declared from tests/population-codec.test.js,
// used only by the digest-state cross-check tooth at the end).

import { describe, test, expect } from 'vitest';
import {
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION, FITNESS_VECTOR_VERSION,
  SPAWN_CLEARANCE, deserializeEvaluationSpec, deserializeFitnessVector,
  fitnessVectorByteLength, peekFitnessVectorVersions, serializeEvaluationSpec,
  serializeFitnessVector,
} from '../src/sim/population-evaluation.js';
import { POPULATION_SNAPSHOT_VERSION, bytesEqual, serializePopulationSnapshot } from '../src/sim/population.js';
import {
  createInitialPopulation, serializePopulationInitialization,
} from '../src/sim/population-initializer.js';
import {
  INTEGRITY_POLICY_VERSION, INTEGRITY_STATUS, INTEGRITY_THRESHOLDS,
} from '../src/sim/integrity.js';
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

  test('the bound is enforced BEFORE allocation, so no foreign RangeError escapes', () => {
    // The size pass multiplies the DECLARED length by 8. Validating at the
    // write instead would size the buffer from an unvalidated length first:
    // measured, ~17 GB reserved at 2^31 and a generic `RangeError: Array
    // buffer allocation failed` at 2^40. An array-LIKE carries the huge
    // length without allocating storage, so this test is cheap.
    for (const length of [2 ** 31, 2 ** 40, 2 ** 50, Number.MAX_SAFE_INTEGER]) {
      const spec = resolvedFlat();
      spec.terrain = {
        ...spec.terrain,
        craterRadiusRange: { length, [Symbol.iterator]: function* gen() {} },
      };
      let thrown;
      try { serializeEvaluationSpec(spec); } catch (err) { thrown = err; }
      expect(thrown, `length ${length} did not throw`).toBeDefined();
      expect(thrown, `length ${length} threw a foreign ${thrown && thrown.constructor.name}`)
        .not.toBeInstanceOf(RangeError);
      expect(thrown.message).toMatch(/population-evaluation: invalid evaluation spec at terrain\.craterRadiusRange\.length/);
    }
  });

  test('a range is read BY INDEX, so a tampered iterator cannot change what is attested', () => {
    // INDICES ARE THE TRUTH. terrain.js consumes every range by index
    // (`cfg.craterRadiusRange[0]`, `[1]`), so the indexed content is what the
    // described run actually executes on. The encoder therefore reads indices
    // and never iterates — which makes an overridden Symbol.iterator
    // irrelevant rather than a special case to detect.
    const withRange = (range) => {
      const spec = resolvedFlat();
      spec.terrain = { ...spec.terrain, craterRadiusRange: range };
      return spec;
    };

    // A GENUINE Array carrying a lying iterator. Array.isArray stays true, so
    // an isArray check alone was never the discriminator — the READ is. The
    // stream must carry [2, 5] (the indices terrain.js reads), not [9, 9].
    const tampered = [2, 5];
    tampered[Symbol.iterator] = function* lie() { yield 9; yield 9; };
    expect(Array.isArray(tampered)).toBe(true);
    const fromTampered = serializeEvaluationSpec(withRange(tampered));
    expect(bytesEqual(fromTampered, serializeEvaluationSpec(withRange([2, 5])))).toBe(true);
    expect(bytesEqual(fromTampered, serializeEvaluationSpec(withRange([9, 9])))).toBe(false);
    expect(deserializeEvaluationSpec(fromTampered).terrain.craterRadiusRange).toEqual([2, 5]);

    // THE WORST CASE, and the reason a downstream decoder can never be the
    // backstop: at the LAST range in the declared walk nothing follows to run
    // short, so an iterator-sourced stream decoded CLEANLY and re-encoded
    // byte-identically — a digest attesting a terrain that never existed.
    const lastRange = [3, 7];
    lastRange[Symbol.iterator] = function* lie() { yield 1; yield 1; };
    const lastSpec = resolvedFlat();
    lastSpec.terrain = { ...lastSpec.terrain, logLengthRange: lastRange };
    const honest = resolvedFlat();
    honest.terrain = { ...honest.terrain, logLengthRange: [3, 7] };
    expect(bytesEqual(serializeEvaluationSpec(lastSpec), serializeEvaluationSpec(honest))).toBe(true);

    // An iterable with NO indices cannot be encoded at all: the declared slots
    // read `undefined` and the f64 gate refuses them loud. Under- and
    // over-yielding and an INFINITE generator all land here identically —
    // the iterator is never consumed, so there is nothing to run short,
    // overrun the DataView, or hang on.
    const started = Date.now();
    for (const [label, range] of [
      ['under-yields', { length: 2, * [Symbol.iterator]() { yield 2; } }],
      ['over-yields', { length: 1, * [Symbol.iterator]() { yield 2; yield 5; } }],
      ['never ends', { length: 2, * [Symbol.iterator]() { for (;;) yield 1; } }],
    ]) {
      let thrown;
      try { serializeEvaluationSpec(withRange(range)); } catch (err) { thrown = err; }
      expect(thrown, label).toBeDefined();
      expect(thrown, `${label} threw a foreign ${thrown && thrown.constructor.name}`)
        .not.toBeInstanceOf(RangeError);
      expect(thrown.message, label)
        .toMatch(/population-evaluation: invalid evaluation spec at terrain\.craterRadiusRange\[\] \(undefined\)/);
    }
    expect(Date.now() - started).toBeLessThan(1000); // no hang on the infinite one

    // A null/non-object range fails as a module error, not a foreign TypeError.
    for (const bad of [null, undefined, 42]) {
      let err;
      try { serializeEvaluationSpec(withRange(bad)); } catch (e) { err = e; }
      expect(err, String(bad)).toBeDefined();
      expect(err.message, String(bad)).toMatch(/population-evaluation: invalid evaluation spec at terrain\.craterRadiusRange/);
    }
  });

  test('an HONEST array-like encodes exactly as the equivalent array (no hole, no shift)', () => {
    // The positive half of the contract: cardinality matching its length is
    // legal input, and the emitted stream is byte-identical to the real-array
    // form — which is only possible if the writer consumed the whole buffer
    // with no zero-filled gap.
    const withRange = (range) => {
      const spec = resolvedFlat();
      spec.terrain = { ...spec.terrain, craterRadiusRange: range };
      return spec;
    };
    const fromArrayLike = serializeEvaluationSpec(withRange({ length: 2, 0: 3, 1: 7 }));
    const fromArray = serializeEvaluationSpec(withRange([3, 7]));
    expect(bytesEqual(fromArrayLike, fromArray)).toBe(true);
    expect(fromArrayLike.length).toBe(401); // the honest size — no over- or under-allocation
    const decoded = deserializeEvaluationSpec(fromArrayLike);
    expect(decoded.terrain.craterRadiusRange).toEqual([3, 7]);
    expect(bytesEqual(serializeEvaluationSpec(decoded), fromArrayLike)).toBe(true);
  });

  test('a non-integer or negative declared length is refused too', () => {
    for (const length of [1.5, -1, NaN]) {
      const spec = resolvedFlat();
      spec.terrain = {
        ...spec.terrain,
        craterRadiusRange: { length, [Symbol.iterator]: function* gen() {} },
      };
      expect(() => serializeEvaluationSpec(spec), `length ${length}`)
        .toThrow(/terrain\.craterRadiusRange\.length/);
    }
  });

  test('deterministic is a STRICT boolean — truthiness can never flip the physics flavor', () => {
    // `s.deterministic ? 1 : 0` encoded the string 'false' and a boxed
    // `new Boolean(false)` (which PRINTS as false) as TRUE — silently flipping
    // the field that selects the engine, so deserialize(serialize(spec)) was
    // no longer semantically the input and the digest attested the wrong
    // flavor. resolveSpec was already strict; the public encoder now is too.
    for (const bad of ['false', 'true', 0, 1, undefined, null, new Boolean(false), new Boolean(true)]) {
      const spec = resolvedFlat();
      spec.deterministic = bad;
      expect(() => serializeEvaluationSpec(spec), String(bad))
        .toThrow(/population-evaluation: invalid evaluation spec at deterministic/);
    }
    for (const good of [true, false]) {
      const spec = resolvedFlat();
      spec.deterministic = good;
      const decoded = deserializeEvaluationSpec(serializeEvaluationSpec(spec));
      expect(decoded.deterministic).toBe(good);
    }
  });

  test('spawn and featureTypeWeights are structurally guarded — no foreign TypeError', () => {
    // The round-5 terrain guard was a one-instance patch: spawn: null leaked
    // `Cannot read properties of null (reading 'x')` and a null weights
    // object leaked `Cannot convert undefined or null to object`. Every
    // structural dereference in the encoder now fails in the module dialect.
    for (const [label, mutate] of [
      ['spawn null', (s) => { s.spawn = null; }],
      ['spawn missing', (s) => { delete s.spawn; }],
      ['spawn scalar', (s) => { s.spawn = 42; }],
      ['weights null', (s) => { s.terrain = { ...s.terrain, featureTypeWeights: null }; }],
      ['weights scalar', (s) => { s.terrain = { ...s.terrain, featureTypeWeights: 42 }; }],
    ]) {
      const spec = resolvedFlat();
      mutate(spec);
      let thrown;
      try { serializeEvaluationSpec(spec); } catch (err) { thrown = err; }
      expect(thrown, label).toBeDefined();
      expect(thrown, `${label} threw a foreign ${thrown && thrown.constructor.name}`)
        .not.toBeInstanceOf(TypeError);
      expect(thrown.message, label).toMatch(/population-evaluation: invalid evaluation spec at/);
    }
  });

  test('a malformed spec OBJECT fails in this module dialect, not a foreign TypeError', () => {
    // `typeof s === 'object'` admits [], Map, Date and a bare {} — none of
    // which carry a terrain. The drift teeth call Object.keys(terrain)
    // immediately after, so without a terrain guard the SIMPLEST malformed
    // input a caller can pass leaked `TypeError: Cannot convert undefined or
    // null to object` out of a public encoder. Replay and import tooling
    // cannot act on a foreign error.
    for (const [label, input] of [
      ['{}', {}], ['[]', []], ['Map', new Map()], ['Date', new Date()],
      ['terrain null', { ...resolvedFlat(), terrain: null }],
      ['terrain scalar', { ...resolvedFlat(), terrain: 42 }],
    ]) {
      let thrown;
      try { serializeEvaluationSpec(input); } catch (err) { thrown = err; }
      expect(thrown, label).toBeDefined();
      expect(thrown, `${label} threw a foreign ${thrown && thrown.constructor.name}`)
        .not.toBeInstanceOf(TypeError);
      expect(thrown.message, label)
        .toMatch(/population-evaluation: invalid evaluation spec at terrain/);
    }
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

// The v3 observation block, as a DECLARED coherent default per status. This is
// a fixture builder, not an expectation calculator: it constructs inputs the
// policy-v1 detector could legally have produced, and every assertion below
// still names its own expected values.
const OBSERVATIONS = Object.freeze({
  // Nothing ever crossed: peaks may be any non-negative value, both onsets null.
  ok: Object.freeze({
    peakBodySpeed: 3.5,
    peakSpeedDelta: 1.25,
    peakStepDisplacement: 0.0625,
    firstAlertStep: null,
    firstCatastrophicStep: null,
  }),
  // A catastrophic crossing implies an alert crossing at or before it (policy
  // v1: the same body at the same capture, 1000 > 25 under one dtScale).
  numericalDivergence: Object.freeze({
    peakBodySpeed: 4096,
    peakSpeedDelta: 2048,
    peakStepDisplacement: 64,
    firstAlertStep: 6,
    firstCatastrophicStep: 11,
  }),
  // A non-finite body can leave every peak finite: NaN samples never take a
  // peak (`speed > peak` is false for NaN) and never fire a predicate.
  nonFinite: Object.freeze({
    peakBodySpeed: 12,
    peakSpeedDelta: 9,
    peakStepDisplacement: 0.5,
    firstAlertStep: null,
    firstCatastrophicStep: null,
  }),
});

const OBSERVATION_KEYS = Object.freeze([
  'peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement',
  'firstAlertStep', 'firstCatastrophicStep',
]);

// The v3 member geometry, COPY-DECLARED from the encoding walk rather than
// imported: deriving offsets from the production constants would let a layout
// change move both sides together (the genotype-schema drift-triangle ruling).
// Header: vectorVersion@0, policyVersion@2, integrityPolicyVersion@4,
// snapshotVersion@6, snapshotState@8, specVersion@12, specState@14, count@18.
const MEMBER_BYTES = 48;
const MEMBER_AT = (i) => 22 + MEMBER_BYTES * i;
const AT = Object.freeze({
  individualId: 0,
  valid: 4,
  integrityStatus: 5,
  fitness: 6,
  peakBodySpeed: 14,
  peakSpeedDelta: 22,
  peakStepDisplacement: 30,
  firstAlertStepPresent: 38,
  firstAlertStep: 39,
  firstCatastrophicStepPresent: 43,
  firstCatastrophicStep: 44,
});

// Entry tuple: [individualId, fitness, valid, integrityStatus='ok', observations?].
const synth = (entries, spec = resolvedFlat()) => ({
  spec,
  populationSnapshotDigestState: 0xdeadbeef,
  individuals: entries.map(([individualId, fitness, valid, integrityStatus = 'ok',
    integrityObservations = OBSERVATIONS[integrityStatus]]) => (
    {
      individualId, fitness, valid, integrityStatus, integrityObservations,
    })),
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
    const o = decoded.individuals[i].integrityObservations;
    for (const key of OBSERVATION_KEYS) {
      expect(Object.is(o[key], ind.integrityObservations[key]), `${key}[${i}]`).toBe(true);
    }
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
      // in population-locks.js). Under vector v2 that fact ALONE determined the
      // bytes, because a clean member's only integrity field was its status.
      // v3 persists the OBSERVATIONS behind the status, and a clean vehicle's
      // peaks are ordinary nonzero measurements — so the lock now has to carry
      // them per member or this reconstruction is impossible. That is not
      // incidental bookkeeping: it is exactly the evidence Next PR needs, and
      // pinning it here is what keeps "the committed digest is reproducible
      // without physics" a true statement rather than one v3 quietly broke.
      individuals: LOCK.individuals.map((m) => ({
        individualId: m.individualId,
        valid: m.valid,
        integrityStatus: 'ok',
        fitness: m.fitness,
        integrityObservations: m.integrityObservations,
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
      expect(bytes.length).toBe(22 + entries.length * 48);
      const decoded = deserializeFitnessVector(bytes);
      assertVectorLeafEqual(decoded, evaluation);
      expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
    }
  });

  test('malformed rows fail in the module dialect — the preflight owns every row before the buffer exists', () => {
    // `individuals[i].individualId` was dereferenced without a shape check in
    // BOTH the ordering pass and the write pass: [null], sparse arrays, and a
    // null second row all leaked foreign TypeErrors from a public encoder.
    // The indexed preflight now snapshots every row into module-owned records
    // before allocation; the write pass re-reads nothing from the caller.
    const good = {
      individualId: 0,
      valid: true,
      integrityStatus: 'ok',
      fitness: 0,
      integrityObservations: OBSERVATIONS.ok,
    };
    const sparse = [good]; sparse.length = 2;
    for (const [label, inds] of [
      ['[null]', [null]],
      ['[undefined]', [undefined]],
      ['sparse', sparse],
      ['second row null', [good, null]],
    ]) {
      let thrown;
      try {
        serializeFitnessVector({ individuals: inds, populationSnapshotDigestState: 1, evaluationSpecDigestState: 2 });
      } catch (err) { thrown = err; }
      expect(thrown, label).toBeDefined();
      expect(thrown, `${label} threw a foreign ${thrown && thrown.constructor.name}`)
        .not.toBeInstanceOf(TypeError);
      expect(thrown.message, label)
        .toMatch(/population-evaluation: invalid evaluation spec at evaluation\.individuals\[/);
    }
  });

  test('a non-array individuals field is refused before any length is trusted', () => {
    // Why there is no u32 count guard here, unlike the axle-count,
    // range-length and populationSize guards: Array.isArray gates the field,
    // and a genuine Array cannot exceed 4294967295 — exactly the u32 max — so
    // an over-long count is unreachable by the language spec, not merely
    // unreachable today. An array-LIKE declaring a huge length never gets far
    // enough for the length to matter.
    const evaluation = synth([[0, 1, true]]);
    for (const bad of [{ length: 0x100000000 }, { length: 2 }, new Set(), null, 42]) {
      expect(() => serializeFitnessVector({ ...evaluation, individuals: bad }), String(bad))
        .toThrow(/population-evaluation: invalid .* at evaluation\.individuals/);
    }
    expect(() => { const a = []; a.length = 0x100000000; }).toThrow(RangeError);
    expect(serializeFitnessVector(evaluation).length).toBe(70);
  });

  test('an unselectable member may legally carry -0, and its sign bit survives', () => {
    // The encoder's coherence tooth is `fitness !== 0`, which -0 satisfies, so
    // -0 on an unselectable member is a LEGAL encoding. The decoder mirrors
    // that comparison verbatim: an Object.is-strict re-validation would be
    // stricter than the encoder and would reject bytes it legally produced.
    for (const [valid, integrityStatus] of [[false, 'ok'], [true, 'numericalDivergence'], [false, 'nonFinite']]) {
      const evaluation = synth([[2, -0, valid, integrityStatus]]);
      const bytes = serializeFitnessVector(evaluation);
      // The f64 sign byte of the member's fitness (member 0 at 22, fitness at
      // +6 => 28; little-endian, so the sign lands in the last byte, 35).
      expect(bytes[35], `${valid}/${integrityStatus} lost the sign bit`).toBe(0x80);
      const decoded = deserializeFitnessVector(bytes);
      expect(Object.is(decoded.individuals[0].fitness, -0)).toBe(true);
      expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
    }
  });

  test('a selectable member carrying -0 also round-trips bit-exactly', () => {
    const evaluation = synth([[2, -0, true]]);
    const bytes = serializeFitnessVector(evaluation);
    const decoded = deserializeFitnessVector(bytes);
    expect(Object.is(decoded.individuals[0].fitness, -0)).toBe(true);
    // -0 and +0 are DISTINCT streams: a normalizing codec would erase this.
    expect(bytesEqual(bytes, serializeFitnessVector(synth([[2, 0, true]])))).toBe(false);
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });

  test('a tampered individuals iterator cannot desynchronize the count from the records', () => {
    // The same systemic class as the terrain ranges: the u32 count comes from
    // individuals.length, so writing the records by iteration would leave a
    // zero-filled tail. The writer is index-based, so the true records are
    // encoded and the tampering is ignored.
    const evaluation = synth([[1, 1.5, true], [2, 2.5, true], [3, 0, false]]);
    evaluation.individuals[Symbol.iterator] = function* short() { yield evaluation.individuals[0]; };
    const bytes = serializeFitnessVector(evaluation);
    expect(bytes.length).toBe(22 + 3 * 48);
    const decoded = deserializeFitnessVector(bytes);
    expect(decoded.individuals.map((m) => m.individualId)).toEqual([1, 2, 3]);
    expect(decoded.individuals[1].fitness).toBe(2.5);
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
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

describe('fitness vector v3 — the integrity observations', () => {
  // THE HAND-COMPUTED ORACLE. Every byte below was written out from the
  // DECLARED wire walk and verified against IEEE-754 by hand, not produced by
  // serializeFitnessVector. That is the whole point: a test that builds its
  // expectation from the encoder proves only that the encoder equals itself,
  // which is how a reordered enum once slipped past two locks in this repo.
  //
  // Member 0 is clean with BOTH steps absent; member 1 carries
  // firstAlertStep = 0 PRESENT. Those two rows are the null-vs-zero
  // discriminator the flag design exists for: the step payloads are
  // byte-identical (four zero bytes) and only the flag byte separates
  // "never crossed" from "crossed at capture 0".
  const ORACLE_BYTES = Object.freeze([
    // --- header (22 bytes) ---
    0x03, 0x00, // u16 fitnessVectorVersion = 3
    0x02, 0x00, // u16 fitnessPolicyVersion = 2
    0x01, 0x00, // u16 integrityPolicyVersion = 1
    0x01, 0x00, // u16 snapshotVersion = 1
    0xef, 0xbe, 0xad, 0xde, // u32 populationSnapshotDigestState = 0xdeadbeef
    0x01, 0x00, // u16 evaluationSpecVersion = 1
    0x78, 0x56, 0x34, 0x12, // u32 evaluationSpecDigestState = 0x12345678
    0x02, 0x00, 0x00, 0x00, // u32 count = 2
    // --- member 0: id 7, valid, ok, fitness 1.5 (48 bytes) ---
    0x07, 0x00, 0x00, 0x00, // u32 individualId = 7
    0x01, // u8 valid = true
    0x00, // u8 integrityStatus = 0 ('ok')
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f, // f64 fitness = 1.5
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, // f64 peakBodySpeed = 2
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // f64 peakSpeedDelta = 0
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x3f, // f64 peakStepDisplacement = 0.5
    0x00, // u8 firstAlertStepPresent = 0
    0x00, 0x00, 0x00, 0x00, // u32 firstAlertStep — ABSENT, so canonically 0
    0x00, // u8 firstCatastrophicStepPresent = 0
    0x00, 0x00, 0x00, 0x00, // u32 firstCatastrophicStep — ABSENT, canonically 0
    // --- member 1: id 9, valid, numericalDivergence, fitness 0 (48 bytes) ---
    0x09, 0x00, 0x00, 0x00, // u32 individualId = 9
    0x01, // u8 valid = true (validity and selectability are distinct)
    0x02, // u8 integrityStatus = 2 ('numericalDivergence')
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // f64 fitness = 0 (gated)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x7f, // f64 peakBodySpeed = +Infinity
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x90, 0x40, // f64 peakSpeedDelta = 1024
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x30, 0x40, // f64 peakStepDisplacement = 16
    0x01, // u8 firstAlertStepPresent = 1
    0x00, 0x00, 0x00, 0x00, // u32 firstAlertStep = 0 — PRESENT at capture 0
    0x01, // u8 firstCatastrophicStepPresent = 1
    0x03, 0x00, 0x00, 0x00, // u32 firstCatastrophicStep = 3
  ]);

  const oracleEvaluation = () => ({
    populationSnapshotDigestState: 0xdeadbeef,
    evaluationSpecDigestState: 0x12345678,
    individuals: [
      {
        individualId: 7,
        valid: true,
        integrityStatus: 'ok',
        fitness: 1.5,
        integrityObservations: {
          peakBodySpeed: 2,
          peakSpeedDelta: 0,
          peakStepDisplacement: 0.5,
          firstAlertStep: null,
          firstCatastrophicStep: null,
        },
      },
      {
        individualId: 9,
        valid: true,
        integrityStatus: 'numericalDivergence',
        fitness: 0,
        integrityObservations: {
          peakBodySpeed: Infinity,
          peakSpeedDelta: 1024,
          peakStepDisplacement: 16,
          firstAlertStep: 0,
          firstCatastrophicStep: 3,
        },
      },
    ],
  });

  test('the encoder reproduces the hand-computed stream byte for byte', () => {
    const bytes = serializeFitnessVector(oracleEvaluation());
    expect(bytes.length).toBe(ORACLE_BYTES.length);
    expect([...bytes]).toEqual([...ORACLE_BYTES]);
  });

  test('the decoder inverts the hand-computed stream without seeing the encoder', () => {
    const decoded = deserializeFitnessVector(Uint8Array.from(ORACLE_BYTES));
    const [a, b] = decoded.individuals;
    expect(a.integrityObservations.peakBodySpeed).toBe(2);
    expect(a.integrityObservations.firstAlertStep).toBeNull();
    expect(a.integrityObservations.firstCatastrophicStep).toBeNull();
    expect(b.integrityObservations.peakBodySpeed).toBe(Infinity);
    // The discriminator: step 0 PRESENT is not null, and never becomes null.
    expect(b.integrityObservations.firstAlertStep).toBe(0);
    expect(b.integrityObservations.firstCatastrophicStep).toBe(3);
    expect(bytesEqual(serializeFitnessVector(decoded), Uint8Array.from(ORACLE_BYTES))).toBe(true);
  });

  test('null and step 0 are byte-distinct, and differ ONLY in the flag byte', () => {
    const withNull = serializeFitnessVector(synth([[1, 0, true, 'ok',
      { ...OBSERVATIONS.ok, firstAlertStep: null }]]));
    const withZero = serializeFitnessVector(synth([[1, 0, true, 'ok',
      { ...OBSERVATIONS.ok, firstAlertStep: 0 }]]));
    expect(bytesEqual(withNull, withZero)).toBe(false);
    const differing = [];
    for (let i = 0; i < withNull.length; i += 1) {
      if (withNull[i] !== withZero[i]) differing.push(i);
    }
    expect(differing).toEqual([MEMBER_AT(0) + AT.firstAlertStepPresent]);
    expect(deserializeFitnessVector(withNull).individuals[0].integrityObservations.firstAlertStep)
      .toBeNull();
    expect(deserializeFitnessVector(withZero).individuals[0].integrityObservations.firstAlertStep)
      .toBe(0);
  });

  test('+Infinity is ACCEPTED — the codec mirrors what the detector can produce', () => {
    // foldIntegrity computes speed = sqrt(vx^2+vy^2+vz^2) and takes it as the
    // peak whenever it is greater, so an infinite linear velocity yields
    // peakBodySpeed = Infinity. It then evaluates the catastrophic predicates
    // BEFORE the !finite branch, so on that same capture the status becomes
    // 'numericalDivergence' while the peak stays infinite. A "must be finite"
    // rule would make this public encoder throw on a legal policy-v1 result —
    // a codec stricter than its own producer, refusing the run's own
    // defensive-net output. (An earlier draft asserted
    // `Math.sqrt(Infinity * Infinity) === Infinity` and `Infinity > 1000` here.
    // Both are IEEE-754 facts about the language, not claims about this
    // codebase — they belong in the reasoning above, not in an expectation
    // that can never fail.)
    for (const key of ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement']) {
      const evaluation = synth([[1, 0, true, 'numericalDivergence',
        { ...OBSERVATIONS.numericalDivergence, [key]: Infinity }]]);
      const bytes = serializeFitnessVector(evaluation);
      const decoded = deserializeFitnessVector(bytes);
      expect(decoded.individuals[0].integrityObservations[key], key).toBe(Infinity);
      expect(bytesEqual(serializeFitnessVector(decoded), bytes), key).toBe(true);
    }
  });

  test('a nonFinite row whose peaks stayed FINITE is legal — NaN never takes a peak', () => {
    // `speed > peak` is false for NaN and the peaks start at 0, so a body that
    // went non-finite via NaN leaves every peak finite and fires no predicate.
    // That row is `nonFinite` with both onsets null, and it must encode.
    const evaluation = synth([[1, 0, true, 'nonFinite']]);
    expect(OBSERVATIONS.nonFinite.firstCatastrophicStep).toBeNull();
    const bytes = serializeFitnessVector(evaluation);
    const decoded = deserializeFitnessVector(bytes);
    expect(decoded.individuals[0].integrityStatus).toBe('nonFinite');
    expect(decoded.individuals[0].integrityObservations.firstCatastrophicStep).toBeNull();
    expect(Number.isFinite(decoded.individuals[0].integrityObservations.peakBodySpeed)).toBe(true);
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });

  test('NaN and -Infinity peaks are REFUSED at the encoder', () => {
    for (const key of ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement']) {
      for (const bad of [NaN, -Infinity, -1, -0.5, '3', null, undefined]) {
        const evaluation = synth([[1, 0, true, 'ok', { ...OBSERVATIONS.ok, [key]: bad }]]);
        expect(() => serializeFitnessVector(evaluation), `${key}=${String(bad)}`)
          .toThrow(new RegExp(`population-evaluation: invalid .*${key}`));
      }
    }
  });

  test('a non-canonical or non-integer step is REFUSED at the encoder', () => {
    for (const bad of [-1, 1.5, 0x100000000, NaN, Infinity, '4', -0, true]) {
      expect(() => serializeFitnessVector(synth([[1, 0, true, 'ok',
        { ...OBSERVATIONS.ok, firstAlertStep: bad }]])), String(bad))
        .toThrow(/population-evaluation: invalid .*firstAlertStep/);
    }
  });

  test('the policy-v1 coherence rules the encoder AND decoder both enforce', () => {
    // Each rule is derivable from integrity.js at policy v1 — see the drift
    // tooth below, which pins the threshold ordering rule 1 rests on.
    const cases = [
      ['catastrophic without alert', [[1, 0, true, 'numericalDivergence',
        { ...OBSERVATIONS.numericalDivergence, firstAlertStep: null }]], /firstAlertStep/],
      ['alert AFTER catastrophic', [[1, 0, true, 'numericalDivergence',
        { ...OBSERVATIONS.numericalDivergence, firstAlertStep: 12, firstCatastrophicStep: 11 }]],
      /firstAlertStep/],
      ["'ok' carrying a catastrophic step", [[1, 0, true, 'ok',
        { ...OBSERVATIONS.ok, firstAlertStep: 4, firstCatastrophicStep: 4 }]],
      /firstCatastrophicStep/],
      ["'numericalDivergence' with NO catastrophic step", [[1, 0, true, 'numericalDivergence',
        { ...OBSERVATIONS.numericalDivergence, firstCatastrophicStep: null }]],
      /firstCatastrophicStep/],
    ];
    for (const [label, entries, pattern] of cases) {
      expect(() => serializeFitnessVector(synth(entries)), label).toThrow(pattern);
    }
    // An 'ok' row MAY carry an alert step: that is the whole contamination
    // class this PR exists to persist, and refusing it would defeat the change.
    const alertOk = synth([[1, 7.5, true, 'ok', { ...OBSERVATIONS.ok, firstAlertStep: 16 }]]);
    const decoded = deserializeFitnessVector(serializeFitnessVector(alertOk));
    expect(decoded.individuals[0].integrityObservations.firstAlertStep).toBe(16);
    expect(decoded.individuals[0].fitness).toBe(7.5);
  });

  test('the DECODER refuses the same out-of-domain and incoherent observations', () => {
    // WHY THIS EXISTS SEPARATELY. The test above is titled "the encoder AND
    // decoder both enforce" and every one of its cases calls the ENCODER, so
    // deleting `validatedObservations(...)` from `deserializeFitnessVector`
    // left the entire suite green. The decoder's half of the mirror contract
    // had no tooth at all — and it is the half that faces bytes nobody in this
    // process wrote: a persisted artifact, a foreign encoder, a forged file.
    //
    // These cases therefore poke a VALID stream and assert the decoder refuses
    // it, which the encoder cannot do for them.
    const dv = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const poke = (mutate, entries = [[1, 0, true, 'ok']]) => {
      const bytes = serializeFitnessVector(synth(entries));
      mutate(dv(bytes), bytes);
      return bytes;
    };

    // Domain: a peak that is NaN or negative. Both are unreachable from
    // foldIntegrity and both are refused, and the asymmetry with +Infinity
    // (accepted, above) is the point of the rule.
    for (const key of ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement']) {
      for (const bad of [NaN, -Infinity, -1]) {
        const bytes = poke((v) => v.setFloat64(MEMBER_AT(0) + AT[key], bad, true));
        expect(() => deserializeFitnessVector(bytes), `${key}=${String(bad)}`)
          .toThrow(new RegExp(`population-evaluation: invalid encoded fitness vector at .*${key}`));
      }
    }

    // Coherence, policy v1. Each case starts from a stream the encoder was
    // willing to write and breaks exactly one rule.
    const catastrophic = [[1, 0, false, 'numericalDivergence',
      { ...OBSERVATIONS.numericalDivergence, firstAlertStep: 11, firstCatastrophicStep: 12 }]];

    // catastrophic present, alert cleared to absent.
    const noAlert = poke((v) => {
      v.setUint8(MEMBER_AT(0) + AT.firstAlertStepPresent, 0);
      v.setUint32(MEMBER_AT(0) + AT.firstAlertStep, 0, true);
    }, catastrophic);
    expect(() => deserializeFitnessVector(noAlert), 'catastrophic without alert')
      .toThrow(/firstAlertStep/);

    // alert moved AFTER the catastrophic step.
    const late = poke((v) => v.setUint32(MEMBER_AT(0) + AT.firstAlertStep, 13, true), catastrophic);
    expect(() => deserializeFitnessVector(late), 'alert after catastrophic')
      .toThrow(/firstAlertStep/);

    // status flipped to 'ok' while a catastrophic step remains.
    const okStatus = poke((v) => {
      v.setUint8(MEMBER_AT(0) + AT.integrityStatus, INTEGRITY_STATUS.indexOf('ok'));
      v.setUint8(MEMBER_AT(0) + AT.valid, 1);
    }, catastrophic);
    expect(() => deserializeFitnessVector(okStatus), "'ok' carrying a catastrophic step")
      .toThrow(/firstCatastrophicStep/);

    // 'numericalDivergence' with the catastrophic step cleared.
    const divergentNoStep = poke((v) => {
      v.setUint8(MEMBER_AT(0) + AT.firstCatastrophicStepPresent, 0);
      v.setUint32(MEMBER_AT(0) + AT.firstCatastrophicStep, 0, true);
    }, catastrophic);
    expect(() => deserializeFitnessVector(divergentNoStep), 'divergence with no catastrophic step')
      .toThrow(/firstCatastrophicStep/);

    // The positive control: an untouched stream of the same shape decodes.
    // Without it every case above would pass on a decoder that refused
    // everything.
    const clean = serializeFitnessVector(synth(catastrophic));
    expect(deserializeFitnessVector(clean).individuals[0].integrityObservations)
      .toMatchObject({ firstAlertStep: 11, firstCatastrophicStep: 12 });
  });

  describe('peekFitnessVectorVersions — the layered compatibility parser', () => {
    // WHY DIRECTLY. The only behavioural exercise of this function anywhere was
    // the stale v2 artifact, which hits the early `fitnessVectorVersion !== 3`
    // return — so FOUR of its five comparisons were unenforced, and neutering
    // the whole mismatch loop left 252 tests green. It is the parser two
    // production gates read their verdict from, and it faces foreign bytes.
    const HEADER_AT = Object.freeze({
      fitnessVectorVersion: 0,
      fitnessPolicyVersion: 2,
      integrityPolicyVersion: 4,
      snapshotVersion: 6,
      // bytes 8..11 are populationSnapshotDigestState (positional, not a version)
      evaluationSpecVersion: 12,
    });
    const CURRENT = Object.freeze({
      fitnessVectorVersion: FITNESS_VECTOR_VERSION,
      fitnessPolicyVersion: FITNESS_POLICY_VERSION,
      integrityPolicyVersion: INTEGRITY_POLICY_VERSION,
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      evaluationSpecVersion: EVALUATION_SPEC_VERSION,
    });
    const withVersion = (field, value) => {
      const bytes = serializeFitnessVector(synth([[1, 0, true, 'ok']]));
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .setUint16(HEADER_AT[field], value, true);
      return bytes;
    };

    test('a current stream is supported and declares every version it carries', () => {
      const peeked = peekFitnessVectorVersions(serializeFitnessVector(synth([[1, 0, true, 'ok']])));
      expect(peeked.supported).toBe(true);
      expect(peeked.mismatches).toEqual([]);
      expect(peeked.declared).toEqual(CURRENT);
    });

    test.each(['fitnessPolicyVersion', 'integrityPolicyVersion', 'snapshotVersion', 'evaluationSpecVersion'])(
      'a non-current %s is reported BY NAME, with stored and current values',
      (field) => {
        const stored = CURRENT[field] + 7;
        const peeked = peekFitnessVectorVersions(withVersion(field, stored));
        expect(peeked.supported).toBe(false);
        expect(peeked.mismatches.length).toBe(1);
        expect(peeked.mismatches[0]).toEqual({ field, stored, current: CURRENT[field] });
        // The other four are still read and still reported as declared: the
        // layering stops at an unknown VECTOR version, not at any mismatch.
        expect(peeked.declared).toEqual({ ...CURRENT, [field]: stored });
      },
    );

    test('an unknown fitnessVectorVersion stops the parse — nothing further is claimed', () => {
      // THE LAYERING RULE. Under an unrecognized layout every later offset is
      // guesswork, so the parser must not report versions it cannot honestly
      // have read. `declared` carries exactly the one field it did read.
      const peeked = peekFitnessVectorVersions(withVersion('fitnessVectorVersion', 2));
      expect(peeked.supported).toBe(false);
      expect(Object.keys(peeked.declared)).toEqual(['fitnessVectorVersion']);
      expect(peeked.declared.fitnessVectorVersion).toBe(2);
      expect(peeked.mismatches).toEqual([
        { field: 'fitnessVectorVersion', stored: 2, current: FITNESS_VECTOR_VERSION },
      ]);
    });

    test('several non-current versions all report, vector version first', () => {
      const bytes = serializeFitnessVector(synth([[1, 0, true, 'ok']]));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setUint16(HEADER_AT.integrityPolicyVersion, 9, true);
      view.setUint16(HEADER_AT.evaluationSpecVersion, 9, true);
      const peeked = peekFitnessVectorVersions(bytes);
      expect(peeked.mismatches.map((m) => m.field))
        .toEqual(['integrityPolicyVersion', 'evaluationSpecVersion']);
    });

    test('a stream truncated inside the version prefix FAILS — it is not "supported"', () => {
      const bytes = serializeFitnessVector(synth([[1, 0, true, 'ok']]));
      for (const length of [0, 1, 3, 5, 7, 13]) {
        expect(() => peekFitnessVectorVersions(bytes.slice(0, length)), `length ${length}`)
          .toThrow(/population-evaluation/);
      }
    });
  });

  test('the threshold ordering the catastrophic-implies-alert rule rests on', () => {
    // Rule 1 is DERIVED, not decreed: within one capture the same body is
    // tested against both bands, so a catastrophic crossing is necessarily an
    // alert crossing only while the alert thresholds sit below the
    // catastrophic ones. If a policy bump ever inverts that, this reddens
    // before the coherence rule silently becomes false.
    expect(INTEGRITY_THRESHOLDS.alertSpeed)
      .toBeLessThanOrEqual(INTEGRITY_THRESHOLDS.catastrophicSpeed);
    expect(INTEGRITY_THRESHOLDS.alertStepDisplacement)
      .toBeLessThanOrEqual(INTEGRITY_THRESHOLDS.catastrophicStepDisplacement);
  });

  test('fitnessVectorByteLength IS the encoder geometry, at every member count', () => {
    // This identity is load-bearing OUTSIDE the codec: evolution-run's
    // assertHistoryCapacity projects a run's worst-case artifact size from
    // fitnessVectorByteLength(populationSize) and REFUSES a configuration whose
    // history could not fit under the 64 MiB ceiling. If the declared geometry
    // ever drifted from what the encoder actually emits, that gate would be
    // computing a fiction — and it is a production refusal, not a test helper.
    // v3 widened a member 14 -> 48 bytes, so this is exactly the change that
    // could have desynchronized them.
    for (const count of [1, 2, 3, 20, 256]) {
      const entries = [];
      for (let i = 0; i < count; i += 1) entries.push([i, 0, true]);
      expect(serializeFitnessVector(synth(entries)).length, `count ${count}`)
        .toBe(fitnessVectorByteLength(count));
    }
    expect(fitnessVectorByteLength(20)).toBe(22 + 20 * 48);
  });

  test('the decoded observation block EXISTS and is frozen', () => {
    // `Object.isFrozen(undefined)` is TRUE — non-objects are frozen by
    // definition — so asserting frozenness alone passed vacuously against a
    // decoder that emitted no block at all. Establish presence and shape first.
    const decoded = deserializeFitnessVector(serializeFitnessVector(synth([[0, 1, true]])));
    const o = decoded.individuals[0].integrityObservations;
    expect(typeof o).toBe('object');
    expect(o).not.toBeNull();
    expect(Object.keys(o).slice().sort()).toEqual([...OBSERVATION_KEYS].sort());
    expect(Object.isFrozen(o)).toBe(true);
  });
});

describe('fitness vector v3 — absent optional steps have exactly ONE encoding', () => {
  // Without this rule `00 00000000`, `00 01000000` and `00 ffffffff` would all
  // decode to the same `null`, so decode->encode would not reproduce its input
  // and one semantic value would have 2^32 byte identities.
  const ABSENT_CASES = Object.freeze([
    ['firstAlertStep', AT.firstAlertStep],
    ['firstCatastrophicStep', AT.firstCatastrophicStep],
  ]);

  test('the encoder always writes zero into an absent step payload', () => {
    const bytes = serializeFitnessVector(synth([[1, 0, true, 'ok']]));
    for (const [label, payloadOffset] of ABSENT_CASES) {
      const at = MEMBER_AT(0) + payloadOffset;
      expect([...bytes.slice(at, at + 4)], label).toEqual([0, 0, 0, 0]);
    }
  });

  test('a nonzero payload behind an absent flag is REJECTED, never ignored', () => {
    for (const [label, payloadOffset] of ABSENT_CASES) {
      for (const junk of [1, 0xffffffff]) {
        const bytes = serializeFitnessVector(synth([[1, 0, true, 'ok']]));
        new DataView(bytes.buffer).setUint32(MEMBER_AT(0) + payloadOffset, junk, true);
        expect(() => deserializeFitnessVector(bytes), `${label}=${junk}`)
          .toThrow(new RegExp(`population-evaluation: invalid encoded fitness vector at .*${label}`));
      }
    }
  });

  test('a malformed presence flag is REJECTED', () => {
    for (const [label, payloadOffset] of ABSENT_CASES) {
      const bytes = serializeFitnessVector(synth([[1, 0, true, 'ok']]));
      new DataView(bytes.buffer).setUint8(MEMBER_AT(0) + payloadOffset - 1, 2);
      expect(() => deserializeFitnessVector(bytes), label)
        .toThrow(new RegExp(`population-evaluation: invalid encoded fitness vector at .*${label}`));
    }
  });
});

describe('fitness vector — malformed streams fail loud', () => {
  const base = () => serializeFitnessVector(synth([[3, 2.5, true], [9, 0, false]]));
  const MEMBER = MEMBER_AT;

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
    // Cuts land in every region: header, member 0's fixed fields, each of its
    // three peaks, both optional-step flags and payloads, and member 1.
    for (const cut of [0, 1, 12, 18, 21, 22, 30, 35, 40, 52, 59, 60, 62, 65, 66, 69, 70, full.length - 1]) {
      expect(() => deserializeFitnessVector(full.slice(0, cut)), `cut ${cut}`)
        .toThrow(/population-evaluation: invalid encoded fitness vector/);
    }
    const extended = new Uint8Array(full.length + 1);
    extended.set(full);
    expect(() => deserializeFitnessVector(extended)).toThrow(/at byteLength \(119 \(expected 118/);
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

describe('fitness vector — the population/spec binding is UNVERIFIED (the deliberate boundary)', () => {
  // The same gap as the initialization manifest's, one module over, and until
  // now nobody had stated it: a fitness vector binds a population SNAPSHOT
  // digest state and an evaluation SPEC digest state alongside a list of
  // fitness numbers, and NOTHING in the encoding proves those numbers came
  // from running that spec on that population. The digests attest WHICH
  // population and WHICH spec existed; the rows beside them are an
  // unverified claim about what happened when they met.
  //
  // MEASURED ON HEAD: rows whose ids exist in NO member of the attested
  // population encode, decode, and re-encode byte-identically, at a member
  // count unrelated to the population's. Pinned deliberately as the boundary,
  // not as a defect — evaluatePopulation is what actually produces coherent
  // vectors, and the codec is its inverse, not its auditor. If a later PR adds
  // an encoder-side membership cross-check, THIS TEST FAILS and tells you to
  // move the assertion rather than going quietly green for a different reason.
  //
  // The contrast tooth below pins the one coherence check these records DO
  // make, so the asymmetry reads as a decision rather than an oversight.

  test('a vector whose member ids are DISJOINT from the attested population still round-trips', () => {
    const { population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const snapshotState = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population));
    const populationIds = population.individuals.map((i) => i.individualId);
    // The premise: these ids belong to no member of the population the
    // snapshot state attests to, so acceptance below is a real gap and not a
    // coincidental overlap.
    const alienIds = [1000, 1001, 1002];
    for (const id of alienIds) expect(populationIds, `id ${id}`).not.toContain(id);
    expect(populationIds).toHaveLength(20);

    const evaluation = {
      spec: resolvedFixtureA(),
      populationSnapshotDigestState: snapshotState,
      individuals: alienIds.map((individualId, i) => ({
        individualId,
        valid: true,
        integrityStatus: 'ok',
        fitness: i + 0.5,
        integrityObservations: OBSERVATIONS.ok,
      })),
    };
    const bytes = serializeFitnessVector(evaluation); // no complaint
    const decoded = deserializeFitnessVector(bytes);
    // Even the COUNT is free: 3 rows attesting a 20-member population.
    expect(decoded.individuals).toHaveLength(3);
    expect(decoded.populationSnapshotDigestState).toBe(snapshotState);
    expect(decoded.individuals.map((m) => m.individualId)).toEqual(alienIds);
    expect(Object.is(decoded.individuals[1].fitness, 1.5)).toBe(true);
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });

  test('the ONE coherence check these records DO make: a declared digest state that disagrees is refused', () => {
    // resolveSpecDigestState (population-evaluation.js) and the manifest's
    // resolvePopulationDigestState (population-initializer.js) are the same
    // additive path in the same shape — take the object OR a pre-computed
    // canonical uint32, and when BOTH are present they must AGREE. Asserted
    // together, next to the check neither of them makes: a record can never
    // attest to a spec or a population it CONTRADICTS, but nothing proves the
    // numbers beside the digests were produced by running one on the other.
    const evaluation = { ...synth([[0, 1, true]]), spec: resolvedFixtureA() };
    const specState = fnv1aFold(FNV_OFFSET_BASIS, serializeEvaluationSpec(resolvedFixtureA()));
    expect(bytesEqual(
      serializeFitnessVector({ ...evaluation, evaluationSpecDigestState: specState }),
      serializeFitnessVector(evaluation),
    )).toBe(true);
    expect(() => serializeFitnessVector({ ...evaluation, evaluationSpecDigestState: (specState ^ 1) >>> 0 }))
      .toThrow(/evaluationSpecDigestState.*disagrees with the spec's computed state/);

    // The manifest's twin, asserted here so the two paths sit side by side.
    const init = createInitialPopulation({ seed: 123456, populationSize: 2 });
    const popState = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(init.population));
    expect(bytesEqual(
      serializePopulationInitialization({ ...init, populationSnapshotDigestState: popState }),
      serializePopulationInitialization(init),
    )).toBe(true);
    expect(() => serializePopulationInitialization({ ...init, populationSnapshotDigestState: (popState ^ 1) >>> 0 }))
      .toThrow(/populationSnapshotDigestState.*disagrees with the population's computed state/);
  });
});
