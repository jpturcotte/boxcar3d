// PR 4D — BENCHMARK-OWNED EVOLUTION-HISTORY ARTIFACT CONSTRUCTION.
//
// PROOF ROLE, stated up front: this module is KERNEL-HONEST INTEGRATION
// TOOLING, never an independent oracle. Every synthesized successor here is
// the exact output of the production transition kernel over the previous
// record's persisted facts, so an artifact built here AGREES with the
// production transition by construction — which is exactly what scale
// measurement needs — but it is not independent evidence that the kernel is
// correct (the same kernel produced the bytes; the independent oracle lives
// in tests/evolution-transition.test.js, and this module is a declared
// benchmark importer in that file's kernel boundary guard).
//
// WHAT LIVES HERE (the PR-4D benchmark's construction needs):
//   1. buildScaleArtifact — kernel-honest SYNTHETIC artifacts at arbitrary
//      population/record shapes (codec-only, NO physics; the fitness rows are
//      coherence-legal authoring rows, NOT evaluation output — extraction-only
//      by design, and labeled 'kernel-honest-synthetic' in every report).
//   2. withForeignRuntimeIdentity / withContradictionAtPair — self-consistent
//      REFORGES of honest artifacts (every digest recomputed), the
//      resume-gate and hostile short-circuit rows. NEVER authenticity
//      tooling: a reforged artifact is self-consistent, not genuine.
//   3. deriveCapacityMaximumGenerations — the legal v1 envelope, derived
//      through the PUBLIC creation refusal, never a hardcoded constant.
// The GENUINE corpus builder lives in bench-evolution-verification-corpus.js
// (Node-only: it imports the campaign protocol from experiment-evolution.js,
// which imports node: builtins). THIS module stays browser-safe — the
// browser bench page and the Chromium smoke test import it.
//
// THE BUILDER CONTRACT (mirrored from the PR-4B kernel-honest test builder in
// tests/evolution-local-semantics.test.js, re-declared here because scripts
// must not import test helpers — the schema test pins the two in step):
//   - generation 0 is the REAL initializer's population, so the provenance
//     recreation bind passes;
//   - every successor's population and lineage bytes are the exact output of
//     deriveNextGeneration over the previous record's persisted facts — the
//     decoded population, the pool reconstructed from the record's OWN
//     persisted vector via selectablePoolFromEvaluation, the manifest-bound
//     seed, the header mutation policy, and the checked fresh-ID base
//     (g + 1) × populationSize. Successor ids are whatever the kernel
//     returned, never assumed;
//   - terminal reasons come from production terminalReasonFor computed on the
//     pool reconstructed from each record's own persisted vector — never
//     overridden; a terminal record has no successor by policy, so requesting
//     one is a loud caller-configuration error;
//   - the caller-owned mutation policy is captured ONCE, before the first
//     await, into a frozen copy — rereading it after a digest await would let
//     a mutating caller derive a successor under a policy the header never
//     persisted;
//   - deliberately-contradictory artifacts are built by REFORGING an honest
//     artifact, never by asking this builder to lie.
//
// NODE + BROWSER: this module is plain deterministic JS over src/sim codecs
// and src/platform/sha256.js (WebCrypto); it runs unchanged in Chromium.
// Wall-clock reads here are construction provenance only — the benchmark
// instrument owns all measurement; nothing in this module is ever inside a
// measured reader interval.

import { createEvolutionRun } from '../src/sim/evolution-run.js';
// THE declared benchmark importer of the kernel — pinned BY DECISION in
// tests/evolution-transition.test.js (AUTHORIZED_BENCHMARK_IMPORTERS). Kernel
// honesty requires the production kernel; the boundary guard requires that
// this be the ONE scripts module that imports it.
import { deriveNextGeneration } from '../src/sim/evolution-transition.js';
import {
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, MAX_EVOLUTION_GENERATIONS,
  checkedMultiply, terminalReasonFor,
} from '../src/sim/evolution-contract.js';
import {
  COMPONENT_KINDS, EVALUATION_METADATA_VERSION, GENERATION_RECORD_VERSION,
  assembleHistory, decodeEvolutionHeader, decodeGenerationPayload, decodeHistoryFraming,
  digestComponent, digestGeneration, digestHeader,
  encodeEvolutionHeader, encodeGenerationPayload, serializeEvaluationMetadata,
} from '../src/sim/evolution-history.js';
import {
  EVOLUTION_LINEAGE_VERSION, serializeLineage, zeroLineageAccounting,
} from '../src/sim/evolution-lineage.js';
import {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_DEFAULTS, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE,
} from '../src/sim/evolution-operators.js';
import {
  createInitialPopulation, serializePopulationInitialization,
} from '../src/sim/population-initializer.js';
import {
  deserializePopulationSnapshot, serializePopulationSnapshot,
} from '../src/sim/population.js';
import {
  POPULATION_WORLD_MODE, canonicalizeEvaluationSpec, deserializeFitnessVector,
  selectablePoolFromEvaluation, serializeFitnessVector,
} from '../src/sim/population-evaluation.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from '../src/sim/fnv1a.js';
import { readDeterministicRuntimeIdentity } from '../src/sim/physics/adapter.js';

