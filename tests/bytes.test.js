// The shared byte reader + the JSON-safe hex representation (src/sim/bytes.js).
//
// Two contracts: (1) every read is bounds-checked and routes its failure
// through the CALLING module's fail idiom, so decoders speak one dialect;
// (2) bytes <-> canonical lowercase hex is exactly lossless and rejects
// malformed text loud instead of normalizing it (an uppercase digest silently
// lowercased is the class of bug that makes two "identical" artifacts differ).

import { describe, test, expect } from 'vitest';
import { bytesToHex, createByteReader, hexToBytes, typedArrayByteLength } from '../src/sim/bytes.js';

const fail = (path, value) => {
  throw new Error(`probe: invalid at ${path} (${String(value)})`);
};

// A buffer with one of every width, little-endian: u8 0x2a, u16 0x1234,
// u32 0xdeadbeef, f64 -0.5, flag 1, flag 0.
function sampleBytes() {
  const view = new DataView(new ArrayBuffer(1 + 2 + 4 + 8 + 1 + 1));
  view.setUint8(0, 0x2a);
  view.setUint16(1, 0x1234, true);
  view.setUint32(3, 0xdeadbeef, true);
  view.setFloat64(7, -0.5, true);
  view.setUint8(15, 1);
  view.setUint8(16, 0);
  return new Uint8Array(view.buffer);
}

