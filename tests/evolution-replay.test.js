// REPLAY AND RESUME: ordered verification, first-divergence localization,
// external freshness, the runtime gate, and byte-identical continuation.
//
// THE REFORGE HELPER is what makes this suite meaningful. Flipping a byte in a
// committed artifact is caught by the component digest — correctly, and that is
// tested — but it tests the DIGEST, not the REPLAY. To reach the replay stages
// you need an artifact that is perfectly well-formed and self-consistent and
// still describes a run this environment does not reproduce. `reforge` builds
// exactly that: it rewrites a component (or the header), recomputes every
// downstream digest, re-chains, and re-assembles, so verification passes
// cleanly and the divergence must be found by re-running the generation.
//
// Seeds declared: population 20260740, terrain 20260741 (as in
// tests/evolution-run.test.js).

import {
  describe, test, expect, vi, beforeEach,
} from 'vitest';
import { runInNewContext as vmRunInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

// A pass-through spy, purely to COUNT physics: the runtime gate's contract is
// that a version mismatch cannot reach a world, which is only observable as
// "zero evaluations happened".
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

const { createEvolutionRun, resumeEvolutionRun } = await import('../src/sim/evolution-run.js');
const {
  EvolutionError, MAX_EVOLUTION_EVALUATION_WORK, MAX_EVOLUTION_GENERATIONS,
  MAX_EVOLUTION_POPULATION_SIZE,
} = await import('../src/sim/evolution-contract.js');
const {
  deserializeEvaluationSpec, deserializeFitnessVector, serializeEvaluationSpec, serializeFitnessVector,
} = await import('../src/sim/population-evaluation.js');
const {
  COMPONENT_KINDS, SHA256_DIGEST_BYTES, assembleHistory, decodeEvolutionHeader,
  decodeGenerationPayload, decodeHistoryFraming, deserializeEvaluationMetadata,
  digestComponent, digestGeneration,
  digestHeader, encodeEvolutionHeader, encodeGenerationPayload, serializeEvaluationMetadata,
} = await import('../src/sim/evolution-history.js');
const {
  REPLAY_STAGES, captureExpectedIdentity, firstByteDifference, verifyHistoryArtifact,
} = await import('../src/sim/evolution-replay.js');
const { EVOLUTION_FIXTURE_A, evolutionRunConfigFor } = await import('../src/sim/evolution-fixtures.js');
const { EVOLUTION_GOLDEN_LOCKS } = await import('../src/sim/evolution-locks.js');
const {
  deserializePopulationInitialization, serializePopulationInitialization,
} = await import('../src/sim/population-initializer.js');
const { bytesToHex } = await import('../src/sim/bytes.js');
const { sha256 } = await import('../src/platform/sha256.js');
const { FNV_OFFSET_BASIS, fnv1aFold } = await import('../src/sim/fnv1a.js');

const POPULATION_SEED = 20260740;
const TERRAIN_SEED = 20260741;

const kimiFixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v1-kimi-k3max.base64', import.meta.url), 'utf8').trim(),
  'base64',
));
// The v2 fixture's self-consistency literals (tests/fixtures/evolution-v1-kimi-k3max.md).
const KIMI_HEADER_DIGEST = '312665978b18bdd920668a1ee3bc49b301a24b76d7497f9ef328732b6939bfce';
const KIMI_HISTORY_DIGEST = '3717df1acd2debc9f6aec79425da49032687b238ae1d0edb60a620c4d902575d';

// The independent v3 interop artifact (tests/fixtures/evolution-v1-fitness-vector-v3-kimi.md).
const v3FixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v1-fitness-vector-v3-kimi.base64', import.meta.url), 'utf8').trim(),
  'base64',
));

const config = (overrides = {}) => ({
  initialization: { seed: POPULATION_SEED, populationSize: 6 },
  evaluationSpec: {
    terrain: {
      seed: TERRAIN_SEED, startFlatLength: 30, startBlendLength: 6, craterDensity: 0, featureDensity: 0,
    },
    maxSteps: 45,
    deterministic: true,
    spawn: { x: -44, z: 0 },
  },
  evolution: { maxGenerations: 3, ...(overrides.evolution ?? {}) },
});

beforeEach(() => { globalThis.__replayProbe = { evaluations: 0 }; });

async function runToTerminal(cfg = config()) {
  const run = createEvolutionRun(cfg);
  let result;
  do { result = await run.advance(); } while (result.kind !== 'terminal');
  return run.historyBytes();
}

async function runGenerations(count, cfg = config({ evolution: { maxGenerations: 8 } })) {
  const run = createEvolutionRun(cfg);
  for (let i = 0; i < count; i += 1) await run.advance();
  return run.historyBytes();
}

/**
 * Rebuild a complete, self-consistent artifact after mutating the header
 * and/or one generation's decoded components. Every downstream digest is
 * recomputed, so the result passes verification and can only fail at replay.
 */
async function reforge(bytes, { mutateHeader, mutateHeaderBytes, mutateRecord } = {}) {
  const framing = decodeHistoryFraming(bytes);
  let headerBytes = framing.headerBytes;
  if (mutateHeader) {
    const decoded = decodeEvolutionHeader(framing.headerBytes);
    headerBytes = encodeEvolutionHeader(mutateHeader({ ...decoded }));
  }
  if (mutateHeaderBytes) {
    headerBytes = new Uint8Array(headerBytes);
    mutateHeaderBytes(headerBytes);
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
    if (mutateRecord) mutateRecord(record, i);
    const digests = {};
    for (const kind of COMPONENT_KINDS) digests[kind] = await digestComponent(kind, record.components[kind]);
    const payloadBytes = encodeGenerationPayload(record, digests);
    const generationDigestBytes = await digestGeneration(previous, payloadBytes);
    previous = generationDigestBytes;
    generations.push({ payloadBytes, generationDigestBytes });
  }
  return (await assembleHistory({ headerBytes, headerDigestBytes, generations })).bytes;
}

const flipByte = (bytes, offset = 0) => {
  const copy = new Uint8Array(bytes);
  copy[offset] ^= 0xff;
  return copy;
};

function rebindFitnessVectorToPopulation(record) {
  const vector = deserializeFitnessVector(record.components.fitnessVector);
  record.components.fitnessVector = serializeFitnessVector({
    populationSnapshotDigestState: fnv1aFold(
      FNV_OFFSET_BASIS, record.components.population,
    ),
    evaluationSpecDigestState: vector.evaluationSpecDigestState,
    individuals: vector.individuals,
  });
}

// The manifest half of a generation-0 population re-attestation: re-encode
// the initialization manifest with its populationSnapshotDigestState
// re-folded over the (mutated) population bytes, so the stage-11 provenance
// binding passes and only deterministic replay can see the change.
function rebindInitializationToPopulation(header, populationBytes) {
  const manifest = deserializePopulationInitialization(header.initializationManifestBytes);
  return serializePopulationInitialization({
    ...manifest,
    populationSnapshotDigestState: fnv1aFold(FNV_OFFSET_BASIS, populationBytes),
  });
}

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

// ============================================================================
// (1) THE HAPPY PATH: RESUME AND CONTINUE
// ============================================================================

