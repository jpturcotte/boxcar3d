// Deterministic evaluation trace — schema, fixed-width record codec.
//
// The trace is a per-step record of the exact engine-exposed state of every
// dynamic vehicle body, hashed with the house FNV-1a into streaming digests.
// It is a REGRESSION LOCK and a DIAGNOSTIC, not a semantic equivalence layer:
// floats are raw little-endian f64 bits (−0, denormals, ±Infinity, and both
// quaternion sign conventions preserved bit-for-bit; `Object.is`-level
// round-trip), with EXACTLY ONE deliberate normalization — NaN. The ES spec
// makes setFloat64's NaN byte pattern implementation-defined (SetValueInBuffer
// may choose any IEEE-754 NaN encoding) and wasm NaN payload bits are
// non-deterministic per the wasm spec, so raw NaN bits would break the
// cross-environment gate precisely in the blow-up case the terminated bit
// exists to record. NaN therefore encodes as the canonical quiet NaN
// 0x7FF8000000000000 via explicit setUint32 writes; the finiteState flag
// carries the semantics.
//
// EVALUATION_TRACE_VERSION is its own axis — NOT GENOTYPE_VERSION and NOT
// ASSEMBLY_IR_VERSION. A trace-version change means the ENCODED CONTRACT
// changed (layout, enums, ordering); it does not by itself mean physics
// changed, and a physics change does not require a trace-version bump (it
// shows up as a digest re-lock instead). There is no in-stream header:
// version and record size travel in the writer result / lock metadata, so the
// digest hashes physics content only and `byteCount = recordCount ×
// RECORD_BYTES` stays an exact identity.

import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHexOf } from './fnv1a.js';

export const EVALUATION_TRACE_VERSION = 1;
export const RECORD_BYTES = 128;

// Array index doubles as the wire code — APPEND-ONLY, never reorder (a
// reorder is a trace-version bump; the FRAME_FAMILIES / FEATURE_TYPES rule).
export const BODY_ROLES = Object.freeze(['chassis', 'hub', 'wheel']);
export const JOINT_STATES = Object.freeze(['invalid', 'valid', 'notApplicable']);
// Trimmed to what v1 implements — future reasons (stuck, goal, …) append.
export const TERMINATION_REASONS = Object.freeze(['none', 'nonFinite']);
export const TRACE_MODES = Object.freeze(['none', 'digest', 'full']);

// u32 index sentinel. Indices are u32 so the trace format imposes no
// structural axle/wheel ceiling below the sentinel — wheel count is unlimited
// by design (only the runtime maxAxles guard caps it; an uncapped
// experimental mode is anticipated).
export const NO_INDEX = 0xffffffff;
export const MAX_STEP_INDEX = 0xffffffff;
export const MAX_VEHICLE_INDEX = 0xffffffff;
export const MAX_AXLE_INDEX = 0xfffffffe; // 0xffffffff is the sentinel
export const MAX_WHEEL_INDEX = 0xfffffffe;

// The layout, as data — the single shared source for the codec tests and the
// comparison utilities' field attribution. Must tile [0, RECORD_BYTES)
// exactly (locked by tests/trace.test.js).
const field = (name, offset, bytes, type) => Object.freeze({ name, offset, bytes, type });
export const TRACE_FIELDS = Object.freeze([
  field('stepIndex', 0, 4, 'u32'),
  field('vehicleIndex', 4, 4, 'u32'),
  field('axleIndex', 8, 4, 'u32'),
  field('wheelIndex', 12, 4, 'u32'),
  field('bodyRole', 16, 1, 'u8'),
  field('bodyValid', 17, 1, 'u8'),
  field('bodySleeping', 18, 1, 'u8'),
  field('jointState', 19, 1, 'u8'),
  field('terminated', 20, 1, 'u8'),
  field('terminationReason', 21, 1, 'u8'),
  field('finiteState', 22, 1, 'u8'),
  field('reserved', 23, 1, 'u8'),
  field('translation.x', 24, 8, 'f64'),
  field('translation.y', 32, 8, 'f64'),
  field('translation.z', 40, 8, 'f64'),
  field('rotation.x', 48, 8, 'f64'),
  field('rotation.y', 56, 8, 'f64'),
  field('rotation.z', 64, 8, 'f64'),
  field('rotation.w', 72, 8, 'f64'),
  field('linvel.x', 80, 8, 'f64'),
  field('linvel.y', 88, 8, 'f64'),
  field('linvel.z', 96, 8, 'f64'),
  field('angvel.x', 104, 8, 'f64'),
  field('angvel.y', 112, 8, 'f64'),
  field('angvel.z', 120, 8, 'f64'),
]);

