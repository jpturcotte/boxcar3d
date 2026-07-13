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