describe('resume and continuation', () => {
  test('the v2 Kimi artifact is now an EARLY-REFUSAL witness: self-consistent, refused at the compatibility gate', async () => {
    // PR 29 R2: this artifact's successful-replay role is historical (pinned
    // to the pre-PR-29 commit in its .md). It still carries a v2 fitness
    // vector, so the compatibility gate must refuse it — AFTER every
    // self-consistency leg passes and BEFORE any physics, naming the exact
    // field, generation, stored and current values.
    const fixture = kimiFixtureBytes();
    expect(fixture.length).toBe(4024);
    expect(fixture[14 + 18]).toBe(0); // outer prefix + format-owned flavor byte
    // The self-consistency legs ALL pass: framing, the header digest, every
    // component digest, the chain, the whole-history digest.
    const verified = await verifyHistoryArtifact(fixture);
    expect(verified.finalGenerationIndex).toBe(0);
    expect(bytesToHex(verified.framing.headerDigestBytes)).toBe(KIMI_HEADER_DIGEST);
    expect(bytesToHex(verified.historyDigestBytes)).toBe(KIMI_HISTORY_DIGEST);
    // …and only THEN does the gate refuse the stale v2 vector.
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(() => resumeEvolutionRun(fixture), 'unsupportedVersion', /fitnessVectorVersion/);
    expect(err.context).toMatchObject({
      field: 'fitnessVectorVersion', generationIndex: 0, stored: 2, current: 3,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('the independently assembled v3 artifact verifies, resumes and continues byte-identically', async () => {
    // PR 29 R2's successful-replay role: an artifact whose v3 vector and
    // framing/digest assembly were encoded by a tool importing nothing from
    // the implementation under test (its narrow, encoding-layer-only claim is
    // in tests/fixtures/evolution-v1-fitness-vector-v3-kimi.md). The local
    // implementation's generation-0 artifact must be BYTE-IDENTICAL to it,
    // and resuming the static bytes must continue to the committed lock's
    // terminal digest.
    const fixture = v3FixtureBytes();
    expect(fixture.length).toBe(5682);
    expect(fixture[14 + 18]).toBe(0); // outer prefix + format-owned flavor byte
    const control = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
    await control.advance();
    const fixtureHeader = decodeEvolutionHeader(decodeHistoryFraming(fixture).headerBytes);
    const controlHeader = decodeEvolutionHeader(decodeHistoryFraming(control.historyBytes()).headerBytes);
    expect(controlHeader.rapierVersion,
      'engine changed — regenerate the independent v3 artifact deliberately')
      .toBe(fixtureHeader.rapierVersion);
    expect(bytesToHex(control.historyBytes())).toBe(bytesToHex(fixture));
    const resumed = await resumeEvolutionRun(fixture);
    while (control.status().phase !== 'terminal') {
      const a = await control.advance();
      const b = await resumed.advance();
      expect(bytesToHex(b.historyDigestBytes)).toBe(bytesToHex(a.historyDigestBytes));
      expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(control.historyBytes()));
    }
    // The terminal continuation reproduces the committed evolution lock's
    // whole-history digest (read through the imported lock — never duplicated).
    expect(bytesToHex(control.historyBytes().slice(-32)))
      .toBe(EVOLUTION_GOLDEN_LOCKS[EVOLUTION_FIXTURE_A.name].historyDigest);
  });

  test('a mid-run history resumes to the same status and the same bytes', async () => {
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 4 } }));
    await run.advance();
    await run.advance();
    const artifact = run.historyBytes();
    const resumed = await resumeEvolutionRun(artifact);
    expect(resumed.status()).toEqual(run.status());
    expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(artifact));
  });

  test('continuation from a resumed run is BYTE-IDENTICAL to never having stopped', async () => {
    const original = createEvolutionRun(config({ evolution: { maxGenerations: 4 } }));
    await original.advance();
    await original.advance();
    const resumed = await resumeEvolutionRun(original.historyBytes());
    // Advance both to the end and compare the whole artifact at each step.
    for (let i = 0; i < 2; i += 1) {
      const a = await original.advance();
      const b = await resumed.advance();
      expect(b.kind).toBe(a.kind);
      expect(bytesToHex(b.historyDigestBytes)).toBe(bytesToHex(a.historyDigestBytes));
      expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(original.historyBytes()));
    }
    expect(resumed.status().phase).toBe('terminal');
  });

  test('a TERMINAL history resumes to an opaque terminal run that appends nothing', async () => {
    const artifact = await runToTerminal();
    const resumed = await resumeEvolutionRun(artifact);
    const status = resumed.status();
    expect(status.phase).toBe('terminal');
    expect(status.terminalReason).toBe('generationLimitReached');
    expect(status.pendingGenerationIndex).toBeNull();
    const result = await resumed.advance();
    expect(result.kind).toBe('terminal');
    expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(artifact));
  });

  test('a single-generation history resumes and continues', async () => {
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    await run.advance();
    const resumed = await resumeEvolutionRun(run.historyBytes());
    expect(resumed.status().pendingGenerationIndex).toBe(1);
    expect((await resumed.advance()).committedGenerationIndex).toBe(1);
  });

  test('resume re-runs the physics it verifies — it is a REPLAY, not a trust exercise', async () => {
    const artifact = await runGenerations(2);
    globalThis.__replayProbe.evaluations = 0;
    await resumeEvolutionRun(artifact);
    // Two committed records, so two generations are re-evaluated.
    expect(globalThis.__replayProbe.evaluations).toBe(2);
  });
});

// ============================================================================
// (2) ORDERED VERIFICATION — each stage has its own code
// ============================================================================

