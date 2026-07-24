// THE HISTORY-CAPACITY REFUSAL BOUNDARY — a public production gate that
// fitness vector v3 MOVED.
//
// `createEvolutionRun` projects the worst legal artifact a configuration could
// produce and refuses one that could not fit under the 64 MiB ceiling, so a
// campaign cannot wedge halfway through. That projection is driven by
// `fitnessVectorByteLength(populationSize)`, and v3 grew a member from 14 to 48
// bytes — so configurations that were accepted before this PR are now refused.
//
// That is CORRECT (the projection tracks the real format; a gate that did not
// move would be the bug), but it is a change to a public entry point that no
// committed literal pinned. These are the literals.
//
// THE VALUES ARE INDEPENDENTLY DECLARED, not computed from the helper under
// test: each is a measured constant of this branch, obtained by bisecting
// `createEvolutionRun` itself. Deriving them from `fitnessVectorByteLength`
// would let the geometry and the expectation move together and stay green —
// exactly the drift this file exists to catch.
//
// Physics-free: `createEvolutionRun` is synchronous and validates before it
// builds generation 0, so nothing here creates a world.
//
// Seeds declared: population 20260740, terrain 20260741.

import { describe, test, expect } from 'vitest';
import { createEvolutionRun } from '../src/sim/evolution-run.js';
import { MAX_EVOLUTION_GENERATIONS, EvolutionError } from '../src/sim/evolution-contract.js';

const POPULATION_SEED = 20260740;
const TERRAIN_SEED = 20260741;

// The canonical configuration these boundaries belong to. Any change to the
// terrain knobs or maxSteps changes the encoded evaluation spec and therefore
// the header size, which moves the boundary — so the configuration is declared
// here in full rather than shared with a suite that might edit it.
const config = (populationSize, maxGenerations) => ({
  initialization: { seed: POPULATION_SEED, populationSize },
  evaluationSpec: {
    terrain: {
      seed: TERRAIN_SEED, startFlatLength: 30, startBlendLength: 6, craterDensity: 0, featureDensity: 0,
    },
    maxSteps: 45,
    deterministic: true,
    spawn: { x: -44, z: 0 },
  },
  evolution: { maxGenerations },
});

// MEASURED ON THIS BRANCH under the configuration above. Before v3 these read
// 940 and 235 respectively (the design record records the movement).
const BOUNDARY = Object.freeze([
  Object.freeze({ populationSize: 64, maximumFeasibleGenerations: 912 }),
  Object.freeze({ populationSize: 256, maximumFeasibleGenerations: 228 }),
]);

describe('history-capacity refusal boundary (fitness vector v3)', () => {
  test.each(BOUNDARY)(
    'population $populationSize accepts exactly $maximumFeasibleGenerations generations',
    ({ populationSize, maximumFeasibleGenerations }) => {
      expect(() => createEvolutionRun(config(populationSize, maximumFeasibleGenerations)))
        .not.toThrow();
    },
  );

  test.each(BOUNDARY)(
    'population $populationSize refuses one generation past $maximumFeasibleGenerations',
    ({ populationSize, maximumFeasibleGenerations }) => {
      let threw = null;
      try {
        createEvolutionRun(config(populationSize, maximumFeasibleGenerations + 1));
      } catch (e) { threw = e; }
      expect(threw, 'one past the boundary must be refused').toBeInstanceOf(EvolutionError);
      expect(threw.code).toBe('resourceLimitExceeded');
      // The reported number is the actionable part: it tells a caller what to
      // ask for instead, so it is asserted as a value, not merely as present.
      expect(threw.context.maximumFeasibleGenerations).toBe(maximumFeasibleGenerations);
    },
  );

  test('at small populations the GENERATION CAP binds first, not capacity', () => {
    // Population 20 — the size every committed fixture uses — is nowhere near
    // the byte ceiling, so its limit is the declared `MAX_EVOLUTION_GENERATIONS`
    // and v3 did not move it. Without this, "the boundary moved" could be read
    // as "every configuration got smaller".
    expect(() => createEvolutionRun(config(20, MAX_EVOLUTION_GENERATIONS))).not.toThrow();
    let threw = null;
    try { createEvolutionRun(config(20, MAX_EVOLUTION_GENERATIONS + 1)); } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(EvolutionError);
    // Both refusals share the `resourceLimitExceeded` code, so the code alone
    // cannot tell them apart. The CONTEXT can, and that is the discriminator
    // worth pinning: the declared cap reports the requested value against the
    // constant, while the capacity projection reports projected bytes and the
    // feasible generation count. (An earlier draft of this test asserted
    // `invalidConfig` here, on an assumption rather than a measurement.)
    expect(threw.code).toBe('resourceLimitExceeded');
    expect(threw.message).toMatch(/MAX_EVOLUTION_GENERATIONS/);
    expect(threw.context).toMatchObject({ maxGenerations: MAX_EVOLUTION_GENERATIONS + 1 });
    expect(threw.context.maximumFeasibleGenerations,
      'the cap is not the capacity projection').toBeUndefined();
    expect(threw.context.projectedBytes).toBeUndefined();
  });

  test('the boundary is MONOTONE in population size', () => {
    // A relational property the literals above cannot express on their own: a
    // bigger population must never be allowed MORE generations. If a future
    // change inverted the projection, both literals could be updated and stay
    // consistent while the gate had become nonsense.
    const [small, large] = BOUNDARY;
    expect(large.populationSize).toBeGreaterThan(small.populationSize);
    expect(large.maximumFeasibleGenerations)
      .toBeLessThan(small.maximumFeasibleGenerations);
  });
});
