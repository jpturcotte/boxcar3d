// THE DEEP MODULE: a deterministic evolution run.
//
// One coherent history-owning engine behind a deliberately small public
// interface:
//
//   createEvolutionRun(config) -> EvolutionRun
//   await run.advance()        -> AdvanceResult
//   run.status()               -> EvolutionRunStatus
//
// (Commit 2 adds `run.historyBytes()`; Commit 3 adds `resumeEvolutionRun`.)
//
// WHY THERE IS NO PUBLIC `advanceGeneration(population, evaluation, ...)`.
// A stateless transition would have to accept a population and a fitness
// result as INDEPENDENTLY SUPPLIED artifacts and then decide whether they
// belong together. The only binding available for that decision is the fitness
// vector's FNV-32 population-snapshot digest state — and PR 2's operator
// boundary already ruled that this state is a same-source, in-process mismatch
// SENTINEL, never equality between independently supplied artifacts (a 32-bit
// hash collides by the birthday bound; one appears in seconds). Rather than
// build a public seam whose safety depends on a hash that is documented not to
// provide it, the transition is PRIVATE to an opaque run: the run decodes the
// population from bytes it owns, evaluates exactly that population, and
// derives the fitness vector from the same owned transition. The FNV state is
// then still checked — as the sentinel it is, against values the module itself
// produced moments earlier — and it is never asked to establish identity.
//
// WHAT THE RUN OWNS. Canonical header inputs, the pending population's
// canonical snapshot bytes, the pending generation's lineage bytes, the next
// individual id, the terminal reason, and the committed generation records.
// No public method returns the pending population, the live evaluation object,
// the selection pool, mutable lineage rows, or any internal buffer; the only
// bytes that leave are fresh copies of committed history.
//
// TRACE EXCLUSION (PR 3 Commit 0's approved policy, and the premise it rests
// on). This module imports NO trace module, and `evaluatePopulation` — the one
// physics seam it uses — evaluates at `trace: { mode: 'none' }`, which is a
// literal no-work path. Nothing in the record geometry can carry a trace, a
// checkpoint, a live diagnostic, or comparator evidence. The teeth for this
// live in tests/evolution-run.test.js, statically and at runtime, so the
// policy premise fails a build rather than rotting into prose.
//
// DIAGNOSTICS NEVER ENTER STATE. `createInitialPopulation` returns
// per-individual diagnostics (and, under keepRaw, raw draws);
// `mutateContinuousGenotype` returns a diagnostic `rawGenotype`. Neither is
// retained: the run keeps the repaired, canonical genome and the frozen
// accounting, and nothing else.

import { Rng } from './prng.js';
import { serializeGenotype } from './assembly.js';
import {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_DEFAULTS, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE, mutateContinuousGenotype, selectElites,
  selectTournamentParent,
} from './evolution-operators.js';
import { copyOrdinaryBytes, typedArrayByteLength } from './bytes.js';
import {
  COMPONENT_KINDS, EVALUATION_METADATA_VERSION, GENERATION_RECORD_VERSION,
  assembleHistory, digestComponent, digestGeneration, digestHeader,
  encodeEvolutionHeader, encodeGenerationPayload, projectEvolutionHistoryCapacity,
  serializeEvaluationMetadata,
} from './evolution-history.js';
import {
  POPULATION_SNAPSHOT_VERSION, deserializePopulationSnapshot, serializePopulationSnapshot,
} from './population.js';
import {
  INITIAL_POPULATION_DEFAULTS, createInitialPopulation,
  deserializePopulationInitialization, serializePopulationInitialization,
} from './population-initializer.js';
import {
  POPULATION_WORLD_MODE, canonicalizeEvaluationSpec, deserializeEvaluationSpec,
  deserializeFitnessVector, evaluatePopulation, fitnessVectorByteLength,
  selectablePoolFromEvaluation,
} from './population-evaluation.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from './fnv1a.js';
import { readDeterministicRuntimeIdentity } from './physics/adapter.js';
import {
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, EvolutionError,
  MAX_EVOLUTION_EVALUATION_WORK, MAX_EVOLUTION_GENERATIONS,
  MAX_EVOLUTION_POPULATION_SIZE, checkedAdd, checkedMultiply, evolutionFail,
  isEvolutionUint32,
} from './evolution-contract.js';
import {
  EVOLUTION_LINEAGE_VERSION, crossCheckLineage, deserializeLineage, lineageByteLength,
  serializeLineage, zeroLineageAccounting,
} from './evolution-lineage.js';
import {
  MAX_EVOLUTION_HISTORY_BYTES, captureExpectedIdentity, checkExpectedIdentity,
  checkRuntimeIdentity, failReplayDivergence, verifyHistoryArtifact,
} from './evolution-replay.js';
import { decodeGenerationPayload } from './evolution-history.js';

export { EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, TERMINAL_REASONS } from './evolution-contract.js';

const CONFIG_KEYS = Object.freeze(['initialization', 'evaluationSpec', 'evolution']);
const INITIALIZATION_KEYS = Object.freeze(['seed', ...Object.keys(INITIAL_POPULATION_DEFAULTS)]);
const EVOLUTION_KEYS = Object.freeze(['maxGenerations', 'mutation']);
const MUTATION_KEYS = Object.freeze(['probability', 'magnitude']);

function invalid(message, context = {}, cause = undefined) {
  evolutionFail('invalidConfig', message, context, cause);
}

/** The byte-layer fail idiom, routed through this module's error taxonomy. */
function bytesFail(path, value) {
  evolutionFail('malformedHistory', `evolution-run: invalid ${path} (${String(value)})`, { path });
}

/** Caller-supplied option bytes are configuration, never persisted-history corruption. */
function configBytesFail(path, value) {
  evolutionFail('invalidConfig', `evolution-run: invalid option ${path} (${String(value)})`, { path });
}

