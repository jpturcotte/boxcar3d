// Pure feature-geometry contract (src/sim/features.js) — no Rapier anywhere.
//
// PR #8 realizes terrain.features as colliders; this file locks the pure half:
// quaternions from {cos, sin} yaw via half-angle sqrt identities (D7/F4 — no
// trig, no library transcendentals), boulder hull points from the per-feature
// trailing seed, and the per-type shape/support-sample geometry the adapter
// and the render scene both consume. Seeds are declared per test (rule 3).

import { describe, test, expect } from 'vitest';
import { FEATURE_GEOMETRY_DEFAULTS, featureGeometry, quatMultiply, yawToQuaternion } from '../src/sim/features.js';
import { Rng } from '../src/sim/prng.js';

const quatNorm = (q) => Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);

// Trig-free unit yaw, exactly as generateFeatures draws boulder/log headings
// (Marsaglia disk rejection) — the real input population for the sweep tests.
function marsagliaYaw(rng) {
  for (;;) {
    const u = rng.range(-1, 1);
    const v = rng.range(-1, 1);
    const m = u * u + v * v;
    if (m > 1 || m < 1e-12) continue;
    const inv = 1 / Math.sqrt(m);
    return { cos: u * inv, sin: v * inv };
  }
}

// Unit yaw headings used across tests. yawToQuaternion rotates local +X onto
// the heading (cos, 0, sin) — the invariant the discriminator test below locks.
// Components follow the half-angle identities with a negated y-term:
// w = sqrt((1+cos)/2), y = -sign(sin)*sqrt((1-cos)/2).
const SQRT_HALF = Math.sqrt(0.5);

// Rotate vector v by unit quaternion q: v' = v + 2·q_w·(q×v) + 2·q×(q×v).
const rotate = (q, v) => {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};

