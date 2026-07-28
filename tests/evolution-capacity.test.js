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
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, MAX_EVOLUTION_GENERATIONS,
} = await import('../src/sim/evolution-contract.js');
const {
  COMPONENT_KINDS, EVALUATION_METADATA_VERSION, GENERATION_RECORD_VERSION,
  MAX_EVOLUTION_HISTORY_BYTES, SHA256_DIGEST_BYTES,
  assembleHistory, decodeGenerationPayload, decodeHistoryFraming, digestComponent,
  digestGeneration, digestHeader, encodeEvolutionHeader, encodeGenerationPayload,
  serializeEvaluationMetadata,
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
const { serializeGenotype } = await import('../src/sim/assembly.js');
const {
  FITNESS_VECTOR_VERSION, POPULATION_WORLD_MODE, canonicalizeEvaluationSpec,
  deserializeFitnessVector, serializeFitnessVector,
} = await import('../src/sim/population-evaluation.js');
const { FNV_OFFSET_BASIS, fnv1aFold } = await import('../src/sim/fnv1a.js');
const { bytesToHex } = await import('../src/sim/bytes.js');
const { readDeterministicRuntimeIdentity } = await import('../src/sim/physics/adapter.js');
const { extractHistoryObservations } = await import('../scripts/history-observations.js');
const { reforge, withLeadingU16 } = await import('./helpers/evolution-artifacts.js');
const {
  CAPACITY_POPULATION_SEED, createCapacityEvaluationSpec,
} = await import('./helpers/evolution-capacity-config.js');
const { expectCode, expectCodeAsync } = await import('./helpers/expect-code.js');

const POPULATION_SIZE = 256;

const expectNoProbes = () => expect(globalThis.__capacityProbe)
  .toEqual({ identityReads: 0, worlds: 0, evaluations: 0 });

// The full refusal-context shape every capacity rejection must carry — one
// assertion site so all readers' contexts stay comparable field by field.
// `mfg` is assigned in beforeAll.
const expectCapacityContext = (err) => {
  expect(err.context).toMatchObject({
    maximumFeasibleGenerations: mfg,
    requestedGenerations: mfg + 1,
    limit: MAX_EVOLUTION_HISTORY_BYTES,
  });
  expect(err.context.projectedBytes).toBeGreaterThan(err.context.limit);
  expect(typeof err.context.generationFrameBytes).toBe('number');
};

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
let provenancePrefilterArtifact; // forged + manifest state left at the ORIGINAL population
let provenanceByteVerdictArtifact; // forged + every FNV state re-attested to the MUTATED population

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
  // Two provenance breaks, one per half of the recreation bind. The mutation
  // is computed ONCE so the header and record mutations agree on it.
  const sourceFraming = decodeHistoryFraming(sourceArtifact);
  const sourcePopulation = decodeGenerationPayload(
    sourceFraming.generations[0].payloadBytes,
  ).components.population;
  const mutatedPopulation = new Uint8Array(sourcePopulation);
  mutatedPopulation[26] ^= 0xff; // inside the first genotype row's bytes
  const mutatedPopulationState = fnv1aFold(FNV_OFFSET_BASIS, mutatedPopulation);
  const rebindVector = (record) => {
    record.components.population = mutatedPopulation;
    // Re-align the vector's population binding so the artifact survives
    // coherence and reaches the recreation bind itself.
    const vector = deserializeFitnessVector(record.components.fitnessVector);
    record.components.fitnessVector = serializeFitnessVector({
      ...vector,
      populationSnapshotDigestState: mutatedPopulationState,
    });
  };
  // The manifest's stored population state is left pointing at the ORIGINAL
  // population, so the bind's FNV PREFILTER is what fires.
  provenancePrefilterArtifact = await reforge(forgedArtifact, {
    mutateRecord: rebindVector,
  });
  // The manifest's stored population state (its final u32) is re-attested to
  // the MUTATED population, so the prefilter passes and the exact recreation
  // BYTE-COMPARE is what fires.
  provenanceByteVerdictArtifact = await reforge(forgedArtifact, {
    mutateHeader: (header) => {
      const manifestBytes = new Uint8Array(header.initializationManifestBytes);
      new DataView(manifestBytes.buffer).setUint32(manifestBytes.length - 4, mutatedPopulationState, true);
      return { ...header, initializationManifestBytes: manifestBytes };
    },
    mutateRecord: rebindVector,
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
    expectCapacityContext(above);
    // Creation is physics-free by construction.
    expectNoProbes();
  });
});

// ============================================================================
// Geometry pin: the projected population-snapshot framing IS the codec's
// ============================================================================

