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
  captureExpectedIdentity, checkExpectedIdentity, checkFitnessVectorCompatibility,
  verifyFitnessVectorMetadataCoherence, verifyFitnessVectorSpecBinding,
  verifyHistoryArtifact,
} from '../src/sim/evolution-replay.js';
import { deserializeFitnessVector } from '../src/sim/population-evaluation.js';
import { deserializeLineage } from '../src/sim/evolution-lineage.js';
import { deserializePopulationSnapshot } from '../src/sim/population.js';
import { evolutionFail } from '../src/sim/evolution-contract.js';
import { bytesToHex, copyOrdinaryBytes } from '../src/sim/bytes.js';
import { serializeGenotype } from '../src/sim/assembly.js';
import { sha256 } from '../src/platform/sha256.js';

export const HISTORY_OBSERVATIONS_SCHEMA = 'boxcar3d.history-observations/1';

const bytesFail = (path, value) => {
  evolutionFail('malformedHistory',
    `history-observations: historyBytes are not ordinary canonical bytes at ${path} (${String(value)})`,
    { path });
};

// A caller's OPTION bytes are a different fault class from the ARTIFACT's
// bytes: 'your argument is wrong', not 'the file is wrong'. The evolution
// taxonomy already draws that line — `resumeEvolutionRun` reports
// `invalidConfig` for a malformed expected digest — and a seam that reported
// `malformedHistory` here would send a caller to inspect a file that is fine.
const optionBytesFail = (path, value) => {
  evolutionFail('invalidConfig',
    `history-observations: expectedHistoryDigestBytes are not ordinary canonical bytes at ${path} (${String(value)})`,
    { path });
};

const DECLARED_OPTIONS = ['expectedHistoryDigestBytes', 'expectedGenerationIndex', 'includeGenotypeDigest'];

/**
 * A scored individual with no genome in its own generation's population is
 * MALFORMED HISTORY, never a `null` digest.
 *
 * `?? null` here read as "no digest available" and returned a row that looks
 * like ordinary missing-optional-data, for an artifact whose fitness vector
 * scores an individual the population does not contain. Measured before the
 * fix: `scored id 5 -> genotypeDigest null`, with no error anywhere.
 *
 * UNREACHABLE, AND SAID SO PLAINLY. The pre-physics id-set gate now refuses
 * that artifact before this runs, so no committed test can redden by deleting
 * this function — a sabotage pass restoring `?? null` left the suite green.
 * That makes this DEFENCE IN DEPTH against a future format change that adds a
 * legitimate way for the two components to disagree, not an enforced
 * guarantee. The enforced one is the gate, and it is tested.
 */
function requireGenotypeDigest(digestById, individualId, generationIndex) {
  const digest = digestById.get(individualId);
  if (digest === undefined) {
    evolutionFail('malformedHistory',
      `generation ${generationIndex} individual ${individualId} is scored but absent from the population`,
      { generationIndex, individualId });
  }
  return digest;
}

/**
 * Validate and own the caller's options, in one synchronous pass.
 *
 * The freshness subset is delegated to `captureExpectedIdentity` rather than
 * hand-built, which is what keeps this seam's promise to share resume's
 * checks rather than reinterpret them: unknown-key refusal, the 32-byte
 * length check, the canonical-uint32 generation index and the `invalidConfig`
 * code all come from that one function. Hand-building the record silently
 * dropped `expectedGenerationIndex` — turning a freshness check OFF with no
 * error — and misrouted two failure classes.
 */
