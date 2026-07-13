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
//   engine   — Stage 2 (the earned shared-loop seam): DIAGNOSTIC engine
//              arms composed through runRealizedEvaluationLoop, never
//              through any production path — dt 1/120 x 600 steps (honest
//              requestedDt), world.numSolverIterations 2/8/16, chassis
//              additionalSolverIterations 0/8, hard/soft/both CCD off, soft
//              prediction sweep. The first arm is the composed BASELINE
//              whose digest must equal the canonical runEvaluation digest
//              (a HARD check — the no-second-authority discipline). A
//              parameter that stops the explosion is a SUPPRESSION, not a
//              correction, until in-policy + both-flavor + cost-justified.
//   local    — Stage 2 localization: one contact-collecting run per witness
//              (read-only inspect; handle->identity map; subject-oriented
//              normals via the flipped flag), the step-0 contact-graph
//              population experiment (empirical, never assumed), the
//              analytic spawn-clearance check, penetration/impulse extremes
//              around the causal window, wedge candidates (>=2 distinct
//              static partners, opposing oriented normals, penetrating),
//              and the offline joint-anchor-stretch series from the trace.
//   (vehicle additionally gains Stage-2 PHENOTYPE-PRESERVING arms — motor
//   off / leading-station removal on the ORIGINAL realized vehicle, clearly
//   labeled outside the genotype contract — the exact-component-necessity
//   level the ecological arms cannot reach.)
//   reproducer — the engine-upgrade rerun surface: the committed minimal
//              reproducer on both flavors + its full CLOSURE MATRIX (each
//              documented stabilizer, plus the zero-gravity free-space load
//              discriminator with measured static-contact counts), so the
//              necessary/sufficient claims regenerate from one command.
//   prevalence — the complete characterization populations (20 individuals
//              per declared seed), driven, full-trace forensic
//              classification — the reproducible source of the "N/60
//              catastrophic" figures.
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
import { runEvaluation, runRealizedEvaluationLoop } from '../src/sim/evaluation.js';
import {
  SUSPENSION_AXIS, addCorridor, addCorridorWithFeatures, createPhysics, FIXED_DT,
  realizeVehicle, suspensionAnchorLocal, vehicleWheelTransforms,
} from '../src/sim/physics/adapter.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { compareCheckpoints, compareTraces, decodeTraceRecord } from '../src/sim/trace.js';
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
  EXPLOSION_WITNESSES, MINIMAL_REPRODUCER, WITNESS_SPEC, WITNESS_TERRAIN,
  passiveTwinOf, reproducerGenotype, witnessDigest, witnessGenotype,
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

const IMPLEMENTED_PASSES = Object.freeze([
  'baseline', 'terrain', 'vehicle', 'engine', 'local', 'reproducer', 'prevalence',
]);

export function smokeConfig() {
  return {
    passes: ['baseline', 'terrain', 'vehicle', 'engine', 'local', 'reproducer', 'prevalence'],
    witnesses: ['A'],
    ordinaryFlavor: false,
    controls: false,
    terrainVariants: ['full', 'flat'],
    vehicleArms: ['passive', 'powerZero', 'sled'],
    componentArms: ['motorOff:all'],
    engineArms: ['baselineComposed', 'solverIters:8'],
    reproducerArms: ['original', 'freeSpace'],
    prevalenceSeeds: [20260725],
    argv: [],
  };
}

export function defaultConfig() {
  return {
    passes: ['baseline', 'terrain', 'vehicle', 'engine', 'local', 'reproducer', 'prevalence'],
    witnesses: ['A'],
    ordinaryFlavor: true,
    controls: true,
    terrainVariants: Object.keys(TERRAIN_VARIANTS),
    vehicleArms: null, // null = every arm
    componentArms: null,
    engineArms: null,
    reproducerArms: null,
    prevalenceSeeds: [20260725, 20260728, 20260729],
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
    if (!IMPLEMENTED_PASSES.includes(p)) {
      throw new Error(`probe-physics-explosion: unknown pass '${p}' (${IMPLEMENTED_PASSES.join('/')} or all)`);
    }
  }
  return list;
}

// --- Stage-2 composition (the earned shared-loop seam) --------------------------

// Rotate a vector by a unit quaternion (pure; scripts are outside the sim ban
// but this uses only mul/add anyway).
const rotateByQuat = (q, v) => {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};

const eachDynamicBody = (rec, fn) => {
  fn(rec.chassis.body);
  for (const st of rec.wheels) {
    fn(st.wheel.body);
    if (st.hub !== null) fn(st.hub.body);
  }
};

/**
 * Compose one DIAGNOSTIC run through runRealizedEvaluationLoop exactly as
 * runEvaluation composes it (createPhysics -> terrain(+statics BVH step) ->
 * staticColliders -> realizeVehicle -> loop), with the investigation-only
 * extension points the production runner deliberately lacks:
 *   worldTuning(world)         — timestep / numSolverIterations / maxCcdSubsteps
 *   featureFilter(f, i)        — post-generation descriptor filtering (RNG-safe)
 *   bodyTuning(rec, world)     — per-body CCD / solver-iteration setters,
 *                                motor reconfiguration
 *   stationFilter(st)          — PHENOTYPE-PRESERVING station removal: bodies
 *                                leave the world AND the realized record, so
 *                                the loop tracks survivors only
 *   buildInspect({world, rec, handleMap}) -> inspect(stepIndex)
 * The zero-extension composition must reproduce the canonical runEvaluation
 * digest — the engine pass's first arm hard-checks exactly that.
 */
