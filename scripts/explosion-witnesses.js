// Finite-explosion witness identities — INVESTIGATION FIXTURES, not a
// production contract. This module freezes the identities of the GA Phase 1A
// finite-physics-explosion witnesses (docs/ga-phase-1a-population-fitness-
// report-2026-07-12.md §3.2/§3.3, §4.3) so the physics-integrity
// investigation can reproduce them forever: population seed + individualId +
// the canonical (repaired) genotype digest, plus morphology facts. It lives
// in scripts/ beside the probe instrument (tests importing scripts/ is the
// population-probe-schema precedent) — src/sim stays reserved for locked
// production contracts.
//
// IDENTITY, not behavior: the digests below lock WHICH genotypes the
// investigation studies. The Phase-1A physics observations (driven vs passive
// maximum forward progress) are deliberately NOT data in this module — they
// are report-recorded measurements the probe re-measures, never assertions.
// A future correction or engine change may legitimately move every physics
// number; it must never move these identities.
//
//   label | seed     | id | phase-1A driven maxFwd | passive twin (observed)
//   ------+----------+----+------------------------+------------------------
//   A     | 20260725 | 19 | ~8.17e6 m              | ~1.80e7 m
//   B     | 20260728 |  4 | ~2.96e3 m              | ~0.53 m  (drive-dependent)
//   C     | 20260729 | 19 | ~1.16e3 m              | ~9.47e6 m
//   S     | 20260725 | 14 | ~3.63 m                | ~1.28e2 m (secondary)
//
// Reconstruction is the exact production path: an individual's genotype is
// sampleInitialGenotype(new Rng(populationSeed).fork(individualId), {})
// repaired through compileAssembly — provably byte-identical to the
// createInitialPopulation({seed, populationSize: 20}) member because
// Rng.fork reads only (seed, streamId) (tests/explosion-witnesses.test.js
// asserts the cross-check). The passive twin zeroes every axle's `driven`
// gene and re-repairs — repair never reads or writes driven, so ONLY the
// drive torques collapse (the scripts/characterize-population.js recipe).
//
// CONTINGENCY (recorded per the investigation plan): if a landed correction
// ever changes initializer or repair behavior — which would move these
// digests — materialize each witness as a full committed genotype literal in
// this module and switch witnessGenotype() to return the literal instead of
// reconstructing. The reproducers must survive; the reconstruction path is a
// convenience, not the identity.

import { Rng } from '../src/sim/prng.js';
import { sampleInitialGenotype } from '../src/sim/population-initializer.js';
import { compileAssembly, repairGenotype, serializeGenotype } from '../src/sim/assembly.js';
import { fnv1aHex } from '../src/sim/fnv1a.js';

// Measured 2026-07-13 on this worktree (Node 22, pure JS — no physics
// involved); asserted by tests/explosion-witnesses.test.js. morphology is
// read from the compiled IR of the canonical genotype; mass/power are exact
// f64 literals (deterministic pure derivations of the digest-locked genes).
export const EXPLOSION_WITNESSES = Object.freeze([
  Object.freeze({
    label: 'A',
    populationSeed: 20260725,
    individualId: 19,
    genotypeDigest: 'ec8d42cf',
    passiveGenotypeDigest: '0afc0cd1',
    morphology: Object.freeze({
      family: 'spine',
      symmetric: false,
      axleCount: 6,
      wheelCount: 10,
      drivenWheelCount: 4,
      suspensionTypes: Object.freeze(['S0', 'S0', 'S0', 'S1', 'S1', 'S0']),
      axleKinds: Object.freeze(['single', 'single', 'paired', 'paired', 'paired', 'paired']),
      massTotal: 435.7882902944057,
      powerBudget: 93.40740437619388,
      wheelRadii: Object.freeze([
        0.3070301566738636, 0.5764181110309436, 0.3070301566738636,
        0.3070301566738636, 0.518492563907057, 0.518492563907057,
        0.31252954415977, 0.31510437218584647, 0.3468516673194244,
        0.34428196993592997,
      ]),
    }),
  }),
  Object.freeze({
    label: 'B',
    populationSeed: 20260728,
    individualId: 4,
    genotypeDigest: '393f7e0e',
    passiveGenotypeDigest: 'f1237fed',
    morphology: Object.freeze({
      family: 'spine',
      symmetric: true,
      axleCount: 6,
      wheelCount: 10,
      drivenWheelCount: 3,
      suspensionTypes: Object.freeze(['S0', 'S1', 'S1', 'S1', 'S1', 'S1']),
      axleKinds: Object.freeze(['single', 'paired', 'single', 'paired', 'paired', 'paired']),
      massTotal: 921.8518291667556,
      powerBudget: 21.9611213542521,
      wheelRadii: Object.freeze([
        0.4446065812371671, 0.4509566760854795, 0.4509566760854795,
        0.4633520397357642, 0.4446065812371671, 0.4446065812371671,
        0.5539199876831844, 0.5539199876831844, 0.673573257564567,
        0.673573257564567,
      ]),
    }),
  }),
  Object.freeze({
    label: 'C',
    populationSeed: 20260729,
    individualId: 19,
    genotypeDigest: '57faad4e',
    passiveGenotypeDigest: '9f722379',
    morphology: Object.freeze({
      family: 'hull',
      symmetric: true,
      axleCount: 4,
      wheelCount: 8,
      drivenWheelCount: 6,
      suspensionTypes: Object.freeze(['S0', 'S1', 'S1', 'S1']),
      axleKinds: Object.freeze(['paired', 'paired', 'paired', 'paired']),
      massTotal: 864.3063627248623,
      powerBudget: 165.5149795114994,
      wheelRadii: Object.freeze([
        0.49235045958776025, 0.49235045958776025, 0.49235045958776025,
        0.49235045958776025, 0.5812605260172858, 0.5812605260172858,
        0.49235045958776025, 0.49235045958776025,
      ]),
    }),
  }),
  Object.freeze({
    label: 'S',
    populationSeed: 20260725,
    individualId: 14,
    genotypeDigest: '565f8c72',
    passiveGenotypeDigest: '09bb9a89',
    morphology: Object.freeze({
      family: 'hull',
      symmetric: false,
      axleCount: 3,
      wheelCount: 5,
      drivenWheelCount: 5,
      suspensionTypes: Object.freeze(['S1', 'S1', 'S1']),
      axleKinds: Object.freeze(['paired', 'paired', 'single']),
      massTotal: 431.5027306425247,
      powerBudget: 290.54619499947876,
      wheelRadii: Object.freeze([
        0.5440503113204613, 0.5440503113204613, 0.5633293132297694,
        0.5440503113204613, 0.5440503113204613,
      ]),
    }),
  }),
]);

