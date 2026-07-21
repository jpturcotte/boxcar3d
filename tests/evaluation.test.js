// Canonical evaluation runner + declared fixtures — the functional gates
// (mission §19: completes-finite dual-flavor, exact entity counts, sleep
// captured without assuming sleep, hooks, profiler plumbing, fail-loud
// options) plus the fixture contract (repair-stability, freshness, descriptor
// coherence, declared-spawn clearance).
//
// MEASURED (this worktree, Windows, 2026-07-11, deterministic flavor unless
// noted; bands carry cross-platform margin):
//   fixture A: dx +19.425 m / 600 steps (the s0-drive witness genes; floor 10)
//   fixture B: dx +28.6 m / 900 steps on the composite corridor, and the
//     vehicle SLEEPS at the end (sleepingAtEnd 7) — natural sleep coverage;
//     dx recorded, deliberately NOT floor-asserted (composite terrain may
//     block a mixed build; determinism, not driving prowess, is B's gate)
//   fixture C: dx +12.785 m / 600 steps, 25 bodies / 24 joints exact
//   ghost pair (A×2, identical spawns): forwardDistance delta exactly 0
//   NaN latch: NO legal input reaches it (velocities ≤1e25 m/s stay finite
//     60+ steps; ~3e38 hard-panics wasm = thrown error, not NaN) — the latch
//     classification is tested at the readBodyState seam with raw engine
//     states instead; see the finding in src/sim/evaluation.js.

import { describe, test, expect } from 'vitest';
import {
  runEvaluation, readBodyState, RUN_TERMINATION,
} from '../src/sim/evaluation.js';
import {
  FIXTURE_A, FIXTURE_B, FIXTURE_C, EVALUATION_FIXTURES, evaluationOptionsFor,
} from '../src/sim/evaluation-fixtures.js';
import { compileAssembly, repairGenotype } from '../src/sim/assembly.js';
import { FIXED_DT, createPhysics, vehicleWheelTransforms } from '../src/sim/physics/adapter.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { decodeTraceRecord } from '../src/sim/trace.js';

const FLAVORS = [[false, 'default flavor'], [true, 'deterministic flavor']];

// --- Fixture contract (pure, flavor-independent) ------------------------------

