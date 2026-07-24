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
// The committed fitness vector is reconstructed WITHOUT re-running
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
  fitnessVectorByteLength, serializeEvaluationSpec, serializeFitnessVector,
} from '../src/sim/population-evaluation.js';
import { POPULATION_SNAPSHOT_VERSION, bytesEqual, serializePopulationSnapshot } from '../src/sim/population.js';
import {
  createInitialPopulation, serializePopulationInitialization,
} from '../src/sim/population-initializer.js';
import { INTEGRITY_POLICY_VERSION, INTEGRITY_STATUS, INTEGRITY_THRESHOLDS } from '../src/sim/integrity.js';
import { bytesToHex, hexToBytes } from '../src/sim/bytes.js';
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

// Entry tuple: [individualId, fitness, valid, integrityStatus='ok', observations].
// Observation defaults are STATUS-AWARE so every call site is a legal v3 row:
// a clean or nonFinite member defaults to quiet observations (peaks 0, both
// onsets null); a numericalDivergence member defaults to a coherent divergence
// record (catastrophic onset present, alert at or before it), because the
// policy-1 coherence tooth requires the catastrophic step. The optional fifth
// tuple element overrides field by field.
const OBSERVATION_DEFAULTS = Object.freeze({
  ok: Object.freeze({
    peakBodySpeed: 0, peakSpeedDelta: 0, peakStepDisplacement: 0,
    firstAlertStep: null, firstCatastrophicStep: null,
  }),
  nonFinite: Object.freeze({
    peakBodySpeed: 0, peakSpeedDelta: 0, peakStepDisplacement: 0,
    firstAlertStep: null, firstCatastrophicStep: null,
  }),
  numericalDivergence: Object.freeze({
    peakBodySpeed: 1200, peakSpeedDelta: 0, peakStepDisplacement: 0,
    firstAlertStep: 3, firstCatastrophicStep: 5,
  }),
});
const synth = (entries, spec = resolvedFlat()) => ({
  spec,
  populationSnapshotDigestState: 0xdeadbeef,
  individuals: entries.map(([individualId, fitness, valid, integrityStatus = 'ok', observations]) => (
    {
      individualId, fitness, valid, integrityStatus,
      ...OBSERVATION_DEFAULTS[integrityStatus], ...observations,
    })),
});

