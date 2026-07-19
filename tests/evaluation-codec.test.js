// Pure tests for the evaluation-spec + fitness-vector codecs
// (src/sim/population-evaluation.js) — no Rapier, no physics.
//
// The headline proof: the committed a6d04f75 fitness-vector lock is
// reconstructed WITHOUT PHYSICS — the snapshot digest state from the
// fixture-A inputs, the lock's own per-member literals (all-'ok' per the
// lock's re-lock comment), and the reconstructed resolved spec — and lands
// LOCK.fitnessVectorDigest read THROUGH the imported lock (zero duplicated
// digest literals; the physics gate in population-determinism.test.js binds
// the same constant in the same `npm test` run).
//
// Decoder depth is ruling R-C: the spec decoder mirrors the SERIALIZER's
// wire validation exactly — NOT resolveSpec — so encoder-producible but
// execution-invalid streams (clearance outside the band, an off-pad spawn,
// negative wheelFriction) decode cleanly; execution validation remains
// evaluatePopulation's responsibility. The vector decoder mirrors the
// encoder's member checks verbatim, including the `!== 0` contradiction
// tooth (a legally-encoded −0 on an unselectable member is preserved).

import { describe, test, expect } from 'vitest';
import {
  EVALUATION_SPEC_VERSION,
  FITNESS_POLICY_VERSION,
  FITNESS_VECTOR_VERSION,
  SPAWN_CLEARANCE,
  deserializeEvaluationSpec,
  deserializeFitnessVector,
  serializeEvaluationSpec,
  serializeFitnessVector,
} from '../src/sim/population-evaluation.js';
import { INTEGRITY_POLICY_VERSION } from '../src/sim/integrity.js';
import {
  POPULATION_SNAPSHOT_VERSION,
  bytesEqual,
  serializePopulationSnapshot,
} from '../src/sim/population.js';
import { TERRAIN_DEFAULTS } from '../src/sim/terrain.js';
import { WHEEL_FRICTION } from '../src/sim/physics/adapter.js';
import { POPULATION_FIXTURE_A, populationEvaluationInputsFor } from '../src/sim/population-fixtures.js';
import { POPULATION_GOLDEN_LOCKS } from '../src/sim/population-locks.js';
import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHex } from '../src/sim/fnv1a.js';

const LOCK = POPULATION_GOLDEN_LOCKS[POPULATION_FIXTURE_A.name];

// --- Copy-declared helpers ----------------------------------------------------

// Object.is-strict deep equality (the trace.test.js idiom, copy-declared).
function assertBitEqual(actual, expected, path = 'value') {
  if (typeof expected === 'number') {
    expect(Object.is(actual, expected), `${path}: ${actual} vs ${expected}`).toBe(true);
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) assertBitEqual(actual[k], expected[k], `${path}.${k}`);
    return;
  }
  expect(actual).toBe(expected);
}

// The default-walk resolved spec (401 bytes; population-evaluation.test.js's
// resolved() shape with plain TERRAIN_DEFAULTS).
const defaultSpec = () => ({
  deterministic: true,
  termination: 'maxSteps',
  maxSteps: 120,
  spawn: { x: -45, z: 0, clearance: SPAWN_CLEARANCE },
  targetWheelSurfaceSpeed: 5,
  wheelFriction: 1,
  terrain: { ...TERRAIN_DEFAULTS },
});

// The fixture-A spec in its RESOLVED shape — what evaluatePopulation stores
// at evaluation.spec, reconstructed from the fixture's declared inputs.
const resolvedFixtureSpec = () => ({
  deterministic: true,
  termination: 'maxSteps',
  maxSteps: POPULATION_FIXTURE_A.maxSteps,
  spawn: { ...POPULATION_FIXTURE_A.spawn, clearance: SPAWN_CLEARANCE },
  targetWheelSurfaceSpeed: POPULATION_FIXTURE_A.targetWheelSurfaceSpeed,
  wheelFriction: WHEEL_FRICTION,
  terrain: { ...TERRAIN_DEFAULTS, ...POPULATION_FIXTURE_A.terrainConfig },
});

