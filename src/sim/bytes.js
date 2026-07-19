// src/sim/bytes.js — shared strict byte READING + the JSON-safe byte
// representation for the canonical codec family (pure; no Rapier, no clock).
//
// WHY this exists. Every canonical encoder in this repo (serializeGenotype,
// serializePopulationSnapshot, serializePopulationInitialization,
// serializeEvaluationSpec, serializeFitnessVector) writes an explicit
// little-endian walk into an exact-size DataView. Their inverses need the
// mirror-image read discipline, and getting truncation / trailing-byte
// handling subtly different per module is exactly how a "lossless" codec
// silently stops being lossless. One reader, four of the five decoders.
//
// THE ONE EXEMPTION, stated here so nobody has to discover it: assembly.js's
// deserializeGenotype reads its own DataView. Not an oversight and not a
// zero-imports nicety — that format alone is FIXED-LAYOUT with an
// out-of-order length identity. It must read the version at byte 0, the
// segment count at 42, and the axle count at 267 BEFORE walking anything, so
// that `byteLength === genotypeByteLength(axleCount)` can reject truncation
// and trailing bytes in a single check up front. A sequential cursor cannot
// peek byte 267 without consuming the 265 before it, which would turn one
// clean length identity into a truncation reported from deep inside a gene.
// Every other format is a sequential walk and uses this reader. A new decoder
// belongs here unless it has the same fixed-layout reason.
//
// THE READER CONTRACT
//   - Every read is little-endian and bounds-checked BEFORE it happens; a
//     short buffer fails loud rather than returning an undefined-ish value.
//   - The cursor lives in a closure. `offset` / `remaining` are GETTERS on a
//     frozen object (a frozen object cannot expose a mutable data property,
//     and the read methods advance the cursor).
//   - The DataView folds in `bytes.byteOffset`, so a subarray view of a larger
//     buffer reads its own window — the trace.js decodeTraceRecord precedent.
//   - Errors are raised through the CALLING module's `fail(path, value)`
//     callback, so a snapshot failure reads `population: ...` and a spec
//     failure reads `population-evaluation: ...`. The reader never invents its
//     own error vocabulary; a decoder's diagnostics stay in one dialect.
//   - `expectEnd` is how a decoder rejects trailing bytes. No encoder here
//     emits padding or framing, so "consumed exactly to the end" is part of
//     every format's identity, not a nicety.
//
// BINARY IDENTITY vs JSON ENVELOPE. The canonical bytes ARE the identity: FNV
// digests are folded over them and never over JSON. When a byte stream has to
// travel through a JSON artifact, it travels as `bytesToHex` output — a
// lossless, deterministic, canonical-LOWERCASE representation — inside an
// envelope that also carries a `boxcar3d.<name>/<v>` schema tag (the existing
// probe-report convention). JSON is the envelope; it is never the identity,
// and no digest is ever computed over it. Base64 is deliberately not used:
// nothing in this repo speaks it, and hex diffs readably against the
// hand-built byte literals the tests assert.
//
// Deliberate duplication, recorded: `hexBytes` (trace.js) and `bytesToHex`
// (scripts/characterize-population.js) implement the same byte->hex idiom.
// They stay where they are — one lives inside a byte-locked module and the
// other in a script outside the sim ESLint ban, and migrating either widens
// this PR's blast radius into locked territory for zero behavioural gain.

/**
 * A strict little-endian cursor over `bytes`. `fail(path, value)` is the
 * calling module's fail-loud helper; every rejection routes through it.
 */
export function createByteReader(bytes, fail) {
  if (typeof fail !== 'function') {
    throw new Error(`bytes: invalid fail callback (${String(fail)})`);
  }
  if (!(bytes instanceof Uint8Array)) fail('bytes', bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;

  const need = (n, path) => {
    if (o + n > bytes.byteLength) {
      fail(path, `truncated at byte ${o} (need ${n}, have ${bytes.byteLength - o})`);
    }
  };
  const u8 = (path) => { need(1, path); const v = view.getUint8(o); o += 1; return v; };
  const u16 = (path) => { need(2, path); const v = view.getUint16(o, true); o += 2; return v; };
  const u32 = (path) => { need(4, path); const v = view.getUint32(o, true); o += 4; return v; };
  const f64 = (path) => { need(8, path); const v = view.getFloat64(o, true); o += 8; return v; };

  return Object.freeze({
    get offset() { return o; },
    get remaining() { return bytes.byteLength - o; },
    u8,
    u16,
    u32,
    f64,
    /** An f64 that must be finite (the encoders' write-side gate, mirrored). */
    finiteF64: (path) => {
      const v = f64(path);
      if (!Number.isFinite(v)) fail(path, v);
      return v;
    },
    /** A boolean byte: exactly 0 or 1 (the trace decodeFlag discipline). */
    flag: (path) => {
      const v = u8(path);
      if (v !== 0 && v !== 1) fail(path, v);
      return v === 1;
    },
    /** A sub-view of n bytes (no copy; the caller must not retain it mutably). */
    bytes: (n, path) => {
      if (!Number.isInteger(n) || n < 0) fail(path, n);
      need(n, path);
      const v = bytes.subarray(o, o + n);
      o += n;
      return v;
    },
    /** Reject trailing bytes — every format here is exactly its content. */
    expectEnd: (path) => {
      if (o !== bytes.byteLength) {
        fail(path, `${bytes.byteLength - o} trailing byte(s) at offset ${o}`);
      }
    },
  });
}

// Canonical LOWERCASE hex pairs. One declared pattern rejects all three
// malformed classes at once: an odd length, uppercase (canonical casing is
// lowercase BY RULING — never silently normalized), and any non-hex character.
const HEX_PAIRS = /^(?:[0-9a-f]{2})*$/;

function hexFail(what, value) {
  throw new Error(`bytes: invalid ${what} (${String(value)})`);
}

/** Bytes -> the canonical lowercase-hex JSON-safe representation. */
export function bytesToHex(bytes) {
  if (!(bytes instanceof Uint8Array)) hexFail('bytes (Uint8Array required)', bytes);
  // Indexed, like every other length-driven read in the codec family. A
  // TypedArray's iterator is not user-overridable per instance the way a plain
  // Array's is, so this is consistency rather than a fix — but a reader who
  // finds an Array.from here has to work that out, and the file's own ruling
  // says indices are the truth.
  const out = [];
  for (let i = 0; i < bytes.length; i += 1) out.push(bytes[i].toString(16).padStart(2, '0'));
  return out.join('');
}

/** The exact inverse of bytesToHex. Malformed text fails loud, never repairs. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string') hexFail('hex (string required)', hex);
  if (!HEX_PAIRS.test(hex)) hexFail('hex (canonical lowercase byte pairs required)', hex);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
