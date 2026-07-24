// ORDERED VERIFICATION of a persisted evolution history — the stages that run
// BEFORE any physics, plus the first-divergence reporting the replay itself
// uses.
//
// A PRIVATE IMPLEMENTATION MODULE, not a new public seam. It deliberately
// contains no generation transition: `deriveNextGeneration` stays inside
// `evolution-run.js`, because a transition exported anywhere would let a caller
// pair a population with a fitness result it did not produce — the exact thing
// the opaque-run design exists to prevent. What lives here is byte work:
// framing, digests, chain, identity, and how to describe a mismatch.
//
// WHY THE STAGES ARE SEPARATE. Verifying only the outer history digest would be
// one line and would tell a user nothing: every corruption class — a flipped
// component byte, a re-ordered record, a spliced-in generation, a truncated
// tail — collapses into "the history digest is wrong". Each stage below has its
// own error code and its own localization, so a failure names WHAT broke:
//
//   1. ordinary storage + the 64 MiB ceiling      (before the first copy)
//   2. copy the caller's bytes                    (before any await)
//   3. outer framing: magic, versions, counts, nested lengths, exact EOF
//   4. header digest, then header decode
//   5. every component digest, in generation order
//   6. the generation chain, from the header digest forward
//   7. the whole-history digest
//   8. external expected identity                  (staleness, not corruption)
//   8a. fitness-vector component compatibility     (unsupported FORMAT)
//   8b. fitness-vector vs evaluation-metadata      (malformed CURRENT format)
//   9. deterministic flavor + exact Rapier version (before physics)
//  10. deterministic replay, stopping at the first byte divergence
//
// Stages 1-2 belong to the caller's intake seam (evolution-run's resume
// prologue, which must copy before it awaits); 3-7 are `verifyHistoryArtifact`;
// 8-9 are the small checks below; 10 is the run's own replay loop.
//
// WHY 8a/8b SIT WHERE THEY DO. The fitness vector is an OPAQUE component to
// the history format — the outer header binds every other version but not the
// vector's — so a stale or semantically malformed vector is invisible to
// stages 3-7 and would surface at stage 10 as `replayDivergence`, after a
// generation has been re-simulated. That reads as engine drift; the truth is a
// stale file. They run AFTER stage 8 rather than inside stage 5 so a stale
// artifact still proves its own framing, component digests, chain and history
// digest before being refused — which is what lets a superseded artifact serve
// as a regression witness instead of failing at the first byte it is judged on.
//
// NOTE that the stage names above are the ORDERED VERIFICATION LADDER, which is
// a different thing from `REPLAY_STAGES` below: that array is the vocabulary of
// stage-10's per-component byte comparison, and a format-compatibility gate has
// no place in it.
//
// MEMORY MODEL, and why verification does NOT return decoded payloads.
// `decodeGenerationPayload` copies the four component byte arrays, so decoding
// every generation up front would hold a second full copy of the artifact.
// Verification therefore decodes one payload at a time, verifies its four
// component digests, and DISCARDS it, returning only scalars plus the framing
// (whose views alias the caller's already-owned buffer). Replay decodes each
// payload again, on demand, one at a time. That is two decodes of each payload
// in exchange for a retention bound of: the artifact, ONE decoded payload, and
// the current/next working populations — which is the documented peak.

import { typedArrayByteLength } from './bytes.js';
import {
  SHA256_DIGEST_BYTES, COMPONENT_KINDS, EVALUATION_METADATA_VERSION,
  GENERATION_RECORD_VERSION,
  decodeEvolutionHeader, decodeGenerationPayload, decodeHistoryFraming,
  deserializeEvaluationMetadata,
  digestComponent, digestGeneration, digestHeader, digestHistoryBody, digestsEqual,
} from './evolution-history.js';
import {
  deserializeFitnessVector, peekFitnessVectorVersions,
} from './population-evaluation.js';
import { peekPopulationSnapshotCount } from './population.js';
import {
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, EvolutionError,
  MAX_EVOLUTION_GENERATIONS, MAX_EVOLUTION_POPULATION_SIZE,
  evolutionFail, isEvolutionUint32,
} from './evolution-contract.js';
import { EVOLUTION_LINEAGE_VERSION } from './evolution-lineage.js';
import {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE,
} from './evolution-operators.js';

