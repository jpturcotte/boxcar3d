// The codec round-trip PROPERTY harness — the seeded, boundary-biased search
// for the value-combination class no hand-written case reaches.
//
// WHY THIS FILE EXISTS. Every confirmed codec defect so far was triggered by
// ONE distinguished value at ONE leaf, and every one of them was found by hand:
// a -0 uint32 that setUint32 silently normalized; a `length: 2` own property
// shadowing the intrinsic accessor; an own `Symbol.iterator` disagreeing with
// the indices; a species-aware `subarray` returning a foreign array. The fixes
// landed and prose rules were written, but NOTHING in the method would have
// produced the NEXT distinguished value — and nothing tested combinations of
// them. This harness asserts the two RULES the whole codec family claims, on
// VALUES, over an adversarially-weighted input distribution:
//
//   R1  serialize(deserialize(serialize(x)))  is BYTE-identical to serialize(x)
//   R2  deserialize(serialize(x))             is LEAF-equal to x under Object.is
//   R3  deserialize never throws on its own encoder's output
//
// R2 is the one that catches silent normalization (a decoder that erases a
// sign bit still satisfies R1 forever, because the normalized value re-encodes
// to the same bytes); R1 is the one that catches a decoder reading a different
// window than the encoder wrote. Both are needed; neither implies the other.
//
// SAMPLING. Uniform random leaves would essentially never produce -0,
// Number.MIN_VALUE, the u32 ceiling, or an empty range. Each sample therefore
// starts from an ordinary record and then OVERWRITES two or three leaves with
// values drawn from a per-kind boundary set (the full cross-product is
// combinatorially hopeless — pairs and triples are where interaction bugs
// live). Structural counts (axle count, member count, range length) are drawn
// from their own {0, 1, 2, max} set.
//
// THE PREMISE TOOTH. Each pair's test also tallies which boundary values its
// stream actually produced and asserts the DECLARED coverage set was reached.
// Without it this whole file could go green while sampling nothing
// distinguished at all — a harness whose premise is never asserted proves
// exactly as much as no harness (the witness-premise rule).
//
// Seed: 20260733 (NEWLY ALLOCATED for this harness; one fork per encoder pair,
// so the five distributions are independent of each other and of sample order
// — ruling D7). N = 200 samples per pair, 5 pairs = 1,000 samples.
//
// NOT in scope here: malformed / hostile / hand-corrupted streams. Those are
// the five *-codec.test.js files' job. This file only ever feeds a decoder its
// own encoder's output — which is exactly why an R3 failure is always a real
// defect and never a bad input.

import { describe, test, expect } from 'vitest';
import { Rng } from '../src/sim/prng.js';
import {
  GENOTYPE_VERSION, deserializeGenotype, repairGenotype, serializeGenotype,
} from '../src/sim/assembly.js';
import {
  POPULATION_SNAPSHOT_VERSION, bytesEqual, deserializePopulationSnapshot,
  serializePopulationSnapshot,
} from '../src/sim/population.js';
import {
  POPULATION_INITIALIZER_VERSION, deserializePopulationInitialization,
  serializePopulationInitialization,
} from '../src/sim/population-initializer.js';
import {
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION, FITNESS_VECTOR_VERSION,
  deserializeEvaluationSpec, deserializeFitnessVector,
  serializeEvaluationSpec, serializeFitnessVector,
} from '../src/sim/population-evaluation.js';
import { INTEGRITY_POLICY_VERSION, INTEGRITY_STATUS } from '../src/sim/integrity.js';
import { TERRAIN_DEFAULTS } from '../src/sim/terrain.js';

const SEED = 20260733;
const N = 200; // samples per encoder/decoder pair

// One fork per pair: a pair's distribution never depends on how many draws
// another pair consumed (the population-initializer stream ruling).
const STREAM = Object.freeze({
  genotype: 1, snapshot: 2, manifest: 3, spec: 4, fitnessVector: 5,
});

// --- Boundary sets (copy-declared literals) ----------------------------------

// f64 GENE leaves: the [0,1] domain checkGene enforces, at both ends, at the
// smallest denormal, at the smallest normal, and one ULP below 1. `-0` is a
// LEGAL gene (-0 >= 0 and -0 <= 1 both hold) whose sign bit setFloat64
// preserves — so it is exactly the value that separates a lossless decoder
// from a normalizing one.
const GENE_BOUNDARIES = Object.freeze([
  0, -0, 1, Number.MIN_VALUE, 2 ** -1022, 1 - Number.EPSILON / 2,
]);