describe('ordered verification localizes the failure', () => {
  test('a corrupt header is `componentDigestMismatch`, named as the header', async () => {
    const artifact = await runGenerations(1);
    const framing = decodeHistoryFraming(artifact);
    const broken = new Uint8Array(artifact);
    broken[14] ^= 0xff; // the first header byte
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'componentDigestMismatch');
    expect(err.context.component).toBe('header');
    expect(framing.headerBytes.length).toBeGreaterThan(0);
  });

  test.each(COMPONENT_KINDS)('a corrupt %s component is `componentDigestMismatch`, naming that component', async (kind) => {
    const artifact = await runGenerations(1);
    // Rewrite the component but NOT its digest — the digest stage must catch it.
    const framing = decodeHistoryFraming(artifact);
    const payload = decodeGenerationPayload(framing.generations[0].payloadBytes);
    const components = { ...payload.components };
    components[kind] = flipByte(components[kind]);
    const payloadBytes = encodeGenerationPayload(
      { generationIndex: 0, terminalReason: payload.terminalReason, components },
      payload.componentDigests, // the ORIGINAL digests: now wrong for `kind`
    );
    const generationDigestBytes = await digestGeneration(framing.headerDigestBytes, payloadBytes);
    const rebuilt = (await assembleHistory({
      headerBytes: framing.headerBytes,
      headerDigestBytes: framing.headerDigestBytes,
      generations: [{ payloadBytes, generationDigestBytes }],
    })).bytes;
    const err = await expectCodeAsync(() => resumeEvolutionRun(rebuilt), 'componentDigestMismatch');
    expect(err.context.component).toBe(kind);
    expect(err.context.generationIndex).toBe(0);
  });

  test('a BROKEN CHAIN is `generationChainMismatch`, not a component or history failure', async () => {
    const artifact = await runGenerations(2);
    const framing = decodeHistoryFraming(artifact);
    // Re-chain generation 1 from the HEADER instead of from generation 0: every
    // component is authentic, every component digest is right, and the record
    // is simply in the wrong lineage.
    const wrongLink = await digestGeneration(framing.headerDigestBytes, framing.generations[1].payloadBytes);
    const rebuilt = (await assembleHistory({
      headerBytes: framing.headerBytes,
      headerDigestBytes: framing.headerDigestBytes,
      generations: [
        framing.generations[0],
        { payloadBytes: framing.generations[1].payloadBytes, generationDigestBytes: wrongLink },
      ],
    })).bytes;
    const err = await expectCodeAsync(() => resumeEvolutionRun(rebuilt), 'generationChainMismatch');
    expect(err.context.generationIndex).toBe(1);
  });

  test('non-contiguous generation indices are `generationChainMismatch`', async () => {
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => { if (i === 1) record.generationIndex = 5; },
    });
    await expectCodeAsync(() => resumeEvolutionRun(broken), 'generationChainMismatch', /contiguous/);
  });

  test('a terminal record followed by more records is `generationChainMismatch`', async () => {
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => { if (i === 0) record.terminalReason = 'noSelectableParents'; },
    });
    await expectCodeAsync(() => resumeEvolutionRun(broken), 'generationChainMismatch', /followed by/);
  });

  // THE ORDERING PROPERTY, and why it needed its own tests. The reassembled
  // cases above prove each stage DETECTS its class — but they recompute the
  // outer digest, so they would stay green even if the whole-history check ran
  // FIRST. (Measured: moving that check ahead of the component loop left the
  // entire suite green.) A real corruption flips a byte IN PLACE, which
  // invalidates the component digest, the chain, AND the trailer at once; the
  // reported code is then the only evidence of which stage ran first, and
  // "the history digest is wrong" localizes nothing.
  test('an IN-PLACE component byte flip reports `componentDigestMismatch`, NOT the outer digest', async () => {
    const artifact = await runGenerations(1);
    const framing = decodeHistoryFraming(artifact);
    // magic(8) + version(2) + headerLen(4) + header + headerDigest(32)
    //   + count(4) + payloadLen(4) -> payload; then u16 version + u32 index
    //   + u8 terminal + u32 componentLen -> the population component's bytes.
    const payloadStart = 8 + 2 + 4 + framing.headerBytes.length + SHA256_DIGEST_BYTES + 4 + 4;
    const broken = new Uint8Array(artifact);
    broken[payloadStart + 2 + 4 + 1 + 4 + 10] ^= 0xff;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'componentDigestMismatch');
    expect(err.context.component).toBe('population');
    expect(err.context.generationIndex).toBe(0);
  });

  test('an IN-PLACE generation-digest flip reports `generationChainMismatch`, NOT the outer digest', async () => {
    const artifact = await runGenerations(1);
    const framing = decodeHistoryFraming(artifact);
    const payloadStart = 8 + 2 + 4 + framing.headerBytes.length + SHA256_DIGEST_BYTES + 4 + 4;
    const digestStart = payloadStart + framing.generations[0].payloadBytes.length;
    const broken = new Uint8Array(artifact);
    broken[digestStart] ^= 0xff;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'generationChainMismatch');
    expect(err.context.generationIndex).toBe(0);
  });

  test('a corrupt whole-history trailer is `historyDigestMismatch`', async () => {
    const artifact = await runGenerations(1);
    const broken = new Uint8Array(artifact);
    broken[broken.length - 1] ^= 0xff;
    await expectCodeAsync(() => resumeEvolutionRun(broken), 'historyDigestMismatch');
  });

  test.each([
    ['truncated', (b) => b.slice(0, b.length - 8)],
    ['appended', (b) => { const x = new Uint8Array(b.length + 1); x.set(b, 0); return x; }],
    ['a broken magic', (b) => flipByte(b, 0)],
  ])('%s input is `malformedHistory` — a framing failure, not a digest failure', async (_name, mutate) => {
    const artifact = await runGenerations(1);
    await expectCodeAsync(() => resumeEvolutionRun(mutate(artifact)), 'malformedHistory');
  });

  test('a header version this build does not implement is `unsupportedVersion`', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateHeader: (h) => ({ ...h, elitismVersion: 7 }),
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'unsupportedVersion', /elitismVersion/);
    expect(err.context.stored).toBe(7);
  });

  test.each(['generationRecordVersion', 'evaluationMetadataVersion'])(
    'a mismatched duplicated %s is rejected before evaluation',
    async (field) => {
      const artifact = await runGenerations(1);
      const broken = await reforge(artifact, {
        mutateHeader: (h) => ({ ...h, [field]: 7 }),
      });
      globalThis.__replayProbe.evaluations = 0;
      const err = await expectCodeAsync(
        () => resumeEvolutionRun(broken), 'unsupportedVersion', new RegExp(field),
      );
      expect(err.context).toMatchObject({ field, stored: 7, current: 1 });
      expect(globalThis.__replayProbe.evaluations).toBe(0);
    },
  );

  test.each([
    ['populationSize', MAX_EVOLUTION_POPULATION_SIZE + 1],
    ['maxGenerations', MAX_EVOLUTION_GENERATIONS + 1],
  ])('an imported header over the %s cap is rejected before evaluation', async (field, value) => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateHeader: (h) => ({ ...h, [field]: value }),
    });
    globalThis.__replayProbe.evaluations = 0;
    await expectCodeAsync(() => resumeEvolutionRun(broken), 'resourceLimitExceeded', new RegExp(field));
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('header and initialization-manifest population sizes must agree', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateHeader: (h) => ({ ...h, populationSize: h.populationSize + 1 }),
    });
    globalThis.__replayProbe.evaluations = 0;
    await expectCodeAsync(() => resumeEvolutionRun(broken), 'malformedHistory', /initialization manifest/);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a forged evaluation spec cannot exceed the product compute budget', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateHeader: (h) => {
        const spec = deserializeEvaluationSpec(h.evaluationSpecBytes);
        const maxSteps = Math.floor(MAX_EVOLUTION_EVALUATION_WORK / h.populationSize) + 1;
        return { ...h, evaluationSpecBytes: serializeEvaluationSpec({ ...spec, maxSteps }) };
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'resourceLimitExceeded', /MAX_EVOLUTION_EVALUATION_WORK/,
    );
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a malformed embedded evaluation spec is classified before physics', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateHeader: (header) => ({ ...header, evaluationSpecBytes: Uint8Array.of(0, 0) }),
    });
    globalThis.__replayProbe.evaluations = 0;

    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /evaluation spec/,
    );
    expect(err.cause).toBeInstanceOf(Error);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a malformed embedded initialization manifest is classified before physics', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateHeader: (header) => ({
        ...header, initializationManifestBytes: Uint8Array.of(0, 0),
      }),
    });
    globalThis.__replayProbe.evaluations = 0;

    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /initialization manifest/,
    );
    expect(err.cause).toBeInstanceOf(Error);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('NO PHYSICS runs before the structural, identity and runtime gates pass', async () => {
    const artifact = await runGenerations(1);
    const broken = new Uint8Array(artifact);
    broken[broken.length - 1] ^= 0xff;
    globalThis.__replayProbe.evaluations = 0;
    await expectCodeAsync(() => resumeEvolutionRun(broken), 'historyDigestMismatch');
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });
});

// ============================================================================
// (3) THE RUNTIME GATE
// ============================================================================