/** The replay stages, in the order a record's components are compared. */
export const REPLAY_STAGES = Object.freeze([
  'initialization', 'population', 'evaluationMetadata', 'fitnessVector',
  'terminalReason', 'lineage',
]);

/** The 64 MiB intake ceiling, checked before the first copy. Re-exported so the
 * resume seam and this module cannot disagree about the number. */
export { MAX_EVOLUTION_HISTORY_BYTES } from './evolution-history.js';

/**
 * Run `body`, CAPTURING any failure as an evolution-taxonomy error rather than
 * throwing it. Returns `{ value, failure }` with exactly one of them set.
 *
 * TWO REASONS this captures instead of re-raising, and both are ordering
 * rulings the failure ladder depends on:
 *
 *  - A sibling module's decoder fails in ITS OWN dialect —
 *    `deserializeFitnessVector` throws a plain `Error` with no `code`. Callers
 *    branch on `code`, never on message text, so an error crossing a module
 *    boundary must arrive wearing this family's vocabulary. The original rides
 *    along as `cause`.
 *  - The failure is discovered while walking components (stage 5) but belongs
 *    to the "malformed current format" rung, which sits BELOW corruption and
 *    wrong-artifact. Throwing here would let a content complaint preempt the
 *    chain (stage 6), whole-history digest (stage 7) and external identity
 *    (stage 8) checks, so a doubly-broken artifact would be diagnosed by the
 *    less actionable of its two faults. Capturing lets the higher rungs run
 *    first and the gates raise what is left.
 */
function capture(code, message, body) {
  try {
    return { value: body(), failure: null };
  } catch (cause) {
    if (cause instanceof EvolutionError) return { value: null, failure: cause };
    const detail = cause && cause.message ? cause.message : String(cause);
    return { value: null, failure: new EvolutionError(code, `${message}: ${detail}`, {}, cause) };
  }
}

/**
 * The first index at which two byte arrays differ, or -1. Used only for
 * DIAGNOSTICS — a mismatch is already established by the caller's length or
 * digest comparison before this runs.
 */
export function firstByteDifference(expected, actual) {
  const expectedLength = typedArrayByteLength(expected);
  const actualLength = typedArrayByteLength(actual);
  const shared = expectedLength < actualLength ? expectedLength : actualLength;
  for (let i = 0; i < shared; i += 1) {
    if (expected[i] !== actual[i]) return i;
  }
  return expectedLength === actualLength ? -1 : shared;
}

/**
 * Raise the localized deterministic-replay failure. `expected` is the byte
 * component the ARTIFACT carries; `actual` is what this environment produced.
 *
 * `lastAgreedGenerationIndex` is null when generation 0 itself diverges — the
 * honest answer, rather than a misleading -1 or 0.
 */
export function failReplayDivergence({
  stage, generationIndex, expected, actual, lastAgreedGenerationIndex,
}) {
  const context = { stage, generationIndex, lastAgreedGenerationIndex };
  // Computed into LOCALS and assigned once. (The byte-family lint bans reading
  // a `byteOffset` PROPERTY, which is about TypedArray geometry rather than
  // this plain diagnostic record — writing locals sidesteps the false positive
  // without weakening the rule or spending a disable comment on it.)
  let offset;
  if (expected !== undefined && actual !== undefined) {
    offset = firstByteDifference(expected, actual);
    const expectedLength = typedArrayByteLength(expected);
    const actualLength = typedArrayByteLength(actual);
    Object.assign(context, {
      byteOffset: offset,
      expectedByteLength: expectedLength,
      actualByteLength: actualLength,
    });
    if (offset >= 0 && offset < expectedLength) context.expectedByte = expected[offset];
    if (offset >= 0 && offset < actualLength) context.actualByte = actual[offset];
  }
  evolutionFail('replayDivergence',
    `replay diverged at generation ${generationIndex}, stage '${stage}'`
    + (offset === undefined ? '' : ` (first differing byte ${offset})`)
    + `; last agreed generation ${lastAgreedGenerationIndex === null ? 'none' : lastAgreedGenerationIndex}`,
    context);
}

