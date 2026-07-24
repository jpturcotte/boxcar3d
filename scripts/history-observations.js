// THE OFFLINE READ SEAM for integrity evidence in a persisted evolution
// history — the capability fitness vector v3 exists to provide.
//
// WHAT THIS IS FOR. Before v3 the fitness vector stored an integrity STATUS and
// nothing else, so "was this champion locomotion or constraint-solver
// divergence?" could not be answered from a saved artifact: PR #26 had to
// re-simulate its own campaign to diagnose the contamination it had found.
// v3 persists the five observations the online detector already computed, and
// this function is where a consumer reads them back — with NO physics, no
// engine, and no re-evaluation.
//
// IT VERIFIES BEFORE IT READS, and that is not optional. Decoding the framing
// and pulling out the components would happily return observations from an
// artifact whose stored component digest and history digest no longer attest
// them — evidence that nothing vouches for, presented as if it did. So this
// seam runs the SAME ordered verification the production resume path runs
// (`verifyHistoryArtifact`, stages 3-7) plus both pre-physics gates, and shares
// their error taxonomy. There is deliberately no second, script-local notion of
// what "a valid history" means.
//
// (Note the contrast with `summarizeEvolutionHistory` in
// scripts/experiment-evolution.js, which decodes without verifying. That is
// sound where it is used — its input is the in-process return value of
// `run.historyBytes()`, which no one has had a chance to modify. It is NOT
// sound for an artifact read back from disk, which is exactly what this seam
// is for.)
//
// SCOPE, deliberately narrow. This returns decoded rows and nothing else: no
// aggregation, no rates, no distributions, no thresholds, no counterfactuals
// and no policy analysis. Those belong to the measurement PR that consumes
// this, and keeping them out is what stops an offline reader from quietly
// becoming a second, unversioned fitness policy.
//
// PURE with respect to filesystem, clock, randomness and physics. Async only
// because SHA-256 verification is.
//
// It lives in `scripts/` rather than `src/sim/` because it is an offline
// read-only consumer: a new `src/sim` module would widen the derived
// byte-family lint scope and the ownership-classification surface that exist
// to police modules handling canonical bytes under the determinism ban, and
// this one gains nothing from that.

import {
  decodeGenerationPayload, deserializeEvaluationMetadata,
} from '../src/sim/evolution-history.js';
import {
  checkExpectedIdentity, checkFitnessVectorCompatibility,
  verifyFitnessVectorMetadataCoherence, verifyHistoryArtifact,
} from '../src/sim/evolution-replay.js';
import { deserializeFitnessVector } from '../src/sim/population-evaluation.js';
import { deserializeLineage } from '../src/sim/evolution-lineage.js';
import { deserializePopulationSnapshot } from '../src/sim/population.js';
import { evolutionFail } from '../src/sim/evolution-contract.js';
import { bytesToHex, copyOrdinaryBytes } from '../src/sim/bytes.js';
import { serializeGenotype } from '../src/sim/assembly.js';

export const HISTORY_OBSERVATIONS_SCHEMA = 'boxcar3d.history-observations/1';

const bytesFail = (path, value) => {
  evolutionFail('malformedHistory',
    `history-observations: historyBytes are not ordinary canonical bytes at ${path} (${String(value)})`,
    { path });
};

/**
 * Decode the per-individual integrity evidence out of a VERIFIED evolution
 * history.
 *
 * `expectedHistoryDigestBytes` is the caller's externally-held freshness
 * claim, passed through to the same stage-8 check resume uses: a valid but
 * OLDER artifact verifies perfectly, so staleness can only ever be detected
 * against something the caller knows and the file does not.
 *
 * `includeGenotypeDigest` attaches each member's genotype digest. It is off by
 * default because it costs a serialization per member, and on when a consumer
 * needs to count distinct INDIVIDUALS: elitism gives a surviving individual a
 * fresh id every generation, so neither id nor fitness identifies a genome
 * across generations. Fitness in particular is a proxy that silently merges two
 * different vehicles — PR #26 shipped a summary field that did exactly that.
 */