// ---------------------------------------------------------------------------
// BENCH-OWNED CONSTANTS
// ---------------------------------------------------------------------------

// The PR-4D bench seed block, declared in CLAUDE.md's PR-4D entry: bench
// corpus population seeds 20260800-20260807, terrain seeds 20260808-20260815,
// synthetic-builder literals 20260816-20260817. NEVER campaign-allocated
// seeds: bench artifacts are measurement inputs, not campaign evidence.
export const BENCH_SYNTHETIC_POPULATION_SEED = 20260816;
export const BENCH_SYNTHETIC_TERRAIN_SEED = 20260817;

// The AUTHORITATIVE CAPACITY-TEST CONFIGURATION, mirrored verbatim from the
// shared capacity-config helper under tests/helpers/ (scripts must not
// import test helpers; tests/evolution-verification-bench-schema.test.js
// names it and pins these values against it so the two cannot drift). The
// capacity boundary (228 at population 256, 912 at 64) was derived by the
// capacity tests under exactly this spec and these seeds; the D-rows must
// follow them.
export const BENCH_CAPACITY_POPULATION_SEED = 20260740;
export const BENCH_CAPACITY_TERRAIN_SEED = 20260741;

export function createBenchCapacityEvaluationSpec() {
  return {
    terrain: {
      seed: BENCH_CAPACITY_TERRAIN_SEED,
      startFlatLength: 30,
      startBlendLength: 6,
      craterDensity: 0,
      featureDensity: 0,
    },
    maxSteps: 45,
    deterministic: true,
    spawn: { x: -44, z: 0 },
  };
}

// The synthetic builder's own default evaluation spec: the capacity shape
// with bench-owned seeds (synthetic artifacts carry authoring rows; the spec
// is persisted geometry, never executed).
export function createBenchSyntheticEvaluationSpec() {
  const spec = createBenchCapacityEvaluationSpec();
  spec.terrain = { ...spec.terrain, seed: BENCH_SYNTHETIC_TERRAIN_SEED };
  return spec;
}

