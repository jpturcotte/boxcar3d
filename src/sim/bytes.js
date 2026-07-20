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
//     failure reads `population-evaluation: ...`. The caller's dialect is what
//     a decoder's diagnostics speak in every reachable case. The reader has
//     exactly ONE error string of its own, and it is unreachable for a
//     well-behaved caller: if `fail` RETURNS instead of throwing, `raise`
//     throws a `bytes: reader aborted at ...` backstop, because every path
//     below assumes a rejection stops the walk. Reaching that message means
//     the caller's fail idiom is broken, which is worth saying in this
//     module's own voice rather than corrupting the read.
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

// INTRINSIC TypedArray geometry reads, cached once at module load. `length`,
// `buffer`, `byteOffset` and `byteLength` are inherited ACCESSORS on
// %TypedArray%.prototype, so an own data property on a genuine Uint8Array
// shadows them with ordinary JavaScript — no Proxy involved. Measured: a
// 4-byte array with an own `length: 2` hex-encoded as 'dead' instead of
// 'deadbeef', and an own `byteOffset`/`byteLength`/`buffer` redirected the
// reader's DataView to bytes outside the array's own window while every
// bounds check passed. The byte-boundary functions in this family therefore
// read geometry through the module-owned prototype getters, which report the
// array's REAL window regardless of own properties (and throw a TypeError on
// any non-TypedArray, backing the instanceof check). This is the same ruling
// as "indices are the truth", one level down: the module reads what the
// runtime knows, not what the caller claims.
const TA_PROTO = Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array(0)));
const taGetter = (name) => Object.getOwnPropertyDescriptor(TA_PROTO, name).get;
const TA_LENGTH = taGetter('length');
const TA_BUFFER = taGetter('buffer');
const TA_BYTE_OFFSET = taGetter('byteOffset');
const TA_BYTE_LENGTH = taGetter('byteLength');

// NO TA_SUBARRAY, and the omission is the ruling. An earlier round replaced
// `bytes.subarray(...)` with `TA_SUBARRAY.call(bytes, ...)` on the theory that
// a module-owned intrinsic cannot run caller code. That is true of the four
// GETTERS above (they are side-effect-free by spec) and FALSE of subarray:
// %TypedArray%.prototype.subarray performs TypedArraySpeciesCreate, which
// reads `bytes.constructor`, then `constructor[Symbol.species]`, and CONSTRUCTS
// whatever it finds — so the returned "sub-view" is whatever caller code chose
// to return. `constructor` is inherited, so a plain Object.defineProperty on a
// GENUINE Uint8Array reaches it: no Proxy, no lying prototype. Measured on the
// snapshot decoder — a 1052-byte stream containing genotype A decoded to
// genotype B and re-encoded to 796 different bytes, i.e.
// serialize(deserialize(x)) !== x, with every bounds check and expectEnd still
// passing (they track the cursor, not the returned view). The replacement below
// constructs the view from the module's OWN %Uint8Array% constructor over the
// intrinsic buffer/offset, which consults nothing on the caller.
//
// THE GENERAL RULE, since "use the intrinsic" is now proven insufficient: a
// %TypedArray%.prototype METHOD may be species-aware or otherwise observable;
// only the geometry ACCESSORS are safe to borrow. Reach for a constructor, not
// a method.

// STORAGE-LIFETIME intake (JP's ruling, break-it sweep I7). The intrinsic
// getters above defeat a caller that LIES about geometry, but not a genuine
// Uint8Array whose BACKING STORE is transient or foreign — an axis the round-8
// property boundary never named. A detached buffer reads as empty (bytesToHex
// → "", fnv1aFold leaves its state unchanged, the reader's DataView throws a
// foreign TypeError); a SharedArrayBuffer can be scrambled by another thread
// mid-fold, digesting a state that never existed; a resizable buffer can shrink
// under a live reader. The ruling: canonical bytes must be ORDINARY — a genuine
// same-realm Uint8Array over a fixed-size, non-shared, non-detached
// ArrayBuffer. Anything fancy is rejected loud at the door, in the caller's
// dialect, never silently absorbed. Backing-store getters cached like the
// geometry ones (an own data property on a genuine ArrayBuffer could shadow
// `.detached`/`.resizable` too).
const abGetter = (name) => Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, name)?.get ?? null;
const AB_DETACHED = abGetter('detached');
const AB_RESIZABLE = abGetter('resizable');
const SAB = typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : null;

