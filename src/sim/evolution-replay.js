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
//   8a. fitness-vector compatibility               (unsupportedVersion)
//   8b. fitness-vector metadata coherence           (malformedHistory)
//   9. deterministic flavor + exact Rapier version (before physics)
//  10. deterministic replay, stopping at the first byte divergence
//
// Stages 1-2 belong to the caller's intake seam (evolution-run's resume
// prologue, which must copy before it awaits); 3-7 are `verifyHistoryArtifact`;
// 8 is `checkExpectedIdentity`; 8a-8b are the fitness-vector compatibility and
// metadata-coherence gates (`checkFitnessVectorCompatibility` and
// `verifyFitnessVectorMetadataCoherence`); 9 is `checkRuntimeIdentity`;
// 10 is the run's own replay loop.
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
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, MAX_EVOLUTION_GENERATIONS,
  MAX_EVOLUTION_POPULATION_SIZE, evolutionFail, isEvolutionUint32,
} from './evolution-contract.js';
import { EVOLUTION_LINEAGE_VERSION } from './evolution-lineage.js';
import {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE,
} from './evolution-operators.js';
import { peekFitnessVectorVersions, deserializeFitnessVector } from './population-evaluation.js';
import {
  INTEGRITY_REFERENCE_CAPTURE_DT, INTEGRITY_THRESHOLDS,
} from './integrity.js';

/** The replay stages, in the order a record's components are compared. */
export const REPLAY_STAGES = Object.freeze([
  'initialization', 'population', 'evaluationMetadata', 'fitnessVector',
  'terminalReason', 'lineage',
]);

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
  });
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

/**
 * Stage 8a — fitness-vector compatibility (Gate A).
 *
 * Layered version check owned by `population-evaluation.js`: reads
 * `fitnessVectorVersion` first; if unsupported, stops and reports it without
 * assuming an unknown layout. Only when current, reads and compares the
 * remaining four declared fields. A truncated or structurally unreadable
 * prefix is `malformedHistory`, not `unsupportedVersion`.
 */
export function checkFitnessVectorCompatibility(verified) {
  const generationCount = verified.framing.generations.length;
  for (let i = 0; i < generationCount; i += 1) {
    const payload = decodeGenerationPayload(verified.framing.generations[i].payloadBytes);
    const fvBytes = payload.components.fitnessVector;
    let mismatch;
    try {
      mismatch = peekFitnessVectorVersions(fvBytes);
    } catch (cause) {
      evolutionFail('malformedHistory',
        `generation ${i} fitness vector is structurally unreadable: ${cause && cause.message ? cause.message : String(cause)}`,
        { generationIndex: i });
      return; // unreachable
    }
    if (mismatch !== null) {
      evolutionFail('unsupportedVersion',
        `generation ${i} fitness vector ${mismatch.field} is ${mismatch.stored}; this build implements ${mismatch.current}`,
        { generationIndex: i, field: mismatch.field, stored: mismatch.stored, current: mismatch.current });
    }
  }
}

/**
 * Stage 8b — fitness-vector metadata coherence (Gate B).
 *
 * A current-format artifact whose observations contradict its own metadata is
 * malformed, not unsupported: `0 ≤ firstAlertStep ≤ executedSteps` and
 * `0 ≤ firstCatastrophicStep ≤ executedSteps`, using each generation's own
 * persisted metadata; plus the peak↔alert equivalence, which needs
 * `effectiveDt` for `dtScale`.
 */
export function verifyFitnessVectorMetadataCoherence(verified) {
  const generationCount = verified.framing.generations.length;
  for (let i = 0; i < generationCount; i += 1) {
    const payload = decodeGenerationPayload(verified.framing.generations[i].payloadBytes);
    const metadata = deserializeEvaluationMetadata(payload.components.evaluationMetadata);
    const executedSteps = metadata.executedSteps;
    const effectiveDt = metadata.effectiveDt;
    const dtScale = effectiveDt / INTEGRITY_REFERENCE_CAPTURE_DT;
    const alertSpeed = INTEGRITY_THRESHOLDS.alertSpeed;
    const alertSpeedDelta = INTEGRITY_THRESHOLDS.alertSpeedDelta * dtScale;
    const alertStepDisplacement = INTEGRITY_THRESHOLDS.alertStepDisplacement * dtScale;
    const catastrophicSpeed = INTEGRITY_THRESHOLDS.catastrophicSpeed;
    const catastrophicStepDisplacement = INTEGRITY_THRESHOLDS.catastrophicStepDisplacement * dtScale;
    const vector = deserializeFitnessVector(payload.components.fitnessVector);
    const individuals = vector.individuals;
    for (let j = 0; j < individuals.length; j += 1) {
      const ind = individuals[j];
      const obs = ind.integrityObservations;
      const id = ind.individualId;
      // Step bounds: 0 ≤ step ≤ executedSteps.
      if (obs.firstAlertStep !== null && obs.firstAlertStep > executedSteps) {
        evolutionFail('malformedHistory',
          `generation ${i} individual ${id} firstAlertStep ${obs.firstAlertStep} exceeds executedSteps ${executedSteps}`,
          { generationIndex: i, individualId: id, firstAlertStep: obs.firstAlertStep, executedSteps });
      }
      if (obs.firstCatastrophicStep !== null && obs.firstCatastrophicStep > executedSteps) {
        evolutionFail('malformedHistory',
          `generation ${i} individual ${id} firstCatastrophicStep ${obs.firstCatastrophicStep} exceeds executedSteps ${executedSteps}`,
          { generationIndex: i, individualId: id, firstCatastrophicStep: obs.firstCatastrophicStep, executedSteps });
      }
      // Peak↔alert equivalence: an alert step is set iff at least one peak
      // exceeds its alert threshold (the peaks are whole-run maxima, so the
      // equivalence holds by construction from the same capture loop).
      const alertPeakExceeded = obs.peakBodySpeed > alertSpeed
        || obs.peakSpeedDelta > alertSpeedDelta
        || obs.peakStepDisplacement > alertStepDisplacement;
      if (obs.firstAlertStep !== null && !alertPeakExceeded) {
        evolutionFail('malformedHistory',
          `generation ${i} individual ${id} declares firstAlertStep ${obs.firstAlertStep} but no peak exceeds the alert threshold`,
          { generationIndex: i, individualId: id, firstAlertStep: obs.firstAlertStep });
      }
      if (obs.firstAlertStep === null && alertPeakExceeded) {
        evolutionFail('malformedHistory',
          `generation ${i} individual ${id} has a peak exceeding the alert threshold but no firstAlertStep`,
          { generationIndex: i, individualId: id });
      }
      // Peak↔catastrophic equivalence (speed or displacement).
      const catPeakExceeded = obs.peakBodySpeed > catastrophicSpeed
        || obs.peakStepDisplacement > catastrophicStepDisplacement;
      if (obs.firstCatastrophicStep !== null && !catPeakExceeded) {
        evolutionFail('malformedHistory',
          `generation ${i} individual ${id} declares firstCatastrophicStep ${obs.firstCatastrophicStep} but no peak exceeds the catastrophic threshold`,
          { generationIndex: i, individualId: id, firstCatastrophicStep: obs.firstCatastrophicStep });
      }
      if (obs.firstCatastrophicStep === null && catPeakExceeded) {
        evolutionFail('malformedHistory',
          `generation ${i} individual ${id} has a peak exceeding the catastrophic threshold but no firstCatastrophicStep`,
          { generationIndex: i, individualId: id });
      }
    }
  }
}
