// PR 4D — THE EVOLUTION-HISTORY VERIFICATION SCALE INSTRUMENT.
//
// Measures the landed PR-4C persisted-history verifier — extraction, the
// resume pre-replay gate, full genuine resume, and hostile short-circuit —
// at the declared representative corpus, along two controlled scaling axes,
// and at the derived legal v1 envelope. This file owns all ambient
// elapsed-time measurement for the bench (Node-only, outside the src/sim
// ESLint ban; wall clock allowed). The ONE Date use is report metadata.
//
// Run:
//   node scripts/bench-evolution-verification.js                 # full Node matrix
//   node scripts/bench-evolution-verification.js --smoke         # tiny liveness matrix
//   node scripts/bench-evolution-verification.js --json <path>   # machine-readable report
//   node scripts/bench-evolution-verification.js --profile-one --population 256 --records 228
//
// METHODOLOGY IN BRIEF (the evidence doc carries the full contract):
//   - artifacts are constructed ONCE per row in the parent, before any
//     measured interval, written to a tmp dir, and reused byte-identically;
//     construction time is reported separately;
//   - each measured sample runs in a FRESH CHILD PROCESS (fork + IPC;
//     stdout/stderr stay diagnostic), with warm-ups discarded inside the
//     child, so GC/JIT/page state cannot carry between samples;
//   - a NO-OP BASELINE CHILD per row (loads the artifact, runs nothing)
//     isolates the operation's resident-memory high-water share:
//     process.resourceUsage().maxRSS is a process-LIFETIME mark — no
//     same-thread sampler can observe the synchronous verifier's mid-loop
//     peak, and this instrument never pretends otherwise;
//   - event-loop delay is measured with monitorEventLoopDelay PRIMED before
//     t0 and DRAINED after t1 (the histogram is timer-based: without the
//     turns it records nothing about the block);
//   - no shared-CI millisecond threshold exists anywhere here: budgets are
//     predeclared, echoed verbatim, and evaluated in the evidence doc.

import os from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fork } from 'node:child_process';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import process from 'node:process';

import { extractHistoryObservations } from './history-observations.js';
import { resumeEvolutionRun } from '../src/sim/evolution-run.js';
import { MAX_EVOLUTION_GENERATIONS } from '../src/sim/evolution-contract.js';
import { sha256 } from '../src/platform/sha256.js';
import { bytesToHex } from '../src/sim/bytes.js';
import { readSourceIdentity } from './experiment-evolution.js';
import {
  BENCH_CAPACITY_POPULATION_SEED, buildScaleArtifact, createBenchCapacityEvaluationSpec,
  deriveCapacityMaximumGenerations, readBenchRuntimeIdentity,
  withContradictionAtPair, withForeignRuntimeIdentity,
} from './bench-evolution-verification-artifacts.js';
import {
  GENUINE_CORPUS_PLANS, assertGenuineMemberShape, buildGenuineCorpusMember,
} from './bench-evolution-verification-corpus.js';

export const BENCH_SCHEMA = 'boxcar3d.bench-evolution-verification/1';

// The committed PR-4 campaign's production wall time (evidence
// totalEvolveMs, docs/ga-phase-1b-pr4-evolution-experiment-evidence.json) —
// the Model-A denominator for cumulative verifier overhead.
export const CAMPAIGN_PRODUCTION_MS = 4183321.9;

// THE PREDECLARED BUDGETS. Committed before the final measurement runs and
// echoed verbatim into every report so reviewers can verify predeclaration by
// diff. None of these is a CI threshold; they are reference-environment
// decision inputs (see docs/evolution-transition-verifier-scale-2026-07.md).
export const BUDGETS = Object.freeze([
  Object.freeze({
    id: 'B1', scope: 'genuine-corpus extraction, fresh child, Node',
    metric: 'per-member medianMs and p90Ms',
    threshold: { medianMs: 2000, p90Ms: 3000 }, unit: 'ms',
    gating: true,
    protects: 'analyst iteration in the measurement workflow (204 histories per pass)',
    consequence: 'Phase C optimization or NO-GO',
  }),
  Object.freeze({
    id: 'B2', scope: 'cumulative campaign verification — batch row in campaign proportions',
    metric: 'one-pass totalMs',
    threshold: { totalMs: 210000 }, unit: 'ms (5% of the 70-min campaign production wall)',
    gating: true,
    protects: 'campaign schedule; sustained-state realism',
    consequence: 'Phase C optimization or NO-GO',
  }),
  Object.freeze({
    id: 'B3', scope: 'legal-maximum Node extraction (population 256, derived record maximum)',
    metric: 'medianMs and highWaterDeltaBytes',
    threshold: { medianMs: 60000, highWaterDeltaBytes: 536870912 }, unit: 'ms / bytes (≈10× artifact)',
    gating: false,
    protects: 'legal-envelope operability as a batch read',
    consequence: "named restriction unless catastrophic (> 5 min or crash → NO-GO for the envelope claim)",
  }),
  Object.freeze({
    id: 'B4', scope: 'full genuine resume, population 20 (30 and 60 records)',
    metric: 'median(resumeMs) / median(productionMs), paired arms',
    threshold: { ratio: 1.35 }, unit: 'ratio',
    gating: false,
    protects: 'resume-dependent tooling (identity probes)',
    consequence: 'named restriction; the campaign itself does not resume',
  }),
  Object.freeze({
    id: 'B5', scope: 'browser representative extraction (prebuilt bytes, fresh page)',
    metric: 'median max frame gap',
    threshold: { maxGapMs: 1000 }, unit: 'ms (responsiveness bands)',
    gating: false,
    protects: 'honesty about interactive use of imported histories',
    consequence: 'named restriction (browser classified per band)',
  }),
  Object.freeze({
    id: 'B6', scope: 'representative Node memory (genuine-corpus extraction)',
    metric: 'per-row highWaterDeltaBytes',
    threshold: { highWaterDeltaBytes: 134217728 }, unit: 'bytes',
    gating: true,
    protects: 'CI/dev machines running batch verification',
    consequence: 'Phase C optimization or NO-GO',
  }),
]);

export const RESPONSIVENESS_BANDS = Object.freeze([
  Object.freeze({ maxGapMs: 100, label: 'interactive' }),
  Object.freeze({ maxGapMs: 250, label: 'noticeable' }),
  Object.freeze({ maxGapMs: 1000, label: 'severely degraded' }),
  Object.freeze({ maxGapMs: Infinity, label: 'batch/non-interactive' }),
]);

export function responsivenessBand(maxGapMs) {
  for (const band of RESPONSIVENESS_BANDS) {
    if (maxGapMs <= band.maxGapMs) return band.label;
  }
  return RESPONSIVENESS_BANDS[RESPONSIVENESS_BANDS.length - 1].label;
}

// ---------------------------------------------------------------------------
// SMALL NUMERIC HELPERS (the bench-physics conventions)
// ---------------------------------------------------------------------------

// Nearest-rank ceil(p*N), 1-indexed on sorted samples (the repo convention).
export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const sorted = [...sortedValues].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function median(values) {
  return percentile(values, 0.5);
}

const roundMs = (value) => (value === null || value === undefined ? null : Math.round(value));

