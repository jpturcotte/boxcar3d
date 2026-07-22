// The deterministic evolution engine's contract: configuration, the
// same-source transition, fresh globally-unique ids, lineage, PRNG ownership,
// terminal precedence, atomicity, and trace exclusion.
//
// THE OBSERVATION SEAM. The run is deliberately opaque — no public method
// returns the pending population, the evaluation, the pool, or lineage rows —
// so this suite observes the engine where it MUST be observable anyway: at the
// physics boundary. `population-evaluation.js` is mocked as a PASS-THROUGH
// spy, which hands each generation's population to the test exactly as the
// engine hands it to physics. Nothing about the engine's behaviour changes;
// the test simply watches what it evaluates. That same spy is the private-seam
// failure injector the atomicity cases need.
//
// The strongest tooth here is EXTERNAL REPRODUCTION: every mutated child of
// generation 1 is rebuilt outside the engine from `new Rng(seed).fork(childId)`
// and the public PR 2 operators, and must be byte-identical. That proves the
// child's stream derivation, the exact draw ORDER (tournament's three uint32
// draws, then one nextFloat decision per eligible continuous leaf and one more
// per selected leaf), and the exact draw COUNT at once — a single extra or
// missing draw shifts every later value and the genome stops matching.
//
// Seeds declared: population 20260740, terrain 20260741 (both allocated by
// this PR; see the seed register in CLAUDE.md).

import {
  describe, test, expect, vi, beforeEach,
} from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// The pass-through spy. `globalThis.__evolutionProbe` is the control channel
// (a mock factory is hoisted and cannot close over test-scope variables, but
// it can read a global at call time). Default behaviour is the real module,
// statement for statement.
vi.mock('../src/sim/population-evaluation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    evaluatePopulation: async (population, spec) => {
      const probe = globalThis.__evolutionProbe;
      if (probe) {
        probe.populations.push(population);
        probe.specs.push(spec);
        if (probe.failAtCall !== null && probe.populations.length === probe.failAtCall) {
          throw new Error('injected evaluation failure');
        }
      }
      const evaluation = await original.evaluatePopulation(population, spec);
      if (probe) {
        probe.evaluations.push(evaluation);
        if (probe.forceUnselectable || probe.selectableCount !== null) {
          // Rebuild the evaluation with every member unselectable — the only
          // way to reach `noSelectableParents` without waiting for physics to
          // produce a whole generation of integrity failures.
          const selectableCount = probe.forceUnselectable ? 0 : probe.selectableCount;
          const individuals = evaluation.individuals.map((ind, index) => (index < selectableCount
            ? { ...ind, fitness: probe.tieFitness ? 1 : ind.fitness, valid: true }
            : { ...ind, fitness: 0, valid: false }));
          const forced = { ...evaluation, individuals };
          const bytes = original.serializeFitnessVector(forced);
          forced.fitnessVector = { bytes, digest: null };
          return forced;
        }
      }
      return evaluation;
    },
  };
});

vi.mock('../src/platform/sha256.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    sha256: async (bytes) => {
      const probe = globalThis.__evolutionProbe;
      if (probe?.failHistoryDigest) {
        let prefix = '';
        const count = Math.min(bytes.length, 48);
        for (let i = 0; i < count; i += 1) prefix += String.fromCharCode(bytes[i]);
        if (prefix.startsWith('boxcar3d/evolution-history/history/v1\0')) {
          throw new Error('injected late history digest failure');
        }
      }
      return original.sha256(bytes);
    },
  };
});

const { createEvolutionRun, resumeEvolutionRun, TERMINAL_REASONS } = await import('../src/sim/evolution-run.js');
const {
  EvolutionError, MAX_EVOLUTION_EVALUATION_WORK, MAX_EVOLUTION_GENERATIONS,
  MAX_EVOLUTION_POPULATION_SIZE, checkedAdd, checkedMultiply,
} = await import('../src/sim/evolution-contract.js');
const { ELITE_COUNT, PARAMETRIC_MUTATION_DEFAULTS, mutateContinuousGenotype } = await import('../src/sim/evolution-operators.js');
const { serializeGenotype } = await import('../src/sim/assembly.js');
const { Rng } = await import('../src/sim/prng.js');
const { bytesToHex } = await import('../src/sim/bytes.js');
const { serializePopulationSnapshot } = await import('../src/sim/population.js');
const { deserializePopulationInitialization } = await import('../src/sim/population-initializer.js');
const { deserializeEvaluationSpec } = await import('../src/sim/population-evaluation.js');
const { deserializeLineage } = await import('../src/sim/evolution-lineage.js');
const {
  COMPONENT_KINDS, decodeEvolutionHeader, decodeGenerationPayload, decodeHistoryFraming,
  deserializeEvaluationMetadata, digestComponent, digestGeneration, digestHeader,
  digestHistoryBody, digestsEqual,
} = await import('../src/sim/evolution-history.js');

const POPULATION_SEED = 20260740;
const TERRAIN_SEED = 20260741;
const POPULATION_SIZE = 6;

// A small, fast, exactly-flat evaluation: craters and features off, a short
// step budget. Physics realism is not the subject here — engine mechanics are.
const SPEC = Object.freeze({
  terrain: Object.freeze({
    seed: TERRAIN_SEED,
    startFlatLength: 30,
    startBlendLength: 6,
    craterDensity: 0,
    featureDensity: 0,
  }),
  maxSteps: 45,
  deterministic: true,
  spawn: Object.freeze({ x: -44, z: 0 }),
});