// --- Fail-loud validation ----------------------------------------------------

function fail(path, value) {
  throw new Error(`trace: invalid record at ${path} (${String(value)})`);
}

const RECORD_KEYS = Object.freeze([
  'stepIndex', 'vehicleIndex', 'bodyRole', 'axleIndex', 'wheelIndex',
  'bodyValid', 'bodySleeping', 'jointState', 'terminated', 'terminationReason',
  'finiteState', 'translation', 'rotation', 'linvel', 'angvel',
]);
const VECTOR_KEYS = Object.freeze({ translation: ['x', 'y', 'z'], rotation: ['x', 'y', 'z', 'w'], linvel: ['x', 'y', 'z'], angvel: ['x', 'y', 'z'] });

function checkUint(v, max, path) {
  if (!Number.isInteger(v) || v < 0 || v > max) fail(path, v);
}

function checkFlag(v, path) {
  // Exactly boolean — a 0/1 number here usually means a raw engine readback
  // landed in the wrong slot.
  if (typeof v !== 'boolean') fail(path, v);
}

function checkVector(rec, key) {
  const vec = rec[key];
  if (typeof vec !== 'object' || vec === null) fail(key, vec);
  const want = VECTOR_KEYS[key];
  for (const k of Object.keys(vec)) {
    if (!want.includes(k)) fail(`${key}.${k}`, 'unknown key');
  }
  for (const k of want) {
    // NaN / ±Infinity ACCEPTED — that is what finiteState records.
    if (typeof vec[k] !== 'number') fail(`${key}.${k}`, vec[k]);
  }
}

function validateRecord(rec) {
  if (typeof rec !== 'object' || rec === null) fail('record', rec);
  // Unknown keys rejected — the structural no-handles / no-timestamps tooth:
  // nothing engine-identity-shaped or wall-clock-shaped can enter the stream.
  for (const k of Object.keys(rec)) {
    if (!RECORD_KEYS.includes(k)) fail(k, 'unknown key');
  }
  checkUint(rec.stepIndex, MAX_STEP_INDEX, 'stepIndex');
  checkUint(rec.vehicleIndex, MAX_VEHICLE_INDEX, 'vehicleIndex');
  if (!BODY_ROLES.includes(rec.bodyRole)) fail('bodyRole', rec.bodyRole);
  if (rec.axleIndex !== null) checkUint(rec.axleIndex, MAX_AXLE_INDEX, 'axleIndex');
  if (rec.wheelIndex !== null) checkUint(rec.wheelIndex, MAX_WHEEL_INDEX, 'wheelIndex');
  if (!JOINT_STATES.includes(rec.jointState)) fail('jointState', rec.jointState);
  if (!TERMINATION_REASONS.includes(rec.terminationReason)) fail('terminationReason', rec.terminationReason);
  checkFlag(rec.bodyValid, 'bodyValid');
  checkFlag(rec.bodySleeping, 'bodySleeping');
  checkFlag(rec.terminated, 'terminated');
  checkFlag(rec.finiteState, 'finiteState');
  // Role-conditional shape: the chassis is the only station-less body, and
  // the only body whose joint slot may be empty (a zero-joint sled).
  if (rec.bodyRole === 'chassis') {
    if (rec.axleIndex !== null) fail('axleIndex', `${rec.axleIndex} (chassis carries no station)`);
    if (rec.wheelIndex !== null) fail('wheelIndex', `${rec.wheelIndex} (chassis carries no station)`);
  } else {
    if (rec.axleIndex === null) fail('axleIndex', 'null (station body requires an axle)');
    if (rec.wheelIndex === null) fail('wheelIndex', 'null (station body requires a wheel)');
    if (rec.jointState === 'notApplicable') {
      fail('jointState', 'notApplicable (every hub has its prismatic, every wheel its revolute)');
    }
  }
  // Termination coherence.
  if (rec.terminated === false && rec.terminationReason !== 'none') fail('terminationReason', rec.terminationReason);
  if (rec.terminated === true && rec.terminationReason === 'none') fail('terminationReason', 'none (terminated record needs a reason)');
  for (const key of Object.keys(VECTOR_KEYS)) checkVector(rec, key);
}

