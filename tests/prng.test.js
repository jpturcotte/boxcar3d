import { describe, test, expect } from 'vitest';
import { Rng } from '../src/sim/prng.js';

// FNV-1a over the little-endian bytes of a uint32 array.
const fnv1a = (arr) => {
  let h = 0x811c9dc5;
  for (const v of arr) {
    for (let s = 0; s < 32; s += 8) {
      h ^= (v >>> s) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

describe('Rng (ruling D7: cross-platform shareable seeds)', () => {
  test('locked sequence: seed 1234567 produces the recorded stream, forever', () => {
    const r = new Rng(1234567);
    const seq = Array.from({ length: 256 }, () => r.nextUint32());
    expect(seq.slice(0, 3)).toEqual([1858167840, 2613321793, 3958110856]);
    // If this hash ever changes, seed-sharing and replays are broken.
    // Do not update the constant without bumping the gene-schema/seed version.
    expect(fnv1a(seq)).toBe('270d814f');
  });

  test('same seed, same sequence; different seed, different sequence', () => {
    const a = Array.from({ length: 64 }, ((r) => () => r.nextUint32())(new Rng(7)));
    const b = Array.from({ length: 64 }, ((r) => () => r.nextUint32())(new Rng(7)));
    const c = Array.from({ length: 64 }, ((r) => () => r.nextUint32())(new Rng(8)));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('fork is order-independent (shard invariance)', () => {
    const consumed = new Rng(99);
    consumed.nextUint32();
    consumed.nextUint32();
    const fresh = new Rng(99);
    // Vehicle #7's stream must not depend on how much the parent was used
    // or which worker asks for it.
    const s1 = Array.from({ length: 16 }, ((r) => () => r.nextUint32())(consumed.fork(7)));
    const s2 = Array.from({ length: 16 }, ((r) => () => r.nextUint32())(fresh.fork(7)));
    expect(s1).toEqual(s2);
    // Distinct streams for distinct ids.
    expect(fresh.fork(8).nextUint32()).not.toBe(fresh.fork(7).nextUint32());
  });

  test('nextFloat stays in [0, 1); range and int respect bounds', () => {
    const r = new Rng(2026);
    for (let i = 0; i < 1000; i++) {
      const f = r.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = r.int(3, 9);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThan(9);
      const g = r.range(-2.5, 2.5);
      expect(g).toBeGreaterThanOrEqual(-2.5);
      expect(g).toBeLessThan(2.5);
    }
  });
});
