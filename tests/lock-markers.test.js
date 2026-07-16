// The structured lock-mismatch marker protocol (src/sim/lock-markers.js):
// the format/parse round-trip, strict field validation, malformed/duplicate
// detection, and the REAL captured message shapes from both reporters — the
// contract the population determinism gates (emit side) and the spike
// adjudicator (parse side) share, so the mutable fitness-vector lock digest
// never needs a second copy anywhere.

import { describe, test, expect } from 'vitest';
import {
  FITNESS_VECTOR_LOCK_MISMATCH,
  formatFitnessVectorLockMismatch,
  parseFitnessVectorLockMismatch,
} from '../src/sim/lock-markers.js';

describe('formatFitnessVectorLockMismatch', () => {
  test('formats the canonical marker', () => {
    expect(formatFitnessVectorLockMismatch('a6d04f75', 'ee605286'))
      .toBe('FITNESS_VECTOR_LOCK_MISMATCH expected=a6d04f75 actual=ee605286');
  });

  test.each([
    ['short hex', 'a6d04f7', 'ee605286'],
    ['long hex', 'a6d04f755', 'ee605286'],
    ['uppercase', 'A6D04F75', 'ee605286'],
    ['non-hex', 'zzzzzzzz', 'ee605286'],
    ['null expected', null, 'ee605286'],
    ['bad actual', 'a6d04f75', 'nope'],
    ['null actual', 'a6d04f75', null],
  ])('rejects %s loud', (_name, expected, actual) => {
    expect(() => formatFitnessVectorLockMismatch(expected, actual)).toThrow(/lock-markers: invalid/);
  });
});

describe('parseFitnessVectorLockMismatch', () => {
  test('round-trips the formatter, with trailing prose tolerated', () => {
    const marker = formatFitnessVectorLockMismatch('a6d04f75', 'ee605286');
    expect(parseFitnessVectorLockMismatch(marker))
      .toEqual({ present: true, malformed: false, expected: 'a6d04f75', actual: 'ee605286' });
    expect(parseFitnessVectorLockMismatch(`${marker} — engine or encoding changed; re-lock deliberately`))
      .toEqual({ present: true, malformed: false, expected: 'a6d04f75', actual: 'ee605286' });
  });

  test('the REAL Node reporter shape (captured verbatim from a flipped-lock run, 2026-07-16) parses', () => {
    const msg = 'AssertionError: FITNESS_VECTOR_LOCK_MISMATCH expected=ffffffff actual=a6d04f75'
      + ' — engine or encoding changed; re-lock deliberately via the null-digest workflow:'
      + " expected 'a6d04f75' to be 'ffffffff' // Object.is equality\n"
      + '    at C:\\w\\tests\\population-determinism.test.js:194:7\n'
      + '    at processTicksAndRejections (node:internal/process/task_queues:105:5)';
    expect(parseFitnessVectorLockMismatch(msg))
      .toEqual({ present: true, malformed: false, expected: 'ffffffff', actual: 'a6d04f75' });
  });

  test('the REAL Chromium reporter shape (stack URLs carry ?v=<hex8> chunk hashes) parses without confusion', () => {
    const msg = 'AssertionError: FITNESS_VECTOR_LOCK_MISMATCH expected=ffffffff actual=a6d04f75'
      + ' — engine or encoding changed; re-lock deliberately via the null-digest workflow:'
      + " expected 'a6d04f75' to be 'ffffffff' // Object.is equality\n"
      + '    at http://localhost:63315/@fs/w/tests/browser/population-determinism.test.js?import&browserv=1784229103509:48:7\n'
      + '    at async http://localhost:63315/node_modules/@vitest/runner/dist/chunk-hooks.js?v=bcab72ab:752:20';
    expect(parseFitnessVectorLockMismatch(msg))
      .toEqual({ present: true, malformed: false, expected: 'ffffffff', actual: 'a6d04f75' });
  });

  test('absent token: present false (the old .toBe diff carries digests but no token)', () => {
    const r = parseFitnessVectorLockMismatch("expected 'ee605286' to be 'a6d04f75' // Object.is equality");
    expect(r.present).toBe(false);
    expect(r.expected).toBeNull();
  });

  test('a token without well-formed fields is malformed, never invisible', () => {
    for (const text of [
      FITNESS_VECTOR_LOCK_MISMATCH,
      `${FITNESS_VECTOR_LOCK_MISMATCH} expected=zzz actual=a6d04f75`,
      `${FITNESS_VECTOR_LOCK_MISMATCH} expected=a6d04f75`,
      `${FITNESS_VECTOR_LOCK_MISMATCH} actual=a6d04f75 expected=ee605286`, // wrong field order
    ]) {
      const r = parseFitnessVectorLockMismatch(text);
      expect(r.present, text).toBe(true);
      expect(r.malformed, text).toBe(true);
      expect(r.expected).toBeNull();
    }
  });

  test('identical duplicates tolerated; contradictory duplicates malformed', () => {
    const one = formatFitnessVectorLockMismatch('a6d04f75', 'ee605286');
    expect(parseFitnessVectorLockMismatch(`${one}\n${one}`))
      .toEqual({ present: true, malformed: false, expected: 'a6d04f75', actual: 'ee605286' });
    const other = formatFitnessVectorLockMismatch('a6d04f75', 'ffff0000');
    const r = parseFitnessVectorLockMismatch(`${one}\n${other}`);
    expect(r.malformed).toBe(true);
    expect(r.reason).toMatch(/contradictory/);
  });

  test('non-string input fails loud', () => {
    expect(() => parseFitnessVectorLockMismatch(null)).toThrow(/lock-markers: invalid/);
    expect(() => parseFitnessVectorLockMismatch(42)).toThrow(/lock-markers: invalid/);
  });
});
