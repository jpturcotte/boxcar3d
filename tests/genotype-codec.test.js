// deserializeGenotype — the exact inverse of the canonical genotype walk.
//
// Two invariants, everywhere: serializeGenotype(deserializeGenotype(bytes)) is
// BYTE-identical, and deserializeGenotype(serializeGenotype(g)) is LEAF-equal
// under Object.is (never toEqual on numbers — it cannot see -0 vs +0, the
// exact distinction a normalizing decoder would erase).
//
// The corpus leg inverts the very stream the 24cd0dd5 fingerprint hashes
// (seed 20260710, n=256, construction copy-declared from tests/assembly.test.js)
// per member, so the decoder is bound to the locked corpus without this file
// duplicating the digest literal — tests/assembly.test.js stays its sole owner.
//
// Seeds: 20260710 (the assembly corpus, reused deliberately), 20260732 (NEW —
// the boundary-value sprinkle corpus).

import { describe, test, expect } from 'vitest';
import {
  FRAME_FAMILIES,
  GENOTYPE_VERSION,
  NODE_SLOTS,
  SUSPENSION_TYPES,
  deserializeGenotype,
  genotypeByteLength,
  randomGenotype,
  repairGenotype,
  serializeGenotype,
} from '../src/sim/assembly.js';
import { Rng } from '../src/sim/prng.js';

const CORPUS_SEED = 20260710;
const CORPUS_SIZE = 256;
const SPRINKLE_SEED = 20260732; // NEW: the boundary-value corpus
const SPRINKLE_SIZE = 64;

// Object.is at leaves + exact key sets (the tests/trace.test.js T8 comparator).
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

const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

// A hand-built genotype with a settable axle count and overridable leaves.
function genotypeWith(axleCount, overrides = {}) {
  const node = (i) => ({
    gap: 0.10 + i * 0.01,
    height: 0.20 + i * 0.01,
    halfWidth: 0.30 + i * 0.01,
    thickness: 0.40 + i * 0.01,
  });
  const axle = (a) => ({
    posX01: 0.11 + a * 0.05,
    paired: 0.6,
    trackHalf: 0.22,
    radius: 0.33,
    width: 0.44,
    density: 0.55,
    suspType: 0.2,
    stiffness: 0.66,
    damping: 0.77,
    travel: 0.88,
    restLength: 0.99,
    driven: 0.7,
    share: 0.35,
    asym: { driveBias: 0.15, sizeBias: 0.25, centerOffset: 0.45 },
  });
  return {
    version: GENOTYPE_VERSION,
    hue: 0.05,
    symmetric: 0.9,
    power: 0.5,
    frameDensity: 0.3,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: NODE_SLOTS }, (_, i) => node(i)),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.6 }, hull: { bulge: 0.7 } },
      }],
    },
    axles: Array.from({ length: axleCount }, (_, a) => axle(a)),
    ...overrides,
  };
}

// Round trip both directions for one genotype.
function assertRoundTrip(g, label) {
  const bytes = serializeGenotype(g);
  const decoded = deserializeGenotype(bytes);
  assertBitEqual(decoded, g, label);
  expect(bytesEqual(serializeGenotype(decoded), bytes), `${label}: re-encode drifted`).toBe(true);
}

