// Pure tests for the genotype SCHEMA WALK (src/sim/assembly.js
// genotypeFieldWalk / forEachGenotypeField) — no Rapier, no physics.
//
// The load-bearing proof is the DRIFT TRIANGLE: a copy-declared literal walk
// (this file), the schema walker, and the real serializer must agree
// EXACTLY — the walk is a metadata mirror of serializeGenotype's locked byte
// layout (ruling R-A), and any drift between them would silently misdirect
// the parametric-mutation traversal the walk exists for. Covered here:
//   (1) hand-computed literals for the 0-axle (36) and 2-axle (68) walks;
//   (2) the per-axle stride derivation + exact tiling of [0, 268+128n);
//   (3) perturb-one-leaf byte EXCLUSIVITY against the real serializer;
//   (4) classification teeth (discrete key set, name uniqueness);
//   (5) schema <-> validator agreement (every f64 leaf gated);
//   (6) static-ness + forEachGenotypeField order/values;
//   (7) the probe cross-check (full path MULTISET — scripts/probe-integrity.js
//       jitterGenotype's sorted-key walk, copy-declared; the probe itself is
//       NOT refactored: its walk order is load-bearing for the committed
//       seed-20260731 neighborhood measurements).

import { describe, test, expect } from 'vitest';
import {
  DISCRETE_GENE_KEYS,
  GENOTYPE_VERSION,
  NODE_SLOTS,
  forEachGenotypeField,
  genotypeByteLength,
  genotypeFieldWalk,
  serializeGenotype,
} from '../src/sim/assembly.js';

// --- Copy-declared helpers ----------------------------------------------------

const deepClone = (node) => {
  if (Array.isArray(node)) return node.map(deepClone);
  if (typeof node === 'object' && node !== null) {
    const out = {};
    for (const k of Object.keys(node)) out[k] = deepClone(node[k]);
    return out;
  }
  return node;
};

// A canonical-shape hand genotype (domain-valid by construction; the schema
// tests never repair).
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
function genotypeWithAxles(axleCount) {
  return {
    version: GENOTYPE_VERSION,
    hue: 0.25,
    symmetric: 0.9,
    power: 0.5,
    frameDensity: 0.3,
    frame: {
      family: 0.1, // spine
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: NODE_SLOTS }, handNode),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: Array.from({ length: axleCount }, (_, i) => handAxle((i + 1) / (axleCount + 1))),
  };
}

