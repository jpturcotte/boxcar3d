import { describe, test, expect } from 'vitest';
import { FNV_OFFSET_BASIS, FNV_PRIME, fnv1aFold, fnv1aHexOf, fnv1aHex } from '../src/sim/fnv1a.js';
import { Rng } from '../src/sim/prng.js';
import { fbm2D } from '../src/sim/noise.js';

// The extracted house hash must be byte-identical to the five test-local FNV
// loops guarding the repo's locked fingerprints. Rather than migrating those
// files (their locks stay untouched — blast radius), F4/F5 below REPRODUCE two
// of their locked constants through this helper: any divergence in constants,
// fold order, or serialization convention fails here, not in a lock file.

describe('fnv1a (the house lock hash, extracted)', () => {
  test('F1: empty stream is the offset basis', () => {
    expect(fnv1aHex(new Uint8Array(0))).toBe('811c9dc5');
    expect(fnv1aHexOf(FNV_OFFSET_BASIS)).toBe('811c9dc5');
    expect(FNV_OFFSET_BASIS).toBe(0x811c9dc5);
    expect(FNV_PRIME).toBe(0x01000193);
  });

  test('F2: published FNV-1a 32 vectors', () => {
    expect(fnv1aHex(new Uint8Array([0x61]))).toBe('e40c292c'); // 'a'
    expect(fnv1aHex(new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]))).toBe('bf9cf968'); // 'foobar'
  });

  test('F3: incremental folding equals one-shot at every split point (seed 20260711, 257 bytes)', () => {
    const rng = new Rng(20260711);
    const bytes = new Uint8Array(257);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = rng.int(0, 256);
    const oneShot = fnv1aHex(bytes);
    for (let split = 0; split <= bytes.length; split += 1) {
      const state = fnv1aFold(FNV_OFFSET_BASIS, bytes.subarray(0, split));
      expect(fnv1aHexOf(fnv1aFold(state, bytes.subarray(split)))).toBe(oneShot);
    }
    // Three-way chunking and resume across separate call chains — the
    // checkpoint-resume property the streaming writer depends on.
    const s1 = fnv1aFold(FNV_OFFSET_BASIS, bytes.subarray(0, 100));
    const s2 = fnv1aFold(s1, bytes.subarray(100, 200));
    expect(fnv1aHexOf(fnv1aFold(s2, bytes.subarray(200)))).toBe(oneShot);
  });

  test('F4: reproduces the locked PRNG stream fingerprint (tests/prng.test.js, 270d814f)', () => {
    const r = new Rng(1234567);
    const seq = Array.from({ length: 256 }, () => r.nextUint32());
    const view = new DataView(new ArrayBuffer(seq.length * 4));
    seq.forEach((v, i) => view.setUint32(i * 4, v, true));
    expect(fnv1aHex(new Uint8Array(view.buffer))).toBe('270d814f');
  });

  test('F5: reproduces the locked noise field fingerprint (tests/noise.test.js, 52f40f90)', () => {
    const samples = [];
    for (let gx = -3; gx <= 3; gx += 1) {
      for (let gy = -2; gy <= 2; gy += 1) {
        samples.push(fbm2D(gx * 0.37 - 0.11, gy * 0.29 + 0.05, 1234567, { octaves: 4 }));
      }
    }
    const view = new DataView(new ArrayBuffer(samples.length * 8));
    samples.forEach((v, i) => view.setFloat64(i * 8, v, true));
    expect(fnv1aHex(new Uint8Array(view.buffer))).toBe('52f40f90');
  });

  test('F6: fail-loud on non-Uint8Array bytes and non-uint32 state', () => {
    const u8 = new Uint8Array([1, 2, 3]);
    expect(() => fnv1aFold(FNV_OFFSET_BASIS, [1, 2, 3])).toThrow(/fnv1a: invalid bytes/);
    expect(() => fnv1aFold(FNV_OFFSET_BASIS, 'abc')).toThrow(/fnv1a: invalid bytes/);
    expect(() => fnv1aFold(1.5, u8)).toThrow(/fnv1a: invalid state/);
    expect(() => fnv1aFold(-1, u8)).toThrow(/fnv1a: invalid state/);
    expect(() => fnv1aFold(2 ** 32, u8)).toThrow(/fnv1a: invalid state/);
    expect(() => fnv1aHexOf(-1)).toThrow(/fnv1a: invalid state/);
  });
});

describe('storage-lifetime intake (round 13) — the fold rejects fancy backing stores', () => {
  const detached = () => {
    const u = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    u.buffer.transfer();
    return u;
  };

  test('a detached buffer is rejected in this dialect, never folded as zero bytes', () => {
    // Measured pre-gate: the fold returned its input state UNCHANGED for a
    // detached buffer — a digest attesting zero bytes it was never handed,
    // the exact failure the module header names. The rejection must be this
    // module's dialect, not a foreign join/TypeError from stringifying the
    // detached array.
    expect(() => fnv1aFold(FNV_OFFSET_BASIS, detached())).toThrow(/fnv1a: invalid bytes \(detached ArrayBuffer/);
    expect(() => fnv1aHex(detached())).toThrow(/detached ArrayBuffer/); // transitively gated
  });

  test('a SharedArrayBuffer-backed view is rejected (mid-fold mutation)', () => {
    expect(() => fnv1aFold(FNV_OFFSET_BASIS, new Uint8Array(new SharedArrayBuffer(4))))
      .toThrow(/fnv1a: invalid bytes \(SharedArrayBuffer-backed/);
  });

  test('a resizable ArrayBuffer is rejected (can shrink under the loop)', () => {
    expect(() => fnv1aFold(FNV_OFFSET_BASIS, new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 }))))
      .toThrow(/fnv1a: invalid bytes \(resizable ArrayBuffer/);
  });

  test('ordinary bytes still fold identically; empty CONTENT stays legal', () => {
    expect(fnv1aHex(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))).toBe('045d4bb3');
    // A genuinely empty array is a legal zero-byte fold (state in = state
    // out BY CONTENT); emptiness via detachment is what the gate rejects.
    expect(fnv1aFold(FNV_OFFSET_BASIS, new Uint8Array(0))).toBe(FNV_OFFSET_BASIS);
  });
});
