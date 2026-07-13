// Finite-explosion investigation probe — a reproducible INSTRUMENT, never a
// CI gate (the characterize-population class: outside the src/sim ESLint
// ban; its only CI touchpoint is the schema smoke in
// tests/physics-explosion-probe-schema.test.js).
//
// Stage 1 (this file): every run goes through the UNCHANGED canonical runner
// (`runEvaluation`) with full traces analyzed offline by
// src/sim/trace-forensics.js — the investigation plan's Tier-1 evidence
// base. Passes:
//   baseline — reproduce each witness (driven + canonical passive twin),
//              deterministic x2 byte-repeatability (HARD check), ordinary-
//              flavor observations (F10: never a contract), onset forensics
//              + the x0.5/x2 threshold-sensitivity sweep, and the declared
//              ordinary-control procedure (min/median/max fitness of
//              population 20260725 EXCLUDING witness ids, driven + passive)
//              that calibrates the diagnostic thresholds.
//   terrain  — the coarse config-expressible ablation matrix per witness
//              (full / noFeatures / noCraters / roughnessOnly / flat),
//              driven + passive. `roughnessOnly` covers BOTH of the
//              mission's "neither craters nor features" and "ordinary
//              roughness" variants — they coincide in this codebase because
//              zones are inert data in v1. `flat` additionally zeroes both
//              fBm amplitudes (deliberately NOT a startFlatLength extension,
//              which would move the start envelope and walls).
//   vehicle  — genotype-level (ECOLOGICAL) arms per witness on the full
//              witness terrain: passive twin, the LEGAL zero-drive analogue
//              power->0 (a zero targetWheelSurfaceSpeed with driven wheels
//              is rejected pre-world by ruling), power scaling, mass-ratio
//              arms (frameDensity->1, wheel densities->0 — repair re-clamps
//              into band, moving the unsprung:chassis RATIO the individual
//              bands never bound), per-axle removal, S1->S0 conversion
//              (per-module + all — NOTE the recorded confound: conversion
//              removes hub bodies + the prismatic DOF and changes mass),
//              single-module reductions, the chassis-only sled, and
//              wheelFriction option variants. Genotype arms are re-repaired
//              (canonical by construction) and each arm records its own
//              genotype digest. These arms answer "does the repaired vehicle
//              WITHOUT X explode?" — exact-component necessity needs the
//              Stage-2 phenotype-preserving ablations.
//   engine / local — RESERVED: they land with the Tier-2 stage (shared
//              evaluation-loop seam + contact telemetry) once the decision
//              record shows trace-only analysis cannot answer the remaining
//              questions.
//
// Check tiers (the probe-rapier-timing convention): HARD checks (exit 1) are
// IDENTITY-class only — witness genotype digests, deterministic same-config
// byte-repeatability, the baseline f32 dt readback. Every physics magnitude
// and onset is an OBSERVATION: pre-correction values must never become
// must-still-explode gates, so the probe survives a landed correction
// unchanged.
//
// USAGE (defaults are SMALL — witness A only; the full matrix is opt-in):
//   node scripts/probe-physics-explosion.js --smoke
//   node scripts/probe-physics-explosion.js
//   node scripts/probe-physics-explosion.js --witness all --pass all
//   node scripts/probe-physics-explosion.js --witness 20260725:19 --pass baseline,terrain
//   node scripts/probe-physics-explosion.js --json physics-explosion.json
//
// Witness selector: 'all', labels ('A,B'), or 'seed:id' pairs. Passes:
// comma list of baseline,terrain,vehicle (or 'all').

