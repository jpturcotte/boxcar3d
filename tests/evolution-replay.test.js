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
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION,
  deserializeEvaluationSpec, serializeEvaluationSpec,
} = await import('../src/sim/population-evaluation.js');
const {
  COMPONENT_KINDS, SHA256_DIGEST_BYTES, assembleHistory, decodeEvolutionHeader,
  decodeGenerationPayload, decodeHistoryFraming, deserializeEvaluationMetadata,
  digestComponent, digestGeneration,
  digestHeader, encodeEvolutionHeader, encodeGenerationPayload,
} = await import('../src/sim/evolution-history.js');
const {
  REPLAY_STAGES, checkFitnessVectorCompatibility, firstByteDifference,
  verifyFitnessVectorMetadataCoherence, verifyHistoryArtifact,
} = await import('../src/sim/evolution-replay.js');
const {
  INTEGRITY_POLICY_VERSION, INTEGRITY_REFERENCE_CAPTURE_DT, INTEGRITY_THRESHOLDS,
} = await import('../src/sim/integrity.js');
const { POPULATION_SNAPSHOT_VERSION } = await import('../src/sim/population.js');
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
const interopFixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v3-interop.base64', import.meta.url), 'utf8').trim(),
  'base64',
));
const INTEROP_TERMINAL_HISTORY_DIGEST = 'bc53c425b88c3cb549285749abc82282162a580f93b741632702028a6cbf247b';

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
  test('the committed v3 interop artifact resumes and continues byte-identically', async () => {
    const fixture = interopFixtureBytes();
    expect(fixture.length).toBe(4160);
    expect(fixture[14 + 18]).toBe(0); // outer prefix + format-owned flavor byte

    const control = createEvolutionRun(INTEROP_CONFIG);
    await control.advance();
    const fixtureHeader = decodeEvolutionHeader(decodeHistoryFraming(fixture).headerBytes);
    const controlHeader = decodeEvolutionHeader(decodeHistoryFraming(control.historyBytes()).headerBytes);
    expect(controlHeader.rapierVersion,
      'engine changed — re-lock the interop evolution artifact deliberately (scripts/relock-evolution-interop.js)')
      .toBe(fixtureHeader.rapierVersion);
    expect(bytesToHex(control.historyBytes())).toBe(bytesToHex(fixture));
    const resumed = await resumeEvolutionRun(fixture);

    while (control.status().phase !== 'terminal') {
      const a = await control.advance();
      const b = await resumed.advance();
      expect(bytesToHex(b.historyDigestBytes)).toBe(bytesToHex(a.historyDigestBytes));
      expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(control.historyBytes()));
    }
    expect(bytesToHex(control.historyBytes().slice(-32))).toBe(INTEROP_TERMINAL_HISTORY_DIGEST);
  });

  test('the independently produced Kimi v2 artifact is REFUSED before any physics (the early-refusal witness)', async () => {
    // The fixture's bytes are deliberately unmodified since its v2-era
    // production: its fitness vectors carry wire version 2, so the resume
    // path must refuse it at stage 8a — as staleness, never as corruption,
    // and with ZERO evaluations.
    const fixture = kimiFixtureBytes();
    expect(fixture.length).toBe(4024);
    const err = await expectCodeAsync(() => resumeEvolutionRun(fixture), 'unsupportedVersion',
      /fitnessVectorVersion is 2; this build implements 3/);
    expect(err.context.field).toBe('fitnessVectorVersion');
    expect(err.context.generationIndex).toBe(0);
    expect(err.context.stored).toBe(2);
    expect(err.context.current).toBe(3);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
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
// (2b) THE PRE-PHYSICS FITNESS-VECTOR GATES — stages 8a/8b (PR #30)
// ============================================================================

// v3 member layout inside the fitnessVector component: a 22-byte vector
// header, then 48 bytes per member. Relative to a member's base: id u32 @0,
// valid u8 @4, status u8 @5, fitness f64 @6, peakBodySpeed f64 @14,
// peakSpeedDelta f64 @22, peakStepDisplacement f64 @30, alert flag u8 @38 +
// step u32 @39, catastrophic flag u8 @43 + step u32 @44. The mutations below
// write RAW BYTES on purpose — the encoder refuses these vectors, so only a
// reforged artifact can carry them, which is exactly the gate's threat model.
const memberBase = (j) => 22 + j * 48;
const mutateVectorMember = (record, j, mutate) => {
  const vector = new Uint8Array(record.components.fitnessVector);
  mutate(new DataView(vector.buffer, vector.byteOffset, vector.byteLength), memberBase(j));
  record.components.fitnessVector = vector;
};

// evaluationMetadata wire layout: u16 version @0, u8 worldMode @2,
// f64 effectiveDt @3, u32 executedSteps @11 (the offset the divergence test
// below already uses). Gate B's whole point is that it trusts THIS record's
// persisted effectiveDt, so the scaling test rewrites exactly that field.
const mutateMetadataDt = (record, effectiveDt) => {
  const m = new Uint8Array(record.components.evaluationMetadata);
  new DataView(m.buffer, m.byteOffset, m.byteLength).setFloat64(3, effectiveDt, true);
  record.components.evaluationMetadata = m;
};

// The exact next representable f64 above a positive value — bit arithmetic,
// not a decimal epsilon that could round back onto the boundary itself.
const nextUp = (x) => {
  const f = new Float64Array(1);
  const u = new BigUint64Array(f.buffer);
  f[0] = x;
  u[0] += 1n;
  return f[0];
};

// Decode one generation's metadata straight from an artifact — used only to
// state test PRECONDITIONS about the unmutated run, so a physics or seed change
// fails these tests legibly instead of silently changing what they prove.
const decodedMetadata = (bytes, gen = 0) => deserializeEvaluationMetadata(
  decodeGenerationPayload(decodeHistoryFraming(bytes).generations[gen].payloadBytes)
    .components.evaluationMetadata,
);

// Gate B POSITIVE contrasts run the gates DIRECTLY over a verified artifact:
// a reforged history passes stages 3–7 but can never survive stage 10 (the
// bytes are, by construction, not what this engine reproduces), so “Gate B
// accepts this” is only observable at the gate seam itself.
async function gatesOver(bytes) {
  const verified = await verifyHistoryArtifact(bytes);
  checkFitnessVectorCompatibility(verified);
  return () => verifyFitnessVectorMetadataCoherence(verified);
}

describe('the pre-physics fitness-vector gates (8a compatibility, 8b coherence)', () => {
  test('Gate A: a stale fitnessVectorVersion is `unsupportedVersion`, named and localized, with zero evaluations', async () => {
    const artifact = await runGenerations(2);
    const broken = await reforge(artifact, {
      mutateRecord: (record, i) => {
        if (i !== 1) return; // only generation 1 goes stale — the error must say so
        const vector = new Uint8Array(record.components.fitnessVector);
        new DataView(vector.buffer, vector.byteOffset, vector.byteLength).setUint16(0, 2, true);
        record.components.fitnessVector = vector;
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'unsupportedVersion', /fitnessVectorVersion is 2; this build implements 3/,
    );
    expect(err.context).toMatchObject({
      field: 'fitnessVectorVersion', generationIndex: 1, stored: 2, current: 3,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('Gate A: a vector prefix too short to answer is `malformedHistory` — corruption, not staleness', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      // 4 bytes: the current version u16 plus one more field — the layered
      // peek must run out of prefix, not misread garbage.
      mutateRecord: (record) => {
        record.components.fitnessVector = record.components.fitnessVector.slice(0, 4);
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /too short to carry its version prefix/,
    );
    expect(err.context).toMatchObject({ generationIndex: 0 });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('Gate B: an alert onset past executedSteps is `malformedHistory`, localized, with zero evaluations', async () => {
    const artifact = await runGenerations(1); // maxSteps 45 ⇒ executedSteps 45
    const broken = await reforge(artifact, {
      mutateRecord: (record) => mutateVectorMember(record, 0, (view, base) => {
        view.setFloat64(base + 14, 30, true); // peakBodySpeed 30: the alert band fires…
        view.setUint8(base + 38, 1); // …and is declared…
        view.setUint32(base + 39, 46, true); // …one capture past executedSteps
      }),
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory', /firstAlertStep 46 exceeds executedSteps 45/,
    );
    expect(err.context).toMatchObject({
      field: 'firstAlertStep', generationIndex: 0, individualId: 0, onset: 46, executedSteps: 45,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('Gate B: an alert onset with every peak below its alert threshold is `malformedHistory`', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => mutateVectorMember(record, 0, (view, base) => {
        view.setFloat64(base + 14, 0, true); // all three peaks quiet…
        view.setFloat64(base + 22, 0, true);
        view.setFloat64(base + 30, 0, true);
        view.setUint8(base + 38, 1); // …yet an alert onset is declared
        view.setUint32(base + 39, 0, true);
        view.setUint8(base + 43, 0); // and no catastrophic onset
        view.setUint32(base + 44, 0, true);
      }),
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory',
      /declares firstAlertStep 0 but no retained peak exceeds an alert threshold/,
    );
    expect(err.context).toMatchObject({
      field: 'firstAlertStep', generationIndex: 0, individualId: 0, firstAlertStep: 0,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('Gate B: a catastrophic peak with no catastrophic onset is `malformedHistory`', async () => {
    const artifact = await runGenerations(1);
    const broken = await reforge(artifact, {
      mutateRecord: (record) => mutateVectorMember(record, 0, (view, base) => {
        view.setFloat64(base + 14, 1200, true); // peakBodySpeed above catastrophicSpeed 1000
        view.setUint8(base + 38, 1); // the alert onset IS coherently declared…
        view.setUint32(base + 39, 0, true);
        view.setUint8(base + 43, 0); // …but the catastrophic onset is denied
        view.setUint32(base + 44, 0, true);
      }),
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory',
      /declares no catastrophic onset but a retained peak exceeds a catastrophic threshold/,
    );
    expect(err.context).toMatchObject({
      field: 'firstCatastrophicStep', generationIndex: 0, individualId: 0, peakBodySpeed: 1200,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  // --- Gate A: TABLE-DRIVEN tests for each nested version field ---------------
  // The layered peek reads fitnessVectorVersion FIRST; if it is current the
  // remaining four are read and each checked independently. Each row below
  // forges a vector whose outer version is CURRENT so the peek trusts it, then
  // bumps exactly ONE of the four inner fields. The check array tells us which
  // offset to mutate — all u16 little-endian from the header start.
  const GATE_A_INNER_VERSIONS = [
    // [name, byteOffset from vector start, forged value, current constant]
    ['fitnessPolicyVersion', 2, 99, FITNESS_POLICY_VERSION],
    ['integrityPolicyVersion', 4, 99, INTEGRITY_POLICY_VERSION],
    ['snapshotVersion', 6, 99, POPULATION_SNAPSHOT_VERSION],
    ['evaluationSpecVersion', 12, 99, EVALUATION_SPEC_VERSION],
  ];
  test.each(GATE_A_INNER_VERSIONS)(
    'Gate A: a stale %s is unsupportedVersion (table-driven), named, localized at generation 1, zero evaluations',
    async (name, offset, forgedValue, current) => {
      const artifact = await runGenerations(2);
      const broken = await reforge(artifact, {
        mutateRecord: (record, i) => {
          if (i !== 1) return; // only generation 1 — error must say so
          const vector = new Uint8Array(record.components.fitnessVector);
          new DataView(vector.buffer, vector.byteOffset, vector.byteLength)
            .setUint16(offset, forgedValue, true);
          record.components.fitnessVector = vector;
        },
      });
      globalThis.__replayProbe.evaluations = 0;
      const err = await expectCodeAsync(
        () => resumeEvolutionRun(broken), 'unsupportedVersion',
        new RegExp(`${name} is ${forgedValue}; this build implements ${current}`),
      );
      expect(err.context).toMatchObject({
        field: name, generationIndex: 1, stored: forgedValue, current,
      });
      expect(globalThis.__replayProbe.evaluations).toBe(0);
    },
  );

  // --- Gate B: EFFECTIVE-DT SCALING -------------------------------------------
  // Gate B derives per-capture thresholds via:
  //   dtScale = metadata.effectiveDt / INTEGRITY_REFERENCE_CAPTURE_DT
  // A reforged artifact with a doubled effectiveDt doubles the per-capture
  // bounds: a peak that was below alertSpeedDelta×1 is still below
  // alertSpeedDelta×2 (passing) but would have EXCEEDED alertSpeedDelta×1
  // (failing). This proves Gate B uses the generation-local effectiveDt.
  test('Gate B: effective-dt scaling — a doubled dt widens per-capture bounds, proven by a value between the two thresholds', async () => {
    const artifact = await runGenerations(1);
    // PRECONDITION: the run used effectiveDt ≈ 1/60 (the reference interval).
    const meta = decodedMetadata(artifact);
    expect(meta.effectiveDt).toBeCloseTo(INTEGRITY_REFERENCE_CAPTURE_DT, 5);
    // The alert speedDelta threshold at 1× reference dt: 30 (per the policy).
    // At 2× reference dt: 60.
    const dtDoubled = INTEGRITY_REFERENCE_CAPTURE_DT * 2;
    // Choose a peak that sits BETWEEN the two thresholds: 45 m/s.
    // Under the generation's persisted effectiveDt=2×ref the threshold is 60,
    // so 45 is below → no alert needed. Under 1× ref the threshold is 30, so
    // 45 would exceed it → alert would be needed. The test PASSES Gate B
    // (positive contrast), proving the doubled dt is what Gate B uses.
    const passing = await reforge(artifact, {
      mutateRecord: (record) => {
        mutateMetadataDt(record, dtDoubled);
        mutateVectorMember(record, 0, (view, base) => {
          view.setFloat64(base + 14, 0, true); // peakBodySpeed quiet
          view.setFloat64(base + 22, 45, true); // peakSpeedDelta = 45
          view.setFloat64(base + 30, 0, true); // peakStepDisplacement quiet
          view.setUint8(base + 38, 0); // no alert declared
          view.setUint32(base + 39, 0, true);
          view.setUint8(base + 43, 0); // no catastrophic
          view.setUint32(base + 44, 0, true);
        });
      },
    });
    // Positive contrast: Gate B must accept this (the scaled threshold is 60,
    // and 45 < 60).
    globalThis.__replayProbe.evaluations = 0;
    const gateBCheck = await gatesOver(passing);
    expect(() => gateBCheck()).not.toThrow();
    expect(globalThis.__replayProbe.evaluations).toBe(0);
    // Negative contrast: same vector but REFERENCE dt (threshold = 30, and
    // 45 > 30 → alert required, not declared → malformedHistory).
    const failing = await reforge(artifact, {
      mutateRecord: (record) => {
        mutateMetadataDt(record, INTEGRITY_REFERENCE_CAPTURE_DT);
        mutateVectorMember(record, 0, (view, base) => {
          view.setFloat64(base + 14, 0, true);
          view.setFloat64(base + 22, 45, true);
          view.setFloat64(base + 30, 0, true);
          view.setUint8(base + 38, 0);
          view.setUint32(base + 39, 0, true);
          view.setUint8(base + 43, 0);
          view.setUint32(base + 44, 0, true);
        });
      },
    });
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(failing), 'malformedHistory',
      /declares no alert onset but a retained peak exceeds an alert threshold/,
    );
    expect(err.context).toMatchObject({
      field: 'firstAlertStep', generationIndex: 0, individualId: 0,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  // --- Gate B: STRICT THRESHOLD BOUNDARY (exact == does NOT require onset) ----
  test('Gate B: strict boundary — a peak EXACTLY at the threshold does NOT require an onset (positive), next-up DOES (negative)', async () => {
    const artifact = await runGenerations(1);
    const meta = decodedMetadata(artifact);
    // Absolute-speed threshold: alertSpeed = 25 m/s.
    // Strict `>`: exactly 25 does NOT fire; nextUp(25) DOES fire.
    const boundary = INTEGRITY_THRESHOLDS.alertSpeed;
    // Positive: peakBodySpeed = exactly 25, no alert declared.
    const passing = await reforge(artifact, {
      mutateRecord: (record) => {
        mutateMetadataDt(record, meta.effectiveDt);
        mutateVectorMember(record, 0, (view, base) => {
          view.setFloat64(base + 14, boundary, true); // exactly at threshold
          view.setFloat64(base + 22, 0, true);
          view.setFloat64(base + 30, 0, true);
          view.setUint8(base + 38, 0); // no alert
          view.setUint32(base + 39, 0, true);
          view.setUint8(base + 43, 0);
          view.setUint32(base + 44, 0, true);
        });
      },
    });
    const gateBCheck = await gatesOver(passing);
    expect(() => gateBCheck()).not.toThrow();
    // Negative: peakBodySpeed = nextUp(25) → alert fires, onset REQUIRED.
    const above = nextUp(boundary);
    expect(above).toBeGreaterThan(boundary); // sanity: actually bigger
    const failing = await reforge(artifact, {
      mutateRecord: (record) => {
        mutateMetadataDt(record, meta.effectiveDt);
        mutateVectorMember(record, 0, (view, base) => {
          view.setFloat64(base + 14, above, true); // just above
          view.setFloat64(base + 22, 0, true);
          view.setFloat64(base + 30, 0, true);
          view.setUint8(base + 38, 0); // no alert declared
          view.setUint32(base + 39, 0, true);
          view.setUint8(base + 43, 0);
          view.setUint32(base + 44, 0, true);
        });
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      async () => {
        const verified = await verifyHistoryArtifact(failing);
        checkFitnessVectorCompatibility(verified);
        verifyFitnessVectorMetadataCoherence(verified);
      }, 'malformedHistory',
      /declares no alert onset but a retained peak exceeds an alert threshold/,
    );
    expect(err.context.field).toBe('firstAlertStep');
    expect(err.context.individualId).toBe(0);
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  // --- Gate B: SCALED per-capture boundary (alertStepDisplacement) -----------
  test('Gate B: strict boundary on a per-capture scaled threshold (alertStepDisplacement)', async () => {
    const artifact = await runGenerations(1);
    const meta = decodedMetadata(artifact);
    const dtScale = meta.effectiveDt / INTEGRITY_REFERENCE_CAPTURE_DT;
    const scaledThreshold = INTEGRITY_THRESHOLDS.alertStepDisplacement * dtScale;
    // Exactly at threshold: no alert required.
    const passing = await reforge(artifact, {
      mutateRecord: (record) => {
        mutateMetadataDt(record, meta.effectiveDt);
        mutateVectorMember(record, 0, (view, base) => {
          view.setFloat64(base + 14, 0, true);
          view.setFloat64(base + 22, 0, true);
          view.setFloat64(base + 30, scaledThreshold, true); // exactly at threshold
          view.setUint8(base + 38, 0);
          view.setUint32(base + 39, 0, true);
          view.setUint8(base + 43, 0);
          view.setUint32(base + 44, 0, true);
        });
      },
    });
    const gateBCheck = await gatesOver(passing);
    expect(() => gateBCheck()).not.toThrow();
    // nextUp(scaledThreshold): alert required.
    const above = nextUp(scaledThreshold);
    const failing = await reforge(artifact, {
      mutateRecord: (record) => {
        mutateMetadataDt(record, meta.effectiveDt);
        mutateVectorMember(record, 0, (view, base) => {
          view.setFloat64(base + 14, 0, true);
          view.setFloat64(base + 22, 0, true);
          view.setFloat64(base + 30, above, true);
          view.setUint8(base + 38, 0); // no alert declared
          view.setUint32(base + 39, 0, true);
          view.setUint8(base + 43, 0);
          view.setUint32(base + 44, 0, true);
        });
      },
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      async () => {
        const verified = await verifyHistoryArtifact(failing);
        checkFitnessVectorCompatibility(verified);
        verifyFitnessVectorMetadataCoherence(verified);
      }, 'malformedHistory',
      /declares no alert onset but a retained peak exceeds an alert threshold/,
    );
    expect(err.context.field).toBe('firstAlertStep');
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  // --- Gate B: BOTH DIRECTIONS of catastrophic peak/onset equivalence --------
  test('Gate B: catastrophic onset declared but no catastrophic peak crosses a threshold is malformedHistory', async () => {
    const artifact = await runGenerations(1);
    // To pass the DECODER'S own policy-1 coherence (which requires
    // numericalDivergence to have a catastrophic step, and catastrophic requires
    // alert), we set integrityStatus = numericalDivergence (index 2),
    // valid = false, fitness = 0, alert onset present AND catastrophic onset
    // present. But the peaks are below the catastrophic thresholds. Gate B sees
    // the contradiction: onset declared, no peak above threshold.
    const broken = await reforge(artifact, {
      mutateRecord: (record) => mutateVectorMember(record, 0, (view, base) => {
        // id stays, valid = false (0), status = numericalDivergence (2), fitness = 0
        view.setUint8(base + 4, 0); // valid = false
        view.setUint8(base + 5, 2); // integrityStatus = numericalDivergence
        view.setFloat64(base + 6, 0, true); // fitness = 0
        view.setFloat64(base + 14, 500, true); // peakBodySpeed: above alert, below cat 1000
        view.setFloat64(base + 22, 0, true);
        view.setFloat64(base + 30, 0, true);
        view.setUint8(base + 38, 1); // alert onset present (required by decoder: cat→alert)
        view.setUint32(base + 39, 3, true);
        view.setUint8(base + 43, 1); // catastrophic onset CLAIMED
        view.setUint32(base + 44, 5, true);
      }),
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      async () => {
        const verified = await verifyHistoryArtifact(broken);
        checkFitnessVectorCompatibility(verified);
        verifyFitnessVectorMetadataCoherence(verified);
      }, 'malformedHistory',
      /declares firstCatastrophicStep 5 but no retained peak exceeds a catastrophic threshold/,
    );
    expect(err.context).toMatchObject({
      field: 'firstCatastrophicStep', generationIndex: 0, individualId: 0,
    });
    expect(globalThis.__replayProbe.evaluations).toBe(0);
  });

  test('Gate B: alert peak crosses a threshold but no alert onset is declared is malformedHistory', async () => {
    const artifact = await runGenerations(1);
    // peakBodySpeed = 30 (above alertSpeed 25): the alert predicate fires,
    // but onset is denied. Below catastrophicSpeed so no catastrophic issue.
    const broken = await reforge(artifact, {
      mutateRecord: (record) => mutateVectorMember(record, 0, (view, base) => {
        view.setFloat64(base + 14, 30, true); // above alertSpeed 25
        view.setFloat64(base + 22, 0, true);
        view.setFloat64(base + 30, 0, true);
        view.setUint8(base + 38, 0); // NO alert onset declared
        view.setUint32(base + 39, 0, true);
        view.setUint8(base + 43, 0);
        view.setUint32(base + 44, 0, true);
      }),
    });
    globalThis.__replayProbe.evaluations = 0;
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(broken), 'malformedHistory',
      /declares no alert onset but a retained peak exceeds an alert threshold/,
    );
    expect(err.context).toMatchObject({
      field: 'firstAlertStep', generationIndex: 0, individualId: 0,
    });
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
        // The last member's f64 fitness, at +6 within its 48-byte stride.
        new DataView(v.buffer).setFloat64(v.length - 48 + 6, 1234.5, true);
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
