// Live initial-population policy contract (src/sim/population-initializer.js)
// — pure, no Rapier. Proves: the documented draw table's invariants hold as
// EXACT loops over a declared sample (never statistical bands), per-individual
// fork streams are population-size- and order-independent, canonical repaired
// genotypes are the stored heredity (raw draws only under keepRaw, never
// serialized), and both versioned encodings reproduce their locked
// fingerprints.
//
// DECLARED SAMPLE: seed 20260726, populationSize 64, INITIAL_POPULATION_
// DEFAULTS otherwise. MEASURED at that sample (this worktree, 2026-07-12,
// locked below as exact deterministic literals, the corpus-lock precedent):
//   symmetric-on count 50/64 (prior 0.8), wasRepaired 64/64 (repair touched
//   EVERY raw draw — R2/R5 fire almost always on uniform geometry genes; a
//   learning-report finding, not a bug), axle counts spread 1..6
//   ([12,9,10,13,11,9]), suspension modules S0 108 / S1 113, families
//   hull 17 / ladder 24 / spine 23, snapshot digest e168e974, initialization
//   digest c9a911e7. Changing ANY of these means the draw table changed —
//   bump POPULATION_INITIALIZER_VERSION and re-lock deliberately.
//
// The assembly corpus lock (24cd0dd5) is untouched by this module — this file
// never calls randomGenotype, and tests/assembly.test.js keeps guarding it.

import { describe, test, expect } from 'vitest';
import {
  INITIAL_POPULATION_DEFAULTS, POPULATION_INITIALIZER_VERSION,
  createInitialPopulation, sampleInitialGenotype, serializePopulationInitialization,
} from '../src/sim/population-initializer.js';
import { bytesEqual, serializePopulationSnapshot } from '../src/sim/population.js';
import {
  SUSPENSION_TYPES, compileAssembly, repairGenotype, serializeGenotype, validateGenotype,
} from '../src/sim/assembly.js';
import { Rng } from '../src/sim/prng.js';
import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHex } from '../src/sim/fnv1a.js';

const SAMPLE_SEED = 20260726;
const SAMPLE_SIZE = 64;
const sampleInit = createInitialPopulation(
  { seed: SAMPLE_SEED, populationSize: SAMPLE_SIZE },
  { keepRaw: true },
);
const sample = sampleInit.population.individuals;

describe('determinism and stream independence', () => {
  test('same config twice: snapshot AND manifest bytes are identical, and reproduce the locked fingerprints', () => {
    const again = createInitialPopulation({ seed: SAMPLE_SEED, populationSize: SAMPLE_SIZE });
    const snapA = serializePopulationSnapshot(sampleInit.population);
    const snapB = serializePopulationSnapshot(again.population);
    expect(bytesEqual(snapA, snapB)).toBe(true);
    expect(fnv1aHex(snapA)).toBe('e168e974'); // locked sample fingerprint
    const manA = serializePopulationInitialization(sampleInit);
    const manB = serializePopulationInitialization(again);
    expect(bytesEqual(manA, manB)).toBe(true);
    expect(fnv1aHex(manA)).toBe('c9a911e7'); // locked sample fingerprint
  });

  test('fork independence: individual K is byte-identical no matter the population size', () => {
    const small = createInitialPopulation({ seed: SAMPLE_SEED, populationSize: 8 });
    for (let k = 0; k < 8; k += 1) {
      expect(small.population.individuals[k].individualId).toBe(k);
      expect(bytesEqual(
        serializeGenotype(small.population.individuals[k].genotype),
        serializeGenotype(sample[k].genotype),
      )).toBe(true);
    }
  });

  test('individualId IS the fork streamId: sampling fork(k) standalone reproduces member k\'s raw draw', () => {
    const root = new Rng(SAMPLE_SEED);
    for (const k of [0, 3, 7, 63]) {
      const raw = sampleInitialGenotype(root.fork(k), sampleInit.config);
      const stored = sampleInit.diagnostics[k].rawGenotype;
      expect(bytesEqual(serializeGenotype(raw), serializeGenotype(stored))).toBe(true);
    }
  });

  test('ids on the initializer\'s own output are the explicit 0..N-1 stream ids', () => {
    sample.forEach((ind, i) => expect(ind.individualId).toBe(i));
  });
});

