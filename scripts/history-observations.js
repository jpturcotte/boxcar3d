// THE VERIFIED HISTORY-OBSERVATION SEAM (PR 29, R6): read the five integrity
// observations a persisted evolution history carries — from a VERIFIED
// artifact, with NO re-simulation.
//
// WHY THIS EXISTS. Fitness-vector v3 persists the integrity observations the
// online detector already computed, so an offline consumer can read alert-band
// evidence out of a saved history. But a consumer that only DECODES would read
// a tampered artifact as evidence even though the stored component and history
// digests no longer attest it (the round-13 deferral lesson: bytes a digest
// never attested must never be read as attested). This seam therefore runs the
// PRODUCTION verification internally — `verifyHistoryArtifact` (framing,
// header digest, every component digest, the chain, the whole-history digest)
// and all three pre-physics gates (fitness-vector compatibility, metadata
// coherence, then shared artifact semantics/bindings) — before returning
// anything, sharing the resume checks and error taxonomy rather than growing a
// second, script-local interpretation. The third gate decodes the evaluation
// spec and initialization manifest, checks the population/spec/vector/metadata
// relationships, and returns the already-checked rows for reuse. An optional
// externally held expected history digest binds freshness exactly like resume.
//
// WHY IT LIVES HERE and not in src/sim: it is an offline, read-only consumer —
// not a production module the byte-family lint scope and the ownership
// classification would have to grow to cover for no correctness gain.
// (`scripts/experiment-evolution.js`'s `summarizeEvolutionHistory` decodes
// without verifying; that is sound for the in-process bytes it is handed from
// `run.historyBytes()`, and unsound for a persisted artifact — which is what
// this seam reads.)
//
// `extractHistoryObservations(historyBytes, options?)` is ASYNC because
// SHA-256 is, and pure with respect to filesystem, clock, randomness and
// physics: verification is byte work only, and decoding runs no evaluation.
// It returns, per generation, the decoded row plus its observations and the
// generation's `executedSteps` — NO aggregation, gates, sampling,
// counterfactuals or policy analysis (those are the measurement layer's own
// PR, not this seam's).

import { copyOrdinaryBytes, typedArrayByteLength } from '../src/sim/bytes.js';
import { evolutionFail } from '../src/sim/evolution-contract.js';
import { SHA256_DIGEST_BYTES } from '../src/sim/evolution-history.js';
import {
  MAX_EVOLUTION_HISTORY_BYTES, checkExpectedIdentity, checkFitnessVectorCompatibility,
  verifyEvolutionArtifactSemantics, verifyFitnessVectorMetadataCoherence, verifyHistoryArtifact,
} from '../src/sim/evolution-replay.js';

function malformed(path, value) {
  evolutionFail('malformedHistory', `history-observations: invalid ${path} (${String(value)})`, { path });
}

/**
 * Extract the decoded fitness rows and integrity observations of every
 * generation of a persisted evolution history, after FULL verification.
 *
 * @param {Uint8Array} historyBytes the persisted artifact (copied at intake).
 * @param {{ expectedHistoryDigestBytes?: Uint8Array }} [options] an externally
 *   held expected digest — the same freshness contract as resume; a mismatch
 *   reports `staleOrWrongArtifact`, never a format or corruption verdict.
 * @returns {Promise<{ historyDigestBytes: Uint8Array, generations: Array }>}
 *   frozen per-generation `{ generationIndex, terminalReason, executedSteps,
 *   individuals }`, where each individual is the decoded vector row
 *   `{ individualId, valid, integrityStatus, fitness, integrityObservations }`.
 */
export async function extractHistoryObservations(historyBytes, options = undefined) {
  // The intake seam mirrors resume's: ceiling on the INTRINSIC length before
  // the copy, then owned bytes, then copied expectations — no caller buffer is
  // borrowed across an `await`.
  let declaredLength;
  try {
    declaredLength = typedArrayByteLength(historyBytes);
  } catch (cause) {
    evolutionFail(
      'malformedHistory',
      'history-observations: historyBytes are not valid persisted bytes',
      { path: 'historyBytes' },
      cause,
    );
  }
  if (declaredLength > MAX_EVOLUTION_HISTORY_BYTES) {
    evolutionFail('resourceLimitExceeded',
      `history byte length ${declaredLength} exceeds MAX_EVOLUTION_HISTORY_BYTES (${MAX_EVOLUTION_HISTORY_BYTES})`,
      { byteLength: declaredLength, limit: MAX_EVOLUTION_HISTORY_BYTES });
  }
  const owned = copyOrdinaryBytes(historyBytes, malformed);
  // The freshness contract is resume's, mirrored gate for gate (the
  // captureExpectedIdentity discipline), restricted to the ONE option this
  // seam declares: null/undefined options are absent; the container must be a
  // PLAIN object (a custom prototype's enumerable keys would be dropped);
  // non-enumerable own properties are refused (a presence gate must use the
  // same enumeration its consumer reads with); and the one declared value is
  // read EXACTLY ONCE, before any await.
  let expectedDigestBytes = null;
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object' || Array.isArray(options)) {
      evolutionFail('invalidConfig', 'history-observations: options must be a plain object', {});
    }
    const proto = Object.getPrototypeOf(options);
    if (proto !== Object.prototype && proto !== null) {
      evolutionFail('invalidConfig', 'history-observations: options must be a plain object', {});
    }
    const keys = Object.keys(options);
    if (Object.getOwnPropertyNames(options).length !== keys.length) {
      evolutionFail('invalidConfig', 'history-observations: options carry non-enumerable own properties', {});
    }
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i] !== 'expectedHistoryDigestBytes') {
        evolutionFail('invalidConfig', `history-observations: option '${keys[i]}' is not a known key`, { key: keys[i] });
      }
    }
    const rawDigest = options.expectedHistoryDigestBytes; // ONE read
    if (rawDigest !== undefined) {
      // Exactly 32 bytes are legal, so validate the intrinsic length before
      // allocating an owned copy of an arbitrarily large caller buffer.
      let declaredDigestLength;
      try {
        declaredDigestLength = typedArrayByteLength(rawDigest);
      } catch (cause) {
        evolutionFail(
          'invalidConfig',
          'history-observations: expectedHistoryDigestBytes are not valid persisted bytes',
          { path: 'expectedHistoryDigestBytes' },
          cause,
        );
      }
      if (declaredDigestLength !== SHA256_DIGEST_BYTES) {
        evolutionFail('invalidConfig',
          `history-observations: expectedHistoryDigestBytes must be exactly ${SHA256_DIGEST_BYTES} bytes (${declaredDigestLength})`,
          { byteLength: declaredDigestLength });
      }
      expectedDigestBytes = copyOrdinaryBytes(rawDigest, (path, value) => {
        evolutionFail('invalidConfig', `history-observations: invalid option ${path} (${String(value)})`, { path });
      });
    }
  }

  // Verification FIRST, always: nothing is decoded from bytes the digests do
  // not attest, and compatibility/coherence/semantics come from the production gates.
  const verified = await verifyHistoryArtifact(owned);
  if (expectedDigestBytes !== null) {
    checkExpectedIdentity(verified, { historyDigestBytes: expectedDigestBytes, generationIndex: null });
  }
  checkFitnessVectorCompatibility(verified);
  verifyFitnessVectorMetadataCoherence(verified);
  const { generations } = verifyEvolutionArtifactSemantics(verified, true);
  return Object.freeze({
    historyDigestBytes: copyOrdinaryBytes(verified.historyDigestBytes, malformed),
    generations,
  });
}
