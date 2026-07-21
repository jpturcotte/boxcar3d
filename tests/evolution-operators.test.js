import { describe, expect, test } from 'vitest';
import {
  compileAssembly, forEachGenotypeField, repairGenotype, serializeGenotype,
} from '../src/sim/assembly.js';
import {
  ELITE_COUNT, ELITISM_VERSION, PARAMETRIC_MUTATION_DEFAULTS, PARAMETRIC_MUTATION_VERSION,
  TOURNAMENT_SELECTION_VERSION, TOURNAMENT_SIZE, mutateContinuousGenotype,
  selectElites, selectTournamentParent,
} from '../src/sim/evolution-operators.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from '../src/sim/fnv1a.js';
import { POPULATION_SNAPSHOT_VERSION, serializePopulationSnapshot } from '../src/sim/population.js';
import {
  FITNESS_POLICY_VERSION, SELECTION_POOL_VERSION, selectablePoolFromEvaluation,
} from '../src/sim/population-evaluation.js';
import {
  POPULATION_FIXTURE_A, populationEvaluationInputsFor,
} from '../src/sim/population-fixtures.js';

function genotype(axles = 0) {
  const axle = () => ({
    posX01: 0.5, paired: 1, trackHalf: 0.5, radius: 0.5, width: 0.5, density: 0.5,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue: 0.5, symmetric: 1, power: 0.5, frameDensity: 0.5,
    frame: {
      family: 0, segments: [{ nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 })),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: Array.from({ length: axles }, axle),
  };
}

function canonical(axles = 0) { return compileAssembly(genotype(axles)).genotype; }
function pool(ids, individuals, state = 0) {
  return Object.freeze({
    selectionPoolVersion: SELECTION_POOL_VERSION,
    fitnessPolicyVersion: FITNESS_POLICY_VERSION,
    populationSnapshotDigestState: state,
    evaluatedIndividualIds: Object.freeze(ids),
    individuals: Object.freeze(individuals.map(Object.freeze)),
  });
}

function fieldRows(value) {
  const rows = [];
  forEachGenotypeField(value, (entry) => rows.push(entry));
  return rows;
}

function singleSelectedLeafRng(target, unit) {
  let leaf = 0;
  let deltaNext = false;
  return {
    nextFloat() {
      if (deltaNext) {
        deltaNext = false;
        return unit;
      }
      const selected = leaf === target;
      leaf += 1;
      if (selected) deltaNext = true;
      return selected ? 0 : 0.75;
    },
  };
}

describe('Phase 1B pure operators', () => {
  test('exports the literal Phase-1B policy constants', () => {
    expect([TOURNAMENT_SELECTION_VERSION, ELITISM_VERSION, PARAMETRIC_MUTATION_VERSION]).toEqual([1, 1, 1]);
    expect([TOURNAMENT_SIZE, ELITE_COUNT]).toEqual([3, 2]);
    expect(PARAMETRIC_MUTATION_DEFAULTS).toEqual({ probability: 0.05, magnitude: 0.05 });
  });

  test('makes a frozen eligible pool in id order from one evaluation', () => {
    const result = selectablePoolFromEvaluation({
      fitnessPolicyVersion: FITNESS_POLICY_VERSION,
      populationSnapshotDigestState: 7,
      individuals: [
      { individualId: 8, valid: true, integrityStatus: 'ok', fitness: 2 },
      { individualId: 3, valid: false, integrityStatus: 'ok', fitness: 0 },
      { individualId: 1, valid: true, integrityStatus: 'numericalDivergence', fitness: 0 },
      ],
    });
    expect(result).toEqual({
      selectionPoolVersion: 1,
      fitnessPolicyVersion: 2,
      populationSnapshotDigestState: 7,
      evaluatedIndividualIds: [1, 3, 8],
      individuals: [{ individualId: 8, fitness: 2 }],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.individuals[0])).toBe(true);
  });

  test('pool construction is order-independent, selectable-only, and owns retained scalars', () => {
    const rows = [
      { individualId: 21, valid: true, integrityStatus: 'ok', fitness: 4 },
      { individualId: 3, valid: false, integrityStatus: 'ok', fitness: 0 },
      { individualId: 13, valid: true, integrityStatus: 'numericalDivergence', fitness: 0 },
      { individualId: 8, valid: true, integrityStatus: 'ok', fitness: 9 },
    ];
    const forward = selectablePoolFromEvaluation({
      fitnessPolicyVersion: FITNESS_POLICY_VERSION, populationSnapshotDigestState: 19, individuals: rows,
    });
    const reverse = selectablePoolFromEvaluation({
      fitnessPolicyVersion: FITNESS_POLICY_VERSION,
      populationSnapshotDigestState: 19,
      individuals: [...rows].reverse(),
    });

    expect(forward).toEqual(reverse);
    expect(forward.evaluatedIndividualIds).toEqual([3, 8, 13, 21]);
    expect(forward.individuals).toEqual([
      { individualId: 8, fitness: 9 },
      { individualId: 21, fitness: 4 },
    ]);

    rows[0].individualId = 99;
    rows[0].fitness = 99;
    expect(forward.individuals[1]).toEqual({ individualId: 21, fitness: 4 });
    expect(Object.isFrozen(forward.evaluatedIndividualIds)).toBe(true);
    expect(Object.isFrozen(forward.individuals)).toBe(true);
  });

  test('pool construction rejects missing, stale, and future fitness policies', () => {
    const evaluation = {
      populationSnapshotDigestState: 19,
      individuals: [{ individualId: 3, valid: true, integrityStatus: 'ok', fitness: 1 }],
    };
    expect(() => selectablePoolFromEvaluation(evaluation)).toThrow(/fitnessPolicyVersion/);
    expect(() => selectablePoolFromEvaluation({ ...evaluation, fitnessPolicyVersion: 1 })).toThrow(/fitnessPolicyVersion/);
    expect(() => selectablePoolFromEvaluation({ ...evaluation, fitnessPolicyVersion: 3 })).toThrow(/fitnessPolicyVersion/);
  });

  test('pool construction captures getters once and ignores length growth after capture', () => {
    const reads = new Map();
    const once = (name, value, sideEffect) => ({
      enumerable: true,
      get() {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        sideEffect?.();
        return value;
      },
    });
    const rows = [];
    const row = {};
    Object.defineProperties(row, {
      individualId: once('individualId', 5, () => rows.push({
        individualId: 99, valid: true, integrityStatus: 'ok', fitness: 99,
      })),
      valid: once('valid', true),
      integrityStatus: once('integrityStatus', 'ok'),
      fitness: once('fitness', 7),
    });
    rows.push(row);
    const evaluation = {};
    Object.defineProperties(evaluation, {
      fitnessPolicyVersion: once('policy', FITNESS_POLICY_VERSION),
      populationSnapshotDigestState: once('digest', 23),
      individuals: once('individuals', rows),
    });

    expect(selectablePoolFromEvaluation(evaluation)).toEqual({
      selectionPoolVersion: 1,
      fitnessPolicyVersion: 2,
      populationSnapshotDigestState: 23,
      evaluatedIndividualIds: [5],
      individuals: [{ individualId: 5, fitness: 7 }],
    });
    expect(Object.fromEntries(reads)).toEqual({
      policy: 1, digest: 1, individuals: 1, individualId: 1, valid: 1, integrityStatus: 1, fitness: 1,
    });
    const sparse = [];
    sparse.length = 1;
    expect(() => selectablePoolFromEvaluation({
      fitnessPolicyVersion: FITNESS_POLICY_VERSION,
      populationSnapshotDigestState: 23,
      individuals: sparse,
    })).toThrow(/individuals\[0\]/);

    let lengthReads = 0;
    const proxiedRows = new Proxy([{
      individualId: 5, valid: true, integrityStatus: 'ok', fitness: 7,
    }], {
      get(target, key, receiver) {
        if (key === 'length') lengthReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(selectablePoolFromEvaluation({
      fitnessPolicyVersion: FITNESS_POLICY_VERSION,
      populationSnapshotDigestState: 23,
      individuals: proxiedRows,
    }).individuals).toEqual([{ individualId: 5, fitness: 7 }]);
    expect(lengthReads).toBe(1);
  });

  test('tournament uses three bound-receiver draws, replacement, and lowest-id ties', () => {
    let calls = 0;
    const rng = {
      marker: 9,
      nextUint32() {
        expect(this.marker).toBe(9);
        calls += 1;
        return [1, 0, 1][calls - 1];
      },
    };
    expect(selectTournamentParent(pool(
      [2, 7],
      [{ individualId: 2, fitness: 4 }, { individualId: 7, fitness: 4 }],
    ), rng)).toBe(2);
    expect(calls).toBe(3);
    let oneMemberCalls = 0;
    expect(selectTournamentParent(
      pool([2], [{ individualId: 2, fitness: 4 }]),
      { nextUint32() { oneMemberCalls += 1; return 0xffffffff; } },
    )).toBe(2);
    expect(oneMemberCalls).toBe(3);
    expect(selectTournamentParent(pool([2], []), {
      get nextUint32() { throw new Error('must not read'); },
    })).toBeNull();
  });

  test('tournament captures the pool before RNG access and rejects malformed draws and pools', () => {
    const mutablePool = {
      selectionPoolVersion: 1,
      fitnessPolicyVersion: 2,
      populationSnapshotDigestState: 1,
      evaluatedIndividualIds: [2, 7],
      individuals: [{ individualId: 2, fitness: 1 }, { individualId: 7, fitness: 9 }],
    };
    const rng = {
      get nextUint32() {
        mutablePool.individuals[0].fitness = 100;
        mutablePool.individuals[1].fitness = 0;
        return () => 1;
      },
    };
    expect(selectTournamentParent(mutablePool, rng)).toBe(7);

    for (const invalid of [-1, 2 ** 32, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0']) {
      expect(() => selectTournamentParent(
        pool([2], [{ individualId: 2, fitness: 1 }]),
        { nextUint32: () => invalid },
      )).toThrow(/nextUint32 draw 1/);
    }

    expect(() => selectTournamentParent({
      selectionPoolVersion: 1,
      fitnessPolicyVersion: 2,
      populationSnapshotDigestState: 1,
      evaluatedIndividualIds: [7, 2],
      individuals: [{ individualId: 2, fitness: 1 }],
    }, { nextUint32: () => 0 })).toThrow(/evaluatedIndividualIds\[1\]/);
    expect(() => selectTournamentParent(pool(
      [2],
      [{ individualId: 3, fitness: 1 }],
    ), { nextUint32: () => 0 })).toThrow(/not an evaluated id/);
  });

  test('pool consumers capture each caller array length exactly once', () => {
    let idLengthReads = 0;
    let rowLengthReads = 0;
    const ids = new Proxy([2, 7], {
      get(target, key, receiver) {
        if (key === 'length') idLengthReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const rows = new Proxy([
      { individualId: 2, fitness: 1 },
      { individualId: 7, fitness: 2 },
    ], {
      get(target, key, receiver) {
        if (key === 'length') rowLengthReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(selectTournamentParent({
      selectionPoolVersion: 1,
      fitnessPolicyVersion: 2,
      populationSnapshotDigestState: 1,
      evaluatedIndividualIds: ids,
      individuals: rows,
    }, { nextUint32: () => 1 })).toBe(7);
    expect(idLengthReads).toBe(1);
    expect(rowLengthReads).toBe(1);
  });

  test('pool consumers own evaluated IDs before reading the selectable rows property', () => {
    const callerIds = [2, 7];
    const hostilePool = {
      selectionPoolVersion: 1,
      fitnessPolicyVersion: 2,
      populationSnapshotDigestState: 1,
      get evaluatedIndividualIds() { return callerIds; },
      get individuals() {
        callerIds[0] = 99;
        return [{ individualId: 2, fitness: 1 }, { individualId: 7, fitness: 2 }];
      },
    };
    expect(selectTournamentParent(hostilePool, { nextUint32: () => 1 })).toBe(7);
  });

  test('elitism binds the exact canonical population bytes to the pool state', () => {
    const population = {
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      individuals: [{ individualId: 4, genotype: canonical() }, { individualId: 9, genotype: canonical(1) }],
    };
    const state = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population));
    const elites = selectElites(
      population,
      pool([4, 9], [{ individualId: 4, fitness: 2 }, { individualId: 9, fitness: 2 }], state),
    );
    expect(elites.map((x) => x.individualId)).toEqual([4, 9]);
    expect(serializeGenotype(elites[0].genotype)).toEqual(serializeGenotype(population.individuals[0].genotype));
    expect(() => selectElites(population, pool([4, 9], [], 1))).toThrow(/digest mismatch.*not cryptographic/i);
  });

  test('elitism returns zero, one, or two distinct selectable members without rewriting bytes', () => {
    const population = {
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      individuals: [
        { individualId: 2, genotype: canonical() },
        { individualId: 7, genotype: canonical(1) },
        { individualId: 11, genotype: canonical(2) },
      ],
    };
    const state = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population));
    const ids = [2, 7, 11];
    expect(selectElites(population, pool(ids, [], state))).toEqual([]);

    const one = selectElites(population, pool(ids, [{ individualId: 7, fitness: 3 }], state));
    expect(one.map(({ individualId }) => individualId)).toEqual([7]);
    expect(serializeGenotype(one[0].genotype)).toEqual(serializeGenotype(population.individuals[1].genotype));

    const many = selectElites(population, pool(ids, [
      { individualId: 2, fitness: 4 },
      { individualId: 7, fitness: 9 },
      { individualId: 11, fitness: 9 },
    ], state));
    expect(many.map(({ individualId }) => individualId)).toEqual([7, 11]);
    expect(serializeGenotype(many[0].genotype)).toEqual(serializeGenotype(population.individuals[1].genotype));
    expect(serializeGenotype(many[1].genotype)).toEqual(serializeGenotype(population.individuals[2].genotype));
    expect(Object.isFrozen(many)).toBe(true);
    expect(Object.isFrozen(many[0])).toBe(true);

    many[0].genotype.hue = 0.125;
    expect(population.individuals[1].genotype.hue).not.toBe(0.125);
    const repeated = selectElites(population, pool(ids, [
      { individualId: 2, fitness: 4 },
      { individualId: 7, fitness: 9 },
      { individualId: 11, fitness: 9 },
    ], state));
    expect(repeated[0].genotype.hue).not.toBe(0.125);
  });

  test('elitism rejects population and evaluated-id incoherence', () => {
    const population = {
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      individuals: [{ individualId: 2, genotype: canonical() }, { individualId: 7, genotype: canonical(1) }],
    };
    const state = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population));
    expect(() => selectElites(
      population,
      pool([2], [{ individualId: 2, fitness: 1 }], state),
    )).toThrow(/id mismatch/);
    expect(() => selectElites(
      population,
      pool([2, 8], [{ individualId: 2, fitness: 1 }], state),
    )).toThrow(/id mismatch/);
  });

  test('mutates every continuous leaf with the exact decision/delta schedule and owns outputs', () => {
    const parent = canonical(2);
    let eligible = 0;
    forEachGenotypeField(parent, (field) => {
      if (field.kind === 'continuous' && field.type === 'f64') eligible += 1;
    });
    const draws = [];
    const result = mutateContinuousGenotype(
      parent,
      { nextFloat() { draws.push(1); return 0.5; } },
      { probability: 1, magnitude: 0 },
    );
    expect(eligible).toBe(30 + 13 * 2);
    expect(draws).toHaveLength(eligible * 2);
    expect(result.accounting).toMatchObject({
      eligibleContinuousLeafCount: eligible,
      selectedLeafCount: eligible,
      rawChangedLeafCount: 0,
      clampedLeafCount: 0,
      rawByteDeltaCount: 0,
      finalByteDeltaCount: 0,
    });
    expect(serializeGenotype(result.rawGenotype)).toEqual(serializeGenotype(parent));
    expect(result.rawGenotype).not.toBe(result.genotype);
    parent.hue = -0;
    const signed = mutateContinuousGenotype(
      parent,
      { nextFloat: () => 0.5 },
      { probability: 0, magnitude: 0 },
    );
    expect(Object.is(signed.rawGenotype.hue, -0)).toBe(true);
    expect(Object.is(signed.genotype.hue, -0)).toBe(true);
    expect(() => mutateContinuousGenotype(
      parent,
      { nextFloat: () => 1 },
      { probability: 1 },
    )).toThrow(/draw 1/);
  });

  test('mutation distinguishes omitted options from explicit undefined and validates every own key', () => {
    const parent = canonical();
    const rng = { nextFloat: () => 0.5 };
    expect(() => mutateContinuousGenotype(parent, rng, undefined)).toThrow(/mutation options/);
    for (const options of [
      null,
      { probability: -0.01 },
      { probability: 1.01 },
      { probability: Number.NaN },
      { magnitude: -0.01 },
      { magnitude: 1.01 },
      { magnitude: Number.POSITIVE_INFINITY },
      { extra: 0 },
    ]) {
      expect(() => mutateContinuousGenotype(parent, rng, options)).toThrow(/mutation options/);
    }

    const hidden = { probability: 0, magnitude: 0 };
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false });
    expect(() => mutateContinuousGenotype(parent, rng, hidden)).toThrow(/mutation options key/);
    const symbol = { probability: 0, magnitude: 0, [Symbol('extra')]: 1 };
    expect(() => mutateContinuousGenotype(parent, rng, symbol)).toThrow(/mutation options key/);

    let omittedDraws = 0;
    const omitted = mutateContinuousGenotype(parent, {
      nextFloat() { omittedDraws += 1; return 0.5; },
    });
    expect(omitted.accounting.selectedLeafCount).toBe(0);
    expect(omittedDraws).toBe(omitted.accounting.eligibleContinuousLeafCount);
  });

  test('mutation applies defaults independently for empty and partial option records', () => {
    const parent = canonical();
    const parentBytes = serializeGenotype(parent);
    const none = mutateContinuousGenotype(
      parent,
      { nextFloat: () => 0 },
      { probability: 0 },
    );
    expect(none.accounting.selectedLeafCount).toBe(0);
    expect(serializeGenotype(none.rawGenotype)).toEqual(parentBytes);
    expect(serializeGenotype(none.genotype)).toEqual(parentBytes);

    const zeroMagnitude = mutateContinuousGenotype(
      parent,
      { nextFloat: () => 0 },
      { magnitude: 0 },
    );
    expect(zeroMagnitude.accounting.selectedLeafCount).toBe(
      zeroMagnitude.accounting.eligibleContinuousLeafCount,
    );
    expect(serializeGenotype(zeroMagnitude.rawGenotype)).toEqual(parentBytes);

    let draw = 0;
    const defaultMagnitude = mutateContinuousGenotype(parent, {
      nextFloat() { draw += 1; return draw % 2 === 1 ? 0 : 0.75; },
    }, { probability: 1 });
    expect(defaultMagnitude.rawGenotype.hue).toBe(parent.hue + 0.025);

    const empty = mutateContinuousGenotype(parent, { nextFloat: () => 0.5 }, {});
    expect(empty.accounting.selectedLeafCount).toBe(0);
  });

  test('mutation captures options once, then the parent, then the RNG method', () => {
    const events = [];
    const parent = canonical();
    const hue = parent.hue;
    Object.defineProperty(parent, 'hue', {
      enumerable: true,
      configurable: true,
      get() { events.push('parent'); return hue; },
    });
    const options = {};
    let probabilityReads = 0;
    let magnitudeReads = 0;
    Object.defineProperties(options, {
      probability: {
        enumerable: true,
        get() { probabilityReads += 1; events.push('options'); return 0; },
      },
      magnitude: {
        enumerable: true,
        get() { magnitudeReads += 1; return 0; },
      },
    });
    const rng = {
      get nextFloat() {
        events.push('rng');
        return () => 0.5;
      },
    };

    mutateContinuousGenotype(parent, rng, options);
    expect(probabilityReads).toBe(1);
    expect(magnitudeReads).toBe(1);
    expect(events.indexOf('options')).toBeLessThan(events.indexOf('parent'));
    expect(events.indexOf('parent')).toBeLessThan(events.indexOf('rng'));
  });

  test('mutation uses the declared signed-uniform interval and replays byte-identically', () => {
    const parent = canonical(1);
    const magnitude = 0.25;
    const lower = mutateContinuousGenotype(
      parent,
      singleSelectedLeafRng(0, 0),
      { probability: 0.5, magnitude },
    );
    expect(lower.rawGenotype.hue).toBe(parent.hue - magnitude);
    expect(lower.accounting).toMatchObject({
      selectedLeafCount: 1,
      rawChangedLeafCount: 1,
      clampedLeafCount: 0,
    });

    const upperUnit = 1 - Number.EPSILON;
    const expectedUpper = parent.hue + (2 * upperUnit - 1) * magnitude;
    const upperA = mutateContinuousGenotype(
      parent,
      singleSelectedLeafRng(0, upperUnit),
      { probability: 0.5, magnitude },
    );
    const upperB = mutateContinuousGenotype(
      parent,
      singleSelectedLeafRng(0, upperUnit),
      { probability: 0.5, magnitude },
    );
    expect(upperA.rawGenotype.hue).toBe(expectedUpper);
    expect(upperA.rawGenotype.hue).toBeLessThan(parent.hue + magnitude);
    const expectedUpperBytes = serializeGenotype(parent);
    new DataView(expectedUpperBytes.buffer, expectedUpperBytes.byteOffset, expectedUpperBytes.byteLength)
      .setFloat64(2, expectedUpper, true);
    expect(serializeGenotype(upperA.rawGenotype)).toEqual(expectedUpperBytes);
    expect(serializeGenotype(upperA.rawGenotype)).toEqual(serializeGenotype(upperB.rawGenotype));
    expect(serializeGenotype(upperA.genotype)).toEqual(serializeGenotype(upperB.genotype));
    expect(upperA.accounting).toEqual(upperB.accounting);
  });

  test('nonzero mutation covers latent continuous leaves and preserves the full excluded-byte schema', () => {
    const parent = canonical(1);
    const parentBefore = serializeGenotype(parent);
    let draw = 0;
    const result = mutateContinuousGenotype(parent, {
      nextFloat() {
        draw += 1;
        return draw % 2 === 1 ? 0 : 0.75;
      },
    }, { probability: 1, magnitude: 0.02 });
    const parentFields = fieldRows(parent);
    const rawFields = fieldRows(result.rawGenotype);
    const finalFields = fieldRows(result.genotype);
    const rawBytes = serializeGenotype(result.rawGenotype);
    const finalBytes = serializeGenotype(result.genotype);

    expect(result.accounting.selectedLeafCount).toBe(result.accounting.eligibleContinuousLeafCount);
    expect(result.rawGenotype.frame.segments[0].fam.ladder.crossFrac).not.toBe(
      parent.frame.segments[0].fam.ladder.crossFrac,
    );
    expect(result.rawGenotype.axles[0].asym.driveBias).not.toBe(parent.axles[0].asym.driveBias);
    expect(parentFields.map(({ path, type, kind, byteOffset, byteLength }) => (
      { path, type, kind, byteOffset, byteLength }
    ))).toEqual(rawFields.map(({ path, type, kind, byteOffset, byteLength }) => (
      { path, type, kind, byteOffset, byteLength }
    )));
    expect(parentFields.map(({ path, type, kind, byteOffset, byteLength }) => (
      { path, type, kind, byteOffset, byteLength }
    ))).toEqual(finalFields.map(({ path, type, kind, byteOffset, byteLength }) => (
      { path, type, kind, byteOffset, byteLength }
    )));

    for (const entry of parentFields) {
      if (entry.kind === 'continuous' && entry.type === 'f64') {
        expect(finalFields.find(({ path }) => path === entry.path).value).toBeGreaterThanOrEqual(0);
        expect(finalFields.find(({ path }) => path === entry.path).value).toBeLessThanOrEqual(1);
        continue;
      }
      const start = entry.byteOffset;
      const end = start + entry.byteLength;
      expect(rawBytes.slice(start, end), `${entry.path} raw bytes`).toEqual(parentBefore.slice(start, end));
      expect(finalBytes.slice(start, end), `${entry.path} final bytes`).toEqual(parentBefore.slice(start, end));
    }
    expect(serializeGenotype(parent)).toEqual(parentBefore);
    expect(serializeGenotype(repairGenotype(result.genotype))).toEqual(finalBytes);
  });

  test('clamping is counted even when the selected raw value remains at its boundary', () => {
    const parent = canonical();
    parent.hue = 0;
    const result = mutateContinuousGenotype(
      parent,
      singleSelectedLeafRng(0, 0),
      { probability: 0.5, magnitude: 1 },
    );
    expect(result.rawGenotype.hue).toBe(0);
    expect(result.accounting).toMatchObject({
      selectedLeafCount: 1,
      rawChangedLeafCount: 0,
      clampedLeafCount: 1,
      finalChangedLeafCount: 0,
    });
  });

  test('a selected zero delta preserves the canonical signed-zero bits', () => {
    const parent = canonical();
    parent.hue = -0;
    const parentBytes = serializeGenotype(parent);
    const result = mutateContinuousGenotype(
      parent,
      singleSelectedLeafRng(0, 0.5),
      { probability: 0.5, magnitude: 0.2 },
    );
    expect(Object.is(result.rawGenotype.hue, -0)).toBe(true);
    expect(Object.is(result.genotype.hue, -0)).toBe(true);
    expect(serializeGenotype(result.rawGenotype)).toEqual(parentBytes);
    expect(serializeGenotype(result.genotype)).toEqual(parentBytes);
    expect(result.accounting).toMatchObject({
      selectedLeafCount: 1,
      rawChangedLeafCount: 0,
      finalChangedLeafCount: 0,
      rawByteDeltaCount: 0,
      finalByteDeltaCount: 0,
    });
  });

  test('repair accounting exactly partitions introduced, erased, and redirected changes', () => {
    const { population } = populationEvaluationInputsFor(POPULATION_FIXTURE_A);
    const parent = population.individuals[0].genotype;
    const options = { probability: 0.5, magnitude: 1 };

    const introduced = mutateContinuousGenotype(parent, singleSelectedLeafRng(4, 0.999999), options);
    expect(introduced.accounting).toMatchObject({
      selectedLeafCount: 1,
      rawChangedLeafCount: 1,
      clampedLeafCount: 1,
      repairChangedLeafCount: 11,
      repairIntroducedLeafCount: 11,
      repairErasedLeafCount: 0,
      repairRedirectedLeafCount: 0,
      finalChangedLeafCount: 12,
      rawByteDeltaCount: 5,
      finalByteDeltaCount: 81,
    });

    const erased = mutateContinuousGenotype(parent, singleSelectedLeafRng(2, 0.999999), options);
    expect(erased.accounting).toMatchObject({
      selectedLeafCount: 1,
      rawChangedLeafCount: 1,
      clampedLeafCount: 1,
      repairChangedLeafCount: 1,
      repairIntroducedLeafCount: 0,
      repairErasedLeafCount: 1,
      repairRedirectedLeafCount: 0,
      finalChangedLeafCount: 0,
      rawByteDeltaCount: 7,
      finalByteDeltaCount: 0,
    });

    const redirected = mutateContinuousGenotype(parent, singleSelectedLeafRng(32, 0), options);
    expect(redirected.accounting).toMatchObject({
      selectedLeafCount: 1,
      rawChangedLeafCount: 1,
      clampedLeafCount: 1,
      repairChangedLeafCount: 1,
      repairIntroducedLeafCount: 0,
      repairErasedLeafCount: 0,
      repairRedirectedLeafCount: 1,
      finalChangedLeafCount: 1,
      rawByteDeltaCount: 6,
      finalByteDeltaCount: 7,
    });

    for (const { accounting } of [introduced, erased, redirected]) {
      expect(accounting.repairChangedLeafCount).toBe(
        accounting.repairIntroducedLeafCount
        + accounting.repairErasedLeafCount
        + accounting.repairRedirectedLeafCount,
      );
      expect(accounting.finalChangedLeafCount).toBe(
        accounting.rawChangedLeafCount
        + accounting.repairIntroducedLeafCount
        - accounting.repairErasedLeafCount,
      );
    }
  });

  test('mutation rejects invalid decision and delta draws at their exact positions', () => {
    const parent = canonical();
    expect(() => mutateContinuousGenotype(
      parent,
      { nextFloat: () => -Number.EPSILON },
      { probability: 1, magnitude: 1 },
    )).toThrow(/nextFloat draw 1/);
    let calls = 0;
    expect(() => mutateContinuousGenotype(parent, {
      nextFloat() {
        calls += 1;
        return calls === 1 ? 0 : 1;
      },
    }, { probability: 1, magnitude: 1 })).toThrow(/nextFloat draw 2/);
  });
});
