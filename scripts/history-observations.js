// scripts/history-observations.js — verified extraction seam (PR #27, R6)
//
// extractHistoryObservations(historyBytes, { expectedHistoryDigestBytes?,
// expectedGenerationIndex? }) runs the full production verification ladder:
// stages 1–2 (owned-copy intake), 3–7 (verifyHistoryArtifact digest chain),
// 8 (checkExpectedIdentity — staleness, not corruption), 8a
// (checkFitnessVectorCompatibility — unsupportedVersion), 8b
// (verifyFitnessVectorMetadataCoherence — malformedHistory) — all BEFORE
// decoding anything, sharing the production checks and error taxonomy —
// never a second, script-local interpretation of compatibility.
//
// Async because SHA-256 is; pure with respect to filesystem, clock, randomness
// and physics. Returns per generation and per individual the decoded row plus
// its observations and the generation's executedSteps.
//
// NO aggregation, gates, sampling, counterfactuals or policy analysis —
// those are PR #28's.
//
// Placed OUTSIDE src/sim/: an offline read-only consumer, and a new src/sim
// module would expand the derived byte-family lint scope and ownership
// classification for no correctness gain.

import {
  MAX_EVOLUTION_HISTORY_BYTES,
  captureExpectedIdentity, checkExpectedIdentity,
  checkFitnessVectorCompatibility, verifyFitnessVectorMetadataCoherence,
  verifyHistoryArtifact,
} from '../src/sim/evolution-replay.js';
import { evolutionFail } from '../src/sim/evolution-contract.js';
import { copyOrdinaryBytes, typedArrayByteLength } from '../src/sim/bytes.js';
import { decodeGenerationPayload, deserializeEvaluationMetadata } from '../src/sim/evolution-history.js';
import { deserializeFitnessVector } from '../src/sim/population-evaluation.js';

const bytesFail = (path, value) => evolutionFail('invalidConfig', `history-observations: invalid ${path}`, { value });
const configBytesFail = (path, value) => evolutionFail('invalidConfig', `history-observations: invalid options.${path}`, { value });

// The intake measurement must classify a non-ordinary input as invalid config
// (matching the seam's other intake refusals) rather than leak the byte
// helper's own error shape.
function translateIntake(body) {
  try {
    return body();
  } catch (cause) {
    return bytesFail('historyBytes', cause && cause.message ? cause.message : String(cause));
  }
}

/**
 * Extract integrity observations from a cryptographically verified history
 * artifact. Runs the full production verification ladder (owned-copy intake,
 * digest chain, external identity, version compatibility, metadata coherence)
 * before decoding — a tampered or stale artifact is refused, never read.
 *
 * @param {Uint8Array} historyBytes — the complete history artifact bytes.
 * @param {object} [options]
 * @param {Uint8Array} [options.expectedHistoryDigestBytes] — optional 32-byte
 *   expected history digest for external identity verification (stage 8).
 * @param {number} [options.expectedGenerationIndex] — optional expected final
 *   committed generation index (stage 8).
 * @returns {Promise<{generations: Array<{generationIndex: number, executedSteps: number, individuals: Array}>}>}
 *   Per generation: the generation index, executedSteps from metadata, and
 *   the decoded fitness-vector rows (each carrying integrityObservations).
 */
export async function extractHistoryObservations(historyBytes, options = {}) {
  // Stage 1: the 64 MiB ceiling is checked on the INTRINSIC length BEFORE any
  // copy — mirroring the production resume seam, so an oversized artifact is
  // refused as resourceLimitExceeded without first allocating its own size.
  const declaredLength = translateIntake(() => typedArrayByteLength(historyBytes));
  if (declaredLength > MAX_EVOLUTION_HISTORY_BYTES) {
    evolutionFail('resourceLimitExceeded',
      `history byte length ${declaredLength} exceeds MAX_EVOLUTION_HISTORY_BYTES (${MAX_EVOLUTION_HISTORY_BYTES})`,
      { byteLength: declaredLength, limit: MAX_EVOLUTION_HISTORY_BYTES });
  }
  // Stage 2: owned-copy intake — the caller's buffer is copied before any
  // await, so post-verification decoding reads only verified bytes (TOCTOU-safe).
  const owned = copyOrdinaryBytes(historyBytes, bytesFail);
  const expected = captureExpectedIdentity(options, (b) => copyOrdinaryBytes(b, configBytesFail));

  // Stages 3–7: full production verification (digest chain, framing, components).
  const verified = await verifyHistoryArtifact(owned);

  // Stage 8: external identity — staleness detection, not corruption.
  checkExpectedIdentity(verified, expected);

  // Stage 8a: fitness-vector compatibility — unsupportedVersion before decode.
  checkFitnessVectorCompatibility(verified);

  // Stage 8b: fitness-vector metadata coherence — malformedHistory before decode.
  verifyFitnessVectorMetadataCoherence(verified);

  // Decode: the artifact is verified and coherent; extract observations.
  const generationCount = verified.framing.generations.length;
  const generations = [];

  for (let i = 0; i < generationCount; i += 1) {
    const payload = decodeGenerationPayload(verified.framing.generations[i].payloadBytes);
    const metadata = deserializeEvaluationMetadata(payload.components.evaluationMetadata);
    const fitnessVector = deserializeFitnessVector(payload.components.fitnessVector);

    generations.push(Object.freeze({
      generationIndex: i,
      executedSteps: metadata.executedSteps,
      individuals: fitnessVector.individuals,
    }));
  }

  return Object.freeze({ generations });
}
