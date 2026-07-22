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
  deserializeEvaluationSpec, serializeEvaluationSpec,
} = await import('../src/sim/population-evaluation.js');
const {
  COMPONENT_KINDS, SHA256_DIGEST_BYTES, assembleHistory, decodeEvolutionHeader,
  decodeGenerationPayload, decodeHistoryFraming, digestComponent, digestGeneration,
  digestHeader, encodeEvolutionHeader, encodeGenerationPayload,
} = await import('../src/sim/evolution-history.js');
const { REPLAY_STAGES, firstByteDifference } = await import('../src/sim/evolution-replay.js');
const { bytesToHex } = await import('../src/sim/bytes.js');
const { sha256 } = await import('../src/platform/sha256.js');

const POPULATION_SEED = 20260740;
const TERRAIN_SEED = 20260741;

const INTEROP_CONFIG = Object.freeze({
  initialization: { seed: 20260721, populationSize: 4 },
  evaluationSpec: {
    terrain: {
      seed: 20260722, startFlatLength: 40, craterDensity: 0, featureDensity: 0,
      sandCoverage: 0, mudCoverage: 0, macroAmp: 0, microAmp: 0,
    },
    maxSteps: 60,
    deterministic: true,
    spawn: { x: -44, z: 0 },
  },
  evolution: { maxGenerations: 3, mutation: { probability: 0.5, magnitude: 0.1 } },
});

const kimiFixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v1-kimi-k3max.base64', import.meta.url), 'utf8').trim(),
  'base64',
));
const KIMI_TERMINAL_HISTORY_DIGEST = 'de7d8e495bea3b0297fa412db60ac88638bd84e4bf97992ecd571e91bbdb7210';

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
  test('an independently produced Kimi artifact resumes and continues byte-identically', async () => {
    const fixture = kimiFixtureBytes();
    expect(fixture.length).toBe(4024);
    expect(fixture[14 + 18]).toBe(0); // outer prefix + format-owned flavor byte

    const control = createEvolutionRun(INTEROP_CONFIG);
    await control.advance();
    const fixtureHeader = decodeEvolutionHeader(decodeHistoryFraming(fixture).headerBytes);
    const controlHeader = decodeEvolutionHeader(decodeHistoryFraming(control.historyBytes()).headerBytes);
    expect(controlHeader.rapierVersion,
      'engine changed — re-lock the independent evolution artifact deliberately')
      .toBe(fixtureHeader.rapierVersion);
    expect(bytesToHex(control.historyBytes())).toBe(bytesToHex(fixture));
    const resumed = await resumeEvolutionRun(fixture);

    while (control.status().phase !== 'terminal') {
      const a = await control.advance();
      const b = await resumed.advance();
      expect(bytesToHex(b.historyDigestBytes)).toBe(bytesToHex(a.historyDigestBytes));
      expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(control.historyBytes()));
    }
    expect(bytesToHex(control.historyBytes().slice(-32))).toBe(KIMI_TERMINAL_HISTORY_DIGEST);
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
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i === 0) record.components.population = flipByte(record.components.population, 40);
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
        if (i === 1) record.components.population = flipByte(record.components.population, 12);
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('population');
    expect(err.context.generationIndex).toBe(1);
    expect(err.context.lastAgreedGenerationIndex).toBe(0);
    expect(err.context.byteOffset).toBe(12);
    expect(typeof err.context.expectedByte).toBe('number');
    expect(typeof err.context.actualByte).toBe('number');
    expect(err.context.expectedByte).not.toBe(err.context.actualByte);
  });

  test("a changed executed-step count diverges at stage 'evaluationMetadata' — BEFORE fitness", async () => {
    // The whole reason the metadata component exists: a timestep or step-count
    // drift EXPLAINS a fitness difference, so it must be reported first.
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        const m = new Uint8Array(record.components.evaluationMetadata);
        new DataView(m.buffer).setUint32(11, 44, true); // executedSteps 45 -> 44
        record.components.evaluationMetadata = m;
      },
    });
    const err = await expectCodeAsync(() => resumeEvolutionRun(broken), 'replayDivergence');
    expect(err.context.stage).toBe('evaluationMetadata');
    expect(err.context.generationIndex).toBe(0);
  });

  test("a changed fitness value diverges at stage 'fitnessVector'", async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => {
        const v = new Uint8Array(record.components.fitnessVector);
        // The last member's f64 fitness, at the end of the fixed-stride vector.
        new DataView(v.buffer).setFloat64(v.length - 8, 1234.5, true);
        record.components.fitnessVector = v;
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
        if (i >= 1) record.components.population = flipByte(record.components.population, 8);
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
