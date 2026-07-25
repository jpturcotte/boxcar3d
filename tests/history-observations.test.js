// THE VERIFIED EXTRACTION SEAM, under test. Proves:
//   1. Observations come out of a committed, digest-verified artifact with
//      ZERO physics evaluations (the __replayProbe counter, as in the replay
//      suite — "no re-simulation" is observable, not structural prose).
//   2. `options.expectedHistoryDigestBytes` actually runs: a wrong expected
//      digest is `staleOrWrongArtifact`, never a silent extraction.
//   3. A stale v2 artifact (the independent Kimi fixture) is refused as
//      `unsupportedVersion` naming `fitnessVectorVersion`, before any decode
//      of its foreign layout.
//   4. Corruption fails with taxonomy codes (`historyDigestMismatch`,
//      `malformedHistory`); fancy storage is refused SYNCHRONOUSLY at the
//      type gate; a REAL over-ceiling Uint8Array is refused SYNCHRONOUSLY as
//      `resourceLimitExceeded` (the intrinsic length, checked BEFORE the
//      copy); and the copy-before-await prologue is proven DIRECTLY — the
//      caller's history buffer and expected-digest bytes are both mutated
//      after the call returns its promise but before it is awaited, and the
//      extraction still answers from the captured originals.

import {
  describe, test, expect, vi, beforeEach,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

// The same pass-through spy as tests/evolution-replay.test.js: the seam's
// contract is that extraction NEVER reaches a physics world, which is only
// observable as "zero evaluations happened".
vi.mock('../src/sim/population-evaluation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    evaluatePopulation: async (population, spec) => {
      if (globalThis.__replayProbe) globalThis.__replayProbe.evaluations += 1;
      return original.evaluatePopulation(population, spec);
    },
  };
});

const { extractHistoryObservations } = await import('../scripts/history-observations.js');
const { EvolutionError } = await import('../src/sim/evolution-contract.js');
const { MAX_EVOLUTION_HISTORY_BYTES } = await import('../src/sim/evolution-history.js');

const kimiFixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v1-kimi-k3max.base64', import.meta.url), 'utf8').trim(),
  'base64',
));
const interopFixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v3-interop.base64', import.meta.url), 'utf8').trim(),
  'base64',
));

beforeEach(() => {
  globalThis.__replayProbe = { evaluations: 0 };
});