/* eslint no-console: 0 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { runEvaluation } from '../src/sim/evaluation.js';
import { createPhysics, FIXED_DT } from '../src/sim/physics/adapter.js';
import {
  evaluatePopulation, isVehicleResultValid, spawnPoseOnFlatStart,
} from '../src/sim/population-evaluation.js';
import { createInitialPopulation } from '../src/sim/population-initializer.js';
import { compileAssembly, repairGenotype, serializeGenotype } from '../src/sim/assembly.js';
import { fnv1aHex } from '../src/sim/fnv1a.js';
import {
  analyzeTrace, bodyReachMetadataForIR, scaledThresholds,
} from '../src/sim/trace-forensics.js';
import {
  EXPLOSION_WITNESSES, WITNESS_SPEC, WITNESS_TERRAIN,
  passiveTwinOf, witnessDigest, witnessGenotype,
} from './explosion-witnesses.js';

export const PROBE_SCHEMA = 'boxcar3d.physics-explosion/1';

// The declared control procedure: population seed 20260725 (a Phase-1A
// characterization master), min/median/max fitness EXCLUDING the two witness
// ids that live in it (A id 19, S id 14) — a procedure, not magic ids, so it
// reproduces from the seed alone.
const CONTROL_POPULATION_SEED = 20260725;
const CONTROL_EXCLUDED_IDS = Object.freeze([19, 14]);

const TERRAIN_VARIANTS = Object.freeze({
  full: Object.freeze({}),
  noFeatures: Object.freeze({ featureDensity: 0 }),
  noCraters: Object.freeze({ craterDensity: 0 }),
  roughnessOnly: Object.freeze({ craterDensity: 0, featureDensity: 0 }),
  flat: Object.freeze({
    craterDensity: 0, featureDensity: 0, macroAmp: 0, microAmp: 0,
  }),
});

const IMPLEMENTED_PASSES = Object.freeze(['baseline', 'terrain', 'vehicle']);
const RESERVED_PASSES = Object.freeze(['engine', 'local']);

export function smokeConfig() {
  return {
    passes: ['baseline', 'terrain', 'vehicle'],
    witnesses: ['A'],
    ordinaryFlavor: false,
    controls: false,
    terrainVariants: ['full', 'flat'],
    vehicleArms: ['passive', 'powerZero', 'sled'],
    argv: [],
  };
}

export function defaultConfig() {
  return {
    passes: ['baseline', 'terrain', 'vehicle'],
    witnesses: ['A'],
    ordinaryFlavor: true,
    controls: true,
    terrainVariants: Object.keys(TERRAIN_VARIANTS),
    vehicleArms: null, // null = every arm
    argv: [],
  };
}

const deepClone = (o) => JSON.parse(JSON.stringify(o));
const speed = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
const exp3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? x.toExponential(3) : String(x));

function selectWitnesses(selector) {
  if (selector === undefined || selector === null) return [...EXPLOSION_WITNESSES];
  const list = Array.isArray(selector) ? selector : String(selector).split(',');
  if (list.length === 1 && list[0] === 'all') return [...EXPLOSION_WITNESSES];
  return list.map((entry) => {
    const byLabel = EXPLOSION_WITNESSES.find((w) => w.label === entry.toUpperCase());
    if (byLabel !== undefined) return byLabel;
    const m = /^(\d+):(\d+)$/.exec(entry);
    if (m !== null) {
      const found = EXPLOSION_WITNESSES.find(
        (w) => w.populationSeed === Number(m[1]) && w.individualId === Number(m[2]),
      );
      if (found !== undefined) return found;
    }
    throw new Error(`probe-physics-explosion: unknown witness selector '${entry}' `
      + `(labels ${EXPLOSION_WITNESSES.map((w) => w.label).join('/')}, or seed:id)`);
  });
}

function selectPasses(selector) {
  const list = selector === 'all' ? [...IMPLEMENTED_PASSES] : String(selector).split(',');
  for (const p of list) {
    if (RESERVED_PASSES.includes(p)) {
      throw new Error(`probe-physics-explosion: pass '${p}' lands with the Tier-2 investigation `
        + 'stage (shared evaluation-loop seam + contact telemetry) — see the module header');
    }
    if (!IMPLEMENTED_PASSES.includes(p)) {
      throw new Error(`probe-physics-explosion: unknown pass '${p}' (${IMPLEMENTED_PASSES.join('/')} or all)`);
    }
  }
  return list;
}

/** One canonical-runner evaluation of a compiled IR under the witness spec. */
async function evaluateIR(ir, {
  terrainOverrides = {}, deterministic = true,
  targetWheelSurfaceSpeed = WITNESS_SPEC.targetWheelSurfaceSpeed,
  wheelFriction = WITNESS_SPEC.wheelFriction,
  traceMode = 'full',
} = {}) {
  const spawn = spawnPoseOnFlatStart(ir, { ...WITNESS_SPEC.spawn });
  return runEvaluation({
    deterministic,
    terrain: { ...WITNESS_TERRAIN, ...terrainOverrides },
    vehicles: [{ ir, spawn, targetWheelSurfaceSpeed, wheelFriction }],
    maxSteps: WITNESS_SPEC.maxSteps,
    termination: 'maxSteps',
    trace: traceMode === 'none' ? { mode: 'none' } : { mode: traceMode, checkpointInterval: 1 },
  });
}

