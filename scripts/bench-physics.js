// Representative physics benchmark — an INSTRUMENT, not a test (the tiny
// schema smoke in tests/bench-schema.test.js is the only CI touchpoint; no
// shared-CI millisecond threshold exists anywhere). Run with:
//
//     npm run bench:physics              (full matrix, Markdown to stdout)
//     npm run bench:physics -- --smoke   (tiny matrix spanning all classes)
//     npm run bench:physics -- --json report.json
//     npm run bench:physics -- --samples 5 --row-budget 60000
//
// Lives OUTSIDE src/sim on purpose: this file owns all ambient elapsed-time
// measurement (performance.now — monotonic — around the runner's
// hooks.onPhase name-only callbacks; `Date` appears exactly once, for the
// report-generation UTC timestamp). Nothing here alters simulation decisions
// or injects time into trace bytes — tests/bench-schema.test.js locks that.
//
// THREE benchmark classes (canonical performance is never measured through
// the profiler — digest equality proves the profiler's semantic
// non-interference, not zero overhead):
//   1. canonical — profile OFF, trace 'none', both flavors × {1,20,50,100}
//      vehicles × fixtures {A,B,C} on the composite corridor, plus a flat
//      CONTROL workload (fixture A) that isolates terrain cost. External
//      phase timing only. THE headline: is the deterministic flavor
//      affordable as the normal eval backend with profiling off?
//      (Note: trace 'none' still includes the runner's per-step state
//      readback + finiteness latch — that is the honest canonical cost.)
//   2. profiler — profile ON, {A,C} × {1,50} × both flavors. Engine
//      timingStep() median/p90 (labelled INTERNAL PROFILED STEP TIME, never
//      wall-clock) plus the profiler-on-vs-off external overhead. These
//      explain the tax; they do not define it.
//   3. traceOverhead — profile OFF, 'none' vs 'digest', {A,C} × 50 × both
//      flavors: isolates the determinism-instrument cost without profiler
//      contamination.
//
// Discipline: one discarded warm-up evaluation per (flavor, fixture) —
// external timing cannot split warm-up steps inside a single run, and the
// measured ~1.5 ms fresh-module first-step wasm spike lands there; every row
// runs `samples` times with nearest-rank median aggregation (declared);
// rows whose projected runtime exceeds the budget emit an explicit
// {status:'omitted'} — the matrix never silently shrinks; a throwing row
// emits {status:'error'}.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import os from 'node:os';
import process from 'node:process';
import { runEvaluation, EVALUATION_TRACE_VERSION } from '../src/sim/evaluation.js';
import {
  FIXTURE_A, FIXTURE_B, FIXTURE_C, evaluationOptionsFor,
} from '../src/sim/evaluation-fixtures.js';

const FIXTURES = { A: FIXTURE_A, B: FIXTURE_B, C: FIXTURE_C };
const FLAVORS = [['default', false], ['deterministic', true]];
const PHASES = ['createPhysics', 'terrain', 'realize', 'run', 'collect', 'done'];

// Flat control workload: the whole 120 m corridor is exactly-flat pad (plus
// the trailing 6 m blend), no craters/features/zones — same vehicles, same
// stepping discipline, terrain cost isolated by comparison with principal.
const CONTROL_TERRAIN = Object.freeze({
  seed: 20260715,
  startFlatLength: 114,
  startBlendLength: 6,
  craterDensity: 0,
  featureDensity: 0,
  sandCoverage: 0,
  mudCoverage: 0,
});

export function defaultConfig() {
  return {
    smoke: false,
    samples: 3,
    warmupSteps: 60,
    rowBudgetMs: 120000,
    stepsOverride: null, // null = each fixture's declared maxSteps
    flavorFilter: null, // 'default' | 'deterministic'
    fixtureFilter: null, // 'A' | 'B' | 'C'
    vehicleCounts: [1, 20, 50, 100],
    argv: [],
  };
}

export function smokeConfig() {
  return {
    ...defaultConfig(),
    smoke: true,
    samples: 2,
    warmupSteps: 10,
    stepsOverride: 30,
    vehicleCounts: [1],
  };
}

