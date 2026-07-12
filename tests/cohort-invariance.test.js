// Cohort/order-independence — the Phase-1A empirical centerpiece, and the
// isolation contract that answers it.
//
// THE MEASURED FINDING (2026-07-12, this worktree, deterministic flavor,
// rapier 0.19.3; probes recorded in full in
// docs/ga-phase-1a-population-fitness-report-2026-07-12.md): SHARED-WORLD
// ghost evaluation is NOT invariant under cohort composition. On a declared
// flat pad (seed 20260723) with a 5-member heterogeneous cohort (plain S0,
// mixed S0/S1, 3-axle S1, mixed-radius S0, zero-axle sled), the sled's
// trajectory diverged from its solo run at the f64 bit level — first at its
// initial contact solve (capture 3, translation.x, ~1e-4 m by step ~100) —
// and differently in every ordering. Refinement probes: the divergence needs
// NO contact between vehicles (an airborne neighbor 50+ steps from touchdown
// still perturbs it), NO broadphase proximity (5 m separation, no AABB
// overlap), and follows NO monotone composition rule (sled+heavy identical
// yet heavy+sled diverges; sled+s0 diverges yet sled+s0+heavy identical).
// Every WHEELED member measured bit-identical in every tested composition
// and the fixture-A identical-ghost lock still holds — rounding coincidences
// absent an engine contract, not a guarantee (evolved phenotypes flip and
// rest on their chassis).
//
// THE RULING: POPULATION_WORLD_MODE = 'isolatedWorlds' — one world per
// individual. This file locks the resulting CONTRACT (evaluator results are
// leaf-exact equal to manual solo runs and independent of input order);
// it deliberately asserts NOTHING about shared-world divergence persisting —
// an engine that gets better must not fail CI. The shared-world recheck
// probe lives in scripts/characterize-population.js (--recheck-shared-world)
// for deliberate re-runs on engine upgrades.
//
// Identity discipline: members carry non-contiguous individualIds
// (3/11/27/42/64) so nothing can accidentally pass by array position.

import { describe, test, expect } from 'vitest';
import {
  POPULATION_WORLD_MODE, evaluatePopulation, spawnPoseOnFlatStart,
} from '../src/sim/population-evaluation.js';
import { POPULATION_SNAPSHOT_VERSION, bytesEqual } from '../src/sim/population.js';
import { compileAssembly, serializeGenotype } from '../src/sim/assembly.js';
import { runEvaluation } from '../src/sim/evaluation.js';

const TERRAIN = Object.freeze({
  seed: 20260723,
  startFlatLength: 80,
  startBlendLength: 6,
  craterDensity: 0,
  featureDensity: 0,
  sandCoverage: 0,
  mudCoverage: 0,
});
const MAX_STEPS = 300;
const SPAWN = Object.freeze({ x: -45, z: 0 });

function assertLeafEqual(a, b, path) {
  if (typeof a === 'object' && a !== null) {
    expect(typeof b === 'object' && b !== null, `${path}: expected object`).toBe(true);
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    expect(kb, `${path}: key sets differ`).toEqual(ka);
    for (const k of ka) assertLeafEqual(a[k], b[k], `${path}.${k}`);
    return;
  }
  if (!Object.is(a, b)) expect.fail(`${path}: ${String(a)} !== ${String(b)}`);
}

// --- The copy-declared heterogeneous cohort ----------------------------------

const frame = (node, nodeCount = 0.5) => ({
  family: 0.1,
  segments: [{
    nodeCount,
    nodes: Array.from({ length: 6 }, node),
    fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
  }],
});
const node = (height, gap = 0.5) => () => ({ gap, height, halfWidth: 0.5, thickness: 0.5 });

