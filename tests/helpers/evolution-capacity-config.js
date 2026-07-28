// THE SHARED AUTHORITATIVE CAPACITY TEST INPUT.
//
// One declaration site for the exact population seed, terrain seed and
// evaluation specification shared by the fresh-run capacity boundary tests
// (tests/evolution-run.test.js), the forged-capacity artifact tests and the
// relational capacity check (tests/evolution-capacity.test.js).
//
// This is the shared INPUT only. The capacity ORACLE — the exact
// maximumFeasibleGenerations boundary — is deliberately NOT declared here:
// tests/evolution-run.test.js pins it as an independent literal through the
// public creation gate, and the forged artifact re-establishes it the same
// way. Keep it that way.

export const CAPACITY_POPULATION_SEED = 20260740;
export const CAPACITY_TERRAIN_SEED = 20260741;

// A small, fast, exactly-flat evaluation: craters and features off, a short
// step budget. Physics realism is not the subject here — engine mechanics
// are. Fresh nested objects per call: no shared mutable test state.
export function createCapacityEvaluationSpec() {
  return {
    terrain: {
      seed: CAPACITY_TERRAIN_SEED,
      startFlatLength: 30,
      startBlendLength: 6,
      craterDensity: 0,
      featureDensity: 0,
    },
    maxSteps: 45,
    deterministic: true,
    spawn: { x: -44, z: 0 },
  };
}
