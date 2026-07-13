// Canonical population content contract (src/sim/population.js) — pure, no
// Rapier. Proves: individualId is explicit identity (never array position),
// public seams accept ANY input order and canonicalize by sorting a COPY,
// only repair-canonical genotypes are storable (the raw-draw-as-heredity bug
// class fails loud), and the snapshot encoding v1 is the documented explicit
// little-endian walk — verified against HAND-BUILT header bytes on a declared
// literal individual, never by calling the encoder twice.

import { describe, test, expect } from 'vitest';
import {
  POPULATION_SNAPSHOT_VERSION, bytesEqual, serializePopulationSnapshot, validatePopulation,
} from '../src/sim/population.js';
import { GENOTYPE_VERSION, serializeGenotype } from '../src/sim/assembly.js';

// Repair-stable declared genotype (fixture-A gene shape, copy-declared; its
// repair identity is asserted below, so the canonicality gate is exercised
// with a known-good input).
function canonicalGenotype(hue = 0.25) {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue, symmetric: 0.9, power: 0.5, frameDensity: 0.3,
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

// A genotype repair MOVES: radius gene 0 decodes to r = 0.2 m, below the R2
// clearance bound for this frame (maxHalfHeight 0.3 + 0.1), so repair raises
// the radius gene — byte-distinct from its canonical form.
function nonCanonicalGenotype() {
  const g = canonicalGenotype();
  g.axles[0].radius = 0;
  return g;
}

const pop = (individuals) => ({ snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals });

describe('validatePopulation', () => {
  test('returns a NEW array sorted by individualId; input order never matters and is never mutated', () => {
    const a = { individualId: 3, genotype: canonicalGenotype(0.25) };
    const b = { individualId: 9, genotype: canonicalGenotype(0.75) };
    const input = [b, a];
    const sorted = validatePopulation(pop(input));
    expect(sorted.map((i) => i.individualId)).toEqual([3, 9]);
    expect(input[0]).toBe(b); // untouched
    expect(sorted).not.toBe(input);
  });

  test.each([
    ['null population', null],
    ['wrong snapshotVersion', { snapshotVersion: 2, individuals: [{ individualId: 0, genotype: canonicalGenotype() }] }],
    ['missing individuals', { snapshotVersion: 1 }],
    ['empty individuals', pop([])],
    ['null individual', pop([null])],
  ])('rejects %s loud', (_name, bad) => {
    expect(() => validatePopulation(bad)).toThrow(/population: invalid/);
  });

  test.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['2^32', 2 ** 32],
    ['string', '3'],
    ['NaN', NaN],
  ])('rejects a non-canonical-uint32 individualId (%s) loud', (_name, id) => {
    expect(() => validatePopulation(pop([{ individualId: id, genotype: canonicalGenotype() }])))
      .toThrow(/individualId/);
  });

  test('rejects duplicate individualIds loud', () => {
    expect(() => validatePopulation(pop([
      { individualId: 4, genotype: canonicalGenotype(0.1) },
      { individualId: 4, genotype: canonicalGenotype(0.9) },
    ]))).toThrow(/duplicate 4/);
  });

  test('rejects a NON-CANONICAL genotype loud — raw draws cannot survive as hereditary records', () => {
    expect(() => validatePopulation(pop([{ individualId: 0, genotype: nonCanonicalGenotype() }])))
      .toThrow(/not canonical.*repaired genotypes/s);
  });

  test('rejects a domain-invalid genotype loud (assembly validation propagates)', () => {
    const g = canonicalGenotype();
    g.power = 1.5;
    expect(() => validatePopulation(pop([{ individualId: 0, genotype: g }])))
      .toThrow(/assembly: invalid genotype at power/);
  });
});

describe('snapshot encoding v1', () => {
  test('matches HAND-BUILT bytes on a declared single-individual population (header offsets + full array)', () => {
    const g = canonicalGenotype();
    const gBytes = serializeGenotype(g); // the assembly walk, locked elsewhere (24cd0dd5 + byte-0 test)
    expect(gBytes.length).toBe(268 + 128 * 2); // 2 axles

    const actual = serializePopulationSnapshot(pop([{ individualId: 7, genotype: g }]));

    // Hand-built expectation: raw DataView following the documented walk.
    const view = new DataView(new ArrayBuffer(2 + 2 + 4 + 4 + 4 + gBytes.length));
    let o = 0;
    view.setUint16(o, 1, true); o += 2;            // snapshotVersion
    view.setUint16(o, GENOTYPE_VERSION, true); o += 2; // genotype schema version
    view.setUint32(o, 1, true); o += 4;            // individualCount
    view.setUint32(o, 7, true); o += 4;            // individualId
    view.setUint32(o, gBytes.length, true); o += 4; // genotypeByteLength
    const expected = new Uint8Array(view.buffer);
    expected.set(gBytes, o);

    expect(actual.length).toBe(expected.length);
    expect(bytesEqual(actual, expected)).toBe(true);

    // Spot literals so the walk is pinned even if both builders drifted
    // together: version u16 LE at 0, genotype version at 2, count at 4,
    // individualId 7 at 8, byteLength 524 = 0x020c at 12.
    expect([...actual.slice(0, 16)]).toEqual([
      0x01, 0x00, 0x01, 0x00,
      0x01, 0x00, 0x00, 0x00,
      0x07, 0x00, 0x00, 0x00,
      0x0c, 0x02, 0x00, 0x00,
    ]);
  });

  test('input order is invisible: shuffled individuals serialize byte-identically', () => {
    const a = { individualId: 0, genotype: canonicalGenotype(0.2) };
    const b = { individualId: 11, genotype: canonicalGenotype(0.4) };
    const c = { individualId: 5, genotype: canonicalGenotype(0.6) };
    const one = serializePopulationSnapshot(pop([a, b, c]));
    const two = serializePopulationSnapshot(pop([c, a, b]));
    expect(bytesEqual(one, two)).toBe(true);
  });

  test('variable-length genotypes frame unambiguously (length prefixes differ, streams never blur)', () => {
    const twoAxle = canonicalGenotype(0.3);
    const zeroAxle = canonicalGenotype(0.3);
    zeroAxle.axles = [];
    const bytes = serializePopulationSnapshot(pop([
      { individualId: 0, genotype: zeroAxle },
      { individualId: 1, genotype: twoAxle },
    ]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(12, true)).toBe(268);        // zero-axle stream length
    const second = 8 + 4 + 4 + 268;
    expect(view.getUint32(second, true)).toBe(1);      // next individualId
    expect(view.getUint32(second + 4, true)).toBe(268 + 256); // two-axle stream length
    expect(bytes.length).toBe(8 + (8 + 268) + (8 + 524));
  });
});
