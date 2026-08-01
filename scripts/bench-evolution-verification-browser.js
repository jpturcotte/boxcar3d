// PR 4D — THE BROWSER (CHROMIUM) SCALE DRIVER.
//
// PROOF ROLE, stated up front: this is the MANUAL EVIDENCE COMMAND for the
// browser leg of the PR-4D scale benchmark — never CI. It measures the
// landed PR-4C persisted-history verifier (the extractHistoryObservations
// seam) inside the pinned Chromium over PREBUILT artifacts, on a fresh page
// per measured sample, and emits the browserRows + B5 budgetOutcome half of
// the bench report schema (the Node half is bench-evolution-verification.js,
// whose frozen BUDGETS/BENCH_SCHEMA/band helpers this file reuses so the two
// reports cannot drift).
//
// Run:
//   node scripts/bench-evolution-verification-browser.js              # full 4-row matrix
//   node scripts/bench-evolution-verification-browser.js --self-check # smallest row only, human summary
//   node scripts/bench-evolution-verification-browser.js --json <path> [--samples 5]
//
// METHODOLOGY IN BRIEF (mirrors the Node instrument's contract):
//   - artifacts are constructed NODE-SIDE, ONCE per row, before any measured
//     interval (constructionMs reported separately), written to a fresh tmp
//     dir, and served to the browser over HTTP by a Vite dev-server
//     middleware at /__bench_artifact__/<id>; a measured page NEVER builds
//     an artifact (in-page construction warms the kernel, blocks the page,
//     and breaks Node-vs-browser byte-identity);
//   - each measured sample runs in a FRESH PAGE (browser.newPage()), so
//     JS heap/JIT/page state cannot carry between samples;
//   - the BYTE-IDENTITY chain is toothed twice: the page throws unless the
//     fetched bytes match the driver's length + SHA-256, and the driver
//     throws unless the page's reported pageSaw digest equals its own —
//     Node-vs-browser byte-identity is asserted, never assumed;
//   - event-loop evidence is the page's primed/drained rAF + 4 ms timer
//     heartbeat (scripts/browser-bench/page.js carries the contract); a
//     sample without primed AND drained evidence fails the row loudly;
//   - memory is driver CDP Performance.getMetrics polling at 100 ms — it may
//     not observe in-block peaks inside the synchronous verifier and is NOT a
//     process memory measure. In-page performance.memory is collected by the
//     page but deliberately NOT aggregated into rows (deprecated, rounded);
//     the row method string says exactly this;
//   - no CI millisecond threshold exists anywhere here: B5 is a predeclared,
//     non-gating budget echoed verbatim from the instrument and evaluated in
//     the evidence doc.
//
// THE ONE Date use is report metadata. Wall clock elsewhere is the
// measurement quantity itself (this file is Node-side instrumentation,
// outside the src/sim bans).

import os from 'node:os';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { chromium } from 'playwright';
import { createServer } from 'vite';

import { sha256 } from '../src/platform/sha256.js';
import { bytesToHex } from '../src/sim/bytes.js';
import { readSourceIdentity } from './experiment-evolution.js';
import {
  BENCH_SCHEMA, BUDGETS, median, percentile, responsivenessBand,
} from './bench-evolution-verification.js';
import {
  BENCH_CAPACITY_POPULATION_SEED, buildScaleArtifact, createBenchCapacityEvaluationSpec,
  deriveCapacityMaximumGenerations, readBenchRuntimeIdentity,
} from './bench-evolution-verification-artifacts.js';
import {
  GENUINE_CORPUS_PLANS, assertGenuineMemberShape, buildGenuineCorpusMember,
} from './bench-evolution-verification-corpus.js';

// THE BROWSER ROW SET, in measurement order. The two synthetic shapes pair
// with the Node instrument's representative extraction rows; G2 is the
// 30-generation defaults member of the genuine corpus; the legal-max row is
// the derived v1 envelope at population 256 (the capacity-test
// configuration, exactly like the Node D-rows).
const BROWSER_ROW_IDS = Object.freeze([
  'B-synthetic-20-30',
  'B-synthetic-20-60',
  'B-genuine-G2',
  'B-legal-max',
]);