function captureOptions(options) {
  const copy = (b) => copyOrdinaryBytes(b, optionBytesFail);
  if (options === undefined || options === null) {
    return { identity: captureExpectedIdentity(null, copy), includeGenotypeDigest: false };
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    evolutionFail('invalidConfig', 'history-observations options must be a plain object', {});
  }
  const proto = Object.getPrototypeOf(options);
  if (proto !== Object.prototype && proto !== null) {
    evolutionFail('invalidConfig', 'history-observations options must be a plain object', {});
  }
  const keys = Object.keys(options);
  if (Object.getOwnPropertyNames(options).length !== keys.length) {
    evolutionFail('invalidConfig', 'history-observations options carry non-enumerable own properties', {});
  }
  const identityOptions = {};
  let includeGenotypeDigest = false;
  let sawInclude = false;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!DECLARED_OPTIONS.includes(key)) {
      evolutionFail('invalidConfig', `history-observations option '${key}' is not a known key`, { key });
    }
    const value = options[key]; // ONE read per key
    if (key === 'includeGenotypeDigest') {
      sawInclude = true;
      includeGenotypeDigest = value;
    } else {
      identityOptions[key] = value;
    }
  }
  if (sawInclude && includeGenotypeDigest !== true && includeGenotypeDigest !== false) {
    evolutionFail('invalidConfig',
      `includeGenotypeDigest must be true or false (${String(includeGenotypeDigest)})`, {});
  }
  return {
    identity: captureExpectedIdentity(identityOptions, copy),
    includeGenotypeDigest: sawInclude ? includeGenotypeDigest : false,
  };
}

/**
 * Decode the per-individual integrity evidence out of a VERIFIED evolution
 * history.
 *
 * `expectedHistoryDigestBytes` and `expectedGenerationIndex` are the caller's
 * externally-held freshness claims, passed through to the same stage-8 check
 * resume uses: a valid but OLDER artifact verifies perfectly, so staleness can
 * only ever be detected against something the caller knows and the file does
 * not.
 *
 * `includeGenotypeDigest` attaches each member's genotype digest: the
 * **SHA-256 of the canonical serialized genotype bytes, as 64 lowercase
 * hexadecimal characters**. It is off by default because it costs a
 * serialization and a hash per member, and on when a consumer needs to count
 * distinct INDIVIDUALS: elitism gives a surviving individual a fresh id every
 * generation, so neither id nor fitness identifies a genome across
 * generations. Fitness in particular is a proxy that silently merges two
 * different vehicles — PR #26 shipped a summary field that did exactly that.
 *
 * SHA-256 rather than FNV-1a32 by this repository's standing ruling: FNV is a
 * drift/lock digest and an in-process mismatch sentinel, while this is durable
 * content identity for offline analysis, where a cheap 32-bit collision would
 * silently merge two genomes exactly as the fitness proxy did.
 *
 * NOT an `async function`, deliberately, and the same ruling `sha256` and
 * `resumeEvolutionRun` are written under: every caller-owned input is
 * validated and COPIED in a synchronous prologue, so copy-before-await is
 * structural rather than a line anyone has to keep in the right order. An
 * `async function` would let a caller mutate its own buffer — or its options —
 * while verification is in flight, and a bad argument would arrive as a
 * rejected promise instead of a throw.
 */
export function extractHistoryObservations(historyBytes, options = {}) {
  const owned = copyOrdinaryBytes(historyBytes, bytesFail);
  const intake = captureOptions(options);
  return extractFromOwned(owned, intake);
}

async function extractFromOwned(owned, intake) {
  const { identity, includeGenotypeDigest } = intake;
  // Stages 3-7, then the two pre-physics gates. Same functions, same codes.
  const verified = await verifyHistoryArtifact(owned);
  checkExpectedIdentity(verified, identity);
  checkFitnessVectorCompatibility(verified);
  verifyFitnessVectorMetadataCoherence(verified);
  // Gate C too. This seam runs none of resume's header-validity checks — it
  // never executes the spec — so there is no earlier diagnosis for it to
  // preempt here, and a vector bound to a different specification is exactly
  // the kind of incoherence an evidence reader must refuse rather than report.
  verifyFitnessVectorSpecBinding(verified);

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
        // SHA-256 of the canonical serialized genotype bytes, as 64 lowercase
        // hex characters. The bytes are module-owned (serializeGenotype
        // returns a fresh array) and are handed to sha256, which validates and
        // COPIES them in a synchronous prologue — so nothing a caller holds is
        // read across this await.
        //
        // An earlier draft stored bytesToHex(serializeGenotype(...)): the
        // WHOLE canonical stream as hex, ~1-2 KB per individual, under a name
        // that says "digest". At campaign scale that is the dominant cost of
        // the extraction output, and the name actively misleads.
        genotypeDigestById.set(m.individualId,
          bytesToHex(await sha256(serializeGenotype(m.genotype))));
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
          ? null : requireGenotypeDigest(genotypeDigestById, row.individualId, payload.generationIndex),
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
