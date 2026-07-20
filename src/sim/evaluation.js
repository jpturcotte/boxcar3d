// The canonical headless vehicle-evaluation runner — the ONE simulation loop
// (every earlier test inlined its own `for (...) world.step()`; new
// determinism gates, the Chromium gate, the benchmark, and later GA/replay
// work all call this instead).
//
// Wall-clock-free by construction (the src/sim ESLint ban applies): time is
// physics-step counting, and the only timing that flows OUT is Rapier's own
// engine profiler readback (engine state, allowed through results). Callers
// that need elapsed-time brackets own them: `hooks.onPhase(name)` fires at
// each phase boundary with the phase NAME ONLY — no timestamp ever crosses
// the seam.
//
// Step-index contract: capture indices 0..maxSteps. Index 0 is the
// post-realization, pre-first-step state — spawn placement itself is under
// the digest, so a realizer regression is caught even if dynamics happen to
// reconverge, and replay tooling gets its initial condition. Index k is the
// state after k evaluation `world.step()` calls, read post-step. The one
// statics-only pre-step (the [V1] query-BVH idiom) is setup and appears in no
// count. A maxSteps=N digest run therefore carries N+1 capture batches.
//
// Termination: the run ALWAYS executes exactly maxSteps evaluation steps —
// no data-dependent early exit (it would make digests structurally
// incomparable between near-identical runs; stepping NaN bodies is bounded
// cost, and physics cannot pause one vehicle anyway). A vehicle that goes
// non-finite LATCHES {step, reason:'nonFinite'} at the first bad capture and
// keeps being stepped AND traced with the terminated bit set — the record
// count stays shape-static and the NaN bytes are the forensic evidence.
//
// dt contract (MEASURED, scripts/probe-rapier-timing.js): the engine stores
// the timestep as f32 — `world.timestep = 1/60` reads back Math.fround(1/60),
// NOT the f64 1/60. The tooth below asserts that measured readback; results
// carry {requestedDt, effectiveDt}.

import {
  FIXED_DT, createPhysics, addCorridor, addCorridorWithFeatures, realizeVehicle,
} from './physics/adapter.js';
import { generateCorridorTerrain, TERRAIN_DEFAULTS } from './terrain.js';
import { EVALUATION_TRACE_VERSION, MAX_STEP_INDEX, TERMINATION_REASONS, TRACE_MODES, TraceWriter } from './trace.js';
import { createIntegrityState, finalizeIntegrity, foldIntegrity } from './integrity.js';

export { EVALUATION_TRACE_VERSION, TERMINATION_REASONS }; // one import point for consumers

// Run-level termination (a different axis from the per-vehicle
// TERMINATION_REASONS): v1 always completes its declared step budget.
export const RUN_TERMINATION = Object.freeze({ COMPLETED: 'completed' });

function fail(path, value) {
  throw new Error(`evaluation: invalid options at ${path} (${String(value)})`);
}

const OPTION_KEYS = Object.freeze([
  'deterministic', 'terrain', 'vehicles', 'maxSteps', 'termination', 'trace', 'profile', 'hooks',
]);
const VEHICLE_KEYS = Object.freeze(['ir', 'spawn', 'targetWheelSurfaceSpeed', 'wheelFriction']);
const SPAWN_KEYS = Object.freeze(['position', 'rotation', 'linvel']);
const TRACE_KEYS = Object.freeze(['mode', 'checkpointInterval']);
const HOOK_KEYS = Object.freeze(['onPhase']);