// B5 gates on the three REPRESENTATIVE rows (interactive-use honesty); the
// legal-max envelope row is reported with its band but is not an
// interactive-use claim — its batch-class gap is expected, not a violation.
const B5_REPRESENTATIVE_IDS = Object.freeze([
  'B-synthetic-20-30',
  'B-synthetic-20-60',
  'B-genuine-G2',
]);

const roundMs = (value) => (value === null || value === undefined ? null : Math.round(value));

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

// Pure argv -> config (the instrument precedent: no side effects, loud on
// invalid input).
export function configFromArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'string' },
      samples: { type: 'string' },
      'self-check': { type: 'boolean', default: false },
    },
  });
  let samples = 3;
  if (values.samples !== undefined) {
    const parsed = Number(values.samples);
    if (!Number.isInteger(parsed) || parsed < 3) {
      throw new Error(`browser-bench: invalid --samples '${String(values.samples)}' (integer >= 3 required)`);
    }
    samples = parsed;
  }
  return Object.freeze({
    json: values.json ?? null,
    samples,
    selfCheck: values['self-check'] === true,
  });
}

// ---------------------------------------------------------------------------
// 1. NODE-SIDE ARTIFACT CONSTRUCTION (never inside a measured interval)
// ---------------------------------------------------------------------------

// Build ONE browser-row artifact Node-side, timed. Mirrors the Node
// instrument's constructRowArtifact shapes so a browser row and its Node
// sibling measure byte-comparable inputs (same builder, same seeds, same
// capacity derivation). The genuine builder is injectable so the browser
// leg's campaign-shape gate can be proven against a mis-shaped stub.
export async function buildRowArtifact(rowId, runtime, { genuineBuilder = buildGenuineCorpusMember } = {}) {
  const startedAt = performance.now();
  if (rowId === 'B-synthetic-20-30' || rowId === 'B-synthetic-20-60') {
    const recordCount = rowId === 'B-synthetic-20-30' ? 30 : 60;
    const built = await buildScaleArtifact(runtime, {
      populationSize: 20, recordCount, maxGenerations: recordCount + 1,
    });
    return {
      id: rowId,
      kind: 'synthetic',
      bytes: built.bytes,
      populationSize: built.populationSize,
      recordCount: built.recordCount,
      maxGenerations: built.maxGenerations,
      terminalReason: built.terminalReason,
      constructionMs: performance.now() - startedAt,
    };
  }
  if (rowId === 'B-genuine-G2') {
    const plan = GENUINE_CORPUS_PLANS.find((p) => p.id === 'G2');
    const built = await genuineBuilder(plan, { protocolKind: 'full' });
    // The campaign-shape gate: an early-terminated run is never published as
    // its planned 30-record generationLimitReached shape (external review
    // finding 1) — and the metadata below is the MEASURED provenance.
    assertGenuineMemberShape(plan, built.provenance);
    return {
      id: rowId,
      kind: 'genuine',
      bytes: built.bytes,
      populationSize: built.provenance.populationSize,
      recordCount: built.provenance.advanceCount,
      maxGenerations: null,
      terminalReason: built.provenance.terminalReason,
      provenance: built.provenance,
      constructionMs: built.provenance.evolveMs,
    };
  }
  if (rowId === 'B-legal-max') {
    const derived = deriveCapacityMaximumGenerations(256);
    const mfg = derived.maximumFeasibleGenerations;
    const built = await buildScaleArtifact(runtime, {
      populationSize: 256,
      recordCount: mfg,
      maxGenerations: mfg,
      seed: BENCH_CAPACITY_POPULATION_SEED,
      spec: createBenchCapacityEvaluationSpec(),
    });
    return {
      id: rowId,
      kind: 'synthetic',
      bytes: built.bytes,
      populationSize: built.populationSize,
      recordCount: built.recordCount,
      maxGenerations: built.maxGenerations,
      terminalReason: built.terminalReason,
      constructionMs: performance.now() - startedAt,
      derivedFrom: derived.derivedFrom,
    };
  }
  throw new Error(`browser-bench: unknown row id '${rowId}'`);
}

