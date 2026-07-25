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
//   9. nested format compatibility                 (unsupported format:
//      the fitness-vector versions and the evaluation-metadata version,
//      each read through its OWN module's layered peek)
//  10. fitness-vector metadata coherence           (malformed current format)
//  11. deterministic flavor + exact Rapier version (before physics)
//  12. deterministic replay, stopping at the first byte divergence
//
// Stages 1-2 belong to the caller's intake seam (evolution-run's resume
// prologue, which must copy before it awaits); 3-7 are `verifyHistoryArtifact`;
// 8-11 are the small checks below; 12 is the run's own replay loop. The two
// fitness-vector gates (9-10) sit BETWEEN external identity and the runtime
// gate, so the escalation ladder reads: corruption -> wrong artifact ->
// unsupported format -> malformed current format -> runtime mismatch ->
// deterministic divergence. Their INPUTS are collected while walking the
// components at stage 5 (per-generation version fields and coherence
// verdicts — scalars and at most one failure descriptor per gate, never rows
// — so the memory model below holds unchanged); the RAISE happens after
// stage 8, never mid-walk, so a corruption or staleness verdict is never
// masked by a format one.
//
// MEMORY MODEL, and why verification does NOT return decoded payloads.
// `decodeGenerationPayload` copies the four component byte arrays, so decoding
// every generation up front would hold a second full copy of the artifact.
// Verification therefore decodes one payload at a time, verifies its four
// component digests, and DISCARDS it, returning only scalars plus the framing
// (whose views alias the caller's already-owned buffer). Replay decodes each
// payload again, on demand, one at a time. That is two decodes of each payload
// in exchange for a retention bound of: the artifact, ONE decoded payload, and
// the current/next working populations — which is the documented peak. The
// stage-5 gate collection adds two TRANSIENT decodes (the fitness vector and
// its sibling metadata, only when the vector's versions are current) inside
// the same one-payload window; what is retained is per-gate scalars or a
// single first-failure descriptor, so the bound above is unchanged.

import { typedArrayByteLength } from './bytes.js';
import {
  SHA256_DIGEST_BYTES, COMPONENT_KINDS, EVALUATION_METADATA_VERSION,
  GENERATION_RECORD_VERSION,
  decodeEvolutionHeader, decodeGenerationPayload, decodeHistoryFraming,
  deserializeEvaluationMetadata, peekEvaluationMetadataVersion,
  digestComponent, digestGeneration, digestHeader, digestHistoryBody, digestsEqual,
} from './evolution-history.js';
import {
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, MAX_EVOLUTION_GENERATIONS,
  MAX_EVOLUTION_POPULATION_SIZE, evolutionFail, isEvolutionUint32,
} from './evolution-contract.js';
import { EVOLUTION_LINEAGE_VERSION } from './evolution-lineage.js';
import {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE,
} from './evolution-operators.js';
import {
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION, FITNESS_VECTOR_VERSION,
  deserializeFitnessVector, peekFitnessVectorVersions,
} from './population-evaluation.js';
import { POPULATION_SNAPSHOT_VERSION } from './population.js';
import {
  INTEGRITY_POLICY_VERSION, INTEGRITY_REFERENCE_CAPTURE_DT, INTEGRITY_THRESHOLDS,
} from './integrity.js';

/** The replay stages, in the order a record's components are compared. */
export const REPLAY_STAGES = Object.freeze([
  'initialization', 'population', 'evaluationMetadata', 'fitnessVector',
  'terminalReason', 'lineage',
]);

/** Human-readable labels for the two nested components the gates read. */
const COMPONENT_LABELS = Object.freeze({
  fitnessVector: 'fitness vector',
  evaluationMetadata: 'evaluation metadata',
});

/** The 64 MiB intake ceiling, checked before the first copy. Re-exported so the
 * resume seam and this module cannot disagree about the number. */
export { MAX_EVOLUTION_HISTORY_BYTES } from './evolution-history.js';

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
  // The stages 9-10 gate inputs, collected inside the same walk: the FIRST
  // failure descriptor per gate, or null when every generation passes.
  let fitnessVectorCompatibilityFailure = null;
  let fitnessVectorCoherenceFailure = null;
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
    // GATE COLLECTION (stages 9-10's inputs). Nothing raises here: the gates
    // fire after stage 8, so a corruption (stages 3-7) or staleness (stage 8)
    // verdict is never masked by a format one — and the walk continues, so
    // every component digest still verifies.
    if (fitnessVectorCompatibilityFailure === null || fitnessVectorCoherenceFailure === null) {
      const gates = collectFitnessVectorGateInputs(payload.components, i);
      if (fitnessVectorCompatibilityFailure === null) fitnessVectorCompatibilityFailure = gates.compatibility;
      if (fitnessVectorCoherenceFailure === null) fitnessVectorCoherenceFailure = gates.coherence;
    }
    records.push(Object.freeze({
      generationIndex: i, terminalReason: payload.terminalReason,
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
    // The stages 9-10 gate inputs: the FIRST failure descriptor per gate, or
    // null when every generation passed. Raised by the two checks below,
    // after external identity — never mid-walk.
    fitnessVectorCompatibilityFailure,
    fitnessVectorCoherenceFailure,
  });
}