function checkUnknownKeys(obj, allowed, path) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${path}.${k}`, 'unknown key');
  }
}

// One walk over the caller's terrain that captures what it validates, so the
// terrain that is GENERATED is the terrain that was guarded. The enumeration
// is `Object.keys` — deliberately the SAME enumeration
// generateCorridorTerrain's `{ ...TERRAIN_DEFAULTS, ...terrain }` performs.
// The presence gate used `hasOwnProperty`, which ALSO sees non-enumerable own
// properties, so an ordinary `Object.defineProperty(t, 'seed', { value })` —
// plain data, no Proxy — passed the "must never bind the default seed" guard
// and then vanished from the spread: measured, the run generated and digested
// the seed-0 DEFAULT terrain with no error. A guard that decides presence must
// use the same property enumeration its consumer reads with.
const TERRAIN_RANGE_MAX = 0xff;
const QUAT_KEYS = ['x', 'y', 'z', 'w'];
const VEC3_KEYS = ['x', 'y', 'z'];

// Capture the components realizeVehicle reads into a module-owned object, so
// the spawn pose the unit-quaternion gate validates is the pose the placement
// math executes (round-11 I2). A non-object passes through unchanged.
function captureSpawnComponents(v, keys) {
  if (typeof v !== 'object' || v === null) return v;
  const out = {};
  for (let i = 0; i < keys.length; i += 1) out[keys[i]] = v[keys[i]];
  return out;
}

// A terrain sub-object (e.g. featureTypeWeights) must be ORDINARY plain data:
// a plain/null prototype and own-enumerable string keys only.
// generateCorridorTerrain reads these by specific key, so a non-enumerable own
// key or an inherited enumerable one would be silently dropped from the
// module-owned copy and revert to a default while the digest attested it — the
// silently-wrong-terrain class (round-11 I4/I5). Copied via spread
// (CreateDataProperty), which — unlike `sub[k] = v[k]` — never invokes the
// inherited `__proto__` SETTER, so an own `__proto__` key cannot re-prototype
// the copy.
function ownPlainTerrainSub(v, path) {
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) fail(path, 'must be a plain object');
  if (Object.getOwnPropertyNames(v).length !== Object.keys(v).length) {
    fail(path, 'carries non-enumerable own properties');
  }
  return { ...v };
}

function ownTerrainOptions(terrain) {
  const allowed = Object.keys(TERRAIN_DEFAULTS);
  // The terrain itself must be ordinary: a custom prototype carrying enumerable
  // knobs would be dropped by the `{ ...TERRAIN_DEFAULTS, ...terrain }` spread
  // and revert to defaults while the digest attested them.
  const tProto = Object.getPrototypeOf(terrain);
  if (tProto !== Object.prototype && tProto !== null) fail('terrain', 'must be a plain object');
  const keys = Object.keys(terrain);
  // Nothing may hide outside the enumeration the spread reads: a non-enumerable
  // known knob would otherwise revert to its default silently while the digest
  // attested the reverted value.
  if (Object.getOwnPropertyNames(terrain).length !== keys.length) {
    fail('terrain', 'carries non-enumerable own properties (the generated terrain reads own enumerable keys only)');
  }
  const out = {};
  let sawSeed = false;
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (!allowed.includes(k)) fail(`terrain.${k}`, 'unknown key');
    if (k === 'seed') sawSeed = true;
    const v = terrain[k];
    if (Array.isArray(v)) {
      // Bound before allocate (the encoders' ruling), then an indexed copy —
      // never `.slice()`, which is looked up on the caller's array.
      const declared = v.length;
      if (!Number.isInteger(declared) || declared < 0 || declared > TERRAIN_RANGE_MAX) {
        fail(`terrain.${k}.length`, `${declared} exceeds ${TERRAIN_RANGE_MAX}`);
      }
      const copy = [];
      for (let j = 0; j < declared; j += 1) copy.push(v[j]);
      out[k] = copy;
    } else if (typeof v === 'object' && v !== null) {
      out[k] = ownPlainTerrainSub(v, `terrain.${k}`);
    } else {
      out[k] = v;
    }
  }
  if (!sawSeed) {
    fail('terrain.seed', 'missing (a digest must never bind to the default seed by accident)');
  }
  return out;
}

// All validation is PRE-WORLD: a typo'd option (linVel, checkpointinterval …)
// must fail loud here, never silently change a digest.
//
// It returns a MODULE-OWNED capture, not the caller's objects. Returning
// `terrain`/`vehicles` by reference meant runEvaluation re-read them after
// `hooks.onPhase(...)` (caller code) and across `await createPhysics(...)`, so
// the validated reading and the executed reading were different ones. Measured
// (round-11), all with an ordinary own accessor on a plain object or a genuine
// Array: a run validated with `trace.mode:'none'` executed in `'full'`; a spawn
// validated at x=-25 realized at x=-13; a 6-axle IR was guarded and a 0-axle
// sled realized; a vehicle carrying the removed `targetAngvel` tombstone
// realized silently at the default surface speed; and a terrain validated at
// seed 20260722 executed at seed 999 with a digest byte-identical to the
// seed-999 control. Indexing the vehicle loop (round-9) fixed holes and
// iterator divergence — it did not make the two readings one.
//
// `ir` is captured BY REFERENCE, deliberately: the standing ruling is that the
// adapter trusts compiler-owned IRs, and the production caller compiles them.
// What matters here is that it is captured ONCE, so the IR that was guarded is
// the IR that is realized.
function validateOptions(options) {
  if (typeof options !== 'object' || options === null) fail('options', options);
  checkUnknownKeys(options, OPTION_KEYS, 'options');
  const {
    deterministic = false, terrain, vehicles, maxSteps,
    termination = 'maxSteps', trace = { mode: 'none' }, profile = false, hooks = {},
  } = options;
  if (typeof deterministic !== 'boolean') fail('deterministic', deterministic);
  if (typeof terrain !== 'object' || terrain === null) fail('terrain', terrain);
  // Unknown terrain keys are rejected HERE, consistent with the runner's other
  // option objects: generateCorridorTerrain spreads `{ ...TERRAIN_DEFAULTS,
  // ...terrain }` and silently ignores extras, so a typo'd knob (e.g.
  // `featureDensitty`) would otherwise run the DEFAULT terrain while producing
  // a valid digest — the exact silently-wrong-terrain class fail-loud prevents.
  // Domain validation of the values themselves stays delegated to
  // generateCorridorTerrain's function-wide validateConfig.
  const ownedTerrain = ownTerrainOptions(terrain);
  if (!Array.isArray(vehicles) || vehicles.length === 0) fail('vehicles', vehicles);
  const vehicleCount = vehicles.length; // bound captured: the body reads caller code
  // INDEXED, never forEach: forEach SKIPS HOLES, while the length guard above
  // and the realization/step loops below are index-based. A sparse `vehicles`
  // (a genuine Array grown by a `length` assignment — exactly what a
  // structural operator produces) bypassed every per-vehicle guard here and
  // then died as a foreign TypeError deep inside realization. Same defect the
  // population layer's validateGenotype/resolvePolicy walks already fixed;
  // this is the runner's copy of it.
  const ownedVehicles = [];
  for (let i = 0; i < vehicleCount; i += 1) {
    const v = vehicles[i];
    if (typeof v !== 'object' || v === null) fail(`vehicles[${i}]`, v);
    // Migration tombstone BEFORE the generic key check: a stale caller using
    // the removed drive option must get the rename diagnosis, not a generic
    // "unknown key".
    if (Object.hasOwn(v, 'targetAngvel')) {
      fail(`vehicles[${i}].targetAngvel`, 'removed; use targetWheelSurfaceSpeed');
    }
    checkUnknownKeys(v, VEHICLE_KEYS, `vehicles[${i}]`);
    // Capture every field ONCE, here, and hand realization these captures.
    const ir = v.ir;
    const spawn = v.spawn;
    const targetWheelSurfaceSpeed = v.targetWheelSurfaceSpeed;
    const wheelFriction = v.wheelFriction;
    if (typeof ir !== 'object' || ir === null) fail(`vehicles[${i}].ir`, ir);
    if (typeof spawn !== 'object' || spawn === null) fail(`vehicles[${i}].spawn`, spawn);
    checkUnknownKeys(spawn, SPAWN_KEYS, `vehicles[${i}].spawn`);
    const p = spawn.position;
    const rotation = spawn.rotation;
    const linvel = spawn.linvel;
    if (typeof p !== 'object' || p === null) fail(`vehicles[${i}].spawn.position`, JSON.stringify(p));
    const px = p.x; const py = p.y; const pz = p.z;
    if (![px, py, pz].every((c) => typeof c === 'number' && Number.isFinite(c))) {
      fail(`vehicles[${i}].spawn.position`, JSON.stringify({ x: px, y: py, z: pz }));
    }
    // rotation/linvel/targetWheelSurfaceSpeed/wheelFriction are validated in
    // depth by realizeVehicle — the existing thorough, message-rich gate. Their
    // COMPONENTS are captured here, exactly as spawn.position is two lines up:
    // storing the caller's `rotation`/`linvel` OBJECT by reference (round-11's
    // gap) let realizeVehicle read each component ~25/7 more times — the
    // unit-quaternion gate, `setRotation`, every hub/wheel body, every
    // `rotateByQuat` — so an ordinary own accessor validated the identity
    // quaternion and executed yaw-90, or passed the |q|²=1 gate and realized a
    // non-unit rotation, `finite:true`/`integrity:'ok'` at a pose nothing
    // validated. Capturing {x,y,z,w}/{x,y,z} makes validated == executed. A
    // non-object is passed through unchanged — a primitive cannot lie on
    // re-read, and realizeVehicle rejects it with its message.
    const record = { ir, position: { x: px, y: py, z: pz } };
    if (rotation !== undefined) record.rotation = captureSpawnComponents(rotation, QUAT_KEYS);
    if (linvel !== undefined) record.linvel = captureSpawnComponents(linvel, VEC3_KEYS);
    if (targetWheelSurfaceSpeed !== undefined) record.targetWheelSurfaceSpeed = targetWheelSurfaceSpeed;
    if (wheelFriction !== undefined) record.wheelFriction = wheelFriction;
    ownedVehicles.push(record);
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1) fail('maxSteps', maxSteps);
  if (termination !== 'maxSteps') fail('termination', termination);
  if (typeof trace !== 'object' || trace === null) fail('trace', trace);
  checkUnknownKeys(trace, TRACE_KEYS, 'trace');
  // The mode that is CHECKED is the mode that is returned and that drives
  // capture: read three times, a `mode` accessor validated 'none' and ran
  // 'full' (a traced run where the caller was told nothing would be retained).
  const traceMode = trace.mode;
  const checkpointIntervalIn = trace.checkpointInterval;
  if (!TRACE_MODES.includes(traceMode)) fail('trace.mode', traceMode);
  // Capture indices run 0..maxSteps and the trace stepIndex field is u32, so a
  // traced run needs maxSteps <= MAX_STEP_INDEX — reject the overflow pre-world
  // rather than letting the encoder throw at the final capture mid-run.
  if (traceMode !== 'none' && maxSteps > MAX_STEP_INDEX) fail('maxSteps', `${maxSteps} > MAX_STEP_INDEX ${MAX_STEP_INDEX} (trace stepIndex is u32)`);
  if (checkpointIntervalIn !== undefined
    && (!Number.isInteger(checkpointIntervalIn) || checkpointIntervalIn < 1)) {
    fail('trace.checkpointInterval', checkpointIntervalIn);
  }
  if (typeof profile !== 'boolean') fail('profile', profile);
  if (typeof hooks !== 'object' || hooks === null) fail('hooks', hooks);
  checkUnknownKeys(hooks, HOOK_KEYS, 'hooks');
  const onPhase = hooks.onPhase;
  if (onPhase !== undefined && typeof onPhase !== 'function') fail('hooks.onPhase', onPhase);
  return {
    deterministic, terrain: ownedTerrain, vehicles: ownedVehicles, maxSteps, termination,
    traceMode, checkpointInterval: checkpointIntervalIn ?? 1,
    profile, onPhase: onPhase ?? null,
  };
}

