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
import { norm3, dist3 } from './integrity.js';

export const TRACE_FORENSICS_SCHEMA = 'boxcar3d.trace-forensics/1';

// Per-capture thresholds are DEFINED at this reference capture interval (the
// runner's FIXED_DT). For a trace captured at another dt, pass `captureDt`:
// the speed thresholds are absolute and stay fixed, while every per-capture
// quantity (one-step displacement = speed x dt; one-step velocity change =
// acceleration x dt) scales linearly with captureDt — the output echoes both
// the reference thresholds and the APPLIED (scaled) ones, plus the captureDt
// used, so onset values from different-timestep runs are never silently
// compared under mismatched units.
export const REFERENCE_CAPTURE_DT = 1 / 60;

export const FORENSIC_THRESHOLD_DEFAULTS = Object.freeze({
  alertSpeed: 25, // m/s (absolute — never scaled)
  alertSpeedDelta: 30, // m/s per REFERENCE capture (an ~1800 m/s^2 x dt quantity)
  alertStepDisplacement: 25 / 60, // m per REFERENCE capture (alertSpeed x dt)
  catastrophicSpeed: 1000, // m/s (absolute — never scaled)
  catastrophicStepDisplacement: 1000 / 60, // m per REFERENCE capture
  causalSpeedDelta: 1, // m/s per REFERENCE capture — backward-scan floor (~60 m/s^2 x dt)
  causalAngularSpeedDelta: 10, // rad/s per REFERENCE capture — backward-scan floor
});

// The per-capture (dt-scaled) threshold keys; speed thresholds are absolute.
const PER_CAPTURE_KEYS = Object.freeze([
  'alertSpeedDelta', 'alertStepDisplacement', 'catastrophicStepDisplacement',
  'causalSpeedDelta', 'causalAngularSpeedDelta',
]);

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

// norm3/dist3 moved to src/sim/integrity.js (the ONLINE detector) and imported
// back here so the two detectors provably share one vector arithmetic — the
// online/offline exact-equivalence contract depends on it. Pure refactor:
// identical implementations, identical results.

const bodyKey = (r) => `${r.vehicleIndex}|${r.bodyRole}|${r.axleIndex === null ? '-' : r.axleIndex}|${r.wheelIndex === null ? '-' : r.wheelIndex}`;

const BODY_META_KEYS = Object.freeze(['vehicleIndex', 'bodyRole', 'axleIndex', 'wheelIndex', 'reach']);
const BODY_META_ROLES = Object.freeze(['chassis', 'hub', 'wheel']);

