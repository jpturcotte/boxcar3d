// THE DETERMINISTIC N -> N+1 TRANSITION KERNEL (PR 4A).
//
// One narrow internal seam: given the current generation's decoded population,
// its decoded selection pool, the run seed, the mutation policy, the next
// fresh individual id and the generation index — all MODULE-OWNED values —
// derive the next generation's canonical population bytes and lineage bytes.
// This is a behavior-preserving extraction of what was evolution-run.js's
// private deriveNextGeneration: elite order and tie-breaking, elite count,
// tournament size and replacement sampling, the per-child RNG fork keyed by
// the FRESH child id, draw order, mutation probability/magnitude semantics,
// field-walk order, repair timing, accounting retention, fresh-ID allocation,
// origin and parent values, member and row order, serialization order, the
// immediate population decode, and the lineage decode + cross-check are all
// exactly what the embedded implementation did.
//
// PLACEMENT. This module sits BELOW both run orchestration (evolution-run.js)
// and replay verification (evolution-replay.js) in the dependency graph: it
// imports only the lower-level deterministic primitives it composes — the
// RNG, the selection and mutation operators, the population and lineage
// codecs, the error taxonomy — and nothing above: no run, no replay, no
// offline scripts, no UI, no runtime identity, no physics orchestration. That
// is what lets the future PR 4B verified-artifact path reproduce persisted
// transitions against the SAME kernel the producer uses, without a cycle. The
// closure is pinned in tests/evolution-transition.test.js.
//
// THIS IS NOT A PUBLIC SEAM. An ES-module export from this file is an
// internal repository boundary, never part of BoxCar3D's public run API. The
// one authorized production importer today is evolution-run.js; PR 4B will
// deliberately add evolution-replay.js when the verified-artifact path starts
// reproducing persisted adjacent transitions. That allowlist is DECLARED and
// pinned in tests/evolution-transition.test.js over every reference form, so
// an accidental re-export or a second production importer fails a build. The
// function still accepts module-owned values only: it never pairs an
// independently supplied population with an independently supplied fitness
// artifact (evolution-run.js's FNV sentinel ruling is unchanged by the move).
//
// TRACE EXCLUSION. This module imports no trace module, and the record
// geometry it produces cannot carry one (the PR 3 Commit 0 policy, pinned
// statically and at runtime in tests/evolution-run.test.js).

import { Rng } from './prng.js';
import {
  mutateContinuousGenotype, selectElites, selectTournamentParent,
} from './evolution-operators.js';
import {
  POPULATION_SNAPSHOT_VERSION, deserializePopulationSnapshot, serializePopulationSnapshot,
} from './population.js';
import {
  EVOLUTION_LINEAGE_VERSION, crossCheckLineage, deserializeLineage,
  serializeLineage, zeroLineageAccounting,
} from './evolution-lineage.js';
import { evolutionFail } from './evolution-contract.js';

/** The ascending id list of a decoded population (module-owned throughout). */
function populationIds(population) {
  const out = [];
  const individuals = population.individuals;
  const count = individuals.length;
  for (let i = 0; i < count; i += 1) out.push(individuals[i].individualId);
  return out;
}

/**
 * The internal, same-source generation transition. It is a free function
 * taking only module-owned values so that its inputs are visibly incapable of
 * pairing a caller's population with a caller's fitness.
 *
 * Returns the next generation's canonical population bytes and lineage bytes.
 * The caller has already decided the run is non-terminal.
 */
export function deriveNextGeneration({
  population, pool, seed, mutation, baseIndividualId, generationIndex,
}) {
  const currentIds = populationIds(population);
  const size = currentIds.length;
  // ELITES FIRST, in the order selectElites returns (canonical fitness rank).
  // Each elite receives a FRESH id; its previous id survives only as lineage.
  // Reusing an elite's id would collide two generations' RNG stream ids, which
  // is the whole reason ids are never recycled.
  const elites = selectElites(population, pool);
  const eliteCount = elites.length;
  const individuals = [];
  const lineageRows = [];
  const zero = zeroLineageAccounting();
  for (let slot = 0; slot < size; slot += 1) {
    const childId = baseIndividualId + slot;
    if (slot < eliteCount) {
      const elite = elites[slot];
      individuals.push({ individualId: childId, genotype: elite.genotype });
      lineageRows.push({
        individualId: childId,
        parentIndividualId: elite.individualId,
        origin: 'eliteCopy',
        accounting: zero,
      });
      continue;
    }
    // Every child derives its OWN stream from the run seed and its OWN id.
    // There is no generation-global RNG: evaluation order, array order,
    // diagnostics, wall clock, worker count, an exception after a draft, and
    // draws made by any sibling cannot reach this stream.
    const childRng = new Rng(seed).fork(childId);
    const parentId = selectTournamentParent(pool, childRng);
    if (parentId === null) {
      // Unreachable: a non-terminal transition has a non-empty pool. Kept as a
      // loud refusal rather than an assumption, because a null here would
      // otherwise surface as an opaque lookup failure two lines down.
      evolutionFail('malformedHistory', 'tournament returned no parent from a non-empty selectable pool', { childId });
    }
    let parentGenotype = null;
    for (let i = 0; i < size; i += 1) {
      if (population.individuals[i].individualId === parentId) {
        parentGenotype = population.individuals[i].genotype;
        break;
      }
    }
    if (parentGenotype === null) {
      evolutionFail('malformedHistory', `tournament selected id ${parentId}, which is not in generation ${generationIndex}`, { parentId, generationIndex });
    }
    const mutated = mutateContinuousGenotype(parentGenotype, childRng, mutation);
    // `mutated.rawGenotype` is diagnostic-only and is deliberately dropped
    // here: it never enters run state, a lineage row, or a persisted record.
    individuals.push({ individualId: childId, genotype: mutated.genotype });
    lineageRows.push({
      individualId: childId,
      parentIndividualId: parentId,
      origin: 'continuousMutation',
      accounting: mutated.accounting,
    });
  }
  const nextGenerationIndex = generationIndex + 1;
  const nextPopulation = { snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals };
  const populationBytes = serializePopulationSnapshot(nextPopulation);
  // Decode what was just encoded: the pending state must be re-decodable
  // canonical bytes, proven now rather than discovered at the next advance.
  const decoded = deserializePopulationSnapshot(populationBytes);
  const lineage = {
    lineageVersion: EVOLUTION_LINEAGE_VERSION,
    generationIndex: nextGenerationIndex,
    individuals: lineageRows,
  };
  const lineageBytes = serializeLineage(lineage);
  crossCheckLineage(deserializeLineage(lineageBytes), nextGenerationIndex, populationIds(decoded), currentIds);
  return { populationBytes, lineageBytes };
}
