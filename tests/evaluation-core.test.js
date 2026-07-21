// The shared evaluation-loop seam (runRealizedEvaluationLoop) — extraction
// contract for the physics-integrity investigation. Deterministic flavor
// only: the equivalence property is structural (the SAME statements run in
// both compositions), so one flavor suffices and keeps the local footprint
// light; the A–D golden locks in test:determinism separately prove the
// production path moved zero digests.
//
// Config: witness S (20260725:14, the smallest witness — 3 axles, 11 bodies)
// on the composite characterization terrain (seed 20260727 — features > 0 so
// the addCorridorWithFeatures path is exercised), 150 steps.

import { describe, test, expect } from 'vitest';
import { runEvaluation, runRealizedEvaluationLoop } from '../src/sim/evaluation.js';
import {
  FIXED_DT, addCorridorWithFeatures, createPhysics, realizeVehicle,
} from '../src/sim/physics/adapter.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { compareTraces } from '../src/sim/trace.js';
import { compileAssembly } from '../src/sim/assembly.js';
import { spawnPoseOnFlatStart } from '../src/sim/population-evaluation.js';
import { WITNESS_TERRAIN, witnessGenotype } from '../scripts/explosion-witnesses.js';

const STEPS = 150;
const ir = compileAssembly(witnessGenotype(20260725, 14));
const spawn = spawnPoseOnFlatStart(ir, { x: -44, z: 0 });

/**
 * Compose the loop exactly as runEvaluation does: createPhysics -> terrain
 * (+ its statics BVH step inside addFeatures) -> staticColliders readback ->
 * realizeVehicle -> runRealizedEvaluationLoop. `withWorld` runs between
 * realization and the loop so a test can build an inspect closure over the
 * live world/colliders it owns.
 */
async function composed({ maxSteps = STEPS, withWorld = null } = {}) {
  const { RAPIER, world } = await createPhysics({ deterministic: true });
  try {
    expect(world.timestep).toBe(Math.fround(FIXED_DT));
    const terrain = generateCorridorTerrain({ ...WITNESS_TERRAIN });
    expect(terrain.features.length).toBeGreaterThan(0); // composite path exercised
    addCorridorWithFeatures(RAPIER, world, terrain);
    const staticColliders = world.colliders.len();
    const realized = [realizeVehicle(RAPIER, world, ir, {
      position: spawn.position, targetWheelSurfaceSpeed: 5, wheelFriction: 1,
    })];
    const extra = withWorld === null ? {} : withWorld(world, realized);
    const result = runRealizedEvaluationLoop(world, realized, {
      requestedDt: FIXED_DT,
      maxSteps,
      traceMode: 'full',
      checkpointInterval: 1,
      staticColliders,
      ...extra,
    });
    return result;
  } finally {
    world.free();
  }
}

const direct = () => runEvaluation({
  deterministic: true,
  terrain: { ...WITNESS_TERRAIN },
  vehicles: [{ ir, spawn, targetWheelSurfaceSpeed: 5, wheelFriction: 1 }],
  maxSteps: STEPS,
  trace: { mode: 'full', checkpointInterval: 1 },
});

