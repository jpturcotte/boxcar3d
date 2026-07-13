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

import { GENOTYPE_VERSION, repairGenotype, serializeGenotype } from './assembly.js';

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
export function validatePopulation(population) {
  if (typeof population !== 'object' || population === null) fail('population', population);
  if (population.snapshotVersion !== POPULATION_SNAPSHOT_VERSION) {
    fail('snapshotVersion', population.snapshotVersion);
  }
  const individuals = population.individuals;
  if (!Array.isArray(individuals) || individuals.length === 0) fail('individuals', individuals);
  const seen = new Set();
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
  }
  return [...individuals].sort((a, b) => a.individualId - b.individualId);
}

/** Serialize canonical population content (see the encoding walk above). */
export function serializePopulationSnapshot(population) {
  const sorted = validatePopulation(population);
  const genotypeBytes = sorted.map((ind) => serializeGenotype(ind.genotype));
  const total = 2 + 2 + 4 + genotypeBytes.reduce((s, g) => s + 4 + 4 + g.length, 0);
  const view = new DataView(new ArrayBuffer(total));
  const out = new Uint8Array(view.buffer);
  let o = 0;
  view.setUint16(o, POPULATION_SNAPSHOT_VERSION, true); o += 2;
  view.setUint16(o, GENOTYPE_VERSION, true); o += 2;
  view.setUint32(o, sorted.length, true); o += 4;
  for (let i = 0; i < sorted.length; i += 1) {
    view.setUint32(o, sorted[i].individualId, true); o += 4;
    view.setUint32(o, genotypeBytes[i].length, true); o += 4;
    out.set(genotypeBytes[i], o); o += genotypeBytes[i].length;
  }
  return out;
}
