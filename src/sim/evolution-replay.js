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
//   9. nested format compatibility                 (unsupported format, raised
//      FIRST GLOBALLY: the fitness-vector versions and the evaluation-metadata
//      version, each peeked independently through its OWN module's layered
//      peek — a malformed prefix anywhere never masks a stale version)
//  10. fitness-vector metadata coherence           (malformed current format)
//  11. current-artifact semantics + bindings          (malformed current format)
//  12. deterministic flavor + exact Rapier version    (before physics)
//  13. deterministic replay, stopping at the first byte divergence
//
// Stages 1-2 belong to the caller's intake seam (evolution-run's resume
// prologue, which must copy before it awaits); 3-7 are `verifyHistoryArtifact`;
// 8-12 are the small checks below; 13 is the run's own replay loop. The
// current-format gates (9-11) sit BETWEEN external identity and the runtime
// gate, so the escalation ladder reads: corruption -> wrong artifact ->
// unsupported format -> malformed current format -> runtime mismatch ->
// deterministic divergence. Gates 9-10 collect their INPUTS while walking the
// components at stage 5. Vector geometry is first bound to the capped header
// population; rows are decoded only transiently, while the retained inputs are
// per-generation scalars and at most one failure descriptor per gate. Gate 11
// then walks one payload at a time after stage 8, retaining validated rows only
// when offline extraction requests them, and closes by recreating generation 0
// from the manifest config: exact byte identity with the persisted population is
// the provenance verdict, the FNV state only its prefilter. Every format verdict
// therefore RAISES after stage 8, so corruption or staleness is never masked.
//
// MEMORY MODEL, and why verification does NOT return decoded payloads.
// `decodeGenerationPayload` copies the four component byte arrays, so decoding
// every generation up front would hold a second full copy of the artifact.
// Verification therefore decodes one payload at a time, verifies its four
// component digests, and DISCARDS it, returning only scalars plus the framing
// (whose views alias the caller's already-owned buffer). Stage 11 and replay
// each decode one payload again, on demand. Those extra passes exchange decode
// work for a resume retention bound of: the artifact, ONE decoded payload, and
// the current/next working populations — which is the documented peak. Offline
// extraction deliberately retains its result rows from stage 11 and does not
// decode them a fourth time. Stage 11's generation-0 recreation adds no
// retention class: it is the same `createInitialPopulation` call resume used
// to run after the runtime gate, moved before it, and resume replays from the
// returned recreation — the current working population the bound already
// counts. The
// stage-5 gate collection adds two TRANSIENT decodes (the fitness vector and
// its sibling metadata, only when BOTH components' versions are current)
// inside the same one-payload window; what is retained is one first-failure
// descriptor of each kind per gate, so the bound above is unchanged.

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
  MAX_EVOLUTION_POPULATION_SIZE, assertEvaluationWork, evolutionFail,
  isEvolutionUint32,
} from './evolution-contract.js';
import { EVOLUTION_LINEAGE_VERSION } from './evolution-lineage.js';
import {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE,
} from './evolution-operators.js';
import {
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION, FITNESS_VECTOR_VERSION,
  canonicalizeEvaluationSpec, deserializeEvaluationSpec, deserializeFitnessVector,
  fitnessVectorByteLength, peekFitnessVectorVersions,
} from './population-evaluation.js';
import {
  POPULATION_SNAPSHOT_VERSION, deserializePopulationSnapshot, peekPopulationSnapshotMemberCount,
  serializePopulationSnapshot,
} from './population.js';
import {
  createInitialPopulation, deserializePopulationInitialization,
} from './population-initializer.js';
import {
  INTEGRITY_POLICY_VERSION, INTEGRITY_REFERENCE_CAPTURE_DT, INTEGRITY_THRESHOLDS,
} from './integrity.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from './fnv1a.js';

/** The replay stages, in the order a record's components are compared. */
export const REPLAY_STAGES = Object.freeze([
  'initialization', 'population', 'evaluationMetadata', 'fitnessVector',
  'terminalReason', 'lineage',
]);

/** Human-readable labels for the two nested components the gates read. */
const COMPONENT_LABELS = Object.freeze({
  population: 'population snapshot',
  fitnessVector: 'fitness vector',
  evaluationMetadata: 'evaluation metadata',
});

/** The 64 MiB intake ceiling, checked before the first copy. Re-exported so the
 * resume seam and this module cannot disagree about the number. */
