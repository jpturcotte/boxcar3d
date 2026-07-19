// Canonical population CONTENT and its versioned byte encoding — deliberately
// PROVENANCE-FREE. A population is nothing but stable individual identities
// plus canonical REPAIRED genotypes (the heritable truth: ir.genotype, the
// clone the repair pass produced — never a raw operator draw). How the content
// came to exist (initializer seed, config, a future mutation pipeline) is a
// separate manifest (population-initializer.js) that binds THIS module's
// digest; identical content therefore hashes identically no matter how it was
// produced, and later generations reuse this format without pretending they
// were seeded directly.
//
// Identity ruling: individualId is an explicit uint32 field on every
// individual — NEVER inferred from array position. Public seams accept
// individuals in ANY order, validate uniqueness, and canonicalize by sorting
// a COPY on individualId ascending. individualId is also the Rng fork
// streamId that produced a generation-0 individual (population-initializer),
// so it is a canonical uint32 by the same ruling as terrain seeds.
//
// Canonicality ruling: every stored genotype must be repair-IDENTICAL under
// the default assembly options (repairGenotype is byte-idempotent, so the
// canonical form is well-defined). A raw genotype that repair would move is
// rejected LOUD here — the digest must attest to what evaluation will
// actually run, and a raw draw surviving as a hereditary record is exactly
// the bug class this seam exists to stop.
//
// SNAPSHOT ENCODING v1 (explicit little-endian walk — never object key
// order; digest = fnv1aHex over these bytes):
//   u16 snapshotVersion
//   u16 genotypeVersion            (binds the serializeGenotype schema)
//   u32 individualCount            (>= 1)
//   per individual, individualId ASCENDING:
//     u32 individualId
//     u32 genotypeByteLength       (explicit length prefix — genotype streams
//                                   vary with axle count; no concatenation
//                                   ambiguity)
//     u8[] serializeGenotype bytes (the locked assembly walk)
// Changing this walk is a deliberate POPULATION_SNAPSHOT_VERSION bump.

import {
  GENOTYPE_VERSION, deserializeGenotype, repairGenotype, serializeGenotype,
} from './assembly.js';
import { createByteReader } from './bytes.js';

export const POPULATION_SNAPSHOT_VERSION = 1;

function fail(path, value) {
  throw new Error(`population: invalid population at ${path} (${String(value)})`);
}