// Resolve the parent container + final key of a schema path on a genotype
// INSTANCE. Schema paths are spelled in serialization order, not object
// nesting: 'nodes[i].*' and 'fam.*' abbreviate 'frame.segments[0].nodes[i].*'
// and 'frame.segments[0].fam.*' (declared expansion below).
const EXPAND_PATH = (path) => path
  .replace(/^nodes\[/, 'frame.segments[0].nodes[')
  .replace(/^fam\./, 'frame.segments[0].fam.');
function leafContainer(genotype, path) {
  const segments = EXPAND_PATH(path).split('.');
  let node = genotype;
  for (const seg of segments.slice(0, -1)) {
    const m = /^([A-Za-z0-9]+)(?:\[(\d+)\])?$/.exec(seg);
    node = m[2] === undefined ? node[m[1]] : node[m[1]][Number(m[2])];
  }
  const last = /^([A-Za-z0-9]+)(?:\[(\d+)\])?$/.exec(segments[segments.length - 1]);
  return last[2] === undefined
    ? { container: node, key: last[1] }
    : { container: node[last[1]], key: Number(last[2]) };
}

// --- (1) The copy-declared literal walks --------------------------------------
//
// Every entry hand-computed from the documented fixed layout: u16 version;
// f64 hue, symmetric, power, frameDensity; f64 family; u8 segmentCount; f64
// nodeCount; 6 x f64 (gap, height, halfWidth, thickness); f64 spine/ladder/
// hull; u8 axleCount; 16 f64 per axle (AXLE_GENES then ASYM_GENES).
const e = (path, key, type, kind, byteOffset, byteLength) => ({ path, key, type, kind, byteOffset, byteLength });
const f64c = (path, key, byteOffset) => e(path, key, 'f64', 'continuous', byteOffset, 8);

const EXPECTED_FIXED_PREFIX = [
  e('version', 'version', 'u16', 'version', 0, 2),
  f64c('hue', 'hue', 2),
  e('symmetric', 'symmetric', 'f64', 'discrete', 10, 8),
  f64c('power', 'power', 18),
  f64c('frameDensity', 'frameDensity', 26),
  e('frame.family', 'family', 'f64', 'discrete', 34, 8),
  e('frame.segments.length', 'segmentCount', 'u8', 'structural', 42, 1),
  e('frame.segments[0].nodeCount', 'nodeCount', 'f64', 'discrete', 43, 8),
  // Node slot 0 (offsets 51 + 32i + 8j).
  f64c('nodes[0].gap', 'gap', 51),
  f64c('nodes[0].height', 'height', 59),
  f64c('nodes[0].halfWidth', 'halfWidth', 67),
  f64c('nodes[0].thickness', 'thickness', 75),
  // Node slot 1.
  f64c('nodes[1].gap', 'gap', 83),
  f64c('nodes[1].height', 'height', 91),
  f64c('nodes[1].halfWidth', 'halfWidth', 99),
  f64c('nodes[1].thickness', 'thickness', 107),
  // Node slot 2.
  f64c('nodes[2].gap', 'gap', 115),
  f64c('nodes[2].height', 'height', 123),
  f64c('nodes[2].halfWidth', 'halfWidth', 131),
  f64c('nodes[2].thickness', 'thickness', 139),
  // Node slot 3.
  f64c('nodes[3].gap', 'gap', 147),
  f64c('nodes[3].height', 'height', 155),
  f64c('nodes[3].halfWidth', 'halfWidth', 163),
  f64c('nodes[3].thickness', 'thickness', 171),
  // Node slot 4.
  f64c('nodes[4].gap', 'gap', 179),
  f64c('nodes[4].height', 'height', 187),
  f64c('nodes[4].halfWidth', 'halfWidth', 195),
  f64c('nodes[4].thickness', 'thickness', 203),
  // Node slot 5.
  f64c('nodes[5].gap', 'gap', 211),
  f64c('nodes[5].height', 'height', 219),
  f64c('nodes[5].halfWidth', 'halfWidth', 227),
  f64c('nodes[5].thickness', 'thickness', 235),
  // The three fam blocks (always serialized, latent for two of them).
  f64c('fam.spine.beamWidthFrac', 'beamWidthFrac', 243),
  f64c('fam.ladder.crossFrac', 'crossFrac', 251),
  f64c('fam.hull.bulge', 'bulge', 259),
  e('axles.length', 'axleCount', 'u8', 'structural', 267, 1),
];

// One 16-entry axle block, hand-computed at stride 128 from base 268.
const axleEntries = (a) => {
  const base = 268 + 128 * a;
  const p = (suffix) => `axles[${a}].${suffix}`;
  return [
    f64c(p('posX01'), 'posX01', base + 0),
    e(p('paired'), 'paired', 'f64', 'discrete', base + 8, 8),
    f64c(p('trackHalf'), 'trackHalf', base + 16),
    f64c(p('radius'), 'radius', base + 24),
    f64c(p('width'), 'width', base + 32),
    f64c(p('density'), 'density', base + 40),
    e(p('suspType'), 'suspType', 'f64', 'discrete', base + 48, 8),
    f64c(p('stiffness'), 'stiffness', base + 56),
    f64c(p('damping'), 'damping', base + 64),
    f64c(p('travel'), 'travel', base + 72),
    f64c(p('restLength'), 'restLength', base + 80),
    e(p('driven'), 'driven', 'f64', 'discrete', base + 88, 8),
    f64c(p('share'), 'share', base + 96),
    f64c(p('asym.driveBias'), 'driveBias', base + 104),
    f64c(p('asym.sizeBias'), 'sizeBias', base + 112),
    f64c(p('asym.centerOffset'), 'centerOffset', base + 120),
  ];
};

const EXPECTED_WALK_0AXLE = [...EXPECTED_FIXED_PREFIX];
const EXPECTED_WALK_2AXLE = [...EXPECTED_FIXED_PREFIX, ...axleEntries(0), ...axleEntries(1)];

describe('genotype schema walk — the drift triangle', () => {
  test('(1) hand-computed literals: 36-entry 0-axle and 68-entry 2-axle walks', () => {
    expect(EXPECTED_WALK_0AXLE.length).toBe(36);
    expect(EXPECTED_WALK_2AXLE.length).toBe(68); // 36 fixed-prefix + 2 x 16
    expect([...genotypeFieldWalk(0)]).toEqual(EXPECTED_WALK_0AXLE);
    expect([...genotypeFieldWalk(2)]).toEqual(EXPECTED_WALK_2AXLE);
    expect(genotypeByteLength(0)).toBe(268);
    expect(genotypeByteLength(2)).toBe(268 + 2 * 128);
  });

  test('(2) stride derivation: walk(6) = 0-axle prefix + 6 shifted copies of one 16-entry axle template', () => {
    const walk0 = genotypeFieldWalk(0);
    const walk1 = genotypeFieldWalk(1);
    const walk6 = genotypeFieldWalk(6);
    expect(walk6.length).toBe(36 + 6 * 16);
    expect([...walk6.slice(0, 36)]).toEqual([...walk0]);
    const template = walk1.slice(36); // axle 0, paths spelled 'axles[0].*'
    expect(template.length).toBe(16);
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 16; j += 1) {
        const actual = walk6[36 + 16 * i + j];
        const t = template[j];
        expect(actual.path).toBe(t.path.replace('axles[0]', `axles[${i}]`));
        expect(actual.key).toBe(t.key);
        expect(actual.type).toBe(t.type);
        expect(actual.kind).toBe(t.kind);
        expect(actual.byteLength).toBe(t.byteLength);
        expect(actual.byteOffset).toBe(t.byteOffset + 128 * i);
      }
    }
  });

  test('(2) widths tile [0, 268+128n) with no gap/overlap, total === serialized length, n = 0..7', () => {
    for (let n = 0; n <= 7; n += 1) {
      const walk = genotypeFieldWalk(n);
      let cursor = 0;
      for (const entry of walk) {
        expect(entry.byteOffset, `gap/overlap before ${entry.path}`).toBe(cursor);
        cursor += entry.byteLength;
      }
      expect(cursor).toBe(268 + 128 * n);
      expect(cursor).toBe(serializeGenotype(genotypeWithAxles(n)).length);
      expect(cursor).toBe(genotypeByteLength(n));
    }
  });

  test('(3) perturb-one-leaf byte EXCLUSIVITY: every gene leaf owns exactly its 8-byte window', () => {
    for (const axleCount of [0, 2, 6]) {
      const genotype = genotypeWithAxles(axleCount);
      const base = serializeGenotype(genotype);
      forEachGenotypeField(genotype, (entry) => {
        if (entry.kind !== 'continuous' && entry.kind !== 'discrete') return; // genes only
        const mutated = deepClone(genotype);
        const { container, key } = leafContainer(mutated, entry.path);
        // A quarter-step inside [0,1] always changes the f64 bit pattern.
        container[key] = entry.value < 0.5 ? entry.value + 0.25 : entry.value - 0.25;
        const after = serializeGenotype(mutated);
        expect(after.length).toBe(base.length);
        // The diffsAgainst idiom: differing bytes must lie ENTIRELY inside
        // the entry's window — every byte outside unchanged.
        const diffs = [];
        for (let i = 0; i < base.length; i += 1) if (base[i] !== after[i]) diffs.push(i);
        expect(diffs.length, `${entry.path}: perturbation must change its own bytes`).toBeGreaterThan(0);
        for (const d of diffs) {
          expect(
            d >= entry.byteOffset && d < entry.byteOffset + entry.byteLength,
            `${entry.path}: diff at byte ${d} escaped [${entry.byteOffset}, ${entry.byteOffset + entry.byteLength})`,
          ).toBe(true);
        }
      });
    }
  });

  test('(3) structural/header fields read back at schema-predicted offsets (direct DataView)', () => {
    for (const axleCount of [0, 2, 6]) {
      const walk = genotypeFieldWalk(axleCount);
      const at = (path) => walk.find((entry) => entry.path === path);
      const bytes = serializeGenotype(genotypeWithAxles(axleCount));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getUint16(at('version').byteOffset, true)).toBe(GENOTYPE_VERSION);
      expect(view.getUint8(at('frame.segments.length').byteOffset)).toBe(1);
      expect(view.getUint8(at('axles.length').byteOffset)).toBe(axleCount);
    }
  });

  test('(4) classification teeth: discrete key set === DISCRETE_GENE_KEYS; leaf-key name uniqueness', () => {
    const walk = genotypeFieldWalk(6);
    const discreteKeys = new Set(walk.filter((entry) => entry.kind === 'discrete').map((entry) => entry.key));
    expect([...discreteKeys].sort()).toEqual([...DISCRETE_GENE_KEYS].sort());
    // Name uniqueness: no continuous entry may share a leaf key with a
    // discrete one (key-based matching must identify discreteness at any
    // depth — the DISCRETE_GENE_KEYS declaration's own invariant).
    for (const entry of walk) {
      if (entry.kind !== 'continuous') continue;
      expect(DISCRETE_GENE_KEYS.includes(entry.key), entry.path).toBe(false);
    }
    // The four kinds only, and discreteness is single-sourced off the declared keys.
    for (const entry of walk) {
      expect(['version', 'structural', 'discrete', 'continuous'].includes(entry.kind), entry.path).toBe(true);
      if (entry.kind === 'discrete' || entry.kind === 'continuous') {
        expect(entry.kind === 'discrete', entry.path).toBe(DISCRETE_GENE_KEYS.includes(entry.key));
      }
    }
  });

  test('(5) schema <-> validator agreement: NaN at EVERY f64 gene leaf fails the serializer loud', () => {
    const genotype = genotypeWithAxles(2);
    forEachGenotypeField(genotype, (entry) => {
      if (entry.type !== 'f64') return; // version/structural are not genes
      const mutated = deepClone(genotype);
      const { container, key } = leafContainer(mutated, entry.path);
      container[key] = NaN;
      // Prefix + leaf key, never an exact path spelling.
      expect(() => serializeGenotype(mutated), entry.path).toThrow(/assembly: invalid genotype/);
      expect(() => serializeGenotype(mutated), entry.path).toThrow(new RegExp(entry.key));
    });
  });

  test('(6) static-ness: identical walk across calls, frozen output; forEach visits the walk in order with values', () => {
    const a = genotypeFieldWalk(2);
    const b = genotypeFieldWalk(2);
    expect(a).not.toBe(b);
    expect([...a]).toEqual([...b]);
    expect(Object.isFrozen(a)).toBe(true);
    for (const entry of a) expect(Object.isFrozen(entry)).toBe(true);

    for (const genotype of [genotypeWithAxles(0), genotypeWithAxles(3)]) {
      const walk = genotypeFieldWalk(genotype.axles.length);
      const visited = [];
      forEachGenotypeField(genotype, (entry) => visited.push(entry));
      expect(visited.length).toBe(walk.length);
      visited.forEach((entry, i) => {
        const { value, ...meta } = entry;
        expect(meta).toEqual({
          path: walk[i].path,
          key: walk[i].key,
          type: walk[i].type,
          kind: walk[i].kind,
          byteOffset: walk[i].byteOffset,
          byteLength: walk[i].byteLength,
        });
        const { container, key } = leafContainer(genotype, entry.path);
        expect(Object.is(value, container[key]), entry.path).toBe(true);
      });
    }
  });

  test('(7) probe cross-check: the probe-style sorted-key leaf walk yields EXACTLY the schema paths (multiset)', () => {
    // Copy-declared mirror of scripts/probe-integrity.js jitterGenotype's
    // traversal (sorted-key recursion; `version` + DISCRETE_GENE_KEYS
    // preserved, every other numeric leaf perturbed). The probe's walk order
    // is load-bearing for committed measurements — this test re-derives its
    // leaf SET, it does not refactor the probe.
    const collectProbePaths = (genotype) => {
      const perturbed = [];
      const preserved = [];
      const walk = (node, path) => {
        if (Array.isArray(node)) {
          node.forEach((v, i) => walk(v, `${path}[${i}]`));
          return;
        }
        if (typeof node === 'object' && node !== null) {
          for (const k of Object.keys(node).sort()) {
            const child = `${path}.${k}`;
            if (k === 'version' || DISCRETE_GENE_KEYS.includes(k)) preserved.push(child);
            else walk(node[k], child);
          }
          return;
        }
        if (typeof node === 'number') perturbed.push(path);
      };
      walk(genotype, 'genotype');
      // Full object-nesting paths -> schema spellings (the declared
      // abbreviation of nodes/fam under frame.segments[0]).
      const toSchema = (p) => p
        .replace(/^genotype\./, '')
        .replace(/^frame\.segments\[0\]\.nodes/, 'nodes')
        .replace(/^frame\.segments\[0\]\.fam/, 'fam');
      return {
        perturbed: perturbed.map(toSchema).sort(),
        preserved: preserved.map(toSchema).sort(),
      };
    };

    const genotype = genotypeWithAxles(2);
    const walk = genotypeFieldWalk(2);
    const probe = collectProbePaths(genotype);
    // Sorted path-ARRAY equality is a MULTISET comparison: keys repeat
    // across node slots and axles, so a key-set test could miss an omitted
    // occurrence — this cannot.
    const continuousPaths = walk.filter((entry) => entry.kind === 'continuous').map((entry) => entry.path).sort();
    expect(probe.perturbed).toEqual(continuousPaths);
    const preservedPaths = walk
      .filter((entry) => entry.kind === 'discrete' || entry.kind === 'version')
      .map((entry) => entry.path)
      .sort();
    expect(probe.preserved).toEqual(preservedPaths);
  });

  test('genotypeByteLength validates the u8 wire bound (0..255)', () => {
    for (const bad of [-1, 256, 1.5, NaN]) {
      expect(() => genotypeByteLength(bad), String(bad)).toThrow(/assembly: invalid genotype/);
    }
    expect(genotypeByteLength(255)).toBe(268 + 128 * 255);
  });
});