/**
 * Stages 3-7 over MODULE-OWNED bytes. Returns a small frozen record: the
 * framing (views into `bytes`), the decoded header, one scalar row per
 * generation, and the verified history digest.
 *
 * Every failure class is distinct on purpose. `malformedHistory` means the
 * bytes are not a well-formed artifact; `componentDigestMismatch` means one
 * component's content does not match the digest stored beside it;
 * `generationChainMismatch` means a record is authentic but is not in the
 * position (or the lineage of predecessors) it claims; `historyDigestMismatch`
 * means the whole artifact's trailer disagrees. Collapsing these would make
 * "someone spliced a generation in" indistinguishable from "one byte flipped".
 */
export function verifyHistoryArtifact(bytes) {
  // Stage 3: framing. Run in the SYNCHRONOUS prologue (the `sha256` /
  // `assembleHistory` ruling): a fancy storage shape or an over-ceiling
  // artifact is refused with a throw, not with a rejected promise, which is
  // what the derived storage battery can assert.
  return verifyFramedArtifact(decodeHistoryFraming(bytes));
}

async function verifyFramedArtifact(framing) {
  // Stage 4: header digest, then decode.
  const computedHeaderDigest = await digestHeader(framing.headerBytes);
  if (!digestsEqual(computedHeaderDigest, framing.headerDigestBytes)) {
    evolutionFail('componentDigestMismatch',
      'the header digest does not match the header bytes', { component: 'header' });
  }
  const header = decodeEvolutionHeader(framing.headerBytes);
  assertHeaderAgreesWithConstants(header);
  // Stage 5: every component digest, in generation order. One payload at a
  // time; nothing decoded is retained (see the memory model above).
  const records = [];
  const generationCount = framing.generations.length;
  for (let i = 0; i < generationCount; i += 1) {
    const payload = decodeGenerationPayload(framing.generations[i].payloadBytes);
    if (payload.generationIndex !== i) {
      evolutionFail('generationChainMismatch',
        `record ${i} claims generationIndex ${payload.generationIndex} — indices must be contiguous from 0`,
        { position: i, generationIndex: payload.generationIndex });
    }
    // A terminal record must be the LAST one: a terminal in the middle would
    // mean the run continued after declaring it could not.
    if (payload.terminalReason !== 'none' && i !== generationCount - 1) {
      evolutionFail('generationChainMismatch',
        `record ${i} is terminal ('${payload.terminalReason}') but is followed by ${generationCount - 1 - i} more`,
        { position: i, terminalReason: payload.terminalReason });
    }
    for (let k = 0; k < COMPONENT_KINDS.length; k += 1) {
      const kind = COMPONENT_KINDS[k];
      const computed = await digestComponent(kind, payload.components[kind]);
      if (!digestsEqual(computed, payload.componentDigests[kind])) {
        evolutionFail('componentDigestMismatch',
          `generation ${i} component '${kind}' does not match its stored digest`,
          { generationIndex: i, component: kind });
      }
    }
    records.push(Object.freeze({
      generationIndex: i,
      terminalReason: payload.terminalReason,
      fitnessVector: collectFitnessVectorFacts(payload, i),
    }));
  }
  // Stage 6: the chain, from the header digest forward.
  let previous = framing.headerDigestBytes;
  for (let i = 0; i < generationCount; i += 1) {
    const computed = await digestGeneration(previous, framing.generations[i].payloadBytes);
    if (!digestsEqual(computed, framing.generations[i].generationDigestBytes)) {
      evolutionFail('generationChainMismatch',
        `generation ${i} does not chain from ${i === 0 ? 'the header digest' : `generation ${i - 1}`}`,
        { generationIndex: i, chainedFrom: i === 0 ? 'header' : i - 1 });
    }
    previous = framing.generations[i].generationDigestBytes;
  }
  // Stage 7: the whole-history digest.
  const computedHistoryDigest = await digestHistoryBody(framing.body);
  if (!digestsEqual(computedHistoryDigest, framing.historyDigestBytes)) {
    evolutionFail('historyDigestMismatch',
      'the whole-history digest does not match the artifact body',
      { bodyByteLength: framing.body.length });
  }
  return Object.freeze({
    framing,
    header,
    records: Object.freeze(records),
    historyDigestBytes: framing.historyDigestBytes,
    finalGenerationIndex: generationCount - 1,
    finalTerminalReason: records[generationCount - 1].terminalReason,
  });
}