const finiteVec = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const NAN_VEC3 = Object.freeze({ x: NaN, y: NaN, z: NaN });
const NAN_QUAT = Object.freeze({ x: NaN, y: NaN, z: NaN, w: NaN });

/**
 * The canonical single-body readback (exported: the classification seam the
 * non-finite latch consumes, and the contract future replay/worker code
 * shares). Invalid-body rule, defined up front and MEASURED load-bearing: a
 * pose read on a removed/stale body PANICS the wasm module ("unreachable" —
 * probed 2026-07-11, both flavors, and the panic can poison subsequent wasm
 * calls), so when isValid() is false the read yields canonical NaNs in every
 * physical field with bodyValid=false, finiteState=false, WITHOUT touching
 * the engine — the record count stays shape-static and the validity bit
 * carries the diagnosis. Engine-side NaN (e.g. a raw setLinvel(NaN)) is
 * accepted by Rapier and persists through stepping — the finite flag here is
 * what detects it. No legal runEvaluation input can produce either state on
 * rapier 0.19.3 (measured: velocities to 1e25 m/s stay finite for 60+ steps;
 * ~3e38 hard-panics wasm, which surfaces as a thrown error, not a NaN trace)
 * — the latch is a defensive net, tested at this seam.
 */
export function readBodyState(body) {
  if (!body.isValid()) {
    return {
      valid: false, sleeping: false, finite: false,
      translation: NAN_VEC3, rotation: NAN_QUAT, linvel: NAN_VEC3, angvel: NAN_VEC3,
    };
  }
  const translation = body.translation();
  const rotation = body.rotation();
  const linvel = body.linvel();
  const angvel = body.angvel();
  const finite = finiteVec(translation) && finiteVec(linvel) && finiteVec(angvel)
    && Number.isFinite(rotation.x) && Number.isFinite(rotation.y)
    && Number.isFinite(rotation.z) && Number.isFinite(rotation.w);
  return { valid: true, sleeping: body.isSleeping(), finite, translation, rotation, linvel, angvel };
}

