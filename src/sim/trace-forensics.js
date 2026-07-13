// Offline forensic analysis of FULL evaluation traces — the finite-explosion
// investigation's Tier-1 telemetry. Consumes a full-mode TraceWriter result
// (decoded via the sanctioned decodeTraceRecord — never ad hoc offset math)
// and derives, per body, the per-step kinematic series and their peaks, plus
// a three-concept onset classification:
//
//   firstAlertStep          — the first DIAGNOSTIC-threshold crossing. A
//                             locator, NOT causal onset: a body may receive
//                             excessive contact energy steps before it
//                             crosses, and an unusual-but-legitimate impact
//                             may cross without beginning an instability.
//   firstCatastrophicStep   — the first catastrophic-threshold crossing
//                             (unambiguously non-physical motion).
//   firstCausalCandidateStep— the earliest step of the CONTIGUOUS escalation
//                             chain ending at the first alert, found by
//                             scanning BACKWARD from the alert while any
//                             body's per-step velocity change stays above the
//                             causal escalation floor. Trace-only evidence;
//                             Tier-2 contact telemetry (impulse, penetration,
//                             manifold composition) refines it.
//
// EVERY threshold here is DIAGNOSTIC: it classifies a forensic timeline for
// a report. None of these values is a validity bound, none is fitness
// policy, none is consumed by any lock or by population-evaluation, and
// changing one changes only a report. (The investigation plan's
// threshold-laundering guard.)
//
// Default derivations (composite-corridor scale, gravity 20, dt 1/60):
//   - gravity impulse per step g*dt = 20/60 = 0.333... m/s is the quantum of
//     legitimate per-step speed change; the recorded solver-pump creep is
//     ~0.33 m/s; the drive law's no-load surface speed is 5 m/s.
//   - worst legitimate fall across the corridor's vertical extent
//     (~12 m with walls) is sqrt(2*20*12) ~ 22 m/s, and 300 steps at 5 m/s
//     is ~25 m of travel — so alertSpeed 25 m/s sits just above anything
//     legitimate corridor dynamics can produce.
//   - alertSpeedDelta 30 m/s/step (~90 g*dt) is the largest one-step arrest
//     a restitution <= 0.1 stop of an alertSpeed-scale fall can deliver;
//     larger jumps mean the solver injected energy.
//   - catastrophicSpeed 1000 m/s (and its one-step displacement 1000/60 m)
//     is far onto the runaway curve while decades under the observed
//     3.26e9 m/s finite ceiling.
//   - causalSpeedDelta 1 m/s (~3 g*dt) / causalAngularSpeedDelta 10 rad/s
//     are the backward-scan escalation floors: above ordinary rolling and
//     settling noise, far below the alert tier.
//
// Sensitivity discipline (enforced by the probe, supported here by
// scaledThresholds): a genuine discrete catapult's alert step must be robust
// to x0.5/x2 threshold scaling (moves <= ~2 steps); a large drift means the
// mechanism is GRADUAL (solver-pump/creep class) and the case must be
// reclassified rather than force-fit.

import { EVALUATION_TRACE_VERSION, RECORD_BYTES, decodeTraceRecord } from './trace.js';

export const TRACE_FORENSICS_SCHEMA = 'boxcar3d.trace-forensics/1';

export const FORENSIC_THRESHOLD_DEFAULTS = Object.freeze({
  alertSpeed: 25, // m/s
  alertSpeedDelta: 30, // m/s per capture interval
  alertStepDisplacement: 25 / 60, // m per capture interval (alertSpeed * dt)
  catastrophicSpeed: 1000, // m/s
  catastrophicStepDisplacement: 1000 / 60, // m per capture interval
  causalSpeedDelta: 1, // m/s per capture — backward-scan escalation floor
  causalAngularSpeedDelta: 10, // rad/s per capture — backward-scan floor
});

function fail(path, value) {
  throw new Error(`trace-forensics: invalid input at ${path} (${String(value)})`);
}