describe('declared fixtures', () => {
  test('every fixture is repair-stable: the genes ARE the phenotype', () => {
    for (const fx of EVALUATION_FIXTURES) {
      const g = fx.buildGenotype();
      expect(repairGenotype(g), fx.name).toEqual(g);
    }
  });

  test('buildGenotype returns fresh, mutation-isolated data each call', () => {
    for (const fx of EVALUATION_FIXTURES) {
      const a = fx.buildGenotype();
      const b = fx.buildGenotype();
      expect(a).toEqual(b);
      a.axles[0].radius = 0.999;
      a.frame.segments[0].nodes[0].gap = 0.999;
      expect(fx.buildGenotype(), fx.name).toEqual(b);
    }
  });

  test('descriptor coherence: compiled counts match expected; declared spawn clears the pad by (0, 0.05]', () => {
    const names = new Set();
    for (const fx of EVALUATION_FIXTURES) {
      names.add(fx.name);
      expect(Number.isInteger(fx.version) && fx.version >= 1, fx.name).toBe(true);
      expect(fx.terrainConfig.seed, fx.name).toBeGreaterThan(20260714); // fresh declared seeds
      const ir = compileAssembly(fx.buildGenotype());
      const stations = ir.axles.reduce((n, a) => n + a.wheels.length, 0);
      const hubs = ir.axles.reduce((n, a) => n + a.wheels.filter((w) => w.hub !== null).length, 0);
      expect(stations, fx.name).toBe(fx.expected.stations);
      expect(stations, fx.name).toBe(fx.expected.wheels);
      expect(1 + stations + hubs, fx.name).toBe(fx.expected.bodies);
      expect(stations + hubs, fx.name).toBe(fx.expected.joints);
      expect(ir.chassis.colliders.length, fx.name).toBe(fx.expected.chassisColliders);
      expect(fx.expected.chassisColliders + stations + hubs, fx.name).toBe(fx.expected.vehicleColliders);
      // Spawn-clearance coherence tooth: the declared literal spawn must put
      // the lowest wheel bottom within (0, 0.05] m of the exactly-flat pad.
      const wheelDrop = Math.max(...vehicleWheelTransforms(ir, {}).map(
        (p) => -p.local.y + ir.axles[p.axleIndex].wheels[p.wheelIndex].radius,
      ));
      const clearance = fx.spawn.position.y - wheelDrop;
      expect(clearance, fx.name).toBeGreaterThan(0);
      expect(clearance, fx.name).toBeLessThanOrEqual(0.05);
      expect(fx.spawn.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    }
    expect(names.size).toBe(EVALUATION_FIXTURES.length);
    // A and C zero every composite knob; B deliberately keeps the defaults ON.
    for (const fx of [FIXTURE_A, FIXTURE_C]) {
      expect(fx.terrainConfig).toMatchObject({
        craterDensity: 0, featureDensity: 0, sandCoverage: 0, mudCoverage: 0,
      });
    }
    for (const knob of ['craterDensity', 'featureDensity', 'sandCoverage', 'mudCoverage']) {
      expect(Object.prototype.hasOwnProperty.call(FIXTURE_B.terrainConfig, knob)).toBe(false);
    }
  });

  test('evaluationOptionsFor compiles fresh IRs per vehicle and validates its inputs', () => {
    const opts = evaluationOptionsFor(FIXTURE_A, { deterministic: true, vehicleCount: 3 });
    expect(opts.vehicles).toHaveLength(3);
    expect(opts.vehicles[0].ir).not.toBe(opts.vehicles[1].ir); // fresh objects, never shared
    expect(opts.vehicles[0].ir).toEqual(opts.vehicles[1].ir);
    expect(opts.terrain).toEqual({ ...FIXTURE_A.terrainConfig });
    expect(opts.maxSteps).toBe(FIXTURE_A.maxSteps);
    expect(() => evaluationOptionsFor(null)).toThrow(/evaluation-fixtures: invalid input at fixture/);
    expect(() => evaluationOptionsFor(FIXTURE_A, { vehicleCount: 0 })).toThrow(/vehicleCount/);
  });
});

// --- Options fail-loud (pre-world; flavor-independent) -------------------------

describe('runEvaluation options validation', () => {
  const base = () => evaluationOptionsFor(FIXTURE_A, { deterministic: true });

  test('negative teeth: every malformed option fails loud before any world exists', async () => {
    const cases = [
      [(o) => { delete o.terrain.seed; }, /terrain\.seed/],
      [(o) => { o.terrain.featureDensitty = 0.9; }, /terrain\.featureDensitty.*unknown key/],
      [(o) => { o.vehicles = []; }, /vehicles/],
      [(o) => { o.maxSteps = 0; }, /maxSteps/],
      [(o) => { o.maxSteps = 1.5; }, /maxSteps/],
      [(o) => { o.stepBudget = 600; }, /options\.stepBudget.*unknown key/],
      [(o) => { o.vehicles[0].genotype = {}; }, /vehicles\[0\]\.genotype.*unknown key/],
      // Migration tombstone: the removed drive option gets the rename
      // diagnosis, never a generic unknown-key failure.
      [(o) => { o.vehicles[0].targetAngvel = -10; }, /vehicles\[0\]\.targetAngvel.*removed; use targetWheelSurfaceSpeed/],
      [(o) => { o.vehicles[0].spawn.linVel = { x: 0, y: 0, z: 0 }; }, /spawn\.linVel.*unknown key/],
      [(o) => { o.trace = { mode: 'digset' }; }, /trace\.mode/],
      [(o) => { o.trace = { mode: 'digest', checkpointInterval: 0 }; }, /checkpointInterval/],
      [(o) => { o.termination = 'goal'; }, /termination/],
      [(o) => { o.hooks = { onPhase: 'log' }; }, /hooks\.onPhase/],
      [(o) => { o.vehicles[0].spawn.position = { x: NaN, y: 1, z: 0 }; }, /spawn\.position/],
      [(o) => { o.profile = 1; }, /profile/],
      // Traced runs cannot exceed the u32 stepIndex field — rejected pre-world,
      // not mid-run at the final capture's encode.
      [(o) => { o.trace = { mode: 'digest' }; o.maxSteps = 0x100000000; }, /MAX_STEP_INDEX/],
      // C10/F7: even UNTRACED, maxSteps bounds the profile buffer and per-step
      // allocations. 2^30 reserved multiple GB / threw a foreign RangeError.
      [(o) => { o.trace = { mode: 'none' }; o.profile = true; o.maxSteps = 2 ** 30; }, /MAX_EVALUATION_STEPS/],
    ];
    for (const [mutate, re] of cases) {
      const opts = base();
      mutate(opts);
      await expect(runEvaluation(opts), String(re)).rejects.toThrow(re);
    }
  });

  // --- Round-11: the validated reading IS the executed reading ---------------
  //
  // validateOptions returned the caller's `terrain` and `vehicles` BY
  // REFERENCE, and runEvaluation re-read them after `hooks.onPhase(...)` (an
  // invocation of caller code) and across `await createPhysics(...)`. Every
  // case below was measured escaping that gap with an ordinary own accessor on
  // a plain object — no Proxy, no lying prototype. This is the runner's copy of
  // the single-read invariant, and it lives here because the seam is private
  // and reachable only through physics: a fix no test can redden is not a fix.

  test('a two-faced terrain.seed cannot make the runner execute a different world', async () => {
    const opts = base();
    let reads = 0;
    const honestSeed = opts.terrain.seed;
    Object.defineProperty(opts.terrain, 'seed', {
      configurable: true,
      enumerable: true,
      get() { reads += 1; return reads === 1 ? honestSeed : 999; },
    });
    const r = await runEvaluation({ ...opts, trace: { mode: 'digest' } });
    expect(reads).toBe(1); // one reading: the guarded one is the generated one
    const control = await runEvaluation({ ...base(), trace: { mode: 'digest' } });
    expect(r.trace.digest).toBe(control.trace.digest);
  });

  test('a non-enumerable own terrain.seed is refused, never silently defaulted', async () => {
    // `hasOwnProperty` sees it; `{ ...TERRAIN_DEFAULTS, ...terrain }` does not.
    // Measured: this ran and digested the seed-0 DEFAULT terrain, with the
    // guard whose message says that must never happen reporting nothing.
    const opts = base();
    const seed = opts.terrain.seed;
    delete opts.terrain.seed;
    Object.defineProperty(opts.terrain, 'seed', { value: seed, enumerable: false });
    await expect(runEvaluation(opts)).rejects.toThrow(/terrain.*non-enumerable/);
  });

  test('a two-faced trace.mode cannot make a run capture what it was not asked to', async () => {
    const opts = base();
    let reads = 0;
    opts.trace = {
      get mode() { reads += 1; return reads === 1 ? 'none' : 'full'; },
    };
    const r = await runEvaluation(opts);
    expect(reads).toBe(1);
    // Mode 'none' is literal no-work: the result carries no trace envelope at
    // all, so a run that had silently switched to 'full' is unmistakable.
    expect(r.trace).toBeNull();
  });

  test('a two-faced spawn.position cannot realize a vehicle where it was not validated', async () => {
    const opts = base();
    const honest = opts.vehicles[0].spawn.position;
    let reads = 0;
    Object.defineProperty(opts.vehicles[0].spawn, 'position', {
      configurable: true,
      enumerable: true,
      get() { reads += 1; return reads === 1 ? honest : { x: honest.x + 12, y: honest.y, z: honest.z }; },
    });
    const r = await runEvaluation({ ...opts, maxSteps: 2, trace: { mode: 'none' } });
    expect(reads).toBe(1);
    // Capture 0 is post-realization, so the final pose reflects the spawn that
    // actually ran — it must be the validated one, not the second reading.
    expect(r.vehicles[0].finalPose.translation.x).toBeCloseTo(honest.x, 0);
  });

  test('a targetAngvel tombstone appearing after validation cannot reach the realizer', async () => {
    // The removed drive option must always produce the rename diagnosis. With
    // the vehicle read twice, a key that materializes on the SECOND read was
    // forwarded silently (unknown realizer options are ignored), so the vehicle
    // ran at the default surface speed while the caller believed otherwise.
    const opts = base();
    const v = opts.vehicles[0];
    let reads = 0;
    Object.defineProperty(opts.vehicles, '0', {
      configurable: true,
      enumerable: true,
      get() { reads += 1; return reads === 1 ? v : { ...v, targetAngvel: -10 }; },
    });
    const r = await runEvaluation({ ...opts, maxSteps: 2, trace: { mode: 'none' } });
    expect(reads).toBe(1);
    expect(r.vehicles).toHaveLength(1);
  });

  // --- The break-it sweep: spawn.rotation/linvel and terrain (C8) ------------
  //
  // Round-11 C3 captured spawn.position componentwise but left spawn.rotation
  // and spawn.linvel by reference, so realizeVehicle re-read each component ~25
  // times: a validated identity quaternion executed as yaw-90, and a |q|²=1
  // reading passed the unit-quaternion gate to a realized non-unit rotation.

  test('a two-faced spawn.rotation cannot make the validated pose differ from the executed one', async () => {
    const S = Math.SQRT1_2;
    const twoFaced = (first, then) => {
      const c = { x: 0, y: 0, z: 0, w: 0 }; const o = {};
      for (const k of ['x', 'y', 'z', 'w']) {
        Object.defineProperty(o, k, { enumerable: true, get() { c[k] += 1; return c[k] === 1 ? first[k] : then[k]; } });
      }
      return o;
    };
    const run = async (rot) => {
      const o = base(); o.maxSteps = 30; o.trace = { mode: 'digest' };
      o.vehicles[0].spawn.rotation = rot;
      return runEvaluation(o);
    };
    const honestId = await run({ x: 0, y: 0, z: 0, w: 1 });
    // The accessor is honest on the FIRST read of each component (the only read
    // the captured pose now performs) and lies afterward. The run must match the
    // honest first-read value, not the poison.
    const attacked = await run(twoFaced({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: S, z: 0, w: S }));
    expect(attacked.trace.digest).toBe(honestId.trace.digest);
  });

  test('a genuinely non-unit spawn.rotation is still rejected by the unit-quaternion gate', async () => {
    const o = base(); o.maxSteps = 2; o.trace = { mode: 'none' };
    o.vehicles[0].spawn.rotation = { x: 0.9, y: 0.9, z: 0.9, w: 0.9 }; // |q|² = 3.24
    await expect(runEvaluation(o)).rejects.toThrow(/unit quaternion/);
  });

  test('a two-faced spawn.linvel cannot slip a NaN past finiteVec via a later read', async () => {
    const o = base(); o.maxSteps = 2; o.trace = { mode: 'none' };
    // Honest {0,0,0} on the first read of each component — the captured value —
    // and NaN afterward. The single-read capture runs the honest value.
    const c = { x: 0, y: 0, z: 0 }; const lv = {};
    for (const k of ['x', 'y', 'z']) {
      Object.defineProperty(lv, k, { enumerable: true, get() { c[k] += 1; return c[k] === 1 ? 0 : NaN; } });
    }
    o.vehicles[0].spawn.linvel = lv;
    const r = await runEvaluation(o);
    expect(r.vehicles[0].finite).toBe(true);
  });

  test('an own __proto__ key in featureTypeWeights cannot re-prototype the terrain copy', async () => {
    const o = base();
    o.terrain = { ...o.terrain, featureTypeWeights: JSON.parse('{"__proto__":{"boulder":9},"ramp":0.3,"log":0.3}') };
    await expect(runEvaluation({ ...o, maxSteps: 2, trace: { mode: 'none' } })).rejects.toThrow();
  });

  test('a terrain whose deleter-accessor removes seed during the walk fails loud, never seed-0', async () => {
    // An accessor on an earlier key deletes `seed` mid-walk. The old shape read
    // the terrain twice (presence guard, then spread), so the guard saw seed and
    // the run digested the default seed-0 world; the single capture makes the
    // deleted seed `undefined`, which fails loud.
    const o = base();
    const t = { featureDensity: 0.1, seed: 20260722, length: 120, startFlatLength: 30 };
    Object.defineProperty(t, 'featureDensity', {
      enumerable: true, configurable: true,
      get() { delete t.seed; return 0.1; },
    });
    o.terrain = t;
    await expect(runEvaluation({ ...o, maxSteps: 2, trace: { mode: 'none' } })).rejects.toThrow(/seed/);
  });

  test('a terrain on a custom prototype is rejected, never run with inherited knobs dropped', async () => {
    const o = base();
    o.terrain = Object.assign(Object.create({ featureDensity: 0.9 }), { seed: 20260722, length: 120, startFlatLength: 30 });
    await expect(runEvaluation({ ...o, maxSteps: 2, trace: { mode: 'none' } })).rejects.toThrow(/plain object/);
  });
});

// --- readBodyState: the latch classification seam (measured engine states) ----

describe.each(FLAVORS)('readBodyState (deterministic=%s, %s)', (deterministic) => {
  test('valid, non-finite, and invalid classifications against the real engine', { timeout: 60000 }, async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
      world.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
      // Valid + finite.
      const healthy = readBodyState(body);
      expect(healthy.valid).toBe(true);
      expect(healthy.finite).toBe(true);
      expect(healthy.translation).toEqual({ x: 0, y: 5, z: 0 });
      expect(typeof healthy.sleeping).toBe('boolean');
      // Engine-side NaN (raw setLinvel accepts it — measured) → finite:false,
      // still valid; the NaN flows through so the trace records the evidence.
      body.setLinvel({ x: NaN, y: 0, z: 0 }, true);
      const poisoned = readBodyState(body);
      expect(poisoned.valid).toBe(true);
      expect(poisoned.finite).toBe(false);
      expect(Number.isNaN(poisoned.linvel.x)).toBe(true);
      // Removed body → isValid() false → canonical NaNs WITHOUT touching pose
      // readbacks (a stale pose read wasm-panics — the guard is load-bearing).
      world.removeRigidBody(body);
      const stale = readBodyState(body);
      expect(stale).toEqual({
        valid: false, sleeping: false, finite: false,
        translation: { x: NaN, y: NaN, z: NaN },
        rotation: { x: NaN, y: NaN, z: NaN, w: NaN },
        linvel: { x: NaN, y: NaN, z: NaN },
        angvel: { x: NaN, y: NaN, z: NaN },
      });
    } finally {
      world.free();
    }
  });
});

