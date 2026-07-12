// realizeS0Vehicle's structural contract — pure pose math, creation-time
// realization readbacks, the S1/S2 realization gate, transactional cleanup,
// and the legal edge shapes. Everything here is creation-time (no stepping);
// the dynamic witness lives in tests/s0-drive.test.js. BOTH flavors via
// describe.each × createPhysics; no random draws — fixtures are hand-built
// literals (the assembly.test.js validGenotype style), so no seeds.
//
// Tolerance discipline: Rapier stores poses in f32, and f32 ULP scales with
// MAGNITUDE (~1.2e-7 relative: one ULP at |x| = 45 is ~5.4e-6 — a flat
// 1e-6 band provably fails there), so every WORLD readback (translations,
// rotations, anchors) is asserted at f32 scale via f32Tol(magnitude). The
// 1e-12 exactness band applies ONLY to the pure-JS s0WheelTransforms math,
// which must be deterministic to the bit.

import { describe, test, expect } from 'vitest';
import {
  ADDITIONAL_SOLVER_ITERATIONS,
  CHASSIS_GROUPS,
  MOTOR_TARGET_WHEEL_SURFACE_SPEED,
  REVOLUTE_AXIS,
  S0_MOTOR_MODEL_NAME,
  SOFT_CCD_PREDICTION,
  WHEEL_COLLIDER_ROTATION,
  WHEEL_FRICTION,
  WHEEL_GROUPS,
  createPhysics,
  realizeS0Vehicle,
  s0WheelTransforms,
} from '../src/sim/physics/adapter.js';
import { SUSPENSION_TYPES, compileAssembly, repairGenotype } from '../src/sim/assembly.js';
import { rotateVector } from './rotate-oracle.js';

