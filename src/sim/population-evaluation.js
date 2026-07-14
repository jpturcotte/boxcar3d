// Deterministic population evaluation: canonical population content in,
// exact per-individual fitness out, with versioned byte encodings for the
// resolved evaluation identity and the fitness vector.
//
// WORLD-MODE RULING (measured 2026-07-12, deterministic flavor, rapier
// 0.19.3 — the cohort-invariance probe, recorded in full in the Phase-1A
// report): shared-world ghost evaluation is NOT invariant under cohort
// composition. A zero-axle sled's trajectory diverges at the f64 bit level
// (first at its initial contact solve, step 3; ~1e-4 m by step ~100)
// depending on which OTHER vehicles share the world and in which order —
// even when the neighbor is AIRBORNE for 50+ steps (zero contacts) or
// spatially separated (no AABB overlap), and in a composition- and
// order-dependent pattern with no monotone rule (sled+heavy identical but
// heavy+sled diverges; sled+s0 diverges but sled+s0+heavy identical). Every
// wheeled member measured bit-identical in every tested composition, and the
// fixture-A identical-ghost lock still holds — but those are rounding
// coincidences absent an engine contract, not a guarantee, and evolved
// phenotypes flip, crash, and rest on their chassis. Therefore:
//
//   POPULATION_WORLD_MODE = 'isolatedWorlds' — one world per individual.
//
// An individual's exact result depends only on its own genotype and the
// declared evaluation spec, by construction. The shared-world divergence is
// a recorded finding, NEVER a permanent must-still-diverge assertion (an
// engine that gets better must not fail CI); a shared-world invariance
// recheck probe rides in scripts/characterize-population.js for deliberate
// re-runs on engine upgrades.
//
// FITNESS RULING (FITNESS_POLICY_VERSION 2 — the numerical-integrity gate):
//   selectable = isVehicleResultValid(v) && v.integrity.status === 'ok'
//   fitness    = maxForwardDistance   when selectable
//              = 0                    otherwise
// v2 composes the UNCHANGED narrow validity predicate (finite && bodies &&
// joints — isVehicleResultValid keeps meaning exactly what it meant) with the
// integrity policy v1 classification (src/sim/integrity.js): solver
// divergence reaches enormous-but-FINITE internal speeds that validity never
// sees, and two of the five known generation-0 cases hide behind
// ordinary-looking forward distance — so integrity failure must be
// non-selectable REGARDLESS of the distance scored. Raw task metrics stay
// observable in diagnostics (never silently zeroed); the integrity block
// itself rides along in full. Maximum progress includes capture 0, so a
// selectable reverse-only vehicle scores 0 (never negative). Still NO drift
// subtraction, mass division, efficiency reward, wheel-count penalty,
// complexity bonus, terrain normalization, or multiobjective scoring.
//
// CHAMPION ELIGIBILITY (v2): selection consumes selectableChampionFromEvaluation,
// which returns the best SELECTABLE individual or null when none exists — an
// integrity-failed individual must never become the evolutionary champion
// merely because every fitness is zero. championFromEvaluation stays as the
// DIAGNOSTIC best-observed selector (reports, never selection or elitism).
//
// EVALUATION-SPEC ENCODING v1 (EVALUATION_SPEC_VERSION; explicit little-
// endian walk): the SELF-CONTAINED evaluation identity. Two evaluations
// sharing a terrain seed but differing in ANY resolved knob get different
// spec digests — the encoding never leans on an external fixture version:
//   u16 specVersion | u8 deterministic | u8 termination enum (0='maxSteps')
//   u32 maxSteps | f64 spawnX | f64 spawnZ | f64 spawnClearance
//   f64 targetWheelSurfaceSpeed | f64 wheelFriction (bound even when
//   defaulted) | u8 terrainKeyCount | the RESOLVED terrain walk:
//   TERRAIN_SPEC_WALK order (asserted set-equal to Object.keys(
//   TERRAIN_DEFAULTS) at encode time — a new terrain knob fails loud here
//   until declared, the terrain.test.js sweep precedent): seed as u32;
//   scalars as f64; ranges as u8 length + f64s; featureTypeWeights as
//   u8 count + (u8 declared-type index + f64) in WEIGHT_KEYS order.
//
// FITNESS-VECTOR ENCODING v2 (FITNESS_VECTOR_VERSION): binds the SNAPSHOT
// digest (content identity — never the initialization manifest), the spec
// digest, AND the integrity policy version, then per individual in
// ascending-individualId order the exact f64 fitness with an explicit
// validity byte and an integrity-status byte (an integrity-failed 0 is never
// indistinguishable from a merely-poor valid 0). Engine identity is
// deliberately NOT in the vector — it is a lock-layer attestation, and a
// source-built engine can truthfully misreport its version string:
//   u16 fitnessVectorVersion | u16 fitnessPolicyVersion
//   u16 integrityPolicyVersion | u16 snapshotVersion
//   u32 populationSnapshotDigestState | u16 evaluationSpecVersion
//   u32 evaluationSpecDigestState | u32 count
//   per individual: u32 individualId | u8 validity
//                 | u8 integrityStatus (INTEGRITY_STATUS index) | f64 fitness