describe('draw-table policy invariants (EXACT loop over the declared sample)', () => {
  test('every raw and canonical genotype is domain-valid', () => {
    for (const [k, ind] of sample.entries()) {
      validateGenotype(ind.genotype);
      validateGenotype(sampleInit.diagnostics[k].rawGenotype);
    }
  });

  test('every individual has >= 1 and <= 6 axles (no sleds in generation 0)', () => {
    for (const ind of sample) {
      expect(ind.genotype.axles.length).toBeGreaterThanOrEqual(1);
      expect(ind.genotype.axles.length).toBeLessThanOrEqual(6);
    }
    // Measured spread at this sample — locked so a draw-table change is loud.
    const counts = [1, 2, 3, 4, 5, 6].map((n) => sample.filter((i) => i.genotype.axles.length === n).length);
    expect(counts).toEqual([12, 9, 10, 13, 11, 9]);
  });

  test('S2 is unreachable: every suspType gene sits strictly below 2/3 and every compiled module is S0 or S1', () => {
    let s0 = 0;
    let s1 = 0;
    for (const ind of sample) {
      for (const a of ind.genotype.axles) expect(a.suspType).toBeLessThan(2 / 3);
      for (const ax of compileAssembly(ind.genotype).axles) {
        expect(['S0', 'S1']).toContain(ax.suspension.type);
        if (ax.suspension.type === 'S0') s0 += 1; else s1 += 1;
      }
    }
    expect([s0, s1]).toEqual([108, 113]); // measured module split, locked
  });

  test('driven BY CONSTRUCTION: every individual has a driven axle gene AND a compiled wheel with positive torque', () => {
    for (const ind of sample) {
      expect(ind.genotype.axles.some((a) => a.driven >= 0.5)).toBe(true);
      const ir = compileAssembly(ind.genotype);
      expect(ir.power.drivenWheelCount).toBeGreaterThanOrEqual(1);
      expect(ir.axles.flatMap((a) => a.wheels).some((w) => w.driven && w.driveTorque > 0)).toBe(true);
    }
  });

  test('symmetry prior lands as drawn: symmetric-on count is EXACTLY the measured 50/64', () => {
    const on = sample.filter((ind) => ind.genotype.symmetric >= 0.5).length;
    expect(on).toBe(50);
  });

  test('frame families all reachable at this sample (measured spread, locked)', () => {
    const fam = { spine: 0, ladder: 0, hull: 0 };
    for (const ind of sample) fam[compileAssembly(ind.genotype).chassis.family] += 1;
    expect(fam).toEqual({ spine: 23, ladder: 24, hull: 17 });
  });
});

describe('repair ownership (canonical heredity)', () => {
  test('every stored genotype is repair-IDENTICAL and recompiles to itself (fixed point)', () => {
    for (const ind of sample) {
      const bytes = serializeGenotype(ind.genotype);
      expect(bytesEqual(bytes, serializeGenotype(repairGenotype(ind.genotype)))).toBe(true);
      expect(bytesEqual(bytes, serializeGenotype(compileAssembly(ind.genotype).genotype))).toBe(true);
    }
  });

  test('wasRepaired is coherent with the raw draw, and repair touched EVERY member of this sample (measured 64/64)', () => {
    for (const [k, d] of sampleInit.diagnostics.entries()) {
      const rawBytes = serializeGenotype(d.rawGenotype);
      const canonBytes = serializeGenotype(sample[k].genotype);
      expect(d.wasRepaired).toBe(!bytesEqual(rawBytes, canonBytes));
    }
    expect(sampleInit.diagnostics.filter((d) => d.wasRepaired).length).toBe(64);
  });

  test('rawGenotype exists ONLY under keepRaw — provenance never leaks by default', () => {
    const lean = createInitialPopulation({ seed: SAMPLE_SEED, populationSize: 2 });
    for (const d of lean.diagnostics) {
      expect(Object.hasOwn(d, 'rawGenotype')).toBe(false);
      expect(Object.hasOwn(d, 'wasRepaired')).toBe(true);
    }
  });
});