/**
 * Stage 5's gate collection, per generation: peek BOTH nested components'
 * declared versions (Gate A's inputs) and — ONLY when every one is current —
 * decode the vector and its sibling metadata TRANSIENTLY to evaluate
 * observation coherence (Gate B's input). Returns
 * `{ compatibility, coherence }`: the first failure descriptor for each gate,
 * or null. Decoded rows are discarded in place; the descriptors carry scalars
 * (plus the thrown cause on the malformed paths), honouring the memory model.
 *
 * OWNERSHIP, stated because two formats meet here: the fitness vector's
 * versions are read through population-evaluation.js's own layered peek, and
 * the evaluation metadata's version through evolution-history.js's — each
 * nested component retains ownership of its version interpretation, and no
 * format offset is duplicated into this module. The vector's peek is
 * evaluated first (it is this gate's primary subject); a stale nested version
 * of EITHER kind reports `unsupportedVersion`, while a prefix too short to
 * reveal its version reports `malformedHistory` — the same classification for
 * both components.
 */
function collectFitnessVectorGateInputs(components, generationIndex) {
  let compatibility = null;
  let peeked = null;
  try {
    peeked = peekFitnessVectorVersions(components.fitnessVector);
  } catch (cause) {
    // A truncated or structurally unreadable prefix is malformed, not
    // unsupported — the layered peek never got far enough to name a version.
    compatibility = Object.freeze({
      generationIndex, component: 'fitnessVector', unreadablePrefix: true, cause,
    });
  }
  if (compatibility === null && peeked.fitnessVectorVersion !== FITNESS_VECTOR_VERSION) {
    // The layered peek stopped at byte 2: the version field is the only thing
    // readable without assuming the unknown layout that follows.
    compatibility = Object.freeze({
      generationIndex,
      component: 'fitnessVector',
      field: 'fitnessVectorVersion',
      stored: peeked.fitnessVectorVersion,
      current: FITNESS_VECTOR_VERSION,
    });
  }
  if (compatibility === null) {
    // The vector version is current, so the remaining four declared offsets
    // are meaningful — compare them in declared order and name the first
    // disagreement exactly.
    const remaining = [
      ['fitnessPolicyVersion', FITNESS_POLICY_VERSION],
      ['integrityPolicyVersion', INTEGRITY_POLICY_VERSION],
      ['snapshotVersion', POPULATION_SNAPSHOT_VERSION],
      ['evaluationSpecVersion', EVALUATION_SPEC_VERSION],
    ];
    for (let f = 0; f < remaining.length; f += 1) {
      const [field, current] = remaining[f];
      if (peeked[field] !== current) {
        compatibility = Object.freeze({
          generationIndex, component: 'fitnessVector', field, stored: peeked[field], current,
        });
        break;
      }
    }
  }
  if (compatibility === null) {
    // The evaluation metadata component owns its OWN nested version: read it
    // through evolution-history.js's layered peek, with the same
    // unsupported-vs-malformed classification as the vector's.
    let peekedMetadata = null;
    try {
      peekedMetadata = peekEvaluationMetadataVersion(components.evaluationMetadata);
    } catch (cause) {
      compatibility = Object.freeze({
        generationIndex, component: 'evaluationMetadata', unreadablePrefix: true, cause,
      });
    }
    if (compatibility === null && peekedMetadata.evaluationMetadataVersion !== EVALUATION_METADATA_VERSION) {
      compatibility = Object.freeze({
        generationIndex,
        component: 'evaluationMetadata',
        field: 'evaluationMetadataVersion',
        stored: peekedMetadata.evaluationMetadataVersion,
        current: EVALUATION_METADATA_VERSION,
      });
    }
  }
  let coherence = null;
  if (compatibility === null) {
    // Gate B reads the vector against its OWN generation's persisted metadata
    // (executedSteps and effectiveDt). A decode failure here is malformed
    // current format — recorded with the failing component named, not raised,
    // so the ladder holds.
    let metadata = null;
    let vector = null;
    try {
      metadata = deserializeEvaluationMetadata(components.evaluationMetadata);
    } catch (cause) {
      coherence = Object.freeze({
        generationIndex, component: 'evaluationMetadata', undecodable: true, cause,
      });
    }
    if (coherence === null) {
      try {
        vector = deserializeFitnessVector(components.fitnessVector);
      } catch (cause) {
        coherence = Object.freeze({
          generationIndex, component: 'fitnessVector', undecodable: true, cause,
        });
      }
    }
    if (coherence === null) {
      coherence = fitnessVectorCoherenceVerdict(vector, metadata, generationIndex);
    }
  }
  return { compatibility, coherence };
}