/**
 * Run `body`, and re-raise anything a lower-level module throws under this
 * module's stable code with the original attached as `cause`.
 *
 * An `EvolutionError` passes through untouched: it already carries a stable
 * code, and re-wrapping it would bury a precise `resourceLimitExceeded` inside
 * a vaguer one. This is the one place the taxonomy meets the rest of the repo.
 */
function translate(code, message, body) {
  try {
    return body();
  } catch (cause) {
    if (cause instanceof EvolutionError) throw cause;
    evolutionFail(code, `${message}: ${cause && cause.message ? cause.message : String(cause)}`, {}, cause);
    return undefined; // unreachable; evolutionFail always throws
  }
}

/**
 * Structural intake for every caller-supplied container in the config.
 *
 * Three rules, each closing a measured class from the round-11 sweep:
 *  - a non-plain prototype is refused (an inherited enumerable knob would be
 *    dropped by an own-key walk and silently revert to a default);
 *  - a non-enumerable own property is refused (the presence gate and the
 *    consumer would then read different property sets — the rule is that a
 *    guard deciding presence uses the same enumeration its consumer reads
 *    with);
 *  - the own-key set must be a subset of the declared keys, so an unknown key
 *    fails rather than being ignored.
 * Returns the CAPTURED own keys; the caller reads each value exactly once.
 */
function structuralKeys(value, path, declared) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${path} must be a plain object`, { path });
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    invalid(`${path} must be a plain object (a custom prototype's enumerable keys would be dropped)`, { path });
  }
  const keys = Object.keys(value);
  if (Object.getOwnPropertyNames(value).length !== keys.length) {
    invalid(`${path} carries non-enumerable own properties`, { path });
  }
  for (let i = 0; i < keys.length; i += 1) {
    if (!declared.includes(keys[i])) invalid(`${path}.${keys[i]} is not a known key`, { path, key: keys[i] });
  }
  return keys;
}

function captureInitialization(source) {
  const keys = structuralKeys(source, 'initialization', INITIALIZATION_KEYS);
  const owned = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const value = source[key]; // ONE read per key
    if (key === 'initialSuspensionTypes') {
      if (!Array.isArray(value)) invalid('initialization.initialSuspensionTypes must be an array', {});
      // Bound captured before the copy; elements copied by index. The
      // initializer's own resolvePolicy re-validates the values.
      const count = value.length;
      if (count > MAX_EVOLUTION_POPULATION_SIZE) {
        evolutionFail('resourceLimitExceeded', `initialization.initialSuspensionTypes length ${count} is nonsensical`, { count });
      }
      const copy = [];
      for (let j = 0; j < count; j += 1) copy.push(value[j]);
      owned[key] = copy;
    } else {
      owned[key] = value;
    }
  }
  const seed = owned.seed;
  const populationSize = owned.populationSize;
  if (!isEvolutionUint32(seed)) {
    invalid(`initialization.seed must be a canonical uint32 (${String(seed)})`, { seed: String(seed) });
  }
  // THE EVOLUTION CEILING, checked BEFORE createInitialPopulation allocates
  // anything. The initializer's own MAX_POPULATION_SIZE (1e6) only stops a
  // heap abort for a single generation; evolution multiplies a population by
  // up to MAX_EVOLUTION_GENERATIONS generations of retained history, so the
  // evolution-specific cap is far lower and is enforced here rather than
  // discovered as a late allocation failure.
  if (!Number.isInteger(populationSize) || populationSize < 1) {
    invalid(`initialization.populationSize must be an integer >= 1 (${String(populationSize)})`, { populationSize: String(populationSize) });
  }
  if (populationSize > MAX_EVOLUTION_POPULATION_SIZE) {
    evolutionFail('resourceLimitExceeded',
      `initialization.populationSize ${populationSize} exceeds MAX_EVOLUTION_POPULATION_SIZE (${MAX_EVOLUTION_POPULATION_SIZE})`,
      { populationSize, limit: MAX_EVOLUTION_POPULATION_SIZE });
  }
  return { config: owned, seed, populationSize };
}

function captureMutation(source) {
  if (source === undefined) return { ...PARAMETRIC_MUTATION_DEFAULTS };
  const keys = structuralKeys(source, 'evolution.mutation', MUTATION_KEYS);
  const owned = { ...PARAMETRIC_MUTATION_DEFAULTS };
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const value = source[key]; // ONE read per key
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      invalid(`evolution.mutation.${key} must be a finite number in [0, 1] (${String(value)})`, { key, value: String(value) });
    }
    owned[key] = value;
  }
  return owned;
}

function captureEvolution(source) {
  const keys = structuralKeys(source, 'evolution', EVOLUTION_KEYS);
  if (!keys.includes('maxGenerations')) invalid('evolution.maxGenerations is required', {});
  const maxGenerations = source.maxGenerations; // ONE read
  const mutationSource = keys.includes('mutation') ? source.mutation : undefined; // ONE read
  if (!Number.isInteger(maxGenerations) || maxGenerations < 1) {
    invalid(`evolution.maxGenerations must be an integer >= 1 (${String(maxGenerations)})`, { maxGenerations: String(maxGenerations) });
  }
  if (maxGenerations > MAX_EVOLUTION_GENERATIONS) {
    evolutionFail('resourceLimitExceeded',
      `evolution.maxGenerations ${maxGenerations} exceeds MAX_EVOLUTION_GENERATIONS (${MAX_EVOLUTION_GENERATIONS})`,
      { maxGenerations, limit: MAX_EVOLUTION_GENERATIONS });
  }
  return { maxGenerations, mutation: captureMutation(mutationSource) };
}