function pickMemory(usage) {
  return Object.freeze({
    rss: usage.rss, heapUsed: usage.heapUsed,
    external: usage.external, arrayBuffers: usage.arrayBuffers,
  });
}

// ---------------------------------------------------------------------------
// THE PRIMED/DRAINED MEASUREMENT PRIMITIVE
// ---------------------------------------------------------------------------

const timerTurns = async (count) => {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
};

/**
 * Measure ONE operation with the event-loop histogram primed before t0 and
 * drained after t1. monitorEventLoopDelay is timer-based on this repo's
 * Node: without a turn before the block it establishes no sampling, and
 * without a turn after it the delayed timer is never recorded (review
 * reproduction: enable → 200 ms block → immediate disable ⇒ count 0; with
 * turns, max ≈ 201 ms). The turns stay OUTSIDE t0–t1. This is the single
 * implementation used by the fork children, the in-process path, and the
 * schema test's busy-block self-test.
 */
export async function measureOperationWithEventLoop(operation) {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  await timerTurns(2); // priming
  const before = process.memoryUsage();
  const t0 = performance.now();
  let outcome;
  try {
    outcome = { value: await operation() };
  } catch (err) {
    outcome = { error: err };
  }
  const t1 = performance.now();
  await timerTurns(2); // drain
  histogram.disable();
  const after = process.memoryUsage();
  return {
    elapsedMs: t1 - t0,
    outcome,
    eventLoop: Object.freeze({
      method: 'perf_hooks.monitorEventLoopDelay (resolution 1 ms); primed 2 timer turns before t0, drained 2 turns after t1',
      primed: true,
      drained: true,
      maxMs: histogram.max / 1e6,
      meanMs: histogram.mean / 1e6,
      p99Ms: histogram.percentile(99) / 1e6,
    }),
    memory: Object.freeze({
      before: pickMemory(before),
      after: pickMemory(after),
      processMaxRssKb: process.resourceUsage().maxRSS,
    }),
  };
}

// A known synchronous busy block (+ optional touched allocation) for the
// harness self-tests: proves the primed/drained histogram sees the block and
// that the same-thread interval sampler CANNOT (it never fires inside the
// synchronous section), and gives maxRSS a known allocation to register.
export function busyBlock(blockMs, allocateBytes = 0) {
  let buffer = null;
  if (allocateBytes > 0) {
    buffer = new Uint8Array(allocateBytes);
    for (let i = 0; i < buffer.length; i += 4096) buffer[i] = 1;
  }
  const end = performance.now() + blockMs;
  while (performance.now() < end) { /* synchronous by construction */ }
  return buffer; // caller holds it across any post measurement
}

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const MODES = Object.freeze(['matrix', 'extraction', 'resume-gate', 'resume-full', 'hostile', 'batch', 'profile-one']);

export function defaultConfig() {
  return Object.freeze({
    smoke: false,
    mode: 'matrix',
    samples: 5,
    samplesHeavy: 3, // D-rows, R4, browser rows
    warmups: 2,
    population: null, // single-row override
    records: null,
    json: null,
    isolation: 'fresh-child-per-sample',
    passes: Object.freeze([1, 2, 3]), // batch: measured contiguously, reported per pass
    profileOne: false,
  });
}

export function smokeConfig() {
  return Object.freeze({
    ...defaultConfig(),
    smoke: true,
    mode: 'matrix',
    samples: 3,
    samplesHeavy: 3,
    warmups: 1,
    isolation: 'in-process', // CI: tests never spawn child processes
  });
}

// Pure argv -> config (the probe-schema precedent: no side effects, loud on
// invalid input, so CI can check the structure without running the bench).
export function configFromArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      smoke: { type: 'boolean', default: false },
      samples: { type: 'string' },
      warmups: { type: 'string' },
      population: { type: 'string' },
      records: { type: 'string' },
      mode: { type: 'string' },
      json: { type: 'string' },
      'profile-one': { type: 'boolean', default: false },
      'run-one': { type: 'boolean', default: false }, // internal fork envelope
      'run-batch': { type: 'boolean', default: false }, // internal fork envelope
    },
  });
  const base = values.smoke ? smokeConfig() : defaultConfig();
  const intFlag = (name, raw, min) => {
    if (raw === undefined) return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min) {
      throw new Error(`bench: invalid --${name} '${String(raw)}' (integer >= ${min} required)`);
    }
    return parsed;
  };
  const samples = intFlag('samples', values.samples, 3);
  const warmups = intFlag('warmups', values.warmups, 0);
  const population = intFlag('population', values.population, 1);
  const records = intFlag('records', values.records, 1);
  const mode = values.mode ?? (values['profile-one'] ? 'profile-one' : base.mode);
  if (!MODES.includes(mode)) {
    throw new Error(`bench: invalid --mode '${String(mode)}' (one of ${MODES.join(', ')})`);
  }
  if ((population === null) !== (records === null)) {
    throw new Error('bench: --population and --records must be given together — a lone axis is never silently ignored');
  }
  if (records !== null && records > MAX_EVOLUTION_GENERATIONS) {
    throw new Error(`bench: --records ${records} exceeds MAX_EVOLUTION_GENERATIONS (${MAX_EVOLUTION_GENERATIONS})`);
  }
  if (values.smoke && (mode === 'batch' || mode === 'resume-full' || mode === 'profile-one')) {
    throw new Error(`bench: --mode ${mode} is not supported with --smoke (the smoke matrix carries no such rows — zero rows would be a vacuous success)`);
  }
  return Object.freeze({
    ...base,
    mode,
    samples: samples ?? base.samples,
    warmups: warmups ?? base.warmups,
    population: population ?? base.population,
    records: records ?? base.records,
    json: values.json ?? null,
    profileOne: values['profile-one'] === true,
    runOne: values['run-one'] === true,
    runBatch: values['run-batch'] === true,
  });
}

// ---------------------------------------------------------------------------
// THE ROW DEFINITIONS
// ---------------------------------------------------------------------------

// Contract-derived verifier kernel-call counts (pinned by
// tests/evolution-local-semantics.test.js A1-A4/B4 — labeled, never measured).
function contractKernelCalls(mode, recordCount, contradictionAtPair) {
  if (mode === 'hostile') return contradictionAtPair + 1;
  if (mode === 'resume-full') return 2 * recordCount - 2; // complete terminal resume
  return recordCount - 1; // extraction / resume-gate
}