function s0Plain() { // fixture-A shape, 5 bodies
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return { version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3, frame: frame(node(0.5)), axles: [axle(0.2), axle(0.8)] };
}
function mixed() { // fixture-B shape, 7 bodies
  const axle = (posX01, suspType, extra = {}) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.4, width: 0.5, density: 0.15,
    suspType, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
    ...extra,
  });
  return {
    version: 1, hue: 0.25, symmetric: 0.9, power: 1, frameDensity: 0.1, frame: frame(node(0.3)),
    axles: [axle(0.2, 0), axle(0.8, 0.5, { stiffness: 0.33, damping: 0.1, travel: 0.75, restLength: 0.29 })],
  };
}
function s1Heavy() { // fixture-C-derived, 3 paired S1 axles, 13 bodies
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.44, width: 0.5, density: 0.15,
    suspType: 0.5, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return { version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.15, frame: frame(node(0.5, 1), 1), axles: [0.1, 0.5, 0.9].map(axle) };
}
function mixedRadius() { // fixture-D shape, 5 bodies
  const axle = (posX01, radius) => ({
    posX01, paired: 1, trackHalf: 0.5, radius, width: 0.5, density: 0.1,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return { version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3, frame: frame(node(0.1)), axles: [axle(0.2, 0.2), axle(0.8, 0.8)] };
}
function sled() { // zero-axle, 1 body
  return { version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3, frame: frame(node(0.5)), axles: [] };
}

// Canonical members (repaired-clone ownership) with NON-CONTIGUOUS ids.
const MEMBERS = [
  { individualId: 3, build: s0Plain },
  { individualId: 11, build: mixed },
  { individualId: 27, build: s1Heavy },
  { individualId: 42, build: mixedRadius },
  { individualId: 64, build: sled },
].map(({ individualId, build }) => ({ individualId, genotype: compileAssembly(build()).genotype }));

// Three declared input orders. Every member occupies at least two distinct
// non-zero positions across them (asserted structurally below).
const CANONICAL = [0, 1, 2, 3, 4];
const REVERSED = [4, 3, 2, 1, 0];
const PERMUTED = [1, 4, 0, 2, 3];
const orderOf = (idx) => ({ snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals: idx.map((i) => MEMBERS[i]) });

const spec = () => ({
  terrain: { ...TERRAIN },
  maxSteps: MAX_STEPS,
  deterministic: true,
  spawn: { ...SPAWN },
});

// One evaluation per input order, computed once (module-level, Vitest forks
// pool: one file = one process).
let evaluations = null;
async function getEvaluations() {
  if (evaluations === null) {
    evaluations = {
      canonical: await evaluatePopulation(orderOf(CANONICAL), spec()),
      reversed: await evaluatePopulation(orderOf(REVERSED), spec()),
      permuted: await evaluatePopulation(orderOf(PERMUTED), spec()),
    };
  }
  return evaluations;
}

describe('cohort/order independence under the isolation contract (deterministic flavor)', () => {
  test('the three input orders cover >= 2 distinct non-zero positions per member (protocol premise)', () => {
    for (let m = 0; m < MEMBERS.length; m += 1) {
      const positions = new Set([CANONICAL.indexOf(m), REVERSED.indexOf(m), PERMUTED.indexOf(m)]);
      const nonZero = [...positions].filter((p) => p !== 0);
      expect(nonZero.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('members are canonical and structurally heterogeneous (S0, S1, mixed, mixed-radius, sled)', () => {
    const stationCounts = [];
    for (const m of MEMBERS) {
      const ir = compileAssembly(m.genotype);
      expect(bytesEqual(serializeGenotype(m.genotype), serializeGenotype(ir.genotype))).toBe(true);
      stationCounts.push(ir.axles.flatMap((a) => a.wheels).length);
    }
    expect(stationCounts).toEqual([4, 4, 6, 4, 0]);
  });

  test('input permutation is invisible: identical ID-keyed results and identical fitness-vector BYTES', { timeout: 240000 }, async () => {
    const ev = await getEvaluations();
    expect(ev.canonical.worldMode).toBe(POPULATION_WORLD_MODE);
    const project = (e) => e.individuals.map(({ individualId, fitness, valid, diagnostics }) => ({ individualId, fitness, valid, diagnostics }));
    assertLeafEqual(project(ev.canonical), project(ev.reversed), 'canonical-vs-reversed');
    assertLeafEqual(project(ev.canonical), project(ev.permuted), 'canonical-vs-permuted');
    expect(bytesEqual(ev.canonical.fitnessVector.bytes, ev.reversed.fitnessVector.bytes)).toBe(true);
    expect(bytesEqual(ev.canonical.fitnessVector.bytes, ev.permuted.fitnessVector.bytes)).toBe(true);
  });

  test('isolation contract: EVERY member\'s result is leaf-exact equal to a manual solo runEvaluation', { timeout: 240000 }, async () => {
    const ev = await getEvaluations();
    for (const m of MEMBERS) {
      const ir = compileAssembly(m.genotype);
      const solo = await runEvaluation({
        deterministic: true,
        terrain: { ...TERRAIN },
        vehicles: [{
          ir,
          spawn: spawnPoseOnFlatStart(ir, SPAWN),
          targetWheelSurfaceSpeed: 5,
          wheelFriction: 1,
        }],
        maxSteps: MAX_STEPS,
        trace: { mode: 'none' },
      });
      const v = solo.vehicles[0];
      const entry = ev.canonical.individuals.find((i) => i.individualId === m.individualId);
      expect(entry).toBeDefined();
      assertLeafEqual({
        forwardDistance: v.forwardDistance,
        maxForwardDistance: v.maxForwardDistance,
        stepAtMaxForwardDistance: v.stepAtMaxForwardDistance,
        maxBackwardDistance: v.maxBackwardDistance,
        origin: v.origin,
        finalPose: v.finalPose,
        finalVelocity: v.finalVelocity,
        finite: v.finite,
        terminated: v.terminated,
        bodies: v.bodies,
        joints: v.joints,
        mass: v.mass,
        stationCount: v.stationCount,
      }, entry.diagnostics, `member ${m.individualId}`);
      expect(Object.is(entry.fitness, entry.valid ? v.maxForwardDistance : 0)).toBe(true);
    }
  });

  test('every wheeled member makes real progress and the sled scores ~0 (cohort sanity, generous bands)', { timeout: 240000 }, async () => {
    const ev = await getEvaluations();
    const byId = new Map(ev.canonical.individuals.map((i) => [i.individualId, i]));
    for (const id of [3, 11, 27, 42]) expect(byId.get(id).fitness).toBeGreaterThan(2);
    expect(byId.get(64).fitness).toBeLessThan(0.01);
    for (const ind of ev.canonical.individuals) expect(ind.valid).toBe(true);
  });
});
