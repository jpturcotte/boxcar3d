// The genotype schema walk vs the canonical serializer — the drift triangle.
//
// ROLES (stated in assembly.js and enforced here): serializeGenotype is the
// canonical byte-layout AUTHORITY; genotypeFieldWalk is a validated METADATA
// MIRROR. Three legs bind them so neither can move alone:
//
//   Leg 1  a COPY-DECLARED literal walk (paths, kinds, types, hand-computed
//          offsets) === genotypeFieldWalk(n). Fails if schema and serializer
//          ever move TOGETHER, or if a field is reordered / omitted / added to
//          one representation only / reclassified discrete<->continuous.
//   Leg 2  the derivation identities: axle blocks are a uniform stride-128
//          template (array-order proof at every count without a 6x literal),
//          and the entries TILE [0, serializeGenotype(...).length) exactly.
//   Leg 3  perturb ONE leaf -> the real serializer's bytes differ inside that
//          entry's window and are byte-identical everywhere else. This is the
//          leg that binds the mirror to the actual encoder.
//
// Plus: the classification teeth (discrete set === DISCRETE_GENE_KEYS, leaf-key
// uniqueness), schema<->validator agreement, static-ness, and a cross-check
// against the integrity probe's independent reflection walk.
//
// No seed: every input here is hand-built or derived, deliberately.

import { describe, test, expect } from 'vitest';
import {
  DISCRETE_GENE_KEYS,
  FRAME_FAMILIES,
  GENOTYPE_VERSION,
  NODE_SLOTS,
  SUSPENSION_TYPES,
  compileAssembly,
  forEachGenotypeField,
  genotypeByteLength,
  genotypeFieldWalk,
  randomGenotype,
  repairGenotype,
  serializeGenotype,
} from '../src/sim/assembly.js';
import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHexOf } from '../src/sim/fnv1a.js';
import { jitterGenotype } from '../scripts/probe-integrity.js';
import { Rng } from '../src/sim/prng.js';

// A hand-built genotype with a settable axle count. Values are distinct enough
// that a single-leaf perturbation always changes bytes.
function genotypeWith(axleCount) {
  const node = (i) => ({
    gap: 0.1 + i * 0.01,
    height: 0.2 + i * 0.01,
    halfWidth: 0.3 + i * 0.01,
    thickness: 0.4 + i * 0.01,
  });
  const axle = (a) => ({
    posX01: 0.11 + a * 0.001,
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
  };
}

// Test-local path get/set. Reflection is fine HERE (a test may introspect);
// the production walk is explicit by ruling.
function setLeaf(genotype, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let node = genotype;
  for (let i = 0; i < parts.length - 1; i += 1) node = node[parts[i]];
  node[parts[parts.length - 1]] = value;
}
function getLeaf(genotype, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let node = genotype;
  for (const p of parts) node = node[p];
  return node;
}

// Explicit deep clone (no structuredClone: not in the lint env's globals).
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = clone(value[k]);
    return out;
  }
  return value;
}
// THE INDEPENDENT CONTRACT. Copy-declared on purpose: production classifies by
// consulting DISCRETE_GENE_KEYS, so deriving the EXPECTED kinds from that same
// constant would make every classification assertion circular — delete
// 'suspType' from the constant and production reclassifies it as continuous,
// the expectation follows, and the suite stays green while a future parametric
// operator gains permission to cross an enum-band boundary. This literal is the
// thing that must be edited deliberately.
const EXPECTED_DISCRETE_GENE_KEYS = Object.freeze([
  'family', 'suspType', 'symmetric', 'paired', 'driven', 'nodeCount',
]);

const kindOf = (key) => (EXPECTED_DISCRETE_GENE_KEYS.includes(key) ? 'discrete' : 'continuous');

// --- Leg 1: the copy-declared literal walk ----------------------------------
//
// Hand-computed offsets: u16 version at 0; the five leading f64 genes at
// 2/10/18/26/34; segmentCount u8 at 42; nodeCount f64 at 43; node i leaf j at
// 51 + 32i + 8j; the three fam leaves at 243/251/259; axleCount u8 at 267;
// axle a leaf j at 268 + 128a + 8j.