// The full Node matrix. Genuine rows come from GENUINE_CORPUS_PLANS;
// synthetic rows are declared here. Every row: { id, mode, reader, ... }.
// Exported so the schema test can pin the row list itself (a silent edit to
// the matrix must fail loudly in CI, not only change the manual evidence).
export function buildNodeRows(config, derived) {
  const rows = [];
  const mfg = derived.maximumFeasibleGenerations;
  if (!config.smoke) {
    for (const plan of GENUINE_CORPUS_PLANS) {
      rows.push({
        id: `R-corpus-${plan.id}`, mode: 'extraction', reader: 'extractHistoryObservations',
        artifact: { kind: 'genuine', plan }, samples: config.samples, warmups: config.warmups,
      });
    }
    rows.push({
      id: 'R3-resume-gate-20-30', mode: 'resume-gate', reader: 'resumeEvolutionRun',
      artifact: { kind: 'synthetic', populationSize: 20, recordCount: 30, maxGenerations: 30, foreignRuntimeIdentity: true },
      samples: config.samples, warmups: config.warmups,
    });
    for (const member of ['G2', 'G6']) {
      rows.push({
        id: `R4-resume-full-${member}`, mode: 'resume-full', reader: 'resumeEvolutionRun',
        artifact: { kind: 'genuine', plan: GENUINE_CORPUS_PLANS.find((p) => p.id === member) },
        pairedProductionRun: true, samples: config.samplesHeavy, warmups: 0,
      });
    }
    for (const populationSize of [16, 64, 128, 256]) {
      rows.push({
        id: `C1-pop-${populationSize}`, mode: 'extraction', reader: 'extractHistoryObservations',
        artifact: { kind: 'synthetic', populationSize, recordCount: 16, maxGenerations: 17 },
        samples: config.samples, warmups: config.warmups,
      });
    }
    for (const recordCount of [1, 8, 16, 32, 64, 128]) {
      rows.push({
        id: `C2-records-${recordCount}`, mode: 'extraction', reader: 'extractHistoryObservations',
        artifact: { kind: 'synthetic', populationSize: 64, recordCount, maxGenerations: recordCount + 1 },
        samples: config.samples, warmups: config.warmups,
      });
    }
    rows.push({
      id: 'C3-128-64', mode: 'extraction', reader: 'extractHistoryObservations',
      artifact: { kind: 'synthetic', populationSize: 128, recordCount: 64, maxGenerations: 65 },
      samples: config.samples, warmups: config.warmups,
    });
    rows.push({
      id: 'D1-legal-max-extraction', mode: 'extraction', reader: 'extractHistoryObservations',
      artifact: {
        kind: 'synthetic', populationSize: 256, recordCount: mfg, maxGenerations: mfg,
        capacitySpec: true,
      },
      samples: config.samplesHeavy, warmups: config.warmups,
    });
    rows.push({
      id: 'D2-legal-max-resume-gate', mode: 'resume-gate', reader: 'resumeEvolutionRun',
      artifact: {
        kind: 'synthetic', populationSize: 256, recordCount: mfg, maxGenerations: mfg,
        capacitySpec: true, foreignRuntimeIdentity: true,
      },
      samples: config.samplesHeavy, warmups: config.warmups,
    });
    for (const k of [0, 30]) {
      for (const reader of ['extractHistoryObservations', 'resumeEvolutionRun']) {
        rows.push({
          id: `E-hostile-k${k}-${reader === 'extractHistoryObservations' ? 'extraction' : 'resume'}`,
          mode: 'hostile', reader,
          artifact: {
            kind: 'synthetic', populationSize: 64, recordCount: 32, maxGenerations: 33,
            contradictionAtPair: k,
          },
          samples: config.samplesHeavy, warmups: config.warmups,
        });
      }
    }
  } else {
    // S1 — CI liveness only: every path executes at the smallest shape.
    rows.push(
      {
        id: 'S1-extraction', mode: 'extraction', reader: 'extractHistoryObservations',
        artifact: { kind: 'synthetic', populationSize: 4, recordCount: 3, maxGenerations: 4 },
        samples: config.samples, warmups: config.warmups,
      },
      {
        id: 'S1-resume-gate', mode: 'resume-gate', reader: 'resumeEvolutionRun',
        artifact: { kind: 'synthetic', populationSize: 4, recordCount: 3, maxGenerations: 4, foreignRuntimeIdentity: true },
        samples: config.samples, warmups: config.warmups,
      },
      {
        id: 'S1-hostile-k0-extraction', mode: 'hostile', reader: 'extractHistoryObservations',
        artifact: { kind: 'synthetic', populationSize: 4, recordCount: 3, maxGenerations: 4, contradictionAtPair: 0 },
        samples: config.samples, warmups: config.warmups,
      },
      {
        id: 'S1-hostile-k0-resume', mode: 'hostile', reader: 'resumeEvolutionRun',
        artifact: { kind: 'synthetic', populationSize: 4, recordCount: 3, maxGenerations: 4, contradictionAtPair: 0 },
        samples: config.samples, warmups: config.warmups,
      },
      // A genuine full-resume row at smoke scale: the only smoke row whose
      // `physics: true` label is exercised, and the cheapest proof that a
      // production-run artifact resumes cleanly end to end.
      {
        id: 'S1-resume-full', mode: 'resume-full', reader: 'resumeEvolutionRun',
        artifact: {
          kind: 'genuine',
          plan: {
            id: 'S-genuine', label: 'smoke-genuine', probability: 0.05, magnitude: 0.05,
            generations: 2, populationSeed: 20260801, terrainSeed: 20260809,
          },
        },
        samples: config.samples, warmups: config.warmups,
      },
    );
  }
  return rows;
}

// A single-row population/records CLI override. records + 1 keeps the final
// record partial ('none'); at the policy maximum the artifact is TERMINAL
// at the cap instead — a 1025th generation cannot exist (external review
// finding 3: the parser accepted a 1024-record row it could not build).
export function customSyntheticRow(population, records, samples, warmups) {
  return {
    id: `custom-${population}-${records}`, mode: 'extraction',
    reader: 'extractHistoryObservations',
    artifact: {
      kind: 'synthetic', populationSize: population, recordCount: records,
      maxGenerations: Math.min(records + 1, MAX_EVOLUTION_GENERATIONS),
    },
    samples, warmups,
  };
}

// ---------------------------------------------------------------------------
// THE FORK ENVELOPES (the child's side)
// ---------------------------------------------------------------------------

async function operateOnce(reader, bytes) {
  if (reader === 'extractHistoryObservations') return extractHistoryObservations(bytes);
  return resumeEvolutionRun(bytes);
}

function verdictFromOutcome(outcome) {
  if (outcome.error) {
    const err = outcome.error;
    return Object.freeze({
      refused: err && typeof err.code === 'string' ? err.code : 'unknown',
      rule: err && err.context && typeof err.context.rule === 'string' ? err.context.rule : null,
      sourceGenerationIndex: err && err.context && Number.isInteger(err.context.sourceGenerationIndex)
        ? err.context.sourceGenerationIndex : null,
      field: err && err.context && typeof err.context.field === 'string' ? err.context.field : null,
    });
  }
  const value = outcome.value;
  return Object.freeze({
    success: true,
    historyDigestHex: value && value.historyDigestBytes ? bytesToHex(value.historyDigestBytes) : null,
  });
}