describe('the projected population-snapshot geometry', () => {
  // The capacity module mirrors the population codec's member framing
  // (2+2+4 header, 4+4+genotype per member) because population.js owns those
  // offsets and exports no framing constants. This pin makes a codec framing
  // change go RED here instead of silently under-projecting the history.
  test('matches the population codec byte for byte', () => {
    // Two sizes, so the header and the per-row framing are OVERdetermined —
    // one size would constrain only their sum.
    for (const populationSize of [8, 24]) {
      const { population } = createInitialPopulation({
        seed: CAPACITY_POPULATION_SEED, populationSize,
      });
      let codecFramedLength = 2 + 2 + 4;
      for (const individual of population.individuals) {
        codecFramedLength += 4 + 4 + serializeGenotype(individual.genotype).length;
      }
      expect(serializePopulationSnapshot(population).length).toBe(codecFramedLength);
    }
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
    expectCapacityContext(err);
    expectNoProbes();
  });

  test('resume refuses the over-declared artifact before runtime identity', async () => {
    const err = await expectCodeAsync(
      () => resumeEvolutionRun(forgedArtifact),
      'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
    );
    expectCapacityContext(err);
    expectNoProbes();
  });

  test('all three capacity paths report the identical five-field context', async () => {
    const creation = expectCode(
      () => createEvolutionRun(configAt(POPULATION_SIZE, mfg + 1)), 'resourceLimitExceeded',
    );
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
      expect(extraction.context[field], field).toBe(creation.context[field]);
      expect(resume.context[field], field).toBe(creation.context[field]);
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

  // One half of the placement contract: capacity closes stage 11 AFTER the
  // generation-zero recreation bind, so a provenance break must surface even
  // when the declared generation count is impossible too. Here the bind's FNV
  // PREFILTER fires (the manifest state points at the original population).
  test('a generation-zero prefilter mismatch is reported before capacity by both readers', async () => {
    for (const reader of [extractHistoryObservations, resumeEvolutionRun]) {
      const err = await expectCodeAsync(
        () => reader(provenancePrefilterArtifact), 'malformedHistory',
      );
      expect(err.context.rule).toBe('initializationPopulationDigestStateMismatch');
    }
    expectNoProbes();
  });

  // The exact half: with every FNV state re-attested to the MUTATED
  // population the prefilter passes, so the recreation BYTE-COMPARE itself
  // must fire — still before capacity. This is the ordering a capacity call
  // moved between the prefilter and the byte-compare would silently break.
  test('a generation-zero recreation byte-mismatch is reported before capacity by both readers', async () => {
    for (const reader of [extractHistoryObservations, resumeEvolutionRun]) {
      const err = await expectCodeAsync(
        () => reader(provenanceByteVerdictArtifact), 'malformedHistory',
      );
      expect(err.context.rule).toBe('initializationPopulationRecreationMismatch');
    }
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
    // Probe LIVENESS: this is the one test that must trip all three counters,
    // so the zero-assertions everywhere else can never pass vacuously — a
    // stale mock wiring fails HERE first.
    expect(globalThis.__capacityProbe.identityReads).toBeGreaterThan(0);
    expect(globalThis.__capacityProbe.worlds).toBeGreaterThan(0);
    expect(globalThis.__capacityProbe.evaluations).toBeGreaterThan(0);
    // Feasible artifacts DO exercise physics on resume — reset so no later
    // assertion can confuse construction/reader probes with these.
    globalThis.__capacityProbe = { identityReads: 0, worlds: 0, evaluations: 0 };
  }, 240000);
});

// ============================================================================
// Static enforcement: the capacity policy gate has exactly one internal home
// ============================================================================

const CAPACITY_IMPORT = "import { assertHistoryCapacity } from './evolution-capacity.js';";
const GATE_MODULE = 'src/sim/evolution-capacity.js';
const GATE_READERS = ['src/sim/evolution-run.js', 'src/sim/evolution-replay.js'];

// Recursive (nested families like src/sim/physics/ are included) and spanning
// scripts/ too, so no offline consumer can reach the internal gate. Outside
// the gate module and its two readers, ANY reference to the module fails —
// there is no import-shape regex to evade.
const walkJs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = `${dir}/${entry.name}`;
  return entry.isDirectory() ? walkJs(path) : [path];
});
const SOURCE_FILES = ['src', 'scripts']
  .flatMap(walkJs)
  .filter((path) => path.endsWith('.js'));

describe('the capacity policy gate has exactly one internal home', () => {
  test('evolution-run.js imports the shared gate', () => {
    expect(readFileSync('src/sim/evolution-run.js', 'utf8')).toContain(CAPACITY_IMPORT);
  });

  test('evolution-replay.js imports the shared gate', () => {
    expect(readFileSync('src/sim/evolution-replay.js', 'utf8')).toContain(CAPACITY_IMPORT);
  });

  test('no other src/ or scripts/ module even references the internal gate', () => {
    for (const file of SOURCE_FILES) {
      if (file === GATE_MODULE || GATE_READERS.includes(file)) continue;
      const source = readFileSync(file, 'utf8');
      expect(source.includes('evolution-capacity'), `${file} must not reference evolution-capacity.js`)
        .toBe(false);
    }
  });

  test('the two readers never re-export the gate, in any export shape', () => {
    // Multiline-tolerant: `export { ... } from`, `export * from`, and the
    // direct `export { assertHistoryCapacity }` shape.
    const fromReExport = /export\s+(?:\*|\{[\s\S]*?\})\s*from\s*['"][^'"]*evolution-capacity\.js['"]/;
    const namedReExport = /export\s*\{[^}]*\bassertHistoryCapacity\b[^}]*\}/;
    for (const file of GATE_READERS) {
      const source = readFileSync(file, 'utf8');
      expect(fromReExport.test(source), `${file} must not re-export evolution-capacity.js`).toBe(false);
      expect(namedReExport.test(source), `${file} must not re-export assertHistoryCapacity`).toBe(false);
    }
  });

  test('the gate module never imports its readers', () => {
    // The module docblock states the no-cycle rule; this is its enforcement.
    // Target-anchored, so EVERY edge shape is caught: named/default/namespace
    // import-from, re-export-from, side-effect import and dynamic import().
    const source = readFileSync(GATE_MODULE, 'utf8');
    const readerEdge = /(?:from\s*|import\s*\(\s*|import\s*)['"]\.\/evolution-(?:run|replay)\.js['"]/;
    expect(readerEdge.test(source), 'evolution-capacity.js must stay reader-free').toBe(false);
  });
});
