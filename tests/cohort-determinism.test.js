// The NARROWED cohort gate for the cross-OS determinism matrix
// (npm run test:determinism — ubuntu/windows/macos × Node 22): the exact
// input-order-independence and isolation-contract claims from
// tests/cohort-invariance.test.js, sized for the matrix (3 members, 150
// steps). The full 5-member protocol, its measured shared-world finding, and
// the world-mode ruling live in the invariance file and the Phase-1A report;
// this file only re-proves the CONTRACT everywhere the golden locks run.
//
// Everything here is exact — byte equality on fitness vectors, Object.is at
// leaves on results. No bands, no toBeCloseTo, no fitness floors.

import { describe, test, expect } from 'vitest';
import {
  POPULATION_WORLD_MODE, evaluatePopulation, spawnPoseOnFlatStart,
} from '../src/sim/population-evaluation.js';
import { POPULATION_SNAPSHOT_VERSION, bytesEqual } from '../src/sim/population.js';
import { compileAssembly } from '../src/sim/assembly.js';
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
const MAX_STEPS = 150;
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

// Copy-declared members (fixture-A shape / fixture-B shape / zero-axle sled),
// canonical by construction, non-contiguous ids.
const frame = (node) => ({
  family: 0.1,
  segments: [{
    nodeCount: 0.5,
    nodes: Array.from({ length: 6 }, node),
    fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
  }],
});
const node = (height) => () => ({ gap: 0.5, height, halfWidth: 0.5, thickness: 0.5 });

function s0Plain() {
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return { version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3, frame: frame(node(0.5)), axles: [axle(0.2), axle(0.8)] };
}
function mixed() {
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
function sled() {
  return { version: 1, hue: 0.25, symmetric: 0.9, power: 0.5, frameDensity: 0.3, frame: frame(node(0.5)), axles: [] };
}

const MEMBERS = [
  { individualId: 6, build: s0Plain },
  { individualId: 21, build: mixed },
  { individualId: 33, build: sled },
].map(({ individualId, build }) => ({ individualId, genotype: compileAssembly(build()).genotype }));

const popOf = (idx) => ({ snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals: idx.map((i) => MEMBERS[i]) });
const spec = () => ({
  terrain: { ...TERRAIN },
  maxSteps: MAX_STEPS,
  deterministic: true,
  spawn: { ...SPAWN },
});

describe('cohort gate (deterministic flavor, matrix-sized)', () => {
  test('input order is invisible: canonical vs reversed vs permuted input produce identical fitness-vector bytes and leaf-equal results', { timeout: 240000 }, async () => {
    const canonical = await evaluatePopulation(popOf([0, 1, 2]), spec());
    const reversed = await evaluatePopulation(popOf([2, 1, 0]), spec());
    const permuted = await evaluatePopulation(popOf([1, 2, 0]), spec());
    expect(canonical.worldMode).toBe(POPULATION_WORLD_MODE);
    expect(bytesEqual(canonical.fitnessVector.bytes, reversed.fitnessVector.bytes)).toBe(true);
    expect(bytesEqual(canonical.fitnessVector.bytes, permuted.fitnessVector.bytes)).toBe(true);
    const project = (e) => e.individuals.map(({ individualId, fitness, valid, diagnostics }) => ({ individualId, fitness, valid, diagnostics }));
    assertLeafEqual(project(canonical), project(reversed), 'canonical-vs-reversed');
    assertLeafEqual(project(canonical), project(permuted), 'canonical-vs-permuted');

    // Isolation contract, two representatives (one rigid, one suspended):
    // evaluator results leaf-equal a manual solo runEvaluation.
    for (const m of [MEMBERS[0], MEMBERS[1]]) {
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
      const entry = canonical.individuals.find((i) => i.individualId === m.individualId);
      assertLeafEqual({
        forwardDistance: v.forwardDistance,
        maxForwardDistance: v.maxForwardDistance,
        stepAtMaxForwardDistance: v.stepAtMaxForwardDistance,
        maxBackwardDistance: v.maxBackwardDistance,
        finalPose: v.finalPose,
        finalVelocity: v.finalVelocity,
        finite: v.finite,
      }, {
        forwardDistance: entry.diagnostics.forwardDistance,
        maxForwardDistance: entry.diagnostics.maxForwardDistance,
        stepAtMaxForwardDistance: entry.diagnostics.stepAtMaxForwardDistance,
        maxBackwardDistance: entry.diagnostics.maxBackwardDistance,
        finalPose: entry.diagnostics.finalPose,
        finalVelocity: entry.diagnostics.finalVelocity,
        finite: entry.diagnostics.finite,
      }, `member ${m.individualId}`);
    }
  });
});
