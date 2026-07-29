// POST-MERGE HARDENING PR 3 — LOCAL HISTORY SEMANTICS. The verification
// ladder's stage 11 now closes with a local-semantics pass between
// generation-zero provenance and the capacity gate: the lineage,
// ID-allocation, terminal and record-count invariants the pass owns, each
// decidable from persisted facts without runtime identity, physics, or
// reproducing generation N+1 (elite-genotype equality, parent ranking,
// replacement shape and accounting-vs-delta checks remain PR 4's scope).
//
//   - lineage compatibility and coherence: the nested lineage version joins
//     stage 9's independent peeks, and `crossCheckLineage` — the existing
//     reusable primitive — is applied to the persisted artifact (record
//     index, lineage ids == population ids, generation 0 all-initialized, no
//     initialized rows later, every derived parent in the immediately
//     preceding generation);
//   - the exact v1 ID-allocation policy: member m of generation g carries id
//     g × populationSize + m, a fresh never-recycled block;
//   - terminal reasons recomputed from persisted facts through the SAME
//     `terminalReasonFor` the producer used (one policy home in the contract
//     leaf) — subsuming noSelectableParents ⟺ empty pool, limit ⟺ nonempty
//     pool at the declared last generation, 'none' legal on a partial
//     history's last record, and individualIdExhausted unreachable under the
//     v1 caps;
//   - record-count semantics: count ≤ header.maxGenerations (contiguity and
//     terminal-last stay at stage 5, covered in evolution-replay.test.js).
//
// RED-FIRST. On the pre-PR main every sabotage case below passed ALL
// pre-physics gates: extraction — the reader that runs no physics — accepted
// each artifact outright, and resume refused none of them before replay
// (several classes were caught later by deterministic replay; the
// shifted/recycled ID block and the count rule had no pre-physics verdict
// anywhere). Captured: 30 of the 40 tests fail on the merge-base, all 40
// green after the implementation.
//
// PROBE DISCIPLINE. Artifact construction reads the runtime identity ONCE
// (to bind header identity strings) and the genuine runs touch physics;
// beforeAll asserts that liveness, then zeroes every probe. Every reader
// assertion below — including the positive extractions — must leave all
// three counters at zero: all of these verdicts are pre-physics.

import {
  describe, test, expect, vi, beforeAll, beforeEach,
} from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
// The kernel boundary requires the STATIC form from every importer — the AST
// guard in tests/evolution-transition.test.js asserts it; this module's other
// dependencies keep arriving through the post-mock destructuring below.
import { deriveNextGeneration } from '../src/sim/evolution-transition.js';

vi.mock('../src/sim/population-evaluation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    evaluatePopulation: async (population, spec) => {
      if (globalThis.__semanticsProbe) globalThis.__semanticsProbe.evaluations += 1;
      return original.evaluatePopulation(population, spec);
    },
  };
});

vi.mock('../src/sim/physics/adapter.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createPhysics: async (...args) => {
      if (globalThis.__semanticsProbe) globalThis.__semanticsProbe.worlds += 1;
      return original.createPhysics(...args);
    },
    readDeterministicRuntimeIdentity: async (...args) => {
      if (globalThis.__semanticsProbe) globalThis.__semanticsProbe.identityReads += 1;
      return original.readDeterministicRuntimeIdentity(...args);
    },
  };
});

const { createEvolutionRun, resumeEvolutionRun } = await import('../src/sim/evolution-run.js');
const {
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, MAX_EVOLUTION_GENERATIONS, checkedMultiply,
  terminalReasonFor,
} = await import('../src/sim/evolution-contract.js');
const {
  COMPONENT_KINDS, EVALUATION_METADATA_VERSION, GENERATION_RECORD_VERSION, SHA256_DIGEST_BYTES,
  assembleHistory, decodeGenerationPayload, digestComponent, digestGeneration, digestHeader,
  encodeEvolutionHeader, encodeGenerationPayload, serializeEvaluationMetadata,
} = await import('../src/sim/evolution-history.js');
const {
  EVOLUTION_LINEAGE_VERSION, deserializeLineage, serializeLineage, zeroLineageAccounting,
} = await import('../src/sim/evolution-lineage.js');
const {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_DEFAULTS, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE,
} = await import('../src/sim/evolution-operators.js');
const {
  createInitialPopulation, deserializePopulationInitialization, serializePopulationInitialization,
} = await import('../src/sim/population-initializer.js');
const {
  POPULATION_SNAPSHOT_VERSION, deserializePopulationSnapshot, serializePopulationSnapshot,
} = await import('../src/sim/population.js');
const {
  FITNESS_VECTOR_VERSION, POPULATION_WORLD_MODE, canonicalizeEvaluationSpec,
  deserializeFitnessVector, selectablePoolFromEvaluation, serializeFitnessVector,
} = await import('../src/sim/population-evaluation.js');
const { FNV_OFFSET_BASIS, fnv1aFold } = await import('../src/sim/fnv1a.js');
const { readDeterministicRuntimeIdentity } = await import('../src/sim/physics/adapter.js');
const { extractHistoryObservations } = await import('../scripts/history-observations.js');
const { verifyHistoryArtifact } = await import('../src/sim/evolution-replay.js');
const { reforge, withLeadingU16 } = await import('./helpers/evolution-artifacts.js');
const {
  CAPACITY_POPULATION_SEED, createCapacityEvaluationSpec,
} = await import('./helpers/evolution-capacity-config.js');
const { expectCode, expectCodeAsync } = await import('./helpers/expect-code.js');

const SMALL = 6; // the cheap genuine-run population (and the synthesized 2-gen one)
const CAP = 256; // the over-declared-capacity population (mfg is read, never pinned)

const expectNoProbes = () => expect(globalThis.__semanticsProbe)
  .toEqual({ identityReads: 0, worlds: 0, evaluations: 0 });