import { runEvaluation } from './evaluation.js';
import { TERRAIN_DEFAULTS } from './terrain.js';
import {
  ASSEMBLY_IR_VERSION, compileAssembly,
} from './assembly.js';
import {
  MOTOR_TARGET_WHEEL_SURFACE_SPEED, WHEEL_FRICTION, vehicleWheelTransforms,
} from './physics/adapter.js';
import { POPULATION_SNAPSHOT_VERSION, serializePopulationSnapshot, validatePopulation } from './population.js';
import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHexOf } from './fnv1a.js';
import { INTEGRITY_POLICY_VERSION, INTEGRITY_STATUS } from './integrity.js';

export const FITNESS_POLICY_VERSION = 2; // v2: the numerical-integrity gate (see the ruling above)
export const FITNESS_VECTOR_VERSION = 2; // v2: +integrityPolicyVersion header, +integrityStatus byte
export const EVALUATION_SPEC_VERSION = 1;
export const POPULATION_WORLD_MODE = 'isolatedWorlds'; // see the world-mode ruling above
export const REALIZABLE_SUSPENSION_TYPES = Object.freeze(['S0', 'S1']); // engine capability, not policy
export const SPAWN_CLEARANCE = 0.02; // m — inside the fixtures' (0, 0.05] coherence band

// Spawn x must keep the whole vehicle on the exactly-flat pad: max frame
// half-span 2.5 m + max wheel radius 0.7 m < 4 m of margin.
const SPAWN_PAD_MARGIN = 4;

const TERMINATIONS = Object.freeze(['maxSteps']);

function fail(path, value) {
  throw new Error(`population-evaluation: invalid evaluation spec at ${path} (${String(value)})`);
}

// --- Fitness policy (pure) ---------------------------------------------------

export function isVehicleResultValid(vehicleResult) {
  return vehicleResult.finite === true
    && vehicleResult.bodies.allValid === true
    && vehicleResult.joints.allValid === true;
}

// The integrity block is MANDATORY on every result the fitness policy
// consumes (the runner emits it unconditionally on every production path; the
// core-loop diagnostic off-arm yields integrity: null, which this policy
// refuses — a fitness computed while the detector was off would be a
// different, unversioned policy).
function requireIntegrity(vehicleResult) {
  const block = vehicleResult.integrity;
  if (typeof block !== 'object' || block === null
    || block.policyVersion !== INTEGRITY_POLICY_VERSION
    || !INTEGRITY_STATUS.includes(block.status)) {
    fail('vehicleResult.integrity', block === null || block === undefined
      ? `${String(block)} (fitness policy v${FITNESS_POLICY_VERSION} requires the integrity block — was the detector disabled?)`
      : `policyVersion ${block.policyVersion}, status ${String(block.status)}`);
  }
  return block;
}

