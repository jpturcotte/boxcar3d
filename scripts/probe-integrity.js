// Numerical-integrity characterization probe — a reproducible INSTRUMENT,
// never a CI gate (the characterize-population class: outside the src/sim
// ESLint ban; its only CI touchpoint is the schema smoke in
// tests/integrity-probe-schema.test.js). It characterizes the DETECTOR
// (src/sim/integrity.js, policy v1) — which subjects it classifies how, what
// each signal contributes, how classification behaves in a mutation
// neighborhood, and what the always-on fold costs — against the shipping
// stable engine.
//
// Passes:
//   signals      — the known-subject panel: witnesses A/B/C/S (driven), the
//                  committed minimal reproducer R, the three clean controls
//                  (population 20260725 ids 13/15/16 — the PR #17 calibration
//                  procedure's selections), and fixtures A–D. Each subject
//                  runs ONCE, full-trace, deterministic flavor; the row
//                  reports the ONLINE classification, and the HARD check is
//                  online ≡ offline agreement with analyzeTrace over the same
//                  run — the FULL derivable contract: classification (status,
//                  firstFailureStep, ordered reasons) via the shared
//                  offlineIntegrityView derivation PLUS bitwise peaks and
//                  identical onset steps — a contract of the shared
//                  arithmetic, agnostic to what the engine did.
//                  Reason-code attribution across the panel answers "which
//                  predicates actually contribute".
//   population   — the committed characterization populations (20 individuals
//                  per declared seed), evaluated through the PRODUCTION path
//                  (evaluatePopulation, trace 'none', isolated worlds) under
//                  the characterization identity (terrain 20260727, 300
//                  steps). Reports per-member status/fitness and the
//                  FALSE-NEGATIVE WATCH LIST: members whose status is 'ok'
//                  but whose alert observation fired — the design record's
//                  acceptance gate inspects exactly these for
//                  runaway-gaining-selection-relevant-progress below the
//                  catastrophic bound.
//   neighborhood — deterministic PARAMETRIC gene-jitter around three declared
//                  parents (a stable ordinary member, an affected witness,
//                  the Phase-1A champion), seed 20260731: every CONTINUOUS
//                  [0,1] gene leaf perturbed by ±magnitude, clamped,
//                  re-repaired (canonical by construction), compiled,
//                  evaluated, classified. Discrete-decode genes
//                  (assembly.DISCRETE_GENE_KEYS: family/suspType/symmetric/
//                  paired/driven/nodeCount) are PRESERVED verbatim — decode-
//                  boundary crossings are structural mutations, not jitter,
//                  and an accidental suspType→S2 crossing would abort the
//                  experiment on the realizability gate. Answers
//                  how abruptly integrity status changes across the
//                  conditioning boundary, whether repair moves children
//                  across it, whether a false-positive halo surrounds viable
//                  parents, and whether failures hide behind ordinary
//                  distance in mutated children. The FULL sweep is Phase 1B's
//                  documented first experiment; this pass is deliberately
//                  SMALL (the machine-footprint rule).
//   cost         — paired interleaved integrity-on vs integrity-off through
//                  the direct-caller core-loop seam (the ONLY place the off
//                  arm exists), arms back-to-back per sample with the order
//                  alternated, median of per-pair ratios (the bench-physics
//                  method). Timing is a machine OBSERVATION, never a
//                  threshold.
//
// Check tiers (the probe-rapier-timing convention): HARD checks are
// identity/contract-class only — genotype digests, the f32 dt readback, and
// online≡offline agreement (a property of the shared arithmetic, not of any
// physics outcome). Every physics magnitude, status, count, and timing is an
// OBSERVATION: no committed check asserts that any subject diverges, so the
// probe survives a future engine that converges these islands.
//
// USAGE (defaults are SMALL):
//   node scripts/probe-integrity.js
//   node scripts/probe-integrity.js --smoke
//   node scripts/probe-integrity.js --pass signals,population --json out.json

