// FNV-1a 32 — the house lock hash, extracted for streaming use.
//
// The constants and fold order below are pinned by the repo's existing locked
// fingerprints (tests/prng.test.js '270d814f', tests/noise.test.js '52f40f90',
// tests/terrain.test.js, tests/features.test.js, tests/assembly.test.js) and
// must NEVER change; tests/fnv1a.test.js proves this helper reproduces two of
// those constants byte-for-byte. The state is a single uint32, so folding
// chunk-by-chunk is exactly the one-shot fold resumed — that identity is what
// makes O(1) streaming checkpoints possible (a checkpoint IS the state).
//
// Callers own their serialization (Uint8Array in, exactly like the test-local
// loops this extracts); plain arrays and strings are rejected loud rather than
// silently iterated.

export const FNV_OFFSET_BASIS = 0x811c9dc5;
export const FNV_PRIME = 0x01000193; // applied via Math.imul (D7-legal)

function fail(what, value) {
  throw new Error(`fnv1a: invalid ${what} (${String(value)})`);
}

/**
 * Fold bytes into a running FNV-1a 32 state. Returns the new uint32 state.
 * Chained folds over chunks equal one fold over the concatenation.
 */
export function fnv1aFold(state, bytes) {
  if (!Number.isInteger(state) || state < 0 || state > 0xffffffff) fail('state', state);
  if (!(bytes instanceof Uint8Array)) fail('bytes (Uint8Array required)', bytes);
  let h = state;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Canonical 8-char lowercase hex of a uint32 FNV state. */
export function fnv1aHexOf(state) {
  if (!Number.isInteger(state) || state < 0 || state > 0xffffffff) fail('state', state);
  return (state >>> 0).toString(16).padStart(8, '0');
}

/** One-shot convenience: hex digest of a single byte buffer. */
export function fnv1aHex(bytes) {
  return fnv1aHexOf(fnv1aFold(FNV_OFFSET_BASIS, bytes));
}