/**
 * The v2 eligibility predicate: valid (the unchanged narrow body/joint/finite
 * contract) AND integrity-clean. Distinct from isVehicleResultValid by
 * design — validity means "the physical result is well-formed evidence";
 * selectable means "that evidence may compete for selection".
 */
export function isVehicleResultSelectable(vehicleResult) {
  return isVehicleResultValid(vehicleResult)
    && requireIntegrity(vehicleResult).status === 'ok';
}

export function fitnessFromVehicleResult(vehicleResult) {
  return isVehicleResultSelectable(vehicleResult) ? vehicleResult.maxForwardDistance : 0;
}

// --- Spawn placement (pure) --------------------------------------------------

/**
 * Spawn pose for an IR dropped onto the EXACTLY-FLAT start pad (elevation 0
 * by the startEnvelope contract — the name states the assumption). The
 * lowest support is either a wheel bottom (center − radius, with the S1
 * quiescent extension included via vehicleWheelTransforms) or, for a
 * zero-wheel sled, the chassis AABB bottom; R2 guarantees wheels win
 * whenever they exist. y = drop + clearance puts the lowest support exactly
 * `clearance` above the pad — the fixtures' (0, 0.05] coherence band.
 */
export function spawnPoseOnFlatStart(ir, { x, z, clearance = SPAWN_CLEARANCE } = {}) {
  if (!ir || ir.version !== ASSEMBLY_IR_VERSION) fail('ir.version', ir && ir.version);
  if (!Number.isFinite(x)) fail('spawn.x', x);
  if (!Number.isFinite(z)) fail('spawn.z', z);
  if (!Number.isFinite(clearance) || clearance <= 0 || clearance > 0.05) fail('spawn.clearance', clearance);
  let drop = -ir.chassis.aabb.min.y; // sled fallback: belly bottom
  for (const t of vehicleWheelTransforms(ir, {})) {
    const wheel = ir.axles[t.axleIndex].wheels[t.wheelIndex];
    drop = Math.max(drop, wheel.radius - t.local.y);
  }
  return { position: { x, y: drop + clearance, z } };
}

// --- Evaluation-spec resolution + encoding -----------------------------------

const SPEC_KEYS = Object.freeze([
  'terrain', 'maxSteps', 'deterministic', 'spawn', 'targetWheelSurfaceSpeed', 'wheelFriction', 'hooks',
]);
const SPAWN_SPEC_KEYS = Object.freeze(['x', 'z', 'clearance']);
const HOOK_KEYS = Object.freeze(['onIndividual']);

// The declared terrain walk — kind per key. Asserted set-equal to
// Object.keys(TERRAIN_DEFAULTS) at encode time so a new knob fails loud
// until it declares its wire type here.
const TERRAIN_SPEC_WALK = Object.freeze([
  ['seed', 'uint32'],
  ['length', 'f64'],
  ['width', 'f64'],
  ['cellSize', 'f64'],
  ['startFlatLength', 'f64'],
  ['startBlendLength', 'f64'],
  ['macroAmp', 'f64'],
  ['macroFrequency', 'f64'],
  ['macroOctaves', 'f64'],
  ['microAmp', 'f64'],
  ['microFrequency', 'f64'],
  ['microOctaves', 'f64'],
  ['wallClearance', 'f64'],
  ['wallEmbed', 'f64'],
  ['wallThickness', 'f64'],
  ['wallRestitution', 'f64'],
  ['wallFriction', 'f64'],
  ['floorFriction', 'f64'],
  ['craterDensity', 'f64'],
  ['craterRadiusRange', 'range'],
  ['craterDepthRatioRange', 'range'],
  ['zoneFrequency', 'f64'],
  ['zoneOctaves', 'f64'],
  ['sandCoverage', 'f64'],
  ['mudCoverage', 'f64'],
  ['featureDensity', 'f64'],
  ['featureTypeWeights', 'weights'],
  ['boulderRadiusRange', 'range'],
  ['rampLengthRange', 'range'],
  ['rampWidthRange', 'range'],
  ['rampHeightRange', 'range'],
  ['logRadiusRange', 'range'],
  ['logLengthRange', 'range'],
]);
const WEIGHT_KEYS = Object.freeze(['boulder', 'ramp', 'log']);