/**
 * Per-capture forward-progress fold (exported pure seam, the readBodyState
 * precedent: its defensive branches are unreachable from legal inputs on
 * rapier 0.19.3 — no legal input produces NaN — so they are tested here, at
 * the seam). dx = chassis translation.x − origin.x for one capture. Capture 0
 * always feeds dx = 0 exactly (origin IS the capture-0 chassis translation,
 * snapshotted at realize time with no step in between), so both accumulators
 * baseline at 0: maximum forward progress can never be negative, and a
 * reverse-only vehicle scores 0 attained at step 0. STRICT comparisons keep
 * the EARLIEST capture index on exact ties. Non-finite samples are skipped —
 * a NaN reaching the comparisons would silently freeze the fold (every
 * NaN-comparison is false), destroying the accumulator without a trace.
 * maxBackwardDistance is the nonnegative distance (m) the chassis ever got
 * BEHIND spawn (0 for a vehicle that never crossed behind its origin); the
 * `-dx > 0` gate keeps it exactly +0 until a genuinely negative dx arrives.
 */
export function createProgressState() {
  return { maxForwardDistance: 0, stepAtMaxForwardDistance: 0, maxBackwardDistance: 0 };
}

export function foldProgress(state, stepIndex, dx) {
  if (!Number.isFinite(dx)) return state;
  if (dx > state.maxForwardDistance) {
    state.maxForwardDistance = dx;
    state.stepAtMaxForwardDistance = stepIndex;
  }
  if (-dx > state.maxBackwardDistance) state.maxBackwardDistance = -dx;
  return state;
}