// The characterization evaluation identity, COPY-DECLARED (never imported
// from scripts/characterize-population.js — the fixtures COPY-DECLARE
// ruling): composite terrain seed 20260727 with the widened flat start, all
// other knobs at TERRAIN_DEFAULTS; 300 fixed steps, deterministic flavor,
// spawn on the flat pad at x = -44, the policy drive target and wheel
// friction.
export const WITNESS_TERRAIN = Object.freeze({
  seed: 20260727,
  startFlatLength: 30,
  startBlendLength: 6,
});
export const WITNESS_SPEC = Object.freeze({
  deterministic: true,
  terrain: WITNESS_TERRAIN,
  maxSteps: 300,
  spawn: Object.freeze({ x: -44, z: 0 }),
  targetWheelSurfaceSpeed: 5,
  wheelFriction: 1,
});

function fail(what, value) {
  throw new Error(`explosion-witnesses: ${what} (${String(value)})`);
}

/** The house genotype fingerprint (the population-locks champion precedent). */
export function witnessDigest(genotype) {
  return fnv1aHex(serializeGenotype(genotype));
}

/**
 * Reconstruct one witness's canonical (repaired) genotype from its declared
 * population seed + individualId via the exact production path. With
 * `assertDigest` (the default), the reconstruction must match the committed
 * identity literal — a mismatch means the initializer/repair path changed
 * under the investigation and the contingency in the header applies.
 */
export function witnessGenotype(populationSeed, individualId, { assertDigest = true } = {}) {
  const entry = EXPLOSION_WITNESSES.find(
    (w) => w.populationSeed === populationSeed && w.individualId === individualId,
  );
  if (entry === undefined) fail('unknown witness', `${populationSeed}:${individualId}`);
  const raw = sampleInitialGenotype(new Rng(populationSeed).fork(individualId), {});
  const genotype = compileAssembly(raw).genotype;
  if (assertDigest) {
    const digest = witnessDigest(genotype);
    if (digest !== entry.genotypeDigest) {
      fail(
        `witness ${entry.label} (${populationSeed}:${individualId}) reconstruction drifted from the committed identity`,
        `measured ${digest}, committed ${entry.genotypeDigest} — see the materialization contingency in the module header`,
      );
    }
  }
  return genotype;
}

// Genotypes are plain JSON-safe data (the characterize-population idiom).
const deepClone = (o) => JSON.parse(JSON.stringify(o));

/**
 * The canonical zero-drive twin: every axle's `driven` gene zeroed, then
 * re-repaired. Repair never reads `driven`, so the twin stays canonical and
 * ONLY the drive torques collapse to 0 (verified by the identity test:
 * compiled twin has driveTorque 0 on every wheel).
 */