// Clean, coherence-legal v3 rows (the capacity test file's cleanRow
// precedent): null onsets and zero peaks stay coherent with any positive-dt
// metadata, and valid: true keeps the selectable pool nonempty. These rows
// are NOT evaluation output — that is exactly why synthetic artifacts are
// extraction-only and never claim resume success.
const cleanRow = (individualId, valid = true) => ({
  individualId,
  valid,
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

// ---------------------------------------------------------------------------
// 1. THE KERNEL-HONEST SYNTHETIC BUILDER
// ---------------------------------------------------------------------------

/**
 * Build a kernel-honest synthetic artifact of `recordCount` generation
 * records at `populationSize`. See the module header for the contract.
 * `invalidPoolAt` makes one generation's rows unselectable (an empty pool)
 * and is legal only on the FINAL record; -1 disables. `mutation` is captured
 * once, before the first await. Returns
 * { bytes, recordCount, populationSize, maxGenerations, terminalReason }.
 */
export async function buildScaleArtifact(runtime, {
  populationSize, recordCount, maxGenerations,
  invalidPoolAt = -1,
  seed = BENCH_SYNTHETIC_POPULATION_SEED,
  mutation = PARAMETRIC_MUTATION_DEFAULTS,
  spec = undefined,
} = {}) {
  if (!Number.isInteger(populationSize) || populationSize < 1) {
    throw new Error(`buildScaleArtifact: populationSize ${String(populationSize)} is not a positive integer`);
  }
  if (!Number.isInteger(recordCount) || recordCount < 1 || recordCount > maxGenerations) {
    throw new Error(`buildScaleArtifact: recordCount ${String(recordCount)} is not an integer in [1, maxGenerations ${String(maxGenerations)}]`);
  }
  if (!(invalidPoolAt === -1
    || (Number.isInteger(invalidPoolAt) && invalidPoolAt >= 0 && invalidPoolAt < recordCount))) {
    throw new Error(`buildScaleArtifact: invalidPoolAt ${String(invalidPoolAt)} is not -1 or an integer generation index in [0, ${recordCount}) — a caller configuration error`);
  }
  // Capture the caller-owned policy ONCE, before the first await (the
  // initializer's capture-once idiom): the header and every kernel call below
  // consume this same owned copy.
  const persistedMutation = Object.freeze({
    probability: mutation.probability, magnitude: mutation.magnitude,
  });
  const initialization = createInitialPopulation({ seed, populationSize });
  const initializationBytes = serializePopulationInitialization(initialization);
  const evaluationSpec = spec ?? createBenchSyntheticEvaluationSpec();
  const specBytes = canonicalizeEvaluationSpec(evaluationSpec).bytes;
  const specState = fnv1aFold(FNV_OFFSET_BASIS, specBytes);
  const metadataBytes = serializeEvaluationMetadata({
    worldMode: POPULATION_WORLD_MODE,
    effectiveDt: Math.fround(1 / 60),
    executedSteps: evaluationSpec.maxSteps,
  });
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
    populationSize,
    maxGenerations,
    mutationProbability: persistedMutation.probability,
    mutationMagnitude: persistedMutation.magnitude,
    initializationManifestBytes: initializationBytes,
    evaluationSpecBytes: specBytes,
  });
  const headerDigestBytes = await digestHeader(headerBytes);
  const generations = [];
  let previous = headerDigestBytes;
  let populationBytes = serializePopulationSnapshot(initialization.population);
  let lineageBytes = null; // generation 0's all-initialized rows are built inline
  for (let g = 0; g < recordCount; g += 1) {
    const population = deserializePopulationSnapshot(populationBytes);
    const ids = population.individuals.map((ind) => ind.individualId);
    const fitnessVectorBytes = serializeFitnessVector({
      populationSnapshotDigestState: fnv1aFold(FNV_OFFSET_BASIS, populationBytes),
      evaluationSpecDigestState: specState,
      individuals: ids.map((id) => cleanRow(id, g !== invalidPoolAt)),
    });
    if (g === 0) {
      lineageBytes = serializeLineage({
        lineageVersion: EVOLUTION_LINEAGE_VERSION,
        generationIndex: 0,
        individuals: ids.map((id) => ({
          individualId: id,
          parentIndividualId: null,
          origin: 'initialized',
          accounting: zeroLineageAccounting(),
        })),
      });
    }
    // The producer's exact idiom: reconstruct the selectable pool from the
    // record's OWN persisted vector, compute the terminal reason from that
    // pool, and derive the successor from the same pool.
    const pool = selectablePoolFromEvaluation(deserializeFitnessVector(fitnessVectorBytes));
    const terminalReason = terminalReasonFor({
      selectableCount: pool.individuals.length,
      generationIndex: g,
      maxGenerations,
      nextIndividualId: checkedMultiply(
        g + 1, populationSize, 'evolution individual id allocation',
      ),
      populationSize,
    });
    if (terminalReason !== 'none' && g + 1 < recordCount) {
      throw new Error(`buildScaleArtifact: generation ${g} is terminal ('${terminalReason}') but a successor (${g + 1}) was requested — a terminal record has no persisted successor`);
    }
    const record = {
      generationIndex: g,
      terminalReason,
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
    const generationDigestBytes = await digestGeneration(previous, payloadBytes);
    previous = generationDigestBytes;
    generations.push({ payloadBytes, generationDigestBytes });
    if (g + 1 < recordCount) {
      // The PR-4C verifier's own idiom, reused for construction: derive the
      // successor from the SAME persisted facts.
      const derived = deriveNextGeneration({
        population,
        pool,
        seed: initialization.seed, // the manifest-bound seed persisted above
        mutation: persistedMutation,
        baseIndividualId: checkedMultiply(
          g + 1, populationSize, 'evolution individual id allocation',
        ),
        generationIndex: g,
      });
      populationBytes = derived.populationBytes;
      lineageBytes = derived.lineageBytes;
    }
  }
  const bytes = (await assembleHistory({ headerBytes, headerDigestBytes, generations })).bytes;
  const lastRecord = decodeGenerationPayload(generations[generations.length - 1].payloadBytes);
  return Object.freeze({
    bytes,
    recordCount,
    populationSize,
    maxGenerations,
    terminalReason: lastRecord.terminalReason,
  });
}

// ---------------------------------------------------------------------------
// 2. SELF-CONSISTENT REFORGES (never authenticity tooling — see the header)
// ---------------------------------------------------------------------------

// The bench-owned reforge, mirrored from tests/helpers/evolution-artifacts.js
// (scripts must not import test helpers): rebuild a complete, internally
// self-consistent history after mutating the decoded header and/or decoded
// generation records — every component digest, generation digest, chain link
// and the whole-history digest is recomputed, so the result can only fail at
// the deliberately targeted later gate.
async function reforgeBench(bytes, { mutateHeader, mutateRecord } = {}) {
  const framing = decodeHistoryFraming(bytes);
  let headerBytes = framing.headerBytes;
  if (mutateHeader) {
    const decoded = decodeEvolutionHeader(framing.headerBytes);
    headerBytes = encodeEvolutionHeader(mutateHeader({ ...decoded }));
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

// Re-attest a record's fitness-vector population FNV state after its
// population component was rewritten, so the artifact stays self-consistent
// through the population/vector coherence bind and fails only at the
// targeted transition-authentication gate.
function rebindFitnessVectorToPopulationBench(record) {
  const vector = deserializeFitnessVector(record.components.fitnessVector);
  record.components.fitnessVector = serializeFitnessVector({
    populationSnapshotDigestState: fnv1aFold(
      FNV_OFFSET_BASIS, record.components.population,
    ),
    evaluationSpecDigestState: vector.evaluationSpecDigestState,
    individuals: vector.individuals,
  });
}

/**
 * A transition-honest artifact carrying an intentionally FOREIGN runtime
 * identity: passes every shared gate — including PR-4C transition
 * authentication — and refuses at the runtime-identity comparison, before
 * world creation, evaluation or replay. This is the 'resume pre-replay gate
 * cost' artifact; it is NEVER full-resume evidence.
 */
export async function withForeignRuntimeIdentity(bytes, { rapierVersion = '99.99.99' } = {}) {
  return reforgeBench(bytes, {
    mutateHeader: (h) => ({ ...h, rapierVersion }),
  });
}

/**
 * A hostile-but-self-consistent artifact with a population contradiction at
 * persisted pair k (the successor record k+1's population rewritten, ids
 * untouched, the vector re-attested). The PR-4C verifier must refuse with
 * malformedHistory / persistedTransitionPopulationMismatch at
 * sourceGenerationIndex k — exactly k + 1 verifier kernel calls by the
 * first-contradictory-pair contract. The flip uses the test suite's proven
 * offset-40 shape: inside member 0's genotype payload for every population
 * size (the genotype schema is shared), never an id field, always decodable,
 * so every earlier gate stays intact and only transition authentication can
 * fire. k is validated loudly: an out-of-range or fractional k would
 * otherwise silently return the HONEST bytes, and a negative one would fire
 * the wrong gate — both are caller configuration errors, not artifacts.
 */
export async function withContradictionAtPair(bytes, k) {
  const recordCount = decodeHistoryFraming(bytes).generations.length;
  if (!Number.isInteger(k) || k < 0 || k + 1 >= recordCount) {
    throw new Error(`withContradictionAtPair: k ${String(k)} is not an integer pair index in [0, ${recordCount - 1}) for a ${recordCount}-record artifact — a caller configuration error`);
  }
  return reforgeBench(bytes, {
    mutateRecord: (record, recordIndex) => {
      if (recordIndex !== k + 1) return;
      const population = new Uint8Array(record.components.population);
      if (population.length <= 40) {
        throw new Error(`withContradictionAtPair: population component too small (${population.length} bytes) for the proven offset-40 flip`);
      }
      population[40] ^= 0xff;
      record.components.population = population;
      rebindFitnessVectorToPopulationBench(record);
    },
  });
}

// ---------------------------------------------------------------------------
// 3. THE LEGAL ENVELOPE, DERIVED — NEVER A HARDCODED CONSTANT
// ---------------------------------------------------------------------------

/**
 * Derive maximumFeasibleGenerations for `populationSize` through the PUBLIC
 * creation gate, following the existing capacity tests: attempt
 * createEvolutionRun at MAX_EVOLUTION_GENERATIONS under the authoritative
 * capacity-test configuration and read the refusal context. When the policy
 * maximum itself is legal (small populations), no refusal occurs and the
 * policy maximum is returned — declared, not assumed.
 */
export function deriveCapacityMaximumGenerations(populationSize) {
  try {
    createEvolutionRun({
      initialization: { seed: BENCH_CAPACITY_POPULATION_SEED, populationSize },
      evaluationSpec: createBenchCapacityEvaluationSpec(),
      evolution: { maxGenerations: MAX_EVOLUTION_GENERATIONS },
    });
    return Object.freeze({
      maximumFeasibleGenerations: MAX_EVOLUTION_GENERATIONS,
      derivedFrom: 'policy maximum (no refusal)',
    });
  } catch (err) {
    if (err && err.code === 'resourceLimitExceeded' && err.context
      && Number.isInteger(err.context.maximumFeasibleGenerations)) {
      return Object.freeze({
        maximumFeasibleGenerations: err.context.maximumFeasibleGenerations,
        derivedFrom: 'resourceLimitExceeded context',
      });
    }
    throw err;
  }
}

// The deterministic runtime identity, bound into synthetic headers. Read once
// per process by the instrument's construction phase (never inside a measured
// reader interval).
export function readBenchRuntimeIdentity() {
  return readDeterministicRuntimeIdentity();
}
