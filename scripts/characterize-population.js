// GA Phase 1A population characterization — a learning INSTRUMENT, never a CI
// gate. Outside the src/sim ESLint ban, so Date/performance/Math.* are legal.
// Nothing here feeds population generation, simulation, fitness, or the locks:
// wall-clock timing is human-facing only.
//
// Passes (each independently selectable so a light local run is cheap):
//   distribution — PURE (no physics): topology/gene/repair/collapse stats
//                  over N forks of a master seed. Seconds even at N=2000.
//   viability    — per-individual physics on a fixed composite terrain across
//                  a few master seeds (isolatedWorlds — one world at a time).
//   undriven     — clones the champions with drive zeroed and re-evaluates
//                  (passive-motion audit; diagnostic only, never subtracted).
//   cost         — wall-clock ms/step vs population size (machine-specific).
//   recheck      — the shared-world invariance RECHECK probe (deliberate
//                  re-run on an engine/architecture change; see the
//                  isolatedWorlds ruling in population-evaluation.js).
//
// USAGE (defaults are SMALL so a local run stays light — the machine this was
// authored on nearly stalled under heavy stacked runs; the big offline sweep
// is a documented opt-in, not the default):
//   node scripts/characterize-population.js --smoke        # tiny, all passes
//   node scripts/characterize-population.js                # default light run
//   node scripts/characterize-population.js --pass distribution --n 2000
//   node scripts/characterize-population.js --pass viability --seeds 20260725,20260728,20260729
//   node scripts/characterize-population.js --json report.json
// Passes: comma list of distribution,viability,undriven,cost,recheck (or all).

