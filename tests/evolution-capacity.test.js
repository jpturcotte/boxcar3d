// READER CAPACITY PARITY (PR 2 hardening): ONE shared history-capacity policy
// gate, applied by every reader, AFTER generation-zero provenance and BEFORE
// runtime identity, world creation, evaluation or replay.
//
// THE ORACLE RULE. The absolute boundary for this exact configuration
// (population 256 -> 228 generations) is pinned ONLY in
// tests/evolution-run.test.js. This file never asserts an absolute generation
// literal and never imports the projection: it reads `maximumFeasibleGenerations`
// ("mfg" below) out of the public creation gate's `resourceLimitExceeded`
// context, then checks every reader against THAT. The forged artifact declares
// mfg + 1 generations — 229 under the currently pinned geometry.
//
// RED-FIRST. Pre-fix, verified extraction did not apply the capacity gate at
// all and resume applied it only AFTER reading runtime identity, so the parity
// and precedence tests below failed (extraction accepted; resume tripped the
// identity probe; the combined capacity+runtime-mismatch fault reported the
// wrong code). The tests labeled CHARACTERIZATION were green both before and
// after; they pin combined-fault precedence the verifier already established.
//
// PROBE DISCIPLINE. Artifact construction reads the runtime identity ONCE (to
// bind the header's identity strings to this environment) and touches no other
// probe. beforeAll asserts that liveness, then zeroes every probe; every
// reader assertion below must leave all three counters at zero.

import {
  describe, test, expect, vi, beforeAll, beforeEach,
} from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

vi.mock('../src/sim/population-evaluation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    evaluatePopulation: async (population, spec) => {
      if (globalThis.__capacityProbe) globalThis.__capacityProbe.evaluations += 1;
      return original.evaluatePopulation(population, spec);
    },
  };
});

vi.mock('../src/sim/physics/adapter.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createPhysics: async (...args) => {
      if (globalThis.__capacityProbe) globalThis.__capacityProbe.worlds += 1;
      return original.createPhysics(...args);
    },
    readDeterministicRuntimeIdentity: async (...args) => {
      if (globalThis.__capacityProbe) globalThis.__capacityProbe.identityReads += 1;
      return original.readDeterministicRuntimeIdentity(...args);
    },
  };
});

const { createEvolutionRun, resumeEvolutionRun } = await import('../src/sim/evolution-run.js');
const {
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, EvolutionError, MAX_EVOLUTION_GENERATIONS,
} = await import('../src/sim/evolution-contract.js');
const {
  COMPONENT_KINDS, EVALUATION_METADATA_VERSION, GENERATION_RECORD_VERSION,
  MAX_EVOLUTION_HISTORY_BYTES, SHA256_DIGEST_BYTES,
  assembleHistory, digestComponent, digestGeneration, digestHeader,
  encodeEvolutionHeader, encodeGenerationPayload, serializeEvaluationMetadata,
} = await import('../src/sim/evolution-history.js');
const {
  EVOLUTION_LINEAGE_VERSION, serializeLineage, zeroLineageAccounting,
} = await import('../src/sim/evolution-lineage.js');
const {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_DEFAULTS, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE,
} = await import('../src/sim/evolution-operators.js');
const {
  createInitialPopulation, serializePopulationInitialization,
} = await import('../src/sim/population-initializer.js');
const { serializePopulationSnapshot } = await import('../src/sim/population.js');
const {
  FITNESS_VECTOR_VERSION, POPULATION_WORLD_MODE, canonicalizeEvaluationSpec, serializeFitnessVector,
} = await import('../src/sim/population-evaluation.js');
const { FNV_OFFSET_BASIS, fnv1aFold } = await import('../src/sim/fnv1a.js');
const { bytesToHex } = await import('../src/sim/bytes.js');
const { readDeterministicRuntimeIdentity } = await import('../src/sim/physics/adapter.js');
const { extractHistoryObservations } = await import('../scripts/history-observations.js');
const { reforge } = await import('./helpers/evolution-artifacts.js');
const {
  CAPACITY_POPULATION_SEED, createCapacityEvaluationSpec,
} = await import('./helpers/evolution-capacity-config.js');

const POPULATION_SIZE = 256;