function resolveThresholds(thresholds) {
  if (typeof thresholds !== 'object' || thresholds === null) fail('thresholds', thresholds);
  const known = Object.keys(FORENSIC_THRESHOLD_DEFAULTS);
  for (const k of Object.keys(thresholds)) {
    if (!known.includes(k)) fail(`thresholds.${k}`, 'unknown key');
  }
  const resolved = { ...FORENSIC_THRESHOLD_DEFAULTS, ...thresholds };
  for (const k of known) {
    const v = resolved[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`thresholds.${k}`, v);
  }
  return Object.freeze(resolved);
}

/** Uniformly scale every threshold — the x0.5/x2 sensitivity-sweep helper. */
export function scaledThresholds(factor, thresholds = FORENSIC_THRESHOLD_DEFAULTS) {
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) fail('factor', factor);
  const base = resolveThresholds(thresholds);
  const out = {};
  for (const k of Object.keys(base)) out[k] = base[k] * factor;
  return Object.freeze(out);
}

const norm3 = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
const dist3 = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const bodyKey = (r) => `${r.vehicleIndex}|${r.bodyRole}|${r.axleIndex === null ? '-' : r.axleIndex}|${r.wheelIndex === null ? '-' : r.wheelIndex}`;

const BODY_META_KEYS = Object.freeze(['vehicleIndex', 'bodyRole', 'axleIndex', 'wheelIndex', 'reach']);

function resolveReachMap(bodies) {
  if (bodies === null) return null;
  if (!Array.isArray(bodies)) fail('bodies', bodies);
  const map = new Map();
  bodies.forEach((b, i) => {
    if (typeof b !== 'object' || b === null) fail(`bodies[${i}]`, b);
    for (const k of Object.keys(b)) {
      if (!BODY_META_KEYS.includes(k)) fail(`bodies[${i}].${k}`, 'unknown key');
    }
    if (typeof b.reach !== 'number' || !Number.isFinite(b.reach) || b.reach <= 0) {
      fail(`bodies[${i}].reach`, b.reach);
    }
    map.set(bodyKey(b), b.reach);
  });
  return map;
}

/**
 * Derive per-station reach metadata for `analyzeTrace`'s tip-speed proxy
 * from a compiled assembly IR — conservative body BOUNDING radii, never a
 * mislabeled wheel radius:
 *   wheel  reach = sqrt(radius^2 + (width/2)^2)   (cylinder corner)
 *   hub    reach = sqrt(hub.radius^2 + hub.halfWidth^2)
 *   chassis reach = ir.chassis.supports.reach     (max origin->support)
 * Raw |angvel| is always reported separately by analyzeTrace; the tip-speed
 * proxy is |angvel| * reach for the body's OWN geometry.
 */
export function bodyReachMetadataForIR(ir, { vehicleIndex = 0 } = {}) {
  if (typeof ir !== 'object' || ir === null || !Array.isArray(ir.axles)) fail('ir', ir);
  if (!Number.isInteger(vehicleIndex) || vehicleIndex < 0) fail('vehicleIndex', vehicleIndex);
  const entries = [{
    vehicleIndex, bodyRole: 'chassis', axleIndex: null, wheelIndex: null,
    reach: ir.chassis.supports.reach,
  }];
  ir.axles.forEach((axle, i) => {
    const axleIndex = Number.isInteger(axle.index) ? axle.index : i;
    axle.wheels.forEach((wheel, wheelIndex) => {
      if (wheel.hub !== null && wheel.hub !== undefined) {
        entries.push({
          vehicleIndex, bodyRole: 'hub', axleIndex, wheelIndex,
          reach: Math.sqrt(wheel.hub.radius * wheel.hub.radius + wheel.hub.halfWidth * wheel.hub.halfWidth),
        });
      }
      entries.push({
        vehicleIndex, bodyRole: 'wheel', axleIndex, wheelIndex,
        reach: Math.sqrt(wheel.radius * wheel.radius + (wheel.width / 2) * (wheel.width / 2)),
      });
    });
  });
  return entries;
}

const peak = () => ({ value: 0, step: null });
const foldPeak = (p, value, step) => {
  // NaN comparisons are false, so a non-finite sample can never take a peak.
  if (value > p.value) {
    p.value = value;
    p.step = step;
  }
};