async function composeRun(ir, {
  terrainOverrides = {},
  featureFilter = null,
  worldTuning = null,
  requestedDt = FIXED_DT,
  maxSteps = WITNESS_SPEC.maxSteps,
  bodyTuning = null,
  stationFilter = null,
  buildInspect = null,
  targetWheelSurfaceSpeed = WITNESS_SPEC.targetWheelSurfaceSpeed,
  wheelFriction = WITNESS_SPEC.wheelFriction,
} = {}) {
  const { RAPIER, world } = await createPhysics({ deterministic: true });
  try {
    if (worldTuning !== null) worldTuning(world);
    let terrain = generateCorridorTerrain({ ...WITNESS_TERRAIN, ...terrainOverrides });
    if (featureFilter !== null) {
      terrain = { ...terrain, features: terrain.features.filter(featureFilter) };
    }
    const handleMap = new Map();
    let corridor;
    if (terrain.features.length > 0) {
      corridor = addCorridorWithFeatures(RAPIER, world, terrain);
      corridor.features.forEach((f, i) => {
        handleMap.set(f.collider.handle, { kind: 'feature', index: i, type: f.feature.type });
      });
    } else {
      corridor = addCorridor(RAPIER, world, terrain);
      world.step(); // the [V1] statics-only query-BVH idiom
    }
    handleMap.set(corridor.floor.handle, { kind: 'floor' });
    corridor.walls.forEach((wl, i) => handleMap.set(wl.handle, { kind: 'wall', index: i }));
    const staticColliders = world.colliders.len();
    const spawn = spawnPoseOnFlatStart(ir, { ...WITNESS_SPEC.spawn });
    let rec = realizeVehicle(RAPIER, world, ir, {
      position: spawn.position, targetWheelSurfaceSpeed, wheelFriction,
    });
    for (const c of rec.chassis.colliders) {
      handleMap.set(c.handle, { kind: 'vehicle', role: 'chassis' });
    }
    for (const st of rec.wheels) {
      handleMap.set(st.wheel.collider.handle, {
        kind: 'vehicle', role: 'wheel', axleIndex: st.axleIndex, wheelIndex: st.wheelIndex,
      });
      if (st.hub !== null && st.hub.collider !== undefined) {
        handleMap.set(st.hub.collider.handle, {
          kind: 'vehicle', role: 'hub', axleIndex: st.axleIndex, wheelIndex: st.wheelIndex,
        });
      }
    }
    if (bodyTuning !== null) bodyTuning(rec, world);
    if (stationFilter !== null) {
      const keep = [];
      for (const st of rec.wheels) {
        if (stationFilter(st)) {
          keep.push(st);
        } else {
          // The engine removes joints attached to a removed body.
          world.removeRigidBody(st.wheel.body);
          if (st.hub !== null) world.removeRigidBody(st.hub.body);
        }
      }
      // Recompute the realized mass record for the SURVIVING phenotype (the
      // loop returns rec.mass verbatim — stale totals would misreport the
      // diagnostic vehicle). Read back from the surviving bodies, the same
      // source the realizer used.
      const wheels = keep.reduce((s, st) => s + st.wheel.body.mass(), 0);
      const hubs = keep.reduce((s, st) => s + (st.hub === null ? 0 : st.hub.body.mass()), 0);
      rec = {
        ...rec,
        wheels: keep,
        mass: {
          chassis: rec.mass.chassis,
          wheels,
          hubs,
          total: rec.mass.chassis + wheels + hubs,
        },
      };
    }
    const inspect = buildInspect === null ? null : buildInspect({ world, rec, handleMap });
    const result = runRealizedEvaluationLoop(world, [rec], {
      requestedDt, maxSteps, traceMode: 'full', checkpointInterval: 1, staticColliders, inspect,
    });
    return { result, spawn };
  } finally {
    world.free();
  }
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

/**
 * Byte-exact deterministic repeatability: full record-stream comparison
 * (compareTraces), byte counts, checkpoints, and the digest — never the FNV
 * digest alone (the records are already retained in full mode).
 */
function tracesByteIdentical(a, b) {
  return compareTraces(a, b) === null
    && a.byteCount === b.byteCount
    && a.recordCount === b.recordCount
    && a.digest === b.digest
    && compareCheckpoints(a.checkpoints, b.checkpoints) === null;
}

/** Result + forensics summary for one full-trace run (captureDt-aware). */
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
    captureDt: r.effectiveDt,
    traceDigest: r.trace === null ? null : r.trace.digest,
  };
  if (r.trace !== null && r.trace.mode === 'full') {
    const a = analyzeTrace(r.trace, {
      bodies: bodyReachMetadataForIR(ir), captureDt: r.effectiveDt,
    });
    const chassis = a.perBody.find((b) => b.bodyRole === 'chassis');
    row.peakChassisSpeed = chassis.peakSpeed.value;
    row.peakBodySpeed = Math.max(...a.perBody.map((b) => b.peakSpeed.value));
    row.onset = a.onset;
  }
  return row;
}

