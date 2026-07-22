// The WebCrypto SHA-256 adapter — the ONE collision-resistant digest seam.
//
// Known-answer vectors are the FLOOR here, not the test. The plan is explicit
// that they are insufficient on their own, and the reason is this repo's whole
// byte-ownership history: a digest helper that produces correct answers for
// well-behaved inputs and silently digests a PREFIX (shadowed geometry), or
// ZERO BYTES (a detached buffer — measured on `fnv1aFold` at head in round 13),
// or a value the caller changed after the call returned (mutation across the
// await), is exactly as broken as one that computes the wrong hash — and only
// the second kind of test finds it.
//
// So: vectors, then the full hostile-storage battery, then the ownership
// properties that make `await sha256(x)` mean "the digest of x as it was when I
// called".

import { describe, test, expect } from 'vitest';
import { runInNewContext as vmRunInNewContext } from 'node:vm';

import { SHA256_DIGEST_BYTES, sha256 } from '../src/platform/sha256.js';
import { bytesToHex } from '../src/sim/bytes.js';

const utf8 = (s) => new TextEncoder().encode(s);
const hex = async (input) => bytesToHex(await sha256(input));

describe('known-answer vectors (FIPS 180-4)', () => {
  test.each([
    ['the empty input', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['the 448-bit message',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['the 896-bit message',
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
  ])('%s', async (_name, message, expected) => {
    expect(await hex(utf8(message))).toBe(expected);
  });

  test('a raw byte vector (not text) — 0x00..0xff', async () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    expect(await hex(bytes)).toBe('40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880');
  });

  test('a one-bit difference changes the digest completely (the point of the primitive)', async () => {
    const a = await hex(Uint8Array.of(0));
    const b = await hex(Uint8Array.of(1));
    expect(a).not.toBe(b);
    // Not a strict-avalanche claim, just that it is not a truncating checksum.
    let same = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) same += 1;
    expect(same).toBeLessThan(a.length / 2);
  });
});

describe('output ownership and geometry', () => {
  test('the digest is EXACTLY 32 bytes, and the constant says so', async () => {
    expect(SHA256_DIGEST_BYTES).toBe(32);
    const digest = await sha256(utf8('abc'));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(SHA256_DIGEST_BYTES);
    expect(digest.byteOffset).toBe(0);
    expect(digest.byteLength).toBe(digest.buffer.byteLength);
  });

  test('every call returns a FRESH array — no shared or cached buffer', async () => {
    const input = utf8('abc');
    const a = await sha256(input);
    const b = await sha256(input);
    expect(a).not.toBe(b);
    expect(a.buffer).not.toBe(b.buffer);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    // Mutating one result cannot affect the other.
    a[0] ^= 0xff;
    expect(bytesToHex(b)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('the returned digest does not alias the input buffer', async () => {
    const input = new Uint8Array(64);
    const digest = await sha256(input);
    expect(digest.buffer).not.toBe(input.buffer);
  });
});

describe('the input is COPIED before the first await', () => {
  test('mutating the caller buffer across the await cannot change the digest', async () => {
    // The load-bearing property: the promise is created from a copy taken in
    // the synchronous prologue. Without it, a caller (or a concurrent worker)
    // rewriting its buffer while the digest is in flight would produce a hash
    // of bytes that never existed at any single moment.
    const input = utf8('abc');
    const pending = sha256(input);
    input.fill(0xff); // happens BEFORE the digest resolves
    expect(await hex(utf8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(bytesToHex(await pending)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('a view over a larger buffer digests ONLY its own window', async () => {
    const backing = new Uint8Array(16).fill(0xaa);
    backing.set(utf8('abc'), 4);
    const window = new Uint8Array(backing.buffer, 4, 3);
    expect(bytesToHex(await sha256(window)))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('the hostile-storage battery — a synchronous refusal, not a rejected promise', () => {
  // `sha256` is deliberately NOT an `async function`: everything that can be
  // decided about the caller's bytes is decided before any await exists. A
  // rejected promise would still be "safe", but it would also mean a caller
  // that forgets to await gets an unhandled rejection instead of a throw, and
  // it would make this whole battery untestable as a synchronous property.
  const cases = [
    ['detached', () => { const u = new Uint8Array(8); u.buffer.transfer(); return u; }, /detached/],
    ['SharedArrayBuffer-backed', () => new Uint8Array(new SharedArrayBuffer(8)), /SharedArrayBuffer/],
    ['resizable', () => new Uint8Array(new ArrayBuffer(8, { maxByteLength: 16 })), /resizable/],
    ['cross-realm', () => vmRunInNewContext('new Uint8Array(8)'), /not an ordinary same-realm Uint8Array/],
  ];

  test.each(cases)('%s storage is refused synchronously', (_name, make, pattern) => {
    expect(() => sha256(make())).toThrow(pattern);
  });

  test('shadowed geometry cannot make the digest cover a PREFIX', async () => {
    // `length`/`byteLength` are inherited accessors; an own data property on a
    // genuine Uint8Array shadows them with ordinary defineProperty. The digest
    // must describe the real window regardless of what the array claims.
    const honest = utf8('abcdefgh');
    const liar = utf8('abcdefgh');
    Object.defineProperty(liar, 'length', { value: 3, configurable: true });
    Object.defineProperty(liar, 'byteLength', { value: 3, configurable: true });
    expect(bytesToHex(await sha256(liar))).toBe(bytesToHex(await sha256(honest)));
    // …and it is NOT the digest of the claimed 3-byte prefix.
    expect(bytesToHex(await sha256(liar))).not.toBe(bytesToHex(await sha256(utf8('abc'))));
  });

  test('a shadowed buffer/byteOffset cannot redirect the digest outside the window', async () => {
    const backing = new Uint8Array(32).fill(0x11);
    const view = new Uint8Array(backing.buffer, 8, 8);
    const control = bytesToHex(await sha256(view));
    const decoy = new Uint8Array(32).fill(0x99);
    Object.defineProperty(view, 'buffer', { value: decoy.buffer, configurable: true });
    Object.defineProperty(view, 'byteOffset', { value: 0, configurable: true });
    expect(bytesToHex(await sha256(view))).toBe(control);
  });

  test.each([
    ['a plain array', [1, 2, 3]],
    ['a string', 'abc'],
    ['null', null],
    ['undefined', undefined],
    ['an ArrayBuffer', new ArrayBuffer(8)],
    ['a DataView', new DataView(new ArrayBuffer(8))],
    ['an Int8Array', new Int8Array(8)],
  ])('%s is refused (only ordinary Uint8Array bytes are canonical)', (_name, value) => {
    expect(() => sha256(value)).toThrow(/not an ordinary same-realm Uint8Array/);
  });
});
