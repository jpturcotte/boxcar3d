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
import {
  POPULATION_SNAPSHOT_VERSION, attestPopulation, isCanonicalUint32,
} from './population.js';
import { createByteReader } from './bytes.js';
import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHexOf } from './fnv1a.js';
import { INTEGRITY_POLICY_VERSION, INTEGRITY_STATUS } from './integrity.js';

export const FITNESS_POLICY_VERSION = 2; // v2: the numerical-integrity gate (see the ruling above)
// This is deliberately an in-memory selection view, not a new wire format.
// A later generation/replacement layer owns any persisted evolution history.
export const SELECTION_POOL_VERSION = 1;
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

/**
 * THE ONE CAPTURE of a vehicle result. Every field the fitness policy
 * consumes is read exactly once, into module-owned locals, and all three
 * public predicates below derive from this single reading.
 *
 * Previously each predicate read the caller independently — and
 * `fitnessFromVehicleResult` called `isVehicleResultSelectable`, which called
 * `isVehicleResultValid`, so one fitness decision took six reads of `bodies`
 * alone. A result whose `integrity.status` getter answered 'ok' once and
 * 'numericalDivergence' once could therefore be recorded selectable and
 * scored on its raw distance, which is exactly the divergence the integrity
 * gate exists to make non-selectable. The `typeof x !== 'object' || x === null`
 * guard shape was itself two reads before anything used the value.
 */
function captureVehicleResult(vehicleResult) {
  // Structural refusal in this module's dialect (the requireIntegrity
  // precedent): a malformed result must fail LOUD here, never leak a foreign
  // TypeError off `.bodies.allValid` — and never silently return false, which
  // would score a malformed record as an ordinary invalid vehicle.
  if (typeof vehicleResult !== 'object' || vehicleResult === null) {
    fail('vehicleResult', vehicleResult);
  }
  const bodies = vehicleResult.bodies;
  const joints = vehicleResult.joints;
  if (typeof bodies !== 'object' || bodies === null
    || typeof joints !== 'object' || joints === null) {
    fail('vehicleResult', vehicleResult);
  }
  const valid = vehicleResult.finite === true
    && bodies.allValid === true
    && joints.allValid === true;
  // Integrity is captured unconditionally, including for invalid results —
  // see isVehicleResultSelectable's ruling on validation order.
  const block = vehicleResult.integrity;
  const policyVersion = typeof block === 'object' && block !== null ? block.policyVersion : undefined;
  const status = typeof block === 'object' && block !== null ? block.status : undefined;
  return {
    valid, block, policyVersion, status, maxForwardDistance: vehicleResult.maxForwardDistance,
  };
}

export function isVehicleResultValid(vehicleResult) {
  return captureVehicleResult(vehicleResult).valid;
}

// The integrity block is MANDATORY on every result the fitness policy
// consumes (the runner emits it unconditionally on every production path; the
// core-loop diagnostic off-arm yields integrity: null, which this policy
// refuses — a fitness computed while the detector was off would be a
// different, unversioned policy).
// Operates on the CAPTURE, so the status this validates is the status the
// caller's decision is made from. Returning the caller's block (as this once
// did) handed the next reader a fresh chance to be told something else.
function requireIntegrity(captured) {
  const { block, policyVersion, status } = captured;
  if (typeof block !== 'object' || block === null
    || policyVersion !== INTEGRITY_POLICY_VERSION
    || !INTEGRITY_STATUS.includes(status)) {
    fail('vehicleResult.integrity', block === null || block === undefined
      ? `${String(block)} (fitness policy v${FITNESS_POLICY_VERSION} requires the integrity block — was the detector disabled?)`
      : `policyVersion ${policyVersion}, status ${String(status)}`);
  }
  return status;
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
  const captured = captureVehicleResult(vehicleResult);
  const status = requireIntegrity(captured);
  return captured.valid && status === 'ok';
}

/**
 * THE FITNESS DOMAIN, declared once and enforced everywhere a fitness value
 * crosses a seam: a finite, non-negative, non-`-0` number.
 *
 * This exists because the previous shape validated everything about a result
 * EXCEPT the number it returned. `requireIntegrity`, `isVehicleResultValid`'s
 * three structural guards and its `=== true` comparisons all passed while
 * `maxForwardDistance` was handed onward raw — measured returning NaN,
 * Infinity, -5, the STRING '12', undefined, and {}. Downstream, both champion
 * selectors order with `>`, so a NaN fitness makes the comparator neither
 * antisymmetric nor total: the first eligible row wins permanently and no
 * finite candidate can ever displace it, contradicting the "total order"
 * claim in championFromEvaluation's own docblock. The encoder already
 * enforced this domain; the producer and the selectors did not, so the one
 * seam that checked was the last one, by which point selection had already
 * happened on a poisoned value.
 *
 * `-0` is ACCEPTED here, unlike in isCanonicalUint32, and the asymmetry is
 * deliberate rather than an oversight: setUint32 ERASES a sign bit (so a -0
 * id silently became +0 and broke Object.is round-tripping), while setFloat64
 * PRESERVES it exactly. A -0 fitness therefore survives encode/decode
 * bit-for-bit, the decoder's `!== 0` coherence tooth already accepts it on an
 * unselectable member, and rejecting it here would make this encoder refuse
 * bytes its own decoder produces — an exact-inverse break in the direction
 * that is hardest to notice. The `typeof` gate is the load-bearing addition:
 * `Number.isFinite('12')` is false, but the old `!Number.isFinite(v) || v < 0`
 * shape was never applied to the producer at all.
 */