/* eslint no-console: 0 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { runEvaluation, runRealizedEvaluationLoop } from '../src/sim/evaluation.js';
import {
  FIXED_DT, addCorridor, addCorridorWithFeatures, createPhysics, realizeVehicle,
} from '../src/sim/physics/adapter.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { analyzeTrace, bodyReachMetadataForIR, offlineIntegrityView } from '../src/sim/trace-forensics.js';
import { INTEGRITY_POLICY_VERSION, INTEGRITY_THRESHOLDS } from '../src/sim/integrity.js';
import {
  evaluatePopulation, fitnessFromVehicleResult, isVehicleResultSelectable,
  isVehicleResultValid, spawnPoseOnFlatStart,
} from '../src/sim/population-evaluation.js';
import { createInitialPopulation, sampleInitialGenotype } from '../src/sim/population-initializer.js';
import {
  DISCRETE_GENE_KEYS, compileAssembly, repairGenotype, serializeGenotype,
} from '../src/sim/assembly.js';
import { Rng } from '../src/sim/prng.js';
import { fnv1aHex } from '../src/sim/fnv1a.js';
import {
  EXPLOSION_WITNESSES, MINIMAL_REPRODUCER, WITNESS_SPEC, WITNESS_TERRAIN,
  reproducerGenotype, witnessGenotype,
} from './explosion-witnesses.js';
import {
  FIXTURE_A, FIXTURE_B, FIXTURE_C, FIXTURE_D, evaluationOptionsFor,
} from '../src/sim/evaluation-fixtures.js';

export const PROBE_SCHEMA = 'boxcar3d.probe-integrity/1';

// The declared clean controls (the PR #17 calibration procedure's selected
// min/median/max-fitness alert-free members of population 20260725, witness
// ids excluded) — COPY-DECLARED ids, reproducible from the seed.
const CONTROL_POPULATION_SEED = 20260725;
const CONTROL_IDS = Object.freeze([13, 15, 16]);

// The mutation-neighborhood parents (declared identities):
//   control  — 20260725:13 (the max-fitness clean calibration control),
//   witness  — 20260725:19 (witness A, catastrophic on 0.19.3),
//   champion — 20260721:10 (the committed Phase-1A champion).
const NEIGHBORHOOD_SEED = 20260731; // allocated for this probe's jitter draws
const NEIGHBORHOOD_PARENTS = Object.freeze([
  Object.freeze({ role: 'control', populationSeed: 20260725, individualId: 13 }),
  Object.freeze({ role: 'witness', populationSeed: 20260725, individualId: 19 }),
  Object.freeze({ role: 'champion', populationSeed: 20260721, individualId: 10 }),
]);

const IMPLEMENTED_PASSES = Object.freeze(['signals', 'population', 'neighborhood', 'cost']);

export function smokeConfig() {
  return {
    passes: ['signals', 'population', 'neighborhood', 'cost'],
    signalSubjects: ['fixtureA', 'reproducer', 'witness:A', 'control:13'],
    populationSeeds: [20260725],
    neighborhoodParents: ['control'],
    neighborhoodMagnitudes: [0.05],
    childrenPerParent: 3,
    costPairs: 2,
    costSteps: 150,
    argv: [],
  };
}

export function defaultConfig() {
  return {
    passes: ['signals', 'population', 'neighborhood', 'cost'],
    signalSubjects: null, // null = the full declared panel
    populationSeeds: [20260725, 20260728, 20260729],
    neighborhoodParents: ['control', 'witness', 'champion'],
    neighborhoodMagnitudes: [0.01, 0.05],
    childrenPerParent: 8, // SMALL by policy; the big sweep is Phase 1B's experiment
    costPairs: 5,
    costSteps: 600,
    argv: [],
  };
}

const deepClone = (o) => JSON.parse(JSON.stringify(o));
const digestOf = (g) => fnv1aHex(serializeGenotype(g));
const exp3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? x.toExponential(3) : String(x));

function selectPasses(selector) {
  const entries = Array.isArray(selector) ? selector : [selector];
  const list = [...new Set(entries.flatMap((p) => (p === 'all' ? [...IMPLEMENTED_PASSES] : String(p).split(','))))];
  for (const p of list) {
    if (!IMPLEMENTED_PASSES.includes(p)) {
      throw new Error(`probe-integrity: unknown pass '${p}' (${IMPLEMENTED_PASSES.join('/')} or all)`);
    }
  }
  return list;
}

// A characterization member's canonical genotype — the exact production
// recipe (the witnessGenotype path, without the witness-table lookup).
function memberGenotype(populationSeed, individualId) {
  const raw = sampleInitialGenotype(new Rng(populationSeed).fork(individualId), {});
  return compileAssembly(raw).genotype;
}

// One deterministic full-trace evaluation under the characterization identity.
async function evaluateSubject(ir, { terrainOverrides = {}, maxSteps = WITNESS_SPEC.maxSteps } = {}) {
  const spawn = spawnPoseOnFlatStart(ir, { ...WITNESS_SPEC.spawn });
  return runEvaluation({
    deterministic: true,
    terrain: { ...WITNESS_TERRAIN, ...terrainOverrides },
    vehicles: [{
      ir, spawn,
      targetWheelSurfaceSpeed: WITNESS_SPEC.targetWheelSurfaceSpeed,
      wheelFriction: WITNESS_SPEC.wheelFriction,
    }],
    maxSteps,
    termination: 'maxSteps',
    trace: { mode: 'full', checkpointInterval: 1 },
  });
}

// The offline (analyzeTrace) view mapped onto the online contract's fields via
// the SHARED projection (trace-forensics.offlineIntegrityView) — the same
// function tests/integrity.test.js consumes, so the mapping cannot drift.
function offlineView(traceResult, ir, captureDt) {
  return offlineIntegrityView(analyzeTrace(traceResult, { bodies: bodyReachMetadataForIR(ir), captureDt }));
}

// FULL agreement: the derived offline CLASSIFICATION (status / firstFailureStep
// / reasons, in order) AND every shared observation, bitwise. The offline-only
// firstNonFiniteStep has no online counterpart and is not compared.
function onlineOfflineAgree(online, offline) {
  return online.status === offline.status
    && online.firstFailureStep === offline.firstFailureStep
    && online.reasons.length === offline.reasons.length
    && online.reasons.every((code, i) => code === offline.reasons[i])
    && Object.is(online.observations.peakBodySpeed, offline.observations.peakBodySpeed)
    && Object.is(online.observations.peakSpeedDelta, offline.observations.peakSpeedDelta)
    && Object.is(online.observations.peakStepDisplacement, offline.observations.peakStepDisplacement)
    && online.observations.firstAlertStep === offline.observations.firstAlertStep
    && online.observations.firstCatastrophicStep === offline.observations.firstCatastrophicStep;
}

// --- signals pass ---------------------------------------------------------------

function signalSubjectTable() {
  const subjects = [];
  for (const w of EXPLOSION_WITNESSES) {
    subjects.push({
      key: `witness:${w.label}`,
      kind: 'witness',
      build: () => ({ genotype: witnessGenotype(w.populationSeed, w.individualId), expectedDigest: w.genotypeDigest }),
    });
  }
  subjects.push({
    key: 'reproducer',
    kind: 'reproducer',
    build: () => ({
      genotype: reproducerGenotype(),
      expectedDigest: MINIMAL_REPRODUCER.genotypeDigest,
      terrainOverrides: { ...MINIMAL_REPRODUCER.terrainOverrides },
    }),
  });
  for (const id of CONTROL_IDS) {
    subjects.push({
      key: `control:${id}`,
      kind: 'control',
      build: () => ({ genotype: memberGenotype(CONTROL_POPULATION_SEED, id), expectedDigest: null }),
    });
  }
  for (const [key, fx] of [['fixtureA', FIXTURE_A], ['fixtureB', FIXTURE_B], ['fixtureC', FIXTURE_C], ['fixtureD', FIXTURE_D]]) {
    subjects.push({ key, kind: 'fixture', fixture: fx });
  }
  return subjects;
}

async function signalsPass(cfg, check) {
  const wanted = cfg.signalSubjects === null ? null : new Set(cfg.signalSubjects);
  const rows = [];
  for (const s of signalSubjectTable()) {
    if (wanted !== null && !wanted.has(s.key)) continue;
    let r;
    let ir;
    if (s.kind === 'fixture') {
      ir = compileAssembly(s.fixture.buildGenotype());
      r = await runEvaluation({
        ...evaluationOptionsFor(s.fixture, { deterministic: true, trace: { mode: 'full', checkpointInterval: 1 } }),
      });
    } else {
      const { genotype, expectedDigest, terrainOverrides = {} } = s.build();
      const digest = digestOf(genotype);
      if (expectedDigest !== null) {
        check(`identity:${s.key}`, digest === expectedDigest, `expected ${expectedDigest}, got ${digest}`);
      }
      ir = compileAssembly(genotype);
      r = await evaluateSubject(ir, { terrainOverrides });
    }
    const v = r.vehicles[0];
    const online = v.integrity;
    const offline = offlineView(r.trace, ir, r.effectiveDt);
    check(`agreement:${s.key}`, onlineOfflineAgree(online, offline),
      'online classification (status/firstFailureStep/reasons) and every shared observation must agree bitwise with the offline derivation over the same run');
    rows.push({
      subject: s.key,
      kind: s.kind,
      status: online.status,
      firstFailureStep: online.firstFailureStep,
      reasons: [...online.reasons],
      firstAlertStep: online.observations.firstAlertStep,
      firstCatastrophicStep: online.observations.firstCatastrophicStep,
      peakBodySpeed: online.observations.peakBodySpeed,
      peakSpeedDelta: online.observations.peakSpeedDelta,
      peakStepDisplacement: online.observations.peakStepDisplacement,
      maxForwardDistance: v.maxForwardDistance,
      valid: isVehicleResultValid(v),
      selectable: isVehicleResultSelectable(v),
      fitness: fitnessFromVehicleResult(v),
    });
  }
  // Which predicates contribute (reason attribution over the panel).
  const reasonCounts = {};
  for (const row of rows) {
    for (const reason of row.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  return { rows, reasonCounts };
}

// --- population pass --------------------------------------------------------------

async function populationPass(cfg) {
  const perSeed = [];
  for (const seed of cfg.populationSeeds) {
    const { population } = createInitialPopulation({ seed, populationSize: 20 });
    const ev = await evaluatePopulation(population, {
      deterministic: true,
      terrain: { ...WITNESS_TERRAIN },
      maxSteps: WITNESS_SPEC.maxSteps,
      spawn: { ...WITNESS_SPEC.spawn },
      targetWheelSurfaceSpeed: WITNESS_SPEC.targetWheelSurfaceSpeed,
      wheelFriction: WITNESS_SPEC.wheelFriction,
    });
    const members = ev.individuals.map((ind) => ({
      individualId: ind.individualId,
      status: ind.integrityStatus,
      valid: ind.valid,
      fitness: ind.fitness,
      maxForwardDistance: ind.diagnostics.maxForwardDistance,
      firstAlertStep: ind.diagnostics.integrity.observations.firstAlertStep,
      firstCatastrophicStep: ind.diagnostics.integrity.observations.firstCatastrophicStep,
      peakBodySpeed: ind.diagnostics.integrity.observations.peakBodySpeed,
    }));
    const statusCounts = {};
    for (const m of members) statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
    const fitnesses = members.map((m) => m.fitness).sort((a, b) => a - b);
    const median = fitnesses[Math.floor(fitnesses.length / 2)];
    // The false-negative WATCH LIST (the design record's acceptance gate):
    // status ok, alert observation fired — did any gain selection-relevant
    // progress from sub-catastrophic runaway?
    const alertButOk = members.filter((m) => m.status === 'ok' && m.firstAlertStep !== null)
      .map((m) => ({ ...m, fitnessVsMedian: median > 0 ? m.fitness / median : null }));
    perSeed.push({
      populationSeed: seed,
      statusCounts,
      medianFitness: median,
      failedIds: members.filter((m) => m.status !== 'ok').map((m) => m.individualId),
      alertButOk,
      members,
    });
  }
  return perSeed;
}

// --- neighborhood pass -------------------------------------------------------------

// Deterministic PARAMETRIC jitter of the CONTINUOUS [0,1] gene leaves
// (sorted-key walk). Preserved VERBATIM: the `version` integer and every
// declared discrete-decode gene (assembly.DISCRETE_GENE_KEYS — enum band /
// boolean threshold / slot count). The policy: this instrument measures the
// local CONTINUOUS neighborhood of a parent, so a decode-boundary crossing —
// a STRUCTURAL mutation (spec §3.1.3), a different operator with its own
// rates — must never ride in on jitter noise; concretely, a `suspType`
// crossing into the S2 band compiles to a legal IR the realizer rejects
// pre-world, which would abort the whole neighborhood experiment. (S2 is
// never clamped or masked — it simply cannot be REACHED by a parametric
// walk.) Draw order is the walk order over PERTURBED leaves only, one
// uniform per perturbed leaf, so a (seed, streamId) pair fully determines a
// child. Exported for the boundary regression test.
export function jitterGenotype(genotype, magnitude, rng) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === 'object' && node !== null) {
      const out = {};
      for (const k of Object.keys(node).sort()) {
        out[k] = k === 'version' || DISCRETE_GENE_KEYS.includes(k) ? node[k] : walk(node[k]);
      }
      return out;
    }
    if (typeof node === 'number') {
      const v = node + (rng.nextFloat() * 2 - 1) * magnitude;
      return v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    return node;
  };
  return walk(deepClone(genotype));
}

// Count how many gene leaves repair changed (the repair-crossing signal).
function leafDeltaCount(a, b) {
  let count = 0;
  const walk = (x, y) => {
    if (Array.isArray(x)) { x.forEach((v, i) => walk(v, y[i])); return; }
    if (typeof x === 'object' && x !== null) {
      for (const k of Object.keys(x)) walk(x[k], y[k]);
      return;
    }
    if (typeof x === 'number' && !Object.is(x, y)) count += 1;
  };
  walk(a, b);
  return count;
}

async function neighborhoodPass(cfg) {
  const parents = NEIGHBORHOOD_PARENTS.filter((p) => cfg.neighborhoodParents.includes(p.role));
  const rows = [];
  let childStream = 0;
  for (const parent of parents) {
    const parentGenotype = memberGenotype(parent.populationSeed, parent.individualId);
    const parentIr = compileAssembly(parentGenotype);
    const parentRun = await evaluateSubject(parentIr, { maxSteps: WITNESS_SPEC.maxSteps });
    const parentV = parentRun.vehicles[0];
    for (const magnitude of cfg.neighborhoodMagnitudes) {
      const children = [];
      for (let c = 0; c < cfg.childrenPerParent; c += 1) {
        const rng = new Rng(NEIGHBORHOOD_SEED).fork(childStream);
        childStream += 1;
        const mutated = jitterGenotype(parentGenotype, magnitude, rng);
        const repaired = repairGenotype(mutated);
        const ir = compileAssembly(repaired);
        const spawn = spawnPoseOnFlatStart(ir, { ...WITNESS_SPEC.spawn });
        const r = await runEvaluation({
          deterministic: true,
          terrain: { ...WITNESS_TERRAIN },
          vehicles: [{
            ir, spawn,
            targetWheelSurfaceSpeed: WITNESS_SPEC.targetWheelSurfaceSpeed,
            wheelFriction: WITNESS_SPEC.wheelFriction,
          }],
          maxSteps: WITNESS_SPEC.maxSteps,
          termination: 'maxSteps',
          trace: { mode: 'none' }, // the production path — online detector only
        });
        const v = r.vehicles[0];
        children.push({
          childIndex: c,
          genotypeDigest: digestOf(repaired),
          repairTouchedLeaves: leafDeltaCount(mutated, repaired),
          status: v.integrity.status,
          firstAlertStep: v.integrity.observations.firstAlertStep,
          peakBodySpeed: v.integrity.observations.peakBodySpeed,
          maxForwardDistance: v.maxForwardDistance,
          fitness: fitnessFromVehicleResult(v),
        });
      }
      const failed = children.filter((c) => c.status !== 'ok');
      const alertButOk = children.filter((c) => c.status === 'ok' && c.firstAlertStep !== null);
      rows.push({
        parent: parent.role,
        parentIdentity: `${parent.populationSeed}:${parent.individualId}`,
        parentStatus: parentV.integrity.status,
        parentFitness: fitnessFromVehicleResult(parentV),
        magnitude,
        children: children.length,
        failedCount: failed.length,
        failedChildren: failed.map((c) => ({
          childIndex: c.childIndex, status: c.status, peakBodySpeed: c.peakBodySpeed, maxForwardDistance: c.maxForwardDistance,
        })),
        alertButOkCount: alertButOk.length,
        meanRepairTouchedLeaves: children.reduce((s, c) => s + c.repairTouchedLeaves, 0) / children.length,
        childRows: children,
      });
    }
  }
  return rows;
}

// --- cost pass ----------------------------------------------------------------------

// One composed core-loop run (the ONLY seam with an off arm), fixture A on
// its own flat declared terrain, trace 'none' so the integrity fold is the
// only difference between arms. Returns wall-clock ms for the loop call.
async function costArm(ir, spawn, integrity, steps) {
  const { RAPIER, world } = await createPhysics({ deterministic: true });
  try {
    const terrain = generateCorridorTerrain({ ...FIXTURE_A.terrainConfig });
    if (terrain.features.length > 0) {
      addCorridorWithFeatures(RAPIER, world, terrain);
    } else {
      addCorridor(RAPIER, world, terrain);
      world.step();
    }
    const staticColliders = world.colliders.len();
    const realized = [realizeVehicle(RAPIER, world, ir, {
      position: spawn.position, targetWheelSurfaceSpeed: 5, wheelFriction: 1,
    })];
    const t0 = performance.now();
    runRealizedEvaluationLoop(world, realized, {
      requestedDt: FIXED_DT, maxSteps: steps, traceMode: 'none', staticColliders, integrity,
    });
    return performance.now() - t0;
  } finally {
    world.free();
  }
}

async function costPass(cfg) {
  const ir = compileAssembly(FIXTURE_A.buildGenotype());
  const spawn = spawnPoseOnFlatStart(ir, { x: -44, z: 0 });
  // Warm-up (discarded): the first stepped world in a module carries a
  // measured ~1.5 ms warm-up spike.
  await costArm(ir, spawn, true, Math.min(cfg.costSteps, 60));
  const pairs = [];
  for (let s = 0; s < cfg.costPairs; s += 1) {
    const order = s % 2 === 0 ? [true, false] : [false, true];
    const ms = {};
    for (const integrity of order) {
      ms[integrity ? 'on' : 'off'] = await costArm(ir, spawn, integrity, cfg.costSteps);
    }
    pairs.push({ onMs: ms.on, offMs: ms.off, ratio: ms.on / ms.off });
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return {
    steps: cfg.costSteps,
    pairs,
    medianOnMs: med(pairs.map((p) => p.onMs)),
    medianOffMs: med(pairs.map((p) => p.offMs)),
    ratioMedian: med(pairs.map((p) => p.ratio)),
    note: 'machine-specific observation, never a threshold; arms differ ONLY in the integrity fold (trace none, core-loop seam)',
  };
}

// --- entry --------------------------------------------------------------------------

export async function runIntegrityProbe(config) {
  const cfg = { ...defaultConfig(), ...config };
  const passes = selectPasses(cfg.passes);
  const report = {
    schema: PROBE_SCHEMA,
    argv: cfg.argv ?? [],
    passes,
    policy: {
      integrityPolicyVersion: INTEGRITY_POLICY_VERSION,
      thresholds: { ...INTEGRITY_THRESHOLDS },
    },
    engine: { rapierVersion: null, deterministic: true, effectiveDt: null },
    checks: [],
    signals: null,
    population: null,
    neighborhood: null,
    cost: null,
  };
  const check = (name, ok, detail) => report.checks.push({ name, ok: ok === true, detail });
  {
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    report.engine.rapierVersion = RAPIER.version();
    world.timestep = FIXED_DT;
    report.engine.effectiveDt = world.timestep;
    check('dt:f32-readback', report.engine.effectiveDt === Math.fround(FIXED_DT),
      `readback ${report.engine.effectiveDt}`);
    world.free();
  }
  if (passes.includes('signals')) report.signals = await signalsPass(cfg, check);
  if (passes.includes('population')) report.population = await populationPass(cfg);
  if (passes.includes('neighborhood')) report.neighborhood = await neighborhoodPass(cfg);
  if (passes.includes('cost')) report.cost = await costPass(cfg);
  return report;
}

// --- markdown -----------------------------------------------------------------------

export function renderMarkdown(report) {
  const L = [];
  const table = (header, rows) => {
    L.push(`| ${header.join(' | ')} |`);
    L.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const r of rows) L.push(`| ${r.join(' | ')} |`);
    L.push('');
  };
  L.push('# Numerical-integrity probe');
  L.push('');
  L.push(`Schema \`${report.schema}\` — integrity policy v${report.policy.integrityPolicyVersion}, `
    + `rapier ${report.engine.rapierVersion}, deterministic flavor, effectiveDt ${report.engine.effectiveDt}. `
    + 'Every status/magnitude below is an OBSERVATION; hard checks are identity/agreement/dt only.');
  L.push('');
  L.push('## Checks');
  L.push('');
  table(['check', 'ok', 'detail'],
    report.checks.map((c) => [c.name, c.ok ? 'OK' : '**FAIL**', c.detail ?? '']));
  if (report.signals !== null) {
    L.push('## Signals (known-subject panel; online ≡ offline agreement hard-checked per row)');
    L.push('');
    table(
      ['subject', 'status', 'reasons', 'alert@', 'cat@', 'peak body (m/s)', 'maxFwd (m)', 'selectable', 'fitness'],
      report.signals.rows.map((r) => [
        r.subject, r.status, r.reasons.join('+') || '-',
        String(r.firstAlertStep), String(r.firstCatastrophicStep),
        exp3(r.peakBodySpeed), exp3(r.maxForwardDistance),
        String(r.selectable), exp3(r.fitness),
      ]),
    );
    L.push(`Reason attribution over the panel: ${JSON.stringify(report.signals.reasonCounts)}`);
    L.push('');
  }
  if (report.population !== null) {
    L.push('## Population (production path, per committed seed)');
    L.push('');
    table(
      ['seed', 'status counts', 'failed ids', 'median fitness (m)', 'alert-but-ok (the false-negative watch list)'],
      report.population.map((p) => [
        String(p.populationSeed),
        JSON.stringify(p.statusCounts),
        p.failedIds.join(', ') || '-',
        exp3(p.medianFitness),
        p.alertButOk.length === 0 ? 'none'
          : p.alertButOk.map((m) => `id ${m.individualId} (fitness ${exp3(m.fitness)}, ${m.fitnessVsMedian === null ? '-' : m.fitnessVsMedian.toFixed(1)}x median)`).join('; '),
      ]),
    );
  }
  if (report.neighborhood !== null) {
    L.push('## Mutation neighborhood (deterministic jitter, seed 20260731 — the SMALL pass; the full sweep is Phase 1B\'s experiment)');
    L.push('');
    table(
      ['parent', 'parent status', 'magnitude', 'children', 'failed', 'alert-but-ok', 'mean repair-touched leaves'],
      report.neighborhood.map((r) => [
        `${r.parent} (${r.parentIdentity})`, r.parentStatus, String(r.magnitude),
        String(r.children), String(r.failedCount), String(r.alertButOkCount),
        r.meanRepairTouchedLeaves.toFixed(1),
      ]),
    );
  }
  if (report.cost !== null) {
    L.push('## Cost (paired interleaved, integrity on vs off at the core-loop seam)');
    L.push('');
    L.push(`${report.cost.pairs.length} pairs x ${report.cost.steps} steps: median on ${report.cost.medianOnMs.toFixed(2)} ms, `
      + `median off ${report.cost.medianOffMs.toFixed(2)} ms, median per-pair ratio ${report.cost.ratioMedian.toFixed(4)}.`);
    L.push('');
    L.push(`_${report.cost.note}_`);
    L.push('');
  }
  return L.join('\n');
}

// --- CLI ----------------------------------------------------------------------------

const isCli = (() => {
  if (typeof process === 'undefined' || !process.argv || process.argv.length < 2) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  const { values } = parseArgs({
    options: {
      smoke: { type: 'boolean', default: false },
      pass: { type: 'string' },
      json: { type: 'string' },
    },
  });
  const cfg = values.smoke ? smokeConfig() : defaultConfig();
  if (values.pass !== undefined) cfg.passes = [values.pass];
  cfg.argv = process.argv.slice(2);
  const report = await runIntegrityProbe(cfg);
  console.log(renderMarkdown(report));
  if (values.json !== undefined) {
    writeFileSync(values.json, JSON.stringify(report, null, 2));
    console.log(`\nJSON written to ${values.json}`);
  }
  const failed = report.checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} hard check(s) FAILED: ${failed.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }
}