// The synth() idiom copy-declared from population-evaluation.test.js: entry
// tuple [individualId, fitness, valid, integrityStatus='ok'].
const synth = (entries) => ({
  spec: defaultSpec(),
  populationSnapshotDigestState: 0xdeadbeef,
  individuals: entries.map(([individualId, fitness, valid, integrityStatus = 'ok']) => (
    { individualId, fitness, valid, integrityStatus })),
});

const specDigestStateOf = (spec) => fnv1aFold(FNV_OFFSET_BASIS, serializeEvaluationSpec(spec));

describe('evaluation-spec codec', () => {
  test('the 401-byte default walk round trips: all 33 terrain knobs leaf-equal, ranges element-wise, weights exact key set', () => {
    const spec = defaultSpec();
    const bytes = serializeEvaluationSpec(spec);
    expect(bytes.length).toBe(401); // 49-byte header+count, 352-byte terrain walk
    const snapshot = bytes.slice();
    const decoded = deserializeEvaluationSpec(bytes);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.spawn)).toBe(true);
    expect(Object.isFrozen(decoded.terrain)).toBe(true);
    expect(Object.isFrozen(decoded.terrain.craterRadiusRange)).toBe(true);
    expect(Object.isFrozen(decoded.terrain.featureTypeWeights)).toBe(true);
    expect(Object.keys(decoded.terrain).length).toBe(33);
    assertBitEqual(decoded, spec, 'spec');
    expect(Object.keys(decoded.terrain.featureTypeWeights).sort()).toEqual(['boulder', 'log', 'ramp']);
    expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
    expect(bytes).toEqual(snapshot); // input not mutated
  });

  test('the reconstructed fixture-A spec round trips and binds the locked spec digest (via the imported lock)', () => {
    const spec = resolvedFixtureSpec();
    const bytes = serializeEvaluationSpec(spec);
    expect(fnv1aHex(bytes)).toBe(LOCK.evaluationSpecDigest);
    const decoded = deserializeEvaluationSpec(bytes);
    assertBitEqual(decoded, spec, 'spec');
    expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
  });

  test('encoded values are preserved VERBATIM — the decoder never re-defaults', () => {
    // clearance and wheelFriction are the knobs resolveSpec can default;
    // non-default encodings must survive the decode untouched.
    const spec = defaultSpec();
    spec.spawn = { ...spec.spawn, clearance: 0.03 };
    spec.wheelFriction = 0.9;
    const decoded = deserializeEvaluationSpec(serializeEvaluationSpec(spec));
    expect(Object.is(decoded.spawn.clearance, 0.03)).toBe(true);
    expect(Object.is(decoded.wheelFriction, 0.9)).toBe(true);
  });

  test('non-default legal values round trip (the mutation-list idiom)', () => {
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
      const spec = defaultSpec();
      mutate(spec);
      const bytes = serializeEvaluationSpec(spec);
      const decoded = deserializeEvaluationSpec(bytes);
      assertBitEqual(decoded, spec, 'spec');
      expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
    }
  });

  test('encoder-producible-but-EXECUTION-INVALID streams decode cleanly (the R-C asymmetry tooth)', () => {
    // The encoder validates wire shape + finiteness only; resolveSpec's
    // execution-level constraints (clearance ∈ (0, 0.05], the flat-pad spawn
    // guard, wheelFriction ≥ 0) are NOT the codec's business — decoding must
    // not call resolveSpec, or these byte streams could not exist.
    for (const mutate of [
      (s) => { s.spawn = { ...s.spawn, clearance: 0.2 }; }, // outside the (0, 0.05] band
      (s) => { s.spawn = { ...s.spawn, x: 0 }; }, // off the flat pad
      (s) => { s.wheelFriction = -0.5; }, // resolveSpec would reject
    ]) {
      const spec = defaultSpec();
      mutate(spec);
      const bytes = serializeEvaluationSpec(spec);
      const decoded = deserializeEvaluationSpec(bytes);
      assertBitEqual(decoded, spec, 'spec');
      expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
    }
  });

  test('the R-D guard tooth: a 256-element range FAILS LOUD at the encoder (no wire-inconsistent stream)', () => {
    const spec = defaultSpec();
    spec.terrain = { ...spec.terrain, craterRadiusRange: new Array(256).fill(1) };
    expect(() => serializeEvaluationSpec(spec)).toThrow(/terrain\.craterRadiusRange\.length \(256 exceeds the u8 wire bound 255\)/);
    spec.terrain = { ...spec.terrain, craterRadiusRange: new Array(255).fill(1) };
    expect(serializeEvaluationSpec(spec).length).toBe(401 - (1 + 2 * 8) + (1 + 255 * 8));
  });

  test('negatives: version, flag, termination, key count, lying range, weights shape, NaN, maxSteps 0, truncation, trailing', () => {
    const base = serializeEvaluationSpec(defaultSpec());
    const fail = /population-evaluation: invalid encoded evaluation spec/;
    const patchU8 = (offset, value) => {
      const out = base.slice();
      out[offset] = value;
      return out;
    };
    const patchU16 = (offset, value) => {
      const out = base.slice();
      new DataView(out.buffer).setUint16(offset, value, true);
      return out;
    };
    const patchU32 = (offset, value) => {
      const out = base.slice();
      new DataView(out.buffer).setUint32(offset, value, true);
      return out;
    };
    const patchF64 = (offset, value) => {
      const out = base.slice();
      new DataView(out.buffer).setFloat64(offset, value, true);
      return out;
    };
    expect(() => deserializeEvaluationSpec(patchU16(0, 2))).toThrow(/at specVersion/);
    expect(() => deserializeEvaluationSpec(patchU8(2, 2))).toThrow(/at deterministic/); // flag strictness
    expect(() => deserializeEvaluationSpec(patchU8(3, 1))).toThrow(/at termination/);
    expect(() => deserializeEvaluationSpec(patchU8(48, 32))).toThrow(/at terrainKeyCount/);
    // A lying range length (craterRadiusRange count byte @197: 2 -> 5).
    expect(() => deserializeEvaluationSpec(patchU8(197, 5))).toThrow(fail);
    // Weights: count byte @271 must be 3; declared indices @272/@281/@290 must be 0/1/2.
    expect(() => deserializeEvaluationSpec(patchU8(271, 2))).toThrow(/count/);
    expect(() => deserializeEvaluationSpec(patchU8(272, 1))).toThrow(/index/);
    expect(() => deserializeEvaluationSpec(patchF64(53, NaN))).toThrow(/at terrain\.length/);
    expect(() => deserializeEvaluationSpec(patchU32(4, 0))).toThrow(/at maxSteps/);
    for (const n of [1, 48, 200, 400]) {
      expect(() => deserializeEvaluationSpec(base.subarray(0, n)), `length ${n}`).toThrow(fail);
    }
    expect(() => deserializeEvaluationSpec(Uint8Array.from([...base, 0]))).toThrow(/trailing/);
  });

  test('hygiene: subarray with nonzero byteOffset decodes its own window', () => {
    const base = serializeEvaluationSpec(defaultSpec());
    const backing = Uint8Array.from([0xaa, 0xbb, ...base, 0xcc]);
    const decoded = deserializeEvaluationSpec(backing.subarray(2, 2 + base.length));
    assertBitEqual(decoded, defaultSpec(), 'spec');
    expect(backing.length).toBe(base.length + 3);
  });
});