/**
 * Collect, from ONE generation payload, the scalar facts the two pre-physics
 * fitness-vector gates need — and nothing else.
 *
 * SCALARS ONLY, never rows. Verification's documented memory model is "one
 * decoded payload at a time, discarded"; retaining decoded members would hold
 * a second copy of every vector in the artifact and quietly break that bound.
 * A `max` is a complete check against an upper bound (max ≤ n ⟺ all ≤ n), so
 * the worst offender's three scalars are all a diagnosis needs.
 *
 * LAYERED, for the reason peekFitnessVectorVersions is layered: when the vector
 * version is not this build's, NOTHING further is read. Handing a v2 stream to
 * a v3 decoder would report `malformedHistory` — "these bytes are corrupt" —
 * about an artifact that is perfectly well-formed under the version it declares.
 *
 * NOTHING HERE THROWS. Every failure is captured into `failure` and raised by
 * the gates, which run after the artifact's own self-consistency and identity
 * checks — see `capture`. A component can be digest-consistent and still
 * internally contradictory (an unselectable member carrying a nonzero fitness,
 * an alert onset after a catastrophic one); that is a malformed
 * current-format artifact, not corruption and not a replay divergence, and it
 * must not preempt the rungs above it.
 */
function collectFitnessVectorFacts(payload, generationIndex) {
  // The peek is a foreign decoder too: a fitness-vector component truncated
  // inside its 14-byte version prefix fails in population-evaluation's dialect
  // as a plain Error with no `code`, which would escape verification untyped.
  const peeked = capture('malformedHistory',
    `generation ${generationIndex} fitness vector header is malformed`,
    () => peekFitnessVectorVersions(payload.components.fitnessVector));
  if (peeked.failure !== null) {
    // No version could be read, so no compatibility verdict is possible —
    // gate A skips a null `versions` and gate B raises this.
    return Object.freeze({
      generationIndex, versions: null, coherence: null, failure: peeked.failure,
    });
  }
  const versions = peeked.value;
  if (!versions.supported) {
    return Object.freeze({ generationIndex, versions, coherence: null, failure: null });
  }
  const decoded = capture('malformedHistory',
    `generation ${generationIndex} fitness vector is malformed`,
    () => ({
      metadata: deserializeEvaluationMetadata(payload.components.evaluationMetadata),
      vector: deserializeFitnessVector(payload.components.fitnessVector),
      // Count only — see peekPopulationSnapshotCount. The population component
      // is what the vector must agree with, and reading the run's declared
      // populationSize from the header instead would be a weaker check placed
      // at the wrong rung: the header's own agreement with the initialization
      // manifest is established later, so a forged header would be diagnosed
      // here by its symptom rather than there by its cause.
      scoredPopulationCount: peekPopulationSnapshotCount(payload.components.population),
    }));
  if (decoded.failure !== null) {
    return Object.freeze({
      generationIndex, versions, coherence: null, failure: decoded.failure,
    });
  }
  const { metadata, vector, scoredPopulationCount } = decoded.value;
  const executedSteps = metadata.executedSteps;
  const rows = vector.individuals;
  let worst = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const observations = row.integrityObservations;
    const fields = [
      ['firstAlertStep', observations.firstAlertStep],
      ['firstCatastrophicStep', observations.firstCatastrophicStep],
    ];
    for (let k = 0; k < fields.length; k += 1) {
      const [field, step] = fields[k];
      if (step === null || step <= executedSteps) continue;
      if (worst === null || step > worst.step) {
        worst = { individualId: row.individualId, field, step };
      }
    }
  }
  return Object.freeze({
    generationIndex,
    versions,
    failure: null,
    coherence: Object.freeze({
      executedSteps,
      // Carried because this is the one cross-component fact the vector's own
      // codec cannot check: its `count` is bound only to its own byte length,
      // so a vector scoring 5 of a generation's 6 individuals is perfectly
      // well-formed in isolation.
      memberCount: rows.length,
      scoredPopulationCount,
      worst: worst === null ? null : Object.freeze(worst),
    }),
  });
}

