// THE VERIFIED EXTRACTION SEAM (R6) — offline consumers read the five
// persisted integrity observations from a history artifact WITHOUT
// re-simulation, and only through the same verification the resume seam runs.
//
//   import { extractHistoryObservations } from './scripts/history-observations.js';
//   const generations = await extractHistoryObservations(historyBytes, options?);
//
// WHY A SEAM AND NOT "just decode the vector". The observations exist so that
// forensic tooling never re-runs physics to learn what the recorded run
// already measured — but bytes read OUTSIDE the gates would trust an artifact
// nothing has attested. This function runs, in order: stages 3–7 (framing,
// header digest, component digests, chain, whole-history digest), stage 8
// (external expected identity — `options.expectedHistoryDigestBytes` /
// `options.expectedGenerationIndex`, the one check that distinguishes stale
// from corrupt), then Gate A (fitness-vector version compatibility —
// a stale v2 artifact is refused as `unsupportedVersion`, never surfaced as a
// decode error) and Gate B (fitness-vector ↔ metadata coherence). Only then
// are observations decoded, from the module-owned copy.
//
// NOT an `async function`, deliberately — the same ruling as
// `resumeEvolutionRun`: the caller's artifact and any expected-identity bytes
// are validated and COPIED in the synchronous prologue, before an `await`
// exists to suspend at, so "no caller bytes are borrowed across an await" is
// structural. A fancy storage shape or an over-ceiling artifact is refused
// with a synchronous throw. The 64 MiB ceiling is checked on the INTRINSIC
// length BEFORE the copy.
//
// Node-only, outside the src/sim ESLint ban.

import { copyOrdinaryBytes, typedArrayByteLength } from '../src/sim/bytes.js';
import { evolutionFail } from '../src/sim/evolution-contract.js';
import {
  MAX_EVOLUTION_HISTORY_BYTES, decodeGenerationPayload, deserializeEvaluationMetadata,
} from '../src/sim/evolution-history.js';
import { deserializeFitnessVector } from '../src/sim/population-evaluation.js';
import {
  captureExpectedIdentity, checkExpectedIdentity, checkFitnessVectorCompatibility,
  verifyFitnessVectorMetadataCoherence, verifyHistoryArtifact,
} from '../src/sim/evolution-replay.js';

function bytesFail(path, value) {
  evolutionFail('malformedHistory', `history-observations: invalid ${path} (${String(value)})`, { path });
}

function optionBytesFail(path, value) {
  evolutionFail('invalidConfig', `history-observations: invalid option ${path} (${String(value)})`, { path });
}

/**
 * Extract the per-member integrity observations from a verified artifact.
 *
 * Resolves to a frozen array, one record per committed generation:
 *   { generationIndex, executedSteps, effectiveDt, individuals }
 * where each individual row is
 *   { individualId, valid, integrityStatus, fitness, peakBodySpeed,
 *     peakSpeedDelta, peakStepDisplacement, firstAlertStep,
 *     firstCatastrophicStep }
 * — exactly the decoded vector rows, no reinterpretation.
 */
export function extractHistoryObservations(historyBytes, options = undefined) {
  let declaredLength;
  try {
    declaredLength = typedArrayByteLength(historyBytes);
  } catch (cause) {
    evolutionFail('malformedHistory',
      `historyBytes are not valid persisted bytes: ${cause && cause.message ? cause.message : String(cause)}`,
      {}, cause);
  }
  if (declaredLength > MAX_EVOLUTION_HISTORY_BYTES) {
    evolutionFail('resourceLimitExceeded',
      `history byte length ${declaredLength} exceeds MAX_EVOLUTION_HISTORY_BYTES (${MAX_EVOLUTION_HISTORY_BYTES})`,
      { byteLength: declaredLength, limit: MAX_EVOLUTION_HISTORY_BYTES });
  }
  const owned = copyOrdinaryBytes(historyBytes, bytesFail);
  const expected = captureExpectedIdentity(options, (b) => copyOrdinaryBytes(b, optionBytesFail));
  return extractFromOwnedBytes(owned, expected);
}

async function extractFromOwnedBytes(owned, expected) {
  const verified = await verifyHistoryArtifact(owned);
  checkExpectedIdentity(verified, expected);
  checkFitnessVectorCompatibility(verified);
  verifyFitnessVectorMetadataCoherence(verified);
  // Every decode below re-reads the MODULE-OWNED copy taken in the prologue —
  // the caller has had no handle to these bytes since before the first await.
  const generations = verified.framing.generations;
  const out = [];
  for (let i = 0; i < generations.length; i += 1) {
    const payload = decodeGenerationPayload(generations[i].payloadBytes);
    const metadata = deserializeEvaluationMetadata(payload.components.evaluationMetadata);
    const vector = deserializeFitnessVector(payload.components.fitnessVector);
    out.push(Object.freeze({
      generationIndex: i,
      executedSteps: metadata.executedSteps,
      effectiveDt: metadata.effectiveDt,
      // The decoded rows are already frozen (deserializeFitnessVector owns
      // that) and carry exactly the persisted fields — pass them through.
      individuals: vector.individuals,
    }));
  }
  return Object.freeze(out);
}