describe('the runtime gate runs before physics', () => {
  test('a different Rapier version is `runtimeVersionMismatch`, with zero evaluations', async () => {
    const artifact = await runGenerations(1);
    const foreign = await reforge(artifact, {
      mutateHeader: (h) => ({ ...h, rapierVersion: '99.99.99' }),
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(() => resumeEvolutionRun(foreign), 'runtimeVersionMismatch', /rapierVersion/);
    expect(err.context.stored).toBe('99.99.99');
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a different package name is `runtimeVersionMismatch`', async () => {
    const artifact = await runGenerations(1);
    const foreign = await reforge(artifact, {
      mutateHeader: (h) => ({ ...h, packageName: '@dimforge/rapier3d-compat' }),
    });
    await expectCodeAsync(() => resumeEvolutionRun(foreign), 'runtimeVersionMismatch', /packageName/);
  });

  test('a non-deterministic embedded spec is rejected before physics', async () => {
    const artifact = await runGenerations(1);
    const foreign = await reforge(artifact, {
      mutateHeader: (header) => ({
        ...header,
        evaluationSpecBytes: serializeEvaluationSpec({
          ...deserializeEvaluationSpec(header.evaluationSpecBytes),
          deterministic: false,
        }),
      }),
    });
    globalThis.__replayProbe.evaluations = 0;

    await expectCodeAsync(
      () => resumeEvolutionRun(foreign), 'malformedHistory', /deterministic/,
    );
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a non-v1 physics flavor is malformed history, never silently replayed', async () => {
    const artifact = await runGenerations(1);
    const foreign = await reforge(artifact, {
      mutateHeaderBytes: (bytes) => { bytes[18] = 1; },
    });
    await expectCodeAsync(() => resumeEvolutionRun(foreign), 'malformedHistory', /physicsFlavor/);
  });
});

// ============================================================================
// (4) FIRST-DIVERGENCE LOCALIZATION AT EVERY STAGE
// ============================================================================

describe('deterministic replay reports the FIRST divergence, localized', () => {
  test('the declared stage list is the copy-declared literal', () => {
    expect([...REPLAY_STAGES]).toEqual([
      'initialization', 'population', 'evaluationMetadata', 'fitnessVector',
      'terminalReason', 'lineage',
    ]);
  });

  test("generation 0's population diverges at stage 'initialization' with no last-agreed generation", async () => {
    const artifact = await runGenerations(2);
    // A population-content flip with EVERY binding re-attested — the vector's
    // digest state AND the initialization manifest's — so only deterministic
    // replay can see it. (Without the manifest re-attestation the stage-11
    // provenance binding correctly reports malformedHistory instead.)
    const flipped = flipByte(
      decodeGenerationPayload(decodeHistoryFraming(artifact).generations[0].payloadBytes).components.population,
      40,
    );
    const broken = await reforge(artifact, {
      mutateHeader: (header) => ({
        ...header,
        initializationManifestBytes: rebindInitializationToPopulation(header, flipped),
      }),
      mutateRecord: (record, i) => {
        if (i === 0) {
          record.components.population = flipped;
          rebindFitnessVectorToPopulation(record);
        }
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('initialization');
    expect(err.context.generationIndex).toBe(0);
    expect(err.context.lastAgreedGenerationIndex).toBeNull();
    expect(err.context.byteOffset).toBe(40);
  });

  test("generation 1's population diverges at stage 'population', with generation 0 agreed", async () => {
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          record.components.population = flipByte(record.components.population, 40);
          rebindFitnessVectorToPopulation(record);
        }
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('population');
    expect(err.context.generationIndex).toBe(1);
    expect(err.context.lastAgreedGenerationIndex).toBe(0);
    expect(err.context.byteOffset).toBe(40);
    expect(typeof err.context.expectedByte).toBe('number');
    expect(typeof err.context.actualByte).toBe('number');
    expect(err.context.expectedByte).not.toBe(err.context.actualByte);
  });

  test("a changed effective timestep diverges at stage 'evaluationMetadata' — BEFORE fitness", async () => {
    // The whole reason the metadata component exists: a timestep or step-count
    // drift EXPLAINS a fitness difference, so it must be reported first.
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        record.components.evaluationMetadata = flipByte(
          record.components.evaluationMetadata, 3,
        );
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('evaluationMetadata');
    expect(err.context.generationIndex).toBe(0);
  });

  test("changed fitness-vector content diverges at stage 'fitnessVector'", async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        const vector = deserializeFitnessVector(record.components.fitnessVector);
        const individuals = vector.individuals.map((row, index) => (index === 0 ? {
          ...row,
          fitness: row.fitness + 1,
        } : row));
        record.components.fitnessVector = serializeFitnessVector({
          populationSnapshotDigestState: vector.populationSnapshotDigestState,
          evaluationSpecDigestState: vector.evaluationSpecDigestState,
          individuals,
        });
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('fitnessVector');
  });

  test("a changed terminal reason diverges at stage 'terminalReason', with both values reported", async () => {
    const artifact = await runToTerminal();
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i === 2) record.terminalReason = 'noSelectableParents';
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('terminalReason');
    expect(err.context.expected).toBe('noSelectableParents');
    expect(err.context.actual).toBe('generationLimitReached');
    expect(err.context.lastAgreedGenerationIndex).toBe(1);
  });

  test("a changed lineage diverges at stage 'lineage'", async () => {
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          const l = new Uint8Array(record.components.lineage);
          // The first row's parent id, at header(10) + id(4).
          new DataView(l.buffer).setUint32(14, 4, true);
          record.components.lineage = l;
        }
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('lineage');
    expect(err.context.generationIndex).toBe(1);
  });

  test("multiple faults report evaluationMetadata before lineage", async () => {
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i !== 1) return;
        record.components.evaluationMetadata = flipByte(record.components.evaluationMetadata, 3);
        record.components.lineage = flipByte(record.components.lineage, 14);
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('evaluationMetadata');
    expect(err.context.generationIndex).toBe(1);
    expect(err.context.lastAgreedGenerationIndex).toBe(0);
  });

  test('replay stops at the FIRST divergent generation, not the last', async () => {
    const artifact = await runGenerations(3);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i >= 1) {
          record.components.population = flipByte(record.components.population, 40);
          rebindFitnessVectorToPopulation(record);
        }
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.generationIndex).toBe(1);
    expect(err.context.lastAgreedGenerationIndex).toBe(0);
  });

  test('firstByteDifference reports the index, and -1 for identical arrays', () => {
    expect(firstByteDifference(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(-1);
    expect(firstByteDifference(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 9, 3))).toBe(1);
    // A length mismatch reports the first index past the shared prefix.
    expect(firstByteDifference(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(2);
  });
});

// ============================================================================
// (5) EXTERNAL FRESHNESS — staleness is NOT corruption
// ============================================================================

describe('the external expected-identity contract', () => {
  test('a matching expected digest and index accept', async () => {
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    const first = await run.advance();
    const artifact = run.historyBytes();
    const resumed = await resumeEvolutionRun(artifact, {
      expectedHistoryDigestBytes: first.historyDigestBytes,
      expectedGenerationIndex: 0,
    });
    expect(resumed.status().lastCommittedGenerationIndex).toBe(0);
  });

  test('a VALID OLDER artifact with the newest expected digest is `staleOrWrongArtifact`', async () => {
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    await run.advance();
    const stale = run.historyBytes();
    const newer = await run.advance();
    // `stale` verifies perfectly — it is simply not the newest save. The
    // embedded digest cannot possibly detect that; only an external expectation
    // can, which is exactly why the claim language is narrow.
    globalThis.__replayProbe.evaluations = 0;
    await expectCodeAsync(
      () => resumeEvolutionRun(stale, { expectedHistoryDigestBytes: newer.historyDigestBytes }),
      'staleOrWrongArtifact', /history digest/,
    );
    expect(globalThis.__replayProbe.evaluations).toBe(0);
    // …and without the expectation it resumes cleanly, proving the artifact is
    // not corrupt in any way the format can see.
    const resumed = await resumeEvolutionRun(stale);
    expect(resumed.status().lastCommittedGenerationIndex).toBe(0);
  });

  test('a wrong expected generation index is `staleOrWrongArtifact`, distinct from corruption', async () => {
    const artifact = await runGenerations(2);
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(artifact, { expectedGenerationIndex: 5 }),
      'staleOrWrongArtifact', /final committed generation/,
    );
    expect(err.context.expected).toBe(5);
    expect(err.context.actual).toBe(1);
  });

  test('expected bytes are COPIED before the first await — mutating them after cannot change the verdict', async () => {
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    const first = await run.advance();
    const expectedDigest = new Uint8Array(first.historyDigestBytes);
    const pending = resumeEvolutionRun(run.historyBytes(), { expectedHistoryDigestBytes: expectedDigest });
    expectedDigest.fill(0); // after the call, before it resolves
    const resumed = await pending;
    expect(resumed.status().lastCommittedGenerationIndex).toBe(0);
  });

  test.each([
    ['an unknown option key', { nope: 1 }],
    ['a non-object options', 42],
    ['an array options', []],
    ['a non-uint32 expected index', { expectedGenerationIndex: -1 }],
  ])('%s is refused as invalidConfig', async (_name, options) => {
    const artifact = await runGenerations(1);
    expectCodeSync(() => resumeEvolutionRun(artifact, options), 'invalidConfig');
  });

  test('an expected digest of the wrong length is refused as invalidConfig', async () => {
    const artifact = await runGenerations(1);
    expectCodeSync(
      () => resumeEvolutionRun(artifact, { expectedHistoryDigestBytes: 'not bytes' }),
      'invalidConfig', /option/,
    );
    expectCodeSync(
      () => resumeEvolutionRun(artifact, { expectedHistoryDigestBytes: new Uint8Array(16) }),
      'invalidConfig', /exactly 32 bytes/,
    );
    // A 32-byte non-matching digest is a STALENESS verdict, not a config error.
    const wrongDigest = await sha256(Uint8Array.of(0));
    await expectCodeAsync(
      () => resumeEvolutionRun(artifact, { expectedHistoryDigestBytes: wrongDigest }),
      'staleOrWrongArtifact',
    );
    expect(SHA256_DIGEST_BYTES).toBe(32);
  });

  test('an impossible expected-digest length is refused before an owned copy is allocated', () => {
    const copy = vi.fn((bytes) => new Uint8Array(bytes));
    const err = expectCodeSync(
      () => captureExpectedIdentity(
        { expectedHistoryDigestBytes: new Uint8Array(SHA256_DIGEST_BYTES + 1) },
        copy,
      ),
      'invalidConfig', /exactly 32 bytes/,
    );
    expect(err.context.byteLength).toBe(SHA256_DIGEST_BYTES + 1);
    expect(copy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// (6) INTAKE: STORAGE, CEILINGS, COPY-BEFORE-AWAIT
// ============================================================================

describe('the resume intake seam', () => {
  test.each([
    ['detached', () => { const u = new Uint8Array(64); u.buffer.transfer(); return u; }, /detached/],
    ['SharedArrayBuffer-backed', () => new Uint8Array(new SharedArrayBuffer(64)), /SharedArrayBuffer/],
    ['resizable', () => new Uint8Array(new ArrayBuffer(64, { maxByteLength: 128 })), /resizable/],
    ['cross-realm', () => vmRunInNewContext('new Uint8Array(64)'), /not an ordinary same-realm Uint8Array/],
  ])('%s storage is refused SYNCHRONOUSLY', (_name, make, pattern) => {
    // Synchronous because everything decidable about the caller's bytes is
    // decided before an await exists — which is also why a caller that forgets
    // to await gets a throw rather than an unhandled rejection.
    expectCodeSync(() => resumeEvolutionRun(make()), 'malformedHistory', pattern);
  });

  test('an over-ceiling artifact is refused BEFORE the copy', () => {
    // 64 MiB + 1: the check reads the intrinsic length and refuses; it must not
    // allocate the artifact's own size as the price of finding out it is too big.
    const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
    expectCodeSync(() => resumeEvolutionRun(oversized), 'resourceLimitExceeded', /MAX_EVOLUTION_HISTORY_BYTES/);
  });

  test('the caller keeps its buffer: mutating it across the await cannot change the resumed run', async () => {
    const artifact = await runGenerations(2);
    const callerCopy = new Uint8Array(artifact);
    const pending = resumeEvolutionRun(callerCopy);
    callerCopy.fill(0); // after the call, before verification completes
    const resumed = await pending;
    expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(artifact));
  });

  test('the resumed run returns a FRESH history copy, never its input buffer', async () => {
    const artifact = await runGenerations(1);
    const resumed = await resumeEvolutionRun(artifact);
    const a = resumed.historyBytes();
    expect(a.buffer).not.toBe(artifact.buffer);
    a[0] ^= 0xff;
    expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(artifact));
  });
});


// ============================================================================
// (7) THE FITNESS-VECTOR PRE-PHYSICS GATES (PR 29)
// ============================================================================
// Gate A (compatibility -> `unsupportedVersion`) and Gate B (metadata
// coherence -> `malformedHistory`) fire AFTER every self-consistency leg and
// the external-identity check, and BEFORE the runtime gate and any physics.
// The reforge helper keeps every artifact self-consistent, so only the named
// gate can fire.

describe('the fitness-vector gates: unsupported format, then malformed current format', () => {
  // A v2 vector for generation 0's six members, hand-built under the OLD
  // layout (22 B header + 14 B/member): a stale but otherwise coherent
  // artifact — the class PR 29 exists to report accurately.
  const v2VectorBytes = () => {
    const bytes = new Uint8Array(22 + 6 * 14);
    const view = new DataView(bytes.buffer);
    let o = 0;
    view.setUint16(o, 2, true); o += 2; // fitnessVectorVersion 2 — the stale one
    view.setUint16(o, 2, true); o += 2;
    view.setUint16(o, 1, true); o += 2;
    view.setUint16(o, 1, true); o += 2;
    view.setUint32(o, 1, true); o += 4; // snapshot digest state (opaque to the gate)
    view.setUint16(o, 1, true); o += 2;
    view.setUint32(o, 2, true); o += 4; // spec digest state
    view.setUint32(o, 6, true); o += 4;
    for (let id = 0; id < 6; id += 1) {
      view.setUint32(o, id, true); o += 4;
      view.setUint8(o, 1); o += 1;
      view.setUint8(o, 0); o += 1;
      view.setFloat64(o, id + 0.5, true); o += 8;
    }
    return bytes;
  };

  // Decode generation 0's vector, rewrite ONE member, and re-encode through
  // the production encoder (guaranteed codec-legal), so only Gate B can fire.
  const reforgeVector = async (artifact, rewriteMemberZero) => reforge(artifact, {
    mutateRecord: (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      const individuals = decoded.individuals.map((row, i) => (i === 0 ? rewriteMemberZero(row) : row));
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: decoded.populationSnapshotDigestState,
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals,
      });
    },
  });

  test('a stale v2 vector inside an otherwise-current artifact is `unsupportedVersion`, named exactly, before physics', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => { record.components.fitnessVector = v2VectorBytes(); },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'unsupportedVersion', /fitnessVectorVersion/);
    expect(err.context).toMatchObject({
      field: 'fitnessVectorVersion', generationIndex: 0, stored: 2, current: 3,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  // The layered peek: the vector version is read first; only when current are
  // the remaining four declared fields compared — each names ITSELF.
  test.each([
    ['fitnessPolicyVersion', 2, 2],
    ['integrityPolicyVersion', 4, 1],
    ['snapshotVersion', 6, 1],
    ['evaluationSpecVersion', 12, 1],
  ])('a current vector whose %s is stale names THAT field, not the vector version', async (field, offset, current) => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        const v = new Uint8Array(record.components.fitnessVector);
        new DataView(v.buffer).setUint16(offset, 9, true);
        record.components.fitnessVector = v;
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'unsupportedVersion', new RegExp(field));
    expect(err.context).toMatchObject({
      field, generationIndex: 0, stored: 9, current,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test.each([[1], [10]])('a %s-byte vector component is `malformedHistory`, not unsupported — the prefix is unreadable', async (length) => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        record.components.fitnessVector = record.components.fitnessVector.slice(0, length);
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    await expectCodeAsync(() => resumeEvolutionRun(broken), 'malformedHistory', /prefix/);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a TWO-byte component naming a STALE version is `unsupportedVersion` — the peek is layered, not greedy', async () => {
    // The layered peek reads fitnessVectorVersion (2 bytes) and STOPS when it
    // is not current, so a stale version is reportable from its two readable
    // bytes. A greedy peek would try the remaining current-layout fields,
    // hit the truncation, and misreport `malformedHistory`.
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        record.components.fitnessVector = Uint8Array.of(2, 0); // fitnessVectorVersion 2, nothing else
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'unsupportedVersion', /fitnessVectorVersion/);
    expect(err.context).toMatchObject({ field: 'fitnessVectorVersion', stored: 2, current: 3 });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('THE LADDER, gate A before gate B: unsupported format beats malformed current format', async () => {
    // Generation 0 carries a Gate-B violation (an onset step beyond
    // executedSteps); generation 1 carries a Gate-A violation (a stale
    // fitnessPolicyVersion). The compatibility verdict must surface FIRST —
    // "unsupported format" precedes "malformed current format" in the
    // documented escalation ladder.
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        const v = new Uint8Array(record.components.fitnessVector);
        if (i === 0) {
          new DataView(v.buffer).setUint8(22 + 38, 1);
          new DataView(v.buffer).setUint32(22 + 39, 4000000000, true);
        } else {
          new DataView(v.buffer).setUint16(2, 9, true); // fitnessPolicyVersion 9
        }
        record.components.fitnessVector = v;
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'unsupportedVersion', /fitnessPolicyVersion/);
    expect(err.context).toMatchObject({ field: 'fitnessPolicyVersion', generationIndex: 1, stored: 9, current: 2 });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('an onset step beyond the generation’s own executedSteps is `malformedHistory` BEFORE physics', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        const v = new Uint8Array(record.components.fitnessVector);
        const view = new DataView(v.buffer);
        // Member 0's firstAlertStep: present, payload 4_000_000_000 — a legal
        // u32 and a legal codec row, absurd against executedSteps 45. Without
        // Gate B this passed every digest, version and runtime check and
        // surfaced as `replayDivergence` after a full re-simulation.
        view.setUint8(22 + 38, 1);
        view.setUint32(22 + 39, 4000000000, true);
        record.components.fitnessVector = v;
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /firstAlertStep 4000000000 exceeds executedSteps 45/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0, field: 'firstAlertStep', stored: 4000000000, executedSteps: 45,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a catastrophic step beyond executedSteps names its own field', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforgeVector(artifact, (row) => ({
      ...row,
      valid: false,
      integrityStatus: 'numericalDivergence',
      fitness: 0,
      integrityObservations: {
        // alert <= cat and both u32-legal, so the codec accepts; the
        // catastrophic step is absurd against executedSteps 45.
        peakBodySpeed: 1500,
        peakSpeedDelta: 0,
        peakStepDisplacement: 0,
        firstAlertStep: 10,
        firstCatastrophicStep: 4000000000,
      },
    }));
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /firstCatastrophicStep 4000000000 exceeds executedSteps 45/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0, field: 'firstCatastrophicStep', stored: 4000000000, executedSteps: 45,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a vector whose byte length exceeds the capped header population is `malformedHistory` BEFORE allocation or physics', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        const decoded = deserializeFitnessVector(record.components.fitnessVector);
        const last = decoded.individuals.at(-1);
        record.components.fitnessVector = serializeFitnessVector({
          populationSnapshotDigestState: decoded.populationSnapshotDigestState,
          evaluationSpecDigestState: decoded.evaluationSpecDigestState,
          individuals: [...decoded.individuals, { ...last, individualId: last.individualId + 1 }],
        });
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /header populationSize 6/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      rule: 'fitnessVectorPopulationSizeOverflow',
      populationSize: 6,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test.each([
    ['a peak over the alert threshold with NO alert step recorded',
      { peakBodySpeed: 100 }, null, true],
    ['an alert step recorded with peaks that never cross',
      { peakBodySpeed: 0, peakSpeedDelta: 0, peakStepDisplacement: 0 }, 3, false],
  ])('the peak<->alert equivalence is enforced per member: %s is `malformedHistory`', async (_name, peaks, alertStep, alertImplied) => {
    const artifact = await runGenerations(1);
    const broken = await reforgeVector(artifact, (row) => ({
      ...row,
      integrityObservations: {
        ...row.integrityObservations,
        ...peaks,
        firstAlertStep: alertStep,
      },
    }));
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /contradicts its own observations/,
    );
    expect(err.context).toMatchObject({ generationIndex: 0, alertImplied });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('an alert onset at capture 0 requires a body-speed crossing BEFORE physics', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforgeVector(artifact, (row) => ({
      ...row,
      integrityObservations: {
        ...row.integrityObservations,
        peakBodySpeed: 0,
        peakSpeedDelta: 100,
        peakStepDisplacement: 0,
        firstAlertStep: 0,
      },
    }));
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /capture 0.*body-speed/i,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      individualId: 0,
      rule: 'captureZeroAlertCause',
      firstAlertStep: 0,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a capture-0 alert is not provably malformed when the whole-run body-speed peak crossed', async () => {
    const artifact = await runGenerations(1);
    const accepted = await reforgeVector(artifact, (row) => ({
      ...row,
      integrityObservations: {
        ...row.integrityObservations,
        peakBodySpeed: 100,
        peakSpeedDelta: 0,
        peakStepDisplacement: 0,
        firstAlertStep: 0,
      },
    }));
    globalThis.__replayProbe.evaluations = 0;
    // v3's aggregate cannot prove WHEN the body-speed peak occurred. Reaching
    // replay divergence proves Gate B correctly abstained from claiming that
    // the capture-0 timestamp itself was attested.
    const err = await expectCodeAsync(() => resumeEvolutionRun(accepted), 'replayDivergence');
    expect(err.context.stage).toBe('fitnessVector');
    expect(globalThis.__replayProbe.evaluations).toBeGreaterThan(0);
  });

  test('a byte flipped INSIDE the v3 observation region is `componentDigestMismatch` — the observations are inside component identity', async () => {
    const artifact = await runGenerations(1);
    const framing = decodeHistoryFraming(artifact);
    const payload = decodeGenerationPayload(framing.generations[0].payloadBytes);
    const payloadStart = 8 + 2 + 4 + framing.headerBytes.length + SHA256_DIGEST_BYTES + 4 + 4;
    // Payload header (u16 + u32 + u8), then the population and metadata
    // frames (u32 length + bytes + 32-byte digest each), then the vector's
    // own u32 length: member 0's peakBodySpeed sits at vector + 22 + 14.
    const vectorStart = payloadStart + 2 + 4 + 1
      + 4 + payload.components.population.length + SHA256_DIGEST_BYTES
      + 4 + payload.components.evaluationMetadata.length + SHA256_DIGEST_BYTES
      + 4;
    const broken = new Uint8Array(artifact);
    broken[vectorStart + 22 + 14] ^= 0xff;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'componentDigestMismatch');
    expect(err.context.component).toBe('fitnessVector');
    expect(err.context.generationIndex).toBe(0);
  });

  test('THE LADDER: corruption beats format — an in-place flip on the stale v2 fixture is `componentDigestMismatch`', async () => {
    const fixture = kimiFixtureBytes();
    const framing = decodeHistoryFraming(fixture);
    const payloadStart = 8 + 2 + 4 + framing.headerBytes.length + SHA256_DIGEST_BYTES + 4 + 4;
    const broken = new Uint8Array(fixture);
    broken[payloadStart + 2 + 4 + 1 + 4 + 10] ^= 0xff; // inside the population component
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'componentDigestMismatch');
    expect(err.context.component).toBe('population');
  });

  test('THE LADDER: staleness beats format — the stale v2 fixture with a wrong expectation is `staleOrWrongArtifact`', async () => {
    const fixture = kimiFixtureBytes();
    const wrongDigest = await sha256(Uint8Array.of(0));
    await expectCodeAsync(
      () => resumeEvolutionRun(fixture, { expectedHistoryDigestBytes: wrongDigest }),
      'staleOrWrongArtifact',
    );
  });
});


// ============================================================================
// (8) THE CATASTROPHIC COHERENCE RULE AND THE NESTED METADATA-VERSION GATE
// ============================================================================
// The peak<->catastrophic equivalence is the SAME producer contract one band
// up from the alert rule: firstCatastrophicStep is present IFF either
// catastrophic arm crossed (peakBodySpeed > catastrophicSpeed, ABSOLUTE, or
// peakStepDisplacement > catastrophicStepDisplacement * dtScale — there is NO
// catastrophic speed-delta arm). At capture 0 only body speed is available;
// there is no previous sample from which to derive displacement. And the
// evaluation metadata component owns its own nested version: a stale one is
// `unsupportedVersion`, never `malformedHistory`. Every artifact below is a
// self-consistent reforge, so only the named gate can fire.

describe('the peak<->catastrophic equivalence and the nested metadata version', () => {
  // Rewrite ONE generation-0 member's observation row (and, when a case needs
  // it, its status/validity) and re-encode through the production encoder, so
  // every artifact is codec-legal and only Gate B's semantics can fire.
  const reforgeMemberZero = async (artifact, rewrite) => reforge(artifact, {
    mutateRecord: (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      const individuals = decoded.individuals.map((row, i) => (i === 0 ? rewrite(row) : row));
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: decoded.populationSnapshotDigestState,
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals,
      });
    },
  });

  const okRow = (observations) => (row) => ({
    ...row,
    valid: false,
    integrityStatus: 'ok',
    fitness: 0,
    integrityObservations: { ...row.integrityObservations, ...observations },
  });

  // The applied displacement thresholds for the fixture's persisted
  // effectiveDt (0.01666666753590107 = Math.fround(1/60)), computed OFFLINE
  // from the frozen policy constants — copy-declared here, never derived from
  // the gate under test:
  //   dtScale = 0.01666666753590107 / (1/60) = 1.0000000521540642
  //   catastrophic step displacement = (1000/60) * dtScale
  const CAT_DISP_APPLIED = 16.66666753590107; // exactly at the applied threshold
  const CAT_DISP_ONE_ABOVE = 16.666667535901073; // one representable value above
  // A foreign persisted dt (Math.fround(1/30) = 0.03333333507180214) doubles
  // the scale, so the SAME peak (20 m/capture) is a catastrophic crossing
  // under the fixture's real dt but not under the foreign one:
  //   real:    20 > 16.66666753590107   (crossing)
  //   foreign: 20 < 33.33333507180214   (no crossing)
  const FOREIGN_DT = 0.03333333507180214; // Math.fround(1/30)

  const withForeignDt = async (artifact) => reforge(artifact, {
    mutateRecord: (record) => {
      const metadata = deserializeEvaluationMetadata(record.components.evaluationMetadata);
      record.components.evaluationMetadata = serializeEvaluationMetadata({
        ...metadata, effectiveDt: FOREIGN_DT,
      });
    },
  });

  test.each([
    ['peakBodySpeed above the absolute catastrophic speed, no step recorded',
      { peakBodySpeed: 1500, firstAlertStep: 2, firstCatastrophicStep: null }],
    ['peakStepDisplacement above the scaled catastrophic threshold, no step recorded',
      { peakStepDisplacement: 20, firstAlertStep: 2, firstCatastrophicStep: null }],
    ['one representable value above the catastrophic speed, no step recorded',
      { peakBodySpeed: 1000.0000000000001, firstAlertStep: 2, firstCatastrophicStep: null }],
    ['one representable value above the scaled displacement threshold, no step recorded',
      { peakStepDisplacement: CAT_DISP_ONE_ABOVE, firstAlertStep: 2, firstCatastrophicStep: null }],
  ])('a catastrophic arm crossed with no catastrophic step is `malformedHistory` (%s)', async (_name, observations) => {
    const artifact = await runGenerations(1);
    const broken = await reforgeMemberZero(artifact, okRow(observations));
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /peaks cross the catastrophic thresholds/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      individualId: 0,
      rule: 'peakCatastrophicEquivalence',
      firstCatastrophicStep: null,
      catastrophicImplied: true,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a catastrophic step with NEITHER arm crossed is `malformedHistory`, naming the recorded step', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforgeMemberZero(artifact, (row) => ({
      ...row,
      valid: false,
      integrityStatus: 'numericalDivergence',
      fitness: 0,
      integrityObservations: {
        // 40 m/s crosses the ALERT band (coherent with the recorded alert
        // step) but not the catastrophic one — so only the catastrophic rule
        // can fire.
        peakBodySpeed: 40,
        peakSpeedDelta: 0,
        peakStepDisplacement: 0,
        firstAlertStep: 2,
        firstCatastrophicStep: 4,
      },
    }));
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /peaks never cross the catastrophic thresholds/,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      individualId: 0,
      rule: 'peakCatastrophicEquivalence',
      firstCatastrophicStep: 4,
      catastrophicImplied: false,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a catastrophic onset at capture 0 requires a body-speed crossing BEFORE physics', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforgeMemberZero(artifact, (row) => ({
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
    }));
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /capture 0.*body-speed/i,
    );
    expect(err.context).toMatchObject({
      generationIndex: 0,
      individualId: 0,
      rule: 'captureZeroCatastrophicCause',
      firstCatastrophicStep: 0,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a capture-0 catastrophic onset is not provably malformed when the whole-run body-speed peak crossed', async () => {
    const artifact = await runGenerations(1);
    const accepted = await reforgeMemberZero(artifact, (row) => ({
      ...row,
      valid: false,
      integrityStatus: 'numericalDivergence',
      fitness: 0,
      integrityObservations: {
        peakBodySpeed: 1500,
        peakSpeedDelta: 0,
        peakStepDisplacement: 0,
        firstAlertStep: 0,
        firstCatastrophicStep: 0,
      },
    }));
    globalThis.__replayProbe.evaluations = 0;
    // The persisted peak is a necessary-cause witness, not a timestamp. Replay
    // divergence proves the semantic gate abstained when it could not disprove
    // capture 0 from v3's aggregates alone.
    const err = await expectCodeAsync(() => resumeEvolutionRun(accepted), 'replayDivergence');
    expect(err.context.stage).toBe('fitnessVector');
    expect(globalThis.__replayProbe.evaluations).toBeGreaterThan(0);
  });

  test.each([
    ['body speed EXACTLY at the catastrophic threshold', { peakBodySpeed: 1000, firstAlertStep: 2, firstCatastrophicStep: null }],
    ['step displacement EXACTLY at its applied threshold', { peakStepDisplacement: CAT_DISP_APPLIED, firstAlertStep: 2, firstCatastrophicStep: null }],
  ])('a value exactly at a threshold does not cross — the row is accepted (%s)', async (_name, observations) => {
    const artifact = await runGenerations(1);
    const accepted = await reforgeMemberZero(artifact, okRow(observations));
    globalThis.__replayProbe.evaluations = 0;
    // The gate passes; only replay finds the mutated vector differs from the
    // derived one — which is exactly what proves the gate accepted the row.
    const err = await expectCodeAsync(() => resumeEvolutionRun(accepted), 'replayDivergence');
    expect(err.context.stage).toBe('fitnessVector');
    expect(globalThis.__replayProbe.evaluations).toBeGreaterThan(0);
  });

  test('+Infinity implies a catastrophic crossing — accepted when the step is recorded', async () => {
    const artifact = await runGenerations(1);
    const accepted = await reforgeMemberZero(artifact, (row) => ({
      ...row,
      valid: false,
      integrityStatus: 'numericalDivergence',
      fitness: 0,
      integrityObservations: {
        peakBodySpeed: Infinity,
        peakSpeedDelta: 0,
        peakStepDisplacement: 0,
        firstAlertStep: 2,
        firstCatastrophicStep: 2,
      },
    }));
    const err = await expectCodeAsync(() => resumeEvolutionRun(accepted), 'replayDivergence');
    expect(err.context.stage).toBe('fitnessVector');
  });

  test.each([
    ['with a later catastrophic crossing its peaks imply', {
      peakBodySpeed: 1500, peakSpeedDelta: 0, peakStepDisplacement: 0,
      firstAlertStep: 2, firstCatastrophicStep: 4,
    }],
    ['with no crossing at all', {
      peakBodySpeed: 12, peakSpeedDelta: 0, peakStepDisplacement: 0,
      firstAlertStep: null, firstCatastrophicStep: null,
    }],
  ])("a 'nonFinite' row remains legal %s", async (_name, observations) => {
    const artifact = await runGenerations(1);
    const accepted = await reforgeMemberZero(artifact, (row) => ({
      ...row,
      valid: false,
      integrityStatus: 'nonFinite',
      fitness: 0,
      integrityObservations: { ...row.integrityObservations, ...observations },
    }));
    const err = await expectCodeAsync(() => resumeEvolutionRun(accepted), 'replayDivergence');
    expect(err.context.stage).toBe('fitnessVector');
  });

  test('the verdict follows the PERSISTED effectiveDt — the same peak flips with the metadata, never a global assumption', async () => {
    const artifact = await runGenerations(1);
    const row = okRow({ peakStepDisplacement: 20, firstAlertStep: 2, firstCatastrophicStep: null });
    // Under the fixture's real dt, 20 m/capture crosses the scaled threshold.
    const realDt = await reforgeMemberZero(artifact, row);
    globalThis.__replayProbe.evaluations = 0;
    await expectCodeAsync(() => resumeEvolutionRun(realDt), 'malformedHistory', /catastrophic/);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
    // The SAME row under a foreign persisted dt does not cross — the gate
    // accepts (replay then reports the mutated metadata, proving the verdict
    // was computed from the persisted dt and not the runtime's).
    const foreignDt = await reforgeMemberZero(await withForeignDt(artifact), row);
    const err = await expectCodeAsync(() => resumeEvolutionRun(foreignDt), 'replayDivergence');
    expect(err.context.stage).toBe('evaluationMetadata');
  });

  test('each generation is judged against its OWN metadata — a foreign dt in generation 0 does not leak into generation 1', async () => {
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i !== 0) return;
        const metadata = deserializeEvaluationMetadata(record.components.evaluationMetadata);
        record.components.evaluationMetadata = serializeEvaluationMetadata({
          ...metadata, effectiveDt: FOREIGN_DT,
        });
        const decoded = deserializeFitnessVector(record.components.fitnessVector);
        const individuals = decoded.individuals.map((row, m) => (m === 0 ? okRow({
          peakStepDisplacement: 20, firstAlertStep: 2, firstCatastrophicStep: null,
        })(row) : row));
        record.components.fitnessVector = serializeFitnessVector({
          populationSnapshotDigestState: decoded.populationSnapshotDigestState,
          evaluationSpecDigestState: decoded.evaluationSpecDigestState,
          individuals,
        });
      },
    });
    // Generation 0's row is coherent under ITS OWN (foreign) metadata and
    // generation 1 is untouched: the gate passes both (replay then reports
    // generation 0's mutated metadata). A global-dt bug would misreport
    // malformedHistory here.
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('evaluationMetadata');
    expect(err.context.generationIndex).toBe(0);
  });

  test('a current fitness vector with a STALE evaluationMetadataVersion is `unsupportedVersion`, named exactly, before physics', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        const m = new Uint8Array(record.components.evaluationMetadata);
        new DataView(m.buffer).setUint16(0, 0, true); // evaluationMetadataVersion 1 -> 0
        record.components.evaluationMetadata = m;
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'unsupportedVersion', /evaluationMetadataVersion/,
    );
    expect(err.context).toMatchObject({
      field: 'evaluationMetadataVersion', generationIndex: 0, stored: 0, current: 1,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test.each([
    ['a ONE-byte metadata component (the version prefix itself is unreadable)', 1],
    ['a ten-byte metadata component (a current version, then truncation)', 10],
  ])('truncated metadata is `malformedHistory`, not unsupported — %s', async (_name, length) => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        record.components.evaluationMetadata = record.components.evaluationMetadata.slice(0, length);
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    await expectCodeAsync(() => resumeEvolutionRun(broken), 'malformedHistory', /malformed/);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a current metadata version followed by INVALID content is `malformedHistory`, naming the component', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        const m = new Uint8Array(record.components.evaluationMetadata);
        new DataView(m.buffer).setFloat64(3, NaN, true); // effectiveDt must be finite and > 0
        record.components.evaluationMetadata = m;
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /evaluation metadata is malformed/,
    );
    expect(err.cause).toBeInstanceOf(Error);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('THE LADDER, nested versions: component corruption beats the nested version error', async () => {
    const artifact = await runGenerations(1);
    const framing = decodeHistoryFraming(artifact);
    const payload = decodeGenerationPayload(framing.generations[0].payloadBytes);
    const payloadStart = 8 + 2 + 4 + framing.headerBytes.length + SHA256_DIGEST_BYTES + 4 + 4;
    // Inside the evaluationMetadata component's effectiveDt field — the
    // digest stage must catch this BEFORE any version interpretation.
    const metadataStart = payloadStart + 2 + 4 + 1
      + 4 + payload.components.population.length + SHA256_DIGEST_BYTES + 4;
    const broken = new Uint8Array(artifact);
    broken[metadataStart + 5] ^= 0xff;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'componentDigestMismatch');
    expect(err.context.component).toBe('evaluationMetadata');
  });

  test('THE LADDER, nested versions: external staleness beats the nested version error', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        const m = new Uint8Array(record.components.evaluationMetadata);
        new DataView(m.buffer).setUint16(0, 0, true);
        record.components.evaluationMetadata = m;
      },
    });
    const wrongDigest = await sha256(Uint8Array.of(0));
    await expectCodeAsync(
      () => resumeEvolutionRun(broken, { expectedHistoryDigestBytes: wrongDigest }),
      'staleOrWrongArtifact',
    );
  });

  test('THE LADDER, nested versions: unsupported format beats current-format incoherence', async () => {
    // Generation 0 carries a Gate-B violation (an onset step beyond
    // executedSteps); generation 1 carries the stale metadata version.
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i === 0) {
          const v = new Uint8Array(record.components.fitnessVector);
          new DataView(v.buffer).setUint8(22 + 38, 1);
          new DataView(v.buffer).setUint32(22 + 39, 4000000000, true);
          record.components.fitnessVector = v;
        } else {
          const m = new Uint8Array(record.components.evaluationMetadata);
          new DataView(m.buffer).setUint16(0, 0, true);
          record.components.evaluationMetadata = m;
        }
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'unsupportedVersion', /evaluationMetadataVersion/);
    expect(err.context).toMatchObject({ field: 'evaluationMetadataVersion', generationIndex: 1 });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a valid current metadata component passes the nested-version gate unchanged', async () => {
    const artifact = await runGenerations(1);
    const resumed = await resumeEvolutionRun(artifact);
    expect(resumed.status().lastCommittedGenerationIndex).toBe(0);
  });

  // THE BLOCKING-CLASS PRECEDENCE, made global: unsupported format beats
  // malformed current format across EVERY generation and BOTH nested
  // components — a malformed prefix anywhere must never mask a stale version
  // anywhere else. Helpers mutate one generation's two nested components.
  const staleVector = (record) => {
    const v = new Uint8Array(record.components.fitnessVector);
    new DataView(v.buffer).setUint16(0, 2, true); // fitnessVectorVersion 3 -> 2 (readable, stale)
    record.components.fitnessVector = v;
  };
  const staleMetadata = (record) => {
    const m = new Uint8Array(record.components.evaluationMetadata);
    new DataView(m.buffer).setUint16(0, 0, true); // evaluationMetadataVersion 1 -> 0 (readable, stale)
    record.components.evaluationMetadata = m;
  };
  const truncateVector = (record) => {
    record.components.fitnessVector = record.components.fitnessVector.slice(0, 1);
  };
  const truncateMetadata = (record) => {
    record.components.evaluationMetadata = record.components.evaluationMetadata.slice(0, 1);
  };

  test.each([
    ['cross-generation: malformed vector prefix at 0, stale metadata version at 1',
      [truncateVector, staleMetadata], 'evaluationMetadataVersion', 1],
    ['cross-generation: stale metadata version at 0, malformed vector prefix at 1',
      [staleMetadata, truncateVector], 'evaluationMetadataVersion', 0],
    ['cross-generation: malformed metadata prefix at 0, stale vector version at 1',
      [truncateMetadata, staleVector], 'fitnessVectorVersion', 1],
    ['cross-generation: stale vector version at 0, malformed metadata prefix at 1',
      [staleVector, truncateMetadata], 'fitnessVectorVersion', 0],
    ['same generation: malformed vector prefix + stale metadata version',
      [(r) => { truncateVector(r); staleMetadata(r); }], 'evaluationMetadataVersion', 0],
    ['same generation: stale vector version + malformed metadata prefix',
      [(r) => { staleVector(r); truncateMetadata(r); }], 'fitnessVectorVersion', 0],
  ])('unsupported format wins globally — %s', async (_name, mutations, field, generationIndex) => {
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i < mutations.length) mutations[i](record);
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'unsupportedVersion', new RegExp(field));
    expect(err.context).toMatchObject({ field, generationIndex });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('with NO unsupported failure anywhere, a malformed prefix still reports `malformedHistory`', async () => {
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => { if (i === 1) truncateVector(record); },
    });
    globalThis.__replayProbe.evaluations = 0;
    await expectCodeAsync(() => resumeEvolutionRun(broken), 'malformedHistory', /version prefix/);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('each generation is judged against its OWN metadata — the same threshold-straddling row under two different persisted timesteps', async () => {
    // The row (peakStepDisplacement 20, alert step 2, no catastrophic step)
    // straddles the scaled catastrophic displacement threshold: a crossing
    // under generation 1's real dt (applied ≈ 16.667), NOT a crossing under
    // generation 0's foreign dt (applied ≈ 33.333). The correct verdict is a
    // refusal at GENERATION 1 only — a defect applying generation 0's
    // metadata to generation 1 would accept both, and one applying generation
    // 1's metadata to generation 0 would refuse at generation 0.
    const artifact = await runGenerations(2);
    const straddlingRow = okRow({
      peakStepDisplacement: 20, firstAlertStep: 2, firstCatastrophicStep: null,
    });
    const rewriteRow = (record) => {
      const decoded = deserializeFitnessVector(record.components.fitnessVector);
      const individuals = decoded.individuals.map((row, m) => (m === 0 ? straddlingRow(row) : row));
      record.components.fitnessVector = serializeFitnessVector({
        populationSnapshotDigestState: decoded.populationSnapshotDigestState,
        evaluationSpecDigestState: decoded.evaluationSpecDigestState,
        individuals,
      });
    };
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i === 0) {
          const metadata = deserializeEvaluationMetadata(record.components.evaluationMetadata);
          record.components.evaluationMetadata = serializeEvaluationMetadata({
            ...metadata, effectiveDt: FOREIGN_DT,
          });
        }
        rewriteRow(record);
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /catastrophic/,
    );
    expect(err.context).toMatchObject({
      // Member 0 of generation 1 — ids are allocated per generation, so it is
      // individualId 6 (generation 0's member 0 is individualId 0).
      generationIndex: 1, individualId: 6, rule: 'peakCatastrophicEquivalence', catastrophicImplied: true,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('a huge peakSpeedDelta alone does NOT imply a catastrophic crossing — there is no catastrophic speed-delta arm', async () => {
    // Sub-catastrophic body speed and displacement, an alert-implying peak
    // (coherent with the recorded alert step), and a peakSpeedDelta far above
    // the catastrophic SPEED: if a phantom catastrophic delta arm existed at
    // any threshold <= 5000 this row would be refused.
    const artifact = await runGenerations(1);
    const accepted = await reforgeMemberZero(artifact, okRow({
      peakBodySpeed: 100,
      peakSpeedDelta: 5000,
      peakStepDisplacement: 5,
      firstAlertStep: 2,
      firstCatastrophicStep: null,
    }));
    const err = await expectCodeAsync(() => resumeEvolutionRun(accepted), 'replayDivergence');
    expect(err.context.stage).toBe('fitnessVector');
  });
});