// f64 WIRE leaves that are not genes (terrain scalars, spawn coordinates,
// friction, speeds): the encoders gate these on Number.isFinite only, so the
// domain reaches both signs and the representable extremes.
const WIRE_F64_BOUNDARIES = Object.freeze([
  0, -0, 1, -1, Number.MIN_VALUE, -Number.MIN_VALUE, 2 ** -1022,
  1 - Number.EPSILON / 2, Number.MAX_VALUE, -Number.MAX_VALUE,
]);

// u32 WIRE leaves. `-0` is deliberately ABSENT: isCanonicalUint32 now rejects
// it (setUint32 erases the sign bit, so accepting it broke R2), and the
// separate refusal suite at the bottom of this file asserts that rejection at
// every u32 seam.
const U32_BOUNDARIES = Object.freeze([0, 1, 2, 0xfffffffe, 0xffffffff]);
// The same set for fields whose domain excludes 0 (maxSteps, populationSize).
const U32_POSITIVE_BOUNDARIES = Object.freeze([1, 2, 0xfffffffe, 0xffffffff]);

// Fitness is finite and non-negative; -0 is legal and round-trips bit-exactly
// (the isCanonicalFitness ruling — deliberately asymmetric with u32).
const FITNESS_BOUNDARIES = Object.freeze([
  0, -0, 1, Number.MIN_VALUE, 2 ** -1022, 1 - Number.EPSILON / 2, Number.MAX_VALUE,
]);

const AXLE_COUNTS = Object.freeze([0, 1, 2, 6]); // {0, 1, 2, max} — v1 caps at 6
const MEMBER_COUNTS = Object.freeze([1, 2, 3]); // 0 is rejected by every count gate
const RANGE_LENGTHS = Object.freeze([0, 1, 2, 255]); // {0, 1, 2, max} — the u8 wire bound
const CATEGORY_SETS = Object.freeze([['S0'], ['S1'], ['S0', 'S1'], ['S1', 'S0']]);

// Copy-declared gene key tables (assembly.js owns the production constants;
// deriving these from them would let a schema change move both sides together).
const NODE_GENES = Object.freeze(['gap', 'height', 'halfWidth', 'thickness']);
const AXLE_GENES = Object.freeze([
  'posX01', 'paired', 'trackHalf', 'radius', 'width', 'density',
  'suspType', 'stiffness', 'damping', 'travel', 'restLength', 'driven', 'share',
]);
const ASYM_GENES = Object.freeze(['driveBias', 'sizeBias', 'centerOffset']);
const NODE_SLOT_COUNT = 6;

// --- Sampling plumbing -------------------------------------------------------

const pick = (rng, arr) => arr[rng.int(0, arr.length)];

function shuffled(rng, arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/** `count` distinct values from `arr`, in a random order. */
const distinct = (rng, arr, count) => shuffled(rng, arr).slice(0, count);

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
}

const pathLabel = (path) => path.join('.');
// String(-0) is '0', so a coverage token or a failure label built from String
// alone cannot tell the two apart — the exact distinction under test.
const fmt = (v) => (Object.is(v, -0) ? '-0' : String(v));

/** Every numeric leaf of a plain record, as an array path. */
function numericLeafPaths(obj, prefix = [], out = []) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'number') out.push([...prefix, k]);
    else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        if (typeof v[i] === 'number') out.push([...prefix, k, i]);
      }
    } else if (v !== null && typeof v === 'object') numericLeafPaths(v, [...prefix, k], out);
  }
  return out;
}

/** 2 or 3 sprinkle sites per sample (pairs and triples, never the full cross). */
const sprinkleCount = (rng) => 2 + rng.int(0, 2);