/** Alert-step spread across x0.5/x1/x2 thresholds — the sharpness signal. */
function alertSensitivity(trace, ir, captureDt = FIXED_DT) {
  const bodies = bodyReachMetadataForIR(ir);
  const at = (factor) => analyzeTrace(trace, {
    bodies, thresholds: scaledThresholds(factor), captureDt,
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
        tracesByteIdentical(r1.trace, r2.trace),
        `byte-exact record streams + checkpoints (digests ${r1.trace.digest}/${r2.trace.digest})`);
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
        sensitivity: alertSensitivity(r1.trace, ir, r1.effectiveDt),
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

// Threshold-calibration controls. LESSON RECORDED (the review finding that
// reshaped this procedure): fitness-selected controls can be CONTAMINATED
// because fitness itself conceals the instability — the first run of this
// probe selected population 20260725's max-fitness non-witness (id 1,
// 14.02 m) as a control and it failed calibration with a >1000 m/s internal
// blow-up, which is what triggered the full prevalence pass. The procedure
// therefore walks the fitness ranking DETERMINISTICALLY and substitutes any
// contaminated candidate with the next-ranked alert-free member; every
// contaminated candidate is reported as its own row (a finding, not a
// calibration sample).
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
  const mid = Math.floor(ranked.length / 2);
  // Deterministic candidate orders per role: min walks up, max walks down,
  // median spirals outward from the middle preferring the lower index.
  const candidateOrder = {
    'min-fitness': ranked.map((_, i) => i),
    'max-fitness': ranked.map((_, i) => ranked.length - 1 - i),
    'median-fitness': ranked.map((_, i) => {
      const k = Math.ceil(i / 2);
      return i % 2 === 0 ? mid - k : mid + k;
    }).filter((i) => i >= 0 && i < ranked.length),
  };
  const cache = new Map(); // individualId -> {row-for-driven, clean}
  const evaluateCandidate = async (ind, role) => {
    if (cache.has(ind.individualId)) return cache.get(ind.individualId);
    const genotype = init.population.individuals
      .find((i) => i.individualId === ind.individualId).genotype;
    const ir = compileAssembly(genotype);
    const r = await evaluateIR(ir);
    const sensitivity = alertSensitivity(r.trace, ir, r.effectiveDt);
    const clean = sensitivity.alertAtDefault === null && sensitivity.alertAtHalf === null;
    const entry = {
      genotype,
      driven: {
        role,
        populationSeed: CONTROL_POPULATION_SEED,
        individualId: ind.individualId,
        passive: false,
        genotypeDigest: witnessDigest(genotype),
        fitness: ind.fitness,
        result: summarize(r, ir),
        sensitivity,
        calibrationClean: clean,
      },
      clean,
    };
    cache.set(ind.individualId, entry);
    return entry;
  };
  const rows = [];
  const selectedIds = new Set();
  for (const role of ['min-fitness', 'median-fitness', 'max-fitness']) {
    let selected = null;
    for (const idx of candidateOrder[role]) {
      const ind = ranked[idx];
      if (selectedIds.has(ind.individualId)) continue;
      const entry = await evaluateCandidate(ind, role);
      if (entry.clean) {
        selected = { ind, entry };
        break;
      }
      // A contaminated candidate is a FINDING (fitness concealed a blow-up),
      // reported and then substituted — never used for calibration.
      rows.push({ ...entry.driven, role: `contaminated(${role})` });
    }
    if (selected === null) {
      throw new Error(`probe-physics-explosion: no alert-free ${role} control exists in `
        + `population ${CONTROL_POPULATION_SEED} — recalibrate thresholds or widen the pool`);
    }
    selectedIds.add(selected.ind.individualId);
    rows.push({ ...selected.entry.driven, role });
    const twin = passiveTwinOf(selected.entry.genotype);
    const twinIr = compileAssembly(twin);
    const rp = await evaluateIR(twinIr);
    const sensitivity = alertSensitivity(rp.trace, twinIr, rp.effectiveDt);
    rows.push({
      role,
      populationSeed: CONTROL_POPULATION_SEED,
      individualId: selected.ind.individualId,
      passive: true,
      genotypeDigest: witnessDigest(twin),
      fitness: null,
      result: summarize(rp, twinIr),
      sensitivity,
      calibrationClean: sensitivity.alertAtDefault === null && sensitivity.alertAtHalf === null,
    });
  }
  check('dt:controls', evaluation.effectiveDt === Math.fround(FIXED_DT),
    `effectiveDt ${evaluation.effectiveDt}`);
  return rows;
}

// The complete-population forensic scan — the reproducible source of the
// prevalence claim (every characterization individual, driven, full trace,
// alert/catastrophic classification). Numbers are OBSERVATIONS.
async function prevalencePass(cfg) {
  const perSeed = [];
  for (const seed of cfg.prevalenceSeeds) {
    const init = createInitialPopulation({ seed, populationSize: 20 });
    const individuals = [];
    for (const ind of init.population.individuals) {
      const ir = compileAssembly(ind.genotype);
      const r = await evaluateIR(ir);
      const a = analyzeTrace(r.trace, {
        bodies: bodyReachMetadataForIR(ir), captureDt: r.effectiveDt,
      });
      individuals.push({
        individualId: ind.individualId,
        genotypeDigest: witnessDigest(ind.genotype),
        maxForwardDistance: r.vehicles[0].maxForwardDistance,
        firstAlertStep: a.onset.firstAlertStep,
        firstCatastrophicStep: a.onset.firstCatastrophicStep,
        peakBodySpeed: Math.max(...a.perBody.map((b) => b.peakSpeed.value)),
      });
    }
    perSeed.push({
      populationSeed: seed,
      individuals,
      alertCount: individuals.filter((i) => i.firstAlertStep !== null).length,
      catastrophicCount: individuals.filter((i) => i.firstCatastrophicStep !== null).length,
      catastrophicIds: individuals
        .filter((i) => i.firstCatastrophicStep !== null)
        .map((i) => i.individualId),
    });
  }
  return perSeed;
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
        kind: 'ecological',
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
    // Stage-2 PHENOTYPE-PRESERVING arms (investigation-only, OUTSIDE the
    // genotype contract): the ORIGINAL vehicle is realized, then only the
    // implicated component is disabled/removed — every unrelated body,
    // transform, mass, and terrain element preserved. This is the
    // exact-component-necessity level the ecological arms cannot reach
    // (genotype removal re-spaces and re-masses the survivors).
    if (cfg.componentArms === null || cfg.componentArms.length > 0) {
      const ir = compileAssembly(genotype);
      const base = await composeRun(ir, {});
      const baseOnset = analyzeTrace(base.result.trace, {
        bodies: bodyReachMetadataForIR(ir),
      }).onset;
      const lead = baseOnset.leadingBody;
      const isLeadStation = (st) => lead !== null && lead.axleIndex !== null
        && st.axleIndex === lead.axleIndex && st.wheelIndex === lead.wheelIndex;
      const componentArms = [
        {
          name: 'motorOff:all',
          changedVariable: 'every drive motor reconfigured to zero gain post-realization',
          opts: {
            bodyTuning: (rec) => {
              for (const st of rec.wheels) {
                if (st.irWheel.driven && st.irWheel.driveTorque > 0) {
                  st.driveJoint.configureMotorVelocity(0, 0);
                }
              }
            },
          },
        },
        {
          name: 'motorOff:leading',
          changedVariable: `drive motor of the leading station (${lead === null ? 'n/a' : `${lead.axleIndex},${lead.wheelIndex}`}) zeroed post-realization`,
          opts: {
            bodyTuning: (rec) => {
              for (const st of rec.wheels) {
                if (isLeadStation(st) && st.irWheel.driven && st.irWheel.driveTorque > 0) {
                  st.driveJoint.configureMotorVelocity(0, 0);
                }
              }
            },
          },
        },
        {
          name: 'stationRemoved:leading',
          changedVariable: `leading station (${lead === null ? 'n/a' : `${lead.axleIndex},${lead.wheelIndex}`}) bodies removed post-realization; everything else untouched`,
          opts: { stationFilter: (st) => !isLeadStation(st) },
        },
      ].filter((a) => cfg.componentArms === null || cfg.componentArms.includes(a.name));
      for (const arm of componentArms) {
        const row = {
          witness: w.label,
          kind: 'phenotype-preserving',
          arm: arm.name,
          changedVariable: arm.changedVariable,
          armGenotypeDigest: w.genotypeDigest, // the ORIGINAL genotype — that is the point
          armEqualsWitness: true,
          result: null,
          error: null,
        };
        try {
          const { result } = await composeRun(ir, arm.opts);
          row.result = summarize(result, ir);
        } catch (e) {
          row.error = String(e && e.message ? e.message : e);
        }
        rows.push(row);
      }
    }
  }
  return rows;
}

