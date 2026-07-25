// THE VERIFIED HISTORY-OBSERVATION SEAM (scripts/history-observations.js):
// a committed v3 history yields its integrity observations with NO physics,
// and a tampered or semantically incoherent artifact is refused with the
// PRODUCTION error taxonomy — never read as evidence the digests do not
// attest. Fixture: evolution-a-small-flat (seeds 20260742 / 20260743).

import {
  describe, test, expect, vi, beforeEach,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

// The physics-counting spy (the evolution-replay precedent): extraction must
// never evaluate, which is only observable as "zero evaluations happened".
vi.mock('../src/sim/population-evaluation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    evaluatePopulation: async (population, spec) => {
      if (globalThis.__observationsProbe) globalThis.__observationsProbe.evaluations += 1;
      return original.evaluatePopulation(population, spec);
    },
  };
});

const { createEvolutionRun } = await import('../src/sim/evolution-run.js');
const { EVOLUTION_FIXTURE_A, evolutionRunConfigFor } = await import('../src/sim/evolution-fixtures.js');
const { EVOLUTION_GOLDEN_LOCKS } = await import('../src/sim/evolution-locks.js');
const { EvolutionError } = await import('../src/sim/evolution-contract.js');
const { extractHistoryObservations } = await import('../scripts/history-observations.js');
const {
  COMPONENT_KINDS, SHA256_DIGEST_BYTES, assembleHistory, decodeGenerationPayload,
  decodeHistoryFraming, digestComponent, digestGeneration, encodeGenerationPayload,
} = await import('../src/sim/evolution-history.js');
const { deserializeFitnessVector, serializeFitnessVector } = await import('../src/sim/population-evaluation.js');
const { bytesToHex } = await import('../src/sim/bytes.js');
const { sha256 } = await import('../src/platform/sha256.js');

const LOCK = EVOLUTION_GOLDEN_LOCKS[EVOLUTION_FIXTURE_A.name];

const kimiFixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v1-kimi-k3max.base64', import.meta.url), 'utf8').trim(),
  'base64',
));

beforeEach(() => { globalThis.__observationsProbe = { evaluations: 0 }; });

async function fixtureArtifact() {
  const run = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
  let result;
  do { result = await run.advance(); } while (result.kind !== 'terminal');
  return run.historyBytes();
}

/** Rebuild a self-consistent artifact after mutating generation 0's record. */
async function reforge(bytes, mutateRecord) {
  const framing = decodeHistoryFraming(bytes);
  const generations = [];
  let previous = framing.headerDigestBytes;
  for (let i = 0; i < framing.generations.length; i += 1) {
    const payload = decodeGenerationPayload(framing.generations[i].payloadBytes);
    const record = {
      generationIndex: payload.generationIndex,
      terminalReason: payload.terminalReason,
      components: { ...payload.components },
    };
    if (i === 0) mutateRecord(record);
    const digests = {};
    for (const kind of COMPONENT_KINDS) digests[kind] = await digestComponent(kind, record.components[kind]);
    const payloadBytes = encodeGenerationPayload(record, digests);
    const generationDigestBytes = await digestGeneration(previous, payloadBytes);
    previous = generationDigestBytes;
    generations.push({ payloadBytes, generationDigestBytes });
  }
  return (await assembleHistory({
    headerBytes: framing.headerBytes,
    headerDigestBytes: framing.headerDigestBytes,
    generations,
  })).bytes;
}

