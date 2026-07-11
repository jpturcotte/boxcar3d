import { describe, test, expect } from 'vitest';
import {
  EVALUATION_TRACE_VERSION, RECORD_BYTES, TRACE_FIELDS,
  BODY_ROLES, JOINT_STATES, TERMINATION_REASONS, TRACE_MODES,
  NO_INDEX, MAX_AXLE_INDEX, MAX_WHEEL_INDEX,
  encodeTraceRecord, decodeTraceRecord,
} from '../src/sim/trace.js';
import { fnv1aHex } from '../src/sim/fnv1a.js';
import { Rng } from '../src/sim/prng.js';

// Codec contract for the versioned evaluation trace (EVALUATION_TRACE_VERSION
// 1, 128-byte fixed records, raw LE f64 floats with the single canonical-NaN
// ruling). Any layout/enum change here is a trace-version bump — it means the
// ENCODED CONTRACT changed, not that physics changed.

// A valid hub-station baseline with a distinctive value in every field.
function baseRecord() {
  return {
    stepIndex: 7,
    vehicleIndex: 2,
    bodyRole: 'hub',
    axleIndex: 3,
    wheelIndex: 1,
    bodyValid: true,
    bodySleeping: false,
    jointState: 'valid',
    terminated: false,
    terminationReason: 'none',
    finiteState: true,
    translation: { x: 1.5, y: -2.25, z: 3.0625 },
    rotation: { x: 0.1, y: -0.2, z: 0.3, w: 0.9 },
    linvel: { x: -4.5, y: 5.5, z: -6.5 },
    angvel: { x: 7.5, y: -8.5, z: 9.5 },
  };
}

function chassisRecord() {
  return {
    ...baseRecord(),
    bodyRole: 'chassis',
    axleIndex: null,
    wheelIndex: null,
    jointState: 'valid',
  };
}

// Object.is-strict deep equality: vitest's toEqual treats +0 and −0 as equal,
// which is exactly the distinction the raw-bits contract must preserve.
function assertBitEqual(actual, expected, path = 'record') {
  if (typeof expected === 'number') {
    expect(Object.is(actual, expected), `${path}: ${actual} vs ${expected}`).toBe(true);
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) assertBitEqual(actual[k], expected[k], `${path}.${k}`);
    return;
  }
  expect(actual).toBe(expected);
}