/**
 * The shared simulate/capture/collect loop over an ALREADY-REALIZED world —
 * the investigation seam extracted from runEvaluation (physics-integrity
 * finite-explosion PR). NOT the production entry point: that is
 * runEvaluation, which composes this function verbatim, so the golden locks
 * in test:determinism attest to both. A caller-side composition identical to
 * runEvaluation's MUST reproduce the golden digest
 * (tests/evaluation-core.test.js).
 *
 * Preconditions: `world` already contains the static terrain (with its
 * statics-only BVH step done) AND the realized vehicles; the CALLER owns
 * world.free(). `requestedDt` is the caller's DECLARED timestep — the
 * production path passes FIXED_DT; a diagnostic composition that sets
 * world.timestep itself must pass what it set, so `result.requestedDt` can
 * never silently claim 1/60 for a 1/120 run (effectiveDt is always the
 * engine readback). The dt f32 assertion deliberately stays in runEvaluation.
 *
 * `inspect(stepIndex)` is an optional READ-ONLY per-step hook, fired after
 * each capture (including capture 0). The production path never passes it —
 * both call sites below are dead under runEvaluation. It receives ONLY the
 * step index: a diagnostic caller closes over the world/collider handles it
 * already owns, and non-interference (identical digest/records/results with
 * a real contact-querying inspect vs null) is locked by
 * tests/evaluation-core.test.js.
 */
