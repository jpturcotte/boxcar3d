// Representative physics benchmark — an INSTRUMENT, not a test (the tiny
// schema smoke in tests/bench-schema.test.js is the only CI touchpoint; no
// shared-CI millisecond threshold exists anywhere). Run with:
//
//     npm run bench:physics              (full matrix, Markdown to stdout)
//     npm run bench:physics -- --smoke   (tiny matrix spanning all families)
//     npm run bench:physics -- --json report.json
//     npm run bench:physics -- --samples 5 --row-budget 600000
//
// Lives OUTSIDE src/sim on purpose: this file owns all ambient elapsed-time
// measurement (performance.now — monotonic — around the runner's
// hooks.onPhase name-only callbacks; `Date` appears exactly once, for the
// report-generation UTC timestamp). Nothing here alters simulation decisions
// or injects time into trace bytes — tests/bench-schema.test.js locks that.
//
// TWO REVIEW AMENDMENTS drive this design:
//
// (1) REAL composite principal terrain. The golden determinism fixtures A/B/C
//     each carry their OWN terrain (A and C disable craters/features/zones and
//     use an 80 m flat pad; only B is composite). Benchmarking on those makes
//     the "composite corridor" label false for A/C — they never leave the flat
//     pad. So the benchmark owns PRINCIPAL_TERRAIN (composite defaults ON, a
//     start pad that covers every fixture's spawn yet blends to composite in
//     time for all three to drive onto it), overrides the terrain for EVERY
//     principal row, and a reached-composite tooth marks a row INVALID if the
//     vehicle never crosses the blend. The golden fixtures are untouched.
//
// (2) PAIRED, INTERLEAVED sampling. Rows are run sequentially, so independent
//     per-row medians carry run-order noise LARGER than some claimed ratios
//     (profiler-on can measure faster than off; deterministic control faster
//     than default — both noise). Every comparison therefore runs its two arms
//     BACK-TO-BACK within each sample, alternating order across samples, and
//     reports the MEDIAN OF PER-PAIR RATIOS (with raw arm medians preserved).
//     That cancels slow drift and first-of-pair bias that unpaired medians
//     cannot.
//
// Three comparison families: deterministicTax (default vs deterministic),
// profilerOverhead (profile off vs on), digestOverhead (trace none vs digest).
// Canonical/control absolute tables are derived from the deterministicTax arms
// (each arm IS a full profile-off/trace-none row). Control carries A AND C so
// the report distinguishes max-topology cost on FLAT ground (control C) from
// max-topology cost on COMPOSITE terrain (principal C).

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import os from 'node:os';
import process from 'node:process';
import { runEvaluation, EVALUATION_TRACE_VERSION } from '../src/sim/evaluation.js';
import { FIXTURE_A, FIXTURE_B, FIXTURE_C, evaluationOptionsFor } from '../src/sim/evaluation-fixtures.js';
import { generateCorridorTerrain, startEnvelope } from '../src/sim/terrain.js';

const FIXTURES = { A: FIXTURE_A, B: FIXTURE_B, C: FIXTURE_C };
const FLAVOR_NAMES = ['default', 'deterministic'];
const PHASES = ['createPhysics', 'terrain', 'realize', 'run', 'collect', 'done'];