describe('trace record codec (T1–T8)', () => {
  test('T1: RECORD_BYTES is 128 and TRACE_FIELDS tiles [0, 128) exactly', () => {
    expect(RECORD_BYTES).toBe(128);
    expect(EVALUATION_TRACE_VERSION).toBe(1);
    expect(encodeTraceRecord(baseRecord()).byteLength).toBe(128);
    const sorted = [...TRACE_FIELDS].sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    for (const f of sorted) {
      expect(f.offset, `gap/overlap before ${f.name}`).toBe(cursor);
      cursor += f.bytes;
    }
    expect(cursor).toBe(RECORD_BYTES);
  });

  test('T2: golden little-endian bytes at declared offsets', () => {
    const rec = { ...baseRecord(), stepIndex: 0x01020304, vehicleIndex: 0x0a0b0c0d, axleIndex: 5, wheelIndex: 9 };
    const bytes = encodeTraceRecord(rec);
    expect([...bytes.subarray(0, 4)]).toEqual([0x04, 0x03, 0x02, 0x01]); // u32 LE
    expect([...bytes.subarray(4, 8)]).toEqual([0x0d, 0x0c, 0x0b, 0x0a]);
    expect([...bytes.subarray(8, 12)]).toEqual([0x05, 0x00, 0x00, 0x00]);
    expect([...bytes.subarray(12, 16)]).toEqual([0x09, 0x00, 0x00, 0x00]);
    // Discrete header: role hub=1, valid=1, sleeping=0, jointState valid=1,
    // terminated=0, reason none=0, finite=1, reserved=0.
    expect([...bytes.subarray(16, 24)]).toEqual([1, 1, 0, 1, 0, 0, 1, 0]);
    // translation.x = 1.5 → IEEE-754 LE 00 00 00 00 00 00 F8 3F.
    expect([...bytes.subarray(24, 32)]).toEqual([0, 0, 0, 0, 0, 0, 0xf8, 0x3f]);
  });

  test('T3: raw f64 bit preservation — −0, denormal, ±Infinity, quaternion sign; canonical NaN', () => {
    const rec = baseRecord();
    rec.translation.x = -0;
    rec.translation.y = Number.MIN_VALUE;
    rec.linvel.x = Infinity;
    rec.linvel.y = -Infinity;
    rec.rotation.w = -0.5;
    rec.finiteState = false;
    const bytes = encodeTraceRecord(rec);
    const back = decodeTraceRecord(bytes);
    expect(Object.is(back.translation.x, -0)).toBe(true);
    expect(Object.is(back.translation.y, Number.MIN_VALUE)).toBe(true);
    expect(back.linvel.x).toBe(Infinity);
    expect(back.linvel.y).toBe(-Infinity);
    expect(Object.is(back.rotation.w, -0.5)).toBe(true);
    // Quaternion sign is NOT canonicalized: −w and +w differ on the wire.
    const plus = encodeTraceRecord({ ...baseRecord(), rotation: { x: 0.1, y: -0.2, z: 0.3, w: 0.5 } });
    const minus = encodeTraceRecord({ ...baseRecord(), rotation: { x: 0.1, y: -0.2, z: 0.3, w: -0.5 } });
    expect([...plus]).not.toEqual([...minus]);
    // −0 and +0 differ on the wire too.
    const negZero = encodeTraceRecord({ ...baseRecord(), translation: { x: -0, y: 0, z: 0 } });
    const posZero = encodeTraceRecord({ ...baseRecord(), translation: { x: 0, y: 0, z: 0 } });
    expect([...negZero]).not.toEqual([...posZero]);
    // NaN — the sole normalization: canonical quiet NaN 0x7FF8000000000000,
    // regardless of the engine/JS NaN the caller held.
    const nanRec = { ...baseRecord(), finiteState: false, angvel: { x: NaN, y: 0, z: 0 } };
    const nanBytes = encodeTraceRecord(nanRec);
    expect([...nanBytes.subarray(104, 112)]).toEqual([0, 0, 0, 0, 0, 0, 0xf8, 0x7f]);
    expect(Number.isNaN(decodeTraceRecord(nanBytes).angvel.x)).toBe(true);
    // Re-encode of a decode is byte-identical (fixed point).
    expect([...encodeTraceRecord(decodeTraceRecord(nanBytes))]).toEqual([...nanBytes]);
  });

  test('T4: enum wire codes are locked and frozen (append-only)', () => {
    expect(BODY_ROLES).toEqual(['chassis', 'hub', 'wheel']);
    expect(JOINT_STATES).toEqual(['invalid', 'valid', 'notApplicable']);
    expect(TERMINATION_REASONS).toEqual(['none', 'nonFinite']);
    expect(TERMINATION_REASONS[0]).toBe('none'); // load-bearing: the terminated-bit coherence rule
    expect(TRACE_MODES).toEqual(['none', 'digest', 'full']);
    for (const arr of [BODY_ROLES, JOINT_STATES, TERMINATION_REASONS, TRACE_MODES, TRACE_FIELDS]) {
      expect(Object.isFrozen(arr)).toBe(true);
    }
    expect(Object.isFrozen(TRACE_FIELDS[0])).toBe(true);
  });

  test('T5: NO_INDEX sentinel — chassis encodes 0xffffffff, decodes to null; a real index may not collide', () => {
    expect(NO_INDEX).toBe(0xffffffff);
    expect(MAX_AXLE_INDEX).toBe(0xfffffffe);
    expect(MAX_WHEEL_INDEX).toBe(0xfffffffe);
    const bytes = encodeTraceRecord(chassisRecord());
    expect([...bytes.subarray(8, 12)]).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect([...bytes.subarray(12, 16)]).toEqual([0xff, 0xff, 0xff, 0xff]);
    const back = decodeTraceRecord(bytes);
    expect(back.axleIndex).toBeNull();
    expect(back.wheelIndex).toBeNull();
    // Sentinel collision is the defined overflow behavior.
    expect(() => encodeTraceRecord({ ...baseRecord(), axleIndex: 0xffffffff }))
      .toThrow(/trace: invalid record at axleIndex/);
    // The max representable index is legal.
    const maxed = encodeTraceRecord({ ...baseRecord(), axleIndex: MAX_AXLE_INDEX, wheelIndex: MAX_WHEEL_INDEX });
    expect(decodeTraceRecord(maxed).axleIndex).toBe(MAX_AXLE_INDEX);
  });

  test('T6: fail-loud matrix — encoder', () => {
    const cases = [
      [{ ...baseRecord(), stepIndex: 2 ** 32 }, /stepIndex/],
      [{ ...baseRecord(), stepIndex: -1 }, /stepIndex/],
      [{ ...baseRecord(), stepIndex: 1.5 }, /stepIndex/],
      [{ ...baseRecord(), vehicleIndex: 2 ** 32 }, /vehicleIndex/],
      [{ ...baseRecord(), bodyRole: 'motor' }, /bodyRole/],
      [{ ...baseRecord(), jointState: 'maybe' }, /jointState/],
      [{ ...baseRecord(), terminationReason: 'lava' }, /terminationReason/],
      [{ ...baseRecord(), bodyValid: 1 }, /bodyValid/], // number, not boolean
      [{ ...baseRecord(), terminated: true }, /terminationReason/], // reason stays 'none'
      [{ ...baseRecord(), terminated: false, terminationReason: 'nonFinite' }, /terminationReason/],
      [{ ...chassisRecord(), axleIndex: 0 }, /axleIndex/],
      [{ ...baseRecord(), wheelIndex: null }, /wheelIndex/],
      [{ ...baseRecord(), jointState: 'notApplicable' }, /jointState/],
      [{ ...baseRecord(), translation: { x: '1.5', y: 0, z: 0 } }, /translation\.x/],
      [{ ...baseRecord(), translation: { x: 0, y: 0, z: 0, w: 1 } }, /translation\.w/],
      [{ ...baseRecord(), bodyHandle: 7 }, /bodyHandle/], // the no-handles tooth
      [{ ...baseRecord(), timestamp: 12345 }, /timestamp/], // the no-timestamps tooth
    ];
    for (const [rec, re] of cases) {
      expect(() => encodeTraceRecord(rec), JSON.stringify(rec)).toThrow(re);
    }
    // Non-finite floats are ACCEPTED (finiteState records them) — must NOT throw.
    expect(() => encodeTraceRecord({ ...baseRecord(), finiteState: false, linvel: { x: NaN, y: Infinity, z: -Infinity } }))
      .not.toThrow();
    // Bad output buffers.
    expect(() => encodeTraceRecord(baseRecord(), new Uint8Array(127))).toThrow(/trace: invalid record at out/);
    expect(() => encodeTraceRecord(baseRecord(), [])).toThrow(/trace: invalid record at out/);
  });

  test('T6b: fail-loud matrix — decoder', () => {
    expect(() => decodeTraceRecord(new Uint8Array(127))).toThrow(/offset/);
    expect(() => decodeTraceRecord(encodeTraceRecord(baseRecord()), 1)).toThrow(/offset/);
    const roleBad = encodeTraceRecord(baseRecord());
    roleBad[16] = 3;
    expect(() => decodeTraceRecord(roleBad)).toThrow(/bodyRole/);
    const flagBad = encodeTraceRecord(baseRecord());
    flagBad[17] = 2;
    expect(() => decodeTraceRecord(flagBad)).toThrow(/bodyValid/);
    const reservedBad = encodeTraceRecord(baseRecord());
    reservedBad[23] = 1;
    expect(() => decodeTraceRecord(reservedBad)).toThrow(/reserved/);
    const reasonBad = encodeTraceRecord(baseRecord());
    reasonBad[21] = TERMINATION_REASONS.length;
    expect(() => decodeTraceRecord(reasonBad)).toThrow(/terminationReason/);
  });

  test('T7: mutating one semantic field changes exactly its byte region, and the digest', () => {
    // terminated/terminationReason are coherence-paired: flipping one requires
    // flipping the other, so their expected dirty region is the pair.
    const mutations = {
      stepIndex: (r) => { r.stepIndex += 1; },
      vehicleIndex: (r) => { r.vehicleIndex += 1; },
      axleIndex: (r) => { r.axleIndex += 1; },
      wheelIndex: (r) => { r.wheelIndex += 1; },
      bodyRole: (r) => { r.bodyRole = 'wheel'; }, // hub→wheel keeps indices/jointState legal
      bodyValid: (r) => { r.bodyValid = false; },
      bodySleeping: (r) => { r.bodySleeping = true; },
      jointState: (r) => { r.jointState = 'invalid'; },
      terminated: (r) => { r.terminated = true; r.terminationReason = 'nonFinite'; },
      terminationReason: null, // covered by the `terminated` pair mutation
      finiteState: (r) => { r.finiteState = false; },
      reserved: null, // padding — not a semantic field
      'translation.x': (r) => { r.translation.x += 1; },
      'translation.y': (r) => { r.translation.y += 1; },
      'translation.z': (r) => { r.translation.z += 1; },
      'rotation.x': (r) => { r.rotation.x += 1; },
      'rotation.y': (r) => { r.rotation.y += 1; },
      'rotation.z': (r) => { r.rotation.z += 1; },
      'rotation.w': (r) => { r.rotation.w += 1; },
      'linvel.x': (r) => { r.linvel.x += 1; },
      'linvel.y': (r) => { r.linvel.y += 1; },
      'linvel.z': (r) => { r.linvel.z += 1; },
      'angvel.x': (r) => { r.angvel.x += 1; },
      'angvel.y': (r) => { r.angvel.y += 1; },
      'angvel.z': (r) => { r.angvel.z += 1; },
    };
    const pairedRegions = {
      terminated: ['terminated', 'terminationReason'],
    };
    expect(Object.keys(mutations).sort()).toEqual(TRACE_FIELDS.map((f) => f.name).sort());
    const baseline = encodeTraceRecord(baseRecord());
    const baseDigest = fnv1aHex(baseline);
    const regionOf = (name) => TRACE_FIELDS.find((f) => f.name === name);
    for (const [name, mutate] of Object.entries(mutations)) {
      if (mutate === null) continue;
      const rec = baseRecord();
      mutate(rec);
      const mutated = encodeTraceRecord(rec);
      const allowed = (pairedRegions[name] ?? [name]).map(regionOf);
      const inAllowed = (i) => allowed.some((f) => i >= f.offset && i < f.offset + f.bytes);
      for (let i = 0; i < RECORD_BYTES; i += 1) {
        if (!inAllowed(i)) {
          expect(mutated[i], `field ${name} leaked into byte ${i}`).toBe(baseline[i]);
        }
      }
      for (const f of allowed) {
        const region = mutated.subarray(f.offset, f.offset + f.bytes);
        const baseRegion = baseline.subarray(f.offset, f.offset + f.bytes);
        expect([...region], `field ${name}: region ${f.name} did not change`).not.toEqual([...baseRegion]);
      }
      expect(fnv1aHex(mutated), `field ${name}: digest unchanged`).not.toBe(baseDigest);
    }
  });

  test('T8: decode is the exact inverse over a seeded corpus (seed 20260711, 64 records)', () => {
    const specials = [-0, 0, 1.5, -1e300, Number.MIN_VALUE, Infinity, -Infinity, NaN, 2 ** -1022];
    const corpus = [];
    for (let i = 0; i < 64; i += 1) {
      const rng = new Rng(20260711).fork(i);
      const role = BODY_ROLES[rng.int(0, 3)];
      const station = role !== 'chassis';
      const terminated = rng.bool();
      const num = () => (rng.bool(0.25) ? specials[rng.int(0, specials.length)] : rng.range(-1e6, 1e6));
      const vec3 = () => ({ x: num(), y: num(), z: num() });
      corpus.push({
        stepIndex: rng.int(0, 1000000),
        vehicleIndex: rng.int(0, 1000),
        bodyRole: role,
        axleIndex: station ? rng.int(0, 6) : null,
        wheelIndex: station ? rng.int(0, 2) : null,
        bodyValid: rng.bool(),
        bodySleeping: rng.bool(),
        jointState: station ? JOINT_STATES[rng.int(0, 2)] : JOINT_STATES[rng.int(0, 3)],
        terminated,
        terminationReason: terminated ? 'nonFinite' : 'none',
        finiteState: rng.bool(),
        translation: vec3(),
        rotation: { ...vec3(), w: num() },
        linvel: vec3(),
        angvel: vec3(),
      });
    }
    for (const rec of corpus) {
      const back = decodeTraceRecord(encodeTraceRecord(rec));
      assertBitEqual(back, rec);
      expect(Object.keys(back).sort()).toEqual([
        'angvel', 'axleIndex', 'bodyRole', 'bodySleeping', 'bodyValid', 'finiteState',
        'jointState', 'linvel', 'rotation', 'stepIndex', 'terminated', 'terminationReason',
        'translation', 'vehicleIndex', 'wheelIndex',
      ]);
    }
  });
});
