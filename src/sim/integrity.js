// Numerical-integrity policy v1 — the ONLINE divergence detector and its
// versioned contract (the corrective successor to the PR #17 investigation;
// design record: docs/numerical-integrity-policy-2026-07.md).
//
// WHY THIS EXISTS: Rapier's constraint solver diverges on a minority of legal
// multi-module impulse-joint vehicles (measured: 5/60 generation-0 individuals
// on core 0.30.1 AND core 0.34; two hide >1000 m/s internal blow-ups behind
// ordinary-looking forward progress), so raw maxForwardDistance mis-ranks in
// both directions and evolution would SELECT for solver divergence. The
// offline forensic detector (src/sim/trace-forensics.js) catches every known
// case but needs full traces; this module is the production-grade subset that
// runs online, per evaluation, from the per-body reads the runner already
// takes every capture — no trace, no engine queries, one step of retained
// history, a handful of scalar maxima.
//
// THE CONTRACT (policy v1, frozen):
//   status:  'ok' | 'nonFinite' | 'numericalDivergence'
//   failure bound = nonFinite OR a catastrophic crossing
//     (body speed > catastrophicSpeed, or one-capture displacement >
//      catastrophicStepDisplacement x dtScale, ANY body)
//   The ALERT band is a recorded OBSERVATION, never a failure: it lacks
//   false-positive calibration breadth, and the mission rules out treating
//   extreme-but-finite motion as invalid without control evidence. Escalating
//   alert to a failure bound is a documented policy-v2 trigger, decided from
//   the probe-integrity neighborhood/population evidence (the false-negative
//   acceptance gate in the design record).
//   Observations are populated on EVERY status — the block doubles as the
//   cheap cross-engine comparison instrument on any future upgrade.
//   Policy v1 CLASSIFIES the evaluation but never shortens it: the runner
//   still executes exactly maxSteps after a failure (trace shape, executed-
//   step semantics, and timing comparability preserved; early termination is
//   deferred to a later policy version).
//
// ENGINE NEUTRALITY: every signal is a kinematic scalar (|v|, one-capture
// |Δv|, one-capture |Δx|) over body state any physics backend exposes; the
// thresholds derive from PROJECT physics (gravity 20, ~22 m/s worst
// legitimate fall, the 5 m/s drive law — the trace-forensics derivation),
// not from engine identity. Engine identity stays a lock-layer attestation;
// neither the thresholds nor the fitness vector bind rapierVersion.
//
// THRESHOLDS are FROZEN COPIES of the forensic defaults at adoption time
// (2026-07: equal to FORENSIC_THRESHOLD_DEFAULTS' alert/catastrophic values),
// deliberately NOT imported: trace-forensics' thresholds are DIAGNOSTIC
// options a probe may tweak freely; these are POLICY, versioned by
// INTEGRITY_POLICY_VERSION. Changing a value here is a policy bump.
//
// CAPTURE-INTERVAL CONVENTION (pinned): per-capture thresholds are defined at
// INTEGRITY_REFERENCE_CAPTURE_DT = 1/60 and scaled by
// captureDt / INTEGRITY_REFERENCE_CAPTURE_DT — the SAME arithmetic
// analyzeTrace applies. The runner passes captureDt = effectiveDt (the
// engine's f32 timestep READBACK, not the f64 request), and the online/
// offline equivalence tests feed analyzeTrace the same captureDt, so the two
// arms' applied thresholds are bit-identical. norm3/dist3 live HERE and
// trace-forensics imports them, so the two detectors share one arithmetic.
//
// EXACT-EQUIVALENCE DISCIPLINE (mirrors analyzeTrace, tested bitwise):
//   - strict `>` comparisons (a value exactly AT a threshold does not fire);
//   - NaN samples can never take a peak or fire a predicate (NaN comparisons
//     are false); the previous-capture scratch is updated UNCONDITIONALLY,
//     NaN included, exactly like analyzeTrace's `prev = rec`;
//   - capture 0 has no previous capture: speed-only predicates.
// Deterministic reason order: within one capture, bodies in canonical order
// (the runner's reads array), and per body catastrophicSpeed ->
// catastrophicStepDisplacement -> nonFinite; each stable code is recorded at
// its FIRST occurrence only. `status` is the first failure class encountered
// in that scan order; `firstFailureStep` is its capture index.

export const INTEGRITY_POLICY_VERSION = 1;

// Fixed vocabulary; the fitness-vector codec encodes status as its index here.
export const INTEGRITY_STATUS = Object.freeze(['ok', 'nonFinite', 'numericalDivergence']);
export const INTEGRITY_REASONS = Object.freeze([
  'nonFinite', 'catastrophicSpeed', 'catastrophicStepDisplacement',
]);