// --- Stage-2 passes --------------------------------------------------------------

const ENGINE_ARMS = Object.freeze([
  { name: 'baselineComposed', changedVariable: 'none (equivalence hard check vs runEvaluation)', opts: {} },
  {
    name: 'dtHalf',
    changedVariable: 'world.timestep = 1/120, 600 steps (same 5 s of sim time)',
    opts: { worldTuning: (w) => { w.timestep = 1 / 120; }, requestedDt: 1 / 120, maxSteps: 600 },
  },
  { name: 'solverIters:2', changedVariable: 'world.numSolverIterations = 2 (default 4)', opts: { worldTuning: (w) => { w.numSolverIterations = 2; } } },
  { name: 'solverIters:8', changedVariable: 'world.numSolverIterations = 8', opts: { worldTuning: (w) => { w.numSolverIterations = 8; } } },
  { name: 'solverIters:16', changedVariable: 'world.numSolverIterations = 16', opts: { worldTuning: (w) => { w.numSolverIterations = 16; } } },
  {
    name: 'addlIters:0',
    changedVariable: 'chassis setAdditionalSolverIterations(0) (policy 4)',
    opts: { bodyTuning: (rec) => rec.chassis.body.setAdditionalSolverIterations(0) },
  },
  {
    name: 'addlIters:8',
    changedVariable: 'chassis setAdditionalSolverIterations(8)',
    opts: { bodyTuning: (rec) => rec.chassis.body.setAdditionalSolverIterations(8) },
  },
  {
    name: 'hardCcdOff',
    changedVariable: 'enableCcd(false) on every dynamic body (soft CCD kept)',
    opts: { bodyTuning: (rec) => eachDynamicBody(rec, (b) => b.enableCcd(false)) },
  },
  {
    name: 'softCcdOff',
    changedVariable: 'setSoftCcdPrediction(0) on every dynamic body (hard CCD kept)',
    opts: { bodyTuning: (rec) => eachDynamicBody(rec, (b) => b.setSoftCcdPrediction(0)) },
  },
  {
    name: 'bothCcdOff',
    changedVariable: 'hard AND soft CCD off on every dynamic body',
    opts: {
      bodyTuning: (rec) => eachDynamicBody(rec, (b) => {
        b.enableCcd(false);
        b.setSoftCcdPrediction(0);
      }),
    },
  },
  { name: 'softCcd:0.1', changedVariable: 'setSoftCcdPrediction(0.1) (policy 1)', opts: { bodyTuning: (rec) => eachDynamicBody(rec, (b) => b.setSoftCcdPrediction(0.1)) } },
  { name: 'softCcd:0.5', changedVariable: 'setSoftCcdPrediction(0.5)', opts: { bodyTuning: (rec) => eachDynamicBody(rec, (b) => b.setSoftCcdPrediction(0.5)) } },
  { name: 'softCcd:2', changedVariable: 'setSoftCcdPrediction(2)', opts: { bodyTuning: (rec) => eachDynamicBody(rec, (b) => b.setSoftCcdPrediction(2)) } },
  {
    name: 'zeroGravity',
    changedVariable: 'world.gravity = 0 (free space: the ground-contact/internal-load discriminator — the vehicle spawns 0.02 m up and never falls)',
    opts: { worldTuning: (w) => { w.gravity = { x: 0, y: 0, z: 0 }; } },
  },
]);

async function enginePass(witnessSet, cfg, check) {
  const rows = [];
  for (const w of witnessSet) {
    const ir = compileAssembly(witnessGenotype(w.populationSeed, w.individualId));
    let reference = null;
    let arms = ENGINE_ARMS;
    if (cfg.engineArms !== null) arms = arms.filter((a) => cfg.engineArms.includes(a.name));
    for (const arm of arms) {
      const { result } = await composeRun(ir, arm.opts);
      if (arm.name === 'baselineComposed') {
        reference = await evaluateIR(ir);
        check(`composed:${w.label}`, result.trace.digest === reference.trace.digest,
          `composed ${result.trace.digest} vs canonical ${reference.trace.digest}`);
      }
      rows.push({
        witness: w.label,
        arm: arm.name,
        changedVariable: arm.changedVariable,
        requestedDt: result.requestedDt,
        effectiveDt: result.effectiveDt,
        executedSteps: result.executedSteps,
        result: summarize(result, ir),
      });
    }
  }
  return rows;
}