/**
 * Gate B's per-generation verdict, or null when the vector agrees with its
 * own metadata. The policy-v1 coherence rules, evaluated per member in
 * declaration order:
 *
 *   - an onset step must lie inside the executed captures (0..executedSteps —
 *   captures are 0..maxSteps inclusive and executedSteps IS maxSteps, so a
 *   first crossing at exactly executedSteps is legal);
 *   - the peak<->alert equivalence: the online detector records a first alert
 *   step IFF some capture crossed an alert threshold, and the whole-run peaks
 *   saw every sample — so "an alert step is present" and "a peak exceeds its
 *   applied alert threshold" must agree exactly;
 *   - the peak<->catastrophic equivalence, the SAME producer contract one band
 *   up: a catastrophic step is recorded IFF either catastrophic arm crossed —
 *   peakBodySpeed over the ABSOLUTE catastrophic speed, or
 *   peakStepDisplacement over the scaled catastrophic step displacement
 *   (there is deliberately NO catastrophic speed-delta arm: the producer has
 *   none). So "a catastrophic step is present" and "a catastrophic arm
 *   crossed" must agree exactly.
 *
 * The applied thresholds are recomputed with the SAME arithmetic the producer
 * used (createIntegrityState: dtScale first — this generation's OWN persisted
 * effectiveDt divided by INTEGRITY_REFERENCE_CAPTURE_DT — then the multiply,
 * strict `>` throughout, so a value exactly at a threshold does not cross and
 * +Infinity does). Bit-identical by construction, never an approximation, and
 * never a global or current-runtime timestep. Gate A has already established
 * the current versions — this verdict therefore runs under integrity policy
 * v1 semantics by construction.
 */