export function runRealizedEvaluationLoop(world, realized, {
  requestedDt,
  maxSteps,
  traceMode = 'none',
  checkpointInterval = 1,
  integrity = true,
  staticColliders,
  profile = false,
  inspect = null,
  onPhase = () => {},
} = {}) {
  // Minimal fail-loud guards for direct (probe) callers — the production
  // path's full validation already ran pre-world in validateOptions.
  if (typeof requestedDt !== 'number' || !Number.isFinite(requestedDt) || requestedDt <= 0) {
    fail('runRealizedEvaluationLoop.requestedDt', requestedDt);
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1) fail('runRealizedEvaluationLoop.maxSteps', maxSteps);
  if (!TRACE_MODES.includes(traceMode)) fail('runRealizedEvaluationLoop.traceMode', traceMode);
  if (!Number.isInteger(staticColliders) || staticColliders < 0) {
    fail('runRealizedEvaluationLoop.staticColliders', staticColliders);
  }
  if (inspect !== null && typeof inspect !== 'function') {
    fail('runRealizedEvaluationLoop.inspect', inspect);
  }
  // The integrity toggle exists ONLY at this direct-caller seam (the `inspect`
  // precedent): production (runEvaluation) never passes it, so integrity is
  // ALWAYS ON through every public path — a policy, not an option. The off
  // arm exists for cost measurement and non-interference witnesses
  // (tests/evaluation-core.test.js, scripts/probe-integrity.js).
  if (typeof integrity !== 'boolean') fail('runRealizedEvaluationLoop.integrity', integrity);
  // Honest-dt contract: the declaration must MATCH the engine readback (the
  // engine stores dt as f32) — a composition running 1/120 while declaring
  // 1/60 must fail loud here, never report a misleading requestedDt.
  if (world.timestep !== Math.fround(requestedDt)) {
    fail('runRealizedEvaluationLoop.requestedDt',
      `${requestedDt} does not match the engine readback ${world.timestep}`);
  }
  const effectiveDt = world.timestep;

  // Canonical body order falls out of iterating the realizeVehicle return
  // shape: vehicles in input order → chassis → stations axle-then-wheel,
  // hub before wheel. No sorting, no handles.
  const tracked = realized.map((rec) => {
    const joints = rec.wheels.flatMap((st) => (st.suspensionJoint === null
      ? [st.driveJoint] : [st.suspensionJoint, st.driveJoint]));
    const bodies = [{
      role: 'chassis', axleIndex: null, wheelIndex: null, body: rec.chassis.body,
      jointState: () => {
        if (joints.length === 0) return 'notApplicable'; // a zero-joint sled
        return joints.every((j) => j.isValid()) ? 'valid' : 'invalid';
      },
    }];
    for (const st of rec.wheels) {
      if (st.hub !== null) {
        bodies.push({
          role: 'hub', axleIndex: st.axleIndex, wheelIndex: st.wheelIndex,
          body: st.hub.body, jointState: () => (st.suspensionJoint.isValid() ? 'valid' : 'invalid'),
        });
      }
      bodies.push({
        role: 'wheel', axleIndex: st.axleIndex, wheelIndex: st.wheelIndex,
        body: st.wheel.body, jointState: () => (st.driveJoint.isValid() ? 'valid' : 'invalid'),
      });
    }
    return {
      rec, joints, bodies,
      origin: { ...rec.chassis.body.translation() },
      latched: null,
      progress: createProgressState(),
      // The online numerical-integrity fold (policy v1, src/sim/integrity.js):
      // per-capture thresholds scale from the EFFECTIVE dt (the f32 engine
      // readback), never the f64 request — the pinned captureDt convention.
      integrity: integrity ? createIntegrityState(bodies.length, effectiveDt) : null,
    };
  });

  const writer = traceMode === 'none'
    ? null
    : new TraceWriter({ mode: traceMode, checkpointInterval });

  // One capture does the readback ONCE per body and feeds both the
  // finiteness latch and (when tracing) the writer — the scanned values and
  // the traced values are provably the same read.
  const captureStep = (stepIndex) => {
    for (let vi = 0; vi < tracked.length; vi += 1) {
      const t = tracked[vi];
      const reads = t.bodies.map((b) => readBodyState(b.body));
      if (t.latched === null && reads.some((r) => !r.finite)) {
        t.latched = { step: stepIndex, reason: 'nonFinite' };
      }
      // Progress folds from the SAME chassis read the latch and trace
      // consume (reads[0] — bodies[0] is the chassis by construction).
      // Gated on the WHOLE-vehicle latch (fires when ANY body goes
      // non-finite), so the fold freezes at the last fully-finite capture.
      // That is deliberate: once latched the vehicle is invalid and its
      // fitness is 0 regardless of progress, so accumulating chassis motion
      // after a wheel exploded would be meaningless. A trace-based
      // recompute therefore agrees with these fields only while
      // latched === null (unreachable divergence otherwise on 0.19.3 — no
      // legal input goes non-finite). The fold's own finite guard is the
      // second net.
      if (t.latched === null) {
        foldProgress(t.progress, stepIndex, reads[0].translation.x - t.origin.x);
      }
      // Integrity folds from the SAME reads, deliberately NOT gated on the
      // latch: classification keeps observing after a non-finite latch (the
      // NaN samples are arithmetic-inert — no peak, no predicate — and other
      // still-finite bodies keep classifying). Result-only, like progress:
      // nothing here enters the trace bytes.
      if (t.integrity !== null) foldIntegrity(t.integrity, stepIndex, reads);
      if (writer !== null) {
        const terminated = t.latched !== null;
        for (let bi = 0; bi < t.bodies.length; bi += 1) {
          const b = t.bodies[bi];
          const r = reads[bi];
          writer.record({
            stepIndex,
            vehicleIndex: vi,
            bodyRole: b.role,
            axleIndex: b.axleIndex,
            wheelIndex: b.wheelIndex,
            bodyValid: r.valid,
            bodySleeping: r.sleeping,
            jointState: b.jointState(),
            terminated,
            terminationReason: terminated ? t.latched.reason : 'none',
            finiteState: r.finite,
            translation: r.translation,
            rotation: r.rotation,
            linvel: r.linvel,
            angvel: r.angvel,
          });
        }
      }
    }
    if (writer !== null) writer.endStep(stepIndex);
  };

  captureStep(0); // post-realization, pre-first-step
  if (inspect !== null) inspect(0); // dead under runEvaluation (inspect null)

  onPhase('run');
  const stepMs = profile ? new Float64Array(maxSteps) : null;
  for (let i = 1; i <= maxSteps; i += 1) {
    world.step();
    if (stepMs !== null) stepMs[i - 1] = world.timingStep();
    captureStep(i);
    if (inspect !== null) inspect(i); // dead under runEvaluation (inspect null)
  }

  onPhase('collect');
  const vehicles = tracked.map((t) => {
    const chassis = readBodyState(t.rec.chassis.body);
    const bodyReads = t.bodies.map((b) => readBodyState(b.body));
    return {
      forwardDistance: chassis.translation.x - t.origin.x,
      // Maximum-progress metrics (derived, per-step, sim-time pure): the
      // fold above saw every captured state 0..maxSteps, so
      // maxForwardDistance >= max(0, forwardDistance) whenever the vehicle
      // stayed finite. These are RESULT fields only — they never enter the
      // trace bytes, so no golden digest can move.
      maxForwardDistance: t.progress.maxForwardDistance,
      stepAtMaxForwardDistance: t.progress.stepAtMaxForwardDistance,
      maxBackwardDistance: t.progress.maxBackwardDistance,
      origin: t.origin,
      finalPose: { translation: chassis.translation, rotation: chassis.rotation },
      finalVelocity: { linvel: chassis.linvel, angvel: chassis.angvel },
      finite: t.latched === null,
      terminated: t.latched === null ? { step: null, reason: null } : { ...t.latched },
      bodies: {
        count: t.bodies.length,
        allValid: bodyReads.every((r) => r.valid),
        sleepingAtEnd: bodyReads.filter((r) => r.sleeping).length, // a count, NEVER an expectation (solver-pump)
      },
      joints: {
        count: t.joints.length,
        allValid: t.joints.every((j) => j.isValid()),
      },
      mass: t.rec.mass,
      stationCount: t.rec.wheels.length,
      // The numerical-integrity classification (policy v1) — a RESULT field
      // only, the maxForwardDistance precedent: never enters the trace bytes,
      // so no golden digest can move. `null` only under the direct-caller
      // diagnostic off-arm; every production result carries the block.
      integrity: t.integrity === null ? null : finalizeIntegrity(t.integrity),
    };
  });
  return {
    terminationReason: RUN_TERMINATION.COMPLETED,
    executedSteps: maxSteps, // evaluation steps only; the statics pre-step is setup
    requestedDt,
    effectiveDt,
    vehicles,
    counts: {
      bodies: world.bodies.len(),
      colliders: world.colliders.len(),
      joints: world.impulseJoints.len(),
      staticColliders,
    },
    trace: writer === null ? null : writer.finish(),
    timing: stepMs === null ? null : { stepMs },
  };
}

