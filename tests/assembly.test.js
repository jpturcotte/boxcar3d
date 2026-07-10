// Pure assembly-compiler contract (src/sim/assembly.js) — no Rapier anywhere.
//
// PR #10 locks the genome contract: the [0,1] genotype schema, the affine
// decoder table, the repair pipeline (domain-invalid throws; physical
// invalidity repairs), symmetry expansion, and the canonical flat encoding.
// The three load-bearing proofs:
//   * repair is IDENTITY on valid genotypes (deep equality),
//   * repair is IDEMPOTENT corpus-wide — asserted BOTH as toEqual AND as
//     byte-equality of the canonical encoding (non-negotiable: the fused-
//     clamp DAG is a design argument, only this test proves the code matches),
//   * compileAssembly never mutates its input (deep-frozen input compiles).
// Every repair rule gets one targeted violating genotype proving its exact
// minimal deterministic correction. Seeds are declared per test (rule 3).

import { describe, test, expect } from 'vitest';
import {
  ASSEMBLY_DEFAULTS,
  ASSEMBLY_RULES,
  FRAME_FAMILIES,
  GENE_RANGES,
  GENOTYPE_VERSION,
  NODE_SLOTS,
  SUSPENSION_TYPES,
  compileAssembly,
  randomGenotype,
  repairGenotype,
  serializeGenotype,
} from '../src/sim/assembly.js';
import { Rng } from '../src/sim/prng.js';

const CORPUS_SEED = 20260710; // the assembly-schema lock seed (2026070x family)
const CORPUS_SIZE = 256;

const affine = (g, [lo, hi]) => lo + (hi - lo) * g;