function expectCode(fn, code, re) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  expect(threw, `expected a throw with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}

async function expectCodeAsync(promiseFn, code, re) {
  let threw = null;
  try { await promiseFn(); } catch (e) { threw = e; }
  expect(threw, `expected a rejection with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}

const expectNoProbes = () => expect(globalThis.__capacityProbe)
  .toEqual({ identityReads: 0, worlds: 0, evaluations: 0 });

const configAt = (populationSize, maxGenerations) => ({
  initialization: { seed: CAPACITY_POPULATION_SEED, populationSize },
  evaluationSpec: createCapacityEvaluationSpec(),
  evolution: { maxGenerations },
});

// Clean, coherence-legal v3 rows: null onsets and zero peaks imply no alert
// or catastrophic step under any positive dt, so the vector stays coherent
// with its sibling metadata (the okRow precedent in evolution-replay.test.js).
const cleanRow = (individualId) => ({
  individualId,
  valid: false,
  integrityStatus: 'ok',
  fitness: 0,
  integrityObservations: {
    peakBodySpeed: 0,
    peakSpeedDelta: 0,
    peakStepDisplacement: 0,
    firstAlertStep: null,
    firstCatastrophicStep: null,
  },
});

const withLeadingU16 = (bytes, value) => {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setUint16(0, value, true);
  return copy;
};

/**
 * A one-generation current-format artifact on the exact shared configuration,
 * synthesized from the real codecs with NO physics: the generation-zero
 * population comes from the deterministic initializer, every other component
 * is encoded directly, and the one committed record carries `terminalReason:
 * 'none'`. The runtime identity read below is construction-time only — it
 * binds the header's identity strings so the artifact is genuinely feasible
 * in this environment.
 */
async function buildFeasibleCapacityArtifact(maxGenerations) {
  const initialization = createInitialPopulation({
    seed: CAPACITY_POPULATION_SEED, populationSize: POPULATION_SIZE,
  });
  const initializationBytes = serializePopulationInitialization(initialization);
  const populationBytes = serializePopulationSnapshot(initialization.population);
  const specBytes = canonicalizeEvaluationSpec(createCapacityEvaluationSpec()).bytes;
  const metadataBytes = serializeEvaluationMetadata({
    worldMode: POPULATION_WORLD_MODE,
    effectiveDt: Math.fround(1 / 60),
    executedSteps: 45,
  });
  const vectorRows = [];
  const lineageRows = [];
  for (let i = 0; i < POPULATION_SIZE; i += 1) {
    vectorRows.push(cleanRow(i));
    lineageRows.push({
      individualId: i,
      parentIndividualId: null,
      origin: 'initialized',
      accounting: zeroLineageAccounting(),
    });
  }
  const fitnessVectorBytes = serializeFitnessVector({
    populationSnapshotDigestState: fnv1aFold(FNV_OFFSET_BASIS, populationBytes),
    evaluationSpecDigestState: fnv1aFold(FNV_OFFSET_BASIS, specBytes),
    individuals: vectorRows,
  });
  const lineageBytes = serializeLineage({
    lineageVersion: EVOLUTION_LINEAGE_VERSION, generationIndex: 0, individuals: lineageRows,
  });
  const runtime = await readDeterministicRuntimeIdentity();
  const headerBytes = encodeEvolutionHeader({
    evolutionEngineVersion: EVOLUTION_ENGINE_VERSION,
    evolutionPolicyVersion: EVOLUTION_POLICY_VERSION,
    generationRecordVersion: GENERATION_RECORD_VERSION,
    lineageVersion: EVOLUTION_LINEAGE_VERSION,
    evaluationMetadataVersion: EVALUATION_METADATA_VERSION,
    tournamentSelectionVersion: TOURNAMENT_SELECTION_VERSION,
    elitismVersion: ELITISM_VERSION,
    parametricMutationVersion: PARAMETRIC_MUTATION_VERSION,
    tournamentSize: TOURNAMENT_SIZE,
    eliteCount: ELITE_COUNT,
    physicsFlavor: runtime.physicsFlavor,
    packageName: runtime.packageName,
    rapierVersion: runtime.rapierVersion,
    populationSize: POPULATION_SIZE,
    maxGenerations,
    mutationProbability: PARAMETRIC_MUTATION_DEFAULTS.probability,
    mutationMagnitude: PARAMETRIC_MUTATION_DEFAULTS.magnitude,
    initializationManifestBytes: initializationBytes,
    evaluationSpecBytes: specBytes,
  });
  const headerDigestBytes = await digestHeader(headerBytes);
  const record = {
    generationIndex: 0,
    terminalReason: 'none',
    components: {
      population: populationBytes,
      evaluationMetadata: metadataBytes,
      fitnessVector: fitnessVectorBytes,
      lineage: lineageBytes,
    },
  };
  const digests = {};
  for (const kind of COMPONENT_KINDS) {
    digests[kind] = await digestComponent(kind, record.components[kind]);
  }
  const payloadBytes = encodeGenerationPayload(record, digests);
  const generationDigestBytes = await digestGeneration(headerDigestBytes, payloadBytes);
  return (await assembleHistory({
    headerBytes, headerDigestBytes, generations: [{ payloadBytes, generationDigestBytes }],
  })).bytes;
}

