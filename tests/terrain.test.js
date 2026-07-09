import { describe, test, expect } from 'vitest';
import {
  generateCorridorTerrain, indexToLocalXZ, startEnvelope, craterDepthAt,
  zoneAt, MATERIALS, FEATURE_TYPES, heightAtLocal,
} from '../src/sim/terrain.js';

// Pure generator tests (no Rapier / WASM). Physics realization + the fall-through
// catch gate live in tests/terrain-physics.test.js.

// FNV-1a over an explicit LITTLE-ENDIAN float32 serialization of the heights
// buffer — host-byte-order independent, captures the exact stored field. If this
// changes, generated terrain changed: seed-sharing / replays break. Do NOT update
// without a seed-format version bump.
function fingerprintHeights(heights) {
  const view = new DataView(new ArrayBuffer(heights.length * 4));
  for (let i = 0; i < heights.length; i++) view.setFloat32(i * 4, heights[i], true); // LE
  let h = 0x811c9dc5;
  for (let b = 0; b < view.byteLength; b++) {
    h ^= view.getUint8(b);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// FNV-1a straight over raw bytes (zone materials are already bytes — no
// endianness concern). Same locked-constant discipline as fingerprintHeights.
function fingerprintBytes(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// FNV-1a over float64 LE values in a documented fixed order — for descriptor
// fingerprints (craters, features). Same locked-constant discipline as
// fingerprintHeights: adding/reordering serialized fields is a deliberate
// re-lock, never a silent update.
function fingerprintFloat64s(values) {
  const view = new DataView(new ArrayBuffer(values.length * 8));
  values.forEach((v, i) => view.setFloat64(i * 8, v, true)); // LE
  let h = 0x811c9dc5;
  for (let b = 0; b < view.byteLength; b++) {
    h ^= view.getUint8(b);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('corridor terrain generator (pure, deterministic)', () => {
  test('locked BASE-field fingerprint: seed 20260708 + craterDensity 0 reproduces e2157c82, forever (Step-1a guard)', () => {
    // Permanent regression guard for the Step-1a base field: with craters off,
    // the generator must be a byte-exact no-op over the 1a pipeline. The
    // constant survives from Step 1a — pinning craterDensity: 0 here is NOT a
    // re-lock. The default config (craters on) gets its own lock below.
    const t = generateCorridorTerrain({ seed: 20260708, craterDensity: 0 });
    expect(fingerprintHeights(t.heights)).toBe('e2157c82');
  });

  test('locked DEFAULT-config heights fingerprint: seed 20260708 (craters baked), forever', () => {
    // First-time lock (Step 1b, terrain v2): the composite default field —
    // base noise plus baked craters. Do NOT update without a version bump.
    const t = generateCorridorTerrain({ seed: 20260708 });
    expect(fingerprintHeights(t.heights)).toBe('48177e22');
  });

  test('locked DEFAULT-config craters fingerprint: seed 20260708, forever', () => {
    // First-time lock (Step 1b). Serialization order per crater: x, z, radius,
    // depth (f64 LE). Isolates crater-stream drift from base-noise drift, which
    // the heights fingerprint alone would conflate.
    const t = generateCorridorTerrain({ seed: 20260708 });
    const fields = t.craters.flatMap((c) => [c.x, c.z, c.radius, c.depth]);
    expect(fingerprintFloat64s(fields)).toBe('b9e05cf7');
  });

  test('locked DEFAULT-config zones fingerprint: seed 20260708, forever', () => {
    // First-time lock (Step 1b): raw material bytes in column-major cell order.
    // 198 SAND + 66 MUD of 1320 eligible cells = the exact 0.15/0.05 quantiles.
    const t = generateCorridorTerrain({ seed: 20260708 });
    expect(fingerprintBytes(t.zones.materials)).toBe('903a3d5f');
  });

  test('locked DEFAULT-config features fingerprint: seed 20260708, forever', () => {
    // First-time lock (Step 1b). Serialization per feature, in array order:
    // u8 type id (FEATURE_TYPES index), f64 LE x, z, y, yaw.cos, yaw.sin,
    // then dims in fixed per-type order (boulder: radius; ramp: length, width,
    // height; log: radius, length), then u32 LE seed. Adding or reordering
    // fields is a deliberate re-lock; new fields append after `seed`.
    const t = generateCorridorTerrain({ seed: 20260708 });
    let h = 0x811c9dc5;
    for (const f of t.features) {
      const dims = f.type === 'boulder' ? [f.dims.radius]
        : f.type === 'ramp' ? [f.dims.length, f.dims.width, f.dims.height]
        : [f.dims.radius, f.dims.length];
      const view = new DataView(new ArrayBuffer(1 + 8 * (5 + dims.length) + 4));
      view.setUint8(0, FEATURE_TYPES.indexOf(f.type));
      [f.x, f.z, f.y, f.yaw.cos, f.yaw.sin, ...dims].forEach((v, i) => view.setFloat64(1 + i * 8, v, true));
      view.setUint32(1 + 8 * (5 + dims.length), f.seed, true);
      for (let b = 0; b < view.byteLength; b++) {
        h ^= view.getUint8(b);
        h = Math.imul(h, 0x01000193);
      }
    }
    expect(((h >>> 0).toString(16)).padStart(8, '0')).toBe('f3f86cbc');
  });

  test('same seed -> identical heights; different seed -> different heights', () => {
    const a = generateCorridorTerrain({ seed: 7 }).heights;
    const b = generateCorridorTerrain({ seed: 7 }).heights;
    const c = generateCorridorTerrain({ seed: 8 }).heights;
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  test('grid dimensions and column-major buffer length are consistent', () => {
    const t = generateCorridorTerrain({ seed: 1, length: 120, width: 12, cellSize: 1 });
    expect(t.rows).toBe(12); // Z cells
    expect(t.cols).toBe(120); // X cells
    expect(t.heights.length).toBe((t.rows + 1) * (t.cols + 1));
    // Deliberate re-lock 1 -> 2 (Step 1b): craters bake into default heights, so
    // the same seed produces different bytes than v1 — the seed-format bump.
    expect(t.version).toBe(2);
    expect(t.scale).toEqual({ x: 120, y: 1, z: 12 });
  });

  test('indexToLocalXZ maps corners and center per the [V1] convention', () => {
    const t = generateCorridorTerrain({ seed: 1 });
    expect(indexToLocalXZ(0, 0, t)).toEqual({ x: -60, z: -6 }); // col0->-X, row0->-Z
    expect(indexToLocalXZ(t.rows, t.cols, t)).toEqual({ x: 60, z: 6 }); // far corner
    expect(indexToLocalXZ(t.rows / 2, t.cols / 2, t)).toEqual({ x: 0, z: 0 }); // centre
  });

  test('start envelope: flat 0 over the pad, monotone through the blend, 1 after', () => {
    const cfg = { length: 120, startFlatLength: 4, startBlendLength: 6 };
    const at = (x) => startEnvelope(x, cfg);
    // Flat pad: x in [-60, -56] (d in [0,4]) is exactly 0.
    expect(at(-60)).toBe(0);
    expect(at(-58)).toBe(0);
    expect(at(-56)).toBe(0);
    // Blend: strictly increasing across (-56, -50).
    const blend = [-55, -54, -53, -52, -51].map(at);
    for (let i = 1; i < blend.length; i++) {
      expect(blend[i]).toBeGreaterThan(blend[i - 1]);
      expect(blend[i]).toBeGreaterThan(0);
      expect(blend[i]).toBeLessThan(1);
    }
    // Full terrain: x >= -50 (d >= 10) is exactly 1.
    expect(at(-50)).toBe(1);
    expect(at(0)).toBe(1);
    expect(at(60)).toBe(1);
  });

  test('flat pad has zero elevation; full terrain appears beyond the blend', () => {
    const t = generateCorridorTerrain({ seed: 42 });
    // cols 0..4 -> x in [-60,-56] (flat pad) -> every height exactly 0.
    for (let col = 0; col <= 4; col++) {
      for (let row = 0; row <= t.rows; row++) {
        expect(t.heights[col * (t.rows + 1) + row]).toBe(0);
      }
    }
    // Beyond the blend (cols >= 11 -> x >= -49) real elevation exists.
    let maxAbs = 0;
    for (let col = 11; col <= t.cols; col++) {
      for (let row = 0; row <= t.rows; row++) {
        maxAbs = Math.max(maxAbs, Math.abs(t.heights[col * (t.rows + 1) + row]));
      }
    }
    expect(maxAbs).toBeGreaterThan(0.1);
  });

  test('two walls sized to terrain bounds, inner faces flush at z = ±width/2', () => {
    const t = generateCorridorTerrain({ seed: 3, width: 12, wallThickness: 0.5, length: 120 });
    expect(t.walls).toHaveLength(2);
    const [neg, pos] = t.walls;
    // Placement: flush inner faces, spanning the full length.
    expect(neg.pos.z).toBeCloseTo(-(12 / 2 + 0.5 / 2), 10);
    expect(pos.pos.z).toBeCloseTo(12 / 2 + 0.5 / 2, 10);
    expect(pos.half.x).toBe(60);
    expect(pos.half.z).toBe(0.25);
    expect(pos.restitution).toBe(0.1);
    // Height spans below the lowest dip and above the highest peak (clearance).
    const bottom = pos.pos.y - pos.half.y;
    const top = pos.pos.y + pos.half.y;
    expect(bottom).toBeCloseTo(t.bounds.minY - 1, 10); // wallEmbed
    expect(top).toBeCloseTo(t.bounds.maxY + 4, 10); // wallClearance
    expect(bottom).toBeLessThan(t.bounds.minY);
    expect(top).toBeGreaterThan(t.bounds.maxY);
  });

  describe('craters (descriptors — dedicated stream, envelope-clear, drivable)', () => {
    test('craterDensity 0 -> empty craters array; default -> at least one', () => {
      expect(generateCorridorTerrain({ seed: 5, craterDensity: 0 }).craters).toEqual([]);
      expect(generateCorridorTerrain({ seed: 20260708 }).craters.length).toBeGreaterThanOrEqual(1);
    });

    test('descriptors in range, fully inside the corridor, clear of the start envelope', () => {
      const cfg = { seed: 20260708 };
      const t = generateCorridorTerrain(cfg);
      const { length, width, startFlatLength, startBlendLength, craterRadiusRange, craterDepthRatioRange } = {
        length: 120, width: 12, startFlatLength: 4, startBlendLength: 6,
        craterRadiusRange: [2, 5], craterDepthRatioRange: [0.08, 0.22],
      };
      const envelopeEndX = -length / 2 + startFlatLength + startBlendLength; // -50
      for (const c of t.craters) {
        expect(c.radius).toBeGreaterThanOrEqual(craterRadiusRange[0]);
        expect(c.radius).toBeLessThanOrEqual(craterRadiusRange[1]);
        const ratio = c.depth / c.radius;
        expect(ratio).toBeGreaterThanOrEqual(craterDepthRatioRange[0]);
        expect(ratio).toBeLessThanOrEqual(craterDepthRatioRange[1]);
        // Drivability: max slope of the smootherstep profile is 1.875*depth/radius.
        expect((1.875 * c.depth) / c.radius).toBeLessThanOrEqual(0.5);
        // Fully inside the corridor (no wall-clipped rims until PR #8).
        expect(Math.abs(c.z) + c.radius).toBeLessThanOrEqual(width / 2);
        expect(c.x + c.radius).toBeLessThanOrEqual(length / 2);
        // Never intersects the flat pad or the blend.
        expect(c.x - c.radius).toBeGreaterThanOrEqual(envelopeEndX);
      }
    });

    test('same seed -> identical craters; different seed -> different', () => {
      const a = generateCorridorTerrain({ seed: 7 }).craters;
      const b = generateCorridorTerrain({ seed: 7 }).craters;
      const c = generateCorridorTerrain({ seed: 8 }).craters;
      expect(a).toEqual(b);
      expect(a).not.toEqual(c);
    });
  });

  describe('crater bake (heights = base field minus the analytic depression)', () => {
    test('craterDepthAt profile: full depth at center, 0 at/beyond rim, smootherstep midpoint, monotone, flat tangents', () => {
      const craters = [{ x: 0, z: 0, radius: 4, depth: 1 }];
      expect(craterDepthAt(0, 0, craters)).toBeCloseTo(1, 12);
      expect(craterDepthAt(4, 0, craters)).toBe(0); // exactly zero at the rim
      expect(craterDepthAt(6, 0, craters)).toBe(0); // zero support outside the radius
      expect(craterDepthAt(2, 0, craters)).toBeCloseTo(0.5, 12); // smootherstep(0.5) = 0.5
      // Monotone non-increasing from center to rim.
      let prev = Infinity;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const d = craterDepthAt(4 * t, 0, craters);
        expect(d).toBeLessThanOrEqual(prev + 1e-12);
        prev = d;
      }
      // C1 profile: numerically flat tangent at both the center and the rim
      // (kills a cliff-walled bake; max slope lives at mid-radius).
      const h = 0.01;
      expect(Math.abs(craterDepthAt(h, 0, craters) - craterDepthAt(0, 0, craters)) / h).toBeLessThan(0.01);
      expect(Math.abs(craterDepthAt(4 - h, 0, craters) - craterDepthAt(4, 0, craters)) / h).toBeLessThan(0.01);
    });

    test('vertex-exact bake: default field = craterDensity-0 twin minus craterDepthAt, everywhere', () => {
      const cratered = generateCorridorTerrain({ seed: 20260708 });
      const flat = generateCorridorTerrain({ seed: 20260708, craterDensity: 0 });
      let touched = 0;
      for (let col = 0; col <= cratered.cols; col++) {
        for (let row = 0; row <= cratered.rows; row++) {
          const k = col * (cratered.rows + 1) + row;
          const { x, z } = indexToLocalXZ(row, col, cratered);
          const expected = craterDepthAt(x, z, cratered.craters);
          expect(flat.heights[k] - cratered.heights[k]).toBeCloseTo(expected, 5);
          if (expected > 0) touched++;
        }
      }
      expect(touched).toBeGreaterThan(0); // the bake actually happened
    });

    test('bounds and walls follow post-crater heights (seed 20260708)', () => {
      const cratered = generateCorridorTerrain({ seed: 20260708 });
      const flat = generateCorridorTerrain({ seed: 20260708, craterDensity: 0 });
      // A crater floor undercuts the base field's global minimum at this seed —
      // walls sized from pre-crater bounds would leave a gap underneath.
      expect(cratered.bounds.minY).toBeLessThan(flat.bounds.minY);
      const [, pos] = cratered.walls;
      expect(pos.pos.y - pos.half.y).toBeCloseTo(cratered.bounds.minY - 1, 10); // wallEmbed tracks new minY
    });
  });

  describe('zones (per-cell material grid — own stream, exact-quantile coverage)', () => {
    test('one cell per heightfield cell, column-major, legal material IDs only', () => {
      const t = generateCorridorTerrain({ seed: 20260708 });
      expect(t.zones.rows).toBe(t.rows);
      expect(t.zones.cols).toBe(t.cols);
      expect(t.zones.materials).toBeInstanceOf(Uint8Array);
      expect(t.zones.materials.length).toBe(t.rows * t.cols);
      const legal = new Set(Object.values(MATERIALS));
      for (const m of t.zones.materials) expect(legal.has(m)).toBe(true);
      // Grid dimensions are a function of geometry only — stable across seeds
      // and coverage knobs.
      const other = generateCorridorTerrain({ seed: 99, sandCoverage: 0.5, mudCoverage: 0.3 });
      expect(other.zones.rows).toBe(t.zones.rows);
      expect(other.zones.cols).toBe(t.zones.cols);
    });

    test('coverage 0 -> all FIRM; sandCoverage 1 -> every post-envelope cell SAND', () => {
      const firm = generateCorridorTerrain({ seed: 11, sandCoverage: 0, mudCoverage: 0 });
      expect(firm.zones.materials.every((m) => m === MATERIALS.FIRM)).toBe(true);

      const sandy = generateCorridorTerrain({ seed: 11, sandCoverage: 1, mudCoverage: 0 });
      const cfg = { length: 120, startFlatLength: 4, startBlendLength: 6 };
      let sandCells = 0;
      for (let col = 0; col < sandy.cols; col++) {
        for (let row = 0; row < sandy.rows; row++) {
          const { x } = indexToLocalXZ(row + 0.5, col + 0.5, sandy); // cell center
          const expected = startEnvelope(x, cfg) === 1 ? MATERIALS.SAND : MATERIALS.FIRM;
          expect(sandy.zones.materials[col * sandy.rows + row]).toBe(expected);
          if (expected === MATERIALS.SAND) sandCells++;
        }
      }
      expect(sandCells).toBeGreaterThan(0); // never vacuous
    });

    test('exact-quantile counts, capped so rounding cannot overflow a tiny grid', () => {
      // 3 eligible cells (1x13 grid, envelope covers the first 10 m), coverage
      // 0.5 + 0.5: naive round(1.5) + round(1.5) = 4 > 3 would overflow; the
      // capped sequential rule gives MUD 2, SAND 1, total exactly n.
      const t = generateCorridorTerrain({
        seed: 13, length: 13, width: 1, cellSize: 1,
        sandCoverage: 0.5, mudCoverage: 0.5, craterDensity: 0, featureDensity: 0,
      });
      const counts = { [MATERIALS.FIRM]: 0, [MATERIALS.SAND]: 0, [MATERIALS.MUD]: 0 };
      for (const m of t.zones.materials) counts[m]++;
      expect(counts[MATERIALS.MUD]).toBe(2); // min(3, round(0.5*3)=2)
      expect(counts[MATERIALS.SAND]).toBe(1); // min(3-2, round(0.5*3)=2) = 1
      expect(counts[MATERIALS.FIRM]).toBe(t.zones.materials.length - 3);
    });

    test('same seed -> identical zones; different seed -> different', () => {
      const a = generateCorridorTerrain({ seed: 7 }).zones.materials;
      const b = generateCorridorTerrain({ seed: 7 }).zones.materials;
      const c = generateCorridorTerrain({ seed: 8 }).zones.materials;
      expect(Array.from(a)).toEqual(Array.from(b));
      expect(Array.from(a)).not.toEqual(Array.from(c));
    });

    test('zoneAt mirrors indexToLocalXZ: exhaustive cell-center round-trip on a small grid', () => {
      // Small enough to check every cell by hand; wide coverage so most cells
      // are non-FIRM and the round-trip is not vacuously all-zeros.
      const t = generateCorridorTerrain({
        seed: 21, length: 8, width: 4, cellSize: 1,
        startFlatLength: 1, startBlendLength: 1, sandCoverage: 0.5, mudCoverage: 0.3,
        craterDensity: 0,
      });
      for (let col = 0; col < t.cols; col++) {
        for (let row = 0; row < t.rows; row++) {
          const { x, z } = indexToLocalXZ(row + 0.5, col + 0.5, t); // cell center
          expect(zoneAt(x, z, t)).toBe(t.zones.materials[col * t.rows + row]);
        }
      }
      const mats = new Set(t.zones.materials);
      expect(mats.size).toBeGreaterThan(1); // round-trip saw real variety
    });

    test('zoneAt clamps: field-edge corners and far out-of-bounds map to edge cells', () => {
      const t = generateCorridorTerrain({ seed: 21, sandCoverage: 0.5, mudCoverage: 0.3 });
      const { rows, cols, materials } = t.zones;
      // Exact +corner (x = +length/2, z = +width/2) hits the last cell.
      expect(zoneAt(60, 6, t)).toBe(materials[(cols - 1) * rows + (rows - 1)]);
      // Exact -corner hits cell (0, 0).
      expect(zoneAt(-60, -6, t)).toBe(materials[0]);
      // Far out of bounds clamps to the nearest edge cell (never throws).
      expect(zoneAt(1e6, 0, t)).toBe(zoneAt(60 - 0.5, 0, t));
      expect(zoneAt(0, -1e6, t)).toBe(zoneAt(0, -6 + 0.5, t));
    });

    test('start pad and blend are FIRM under the default config', () => {
      const t = generateCorridorTerrain({ seed: 20260708 });
      const cfg = { length: 120, startFlatLength: 4, startBlendLength: 6 };
      for (let col = 0; col < t.cols; col++) {
        for (let row = 0; row < t.rows; row++) {
          const { x, z } = indexToLocalXZ(row + 0.5, col + 0.5, t);
          if (startEnvelope(x, cfg) < 1) {
            expect(zoneAt(x, z, t)).toBe(MATERIALS.FIRM);
          }
        }
      }
    });
  });

  describe('features (boulder/ramp/log descriptors — data only, colliders are PR #8)', () => {
    // Yaw-safe conservative footprint per type (matches the placement margins).
    const halfExtent = (f) =>
      f.type === 'boulder' ? f.dims.radius
      : f.type === 'ramp' ? Math.sqrt((f.dims.length / 2) ** 2 + (f.dims.width / 2) ** 2)
      : f.dims.length / 2 + f.dims.radius; // log capsule: half axis + cap

    test('featureDensity 0 -> empty; default -> at least one of the known types', () => {
      expect(generateCorridorTerrain({ seed: 5, featureDensity: 0 }).features).toEqual([]);
      const t = generateCorridorTerrain({ seed: 20260708 });
      expect(t.features.length).toBeGreaterThanOrEqual(1);
      for (const f of t.features) expect(FEATURE_TYPES).toContain(f.type);
    });

    test('per-type schema: finite fields, dims in configured ranges, unit yaw, u32 seed', () => {
      const t = generateCorridorTerrain({ seed: 20260708 });
      for (const f of t.features) {
        expect(Number.isFinite(f.x)).toBe(true);
        expect(Number.isFinite(f.z)).toBe(true);
        expect(Number.isFinite(f.y)).toBe(true);
        expect(Math.abs(f.yaw.cos ** 2 + f.yaw.sin ** 2 - 1)).toBeLessThan(1e-12);
        expect(Number.isInteger(f.seed)).toBe(true);
        expect(f.seed).toBeGreaterThanOrEqual(0);
        expect(f.seed).toBeLessThan(2 ** 32);
        if (f.type === 'boulder') {
          expect(f.dims.radius).toBeGreaterThanOrEqual(0.4);
          expect(f.dims.radius).toBeLessThanOrEqual(1.1);
        } else if (f.type === 'ramp') {
          expect(f.dims.length).toBeGreaterThanOrEqual(4);
          expect(f.dims.length).toBeLessThanOrEqual(8);
          expect(f.dims.width).toBeGreaterThanOrEqual(2.5);
          expect(f.dims.width).toBeLessThanOrEqual(4);
          expect(f.dims.height).toBeGreaterThanOrEqual(0.6);
          expect(f.dims.height).toBeLessThanOrEqual(1.6);
          // Ramps roughly face +X (drivable up-corridor), never sideways/backwards.
          expect(f.yaw.cos).toBeGreaterThan(0.9);
        } else {
          expect(f.dims.radius).toBeGreaterThanOrEqual(0.25);
          expect(f.dims.radius).toBeLessThanOrEqual(0.45);
          expect(f.dims.length).toBeGreaterThanOrEqual(3);
          expect(f.dims.length).toBeLessThanOrEqual(7);
        }
      }
    });

    test('no feature reaches the start envelope, the corridor end, or the walls', () => {
      const t = generateCorridorTerrain({ seed: 20260708 });
      const envelopeEndX = -120 / 2 + 4 + 6; // -50
      for (const f of t.features) {
        const h = halfExtent(f);
        expect(f.x - h).toBeGreaterThanOrEqual(envelopeEndX);
        expect(f.x + h).toBeLessThanOrEqual(60);
        expect(Math.abs(f.z) + h).toBeLessThanOrEqual(6);
      }
    });

    test('heightAtLocal: exact at vertices, corner-mean at cell centers (pins the sampler)', () => {
      const t = generateCorridorTerrain({ seed: 42 });
      const h = (row, col) => t.heights[col * (t.rows + 1) + row] * t.scale.y;
      // Exact at a spread of vertices, including the far corner.
      for (const [row, col] of [[0, 0], [3, 17], [t.rows, t.cols], [7, 60]]) {
        const { x, z } = indexToLocalXZ(row, col, t);
        expect(heightAtLocal(x, z, t)).toBeCloseTo(h(row, col), 12);
      }
      // Bilinear identity at a cell center: mean of the 4 corners.
      const { x: cx, z: cz } = indexToLocalXZ(4.5, 30.5, t);
      const mean = (h(4, 30) + h(4, 31) + h(5, 30) + h(5, 31)) / 4;
      expect(heightAtLocal(cx, cz, t)).toBeCloseTo(mean, 12);
    });

    test('feature y is the post-crater ground height at its (x, z)', () => {
      const t = generateCorridorTerrain({ seed: 20260708 });
      for (const f of t.features) {
        expect(f.y).toBeCloseTo(heightAtLocal(f.x, f.z, t), 12);
      }
    });

    test('stream isolation: knobs of one subsystem never leak into another', () => {
      const base = generateCorridorTerrain({ seed: 20260708 });
      // Heights are invariant to zone/feature knobs...
      const knobbed = generateCorridorTerrain({ seed: 20260708, sandCoverage: 0.9, featureDensity: 2 });
      expect(fingerprintHeights(knobbed.heights)).toBe(fingerprintHeights(base.heights));
      // ...zones are invariant to craterDensity...
      const flat = generateCorridorTerrain({ seed: 20260708, craterDensity: 0 });
      expect(Array.from(flat.zones.materials)).toEqual(Array.from(base.zones.materials));
      // ...and features keep identical draws (x, z, yaw, dims, seed) with craters
      // off — only y (sampled from the baked surface) may move.
      expect(flat.features.length).toBe(base.features.length);
      base.features.forEach((f, i) => {
        const g = flat.features[i];
        expect([g.type, g.x, g.z, g.yaw.cos, g.yaw.sin, g.seed]).toEqual([f.type, f.x, f.z, f.yaw.cos, f.yaw.sin, f.seed]);
        expect(g.dims).toEqual(f.dims);
      });
    });

    test('feature y is sampled AFTER the crater bake (declared seed 1)', () => {
      // Seed 1 places a feature inside a crater (craterDepthAt > 0.05 there),
      // so its y must drop relative to the craterDensity-0 twin at the same
      // (x, z) — proving y reads the baked surface, not the base field.
      const cratered = generateCorridorTerrain({ seed: 1 });
      const flat = generateCorridorTerrain({ seed: 1, craterDensity: 0 });
      const drops = cratered.features.map((f, i) => flat.features[i].y - f.y);
      expect(Math.max(...drops)).toBeGreaterThan(0.04);
    });

    test('same seed -> identical features; different seed -> different', () => {
      const a = generateCorridorTerrain({ seed: 7 }).features;
      const b = generateCorridorTerrain({ seed: 7 }).features;
      const c = generateCorridorTerrain({ seed: 8 }).features;
      expect(a).toEqual(b);
      expect(a).not.toEqual(c);
    });
  });

  describe('config validation (fail loud on degenerate input)', () => {
    test('rejects non-positive cellSize / length / width', () => {
      // cellSize=0 would otherwise RangeError on Float32Array(Infinity).
      expect(() => generateCorridorTerrain({ cellSize: 0 })).toThrow(/cellSize/);
      expect(() => generateCorridorTerrain({ cellSize: -1 })).toThrow(/cellSize/);
      // length<=0 would otherwise RangeError on a negative typed-array length.
      expect(() => generateCorridorTerrain({ length: -10 })).toThrow(/length and width/);
      expect(() => generateCorridorTerrain({ width: 0 })).toThrow(/length and width/);
    });

    test('rejects bad wall params', () => {
      expect(() => generateCorridorTerrain({ wallThickness: 0 })).toThrow(/wallThickness/);
      expect(() => generateCorridorTerrain({ wallClearance: -1 })).toThrow(/wallClearance and wallEmbed/);
      expect(() => generateCorridorTerrain({ wallEmbed: -1 })).toThrow(/wallClearance and wallEmbed/);
    });

    test('rejects negative start lengths and a pad longer than the corridor', () => {
      expect(() => generateCorridorTerrain({ startFlatLength: -1 })).toThrow(/start lengths/);
      expect(() => generateCorridorTerrain({ startBlendLength: -1 })).toThrow(/start lengths/);
      expect(() => generateCorridorTerrain({ startFlatLength: 100, startBlendLength: 100, length: 120 })).toThrow(/cannot exceed length/);
    });

    test('rejects config that rounds to fewer than one cell per axis', () => {
      // width 0.3 with cellSize 1 -> rows = round(0.3) = 0.
      expect(() => generateCorridorTerrain({ width: 0.3, cellSize: 1 })).toThrow(/fewer than one cell/);
    });

    test('bad noise octaves propagate to a throw (closes the NaN terrain path)', () => {
      expect(() => generateCorridorTerrain({ macroOctaves: 0 })).toThrow(/octaves/);
      expect(() => generateCorridorTerrain({ microOctaves: -2 })).toThrow(/octaves/);
      expect(() => generateCorridorTerrain({ zoneOctaves: 0 })).toThrow(/octaves/);
    });

    test('rejects non-positive or non-finite frequency knobs (bypass fbm2D guard)', () => {
      // zoneFrequency/macro/micro are multiplied into the coords before fbm2D,
      // so its own frequency guard never fires — these must fail loud here or
      // they silently poison the field (zone quantile degenerates to index order).
      expect(() => generateCorridorTerrain({ zoneFrequency: 0 })).toThrow(/zoneFrequency/);
      expect(() => generateCorridorTerrain({ zoneFrequency: NaN })).toThrow(/zoneFrequency/);
      expect(() => generateCorridorTerrain({ zoneFrequency: Infinity })).toThrow(/zoneFrequency/);
      expect(() => generateCorridorTerrain({ macroFrequency: 0 })).toThrow(/macroFrequency/);
      expect(() => generateCorridorTerrain({ microFrequency: -1 })).toThrow(/microFrequency/);
    });

    test('rejects negative or non-finite densities', () => {
      expect(() => generateCorridorTerrain({ craterDensity: -1 })).toThrow(/craterDensity/);
      expect(() => generateCorridorTerrain({ craterDensity: Infinity })).toThrow(/craterDensity/);
      expect(() => generateCorridorTerrain({ featureDensity: -1 })).toThrow(/featureDensity/);
    });

    test('rejects malformed [min, max] range keys (inverted, zero/negative min, wrong shape)', () => {
      expect(() => generateCorridorTerrain({ craterRadiusRange: [5, 2] })).toThrow(/craterRadiusRange/);
      expect(() => generateCorridorTerrain({ craterRadiusRange: [0, 3] })).toThrow(/craterRadiusRange/);
      expect(() => generateCorridorTerrain({ craterDepthRatioRange: [-0.1, 0.2] })).toThrow(/craterDepthRatioRange/);
      expect(() => generateCorridorTerrain({ craterDepthRatioRange: [0.3, 0.1] })).toThrow(/craterDepthRatioRange/);
      expect(() => generateCorridorTerrain({ boulderRadiusRange: [2, 1] })).toThrow(/boulderRadiusRange/);
      expect(() => generateCorridorTerrain({ logLengthRange: 5 })).toThrow(/logLengthRange/);
    });

    test('rejects coverages outside [0, 1] or summing past 1', () => {
      expect(() => generateCorridorTerrain({ sandCoverage: -0.1 })).toThrow(/coverage/i);
      expect(() => generateCorridorTerrain({ sandCoverage: 1.5 })).toThrow(/coverage/i);
      expect(() => generateCorridorTerrain({ mudCoverage: 2 })).toThrow(/coverage/i);
      expect(() => generateCorridorTerrain({ sandCoverage: 0.7, mudCoverage: 0.5 })).toThrow(/coverage/i);
    });

    test('rejects bad featureTypeWeights: unknown type, negative weight, all-zero with features requested', () => {
      // Unknown key must throw — { asteroid: 1 } has positive total but would
      // produce no known feature type.
      expect(() => generateCorridorTerrain({ featureTypeWeights: { asteroid: 1 } })).toThrow(/featureTypeWeights/);
      expect(() => generateCorridorTerrain({ featureTypeWeights: { boulder: -1, ramp: 1 } })).toThrow(/featureTypeWeights/);
      expect(() => generateCorridorTerrain({ featureTypeWeights: { boulder: 0 } })).toThrow(/featureTypeWeights/);
      // ...but an all-zero weight table is fine when no features are requested.
      expect(() => generateCorridorTerrain({ featureTypeWeights: { boulder: 0 }, featureDensity: 0 })).not.toThrow();
    });

    test('default config is accepted', () => {
      expect(() => generateCorridorTerrain({ seed: 1 })).not.toThrow();
    });
  });
});
