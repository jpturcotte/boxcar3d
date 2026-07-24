// The offline read seam: integrity evidence out of a persisted history, with
// NO physics — and refused outright when the artifact does not attest it.
//
// This is the capability fitness vector v3 exists to provide, so the central
// test is the negative one: before v3, "was this champion locomotion or solver
// divergence?" required re-simulating. The first test below answers it from
// bytes alone; the rest establish that it only ever answers from bytes a digest
// vouches for.
//
// The committed v3 interoperability artifact is the subject (produced by an
// encoder written from the format spec — tests/fixtures/evolution-v3-independent.md),
// so this file runs no engine at all.

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

import {
  HISTORY_OBSERVATIONS_SCHEMA, extractHistoryObservations,
} from '../scripts/history-observations.js';
import { EvolutionError } from '../src/sim/evolution-contract.js';
import {
  decodeGenerationPayload, decodeHistoryFraming,
} from '../src/sim/evolution-history.js';
import { hexToBytes } from '../src/sim/bytes.js';

const artifact = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v3-independent.base64', import.meta.url), 'utf8').trim(),
  'base64',
));
// Declared in tests/fixtures/evolution-v3-independent.md.
const HISTORY_DIGEST = 'aea30ef11d4d6c75adc5af1a88b9a1a408e5ab51962690a29b7ec81dffd7e79c';

// The v2 artifact, which this seam must refuse for its FORMAT rather than
// silently read under v3 semantics.
const staleArtifact = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v1-kimi-k3max.base64', import.meta.url), 'utf8').trim(),
  'base64',
));

