// Pure Phase-1B selection and parametric-mutation operators. This module
// deliberately creates neither generations nor child identities.

import {
  deserializeGenotype, forEachGenotypeField, repairGenotype, serializeGenotype,
} from './assembly.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from './fnv1a.js';
import { attestPopulation, isCanonicalUint32, POPULATION_SNAPSHOT_VERSION } from './population.js';
import { FITNESS_POLICY_VERSION, SELECTION_POOL_VERSION } from './population-evaluation.js';

export { SELECTION_POOL_VERSION } from './population-evaluation.js';

export const TOURNAMENT_SELECTION_VERSION = 1;
export const ELITISM_VERSION = 1;
export const PARAMETRIC_MUTATION_VERSION = 1;
export const TOURNAMENT_SIZE = 3;
export const ELITE_COUNT = 2;
export const PARAMETRIC_MUTATION_DEFAULTS = Object.freeze({ probability: 0.05, magnitude: 0.05 });

function fail(path, value) {
  throw new Error(`evolution-operators: invalid ${path} (${String(value)})`);
}

function canonicalFitness(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// One private capture for every pool consumer. It owns all scalar values
// before an operator makes a selection or touches its RNG.
function capturePool(pool) {
  if (typeof pool !== 'object' || pool === null) fail('selection pool', pool);
  const selectionPoolVersion = pool.selectionPoolVersion;
  const fitnessPolicyVersion = pool.fitnessPolicyVersion;
  const populationSnapshotDigestState = pool.populationSnapshotDigestState;
  const evaluatedIndividualIds = pool.evaluatedIndividualIds;
  if (selectionPoolVersion !== SELECTION_POOL_VERSION) fail('selectionPoolVersion', selectionPoolVersion);
  if (fitnessPolicyVersion !== FITNESS_POLICY_VERSION) fail('fitnessPolicyVersion', fitnessPolicyVersion);
  if (!isCanonicalUint32(populationSnapshotDigestState)) fail('populationSnapshotDigestState', populationSnapshotDigestState);
  if (!Array.isArray(evaluatedIndividualIds)) fail('evaluatedIndividualIds', evaluatedIndividualIds);
  const evaluatedCount = evaluatedIndividualIds.length;
  if (evaluatedCount === 0) fail('evaluatedIndividualIds', evaluatedIndividualIds);
  const ids = [];
  let previous = -1;
  for (let i = 0; i < evaluatedCount; i += 1) {
    const id = evaluatedIndividualIds[i];
    if (!isCanonicalUint32(id) || id <= previous) fail(`evaluatedIndividualIds[${i}]`, id);
    ids.push(id);
    previous = id;
  }
  const individuals = pool.individuals;
  if (!Array.isArray(individuals)) fail('individuals', individuals);
  const selectedCount = individuals.length;
  const selected = [];
  let selectedPrevious = -1;
  let sourceAt = 0;
  for (let i = 0; i < selectedCount; i += 1) {
    const row = individuals[i];
    if (typeof row !== 'object' || row === null) fail(`individuals[${i}]`, row);
    const individualId = row.individualId;
    const fitness = row.fitness;
    if (!isCanonicalUint32(individualId) || individualId <= selectedPrevious) {
      fail(`individuals[${i}].individualId`, individualId);
    }
    if (!canonicalFitness(fitness)) fail(`individuals[${i}].fitness`, fitness);
    while (sourceAt < evaluatedCount && ids[sourceAt] < individualId) sourceAt += 1;
    if (sourceAt === evaluatedCount || ids[sourceAt] !== individualId) {
      fail(`individuals[${i}].individualId`, `${individualId} is not an evaluated id`);
    }
    selected.push({ individualId, fitness });
    selectedPrevious = individualId;
  }
  return { populationSnapshotDigestState, evaluatedIndividualIds: ids, individuals: selected };
}

function higherFitnessThenLowerId(a, b) {
  return a.fitness > b.fitness || (a.fitness === b.fitness && a.individualId < b.individualId);
}

function captureNextUint32(rng) {
  if (typeof rng !== 'object' || rng === null) fail('rng', rng);
  const nextUint32 = rng.nextUint32;
  if (typeof nextUint32 !== 'function') fail('rng.nextUint32', nextUint32);
  return nextUint32;
}

function nextCanonicalUint32(rng, nextUint32, draw) {
  const value = nextUint32.call(rng);
  if (!isCanonicalUint32(value)) fail(`rng.nextUint32 draw ${draw}`, value);
  return value;
}

/** Select the best of exactly three replacement samples, or null if empty. */
export function selectTournamentParent(pool, rng) {
  const captured = capturePool(pool);
  const count = captured.individuals.length;
  if (count === 0) return null;
  const nextUint32 = captureNextUint32(rng);
  let winner = null;
  for (let i = 0; i < TOURNAMENT_SIZE; i += 1) {
    const draw = nextCanonicalUint32(rng, nextUint32, i + 1);
    const candidate = captured.individuals[draw % count];
    if (winner === null || higherFitnessThenLowerId(candidate, winner)) winner = candidate;
  }
  return winner.individualId;
}

/** Return at most two owned, canonical population members ranked by the pool. */
export function selectElites(population, pool) {
  const captured = capturePool(pool);
  const attested = attestPopulation(population);
  const state = fnv1aFold(FNV_OFFSET_BASIS, attested.bytes);
  if (state !== captured.populationSnapshotDigestState) {
    throw new Error('evolution-operators: population digest mismatch (FNV is an in-process mismatch sentinel, not cryptographic identity or equality)');
  }
  const members = attested.individuals;
  if (members.length !== captured.evaluatedIndividualIds.length) {
    fail('population/evaluatedIndividualIds', 'id mismatch');
  }
  for (let i = 0; i < members.length; i += 1) {
    if (members[i].individualId !== captured.evaluatedIndividualIds[i]) {
      fail('population/evaluatedIndividualIds', 'id mismatch');
    }
  }
  const ranked = captured.individuals.slice();
  ranked.sort((a, b) => (higherFitnessThenLowerId(a, b) ? -1 : (higherFitnessThenLowerId(b, a) ? 1 : 0)));
  const out = [];
  for (let i = 0; i < ranked.length && i < ELITE_COUNT; i += 1) {
    const id = ranked[i].individualId;
    // Exact evaluated-id equality makes this a bounded indexed lookup; retain
    // a loop instead of trusting id == array index.
    for (let j = 0; j < members.length; j += 1) {
      if (members[j].individualId === id) {
        const genotype = deserializeGenotype(serializeGenotype(members[j].genotype));
        out.push(Object.freeze({ individualId: id, genotype }));
        break;
      }
    }
  }
  return Object.freeze(out);
}

function captureMutationOptions(options, supplied) {
  if (!supplied) return { ...PARAMETRIC_MUTATION_DEFAULTS };
  if (typeof options !== 'object' || options === null) fail('mutation options', options);
  const keys = Reflect.ownKeys(options);
  let probability = PARAMETRIC_MUTATION_DEFAULTS.probability;
  let magnitude = PARAMETRIC_MUTATION_DEFAULTS.magnitude;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key !== 'string' || (key !== 'probability' && key !== 'magnitude')) {
      fail('mutation options key', String(key));
    }
    const value = options[key];
    if (key === 'probability') probability = value;
    else magnitude = value;
  }
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    fail('mutation options.probability', probability);
  }
  if (typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude < 0 || magnitude > 1) {
    fail('mutation options.magnitude', magnitude);
  }
  return { probability, magnitude };
}