describe('config validation (fail-loud matrix)', () => {
  const base = { seed: 1, populationSize: 4 };
  test.each([
    ['unknown key', { ...base, populationsize: 4 }],
    ['missing seed', { populationSize: 4 }],
    ['seed -1', { ...base, seed: -1 }],
    ['seed 1.5', { ...base, seed: 1.5 }],
    ['seed 2^32', { ...base, seed: 2 ** 32 }],
    ['seed NaN', { ...base, seed: NaN }],
    ['size 0', { ...base, populationSize: 0 }],
    ['size -1', { ...base, populationSize: -1 }],
    ['size 1.5', { ...base, populationSize: 1.5 }],
    ['size string', { ...base, populationSize: '20' }],
    ['minAxles 0', { ...base, minAxles: 0 }],
    ['maxAxles 7', { ...base, maxAxles: 7 }],
    ['min > max', { ...base, minAxles: 4, maxAxles: 2 }],
    ['symmetricProbability -0.1', { ...base, symmetricProbability: -0.1 }],
    ['symmetricProbability 1.1', { ...base, symmetricProbability: 1.1 }],
    ['symmetricProbability NaN', { ...base, symmetricProbability: NaN }],
    ['minInitialPowerGene -0.1', { ...base, minInitialPowerGene: -0.1 }],
    ['minInitialPowerGene 1.5', { ...base, minInitialPowerGene: 1.5 }],
    ['suspension list empty', { ...base, initialSuspensionTypes: [] }],
    ['suspension list S2', { ...base, initialSuspensionTypes: ['S0', 'S2'] }],
    ['suspension list duplicate', { ...base, initialSuspensionTypes: ['S0', 'S0'] }],
    ['suspension list non-array', { ...base, initialSuspensionTypes: 'S0' }],
    ['null config', null],
  ])('rejects %s', (_name, bad) => {
    expect(() => createInitialPopulation(bad)).toThrow(/population-initializer: invalid config/);
  });

  test('rejects unknown options keys and non-boolean keepRaw', () => {
    expect(() => createInitialPopulation(base, { keepraw: true })).toThrow(/options\.keepraw/);
    expect(() => createInitialPopulation(base, { keepRaw: 1 })).toThrow(/keepRaw/);
  });

  test('the S2 rejection names the mask ruling', () => {
    expect(() => createInitialPopulation({ ...base, initialSuspensionTypes: ['S2'] }))
      .toThrow(/S2 lands with its realization PR/);
  });

  // C10/F6: createInitialPopulation BUILDS every member, so a populationSize
  // under the u32 wire bound (2^30) but too large to materialize was an
  // uncatchable heap abort. The digest-only encoder legitimately allows up to
  // u32 (it builds no members) — that path is covered in population-codec.
  test('rejects a populationSize too large to materialize, before the build loop', () => {
    expect(() => createInitialPopulation({ seed: 1, populationSize: 2 ** 30 }))
      .toThrow(/MAX_POPULATION_SIZE/);
    expect(() => createInitialPopulation({ seed: 1, populationSize: 20 })).not.toThrow();
  });
});

describe('initialization manifest encoding v1', () => {
  test('matches HAND-BUILT bytes on a declared size-2 population (header offsets + digest-state tail)', () => {
    const init = createInitialPopulation({ seed: 123456, populationSize: 2 });
    const actual = serializePopulationInitialization(init);
    const snapshotState = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(init.population));

    const view = new DataView(new ArrayBuffer(37));
    let o = 0;
    view.setUint16(o, POPULATION_INITIALIZER_VERSION, true); o += 2;
    view.setUint16(o, 1, true); o += 2; // genotype version
    view.setUint32(o, 123456, true); o += 4;
    view.setUint32(o, 2, true); o += 4;
    view.setUint8(o, 1); o += 1; // minAxles
    view.setUint8(o, 6); o += 1; // maxAxles
    view.setFloat64(o, 0.8, true); o += 8;
    view.setFloat64(o, 0, true); o += 8;
    view.setUint8(o, 2); o += 1; // categoryCount
    view.setUint8(o, SUSPENSION_TYPES.indexOf('S0')); o += 1;
    view.setUint8(o, SUSPENSION_TYPES.indexOf('S1')); o += 1;
    view.setUint32(o, snapshotState, true); o += 4;
    const expected = new Uint8Array(view.buffer);

    expect(actual.length).toBe(37);
    expect(bytesEqual(actual, expected)).toBe(true);
    // Spot literals: initializer version at 0, seed 123456 = 0x0001e240 LE at 4.
    expect([...actual.slice(0, 8)]).toEqual([0x01, 0x00, 0x01, 0x00, 0x40, 0xe2, 0x01, 0x00]);
  });

  test('manifest rejects a seed/config disagreement and a size mismatch loud', () => {
    const init = createInitialPopulation({ seed: 9, populationSize: 2 });
    expect(() => serializePopulationInitialization({ ...init, seed: 10 }))
      .toThrow(/disagrees with config.seed/);
    expect(() => serializePopulationInitialization({
      ...init,
      population: { ...init.population, individuals: init.population.individuals.slice(0, 1) },
    })).toThrow(/populationSize/);
  });

  test('manifest rejects a wrong initializerVersion loud', () => {
    const init = createInitialPopulation({ seed: 9, populationSize: 2 });
    expect(() => serializePopulationInitialization({ ...init, initializerVersion: 2 }))
      .toThrow(/initializerVersion/);
  });
});

describe('defaults contract', () => {
  test('INITIAL_POPULATION_DEFAULTS carries the declared Phase-1A policy and is frozen', () => {
    expect(INITIAL_POPULATION_DEFAULTS).toEqual({
      populationSize: 20,
      minAxles: 1,
      maxAxles: 6,
      symmetricProbability: 0.8,
      initialSuspensionTypes: ['S0', 'S1'],
      minInitialPowerGene: 0,
    });
    expect(Object.isFrozen(INITIAL_POPULATION_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(INITIAL_POPULATION_DEFAULTS.initialSuspensionTypes)).toBe(true);
  });
});
