// Pure tests for the population snapshot + initialization manifest codecs
// (src/sim/population.js, src/sim/population-initializer.js) — no Rapier,
// no physics.
//
// Both decoders are exact inverses of their encoders across the encoders'
// output domains (ruling R-C): the snapshot decoder re-runs
// validatePopulation (the repair-identity canonicality tooth included — a
// hand-crafted snapshot carrying a raw draw must not re-enter as heredity
// through the decode side door) PLUS strict-ascending STREAM order; the
// manifest decoder re-runs resolveConfig. The manifest round trip exercises
// the R-E additive digest-state path (5a): decoded manifests carry no
// population, so re-serialization binds the DECLARED digest state. The
// committed cae92db7/7acb271d digest bindings live in
// tests/population-determinism.test.js (same `npm test` run) — no literals
// are duplicated here.

import { describe, test, expect } from 'vitest';
import {
  GENOTYPE_VERSION,
  NODE_SLOTS,
  randomGenotype,
  repairGenotype,
  serializeGenotype,
} from '../src/sim/assembly.js';
import {
  POPULATION_SNAPSHOT_VERSION,
  bytesEqual,
  deserializePopulationSnapshot,
  serializePopulationSnapshot,
} from '../src/sim/population.js';
import {
  POPULATION_INITIALIZER_VERSION,
  createInitialPopulation,
  deserializePopulationInitialization,
  serializePopulationInitialization,
} from '../src/sim/population-initializer.js';
import { POPULATION_FIXTURE_A, populationEvaluationInputsFor } from '../src/sim/population-fixtures.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from '../src/sim/fnv1a.js';
import { Rng } from '../src/sim/prng.js';

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

const handNode = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
const handAxle = (posX01) => ({
  posX01,
  paired: 1,
  trackHalf: 0.5,
  radius: 0.6,
  width: 0.5,
  density: 0.15,
  suspType: 0.5,
  stiffness: 0.5,
  damping: 0.5,
  travel: 0.5,
  restLength: 0.5,
  driven: 1,
  share: 0.5,
  asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
});
// Canonical AND repair-stable (the assembly.test.js validGenotype margins).
function canonicalGenotype() {
  return {
    version: GENOTYPE_VERSION,
    hue: 0.25,
    symmetric: 0.9,
    power: 0.5,
    frameDensity: 0.3,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: NODE_SLOTS }, handNode),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [handAxle(0.2), handAxle(0.8)],
  };
}

const twoMemberPopulation = () => ({
  snapshotVersion: POPULATION_SNAPSHOT_VERSION,
  individuals: [
    { individualId: 3, genotype: canonicalGenotype() },
    { individualId: 9, genotype: canonicalGenotype() },
  ],
});

// Byte offsets in a 2-member snapshot stream: 8-byte header, then per member
// u32 id | u32 genotypeByteLength | payload.
const memberOffset = (bytes, index) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  for (let i = 0; i < index; i += 1) o += 8 + view.getUint32(o + 4, true);
  return o;
};

