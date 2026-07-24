// tests/history-observations.test.js — verified extraction seam (PR #27, R6)
//
// Proves:
// 1. A committed v3 history yields observations with NO physics re-simulation
//    (the extraction itself performs zero stepping; the fixture run that
//    produces the artifact is test scaffolding, not the seam under test).
// 2. A tampered artifact is refused with the digest taxonomy, never read.
// 3. A stale v2 artifact is refused as unsupportedVersion (Gate A).
// 4. A wrong expectedHistoryDigestBytes is refused as staleOrWrongArtifact.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

// Issue 5 tooth: count physics evaluations. The fixture run that PRODUCES the
// artifact evaluates (test scaffolding); the extraction seam under test must
// evaluate ZERO — a future implementation that secretly calls resumeEvolutionRun
// (a replay) would increment this and fail.
vi.mock('../src/sim/population-evaluation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    evaluatePopulation: async (population, spec) => {
      if (globalThis.__extractProbe) globalThis.__extractProbe.evaluations += 1;
      return original.evaluatePopulation(population, spec);
    },
  };
});

// Issue 4 tooth: spy on the copy so an over-ceiling input can be proven NOT
// copied (the ceiling fires on the intrinsic length BEFORE any allocation of
// the artifact's own size).
vi.mock('../src/sim/bytes.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    copyOrdinaryBytes: vi.fn((...args) => original.copyOrdinaryBytes(...args)),
  };
});

const { copyOrdinaryBytes } = await import('../src/sim/bytes.js');
const { MAX_EVOLUTION_HISTORY_BYTES } = await import('../src/sim/evolution-replay.js');
const {
  COMPONENT_KINDS, assembleHistory, decodeGenerationPayload, decodeHistoryFraming,
  digestComponent, digestGeneration, digestHeader, encodeGenerationPayload,
} = await import('../src/sim/evolution-history.js');

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

/**
 * Rebuild a digest-consistent artifact after mutating one generation's decoded
 * components (mirrors the evolution-replay reforge helper). Every downstream
 * digest is recomputed, so verification (stages 3–7) passes and the defect must
 * be caught by a gate, not by the digest chain.
 */
async function reforge(bytes, mutateRecord) {
  const framing = decodeHistoryFraming(bytes);
  const headerBytes = framing.headerBytes;
  const headerDigestBytes = await digestHeader(headerBytes);
  const generations = [];
  let previous = headerDigestBytes;
  for (let i = 0; i < framing.generations.length; i += 1) {
    const payload = decodeGenerationPayload(framing.generations[i].payloadBytes);
    const record = {
      generationIndex: payload.generationIndex,
      terminalReason: payload.terminalReason,
      components: { ...payload.components },
    };
    mutateRecord(record, i);
    const digests = {};
    for (const kind of COMPONENT_KINDS) digests[kind] = await digestComponent(kind, record.components[kind]);
    const payloadBytes = encodeGenerationPayload(record, digests);
    const generationDigestBytes = await digestGeneration(previous, payloadBytes);
    previous = generationDigestBytes;
    generations.push({ payloadBytes, generationDigestBytes });
  }
  return (await assembleHistory({ headerBytes, headerDigestBytes, generations })).bytes;
}