function expectedPrefixWalk() {
  const walk = [
    { path: 'version', key: 'version', type: 'u16', kind: 'version', byteOffset: 0, byteLength: 2 },
    { path: 'hue', key: 'hue', type: 'f64', kind: 'continuous', byteOffset: 2, byteLength: 8 },
    { path: 'symmetric', key: 'symmetric', type: 'f64', kind: 'discrete', byteOffset: 10, byteLength: 8 },
    { path: 'power', key: 'power', type: 'f64', kind: 'continuous', byteOffset: 18, byteLength: 8 },
    { path: 'frameDensity', key: 'frameDensity', type: 'f64', kind: 'continuous', byteOffset: 26, byteLength: 8 },
    { path: 'frame.family', key: 'family', type: 'f64', kind: 'discrete', byteOffset: 34, byteLength: 8 },
    { path: 'frame.segments.length', key: 'segmentCount', type: 'u8', kind: 'structural', byteOffset: 42, byteLength: 1 },
    { path: 'frame.segments[0].nodeCount', key: 'nodeCount', type: 'f64', kind: 'discrete', byteOffset: 43, byteLength: 8 },
  ];
  const NODE_KEYS = ['gap', 'height', 'halfWidth', 'thickness'];
  for (let i = 0; i < 6; i += 1) {
    NODE_KEYS.forEach((k, j) => {
      walk.push({
        path: `frame.segments[0].nodes[${i}].${k}`,
        key: k,
        type: 'f64',
        kind: 'continuous',
        byteOffset: 51 + 32 * i + 8 * j,
        byteLength: 8,
      });
    });
  }
  walk.push({ path: 'frame.segments[0].fam.spine.beamWidthFrac', key: 'beamWidthFrac', type: 'f64', kind: 'continuous', byteOffset: 243, byteLength: 8 });
  walk.push({ path: 'frame.segments[0].fam.ladder.crossFrac', key: 'crossFrac', type: 'f64', kind: 'continuous', byteOffset: 251, byteLength: 8 });
  walk.push({ path: 'frame.segments[0].fam.hull.bulge', key: 'bulge', type: 'f64', kind: 'continuous', byteOffset: 259, byteLength: 8 });
  walk.push({ path: 'axles.length', key: 'axleCount', type: 'u8', kind: 'structural', byteOffset: 267, byteLength: 1 });
  return walk;
}

// The per-axle block, copy-declared in AXLE_GENES then ASYM_GENES order.
const AXLE_BLOCK = [
  ['posX01', 'axles[%].posX01'],
  ['paired', 'axles[%].paired'],
  ['trackHalf', 'axles[%].trackHalf'],
  ['radius', 'axles[%].radius'],
  ['width', 'axles[%].width'],
  ['density', 'axles[%].density'],
  ['suspType', 'axles[%].suspType'],
  ['stiffness', 'axles[%].stiffness'],
  ['damping', 'axles[%].damping'],
  ['travel', 'axles[%].travel'],
  ['restLength', 'axles[%].restLength'],
  ['driven', 'axles[%].driven'],
  ['share', 'axles[%].share'],
  ['driveBias', 'axles[%].asym.driveBias'],
  ['sizeBias', 'axles[%].asym.sizeBias'],
  ['centerOffset', 'axles[%].asym.centerOffset'],
];

function expectedWalk(axleCount) {
  const walk = expectedPrefixWalk();
  for (let a = 0; a < axleCount; a += 1) {
    AXLE_BLOCK.forEach(([key, template], j) => {
      walk.push({
        path: template.replace('%', String(a)),
        key,
        type: 'f64',
        kind: kindOf(key),
        byteOffset: 268 + 128 * a + 8 * j,
        byteLength: 8,
      });
    });
  }
  return walk;
}