function assertEvaluationWork(populationSize, maxSteps) {
  const work = checkedMultiply(populationSize, maxSteps, 'evolution evaluation work');
  if (work > MAX_EVOLUTION_EVALUATION_WORK) {
    evolutionFail('resourceLimitExceeded',
      `populationSize × maxSteps (${work}) exceeds MAX_EVOLUTION_EVALUATION_WORK (${MAX_EVOLUTION_EVALUATION_WORK})`,
      {
        populationSize, maxSteps, work, limit: MAX_EVOLUTION_EVALUATION_WORK,
      });
  }
}

/**
 * Capture and validate the complete caller configuration under single-read
 * rules, then normalize every artifact through its existing codec.
 *
 * "Normalize through the codec" is not ceremony: the population, the
 * initialization manifest and the evaluation spec each go out through their
 * encoder and back through their decoder, so what the run holds is decoded
 * from the exact bytes it will attest. A caller retaining a reference to the
 * config, the population, or the spec cannot change what runs.
 */
function captureConfig(config) {
  const keys = structuralKeys(config, 'config', CONFIG_KEYS);
  for (let i = 0; i < CONFIG_KEYS.length; i += 1) {
    if (!keys.includes(CONFIG_KEYS[i])) invalid(`config.${CONFIG_KEYS[i]} is required`, { key: CONFIG_KEYS[i] });
  }
  const initializationSource = config.initialization; // ONE read each
  const evaluationSpecSource = config.evaluationSpec;
  const evolutionSource = config.evolution;

  const initialization = captureInitialization(initializationSource);
  const evolution = captureEvolution(evolutionSource);

  // The spec is canonicalized ONCE: resolved, encoded, decoded, and (inside
  // the helper) proven idempotent under re-resolution. Hooks are refused there
  // — an evolution run and its replay must not be able to differ in side
  // effects or failure behaviour while presenting the same spec digest.
  //
  // The lower-level module speaks its own dialect (`population-evaluation:
  // invalid evaluation spec at ...`), which is exactly the diagnosis a human
  // wants and exactly the thing a caller must not have to PARSE. It rides
  // along as `cause` under this module's stable code, so branching stays on
  // `err.code` while the precise reason survives intact.
  const canonical = translate('invalidConfig', 'evaluationSpec is not canonicalizable',
    () => canonicalizeEvaluationSpec(evaluationSpecSource));
  if (canonical.spec.deterministic !== true) {
    invalid('evaluationSpec.deterministic must be true — evolution history binds one engine identity and replays it, which the default flavor does not promise (F10)',
      { deterministic: String(canonical.spec.deterministic) });
  }
  assertEvaluationWork(initialization.populationSize, canonical.spec.maxSteps);
  return {
    initialization, evolution, specBytes: canonical.bytes, spec: canonical.spec,
  };
}

/** Generation-0 lineage: every row initialized, no parent, zero counters. */
function initialLineage(individualIds) {
  const individuals = [];
  for (let i = 0; i < individualIds.length; i += 1) {
    individuals.push({
      individualId: individualIds[i],
      parentIndividualId: null,
      origin: 'initialized',
      accounting: zeroLineageAccounting(),
    });
  }
  return { lineageVersion: EVOLUTION_LINEAGE_VERSION, generationIndex: 0, individuals };
}

/** The ascending id list of a decoded population (module-owned throughout). */
function populationIds(population) {
  const out = [];
  const individuals = population.individuals;
  const count = individuals.length;
  for (let i = 0; i < count; i += 1) out.push(individuals[i].individualId);
  return out;
}

/**
 * Capture and validate the evaluation metadata BEFORE the live evaluation is
 * discarded. Fitness normalization must not erase determinism evidence: the
 * fitness vector carries no world mode, no effective timestep and no executed
 * step count, so replay comparing only fitness bytes would miss exactly the
 * drift class the existing evaluation locks were built to catch.
 */
function captureEvaluationMetadata(evaluation, expectedSteps) {
  const worldMode = evaluation.worldMode;
  const effectiveDt = evaluation.effectiveDt;
  const executedSteps = evaluation.executedSteps;
  if (worldMode !== POPULATION_WORLD_MODE) {
    evolutionFail('malformedHistory', `evaluation worldMode ${String(worldMode)} !== ${POPULATION_WORLD_MODE}`, { worldMode: String(worldMode) });
  }
  if (typeof effectiveDt !== 'number' || !Number.isFinite(effectiveDt) || effectiveDt <= 0) {
    evolutionFail('malformedHistory', `evaluation effectiveDt must be finite and > 0 (${String(effectiveDt)})`, { effectiveDt: String(effectiveDt) });
  }
  if (executedSteps !== expectedSteps || !isEvolutionUint32(executedSteps)) {
    evolutionFail('malformedHistory',
      `evaluation executedSteps ${String(executedSteps)} !== the canonical spec's maxSteps ${expectedSteps}`,
      { executedSteps: String(executedSteps), expectedSteps });
  }
  return Object.freeze({ worldMode, effectiveDt, executedSteps });
}

/**
 * The private, same-source generation transition. It is a free function taking
 * only module-owned values so that its inputs are visibly incapable of pairing
 * a caller's population with a caller's fitness.
 *
 * Returns the next generation's canonical population bytes and lineage bytes.
 * The caller has already decided the run is non-terminal.
 */
