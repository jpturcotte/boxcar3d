// Pure tests for the genotype codec (src/sim/assembly.js serializeGenotype /
// deserializeGenotype) — no Rapier, no physics.
//
// deserializeGenotype is the EXACT INVERSE of the canonical encoder across
// the encoder's whole output domain (ruling R-C): raw [0,1] genes survive
// bit-exactly (−0 included), latent/inactive blocks are always serialized
// and round-trip untouched, and the decoder re-runs validateGenotype — never
// repairs. The locked-corpus inversion below decodes the EXACT 24cd0dd5
// corpus (seed 20260710, n=256, the assembly.test.js construction) with ZERO
// new digest literals: byte-equality against the real serializer is the
// proof. The R-D guard tooth proves a 256-axle genotype now fails loud at
// the encoder instead of emitting a wrapped u8 count byte. Seeds declared
// per test (rule 3): 20260710 (the shared corpus seed), 20260732 (new —
// the codec sprinkle corpus), 20260733 (negative-case raw draws).

import { describe, test, expect } from 'vitest';
import {
  GENOTYPE_VERSION,
  NODE_SLOTS,
  deserializeGenotype,
  genotypeByteLength,
  randomGenotype,
  repairGenotype,
  serializeGenotype,
} from '../src/sim/assembly.js';
import { bytesEqual } from '../src/sim/population.js';
import { Rng } from '../src/sim/prng.js';

// --- Copy-declared helpers ----------------------------------------------------

// Object.is-strict deep equality (the trace.test.js idiom, copy-declared).
function assertBitEqual(actual, expected, path = 'genotype') {
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

// Canonical-shape hand genotypes. Values chosen domain-valid; the codec
// never repairs, so physical feasibility is irrelevant here.
const handNode = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
const handAxle = (overrides = {}) => ({
  posX01: 0.5,
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
  ...overrides,
});
function handGenotype({ family = 0.1, axleCount = 2, symmetric = 0.9 } = {}) {
  return {
    version: GENOTYPE_VERSION,
    hue: 0.25,
    symmetric,
    power: 0.5,
    frameDensity: 0.3,
    frame: {
      family,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: NODE_SLOTS }, handNode),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: Array.from({ length: axleCount }, (_, i) => handAxle({ posX01: (i + 1) / (axleCount + 1) })),
  };
}

// Round trip with hygiene: decode is leaf-exact (Object.is), re-encode is
// byte-exact, and the input buffer is not mutated.
function expectRoundTrip(genotype) {
  const bytes = serializeGenotype(genotype);
  const snapshot = bytes.slice();
  const decoded = deserializeGenotype(bytes);
  assertBitEqual(decoded, genotype);
  expect(bytesEqual(serializeGenotype(decoded), bytes)).toBe(true);
  expect(bytes).toEqual(snapshot);
  return { bytes, decoded };
}

// The boundary/special gene values the codec must carry bit-exactly. All
// inside [0,1]; 0.5−2^-54 / 0.5+2^-53 are the neighbors of 0.5.
const BOUNDARY_GENES = [
  0, 1, 0.5, 0.5 - 2 ** -54, 0.5 + 2 ** -53,
  1 / 3, 2 / 3, // the suspType band edges
  Number.MIN_VALUE, 2 ** -1022, 1 - 2 ** -53,
];