describe('runRealizedEvaluationLoop (the shared loop seam)', () => {
  test('a composition identical to runEvaluation reproduces its result byte-for-byte', { timeout: 240000 }, async () => {
    const a = await direct();
    const b = await composed();
    expect(b.trace.recordCount).toBe(a.trace.recordCount);
    const div = compareTraces(a.trace, b.trace);
    expect(div === null ? null : JSON.stringify(div)).toBeNull();
    expect(b.trace.digest).toBe(a.trace.digest);
    expect(b.counts).toEqual(a.counts);
    expect(b.vehicles).toEqual(a.vehicles);
    expect(b.requestedDt).toBe(a.requestedDt);
    expect(b.effectiveDt).toBe(a.effectiveDt);
    expect(b.executedSteps).toBe(a.executedSteps);
    expect(b.terminationReason).toBe(a.terminationReason);
  });

  test('a REAL contact-querying inspect is observationally inert (identical bytes and results)', { timeout: 240000 }, async () => {
    const silent = await composed();
    let calls = 0;
    let contactPairs = 0;
    let manifoldReads = 0;
    const noisy = await composed({
      withWorld: (world, realized) => {
        const colliders = [
          ...realized[0].chassis.colliders,
          ...realized[0].wheels.map((st) => st.wheel.collider),
        ];
        return {
          inspect: () => {
            calls += 1;
            for (const c of colliders) {
              world.contactPairsWith(c, (other) => {
                contactPairs += 1;
                world.contactPair(c, other, (manifold) => {
                  const n = manifold.numContacts();
                  for (let i = 0; i < n; i += 1) {
                    manifold.contactDist(i);
                    manifold.contactImpulse(i);
                    manifoldReads += 1;
                  }
                  manifold.normal();
                });
              });
            }
          },
        };
      },
    });
    // The hook genuinely ran and genuinely touched the narrow phase.
    expect(calls).toBe(STEPS + 1); // capture 0 + every step
    expect(contactPairs).toBeGreaterThan(0);
    expect(manifoldReads).toBeGreaterThan(0);
    // ... and changed nothing.
    const div = compareTraces(silent.trace, noisy.trace);
    expect(div === null ? null : JSON.stringify(div)).toBeNull();
    expect(noisy.trace.digest).toBe(silent.trace.digest);
    expect(noisy.vehicles).toEqual(silent.vehicles);
    expect(noisy.counts).toEqual(silent.counts);
  });

  test('requestedDt is the caller declaration; effectiveDt is the engine readback (honest 1/120 semantics)', { timeout: 240000 }, async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    try {
      world.timestep = 1 / 120;
      expect(world.timestep).toBe(Math.fround(1 / 120)); // the engine's f32 storage
      const terrain = generateCorridorTerrain({ ...WITNESS_TERRAIN });
      addCorridorWithFeatures(RAPIER, world, terrain);
      const staticColliders = world.colliders.len();
      const realized = [realizeVehicle(RAPIER, world, ir, {
        position: spawn.position, targetWheelSurfaceSpeed: 5, wheelFriction: 1,
      })];
      // A MISMATCHED declaration fails loud (the honest-dt contract): the
      // world runs 1/120 here, so declaring the production 1/60 must throw.
      expect(() => runRealizedEvaluationLoop(world, realized, {
        requestedDt: FIXED_DT, maxSteps: 10, staticColliders,
      })).toThrow(/does not match the engine readback/);
      const r = runRealizedEvaluationLoop(world, realized, {
        requestedDt: 1 / 120, maxSteps: 10, staticColliders,
      });
      // No physics claim — only the honest-reporting contract.
      expect(r.requestedDt).toBe(1 / 120);
      expect(r.effectiveDt).toBe(Math.fround(1 / 120));
      expect(r.executedSteps).toBe(10);
    } finally {
      world.free();
    }
  });

  test('direct-caller guards fail loud', { timeout: 240000 }, async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    try {
      const terrain = generateCorridorTerrain({ ...WITNESS_TERRAIN, featureDensity: 0 });
      const { addCorridor } = await import('../src/sim/physics/adapter.js');
      addCorridor(RAPIER, world, terrain);
      world.step();
      const staticColliders = world.colliders.len();
      const realized = [realizeVehicle(RAPIER, world, ir, {
        position: spawn.position, targetWheelSurfaceSpeed: 5, wheelFriction: 1,
      })];
      const base = { requestedDt: FIXED_DT, maxSteps: 1, staticColliders };
      expect(() => runRealizedEvaluationLoop(world, realized, { ...base, requestedDt: 0 }))
        .toThrow(/requestedDt/);
      expect(() => runRealizedEvaluationLoop(world, realized, { ...base, requestedDt: NaN }))
        .toThrow(/requestedDt/);
      expect(() => runRealizedEvaluationLoop(world, realized, { ...base, maxSteps: 0 }))
        .toThrow(/maxSteps/);
      expect(() => runRealizedEvaluationLoop(world, realized, { ...base, traceMode: 'verbose' }))
        .toThrow(/traceMode/);
      expect(() => runRealizedEvaluationLoop(world, realized, { ...base, staticColliders: -1 }))
        .toThrow(/staticColliders/);
      expect(() => runRealizedEvaluationLoop(world, realized, { ...base, inspect: 42 }))
        .toThrow(/inspect/);
      expect(() => runRealizedEvaluationLoop(world, realized, { ...base, integrity: 'on' }))
        .toThrow(/integrity/);
      // The guards threw BEFORE any stepping — the world is still steppable
      // and a real run still works afterwards.
      const r = runRealizedEvaluationLoop(world, realized, base);
      expect(r.executedSteps).toBe(1);
    } finally {
      world.free();
    }
  });

  test('the integrity fold is observationally inert: the off-arm reproduces identical trace bytes and identical non-integrity results', { timeout: 240000 }, async () => {
    // The detector-disabled arm exists ONLY at this direct-caller seam (the
    // inspect precedent) — this is the committed non-interference witness:
    // integrity on vs off changes NOTHING except the presence of the result
    // block itself (its fold reads the same already-taken body reads and
    // never touches the engine).
    const on = await composed();
    const off = await composed({ withWorld: () => ({ integrity: false }) });
    const div = compareTraces(on.trace, off.trace);
    expect(div === null ? null : JSON.stringify(div)).toBeNull();
    expect(off.trace.digest).toBe(on.trace.digest);
    expect(off.counts).toEqual(on.counts);
    // Every vehicle field except `integrity` is deep-equal; the off arm's
    // integrity is exactly null (an honest "did not run", never a fake ok).
    expect(on.vehicles[0].integrity).not.toBeNull();
    expect(off.vehicles[0].integrity).toBeNull();
    const strip = (v) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'integrity'));
    expect(off.vehicles.map(strip)).toEqual(on.vehicles.map(strip));
  });

  test('the production seam REJECTS the integrity toggle: runEvaluation has no off switch', { timeout: 240000 }, async () => {
    // Always-on is a policy, not an option: the GA path can never evaluate
    // with the detector disabled (the witnesses-never-disable-the-system
    // rule). Unknown-key rejection is the existing options discipline.
    await expect(runEvaluation({
      deterministic: true,
      terrain: { ...WITNESS_TERRAIN },
      vehicles: [{ ir, spawn, targetWheelSurfaceSpeed: 5, wheelFriction: 1 }],
      maxSteps: 1,
      integrity: false,
    })).rejects.toThrow(/unknown option|integrity/);
  });
});

