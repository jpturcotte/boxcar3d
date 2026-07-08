import { describe, test, expect } from 'vitest';
import { valueNoise2D, fbm2D } from '../src/sim/noise.js';

// Locked value-noise fingerprint — the terrain analogue of prng.test.js's locked
// stream. FNV-1a over an explicit LITTLE-ENDIAN serialization of a fixed sample
// grid (DataView.setFloat64 with littleEndian=true), so the constant is
// host-byte-order independent and captures the exact IEEE-754 doubles (stronger
// than decimal buckets). If this constant changes, the terrain field changed and
// seed-sharing / replays are broken — do NOT update it without bumping the
// seed-format version (same rule as the PRNG's locked hash).
function fingerprint(samples) {
  const view = new DataView(new ArrayBuffer(samples.length * 8));
  samples.forEach((v, i) => view.setFloat64(i * 8, v, true)); // littleEndian
  let h = 0x811c9dc5;
  for (let b = 0; b < view.byteLength; b++) {
    h ^= view.getUint8(b);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Fixed grid over negative + positive coords with non-integer steps, so the
// fingerprint exercises negative-lattice folding and off-lattice interpolation.
function sampleField(seed, fn) {
  const out = [];
  for (let gx = -3; gx <= 3; gx++) {
    for (let gy = -2; gy <= 2; gy++) {
      out.push(fn(gx * 0.37 - 0.11, gy * 0.29 + 0.05, seed));
    }
  }
  return out;
}

describe('value noise (deterministic, hash-based — ruling D7 / red-team F4)', () => {
  test('locked fingerprint: seed 1234567 reproduces the recorded field, forever', () => {
    const field = sampleField(1234567, (x, y, s) => fbm2D(x, y, s, { octaves: 4 }));
    expect(fingerprint(field)).toBe('52f40f90');
  });

  test('same seed -> identical field; different seed -> different field', () => {
    const a = sampleField(7, (x, y, s) => fbm2D(x, y, s));
    const b = sampleField(7, (x, y, s) => fbm2D(x, y, s));
    const c = sampleField(8, (x, y, s) => fbm2D(x, y, s));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('all samples stay in [0, 1) — valueNoise2D and fbm2D, incl. negatives', () => {
    for (let i = 0; i < 500; i++) {
      const x = i * 0.613 - 150;
      const y = i * -0.271 + 80;
      const vn = valueNoise2D(x, y, 42);
      const fb = fbm2D(x, y, 99, { octaves: 5 });
      expect(vn).toBeGreaterThanOrEqual(0);
      expect(vn).toBeLessThan(1);
      expect(fb).toBeGreaterThanOrEqual(0);
      expect(fb).toBeLessThan(1);
    }
  });
});