// Clean, coherence-legal v3 rows (the capacity file's cleanRow precedent):
// null onsets and zero peaks stay coherent with any positive-dt metadata, and
// `valid: true` keeps the selectable pool nonempty.
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

const configAt = (populationSize, maxGenerations) => ({
  initialization: { seed: CAPACITY_POPULATION_SEED, populationSize },
  evaluationSpec: createCapacityEvaluationSpec(),
  evolution: { maxGenerations },
});

/**
 * The buildFeasibleCapacityArtifact pattern, generalized to multiple
 * generations: codec-only, NO physics — and, since PR 4B, KERNEL-HONEST.
 * Generation 0 is the real initializer's population (so the provenance
 * recreation bind passes); every later generation's population and lineage
 * components are the exact output of deriveNextGeneration over the previous
 * record's persisted facts — the decoded population, the pool reconstructed
 * from the record's own synthetic vector, the manifest seed, the header
 * mutation policy, and the checked fresh-ID base (g + 1) × populationSize.
 * Successor ids are therefore whatever the kernel returned, never assumed.
 *
 * PROOF ROLE (the 3.2 integration role, not the 3.1 oracle): an artifact
 * built here AGREES with the production transition by construction, which is
 * exactly what the local-semantics and capacity gates need — but it is not
 * independent evidence that the kernel is correct (the same kernel produced
 * it; that boundary lives in tests/evolution-transition.test.js).
 *
 * Terminal reasons are computed by the producer's own terminalReasonFor —
 * never overridden — from the selectable pool reconstructed out of each
 * record's OWN persisted vector, exactly the producer's idiom
 * (evolution-run.js): an empty pool (invalidPoolAt) ends
 * noSelectableParents, a full count ends
 * generationLimitReached, anything else persists 'none'. A terminal record
 * has no successor by policy, so requesting one is a caller configuration
 * error and is refused loudly. `invalidPoolAt` makes one generation's rows
 * unselectable (an empty pool) and is therefore only legal on the FINAL
 * record; any value that names no generation at all (out of range,
 * fractional, < -1) is likewise a loud caller configuration error.
 * Deliberately-contradictory terminal states are built by reforging
 * an honest artifact, never by asking this builder to lie.
 */