// One measured sample in a fresh process. The warm-ups run the SAME operation
// discarded; the measured pass is wrapped by the primed/drained primitive.
async function runOneSample(envelope) {
  const bytes = envelope.artifactPath ? readFileSync(envelope.artifactPath) : null;
  if (envelope.mode === 'noop-baseline') {
    return {
      ok: true, noop: true,
      processMaxRssKb: process.resourceUsage().maxRSS,
      memory: { current: pickMemory(process.memoryUsage()) },
    };
  }
  if (envelope.mode === 'production-run') {
    // R4 arm A: a fresh production run to the same record count — the paired
    // denominator. evolveMs is the production wall time for these records.
    const member = await buildGenuineCorpusMember(envelope.plan, { protocolKind: envelope.protocolKind ?? 'full' });
    return { ok: true, elapsedMs: member.provenance.evolveMs, provenance: member.provenance };
  }
  for (let i = 0; i < envelope.warmups; i += 1) {
    try { await operateOnce(envelope.reader, bytes); } catch { /* warm-up verdicts are discarded by design */ }
  }
  const measured = await measureOperationWithEventLoop(() => operateOnce(envelope.reader, bytes));
  return {
    ok: true,
    elapsedMs: measured.elapsedMs,
    verdict: verdictFromOutcome(measured.outcome),
    eventLoop: measured.eventLoop,
    memory: measured.memory,
  };
}

// The long-lived batch process: one process, the whole genuine corpus in
// memory, extractions in campaign proportions, passes measured contiguously.
export async function runBatchSample(envelope) {
  const members = envelope.members.map((m) => ({
    ...m, bytes: readFileSync(m.path),
  }));
  const thirty = members.filter((m) => m.recordCount === 30);
  const sixty = members.filter((m) => m.recordCount === 60);
  // Campaign proportions, fixed disclosed round-robin: 156 draws over the
  // four 30-record members, 48 over the four 60-record members.
  const draws = [];
  for (let i = 0; i < 156; i += 1) draws.push(thirty[i % thirty.length]);
  for (let i = 0; i < 48; i += 1) draws.push(sixty[i % sixty.length]);
  const heapUsedBefore = process.memoryUsage().heapUsed;
  let betweenOpSamples = 0;
  const sampler = setInterval(() => { betweenOpSamples += 1; }, 10);
  try {
    const passes = [];
    const firstDigests = {};
    for (let passIndex = 1; passIndex <= envelope.maxPass; passIndex += 1) {
      const perArtifactMs = [];
      const passStart = performance.now();
      for (const member of draws) {
        const t0 = performance.now();
        const result = await extractHistoryObservations(member.bytes); // sequential by design — the batch IS one long-lived reader
        perArtifactMs.push(performance.now() - t0);
        if (!firstDigests[member.id]) firstDigests[member.id] = bytesToHex(result.historyDigestBytes);
      }
      passes.push(Object.freeze({
        passIndex,
        draws: draws.length,
        perArtifactMs: perArtifactMs.map(roundMs),
        totalMs: performance.now() - passStart,
      }));
    }
    const heapUsedAfter = process.memoryUsage().heapUsed;
    return {
      ok: true,
      passes,
      firstDigests,
      betweenOpSamples,
      memory: { heapUsedBefore, heapUsedAfter, processMaxRssKb: process.resourceUsage().maxRSS },
    };
  } finally {
    clearInterval(sampler);
  }
}

// The batch REPORT section, assembled from the child's raw result. Exported
// so the schema test can pin its invariants (declaredPasses mirrors the raw
// pass array; firstDigests bind draws to members; per-pass medians present).
export function assembleBatchReport(batchResult) {
  return Object.freeze({
    campaignProportions: Object.freeze({ thirty: 156, sixty: 48 }),
    declaredPasses: batchResult.passes.length,
    passes: batchResult.passes.map((p) => Object.freeze({
      ...p, totalMs: roundMs(p.totalMs),
      medianPerArtifactMs: roundMs(median(p.perArtifactMs)),
      p90PerArtifactMs: roundMs(percentile(p.perArtifactMs, 0.9)),
    })),
    firstDigests: batchResult.firstDigests,
    betweenOpSamples: batchResult.betweenOpSamples,
    memory: Object.freeze({
      heapUsedBefore: batchResult.memory.heapUsedBefore,
      heapUsedAfter: batchResult.memory.heapUsedAfter,
      processMaxRssBytes: batchResult.memory.processMaxRssKb * 1024,
    }),
  });
}

// ---------------------------------------------------------------------------
// THE PARENT'S CHILD PLUMBING
// ---------------------------------------------------------------------------

const MODULE_PATH = fileURLToPath(import.meta.url);

