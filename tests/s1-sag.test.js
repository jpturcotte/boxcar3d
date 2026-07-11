// Static vehicle sag — the S1 spring's relational teeth at the VEHICLE level
// (declared symmetric fixtures on a flat cuboid floor, both flavors).
//
// Relational claims (the [V12] discipline: relations and measured bands,
// never exact solver curves):
//   * heavier chassis ⇒ more S1 compression at fixed stiffness;
//   * greater stiffness ⇒ less compression at fixed mass;
//   * damping leaves the static equilibrium materially unchanged ON A
//     HEAVY-UNSPRUNG FIXTURE, while materially changing the transient
//     (deeper drop overshoot at low damping);
//   * limits bound every observed coordinate;
//   * a weak spring under a heavy chassis bottoms out FINITELY (a legal poor
//     phenotype — never repaired);
//   * a preloaded suspension sits against its extension stop as a valid
//     static state;
//   * the S0 twin shows zero prismatic-equivalent displacement while the S1
//     twin visibly sags;
//   * a hand-edited k=0 ∧ c=0 IR realizes as an honest FREE SLIDER (the
//     realizer's skip-motor rule): the chassis load runs the coordinate to
//     the compression stop instead of freezing at spawn (the engine's
//     0/0-motor lock, measured in tests/s1-prismatic.test.js).
//
// MEASURED ENGINE CAVEAT (probe:s1, first measured 2026-07-11): through the
// full chain the static sag inflates with damping × sprung:unsprung mass
// ratio (solver convergence starvation — γ ≈ 0.33·c·dt/m_unsprung; exact at
// c = 0 or heavy wheels; the chassis ADDITIONAL_SOLVER_ITERATIONS policy is
// load-bearing). The damping-equilibrium tooth therefore runs on the
// heavy-wheel fixture (γ ≤ ~0.02 across its damping span); the light-wheel
// coupling is RECORDED engine behavior, not asserted away.
//
// Fixture family: the canonical spine (346 kg chassis at gene 0.3), wheels
// r 0.5 / w 0.3, restLength gene 0.2 → 0.14 m (IN-band — a real spring, not
// the canonical preload), travel 0.2 m, k(0.5) = 26000 N/m, c(0.5) = 2500.

import { describe, test, expect } from 'vitest';
import {
  GROUND_GROUPS,
  SUSPENSION_AXIS,
  createPhysics,
  projectedPrismaticCoordinate,
  realizeVehicle,
  suspensionAnchorLocal,
} from '../src/sim/physics/adapter.js';
import { compileAssembly, repairGenotype } from '../src/sim/assembly.js';

const ORIGIN = { x: 0, y: 0, z: 0 };
const poseOf = (body) => ({ position: body.translation(), rotation: body.rotation() });