/**
 * Analyze one FULL-mode trace result ({version, mode:'full', recordBytes,
 * records}). Options: `bodies` — reach metadata entries (see
 * bodyReachMetadataForIR); `thresholds` — diagnostic overrides.
 * Returns plain data only; throws loud on a digest/none-mode result (no
 * records to analyze) or a trace-contract mismatch.
 */
export function analyzeTrace(traceResult, { bodies = null, thresholds = {} } = {}) {
  if (typeof traceResult !== 'object' || traceResult === null) fail('traceResult', traceResult);
  if (traceResult.version !== EVALUATION_TRACE_VERSION) fail('traceResult.version', traceResult.version);
  if (traceResult.mode !== 'full') fail('traceResult.mode', `${traceResult.mode} (analyzeTrace needs retained records — run with trace mode 'full')`);
  if (traceResult.recordBytes !== RECORD_BYTES) fail('traceResult.recordBytes', traceResult.recordBytes);
  if (!Array.isArray(traceResult.records) || traceResult.records.length === 0) {
    fail('traceResult.records', traceResult.records);
  }
  const t = resolveThresholds(thresholds);
  const reachMap = resolveReachMap(bodies);

  // Group decoded records per body, in capture order (the writer's canonical
  // order is already step-major; a per-body sort keeps this robust to any
  // valid interleaving). Consecutive captures are assumed stride-1 — the
  // runner's contract (capture indices 0..maxSteps).
  const perBodyRecords = new Map();
  let firstStep = Infinity;
  let lastStep = -Infinity;
  for (const bytes of traceResult.records) {
    const rec = decodeTraceRecord(bytes);
    const key = bodyKey(rec);
    if (!perBodyRecords.has(key)) perBodyRecords.set(key, []);
    perBodyRecords.get(key).push(rec);
    if (rec.stepIndex < firstStep) firstStep = rec.stepIndex;
    if (rec.stepIndex > lastStep) lastStep = rec.stepIndex;
  }

  const perBody = [];
  // Escalation flags per step (any body), for the backward causal scan.
  const escalationBySteps = new Map();
  const markEscalation = (step) => escalationBySteps.set(step, true);

  for (const recs of perBodyRecords.values()) {
    recs.sort((a, b) => a.stepIndex - b.stepIndex);
    const head = recs[0];
    const body = {
      vehicleIndex: head.vehicleIndex,
      bodyRole: head.bodyRole,
      axleIndex: head.axleIndex,
      wheelIndex: head.wheelIndex,
      captureCount: recs.length,
      peakSpeed: peak(),
      peakStepDisplacement: peak(),
      peakSpeedDelta: peak(),
      peakAngularSpeed: peak(),
      peakTipSpeed: reachMap !== null && reachMap.has(bodyKey(head)) ? peak() : null,
      firstNonFiniteStep: null,
      firstSleepingStep: null,
      firstAwakeAfterSleepStep: null,
      firstAlertStep: null,
      alertSpeedDeltaAtAlert: null,
      firstCatastrophicStep: null,
    };
    const reach = reachMap !== null ? reachMap.get(bodyKey(head)) : undefined;
    let prev = null;
    let wasSleeping = false;
    for (const rec of recs) {
      const k = rec.stepIndex;
      const speed = norm3(rec.linvel);
      const angSpeed = norm3(rec.angvel);
      foldPeak(body.peakSpeed, speed, k);
      foldPeak(body.peakAngularSpeed, angSpeed, k);
      if (reach !== undefined) foldPeak(body.peakTipSpeed, angSpeed * reach, k);
      let speedDelta = null;
      let stepDisplacement = null;
      let angDelta = null;
      if (prev !== null) {
        speedDelta = dist3(rec.linvel, prev.linvel);
        stepDisplacement = dist3(rec.translation, prev.translation);
        angDelta = dist3(rec.angvel, prev.angvel);
        foldPeak(body.peakSpeedDelta, speedDelta, k);
        foldPeak(body.peakStepDisplacement, stepDisplacement, k);
        if (speedDelta > t.causalSpeedDelta || angDelta > t.causalAngularSpeedDelta) {
          markEscalation(k);
        }
      }
      if (!rec.finiteState && body.firstNonFiniteStep === null) body.firstNonFiniteStep = k;
      if (rec.bodySleeping && !wasSleeping && body.firstSleepingStep === null) body.firstSleepingStep = k;
      if (!rec.bodySleeping && wasSleeping && body.firstAwakeAfterSleepStep === null) {
        body.firstAwakeAfterSleepStep = k;
      }
      wasSleeping = rec.bodySleeping;
      const alert = speed > t.alertSpeed
        || (speedDelta !== null && speedDelta > t.alertSpeedDelta)
        || (stepDisplacement !== null && stepDisplacement > t.alertStepDisplacement);
      if (alert && body.firstAlertStep === null) {
        body.firstAlertStep = k;
        body.alertSpeedDeltaAtAlert = speedDelta ?? speed;
      }
      const catastrophic = speed > t.catastrophicSpeed
        || (stepDisplacement !== null && stepDisplacement > t.catastrophicStepDisplacement);
      if (catastrophic && body.firstCatastrophicStep === null) body.firstCatastrophicStep = k;
      prev = rec;
    }
    perBody.push(body);
  }

  // Deterministic report order: vehicle, then chassis before stations, then
  // station order (the trace's canonical family order).
  const roleRank = { chassis: 0, hub: 1, wheel: 2 };
  perBody.sort((a, b) => a.vehicleIndex - b.vehicleIndex
    || (a.axleIndex ?? -1) - (b.axleIndex ?? -1)
    || (a.wheelIndex ?? -1) - (b.wheelIndex ?? -1)
    || roleRank[a.bodyRole] - roleRank[b.bodyRole]);

  // Onset summary.
  let leading = null;
  for (const b of perBody) {
    if (b.firstAlertStep === null) continue;
    if (leading === null
      || b.firstAlertStep < leading.firstAlertStep
      || (b.firstAlertStep === leading.firstAlertStep
        && b.alertSpeedDeltaAtAlert > leading.alertSpeedDeltaAtAlert)) {
      leading = b;
    }
  }
  let firstCatastrophicStep = null;
  for (const b of perBody) {
    if (b.firstCatastrophicStep !== null
      && (firstCatastrophicStep === null || b.firstCatastrophicStep < firstCatastrophicStep)) {
      firstCatastrophicStep = b.firstCatastrophicStep;
    }
  }

  let firstAlertStep = null;
  let lastOrdinaryStep = lastStep;
  let firstCausalCandidateStep = null;
  let chassisLagSteps = null;
  if (leading !== null) {
    firstAlertStep = leading.firstAlertStep;
    lastOrdinaryStep = firstAlertStep > firstStep ? firstAlertStep - 1 : null;
    // Backward scan: the contiguous escalation chain ending at the alert.
    // If the alert step itself shows no per-step escalation (a sustained-
    // speed alert with no recent jump — the gradual signature), the
    // candidate stays at the alert step and the sharpness discipline
    // (threshold sensitivity) flags the case as gradual.
    let k = firstAlertStep;
    while (k - 1 > firstStep && escalationBySteps.get(k - 1) === true) k -= 1;
    firstCausalCandidateStep = escalationBySteps.get(firstAlertStep) === true || k < firstAlertStep
      ? k
      : firstAlertStep;
    const chassis = perBody.find(
      (b) => b.vehicleIndex === leading.vehicleIndex && b.bodyRole === 'chassis',
    );
    if (chassis !== undefined && chassis.firstAlertStep !== null) {
      chassisLagSteps = chassis.firstAlertStep - firstAlertStep;
    }
  }

  return {
    schema: TRACE_FORENSICS_SCHEMA,
    thresholds: t,
    stepRange: { first: firstStep, last: lastStep },
    perBody,
    onset: {
      firstAlertStep,
      lastOrdinaryStep,
      firstCatastrophicStep,
      firstCausalCandidateStep,
      leadingBody: leading === null ? null : {
        vehicleIndex: leading.vehicleIndex,
        bodyRole: leading.bodyRole,
        axleIndex: leading.axleIndex,
        wheelIndex: leading.wheelIndex,
      },
      chassisLagSteps,
    },
  };
}