// ---------------------------------------------------------------------------
// 2. THE DEV SERVER (Vite serves the page; the middleware serves the bytes)
// ---------------------------------------------------------------------------

async function startBenchServer(repoRoot, artifactFiles) {
  const server = await createServer({
    configFile: false,
    root: repoRoot,
    logLevel: 'warn',
    // host 127.0.0.1 is load-bearing twice: the page must be a secure context
    // for WebCrypto SHA-256, and Vite's default `localhost` bind resolves to
    // IPv6 ::1 on Windows — where Chromium's IPv4 127.0.0.1 navigation is
    // refused. Vite treats port 0 as UNSET (a falsy fallback to 5173, then
    // the next free port with strictPort off), so the bound port is ALWAYS
    // read back from server.httpServer.address().port below, never assumed.
    server: { port: 0, host: '127.0.0.1' },
    plugins: [{
      name: 'pr4d-bench-artifacts',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const prefix = '/__bench_artifact__/';
          if (!req.url || !req.url.startsWith(prefix)) {
            next();
            return;
          }
          const id = req.url.slice(prefix.length).split(/[?#]/, 1)[0];
          // Exact-id lookup only: a URL that is not a declared row id is a
          // 404, never a path into the tmp dir.
          const filePath = artifactFiles.get(id);
          if (filePath === undefined) {
            res.statusCode = 404;
            res.end('unknown bench artifact');
            return;
          }
          res.setHeader('content-type', 'application/octet-stream');
          createReadStream(filePath).pipe(res);
        });
      },
    }],
  });
  await server.listen();
  return { server, port: server.httpServer.address().port };
}

// ---------------------------------------------------------------------------
// 3. THE MEASURED SAMPLE (fresh page per sample)
// ---------------------------------------------------------------------------