function resolveSpec(spec) {
  if (typeof spec !== 'object' || spec === null) fail('spec', spec);
  for (const k of Object.keys(spec)) {
    if (!SPEC_KEYS.includes(k)) fail(k, 'unknown key');
  }
  const {
    terrain, maxSteps, deterministic = false,
    spawn, targetWheelSurfaceSpeed = MOTOR_TARGET_WHEEL_SURFACE_SPEED,
    wheelFriction = WHEEL_FRICTION, hooks = {},
  } = spec;
  if (typeof terrain !== 'object' || terrain === null) fail('terrain', terrain);
  if (!Object.prototype.hasOwnProperty.call(terrain, 'seed')) {
    fail('terrain.seed', 'missing (a fitness vector must never bind the default seed by accident)');
  }
  for (const k of Object.keys(terrain)) {
    if (!Object.prototype.hasOwnProperty.call(TERRAIN_DEFAULTS, k)) fail(`terrain.${k}`, 'unknown key');
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 0xffffffff) fail('maxSteps', maxSteps);
  if (typeof deterministic !== 'boolean') fail('deterministic', deterministic);
  if (typeof spawn !== 'object' || spawn === null) fail('spawn', spawn);
  for (const k of Object.keys(spawn)) {
    if (!SPAWN_SPEC_KEYS.includes(k)) fail(`spawn.${k}`, 'unknown key');
  }
  const clearance = spawn.clearance ?? SPAWN_CLEARANCE;
  if (!Number.isFinite(spawn.x)) fail('spawn.x', spawn.x);
  if (!Number.isFinite(spawn.z)) fail('spawn.z', spawn.z);
  if (!Number.isFinite(clearance) || clearance <= 0 || clearance > 0.05) fail('spawn.clearance', clearance);
  if (!Number.isFinite(targetWheelSurfaceSpeed)) fail('targetWheelSurfaceSpeed', targetWheelSurfaceSpeed);
  if (!Number.isFinite(wheelFriction) || wheelFriction < 0) fail('wheelFriction', wheelFriction);
  if (typeof hooks !== 'object' || hooks === null) fail('hooks', hooks);
  for (const k of Object.keys(hooks)) {
    if (!HOOK_KEYS.includes(k)) fail(`hooks.${k}`, 'unknown key');
  }
  if (hooks.onIndividual !== undefined && typeof hooks.onIndividual !== 'function') {
    fail('hooks.onIndividual', hooks.onIndividual);
  }
  const resolvedTerrain = ownTerrain({ ...TERRAIN_DEFAULTS, ...terrain });
  // The flat-pad guard: the whole vehicle must sit on exactly-flat ground.
  const padStart = -resolvedTerrain.length / 2;
  const padEnd = padStart + resolvedTerrain.startFlatLength;
  if (spawn.x - SPAWN_PAD_MARGIN < padStart || spawn.x + SPAWN_PAD_MARGIN > padEnd) {
    fail('spawn.x', `${spawn.x} must sit >= ${SPAWN_PAD_MARGIN} m inside the flat pad [${padStart}, ${padEnd}]`);
  }
  return {
    deterministic,
    termination: 'maxSteps',
    maxSteps,
    spawn: { x: spawn.x, z: spawn.z, clearance },
    targetWheelSurfaceSpeed,
    wheelFriction,
    terrain: resolvedTerrain,
    onIndividual: hooks.onIndividual ?? null,
  };
}

// Deep-copy every array / nested object of a resolved terrain and deep-freeze
// the result, so the evaluator EXCLUSIVELY owns it. A hook or a concurrent
// caller mutating the input's nested `craterRadiusRange` array or
// `featureTypeWeights` object cannot then change what a later individual runs
// on (the shallow `{...TERRAIN_DEFAULTS, ...terrain}` merge shares those
// references), and the serialized evaluation spec binds exactly what ran.
function ownTerrain(terrain) {
  const out = {};
  for (const [k, v] of Object.entries(terrain)) {
    if (Array.isArray(v)) {
      out[k] = Object.freeze(v.slice());
    } else if (v !== null && typeof v === 'object') {
      out[k] = Object.freeze({ ...v });
    } else {
      out[k] = v;
    }
  }
  return Object.freeze(out);
}