async function buildSynthesizedArtifact(runtime, {
  populationSize, generationCount, maxGenerations, invalidPoolAt = -1,
  seed = CAPACITY_POPULATION_SEED, mutation = PARAMETRIC_MUTATION_DEFAULTS,
}) {
  if (!(invalidPoolAt === -1
    || (Number.isInteger(invalidPoolAt) && invalidPoolAt >= 0 && invalidPoolAt < generationCount))) {
    throw new Error(`buildSynthesizedArtifact: invalidPoolAt ${invalidPoolAt} is not -1 or an integer generation index in [0, ${generationCount}) — a caller configuration error`);
  }
  const initialization = createInitialPopulation({ seed, populationSize });
  const initializationBytes = serializePopulationInitialization(initialization);
  const specBytes = canonicalizeEvaluationSpec(createCapacityEvaluationSpec()).bytes;
  const specState = fnv1aFold(FNV_OFFSET_BASIS, specBytes);
  const metadataBytes = serializeEvaluationMetadata({
    worldMode: POPULATION_WORLD_MODE,
    effectiveDt: Math.fround(1 / 60),
    executedSteps: 45,
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
    mutationProbability: mutation.probability,
    mutationMagnitude: mutation.magnitude,
    initializationManifestBytes: initializationBytes,
    evaluationSpecBytes: specBytes,
  });
  const headerDigestBytes = await digestHeader(headerBytes);
  const generations = [];
  let previous = headerDigestBytes;
  // The running kernel-honest state: generation 0 is the initializer's own
  // snapshot; each later generation's bytes arrive from the kernel below.
  let populationBytes = serializePopulationSnapshot(initialization.population);
  let lineageBytes = null; // generation 0's all-initialized rows are built inline
  for (let g = 0; g < generationCount; g += 1) {
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
    // The producer's exact idiom (evolution-run.js): reconstruct the
    // selectable pool from the record's OWN persisted vector, compute the
    // terminal reason from that pool, and derive the successor from the
    // same pool — the construction shortcut never interprets the vector.
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
    if (terminalReason !== 'none' && g + 1 < generationCount) {
      throw new Error(`buildSynthesizedArtifact: generation ${g} is terminal ('${terminalReason}') but a successor (${g + 1}) was requested — a terminal record has no persisted successor`);
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
    if (g + 1 < generationCount) {
      // The PR 4C verifier's own idiom, reused for construction: derive the
      // successor from the SAME persisted facts — the decoded population and
      // the pool reconstructed above from this record's own vector.
      const derived = deriveNextGeneration({
        population,
        pool,
        seed,
        mutation: Object.freeze({
          probability: mutation.probability, magnitude: mutation.magnitude,
        }),
        baseIndividualId: checkedMultiply(
          g + 1, populationSize, 'evolution individual id allocation',
        ),
        generationIndex: g,
      });
      populationBytes = derived.populationBytes;
      lineageBytes = derived.lineageBytes;
    }
  }
  return (await assembleHistory({ headerBytes, headerDigestBytes, generations })).bytes;
}

/**
 * Re-bind a record to a replacement id block: population, lineage and vector
 * all re-encoded so lineage ids == population ids == vector ids (the
 * coherence `crossCheckLineage` checks stays intact), which is exactly what
 * lets the ID-ALLOCATION rule — not the lineage rule — be the one that fires.
 * Origins and parents are preserved, so the predecessor rule still passes.
 */
function rewriteGenerationIds(record, g, newIds) {
  const population = deserializePopulationSnapshot(record.components.population);
  record.components.population = serializePopulationSnapshot({
    snapshotVersion: POPULATION_SNAPSHOT_VERSION,
    individuals: population.individuals.map((ind, m) => ({
      individualId: newIds[m], genotype: ind.genotype,
    })),
  });
  const lineage = deserializeLineage(record.components.lineage);
  record.components.lineage = serializeLineage({
    lineageVersion: EVOLUTION_LINEAGE_VERSION,
    generationIndex: g,
    individuals: lineage.individuals.map((row, m) => ({
      individualId: newIds[m],
      parentIndividualId: row.parentIndividualId,
      origin: row.origin,
      accounting: row.accounting,
    })),
  });
  const vector = deserializeFitnessVector(record.components.fitnessVector);
  record.components.fitnessVector = serializeFitnessVector({
    populationSnapshotDigestState: fnv1aFold(FNV_OFFSET_BASIS, record.components.population),
    evaluationSpecDigestState: vector.evaluationSpecDigestState,
    individuals: vector.individuals.map((row, m) => ({ ...row, individualId: newIds[m] })),
  });
}

// Re-encode one record's lineage with rows mutated by `mutate(rows)` — each
// row a plain { individualId, parentIndividualId, origin, accounting }.
function rewriteLineage(record, g, mutate) {
  const lineage = deserializeLineage(record.components.lineage);
  const rows = lineage.individuals.map((row) => ({
    individualId: row.individualId,
    parentIndividualId: row.parentIndividualId,
    origin: row.origin,
    accounting: row.accounting,
  }));
  mutate(rows);
  record.components.lineage = serializeLineage({
    lineageVersion: EVOLUTION_LINEAGE_VERSION, generationIndex: g, individuals: rows,
  });
}

// Re-encode one record's vector with every row unselectable (an empty pool),
// FNV states re-attested.
function emptyPool(record) {
  const vector = deserializeFitnessVector(record.components.fitnessVector);
  record.components.fitnessVector = serializeFitnessVector({
    populationSnapshotDigestState: vector.populationSnapshotDigestState,
    evaluationSpecDigestState: vector.evaluationSpecDigestState,
    individuals: vector.individuals.map((row) => ({ ...row, valid: false })),
  });
}

const expectBothReaders = async (artifact, code, re) => {
  const extraction = await expectCodeAsync(() => extractHistoryObservations(artifact), code, re);
  const resume = await expectCodeAsync(() => resumeEvolutionRun(artifact), code, re);
  return { extraction, resume };
};

let runtime;
let terminalArtifact; // genuine: 3 records, final generationLimitReached
let partialArtifact; // genuine: 1 record, final none, count < maxGenerations
let synth2; // synthesized: population 6, 2 records (ids 0..5 then 6..11), limit reached
let mfg; // maximumFeasibleGenerations for population 256 — read, never pinned
let overDeclared; // synthesized population-256 2-record artifact declaring mfg + 1

beforeAll(async () => {
  globalThis.__semanticsProbe = { identityReads: 0, worlds: 0, evaluations: 0 };
  runtime = await readDeterministicRuntimeIdentity();

  const terminalRun = createEvolutionRun(configAt(SMALL, 3));
  let result;
  do { result = await terminalRun.advance(); } while (result.kind !== 'terminal');
  terminalArtifact = terminalRun.historyBytes();
  const partialRun = createEvolutionRun(configAt(SMALL, 8));
  await partialRun.advance();
  partialArtifact = partialRun.historyBytes();

  synth2 = await buildSynthesizedArtifact(runtime, {
    populationSize: SMALL, generationCount: 2, maxGenerations: 2,
  });

  // The ONLY boundary oracle: the public creation gate's refusal context on
  // the exact shared configuration (never a literal, never the projection).
  const refusal = expectCode(
    () => createEvolutionRun(configAt(CAP, MAX_EVOLUTION_GENERATIONS)),
    'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
  );
  mfg = refusal.context.maximumFeasibleGenerations;
  expect(Number.isInteger(mfg)).toBe(true);
  overDeclared = await buildSynthesizedArtifact(runtime, {
    populationSize: CAP, generationCount: 2, maxGenerations: mfg + 1,
  });

  // Probe liveness: the genuine runs evaluated and built worlds, the builders
  // read the runtime identity. Zeroed before any reader runs below.
  expect(globalThis.__semanticsProbe.identityReads).toBeGreaterThan(0);
  expect(globalThis.__semanticsProbe.worlds).toBeGreaterThan(0);
  expect(globalThis.__semanticsProbe.evaluations).toBeGreaterThan(0);
  globalThis.__semanticsProbe = { identityReads: 0, worlds: 0, evaluations: 0 };
}, 240000);

beforeEach(() => {
  globalThis.__semanticsProbe = { identityReads: 0, worlds: 0, evaluations: 0 };
});

// ============================================================================
// Positives: genuine and synthesized artifacts pass the pass, with no physics
// ============================================================================

describe('artifacts whose persisted facts agree pass the local-semantics pass', () => {
  test('a genuine terminal history (3 records, generationLimitReached) extracts with zero probes', async () => {
    const extracted = await extractHistoryObservations(terminalArtifact);
    expect(extracted.generations).toHaveLength(3);
    expect(extracted.generations[2].terminalReason).toBe('generationLimitReached');
    expectNoProbes();
  });

  test('a genuine partial history (final none, count < maxGenerations) extracts with zero probes', async () => {
    const extracted = await extractHistoryObservations(partialArtifact);
    expect(extracted.generations).toHaveLength(1);
    expect(extracted.generations[0].terminalReason).toBe('none');
    expectNoProbes();
  });

  test('a synthesized 2-generation artifact with derived lineage and the exact 6..11 second block verifies', async () => {
    const extracted = await extractHistoryObservations(synth2);
    expect(extracted.generations).toHaveLength(2);
    expect(extracted.generations[0].individuals.map((row) => row.individualId))
      .toEqual([0, 1, 2, 3, 4, 5]);
    expect(extracted.generations[1].individuals.map((row) => row.individualId))
      .toEqual([6, 7, 8, 9, 10, 11]);
    expect(extracted.generations[1].terminalReason).toBe('generationLimitReached');
    expectNoProbes();
    // Resume replay is deliberately NOT claimed: the artifact is now
    // transition-honest (PR 4B — the second record is the kernel's exact
    // successor), but the synthesized clean rows are still not real physics
    // output (the capacity file's source-artifact ruling).
  });

  test('an empty pool at the declared last generation with persisted noSelectableParents verifies', async () => {
    const artifact = await buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 2, maxGenerations: 2, invalidPoolAt: 1,
    });
    const extracted = await extractHistoryObservations(artifact);
    expect(extracted.generations[1].terminalReason).toBe('noSelectableParents');
    expectNoProbes();
  });
});