// String(-0) is '0' — the label helper from the property harness, copy-declared.
const fmt = (v) => (Object.is(v, -0) ? '-0' : String(v));

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
    // The five v3 integrity observations — peaks under Object.is (f64 leaves,
    // -0 and +Infinity are distinct decodable values), onsets under toBe
    // (null or a canonical u32, never a float).
    expect(Object.is(decoded.individuals[i].peakBodySpeed, ind.peakBodySpeed), `peakBodySpeed[${i}]`).toBe(true);
    expect(Object.is(decoded.individuals[i].peakSpeedDelta, ind.peakSpeedDelta), `peakSpeedDelta[${i}]`).toBe(true);
    expect(Object.is(decoded.individuals[i].peakStepDisplacement, ind.peakStepDisplacement),
      `peakStepDisplacement[${i}]`).toBe(true);
    expect(decoded.individuals[i].firstAlertStep, `firstAlertStep[${i}]`).toBe(ind.firstAlertStep);
    expect(decoded.individuals[i].firstCatastrophicStep, `firstCatastrophicStep[${i}]`).toBe(ind.firstCatastrophicStep);
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
      // The five v3 observations are lock literals too — real measured values
      // (peaks are nonzero even on clean runs) — keeping the reconstruction
      // physics-free.
      individuals: LOCK.individuals.map((m) => ({
        individualId: m.individualId,
        valid: m.valid,
        integrityStatus: 'ok',
        fitness: m.fitness,
        peakBodySpeed: m.peakBodySpeed,
        peakSpeedDelta: m.peakSpeedDelta,
        peakStepDisplacement: m.peakStepDisplacement,
        firstAlertStep: m.firstAlertStep,
        firstCatastrophicStep: m.firstCatastrophicStep,
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
      // A divergence observed at the very first capture: both onsets at step 0
      // (present, byte-distinct from null) and a +Infinity peak — the legal
      // policy-v1 output measured in the grounding.
      [[0, 0, true, 'numericalDivergence',
        { peakBodySpeed: Infinity, firstAlertStep: 0, firstCatastrophicStep: 0 }]],
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
      individualId: 0, valid: true, integrityStatus: 'ok', fitness: 0,
      ...OBSERVATION_DEFAULTS.ok,
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
  // Per-member wire layout (48 B): id u32 | valid u8 | status u8 | fitness f64
  // | peakBodySpeed f64 | peakSpeedDelta f64 | peakStepDisplacement f64
  // | firstAlertStepPresent u8 | firstAlertStep u32
  // | firstCatastrophicStepPresent u8 | firstCatastrophicStep u32.
  // Member 0 field offsets, hand-derived from the 22-byte header:
  const PEAK_BODY_SPEED = 36;
  const ALERT_FLAG = 60;
  const ALERT_STEP = 61;
  const CAT_FLAG = 65;
  const CAT_STEP = 66;

  test('the version constant and the geometry moved together', () => {
    expect(FITNESS_VECTOR_VERSION).toBe(3);
    expect(fitnessVectorByteLength(1)).toBe(70);
    expect(fitnessVectorByteLength(20)).toBe(22 + 20 * 48);
  });

  test('the hand-computed v3 byte literal — the strongest narrow oracle for the new wire layout', () => {
    // A one-member vector through the additive digest-state path, every byte
    // written down independently of the encoder. The member is the measured
    // policy-v1 shape from the grounding: a numericalDivergence carrying a
    // +Infinity peak (000000000000f07f) with both onsets present.
    const V3_LITERAL_HEX = [
      '0300', // fitnessVectorVersion 3
      '0200', // fitnessPolicyVersion 2
      '0100', // integrityPolicyVersion 1
      '0100', // snapshotVersion 1
      '44332211', // populationSnapshotDigestState 0x11223344
      '0100', // evaluationSpecVersion 1
      '88776655', // evaluationSpecDigestState 0x55667788
      '01000000', // count 1
      '07000000', // individualId 7
      '01', // valid true
      '02', // integrityStatus numericalDivergence
      '0000000000000000', // fitness 0 (unselectable => 0)
      '000000000000f07f', // peakBodySpeed +Infinity
      '000000000000f83f', // peakSpeedDelta 1.5
      '000000000000d03f', // peakStepDisplacement 0.25
      '01', // firstAlertStepPresent
      '03000000', // firstAlertStep 3
      '01', // firstCatastrophicStepPresent
      '07000000', // firstCatastrophicStep 7
    ].join('');
    const evaluation = {
      populationSnapshotDigestState: 0x11223344,
      evaluationSpecDigestState: 0x55667788,
      individuals: [{
        individualId: 7,
        valid: true,
        integrityStatus: 'numericalDivergence',
        fitness: 0,
        peakBodySpeed: Infinity,
        peakSpeedDelta: 1.5,
        peakStepDisplacement: 0.25,
        firstAlertStep: 3,
        firstCatastrophicStep: 7,
      }],
    };
    const bytes = serializeFitnessVector(evaluation);
    expect(bytesToHex(bytes)).toBe(V3_LITERAL_HEX);
    const decoded = deserializeFitnessVector(hexToBytes(V3_LITERAL_HEX));
    assertVectorLeafEqual(decoded, evaluation);
    expect(decoded.individuals[0].peakBodySpeed).toBe(Infinity);
    expect(bytesEqual(serializeFitnessVector(decoded), hexToBytes(V3_LITERAL_HEX))).toBe(true);
  });

  test('null and step 0 are byte-distinct, and the absent u32 payload is exactly 0', () => {
    const absent = serializeFitnessVector(synth([[0, 1, true, 'ok', { firstAlertStep: null }]]));
    const atZero = serializeFitnessVector(synth([[0, 1, true, 'ok', { firstAlertStep: 0 }]]));
    // The ONLY differing byte is the presence flag — the encoder writes a zero
    // payload unconditionally when the field is absent, so one semantic value
    // has exactly one byte string.
    expect(absent[ALERT_FLAG]).toBe(0);
    expect(atZero[ALERT_FLAG]).toBe(1);
    for (let i = 0; i < absent.length; i += 1) {
      if (i !== ALERT_FLAG) expect(absent[i], `byte ${i}`).toBe(atZero[i]);
    }
    for (let i = ALERT_STEP; i < ALERT_STEP + 4; i += 1) expect(absent[i], `payload byte ${i}`).toBe(0);
    expect(deserializeFitnessVector(absent).individuals[0].firstAlertStep).toBe(null);
    expect(deserializeFitnessVector(atZero).individuals[0].firstAlertStep).toBe(0);
  });

  test('an absent flag with a nonzero payload is rejected — both optional fields independently', () => {
    // Byte-tampered non-canonical streams: flag 0, payload nonzero. Without
    // this refusal two byte strings would decode to one record and
    // decode->encode would not be an inverse.
    for (const [label, offset] of [['firstAlertStep', ALERT_STEP], ['firstCatastrophicStep', CAT_STEP]]) {
      const bytes = serializeFitnessVector(synth([[0, 1, true]]));
      new DataView(bytes.buffer).setUint32(offset, 9, true);
      expect(() => deserializeFitnessVector(bytes), label)
        .toThrow(new RegExp(`individuals\\[0\\]\\.${label}`));
    }
  });

  test('a presence flag byte other than 0 or 1 is rejected — both flags independently', () => {
    for (const [label, offset] of [
      ['firstAlertStepPresent', ALERT_FLAG], ['firstCatastrophicStepPresent', CAT_FLAG],
    ]) {
      const bytes = serializeFitnessVector(synth([[0, 1, true]]));
      bytes[offset] = 2;
      expect(() => deserializeFitnessVector(bytes), label)
        .toThrow(new RegExp(`individuals\\[0\\]\\.${label} \\(2\\)`));
    }
  });

  test('each peak admits +Infinity and every finite boundary, and preserves -0 bit-exactly', () => {
    // R4: `typeof value === 'number' && value >= 0` — which admits +Infinity
    // (legal policy-v1 output) and -0 (>= 0 is true; the standing f64-leaf
    // ruling, unreachable from the producer but legal on the wire).
    const PEAKS = ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement'];
    for (const field of PEAKS) {
      for (const value of [0, -0, Number.MIN_VALUE, 2 ** -1022, 1, Number.MAX_VALUE, Infinity]) {
        const evaluation = synth([[0, 1, true, 'ok', { [field]: value }]]);
        const decoded = deserializeFitnessVector(serializeFitnessVector(evaluation));
        expect(Object.is(decoded.individuals[0][field], value), `${field}=${fmt(value)}`).toBe(true);
      }
    }
  });

  test('each peak rejects NaN, -Infinity, negatives and non-numbers — encoder and decoder', () => {
    const PEAKS = ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement'];
    for (const field of PEAKS) {
      for (const bad of [NaN, -Infinity, -1, -Number.MIN_VALUE, '5', null, undefined, true]) {
        const evaluation = synth([[0, 1, true, 'ok', { [field]: bad }]]);
        expect(() => serializeFitnessVector(evaluation), `${field}=${fmt(bad)}`)
          .toThrow(new RegExp(`individual 0 ${field}`));
      }
    }
    // Decoder mirror at the wire: member 0's peaks start at byte 36, stride 8.
    for (const [i, field] of PEAKS.entries()) {
      for (const bad of [NaN, -Infinity, -1]) {
        const bytes = serializeFitnessVector(synth([[0, 1, true]]));
        new DataView(bytes.buffer).setFloat64(PEAK_BODY_SPEED + 8 * i, bad, true);
        expect(() => deserializeFitnessVector(bytes), `${field}=${fmt(bad)}`)
          .toThrow(new RegExp(`individuals\\[0\\]\\.${field}`));
      }
    }
  });

  test('the onset steps are canonical u32 or null — nothing else encodes', () => {
    for (const field of ['firstAlertStep', 'firstCatastrophicStep']) {
      for (const bad of [-1, 1.5, NaN, Infinity, '3', 0x100000000, -0, undefined, false]) {
        // Keep the row coherent apart from the field under test, so the ONLY
        // possible refusal is the canonicality of this step value.
        const observations = field === 'firstAlertStep'
          ? { firstAlertStep: bad, firstCatastrophicStep: null }
          : { firstAlertStep: 1, firstCatastrophicStep: bad };
        const status = field === 'firstAlertStep' ? 'ok' : 'nonFinite';
        const evaluation = synth([[0, 0, status === 'ok', status, observations]]);
        evaluation.individuals[0].fitness = 0;
        expect(() => serializeFitnessVector(evaluation), `${field}=${fmt(bad)}`)
          .toThrow(new RegExp(`individual 0 ${field}`));
      }
    }
  });

  test('policy-1 coherence: a catastrophic onset requires an alert onset at or before it', () => {
    // Encoder side — catastrophic-without-alert and alert-after-catastrophic
    // are both producer-impossible under policy v1 (same body, same capture,
    // the alert threshold is below the catastrophic one) and are refused.
    const withoutAlert = synth([[3, 0, true, 'numericalDivergence',
      { firstAlertStep: null, firstCatastrophicStep: 5 }]]);
    expect(() => serializeFitnessVector(withoutAlert)).toThrow(/individual 3 firstCatastrophicStep/);
    const inverted = synth([[3, 0, true, 'numericalDivergence',
      { firstAlertStep: 6, firstCatastrophicStep: 5 }]]);
    expect(() => serializeFitnessVector(inverted)).toThrow(/individual 3 firstAlertStep/);
    // Same capture IS legal: the catastrophic threshold crossing sets both.
    const sameCapture = synth([[3, 0, true, 'numericalDivergence',
      { firstAlertStep: 5, firstCatastrophicStep: 5 }]]);
    const decoded = deserializeFitnessVector(serializeFitnessVector(sameCapture));
    expect(decoded.individuals[0].firstAlertStep).toBe(5);
    expect(decoded.individuals[0].firstCatastrophicStep).toBe(5);
    // Decoder side — tamper a coherent stream into each contradiction.
    const base = serializeFitnessVector(sameCapture);
    const noAlert = Uint8Array.from(base);
    noAlert[ALERT_FLAG] = 0;
    new DataView(noAlert.buffer).setUint32(ALERT_STEP, 0, true);
    expect(() => deserializeFitnessVector(noAlert)).toThrow(/individuals\[0\]\.firstCatastrophicStep/);
    const late = Uint8Array.from(base);
    new DataView(late.buffer).setUint32(ALERT_STEP, 6, true);
    expect(() => deserializeFitnessVector(late)).toThrow(/individuals\[0\]\.firstAlertStep/);
  });

  test('policy-1 coherence: the status and the catastrophic onset must agree', () => {
    // status 'ok' => no catastrophic onset; 'numericalDivergence' => one.
    const okWithCat = synth([[0, 0, true, 'ok', { firstAlertStep: 2, firstCatastrophicStep: 2 }]]);
    expect(() => serializeFitnessVector(okWithCat)).toThrow(/individual 0 firstCatastrophicStep/);
    const divergenceWithout = synth([[0, 0, true, 'numericalDivergence',
      { firstAlertStep: 2, firstCatastrophicStep: null }]]);
    expect(() => serializeFitnessVector(divergenceWithout)).toThrow(/individual 0 firstCatastrophicStep/);
    // An alert-only crossing on a clean run is an OBSERVATION, not a failure:
    // status 'ok' with firstAlertStep present round-trips.
    const alertOnly = synth([[0, 2.5, true, 'ok', { peakBodySpeed: 30, firstAlertStep: 11 }]]);
    const decoded = deserializeFitnessVector(serializeFitnessVector(alertOnly));
    expect(decoded.individuals[0].integrityStatus).toBe('ok');
    expect(decoded.individuals[0].firstAlertStep).toBe(11);
    expect(decoded.individuals[0].firstCatastrophicStep).toBe(null);
    // Decoder mirror for both status contradictions, via the status byte.
    const okBytes = serializeFitnessVector(synth([[0, 0, true, 'nonFinite',
      { firstAlertStep: 2, firstCatastrophicStep: 2 }]]));
    okBytes[27] = 0; // 'ok' beside a present catastrophic onset
    expect(() => deserializeFitnessVector(okBytes)).toThrow(/individuals\[0\]\.firstCatastrophicStep/);
    const divBytes = serializeFitnessVector(synth([[0, 0, false, 'ok']]));
    divBytes[27] = 2; // 'numericalDivergence' with no catastrophic onset
    expect(() => deserializeFitnessVector(divBytes)).toThrow(/individuals\[0\]\.firstCatastrophicStep/);
  });

  test('a nonFinite member whose peaks stayed finite, and one sharing a catastrophic capture', () => {
    // NaN samples never advance a peak (`NaN > peak` is false) and never cross
    // a threshold, so a nonFinite member with quiet finite observations is the
    // COMMON producer output — and a nonFinite that crossed the catastrophic
    // band on the same capture that went non-finite is representable too
    // (policy v1 constrains 'ok' and 'numericalDivergence', not 'nonFinite').
    const quiet = synth([[0, 0, true, 'nonFinite']]);
    const decodedQuiet = deserializeFitnessVector(serializeFitnessVector(quiet));
    expect(decodedQuiet.individuals[0].firstCatastrophicStep).toBe(null);
    expect(decodedQuiet.individuals[0].peakBodySpeed).toBe(0);
    const shared = synth([[0, 0, true, 'nonFinite',
      { peakBodySpeed: 1042.5, firstAlertStep: 7, firstCatastrophicStep: 7 }]]);
    const decodedShared = deserializeFitnessVector(serializeFitnessVector(shared));
    expect(decodedShared.individuals[0].integrityStatus).toBe('nonFinite');
    expect(decodedShared.individuals[0].firstCatastrophicStep).toBe(7);
    expect(bytesEqual(serializeFitnessVector(decodedShared), serializeFitnessVector(shared))).toBe(true);
  });

  test('the drift tooth: the alert band sits at or below the catastrophic band', () => {
    // The catastrophic=>alert coherence rule rests on the thresholds keeping
    // this order. If a policy revision inverts a band, this test names the
    // premise instead of letting the codec enforce a stale rule.
    expect(INTEGRITY_THRESHOLDS.alertSpeed).toBeLessThanOrEqual(INTEGRITY_THRESHOLDS.catastrophicSpeed);
    expect(INTEGRITY_THRESHOLDS.alertStepDisplacement)
      .toBeLessThanOrEqual(INTEGRITY_THRESHOLDS.catastrophicStepDisplacement);
  });

  test('a stale v2 stream is refused AT ITS VERSION FIELD, before any layout is assumed', () => {
    // A hand-built v2-layout vector (22-byte header + 14-byte member, version
    // 2): the decoder must name fitnessVectorVersion, not misparse the member.
    const v2 = new Uint8Array(22 + 14);
    const view = new DataView(v2.buffer);
    let o = 0;
    view.setUint16(o, 2, true); o += 2; // fitnessVectorVersion 2 (stale)
    view.setUint16(o, FITNESS_POLICY_VERSION, true); o += 2;
    view.setUint16(o, INTEGRITY_POLICY_VERSION, true); o += 2;
    view.setUint16(o, POPULATION_SNAPSHOT_VERSION, true); o += 2;
    view.setUint32(o, 1, true); o += 4;
    view.setUint16(o, EVALUATION_SPEC_VERSION, true); o += 2;
    view.setUint32(o, 2, true); o += 4;
    view.setUint32(o, 1, true); o += 4; // count 1
    view.setUint32(o, 0, true); o += 4; // individualId
    view.setUint8(o, 1); o += 1; // valid
    view.setUint8(o, 0); o += 1; // 'ok'
    view.setFloat64(o, 1.5, true); // fitness
    expect(() => deserializeFitnessVector(v2)).toThrow(/at fitnessVectorVersion \(2\)/);
  });
});

describe('fitness vector — malformed streams fail loud', () => {
  const base = () => serializeFitnessVector(synth([[3, 2.5, true], [9, 0, false]]));
  // Header: vectorVersion@0, policyVersion@2, integrityPolicyVersion@4,
  // snapshotVersion@6, snapshotState@8, specVersion@12, specState@14, count@18.
  // Member i at 22 + 48i: id u32, valid u8, status u8, fitness f64, three
  // observation peaks f64, then flag u8 + step u32 twice.
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
    // Cuts land in the header, on member boundaries, inside the fitness f64,
    // inside each observation peak, on a presence flag, and inside a step u32.
    for (const cut of [0, 1, 12, 18, 21, 22, 30, 35, 40, 56, 60, 63, 65, 68, full.length - 1]) {
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
        individualId, valid: true, integrityStatus: 'ok', fitness: i + 0.5, ...OBSERVATION_DEFAULTS.ok,
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
