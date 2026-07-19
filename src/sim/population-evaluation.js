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
import { createByteReader } from './bytes.js';
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
  // Structural refusal in this module's dialect (the requireIntegrity
  // precedent): a malformed result must fail LOUD here, never leak a foreign
  // TypeError off `.bodies.allValid` — and never silently return false, which
  // would score a malformed record as an ordinary invalid vehicle.
  if (typeof vehicleResult !== 'object' || vehicleResult === null
    || typeof vehicleResult.bodies !== 'object' || vehicleResult.bodies === null
    || typeof vehicleResult.joints !== 'object' || vehicleResult.joints === null) {
    fail('vehicleResult', vehicleResult);
  }
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
 *
 * Integrity is validated FIRST, unconditionally: EVERY result the fitness
 * policy consumes must carry a valid versioned integrity block, including
 * invalid results. A `validity && requireIntegrity(...)` order would
 * short-circuit on an invalid result and let a detector-disabled
 * (integrity: null) or malformed block return a silent `false` instead of
 * the mandated loud refusal — an unversioned "policy" for exactly the
 * results most likely to need diagnosis.
 */
export function isVehicleResultSelectable(vehicleResult) {
  const integrity = requireIntegrity(vehicleResult);
  return isVehicleResultValid(vehicleResult) && integrity.status === 'ok';
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
  // Structural guards for the two shapes dereferenced below — a version-only
  // gate let `{version: 2}` leak a foreign TypeError off `.aabb.min.y`. The
  // production path always passes compileAssembly output (module-owned), so
  // these guard direct callers with hand-built IRs.
  if (typeof ir.chassis !== 'object' || ir.chassis === null
    || typeof ir.chassis.aabb !== 'object' || ir.chassis.aabb === null
    || typeof ir.chassis.aabb.min !== 'object' || ir.chassis.aabb.min === null) {
    fail('ir.chassis', ir.chassis);
  }
  if (!Array.isArray(ir.axles)) fail('ir.axles', ir.axles);
  let drop = -ir.chassis.aabb.min.y; // sled fallback: belly bottom
  for (const t of vehicleWheelTransforms(ir, {})) {
    const wheel = ir.axles[t.axleIndex].wheels[t.wheelIndex];
    drop = Math.max(drop, wheel.radius - t.local.y);
  }
  return { position: { x, y: drop + clearance, z } };
}

// --- Evaluation-spec resolution + encoding -----------------------------------

