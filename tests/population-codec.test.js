// deserializePopulationSnapshot + deserializePopulationInitialization — the
// inverses of the population-content and provenance-manifest encodings.
//
// Both are proven against the COMMITTED fixture-A streams (built without
// physics via populationEvaluationInputsFor), so the decoders are bound to the
// same bytes the cae92db7 / 7acb271d locks hash — without this file
// duplicating either digest literal (population-locks.js stays their owner,
// and tests/population-determinism.test.js asserts them in the same run).
//
// The snapshot decoder deliberately re-runs the FULL validatePopulation gate,
// including the repair-identity canonicality tooth: a hand-crafted snapshot
// carrying a raw draw must not re-enter the population layer as heredity
// through the decode side door.
//
// Seeds: 20260721/20260722 (fixture A), 123456 (the manifest test's declared
// literal seed, reused from tests/population-initializer.test.js).

import { describe, test, expect } from 'vitest';
import {
  POPULATION_SNAPSHOT_VERSION, bytesEqual, deserializePopulationSnapshot,
  serializePopulationSnapshot,
} from '../src/sim/population.js';
import {
  POPULATION_INITIALIZER_VERSION, createInitialPopulation,
  deserializePopulationInitialization, serializePopulationInitialization,
} from '../src/sim/population-initializer.js';
import {
  GENOTYPE_VERSION, randomGenotype, repairGenotype, serializeGenotype,
} from '../src/sim/assembly.js';
import { Rng } from '../src/sim/prng.js';
import { POPULATION_FIXTURE_A, populationEvaluationInputsFor } from '../src/sim/population-fixtures.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from '../src/sim/fnv1a.js';

// Object.is at leaves + exact key sets (the trace.js T8 comparator).
function assertBitEqual(actual, expected, path = '') {
  if (typeof expected === 'number') {
    expect(Object.is(actual, expected), `${path}: ${String(actual)} !== ${String(expected)}`).toBe(true);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} is not an array`).toBe(true);
    expect(actual.length, `${path}.length`).toBe(expected.length);
    expected.forEach((v, i) => assertBitEqual(actual[i], v, `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    expect(Object.keys(actual).sort(), `${path} key set`).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) assertBitEqual(actual[k], expected[k], path === '' ? k : `${path}.${k}`);
    return;
  }
  expect(actual, path).toBe(expected);
}