// UNDRIVEN by design (driven gene 0): these are STATIC rigs — a driven
// fixture would cruise at ωR during "settling" and measure rolling, not
// sag. (An awake undriven jointed vehicle on a cuboid floor is also the
// S0 solver-pump finding's rig — its residual creep is recorded in
// s1-drive's findings ledger, and the coordinate equilibrium here is
// insensitive to it.)
function sagGenotype(patch = null) {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0.5, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.2,
    driven: 0, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  const g = {
    version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3,
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
  if (patch) patch(g);
  return g;
}

test('every sag fixture is repair-stable: the genes ARE the phenotype', () => {
  for (const patch of [
    null,
    (g) => { g.frameDensity = 0.15; },
    (g) => { g.frameDensity = 0.42; },
    (g) => { for (const a of g.axles) a.stiffness = 0.4; },
    (g) => { for (const a of g.axles) a.stiffness = 0.9; },
    (g) => { for (const a of g.axles) { a.density = 0.2; a.damping = 0.05; } },
    (g) => { for (const a of g.axles) { a.density = 0.2; a.damping = 0.5; } },
    (g) => { g.frameDensity = 0.42; for (const a of g.axles) a.stiffness = 0; },
    (g) => { for (const a of g.axles) { a.restLength = 1; a.stiffness = 0.9; } },
  ]) {
    const g = sagGenotype(patch);
    expect(repairGenotype(g)).toEqual(g);
  }
});

// Realize `ir` on a flat cuboid floor (top at y = 0), settle, and track the
// per-station projected coordinate (the ONLY coordinate source — no native
// getter exists) plus its min/max over the whole run.
async function settleRun(deterministic, ir, { steps = 600, dropExtra = 0, mutateIR = null } = {}) {
  const { RAPIER, world } = await createPhysics({ deterministic });
  try {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(200, 1, 25).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUND_GROUPS)
    );
    world.step(); // query BVH
    if (mutateIR) mutateIR(ir);
    const maxR = Math.max(...ir.axles.flatMap((a) => a.wheels).map((w) => w.radius));
    const isS1 = (a) => a.suspension.type === 'S1';
    const coord0 = ir.axles.some(isS1)
      ? Math.max(0, Math.min(ir.axles[0].suspension.restLength, ir.axles[0].suspension.travel))
      : 0;
    const spawnY = maxR + coord0 + 0.02 + dropExtra;
    const rec = realizeVehicle(RAPIER, world, ir, { position: { x: 0, y: spawnY, z: 0 } });
    const stations = rec.wheels.map((st) => ({
      st,
      anchor: suspensionAnchorLocal(ir.axles[st.axleIndex], st.irWheel),
      // For S0 stations the same projection measured chassis→WHEEL reads the
      // (rigid) joint compliance — the zero-displacement oracle.
      otherBody: st.hub ? st.hub.body : st.wheel.body,
    }));
    let minQ = Infinity;
    let maxQ = -Infinity;
    for (let i = 0; i < steps; i++) {
      world.step();
      for (const s of stations) {
        const q = projectedPrismaticCoordinate(poseOf(rec.chassis.body), poseOf(s.otherBody), s.anchor, ORIGIN, SUSPENSION_AXIS);
        if (q < minQ) minQ = q;
        if (q > maxQ) maxQ = q;
      }
    }
    const coords = stations.map((s) =>
      projectedPrismaticCoordinate(poseOf(rec.chassis.body), poseOf(s.otherBody), s.anchor, ORIGIN, SUSPENSION_AXIS)
    );
    const p = rec.chassis.body.translation();
    const hv = stations[0].otherBody.linvel();
    return {
      coords,
      meanQ: coords.reduce((s, q) => s + q, 0) / coords.length,
      minQ,
      maxQ,
      chassisY: p.y,
      spawnY,
      hubSpeed: Math.sqrt(hv.x * hv.x + hv.y * hv.y + hv.z * hv.z),
      finite: [p.x, p.y, p.z].every(Number.isFinite) && coords.every(Number.isFinite),
    };
  } finally {
    world.free();
  }
}

