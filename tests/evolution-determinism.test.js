// THE EVOLUTION IDENTITY GATE (runs under `npm test` AND the cross-platform
// `npm run test:determinism` matrix): the committed evolution-a-small-flat
// locks must reproduce exactly — every version and runtime field, the header
// digest, each generation's four component digests and its chained generation
// digest, every lineage row, and the whole-history digest.
// tests/browser/evolution-determinism.test.js re-proves the same literals in
// pinned Chromium.
//
// ASSERTION DISCIPLINE. `toBe` against committed literals ONLY. The lineage
// accounting entries are EXACT measured values; this file must never assert
// that mutation is "enough", that fitness is "good", or that a population is
// improving — those are PR 4's empirical questions, and a threshold disguised
// as a determinism lock is the failure mode this repo has already paid for.
// What it DOES assert beyond the literals is STRUCTURAL coverage (elites exist,
// both mutation branches occur, the last record is terminal), because a fixture
// that silently stopped exercising a mechanism would keep every digest green
// while locking nothing.
//
// Re-lock workflow (deliberate changes only): set the stale lock's
// `historyDigest` to null, run this gate — it fails printing the FULL measured
// record as paste-ready JSON — paste it into src/sim/evolution-locks.js, get
// Node green, then pinned Chromium must agree before merge.

import { describe, test, expect } from 'vitest';

import { EVOLUTION_GOLDEN_LOCKS } from '../src/sim/evolution-locks.js';
import { EVOLUTION_FIXTURE_A, evolutionRunConfigFor } from '../src/sim/evolution-fixtures.js';
import {
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, createEvolutionRun, resumeEvolutionRun,
} from '../src/sim/evolution-run.js';
import {
  COMPONENT_KINDS, EVALUATION_METADATA_VERSION, EVOLUTION_HISTORY_VERSION,
  GENERATION_RECORD_VERSION, decodeEvolutionHeader, decodeGenerationPayload,
  decodeHistoryFraming, deserializeEvaluationMetadata,
} from '../src/sim/evolution-history.js';
import { EVOLUTION_LINEAGE_VERSION, deserializeLineage } from '../src/sim/evolution-lineage.js';
import {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE,
} from '../src/sim/evolution-operators.js';
import {
  EVALUATION_SPEC_VERSION, FITNESS_POLICY_VERSION, FITNESS_VECTOR_VERSION, POPULATION_WORLD_MODE,
} from '../src/sim/population-evaluation.js';
import { INTEGRITY_POLICY_VERSION } from '../src/sim/integrity.js';
import { POPULATION_SNAPSHOT_VERSION } from '../src/sim/population.js';
import { POPULATION_INITIALIZER_VERSION } from '../src/sim/population-initializer.js';
import { GENOTYPE_VERSION } from '../src/sim/assembly.js';
import { bytesToHex } from '../src/sim/bytes.js';

const LOCK = EVOLUTION_GOLDEN_LOCKS[EVOLUTION_FIXTURE_A.name];

/** Run the fixture to its terminal record and return the artifact bytes. */
async function runFixture() {
  const run = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
  let result;
  do { result = await run.advance(); } while (result.kind !== 'terminal');
  return { run, bytes: run.historyBytes(), result };
}

/** Decode an artifact into the shape the lock declares. */
function measure(bytes) {
  const framing = decodeHistoryFraming(bytes);
  const header = decodeEvolutionHeader(framing.headerBytes);
  const generations = [];
  for (let i = 0; i < framing.generations.length; i += 1) {
    const payload = decodeGenerationPayload(framing.generations[i].payloadBytes);
    const lineage = deserializeLineage(payload.components.lineage);
    const rows = [];
    for (const row of lineage.individuals) {
      rows.push({
        individualId: row.individualId,
        parentIndividualId: row.parentIndividualId,
        origin: row.origin,
        eligibleContinuousLeafCount: row.accounting.eligibleContinuousLeafCount,
        selectedLeafCount: row.accounting.selectedLeafCount,
        finalChangedLeafCount: row.accounting.finalChangedLeafCount,
        finalByteDeltaCount: row.accounting.finalByteDeltaCount,
      });
    }
    generations.push({
      generationIndex: payload.generationIndex,
      terminalReason: payload.terminalReason,
      payloadByteLength: framing.generations[i].payloadBytes.length,
      populationByteLength: payload.components.population.length,
      populationDigest: bytesToHex(payload.componentDigests.population),
      evaluationMetadataDigest: bytesToHex(payload.componentDigests.evaluationMetadata),
      fitnessVectorDigest: bytesToHex(payload.componentDigests.fitnessVector),
      lineageDigest: bytesToHex(payload.componentDigests.lineage),
      generationDigest: bytesToHex(framing.generations[i].generationDigestBytes),
      lineage: rows,
    });
  }
  const metadata = deserializeEvaluationMetadata(
    decodeGenerationPayload(framing.generations[0].payloadBytes).components.evaluationMetadata,
  );
  return {
    framing,
    header,
    metadata,
    record: {
      headerByteLength: framing.headerBytes.length,
      headerDigest: bytesToHex(framing.headerDigestBytes),
      historyByteLength: bytes.length,
      historyDigest: bytesToHex(framing.historyDigestBytes),
      generations,
    },
  };
}

