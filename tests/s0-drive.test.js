// The S0 forward-drive witness (Phase 0 mechanism proof) — a repaired,
// all-S0 assembly IR realized through the native cylinder/revolute/motor
// path PROPELS a canonical vehicle toward world +X on declared flat terrain.
// Movement comes from joint motors only: nothing here (or in the adapter)
// touches setAngvel, impulses, forces, or poses after creation. BOTH flavors
// via describe.each × createPhysics; exactness only ever per-flavor (F10).
//
// WITNESS TERRAIN (declared; touches NO locked fingerprint — the five locks
// pin the DEFAULT config at seed 20260708 only): seed 20260713 with a raised
// 80 m start pad and the composite generators zeroed per knob —
//   { startFlatLength: 80, startBlendLength: 6, craterDensity: 0,
//     featureDensity: 0, sandCoverage: 0, mudCoverage: 0 }
// Default macro/micro amplitudes are deliberately KEPT: the pad spans
// x ∈ [−60, +20] at exactly-zero elevation (the flat-pad branch), the blend
// and real terrain lie beyond it, so the witness drives on the declared flat
// envelope of a REAL terrain, not on a globally disabled generator. Every
// measured run stays on the pad; the reversed twin spawns at x = 0 because
// the corridor's x-ends are OPEN — launched −X from x = −45 it would exit
// the west end and free-fall.
//
// CANONICAL VEHICLE: the repair-stable all-S0 fixture (two paired driven
// axles, spine frame; wheel r 0.5 m, driveTorque 62.5 N·m per wheel from the
// power-0.5 budget; total mass ≈ 596 kg).
//
// MEASURED (this worktree, Windows, 2026-07-10, both flavors identical at
// this seed; bands carry cross-platform margin — 600 steps unless noted):
//   driven   (x −45): dx +19.425, |dz| 0.179, vx_final 2.79, anchorErr 2.0e-3
//   undriven (x −45): dx −0.063 (sleeps at rest; the s0-motor solver-pump
//                     drift did not manifest on the heightfield pad)
//   reversed (x 0):   dx −19.186, anchorErr 3.4e-3
//   gain invariance through the shipped path (targetWheelSurfaceSpeed 2.5 vs
//     the default 5 — per-wheel ω ≈ −5 vs −10 at this fixture's r ≈ 0.5, the
//     same physics as the old shared −5/−10 targets, same driveTorque):
//     vx@15 0.1781 vs 0.1784 (0.2% apart) — the surface speed is the no-load
//     speed, NOT a torque rescale; dx@600 14.62 vs 19.43 (the cruise cap ωR
//     differs, exactly as the law says)
//   PER-WHEEL LAW NOTE (2026-07-11): the witness wheels decode to r =
//     0.49999999999999994, so the derived ω = −10.000000000000002 differs
//     from the old shared −10 by 1 f64 ulp — below f32 engine-state
//     resolution (Math.fround(−10.000000000000002) === −10), and the gains
//     are f32-equal too; every measured number above reproduced unchanged
//     under the per-wheel law (re-verified at this seed, both flavors).
//   power-doubled twin (driveTorque 125): vx@15 ratio 1.919 — the compiler's
//     budget shares translate into proportional thrust
//   residual-overlap witness (R5 cap case, axle spacing 0.195 m < r1+r2
//     1.0 m): realizes, 300 steps finite, max |v| 0.11, anchorErr 3.4e-3 —
//     overlapping wheels coexist (collision-inert self-pairs) and neither
//     explode nor detach; whether that is acceptable for EVOLUTION is the
//     open schema-ruling question from PR #10's review.
//   max anchor error over every dynamic case in this file: 7.2e-3 (band 0.02)

import { describe, test, expect } from 'vitest';
import {
  addCorridor,
  createPhysics,
  realizeS0Vehicle,
} from '../src/sim/physics/adapter.js';
import { generateCorridorTerrain } from '../src/sim/terrain.js';
import { compileAssembly, repairGenotype } from '../src/sim/assembly.js';
import { rotateVector } from './rotate-oracle.js';