describe('yawToQuaternion (half-angle sqrt identities, no trig)', () => {
  // THE load-bearing invariant. The quaternion must rotate local +X onto the
  // heading (cos, 0, sin), so collider orientation, render mesh, and seating
  // support samples all agree. A mirrored yaw (y not negated) passes every
  // unit-norm / component check yet fails HERE — this is the test that catches
  // the collider-vs-support-sample lateral disagreement on sloped terrain.
  test('rotates local +X onto the heading (cos, 0, sin) — exact cases + seeded sweep', () => {
    const cases = [
      { cos: 1, sin: 0 }, { cos: -1, sin: 0 }, { cos: 0, sin: 1 }, { cos: 0, sin: -1 },
      { cos: SQRT_HALF, sin: SQRT_HALF }, { cos: 0.6, sin: 0.8 }, { cos: -0.6, sin: 0.8 },
    ];
    const rng = new Rng(0xfea70003);
    for (let i = 0; i < 100; i++) cases.push(marsagliaYaw(rng.fork(i)));
    for (const yaw of cases) {
      const h = rotate(yawToQuaternion(yaw), { x: 1, y: 0, z: 0 });
      expect(h.x).toBeCloseTo(yaw.cos, 12);
      expect(h.y).toBeCloseTo(0, 12);
      expect(h.z).toBeCloseTo(yaw.sin, 12);
    }
  });

  test('identity yaw {cos:1, sin:0} -> unit quaternion (0, ±0, 0, 1)', () => {
    const q = yawToQuaternion({ cos: 1, sin: 0 });
    expect(q.x).toBe(0);
    expect(q.y).toBeCloseTo(0, 15); // ±0 (−sgn(0)·0); both are the identity
    expect(q.z).toBe(0);
    expect(q.w).toBe(1);
  });

  test('90° heading {cos:0, sin:1} -> (0, -sqrt(1/2), 0, sqrt(1/2)): −90° about +Y sends +X to +Z', () => {
    const q = yawToQuaternion({ cos: 0, sin: 1 });
    expect(q.x).toBe(0);
    expect(q.z).toBe(0);
    expect(q.y).toBeCloseTo(-SQRT_HALF, 15);
    expect(q.w).toBeCloseTo(SQRT_HALF, 15);
  });

  test('180° heading {cos:-1, sin:0} takes the sgn(0)=+1 branch -> (0,-1,0,0) ≡ (0,1,0,0) [double cover]', () => {
    const q = yawToQuaternion({ cos: -1, sin: 0 });
    expect(q.x).toBe(0);
    expect(q.z).toBe(0);
    expect(q.w).toBeCloseTo(0, 15);
    expect(Math.abs(q.y)).toBeCloseTo(1, 15); // q and −q are the same rotation
    expect(rotate(q, { x: 1, y: 0, z: 0 }).x).toBeCloseTo(-1, 12); // and it genuinely faces −X
  });

  test('negative sin flips the heading to -Z: {cos:0, sin:-1} -> y = +sqrt(1/2)', () => {
    const q = yawToQuaternion({ cos: 0, sin: -1 });
    expect(q.y).toBeCloseTo(SQRT_HALF, 15);
    expect(q.w).toBeCloseTo(SQRT_HALF, 15);
  });

  test('cos carrying +ulp from normalization stays finite (clamped radicand)', () => {
    // 1 + 2^-52 passes the unit-heading tolerance but makes (1-cos)/2 negative;
    // an unclamped sqrt would return NaN and poison the collider pose.
    const q = yawToQuaternion({ cos: 1 + Number.EPSILON, sin: 0 });
    expect(Number.isFinite(q.y)).toBe(true);
    expect(Number.isFinite(q.w)).toBe(true);
    expect(q.y).toBeCloseTo(0, 15); // ±0
    expect(quatNorm(q)).toBeCloseTo(1, 12);
  });

  test('unit norm across a seeded sweep of Marsaglia headings (seed 0xfea70001, n=200)', () => {
    const rng = new Rng(0xfea70001);
    for (let i = 0; i < 200; i++) {
      const q = yawToQuaternion(marsagliaYaw(rng.fork(i)));
      expect(quatNorm(q)).toBeCloseTo(1, 12);
    }
  });

  test('malformed yaw throws: non-unit, NaN, missing', () => {
    expect(() => yawToQuaternion({ cos: 0.5, sin: 0.5 })).toThrow(/unit/);
    expect(() => yawToQuaternion({ cos: NaN, sin: 0 })).toThrow(/unit/);
    expect(() => yawToQuaternion({ cos: Infinity, sin: 0 })).toThrow(/unit/);
    expect(() => yawToQuaternion({})).toThrow(/unit/);
  });
});

describe('quatMultiply', () => {
  test('identity is neutral on both sides', () => {
    const id = { x: 0, y: 0, z: 0, w: 1 };
    const q = yawToQuaternion({ cos: 0, sin: 1 });
    expect(quatMultiply(q, id)).toEqual(q);
    expect(quatMultiply(id, q)).toEqual(q);
  });

  test('two 90° yaws compose to the 180° yaw (|y|≈1, w≈0; double cover)', () => {
    const q90 = yawToQuaternion({ cos: 0, sin: 1 });
    const q180 = quatMultiply(q90, q90);
    expect(q180.x).toBeCloseTo(0, 15);
    expect(Math.abs(q180.y)).toBeCloseTo(1, 15); // ±(0,1,0,0) — same rotation
    expect(q180.z).toBeCloseTo(0, 15);
    expect(q180.w).toBeCloseTo(0, 15);
  });

  test('result is normalized to unit length', () => {
    const rng = new Rng(0xfea70002);
    for (let i = 0; i < 50; i++) {
      const f = rng.fork(i);
      const q = quatMultiply(yawToQuaternion(marsagliaYaw(f)), yawToQuaternion(marsagliaYaw(f)));
      expect(quatNorm(q)).toBeCloseTo(1, 12);
    }
  });
});

// Synthetic descriptors: featureGeometry is a pure function of
// (type, yaw, dims, seed) + options, so tests pin exact values instead of
// depending on generated terrain. x/z/y placement is the adapter's business.
const IDENTITY_YAW = { cos: 1, sin: 0 };
const log = (over = {}) => ({ type: 'log', yaw: IDENTITY_YAW, dims: { radius: 0.3, length: 5 }, seed: 0xd06f00d, ...over });
// L=4, H=3 -> hyp=5, cosφ=0.8, sinφ=0.6: every expected value is exact.
const ramp = (over = {}) => ({ type: 'ramp', yaw: IDENTITY_YAW, dims: { length: 4, width: 3, height: 3 }, seed: 0x4a3b2c1d, ...over });