/** Result + forensics summary for one full-trace run. */
function summarize(r, ir) {
  const v = r.vehicles[0];
  const row = {
    valid: isVehicleResultValid(v),
    finite: v.finite,
    maxForwardDistance: v.maxForwardDistance,
    stepAtMaxForwardDistance: v.stepAtMaxForwardDistance,
    finalDistance: v.forwardDistance,
    maxBackwardDistance: v.maxBackwardDistance,
    finalSpeed: speed(v.finalVelocity.linvel),
    finalVelocityX: v.finalVelocity.linvel.x,
    peakChassisSpeed: null,
    peakBodySpeed: null,
    onset: null,
    traceDigest: r.trace === null ? null : r.trace.digest,
  };
  if (r.trace !== null && r.trace.mode === 'full') {
    const a = analyzeTrace(r.trace, { bodies: bodyReachMetadataForIR(ir) });
    const chassis = a.perBody.find((b) => b.bodyRole === 'chassis');
    row.peakChassisSpeed = chassis.peakSpeed.value;
    row.peakBodySpeed = Math.max(...a.perBody.map((b) => b.peakSpeed.value));
    row.onset = a.onset;
  }
  return row;
}

/** Alert-step spread across x0.5/x1/x2 thresholds — the sharpness signal. */
function alertSensitivity(trace, ir) {
  const bodies = bodyReachMetadataForIR(ir);
  const at = (factor) => analyzeTrace(trace, {
    bodies, thresholds: scaledThresholds(factor),
  }).onset.firstAlertStep;
  const half = at(0.5);
  const base = at(1);
  const double = at(2);
  const steps = [half, base, double].filter((s) => s !== null);
  return {
    alertAtHalf: half,
    alertAtDefault: base,
    alertAtDouble: double,
    spread: steps.length === 3 ? Math.max(...steps) - Math.min(...steps) : null,
  };
}

// --- Vehicle-pass genotype arms (ecological: edit -> repair -> compile) ------

function vehicleArmsFor(genotype) {
  const baseIr = compileAssembly(genotype);
  const arms = [];
  const gene = (name, changedVariable, edited) => {
    arms.push({
      name, changedVariable, genotype: repairGenotype(edited), wheelFriction: undefined,
    });
  };
  gene('passive', 'every axle driven gene -> 0', passiveTwinOf(genotype));
  gene('powerZero', 'power gene -> 0 (legal zero-drive analogue)', { ...deepClone(genotype), power: 0 });
  for (const f of [0.5, 0.25, 0.1]) {
    gene(`powerX${f}`, `power gene x${f}`, { ...deepClone(genotype), power: genotype.power * f });
  }
  gene('chassisDensityMax', 'frameDensity gene -> 1 (mass-ratio arm)', { ...deepClone(genotype), frameDensity: 1 });
  gene('wheelDensityMin', 'every axle density gene -> 0 (mass-ratio arm; R3 re-clamps to band floor)', {
    ...deepClone(genotype),
    axles: genotype.axles.map((a) => ({ ...deepClone(a), density: 0 })),
  });
  genotype.axles.forEach((_, i) => {
    gene(`axleRemoval:${i}`, `axle ${i} removed (ecological — R5 may re-space survivors)`, {
      ...deepClone(genotype),
      axles: genotype.axles.filter((__, j) => j !== i),
    });
  });
  baseIr.axles.forEach((axle, i) => {
    if (axle.suspension.type !== 'S1') return;
    gene(`s1ToS0:${i}`, `axle ${i} suspType gene -> 0 (S1->S0; removes hub+prismatic AND their mass — confound recorded)`, {
      ...deepClone(genotype),
      axles: genotype.axles.map((a, j) => (j === i ? { ...deepClone(a), suspType: 0 } : deepClone(a))),
    });
  });
  if (baseIr.axles.some((a) => a.suspension.type === 'S1')) {
    gene('s1ToS0:all', 'every suspType gene -> 0 (all-S0 twin; hub mass removed — confound recorded)', {
      ...deepClone(genotype),
      axles: genotype.axles.map((a) => ({ ...deepClone(a), suspType: 0 })),
    });
  }
  genotype.axles.forEach((_, i) => {
    gene(`singleModule:${i}`, `only axle ${i} retained`, {
      ...deepClone(genotype),
      axles: [deepClone(genotype.axles[i])],
    });
  });
  gene('sled', 'all axles removed (chassis-only)', { ...deepClone(genotype), axles: [] });
  for (const wf of [0, 0.5, 2]) {
    arms.push({
      name: `wheelFriction:${wf}`,
      changedVariable: `wheelFriction option ${wf} (genotype unchanged)`,
      genotype: deepClone(genotype),
      wheelFriction: wf,
    });
  }
  return arms;
}