function forkChild(kind, envelope, { execArgv = [], timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(MODULE_PATH, [kind === 'batch' ? '--run-batch' : '--run-one'], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      execArgv,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bench: child timed out after ${timeoutMs} ms (${kind} ${envelope.id ?? ''})`));
    }, timeoutMs);
    let settled = false;
    let result = null;
    // Resolve on EXIT, not on the message: the child flushes exit-hook work
    // (e.g. --cpu-prof's file write) only as it actually exits — a parent
    // that proceeds at the message races that flush.
    child.on('message', (r) => { result = r; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result !== null) {
        resolve(result);
      } else {
        reject(new Error(`bench: child exited before reporting (code ${String(code)}, signal ${String(signal)}) — ${kind} ${envelope.id ?? ''}`));
      }
    });
    child.send(envelope);
  });
}

// ---------------------------------------------------------------------------
// REPORT ASSEMBLY GUARDS (the deliberate-defect teeth live here)
// ---------------------------------------------------------------------------

function consistentVerdict(verdicts, rowId) {
  const first = JSON.stringify(verdicts[0]);
  for (const verdict of verdicts) {
    if (JSON.stringify(verdict) !== first) {
      throw new Error(`bench: row '${rowId}' reported inconsistent verdicts across samples — ${first} vs ${JSON.stringify(verdict)}`);
    }
  }
  return verdicts[0];
}

// The row contract: every mode has exactly one honest outcome. A wrong
// verdict means the artifact or the row is mislabeled — fail loudly rather
// than record a meaningless timing (e.g. a resume-gate row that SUCCEEDED
// would have run full replay, and a hostile row that passed would not be
// hostile at all).
function assertExpectedVerdict(row, verdict) {
  if (row.mode === 'extraction' || row.mode === 'resume-full') {
    if (verdict.success !== true) {
      throw new Error(`bench: row '${row.id}' (${row.mode}) must succeed; got ${JSON.stringify(verdict)}`);
    }
    return;
  }
  if (row.mode === 'resume-gate') {
    if (verdict.refused !== 'runtimeVersionMismatch') {
      throw new Error(`bench: row '${row.id}' must refuse runtimeVersionMismatch at the pre-replay boundary; got ${JSON.stringify(verdict)}`);
    }
    return;
  }
  if (row.mode === 'hostile') {
    if (verdict.refused !== 'malformedHistory'
      || (verdict.rule !== 'persistedTransitionPopulationMismatch' && verdict.rule !== 'persistedTransitionLineageMismatch')
      || verdict.sourceGenerationIndex !== row.artifact.contradictionAtPair) {
      throw new Error(`bench: row '${row.id}' must refuse malformedHistory with a persistedTransition* rule at pair ${row.artifact.contradictionAtPair}; got ${JSON.stringify(verdict)}`);
    }
  }
}

/**
 * Assemble one report row from raw child results. The guards here are the
 * non-vacuous teeth: sample-count honesty (defect 3), verdict consistency,
 * primed/drained event-loop evidence (defects 8/9), and the no-op baseline
 * requirement for child-mode memory claims (defect 5).
 * `actualRecordCount` is the CONSTRUCTED artifact's measured record count
 * (genuine rows: the run's advanceCount — never the plan's requested
 * generations, external review finding 1). Synthetic callers may omit it;
 * it then falls back to the row's declared shape.
 */
export function assembleRow(row, samples, noopBaseline, config, actualRecordCount = undefined) {
  if (samples.length !== row.samples) {
    throw new Error(`bench: row '${row.id}' produced ${samples.length} samples, expected ${row.samples} — warm-up leakage or a lost sample`);
  }
  const inProcess = config.isolation === 'in-process';
  const memoryClaimed = !inProcess;
  if (memoryClaimed && (!noopBaseline || !Number.isFinite(noopBaseline.processMaxRssKb))) {
    throw new Error(`bench: row '${row.id}' is missing its no-op baseline child — the high-water delta is meaningless without it`);
  }
  for (const sample of samples) {
    if (!sample.eventLoop || sample.eventLoop.primed !== true || sample.eventLoop.drained !== true) {
      throw new Error(`bench: row '${row.id}' has a sample without primed/drained event-loop evidence`);
    }
  }
  const recordCount = actualRecordCount ?? row.artifact.recordCount ?? row.artifact.plan?.generations;
  const samplesMs = samples.map((s) => roundMs(s.elapsedMs));
  const maxRssKb = Math.max(...samples.map((s) => s.memory.processMaxRssKb));
  const verdict = consistentVerdict(samples.map((s) => s.verdict), row.id);
  assertExpectedVerdict(row, verdict);
  return Object.freeze({
    id: row.id,
    mode: row.mode,
    reader: row.reader,
    environment: 'node',
    physics: row.mode === 'resume-full',
    verifierKernelCalls: contractKernelCalls(row.mode, recordCount, row.artifact.contradictionAtPair),
    verifierKernelCallsBasis: 'contract-derived (tests/evolution-local-semantics.test.js A1-A4/B4), not measured',
    verdict,
    samplesMs,
    medianMs: roundMs(median(samplesMs)),
    p90Ms: roundMs(percentile(samplesMs, 0.9)),
    eventLoop: Object.freeze({
      method: `${samples[0].eventLoop.method}; row stats are max-across-samples of the per-sample histogram values`,
      primed: true,
      drained: true,
      maxMs: roundMs(Math.max(...samples.map((s) => s.eventLoop.maxMs))),
      meanMs: roundMs(Math.max(...samples.map((s) => s.eventLoop.meanMs))),
      p99Ms: roundMs(Math.max(...samples.map((s) => s.eventLoop.p99Ms))),
    }),
    memory: memoryClaimed ? Object.freeze({
      method: 'before/after process.memoryUsage (from the FINAL sample) + max-across-samples process.resourceUsage().maxRSS (process lifetime, fresh child per sample) vs a no-op baseline child; operation-moment heap peaks unavailable — no same-thread sampler claim',
      before: samples[samples.length - 1].memory.before,
      after: samples[samples.length - 1].memory.after,
      processMaxRssBytes: maxRssKb * 1024,
      noopBaselineMaxRssBytes: noopBaseline.processMaxRssKb * 1024,
      highWaterDeltaBytes: (maxRssKb - noopBaseline.processMaxRssKb) * 1024,
    }) : 'unavailable: in-process isolation (CI smoke); child-mode rows carry the measured fields',
  });
}

// The corpus guard (defects 4/12): distinct identities and complete genuine
// provenance — one convenient history must not impersonate a stratified
// corpus. The resume tooth behind it (synthetic bytes diverge under replay)
// is exercised directly by the schema test and by R4's success verdict.
export function validateCorpusMembers(members) {
  const digests = new Set();
  for (const member of members) {
    const p = member.provenance;
    if (!p || p.construction !== 'production-run-genuine'
      || !Number.isInteger(p.populationSeed) || !Number.isInteger(p.terrainSeed)
      || !Number.isInteger(p.generations) || !Number.isFinite(p.probability) || !Number.isFinite(p.magnitude)
      || !Number.isInteger(p.advanceCount) || typeof p.terminalReason !== 'string'
      || p.advanceCount !== p.generations || p.terminalReason !== 'generationLimitReached') {
      throw new Error(`bench: corpus member '${member.id}' lacks complete, campaign-shaped production-run provenance (construction, seeds, generations, arm, MEASURED advanceCount and terminalReason)`);
    }
    if (digests.has(member.sha256Hex)) {
      throw new Error(`bench: corpus members '${member.id}' duplicates another member's digest — a substituted corpus is not a corpus`);
    }
    digests.add(member.sha256Hex);
  }
  return true;
}

// ---------------------------------------------------------------------------
// THE ORCHESTRATION
// ---------------------------------------------------------------------------

async function sha256Hex(bytes) {
  return bytesToHex(await sha256(bytes));
}

// Exported (with an injectable genuine builder) so the schema test can prove
// a mis-shaped genuine run can never be published at planned dimensions.
export async function constructRowArtifact(row, runtime, tmpDir, corpusMembers, { smoke = false, genuineBuilder = buildGenuineCorpusMember } = {}) {
  const spec = row.artifact;
  if (spec.kind === 'genuine') {
    const cached = corpusMembers.get(spec.plan.id);
    if (cached) return cached;
    const built = await genuineBuilder(spec.plan, { protocolKind: smoke ? 'smoke' : 'full' });
    // The campaign-shape gate (corpus.js): a run that terminated EARLY is
    // refused here, before it can become an artifact record — no Node row,
    // batch draw, or budget can ever publish it at its planned dimensions.
    assertGenuineMemberShape(spec.plan, built.provenance);
    const record = {
      id: spec.plan.id,
      kind: 'genuine',
      bytes: built.bytes,
      provenance: built.provenance,
      // MEASURED by the run, never asserted from the plan.
      recordCount: built.provenance.advanceCount,
      terminalReason: built.provenance.terminalReason,
      populationSize: built.provenance.populationSize,
      sha256Hex: await sha256Hex(built.bytes),
      constructionMs: built.provenance.evolveMs,
    };
    corpusMembers.set(spec.plan.id, record);
    return record;
  }
  const startedAt = performance.now();
  // capacitySpec rows follow the authoritative capacity-test configuration
  // (seeds 20260740/20260741, flat 45-step spec) — the exact shape the 228/912
  // boundaries were derived under.
  let built = await buildScaleArtifact(runtime, {
    populationSize: spec.populationSize,
    recordCount: spec.recordCount,
    maxGenerations: spec.maxGenerations,
    ...(spec.capacitySpec ? {
      seed: BENCH_CAPACITY_POPULATION_SEED,
      spec: createBenchCapacityEvaluationSpec(),
    } : {}),
  });
  let bytes = built.bytes;
  const reforged = spec.foreignRuntimeIdentity === true || spec.contradictionAtPair !== undefined;
  if (spec.foreignRuntimeIdentity) bytes = await withForeignRuntimeIdentity(bytes);
  if (spec.contradictionAtPair !== undefined) bytes = await withContradictionAtPair(bytes, spec.contradictionAtPair);
  return {
    id: row.id,
    kind: 'synthetic',
    bytes,
    recordCount: spec.recordCount,
    populationSize: spec.populationSize,
    maxGenerations: spec.maxGenerations,
    terminalReason: built.terminalReason,
    foreignRuntimeIdentity: spec.foreignRuntimeIdentity === true,
    contradictionAtPair: spec.contradictionAtPair ?? null,
    sha256Hex: await sha256Hex(bytes),
    // A reforged artifact is never successfully read, so no reader-reported
    // digest exists — but its format history digest is the 32-byte TRAILER
    // of the artifact (assembleHistory appends it outside the hashed body,
    // src/sim/evolution-history.js). Record it from there, honestly sourced.
    historyDigestHex: reforged ? bytesToHex(bytes.slice(bytes.length - 32)) : null,
    constructionMs: performance.now() - startedAt,
  };
}

