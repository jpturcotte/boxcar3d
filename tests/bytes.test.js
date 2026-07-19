// Pure tests for src/sim/bytes.js — the shared strict LE reader and the
// canonical lowercase-hex representation. No Rapier, no physics.
//
// The two contracts under test:
//   * createByteReader — bounds-checked cursor reads where EVERY malformed
//     condition surfaces through the CALLER's fail callback (the owning
//     module's idiom, never this module's voice), with cursor state exposed
//     as getters on a frozen object;
//   * bytesToHex/hexToBytes — the JSON-safe lossless byte representation:
//     canonical LOWERCASE only (uppercase is rejected, never lowercased —
//     exactly one string denotes one byte string), exact inverses.

import { describe, test, expect } from 'vitest';
import { bytesToHex, createByteReader, hexToBytes } from '../src/sim/bytes.js';

// A caller-idiom fail stand-in, exactly the shape the codec modules pass.
const FAIL_PREFIX = 'test-module: invalid encoded thing';
const fail = (path, value) => {
  throw new Error(`${FAIL_PREFIX} at ${path} (${String(value)})`);
};

const SAMPLE = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0xff, 0x00]);

describe('createByteReader', () => {
  test('reads every width little-endian and tracks offset/remaining via getters', () => {
    const r = createByteReader(SAMPLE, fail);
    expect(Object.isFrozen(r)).toBe(true);
    expect(r.offset).toBe(0);
    expect(r.remaining).toBe(10);
    expect(r.u8('a')).toBe(0x01);
    expect(r.u16('b')).toBe(0x0302); // LE
    expect(r.u32('c')).toBe(0x07060504);
    expect(r.offset).toBe(7);
    expect(r.remaining).toBe(3);
    expect(() => r.u32('d')).toThrow(/truncated at byte 7 \(need 4, have 3\)/);
    expect(r.remaining).toBe(3); // a failed read does not advance the cursor
  });

  test('f64 round-trips raw bits; finiteF64 rejects NaN and ±Infinity through the caller fail', () => {
    const view = new DataView(new ArrayBuffer(8 * 4));
    view.setFloat64(0, -0, true);
    view.setFloat64(8, 8.419723510742188, true);
    view.setFloat64(16, NaN, true);
    view.setFloat64(24, Infinity, true);
    const bytes = new Uint8Array(view.buffer);
    const r = createByteReader(bytes, fail);
    expect(Object.is(r.f64('v0'), -0)).toBe(true); // raw read preserves −0
    expect(Object.is(r.f64('v1'), 8.419723510742188)).toBe(true);
    expect(Number.isNaN(r.f64('nan-raw'))).toBe(true); // f64 does NOT gate
    expect(() => r.finiteF64('inf')).toThrow(new RegExp(`^${FAIL_PREFIX} at inf `));
    const r2 = createByteReader(bytes.subarray(16), fail);
    expect(() => r2.finiteF64('nan')).toThrow(/at nan /);
  });

  test('flag is strict 0/1 -> boolean; any other byte fails', () => {
    const r = createByteReader(Uint8Array.from([0, 1, 2]), fail);
    expect(r.flag('f0')).toBe(false);
    expect(r.flag('f1')).toBe(true);
    expect(() => r.flag('f2')).toThrow(/at f2 \(2\)/);
  });

  test('truncation at every width reports offset, need, and have', () => {
    for (const [method, width] of [['u8', 1], ['u16', 2], ['u32', 4], ['f64', 8]]) {
      const r = createByteReader(new Uint8Array(width - 1), fail);
      expect(() => r[method]('field'), method).toThrow(
        new RegExp(`truncated at byte 0 \\(need ${width}, have ${width - 1}\\)`),
      );
    }
  });

  test('bytes(n) takes a subarray and advances; a short take fails', () => {
    const r = createByteReader(SAMPLE, fail);
    const taken = r.bytes(3, 'payload');
    expect([...taken]).toEqual([1, 2, 3]);
    expect(r.offset).toBe(3);
    expect(() => r.bytes(8, 'payload')).toThrow(/truncated at byte 3 \(need 8, have 7\)/);
    expect(() => r.bytes(-1, 'payload')).toThrow(/at payload \(-1\)/);
    expect(() => r.bytes(1.5, 'payload')).toThrow(/at payload \(1.5\)/);
  });

  test('expectEnd passes at the exact end and rejects trailing bytes with count + offset', () => {
    const r = createByteReader(SAMPLE, fail);
    r.bytes(10, 'all');
    expect(() => r.expectEnd('end')).not.toThrow();
    const r2 = createByteReader(SAMPLE, fail);
    r2.bytes(9, 'almost');
    expect(() => r2.expectEnd('end')).toThrow(/1 trailing byte\(s\) at byte 9/);
  });

  test('subarray safety: a nonzero byteOffset view reads its own window', () => {
    const backing = Uint8Array.from([0xaa, 0xbb, ...SAMPLE, 0xcc]);
    const window = backing.subarray(2, 12);
    const r = createByteReader(window, fail);
    expect(r.u32('first')).toBe(0x04030201);
    expect(r.offset).toBe(4); // window-relative, never backing-relative
    r.bytes(6, 'rest');
    expect(() => r.expectEnd('end')).not.toThrow();
  });

  test('fail-callback plumbing: every error speaks the CALLER\'s idiom, and a missing callback is a plain TypeError', () => {
    const r = createByteReader(new Uint8Array(0), fail);
    expect(() => r.u8('x')).toThrow(new RegExp(`^${FAIL_PREFIX} at x `));
    expect(() => createByteReader('not bytes', fail)).toThrow(new RegExp(`^${FAIL_PREFIX} at bytes `));
    expect(() => createByteReader(SAMPLE)).toThrow(TypeError);
    expect(() => createByteReader(SAMPLE, 'nope')).toThrow(TypeError);
  });
});