describe('featureGeometry: log (capsule laid on its side)', () => {
  test('shape is a capsule with halfHeight = length/2 (caps extend by radius)', () => {
    const g = featureGeometry(log());
    expect(g.shape).toEqual({ kind: 'capsule', halfHeight: 2.5, radius: 0.3 });
    expect(g.points).toBeNull();
  });

  test('identity yaw -> pure roll (0, 0, -sqrt(1/2), sqrt(1/2)): capsule +Y axis onto +X', () => {
    const g = featureGeometry(log());
    expect(g.quat.x).toBe(0);
    expect(g.quat.y).toBeCloseTo(0, 15);
    expect(g.quat.z).toBeCloseTo(-SQRT_HALF, 15);
    expect(g.quat.w).toBeCloseTo(SQRT_HALF, 15);
    // the roll genuinely sends the local +Y capsule axis onto +X:
    expect(rotate(g.quat, { x: 0, y: 1, z: 0 }).x).toBeCloseTo(1, 12);
  });

  test('support samples: center + both axis ends along the yaw heading, bottom = -radius', () => {
    const yaw = { cos: 0, sin: 1 };
    const g = featureGeometry(log({ yaw }));
    expect(g.supportSamples).toEqual([
      { dx: 0, dz: 0, bottomOffset: -0.3 },
      { dx: -0, dz: -2.5, bottomOffset: -0.3 },
      { dx: 0, dz: 2.5, bottomOffset: -0.3 },
    ]);
    expect(quatNorm(g.quat)).toBeCloseTo(1, 12);
    // capsule axis follows +heading (+Z here); it is symmetric, so the ±half
    // end samples both lie on the axis line either way:
    expect(rotate(g.quat, { x: 0, y: 1, z: 0 }).z).toBeCloseTo(1, 12);
  });
});

describe('featureGeometry: ramp (pitched cuboid slab)', () => {
  test('shape is a cuboid slab: hx = hyp/2, hy = thickness/2, hz = width/2', () => {
    const g = featureGeometry(ramp());
    expect(g.shape).toEqual({ kind: 'cuboid', hx: 2.5, hy: 0.15, hz: 1.5 });
    expect(g.points).toBeNull();
  });

  test('identity yaw -> pure pitch about Z: (0, 0, sqrt((1-cosφ)/2), sqrt((1+cosφ)/2))', () => {
    const g = featureGeometry(ramp());
    expect(g.quat.x).toBe(0);
    expect(g.quat.y).toBeCloseTo(0, 15);
    expect(g.quat.z).toBeCloseTo(Math.sqrt((1 - 0.8) / 2), 15);
    expect(g.quat.w).toBeCloseTo(Math.sqrt((1 + 0.8) / 2), 15);
  });

  test('support samples follow the pinned sign table (low end faces -yaw)', () => {
    const g = featureGeometry(ramp());
    const t = 0.3; // default rampThickness
    expect(g.supportSamples).toEqual([
      { dx: -2, dz: -0, bottomOffset: -1.5 - (t / 2) * 0.8 }, // low end: -L/2, -H/2 - (t/2)cosφ
      { dx: 0, dz: 0, bottomOffset: -(t / 2) * 0.8 },         // center
      { dx: 2, dz: 0, bottomOffset: 1.5 - (t / 2) * 0.8 },    // high end: +L/2, +H/2 - (t/2)cosφ
    ]);
  });

  test('ordering lock: bottomOffset(low) < bottomOffset(center) < bottomOffset(high), and the low-end bottom corner is the lowest point', () => {
    const g = featureGeometry(ramp({ yaw: { cos: SQRT_HALF, sin: SQRT_HALF } }));
    const [low, center, high] = g.supportSamples;
    expect(low.bottomOffset).toBeLessThan(center.bottomOffset);
    expect(center.bottomOffset).toBeLessThan(high.bottomOffset);
    // The slab's global minimum offset IS the low-end support: -(hyp/2)sinφ - (t/2)cosφ.
    expect(low.bottomOffset).toBeCloseTo(-(5 / 2) * 0.6 - (0.3 / 2) * 0.8, 15);
  });

  // Consistency lock (the ramp half of the mirrored-yaw bug): the collider's
  // rotated length axis (local +X, the raised HIGH end) must point the SAME
  // horizontal direction as the high-end support sample. If the yaw quaternion
  // is mirrored, the seating ray samples the terrain on the wrong side of the
  // slab and mis-seats on any Z-varying ground.
  test('rotated collider high end and the high-end support sample share a heading', () => {
    for (const yaw of [{ cos: 0.6, sin: 0.8 }, { cos: -0.6, sin: 0.8 }, { cos: SQRT_HALF, sin: -SQRT_HALF }]) {
      const g = featureGeometry(ramp({ yaw }));
      const axis = rotate(g.quat, { x: 1, y: 0, z: 0 }); // local +X = high end
      const high = g.supportSamples[2];
      // horizontal parts are parallel and same-signed (dot of unit dirs ≈ 1)
      const axisLen = Math.sqrt(axis.x * axis.x + axis.z * axis.z);
      const sampLen = Math.sqrt(high.dx * high.dx + high.dz * high.dz);
      const dot = (axis.x * high.dx + axis.z * high.dz) / (axisLen * sampLen);
      expect(dot).toBeCloseTo(1, 6);
    }
  });
});