export { MAX_EVOLUTION_HISTORY_BYTES } from './evolution-history.js';

/**
 * The first index at which two byte arrays differ, or -1 when they are
 * byte-identical, lengths included. Two call styles: replay localization uses
 * it for DIAGNOSTICS after a mismatch is already established by the caller's
 * length or digest comparison; the stage-11 initialization-provenance bind
 * uses the -1 result AS the byte-identity verdict.
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
  // failure descriptor of EACH kind, or null. Unsupported-format and
  // malformed-format failures are tracked SEPARATELY (a malformed prefix in
  // one generation must never mask a stale version in another — the ladder
  // raises unsupported format first, globally).
  let nestedFormatUnsupportedFailure = null;
  let nestedFormatMalformedFailure = null;
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
    if (nestedFormatUnsupportedFailure === null
      || nestedFormatMalformedFailure === null
      || fitnessVectorCoherenceFailure === null) {
      const gates = collectFitnessVectorGateInputs(payload.components, i, header.populationSize);
      if (nestedFormatUnsupportedFailure === null) nestedFormatUnsupportedFailure = gates.unsupported;
      if (nestedFormatMalformedFailure === null) nestedFormatMalformedFailure = gates.malformedPrefix;
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
    // The stages 9-10 gate inputs: the FIRST failure descriptor of each kind,
    // or null. Raised by the two checks below, after external identity —
    // never mid-walk: the unsupported-format failure first (globally), then
    // the malformed-prefix failure, then the coherence failure.
    nestedFormatUnsupportedFailure,
    nestedFormatMalformedFailure,
    fitnessVectorCoherenceFailure,
  });
}

/**
 * Stage 5's gate collection, per generation: peek BOTH nested components'
 * declared versions INDEPENDENTLY (Gate A's inputs) and — ONLY when both are
 * current-format — require the vector's fixed geometry not to exceed the capped
 * header population before decoding it, then decode the vector and its sibling
 * metadata TRANSIENTLY to evaluate observation coherence (Gate B's input).
 * Returns
 * `{ unsupported, malformedPrefix, coherence }`: the generation's failure
 * descriptor of each kind, or null. Decoded rows are discarded in place; the
 * descriptors carry scalars (plus the thrown cause on the malformed paths),
 * honouring the memory model.
 *
 * INDEPENDENCE, and why it is the point: a malformed unreadable prefix in one
 * component must NEVER stop the sibling's version from being read, and a
 * malformed prefix in one GENERATION must never mask a stale version in
 * another. Unsupported-format failures (a readable but stale version) and
 * malformed-format failures (a prefix too short to reveal one) are therefore
 * collected separately for both components of every generation, and the gate
 * raises unsupported format FIRST, globally — the ladder's "unsupported
 * format → malformed current format" precedence holds across generations and
 * components, not merely within one descriptor slot.
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
function collectFitnessVectorGateInputs(components, generationIndex, populationSize) {
  let unsupported = null;
  let malformedPrefix = null;
  let peeked = null;
  try {
    peeked = peekFitnessVectorVersions(components.fitnessVector);
  } catch (cause) {
    // A truncated or structurally unreadable prefix is malformed, not
    // unsupported — the layered peek never got far enough to name a version.
    malformedPrefix = Object.freeze({
      generationIndex, component: 'fitnessVector', cause,
    });
  }
  if (malformedPrefix === null && peeked.fitnessVectorVersion !== FITNESS_VECTOR_VERSION) {
    // The layered peek stopped at byte 2: the version field is the only thing
    // readable without assuming the unknown layout that follows.
    unsupported = Object.freeze({
      generationIndex,
      component: 'fitnessVector',
      field: 'fitnessVectorVersion',
      stored: peeked.fitnessVectorVersion,
      current: FITNESS_VECTOR_VERSION,
    });
  }
  if (unsupported === null && malformedPrefix === null) {
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
        unsupported = Object.freeze({
          generationIndex, component: 'fitnessVector', field, stored: peeked[field], current,
        });
        break;
      }
    }
  }
  // The evaluation metadata component owns its OWN nested version, peeked
  // INDEPENDENTLY of whatever the vector produced: read it through
  // evolution-history.js's layered peek, with the same unsupported-vs-
  // malformed classification as the vector's.
  let peekedMetadata = null;
  try {
    peekedMetadata = peekEvaluationMetadataVersion(components.evaluationMetadata);
  } catch (cause) {
    if (malformedPrefix === null) {
      malformedPrefix = Object.freeze({
        generationIndex, component: 'evaluationMetadata', cause,
      });
    }
  }
  if (peekedMetadata !== null
    && peekedMetadata.evaluationMetadataVersion !== EVALUATION_METADATA_VERSION
    && unsupported === null) {
    unsupported = Object.freeze({
      generationIndex,
      component: 'evaluationMetadata',
      field: 'evaluationMetadataVersion',
      stored: peekedMetadata.evaluationMetadataVersion,
      current: EVALUATION_METADATA_VERSION,
    });
  }
  let coherence = null;
  if (unsupported === null && malformedPrefix === null) {
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
      const actualByteLength = typedArrayByteLength(components.fitnessVector);
      const expectedByteLength = fitnessVectorByteLength(populationSize);
      if (actualByteLength > expectedByteLength) {
        coherence = Object.freeze({
          generationIndex,
          component: 'fitnessVector',
          rule: 'fitnessVectorPopulationSizeOverflow',
          populationSize,
          actualByteLength,
          expectedByteLength,
        });
      }
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
  return { unsupported, malformedPrefix, coherence };
}

/**
 * Gate B's per-generation verdict, or null when the vector agrees with its
 * own metadata. The policy-v1 coherence rules, evaluated per member in
 * declaration order:
 *
 *   - an onset step must lie inside the executed captures (0..executedSteps —
 *   captures are 0..maxSteps inclusive and executedSteps IS maxSteps, so a
 *   first crossing at exactly executedSteps is legal);
 *   - an onset at capture 0 requires the matching body-speed arm to have
 *   crossed: the producer has no previous sample yet, so speed delta and step
 *   displacement cannot trigger either band there. This is a necessary
 *   condition only: the persisted body-speed peak spans the whole run, so it
 *   cannot attest that the crossing itself happened at capture 0;
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
 * never a global or current-runtime timestep. The rules are dispatched on the
 * vector's DECLARED integrityPolicyVersion EXPLICITLY (the codec's
 * conditioning, mirrored): the decoder has already required it current, so
 * the branch covers exactly policy v1 today — and a future policy bump can
 * never silently inherit v1 semantics here.
 */
