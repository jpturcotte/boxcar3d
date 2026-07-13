// The declared committed population fixture — the cross-environment
// population/fitness contract's subject. Deliberate documented divergence
// from the evaluation fixtures' literal-genes COPY-DECLARE style: here the
// GENERATOR is the artifact under lock (the initializer draw table), so the
// fixture declares seeds + config literals and the tests assert the
// resulting structural mix; spawn y is computed per member by
// spawnPoseOnFlatStart (pinned by the fixtures'-literal reproduction tooth
// and by the fitness-vector/champion-trace digests).
//
// SEED-SELECTION DISCIPLINE (recorded in the Phase-1A report): the
// population seed was scanned against PURELY STRUCTURAL heterogeneity
// criteria — both suspension types, >= 2 frame families, paired AND single
// modules, symmetric AND asymmetric individuals, >= 1 repair-changed raw
// draw, mixed wheel counts. Champion fitness, median fitness, rollback,
// zero-fitness fraction, and any notion of "evolutionary promise" were
// FORBIDDEN selection criteria: the lock covers code paths, it does not
// advertise a lucky starting population.
//
// A fixture-version bump is required for ANY change to the seeds, config,
// terrain, spawn, step budget, or drive target below.

import { createInitialPopulation } from './population-initializer.js';

export const POPULATION_FIXTURE_A = Object.freeze({
  name: 'population-a-initial-composite',
  version: 1,
  description: 'The generation-0 contract population: 20 individuals from the live initializer at the declared seed, evaluated per-individual on the composite corridor (craters, features, zones all on).',
  populationSeed: 20260721,
  populationConfig: Object.freeze({
    populationSize: 20, // the SALVAGE tuned default
    minAxles: 1,
    maxAxles: 6,
    symmetricProbability: 0.8,
    initialSuspensionTypes: Object.freeze(['S0', 'S1']),
    minInitialPowerGene: 0,
  }),
  terrainConfig: Object.freeze({
    seed: 20260722,
    startFlatLength: 30, // pad x ∈ [−60, −30]; blend to −24; composite beyond
    startBlendLength: 6,
    // Every other knob DELIBERATELY left at TERRAIN_DEFAULTS — composite ON
    // (the fixture-B convention): the locked fitness vector attests
    // real-corridor behavior, and the browser gate transitively re-proves
    // the composite paths through the population evaluator.
  }),
  spawn: Object.freeze({ x: -44, z: 0 }), // >= 4 m inside the pad both ways
  targetWheelSurfaceSpeed: 5, // == MOTOR_TARGET_WHEEL_SURFACE_SPEED, declared as a literal so the fixture is self-contained
  maxSteps: 300, // 5 s of sim time — enough to reach the blend and the composite field
});

/**
 * Build the fixture's evaluation inputs fresh: the initialization (owning
 * provenance + diagnostics), its canonical population, and the evaluation
 * spec. Deterministic flavor is the fixture's declared contract flavor —
 * fixed, not an option (F10: the default flavor is never locked).
 */
export function populationEvaluationInputsFor(fixture, { keepRaw = false } = {}) {
  if (!fixture || typeof fixture.populationSeed !== 'number' || !fixture.populationConfig) {
    throw new Error(`population-fixtures: not a population fixture (${String(fixture && fixture.name)})`);
  }
  const initialization = createInitialPopulation(
    { seed: fixture.populationSeed, ...fixture.populationConfig },
    { keepRaw },
  );
  return {
    initialization,
    population: initialization.population,
    spec: {
      terrain: { ...fixture.terrainConfig },
      maxSteps: fixture.maxSteps,
      deterministic: true,
      spawn: { ...fixture.spawn },
      targetWheelSurfaceSpeed: fixture.targetWheelSurfaceSpeed,
    },
  };
}