// Offline joint-anchor telemetry from the full trace.
//   S0 station:  stretch = |chassisPose x anchorLocal - wheelPos|  (the
//                drive-revolute anchor separation — ~1e-6 m at creation).
//   S1 station:  stretch = |hubPos - wheelPos| (the hub->wheel REVOLUTE
//                anchor separation; hub and wheel are coaxial), PLUS the
//                chassis->hub PRISMATIC decomposition: with a1 = chassisPose
//                x suspensionAnchorLocal and axis = chassisRot x
//                SUSPENSION_AXIS, delta = hubPos - a1 splits into the
//                along-axis coordinate (compared against the [0, travel]
//                limits) and the OFF-AXIS separation |delta - coord*axis| —
//                the prismatic's own constraint-violation measure.
// Separations of centimetres mean the SOLVER left the constraint violated —
// the constraint-divergence signature.
function jointStretchSeries(trace, ir) {
  const stationsMeta = new Map(); // key -> {isS1, local, anchorLocal, travel}
  ir.axles.forEach((axle, i) => {
    const axleIndex = Number.isInteger(axle.index) ? axle.index : i;
    axle.wheels.forEach((wheel, j) => {
      stationsMeta.set(`${axleIndex}|${j}`, {
        isS1: axle.suspension.type === 'S1',
        anchorLocal: suspensionAnchorLocal(axle, wheel),
        travel: axle.suspension.travel,
      });
    });
  });
  const locals = new Map();
  for (const t of vehicleWheelTransforms(ir, {})) {
    locals.set(`${t.axleIndex}|${t.wheelIndex}`, t.local);
  }
  const poses = new Map(); // step -> { chassis, [key]: {role, pos} }
  for (const bytes of trace.records) {
    const rec = decodeTraceRecord(bytes);
    if (!poses.has(rec.stepIndex)) poses.set(rec.stepIndex, {});
    const step = poses.get(rec.stepIndex);
    if (rec.bodyRole === 'chassis') {
      step.chassis = { pos: rec.translation, rot: rec.rotation };
    } else {
      step[`${rec.bodyRole}|${rec.axleIndex}|${rec.wheelIndex}`] = rec.translation;
    }
  }
  const stations = new Map();
  const stationState = (key) => {
    if (!stations.has(key)) {
      stations.set(key, {
        maxStretch: 0,
        step: null,
        firstOver2cm: null,
        prismatic: null,
      });
    }
    return stations.get(key);
  };
  for (const [stepIndex, step] of poses) {
    if (step.chassis === undefined) continue;
    for (const [key, local] of locals) {
      const meta = stationsMeta.get(key);
      const wheelPos = step[`wheel|${key}`];
      if (wheelPos === undefined || meta === undefined) continue;
      let expected;
      if (meta.isS1) {
        expected = step[`hub|${key}`];
        if (expected === undefined) continue;
      } else {
        const r = rotateByQuat(step.chassis.rot, local);
        expected = {
          x: step.chassis.pos.x + r.x,
          y: step.chassis.pos.y + r.y,
          z: step.chassis.pos.z + r.z,
        };
      }
      const dx = wheelPos.x - expected.x;
      const dy = wheelPos.y - expected.y;
      const dz = wheelPos.z - expected.z;
      const stretch = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (Number.isFinite(stretch)) {
        const s = stationState(key);
        if (stretch > s.maxStretch) {
          s.maxStretch = stretch;
          s.step = stepIndex;
        }
        if (stretch > 0.02 && (s.firstOver2cm === null || stepIndex < s.firstOver2cm)) {
          s.firstOver2cm = stepIndex;
        }
      }
      if (meta.isS1) {
        const hubPos = step[`hub|${key}`];
        if (hubPos === undefined) continue;
        const a1r = rotateByQuat(step.chassis.rot, meta.anchorLocal);
        const a1 = {
          x: step.chassis.pos.x + a1r.x,
          y: step.chassis.pos.y + a1r.y,
          z: step.chassis.pos.z + a1r.z,
        };
        const axis = rotateByQuat(step.chassis.rot, SUSPENSION_AXIS);
        const d = { x: hubPos.x - a1.x, y: hubPos.y - a1.y, z: hubPos.z - a1.z };
        const coord = d.x * axis.x + d.y * axis.y + d.z * axis.z;
        const ox = d.x - coord * axis.x;
        const oy = d.y - coord * axis.y;
        const oz = d.z - coord * axis.z;
        const offAxis = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (!Number.isFinite(offAxis) || !Number.isFinite(coord)) continue;
        const s = stationState(key);
        if (s.prismatic === null) {
          s.prismatic = {
            maxOffAxis: 0,
            offAxisStep: null,
            firstOffAxisOver2cm: null,
            coordMin: Infinity,
            coordMax: -Infinity,
            travel: meta.travel,
          };
        }
        const p = s.prismatic;
        if (offAxis > p.maxOffAxis) {
          p.maxOffAxis = offAxis;
          p.offAxisStep = stepIndex;
        }
        if (offAxis > 0.02 && (p.firstOffAxisOver2cm === null || stepIndex < p.firstOffAxisOver2cm)) {
          p.firstOffAxisOver2cm = stepIndex;
        }
        if (coord < p.coordMin) p.coordMin = coord;
        if (coord > p.coordMax) p.coordMax = coord;
      }
    }
  }
  return [...stations.entries()]
    .map(([key, s]) => ({
      station: key,
      suspension: stationsMeta.get(key).isS1 ? 'S1' : 'S0',
      ...s,
      prismatic: s.prismatic === null ? null : {
        ...s.prismatic,
        limitExceeded: s.prismatic.coordMin < -0.02
          || s.prismatic.coordMax > s.prismatic.travel + 0.02,
      },
    }))
    .sort((a, b) => (a.firstOver2cm ?? Infinity) - (b.firstOver2cm ?? Infinity));
}