/**
 * Run one headless evaluation. See the header for the step-index, termination,
 * and dt contracts. Options:
 *
 *   { deterministic, terrain (must carry its own seed), vehicles: [{ ir,
 *     spawn: { position, rotation?, linvel? }, targetWheelSurfaceSpeed?,
 *     wheelFriction? }],
 *     maxSteps, termination: 'maxSteps', trace: { mode, checkpointInterval? },
 *     profile, hooks: { onPhase? } }
 *
 * Vehicles enter as COMPILED IRs, never genotypes — a genotype-accepting
 * runner would silently repair, and the digest would attest to a phenotype
 * the caller never saw (fixtures assert repair-stability separately, then
 * compile). Ghost policy: vehicle groups filter GROUND only, so spawning any
 * number of vehicles at the identical transform is legal and expected; the
 * runner performs no spawn-separation validation.
 */
export async function runEvaluation(options) {
  const cfg = validateOptions(options);
  const onPhase = cfg.onPhase ?? (() => {});

  onPhase('createPhysics');
  const { RAPIER, world } = await createPhysics({ deterministic: cfg.deterministic });
  let result;
  try {
    // The MEASURED dt contract (probe: the engine stores f32) — a drift
    // tooth against future adapter/engine changes, not a knob.
    if (world.timestep !== Math.fround(FIXED_DT)) {
      throw new Error(`evaluation: world.timestep readback drifted from the measured f32 contract (${world.timestep})`);
    }
    // Enable the profiler BEFORE any stepping so the fresh-module first-step
    // warm-up spike (measured ~1.5 ms) lands on the statics pre-step, never
    // on an evaluation sample.
    if (cfg.profile) world.profilerEnabled = true;

    onPhase('terrain');
    const terrain = generateCorridorTerrain(cfg.terrain);
    if (terrain.features.length > 0) {
      // addFeatures performs the one statics-only BVH step internally.
      addCorridorWithFeatures(RAPIER, world, terrain);
    } else {
      addCorridor(RAPIER, world, terrain);
      world.step(); // the [V1] statics-only query-BVH idiom
    }
    const staticColliders = world.colliders.len();

    onPhase('realize');
    // `cfg.vehicles` are validateOptions' MODULE-OWNED records, so the guarded
    // reading and the realized reading are literally the same values — not
    // merely the same indices. Re-reading the caller's objects here (the old
    // shape) put `onPhase(...)` and an `await` between validation and use.
    const realized = [];
    for (let vi = 0; vi < cfg.vehicles.length; vi += 1) {
      const v = cfg.vehicles[vi];
      const opts = { position: v.position };
      if (v.rotation !== undefined) opts.rotation = v.rotation;
      if (v.linvel !== undefined) opts.linvel = v.linvel;
      if (v.targetWheelSurfaceSpeed !== undefined) opts.targetWheelSurfaceSpeed = v.targetWheelSurfaceSpeed;
      if (v.wheelFriction !== undefined) opts.wheelFriction = v.wheelFriction;
      realized.push(realizeVehicle(RAPIER, world, v.ir, opts));
    }

    // The shared loop — composed verbatim; inspect is never passed here
    // (the production path has no per-step observer).
    result = runRealizedEvaluationLoop(world, realized, {
      requestedDt: FIXED_DT,
      maxSteps: cfg.maxSteps,
      traceMode: cfg.traceMode,
      checkpointInterval: cfg.checkpointInterval,
      staticColliders,
      profile: cfg.profile,
      onPhase,
    });
  } finally {
    world.free();
  }
  onPhase('done');
  return result;
}
