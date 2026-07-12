// The per-wheel no-load wheel-surface-speed drive law — the PURE derivation
// contract (no world, no flavors, no seeds). driveMotorForWheel is the single
// source the realizer consumes (Rapier 0.19.3 exposes NO motor readback, so
// this pure seam is the only place the per-wheel numbers are assertable;
// the golden gate proves the wasm boundary). The law:
//     ω_i    = −targetWheelSurfaceSpeed / radius_i     (rad/s about local +Z)
//     gain_i = driveTorque_i × (1 / |ω_i|)             (the [V10] shape, per wheel)
// "Surface speed" is the wheel's no-load CIRCUMFERENTIAL speed — the
// rolling-without-slip reading; actual vehicle speed differs under slip,
// terrain, suspension motion, collisions, and solver behavior. What the law
// preserves exactly is the STALL-TORQUE budget and its per-wheel allocation
// (stall magnitude = driveTorque_i verbatim) — NOT mechanical power: at a
// common surface-speed target, smaller wheels run larger no-load ω, so equal
// stall torques imply different peak powers.
//
// MEASURED (2026-07-11, f64 — IEEE ops are platform-deterministic, so these
// reproduce bit-exactly everywhere): surface-speed recovery |ω·r + gs| is
// EXACTLY 0 over the whole declared radius × speed set; torque recovery
// |gain·|ω| − t|/t max 1.137e-16 (~1 ulp); the identity corner is bit-equal
// to the legacy derivation for every torque tried; sign symmetry is exact.

import { describe, test, expect } from 'vitest';
import { MOTOR_TARGET_WHEEL_SURFACE_SPEED, driveMotorForWheel } from '../src/sim/physics/adapter.js';

// Declared sets — literals, no PRNG. 0.49999999999999994 is the radius the
// gene decoder ACTUALLY emits for radius gene 0.6 (assembly.js affine:
// (0.7 − 0.2) = 0.49999999999999994 in f64), i.e. the fixture-A wheel; 0.5
// exactly is the pure-math identity corner the decoder cannot reach.
const RADII = [0.2, 0.25, 0.3, 0.42, 0.49999999999999994, 0.5, 0.6, 0.7];
const SPEEDS = [2.5, 5, 7.5, -5];
const TORQUE = 125;

describe('surface-speed law (pure)', () => {
  test('identity corner reproduces the legacy gain bits exactly (r = 0.5, speed 5)', () => {
    // −5/0.5 === −10 exactly (division by a power of two), so 1/|ω| is the
    // same f64 as the legacy shared-target reciprocal 1/|−10| and the
    // reciprocal-MULTIPLY gain shape reproduces the legacy bits for EVERY
    // torque. The
    // decoder-emitted r = 0.49999999999999994 gives ω = −10.000000000000002
    // (1 f64 ulp off) — that path is deliberately NOT asserted here; the
    // golden gate owns it (Gate-3 classification: all fixtures re-lock).
    const LEGACY_INV = 1 / Math.abs(-10); // the old shipped invTarget
    for (const t of [62.5, 100, 125, 31.25, 3, 0.7]) {
      const plan = driveMotorForWheel(5, { radius: 0.5, driveTorque: t });
      expect(plan.omega).toBe(-10);
      expect(Object.is(plan.gain, t * LEGACY_INV), `torque ${t}`).toBe(true);
    }
  });

  test('ω·r and gain·|ω| recover the inputs over the declared radius × speed set', () => {
    for (const r of RADII) {
      for (const gs of SPEEDS) {
        const { omega, gain } = driveMotorForWheel(gs, { radius: r, driveTorque: TORQUE });
        const diag = `r ${r} gs ${gs}`;
        // Measured exactly 0 over this set; banded at 1e-15 relative.
        expect(Math.abs(omega * r + gs) / Math.abs(gs), diag).toBeLessThanOrEqual(1e-15);
        // Measured max 1.137e-16; banded at 1e-15 relative.
        expect(Math.abs(gain * Math.abs(omega) - TORQUE) / TORQUE, diag).toBeLessThanOrEqual(1e-15);
        expect(gain, diag).toBeGreaterThan(0);
      }
    }
  });

  test('sign law: positive surface speed spins ω negative about +Z; negation is bit-symmetric', () => {
    for (const r of RADII) {
      const fwd = driveMotorForWheel(5, { radius: r, driveTorque: TORQUE });
      const rev = driveMotorForWheel(-5, { radius: r, driveTorque: TORQUE });
      expect(fwd.omega, `r ${r}`).toBeLessThan(0); // forward (+X) needs ω < 0
      expect(Object.is(rev.omega, -fwd.omega), `r ${r}`).toBe(true); // f64 negation is exact
      expect(Object.is(rev.gain, fwd.gain), `r ${r}`).toBe(true); // |ω| identical ⇒ same gain bits
    }
  });

  test('policy: MOTOR_TARGET_WHEEL_SURFACE_SPEED is 5 m/s — the legacy 10 rad/s × the canonical 0.5 m wheel', () => {
    expect(MOTOR_TARGET_WHEEL_SURFACE_SPEED).toBe(5);
    expect(MOTOR_TARGET_WHEEL_SURFACE_SPEED).toBeGreaterThan(0); // positive drives +X; the minus lives in the derivation
    const corner = driveMotorForWheel(MOTOR_TARGET_WHEEL_SURFACE_SPEED, { radius: 0.5, driveTorque: 1 });
    expect(Object.is(corner.omega, -10)).toBe(true);
  });

  test('out-of-domain inputs surface as non-finite fields — a non-finite ω POISONS the gain, so no gain-only consumer can miss it', () => {
    // Denormal speeds: ω stays finite-denormal, 1/|ω| overflows ⇒ gain Infinity.
    for (const gs of [Number.MIN_VALUE, 1e-320]) {
      const p = driveMotorForWheel(gs, { radius: 0.5, driveTorque: TORQUE });
      expect(Number.isFinite(p.omega), `gs ${gs} omega`).toBe(true);
      expect(p.gain, `gs ${gs}`).toBe(Infinity);
    }
    // Huge speed over a small radius: ω overflows to −Infinity. The raw math
    // would COLLAPSE the gain to a plausible finite 0 (t × 1/Infinity) — the
    // helper poisons it to NaN by contract so a consumer validating EITHER
    // field fails loud (the shipped validator still rejects ω first for the
    // sharper diagnostic).
    const huge = driveMotorForWheel(1e308, { radius: 0.2, driveTorque: TORQUE });
    expect(huge.omega).toBe(-Infinity);
    expect(Number.isNaN(huge.gain)).toBe(true);
    // Zero: ω is −0 (finite), gain Infinity — the validator's dedicated
    // zero-with-motors rule fires first (and −0 === 0 covers a −0 option).
    const zero = driveMotorForWheel(0, { radius: 0.5, driveTorque: TORQUE });
    expect(Object.is(zero.omega, -0)).toBe(true);
    expect(zero.gain).toBe(Infinity);
    // NaN propagates; never throws.
    const nan = driveMotorForWheel(NaN, { radius: 0.5, driveTorque: TORQUE });
    expect(Number.isNaN(nan.omega)).toBe(true);
    expect(Number.isNaN(nan.gain)).toBe(true);
  });
});