function isCanonicalFitness(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export function fitnessFromVehicleResult(vehicleResult) {
  // One capture backs BOTH the eligibility decision and the returned number.
  // Deriving them from separate readings let a result be judged selectable on
  // one reading and scored from another.
  const captured = captureVehicleResult(vehicleResult);
  const status = requireIntegrity(captured);
  if (!(captured.valid && status === 'ok')) return 0;
  const raw = captured.maxForwardDistance;
  if (!isCanonicalFitness(raw)) fail('vehicleResult.maxForwardDistance', raw);
  return raw;
}

// --- Spawn placement (pure) --------------------------------------------------

/**
 * Indexed deep copy of PLAIN DATA (arrays and plain objects), reading every
 * property exactly once. Anything that is not a plain array/object — numbers,
 * strings, null, and any exotic value — passes through by reference.
 *
 * Used when this module must hand caller-owned structure to code written under
 * a different ownership ruling (the adapter's placement planner, which
 * legitimately re-reads the compiler-owned IRs it was designed for). Copying
 * first means the callee's repeated reads are reads of module-owned data, so
 * this module's single-read guarantee holds at its own boundary without
 * imposing the rule on the physics layer. Indexed and key-enumerated, never
 * via caller-visible `.map`/iterators.
 *
 * Three round-11 corrections, each measured:
 *  - the plainness gate was `getPrototypeOf(v) === Object.prototype`, so an
 *    `Object.create(null)` dictionary or a class instance — ordinary data,
 *    not exotic — passed through BY REFERENCE and the planner then re-read it
 *    (spawn y 50.42 vs 0.54, and a caller-installed `forEach` invoked inside
 *    the boundary). The gate is now "no caller code reachable through the
 *    copy": null-prototype and Object.prototype containers are copied,
 *    everything else is refused rather than silently aliased.
 *  - `out[key] = ...` invokes the inherited SETTER for an own `"__proto__"`
 *    key (exactly what `JSON.parse('{"__proto__":{...}}')` produces): the
 *    property vanished and the "owned" copy adopted a caller-chosen
 *    prototype. defineProperty stores the value as data, always.
 *  - the recursion had no bound, so a cyclic or 12,000-deep plain object left
 *    this module as a foreign `RangeError`. A depth cap converts that to the
 *    module's own diagnosis; a cycle is infinite depth, so no `seen` set is
 *    needed. Compiled IRs measure depth 6.
 */
const OWN_PLAIN_MAX_DEPTH = 64;
const OWN_PLAIN_MAX_ARRAY = 1000000;

function ownPlainData(value, path = 'ir', depth = 0) {
  if (depth > OWN_PLAIN_MAX_DEPTH) {
    fail(path, `nesting exceeds ${OWN_PLAIN_MAX_DEPTH} levels (cyclic or pathologically deep)`);
  }
  if (Array.isArray(value)) {
    // Bound captured: element reads below are caller code and `length` is
    // writable (the round-11 loop-bound class).
    const count = value.length;
    // …and bounded BEFORE the copy loop allocates it (I8): round 11 captured
    // the length but still densified it, so a caller-declared `axles.length` of
    // 2^30 drove spawnPoseOnFlatStart to an uncatchable heap abort. An IR array
    // is tiny (axles ≤ 12, hull points ≲ hundreds); this only rejects a
    // pathological length.
    if (count > OWN_PLAIN_MAX_ARRAY) {
      fail(path, `array length ${count} exceeds OWN_PLAIN_MAX_ARRAY (${OWN_PLAIN_MAX_ARRAY})`);
    }
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(ownPlainData(value[i], `${path}[${i}]`, depth + 1));
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) fail(path, value);
    const out = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      Object.defineProperty(out, key, {
        value: ownPlainData(value[key], `${path}.${key}`, depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  if (typeof value === 'function') fail(path, value);
  return value;
}

/**
 * Spawn pose for an IR dropped onto the EXACTLY-FLAT start pad (elevation 0
 * by the startEnvelope contract — the name states the assumption). The
 * lowest support is either a wheel bottom (center − radius, with the S1
 * quiescent extension included via vehicleWheelTransforms) or, for a
 * zero-wheel sled, the chassis AABB bottom; R2 guarantees wheels win
 * whenever they exist. y = drop + clearance puts the lowest support exactly
 * `clearance` above the pad — the fixtures' (0, 0.05] coherence band.
 */
export function spawnPoseOnFlatStart(ir, options) {
  // Options are destructured INSIDE, not in the parameter list: an explicit
  // `null` hit the `= {}` default only for `undefined` and then threw a
  // foreign TypeError out of destructuring, before this module could say
  // anything. Same ruling as createInitialPopulation's keepRaw — explicit null
  // fails loud in the module's own dialect, absent defaults.
  const opts = options === undefined ? {} : options;
  if (typeof opts !== 'object' || opts === null) fail('spawn', options);
  const { x, z } = opts;
  // ABSENT — and an explicit `undefined`, which is what `{clearance:
  // opts.clearance}` forwarding produces — defaults; an explicit `null` fails
  // like any other non-number (the `??` shape silently substituted the default
  // for null; the `Object.hasOwn` shape over-corrected and rejected undefined,
  // which no sibling optional key does and which broke callers that ran on
  // main). One read, then one comparison.
  const rawClearance = opts.clearance;
  const clearance = rawClearance === undefined ? SPAWN_CLEARANCE : rawClearance;
  // One reading, reported verbatim: `ir.version` was read twice, so a version
  // accessor rejected at 77 was PRINTED as 2 — the currently-valid version, a
  // diagnostic that contradicts the rejection it explains.
  const irVersion = ir ? ir.version : undefined;
  if (!ir || irVersion !== ASSEMBLY_IR_VERSION) fail('ir.version', ir && irVersion);
  if (!Number.isFinite(x)) fail('spawn.x', x);
  if (!Number.isFinite(z)) fail('spawn.z', z);
  if (!Number.isFinite(clearance) || clearance <= 0 || clearance > 0.05) fail('spawn.clearance', clearance);
  // Structural guards for the two shapes dereferenced below — a version-only
  // gate let `{version: 2}` leak a foreign TypeError off `.aabb.min.y`. The
  // production path always passes compileAssembly output (module-owned), so
  // these guard direct callers with hand-built IRs.
  // Each link of the chain is captured as it is checked: the former shape read
  // `ir.chassis` twice, `ir.chassis.aabb` twice and `.min` twice before
  // reaching `.min.y`, so the object that passed the guard need not have been
  // the object the height came from.
  const chassis = ir.chassis;
  const aabb = typeof chassis === 'object' && chassis !== null ? chassis.aabb : null;
  const aabbMin = typeof aabb === 'object' && aabb !== null ? aabb.min : null;
  if (typeof chassis !== 'object' || chassis === null
    || typeof aabb !== 'object' || aabb === null
    || typeof aabbMin !== 'object' || aabbMin === null) {
    fail('ir.chassis', chassis);
  }
  const axles = ir.axles;
  if (!Array.isArray(axles)) fail('ir.axles', axles);
  // Validate the NUMBERS, not only the shapes that hold them. The structural
  // guards above were added because `{version: 2}` leaked a foreign TypeError
  // off `.aabb.min.y`; they made the loud failure loud, and left the SILENT
  // one — a well-shaped `{aabb: {min: {}}}` returned position.y === NaN, and a
  // string min.y was coerced through unary minus. A NaN spawn height is the
  // worst possible output here: it realizes a vehicle at an undefined pose and
  // every downstream metric inherits it. This is the same class the hub-record
  // guards closed one module over; it is enforced here on every scalar this
  // function actually combines, including the ones reached through the
  // adapter's transform records.
  const minY = aabbMin.y;
  if (!Number.isFinite(minY)) fail('ir.chassis.aabb.min.y', minY);
  let drop = -minY; // sled fallback: belly bottom
  // The planner is handed a MODULE-OWNED deep copy of the captured axles, and
  // the wheel records below are read from that same copy — so `t.local.y` and
  // `wheel.radius` cannot come from two different readings.
  //
  // The copy is what makes this module's boundary honest without reaching into
  // the adapter. `vehicleWheelTransforms` reads each axle's suspension, posX,
  // mountY and wheel z several times (measured: `suspension` 4x per axle),
  // which is CORRECT under the standing "the adapter trusts compiler-owned
  // IRs" ruling — it is written for IRs the compiler owns. `spawnPoseOnFlatStart`
  // is a public export that may be handed a caller's IR, so it owns what it
  // passes on rather than extending the single-read rule into the realizer.
  // A minimal `{ axles }` wrapper would NOT be enough: the planner would still
  // be re-reading the caller's own axle objects through it.
  const ownedAxles = ownPlainData(axles, 'ir.axles');
  // Structural pass over the MODULE-OWNED copy before the planner sees it.
  // `Array.isArray(ir.axles)` said nothing about the elements, so `[{}]`,
  // `[null]`, `[42]`, a hole, or a missing `suspension` each left this public
  // seam as a foreign `TypeError: Cannot read properties of undefined` — the
  // exact class the chassis guards above exist to close, one level down. The
  // committed dialect test stopped at an ABSENT axles array.
  for (let i = 0; i < ownedAxles.length; i += 1) {
    const axle = ownedAxles[i];
    if (typeof axle !== 'object' || axle === null) fail(`ir.axles[${i}]`, axle);
    // vehicleWheelTransforms dereferences `axle.suspension.type`; a missing or
    // null suspension escaped as a foreign TypeError (round-11 I9 — the comment
    // listed suspension as covered, the code did not guard it).
    if (typeof axle.suspension !== 'object' || axle.suspension === null) {
      fail(`ir.axles[${i}].suspension`, axle.suspension);
    }
    if (!Array.isArray(axle.wheels)) fail(`ir.axles[${i}].wheels`, axle.wheels);
    for (let w = 0; w < axle.wheels.length; w += 1) {
      const wheel = axle.wheels[w];
      if (typeof wheel !== 'object' || wheel === null) fail(`ir.axles[${i}].wheels[${w}]`, wheel);
    }
  }
  for (const t of vehicleWheelTransforms({ axles: ownedAxles }, {})) {
    const wheel = ownedAxles[t.axleIndex].wheels[t.wheelIndex];
    const radius = wheel.radius;
    const localY = t.local.y;
    if (!Number.isFinite(radius)) {
      fail(`ir.axles[${t.axleIndex}].wheels[${t.wheelIndex}].radius`, radius);
    }
    if (!Number.isFinite(localY)) {
      fail(`ir.axles[${t.axleIndex}].wheels[${t.wheelIndex}] local.y`, localY);
    }
    drop = Math.max(drop, radius - localY);
  }
  if (!Number.isFinite(drop)) fail('ir (derived spawn drop)', drop);
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
  // ONE enumeration, and it is the one the consumer reads with. The presence
  // gate used `hasOwnProperty`, which ALSO sees non-enumerable own properties,
  // while the terrain that actually runs comes from `{ ...TERRAIN_DEFAULTS,
  // ...terrain }` — own ENUMERABLE only. Measured (round-11), with an ordinary
  // `Object.defineProperty(t, 'seed', { value: 20260722 })` and no Proxy: this
  // guard passed, the spread dropped the property, and `evaluatePopulation`
  // resolved `spec.terrain.seed = 0` — running and digesting the DEFAULT
  // terrain, byte-identical to an explicit seed-0 run. The same shape reverted
  // any non-enumerable known knob (featureDensity 0 silently became 0.4).
  // The general rule: a guard that decides presence must use the same property
  // enumeration its consumer reads with.
  // The terrain must be ordinary: a custom prototype carrying enumerable knobs
  // would be dropped by the generation spread and revert to defaults.
  const tProto = Object.getPrototypeOf(terrain);
  if (tProto !== Object.prototype && tProto !== null) fail('terrain', 'must be a plain object');
  const terrainKeys = Object.keys(terrain);
  // …and nothing may hide OUTSIDE that enumeration. Without this, a
  // non-enumerable known knob (`featureDensity`) still reverted to its default
  // silently while the spec digest attested the reverted value — the same
  // silently-wrong-terrain class, one knob over from `seed`.
  if (Object.getOwnPropertyNames(terrain).length !== terrainKeys.length) {
    fail('terrain', 'carries non-enumerable own properties (the resolved terrain reads own enumerable keys only)');
  }
  // CAPTURE ONCE: read each own-enumerable value into a module-owned object, and
  // derive BOTH the seed-presence guard and the resolved terrain from that
  // single reading. The old shape enumerated the caller TWICE — the presence
  // walk here, then the `{ ...terrain }` spread at line ~550 — so an accessor on
  // an earlier key could `delete this.seed` between them: the guard saw seed
  // present, the spread dropped it, and evaluatePopulation attested the DEFAULT
  // seed-0 world (round-11 I1, measured). The captured seed value, if deleted
  // mid-walk, becomes `undefined` and fails loud at validateConfig, never a
  // silent default.
  const capturedTerrain = {};
  for (let i = 0; i < terrainKeys.length; i += 1) {
    const k = terrainKeys[i];
    if (!Object.prototype.hasOwnProperty.call(TERRAIN_DEFAULTS, k)) fail(`terrain.${k}`, 'unknown key');
    // k is a known TERRAIN_DEFAULTS key (never `__proto__`); defineProperty for
    // uniformity with the rest of the ownership boundary.
    Object.defineProperty(capturedTerrain, k, {
      value: terrain[k], writable: true, enumerable: true, configurable: true,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(capturedTerrain, 'seed')) {
    fail('terrain.seed', 'missing (a fitness vector must never bind the default seed by accident)');
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 0xffffffff) fail('maxSteps', maxSteps);
  if (typeof deterministic !== 'boolean') fail('deterministic', deterministic);
  if (typeof spawn !== 'object' || spawn === null) fail('spawn', spawn);
  for (const k of Object.keys(spawn)) {
    if (!SPAWN_SPEC_KEYS.includes(k)) fail(`spawn.${k}`, 'unknown key');
  }
  // Absent (or explicitly `undefined`) defaults; an EXPLICIT null fails like
  // any other non-number — the `??` shape silently substituted the default for
  // null, and the `Object.hasOwn` shape additionally rejected `undefined`,
  // which the five sibling optional keys here accept via destructuring.
  const rawClearance = spawn.clearance;
  const clearance = rawClearance === undefined ? SPAWN_CLEARANCE : rawClearance;
  // Capture every spawn scalar ONCE. The guard, the flat-pad comparison, the
  // error text, and the returned resolved spec must all be the same reading:
  // measured (round-10), an `x` accessor answering -44 for the first three
  // reads and 100 afterwards passed the flat-pad guard and then EXECUTED the
  // vehicle at x=100, off the pad, with the fitness vector's spec digest
  // attesting the position that never ran. That is an execution-constraint
  // bypass, not a codec asymmetry.
  const spawnX = spawn.x;
  const spawnZ = spawn.z;
  if (!Number.isFinite(spawnX)) fail('spawn.x', spawnX);
  if (!Number.isFinite(spawnZ)) fail('spawn.z', spawnZ);
  if (!Number.isFinite(clearance) || clearance <= 0 || clearance > 0.05) fail('spawn.clearance', clearance);
  if (!Number.isFinite(targetWheelSurfaceSpeed)) fail('targetWheelSurfaceSpeed', targetWheelSurfaceSpeed);
  if (!Number.isFinite(wheelFriction) || wheelFriction < 0) fail('wheelFriction', wheelFriction);
  if (typeof hooks !== 'object' || hooks === null) fail('hooks', hooks);
  for (const k of Object.keys(hooks)) {
    if (!HOOK_KEYS.includes(k)) fail(`hooks.${k}`, 'unknown key');
  }
  const onIndividual = hooks.onIndividual;
  if (onIndividual !== undefined && typeof onIndividual !== 'function') {
    fail('hooks.onIndividual', onIndividual);
  }
  const resolvedTerrain = ownTerrain({ ...TERRAIN_DEFAULTS, ...capturedTerrain });
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
  if (spawnX - SPAWN_PAD_MARGIN < padStart || spawnX + SPAWN_PAD_MARGIN > padEnd) {
    fail('spawn.x', `${spawnX} must sit >= ${SPAWN_PAD_MARGIN} m inside the flat pad [${padStart}, ${padEnd}]`);
  }
  return {
    deterministic,
    termination, // validated against TERMINATIONS above; defaults to the only value
    maxSteps,
    spawn: { x: spawnX, z: spawnZ, clearance },
    targetWheelSurfaceSpeed,
    wheelFriction,
    terrain: resolvedTerrain,
    onIndividual: onIndividual ?? null,
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
      // BOUND BEFORE ALLOCATE — the same ordering ruling serializeEvaluationSpec
      // states for its own u8 check, applied here because THIS is the
      // production `evaluatePopulation -> resolveSpec` path and it runs FIRST.
      // Measured (round-11): a sparse genuine Array declaring length 2^26 costs
      // the caller nothing and densifies here into a `FATAL ERROR: heap limit`
      // V8 abort — uncatchable, before any value is validated. Every terrain
      // range is a 2-element pair (validateConfig refuses anything else), so
      // the wire bound rejects only inputs already doomed downstream.
      const declared = v.length;
      if (!Number.isInteger(declared) || declared < 0 || declared > 0xff) {
        fail(`terrain.${k}.length`, `${declared} exceeds the u8 wire bound (255)`);
      }
      const copy = [];
      for (let i = 0; i < declared; i += 1) copy.push(v[i]);
      out[k] = Object.freeze(copy);
    } else if (v !== null && typeof v === 'object') {
      // A nested knob object (featureTypeWeights) must be ordinary plain data.
      // The old `{ ...v }` was safe against an own `__proto__` key but silently
      // DROPPED a non-enumerable own key or an inherited enumerable one, which
      // generateCorridorTerrain then read as a missing (0/default) weight while
      // the digest attested it — the silently-wrong-terrain class one level down
      // (round-11).
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) fail(`terrain.${k}`, 'must be a plain object');
      if (Object.getOwnPropertyNames(v).length !== Object.keys(v).length) {
        fail(`terrain.${k}`, 'carries non-enumerable own properties');
      }
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
  // EVERY spec scalar is captured once here and the write pass below consumes
  // only these locals. Guarding one reading and writing another let a spec be
  // validated as one run and encoded as a different one — and the digest folded
  // over those bytes then attested the run that never happened.
  const termination = s.termination;
  const maxSteps = s.maxSteps;
  const deterministic = s.deterministic;
  const targetWheelSurfaceSpeed = s.targetWheelSurfaceSpeed;
  const wheelFriction = s.wheelFriction;
  const term = TERMINATIONS.indexOf(termination);
  if (term < 0) fail('termination', termination);
  // maxSteps is a u32 on the wire — reject anything that would silently wrap
  // (a public export cannot assume it was routed through resolveSpec).
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 0xffffffff) fail('maxSteps', maxSteps);
  // deterministic selects the PHYSICS FLAVOR — a strict boolean, never
  // truthiness. The former `s.deterministic ? 1 : 0` silently flipped the
  // field's meaning for plausible wrong types: the string 'false' and a boxed
  // `new Boolean(false)` (which PRINTS as false) both encoded as true, so
  // deserialize(serialize(spec)) was no longer semantically the input, and
  // the digest attested the wrong engine. resolveSpec already requires a
  // strict boolean; the public encoder must too.
  if (typeof deterministic !== 'boolean') fail('deterministic', deterministic);
  // spawn: structural guard (spawn: null leaked a foreign TypeError), then its
  // three scalars captured once each — the write pass never dereferences the
  // caller's spawn again.
  const spawn = s.spawn;
  if (typeof spawn !== 'object' || spawn === null) fail('spawn', spawn);
  const spawnX = spawn.x;
  const spawnZ = spawn.z;
  const spawnClearance = spawn.clearance;

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
  // EVERY terrain value — not only the ranges — is materialized here, once,
  // and the write pass reads exclusively from `captured`. The ranges were
  // already snapshotted for the size/write agreement; the scalars were not, so
  // `terrain[key]` was still read twice for every uint32 and f64 knob.
  const captured = new Map();
  let size = 2 + 1 + 1 + 4 + 8 * 5 + 1;
  for (const [key, kind] of TERRAIN_SPEC_WALK) {
    const v = terrain[key];
    if (kind === 'uint32') {
      captured.set(key, v);
      size += 4;
    } else if (kind === 'f64') {
      captured.set(key, v);
      size += 8;
    } else if (kind === 'range') {
      if (v === null || typeof v !== 'object') fail(`terrain.${key}`, v);
      const declared = v.length;
      if (!Number.isInteger(declared) || declared < 0 || declared > 0xff) {
        fail(`terrain.${key}.length`, `${declared} exceeds the u8 wire bound (255)`);
      }
      const values = [];
      for (let i = 0; i < declared; i += 1) values.push(v[i]);
      captured.set(key, values);
      size += 1 + values.length * 8;
    } else { // weights
      // Structural guard before Object.keys — a null/scalar weights object
      // leaked a foreign TypeError here (the spawn/terrain guard ruling).
      if (typeof v !== 'object' || v === null) fail(`terrain.${key}`, v);
      const keys = Object.keys(v);
      if (keys.length !== WEIGHT_KEYS.length || !WEIGHT_KEYS.every((k) => keys.includes(k))) {
        fail(`terrain.${key}`, `keys [${keys}] must equal the declared [${WEIGHT_KEYS}]`);
      }
      const weights = [];
      for (let i = 0; i < WEIGHT_KEYS.length; i += 1) weights.push(v[WEIGHT_KEYS[i]]);
      captured.set(key, weights);
      size += 1 + WEIGHT_KEYS.length * (1 + 8);
    }
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
  view.setUint8(o, deterministic ? 1 : 0); o += 1;
  view.setUint8(o, term); o += 1;
  view.setUint32(o, maxSteps, true); o += 4;
  f64(spawnX, 'spawn.x');
  f64(spawnZ, 'spawn.z');
  f64(spawnClearance, 'spawn.clearance');
  f64(targetWheelSurfaceSpeed, 'targetWheelSurfaceSpeed');
  f64(wheelFriction, 'wheelFriction');
  view.setUint8(o, TERRAIN_SPEC_WALK.length); o += 1;
  for (const [key, kind] of TERRAIN_SPEC_WALK) {
    const v = captured.get(key);
    if (kind === 'uint32') {
      // isCanonicalUint32 rejects -0: setUint32 erases the sign bit, so a -0
      // seed encoded as +0 and decoded back as +0 — a silent normalization
      // that breaks the Object.is leaf-equality the round trip claims.
      if (!isCanonicalUint32(v)) fail(`terrain.${key}`, v);
      view.setUint32(o, v, true); o += 4;
    } else if (kind === 'f64') {
      f64(v, `terrain.${key}`);
    } else if (kind === 'range') {
      // The MATERIALIZED values from the size pass — count and payload cannot
      // disagree, because they are the same array. Indexed here too: this
      // module never reads a length from one place and content from another.
      view.setUint8(o, v.length); o += 1;
      for (let i = 0; i < v.length; i += 1) f64(v[i], `terrain.${key}[]`);
    } else { // weights
      // Also materialized in the size pass (structure and key set validated
      // there); these are module-owned values in declared order.
      view.setUint8(o, WEIGHT_KEYS.length); o += 1;
      for (let i = 0; i < WEIGHT_KEYS.length; i += 1) {
        view.setUint8(o, i); o += 1;
        f64(v[i], `terrain.${key}.${WEIGHT_KEYS[i]}`);
      }
    }
  }
  // receiver `view` is the module-owned DataView this encoder allocated.
  // eslint-disable-next-line no-restricted-syntax
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
  // ONE walk of the caller's population produces both the canonical bytes and
  // the module-owned genotypes those bytes describe (each decoded from the
  // stream the canonicality tooth approved). The former shape validated,
  // compiled from `ind.genotype`, and then serialized the caller's population
  // again — four independent reads backing one attestation, so the digest
  // bound whatever the LAST read returned rather than what was evaluated.
  const { individuals: sorted, bytes: snapshotBytes } = attestPopulation(population);
  const snapshotState = fnv1aFold(FNV_OFFSET_BASIS, snapshotBytes);
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

  // (The snapshot bytes and their digest state were captured by
  // attestPopulation at the very top, before anything else touched the input:
  // a hook — or any caller retaining the input — can mutate a genotype after
  // it was compiled, and the simulations run the compiled IR, so the returned
  // fitness vector must bind the population that was actually evaluated. The
  // IRs below are compiled from those same attested bytes, so "what ran" and
  // "what was hashed" are one object rather than two agreeing reads.)
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
    fitnessPolicyVersion: FITNESS_POLICY_VERSION,
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
  // ONE reading: the object whose PRESENCE selects this branch is the object
  // that is serialized and folded. Two reads let the branch be chosen by spec A
  // while the vector attested spec B (measured, round-11) — and the documented
  // twin `resolvePopulationDigestState` already takes its population as a
  // captured parameter for exactly this reason.
  const spec = evaluation.spec;
  if (spec !== undefined) {
    const specBytes = serializeEvaluationSpec(spec);
    const state = fnv1aFold(FNV_OFFSET_BASIS, specBytes);
    if (declared !== undefined && declared !== state) {
      fail('evaluation.evaluationSpecDigestState',
        `${declared} disagrees with the spec's computed state ${state}`);
    }
    return state;
  }
  if (!isCanonicalUint32(declared)) {
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
  if (!isCanonicalUint32(populationSnapshotDigestState)) {
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
  const count = individuals.length;
  for (let i = 0; i < count; i += 1) {
    const ind = individuals[i];
    if (typeof ind !== 'object' || ind === null) fail(`evaluation.individuals[${i}]`, ind);
    // ALL FOUR FIELDS CAPTURED BEFORE ANY CHECK. The former shape read each
    // one two or three times — the guard, the coherence tooth, and then again
    // when building the "module-owned" row — so the row could carry values no
    // check had seen. Measured (round-10): a `valid` getter answering
    // true, true, false was guarded as valid and ENCODED as invalid-carrying-
    // fitness-1, a member combination the decoder correctly refuses; the
    // encoder produced bytes its own inverse rejects.
    const individualId = ind.individualId;
    const valid = ind.valid;
    const integrityStatus = ind.integrityStatus;
    const fitness = ind.fitness;
    if (!isCanonicalUint32(individualId)) fail('individualId', individualId);
    if (i > 0 && !(individualId > rows[i - 1].individualId)) {
      fail(`evaluation.individuals[${i}].individualId`, 'must be strictly ascending');
    }
    if (typeof valid !== 'boolean') fail(`individual ${individualId} valid`, valid);
    const statusIndex = INTEGRITY_STATUS.indexOf(integrityStatus);
    if (statusIndex === -1) fail(`individual ${individualId} integrityStatus`, integrityStatus);
    // The fitness contract is a non-negative finite score: NaN/Infinity would
    // emit implementation-defined bytes (the cross-engine hazard the codec
    // exists to prevent), and a negative fitness contradicts the max-progress
    // policy (maxForwardDistance ≥ 0, unselectable ⇒ 0). Reject an internally
    // contradictory vector rather than faithfully serialize it: fitness must
    // be 0 unless the member is BOTH valid and integrity-clean (policy v2).
    if (!isCanonicalFitness(fitness)) fail(`individual ${individualId} fitness`, fitness);
    if ((!valid || integrityStatus !== 'ok') && fitness !== 0) {
      fail(`individual ${individualId} fitness`,
        `unselectable individual (valid ${valid}, integrity ${integrityStatus}) must have fitness 0, got ${fitness}`);
    }
    rows.push({
      individualId, valid, statusIndex, fitness,
    });
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
  // receiver `view` is the module-owned DataView this encoder allocated.
  // eslint-disable-next-line no-restricted-syntax
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
  // r.byteLength is the INTRINSIC geometry the reader captured. Reading
  // `bytes.byteLength` here read the caller-shadowable accessor instead, so an
  // own data property made this identity reject a byte-identical, perfectly
  // valid canonical vector — a decoder stricter than its own encoder, which is
  // the exact-inverse claim failing in the direction nobody tests for.
  const expected = fitnessVectorByteLength(count);
  // receiver `r` is the module-owned reader; this getter IS the captured
  // intrinsic length.
  // eslint-disable-next-line no-restricted-syntax
  const actualLength = r.byteLength;
  if (actualLength !== expected) {
    vectorDecodeFail('byteLength', `${actualLength} (expected ${expected} for count ${count})`);
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
 * The row contract BOTH champion selectors order by, checked once here so the
 * two cannot drift and so every field a comparator touches is validated before
 * any comparison happens.
 *
 * Why the fitness check is not optional: `>` and `!==` against NaN are both
 * false, so a single NaN row makes the ordering non-total and POSITION
 * DEPENDENT — whichever row is seen first wins and nothing can displace it.
 * Both selectors document a total order robust to input arrangement; without
 * this, that documentation was false for one input value. The individualId
 * check matters for the same reason one level down: it is the tie-breaker, so
 * a non-canonical id makes ties resolve by an uncomparable value.
 *
 * Each field is captured ONCE into a module-owned candidate and the
 * comparators read only those captures — validating a field and then re-reading
 * it to compare is the defect `serializeFitnessVector`'s indexed preflight
 * exists to prevent, applied at the encoder and skipped at the two SELECTION
 * entry points, which is precisely where a comparator seeing a different value
 * than its validator decides which genome breeds. An own accessor on a plain
 * object is ordinary JavaScript, not a Proxy.
 *
 * `source` is the caller's original row, and the selectors RETURN it: these
 * helpers have always handed back the winning evaluation row, production rows
 * carry a full `diagnostics` block, and the diagnostic selector exists to serve
 * reports — so returning a four-field summary would silently narrow a working
 * API under cover of hardening. Owned values decide; the caller's row is what
 * comes back.
 *
 * The domain is the fitness vector encoder's, so a row that could not be
 * SERIALIZED cannot be RANKED either: canonical id, strict boolean validity,
 * KNOWN integrity status, finite non-negative fitness, and the policy-v2
 * coherence rule that an unselectable member carries fitness 0. (The diagnostic
 * selector may still surface an unselectable row at a zero-fitness tie — that
 * is its documented job — but never an internally contradictory one.)
 */
function championCandidate(ind, i) {
  if (typeof ind !== 'object' || ind === null) fail(`evaluation.individuals[${i}]`, ind);
  const individualId = ind.individualId;
  if (!isCanonicalUint32(individualId)) {
    fail(`evaluation.individuals[${i}].individualId`, individualId);
  }
  const valid = ind.valid;
  if (typeof valid !== 'boolean') fail(`individual ${individualId} valid`, valid);
  const integrityStatus = ind.integrityStatus;
  if (!INTEGRITY_STATUS.includes(integrityStatus)) {
    fail(`individual ${individualId} integrityStatus`, integrityStatus);
  }
  const fitness = ind.fitness;
  if (!isCanonicalFitness(fitness)) fail(`individual ${individualId} fitness`, fitness);
  if ((!valid || integrityStatus !== 'ok') && fitness !== 0) {
    fail(`individual ${individualId} fitness`,
      `unselectable individual (valid ${valid}, integrity ${integrityStatus}) must have fitness 0, got ${fitness}`);
  }
  return {
    source: ind, individualId, valid, fitness, integrityStatus,
  };
}

/**
 * ONE capture of a caller's evaluation into module-owned candidate rows,
 * shared by both selectors.
 *
 * `evaluation.individuals` is read exactly once — the guard and the loop used
 * to read it separately, so the collection that was gated need not have been
 * the collection that was ranked (an empty second read even produced the
 * documented "no selectable individual" null for a population that had one).
 * The cardinality is captured too: a row accessor that appends during the walk
 * cannot extend a loop bound that was already fixed.
 *
 * IDs must be UNIQUE. Both comparators use `individualId` as the final
 * tie-breaker, so two otherwise-equal rows sharing an id leave neither
 * outranking the other and the FIRST one wins — making the result depend on
 * input arrangement, contradicting both the documented total order and the
 * permutation invariance these selectors claim. The fitness vector encoder
 * already rejects duplicates through its strictly-ascending id rule, so this
 * is the same domain: a collection that could not be SERIALIZED must not be
 * RANKED.
 */
function championCandidates(evaluation) {
  if (typeof evaluation !== 'object' || evaluation === null) {
    fail('evaluation.individuals', evaluation);
  }
  const individuals = evaluation.individuals;
  if (!Array.isArray(individuals)) fail('evaluation.individuals', individuals);
  const count = individuals.length;
  if (count === 0) fail('evaluation.individuals', individuals);
  const seen = new Set();
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const row = championCandidate(individuals[i], i);
    if (seen.has(row.individualId)) {
      fail(`evaluation.individuals[${i}].individualId`, `duplicate ${row.individualId}`);
    }
    seen.add(row.individualId);
    rows.push(row);
  }
  return rows;
}

function freezeSelectionPool(value) {
  for (let i = 0; i < value.individuals.length; i += 1) Object.freeze(value.individuals[i]);
  Object.freeze(value.evaluatedIndividualIds);
  Object.freeze(value.individuals);
  return Object.freeze(value);
}

/**
 * Capture the eligible portion of one evaluation into an owned, immutable
 * selection pool. The snapshot state is captured before championCandidates
 * touches a row, so the pool cannot bind row data to a later digest reading.
 */
export function selectablePoolFromEvaluation(evaluation) {
  if (typeof evaluation !== 'object' || evaluation === null) {
    fail('evaluation', evaluation);
  }
  const fitnessPolicyVersion = evaluation.fitnessPolicyVersion;
  if (fitnessPolicyVersion !== FITNESS_POLICY_VERSION) {
    fail('evaluation.fitnessPolicyVersion', fitnessPolicyVersion);
  }
  const populationSnapshotDigestState = evaluation.populationSnapshotDigestState;
  if (!isCanonicalUint32(populationSnapshotDigestState)) {
    fail('evaluation.populationSnapshotDigestState', populationSnapshotDigestState);
  }
  // Exactly one evaluation-row capture. It validates row shape, ids,
  // fitness, validity and integrity coherence before we retain any value.
  const rows = championCandidates(evaluation);
  rows.sort((a, b) => a.individualId - b.individualId);
  const evaluatedIndividualIds = [];
  const individuals = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    evaluatedIndividualIds.push(row.individualId);
    if (row.valid && row.integrityStatus === 'ok') {
      individuals.push({ individualId: row.individualId, fitness: row.fitness });
    }
  }
  return freezeSelectionPool({
    selectionPoolVersion: SELECTION_POOL_VERSION,
    fitnessPolicyVersion,
    populationSnapshotDigestState,
    evaluatedIndividualIds,
    individuals,
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
  const better = (a, b) => {
    if (a.fitness !== b.fitness) return a.fitness > b.fitness;
    if (a.valid !== b.valid) return a.valid; // valid outranks invalid on a fitness tie
    return a.individualId < b.individualId;
  };
  const rows = championCandidates(evaluation);
  let champion = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (champion === null || better(row, champion)) champion = row;
  }
  // The caller's original row — complete with diagnostics — chosen by
  // module-owned values.
  return champion.source;
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
  // This is the SELECTION entry point, so the rows it judges must be the rows
  // every other consumer reads — one capture, unique ids, indexed.
  const rows = championCandidates(evaluation);
  let champion = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!(row.valid && row.integrityStatus === 'ok')) continue;
    if (champion === null
      || row.fitness > champion.fitness
      || (row.fitness === champion.fitness && row.individualId < champion.individualId)) {
      champion = row;
    }
  }
  // null when no selectable individual exists (the explicit Phase-1B
  // condition); otherwise the caller's own winning row.
  return champion === null ? null : champion.source;
}
