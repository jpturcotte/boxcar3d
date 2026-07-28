// Shared EvolutionError assertion helpers: assert a synchronous throw or an
// asynchronous rejection carries the expected taxonomy code (and optionally
// matches a message pattern), handing the error back for context assertions.

import { expect } from 'vitest';
import { EvolutionError } from '../../src/sim/evolution-contract.js';

export function expectCode(fn, code, re) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  expect(threw, `expected a throw with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}

export async function expectCodeAsync(promiseFn, code, re) {
  let threw = null;
  try { await promiseFn(); } catch (e) { threw = e; }
  expect(threw, `expected a rejection with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}