const config = (overrides = {}) => ({
  initialization: { seed: POPULATION_SEED, populationSize: POPULATION_SIZE, ...(overrides.initialization ?? {}) },
  evaluationSpec: { ...SPEC, terrain: { ...SPEC.terrain }, spawn: { ...SPEC.spawn }, ...(overrides.evaluationSpec ?? {}) },
  evolution: { maxGenerations: 3, ...(overrides.evolution ?? {}) },
});

function startProbe(options = {}) {
  const probe = {
    populations: [],
    specs: [],
    evaluations: [],
    failAtCall: options.failAtCall ?? null,
    failHistoryDigest: options.failHistoryDigest ?? false,
    forceUnselectable: options.forceUnselectable ?? false,
    selectableCount: options.selectableCount ?? null,
    tieFitness: options.tieFitness ?? false,
  };
  globalThis.__evolutionProbe = probe;
  return probe;
}

beforeEach(() => { globalThis.__evolutionProbe = undefined; });

// The probe observes populations at EVALUATION time, so generation N+1 is only
// visible after the advance that evaluates it. `advanceTo(run, n)` runs enough
// advances that `probe.populations[n]` exists.
async function advanceTo(run, generationIndex) {
  for (let i = 0; i <= generationIndex; i += 1) {
    const result = await run.advance();
    if (result.kind === 'terminal' && i < generationIndex) {
      throw new Error(`run terminated at generation ${result.committedGenerationIndex} (${result.reason}) before reaching ${generationIndex}`);
    }
  }
}

// An AdvanceResult carries a FRESH 32-byte history digest alongside its
// scalars; this asserts the scalars and the digest's shape/freshness together,
// so no case has to restate the digest expectation.
function expectAdvance(result, expected) {
  const { historyDigestBytes, ...scalars } = result;
  expect(scalars).toEqual(expected);
  expect(historyDigestBytes).toBeInstanceOf(Uint8Array);
  expect(historyDigestBytes.length).toBe(32);
  expect(Object.isFrozen(result)).toBe(true);
  return result;
}

const idsOf = (population) => population.individuals.map((i) => i.individualId);
const genotypeHex = (genotype) => Array.from(serializeGenotype(genotype))
  .map((b) => b.toString(16).padStart(2, '0')).join('');