function captureNextFloat(rng) {
  if (typeof rng !== 'object' || rng === null) fail('rng', rng);
  const nextFloat = rng.nextFloat;
  if (typeof nextFloat !== 'function') fail('rng.nextFloat', nextFloat);
  return nextFloat;
}

function nextUnitFloat(rng, nextFloat, draw) {
  const value = nextFloat.call(rng);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    fail(`rng.nextFloat draw ${draw}`, value);
  }
  return value;
}

function byteDeltaCount(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) count += 1;
  return count;
}

function fields(genotype) {
  const out = [];
  forEachGenotypeField(genotype, (entry) => out.push(entry));
  return out;
}

function assertStableShape(parentFields, rawFields, finalFields, parentBytes, rawBytes, finalBytes) {
  if (parentBytes.length !== rawBytes.length || parentBytes.length !== finalBytes.length) {
    fail('mutation schema', 'byte length changed');
  }
  if (parentFields.length !== rawFields.length || parentFields.length !== finalFields.length) {
    fail('mutation schema', 'field count changed');
  }
  for (let i = 0; i < parentFields.length; i += 1) {
    const p = parentFields[i]; const r = rawFields[i]; const f = finalFields[i];
    if (p.path !== r.path || p.path !== f.path || p.type !== r.type || p.type !== f.type
      || p.kind !== r.kind || p.kind !== f.kind
      || p.byteOffset !== r.byteOffset || p.byteOffset !== f.byteOffset
      || p.byteLength !== r.byteLength || p.byteLength !== f.byteLength) {
      fail('mutation schema', `field ${i} changed`);
    }
    if (!(p.kind === 'continuous' && p.type === 'f64')) {
      for (let j = 0; j < p.byteLength; j += 1) {
        if (parentBytes[p.byteOffset + j] !== rawBytes[p.byteOffset + j]) {
          fail('mutation', `raw non-continuous bytes changed at ${p.path}`);
        }
        if (parentBytes[p.byteOffset + j] !== finalBytes[p.byteOffset + j]) {
          fail('mutation', `final non-continuous bytes changed at ${p.path}`);
        }
      }
    }
  }
}