// A hand-built genotype chosen so NO repair rule bites (each margin is
// documented next to the value): 4 active spine nodes, two well-separated
// paired axles.
function validGenotype() {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01) => ({
    posX01,
    paired: 1,
    trackHalf: 0.5, // bounds [0, 1] under the default corridor
    radius: 0.6, // 0.5 m >= clearance bound 0.4 m gene 0.4
    width: 0.5, // 0.3 m
    density: 0.15, // 265 kg/m³ -> 62.5 kg, inside [2, 80]
    suspType: 0.5,
    stiffness: 0.5,
    damping: 0.5,
    travel: 0.5,
    restLength: 0.5,
    driven: 1,
    share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: GENOTYPE_VERSION,
    hue: 0.25,
    symmetric: 0.9,
    power: 0.5,
    frameDensity: 0.3, // 381 kg/m³ × 0.907 m³ = 346 kg, inside [5, 500]
    frame: {
      family: 0.1, // spine
      segments: [{
        nodeCount: 0.5, // -> 4 active nodes
        nodes: Array.from({ length: NODE_SLOTS }, node),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    // separation needed (0.5+0.5+0.05)/1.95 ≈ 0.538 < 0.6 gap — no push
    axles: [axle(0.2), axle(0.8)],
  };
}

// Frame span exactly as decodeFrame accumulates it (sequential adds — float
// order matters for exact-value assertions).
function spanOf(genotype) {
  const seg = genotype.frame.segments[0];
  const nodeCount = 2 + Math.min(4, Math.floor(seg.nodeCount * 5));
  let span = 0;
  for (let i = 1; i < nodeCount; i++) span += affine(seg.nodes[i].gap, GENE_RANGES.nodeGap);
  return span;
}

function deepFreeze(o) {
  Object.freeze(o);
  for (const v of Object.values(o)) {
    if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) deepFreeze(v);
  }
  return o;
}

// The seeded corpus every lock and property test shares: raw -> repaired ->
// compiled, one fork per index (order-independent, rule 1).
const corpus = Array.from({ length: CORPUS_SIZE }, (_, i) => {
  const raw = randomGenotype(new Rng(CORPUS_SEED).fork(i));
  const repaired = repairGenotype(raw);
  return { raw, repaired, ir: compileAssembly(raw) };
});

describe('repair contract (identity / idempotence / no-mutation)', () => {
  test('repair is identity on a valid genotype (deep equality)', () => {
    const g = validGenotype();
    expect(repairGenotype(g)).toEqual(g);
  });

  test('repair is idempotent corpus-wide: toEqual AND canonical-byte equality (seed 20260710, n=256)', () => {
    for (const { repaired } of corpus) {
      const twice = repairGenotype(repaired);
      expect(twice).toEqual(repaired);
      // byte-for-byte over the canonical encoding, not just toEqual (which
      // treats +0/-0 and object identity loosely)
      const a = serializeGenotype(twice);
      const b = serializeGenotype(repaired);
      expect(a.length).toBe(b.length);
      for (let k = 0; k < a.length; k++) {
        if (a[k] !== b[k]) throw new Error(`idempotence byte drift at offset ${k}`);
      }
    }
  });

  test('corpus members that are already valid come back unchanged (identity subset exists)', () => {
    // randomGenotype and the repair clone build the same canonical field
    // order, so JSON equality is exact structural equality here.
    const identityCount = corpus.filter(
      ({ raw, repaired }) => JSON.stringify(raw) === JSON.stringify(repaired)
    ).length;
    expect(identityCount).toBeGreaterThan(0); // repair-identity coverage
    expect(identityCount).toBeLessThan(CORPUS_SIZE); // repair-non-identity coverage
  });

  test('compileAssembly never mutates its input (deep-frozen input compiles; snapshot unchanged)', () => {
    const g = deepFreeze(validGenotype());
    const snapshot = JSON.parse(JSON.stringify(g));
    const ir = compileAssembly(g); // a strict-mode write to a frozen object would throw
    expect(ir.chassis.colliders.length).toBeGreaterThan(0);
    expect(g).toEqual(snapshot);
    // and a genotype that NEEDS repair is also left untouched
    const violating = deepFreeze({ ...validGenotype(), frameDensity: 1 });
    const before = JSON.parse(JSON.stringify(violating));
    compileAssembly(violating);
    expect(violating).toEqual(before);
  });

  test('ir.genotype is the repaired clone, not the input object', () => {
    const g = validGenotype();
    const ir = compileAssembly(g);
    expect(ir.genotype).not.toBe(g);
    expect(ir.genotype).toEqual(repairGenotype(g));
  });
});

describe('repair rules — one targeted violating genotype per rule, exact minimal correction', () => {
  test('R1 axle-count cap: 7th module truncated, surviving six untouched', () => {
    const g = validGenotype();
    const seg = g.frame.segments[0];
    seg.nodeCount = 1; // 6 active nodes
    seg.nodes.forEach((n) => { n.gap = 1; }); // span 5 m — room for six axles
    const base = g.axles[0];
    // min separation (0.5+0.5+0.05)/5 = 0.21 < 0.18? NO — use 0.18 spacing:
    // radius 0.6 -> r 0.5 -> minGapGene 0.21 > 0.18 would push. Use radius
    // gene 0.44 -> r 0.42 -> minGapGene (0.42+0.42+0.05)/5 = 0.178 <= 0.18.
    const positions = [0, 0.18, 0.36, 0.54, 0.72, 0.9, 0.95];
    g.axles = positions.map((p) => ({ ...base, radius: 0.44, posX01: p, asym: { ...base.asym } }));
    const r = repairGenotype(g);
    expect(r.axles).toHaveLength(ASSEMBLY_DEFAULTS.maxAxles);
    r.axles.forEach((a, i) => expect(a).toEqual({ ...base, radius: 0.44, posX01: positions[i], asym: { ...base.asym } }));
  });

  test('R2 wheels-below-frame + clearance: tall frame raises the radius gene to the exact bound', () => {
    const g = validGenotype();
    g.frame.segments[0].nodes.forEach((n) => { n.height = 1; }); // maxHalfHeight 0.45
    g.axles[0].radius = 0; // 0.2 m wheel tucked inside a 0.45 frame
    const r = repairGenotype(g);
    const bound = (0.45 + ASSEMBLY_RULES.clearance - GENE_RANGES.wheelRadius[0]) / (GENE_RANGES.wheelRadius[1] - GENE_RANGES.wheelRadius[0]);
    expect(r.axles[0].radius).toBe(bound); // exactly 0.7
    expect(r.axles[1].radius).toBe(Math.max(0.6, bound)); // other module: same bound, was above -> only raised if below
  });

  test('R3 wheel mass: oversize+dense wheel clamps the density gene down to the exact 80 kg bound', () => {
    const g = validGenotype();
    g.axles[0].radius = 0.6; // 0.5 m
    g.axles[0].width = 1; // 0.5 m
    g.axles[0].density = 1; // 1200 kg/m³ -> 471 kg, way past 80
    const r = repairGenotype(g);
    // decode through the same affine ops as the compiler — literal shortcuts
    // (0.5 vs affine(0.6, range)) differ by ulps and toBe is exact
    const rad = affine(0.6, GENE_RANGES.wheelRadius);
    const wid = affine(1, GENE_RANGES.wheelWidth);
    const vol = Math.PI * rad * rad * wid;
    const bound = (ASSEMBLY_RULES.wheelMass[1] / vol - GENE_RANGES.wheelDensity[0]) / (GENE_RANGES.wheelDensity[1] - GENE_RANGES.wheelDensity[0]);
    expect(r.axles[0].density).toBe(bound);
    expect(affine(bound, GENE_RANGES.wheelDensity) * vol).toBeCloseTo(80, 10);
  });

  test('R4 track-width sanity: fat wheels raise trackHalf to clear each other; a narrow corridor clamps it down', () => {
    const g = validGenotype();
    g.axles[0].width = 1; // 0.5 m
    g.axles[0].trackHalf = 0; // 0.2 m < w/2 + gap = 0.3 m
    const r = repairGenotype(g);
    const wFat = affine(1, GENE_RANGES.wheelWidth);
    const lo = (wFat / 2 + ASSEMBLY_RULES.wheelGap - GENE_RANGES.trackHalf[0]) / (GENE_RANGES.trackHalf[1] - GENE_RANGES.trackHalf[0]);
    expect(r.axles[0].trackHalf).toBe(lo);

    const narrow = validGenotype();
    narrow.axles[0].trackHalf = 1; // 3.0 m into a 2 m half corridor
    const zLimit = 2 - ASSEMBLY_RULES.wallMargin;
    const wMid = affine(0.5, GENE_RANGES.wheelWidth); // validGenotype width gene
    const n = repairGenotype(narrow, { corridorHalfWidth: 2 });
    const hi = (zLimit - wMid / 2 - GENE_RANGES.trackHalf[0]) / (GENE_RANGES.trackHalf[1] - GENE_RANGES.trackHalf[0]);
    expect(n.axles[0].trackHalf).toBe(hi);

    const offset = validGenotype();
    offset.axles[0].asym.centerOffset = 1; // +1.5 m single-wheel offset
    const o = repairGenotype(offset, { corridorHalfWidth: 2 });
    const oHi = (zLimit - wMid / 2 - GENE_RANGES.centerOffset[0]) / (GENE_RANGES.centerOffset[1] - GENE_RANGES.centerOffset[0]);
    expect(o.axles[0].asym.centerOffset).toBe(Math.min(1, oHi));
  });

  test('R5 non-overlap: coincident axles separated by exactly (r1+r2+gap)/span; storage order preserved', () => {
    const g = validGenotype();
    g.axles[0].posX01 = 0.5;
    g.axles[0].radius = 0.4; // exactly the clearance bound -> r 0.4 m, R2 no-op
    g.axles[1].posX01 = 0.5;
    g.axles[1].radius = 0.4;
    const r = repairGenotype(g);
    const span = spanOf(g);
    expect(r.axles[0].posX01).toBe(0.5); // slot 0 wins the tie (stable tie-break)
    expect(r.axles[1].posX01).toBe(Math.min(1, 0.5 + (0.4 + 0.4 + ASSEMBLY_RULES.wheelGap) / span));
  });

  test('R5 cap: axles that cannot fit pile at gene 1 exactly (residual overlap accepted, collision-inert)', () => {
    const g = validGenotype();
    g.axles[0].posX01 = 0.9;
    g.axles[1].posX01 = 0.95;
    const r = repairGenotype(g);
    expect(r.axles[0].posX01).toBe(0.9);
    expect(r.axles[1].posX01).toBe(1);
    expect(repairGenotype(r)).toEqual(r); // the pile-up is a fixpoint
  });

  test('R6 chassis mass: huge dense frame clamps frameDensity down; tiny light frame raises it', () => {
    const g = validGenotype();
    const seg = g.frame.segments[0];
    seg.nodeCount = 1;
    seg.nodes.forEach((n) => { n.gap = 1; n.height = 1; n.halfWidth = 1; n.thickness = 1; });
    seg.fam.spine.beamWidthFrac = 1;
    g.frameDensity = 1;
    const r = repairGenotype(g);
    let vol = 0; // accumulate exactly as buildChassis does (float add order matters for toBe)
    for (let i = 0; i < 5; i++) vol += 8 * 0.5 * 0.45 * 1.2;
    const hi = (ASSEMBLY_RULES.chassisMass[1] / vol - GENE_RANGES.frameDensity[0]) / (GENE_RANGES.frameDensity[1] - GENE_RANGES.frameDensity[0]);
    expect(r.frameDensity).toBe(hi);

    const tiny = validGenotype();
    const tseg = tiny.frame.segments[0];
    tseg.nodeCount = 0; // 2 nodes
    tseg.nodes.forEach((n) => { n.gap = 0; n.height = 0; n.halfWidth = 0; n.thickness = 0; });
    tseg.fam.spine.beamWidthFrac = 0;
    tiny.frameDensity = 0;
    const t = repairGenotype(tiny);
    const tinyVol = 8 * 0.15 * 0.15 * ASSEMBLY_RULES.minPartHalfExtent; // hz floored at 0.12
    const lo = (ASSEMBLY_RULES.chassisMass[0] / tinyVol - GENE_RANGES.frameDensity[0]) / (GENE_RANGES.frameDensity[1] - GENE_RANGES.frameDensity[0]);
    expect(t.frameDensity).toBe(lo);
  });

  test('axle anchor validity holds by construction: every compiled anchor sits on the frame (corpus property)', () => {
    for (const { repaired, ir } of corpus) {
      const half = spanOf(repaired) / 2;
      for (const ax of ir.axles) {
        expect(Number.isFinite(ax.posX)).toBe(true);
        expect(ax.posX).toBeGreaterThanOrEqual(-half - 1e-12);
        expect(ax.posX).toBeLessThanOrEqual(half + 1e-12);
      }
    }
  });

  test('drive shares: all-zero shares fall back to an equal split; genes stay untouched', () => {
    const g = validGenotype();
    g.axles.forEach((a) => { a.share = 0; });
    const r = repairGenotype(g);
    expect(r.axles.map((a) => a.share)).toEqual([0, 0]); // no gene write
    const ir = compileAssembly(g);
    const driven = ir.axles.flatMap((ax) => ax.wheels).filter((w) => w.driven);
    const each = ir.power.budget / driven.length;
    for (const w of driven) expect(w.driveTorque).toBe(each);
  });
});

describe('symmetry (core gene, compiler-expanded, count-stable)', () => {
  test('symmetric ON: paired modules mirror exactly; asym genes are gated, not erased', () => {
    const g = validGenotype();
    g.symmetric = 0.9;
    g.axles[0].asym = { driveBias: 0.9, sizeBias: 0.9, centerOffset: 0.9 };
    const ir = compileAssembly(g);
    const [l, rWheel] = ir.axles[0].wheels;
    expect(ir.axles[0].kind).toBe('paired');
    expect(l.z).toBe(-rWheel.z);
    expect(l.radius).toBe(rWheel.radius);
    expect(l.mass).toBe(rWheel.mass);
    expect(l.driveTorque).toBe(rWheel.driveTorque);
    expect(compileAssembly(g).genotype.axles[0].asym.driveBias).toBe(0.9); // stored gene survives
  });

  test('symmetric ON: single modules snap to the centerline', () => {
    const g = validGenotype();
    g.axles[0].paired = 0;
    g.axles[0].asym.centerOffset = 0.95;
    const ir = compileAssembly(g);
    expect(ir.axles[0].kind).toBe('single');
    expect(ir.axles[0].wheels).toHaveLength(1);
    expect(ir.axles[0].wheels[0].z).toBe(0);
  });

  test('symmetric OFF: driveBias, sizeBias, and centerOffset all express (asymmetry is first-class)', () => {
    const g = validGenotype();
    g.symmetric = 0.1;
    g.axles[0].asym = { driveBias: 0.9, sizeBias: 0.9, centerOffset: 0.5 };
    g.axles[1].paired = 0;
    g.axles[1].asym.centerOffset = 0.9; // +1.2 m off-center single wheel
    const ir = compileAssembly(g);
    const [l, r] = ir.axles[0].wheels;
    expect(r.radius).toBe(l.radius * affine(0.9, GENE_RANGES.sizeBiasFactor));
    expect(l.driveTorque).toBeGreaterThan(r.driveTorque); // 0.9 : 0.1 split
    expect(ir.axles[1].wheels[0].z).toBe(affine(0.9, GENE_RANGES.centerOffset));
  });

  test('a symmetry flip never changes wheel count (count-stable)', () => {
    const g = validGenotype();
    const on = compileAssembly({ ...g, symmetric: 0.9 });
    const off = compileAssembly({ ...g, symmetric: 0.1 });
    expect(on.axles.map((a) => a.wheels.length)).toEqual(off.axles.map((a) => a.wheels.length));
  });

  test('compilation is deterministic: same genotype -> byte-identical IR poses', () => {
    const g = validGenotype();
    expect(compileAssembly(g)).toEqual(compileAssembly(g));
  });
});

describe('frame families compile to valid IR', () => {
  const withFamily = (familyGene) => {
    const g = validGenotype();
    g.frame.family = familyGene;
    return compileAssembly(g);
  };

  test('spine: one cuboid per inter-node segment', () => {
    const ir = withFamily(0.1);
    expect(ir.chassis.family).toBe('spine');
    expect(ir.chassis.colliders).toHaveLength(3); // 4 active nodes
    for (const c of ir.chassis.colliders) {
      expect(c.kind).toBe('cuboid');
      for (const h of [c.hx, c.hy, c.hz]) expect(h).toBeGreaterThanOrEqual(ASSEMBLY_RULES.minPartHalfExtent);
      expect(c.rot).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    }
  });

  test('ladder: two rails per segment plus one crossmember per node', () => {
    const ir = withFamily(0.5);
    expect(ir.chassis.family).toBe('ladder');
    expect(ir.chassis.colliders).toHaveLength(2 * 3 + 4);
  });

  test('hull: one convex hull, 4 points per active node, every coordinate fround-quantized once', () => {
    const ir = withFamily(0.9);
    expect(ir.chassis.family).toBe('hull');
    expect(ir.chassis.colliders).toHaveLength(1);
    const { points } = ir.chassis.colliders[0];
    expect(points).toHaveLength(4 * 4 * 3);
    for (const p of points) expect(p).toBe(Math.fround(p)); // f32 discipline (features.js rule)
  });

  test('corpus coverage: every family, every suspension type, asymmetric and zero-axle genotypes all occur', () => {
    const families = new Set(corpus.map(({ ir }) => ir.chassis.family));
    expect([...families].sort()).toEqual([...FRAME_FAMILIES].sort());
    const suspTypes = new Set(corpus.flatMap(({ ir }) => ir.axles.map((a) => a.suspension.type)));
    expect([...suspTypes].sort()).toEqual([...SUSPENSION_TYPES].sort());
    expect(corpus.some(({ repaired }) => repaired.symmetric < 0.5)).toBe(true);
    expect(corpus.some(({ repaired }) => repaired.axles.length === 0)).toBe(true);
  });

  test('IR sanity corpus-wide: finite geometry, mass estimate inside the band, supports positive', () => {
    for (const { ir } of corpus) {
      expect(Number.isFinite(ir.chassis.massEstimate)).toBe(true);
      expect(ir.chassis.massEstimate).toBeGreaterThanOrEqual(ASSEMBLY_RULES.chassisMass[0] - 1e-9);
      expect(ir.chassis.massEstimate).toBeLessThanOrEqual(ASSEMBLY_RULES.chassisMass[1] + 1e-9);
      expect(ir.chassis.supports.minFace).toBeGreaterThanOrEqual(ASSEMBLY_RULES.minPartHalfExtent);
      expect(ir.chassis.supports.reach).toBeGreaterThan(ir.chassis.supports.minFace);
      for (const ax of ir.axles) {
        for (const w of ax.wheels) {
          expect(w.mass).toBeGreaterThanOrEqual(0); // sizeBias-shrunk side may undercut 2 kg — base wheel is band-checked
          expect(Number.isFinite(w.driveTorque)).toBe(true);
        }
      }
    }
  });
});

describe('locked fingerprints (deliberate re-lock + version bump required to change)', () => {
  test('locked CORPUS fingerprint: seed 20260710, n=256 repaired genotypes, canonical flat encoding, forever', () => {
    // FNV-1a over the concatenated canonical serialization of every repaired
    // genotype in corpus order. Locks schema shape + decoder-driven repair
    // end-to-end at the genotype level (f64 — never mixed with the f32 IR
    // lock below). First-time lock (PR #10).
    let h = 0x811c9dc5;
    for (const { repaired } of corpus) {
      for (const b of serializeGenotype(repaired)) {
        h ^= b;
        h = Math.imul(h, 0x01000193);
      }
    }
    expect(((h >>> 0).toString(16)).padStart(8, '0')).toBe('922d0458');
  });

  test('locked CHASSIS-GEOMETRY fingerprint: compiled IR colliders over the same corpus, forever', () => {
    // Per IR: u8 familyIdx, f64 density, u32 colliderCount; per collider
    // u8 kind (0 cuboid / 1 hull); cuboid -> f64 hx,hy,hz,cx,cy,cz + rot
    // x,y,z,w; hull -> u32 pointCount + f32 LE points (the fround values —
    // exactly the features.test.js f32 construction). Locks decode + repair +
    // build end-to-end, separately re-lockable from the genotype lock.
    let h = 0x811c9dc5;
    const eat = (view) => {
      for (let b = 0; b < view.byteLength; b++) {
        h ^= view.getUint8(b);
        h = Math.imul(h, 0x01000193);
      }
    };
    for (const { ir } of corpus) {
      const head = new DataView(new ArrayBuffer(1 + 8 + 4));
      head.setUint8(0, FRAME_FAMILIES.indexOf(ir.chassis.family));
      head.setFloat64(1, ir.chassis.density, true);
      head.setUint32(9, ir.chassis.colliders.length, true);
      eat(head);
      for (const c of ir.chassis.colliders) {
        if (c.kind === 'cuboid') {
          const v = new DataView(new ArrayBuffer(1 + 10 * 8));
          v.setUint8(0, 0);
          [c.hx, c.hy, c.hz, c.cx, c.cy, c.cz, c.rot.x, c.rot.y, c.rot.z, c.rot.w]
            .forEach((x, i) => v.setFloat64(1 + i * 8, x, true));
          eat(v);
        } else {
          const v = new DataView(new ArrayBuffer(1 + 4 + c.points.length * 4));
          v.setUint8(0, 1);
          v.setUint32(1, c.points.length, true);
          c.points.forEach((p, i) => v.setFloat32(5 + i * 4, p, true));
          eat(v);
        }
      }
    }
    expect(((h >>> 0).toString(16)).padStart(8, '0')).toBe('39bcd6c4');
  });

  test('serializeGenotype puts hue at canonical flat index 0 (the SALVAGE gene[0]=hue convention)', () => {
    const g = validGenotype();
    const bytes = serializeGenotype(g);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(0, true)).toBe(GENOTYPE_VERSION);
    expect(view.getFloat64(2, true)).toBe(g.hue); // first gene after the version header
  });
});

describe('fail-loud negatives (domain-invalid throws; physical invalidity repairs)', () => {
  test('malformed genotypes throw with a path diagnosis, never clamp', () => {
    const cases = [
      [(g) => { g.version = 2; }, /version/],
      [(g) => { g.hue = NaN; }, /hue/],
      [(g) => { g.hue = -0.1; }, /hue/],
      [(g) => { g.hue = 1.1; }, /hue/],
      [(g) => { g.frame.segments = []; }, /segments/],
      [(g) => { g.frame.segments.push({}); }, /segments/],
      [(g) => { g.frame.segments[0].nodes.pop(); }, /nodes/],
      [(g) => { delete g.axles[0].radius; }, /radius/],
      [(g) => { delete g.axles[0].asym; }, /asym/],
      [(g) => { g.axles[0].asym.sizeBias = 2; }, /sizeBias/],
    ];
    for (const [mutate, pattern] of cases) {
      const g = validGenotype();
      mutate(g);
      expect(() => repairGenotype(g), String(pattern)).toThrow(pattern);
      expect(() => compileAssembly(g), String(pattern)).toThrow(pattern);
    }
  });

  test('every options knob validates fail-loud', () => {
    const g = validGenotype();
    for (const corridorHalfWidth of [0, -1, NaN, 0.4]) {
      expect(() => compileAssembly(g, { corridorHalfWidth })).toThrow(/corridorHalfWidth/);
    }
    for (const maxAxles of [-1, 1.5, NaN]) {
      expect(() => compileAssembly(g, { maxAxles })).toThrow(/maxAxles/);
    }
  });

  test('randomGenotype output is always domain-valid (corpus draws never need pre-clamping)', () => {
    for (const { raw } of corpus) expect(() => repairGenotype(raw)).not.toThrow();
  });
});