function expectCode(fn, code, re) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  expect(threw, `expected a throw with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}

// ============================================================================
// (1) CREATION AND CONFIGURATION
// ============================================================================

describe('run creation validates the complete configuration', () => {
  test('a valid config creates a ready run with generation 0 pending and no history', () => {
    const run = createEvolutionRun(config());
    const status = run.status();
    expect(status.phase).toBe('ready');
    expect(status.lastCommittedGenerationIndex).toBeNull();
    expect(status.pendingGenerationIndex).toBe(0);
    expect(status.terminalReason).toBeNull();
    expect(status.historyAvailable).toBe(false);
    expect(status.populationSize).toBe(POPULATION_SIZE);
    expect(Object.isFrozen(status)).toBe(true);
  });

  test.each([
    ['a missing top-level key', () => { const c = config(); delete c.evolution; return c; }],
    ['an unknown top-level key', () => ({ ...config(), extra: 1 })],
    ['a non-object config', () => 42],
    ['null', () => null],
    ['an array config', () => []],
    ['an unknown initialization key', () => config({ initialization: { unknown: 1 } })],
    ['an unknown evolution key', () => config({ evolution: { unknown: 1 } })],
    ['a non-integer maxGenerations', () => config({ evolution: { maxGenerations: 2.5 } })],
    ['maxGenerations 0', () => config({ evolution: { maxGenerations: 0 } })],
    ['a non-uint32 seed', () => config({ initialization: { seed: -1 } })],
    ['a fractional seed', () => config({ initialization: { seed: 1.5 } })],
    ['populationSize 0', () => config({ initialization: { populationSize: 0 } })],
    ['an unknown mutation key', () => config({ evolution: { maxGenerations: 2, mutation: { rate: 0.1 } } })],
    ['a mutation probability above 1', () => config({ evolution: { maxGenerations: 2, mutation: { probability: 1.5 } } })],
    ['a NaN mutation magnitude', () => config({ evolution: { maxGenerations: 2, mutation: { magnitude: NaN } } })],
  ])('%s is refused as invalidConfig', (_name, build) => {
    expectCode(() => createEvolutionRun(build()), 'invalidConfig');
  });

  test('the evolution population ceiling is enforced BEFORE the initializer allocates', () => {
    const err = expectCode(
      () => createEvolutionRun(config({ initialization: { populationSize: MAX_EVOLUTION_POPULATION_SIZE + 1 } })),
      'resourceLimitExceeded', /MAX_EVOLUTION_POPULATION_SIZE/,
    );
    expect(err.context.limit).toBe(MAX_EVOLUTION_POPULATION_SIZE);
    // …and the ceiling is far below the initializer's own 1e6 heap guard, so
    // this is an evolution-specific policy, not a re-statement of that one.
    expect(MAX_EVOLUTION_POPULATION_SIZE).toBeLessThan(1000000);
  });

  test('the generation ceiling is enforced at creation', () => {
    expectCode(
      () => createEvolutionRun(config({ evolution: { maxGenerations: MAX_EVOLUTION_GENERATIONS + 1 } })),
      'resourceLimitExceeded', /MAX_EVOLUTION_GENERATIONS/,
    );
  });

  test('a legal but history-infeasible configuration is rejected before physics', () => {
    const probe = startProbe();
    const err = expectCode(
      () => createEvolutionRun(config({
        initialization: { populationSize: MAX_EVOLUTION_POPULATION_SIZE },
        evolution: { maxGenerations: MAX_EVOLUTION_GENERATIONS },
      })),
      'resourceLimitExceeded', /history.*MAX_EVOLUTION_HISTORY_BYTES/i,
    );
    expect(err.context.projectedBytes).toBeGreaterThan(err.context.limit);
    expect(err.context.maximumFeasibleGenerations).toBeLessThan(MAX_EVOLUTION_GENERATIONS);
    expect(probe.populations).toHaveLength(0);
  });

  test('a practical 20-member campaign remains legal at the generation ceiling', () => {
    const run = createEvolutionRun(config({
      initialization: { populationSize: 20 },
      evolution: { maxGenerations: MAX_EVOLUTION_GENERATIONS },
    }));
    expect(run.status()).toMatchObject({
      phase: 'ready', populationSize: 20, maxGenerations: MAX_EVOLUTION_GENERATIONS,
    });
  });

  test('the population × step compute budget rejects before initialization or physics', () => {
    const populationSize = 6;
    const maxSteps = Math.floor(MAX_EVOLUTION_EVALUATION_WORK / populationSize) + 1;
    const probe = startProbe();
    expectCode(
      () => createEvolutionRun(config({
        initialization: { populationSize },
        evaluationSpec: { maxSteps },
      })),
      'resourceLimitExceeded', /MAX_EVOLUTION_EVALUATION_WORK/,
    );
    expect(probe.populations).toHaveLength(0);
  });

  test('an evaluationSpec carrying a `hooks` key is refused — even empty, even undefined', () => {
    for (const hooks of [{}, undefined, { onIndividual: () => {} }]) {
      const c = config();
      c.evaluationSpec.hooks = hooks;
      expectCode(() => createEvolutionRun(c), 'invalidConfig', /hook-free/);
    }
  });

  test('a non-deterministic spec is refused (evolution binds one engine identity)', () => {
    const c = config();
    c.evaluationSpec.deterministic = false;
    expectCode(() => createEvolutionRun(c), 'invalidConfig', /deterministic must be true/);
  });

  test('a config object mutated AFTER creation cannot change what runs', async () => {
    const c = config();
    const run = createEvolutionRun(c);
    c.initialization.seed = 999;
    c.evaluationSpec.maxSteps = 4321;
    c.evaluationSpec.terrain.seed = 999;
    c.evolution.maxGenerations = 99;
    const probe = startProbe();
    await run.advance();
    expect(probe.specs[0].maxSteps).toBe(SPEC.maxSteps);
    expect(probe.specs[0].terrain.seed).toBe(TERRAIN_SEED);
    // The population is generation 0 of the ORIGINAL seed: ids 0..N-1 and the
    // same genomes a fresh run at the original config produces.
    expect(idsOf(probe.populations[0])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(run.status().maxGenerations).toBe(3);
  });

  test('a non-plain or non-enumerable-carrying config container is refused', () => {
    const withProto = Object.create({ initialization: {} });
    expectCode(() => createEvolutionRun(withProto), 'invalidConfig', /plain object/);
    const hidden = config();
    Object.defineProperty(hidden.initialization, 'seed', { value: 7, enumerable: false });
    expectCode(() => createEvolutionRun(hidden), 'invalidConfig', /non-enumerable/);
  });
});

// ============================================================================
// (2) THE TRANSITION: IDS, ELITES, CHILDREN, LINEAGE
// ============================================================================

describe('the generation transition', () => {
  test.each([
    [1, 1],
    [2, 1],
    [3, 2],
    [6, 3],
  ])('population %i with %i tied selectable parents composes elites and children correctly', async (populationSize, selectableCount) => {
    const probe = startProbe({ selectableCount, tieFitness: true });
    const run = createEvolutionRun(config({
      initialization: { populationSize },
      evolution: { maxGenerations: 3 },
    }));
    await run.advance();
    await run.advance();

    const nextPopulation = probe.populations[1];
    expect(nextPopulation.individuals.map((row) => row.individualId))
      .toEqual(Array.from({ length: populationSize }, (_, i) => populationSize + i));

    const framing = decodeHistoryFraming(run.historyBytes());
    const generation = decodeGenerationPayload(framing.generations[1].payloadBytes);
    const lineage = deserializeLineage(generation.components.lineage);
    const eliteCount = Math.min(ELITE_COUNT, selectableCount, populationSize);
    expect(lineage.individuals).toHaveLength(populationSize);
    expect(lineage.individuals.slice(0, eliteCount).map((row) => row.origin))
      .toEqual(Array(eliteCount).fill('eliteCopy'));
    expect(lineage.individuals.slice(eliteCount).map((row) => row.origin))
      .toEqual(Array(populationSize - eliteCount).fill('continuousMutation'));
    expect(lineage.individuals.slice(0, eliteCount).map((row) => row.parentIndividualId))
      .toEqual(Array.from({ length: eliteCount }, (_, i) => i));
    for (const row of lineage.individuals.slice(eliteCount)) {
      expect(row.parentIndividualId).toBeGreaterThanOrEqual(0);
      expect(row.parentIndividualId).toBeLessThan(selectableCount);
    }
  });

  test('generation 0 evaluates ids 0..N-1 — the initializer fork stream ids', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config());
    await run.advance();
    expect(idsOf(probe.populations[0])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('every later generation receives a FRESH contiguous ascending id block; nothing is ever reused', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 4 } }));
    await run.advance();
    await run.advance();
    await run.advance();
    expect(idsOf(probe.populations[0])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(idsOf(probe.populations[1])).toEqual([6, 7, 8, 9, 10, 11]);
    expect(idsOf(probe.populations[2])).toEqual([12, 13, 14, 15, 16, 17]);
    const seen = new Set();
    for (const population of probe.populations) {
      for (const id of idsOf(population)) {
        expect(seen.has(id), `id ${id} was reused across generations`).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(18);
  });

  test('elites are copied FIRST, byte-identical, and receive fresh ids', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config());
    await advanceTo(run, 1);
    const gen0 = probe.populations[0];
    const gen1 = probe.populations[1];
    const evaluation = probe.evaluations[0];
    // The pool's canonical rank: greater fitness, then lower individualId.
    const ranked = evaluation.individuals
      .filter((i) => i.valid && i.integrityStatus === 'ok')
      .slice()
      .sort((a, b) => (b.fitness - a.fitness) || (a.individualId - b.individualId));
    const expectedElites = ranked.slice(0, ELITE_COUNT);
    expect(expectedElites.length).toBe(ELITE_COUNT); // the fixture must exercise elitism
    expectedElites.forEach((row, slot) => {
      const source = gen0.individuals.find((i) => i.individualId === row.individualId);
      expect(genotypeHex(gen1.individuals[slot].genotype)).toBe(genotypeHex(source.genotype));
      // A fresh id, and NOT the parent's.
      expect(gen1.individuals[slot].individualId).toBe(POPULATION_SIZE + slot);
      expect(gen1.individuals[slot].individualId).not.toBe(row.individualId);
    });
  });

  test('every mutated child is reproducible EXACTLY from (seed, childId) outside the engine', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config());
    await advanceTo(run, 1);
    const gen0 = probe.populations[0];
    const gen1 = probe.populations[1];
    const evaluation = probe.evaluations[0];
    const pool = {
      selectionPoolVersion: 1,
      fitnessPolicyVersion: evaluation.fitnessPolicyVersion,
      populationSnapshotDigestState: evaluation.populationSnapshotDigestState,
      evaluatedIndividualIds: evaluation.individuals.map((i) => i.individualId).sort((a, b) => a - b),
      individuals: evaluation.individuals
        .filter((i) => i.valid && i.integrityStatus === 'ok')
        .map((i) => ({ individualId: i.individualId, fitness: i.fitness })),
    };
    const { selectTournamentParent } = await import('../src/sim/evolution-operators.js');
    let reproduced = 0;
    for (let slot = ELITE_COUNT; slot < POPULATION_SIZE; slot += 1) {
      const childId = POPULATION_SIZE + slot;
      // The engine's exact stream derivation, replicated: one fork per child,
      // tournament first, then mutation on the SAME stream.
      const rng = new Rng(POPULATION_SEED).fork(childId);
      const parentId = selectTournamentParent(pool, rng);
      const parent = gen0.individuals.find((i) => i.individualId === parentId);
      const child = mutateContinuousGenotype(parent.genotype, rng, PARAMETRIC_MUTATION_DEFAULTS);
      expect(gen1.individuals[slot].individualId).toBe(childId);
      expect(genotypeHex(gen1.individuals[slot].genotype)).toBe(genotypeHex(child.genotype));
      reproduced += 1;
    }
    expect(reproduced).toBe(POPULATION_SIZE - ELITE_COUNT);
  });

  test('a child stream does not depend on how many generations the run will do', async () => {
    // No generation-global RNG: the same (seed, childId) means the same child
    // whether the run stops at 2 generations or 4.
    const short = startProbe();
    await advanceTo(createEvolutionRun(config({ evolution: { maxGenerations: 2 } })), 1);
    const shortGen1 = short.populations[1].individuals.map((i) => genotypeHex(i.genotype));
    const long = startProbe();
    await advanceTo(createEvolutionRun(config({ evolution: { maxGenerations: 4 } })), 1);
    const longGen1 = long.populations[1].individuals.map((i) => genotypeHex(i.genotype));
    expect(shortGen1).toEqual(longGen1);
  });

  test('two runs with identical configs evaluate identical generations', async () => {
    const a = startProbe();
    const runA = createEvolutionRun(config());
    await runA.advance();
    await runA.advance();
    const aHex = a.populations.map((p) => p.individuals.map((i) => genotypeHex(i.genotype)));
    const b = startProbe();
    const runB = createEvolutionRun(config());
    await runB.advance();
    await runB.advance();
    const bHex = b.populations.map((p) => p.individuals.map((i) => genotypeHex(i.genotype)));
    expect(bHex).toEqual(aHex);
  });

  test('mutation defaults are the PR 2 provisional baseline unless overridden', async () => {
    expect(PARAMETRIC_MUTATION_DEFAULTS.probability).toBe(0.05);
    expect(PARAMETRIC_MUTATION_DEFAULTS.magnitude).toBe(0.05);
    // A different magnitude must produce different children (the resolved
    // value really reaches the operator).
    const base = startProbe();
    await advanceTo(createEvolutionRun(config()), 1);
    const baseHex = base.populations[1].individuals.map((i) => genotypeHex(i.genotype));
    const tuned = startProbe();
    await advanceTo(createEvolutionRun(config({
      evolution: { maxGenerations: 3, mutation: { probability: 1, magnitude: 0.4 } },
    })), 1);
    const tunedHex = tuned.populations[1].individuals.map((i) => genotypeHex(i.genotype));
    // Elites are copies and stay identical; children must differ.
    expect(tunedHex.slice(0, ELITE_COUNT)).toEqual(baseHex.slice(0, ELITE_COUNT));
    expect(tunedHex.slice(ELITE_COUNT)).not.toEqual(baseHex.slice(ELITE_COUNT));
  });
});

// ============================================================================
// (3) TERMINALS
// ============================================================================

describe('terminal precedence and finalization', () => {
  test('the wire enum is the copy-declared order (the index IS the encoded byte)', () => {
    expect([...TERMINAL_REASONS]).toEqual([
      'none', 'noSelectableParents', 'generationLimitReached', 'individualIdExhausted',
    ]);
  });

  test('generationLimitReached fires on the record that satisfies maxGenerations', async () => {
    startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    expectAdvance(await run.advance(), { kind: 'advanced', committedGenerationIndex: 0, nextGenerationIndex: 1 });
    expectAdvance(await run.advance(), { kind: 'advanced', committedGenerationIndex: 1, nextGenerationIndex: 2 });
    expectAdvance(await run.advance(), { kind: 'terminal', committedGenerationIndex: 2, reason: 'generationLimitReached' });
    expect(run.status().phase).toBe('terminal');
    expect(run.status().pendingGenerationIndex).toBeNull();
  });

  test('maxGenerations 1 terminates on generation 0 — one evaluated, persisted record', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 1 } }));
    expectAdvance(await run.advance(), { kind: 'terminal', committedGenerationIndex: 0, reason: 'generationLimitReached' });
    expect(probe.populations.length).toBe(1); // no next generation was ever derived
  });

  test('an empty selectable pool is terminal — never a diagnostic-champion substitution', async () => {
    const probe = startProbe({ forceUnselectable: true });
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 5 } }));
    expectAdvance(await run.advance(), { kind: 'terminal', committedGenerationIndex: 0, reason: 'noSelectableParents' });
    expect(probe.populations.length).toBe(1);
    expect(run.status().terminalReason).toBe('noSelectableParents');
  });

  test('noSelectableParents OUTRANKS generationLimitReached', async () => {
    // Both conditions hold at generation 0 with maxGenerations 1; precedence
    // says the empty pool wins, because it describes WHY there is no successor.
    startProbe({ forceUnselectable: true });
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 1 } }));
    expect((await run.advance()).reason).toBe('noSelectableParents');
  });

  test('a terminal run repeats its terminal result and never appends a second record', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 1 } }));
    const first = await run.advance();
    const again = await run.advance();
    const third = await run.advance();
    const scalars = ({ historyDigestBytes: _digest, ...rest }) => rest;
    expect(scalars(again)).toEqual(scalars(first));
    expect(scalars(third)).toEqual(scalars(first));
    // The digest is a fresh COPY each time, with identical content: a repeated
    // terminal reports the same artifact, it does not re-derive one.
    expect(again.historyDigestBytes).not.toBe(first.historyDigestBytes);
    expect([...again.historyDigestBytes]).toEqual([...first.historyDigestBytes]);
    expect(probe.populations.length).toBe(1); // no further evaluation happened
  });

  test('individualIdExhausted is unreachable under the v1 caps, and the checked arithmetic stays', () => {
    // 256 * 1024 ids is nine orders below 2^32 — the enum exists so a future
    // cap change fails SAFE rather than wrapping an id.
    expect(MAX_EVOLUTION_POPULATION_SIZE * MAX_EVOLUTION_GENERATIONS).toBeLessThan(2 ** 32);
    expect(TERMINAL_REASONS.includes('individualIdExhausted')).toBe(true);
    expectCode(() => checkedAdd(Number.MAX_SAFE_INTEGER, 1, 'probe'), 'resourceLimitExceeded');
    expectCode(() => checkedMultiply(2 ** 40, 2 ** 20, 'probe'), 'resourceLimitExceeded');
    expectCode(() => checkedAdd(1.5, 1, 'probe'), 'resourceLimitExceeded');
    expectCode(() => checkedAdd(-1, 1, 'probe'), 'resourceLimitExceeded');
  });
});

// ============================================================================
// (4) ATOMICITY, RETRY, CONCURRENCY
// ============================================================================

describe('draft/commit atomicity', () => {
  test('a failed advance leaves the run byte-identically where it was, and a retry succeeds identically', async () => {
    const control = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    await run.advance(); // generation 0 commits
    const before = run.status();
    // Fail the SECOND evaluation this run performs.
    control.failAtCall = control.populations.length + 1;
    await expect(run.advance()).rejects.toThrow(/injected evaluation failure/);
    const after = run.status();
    expect(after).toEqual(before);
    expect(after.phase).toBe('ready');
    expect(after.lastCommittedGenerationIndex).toBe(0);
    expect(after.pendingGenerationIndex).toBe(1);
    // Retry: no mutable RNG state was committed, so the retry must produce the
    // same generation the failed attempt would have.
    control.failAtCall = null;
    expectAdvance(await run.advance(), { kind: 'advanced', committedGenerationIndex: 1, nextGenerationIndex: 2 });
    const retryHex = control.populations.at(-1).individuals.map((i) => genotypeHex(i.genotype));
    // A clean reference run must agree generation for generation.
    const reference = startProbe();
    const clean = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    await clean.advance();
    await clean.advance();
    const referenceHex = reference.populations.at(-1).individuals.map((i) => genotypeHex(i.genotype));
    expect(retryHex).toEqual(referenceHex);
  });

  test('a failure on the very first advance leaves the run with no history at all', async () => {
    const control = startProbe({ failAtCall: 1 });
    const run = createEvolutionRun(config());
    await expect(run.advance()).rejects.toThrow(/injected evaluation failure/);
    expect(run.status().historyAvailable).toBe(false);
    expect(run.status().lastCommittedGenerationIndex).toBeNull();
    expect(run.status().phase).toBe('ready');
    control.failAtCall = null;
    expect((await run.advance()).committedGenerationIndex).toBe(0);
  });

  test('a late history-digest failure commits no draft bytes and retries identically', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    await run.advance();
    const beforeStatus = run.status();
    const beforeBytes = bytesToHex(run.historyBytes());

    probe.failHistoryDigest = true;
    await expect(run.advance()).rejects.toThrow(/injected late history digest failure/);
    expect(run.status()).toEqual(beforeStatus);
    expect(bytesToHex(run.historyBytes())).toBe(beforeBytes);

    probe.failHistoryDigest = false;
    await run.advance();
    const retriedBytes = bytesToHex(run.historyBytes());

    startProbe();
    const clean = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    await clean.advance();
    await clean.advance();
    expect(retriedBytes).toBe(bytesToHex(clean.historyBytes()));
  });

  test('a concurrent advance fails with advanceInProgress and does not disturb the draft', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    const first = run.advance();
    expectCode(() => run.advance(), 'advanceInProgress');
    expectAdvance(await first, { kind: 'advanced', committedGenerationIndex: 0, nextGenerationIndex: 1 });
    // Exactly one evaluation happened — the rejected call did no work.
    expect(probe.populations.length).toBe(1);
    // …and the run is usable afterwards, at the state the first call left.
    expect((await run.advance()).committedGenerationIndex).toBe(1);
  });
});

// ============================================================================
// (4b) THE COMMITTED HISTORY — the byte-level view of the same transition
// ============================================================================
//
// Sections 2-3 observe the engine at the physics boundary. This one observes it
// at the ARTIFACT boundary and requires the two to agree: the population bytes
// in generation N's record must be exactly the population that was evaluated,
// and the lineage rows must describe exactly the elites and children that were
// produced. A transition that got the right physics and wrote the wrong record
// would pass section 2 and fail here.

describe('the committed history artifact', () => {
  test.each([
    [0, 1, 'none-selected'],
    [1, 0, 'selected-no-delta'],
    [1, 1, 'selected-with-delta'],
  ])('mutation boundary p=%s magnitude=%s persists and resumes (%s)', async (probability, magnitude, mode) => {
    startProbe();
    const run = createEvolutionRun(config({
      evolution: { maxGenerations: 3, mutation: { probability, magnitude } },
    }));
    await run.advance();
    const firstFraming = decodeHistoryFraming(run.historyBytes());
    const header = decodeEvolutionHeader(firstFraming.headerBytes);
    expect(Object.is(header.mutationProbability, probability)).toBe(true);
    expect(Object.is(header.mutationMagnitude, magnitude)).toBe(true);

    const resumed = await resumeEvolutionRun(run.historyBytes());
    await run.advance();
    await resumed.advance();
    expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(run.historyBytes()));

    const framing = decodeHistoryFraming(run.historyBytes());
    const generation = decodeGenerationPayload(framing.generations[1].payloadBytes);
    const lineage = deserializeLineage(generation.components.lineage);
    const mutated = lineage.individuals.filter((row) => row.origin === 'continuousMutation');
    expect(mutated.length).toBeGreaterThan(0);
    const selected = mutated.reduce((sum, row) => sum + row.accounting.selectedLeafCount, 0);
    const eligible = mutated.reduce((sum, row) => sum + row.accounting.eligibleContinuousLeafCount, 0);
    const deltas = mutated.reduce((sum, row) => sum + row.accounting.finalByteDeltaCount, 0);
    if (mode === 'none-selected') expect({ selected, deltas }).toEqual({ selected: 0, deltas: 0 });
    if (mode === 'selected-no-delta') expect({ selected, eligible, deltas }).toEqual({ selected: eligible, eligible, deltas: 0 });
    if (mode === 'selected-with-delta') {
      expect(selected).toBe(eligible);
      expect(selected).toBeGreaterThan(0);
      // Delta accounting is byte-based, while selection accounting is leaf-based.
      expect(deltas).toBeGreaterThan(0);
    }
  });

  test('historyBytes() throws historyUnavailable before the first advance, and status says so without throwing', () => {
    const run = createEvolutionRun(config());
    expect(run.status().historyAvailable).toBe(false);
    expectCode(() => run.historyBytes(), 'historyUnavailable');
  });

  test('historyBytes() returns a FRESH copy every call — never the internal buffer', async () => {
    startProbe();
    const run = createEvolutionRun(config());
    await run.advance();
    const a = run.historyBytes();
    const b = run.historyBytes();
    expect(a).not.toBe(b);
    expect(a.buffer).not.toBe(b.buffer);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    // Mutating a returned copy cannot corrupt the run's own artifact.
    a[0] ^= 0xff;
    expect(bytesToHex(run.historyBytes())).toBe(bytesToHex(b));
  });

  test('the header binds runtime identity, the resolved mutation NUMBERS, and every operator version', async () => {
    startProbe();
    const run = createEvolutionRun(config({
      evolution: { maxGenerations: 3, mutation: { probability: 0.25, magnitude: 0.125 } },
    }));
    await run.advance();
    const framing = decodeHistoryFraming(run.historyBytes());
    const header = decodeEvolutionHeader(framing.headerBytes);
    expect(header.physicsFlavor).toBe('deterministicCompat');
    expect(header.packageName).toBe('@dimforge/rapier3d-deterministic-compat');
    expect(header.rapierVersion.length).toBeGreaterThan(0);
    expect(header.populationSize).toBe(POPULATION_SIZE);
    expect(header.maxGenerations).toBe(3);
    // The resolved numeric values, not "the defaults" — a future change to
    // PARAMETRIC_MUTATION_DEFAULTS must not rewrite an old artifact's meaning.
    expect(Object.is(header.mutationProbability, 0.25)).toBe(true);
    expect(Object.is(header.mutationMagnitude, 0.125)).toBe(true);
    expect(header.tournamentSize).toBe(3);
    expect(header.eliteCount).toBe(ELITE_COUNT);
    // The embedded manifest and spec decode through their own codecs.
    const manifest = deserializePopulationInitialization(header.initializationManifestBytes);
    expect(manifest.seed).toBe(POPULATION_SEED);
    expect(manifest.config.populationSize).toBe(POPULATION_SIZE);
    const spec = deserializeEvaluationSpec(header.evaluationSpecBytes);
    expect(spec.deterministic).toBe(true);
    expect(spec.maxSteps).toBe(SPEC.maxSteps);
    expect(spec.terrain.seed).toBe(TERRAIN_SEED);
  });

  test('records are contiguous from 0, non-terminal until the last, and the last carries the reason', async () => {
    startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    let result;
    do { result = await run.advance(); } while (result.kind !== 'terminal');
    const framing = decodeHistoryFraming(run.historyBytes());
    expect(framing.generations.length).toBe(3);
    framing.generations.forEach((g, i) => {
      const payload = decodeGenerationPayload(g.payloadBytes);
      expect(payload.generationIndex).toBe(i);
      expect(payload.terminalReason).toBe(i === 2 ? 'generationLimitReached' : 'none');
    });
  });

  test('each record embeds EXACTLY the population that was evaluated', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    let result;
    do { result = await run.advance(); } while (result.kind !== 'terminal');
    const framing = decodeHistoryFraming(run.historyBytes());
    expect(probe.populations.length).toBe(3);
    framing.generations.forEach((g, i) => {
      const payload = decodeGenerationPayload(g.payloadBytes);
      const evaluated = serializePopulationSnapshot(probe.populations[i]);
      expect(bytesToHex(payload.components.population), `generation ${i}`).toBe(bytesToHex(evaluated));
    });
  });

  test('the evaluation-metadata component preserves the determinism evidence fitness drops', async () => {
    startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 1 } }));
    await run.advance();
    const framing = decodeHistoryFraming(run.historyBytes());
    const payload = decodeGenerationPayload(framing.generations[0].payloadBytes);
    const metadata = deserializeEvaluationMetadata(payload.components.evaluationMetadata);
    expect(metadata.worldMode).toBe('isolatedWorlds');
    expect(metadata.executedSteps).toBe(SPEC.maxSteps);
    // The engine's f32 timestep readback — the exact value the existing
    // evaluation locks bind, carried here because the fitness vector does not.
    expect(metadata.effectiveDt).toBe(Math.fround(1 / 60));
  });

  test('LINEAGE: generation 0 is all-initialized with zero counters and no parent', async () => {
    startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 1 } }));
    await run.advance();
    const framing = decodeHistoryFraming(run.historyBytes());
    const payload = decodeGenerationPayload(framing.generations[0].payloadBytes);
    const lineage = deserializeLineage(payload.components.lineage);
    expect(lineage.generationIndex).toBe(0);
    expect(lineage.individuals.map((r) => r.individualId)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const row of lineage.individuals) {
      expect(row.origin).toBe('initialized');
      expect(row.parentIndividualId).toBeNull();
      for (const key of Object.keys(row.accounting)) expect(row.accounting[key]).toBe(0);
    }
  });

  test('LINEAGE: generation 1 is elites-then-children, with real parents and real accounting', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 2 } }));
    await run.advance();
    await run.advance();
    const framing = decodeHistoryFraming(run.historyBytes());
    const payload = decodeGenerationPayload(framing.generations[1].payloadBytes);
    const lineage = deserializeLineage(payload.components.lineage);
    expect(lineage.generationIndex).toBe(1);
    expect(lineage.individuals.map((r) => r.individualId)).toEqual([6, 7, 8, 9, 10, 11]);
    const gen0Ids = new Set(idsOf(probe.populations[0]));
    lineage.individuals.forEach((row, slot) => {
      // Every parent existed in the PRECEDING generation.
      expect(gen0Ids.has(row.parentIndividualId), `row ${slot} parent ${row.parentIndividualId}`).toBe(true);
      if (slot < ELITE_COUNT) {
        expect(row.origin).toBe('eliteCopy');
        for (const key of Object.keys(row.accounting)) expect(row.accounting[key]).toBe(0);
      } else {
        expect(row.origin).toBe('continuousMutation');
        // A continuous-mutation row must attest a real walk of the schema.
        expect(row.accounting.eligibleContinuousLeafCount).toBeGreaterThan(0);
      }
    });
  });

  test('LINEAGE accounting matches the operator EXACTLY, reproduced outside the engine', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 2 } }));
    await run.advance();
    await run.advance();
    const framing = decodeHistoryFraming(run.historyBytes());
    const lineage = deserializeLineage(
      decodeGenerationPayload(framing.generations[1].payloadBytes).components.lineage,
    );
    const gen0 = probe.populations[0];
    const evaluation = probe.evaluations[0];
    const pool = {
      selectionPoolVersion: 1,
      fitnessPolicyVersion: evaluation.fitnessPolicyVersion,
      populationSnapshotDigestState: evaluation.populationSnapshotDigestState,
      evaluatedIndividualIds: evaluation.individuals.map((i) => i.individualId).sort((a, b) => a - b),
      individuals: evaluation.individuals
        .filter((i) => i.valid && i.integrityStatus === 'ok')
        .map((i) => ({ individualId: i.individualId, fitness: i.fitness })),
    };
    const { selectTournamentParent } = await import('../src/sim/evolution-operators.js');
    for (let slot = ELITE_COUNT; slot < POPULATION_SIZE; slot += 1) {
      const childId = POPULATION_SIZE + slot;
      const rng = new Rng(POPULATION_SEED).fork(childId);
      const parentId = selectTournamentParent(pool, rng);
      const parent = gen0.individuals.find((i) => i.individualId === parentId);
      const { accounting } = mutateContinuousGenotype(parent.genotype, rng, PARAMETRIC_MUTATION_DEFAULTS);
      const row = lineage.individuals[slot];
      expect(row.parentIndividualId).toBe(parentId);
      for (const key of Object.keys(accounting)) {
        expect(row.accounting[key], `child ${childId} ${key}`).toBe(accounting[key]);
      }
    }
  });

  test('the generation chain and history digest verify from the header, over the whole artifact', async () => {
    startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    let result;
    do { result = await run.advance(); } while (result.kind !== 'terminal');
    const bytes = run.historyBytes();
    const framing = decodeHistoryFraming(bytes);
    // Header digest.
    expect(digestsEqual(await digestHeader(framing.headerBytes), framing.headerDigestBytes)).toBe(true);
    // Component digests, per record.
    for (const g of framing.generations) {
      const payload = decodeGenerationPayload(g.payloadBytes);
      for (const kind of COMPONENT_KINDS) {
        expect(digestsEqual(
          await digestComponent(kind, payload.components[kind]), payload.componentDigests[kind],
        ), kind).toBe(true);
      }
    }
    // The chain, from the header forward.
    let previous = framing.headerDigestBytes;
    for (let i = 0; i < framing.generations.length; i += 1) {
      const expected = await digestGeneration(previous, framing.generations[i].payloadBytes);
      expect(digestsEqual(expected, framing.generations[i].generationDigestBytes), `chain ${i}`).toBe(true);
      previous = framing.generations[i].generationDigestBytes;
    }
    // The whole-history digest, and the value advance() handed back.
    expect(digestsEqual(await digestHistoryBody(framing.body), framing.historyDigestBytes)).toBe(true);
    expect(bytesToHex(result.historyDigestBytes)).toBe(bytesToHex(framing.historyDigestBytes));
  });

  test('two runs with identical configs produce BYTE-IDENTICAL history', async () => {
    startProbe();
    const a = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    let r; do { r = await a.advance(); } while (r.kind !== 'terminal');
    startProbe();
    const b = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    do { r = await b.advance(); } while (r.kind !== 'terminal');
    expect(bytesToHex(b.historyBytes())).toBe(bytesToHex(a.historyBytes()));
  });

  test('a failed advance leaves the committed history BYTE-IDENTICAL', async () => {
    const control = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 3 } }));
    await run.advance();
    const before = bytesToHex(run.historyBytes());
    control.failAtCall = control.populations.length + 1;
    await expect(run.advance()).rejects.toThrow(/injected evaluation failure/);
    expect(bytesToHex(run.historyBytes())).toBe(before);
  });

  test('a terminal run does not append a second record on repeated advance()', async () => {
    startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 1 } }));
    await run.advance();
    const after = bytesToHex(run.historyBytes());
    await run.advance();
    await run.advance();
    expect(bytesToHex(run.historyBytes())).toBe(after);
    expect(decodeHistoryFraming(run.historyBytes()).generations.length).toBe(1);
  });
});

// ============================================================================
// (5) TRACE EXCLUSION — the Commit 0 policy premise, as a build failure
// ============================================================================

describe('trace exclusion (PR 3 Commit 0 policy premise)', () => {
  const EVOLUTION_MODULES = readdirSync('src/sim')
    .filter((name) => name.startsWith('evolution-') && name.endsWith('.js'))
    .map((name) => `src/sim/${name}`);

  test('the evolution module family is non-empty and imports no trace module', () => {
    expect(EVOLUTION_MODULES.length).toBeGreaterThan(0);
    for (const file of EVOLUTION_MODULES) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/^\s*import[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
      const offenders = imports.filter((s) => /trace/.test(s));
      expect(offenders, `${file} must not import a trace module`).toEqual([]);
      // …and no dynamic back door either.
      expect(/import\(\s*['"][^'"]*trace/.test(source), `${file} dynamic trace import`).toBe(false);
    }
  });

  test('the one physics seam evaluates at trace mode none', () => {
    // The engine's only physics call is `evaluatePopulation`, which hard-codes
    // the mode. Asserted on the SOURCE because the option never surfaces in
    // any value the engine can see — which is precisely the property being
    // claimed.
    const source = readFileSync('src/sim/population-evaluation.js', 'utf8');
    expect(source).toMatch(/trace:\s*\{\s*mode:\s*'none'\s*\}/);
    expect(source.match(/trace:\s*\{/g).length).toBe(1);
  });

  test('at runtime, the evaluation the engine consumes carries no trace evidence', async () => {
    const probe = startProbe();
    const run = createEvolutionRun(config({ evolution: { maxGenerations: 1 } }));
    await run.advance();
    const evaluation = probe.evaluations[0];
    for (const key of ['trace', 'records', 'checkpoints']) {
      expect(Object.prototype.hasOwnProperty.call(evaluation, key), `evaluation.${key}`).toBe(false);
    }
    for (const individual of evaluation.individuals) {
      expect(Object.prototype.hasOwnProperty.call(individual, 'trace')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(individual.diagnostics, 'trace')).toBe(false);
    }
  });
});