// ============================================================================
// Kernel-honest artifact construction (PR 4B): the builder routes EVERY
// successor through deriveNextGeneration — integration evidence, NOT the
// independent oracle (that boundary lives in tests/evolution-transition.test.js)
// ============================================================================

describe('kernel-honest synthesized artifacts (PR 4B)', () => {
  // Read persisted facts back out of an artifact. verifyHistoryArtifact is
  // digest/framing byte-work only — no runtime-identity read, no physics —
  // and expectNoProbes re-proves it on every test below.
  const readArtifact = async (artifact) => {
    const verified = await verifyHistoryArtifact(artifact);
    const { header, framing } = verified;
    const records = framing.generations.map((g) => decodeGenerationPayload(g.payloadBytes));
    const manifest = deserializePopulationInitialization(header.initializationManifestBytes);
    return { header, records, manifest };
  };

  // Derive the successor transition from one record's persisted facts, exactly
  // as the future PR 4C verifier will: persisted population + the pool the
  // persisted vector reconstructs + the manifest seed + the header mutation
  // policy + the exact fresh-ID base. Integration idiom — kernel calls here
  // are NOT independent evidence; the oracle owns that role.
  const deriveSuccessor = (components, {
    seed, mutation, populationSize, generationIndex,
  }) => {
    const population = deserializePopulationSnapshot(components.population);
    const vector = deserializeFitnessVector(components.fitnessVector);
    const pool = selectablePoolFromEvaluation(vector);
    return deriveNextGeneration({
      population,
      pool,
      seed,
      mutation: Object.freeze({ probability: mutation.probability, magnitude: mutation.magnitude }),
      baseIndividualId: checkedMultiply(
        generationIndex + 1, populationSize, 'evolution individual id allocation',
      ),
      generationIndex,
    });
  };

  test("synth2's second record is the exact kernel-derived successor of its first", async () => {
    const { header, records, manifest } = await readArtifact(synth2);
    const derived = deriveSuccessor(records[0].components, {
      seed: manifest.seed,
      mutation: { probability: header.mutationProbability, magnitude: header.mutationMagnitude },
      populationSize: header.populationSize,
      generationIndex: 0,
    });
    expect(records[1].components.population).toEqual(derived.populationBytes);
    expect(records[1].components.lineage).toEqual(derived.lineageBytes);
    expectNoProbes();
  });

  test('an empty final pool still carries an honest predecessor transition', async () => {
    const artifact = await buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 2, maxGenerations: 2, invalidPoolAt: 1,
    });
    const { header, records, manifest } = await readArtifact(artifact);
    const derived = deriveSuccessor(records[0].components, {
      seed: manifest.seed,
      mutation: { probability: header.mutationProbability, magnitude: header.mutationMagnitude },
      populationSize: header.populationSize,
      generationIndex: 0,
    });
    expect(records[1].components.population).toEqual(derived.populationBytes);
    expect(records[1].components.lineage).toEqual(derived.lineageBytes);
    expect(records[1].terminalReason).toBe('noSelectableParents');
    expectNoProbes();
  });

  test('the builder consumes the header mutation policy, never the current defaults', async () => {
    // The witness fixture: probability 1 against the 0.05 default. The
    // inequality below is asserted as OBSERVED evidence for this fixture — no
    // policy value is a theorem (repair/clamping can collapse proposals); the
    // literal was confirmed at authoring time.
    const policy = Object.freeze({ probability: 1, magnitude: 0.3 });
    const artifact = await buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 2, maxGenerations: 2, mutation: policy,
    });
    const { header, records, manifest } = await readArtifact(artifact);
    expect(header.mutationProbability).toBe(1);
    expect(header.mutationMagnitude).toBe(0.3);
    const underPersisted = deriveSuccessor(records[0].components, {
      seed: manifest.seed, mutation: policy, populationSize: header.populationSize, generationIndex: 0,
    });
    const underDefaults = deriveSuccessor(records[0].components, {
      seed: manifest.seed, mutation: PARAMETRIC_MUTATION_DEFAULTS,
      populationSize: header.populationSize, generationIndex: 0,
    });
    expect(underPersisted.populationBytes).not.toEqual(underDefaults.populationBytes);
    expect(records[1].components.population).toEqual(underPersisted.populationBytes);
    expect(records[1].components.lineage).toEqual(underPersisted.lineageBytes);
    expectNoProbes();
  });

  test('the builder transitions under the manifest seed, never another seed', async () => {
    // 20260799 is a test-local authoring literal (NOT a campaign-seed
    // allocation), accepted because the two derivations below were observed to
    // differ for this fixture — the committed witness asserted here. Both
    // derivations start from THE SAME persisted record-0 population and
    // vector; only the transition seed changes, so initialization differences
    // cannot confound the witness.
    const S = 20260799;
    const artifact = await buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 2, maxGenerations: 2, seed: S,
    });
    const { header, records, manifest } = await readArtifact(artifact);
    expect(manifest.seed).toBe(S);
    const underManifestSeed = deriveSuccessor(records[0].components, {
      seed: S,
      mutation: { probability: header.mutationProbability, magnitude: header.mutationMagnitude },
      populationSize: header.populationSize, generationIndex: 0,
    });
    const underOtherSeed = deriveSuccessor(records[0].components, {
      seed: CAPACITY_POPULATION_SEED,
      mutation: { probability: header.mutationProbability, magnitude: header.mutationMagnitude },
      populationSize: header.populationSize, generationIndex: 0,
    });
    expect(underManifestSeed.populationBytes).not.toEqual(underOtherSeed.populationBytes);
    expect(records[1].components.population).toEqual(underManifestSeed.populationBytes);
    expect(records[1].components.lineage).toEqual(underManifestSeed.lineageBytes);
    expectNoProbes();
  });

  test('a three-record artifact carries both transitions, each derived from its own record', async () => {
    // The g >= 1 coverage the two-record guards cannot see: a builder that
    // froze generationIndex, reused record 0's pool, or stopped advancing
    // the id base would pass every guard above. Record 2 must be the exact
    // kernel successor of RECORD 1's persisted facts — not of record 0's.
    const artifact = await buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 3, maxGenerations: 3,
    });
    const { header, records, manifest } = await readArtifact(artifact);
    expect(records).toHaveLength(3);
    for (const g of [0, 1]) {
      const derived = deriveSuccessor(records[g].components, {
        seed: manifest.seed,
        mutation: { probability: header.mutationProbability, magnitude: header.mutationMagnitude },
        populationSize: header.populationSize,
        generationIndex: g,
      });
      expect(records[g + 1].components.population).toEqual(derived.populationBytes);
      expect(records[g + 1].components.lineage).toEqual(derived.lineageBytes);
    }
    expect(records[2].terminalReason).toBe('generationLimitReached');
    expectNoProbes();
  });

  test('a successor requested after an empty-pool terminal is a configuration error', async () => {
    await expect(buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 2, maxGenerations: 3, invalidPoolAt: 0,
    })).rejects.toThrow(/terminal \('noSelectableParents'\).*no persisted successor/);
  });

  test('a successor requested past the generation limit is a configuration error', async () => {
    await expect(buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 2, maxGenerations: 1,
    })).rejects.toThrow(/terminal \('generationLimitReached'\).*no persisted successor/);
  });

  test('an invalidPoolAt naming no generation is a configuration error', async () => {
    // Out-of-domain values must fail loudly rather than silently build a
    // fully selectable artifact (external-review finding: 99, -2, 1.5 and
    // generationCount itself all used to slip past the loop untouched).
    await expect(buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 2, maxGenerations: 2, invalidPoolAt: 2,
    })).rejects.toThrow(/invalidPoolAt 2 .*configuration error/);
    await expect(buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 2, maxGenerations: 2, invalidPoolAt: 1.5,
    })).rejects.toThrow(/invalidPoolAt 1.5 .*configuration error/);
    await expect(buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 2, maxGenerations: 2, invalidPoolAt: -2,
    })).rejects.toThrow(/invalidPoolAt -2 .*configuration error/);
  });
});