async function localPass(witnessSet) {
  const rows = [];
  for (const w of witnessSet) {
    const ir = compileAssembly(witnessGenotype(w.populationSeed, w.individualId));
    const contactSteps = [];
    const { result, spawn } = await composeRun(ir, {
      buildInspect: ({ world, rec, handleMap }) => {
        const subjects = [
          ...rec.chassis.colliders.map((c) => ({ c, id: { role: 'chassis', axleIndex: null, wheelIndex: null } })),
          ...rec.wheels.flatMap((st) => {
            const arr = [{
              c: st.wheel.collider,
              id: { role: 'wheel', axleIndex: st.axleIndex, wheelIndex: st.wheelIndex },
            }];
            if (st.hub !== null && st.hub.collider !== undefined) {
              arr.push({
                c: st.hub.collider,
                id: { role: 'hub', axleIndex: st.axleIndex, wheelIndex: st.wheelIndex },
              });
            }
            return arr;
          }),
        ];
        return (stepIndex) => {
          const pairs = [];
          for (const { c, id } of subjects) {
            world.contactPairsWith(c, (other) => {
              const partner = handleMap.get(other.handle);
              if (partner === undefined) {
                throw new Error(`probe-physics-explosion: unmapped collider handle ${other.handle}`);
              }
              if (partner.kind === 'vehicle') return; // self-pairs are filtered by groups anyway
              let numContacts = 0;
              let minDist = Infinity;
              let maxImpulse = 0;
              let normal = null;
              world.contactPair(c, other, (m, flipped) => {
                const n = m.numContacts();
                numContacts += n;
                for (let i = 0; i < n; i += 1) {
                  const d = m.contactDist(i);
                  if (d < minDist) minDist = d;
                  const imp = m.contactImpulse(i);
                  if (imp > maxImpulse) maxImpulse = imp;
                }
                const nm = m.normal();
                // Subject-oriented: flipped means the callback saw
                // (other, c) order — negate so the normal always points the
                // same way relative to the SUBJECT body.
                normal = flipped ? { x: -nm.x, y: -nm.y, z: -nm.z } : { x: nm.x, y: nm.y, z: nm.z };
              });
              if (numContacts > 0) {
                if (normal === null) {
                  // The manifold callback assigns the normal whenever
                  // contacts exist — a null here would mean the probe's
                  // invariant broke, and the wedge classifier below would
                  // silently misbehave. Fail loud instead.
                  throw new Error('probe-physics-explosion: contact pair with contacts but no manifold normal');
                }
                pairs.push({ body: id, partner, numContacts, minDist, maxImpulse, normal });
              }
            });
          }
          contactSteps.push({ step: stepIndex, pairs });
        };
      },
    });
    const forensics = analyzeTrace(result.trace, { bodies: bodyReachMetadataForIR(ir) });
    const onset = forensics.onset;
    const causal = onset.firstCausalCandidateStep ?? onset.firstAlertStep;

    // The step-0 contact-graph population experiment (empirical — an empty
    // capture-0 set is NEVER read as "no initial overlap").
    const pairsAt = (k) => (contactSteps.find((s) => s.step === k)?.pairs ?? []);
    const step0Pairs = pairsAt(0).length;
    const step1Pairs = pairsAt(1).length;

    // Analytic spawn clearance (pure; the pad is exactly-elevation-0):
    // wheel bottoms and chassis belly vs the pad plane at spawn.
    let minWheelClearance = Infinity;
    for (const t of vehicleWheelTransforms(ir, {})) {
      const wheel = ir.axles.find((a, i) => (Number.isInteger(a.index) ? a.index : i) === t.axleIndex)
        .wheels[t.wheelIndex];
      const bottom = spawn.position.y + t.local.y - wheel.radius;
      if (bottom < minWheelClearance) minWheelClearance = bottom;
    }
    const bellyClearance = spawn.position.y + ir.chassis.aabb.min.y;

    // Penetration/impulse extremes and the causal-window contact picture.
    let deepest = null;
    let hardest = null;
    const wedges = [];
    for (const s of contactSteps) {
      const statics = new Map(); // body key -> [{partner, normal, minDist, maxImpulse}]
      for (const p of s.pairs) {
        if (p.minDist < (deepest?.minDist ?? Infinity)) deepest = { step: s.step, ...p };
        if (p.maxImpulse > (hardest?.maxImpulse ?? 0)) hardest = { step: s.step, ...p };
        const key = `${p.body.role}|${p.body.axleIndex}|${p.body.wheelIndex}`;
        if (!statics.has(key)) statics.set(key, []);
        statics.get(key).push(p);
      }
      for (const [key, list] of statics) {
        if (list.length < 2) continue;
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const a = list[i];
            const b = list[j];
            const samePartner = JSON.stringify(a.partner) === JSON.stringify(b.partner);
            const dot = a.normal.x * b.normal.x + a.normal.y * b.normal.y + a.normal.z * b.normal.z;
            if (!samePartner && dot < -0.5 && a.minDist < 0 && b.minDist < 0
              && a.maxImpulse > 0 && b.maxImpulse > 0) {
              wedges.push({ step: s.step, body: key, partners: [a.partner, b.partner], dot });
            }
          }
        }
      }
    }
    const windowLo = Math.max(0, (causal ?? 0) - 3);
    const windowHi = (onset.firstAlertStep ?? causal ?? 0) + 3;
    const windowContacts = contactSteps
      .filter((s) => s.step >= windowLo && s.step <= windowHi)
      .map((s) => ({
        step: s.step,
        pairs: s.pairs.map((p) => ({
          body: `${p.body.role}(${p.body.axleIndex ?? '-'},${p.body.wheelIndex ?? '-'})`,
          partner: p.partner.kind === 'feature' ? `feature[${p.partner.index}]:${p.partner.type}` : p.partner.kind,
          numContacts: p.numContacts,
          minDist: p.minDist,
          maxImpulse: p.maxImpulse,
        })),
      }));
    const stretch = jointStretchSeries(result.trace, ir);
    rows.push({
      witness: w.label,
      onset,
      step0Pairs,
      step1Pairs,
      spawn: { minWheelClearance, bellyClearance },
      deepestPenetration: deepest,
      hardestImpulse: hardest,
      wedgeCandidates: wedges.length,
      wedgeSample: wedges.slice(0, 3),
      windowContacts,
      jointStretch: stretch.slice(0, 6),
    });
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
    engineAblations: null,
    localization: null,
    reproducer: null,
    prevalence: null,
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
  if (passes.includes('engine')) report.engineAblations = await enginePass(witnessSet, cfg, check);
  if (passes.includes('local')) report.localization = await localPass(witnessSet);
  if (passes.includes('reproducer')) report.reproducer = await reproducerPass(cfg, check);
  if (passes.includes('prevalence')) report.prevalence = await prevalencePass(cfg);
  return report;
}