// --- Functional gates: fixtures complete finite (both flavors) -----------------

describe.each(FLAVORS)('runEvaluation fixtures (deterministic=%s, %s)', (deterministic) => {
  test('fixture A completes finite with the expected counts and forward progress', { timeout: 120000 }, async () => {
    const r = await runEvaluation(evaluationOptionsFor(FIXTURE_A, { deterministic }));
    expect(r.terminationReason).toBe(RUN_TERMINATION.COMPLETED);
    expect(r.executedSteps).toBe(600);
    expect(r.requestedDt).toBe(FIXED_DT);
    expect(r.effectiveDt).toBe(Math.fround(FIXED_DT)); // the MEASURED f32 dt contract
    const v = r.vehicles[0];
    expect(v.finite).toBe(true);
    expect(v.terminated).toEqual({ step: null, reason: null });
    expect(v.forwardDistance).toBeGreaterThan(10); // measured 19.425
    expect(v.forwardDistance).toBeLessThan(40);
    expect(Math.abs(v.finalPose.translation.z)).toBeLessThan(1);
    expect(v.bodies).toMatchObject({ count: 5, allValid: true });
    expect(v.joints).toEqual({ count: 4, allValid: true });
    expect(v.stationCount).toBe(4);
    expect(v.bodies.sleepingAtEnd).toBeGreaterThanOrEqual(0); // a count, never an expectation
    // The numerical-integrity block is present on every production result and
    // well-formed. Fixture A is a curated HEALTHY vehicle on a flat pad — its
    // status being 'ok' is a behavioral gate on a known-good subject (not a
    // must-explode assertion anywhere). The observations shape is fixed.
    expect(v.integrity.policyVersion).toBe(1);
    expect(v.integrity.status).toBe('ok');
    expect(v.integrity.firstFailureStep).toBeNull();
    expect(v.integrity.reasons).toEqual([]);
    expect(Object.keys(v.integrity.observations).sort()).toEqual([
      'firstAlertStep', 'firstCatastrophicStep', 'peakBodySpeed',
      'peakSpeedDelta', 'peakStepDisplacement',
    ]);
    expect(v.integrity.observations.firstCatastrophicStep).toBeNull();
    expect(r.counts).toEqual({
      bodies: 5, colliders: 3 + FIXTURE_A.expected.vehicleColliders, joints: 4, staticColliders: 3,
    });
    expect(r.trace).toBeNull(); // default mode 'none'
    expect(r.timing).toBeNull();
  });

  test('fixture B completes finite on the full composite corridor', { timeout: 120000 }, async () => {
    const r = await runEvaluation(evaluationOptionsFor(FIXTURE_B, { deterministic }));
    expect(r.executedSteps).toBe(900);
    const v = r.vehicles[0];
    expect(v.finite).toBe(true);
    expect(v.bodies).toMatchObject({ count: 7, allValid: true });
    expect(v.joints).toEqual({ count: 6, allValid: true });
    // The composite statics: floor + 2 walls + one collider per realized feature
    // (recomputed from the pure generator — the terrain path is deterministic).
    const terrain = generateCorridorTerrain(FIXTURE_B.terrainConfig);
    expect(terrain.features.length).toBeGreaterThan(0); // B must exercise the feature path
    expect(r.counts.staticColliders).toBe(3 + terrain.features.length);
    expect(r.counts.bodies).toBe(7);
    // dx recorded, not floor-asserted: measured +28.6 m, then the build SLEEPS
    // (sleepingAtEnd 7 — natural no-assumed-sleep coverage runs the other way).
    expect(Number.isFinite(v.forwardDistance)).toBe(true);
  });

  test('fixture C holds the exact maximum topology: 25 bodies / 24 joints', { timeout: 120000 }, async () => {
    const r = await runEvaluation(evaluationOptionsFor(FIXTURE_C, { deterministic }));
    expect(r.executedSteps).toBe(600); // termination counts physics steps
    const v = r.vehicles[0];
    expect(v.finite).toBe(true);
    expect(v.bodies).toMatchObject({ count: 25, allValid: true });
    expect(v.joints).toEqual({ count: 24, allValid: true });
    expect(v.stationCount).toBe(12);
    expect(r.counts).toEqual({
      bodies: 25, colliders: 3 + FIXTURE_C.expected.vehicleColliders, joints: 24, staticColliders: 3,
    });
    expect(v.forwardDistance).toBeGreaterThan(5); // measured 12.785
  });
});