const WITNESS_SEED = 20260713; // declared; distinct from every other repo seed
const WITNESS_CONFIG = Object.freeze({
  seed: WITNESS_SEED,
  startFlatLength: 80,
  startBlendLength: 6,
  craterDensity: 0,
  featureDensity: 0,
  sandCoverage: 0,
  mudCoverage: 0,
});
const STEPS = 600;
const SPAWN_X = -45; // on the pad, ~15 m past the corridor's west end margin
const REVERSED_SPAWN_X = 0; // see header: −X runs must not exit the open west end
const ANCHOR_BAND = 0.02; // m — measured max 7.2e-3 across every case
const TUNNEL_Y = -50;
// The exactly-flat pad: terrain length 120 is centered, so x ∈ [−60, +60];
// startFlatLength 80 from the west edge is flat to x = +20, then the 6 m blend.
// The witness must stay strictly inside the flat span (the whole vehicle, not
// just the chassis center — hence the margin) or its flat-terrain claim is void.
const PAD_MIN_X = -60;
const PAD_MAX_X = 20;
const PAD_MARGIN = 1.5; // ≥ the canonical vehicle's longitudinal reach
// measured trajectory extremes across all runs: maxX ≈ 0 (reversed spawn),
// minX ≈ −45 (driven/undriven spawn) — far inside; the bound is a regression net.

const terrain = generateCorridorTerrain(WITNESS_CONFIG);

// The canonical all-S0 genotype (shared shape with tests/s0-kernel.test.js;
// repair-stability of the default is asserted below — the witness distances
// only mean "these declared genes drove this far" if repair is a no-op).
function canonicalS0Genotype({ driven = 1, power = 0.5 } = {}) {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue: 0.25, symmetric: 0.9, power, frameDensity: 0.3,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, node),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [axle(0.2), axle(0.8)],
  };
}

// Independent quaternion sandwich oracle (see tests/rotate-oracle.js) — a
// different formula from the adapter's expansion, so the anchor-error check
// below is a genuine cross-check, not a copy of the code under test.
const rotate = rotateVector;

// Realize `ir` close to the pad surface (placed, not dropped) and run a fixed
// step count while tracking anchor error, wheel lows, and peak speed.
async function witnessRun(deterministic, ir, { x, steps = STEPS, targetWheelSurfaceSpeed } = {}) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    const { floor } = addCorridor(RAPIER, world, terrain);
    world.step(); // query BVH ([V1])
    const maxR = Math.max(...ir.axles.flatMap((a) => a.wheels).map((w) => w.radius));
    const opts = { position: { x, y: maxR + 0.02, z: 0 } };
    if (targetWheelSurfaceSpeed !== undefined) opts.targetWheelSurfaceSpeed = targetWheelSurfaceSpeed;
    const rec = realizeS0Vehicle(RAPIER, world, ir, opts);
    const x0 = rec.chassis.body.translation().x;

    let maxAnchorErr = 0;
    let minBodyY = Infinity;
    let maxSpeed = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    const samples = {};
    for (let i = 1; i <= steps; i++) {
      world.step();
      // Chassis X every step — the witness claims driving happens on the
      // exactly-flat pad, so the trajectory (not just the endpoint) must stay
      // inside it; a later speed bump could otherwise carry the vehicle onto
      // the blend/real terrain while the test still claimed a flat witness.
      const cx = rec.chassis.body.translation().x;
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      if (i % 10 === 0) {
        const cp = rec.chassis.body.translation();
        const cr = rec.chassis.body.rotation();
        for (const w of rec.wheels) {
          const a = rotate(cr, w.joint.anchor1());
          const wp = w.body.translation();
          maxAnchorErr = Math.max(
            maxAnchorErr,
            Math.sqrt((cp.x + a.x - wp.x) ** 2 + (cp.y + a.y - wp.y) ** 2 + (cp.z + a.z - wp.z) ** 2)
          );
          minBodyY = Math.min(minBodyY, wp.y);
        }
        minBodyY = Math.min(minBodyY, cp.y);
        const v = rec.chassis.body.linvel();
        maxSpeed = Math.max(maxSpeed, Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z));
      }
      if (i === 15) samples.vx15 = rec.chassis.body.linvel().x;
    }
    const p = rec.chassis.body.translation();
    // Floor-only ray under the final pose (the assembly-physics idiom) — on
    // the pad this is exactly 0, but the ray proves it against the collider.
    const ray = new RAPIER.Ray({ x: p.x, y: 60, z: p.z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 200, true, undefined, undefined, undefined, undefined, (c) => c.handle === floor.handle);
    const floorY = hit === null ? null : 60 - hit.timeOfImpact;
    return {
      seed: WITNESS_SEED,
      finite: [p.x, p.y, p.z].every(Number.isFinite),
      dx: p.x - x0,
      z: p.z,
      y: p.y,
      floorY,
      maxAnchorErr,
      minBodyY,
      maxSpeed,
      minX,
      maxX,
      samples,
      wheels: rec.wheels.map((w) => ({ y: w.body.translation().y, radius: w.irWheel.radius })),
    };
  } finally {
    world.free();
  }
}