describe('runRealizedEvaluationLoop — caller-collection ownership (round 14, external-review Major)', () => {
  // The reviewer's attack: `realized` is a genuine Array with an own no-op
  // `.map`. The seam used to consume it via `.map`/`.flatMap`/for-of, so the
  // hostile method returned [] and the function returned `vehicles.length ===
  // 0` with `world.bodies.len() === 0`, ran maxSteps physics steps, and
  // reported staticColliders === 0 — silent contradiction, no dialect error.
  // The classification called this seam "no caller collections", which
  // exempted it from every hostile-collection battery. Both are fixed.

  test('outer `realized.map` cannot shadow the walk: an own .map still produces the real vehicle count', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    try {
      const terrain = generateCorridorTerrain({ ...WITNESS_TERRAIN });
      addCorridorWithFeatures(RAPIER, world, terrain);
      const staticColliders = world.colliders.len();
      const realized = [realizeVehicle(RAPIER, world, ir, {
        position: spawn.position, targetWheelSurfaceSpeed: 5, wheelFriction: 1,
      })];
      // The hostile own method — pre-fix, this returned [].
      Object.defineProperty(realized, 'map', { value: () => [] });
      const r = runRealizedEvaluationLoop(world, realized, {
        requestedDt: FIXED_DT, maxSteps: 5, staticColliders, traceMode: 'none',
      });
      expect(r.vehicles.length, 'hostile .map must not shadow the walk').toBe(1);
    } finally {
      world.free();
    }
  });

  test('inner `wheels.flatMap` cannot shadow the walk: an own .flatMap still produces the real body count', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    try {
      const terrain = generateCorridorTerrain({ ...WITNESS_TERRAIN });
      addCorridorWithFeatures(RAPIER, world, terrain);
      const staticColliders = world.colliders.len();
      const vehicle = realizeVehicle(RAPIER, world, ir, {
        position: spawn.position, targetWheelSurfaceSpeed: 5, wheelFriction: 1,
      });
      // Hostile own methods on the inner wheels array — pre-fix, joints
      // came out of `.flatMap` and would have been empty; the sled would
      // have reported `jointState: 'notApplicable'` on a multi-jointed
      // vehicle.
      Object.defineProperty(vehicle.wheels, 'flatMap', { value: () => [] });
      const realized = [vehicle];
      // traceMode 'full' so we can count TRACKED bodies via records/step —
      // r.counts.bodies is the WORLD count (populated by realizeVehicle
      // regardless of the tracked walk), which is why the earlier draft of
      // this test missed the mutation. The trace record count = (maxSteps+1) ×
      // tracked-body-count per vehicle; hostile flatMap would leave one
      // tracked body (chassis) and shrink the trace, so the assertion below
      // fires on the fix's actual observable.
      const r = runRealizedEvaluationLoop(world, realized, {
        requestedDt: FIXED_DT, maxSteps: 5, staticColliders, traceMode: 'full',
      });
      expect(r.vehicles.length).toBe(1);
      const perStepBodies = r.trace.recordCount / 6; // 6 captures for maxSteps=5
      expect(perStepBodies, 'inner walk must track chassis + hubs + wheels, not just chassis').toBeGreaterThan(1);
    } finally {
      world.free();
    }
  });

  test('the TOP-LEVEL collection is shape-checked: an array-LIKE is not an array', async () => {
    // Round-14 follow-up. The indexed rewrite read `realized.length` off an
    // unvalidated argument, so any array-LIKE walked: `{ length: 0 }` produced
    // a clean `vehicles: []` result while the world stepped maxSteps, and
    // `null` leaked a foreign "Cannot read properties of null" TypeError
    // instead of this module's dialect. Fixing the ELEMENT walk without
    // checking the COLLECTION left the outermost input the only unguarded one.
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    try {
      const terrain = generateCorridorTerrain({ ...WITNESS_TERRAIN });
      addCorridorWithFeatures(RAPIER, world, terrain);
      const staticColliders = world.colliders.len();
      const opts = { requestedDt: FIXED_DT, maxSteps: 3, staticColliders, traceMode: 'none' };
      for (const bad of [{ length: 0 }, { length: 2 }, null, undefined, 'nope', 42]) {
        expect(() => runRealizedEvaluationLoop(world, bad, opts), String(bad))
          .toThrow(/runRealizedEvaluationLoop\.realized/);
      }
      // A genuine EMPTY array stays legal — a zero-vehicle run is a real case
      // (the explosion probe's static-only arms use it), so the guard must
      // reject the array-like without rejecting the empty array.
      const r = runRealizedEvaluationLoop(world, [], opts);
      expect(r.vehicles).toEqual([]);
    } finally {
      world.free();
    }
  });

  test('malformed shapes fail loud in the runner dialect (not a silent zero)', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic: true });
    try {
      const terrain = generateCorridorTerrain({ ...WITNESS_TERRAIN });
      addCorridorWithFeatures(RAPIER, world, terrain);
      const staticColliders = world.colliders.len();
      // realized[0] a string
      expect(() => runRealizedEvaluationLoop(world, ['nope'], {
        requestedDt: FIXED_DT, maxSteps: 5, staticColliders, traceMode: 'none',
      })).toThrow(/realized\[0\]/);
      // realized[0].wheels not an array
      const rec = realizeVehicle(RAPIER, world, ir, {
        position: spawn.position, targetWheelSurfaceSpeed: 5, wheelFriction: 1,
      });
      const bad = { ...rec, wheels: 'nope' };
      expect(() => runRealizedEvaluationLoop(world, [bad], {
        requestedDt: FIXED_DT, maxSteps: 5, staticColliders, traceMode: 'none',
      })).toThrow(/realized\[0\]\.wheels/);
    } finally {
      world.free();
    }
  });
});