// Benchmark-owned composite principal terrain: composite defaults ON, a 20 m
// flat start pad (covers the fixtures' x∈{−44,−45} spawns, since the pad spans
// x∈[−60,−40]) that blends to composite by x=−34. Measured: A/B/C all reach
// fully-composite ground (startEnvelope === 1) on both flavors before the run
// ends. Fresh seed 20260718 (distinct from every fixture/lock/probe seed).
const PRINCIPAL_TERRAIN = Object.freeze({ seed: 20260718, startFlatLength: 20, startBlendLength: 6 });
// Flat control: the whole corridor is exactly-flat pad + trailing blend, no
// craters/features/zones — same vehicles, terrain cost isolated by comparison.
const CONTROL_TERRAIN = Object.freeze({
  seed: 20260715, startFlatLength: 114, startBlendLength: 6,
  craterDensity: 0, featureDensity: 0, sandCoverage: 0, mudCoverage: 0,
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
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
const median = (values) => percentile([...values].sort((a, b) => a - b), 0.5);

function fixtureKeysFor(config) {
  const all = Object.keys(FIXTURES);
  if (config.fixtureFilter !== null) return [config.fixtureFilter];
  return config.smoke ? ['A'] : all;
}
function flavorsFor(config) {
  return FLAVOR_NAMES.filter((f) => config.flavorFilter === null || f === config.flavorFilter);
}

// A comparison = two arms measured paired+interleaved. denom is the baseline,
// numer the thing compared to it; ratio = numer.steppingMs / denom.steppingMs.
function buildComparisons(config) {
  const comparisons = [];
  const fixtures = fixtureKeysFor(config);
  const flavors = flavorsFor(config);
  const counts = config.vehicleCounts;
  const diag = config.smoke ? ['A'] : ['A', 'C'];
  const diagFixtures = diag.filter((k) => fixtures.includes(k));
  const diagCounts = config.smoke ? [1] : [1, 50];
  const overheadCounts = config.smoke ? [1] : [50];
  const hasDet = flavors.includes('deterministic');
  const hasDef = flavors.includes('default');

  // deterministicTax — only when BOTH flavors are in scope (the pair needs them).
  if (hasDef && hasDet) {
    for (const fixture of fixtures) {
      for (const vehicleCount of counts) {
        comparisons.push({
          family: 'deterministicTax', workload: 'principal', fixture, vehicleCount,
          ratioLabel: 'Det÷Def',
          denom: { flavor: 'default', profile: false, traceMode: 'none' },
          numer: { flavor: 'deterministic', profile: false, traceMode: 'none' },
        });
      }
    }
    for (const fixture of ['A', 'C'].filter((k) => fixtures.includes(k))) {
      for (const vehicleCount of counts) {
        comparisons.push({
          family: 'deterministicTax', workload: 'control', fixture, vehicleCount,
          ratioLabel: 'Det÷Def',
          denom: { flavor: 'default', profile: false, traceMode: 'none' },
          numer: { flavor: 'deterministic', profile: false, traceMode: 'none' },
        });
      }
    }
  }
  // profilerOverhead — per flavor in scope.
  for (const flavor of flavors) {
    for (const fixture of diagFixtures) {
      for (const vehicleCount of diagCounts) {
        comparisons.push({
          family: 'profilerOverhead', workload: 'principal', fixture, vehicleCount,
          ratioLabel: 'ProfOn÷Off',
          denom: { flavor, profile: false, traceMode: 'none' },
          numer: { flavor, profile: true, traceMode: 'none' },
        });
      }
    }
  }
  // digestOverhead — per flavor in scope.
  for (const flavor of flavors) {
    for (const fixture of diagFixtures) {
      for (const vehicleCount of overheadCounts) {
        comparisons.push({
          family: 'digestOverhead', workload: 'principal', fixture, vehicleCount,
          ratioLabel: 'Digest÷None',
          denom: { flavor, profile: false, traceMode: 'none' },
          numer: { flavor, profile: false, traceMode: 'digest' },
        });
      }
    }
  }
  return comparisons;
}

async function runArm(comparison, arm, config, ctx) {
  const fx = FIXTURES[comparison.fixture];
  const deterministic = arm.flavor === 'deterministic';
  const marks = {};
  const options = evaluationOptionsFor(fx, {
    deterministic,
    vehicleCount: comparison.vehicleCount,
    profile: arm.profile,
    hooks: { onPhase: (name) => { marks[name] = performance.now(); } },
    ...(arm.traceMode === 'none' ? {} : { trace: { mode: arm.traceMode, checkpointInterval: 1 } }),
  });
  // Amendment (1): the benchmark owns its terrain — principal is composite,
  // control is flat — never the golden fixture terrain.
  options.terrain = comparison.workload === 'control' ? { ...CONTROL_TERRAIN } : { ...PRINCIPAL_TERRAIN };
  if (config.stepsOverride !== null) options.maxSteps = config.stepsOverride;
  const tCall = performance.now();
  const result = await runEvaluation(options);
  const tReturn = performance.now();
  for (const p of PHASES) {
    if (typeof marks[p] !== 'number') throw new Error(`bench: phase mark ${p} missing`);
  }
  // Reached-composite tooth: only meaningful for a principal FULL run (a smoke
  // 30-step run never reaches composite by design, so it is exempt).
  let reachedComposite = null;
  if (comparison.workload === 'principal' && config.stepsOverride === null) {
    reachedComposite = result.vehicles.every((v) => {
      const finalX = v.origin.x + v.forwardDistance;
      return startEnvelope(finalX, ctx.principalEnvelope) === 1;
    });
  }
  return {
    steps: result.executedSteps,
    reachedComposite,
    phases: {
      createPhysicsMs: marks.terrain - marks.createPhysics,
      terrainMs: marks.realize - marks.terrain,
      realizationMs: marks.run - marks.realize,
      steppingMs: marks.collect - marks.run,
      collectMs: marks.done - marks.collect,
      totalMs: tReturn - tCall,
    },
    counts: result.counts,
    health: {
      nonFiniteVehicles: result.vehicles.filter((v) => !v.finite).length,
      invalidBodies: result.vehicles.filter((v) => !v.bodies.allValid).length,
      invalidJoints: result.vehicles.filter((v) => !v.joints.allValid).length,
      sleepingAtEnd: result.vehicles.reduce((n, v) => n + v.bodies.sleepingAtEnd, 0),
    },
    digest: result.trace === null ? null : result.trace.digest,
    recordCount: result.trace === null ? null : result.trace.recordCount,
    byteCount: result.trace === null ? null : result.trace.byteCount,
    engine: result.timing === null ? null : [...result.timing.stepMs],
  };
}

function aggregateArm(arm, armSamples) {
  const phaseKeys = Object.keys(armSamples[0].phases);
  const phases = {};
  for (const k of phaseKeys) phases[k] = median(armSamples.map((s) => s.phases[k]));
  const last = armSamples[armSamples.length - 1];
  const steps = last.steps;
  const out = {
    flavor: arm.flavor, profile: arm.profile, traceMode: arm.traceMode,
    phases,
    meanStepMs: phases.steppingMs / steps,
    vehicleStepsPerSec: null, // filled by caller (needs vehicleCount)
    counts: last.counts,
    health: last.health,
    digest: last.digest,
    recordCount: last.recordCount,
    byteCount: last.byteCount,
    engine: null,
  };
  if (arm.profile) {
    const pooled = armSamples.flatMap((s) => s.engine).sort((a, b) => a - b);
    out.engine = { stepMsMedian: percentile(pooled, 0.5), stepMsP90: percentile(pooled, 0.9), sampleCount: pooled.length };
  }
  return out;
}

async function runComparison(comparison, config, state, ctx) {
  // One discarded warm-up per (flavor, fixture) — absorbs the fresh-module
  // first-step wasm spike + JIT before any measured sample.
  for (const arm of [comparison.denom, comparison.numer]) {
    const warmKey = `${arm.flavor}/${comparison.fixture}`;
    if (!state.warmed.has(warmKey)) {
      const warmOptions = evaluationOptionsFor(FIXTURES[comparison.fixture], { deterministic: arm.flavor === 'deterministic' });
      warmOptions.terrain = comparison.workload === 'control' ? { ...CONTROL_TERRAIN } : { ...PRINCIPAL_TERRAIN };
      warmOptions.maxSteps = config.warmupSteps;
      await runEvaluation(warmOptions);
      state.warmed.add(warmKey);
    }
  }
  // Budget guard: extrapolate a per-sample pair cost from the last completed
  // comparison of the same (family, workload, fixture) at a lower count.
  const key = `${comparison.family}/${comparison.workload}/${comparison.fixture}`;
  const prev = state.lastCompleted.get(key);
  if (prev !== undefined && comparison.vehicleCount > prev.vehicleCount) {
    const projected = prev.perSampleMs * (comparison.vehicleCount / prev.vehicleCount) * config.samples;
    if (projected > config.rowBudgetMs) {
      return {
        ...comparison,
        status: 'omitted',
        reason: `projected ~${Math.round(projected)} ms (from the ${prev.vehicleCount}-vehicle pair × ${config.samples} samples) exceeds --row-budget ${config.rowBudgetMs} ms`,
      };
    }
  }

  const denomSamples = [];
  const numerSamples = [];
  const ratios = [];
  for (let s = 0; s < config.samples; s += 1) {
    // Alternate order each sample so first-of-pair bias cancels.
    const order = s % 2 === 0 ? ['denom', 'numer'] : ['numer', 'denom'];
    const perSample = {};
    for (const role of order) {
      perSample[role] = await runArm(comparison, comparison[role], config, ctx);
    }
    denomSamples.push(perSample.denom);
    numerSamples.push(perSample.numer);
    ratios.push(perSample.numer.phases.steppingMs / perSample.denom.phases.steppingMs);
  }

  const denom = aggregateArm(comparison.denom, denomSamples);
  const numer = aggregateArm(comparison.numer, numerSamples);
  denom.vehicleStepsPerSec = (comparison.vehicleCount * denomSamples[0].steps) / (denom.phases.steppingMs / 1000);
  numer.vehicleStepsPerSec = (comparison.vehicleCount * numerSamples[0].steps) / (numer.phases.steppingMs / 1000);

  const perSampleMs = median(denomSamples.map((d, i) => d.phases.totalMs + numerSamples[i].phases.totalMs));
  state.lastCompleted.set(key, { vehicleCount: comparison.vehicleCount, perSampleMs });

  // Amendment (1) tooth: a principal full-run row is INVALID if any arm/sample
  // did not drive onto composite terrain — never silently reported as a
  // composite cost that was actually flat-pad.
  const reachFlags = [...denomSamples, ...numerSamples].map((x) => x.reachedComposite).filter((r) => r !== null);
  const reachedComposite = reachFlags.length === 0 ? null : reachFlags.every(Boolean);
  if (reachedComposite === false) {
    return {
      ...comparison,
      status: 'invalid',
      reason: 'a vehicle never reached composite terrain (startEnvelope < 1 at run end) — the principal number would misrepresent flat-pad cost as composite',
      ratioMedian: median(ratios),
      denom, numer,
    };
  }

  return {
    ...comparison,
    status: 'ok',
    samples: config.samples,
    warmupSteps: config.warmupSteps,
    measuredSteps: denomSamples[0].steps,
    ratioMedian: median(ratios),
    ratioSamples: ratios,
    reachedComposite,
    denom,
    numer,
  };
}

function collectMeta(config, ctx) {
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
      name: f.name, version: f.version, maxSteps: f.maxSteps,
    }])),
    traceSchemaVersion: EVALUATION_TRACE_VERSION,
    principalTerrain: PRINCIPAL_TERRAIN,
    controlTerrain: CONTROL_TERRAIN,
    compositeStartX: ctx.compositeStartX,
    sampling: 'paired + interleaved (arms run back-to-back per sample, order alternated); reported ratio = median of per-pair ratios',
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
  // Composite boundary for the reached-composite tooth.
  const terrain = generateCorridorTerrain(PRINCIPAL_TERRAIN);
  const compositeStartX = -terrain.scale.x / 2 + PRINCIPAL_TERRAIN.startFlatLength + PRINCIPAL_TERRAIN.startBlendLength;
  const ctx = {
    compositeStartX,
    principalEnvelope: {
      length: terrain.scale.x,
      startFlatLength: PRINCIPAL_TERRAIN.startFlatLength,
      startBlendLength: PRINCIPAL_TERRAIN.startBlendLength,
    },
  };
  const comparisons = [];
  const state = { warmed: new Set(), lastCompleted: new Map() };
  for (const c of buildComparisons(config)) {
    try {
      comparisons.push(await runComparison(c, config, state, ctx));
    } catch (error) {
      comparisons.push({ ...c, status: 'error', error: String(error && error.message ? error.message : error) });
    }
  }
  return {
    schema: 'boxcar3d.bench-physics/2',
    meta: collectMeta(config, ctx),
    comparisons,
    derived: deriveRatios(comparisons),
  };
}