// ============================================================================
// Lineage semantics: version compatibility, then cross-generation coherence
// ============================================================================

describe('lineage semantics', () => {
  test('a stale nested lineage version reports unsupportedVersion before any semantic defect', async () => {
    // Combined fault, by construction: the SAME artifact also carries a
    // generation-1 lineage row whose id does not match its population — the
    // stale version must win (the ladder's unsupported → malformed order).
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 0) {
          record.components.lineage = withLeadingU16(
            record.components.lineage, EVOLUTION_LINEAGE_VERSION - 1,
          );
        }
        if (i === 1) {
          rewriteLineage(record, 1, (rows) => { rows[5].individualId = 12; });
        }
      },
    });
    for (const reader of [extractHistoryObservations, resumeEvolutionRun]) {
      const err = await expectCodeAsync(() => reader(broken), 'unsupportedVersion',
        /generation 0 lineage lineageVersion is 0; this build implements 1/);
      expect(err.context.field).toBe('lineageVersion');
      expect(err.context.stored).toBe(0);
      expect(err.context.current).toBe(EVOLUTION_LINEAGE_VERSION);
    }
    expectNoProbes();
  });

  test('a malformed lineage prefix never masks a stale vector version', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 0) record.components.lineage = record.components.lineage.slice(0, 1);
        if (i === 1) {
          record.components.fitnessVector = withLeadingU16(
            record.components.fitnessVector, FITNESS_VECTOR_VERSION - 1,
          );
        }
      },
    });
    await expectBothReaders(broken, 'unsupportedVersion',
      /generation 1 fitness vector fitnessVectorVersion is 2; this build implements 3/);
    expectNoProbes();
  });

  test('a malformed vector prefix never masks a stale lineage version', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 0) record.components.fitnessVector = record.components.fitnessVector.slice(0, 1);
        if (i === 1) {
          record.components.lineage = withLeadingU16(
            record.components.lineage, EVOLUTION_LINEAGE_VERSION - 1,
          );
        }
      },
    });
    await expectBothReaders(broken, 'unsupportedVersion',
      /generation 1 lineage lineageVersion is 0; this build implements 1/);
    expectNoProbes();
  });

  test('a lineage row id that does not match its population id is malformedHistory', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) rewriteLineage(record, 1, (rows) => { rows[5].individualId = 12; });
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory',
      /row 5 id 12 does not match population id 11/);
    expect(extraction.context).toMatchObject({
      index: 5, lineageId: 12, populationId: 11, generationIndex: 1,
    });
    expectNoProbes();
  });

  test('a derived row in generation 0 is malformedHistory', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 0) {
          rewriteLineage(record, 0, (rows) => {
            rows[0].origin = 'eliteCopy';
            rows[0].parentIndividualId = 0;
          });
        }
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory',
      /has origin 'eliteCopy' in generation 0, which has no predecessor/);
    expect(extraction.context).toMatchObject({ index: 0, individualId: 0, generationIndex: 0 });
    expectNoProbes();
  });

  test('an initialized row in generation 1 is malformedHistory', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          rewriteLineage(record, 1, (rows) => {
            rows[0].origin = 'initialized';
            rows[0].parentIndividualId = null;
          });
        }
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory',
      /is 'initialized' in generation 1, which has a predecessor/);
    expect(extraction.context).toMatchObject({ index: 0, individualId: 6, generationIndex: 1 });
    expectNoProbes();
  });

  test('a parent outside the immediately preceding generation is malformedHistory', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) rewriteLineage(record, 1, (rows) => { rows[2].parentIndividualId = 99; });
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory',
      /names parent 99, which is not in generation 0/);
    expect(extraction.context).toMatchObject({
      index: 2, individualId: 8, parentIndividualId: 99, generationIndex: 1,
    });
    expectNoProbes();
  });

  test('a lineage generationIndex that is not the record index is malformedHistory', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          const lineage = deserializeLineage(record.components.lineage);
          record.components.lineage = serializeLineage({
            lineageVersion: EVOLUTION_LINEAGE_VERSION,
            generationIndex: 0,
            individuals: lineage.individuals,
          });
        }
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory',
      /generationIndex 0 does not match the record's 1/);
    expect(extraction.context).toMatchObject({ lineageGenerationIndex: 0, generationIndex: 1 });
    expectNoProbes();
  });

  test('a truncated but version-readable lineage is malformedHistory from the pass', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) record.components.lineage = record.components.lineage.slice(0, 20);
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory',
      /generation 1 lineage is malformed/);
    expect(extraction.context.generationIndex).toBe(1);
    expectNoProbes();
  });

  test('a lineage too short to reveal its version is the stage-9 malformed prefix', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) record.components.lineage = record.components.lineage.slice(0, 1);
      },
    });
    await expectBothReaders(broken, 'malformedHistory',
      /generation 1 lineage has a truncated or unreadable version prefix/);
    expectNoProbes();
  });

  test('a lineage oversized for the header population is refused before any row is decoded', async () => {
    // Seven rows for a population of 6: 10 + 7×53 = 381 bytes against the
    // bounded 328. The allocation guard (the fitness-vector guard's lineage
    // twin) must fire BEFORE the decoder walks a single row — a 16 MiB
    // component could otherwise declare ~316k rows against a population
    // capped at 256 and materialize them all before crossCheckLineage ever
    // sees the count.
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          rewriteLineage(record, 1, (rows) => {
            rows.push({
              individualId: 12,
              parentIndividualId: 5,
              origin: 'continuousMutation',
              accounting: zeroLineageAccounting(),
            });
          });
        }
      },
    });
    const { extraction, resume } = await expectBothReaders(broken, 'malformedHistory',
      /generation 1 lineage byteLength 381 exceeds header populationSize 6 allocation bound \(328 bytes\)/);
    for (const err of [extraction, resume]) {
      expect(err.context).toMatchObject({
        rule: 'lineagePopulationSizeOverflow',
        generationIndex: 1,
        populationSize: 6,
        actualByteLength: 381,
        expectedByteLength: 328,
      });
    }
    expectNoProbes();
  });
});