function deriveNextGeneration({
  population, pool, seed, mutation, baseIndividualId, generationIndex,
}) {
  const currentIds = populationIds(population);
  const size = currentIds.length;
  // ELITES FIRST, in the order selectElites returns (canonical fitness rank).
  // Each elite receives a FRESH id; its previous id survives only as lineage.
  // Reusing an elite's id would collide two generations' RNG stream ids, which
  // is the whole reason ids are never recycled.
  const elites = selectElites(population, pool);
  const eliteCount = elites.length;
  const individuals = [];
  const lineageRows = [];
  const zero = zeroLineageAccounting();
  for (let slot = 0; slot < size; slot += 1) {
    const childId = baseIndividualId + slot;
    if (slot < eliteCount) {
      const elite = elites[slot];
      individuals.push({ individualId: childId, genotype: elite.genotype });
      lineageRows.push({
        individualId: childId,
        parentIndividualId: elite.individualId,
        origin: 'eliteCopy',
        accounting: zero,
      });
      continue;
    }
    // Every child derives its OWN stream from the run seed and its OWN id.
    // There is no generation-global RNG: evaluation order, array order,
    // diagnostics, wall clock, worker count, an exception after a draft, and
    // draws made by any sibling cannot reach this stream.
    const childRng = new Rng(seed).fork(childId);
    const parentId = selectTournamentParent(pool, childRng);
    if (parentId === null) {
      // Unreachable: a non-terminal transition has a non-empty pool. Kept as a
      // loud refusal rather than an assumption, because a null here would
      // otherwise surface as an opaque lookup failure two lines down.
      evolutionFail('malformedHistory', 'tournament returned no parent from a non-empty selectable pool', { childId });
    }
    let parentGenotype = null;
    for (let i = 0; i < size; i += 1) {
      if (population.individuals[i].individualId === parentId) {
        parentGenotype = population.individuals[i].genotype;
        break;
      }
    }
    if (parentGenotype === null) {
      evolutionFail('malformedHistory', `tournament selected id ${parentId}, which is not in generation ${generationIndex}`, { parentId, generationIndex });
    }
    const mutated = mutateContinuousGenotype(parentGenotype, childRng, mutation);
    // `mutated.rawGenotype` is diagnostic-only and is deliberately dropped
    // here: it never enters run state, a lineage row, or a persisted record.
    individuals.push({ individualId: childId, genotype: mutated.genotype });
    lineageRows.push({
      individualId: childId,
      parentIndividualId: parentId,
      origin: 'continuousMutation',
      accounting: mutated.accounting,
    });
  }
  const nextGenerationIndex = generationIndex + 1;
  const nextPopulation = { snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals };
  const populationBytes = serializePopulationSnapshot(nextPopulation);
  // Decode what was just encoded: the pending state must be re-decodable
  // canonical bytes, proven now rather than discovered at the next advance.
  const decoded = deserializePopulationSnapshot(populationBytes);
  const lineage = {
    lineageVersion: EVOLUTION_LINEAGE_VERSION,
    generationIndex: nextGenerationIndex,
    individuals: lineageRows,
  };
  const lineageBytes = serializeLineage(lineage);
  crossCheckLineage(deserializeLineage(lineageBytes), nextGenerationIndex, populationIds(decoded), currentIds);
  return { populationBytes, lineageBytes };
}

/**
 * THE ONE GENERATION TRANSITION, as a free function over module-owned values.
 *
 * `advance()` and `resumeEvolutionRun`'s replay both call exactly this — which
 * is what makes replay a REPLAY rather than a second implementation that has to
 * be kept in agreement by hand. It takes only bytes and scalars the caller
 * already owns, and it returns bytes: no caller can reach it, and it cannot
 * pair a population with a fitness result it did not produce.
 *
 * Returns `{ metadataBytes, fitnessVectorBytes, terminalReason, next }`, where
 * `next` is null exactly when the transition is terminal.
 */
async function runGeneration({
  populationBytes, spec, seed, mutation, populationSize, maxGenerations,
  generationIndex, nextIndividualId,
}) {
  // Decode the population from the OWNED snapshot bytes. This is the step that
  // makes the transition same-source: what is evaluated is what the record
  // attests, because both come from these bytes.
  const population = deserializePopulationSnapshot(populationBytes);
  const evaluation = await evaluatePopulation(population, spec);
  const metadata = captureEvaluationMetadata(evaluation, spec.maxSteps);
  // Serialize the fitness vector, then immediately decode it. Everything
  // downstream — the pool, the terminal decision, the record — consumes the
  // DECODED vector, so no live evaluation object, no diagnostics block and no
  // physics result can reach the selection path or the record.
  const fitnessVectorBytes = evaluation.fitnessVector.bytes;
  const decodedVector = deserializeFitnessVector(fitnessVectorBytes);
  // The FNV state as PR 2 defines it: a same-source, in-process mismatch
  // sentinel over values this module produced moments ago — never identity,
  // and never a claim about two independently supplied artifacts.
  const snapshotState = fnv1aFold(FNV_OFFSET_BASIS, populationBytes);
  if (decodedVector.populationSnapshotDigestState !== snapshotState) {
    evolutionFail('malformedHistory',
      'the fitness vector does not attest the population that was evaluated (in-process digest-state sentinel mismatch)',
      { generationIndex });
  }
  const pool = selectablePoolFromEvaluation(decodedVector);
  // TERMINAL FIRST, exactly once, before anything is encoded or digested.
  const terminalReason = terminalFor({
    pool, generationIndex, maxGenerations, nextIndividualId, populationSize,
  });
  const next = terminalReason === 'none' ? deriveNextGeneration({
    population, pool, seed, mutation, baseIndividualId: nextIndividualId, generationIndex,
  }) : null;
  return {
    metadataBytes: serializeEvaluationMetadata(metadata),
    fitnessVectorBytes,
    terminalReason,
    next,
  };
}

/** The declared precedence, applied exactly once per transition. */
function terminalFor({
  pool, generationIndex, maxGenerations, nextIndividualId, populationSize,
}) {
  if (pool.individuals.length === 0) return 'noSelectableParents';
  if (generationIndex + 1 >= maxGenerations) return 'generationLimitReached';
  const last = nextIndividualId + populationSize - 1;
  if (!Number.isSafeInteger(last) || last > 0xffffffff) return 'individualIdExhausted';
  return 'none';
}

/**
 * An opaque deterministic evolution run.
 *
 * `advance()` is a DRAFT/COMMIT operation: nothing the run has committed
 * changes until every step of the draft has succeeded. If validation, physics,
 * mutation, encoding, hashing or allocation throws, the committed run is
 * byte-identical to its pre-call state, and retrying re-derives the same
 * result — because every child's randomness comes from `(seed, childId)`, not
 * from a mutable stream that a failed attempt could have advanced.
 */