/** Serialize a RESOLVED spec (the object evaluatePopulation stores at
 * `evaluation.spec`; hooks are execution plumbing, never identity). */
export function serializeEvaluationSpec(resolvedSpec) {
  const s = resolvedSpec;
  if (typeof s !== 'object' || s === null) fail('resolvedSpec', s);
  const terrain = s.terrain;
  // Drift teeth: the declared walk must cover the terrain contract exactly.
  const walkKeys = TERRAIN_SPEC_WALK.map(([k]) => k);
  const defaultKeys = Object.keys(TERRAIN_DEFAULTS);
  if (walkKeys.length !== defaultKeys.length || !defaultKeys.every((k) => walkKeys.includes(k))) {
    throw new Error('population-evaluation: TERRAIN_SPEC_WALK is out of sync with TERRAIN_DEFAULTS — declare the new knob\'s wire type before encoding');
  }
  const terrainKeys = Object.keys(terrain);
  if (terrainKeys.length !== walkKeys.length || !terrainKeys.every((k) => walkKeys.includes(k))) {
    throw new Error('population-evaluation: resolved terrain keys diverge from the declared walk');
  }
  const term = TERMINATIONS.indexOf(s.termination);
  if (term < 0) fail('termination', s.termination);
  // maxSteps is a u32 on the wire — reject anything that would silently wrap
  // (a public export cannot assume it was routed through resolveSpec).
  if (!Number.isInteger(s.maxSteps) || s.maxSteps < 1 || s.maxSteps > 0xffffffff) fail('maxSteps', s.maxSteps);

  // Size pass, then write pass (explicit, no push-buffers).
  let size = 2 + 1 + 1 + 4 + 8 * 5 + 1;
  for (const [key, kind] of TERRAIN_SPEC_WALK) {
    if (kind === 'uint32') size += 4;
    else if (kind === 'f64') size += 8;
    else if (kind === 'range') size += 1 + terrain[key].length * 8;
    else size += 1 + WEIGHT_KEYS.length * (1 + 8);
  }
  const view = new DataView(new ArrayBuffer(size));
  let o = 0;
  // Every f64 write is finiteness-gated: setFloat64(NaN) emits an
  // implementation-defined bit pattern (wasm NaN payloads are
  // nondeterministic — the exact cross-engine hazard the trace codec
  // canonicalizes against), and an infinite terrain scalar is nonsense. In
  // the normal evaluatePopulation flow generateCorridorTerrain's
  // validateConfig has already rejected a non-finite terrain, but
  // serializeEvaluationSpec is a public export, so it validates the derived
  // quantity at its own seam rather than trusting an upstream caller.
  const f64 = (v, path) => {
    if (!Number.isFinite(v)) fail(path, v);
    view.setFloat64(o, v, true); o += 8;
  };
  view.setUint16(o, EVALUATION_SPEC_VERSION, true); o += 2;
  view.setUint8(o, s.deterministic ? 1 : 0); o += 1;
  view.setUint8(o, term); o += 1;
  view.setUint32(o, s.maxSteps, true); o += 4;
  f64(s.spawn.x, 'spawn.x');
  f64(s.spawn.z, 'spawn.z');
  f64(s.spawn.clearance, 'spawn.clearance');
  f64(s.targetWheelSurfaceSpeed, 'targetWheelSurfaceSpeed');
  f64(s.wheelFriction, 'wheelFriction');
  view.setUint8(o, TERRAIN_SPEC_WALK.length); o += 1;
  for (const [key, kind] of TERRAIN_SPEC_WALK) {
    const v = terrain[key];
    if (kind === 'uint32') {
      if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) fail(`terrain.${key}`, v);
      view.setUint32(o, v, true); o += 4;
    } else if (kind === 'f64') {
      f64(v, `terrain.${key}`);
    } else if (kind === 'range') {
      view.setUint8(o, v.length); o += 1;
      for (const e of v) f64(e, `terrain.${key}[]`);
    } else { // weights
      const keys = Object.keys(v);
      if (keys.length !== WEIGHT_KEYS.length || !WEIGHT_KEYS.every((k) => keys.includes(k))) {
        fail(`terrain.${key}`, `keys [${keys}] must equal the declared [${WEIGHT_KEYS}]`);
      }
      view.setUint8(o, WEIGHT_KEYS.length); o += 1;
      WEIGHT_KEYS.forEach((k, i) => {
        view.setUint8(o, i); o += 1;
        f64(v[k], `terrain.${key}.${k}`);
      });
    }
  }
  return new Uint8Array(view.buffer);
}

