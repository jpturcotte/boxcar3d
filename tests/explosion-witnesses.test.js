// Witness identity locks for the finite-explosion investigation (pure — no
// physics). Seeds: population 20260725/20260728/20260729 + characterization
// terrain 20260727, all Phase-1A allocations (CLAUDE.md seed ledger).
//
// What this file locks: WHICH genotypes the investigation studies — the
// committed digests, the reconstruction path's equivalence to the production
// initializer, the passive-twin recipe, and the morphology facts. What it
// deliberately does NOT lock: any physics observation (driven/passive
// distances, onsets, peak speeds) — those are probe measurements recorded in
// the report, never must-still-explode assertions (the investigation plan's
// regression asymmetry).

import { describe, test, expect } from 'vitest';
import {
  EXPLOSION_WITNESSES, WITNESS_SPEC, WITNESS_TERRAIN,
  passiveTwinOf, witnessDigest, witnessGenotype,
} from '../scripts/explosion-witnesses.js';
import { createInitialPopulation } from '../src/sim/population-initializer.js';
import { compileAssembly, repairGenotype, serializeGenotype } from '../src/sim/assembly.js';
import { bytesEqual } from '../src/sim/population.js';

const deepClone = (o) => JSON.parse(JSON.stringify(o));

describe('witness identity', () => {
  test('the witness table is well-formed and covers the four Phase-1A cases', () => {
    expect(EXPLOSION_WITNESSES.map((w) => `${w.label}:${w.populationSeed}:${w.individualId}`))
      .toEqual(['A:20260725:19', 'B:20260728:4', 'C:20260729:19', 'S:20260725:14']);
    for (const w of EXPLOSION_WITNESSES) {
      expect(w.genotypeDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(w.passiveGenotypeDigest).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test('the declared evaluation identity matches the Phase-1A characterization spec', () => {
    expect(WITNESS_TERRAIN).toEqual({ seed: 20260727, startFlatLength: 30, startBlendLength: 6 });
    expect(WITNESS_SPEC.deterministic).toBe(true);
    expect(WITNESS_SPEC.maxSteps).toBe(300);
    expect(WITNESS_SPEC.spawn).toEqual({ x: -44, z: 0 });
    expect(WITNESS_SPEC.targetWheelSurfaceSpeed).toBe(5);
    expect(WITNESS_SPEC.wheelFriction).toBe(1);
  });

  for (const w of EXPLOSION_WITNESSES) {
    describe(`witness ${w.label} (${w.populationSeed}:${w.individualId})`, () => {
      const genotype = witnessGenotype(w.populationSeed, w.individualId);

      test('reconstruction reproduces the committed genotype digest', () => {
        expect(witnessDigest(genotype)).toBe(w.genotypeDigest);
        // assertDigest defaulted ON above and did not throw; the explicit
        // opt-out path must reconstruct the same bytes.
        const unasserted = witnessGenotype(w.populationSeed, w.individualId, { assertDigest: false });
        expect(bytesEqual(serializeGenotype(unasserted), serializeGenotype(genotype))).toBe(true);
      });

      test('the canonical genotype is repair-identical', () => {
        expect(bytesEqual(
          serializeGenotype(repairGenotype(genotype)),
          serializeGenotype(genotype),
        )).toBe(true);
      });

      test('the standalone recipe is byte-identical to the createInitialPopulation member', () => {
        const pop = createInitialPopulation({ seed: w.populationSeed, populationSize: 20 });
        const member = pop.population.individuals.find((i) => i.individualId === w.individualId);
        expect(member).toBeDefined();
        expect(bytesEqual(serializeGenotype(member.genotype), serializeGenotype(genotype))).toBe(true);
      });

      test('the passive twin matches its committed digest and the characterize-population recipe', () => {
        const twin = passiveTwinOf(genotype);
        expect(witnessDigest(twin)).toBe(w.passiveGenotypeDigest);
        // The exact scripts/characterize-population.js construction, inlined
        // (COPY-DECLARED, not imported) — the two recipes must agree in bytes.
        const recipe = repairGenotype({
          ...deepClone(genotype),
          axles: genotype.axles.map((a) => ({ ...deepClone(a), driven: 0 })),
        });
        expect(bytesEqual(serializeGenotype(twin), serializeGenotype(recipe))).toBe(true);
        // Canonical (repair-identical) — storable population content.
        expect(bytesEqual(serializeGenotype(repairGenotype(twin)), serializeGenotype(twin))).toBe(true);
      });

      test('the compiled passive twin drives nothing and changes nothing else', () => {
        const ir = compileAssembly(genotype);
        const twinIr = compileAssembly(passiveTwinOf(genotype));
        expect(twinIr.power.drivenWheelCount).toBe(0);
        for (const axle of twinIr.axles) {
          for (const wheel of axle.wheels) {
            expect(wheel.driven).toBe(false);
            expect(wheel.driveTorque).toBe(0);
          }
        }
        // Same structure: repair never reads driven, so the twin's physical
        // body plan is the witness's.
        expect(twinIr.axles.length).toBe(ir.axles.length);
        expect(twinIr.axles.map((a) => a.wheels.length)).toEqual(ir.axles.map((a) => a.wheels.length));
        expect(twinIr.axles.map((a) => a.suspension.type)).toEqual(ir.axles.map((a) => a.suspension.type));
        expect(twinIr.mass.total).toBe(ir.mass.total);
      });

      test('morphology facts match the committed literals', () => {
        const ir = compileAssembly(genotype);
        const m = w.morphology;
        expect(ir.chassis.family).toBe(m.family);
        expect(genotype.symmetric >= 0.5).toBe(m.symmetric);
        expect(ir.axles.length).toBe(m.axleCount);
        const wheels = ir.axles.flatMap((a) => a.wheels);
        expect(wheels.length).toBe(m.wheelCount);
        expect(wheels.filter((wh) => wh.driven).length).toBe(m.drivenWheelCount);
        expect(ir.axles.map((a) => a.suspension.type)).toEqual([...m.suspensionTypes]);
        expect(ir.axles.map((a) => a.kind)).toEqual([...m.axleKinds]);
        expect(ir.mass.total).toBe(m.massTotal);
        expect(ir.power.budget).toBe(m.powerBudget);
        expect(wheels.map((wh) => wh.radius)).toEqual([...m.wheelRadii]);
      });
    });
  }

  test('an unknown witness fails loud', () => {
    expect(() => witnessGenotype(20260725, 3)).toThrow(/unknown witness/);
    expect(() => witnessGenotype(1, 19)).toThrow(/unknown witness/);
  });
});
