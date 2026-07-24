// THE INTEROP FIXTURE RE-LOCK — a deliberate, auditable regeneration step,
// never a CI job.
//
//   node scripts/relock-evolution-interop.js
//
// WHAT IT DOES: runs the canonical interop config (declared beside the
// consuming tests) for exactly one generation, writes the artifact to
// tests/fixtures/evolution-v3-interop.base64 AND its captured-literals
// manifest to tests/fixtures/evolution-v3-interop.manifest.json (the declared
// component inputs the structurally independent encoder consumes — see
// scripts/interop-v3-encoder.js), continues the SAME run to its terminal
// record, and prints every digest the consuming tests lock: the artifact
// SHA-256, the header digest, the one-generation history digest, the
// terminal continuation digest, and the terminal artifact SHA-256.
//
// WHY IT EXISTS. The v2-era interoperability oracle
// (tests/fixtures/evolution-v1-kimi-k3max.base64) was produced by an
// INDEPENDENT implementation and is deliberately kept unmodified: since
// fitness-vector v3 it is the standing early-refusal witness (a stale wire
// version must be refused as unsupportedVersion before any physics). The
// successful-replay role therefore needs a v3-vector artifact, and THIS
// script is its one honest producer — the committed bytes are the durable
// oracle, and any regeneration is a reviewed re-lock, exactly like the
// null-digest workflow in src/sim/evolution-locks.js.
//
// Node-only, outside the src/sim ESLint ban.

import { writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';

import { createEvolutionRun } from '../src/sim/evolution-run.js';
import { decodeHistoryFraming, decodeGenerationPayload } from '../src/sim/evolution-history.js';
import { deserializeFitnessVector } from '../src/sim/population-evaluation.js';
import { bytesToHex } from '../src/sim/bytes.js';
import { sha256 } from '../src/platform/sha256.js';

// The canonical interop config — MUST stay literal-identical to the copies
// declared beside the consuming tests (tests/evolution-replay.test.js and
// tests/browser/evolution-determinism.test.js).
const INTEROP_CONFIG = Object.freeze({
  initialization: { seed: 20260721, populationSize: 4 },
  evaluationSpec: {
    terrain: {
      seed: 20260722, startFlatLength: 40, craterDensity: 0, featureDensity: 0,
      sandCoverage: 0, mudCoverage: 0, macroAmp: 0, microAmp: 0,
    },
    maxSteps: 60,
    deterministic: true,
    spawn: { x: -44, z: 0 },
  },
  evolution: { maxGenerations: 3, mutation: { probability: 0.5, magnitude: 0.1 } },
});

const FIXTURE_PATH = fileURLToPath(
  new URL('../tests/fixtures/evolution-v3-interop.base64', import.meta.url),
);
const MANIFEST_PATH = fileURLToPath(
  new URL('../tests/fixtures/evolution-v3-interop.manifest.json', import.meta.url),
);

// The captured-literals manifest: the header and the derived population /
// evaluation-metadata / lineage components ride as opaque base64 (INPUTS, not
// evidence — an independent encoder cannot recreate derived content without
// reimplementing the GA transition), while the fitness vector rides as
// SEMANTIC values so the independent encoder re-encodes its bytes and the
// whole framing/digest assembly from the written spec alone.
function buildManifest(framing) {
  const record = decodeGenerationPayload(framing.generations[0].payloadBytes);
  const vector = deserializeFitnessVector(record.components.fitnessVector);
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  return {
    format: 'boxcar3d/evolution-v3-interop-manifest/v1',
    note: 'Captured literals for scripts/interop-v3-encoder.js — inputs, not '
      + 'evidence. Only the fitness-vector semantics below are re-encoded '
      + 'independently; header/population/metadata/lineage bytes are opaque.',
    headerBytesBase64: b64(framing.headerBytes),
    generation: {
      generationIndex: record.generationIndex,
      terminalReason: record.terminalReason,
      components: {
        populationBase64: b64(record.components.population),
        evaluationMetadataBase64: b64(record.components.evaluationMetadata),
        lineageBase64: b64(record.components.lineage),
      },
      fitnessVector: {
        fitnessVectorVersion: vector.fitnessVectorVersion,
        fitnessPolicyVersion: vector.fitnessPolicyVersion,
        integrityPolicyVersion: vector.integrityPolicyVersion,
        snapshotVersion: vector.snapshotVersion,
        populationSnapshotDigestState: vector.populationSnapshotDigestState,
        evaluationSpecVersion: vector.evaluationSpecVersion,
        evaluationSpecDigestState: vector.evaluationSpecDigestState,
        individuals: vector.individuals.map((row) => ({ ...row })),
      },
    },
  };
}

async function main() {
  const run = createEvolutionRun(INTEROP_CONFIG);
  await run.advance();
  const oneGeneration = run.historyBytes();
  const framing = decodeHistoryFraming(oneGeneration);

  let result;
  do { result = await run.advance(); } while (result.kind !== 'terminal');
  const terminal = run.historyBytes();

  writeFileSync(FIXTURE_PATH, `${Buffer.from(oneGeneration).toString('base64')}\n`);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(buildManifest(framing), null, 2)}\n`);

  const lines = [
    `fixture written: ${FIXTURE_PATH}`,
    `manifest written: ${MANIFEST_PATH}`,
    `one-generation byte length: ${oneGeneration.length}`,
    `artifact SHA-256: ${bytesToHex(await sha256(oneGeneration))}`,
    `header digest: ${bytesToHex(framing.headerDigestBytes)}`,
    `one-generation history digest: ${bytesToHex(framing.historyDigestBytes)}`,
    `terminal continuation digest: ${bytesToHex(terminal.slice(-32))}`,
    `terminal artifact SHA-256: ${bytesToHex(await sha256(terminal))}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(error);
});
