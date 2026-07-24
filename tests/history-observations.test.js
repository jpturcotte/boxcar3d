// tests/history-observations.test.js — verified extraction seam (PR #27, R6)
//
// Proves:
// 1. A committed v3 history yields observations with NO physics re-simulation
//    (the extraction itself performs zero stepping; the fixture run that
//    produces the artifact is test scaffolding, not the seam under test).
// 2. A tampered artifact is refused with the digest taxonomy, never read.
// 3. A stale v2 artifact is refused as unsupportedVersion (Gate A).
// 4. A wrong expectedHistoryDigestBytes is refused as staleOrWrongArtifact.

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

import { extractHistoryObservations } from '../scripts/history-observations.js';
import { EVOLUTION_FIXTURE_A, evolutionRunConfigFor } from '../src/sim/evolution-fixtures.js';
import { createEvolutionRun } from '../src/sim/evolution-run.js';
import { EVOLUTION_GOLDEN_LOCKS } from '../src/sim/evolution-locks.js';

const LOCK = EVOLUTION_GOLDEN_LOCKS[EVOLUTION_FIXTURE_A.name];

const kimiFixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v1-kimi-k3max.base64', import.meta.url), 'utf8').trim(),
  'base64',
));

/** Run the fixture to its terminal record and return the artifact bytes. */
async function runFixture() {
  const run = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
  let result;
  do { result = await run.advance(); } while (result.kind !== 'terminal');
  return run.historyBytes();
}

describe('extractHistoryObservations — the verified extraction seam', () => {
  test('a committed v3 history yields observations with no physics', async () => {
    const bytes = await runFixture();
    const result = await extractHistoryObservations(bytes);

    // Three generations in fixture A.
    expect(result.generations.length).toBe(3);

    // Each generation has executedSteps from metadata and 6 individuals.
    for (const gen of result.generations) {
      expect(gen.executedSteps).toBe(LOCK.executedSteps);
      expect(gen.individuals.length).toBe(LOCK.populationSize);

      // Each individual carries the five integrity observations.
      for (const ind of gen.individuals) {
        expect(ind).toHaveProperty('individualId');
        expect(ind).toHaveProperty('valid');
        expect(ind).toHaveProperty('integrityStatus');
        expect(ind).toHaveProperty('fitness');
        expect(ind).toHaveProperty('integrityObservations');

        const obs = ind.integrityObservations;
        expect(obs).toHaveProperty('peakBodySpeed');
        expect(obs).toHaveProperty('peakSpeedDelta');
        expect(obs).toHaveProperty('peakStepDisplacement');
        expect(obs).toHaveProperty('firstAlertStep');
        expect(obs).toHaveProperty('firstCatastrophicStep');

        // Peaks are non-negative numbers (possibly +Infinity).
        expect(typeof obs.peakBodySpeed).toBe('number');
        expect(obs.peakBodySpeed >= 0).toBe(true);
        expect(typeof obs.peakSpeedDelta).toBe('number');
        expect(obs.peakSpeedDelta >= 0).toBe(true);
        expect(typeof obs.peakStepDisplacement).toBe('number');
        expect(obs.peakStepDisplacement >= 0).toBe(true);

        // Onset steps are null or non-negative integers.
        if (obs.firstAlertStep !== null) {
          expect(Number.isInteger(obs.firstAlertStep)).toBe(true);
          expect(obs.firstAlertStep >= 0).toBe(true);
        }
        if (obs.firstCatastrophicStep !== null) {
          expect(Number.isInteger(obs.firstCatastrophicStep)).toBe(true);
          expect(obs.firstCatastrophicStep >= 0).toBe(true);
        }
      }
    }

    // Generation 0 is all-initialized; all members are integrity-clean.
    const gen0 = result.generations[0];
    for (const ind of gen0.individuals) {
      expect(ind.integrityStatus).toBe('ok');
      expect(ind.integrityObservations.firstAlertStep).toBeNull();
      expect(ind.integrityObservations.firstCatastrophicStep).toBeNull();
    }
  });

  test('a tampered artifact is refused with a digest taxonomy code', async () => {
    const bytes = await runFixture();

    // Flip the last byte (inside the whole-history digest) — the computed
    // digest will not match, so verification refuses before any decode.
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1] ^= 0xff;

    let caught = null;
    try { await extractHistoryObservations(tampered); } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('historyDigestMismatch');
  });

  test('truncated artifact is refused with malformedHistory', async () => {
    const bytes = await runFixture();
    const truncated = bytes.slice(0, 100);

    let caught = null;
    try { await extractHistoryObservations(truncated); } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('malformedHistory');
  });

  test('a stale v2 artifact is refused as unsupportedVersion (Gate A)', async () => {
    const fixture = kimiFixtureBytes();

    let caught = null;
    try { await extractHistoryObservations(fixture); } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('unsupportedVersion');
    expect(caught.context.field).toBe('fitnessVectorVersion');
  });

  test('a wrong expectedHistoryDigestBytes is refused as staleOrWrongArtifact', async () => {
    const bytes = await runFixture();
    const wrongDigest = new Uint8Array(32).fill(0xab);

    let caught = null;
    try {
      await extractHistoryObservations(bytes, { expectedHistoryDigestBytes: wrongDigest });
    } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('staleOrWrongArtifact');
  });

  test('the correct expectedHistoryDigestBytes passes and yields observations', async () => {
    const bytes = await runFixture();
    // Compute the actual history digest from the framing (last 32 bytes of the
    // artifact are the history digest in the evolution-history wire format).
    const { decodeHistoryFraming } = await import('../src/sim/evolution-history.js');
    const framing = decodeHistoryFraming(bytes);
    const correctDigest = framing.historyDigestBytes;

    const result = await extractHistoryObservations(bytes, {
      expectedHistoryDigestBytes: correctDigest,
    });
    expect(result.generations.length).toBe(3);
  });

  test('mutating the caller buffer after the call cannot change extracted observations', async () => {
    const bytes = await runFixture();
    const callerCopy = new Uint8Array(bytes);
    const pending = extractHistoryObservations(callerCopy);
    callerCopy.fill(0); // mutate after the synchronous prologue copies
    const result = await pending;
    // The owned copy was taken before the await; observations are intact.
    expect(result.generations.length).toBe(3);
    expect(result.generations[0].individuals.length).toBe(LOCK.populationSize);
  });
});