function artifactReportEntry(artifact) {
  return Object.freeze({
    id: artifact.id,
    construction: artifact.kind === 'genuine' ? 'production-run-genuine' : 'kernel-honest-synthetic',
    populationSize: artifact.populationSize,
    recordCount: artifact.recordCount,
    maxGenerations: artifact.maxGenerations ?? null,
    byteLength: artifact.bytes.length,
    sha256Hex: artifact.sha256Hex,
    historyDigestHex: artifact.historyDigestHex ?? null,
    terminalReason: artifact.terminalReason ?? null,
    provenance: artifact.provenance ?? null,
    foreignRuntimeIdentity: artifact.foreignRuntimeIdentity ?? null,
    contradictionAtPair: artifact.contradictionAtPair ?? null,
    constructionMs: roundMs(artifact.constructionMs),
  });
}

async function runNodeRow(row, artifact, config, emit) {
  const artifactPath = join(config.tmpDir, `${row.id}.bin`);
  writeFileSync(artifactPath, artifact.bytes);
  const envelopeBase = {
    id: row.id, mode: row.mode, reader: row.reader,
    artifactPath, warmups: row.warmups,
  };
  const samples = [];
  if (config.isolation === 'in-process') {
    for (let i = 0; i < row.samples; i += 1) {
      emit({ type: 'sample-start', row: row.id, index: i });
      // In-process mirrors the per-child semantics exactly: each sample gets
      // its own discarded warm-ups, then one measured pass.
      samples.push(await runOneSample({ ...envelopeBase }));
    }
  } else {
    for (let i = 0; i < row.samples; i += 1) {
      emit({ type: 'sample-start', row: row.id, index: i });
      samples.push(await forkChild('one', { ...envelopeBase }, { timeoutMs: 900000 }));
    }
  }
  const noopBaseline = config.isolation === 'in-process'
    ? null
    : await forkChild('one', { id: `${row.id}-noop`, mode: 'noop-baseline', artifactPath }, { timeoutMs: 120000 });
  return assembleRow(row, samples, noopBaseline, config, artifact.recordCount);
}

async function runPairedResumeRows(row, artifact, config, emit) {
  // R4: arm A = fresh production run to the same record count; arm B = full
  // resume of the preconstructed genuine artifact. Same fresh-process
  // isolation, same sample count, zero per-child warm-ups (physics dominates;
  // both arms treated identically), interleaved with the starting arm
  // alternated per pair index.
  const artifactPath = join(config.tmpDir, `${row.id}.bin`);
  writeFileSync(artifactPath, artifact.bytes);
  const armA = [];
  const armB = [];
  for (let i = 0; i < row.samples; i += 1) {
    const firstA = i % 2 === 0;
    for (const arm of firstA ? ['A', 'B'] : ['B', 'A']) {
      emit({ type: 'sample-start', row: row.id, arm, index: i });
      if (arm === 'A') {
        armA.push(await forkChild('one', {
          id: `${row.id}-A${i}`, mode: 'production-run', plan: row.artifact.plan,
        }, { timeoutMs: 900000 }));
      } else {
        armB.push(await forkChild('one', {
          id: `${row.id}-B${i}`, mode: 'resume-full', reader: 'resumeEvolutionRun',
          artifactPath, warmups: 0,
        }, { timeoutMs: 900000 }));
      }
    }
  }
  const noopBaseline = await forkChild('one', { id: `${row.id}-noop`, mode: 'noop-baseline', artifactPath }, { timeoutMs: 120000 });
  const resumeRow = assembleRow(row, armB, noopBaseline, config, artifact.recordCount);
  const productionMs = armA.map((s) => roundMs(s.elapsedMs));
  const resumeMs = resumeRow.samplesMs;
  return Object.freeze({
    ...resumeRow,
    pairedResume: Object.freeze({
      armA_productionMs: productionMs,
      armB_resumeMs: resumeMs,
      medianProductionMs: roundMs(median(productionMs)),
      medianResumeMs: roundMs(median(resumeMs)),
      medianRatio: Math.round((median(resumeMs) / median(productionMs)) * 10000) / 10000,
      samples: row.samples,
      warmups: row.warmups,
      isolation: config.isolation,
      interleaving: 'arms alternate per sample; starting arm alternates per pair index',
    }),
  });
}

// Every threshold comes from BUDGETS itself — the evaluation never
// re-hardcodes a number the report echoes as predeclared (a desync would
// make the report gate on different numbers than it displays).
function thresholdFor(id) {
  const budget = BUDGETS.find((b) => b.id === id);
  if (!budget) throw new Error(`bench: unknown budget id '${String(id)}'`);
  return budget.threshold;
}

