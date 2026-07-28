// Contract tests for tests/helpers/evolution-artifacts.js (the shared
// adversarial reforge helper): a reforged artifact must pass every EARLIER
// gate — framing, header digest, component digests, the chain, the
// whole-history digest — and arrive at EXACTLY the gate its mutation
// targets. The source is a real small run (population 6, 45 steps), the
// established cheap construction pattern.

import { describe, test, expect } from 'vitest';

const { createEvolutionRun } = await import('../../src/sim/evolution-run.js');
const { FITNESS_VECTOR_VERSION } = await import('../../src/sim/population-evaluation.js');
const {
  deserializeEvaluationMetadata, serializeEvaluationMetadata,
} = await import('../../src/sim/evolution-history.js');
const { extractHistoryObservations } = await import('../../scripts/history-observations.js');
const { reforge, withLeadingU16 } = await import('./evolution-artifacts.js');
const { expectCodeAsync } = await import('./expect-code.js');
const {
  CAPACITY_POPULATION_SEED, createCapacityEvaluationSpec,
} = await import('./evolution-capacity-config.js');

async function smallRunArtifact() {
  const run = createEvolutionRun({
    initialization: { seed: CAPACITY_POPULATION_SEED, populationSize: 6 },
    evaluationSpec: createCapacityEvaluationSpec(),
    evolution: { maxGenerations: 2 },
  });
  await run.advance();
  return run.historyBytes();
}

describe('the shared reforge helper', () => {
  test('a coherence-legal mutation passes every gate and extracts', async () => {
    // A LARGER legal effectiveDt scales the displacement thresholds up, so
    // the run's clean rows stay vector/metadata coherent (the withForeignDt
    // precedent). Extraction must succeed and report the mutated value —
    // positive proof the helper re-attested every component digest, the
    // chain and the whole-history digest correctly.
    const artifact = await smallRunArtifact();
    const foreignDt = Math.fround(1 / 30);
    const reforged = await reforge(artifact, {
      mutateRecord: (record) => {
        const metadata = deserializeEvaluationMetadata(record.components.evaluationMetadata);
        record.components.evaluationMetadata = serializeEvaluationMetadata({
          ...metadata, effectiveDt: foreignDt,
        });
      },
    });
    const extracted = await extractHistoryObservations(reforged);
    expect(extracted.generations).toHaveLength(1);
    expect(extracted.generations[0].effectiveDt).toBe(foreignDt);
  });

  test('a mutation targeting a later gate is refused at exactly that gate', async () => {
    // A stale nested fitness-vector version must surface as
    // `unsupportedVersion` — a gate the artifact reaches ONLY because the
    // re-attested framing, digests and chain all passed (a stale digest
    // would fail earlier as malformedHistory).
    const artifact = await smallRunArtifact();
    const reforged = await reforge(artifact, {
      mutateRecord: (record) => {
        record.components.fitnessVector = withLeadingU16(
          record.components.fitnessVector, FITNESS_VECTOR_VERSION - 1,
        );
      },
    });
    await expectCodeAsync(() => extractHistoryObservations(reforged), 'unsupportedVersion');
  });
});