// nearest-rank percentile: ceil(p·N), 1-indexed on the sorted samples.
export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.ceil(p * sorted.length) - 1];
}
const median = (values) => percentile([...values].sort((a, b) => a - b), 0.5);

function buildRows(config) {
  const rows = [];
  const flavors = FLAVORS.filter(([name]) => config.flavorFilter === null || name === config.flavorFilter);
  const fixtureKeys = Object.keys(FIXTURES).filter((k) => config.fixtureFilter === null || k === config.fixtureFilter);
  const smokeKeys = config.smoke ? ['A'] : fixtureKeys;
  // 1. canonical: principal (all fixtures) + control (fixture A only) —
  //    ascending vehicle counts so the budget guard can extrapolate.
  for (const [flavor] of flavors) {
    for (const fixture of smokeKeys) {
      for (const vehicleCount of config.vehicleCounts) {
        rows.push({ class: 'canonical', workload: 'principal', flavor, fixture, vehicleCount, traceMode: 'none', profile: false });
      }
    }
    if (smokeKeys.includes('A')) {
      for (const vehicleCount of config.vehicleCounts) {
        rows.push({ class: 'canonical', workload: 'control', flavor, fixture: 'A', vehicleCount, traceMode: 'none', profile: false });
      }
    }
  }
  // 2. profiler diagnostic: {A,C} × {1,50}.
  const profFixtures = config.smoke ? ['A'] : ['A', 'C'].filter((k) => smokeKeys.includes(k));
  const profCounts = config.smoke ? [1] : [1, 50];
  for (const [flavor] of flavors) {
    for (const fixture of profFixtures) {
      for (const vehicleCount of profCounts) {
        rows.push({ class: 'profiler', workload: 'principal', flavor, fixture, vehicleCount, traceMode: 'none', profile: true });
      }
    }
  }
  // 3. trace overhead: none-vs-digest pairs, {A,C} × 50.
  const overheadCounts = config.smoke ? [1] : [50];
  for (const [flavor] of flavors) {
    for (const fixture of profFixtures) {
      for (const vehicleCount of overheadCounts) {
        for (const traceMode of ['none', 'digest']) {
          rows.push({ class: 'traceOverhead', workload: 'principal', flavor, fixture, vehicleCount, traceMode, profile: false });
        }
      }
    }
  }
  return rows;
}

async function runOnce(desc, config) {
  const fx = FIXTURES[desc.fixture];
  const deterministic = desc.flavor === 'deterministic';
  const marks = {};
  const options = evaluationOptionsFor(fx, {
    deterministic,
    vehicleCount: desc.vehicleCount,
    profile: desc.profile,
    hooks: { onPhase: (name) => { marks[name] = performance.now(); } },
    ...(desc.traceMode === 'none' ? {} : { trace: { mode: desc.traceMode, checkpointInterval: 1 } }),
  });
  if (desc.workload === 'control') options.terrain = { ...CONTROL_TERRAIN };
  if (config.stepsOverride !== null) options.maxSteps = config.stepsOverride;
  const tCall = performance.now();
  const result = await runEvaluation(options);
  const tReturn = performance.now();
  for (const p of PHASES) {
    if (typeof marks[p] !== 'number') throw new Error(`bench: phase mark ${p} missing`);
  }
  return {
    result,
    steps: result.executedSteps,
    phases: {
      createPhysicsMs: marks.terrain - marks.createPhysics, // module init + world creation
      terrainMs: marks.realize - marks.terrain,
      realizationMs: marks.run - marks.realize,
      steppingMs: marks.collect - marks.run,
      collectMs: marks.done - marks.collect, // includes world disposal
      totalMs: tReturn - tCall,
    },
  };
}

