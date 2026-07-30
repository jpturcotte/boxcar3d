// TEST-ONLY CONSISTENCY-FORGERY TOOLING.
//
// `reforge` rebuilds a complete, internally self-consistent history artifact
// after mutating the decoded header, the raw header bytes, and/or decoded
// generation records: every component digest, generation digest, chain link
// and the whole-history digest is recomputed, so the result passes framing,
// component-digest, chain and whole-history verification and can only fail at
// the deliberately targeted later gate (local coherence, semantics, capacity,
// runtime identity or replay).
//
// This is NEVER authenticity tooling. A reforged artifact is self-consistent,
// not genuine: it establishes neither freshness, nor provenance, nor runtime
// identity, nor physics authenticity. Do not use it to make persisted bytes
// appear trustworthy outside a test.

import {
  COMPONENT_KINDS,
  assembleHistory,
  decodeEvolutionHeader,
  decodeGenerationPayload,
  decodeHistoryFraming,
  digestComponent,
  digestGeneration,
  digestHeader,
  encodeEvolutionHeader,
  encodeGenerationPayload,
} from '../../src/sim/evolution-history.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from '../../src/sim/fnv1a.js';
import {
  deserializeFitnessVector, serializeFitnessVector,
} from '../../src/sim/population-evaluation.js';

/**
 * Rebuild a complete, self-consistent artifact after mutating the header
 * and/or generations' decoded components. Every downstream digest is
 * recomputed, so the result passes verification and can only fail at a
 * later gate.
 *
 * - `mutateHeader(decodedHeader)` returns the replacement decoded header,
 *   re-encoded before anything downstream is computed.
 * - `mutateHeaderBytes(headerBytes)` rewrites the raw (copied) header byte
 *   buffer in place — applied after any decoded-header mutation.
 * - `mutateRecord(record, recordIndex)` rewrites a decoded record in place
 *   (`record.components[kind]` per component kind). `recordIndex` is the
 *   ordinal position in the record sequence — deliberately NOT asserted to
 *   equal `record.generationIndex`, so tests forging generation numbering
 *   can target by either.
 */
export async function reforge(bytes, { mutateHeader, mutateHeaderBytes, mutateRecord } = {}) {
  const framing = decodeHistoryFraming(bytes);
  let headerBytes = framing.headerBytes;
  if (mutateHeader) {
    const decoded = decodeEvolutionHeader(framing.headerBytes);
    headerBytes = encodeEvolutionHeader(mutateHeader({ ...decoded }));
  }
  if (mutateHeaderBytes) {
    headerBytes = new Uint8Array(headerBytes);
    mutateHeaderBytes(headerBytes);
  }
  const headerDigestBytes = await digestHeader(headerBytes);
  const generations = [];
  let previous = headerDigestBytes;
  for (let i = 0; i < framing.generations.length; i += 1) {
    const payload = decodeGenerationPayload(framing.generations[i].payloadBytes);
    const record = {
      generationIndex: payload.generationIndex,
      terminalReason: payload.terminalReason,
      components: { ...payload.components },
    };
    if (mutateRecord) mutateRecord(record, i);
    const digests = {};
    for (const kind of COMPONENT_KINDS) digests[kind] = await digestComponent(kind, record.components[kind]);
    const payloadBytes = encodeGenerationPayload(record, digests);
    const generationDigestBytes = await digestGeneration(previous, payloadBytes);
    previous = generationDigestBytes;
    generations.push({ payloadBytes, generationDigestBytes });
  }
  return (await assembleHistory({ headerBytes, headerDigestBytes, generations })).bytes;
}

/**
 * Copy `bytes` with its leading u16 replaced — the nested-version tweaker the
 * adversarial suites share. A stale component version must stay READABLE so
 * the artifact reaches the compatibility gate rather than the decoder.
 */
export function withLeadingU16(bytes, value) {
  const copy = new Uint8Array(bytes);
  new DataView(copy.buffer).setUint16(0, value, true);
  return copy;
}

/**
 * Copy `bytes` with one byte XORed at `offset` — the minimal content forgery
 * the adversarial suites share. Pair with `reforge` (digests recomputed) so
 * the artifact stays self-consistent and only the targeted gate can fire.
 */
export function flipByte(bytes, offset = 0) {
  const copy = new Uint8Array(bytes);
  copy[offset] ^= 0xff;
  return copy;
}

/**
 * Re-attest a record's fitness-vector population FNV state after its
 * population component was rewritten, so the forged population keeps passing
 * the stage-11 population/vector coherence bind and fails only at a later
 * gate (e.g. PR 4C transition authentication). NEVER authenticity tooling —
 * see the header.
 */
export function rebindFitnessVectorToPopulation(record) {
  const vector = deserializeFitnessVector(record.components.fitnessVector);
  record.components.fitnessVector = serializeFitnessVector({
    populationSnapshotDigestState: fnv1aFold(
      FNV_OFFSET_BASIS, record.components.population,
    ),
    evaluationSpecDigestState: vector.evaluationSpecDigestState,
    individuals: vector.individuals,
  });
}
