// THE INTEROP FIXTURE RE-LOCK — a deliberate, auditable regeneration step,
// never a CI job.
//
//   node scripts/relock-evolution-interop.js
//
// WHAT IT DOES: runs the canonical interop config (declared beside the
// consuming tests) for exactly one generation, writes the artifact to
// tests/fixtures/evolution-v3-interop.base64, continues the SAME run to its
// terminal record, and prints every digest the consuming tests lock: the
// artifact SHA-256, the header digest, the one-generation history digest, the
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
import { decodeHistoryFraming } from '../src/sim/evolution-history.js';
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

async function main() {
  const run = createEvolutionRun(INTEROP_CONFIG);
  await run.advance();
  const oneGeneration = run.historyBytes();
  const framing = decodeHistoryFraming(oneGeneration);

  let result;
  do { result = await run.advance(); } while (result.kind !== 'terminal');
  const terminal = run.historyBytes();

  writeFileSync(FIXTURE_PATH, `${Buffer.from(oneGeneration).toString('base64')}\n`);

  const lines = [
    `fixture written: ${FIXTURE_PATH}`,
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
