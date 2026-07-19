// THE OWNERSHIP BOUNDARY — standing enforcement, asserted on VALUES.
//
// WHY THIS FILE EXISTS. Every defect in this class was previously fixed at the
// site where it was found, a rule was written in prose next to the fix, and
// NOTHING bound the two. A measurement proved the gap: deleting the three
// cached intrinsic getters in `deserializeGenotype` and reverting to plain
// `bytes.buffer` / `bytes.byteOffset` / `bytes.byteLength` reads left the whole
// suite GREEN. Worse, the one test that claimed to guard the species ruling —
// "an own subarray property is never invoked by r.bytes" (tests/bytes.test.js)
// — asserts a strictly WEAKER proposition than the rule: the species-aware
// `%TypedArray%.prototype.subarray` path never touches an OWN `subarray`
// property, so it PASSED while violating the rule it was written for. A test
// that observes whether a particular hook fired can only ever catch the one
// mechanism its author imagined. This file asserts the RULE, on the returned
// VALUE, mechanism-agnostically.
//
// THE RULE, in four parts, one section each:
//   (1) the owned export surface is DECLARED, so a new export cannot ship
//       unclassified (and so `export const` arrows — `wheelMass` — cannot hide
//       from a `grep '^export function'` review the way one already did);
//   (2) byte-boundary geometry comes from the runtime, never from what the
//       caller's object CLAIMS (`length`/`byteLength`/`byteOffset`/`buffer` are
//       inherited ACCESSORS: an own data property on a GENUINE Uint8Array
//       shadows them with ordinary JavaScript — no Proxy, no lying prototype);
//   (3) a sub-view is CONSTRUCTED by the module, never produced by
//       caller-selected code (the species leg);
//   (4) a module copies on intake and retains no caller reference in anything
//       it attests — with the two deliberate exceptions named and pinned.
//
// Pure: no Rapier, no physics, no clock. The one export this file cannot
// exercise (`evaluatePopulation`, which steps worlds) is declared and routed to
// its owning suite rather than silently omitted.
//
// Seeds: 20260710 (the assembly corpus fork used for a repair-moving raw draw),
// 123456 (the declared small-manifest seed, copy-declared from
// tests/population-codec.test.js).

import { describe, test, expect } from 'vitest';

import * as BytesNS from '../src/sim/bytes.js';
import * as AssemblyNS from '../src/sim/assembly.js';
import * as PopulationNS from '../src/sim/population.js';
import * as InitializerNS from '../src/sim/population-initializer.js';
import * as EvaluationNS from '../src/sim/population-evaluation.js';

import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHex } from '../src/sim/fnv1a.js';
import {
  EVALUATION_TRACE_VERSION, RECORD_BYTES, compareTraces, decodeTraceRecord, encodeTraceRecord,
} from '../src/sim/trace.js';
import { TERRAIN_DEFAULTS } from '../src/sim/terrain.js';
import { Rng } from '../src/sim/prng.js';

const {
  bytesToHex, createByteReader, typedArrayByteLength,
} = BytesNS;
const {
  compileAssembly, deserializeGenotype, forEachGenotypeField, randomGenotype,
  repairGenotype, serializeGenotype, validateGenotype,
} = AssemblyNS;
const {
  POPULATION_SNAPSHOT_VERSION, attestPopulation, bytesEqual,
  deserializePopulationSnapshot, serializePopulationSnapshot, validatePopulation,
} = PopulationNS;
const {
  createInitialPopulation, deserializePopulationInitialization,
  sampleInitialGenotype, serializePopulationInitialization,
} = InitializerNS;
const {
  SPAWN_CLEARANCE, championFromEvaluation, deserializeEvaluationSpec,
  deserializeFitnessVector, selectableChampionFromEvaluation,
  serializeEvaluationSpec, serializeFitnessVector, spawnPoseOnFlatStart,
} = EvaluationNS;

// --- Shared helpers ----------------------------------------------------------

// Object.is at leaves + exact key sets (the trace.js T8 comparator, copied from
// tests/population-codec.test.js). vitest's toEqual treats +0 and −0 as equal;
// the byte contracts here do not.
function assertBitEqual(actual, expected, path = '') {
  if (typeof expected === 'number') {
    expect(Object.is(actual, expected), `${path}: ${String(actual)} !== ${String(expected)}`).toBe(true);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} is not an array`).toBe(true);
    expect(actual.length, `${path}.length`).toBe(expected.length);
    expected.forEach((v, i) => assertBitEqual(actual[i], v, `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    expect(Object.keys(actual).sort(), `${path} key set`).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) assertBitEqual(actual[k], expected[k], path === '' ? k : `${path}.${k}`);
    return;
  }
  expect(actual, path).toBe(expected);
}

// Every object reachable from `root` by ordinary key walking. Byte containers
// are recorded but never walked into (a Uint8Array's keys are its indices).
function collectRefs(root, out = new Set()) {
  if (root === null || typeof root !== 'object') return out;
  if (out.has(root)) return out;
  out.add(root);
  if (ArrayBuffer.isView(root) || root instanceof ArrayBuffer) return out;
  for (const k of Object.keys(root)) collectRefs(root[k], out);
  return out;
}

/**
 * The copy-on-intake assertion, generalized: NO object reachable in `result`
 * may be reference-identical to ANY object reachable in the caller's inputs.
 * Stated this way it catches an escape at any depth — an axle record, a node
 * slot, a nested range array — not only the one field a hand-written
 * `result[0] !== input[0]` happened to name.
 */
function assertNoReferenceEscape(result, callerRoots, label) {
  const forbidden = new Set();
  for (const root of callerRoots) collectRefs(root, forbidden);
  for (const ref of collectRefs(result)) {
    expect(forbidden.has(ref), `${label}: handed back a caller-owned object`).toBe(false);
  }
}

function assertDeepFrozen(v, path, seen = new Set()) {
  if (v === null || typeof v !== 'object') return;
  if (seen.has(v)) return;
  seen.add(v);
  expect(Object.isFrozen(v), `${path} is not frozen`).toBe(true);
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return;
  for (const k of Object.keys(v)) assertDeepFrozen(v[k], `${path}.${k}`, seen);
}

// --- Declared fixtures (copy-declared; never derived from the modules) -------