describe('population snapshot codec', () => {
  test('committed-fixture round trip: fixture-A population decodes leaf-equal and re-serializes byte-equal', () => {
    const { population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const bytes = serializePopulationSnapshot(population);
    const snapshot = bytes.slice();
    const decoded = deserializePopulationSnapshot(bytes);
    expect(decoded.snapshotVersion).toBe(POPULATION_SNAPSHOT_VERSION);
    expect(decoded.individuals.length).toBe(population.individuals.length);
    decoded.individuals.forEach((member, i) => {
      expect(member.individualId).toBe(population.individuals[i].individualId);
      assertBitEqual(member.genotype, population.individuals[i].genotype, `individuals[${i}].genotype`);
    });
    expect(bytesEqual(serializePopulationSnapshot(decoded), bytes)).toBe(true);
    expect(bytes).toEqual(snapshot); // input not mutated
  });

  test('hand-built header decode: versions, count, id, length prefix land at the documented offsets', () => {
    const population = {
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      individuals: [{ individualId: 7, genotype: canonicalGenotype() }],
    };
    const bytes = serializePopulationSnapshot(population);
    const genotypeBytes = serializeGenotype(population.individuals[0].genotype);
    expect(bytes.length).toBe(8 + 8 + genotypeBytes.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(0, true)).toBe(POPULATION_SNAPSHOT_VERSION);
    expect(view.getUint16(2, true)).toBe(GENOTYPE_VERSION);
    expect(view.getUint32(4, true)).toBe(1); // individualCount
    expect(view.getUint32(8, true)).toBe(7); // individualId
    expect(view.getUint32(12, true)).toBe(genotypeBytes.length);
    const decoded = deserializePopulationSnapshot(bytes);
    expect(decoded.individuals[0].individualId).toBe(7);
    assertBitEqual(decoded.individuals[0].genotype, population.individuals[0].genotype);
  });

  test('negatives: duplicate and NON-ASCENDING stream ids are rejected (stream order is canonical)', () => {
    const base = serializePopulationSnapshot(twoMemberPopulation());
    const member1 = memberOffset(base, 1);
    for (const bad of [3, 2]) { // duplicate of member 0; less than member 0
      const tampered = base.slice();
      new DataView(tampered.buffer).setUint32(member1, bad, true);
      expect(() => deserializePopulationSnapshot(tampered), `id ${bad}`).toThrow(
        /population: invalid encoded population at individuals\[1\]\.individualId .*not strictly ascending/,
      );
    }
  });

  test('negatives: a NaN-gene payload surfaces the nested assembly idiom', () => {
    const base = serializePopulationSnapshot(twoMemberPopulation());
    const tampered = base.slice();
    // First gene (hue) of member 0's genotype payload: 8-byte header + 8-byte
    // member prefix + offset 2 into the genotype stream.
    new DataView(tampered.buffer).setFloat64(16 + 2, NaN, true);
    expect(() => deserializePopulationSnapshot(tampered)).toThrow(/assembly: invalid/);
  });

  test('negatives: a lying genotypeByteLength (±1) is caught by the nested exact-length check', () => {
    const base = serializePopulationSnapshot(twoMemberPopulation());
    const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
    const declared = view.getUint32(12, true);
    for (const lie of [declared + 1, declared - 1]) {
      const tampered = base.slice();
      new DataView(tampered.buffer).setUint32(12, lie, true);
      expect(() => deserializePopulationSnapshot(tampered), `length ${lie}`).toThrow(/invalid encoded/);
    }
  });

  test('negatives: truncation mid-genotype, trailing bytes, wrong versions, count lies', () => {
    const base = serializePopulationSnapshot(twoMemberPopulation());
    const genotypeLength = new DataView(base.buffer, base.byteOffset, base.byteLength).getUint32(12, true);
    // Truncated mid-genotype (half of member 0's payload present).
    expect(() => deserializePopulationSnapshot(base.subarray(0, 16 + Math.floor(genotypeLength / 2))))
      .toThrow(/population: invalid encoded population .*truncated/);
    // Trailing byte.
    expect(() => deserializePopulationSnapshot(Uint8Array.from([...base, 0])))
      .toThrow(/population: invalid encoded population .*trailing/);
    // Versions 2/2.
    const badSnapshot = base.slice();
    new DataView(badSnapshot.buffer).setUint16(0, 2, true);
    expect(() => deserializePopulationSnapshot(badSnapshot)).toThrow(/at snapshotVersion/);
    const badGenotype = base.slice();
    new DataView(badGenotype.buffer).setUint16(2, 2, true);
    expect(() => deserializePopulationSnapshot(badGenotype)).toThrow(/at genotypeVersion/);
    // Count lies: 0 (below the >= 1 floor), 1 (trailing member remains), 3 (payload runs out).
    for (const [count, pattern] of [[0, /at individualCount/], [1, /trailing/], [3, /truncated/]]) {
      const tampered = base.slice();
      new DataView(tampered.buffer).setUint32(4, count, true);
      expect(() => deserializePopulationSnapshot(tampered), `count ${count}`).toThrow(pattern);
    }
  });

  test('negatives: a spliced NON-CANONICAL genotype hits the canonicality tooth (no heredity side door)', () => {
    // Seed 20260733: scan for a raw draw that repair moves (the common case).
    let raw = null;
    for (let i = 0; raw === null; i += 1) {
      const candidate = randomGenotype(new Rng(20260733).fork(i));
      if (!bytesEqual(serializeGenotype(candidate), serializeGenotype(repairGenotype(candidate)))) raw = candidate;
    }
    const genotypeBytes = serializeGenotype(raw);
    const view = new DataView(new ArrayBuffer(8 + 8 + genotypeBytes.length));
    let o = 0;
    view.setUint16(o, POPULATION_SNAPSHOT_VERSION, true); o += 2;
    view.setUint16(o, GENOTYPE_VERSION, true); o += 2;
    view.setUint32(o, 1, true); o += 4;
    view.setUint32(o, 5, true); o += 4;
    view.setUint32(o, genotypeBytes.length, true); o += 4;
    const bytes = new Uint8Array(view.buffer);
    bytes.set(genotypeBytes, o);
    expect(() => deserializePopulationSnapshot(bytes)).toThrow(/not canonical/);
  });

  test('hygiene: subarray with nonzero byteOffset decodes its own window', () => {
    const base = serializePopulationSnapshot(twoMemberPopulation());
    const backing = Uint8Array.from([0xaa, ...base, 0xcc]);
    const decoded = deserializePopulationSnapshot(backing.subarray(1, 1 + base.length));
    expect(decoded.individuals.map((m) => m.individualId)).toEqual([3, 9]);
    expect(backing.length).toBe(base.length + 2);
  });
});

describe('initialization manifest codec', () => {
  const MANIFEST_CONFIG = Object.freeze({ seed: 123456, populationSize: 2 });

  test('decode -> fields bit-equal; re-serialize via the 5a declared-state path is byte-identical', () => {
    const initialization = createInitialPopulation(MANIFEST_CONFIG);
    const bytes = serializePopulationInitialization(initialization);
    const snapshot = bytes.slice();
    const decoded = deserializePopulationInitialization(bytes);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.config)).toBe(true);
    expect(decoded.initializerVersion).toBe(POPULATION_INITIALIZER_VERSION);
    expect(decoded.genotypeVersion).toBe(GENOTYPE_VERSION);
    expect(decoded.seed).toBe(123456);
    assertBitEqual(decoded.config, {
      seed: 123456,
      populationSize: 2,
      minAxles: 1,
      maxAxles: 6,
      symmetricProbability: 0.8,
      minInitialPowerGene: 0,
      initialSuspensionTypes: ['S0', 'S1'],
    }, 'config');
    expect(decoded.populationSnapshotDigestState).toBe(
      fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(initialization.population)),
    );
    // The decoded manifest carries NO population: re-serialization binds the
    // DECLARED digest state (the R-E additive input, 5a).
    expect(bytesEqual(serializePopulationInitialization(decoded), bytes)).toBe(true);
    expect(bytes).toEqual(snapshot);
  });

  test('the self-contained-history proof: decoded config re-seeds a byte-identical manifest with a matching snapshot state', () => {
    const initialization = createInitialPopulation(MANIFEST_CONFIG);
    const bytes = serializePopulationInitialization(initialization);
    const decoded = deserializePopulationInitialization(bytes);
    // The decoded config is sufficient provenance: re-running the initializer
    // on it reproduces the population, the manifest bytes, and the digest
    // state the decoded manifest attested — history closes over itself.
    const again = createInitialPopulation(decoded.config);
    expect(bytesEqual(serializePopulationInitialization(again), bytes)).toBe(true);
    expect(fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(again.population)))
      .toBe(decoded.populationSnapshotDigestState);
  });

  test('negatives: versions, S2/dup/out-of-range categories, categoryCount lies, truncation/trailing', () => {
    const base = serializePopulationInitialization(createInitialPopulation(MANIFEST_CONFIG));
    expect(base.length).toBe(37); // the size-2 default manifest
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
    expect(() => deserializePopulationInitialization(patchU16(0, 2))).toThrow(/at initializerVersion/);
    expect(() => deserializePopulationInitialization(patchU16(2, 2))).toThrow(/at genotypeVersion/);
    // Category bytes at offsets 31/32 (S0, S1 by default); categoryCount at 30.
    expect(() => deserializePopulationInitialization(patchU8(31, 2)))
      .toThrow(/initialSuspensionTypes\[0\].*S2/); // resolveConfig's mask tooth
    expect(() => deserializePopulationInitialization(patchU8(32, 0)))
      .toThrow(/duplicate/);
    expect(() => deserializePopulationInitialization(patchU8(31, 3)))
      .toThrow(/population-initializer: invalid encoded initialization at initialSuspensionTypes\[0\] \(3\)/);
    // categoryCount lies: 3 over-reads into the digest (truncation), 1 leaves a trailing byte.
    expect(() => deserializePopulationInitialization(patchU8(30, 3))).toThrow(/population-initializer: invalid/);
    expect(() => deserializePopulationInitialization(patchU8(30, 1))).toThrow(/trailing/);
    expect(() => deserializePopulationInitialization(base.subarray(0, 20))).toThrow(/truncated/);
    expect(() => deserializePopulationInitialization(Uint8Array.from([...base, 0]))).toThrow(/trailing/);
  });

  test('the 5a cross-check: population present + declared state must AGREE, else fail loud', () => {
    const initialization = createInitialPopulation(MANIFEST_CONFIG);
    const state = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(initialization.population));
    const agreed = { ...initialization, populationSnapshotDigestState: state };
    expect(bytesEqual(serializePopulationInitialization(agreed), serializePopulationInitialization(initialization))).toBe(true);
    const disagreed = { ...initialization, populationSnapshotDigestState: (state ^ 1) >>> 0 };
    expect(() => serializePopulationInitialization(disagreed)).toThrow(/disagrees with the digest of initialization\.population/);
  });
});