// One measured sample: fresh page, CDP JSHeapUsedSize polling at 100 ms
// while the row runs, then the page's own heartbeat-measured row result.
// The poll loop is the driver's; it terminates IN FINALLY (a throwing page
// must not leak a permanent timer chain — the post-review audit reproduced
// the leak) and tolerates the page closing underneath it.
async function runOneBrowserSample(browser, port, artifact) {
  const page = await browser.newPage();
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');
    const cdpSamples = [];
    let polling = true;
    const pollLoop = (async () => {
      while (polling) {
        try {
          const metricsReport = await client.send('Performance.getMetrics');
          const heap = metricsReport.metrics.find((m) => m.name === 'JSHeapUsedSize');
          cdpSamples.push({
            t: performance.now(),
            jsHeapUsedSize: heap ? heap.value : null,
          });
        } catch {
          // The page closed or is closing mid-poll — the driver owns poll
          // termination; a lost trailing sample is not a measurement defect.
        }
        await new Promise((resolve) => { globalThis.setTimeout(resolve, 100); });
      }
    })();
    let result;
    try {
      await page.goto(`http://127.0.0.1:${port}/scripts/browser-bench/evolution-verification.html`);
      await page.waitForFunction(() => globalThis.__benchPage !== undefined);
      result = await page.evaluate(
        (spec) => globalThis.__benchPage.runBrowserExtractionRow(spec),
        {
          artifactUrl: `/__bench_artifact__/${artifact.id}`,
          expectedByteLength: artifact.bytes.length,
          expectedSha256Hex: artifact.sha256Hex,
          rowId: artifact.id,
        },
      );
    } finally {
      polling = false;
      await pollLoop;
    }
    // THE DRIVER-SIDE BYTE-IDENTITY TOOTH: the page proved it received the
    // driver's bytes; here the driver proves the page's reported identity IS
    // its own artifact. Node-vs-browser byte-identity is asserted, never
    // assumed.
    if (result.pageSaw.sha256Hex !== artifact.sha256Hex) {
      throw new Error(`browser-bench: page/driver artifact identity diverged on '${artifact.id}' — page saw ${result.pageSaw.sha256Hex}, driver holds ${artifact.sha256Hex}`);
    }
    return { ...result, cdpSamples };
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// 4. ROW ASSEMBLY (the non-vacuous teeth live here)
// ---------------------------------------------------------------------------

export function consistentVerdict(verdicts, rowId) {
  const first = JSON.stringify(verdicts[0]);
  for (const verdict of verdicts) {
    if (JSON.stringify(verdict) !== first) {
      throw new Error(`browser-bench: row '${rowId}' reported inconsistent verdicts across samples — ${first} vs ${JSON.stringify(verdict)}`);
    }
  }
  return verdicts[0];
}

// Assemble one report row from raw page samples. The guards mirror the Node
// instrument's assembleRow: primed/drained heartbeat evidence on EVERY
// sample (defects 8/9, browser leg) INCLUDING the tick-channel prime tooth
// (frame-begin rAF timestamps self-prime, so only the tick channel can carry
// it), verdict consistency, and the extraction row contract (an extraction
// row that refuses is a mislabeled artifact, not a timing). Exported so the
// Node-side schema test can pin these refusals directly — the repo's
// assembleRow export-and-guard-test precedent.
export function assembleBrowserRow(artifact, samples, browserVersion) {
  for (const sample of samples) {
    if (!sample.frameGap || sample.frameGap.primed !== true || sample.frameGap.drained !== true) {
      throw new Error(`browser-bench: row '${artifact.id}' has a sample without primed/drained heartbeat evidence`);
    }
    if (sample.frameGap.tickPrimedBeforeT0 !== true) {
      throw new Error(`browser-bench: row '${artifact.id}' has a sample whose tick channel was not live before t0 — the prime tooth rides the tick channel (rAF frame-begin timestamps self-prime)`);
    }
  }
  const verdict = consistentVerdict(samples.map((s) => s.verdict), artifact.id);
  if (verdict.success !== true) {
    throw new Error(`browser-bench: row '${artifact.id}' (extraction) must succeed; got ${JSON.stringify(verdict)}`);
  }
  const samplesMs = samples.map((s) => roundMs(s.elapsedMs));
  const perSampleMaxGapMs = samples.map((s) => s.frameGap.maxGapMs);
  const maxGapMs = Math.round(Math.max(...perSampleMaxGapMs));
  const gapsOver50ms = samples.reduce((sum, s) => sum + s.frameGap.gapsOver50ms, 0);
  const cdpSampleCount = samples.reduce((sum, s) => sum + s.cdpSamples.length, 0);
  // Before/after come from the LAST sample's CDP stream (fresh page per
  // sample; the last sample is the representative one). Labeled non-peak,
  // non-process — the method string is the honest claim.
  const lastCdpSamples = samples[samples.length - 1].cdpSamples;
  const firstCdp = lastCdpSamples.length > 0 ? lastCdpSamples[0] : null;
  const lastCdp = lastCdpSamples.length > 0 ? lastCdpSamples[lastCdpSamples.length - 1] : null;
  return Object.freeze({
    id: artifact.id,
    mode: 'extraction',
    reader: 'extractHistoryObservations',
    environment: 'chromium',
    browser: Object.freeze({ name: 'chromium', version: browserVersion }),
    physics: false,
    verifierKernelCalls: artifact.recordCount - 1,
    verifierKernelCallsBasis: 'contract-derived (tests/evolution-local-semantics.test.js A1), not measured',
    verdict,
    samplesMs,
    medianMs: roundMs(median(samplesMs)),
    p90Ms: roundMs(percentile(samplesMs, 0.9)),
    frameGap: Object.freeze({
      method: samples[0].frameGap.method,
      primed: true,
      drained: true,
      tickPrimedBeforeT0: true, // asserted per sample by the guard above
      maxGapMs,
      gapsOver50ms,
      band: responsivenessBand(maxGapMs),
    }),
    memory: Object.freeze({
      method: 'driver CDP Performance.getMetrics polling at 100 ms (may not observe in-block peaks; NOT a process memory measure); in-page performance.memory is collected by the page but deliberately NOT aggregated here — it is deprecated and rounded',
      cdpSampleCount,
      jsHeapUsedBefore: firstCdp ? firstCdp.jsHeapUsedSize : null,
      jsHeapUsedAfter: lastCdp ? lastCdp.jsHeapUsedSize : null,
    }),
    pageSaw: Object.freeze({
      byteLength: samples[0].pageSaw.byteLength,
      sha256Hex: samples[0].pageSaw.sha256Hex,
      matchesDriverArtifact: true, // asserted per sample above — never assumed
    }),
  });
}

// ---------------------------------------------------------------------------
// REPORT ASSEMBLY
// ---------------------------------------------------------------------------

// The B5 outcome, evaluated against the SAME frozen BUDGETS the report
// echoes — never a literal (external review finding 2: a future budget edit
// must change display and verdict together). `budgets` is injectable so the
// test can prove the outcome follows the SUPPLIED budget.
//
// FAIL CLOSED on the representative set (external review, PR #37 round 2):
// B5's claim is "all three representative rows pass", so the three must
// EXIST — exactly once each, with finite values. `[].every()` is true, and
// a missing, duplicated, or non-finite representative must never become a
// passing verdict. Additional rows (the legal-max classification) are
// allowed; replacement of a representative is not.
export function assembleB5Outcome(budgetPerRow, { selfCheck = false, budgets = BUDGETS } = {}) {
  const b5 = budgets.find((b) => b.id === 'B5');
  if (!b5) throw new Error("browser-bench: no budget with id 'B5' in the supplied budgets");
  let representative = null;
  if (!selfCheck) {
    representative = B5_REPRESENTATIVE_IDS.map((id) => {
      const matches = budgetPerRow.filter((r) => r.id === id);
      if (matches.length !== 1) {
        throw new Error(`browser-bench: B5 requires exactly one result for representative row '${id}', got ${matches.length} — a missing or duplicated representative row is not a passing budget outcome`);
      }
      if (!Number.isFinite(matches[0].medianMaxGapMs)) {
        throw new Error(`browser-bench: B5 representative row '${id}' carries non-finite medianMaxGapMs (${String(matches[0].medianMaxGapMs)}) — not a measurable outcome`);
      }
      return matches[0];
    });
  }
  return Object.freeze({
    id: 'B5',
    gating: false,
    perRow: budgetPerRow,
    // B5 passes iff the three representative rows all sit at or below the
    // budget's band edge. --self-check measures one row, so the budget is
    // not evaluated there (null), matching the Node instrument's
    // not-measured-in-this-configuration convention.
    pass: selfCheck
      ? null
      : representative.every((r) => r.medianMaxGapMs <= b5.threshold.maxGapMs),
  });
}

function collectMeta(config, browserVersion) {
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
    browser: { name: 'chromium', version: browserVersion },
    benchmarkConfig: config,
    memoryMethod: 'driver CDP Performance.getMetrics polling at 100 ms (may not observe in-block peaks; NOT a process memory measure); in-page performance.memory collected by the page but deliberately not aggregated (deprecated, rounded)',
    eventLoopMethod: 'page rAF + 4 ms timer heartbeats, primed >= 2 pre-op timestamps before t0 and drained post-op timestamps after t1',
    percentileMethod: 'nearest-rank ceil(p*N), 1-indexed on sorted samples; median = p0.5, upper = p90',
    argv: process.argv.slice(2),
  });
}

