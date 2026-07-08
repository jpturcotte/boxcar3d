import { describe, test, expect } from 'vitest';
import { generateCorridorTerrain, indexToLocalXZ, startEnvelope, craterDepthAt } from '../src/sim/terrain.js';

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

describe('corridor terrain generator (pure, deterministic)', () => {
  test('locked BASE-field fingerprint: seed 20260708 + craterDensity 0 reproduces e2157c82, forever (Step-1a guard)', () => {
    // Permanent regression guard for the Step-1a base field: with craters off,
    // the generator must be a byte-exact no-op over the 1a pipeline. The
    // constant survives from Step 1a — pinning craterDensity: 0 here is NOT a
    // re-lock. The default config (craters on) gets its own lock below.
    const t = generateCorridorTerrain({ seed: 20260708, craterDensity: 0 });
    expect(fingerprintHeights(t.heights)).toBe('e2157c82');
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
    });

    test('default config is accepted', () => {
      expect(() => generateCorridorTerrain({ seed: 1 })).not.toThrow();
    });
  });
});