// --- The evaluator -----------------------------------------------------------

/**
 * Evaluate a canonical population under a declared spec. Individuals are
 * accepted in ANY order (identity is individualId; a sorted COPY defines the
 * canonical order); every genotype must be canonical (validatePopulation)
 * and realizable (S0/S1 — an imported S2 fails LOUD with its individualId
 * and axle path, never silently masked). One isolated world per individual
 * (the world-mode ruling above). Result contract is architecture-independent:
 * per-individual physics diagnostics only — no shared-world counts, no
 * profiler samples (batch cost is the characterization script's job).
 */
export async function evaluatePopulation(population, evaluationSpec) {
  const sorted = validatePopulation(population);
  const resolved = resolveSpec(evaluationSpec);
  const { onIndividual } = resolved;

  // Compile + realizability gate, all before any physics.
  const compiled = sorted.map((ind) => {
    const ir = compileAssembly(ind.genotype);
    ir.axles.forEach((axle, ai) => {
      if (!REALIZABLE_SUSPENSION_TYPES.includes(axle.suspension.type)) {
        throw new Error(`population-evaluation: individual ${ind.individualId} axles[${ai}] `
          + `decodes to unsupported suspension type '${axle.suspension.type}' — `
          + `realizable types are ${REALIZABLE_SUSPENSION_TYPES.join('/')}; `
          + 'imported populations are never silently masked');
      }
    });
    return { individualId: ind.individualId, ir };
  });

  const spec = Object.freeze({
    deterministic: resolved.deterministic,
    termination: resolved.termination,
    maxSteps: resolved.maxSteps,
    spawn: Object.freeze({ ...resolved.spawn }),
    targetWheelSurfaceSpeed: resolved.targetWheelSurfaceSpeed,
    wheelFriction: resolved.wheelFriction,
    terrain: resolved.terrain, // already deep-copied + deep-frozen by ownTerrain — the evaluator owns it
  });

  // Capture the population snapshot bytes SYNCHRONOUSLY, before the first hook
  // or await. A hook (onIndividual) — or any caller retaining the input — can
  // mutate a genotype after it was compiled to an IR; the simulations run the
  // captured IR, so the returned fitness vector must bind the population that
  // was actually evaluated, not a later mutation. Hashing here freezes that
  // identity into bytes the loop cannot disturb.
  const snapshotBytes = serializePopulationSnapshot(population);
  const snapshotState = fnv1aFold(FNV_OFFSET_BASIS, snapshotBytes);

  const individuals = [];
  let effectiveDt = null;
  for (let i = 0; i < compiled.length; i += 1) {
    const { individualId, ir } = compiled[i];
    if (onIndividual !== null) onIndividual(individualId, i, compiled.length);
    const spawn = spawnPoseOnFlatStart(ir, spec.spawn);
    // One isolated world at a time, sequentially — the world-mode ruling.
    const r = await runEvaluation({
      deterministic: spec.deterministic,
      terrain: { ...spec.terrain },
      vehicles: [{
        ir,
        spawn,
        targetWheelSurfaceSpeed: spec.targetWheelSurfaceSpeed,
        wheelFriction: spec.wheelFriction,
      }],
      maxSteps: spec.maxSteps,
      termination: spec.termination,
      trace: { mode: 'none' },
    });
    if (effectiveDt === null) effectiveDt = r.effectiveDt;
    else if (r.effectiveDt !== effectiveDt) fail('effectiveDt', `${r.effectiveDt} drifted from ${effectiveDt}`);
    const v = r.vehicles[0];
    individuals.push({
      individualId,
      fitness: fitnessFromVehicleResult(v),
      valid: isVehicleResultValid(v),
      // The integrity classification rides at member level (serialized into
      // the fitness vector) AND in full inside diagnostics — an
      // integrity-failed individual stays OBSERVABLE (status, first failure
      // step, reasons, bounded observations, raw task metrics), never
      // silently converted to a bare zero.
      integrityStatus: v.integrity.status,
      diagnostics: {
        forwardDistance: v.forwardDistance,
        maxForwardDistance: v.maxForwardDistance,
        stepAtMaxForwardDistance: v.stepAtMaxForwardDistance,
        maxBackwardDistance: v.maxBackwardDistance,
        origin: v.origin,
        finalPose: v.finalPose,
        finalVelocity: v.finalVelocity,
        finite: v.finite,
        terminated: v.terminated,
        bodies: v.bodies,
        joints: v.joints,
        mass: v.mass,
        stationCount: v.stationCount,
        integrity: v.integrity,
      },
    });
  }

  const evaluation = {
    worldMode: POPULATION_WORLD_MODE,
    effectiveDt,
    executedSteps: spec.maxSteps,
    spec,
    populationSnapshotDigestState: snapshotState, // captured pre-hook (see above)
    individuals,
  };
  const bytes = serializeFitnessVector(evaluation);
  evaluation.fitnessVector = { bytes, digest: fnv1aHexOf(fnv1aFold(FNV_OFFSET_BASIS, bytes)) };
  return evaluation;
}