/**
 * GATE A — component compatibility. Runs AFTER the artifact has passed every
 * self-consistency check and the external identity check, and BEFORE the
 * runtime gate or any physics.
 *
 * WHY THIS POSITION, precisely, and what it does NOT buy. The failure ladder is
 * corruption -> wrong artifact -> unsupported format -> malformed current
 * format -> runtime mismatch -> deterministic divergence, and each rung has a
 * different remedy.
 *
 * Two distinct properties are at stake, and only one of them depends on this
 * gate's position:
 *
 *  - "a stale artifact still proves its own framing, component digests, chain
 *    and whole-history digest before being refused" is guaranteed by running
 *    OUTSIDE `verifyHistoryArtifact` at all. Stages 3-7 complete before either
 *    check, so this holds wherever the gate sits afterwards. (An earlier
 *    version of this comment attributed that property to the position; a
 *    sabotage pass moving the gate one line earlier left every test green,
 *    which is how the overclaim was found.)
 *  - "wrong artifact" outranks "unsupported format" — the ordering against
 *    `checkExpectedIdentity` — DOES depend on the position, and it is the
 *    reason the call sits after it. When a caller holds an expected digest and
 *    the file is both the wrong one AND an old format, the actionable answer is
 *    `staleOrWrongArtifact`: go find the right file. Telling them the format is
 *    old sends them to a migration they may not need. That ordering is pinned
 *    by a test in tests/evolution-replay.test.js.
 *
 * Without this gate a stale vector surfaces at stage 10 as `replayDivergence`
 * — after a full generation has been re-simulated — and that reads like engine
 * or environment drift when the truth is simply that the file is old.
 */
export function checkFitnessVectorCompatibility(verified) {
  const records = verified.records;
  for (let i = 0; i < records.length; i += 1) {
    const facts = records[i].fitnessVector;
    // A component whose version prefix could not be read at all yields no
    // verdict here: claiming "unsupported version" would name a version
    // nothing ever decoded. Gate B raises the captured malformedHistory.
    if (facts.versions === null) continue;
    const mismatches = facts.versions.mismatches;
    if (mismatches.length === 0) continue;
    const first = mismatches[0];
    evolutionFail('unsupportedVersion',
      `generation ${facts.generationIndex} fitness vector ${first.field} is ${first.stored}; this build implements ${first.current}`,
      {
        generationIndex: facts.generationIndex,
        field: first.field,
        stored: first.stored,
        current: first.current,
        mismatchCount: mismatches.length,
      });
  }
}

/**
 * GATE B — cross-component semantic coherence, the check no single component
 * can make on its own.
 *
 * The fitness vector carries onset STEPS; the evaluation metadata carries the
 * EXECUTED step count. Neither codec can see the other, so an artifact
 * declaring `executedSteps: 45` and `firstAlertStep: 4000000000` is
 * well-formed by every check that exists before this one — framing, all four
 * component digests, the chain, the whole-history digest, the version fields,
 * the runtime identity — and would then be re-simulated and reported as
 * `replayDivergence`. It is not divergence; it is a malformed current-format
 * artifact, and it is refused as one, before physics.
 *
 * THE BOUND IS INCLUSIVE. Captures are indexed 0..maxSteps — `captureStep(0)`
 * runs post-realization and the loop then captures after every step through
 * `i <= maxSteps` — so a first crossing at exactly `executedSteps` is legal and
 * a `<` bound would reject a real, correctly-produced artifact.
 *
 * Each generation's STEP BOUND is checked against ITS OWN persisted metadata,
 * never the header's spec or generation 0's: `executedSteps` is a property of
 * one evaluation, they agree in every artifact this build produces, and
 * reading one to validate another would be an assumption the format does not
 * enforce.
 *
 * THE MEMBER COUNT is checked the same way — against the generation's own
 * population component, never the header's `populationSize`. A vector that
 * scores fewer members than its generation holds is well-formed by every
 * check above (its `count` is bound only to its own byte length), reaches
 * physics, and comes back as `replayDivergence` at stage 'fitnessVector' —
 * "the engine drifted" for a fault that is entirely in the file.
 *
 * This gate also raises whatever `collectFitnessVectorFacts` CAPTURED while
 * walking components — a malformed version prefix or an unreadable vector.
 * Those are discovered at stage 5 and belong on this rung, so they wait here
 * rather than preempting the chain, whole-history and identity checks.
 */