describe('genotype codec — hand-built round trips', () => {
  test('0-axle and 6-axle genotypes round trip at the exact length literals 268 / 1036', () => {
    const zero = handGenotype({ axleCount: 0 });
    const six = handGenotype({ axleCount: 6 });
    expect(serializeGenotype(zero).length).toBe(268);
    expect(serializeGenotype(six).length).toBe(1036);
    expect(genotypeByteLength(0)).toBe(268);
    expect(genotypeByteLength(6)).toBe(1036);
    expectRoundTrip(zero);
    expectRoundTrip(six);
  });

  test('all three frame families round trip', () => {
    for (const family of [0.1, 0.5, 0.9]) { // spine / ladder / hull bands
      const { decoded } = expectRoundTrip(handGenotype({ family }));
      expect(Object.is(decoded.frame.family, family)).toBe(true);
    }
  });

  test('all three suspType bands — S2 INCLUDED — round trip (the codec carries the gene, never the realizability gate)', () => {
    // S2 is legal encoder INPUT (a domain-valid gene in the [2/3, 1] band);
    // only the EVALUATOR rejects it pre-world. The codec must not editorialize.
    const genotype = handGenotype({ axleCount: 3 });
    genotype.axles[0].suspType = 0.1; // S0
    genotype.axles[1].suspType = 0.5; // S1
    genotype.axles[2].suspType = 0.9; // S2
    const { decoded } = expectRoundTrip(genotype);
    expect(Object.is(decoded.axles[2].suspType, 0.9)).toBe(true);
  });

  test('latent blocks survive bit-exactly: asym genes on a SYMMETRIC genotype, inactive fam blocks, inactive node slots, nodes[0].gap', () => {
    const genotype = handGenotype({ family: 0.1, axleCount: 2, symmetric: 0.9 }); // spine, symmetric
    // Latent asym blocks (symmetric on): distinctive values.
    genotype.axles[0].asym = { driveBias: 0.123456789, sizeBias: 0.987654321, centerOffset: 0.333333333 };
    genotype.axles[1].asym = { driveBias: 0.75, sizeBias: 0.25, centerOffset: 0.5 };
    // Latent fam blocks (family = spine): ladder + hull carry unused genes.
    genotype.frame.segments[0].fam.ladder.crossFrac = 0.314159265;
    genotype.frame.segments[0].fam.hull.bulge = 0.271828182;
    // Latent node tail: nodeCount 0.5 -> 4 active nodes; slots 4/5 unused.
    genotype.frame.segments[0].nodes[4] = { gap: 0.11, height: 0.22, halfWidth: 0.33, thickness: 0.44 };
    genotype.frame.segments[0].nodes[5] = { gap: 0.55, height: 0.66, halfWidth: 0.77, thickness: 0.88 };
    // nodes[0].gap is ALWAYS latent (cumulative spacing starts at 0).
    genotype.frame.segments[0].nodes[0].gap = 0.424242424;
    expectRoundTrip(genotype);
  });

  test('boundary genes round trip bit-exactly (0, 1, 0.5, 0.5±ulp, band edges, denormals, 1−2^-53)', () => {
    const genotype = handGenotype({ axleCount: 1 });
    // Cycle the boundary set across EVERY gene leaf, explicitly.
    let leafIndex = 0;
    const setLeaf = (container, key) => {
      container[key] = BOUNDARY_GENES[leafIndex % BOUNDARY_GENES.length];
      leafIndex += 1;
    };
    for (const k of ['hue', 'symmetric', 'power', 'frameDensity']) setLeaf(genotype, k);
    setLeaf(genotype.frame, 'family');
    const seg = genotype.frame.segments[0];
    setLeaf(seg, 'nodeCount');
    for (const n of seg.nodes) {
      for (const k of ['gap', 'height', 'halfWidth', 'thickness']) setLeaf(n, k);
    }
    setLeaf(seg.fam.spine, 'beamWidthFrac');
    setLeaf(seg.fam.ladder, 'crossFrac');
    setLeaf(seg.fam.hull, 'bulge');
    const a = genotype.axles[0];
    for (const k of ['posX01', 'paired', 'trackHalf', 'radius', 'width', 'density', 'suspType', 'stiffness', 'damping', 'travel', 'restLength', 'driven', 'share']) setLeaf(a, k);
    for (const k of ['driveBias', 'sizeBias', 'centerOffset']) setLeaf(a.asym, k);
    const { bytes, decoded } = expectRoundTrip(genotype);
    // Spot literal: the first leaf took BOUNDARY_GENES[0] = 0 exactly.
    expect(Object.is(decoded.hue, 0)).toBe(true);
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(2, true)).toBe(0);
  });

  test('−0 round trips with the serialized sign byte asserted', () => {
    const genotype = handGenotype({ axleCount: 1 });
    genotype.hue = -0;
    genotype.axles[0].asym.centerOffset = -0;
    const { bytes, decoded } = expectRoundTrip(genotype);
    // f64 hue at offset 2: −0 is 00 00 00 00 00 00 00 80 little-endian.
    expect(bytes[2 + 7]).toBe(0x80);
    expect(Object.is(decoded.hue, -0)).toBe(true);
    // asym.centerOffset is axle leaf 15: offset 268 + 15*8, sign byte at +7.
    expect(bytes[268 + 15 * 8 + 7]).toBe(0x80);
    expect(Object.is(decoded.axles[0].asym.centerOffset, -0)).toBe(true);
  });

  test('a 7-axle genotype round trips — the wire domain (u8) exceeds the default repair cap (6), documented', () => {
    const genotype = handGenotype({ axleCount: 7 });
    const bytes = serializeGenotype(genotype);
    expect(bytes.length).toBe(268 + 7 * 128);
    expectRoundTrip(genotype);
  });

  test('the R-D guard tooth: a 256-axle genotype FAILS LOUD at the encoder (no wrapped u8 count byte)', () => {
    const genotype = handGenotype({ axleCount: 0 });
    genotype.axles = Array.from({ length: 256 }, (_, i) => handAxle({ posX01: i / 256 }));
    expect(() => serializeGenotype(genotype)).toThrow(/assembly: invalid genotype at axles\.length \(256 exceeds the u8 wire bound 255\)/);
    // 255 remains legal — the guard moves NO valid byte.
    genotype.axles = genotype.axles.slice(0, 255);
    expect(serializeGenotype(genotype).length).toBe(genotypeByteLength(255));
  });
});

