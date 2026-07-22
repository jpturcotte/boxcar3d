// The declared committed evolution fixture — the subject of the cross-runtime
// identity locks (Node on three OSes, plus pinned Chromium).
//
// SIZING DISCIPLINE. This fixture is deliberately SMALL and fast, because it
// runs in every determinism job and in a real browser. It is not a scientific
// experiment and it does not advertise a promising run: PR 4 owns the empirical
// work. What it must do is EXERCISE THE MECHANISM — and the exercise is
// declared, not hoped for. Three evaluated, persisted generations means:
//   - generation 0 is initialized (all-initialized lineage, no parents);
//   - generations 1 and 2 are derived, so elite copying, tournament selection,
//     child-id allocation, parametric mutation, and lineage accounting all
//     appear in a committed record;
//   - the final record is TERMINAL (generationLimitReached), so the terminal
//     encoding and terminal-record chaining are locked too.
// The determinism gate asserts each of those structural properties, so a
// fixture change that silently stopped covering one of them fails rather than
// quietly narrowing what the locks prove.
//
// TERRAIN: exactly-flat start pad with craters and features OFF. The physics
// realism is not the subject; a short deterministic settle is. The composite
// paths are already covered by the population fixture's own gates.
//
// A FIXTURE-VERSION BUMP is required for ANY change to the seeds, config,
// terrain, spawn, step budget, generation count, or mutation parameters below.

export const EVOLUTION_FIXTURE_A = Object.freeze({
  name: 'evolution-a-small-flat',
  version: 1,
  description: 'Three evaluated generations of six individuals on the flat start pad: initialized generation 0, two derived generations with elites and mutated children, terminating on the generation limit.',
  populationSeed: 20260742,
  terrainSeed: 20260743,
  populationSize: 6,
  maxGenerations: 3,
  maxSteps: 45,
  // Declared as literals rather than imported from PARAMETRIC_MUTATION_DEFAULTS
  // so the fixture is self-contained: PR 4 may deliberately retune the
  // defaults, and that must not silently re-point this fixture at new numbers.
  mutationProbability: 0.05,
  mutationMagnitude: 0.05,
  spawn: Object.freeze({ x: -44, z: 0 }),
  terrainConfig: Object.freeze({
    seed: 20260743,
    startFlatLength: 30, // pad x ∈ [−60, −30]; spawn sits ≥ 4 m inside both ends
    startBlendLength: 6,
    craterDensity: 0,
    featureDensity: 0,
  }),
});

/**
 * Build the fixture's `createEvolutionRun` config fresh. Deterministic flavor
 * is the fixture's declared contract flavor — fixed, never an option (F10: the
 * default flavor is never locked).
 */
export function evolutionRunConfigFor(fixture) {
  if (!fixture || typeof fixture.populationSeed !== 'number' || !fixture.terrainConfig) {
    throw new Error(`evolution-fixtures: not an evolution fixture (${String(fixture && fixture.name)})`);
  }
  return {
    initialization: {
      seed: fixture.populationSeed,
      populationSize: fixture.populationSize,
    },
    evaluationSpec: {
      terrain: { ...fixture.terrainConfig },
      maxSteps: fixture.maxSteps,
      deterministic: true,
      spawn: { ...fixture.spawn },
    },
    evolution: {
      maxGenerations: fixture.maxGenerations,
      mutation: {
        probability: fixture.mutationProbability,
        magnitude: fixture.mutationMagnitude,
      },
    },
  };
}
