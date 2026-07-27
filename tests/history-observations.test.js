// THE VERIFIED HISTORY-OBSERVATION SEAM (scripts/history-observations.js):
// a committed v3 history yields its integrity observations with NO physics,
// and a tampered or semantically incoherent artifact is refused with the
// SHARED resume taxonomy — never read as evidence the digests do not
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
    deserializeFitnessVector: vi.fn((...args) => original.deserializeFitnessVector(...args)),
    evaluatePopulation: async (population, spec) => {
      if (globalThis.__observationsProbe) globalThis.__observationsProbe.evaluations += 1;
      return original.evaluatePopulation(population, spec);
    },
  };
});

vi.mock('../src/sim/population.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    deserializePopulationSnapshot: vi.fn((...args) => original.deserializePopulationSnapshot(...args)),
  };
});

vi.mock('../src/sim/physics/adapter.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createPhysics: async (...args) => {
      if (globalThis.__observationsProbe) globalThis.__observationsProbe.worlds += 1;
      return original.createPhysics(...args);
    },
  };
});

vi.mock('../src/sim/bytes.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    copyOrdinaryBytes: vi.fn((...args) => original.copyOrdinaryBytes(...args)),
  };
});

const { createEvolutionRun, resumeEvolutionRun } = await import('../src/sim/evolution-run.js');
const { EVOLUTION_FIXTURE_A, evolutionRunConfigFor } = await import('../src/sim/evolution-fixtures.js');
const { EVOLUTION_GOLDEN_LOCKS } = await import('../src/sim/evolution-locks.js');
const { EvolutionError } = await import('../src/sim/evolution-contract.js');
const { extractHistoryObservations } = await import('../scripts/history-observations.js');
const {
  COMPONENT_KINDS, SHA256_DIGEST_BYTES, assembleHistory, decodeEvolutionHeader,
  decodeGenerationPayload, decodeHistoryFraming, deserializeEvaluationMetadata,
  digestComponent, digestGeneration, digestHeader, encodeEvolutionHeader,
  encodeGenerationPayload, serializeEvaluationMetadata,
} = await import('../src/sim/evolution-history.js');
const { MAX_EVOLUTION_HISTORY_BYTES } = await import('../src/sim/evolution-replay.js');
const {
  deserializeEvaluationSpec, deserializeFitnessVector, serializeEvaluationSpec, serializeFitnessVector,
} = await import('../src/sim/population-evaluation.js');
const {
  deserializePopulationSnapshot, serializePopulationSnapshot,
} = await import('../src/sim/population.js');
const {
  deserializePopulationInitialization, serializePopulationInitialization,
} = await import('../src/sim/population-initializer.js');
const { FNV_OFFSET_BASIS, fnv1aFold } = await import('../src/sim/fnv1a.js');
const { bytesToHex, copyOrdinaryBytes } = await import('../src/sim/bytes.js');
const { sha256 } = await import('../src/platform/sha256.js');

const LOCK = EVOLUTION_GOLDEN_LOCKS[EVOLUTION_FIXTURE_A.name];

const kimiFixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v1-kimi-k3max.base64', import.meta.url), 'utf8').trim(),
  'base64',
));

beforeEach(() => {
  globalThis.__observationsProbe = { evaluations: 0, worlds: 0 };
  copyOrdinaryBytes.mockClear();
  deserializeFitnessVector.mockClear();
  deserializePopulationSnapshot.mockClear();
});

async function fixtureArtifact() {
  const run = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
  let result;
  do { result = await run.advance(); } while (result.kind !== 'terminal');
  return run.historyBytes();
}

async function oneGenerationArtifact() {
  const run = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
  await run.advance();
  return run.historyBytes();
}