async function runRow(desc, config, state) {
  // One discarded warm-up evaluation per (flavor, fixture): absorbs the
  // fresh-module first-step wasm spike + JIT before any measured sample.
  const warmKey = `${desc.flavor}/${desc.fixture}`;
  if (!state.warmed.has(warmKey)) {
    const warmOptions = evaluationOptionsFor(FIXTURES[desc.fixture], {
      deterministic: desc.flavor === 'deterministic',
    });
    warmOptions.maxSteps = config.warmupSteps;
    await runEvaluation(warmOptions);
    state.warmed.add(warmKey);
  }
  // Budget guard: linear vehicle-count extrapolation from the last completed
  // row of the same (class, workload, flavor, fixture).
  const prevKey = `${desc.class}/${desc.workload}/${desc.flavor}/${desc.fixture}/${desc.traceMode}`;
  const prev = state.lastCompleted.get(prevKey);
  if (prev !== undefined) {
    const projected = (prev.totalMs * desc.vehicleCount / prev.vehicleCount) * config.samples;
    if (projected > config.rowBudgetMs) {
      return {
        ...desc,
        status: 'omitted',
        reason: `projected ~${Math.round(projected)} ms (from ${prev.vehicleCount}-vehicle row) exceeds --row-budget ${config.rowBudgetMs} ms`,
      };
    }
  }
  const sampled = [];
  for (let s = 0; s < config.samples; s += 1) sampled.push(await runOnce(desc, config));
  const last = sampled[sampled.length - 1].result;
  const phaseMedians = {};
  for (const key of Object.keys(sampled[0].phases)) {
    phaseMedians[key] = median(sampled.map((s) => s.phases[key]));
  }
  state.lastCompleted.set(prevKey, { vehicleCount: desc.vehicleCount, totalMs: phaseMedians.totalMs });
  const steps = sampled[0].steps;
  const row = {
    ...desc,
    status: 'ok',
    samples: config.samples,
    warmupSteps: config.warmupSteps,
    measuredSteps: steps,
    counts: last.counts,
    phases: phaseMedians,
    meanStepMs: phaseMedians.steppingMs / steps, // arithmetic mean — external timing has no per-step samples
    vehicleStepsPerSec: (desc.vehicleCount * steps) / (phaseMedians.steppingMs / 1000),
    health: {
      nonFiniteVehicles: last.vehicles.filter((v) => !v.finite).length,
      invalidBodies: last.vehicles.filter((v) => !v.bodies.allValid).length,
      invalidJoints: last.vehicles.filter((v) => !v.joints.allValid).length,
      sleepingAtEnd: last.vehicles.reduce((n, v) => n + v.bodies.sleepingAtEnd, 0),
    },
    digest: last.trace === null ? null : last.trace.digest,
    recordCount: last.trace === null ? null : last.trace.recordCount,
    byteCount: last.trace === null ? null : last.trace.byteCount,
    engine: null,
  };
  if (desc.profile) {
    // INTERNAL PROFILED STEP TIME (world.timingStep(), per-step ms) — pooled
    // across samples, never conflated with the external wall numbers.
    const pooled = sampled.flatMap((s) => [...s.result.timing.stepMs]).sort((a, b) => a - b);
    row.engine = {
      stepMsMedian: percentile(pooled, 0.5),
      stepMsP90: percentile(pooled, 0.9),
      sampleCount: pooled.length,
    };
  }
  return row;
}

function deriveRatios(rows) {
  const ok = rows.filter((r) => r.status === 'ok');
  const find = (pred) => ok.find(pred);
  const deterministicOverhead = [];
  for (const r of ok.filter((x) => x.class === 'canonical' && x.flavor === 'deterministic')) {
    const base = find((x) => x.class === 'canonical' && x.flavor === 'default'
      && x.fixture === r.fixture && x.vehicleCount === r.vehicleCount && x.workload === r.workload);
    if (base) {
      deterministicOverhead.push({
        workload: r.workload,
        fixture: r.fixture,
        vehicleCount: r.vehicleCount,
        ratio: r.phases.steppingMs / base.phases.steppingMs,
      });
    }
  }
  const digestOverhead = [];
  for (const r of ok.filter((x) => x.class === 'traceOverhead' && x.traceMode === 'digest')) {
    const base = find((x) => x.class === 'traceOverhead' && x.traceMode === 'none'
      && x.flavor === r.flavor && x.fixture === r.fixture && x.vehicleCount === r.vehicleCount);
    if (base) {
      digestOverhead.push({
        flavor: r.flavor,
        fixture: r.fixture,
        vehicleCount: r.vehicleCount,
        noneSteppingMs: base.phases.steppingMs,
        digestSteppingMs: r.phases.steppingMs,
        ratio: r.phases.steppingMs / base.phases.steppingMs,
      });
    }
  }
  const profilerOverhead = [];
  for (const r of ok.filter((x) => x.class === 'profiler')) {
    const base = find((x) => x.class === 'canonical' && x.workload === 'principal'
      && x.flavor === r.flavor && x.fixture === r.fixture && x.vehicleCount === r.vehicleCount);
    if (base) {
      profilerOverhead.push({
        flavor: r.flavor,
        fixture: r.fixture,
        vehicleCount: r.vehicleCount,
        ratio: r.phases.steppingMs / base.phases.steppingMs,
      });
    }
  }
  return { deterministicOverhead, digestOverhead, profilerOverhead };
}