// Repair-stable declared genotype (copy-declared from tests/population.test.js).
function canonicalGenotype(hue = 0.25) {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue, symmetric: 0.9, power: 0.5, frameDensity: 0.3,
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

// A genotype repair MOVES (radius gene 0 -> below the R2 clearance bound).
function nonCanonicalGenotype() {
  const g = canonicalGenotype();
  g.axles[0].radius = 0;
  return g;
}

const pop = (individuals) => ({ snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals });
const twoMemberPopulation = () => pop([
  { individualId: 3, genotype: canonicalGenotype(0.25) },
  { individualId: 9, genotype: canonicalGenotype(0.75) },
]);

describe('population snapshot — round trips', () => {
  test('the committed fixture-A snapshot decodes and re-encodes byte-identically', () => {
    const { population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const bytes = serializePopulationSnapshot(population);
    const decoded = deserializePopulationSnapshot(bytes);
    expect(decoded.snapshotVersion).toBe(POPULATION_SNAPSHOT_VERSION);
    expect(decoded.individuals).toHaveLength(20);
    expect(decoded.individuals.map((i) => i.individualId)).toEqual([...Array(20).keys()]);
    // Canonical (ascending) order and exact genotypes.
    const canonical = [...population.individuals].sort((a, b) => a.individualId - b.individualId);
    canonical.forEach((ind, i) => {
      expect(decoded.individuals[i].individualId).toBe(ind.individualId);
      assertBitEqual(decoded.individuals[i].genotype, ind.genotype, `individuals[${i}].genotype`);
    });
    expect(bytesEqual(serializePopulationSnapshot(decoded), bytes)).toBe(true);
  });

  test('a shuffled source population canonicalizes to the same bytes and decodes identically', () => {
    const ordered = twoMemberPopulation();
    const shuffled = pop([...ordered.individuals].reverse());
    const a = serializePopulationSnapshot(ordered);
    const b = serializePopulationSnapshot(shuffled);
    expect(bytesEqual(a, b)).toBe(true);
    assertBitEqual(deserializePopulationSnapshot(b), deserializePopulationSnapshot(a), 'shuffled');
  });

  test('the hand-built header walk decodes to its declared fields', () => {
    // Hand-built bytes (never the encoder twice): the documented walk for one
    // individual at id 4.
    const genotypeBytes = serializeGenotype(canonicalGenotype(0.5));
    const view = new DataView(new ArrayBuffer(2 + 2 + 4 + 4 + 4 + genotypeBytes.length));
    const out = new Uint8Array(view.buffer);
    view.setUint16(0, POPULATION_SNAPSHOT_VERSION, true);
    view.setUint16(2, GENOTYPE_VERSION, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, 4, true);
    view.setUint32(12, genotypeBytes.length, true);
    out.set(genotypeBytes, 16);
    const decoded = deserializePopulationSnapshot(out);
    expect(decoded.individuals).toHaveLength(1);
    expect(decoded.individuals[0].individualId).toBe(4);
    assertBitEqual(decoded.individuals[0].genotype, canonicalGenotype(0.5), 'hand-built');
    expect(bytesEqual(serializePopulationSnapshot(decoded), out)).toBe(true);
  });
});

describe('population snapshot — the validated members ARE the encoded members', () => {
  // validatePopulation checks members BY INDEX and used to hand back
  // `[...individuals]`, an ITERATOR read. A caller-supplied Array carrying an
  // overridden Symbol.iterator was therefore validated as one population and
  // encoded as another, defeating the canonicality tooth: the indices held
  // repaired genotypes, the iterator yielded a RAW draw, and the snapshot
  // attested the raw draw.
  const canonical = (fork) => repairGenotype(randomGenotype(new Rng(20260710).fork(fork)));

  test('a tampered Symbol.iterator cannot substitute members past validation', () => {
    const raw = randomGenotype(new Rng(20260710).fork(3));
    const canonA = repairGenotype(raw);
    // The premise: this raw draw really is non-canonical, so encoding it is a
    // detectable violation and not a vacuous pass.
    expect(bytesEqual(serializeGenotype(raw), serializeGenotype(canonA))).toBe(false);

    const individuals = [{ individualId: 0, genotype: canonA }, { individualId: 1, genotype: canonical(4) }];
    individuals[Symbol.iterator] = function* lie() {
      yield { individualId: 0, genotype: raw };
      yield individuals[1];
    };
    expect(Array.isArray(individuals)).toBe(true);

    const bytes = serializePopulationSnapshot(pop(individuals));
    // The stream must carry what was VALIDATED (the indices), not what the
    // iterator yielded — byte-identical to the untampered population.
    const honest = [{ individualId: 0, genotype: canonA }, { individualId: 1, genotype: canonical(4) }];
    expect(bytesEqual(bytes, serializePopulationSnapshot(pop(honest)))).toBe(true);
    // And it round-trips, which the raw-carrying stream could not: the decoder
    // re-runs validatePopulation, so encoding the raw draw produced bytes the
    // codec itself refuses — a producible, undecodable stream.
    const back = deserializePopulationSnapshot(bytes);
    expect(bytesEqual(serializeGenotype(back.individuals[0].genotype), serializeGenotype(canonA))).toBe(true);
  });

  test('the snapshot attests the tooth-checked bytes — a sibling cannot mutate a validated member', () => {
    // The deepest instance of the class: sibling B's axles carried an own
    // `map` that, when invoked by the canonicality tooth's repairGenotype →
    // cloneGenotype, swapped ALREADY-VALIDATED sibling A's genotype for a raw
    // draw. Pre-fix the snapshot then embedded the raw draw (its own decoder
    // rejected the bytes — a producible, undecodable stream whose digest
    // attested a population never approved). Two independent fixes both close
    // it, and this tooth holds if EITHER stands: cloneGenotype no longer
    // invokes caller methods, and the encoder now emits the exact bytes the
    // tooth checked rather than re-reading ind.genotype afterwards.
    const rawDraw = randomGenotype(new Rng(20260710).fork(3));
    const A = { individualId: 0, genotype: canonical(3) };
    const B = { individualId: 1, genotype: canonical(4) };
    B.genotype.axles = [...B.genotype.axles];
    B.genotype.axles.map = function evil(fn) {
      A.genotype = rawDraw;
      return Array.prototype.map.call(this, fn);
    };
    const bytes = serializePopulationSnapshot(pop([A, B]));
    const honest = serializePopulationSnapshot(pop([
      { individualId: 0, genotype: canonical(3) },
      { individualId: 1, genotype: canonical(4) },
    ]));
    expect(bytesEqual(bytes, honest)).toBe(true);
    const back = deserializePopulationSnapshot(bytes); // decodes — no asymmetry
    expect(bytesEqual(
      serializeGenotype(back.individuals[0].genotype),
      serializeGenotype(canonical(3)),
    )).toBe(true);
  });

  test('a tampered iterator cannot smuggle duplicate or unordered ids either', () => {
    const individuals = [{ individualId: 0, genotype: canonical(3) }, { individualId: 1, genotype: canonical(4) }];
    individuals[Symbol.iterator] = function* lie() {
      yield individuals[1];
      yield individuals[1]; // a duplicate id the indexed validation never saw
    };
    const back = deserializePopulationSnapshot(serializePopulationSnapshot(pop(individuals)));
    expect(back.individuals.map((i) => i.individualId)).toEqual([0, 1]);
  });
});

describe('population snapshot — malformed streams fail loud', () => {
  const base = () => serializePopulationSnapshot(twoMemberPopulation());
  const memberLength = () => serializeGenotype(canonicalGenotype()).length;

  test('duplicate individual ids', () => {
    const bytes = base();
    // Second member's id sits after the header (8) + first id/len (8) + payload.
    const view = new DataView(bytes.buffer);
    view.setUint32(8 + 8 + memberLength(), 3, true); // both members now id 3
    expect(() => deserializePopulationSnapshot(bytes))
      .toThrow(/must be strictly ascending \(previous 3\)/);
  });

  test('non-ascending ids in the stream (a decoder that re-sorted would break byte identity)', () => {
    const bytes = base();
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 9, true); // first id 9 ...
    view.setUint32(8 + 8 + memberLength(), 3, true); // ... second id 3
    expect(() => deserializePopulationSnapshot(bytes))
      .toThrow(/individuals\[1\]\.individualId \(3 must be strictly ascending \(previous 9\)\)/);
  });

  test('a malformed genotype payload (NaN gene) inside a member', () => {
    const bytes = base();
    new DataView(bytes.buffer).setFloat64(16 + 2, NaN, true); // first genotype's hue
    expect(() => deserializePopulationSnapshot(bytes)).toThrow(/assembly: invalid genotype at hue/);
  });

  test('a lying genotype length prefix', () => {
    for (const delta of [1, -1, 8]) {
      const bytes = base();
      new DataView(bytes.buffer).setUint32(12, memberLength() + delta, true);
      expect(() => deserializePopulationSnapshot(bytes), `delta ${delta}`)
        .toThrow(/population: invalid encoded population|assembly: invalid encoded genotype/);
    }
  });

  test('a truncated member and trailing bytes', () => {
    const full = base();
    for (const cut of [0, 4, 8, 16, 16 + memberLength(), full.length - 1]) {
      expect(() => deserializePopulationSnapshot(full.slice(0, cut)), `cut ${cut}`)
        .toThrow(/population: invalid encoded population|assembly: invalid encoded genotype/);
    }
    const extended = new Uint8Array(full.length + 1);
    extended.set(full);
    expect(() => deserializePopulationSnapshot(extended))
      .toThrow(/population: invalid encoded population at individuals \(1 trailing byte\(s\)/);
  });

  test('a version mismatch in either header field', () => {
    const a = base();
    new DataView(a.buffer).setUint16(0, 2, true);
    expect(() => deserializePopulationSnapshot(a)).toThrow(/at snapshotVersion \(2\)/);
    const b = base();
    new DataView(b.buffer).setUint16(2, 2, true);
    expect(() => deserializePopulationSnapshot(b)).toThrow(/at genotypeVersion \(2\)/);
  });

  test('a count that disagrees with the payload (zero, too many, too few)', () => {
    for (const count of [0, 1, 3]) {
      const bytes = base();
      new DataView(bytes.buffer).setUint32(4, count, true);
      expect(() => deserializePopulationSnapshot(bytes), `count ${count}`)
        .toThrow(/population: invalid encoded population/);
    }
  });

  test('a spliced NON-CANONICAL genotype is refused (no raw-draw side door)', () => {
    const raw = serializeGenotype(nonCanonicalGenotype());
    const view = new DataView(new ArrayBuffer(2 + 2 + 4 + 4 + 4 + raw.length));
    const out = new Uint8Array(view.buffer);
    view.setUint16(0, POPULATION_SNAPSHOT_VERSION, true);
    view.setUint16(2, GENOTYPE_VERSION, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, 0, true);
    view.setUint32(12, raw.length, true);
    out.set(raw, 16);
    expect(() => deserializePopulationSnapshot(out)).toThrow(/is not canonical — repair moved it/);
  });

  test('a non-Uint8Array input', () => {
    for (const bad of [null, [1, 2], 'bytes']) {
      expect(() => deserializePopulationSnapshot(bad)).toThrow(/population: invalid encoded population at bytes/);
    }
  });
});

describe('population snapshot — decoder hygiene', () => {
  test('the input bytes are never mutated', () => {
    const bytes = base_();
    const before = Uint8Array.from(bytes);
    deserializePopulationSnapshot(bytes);
    expect(bytesEqual(bytes, before)).toBe(true);
  });

  function base_() { return serializePopulationSnapshot(twoMemberPopulation()); }

  test('a subarray view decodes its own window', () => {
    const bytes = base_();
    const parent = new Uint8Array(32 + bytes.length + 16).fill(0xab);
    parent.set(bytes, 32);
    const decoded = deserializePopulationSnapshot(parent.subarray(32, 32 + bytes.length));
    expect(decoded.individuals.map((i) => i.individualId)).toEqual([3, 9]);
  });
});

describe('initialization manifest — round trips', () => {
  test('the committed fixture-A manifest decodes and re-encodes byte-identically', () => {
    const { initialization } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const bytes = serializePopulationInitialization(initialization);
    const decoded = deserializePopulationInitialization(bytes);
    expect(decoded.initializerVersion).toBe(POPULATION_INITIALIZER_VERSION);
    expect(decoded.genotypeVersion).toBe(GENOTYPE_VERSION);
    expect(decoded.seed).toBe(POPULATION_FIXTURE_A.populationSeed);
    expect(decoded.config.populationSize).toBe(20);
    expect(decoded.config.minAxles).toBe(1);
    expect(decoded.config.maxAxles).toBe(6);
    expect(decoded.config.symmetricProbability).toBe(0.8);
    expect(decoded.config.minInitialPowerGene).toBe(0);
    expect([...decoded.config.initialSuspensionTypes]).toEqual(['S0', 'S1']);
    expect(decoded.populationSnapshotDigestState).toBe(
      fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(initialization.population)),
    );
    // Re-encode through the digest-state input path.
    expect(bytesEqual(serializePopulationInitialization(decoded), bytes)).toBe(true);
  });

  test('the declared small manifest (seed 123456, size 2) round-trips', () => {
    const init = createInitialPopulation({ seed: 123456, populationSize: 2 });
    const bytes = serializePopulationInitialization(init);
    expect(bytes.length).toBe(2 + 2 + 4 + 4 + 1 + 1 + 8 + 8 + 1 + 2 + 4);
    const decoded = deserializePopulationInitialization(bytes);
    expect(decoded.seed).toBe(123456);
    expect(decoded.config.populationSize).toBe(2);
    expect(bytesEqual(serializePopulationInitialization(decoded), bytes)).toBe(true);
  });

  test('SELF-CONTAINED HISTORY: the decoded config reproduces the population it attests to', () => {
    // The manifest binds content by DIGEST, not by value. This is the proof
    // that the binding is sufficient: re-running the initializer from the
    // decoded config alone reproduces the exact population, and its snapshot
    // digest state matches the attestation.
    //
    // THE HONEST-PRODUCER HALF OF A PAIR. This body only ever exercises
    // manifests createInitialPopulation itself produced, so on its own it
    // reads as a universal property of the FORMAT when it is a property of
    // one PRODUCER. The dishonest-producer half — a manifest whose population
    // came from a different seed than its config declares — lives in
    // "initialization manifest — the provenance claim is UNVERIFIED" below,
    // and shows the format accepts it.
    const original = createInitialPopulation({ seed: 123456, populationSize: 4 });
    const bytes = serializePopulationInitialization(original);
    const decoded = deserializePopulationInitialization(bytes);
    const rebuilt = createInitialPopulation({ ...decoded.config, seed: decoded.seed });
    expect(fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(rebuilt.population)))
      .toBe(decoded.populationSnapshotDigestState);
    expect(bytesEqual(serializePopulationInitialization(rebuilt), bytes)).toBe(true);
  });

  test('the encoder cross-checks a declared digest state against a supplied population', () => {
    const init = createInitialPopulation({ seed: 123456, populationSize: 2 });
    const state = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(init.population));
    // Agreeing: identical bytes to the population-only path.
    expect(bytesEqual(
      serializePopulationInitialization({ ...init, populationSnapshotDigestState: state }),
      serializePopulationInitialization(init),
    )).toBe(true);
    // Disagreeing: refused — a manifest can never attest to content it contradicts.
    expect(() => serializePopulationInitialization({ ...init, populationSnapshotDigestState: (state ^ 1) >>> 0 }))
      .toThrow(/populationSnapshotDigestState.*disagrees with the population's computed state/);
  });

  test('a tampered category iterator cannot desynchronize the count from the payload', () => {
    // Same systemic class as the spec's ranges: the u8 categoryCount and the
    // encoded categories both come from resolving cats BY INDEX before
    // allocation, so an overridden Symbol.iterator is irrelevant — the real
    // categories are encoded regardless of what the iterator would yield.
    const init = createInitialPopulation({ seed: 123456, populationSize: 2 });
    const cats = ['S0', 'S1'];
    cats[Symbol.iterator] = function* short() { yield 'S0'; };
    const bytes = serializePopulationInitialization({
      ...init,
      config: { ...init.config, initialSuspensionTypes: cats },
    });
    const decoded = deserializePopulationInitialization(bytes);
    expect([...decoded.config.initialSuspensionTypes]).toEqual(['S0', 'S1']);
    expect(bytesEqual(serializePopulationInitialization(decoded), bytes)).toBe(true);
  });

  test('caller-owned category methods are never consulted and holes are refused', () => {
    // resolvePolicy used cats.forEach + cats.indexOf — caller-owned methods
    // on a genuine Array. An own no-op forEach let 'S2' past the mask and an
    // own indexOf defeated the duplicate check, each producing a manifest the
    // decoder then REJECTED (encode/decode asymmetry); a sparse array's hole
    // was skipped by forEach and reached sampleInitialGenotype as a SILENT
    // out-of-domain suspType gene. The indexed walk + module-owned Set close
    // all three.
    const s2 = ['S2'];
    s2.forEach = () => {};
    expect(() => createInitialPopulation({ seed: 1, populationSize: 2, initialSuspensionTypes: s2 }))
      .toThrow(/initialSuspensionTypes\[0\] \(S2/);

    const dup = ['S0', 'S0'];
    let calls = 0;
    dup.indexOf = () => calls++; // answers 0 then 1 — never !== i
    expect(() => createInitialPopulation({ seed: 1, populationSize: 2, initialSuspensionTypes: dup }))
      .toThrow(/initialSuspensionTypes\[1\] \(duplicate S0\)/);

    const sparse = ['S0'];
    sparse.length = 2;
    expect(() => createInitialPopulation({ seed: 1, populationSize: 2, initialSuspensionTypes: sparse }))
      .toThrow(/initialSuspensionTypes\[1\] \(undefined/);
  });

  test('the returned config OWNS its category list — caller mutation cannot rewrite provenance', () => {
    // createInitialPopulation froze its config object, but a shallow freeze
    // left the caller holding a live alias to the array inside: mutating it
    // after generation changed what the manifest ENCODED while the digest
    // still attested the population the ORIGINAL categories produced — a
    // manifest whose decoded config rebuilds a DIFFERENT population
    // (self-contained history broken by a plain array write).
    const categories = ['S0'];
    const init = createInitialPopulation({ seed: 123456, populationSize: 3, initialSuspensionTypes: categories });
    categories[0] = 'S1';
    expect([...init.config.initialSuspensionTypes]).toEqual(['S0']);
    expect(Object.isFrozen(init.config.initialSuspensionTypes)).toBe(true);
    // The self-contained-history proof survives the mutation: decoded config
    // rebuilds the exact population the digest attests.
    const decoded = deserializePopulationInitialization(serializePopulationInitialization(init));
    const rebuilt = createInitialPopulation({ seed: decoded.seed, ...decoded.config });
    const state = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(rebuilt.population));
    expect(decoded.populationSnapshotDigestState).toBe(state);
  });

  test('an explicit keepRaw: null fails loud like every other non-boolean', () => {
    // `options.keepRaw ?? false` silently coerced null past the typeof gate —
    // the one value class that slipped the fail-loud idiom.
    expect(() => createInitialPopulation({ seed: 1, populationSize: 2 }, { keepRaw: null }))
      .toThrow(/options\.keepRaw \(null\)/);
    // Absent still defaults, true still keeps.
    const kept = createInitialPopulation({ seed: 1, populationSize: 2 }, { keepRaw: true });
    expect(kept.diagnostics.every((d) => Object.hasOwn(d, 'rawGenotype'))).toBe(true);
  });

  test('a populationSize beyond the u32 wire bound fails loud on the digest-only path', () => {
    // The population path bounds this implicitly (no array can match such a
    // length), but the digest-only path has no population to compare against:
    // without the guard, 0x100000001 wraps to 1 on the wire and the manifest
    // decodes into a config that REBUILDS a different population while still
    // carrying the original's digest state.
    const init = createInitialPopulation({ seed: 123456, populationSize: 2 });
    const digestOnly = {
      initializerVersion: init.initializerVersion,
      seed: init.seed,
      config: { ...init.config, populationSize: 0x100000001 },
      populationSnapshotDigestState: 0xdeadbeef,
    };
    expect(() => serializePopulationInitialization(digestOnly))
      .toThrow(/populationSize \(4294967297 exceeds the u32 wire bound/);
    // A legal size on the same path still encodes and round-trips.
    const legal = { ...digestOnly, config: { ...init.config, populationSize: 2 } };
    const bytes = serializePopulationInitialization(legal);
    expect(deserializePopulationInitialization(bytes).config.populationSize).toBe(2);
  });

  test('neither population nor digest state fails loud', () => {
    const withoutPopulation = { ...createInitialPopulation({ seed: 123456, populationSize: 2 }) };
    delete withoutPopulation.population;
    expect(() => serializePopulationInitialization(withoutPopulation))
      .toThrow(/population-initializer: invalid config at initialization.populationSnapshotDigestState/);
  });
});

describe('initialization manifest — malformed streams fail loud', () => {
  const base = () => serializePopulationInitialization(createInitialPopulation({ seed: 123456, populationSize: 2 }));
  // The declared 37-byte walk: initializerVersion u16 @0, genotypeVersion u16
  // @2, seed u32 @4, populationSize u32 @8, minAxles u8 @12, maxAxles u8 @13,
  // symmetricProbability f64 @14, minInitialPowerGene f64 @22, categoryCount
  // u8 @30, categories u8 @31..32, snapshotDigestState u32 @33.
  const OFF = Object.freeze({
    minAxles: 12, maxAxles: 13, symmetricProbability: 14,
    minInitialPowerGene: 22, categoryCount: 30, categories: 31,
  });

  test('version mismatches', () => {
    const a = base();
    new DataView(a.buffer).setUint16(0, 2, true);
    expect(() => deserializePopulationInitialization(a)).toThrow(/at initializerVersion \(2\)/);
    const b = base();
    new DataView(b.buffer).setUint16(2, 2, true);
    expect(() => deserializePopulationInitialization(b)).toThrow(/at genotypeVersion \(2\)/);
  });

  test('an out-of-range suspension category index', () => {
    const bytes = base();
    new DataView(bytes.buffer).setUint8(OFF.categories, 3);
    expect(() => deserializePopulationInitialization(bytes))
      .toThrow(/at initialSuspensionTypes\[0\] \(3\)/);
  });

  test('an S2 category (legal index, illegal initializer policy) is refused by resolveConfig', () => {
    const bytes = base();
    new DataView(bytes.buffer).setUint8(OFF.categories, 2); // 'S2'
    expect(() => deserializePopulationInitialization(bytes))
      .toThrow(/initialSuspensionTypes\[0\].*S2 — initial seeding masks to S0\/S1/);
  });

  test('duplicate categories', () => {
    const bytes = base();
    new DataView(bytes.buffer).setUint8(OFF.categories + 1, 0); // second category = 'S0' too
    expect(() => deserializePopulationInitialization(bytes))
      .toThrow(/initialSuspensionTypes\[1\].*duplicate S0/);
  });

  test('a lying category count', () => {
    for (const count of [1, 3]) {
      const bytes = base();
      new DataView(bytes.buffer).setUint8(OFF.categoryCount, count);
      expect(() => deserializePopulationInitialization(bytes), `count ${count}`)
        .toThrow(/population-initializer: invalid encoded initialization/);
    }
  });

  test('an out-of-domain config field (non-probability, bad axle bounds)', () => {
    const p = base();
    new DataView(p.buffer).setFloat64(OFF.symmetricProbability, 1.5, true);
    expect(() => deserializePopulationInitialization(p)).toThrow(/invalid config at symmetricProbability/);
    const a = base();
    new DataView(a.buffer).setUint8(OFF.minAxles, 0);
    expect(() => deserializePopulationInitialization(a)).toThrow(/invalid config at minAxles/);
    const m = base();
    new DataView(m.buffer).setUint8(OFF.maxAxles, 7); // above the compiler cap
    expect(() => deserializePopulationInitialization(m)).toThrow(/invalid config at maxAxles/);
  });

  test('a non-finite f64 field', () => {
    const bytes = base();
    new DataView(bytes.buffer).setFloat64(OFF.minInitialPowerGene, NaN, true);
    expect(() => deserializePopulationInitialization(bytes))
      .toThrow(/at minInitialPowerGene \(NaN\)/);
  });

  test('truncation and trailing bytes', () => {
    const full = base();
    for (const cut of [0, 2, 12, 28, full.length - 1]) {
      expect(() => deserializePopulationInitialization(full.slice(0, cut)), `cut ${cut}`)
        .toThrow(/population-initializer: invalid encoded initialization/);
    }
    const extended = new Uint8Array(full.length + 1);
    extended.set(full);
    expect(() => deserializePopulationInitialization(extended))
      .toThrow(/at initialization \(1 trailing byte\(s\)/);
  });

  test('the decoded manifest is frozen and the input is not mutated', () => {
    const bytes = base();
    const before = Uint8Array.from(bytes);
    const decoded = deserializePopulationInitialization(bytes);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.config)).toBe(true);
    expect(bytesEqual(bytes, before)).toBe(true);
  });
});

describe('initialization manifest — the provenance claim is UNVERIFIED (the deliberate boundary)', () => {
  // The dishonest-producer half of the pair whose other half is
  // "SELF-CONTAINED HISTORY: the decoded config reproduces the population it
  // attests to". That test only ever feeds itself manifests
  // createInitialPopulation produced, and anything named as a proof and never
  // attacked is decoration — so this block attacks it.
  //
  // MEASURED ON HEAD, and this is the finding: a manifest whose `population`
  // came from seed A while its `seed`/`config.seed` say B encodes, decodes,
  // and re-encodes byte-identically. The encoder's ONLY content check is
  // resolvePopulationDigestState's LENGTH cross-check (size, never identity),
  // so the record is an UNVERIFIED PROVENANCE CLAIM (seed + config) sitting
  // beside a VERIFIED CONTENT DIGEST (the snapshot state). The digest attests
  // exactly WHICH population existed; nothing attests that the declared seed
  // is what produced it.
  //
  // Pinned deliberately as the boundary, not as a defect. If a later PR adds
  // an encoder-side cross-check (rebuild from cfg, fold, compare), THIS TEST
  // FAILS and tells you to move the assertion — instead of the alternative,
  // where the honest-producer test alone stays green for an entirely
  // different reason and the change in contract goes unrecorded.

  const SEED_A = 123456; // the population's TRUE seed (the file's declared literal)
  const SEED_B = 654321; // the seed the forged manifest CLAIMS

  const snapshotState = (population) => fnv1aFold(
    FNV_OFFSET_BASIS, serializePopulationSnapshot(population),
  );

  test('a manifest whose population came from a DIFFERENT seed than its config encodes and round-trips', () => {
    const fromA = createInitialPopulation({ seed: SEED_A, populationSize: 3 });
    const fromB = createInitialPopulation({ seed: SEED_B, populationSize: 3 });
    const stateA = snapshotState(fromA.population);
    const stateB = snapshotState(fromB.population);
    // The premise: the two seeds really do produce different populations, so
    // the mismatch below is detectable and this is not a vacuous pass.
    expect(stateA).not.toBe(stateB);

    const forged = {
      initializerVersion: fromA.initializerVersion,
      seed: SEED_B,
      config: { ...fromA.config, seed: SEED_B },
      population: fromA.population, // seed-A CONTENT under a seed-B claim
    };
    // No complaint anywhere on the codec path.
    const bytes = serializePopulationInitialization(forged);
    const decoded = deserializePopulationInitialization(bytes);
    expect(decoded.seed).toBe(SEED_B);
    expect(decoded.populationSnapshotDigestState).toBe(stateA);
    expect(bytesEqual(serializePopulationInitialization(decoded), bytes)).toBe(true);

    // The self-contained-history property FAILS on these bytes, and THAT is
    // the boundary: rebuilding from the decoded config reproduces seed B's
    // population, whose digest state is not the one the manifest carries.
    const rebuilt = createInitialPopulation({ ...decoded.config, seed: decoded.seed });
    expect(snapshotState(rebuilt.population)).not.toBe(decoded.populationSnapshotDigestState);
    expect(snapshotState(rebuilt.population)).toBe(stateB); // it rebuilt seed B, exactly as asked
  });

  test('the honest producer still reproduces its population (the two legs side by side)', () => {
    const honest = createInitialPopulation({ seed: SEED_B, populationSize: 3 });
    const decoded = deserializePopulationInitialization(serializePopulationInitialization(honest));
    expect(decoded.seed).toBe(SEED_B);
    const rebuilt = createInitialPopulation({ ...decoded.config, seed: decoded.seed });
    expect(snapshotState(rebuilt.population)).toBe(decoded.populationSnapshotDigestState);
  });

  test('the ONE content check the manifest does make: a population/populationSize disagreement is refused', () => {
    // The boundary is not "no checks at all" — resolvePopulationDigestState
    // cross-checks the supplied population's SIZE against config.populationSize.
    // That is the whole of it, and naming it here keeps the asymmetry legible:
    // size is verified, identity is not.
    const fromA = createInitialPopulation({ seed: SEED_A, populationSize: 3 });
    const forged = {
      initializerVersion: fromA.initializerVersion,
      seed: SEED_A,
      config: { ...fromA.config, populationSize: 4 },
      population: fromA.population,
    };
    expect(() => serializePopulationInitialization(forged))
      .toThrow(/population\.individuals\.length \(3 !== populationSize 4/);
  });
});