describe('evolution golden locks (Node)', () => {
  test('the LIVE version constants still match the committed lock (staleness teeth)', () => {
    // These are the deliberate-change tripwires: a version bump must fail HERE,
    // with a message that says re-lock, rather than surface as an unexplained
    // digest difference three assertions later.
    const live = {
      evolutionEngineVersion: EVOLUTION_ENGINE_VERSION,
      evolutionPolicyVersion: EVOLUTION_POLICY_VERSION,
      evolutionHistoryVersion: EVOLUTION_HISTORY_VERSION,
      generationRecordVersion: GENERATION_RECORD_VERSION,
      evolutionLineageVersion: EVOLUTION_LINEAGE_VERSION,
      evaluationMetadataVersion: EVALUATION_METADATA_VERSION,
      tournamentSelectionVersion: TOURNAMENT_SELECTION_VERSION,
      elitismVersion: ELITISM_VERSION,
      parametricMutationVersion: PARAMETRIC_MUTATION_VERSION,
      tournamentSize: TOURNAMENT_SIZE,
      eliteCount: ELITE_COUNT,
      populationSnapshotVersion: POPULATION_SNAPSHOT_VERSION,
      populationInitializerVersion: POPULATION_INITIALIZER_VERSION,
      evaluationSpecVersion: EVALUATION_SPEC_VERSION,
      fitnessVectorVersion: FITNESS_VECTOR_VERSION,
      fitnessPolicyVersion: FITNESS_POLICY_VERSION,
      integrityPolicyVersion: INTEGRITY_POLICY_VERSION,
      genotypeVersion: GENOTYPE_VERSION,
      worldMode: POPULATION_WORLD_MODE,
    };
    for (const [name, value] of Object.entries(live)) {
      expect(LOCK[name], `${name} changed — re-lock deliberately`).toBe(value);
    }
    // The fixture's own declared parameters must match the lock too, so a
    // fixture edit cannot silently re-point the locks at a different run.
    expect(LOCK.fixtureVersion).toBe(EVOLUTION_FIXTURE_A.version);
    expect(LOCK.populationSeed).toBe(EVOLUTION_FIXTURE_A.populationSeed);
    expect(LOCK.terrainSeed).toBe(EVOLUTION_FIXTURE_A.terrainSeed);
    expect(LOCK.populationSize).toBe(EVOLUTION_FIXTURE_A.populationSize);
    expect(LOCK.maxGenerations).toBe(EVOLUTION_FIXTURE_A.maxGenerations);
    expect(LOCK.executedSteps).toBe(EVOLUTION_FIXTURE_A.maxSteps);
    expect(LOCK.mutationProbability).toBe(EVOLUTION_FIXTURE_A.mutationProbability);
    expect(LOCK.mutationMagnitude).toBe(EVOLUTION_FIXTURE_A.mutationMagnitude);
  });

  test('the committed artifact reproduces EXACTLY', { timeout: 240000 }, async () => {
    const { bytes, result } = await runFixture();
    const measured = measure(bytes);

    // The re-lock workflow: a null digest fails loud with the FULL measured
    // record as paste-ready JSON, so a deliberate change never needs anyone to
    // reconstruct thirty literals by hand.
    if (LOCK.historyDigest === null) {
      throw new Error('RE-LOCK: paste this into src/sim/evolution-locks.js\n'
        + JSON.stringify(measured.record, null, 2));
    }

    // Runtime identity FIRST: a dependency bump must read as "the engine
    // changed", never as an unexplained digest difference.
    expect(measured.header.physicsFlavor, 'physics flavor changed — re-lock deliberately').toBe(LOCK.physicsFlavor);
    expect(measured.header.packageName, 'physics package changed — re-lock deliberately').toBe(LOCK.packageName);
    expect(measured.header.rapierVersion, 'engine changed — re-lock deliberately').toBe(LOCK.rapierVersion);
    expect(Object.is(measured.metadata.effectiveDt, LOCK.effectiveDt), `effectiveDt ${measured.metadata.effectiveDt} !== locked ${LOCK.effectiveDt}`).toBe(true);
    expect(measured.metadata.executedSteps).toBe(LOCK.executedSteps);
    expect(measured.metadata.worldMode).toBe(LOCK.worldMode);

    // The header, then every generation, then the whole artifact.
    expect(measured.record.headerByteLength).toBe(LOCK.headerByteLength);
    expect(measured.record.headerDigest).toBe(LOCK.headerDigest);
    expect(measured.record.generations.length).toBe(LOCK.generations.length);
    measured.record.generations.forEach((g, i) => {
      const locked = LOCK.generations[i];
      expect(g.generationIndex, `generation ${i} index`).toBe(locked.generationIndex);
      expect(g.terminalReason, `generation ${i} terminalReason`).toBe(locked.terminalReason);
      expect(g.payloadByteLength, `generation ${i} payload length`).toBe(locked.payloadByteLength);
      expect(g.populationByteLength, `generation ${i} population length`).toBe(locked.populationByteLength);
      expect(g.populationDigest, `generation ${i} population digest`).toBe(locked.populationDigest);
      expect(g.evaluationMetadataDigest, `generation ${i} metadata digest`).toBe(locked.evaluationMetadataDigest);
      expect(g.fitnessVectorDigest, `generation ${i} fitness digest`).toBe(locked.fitnessVectorDigest);
      expect(g.lineageDigest, `generation ${i} lineage digest`).toBe(locked.lineageDigest);
      expect(g.generationDigest, `generation ${i} chained digest`).toBe(locked.generationDigest);
      expect(g.lineage.length, `generation ${i} lineage rows`).toBe(locked.lineage.length);
      g.lineage.forEach((row, r) => {
        expect(row, `generation ${i} lineage row ${r}`).toEqual(locked.lineage[r]);
      });
    });
    expect(measured.record.historyByteLength).toBe(LOCK.historyByteLength);
    expect(measured.record.historyDigest).toBe(LOCK.historyDigest);
    // …and the digest advance() handed back is the same one the artifact carries.
    expect(bytesToHex(result.historyDigestBytes)).toBe(LOCK.historyDigest);
  });

  test('the fixture still EXERCISES what the locks claim to cover', { timeout: 240000 }, async () => {
    // Structural coverage, asserted rather than assumed. A fixture change that
    // stopped producing elites, or stopped selecting any leaf, would leave
    // every digest green while the locks quietly covered less.
    const locked = LOCK.generations;
    expect(locked.length).toBeGreaterThanOrEqual(3);
    expect(locked[0].lineage.every((r) => r.origin === 'initialized')).toBe(true);
    expect(locked[0].terminalReason).toBe('none');
    expect(locked[locked.length - 1].terminalReason).not.toBe('none');
    for (let i = 1; i < locked.length; i += 1) {
      const rows = locked[i].lineage;
      expect(rows.filter((r) => r.origin === 'eliteCopy').length, `generation ${i} elites`).toBe(ELITE_COUNT);
      expect(rows.filter((r) => r.origin === 'continuousMutation').length).toBe(LOCK.populationSize - ELITE_COUNT);
      // An elite is a copy: it consumed no operator work.
      for (const r of rows.filter((x) => x.origin === 'eliteCopy')) {
        expect(r.selectedLeafCount).toBe(0);
        expect(r.finalByteDeltaCount).toBe(0);
      }
      // Every id is fresh: strictly greater than every id of the generation before.
      const previousMax = Math.max(...locked[i - 1].lineage.map((r) => r.individualId));
      expect(Math.min(...rows.map((r) => r.individualId))).toBeGreaterThan(previousMax);
      // Every parent came from the preceding generation.
      const parents = new Set(locked[i - 1].lineage.map((r) => r.individualId));
      for (const r of rows) expect(parents.has(r.parentIndividualId), `row ${r.individualId} parent`).toBe(true);
    }
    const mutated = locked.slice(1).flatMap((g) => g.lineage).filter((r) => r.origin === 'continuousMutation');
    // BOTH mutation branches are inside the lock: at least one child had no
    // leaf selected (a byte-identical copy of its parent) and at least one had
    // several. Neither is a quality claim; both are coverage.
    expect(mutated.some((r) => r.selectedLeafCount === 0)).toBe(true);
    expect(mutated.some((r) => r.selectedLeafCount > 1)).toBe(true);
    expect(mutated.every((r) => r.selectedLeafCount <= r.eligibleContinuousLeafCount)).toBe(true);
  });

  test('the artifact is reproducible in-process and resumes byte-identically', { timeout: 240000 }, async () => {
    const a = await runFixture();
    const b = await runFixture();
    expect(bytesToHex(b.bytes)).toBe(bytesToHex(a.bytes));
    // Resume verifies, replays every generation against the recorded bytes, and
    // returns a terminal run carrying the same artifact — the round trip the
    // whole format exists for.
    const resumed = await resumeEvolutionRun(a.bytes);
    expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(a.bytes));
    expect(resumed.status().phase).toBe('terminal');
    expect(resumed.status().terminalReason).toBe(LOCK.generations[LOCK.generations.length - 1].terminalReason);
  });

  test('every component kind is present in every record (the fixed geometry)', { timeout: 240000 }, async () => {
    const { bytes } = await runFixture();
    const framing = decodeHistoryFraming(bytes);
    for (const g of framing.generations) {
      const payload = decodeGenerationPayload(g.payloadBytes);
      expect(Object.keys(payload.components).sort()).toEqual([...COMPONENT_KINDS].sort());
      // No trace, no checkpoints, no diagnostics — the Commit 0 policy premise.
      expect(Object.keys(payload.components)).not.toContain('trace');
    }
  });
});