function printHumanSummary(report) {
  const row = report.browserRows[0];
  const artifact = report.artifacts[0];
  const budget = report.budgetOutcomes[0];
  console.log('PR-4D browser self-check — B-synthetic-20-30 only');
  console.log(`  browser: chromium ${report.meta.browser.version}`);
  console.log(`  artifact: ${artifact.byteLength} bytes, sha256 ${artifact.sha256Hex.slice(0, 16)}…, construction ${artifact.constructionMs} ms`);
  console.log(`  verdict: ${JSON.stringify(row.verdict)}`);
  console.log(`  samplesMs: [${row.samplesMs.join(', ')}]  median ${row.medianMs} ms, p90 ${row.p90Ms} ms`);
  console.log(`  frameGap: max ${row.frameGap.maxGapMs} ms across samples; per-row median ${budget.perRow[0].medianMaxGapMs} ms -> band '${budget.perRow[0].band}'; gaps>50ms ${row.frameGap.gapsOver50ms}`);
  console.log(`  heartbeat: primed ${row.frameGap.primed}, drained ${row.frameGap.drained}`);
  console.log(`  byte-identity: page saw sha256 ${row.pageSaw.sha256Hex.slice(0, 16)}… == driver artifact (${row.pageSaw.matchesDriverArtifact})`);
  console.log(`  memory (non-peak, non-process): CDP samples ${row.memory.cdpSampleCount}, JS heap before ${row.memory.jsHeapUsedBefore}, after ${row.memory.jsHeapUsedAfter}`);
  console.log('  self-check OK — B5 pass is null by design in --self-check');
}