// The canonical all-S0 fixture: the assembly.test.js validGenotype with
// suspType 0 (S0) — chosen so NO repair rule bites (proven below), so the
// declared genes ARE the compiled phenotype. Two paired driven axles, spine
// family, wheel r 0.5 m / width 0.3 m.
function canonicalS0Genotype(overrides = {}) {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01, over = {}) => ({
    posX01,
    paired: 1,
    trackHalf: 0.5,
    radius: 0.6,
    width: 0.5,
    density: 0.15,
    suspType: 0, // S0 — the one gene changed from validGenotype (never repaired)
    stiffness: 0.5,
    damping: 0.5,
    travel: 0.5,
    restLength: 0.5,
    driven: 1,
    share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
    ...over,
  });
  return {
    version: 1,
    hue: 0.25,
    symmetric: 0.9,
    power: 0.5,
    frameDensity: 0.3,
    frame: {
      family: 0.1, // spine
      segments: [{
        nodeCount: 0.5, // 4 active nodes -> 3 beam colliders
        nodes: Array.from({ length: 6 }, node),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [axle(0.2, overrides.axle), axle(0.8, overrides.axle)],
    ...overrides.top,
  };
}

const canonicalIR = () => compileAssembly(canonicalS0Genotype());

// The oracle is `rotateVector` (tests/rotate-oracle.js): the quaternion
// sandwich, a DIFFERENT formula from the adapter's 2·q×v expansion, so a
// sign/ordering slip in the kernel cannot hide by corrupting the oracle in
// lockstep. Aliased to `rotate` at the existing call sites.
const rotate = rotateVector;

const YAW_90 = { x: 0, y: Math.sqrt(0.5), z: 0, w: Math.sqrt(0.5) }; // +90° about Y, trig-free
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

// f32 readback tolerance at a given coordinate magnitude (see header).
const f32Tol = (magnitude) => 1e-6 * Math.max(1, Math.abs(magnitude));

const counts = (world) => [world.bodies.len(), world.colliders.len(), world.impulseJoints.len()];

describe('pure pose math (no Rapier)', () => {
  test('the canonical fixture is repair-stable: its genes ARE the phenotype', () => {
    const g = canonicalS0Genotype();
    expect(repairGenotype(g)).toEqual(g);
  });

  test('WHEEL_COLLIDER_ROTATION maps cylinder-local +Y onto vehicle-local +Z, exactly and unit-norm', () => {
    const q = WHEEL_COLLIDER_ROTATION;
    expect(Math.abs(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w - 1)).toBeLessThan(1e-12);
    const mapped = rotate(q, { x: 0, y: 1, z: 0 });
    expect(Math.abs(mapped.x)).toBeLessThan(1e-12);
    expect(Math.abs(mapped.y)).toBeLessThan(1e-12);
    expect(Math.abs(mapped.z - 1)).toBeLessThan(1e-12);
  });

  test('identity spawn: wheel centers are exactly {posX, mountY, z} + position', () => {
    const ir = canonicalIR();
    const position = { x: 3, y: 1.5, z: -2 };
    const t = s0WheelTransforms(ir, { position, rotation: IDENTITY });
    expect(t).toHaveLength(4);
    for (const p of t) {
      const axle = ir.axles[p.axleIndex];
      const wheel = axle.wheels[p.wheelIndex];
      expect(p.local).toEqual({ x: axle.posX, y: axle.mountY, z: wheel.z });
      // identity rotation is EXACT in the quat expansion (all cross terms 0)
      expect(p.world).toEqual({ x: position.x + p.local.x, y: position.y + p.local.y, z: position.z + p.local.z });
    }
  });

  test('yaw-90 spawn rotates every wheel center: (x, y, z) -> (z, y, -x) about the spawn point', () => {
    const ir = canonicalIR();
    const position = { x: 1, y: 2, z: 3 };
    const t = s0WheelTransforms(ir, { position, rotation: YAW_90 });
    for (const p of t) {
      expect(Math.abs(p.world.x - (position.x + p.local.z))).toBeLessThan(1e-12);
      expect(Math.abs(p.world.y - (position.y + p.local.y))).toBeLessThan(1e-12);
      expect(Math.abs(p.world.z - (position.z - p.local.x))).toBeLessThan(1e-12);
    }
  });

  test('chassis and wheel local +Z describe the same world hinge axis (shared base rotation)', () => {
    // The contract: wheel body base rotation = chassis spawn rotation, so
    // REVOLUTE_AXIS means the same world direction in both local frames.
    // At yaw-90 that world direction is +X.
    const chassisAxis = rotate(YAW_90, REVOLUTE_AXIS);
    const wheelAxis = rotate(YAW_90, REVOLUTE_AXIS); // same base rotation by construction
    expect(chassisAxis).toEqual(wheelAxis);
    expect(Math.abs(chassisAxis.x - 1)).toBeLessThan(1e-12);
    expect(Math.abs(chassisAxis.y)).toBeLessThan(1e-12);
    expect(Math.abs(chassisAxis.z)).toBeLessThan(1e-12);
  });

  test('repeated transforms are identical and never mutate the IR', () => {
    const ir = canonicalIR();
    const frozen = JSON.parse(JSON.stringify(ir));
    const spawn = { position: { x: -45, y: 0.52, z: 0 }, rotation: YAW_90 };
    const a = s0WheelTransforms(ir, spawn);
    const b = s0WheelTransforms(ir, spawn);
    expect(a).toEqual(b);
    expect(ir).toEqual(frozen);
  });
});

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('S0 realization contract (deterministic=%s, %s)', (deterministic) => {
  test('counts, per-wheel readbacks, chassis policy, joints, anchors — the full creation-time contract', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const ir = canonicalIR();
      const spawn = { position: { x: 2, y: 5, z: -1 }, rotation: IDENTITY, linvel: { x: 3, y: 0, z: 0 } };
      const before = counts(world);
      const rec = realizeS0Vehicle(RAPIER, world, ir, spawn);

      // Exact counts: 1 chassis + 4 wheels; chassis colliders + 1 cylinder
      // per wheel; 1 revolute per wheel.
      expect(counts(world)).toEqual([
        before[0] + 1 + 4,
        before[1] + ir.chassis.colliders.length + 4,
        before[2] + 4,
      ]);
      expect(rec.wheels).toHaveLength(4);

      // Chassis carries the full realizeChassis policy; wheels must NOT
      // independently receive the solver-iteration budget.
      expect(rec.chassis.body.additionalSolverIterations()).toBe(ADDITIONAL_SOLVER_ITERATIONS);
      expect(rec.chassis.body.isCcdEnabled()).toBe(true);
      expect(rec.chassis.body.softCcdPrediction()).toBe(SOFT_CCD_PREDICTION);
      for (const c of rec.chassis.colliders) expect(c.collisionGroups()).toBe(CHASSIS_GROUPS);

      const expected = s0WheelTransforms(ir, spawn);
      rec.wheels.forEach((wrec, k) => {
        const { body, collider, joint, irWheel, axleIndex, wheelIndex } = wrec;
        expect(irWheel).toBe(ir.axles[axleIndex].wheels[wheelIndex]);
        // Cylinder geometry from the IR: halfHeight = width / 2.
        expect(collider.shapeType()).toBe(RAPIER.ShapeType.Cylinder);
        expect(Math.abs(collider.radius() - irWheel.radius)).toBeLessThan(1e-6);
        expect(Math.abs(collider.halfHeight() - irWheel.width / 2)).toBeLessThan(1e-6);
        expect(collider.collisionGroups()).toBe(WHEEL_GROUPS);
        expect(collider.friction()).toBe(WHEEL_FRICTION);
        // Dual CCD, no per-wheel solver iterations.
        expect(body.isCcdEnabled()).toBe(true);
        expect(body.softCcdPrediction()).toBe(SOFT_CCD_PREDICTION);
        expect(body.additionalSolverIterations()).toBe(0);
        // Mass realizes from density (f32 collider: 1e-3 relative band).
        expect(Math.abs(body.mass() - irWheel.mass)).toBeLessThan(1e-3 * Math.max(1, irWheel.mass));
        // Base rotation = chassis spawn rotation; center = the pure transform.
        const rot = body.rotation();
        for (const a of ['x', 'y', 'z', 'w']) expect(Math.abs(rot[a] - spawn.rotation[a])).toBeLessThan(1e-6);
        const p = body.translation();
        expect(Math.abs(p.x - expected[k].world.x)).toBeLessThan(1e-6);
        expect(Math.abs(p.y - expected[k].world.y)).toBeLessThan(1e-6);
        expect(Math.abs(p.z - expected[k].world.z)).toBeLessThan(1e-6);
        // Spawn linvel reaches EVERY wheel (a moving chassis with resting
        // wheels is step-0 joint violence).
        const v = body.linvel();
        expect(Math.abs(v.x - spawn.linvel.x)).toBeLessThan(1e-6);
        expect(Math.abs(v.y)).toBeLessThan(1e-6);
        expect(Math.abs(v.z)).toBeLessThan(1e-6);
        // The joint: revolute, chassis-local anchor at the wheel center,
        // wheel-local anchor at the origin, world anchors coincident.
        expect(joint.type()).toBe(RAPIER.JointType.Revolute);
        expect(joint.body1().handle).toBe(rec.chassis.body.handle);
        expect(joint.body2().handle).toBe(body.handle);
        const a1 = joint.anchor1();
        expect(Math.abs(a1.x - expected[k].local.x)).toBeLessThan(1e-6);
        expect(Math.abs(a1.y - expected[k].local.y)).toBeLessThan(1e-6);
        expect(Math.abs(a1.z - expected[k].local.z)).toBeLessThan(1e-6);
        const a2 = joint.anchor2();
        expect(Math.abs(a2.x) + Math.abs(a2.y) + Math.abs(a2.z)).toBeLessThan(1e-6);
        const cp = rec.chassis.body.translation();
        const cr = rec.chassis.body.rotation();
        const world1 = rotate(cr, a1);
        const err = Math.sqrt(
          (cp.x + world1.x - p.x) ** 2 + (cp.y + world1.y - p.y) ** 2 + (cp.z + world1.z - p.z) ** 2
        );
        expect(err).toBeLessThan(1e-6); // measured ~4e-8 (f32 scale)
      });
      const cv = rec.chassis.body.linvel();
      expect(Math.abs(cv.x - spawn.linvel.x)).toBeLessThan(1e-6);
    } finally {
      world.free();
    }
  });

  test('the motor-model policy resolves symbolically per flavor', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      expect(typeof RAPIER.MotorModel[S0_MOTOR_MODEL_NAME]).toBe('number');
      expect(RAPIER.MotorModel[S0_MOTOR_MODEL_NAME]).toBe(RAPIER.MotorModel.ForceBased);
      expect(Number.isFinite(MOTOR_TARGET_WHEEL_SURFACE_SPEED)).toBe(true);
      // POSITIVE surface speed drives +X — the minus sign lives in the
      // per-wheel derivation ω_i = −speed/radius_i (s0-motor sign lock).
      expect(MOTOR_TARGET_WHEEL_SURFACE_SPEED).toBeGreaterThan(0);
    } finally {
      world.free();
    }
  });

  test('non-identity yaw spawn: the whole contract holds at yaw-90', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const ir = canonicalIR();
      const spawn = { position: { x: -45, y: 0.52, z: 0 }, rotation: YAW_90 };
      const rec = realizeS0Vehicle(RAPIER, world, ir, spawn);
      const expected = s0WheelTransforms(ir, spawn);
      rec.wheels.forEach((wrec, k) => {
        const p = wrec.body.translation();
        expect(Math.abs(p.x - expected[k].world.x)).toBeLessThan(f32Tol(expected[k].world.x));
        expect(Math.abs(p.y - expected[k].world.y)).toBeLessThan(f32Tol(expected[k].world.y));
        expect(Math.abs(p.z - expected[k].world.z)).toBeLessThan(f32Tol(expected[k].world.z));
        const rot = wrec.body.rotation();
        for (const a of ['x', 'y', 'z', 'w']) expect(Math.abs(rot[a] - YAW_90[a])).toBeLessThan(1e-6);
        // World anchors coincide at the rotated spawn too (the error is a
        // difference of nearby f32 values, so it scales with |position|).
        const cp = rec.chassis.body.translation();
        const world1 = rotate(rec.chassis.body.rotation(), wrec.joint.anchor1());
        const err = Math.sqrt(
          (cp.x + world1.x - p.x) ** 2 + (cp.y + world1.y - p.y) ** 2 + (cp.z + world1.z - p.z) ** 2
        );
        expect(err).toBeLessThan(f32Tol(spawn.position.x));
      });
    } finally {
      world.free();
    }
  });

  test('suspension gate: S1/S2 compile as legal IR data but are rejected at realization, pre-world', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      // suspType gene 0.5 -> S1, 0.9 -> S2 (enumIdx over 3 types).
      for (const [gene, type] of [[0.5, 'S1'], [0.9, 'S2']]) {
        const g = canonicalS0Genotype({ axle: { suspType: gene } });
        // Repair never touches the suspension-type gene…
        expect(repairGenotype(g).axles[0].suspType).toBe(gene);
        // …and the compiler emits it as data (the corpus-lock requirement).
        const ir = compileAssembly(g);
        expect(ir.axles.every((a) => a.suspension.type === type)).toBe(true);
        expect(SUSPENSION_TYPES).toContain(type);
        const before = counts(world);
        expect(() => realizeS0Vehicle(RAPIER, world, ir, {})).toThrow(/S0 kernel realizes only S0/);
        expect(counts(world)).toEqual(before);
      }
      // Mixed S0 + S1 and S0 + S2 fail the same way (the gate is per-axle).
      for (const gene of [0.5, 0.9]) {
        const g = canonicalS0Genotype();
        g.axles[1].suspType = gene;
        const ir = compileAssembly(g);
        expect(ir.axles[0].suspension.type).toBe('S0');
        const before = counts(world);
        expect(() => realizeS0Vehicle(RAPIER, world, ir, {})).toThrow(/S0 kernel realizes only S0/);
        expect(counts(world)).toEqual(before);
      }
    } finally {
      world.free();
    }
  });

  test('malformed IR wheels and options fail loud BEFORE the world is touched', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const before = counts(world);
      const broken = (mutate) => {
        const ir = canonicalIR();
        mutate(ir);
        return ir;
      };
      // NaN radius on the FIRST wheel; negative width on a LATER wheel.
      expect(() => realizeS0Vehicle(RAPIER, world, broken((ir) => { ir.axles[0].wheels[0].radius = NaN; }), {}))
        .toThrow(/radius must be a finite number > 0/);
      expect(() => realizeS0Vehicle(RAPIER, world, broken((ir) => { ir.axles[1].wheels[1].width = -0.2; }), {}))
        .toThrow(/width must be a finite number > 0/);
      // Hand-edited IR whose mass no longer matches pi r^2 w rho.
      expect(() => realizeS0Vehicle(RAPIER, world, broken((ir) => { ir.axles[0].wheels[0].mass *= 1.5; }), {}))
        .toThrow(/disagrees with/);
      expect(() => realizeS0Vehicle(RAPIER, world, broken((ir) => { ir.axles[0].wheels[0].driven = 1; }), {}))
        .toThrow(/driven must be a boolean/);
      expect(() => realizeS0Vehicle(RAPIER, world, broken((ir) => { ir.axles[0].wheels[0].driveTorque = -1; }), {}))
        .toThrow(/driveTorque must be a finite number >= 0/);
      expect(() => realizeS0Vehicle(RAPIER, world, broken((ir) => { ir.axles[0].wheels[0].z = Infinity; }), {}))
        .toThrow(/z must be finite/);
      expect(() => realizeS0Vehicle(RAPIER, world, broken((ir) => { ir.axles[0].mountY = NaN; }), {}))
        .toThrow(/finite posX and mountY/);
      expect(() => realizeS0Vehicle(RAPIER, world, broken((ir) => { ir.axles[0].wheels = []; }), {}))
        .toThrow(/non-empty array/);
      const ir = canonicalIR();
      // Non-unit spawn quaternion: wheel centers would silently misplace.
      expect(() => realizeS0Vehicle(RAPIER, world, ir, { rotation: { x: 0, y: 0.5, z: 0, w: 1 } }))
        .toThrow(/unit quaternion/);
      expect(() => realizeS0Vehicle(RAPIER, world, ir, { linvel: { x: NaN, y: 0, z: 0 } }))
        .toThrow(/spawn pose/);
      expect(() => realizeS0Vehicle(RAPIER, world, ir, { targetWheelSurfaceSpeed: Infinity }))
        .toThrow(/targetWheelSurfaceSpeed must be finite/);
      expect(() => realizeS0Vehicle(RAPIER, world, ir, { wheelFriction: -0.1 }))
        .toThrow(/wheelFriction/);
      // Zero surface speed + driven wheels: the per-wheel derivation must
      // never divide (−0 === 0, so a negative zero is rejected identically).
      expect(() => realizeS0Vehicle(RAPIER, world, ir, { targetWheelSurfaceSpeed: 0 }))
        .toThrow(/nonzero no-load surface speed/);
      expect(() => realizeS0Vehicle(RAPIER, world, ir, { targetWheelSurfaceSpeed: -0 }))
        .toThrow(/nonzero no-load surface speed/);
      // Migration tombstone: the removed option name gets the rename
      // diagnosis, never a silent fall-through to the default speed.
      expect(() => realizeS0Vehicle(RAPIER, world, ir, { targetAngvel: -10 }))
        .toThrow(/targetAngvel was removed/);
      expect(counts(world)).toEqual(before); // zero side effects from any rejection
      // …but a fully undriven IR accepts speed 0 (nothing consumes it).
      const undrivenIR = compileAssembly(canonicalS0Genotype({ axle: { driven: 0 } }));
      const rec = realizeS0Vehicle(RAPIER, world, undrivenIR, { targetWheelSurfaceSpeed: 0 });
      expect(rec.wheels).toHaveLength(4);
    } finally {
      world.free();
    }
  });

  test('a Rapier build without the ruled motor model fails loud pre-world', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const doctored = { ...RAPIER, MotorModel: {} }; // simulate an API-drift bump
      const before = counts(world);
      expect(() => realizeS0Vehicle(doctored, world, canonicalIR(), {}))
        .toThrow(new RegExp(`MotorModel\\.${S0_MOTOR_MODEL_NAME} is missing`));
      expect(counts(world)).toEqual(before);
    } finally {
      world.free();
    }
  });

  test('transactional cleanup: induced mid-construction throws leave all three counts unchanged', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      // Test-local wrapped world: the get-trap returns target-bound methods
      // and throws BEFORE delegating on the Nth call of one method — a
      // post-delegation throw would create an object the realizer never got
      // a handle to, failing the count check for the wrong reason.
      const trapWorld = (method, failOn) => {
        let calls = 0;
        return new Proxy(world, {
          get(target, key) {
            const v = target[key];
            if (key === method) {
              return (...args) => {
                calls += 1;
                if (calls === failOn) throw new Error(`induced ${method} #${failOn}`);
                return v.apply(target, args);
              };
            }
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      };
      const ir = canonicalIR();
      const before = counts(world);
      // Chassis is the 1st createRigidBody. 2nd = first wheel (chassis-only
      // rollback); 3rd = second wheel (chassis + 1 wheel + 1 joint alive —
      // the full unwind path); 2nd createImpulseJoint (chassis + 2 wheels +
      // 1 joint alive).
      // createCollider on the first WHEEL collider (chassis colliders come
      // first, through realizeChassis) exercises the collider-failure branch:
      // chassis + 1 wheel body alive, no joints yet. The body is tracked in
      // createdBodies before its collider, so the rollback still unwinds it.
      const firstWheelCollider = ir.chassis.colliders.length + 1;
      for (const [method, failOn] of [
        ['createRigidBody', 2],
        ['createRigidBody', 3],
        ['createCollider', firstWheelCollider],
        ['createImpulseJoint', 2],
      ]) {
        expect(() => realizeS0Vehicle(RAPIER, trapWorld(method, failOn), ir, {}))
          .toThrow(new RegExp(`induced ${method} #${failOn}`));
        expect(counts(world)).toEqual(before);
      }
    } finally {
      world.free();
    }
  });

  test('motor domain: a denormal-tiny targetWheelSurfaceSpeed is rejected pre-world (non-finite per-wheel gain)', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      const ir = canonicalIR(); // paired driven wheels ⇒ motor plans are derived
      const before = counts(world);
      // A denormal speed keeps ω_i = −speed/radius finite-denormal while
      // 1/|ω_i| overflows, sending the gain to Infinity — a finite option
      // that passed the exact-zero guard but must fail loud BEFORE any
      // body/joint exists, never reach configureMotorVelocity. (The mirror
      // overflow — a huge speed over a small radius sends ω_i itself to
      // ±Infinity — is rejected by the ω check, which the validator runs
      // FIRST for the sharper message; the helper also poisons the gain to
      // NaN whenever ω is non-finite, so neither check can be skipped.)
      for (const tiny of [Number.MIN_VALUE, 1e-320]) {
        expect(() => realizeS0Vehicle(RAPIER, world, ir, { targetWheelSurfaceSpeed: tiny }))
          .toThrow(/gain .* is not finite|too small/);
        expect(counts(world)).toEqual(before); // rejected with the world untouched
      }
      expect(() => realizeS0Vehicle(RAPIER, world, ir, { targetWheelSurfaceSpeed: 1e308 }))
        .toThrow(/drive target ω .* is not finite/);
      expect(counts(world)).toEqual(before);
      // A small-but-safe speed keeps every plan finite (r ≈ 0.5 ⇒ |ω| ≈
      // 0.002, gain ≈ 62.5 / 0.002 = 31250) and realizes normally — no
      // arbitrary magnitude floor.
      const rec = realizeS0Vehicle(RAPIER, world, ir, { targetWheelSurfaceSpeed: -1e-3 });
      expect(rec.wheels.length).toBeGreaterThan(0);
    } finally {
      world.free();
    }
  });

  test('legal edge shapes: sled, undriven, centerline singles, asymmetric radii, three axles', async () => {
    const { RAPIER, world } = await createPhysics({ deterministic });
    try {
      // Zero-axle sled: chassis-only record (spec: legal, scores ~0 later).
      const sledG = canonicalS0Genotype();
      sledG.axles = [];
      const sled = realizeS0Vehicle(RAPIER, world, compileAssembly(sledG), {});
      expect(sled.wheels).toEqual([]);
      expect(sled.chassis.body.isCcdEnabled()).toBe(true);

      // Zero driven wheels: realizes free-rolling (the witness proves the
      // no-motor behavior dynamically — it does not move).
      const undriven = realizeS0Vehicle(
        RAPIER, world, compileAssembly(canonicalS0Genotype({ axle: { driven: 0 } })), {});
      expect(undriven.wheels).toHaveLength(4);

      // Single centerline modules: symmetry snaps centerOffset to 0, so the
      // lone wheel sits exactly on the centerline.
      const singles = realizeS0Vehicle(
        RAPIER, world, compileAssembly(canonicalS0Genotype({ axle: { paired: 0 } })), {});
      expect(singles.wheels).toHaveLength(2);
      for (const w of singles.wheels) expect(w.irWheel.z).toBe(0);

      // Asymmetric paired module: sizeBias expresses, the two wheels realize
      // with genuinely different radii.
      const asymG = canonicalS0Genotype({ axle: { asym: { driveBias: 0.5, sizeBias: 0.8, centerOffset: 0.5 } } });
      asymG.symmetric = 0.2;
      const asym = realizeS0Vehicle(RAPIER, world, compileAssembly(asymG), {});
      const [r0, r1] = asym.wheels.slice(0, 2).map((w) => w.collider.radius());
      expect(Math.abs(r0 - r1)).toBeGreaterThan(0.01);

      // Three axle modules -> six wheels, six joints.
      const threeG = canonicalS0Genotype();
      threeG.axles = [0.1, 0.55, 1.0].map((posX01) => ({ ...threeG.axles[0], posX01, radius: 0.4 }));
      const three = realizeS0Vehicle(RAPIER, world, compileAssembly(threeG), {});
      expect(three.wheels).toHaveLength(6);
      expect(new Set(three.wheels.map((w) => w.joint.handle)).size).toBe(6);
    } finally {
      world.free();
    }
  });
});
