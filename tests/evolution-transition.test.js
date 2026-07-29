// PR 4A — the deterministic N -> N+1 transition kernel: static boundary pins
// and an INDEPENDENT correctness oracle.
//
// The kernel (src/sim/evolution-transition.js) is an INTERNAL seam: the one
// authorized production importer today is evolution-run.js, and PR 4B will
// deliberately extend the allowlist with evolution-replay.js when the
// verified-artifact path starts reproducing persisted transitions. That
// allowlist is DECLARED below and pinned over every reference form, so an
// accidental production re-export or a second importer fails a build.
//
// ============================================================================
// THE ORACLE'S CLAIM BOUNDARY (read before trusting it)
// ============================================================================
//
// Moving deriveNextGeneration into a kernel and watching the existing suite
// stay green proves only behavior CONTINUITY. It does not protect against
// extracting a subtly wrong transition that the producer and the future PR 4B
// verifier will then share — the tautology the PR 4 split exists to avoid.
// The oracle below therefore derives its expected transition INDEPENDENTLY:
//
// NEVER CALLED to compute an expected result (the central subjects of the
// oracle): deriveNextGeneration, runGeneration, createEvolutionRun,
// selectElites, selectTournamentParent, mutateContinuousGenotype, any wrapper
// around them, and any fixture captured from the implementation under test.
// Elite ranking, the tournament winner, every mutation decision/delta/clamp,
// and all eleven accounting counters are re-derived inline from documented
// semantics with hand-written comparators and arithmetic, and the derived
// facts are asserted against COMMITTED literals so a reviewer reads the claim
// without re-running anything.
//
// SHARED lower-level primitives (locked elsewhere; NOT proven here):
//   - Rng (src/sim/prng.js) — the per-child stream derivation. The committed
//     tournament uint32 draws and mutation float draws pin the stream inside
//     this oracle too, but the xoshiro128** algorithm itself is proven by the
//     PRNG locks, not here.
//   - The canonical codecs (population, genotype, lineage serialize /
//     deserialize) and fnv1aFold — expected LOGICAL populations and lineages
//     are derived independently, then serialized through the shared codec;
//     this proves transition COMPOSITION, not codec internals (the codec
//     round-trip and golden-fixture tests prove those).
//   - compileAssembly / forEachGenotypeField / repairGenotype
//     (src/sim/assembly.js) — fixture preparation and the repair step of the
//     expected derivation. The expected field-walk PATHS are asserted against
//     committed literals, so a walk-order change fails this oracle rather
//     than being inherited from the shared walk.
//   - Policy literals ELITE_COUNT = 2 and TOURNAMENT_SIZE = 3, written as
//     literals here and pinned to the production constants in
//     tests/evolution-operators.test.js.
//
// PROVES: transition composition — canonical elite rank/order/count, the
// lower-id fitness tie-break, fresh-ID allocation, elite parent retention,
// the per-child RNG fork keyed by the FRESH child id, draw order (3 uint32
// tournament draws, then one decision float per eligible leaf, then one unit
// float per selected leaf), tournament sampling with replacement, the repair
// invocation point, final-vs-raw genotype selection (Case B is repair-
// sensitive: retaining rawGenotype instead of genotype changes the bytes),
// accounting propagation, population member order, lineage row order, and
// byte-exact serialization of the composed result.
//
// DOES NOT PROVE: the Rng algorithm, codec internals, repair's internal
// rules, or the selection/mutation operators against their own specs — all
// independently locked by their own suites. The immediate-decode and
// cross-check proof OBLIGATIONS (that the kernel re-decodes what it encoded,
// and cross-checks the decoded lineage against the decoded population and the
// preceding generation's ids) are pinned source-statically below, because
// they are unobservable from the outside when the input is well-formed.

import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

import { deriveNextGeneration } from '../src/sim/evolution-transition.js';
import { Rng } from '../src/sim/prng.js';
import {
  compileAssembly, deserializeGenotype, forEachGenotypeField, repairGenotype, serializeGenotype,
} from '../src/sim/assembly.js';
import {
  POPULATION_SNAPSHOT_VERSION, deserializePopulationSnapshot, serializePopulationSnapshot,
} from '../src/sim/population.js';
import {
  EVOLUTION_LINEAGE_VERSION, deserializeLineage, serializeLineage,
} from '../src/sim/evolution-lineage.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from '../src/sim/fnv1a.js';
import {
  FITNESS_POLICY_VERSION, SELECTION_POOL_VERSION,
} from '../src/sim/population-evaluation.js';

