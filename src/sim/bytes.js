// src/sim/bytes.js — shared byte helpers for the canonical codec family.
//
// WHY: every canonical format in src/sim (genotype, population snapshot,
// evaluation spec, fitness vector, initialization manifest) is an explicit
// little-endian walk produced by a hand-written encoder. The decoders that
// pair with those encoders all need the SAME strict reading discipline —
// bounds-checked cursor reads over one DataView, subarray-safe — so that
// discipline lives here ONCE instead of being re-derived (and drifting) per
// module.
//
// CANONICAL HEX: bytesToHex/hexToBytes define the JSON-safe lossless byte
// representation. JSON envelopes carry canonical LOWERCASE hex plus a
// `boxcar3d.<name>/<version>` schema tag — NEVER raw bytes (not JSON-safe),
// NEVER base64 (a second, separately-driftable representation), and NEVER
// digests-over-JSON (JSON serialization is not a canonical byte contract;
// digests bind the canonical byte streams only). Hex is lowercase by ruling:
// hexToBytes rejects uppercase so exactly one string denotes one byte string.
//
// FAIL-CALLBACK CONTRACT: this module has no error idiom of its own. The
// caller passes its own fail(path, value) — every malformed-bytes error
// therefore surfaces in the OWNING module's `...invalid encoded <thing> at
// ${path} (${String(value)})` idiom, so a corrupt snapshot blames
// population.js, not a shared helper. createByteReader itself only throws a
// bare TypeError when the callback contract itself is broken.
//
// DELIBERATE DUPLICATION: trace.js `hexBytes` and
// scripts/characterize-population.js `bytesToHex` implement the same
// lowercase-hex idiom and stay in place — migrating them widens this PR's
// blast radius for zero behavioral gain. New codec/JSON code uses THIS
// module's pair.

/**
 * Strict little-endian cursor reader over a Uint8Array. One DataView with
 * `bytes.byteOffset` folded in (subarray-safe — the trace.js precedent).
 * Every read is bounds-checked: a short buffer fails as
 * `fail(path, 'truncated at byte N (need n, have m)')`. The returned object
 * is frozen, so cursor state is exposed as GETTERS (a frozen object cannot
 * carry mutable data properties).
 *
 * Methods: u8/u16/u32/f64(path) raw reads; finiteF64(path) additionally
 * rejects NaN/±Infinity; flag(path) reads a strict 0/1 byte and returns a
 * boolean; bytes(n, path) takes a subarray of n bytes; expectEnd(path)
 * rejects trailing bytes with their count and offset.
 */
export function createByteReader(bytes, fail) {
  if (typeof fail !== 'function') {
    throw new TypeError("bytes: createByteReader requires the calling module's fail(path, value) callback");
  }
  if (!(bytes instanceof Uint8Array)) fail('bytes', bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n, path) => {
    if (n > bytes.byteLength - o) fail(path, `truncated at byte ${o} (need ${n}, have ${bytes.byteLength - o})`);
  };
  const u8 = (path) => { need(1, path); const v = view.getUint8(o); o += 1; return v; };
  const u16 = (path) => { need(2, path); const v = view.getUint16(o, true); o += 2; return v; };
  const u32 = (path) => { need(4, path); const v = view.getUint32(o, true); o += 4; return v; };
  const f64 = (path) => { need(8, path); const v = view.getFloat64(o, true); o += 8; return v; };
  const finiteF64 = (path) => {
    const v = f64(path);
    if (!Number.isFinite(v)) fail(path, v);
    return v;
  };
  const flag = (path) => {
    const v = u8(path);
    if (v !== 0 && v !== 1) fail(path, v);
    return v === 1;
  };
  const take = (n, path) => {
    if (!Number.isInteger(n) || n < 0) fail(path, n);
    need(n, path);
    const v = bytes.subarray(o, o + n);
    o += n;
    return v;
  };
  const expectEnd = (path) => {
    if (o !== bytes.byteLength) fail(path, `${bytes.byteLength - o} trailing byte(s) at byte ${o}`);
  };
  return Object.freeze({
    get offset() { return o; },
    get remaining() { return bytes.byteLength - o; },
    u8, u16, u32, f64, finiteF64, flag, bytes: take, expectEnd,
  });
}

/** Canonical lowercase hex of a byte buffer (the JSON-safe representation). */
export function bytesToHex(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`bytes: bytesToHex requires a Uint8Array (${String(bytes)})`);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Strict inverse of bytesToHex: one declared pattern rejects odd length,
 * uppercase, and non-hex characters in a single test — canonical lowercase
 * means exactly one string denotes one byte string.
 */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new TypeError(`bytes: invalid canonical hex (${String(hex)})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