/**
 * Reject any byte input that is not an ordinary same-realm Uint8Array over a
 * fixed-size, non-shared, non-detached ArrayBuffer. Returns `bytes` on success.
 * `fail(path, value)` is the calling module's fail-loud helper. Called at every
 * public seam where caller bytes ENTER the codec (the reader, the hex encoder,
 * the fixed-layout decoders).
 */
export function requireOrdinaryBytes(bytes, fail) {
  if (typeof fail !== 'function') throw new Error(`bytes: invalid fail callback (${String(fail)})`);
  // Genuine same-realm Uint8Array: a cross-realm view (iframe/worker/vm) is
  // "fancy" and rejected. `instanceof` is same-realm by construction here.
  if (!(bytes instanceof Uint8Array)) fail('bytes', 'not an ordinary same-realm Uint8Array');
  const buffer = TA_BUFFER.call(bytes); // intrinsic, never the shadowable `.buffer`
  // Shared first: the ArrayBuffer.prototype getters below throw on a SAB.
  if (SAB !== null && buffer instanceof SAB) {
    fail('bytes', 'SharedArrayBuffer-backed — concurrent mutation is not supported; pass ordinary bytes');
  }
  if (AB_RESIZABLE !== null && AB_RESIZABLE.call(buffer) === true) {
    fail('bytes', 'resizable ArrayBuffer — canonical bytes must be fixed-size');
  }
  if (AB_DETACHED !== null && AB_DETACHED.call(buffer) === true) {
    fail('bytes', 'detached ArrayBuffer — the backing store was transferred away');
  }
  return bytes;
}

/**
 * A strict little-endian cursor over `bytes`. `fail(path, value)` is the
 * calling module's fail-loud helper; every rejection routes through it.
 */
export function createByteReader(bytes, fail) {
  if (typeof fail !== 'function') {
    throw new Error(`bytes: invalid fail callback (${String(fail)})`);
  }
  // The caller's fail idiom gets first say, but the reader ABORTS regardless:
  // every path below assumes a rejection stops the walk, and a fail callback
  // that returns (a log-and-continue handler) let the cursor resume — a
  // negative count REWOUND it, flag() returned a coerced boolean, expectEnd
  // accepted trailing bytes. Measured. The backstop makes the assumption a
  // guarantee instead of a convention.
  const raise = (path, value) => {
    fail(path, value);
    throw new Error(`bytes: reader aborted at ${path} (${String(value)}) — the fail callback returned`);
  };
  requireOrdinaryBytes(bytes, raise); // ordinary, same-realm, fixed, non-detached
  // Geometry via the intrinsic getters (see the module-load block above);
  // captured ONCE so every later check agrees with the DataView's window.
  const byteLength = TA_BYTE_LENGTH.call(bytes);
  const view = new DataView(TA_BUFFER.call(bytes), TA_BYTE_OFFSET.call(bytes), byteLength);
  let o = 0;

  const need = (n, path) => {
    if (o + n > byteLength) {
      raise(path, `truncated at byte ${o} (need ${n}, have ${byteLength - o})`);
    }
  };
  const u8 = (path) => { need(1, path); const v = view.getUint8(o); o += 1; return v; };
  const u16 = (path) => { need(2, path); const v = view.getUint16(o, true); o += 2; return v; };
  const u32 = (path) => { need(4, path); const v = view.getUint32(o, true); o += 4; return v; };
  const f64 = (path) => { need(8, path); const v = view.getFloat64(o, true); o += 8; return v; };

  return Object.freeze({
    get offset() { return o; },
    get remaining() { return byteLength - o; },
    // The INTRINSIC length, captured once above. Exposed because a decoder
    // with a fixed record stride wants an exact total-length identity, and the
    // only other way to get one is `bytes.byteLength` — the caller-shadowable
    // accessor this reader exists to stop reading. deserializeFitnessVector
    // did exactly that and falsely REJECTED byte-identical valid streams.
    get byteLength() { return byteLength; },
    u8,
    u16,
    u32,
    f64,
    /** An f64 that must be finite (the encoders' write-side gate, mirrored). */
    finiteF64: (path) => {
      const v = f64(path);
      if (!Number.isFinite(v)) raise(path, v);
      return v;
    },
    /** A boolean byte: exactly 0 or 1 (the trace decodeFlag discipline). */
    flag: (path) => {
      const v = u8(path);
      if (v !== 0 && v !== 1) raise(path, v);
      return v === 1;
    },
    /**
     * A sub-view of n bytes (no copy; the caller must not retain it mutably).
     * Built with the module's own %Uint8Array% over the intrinsic
     * buffer/offset — never `subarray`, which is species-aware (see the
     * module-load block). The returned view is therefore a genuine Uint8Array
     * over the real window no matter what the caller's array claims.
     */
    bytes: (n, path) => {
      if (!Number.isInteger(n) || n < 0) raise(path, n);
      need(n, path);
      const v = new Uint8Array(TA_BUFFER.call(bytes), TA_BYTE_OFFSET.call(bytes) + o, n);
      o += n;
      return v;
    },
    /** Reject trailing bytes — every format here is exactly its content. */
    expectEnd: (path) => {
      if (o !== byteLength) {
        raise(path, `${byteLength - o} trailing byte(s) at offset ${o}`);
      }
    },
  });
}