// ============================================================================
// ID-allocation semantics: the exact fresh never-recycled block g × N + m
// ============================================================================

describe('ID-allocation semantics', () => {
  test('generation 1 recycling generation 0\'s ids is refused by the ID rule, not the lineage rule', async () => {
    // Lineage re-aligned (ids match, every parent in generation 0), so
    // `crossCheckLineage` passes — only the allocation policy sees the reuse.
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) rewriteGenerationIds(record, 1, [0, 1, 2, 3, 4, 5]);
      },
    });
    const { extraction, resume } = await expectBothReaders(broken, 'malformedHistory');
    for (const err of [extraction, resume]) {
      expect(err.context).toMatchObject({
        rule: 'individualIdAllocationMismatch',
        generationIndex: 1,
        memberIndex: 0,
        stored: 0,
        expected: 6,
      });
    }
    expectNoProbes();
  });

  test('a shifted but contiguous block (7..12 instead of 6..11) is refused', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) rewriteGenerationIds(record, 1, [7, 8, 9, 10, 11, 12]);
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'individualIdAllocationMismatch', generationIndex: 1, memberIndex: 0, stored: 7, expected: 6,
    });
    expectNoProbes();
  });

  test('one id introducing a gap is refused at the exact member', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) rewriteGenerationIds(record, 1, [6, 7, 8, 9, 10, 12]);
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'individualIdAllocationMismatch', generationIndex: 1, memberIndex: 5, stored: 12, expected: 11,
    });
    expectNoProbes();
  });
});

// ============================================================================
// Terminal semantics: the stored reason must equal the persisted facts'
// ============================================================================