/** Serialize the fitness vector of an evaluation (see the encoding walk). */
export function serializeFitnessVector(evaluation) {
  if (typeof evaluation !== 'object' || evaluation === null) fail('evaluation', evaluation);
  const { individuals, populationSnapshotDigestState } = evaluation;
  if (!Array.isArray(individuals) || individuals.length === 0) fail('evaluation.individuals', individuals);
  if (!Number.isInteger(populationSnapshotDigestState)
    || populationSnapshotDigestState < 0 || populationSnapshotDigestState > 0xffffffff) {
    fail('evaluation.populationSnapshotDigestState', populationSnapshotDigestState);
  }
  const specBytes = serializeEvaluationSpec(evaluation.spec);
  const specState = fnv1aFold(FNV_OFFSET_BASIS, specBytes);
  for (let i = 1; i < individuals.length; i += 1) {
    if (!(individuals[i].individualId > individuals[i - 1].individualId)) {
      fail(`evaluation.individuals[${i}].individualId`, 'must be strictly ascending');
    }
  }
  const view = new DataView(new ArrayBuffer(2 + 2 + 2 + 2 + 4 + 2 + 4 + 4 + individuals.length * (4 + 1 + 1 + 8)));
  let o = 0;
  view.setUint16(o, FITNESS_VECTOR_VERSION, true); o += 2;
  view.setUint16(o, FITNESS_POLICY_VERSION, true); o += 2;
  view.setUint16(o, INTEGRITY_POLICY_VERSION, true); o += 2;
  view.setUint16(o, POPULATION_SNAPSHOT_VERSION, true); o += 2;
  view.setUint32(o, populationSnapshotDigestState, true); o += 4;
  view.setUint16(o, EVALUATION_SPEC_VERSION, true); o += 2;
  view.setUint32(o, specState, true); o += 4;
  view.setUint32(o, individuals.length, true); o += 4;
  for (const ind of individuals) {
    if (!Number.isInteger(ind.individualId) || ind.individualId < 0 || ind.individualId > 0xffffffff) {
      fail('individualId', ind.individualId);
    }
    if (typeof ind.valid !== 'boolean') fail(`individual ${ind.individualId} valid`, ind.valid);
    const statusIndex = INTEGRITY_STATUS.indexOf(ind.integrityStatus);
    if (statusIndex === -1) fail(`individual ${ind.individualId} integrityStatus`, ind.integrityStatus);
    // The fitness contract is a non-negative finite score: NaN/Infinity would
    // emit implementation-defined bytes (the cross-engine hazard the codec
    // exists to prevent), and a negative fitness contradicts the max-progress
    // policy (maxForwardDistance ≥ 0, unselectable ⇒ 0). Reject an internally
    // contradictory vector rather than faithfully serialize it: fitness must
    // be 0 unless the member is BOTH valid and integrity-clean (policy v2).
    if (!Number.isFinite(ind.fitness) || ind.fitness < 0) fail(`individual ${ind.individualId} fitness`, ind.fitness);
    if ((!ind.valid || ind.integrityStatus !== 'ok') && ind.fitness !== 0) {
      fail(`individual ${ind.individualId} fitness`,
        `unselectable individual (valid ${ind.valid}, integrity ${ind.integrityStatus}) must have fitness 0, got ${ind.fitness}`);
    }
    view.setUint32(o, ind.individualId, true); o += 4;
    view.setUint8(o, ind.valid ? 1 : 0); o += 1;
    view.setUint8(o, statusIndex); o += 1;
    view.setFloat64(o, ind.fitness, true); o += 8;
  }
  return new Uint8Array(view.buffer);
}

