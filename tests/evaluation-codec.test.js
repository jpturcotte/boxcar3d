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
// The committed fitness vector (the v3 lock digest, read through the imported
// lock — never duplicated here) is reconstructed WITHOUT re-running
// evaluatePopulation (which tests/population-determinism.test.js already runs
// in the same suite): the snapshot state comes from the physics-free fixture
// builder and the per-member rows — fitness, validity, and the five v3
// observation literals — come from the imported lock, so this file duplicates
// no digest literal.
//
// Seeds: 20260722 (fixture-A terrain), 20260723 (the declared flat terrain,
// copy-declared from tests/population-evaluation.test.js), 123456 (the small
// declared manifest seed, copy-declared from tests/population-codec.test.js,
// used only by the digest-state cross-check tooth at the end).

import { describe, test, expect } from 'vitest';
import {
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION, FITNESS_VECTOR_VERSION,
  SPAWN_CLEARANCE, deserializeEvaluationSpec, deserializeFitnessVector,
  serializeEvaluationSpec, serializeFitnessVector,
} from '../src/sim/population-evaluation.js';
import { POPULATION_SNAPSHOT_VERSION, bytesEqual, serializePopulationSnapshot } from '../src/sim/population.js';
import {
  createInitialPopulation, serializePopulationInitialization,
} from '../src/sim/population-initializer.js';
import { INTEGRITY_POLICY_VERSION, INTEGRITY_STATUS, INTEGRITY_THRESHOLDS } from '../src/sim/integrity.js';
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

// Status-coherent observation defaults for synthetic rows (policy v1): an 'ok'
// or 'nonFinite' row may carry no onset steps (nonFinite CAN, but the simple
// case keeps them null); a 'numericalDivergence' row MUST carry a catastrophic
// step, and the catastrophic step implies an alert step at or before it (the
// catastrophic thresholds exceed the alert ones arm-for-arm under one dtScale).
// Individual tests override the fields they exercise.
const observationsFor = (integrityStatus, overrides = {}) => ({
  peakBodySpeed: 0,
  peakSpeedDelta: 0,
  peakStepDisplacement: 0,
  firstAlertStep: null,
  firstCatastrophicStep: null,
  ...(integrityStatus === 'numericalDivergence'
    ? { peakBodySpeed: 1500, firstAlertStep: 12, firstCatastrophicStep: 12 }
    : {}),
  ...overrides,
});