function isCanonicalUint32(v) {
  return Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Validate population shape, ids, and genotype canonicality; return the
 * individuals as a NEW array sorted by individualId ascending (the canonical
 * order every consumer shares). The input array is never mutated. Exported:
 * the evaluator seam runs the same gate before adding its own realizability
 * checks.
 */
// The one validation walk, shared by the public gate and the encoder. Returns
// the individuals sorted by individualId ascending PLUS, per member, the exact
// canonicality-checked bytes — so the encoder can emit precisely what was
// validated. Copy BY INDEX, never by spread (spreading reads the iterator; the
// loop validates the INDEXED members — measured divergence in an earlier
// round). The bytes-threading matters for the same reason one level deeper:
// the canonicality tooth calls repairGenotype, which is caller-reachable code
// territory in the general case, so validation captures each member's bytes
// ONCE and nothing after that point re-reads `ind.genotype`. What the tooth
// approved is, by construction, what the snapshot attests. (It also halves the
// encoder's serialization work — the tooth had already produced these bytes.)
function validatedMembers(population) {
  if (typeof population !== 'object' || population === null) fail('population', population);
  if (population.snapshotVersion !== POPULATION_SNAPSHOT_VERSION) {
    fail('snapshotVersion', population.snapshotVersion);
  }
  const individuals = population.individuals;
  if (!Array.isArray(individuals) || individuals.length === 0) fail('individuals', individuals);
  const seen = new Set();
  const members = [];
  for (let i = 0; i < individuals.length; i += 1) {
    const ind = individuals[i];
    if (typeof ind !== 'object' || ind === null) fail(`individuals[${i}]`, ind);
    if (!isCanonicalUint32(ind.individualId)) fail(`individuals[${i}].individualId`, ind.individualId);
    if (seen.has(ind.individualId)) fail(`individuals[${i}].individualId`, `duplicate ${ind.individualId}`);
    seen.add(ind.individualId);
    // serializeGenotype runs validateGenotype (structure + gene domains);
    // byte-comparing against the repaired form is the canonicality tooth.
    // Default assembly options define the canonical form (the whole Phase 1A
    // pipeline compiles with defaults).
    const bytes = serializeGenotype(ind.genotype);
    const repairedBytes = serializeGenotype(repairGenotype(ind.genotype));
    if (!bytesEqual(bytes, repairedBytes)) {
      throw new Error(`population: individuals[${i}] (individualId ${ind.individualId}) is not canonical — `
        + 'repair moved it; populations must carry repaired genotypes (compileAssembly(...).genotype)');
    }
    members.push({ individual: ind, bytes });
  }
  return members.sort((a, b) => a.individual.individualId - b.individual.individualId);
}

export function validatePopulation(population) {
  const members = validatedMembers(population);
  const sorted = [];
  for (let i = 0; i < members.length; i += 1) sorted.push(members[i].individual);
  return sorted;
}

/** Serialize canonical population content (see the encoding walk above). */
export function serializePopulationSnapshot(population) {
  // The encoder consumes the tooth-checked bytes from the validation walk —
  // it never re-reads `ind.genotype` after validation, so no code running
  // between (or during) the two can substitute a member the tooth approved.
  const members = validatedMembers(population);
  const total = 2 + 2 + 4 + members.reduce((s, m) => s + 4 + 4 + m.bytes.length, 0);
  const view = new DataView(new ArrayBuffer(total));
  const out = new Uint8Array(view.buffer);
  let o = 0;
  view.setUint16(o, POPULATION_SNAPSHOT_VERSION, true); o += 2;
  view.setUint16(o, GENOTYPE_VERSION, true); o += 2;
  view.setUint32(o, members.length, true); o += 4;
  for (let i = 0; i < members.length; i += 1) {
    view.setUint32(o, members[i].individual.individualId, true); o += 4;
    view.setUint32(o, members[i].bytes.length, true); o += 4;
    out.set(members[i].bytes, o); o += members[i].bytes.length;
  }
  return out;
}

function decodeFail(path, value) {
  throw new Error(`population: invalid encoded population at ${path} (${String(value)})`);
}

/**
 * The exact inverse of serializePopulationSnapshot. Fail-loud, never
 * repairing: individual ids must be strictly ascending IN THE STREAM (the
 * canonical order — validatePopulation sorts a copy and so cannot see stream
 * order, and a decoder that silently re-sorted would break byte identity on
 * re-encode while accepting non-canonical bytes), the embedded genotype
 * streams decode through the assembly codec's own exact-length check (so a
 * lying length prefix fails), and the decoded population re-runs the full
 * validatePopulation gate — including the repair-identity canonicality
 * tooth, so a hand-crafted snapshot carrying a raw draw cannot re-enter the
 * population layer as heredity through the decode side door.
 *
 * Returned UNFROZEN, deliberately, and this is the one decoder that is. The
 * spec, fitness-vector and manifest decoders freeze, because those records are
 * attestations — a digest has already been folded over their bytes, so letting
 * a caller mutate one after the fact would let it disagree with what it
 * attests. A population is not an attestation but a live working object:
 * createInitialPopulation returns exactly this shape unfrozen (its
 * `population` field), and Phase 1B replaces individuals generation over
 * generation. Freezing here would make a decoded population a different kind
 * of thing from a produced one, which is the drift this codec exists to
 * prevent. Canonicality is enforced at the seams (validatePopulation on the
 * way in, serializePopulationSnapshot on the way out), never by immutability.
 */
export function deserializePopulationSnapshot(bytes) {
  const r = createByteReader(bytes, decodeFail);
  const snapshotVersion = r.u16('snapshotVersion');
  if (snapshotVersion !== POPULATION_SNAPSHOT_VERSION) decodeFail('snapshotVersion', snapshotVersion);
  const genotypeVersion = r.u16('genotypeVersion');
  if (genotypeVersion !== GENOTYPE_VERSION) decodeFail('genotypeVersion', genotypeVersion);
  const count = r.u32('individualCount');
  if (count < 1) decodeFail('individualCount', count);
  const individuals = [];
  let prevId = -1;
  for (let i = 0; i < count; i += 1) {
    const individualId = r.u32(`individuals[${i}].individualId`);
    if (individualId <= prevId) {
      decodeFail(`individuals[${i}].individualId`,
        `${individualId} must be strictly ascending (previous ${prevId})`);
    }
    prevId = individualId;
    const length = r.u32(`individuals[${i}].genotypeByteLength`);
    const genotype = deserializeGenotype(r.bytes(length, `individuals[${i}].genotype`));
    individuals.push({ individualId, genotype });
  }
  r.expectEnd('individuals');
  const population = { snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals };
  validatePopulation(population);
  return population;
}