// --- Passes -------------------------------------------------------------------

async function baselinePass(witnessSet, cfg, report, check) {
  const rows = [];
  for (const w of witnessSet) {
    // witnessGenotype hard-throws on identity drift; record the check.
    const genotype = witnessGenotype(w.populationSeed, w.individualId);
    check(`identity:${w.label}`, witnessDigest(genotype) === w.genotypeDigest,
      `expected ${w.genotypeDigest}`);
    for (const passive of [false, true]) {
      const g = passive ? passiveTwinOf(genotype) : genotype;
      if (passive) {
        check(`identity:${w.label}:passive`, witnessDigest(g) === w.passiveGenotypeDigest,
          `expected ${w.passiveGenotypeDigest}`);
      }
      const ir = compileAssembly(g);
      const r1 = await evaluateIR(ir);
      const r2 = await evaluateIR(ir);
      check(`repeat:${w.label}:${passive ? 'passive' : 'driven'}`,
        r1.trace.digest === r2.trace.digest && r1.trace.recordCount === r2.trace.recordCount,
        `digests ${r1.trace.digest}/${r2.trace.digest}`);
      check(`dt:${w.label}:${passive ? 'passive' : 'driven'}`,
        r1.effectiveDt === Math.fround(FIXED_DT), `effectiveDt ${r1.effectiveDt}`);
      if (report.engine.effectiveDt === null) report.engine.effectiveDt = r1.effectiveDt;
      const row = {
        witness: w.label,
        populationSeed: w.populationSeed,
        individualId: w.individualId,
        passive,
        genotypeDigest: witnessDigest(g),
        morphology: passive ? null : { ...w.morphology, suspensionTypes: [...w.morphology.suspensionTypes] },
        result: summarize(r1, ir),
        sensitivity: alertSensitivity(r1.trace, ir),
        ordinary: null,
      };
      if (cfg.ordinaryFlavor) {
        const o1 = await evaluateIR(ir, { deterministic: false });
        const o2 = await evaluateIR(ir, { deterministic: false });
        // OBSERVATIONS only (F10): the ordinary flavor carries no
        // repeatability or cross-environment contract.
        row.ordinary = {
          repeatDigestEqual: o1.trace.digest === o2.trace.digest,
          result: summarize(o1, ir),
        };
      }
      rows.push(row);
    }
  }
  return rows;
}

async function controlsPass(report, check) {
  const init = createInitialPopulation({ seed: CONTROL_POPULATION_SEED, populationSize: 20 });
  const evaluation = await evaluatePopulation(init.population, {
    terrain: { ...WITNESS_TERRAIN },
    maxSteps: WITNESS_SPEC.maxSteps,
    deterministic: true,
    spawn: { ...WITNESS_SPEC.spawn },
    targetWheelSurfaceSpeed: WITNESS_SPEC.targetWheelSurfaceSpeed,
    wheelFriction: WITNESS_SPEC.wheelFriction,
  });
  const ranked = evaluation.individuals
    .filter((i) => !CONTROL_EXCLUDED_IDS.includes(i.individualId))
    .sort((a, b) => a.fitness - b.fitness);
  const picks = [
    { role: 'min-fitness', ind: ranked[0] },
    { role: 'median-fitness', ind: ranked[Math.floor(ranked.length / 2)] },
    { role: 'max-fitness', ind: ranked[ranked.length - 1] },
  ];
  const rows = [];
  for (const { role, ind } of picks) {
    const genotype = init.population.individuals
      .find((i) => i.individualId === ind.individualId).genotype;
    for (const passive of [false, true]) {
      const g = passive ? passiveTwinOf(genotype) : genotype;
      const ir = compileAssembly(g);
      const r = await evaluateIR(ir);
      const row = {
        role,
        populationSeed: CONTROL_POPULATION_SEED,
        individualId: ind.individualId,
        passive,
        genotypeDigest: witnessDigest(g),
        fitness: passive ? null : ind.fitness,
        result: summarize(r, ir),
        sensitivity: alertSensitivity(r.trace, ir),
      };
      // Threshold calibration signal (an OBSERVATION, prominently flagged in
      // the markdown — an alerting control means the diagnostic thresholds
      // need recalibration, or the control itself is a finding).
      row.calibrationClean = row.sensitivity.alertAtDefault === null
        && row.sensitivity.alertAtHalf === null;
      rows.push(row);
    }
  }
  check('dt:controls', evaluation.effectiveDt === Math.fround(FIXED_DT),
    `effectiveDt ${evaluation.effectiveDt}`);
  return rows;
}

