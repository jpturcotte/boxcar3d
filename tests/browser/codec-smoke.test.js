// The Chromium codec gate: the decoders and the hex representation must
// behave identically in the pinned browser, not just in Node.
//
// This file exists because vitest.browser.config.js collects ONLY
// tests/browser/** — without it, no line of the codec family would ever
// execute in Chromium, and "usable in Node and the pinned browser" would be an
// untested claim. It is imports plus assertions: no physics, no second
// simulation loop, and NO golden lock of its own (this PR moves no lock; the
// population gate alongside it re-proves the committed digests).

import { describe, test, expect } from 'vitest';
import {
  deserializeGenotype, randomGenotype, repairGenotype, serializeGenotype,
  genotypeFieldWalk, genotypeByteLength,
} from '../../src/sim/assembly.js';
import {
  deserializePopulationSnapshot, serializePopulationSnapshot, bytesEqual,
} from '../../src/sim/population.js';
import {
  SPAWN_CLEARANCE, deserializeEvaluationSpec, deserializeFitnessVector,
  serializeEvaluationSpec, serializeFitnessVector,
} from '../../src/sim/population-evaluation.js';
import {
  deserializePopulationInitialization, serializePopulationInitialization,
} from '../../src/sim/population-initializer.js';
import { bytesToHex, hexToBytes } from '../../src/sim/bytes.js';
import { TERRAIN_DEFAULTS } from '../../src/sim/terrain.js';
import { POPULATION_FIXTURE_A, populationEvaluationInputsFor } from '../../src/sim/population-fixtures.js';
import { Rng } from '../../src/sim/prng.js';

const resolvedSpec = () => ({
  deterministic: true,
  termination: 'maxSteps',
  maxSteps: 120,
  spawn: { x: -45, z: 0, clearance: SPAWN_CLEARANCE },
  targetWheelSurfaceSpeed: 5,
  wheelFriction: 1,
  terrain: { ...TERRAIN_DEFAULTS, seed: 20260723, startFlatLength: 60 },
});

describe('canonical codecs (Chromium)', () => {
  test('genotype: the seeded corpus round-trips bit-exactly', () => {
    console.log(`codec browser gate on: ${navigator.userAgent}`);
    // A slice of the seed-20260710 corpus — enough axle-count variety to
    // exercise the variable-length walk in the browser's f64 handling.
    for (let i = 0; i < 32; i += 1) {
      const g = repairGenotype(randomGenotype(new Rng(20260710).fork(i)));
      const bytes = serializeGenotype(g);
      const decoded = deserializeGenotype(bytes);
      expect(decoded.axles.length).toBe(g.axles.length);
      expect(Object.is(decoded.hue, g.hue), `corpus[${i}].hue`).toBe(true);
      expect(bytesEqual(serializeGenotype(decoded), bytes), `corpus[${i}]`).toBe(true);
    }
  });

  test('genotype: signed zero and the schema walk survive the browser', () => {
    const g = repairGenotype(randomGenotype(new Rng(20260710).fork(0)));
    g.hue = -0;
    const decoded = deserializeGenotype(serializeGenotype(g));
    expect(Object.is(decoded.hue, -0)).toBe(true);
    const walk = genotypeFieldWalk(2);
    expect(walk).toHaveLength(68);
    expect(walk[walk.length - 1].byteOffset + walk[walk.length - 1].byteLength)
      .toBe(genotypeByteLength(2));
  });

  test('population snapshot: the committed fixture round-trips', () => {
    const { population, initialization } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const bytes = serializePopulationSnapshot(population);
    const decoded = deserializePopulationSnapshot(bytes);
    expect(decoded.individuals).toHaveLength(20);
    expect(bytesEqual(serializePopulationSnapshot(decoded), bytes)).toBe(true);

    const manifest = serializePopulationInitialization(initialization);
    const decodedManifest = deserializePopulationInitialization(manifest);
    expect(decodedManifest.seed).toBe(POPULATION_FIXTURE_A.populationSeed);
    expect(bytesEqual(serializePopulationInitialization(decodedManifest), manifest)).toBe(true);
  });

  test('evaluation spec: the 401-byte walk round-trips', () => {
    const bytes = serializeEvaluationSpec(resolvedSpec());
    expect(bytes.length).toBe(401);
    const decoded = deserializeEvaluationSpec(bytes);
    expect(Object.keys(decoded.terrain)).toHaveLength(33);
    expect(decoded.terrain.seed).toBe(20260723);
    expect(bytesEqual(serializeEvaluationSpec(decoded), bytes)).toBe(true);
  });

  test('fitness vector: round-trips through the digest-state input path', () => {
    const evaluation = {
      spec: resolvedSpec(),
      populationSnapshotDigestState: 0xdeadbeef,
      individuals: [
        { individualId: 0, valid: true, integrityStatus: 'ok', fitness: 12.484905242919922 },
        { individualId: 4, valid: false, integrityStatus: 'ok', fitness: 0 },
        { individualId: 9, valid: true, integrityStatus: 'numericalDivergence', fitness: 0 },
      ],
    };
    const bytes = serializeFitnessVector(evaluation);
    const decoded = deserializeFitnessVector(bytes);
    expect(decoded.individuals.map((m) => m.individualId)).toEqual([0, 4, 9]);
    expect(Object.is(decoded.individuals[0].fitness, 12.484905242919922)).toBe(true);
    expect(decoded.individuals[2].integrityStatus).toBe('numericalDivergence');
    expect(bytesEqual(serializeFitnessVector(decoded), bytes)).toBe(true);
  });

  test('decoders reject malformed streams in the browser too', () => {
    const bytes = serializeEvaluationSpec(resolvedSpec());
    expect(() => deserializeEvaluationSpec(bytes.slice(0, 40))).toThrow(/invalid encoded evaluation spec/);
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => deserializeEvaluationSpec(trailing)).toThrow(/trailing byte/);
  });

  test('hex: bytes -> text -> bytes is exact, and malformed text is refused', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const hex = bytesToHex(all);
    expect(hex).toHaveLength(512);
    expect(bytesEqual(hexToBytes(hex), all)).toBe(true);
    const envelope = JSON.parse(JSON.stringify({ payload: bytesToHex(serializeEvaluationSpec(resolvedSpec())) }));
    expect(bytesEqual(hexToBytes(envelope.payload), serializeEvaluationSpec(resolvedSpec()))).toBe(true);
    for (const bad of ['abc', 'AB', 'zz']) {
      expect(() => hexToBytes(bad), bad).toThrow(/bytes: invalid hex/);
    }
  });
});

describe('cross-realm rejection (Chromium, round 14)', () => {
  // Same-origin iframe = a genuine cross-realm Uint8Array. `instanceof
  // Uint8Array` is false in the parent realm, so every gate short-circuits
  // through its own dialect. The point is no gate silently accepts it — a
  // drift from `instanceof` to a broader brand check would need active
  // cross-realm rejection to keep this green.
  test('a same-origin iframe Uint8Array is rejected by bytesToHex and the decoders', async () => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    try {
      const foreignU8 = new iframe.contentWindow.Uint8Array(4);
      expect(foreignU8 instanceof Uint8Array).toBe(false); // sanity: cross-realm
      // bytesToHex has a gated `requireOrdinaryBytes` (same-realm brand).
      expect(() => bytesToHex(foreignU8)).toThrow();
      // A decoder likewise refuses the cross-realm view.
      expect(() => deserializeGenotype(foreignU8)).toThrow();
    } finally {
      iframe.remove();
    }
  });
});