const KERNEL = 'src/sim/evolution-transition.js';

// ============================================================================
// (1) THE PRODUCTION IMPORTER / RE-EXPORT GUARD
// ============================================================================
//
// THE DECLARED production importer allowlist. Exactly one entry today; PR 4B
// adds 'src/sim/evolution-replay.js' here BY DECISION, with its own review —
// this set is pinned, not eternal. Tests import the kernel directly and are
// outside this guard's walked roots by construction.
const AUTHORIZED_PRODUCTION_IMPORTERS = Object.freeze({
  'src/sim/evolution-run.js': true,
});

const walkJs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walkJs(`${dir}/${e.name}`) : (e.name.endsWith('.js') ? [`${dir}/${e.name}`] : [])
));

// Resolve a relative specifier against the importing file and NORMALIZE to
// the repo-relative forward-slash form, so './evolution-transition.js',
// './evolution-transition' and '../sim/evolution-transition.js' all
// canonicalize to the one module path.
function normalizeSpecifier(fromFile, spec) {
  const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  const out = [];
  for (const part of [...dir.split('/'), ...spec.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const joined = out.join('/');
  return joined.endsWith('.js') ? joined : `${joined}.js`;
}

// Every reference form an ES module can take: static import, side-effect
// import, re-export (named and star), and dynamic import().
const REFERENCE_FORMS = Object.freeze([
  ['static', /^\s*import\s[^;]*?\bfrom\s*'([^']+)'/gm],
  ['side-effect', /^\s*import\s*'([^']+)'/gm],
  ['re-export', /^\s*export\s[^;]*?\bfrom\s*'([^']+)'/gm],
  ['dynamic', /\bimport\(\s*'([^']+)'\s*\)/g],
]);

function referencesToKernel(file) {
  const source = readFileSync(file, 'utf8');
  const hits = [];
  for (const [form, pattern] of REFERENCE_FORMS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('.') && normalizeSpecifier(file, match[1]) === KERNEL) hits.push(form);
    }
  }
  return hits;
}

describe('the production importer / re-export guard', () => {
  test('exactly the declared production allowlist references the kernel, under every reference form', () => {
    const files = [...walkJs('src'), ...walkJs('scripts')];
    expect(files.length).toBeGreaterThan(20); // the walk is not vacuous
    const importers = {};
    for (const file of files) {
      const forms = referencesToKernel(file);
      if (forms.length > 0) importers[file] = forms;
    }
    expect(Object.keys(importers).sort()).toEqual(Object.keys(AUTHORIZED_PRODUCTION_IMPORTERS).sort());
    for (const [file, forms] of Object.entries(importers)) {
      expect(forms, `${file} may only STATIC-import the kernel`).toEqual(['static']);
    }
  });

  test('evolution-run.js does not re-export the kernel or its function', () => {
    const source = readFileSync('src/sim/evolution-run.js', 'utf8');
    const exportStatements = source.match(/^\s*export\s[^;]*;/gm) || [];
    expect(exportStatements.some((s) => s.includes('evolution-transition'))).toBe(false);
    expect(exportStatements.some((s) => s.includes('deriveNextGeneration'))).toBe(false);
  });
});

// ============================================================================
// (2) CYCLE-FREE PLACEMENT
// ============================================================================

function staticImportsOf(file) {
  const source = readFileSync(file, 'utf8');
  const specs = [
    ...[...source.matchAll(/^\s*import\s[^;]*?\bfrom\s*'([^']+)';/gm)].map((m) => m[1]),
    ...[...source.matchAll(/^\s*import\s*'([^']+)';/gm)].map((m) => m[1]),
  ];
  return specs.filter((s) => s.startsWith('.')).map((s) => normalizeSpecifier(file, s));
}

describe('cycle-free placement', () => {
  test('the kernel imports exactly the five declared lower-level modules', () => {
    expect(staticImportsOf(KERNEL).sort()).toEqual([
      'src/sim/evolution-contract.js',
      'src/sim/evolution-lineage.js',
      'src/sim/evolution-operators.js',
      'src/sim/population.js',
      'src/sim/prng.js',
    ]);
  });

  test('neither run orchestration nor replay verification is reachable from the kernel', () => {
    const closure = new Set();
    const stack = [KERNEL];
    while (stack.length > 0) {
      const file = stack.pop();
      if (closure.has(file)) continue;
      closure.add(file);
      for (const dep of staticImportsOf(file)) stack.push(dep);
    }
    expect(closure.has('src/sim/evolution-run.js')).toBe(false);
    expect(closure.has('src/sim/evolution-replay.js')).toBe(false);
  });
});