describe('fitness-vector codec', () => {
  test('the committed a6d04f75 vector reconstructs WITHOUT physics, decodes leaf-equal, and re-serializes byte-identical', () => {
    const { population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const spec = resolvedFixtureSpec();
    const snapshotState = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population));
    const evaluation = {
      spec,
      populationSnapshotDigestState: snapshotState,
      // The lock's own per-member literals; all 20 members measured
      // integrity-clean at the v2 re-lock (population-locks.js comment).
      individuals: LOCK.individuals.map((i) => ({
        individualId: i.individualId,
        valid: i.valid,
        integrityStatus: 'ok',
        fitness: i.fitness,
      })),
    };
    const bytes = serializeFitnessVector(evaluation);
    expect(bytes.length).toBe(22 + 14 * 20);
    expect(fnv1aHex(bytes)).toBe(LOCK.fitnessVectorDigest); // through the imported lock — zero duplicated literals

    const decoded = deserializeFitnessVector(bytes);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(decoded.fitnessVectorVersion).toBe(FITNESS_VECTOR_VERSION);
    expect(decoded.fitnessPolicyVersion).toBe(FITNESS_POLICY_VERSION);
    expect(decoded.integrityPolicyVersion).toBe(INTEGRITY_POLICY_VERSION);
    expect(decoded.snapshotVersion).toBe(POPULATION_SNAPSHOT_VERSION);
    expect(decoded.evaluationSpecVersion).toBe(EVALUATION_SPEC_VERSION);
    expect(decoded.populationSnapshotDigestState).toBe(snapshotState);
    expect(decoded.evaluationSpecDigestState).toBe(specDigestStateOf(spec));
    assertBitEqual(decoded.individuals, evaluation.individuals, 'individuals');

    // Re-serialize via the 4a declared-state path (spec absent): byte-identical.
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });

  test('synthetic members round trip: selectable positive/+0, invalid 0, both integrity-failure statuses, id 0xffffffff, exact f64', () => {
    const cases = [
      [[7, 3.5, true]],
      [[7, 0, true]], // selectable +0
      [[7, 0, false]], // invalid 0
      [[7, 0, true, 'nonFinite']],
      [[7, 0, true, 'numericalDivergence']],
      [[0xffffffff, 1, true]], // the u32 ceiling id
      [[0, 8.419723510742188, true]], // an exact-f64 fitness
      [[3, 0, false], [9, 12.484905242919922, true]], // mixed pair, ascending
    ];
    for (const entries of cases) {
      const evaluation = synth(entries);
      const bytes = serializeFitnessVector(evaluation);
      const decoded = deserializeFitnessVector(bytes);
      assertBitEqual(decoded.individuals, evaluation.individuals, 'individuals');
      expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
    }
  });

  test('a legally-encoded −0 fitness on an unselectable member is PRESERVED (the !== 0 tooth, not Object.is)', () => {
    const evaluation = synth([[5, -0, false]]);
    const bytes = serializeFitnessVector(evaluation);
    expect(bytes[22 + 4 + 1 + 1 + 7]).toBe(0x80); // the f64 sign byte
    const decoded = deserializeFitnessVector(bytes);
    expect(Object.is(decoded.individuals[0].fitness, -0)).toBe(true);
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });

  test('encoder-with-state-only ≡ encoder-with-spec byte identity (the 4a additive input)', () => {
    const withSpec = synth([[7, 3.5, true]]);
    const stateOnly = {
      populationSnapshotDigestState: withSpec.populationSnapshotDigestState,
      evaluationSpecDigestState: specDigestStateOf(withSpec.spec),
      individuals: withSpec.individuals,
    };
    expect(bytesEqual(serializeFitnessVector(stateOnly), serializeFitnessVector(withSpec))).toBe(true);
  });

  test('both-present cross-check: a declared state must AGREE with the spec digest, else fail loud', () => {
    const evaluation = synth([[7, 3.5, true]]);
    const state = specDigestStateOf(evaluation.spec);
    const agreed = { ...evaluation, evaluationSpecDigestState: state };
    expect(bytesEqual(serializeFitnessVector(agreed), serializeFitnessVector(evaluation))).toBe(true);
    const disagreed = { ...evaluation, evaluationSpecDigestState: (state ^ 1) >>> 0 };
    expect(() => serializeFitnessVector(disagreed)).toThrow(/disagrees with the digest of evaluation\.spec/);
    // Spec ABSENT and no declared state: the canonical-uint32 gate fires.
    const noState = {
      populationSnapshotDigestState: evaluation.populationSnapshotDigestState,
      individuals: evaluation.individuals,
    };
    expect(() => serializeFitnessVector(noState)).toThrow(/evaluationSpecDigestState/);
  });

  test('negatives: a validity byte 0 under positive fitness is REJECTED, never repaired', () => {
    const base = serializeFitnessVector(synth([[7, 3.5, true]]));
    const tampered = base.slice();
    tampered[26] = 0; // valid -> false with fitness 3.5: internally contradictory
    expect(() => deserializeFitnessVector(tampered)).toThrow(/must have fitness 0/);
  });

  test('negatives: duplicate and unordered ids', () => {
    const base = serializeFitnessVector(synth([[5, 1, true], [9, 2, true]]));
    for (const bad of [5, 4]) {
      const tampered = base.slice();
      new DataView(tampered.buffer).setUint32(36, bad, true); // member 1 id
      expect(() => deserializeFitnessVector(tampered), `id ${bad}`).toThrow(/not strictly ascending/);
    }
  });

  test('negatives: count lies (0, −1, +1 against the exact 22 + 14·count length)', () => {
    const base = serializeFitnessVector(synth([[5, 1, true], [9, 2, true]]));
    expect(base.length).toBe(22 + 14 * 2);
    for (const count of [0, 1, 3]) {
      const tampered = base.slice();
      new DataView(tampered.buffer).setUint32(18, count, true);
      expect(() => deserializeFitnessVector(tampered), `count ${count}`).toThrow(
        /population-evaluation: invalid encoded fitness vector/,
      );
    }
  });

  test('negatives: every header version field rejects +1 (current constants only)', () => {
    const base = serializeFitnessVector(synth([[7, 0, true]]));
    for (const offset of [0, 2, 4, 6, 12]) {
      const tampered = base.slice();
      const view = new DataView(tampered.buffer);
      view.setUint16(offset, view.getUint16(offset, true) + 1, true);
      expect(() => deserializeFitnessVector(tampered), `offset ${offset}`).toThrow(
        /population-evaluation: invalid encoded fitness vector/,
      );
    }
  });

  test('negatives: status byte 3, validity byte 2, sign-bit fitness, NaN fitness, truncations, trailing', () => {
    const base = serializeFitnessVector(synth([[7, 1.5, true]]));
    expect(base.length).toBe(36);
    const fail = /population-evaluation: invalid encoded fitness vector/;
    const patch = (offset, value) => {
      const out = base.slice();
      out[offset] = value;
      return out;
    };
    expect(() => deserializeFitnessVector(patch(27, 3))).toThrow(/at individuals\[0\]\.integrityStatus/);
    expect(() => deserializeFitnessVector(patch(26, 2))).toThrow(/at individuals\[0\]\.valid/);
    expect(() => deserializeFitnessVector(patch(35, base[35] | 0x80))).toThrow(/at individuals\[0\]\.fitness/); // −1.5
    const nan = base.slice();
    new DataView(nan.buffer).setFloat64(28, NaN, true);
    expect(() => deserializeFitnessVector(nan)).toThrow(/at individuals\[0\]\.fitness/);
    for (const n of [1, 21, 22, 30, 35]) {
      expect(() => deserializeFitnessVector(base.subarray(0, n)), `length ${n}`).toThrow(fail);
    }
    // A trailing byte is caught by the exact total-length check (22 + 14·count).
    expect(() => deserializeFitnessVector(Uint8Array.from([...base, 0]))).toThrow(/!== 14 for count 1/);
  });

  test('hygiene: input not mutated; subarray with nonzero byteOffset decodes its own window', () => {
    const evaluation = synth([[3, 0, false], [9, 4.25, true]]);
    const base = serializeFitnessVector(evaluation);
    const snapshot = base.slice();
    const backing = Uint8Array.from([0xaa, ...base, 0xcc]);
    const decoded = deserializeFitnessVector(backing.subarray(1, 1 + base.length));
    assertBitEqual(decoded.individuals, evaluation.individuals, 'individuals');
    expect(base).toEqual(snapshot);
    expect(backing.length).toBe(base.length + 2);
  });
});
