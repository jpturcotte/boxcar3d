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
//      `malformedHistory`), and fancy storage / over-ceiling artifacts are
//      refused SYNCHRONOUSLY — the copy-before-await prologue is real.

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

  test('fancy storage and over-ceiling artifacts are refused SYNCHRONOUSLY (the copy-before-await prologue)', () => {
    expectCodeSync(
      () => extractHistoryObservations(new Uint8Array(new SharedArrayBuffer(64))),
      'malformedHistory',
    );
    const oversized = { buffer: new ArrayBuffer(0), byteLength: MAX_EVOLUTION_HISTORY_BYTES + 1 };
    // Not a real Uint8Array — the intrinsic length read itself must refuse it.
    expectCodeSync(() => extractHistoryObservations(oversized), 'malformedHistory');
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });
});
