// Deterministic PRNG — the ONLY source of randomness in src/sim (ruling D7).
//
// xoshiro128** with a splitmix32 seeder. All operations are 32-bit integer
// ops (Math.imul, shifts, xors) plus division by a power of two, all of which
// are bit-exact across JS engines and platforms — unlike Math.random or the
// library transcendentals, which are implementation-defined.
//
// Shard invariance: fork(streamId) derives a child stream from the rng's
// ORIGINAL seed and the streamId only. It does not read or advance the parent
// state, so vehicle #7 gets the same stream no matter which worker simulates
// it, in what order, or how much the parent was used in between.

export function splitmix32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };
}

function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    const sm = splitmix32(this.seed);
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s3 = 1; // never all-zero
  }

  /** Next value in [0, 2^32). */
  nextUint32() {
    const r = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return r;
  }

  /** Float in [0, 1). Division by 2^32 is exact in binary — deterministic. */
  nextFloat() {
    return this.nextUint32() / 4294967296;
  }

  /** Float in [min, max). */
  range(min, max) {
    return min + this.nextFloat() * (max - min);
  }

  /** Integer in [min, maxExclusive). Modulo bias is negligible for game-sized ranges. */
  int(min, maxExclusive) {
    return min + (this.nextUint32() % (maxExclusive - min));
  }

  /** True with probability p. */
  bool(p = 0.5) {
    return this.nextFloat() < p;
  }

  /**
   * Deterministic, order-independent child stream (see header note).
   * Same (seed, streamId) always yields the same stream.
   */
  fork(streamId) {
    const mixed = (this.seed ^ Math.imul(streamId >>> 0, 0x9e3779b1)) >>> 0;
    const sm = splitmix32(mixed);
    sm(); // discard one output to decorrelate near-identical inputs
    return new Rng(sm());
  }
}