describe('hand-built genotypes round-trip exactly', () => {
  test('the simple case, and the exact stream lengths', () => {
    expect(serializeGenotype(genotypeWith(0)).length).toBe(268);
    expect(serializeGenotype(genotypeWith(6)).length).toBe(1036);
    assertRoundTrip(genotypeWith(2), 'two-axle');
  });

  test('minimum and maximum legal axle counts (0 and 6)', () => {
    assertRoundTrip(genotypeWith(0), 'sled');
    assertRoundTrip(genotypeWith(6), 'max topology');
  });

  test('all three frame families', () => {
    // Band centres: enumIdx(g, 3) selects spine / ladder / hull.
    [0.1, 0.5, 0.9].forEach((family, i) => {
      const g = genotypeWith(1);
      g.frame.family = family;
      expect(FRAME_FAMILIES[Math.min(2, Math.floor(family * 3))]).toBe(FRAME_FAMILIES[i]);
      assertRoundTrip(g, `family ${FRAME_FAMILIES[i]}`);
    });
  });

  test('all three suspension bands, including the S2 band (legal as gene data)', () => {
    [0.1, 0.5, 0.9].forEach((suspType, i) => {
      const g = genotypeWith(1);
      g.axles[0].suspType = suspType;
      expect(SUSPENSION_TYPES[Math.min(2, Math.floor(suspType * 3))]).toBe(SUSPENSION_TYPES[i]);
      assertRoundTrip(g, `suspType ${SUSPENSION_TYPES[i]}`);
    });
  });

  test('symmetric and asymmetric latent blocks both survive bit-exactly', () => {
    for (const symmetric of [0.9, 0.1]) {
      const g = genotypeWith(2);
      g.symmetric = symmetric;
      g.axles[0].asym = { driveBias: 0.123, sizeBias: 0.456, centerOffset: 0.789 };
      g.axles[1].asym = { driveBias: 0, sizeBias: 1, centerOffset: 0.5 };
      assertRoundTrip(g, `symmetric ${symmetric}`);
      const decoded = deserializeGenotype(serializeGenotype(g));
      // Latents are never dropped, whatever the gate says.
      expect(decoded.axles[0].asym.sizeBias).toBe(0.456);
      expect(decoded.axles[1].asym.sizeBias).toBe(1);
    }
  });

  test('inactive latent fields (node slots past the active prefix, both idle fam blocks)', () => {
    const g = genotypeWith(1);
    g.frame.segments[0].nodeCount = 0; // -> 2 active nodes
    g.frame.segments[0].nodes[4] = { gap: 0.111, height: 0.222, halfWidth: 0.333, thickness: 0.444 };
    g.frame.segments[0].nodes[5] = { gap: 1, height: 0, halfWidth: 1, thickness: 0 };
    g.frame.family = 0.1; // spine active; ladder + hull latent
    assertRoundTrip(g, 'inactive latents');
    const decoded = deserializeGenotype(serializeGenotype(g));
    expect(decoded.frame.segments[0].nodes[5].gap).toBe(1);
    expect(decoded.frame.segments[0].fam.ladder.crossFrac).toBe(0.6);
    expect(decoded.frame.segments[0].fam.hull.bulge).toBe(0.7);
  });

  test('boundary gene values: 0, 1, threshold neighbours, denormals', () => {
    const boundaries = [
      0,
      1,
      0.5,
      0.5 - Number.EPSILON / 2, // just below the bool-gene threshold
      0.5 + Number.EPSILON, // just above
      1 / 3, // the enum band edge (family / suspType)
      2 / 3,
      Number.MIN_VALUE, // the smallest denormal
      2 ** -1022, // the smallest normal
      1 - Number.EPSILON / 2,
    ];
    for (const v of boundaries) {
      const g = genotypeWith(1);
      g.hue = v;
      g.symmetric = v;
      g.frame.family = v;
      g.frame.segments[0].nodeCount = v;
      g.frame.segments[0].nodes[0].gap = v;
      g.axles[0].suspType = v;
      g.axles[0].asym.centerOffset = v;
      assertRoundTrip(g, `boundary ${v}`);
    }
  });

  test('signed zero keeps its sign bit through both directions', () => {
    // -0 is a legal gene (checkGene accepts it: -0 < 0 is false) and appears
    // in no committed corpus, so only a hand-built case covers it. A decoder
    // that normalized it would pass every toEqual test ever written.
    const g = genotypeWith(1);
    g.hue = -0;
    g.axles[0].asym.driveBias = -0;
    const bytes = serializeGenotype(g);
    // The f64 sign byte of `hue` (offset 2, little-endian => byte 9).
    expect(bytes[9]).toBe(0x80);
    const decoded = deserializeGenotype(bytes);
    expect(Object.is(decoded.hue, -0)).toBe(true);
    expect(Object.is(decoded.axles[0].asym.driveBias, -0)).toBe(true);
    assertRoundTrip(g, 'signed zero');
  });

  test('a 7-axle genotype round-trips (the wire domain exceeds the repair cap)', () => {
    // validateGenotype imposes no axle cap; maxAxles is repair POLICY. The
    // codec's domain is the wire's, so an un-repaired 7-axle genotype is legal
    // here even though repair would truncate it.
    assertRoundTrip(genotypeWith(7), 'seven axles');
    expect(serializeGenotype(genotypeWith(7)).length).toBe(genotypeByteLength(7));
  });

  test('the u8 axle-count wire bound fails loud instead of wrapping', () => {
    const g = genotypeWith(0);
    g.axles = Array.from({ length: 256 }, () => genotypeWith(1).axles[0]);
    expect(() => serializeGenotype(g)).toThrow(/assembly: invalid genotype at axles\.length \(256 exceeds the u8 wire bound/);
  });
});

describe('locked-corpus inversion (seed 20260710, n=256)', () => {
  // Construction copy-declared from tests/assembly.test.js: raw draw -> repair.
  const corpus = Array.from({ length: CORPUS_SIZE }, (_, i) => repairGenotype(randomGenotype(new Rng(CORPUS_SEED).fork(i))));

  test('every member of the fingerprinted corpus decodes and re-encodes exactly', () => {
    for (let i = 0; i < corpus.length; i += 1) {
      const bytes = serializeGenotype(corpus[i]);
      const decoded = deserializeGenotype(bytes);
      assertBitEqual(decoded, corpus[i], `corpus[${i}]`);
      expect(bytesEqual(serializeGenotype(decoded), bytes), `corpus[${i}] re-encode`).toBe(true);
    }
  });

  test('the corpus spans every axle count 0..6 (so the inversion is not narrow)', () => {
    const counts = new Set(corpus.map((g) => g.axles.length));
    expect([...counts].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('boundary-value sprinkle corpus (seed 20260732, n=64)', () => {
  // Valid-but-non-canonical genotypes: serializeGenotype only runs
  // validateGenotype, so repair-instability is irrelevant here. Special values
  // are drawn from the legal domain — NaN/Infinity live in the negatives.
  const SPECIALS = [0, 1, -0, 0.5, 0.5 - Number.EPSILON / 2, 0.5 + Number.EPSILON,
    Number.MIN_VALUE, 2 ** -1022, 1 - Number.EPSILON / 2];

  const sprinkle = Array.from({ length: SPRINKLE_SIZE }, (_, i) => {
    const rng = new Rng(SPRINKLE_SEED).fork(i);
    const g = genotypeWith(i % 7);
    const pick = () => SPECIALS[rng.int(0, SPECIALS.length)];
    const maybe = (v) => (rng.nextFloat() < 0.25 ? pick() : v);
    // Explicit walk in the declared shape — never a reflective one.
    g.hue = maybe(g.hue);
    g.symmetric = maybe(g.symmetric);
    g.power = maybe(g.power);
    g.frameDensity = maybe(g.frameDensity);
    g.frame.family = maybe(g.frame.family);
    const seg = g.frame.segments[0];
    seg.nodeCount = maybe(seg.nodeCount);
    for (const node of seg.nodes) {
      node.gap = maybe(node.gap);
      node.height = maybe(node.height);
      node.halfWidth = maybe(node.halfWidth);
      node.thickness = maybe(node.thickness);
    }
    seg.fam.spine.beamWidthFrac = maybe(seg.fam.spine.beamWidthFrac);
    seg.fam.ladder.crossFrac = maybe(seg.fam.ladder.crossFrac);
    seg.fam.hull.bulge = maybe(seg.fam.hull.bulge);
    for (const a of g.axles) {
      for (const k of ['posX01', 'paired', 'trackHalf', 'radius', 'width', 'density',
        'suspType', 'stiffness', 'damping', 'travel', 'restLength', 'driven', 'share']) {
        a[k] = maybe(a[k]);
      }
      for (const k of ['driveBias', 'sizeBias', 'centerOffset']) a.asym[k] = maybe(a.asym[k]);
    }
    return g;
  });

  test('every sprinkled genotype round-trips bit-exactly', () => {
    for (let i = 0; i < sprinkle.length; i += 1) assertRoundTrip(sprinkle[i], `sprinkle[${i}]`);
  });

  test('the corpus actually exercises the special values (not a vacuous pass)', () => {
    const negZero = sprinkle.some((g) => Object.is(g.hue, -0)
      || g.axles.some((a) => Object.is(a.asym.centerOffset, -0)));
    const extremes = sprinkle.some((g) => g.power === 1 || g.power === 0);
    expect(negZero || extremes).toBe(true);
    expect(new Set(sprinkle.map((g) => g.axles.length)).size).toBe(7);
  });
});

describe('malformed streams fail loud, never repair', () => {
  const base = () => serializeGenotype(genotypeWith(2)); // 524 bytes
  const tampered = (mutate) => {
    const bytes = base();
    mutate(new DataView(bytes.buffer), bytes);
    return bytes;
  };

  test('truncation at every structural boundary', () => {
    const full = base();
    for (const cut of [0, 1, 2, 5, 267, 268, 332, 523]) {
      expect(() => deserializeGenotype(full.slice(0, cut)), `cut ${cut}`)
        .toThrow(/assembly: invalid encoded genotype at byteLength/);
    }
  });

  test('trailing bytes', () => {
    const full = base();
    const extended = new Uint8Array(full.length + 1);
    extended.set(full);
    expect(() => deserializeGenotype(extended))
      .toThrow(/assembly: invalid encoded genotype at byteLength \(525 \(expected 524/);
  });

  test('an unknown version', () => {
    for (const v of [0, 2, 0xffff]) {
      const bytes = tampered((view) => view.setUint16(0, v, true));
      expect(() => deserializeGenotype(bytes), `version ${v}`)
        .toThrow(new RegExp(`assembly: invalid encoded genotype at version \\(${v}\\)`));
    }
  });

  test('a malformed segment count', () => {
    for (const n of [0, 2, 0xff]) {
      const bytes = tampered((view) => view.setUint8(42, n));
      expect(() => deserializeGenotype(bytes), `segments ${n}`)
        .toThrow(/assembly: invalid encoded genotype at frame\.segments\.length/);
    }
  });

  test('an axle count that disagrees with the payload length', () => {
    for (const n of [1, 3, 0]) {
      const bytes = tampered((view) => view.setUint8(267, n));
      expect(() => deserializeGenotype(bytes), `axleCount ${n}`)
        .toThrow(/assembly: invalid encoded genotype at byteLength \(524 \(expected/);
    }
  });

  test('an out-of-domain gene patched into the bytes (NaN, >1, <0, Infinity)', () => {
    for (const v of [NaN, 1.5, -(2 ** -1074), Infinity, -Infinity]) {
      // Offset 2 is `hue`; offset 268 is axles[0].posX01.
      for (const offset of [2, 268]) {
        const bytes = tampered((view) => view.setFloat64(offset, v, true));
        expect(() => deserializeGenotype(bytes), `${v} @ ${offset}`)
          .toThrow(/assembly: invalid genotype at/);
      }
    }
  });

  test('a non-Uint8Array input', () => {
    for (const bad of [null, undefined, [1, 2, 3], 'bytes', new Uint16Array(300)]) {
      expect(() => deserializeGenotype(bad)).toThrow(/assembly: invalid encoded genotype at bytes/);
    }
  });
});

describe('decoder hygiene', () => {
  test('the input bytes are never mutated', () => {
    const bytes = serializeGenotype(genotypeWith(3));
    const before = Uint8Array.from(bytes);
    deserializeGenotype(bytes);
    expect(bytesEqual(bytes, before)).toBe(true);
  });

  test('a subarray view decodes its OWN window, not the parent buffer', () => {
    const g = genotypeWith(2);
    const bytes = serializeGenotype(g);
    const parent = new Uint8Array(64 + bytes.length + 32).fill(0xcd);
    parent.set(bytes, 64);
    const window = parent.subarray(64, 64 + bytes.length);
    assertBitEqual(deserializeGenotype(window), g, 'subarray');
  });

  test('the decoded genotype is a plain mutable object in canonical shape', () => {
    const decoded = deserializeGenotype(serializeGenotype(genotypeWith(1)));
    expect(Object.keys(decoded).sort()).toEqual(['axles', 'frame', 'frameDensity', 'hue', 'power', 'symmetric', 'version']);
    expect(Object.keys(decoded.axles[0]).sort()).toEqual([
      'asym', 'damping', 'density', 'driven', 'paired', 'posX01', 'radius',
      'restLength', 'share', 'stiffness', 'suspType', 'trackHalf', 'travel', 'width',
    ]);
    // No repair happened: the decoded object is exactly what the bytes said.
    expect(decoded.axles[0].radius).toBe(0.33);
  });
});