export function evaluateBudgets(report) {
  const outcomes = [];
  const corpusRows = report.rows.filter((r) => r.id.startsWith('R-corpus-') && !r.id.endsWith('-repeat'));
  const b1 = thresholdFor('B1');
  outcomes.push(Object.freeze({
    id: 'B1', gating: true,
    perMember: corpusRows.map((r) => Object.freeze({ id: r.id, medianMs: r.medianMs, p90Ms: r.p90Ms })),
    pass: corpusRows.length === 0 ? null : corpusRows.every((r) => r.medianMs <= b1.medianMs && r.p90Ms <= b1.p90Ms),
    ...(corpusRows.length === 0 ? { note: 'not measured in this configuration' } : {}),
  }));
  const b2 = thresholdFor('B2');
  const firstPass = report.batch && report.batch.passes.length > 0
    ? report.batch.passes.find((p) => p.passIndex === 1)
    : null;
  const onePass = firstPass ? firstPass.totalMs : null;
  outcomes.push(Object.freeze({
    id: 'B2', gating: true,
    onePassTotalMs: onePass === null ? null : roundMs(onePass),
    pass: onePass === null ? null : onePass <= b2.totalMs,
    ...(onePass === null ? { note: report.batch ? 'batch produced no passes' : 'not measured in this configuration' } : {}),
  }));
  const b3 = thresholdFor('B3');
  const d1 = report.rows.find((r) => r.id === 'D1-legal-max-extraction');
  const d1Delta = d1 && d1.memory && Number.isFinite(d1.memory.highWaterDeltaBytes)
    ? d1.memory.highWaterDeltaBytes : null;
  outcomes.push(Object.freeze({
    id: 'B3', gating: false,
    medianMs: d1 ? d1.medianMs : null,
    highWaterDeltaBytes: d1Delta,
    // null when the memory channel is unmeasured (in-process) — never a
    // false failure beside a null echo.
    pass: d1 && d1Delta !== null ? (d1.medianMs <= b3.medianMs && d1Delta <= b3.highWaterDeltaBytes) : null,
    ...(d1 ? (d1Delta === null ? { note: 'memory channel unavailable in this isolation mode' } : {}) : { note: 'not measured in this configuration' }),
  }));
  const b4 = thresholdFor('B4');
  const r4rows = report.rows.filter((r) => r.pairedResume);
  outcomes.push(Object.freeze({
    id: 'B4', gating: false,
    perShape: r4rows.map((r) => Object.freeze({ id: r.id, ratio: r.pairedResume.medianRatio })),
    pass: r4rows.length > 0 ? r4rows.every((r) => r.pairedResume.medianRatio <= b4.ratio) : null,
    ...(r4rows.length === 0 ? { note: 'not measured in this configuration' } : {}),
  }));
  outcomes.push(Object.freeze({
    id: 'B5', gating: false, pass: null,
    note: 'browser rows are merged by scripts/bench-evolution-verification-browser.js — pending in a Node-only report',
  }));
  const b6 = thresholdFor('B6');
  const b6Rows = corpusRows.map((r) => Object.freeze({
    id: r.id,
    highWaterDeltaBytes: r.memory && Number.isFinite(r.memory.highWaterDeltaBytes) ? r.memory.highWaterDeltaBytes : null,
  }));
  outcomes.push(Object.freeze({
    id: 'B6', gating: true,
    perRow: b6Rows,
    pass: corpusRows.length === 0 ? null
      : (b6Rows.some((r) => r.highWaterDeltaBytes === null) ? null
        : b6Rows.every((r) => r.highWaterDeltaBytes <= b6.highWaterDeltaBytes)),
    ...(corpusRows.length === 0 ? { note: 'not measured in this configuration' }
      : (b6Rows.some((r) => r.highWaterDeltaBytes === null) ? { note: 'memory channel unavailable in this isolation mode' } : {})),
  }));
  return Object.freeze(outcomes);
}

function collectMeta(config, extra = {}) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const identity = readSourceIdentity();
  return Object.freeze({
    generatedUtc: new Date().toISOString(), // the ONE Date use — report metadata, outside every deterministic input
    commit: identity.available ? identity.commit : 'unavailable',
    dirtyTree: identity.available ? !identity.clean : 'unavailable',
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: { model: os.cpus()[0]?.model ?? 'unknown', count: os.cpus().length },
    node: process.version,
    rapier: {
      compat: pkg.dependencies['@dimforge/rapier3d-compat'],
      deterministicCompat: pkg.dependencies['@dimforge/rapier3d-deterministic-compat'],
    },
    benchmarkConfig: config,
    isolation: config.isolation,
    gcDisclosure: 'normal runtime; no --expose-gc; no forced collection; fresh child process per measured sample (in-process for CI smoke)',
    memoryMethod: 'before/after process.memoryUsage + process.resourceUsage().maxRSS (process-lifetime high-water, fresh child) vs no-op baseline child; operation-moment heap peaks are unavailable — the PR-4C verifier is synchronous and no same-thread sampler can observe them',
    eventLoopMethod: 'perf_hooks.monitorEventLoopDelay (resolution 1 ms), primed 2 timer turns before t0 and drained 2 turns after t1; turns excluded from t0–t1',
    percentileMethod: 'nearest-rank ceil(p*N), 1-indexed on sorted samples; median = p0.5, upper = p90',
    argv: process.argv.slice(2),
    ...extra,
  });
}

/**
 * Run the benchmark. `config.tmpDir` is created and cleaned by the caller's
 * CLI path; `config.onEvent` receives { type: 'artifact-built' | 'sample-start', ... }
 * progress events (the schema test asserts construction precedes every
 * measured interval — deliberate defect 1's tooth).
 */
