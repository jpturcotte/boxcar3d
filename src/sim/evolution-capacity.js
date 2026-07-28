// THE HISTORY-CAPACITY POLICY GATE (internal).
//
// One shared implementation of the worst-case retained-history projection,
// imported by exactly two modules:
//
//   - evolution-run.js    — fresh creation applies it after generation-zero
//                           normalization and before any runtime
//                           initialization;
//   - evolution-replay.js — persisted-artifact verification applies it after
//                           exact generation-zero provenance and before
//                           runtime identity, world creation, evaluation or
//                           replay.
//
// Capacity needs no physics attestation — it is a pure byte projection — so
// every refusal here is pre-runtime and pre-physics by construction.
//
// This module is NOT a public application API: it is imported by the two
// modules above and re-exported by nothing. It must not import
// evolution-run.js or evolution-replay.js.

import { serializeGenotype } from './assembly.js';
import {
  MAX_EVOLUTION_HISTORY_BYTES, projectEvolutionHistoryCapacity, serializeEvaluationMetadata,
} from './evolution-history.js';
import { checkedAdd, checkedMultiply, evolutionFail } from './evolution-contract.js';
import { POPULATION_WORLD_MODE, fitnessVectorByteLength } from './population-evaluation.js';
import { lineageByteLength } from './evolution-lineage.js';
import { typedArrayByteLength } from './bytes.js';

/**
 * Refuse a run whose legal generation count cannot fit its retained evolution
 * history (history-format v1 carrying the v3 fitness-vector component).
 * Continuous mutation cannot change genotype
 * geometry, but selection can concentrate the largest starting genotype into
 * every row, so the projection uses that worst-case population rather than
 * generation 0's sum.
 */
export function assertHistoryCapacity({
  population,
  populationSize,
  maxGenerations,
  initializationBytes,
  specBytes,
  spec,
}) {
  const individuals = population.individuals;
  const count = individuals.length;
  let maximumGenotypeBytes = 0;
  for (let i = 0; i < count; i += 1) {
    maximumGenotypeBytes = Math.max(
      maximumGenotypeBytes,
      serializeGenotype(individuals[i].genotype).length,
    );
  }
  // Population-snapshot framing — u16+u16+u32 header, then u32 id + u32
  // length + genotype per member — is owned by the population codec
  // (population.js `encodeMembers`, "callers never duplicate these offsets"),
  // which exports no framing constants to import. The projection must mirror
  // it, so tests/evolution-capacity.test.js pins this geometry against a real
  // codec encoding byte for byte.
  const maximumPopulationBytes = checkedAdd(
    2 + 2 + 4,
    checkedMultiply(populationSize, 4 + 4 + maximumGenotypeBytes, 'projected population snapshot'),
    'projected population snapshot',
  );
  const metadataBytes = serializeEvaluationMetadata({
    worldMode: POPULATION_WORLD_MODE,
    effectiveDt: 1,
    executedSteps: spec.maxSteps,
  }).length;
  const projection = projectEvolutionHistoryCapacity({
    initializationManifestByteLength: typedArrayByteLength(initializationBytes),
    evaluationSpecByteLength: typedArrayByteLength(specBytes),
    generationCount: maxGenerations,
    componentByteLengths: {
      population: maximumPopulationBytes,
      evaluationMetadata: metadataBytes,
      fitnessVector: fitnessVectorByteLength(populationSize),
      lineage: lineageByteLength(populationSize),
    },
  });
  if (projection.projectedBytes > MAX_EVOLUTION_HISTORY_BYTES) {
    evolutionFail('resourceLimitExceeded',
      `projected evolution history ${projection.projectedBytes} exceeds MAX_EVOLUTION_HISTORY_BYTES (${MAX_EVOLUTION_HISTORY_BYTES})`,
      {
        projectedBytes: projection.projectedBytes,
        limit: MAX_EVOLUTION_HISTORY_BYTES,
        maximumFeasibleGenerations: projection.maximumFeasibleGenerations,
        requestedGenerations: maxGenerations,
        generationFrameBytes: projection.generationFrameBytes,
      });
  }
}