// The reference capture interval the per-capture thresholds are defined at.
// A POLICY constant (own literal, never imported from the diagnostic module);
// a drift tooth in tests/integrity.test.js asserts it equals trace-forensics'
// REFERENCE_CAPTURE_DT so the two arms can never silently diverge.
export const INTEGRITY_REFERENCE_CAPTURE_DT = 1 / 60;

export const INTEGRITY_THRESHOLDS = Object.freeze({
  alertSpeed: 25, // m/s (absolute — never scaled); OBSERVATION band
  alertSpeedDelta: 30, // m/s per REFERENCE capture; OBSERVATION band
  alertStepDisplacement: 25 / 60, // m per REFERENCE capture; OBSERVATION band
  catastrophicSpeed: 1000, // m/s (absolute); FAILURE bound
  catastrophicStepDisplacement: 1000 / 60, // m per REFERENCE capture; FAILURE bound
});

const PER_CAPTURE_KEYS = Object.freeze([
  'alertSpeedDelta', 'alertStepDisplacement', 'catastrophicStepDisplacement',
]);

function fail(path, value) {
  throw new Error(`integrity: invalid input at ${path} (${String(value)})`);
}

// The ONE shared vector arithmetic for both detectors (trace-forensics
// imports these): plain Euclidean norms, Math.sqrt only (algebraic — the sim
// ESLint ban forbids transcendentals, not sqrt).
// `norm3xyz` is the arithmetic; `norm3` is the object-reading convenience.
// The split exists so a caller that has already CAPTURED its components can
// reach the identical expression without re-reading the source object — see
// foldIntegrity's hot loop (round-11 single-read sweep, no allocation).
export const norm3xyz = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
export const norm3 = (v) => norm3xyz(v.x, v.y, v.z);
export const dist3 = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/**
 * Per-vehicle online integrity state. `bodyCount` is the vehicle's tracked
 * body count (chassis + hubs + wheels, the runner's canonical reads order);
 * `captureDt` is the run's EFFECTIVE timestep (the engine readback). The
 * previous-capture pose/velocity scratch is preallocated here — the per-step
 * fold allocates nothing.
 */
export function createIntegrityState(bodyCount, captureDt) {
  if (!Number.isInteger(bodyCount) || bodyCount < 1) fail('bodyCount', bodyCount);
  if (typeof captureDt !== 'number' || !Number.isFinite(captureDt) || captureDt <= 0) {
    fail('captureDt', captureDt);
  }
  const dtScale = captureDt / INTEGRITY_REFERENCE_CAPTURE_DT;
  const applied = { ...INTEGRITY_THRESHOLDS };
  for (const k of PER_CAPTURE_KEYS) applied[k] = INTEGRITY_THRESHOLDS[k] * dtScale;
  return {
    bodyCount,
    captureDt,
    appliedThresholds: Object.freeze(applied),
    status: 'ok',
    firstFailureStep: null,
    reasons: [],
    peakBodySpeed: 0,
    peakSpeedDelta: 0,
    peakStepDisplacement: 0,
    firstAlertStep: null,
    firstCatastrophicStep: null,
    hasPrev: false,
    prevLinvel: new Float64Array(bodyCount * 3),
    prevTranslation: new Float64Array(bodyCount * 3),
  };
}

const addReason = (state, code) => {
  if (!state.reasons.includes(code)) state.reasons.push(code);
};

/**
 * Fold one capture (the SAME `reads` array the runner's captureStep already
 * built: per body {finite, translation, linvel, ...} in canonical order).
 * Hot path: no allocation, ~a dozen float ops per body on values already in
 * hand. Returns the state for chaining (the foldProgress convention).
 */