describe('terminal semantics', () => {
  test('an empty selectable pool with persisted none is refused', async () => {
    // Honest base first: the builder recomputes and persists
    // 'noSelectableParents' for the empty pool; the reforge then lies about
    // it, so the terminal rule — not the builder — is what the test isolates.
    const artifact = await buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 1, maxGenerations: 2, invalidPoolAt: 0,
    });
    const broken = await reforge(artifact, {
      mutateRecord: (record) => { record.terminalReason = 'none'; },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'terminalReasonMismatch', generationIndex: 0, stored: 'none', expected: 'noSelectableParents',
    });
    expectNoProbes();
  });

  test('a nonempty pool with persisted noSelectableParents is refused', async () => {
    const artifact = await buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 1, maxGenerations: 2,
    });
    const broken = await reforge(artifact, {
      mutateRecord: (record) => { record.terminalReason = 'noSelectableParents'; },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'terminalReasonMismatch', generationIndex: 0, stored: 'noSelectableParents', expected: 'none',
    });
    expectNoProbes();
  });

  test('generationLimitReached on a one-record history declaring more is refused', async () => {
    const artifact = await buildSynthesizedArtifact(runtime, {
      populationSize: SMALL, generationCount: 1, maxGenerations: 3,
    });
    const broken = await reforge(artifact, {
      mutateRecord: (record) => { record.terminalReason = 'generationLimitReached'; },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'terminalReasonMismatch', generationIndex: 0, stored: 'generationLimitReached', expected: 'none',
    });
    expectNoProbes();
  });

  test('a full count whose final record is none is refused', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => { if (i === 1) record.terminalReason = 'none'; },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'terminalReasonMismatch',
      generationIndex: 1,
      stored: 'none',
      expected: 'generationLimitReached',
    });
    expectNoProbes();
  });

  test('individualIdExhausted persisted under the v1 caps is always refused', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => { if (i === 1) record.terminalReason = 'individualIdExhausted'; },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'terminalReasonMismatch',
      generationIndex: 1,
      stored: 'individualIdExhausted',
      expected: 'generationLimitReached',
    });
    expectNoProbes();
  });

  test('an empty pool at the declared last generation still expects noSelectableParents (precedence)', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          emptyPool(record);
          record.terminalReason = 'generationLimitReached';
        }
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'terminalReasonMismatch',
      generationIndex: 1,
      stored: 'generationLimitReached',
      expected: 'noSelectableParents',
    });
    expectNoProbes();
  });
});

// ============================================================================
// Record-count semantics: the count never exceeds the declared maximum
// ============================================================================

describe('record-count semantics', () => {
  test('a record count above header.maxGenerations is refused before the per-generation rules', async () => {
    const broken = await reforge(synth2, {
      mutateHeader: (header) => ({ ...header, maxGenerations: 1 }),
    });
    const { extraction, resume } = await expectBothReaders(broken, 'malformedHistory');
    for (const err of [extraction, resume]) {
      expect(err.context).toMatchObject({
        rule: 'recordCountExceedsMaxGenerations', recordCount: 2, maxGenerations: 1,
      });
    }
    expectNoProbes();
  });
});

// ============================================================================
// Combined-fault precedence: the ladder order, with semantics before capacity
// ============================================================================

describe('combined-fault precedence', () => {
  test('a wrong expected digest beats every lineage, ID, terminal and count defect', async () => {
    // One artifact carrying ALL of them: stale lineage version at generation
    // 0, a shifted ID block and a contradictory terminal reason at generation
    // 1, and a header declaring less than the record count.
    const broken = await reforge(synth2, {
      mutateHeader: (header) => ({ ...header, maxGenerations: 1 }),
      mutateRecord: (record, i) => {
        if (i === 0) {
          record.components.lineage = withLeadingU16(
            record.components.lineage, EVOLUTION_LINEAGE_VERSION - 1,
          );
        }
        if (i === 1) {
          rewriteGenerationIds(record, 1, [7, 8, 9, 10, 11, 12]);
          record.terminalReason = 'noSelectableParents';
        }
      },
    });
    const wrongDigest = new Uint8Array(SHA256_DIGEST_BYTES);
    await expectCodeAsync(
      () => extractHistoryObservations(broken, { expectedHistoryDigestBytes: wrongDigest }),
      'staleOrWrongArtifact',
    );
    await expectCodeAsync(
      () => resumeEvolutionRun(broken, { expectedHistoryDigestBytes: wrongDigest }),
      'staleOrWrongArtifact',
    );
    expectNoProbes();
  });

  test('malformed lineage semantics beats capacity by both readers', async () => {
    const broken = await reforge(overDeclared, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          rewriteLineage(record, 1, (rows) => {
            rows[0].origin = 'initialized';
            rows[0].parentIndividualId = null;
          });
        }
      },
    });
    await expectBothReaders(broken, 'malformedHistory', /has a predecessor/);
    expectNoProbes();
  });

  test('an oversized lineage beats capacity by both readers', async () => {
    // 257 rows for a population of 256: 13,631 bytes against the bounded
    // 13,578 — refused before decode, and before the capacity projection.
    const broken = await reforge(overDeclared, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          rewriteLineage(record, 1, (rows) => {
            rows.push({
              individualId: CAP * 2,
              parentIndividualId: CAP - 1,
              origin: 'continuousMutation',
              accounting: zeroLineageAccounting(),
            });
          });
        }
      },
    });
    const { extraction, resume } = await expectBothReaders(broken, 'malformedHistory');
    for (const err of [extraction, resume]) {
      expect(err.context).toMatchObject({
        rule: 'lineagePopulationSizeOverflow',
        generationIndex: 1,
        populationSize: CAP,
        actualByteLength: 10 + (CAP + 1) * 53,
        expectedByteLength: 10 + CAP * 53,
      });
    }
    expectNoProbes();
  });

  test('a wrong ID block beats capacity by both readers', async () => {
    const shifted = Array.from({ length: CAP }, (_, m) => CAP + 1 + m);
    const broken = await reforge(overDeclared, {
      mutateRecord: (record, i) => {
        if (i === 1) rewriteGenerationIds(record, 1, shifted);
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'individualIdAllocationMismatch', generationIndex: 1, memberIndex: 0,
      stored: CAP + 1, expected: CAP,
    });
    expectNoProbes();
  });

  test('malformed terminal semantics beats capacity by both readers', async () => {
    const broken = await reforge(overDeclared, {
      mutateRecord: (record, i) => { if (i === 1) record.terminalReason = 'noSelectableParents'; },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context).toMatchObject({
      rule: 'terminalReasonMismatch', generationIndex: 1, stored: 'noSelectableParents', expected: 'none',
    });
    expectNoProbes();
  });

  test('within one generation a lineage defect beats an ID defect', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          rewriteGenerationIds(record, 1, [7, 8, 9, 10, 11, 12]);
          rewriteLineage(record, 1, (rows) => { rows[5].individualId = 13; });
        }
      },
    });
    const { extraction, resume } = await expectBothReaders(broken, 'malformedHistory',
      /row 5 id 13 does not match population id 12/);
    // The LINEAGE coherence verdict (crossCheckLineage's context), not the
    // ID-allocation rule that a later check in the same generation would name.
    for (const err of [extraction, resume]) {
      expect(err.context).toMatchObject({
        index: 5, lineageId: 13, populationId: 12, generationIndex: 1,
      });
    }
    expectNoProbes();
  });

  test('within one generation an ID defect beats a terminal mismatch', async () => {
    const broken = await reforge(synth2, {
      mutateRecord: (record, i) => {
        if (i === 1) {
          rewriteGenerationIds(record, 1, [7, 8, 9, 10, 11, 12]);
          record.terminalReason = 'noSelectableParents';
        }
      },
    });
    const { extraction } = await expectBothReaders(broken, 'malformedHistory');
    expect(extraction.context.rule).toBe('individualIdAllocationMismatch');
    expectNoProbes();
  });
});

