// Chromium codec smoke — the browser config collects ONLY tests/browser/**,
// so without this file none of the new decoders would ever run in Chromium.
// Pure and inexpensive (no physics, no golden locks — those keep their own
// dedicated browser gates): the same production modules Vite serves to Node
// must encode/decode bit-identically in the pinned browser. All assertions
// are Object.is / byte-equal.

import { describe, test, expect } from 'vitest';
import {
  GENOTYPE_VERSION,
  NODE_SLOTS,
  deserializeGenotype,
  randomGenotype,
  repairGenotype,
  serializeGenotype,
} from '../../src/sim/assembly.js';
import {
  SPAWN_CLEARANCE,
  deserializeEvaluationSpec,
  deserializeFitnessVector,
  serializeEvaluationSpec,
  serializeFitnessVector,
} from '../../src/sim/population-evaluation.js';
import { bytesEqual } from '../../src/sim/population.js';
import { TERRAIN_DEFAULTS } from '../../src/sim/terrain.js';
import { bytesToHex, hexToBytes } from '../../src/sim/bytes.js';
import { Rng } from '../../src/sim/prng.js';

const handNode = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
const handGenotype = () => ({
  version: GENOTYPE_VERSION,
  hue: 0.25,
  symmetric: 0.9,
  power: 0.5,
  frameDensity: 0.3,
  frame: {
    family: 0.1,
    segments: [{
      nodeCount: 0.5,
      nodes: Array.from({ length: NODE_SLOTS }, handNode),
      fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
    }],
  },
  axles: [{
    posX01: 0.5, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0.5, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  }],
});

describe('codec smoke (Chromium)', () => {
  test('genotype encode/decode round trip: hand-built + seed-20260710 corpus members, −0 included', () => {
    const genotypes = [handGenotype()];
    for (let i = 0; i < 5; i += 1) {
      genotypes.push(repairGenotype(randomGenotype(new Rng(20260710).fork(i))));
    }
    genotypes[0].hue = -0; // the sign-bit case, in the browser too
    for (const genotype of genotypes) {
      const bytes = serializeGenotype(genotype);
      const decoded = deserializeGenotype(bytes);
      expect(bytesEqual(serializeGenotype(decoded), bytes)).toBe(true);
    }
    expect(Object.is(deserializeGenotype(serializeGenotype(genotypes[0])).hue, -0)).toBe(true);
  });

  test('evaluation-spec encode/decode round trip', () => {
    const spec = {
      deterministic: true,
      termination: 'maxSteps',
      maxSteps: 120,
      spawn: { x: -45, z: 0, clearance: SPAWN_CLEARANCE },
      targetWheelSurfaceSpeed: 5,
      wheelFriction: 1,
      terrain: { ...TERRAIN_DEFAULTS },
    };
    const bytes = serializeEvaluationSpec(spec);
    expect(bytes.length).toBe(401);
    const decoded = deserializeEvaluationSpec(bytes);
    expect(Object.is(decoded.terrain.mudCoverage, TERRAIN_DEFAULTS.mudCoverage)).toBe(true);
    expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
  });

  test('fitness-vector synth encode/decode round trip (declared-state path)', () => {
    const evaluation = {
      spec: {
        deterministic: true,
        termination: 'maxSteps',
        maxSteps: 120,
        spawn: { x: -45, z: 0, clearance: SPAWN_CLEARANCE },
        targetWheelSurfaceSpeed: 5,
        wheelFriction: 1,
        terrain: { ...TERRAIN_DEFAULTS },
      },
      populationSnapshotDigestState: 0xdeadbeef,
      individuals: [
        { individualId: 3, valid: false, integrityStatus: 'nonFinite', fitness: 0 },
        { individualId: 7, valid: true, integrityStatus: 'ok', fitness: 8.419723510742188 },
      ],
    };
    const bytes = serializeFitnessVector(evaluation);
    const decoded = deserializeFitnessVector(bytes);
    expect(decoded.individuals.length).toBe(2);
    expect(Object.is(decoded.individuals[1].fitness, 8.419723510742188)).toBe(true);
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });

  test('bytesToHex/hexToBytes round trip', () => {
    const bytes = serializeGenotype(handGenotype());
    const hex = bytesToHex(bytes);
    expect(hex).toBe(hex.toLowerCase());
    expect(bytesEqual(hexToBytes(hex), bytes)).toBe(true);
    expect(bytesToHex(hexToBytes('0123456789abcdef'))).toBe('0123456789abcdef');
  });
});