function fitnessVectorCoherenceVerdict(vector, metadata, generationIndex) {
  const dtScale = metadata.effectiveDt / INTEGRITY_REFERENCE_CAPTURE_DT;
  const alertSpeed = INTEGRITY_THRESHOLDS.alertSpeed; // absolute — never scaled
  const alertSpeedDelta = INTEGRITY_THRESHOLDS.alertSpeedDelta * dtScale;
  const alertStepDisplacement = INTEGRITY_THRESHOLDS.alertStepDisplacement * dtScale;
  const catastrophicSpeed = INTEGRITY_THRESHOLDS.catastrophicSpeed; // absolute — never scaled
  const catastrophicStepDisplacement = INTEGRITY_THRESHOLDS.catastrophicStepDisplacement * dtScale;
  const executedSteps = metadata.executedSteps;
  const rows = vector.individuals;
  const rowCount = rows.length;
  for (let m = 0; m < rowCount; m += 1) {
    const observations = rows[m].integrityObservations;
    const individualId = rows[m].individualId;
    if (observations.firstAlertStep !== null && observations.firstAlertStep > executedSteps) {
      return Object.freeze({
        generationIndex, individualId, rule: 'stepBeyondExecutedSteps', stepField: 'firstAlertStep', stored: observations.firstAlertStep, executedSteps,
      });
    }
    if (observations.firstCatastrophicStep !== null && observations.firstCatastrophicStep > executedSteps) {
      return Object.freeze({
        generationIndex, individualId, rule: 'stepBeyondExecutedSteps', stepField: 'firstCatastrophicStep', stored: observations.firstCatastrophicStep, executedSteps,
      });
    }
    const alertImplied = observations.peakBodySpeed > alertSpeed
      || observations.peakSpeedDelta > alertSpeedDelta
      || observations.peakStepDisplacement > alertStepDisplacement;
    if ((observations.firstAlertStep !== null) !== alertImplied) {
      return Object.freeze({
        generationIndex, individualId, rule: 'peakAlertEquivalence', firstAlertStep: observations.firstAlertStep, alertImplied,
      });
    }
    const catastrophicImplied = observations.peakBodySpeed > catastrophicSpeed
      || observations.peakStepDisplacement > catastrophicStepDisplacement;
    if ((observations.firstCatastrophicStep !== null) !== catastrophicImplied) {
      return Object.freeze({
        generationIndex, individualId, rule: 'peakCatastrophicEquivalence', firstCatastrophicStep: observations.firstCatastrophicStep, catastrophicImplied,
      });
    }
  }
  return null;
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
 * Stage 9 — fitness-vector format compatibility, raised from the stage-5
 * collection AFTER external identity and before the runtime gate. A stale v2
 * artifact reports `unsupportedVersion` naming the exact field, the
 * generation that carries it, and the stored and current values — never a
 * false replay drift discovered after a re-simulation. A truncated or
 * structurally unreadable version prefix reports `malformedHistory` instead:
 * without a readable prefix there is no version to call unsupported.
 */
export function checkFitnessVectorCompatibility(verified) {
  const failure = verified.fitnessVectorCompatibilityFailure;
  if (failure === null) return;
  const componentLabel = COMPONENT_LABELS[failure.component];
  if (failure.unreadablePrefix === true) {
    evolutionFail('malformedHistory',
      `generation ${failure.generationIndex} ${componentLabel} has a truncated or unreadable version prefix`,
      { generationIndex: failure.generationIndex },
      failure.cause);
  }
  evolutionFail('unsupportedVersion',
    `generation ${failure.generationIndex} ${componentLabel} ${failure.field} is ${failure.stored}; this build implements ${failure.current}`,
    {
      field: failure.field,
      generationIndex: failure.generationIndex,
      stored: failure.stored,
      current: failure.current,
    });
}

/**
 * Stage 10 — fitness-vector metadata coherence (`malformedHistory`). A
 * CURRENT-format artifact whose observations contradict its own per-
 * generation metadata is malformed, not unsupported: onset steps must lie
 * inside the executed captures, and a recorded first alert step must agree
 * with the whole-run peaks under that generation's own effectiveDt. Without
 * this gate, an artifact declaring `executedSteps: 45` and
 * `firstAlertStep: 4_000_000_000` passed every digest, version and runtime
 * check and then surfaced as `replayDivergence` after a full generation-0
 * re-simulation — the exact misleading class this stage exists to remove.
 */
export function verifyFitnessVectorMetadataCoherence(verified) {
  const failure = verified.fitnessVectorCoherenceFailure;
  if (failure === null) return;
  if (failure.undecodable === true) {
    evolutionFail('malformedHistory',
      `generation ${failure.generationIndex} ${COMPONENT_LABELS[failure.component]} is malformed`,
      { generationIndex: failure.generationIndex },
      failure.cause);
  }
  if (failure.rule === 'peakAlertEquivalence') {
    evolutionFail('malformedHistory',
      `generation ${failure.generationIndex} individual ${failure.individualId} contradicts its own observations: `
      + `firstAlertStep is ${String(failure.firstAlertStep)} but the whole-run peaks `
      + `${failure.alertImplied ? 'cross' : 'never cross'} the alert thresholds under this generation's effectiveDt`,
      {
        generationIndex: failure.generationIndex,
        individualId: failure.individualId,
        rule: failure.rule,
        firstAlertStep: failure.firstAlertStep,
        alertImplied: failure.alertImplied,
      });
  }
  if (failure.rule === 'peakCatastrophicEquivalence') {
    evolutionFail('malformedHistory',
      `generation ${failure.generationIndex} individual ${failure.individualId} contradicts its own observations: `
      + `firstCatastrophicStep is ${String(failure.firstCatastrophicStep)} but the whole-run peaks `
      + `${failure.catastrophicImplied ? 'cross' : 'never cross'} the catastrophic thresholds under this generation's effectiveDt`,
      {
        generationIndex: failure.generationIndex,
        individualId: failure.individualId,
        rule: failure.rule,
        firstCatastrophicStep: failure.firstCatastrophicStep,
        catastrophicImplied: failure.catastrophicImplied,
      });
  }
  evolutionFail('malformedHistory',
    `generation ${failure.generationIndex} individual ${failure.individualId} ${failure.stepField} ${failure.stored} exceeds executedSteps ${failure.executedSteps} (captures run 0..executedSteps)`,
    {
      generationIndex: failure.generationIndex,
      individualId: failure.individualId,
      rule: failure.rule,
      field: failure.stepField,
      stored: failure.stored,
      executedSteps: failure.executedSteps,
    });
}

/**
 * Stage 11 — the runtime gate, run BEFORE any physics.
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