describe('extractHistoryObservations — the verified extraction seam', () => {
  beforeEach(() => {
    globalThis.__extractProbe = { evaluations: 0 };
    copyOrdinaryBytes.mockClear();
  });

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

  // --------------------------------------------------------------------------
  // Issue 5: extraction performs ZERO evaluations and creates no physics world.
  // --------------------------------------------------------------------------
  test('extraction performs ZERO evaluations (probe stays 0; a replay would not)', async () => {
    const bytes = await runFixture();
    // The fixture run evaluated; reset so only the seam under test is measured.
    globalThis.__extractProbe.evaluations = 0;
    const result = await extractHistoryObservations(bytes);
    expect(result.generations.length).toBe(3);
    // A future implementation that secretly calls resumeEvolutionRun (a replay)
    // would re-evaluate every committed generation and fail this assertion.
    expect(globalThis.__extractProbe.evaluations).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Issue 1 (extraction path): a current-version but byte-malformed vector is
  // refused as malformedHistory through the SAME shared Gate B the resume path
  // uses — never a bare decoder exception.
  // --------------------------------------------------------------------------
  test('a malformed current-version vector is refused as malformedHistory (extraction path)', async () => {
    const bytes = await runFixture();
    // Corrupt member 0's alert-present flag byte to 5 (outside {0,1}); reforge
    // recomputes digests so the chain passes and only Gate B's decode catches it.
    const reforged = await reforge(bytes, (record) => {
      const fv = new Uint8Array(record.components.fitnessVector);
      fv[22 + 38] = 5; // member 0 firstAlertStepPresent = 5
      record.components.fitnessVector = fv;
    });
    globalThis.__extractProbe.evaluations = 0;
    let caught = null;
    try { await extractHistoryObservations(reforged); } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('malformedHistory');
    expect(caught.context.generationIndex).toBe(0);
    expect(caught.cause).toBeInstanceOf(Error); // decoder exception preserved
    expect(globalThis.__extractProbe.evaluations).toBe(0);
  });

  // The remaining malformed-vector classes, exercised through the SAME shared
  // Gate B on the extraction path (mirroring the resume-path teeth). Member 0
  // absolute offsets: fitness@28, peakBodySpeed@36, alertPresent@60, alertStep@61.
  function corruptFv(fvBytes, patches) {
    const copy = new Uint8Array(fvBytes);
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    for (const [offset, type, value] of patches) {
      if (type === 'u8') view.setUint8(offset, value);
      else if (type === 'f64') view.setFloat64(offset, value, true);
      else if (type === 'u32') view.setUint32(offset, value, true);
    }
    return copy;
  }

  async function expectExtractionMalformed(mutateRecord) {
    const bytes = await runFixture();
    const reforged = await reforge(bytes, mutateRecord);
    globalThis.__extractProbe.evaluations = 0;
    let caught = null;
    try { await extractHistoryObservations(reforged); } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('malformedHistory');
    expect(caught.context.generationIndex).toBe(0);
    expect(caught.cause).toBeInstanceOf(Error);
    expect(globalThis.__extractProbe.evaluations).toBe(0);
  }

  test('a count inconsistent with the vector length is malformedHistory (extraction path)', async () => {
    await expectExtractionMalformed((record) => {
      // Keep the 22-byte header (count says 6) but truncate the members.
      record.components.fitnessVector = record.components.fitnessVector.slice(0, 22 + 10);
    });
  });

  test('an illegal NaN fitness is malformedHistory (extraction path)', async () => {
    await expectExtractionMalformed((record) => {
      record.components.fitnessVector = corruptFv(record.components.fitnessVector, [
        [28, 'f64', Number.NaN], // member 0 fitness = NaN
      ]);
    });
  });

  test('an illegal NaN peak is malformedHistory (extraction path)', async () => {
    await expectExtractionMalformed((record) => {
      record.components.fitnessVector = corruptFv(record.components.fitnessVector, [
        [36, 'f64', Number.NaN], // member 0 peakBodySpeed = NaN
      ]);
    });
  });

  test('an absent onset flag with a nonzero payload is malformedHistory (extraction path)', async () => {
    await expectExtractionMalformed((record) => {
      record.components.fitnessVector = corruptFv(record.components.fitnessVector, [
        [60, 'u8', 0],  // firstAlertStepPresent = 0 (absent)
        [61, 'u32', 7], // but payload nonzero — noncanonical
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // Issue 4: an over-ceiling input is refused BEFORE the copy, as
  // resourceLimitExceeded, without digest verification or physics.
  // --------------------------------------------------------------------------
  test('an over-ceiling input is resourceLimitExceeded and is NOT copied first', async () => {
    const oversized = new Uint8Array(MAX_EVOLUTION_HISTORY_BYTES + 1);
    copyOrdinaryBytes.mockClear();
    let caught = null;
    let rejected = null;
    try {
      rejected = extractHistoryObservations(oversized);
      await rejected;
    } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('resourceLimitExceeded');
    expect(caught.context.limit).toBe(MAX_EVOLUTION_HISTORY_BYTES);
    // The ceiling fired on the intrinsic length BEFORE any copy of the
    // artifact's own size — the copy spy was never invoked.
    expect(copyOrdinaryBytes).not.toHaveBeenCalled();
  });

  test('the over-ceiling refusal happens in the synchronous prologue (no await needed to observe it)', async () => {
    const oversized = new Uint8Array(MAX_EVOLUTION_HISTORY_BYTES + 1);
    // The body runs synchronously up to the first await; the ceiling throws
    // there, so the returned promise is ALREADY rejected on the same tick.
    const promise = extractHistoryObservations(oversized);
    let state = 'pending';
    promise.then(() => { state = 'fulfilled'; }, () => { state = 'rejected'; });
    // Flush the microtask queue only. A synchronous-prologue throw rejects the
    // returned promise immediately, so its handler runs within microtasks; a
    // refusal that needed a real await (e.g. digest verification) would still
    // be 'pending' here.
    await Promise.resolve();
    await Promise.resolve();
    expect(state).toBe('rejected');
    await expect(promise).rejects.toMatchObject({ code: 'resourceLimitExceeded' });
  });
});