export function verifyFitnessVectorMetadataCoherence(verified) {
  const records = verified.records;
  for (let i = 0; i < records.length; i += 1) {
    const facts = records[i].fitnessVector;
    if (facts.failure !== null) throw facts.failure;
    const coherence = facts.coherence;
    if (coherence === null) continue;
    if (coherence.memberCount !== coherence.scoredPopulationCount) {
      evolutionFail('malformedHistory',
        `generation ${facts.generationIndex} fitness vector scores ${coherence.memberCount} `
        + `members, but the generation holds ${coherence.scoredPopulationCount} individuals`,
        {
          generationIndex: facts.generationIndex,
          memberCount: coherence.memberCount,
          populationCount: coherence.scoredPopulationCount,
        });
    }
    if (coherence.worst === null) continue;
    const { individualId, field, step } = coherence.worst;
    evolutionFail('malformedHistory',
      `generation ${facts.generationIndex} individual ${individualId} declares ${field} ${step}, `
      + `but that evaluation executed ${coherence.executedSteps} steps (captures are 0..${coherence.executedSteps})`,
      {
        generationIndex: facts.generationIndex,
        individualId,
        field,
        step,
        executedSteps: coherence.executedSteps,
      });
  }
}

/**
 * The header's duplicated versions and constants must agree with the ones this
 * build actually implements — otherwise a decoded artifact would be replayed
 * under semantics it was never produced under.
 *
 * NO DEFAULT IS EVER INJECTED. Everything compared here is explicit on the
 * wire, so an old artifact cannot silently acquire today's meaning by omission.
 */
function assertHeaderAgreesWithConstants(header) {
  const checks = [
    ['evolutionEngineVersion', header.evolutionEngineVersion, EVOLUTION_ENGINE_VERSION],
    ['evolutionPolicyVersion', header.evolutionPolicyVersion, EVOLUTION_POLICY_VERSION],
    ['generationRecordVersion', header.generationRecordVersion, GENERATION_RECORD_VERSION],
    ['lineageVersion', header.lineageVersion, EVOLUTION_LINEAGE_VERSION],
    ['evaluationMetadataVersion', header.evaluationMetadataVersion, EVALUATION_METADATA_VERSION],
    ['tournamentSelectionVersion', header.tournamentSelectionVersion, TOURNAMENT_SELECTION_VERSION],
    ['elitismVersion', header.elitismVersion, ELITISM_VERSION],
    ['parametricMutationVersion', header.parametricMutationVersion, PARAMETRIC_MUTATION_VERSION],
    ['tournamentSize', header.tournamentSize, TOURNAMENT_SIZE],
    ['eliteCount', header.eliteCount, ELITE_COUNT],
  ];
  for (let i = 0; i < checks.length; i += 1) {
    const [name, stored, current] = checks[i];
    if (stored !== current) {
      evolutionFail('unsupportedVersion',
        `history header ${name} is ${stored}; this build implements ${current}`,
        { field: name, stored, current });
    }
  }
  if (header.populationSize > MAX_EVOLUTION_POPULATION_SIZE) {
    evolutionFail('resourceLimitExceeded',
      `history populationSize ${header.populationSize} exceeds MAX_EVOLUTION_POPULATION_SIZE (${MAX_EVOLUTION_POPULATION_SIZE})`,
      { populationSize: header.populationSize, limit: MAX_EVOLUTION_POPULATION_SIZE });
  }
  if (header.maxGenerations > MAX_EVOLUTION_GENERATIONS) {
    evolutionFail('resourceLimitExceeded',
      `history maxGenerations ${header.maxGenerations} exceeds MAX_EVOLUTION_GENERATIONS (${MAX_EVOLUTION_GENERATIONS})`,
      { maxGenerations: header.maxGenerations, limit: MAX_EVOLUTION_GENERATIONS });
  }
}

/**
 * Stage 8 — the EXTERNAL freshness contract, and the only thing in this module
 * that can distinguish "stale" from "corrupt".
 *
 * The embedded digest proves framing and self-consistency. It proves NOTHING
 * about freshness: a perfectly valid older save verifies perfectly. A caller
 * that tracks the newest artifact out of band passes what it expects, and a
 * mismatch comes back as `staleOrWrongArtifact` — a different code from every
 * corruption class, because the remedy is different (find the right file, not
 * repair this one).
 */