class EvolutionRun {
  #phase = 'ready';

  #inFlight = false;

  #seed;

  #populationSize;

  #maxGenerations;

  #mutation;

  #initializationConfig;

  #initializationBytes;

  #specBytes;

  #spec;

  #runtime = null;

  #pendingGenerationIndex = 0;

  #pendingPopulationBytes;

  #pendingLineageBytes;

  #nextIndividualId;

  #terminalReason = null;

  #lastCommittedGenerationIndex = null;

  // The committed artifact. `#headerBytes`/`#headerDigestBytes` are bound at
  // the FIRST advance (the header carries runtime identity, which needs an
  // async engine load, and nothing is committed before then anyway).
  #headerBytes = null;

  #headerDigestBytes = null;

  #generations = [];

  #historyBytes = null;

  #historyDigestBytes = null;

  // The ONE constructor, taking a fully-formed module-private state record.
  // Two builders produce that record: `initialRunState` (from a validated
  // config) and, from Commit 3, the resume path (from a verified history).
  // Neither the record nor any field of it is reachable from outside this
  // module — there is deliberately no `_internalState()` escape hatch, because
  // an internal accessor is a public method by any other name and would hand a
  // caller the pending population, the lineage rows and the record list the
  // opaque-state ruling exists to withhold. Sibling modules get PURE codec
  // functions instead, called from inside this class with its own fields.
  constructor(state) {
    this.#seed = state.seed;
    this.#populationSize = state.populationSize;
    this.#maxGenerations = state.maxGenerations;
    this.#mutation = state.mutation;
    this.#specBytes = state.specBytes;
    this.#spec = state.spec;
    this.#initializationBytes = state.initializationBytes;
    this.#initializationConfig = state.initializationConfig;
    this.#pendingGenerationIndex = state.pendingGenerationIndex;
    this.#pendingPopulationBytes = state.pendingPopulationBytes;
    this.#pendingLineageBytes = state.pendingLineageBytes;
    this.#nextIndividualId = state.nextIndividualId;
    // Resume adopts the artifact's OWN header and records rather than
    // re-encoding them: continuation must extend the very chain that was
    // verified, so the bytes a resumed run appends to are the bytes it read.
    if (state.history !== undefined) {
      this.#headerBytes = state.history.headerBytes;
      this.#headerDigestBytes = state.history.headerDigestBytes;
      this.#generations = state.history.generations;
      this.#historyBytes = state.history.bytes;
      this.#historyDigestBytes = state.history.historyDigestBytes;
      this.#lastCommittedGenerationIndex = state.history.lastCommittedGenerationIndex;
      this.#runtime = state.history.runtime;
      if (state.history.terminalReason !== 'none') {
        this.#terminalReason = state.history.terminalReason;
        this.#phase = 'terminal';
      }
    }
  }

  /**
   * The engine's own view of itself. Frozen scalars only — no bytes, no
   * populations, no pools, nothing a caller could mutate or retain.
   */
  status() {
    return Object.freeze({
      phase: this.#phase,
      engineVersion: EVOLUTION_ENGINE_VERSION,
      policyVersion: EVOLUTION_POLICY_VERSION,
      populationSize: this.#populationSize,
      maxGenerations: this.#maxGenerations,
      lastCommittedGenerationIndex: this.#lastCommittedGenerationIndex,
      pendingGenerationIndex: this.#phase === 'terminal' ? null : this.#pendingGenerationIndex,
      terminalReason: this.#terminalReason,
      historyAvailable: this.#historyBytes !== null,
      committedGenerationCount: this.#generations.length,
    });
  }