// ---------------------------------------------------------------------------
// THE ORCHESTRATION
// ---------------------------------------------------------------------------

export async function runBrowserBenchmark(config) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const tmpDir = join(os.tmpdir(), `boxcar3d-bench-browser-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  let server = null;
  let browser = null;
  try {
    // Construction phase — NODE-SIDE, timed, NEVER inside a measured
    // interval. --self-check builds only the smallest row.
    const runtime = await readBenchRuntimeIdentity();
    const rowIds = config.selfCheck ? ['B-synthetic-20-30'] : [...BROWSER_ROW_IDS];
    const artifacts = [];
    for (const rowId of rowIds) {
      const artifact = await buildRowArtifact(rowId, runtime);
      artifact.sha256Hex = bytesToHex(await sha256(artifact.bytes));
      artifact.path = join(tmpDir, `${rowId}.bin`);
      writeFileSync(artifact.path, artifact.bytes);
      artifacts.push(artifact);
      console.log(`browser-bench: built ${rowId} (${artifact.bytes.length} bytes, sha256 ${artifact.sha256Hex.slice(0, 16)}…) in ${Math.round(artifact.constructionMs)} ms`);
    }

    const started = await startBenchServer(
      repoRoot,
      new Map(artifacts.map((artifact) => [artifact.id, artifact.path])),
    );
    server = started.server;
    const { port } = started;

    // Measured phase — fresh page per sample.
    browser = await chromium.launch();
    const browserVersion = browser.version();
    const browserRows = [];
    const budgetPerRow = [];
    for (const artifact of artifacts) {
      const samples = [];
      for (let i = 0; i < config.samples; i += 1) {
        console.log(`browser-bench: ${artifact.id} sample ${i + 1}/${config.samples}`);
        // The row IS sequential: one fresh page at a time, by design.
        samples.push(await runOneBrowserSample(browser, port, artifact));
      }
      browserRows.push(assembleBrowserRow(artifact, samples, browserVersion));
      // The B5 metric is the median of the PER-SAMPLE max gap, classified by band.
      const perSampleMaxGapMs = samples.map((s) => s.frameGap.maxGapMs);
      const medianMaxGapMs = Math.round(median(perSampleMaxGapMs));
      budgetPerRow.push(Object.freeze({
        id: artifact.id,
        medianMaxGapMs,
        band: responsivenessBand(medianMaxGapMs),
      }));
    }

    const report = {
      schema: BENCH_SCHEMA,
      meta: collectMeta(config, browserVersion),
      budgets: BUDGETS,
      artifacts: artifacts.map((artifact) => Object.freeze({
        id: artifact.id,
        construction: artifact.kind === 'genuine' ? 'production-run-genuine' : 'kernel-honest-synthetic',
        populationSize: artifact.populationSize,
        recordCount: artifact.recordCount,
        maxGenerations: artifact.maxGenerations,
        byteLength: artifact.bytes.length,
        sha256Hex: artifact.sha256Hex,
        historyDigestHex: browserRows.find((r) => r.id === artifact.id).verdict.historyDigestHex,
        terminalReason: artifact.terminalReason,
        provenance: artifact.provenance ?? null,
        constructionMs: roundMs(artifact.constructionMs),
      })),
      browserRows,
      budgetOutcomes: [assembleB5Outcome(budgetPerRow, { selfCheck: config.selfCheck })],
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (config.json) {
      writeFileSync(config.json, json);
      console.log(`browser-bench: report written to ${config.json}`);
    } else if (config.selfCheck) {
      printHumanSummary(report);
    } else {
      console.log(json);
    }
    return report;
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBrowserBenchmark(configFromArgs(process.argv.slice(2)));
}
