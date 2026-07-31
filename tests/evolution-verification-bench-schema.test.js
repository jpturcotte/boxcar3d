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

import { describe, test, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { clearInterval, setInterval } from 'node:timers';
import {
  BENCH_SCHEMA, BUDGETS, CAMPAIGN_PRODUCTION_MS, assembleBatchReport, assembleRow,
  buildNodeRows, busyBlock, configFromArgs, defaultConfig, evaluateBudgets,
  measureOperationWithEventLoop, median, percentile, responsivenessBand,
  runBatchSample, runBenchmark, smokeConfig, validateCorpusMembers,
} from '../scripts/bench-evolution-verification.js';
import {
  BENCH_CAPACITY_POPULATION_SEED, BENCH_CAPACITY_TERRAIN_SEED,
  buildScaleArtifact, createBenchCapacityEvaluationSpec,
  deriveCapacityMaximumGenerations, readBenchRuntimeIdentity,
  withContradictionAtPair, withForeignRuntimeIdentity,
} from '../scripts/bench-evolution-verification-artifacts.js';
import { GENUINE_CORPUS_PLANS, buildGenuineCorpusMember } from '../scripts/bench-evolution-verification-corpus.js';
import { assembleBrowserRow } from '../scripts/bench-evolution-verification-browser.js';
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
  let tmpDirA;
  let tmpDirB;

  afterAll(() => {
    // Cleanup belongs here, not at the test's happy end: a failed assertion
    // must not leak instrument workspaces into the temp dir.
    if (tmpDirA) rmSync(tmpDirA, { recursive: true, force: true });
    if (tmpDirB) rmSync(tmpDirB, { recursive: true, force: true });
  });

  test('smoke matrix completes and the report carries the pinned structure', { timeout: SMOKE_TIMEOUT }, async () => {
    tmpDirA = freshTmpDir('a');
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

    // The four-plus-one smoke rows: every path executed, verdicts from error codes.
    expect(report.rows.map((r) => r.id)).toEqual([
      'S1-extraction', 'S1-resume-gate', 'S1-hostile-k0-extraction', 'S1-hostile-k0-resume', 'S1-resume-full',
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
    // The genuine smoke row: production-run bytes resume cleanly end to end,
    // with MEASURED provenance (never asserted from the plan).
    expect(byId['S1-resume-full'].verdict.success).toBe(true);
    expect(byId['S1-resume-full'].physics).toBe(true);
    expect(byId['S1-resume-full'].verifierKernelCalls).toBe(2); // complete terminal resume, 2R−2 with R = 2
    const genuineArtifact = report.artifacts.find((a) => a.construction === 'production-run-genuine');
    expect(genuineArtifact).toBeDefined();
    expect(genuineArtifact.provenance).toMatchObject({
      id: 'S-genuine', advanceCount: 2, terminalReason: 'generationLimitReached',
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
      // 3 synthetic records; the genuine smoke run commits its MEASURED 2.
      expect(artifact.recordCount).toBe(artifact.construction === 'production-run-genuine' ? 2 : 3);
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

    // Defect-1 tooth: construction precedes every measured interval, no
    // artifact is built after the first sample-start, and the event stream
    // itself is non-vacuous (an earlier version of this guard checked
    // set-membership in the COMPLETE build set and passed inverted and empty
    // streams — the review caught it; this is the corrected tooth).
    expect(events.length).toBeGreaterThan(0); // the canary: an instrument that stops emitting fails here
    const built = new Set();
    const sampled = new Set();
    let firstSampleIndex = -1;
    for (const [index, event] of events.entries()) {
      if (event.type === 'artifact-built') {
        expect(
          firstSampleIndex,
          `artifact-built for '${event.row}' arrives after the first sample-start — construction must never interleave with measurement`,
        ).toBe(-1);
        built.add(event.row);
      } else if (event.type === 'sample-start') {
        if (firstSampleIndex === -1) firstSampleIndex = index;
        sampled.add(event.row);
        expect(
          built.has(event.row),
          `sample-start for '${event.row}' before its artifact-built event`,
        ).toBe(true);
      }
    }
    // Cardinality: every report row was built AND sampled — a missing event
    // on either side is a defect, not a choice.
    expect(built.size).toBe(report.rows.length);
    expect(sampled.size).toBe(report.rows.length);

    // Smoke mode measures nothing against budgets: outcomes are declared
    // unmeasured, never silently green.
    expect(report.budgetOutcomes.map((b) => b.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
    for (const outcome of report.budgetOutcomes) expect(outcome.pass).toBeNull();

    // Second run: artifact identities reproduce byte-for-byte (the
    // deterministic-construction tooth; wall times may differ).
    tmpDirB = freshTmpDir('b');
    secondReport = await runBenchmark({ ...smokeConfig(), tmpDir: tmpDirB });
    expect(secondReport.artifacts.map((a) => a.sha256Hex).sort())
      .toEqual(report.artifacts.map((a) => a.sha256Hex).sort());
    expect(secondReport.rows.find((r) => r.id === 'S1-extraction').verdict.historyDigestHex)
      .toBe(byId['S1-extraction'].verdict.historyDigestHex);
    // …and the identity is not merely run-stable but EXACTLY this: the
    // smoke artifact is byte-pinned, so deterministic-but-drifted
    // construction (a codec or initializer change) fails loudly here, the
    // same authority the repo's golden locks carry.
    expect(extractionArtifact.sha256Hex).toBe('218ccddb943379e5ef1918a7d7cfe469e6ee3fe84279feec43a6ae585bbb3f83');
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
    expect(() => configFromArgs(['--samplse', '3'])).toThrow(); // unknown flags refuse natively
    expect(() => configFromArgs(['--population', '64'])).toThrow(/together/); // a lone axis is never silently ignored
    expect(() => configFromArgs(['--records', '32'])).toThrow(/together/);
    expect(() => configFromArgs(['--population', '64', '--records', '2000'])).toThrow(/MAX_EVOLUTION_GENERATIONS/);
    expect(() => configFromArgs(['--smoke', '--mode', 'batch'])).toThrow(/not supported with --smoke/);
    expect(() => configFromArgs(['--smoke', '--mode', 'resume-full'])).toThrow(/not supported with --smoke/);
    expect(() => configFromArgs(['--smoke', '--profile-one'])).toThrow(/not supported with --smoke/);
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

  test('withContradictionAtPair validates k loudly (never a silent honest artifact)', async () => {
    // The review found the old boundary: an out-of-range or fractional k
    // silently returned the HONEST bytes, and a negative one fired the wrong
    // gate. Both are caller configuration errors now.
    const runtime = await readBenchRuntimeIdentity();
    const honest = await buildScaleArtifact(runtime, {
      populationSize: 6, recordCount: 3, maxGenerations: 4,
    });
    await expect(() => withContradictionAtPair(honest.bytes, 2)).rejects.toThrow(/caller configuration error/);
    await expect(() => withContradictionAtPair(honest.bytes, -1)).rejects.toThrow(/caller configuration error/);
    await expect(() => withContradictionAtPair(honest.bytes, 0.5)).rejects.toThrow(/caller configuration error/);
    await expect(withContradictionAtPair(honest.bytes, 1)).resolves.toBeDefined(); // [0, R-1) is legal
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
    // Unit + sensitivity guard (defect 10's second leg): a touched 96 MiB
    // allocation must move the process-lifetime high-water by ≈96 MiB. If a
    // platform ever reports bytes instead, the delta blows the upper bound
    // and this test fails loudly instead of silently mislabeling units.
    // Order-dependence note: maxRSS is a lifetime mark, so an EARLIER test
    // in this worker with a larger transient peak would zero the delta — the
    // allocation is deliberately sized well above anything this file does.
    const before = process.resourceUsage().maxRSS;
    const held = busyBlock(0, 96 * 1024 * 1024);
    const after = process.resourceUsage().maxRSS;
    expect(held.length).toBe(96 * 1024 * 1024); // the buffer is live across the read
    expect(after - before).toBeGreaterThanOrEqual(72 * 1024);
    expect(after - before).toBeLessThanOrEqual(384 * 1024);
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

  test('an extraction/resume-full row that refuses is refused (the must-succeed branch)', () => {
    const refused = sample({
      verdict: { refused: 'malformedHistory', rule: 'persistedTransitionPopulationMismatch', sourceGenerationIndex: 0, field: null },
    });
    expect(() => assembleRow(row, [refused, refused], baseline, config)).toThrow(/must succeed/);
    expect(() => assembleRow(
      { ...row, mode: 'resume-full', artifact: { kind: 'genuine', plan: { generations: 3 } } },
      [refused, refused], baseline, config,
    )).toThrow(/must succeed/);
  });

  test('a hostile row with the wrong rule or wrong pair index is refused', () => {
    const wrongRule = sample({
      verdict: { refused: 'malformedHistory', rule: 'individualIdAllocationMismatch', sourceGenerationIndex: 0, field: null },
    });
    const wrongIndex = sample({
      verdict: { refused: 'malformedHistory', rule: 'persistedTransitionPopulationMismatch', sourceGenerationIndex: 1, field: null },
    });
    const hostileRow = { ...row, mode: 'hostile', artifact: { kind: 'synthetic', recordCount: 3, contradictionAtPair: 0 } };
    expect(() => assembleRow(hostileRow, [wrongRule, wrongRule], baseline, config)).toThrow(/persistedTransition/);
    expect(() => assembleRow(hostileRow, [wrongIndex, wrongIndex], baseline, config)).toThrow(/at pair 0/);
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

  test('a synthetic-construction member and non-integer fields are refused', () => {
    const synthetic = member('GX', 'dd'.repeat(32));
    synthetic.provenance.construction = 'kernel-honest-synthetic';
    expect(() => validateCorpusMembers([synthetic])).toThrow(/provenance/);
    const badSeed = member('GY', 'ee'.repeat(32));
    badSeed.provenance.populationSeed = 20260801.5;
    expect(() => validateCorpusMembers([badSeed])).toThrow(/provenance/);
    const badGenerations = member('GZ', 'ff'.repeat(32));
    badGenerations.provenance.generations = '30';
    expect(() => validateCorpusMembers([badGenerations])).toThrow(/provenance/);
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
    expect(imports.length).toBeGreaterThan(0); // non-vacuity: the pin must see real imports
    for (const statement of imports) {
      expect(statement, 'the measured page must not import any artifact builder').not.toMatch(/bench-evolution-verification-(artifacts|corpus)/);
    }
    // …and it must reach the reader: the measured operation exists.
    expect(imports.some((s) => s.includes('history-observations.js'))).toBe(true);
    // The html entry gets the same scan: its inline module may not carry a
    // builder either (the AST entry-point list stays index.html-only by
    // decision, so this pin is the html's builder fence).
    const html = readFileSync(
      new URL('../scripts/browser-bench/evolution-verification.html', import.meta.url), 'utf8',
    );
    expect(html).not.toMatch(/bench-evolution-verification-(artifacts|corpus)/);
    expect(html).toContain('browser-bench/page.js');
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


// ---------------------------------------------------------------------------
// POST-REVIEW HARDENING PINS. The six-round audit found the batch row had no
// CI presence, the browser driver's guards were untestable, the corpus and
// the full matrix were unpinned, and several guard boundaries were unexercised.
// These describes close exactly those gaps — every one names the gap it pins.
// ---------------------------------------------------------------------------

describe('the batch row has CI liveness (the B2 path is no longer evidence-only)', () => {
  test('runBatchSample + assembleBatchReport at tiny shape, with invariants', { timeout: 120000 }, async () => {
    // Two tiny synthetic members, one per record class, drive the REAL batch
    // child logic in-process (tests never fork — the repo rule; the forked
    // path shares this same function).
    const runtime = await readBenchRuntimeIdentity();
    const thirty = await buildScaleArtifact(runtime, { populationSize: 4, recordCount: 3, maxGenerations: 4 });
    const sixty = await buildScaleArtifact(runtime, { populationSize: 4, recordCount: 4, maxGenerations: 5 });
    const dir = freshTmpDir('batch');
    try {
      mkdirSync(dir, { recursive: true });
      const thirtyPath = join(dir, 'thirty.bin');
      const sixtyPath = join(dir, 'sixty.bin');
      writeFileSync(thirtyPath, thirty.bytes);
      writeFileSync(sixtyPath, sixty.bytes);
      const result = await runBatchSample({
        members: [
          { id: 'tiny-30', path: thirtyPath, recordCount: 30 },
          { id: 'tiny-60', path: sixtyPath, recordCount: 60 },
        ],
        maxPass: 1,
      });
      expect(result.passes).toHaveLength(1);
      const pass = result.passes[0];
      expect(pass.draws).toBe(204); // the campaign proportions, honored at any member count
      expect(pass.perArtifactMs).toHaveLength(204);
      for (const ms of pass.perArtifactMs) expectFiniteNonnegative(ms, 'batch perArtifactMs');
      expectFiniteNonnegative(pass.totalMs, 'batch pass totalMs');
      // firstDigests bind every drawn member to its reader-reported identity.
      expect(Object.keys(result.firstDigests).sort()).toEqual(['tiny-30', 'tiny-60']);
      for (const hex of Object.values(result.firstDigests)) expect(hex).toMatch(/^[0-9a-f]{64}$/);
      expectFiniteNonnegative(result.memory.heapUsedBefore, 'batch heapUsedBefore');
      expectFiniteNonnegative(result.memory.heapUsedAfter, 'batch heapUsedAfter');
      expectFiniteNonnegative(result.betweenOpSamples, 'batch betweenOpSamples');

      const assembled = assembleBatchReport(result);
      expect(assembled.declaredPasses).toBe(result.passes.length); // the pass-count tooth: derived, never asserted
      expect(assembled.firstDigests).toEqual(result.firstDigests);
      expect(assembled.campaignProportions).toEqual({ thirty: 156, sixty: 48 });
      expectFiniteNonnegative(assembled.passes[0].medianPerArtifactMs, 'batch medianPerArtifactMs');
      expectFiniteNonnegative(assembled.passes[0].p90PerArtifactMs, 'batch p90PerArtifactMs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('evaluateBudgets reads BUDGETS thresholds and reports null honestly', () => {
    const b2 = BUDGETS.find((b) => b.id === 'B2');
    const reportWithBatch = (totalMs) => ({
      rows: [],
      batch: { passes: [{ passIndex: 1, totalMs, perArtifactMs: [1] }] },
    });
    const passing = evaluateBudgets(reportWithBatch(b2.threshold.totalMs - 1));
    expect(passing.find((b) => b.id === 'B2').pass).toBe(true);
    const failing = evaluateBudgets(reportWithBatch(b2.threshold.totalMs + 1));
    expect(failing.find((b) => b.id === 'B2').pass).toBe(false);
    // No batch at all, and an EMPTY pass list, are honest nulls — never crashes.
    expect(evaluateBudgets({ rows: [], batch: null }).find((b) => b.id === 'B2').pass).toBeNull();
    expect(evaluateBudgets({ rows: [], batch: { passes: [] } }).find((b) => b.id === 'B2').pass).toBeNull();
    // An in-process D1-shaped row (memory is the unavailable string) yields
    // null, not a false failure (the review's latent B3/B6 asymmetry).
    const d1Row = {
      id: 'D1-legal-max-extraction', medianMs: 1, p90Ms: 1, memory: 'unavailable: in-process isolation (CI smoke)',
      verdict: { success: true },
    };
    const b3 = evaluateBudgets({ rows: [d1Row], batch: null }).find((b) => b.id === 'B3');
    expect(b3.pass).toBeNull();
    expect(b3.note).toContain('unavailable');
  });
});

describe('the browser driver assembly guards (exported and pinned, the assembleRow precedent)', () => {
  const artifact = { id: 'B-row', recordCount: 3 };
  const frameGap = (overrides = {}) => ({
    method: 'm', primed: true, drained: true, tickPrimedBeforeT0: true,
    maxGapMs: 10, gapsOver50ms: 0, ...overrides,
  });
  const sample = (overrides = {}) => ({
    verdict: { success: true, historyDigestHex: 'ab'.repeat(32) },
    elapsedMs: 12,
    frameGap: frameGap(),
    pageSaw: { byteLength: 100, sha256Hex: 'cd'.repeat(32) },
    cdpSamples: [{ t: 0, jsHeapUsedSize: 1 }],
    ...overrides,
  });

  test('the happy path assembles a schema-shaped browser row', () => {
    const row = assembleBrowserRow(artifact, [sample(), sample(), sample()], '149.0');
    expect(row.samplesMs).toEqual([12, 12, 12]);
    expect(row.frameGap.tickPrimedBeforeT0).toBe(true);
    expect(row.frameGap.band).toBe('interactive');
    expect(row.memory.method).not.toContain('+ in-page performance.memory'); // the stop-claiming fix
    expect(row.pageSaw.matchesDriverArtifact).toBe(true);
  });

  test('a sample without primed/drained evidence is refused', () => {
    expect(() => assembleBrowserRow(artifact, [sample({ frameGap: frameGap({ primed: false }) }), sample(), sample()], '149'))
      .toThrow(/primed\/drained/);
  });

  test('a sample whose tick channel was not live before t0 is refused (the prime tooth)', () => {
    // rAF frame-begin timestamps self-prime, so only the tick channel can
    // carry the deleted-prime tooth — the guard must require it explicitly.
    expect(() => assembleBrowserRow(artifact, [sample({ frameGap: frameGap({ tickPrimedBeforeT0: false }) }), sample(), sample()], '149'))
      .toThrow(/tick channel/);
  });

  test('a refused extraction row and inconsistent verdicts are refused', () => {
    const refused = sample({ verdict: { refused: 'malformedHistory', rule: null, sourceGenerationIndex: null } });
    expect(() => assembleBrowserRow(artifact, [refused, refused, refused], '149')).toThrow(/must succeed/);
    const other = sample({ verdict: { success: true, historyDigestHex: 'ef'.repeat(32) } });
    expect(() => assembleBrowserRow(artifact, [sample(), other, sample()], '149')).toThrow(/inconsistent verdicts/);
  });
});

describe('the corpus and the matrix are pinned', () => {
  test('GENUINE_CORPUS_PLANS is exactly the declared stratified corpus', () => {
    expect(GENUINE_CORPUS_PLANS.map((p) => p.id)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
    expect(GENUINE_CORPUS_PLANS.filter((p) => p.generations === 30)).toHaveLength(4);
    expect(GENUINE_CORPUS_PLANS.filter((p) => p.generations === 60)).toHaveLength(4);
    expect(GENUINE_CORPUS_PLANS.filter((p) => p.probability === 0 && p.magnitude === 0)).toHaveLength(2); // control
    expect(GENUINE_CORPUS_PLANS.filter((p) => p.probability === 0.2 && p.magnitude === 0.2)).toHaveLength(2); // aggressive
    expect(GENUINE_CORPUS_PLANS.filter((p) => p.probability === 0.05 && p.magnitude === 0.05)).toHaveLength(4); // defaults ×2 seed pairs
    // The declared bench seed block — pairwise, never campaign-allocated.
    for (const [index, plan] of GENUINE_CORPUS_PLANS.entries()) {
      expect(plan.populationSeed).toBe(20260800 + index);
      expect(plan.terrainSeed).toBe(20260808 + index);
    }
  });

  test('buildNodeRows pins the full matrix and the smoke matrix', () => {
    const full = buildNodeRows(defaultConfig(), { maximumFeasibleGenerations: 228 });
    expect(full.map((r) => r.id)).toEqual([
      'R-corpus-G1', 'R-corpus-G2', 'R-corpus-G3', 'R-corpus-G4',
      'R-corpus-G5', 'R-corpus-G6', 'R-corpus-G7', 'R-corpus-G8',
      'R3-resume-gate-20-30',
      'R4-resume-full-G2', 'R4-resume-full-G6',
      'C1-pop-16', 'C1-pop-64', 'C1-pop-128', 'C1-pop-256',
      'C2-records-1', 'C2-records-8', 'C2-records-16', 'C2-records-32', 'C2-records-64', 'C2-records-128',
      'C3-128-64',
      'D1-legal-max-extraction', 'D2-legal-max-resume-gate',
      'E-hostile-k0-extraction', 'E-hostile-k0-resume',
      'E-hostile-k30-extraction', 'E-hostile-k30-resume',
    ]);
    // The legal envelope rows ride the DERIVED maximum, never a literal.
    expect(full.find((r) => r.id === 'D1-legal-max-extraction').artifact.recordCount).toBe(228);
    expect(full.find((r) => r.id === 'D2-legal-max-resume-gate').artifact.maxGenerations).toBe(228);
    const smoke = buildNodeRows(smokeConfig(), { maximumFeasibleGenerations: 228 });
    expect(smoke.map((r) => r.id)).toEqual([
      'S1-extraction', 'S1-resume-gate', 'S1-hostile-k0-extraction', 'S1-hostile-k0-resume', 'S1-resume-full',
    ]);
    expect(smoke.find((r) => r.id === 'S1-resume-full').mode).toBe('resume-full');
  });
});