  /**
   * Evaluate the pending generation, commit its record, and (when
   * non-terminal) derive the next generation.
   *
   * A terminal run returns its terminal result again without doing any work:
   * the record is never re-encoded and never appended twice, which is the
   * point — a duplicate terminal record would be a second, differently-chained
   * digest for one generation.
   *
   * SYNCHRONOUS GUARD, DELIBERATELY. This method is awaitable but is not an
   * `async function`: the in-flight check runs before any microtask, so a
   * concurrent call throws `advanceInProgress` immediately rather than
   * resolving to a rejected promise on a later turn. Both shapes look the same
   * to `await run.advance()`; only this one refuses a second caller before it
   * has had any chance to observe the draft.
   */
  advance() {
    if (this.#inFlight) {
      evolutionFail('advanceInProgress',
        'an advance is already running; a concurrent call must not observe or alter the draft',
        { phase: this.#phase, pendingGenerationIndex: this.#pendingGenerationIndex });
    }
    if (this.#phase === 'terminal') {
      return Promise.resolve(this.#terminalResult());
    }
    this.#inFlight = true;
    this.#phase = 'advancing';
    return this.#draftAndCommit().finally(() => {
      this.#inFlight = false;
      if (this.#phase === 'advancing') this.#phase = 'ready';
    });
  }

  /**
   * A fresh, ordinary `Uint8Array` copy of the committed history, every time.
   *
   * Never the internal buffer: a caller holding the run's own bytes could
   * mutate an artifact after its digest was computed — the exact
   * post-attestation class the trace deferral names — and here it would be a
   * live persisted-history hole rather than a diagnostic one.
   */
  historyBytes() {
    if (this.#historyBytes === null) {
      evolutionFail('historyUnavailable',
        'no generation has been committed yet — call advance() first (status().historyAvailable reports this without throwing)',
        { phase: this.#phase, pendingGenerationIndex: this.#pendingGenerationIndex });
    }
    return copyOrdinaryBytes(this.#historyBytes, bytesFail);
  }

  #terminalResult() {
    return Object.freeze({
      kind: 'terminal',
      committedGenerationIndex: this.#lastCommittedGenerationIndex,
      reason: this.#terminalReason,
      historyDigestBytes: copyOrdinaryBytes(this.#historyDigestBytes, bytesFail),
    });
  }

  async #runtimeIdentity() {
    // Resolved once, lazily, before the first evaluation. `createEvolutionRun`
    // is synchronous by design (its whole job is validation and generation 0,
    // both pure), and reading the engine version requires an async wasm init —
    // so identity is bound at the first moment a record could exist, which is
    // also the first moment it is needed. Memoized: one answer per run.
    if (this.#runtime === null) {
      this.#runtime = await readDeterministicRuntimeIdentity();
    }
    return this.#runtime;
  }

  /**
   * The canonical header, built once and then reused for every later append.
   * It binds runtime identity, every operator version and constant, the
   * resolved mutation NUMBERS (never "the defaults" — a future change to
   * PARAMETRIC_MUTATION_DEFAULTS must not rewrite an old artifact's meaning),
   * the initialization manifest and the evaluation spec.
   */
  async #header(runtime) {
    if (this.#headerBytes !== null) {
      return { headerBytes: this.#headerBytes, headerDigestBytes: this.#headerDigestBytes };
    }
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
      populationSize: this.#populationSize,
      maxGenerations: this.#maxGenerations,
      mutationProbability: this.#mutation.probability,
      mutationMagnitude: this.#mutation.magnitude,
      initializationManifestBytes: this.#initializationBytes,
      evaluationSpecBytes: this.#specBytes,
    });
    return { headerBytes, headerDigestBytes: await digestHeader(headerBytes) };
  }

  async #draftAndCommit() {
    const generationIndex = this.#pendingGenerationIndex;
    const populationBytes = this.#pendingPopulationBytes;
    const lineageBytes = this.#pendingLineageBytes;
    const runtime = await this.#runtimeIdentity();

    const {
      metadataBytes, fitnessVectorBytes, terminalReason, next,
    } = await runGeneration({
      populationBytes,
      spec: this.#spec,
      seed: this.#seed,
      mutation: this.#mutation,
      populationSize: this.#populationSize,
      maxGenerations: this.#maxGenerations,
      generationIndex,
      nextIndividualId: this.#nextIndividualId,
    });
    // --- THE RECORD, ENCODED ONCE, WITH ITS TERMINAL ALREADY FINAL ----------
    // The terminal reason was decided above and is written into the payload
    // before a single digest exists, so no record is ever mutated after being
    // digested and no duplicate terminal record can be appended.
    const { headerBytes, headerDigestBytes } = await this.#header(runtime);
    const components = {
      population: populationBytes,
      evaluationMetadata: metadataBytes,
      fitnessVector: fitnessVectorBytes,
      lineage: lineageBytes,
    };
    const componentDigests = {};
    for (let i = 0; i < COMPONENT_KINDS.length; i += 1) {
      const kind = COMPONENT_KINDS[i];

      componentDigests[kind] = await digestComponent(kind, components[kind]);
    }
    const payloadBytes = encodeGenerationPayload(
      { generationIndex, terminalReason, components }, componentDigests,
    );
    // Generation 0 chains from the HEADER digest; every later generation from
    // its predecessor. That is what makes the chain cover configuration and
    // runtime identity, not only the records.
    const previousDigestBytes = this.#generations.length === 0
      ? headerDigestBytes
      : this.#generations[this.#generations.length - 1].generationDigestBytes;
    const generationDigestBytes = await digestGeneration(previousDigestBytes, payloadBytes);
    const generations = [];
    for (let i = 0; i < this.#generations.length; i += 1) generations.push(this.#generations[i]);
    generations.push(Object.freeze({ payloadBytes, generationDigestBytes }));
    const assembled = await assembleHistory({ headerBytes, headerDigestBytes, generations });

    // --- ATOMIC COMMIT ------------------------------------------------------
    // Everything above can throw without touching committed state. From here
    // the assignments are plain and cannot fail.
    this.#headerBytes = headerBytes;
    this.#headerDigestBytes = headerDigestBytes;
    this.#generations = generations;
    this.#historyBytes = assembled.bytes;
    this.#historyDigestBytes = assembled.historyDigestBytes;
    this.#lastCommittedGenerationIndex = generationIndex;
    if (terminalReason === 'none') {
      this.#pendingPopulationBytes = next.populationBytes;
      this.#pendingLineageBytes = next.lineageBytes;
      this.#pendingGenerationIndex = generationIndex + 1;
      this.#nextIndividualId += this.#populationSize;
      this.#phase = 'ready';
      return Object.freeze({
        kind: 'advanced',
        committedGenerationIndex: generationIndex,
        nextGenerationIndex: this.#pendingGenerationIndex,
        historyDigestBytes: copyOrdinaryBytes(this.#historyDigestBytes, bytesFail),
      });
    }
    this.#terminalReason = terminalReason;
    this.#phase = 'terminal';
    return this.#terminalResult();
  }

}

/**
 * Refuse a run whose legal generation count cannot fit its retained v1
 * history. Continuous mutation cannot change genotype geometry, but selection
 * can concentrate the largest starting genotype into every row, so the
 * projection uses that worst-case population rather than generation 0's sum.
 */
function assertHistoryCapacity({
  population,
  populationSize,
  maxGenerations,
  initializationBytes,
  specBytes,
  spec,
}) {
  let maximumGenotypeBytes = 0;
  for (let i = 0; i < population.individuals.length; i += 1) {
    maximumGenotypeBytes = Math.max(
      maximumGenotypeBytes,
      serializeGenotype(population.individuals[i].genotype).length,
    );
  }
  const maximumPopulationBytes = checkedAdd(
    2 + 2 + 4,
    checkedMultiply(populationSize, 4 + 4 + maximumGenotypeBytes, 'projected population snapshot'),
    'projected population snapshot',
  );
  const metadataBytes = serializeEvaluationMetadata({
    worldMode: POPULATION_WORLD_MODE,
    effectiveDt: 1,
    executedSteps: spec.maxSteps,
  }).length;
  const projection = projectEvolutionHistoryCapacity({
    initializationManifestByteLength: initializationBytes.length,
    evaluationSpecByteLength: specBytes.length,
    generationCount: maxGenerations,
    componentByteLengths: {
      population: maximumPopulationBytes,
      evaluationMetadata: metadataBytes,
      fitnessVector: fitnessVectorByteLength(populationSize),
      lineage: lineageByteLength(populationSize),
    },
  });
  if (projection.projectedBytes > MAX_EVOLUTION_HISTORY_BYTES) {
    evolutionFail('resourceLimitExceeded',
      `projected evolution history ${projection.projectedBytes} exceeds MAX_EVOLUTION_HISTORY_BYTES (${MAX_EVOLUTION_HISTORY_BYTES})`,
      {
        projectedBytes: projection.projectedBytes,
        limit: MAX_EVOLUTION_HISTORY_BYTES,
        maximumFeasibleGenerations: projection.maximumFeasibleGenerations,
        requestedGenerations: maxGenerations,
        generationFrameBytes: projection.generationFrameBytes,
      });
  }
}

/**
 * Build the private state record for a fresh run: generation 0's population
 * and lineage, both normalized through their codecs, plus the next free id.
 */
function initialRunState(captured) {
  const seed = captured.initialization.seed;
  const populationSize = captured.initialization.populationSize;
  const initialization = translate('invalidConfig', 'initialization is not a valid population config',
    () => createInitialPopulation(captured.initialization.config));
  // The manifest goes out through its encoder and back through its decoder;
  // only the decoded provenance and the owned bytes are retained.
  // `initialization.diagnostics` (and any raw draw) is dropped here.
  const initializationBytes = serializePopulationInitialization(initialization);
  const initializationConfig = deserializePopulationInitialization(initializationBytes);
  const pendingPopulationBytes = serializePopulationSnapshot(initialization.population);
  const decoded = deserializePopulationSnapshot(pendingPopulationBytes);
  const ids = populationIds(decoded);
  if (ids.length !== populationSize) {
    evolutionFail('invalidConfig', `generation 0 holds ${ids.length} individuals, expected ${populationSize}`,
      { count: ids.length, populationSize });
  }
  const pendingLineageBytes = serializeLineage(initialLineage(ids));
  crossCheckLineage(deserializeLineage(pendingLineageBytes), 0, ids, null);
  assertHistoryCapacity({
    population: decoded,
    populationSize,
    maxGenerations: captured.evolution.maxGenerations,
    initializationBytes,
    specBytes: captured.specBytes,
    spec: captured.spec,
  });
  return {
    seed,
    populationSize,
    maxGenerations: captured.evolution.maxGenerations,
    mutation: Object.freeze({ ...captured.evolution.mutation }),
    specBytes: captured.specBytes,
    spec: captured.spec,
    initializationBytes,
    initializationConfig,
    pendingGenerationIndex: 0,
    pendingPopulationBytes,
    pendingLineageBytes,
    // Generation-0 ids are 0..populationSize-1 (the initializer's fork stream
    // ids); the next generation must start beyond them so no stream id is ever
    // reused across generations.
    nextIndividualId: checkedAdd(0, populationSize, 'next individual id'),
  };
}

/**
 * Create a deterministic evolution run. Synchronous by design: validation and
 * generation 0 are pure, and nothing is evaluated, digested or committed until
 * the first successful `advance()`.
 */
export function createEvolutionRun(config) {
  return new EvolutionRun(initialRunState(captureConfig(config)));
}

/**
 * Verify a persisted evolution history, replay it deterministically, and return
 * a run positioned to continue (or an opaque terminal run).
 *
 * NOT an `async function`, deliberately — the same ruling as `sha256` and
 * `assembleHistory`. The caller's artifact and any expected-identity bytes are
 * validated and COPIED in the synchronous prologue, before an `await` exists to
 * suspend at, so "no caller bytes are borrowed across an await" is structural
 * rather than a convention. It also means a fancy storage shape or an
 * over-ceiling artifact is refused with a synchronous throw.
 *
 * The 64 MiB ceiling is checked on the INTRINSIC length BEFORE the copy: a
 * hostile artifact must not be able to make this function allocate its own size
 * as the price of finding out it is too big.
 */
export function resumeEvolutionRun(historyBytes, options = undefined) {
  const declaredLength = translate('malformedHistory', 'historyBytes are not valid persisted bytes',
    () => typedArrayByteLength(historyBytes));
  if (declaredLength > MAX_EVOLUTION_HISTORY_BYTES) {
    evolutionFail('resourceLimitExceeded',
      `history byte length ${declaredLength} exceeds MAX_EVOLUTION_HISTORY_BYTES (${MAX_EVOLUTION_HISTORY_BYTES})`,
      { byteLength: declaredLength, limit: MAX_EVOLUTION_HISTORY_BYTES });
  }
  const owned = copyOrdinaryBytes(historyBytes, bytesFail);
  const expected = captureExpectedIdentity(options, (b) => copyOrdinaryBytes(b, configBytesFail));
  return resumeFromOwnedBytes(owned, expected);
}

async function resumeFromOwnedBytes(owned, expected) {
  // Stages 3-7: framing, header digest + decode, every component digest, the
  // chain from the header, the whole-history digest.
  const verified = await verifyHistoryArtifact(owned);
  // Stage 8: external expected identity — staleness, distinct from corruption.
  checkExpectedIdentity(verified, expected);
  const header = verified.header;
  const spec = translate('malformedHistory', 'history evaluation spec is malformed',
    () => deserializeEvaluationSpec(header.evaluationSpecBytes));
  if (spec.deterministic !== true) {
    evolutionFail('malformedHistory',
      'history evaluation spec is not deterministic — evolution binds one engine identity',
      { deterministic: String(spec.deterministic) });
  }
  const manifest = translate('malformedHistory', 'history initialization manifest is malformed',
    () => deserializePopulationInitialization(header.initializationManifestBytes));
  const mutation = Object.freeze({
    probability: header.mutationProbability, magnitude: header.mutationMagnitude,
  });
  const seed = manifest.seed;
  const populationSize = header.populationSize;
  if (manifest.config.populationSize !== populationSize) {
    evolutionFail('malformedHistory',
      `history populationSize ${populationSize} disagrees with initialization manifest ${manifest.config.populationSize}`,
      { headerPopulationSize: populationSize, manifestPopulationSize: manifest.config.populationSize });
  }
  assertEvaluationWork(populationSize, spec.maxSteps);

  // Stage 9: the runtime gate, after all product-level resource/coherence
  // checks but before a single world is created.
  const runtime = await readDeterministicRuntimeIdentity();
  checkRuntimeIdentity(header, runtime);

  // Stage 10a: recreate generation 0 from the decoded manifest and compare its
  // population and lineage BYTES. This is the only stage that can fail with
  // stage 'initialization' — everything later is a derived generation.
  const initialization = translate('malformedHistory',
    'history initialization manifest cannot recreate generation zero',
    () => createInitialPopulation(manifest.config));
  assertHistoryCapacity({
    population: initialization.population,
    populationSize,
    maxGenerations: header.maxGenerations,
    initializationBytes: header.initializationManifestBytes,
    specBytes: header.evaluationSpecBytes,
    spec,
  });
  let populationBytes = serializePopulationSnapshot(initialization.population);
  let lineageBytes = serializeLineage(initialLineage(populationIds(
    deserializePopulationSnapshot(populationBytes),
  )));
  let nextIndividualId = checkedAdd(0, populationSize, 'next individual id');
  let lastAgreed = null;
  let pendingGenerationIndex = 0;

  const recordCount = verified.framing.generations.length;
  for (let i = 0; i < recordCount; i += 1) {
    // One decoded payload at a time; nothing is retained across iterations
    // beyond the working population/lineage bytes (the documented bound).
    const payload = decodeGenerationPayload(verified.framing.generations[i].payloadBytes);
    const stage = i === 0 ? 'initialization' : 'population';
    if (!bytesIdentical(payload.components.population, populationBytes)) {
      failReplayDivergence({
        stage,
        generationIndex: i,
        expected: payload.components.population,
        actual: populationBytes,
        lastAgreedGenerationIndex: lastAgreed,
      });
    }
    // Re-run the generation, then compare metadata BEFORE fitness: a drifted
    // timestep or step count explains a fitness difference, and reporting the
    // fitness first would bury the cause.
    const derived = await runGeneration({
      populationBytes, lineageBytes, spec, seed, mutation, populationSize,
      maxGenerations: header.maxGenerations, generationIndex: i, nextIndividualId,
    });
    if (!bytesIdentical(payload.components.evaluationMetadata, derived.metadataBytes)) {
      failReplayDivergence({
        stage: 'evaluationMetadata',
        generationIndex: i,
        expected: payload.components.evaluationMetadata,
        actual: derived.metadataBytes,
        lastAgreedGenerationIndex: lastAgreed,
      });
    }
    if (!bytesIdentical(payload.components.fitnessVector, derived.fitnessVectorBytes)) {
      failReplayDivergence({
        stage: 'fitnessVector',
        generationIndex: i,
        expected: payload.components.fitnessVector,
        actual: derived.fitnessVectorBytes,
        lastAgreedGenerationIndex: lastAgreed,
      });
    }
    if (payload.terminalReason !== derived.terminalReason) {
      evolutionFail('replayDivergence',
        `replay diverged at generation ${i}, stage 'terminalReason': history says '${payload.terminalReason}', replay computed '${derived.terminalReason}'`,
        {
          stage: 'terminalReason',
          generationIndex: i,
          expected: payload.terminalReason,
          actual: derived.terminalReason,
          lastAgreedGenerationIndex: lastAgreed,
        });
    }
    if (!bytesIdentical(payload.components.lineage, lineageBytes)) {
      failReplayDivergence({
        stage: i === 0 ? 'initialization' : 'lineage',
        generationIndex: i,
        expected: payload.components.lineage,
        actual: lineageBytes,
        lastAgreedGenerationIndex: lastAgreed,
      });
    }
    lastAgreed = i;
    if (derived.terminalReason === 'none') {
      populationBytes = derived.next.populationBytes;
      lineageBytes = derived.next.lineageBytes;
      nextIndividualId += populationSize;
      pendingGenerationIndex = i + 1;
    }
  }

  const generations = [];
  for (let i = 0; i < recordCount; i += 1) generations.push(verified.framing.generations[i]);
  return new EvolutionRun({
    seed,
    populationSize,
    maxGenerations: header.maxGenerations,
    mutation,
    specBytes: header.evaluationSpecBytes,
    spec,
    initializationBytes: header.initializationManifestBytes,
    initializationConfig: manifest,
    pendingGenerationIndex,
    pendingPopulationBytes: populationBytes,
    pendingLineageBytes: lineageBytes,
    nextIndividualId,
    history: {
      headerBytes: verified.framing.headerBytes,
      headerDigestBytes: verified.framing.headerDigestBytes,
      generations,
      bytes: owned,
      historyDigestBytes: verified.historyDigestBytes,
      lastCommittedGenerationIndex: verified.finalGenerationIndex,
      terminalReason: verified.finalTerminalReason,
      runtime,
    },
  });
}

/** Byte identity over two module-owned arrays. */
function bytesIdentical(a, b) {
  const aLength = typedArrayByteLength(a);
  const bLength = typedArrayByteLength(b);
  if (aLength !== bLength) return false;
  for (let i = 0; i < aLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