async function terrainPass(witnessSet, cfg) {
  const rows = [];
  for (const w of witnessSet) {
    const genotype = witnessGenotype(w.populationSeed, w.individualId);
    for (const passive of [false, true]) {
      const ir = compileAssembly(passive ? passiveTwinOf(genotype) : genotype);
      for (const variant of cfg.terrainVariants) {
        const overrides = TERRAIN_VARIANTS[variant];
        if (overrides === undefined) {
          throw new Error(`probe-physics-explosion: unknown terrain variant '${variant}'`);
        }
        const r = await evaluateIR(ir, { terrainOverrides: { ...overrides } });
        rows.push({
          witness: w.label,
          passive,
          variant,
          changedVariable: Object.keys(overrides).length === 0
            ? 'none (witness terrain)' : JSON.stringify(overrides),
          result: summarize(r, ir),
        });
      }
    }
  }
  return rows;
}

async function vehiclePass(witnessSet, cfg) {
  const rows = [];
  for (const w of witnessSet) {
    const genotype = witnessGenotype(w.populationSeed, w.individualId);
    let arms = vehicleArmsFor(genotype);
    if (cfg.vehicleArms !== null) arms = arms.filter((a) => cfg.vehicleArms.includes(a.name));
    for (const arm of arms) {
      const armDigest = fnv1aHex(serializeGenotype(repairGenotype(arm.genotype)));
      const row = {
        witness: w.label,
        arm: arm.name,
        changedVariable: arm.changedVariable,
        armGenotypeDigest: armDigest,
        armEqualsWitness: armDigest === w.genotypeDigest,
        result: null,
        error: null,
      };
      try {
        const ir = compileAssembly(arm.genotype);
        const r = await evaluateIR(ir, arm.wheelFriction === undefined
          ? {} : { wheelFriction: arm.wheelFriction });
        row.result = summarize(r, ir);
      } catch (e) {
        // A loud-failing legal-domain arm is itself a finding, not a crash.
        row.error = String(e && e.message ? e.message : e);
      }
      rows.push(row);
    }
  }
  return rows;
}

// --- Entry ---------------------------------------------------------------------

export async function runProbe(config) {
  const cfg = { ...defaultConfig(), ...config };
  const witnessSet = selectWitnesses(cfg.witnesses);
  const passes = cfg.passes;
  for (const p of passes) selectPasses(p); // validate every named pass

  const report = {
    schema: PROBE_SCHEMA,
    argv: cfg.argv ?? [],
    engine: { rapierVersion: null, deterministic: true, effectiveDt: null },
    checks: [],
    baseline: null,
    controls: null,
    terrain: null,
    vehicle: null,
  };
  const check = (name, ok, detail) => report.checks.push({ name, ok: ok === true, detail });

  {
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    report.engine.rapierVersion = RAPIER.version();
    world.free();
  }

  if (passes.includes('baseline')) {
    report.baseline = await baselinePass(witnessSet, cfg, report, check);
    if (cfg.controls) report.controls = await controlsPass(report, check);
  }
  if (passes.includes('terrain')) report.terrain = await terrainPass(witnessSet, cfg);
  if (passes.includes('vehicle')) report.vehicle = await vehiclePass(witnessSet, cfg);
  return report;
}

// --- Markdown ------------------------------------------------------------------

function onsetCell(o) {
  if (o === null) return '(no trace)';
  const lead = o.leadingBody === null ? 'none'
    : `${o.leadingBody.bodyRole}(${o.leadingBody.axleIndex ?? '-'},${o.leadingBody.wheelIndex ?? '-'})`;
  return `alert@${o.firstAlertStep} causal@${o.firstCausalCandidateStep} cat@${o.firstCatastrophicStep} lead=${lead} lag=${o.chassisLagSteps}`;
}

