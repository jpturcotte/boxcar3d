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
import { createByteReader, typedArrayByteLength } from './bytes.js';

export const POPULATION_SNAPSHOT_VERSION = 1;

function fail(path, value) {
  throw new Error(`population: invalid population at ${path} (${String(value)})`);
}

// The canonical uint32 predicate, shared by every wire field in this family.
// `-0` is REJECTED: Number.isInteger(-0) is true and -0 >= 0 is true, so the
// naive form admitted it, and setUint32 then erased the sign bit — which made
// `deserialize(serialize(x))` NOT leaf-equal under Object.is on that field,
// contradicting the codec's stated round-trip invariant. No producer in this
// repo emits -0 for a count, an id, a seed, or a digest state, so no valid
// stream changes; a hand-built -0 now fails loud instead of silently
// normalizing. (f64 GENE leaves are a different contract: there -0 is a legal
// value, preserved bit-exactly, and must NOT be rejected.)
export function isCanonicalUint32(v) {
  return Number.isInteger(v) && v >= 0 && v <= 0xffffffff && !Object.is(v, -0);
}

/**
 * Byte equality over the INTRINSIC geometry. Both the length compare and the
 * loop bound formerly read `a.length` / `b.length` — an inherited accessor on
 * %TypedArray%.prototype that an own data property shadows on a genuine
 * Uint8Array — so two arrays whose real content differs compared EQUAL and
 * this module's canonicality tooth would have accepted a non-canonical
 * genotype. Silent, from the one comparison the population layer exists to
 * make. Measured: deadbeef vs dead0000 under an own `length: 2` returned true.
 */
export function bytesEqual(a, b) {
  const aLen = typedArrayByteLength(a);
  const bLen = typedArrayByteLength(b);
  if (aLen !== bLen) return false;
  for (let i = 0; i < aLen; i += 1) if (a[i] !== b[i]) return false;
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
  // The diagnostic prints the value that was REJECTED. Re-reading the caller
  // inside the message let a version accessor be rejected as 7 and reported as
  // 4242 — a report naming a value no check ever saw. Cheap, and it is the
  // standard this repo already states for resolveSpec's error text.
  const snapshotVersion = population.snapshotVersion;
  if (snapshotVersion !== POPULATION_SNAPSHOT_VERSION) fail('snapshotVersion', snapshotVersion);
  const individuals = population.individuals;
  if (!Array.isArray(individuals) || individuals.length === 0) fail('individuals', individuals);
  // CAPTURE THE BOUND before the walk: the body calls serializeGenotype on a
  // caller-owned genotype, so caller code runs between two readings of
  // `individuals.length`, and Array length is writable. Measured (round-11): a
  // member accessor assigning `individuals.length = 3` made attestPopulation
  // return a silent PREFIX — 4 members in, 3 attested, 1476 bytes instead of
  // 1752 — that re-decodes cleanly.
  const count = individuals.length;
  const seen = new Set();
  const members = [];
  for (let i = 0; i < count; i += 1) {
    const ind = individuals[i];
    if (typeof ind !== 'object' || ind === null) fail(`individuals[${i}]`, ind);
    // CAPTURE ONCE, then never touch the caller's property again. `ind` is a
    // caller object and `individualId` may be an own ACCESSOR — ordinary
    // JavaScript, not a Proxy — so every extra read is an independent chance to
    // return a different value. The earlier shape read it five times (validate,
    // duplicate-check, Set insert, error text, sort) and both consumers read it
    // a sixth and seventh time off the stored `individual`. Measured: one member
    // whose getter walked 0,0,0,7,9 was VALIDATED as id 0, ENCODED as id 7, and
    // RETURNED by attestPopulation as id 9 — three identities for one member,
    // defeating precisely the attestation this walk exists to provide.
    const individualId = ind.individualId;
    const genotype = ind.genotype;
    if (!isCanonicalUint32(individualId)) fail(`individuals[${i}].individualId`, individualId);
    if (seen.has(individualId)) fail(`individuals[${i}].individualId`, `duplicate ${individualId}`);
    seen.add(individualId);
    // serializeGenotype runs validateGenotype (structure + gene domains);
    // byte-comparing against the repaired form is the canonicality tooth.
    // Default assembly options define the canonical form (the whole Phase 1A
    // pipeline compiles with defaults).
    //
    // The caller's genotype is walked EXACTLY ONCE, by the first serialize.
    // Everything after that — the repair, the comparison, the snapshot, the
    // attestation — runs on `owned`, decoded from those very bytes. Passing
    // the caller's object to BOTH serialize calls meant the tooth compared one
    // reading against the repair of a SECOND reading, so a genotype whose
    // leaves differed between walks could be judged canonical on evidence that
    // never described a single genotype. Round-trip identity
    // (serialize∘deserialize = identity) is what makes this substitution
    // byte-neutral, so the codec's own contract is load-bearing here.
    const bytes = serializeGenotype(genotype);
    const owned = deserializeGenotype(bytes);
    const repairedBytes = serializeGenotype(repairGenotype(owned));
    if (!bytesEqual(bytes, repairedBytes)) {
      throw new Error(`population: individuals[${i}] (individualId ${individualId}) is not canonical — `
        + 'repair moved it; populations must carry repaired genotypes (compileAssembly(...).genotype)');
    }
    members.push({
      individual: ind, individualId, bytes, genotype: owned,
    });
  }
  // Sorting, encoding, attestation and every later diagnostic use the CAPTURED
  // scalar. `individual` is retained only so validatePopulation can hand the
  // caller's own records back; nothing downstream reads an id through it.
  return members.sort((a, b) => a.individualId - b.individualId);
}