// Canonical LOWERCASE hex pairs. One declared pattern rejects all three
// malformed classes at once: an odd length, uppercase (canonical casing is
// lowercase BY RULING — never silently normalized), and any non-hex character.
const HEX_PAIRS = /^(?:[0-9a-f]{2})*$/;

function bytesFail(what, value) {
  throw new Error(`bytes: invalid ${what} (${String(value)})`);
}

/**
 * The INTRINSIC byte length of a Uint8Array — the geometry the runtime holds,
 * not the `length`/`byteLength` accessors a caller can shadow with an own data
 * property. Exported because two modules outside this one compare or fold raw
 * byte buffers and must not read the caller's claim: population.js's
 * `bytesEqual` reported deadbeef equal to dead0000 under an own `length: 2`,
 * and any digest folded over a shadowed buffer attests a PREFIX. Callers that
 * already hold module-owned bytes do not need this; callers that accept bytes
 * from outside do.
 */
export function typedArrayByteLength(bytes) {
  if (!(bytes instanceof Uint8Array)) bytesFail('bytes (Uint8Array required)', bytes);
  return TA_BYTE_LENGTH.call(bytes);
}

/** Bytes -> the canonical lowercase-hex JSON-safe representation. */
export function bytesToHex(bytes) {
  // Ordinary storage only (I7): a detached buffer used to hex-encode as "" — a
  // formerly-nonempty identity silently blanked.
  requireOrdinaryBytes(bytes, bytesFail);
  // Indexed reads with the length from the INTRINSIC getter. `length` is an
  // inherited accessor, so an own data property on a genuine Uint8Array
  // shadows it: measured, a 4-byte array claiming `length: 2` hex-encoded as
  // 'dead' where its content is deadbeef — the canonical JSON-safe identity
  // silently truncated. The intrinsic reports the real window regardless.
  const length = TA_LENGTH.call(bytes);
  const out = [];
  for (let i = 0; i < length; i += 1) out.push(bytes[i].toString(16).padStart(2, '0'));
  return out.join('');
}

/** The exact inverse of bytesToHex. Malformed text fails loud, never repairs. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string') bytesFail('hex (string required)', hex);
  if (!HEX_PAIRS.test(hex)) bytesFail('hex (canonical lowercase byte pairs required)', hex);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