/** Rebuild a self-consistent artifact after mutating generation 0's record. */
async function reforge(bytes, mutateRecord, mutateHeader = null) {
  const framing = decodeHistoryFraming(bytes);
  let headerBytes = framing.headerBytes;
  if (mutateHeader !== null) {
    headerBytes = encodeEvolutionHeader(mutateHeader({
      ...decodeEvolutionHeader(framing.headerBytes),
    }));
  }
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
    if (i === 0) mutateRecord(record);
    const digests = {};
    for (const kind of COMPONENT_KINDS) digests[kind] = await digestComponent(kind, record.components[kind]);
    const payloadBytes = encodeGenerationPayload(record, digests);
    const generationDigestBytes = await digestGeneration(previous, payloadBytes);
    previous = generationDigestBytes;
    generations.push({ payloadBytes, generationDigestBytes });
  }
  return (await assembleHistory({
    headerBytes,
    headerDigestBytes,
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
  test('a self-consistent history with a malformed evaluation spec is refused by extraction and resume before physics', async () => {
    const invalidSpecBytes = new Uint8Array(0);
    const evaluationSpecDigestState = fnv1aFold(FNV_OFFSET_BASIS, invalidSpecBytes);
    const artifact = await oneGenerationArtifact();
    const broken = await reforge(
      artifact,
      (record) => {
        const decoded = deserializeFitnessVector(record.components.fitnessVector);
        record.components.fitnessVector = serializeFitnessVector({
          populationSnapshotDigestState: decoded.populationSnapshotDigestState,
          evaluationSpecDigestState,
          individuals: decoded.individuals,
        });
      },
      (header) => ({ ...header, evaluationSpecBytes: invalidSpecBytes }),
    );

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /evaluation spec/,
    );
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /evaluation spec/,
    );
    expect(globalThis.__observationsProbe.worlds).toBe(0);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('a wire-valid but unexecutable evaluation spec is refused by both readers before physics', async () => {
    const artifact = await oneGenerationArtifact();
    const originalHeader = decodeEvolutionHeader(decodeHistoryFraming(artifact).headerBytes);
    const originalSpec = deserializeEvaluationSpec(originalHeader.evaluationSpecBytes);
    const invalidSpecBytes = serializeEvaluationSpec({
      ...originalSpec,
      spawn: { ...originalSpec.spawn, clearance: 0.2 },
    });
    const evaluationSpecDigestState = fnv1aFold(FNV_OFFSET_BASIS, invalidSpecBytes);
    const broken = await reforge(
      artifact,
      (record) => {
        const decoded = deserializeFitnessVector(record.components.fitnessVector);
        record.components.fitnessVector = serializeFitnessVector({
          populationSnapshotDigestState: decoded.populationSnapshotDigestState,
          evaluationSpecDigestState,
          individuals: decoded.individuals,
        });
      },
      (header) => ({ ...header, evaluationSpecBytes: invalidSpecBytes }),
    );

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /not executable/,
    );
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /not executable/,
    );
    expect(globalThis.__observationsProbe.worlds).toBe(0);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('generation metadata must report the evaluation spec maxSteps in extraction and resume', async () => {
    const artifact = await oneGenerationArtifact();
    const broken = await reforge(artifact, (record) => {
      const metadata = deserializeEvaluationMetadata(record.components.evaluationMetadata);
      record.components.evaluationMetadata = serializeEvaluationMetadata({
        ...metadata,
        executedSteps: metadata.executedSteps - 1,
      });
    });

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory',
      /executedSteps 44.*evaluation spec maxSteps 45/,
    );
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory',
      /executedSteps 44.*evaluation spec maxSteps 45/,
    );
    expect(globalThis.__observationsProbe.worlds).toBe(0);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('a self-consistent history with a malformed initialization manifest is refused by both readers', async () => {
    const artifact = await oneGenerationArtifact();
    const broken = await reforge(
      artifact,
      () => {},
      (header) => ({ ...header, initializationManifestBytes: new Uint8Array(0) }),
    );

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /initialization manifest/,
    );
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /initialization manifest/,
    );
    expect(globalThis.__observationsProbe.worlds).toBe(0);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('the initialization manifest must bind the persisted generation-0 population in both readers', async () => {
    const artifact = await oneGenerationArtifact();
    const originalHeader = decodeEvolutionHeader(decodeHistoryFraming(artifact).headerBytes);
    const manifest = deserializePopulationInitialization(
      originalHeader.initializationManifestBytes,
    );
    const wrongState = (manifest.populationSnapshotDigestState + 1) >>> 0;
    const wrongManifestBytes = serializePopulationInitialization({
      ...manifest,
      populationSnapshotDigestState: wrongState,
    });
    const broken = await reforge(
      artifact,
      () => {},
      (header) => ({ ...header, initializationManifestBytes: wrongManifestBytes }),
    );

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    const extractionError = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory',
      /initialization manifest populationSnapshotDigestState/,
    );
    expect(extractionError.context).toMatchObject({
      generationIndex: 0,
      rule: 'initializationPopulationDigestStateMismatch',
      stored: wrongState,
    });
    const resumeError = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory',
      /initialization manifest populationSnapshotDigestState/,
    );
    expect(resumeError.context).toMatchObject({
      generationIndex: 0,
      rule: 'initializationPopulationDigestStateMismatch',
      stored: wrongState,
    });
    expect(globalThis.__observationsProbe.worlds).toBe(0);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('a swapped generation-0 population with BOTH FNV states re-attested is refused by both readers before physics', async () => {
    // THE ATTACK THE PROVENANCE BIND EXISTS FOR. Swap generation 0's
    // population, re-attest the fitness vector's populationSnapshotDigestState
    // to the swapped bytes, re-attest the initialization manifest's state to
    // match, and re-forge every SHA-256 component/chain/history digest — a
    // fully self-consistent artifact, no hash collision required. The FNV
    // prefilter passes by construction; the verdict is recreation: the
    // manifest's config must reproduce generation 0 byte-for-byte, and it
    // reproduces the ORIGINAL. Before this bind, extraction returned the
    // swapped rows as verified evidence while resume went on to report
    // replayDivergence at stage 'initialization' — the offline seam accepting
    // what resume rejects. Both readers must now refuse with malformedHistory
    // before a world or an evaluation exists.
    const artifact = await oneGenerationArtifact();
    const framing = decodeHistoryFraming(artifact);
    const gen0Population = decodeGenerationPayload(
      framing.generations[0].payloadBytes,
    ).components.population;
    const swapped = new Uint8Array(gen0Population);
    swapped[40] ^= 0xff; // inside member 0's genotype: still decodable, member ids intact
    const swappedState = fnv1aFold(FNV_OFFSET_BASIS, swapped);
    const broken = await reforge(
      artifact,
      (record) => {
        record.components.population = swapped;
        const decoded = deserializeFitnessVector(record.components.fitnessVector);
        record.components.fitnessVector = serializeFitnessVector({
          populationSnapshotDigestState: swappedState,
          evaluationSpecDigestState: decoded.evaluationSpecDigestState,
          individuals: decoded.individuals,
        });
      },
      (header) => {
        const manifest = deserializePopulationInitialization(header.initializationManifestBytes);
        return {
          ...header,
          initializationManifestBytes: serializePopulationInitialization({
            ...manifest,
            populationSnapshotDigestState: swappedState,
          }),
        };
      },
    );

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    const extractionError = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /recreates a generation 0 population/,
    );
    expect(extractionError.context).toMatchObject({
      generationIndex: 0,
      rule: 'initializationPopulationRecreationMismatch',
      byteOffset: 40,
      storedByte: swapped[40],
      recomputedByte: gen0Population[40],
      storedByteLength: gen0Population.byteLength,
      recomputedByteLength: gen0Population.byteLength,
    });
    const resumeError = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /recreates a generation 0 population/,
    );
    expect(resumeError.context).toMatchObject({
      generationIndex: 0,
      rule: 'initializationPopulationRecreationMismatch',
      byteOffset: 40,
      storedByte: swapped[40],
      recomputedByte: gen0Population[40],
      storedByteLength: gen0Population.byteLength,
      recomputedByteLength: gen0Population.byteLength,
    });
    expect(globalThis.__observationsProbe.worlds).toBe(0);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('a non-deterministic evaluation spec is refused by both readers before physics', async () => {
    const artifact = await oneGenerationArtifact();
    const originalHeader = decodeEvolutionHeader(decodeHistoryFraming(artifact).headerBytes);
    const nonDeterministicSpecBytes = serializeEvaluationSpec({
      ...deserializeEvaluationSpec(originalHeader.evaluationSpecBytes),
      deterministic: false,
    });
    const evaluationSpecDigestState = fnv1aFold(
      FNV_OFFSET_BASIS, nonDeterministicSpecBytes,
    );
    const broken = await reforge(
      artifact,
      (record) => {
        const decoded = deserializeFitnessVector(record.components.fitnessVector);
        record.components.fitnessVector = serializeFitnessVector({
          populationSnapshotDigestState: decoded.populationSnapshotDigestState,
          evaluationSpecDigestState,
          individuals: decoded.individuals,
        });
      },
      (header) => ({ ...header, evaluationSpecBytes: nonDeterministicSpecBytes }),
    );

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /not deterministic/,
    );
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /not deterministic/,
    );
    expect(globalThis.__observationsProbe.worlds).toBe(0);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('invalid history-byte storage uses the production malformedHistory taxonomy', async () => {
    const err = await expectCodeAsync(
      () => extractHistoryObservations({}), 'malformedHistory', /historyBytes/,
    );
    expect(err.context).toMatchObject({ path: 'historyBytes' });

    const shared = await expectCodeAsync(
      () => extractHistoryObservations(new Uint8Array(new SharedArrayBuffer(64))),
      'malformedHistory', /historyBytes/,
    );
    expect(shared.context).toMatchObject({ path: 'historyBytes' });
  });

  test('a committed v3 history yields its observations with NO physics', async () => {
    const artifact = await fixtureArtifact();
    // Prove both probes are live before measuring the extraction seam itself.
    expect(globalThis.__observationsProbe.evaluations).toBeGreaterThan(0);
    expect(globalThis.__observationsProbe.worlds).toBeGreaterThan(0);
    globalThis.__observationsProbe.evaluations = 0;
    globalThis.__observationsProbe.worlds = 0;
    deserializeFitnessVector.mockClear();
    const extracted = await extractHistoryObservations(artifact);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
    expect(globalThis.__observationsProbe.worlds).toBe(0);
    // Gate B decodes each vector once; the binding guard decodes it once more
    // and returns those checked rows to the seam. A third extraction decode is
    // an avoidable full-population pass.
    expect(deserializeFitnessVector).toHaveBeenCalledTimes(6);

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

  test('a self-consistent vector that names the wrong population snapshot is refused as malformed', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: (decoded.populationSnapshotDigestState + 1) >>> 0,
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals: decoded.individuals,
      });
    });

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /populationSnapshotDigestState/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      rule: 'populationSnapshotDigestStateMismatch',
    });
    const resumeErr = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /populationSnapshotDigestState/,
    );
    expect(resumeErr.context).toMatchObject({
      generationIndex: 0,
      rule: 'populationSnapshotDigestStateMismatch',
    });
    expect(globalThis.__observationsProbe.worlds).toBe(0);
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('a self-consistent vector that names the wrong evaluation spec is refused as malformed', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: decoded.populationSnapshotDigestState,
        evaluationSpecDigestState: (decoded.evaluationSpecDigestState + 1) >>> 0,
        individuals: decoded.individuals,
      });
    });

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /evaluationSpecDigestState/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      rule: 'evaluationSpecDigestStateMismatch',
    });
    const resumeErr = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /evaluationSpecDigestState/,
    );
    expect(resumeErr.context).toMatchObject({
      generationIndex: 0,
      rule: 'evaluationSpecDigestStateMismatch',
    });
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('a self-consistent vector with fewer rows than the header population is refused as malformed', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: decoded.populationSnapshotDigestState,
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals: decoded.individuals.slice(0, -1),
      });
    });

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /5 rows.*populationSize is 6/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      rule: 'fitnessVectorPopulationSizeMismatch',
      populationSize: 6,
      individualCount: 5,
    });
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /5 rows.*populationSize is 6/,
    );
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('a sibling population with fewer members than the header is refused as malformed', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const population = deserializePopulationSnapshot(record.components.population);
      record.components.population = serializePopulationSnapshot({
        ...population,
        individuals: population.individuals.slice(0, -1),
      });
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: fnv1aFold(
          FNV_OFFSET_BASIS, record.components.population,
        ),
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals: decoded.individuals,
      });
    });

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory',
      /population snapshot carries 5 members.*populationSize is 6/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      rule: 'populationSnapshotPopulationSizeMismatch',
      populationSize: 6,
      populationCount: 5,
    });
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory',
      /population snapshot carries 5 members.*populationSize is 6/,
    );
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('an oversized sibling population is rejected before any genotype rows are materialized', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const population = deserializePopulationSnapshot(record.components.population);
      const last = population.individuals.at(-1);
      record.components.population = serializePopulationSnapshot({
        ...population,
        individuals: [
          ...population.individuals,
          { individualId: last.individualId + 1, genotype: last.genotype },
        ],
      });
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: fnv1aFold(
          FNV_OFFSET_BASIS, record.components.population,
        ),
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals: decoded.individuals,
      });
    });

    deserializePopulationSnapshot.mockClear();
    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory',
      /population snapshot carries 7 members.*populationSize is 6/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      rule: 'populationSnapshotPopulationSizeMismatch',
      populationSize: 6,
      populationCount: 7,
    });
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory',
      /population snapshot carries 7 members.*populationSize is 6/,
    );
    expect(deserializePopulationSnapshot).not.toHaveBeenCalled();
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
  });

  test('self-consistent vector rows must name the persisted population members exactly', async () => {
    const artifact = await fixtureArtifact();
    const broken = await reforge(artifact, (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      const individuals = decoded.individuals.map((row) => ({
        ...row,
        individualId: row.individualId + 1000,
      }));
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: decoded.populationSnapshotDigestState,
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals,
      });
    });

    globalThis.__observationsProbe.worlds = 0;
    globalThis.__observationsProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => extractHistoryObservations(broken), 'malformedHistory', /individual 1000.*population member 0/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      rule: 'fitnessVectorIndividualIdMismatch',
      memberIndex: 0,
      stored: 1000,
      expected: 0,
    });
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /individual 1000.*population member 0/,
    );
    expect(globalThis.__observationsProbe.evaluations).toBe(0);
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

  test('a wrong-length expected digest is refused before it is copied', async () => {
    const artifact = await fixtureArtifact();
    const wrongLength = new Uint8Array(SHA256_DIGEST_BYTES + 1);
    copyOrdinaryBytes.mockClear();

    const err = await expectCodeAsync(
      () => extractHistoryObservations(artifact, { expectedHistoryDigestBytes: wrongLength }),
      'invalidConfig', /exactly 32 bytes/,
    );
    expect(err.context.byteLength).toBe(SHA256_DIGEST_BYTES + 1);
    expect(copyOrdinaryBytes).toHaveBeenCalledTimes(1); // history only
    expect(copyOrdinaryBytes.mock.calls[0][0]).toBe(artifact);
  });

  test('history and expected-digest inputs are owned before the first await', async () => {
    const artifact = await fixtureArtifact();
    const pristine = new Uint8Array(artifact);
    const expected = pristine.slice(-SHA256_DIGEST_BYTES);
    const pending = extractHistoryObservations(artifact, { expectedHistoryDigestBytes: expected });
    artifact.fill(0);
    expected.fill(0);

    const extracted = await pending;
    expect(extracted.generations).toHaveLength(3);
    expect(bytesToHex(extracted.historyDigestBytes))
      .toBe(bytesToHex(pristine.slice(-SHA256_DIGEST_BYTES)));

    const wrongExpected = pristine.slice(-SHA256_DIGEST_BYTES);
    wrongExpected[0] ^= 0xff;
    const rejected = extractHistoryObservations(pristine, {
      expectedHistoryDigestBytes: wrongExpected,
    });
    wrongExpected[0] ^= 0xff; // repaired after invocation — too late
    await expectCodeAsync(() => rejected, 'staleOrWrongArtifact');
  });

  test('an over-ceiling artifact is refused BEFORE the copy', async () => {
    const oversized = new Uint8Array(MAX_EVOLUTION_HISTORY_BYTES + 1);
    copyOrdinaryBytes.mockClear();
    let threw = null;
    try {
      await extractHistoryObservations(oversized);
    } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(EvolutionError);
    expect(threw.code).toBe('resourceLimitExceeded');
    expect(copyOrdinaryBytes).not.toHaveBeenCalled();
  });
});