describe('bytesToHex / hexToBytes', () => {
  test('the empty byte string is the empty string, both ways', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  test('all 256 byte values -> a 512-char lowercase string (spot literals)', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const hex = bytesToHex(all);
    expect(hex.length).toBe(512);
    expect(hex.slice(0, 8)).toBe('00010203');
    expect(hex.slice(2 * 0x0a, 2 * 0x0a + 2)).toBe('0a'); // lowercase a-f
    expect(hex.slice(2 * 0xff, 2 * 0xff + 2)).toBe('ff');
    expect(hex).toBe(hex.toLowerCase());
    expect(hexToBytes(hex)).toEqual(all);
  });

  test('JSON stringify/parse round trip (hex is THE JSON-safe representation)', () => {
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);
    const envelope = { schema: 'boxcar3d.example/1', hex: bytesToHex(bytes) };
    const restored = hexToBytes(JSON.parse(JSON.stringify(envelope)).hex);
    expect(restored).toEqual(bytes);
  });

  test('exact recovery both directions', () => {
    const s = '0123456789abcdef'.repeat(4);
    expect(bytesToHex(hexToBytes(s))).toBe(s);
    const bytes = Uint8Array.from([9, 8, 7, 6]);
    expect([...hexToBytes(bytesToHex(bytes))]).toEqual([...bytes]);
  });

  test('malformed hex throws: odd length, UPPERCASE (rejected, never lowercased), non-hex, prefixes, whitespace, non-string', () => {
    for (const bad of ['a', 'abc', 'AB', 'zz', '0x1f', ' 1f', '1f ', '1 f', 42, null, undefined]) {
      expect(() => hexToBytes(bad), String(bad)).toThrow(/bytes: invalid canonical hex/);
    }
    expect(bytesToHex(hexToBytes('ab'))).toBe('ab'); // lowercase survives; 'AB' does not
  });

  test('bytesToHex requires a Uint8Array', () => {
    for (const bad of ['abcd', [1, 2], 42, null]) {
      expect(() => bytesToHex(bad), String(bad)).toThrow(TypeError);
    }
  });
});