let mfg; // maximumFeasibleGenerations for the exact shared configuration
let sourceArtifact; // declares mfg generations — feasible
let forgedArtifact; // declares mfg + 1 — over the ceiling, digests re-attested
let staleVectorArtifact; // forged + readable stale fitness-vector version
let staleMetadataArtifact; // forged + readable stale evaluation-metadata version
let runtimeMismatchArtifact; // forged + a rapierVersion this environment is not

beforeAll(async () => {
  globalThis.__capacityProbe = { identityReads: 0, worlds: 0, evaluations: 0 };
  // The ONLY boundary oracle this file consults: the public creation gate's
  // refusal context on the exact shared configuration.
  const refusal = expectCode(
    () => createEvolutionRun(configAt(POPULATION_SIZE, MAX_EVOLUTION_GENERATIONS)),
    'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
  );
  mfg = refusal.context.maximumFeasibleGenerations;
  expect(Number.isInteger(mfg)).toBe(true);
  expect(mfg).toBeLessThan(MAX_EVOLUTION_GENERATIONS);

  sourceArtifact = await buildFeasibleCapacityArtifact(mfg);
  forgedArtifact = await reforge(sourceArtifact, {
    mutateHeader: (header) => ({ ...header, maxGenerations: mfg + 1 }),
  });
  staleVectorArtifact = await reforge(forgedArtifact, {
    mutateRecord: (record) => {
      record.components.fitnessVector = withLeadingU16(
        record.components.fitnessVector, FITNESS_VECTOR_VERSION - 1,
      );
    },
  });
  staleMetadataArtifact = await reforge(forgedArtifact, {
    mutateRecord: (record) => {
      record.components.evaluationMetadata = withLeadingU16(
        record.components.evaluationMetadata, EVALUATION_METADATA_VERSION - 1,
      );
    },
  });
  runtimeMismatchArtifact = await reforge(forgedArtifact, {
    mutateHeader: (header) => ({ ...header, rapierVersion: '99.99.99' }),
  });

  // Probe discipline: construction must have read the runtime identity (the
  // header binds it), and every probe is then zeroed BEFORE any reader runs.
  expect(globalThis.__capacityProbe.identityReads).toBeGreaterThan(0);
  globalThis.__capacityProbe = { identityReads: 0, worlds: 0, evaluations: 0 };
}, 240000);

beforeEach(() => {
  globalThis.__capacityProbe = { identityReads: 0, worlds: 0, evaluations: 0 };
});

// ============================================================================
// Grounding: the boundary is real in both directions through the public gate
// ============================================================================

describe('the authoritative capacity configuration', () => {
  test('the public creation gate bounds the exact shared configuration', () => {
    createEvolutionRun(configAt(POPULATION_SIZE, mfg)); // feasible: must not throw
    const above = expectCode(
      () => createEvolutionRun(configAt(POPULATION_SIZE, mfg + 1)),
      'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
    );
    expect(above.context).toMatchObject({
      maximumFeasibleGenerations: mfg,
      requestedGenerations: mfg + 1,
      limit: MAX_EVOLUTION_HISTORY_BYTES,
    });
    expect(above.context.projectedBytes).toBeGreaterThan(above.context.limit);
    expect(typeof above.context.generationFrameBytes).toBe('number');
    // Creation is physics-free by construction.
    expectNoProbes();
  });
});

// ============================================================================
// Parity: extraction and resume refuse the same artifact, identically, first
// ============================================================================