function collectMeta(config) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return {
    generatedUtc: new Date().toISOString(), // the ONE Date use — report metadata, outside every deterministic input
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: { model: os.cpus()[0]?.model ?? 'unknown', count: os.cpus().length },
    node: process.version,
    rapier: {
      compat: pkg.dependencies['@dimforge/rapier3d-compat'],
      deterministicCompat: pkg.dependencies['@dimforge/rapier3d-deterministic-compat'],
    },
    fixtures: Object.fromEntries(Object.entries(FIXTURES).map(([k, f]) => [k, {
      name: f.name, version: f.version, terrainSeed: f.terrainConfig.seed, maxSteps: f.maxSteps,
    }])),
    traceSchemaVersion: EVALUATION_TRACE_VERSION,
    controlTerrain: CONTROL_TERRAIN,
    smoke: config.smoke,
    samples: config.samples,
    warmupSteps: config.warmupSteps,
    stepsOverride: config.stepsOverride,
    rowBudgetMs: config.rowBudgetMs,
    percentileMethod: 'nearest-rank ceil(p*N), 1-indexed on sorted samples',
    argv: config.argv,
  };
}

export async function runBenchmark(config = defaultConfig()) {
  const rows = [];
  const state = { warmed: new Set(), lastCompleted: new Map() };
  for (const desc of buildRows(config)) {
    try {
      rows.push(await runRow(desc, config, state));
    } catch (error) {
      rows.push({ ...desc, status: 'error', error: String(error && error.message ? error.message : error) });
    }
  }
  return {
    schema: 'boxcar3d.bench-physics/1',
    meta: collectMeta(config),
    rows,
    derived: deriveRatios(rows),
  };
}

// --- Markdown report -----------------------------------------------------------

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));
const f4 = (n) => (Number.isFinite(n) ? n.toFixed(4) : String(n));