export function foldIntegrity(state, stepIndex, reads) {
  // The bound is captured: `length` is writable on a genuine Array and the
  // body reads caller record fields, so the count that was checked against
  // `state.bodyCount` must be the count that is walked (round-11 class sweep;
  // the production `reads` is runner-owned, so this is a boundary guarantee,
  // not a reachable-defect fix).
  const readCount = reads.length;
  if (readCount !== state.bodyCount) {
    fail('reads.length', `${readCount} (state tracks ${state.bodyCount} bodies)`);
  }
  const t = state.appliedThresholds;
  const pl = state.prevLinvel;
  const pt = state.prevTranslation;
  for (let i = 0; i < readCount; i += 1) {
    const r = reads[i];
    // Structural guard so a malformed or missing entry leaves this public
    // export in the module's own dialect rather than as a foreign TypeError
    // off `.linvel`. One typeof per body per capture, in a loop that already
    // evaluates two Math.sqrt — the hot-path claim above still holds.
    if (typeof r !== 'object' || r === null) fail(`reads[${i}]`, r);
    const o = i * 3;
    // Every caller-owned field this body contributes, captured ONCE into
    // locals: the value that is compared against the thresholds is the value
    // stored into the scratch for the next capture's deltas. Reading
    // `r.linvel.x` seven times and `r.translation.x` six (the previous shape)
    // gave a two-faced accessor seven chances to answer differently within one
    // body's fold — classify on one number, remember another. No allocation:
    // norm3xyz is the same expression norm3 evaluates.
    const linvel = r.linvel;
    const translation = r.translation;
    const finite = r.finite;
    // Guard the FIELDS the entry contributes, not just the entry: the round-11
    // guard checked `r` but a primitive `linvel`/`translation` then read
    // `.x` === undefined → norm3xyz(NaN) whose comparisons are all false, so a
    // malformed read silently left status:'ok' over unread data (F14). A missing
    // one escaped as a foreign TypeError off `.linvel`, the exact class the
    // guard's own comment claims to close.
    if (typeof linvel !== 'object' || linvel === null) fail(`reads[${i}].linvel`, linvel);
    if (typeof translation !== 'object' || translation === null) fail(`reads[${i}].translation`, translation);
    const vx = linvel.x; const vy = linvel.y; const vz = linvel.z;
    const tx = translation.x; const ty = translation.y; const tz = translation.z;
    const speed = norm3xyz(vx, vy, vz);
    if (speed > state.peakBodySpeed) state.peakBodySpeed = speed;
    let speedDelta = null;
    let stepDisplacement = null;
    if (state.hasPrev) {
      // Same subtraction order as analyzeTrace's dist3(current, previous).
      const dvx = vx - pl[o];
      const dvy = vy - pl[o + 1];
      const dvz = vz - pl[o + 2];
      speedDelta = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
      const dxx = tx - pt[o];
      const dxy = ty - pt[o + 1];
      const dxz = tz - pt[o + 2];
      stepDisplacement = Math.sqrt(dxx * dxx + dxy * dxy + dxz * dxz);
      if (speedDelta > state.peakSpeedDelta) state.peakSpeedDelta = speedDelta;
      if (stepDisplacement > state.peakStepDisplacement) state.peakStepDisplacement = stepDisplacement;
    }
    const alert = speed > t.alertSpeed
      || (speedDelta !== null && speedDelta > t.alertSpeedDelta)
      || (stepDisplacement !== null && stepDisplacement > t.alertStepDisplacement);
    if (alert && state.firstAlertStep === null) state.firstAlertStep = stepIndex;
    const catSpeed = speed > t.catastrophicSpeed;
    const catDisplacement = stepDisplacement !== null
      && stepDisplacement > t.catastrophicStepDisplacement;
    if (catSpeed) addReason(state, 'catastrophicSpeed');
    if (catDisplacement) addReason(state, 'catastrophicStepDisplacement');
    if (catSpeed || catDisplacement) {
      if (state.firstCatastrophicStep === null) state.firstCatastrophicStep = stepIndex;
      if (state.status === 'ok') {
        state.status = 'numericalDivergence';
        state.firstFailureStep = stepIndex;
      }
    }
    if (!finite) {
      addReason(state, 'nonFinite');
      if (state.status === 'ok') {
        state.status = 'nonFinite';
        state.firstFailureStep = stepIndex;
      }
    }
    // Unconditional, NaN included — analyzeTrace's `prev = rec` parity. A NaN
    // here poisons the NEXT capture's deltas into NaN, whose comparisons are
    // all false — identical on both arms.
    pl[o] = vx; pl[o + 1] = vy; pl[o + 2] = vz;
    pt[o] = tx; pt[o + 1] = ty; pt[o + 2] = tz;
  }
  state.hasPrev = true;
  return state;
}

/** The frozen per-vehicle result block (the shape the fitness policy consumes). */
export function finalizeIntegrity(state) {
  return Object.freeze({
    policyVersion: INTEGRITY_POLICY_VERSION,
    status: state.status,
    firstFailureStep: state.firstFailureStep,
    reasons: Object.freeze([...state.reasons]),
    observations: Object.freeze({
      peakBodySpeed: state.peakBodySpeed,
      peakSpeedDelta: state.peakSpeedDelta,
      peakStepDisplacement: state.peakStepDisplacement,
      firstAlertStep: state.firstAlertStep,
      firstCatastrophicStep: state.firstCatastrophicStep,
    }),
  });
}