// `termination` is accepted as INPUT even though resolveSpec derives it, so a
// RESOLVED spec re-enters the resolver unchanged — which is what makes a spec
// decoded from canonical bytes directly replayable (deserializeEvaluationSpec
// returns the resolved shape, since that is what serializeEvaluationSpec
// consumes). Accepting it is additive and byte-neutral: the resolved output
// already carried this exact value. It stays fail-loud — a termination outside
// TERMINATIONS is rejected below, never coerced to the default.
const SPEC_KEYS = Object.freeze([
  'terrain', 'maxSteps', 'deterministic', 'spawn', 'targetWheelSurfaceSpeed', 'wheelFriction',
  'termination', 'hooks',
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
    wheelFriction = WHEEL_FRICTION, termination = TERMINATIONS[0], hooks = {},
  } = spec;
  if (!TERMINATIONS.includes(termination)) fail('termination', termination);
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
  // Absent defaults; an EXPLICIT null fails like any other non-number (the
  // `??` shape silently substituted the default for null — the keepRaw class).
  const clearance = Object.hasOwn(spawn, 'clearance') ? spawn.clearance : SPAWN_CLEARANCE;
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
  // The two scalars the flat-pad guard computes with must be honest numbers
  // BEFORE the comparison: a NaN length made both comparisons vacuously false
  // (the guard silently passed), and a string coerced through the arithmetic.
  // Full terrain validation stays at generation time (generateCorridorTerrain
  // validateConfig — the execution gate); this validates only what THIS guard
  // consumes, so the guard can never be a no-op.
  if (typeof resolvedTerrain.length !== 'number' || !Number.isFinite(resolvedTerrain.length)) {
    fail('terrain.length', resolvedTerrain.length);
  }
  if (typeof resolvedTerrain.startFlatLength !== 'number' || !Number.isFinite(resolvedTerrain.startFlatLength)) {
    fail('terrain.startFlatLength', resolvedTerrain.startFlatLength);
  }
  // The flat-pad guard: the whole vehicle must sit on exactly-flat ground.
  const padStart = -resolvedTerrain.length / 2;
  const padEnd = padStart + resolvedTerrain.startFlatLength;
  if (spawn.x - SPAWN_PAD_MARGIN < padStart || spawn.x + SPAWN_PAD_MARGIN > padEnd) {
    fail('spawn.x', `${spawn.x} must sit >= ${SPAWN_PAD_MARGIN} m inside the flat pad [${padStart}, ${padEnd}]`);
  }
  return {
    deterministic,
    termination, // validated against TERMINATIONS above; defaults to the only value
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
      // Indexed copy, never `v.slice()`: slice is looked up on the CALLER's
      // array, so an own `slice` property would run caller code inside the
      // ownership boundary and its return value would BECOME the owned copy —
      // the cloneGenotype class. The whole point of this function is that
      // nothing caller-controlled survives into the result.
      const copy = [];
      for (let i = 0; i < v.length; i += 1) copy.push(v[i]);
      out[k] = Object.freeze(copy);
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
  // `terrain` is validated HERE, before the drift teeth below reach
  // Object.keys(terrain). `typeof s === 'object'` admits [], new Map(),
  // new Date() and a bare {} — none of which carry a terrain — so without
  // this the simplest malformed input a caller can pass leaked a foreign
  // `TypeError: Cannot convert undefined or null to object` out of
  // Object.keys instead of this module's diagnosis. Measured on {}, [],
  // new Map(), new Date(). That contradicts the standard this codec holds
  // everywhere else (its own range tooth asserts "a module error, not a
  // foreign TypeError"), and a foreign error from a PUBLIC encoder is
  // exactly what replay and import tooling cannot act on.
  if (typeof terrain !== 'object' || terrain === null) fail('terrain', terrain);
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
  // deterministic selects the PHYSICS FLAVOR — a strict boolean, never
  // truthiness. The former `s.deterministic ? 1 : 0` silently flipped the
  // field's meaning for plausible wrong types: the string 'false' and a boxed
  // `new Boolean(false)` (which PRINTS as false) both encoded as true, so
  // deserialize(serialize(spec)) was no longer semantically the input, and
  // the digest attested the wrong engine. resolveSpec already requires a
  // strict boolean; the public encoder must too.
  if (typeof s.deterministic !== 'boolean') fail('deterministic', s.deterministic);
  // spawn is dereferenced three times below — the same structural-guard
  // ruling as `terrain` above (spawn: null leaked a foreign TypeError).
  if (typeof s.spawn !== 'object' || s.spawn === null) fail('spawn', s.spawn);

  // Size pass, then write pass (explicit, no push-buffers).
  //
  // Ranges are MATERIALIZED here, once, BY INDEX, and BOTH passes consume that
  // snapshot — the count byte, the allocation, and the written values all come
  // from one source that cannot disagree with itself.
  //
  // INDICES ARE THE TRUTH, and that is the whole ruling. Terrain generation
  // consumes every range by index (`cfg.craterRadiusRange[0]`,
  // `cfg.craterRadiusRange[1]` — terrain.js), so a range's indexed content is
  // what the described run actually executes on. Reading the values any other
  // way lets the spec digest attest a terrain that never existed: an
  // overridden Symbol.iterator on a GENUINE Array (Array.isArray stays true —
  // it is no defence) yields whatever it likes while the indices terrain.js
  // reads say something else, and the resulting stream is well-formed, decodes
  // cleanly, and re-encodes byte-identically. Iterating also let a declared
  // length and an iterable's cardinality disagree — under-yielding left a
  // zero-filled hole that shifted every later field (a correctly-SIZED but
  // semantically wrong stream, the worst failure mode), over-yielding overran
  // the DataView with a foreign RangeError, and an INFINITE generator hung.
  // An indexed read is immune to all four by construction: `declared` values
  // come from `declared` slots, and a slot that is not a finite number fails
  // loud at the f64 gate below.
  //
  // Order is load-bearing. The u8 bound is checked BEFORE materializing and
  // before the buffer exists, because both the size pass and the
  // materialization scale with the declared length: validating later let a
  // pathological length size the allocation first — measured, ~17 GB reserved
  // at length 2^31 and a generic `RangeError: Array buffer allocation failed`
  // at 2^40, instead of this module's diagnosis. The axle-count and
  // populationSize guards are the same ruling.
  const ranges = new Map();
  let size = 2 + 1 + 1 + 4 + 8 * 5 + 1;
  for (const [key, kind] of TERRAIN_SPEC_WALK) {
    if (kind === 'uint32') size += 4;
    else if (kind === 'f64') size += 8;
    else if (kind === 'range') {
      const range = terrain[key];
      if (range === null || typeof range !== 'object') fail(`terrain.${key}`, range);
      const declared = range.length;
      if (!Number.isInteger(declared) || declared < 0 || declared > 0xff) {
        fail(`terrain.${key}.length`, `${declared} exceeds the u8 wire bound (255)`);
      }
      const values = [];
      for (let i = 0; i < declared; i += 1) values.push(range[i]);
      ranges.set(key, values);
      size += 1 + values.length * 8;
    } else size += 1 + WEIGHT_KEYS.length * (1 + 8);
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
      // The MATERIALIZED values from the size pass — count and payload cannot
      // disagree, because they are the same array. Indexed here too: this
      // module never reads a length from one place and content from another.
      const values = ranges.get(key);
      view.setUint8(o, values.length); o += 1;
      for (let i = 0; i < values.length; i += 1) f64(values[i], `terrain.${key}[]`);
    } else { // weights
      // Structural guard before Object.keys — a null/scalar weights object
      // leaked a foreign TypeError here (the spawn/terrain guard ruling).
      if (typeof v !== 'object' || v === null) fail(`terrain.${key}`, v);
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

function specDecodeFail(path, value) {
  throw new Error(`population-evaluation: invalid encoded evaluation spec at ${path} (${String(value)})`);
}

/**
 * The exact inverse of serializeEvaluationSpec.
 *
 * Validation depth is deliberate: this mirrors the SERIALIZER's checks — wire
 * shape, enum/flag ranges, u32 domains, f64 finiteness — and nothing more. It
 * does NOT run resolveSpec, which additionally enforces EXECUTION constraints
 * the encoder never applies (the spawn-clearance band, the flat-pad guard, a
 * non-negative wheelFriction). Calling it here would reject byte streams the
 * public encoder legally produces, i.e. this would stop being an inverse.
 * Execution validation stays where it already is: evaluatePopulation resolves
 * every spec it runs.
 *
 * Values are returned exactly as encoded — never re-resolved against current
 * runtime defaults. All 33 terrain knobs are explicit on the wire, so the
 * decoder never injects a default and a future change to TERRAIN_DEFAULTS
 * cannot silently rewrite an old spec's meaning.
 */
export function deserializeEvaluationSpec(bytes) {
  const r = createByteReader(bytes, specDecodeFail);
  const specVersion = r.u16('specVersion');
  if (specVersion !== EVALUATION_SPEC_VERSION) specDecodeFail('specVersion', specVersion);
  const deterministic = r.flag('deterministic');
  const terminationIndex = r.u8('termination');
  if (terminationIndex >= TERMINATIONS.length) specDecodeFail('termination', terminationIndex);
  const maxSteps = r.u32('maxSteps');
  if (maxSteps < 1) specDecodeFail('maxSteps', maxSteps);
  const spawnX = r.finiteF64('spawn.x');
  const spawnZ = r.finiteF64('spawn.z');
  const clearance = r.finiteF64('spawn.clearance');
  const targetWheelSurfaceSpeed = r.finiteF64('targetWheelSurfaceSpeed');
  const wheelFriction = r.finiteF64('wheelFriction');
  const terrainKeyCount = r.u8('terrainKeyCount');
  if (terrainKeyCount !== TERRAIN_SPEC_WALK.length) specDecodeFail('terrainKeyCount', terrainKeyCount);
  const terrain = {};
  for (const [key, kind] of TERRAIN_SPEC_WALK) {
    if (kind === 'uint32') {
      terrain[key] = r.u32(`terrain.${key}`);
    } else if (kind === 'f64') {
      terrain[key] = r.finiteF64(`terrain.${key}`);
    } else if (kind === 'range') {
      const length = r.u8(`terrain.${key}.length`);
      const range = [];
      for (let i = 0; i < length; i += 1) range.push(r.finiteF64(`terrain.${key}[${i}]`));
      terrain[key] = range;
    } else { // weights
      const count = r.u8(`terrain.${key}.count`);
      if (count !== WEIGHT_KEYS.length) specDecodeFail(`terrain.${key}.count`, count);
      const weights = {};
      WEIGHT_KEYS.forEach((k, i) => {
        const declaredIndex = r.u8(`terrain.${key}.${k}.declaredIndex`);
        if (declaredIndex !== i) specDecodeFail(`terrain.${key}.${k}.declaredIndex`, declaredIndex);
        weights[k] = r.finiteF64(`terrain.${key}.${k}`);
      });
      terrain[key] = weights;
    }
  }
  r.expectEnd('evaluationSpec');
  // Same ownership discipline as a resolved spec: deep-frozen, so a decoded
  // spec cannot be mutated out from under a digest that already attested it.
  return Object.freeze({
    deterministic,
    termination: TERMINATIONS[terminationIndex],
    maxSteps,
    spawn: Object.freeze({ x: spawnX, z: spawnZ, clearance }),
    targetWheelSurfaceSpeed,
    wheelFriction,
    terrain: ownTerrain(terrain),
  });
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

// Where the encoded evaluationSpecDigestState comes from. The production path
// carries the resolved `spec` itself and computes the state from it —
// unchanged, statement for statement. The ADDITIVE path exists because the
// spec digest is a one-way attestation: a decoded fitness vector holds the
// state but can never reconstruct the spec, so without this an encoded vector
// could not be re-encoded from its own decoded form (the codec's round-trip
// contract). Both present must AGREE — a vector can never attest to a spec it
// disagrees with; neither present fails loud.
function resolveSpecDigestState(evaluation) {
  const declared = evaluation.evaluationSpecDigestState;
  if (evaluation.spec !== undefined) {
    const specBytes = serializeEvaluationSpec(evaluation.spec);
    const state = fnv1aFold(FNV_OFFSET_BASIS, specBytes);
    if (declared !== undefined && declared !== state) {
      fail('evaluation.evaluationSpecDigestState',
        `${declared} disagrees with the spec's computed state ${state}`);
    }
    return state;
  }
  if (!Number.isInteger(declared) || declared < 0 || declared > 0xffffffff) {
    fail('evaluation.evaluationSpecDigestState', declared);
  }
  return declared;
}

// The fixed wire geometry, named once so the encoder's allocation and the
// decoder's exact-length identity cannot drift apart (the genotypeByteLength
// precedent — GENOTYPE_BASE_BYTES / GENOTYPE_AXLE_STRIDE in assembly.js).
const FITNESS_VECTOR_HEADER_BYTES = 2 + 2 + 2 + 2 + 4 + 2 + 4 + 4; // 22
const FITNESS_VECTOR_MEMBER_BYTES = 4 + 1 + 1 + 8; // 14

/** Exact byte length of a canonical fitness vector carrying `count` members. */
function fitnessVectorByteLength(count) {
  return FITNESS_VECTOR_HEADER_BYTES + FITNESS_VECTOR_MEMBER_BYTES * count;
}

/** Serialize the fitness vector of an evaluation (see the encoding walk). */
export function serializeFitnessVector(evaluation) {
  if (typeof evaluation !== 'object' || evaluation === null) fail('evaluation', evaluation);
  const { individuals, populationSnapshotDigestState } = evaluation;
  if (!Array.isArray(individuals) || individuals.length === 0) fail('evaluation.individuals', individuals);
  // NO u32 guard on individuals.length, deliberately, and NOT an omission from
  // the axle-count / range-length / populationSize family. Those three each
  // guard a REACHABLE gap and each has a committed test that triggers it.
  // This one cannot be triggered at all: Array.isArray gates the field above,
  // and a genuine Array's maximum length is exactly 4294967295 — the u32 max
  // (`a.length = 0x100000000` throws `RangeError: Invalid array length`). A
  // guard here would be unreachable by the language spec rather than merely
  // unreachable today, i.e. dead code defending a shape JavaScript cannot
  // construct.
  if (!Number.isInteger(populationSnapshotDigestState)
    || populationSnapshotDigestState < 0 || populationSnapshotDigestState > 0xffffffff) {
    fail('evaluation.populationSnapshotDigestState', populationSnapshotDigestState);
  }
  const specState = resolveSpecDigestState(evaluation);
  // ONE indexed preflight builds a module-owned snapshot of every row —
  // structural shape, canonical id, strictly-ascending order, strict boolean
  // validity, known integrity status, finite non-negative fitness, and the
  // policy-v2 coherence tooth — BEFORE the buffer exists. The write pass
  // below is then a pure encoding pass over already-validated module-owned
  // rows: it re-reads nothing from the caller, so nothing can differ from
  // what was checked (the validatedMembers ruling in population.js). The
  // former shape read `individuals[i].individualId` in the ordering pass and
  // again in the write pass, and dereferenced rows without a shape check —
  // `[null]` or a sparse array leaked a foreign TypeError from a public
  // encoder.
  const rows = [];
  for (let i = 0; i < individuals.length; i += 1) {
    const ind = individuals[i];
    if (typeof ind !== 'object' || ind === null) fail(`evaluation.individuals[${i}]`, ind);
    if (!Number.isInteger(ind.individualId) || ind.individualId < 0 || ind.individualId > 0xffffffff) {
      fail('individualId', ind.individualId);
    }
    if (i > 0 && !(ind.individualId > rows[i - 1].individualId)) {
      fail(`evaluation.individuals[${i}].individualId`, 'must be strictly ascending');
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
    rows.push({ individualId: ind.individualId, valid: ind.valid, statusIndex, fitness: ind.fitness });
  }
  const view = new DataView(new ArrayBuffer(fitnessVectorByteLength(rows.length)));
  let o = 0;
  view.setUint16(o, FITNESS_VECTOR_VERSION, true); o += 2;
  view.setUint16(o, FITNESS_POLICY_VERSION, true); o += 2;
  view.setUint16(o, INTEGRITY_POLICY_VERSION, true); o += 2;
  view.setUint16(o, POPULATION_SNAPSHOT_VERSION, true); o += 2;
  view.setUint32(o, populationSnapshotDigestState, true); o += 4;
  view.setUint16(o, EVALUATION_SPEC_VERSION, true); o += 2;
  view.setUint32(o, specState, true); o += 4;
  view.setUint32(o, rows.length, true); o += 4;
  for (let i = 0; i < rows.length; i += 1) {
    view.setUint32(o, rows[i].individualId, true); o += 4;
    view.setUint8(o, rows[i].valid ? 1 : 0); o += 1;
    view.setUint8(o, rows[i].statusIndex); o += 1;
    view.setFloat64(o, rows[i].fitness, true); o += 8;
  }
  return new Uint8Array(view.buffer);
}

function vectorDecodeFail(path, value) {
  throw new Error(`population-evaluation: invalid encoded fitness vector at ${path} (${String(value)})`);
}

/**
 * The exact inverse of serializeFitnessVector. Mirrors the encoder's checks
 * verbatim, including the coherence tooth that an unselectable member (invalid
 * OR integrity-failed) must carry fitness 0 — a contradictory stream is
 * malformed and rejected, never silently normalized to 0.
 *
 * The result feeds serializeFitnessVector directly: it carries
 * evaluationSpecDigestState (no `spec`), which the encoder's additive input
 * path consumes.
 */
export function deserializeFitnessVector(bytes) {
  const r = createByteReader(bytes, vectorDecodeFail);
  const fitnessVectorVersion = r.u16('fitnessVectorVersion');
  if (fitnessVectorVersion !== FITNESS_VECTOR_VERSION) {
    vectorDecodeFail('fitnessVectorVersion', fitnessVectorVersion);
  }
  const fitnessPolicyVersion = r.u16('fitnessPolicyVersion');
  if (fitnessPolicyVersion !== FITNESS_POLICY_VERSION) {
    vectorDecodeFail('fitnessPolicyVersion', fitnessPolicyVersion);
  }
  const integrityPolicyVersion = r.u16('integrityPolicyVersion');
  if (integrityPolicyVersion !== INTEGRITY_POLICY_VERSION) {
    vectorDecodeFail('integrityPolicyVersion', integrityPolicyVersion);
  }
  const snapshotVersion = r.u16('snapshotVersion');
  if (snapshotVersion !== POPULATION_SNAPSHOT_VERSION) {
    vectorDecodeFail('snapshotVersion', snapshotVersion);
  }
  const populationSnapshotDigestState = r.u32('populationSnapshotDigestState');
  const evaluationSpecVersion = r.u16('evaluationSpecVersion');
  if (evaluationSpecVersion !== EVALUATION_SPEC_VERSION) {
    vectorDecodeFail('evaluationSpecVersion', evaluationSpecVersion);
  }
  const evaluationSpecDigestState = r.u32('evaluationSpecDigestState');
  const count = r.u32('count');
  if (count < 1) vectorDecodeFail('count', count);
  // The record stride is fixed, so the total length is an exact identity —
  // checked before the member loop so a lying count reports as a length
  // mismatch rather than a truncation deep inside a member.
  const expected = fitnessVectorByteLength(count);
  if (bytes.byteLength !== expected) {
    vectorDecodeFail('byteLength', `${bytes.byteLength} (expected ${expected} for count ${count})`);
  }
  const individuals = [];
  let prevId = -1;
  for (let i = 0; i < count; i += 1) {
    const individualId = r.u32(`individuals[${i}].individualId`);
    if (individualId <= prevId) {
      vectorDecodeFail(`individuals[${i}].individualId`,
        `${individualId} must be strictly ascending (previous ${prevId})`);
    }
    prevId = individualId;
    const valid = r.flag(`individuals[${i}].valid`);
    const statusIndex = r.u8(`individuals[${i}].integrityStatus`);
    if (statusIndex >= INTEGRITY_STATUS.length) {
      vectorDecodeFail(`individuals[${i}].integrityStatus`, statusIndex);
    }
    const integrityStatus = INTEGRITY_STATUS[statusIndex];
    const fitness = r.f64(`individuals[${i}].fitness`);
    if (!Number.isFinite(fitness) || fitness < 0) vectorDecodeFail(`individuals[${i}].fitness`, fitness);
    // The encoder's own comparison, verbatim: `!== 0` (not Object.is), so a
    // legally-encoded -0 on an unselectable member decodes rather than being
    // rejected by a stricter-than-the-encoder rule.
    if ((!valid || integrityStatus !== 'ok') && fitness !== 0) {
      vectorDecodeFail(`individuals[${i}].fitness`,
        `unselectable individual (valid ${valid}, integrity ${integrityStatus}) must have fitness 0, got ${fitness}`);
    }
    individuals.push(Object.freeze({ individualId, valid, integrityStatus, fitness }));
  }
  r.expectEnd('fitnessVector');
  return Object.freeze({
    fitnessVectorVersion,
    fitnessPolicyVersion,
    integrityPolicyVersion,
    snapshotVersion,
    populationSnapshotDigestState,
    evaluationSpecVersion,
    evaluationSpecDigestState,
    individuals: Object.freeze(individuals),
  });
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
  // Indexed, with a per-row shape check: `for...of` read the caller's
  // iterator (which can disagree with the indices every other consumer
  // reads), and a null row leaked a foreign TypeError.
  const individuals = evaluation.individuals;
  let champion = null;
  for (let i = 0; i < individuals.length; i += 1) {
    const ind = individuals[i];
    if (typeof ind !== 'object' || ind === null) fail(`evaluation.individuals[${i}]`, ind);
    if (champion === null || better(ind, champion)) champion = ind;
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
  // Indexed + per-row shape check (see championFromEvaluation): this is the
  // SELECTION entry point, so the rows it judges must be the rows every other
  // consumer reads — the indices — never a caller iterator's answers.
  const individuals = evaluation.individuals;
  let champion = null;
  for (let i = 0; i < individuals.length; i += 1) {
    const ind = individuals[i];
    if (typeof ind !== 'object' || ind === null) fail(`evaluation.individuals[${i}]`, ind);
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