export async function extractHistoryObservations(historyBytes, options = {}) {
  const {
    expectedHistoryDigestBytes = null,
    includeGenotypeDigest = false,
  } = options;
  // Copy before any await, the resume seam's rule: nothing this function
  // attests may be mutable by the caller while verification is in flight.
  const owned = copyOrdinaryBytes(historyBytes, bytesFail);

  // Stages 3-7, then the two pre-physics gates. Same functions, same codes.
  const verified = await verifyHistoryArtifact(owned);
  if (expectedHistoryDigestBytes !== null) {
    checkExpectedIdentity(verified, {
      historyDigestBytes: copyOrdinaryBytes(expectedHistoryDigestBytes, bytesFail),
      generationIndex: null,
    });
  }
  checkFitnessVectorCompatibility(verified);
  verifyFitnessVectorMetadataCoherence(verified);

  const framing = verified.framing;
  const generations = [];
  for (let i = 0; i < framing.generations.length; i += 1) {
    const payload = decodeGenerationPayload(framing.generations[i].payloadBytes);
    const metadata = deserializeEvaluationMetadata(payload.components.evaluationMetadata);
    const vector = deserializeFitnessVector(payload.components.fitnessVector);
    const lineage = deserializeLineage(payload.components.lineage);

    // Lineage is keyed by id so a consumer never has to assume the two
    // components are in the same order — they are, but that is a property of
    // the producer, not of the format.
    const originById = new Map();
    for (let k = 0; k < lineage.individuals.length; k += 1) {
      const row = lineage.individuals[k];
      originById.set(row.individualId, {
        origin: row.origin, parentIndividualId: row.parentIndividualId,
      });
    }

    let genotypeDigestById = null;
    if (includeGenotypeDigest) {
      genotypeDigestById = new Map();
      const snapshot = deserializePopulationSnapshot(payload.components.population);
      for (let k = 0; k < snapshot.individuals.length; k += 1) {
        const m = snapshot.individuals[k];
        genotypeDigestById.set(m.individualId, bytesToHex(serializeGenotype(m.genotype)));
      }
    }

    const individuals = [];
    for (let k = 0; k < vector.individuals.length; k += 1) {
      const row = vector.individuals[k];
      const provenance = originById.get(row.individualId);
      if (provenance === undefined) {
        evolutionFail('malformedHistory',
          `generation ${payload.generationIndex} individual ${row.individualId} is scored but absent from the lineage`,
          { generationIndex: payload.generationIndex, individualId: row.individualId });
      }
      individuals.push(Object.freeze({
        individualId: row.individualId,
        valid: row.valid,
        integrityStatus: row.integrityStatus,
        fitness: row.fitness,
        // The v3 payload, verbatim. No derived flag, no classification: a
        // reader that wants "is this alert-bearing" applies its own rule to
        // `firstAlertStep`, and the rule stays where the decision lives.
        observations: row.integrityObservations,
        origin: provenance.origin,
        parentIndividualId: provenance.parentIndividualId,
        genotypeDigest: genotypeDigestById === null
          ? null : genotypeDigestById.get(row.individualId) ?? null,
      }));
    }

    generations.push(Object.freeze({
      generationIndex: payload.generationIndex,
      terminalReason: payload.terminalReason,
      // Carried per generation because the onset steps are only interpretable
      // against it, and because each generation persists its own.
      executedSteps: metadata.executedSteps,
      effectiveDt: metadata.effectiveDt,
      worldMode: metadata.worldMode,
      individuals: Object.freeze(individuals),
    }));
  }

  return Object.freeze({
    schema: HISTORY_OBSERVATIONS_SCHEMA,
    fitnessVectorVersion: verified.records.length === 0
      ? null : verified.records[0].fitnessVector.versions.declared.fitnessVectorVersion,
    historyDigest: bytesToHex(verified.historyDigestBytes),
    headerDigest: bytesToHex(framing.headerDigestBytes),
    populationSize: verified.header.populationSize,
    mutationProbability: verified.header.mutationProbability,
    mutationMagnitude: verified.header.mutationMagnitude,
    rapierVersion: verified.header.rapierVersion,
    finalTerminalReason: verified.finalTerminalReason,
    generations: Object.freeze(generations),
  });
}