describe('genotype codec — locked-corpus inversion (seed 20260710, n=256)', () => {
  // The EXACT assembly.test.js corpus construction (copy-declared):
  // raw -> repaired, one fork per index. Decoding and re-encoding each
  // member inverts the 24cd0dd5 corpus with zero new digest literals.
  const corpus = Array.from({ length: 256 }, (_, i) => (
    repairGenotype(randomGenotype(new Rng(20260710).fork(i)))
  ));

  test('every corpus member decodes leaf-equal and re-serializes byte-equal', () => {
    for (const genotype of corpus) expectRoundTrip(genotype);
  });

  test('the corpus covers every axle count 0..6', () => {
    const counts = new Set(corpus.map((g) => g.axles.length));
    expect([...counts].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('genotype codec — special-value sprinkle corpus (seed 20260732, n=64)', () => {
  // Copy-declared axle draw (randomGenotype's own idiom: AXLE_GENES then
  // ASYM_GENES nextFloat order) so axle counts can be FORCED to i%7.
  const AXLE_KEYS = [
    'posX01', 'paired', 'trackHalf', 'radius', 'width', 'density',
    'suspType', 'stiffness', 'damping', 'travel', 'restLength', 'driven', 'share',
  ];
  const ASYM_KEYS = ['driveBias', 'sizeBias', 'centerOffset'];
  const drawAxle = (rng) => {
    const axle = {};
    for (const k of AXLE_KEYS) axle[k] = rng.nextFloat();
    axle.asym = {};
    for (const k of ASYM_KEYS) axle.asym[k] = rng.nextFloat();
    return axle;
  };

  test('raw sprinkled genotypes (valid-but-non-canonical is legal encoder input) round trip', () => {
    let replacements = 0;
    for (let i = 0; i < 64; i += 1) {
      const rng = new Rng(20260732).fork(i);
      const genotype = randomGenotype(rng);
      // Force the axle count to i%7: slice down, or draw more axles up.
      genotype.axles = genotype.axles.slice(0, i % 7);
      while (genotype.axles.length < i % 7) genotype.axles.push(drawAxle(rng));
      // Sprinkle: each gene leaf is replaced with probability 0.25 by a
      // draw from the boundary set (same stream — fully seed-determined).
      const sprinkle = (node, keys) => {
        for (const k of keys) {
          if (rng.nextFloat() < 0.25) {
            node[k] = BOUNDARY_GENES[rng.int(0, BOUNDARY_GENES.length)];
            replacements += 1;
          }
        }
      };
      sprinkle(genotype, ['hue', 'symmetric', 'power', 'frameDensity']);
      sprinkle(genotype.frame, ['family']);
      const seg = genotype.frame.segments[0];
      sprinkle(seg, ['nodeCount']);
      for (const n of seg.nodes) sprinkle(n, ['gap', 'height', 'halfWidth', 'thickness']);
      sprinkle(seg.fam.spine, ['beamWidthFrac']);
      sprinkle(seg.fam.ladder, ['crossFrac']);
      sprinkle(seg.fam.hull, ['bulge']);
      for (const a of genotype.axles) {
        sprinkle(a, AXLE_KEYS);
        sprinkle(a.asym, ASYM_KEYS);
      }
      expectRoundTrip(genotype); // NO repair — the raw draw is the encoder input
    }
    expect(replacements).toBeGreaterThan(0); // the sprinkle actually fired
  });
});

describe('genotype codec — negatives on a tampered 524-byte 2-axle stream', () => {
  const base = serializeGenotype(handGenotype({ axleCount: 2 }));
  expect(base.length).toBe(524); // 268 + 2 x 128
  const patchF64 = (bytes, offset, value) => {
    const out = bytes.slice();
    new DataView(out.buffer, out.byteOffset, out.byteLength).setFloat64(offset, value, true);
    return out;
  };
  const patchU8 = (bytes, offset, value) => {
    const out = bytes.slice();
    out[offset] = value;
    return out;
  };
  const patchU16 = (bytes, offset, value) => {
    const out = bytes.slice();
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(offset, value, true);
    return out;
  };

  test('truncations at every interesting boundary', () => {
    for (const n of [0, 1, 2, 5, 267, 268, 332, 523]) {
      expect(() => deserializeGenotype(base.subarray(0, n)), `length ${n}`).toThrow(/assembly: invalid encoded genotype/);
    }
  });

  test('a trailing byte fails the exact-length check', () => {
    const longer = Uint8Array.from([...base, 0]);
    expect(() => deserializeGenotype(longer)).toThrow(/assembly: invalid encoded genotype/);
  });

  test('version 0 and 2 are rejected (encoders write the current constant unconditionally)', () => {
    for (const v of [0, 2]) {
      expect(() => deserializeGenotype(patchU16(base, 0, v)), `version ${v}`).toThrow(/assembly: invalid encoded genotype at version/);
    }
  });

  test('segmentCount 0 and 2 are rejected (v1 has exactly one segment)', () => {
    for (const v of [0, 2]) {
      expect(() => deserializeGenotype(patchU8(base, 42, v)), `segmentCount ${v}`).toThrow(/assembly: invalid encoded genotype at frame\.segments\.length/);
    }
  });

  test('axleCount 1 and 3 against a 2-axle payload fail the exact-length check', () => {
    for (const v of [1, 3]) {
      expect(() => deserializeGenotype(patchU8(base, 267, v)), `axleCount ${v}`).toThrow(/assembly: invalid encoded genotype/);
    }
  });

  test('a gene patched outside the [0,1] domain is rejected by the re-run validator (never repaired)', () => {
    for (const bad of [NaN, 1.5, -(2 ** -1074), Infinity]) {
      expect(() => deserializeGenotype(patchF64(base, 2, bad)), `hue ${bad}`).toThrow(/assembly: invalid/);
    }
  });

  test('non-Uint8Array input fails loud', () => {
    for (const bad of ['bytes', [1, 2], 42, null]) {
      expect(() => deserializeGenotype(bad), String(bad)).toThrow(/assembly: invalid encoded genotype at bytes/);
    }
  });

  test('hygiene: a subarray with a nonzero byteOffset decodes its own window', () => {
    const backing = Uint8Array.from([0xaa, 0xbb, ...base, 0xcc]);
    const decoded = deserializeGenotype(backing.subarray(2, 2 + base.length));
    assertBitEqual(decoded, handGenotype({ axleCount: 2 }));
    expect(backing.length).toBe(base.length + 3); // input untouched
  });
});