/* eslint no-console: 0 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { Rng } from '../src/sim/prng.js';
import {
  INITIAL_POPULATION_DEFAULTS, createInitialPopulation, sampleInitialGenotype,
} from '../src/sim/population-initializer.js';
import { serializeGenotype, compileAssembly, repairGenotype } from '../src/sim/assembly.js';
import {
  evaluatePopulation, championFromEvaluation, spawnPoseOnFlatStart, fitnessFromVehicleResult,
} from '../src/sim/population-evaluation.js';
import { runEvaluation } from '../src/sim/evaluation.js';

const DISTRIBUTION_MASTER = 20260725;
const VIABILITY_SEEDS = [20260725, 20260728, 20260729];
const VIABILITY_TERRAIN = Object.freeze({
  seed: 20260727,
  startFlatLength: 30,
  startBlendLength: 6,
});
const VIABILITY_SPEC = Object.freeze({
  terrain: VIABILITY_TERRAIN,
  maxSteps: 300,
  deterministic: true,
  spawn: { x: -44, z: 0 },
  targetWheelSurfaceSpeed: 5,
});

function smokeConfig() {
  return {
    passes: ['distribution', 'viability', 'undriven', 'cost', 'recheck'],
    n: 64,
    viabilitySeeds: [20260725],
    viabilitySize: 6,
    costSizes: [3, 6],
    argv: [],
  };
}

function defaultConfig() {
  return {
    passes: ['distribution', 'viability', 'undriven', 'cost'],
    n: 400,
    viabilitySeeds: [20260725, 20260728],
    viabilitySize: 20,
    costSizes: [5, 10, 20],
    argv: [],
  };
}

// Genotypes are plain JSON-safe data — a round-trip deep-clone avoids a
// structuredClone global the lint config does not define.
const deepClone = (o) => JSON.parse(JSON.stringify(o));
const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const quantile = (sorted, q) => {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const countBy = (arr, keyFn) => {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
};

// --- Pass: pure distributions ------------------------------------------------

function distributionPass(n) {
  const root = new Rng(DISTRIBUTION_MASTER);
  const cfg = { ...INITIAL_POPULATION_DEFAULTS };
  const rows = [];
  const rawEncodings = new Set();
  const canonicalEncodings = new Map(); // hex -> multiplicity
  let repaired = 0;
  let recompileStable = 0;
  let s2 = 0;
  let noDriven = 0;
  for (let id = 0; id < n; id += 1) {
    const raw = sampleInitialGenotype(root.fork(id), cfg);
    const ir = compileAssembly(raw);
    const canon = ir.genotype;
    const rawHex = bytesToHex(serializeGenotype(raw));
    const canonHex = bytesToHex(serializeGenotype(canon));
    rawEncodings.add(rawHex);
    canonicalEncodings.set(canonHex, (canonicalEncodings.get(canonHex) ?? 0) + 1);
    if (rawHex !== canonHex) repaired += 1;
    if (bytesToHex(serializeGenotype(repairGenotype(canon))) === canonHex) recompileStable += 1;
    const wheels = ir.axles.flatMap((a) => a.wheels);
    if (ir.axles.some((a) => a.suspension.type === 'S2')) s2 += 1;
    if (ir.power.drivenWheelCount === 0) noDriven += 1;
    rows.push({
      axles: canon.axles.length,
      wheels: wheels.length,
      drivenWheels: ir.power.drivenWheelCount,
      family: ir.chassis.family,
      symmetric: canon.symmetric >= 0.5,
      s0Modules: ir.axles.filter((a) => a.suspension.type === 'S0').length,
      s1Modules: ir.axles.filter((a) => a.suspension.type === 'S1').length,
      power: ir.power.budget,
      mass: ir.mass.total,
      stations: ir.axles.flatMap((a) => a.wheels).length,
      maxRadius: Math.max(...wheels.map((w) => w.radius)),
    });
  }
  const masses = rows.map((r) => r.mass).sort((a, b) => a - b);
  const powers = rows.map((r) => r.power).sort((a, b) => a - b);
  const radii = rows.map((r) => r.maxRadius).sort((a, b) => a - b);
  const maxMultiplicity = Math.max(...canonicalEncodings.values());
  return {
    n,
    master: DISTRIBUTION_MASTER,
    axleCounts: countBy(rows, (r) => r.axles),
    wheelCounts: countBy(rows, (r) => r.wheels),
    drivenWheelCounts: countBy(rows, (r) => r.drivenWheels),
    families: countBy(rows, (r) => r.family),
    symmetric: countBy(rows, (r) => (r.symmetric ? 'symmetric' : 'asymmetric')),
    moduleMix: { s0: rows.reduce((s, r) => s + r.s0Modules, 0), s1: rows.reduce((s, r) => s + r.s1Modules, 0) },
    stationCounts: countBy(rows, (r) => r.stations),
    power: { min: powers[0], median: quantile(powers, 0.5), max: powers[powers.length - 1] },
    mass: { min: masses[0], median: quantile(masses, 0.5), max: masses[masses.length - 1] },
    maxRadius: { min: radii[0], median: quantile(radii, 0.5), max: radii[radii.length - 1] },
    repairFraction: repaired / n,
    recompileStable,
    uniqueRaw: rawEncodings.size,
    uniqueCanonical: canonicalEncodings.size,
    collapseRate: (rawEncodings.size - canonicalEncodings.size) / rawEncodings.size,
    maxCanonicalMultiplicity: maxMultiplicity,
    s2Frequency: s2,
    noDrivenFrequency: noDriven,
  };
}

// --- Pass: physical viability ------------------------------------------------

async function viabilityPass(seeds, size) {
  const out = [];
  for (const seed of seeds) {
    const { population } = createInitialPopulation({ seed, populationSize: size });
    const ev = await evaluatePopulation(population, { ...VIABILITY_SPEC });
    const champion = championFromEvaluation(ev);
    const fitnesses = ev.individuals.map((i) => i.fitness).sort((a, b) => a - b);
    const rollbacks = ev.individuals.map((i) => i.diagnostics.maxForwardDistance - i.diagnostics.forwardDistance);
    const validCount = ev.individuals.filter((i) => i.valid).length;
    const level = (t) => ev.individuals.filter((i) => i.fitness >= t).length;
    const maxBeforeFinal = ev.individuals.filter((i) => i.diagnostics.stepAtMaxForwardDistance < VIABILITY_SPEC.maxSteps).length;
    out.push({
      seed,
      size,
      valid: validCount,
      zeroFitness: ev.individuals.filter((i) => i.fitness < 0.01).length,
      atLeast1m: level(1),
      atLeast5m: level(5),
      atLeast10m: level(10),
      fitnessQuartiles: [quantile(fitnesses, 0.25), quantile(fitnesses, 0.5), quantile(fitnesses, 0.75)],
      fitnessMax: fitnesses[fitnesses.length - 1],
      rollbackMax: Math.max(...rollbacks),
      maxBeforeFinal,
      champion: championMorphology(population, champion),
    });
  }
  return out;
}

function championMorphology(population, champion) {
  const g = population.individuals.find((i) => i.individualId === champion.individualId).genotype;
  const ir = compileAssembly(g);
  return {
    individualId: champion.individualId,
    fitness: champion.fitness,
    axles: g.axles.length,
    wheels: ir.axles.flatMap((a) => a.wheels).length,
    drivenWheels: ir.power.drivenWheelCount,
    family: ir.chassis.family,
    symmetric: g.symmetric >= 0.5,
    suspension: ir.axles.map((a) => a.suspension.type).join('/'),
    power: ir.power.budget,
    mass: ir.mass.total,
  };
}

// --- Pass: undriven audit ----------------------------------------------------

async function undrivenPass(seeds, size) {
  const out = [];
  for (const seed of seeds) {
    const { population } = createInitialPopulation({ seed, populationSize: size });
    const ev = await evaluatePopulation(population, { ...VIABILITY_SPEC });
    const champion = championFromEvaluation(ev);
    const g = population.individuals.find((i) => i.individualId === champion.individualId).genotype;
    // Zero every drive gene -> a canonical zero-drive twin (repair never
    // reads driven, so it stays canonical). driveTorque collapses to 0.
    const passive = repairGenotype({ ...deepClone(g), axles: g.axles.map((a) => ({ ...deepClone(a), driven: 0 })) });
    const ir = compileAssembly(passive);
    const r = await runEvaluation({
      deterministic: true,
      terrain: { ...VIABILITY_SPEC.terrain },
      vehicles: [{ ir, spawn: spawnPoseOnFlatStart(ir, VIABILITY_SPEC.spawn), targetWheelSurfaceSpeed: 5, wheelFriction: 1 }],
      maxSteps: VIABILITY_SPEC.maxSteps,
      trace: { mode: 'none' },
    });
    out.push({
      seed,
      championId: champion.individualId,
      drivenFitness: champion.fitness,
      passiveMaxForward: fitnessFromVehicleResult(r.vehicles[0]),
      passiveFinal: r.vehicles[0].forwardDistance,
    });
  }
  return out;
}

// --- Pass: cohort cost (machine-specific) ------------------------------------

async function costPass(sizes) {
  const out = [];
  for (const size of sizes) {
    const { population } = createInitialPopulation({ seed: DISTRIBUTION_MASTER, populationSize: size });
    const t0 = performance.now();
    await evaluatePopulation(population, { ...VIABILITY_SPEC });
    const elapsed = performance.now() - t0;
    out.push({ size, totalMs: elapsed, msPerStep: elapsed / VIABILITY_SPEC.maxSteps, msPerIndividual: elapsed / size });
  }
  return out;
}

// --- Pass: shared-world invariance recheck (deliberate opt-in) ---------------

async function recheckPass() {
  // Two members whose shared-world coexistence the isolatedWorlds ruling was
  // built on: a wheeled S0 vehicle and a zero-axle sled. Compare each SOLO vs
  // beside the other in ONE shared world (full trace, vehicleIndex
  // normalized). A future engine that makes these bit-identical is the signal
  // to reconsider shared-world execution.
  const { compareTraces, EVALUATION_TRACE_VERSION, RECORD_BYTES } = await import('../src/sim/trace.js');
  const { population } = createInitialPopulation({ seed: DISTRIBUTION_MASTER, populationSize: 20 });
  // Pick a wheeled individual and a (synthetic) sled shape.
  const wheeled = compileAssembly(population.individuals[0].genotype);
  const sledGenotype = { ...deepClone(population.individuals[0].genotype), axles: [] };
  const sled = compileAssembly(sledGenotype);
  const terrain = Object.freeze({
    seed: 20260723, startFlatLength: 80, startBlendLength: 6,
    craterDensity: 0, featureDensity: 0, sandCoverage: 0, mudCoverage: 0,
  });
  const veh = (ir) => ({ ir, spawn: spawnPoseOnFlatStart(ir, { x: -45, z: 0 }), targetWheelSurfaceSpeed: 5, wheelFriction: 1 });
  const run = async (vehicles) => runEvaluation({ deterministic: true, terrain: { ...terrain }, vehicles, maxSteps: 200, trace: { mode: 'full' } });
  const slice = (r, vi) => {
    const records = [];
    for (const b of r.trace.records) {
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (view.getUint32(4, true) !== vi) continue;
      const copy = b.slice();
      new DataView(copy.buffer).setUint32(4, 0, true);
      records.push(copy);
    }
    return records;
  };
  const solo = await run([veh(sled)]);
  const dual = await run([veh(sled), veh(wheeled)]);
  const div = compareTraces(
    { version: EVALUATION_TRACE_VERSION, recordBytes: RECORD_BYTES, records: slice(solo, 0) },
    { version: EVALUATION_TRACE_VERSION, recordBytes: RECORD_BYTES, records: slice(dual, 0) },
  );
  return {
    sharedWorldInvariant: div === null,
    firstDivergence: div === null ? null : { step: div.identity?.stepIndex, field: div.field },
    note: div === null
      ? 'Shared-world invariance now HOLDS for this pair — reconsider shared-world execution deliberately.'
      : 'Shared-world still diverges (the isolatedWorlds ruling stands).',
  };
}

// --- Rendering ---------------------------------------------------------------

function renderMarkdown(report) {
  const L = [];
  const table = (headers, rows) => {
    L.push(`| ${headers.join(' | ')} |`);
    L.push(`| ${headers.map(() => '---').join(' | ')} |`);
    for (const r of rows) L.push(`| ${r.join(' | ')} |`);
    L.push('');
  };
  L.push('# GA Phase 1A population characterization', '');
  L.push(`Command: \`node scripts/characterize-population.js ${report.argv.join(' ')}\``);
  L.push(`Generated by an offline instrument — NOT a CI gate, NOT a package property.`, '');

  if (report.distribution) {
    const d = report.distribution;
    L.push(`## Distributions (pure, N=${d.n}, master seed ${d.master})`, '');
    table(['axles', 'count'], d.axleCounts);
    table(['wheels', 'count'], d.wheelCounts);
    table(['driven wheels', 'count'], d.drivenWheelCounts);
    table(['frame family', 'count'], d.families);
    table(['symmetry', 'count'], d.symmetric);
    L.push(`Suspension modules: S0 ${d.moduleMix.s0}, S1 ${d.moduleMix.s1}. S2 frequency: **${d.s2Frequency}** (must be 0). Undriven individuals: **${d.noDrivenFrequency}** (must be 0).`, '');
    L.push(`Power [${d.power.min.toFixed(1)}, ${d.power.max.toFixed(1)}] median ${d.power.median.toFixed(1)} N·m; mass [${d.mass.min.toFixed(1)}, ${d.mass.max.toFixed(1)}] median ${d.mass.median.toFixed(1)} kg; max wheel radius [${d.maxRadius.min.toFixed(3)}, ${d.maxRadius.max.toFixed(3)}] m.`, '');
    L.push(`**Repair:** ${(d.repairFraction * 100).toFixed(1)}% of raw draws changed; recompile-stable ${d.recompileStable}/${d.n}.`);
    L.push(`**Collapse:** ${d.uniqueRaw} unique raw encodings -> ${d.uniqueCanonical} unique canonical (collapse rate ${(d.collapseRate * 100).toFixed(2)}%, max canonical multiplicity ${d.maxCanonicalMultiplicity}).`, '');
  }

  if (report.viability) {
    L.push('## Physical viability (isolatedWorlds, composite terrain seed 20260727)', '');
    table(
      ['seed', 'size', 'valid', 'zero-fit', '>=1m', '>=5m', '>=10m', 'Q1/Q2/Q3 max-fwd', 'max', 'rollback-max', 'max<final#'],
      report.viability.map((v) => [
        v.seed, v.size, v.valid, v.zeroFitness, v.atLeast1m, v.atLeast5m, v.atLeast10m,
        v.fitnessQuartiles.map((q) => q.toFixed(2)).join('/'), v.fitnessMax.toFixed(2),
        v.rollbackMax.toFixed(3), v.maxBeforeFinal,
      ]),
    );
    L.push('Champion morphologies:', '');
    table(
      ['seed', 'id', 'fitness', 'axles', 'wheels', 'driven', 'family', 'sym', 'suspension', 'power', 'mass'],
      report.viability.map((v) => {
        const c = v.champion;
        return [v.seed, c.individualId, c.fitness.toFixed(2), c.axles, c.wheels, c.drivenWheels, c.family, c.symmetric, c.suspension, c.power.toFixed(0), c.mass.toFixed(0)];
      }),
    );
  }

  if (report.undriven) {
    L.push('## Undriven audit (champions, drive genes zeroed — diagnostic only, never subtracted)', '');
    table(
      ['seed', 'champ id', 'driven fitness', 'passive max-fwd', 'passive final'],
      report.undriven.map((u) => [u.seed, u.championId, u.drivenFitness.toFixed(3), u.passiveMaxForward.toFixed(3), u.passiveFinal.toFixed(3)]),
    );
  }

  if (report.cost) {
    L.push('## Cohort cost (WALL-CLOCK, machine-specific — never a package property)', '');
    table(
      ['population size', 'total ms', 'ms/step', 'ms/individual'],
      report.cost.map((c) => [c.size, c.totalMs.toFixed(1), c.msPerStep.toFixed(3), c.msPerIndividual.toFixed(1)]),
    );
  }

  if (report.recheck) {
    L.push('## Shared-world invariance recheck', '');
    L.push(`sharedWorldInvariant: **${report.recheck.sharedWorldInvariant}** — ${report.recheck.note}`);
    if (report.recheck.firstDivergence) L.push(`First divergence: step ${report.recheck.firstDivergence.step}, field ${report.recheck.firstDivergence.field}.`);
    L.push('');
  }
  return L.join('\n');
}

export async function runCharacterization(config) {
  const report = { schema: 'boxcar3d.characterize-population/1', argv: config.argv };
  if (config.passes.includes('distribution')) report.distribution = distributionPass(config.n);
  if (config.passes.includes('viability')) report.viability = await viabilityPass(config.viabilitySeeds, config.viabilitySize);
  if (config.passes.includes('undriven')) report.undriven = await undrivenPass(config.viabilitySeeds, config.viabilitySize);
  if (config.passes.includes('cost')) report.cost = await costPass(config.costSizes);
  if (config.passes.includes('recheck')) report.recheck = await recheckPass();
  return report;
}

export { smokeConfig, defaultConfig, renderMarkdown, quantile };

async function main() {
  const { values } = parseArgs({
    options: {
      smoke: { type: 'boolean', default: false },
      pass: { type: 'string' },
      n: { type: 'string' },
      seeds: { type: 'string' },
      size: { type: 'string' },
      json: { type: 'string' },
    },
  });
  const config = values.smoke ? smokeConfig() : defaultConfig();
  if (values.pass !== undefined) {
    const passes = values.pass === 'all'
      ? ['distribution', 'viability', 'undriven', 'cost', 'recheck']
      : values.pass.split(',').map((p) => p.trim());
    const known = ['distribution', 'viability', 'undriven', 'cost', 'recheck'];
    for (const p of passes) if (!known.includes(p)) throw new Error(`characterize-population: unknown pass '${p}' (expected ${known.join(', ')})`);
    config.passes = passes;
  }
  if (values.n !== undefined) {
    config.n = Number(values.n);
    if (!Number.isInteger(config.n) || config.n < 1) throw new Error(`characterize-population: invalid --n ${values.n}`);
  }
  if (values.seeds !== undefined) {
    config.viabilitySeeds = values.seeds.split(',').map((s) => Number(s.trim()));
    if (config.viabilitySeeds.some((s) => !Number.isInteger(s) || s < 0)) throw new Error(`characterize-population: invalid --seeds ${values.seeds}`);
  }
  if (values.size !== undefined) {
    config.viabilitySize = Number(values.size);
    if (!Number.isInteger(config.viabilitySize) || config.viabilitySize < 1) throw new Error(`characterize-population: invalid --size ${values.size}`);
  }
  config.argv = process.argv.slice(2);
  const report = await runCharacterization(config);
  console.log(renderMarkdown(report));
  if (values.json !== undefined) {
    writeFileSync(values.json, JSON.stringify(report, null, 2));
    console.log(`\nJSON written to ${values.json}`);
  }
}

// Run the CLI only when invoked directly (the schema test imports this
// module; pathToFileURL(undefined) under bare imports would throw).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}

export { VIABILITY_SEEDS };
