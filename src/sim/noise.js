// Deterministic 2D value noise for terrain generation (ruling D7 / red-team F4).
//
// Built ONLY on integer hashing from src/sim/prng.js — no library trig. The
// legacy TerrainFactory built heights from Math.sin/cos, which are
// implementation-defined across JS engines and would break cross-platform seed
// sharing (ESLint bans them in src/sim). Every operation here is an integer
// avalanche + division by 2^32, or IEEE-754 +,-,* and Math.floor
// (round-to-nearest, no FMA in JS → bit-exact across V8/JSC/SpiderMonkey), so a
// seed reproduces the same field on any machine or browser.

import { splitmix32 } from './prng.js';

// Pure 2D integer hash -> float in [0, 1). Negative-safe: lattice coords are
// folded with Math.imul and >>>0 (the corridor's Z spans negatives), never a
// float modulo or sign trick. splitmix32 supplies the avalanche — the prng.js
// integer-hashing primitive this module is built on.
export function hashToUnit(ix, iy, seed) {
  let h = seed >>> 0;
  h = (h ^ Math.imul(ix | 0, 0x27d4eb2f)) >>> 0;
  h = (h ^ Math.imul(iy | 0, 0x85ebca6b)) >>> 0;
  return splitmix32(h)() / 4294967296; // one avalanche step, /2^32 -> [0, 1)
}

// Integer octave-seed derivation — order-independent (no shared running stream,
// rule 1). Distinct octave index -> distinct, decorrelated seed.
function octaveSeed(seed, octave) {
  return (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(octave + 1, 0x85ebca6b)) >>> 0;
}

// Quintic smootherstep 6t^5-15t^4+10t^3 (polynomial — no trig) and linear blend.
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

// Value noise: hash the 4 lattice corners of the cell containing (x, y),
// smootherstep the fractional coords, bilinear-blend. Output in [0, 1),
// continuous (C1). Math.floor toward -inf keeps xf/yf in [0, 1) for negative x.
export function valueNoise2D(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;
  const v00 = hashToUnit(x0, y0, seed);
  const v10 = hashToUnit(x0 + 1, y0, seed);
  const v01 = hashToUnit(x0, y0 + 1, seed);
  const v11 = hashToUnit(x0 + 1, y0 + 1, seed);
  const u = smootherstep(xf);
  const v = smootherstep(yf);
  return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
}

// Fractional Brownian motion: sum octaves of value noise, each drawing an
// INDEPENDENT integer seed (never a shared, order-dependent stream). The result
// is the amplitude-weighted average of [0,1) octaves, so it stays in [0, 1).
export function fbm2D(x, y, seed, { octaves = 4, lacunarity = 2, gain = 0.5, frequency = 1 } = {}) {
  let amp = 1;
  let freq = frequency;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2D(x * freq, y * freq, octaveSeed(seed, o));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