// Object.is at leaves + exact key sets, REPORTING THE FAILING PATH (the
// tests/genotype-codec.test.js comparator idiom, copied deliberately — that
// file stays its own owner). toEqual cannot see -0 vs +0, which is the exact
// distinction this harness exists to police.
function assertBitEqual(actual, expected, path) {
  if (typeof expected === 'number') {
    expect(Object.is(actual, expected), `${path}: ${fmt(actual)} !== ${fmt(expected)}`).toBe(true);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} is not an array`).toBe(true);
    expect(actual.length, `${path}.length`).toBe(expected.length);
    for (let i = 0; i < expected.length; i += 1) assertBitEqual(actual[i], expected[i], `${path}[${i}]`);
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    expect(Object.keys(actual).sort(), `${path} key set`).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) assertBitEqual(actual[k], expected[k], `${path}.${k}`);
    return;
  }
  expect(actual, path).toBe(expected);
}

/**
 * The three rules, applied to one sample. `label` names the sample and the
 * leaves that were sprinkled into it, so a red reports a reproducible input
 * rather than "property failed".
 */
function assertCodecRules(serialize, deserialize, x, expected, label) {
  const bytes = serialize(x);
  // R3: the decoder must accept its own encoder's output. A throw here is
  // always a defect — the input came from the encoder, not from a corpus.
  let decoded;
  try {
    decoded = deserialize(bytes);
  } catch (err) {
    expect.fail(`${label}: R3 — deserialize threw on encoder output: ${err.message}`);
  }
  // R2: leaf equality under Object.is, with the failing path named.
  assertBitEqual(decoded, expected, label);
  // R1: byte identity on re-encode.
  expect(bytesEqual(serialize(decoded), bytes), `${label}: R1 — re-encode drifted`).toBe(true);
}

/**
 * The premise tooth: the stream must have actually produced every declared
 * distinguished value. Reports the whole missing set at once, so a sampler
 * that drifts away from its boundaries names exactly what it stopped reaching.
 */
function assertCoverage(seen, required, label) {
  const missing = required.filter((t) => !seen.has(t));
  expect(missing, `${label}: the sampler never produced these boundary values`).toEqual([]);
}

// --- The harness's own teeth -------------------------------------------------

describe('the harness itself reds on a deliberately broken codec', () => {
  // THE REASON THIS BLOCK EXISTS, stated plainly: the previous round measured
  // that reverting a real fix (the cached intrinsic getters in
  // deserializeGenotype) left the whole suite GREEN, because the test that
  // claimed to enforce the rule asserted something strictly weaker. A property
  // harness has the same failure mode one level up — assertCodecRules could
  // silently stop checking anything and every pair above would still pass. So
  // the three rules are exercised against toy codecs carrying exactly the three
  // real defect shapes, and each must RED. `run` returns the caught error, so a
  // rule that stopped firing shows up as `undefined`.
  const run = (serialize, deserialize, x, expected) => {
    try {
      assertCodecRules(serialize, deserialize, x, expected, 'teeth');
    } catch (err) { return err; }
    return undefined;
  };
  // The honest toy pair: f64 `a`, u32 `b`.
  const write = (a, b) => {
    const v = new DataView(new ArrayBuffer(12));
    v.setFloat64(0, a, true); v.setUint32(8, b, true);
    return new Uint8Array(v.buffer);
  };
  const read = (bytes) => {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { a: v.getFloat64(0, true), b: v.getUint32(8, true) };
  };
  const encode = (x) => write(x.a, x.b);

  test('an honest codec passes all three rules', () => {
    for (const x of [{ a: -0, b: 0 }, { a: Number.MIN_VALUE, b: 0xffffffff }]) {
      expect(run(encode, read, x, x), `honest ${fmt(x.a)}/${x.b}`).toBeUndefined();
    }
  });

  test('R2 fires on SILENT NORMALIZATION that R1 cannot see', () => {
    // The -0 class, exactly: the encoder erases the sign bit, so the decoded
    // value re-encodes to the identical bytes and R1 is satisfied FOREVER.
    // Only Object.is leaf equality distinguishes the record from its image.
    const normalizing = (x) => write(x.a === 0 ? 0 : x.a, x.b);
    const x = { a: -0, b: 7 };
    const err = run(normalizing, read, x, x);
    expect(err, 'R2 did not fire on a normalized -0').toBeDefined();
    expect(err.message).toMatch(/teeth\.a: 0 !== -0/);
    // The premise: R1 alone really is blind to this defect.
    const bytes = normalizing(x);
    expect(bytesEqual(normalizing(read(bytes)), bytes)).toBe(true);
  });

  test('R1 fires on an encoder whose output is not a function of the record', () => {
    // The "two independent reads backing one attestation" class: leaves decode
    // correctly (R2 passes), but re-encoding does not reproduce the stream.
    let n = 0;
    const drifting = (x) => {
      const out = new Uint8Array(13);
      out.set(write(x.a, x.b));
      out[12] = n; n += 1; // a byte that depends on call order, not on x
      return out;
    };
    const x = { a: 0.5, b: 3 };
    const err = run(drifting, read, x, x);
    expect(err, 'R1 did not fire on a drifting encoder').toBeDefined();
    expect(err.message).toMatch(/R1 — re-encode drifted/);
  });

  test('R3 fires when a decoder refuses its own encoder\'s output', () => {
    // The deserializeFitnessVector class: a decoder stricter than its encoder
    // rejects a byte-identical, perfectly valid canonical stream.
    const stricter = (bytes) => {
      const x = read(bytes);
      if (x.b === 0xffffffff) throw new Error('toy: b out of range');
      return x;
    };
    const x = { a: 1, b: 0xffffffff };
    const err = run(encode, stricter, x, x);
    expect(err, 'R3 did not fire').toBeDefined();
    expect(err.message).toMatch(/R3 — deserialize threw on encoder output: toy: b out of range/);
  });

  test('the coverage tooth reds when the sampler stops reaching a boundary', () => {
    let err;
    try { assertCoverage(new Set(['gene:0']), ['gene:0', 'gene:-0'], 'toy'); } catch (e) { err = e; }
    expect(err, 'assertCoverage accepted a missing boundary').toBeDefined();
    expect(err.message).toMatch(/gene:-0/);
  });
});

// --- Pair 1: genotype --------------------------------------------------------

function baseGenotype(rng, axleCount) {
  const nodes = [];
  for (let i = 0; i < NODE_SLOT_COUNT; i += 1) {
    const n = {};
    for (const k of NODE_GENES) n[k] = rng.nextFloat();
    nodes.push(n);
  }
  const axles = [];
  for (let a = 0; a < axleCount; a += 1) {
    const axle = {};
    for (const k of AXLE_GENES) axle[k] = rng.nextFloat();
    axle.asym = {};
    for (const k of ASYM_GENES) axle.asym[k] = rng.nextFloat();
    axles.push(axle);
  }
  return {
    version: GENOTYPE_VERSION,
    hue: rng.nextFloat(),
    symmetric: rng.nextFloat(),
    power: rng.nextFloat(),
    frameDensity: rng.nextFloat(),
    frame: {
      family: rng.nextFloat(),
      segments: [{
        nodeCount: rng.nextFloat(),
        nodes,
        fam: {
          spine: { beamWidthFrac: rng.nextFloat() },
          ladder: { crossFrac: rng.nextFloat() },
          hull: { bulge: rng.nextFloat() },
        },
      }],
    },
    axles,
  };
}

function genotypeGenePaths(axleCount) {
  const seg = ['frame', 'segments', 0];
  const paths = [
    ['hue'], ['symmetric'], ['power'], ['frameDensity'],
    ['frame', 'family'], [...seg, 'nodeCount'],
    [...seg, 'fam', 'spine', 'beamWidthFrac'],
    [...seg, 'fam', 'ladder', 'crossFrac'],
    [...seg, 'fam', 'hull', 'bulge'],
  ];
  for (let i = 0; i < NODE_SLOT_COUNT; i += 1) {
    for (const k of NODE_GENES) paths.push([...seg, 'nodes', i, k]);
  }
  for (let a = 0; a < axleCount; a += 1) {
    for (const k of AXLE_GENES) paths.push(['axles', a, k]);
    for (const k of ASYM_GENES) paths.push(['axles', a, 'asym', k]);
  }
  return paths;
}

/** An ordinary genotype with 2-3 gene leaves overwritten by boundary values. */
function sprinkledGenotype(rng, tokens) {
  const axleCount = pick(rng, AXLE_COUNTS);
  const g = baseGenotype(rng, axleCount);
  if (tokens) tokens.add(`axles:${axleCount}`);
  const paths = genotypeGenePaths(axleCount);
  const applied = [];
  for (let s = 0; s < sprinkleCount(rng); s += 1) {
    const path = pick(rng, paths);
    const value = pick(rng, GENE_BOUNDARIES);
    setPath(g, path, value);
    if (tokens) tokens.add(`gene:${fmt(value)}`);
    applied.push(`${pathLabel(path)}=${fmt(value)}`);
  }
  return { genotype: g, label: `axles ${axleCount} [${applied.join(' ')}]` };
}

describe(`genotype codec — ${N} boundary-sprinkled samples (seed ${SEED})`, () => {
  test('serialize/deserialize is an exact inverse in both directions', () => {
    const rng = new Rng(SEED).fork(STREAM.genotype);
    const seen = new Set();
    for (let i = 0; i < N; i += 1) {
      const { genotype, label } = sprinkledGenotype(rng, seen);
      assertCodecRules(serializeGenotype, deserializeGenotype, genotype, genotype,
        `genotype sample ${i} — ${label}`);
    }
    assertCoverage(seen, [
      ...GENE_BOUNDARIES.map((v) => `gene:${fmt(v)}`),
      ...AXLE_COUNTS.map((n) => `axles:${n}`),
    ], 'genotype');
  });
});

// --- Pair 2: population snapshot ---------------------------------------------

describe(`population snapshot codec — ${N} boundary-sprinkled samples (seed ${SEED})`, () => {
  test('serialize/deserialize is an exact inverse in both directions', () => {
    const rng = new Rng(SEED).fork(STREAM.snapshot);
    const seen = new Set();
    for (let i = 0; i < N; i += 1) {
      const count = pick(rng, MEMBER_COUNTS);
      seen.add(`members:${count}`);
      // Ids come from the u32 boundary set (0 and 0xffffffff included), and the
      // input order is SHUFFLED — the encoder canonicalizes by sorting a copy,
      // so the expectation is always the ascending order.
      const ids = distinct(rng, U32_BOUNDARIES, count);
      const members = ids.map((individualId) => {
        seen.add(`id:${individualId}`);
        const { genotype, label } = sprinkledGenotype(rng, seen);
        // Snapshots may only carry REPAIRED genotypes (the canonicality
        // ruling). Assert idempotence here rather than letting the encoder
        // throw "not canonical" — that failure mode is repair's, not the
        // codec's, and conflating them would make a red unreadable.
        const canonical = repairGenotype(genotype);
        expect(
          bytesEqual(serializeGenotype(repairGenotype(canonical)), serializeGenotype(canonical)),
          `snapshot sample ${i} — repair is not idempotent on ${label}`,
        ).toBe(true);
        return { individualId, genotype: canonical };
      });
      const x = { snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals: members };
      const expected = {
        snapshotVersion: POPULATION_SNAPSHOT_VERSION,
        individuals: [...members].sort((a, b) => a.individualId - b.individualId),
      };
      assertCodecRules(serializePopulationSnapshot, deserializePopulationSnapshot, x, expected,
        `snapshot sample ${i} — ids [${ids.join(',')}]`);
    }
    assertCoverage(seen, [
      ...U32_BOUNDARIES.map((v) => `id:${v}`),
      ...MEMBER_COUNTS.map((n) => `members:${n}`),
    ], 'snapshot');
  });
});

// --- Pair 3: population initialization manifest ------------------------------

describe(`initialization manifest codec — ${N} boundary-sprinkled samples (seed ${SEED})`, () => {
  test('serialize/deserialize is an exact inverse in both directions', () => {
    const rng = new Rng(SEED).fork(STREAM.manifest);
    const seen = new Set();
    for (let i = 0; i < N; i += 1) {
      // The DIGEST-ONLY input path (no `population`): the manifest binds
      // content by digest state, and that is the path a decoded manifest
      // re-enters the encoder on — so it is the path the round trip must close.
      const minAxles = pick(rng, [1, 2, 6]);
      const maxAxles = pick(rng, [minAxles, 6]);
      const categories = pick(rng, CATEGORY_SETS);
      seen.add(`cats:${categories.join('/')}`);
      const config = {
        populationSize: rng.int(1, 64),
        minAxles,
        maxAxles,
        symmetricProbability: rng.nextFloat(),
        minInitialPowerGene: rng.nextFloat(),
        initialSuspensionTypes: categories,
      };
      const record = {
        initializerVersion: POPULATION_INITIALIZER_VERSION,
        seed: rng.int(0, 0x7fffffff),
        config,
        populationSnapshotDigestState: rng.int(0, 0x7fffffff),
      };
      // Sprinkle sites: the two u32 identity fields, populationSize, and the
      // two probability f64s (where -0 is legal and must survive).
      const sites = [
        () => {
          record.seed = pick(rng, U32_BOUNDARIES);
          seen.add(`u32:${record.seed}`);
          return `seed=${record.seed}`;
        },
        () => {
          record.populationSnapshotDigestState = pick(rng, U32_BOUNDARIES);
          seen.add(`u32:${record.populationSnapshotDigestState}`);
          return `digest=${record.populationSnapshotDigestState}`;
        },
        () => {
          config.populationSize = pick(rng, U32_POSITIVE_BOUNDARIES);
          seen.add(`u32:${config.populationSize}`);
          return `populationSize=${config.populationSize}`;
        },
        () => {
          config.symmetricProbability = pick(rng, GENE_BOUNDARIES);
          seen.add(`f64:${fmt(config.symmetricProbability)}`);
          return `symmetricProbability=${fmt(config.symmetricProbability)}`;
        },
        () => {
          config.minInitialPowerGene = pick(rng, GENE_BOUNDARIES);
          seen.add(`f64:${fmt(config.minInitialPowerGene)}`);
          return `minInitialPowerGene=${fmt(config.minInitialPowerGene)}`;
        },
      ];
      const applied = distinct(rng, sites, sprinkleCount(rng)).map((run) => run());

      const expected = {
        initializerVersion: POPULATION_INITIALIZER_VERSION,
        genotypeVersion: GENOTYPE_VERSION,
        seed: record.seed,
        config: {
          seed: record.seed, // resolveConfig folds the seed into the config it returns
          populationSize: config.populationSize,
          minAxles: config.minAxles,
          maxAxles: config.maxAxles,
          symmetricProbability: config.symmetricProbability,
          minInitialPowerGene: config.minInitialPowerGene,
          initialSuspensionTypes: [...config.initialSuspensionTypes],
        },
        populationSnapshotDigestState: record.populationSnapshotDigestState,
      };
      assertCodecRules(
        serializePopulationInitialization, deserializePopulationInitialization,
        record, expected, `manifest sample ${i} — [${applied.join(' ')}]`,
      );
    }
    assertCoverage(seen, [
      ...U32_BOUNDARIES.map((v) => `u32:${v}`),
      ...GENE_BOUNDARIES.map((v) => `f64:${fmt(v)}`),
      ...CATEGORY_SETS.map((c) => `cats:${c.join('/')}`),
    ], 'manifest');
  });
});

// --- Pair 4: evaluation spec -------------------------------------------------

function deepCopyTerrain(terrain) {
  const out = {};
  for (const k of Object.keys(terrain)) {
    const v = terrain[k];
    if (Array.isArray(v)) {
      const copy = [];
      for (let i = 0; i < v.length; i += 1) copy.push(v[i]);
      out[k] = copy;
    } else if (v !== null && typeof v === 'object') out[k] = { ...v };
    else out[k] = v;
  }
  return out;
}

const TERRAIN_RANGE_KEYS = Object.freeze(Object.keys(TERRAIN_DEFAULTS)
  .filter((k) => Array.isArray(TERRAIN_DEFAULTS[k])));
// The two u32 leaves of a resolved spec, declared rather than sniffed: the
// sprinkler picks a KIND first so the u32 domain is reached at a useful rate
// (a uniform pick over ~60 numeric leaves would hit these twice in 200 samples).
const SPEC_U32_PATHS = Object.freeze([['maxSteps'], ['terrain', 'seed']]);

function baseSpec(rng) {
  const terrain = deepCopyTerrain(TERRAIN_DEFAULTS);
  terrain.seed = rng.int(0, 0x7fffffff);
  return {
    deterministic: rng.bool(0.5),
    termination: 'maxSteps', // the only member of TERMINATIONS
    maxSteps: rng.int(1, 4096),
    spawn: { x: rng.range(-60, 60), z: rng.range(-5, 5), clearance: rng.range(0.001, 0.05) },
    targetWheelSurfaceSpeed: rng.range(0, 20),
    wheelFriction: rng.range(0, 3),
    terrain,
  };
}

describe(`evaluation spec codec — ${N} boundary-sprinkled samples (seed ${SEED})`, () => {
  test('serialize/deserialize is an exact inverse in both directions', () => {
    const rng = new Rng(SEED).fork(STREAM.spec);
    const seen = new Set();
    for (let i = 0; i < N; i += 1) {
      const spec = baseSpec(rng);
      seen.add(`deterministic:${spec.deterministic}`);
      const applied = [];
      for (let s = 0; s < sprinkleCount(rng); s += 1) {
        // Three sprinkle KINDS: a u32 leaf, an f64 leaf, or a variable-length
        // range whose length is redrawn from {0, 1, 2, 255} — that last one is
        // the one-source-of-truth ruling's own field class (count, allocation
        // and payload must all come from the same indexed reading).
        const kind = pick(rng, ['u32', 'f64', 'rangeLength']);
        if (kind === 'rangeLength') {
          const key = pick(rng, TERRAIN_RANGE_KEYS);
          const length = pick(rng, RANGE_LENGTHS);
          const range = [];
          for (let j = 0; j < length; j += 1) range.push(pick(rng, WIRE_F64_BOUNDARIES));
          spec.terrain[key] = range;
          seen.add(`len:${length}`);
          applied.push(`terrain.${key}.length=${length}`);
          continue;
        }
        if (kind === 'u32') {
          const path = pick(rng, SPEC_U32_PATHS);
          const label = pathLabel(path);
          const value = pick(rng, label === 'maxSteps' ? U32_POSITIVE_BOUNDARIES : U32_BOUNDARIES);
          setPath(spec, path, value);
          seen.add(`u32:${value}`);
          applied.push(`${label}=${value}`);
          continue;
        }
        // f64: any numeric leaf that is not one of the two u32 fields.
        const u32Labels = SPEC_U32_PATHS.map(pathLabel);
        const f64Paths = numericLeafPaths(spec).filter((p) => !u32Labels.includes(pathLabel(p)));
        const path = pick(rng, f64Paths);
        const value = pick(rng, WIRE_F64_BOUNDARIES);
        setPath(spec, path, value);
        seen.add(`f64:${fmt(value)}`);
        applied.push(`${pathLabel(path)}=${fmt(value)}`);
      }
      // The decoder returns the RESOLVED shape — the same seven keys the
      // encoder consumes — so the sample IS its own expectation.
      assertCodecRules(serializeEvaluationSpec, deserializeEvaluationSpec, spec, spec,
        `spec sample ${i} — [${applied.join(' ')}]`);
    }
    assertCoverage(seen, [
      ...U32_BOUNDARIES.map((v) => `u32:${v}`),
      ...WIRE_F64_BOUNDARIES.map((v) => `f64:${fmt(v)}`),
      ...RANGE_LENGTHS.map((n) => `len:${n}`),
      'deterministic:true', 'deterministic:false',
    ], 'spec');
  });
});

// --- Pair 5: fitness vector --------------------------------------------------

describe(`fitness vector codec — ${N} boundary-sprinkled samples (seed ${SEED})`, () => {
  test('serialize/deserialize is an exact inverse in both directions', () => {
    const rng = new Rng(SEED).fork(STREAM.fitnessVector);
    const seen = new Set();
    for (let i = 0; i < N; i += 1) {
      const count = pick(rng, MEMBER_COUNTS);
      seen.add(`members:${count}`);
      const ids = distinct(rng, U32_BOUNDARIES, count).sort((a, b) => a - b);
      const individuals = ids.map((individualId) => {
        seen.add(`id:${individualId}`);
        const valid = rng.bool(0.5);
        // 'ok' is drawn at 1/2 rather than 1/3 so SELECTABLE rows — the only
        // ones that may carry a nonzero fitness — stay frequent enough for the
        // fitness boundary set to be reached (the coverage tooth enforces it).
        const integrityStatus = rng.bool(0.5)
          ? 'ok' : pick(rng, ['nonFinite', 'numericalDivergence']);
        seen.add(`status:${integrityStatus}`);
        // The policy-v2 coherence rule the encoder AND the decoder enforce:
        // an unselectable member must carry fitness 0 — and a legally-encoded
        // -0 on such a member must decode (the `!== 0` comparison, not
        // Object.is), which is the asymmetry this sample class exercises.
        const selectable = valid && integrityStatus === 'ok';
        const fitness = selectable ? pick(rng, FITNESS_BOUNDARIES) : pick(rng, [0, -0]);
        if (selectable) seen.add(`fitness:${fmt(fitness)}`);
        return { individualId, valid, integrityStatus, fitness };
      });
      const evaluation = {
        individuals,
        populationSnapshotDigestState: pick(rng, U32_BOUNDARIES),
        evaluationSpecDigestState: pick(rng, U32_BOUNDARIES),
      };
      const expected = {
        fitnessVectorVersion: FITNESS_VECTOR_VERSION,
        fitnessPolicyVersion: FITNESS_POLICY_VERSION,
        integrityPolicyVersion: INTEGRITY_POLICY_VERSION,
        snapshotVersion: POPULATION_SNAPSHOT_VERSION,
        populationSnapshotDigestState: evaluation.populationSnapshotDigestState,
        evaluationSpecVersion: EVALUATION_SPEC_VERSION,
        evaluationSpecDigestState: evaluation.evaluationSpecDigestState,
        individuals,
      };
      assertCodecRules(serializeFitnessVector, deserializeFitnessVector, evaluation, expected,
        `fitness vector sample ${i} — ids [${ids.join(',')}]`);
    }
    assertCoverage(seen, [
      ...U32_BOUNDARIES.map((v) => `id:${v}`),
      ...FITNESS_BOUNDARIES.map((v) => `fitness:${fmt(v)}`),
      ...INTEGRITY_STATUS.map((s) => `status:${s}`),
      ...MEMBER_COUNTS.map((n) => `members:${n}`),
    ], 'fitness vector');
  });
});

// --- The -0 uint32 refusal, asserted at every u32 seam ------------------------

describe('-0 is refused by every canonical uint32 seam', () => {
  // WHY this is a hard refusal and not a normalization: setUint32 ERASES the
  // sign bit, so a -0 that encoded silently decoded back as +0 — and R2 above
  // (Object.is leaf equality) then failed on a stream the encoder itself
  // produced. The codec cannot be an exact inverse over a domain containing a
  // value it cannot represent, so the domain excludes it. This is deliberately
  // ASYMMETRIC with f64 fitness/gene leaves, where setFloat64 PRESERVES the
  // sign bit and -0 is therefore legal and must NOT be rejected (asserted
  // positively by the samples above — the fitness and gene coverage sets both
  // require a -0 token).
  const canonicalGenotype = () => {
    const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
    const axle = (posX01) => ({
      posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
      suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
      driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
    });
    return {
      version: GENOTYPE_VERSION, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3,
      frame: {
        family: 0.1,
        segments: [{
          nodeCount: 0.5,
          nodes: Array.from({ length: NODE_SLOT_COUNT }, node),
          fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
        }],
      },
      axles: [axle(0.2), axle(0.8)],
    };
  };
  const row = (individualId) => ({
    individualId, valid: true, integrityStatus: 'ok', fitness: 1,
  });

  const SEAMS = Object.freeze([
    ['snapshot individualId', () => serializePopulationSnapshot({
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      individuals: [{ individualId: -0, genotype: repairGenotype(canonicalGenotype()) }],
    })],
    ['manifest seed', () => serializePopulationInitialization({
      initializerVersion: POPULATION_INITIALIZER_VERSION,
      seed: -0,
      config: { populationSize: 2 },
      populationSnapshotDigestState: 7,
    })],
    ['manifest populationSnapshotDigestState', () => serializePopulationInitialization({
      initializerVersion: POPULATION_INITIALIZER_VERSION,
      seed: 1,
      config: { populationSize: 2 },
      populationSnapshotDigestState: -0,
    })],
    ['spec terrain.seed', () => {
      const spec = baseSpec(new Rng(SEED).fork(99));
      spec.terrain.seed = -0;
      return serializeEvaluationSpec(spec);
    }],
    ['fitness vector individualId', () => serializeFitnessVector({
      individuals: [row(-0)],
      populationSnapshotDigestState: 1,
      evaluationSpecDigestState: 2,
    })],
    ['fitness vector populationSnapshotDigestState', () => serializeFitnessVector({
      individuals: [row(0)],
      populationSnapshotDigestState: -0,
      evaluationSpecDigestState: 2,
    })],
    ['fitness vector evaluationSpecDigestState', () => serializeFitnessVector({
      individuals: [row(0)],
      populationSnapshotDigestState: 1,
      evaluationSpecDigestState: -0,
    })],
  ]);

  test('every u32 seam fails loud in its own module dialect', () => {
    for (const [label, run] of SEAMS) {
      let thrown;
      try { run(); } catch (err) { thrown = err; }
      expect(thrown, `${label} accepted -0`).toBeDefined();
      expect(thrown, `${label} threw a foreign ${thrown && thrown.constructor.name}`)
        .not.toBeInstanceOf(TypeError);
      expect(thrown.message, label).toMatch(/^(population|population-initializer|population-evaluation):/);
    }
  });

  test('the same seams accept +0 — the refusal is about the sign bit, not the value', () => {
    // Without this control the refusal above would also pass if a seam simply
    // rejected zero, which would be a different (and wrong) contract.
    expect(() => serializePopulationSnapshot({
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      individuals: [{ individualId: 0, genotype: repairGenotype(canonicalGenotype()) }],
    })).not.toThrow();
    expect(() => serializePopulationInitialization({
      initializerVersion: POPULATION_INITIALIZER_VERSION,
      seed: 0,
      config: { populationSize: 2 },
      populationSnapshotDigestState: 0,
    })).not.toThrow();
    expect(() => serializeFitnessVector({
      individuals: [row(0)],
      populationSnapshotDigestState: 0,
      evaluationSpecDigestState: 0,
    })).not.toThrow();
  });
});