export function passiveTwinOf(genotype) {
  return repairGenotype({
    ...deepClone(genotype),
    axles: genotype.axles.map((a) => ({ ...deepClone(a), driven: 0 })),
  });
}

// --- The minimum reproducer (investigation verdict evidence) -------------------
//
// MATERIALIZED canonical genotype (a literal, not a reconstruction):
// derived from witness A's axles 2+5 (both S0), every gene rounded to two
// decimals, re-repaired — the values below INCLUDE repair's exact writes
// (radius/sizeBias carry repair's f64 output; never re-round them). It is the
// smallest configuration found that reproduces the finite explosion:
//
//   2 paired wide-track S0 axles (wheel centers z ~ +/-2.3 / +/-1.9 m),
//   4 UNDRIVEN wheels (8.8-22 kg), one 18 kg chassis (79 kg total),
//   NO motors, NO S1, on a completely FLAT corridor (craterDensity 0,
//   featureDensity 0, macroAmp 0, microAmp 0) at the standard spawn
//   => catastrophic (>1000 m/s body speeds) by step ~46 of 300,
//      IDENTICALLY on both Rapier 0.19.3 flavors.
//
// Measured stabilizers — removing ANY single ingredient abolishes the event
// (the necessary/sufficient closure; docs/physics-integrity-finite-explosion-
// report-2026-07-13.md carries the full matrix):
//   - either axle alone (every single-module arm is stable),
//   - trackHalf genes <= ~0.2 (short lateral anchor arms),
//   - frameDensity 1 (a ~160 kg chassis instead of 18 kg).
// Gravity 9.81 vs 20, drive, dt 1/120, CCD on/off, and terrain content do
// NOT change the classification.
//
// RERUN ON RAPIER BUMP:
//   npm run probe:physics-explosion -- --pass reproducer
// (identity is a hard check; the onset is an OBSERVATION — if a future
// engine converges this island, the probe reports the disappearance and the
// engine-limitation ruling is re-evaluated; no committed test asserts the
// explosion occurs.)
export const MINIMAL_REPRODUCER = Object.freeze({
  label: 'R',
  genotypeDigest: '9fde1f1c',
  terrainOverrides: Object.freeze({
    craterDensity: 0, featureDensity: 0, macroAmp: 0, microAmp: 0,
  }),
  genotype: Object.freeze({
    version: 1,
    hue: 0.2,
    symmetric: 0.22,
    power: 0.19,
    frameDensity: 0.09,
    frame: Object.freeze({
      family: 0.18,
      segments: Object.freeze([Object.freeze({
        nodeCount: 0.13,
        nodes: Object.freeze([
          Object.freeze({ gap: 0.72, height: 0.19, halfWidth: 0.32, thickness: 0.71 }),
          Object.freeze({ gap: 0.19, height: 0.07, halfWidth: 0.37, thickness: 0.51 }),
          Object.freeze({ gap: 0.71, height: 0.34, halfWidth: 0.79, thickness: 0.3 }),
          Object.freeze({ gap: 0.95, height: 0.83, halfWidth: 0.42, thickness: 0.19 }),
          Object.freeze({ gap: 0.86, height: 0.42, halfWidth: 0.16, thickness: 0.29 }),
          Object.freeze({ gap: 0.6, height: 0.29, halfWidth: 0.88, thickness: 0.87 }),
        ]),
        fam: Object.freeze({
          spine: Object.freeze({ beamWidthFrac: 0.76 }),
          ladder: Object.freeze({ crossFrac: 0.02 }),
          hull: Object.freeze({ bulge: 0.34 }),
        }),
      })]),
    }),
    axles: Object.freeze([
      Object.freeze({
        posX01: 1,
        paired: 0.94,
        trackHalf: 0.76,
        radius: 0.2140000000000001,
        width: 0.33,
        density: 0.03,
        suspType: 0.27,
        stiffness: 0.54,
        damping: 0.95,
        travel: 0.69,
        restLength: 0.35,
        driven: 0.02,
        share: 0.9,
        asym: Object.freeze({ driveBias: 0.86, sizeBias: 0.5000000000000001, centerOffset: 0.1 }),
      }),
      Object.freeze({
        posX01: 1,
        paired: 0.6,
        trackHalf: 0.6,
        radius: 0.29,
        width: 0.74,
        density: 0.04,
        suspType: 0.21,
        stiffness: 0.47,
        damping: 0.49,
        travel: 0.89,
        restLength: 0.53,
        driven: 0.26,
        share: 0.17,
        asym: Object.freeze({ driveBias: 0.89, sizeBias: 0.49, centerOffset: 0.52 }),
      }),
    ]),
  }),
});

/** The reproducer genotype as mutable plain data (compile/repair inputs). */
export function reproducerGenotype() {
  return deepClone(MINIMAL_REPRODUCER.genotype);
}
