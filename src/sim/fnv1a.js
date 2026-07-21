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
// The intrinsic length getter, cached at module load (the bytes.js idiom,
// duplicated locally to keep this module import-free — it is the lock hash).
// `length` is an inherited ACCESSOR on %TypedArray%.prototype, so an own data
// property on a GENUINE Uint8Array shadows it with ordinary defineProperty.
// The fold's loop bound used to read it: a 4-byte buffer claiming `length: 2`
// produced the digest of a PREFIX, silently — a digest that attests less than
// the bytes it was handed is the one failure this module must not have.
const TA_PROTO = Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array(0)));
const U8_LENGTH = Object.getOwnPropertyDescriptor(TA_PROTO, 'length').get;

// STORAGE-LIFETIME intake (JP's ruling; the round-13 closure). The intrinsic
// length above defeats a caller that LIES about geometry; it does NOT defeat a
// genuine Uint8Array whose BACKING STORE is transient or foreign. Measured at
// head: a DETACHED buffer read as empty, so the fold returned its input state
// UNCHANGED — a digest attesting zero bytes it was never handed, the exact
// failure the U8_LENGTH note calls "the one failure this module must not
// have", reachable through the storage axis the length fix never covered. A
// SharedArrayBuffer can be scrambled by another thread mid-fold (digesting a
// state that never existed); a resizable buffer can shrink under the loop.
// Checks duplicated inline from bytes.js requireOrdinaryBytes — this module
// stays import-free BY RULING (it is the lock hash), the deserializeGenotype
// precedent, recorded duplication.
const U8_BUFFER = Object.getOwnPropertyDescriptor(TA_PROTO, 'buffer').get;
const abGetter = (name) => Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, name)?.get ?? null;
const AB_DETACHED = abGetter('detached');
const AB_RESIZABLE = abGetter('resizable');
const SAB = typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : null;

export function fnv1aFold(state, bytes) {
  if (!Number.isInteger(state) || state < 0 || state > 0xffffffff) fail('state', state);
  if (!(bytes instanceof Uint8Array)) fail('bytes (Uint8Array required)', bytes);
  // Descriptions, never the bytes themselves: String(detached) re-reads the
  // detached buffer and dies as a FOREIGN join error instead of this dialect.
  const buffer = U8_BUFFER.call(bytes); // intrinsic, never the shadowable `.buffer`
  if (SAB !== null && buffer instanceof SAB) fail('bytes', 'SharedArrayBuffer-backed — concurrent mutation is not supported');
  if (AB_RESIZABLE !== null && AB_RESIZABLE.call(buffer) === true) fail('bytes', 'resizable ArrayBuffer — canonical bytes must be fixed-size');
  if (AB_DETACHED !== null && AB_DETACHED.call(buffer) === true) fail('bytes', 'detached ArrayBuffer — the backing store was transferred away');
  let h = state;
  const n = U8_LENGTH.call(bytes);
  for (let i = 0; i < n; i += 1) {
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
