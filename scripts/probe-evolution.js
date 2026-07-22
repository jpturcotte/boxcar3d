// THE EVOLUTION PROBE — an identity instrument, deliberately not an experiment.
//
//   npm run probe:evolution            markdown to stdout
//   npm run probe:evolution -- --json  the machine-readable report
//
// WHAT IT DOES: reports the runtime/version/config identities, runs the
// committed small evolution case, prints every generation's component, chain
// and lineage digests plus the final history digest, resumes the artifact and
// confirms byte-identical continuation, and emits a versioned JSON report.
//
// WHAT IT IS NOT, stated up front because instruments in this repo have drifted
// into oracles before. This probe establishes NO lock authority (the committed
// literals in src/sim/evolution-locks.js are the authority, and
// tests/evolution-determinism.test.js is the gate), and it makes NO claim about
// fitness quality, diversity, convergence, mutation-default suitability, or
// performance. Those are PR 4's empirical questions and this file must never be
// cited for them. Its only CI touchpoint is the schema smoke
// (tests/evolution-probe-schema.test.js), which checks structure and hard
// identity — never a magnitude.
//
// Node-only, outside the src/sim ESLint ban (wall clock allowed here; nothing
// it measures enters a digest).

import { EVOLUTION_FIXTURE_A, evolutionRunConfigFor } from '../src/sim/evolution-fixtures.js';
import { EVOLUTION_GOLDEN_LOCKS } from '../src/sim/evolution-locks.js';
import {
  EVOLUTION_ENGINE_VERSION, EVOLUTION_POLICY_VERSION, createEvolutionRun, resumeEvolutionRun,
} from '../src/sim/evolution-run.js';
import {
  COMPONENT_KINDS, EVALUATION_METADATA_VERSION, EVOLUTION_HISTORY_VERSION,
  GENERATION_RECORD_VERSION, decodeEvolutionHeader, decodeGenerationPayload,
  decodeHistoryFraming, deserializeEvaluationMetadata,
} from '../src/sim/evolution-history.js';
import { EVOLUTION_LINEAGE_VERSION, deserializeLineage } from '../src/sim/evolution-lineage.js';
import { bytesToHex } from '../src/sim/bytes.js';

export const EVOLUTION_PROBE_SCHEMA = 'boxcar3d.probe-evolution/1';

const PROBE_MODES = Object.freeze(['identity']);

export function configFromArgs(argv) {
  const config = { mode: 'identity', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--mode') {
      const value = argv[i + 1];
      if (!PROBE_MODES.includes(value)) {
        throw new Error(`probe-evolution: unknown --mode '${String(value)}' (modes: ${PROBE_MODES.join(', ')})`);
      }
      config.mode = value;
      i += 1;
      continue;
    }
    throw new Error(`probe-evolution: unknown argument '${arg}'`);
  }
  return config;
}

/**
 * Run the fixture, decode the artifact, resume it, and return the report.
 *
 * The HARD checks are identity-class only, exactly as the physics-explosion and
 * integrity probes rule: digests, byte lengths, structural agreement with the
 * committed lock, and byte-identical resume. No physics magnitude is asserted
 * anywhere — this instrument OBSERVES the run and VERIFIES its identity.
 */