const boulder = (over = {}) => ({ type: 'boulder', yaw: IDENTITY_YAW, dims: { radius: 0.8 }, seed: 0xb0d1de5, ...over });

describe('featureGeometry: boulder (jittered convex hull from the trailing seed)', () => {
  test('hull: flat xyz array, default 12 vertices, every radius within radius·[0.7, 1.0]', () => {
    const g = featureGeometry(boulder());
    expect(g.shape.kind).toBe('convexHull');
    expect(g.shape.points).toBe(g.points);
    expect(g.points).toHaveLength(12 * 3);
    for (let i = 0; i < g.points.length; i += 3) {
      const r = Math.sqrt(g.points[i] ** 2 + g.points[i + 1] ** 2 + g.points[i + 2] ** 2);
      expect(r).toBeGreaterThanOrEqual(0.8 * 0.7 - 1e-6);
      expect(r).toBeLessThanOrEqual(0.8 * 1.0 + 1e-6);
    }
  });

  test('points are f32-quantized so collider and render mesh share exact vertices', () => {
    const g = featureGeometry(boulder());
    for (const v of g.points) expect(Math.fround(v)).toBe(v);
  });

  test('same seed -> bit-identical points; different seed -> different points', () => {
    const a = featureGeometry(boulder());
    const b = featureGeometry(boulder());
    expect(b.points).toEqual(a.points);
    const c = featureGeometry(boulder({ seed: 0xb0d1de6 }));
    expect(c.points).not.toEqual(a.points);
  });

  test('quat is the plain yaw quaternion (no pitch/roll)', () => {
    const yaw = { cos: 0, sin: 1 };
    expect(featureGeometry(boulder({ yaw }))).toHaveProperty('quat', yawToQuaternion(yaw));
  });

  test('support samples: center + 4 compass points at r·jitterMin, bottom = min hull Y', () => {
    const g = featureGeometry(boulder());
    const minY = Math.min(...g.points.filter((_, i) => i % 3 === 1));
    const r = 0.8 * 0.7;
    expect(g.supportSamples).toEqual([
      { dx: 0, dz: 0, bottomOffset: minY },
      { dx: -r, dz: 0, bottomOffset: minY },
      { dx: r, dz: 0, bottomOffset: minY },
      { dx: 0, dz: -r, bottomOffset: minY },
      { dx: 0, dz: r, bottomOffset: minY },
    ]);
    expect(minY).toBeLessThan(0); // a hull with no underside would float
  });
});