export function renderMarkdown(report) {
  const L = [];
  const table = (header, rows) => {
    L.push(`| ${header.join(' | ')} |`);
    L.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const r of rows) L.push(`| ${r.join(' | ')} |`);
    L.push('');
  };
  L.push('# Physics-explosion probe');
  L.push('');
  L.push(`Schema \`${report.schema}\` — rapier ${report.engine.rapierVersion}, `
    + `deterministic flavor, effectiveDt ${report.engine.effectiveDt}. Every physics `
    + 'value below is an OBSERVATION (report-facing); only identity/repeatability/dt '
    + 'checks are hard.');
  L.push('');
  L.push('## Checks');
  L.push('');
  table(['check', 'ok', 'detail'],
    report.checks.map((c) => [c.name, c.ok ? 'OK' : '**FAIL**', c.detail ?? '']));
  if (report.baseline !== null) {
    L.push('## Baseline (witness reproduction)');
    L.push('');
    table(
      ['witness', 'arm', 'maxFwd (m)', 'final (m)', 'peak chassis (m/s)', 'peak body (m/s)', 'onset', 'alert x0.5/x1/x2', 'ordinary flavor'],
      report.baseline.map((b) => [
        `${b.witness} (${b.populationSeed}:${b.individualId})`,
        b.passive ? 'passive' : 'driven',
        exp3(b.result.maxForwardDistance),
        exp3(b.result.finalDistance),
        exp3(b.result.peakChassisSpeed),
        exp3(b.result.peakBodySpeed),
        onsetCell(b.result.onset),
        `${b.sensitivity.alertAtHalf}/${b.sensitivity.alertAtDefault}/${b.sensitivity.alertAtDouble} (spread ${b.sensitivity.spread})`,
        b.ordinary === null ? '(skipped)'
          : `maxFwd ${exp3(b.ordinary.result.maxForwardDistance)}, ${onsetCell(b.ordinary.result.onset)}, repeat=${b.ordinary.repeatDigestEqual}`,
      ]),
    );
  }
  if (report.controls !== null) {
    L.push('## Ordinary controls (population 20260725 minus witness ids; threshold calibration)');
    L.push('');
    table(
      ['control', 'id', 'arm', 'fitness (m)', 'maxFwd (m)', 'onset', 'calibration clean'],
      report.controls.map((c) => [
        c.role, c.individualId, c.passive ? 'passive' : 'driven',
        c.fitness === null ? '-' : exp3(c.fitness),
        exp3(c.result.maxForwardDistance),
        onsetCell(c.result.onset),
        c.calibrationClean ? 'yes' : '**NO — recalibrate or investigate**',
      ]),
    );
  }
  if (report.terrain !== null) {
    L.push('## Terrain ablations (coarse, config-expressible)');
    L.push('');
    table(
      ['witness', 'arm', 'variant', 'overrides', 'maxFwd (m)', 'peak body (m/s)', 'onset'],
      report.terrain.map((t) => [
        t.witness, t.passive ? 'passive' : 'driven', t.variant, t.changedVariable,
        exp3(t.result.maxForwardDistance),
        exp3(t.result.peakBodySpeed),
        onsetCell(t.result.onset),
      ]),
    );
  }
  if (report.vehicle !== null) {
    L.push('## Vehicle ablations (ecological genotype-level arms)');
    L.push('');
    table(
      ['witness', 'arm', 'changed variable', 'arm digest', 'maxFwd (m)', 'peak body (m/s)', 'onset / error'],
      report.vehicle.map((v) => [
        v.witness, v.arm, v.changedVariable, v.armGenotypeDigest,
        v.result === null ? '-' : exp3(v.result.maxForwardDistance),
        v.result === null ? '-' : exp3(v.result.peakBodySpeed),
        v.error !== null ? `ERROR: ${v.error}` : onsetCell(v.result.onset),
      ]),
    );
  }
  return L.join('\n');
}

// --- CLI -----------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      smoke: { type: 'boolean', default: false },
      witness: { type: 'string' },
      pass: { type: 'string' },
      json: { type: 'string' },
    },
  });
  const config = values.smoke ? smokeConfig() : defaultConfig();
  if (values.witness !== undefined) config.witnesses = values.witness;
  if (values.pass !== undefined) config.passes = selectPasses(values.pass);
  config.argv = process.argv.slice(2);

  const report = await runProbe(config);
  console.log(renderMarkdown(report));
  if (values.json !== undefined) {
    writeFileSync(values.json, JSON.stringify(report, null, 2));
    console.log(`\nJSON written to ${values.json}`);
  }
  const failed = report.checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} HARD CHECK FAILURE(S) — the investigation basis moved:`);
    for (const f of failed) console.log(`  ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