function fitnessVectorCoherenceVerdict(vector, metadata, generationIndex) {
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
  }
  switch (vector.integrityPolicyVersion) {
    case 1:
      break;
    default:
      // The decoder has already required the build's current policy version.
      // Returning a named failure lets the public gates raise AFTER freshness,
      // while making a future constant bump fail loudly until its coherence
      // semantics are implemented here.
      return Object.freeze({
        generationIndex,
        rule: 'integrityPolicyCoherenceNotImplemented',
        integrityPolicyVersion: vector.integrityPolicyVersion,
      });
  }
  const dtScale = metadata.effectiveDt / INTEGRITY_REFERENCE_CAPTURE_DT;
  const alertSpeed = INTEGRITY_THRESHOLDS.alertSpeed; // absolute — never scaled
  const alertSpeedDelta = INTEGRITY_THRESHOLDS.alertSpeedDelta * dtScale;
  const alertStepDisplacement = INTEGRITY_THRESHOLDS.alertStepDisplacement * dtScale;
  const catastrophicSpeed = INTEGRITY_THRESHOLDS.catastrophicSpeed; // absolute — never scaled
  const catastrophicStepDisplacement = INTEGRITY_THRESHOLDS.catastrophicStepDisplacement * dtScale;
  for (let m = 0; m < rowCount; m += 1) {
    const observations = rows[m].integrityObservations;
    const individualId = rows[m].individualId;
    if (observations.firstAlertStep === 0 && !(observations.peakBodySpeed > alertSpeed)) {
      return Object.freeze({
        generationIndex,
        individualId,
        rule: 'captureZeroAlertCause',
        firstAlertStep: observations.firstAlertStep,
        peakBodySpeed: observations.peakBodySpeed,
        alertSpeed,
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
    if (observations.firstCatastrophicStep === 0
      && !(observations.peakBodySpeed > catastrophicSpeed)) {
      return Object.freeze({
        generationIndex,
        individualId,
        rule: 'captureZeroCatastrophicCause',
        firstCatastrophicStep: observations.firstCatastrophicStep,
        peakBodySpeed: observations.peakBodySpeed,
        catastrophicSpeed,
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
 * Stage 9 — nested format compatibility, raised from the stage-5 collection
 * AFTER external identity and before the runtime gate. Precedence is GLOBAL,
 * across every generation and both nested components: the first
 * unsupported-format failure reports `unsupportedVersion` naming the exact
 * component and field, the generation, and the stored and current values —
 * never a false replay drift discovered after a re-simulation, and never
 * masked by a malformed prefix anywhere else in the artifact. Only when no
 * generation carries an unsupported version does the first malformed nested
 * prefix report `malformedHistory`: without a readable prefix there is no
 * version to call unsupported.
 */
export function checkFitnessVectorCompatibility(verified) {
  const unsupported = verified.nestedFormatUnsupportedFailure;
  if (unsupported !== null) {
    const componentLabel = COMPONENT_LABELS[unsupported.component];
    evolutionFail('unsupportedVersion',
      `generation ${unsupported.generationIndex} ${componentLabel} ${unsupported.field} is ${unsupported.stored}; this build implements ${unsupported.current}`,
      {
        field: unsupported.field,
        generationIndex: unsupported.generationIndex,
        stored: unsupported.stored,
        current: unsupported.current,
      });
  }
  const malformedPrefix = verified.nestedFormatMalformedFailure;
  if (malformedPrefix !== null) {
    evolutionFail('malformedHistory',
      `generation ${malformedPrefix.generationIndex} ${COMPONENT_LABELS[malformedPrefix.component]} has a truncated or unreadable version prefix`,
      { generationIndex: malformedPrefix.generationIndex },
      malformedPrefix.cause);
  }
}

/**
 * Stage 10 — fitness-vector metadata coherence (`malformedHistory`). A
 * CURRENT-format artifact whose observations contradict its own per-
 * generation metadata is malformed, not unsupported: onset steps must lie
 * inside the executed captures; capture-zero onsets require a body-speed
 * crossing because no delta or displacement exists at that capture; and
 * recorded onset steps must agree with the whole-run peaks under that
 * generation's own effectiveDt. The vector's fixed byte geometry must also
 * not exceed the capped header population before any member rows are
 * materialized. Without this gate, an artifact declaring
 * `executedSteps: 45` and
 * `firstAlertStep: 4_000_000_000` passed every digest, version and runtime
 * check and then surfaced as `replayDivergence` after a full generation-0
 * re-simulation — the exact misleading class this stage exists to remove.
 */
export function verifyFitnessVectorMetadataCoherence(verified) {
  const failure = verified.fitnessVectorCoherenceFailure;
  if (failure === null) return;
  if (failure.rule === 'integrityPolicyCoherenceNotImplemented') {
    throw new Error(
      `evolution-replay: missing fitness-vector coherence implementation for current integrity policy ${failure.integrityPolicyVersion}`,
    );
  }
  if (failure.undecodable === true) {
    evolutionFail('malformedHistory',
      `generation ${failure.generationIndex} ${COMPONENT_LABELS[failure.component]} is malformed`,
      { generationIndex: failure.generationIndex },
      failure.cause);
  }
  if (failure.rule === 'fitnessVectorPopulationSizeOverflow') {
    evolutionFail('malformedHistory',
      `generation ${failure.generationIndex} fitness vector byteLength ${failure.actualByteLength} `
      + `exceeds header populationSize ${failure.populationSize} allocation bound `
      + `(${failure.expectedByteLength} bytes)`,
      {
        generationIndex: failure.generationIndex,
        rule: failure.rule,
        populationSize: failure.populationSize,
        actualByteLength: failure.actualByteLength,
        expectedByteLength: failure.expectedByteLength,
      });
  }
  if (failure.rule === 'captureZeroAlertCause') {
    evolutionFail('malformedHistory',
      `generation ${failure.generationIndex} individual ${failure.individualId} contradicts its own observations: `
      + `an alert onset at capture 0 requires a body-speed crossing, but peakBodySpeed ${failure.peakBodySpeed} `
      + `does not exceed alertSpeed ${failure.alertSpeed}`,
      {
        generationIndex: failure.generationIndex,
        individualId: failure.individualId,
        rule: failure.rule,
        firstAlertStep: failure.firstAlertStep,
        peakBodySpeed: failure.peakBodySpeed,
        alertSpeed: failure.alertSpeed,
      });
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
  if (failure.rule === 'captureZeroCatastrophicCause') {
    evolutionFail('malformedHistory',
      `generation ${failure.generationIndex} individual ${failure.individualId} contradicts its own observations: `
      + `a catastrophic onset at capture 0 requires a body-speed crossing, but peakBodySpeed ${failure.peakBodySpeed} `
      + `does not exceed catastrophicSpeed ${failure.catastrophicSpeed}`,
      {
        generationIndex: failure.generationIndex,
        individualId: failure.individualId,
        rule: failure.rule,
        firstCatastrophicStep: failure.firstCatastrophicStep,
        peakBodySpeed: failure.peakBodySpeed,
        catastrophicSpeed: failure.catastrophicSpeed,
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
 * Stage 11 — shared current-artifact semantics and bindings. Decode the header
 * evaluation spec and initialization manifest; require an executable,
 * deterministic spec and the header/manifest population agreement; bind every
 * fitness vector to its sibling population and the header spec with the
 * persisted FNV states, counts, ordered ids, and metadata executedSteps; then
 * bind the initialization manifest to generation 0's population LAST, so a
 * generation-0 content defect reports with its most specific first message
 * (the per-generation guards) and only a manifest that attests none of them
 * reports as the provenance contradiction it is. That bind is two-tier: the
 * manifest's FNV population state is the cheap prefilter with its own message,
 * and the VERDICT is recreation — `createInitialPopulation(manifest.config)`
 * must serialize to bytes exactly identical to the persisted generation-0
 * population component (the initializer codec's contract is that re-running it
 * with the decoded config reproduces the population). Anything less would let
 * a swapped generation 0 pass with both FNV states re-attested — no hash
 * collision needed — and be read as verified evidence while resume recreated a
 * different run.
 *
 * Call this only after `checkFitnessVectorCompatibility` and
 * `verifyFitnessVectorMetadataCoherence`: those gates own version and
 * current-format decoding precedence. Both resume and offline extraction call
 * this gate, so a detectable current-format contradiction has one
 * `malformedHistory` taxonomy before runtime or physics. FNV is only a
 * non-cryptographic coherence sentinel inside the SHA-256-attested artifact;
 * it never establishes artifact identity. Offline extraction may request the
 * decoded generation rows for reuse; resume leaves that off so only one
 * generation's decoded rows are retained during this pass. The recreated
 * generation-0 population (object and canonical bytes) is returned either way:
 * resume replays FROM it instead of recreating a second time after the
 * runtime gate, and extraction simply ignores it.
 */
export function verifyEvolutionArtifactSemantics(verified, collectGenerations = false) {
  const { header, framing } = verified;
  let spec;
  try {
    spec = canonicalizeEvaluationSpec(
      deserializeEvaluationSpec(header.evaluationSpecBytes),
    ).spec;
  } catch (cause) {
    evolutionFail('malformedHistory',
      'history evaluation spec is malformed or not executable', {}, cause);
  }
  if (spec.deterministic !== true) {
    evolutionFail('malformedHistory',
      'history evaluation spec is not deterministic — evolution binds one engine identity',
      { deterministic: String(spec.deterministic) });
  }
  let manifest;
  try {
    manifest = deserializePopulationInitialization(header.initializationManifestBytes);
  } catch (cause) {
    evolutionFail('malformedHistory', 'history initialization manifest is malformed', {}, cause);
  }
  if (manifest.config.populationSize !== header.populationSize) {
    evolutionFail('malformedHistory',
      `history populationSize ${header.populationSize} disagrees with initialization manifest ${manifest.config.populationSize}`,
      {
        headerPopulationSize: header.populationSize,
        manifestPopulationSize: manifest.config.populationSize,
      });
  }
  assertEvaluationWork(header.populationSize, spec.maxSteps);
  const expectedEvaluationSpecDigestState = fnv1aFold(
    FNV_OFFSET_BASIS, header.evaluationSpecBytes,
  );
  const generations = collectGenerations ? [] : null;

  for (let generationIndex = 0;
    generationIndex < framing.generations.length;
    generationIndex += 1) {
    const payload = decodeGenerationPayload(framing.generations[generationIndex].payloadBytes);
    const { population: populationBytes, fitnessVector: fitnessVectorBytes } = payload.components;
    const vector = deserializeFitnessVector(fitnessVectorBytes);
    const individualCount = vector.individuals.length;

    if (individualCount !== header.populationSize) {
      evolutionFail('malformedHistory',
        `generation ${generationIndex} fitness vector carries ${individualCount} rows, `
        + `but the history header populationSize is ${header.populationSize}`,
        {
          generationIndex,
          rule: 'fitnessVectorPopulationSizeMismatch',
          populationSize: header.populationSize,
          individualCount,
        });
    }

    const expectedPopulationSnapshotDigestState = fnv1aFold(
      FNV_OFFSET_BASIS, populationBytes,
    );
    if (vector.populationSnapshotDigestState !== expectedPopulationSnapshotDigestState) {
      evolutionFail('malformedHistory',
        `generation ${generationIndex} fitness vector populationSnapshotDigestState `
        + `${vector.populationSnapshotDigestState} does not match the persisted population snapshot `
        + `state ${expectedPopulationSnapshotDigestState}`,
        {
          generationIndex,
          rule: 'populationSnapshotDigestStateMismatch',
          stored: vector.populationSnapshotDigestState,
          expected: expectedPopulationSnapshotDigestState,
        });
    }
    if (vector.evaluationSpecDigestState !== expectedEvaluationSpecDigestState) {
      evolutionFail('malformedHistory',
        `generation ${generationIndex} fitness vector evaluationSpecDigestState `
        + `${vector.evaluationSpecDigestState} does not match the history evaluation spec state `
        + `${expectedEvaluationSpecDigestState}`,
        {
          generationIndex,
          rule: 'evaluationSpecDigestStateMismatch',
          stored: vector.evaluationSpecDigestState,
          expected: expectedEvaluationSpecDigestState,
        });
    }

    let populationCount;
    try {
      populationCount = peekPopulationSnapshotMemberCount(populationBytes);
    } catch (cause) {
      evolutionFail('malformedHistory',
        `generation ${generationIndex} ${COMPONENT_LABELS.population} has a truncated or unreadable prefix`,
        { generationIndex },
        cause);
    }
    if (populationCount !== header.populationSize) {
      evolutionFail('malformedHistory',
        `generation ${generationIndex} population snapshot carries ${populationCount} members, `
        + `but the history header populationSize is ${header.populationSize}`,
        {
          generationIndex,
          rule: 'populationSnapshotPopulationSizeMismatch',
          populationSize: header.populationSize,
          populationCount,
        });
    }

    let population;
    try {
      population = deserializePopulationSnapshot(populationBytes);
    } catch (cause) {
      evolutionFail('malformedHistory',
        `generation ${generationIndex} ${COMPONENT_LABELS.population} is malformed`,
        { generationIndex },
        cause);
    }

    for (let memberIndex = 0; memberIndex < header.populationSize; memberIndex += 1) {
      const stored = vector.individuals[memberIndex].individualId;
      const expected = population.individuals[memberIndex].individualId;
      if (stored !== expected) {
        evolutionFail('malformedHistory',
          `generation ${generationIndex} fitness vector individual ${stored} at member index `
          + `${memberIndex} does not match persisted population member ${expected}`,
          {
            generationIndex,
            rule: 'fitnessVectorIndividualIdMismatch',
            memberIndex,
            stored,
            expected,
          });
      }
    }

    const metadata = deserializeEvaluationMetadata(payload.components.evaluationMetadata);
    if (metadata.executedSteps !== spec.maxSteps) {
      evolutionFail('malformedHistory',
        `generation ${generationIndex} evaluation metadata executedSteps ${metadata.executedSteps} `
        + `does not match evaluation spec maxSteps ${spec.maxSteps}`,
        {
          generationIndex,
          rule: 'evaluationMetadataMaxStepsMismatch',
          executedSteps: metadata.executedSteps,
          maxSteps: spec.maxSteps,
        });
    }
    if (generations !== null) {
      generations.push(Object.freeze({
        generationIndex: payload.generationIndex,
        terminalReason: payload.terminalReason,
        executedSteps: metadata.executedSteps,
        individuals: vector.individuals,
      }));
    }
  }
  // The initialization provenance binding, evaluated AFTER the per-generation
  // content bindings above: a defect in generation 0's population reports
  // with its most specific first message (the count/row/digest-state guards
  // in the loop), and only when those pass does a manifest that fails to
  // attest generation 0's population report as the provenance contradiction
  // it is. The FNV state is the cheap PREFILTER of that bind — it keeps its
  // own message — but a 32-bit state can never be the verdict: the ruling is
  // that FNV is a same-source mismatch sentinel, never identity between
  // independently persisted artifacts.
  const generationZeroPayload = decodeGenerationPayload(framing.generations[0].payloadBytes);
  const generationZeroPopulationDigestState = fnv1aFold(
    FNV_OFFSET_BASIS, generationZeroPayload.components.population,
  );
  if (manifest.populationSnapshotDigestState !== generationZeroPopulationDigestState) {
    evolutionFail('malformedHistory',
      `initialization manifest populationSnapshotDigestState `
      + `${manifest.populationSnapshotDigestState} does not match generation 0 population state `
      + `${generationZeroPopulationDigestState}`,
      {
        generationIndex: 0,
        rule: 'initializationPopulationDigestStateMismatch',
        stored: manifest.populationSnapshotDigestState,
        expected: generationZeroPopulationDigestState,
      });
  }
  // The verdict half of the bind, and the check the prefilter cannot be: the
  // manifest's config must REPRODUCE generation 0. Recreate the population
  // with `createInitialPopulation(manifest.config)` — the initializer codec's
  // own contract is that re-running it with the decoded config reproduces the
  // population — serialize it canonically, and require EXACT BYTE IDENTITY
  // with the persisted generation-0 population component. Without this, an
  // artifact whose generation 0 was swapped with BOTH FNV states re-attested
  // (no hash collision needed) passed every gate: extraction returned its rows
  // as verified evidence while resume went on to recreate a DIFFERENT
  // generation 0 and report replayDivergence at stage 'initialization' — the
  // offline seam accepting what resume rejects. A current-format semantic
  // contradiction is malformedHistory HERE, before runtime or physics, never
  // a later replay verdict.
  let recreated;
  try {
    recreated = createInitialPopulation(manifest.config);
  } catch (cause) {
    evolutionFail('malformedHistory',
      'history initialization manifest cannot recreate generation zero', {}, cause);
  }
  const recreatedPopulationBytes = serializePopulationSnapshot(recreated.population);
  const persistedPopulationBytes = generationZeroPayload.components.population;
  const mismatchOffset = firstByteDifference(persistedPopulationBytes, recreatedPopulationBytes);
  if (mismatchOffset !== -1) {
    const storedByteLength = typedArrayByteLength(persistedPopulationBytes);
    const recomputedByteLength = typedArrayByteLength(recreatedPopulationBytes);
    const context = {
      generationIndex: 0,
      rule: 'initializationPopulationRecreationMismatch',
      byteOffset: mismatchOffset,
      storedByteLength,
      recomputedByteLength,
    };
    if (mismatchOffset < storedByteLength) context.storedByte = persistedPopulationBytes[mismatchOffset];
    if (mismatchOffset < recomputedByteLength) context.recomputedByte = recreatedPopulationBytes[mismatchOffset];
    evolutionFail('malformedHistory',
      'initialization manifest config recreates a generation 0 population that differs '
      + `from the persisted population snapshot (first differing byte ${mismatchOffset})`,
      context);
  }
  // Resume replays FROM this recreation — it is exactly the recreation resume
  // used to run as stage 13a after the runtime gate — so the replay loop's
  // generation-0 population comparison starts from bytes this gate already
  // proved identical to the persisted component. Extraction ignores it; its
  // retention ends with the return value's lifetime.
  return Object.freeze({
    spec,
    manifest,
    generations: generations === null ? null : Object.freeze(generations),
    generationZero: Object.freeze({
      population: recreated.population,
      populationBytes: recreatedPopulationBytes,
    }),
  });
}

/**
 * Stage 12 — the runtime gate, run BEFORE any physics.
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
    // Refuse an impossible length before allocating a caller-sized owned copy.
    // Invalid storage remains an invalidConfig verdict at this public seam.
    let declaredDigestLength;
    try {
      declaredDigestLength = typedArrayByteLength(rawDigest);
    } catch (cause) {
      evolutionFail('invalidConfig',
        `resume option expectedHistoryDigestBytes is not valid persisted bytes: ${cause && cause.message ? cause.message : String(cause)}`,
        {}, cause);
    }
    if (declaredDigestLength !== SHA256_DIGEST_BYTES) {
      evolutionFail('invalidConfig',
        `expectedHistoryDigestBytes must be exactly ${SHA256_DIGEST_BYTES} bytes`,
        { byteLength: declaredDigestLength });
    }
    historyDigestBytes = copy(rawDigest);
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