export async function runBenchmark(config) {
  const emit = config.onEvent ?? (() => {});
  const tmpDir = config.tmpDir ?? join(os.tmpdir(), `boxcar3d-bench-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  const working = { ...config, tmpDir };
  const artifacts = new Map();
  const corpusMembers = new Map();
  const report = {
    schema: BENCH_SCHEMA,
    meta: null,
    budgets: BUDGETS,
    capacity: null,
    artifacts: [],
    rows: [],
    batch: null,
    cumulative: null,
    budgetOutcomes: null,
  };

  // Construction phase — NEVER inside a measured reader interval.
  const runtime = await readBenchRuntimeIdentity();
  const derived256 = deriveCapacityMaximumGenerations(256);
  const derived64 = deriveCapacityMaximumGenerations(64);
  const derivedSmall = deriveCapacityMaximumGenerations(4);
  report.capacity = Object.freeze({
    population256: { ...derived256, expectedLiteral: 228, matchesExpected: derived256.maximumFeasibleGenerations === 228 },
    population64: { ...derived64, expectedLiteral: 912, matchesExpected: derived64.maximumFeasibleGenerations === 912 },
    population4: { ...derivedSmall, note: 'exercises the no-refusal policy-maximum path' },
  });
  const rows = buildNodeRows(working, derived256);
  const modeFilter = (row) => {
    if (working.mode === 'matrix') return true;
    if (working.mode === 'extraction') return row.mode === 'extraction';
    if (working.mode === 'resume-gate') return row.mode === 'resume-gate';
    if (working.mode === 'resume-full') return row.mode === 'resume-full';
    if (working.mode === 'hostile') return row.mode === 'hostile';
    return false; // batch handled separately
  };
  const selectedRows = rows.filter(modeFilter);
  // The batch row needs the whole genuine corpus even when no corpus row is
  // selected (mode 'batch'); in matrix mode this pre-build is the same cache
  // the R-corpus/R4 rows reuse.
  const batchPlanned = (working.mode === 'matrix' || working.mode === 'batch') && !working.smoke;
  if (batchPlanned) {
    for (const plan of GENUINE_CORPUS_PLANS) {
      const artifact = await constructRowArtifact(
        { id: `corpus-${plan.id}`, artifact: { kind: 'genuine', plan } },
        runtime, tmpDir, corpusMembers, working,
      );
      emit({ type: 'artifact-built', row: `corpus-${plan.id}`, artifact: artifact.sha256Hex });
    }
  }
  for (const row of selectedRows) {
    const artifact = await constructRowArtifact(row, runtime, tmpDir, corpusMembers, working);
    emit({ type: 'artifact-built', row: row.id, artifact: artifact.sha256Hex });
    artifacts.set(row.id, artifact);
  }
  // A single-row population/records override appends a custom synthetic row.
  if (working.population !== null && working.records !== null) {
    const row = customSyntheticRow(working.population, working.records, working.samples, working.warmups);
    const artifact = await constructRowArtifact(row, runtime, tmpDir, corpusMembers, working);
    emit({ type: 'artifact-built', row: row.id, artifact: artifact.sha256Hex });
    artifacts.set(row.id, artifact);
    selectedRows.push(row);
  }

  // Measured phase.
  for (const row of selectedRows) {
    const artifact = artifacts.get(row.id);
    const measured = row.pairedProductionRun === true
      ? await runPairedResumeRows(row, artifact, working, emit)
      : await runNodeRow(row, artifact, working, emit);
    report.rows.push(measured);
  }
  // The drift witness: the first corpus member's row is re-measured as the
  // last row, bounding cross-run drift (thermal/JIT/page-cache) within the
  // session. It is excluded from B1 aggregation by its '-repeat' suffix.
  if (working.mode === 'matrix' && !working.smoke) {
    const g2Row = rows.find((r) => r.id === 'R-corpus-G2');
    const repeat = { ...g2Row, id: 'R-corpus-G2-repeat' };
    report.rows.push(await runNodeRow(repeat, corpusMembers.get('G2'), working, emit));
  }
  // historyDigestHex backfill from extraction samples' verdicts.
  for (const row of selectedRows) {
    const artifact = artifacts.get(row.id);
    const measured = report.rows.find((r) => r.id === row.id);
    if (artifact && measured && measured.verdict && measured.verdict.historyDigestHex && !artifact.historyDigestHex) {
      artifact.historyDigestHex = measured.verdict.historyDigestHex;
    }
  }

  // The batch row (long-lived process, campaign proportions).
  if ((working.mode === 'matrix' || working.mode === 'batch') && !working.smoke) {
    const memberEnvelopes = GENUINE_CORPUS_PLANS.map((plan) => ({
      // The batch draw classes ride the CONSTRUCTED member's measured record
      // count, never the plan's requested generations (external review
      // finding 1); the shape gate upstream guarantees they agree.
      id: plan.id, path: join(tmpDir, `batch-${plan.id}.bin`),
      recordCount: corpusMembers.get(plan.id).recordCount,
    }));
    for (const envelope of memberEnvelopes) {
      writeFileSync(envelope.path, corpusMembers.get(envelope.id).bytes);
    }
    emit({ type: 'artifact-built', row: 'batch-corpus', artifact: 'see members' });
    const batchResult = working.isolation === 'in-process'
      ? await runBatchSample({ members: memberEnvelopes, maxPass: Math.max(...working.passes) })
      : await forkChild('batch', { members: memberEnvelopes, maxPass: Math.max(...working.passes) }, { timeoutMs: 3600000 });
    report.batch = assembleBatchReport(batchResult);
    const pass1 = batchResult.passes.find((p) => p.passIndex === 1).totalMs;
    const meanPerPass = batchResult.passes.reduce((s, p) => s + p.totalMs, 0) / batchResult.passes.length;
    report.cumulative = Object.freeze({
      perPassMs: roundMs(pass1),
      twoPassCalculatedMs: roundMs(2 * meanPerPass),
      threePassMs: roundMs(batchResult.passes.reduce((s, p) => s + p.totalMs, 0)),
      campaignProductionMs: CAMPAIGN_PRODUCTION_MS,
      overheadFractionPerPass: Math.round((pass1 / CAMPAIGN_PRODUCTION_MS) * 10000) / 10000,
      maxAffordablePassesWithinB2: Math.max(0, Math.floor(thresholdFor('B2').totalMs / meanPerPass)),
      formula: 'overhead = passes × perPassMs; passes = 1 if downstream analyses reuse each verified extraction (declared handoff), else the declared pass count',
    });
    // Corpus identities backfilled from the batch child's first extractions.
    for (const [id, hex] of Object.entries(batchResult.firstDigests)) {
      const member = corpusMembers.get(id);
      if (member && !member.historyDigestHex) member.historyDigestHex = hex;
    }
  }

  // Artifact identities, deduplicated by digest (corpus members are shared
  // by the R-corpus rows, R4 and the batch row).
  const uniqueArtifacts = new Map();
  for (const artifact of [...corpusMembers.values(), ...artifacts.values()]) {
    if (!uniqueArtifacts.has(artifact.sha256Hex)) uniqueArtifacts.set(artifact.sha256Hex, artifact);
  }
  report.artifacts = [...uniqueArtifacts.values()].map(artifactReportEntry);
  // Corpus validation (defects 4/12) — genuine members only, when present.
  const genuineMembers = [...corpusMembers.values()];
  if (genuineMembers.length > 0) validateCorpusMembers(genuineMembers);
  report.meta = collectMeta(working);
  report.budgetOutcomes = evaluateBudgets(report);
  return Object.freeze(report);
}

// ---------------------------------------------------------------------------
// --profile-one (attribution-only — NEVER written into evidence rows)
// ---------------------------------------------------------------------------

async function profileOne(config) {
  const runtime = await readBenchRuntimeIdentity();
  const derived = deriveCapacityMaximumGenerations(config.population ?? 256);
  const recordCount = config.records ?? derived.maximumFeasibleGenerations;
  const populationSize = config.population ?? 256;
  const tmpDir = join(os.tmpdir(), `boxcar3d-bench-profile-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const built = await buildScaleArtifact(runtime, {
      populationSize, recordCount, maxGenerations: recordCount,
    });
    const artifactPath = join(tmpDir, 'profile.bin');
    writeFileSync(artifactPath, built.bytes);
    await forkChild('one', {
      id: 'profile-one', mode: 'extraction', reader: 'extractHistoryObservations',
      artifactPath, warmups: 1,
    }, {
      execArgv: ['--cpu-prof', '--cpu-prof-dir', tmpDir],
      timeoutMs: 900000,
    });
    const profileFile = readdirSync(tmpDir).filter((f) => f.endsWith('.cpuprofile')).sort().pop();
    if (!profileFile) throw new Error('bench: --profile-one produced no .cpuprofile');
    const profile = JSON.parse(readFileSync(join(tmpDir, profileFile), 'utf8'));
    const hits = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (let i = 0; i < profile.samples.length; i += 1) {
      const node = byId.get(profile.samples[i]);
      if (!node) continue;
      const key = `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('/').pop()}:${node.callFrame.lineNumber + 1}`;
      hits.set(key, (hits.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
    }
    const top = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const total = [...hits.values()].reduce((s, v) => s + v, 0);
    console.log(`profile-one: population ${populationSize}, records ${recordCount} — ATTRIBUTION ONLY, not timing evidence`);
    for (const [key, us] of top) {
      console.log(`  ${(us / 1000).toFixed(1).padStart(9)} ms  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function shouldRunAsScript(argv1) {
  return argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href;
}

if (shouldRunAsScript(process.argv[1])) {
  const config = configFromArgs(process.argv.slice(2));
  if (config.runOne) {
    process.on('message', async (envelope) => {
      const result = await runOneSample(envelope);
      // disconnect (natural exit) rather than process.exit: exit hooks such
      // as --cpu-prof's flush must be allowed to run.
      process.send(result, () => { if (process.disconnect) process.disconnect(); });
    });
  } else if (config.runBatch) {
    process.on('message', async (envelope) => {
      const result = await runBatchSample(envelope);
      process.send(result, () => { if (process.disconnect) process.disconnect(); });
    });
  } else if (config.profileOne || config.mode === 'profile-one') {
    await profileOne(config);
  } else {
    const tmpDir = join(os.tmpdir(), `boxcar3d-bench-${process.pid}`);
    try {
      const report = await runBenchmark({ ...config, tmpDir });
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (config.json) {
        writeFileSync(config.json, json);
        console.log(`bench: report written to ${config.json}`);
      } else {
        console.log(json);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