async function expectCodeAsync(promiseFn, code, re) {
  let threw = null;
  try { await promiseFn(); } catch (e) { threw = e; }
  expect(threw, `expected a rejection with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}

describe('extractHistoryObservations', () => {
  test('invalid history-byte storage uses the production malformedHistory taxonomy', async () => {
    const err = await expectCodeAsync(
      () => extractHistoryObservations({}), 'malformedHistory', /historyBytes/,
    );
    expect(err.context).toMatchObject({ path: 'historyBytes' });
  });

  test('a committed v3 history yields its observations with NO physics', async () => {
    const artifact = await fixtureArtifact();
    globalThis.__observationsProbe.evaluations = 0;
    const extracted = await extractHistoryObservations(artifact);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);

    expect(bytesToHex(extracted.historyDigestBytes)).toBe(LOCK.historyDigest);
    expect(Object.isFrozen(extracted)).toBe(true);
    expect(Object.isFrozen(extracted.generations)).toBe(true);
    expect(extracted.generations).toHaveLength(3);

    // Row-for-row equivalence with a direct (pure) decode of the same
    // artifact — the seam adds verification, never a second interpretation.
    const framing = decodeHistoryFraming(artifact);
    for (let i = 0; i < framing.generations.length; i += 1) {
      const payload = decodeGenerationPayload(framing.generations[i].payloadBytes);
      const vector = deserializeFitnessVector(payload.components.fitnessVector);
      const generation = extracted.generations[i];
      expect(generation.generationIndex).toBe(i);
      expect(generation.terminalReason).toBe(payload.terminalReason);
      expect(generation.executedSteps).toBe(45);
      expect(generation.individuals).toEqual(vector.individuals);
      expect(Object.isFrozen(generation.individuals[0].integrityObservations)).toBe(true);
    }
    // …and the rows really are the v3 observations (fixture A is clean:
    // measured finite peaks, both onset steps null on every row).
    const row = extracted.generations[0].individuals[0];
    expect(row.integrityObservations.peakBodySpeed).toBeGreaterThan(0);
    expect(Number.isFinite(row.integrityObservations.peakBodySpeed)).toBe(true);
    expect(row.integrityObservations.firstAlertStep).toBeNull();
    expect(row.integrityObservations.firstCatastrophicStep).toBeNull();
  });

  test('alert-bearing rows yield their onset steps — still with no physics', async () => {
    const artifact = await fixtureArtifact();
    // A legal Gate-B-coherent alert row: peak over the alert threshold and a
    // matching firstAlertStep inside the executed captures.
    const broken = await reforge(artifact, (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      const individuals = decoded.individuals.map((row, i) => (i === 0 ? {
        ...row,
        integrityObservations: {
          ...row.integrityObservations,
          peakBodySpeed: 100,
          firstAlertStep: 4,
        },
      } : row));
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: decoded.populationSnapshotDigestState,
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals,
      });
    });
    globalThis.__observationsProbe.evaluations = 0;
    const extracted = await extractHistoryObservations(broken);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
    expect(extracted.generations[0].individuals[0].integrityObservations.firstAlertStep).toBe(4);
    expect(extracted.generations[0].individuals[0].integrityObservations.peakBodySpeed).toBe(100);
  });

  test('a flipped observation byte is REFUSED (componentDigestMismatch), never read as evidence', async () => {
    const artifact = await fixtureArtifact();
    const framing = decodeHistoryFraming(artifact);
    const payload = decodeGenerationPayload(framing.generations[0].payloadBytes);
    const payloadStart = 8 + 2 + 4 + framing.headerBytes.length + SHA256_DIGEST_BYTES + 4 + 4;
    const vectorStart = payloadStart + 2 + 4 + 1
      + 4 + payload.components.population.length + SHA256_DIGEST_BYTES
      + 4 + payload.components.evaluationMetadata.length + SHA256_DIGEST_BYTES
      + 4;
    const tampered = new Uint8Array(artifact);
    tampered[vectorStart + 22 + 14] ^= 0xff; // member 0's peakBodySpeed
    const err = await expectCodeAsync(() => extractHistoryObservations(tampered), 'componentDigestMismatch');
    expect(err.context.component).toBe('fitnessVector');
  });

  test('a current-format artifact whose steps contradict its metadata is REFUSED (malformedHistory)', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const v = new Uint8Array(record.components.fitnessVector);
      const view = new DataView(v.buffer);
      view.setUint8(22 + 38, 1);
      view.setUint32(22 + 39, 4000000000, true); // firstAlertStep beyond executedSteps
      record.components.fitnessVector = v;
    });
    await expectCodeAsync(() => extractHistoryObservations(broken), 'malformedHistory', /exceeds executedSteps/);
  });

  test.each([
    ['alert', (row) => ({
      ...row,
      integrityObservations: {
        ...row.integrityObservations,
        peakBodySpeed: 0,
        peakSpeedDelta: 100,
        peakStepDisplacement: 0,
        firstAlertStep: 0,
      },
    }), 'captureZeroAlertCause'],
    ['catastrophic', (row) => ({
      ...row,
      valid: false,
      integrityStatus: 'numericalDivergence',
      fitness: 0,
      integrityObservations: {
        peakBodySpeed: 30,
        peakSpeedDelta: 0,
        peakStepDisplacement: 20,
        firstAlertStep: 0,
        firstCatastrophicStep: 0,
      },
    }), 'captureZeroCatastrophicCause'],
  ])('a forged capture-zero %s onset without the required body-speed crossing is REFUSED before physics', async (_band, rewrite, rule) => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      const individuals = decoded.individuals.map((row, i) => (i === 0 ? rewrite(row) : row));
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: decoded.populationSnapshotDigestState,
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals,
      });
    });
    globalThis.__observationsProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /capture 0.*body-speed/i,
    );
    expect(err.context).toMatchObject({ generationIndex: 0, individualId: 0, rule });
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('a vector larger than the capped header population is REFUSED before row materialization or physics', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      const last = decoded.individuals.at(-1);
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: decoded.populationSnapshotDigestState,
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals: [...decoded.individuals, { ...last, individualId: last.individualId + 1 }],
      });
    });
    globalThis.__observationsProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /header populationSize 6/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      rule: 'fitnessVectorPopulationSizeOverflow',
      populationSize: 6,
    });
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('the stale v2 Kimi artifact is REFUSED (unsupportedVersion) — the seam shares Gate A', async () => {
    const err = await expectCodeAsync(
      () => extractHistoryObservations(kimiFixtureBytes()), 'unsupportedVersion', /fitnessVectorVersion/,
    );
    expect(err.context).toMatchObject({ field: 'fitnessVectorVersion', stored: 2, current: 3 });
  });

  test('a stale evaluationMetadataVersion is REFUSED as unsupportedVersion — the same taxonomy as resume', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const m = new Uint8Array(record.components.evaluationMetadata);
      new DataView(m.buffer).setUint16(0, 0, true); // evaluationMetadataVersion 1 -> 0
      record.components.evaluationMetadata = m;
    });
    const err = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'unsupportedVersion', /evaluationMetadataVersion/,
    );
    expect(err.context).toMatchObject({ field: 'evaluationMetadataVersion', generationIndex: 0, stored: 0, current: 1 });
  });

  test('a truncated metadata component is REFUSED as malformedHistory — the same taxonomy as resume', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      record.components.evaluationMetadata = record.components.evaluationMetadata.slice(0, 1);
    });
    await expectCodeAsync(() => extractHistoryObservations(broken), 'malformedHistory', /malformed/);
  });

  test('the expected-digest freshness contract matches resume semantics', async () => {
    const artifact = await fixtureArtifact();
    const framing = decodeHistoryFraming(artifact);
    // A matching expectation accepts and yields the same rows.
    const extracted = await extractHistoryObservations(artifact, {
      expectedHistoryDigestBytes: framing.historyDigestBytes,
    });
    expect(extracted.generations).toHaveLength(3);
    // A non-matching one is staleness, never corruption or format.
    const wrongDigest = await sha256(Uint8Array.of(0));
    await expectCodeAsync(
      () => extractHistoryObservations(artifact, { expectedHistoryDigestBytes: wrongDigest }),
      'staleOrWrongArtifact',
    );
    // Malformed options are configuration errors, in the same taxonomy.
    await expectCodeAsync(
      () => extractHistoryObservations(artifact, { expectedHistoryDigestBytes: new Uint8Array(16) }),
      'invalidConfig', /exactly 32 bytes/,
    );
    await expectCodeAsync(
      () => extractHistoryObservations(artifact, { nope: 1 }),
      'invalidConfig', /not a known key/,
    );
  });

  test('the options intake mirrors resume exactly: null means absent, plain object, one read', async () => {
    const artifact = await fixtureArtifact();
    // null/undefined are ABSENT (resume's captureExpectedIdentity semantics),
    // not errors; absent means no freshness expectation.
    expect((await extractHistoryObservations(artifact, null)).generations).toHaveLength(3);
    expect((await extractHistoryObservations(artifact, undefined)).generations).toHaveLength(3);
    expect((await extractHistoryObservations(artifact)).generations).toHaveLength(3);
    // A non-plain prototype is refused, exactly like resume.
    await expectCodeAsync(
      () => extractHistoryObservations(artifact, Object.create({ expectedHistoryDigestBytes: undefined })),
      'invalidConfig', /plain object/,
    );
    // A non-enumerable own key is refused — a presence gate must enumerate the
    // way its consumer reads.
    const hidden = {};
    Object.defineProperty(hidden, 'expectedGenerationIndex', { value: 0, enumerable: false });
    await expectCodeAsync(
      () => extractHistoryObservations(artifact, hidden),
      'invalidConfig', /non-enumerable/,
    );
    // ONE read: a two-faced getter is answered once and that answer stands —
    // resume's semantics, not a flip between two readings.
    const framing = decodeHistoryFraming(artifact);
    let reads = 0;
    const options = {};
    Object.defineProperty(options, 'expectedHistoryDigestBytes', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? framing.historyDigestBytes : new Uint8Array(31);
      },
    });
    const extracted = await extractHistoryObservations(artifact, options);
    expect(reads).toBe(1);
    expect(extracted.generations).toHaveLength(3);
  });

  test('an over-ceiling artifact is refused BEFORE the copy', async () => {
    const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
    let threw = null;
    try {
      await extractHistoryObservations(oversized);
    } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(EvolutionError);
    expect(threw.code).toBe('resourceLimitExceeded');
  });
});