// Full identity validation (the trace's own role-conditional rules): a
// malformed entry must fail loud, never silently miss its trace key and
// suppress tip-speed output.
// INDEXED and capture-once, never `bodies.forEach`. `forEach` is looked up on
// the CALLER's array, so an own no-op `forEach` skipped this entire validation
// walk (a malformed entry passed silently and tip speed came back null), and
// one yielding a phantom entry — or an ordinary `reach` accessor answering 1 to
// the three domain checks and 1e6 to `map.set` — made analyzeTrace report a tip
// speed derived from a value at no index (measured 4000 vs an honest 1). The
// duplicate-identity rejection was defeated the same way. The rule was already
// written 40 lines below, applied to the sibling loops and not to this one.
function resolveReachMap(bodies) {
  if (bodies === null) return null;
  if (!Array.isArray(bodies)) fail('bodies', bodies);
  const count = bodies.length;
  const map = new Map();
  for (let i = 0; i < count; i += 1) {
    const b = bodies[i];
    if (typeof b !== 'object' || b === null) fail(`bodies[${i}]`, b);
    for (const k of Object.keys(b)) {
      if (!BODY_META_KEYS.includes(k)) fail(`bodies[${i}].${k}`, 'unknown key');
    }
    const vehicleIndex = b.vehicleIndex;
    const bodyRole = b.bodyRole;
    const axleIndex = b.axleIndex;
    const wheelIndex = b.wheelIndex;
    const reach = b.reach;
    if (!Number.isInteger(vehicleIndex) || vehicleIndex < 0) {
      fail(`bodies[${i}].vehicleIndex`, vehicleIndex);
    }
    if (!BODY_META_ROLES.includes(bodyRole)) fail(`bodies[${i}].bodyRole`, bodyRole);
    if (bodyRole === 'chassis') {
      if (axleIndex !== null) fail(`bodies[${i}].axleIndex`, `${axleIndex} (chassis carries no station)`);
      if (wheelIndex !== null) fail(`bodies[${i}].wheelIndex`, `${wheelIndex} (chassis carries no station)`);
    } else {
      if (!Number.isInteger(axleIndex) || axleIndex < 0) fail(`bodies[${i}].axleIndex`, axleIndex);
      if (!Number.isInteger(wheelIndex) || wheelIndex < 0) fail(`bodies[${i}].wheelIndex`, wheelIndex);
    }
    if (typeof reach !== 'number' || !Number.isFinite(reach) || reach <= 0) {
      fail(`bodies[${i}].reach`, reach);
    }
    // The key is built from the CAPTURES, so the identity that is checked for
    // duplication is the identity the reach is stored under.
    const key = bodyKey({ vehicleIndex, bodyRole, axleIndex, wheelIndex });
    if (map.has(key)) fail(`bodies[${i}]`, `duplicate body identity ${key}`);
    map.set(key, reach);
  }
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
  if (typeof ir !== 'object' || ir === null) fail('ir', ir);
  const axles = ir.axles;
  if (!Array.isArray(axles)) fail('ir', ir);
  const axleCount = axles.length; // bound captured: the body reads caller code
  if (!Number.isInteger(vehicleIndex) || vehicleIndex < 0) fail('vehicleIndex', vehicleIndex);
  // Structural guards on the chassis chain, captured link by link. `ir.chassis`,
  // `.supports` and `.reach` were dereferenced unguarded, so three ordinary
  // shapes left this public seam as a foreign TypeError.
  const chassis = ir.chassis;
  const supports = typeof chassis === 'object' && chassis !== null ? chassis.supports : null;
  if (typeof chassis !== 'object' || chassis === null
    || typeof supports !== 'object' || supports === null) {
    fail('ir.chassis', chassis);
  }
  const entries = [{
    vehicleIndex, bodyRole: 'chassis', axleIndex: null, wheelIndex: null,
    reach: supports.reach,
  }];
  // Indexed, and every scalar captured once: `.forEach`/`.map` are looked up
  // on the caller's arrays (running caller code inside a module walk), and the
  // former shape read `axle.index` twice through the ternary and each hub /
  // wheel dimension twice inside its own Math.sqrt.
  for (let i = 0; i < axleCount; i += 1) {
    const axle = axles[i];
    if (typeof axle !== 'object' || axle === null) fail(`ir.axles[${i}]`, axle);
    const rawIndex = axle.index;
    const axleIndex = Number.isInteger(rawIndex) ? rawIndex : i;
    const wheels = axle.wheels;
    // A non-array `wheels` returned chassis-only metadata with NO error — a
    // silent path this module's indexed rewrite introduced (the previous
    // `.forEach` shape threw) — which nulls every wheel/hub tip-speed proxy
    // while `resolveReachMap`'s "never silently suppress" contract cannot see
    // entries that were never produced.
    if (!Array.isArray(wheels)) fail(`ir.axles[${i}].wheels`, wheels);
    const wheelCount = wheels.length;
    for (let wheelIndex = 0; wheelIndex < wheelCount; wheelIndex += 1) {
      const wheel = wheels[wheelIndex];
      if (typeof wheel !== 'object' || wheel === null) {
        fail(`ir.axles[${i}].wheels[${wheelIndex}]`, wheel);
      }
      const hub = wheel.hub;
      if (hub !== null && hub !== undefined) {
        const hubRadius = hub.radius;
        const hubHalfWidth = hub.halfWidth;
        entries.push({
          vehicleIndex,
          bodyRole: 'hub',
          axleIndex,
          wheelIndex,
          reach: Math.sqrt(hubRadius * hubRadius + hubHalfWidth * hubHalfWidth),
        });
      }
      const radius = wheel.radius;
      const halfWidth = wheel.width / 2;
      entries.push({
        vehicleIndex,
        bodyRole: 'wheel',
        axleIndex,
        wheelIndex,
        reach: Math.sqrt(radius * radius + halfWidth * halfWidth),
      });
    }
  }
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
 * bodyReachMetadataForIR); `thresholds` — diagnostic overrides (defined at
 * REFERENCE_CAPTURE_DT); `captureDt` — the trace's actual capture interval
 * (the run's effectiveDt) — per-capture thresholds scale linearly with it.
 * Returns plain data only; throws loud on a digest/none-mode result (no
 * records to analyze) or a trace-contract mismatch.
 */
export function analyzeTrace(traceResult, {
  bodies = null, thresholds = {}, captureDt = REFERENCE_CAPTURE_DT,
} = {}) {
  if (typeof traceResult !== 'object' || traceResult === null) fail('traceResult', traceResult);
  // Captured once, above the guards: the array that is gated here is the array
  // the analysis loop walks. (The loop already read `traceResult.records` a
  // third time, which made the "one reading" comment below untrue.)
  const version = traceResult.version;
  const mode = traceResult.mode;
  const recordBytes = traceResult.recordBytes;
  const records = traceResult.records;
  if (version !== EVALUATION_TRACE_VERSION) fail('traceResult.version', version);
  if (mode !== 'full') fail('traceResult.mode', `${mode} (analyzeTrace needs retained records — run with trace mode 'full')`);
  if (recordBytes !== RECORD_BYTES) fail('traceResult.recordBytes', recordBytes);
  if (!Array.isArray(records)) fail('traceResult.records', records);
  const recordCount = records.length;
  if (recordCount === 0) fail('traceResult.records', records);
  if (typeof captureDt !== 'number' || !Number.isFinite(captureDt) || captureDt <= 0) {
    fail('captureDt', captureDt);
  }
  const reference = resolveThresholds(thresholds);
  const dtScale = captureDt / REFERENCE_CAPTURE_DT;
  const applied = { ...reference };
  for (const k of PER_CAPTURE_KEYS) applied[k] = reference[k] * dtScale;
  const t = Object.freeze(applied);
  const reachMap = resolveReachMap(bodies);

  // Group decoded records per body, in capture order (the writer's canonical
  // order is already step-major; a per-body sort keeps this robust to any
  // valid interleaving). Consecutive captures are assumed stride-1 — the
  // runner's contract (capture indices 0..maxSteps).
  const perBodyRecords = new Map();
  let firstStep = Infinity;
  let lastStep = -Infinity;
  // Indexed, never `for...of`: the guard above gates `records` with
  // Array.isArray + `.length` (an indexed reading), so consuming it through
  // the caller's iterator let a genuine Array whose own Symbol.iterator
  // disagrees with its indices be ANALYSED as a different trace than the one
  // that was validated. Same rule as the encoders — one reading, the one the
  // consumer performs.
  // Bound captured with the guard above: `resolveReachMap(bodies)` runs
  // between the two readings, and `length` is writable (round-11).
  for (let ri = 0; ri < recordCount; ri += 1) {
    const bytes = records[ri];
    const rec = decodeTraceRecord(bytes);
    const key = bodyKey(rec);
    if (!perBodyRecords.has(key)) perBodyRecords.set(key, []);
    perBodyRecords.get(key).push(rec);
    if (rec.stepIndex < firstStep) firstStep = rec.stepIndex;
    if (rec.stepIndex > lastStep) lastStep = rec.stepIndex;
  }

  const perBody = [];
  // Escalation flags PER VEHICLE per step, for the backward causal scan. Was
  // trace-global (F13): an unrelated ghost vehicle escalating at step k-1 pulled
  // the leading vehicle's firstCausalCandidateStep back, crediting a chain that
  // belongs to a different vehicle. Keyed by vehicleIndex now.
  const escalationByVehicle = new Map();
  const EMPTY_ESCALATION = new Map();
  const markEscalation = (vehicleIndex, step) => {
    let m = escalationByVehicle.get(vehicleIndex);
    if (m === undefined) { m = new Map(); escalationByVehicle.set(vehicleIndex, m); }
    m.set(step, true);
  };

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
      // Per-REASON first crossings (additive diagnostics): which catastrophic
      // sub-threshold fired, and when it first did, per body. These exist so
      // offlineIntegrityView below can derive the online detector's FULL
      // reason ordering, not just the combined onset.
      firstCatastrophicSpeedStep: null,
      firstCatastrophicStepDisplacementStep: null,
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
          markEscalation(body.vehicleIndex, k);
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
      // Identical arithmetic to the former combined expression — split only so
      // the per-reason first steps can be recorded (NaN comparisons stay false).
      const catastrophicSpeed = speed > t.catastrophicSpeed;
      const catastrophicDisplacement = stepDisplacement !== null
        && stepDisplacement > t.catastrophicStepDisplacement;
      if (catastrophicSpeed && body.firstCatastrophicSpeedStep === null) {
        body.firstCatastrophicSpeedStep = k;
      }
      if (catastrophicDisplacement && body.firstCatastrophicStepDisplacementStep === null) {
        body.firstCatastrophicStepDisplacementStep = k;
      }
      const catastrophic = catastrophicSpeed || catastrophicDisplacement;
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
    // Backward scan: the contiguous escalation chain ENDING AT the alert, in
    // the leading body's OWN vehicle. If the alert step itself shows no per-step
    // escalation (a sustained-speed alert with no recent jump — the gradual
    // signature), the candidate stays at the alert step. The old code credited a
    // prior chain even when it did NOT reach the alert step (F12: `|| k <
    // firstAlertStep`), so a chain that ended before the alert was reported as
    // the cause; the scan now runs only when the alert step escalates.
    const esc = escalationByVehicle.get(leading.vehicleIndex) ?? EMPTY_ESCALATION;
    let k = firstAlertStep;
    if (esc.get(firstAlertStep) === true) {
      while (k - 1 > firstStep && esc.get(k - 1) === true) k -= 1;
    }
    firstCausalCandidateStep = k;
    const chassis = perBody.find(
      (b) => b.vehicleIndex === leading.vehicleIndex && b.bodyRole === 'chassis',
    );
    if (chassis !== undefined && chassis.firstAlertStep !== null) {
      chassisLagSteps = chassis.firstAlertStep - firstAlertStep;
    }
  }

  return {
    schema: TRACE_FORENSICS_SCHEMA,
    thresholds: reference,
    captureDt,
    appliedThresholds: t,
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

/**
 * Project an `analyzeTrace` result onto the ONLINE integrity contract
 * (src/sim/integrity.js): the derived CLASSIFICATION — status /
 * firstFailureStep / reasons — plus the shared observations, and the earliest
 * non-finite step (an offline-only extra datum, not part of the online block).
 * This is the ONE offline→online mapping — the online/offline equivalence
 * witnesses (the probe's `agreement` hard check and tests/integrity.test.js)
 * both consume it, so neither the field set nor the classification logic can
 * drift between the two sites. Pure.
 *
 * THE DERIVATION CONTRACT (mirrors foldIntegrity's documented scan order —
 * capture ascending → bodies in canonical order → per body catastrophicSpeed
 * → catastrophicStepDisplacement → nonFinite):
 *   - `analysis.perBody` is REQUIRED to be in the runner's canonical body
 *     order for the traced vehicle (chassis, then stations by axle-then-wheel
 *     with hub before wheel) — which is exactly analyzeTrace's report sort
 *     for a single-vehicle trace. Multi-vehicle traces aggregate ALL bodies;
 *     the equivalence claim is per SOLO run (the witnesses' shape).
 *   - status/firstFailureStep: each body contributes failure candidates
 *     (firstCatastrophicStep, bodyIndex, 0 → 'numericalDivergence') and
 *     (firstNonFiniteStep, bodyIndex, 1 → 'nonFinite'); the lexicographic
 *     minimum tuple wins — catastrophic is checked before finite WITHIN a
 *     body-step, and body order breaks same-step cross-body ties, exactly
 *     like the online scan.
 *   - reasons: each code's first occurrence is its minimum (step, bodyIndex,
 *     intra-body rank) tuple, ranks catastrophicSpeed 0 →
 *     catastrophicStepDisplacement 1 → nonFinite 2; codes sort by tuple —
 *     reproducing the online first-occurrence-order array exactly.
 */
const INTEGRITY_STEP_KEYS = Object.freeze(['firstCatastrophicStep', 'firstNonFiniteStep',
  'firstCatastrophicSpeedStep', 'firstCatastrophicStepDisplacementStep']);
const INTEGRITY_PEAK_KEYS = Object.freeze(['peakSpeed', 'peakSpeedDelta', 'peakStepDisplacement']);

// COPY ON INTAKE, BY INDEX. Every field this view classifies from or reports
// is read once into a module-owned row, and classification, the peak
// reductions and the returned observations all read the rows.
//
// The former shape read `analysis.perBody` six times and each per-body field
// two or three more (validation, then classification, then the reducers), so
// the status could be derived from one reading while the observations reported
// another — a body validated as catastrophic could be classified 'ok'. `maxOf`
// additionally evaluated `sel(b).value` TWICE per element, so the value that
// won the comparison was not necessarily the value stored.
function capturePerBody(analysis) {
  const perBody = analysis.perBody;
  if (!Array.isArray(perBody)) fail('analysis', analysis);
  // Capture the bound before the walk: the body reads caller accessors (`b[key]`
  // below), so an accessor that shrank `perBody` mid-walk otherwise skipped a
  // catastrophic body and offlineIntegrityView returned status:'ok' for it
  // (round-11 I3 — the loop-bound class survived in the one function whose
  // docblock claims to enforce it). `length` is writable on a genuine Array.
  const count = perBody.length;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const b = perBody[i];
    if (typeof b !== 'object' || b === null) fail(`analysis.perBody[${i}]`, b);
    const row = {};
    // Per-body first-step fields are REQUIRED (null = never fired); an
    // analysis missing them predates the classification contract — fail loud
    // rather than silently derive 'ok' from absent evidence.
    for (let k = 0; k < INTEGRITY_STEP_KEYS.length; k += 1) {
      const key = INTEGRITY_STEP_KEYS[k];
      if (!(key in b)) fail(`analysis.perBody[${i}].${key}`, 'missing');
      const v = b[key];
      if (v !== null && !Number.isInteger(v)) fail(`analysis.perBody[${i}].${key}`, v);
      row[key] = v;
    }
    for (let k = 0; k < INTEGRITY_PEAK_KEYS.length; k += 1) {
      const key = INTEGRITY_PEAK_KEYS[k];
      const p = b[key];
      if (typeof p !== 'object' || p === null) fail(`analysis.perBody[${i}].${key}`, p);
      row[key] = p.value;
    }
    rows.push(row);
  }
  return rows;
}

export function offlineIntegrityView(analysis) {
  if (typeof analysis !== 'object' || analysis === null) fail('analysis', analysis);
  const rows = capturePerBody(analysis);
  const onset = analysis.onset;
  if (typeof onset !== 'object' || onset === null) fail('analysis.onset', onset);
  const firstAlertStep = onset.firstAlertStep;
  const firstCatastrophicOnsetStep = onset.firstCatastrophicStep;
  const maxOf = (key) => {
    let m = 0;
    for (let i = 0; i < rows.length; i += 1) if (rows[i][key] > m) m = rows[i][key];
    return m;
  };
  const minOf = (key) => {
    let m = null;
    for (let i = 0; i < rows.length; i += 1) {
      const v = rows[i][key];
      if (v !== null && (m === null || v < m)) m = v;
    }
    return m;
  };

  // First occurrence of each failure CLASS and each reason CODE, as
  // (step, bodyIndex, intraRank) tuples over the canonical body order.
  const lt = (a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0];
    if (a[1] !== b[1]) return a[1] < b[1];
    return a[2] < b[2];
  };
  let firstFailure = null; // { tuple, status }
  const reasonFirsts = []; // { code, tuple }
  const noteReason = (code, step, bodyIndex, rank) => {
    if (step === null) return;
    const tuple = [step, bodyIndex, rank];
    const existing = reasonFirsts.find((r) => r.code === code);
    if (existing === undefined) reasonFirsts.push({ code, tuple });
    else if (lt(tuple, existing.tuple)) existing.tuple = tuple;
  };
  for (let bodyIndex = 0; bodyIndex < rows.length; bodyIndex += 1) {
    const b = rows[bodyIndex];
    for (const [step, status, rank] of [
      [b.firstCatastrophicStep, 'numericalDivergence', 0],
      [b.firstNonFiniteStep, 'nonFinite', 1],
    ]) {
      if (step === null) continue;
      const tuple = [step, bodyIndex, rank];
      if (firstFailure === null || lt(tuple, firstFailure.tuple)) firstFailure = { tuple, status };
    }
    noteReason('catastrophicSpeed', b.firstCatastrophicSpeedStep, bodyIndex, 0);
    noteReason('catastrophicStepDisplacement', b.firstCatastrophicStepDisplacementStep, bodyIndex, 1);
    noteReason('nonFinite', b.firstNonFiniteStep, bodyIndex, 2);
  }
  reasonFirsts.sort((a, b) => (lt(a.tuple, b.tuple) ? -1 : 1));

  return {
    status: firstFailure === null ? 'ok' : firstFailure.status,
    firstFailureStep: firstFailure === null ? null : firstFailure.tuple[0],
    reasons: reasonFirsts.map((r) => r.code),
    observations: {
      peakBodySpeed: maxOf('peakSpeed'),
      peakSpeedDelta: maxOf('peakSpeedDelta'),
      peakStepDisplacement: maxOf('peakStepDisplacement'),
      firstAlertStep,
      firstCatastrophicStep: firstCatastrophicOnsetStep,
    },
    firstNonFiniteStep: minOf('firstNonFiniteStep'),
  };
}