describe('createByteReader — little-endian reads and cursor state', () => {
  test('reads every width in order and tracks offset/remaining', () => {
    const bytes = sampleBytes();
    const r = createByteReader(bytes, fail);
    expect(r.offset).toBe(0);
    expect(r.remaining).toBe(17);
    expect(r.u8('a')).toBe(0x2a);
    expect(r.u16('b')).toBe(0x1234);
    expect(r.u32('c')).toBe(0xdeadbeef);
    expect(Object.is(r.f64('d'), -0.5)).toBe(true);
    expect(r.offset).toBe(15);
    expect(r.flag('e')).toBe(true);
    expect(r.flag('f')).toBe(false);
    expect(r.remaining).toBe(0);
    expect(() => r.expectEnd('end')).not.toThrow();
  });

  test('offset and remaining are live getters, not a frozen snapshot', () => {
    const r = createByteReader(new Uint8Array(4), fail);
    expect(r.offset).toBe(0);
    r.u16('x');
    expect(r.offset).toBe(2);
    expect(r.remaining).toBe(2);
    // The reader itself is frozen — no caller can graft state onto it.
    expect(Object.isFrozen(r)).toBe(true);
  });

  test('every width fails loud on truncation, through the caller idiom', () => {
    const widths = [['u8', 1], ['u16', 2], ['u32', 4], ['f64', 8], ['finiteF64', 8], ['flag', 1]];
    for (const [method, width] of widths) {
      const r = createByteReader(new Uint8Array(width - 1), fail);
      expect(() => r[method]('field'), method).toThrow(/probe: invalid at field \(truncated at byte 0/);
    }
  });

  test('a partially-consumed buffer reports the truncation offset', () => {
    const r = createByteReader(new Uint8Array(6), fail);
    r.u32('a');
    expect(() => r.f64('b')).toThrow(/truncated at byte 4 \(need 8, have 2\)/);
  });

  test('finiteF64 rejects NaN and infinities; f64 does not', () => {
    const view = new DataView(new ArrayBuffer(24));
    view.setFloat64(0, NaN, true);
    view.setFloat64(8, Infinity, true);
    view.setFloat64(16, -Infinity, true);
    const raw = createByteReader(new Uint8Array(view.buffer), fail);
    expect(Number.isNaN(raw.f64('a'))).toBe(true);
    expect(raw.f64('b')).toBe(Infinity);
    expect(raw.f64('c')).toBe(-Infinity);
    const gated = createByteReader(new Uint8Array(view.buffer), fail);
    expect(() => gated.finiteF64('a')).toThrow(/probe: invalid at a \(NaN\)/);
  });

  test('flag accepts only 0 and 1', () => {
    for (const b of [2, 0xff]) {
      const r = createByteReader(Uint8Array.of(b), fail);
      expect(() => r.flag('flag')).toThrow(new RegExp(`probe: invalid at flag \\(${b}\\)`));
    }
  });

  test('bytes(n) returns the window and advances; a negative n fails', () => {
    const r = createByteReader(Uint8Array.of(1, 2, 3, 4), fail);
    expect([...r.bytes(3, 'chunk')]).toEqual([1, 2, 3]);
    expect(r.remaining).toBe(1);
    expect(() => r.bytes(2, 'chunk')).toThrow(/truncated/);
    expect(() => createByteReader(new Uint8Array(4), fail).bytes(-1, 'chunk')).toThrow(/probe: invalid at chunk \(-1\)/);
  });

  test('expectEnd rejects trailing bytes with their count and offset', () => {
    const r = createByteReader(new Uint8Array(6), fail);
    r.u32('a');
    expect(() => r.expectEnd('tail')).toThrow(/probe: invalid at tail \(2 trailing byte\(s\) at offset 4\)/);
  });

  test('a subarray view reads its OWN window, not the parent buffer', () => {
    const parent = new Uint8Array(16);
    new DataView(parent.buffer).setUint32(0, 0x11111111, true);
    new DataView(parent.buffer).setUint32(8, 0xabcdef01, true);
    const window = parent.subarray(8, 12);
    const r = createByteReader(window, fail);
    expect(r.u32('v')).toBe(0xabcdef01);
    expect(r.remaining).toBe(0);
  });

  test('rejects a non-Uint8Array buffer and a missing fail callback', () => {
    expect(() => createByteReader([1, 2, 3], fail)).toThrow(/probe: invalid at bytes/);
    expect(() => createByteReader(new Uint8Array(1), null)).toThrow(/bytes: invalid fail callback/);
  });
});

describe('bytesToHex / hexToBytes — the lossless JSON-safe representation', () => {
  test('empty round trip', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
    expect(hexToBytes('').length).toBe(0);
  });

  test('all 256 byte values survive exactly', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const hex = bytesToHex(all);
    expect(hex).toHaveLength(512);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex.slice(0, 2)).toBe('00');
    expect(hex.slice(15 * 2, 15 * 2 + 2)).toBe('0f');
    expect(hex.slice(165 * 2, 165 * 2 + 2)).toBe('a5');
    expect(hex.slice(510)).toBe('ff');
    const back = hexToBytes(hex);
    expect(back.length).toBe(256);
    for (let i = 0; i < 256; i += 1) expect(back[i]).toBe(i);
  });

  test('ordinary fixture bytes round trip', () => {
    const bytes = sampleBytes();
    const back = hexToBytes(bytesToHex(bytes));
    expect([...back]).toEqual([...bytes]);
  });

  test('survives a JSON envelope (hex in, bytes out — JSON is never the identity)', () => {
    const bytes = sampleBytes();
    const envelope = { schema: 'boxcar3d.codec-test/1', payload: bytesToHex(bytes) };
    const parsed = JSON.parse(JSON.stringify(envelope));
    expect([...hexToBytes(parsed.payload)]).toEqual([...bytes]);
  });

  test('hex -> bytes -> hex is exact for canonical strings', () => {
    for (const s of ['', '00', 'ff', 'deadbeef', '0123456789abcdef']) {
      expect(bytesToHex(hexToBytes(s))).toBe(s);
    }
  });

  test('malformed text fails loud — odd length, uppercase, non-hex, wrong type', () => {
    for (const bad of ['a', 'abc', '0123456']) {
      expect(() => hexToBytes(bad), bad).toThrow(/bytes: invalid hex/);
    }
    // Canonical casing is LOWERCASE by ruling: uppercase is rejected, never
    // silently normalized (a normalizing decoder makes two artifacts that
    // differ in bytes compare equal).
    for (const bad of ['AB', 'aBcd', 'DEADBEEF']) {
      expect(() => hexToBytes(bad), bad).toThrow(/bytes: invalid hex/);
    }
    for (const bad of ['zz', '0x1f', ' ab', 'a b', 'ab\n']) {
      expect(() => hexToBytes(bad), bad).toThrow(/bytes: invalid hex/);
    }
    for (const bad of [null, undefined, 42, new Uint8Array(2), ['ab']]) {
      expect(() => hexToBytes(bad)).toThrow(/bytes: invalid hex \(string required\)/);
    }
  });

  test('bytesToHex rejects anything that is not a Uint8Array', () => {
    // The storage-lifetime gate (C12) subsumes the old brand check; the message
    // moved to "not an ordinary same-realm Uint8Array".
    for (const bad of [[1, 2], 'ab', null, new Uint16Array(2)]) {
      expect(() => bytesToHex(bad)).toThrow(/bytes: invalid bytes \(not an ordinary/);
    }
  });
});