// Repair-stability of the witness fixture (pure, flavor-independent — outside
// describe.each). The witness distances only mean "these declared genes drove
// this far" if repair is a no-op on them.
test('the witness fixture is repair-stable: its genes ARE the phenotype', () => {
  const g = canonicalS0Genotype();
  expect(repairGenotype(g)).toEqual(g);
});

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('S0 forward-drive witness (deterministic=%s, %s)', (deterministic) => {
  test('driven beats undriven toward +X; reversed target drives −X; everything stays sane', { timeout: 60000 }, async () => {
    const drivenIR = compileAssembly(canonicalS0Genotype());
    const undrivenIR = compileAssembly(canonicalS0Genotype({ driven: 0 }));
    const driven = await witnessRun(deterministic, drivenIR, { x: SPAWN_X });
    const undriven = await witnessRun(deterministic, undrivenIR, { x: SPAWN_X });
    // The equal-radius sign tooth: a NEGATIVE surface speed derives positive
    // per-wheel ω (≈ +10 at r ≈ 0.5) and drives −X.
    const reversed = await witnessRun(deterministic, drivenIR, { x: REVERSED_SPAWN_X, targetWheelSurfaceSpeed: -5 });
    const diag = JSON.stringify({ driven, undriven, reversed });

    for (const run of [driven, undriven, reversed]) {
      expect(run.finite, diag).toBe(true);
      expect(run.floorY, diag).not.toBeNull();
      expect(run.minBodyY, diag).toBeGreaterThan(TUNNEL_Y);
      expect(run.maxAnchorErr, diag).toBeLessThan(ANCHOR_BAND);
      expect(run.maxSpeed, diag).toBeLessThan(10); // cruise measured ≤ 2.8
      // No burial: the chassis rides at wheel-radius height (measured 0.499
      // against pad floorY 0); each wheel center stays above 0.6 × its radius.
      expect(run.y, diag).toBeGreaterThan(run.floorY + 0.35);
      for (const w of run.wheels) expect(w.y, diag).toBeGreaterThan(run.floorY + 0.6 * w.radius);
      expect(Math.abs(run.z), diag).toBeLessThan(1); // symmetric vehicle: measured ≤ 0.18
      // Stayed on the exactly-flat pad the whole run (the witness's premise —
      // not merely at the endpoint): a slope excursion would void the claim.
      expect(run.maxX, diag).toBeLessThan(PAD_MAX_X - PAD_MARGIN);
      expect(run.minX, diag).toBeGreaterThan(PAD_MIN_X + PAD_MARGIN);
    }
    expect(driven.dx, diag).toBeGreaterThan(10); // measured +19.43
    expect(Math.abs(undriven.dx), diag).toBeLessThan(1); // measured −0.063
    expect(driven.dx - undriven.dx, diag).toBeGreaterThan(10); // the witness margin
    expect(reversed.dx, diag).toBeLessThan(-5); // measured −19.19
  });

  test('gain semantics through the shipped path: surface speed is no-load speed, budget shares are thrust', { timeout: 60000 }, async () => {
    const ir = compileAssembly(canonicalS0Genotype());
    const t10 = await witnessRun(deterministic, ir, { x: SPAWN_X }); // default 5 m/s ⇒ ω ≈ −10 at r ≈ 0.5
    const t5 = await witnessRun(deterministic, ir, { x: SPAWN_X, targetWheelSurfaceSpeed: 2.5 }); // ω ≈ −5
    const diag = JSON.stringify({ t10: t10.samples, t5: t5.samples, dx10: t10.dx, dx5: t5.dx });
    // Same driveTorque, different no-load speed: initial thrust is invariant
    // (measured 0.1784 vs 0.1781 — 0.2% apart; band 5%)…
    expect(Math.abs(t5.samples.vx15 / t10.samples.vx15 - 1), diag).toBeLessThan(0.05);
    // …but the cruise cap ωR halves, so the slower target covers less ground
    // (measured 14.62 vs 19.43) — the target rescales SPEED, never torque.
    expect(t5.dx, diag).toBeGreaterThan(5);
    expect(t5.dx, diag).toBeLessThan(t10.dx);

    // Doubling the power gene doubles each wheel's driveTorque (62.5 → 125)
    // and early thrust follows (measured vx@15 ratio 1.919; band [1.7, 2.05]).
    const doubled = await witnessRun(deterministic, compileAssembly(canonicalS0Genotype({ power: 1 })), { x: SPAWN_X });
    const ratio = doubled.samples.vx15 / t10.samples.vx15;
    expect(ratio, diag).toBeGreaterThan(1.7);
    expect(ratio, diag).toBeLessThan(2.05);
  });

  test('residual-overlap witness: the R5 cap-and-accept case realizes and stays bounded', { timeout: 60000 }, async () => {
    // The assembly.test.js R5-cap recipe, all-S0: two axles that cannot fit
    // pile at gene 1 exactly, leaving overlapping wheels (accepted residual —
    // collision-inert because vehicle self-pairs filter GROUND only).
    const g = canonicalS0Genotype();
    g.axles[0].posX01 = 0.9;
    g.axles[1].posX01 = 0.95;
    const repaired = repairGenotype(g);
    expect(repaired.axles[0].posX01).toBe(0.9);
    expect(repaired.axles[1].posX01).toBe(1);
    const ir = compileAssembly(g);
    // Prove the residual overlap is REAL in the emitted vehicle: adjacent
    // axle spacing (0.195 m) is far below the wheels' combined radii (1.0 m).
    const spacing = ir.axles[1].posX - ir.axles[0].posX;
    const sumR = ir.axles[0].wheels[0].radius + ir.axles[1].wheels[0].radius;
    expect(spacing).toBeLessThan(sumR);

    const run = await witnessRun(deterministic, ir, { x: SPAWN_X, steps: 300 });
    const diag = JSON.stringify(run);
    expect(run.finite, diag).toBe(true);
    expect(run.maxAnchorErr, diag).toBeLessThan(ANCHOR_BAND); // no joint detach (measured 3.4e-3)
    expect(run.maxSpeed, diag).toBeLessThan(5); // no explosion (measured 0.11)
    // Guard the floor ray before the tunneling band (the sibling test's idiom):
    // without this, a null floorY coerces `null - 0.5` to -0.5 and the assert
    // silently degrades to `minBodyY > -0.5` instead of failing loud.
    expect(run.floorY, diag).not.toBeNull();
    expect(run.minBodyY, diag).toBeGreaterThan(run.floorY - 0.5); // nothing tunnels
  });
});