// Entry tuple: [individualId, fitness, valid, integrityStatus='ok', observationOverrides].
const synth = (entries, spec = resolvedFlat()) => ({
  spec,
  populationSnapshotDigestState: 0xdeadbeef,
  individuals: entries.map(([individualId, fitness, valid, integrityStatus = 'ok', observations]) => (
    {
      individualId,
      fitness,
      valid,
      integrityStatus,
      integrityObservations: observationsFor(integrityStatus, observations),
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
    const expected = ind.integrityObservations;
    const actual = decoded.individuals[i].integrityObservations;
    for (const key of ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement']) {
      expect(Object.is(actual[key], expected[key]), `observations[${i}].${key}`).toBe(true);
    }
    expect(actual.firstAlertStep, `observations[${i}].firstAlertStep`).toBe(expected.firstAlertStep);
    expect(actual.firstCatastrophicStep, `observations[${i}].firstCatastrophicStep`)
      .toBe(expected.firstCatastrophicStep);
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
      // in population-locks.js), so the lock's rows fully determine the vector —
      // including the five persisted integrity observations v3 appends.
      individuals: LOCK.individuals.map((m) => ({
        individualId: m.individualId,
        valid: m.valid,
        integrityStatus: 'ok',
        fitness: m.fitness,
        integrityObservations: {
          peakBodySpeed: m.peakBodySpeed,
          peakSpeedDelta: m.peakSpeedDelta,
          peakStepDisplacement: m.peakStepDisplacement,
          firstAlertStep: m.firstAlertStep,
          firstCatastrophicStep: m.firstCatastrophicStep,
        },
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
    const good = { individualId: 0, valid: true, integrityStatus: 'ok', fitness: 0 };
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
    expect(serializeFitnessVector(evaluation).length).toBe(22 + 48);
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
    expect(Object.isFrozen(decoded.individuals[0].integrityObservations)).toBe(true);
  });
});

describe('fitness vector v3 — the persisted integrity observations', () => {
  // The v3 member walk (48 B, copy-declared): individualId u32 @0, valid u8 @4,
  // integrityStatus u8 @5, fitness f64 @6, peakBodySpeed f64 @14,
  // peakSpeedDelta f64 @22, peakStepDisplacement f64 @30,
  // firstAlertStepPresent u8 @38, firstAlertStep u32 @39,
  // firstCatastrophicStepPresent u8 @43, firstCatastrophicStep u32 @44.
  const PEAK_OFFSETS = Object.freeze({ peakBodySpeed: 14, peakSpeedDelta: 22, peakStepDisplacement: 30 });
  const ALERT_FLAG = 38;
  const ALERT_STEP = 39;
  const CAT_FLAG = 43;
  const CAT_STEP = 44;

  test('the hand-computed expected-bytes literal — the narrow oracle for the v3 walk', () => {
    const literal = new Uint8Array(22 + 2 * 48);
    const view = new DataView(literal.buffer);
    let o = 0;
    view.setUint16(o, 3, true); o += 2; // fitnessVectorVersion
    view.setUint16(o, 2, true); o += 2; // fitnessPolicyVersion
    view.setUint16(o, 1, true); o += 2; // integrityPolicyVersion
    view.setUint16(o, 1, true); o += 2; // snapshotVersion
    view.setUint32(o, 0xdeadbeef, true); o += 4; // populationSnapshotDigestState
    view.setUint16(o, 1, true); o += 2; // evaluationSpecVersion
    view.setUint32(o, 0x01020304, true); o += 4; // evaluationSpecDigestState
    view.setUint32(o, 2, true); o += 4; // count
    // Member 0: id 7, valid, 'ok', fitness 12.5; peaks (1.5, 2.5, 3.5);
    // alert at step 9, NO catastrophic step (absent => payload exactly 0).
    view.setUint32(o, 7, true); o += 4;
    view.setUint8(o, 1); o += 1;
    view.setUint8(o, 0); o += 1;
    view.setFloat64(o, 12.5, true); o += 8;
    view.setFloat64(o, 1.5, true); o += 8;
    view.setFloat64(o, 2.5, true); o += 8;
    view.setFloat64(o, 3.5, true); o += 8;
    view.setUint8(o, 1); o += 1;
    view.setUint32(o, 9, true); o += 4;
    view.setUint8(o, 0); o += 1;
    view.setUint32(o, 0, true); o += 4;
    // Member 1: id 9, valid, 'numericalDivergence', fitness 0;
    // peaks (+Infinity, 0, 1000.5); alert step 4, catastrophic step 4.
    view.setUint32(o, 9, true); o += 4;
    view.setUint8(o, 1); o += 1;
    view.setUint8(o, 2); o += 1;
    view.setFloat64(o, 0, true); o += 8;
    view.setFloat64(o, Infinity, true); o += 8;
    view.setFloat64(o, 0, true); o += 8;
    view.setFloat64(o, 1000.5, true); o += 8;
    view.setUint8(o, 1); o += 1;
    view.setUint32(o, 4, true); o += 4;
    view.setUint8(o, 1); o += 1;
    view.setUint32(o, 4, true); o += 4;
    expect(o).toBe(literal.length);
    // +Infinity has exactly one f64 representation (00 00 00 00 00 00 f0 7f) —
    // the cross-engine NaN-payload hazard can never occur here, because NaN is
    // outside the >= 0 peak domain.
    expect([...literal.slice(22 + 48 + 14, 22 + 48 + 22)]).toEqual([0, 0, 0, 0, 0, 0, 0xf0, 0x7f]);

    const evaluation = {
      populationSnapshotDigestState: 0xdeadbeef,
      evaluationSpecDigestState: 0x01020304,
      individuals: synth([
        [7, 12.5, true, 'ok', {
          peakBodySpeed: 1.5, peakSpeedDelta: 2.5, peakStepDisplacement: 3.5, firstAlertStep: 9,
        }],
        [9, 0, true, 'numericalDivergence', {
          peakBodySpeed: Infinity, peakSpeedDelta: 0, peakStepDisplacement: 1000.5,
          firstAlertStep: 4, firstCatastrophicStep: 4,
        }],
      ]).individuals,
    };
    const bytes = serializeFitnessVector(evaluation);
    expect(bytesEqual(bytes, literal)).toBe(true);
    const decoded = deserializeFitnessVector(literal);
    assertVectorLeafEqual(decoded, evaluation, 0x01020304);
    expect(Object.is(decoded.individuals[1].integrityObservations.peakBodySpeed, Infinity)).toBe(true);
    expect(bytesEqual(serializeFitnessVector(decoded), literal)).toBe(true);
  });

  test('null and step 0 are byte-distinct — the flag+u32 pair consumes no legal step value', () => {
    const asNull = serializeFitnessVector(synth([[3, 0, false, 'ok', { firstAlertStep: null }]]));
    const asZero = serializeFitnessVector(synth([[3, 0, false, 'ok', { firstAlertStep: 0 }]]));
    expect(bytesEqual(asNull, asZero)).toBe(false);
    // null: flag 0, payload 0. step 0: flag 1, payload 0 — the flag alone differs.
    expect(asNull[22 + ALERT_FLAG]).toBe(0);
    expect(asZero[22 + ALERT_FLAG]).toBe(1);
    expect(new DataView(asZero.buffer).getUint32(22 + ALERT_STEP, true)).toBe(0);
    expect(deserializeFitnessVector(asNull).individuals[0].integrityObservations.firstAlertStep).toBeNull();
    expect(deserializeFitnessVector(asZero).individuals[0].integrityObservations.firstAlertStep).toBe(0);
  });

  test('an absent step with a NONZERO payload is rejected, both optional fields independently', () => {
    // Canonical presence: the encoder writes the payload as exactly 0 when the
    // flag is absent, and the decoder rejects a nonzero payload under an absent
    // flag — one semantic value has exactly one byte string, so decode -> encode
    // is a true inverse (the standing f64-leaf / canonical-flag discipline).
    for (const [flagOffset, stepOffset, name] of [[ALERT_FLAG, ALERT_STEP, 'firstAlertStep'], [CAT_FLAG, CAT_STEP, 'firstCatastrophicStep']]) {
      const bytes = serializeFitnessVector(synth([[3, 0, false]]));
      const view = new DataView(bytes.buffer);
      expect(view.getUint8(22 + flagOffset), `${name} flag`).toBe(0); // absent
      expect(view.getUint32(22 + stepOffset, true), `${name} payload`).toBe(0); // always zero
      view.setUint32(22 + stepOffset, 1, true); // a payload under an absent flag
      expect(() => deserializeFitnessVector(bytes), name)
        .toThrow(new RegExp(`individuals\\[0\\]\\.integrityObservations\\.${name}`));
    }
  });

  test('a non-canonical presence flag is rejected, both optional fields independently', () => {
    for (const [flagOffset, name] of [[ALERT_FLAG, 'firstAlertStepPresent'], [CAT_FLAG, 'firstCatastrophicStepPresent']]) {
      const bytes = serializeFitnessVector(synth([[3, 0, false]]));
      new DataView(bytes.buffer).setUint8(22 + flagOffset, 2);
      expect(() => deserializeFitnessVector(bytes), name)
        .toThrow(new RegExp(`individuals\\[0\\]\\.integrityObservations\\.${name}`));
    }
  });

  test('each peak admits +Infinity and rejects NaN, -Infinity, negatives and non-numbers', () => {
    // THE DOMAIN, mirrored from the producer exactly: typeof number AND >= 0.
    // A "must be finite" rule would make the encoder throw on a legal policy-v1
    // result ({status:'numericalDivergence', peakBodySpeed: Infinity} is
    // producible: Infinity takes the peak and sets the catastrophic crossing
    // BEFORE the !finite branch can claim the status), killing the run on its
    // own defensive path. NaN is unreachable from the producer and unwritable
    // deterministically, so it is outside the domain; -0 is inside it (the
    // standing setFloat64-preserves-the-sign ruling) and unreachable too.
    for (const key of ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement']) {
      const inf = synth([[3, 0, true, 'numericalDivergence', { [key]: Infinity }]]);
      const decoded = deserializeFitnessVector(serializeFitnessVector(inf));
      expect(Object.is(decoded.individuals[0].integrityObservations[key], Infinity), `${key} Infinity`).toBe(true);
      for (const bad of [NaN, -Infinity, -1, '5']) {
        expect(() => serializeFitnessVector(synth([[3, 0, true, 'numericalDivergence', { [key]: bad }]])),
          `encode ${key} ${String(bad)}`)
          .toThrow(new RegExp(`individual 3 integrityObservations\\.${key}`));
      }
      for (const bad of [NaN, -Infinity, -1]) {
        const bytes = serializeFitnessVector(synth([[3, 0, true, 'numericalDivergence']]));
        new DataView(bytes.buffer).setFloat64(22 + PEAK_OFFSETS[key], bad, true);
        expect(() => deserializeFitnessVector(bytes), `decode ${key} ${String(bad)}`)
          .toThrow(new RegExp(`individuals\\[0\\]\\.integrityObservations\\.${key}`));
      }
    }
  });

  test('finite boundary peaks and extreme u32 steps round-trip bit-exactly; a -0 peak keeps its sign', () => {
    const evaluation = synth([
      [3, 0, false, 'ok', {
        peakBodySpeed: -0,
        peakSpeedDelta: Number.MIN_VALUE,
        peakStepDisplacement: Number.MAX_VALUE,
        firstAlertStep: 0xffffffff,
      }],
      // 'nonFinite' carries no onset-step constraint: this row's peaks stayed
      // finite because the invalid samples were NaN (arithmetic-inert — they
      // take no peak and fire no predicate), so both steps may be null; and a
      // LATER catastrophic crossing after an earlier nonFinite latch is legal
      // too, so it may carry them.
      [4, 0, true, 'nonFinite', {
        peakBodySpeed: 2 ** -1022,
        peakSpeedDelta: 1 - Number.EPSILON / 2,
        peakStepDisplacement: 0,
        firstAlertStep: 0xfffffffe,
        firstCatastrophicStep: 0xffffffff,
      }],
    ]);
    const bytes = serializeFitnessVector(evaluation);
    // The -0 peak's sign byte (member 0, peakBodySpeed @14, little-endian sign last).
    expect(bytes[22 + 14 + 7]).toBe(0x80);
    const decoded = deserializeFitnessVector(bytes);
    assertVectorLeafEqual(decoded, evaluation);
    expect(Object.is(decoded.individuals[0].integrityObservations.peakBodySpeed, -0)).toBe(true);
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });

  test('a stale v2 vector is refused at the version field, never parsed under the v3 layout', () => {
    // The v2 walk, hand-built: 22 B header with fitnessVectorVersion 2, then
    // 14 B per member (id u32, valid u8, status u8, fitness f64).
    const v2 = new Uint8Array(22 + 14);
    const view = new DataView(v2.buffer);
    let o = 0;
    view.setUint16(o, 2, true); o += 2; // fitnessVectorVersion 2 — the stale one
    view.setUint16(o, 2, true); o += 2;
    view.setUint16(o, 1, true); o += 2;
    view.setUint16(o, 1, true); o += 2;
    view.setUint32(o, 0xdeadbeef, true); o += 4;
    view.setUint16(o, 1, true); o += 2;
    view.setUint32(o, 0x01020304, true); o += 4;
    view.setUint32(o, 1, true); o += 4;
    view.setUint32(o, 3, true); o += 4;
    view.setUint8(o, 1); o += 1;
    view.setUint8(o, 0); o += 1;
    view.setFloat64(o, 2.5, true); o += 8;
    expect(o).toBe(v2.length);
    expect(() => deserializeFitnessVector(v2)).toThrow(/at fitnessVectorVersion \(2\)/);
  });

  test('the alert thresholds sit at or below their catastrophic counterparts, arm for arm', () => {
    // The codec's catastrophic-implies-alert coherence rule (policy v1) rests
    // on this premise: a catastrophic speed crossing (1000 > 25) or step-
    // displacement crossing ((1000/60)·dtScale > (25/60)·dtScale under one
    // shared dtScale) always fires the matching alert arm on the SAME sample.
    // If a threshold edit ever inverted an arm, the codec rule would become
    // unmeetable — fail HERE, next to the rule, not inside a physics run.
    expect(INTEGRITY_THRESHOLDS.alertSpeed).toBeLessThanOrEqual(INTEGRITY_THRESHOLDS.catastrophicSpeed);
    expect(INTEGRITY_THRESHOLDS.alertStepDisplacement)
      .toBeLessThanOrEqual(INTEGRITY_THRESHOLDS.catastrophicStepDisplacement);
  });
});

describe('fitness vector v3 — the policy-v1 coherence rules (conditioned, deliberately)', () => {
  // These three rules are POLICY-v1 invariants, not eternal vector-v3 ones:
  // they are checked conditioned on the vector's declared integrityPolicyVersion
  // being 1, because a later policy is expected to classify alert-only crossings
  // as divergence with NO catastrophic step. Encoding them as eternal invariants
  // would force an unnecessary v4 bump or an undo.
  const MEMBER = (i) => 22 + 48 * i;

  test('a catastrophic step REQUIRES an alert step at or before it', () => {
    expect(() => serializeFitnessVector(synth([[3, 0, true, 'nonFinite', { firstAlertStep: null, firstCatastrophicStep: 12 }]])))
      .toThrow(/individual 3 integrityObservations\.firstCatastrophicStep/);
    expect(() => serializeFitnessVector(synth([[3, 0, true, 'nonFinite', { firstAlertStep: 13, firstCatastrophicStep: 12 }]])))
      .toThrow(/individual 3 integrityObservations\.firstAlertStep/);
    // The decoder mirrors both on hand-mutated wire bytes.
    const withoutAlert = serializeFitnessVector(synth([[3, 0, true, 'nonFinite', { firstAlertStep: 12, firstCatastrophicStep: 12 }]]));
    const v1 = new DataView(withoutAlert.buffer);
    v1.setUint8(MEMBER(0) + 38, 0); // alert flag absent...
    v1.setUint32(MEMBER(0) + 39, 0, true); // ...payload canonical zero...
    expect(() => deserializeFitnessVector(withoutAlert)).toThrow(/individuals\[0\]\.integrityObservations\.firstCatastrophicStep/);
    const alertAfter = serializeFitnessVector(synth([[3, 0, true, 'nonFinite', { firstAlertStep: 12, firstCatastrophicStep: 12 }]]));
    new DataView(alertAfter.buffer).setUint32(MEMBER(0) + 39, 13, true); // alert at 13 > cat at 12
    expect(() => deserializeFitnessVector(alertAfter)).toThrow(/individuals\[0\]\.integrityObservations\.firstAlertStep/);
  });

  test("status 'ok' carries NO catastrophic step; 'numericalDivergence' always carries one", () => {
    // The 'ok' case carries a COHERENT alert step deliberately: with alert
    // null the catastrophic-implies-alert rule fires first and the 'ok' rule
    // is unfalsifiable beside it.
    expect(() => serializeFitnessVector(synth([[3, 0, true, 'ok', { firstAlertStep: 12, firstCatastrophicStep: 12 }]])))
      .toThrow(/individual 3 integrityObservations\.firstCatastrophicStep/);
    expect(() => serializeFitnessVector(synth([[3, 0, true, 'numericalDivergence', { firstAlertStep: 3, firstCatastrophicStep: null }]])))
      .toThrow(/individual 3 integrityObservations\.firstCatastrophicStep/);
    const okWithCat = serializeFitnessVector(synth([[3, 0, true, 'ok', { firstAlertStep: 12 }]]));
    const v1 = new DataView(okWithCat.buffer);
    v1.setUint8(MEMBER(0) + 43, 1);
    v1.setUint32(MEMBER(0) + 44, 12, true);
    expect(() => deserializeFitnessVector(okWithCat)).toThrow(/individuals\[0\]\.integrityObservations\.firstCatastrophicStep/);
    const divergenceWithoutCat = serializeFitnessVector(synth([[3, 0, true, 'numericalDivergence']]));
    const v2 = new DataView(divergenceWithoutCat.buffer);
    v2.setUint8(MEMBER(0) + 43, 0);
    v2.setUint32(MEMBER(0) + 44, 0, true);
    expect(() => deserializeFitnessVector(divergenceWithoutCat)).toThrow(/individuals\[0\]\.integrityObservations\.firstCatastrophicStep/);
  });

  test("'nonFinite' is unconstrained — with or without a catastrophic step, and the same-step boundary is legal", () => {
    // A nonFinite row whose peaks stayed finite because the invalid samples were
    // NaN: both onset steps null, and that is NOT a contradiction.
    const without = synth([[3, 0, true, 'nonFinite']]);
    const decodedWithout = deserializeFitnessVector(serializeFitnessVector(without));
    assertVectorLeafEqual(decodedWithout, without);
    // A nonFinite status with a LATER catastrophic step: status records the FIRST
    // failure class, so nonFinite at step 5 + catastrophic at step 9 is legal.
    const withCat = synth([[3, 0, true, 'nonFinite', { firstAlertStep: 5, firstCatastrophicStep: 9 }]]);
    const decodedWith = deserializeFitnessVector(serializeFitnessVector(withCat));
    assertVectorLeafEqual(decodedWith, withCat);
    // The same-capture catastrophic-plus-nonfinite ordering surfaces as
    // 'numericalDivergence' at the producer; at the codec the <= boundary
    // (alert at the SAME step as catastrophic) is simply legal.
    const sameStep = synth([[3, 0, true, 'numericalDivergence', { firstAlertStep: 12, firstCatastrophicStep: 12 }]]);
    const decodedSame = deserializeFitnessVector(serializeFitnessVector(sameStep));
    assertVectorLeafEqual(decodedSame, sameStep);
  });

  test('a numericalDivergence row carrying +Infinity peaks round-trips (the producible case that fixed the domain)', () => {
    // Measured producer path: Math.sqrt(Infinity*Infinity) is Infinity, which
    // takes the peak AND the catastrophic crossing. The row is legal policy-v1
    // output, so the codec must carry it bit-exactly.
    const evaluation = synth([[3, 0, true, 'numericalDivergence', {
      peakBodySpeed: Infinity,
      peakSpeedDelta: Infinity,
      peakStepDisplacement: 25,
      firstAlertStep: 46,
      firstCatastrophicStep: 46,
    }]]);
    const bytes = serializeFitnessVector(evaluation);
    const decoded = deserializeFitnessVector(bytes);
    assertVectorLeafEqual(decoded, evaluation);
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });
});

describe('fitness vector — malformed streams fail loud', () => {
  const base = () => serializeFitnessVector(synth([[3, 2.5, true], [9, 0, false]]));
  // Header: vectorVersion@0, policyVersion@2, integrityPolicyVersion@4,
  // snapshotVersion@6, snapshotState@8, specVersion@12, specState@14, count@18.
  // Member i at 22 + 48i: id u32, valid u8, status u8, fitness f64,
  // peakBodySpeed f64, peakSpeedDelta f64, peakStepDisplacement f64,
  // firstAlertStepPresent u8, firstAlertStep u32,
  // firstCatastrophicStepPresent u8, firstCatastrophicStep u32.
  const MEMBER = (i) => 22 + 48 * i;

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
        integrityObservations: observationsFor('ok', { peakBodySpeed: i }),
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