/**
 * Independently owns a canonical parent, applies continuous f64 draws in
 * field-walk order, then performs exactly one post-mutation repair.
 */
export function mutateContinuousGenotype(parent, rng, options) {
  const mutation = captureMutationOptions(options, arguments.length >= 3);
  // This is intentionally the canonicality tooth: no caller genotype is read
  // after attestPopulation has captured its bytes.
  const attested = attestPopulation({
    snapshotVersion: POPULATION_SNAPSHOT_VERSION,
    individuals: [{ individualId: 0, genotype: parent }],
  });
  const parentGenotype = attested.individuals[0].genotype;
  const parentBytes = serializeGenotype(parentGenotype);
  const parentFields = fields(parentGenotype);
  // All validation above completes before the first RNG property read.
  const nextFloat = captureNextFloat(rng);
  const rawBytes = new Uint8Array(parentBytes);
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  let draw = 0;
  let eligibleContinuousLeafCount = 0;
  let selectedLeafCount = 0;
  let clampedLeafCount = 0;
  for (let i = 0; i < parentFields.length; i += 1) {
    const entry = parentFields[i];
    if (!(entry.kind === 'continuous' && entry.type === 'f64')) continue;
    eligibleContinuousLeafCount += 1;
    const decision = nextUnitFloat(rng, nextFloat, draw += 1);
    if (decision >= mutation.probability) continue;
    selectedLeafCount += 1;
    const unit = nextUnitFloat(rng, nextFloat, draw += 1);
    const current = view.getFloat64(entry.byteOffset, true);
    const delta = (2 * unit - 1) * mutation.magnitude;
    const proposal = current + delta;
    let value = proposal;
    if (proposal < 0) { value = 0; clampedLeafCount += 1; }
    else if (proposal > 1) { value = 1; clampedLeafCount += 1; }
    // A zero sampled delta is byte-preserving, including a signed-zero source.
    if (delta !== 0) view.setFloat64(entry.byteOffset, value, true);
  }
  const rawGenotype = deserializeGenotype(rawBytes);
  const rawBytesCanonical = serializeGenotype(rawGenotype);
  const repaired = repairGenotype(rawGenotype);
  const genotype = deserializeGenotype(serializeGenotype(repaired));
  const rawFields = fields(rawGenotype);
  const finalFields = fields(genotype);
  const finalBytes = serializeGenotype(genotype);
  assertStableShape(parentFields, rawFields, finalFields, parentBytes, rawBytesCanonical, finalBytes);
  let rawChangedLeafCount = 0;
  let repairChangedLeafCount = 0;
  let repairIntroducedLeafCount = 0;
  let repairErasedLeafCount = 0;
  let repairRedirectedLeafCount = 0;
  let finalChangedLeafCount = 0;
  for (let i = 0; i < parentFields.length; i += 1) {
    const p = parentFields[i];
    if (!(p.kind === 'continuous' && p.type === 'f64')) continue;
    const rawChanged = !Object.is(p.value, rawFields[i].value);
    const finalChanged = !Object.is(p.value, finalFields[i].value);
    const repairChanged = !Object.is(rawFields[i].value, finalFields[i].value);
    if (rawChanged) rawChangedLeafCount += 1;
    if (finalChanged) finalChangedLeafCount += 1;
    if (repairChanged) repairChangedLeafCount += 1;
    if (!rawChanged && finalChanged) repairIntroducedLeafCount += 1;
    else if (rawChanged && !finalChanged) repairErasedLeafCount += 1;
    else if (rawChanged && !Object.is(rawFields[i].value, finalFields[i].value)) repairRedirectedLeafCount += 1;
  }
  if (repairChangedLeafCount !== repairIntroducedLeafCount + repairErasedLeafCount + repairRedirectedLeafCount
    || finalChangedLeafCount !== rawChangedLeafCount + repairIntroducedLeafCount - repairErasedLeafCount) {
    fail('mutation accounting', 'invariant failed');
  }
  const accounting = Object.freeze({
    eligibleContinuousLeafCount,
    selectedLeafCount,
    rawChangedLeafCount,
    clampedLeafCount,
    repairChangedLeafCount,
    repairIntroducedLeafCount,
    repairErasedLeafCount,
    repairRedirectedLeafCount,
    finalChangedLeafCount,
    rawByteDeltaCount: byteDeltaCount(parentBytes, rawBytesCanonical),
    finalByteDeltaCount: byteDeltaCount(parentBytes, finalBytes),
  });
  return Object.freeze({ rawGenotype, genotype, accounting });
}