export function renderMarkdown(report) {
  const { meta, rows, derived } = report;
  const lines = [];
  lines.push('# bench:physics report');
  lines.push('');
  lines.push(`Generated ${meta.generatedUtc} on ${meta.os.platform}/${meta.os.arch} (${meta.cpu.model} ×${meta.cpu.count}), Node ${meta.node}, rapier ${meta.rapier.compat}${meta.smoke ? ' — SMOKE matrix' : ''}.`);
  lines.push(`Samples/row: ${meta.samples} (median, ${meta.percentileMethod}); warm-up ${meta.warmupSteps} steps discarded per flavor×fixture; row budget ${meta.rowBudgetMs} ms.`);
  lines.push('All wall numbers are external monotonic timing with the profiler OFF unless the table says otherwise; machine-specific — never a universal package property.');
  lines.push('');
  const ratioFor = (r) => {
    const m = derived.deterministicOverhead.find((d) => d.workload === r.workload
      && d.fixture === r.fixture && d.vehicleCount === r.vehicleCount);
    return r.flavor === 'deterministic' && m ? `${f2(m.ratio)}×` : '';
  };
  const canonicalTable = (workload, title) => {
    const subset = rows.filter((r) => r.class === 'canonical' && r.workload === workload);
    if (subset.length === 0) return;
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| Flavor | Fixture | Vehicles | Bodies/Joints | Init ms | Terrain ms | Realize ms | Step total ms | Step mean ms | Veh-steps/s | Det÷Def | Status |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of subset) {
      if (r.status !== 'ok') {
        lines.push(`| ${r.flavor} | ${r.fixture} | ${r.vehicleCount} | — | — | — | — | — | — | — | — | ${r.status}: ${r.reason ?? r.error} |`);
        continue;
      }
      lines.push(`| ${r.flavor} | ${r.fixture} | ${r.vehicleCount} | ${r.counts.bodies}/${r.counts.joints} | ${f2(r.phases.createPhysicsMs)} | ${f2(r.phases.terrainMs)} | ${f2(r.phases.realizationMs)} | ${f2(r.phases.steppingMs)} | ${f4(r.meanStepMs)} | ${Math.round(r.vehicleStepsPerSec)} | ${ratioFor(r)} | ok |`);
    }
    lines.push('');
  };
  canonicalTable('principal', 'Canonical affordability — composite corridor (profile off, trace none)');
  canonicalTable('control', 'Control — flat corridor (terrain cost isolation, fixture A)');
  const prof = rows.filter((r) => r.class === 'profiler');
  if (prof.length > 0) {
    lines.push('## Profiler diagnostic (profile ON — engine numbers are INTERNAL PROFILED STEP TIME, not wall clock)');
    lines.push('');
    lines.push('| Flavor | Fixture | Vehicles | Engine step med ms | Engine step p90 ms | External step total ms | Profiler-on ÷ off | Status |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of prof) {
      if (r.status !== 'ok') {
        lines.push(`| ${r.flavor} | ${r.fixture} | ${r.vehicleCount} | — | — | — | — | ${r.status}: ${r.reason ?? r.error} |`);
        continue;
      }
      const m = report.derived.profilerOverhead.find((d) => d.flavor === r.flavor
        && d.fixture === r.fixture && d.vehicleCount === r.vehicleCount);
      lines.push(`| ${r.flavor} | ${r.fixture} | ${r.vehicleCount} | ${f4(r.engine.stepMsMedian)} | ${f4(r.engine.stepMsP90)} | ${f2(r.phases.steppingMs)} | ${m ? `${f2(m.ratio)}×` : ''} | ok |`);
    }
    lines.push('');
  }
  if (derived.digestOverhead.length > 0) {
    lines.push('## Trace-instrument overhead (profile off; none vs digest)');
    lines.push('');
    lines.push('| Flavor | Fixture | Vehicles | none step ms | digest step ms | Overhead × |');
    lines.push('|---|---|---|---|---|---|');
    for (const d of derived.digestOverhead) {
      lines.push(`| ${d.flavor} | ${d.fixture} | ${d.vehicleCount} | ${f2(d.noneSteppingMs)} | ${f2(d.digestSteppingMs)} | ${f2(d.ratio)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// --- CLI -------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      smoke: { type: 'boolean', default: false },
      samples: { type: 'string' },
      'row-budget': { type: 'string' },
      flavor: { type: 'string' },
      fixture: { type: 'string' },
      json: { type: 'string' },
    },
  });
  const config = values.smoke ? smokeConfig() : defaultConfig();
  if (values.samples !== undefined) config.samples = Number(values.samples);
  if (values['row-budget'] !== undefined) config.rowBudgetMs = Number(values['row-budget']);
  if (values.flavor !== undefined) config.flavorFilter = values.flavor;
  if (values.fixture !== undefined) config.fixtureFilter = values.fixture;
  config.argv = process.argv.slice(2);
  if (!Number.isInteger(config.samples) || config.samples < 1) throw new Error(`bench: invalid --samples ${config.samples}`);
  if (!Number.isFinite(config.rowBudgetMs) || config.rowBudgetMs <= 0) throw new Error(`bench: invalid --row-budget ${config.rowBudgetMs}`);
  const report = await runBenchmark(config);
  console.log(renderMarkdown(report));
  if (values.json !== undefined) {
    writeFileSync(values.json, JSON.stringify(report, null, 2));
    console.log(`\nJSON written to ${values.json}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