// ============================================================================
// (3) THE CANONICALIZATION-SEQUENCE PIN (source-static)
// ============================================================================
//
// The immediate population decode and the lineage decode + cross-check are
// PROOF OBLIGATIONS: with a well-formed input they leave no observable trace,
// so no value-level test can see them being skipped. Pinned on the source, the
// same accepted technique as the trace-exclusion guard — deleting either one
// must fail a build. The \b matters: 'deserialize...' CONTAINS 'serialize...'
// as a substring, and an unanchored count would silently count the decode as a
// second encode.

describe('the canonicalization sequence (source-static)', () => {
  const source = readFileSync(KERNEL, 'utf8');
  const count = (pattern) => (source.match(pattern) || []).length;

  test('population serialize -> immediate decode -> lineage serialize -> decode + cross-check, each exactly once, in that order', () => {
    expect(count(/\bserializePopulationSnapshot\(/g)).toBe(1);
    expect(count(/\bdeserializePopulationSnapshot\(populationBytes\)/g)).toBe(1);
    expect(count(/\bserializeLineage\(/g)).toBe(1);
    expect(count(/\bcrossCheckLineage\(/g)).toBe(1);
    const iSerializePop = source.search(/\bserializePopulationSnapshot\(/);
    const iDecodePop = source.search(/\bdeserializePopulationSnapshot\(populationBytes\)/);
    const iSerializeLin = source.search(/\bserializeLineage\(/);
    const iCrossCheck = source.search(/\bcrossCheckLineage\(/);
    expect(iSerializePop).toBeGreaterThanOrEqual(0);
    expect(iDecodePop).toBeGreaterThan(iSerializePop);
    expect(iSerializeLin).toBeGreaterThan(iDecodePop);
    expect(iCrossCheck).toBeGreaterThan(iSerializeLin);
  });

  test('the cross-check consumes the DECODED lineage, the DECODED population ids, and the PRECEDING generation ids', () => {
    const iCrossCheck = source.search(/\bcrossCheckLineage\(/);
    const args = source.slice(iCrossCheck, source.indexOf(');', iCrossCheck) + 2);
    expect(args).toContain('deserializeLineage(lineageBytes)');
    expect(args).toContain('populationIds(decoded)');
    expect(args).toContain('currentIds');
  });
});

// ============================================================================
// (4) THE INDEPENDENT ORACLE
// ============================================================================
//
// Fixture shape copy-declared from tests/evolution-operators.test.js:19-45
// (extended with a hue parameter so members carry distinct genotype bytes).
// compileAssembly(...).genotype is the repaired canonical clone — fixture
// preparation only, under the stated boundary.

function genotype(axles = 0, hue = 0.5) {
  const axle = () => ({
    posX01: 0.5, paired: 1, trackHalf: 0.5, radius: 0.5, width: 0.5, density: 0.5,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue, symmetric: 1, power: 0.5, frameDensity: 0.5,
    frame: {
      family: 0, segments: [{ nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 })),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: Array.from({ length: axles }, axle),
  };
}

const canonical = (axles, hue) => compileAssembly(genotype(axles, hue)).genotype;

function oraclePool(population, rows) {
  return Object.freeze({
    selectionPoolVersion: SELECTION_POOL_VERSION,
    fitnessPolicyVersion: FITNESS_POLICY_VERSION,
    // The same-source FNV sentinel, folded over the population's own canonical
    // bytes — exactly the value production computes from the decoded vector.
    populationSnapshotDigestState: fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population)),
    evaluatedIndividualIds: Object.freeze(rows.map((r) => r.individualId)),
    individuals: Object.freeze(rows.map((r) => Object.freeze(r))),
  });
}

const fieldRows = (g) => {
  const rows = [];
  forEachGenotypeField(g, (e) => rows.push(e));
  return rows;
};

// --- The independent derivation. Hand-written arithmetic over the shared ---
// --- primitives named in the header; NEVER the production operators.      ---

// Policy literals, pinned to the production constants in
// tests/evolution-operators.test.js — written out here so this file never
// imports the module whose composition it checks.
const ORACLE_ELITE_COUNT = 2;
const ORACLE_TOURNAMENT_SIZE = 3;

// Canonical fitness ranking: higher fitness first, ties to the LOWER id.
const oracleRanksHigher = (a, b) => a.fitness > b.fitness
  || (a.fitness === b.fitness && a.individualId < b.individualId);

function oracleEliteIds(rows) {
  const ranked = [...rows].sort((a, b) => (oracleRanksHigher(a, b) ? -1 : (oracleRanksHigher(b, a) ? 1 : 0)));
  return ranked.slice(0, ORACLE_ELITE_COUNT).map((r) => r.individualId);
}

// Three replacement samples from the child's own stream, best of three by the
// canonical ranking. Returns the committed-draw evidence as well as the winner.
function oracleTournament(childRng, rows) {
  const draws = [];
  let winner = null;
  for (let i = 0; i < ORACLE_TOURNAMENT_SIZE; i += 1) {
    const draw = childRng.nextUint32();
    draws.push(draw);
    const candidate = rows[draw % rows.length];
    if (winner === null || oracleRanksHigher(candidate, winner)) winner = candidate;
  }
  return { draws, winnerId: winner.individualId };
}

// The continuous-mutation semantics, re-derived: one decision float per
// eligible (continuous f64) leaf in field-walk order; a selected leaf draws
// one unit float, applies delta = (2*unit - 1) * magnitude, clamps the
// proposal to [0,1], and writes only when delta !== 0. Then exactly one
// repair, and the final genotype is the CANONICAL repaired form. Counters
// compared leaf-by-leaf with Object.is, byte deltas counted byte-by-byte.
function oracleMutation(parentGenotype, childRng, mutation) {
  const parentFields = fieldRows(parentGenotype);
  const parentBytes = serializeGenotype(parentGenotype);
  const rawBytes = new Uint8Array(parentBytes);
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  let eligibleContinuousLeafCount = 0;
  let selectedLeafCount = 0;
  let clampedLeafCount = 0;
  const selectedLeaves = [];
  for (let i = 0; i < parentFields.length; i += 1) {
    const entry = parentFields[i];
    if (!(entry.kind === 'continuous' && entry.type === 'f64')) continue;
    eligibleContinuousLeafCount += 1;
    const decision = childRng.nextFloat();
    if (decision >= mutation.probability) continue;
    selectedLeafCount += 1;
    const unit = childRng.nextFloat();
    const current = view.getFloat64(entry.byteOffset, true);
    const delta = (2 * unit - 1) * mutation.magnitude;
    const proposal = current + delta;
    let value = proposal;
    if (proposal < 0) { value = 0; clampedLeafCount += 1; } else if (proposal > 1) { value = 1; clampedLeafCount += 1; }
    if (delta !== 0) view.setFloat64(entry.byteOffset, value, true);
    selectedLeaves.push(Object.freeze({ path: entry.path, decision, unit, value }));
  }
  const rawGenotype = deserializeGenotype(rawBytes);
  const rawBytesCanonical = serializeGenotype(rawGenotype);
  // Shared repair primitive, under the stated boundary: repair's INTERNAL
  // rules are not proven here; its INVOCATION POINT and its effect on the
  // composed result are.
  const finalGenotype = deserializeGenotype(serializeGenotype(repairGenotype(rawGenotype)));
  const finalBytes = serializeGenotype(finalGenotype);
  const rawFields = fieldRows(rawGenotype);
  const finalFields = fieldRows(finalGenotype);
  let rawChangedLeafCount = 0;
  let repairChangedLeafCount = 0;
  let repairIntroducedLeafCount = 0;
  let repairErasedLeafCount = 0;
  let repairRedirectedLeafCount = 0;
  let finalChangedLeafCount = 0;
  const repairTouched = [];
  for (let i = 0; i < parentFields.length; i += 1) {
    const p = parentFields[i];
    if (!(p.kind === 'continuous' && p.type === 'f64')) continue;
    const rawChanged = !Object.is(p.value, rawFields[i].value);
    const finalChanged = !Object.is(p.value, finalFields[i].value);
    const repairChanged = !Object.is(rawFields[i].value, finalFields[i].value);
    if (rawChanged) rawChangedLeafCount += 1;
    if (finalChanged) finalChangedLeafCount += 1;
    if (repairChanged) repairChangedLeafCount += 1;
    let classification = null;
    if (!rawChanged && finalChanged) { repairIntroducedLeafCount += 1; classification = 'introduced'; } else if (rawChanged && !finalChanged) { repairErasedLeafCount += 1; classification = 'erased'; } else if (rawChanged && repairChanged) { repairRedirectedLeafCount += 1; classification = 'redirected'; }
    if (repairChanged) {
      repairTouched.push(Object.freeze({
        path: p.path, parent: p.value, raw: rawFields[i].value, final: finalFields[i].value, classification,
      }));
    }
  }
  const byteDeltaCount = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) n += 1;
    return n;
  };
  const accounting = {
    eligibleContinuousLeafCount,
    selectedLeafCount,
    rawChangedLeafCount,
    clampedLeafCount,
    repairChangedLeafCount,
    repairIntroducedLeafCount,
    repairErasedLeafCount,
    repairRedirectedLeafCount,
    finalChangedLeafCount,
    rawByteDeltaCount: byteDeltaCount(parentBytes, rawBytesCanonical),
    finalByteDeltaCount: byteDeltaCount(parentBytes, finalBytes),
  };
  return {
    accounting, finalGenotype, finalBytes, selectedLeaves, repairTouched, eligibleContinuousLeafCount,
  };
}

// One non-elite child, derived end to end: fork keyed by the FRESH child id,
// three tournament draws, then the mutation stream over the parent genotype.
function oracleChild(seed, childId, poolRows, genotypesById, mutation) {
  const childRng = new Rng(seed).fork(childId);
  const { draws, winnerId } = oracleTournament(childRng, poolRows);
  const parentGenotype = genotypesById.get(winnerId);
  const derived = oracleMutation(parentGenotype, childRng, mutation);
  return { draws, winnerId, parentGenotype, ...derived };
}

// The all-zero accounting an elite copy carries (key set written out by hand;
// the lineage codec itself rejects a wrong set).
const ZERO_ACCOUNTING = Object.freeze({
  eligibleContinuousLeafCount: 0,
  selectedLeafCount: 0,
  rawChangedLeafCount: 0,
  clampedLeafCount: 0,
  repairChangedLeafCount: 0,
  repairIntroducedLeafCount: 0,
  repairErasedLeafCount: 0,
  repairRedirectedLeafCount: 0,
  finalChangedLeafCount: 0,
  rawByteDeltaCount: 0,
  finalByteDeltaCount: 0,
});

function oracleTransition({
  ids, fitnesses, genotypesById, seed, mutation, baseIndividualId, generationIndex,
}) {
  const population = {
    snapshotVersion: POPULATION_SNAPSHOT_VERSION,
    individuals: ids.map((id) => ({ individualId: id, genotype: genotypesById.get(id) })),
  };
  const rows = ids.map((id, i) => ({ individualId: id, fitness: fitnesses[i] }));
  const pool = oraclePool(population, rows);
  const eliteIds = oracleEliteIds(rows);
  const individuals = [];
  const lineageRows = [];
  const children = new Map();
  for (let slot = 0; slot < ids.length; slot += 1) {
    const childId = baseIndividualId + slot;
    if (slot < eliteIds.length) {
      const eliteId = eliteIds[slot];
      individuals.push({ individualId: childId, genotype: genotypesById.get(eliteId) });
      lineageRows.push({
        individualId: childId, parentIndividualId: eliteId, origin: 'eliteCopy', accounting: ZERO_ACCOUNTING,
      });
      continue;
    }
    const child = oracleChild(seed, childId, rows, genotypesById, mutation);
    children.set(childId, child);
    individuals.push({ individualId: childId, genotype: child.finalGenotype });
    lineageRows.push({
      individualId: childId,
      parentIndividualId: child.winnerId,
      origin: 'continuousMutation',
      accounting: child.accounting,
    });
  }
  const expectedPopulationBytes = serializePopulationSnapshot({
    snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals,
  });
  const expectedLineageRows = lineageRows;
  const expectedLineageBytes = serializeLineage({
    lineageVersion: EVOLUTION_LINEAGE_VERSION, generationIndex: generationIndex + 1, individuals: lineageRows,
  });
  return {
    population, pool, eliteIds, children, expectedPopulationBytes, expectedLineageBytes, expectedLineageRows,
  };
}

// Assert the kernel's actual output against the independently derived
// expectation: exact bytes, then the decoded intermediate facts.
function expectTransitionMatches(actual, derived, expectedChildIds) {
  expect(actual.populationBytes).toEqual(derived.expectedPopulationBytes);
  expect(actual.lineageBytes).toEqual(derived.expectedLineageBytes);
  const decodedPopulation = deserializePopulationSnapshot(actual.populationBytes);
  expect(decodedPopulation.individuals.map((m) => m.individualId)).toEqual(expectedChildIds);
  const decodedLineage = deserializeLineage(actual.lineageBytes);
  expect(decodedLineage.individuals.map((r) => ({
    individualId: r.individualId,
    parentIndividualId: r.parentIndividualId,
    origin: r.origin,
    accounting: r.accounting,
  }))).toEqual(derived.expectedLineageRows.map((r) => ({
    individualId: r.individualId,
    parentIndividualId: r.parentIndividualId,
    origin: r.origin,
    accounting: r.accounting,
  })));
}

describe('the independent transition oracle', () => {
  test('Case A — selection, elitism, tie-break, fresh ids and lineage shape (zero-probability mutation)', () => {
    // Five members (more than the elite count), axles=0 genotypes with
    // distinct hues. Fitnesses carry a TIE at 7 between ids 11 and 12,
    // resolved to the lower id first: canonical elite order is [11, 12].
    const ids = [10, 11, 12, 13, 14];
    const hues = [0.1, 0.2, 0.3, 0.4, 0.5];
    const fitnesses = [5, 7, 7, 1, 3];
    const genotypesById = new Map(ids.map((id, i) => [id, canonical(0, hues[i])]));
    const seed = 20260728;
    const mutation = { probability: 0, magnitude: 0 };
    const baseIndividualId = 20;
    const generationIndex = 0;

    const derived = oracleTransition({
      ids, fitnesses, genotypesById, seed, mutation, baseIndividualId, generationIndex,
    });

    // COMMITTED FACT 1: the tie-break. 11 and 12 both have fitness 7; the
    // lower id ranks first. Elites are placed FIRST, in this order.
    expect(derived.eliteIds).toEqual([11, 12]);

    // COMMITTED FACT 2: the per-child tournament evidence. Each child's
    // stream is forked by its FRESH id (22, 23, 24 — never a slot index, and
    // no generation-global stream); three uint32 draws index the pool WITH
    // replacement (child 22 draws row 14 twice). Child 23's winner is id 10 —
    // a tournament-selected NON-ELITE parent.
    const expectedDraws = new Map([
      [22, [2571769194, 2999783284, 4013469867]],
      [23, [4153418890, 104060178, 433345798]],
      [24, [262507811, 3456338957, 419922519]],
    ]);
    const expectedWinners = new Map([[22, 12], [23, 10], [24, 11]]);
    for (const [childId, child] of derived.children) {
      expect(child.draws).toEqual(expectedDraws.get(childId));
      expect(child.winnerId).toBe(expectedWinners.get(childId));
    }

    // COMMITTED FACT 3: with probability 0 every decision draws and skips, so
    // the accounting is exactly the eligible-leaf count of the axles=0 walk
    // (30 continuous f64 leaves) and nothing else, and each child's final
    // genotype is byte-identical to its parent's.
    expect(derived.children.get(22).eligibleContinuousLeafCount).toBe(30);
    for (const [, child] of derived.children) {
      expect(child.accounting).toEqual({ ...ZERO_ACCOUNTING, eligibleContinuousLeafCount: 30 });
      expect(child.selectedLeaves).toEqual([]);
      expect(child.repairTouched).toEqual([]);
      expect(child.finalBytes).toEqual(serializeGenotype(child.parentGenotype));
    }

    const actual = deriveNextGeneration({
      population: derived.population,
      pool: derived.pool,
      seed,
      mutation,
      baseIndividualId,
      generationIndex,
    });
    expectTransitionMatches(actual, derived, [20, 21, 22, 23, 24]);

    // The decoded elite rows retain the OLD parent ids; every row order is
    // the fresh-id order (population member order == lineage row order).
    const lineage = deserializeLineage(actual.lineageBytes);
    expect(lineage.generationIndex).toBe(1);
    expect(lineage.individuals.slice(0, 2).map((r) => [r.individualId, r.parentIndividualId, r.origin]))
      .toEqual([[20, 11, 'eliteCopy'], [21, 12, 'eliteCopy']]);
    expect(lineage.individuals.slice(2).map((r) => [r.individualId, r.parentIndividualId, r.origin]))
      .toEqual([[22, 12, 'continuousMutation'], [23, 10, 'continuousMutation'], [24, 11, 'continuousMutation']]);
  });

  test('Case B — nonzero mutation, repair sensitivity and exact accounting', () => {
    // Four members, axles=1 genotypes with distinct hues; elites [31, 33].
    // Mutation probability 0.05 / magnitude 0.5 over the 43-leaf walk, seed
    // 35 (chosen at authoring time so both children mutate and child 42's
    // radius leaf is repair-sensitive), then committed as literals.
    const ids = [30, 31, 32, 33];
    const hues = [0.1, 0.2, 0.3, 0.4];
    const fitnesses = [4, 9, 2, 6];
    const genotypesById = new Map(ids.map((id, i) => [id, canonical(1, hues[i])]));
    const seed = 35;
    const mutation = { probability: 0.05, magnitude: 0.5 };
    const baseIndividualId = 40;
    const generationIndex = 3;

    // COMMITTED FACT 1: the axles=1 field walk the mutation consumes, in
    // canonical serialization order. A walk-order or eligibility change fails
    // HERE rather than being inherited from the shared walk primitive.
    const expectedWalk = [
      'version', 'hue', 'symmetric', 'power', 'frameDensity', 'frame.family',
      'frame.segments.length', 'frame.segments[0].nodeCount',
      'frame.segments[0].nodes[0].gap', 'frame.segments[0].nodes[0].height',
      'frame.segments[0].nodes[0].halfWidth', 'frame.segments[0].nodes[0].thickness',
      'frame.segments[0].nodes[1].gap', 'frame.segments[0].nodes[1].height',
      'frame.segments[0].nodes[1].halfWidth', 'frame.segments[0].nodes[1].thickness',
      'frame.segments[0].nodes[2].gap', 'frame.segments[0].nodes[2].height',
      'frame.segments[0].nodes[2].halfWidth', 'frame.segments[0].nodes[2].thickness',
      'frame.segments[0].nodes[3].gap', 'frame.segments[0].nodes[3].height',
      'frame.segments[0].nodes[3].halfWidth', 'frame.segments[0].nodes[3].thickness',
      'frame.segments[0].nodes[4].gap', 'frame.segments[0].nodes[4].height',
      'frame.segments[0].nodes[4].halfWidth', 'frame.segments[0].nodes[4].thickness',
      'frame.segments[0].nodes[5].gap', 'frame.segments[0].nodes[5].height',
      'frame.segments[0].nodes[5].halfWidth', 'frame.segments[0].nodes[5].thickness',
      'frame.segments[0].fam.spine.beamWidthFrac', 'frame.segments[0].fam.ladder.crossFrac',
      'frame.segments[0].fam.hull.bulge', 'axles.length',
      'axles[0].posX01', 'axles[0].paired', 'axles[0].trackHalf', 'axles[0].radius',
      'axles[0].width', 'axles[0].density', 'axles[0].suspType', 'axles[0].stiffness',
      'axles[0].damping', 'axles[0].travel', 'axles[0].restLength', 'axles[0].driven',
      'axles[0].share', 'axles[0].asym.driveBias', 'axles[0].asym.sizeBias',
      'axles[0].asym.centerOffset',
    ];
    expect(fieldRows(genotypesById.get(31)).map((e) => e.path)).toEqual(expectedWalk);

    const derived = oracleTransition({
      ids, fitnesses, genotypesById, seed, mutation, baseIndividualId, generationIndex,
    });
    expect(derived.eliteIds).toEqual([31, 33]);

    // COMMITTED FACT 2: tournament evidence. Children 42 and 43 (fresh ids
    // base + slot), each forked from (seed, childId).
    expect(derived.children.get(42).draws).toEqual([4144057290, 2041815096, 1639505013]);
    expect(derived.children.get(42).winnerId).toBe(31);
    expect(derived.children.get(43).draws).toEqual([1681298795, 21421303, 112781956]);
    expect(derived.children.get(43).winnerId).toBe(33);

    // COMMITTED FACT 3: child 42's mutation. Four selected leaves with their
    // exact decision/unit draws and written values — the radius leaf is drawn
    // DOWN to 0.31067544245161116, below the repair floor.
    expect(derived.children.get(42).selectedLeaves).toEqual([
      { path: 'frame.segments[0].nodes[3].thickness', decision: 0.04597651003859937, unit: 0.647209434537217, value: 0.647209434537217 },
      { path: 'frame.segments[0].nodes[5].halfWidth', decision: 0.02310334239155054, unit: 0.9455797320697457, value: 0.9455797320697457 },
      { path: 'frame.segments[0].fam.ladder.crossFrac', decision: 0.03145399014465511, unit: 0.15243082772940397, value: 0.15243082772940397 },
      { path: 'axles[0].radius', decision: 0.04479147074744105, unit: 0.31067544245161116, value: 0.31067544245161116 },
    ]);

    // COMMITTED FACT 4: child 42 is REPAIR-SENSITIVE, and this is what makes
    // the final-vs-raw distinction observable. Repair clamps the radius gene
    // UP to its feasibility floor: raw 0.31067544245161116 becomes
    // 0.4000000000000001 while the parent's 0.5 stays changed — a REDIRECTED
    // leaf. At that floor the size-bias feasibility bound lands one ulp above
    // the parent's saturated 0.5, so repair also nudges sizeBias from 0.5 to
    // 0.5000000000000001 without any mutation draw touching it — an
    // INTRODUCED leaf. The derivation reproduces both bit-exactly; a kernel
    // that retained rawGenotype, skipped repair, or repaired before mutating
    // would produce different bytes and different counters.
    expect(derived.children.get(42).repairTouched).toEqual([
      {
        path: 'axles[0].radius', parent: 0.5, raw: 0.31067544245161116, final: 0.4000000000000001, classification: 'redirected',
      },
      {
        path: 'axles[0].asym.sizeBias', parent: 0.5, raw: 0.5, final: 0.5000000000000001, classification: 'introduced',
      },
    ]);

    // COMMITTED FACT 5: child 43's single nonzero mutation, no repair effect.
    expect(derived.children.get(43).selectedLeaves).toEqual([
      { path: 'frame.segments[0].nodes[0].height', decision: 0.0383961817715317, unit: 0.08694990770891309, value: 0.08694990770891309 },
    ]);
    expect(derived.children.get(43).repairTouched).toEqual([]);

    // COMMITTED FACT 6: all eleven accounting counters, both children.
    expect(derived.children.get(42).accounting).toEqual({
      eligibleContinuousLeafCount: 43,
      selectedLeafCount: 4,
      rawChangedLeafCount: 4,
      clampedLeafCount: 0,
      repairChangedLeafCount: 2,
      repairIntroducedLeafCount: 1,
      repairErasedLeafCount: 0,
      repairRedirectedLeafCount: 1,
      finalChangedLeafCount: 5,
      rawByteDeltaCount: 19,
      finalByteDeltaCount: 22,
    });
    expect(derived.children.get(43).accounting).toEqual({
      eligibleContinuousLeafCount: 43,
      selectedLeafCount: 1,
      rawChangedLeafCount: 1,
      clampedLeafCount: 0,
      repairChangedLeafCount: 0,
      repairIntroducedLeafCount: 0,
      repairErasedLeafCount: 0,
      repairRedirectedLeafCount: 0,
      finalChangedLeafCount: 1,
      rawByteDeltaCount: 4,
      finalByteDeltaCount: 4,
    });

    const actual = deriveNextGeneration({
      population: derived.population,
      pool: derived.pool,
      seed,
      mutation,
      baseIndividualId,
      generationIndex,
    });
    expectTransitionMatches(actual, derived, [40, 41, 42, 43]);

    // The lineage generation index is the NEXT generation's, and the elite
    // rows retain the old parent ids with zero accounting.
    const lineage = deserializeLineage(actual.lineageBytes);
    expect(lineage.generationIndex).toBe(4);
    expect(lineage.individuals.slice(0, 2).map((r) => [r.individualId, r.parentIndividualId, r.origin]))
      .toEqual([[40, 31, 'eliteCopy'], [41, 33, 'eliteCopy']]);
    expect(lineage.individuals[2].accounting).toEqual(derived.children.get(42).accounting);
    expect(lineage.individuals[3].accounting).toEqual(derived.children.get(43).accounting);
  });
});
