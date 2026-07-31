// PR 4D — THE EVOLUTION-VERIFICATION BENCH: SCHEMA, CONTRACT AND HARNESS
// TEETH. A benchmark is an instrument, not a correctness gate, so CI checks
// its STRUCTURE, its HARD IDENTITY claims, and its harness self-tests —
// NEVER an absolute timing threshold (the bench-physics precedent).
//
// What this file pins:
//   1. SMOKE: the tiny matrix completes in-process; every required report
//      field exists, is finite and nonnegative where applicable; artifact
//      identity and dimensions are reported; verdicts come from error codes,
//      never elapsed time; construction precedes every measured interval
//      (the defect-1 tooth); artifact digests reproduce across runs.
//   2. THE BUILDER CONTRACT: the bench-owned kernel-honest builder agrees
//      with the production transition (proven by the UNMOCKED production
//      verifier accepting its artifacts), honors the capture-once / terminal
//      / manifest-seed rules, follows the authoritative capacity-test
//      configuration, and derives the legal envelope through the public
//      refusal — and through the no-refusal policy-maximum path.
//   3. THE HARNESS SELF-TESTS: the primed/drained event-loop primitive sees
//      a known synchronous block (deleting the priming or the drain kills
//      it — defects 8/9); a same-thread interval sampler CANNOT see inside
//      the block (which is why 'peak memory' is maxRSS, not a sampler —
//      defect 10); maxRSS registers a known allocation in the documented
//      unit; the assembly guards refuse warm-up leakage, missing no-op
//      baselines, unprimed samples, inconsistent verdicts and mode-inconsistent
//      verdicts (defects 3/5/8/9); the corpus guard refuses substituted and
//      provenance-incomplete members (defects 4/12), and synthetic bytes
//      impersonating a genuine member diverge under genuine replay.
//
// The import below is itself the import-has-no-side-effect pin (the
// bench-schema precedent): importing the instrument must not run it.

import { describe, test, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, rmSync } from 'node:fs';
import { URL } from 'node:url';
import { clearInterval, setInterval } from 'node:timers';
import {
  BENCH_SCHEMA, BUDGETS, CAMPAIGN_PRODUCTION_MS, assembleRow, busyBlock,
  configFromArgs, measureOperationWithEventLoop, median, percentile,
  responsivenessBand, runBenchmark, smokeConfig, validateCorpusMembers,
} from '../scripts/bench-evolution-verification.js';
import {
  BENCH_CAPACITY_POPULATION_SEED, BENCH_CAPACITY_TERRAIN_SEED,
  buildScaleArtifact, createBenchCapacityEvaluationSpec,
  deriveCapacityMaximumGenerations, readBenchRuntimeIdentity,
  withContradictionAtPair, withForeignRuntimeIdentity,
} from '../scripts/bench-evolution-verification-artifacts.js';
import { buildGenuineCorpusMember } from '../scripts/bench-evolution-verification-corpus.js';
import {
  CAPACITY_POPULATION_SEED, CAPACITY_TERRAIN_SEED, createCapacityEvaluationSpec,
} from './helpers/evolution-capacity-config.js';
import { extractHistoryObservations } from '../scripts/history-observations.js';
import { resumeEvolutionRun } from '../src/sim/evolution-run.js';
import { decodeEvolutionHeader, decodeHistoryFraming } from '../src/sim/evolution-history.js';
import { expectCodeAsync } from './helpers/expect-code.js';

const SMOKE_TIMEOUT = 240000;