export function checkExpectedIdentity(verified, expected) {
  if (expected.historyDigestBytes !== null) {
    if (!digestsEqual(expected.historyDigestBytes, verified.historyDigestBytes)) {
      evolutionFail('staleOrWrongArtifact',
        'the artifact is well-framed and self-consistent, but its history digest is not the expected one',
        { expectedByteLength: SHA256_DIGEST_BYTES });
    }
  }
  if (expected.generationIndex !== null) {
    if (expected.generationIndex !== verified.finalGenerationIndex) {
      evolutionFail('staleOrWrongArtifact',
        `the artifact's final committed generation is ${verified.finalGenerationIndex}, not the expected ${expected.generationIndex}`,
        { expected: expected.generationIndex, actual: verified.finalGenerationIndex });
    }
  }
}

/**
 * Stage 9 — the runtime gate, run BEFORE any physics.
 *
 * Deterministic replay compares bytes produced by a physics engine. If the
 * engine is not the one the artifact was produced by, the honest report is
 * "this environment cannot replay that artifact", not a byte divergence at
 * generation 0 that reads like data corruption. That distinction is the whole
 * reason runtime identity is in the header.
 */
export function checkRuntimeIdentity(header, runtime) {
  const fields = [
    ['physicsFlavor', header.physicsFlavor, runtime.physicsFlavor],
    ['packageName', header.packageName, runtime.packageName],
    ['rapierVersion', header.rapierVersion, runtime.rapierVersion],
  ];
  for (let i = 0; i < fields.length; i += 1) {
    const [name, stored, current] = fields[i];
    if (stored !== current) {
      evolutionFail('runtimeVersionMismatch',
        `history was produced by ${name} '${stored}'; this environment provides '${current}'`,
        { field: name, stored, current });
    }
  }
  if (header.physicsFlavor !== 'deterministicCompat') {
    evolutionFail('runtimeVersionMismatch',
      `history names physics flavor '${header.physicsFlavor}'; evolution requires 'deterministicCompat'`,
      { field: 'physicsFlavor', stored: header.physicsFlavor });
  }
}

/**
 * Capture the optional external-identity inputs. Called in the resume seam's
 * SYNCHRONOUS prologue: expected bytes are copied before the first `await`,
 * exactly like the artifact itself, so a caller cannot change what it claimed
 * to expect while verification is in flight.
 */
export function captureExpectedIdentity(options, copy) {
  if (options === undefined || options === null) return { historyDigestBytes: null, generationIndex: null };
  if (typeof options !== 'object' || Array.isArray(options)) {
    evolutionFail('invalidConfig', 'resume options must be a plain object', {});
  }
  const proto = Object.getPrototypeOf(options);
  if (proto !== Object.prototype && proto !== null) {
    evolutionFail('invalidConfig', 'resume options must be a plain object', {});
  }
  const keys = Object.keys(options);
  if (Object.getOwnPropertyNames(options).length !== keys.length) {
    evolutionFail('invalidConfig', 'resume options carry non-enumerable own properties', {});
  }
  const declared = ['expectedHistoryDigestBytes', 'expectedGenerationIndex'];
  for (let i = 0; i < keys.length; i += 1) {
    if (!declared.includes(keys[i])) {
      evolutionFail('invalidConfig', `resume option '${keys[i]}' is not a known key`, { key: keys[i] });
    }
  }
  const rawDigest = options.expectedHistoryDigestBytes; // ONE read each
  const rawIndex = options.expectedGenerationIndex;
  let historyDigestBytes = null;
  if (rawDigest !== undefined) {
    historyDigestBytes = copy(rawDigest);
    if (typedArrayByteLength(historyDigestBytes) !== SHA256_DIGEST_BYTES) {
      evolutionFail('invalidConfig',
        `expectedHistoryDigestBytes must be exactly ${SHA256_DIGEST_BYTES} bytes`,
        { byteLength: typedArrayByteLength(historyDigestBytes) });
    }
  }
  let generationIndex = null;
  if (rawIndex !== undefined) {
    if (!isEvolutionUint32(rawIndex)) {
      evolutionFail('invalidConfig', `expectedGenerationIndex must be a canonical uint32 (${String(rawIndex)})`, {});
    }
    generationIndex = rawIndex;
  }
  return { historyDigestBytes, generationIndex };
}
