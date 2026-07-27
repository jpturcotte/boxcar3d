// Capture the DECLARED component inputs for the independent fitness-vector-v3
// interoperability fixture (PR 29, R2). This script is the producer side: it
// MAY import the implementation under test — its output is a capture, not
// evidence. The independent encoder (generate-evolution-v3-interop-fixture.js)
// consumes this JSON and nothing from the implementation.
//
// What is captured, and why. Fixture A's generation 0 carries a DERIVED
// population and lineage, which an independent encoder cannot recreate without
// reimplementing the GA transition — so the population, metadata and lineage
// component bytes are captured LITERALS (inputs, never evidence). What the
// oracle attests downstream is the ENCODING AND ASSEMBLY layer only: the v3
// fitness-vector member walk (encoded here as decoded ROWS, so the independent
// tool re-encodes them from declared values) and the framing / digest
// assembly.
//
// Usage: node scripts/capture-evolution-v3-oracle-inputs.js
//   (writes tests/fixtures/evolution-v1-fitness-vector-v3-oracle-inputs.json)

import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { EVOLUTION_FIXTURE_A, evolutionRunConfigFor } from '../src/sim/evolution-fixtures.js';
import { createEvolutionRun } from '../src/sim/evolution-run.js';
import { decodeGenerationPayload, decodeHistoryFraming } from '../src/sim/evolution-history.js';
import { deserializeFitnessVector } from '../src/sim/population-evaluation.js';
import { bytesToHex } from '../src/sim/bytes.js';

const OUT = new URL('../tests/fixtures/evolution-v1-fitness-vector-v3-oracle-inputs.json', import.meta.url);

const run = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
const first = await run.advance();
if (first.kind !== 'advanced') {
  throw new Error(`expected generation 0 to be non-terminal, got ${first.kind}`);
}
const framing = decodeHistoryFraming(run.historyBytes());
if (framing.generations.length !== 1) {
  throw new Error(`expected exactly one committed generation, got ${framing.generations.length}`);
}
const payload = decodeGenerationPayload(framing.generations[0].payloadBytes);
const vector = deserializeFitnessVector(payload.components.fitnessVector);

const inputs = {
  schema: 'boxcar3d.evolution-v3-oracle-inputs/v1',
  fixture: {
    name: EVOLUTION_FIXTURE_A.name,
    version: EVOLUTION_FIXTURE_A.version,
    populationSeed: EVOLUTION_FIXTURE_A.populationSeed,
    terrainSeed: EVOLUTION_FIXTURE_A.terrainSeed,
    populationSize: EVOLUTION_FIXTURE_A.populationSize,
    maxGenerations: EVOLUTION_FIXTURE_A.maxGenerations,
    maxSteps: EVOLUTION_FIXTURE_A.maxSteps,
    mutationProbability: EVOLUTION_FIXTURE_A.mutationProbability,
    mutationMagnitude: EVOLUTION_FIXTURE_A.mutationMagnitude,
  },
  headerBytesHex: bytesToHex(framing.headerBytes),
  generation: {
    generationIndex: payload.generationIndex,
    terminalReason: payload.terminalReason,
    components: {
      populationHex: bytesToHex(payload.components.population),
      evaluationMetadataHex: bytesToHex(payload.components.evaluationMetadata),
      lineageHex: bytesToHex(payload.components.lineage),
      fitnessVector: {
        fitnessVectorVersion: vector.fitnessVectorVersion,
        fitnessPolicyVersion: vector.fitnessPolicyVersion,
        integrityPolicyVersion: vector.integrityPolicyVersion,
        snapshotVersion: vector.snapshotVersion,
        populationSnapshotDigestState: vector.populationSnapshotDigestState,
        evaluationSpecVersion: vector.evaluationSpecVersion,
        evaluationSpecDigestState: vector.evaluationSpecDigestState,
        individuals: vector.individuals.map((row) => ({
          individualId: row.individualId,
          valid: row.valid,
          integrityStatus: row.integrityStatus,
          fitness: row.fitness,
          integrityObservations: {
            peakBodySpeed: row.integrityObservations.peakBodySpeed,
            peakSpeedDelta: row.integrityObservations.peakSpeedDelta,
            peakStepDisplacement: row.integrityObservations.peakStepDisplacement,
            firstAlertStep: row.integrityObservations.firstAlertStep,
            firstCatastrophicStep: row.integrityObservations.firstCatastrophicStep,
          },
        })),
      },
    },
  },
};

// The rows cross a JSON envelope, and v3 admits +Infinity peaks: refuse to
// write a record JSON cannot carry losslessly (JSON.stringify(Infinity) is
// null — a silent lie about a real measurement).
for (const row of inputs.generation.components.fitnessVector.individuals) {
  for (const key of ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement']) {
    if (!Number.isFinite(row.integrityObservations[key])) {
      throw new Error(`individual ${row.individualId} ${key} is non-finite — the JSON inputs cannot carry it; extend the representation deliberately`);
    }
  }
}

writeFileSync(OUT, `${JSON.stringify(inputs, null, 2)}\n`);
console.log(`wrote ${OUT.pathname}`);