// --- Runner plumbing (deterministic flavor only — flavor-invariant semantics) --

describe('runEvaluation plumbing (deterministic flavor)', () => {
  test('ghost multi-vehicle: identical spawns coexist, counts double, input order kept', { timeout: 120000 }, async () => {
    const r = await runEvaluation(evaluationOptionsFor(FIXTURE_A, { deterministic: true, vehicleCount: 2 }));
    expect(r.vehicles).toHaveLength(2);
    for (const v of r.vehicles) {
      expect(v.finite).toBe(true);
      expect(v.bodies.count).toBe(5);
    }
    expect(r.counts.bodies).toBe(10);
    expect(r.counts.joints).toBe(8);
    expect(r.counts.colliders).toBe(3 + 2 * FIXTURE_A.expected.vehicleColliders);
    // Identical ghosts produce identical trajectories (measured delta exactly
    // 0) — the bit-level lock lives in the determinism suite.
    expect(Math.abs(r.vehicles[0].forwardDistance - r.vehicles[1].forwardDistance)).toBeLessThan(1e-9);
  });

  test('zero-axle sled: legal, chassis-only, jointState notApplicable in the trace', { timeout: 60000 }, async () => {
    const sledGenotype = FIXTURE_A.buildGenotype();
    sledGenotype.axles = [];
    const opts = evaluationOptionsFor(FIXTURE_A, { deterministic: true, trace: { mode: 'full' } });
    opts.vehicles = [{ ir: compileAssembly(sledGenotype), spawn: { position: { x: -45, y: 0.5, z: 0 } } }];
    opts.maxSteps = 60;
    const r = await runEvaluation(opts);
    const v = r.vehicles[0];
    expect(v.finite).toBe(true);
    expect(v.stationCount).toBe(0);
    expect(v.joints).toEqual({ count: 0, allValid: true });
    expect(r.trace.recordCount).toBe(61); // 61 captures × 1 chassis record
    const first = decodeTraceRecord(r.trace.records[0]);
    expect(first).toMatchObject({
      bodyRole: 'chassis', axleIndex: null, wheelIndex: null, jointState: 'notApplicable',
    });
  });

  test('hooks receive exactly the six phase names, in order, with no payload', { timeout: 60000 }, async () => {
    const calls = [];
    const opts = evaluationOptionsFor(FIXTURE_A, {
      deterministic: true,
      hooks: { onPhase: (...args) => calls.push(args) },
    });
    opts.maxSteps = 30;
    await runEvaluation(opts);
    expect(calls.map((a) => a[0])).toEqual(['createPhysics', 'terrain', 'realize', 'run', 'collect', 'done']);
    for (const args of calls) {
      expect(args).toHaveLength(1); // names only — no timestamp ever crosses the seam
      expect(typeof args[0]).toBe('string');
    }
  });

  test('profiler plumbing: per-step engine samples when on, null when off — magnitudes never asserted', { timeout: 60000 }, async () => {
    const on = evaluationOptionsFor(FIXTURE_A, { deterministic: true, profile: true });
    on.maxSteps = 60;
    const rOn = await runEvaluation(on);
    expect(rOn.timing.stepMs).toBeInstanceOf(Float64Array);
    expect(rOn.timing.stepMs).toHaveLength(60);
    for (const ms of rOn.timing.stepMs) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    const off = evaluationOptionsFor(FIXTURE_A, { deterministic: true });
    off.maxSteps = 30;
    expect((await runEvaluation(off)).timing).toBeNull();
  });

  test('digest trace: shape-static record count across vehicles and captures', { timeout: 60000 }, async () => {
    const opts = evaluationOptionsFor(FIXTURE_A, {
      deterministic: true, vehicleCount: 2, trace: { mode: 'digest', checkpointInterval: 1 },
    });
    opts.maxSteps = 60;
    const r = await runEvaluation(opts);
    expect(r.trace.recordCount).toBe(61 * 10); // (60+1) captures × 2 vehicles × 5 bodies
    expect(r.trace.byteCount).toBe(r.trace.recordCount * 128);
    expect(r.trace.checkpoints).toHaveLength(61);
    expect(r.trace.records).toBeNull(); // digest mode retains nothing
  });
});