// ============================================================================
// terminalReasonFor: the precedence table, direct against the one policy home
// ============================================================================

describe('terminalReasonFor — the one terminal-policy home', () => {
  const forFacts = (overrides) => terminalReasonFor({
    selectableCount: 3,
    generationIndex: 0,
    maxGenerations: 3,
    nextIndividualId: 6,
    populationSize: 6,
    ...overrides,
  });

  test('an empty pool wins first — even at the declared last generation', () => {
    expect(forFacts({ selectableCount: 0 })).toBe('noSelectableParents');
    expect(forFacts({ selectableCount: 0, generationIndex: 2 })).toBe('noSelectableParents');
  });

  test('a nonempty pool at the declared last generation reaches the limit', () => {
    expect(forFacts({ generationIndex: 2 })).toBe('generationLimitReached');
  });

  test('the id-exhaustion arithmetic boundary is exact', () => {
    // last === 0xffffffff still fits; last === 0x100000000 does not.
    expect(forFacts({ nextIndividualId: 0xffffffff - 6 + 1 })).toBe('none');
    expect(forFacts({ nextIndividualId: 0x100000000 - 6 + 1 })).toBe('individualIdExhausted');
  });

  test('a mid-run generation with room is none', () => {
    expect(forFacts({})).toBe('none');
    expect(forFacts({ generationIndex: 1 })).toBe('none');
  });

  test('individualIdExhausted is unreachable under the v1 caps', () => {
    // The worst case the caps allow: generation 1022 of 1024 at population
    // 256 — nextIndividualId + populationSize - 1 = 1024 × 256 - 1 ≪ 2³².
    expect(terminalReasonFor({
      selectableCount: 1,
      generationIndex: 1022,
      maxGenerations: 1024,
      nextIndividualId: 1023 * 256,
      populationSize: 256,
    })).toBe('none');
  });
});

// ============================================================================
// Static enforcement: the terminal policy has exactly one implementation home
// ============================================================================

const POLICY_MODULE = 'src/sim/evolution-contract.js';
const POLICY_READERS = ['src/sim/evolution-run.js', 'src/sim/evolution-replay.js'];
const POLICY_IMPORT = /import\s*\{[^}]*\bterminalReasonFor\b[^}]*\}\s*from\s*['"]\.\/evolution-contract\.js['"]/;

const walkJs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = `${dir}/${entry.name}`;
  return entry.isDirectory() ? walkJs(path) : [path];
});
const SOURCE_FILES = ['src', 'scripts']
  .flatMap(walkJs)
  .filter((path) => path.endsWith('.js'));

describe('the terminal policy has exactly one implementation home', () => {
  test('evolution-contract.js declares the one scalar decision function', () => {
    expect(readFileSync(POLICY_MODULE, 'utf8')).toMatch(/export function terminalReasonFor\b/);
  });

  test('both readers import it from the contract leaf', () => {
    for (const file of POLICY_READERS) {
      expect(readFileSync(file, 'utf8')).toMatch(POLICY_IMPORT);
    }
  });

  test('neither reader declares a local implementation, in any shape', () => {
    const localFunction = /function terminalReasonFor\b/;
    const localArrow = /(?:const|let|var)\s+terminalReasonFor\b\s*=/;
    const oldHome = /function terminalFor\b|\bterminalFor\s*\(/;
    for (const file of POLICY_READERS) {
      const source = readFileSync(file, 'utf8');
      expect(localFunction.test(source), `${file} must not define terminalReasonFor`).toBe(false);
      expect(localArrow.test(source), `${file} must not define terminalReasonFor`).toBe(false);
      expect(oldHome.test(source), `${file} must not keep the old local terminalFor`).toBe(false);
    }
  });

  test('no other src/ or scripts/ module even references the policy name', () => {
    for (const file of SOURCE_FILES) {
      if (file === POLICY_MODULE || POLICY_READERS.includes(file)) continue;
      const source = readFileSync(file, 'utf8');
      expect(source.includes('terminalReasonFor'), `${file} must not reference terminalReasonFor`)
        .toBe(false);
    }
  });

  test('neither reader re-exports the policy, in any export shape', () => {
    // Multiline-tolerant named-export shape (this catches the existing
    // `export { ... } from './evolution-contract.js'` line if the name ever
    // joins it), plus the star shape.
    const namedReExport = /export\s*\{[^}]*\bterminalReasonFor\b[^}]*\}/;
    const starReExport = /export\s+\*\s+from\s*['"][^'"]*evolution-contract\.js['"]/;
    for (const file of POLICY_READERS) {
      const source = readFileSync(file, 'utf8');
      expect(namedReExport.test(source), `${file} must not re-export terminalReasonFor`).toBe(false);
      expect(starReExport.test(source), `${file} must not star-re-export the contract`).toBe(false);
    }
  });
});