// The engine-upgrade rerun surface (see MINIMAL_REPRODUCER's header):
// identity is HARD; every onset/outcome is an OBSERVATION — a future Rapier
// that converges this island simply reports no alert, and the
// engine-limitation ruling gets re-evaluated. The pass carries the FULL
// closure matrix, so the necessary/sufficient claims regenerate from this
// one command: the unchanged reproducer on both flavors, each documented
// stabilizer (either axle removed, narrow track, heavy chassis), and the
// free-space load discriminator (zero gravity, zero static contacts).
const REPRODUCER_ARMS = Object.freeze([
  'original', 'removeAxle:0', 'removeAxle:1', 'narrowTrack', 'heavyChassis', 'freeSpace',
]);

async function reproducerPass(cfg, check) {
  const g = reproducerGenotype();
  check('identity:reproducer', witnessDigest(g) === MINIMAL_REPRODUCER.genotypeDigest,
    `expected ${MINIMAL_REPRODUCER.genotypeDigest}`);
  const ir = compileAssembly(g);
  const overrides = { ...MINIMAL_REPRODUCER.terrainOverrides };
  const arms = cfg.reproducerArms === null
    ? [...REPRODUCER_ARMS]
    : REPRODUCER_ARMS.filter((a) => cfg.reproducerArms.includes(a));
  const rows = [];
  for (const arm of arms) {
    if (arm === 'original') {
      for (const deterministic of [true, false]) {
        const r = await evaluateIR(ir, { terrainOverrides: overrides, deterministic });
        if (deterministic) {
          const r2 = await evaluateIR(ir, { terrainOverrides: overrides, deterministic });
          check('repeat:reproducer', tracesByteIdentical(r.trace, r2.trace),
            `byte-exact record streams + checkpoints (digests ${r.trace.digest}/${r2.trace.digest})`);
        }
        rows.push({
          arm,
          flavor: deterministic ? 'deterministic' : 'ordinary',
          changedVariable: 'none (the committed reproducer)',
          genotypeDigest: MINIMAL_REPRODUCER.genotypeDigest,
          staticContacts: null,
          result: summarize(r, ir),
        });
      }
      continue;
    }
    if (arm === 'freeSpace') {
      // Zero gravity: the vehicle spawns 0.02 m above the pad and never
      // falls — the run counts vehicle-vs-STATIC contact pairs across every
      // capture, so "no contact occurred" is measured, never assumed
      // (vehicle self-pairs are collision-inert and excluded).
      let staticContacts = 0;
      const { result } = await composeRun(ir, {
        terrainOverrides: overrides,
        worldTuning: (w) => { w.gravity = { x: 0, y: 0, z: 0 }; },
        buildInspect: ({ world, rec, handleMap }) => {
          const colliders = [
            ...rec.chassis.colliders,
            ...rec.wheels.flatMap((st) => [st.wheel.collider,
              ...(st.hub !== null && st.hub.collider !== undefined ? [st.hub.collider] : [])]),
          ];
          return () => {
            for (const c of colliders) {
              world.contactPairsWith(c, (other) => {
                const partner = handleMap.get(other.handle);
                if (partner !== undefined && partner.kind !== 'vehicle') staticContacts += 1;
              });
            }
          };
        },
      });
      rows.push({
        arm,
        flavor: 'deterministic',
        changedVariable: 'world.gravity = 0 (free space; no static contact ever occurs — measured)',
        genotypeDigest: MINIMAL_REPRODUCER.genotypeDigest,
        staticContacts,
        result: summarize(result, ir),
      });
      continue;
    }
    // The documented stabilizers, as canonical genotype edits (each arm
    // records its own digest — repair keeps them in-band).
    let edited;
    let changedVariable;
    if (arm === 'removeAxle:0' || arm === 'removeAxle:1') {
      const i = Number(arm.split(':')[1]);
      edited = { ...deepClone(g), axles: g.axles.filter((_, j) => j !== i) };
      changedVariable = `axle ${i} removed (single-module stabilizer)`;
    } else if (arm === 'narrowTrack') {
      edited = { ...deepClone(g), axles: g.axles.map((a) => ({ ...deepClone(a), trackHalf: 0.2 })) };
      changedVariable = 'trackHalf genes -> 0.2 (short lateral anchor arms)';
    } else {
      edited = { ...deepClone(g), frameDensity: 1 };
      changedVariable = 'frameDensity gene -> 1 (~160 kg chassis)';
    }
    const armGenotype = repairGenotype(edited);
    const armIr = compileAssembly(armGenotype);
    const r = await evaluateIR(armIr, { terrainOverrides: overrides });
    rows.push({
      arm,
      flavor: 'deterministic',
      changedVariable,
      genotypeDigest: fnv1aHex(serializeGenotype(armGenotype)),
      staticContacts: null,
      result: summarize(r, armIr),
    });
  }
  return rows;
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
    L.push('## Vehicle ablations (ecological genotype arms + phenotype-preserving component arms)');
    L.push('');
    table(
      ['witness', 'kind', 'arm', 'changed variable', 'arm digest', 'maxFwd (m)', 'peak body (m/s)', 'onset / error'],
      report.vehicle.map((v) => [
        v.witness, v.kind, v.arm, v.changedVariable, v.armGenotypeDigest,
        v.result === null ? '-' : exp3(v.result.maxForwardDistance),
        v.result === null ? '-' : exp3(v.result.peakBodySpeed),
        v.error !== null ? `ERROR: ${v.error}` : onsetCell(v.result.onset),
      ]),
    );
  }
  if (report.engineAblations !== null) {
    L.push('## Engine ablations (diagnostic; composed through the shared loop — NEVER production settings)');
    L.push('');
    L.push('A parameter that stops the explosion is a SUPPRESSION, not a correction, '
      + 'until it is in-policy, justified for the general population on both flavors '
      + 'with bench cost, and introduces no new failure mode.');
    L.push('');
    table(
      ['witness', 'arm', 'changed variable', 'dt (req/eff)', 'steps', 'maxFwd (m)', 'peak body (m/s)', 'onset'],
      report.engineAblations.map((e) => [
        e.witness, e.arm, e.changedVariable,
        `${exp3(e.requestedDt)}/${exp3(e.effectiveDt)}`,
        e.executedSteps,
        exp3(e.result.maxForwardDistance),
        exp3(e.result.peakBodySpeed),
        onsetCell(e.result.onset),
      ]),
    );
  }
  if (report.localization !== null) {
    L.push('## Localization (contact evidence, spawn geometry, joint stretch)');
    L.push('');
    table(
      ['witness', 'onset', 'step0/step1 contact pairs', 'spawn clearance (wheel/belly m)', 'deepest penetration', 'hardest impulse', 'wedges', 'first joint >2cm stretch', 'first prismatic off-axis >2cm'],
      report.localization.map((l) => {
        const firstPrismatic = l.jointStretch
          .filter((s) => s.prismatic !== null && s.prismatic.firstOffAxisOver2cm !== null)
          .sort((a, b) => a.prismatic.firstOffAxisOver2cm - b.prismatic.firstOffAxisOver2cm)[0];
        return [
          l.witness,
          onsetCell(l.onset),
          `${l.step0Pairs}/${l.step1Pairs}`,
          `${exp3(l.spawn.minWheelClearance)}/${exp3(l.spawn.bellyClearance)}`,
          l.deepestPenetration === null ? 'none'
            : `${exp3(l.deepestPenetration.minDist)} m @${l.deepestPenetration.step} (${l.deepestPenetration.partner.kind})`,
          l.hardestImpulse === null ? 'none'
            : `${exp3(l.hardestImpulse.maxImpulse)} @${l.hardestImpulse.step} (${l.hardestImpulse.partner.kind})`,
          l.wedgeCandidates,
          l.jointStretch.length === 0 ? 'none'
            : `${l.jointStretch[0].suspension} ${l.jointStretch[0].station} @${l.jointStretch[0].firstOver2cm} (max ${exp3(l.jointStretch[0].maxStretch)} m)`,
          firstPrismatic === undefined ? 'none'
            : `${firstPrismatic.station} @${firstPrismatic.prismatic.firstOffAxisOver2cm} (max ${exp3(firstPrismatic.prismatic.maxOffAxis)} m; coord [${exp3(firstPrismatic.prismatic.coordMin)}, ${exp3(firstPrismatic.prismatic.coordMax)}] vs travel ${exp3(firstPrismatic.prismatic.travel)})`,
        ];
      }),
    );
    L.push('Window contact detail and full joint-stretch/prismatic tables are in the JSON output.');
    L.push('');
  }
  if (report.reproducer !== null && report.reproducer !== undefined) {
    L.push('## Minimum reproducer + closure matrix (2 wide-track paired S0 axles, light chassis, undriven, flat ground)');
    L.push('');
    table(
      ['arm', 'flavor', 'changed variable', 'digest', 'static contacts', 'maxFwd (m)', 'peak body (m/s)', 'onset (OBSERVATION — rerun on Rapier bump)'],
      report.reproducer.map((r) => [
        r.arm, r.flavor, r.changedVariable, r.genotypeDigest,
        r.staticContacts === null ? '-' : r.staticContacts,
        exp3(r.result.maxForwardDistance),
        exp3(r.result.peakBodySpeed),
        onsetCell(r.result.onset),
      ]),
    );
  }
  if (report.prevalence !== null && report.prevalence !== undefined) {
    L.push('## Prevalence (complete characterization populations, driven, forensic classification)');
    L.push('');
    table(
      ['population seed', 'alerts', 'catastrophic', 'catastrophic ids (@first step)'],
      report.prevalence.map((p) => [
        p.populationSeed,
        `${p.alertCount}/20`,
        `${p.catastrophicCount}/20`,
        p.individuals
          .filter((i) => i.firstCatastrophicStep !== null)
          .map((i) => `${i.individualId}@${i.firstCatastrophicStep}`)
          .join(' '),
      ]),
    );
    L.push('Per-individual rows (digest, maxFwd, alert/catastrophic steps, peak speed) are in the JSON output.');
    L.push('');
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