/**
 * DIAGNOSTIC best-observed individual (reports and instrumentation ONLY —
 * selection and elitism must consume selectableChampionFromEvaluation below).
 * Total order robust to input arrangement:
 *   1. greater fitness;
 *   2. on an EXACT fitness tie, VALID over invalid;
 *   3. then the LOWEST individualId.
 * An all-invalid population still yields a well-defined {lowest id, fitness 0,
 * valid false} best-observed row. Under fitness policy v2 this can surface an
 * integrity-failed individual at a zero-fitness tie — which is exactly why it
 * is diagnostic, not selective.
 */
export function championFromEvaluation(evaluation) {
  if (typeof evaluation !== 'object' || evaluation === null
    || !Array.isArray(evaluation.individuals) || evaluation.individuals.length === 0) {
    fail('evaluation.individuals', evaluation && evaluation.individuals);
  }
  const better = (a, b) => {
    if (a.fitness !== b.fitness) return a.fitness > b.fitness;
    if (a.valid !== b.valid) return a.valid; // valid outranks invalid on a fitness tie
    return a.individualId < b.individualId;
  };
  let champion = evaluation.individuals[0];
  for (const ind of evaluation.individuals) {
    if (better(ind, champion)) champion = ind;
  }
  return champion;
}

/**
 * The SELECTION champion (fitness policy v2's eligibility contract): the best
 * individual among those that are BOTH valid AND integrity-clean
 * (integrityStatus === 'ok'), by greater fitness then lowest individualId —
 * or **null** when no selectable individual exists. Returning an explicit
 * null (never a least-bad unselectable member) is the point: an
 * integrity-failed individual must not become the evolutionary champion
 * merely because every fitness is zero; a generation with no selectable
 * member is a condition Phase 1B must handle deliberately, not paper over.
 */
export function selectableChampionFromEvaluation(evaluation) {
  if (typeof evaluation !== 'object' || evaluation === null
    || !Array.isArray(evaluation.individuals) || evaluation.individuals.length === 0) {
    fail('evaluation.individuals', evaluation && evaluation.individuals);
  }
  let champion = null;
  for (const ind of evaluation.individuals) {
    if (typeof ind.valid !== 'boolean') fail(`individual ${ind.individualId} valid`, ind.valid);
    if (!INTEGRITY_STATUS.includes(ind.integrityStatus)) {
      fail(`individual ${ind.individualId} integrityStatus`, ind.integrityStatus);
    }
    if (!(ind.valid && ind.integrityStatus === 'ok')) continue;
    if (champion === null
      || ind.fitness > champion.fitness
      || (ind.fitness === champion.fitness && ind.individualId < champion.individualId)) {
      champion = ind;
    }
  }
  return champion;
}