const freshTmpDir = (label) => {
  const dir = join(tmpdir(), `boxcar3d-bench-schema-${label}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
};

const expectFiniteNonnegative = (value, label) => {
  expect(Number.isFinite(value), `${label} must be finite, got ${String(value)}`).toBe(true);
  expect(value, `${label} must be nonnegative, got ${String(value)}`).toBeGreaterThanOrEqual(0);
};

describe('the evolution-verification bench report (smoke mode)', () => {
  const events = [];
  let report;
  let secondReport;

  test('smoke matrix completes and the report carries the pinned structure', { timeout: SMOKE_TIMEOUT }, async () => {
    const tmpDirA = freshTmpDir('a');
    const config = {
      ...smokeConfig(),
      tmpDir: tmpDirA,
      onEvent: (event) => events.push(event),
    };
    report = await runBenchmark(config);

    expect(report.schema).toBe(BENCH_SCHEMA);

    // Meta: machine identity and methodology disclosures.
    expect(report.meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof report.meta.dirtyTree).toBe('boolean');
    expect(report.meta.os.platform).toBe(process.platform);
    expect(Number.isInteger(report.meta.cpu.count)).toBe(true);
    expect(report.meta.node).toBe(process.version);
    expect(report.meta.rapier).toEqual({ compat: '0.19.3', deterministicCompat: '0.19.3' });
    expect(report.meta.generatedUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.meta.gcDisclosure).toContain('no --expose-gc');
    expect(report.meta.memoryMethod).toContain('maxRSS');
    expect(report.meta.memoryMethod).toContain('unavailable'); // the no-same-thread-sampler disclosure
    expect(report.meta.eventLoopMethod).toContain('primed');
    expect(report.meta.eventLoopMethod).toContain('drained');
    expect(report.meta.percentileMethod).toContain('nearest-rank');
    expect(report.meta.isolation).toBe('in-process');

    // Budgets echoed verbatim — predeclaration is diffable.
    expect(report.budgets).toBe(BUDGETS);
    expect(report.budgets.map((b) => b.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
    expect(report.budgets.filter((b) => b.gating).map((b) => b.id)).toEqual(['B1', 'B2', 'B6']);
    for (const budget of report.budgets) {
      expect(typeof budget.scope).toBe('string');
      expect(typeof budget.protects).toBe('string');
      expect(typeof budget.consequence).toBe('string');
    }
    expect(CAMPAIGN_PRODUCTION_MS).toBe(4183321.9);

    // The derived legal envelope — asserted, reported, and never hardcoded.
    expect(report.capacity.population256).toMatchObject({
      maximumFeasibleGenerations: 228, derivedFrom: 'resourceLimitExceeded context', matchesExpected: true,
    });
    expect(report.capacity.population64).toMatchObject({
      maximumFeasibleGenerations: 912, derivedFrom: 'resourceLimitExceeded context', matchesExpected: true,
    });
    expect(report.capacity.population4).toMatchObject({
      maximumFeasibleGenerations: 1024, derivedFrom: 'policy maximum (no refusal)',
    });

    // The four smoke rows: every path executed, verdicts from error codes.
    expect(report.rows.map((r) => r.id)).toEqual([
      'S1-extraction', 'S1-resume-gate', 'S1-hostile-k0-extraction', 'S1-hostile-k0-resume',
    ]);
    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]));
    expect(byId['S1-extraction'].verdict.success).toBe(true);
    expect(byId['S1-extraction'].verdict.historyDigestHex).toMatch(/^[0-9a-f]{64}$/);
    expect(byId['S1-resume-gate'].verdict).toMatchObject({ refused: 'runtimeVersionMismatch', field: 'rapierVersion' });
    expect(byId['S1-hostile-k0-extraction'].verdict).toMatchObject({
      refused: 'malformedHistory', rule: 'persistedTransitionPopulationMismatch', sourceGenerationIndex: 0,
    });
    expect(byId['S1-hostile-k0-resume'].verdict).toMatchObject({
      refused: 'malformedHistory', rule: 'persistedTransitionPopulationMismatch', sourceGenerationIndex: 0,
    });
    // Contract-derived kernel-call labels: R−1 for full reads, k+1 for the
    // hostile row at pair 0.
    expect(byId['S1-extraction'].verifierKernelCalls).toBe(2);
    expect(byId['S1-hostile-k0-extraction'].verifierKernelCalls).toBe(1);
    expect(byId['S1-extraction'].verifierKernelCallsBasis).toContain('contract-derived');
    // No physics in extraction rows: the artifact's rows are authoring rows
    // (not evaluation output), yet extraction succeeded — physics was never
    // consulted — and the row says so.
    expect(byId['S1-extraction'].physics).toBe(false);
    expect(byId['S1-extraction'].environment).toBe('node');

    for (const row of report.rows) {
      expect(row.samplesMs).toHaveLength(3); // warm-ups never leak into samples
      for (const sample of row.samplesMs) expectFiniteNonnegative(sample, `${row.id} sample`);
      expectFiniteNonnegative(row.medianMs, `${row.id} medianMs`);
      expectFiniteNonnegative(row.p90Ms, `${row.id} p90Ms`);
      expect(row.eventLoop.primed).toBe(true);
      expect(row.eventLoop.drained).toBe(true);
      expectFiniteNonnegative(row.eventLoop.maxMs, `${row.id} eventLoop.maxMs`);
      expectFiniteNonnegative(row.eventLoop.meanMs, `${row.id} eventLoop.meanMs`);
      expectFiniteNonnegative(row.eventLoop.p99Ms, `${row.id} eventLoop.p99Ms`);
      // In-process isolation marks memory unavailable rather than inventing it.
      expect(typeof row.memory).toBe('string');
      expect(row.memory).toContain('unavailable');
    }

    // Artifact identity and dimensions.
    expect(report.artifacts.length).toBeGreaterThanOrEqual(3);
    for (const artifact of report.artifacts) {
      expect(artifact.byteLength).toBeGreaterThan(0);
      expect(artifact.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.populationSize).toBe(4);
      expect(artifact.recordCount).toBe(3);
      expectFiniteNonnegative(artifact.constructionMs, `${artifact.id} constructionMs`);
      expect(['kernel-honest-synthetic', 'production-run-genuine']).toContain(artifact.construction);
    }
    const extractionArtifact = report.artifacts.find((a) => a.id === 'S1-extraction');
    expect(extractionArtifact.historyDigestHex).toBe(byId['S1-extraction'].verdict.historyDigestHex);
    expect(extractionArtifact.terminalReason).toBe('none'); // partial history: maxGenerations 4 > 3 records
    const foreign = report.artifacts.find((a) => a.foreignRuntimeIdentity === true);
    expect(foreign).toBeDefined();
    const hostile = report.artifacts.find((a) => a.contradictionAtPair === 0);
    expect(hostile).toBeDefined();

    // Defect-1 tooth: construction precedes every measured interval.
    const builtAt = new Map();
    for (const event of events) {
      if (event.type === 'artifact-built' && !builtAt.has(event.row)) builtAt.set(event.row, builtAt.size);
    }
    for (const event of events) {
      if (event.type === 'sample-start') {
        expect(builtAt.has(event.row), `sample-start for '${event.row}' before its artifact-built event`).toBe(true);
      }
    }

    // Smoke mode measures nothing against budgets: outcomes are declared
    // unmeasured, never silently green.
    expect(report.budgetOutcomes.map((b) => b.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
    for (const outcome of report.budgetOutcomes) expect(outcome.pass).toBeNull();

    // Second run: artifact identities reproduce byte-for-byte (the
    // deterministic-construction tooth; wall times may differ).
    const tmpDirB = freshTmpDir('b');
    secondReport = await runBenchmark({ ...smokeConfig(), tmpDir: tmpDirB });
    expect(secondReport.artifacts.map((a) => a.sha256Hex).sort())
      .toEqual(report.artifacts.map((a) => a.sha256Hex).sort());
    expect(secondReport.rows.find((r) => r.id === 'S1-extraction').verdict.historyDigestHex)
      .toBe(byId['S1-extraction'].verdict.historyDigestHex);

    rmSync(tmpDirA, { recursive: true, force: true });
    rmSync(tmpDirB, { recursive: true, force: true });
  });
});

describe('configFromArgs (pure argv -> config)', () => {
  test('defaults and flags without side effects', () => {
    const config = configFromArgs([]);
    expect(config.mode).toBe('matrix');
    expect(config.samples).toBe(5);
    expect(config.warmups).toBe(2);
    expect(config.isolation).toBe('fresh-child-per-sample');
    expect(configFromArgs(['--smoke']).isolation).toBe('in-process');
    expect(configFromArgs(['--samples', '7', '--warmups', '3']).samples).toBe(7);
    expect(configFromArgs(['--mode', 'hostile']).mode).toBe('hostile');
    expect(configFromArgs(['--population', '64', '--records', '32']).population).toBe(64);
    expect(() => configFromArgs(['--samples', 'nope'])).toThrow(/--samples/);
    expect(() => configFromArgs(['--samples', '2'])).toThrow(/--samples/); // samples >= 3
    expect(() => configFromArgs(['--mode', 'everything'])).toThrow(/--mode/);
    expect(() => configFromArgs(['--warmups', '-1'])).toThrow(/--warmups/);
  });
});

describe('the kernel-honest synthetic builder contract (bench-owned)', () => {
  test('artifacts pass the UNMOCKED production verifier — kernel agreement by acceptance', async () => {
    const runtime = await readBenchRuntimeIdentity();
    const built = await buildScaleArtifact(runtime, {
      populationSize: 6, recordCount: 3, maxGenerations: 4,
    });
    const extracted = await extractHistoryObservations(built.bytes);
    expect(extracted.historyDigestBytes).toHaveLength(32);
    expect(extracted.generations).toHaveLength(3);
    expect(built.terminalReason).toBe('none'); // partial: 3 < 4
    // The foreign-runtime reforge passes every shared gate too (extraction
    // never reads runtime identity) and refuses only at resume's identity
    // comparison — the resume pre-replay gate artifact.
    const foreign = await withForeignRuntimeIdentity(built.bytes);
    await extractHistoryObservations(foreign);
    const err = await expectCodeAsync(() => resumeEvolutionRun(foreign), 'runtimeVersionMismatch', /rapierVersion/);
    expect(err.context.stored).toBe('99.99.99');
  });

  test('terminal shape: a complete history ends generationLimitReached', async () => {
    const runtime = await readBenchRuntimeIdentity();
    const built = await buildScaleArtifact(runtime, {
      populationSize: 6, recordCount: 3, maxGenerations: 3,
    });
    expect(built.terminalReason).toBe('generationLimitReached');
    await extractHistoryObservations(built.bytes);
  });

  test('the header persists the captured mutation policy, immune to post-call mutation', async () => {
    const runtime = await readBenchRuntimeIdentity();
    const mutation = { probability: 1, magnitude: 0.3 }; // a non-default witness
    const pending = buildScaleArtifact(runtime, {
      populationSize: 6, recordCount: 3, maxGenerations: 4, mutation,
    });
    mutation.probability = 0.01; // a mutating caller must not move the captured policy
    const built = await pending;
    const framing = decodeHistoryFraming(built.bytes);
    const header = decodeEvolutionHeader(framing.headerBytes);
    expect(header.mutationProbability).toBe(1);
    expect(header.mutationMagnitude).toBe(0.3);
    await extractHistoryObservations(built.bytes); // and the kernel agrees under that policy
  });

  test('caller-configuration errors are loud', async () => {
    const runtime = await readBenchRuntimeIdentity();
    await expect(() => buildScaleArtifact(runtime, {
      populationSize: 6, recordCount: 3, maxGenerations: 4, invalidPoolAt: 7,
    })).rejects.toThrow(/invalidPoolAt/);
    await expect(() => buildScaleArtifact(runtime, {
      populationSize: 6, recordCount: 5, maxGenerations: 4,
    })).rejects.toThrow(/recordCount/);
    // An empty pool ends the history; requesting a successor after a terminal
    // record is a configuration error, never a fabricated transition.
    await expect(() => buildScaleArtifact(runtime, {
      populationSize: 6, recordCount: 3, maxGenerations: 4, invalidPoolAt: 0,
    })).rejects.toThrow(/terminal/);
    await expect(buildScaleArtifact(runtime, {
      populationSize: 6, recordCount: 3, maxGenerations: 4, invalidPoolAt: 2,
    })).resolves.toBeDefined(); // legal on the FINAL record
  });

  test('hostile reforges stop at their first authenticated contradiction, on both readers', async () => {
    const runtime = await readBenchRuntimeIdentity();
    const honest = await buildScaleArtifact(runtime, {
      populationSize: 6, recordCount: 3, maxGenerations: 4,
    });
    for (const k of [0, 1]) {
      const hostile = await withContradictionAtPair(honest.bytes, k);
      for (const reader of [extractHistoryObservations, resumeEvolutionRun]) {
        const err = await expectCodeAsync(() => reader(hostile), 'malformedHistory');
        expect(err.context.rule).toBe('persistedTransitionPopulationMismatch');
        expect(err.context.sourceGenerationIndex).toBe(k);
      }
    }
  });

  test('the capacity configuration follows the authoritative capacity-test input', () => {
    // The bench mirrors the test helper (scripts must not import test
    // helpers); this pin keeps the two in step.
    expect(BENCH_CAPACITY_POPULATION_SEED).toBe(CAPACITY_POPULATION_SEED);
    expect(BENCH_CAPACITY_TERRAIN_SEED).toBe(CAPACITY_TERRAIN_SEED);
    expect(createBenchCapacityEvaluationSpec()).toEqual(createCapacityEvaluationSpec());
  });

  test('the legal envelope derives through the public refusal — and through no refusal', () => {
    expect(deriveCapacityMaximumGenerations(256)).toEqual({
      maximumFeasibleGenerations: 228, derivedFrom: 'resourceLimitExceeded context',
    });
    expect(deriveCapacityMaximumGenerations(64)).toEqual({
      maximumFeasibleGenerations: 912, derivedFrom: 'resourceLimitExceeded context',
    });
    expect(deriveCapacityMaximumGenerations(4)).toEqual({
      maximumFeasibleGenerations: 1024, derivedFrom: 'policy maximum (no refusal)',
    });
  });
});

describe('the event-loop and memory harness self-tests', () => {
  test('the primed/drained histogram sees a known synchronous block', async () => {
    const blockMs = 200;
    const measured = await measureOperationWithEventLoop(() => busyBlock(blockMs));
    expect(measured.eventLoop.primed).toBe(true);
    expect(measured.eventLoop.drained).toBe(true);
    // Without the priming turn the histogram records nothing; without the
    // drain the delayed timer is never counted (defects 8/9). With both,
    // max approximates the block.
    expect(measured.eventLoop.maxMs).toBeGreaterThanOrEqual(blockMs * 0.75);
    expect(measured.elapsedMs).toBeGreaterThanOrEqual(blockMs);
  });

  test('a same-thread interval sampler cannot observe inside the synchronous block', async () => {
    // WHY 'peak memory' is maxRSS and never a sampler: the PR-4C verifier is
    // synchronous, so a setInterval in the measured process fires zero times
    // inside it. This test pins that platform fact (defect 10's first leg).
    let samplesDuringBlock = 0;
    const sampler = setInterval(() => { samplesDuringBlock += 1; }, 5);
    busyBlock(150, 16 * 1024 * 1024);
    clearInterval(sampler);
    expect(samplesDuringBlock).toBe(0);
  });

  test('maxRSS registers a known allocation in the documented unit (kilobytes)', async () => {
    // Unit + sensitivity guard (defect 10's second leg): a touched 64 MiB
    // allocation must move the process-lifetime high-water by ≈64 MiB. If a
    // platform ever reports bytes instead, the delta blows the upper bound
    // and this test fails loudly instead of silently mislabeling units.
    const before = process.resourceUsage().maxRSS;
    const held = busyBlock(0, 64 * 1024 * 1024);
    const after = process.resourceUsage().maxRSS;
    expect(held.length).toBe(64 * 1024 * 1024); // the buffer is live across the read
    expect(after - before).toBeGreaterThanOrEqual(48 * 1024);
    expect(after - before).toBeLessThanOrEqual(256 * 1024);
  });
});

describe('the report assembly guards', () => {
  const row = {
    id: 'unit-row', mode: 'extraction', reader: 'extractHistoryObservations',
    artifact: { kind: 'synthetic', recordCount: 3 }, samples: 2,
  };
  const config = { isolation: 'fresh-child-per-sample' };
  const sample = (overrides = {}) => ({
    elapsedMs: 10,
    verdict: { success: true, historyDigestHex: 'ab'.repeat(32) },
    eventLoop: { method: 'm', primed: true, drained: true, maxMs: 1, meanMs: 0, p99Ms: 1 },
    memory: { before: {}, after: {}, processMaxRssKb: 100 },
    ...overrides,
  });
  const baseline = { processMaxRssKb: 50 };

  test('the happy path assembles a schema-shaped row', () => {
    const assembled = assembleRow(row, [sample(), sample()], baseline, config);
    expect(assembled.samplesMs).toEqual([10, 10]);
    expect(assembled.medianMs).toBe(10);
    expect(assembled.memory.highWaterDeltaBytes).toBe((100 - 50) * 1024);
    expect(assembled.verifierKernelCalls).toBe(2);
  });

  test('warm-up leakage / lost samples are refused', () => {
    expect(() => assembleRow(row, [sample()], baseline, config)).toThrow(/warm-up leakage/);
  });

  test('child-mode rows without a no-op baseline are refused (defect 5)', () => {
    expect(() => assembleRow(row, [sample(), sample()], null, config)).toThrow(/no-op baseline/);
  });

  test('samples without primed/drained event-loop evidence are refused (defects 8/9)', () => {
    expect(() => assembleRow(
      row,
      [sample(), sample({ eventLoop: { primed: false, drained: true, maxMs: 0, meanMs: 0, p99Ms: 0 } })],
      baseline, config,
    )).toThrow(/primed\/drained/);
  });

  test('inconsistent verdicts across samples are refused', () => {
    expect(() => assembleRow(
      row,
      [sample(), sample({ verdict: { success: true, historyDigestHex: 'cd'.repeat(32) } })],
      baseline, config,
    )).toThrow(/inconsistent verdicts/);
  });

  test('a mode-inconsistent verdict is refused (the row contract)', () => {
    expect(() => assembleRow(
      { ...row, mode: 'resume-gate' },
      [sample(), sample()], baseline, config,
    )).toThrow(/runtimeVersionMismatch/);
    expect(() => assembleRow(
      { ...row, mode: 'hostile', artifact: { kind: 'synthetic', recordCount: 3, contradictionAtPair: 0 } },
      [sample(), sample()], baseline, config,
    )).toThrow(/persistedTransition/);
  });
});

describe('the corpus guard', () => {
  const member = (id, hex) => ({
    id,
    sha256Hex: hex,
    provenance: {
      construction: 'production-run-genuine', populationSeed: 1, terrainSeed: 2,
      generations: 30, probability: 0.05, magnitude: 0.05,
    },
  });

  test('distinct, fully-provenanced members pass; substitutions fail', () => {
    expect(validateCorpusMembers([member('G1', 'aa'.repeat(32)), member('G2', 'bb'.repeat(32))])).toBe(true);
    expect(() => validateCorpusMembers([
      member('G1', 'aa'.repeat(32)), member('G2', 'aa'.repeat(32)),
    ])).toThrow(/duplicates/);
    expect(() => validateCorpusMembers([{ id: 'GX', sha256Hex: 'cc'.repeat(32) }])).toThrow(/provenance/);
  });

  test('synthetic bytes impersonating a genuine member diverge under genuine replay', { timeout: 120000 }, async () => {
    // The non-vacuous tooth behind the guard (defects 4/12): a synthetic
    // artifact's authoring rows are not physics output, so resume — which
    // replays — must diverge; a tiny GENUINE member resumes cleanly.
    const runtime = await readBenchRuntimeIdentity();
    const synthetic = await buildScaleArtifact(runtime, {
      populationSize: 4, recordCount: 2, maxGenerations: 2,
    });
    await expectCodeAsync(() => resumeEvolutionRun(synthetic.bytes), 'replayDivergence');
    const genuine = await buildGenuineCorpusMember(
      {
        id: 'T1', label: 'tiny', probability: 0.05, magnitude: 0.05,
        generations: 2, populationSeed: 20260801, terrainSeed: 20260809,
      },
      { protocolKind: 'smoke' },
    );
    expect(genuine.provenance.construction).toBe('production-run-genuine');
    expect(genuine.provenance.populationSize).toBe(4); // the smoke protocol shape
    const resumed = await resumeEvolutionRun(genuine.bytes);
    expect(resumed).toBeDefined();
  });
});

describe('the browser measured-page boundary', () => {
  test('the measured page never imports the artifact builder (defect 11)', () => {
    // Building in the measured page would warm the exact kernel being
    // benchmarked, retain construction allocations, and break Node-vs-browser
    // byte-identity — measured rows fetch PREBUILT bytes instead. This pin
    // makes the structural rule a test, not a convention.
    const source = readFileSync(
      new URL('../scripts/browser-bench/page.js', import.meta.url), 'utf8',
    );
    const imports = source.match(/^import\s[^;]*from\s*['"][^'"]+['"];?/gm) ?? [];
    for (const statement of imports) {
      expect(statement, 'the measured page must not import any artifact builder').not.toMatch(/bench-evolution-verification-(artifacts|corpus)/);
    }
    // …and it must reach the reader: the measured operation exists.
    expect(imports.some((s) => s.includes('history-observations.js'))).toBe(true);
  });
});

describe('the numeric helpers and responsiveness bands', () => {
  test('nearest-rank percentiles and the band scale', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
    expect(percentile([], 0.5)).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(responsivenessBand(50)).toBe('interactive');
    expect(responsivenessBand(100)).toBe('interactive');
    expect(responsivenessBand(101)).toBe('noticeable');
    expect(responsivenessBand(250)).toBe('noticeable');
    expect(responsivenessBand(251)).toBe('severely degraded');
    expect(responsivenessBand(1000)).toBe('severely degraded');
    expect(responsivenessBand(1001)).toBe('batch/non-interactive');
  });
});