// Repair-stable declared genotype (copy-declared from
// tests/population-codec.test.js, which in turn copies tests/population.test.js).
function canonicalGenotype(hue = 0.25) {
  const node = () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 });
  const axle = (posX01) => ({
    posX01, paired: 1, trackHalf: 0.5, radius: 0.6, width: 0.5, density: 0.15,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5,
    asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue, symmetric: 0.9, power: 0.5, frameDensity: 0.3,
    frame: {
      family: 0.1,
      segments: [{
        nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, node),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: [axle(0.2), axle(0.8)],
  };
}

const pop = (individuals) => ({ snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals });
const twoMemberPopulation = () => pop([
  { individualId: 3, genotype: canonicalGenotype(0.25) },
  { individualId: 9, genotype: canonicalGenotype(0.75) },
]);

// Copy-declared from tests/evaluation-codec.test.js (itself copied from
// tests/population-evaluation.test.js).
const FLAT_TERRAIN = Object.freeze({
  seed: 20260723,
  length: 120,
  craterDensity: 0,
  featureDensity: 0,
  sandCoverage: 0,
  mudCoverage: 0,
  macroAmp: 0,
  microAmp: 0,
  startFlatLength: 60,
});

const resolvedFlat = () => ({
  deterministic: true,
  termination: 'maxSteps',
  maxSteps: 120,
  spawn: { x: -45, z: 0, clearance: SPAWN_CLEARANCE },
  targetWheelSurfaceSpeed: 5,
  wheelFriction: 1,
  terrain: { ...TERRAIN_DEFAULTS, ...FLAT_TERRAIN },
});

// Entry tuple: [individualId, fitness, valid, integrityStatus='ok'] — the
// tests/evaluation-codec.test.js shape.
const synthEvaluation = () => ({
  spec: resolvedFlat(),
  populationSnapshotDigestState: 0xdeadbeef,
  individuals: [
    { individualId: 0, fitness: 12.5, valid: true, integrityStatus: 'ok' },
    { individualId: 3, fitness: 0, valid: false, integrityStatus: 'numericalDivergence' },
  ],
});

// A valid hub-station trace record (copy-declared from tests/trace.test.js).
const baseTraceRecord = () => ({
  stepIndex: 7,
  vehicleIndex: 2,
  bodyRole: 'hub',
  axleIndex: 3,
  wheelIndex: 1,
  bodyValid: true,
  bodySleeping: false,
  jointState: 'valid',
  terminated: false,
  terminationReason: 'none',
  finiteState: true,
  translation: { x: 1.5, y: -2.25, z: 3.0625 },
  rotation: { x: 0.1, y: -0.2, z: 0.3, w: 0.9 },
  linvel: { x: -4.5, y: 5.5, z: -6.5 },
  angvel: { x: 7.5, y: -8.5, z: 9.5 },
});

// ============================================================================
// (1) EXPORT-SURFACE CONFORMANCE
// ============================================================================
//
// COPY-DECLARED, never derived from the modules (the SCALAR_DOMAINS idiom in
// tests/terrain.test.js and EXPECTED_DISCRETE_GENE_KEYS in
// tests/genotype-schema.test.js). Deriving the expectation from the namespace
// would make a new export satisfy its own guard.
//
// NOTE, because this is exactly how a public export survived a full review
// round unguarded: `wheelMass` is an `export const` ARROW, so
// `grep '^export function'` MISSES it. These lists were enumerated from
// `grep -E '^export'`, which catches const/function/class/async alike.

const EXPECTED_EXPORTS = Object.freeze({
  'bytes.js': Object.freeze([
    'bytesToHex', 'createByteReader', 'hexToBytes', 'typedArrayByteLength',
  ]),
  'assembly.js': Object.freeze([
    'ASSEMBLY_DEFAULTS', 'ASSEMBLY_IR_VERSION', 'ASSEMBLY_RULES', 'DISCRETE_GENE_KEYS',
    'FRAME_FAMILIES', 'GENE_RANGES', 'GENOTYPE_VERSION', 'HUB_LENGTH_FRACTION',
    'HUB_MASS_FRACTION', 'HUB_MASS_RANGE', 'HUB_RADIUS_FRACTION', 'NODE_COUNT_RANGE',
    'NODE_SLOTS', 'SUSPENSION_TYPES', 'compileAssembly', 'deserializeGenotype',
    'forEachGenotypeField', 'genotypeByteLength', 'genotypeFieldWalk',
    'hubMassProperties', 'randomGenotype', 'repairGenotype', 'serializeGenotype',
    'validateGenotype', 'wheelMass',
  ]),
  'population.js': Object.freeze([
    'POPULATION_SNAPSHOT_VERSION', 'attestPopulation', 'bytesEqual',
    'deserializePopulationSnapshot', 'isCanonicalUint32',
    'serializePopulationSnapshot', 'validatePopulation',
  ]),
  'population-initializer.js': Object.freeze([
    'INITIAL_POPULATION_DEFAULTS', 'POPULATION_INITIALIZER_VERSION',
    'createInitialPopulation', 'deserializePopulationInitialization',
    'sampleInitialGenotype', 'serializePopulationInitialization',
  ]),
  'population-evaluation.js': Object.freeze([
    'EVALUATION_SPEC_VERSION', 'FITNESS_POLICY_VERSION', 'FITNESS_VECTOR_VERSION',
    'POPULATION_WORLD_MODE', 'REALIZABLE_SUSPENSION_TYPES', 'SPAWN_CLEARANCE',
    'championFromEvaluation', 'deserializeEvaluationSpec', 'deserializeFitnessVector',
    'evaluatePopulation', 'fitnessFromVehicleResult', 'isVehicleResultSelectable',
    'isVehicleResultValid', 'selectableChampionFromEvaluation',
    'serializeEvaluationSpec', 'serializeFitnessVector', 'spawnPoseOnFlatStart',
  ]),
});

const NAMESPACES = Object.freeze({
  'bytes.js': BytesNS,
  'assembly.js': AssemblyNS,
  'population.js': PopulationNS,
  'population-initializer.js': InitializerNS,
  'population-evaluation.js': EvaluationNS,
});

// The five kinds the brief declares, plus ONE: `evaluatePopulation` orchestrates
// physics and is neither a codec, a predicate, nor a constant. Calling it
// 'pure' would be false in a table whose whole job is to state what each export
// is; the honest sixth entry is cheaper than a lie.
const KINDS = Object.freeze(['encoder', 'decoder', 'validator', 'policy', 'pure', 'orchestrator']);

/**
 * One row per export. `callerCollections` names every collection the function
 * READS out of caller-supplied data (arrays, typed arrays); `callerNumbers`
 * names the scalar leaves it combines arithmetically. Sections 2 and 4 consume
 * this table: a new export must be classified here before it can ship, and
 * anything with a non-empty `callerCollections` must additionally declare an
 * ownership verdict below.
 */
const EXPORT_ROLES = Object.freeze({
  'bytes.js': Object.freeze([
    { name: 'createByteReader', kind: 'pure', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'typedArrayByteLength', kind: 'pure', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'bytesToHex', kind: 'encoder', callerCollections: ['bytes'], callerNumbers: [] },
    // hex is a STRING: no caller collection, no caller number.
    { name: 'hexToBytes', kind: 'decoder', callerCollections: [], callerNumbers: [] },
  ]),
  'assembly.js': Object.freeze([
    { name: 'GENOTYPE_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'ASSEMBLY_IR_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'FRAME_FAMILIES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'SUSPENSION_TYPES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'ASSEMBLY_DEFAULTS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'ASSEMBLY_RULES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'GENE_RANGES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'NODE_SLOTS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'NODE_COUNT_RANGE', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'DISCRETE_GENE_KEYS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'HUB_MASS_FRACTION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'HUB_MASS_RANGE', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'HUB_RADIUS_FRACTION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'HUB_LENGTH_FRACTION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    // An `export const` ARROW — invisible to `grep '^export function'`, which is
    // how it reached production with three unvalidated numeric arguments.
    { name: 'wheelMass', kind: 'pure', callerCollections: [], callerNumbers: ['radius', 'width', 'density'] },
    {
      name: 'hubMassProperties',
      kind: 'pure',
      callerCollections: [],
      callerNumbers: ['wheel.mass', 'wheel.radius', 'wheel.width'],
    },
    {
      name: 'validateGenotype',
      kind: 'validator',
      callerCollections: ['genotype.frame.segments', 'genotype.frame.segments[0].nodes', 'genotype.axles'],
      callerNumbers: ['every [0,1] gene leaf'],
    },
    {
      name: 'repairGenotype',
      kind: 'pure',
      callerCollections: ['genotype.frame.segments[0].nodes', 'genotype.axles'],
      callerNumbers: ['every [0,1] gene leaf', 'options.maxAxles', 'options.corridorHalfWidth'],
    },
    {
      name: 'compileAssembly',
      kind: 'pure',
      callerCollections: ['genotype.frame.segments[0].nodes', 'genotype.axles'],
      callerNumbers: ['every [0,1] gene leaf', 'options.maxAxles', 'options.corridorHalfWidth'],
    },
    {
      name: 'serializeGenotype',
      kind: 'encoder',
      callerCollections: ['genotype.frame.segments[0].nodes', 'genotype.axles'],
      callerNumbers: ['every [0,1] gene leaf'],
    },
    { name: 'genotypeByteLength', kind: 'pure', callerCollections: [], callerNumbers: ['axleCount'] },
    { name: 'genotypeFieldWalk', kind: 'pure', callerCollections: [], callerNumbers: ['axleCount'] },
    {
      name: 'forEachGenotypeField',
      kind: 'pure',
      callerCollections: ['genotype.frame.segments[0].nodes', 'genotype.axles'],
      callerNumbers: ['every [0,1] gene leaf'],
    },
    { name: 'deserializeGenotype', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
    // The rng INJECTION contract, documented-not-fixed: `rng` is caller code by
    // design, and downstream domain validation contains an out-of-range draw.
    { name: 'randomGenotype', kind: 'pure', callerCollections: [], callerNumbers: ['rng.nextFloat() draws'] },
  ]),
  'population.js': Object.freeze([
    { name: 'POPULATION_SNAPSHOT_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'isCanonicalUint32', kind: 'validator', callerCollections: [], callerNumbers: ['v'] },
    { name: 'bytesEqual', kind: 'pure', callerCollections: ['a', 'b'], callerNumbers: [] },
    { name: 'validatePopulation', kind: 'validator', callerCollections: ['population.individuals'], callerNumbers: ['individualId'] },
    { name: 'serializePopulationSnapshot', kind: 'encoder', callerCollections: ['population.individuals'], callerNumbers: ['individualId'] },
    { name: 'attestPopulation', kind: 'encoder', callerCollections: ['population.individuals'], callerNumbers: ['individualId'] },
    { name: 'deserializePopulationSnapshot', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
  ]),
  'population-initializer.js': Object.freeze([
    { name: 'POPULATION_INITIALIZER_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'INITIAL_POPULATION_DEFAULTS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    {
      name: 'sampleInitialGenotype',
      kind: 'pure',
      callerCollections: ['config.initialSuspensionTypes'],
      callerNumbers: ['config.symmetricProbability', 'config.minInitialPowerGene', 'config.minAxles', 'config.maxAxles'],
    },
    {
      name: 'createInitialPopulation',
      kind: 'pure',
      callerCollections: ['config.initialSuspensionTypes'],
      callerNumbers: ['config.seed', 'config.populationSize', 'config.symmetricProbability', 'config.minInitialPowerGene'],
    },
    {
      name: 'serializePopulationInitialization',
      kind: 'encoder',
      callerCollections: ['initialization.config.initialSuspensionTypes', 'initialization.population.individuals'],
      callerNumbers: ['initialization.seed', 'initialization.populationSnapshotDigestState'],
    },
    { name: 'deserializePopulationInitialization', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
  ]),
  'population-evaluation.js': Object.freeze([
    { name: 'FITNESS_POLICY_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'FITNESS_VECTOR_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'EVALUATION_SPEC_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'POPULATION_WORLD_MODE', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'REALIZABLE_SUSPENSION_TYPES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'SPAWN_CLEARANCE', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'isVehicleResultValid', kind: 'validator', callerCollections: [], callerNumbers: [] },
    { name: 'isVehicleResultSelectable', kind: 'validator', callerCollections: [], callerNumbers: [] },
    { name: 'fitnessFromVehicleResult', kind: 'pure', callerCollections: [], callerNumbers: ['vehicleResult.maxForwardDistance'] },
    {
      name: 'spawnPoseOnFlatStart',
      kind: 'pure',
      callerCollections: ['ir.axles'],
      callerNumbers: ['ir.chassis.aabb.min.y', 'wheel.radius', 'transform.local.y', 'options.x', 'options.z', 'options.clearance'],
    },
    {
      name: 'serializeEvaluationSpec',
      kind: 'encoder',
      callerCollections: ['resolvedSpec.terrain.<range> (6 of them)'],
      callerNumbers: ['maxSteps', 'spawn.x', 'spawn.z', 'spawn.clearance', 'targetWheelSurfaceSpeed', 'wheelFriction', 'every terrain scalar'],
    },
    { name: 'deserializeEvaluationSpec', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
    {
      name: 'evaluatePopulation',
      kind: 'orchestrator',
      callerCollections: ['population.individuals', 'evaluationSpec.terrain.<range>'],
      callerNumbers: ['evaluationSpec.maxSteps', 'evaluationSpec.spawn.*'],
    },
    {
      name: 'serializeFitnessVector',
      kind: 'encoder',
      callerCollections: ['evaluation.individuals'],
      callerNumbers: ['individualId', 'fitness', 'populationSnapshotDigestState', 'evaluationSpecDigestState'],
    },
    { name: 'deserializeFitnessVector', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'championFromEvaluation', kind: 'pure', callerCollections: ['evaluation.individuals'], callerNumbers: ['fitness', 'individualId'] },
    { name: 'selectableChampionFromEvaluation', kind: 'pure', callerCollections: ['evaluation.individuals'], callerNumbers: ['fitness', 'individualId'] },
  ]),
});

describe('(1) export-surface conformance — nothing ships unclassified', () => {
  for (const [module, expected] of Object.entries(EXPECTED_EXPORTS)) {
    test(`${module} exports exactly the declared surface`, () => {
      expect(Object.keys(NAMESPACES[module]).sort()).toEqual([...expected].sort());
    });

    test(`${module}: every export carries a role classification`, () => {
      const rows = EXPORT_ROLES[module];
      expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(NAMESPACES[module]).sort());
      // No duplicate rows hiding a missing one behind an equal count.
      expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
      for (const row of rows) {
        expect(KINDS, `${row.name}.kind`).toContain(row.kind);
        expect(Array.isArray(row.callerCollections), `${row.name}.callerCollections`).toBe(true);
        expect(Array.isArray(row.callerNumbers), `${row.name}.callerNumbers`).toBe(true);
      }
    });
  }

  test('the declared surface is a set, not a multiset, across all five modules', () => {
    const all = Object.values(EXPECTED_EXPORTS).flatMap((names) => [...names]);
    // Names are globally unique in this family, which is what lets the
    // ownership verdicts below be keyed by bare name.
    expect(new Set(all).size).toBe(all.length);
  });
});

// ============================================================================
// (2) THE SHADOWED-GEOMETRY BATTERY
// ============================================================================
//
// `length`, `byteLength`, `byteOffset` and `buffer` are inherited ACCESSORS on
// %TypedArray%.prototype. `Object.defineProperty` on a GENUINE Uint8Array
// shadows each with an own DATA property — ordinary JavaScript, no Proxy, and
// `instanceof Uint8Array` stays true. Every function in this repo that takes
// bytes from a caller must read the RUNTIME's geometry, so a shadowed claim
// changes NOTHING about the value it returns.
//
// THE ASSERTION SHAPE IS LOAD-BEARING. A "does it throw?" tooth is not a test
// of this rule: it scored `deserializeFitnessVector` GREEN while that decoder
// was FALSELY REJECTING a byte-identical, perfectly valid canonical vector
// (it read the caller-shadowable `bytes.byteLength` for its exact-length
// identity, so a shadowed claim made a decoder STRICTER than its own encoder —
// the exact-inverse contract failing in the direction nobody tests for). Each
// row below therefore declares its outcome: `identical` means the returned
// VALUE equals the un-shadowed call bit for bit; `rejects` means it must fail
// in the OWNING MODULE's dialect. Nothing here may surface a foreign
// TypeError/RangeError.

const DIALECTS = Object.freeze({
  bytes: /^bytes: /,
  assembly: /^assembly: /,
  population: /^population: /,
  'population-evaluation': /^population-evaluation: /,
  'population-initializer': /^population-initializer: /,
  fnv1a: /^fnv1a: /,
  trace: /^trace: /,
});

const PAD = 8;

// The un-shadowed control: the SAME subarray geometry as the hostile view, so
// the comparison isolates the shadow and nothing else.
function baseView(valid) {
  const parent = new Uint8Array(PAD + valid.length + PAD).fill(0xa7);
  parent.set(valid, PAD);
  return parent.subarray(PAD, PAD + valid.length);
}

function shadowed(valid, prop, value) {
  const view = baseView(valid);
  Object.defineProperty(view, prop, { value, configurable: true });
  return view;
}

// Six lies over the four geometry properties: each length-ish property is
// claimed both SHORT (the truncation class — a digest attesting a prefix) and
// LONG (the overrun class), byteOffset claims the padded parent's head, and
// buffer redirects to a foreign backing store of identical size.
function geometryLies(n) {
  const foreign = new Uint8Array(PAD + n + PAD).fill(0x5a).buffer;
  return [
    ['length', Math.max(0, n - 2)],
    ['length', n + 2],
    ['byteLength', Math.max(0, n - 2)],
    ['byteLength', n + 2],
    ['byteOffset', 0],
    ['buffer', foreign],
  ];
}

const genericBytes = () => Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x01, 0x02);
const genotypeBytes = () => serializeGenotype(canonicalGenotype());
const snapshotBytes = () => serializePopulationSnapshot(twoMemberPopulation());
const specBytes = () => serializeEvaluationSpec(resolvedFlat());
const vectorBytes = () => serializeFitnessVector(synthEvaluation());
const initBytes = () => serializePopulationInitialization(
  createInitialPopulation({ seed: 123456, populationSize: 2 }),
);
const traceBytes = () => encodeTraceRecord(baseTraceRecord());

// A fail idiom in the bytes dialect, so a reader rejection is attributable.
const readerFail = (path, value) => {
  throw new Error(`bytes: probe rejected at ${path} (${String(value)})`);
};

const BYTE_CONSUMERS = Object.freeze([
  {
    name: 'createByteReader',
    module: 'bytes',
    outcome: 'identical',
    bytes: genericBytes,
    call: (b) => {
      const r = createByteReader(b, readerFail);
      const head = r.u32('head');
      const tail = [...r.bytes(r.remaining, 'tail')];
      return { byteLength: r.byteLength, offset: r.offset, head, tail };
    },
  },
  { name: 'bytesToHex', module: 'bytes', outcome: 'identical', bytes: genericBytes, call: (b) => bytesToHex(b) },
  { name: 'typedArrayByteLength', module: 'bytes', outcome: 'identical', bytes: genericBytes, call: (b) => typedArrayByteLength(b) },
  {
    // bytesEqual lives in population.js but delegates its geometry read to
    // bytes.js — a rejection would speak the `bytes:` dialect. It must not
    // reject: a shadowed `length: 2` once made deadbeef compare EQUAL to
    // dead0000, i.e. the canonicality tooth would have accepted a
    // non-canonical genotype from the one comparison it exists to make.
    name: 'bytesEqual',
    module: 'bytes',
    outcome: 'identical',
    bytes: genericBytes,
    call: (b) => [
      bytesEqual(b, genericBytes()),
      bytesEqual(b, Uint8Array.of(0xde, 0xad, 0xbe, 0xef)),
      bytesEqual(Uint8Array.of(0xde, 0xad, 0xbe, 0xef), b),
    ],
  },
  { name: 'fnv1aFold', module: 'fnv1a', outcome: 'identical', bytes: genericBytes, call: (b) => fnv1aFold(FNV_OFFSET_BASIS, b) },
  { name: 'fnv1aHex', module: 'fnv1a', outcome: 'identical', bytes: genericBytes, call: (b) => fnv1aHex(b) },
  { name: 'deserializeGenotype', module: 'assembly', outcome: 'identical', bytes: genotypeBytes, call: (b) => deserializeGenotype(b) },
  {
    name: 'deserializePopulationSnapshot',
    module: 'population',
    outcome: 'identical',
    bytes: snapshotBytes,
    call: (b) => deserializePopulationSnapshot(b),
  },
  {
    name: 'deserializeEvaluationSpec',
    module: 'population-evaluation',
    outcome: 'identical',
    bytes: specBytes,
    call: (b) => deserializeEvaluationSpec(b),
  },
  {
    name: 'deserializeFitnessVector',
    module: 'population-evaluation',
    outcome: 'identical',
    bytes: vectorBytes,
    call: (b) => deserializeFitnessVector(b),
  },
  {
    name: 'deserializePopulationInitialization',
    module: 'population-initializer',
    outcome: 'identical',
    bytes: initBytes,
    call: (b) => deserializePopulationInitialization(b),
  },
  {
    // Here the caller's Uint8Array is the OUT buffer, not the input: the
    // RECORD_BYTES size check must consult the runtime, or a 128-byte buffer
    // claiming `byteLength: 126` gets refused and one claiming 130 gets a
    // short write.
    name: 'encodeTraceRecord',
    module: 'trace',
    outcome: 'identical',
    bytes: () => new Uint8Array(RECORD_BYTES),
    call: (b) => {
      encodeTraceRecord(baseTraceRecord(), b);
      return Array.from({ length: RECORD_BYTES }, (_, i) => b[i]);
    },
  },
  { name: 'decodeTraceRecord', module: 'trace', outcome: 'identical', bytes: traceBytes, call: (b) => decodeTraceRecord(b) },
  {
    // The divergence REPORTER: `records` entries may be caller Uint8Arrays, and
    // its report quotes raw bytes back (`expectedBytes`/`actualBytes` hex, via
    // a windowed sub-view). A diagnostic that reads a caller's CLAIM would
    // localize the divergence in the wrong field and print bytes that are not
    // in the stream — the failure mode where the instrument lies about the
    // failure it was called to explain.
    name: 'compareTraces',
    module: 'trace',
    outcome: 'identical',
    bytes: traceBytes,
    call: (b) => {
      const other = encodeTraceRecord({ ...baseTraceRecord(), linvel: { x: -4.5, y: 5.5, z: -6.25 } });
      const side = (records) => ({ version: EVALUATION_TRACE_VERSION, recordBytes: RECORD_BYTES, records });
      return compareTraces(side([b]), side([other]));
    },
  },
]);

describe('(2) shadowed geometry — a caller\'s CLAIM never changes a returned value', () => {
  test('every byte-consuming export in the repo is in the battery', () => {
    // The declared inventory, so a new byte consumer has to be added here
    // deliberately rather than inheriting silence. Enumerated from
    // `grep -rn 'instanceof Uint8Array' src/` — eight acceptance sites
    // (assembly×1, bytes×3, fnv1a×1, trace×3) plus the four functions that
    // reach bytes only through createByteReader/typedArrayByteLength.
    // trace-forensics' analyzeTrace is deliberately absent: it never reads
    // geometry itself, it delegates every byte to decodeTraceRecord.
    expect(BYTE_CONSUMERS.map((c) => c.name).sort()).toEqual([
      'bytesEqual', 'bytesToHex', 'compareTraces', 'createByteReader',
      'decodeTraceRecord', 'deserializeEvaluationSpec', 'deserializeFitnessVector',
      'deserializeGenotype', 'deserializePopulationInitialization',
      'deserializePopulationSnapshot', 'encodeTraceRecord', 'fnv1aFold', 'fnv1aHex',
      'typedArrayByteLength',
    ]);
    for (const c of BYTE_CONSUMERS) {
      expect(DIALECTS[c.module], c.name).toBeDefined();
      expect(['identical', 'rejects'], c.name).toContain(c.outcome);
    }
  });

  for (const consumer of BYTE_CONSUMERS) {
    test(`${consumer.name}: shadowed length/byteLength/byteOffset/buffer are inert`, () => {
      const valid = consumer.bytes();
      const expected = consumer.call(baseView(consumer.bytes()));
      for (const [prop, lie] of geometryLies(valid.length)) {
        const label = `${consumer.name} with own ${prop}=${prop === 'buffer' ? 'foreign ArrayBuffer' : String(lie)}`;
        const hostile = shadowed(consumer.bytes(), prop, lie);
        expect(hostile instanceof Uint8Array, label).toBe(true);
        expect(Object.hasOwn(hostile, prop), label).toBe(true);
        if (consumer.outcome === 'rejects') {
          expect(() => consumer.call(hostile), label).toThrow(DIALECTS[consumer.module]);
          continue;
        }
        let got;
        try {
          got = consumer.call(hostile);
        } catch (err) {
          // A shadowed geometry read must never surface a FOREIGN error; if a
          // function ever legitimately rejects one, it declares outcome
          // 'rejects' above and speaks its own dialect here.
          expect(err.message, `${label} threw`).toMatch(DIALECTS[consumer.module]);
          throw new Error(`${label} rejected a VALID stream: ${err.message}`);
        }
        assertBitEqual(got, expected, label);
      }
    });
  }

  test('the compareTraces row compares a REAL divergence report, not two nulls', () => {
    // Premise for that battery row: without a genuine mismatch carrying quoted
    // bytes, the row would compare `null` to `null` and prove nothing.
    const report = BYTE_CONSUMERS.find((c) => c.name === 'compareTraces').call(baseView(traceBytes()));
    expect(report.kind).toBe('fieldMismatch');
    expect(report.field).toBe('linvel.z');
    expect(report.expectedBytes).not.toBe(report.actualBytes);
    expect(report.expectedBytes).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the shadows are real — an UNGUARDED read of the same views is wrong', () => {
    // The premise, so none of the rows above can pass vacuously: reading the
    // caller's claims (what the pre-fix code did) genuinely produces different
    // answers. If this ever stops failing, the battery is measuring nothing.
    const valid = genericBytes();
    const shortLen = shadowed(valid, 'length', 2);
    expect(shortLen.length).toBe(2); // the CLAIM
    expect(typedArrayByteLength(shortLen)).toBe(6); // the runtime
    const foreign = shadowed(valid, 'buffer', new Uint8Array(PAD + valid.length + PAD).fill(0x5a).buffer);
    expect(new Uint8Array(foreign.buffer, foreign.byteOffset, 4)[0]).toBe(0x5a); // the CLAIM
    expect(bytesToHex(foreign).slice(0, 8)).toBe('deadbeef'); // the runtime
  });
});

// ============================================================================
// (3) THE SPECIES LEG — the tooth the old suite got wrong
// ============================================================================

describe('(3) sub-views are CONSTRUCTED by the module, not selected by the caller', () => {
  // %TypedArray%.prototype.subarray performs TypedArraySpeciesCreate: it reads
  // `bytes.constructor`, then `constructor[Symbol.species]`, and CONSTRUCTS
  // whatever it finds — so the "sub-view" is whatever caller code returned.
  // `constructor` is INHERITED, so a plain defineProperty on a GENUINE
  // Uint8Array reaches it. No Proxy, no lying prototype.
  //
  // tests/bytes.test.js's "an own subarray property is never invoked by
  // r.bytes" asserts something STRICTLY WEAKER: the species path never touches
  // an own `subarray` property, so it passed while the rule was violated. That
  // test stays where it is (it pins a different, still-true fact); this one
  // asserts the RULE, on the VALUE.
  //
  // MEASURED, pre-fix: a 1052-byte snapshot stream containing genotype A
  // decoded to genotype B and re-encoded to 796 DIFFERENT bytes —
  // serialize(deserialize(x)) !== x — with every bounds check and expectEnd
  // still passing, because those track the cursor, not the returned view.

  const FOREIGN = new Uint8Array([0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99]);

  function withHostileSpecies(bytes) {
    let consulted = 0;
    function ForeignSpecies() { return FOREIGN; }
    Object.defineProperty(bytes, 'constructor', {
      configurable: true,
      value: {
        get [Symbol.species]() { consulted += 1; return ForeignSpecies; },
      },
    });
    return { bytes, species: () => consulted };
  }

  test('r.bytes returns a genuine Uint8Array over the REAL window', () => {
    const { bytes: u } = withHostileSpecies(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    const r = createByteReader(u, readerFail);
    const out = r.bytes(4, 'x');
    // THE VALUE — asserted first and on its own; this is the rule.
    expect([...out]).toEqual([1, 2, 3, 4]);
    expect(out).not.toBe(FOREIGN);
    expect(out instanceof Uint8Array).toBe(true);
    expect(out.constructor).toBe(Uint8Array); // the module's own %Uint8Array%
    // And the cursor advanced by what was actually handed back.
    expect(r.offset).toBe(4);
    expect([...r.bytes(4, 'y')]).toEqual([5, 6, 7, 8]);
  });

  test('a subarray window under hostile species still reads its OWN window', () => {
    const parent = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 1, 2, 3, 4]);
    const { bytes: window } = withHostileSpecies(parent.subarray(4, 8));
    const r = createByteReader(window, readerFail);
    expect([...r.bytes(4, 'w')]).toEqual([1, 2, 3, 4]);
  });

  test('a snapshot stream with a hostile species round-trips byte-identically', () => {
    const original = snapshotBytes();
    const { bytes: hostile } = withHostileSpecies(Uint8Array.from(original));
    const decoded = deserializePopulationSnapshot(hostile);
    expect(decoded.individuals.map((i) => i.individualId)).toEqual([3, 9]);
    // The genotypes the stream CONTAINS, not whatever the species produced.
    assertBitEqual(decoded.individuals[0].genotype, canonicalGenotype(0.25), 'individuals[0].genotype');
    assertBitEqual(decoded.individuals[1].genotype, canonicalGenotype(0.75), 'individuals[1].genotype');
    expect(bytesEqual(serializePopulationSnapshot(decoded), original)).toBe(true);
  });

  test('compareTraces quotes the REAL bytes of a hostile-species record', () => {
    // The SECOND species site in the repo: trace.js's `taWindow` builds the
    // hex quoted in a fieldMismatch report. Its comment says "Never
    // `subarray` ... Diagnostics must report the real bytes" — nothing bound
    // that until here. A species-produced window makes the divergence report
    // print bytes that are not in the stream, i.e. the instrument lies about
    // the failure it was called to explain. NOTE the geometry battery cannot
    // reach this: `subarray` reads INTERNAL slots, so shadowing
    // byteOffset/buffer leaves it correct — species is the only lever.
    const honest = traceBytes();
    const hostile = Uint8Array.from(honest);
    withHostileSpecies(hostile);
    const other = encodeTraceRecord({ ...baseTraceRecord(), linvel: { x: -4.5, y: 5.5, z: -6.25 } });
    const side = (records) => ({ version: EVALUATION_TRACE_VERSION, recordBytes: RECORD_BYTES, records });
    const report = compareTraces(side([hostile]), side([other]));
    const control = compareTraces(side([honest]), side([other]));
    expect(report.kind).toBe('fieldMismatch');
    expect(report.field).toBe('linvel.z');
    expect(report.expectedBytes).toBe(control.expectedBytes);
    expect(report.expectedBytes).not.toMatch(/^9999/); // the species payload
  });

  test('the hostile species is real — %TypedArray%.subarray DOES consult it', () => {
    // The premise, so the three value assertions above cannot pass vacuously:
    // the same defineProperty genuinely redirects the engine's own subarray.
    const { bytes: u, species } = withHostileSpecies(Uint8Array.of(1, 2, 3, 4));
    expect(Uint8Array.prototype.subarray.call(u, 0, 4)).toBe(FOREIGN);
    expect(species()).toBeGreaterThan(0);
  });
});

// ============================================================================
// (4) COPY-ON-INTAKE AND NO RETAINED REFERENCE
// ============================================================================
//
// Driven by section 1's table: every export whose `callerCollections` is
// non-empty must declare a verdict here, so a new one cannot ship with its
// ownership question unanswered.
//
//   ownedCopy    — nothing reachable in the result is reference-identical to
//                  anything reachable in the caller's input.
//   freshBytes   — returns a module-allocated Uint8Array over its own buffer.
//   scalar       — returns no object at all.
//   sharedWindow — deliberately returns a view over the CALLER's buffer
//                  (documented on the function; the caller must not retain it
//                  mutably).
//   callerElements — DELIBERATE EXCEPTION: hands back the caller's own objects.
//   notExercised — real behaviour, owned by a suite this pure file cannot run.

const OWNERSHIP_VERDICTS = Object.freeze({
  // bytes.js
  createByteReader: 'sharedWindow',
  typedArrayByteLength: 'scalar',
  bytesToHex: 'scalar',
  // assembly.js
  validateGenotype: 'scalar',
  repairGenotype: 'ownedCopy',
  compileAssembly: 'ownedCopy',
  serializeGenotype: 'freshBytes',
  forEachGenotypeField: 'ownedCopy',
  deserializeGenotype: 'ownedCopy',
  // population.js
  bytesEqual: 'scalar',
  validatePopulation: 'callerElements',
  serializePopulationSnapshot: 'freshBytes',
  attestPopulation: 'ownedCopy',
  deserializePopulationSnapshot: 'ownedCopy',
  // population-initializer.js
  sampleInitialGenotype: 'ownedCopy',
  createInitialPopulation: 'ownedCopy',
  serializePopulationInitialization: 'freshBytes',
  deserializePopulationInitialization: 'ownedCopy',
  // population-evaluation.js
  spawnPoseOnFlatStart: 'ownedCopy',
  serializeEvaluationSpec: 'freshBytes',
  deserializeEvaluationSpec: 'ownedCopy',
  evaluatePopulation: 'notExercised',
  serializeFitnessVector: 'freshBytes',
  deserializeFitnessVector: 'ownedCopy',
  championFromEvaluation: 'callerElements',
  selectableChampionFromEvaluation: 'callerElements',
});

const VERDICTS = Object.freeze([
  'ownedCopy', 'freshBytes', 'scalar', 'sharedWindow', 'callerElements', 'notExercised',
]);

// Every `callerElements` verdict, each a predicate that DEMONSTRATES the
// exception by identity. Keyed by export name and asserted set-equal to the
// declared verdicts, so a new exception cannot be declared without being shown.
function callerElementsCases() {
  const population = twoMemberPopulation();
  const evaluation = {
    individuals: [
      { individualId: 0, fitness: 1.5, valid: true, integrityStatus: 'ok' },
      { individualId: 3, fitness: 9.5, valid: true, integrityStatus: 'ok' },
    ],
  };
  return {
    validatePopulation: () => validatePopulation(population)[0] === population.individuals[0],
    championFromEvaluation: () => championFromEvaluation(evaluation) === evaluation.individuals[1],
    selectableChampionFromEvaluation:
      () => selectableChampionFromEvaluation(evaluation) === evaluation.individuals[1],
  };
}

// The `ownedCopy` cases, each a real call with plain data.
function ownedCopyCases() {
  const g = canonicalGenotype();
  const population = twoMemberPopulation();
  const cats = ['S0', 'S1'];
  const initConfig = { seed: 123456, populationSize: 2, initialSuspensionTypes: cats };
  const ir = compileAssembly(canonicalGenotype());
  const spawn = { x: -45, z: 0, clearance: SPAWN_CLEARANCE };
  const gBytes = genotypeBytes();
  const sBytes = snapshotBytes();
  const spBytes = specBytes();
  const vBytes = vectorBytes();
  const iBytes = initBytes();
  const entries = [];
  return [
    { name: 'repairGenotype', result: repairGenotype(g), roots: [g] },
    { name: 'compileAssembly', result: compileAssembly(g), roots: [g] },
    {
      name: 'forEachGenotypeField',
      result: (() => { forEachGenotypeField(g, (e) => entries.push(e)); return entries; })(),
      roots: [g],
    },
    { name: 'deserializeGenotype', result: deserializeGenotype(gBytes), roots: [gBytes] },
    { name: 'attestPopulation', result: attestPopulation(population), roots: [population] },
    { name: 'deserializePopulationSnapshot', result: deserializePopulationSnapshot(sBytes), roots: [sBytes] },
    {
      name: 'sampleInitialGenotype',
      result: sampleInitialGenotype(new Rng(123456).fork(0), { initialSuspensionTypes: cats }),
      roots: [cats],
    },
    { name: 'createInitialPopulation', result: createInitialPopulation(initConfig), roots: [initConfig] },
    { name: 'deserializePopulationInitialization', result: deserializePopulationInitialization(iBytes), roots: [iBytes] },
    { name: 'spawnPoseOnFlatStart', result: spawnPoseOnFlatStart(ir, spawn), roots: [ir, spawn] },
    { name: 'deserializeEvaluationSpec', result: deserializeEvaluationSpec(spBytes), roots: [spBytes] },
    { name: 'deserializeFitnessVector', result: deserializeFitnessVector(vBytes), roots: [vBytes] },
  ];
}

function freshBytesCases() {
  const g = canonicalGenotype();
  const population = twoMemberPopulation();
  const init = createInitialPopulation({ seed: 123456, populationSize: 2 });
  const spec = resolvedFlat();
  const evaluation = synthEvaluation();
  return [
    { name: 'serializeGenotype', result: serializeGenotype(g), roots: [g] },
    { name: 'serializePopulationSnapshot', result: serializePopulationSnapshot(population), roots: [population] },
    { name: 'serializePopulationInitialization', result: serializePopulationInitialization(init), roots: [init] },
    { name: 'serializeEvaluationSpec', result: serializeEvaluationSpec(spec), roots: [spec] },
    { name: 'serializeFitnessVector', result: serializeFitnessVector(evaluation), roots: [evaluation] },
  ];
}

describe('(4) copy-on-intake — the module owns what it hands back', () => {
  test('every export that reads a caller collection declares an ownership verdict', () => {
    const withCollections = Object.values(EXPORT_ROLES)
      .flatMap((rows) => rows.filter((r) => r.callerCollections.length > 0).map((r) => r.name))
      .sort();
    expect(Object.keys(OWNERSHIP_VERDICTS).sort()).toEqual(withCollections);
    for (const [name, verdict] of Object.entries(OWNERSHIP_VERDICTS)) {
      expect(VERDICTS, name).toContain(verdict);
    }
  });

  test('the ownedCopy / freshBytes case lists cover their verdicts exactly', () => {
    const declared = (v) => Object.entries(OWNERSHIP_VERDICTS)
      .filter(([, verdict]) => verdict === v).map(([name]) => name).sort();
    expect(ownedCopyCases().map((c) => c.name).sort()).toEqual(declared('ownedCopy'));
    expect(freshBytesCases().map((c) => c.name).sort()).toEqual(declared('freshBytes'));
  });

  test('every callerElements verdict is EXERCISED, not just spelled legally', () => {
    // The gap this closes was real and in this file: the table declared both
    // champion selectors `callerElements` while a test below asserted they
    // returned a module-owned row — the opposite — and the suite stayed green,
    // because the only generic check was `VERDICTS.toContain(verdict)`, i.e.
    // that the LABEL is a legal string. A verdict nothing exercises is a
    // comment with a colon in it. Every `callerElements` entry must have a case
    // here that actually demonstrates the exception.
    const declared = Object.entries(OWNERSHIP_VERDICTS)
      .filter(([, v]) => v === 'callerElements').map(([name]) => name).sort();
    expect(Object.keys(callerElementsCases()).sort()).toEqual(declared);
    for (const [name, demonstrate] of Object.entries(callerElementsCases())) {
      expect(demonstrate(), `${name} does not return the caller's own object`).toBe(true);
    }
  });

  for (const c of ownedCopyCases()) {
    test(`${c.name}: no caller-owned object survives into the result`, () => {
      assertNoReferenceEscape(c.result, c.roots, c.name);
    });
  }

  for (const c of freshBytesCases()) {
    test(`${c.name}: returns module-allocated bytes over its own buffer`, () => {
      expect(c.result instanceof Uint8Array).toBe(true);
      expect(c.result.byteOffset).toBe(0);
      expect(c.result.byteLength).toBe(c.result.buffer.byteLength);
      assertNoReferenceEscape({ bytes: c.result }, c.roots, c.name);
    });
  }

  test('the attestation reads each member scalar EXACTLY ONCE', () => {
    // The blocker this pins: `validatedMembers` read `ind.individualId` five
    // times (validate, duplicate-check, Set insert, error text, sort) and both
    // consumers read it again off the stored member. With an own accessor —
    // ordinary JavaScript, no Proxy — one member was VALIDATED as id 0,
    // ENCODED as id 7, and RETURNED by attestPopulation as id 9. Three
    // identities for one member, which defeats the whole point of an
    // attestation: evaluatePopulation hashes the bytes and compiles the
    // returned members, and its comment claims those are one object.
    const genotype = canonicalGenotype();
    let idReads = 0;
    let genotypeReads = 0;
    const walk = [0, 0, 0, 7, 9, 9, 9, 9];
    const population = {
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      individuals: [{
        get individualId() { idReads += 1; return walk[idReads - 1] ?? 9; },
        get genotype() { genotypeReads += 1; return genotype; },
      }],
    };

    const attested = attestPopulation(population);
    expect(idReads, 'individualId read more than once').toBe(1);
    expect(genotypeReads, 'genotype read more than once').toBe(1);

    // The three identities that used to disagree must now be the same one.
    const decoded = deserializePopulationSnapshot(attested.bytes);
    expect(attested.individuals[0].individualId).toBe(0);
    expect(decoded.individuals[0].individualId).toBe(0);
    expect(decoded.individuals).toHaveLength(attested.individuals.length);
  });

  test('attestPopulation decodes each genotype from the bytes it attests', () => {
    // The strongest form of the rule: not merely "a copy", but a copy produced
    // by the codec from the exact stream the canonicality tooth approved — so
    // "what was compiled" and "what was hashed" are one object rather than two
    // reads that happened to agree.
    const population = twoMemberPopulation();
    const attested = attestPopulation(population);
    expect(attested.individuals).toHaveLength(2);
    for (let i = 0; i < attested.individuals.length; i += 1) {
      const source = population.individuals[i].genotype;
      const owned = attested.individuals[i].genotype;
      expect(owned).not.toBe(source);
      expect(owned.axles).not.toBe(source.axles);
      expect(owned.axles[0]).not.toBe(source.axles[0]);
      expect(owned.frame.segments[0].nodes[0]).not.toBe(source.frame.segments[0].nodes[0]);
      assertBitEqual(owned, source, `individuals[${i}].genotype`);
    }
    expect(bytesEqual(attested.bytes, serializePopulationSnapshot(population))).toBe(true);
  });

  test('DELIBERATE EXCEPTION — validatePopulation returns the CALLER\'s objects', () => {
    // Documented in population.js: a GATE hands the caller's own records back
    // in canonical order and attests NOTHING; deep-copying on every validation
    // would be pure cost. Anything that must BIND what it validated calls
    // `attestPopulation`, which returns module-owned genotypes decoded from the
    // bytes it attested. Gate vs attestation — do not blur it.
    //
    // Pinned here so a future change to EITHER function has to come to this
    // file and choose deliberately, rather than drift silently.
    const population = twoMemberPopulation();
    const sorted = validatePopulation(population);
    expect(sorted).not.toBe(population.individuals); // the ARRAY is the module's
    expect(sorted[0]).toBe(population.individuals[0]); // the MEMBERS are the caller's
    expect(sorted[1]).toBe(population.individuals[1]);
    expect(sorted[0].genotype).toBe(population.individuals[0].genotype);
  });

  test('DELIBERATE EXCEPTION — champion selectors return the caller\'s WINNING row', () => {
    // The verdict table says `callerElements`, and this asserts exactly that,
    // because these helpers have always handed back the winning evaluation row
    // and production rows carry a full `diagnostics` block that the diagnostic
    // selector exists to report. Returning a compact four-field summary would
    // silently narrow a working API under cover of hardening.
    //
    // What IS owned is the JUDGEMENT: championCandidate captures every compared
    // field once and the comparators read only those captures, so an own
    // accessor cannot show the validator one value and the comparator another.
    // Owned values decide; the caller's row comes back.
    const evaluation = {
      individuals: [
        { individualId: 0, fitness: 1.5, valid: true, integrityStatus: 'ok', diagnostics: { note: 'a' } },
        { individualId: 3, fitness: 9.5, valid: true, integrityStatus: 'ok', diagnostics: { note: 'b' } },
      ],
    };
    for (const champion of [
      championFromEvaluation(evaluation),
      selectableChampionFromEvaluation(evaluation),
    ]) {
      expect(champion).toBe(evaluation.individuals[1]); // the caller's row itself
      expect(champion.diagnostics.note).toBe('b'); // diagnostics survive
    }
  });

  test('champion selectors read each compared field EXACTLY ONCE', () => {
    // The poisoning route this closes: an own accessor that answers the
    // validator with an in-domain value and the comparator with another. Read
    // counts are the direct evidence; the permutation-invariance tooth in
    // population-evaluation.test.js is the behavioural half.
    const counts = { individualId: 0, fitness: 0, valid: 0, integrityStatus: 0 };
    const row = (id, fit) => ({
      get individualId() { counts.individualId += 1; return id; },
      get fitness() { counts.fitness += 1; return fit; },
      get valid() { counts.valid += 1; return true; },
      get integrityStatus() { counts.integrityStatus += 1; return 'ok'; },
    });
    const evaluation = { individuals: [row(0, 1.5), row(3, 9.5)] };
    championFromEvaluation(evaluation);
    for (const [field, n] of Object.entries(counts)) {
      expect(n, `${field} was read ${n} times across 2 rows`).toBe(2);
    }
  });

  test('sharedWindow — r.bytes deliberately views the caller\'s buffer, no copy', () => {
    // Declared, not accidental: the JSDoc says "no copy; the caller must not
    // retain it mutably". What section 3 pins is that the VIEW is genuine and
    // over the real window; the buffer sharing is the documented contract.
    const source = Uint8Array.of(1, 2, 3, 4);
    const view = createByteReader(source, readerFail).bytes(4, 'all');
    expect(view).not.toBe(source);
    expect(view.buffer).toBe(source.buffer);
    expect([...view]).toEqual([1, 2, 3, 4]);
  });

  test('scalar verdicts return no object at all', () => {
    expect(typedArrayByteLength(genericBytes())).toBe(6);
    expect(bytesToHex(Uint8Array.of(0xde, 0xad))).toBe('dead');
    expect(bytesEqual(genericBytes(), genericBytes())).toBe(true);
    expect(validateGenotype(canonicalGenotype())).toBeUndefined();
  });

  test('notExercised — evaluatePopulation is declared, and named to its owner', () => {
    // It steps physics worlds; this file is pure. Its ownership behaviour (one
    // attestPopulation walk producing both the canonical bytes and the
    // module-owned genotypes that are compiled) is covered by
    // tests/population-evaluation.test.js and the population determinism gate.
    // Declared rather than omitted, so the surface stays complete.
    expect(typeof EvaluationNS.evaluatePopulation).toBe('function');
    expect(OWNERSHIP_VERDICTS.evaluatePopulation).toBe('notExercised');
  });
});

describe('(4b) attestation records are deep-frozen; working objects deliberately are not', () => {
  test('the three attestation decoders return fully frozen records', () => {
    // A digest has already been folded over these bytes, so a caller mutating
    // the decoded record afterwards would let it disagree with what it attests.
    assertDeepFrozen(deserializeEvaluationSpec(specBytes()), 'evaluationSpec');
    assertDeepFrozen(deserializeFitnessVector(vectorBytes()), 'fitnessVector');
    assertDeepFrozen(deserializePopulationInitialization(initBytes()), 'initialization');
  });

  test('deserializePopulationSnapshot and deserializeGenotype are deliberately UNFROZEN', () => {
    // A population is a live working object, not an attestation:
    // createInitialPopulation returns exactly this shape unfrozen and Phase 1B
    // replaces individuals generation over generation. Canonicality is enforced
    // at the seams (validatePopulation in, serializePopulationSnapshot out),
    // never by immutability.
    //
    // RECORDED, because the JSDoc in population.js used to claim there was only
    // ONE unfrozen decoder: `deserializeGenotype` is likewise unfrozen — and
    // for the same reason (a genotype is mutation's working object). Two, not
    // one.
    const snapshot = deserializePopulationSnapshot(snapshotBytes());
    expect(Object.isFrozen(snapshot)).toBe(false);
    expect(Object.isFrozen(snapshot.individuals)).toBe(false);
    expect(Object.isFrozen(snapshot.individuals[0].genotype)).toBe(false);

    const genotype = deserializeGenotype(genotypeBytes());
    expect(Object.isFrozen(genotype)).toBe(false);
    expect(Object.isFrozen(genotype.axles)).toBe(false);
    expect(Object.isFrozen(genotype.axles[0])).toBe(false);
  });
});

describe('(4c) the canonicality gate cannot be walked past by ordinary caller data', () => {
  test('a repair-MOVING raw draw is still refused when reached through attestPopulation', () => {
    // The premise first: seed 20260710 fork 3 really is a non-canonical draw,
    // so this is a detectable violation and not a vacuous pass.
    const raw = randomGenotype(new Rng(20260710).fork(3));
    const canonical = repairGenotype(raw);
    expect(bytesEqual(serializeGenotype(raw), serializeGenotype(canonical))).toBe(false);
    expect(() => attestPopulation(pop([{ individualId: 0, genotype: raw }])))
      .toThrow(/is not canonical — repair moved it/);
    // And the canonical form attests cleanly, decoded from its own bytes.
    const attested = attestPopulation(pop([{ individualId: 0, genotype: canonical }]));
    expect(attested.individuals[0].genotype).not.toBe(canonical);
    assertBitEqual(attested.individuals[0].genotype, canonical, 'attested');
  });
});