// --- Codec -------------------------------------------------------------------

function writeF64(view, offset, v) {
  if (Number.isNaN(v)) {
    // The sole normalization — canonical quiet NaN via explicit u32 writes
    // (setFloat64's NaN pattern is implementation-defined; see header).
    view.setUint32(offset, 0x00000000, true);
    view.setUint32(offset + 4, 0x7ff80000, true);
  } else {
    view.setFloat64(offset, v, true);
  }
}

/**
 * Encode one record into `out` (allocated if omitted). Validates the record
 * fully; `out` must be exactly RECORD_BYTES. Returns `out`.
 */
export function encodeTraceRecord(rec, out = new Uint8Array(RECORD_BYTES)) {
  validateRecord(rec);
  if (!(out instanceof Uint8Array) || out.byteLength !== RECORD_BYTES) fail('out', out);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, rec.stepIndex, true);
  view.setUint32(4, rec.vehicleIndex, true);
  view.setUint32(8, rec.axleIndex === null ? NO_INDEX : rec.axleIndex, true);
  view.setUint32(12, rec.wheelIndex === null ? NO_INDEX : rec.wheelIndex, true);
  view.setUint8(16, BODY_ROLES.indexOf(rec.bodyRole));
  view.setUint8(17, rec.bodyValid ? 1 : 0);
  view.setUint8(18, rec.bodySleeping ? 1 : 0);
  view.setUint8(19, JOINT_STATES.indexOf(rec.jointState));
  view.setUint8(20, rec.terminated ? 1 : 0);
  view.setUint8(21, TERMINATION_REASONS.indexOf(rec.terminationReason));
  view.setUint8(22, rec.finiteState ? 1 : 0);
  view.setUint8(23, 0);
  writeF64(view, 24, rec.translation.x);
  writeF64(view, 32, rec.translation.y);
  writeF64(view, 40, rec.translation.z);
  writeF64(view, 48, rec.rotation.x);
  writeF64(view, 56, rec.rotation.y);
  writeF64(view, 64, rec.rotation.z);
  writeF64(view, 72, rec.rotation.w);
  writeF64(view, 80, rec.linvel.x);
  writeF64(view, 88, rec.linvel.y);
  writeF64(view, 96, rec.linvel.z);
  writeF64(view, 104, rec.angvel.x);
  writeF64(view, 112, rec.angvel.y);
  writeF64(view, 120, rec.angvel.z);
  return out;
}

function decodeFail(path, value) {
  throw new Error(`trace: invalid encoded record at ${path} (${String(value)})`);
}

function decodeFlag(view, offset, path) {
  const b = view.getUint8(offset);
  if (b !== 0 && b !== 1) decodeFail(path, b);
  return b === 1;
}

/**
 * Decode RECORD_BYTES at `offset`. Strict: reserved must be 0, enum codes and
 * flag bytes in range, sentinel/role coherence enforced. Exact inverse of
 * encode up to f64 bit patterns (NaN decodes as the canonical quiet NaN).
 */