export async function runEvolutionProbe(config = { mode: 'identity', json: false }) {
  const fixture = EVOLUTION_FIXTURE_A;
  const lock = EVOLUTION_GOLDEN_LOCKS[fixture.name] ?? null;
  const startedAt = Date.now();
  const run = createEvolutionRun(evolutionRunConfigFor(fixture));
  const advances = [];
  let result;
  do {
    result = await run.advance();
    advances.push({
      kind: result.kind,
      committedGenerationIndex: result.committedGenerationIndex,
      reason: result.kind === 'terminal' ? result.reason : null,
      historyDigest: bytesToHex(result.historyDigestBytes),
    });
  } while (result.kind !== 'terminal');
  const bytes = run.historyBytes();
  const framing = decodeHistoryFraming(bytes);
  const header = decodeEvolutionHeader(framing.headerBytes);
  const metadata = deserializeEvaluationMetadata(
    decodeGenerationPayload(framing.generations[0].payloadBytes).components.evaluationMetadata,
  );

  const generations = framing.generations.map((g, i) => {
    const payload = decodeGenerationPayload(g.payloadBytes);
    const lineage = deserializeLineage(payload.components.lineage);
    const origins = { initialized: 0, eliteCopy: 0, continuousMutation: 0 };
    let selectedLeafTotal = 0;
    for (const row of lineage.individuals) {
      origins[row.origin] += 1;
      selectedLeafTotal += row.accounting.selectedLeafCount;
    }
    return {
      generationIndex: payload.generationIndex,
      terminalReason: payload.terminalReason,
      payloadByteLength: g.payloadBytes.length,
      componentDigests: Object.fromEntries(
        COMPONENT_KINDS.map((kind) => [kind, bytesToHex(payload.componentDigests[kind])]),
      ),
      generationDigest: bytesToHex(g.generationDigestBytes),
      individualIds: lineage.individuals.map((row) => row.individualId),
      parentIndividualIds: lineage.individuals.map((row) => row.parentIndividualId),
      origins,
      selectedLeafTotal,
      chainedFrom: i === 0 ? 'header' : i - 1,
    };
  });

  // Resume: verify + replay + confirm byte-identical continuation. This is the
  // probe's one behavioural claim, and it is an IDENTITY claim.
  const resumed = await resumeEvolutionRun(bytes, {
    expectedHistoryDigestBytes: result.historyDigestBytes,
    expectedGenerationIndex: framing.generations.length - 1,
  });
  const resumedHex = bytesToHex(resumed.historyBytes());
  const originalHex = bytesToHex(bytes);

  const hard = [];
  const check = (name, pass, detail) => hard.push({ name, pass, detail });
  check('resume reproduces the artifact byte-identically', resumedHex === originalHex,
    `${resumedHex.length / 2} bytes`);
  check('resume reports the same terminal reason', resumed.status().terminalReason === result.reason,
    String(resumed.status().terminalReason));
  check('generation indices are contiguous from 0',
    generations.every((g, i) => g.generationIndex === i), `${generations.length} records`);
  check('only the final record is terminal',
    generations.every((g, i) => (g.terminalReason === 'none') === (i !== generations.length - 1)),
    generations[generations.length - 1].terminalReason);
  check('every individual id is globally unique across generations',
    new Set(generations.flatMap((g) => g.individualIds)).size
      === generations.reduce((n, g) => n + g.individualIds.length, 0),
    `${generations.reduce((n, g) => n + g.individualIds.length, 0)} ids`);
  if (lock !== null) {
    check('history digest matches the committed lock',
      bytesToHex(framing.historyDigestBytes) === lock.historyDigest, lock.historyDigest);
    check('header digest matches the committed lock',
      bytesToHex(framing.headerDigestBytes) === lock.headerDigest, lock.headerDigest);
  }

  return {
    schema: EVOLUTION_PROBE_SCHEMA,
    mode: config.mode,
    elapsedMs: Date.now() - startedAt,
    fixture: {
      name: fixture.name,
      version: fixture.version,
      populationSeed: fixture.populationSeed,
      terrainSeed: fixture.terrainSeed,
      populationSize: fixture.populationSize,
      maxGenerations: fixture.maxGenerations,
      maxSteps: fixture.maxSteps,
      mutationProbability: fixture.mutationProbability,
      mutationMagnitude: fixture.mutationMagnitude,
    },
    versions: {
      evolutionEngineVersion: EVOLUTION_ENGINE_VERSION,
      evolutionPolicyVersion: EVOLUTION_POLICY_VERSION,
      evolutionHistoryVersion: EVOLUTION_HISTORY_VERSION,
      generationRecordVersion: GENERATION_RECORD_VERSION,
      evolutionLineageVersion: EVOLUTION_LINEAGE_VERSION,
      evaluationMetadataVersion: EVALUATION_METADATA_VERSION,
    },
    runtime: {
      physicsFlavor: header.physicsFlavor,
      packageName: header.packageName,
      rapierVersion: header.rapierVersion,
      effectiveDt: metadata.effectiveDt,
      executedSteps: metadata.executedSteps,
      worldMode: metadata.worldMode,
    },
    artifact: {
      headerByteLength: framing.headerBytes.length,
      headerDigest: bytesToHex(framing.headerDigestBytes),
      historyByteLength: bytes.length,
      historyDigest: bytesToHex(framing.historyDigestBytes),
      generationRecordCount: framing.generations.length,
    },
    advances,
    generations,
    hard,
    // Stated IN the artifact so a pasted report cannot be read as more than it is.
    disclaimer: 'Identity instrument only. Establishes no lock authority and no claim about fitness quality, diversity, convergence, mutation-default suitability, or performance — those are PR 4 empirical questions.',
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push(`# ${report.schema}`);
  lines.push('');
  lines.push(`_${report.disclaimer}_`);
  lines.push('');
  lines.push(`- fixture: **${report.fixture.name}** v${report.fixture.version} `
    + `(population seed ${report.fixture.populationSeed}, terrain seed ${report.fixture.terrainSeed}, `
    + `${report.fixture.populationSize} individuals x ${report.fixture.maxGenerations} generations x ${report.fixture.maxSteps} steps)`);
  lines.push(`- mutation: probability ${report.fixture.mutationProbability}, magnitude ${report.fixture.mutationMagnitude}`);
  lines.push(`- runtime: ${report.runtime.physicsFlavor} \`${report.runtime.packageName}@${report.runtime.rapierVersion}\`, `
    + `dt ${report.runtime.effectiveDt}, ${report.runtime.executedSteps} steps, ${report.runtime.worldMode}`);
  lines.push(`- versions: ${Object.entries(report.versions).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  lines.push('');
  lines.push(`## Artifact (${report.artifact.historyByteLength} bytes)`);
  lines.push('');
  lines.push(`- header (${report.artifact.headerByteLength} B): \`${report.artifact.headerDigest}\``);
  lines.push(`- history: \`${report.artifact.historyDigest}\``);
  lines.push('');
  lines.push('| gen | terminal | population | metadata | fitness | lineage | chained | ids |');
  lines.push('|---:|---|---|---|---|---|---|---|');
  for (const g of report.generations) {
    const short = (hex) => `${hex.slice(0, 12)}…`;
    lines.push(`| ${g.generationIndex} | ${g.terminalReason} | \`${short(g.componentDigests.population)}\` `
      + `| \`${short(g.componentDigests.evaluationMetadata)}\` | \`${short(g.componentDigests.fitnessVector)}\` `
      + `| \`${short(g.componentDigests.lineage)}\` | \`${short(g.generationDigest)}\` (from ${g.chainedFrom}) `
      + `| ${g.individualIds.join(',')} |`);
  }
  lines.push('');
  lines.push('## Lineage composition (observation)');
  lines.push('');
  for (const g of report.generations) {
    lines.push(`- gen ${g.generationIndex}: ${Object.entries(g.origins).filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`).join(', ')}; ${g.selectedLeafTotal} leaves selected in total`);
  }
  lines.push('');
  lines.push('## Hard identity checks');
  lines.push('');
  for (const c of report.hard) {
    lines.push(`- ${c.pass ? 'PASS' : 'FAIL'} — ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  }
  return lines.join('\n');
}

async function main() {
  const config = configFromArgs(process.argv.slice(2));
  const report = await runEvolutionProbe(config);
  if (config.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(toMarkdown(report));
  }
  const failed = report.hard.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(`probe-evolution: ${failed.length} hard identity check(s) FAILED`);
    process.exitCode = 1;
  }
}

// Only when invoked as a script — importing this module (the schema smoke does)
// must never start a run.
if (process.argv[1] && process.argv[1].endsWith('probe-evolution.js')) {
  await main();
}