describe('capacity parity across both persisted readers', () => {
  test('verified extraction refuses the over-declared artifact before runtime identity', async () => {
    const err = await expectCodeAsync(
      () => extractHistoryObservations(forgedArtifact),
      'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
    );
    expect(err.context).toMatchObject({
      maximumFeasibleGenerations: mfg,
      requestedGenerations: mfg + 1,
      limit: MAX_EVOLUTION_HISTORY_BYTES,
    });
    expect(err.context.projectedBytes).toBeGreaterThan(err.context.limit);
    expect(typeof err.context.generationFrameBytes).toBe('number');
    expectNoProbes();
  });

  test('resume refuses the over-declared artifact before runtime identity', async () => {
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(forgedArtifact),
      'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
    );
    expect(err.context).toMatchObject({
      maximumFeasibleGenerations: mfg,
      requestedGenerations: mfg + 1,
      limit: MAX_EVOLUTION_HISTORY_BYTES,
    });
    expect(err.context.projectedBytes).toBeGreaterThan(err.context.limit);
    expect(typeof err.context.generationFrameBytes).toBe('number');
    expectNoProbes();
  });

  test('both readers report the identical capacity context', async () => {
    const extraction = await expectCodeAsync(
      () => extractHistoryObservations(forgedArtifact), 'resourceLimitExceeded',
    );
    const resume = await expectCodeAsync(
      () => resumeEvolutionRun(forgedArtifact), 'resourceLimitExceeded',
    );
    for (const field of [
      'projectedBytes', 'limit', 'maximumFeasibleGenerations',
      'requestedGenerations', 'generationFrameBytes',
    ]) {
      expect(extraction.context[field], field).toBe(resume.context[field]);
    }
    expectNoProbes();
  });

  test('a matching expected history digest does not rescue the over-declared artifact', async () => {
    // Artifact identity (stage 8) PASSES with the artifact's own digest; the
    // capacity gate must still fire — freshness never rescues a resource
    // refusal.
    const err = await expectCodeAsync(
      () => extractHistoryObservations(forgedArtifact, {
        expectedHistoryDigestBytes: forgedArtifact.slice(-SHA256_DIGEST_BYTES),
      }),
      'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
    );
    expect(err.context.requestedGenerations).toBe(mfg + 1);
    expectNoProbes();
  });
});

// ============================================================================
// Precedence: combined faults must report the EARLIER gate, never capacity
// masking identity problems nor identity problems masking capacity
// ============================================================================

describe('capacity precedence in the verification ladder', () => {
  // CHARACTERIZATION (green before and after the fix): stage 8 precedes stage
  // 11 by construction. Kept as a combined-fault guard so a future reorder
  // cannot let capacity mask a stale-or-wrong artifact.
  test('a wrong expected digest is reported before capacity by both readers', async () => {
    const wrongDigest = new Uint8Array(SHA256_DIGEST_BYTES);
    await expectCodeAsync(
      () => extractHistoryObservations(forgedArtifact, { expectedHistoryDigestBytes: wrongDigest }),
      'staleOrWrongArtifact',
    );
    await expectCodeAsync(
      () => resumeEvolutionRun(forgedArtifact, { expectedHistoryDigestBytes: wrongDigest }),
      'staleOrWrongArtifact',
    );
    expectNoProbes();
  });

  // CHARACTERIZATION (green before and after the fix). The claim is scoped to
  // the NESTED compatibility gates — the fitness-vector and evaluation-metadata
  // versions peeked inside the components. Header versions are interpreted at
  // stage 4 and are NOT covered by this ordering claim.
  test('a stale nested fitness-vector version is reported before capacity by both readers', async () => {
    await expectCodeAsync(
      () => extractHistoryObservations(staleVectorArtifact), 'unsupportedVersion',
    );
    await expectCodeAsync(
      () => resumeEvolutionRun(staleVectorArtifact), 'unsupportedVersion',
    );
    expectNoProbes();
  });

  test('a stale nested evaluation-metadata version is reported before capacity by both readers', async () => {
    await expectCodeAsync(
      () => extractHistoryObservations(staleMetadataArtifact), 'unsupportedVersion',
    );
    await expectCodeAsync(
      () => resumeEvolutionRun(staleMetadataArtifact), 'unsupportedVersion',
    );
    expectNoProbes();
  });

  // The PR-2 placement verdict: an impossible-capacity artifact that ALSO
  // names a runtime this environment is not must report capacity — the
  // earlier gate — and must never reach the runtime-identity read.
  test('capacity is reported before runtime identity by both readers', async () => {
    const extraction = await expectCodeAsync(
      () => extractHistoryObservations(runtimeMismatchArtifact),
      'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
    );
    const resume = await expectCodeAsync(
      () => resumeEvolutionRun(runtimeMismatchArtifact),
      'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
    );
    expect(extraction.context.requestedGenerations).toBe(mfg + 1);
    expect(resume.context.requestedGenerations).toBe(mfg + 1);
    expectNoProbes();
  });
});