/**
 * Validate and canonically order a population.
 *
 * OWNERSHIP, stated because it is a deliberate exception: the returned array
 * is this module's, but the INDIVIDUALS in it are the caller's own objects,
 * not copies. That is correct for a gate — callers legitimately want their own
 * records back in canonical order, and deep-copying every genotype on every
 * validation would be pure cost. It also means this function attests NOTHING:
 * a second read of `ind.genotype` afterwards is a second read of caller data.
 * Anything that must bind what it validated calls `attestPopulation` below,
 * which hands back module-owned genotypes decoded from the very bytes it
 * attested. Gate vs attestation is the distinction; do not blur it.
 */
export function validatePopulation(population) {
  const members = validatedMembers(population);
  const sorted = [];
  for (let i = 0; i < members.length; i += 1) sorted.push(members[i].individual);
  return sorted;
}

// The byte walk, over members the validation pass already approved. Split out
// so the snapshot encoder and the attestation below emit the SAME bytes from
// the SAME walk rather than two calls that could read the caller twice.
function encodeMembers(members) {
  let payload = 0;
  for (let i = 0; i < members.length; i += 1) payload += 4 + 4 + members[i].bytes.length;
  const view = new DataView(new ArrayBuffer(2 + 2 + 4 + payload));
  // receiver `view` is the module-owned DataView allocated above, not caller data.
  // eslint-disable-next-line no-restricted-syntax
  const out = new Uint8Array(view.buffer);
  let o = 0;
  view.setUint16(o, POPULATION_SNAPSHOT_VERSION, true); o += 2;
  view.setUint16(o, GENOTYPE_VERSION, true); o += 2;
  view.setUint32(o, members.length, true); o += 4;
  for (let i = 0; i < members.length; i += 1) {
    view.setUint32(o, members[i].individualId, true); o += 4;
    view.setUint32(o, members[i].bytes.length, true); o += 4;
    out.set(members[i].bytes, o); o += members[i].bytes.length;
  }
  return out;
}

/** Serialize canonical population content (see the encoding walk above). */
export function serializePopulationSnapshot(population) {
  // The encoder consumes the tooth-checked bytes from the validation walk —
  // it never re-reads `ind.genotype` after validation, so no code running
  // between (or during) the two can substitute a member the tooth approved.
  return encodeMembers(validatedMembers(population));
}

/**
 * ONE walk that produces the canonical bytes AND the members those bytes
 * describe, with every genotype MODULE-OWNED: each is decoded from the exact
 * stream the canonicality tooth approved, so "what was compiled" and "what was
 * attested" are the same object by construction rather than by two reads
 * happening to agree.
 *
 * The evaluator used to call `validatePopulation(population)`, compile from
 * `ind.genotype`, and then call `serializePopulationSnapshot(population)` —
 * four independent reads of the caller's records for one attestation. Nothing
 * ran between them, so plain data could not diverge; but the fitness vector's
 * digest claimed to bind the population that was EVALUATED, and what it
 * actually bound was whatever the last read returned. Decoding from the
 * attested bytes closes it at the source instead of arguing about which reads
 * are adjacent, and makes the codec's exact-inverse property load-bearing in
 * production rather than only in its own tests.
 */
export function attestPopulation(population) {
  const members = validatedMembers(population);
  const bytes = encodeMembers(members);
  const individuals = [];
  for (let i = 0; i < members.length; i += 1) {
    // The genotype decoded from the attested bytes during validation — the
    // same object the canonicality tooth judged, not a fresh decode.
    individuals.push({
      individualId: members[i].individualId,
      genotype: members[i].genotype,
    });
  }
  return { individuals, bytes };
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
 * Returned UNFROZEN, deliberately. So is `deserializeGenotype`'s record — the
 * two WORKING-OBJECT decoders. (An earlier draft of this comment claimed this
 * was "the one decoder that is", which was simply a miscount; the genotype
 * decoder's behaviour is correct and was never the thing in question.) The
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