function deriveRatios(comparisons) {
  const ok = comparisons.filter((c) => c.status === 'ok');
  const pick = (family) => ok.filter((c) => c.family === family).map((c) => ({
    workload: c.workload, flavor: c.numer.flavor, fixture: c.fixture, vehicleCount: c.vehicleCount, ratio: c.ratioMedian,
  }));
  return {
    deterministicOverhead: pick('deterministicTax'),
    profilerOverhead: pick('profilerOverhead'),
    digestOverhead: ok.filter((c) => c.family === 'digestOverhead').map((c) => ({
      flavor: c.numer.flavor, fixture: c.fixture, vehicleCount: c.vehicleCount,
      noneSteppingMs: c.denom.phases.steppingMs, digestSteppingMs: c.numer.phases.steppingMs, ratio: c.ratioMedian,
    })),
  };
}

// --- Markdown report -----------------------------------------------------------

const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));
const f4 = (n) => (Number.isFinite(n) ? n.toFixed(4) : String(n));

export function renderMarkdown(report) {
  const { meta, comparisons } = report;
  const lines = [];
  lines.push('# bench:physics report');
  lines.push('');
  lines.push(`Generated ${meta.generatedUtc} on ${meta.os.platform}/${meta.os.arch} (${meta.cpu.model} ×${meta.cpu.count}), Node ${meta.node}, rapier ${meta.rapier.compat}${meta.smoke ? ' — SMOKE matrix' : ''}.`);
  lines.push(`Sampling: ${meta.sampling}; ${meta.samples} samples/comparison; warm-up ${meta.warmupSteps} steps discarded per flavor×fixture; row budget ${meta.rowBudgetMs} ms.`);
  lines.push(`Principal workload = composite corridor (seed ${meta.principalTerrain.seed}, composite start x=${meta.compositeStartX}); control = flat corridor. All wall numbers are external monotonic timing with the profiler OFF unless a table says otherwise — machine-specific, never a universal package property.`);
  lines.push('');

  const detTax = comparisons.filter((c) => c.family === 'deterministicTax');
  const canonicalTable = (workload, title, note) => {
    const subset = detTax.filter((c) => c.workload === workload);
    if (subset.length === 0) return;
    lines.push(`## ${title}`);
    if (note) { lines.push(''); lines.push(note); }
    lines.push('');
    lines.push('| Flavor | Fixture | Vehicles | Bodies/Joints | Init ms | Terrain ms | Realize ms | Step total ms | Step mean ms | Veh-steps/s | Det÷Def (paired) | Status |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of subset) {
      if (c.status !== 'ok') {
        lines.push(`| default | ${c.fixture} | ${c.vehicleCount} | — | — | — | — | — | — | — | — | ${c.status}: ${c.reason ?? c.error} |`);
        continue;
      }
      const row = (arm, ratioCell) => `| ${arm.flavor} | ${c.fixture} | ${c.vehicleCount} | ${arm.counts.bodies}/${arm.counts.joints} | ${f2(arm.phases.createPhysicsMs)} | ${f2(arm.phases.terrainMs)} | ${f2(arm.phases.realizationMs)} | ${f2(arm.phases.steppingMs)} | ${f4(arm.meanStepMs)} | ${Math.round(arm.vehicleStepsPerSec)} | ${ratioCell} | ok |`;
      lines.push(row(c.denom, ''));
      lines.push(row(c.numer, `${f2(c.ratioMedian)}×`));
    }
    lines.push('');
  };
  canonicalTable('principal', 'Canonical affordability — composite corridor (profile off, trace none)',
    'Every vehicle drives onto composite terrain (the reached-composite tooth marks any row that does not as invalid). Det÷Def is the median of per-pair ratios (default and deterministic arms run back-to-back, order alternated).');
  canonicalTable('control', 'Control — flat corridor (terrain-cost isolation; fixture C here is max topology on FLAT ground)',
    'Compare fixture C here (max topology, flat) against fixture C in the composite table above (max topology, composite) to separate structural cost from terrain cost.');

  const prof = comparisons.filter((c) => c.family === 'profilerOverhead');
  if (prof.length > 0) {
    lines.push('## Profiler diagnostic (profile ON — engine numbers are INTERNAL PROFILED STEP TIME, not wall clock)');
    lines.push('');
    lines.push('| Flavor | Fixture | Vehicles | Engine step med ms | Engine step p90 ms | Ext step (off) ms | Ext step (on) ms | ProfOn÷Off (paired) | Status |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const c of prof) {
      if (c.status !== 'ok') {
        lines.push(`| ${c.numer.flavor} | ${c.fixture} | ${c.vehicleCount} | — | — | — | — | — | ${c.status}: ${c.reason ?? c.error} |`);
        continue;
      }
      lines.push(`| ${c.numer.flavor} | ${c.fixture} | ${c.vehicleCount} | ${f4(c.numer.engine.stepMsMedian)} | ${f4(c.numer.engine.stepMsP90)} | ${f2(c.denom.phases.steppingMs)} | ${f2(c.numer.phases.steppingMs)} | ${f2(c.ratioMedian)}× | ok |`);
    }
    lines.push('');
  }

  const digest = comparisons.filter((c) => c.family === 'digestOverhead');
  if (digest.length > 0) {
    lines.push('## Trace-instrument overhead (profile off; none vs digest, paired)');
    lines.push('');
    lines.push('| Flavor | Fixture | Vehicles | none step ms | digest step ms | Digest÷None (paired) | Status |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const c of digest) {
      if (c.status !== 'ok') {
        lines.push(`| ${c.numer.flavor} | ${c.fixture} | ${c.vehicleCount} | — | — | — | ${c.status}: ${c.reason ?? c.error} |`);
        continue;
      }
      lines.push(`| ${c.numer.flavor} | ${c.fixture} | ${c.vehicleCount} | ${f2(c.denom.phases.steppingMs)} | ${f2(c.numer.phases.steppingMs)} | ${f2(c.ratioMedian)}× | ok |`);
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
  // Fail loud on a typo'd filter rather than emitting a silently empty report.
  if (config.flavorFilter !== null && !FLAVOR_NAMES.includes(config.flavorFilter)) {
    throw new Error(`bench: invalid --flavor ${config.flavorFilter} (expected ${FLAVOR_NAMES.join(' | ')})`);
  }
  if (config.fixtureFilter !== null && !Object.prototype.hasOwnProperty.call(FIXTURES, config.fixtureFilter)) {
    throw new Error(`bench: invalid --fixture ${config.fixtureFilter} (expected ${Object.keys(FIXTURES).join(' | ')})`);
  }
  const report = await runBenchmark(config);
  if (report.comparisons.length === 0) throw new Error('bench: matrix is empty — no comparisons to run (deterministicTax needs both flavors)');
  console.log(renderMarkdown(report));
  if (values.json !== undefined) {
    writeFileSync(values.json, JSON.stringify(report, null, 2));
    console.log(`\nJSON written to ${values.json}`);
  }
}

// Run the CLI only when invoked directly. Guard process.argv[1] — it is
// undefined under `node -e` / a bare REPL import, where pathToFileURL(undefined)
// would throw at import time and make the module's exports unusable (the
// bench-schema test imports this module).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