describe.each([
  [false, 'default flavor'],
  [true, 'deterministic flavor'],
])('S1 static sag (deterministic=%s, %s)', (deterministic) => {
  test('heavier chassis ⇒ more compression; stiffer spring ⇒ less; every coordinate stays inside the limits', { timeout: 60000 }, async () => {
    const base = await settleRun(deterministic, compileAssembly(sagGenotype()));
    const light = await settleRun(deterministic, compileAssembly(sagGenotype((g) => { g.frameDensity = 0.15; })));
    const heavy = await settleRun(deterministic, compileAssembly(sagGenotype((g) => { g.frameDensity = 0.42; })));
    const soft = await settleRun(deterministic, compileAssembly(sagGenotype((g) => { for (const a of g.axles) a.stiffness = 0.4; })));
    const stiff = await settleRun(deterministic, compileAssembly(sagGenotype((g) => { for (const a of g.axles) a.stiffness = 0.9; })));
    const diag = JSON.stringify({ base: base.meanQ, light: light.meanQ, heavy: heavy.meanQ, soft: soft.meanQ, stiff: stiff.meanQ });
    for (const run of [base, light, heavy, soft, stiff]) {
      expect(run.finite, diag).toBe(true);
      // Limits are real: nothing ever leaves [0 − leak, travel + leak]
      // (stop compliance measured ≈ 9e-6 m/N — band 0.05 covers the heavy
      // fixture's ~2.4 kN corners with margin).
      expect(run.minQ, diag).toBeGreaterThan(-0.05);
      expect(run.maxQ, diag).toBeLessThan(0.2 + 0.02);
    }
    // Mass ordering (measured meanQ: light 0.0966, base 0.0724, heavy 0.0362).
    expect(light.meanQ, diag).toBeGreaterThan(base.meanQ + 0.01);
    expect(base.meanQ, diag).toBeGreaterThan(heavy.meanQ + 0.01);
    // Stiffness ordering at fixed mass (measured: soft 0.0410, stiff 0.1023).
    expect(stiff.meanQ, diag).toBeGreaterThan(soft.meanQ + 0.01);
  });

  test('damping: static equilibrium materially unchanged (heavy-unsprung fixture), transient overshoot materially deeper at low damping', { timeout: 60000 }, async () => {
    // Heavy wheels (density gene 0.2 → 75.4 kg/wheel; unsprung 94 kg with
    // the hub) push the measured convergence artifact γ under ~0.02 across
    // this damping span, so the equilibrium comparison is honest.
    const lowC = (g) => { for (const a of g.axles) { a.density = 0.2; a.damping = 0.05; } };
    const highC = (g) => { for (const a of g.axles) { a.density = 0.2; a.damping = 0.5; } };
    const settledLow = await settleRun(deterministic, compileAssembly(sagGenotype(lowC)), { steps: 900 });
    const settledHigh = await settleRun(deterministic, compileAssembly(sagGenotype(highC)), { steps: 900 });
    const diag1 = JSON.stringify({ low: settledLow.meanQ, high: settledHigh.meanQ });
    expect(Math.abs(settledLow.meanQ - settledHigh.meanQ), diag1).toBeLessThan(0.02); // measured Δ ~0.006
    // Drop transient: released 0.3 m above the quiescent height, the lightly
    // damped twin overshoots DEEPER into compression.
    const dropLow = await settleRun(deterministic, compileAssembly(sagGenotype(lowC)), { steps: 900, dropExtra: 0.3 });
    const dropHigh = await settleRun(deterministic, compileAssembly(sagGenotype(highC)), { steps: 900, dropExtra: 0.3 });
    const diag2 = JSON.stringify({ lowMinQ: dropLow.minQ, highMinQ: dropHigh.minQ, lowEq: dropLow.meanQ, highEq: dropHigh.meanQ });
    expect(dropLow.minQ, diag2).toBeLessThan(dropHigh.minQ - 0.005);
    // …and both still land on (materially) the same equilibrium.
    expect(Math.abs(dropLow.meanQ - dropHigh.meanQ), diag2).toBeLessThan(0.02);
  });

  test('a weak spring under a heavy chassis bottoms out FINITELY — a legal poor phenotype, not a defect', { timeout: 60000 }, async () => {
    const run = await settleRun(
      deterministic,
      compileAssembly(sagGenotype((g) => { g.frameDensity = 0.42; for (const a of g.axles) a.stiffness = 0; }))
    );
    const diag = JSON.stringify(run);
    expect(run.finite, diag).toBe(true);
    // Bottomed: sitting on (or leaking slightly through) the compression stop.
    expect(run.meanQ, diag).toBeLessThan(0.03);
    expect(run.meanQ, diag).toBeGreaterThan(-0.05);
    // The R2 clearance guarantee holds at full compression: the chassis
    // still rides above the floor (belly = chassisY − maxHalfHeight ≥ ~0.1).
    expect(run.chassisY, diag).toBeGreaterThan(0.3);
  });

  test('preload rides pinned against the extension stop as a STATIC state', { timeout: 60000 }, async () => {
    // restLength gene 1 → 0.5 m target, travel 0.2 m, k gene 0.9 → 45200 N/m:
    // the spring presses ~13.6 kN into the droop stop — far beyond the
    // ~1.7 kN corner load, so the coordinate stays at the stop.
    const run = await settleRun(
      deterministic,
      compileAssembly(sagGenotype((g) => { for (const a of g.axles) { a.restLength = 1; a.stiffness = 0.9; } }))
    );
    const diag = JSON.stringify(run);
    expect(run.finite, diag).toBe(true);
    // Pinned THROUGH the run, not just at the end (measured meanQ 0.2014,
    // excursion band [0.193, 0.209] — stop jitter under the 13.6 kN press).
    expect(Math.abs(run.meanQ - 0.2), diag).toBeLessThan(0.01);
    expect(run.minQ, diag).toBeGreaterThan(0.18);
    expect(run.maxQ, diag).toBeLessThan(0.215);
    // The chassis rides at wheel radius + full extension, stably.
    expect(Math.abs(run.chassisY - 0.7), diag).toBeLessThan(0.03); // measured 0.7027
    // RECORDED, not remediated: the hard-pressed stop never quiets — the
    // undriven vehicle carries a residual solver creep (measured hub speed
    // 0.565 m/s; the S0 solver-pump finding's class, amplified by the
    // preload press). The pose and coordinate above prove the STATE is
    // static; the residual velocity is engine behavior for the findings
    // ledger, bounded loosely here so an explosion still fails.
    expect(run.hubSpeed, diag).toBeLessThan(1.5);
  });

  test('the S0 twin shows ZERO prismatic-equivalent displacement while the S1 twin sags', { timeout: 60000 }, async () => {
    const s1 = await settleRun(deterministic, compileAssembly(sagGenotype()));
    const s0 = await settleRun(deterministic, compileAssembly(sagGenotype((g) => { for (const a of g.axles) a.suspType = 0; })));
    const diag = JSON.stringify({ s1: { meanQ: s1.meanQ, chassisY: s1.chassisY, spawnY: s1.spawnY }, s0: { meanQ: s0.meanQ, chassisY: s0.chassisY } });
    // S0: the chassis→wheel projection reads only rigid-joint compliance.
    expect(Math.abs(s0.meanQ), diag).toBeLessThan(5e-3);
    expect(Math.abs(s0.maxQ), diag).toBeLessThan(5e-3);
    // …and the S0 chassis rides at wheel height while the S1 twin sagged
    // below its spawn by a real margin.
    expect(Math.abs(s0.chassisY - 0.5), diag).toBeLessThan(0.03);
    expect(s1.spawnY - s1.chassisY, diag).toBeGreaterThan(0.03); // measured sag ~0.09 from rest 0.14
  });

  test('hand-edited k=0 ∧ c=0 realizes as an honest FREE SLIDER: the load runs it to the compression stop (never the frozen 0/0 motor)', { timeout: 60000 }, async () => {
    const run = await settleRun(deterministic, compileAssembly(sagGenotype()), {
      mutateIR: (ir) => {
        for (const a of ir.axles) {
          a.suspension.stiffness = 0;
          a.suspension.damping = 0;
        }
      },
    });
    const diag = JSON.stringify(run);
    expect(run.finite, diag).toBe(true);
    // Started at the 0.14 quiescent coordinate; a frozen axis would still
    // read ~0.14 — the slider must reach the compression stop instead.
    expect(run.meanQ, diag).toBeLessThan(0.03);
    expect(run.meanQ, diag).toBeGreaterThan(-0.05);
  });
});