describe('featureGeometry options (every knob validated, fail loud)', () => {
  test('defaults are exported and frozen', () => {
    expect(FEATURE_GEOMETRY_DEFAULTS).toEqual({
      boulderVertexCount: 12,
      boulderJitterRange: [0.7, 1.0],
      rampThickness: 0.3,
    });
    expect(Object.isFrozen(FEATURE_GEOMETRY_DEFAULTS)).toBe(true);
  });

  test('boulderVertexCount and boulderJitterRange shape the hull', () => {
    const g = featureGeometry(boulder(), { boulderVertexCount: 6, boulderJitterRange: [0.9, 0.9] });
    expect(g.points).toHaveLength(6 * 3);
    for (let i = 0; i < g.points.length; i += 3) {
      const r = Math.sqrt(g.points[i] ** 2 + g.points[i + 1] ** 2 + g.points[i + 2] ** 2);
      expect(r).toBeCloseTo(0.8 * 0.9, 6);
    }
    // support footprint follows jitterMin
    expect(g.supportSamples[1].dx).toBeCloseTo(-0.8 * 0.9, 12);
  });

  test('rampThickness shapes the slab and its support offsets', () => {
    const g = featureGeometry(ramp(), { rampThickness: 0.5 });
    expect(g.shape.hy).toBeCloseTo(0.25, 15);
    expect(g.supportSamples[1].bottomOffset).toBeCloseTo(-0.25 * 0.8, 15);
  });

  test('boulderVertexCount: <4, non-integer, NaN, Infinity all throw', () => {
    for (const bad of [3, 0, -1, 6.5, NaN, Infinity]) {
      expect(() => featureGeometry(boulder(), { boulderVertexCount: bad })).toThrow(/boulderVertexCount/);
    }
  });

  test('boulderJitterRange: wrong shape, min>max, min<=0, max>1, non-finite all throw', () => {
    for (const bad of [0.7, [0.7], [0.9, 0.7], [0, 1], [-0.1, 0.5], [0.7, 1.1], [NaN, 1], [0.7, Infinity]]) {
      expect(() => featureGeometry(boulder(), { boulderJitterRange: bad })).toThrow(/boulderJitterRange/);
    }
  });

  test('rampThickness: <=0, NaN, Infinity all throw', () => {
    for (const bad of [0, -0.3, NaN, Infinity]) {
      expect(() => featureGeometry(ramp(), { rampThickness: bad })).toThrow(/rampThickness/);
    }
  });

  test('malformed yaw and unknown type fail loud', () => {
    expect(() => featureGeometry(boulder({ yaw: { cos: 2, sin: 0 } }))).toThrow(/unit/);
    expect(() => featureGeometry({ type: 'asteroid', yaw: IDENTITY_YAW, dims: {}, seed: 1 })).toThrow(/asteroid/);
  });
});

describe('locked hull fingerprint (deliberate re-lock + version note required to change)', () => {
  // FNV-1a over the LE float32 serialization of every boulder hull vertex at
  // seed 20260708, default config + default geometry options, in feature index
  // order — the same helper style as tests/terrain.test.js. The whole chain is
  // integer Rng draws and correctly-rounded sqrt/fround, so this hash is
  // cross-platform stable. If it moves, hull-vertex jitter changed for every
  // shared seed: re-lock only with a seed-format version bump.
  test('seed 20260708 boulder hull points -> 06f5fca4', async () => {
    const { generateCorridorTerrain } = await import('../src/sim/terrain.js');
    const terrain = generateCorridorTerrain({ seed: 20260708 });
    const boulders = terrain.features.filter((f) => f.type === 'boulder');
    expect(boulders.length).toBeGreaterThan(0); // guard: an empty lock checks nothing
    const all = boulders.flatMap((f) => featureGeometry(f).points);
    const view = new DataView(new ArrayBuffer(all.length * 4));
    all.forEach((v, i) => view.setFloat32(i * 4, v, true));
    let h = 0x811c9dc5;
    for (let b = 0; b < view.byteLength; b++) {
      h ^= view.getUint8(b);
      h = Math.imul(h, 0x01000193);
    }
    expect((h >>> 0).toString(16).padStart(8, '0')).toBe('06f5fca4');
  });
});