// ============================================================================
// One relational assertion (NOT another absolute oracle)
// ============================================================================

describe('capacity monotonicity', () => {
  // This is RELATIONAL coverage, deliberately: both points come from the
  // public creation gate's refusal context, with no projection import, no
  // duplicated formula, and no absolute generation literal (the absolute pins
  // live in tests/evolution-run.test.js). A regression that preserved one
  // pinned point but broke the resource relationship — more population rows
  // somehow affording MORE history under the same byte ceiling — would still
  // fail here.
  test('a larger declared population never affords more history under the same byte ceiling', () => {
    const mfgAt = (populationSize) => expectCode(
      () => createEvolutionRun(configAt(populationSize, MAX_EVOLUTION_GENERATIONS)),
      'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
    ).context.maximumFeasibleGenerations;
    expect(mfgAt(256)).toBeLessThan(mfgAt(64));
    expectNoProbes();
  });
});

// ============================================================================
// Feasibility sanity: feasible artifacts pass the capacity-complete gate
// ============================================================================

describe('feasible artifacts through the capacity-complete gate', () => {
  test('the boundary-feasible synthesized source verifies and extracts', async () => {
    const extracted = await extractHistoryObservations(sourceArtifact);
    expect(extracted.generations.length).toBe(1);
    expect(extracted.generations[0].generationIndex).toBe(0);
    expectNoProbes();
    // Resume replay is deliberately NOT claimed for this artifact: its
    // synthesized zero-fitness record is verification-coherent but is not
    // real physics output, so deterministic replay must (and does) diverge
    // at the fitness vector. End-to-end continuation is proven on a real run
    // below — and across the whole replay suite, which now runs through the
    // same capacity-complete gate.
  });

  test('a real feasible run resumes and continues byte-identically', async () => {
    const run = createEvolutionRun(configAt(6, 2));
    await run.advance();
    const artifact = run.historyBytes();
    const resumedA = await resumeEvolutionRun(artifact);
    await resumedA.advance();
    const resumedB = await resumeEvolutionRun(artifact);
    await resumedB.advance();
    expect(bytesToHex(resumedA.historyBytes())).toBe(bytesToHex(resumedB.historyBytes()));
    // Feasible artifacts DO exercise physics on resume — reset so no later
    // assertion can confuse construction/reader probes with these.
    globalThis.__capacityProbe = { identityReads: 0, worlds: 0, evaluations: 0 };
  }, 240000);
});

// ============================================================================
// Static enforcement: the capacity policy gate has exactly one internal home
// ============================================================================

const CAPACITY_IMPORT = "import { assertHistoryCapacity } from './evolution-capacity.js';";

const SRC_FILES = [
  'src/main.js',
  ...['src/sim', 'src/ui', 'src/workers', 'src/platform', 'src/render']
    .flatMap((dir) => readdirSync(dir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => `${dir}/${name}`)),
];

describe('the capacity policy gate has exactly one internal home', () => {
  test('evolution-run.js imports the shared gate', () => {
    expect(readFileSync('src/sim/evolution-run.js', 'utf8')).toContain(CAPACITY_IMPORT);
  });

  test('evolution-replay.js imports the shared gate', () => {
    expect(readFileSync('src/sim/evolution-replay.js', 'utf8')).toContain(CAPACITY_IMPORT);
  });

  test('no src/ module re-exports the internal gate', () => {
    for (const file of SRC_FILES) {
      const source = readFileSync(file, 'utf8');
      const reExports = [...source.matchAll(/^\s*export[^;]*?from\s+'[^']*evolution-capacity\.js';/gm)];
      expect(reExports, `${file} must not re-export evolution-capacity.js`).toEqual([]);
    }
  });
});