describe('intrinsic geometry — own-property shadowing cannot redirect a read', () => {
  // `length`/`buffer`/`byteOffset`/`byteLength` are inherited ACCESSORS on
  // %TypedArray%.prototype, so an own data property on a GENUINE Uint8Array
  // shadows them with ordinary JavaScript. Pre-fix, a 4-byte array claiming
  // `length: 2` hex-encoded as 'dead' (content deadbeef), and a shadowed
  // byteOffset/byteLength/buffer silently pointed the reader's DataView at
  // bytes OUTSIDE the array's real window. The module now reads geometry
  // through the intrinsic prototype getters, which report the runtime's truth.
  const moduleFail = (path, value) => {
    throw new Error(`mod: invalid at ${path} (${String(value)})`);
  };

  test('bytesToHex encodes the REAL window under a shadowed length', () => {
    const u = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    Object.defineProperty(u, 'length', { value: 2 });
    expect(u instanceof Uint8Array).toBe(true);
    expect(bytesToHex(u)).toBe('deadbeef');
    // Shadowed LARGER must not throw a foreign TypeError either.
    const v = new Uint8Array([1, 2]);
    Object.defineProperty(v, 'length', { value: 8 });
    expect(bytesToHex(v)).toBe('0102');
  });

  test('the reader reads a subarray\'s OWN window under shadowed geometry', () => {
    const backing = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc, 0xdd]);
    const sub = backing.subarray(4, 8);
    Object.defineProperty(sub, 'byteOffset', { value: 0 }); // claims the head
    const r = createByteReader(sub, moduleFail);
    expect(r.u32('w')).toBe(0xddccbbaa); // the REAL window, not the head

    const short = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).subarray(0, 4);
    Object.defineProperty(short, 'byteLength', { value: 8 }); // claims the tail
    const r2 = createByteReader(short, moduleFail);
    r2.u32('a');
    expect(() => r2.u32('b')).toThrow(/truncated at byte 4/); // window is 4, not 8

    const foreign = new Uint8Array([9, 9, 9, 9]);
    Object.defineProperty(foreign, 'buffer', { value: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]).buffer });
    const r3 = createByteReader(foreign, moduleFail);
    expect(r3.u32('c')).toBe(0x09090909); // the array's real buffer
  });

  test('an own subarray property is never invoked by r.bytes', () => {
    const u = new Uint8Array([1, 2, 3, 4]);
    let invoked = false;
    u.subarray = function evil() { invoked = true; return new Uint8Array([9]); };
    const r = createByteReader(u, moduleFail);
    const out = r.bytes(4, 'all');
    expect(invoked).toBe(false);
    expect([...out]).toEqual([1, 2, 3, 4]);
  });
});