async function expectCodeAsync(promiseFn, code, re) {
  let threw = null;
  try { await promiseFn(); } catch (e) { threw = e; }
  expect(threw, `expected a rejection with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}

function expectCodeSync(fn, code, re) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  expect(threw, `expected a synchronous throw with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}

describe('extractHistoryObservations — the verified read path', () => {
  test('extracts the five persisted observations from the committed v3 interop artifact with ZERO evaluations', async () => {
    const generations = await extractHistoryObservations(interopFixtureBytes());
    expect(Object.isFrozen(generations)).toBe(true);
    expect(generations.length).toBe(1);
    const g = generations[0];
    expect(Object.isFrozen(g)).toBe(true);
    expect(g.generationIndex).toBe(0);
    expect(g.executedSteps).toBe(60);
    // The engine's timestep is f32 (Rapier), persisted exactly.
    expect(g.effectiveDt).toBe(Math.fround(1 / 60));
    expect(g.individuals.map((m) => m.individualId)).toEqual([0, 1, 2, 3]);
    for (const row of g.individuals) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(row.integrityStatus).toBe('ok');
      // Real measured peaks, never zero-filled placeholders — and coherent
      // with the clean run they came from (Gate B already proved this; the
      // assertions here pin the DECODED shape offline consumers receive).
      for (const peak of [row.peakBodySpeed, row.peakSpeedDelta, row.peakStepDisplacement]) {
        expect(typeof peak).toBe('number');
        expect(Number.isFinite(peak)).toBe(true);
        expect(peak).toBeGreaterThan(0);
      }
      expect(row.firstAlertStep).toBe(null);
      expect(row.firstCatastrophicStep).toBe(null);
    }
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('the expected-identity option RUNS: the artifact\u2019s own digest passes, a flipped one is staleOrWrongArtifact', async () => {
    const fixture = interopFixtureBytes();
    // The trailer IS the whole-history digest — the correct expectation.
    const rightDigest = fixture.slice(-32);
    await extractHistoryObservations(fixture, { expectedHistoryDigestBytes: rightDigest });
    const wrongDigest = new Uint8Array(rightDigest);
    wrongDigest[0] ^= 0xff;
    await expectCodeAsync(
      () => extractHistoryObservations(fixture, { expectedHistoryDigestBytes: wrongDigest }),
      'staleOrWrongArtifact', /history digest is not the expected one/,
    );
    await expectCodeAsync(
      () => extractHistoryObservations(fixture, { expectedGenerationIndex: 7 }),
      'staleOrWrongArtifact', /final committed generation is 0, not the expected 7/,
    );
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('the stale v2 Kimi artifact is refused as unsupportedVersion naming fitnessVectorVersion', async () => {
    const err = await expectCodeAsync(
      () => extractHistoryObservations(kimiFixtureBytes()),
      'unsupportedVersion', /fitnessVectorVersion is 2; this build implements 3/,
    );
    expect(err.context.field).toBe('fitnessVectorVersion');
    expect(err.context.generationIndex).toBe(0);
    expect(err.context.stored).toBe(2);
    expect(err.context.current).toBe(3);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('corruption fails with taxonomy codes, never a bare decode error', async () => {
    const trailerFlipped = interopFixtureBytes();
    trailerFlipped[trailerFlipped.length - 1] ^= 0xff;
    await expectCodeAsync(
      () => extractHistoryObservations(trailerFlipped),
      'historyDigestMismatch', /whole-history digest does not match/,
    );
    await expectCodeAsync(
      () => extractHistoryObservations(interopFixtureBytes().slice(0, 100)),
      'malformedHistory',
    );
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('fancy storage and non-typed-array inputs are refused SYNCHRONOUSLY at the type gate', () => {
    expectCodeSync(
      () => extractHistoryObservations(new Uint8Array(new SharedArrayBuffer(64))),
      'malformedHistory',
    );
    // Not a real typed array: the intrinsic-length read itself refuses it —
    // this is the TYPE gate, not the ceiling (the byteLength property here is
    // caller-authored fiction, so it is never trusted enough to compare).
    const fake = { buffer: new ArrayBuffer(0), byteLength: MAX_EVOLUTION_HISTORY_BYTES + 1 };
    expectCodeSync(() => extractHistoryObservations(fake), 'malformedHistory');
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a REAL artifact one byte over MAX_EVOLUTION_HISTORY_BYTES is refused synchronously as resourceLimitExceeded, before the copy', () => {
    // A genuine same-realm Uint8Array whose INTRINSIC length is one over the
    // ceiling — this reaches the resource-limit branch itself, which the fake
    // object above never can (it dies at the type gate as malformedHistory).
    const oversized = new Uint8Array(MAX_EVOLUTION_HISTORY_BYTES + 1);
    const err = expectCodeSync(
      () => extractHistoryObservations(oversized),
      'resourceLimitExceeded', /exceeds MAX_EVOLUTION_HISTORY_BYTES/,
    );
    expect(err.context.byteLength).toBe(MAX_EVOLUTION_HISTORY_BYTES + 1);
    expect(err.context.limit).toBe(MAX_EVOLUTION_HISTORY_BYTES);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('the caller\u2019s history buffer is COPIED before the first await: zeroing it after the call changes nothing', async () => {
    const fixture = interopFixtureBytes();
    // The synchronous prologue copies; the promise exists but nothing has
    // been awaited yet when the caller destroys its own buffer.
    const promise = extractHistoryObservations(fixture);
    fixture.fill(0);
    const generations = await promise;
    expect(generations.length).toBe(1);
    expect(generations[0].generationIndex).toBe(0);
    expect(generations[0].executedSteps).toBe(60);
    expect(generations[0].individuals.map((m) => m.individualId)).toEqual([0, 1, 2, 3]);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('the expected-digest bytes are COPIED before the first await, in both directions', async () => {
    // Direction 1: a CORRECT expectation, vandalized after the call — the
    // captured original is used, so extraction still succeeds.
    const rightDigest = interopFixtureBytes().slice(-32);
    const okPromise = extractHistoryObservations(
      interopFixtureBytes(), { expectedHistoryDigestBytes: rightDigest },
    );
    rightDigest.fill(0);
    const generations = await okPromise;
    expect(generations.length).toBe(1);
    // Direction 2: a WRONG expectation, “repaired” after the call — the
    // captured original is used, so extraction still refuses as stale.
    const wrongDigest = interopFixtureBytes().slice(-32);
    wrongDigest[0] ^= 0xff;
    const fixture = interopFixtureBytes();
    const badPromise = extractHistoryObservations(
      fixture, { expectedHistoryDigestBytes: wrongDigest },
    );
    wrongDigest[0] ^= 0xff; // now byte-equal to the true digest — too late
    await expectCodeAsync(() => badPromise, 'staleOrWrongArtifact');
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });
});