export function decodeTraceRecord(bytes, offset = 0) {
  if (!(bytes instanceof Uint8Array)) decodeFail('bytes', bytes);
  if (!Number.isInteger(offset) || offset < 0 || offset + RECORD_BYTES > bytes.byteLength) {
    decodeFail('offset', `${offset} (byteLength ${bytes.byteLength})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, RECORD_BYTES);
  const roleCode = view.getUint8(16);
  if (roleCode >= BODY_ROLES.length) decodeFail('bodyRole', roleCode);
  const jointCode = view.getUint8(19);
  if (jointCode >= JOINT_STATES.length) decodeFail('jointState', jointCode);
  const reasonCode = view.getUint8(21);
  if (reasonCode >= TERMINATION_REASONS.length) decodeFail('terminationReason', reasonCode);
  if (view.getUint8(23) !== 0) decodeFail('reserved', view.getUint8(23));
  const axleRaw = view.getUint32(8, true);
  const wheelRaw = view.getUint32(12, true);
  const rec = {
    stepIndex: view.getUint32(0, true),
    vehicleIndex: view.getUint32(4, true),
    bodyRole: BODY_ROLES[roleCode],
    axleIndex: axleRaw === NO_INDEX ? null : axleRaw,
    wheelIndex: wheelRaw === NO_INDEX ? null : wheelRaw,
    bodyValid: decodeFlag(view, 17, 'bodyValid'),
    bodySleeping: decodeFlag(view, 18, 'bodySleeping'),
    jointState: JOINT_STATES[jointCode],
    terminated: decodeFlag(view, 20, 'terminated'),
    terminationReason: TERMINATION_REASONS[reasonCode],
    finiteState: decodeFlag(view, 22, 'finiteState'),
    translation: { x: view.getFloat64(24, true), y: view.getFloat64(32, true), z: view.getFloat64(40, true) },
    rotation: { x: view.getFloat64(48, true), y: view.getFloat64(56, true), z: view.getFloat64(64, true), w: view.getFloat64(72, true) },
    linvel: { x: view.getFloat64(80, true), y: view.getFloat64(88, true), z: view.getFloat64(96, true) },
    angvel: { x: view.getFloat64(104, true), y: view.getFloat64(112, true), z: view.getFloat64(120, true) },
  };
  // A decoded stream must satisfy the same coherence rules as encoder input.
  validateRecord(rec);
  return rec;
}

// --- Streaming writer ----------------------------------------------------------

function writerFail(what, value) {
  throw new Error(`trace: TraceWriter ${what} (${String(value)})`);
}

/**
 * Streaming trace writer. The runner passes plain record objects in canonical
 * semantic order (vehicles in input order; per vehicle chassis first, then
 * stations axle-then-wheel, hub before wheel) — the order is a WRITE-TIME
 * INVARIANT enforced here, not a compare-time observation.
 *
 * Modes: 'none' retains and computes nothing (a literal early return, so a
 * benchmark comparing none vs digest measures encoding, not validation);
 * 'digest' encodes each record into one reusable scratch buffer and folds it
 * immediately — no records retained; 'full' additionally retains a COPY of
 * every encoded record and produces the identical digest by the same fold.
 *
 * Checkpoints (digest/full): one per `checkpointInterval` ended steps —
 * `{ stepIndex, recordCount, byteCount, state }` where `state` is the raw
 * cumulative uint32 FNV state (hex is derived only for reports; a checkpoint
 * is O(1) because the state IS the running hash). `finish()` appends a
 * terminal checkpoint only when the last `endStep` did not already create
 * one, so interval 1 never duplicates the tail.
 */
export class TraceWriter {
  #mode;
  #interval;
  #state = FNV_OFFSET_BASIS;
  #recordCount = 0;
  #byteCount = 0;
  #checkpoints = [];
  #records = null;
  #scratch = null;
  #lastKey = null;
  #lastEndedStep = -1;
  #maxSeenStep = -1;
  #stepsEnded = 0;
  #finished = false;

  constructor({ mode = 'digest', checkpointInterval = 1 } = {}) {
    if (!TRACE_MODES.includes(mode)) writerFail('invalid mode', mode);
    if (!Number.isInteger(checkpointInterval) || checkpointInterval < 1) {
      writerFail('invalid checkpointInterval', checkpointInterval);
    }
    this.#mode = mode;
    this.#interval = checkpointInterval;
    if (mode !== 'none') this.#scratch = new Uint8Array(RECORD_BYTES);
    if (mode === 'full') this.#records = [];
  }

  record(rec) {
    if (this.#finished) writerFail('record() after finish()', this.#mode);
    if (this.#mode === 'none') return;
    encodeTraceRecord(rec, this.#scratch); // validates fully
    if (rec.stepIndex <= this.#lastEndedStep) {
      writerFail(`record for already-ended step ${rec.stepIndex}`, `lastEndedStep ${this.#lastEndedStep}`);
    }
    const key = [
      rec.stepIndex, rec.vehicleIndex,
      rec.axleIndex === null ? -1 : rec.axleIndex,
      rec.wheelIndex === null ? -1 : rec.wheelIndex,
      BODY_ROLES.indexOf(rec.bodyRole),
    ];
    if (this.#lastKey !== null) {
      let cmp = 0;
      for (let i = 0; i < key.length && cmp === 0; i += 1) cmp = key[i] - this.#lastKey[i];
      if (cmp <= 0) {
        writerFail('record out of canonical order', `${JSON.stringify(this.#lastKey)} then ${JSON.stringify(key)}`);
      }
    }
    this.#lastKey = key;
    if (rec.stepIndex > this.#maxSeenStep) this.#maxSeenStep = rec.stepIndex;
    this.#state = fnv1aFold(this.#state, this.#scratch);
    this.#recordCount += 1;
    this.#byteCount += RECORD_BYTES;
    if (this.#mode === 'full') this.#records.push(this.#scratch.slice()); // COPY — never the scratch itself
  }

  endStep(stepIndex) {
    if (this.#finished) writerFail('endStep() after finish()', stepIndex);
    if (this.#mode === 'none') return;
    if (!Number.isInteger(stepIndex) || stepIndex <= this.#lastEndedStep) {
      writerFail('endStep must advance', `${stepIndex} after ${this.#lastEndedStep}`);
    }
    if (stepIndex < this.#maxSeenStep) {
      writerFail('endStep behind recorded steps', `${stepIndex} < max seen ${this.#maxSeenStep}`);
    }
    this.#lastEndedStep = stepIndex;
    this.#stepsEnded += 1;
    if (this.#stepsEnded % this.#interval === 0) {
      this.#checkpoints.push({
        stepIndex,
        recordCount: this.#recordCount,
        byteCount: this.#byteCount,
        state: this.#state,
      });
    }
  }

  finish() {
    if (this.#finished) writerFail('finish() after finish()', this.#mode);
    this.#finished = true;
    if (this.#mode === 'none') {
      return {
        version: EVALUATION_TRACE_VERSION,
        mode: 'none',
        recordBytes: RECORD_BYTES,
        recordCount: null, // an honest "did no work", never a fake 0
        byteCount: null,
        digest: null,
        checkpoints: null,
        records: null,
      };
    }
    const last = this.#checkpoints[this.#checkpoints.length - 1];
    const anythingHappened = this.#lastEndedStep !== -1 || this.#maxSeenStep !== -1;
    const lastIsCurrent = last !== undefined
      && last.recordCount === this.#recordCount
      && last.byteCount === this.#byteCount
      && last.stepIndex === Math.max(this.#lastEndedStep, this.#maxSeenStep);
    if (anythingHappened && !lastIsCurrent) {
      this.#checkpoints.push({
        stepIndex: Math.max(this.#lastEndedStep, this.#maxSeenStep),
        recordCount: this.#recordCount,
        byteCount: this.#byteCount,
        state: this.#state,
      });
    }
    return {
      version: EVALUATION_TRACE_VERSION,
      mode: this.#mode,
      recordBytes: RECORD_BYTES,
      recordCount: this.#recordCount,
      byteCount: this.#byteCount,
      digest: fnv1aHexOf(this.#state),
      checkpoints: this.#checkpoints,
      records: this.#records,
    };
  }
}

// --- Comparison / diagnostics --------------------------------------------------

const hexBytes = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Lenient identity read for divergence reports: raw wire values, no
// validation — a corrupt stream must still be REPORTABLE, so this never
// throws on out-of-range codes (it reports the raw code instead).
function identityOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const axleRaw = view.getUint32(8, true);
  const wheelRaw = view.getUint32(12, true);
  const roleCode = view.getUint8(16);
  return {
    stepIndex: view.getUint32(0, true),
    vehicleIndex: view.getUint32(4, true),
    axleIndex: axleRaw === NO_INDEX ? null : axleRaw,
    wheelIndex: wheelRaw === NO_INDEX ? null : wheelRaw,
    bodyRole: BODY_ROLES[roleCode] ?? `code ${roleCode}`,
  };
}

function fieldValueOf(f, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (f.type === 'f64') return view.getFloat64(f.offset, true);
  if (f.type === 'u32') {
    const v = view.getUint32(f.offset, true);
    return (f.name === 'axleIndex' || f.name === 'wheelIndex') && v === NO_INDEX ? null : v;
  }
  const code = view.getUint8(f.offset);
  if (f.name === 'bodyRole') return BODY_ROLES[code] ?? `code ${code}`;
  if (f.name === 'jointState') return JOINT_STATES[code] ?? `code ${code}`;
  if (f.name === 'terminationReason') return TERMINATION_REASONS[code] ?? `code ${code}`;
  return code;
}

function compareFail(what, value) {
  throw new Error(`trace: compare ${what} (${String(value)})`);
}

function normalizeRecords(side, label) {
  if (typeof side !== 'object' || side === null) compareFail(`invalid ${label}`, side);
  if (!Number.isInteger(side.version)) compareFail(`${label}.version missing`, side.version);
  if (!Number.isInteger(side.recordBytes)) compareFail(`${label}.recordBytes missing`, side.recordBytes);
  if (!Array.isArray(side.records)) compareFail(`${label}.records missing (full-capture input required)`, side.records);
  return side.records;
}

/**
 * Compare two full-capture traces. `expected`/`actual` are
 * `{ version, recordBytes, records }` — a full-mode `finish()` result works
 * directly; records entries may be Uint8Array(RECORD_BYTES) or plain record
 * objects (encoded on the fly), so tests can diff against hand-written
 * expectations. Returns null when identical, else the FIRST divergence:
 * `{ kind, expectedCount, actualCount, ... }` with kind one of
 * versionMismatch | recordSizeMismatch | fieldMismatch | orderingMismatch |
 * missingRecord | extraRecord. Comparison is byte-first, so −0 vs +0 and
 * differing quaternion signs ARE divergences.
 */
export function compareTraces(expected, actual) {
  const expRecords = normalizeRecords(expected, 'expected');
  const actRecords = normalizeRecords(actual, 'actual');
  const counts = { expectedCount: expRecords.length, actualCount: actRecords.length };
  if (expected.version !== actual.version) {
    return { kind: 'versionMismatch', ...counts, expected: expected.version, actual: actual.version };
  }
  if (expected.recordBytes !== actual.recordBytes
    || expected.recordBytes !== RECORD_BYTES || actual.recordBytes !== RECORD_BYTES) {
    return {
      kind: 'recordSizeMismatch', ...counts, index: null,
      expected: expected.recordBytes, actual: actual.recordBytes,
    };
  }
  const toBytes = (entry, index, label) => {
    if (entry instanceof Uint8Array) {
      if (entry.byteLength !== RECORD_BYTES) {
        return { sizeError: { kind: 'recordSizeMismatch', ...counts, index, label, expected: RECORD_BYTES, actual: entry.byteLength } };
      }
      return { bytes: entry };
    }
    return { bytes: encodeTraceRecord(entry) };
  };
  const n = Math.min(expRecords.length, actRecords.length);
  for (let i = 0; i < n; i += 1) {
    const e = toBytes(expRecords[i], i, 'expected');
    if (e.sizeError) return e.sizeError;
    const a = toBytes(actRecords[i], i, 'actual');
    if (a.sizeError) return a.sizeError;
    let firstDiff = -1;
    for (let b = 0; b < RECORD_BYTES; b += 1) {
      if (e.bytes[b] !== a.bytes[b]) { firstDiff = b; break; }
    }
    if (firstDiff === -1) continue;
    const expId = identityOf(e.bytes);
    const actId = identityOf(a.bytes);
    const idEqual = expId.stepIndex === actId.stepIndex
      && expId.vehicleIndex === actId.vehicleIndex
      && expId.axleIndex === actId.axleIndex
      && expId.wheelIndex === actId.wheelIndex
      && expId.bodyRole === actId.bodyRole;
    if (!idEqual) {
      return { kind: 'orderingMismatch', ...counts, index: i, expected: expId, actual: actId };
    }
    const f = TRACE_FIELDS.find((fd) => firstDiff >= fd.offset && firstDiff < fd.offset + fd.bytes);
    return {
      kind: 'fieldMismatch',
      ...counts,
      index: i,
      identity: expId,
      field: f.name,
      byteOffset: f.offset,
      expectedValue: fieldValueOf(f, e.bytes),
      actualValue: fieldValueOf(f, a.bytes),
      expectedBytes: hexBytes(e.bytes.subarray(f.offset, f.offset + f.bytes)),
      actualBytes: hexBytes(a.bytes.subarray(f.offset, f.offset + f.bytes)),
    };
  }
  if (expRecords.length > actRecords.length) {
    const e = toBytes(expRecords[n], n, 'expected');
    return { kind: 'missingRecord', ...counts, index: n, identity: e.sizeError ? null : identityOf(e.bytes) };
  }
  if (actRecords.length > expRecords.length) {
    const a = toBytes(actRecords[n], n, 'actual');
    return { kind: 'extraRecord', ...counts, index: n, identity: a.sizeError ? null : identityOf(a.bytes) };
  }
  return null;
}

/**
 * Localize the first differing step/block between two checkpoint sequences.
 * Entries are `{ stepIndex, recordCount, byteCount, state }`; a side may be
 * PARTIAL (e.g. lock-derived `{ stepIndex, state }` pairs) — only fields
 * present on both sides are compared. Returns null when identical, else
 * `{ checkpointIndex, reason, lastAgreedStepIndex, firstDifferingStepIndex,
 * expected, actual }` — with interval 1 the first bad step exactly, with
 * interval N an N-step block for a bounded full-capture re-run.
 */
export function compareCheckpoints(expected, actual) {
  if (!Array.isArray(expected)) compareFail('invalid expected checkpoints', expected);
  if (!Array.isArray(actual)) compareFail('invalid actual checkpoints', actual);
  const n = Math.min(expected.length, actual.length);
  const lastAgreed = (i) => (i > 0 ? expected[i - 1].stepIndex : null);
  for (let i = 0; i < n; i += 1) {
    for (const fieldName of ['stepIndex', 'recordCount', 'byteCount', 'state']) {
      const e = expected[i][fieldName];
      const a = actual[i][fieldName];
      if (e === undefined || a === undefined || e === a) continue;
      return {
        checkpointIndex: i,
        reason: fieldName,
        lastAgreedStepIndex: lastAgreed(i),
        firstDifferingStepIndex: expected[i].stepIndex ?? actual[i].stepIndex ?? null,
        expected: expected[i],
        actual: actual[i],
      };
    }
  }
  if (expected.length !== actual.length) {
    const longer = expected.length > actual.length ? expected : actual;
    return {
      checkpointIndex: n,
      reason: 'length',
      lastAgreedStepIndex: lastAgreed(n),
      firstDifferingStepIndex: longer[n].stepIndex ?? null,
      expected: expected[n] ?? null,
      actual: actual[n] ?? null,
    };
  }
  return null;
}