// C12 (JP's ruling / break-it sweep I7): canonical bytes must be ORDINARY —
// same-realm, fixed-size, non-shared, non-detached. A genuine Uint8Array whose
// STORAGE is transient or foreign is rejected loud at the door, never silently
// absorbed. These attack the shadowing tests' blind spot: the geometry is
// honest, the backing store is not.
describe('storage-lifetime intake — fancy backing stores are rejected at the door', () => {
  const moduleFail = (path, value) => { throw new Error(`mod: invalid at ${path} (${String(value)})`); };
  const detach = (u) => { u.buffer.transfer(); return u; }; // ArrayBuffer.prototype.transfer detaches

  test('a detached buffer is rejected, never hex-encoded as ""', () => {
    const u = detach(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
    expect(() => bytesToHex(u)).toThrow(/detached ArrayBuffer/);
    expect(() => createByteReader(u, moduleFail)).toThrow(/mod: invalid at bytes/);
  });

  test('a SharedArrayBuffer-backed view is rejected (concurrent mutation)', () => {
    const u = new Uint8Array(new SharedArrayBuffer(4));
    expect(() => bytesToHex(u)).toThrow(/SharedArrayBuffer/);
    expect(() => createByteReader(u, moduleFail)).toThrow(/mod: invalid at bytes/);
  });

  test('a resizable ArrayBuffer is rejected (can shift under a reader)', () => {
    const u = new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 }));
    expect(() => bytesToHex(u)).toThrow(/resizable ArrayBuffer/);
  });

  test('typedArrayByteLength rejects fancy storage — detached geometry is a lie (round 13)', () => {
    // Measured pre-gate: bytesEqual(detached [1,2,3], empty) returned TRUE
    // through this helper (both intrinsic lengths honestly read 0 — the
    // geometry is true and still a lie about a formerly-nonempty array).
    expect(() => typedArrayByteLength(detach(Uint8Array.from([1, 2, 3])))).toThrow(/detached ArrayBuffer/);
    expect(() => typedArrayByteLength(new Uint8Array(new SharedArrayBuffer(4)))).toThrow(/SharedArrayBuffer/);
    expect(() => typedArrayByteLength(new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 })))).toThrow(/resizable ArrayBuffer/);
    expect(typedArrayByteLength(Uint8Array.of(1, 2, 3))).toBe(3);
  });

  test('an ordinary fixed Uint8Array still works', () => {
    expect(bytesToHex(Uint8Array.from([0xde, 0xad]))).toBe('dead');
    const r = createByteReader(Uint8Array.of(1, 0, 0, 0), moduleFail);
    expect(r.u32('x')).toBe(1);
  });
});

describe('the fail-callback backstop — a returning fail can never resume the walk', () => {
  // Every decoder in the repo passes a throwing fail idiom, but the reader is
  // a public export usable with any callback. Pre-fix, a log-and-continue
  // callback let the cursor RESUME after notification: a negative byte count
  // rewound it, flag() returned a coerced boolean, expectEnd accepted
  // trailing bytes, finiteF64 returned the non-finite value. The reader now
  // throws its own backstop after fail returns — fail gets first say, the
  // abort is unconditional.
  const returningFail = () => { /* logs and returns */ };

  test('every failure path aborts even when fail returns', () => {
    const abort = /bytes: reader aborted at/;
    const r1 = createByteReader(new Uint8Array(2), returningFail);
    expect(() => r1.u32('trunc')).toThrow(abort);

    const r2 = createByteReader(new Uint8Array([7]), returningFail);
    expect(() => r2.flag('flag')).toThrow(abort);

    const r3 = createByteReader(new Uint8Array(8), returningFail);
    r3.u32('a');
    expect(() => r3.bytes(-4, 'neg')).toThrow(abort); // pre-fix: cursor REWOUND
    expect(r3.offset).toBe(4); // cursor unchanged by the aborted call

    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, Infinity, true);
    const r4 = createByteReader(new Uint8Array(view.buffer), returningFail);
    expect(() => r4.finiteF64('inf')).toThrow(abort);

    const r5 = createByteReader(new Uint8Array(4), returningFail);
    r5.u16('a');
    expect(() => r5.expectEnd('end')).toThrow(abort); // pre-fix: trailing accepted

    expect(() => createByteReader([1, 2], returningFail)).toThrow(abort);
  });

  test('a throwing fail still wins — the backstop never masks the module dialect', () => {
    const moduleFail = (path, value) => {
      throw new Error(`mod: invalid at ${path} (${String(value)})`);
    };
    const r = createByteReader(new Uint8Array(2), moduleFail);
    expect(() => r.u32('x')).toThrow(/^mod: invalid at x/);
  });
});