describe('Leg 1 — the schema walk equals the copy-declared literal', () => {
  test('the 36-entry fixed prefix (axleCount 0)', () => {
    const walk = genotypeFieldWalk(0);
    expect(walk).toHaveLength(36);
    expect(walk.map((e) => ({ ...e }))).toEqual(expectedWalk(0));
  });

  test('the 68-entry two-axle walk (36 prefix + 2 x 16)', () => {
    const walk = genotypeFieldWalk(2);
    expect(walk).toHaveLength(68);
    expect(walk.map((e) => ({ ...e }))).toEqual(expectedWalk(2));
  });

  test('the maximum-topology walk (6 axles = 132 entries)', () => {
    const walk = genotypeFieldWalk(6);
    expect(walk).toHaveLength(36 + 6 * 16);
    expect(walk.map((e) => ({ ...e }))).toEqual(expectedWalk(6));
  });

  test('entries are frozen, so a consumer cannot mutate the shared metadata', () => {
    for (const entry of genotypeFieldWalk(1)) expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe('Leg 2 — derivation identities (array order, tiling, total length)', () => {
  test('axle blocks are a uniform stride-128 template at every count', () => {
    const prefix = genotypeFieldWalk(0);
    for (const n of [1, 2, 3, 6]) {
      const walk = genotypeFieldWalk(n);
      expect(walk.slice(0, 36).map((e) => ({ ...e }))).toEqual(prefix.map((e) => ({ ...e })));
      const template = walk.slice(36, 52);
      for (let a = 1; a < n; a += 1) {
        const block = walk.slice(36 + 16 * a, 36 + 16 * (a + 1));
        block.forEach((entry, j) => {
          expect(entry.key).toBe(template[j].key);
          expect(entry.kind).toBe(template[j].kind);
          expect(entry.type).toBe(template[j].type);
          expect(entry.byteOffset).toBe(template[j].byteOffset + 128 * a);
          expect(entry.path).toBe(template[j].path.replace('axles[0]', `axles[${a}]`));
        });
      }
    }
  });

  test('entries tile [0, byteLength) with no gap or overlap, and match the real serializer', () => {
    for (let n = 0; n <= 7; n += 1) {
      const walk = genotypeFieldWalk(n);
      let offset = 0;
      for (const entry of walk) {
        expect(entry.byteOffset, `${entry.path} at n=${n}`).toBe(offset);
        offset += entry.byteLength;
      }
      expect(offset).toBe(genotypeByteLength(n));
      // The authority: the serializer's own output length.
      expect(serializeGenotype(genotypeWith(n)).length).toBe(offset);
    }
  });

  test('genotypeByteLength rejects a non-integer or out-of-u8 axle count', () => {
    for (const bad of [-1, 1.5, 256, NaN, '2', null]) {
      expect(() => genotypeByteLength(bad), String(bad)).toThrow(/assembly: invalid genotype at axleCount/);
    }
  });
});

describe('Leg 3 — perturbing one leaf moves exactly its own bytes', () => {
  // The binding leg: schema-predicted windows vs the REAL serializer.
  for (const axleCount of [0, 2, 6]) {
    test(`single-leaf byte exclusivity at ${axleCount} axles`, () => {
      const base = genotypeWith(axleCount);
      const baseBytes = serializeGenotype(base);
      const walk = genotypeFieldWalk(axleCount);
      for (const entry of walk) {
        if (entry.kind === 'version' || entry.kind === 'structural') continue; // not gene leaves
        const mutant = clone(base);
        const original = getLeaf(mutant, entry.path);
        setLeaf(mutant, entry.path, original === 0.123456789 ? 0.987654321 : 0.123456789);
        const bytes = serializeGenotype(mutant);
        expect(bytes.length).toBe(baseBytes.length);
        const differing = [];
        for (let i = 0; i < bytes.length; i += 1) if (bytes[i] !== baseBytes[i]) differing.push(i);
        expect(differing.length, `${entry.path} changed no bytes`).toBeGreaterThan(0);
        for (const i of differing) {
          expect(
            i >= entry.byteOffset && i < entry.byteOffset + entry.byteLength,
            `${entry.path} moved byte ${i} outside its window [${entry.byteOffset}, ${entry.byteOffset + entry.byteLength})`,
          ).toBe(true);
        }
      }
    });
  }

  test('the header/structural fields sit at their schema-predicted offsets', () => {
    for (const axleCount of [0, 2, 6]) {
      const bytes = serializeGenotype(genotypeWith(axleCount));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const walk = genotypeFieldWalk(axleCount);
      const at = (path) => walk.find((e) => e.path === path);
      expect(view.getUint16(at('version').byteOffset, true)).toBe(GENOTYPE_VERSION);
      expect(view.getUint8(at('frame.segments.length').byteOffset)).toBe(1);
      expect(view.getUint8(at('axles.length').byteOffset)).toBe(axleCount);
    }
  });
});

// --- The decode tables: what the archived bytes MEAN -----------------------
//
// Round 11 (completeness pass). Every codec test in this repo asks "do the same
// bytes come back?" — none asked "do the same bytes still describe the same
// vehicle?" Measured on a copy of assembly.js with SUSPENSION_TYPES reordered
// to ['S1','S0','S2']: EVERY archived axle's suspension type flips, and BOTH
// locked fingerprints stay byte-identical —
//
//   head         corpus= 24cd0dd5  chassis= 39bcd6c4
//   suspSwapped  corpus= 24cd0dd5  chassis= 39bcd6c4   <-- every axle flipped
//
// because `24cd0dd5` hashes raw [0,1] GENES and `39bcd6c4` hashes chassis
// colliders, which derive only from frame genes. The sole prior guard was one
// incidental assertion in a repair test, and genotype-codec.test.js:139 is
// self-referential on both sides (`SUSPENSION_TYPES[...]` twice) — the exact
// shape this file bans for DISCRETE_GENE_KEYS. `FRAME_FAMILIES` is caught only
// incidentally, because repair depends on family geometry.
//
// This is precisely the failure the replay/import tooling exists to prevent: a
// semantic reinterpretation of every stored stream that the artifacts the
// project calls "the identity" cannot see. Pre-existing, not a PR-#23 defect.

const EXPECTED_FRAME_FAMILIES = Object.freeze(['spine', 'ladder', 'hull']);
const EXPECTED_SUSPENSION_TYPES = Object.freeze(['S0', 'S1', 'S2']);

// One line per corpus member: family, then per axle its suspension type, wheel
// count, and each wheel's drive flag + radius. Deliberately NOT a byte hash of
// the genotype — it is the DECODED MEANING, which is the thing no existing lock
// covers. Seed 20260710, N=256, the same corpus construction as `24cd0dd5`.
const PHENOTYPE_DIGEST = '341c2830';

describe('decode tables — the archived bytes still mean the same vehicle', () => {
  test('the enum orders are pinned by copy-declared literals', () => {
    // Production DECODES by these constants, so the expectation must be an
    // independent literal — the DISCRETE_GENE_KEYS argument, applied to the
    // tables that turn a gene band into a phenotype.
    expect([...FRAME_FAMILIES]).toEqual([...EXPECTED_FRAME_FAMILIES]);
    expect([...SUSPENSION_TYPES]).toEqual([...EXPECTED_SUSPENSION_TYPES]);
  });

  test('the seed-20260710 corpus decodes to the same phenotypes', () => {
    // Ordinary ASCII, folded without TextEncoder (not in the lint env's
    // declared globals, and widening those for one test is the wrong trade).
    const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    let state = FNV_OFFSET_BASIS;
    for (let i = 0; i < 256; i += 1) {
      const ir = compileAssembly(repairGenotype(randomGenotype(new Rng(20260710).fork(i))));
      const parts = [ir.chassis.family];
      for (let a = 0; a < ir.axles.length; a += 1) {
        const axle = ir.axles[a];
        const wheels = axle.wheels
          .map((w) => `${w.driveTorque > 0 ? 'D' : 'F'}${w.radius.toFixed(6)}`)
          .join(',');
        parts.push(`${axle.suspension.type}:${axle.wheels.length}:${wheels}`);
      }
      state = fnv1aFold(state, enc(parts.join('|')));
    }
    // Changing this is a deliberate re-lock: it means every archived genotype
    // now describes a different vehicle, which is a genotype-VERSION event.
    expect(fnv1aHexOf(state)).toBe(PHENOTYPE_DIGEST);
  });
});

describe('classification teeth', () => {
  test('DISCRETE_GENE_KEYS equals the independently copy-declared contract', () => {
    // The tooth that breaks the circle: production classifies BY this constant,
    // so nothing else in this file may derive its expectations from it. Dropping
    // a key here must be a deliberate edit to this literal, not a silent
    // consequence of editing assembly.js.
    expect([...DISCRETE_GENE_KEYS]).toEqual([...EXPECTED_DISCRETE_GENE_KEYS]);
  });

  test('the discrete leaf keys are exactly the contract set', () => {
    const walk = genotypeFieldWalk(3);
    const discrete = [...new Set(walk.filter((e) => e.kind === 'discrete').map((e) => e.key))].sort();
    expect(discrete).toEqual([...EXPECTED_DISCRETE_GENE_KEYS].sort());
  });

  test('every discrete key appears at every occurrence it should, WITH its kind', () => {
    const walk = genotypeFieldWalk(3);
    const entries = (key) => walk.filter((e) => e.key === key);
    const paths = (key) => entries(key).map((e) => e.path);
    expect(paths('symmetric')).toEqual(['symmetric']);
    expect(paths('family')).toEqual(['frame.family']);
    expect(paths('nodeCount')).toEqual(['frame.segments[0].nodeCount']);
    for (const key of ['paired', 'suspType', 'driven']) {
      expect(paths(key), key).toEqual(['axles[0]', 'axles[1]', 'axles[2]'].map((a) => `${a}.${key}`));
    }
    // Paths alone are not enough — assert the KIND of every occurrence against
    // the copy-declared contract, so a reclassification cannot slip through a
    // path-only check.
    for (const key of EXPECTED_DISCRETE_GENE_KEYS) {
      const found = entries(key);
      expect(found.length, `${key} has no occurrences`).toBeGreaterThan(0);
      for (const e of found) expect(e.kind, `${e.path} is not discrete`).toBe('discrete');
    }
    // And the converse: every leaf NOT in the contract is continuous or
    // structural — never silently discrete.
    for (const e of walk) {
      if (EXPECTED_DISCRETE_GENE_KEYS.includes(e.key)) continue;
      expect(e.kind, `${e.path} is unexpectedly discrete`).not.toBe('discrete');
    }
  });

  test('no continuous leaf shares a key with a discrete one (the key-uniqueness assumption)', () => {
    const walk = genotypeFieldWalk(6);
    const byKey = new Map();
    for (const e of walk) {
      if (!byKey.has(e.key)) byKey.set(e.key, new Set());
      byKey.get(e.key).add(e.kind);
    }
    for (const [key, kinds] of byKey) {
      expect([...kinds], `key ${key} carries mixed kinds`).toHaveLength(1);
    }
  });

  test('structural entries are array lengths, never [0,1] genes', () => {
    const g = genotypeWith(4);
    const seen = new Map();
    forEachGenotypeField(g, (e) => { if (e.kind === 'structural') seen.set(e.path, e.value); });
    expect([...seen]).toEqual([['frame.segments.length', 1], ['axles.length', 4]]);
  });
});

describe('schema <-> validator agreement', () => {
  test('every f64 gene leaf in the walk is domain-checked by the serializer', () => {
    // A leaf present in the walk but missing from validateGenotype (or vice
    // versa) shows up here: NaN at that path must be refused.
    // 68 entries - the u16 version - the two u8 structural lengths = 65 genes
    // (33 in the fixed prefix: 6 leading + 24 node leaves + 3 fam; plus 2x16).
    const walk = genotypeFieldWalk(2).filter((e) => e.type === 'f64');
    expect(walk.length).toBe(65);
    for (const entry of walk) {
      const mutant = genotypeWith(2);
      setLeaf(mutant, entry.path, NaN);
      expect(() => serializeGenotype(mutant), entry.path)
        .toThrow(new RegExp(`assembly: invalid genotype at .*${entry.key}`));
    }
  });
});

describe('static-ness and value iteration', () => {
  test('the walk is a pure function of axle count', () => {
    const a = genotypeFieldWalk(3).map((e) => ({ ...e }));
    const b = genotypeFieldWalk(3).map((e) => ({ ...e }));
    expect(a).toEqual(b);
    // ...and carries no value fields without a genotype.
    for (const e of genotypeFieldWalk(3)) expect('value' in e).toBe(false);
  });

  test('forEachGenotypeField visits exactly the walk, in order, with exact values', () => {
    for (const g of [genotypeWith(0), genotypeWith(2)]) {
      const walk = genotypeFieldWalk(g.axles.length);
      const visited = [];
      forEachGenotypeField(g, (e) => visited.push(e));
      expect(visited.map((e) => e.path)).toEqual(walk.map((e) => e.path));
      for (const e of visited) {
        if (e.kind === 'version') expect(Object.is(e.value, g.version)).toBe(true);
        else if (e.path === 'frame.segments.length') expect(e.value).toBe(1);
        else if (e.path === 'axles.length') expect(e.value).toBe(g.axles.length);
        else expect(Object.is(e.value, getLeaf(g, e.path)), e.path).toBe(true);
      }
    }
  });

  test('forEachGenotypeField validates first and rejects a bad visitor', () => {
    const bad = genotypeWith(1);
    bad.hue = 2;
    expect(() => forEachGenotypeField(bad, () => {})).toThrow(/assembly: invalid genotype at hue/);
    expect(() => forEachGenotypeField(genotypeWith(1), null)).toThrow(/assembly: invalid genotype at visit/);
  });

  test('forEachGenotypeField shares the WIRE domain, not validateGenotype\'s uncapped one', () => {
    // The walk describes canonical serialization order, so it must refuse what
    // the serializer refuses: otherwise it would hand a consumer byteOffsets
    // for a stream that cannot exist. validateGenotype stays deliberately
    // uncapped for in-memory genotypes — that asymmetry is the point.
    const huge = genotypeWith(0);
    huge.axles = Array.from({ length: 256 }, () => genotypeWith(1).axles[0]);
    expect(() => serializeGenotype(huge)).toThrow(/axles\.length \(256 exceeds the u8 wire bound/);
    expect(() => genotypeFieldWalk(256)).toThrow(/assembly: invalid genotype at axleCount/);
    expect(() => forEachGenotypeField(huge, () => {})).toThrow(/assembly: invalid genotype at axleCount/);
    // ...while the largest wire-representable count still walks.
    const max = genotypeWith(0);
    max.axles = Array.from({ length: 255 }, () => genotypeWith(1).axles[0]);
    let visited = 0;
    forEachGenotypeField(max, () => { visited += 1; });
    expect(visited).toBe(36 + 255 * 16);
  });
});

describe('cross-check: the integrity probe\'s independent leaf walk', () => {
  // scripts/probe-integrity.js walks genotypes by its own sorted-key
  // reflection, preserving `version` + DISCRETE_GENE_KEYS and perturbing every
  // other numeric leaf. That walk order is load-bearing for the committed
  // seed-20260731 neighborhood measurements, so it is NOT refactored onto the
  // schema — instead the two must agree on WHICH leaves are perturbable.
  //
  // Compared as a PATH MULTISET, not a key set: keys repeat across node slots
  // and axles, so a key-set comparison would not notice an omitted occurrence.
  const collectNumericPaths = (a, b) => {
    const changed = [];
    const preserved = [];
    const walk = (x, y, path) => {
      if (Array.isArray(x)) { x.forEach((v, i) => walk(v, y[i], `${path}[${i}]`)); return; }
      if (typeof x === 'object' && x !== null) {
        for (const k of Object.keys(x)) walk(x[k], y[k], path === '' ? k : `${path}.${k}`);
        return;
      }
      if (typeof x === 'number') (Object.is(x, y) ? preserved : changed).push(path);
    };
    walk(a, b, '');
    return { changed, preserved };
  };

  test('the probe perturbs exactly the schema\'s continuous leaves', () => {
    const parent = genotypeWith(3);
    // magnitude 0.05 with mid-range values: every perturbed leaf moves (no
    // clamp can pin one, so "unchanged" means "not a target").
    const child = jitterGenotype(parent, 0.05, new Rng(20260731).fork(0));
    const { changed, preserved } = collectNumericPaths(parent, child);
    // Partition the walk by the COPY-DECLARED contract, not by the schema's own
    // `kind` — the probe and production both consult DISCRETE_GENE_KEYS, so
    // splitting on `kind` would let a reclassification move both sides together
    // and keep this green. Paths and keys come from the walk (Leg 1 pins those
    // against a literal); only the partition is anchored independently.
    const walk = genotypeFieldWalk(3).filter((e) => e.type === 'f64' || e.kind === 'version');
    const expectedPerturbed = walk
      .filter((e) => e.kind !== 'version' && !EXPECTED_DISCRETE_GENE_KEYS.includes(e.key))
      .map((e) => e.path).sort();
    const expectedPreserved = walk
      .filter((e) => e.kind === 'version' || EXPECTED_DISCRETE_GENE_KEYS.includes(e.key))
      .map((e) => e.path).sort();
    // The probe's path spelling matches the schema's (both index arrays), so
    // the two multisets compare directly.
    expect(changed.slice().sort()).toEqual(expectedPerturbed);
    expect(preserved.slice().sort()).toEqual(expectedPreserved);
  });
});