/** First index at which `needle` occurs in `haystack`, or -1. */
function indexOfSubarray(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let k = 0; k < needle.length; k += 1) {
      if (haystack[i + k] !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}

async function expectCode(fn, code) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  expect(threw, `expected a rejection with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  return threw;
}

describe('extractHistoryObservations — evidence without physics', () => {
  test('a committed history yields every observation, and no engine is loaded', async () => {
    const result = await extractHistoryObservations(artifact());
    expect(result.schema).toBe(HISTORY_OBSERVATIONS_SCHEMA);
    expect(result.fitnessVectorVersion).toBe(3);
    expect(result.historyDigest).toBe(HISTORY_DIGEST);
    expect(result.generations).toHaveLength(1);

    const g = result.generations[0];
    expect(g.generationIndex).toBe(0);
    expect(g.executedSteps).toBe(60);
    expect(g.individuals).toHaveLength(4);

    for (const row of g.individuals) {
      const o = row.observations;
      // The five fields are PRESENT and typed — the whole point of v3.
      expect(Object.keys(o).slice().sort()).toEqual([
        'firstAlertStep', 'firstCatastrophicStep',
        'peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement',
      ]);
      for (const k of ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement']) {
        expect(typeof o[k], `${k} on individual ${row.individualId}`).toBe('number');
        expect(o[k] >= 0, `${k} must be non-negative`).toBe(true);
      }
      for (const k of ['firstAlertStep', 'firstCatastrophicStep']) {
        expect(o[k] === null || Number.isInteger(o[k]), `${k} is null or an integer`).toBe(true);
        // Gate B's bound, restated as a property of what came back.
        if (o[k] !== null) expect(o[k]).toBeLessThanOrEqual(g.executedSteps);
      }
      // Lineage provenance is joined by id, so a consumer can attribute an
      // observation to how the individual came to exist.
      expect(row.origin).toBe('initialized');
      expect(row.parentIndividualId).toBeNull();
    }
  });

  test('THE QUESTION v3 EXISTS TO ANSWER, asked of saved bytes only', async () => {
    // Under v2 this was unanswerable without re-running the physics: the
    // vector said 'ok' and stopped there. The distinction below — selectable
    // AND alert-bearing — is exactly the contamination class PR #26 had to
    // re-simulate to find, and is what the next PR will measure at scale.
    const result = await extractHistoryObservations(artifact());
    const rows = result.generations[0].individuals;
    const selectable = rows.filter((r) => r.valid && r.integrityStatus === 'ok');
    const alertBearing = rows.filter((r) => r.observations.firstAlertStep !== null);
    expect(selectable).toHaveLength(4);
    // This fixture is clean, and that is an OBSERVATION, not a threshold:
    // the assertion is that the question is answerable, not what the answer is.
    expect(alertBearing).toHaveLength(0);
    const peaks = rows.map((r) => r.observations.peakBodySpeed);
    expect(Math.max(...peaks)).toBeGreaterThan(0); // real measurements, not zeros
  });

  test('genotype digests are opt-in, and identify individuals where ids cannot', async () => {
    // Elitism gives a surviving individual a FRESH id each generation, so a
    // consumer counting distinct genomes needs the digest. Off by default
    // because it costs a serialization per member.
    const without = await extractHistoryObservations(artifact());
    expect(without.generations[0].individuals[0].genotypeDigest).toBeNull();
    const withDigests = await extractHistoryObservations(artifact(), { includeGenotypeDigest: true });
    const digests = withDigests.generations[0].individuals.map((r) => r.genotypeDigest);
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]+$/);
    expect(new Set(digests).size).toBe(4);
  });
});

describe('extractHistoryObservations — it reads only what a digest attests', () => {
  test('a tampered observation byte is REFUSED, not returned as evidence', async () => {
    // THE REASON THIS SEAM VERIFIES. Decoding the framing and pulling the
    // components out would happily hand back an observation the stored
    // component digest no longer covers — evidence nothing vouches for,
    // presented as if it did.
    // The byte is LOCATED, not guessed: a blind offset could land in another
    // component and pass for a different reason than the one claimed.
    const bytes = artifact();
    const framing = decodeHistoryFraming(bytes);
    const payload = decodeGenerationPayload(framing.generations[0].payloadBytes);
    const vector = payload.components.fitnessVector;
    // Member 0's peakBodySpeed: header 22 + member offset 14, low mantissa byte.
    const target = indexOfSubarray(bytes, vector) + 22 + 14;
    expect(target, 'the fitness-vector component must be locatable').toBeGreaterThan(0);
    const before = bytes[target];
    bytes[target] ^= 0xff;
    expect(bytes[target]).not.toBe(before);
    const err = await expectCode(() => extractHistoryObservations(bytes), 'componentDigestMismatch');
    expect(err.context.component).toBe('fitnessVector');
  });

  test('a truncated artifact is refused as malformed', async () => {
    await expectCode(() => extractHistoryObservations(artifact().slice(0, 2000)), 'malformedHistory');
  });

  test('a STALE v2 artifact is refused for its FORMAT, sharing resume\'s taxonomy', async () => {
    // Not `malformedHistory` — those bytes are perfectly well-formed under the
    // version they declare. The same code and the same message the production
    // resume path produces, because it is literally the same gate.
    const err = await expectCode(() => extractHistoryObservations(staleArtifact()), 'unsupportedVersion');
    expect(err.message).toMatch(/fitness vector fitnessVectorVersion is 2; this build implements 3/);
  });

  test('an externally-held expected digest detects a stale-but-valid artifact', async () => {
    // A valid OLDER save verifies perfectly — that is the point of the
    // embedded digest and the reason freshness can only come from outside.
    await extractHistoryObservations(artifact(), {
      expectedHistoryDigestBytes: hexToBytes(HISTORY_DIGEST),
    });
    const wrong = hexToBytes(HISTORY_DIGEST.replace(/^ae/, 'af'));
    await expectCode(
      () => extractHistoryObservations(artifact(), { expectedHistoryDigestBytes: wrong }),
      'staleOrWrongArtifact',
    );
  });

  test('the returned record is frozen all the way down', async () => {
    const result = await extractHistoryObservations(artifact());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.generations)).toBe(true);
    expect(Object.isFrozen(result.generations[0])).toBe(true);
    expect(Object.isFrozen(result.generations[0].individuals[0])).toBe(true);
    expect(Object.isFrozen(result.generations[0].individuals[0].observations)).toBe(true);
  });

  test('the caller cannot mutate the artifact while verification is in flight', async () => {
    // Copy-before-await, the resume seam's rule restated at this boundary.
    const bytes = artifact();
    const pending = extractHistoryObservations(bytes);
    bytes.fill(0); // would break every digest if the copy were not already taken
    const result = await pending;
    expect(result.historyDigest).toBe(HISTORY_DIGEST);
  });
});
