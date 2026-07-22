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
import * as EvolutionNS from '../src/sim/evolution-operators.js';
import * as EvolutionContractNS from '../src/sim/evolution-contract.js';
import * as EvolutionLineageNS from '../src/sim/evolution-lineage.js';
import * as EvolutionRunNS from '../src/sim/evolution-run.js';
import * as EvolutionHistoryNS from '../src/sim/evolution-history.js';
import * as EvolutionReplayNS from '../src/sim/evolution-replay.js';
import * as Sha256NS from '../src/platform/sha256.js';
import * as IntegrityNS from '../src/sim/integrity.js';
import * as TraceNS from '../src/sim/trace.js';
import * as ForensicsNS from '../src/sim/trace-forensics.js';
import * as RunnerNS from '../src/sim/evaluation.js';
import * as Fnv1aNS from '../src/sim/fnv1a.js';

import { FNV_OFFSET_BASIS, fnv1aFold, fnv1aHex } from '../src/sim/fnv1a.js';
import {
  EVALUATION_TRACE_VERSION, RECORD_BYTES, compareCheckpoints, compareTraces,
  decodeTraceRecord, encodeTraceRecord,
} from '../src/sim/trace.js';
import { createIntegrityState, foldIntegrity } from '../src/sim/integrity.js';
import {
  analyzeTrace, bodyReachMetadataForIR, offlineIntegrityView,
} from '../src/sim/trace-forensics.js';
import {
  deserializeLineage, serializeLineage, zeroLineageAccounting,
} from '../src/sim/evolution-lineage.js';
import {
  assembleHistory, decodeEvolutionHeader, decodeGenerationPayload, decodeHistoryFraming,
  deserializeEvaluationMetadata, digestComponent, digestGeneration, digestHeader,
  digestHistoryBody, digestsEqual, encodeEvolutionHeader, encodeGenerationPayload,
  serializeEvaluationMetadata,
} from '../src/sim/evolution-history.js';
import { sha256 } from '../src/platform/sha256.js';
import {
  captureExpectedIdentity, failReplayDivergence, firstByteDifference,
  verifyHistoryArtifact,
} from '../src/sim/evolution-replay.js';
import { resumeEvolutionRun } from '../src/sim/evolution-run.js';
import { EvolutionError, evolutionFail } from '../src/sim/evolution-contract.js';
import { TERRAIN_DEFAULTS } from '../src/sim/terrain.js';
import { Rng } from '../src/sim/prng.js';
import { runInNewContext as vmRunInNewContext } from 'node:vm';

const {
  bytesToHex, copyOrdinaryBytes, createByteReader, requireOrdinaryBytes, typedArrayByteLength,
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
  SPAWN_CLEARANCE, canonicalizeEvaluationSpec, championFromEvaluation, deserializeEvaluationSpec,
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
    'bytesToHex', 'copyOrdinaryBytes', 'createByteReader', 'hexToBytes',
    'requireOrdinaryBytes', 'typedArrayByteLength',
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
    'INITIAL_POPULATION_DEFAULTS', 'MAX_POPULATION_SIZE', 'POPULATION_INITIALIZER_VERSION',
    'createInitialPopulation', 'deserializePopulationInitialization',
    'sampleInitialGenotype', 'serializePopulationInitialization',
  ]),
  'population-evaluation.js': Object.freeze([
    'EVALUATION_SPEC_VERSION', 'FITNESS_POLICY_VERSION', 'FITNESS_VECTOR_VERSION',
    'POPULATION_WORLD_MODE', 'REALIZABLE_SUSPENSION_TYPES', 'SELECTION_POOL_VERSION', 'SPAWN_CLEARANCE',
    'canonicalizeEvaluationSpec', 'championFromEvaluation', 'deserializeEvaluationSpec',
    'deserializeFitnessVector',
    'evaluatePopulation', 'fitnessFromVehicleResult', 'isVehicleResultSelectable',
    'isVehicleResultValid', 'selectableChampionFromEvaluation', 'selectablePoolFromEvaluation',
    'serializeEvaluationSpec', 'serializeFitnessVector', 'spawnPoseOnFlatStart',
  ]),
  'evolution-operators.js': Object.freeze([
    'ELITE_COUNT', 'ELITISM_VERSION', 'PARAMETRIC_MUTATION_DEFAULTS', 'PARAMETRIC_MUTATION_VERSION',
    'SELECTION_POOL_VERSION', 'TOURNAMENT_SELECTION_VERSION', 'TOURNAMENT_SIZE',
    'mutateContinuousGenotype', 'selectElites', 'selectTournamentParent',
  ]),
  // PR 3's evolution family. `evolution-contract.js` is the leaf every other
  // evolution module binds (error taxonomy, terminal enum, caps); it has no
  // imports of its own, which is what keeps the family cycle-free.
  'evolution-contract.js': Object.freeze([
    'EVOLUTION_ENGINE_VERSION', 'EVOLUTION_ERROR_CODES', 'EVOLUTION_POLICY_VERSION',
    'EvolutionError', 'MAX_EVOLUTION_GENERATIONS', 'MAX_EVOLUTION_POPULATION_SIZE',
    'TERMINAL_REASONS', 'checkedAdd', 'checkedMultiply', 'evolutionFail',
    'isEvolutionUint32',
  ]),
  'evolution-lineage.js': Object.freeze([
    'EVOLUTION_LINEAGE_VERSION', 'LINEAGE_ACCOUNTING_KEYS', 'LINEAGE_NO_PARENT',
    'LINEAGE_ORIGINS', 'crossCheckLineage', 'deserializeLineage', 'lineageByteLength',
    'serializeLineage', 'validateLineage', 'zeroLineageAccounting',
  ]),
  'evolution-run.js': Object.freeze([
    'EVOLUTION_ENGINE_VERSION', 'EVOLUTION_POLICY_VERSION', 'TERMINAL_REASONS',
    'createEvolutionRun', 'resumeEvolutionRun',
  ]),
  'evolution-replay.js': Object.freeze([
    'MAX_EVOLUTION_HISTORY_BYTES', 'REPLAY_STAGES', 'captureExpectedIdentity',
    'checkExpectedIdentity', 'checkRuntimeIdentity', 'failReplayDivergence',
    'firstByteDifference', 'verifyHistoryArtifact',
  ]),
  'evolution-history.js': Object.freeze([
    'COMPONENT_KINDS', 'EVALUATION_METADATA_VERSION', 'EVOLUTION_DIGEST_DOMAINS',
    'EVOLUTION_HISTORY_MAGIC', 'EVOLUTION_HISTORY_VERSION', 'GENERATION_RECORD_VERSION',
    'MAX_EVOLUTION_COMPONENT_BYTES', 'MAX_EVOLUTION_HISTORY_BYTES',
    'MAX_EVOLUTION_RECORD_BYTES', 'SHA256_DIGEST_BYTES', 'WORLD_MODES',
    'assembleHistory', 'decodeEvolutionHeader', 'decodeGenerationPayload',
    'decodeHistoryFraming', 'deserializeEvaluationMetadata', 'digestComponent',
    'digestGeneration', 'digestHeader', 'digestHistoryBody', 'digestsEqual',
    'encodeEvolutionHeader', 'encodeGenerationPayload', 'serializeEvaluationMetadata',
  ]),
  // The platform adapter is INSIDE this family by ruling, not beside it: it is
  // a byte seam whose output is persisted artifact identity.
  'sha256.js': Object.freeze(['SHA256_DIGEST_BYTES', 'sha256']),
  // Round 11: these five were UNPINNED while tests/single-read.test.js:250-252
  // cited this file as the backstop that forces a new export into its table
  // ("an unlisted export fails there first"). For 47 exports across five
  // modules — four of which this PR rewrote under the ownership rulings, and
  // three of which carry single-read CASES rows — that backstop did not exist.
  // A claim of universal-by-construction enforcement is only true of FIELDS if
  // the MODULE list is itself enumerated by hand and incomplete.
  'integrity.js': Object.freeze([
    'INTEGRITY_POLICY_VERSION', 'INTEGRITY_REASONS', 'INTEGRITY_REFERENCE_CAPTURE_DT',
    'INTEGRITY_STATUS', 'INTEGRITY_THRESHOLDS', 'createIntegrityState', 'dist3',
    'finalizeIntegrity', 'foldIntegrity', 'norm3', 'norm3xyz',
  ]),
  'trace.js': Object.freeze([
    'BODY_ROLES', 'EVALUATION_TRACE_VERSION', 'JOINT_STATES', 'MAX_AXLE_INDEX',
    'MAX_STEP_INDEX', 'MAX_VEHICLE_INDEX', 'MAX_WHEEL_INDEX', 'NO_INDEX',
    'RECORD_BYTES', 'TERMINATION_REASONS', 'TRACE_FIELDS', 'TRACE_MODES',
    'TraceWriter', 'compareCheckpoints', 'compareTraces', 'decodeTraceRecord',
    'encodeTraceRecord',
  ]),
  'trace-forensics.js': Object.freeze([
    'FORENSIC_THRESHOLD_DEFAULTS', 'REFERENCE_CAPTURE_DT', 'TRACE_FORENSICS_SCHEMA',
    'analyzeTrace', 'bodyReachMetadataForIR', 'offlineIntegrityView', 'scaledThresholds',
  ]),
  'evaluation.js': Object.freeze([
    'EVALUATION_TRACE_VERSION', 'RUN_TERMINATION', 'TERMINATION_REASONS',
    'createProgressState', 'foldProgress', 'readBodyState', 'runEvaluation',
    'runRealizedEvaluationLoop',
  ]),
  'fnv1a.js': Object.freeze([
    'FNV_OFFSET_BASIS', 'FNV_PRIME', 'fnv1aFold', 'fnv1aHex', 'fnv1aHexOf',
  ]),
});

// Names that appear in a module's namespace but are BINDINGS OWNED ELSEWHERE.
// Declared, because the ownership verdicts are keyed by bare name and would
// otherwise collide — and asserted reference-identical below, so this cannot
// become cover for two modules exporting different values under one name.
const RE_EXPORTS = Object.freeze({
  'evaluation.js': Object.freeze(['EVALUATION_TRACE_VERSION', 'TERMINATION_REASONS']),
  'evolution-operators.js': Object.freeze(['SELECTION_POOL_VERSION']),
  'evolution-run.js': Object.freeze([
    'EVOLUTION_ENGINE_VERSION', 'EVOLUTION_POLICY_VERSION', 'TERMINAL_REASONS',
  ]),
  'evolution-history.js': Object.freeze(['SHA256_DIGEST_BYTES']),
  'evolution-replay.js': Object.freeze(['MAX_EVOLUTION_HISTORY_BYTES']),
});

// Which module OWNS each re-exported binding. Declared rather than inferred:
// the identity check below used a hard-coded ternary over two modules, which
// silently stopped scaling the moment a third re-exporting module shipped.
const RE_EXPORT_OWNER = Object.freeze({
  'evaluation.js': 'trace.js',
  'evolution-operators.js': 'population-evaluation.js',
  'evolution-run.js': 'evolution-contract.js',
  'evolution-history.js': 'sha256.js',
  'evolution-replay.js': 'evolution-history.js',
});

const NAMESPACES = Object.freeze({
  'bytes.js': BytesNS,
  'assembly.js': AssemblyNS,
  'population.js': PopulationNS,
  'population-initializer.js': InitializerNS,
  'population-evaluation.js': EvaluationNS,
  'evolution-operators.js': EvolutionNS,
  'evolution-contract.js': EvolutionContractNS,
  'evolution-lineage.js': EvolutionLineageNS,
  'evolution-run.js': EvolutionRunNS,
  'evolution-history.js': EvolutionHistoryNS,
  'evolution-replay.js': EvolutionReplayNS,
  'sha256.js': Sha256NS,
  'integrity.js': IntegrityNS,
  'trace.js': TraceNS,
  'trace-forensics.js': ForensicsNS,
  // evaluation.js imports the adapter, whose Rapier load is INSIDE
  // createPhysics (a dynamic import) — so this stays a pure module-graph read.
  'evaluation.js': RunnerNS,
  'fnv1a.js': Fnv1aNS,
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
    { name: 'requireOrdinaryBytes', kind: 'validator', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'typedArrayByteLength', kind: 'pure', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'bytesToHex', kind: 'encoder', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'copyOrdinaryBytes', kind: 'pure', callerCollections: ['bytes'], callerNumbers: [] },
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
    { name: 'MAX_POPULATION_SIZE', kind: 'policy', callerCollections: [], callerNumbers: [] },
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
    { name: 'SELECTION_POOL_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
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
    // Resolves the caller's spec once and returns the bytes PLUS the record
    // decoded from them; the returned spec shares nothing with the input.
    {
      name: 'canonicalizeEvaluationSpec',
      kind: 'encoder',
      callerCollections: ['spec.terrain.<range>'],
      callerNumbers: ['spec.maxSteps', 'spec.spawn.*', 'spec.terrain.*'],
    },
    { name: 'championFromEvaluation', kind: 'pure', callerCollections: ['evaluation.individuals'], callerNumbers: ['fitness', 'individualId'] },
    { name: 'selectableChampionFromEvaluation', kind: 'pure', callerCollections: ['evaluation.individuals'], callerNumbers: ['fitness', 'individualId'] },
    { name: 'selectablePoolFromEvaluation', kind: 'pure', callerCollections: ['evaluation.individuals'], callerNumbers: ['fitnessPolicyVersion', 'fitness', 'individualId', 'populationSnapshotDigestState'] },
  ]),
  'evolution-operators.js': Object.freeze([
    { name: 'SELECTION_POOL_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'TOURNAMENT_SELECTION_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'ELITISM_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'PARAMETRIC_MUTATION_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'TOURNAMENT_SIZE', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'ELITE_COUNT', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'PARAMETRIC_MUTATION_DEFAULTS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'selectTournamentParent', kind: 'pure', callerCollections: ['pool.evaluatedIndividualIds', 'pool.individuals'], callerNumbers: ['pool.populationSnapshotDigestState', 'fitness', 'individualId'] },
    { name: 'selectElites', kind: 'pure', callerCollections: ['population.individuals', 'pool.evaluatedIndividualIds', 'pool.individuals'], callerNumbers: ['pool.populationSnapshotDigestState', 'fitness', 'individualId'] },
    { name: 'mutateContinuousGenotype', kind: 'pure', callerCollections: ['parent'], callerNumbers: ['options.probability', 'options.magnitude'] },
  ]),
  'evolution-contract.js': Object.freeze([
    { name: 'EVOLUTION_ENGINE_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'EVOLUTION_POLICY_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'EVOLUTION_ERROR_CODES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'TERMINAL_REASONS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_EVOLUTION_POPULATION_SIZE', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_EVOLUTION_GENERATIONS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    // The error type COPIES its context by key enumeration and coerces every
    // non-scalar to a string, so no caller object — and no history buffer —
    // can be retained by a thrown diagnostic.
    { name: 'EvolutionError', kind: 'pure', callerCollections: ['context'], callerNumbers: [] },
    { name: 'evolutionFail', kind: 'pure', callerCollections: ['context'], callerNumbers: [] },
    { name: 'isEvolutionUint32', kind: 'validator', callerCollections: [], callerNumbers: ['v'] },
    { name: 'checkedAdd', kind: 'pure', callerCollections: [], callerNumbers: ['a', 'b'] },
    { name: 'checkedMultiply', kind: 'pure', callerCollections: [], callerNumbers: ['a', 'b'] },
  ]),
  'evolution-lineage.js': Object.freeze([
    { name: 'EVOLUTION_LINEAGE_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'LINEAGE_ORIGINS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'LINEAGE_NO_PARENT', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'LINEAGE_ACCOUNTING_KEYS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'lineageByteLength', kind: 'pure', callerCollections: [], callerNumbers: ['count'] },
    { name: 'zeroLineageAccounting', kind: 'pure', callerCollections: [], callerNumbers: [] },
    { name: 'validateLineage', kind: 'validator', callerCollections: ['lineage.individuals'], callerNumbers: [] },
    { name: 'serializeLineage', kind: 'encoder', callerCollections: ['lineage.individuals'], callerNumbers: [] },
    { name: 'deserializeLineage', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'crossCheckLineage', kind: 'validator', callerCollections: ['individualIds', 'previousIndividualIds'], callerNumbers: [] },
  ]),
  'evolution-run.js': Object.freeze([
    { name: 'EVOLUTION_ENGINE_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'EVOLUTION_POLICY_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'TERMINAL_REASONS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    // The config's own array (initialSuspensionTypes) is copied by index at
    // intake; nothing caller-owned survives into run state.
    { name: 'createEvolutionRun', kind: 'orchestrator', callerCollections: ['initialization.initialSuspensionTypes'], callerNumbers: [] },
    { name: 'resumeEvolutionRun', kind: 'orchestrator', callerCollections: ['historyBytes', 'options.expectedHistoryDigestBytes'], callerNumbers: ['options.expectedGenerationIndex'] },
  ]),
  'evolution-replay.js': Object.freeze([
    { name: 'REPLAY_STAGES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_EVOLUTION_HISTORY_BYTES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'firstByteDifference', kind: 'pure', callerCollections: ['expected', 'actual'], callerNumbers: [] },
    { name: 'failReplayDivergence', kind: 'pure', callerCollections: ['expected', 'actual'], callerNumbers: [] },
    { name: 'verifyHistoryArtifact', kind: 'validator', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'checkExpectedIdentity', kind: 'validator', callerCollections: [], callerNumbers: ['expected.generationIndex'] },
    { name: 'checkRuntimeIdentity', kind: 'validator', callerCollections: [], callerNumbers: [] },
    { name: 'captureExpectedIdentity', kind: 'validator', callerCollections: ['options.expectedHistoryDigestBytes'], callerNumbers: ['options.expectedGenerationIndex'] },
  ]),
  'evolution-history.js': Object.freeze([
    { name: 'EVOLUTION_HISTORY_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'GENERATION_RECORD_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'EVALUATION_METADATA_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'EVOLUTION_HISTORY_MAGIC', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'EVOLUTION_DIGEST_DOMAINS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'COMPONENT_KINDS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'WORLD_MODES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'SHA256_DIGEST_BYTES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_EVOLUTION_COMPONENT_BYTES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_EVOLUTION_RECORD_BYTES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_EVOLUTION_HISTORY_BYTES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'serializeEvaluationMetadata', kind: 'encoder', callerCollections: [], callerNumbers: ['metadata.effectiveDt', 'metadata.executedSteps'] },
    { name: 'deserializeEvaluationMetadata', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'encodeEvolutionHeader', kind: 'encoder', callerCollections: ['header.initializationManifestBytes', 'header.evaluationSpecBytes'], callerNumbers: ['header.populationSize', 'header.maxGenerations'] },
    { name: 'decodeEvolutionHeader', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'encodeGenerationPayload', kind: 'encoder', callerCollections: ['record.components', 'componentDigests'], callerNumbers: ['record.generationIndex'] },
    { name: 'decodeGenerationPayload', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'digestHeader', kind: 'pure', callerCollections: ['headerBytes'], callerNumbers: [] },
    { name: 'digestComponent', kind: 'pure', callerCollections: ['componentBytes'], callerNumbers: [] },
    { name: 'digestGeneration', kind: 'pure', callerCollections: ['previousDigestBytes', 'payloadBytes'], callerNumbers: [] },
    { name: 'digestHistoryBody', kind: 'pure', callerCollections: ['bodyBytes'], callerNumbers: [] },
    { name: 'digestsEqual', kind: 'pure', callerCollections: ['a', 'b'], callerNumbers: [] },
    { name: 'assembleHistory', kind: 'encoder', callerCollections: ['headerBytes', 'headerDigestBytes', 'generations'], callerNumbers: [] },
    // DELIBERATE EXCEPTION, documented on the function: the returned header and
    // payload views ALIAS the input, which is what keeps the 64 MiB peak-memory
    // model honest. Its contract is "module-owned bytes only".
    { name: 'decodeHistoryFraming', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
  ]),
  'sha256.js': Object.freeze([
    { name: 'SHA256_DIGEST_BYTES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'sha256', kind: 'pure', callerCollections: ['bytes'], callerNumbers: [] },
  ]),
  'integrity.js': Object.freeze([
    { name: 'INTEGRITY_POLICY_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'INTEGRITY_THRESHOLDS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'INTEGRITY_STATUS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'INTEGRITY_REASONS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'INTEGRITY_REFERENCE_CAPTURE_DT', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'norm3', kind: 'pure', callerCollections: [], callerNumbers: ['v.x', 'v.y', 'v.z'] },
    { name: 'norm3xyz', kind: 'pure', callerCollections: [], callerNumbers: ['x', 'y', 'z'] },
    { name: 'dist3', kind: 'pure', callerCollections: [], callerNumbers: ['a.*', 'b.*'] },
    { name: 'createIntegrityState', kind: 'pure', callerCollections: [], callerNumbers: ['bodyCount', 'captureDt'] },
    {
      name: 'foldIntegrity',
      kind: 'pure',
      callerCollections: ['reads'],
      callerNumbers: ['read.linvel.*', 'read.translation.*'],
    },
    { name: 'finalizeIntegrity', kind: 'pure', callerCollections: [], callerNumbers: [] },
  ]),
  'trace.js': Object.freeze([
    { name: 'EVALUATION_TRACE_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'RECORD_BYTES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'TRACE_FIELDS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'TRACE_MODES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'BODY_ROLES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'JOINT_STATES', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'TERMINATION_REASONS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'NO_INDEX', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_STEP_INDEX', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_VEHICLE_INDEX', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_AXLE_INDEX', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'MAX_WHEEL_INDEX', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'encodeTraceRecord', kind: 'encoder', callerCollections: [], callerNumbers: ['record.translation.*', 'record.rotation.*', 'record.linvel.*', 'record.angvel.*'] },
    { name: 'decodeTraceRecord', kind: 'decoder', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'TraceWriter', kind: 'encoder', callerCollections: [], callerNumbers: ['record.*'] },
    { name: 'compareTraces', kind: 'pure', callerCollections: ['expected.records', 'actual.records'], callerNumbers: [] },
    { name: 'compareCheckpoints', kind: 'pure', callerCollections: ['expected', 'actual'], callerNumbers: ['stepIndex', 'recordCount', 'byteCount', 'state'] },
  ]),
  'trace-forensics.js': Object.freeze([
    { name: 'TRACE_FORENSICS_SCHEMA', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'FORENSIC_THRESHOLD_DEFAULTS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'REFERENCE_CAPTURE_DT', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'scaledThresholds', kind: 'pure', callerCollections: [], callerNumbers: ['dtScale', 'thresholds.*'] },
    { name: 'bodyReachMetadataForIR', kind: 'pure', callerCollections: ['ir.axles'], callerNumbers: ['wheel.radius', 'wheel.width', 'hub.radius', 'hub.halfWidth', 'chassis.supports.reach'] },
    { name: 'analyzeTrace', kind: 'pure', callerCollections: ['traceResult.records', 'options.bodies'], callerNumbers: ['captureDt', 'thresholds.*'] },
    { name: 'offlineIntegrityView', kind: 'pure', callerCollections: ['analysis.perBody'], callerNumbers: [] },
  ]),
  'evaluation.js': Object.freeze([
    { name: 'EVALUATION_TRACE_VERSION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'TERMINATION_REASONS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'RUN_TERMINATION', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'createProgressState', kind: 'pure', callerCollections: [], callerNumbers: [] },
    { name: 'foldProgress', kind: 'pure', callerCollections: [], callerNumbers: ['translation.x'] },
    // The engine seam: `body` is a Rapier handle, not caller data.
    { name: 'readBodyState', kind: 'pure', callerCollections: [], callerNumbers: [] },
    {
      name: 'runEvaluation',
      kind: 'orchestrator',
      callerCollections: ['options.vehicles', 'options.terrain.<range>'],
      // spawn.rotation.*/linvel.* were omitted (F10): the documentary table
      // agreed with the defect (they were captured by reference, C8) instead of
      // naming the full surface.
      callerNumbers: ['maxSteps', 'spawn.position.*', 'spawn.rotation.*', 'spawn.linvel.*', 'targetWheelSurfaceSpeed', 'wheelFriction'],
    },
    // Takes ALREADY-REALIZED bodies and a module-owned option object from
    // runEvaluation; the investigation seam passes its own literals.
    // ROUND 14 — the classification WAS the defect. Documenting the seam as
    // taking no caller collections effectively exempted it from the
    // hostile-collection battery, and `realized.map`/`.flatMap`/for-of let a
    // hostile own `.map` produce vehicles.length === 0 while the world still
    // stepped `maxSteps` — silent contradiction. The seam is now walked by
    // captured integer index over BOTH `realized` and each `realized[].wheels`;
    // classify honestly so the battery actually exercises it.
    { name: 'runRealizedEvaluationLoop', kind: 'orchestrator', callerCollections: ['realized', 'realized[].wheels'], callerNumbers: ['requestedDt', 'maxSteps'] },
  ]),
  'fnv1a.js': Object.freeze([
    { name: 'FNV_OFFSET_BASIS', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'FNV_PRIME', kind: 'policy', callerCollections: [], callerNumbers: [] },
    { name: 'fnv1aFold', kind: 'pure', callerCollections: ['bytes'], callerNumbers: [] },
    { name: 'fnv1aHex', kind: 'pure', callerCollections: [], callerNumbers: [] },
    { name: 'fnv1aHexOf', kind: 'pure', callerCollections: [], callerNumbers: [] },
  ]),
});

// ============================================================================
// (0) THE ENFORCEMENT SCOPE ITSELF
// ============================================================================
//
// Round 11: the byte-family lint block scopes itself with a HARD-CODED
// seven-file list, and nothing pinned it. The same probe file placed elsewhere
// in src/sim produced zero diagnostics, so a future byte module (Phase 1B's
// operator streams, lineage encoding) would start with no enforcement at all
// and nobody would be told. No test in this repo enumerated a directory, so
// both this list and the export tables above were enumerations a new module
// joins only if someone remembers.
//
// This reads the real config and the real directory, and forces every src/sim
// module into exactly one of two buckets: linted by the byte family, or
// EXEMPT WITH A STATED REASON. A new file fails here until it is classified.

const BYTE_FAMILY_EXEMPT = Object.freeze({
  'src/sim/prng.js': 'the PRNG itself: uint32 arithmetic, no caller byte buffers',
  'src/sim/noise.js': 'pure hash-based field sampling over module-owned scalars',
  'src/sim/terrain.js': 'generates module-owned typed arrays from a config; takes no caller bytes',
  'src/sim/features.js': 'pure descriptor -> geometry over module-owned arrays',
  'src/sim/integrity.js': 'reads caller RECORD objects, not byte buffers (single-read table covers it)',
  'src/sim/trace-forensics.js': 'consumes decoded records via trace.js; holds no byte geometry of its own',
  'src/sim/evaluation.js': 'orchestrates physics; the trace bytes it holds come from TraceWriter',
  'src/sim/evaluation-fixtures.js': 'declared fixture literals',
  'src/sim/evaluation-locks.js': 'golden literals only, zero imports',
  'src/sim/population-fixtures.js': 'declared fixture literals',
  'src/sim/population-locks.js': 'golden literals only, zero imports',
  'src/sim/evolution-operators.js': 'plain population/pool/genotype inputs; serializes only module-owned canonical data',
  'src/sim/evolution-contract.js': 'error taxonomy, terminal enum, caps and checked arithmetic; no byte buffers, no caller collections beyond a scalar-copied error context',
  'src/sim/evolution-fixtures.js': 'declared fixture literals',
  'src/sim/evolution-locks.js': 'golden literals only, zero imports',
  'src/sim/lock-markers.js': 'message-format constants',
  'src/sim/physics/adapter.js': 'the Rapier seam; trusts compiler-owned IRs by standing ruling',
});

// The byte-family scope is derived from the RULES, not from one block's name.
// Round 13 found it by `files.includes('src/sim/bytes.js')` — a single-block
// lookup that silently stopped covering the family the moment PR 3 split the
// platform adapter into its own block (same rules, different determinism
// policy). Matching on the shared selector means any future block that spreads
// BYTE_SAFETY_SYNTAX joins the enforced surface automatically.
const BYTE_SAFETY_MARKER = 'subarray is banned here';

async function byteFamilyFiles() {
  const { default: config } = await import('../eslint.config.js');
  const blocks = config.filter((b) => Array.isArray(b.files)
    && b.rules && Array.isArray(b.rules['no-restricted-syntax'])
    && b.rules['no-restricted-syntax'].some((r) => typeof r === 'object' && r !== null
      && typeof r.message === 'string' && r.message.includes(BYTE_SAFETY_MARKER)));
  expect(blocks.length, 'at least one block must carry the byte-safety rules').toBeGreaterThan(0);
  return blocks.flatMap((b) => [...b.files]);
}

describe('(0) the byte-family lint scope covers every byte-owning module', () => {
  test('each module is either linted by the byte family or exempt with a reason', async () => {
    const { readdirSync } = await import('node:fs');
    const files = await byteFamilyFiles();

    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(`${dir}/${e.name}`) : (e.name.endsWith('.js') ? [`${dir}/${e.name}`] : [])
    ));
    // src/platform joins the walk with PR 3: the SHA-256 adapter is a byte seam
    // whose output is persisted artifact identity, so leaving it outside the
    // derivation would exempt it by directory rather than by decision.
    const modules = [...walk('src/sim'), ...walk('src/platform')].sort();
    expect(modules.length).toBeGreaterThan(15); // the enumeration is not vacuous

    const linted = new Set(files);
    const exempt = new Set(Object.keys(BYTE_FAMILY_EXEMPT));
    const unclassified = modules.filter((m) => !linted.has(m) && !exempt.has(m));
    expect(unclassified, 'classify these in BYTE_FAMILY_EXEMPT or add them to the lint block').toEqual([]);
    // No stale entries on either side, so the table cannot drift into fiction.
    expect([...linted].filter((f) => !modules.includes(f))).toEqual([]);
    expect([...exempt].filter((f) => !modules.includes(f))).toEqual([]);
    // And the two buckets are disjoint: an exemption must be a real exemption.
    expect([...exempt].filter((f) => linted.has(f))).toEqual([]);
  });

  // F2: checking the `files` LIST is not enough — flat-config REPLACES
  // `no-restricted-syntax`, so the byte-family block silently stripped the
  // D7/F3 determinism bans from these 7 files while the list still "covered"
  // them. Resolve the REAL config for a byte-family file and lint a snippet:
  // `x ** 2` must be flagged there, proving the determinism ban survives the
  // block that overrides the rule.
  test('the D7 determinism syntax bans actually fire in a byte-family file (not just the src/sim files)', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint();
    const [result] = await eslint.lintText('const y = x ** 2;\n', { filePath: 'src/sim/assembly.js' });
    const messages = result.messages.map((m) => m.message).join(' | ');
    expect(messages, `assembly.js is byte-family AND src/sim; got: ${messages}`).toMatch(/\*\* operator/);
    // And a control: a non-sim file does NOT ban it.
    const [render] = await eslint.lintText('const y = x ** 2;\n', { filePath: 'src/render/scene.js' });
    expect(render.messages.map((m) => m.ruleId)).not.toContain('no-restricted-syntax');
  });
});

// ============================================================================
// (0b) THE BYTE-STORAGE INTAKE SURFACE (round 13)
// ============================================================================
//
// Round 12 wrote "requireOrdinaryBytes enforces it at every intake seam" and
// gated TWO seams. An external review then executed fnv1aFold over a detached
// buffer (state returned UNCHANGED — a digest attesting zero bytes it was
// never handed) and bytesEqual over two detached arrays of different former
// content (EQUAL) — the recurring failure shape, again: a rule declared
// universal, enforced at the discovered sites, closed nowhere. This is the
// derived closure. The module SET comes from the byte-family lint block (the
// (0) derivation — the same list, so a file cannot be byte-family for lint
// and invisible here), the export set from the real namespaces, and every
// FUNCTION export must be classified exactly one way:
//
//   'gated'          — accepts caller byte buffers; the storage gate must
//                      fire. The invoke thunk is run against all three fancy
//                      stores (detached / SharedArrayBuffer / resizable) and
//                      must THROW each time.
//   'no-byte-intake' — accepts no raw caller byte buffer (it may RETURN
//                      module-owned bytes); `why` states the reason.
//
// A new export in any byte-family module fails the coverage tooth until it is
// classified, and a byte-accepting helper cannot ship ungated without a
// visibly false 'no-byte-intake' row.

const BYTE_FAMILY_NAMESPACES = Object.freeze({
  'src/sim/bytes.js': BytesNS,
  'src/sim/fnv1a.js': Fnv1aNS,
  'src/sim/trace.js': TraceNS,
  'src/sim/assembly.js': AssemblyNS,
  'src/sim/population.js': PopulationNS,
  'src/sim/population-initializer.js': InitializerNS,
  'src/sim/population-evaluation.js': EvaluationNS,
  'src/sim/evolution-lineage.js': EvolutionLineageNS,
  'src/sim/evolution-run.js': EvolutionRunNS,
  'src/sim/evolution-history.js': EvolutionHistoryNS,
  'src/sim/evolution-replay.js': EvolutionReplayNS,
  'src/platform/sha256.js': Sha256NS,
});

const storageProbeFail = (path, value) => {
  throw new Error(`storage-probe: invalid at ${path} (${String(value)})`);
};
const storageEnvelope = (records) => ({
  version: EVALUATION_TRACE_VERSION, recordBytes: RECORD_BYTES, records,
});

// Every gate runs BEFORE any length/shape check (verified per module), so one
// 128-byte fancy input reaches all of them regardless of the format it fails.
const BYTE_STORAGE_INTAKE = Object.freeze({
  'src/sim/bytes.js': {
    requireOrdinaryBytes: { intake: 'gated', invoke: (u) => requireOrdinaryBytes(u, storageProbeFail) },
    createByteReader: { intake: 'gated', invoke: (u) => createByteReader(u, storageProbeFail) },
    bytesToHex: { intake: 'gated', invoke: (u) => bytesToHex(u) },
    copyOrdinaryBytes: { intake: 'gated', invoke: (u) => copyOrdinaryBytes(u) },
    typedArrayByteLength: { intake: 'gated', invoke: (u) => typedArrayByteLength(u) },
    hexToBytes: { intake: 'no-byte-intake', why: 'string in; returns fresh module-owned bytes' },
  },
  'src/sim/fnv1a.js': {
    fnv1aFold: { intake: 'gated', invoke: (u) => fnv1aFold(FNV_OFFSET_BASIS, u) },
    fnv1aHex: { intake: 'gated', invoke: (u) => fnv1aHex(u) },
    fnv1aHexOf: { intake: 'no-byte-intake', why: 'uint32 state in, hex string out' },
  },
  'src/sim/trace.js': {
    decodeTraceRecord: { intake: 'gated', invoke: (u) => decodeTraceRecord(u) },
    // The out-gate runs before record validation, so no valid record needed.
    encodeTraceRecord: { intake: 'gated', invoke: (u) => encodeTraceRecord({}, u) },
    compareTraces: { intake: 'gated', invoke: (u) => compareTraces(storageEnvelope([u]), storageEnvelope([u])) },
    compareCheckpoints: { intake: 'no-byte-intake', why: 'checkpoint rows are numbers (uint32 states), no byte buffers' },
    TraceWriter: { intake: 'no-byte-intake', why: 'record() takes plain records; emits module-owned bytes only (finish() output mutability: the DEFERRED round-13 ruling, expiry narrowed to the semantic non-null-trace trigger by PR 3 Commit 0 — see the codec doc §Round 15)' },
  },
  'src/sim/assembly.js': {
    deserializeGenotype: { intake: 'gated', invoke: (u) => deserializeGenotype(u) },
    compileAssembly: { intake: 'no-byte-intake', why: 'genotype object in, IR out' },
    forEachGenotypeField: { intake: 'no-byte-intake', why: 'genotype object + visitor in' },
    genotypeByteLength: { intake: 'no-byte-intake', why: 'axle count in, number out' },
    genotypeFieldWalk: { intake: 'no-byte-intake', why: 'axle count in, metadata out' },
    hubMassProperties: { intake: 'no-byte-intake', why: 'wheel record in, plain record out' },
    randomGenotype: { intake: 'no-byte-intake', why: 'rng in, genotype out' },
    repairGenotype: { intake: 'no-byte-intake', why: 'genotype object in/out' },
    serializeGenotype: { intake: 'no-byte-intake', why: 'genotype object in; returns fresh module-owned bytes' },
    validateGenotype: { intake: 'no-byte-intake', why: 'genotype object in' },
    wheelMass: { intake: 'no-byte-intake', why: 'wheel record in, number out' },
  },
  'src/sim/population.js': {
    // Arg `a` probed here; the b-side battery lives in tests/population.test.js.
    bytesEqual: { intake: 'gated', invoke: (u) => bytesEqual(u, Uint8Array.of(1)) },
    deserializePopulationSnapshot: { intake: 'gated', invoke: (u) => deserializePopulationSnapshot(u) },
    attestPopulation: { intake: 'no-byte-intake', why: 'population object in; returns module-owned bytes + decoded genotypes' },
    isCanonicalUint32: { intake: 'no-byte-intake', why: 'number in, boolean out' },
    serializePopulationSnapshot: { intake: 'no-byte-intake', why: 'population object in; returns fresh module-owned bytes' },
    validatePopulation: { intake: 'no-byte-intake', why: 'population object in' },
  },
  'src/sim/population-initializer.js': {
    deserializePopulationInitialization: { intake: 'gated', invoke: (u) => deserializePopulationInitialization(u) },
    createInitialPopulation: { intake: 'no-byte-intake', why: 'config in, population out' },
    sampleInitialGenotype: { intake: 'no-byte-intake', why: 'rng + config in, genotype out' },
    serializePopulationInitialization: { intake: 'no-byte-intake', why: 'initialization object in; returns fresh module-owned bytes' },
  },
  'src/sim/population-evaluation.js': {
    deserializeEvaluationSpec: { intake: 'gated', invoke: (u) => deserializeEvaluationSpec(u) },
    deserializeFitnessVector: { intake: 'gated', invoke: (u) => deserializeFitnessVector(u) },
    championFromEvaluation: { intake: 'no-byte-intake', why: 'evaluation rows in' },
    evaluatePopulation: { intake: 'no-byte-intake', why: 'population + spec objects in' },
    fitnessFromVehicleResult: { intake: 'no-byte-intake', why: 'vehicle result record in' },
    isVehicleResultSelectable: { intake: 'no-byte-intake', why: 'vehicle result record in' },
    isVehicleResultValid: { intake: 'no-byte-intake', why: 'vehicle result record in' },
    selectableChampionFromEvaluation: { intake: 'no-byte-intake', why: 'evaluation rows in' },
    selectablePoolFromEvaluation: { intake: 'no-byte-intake', why: 'evaluation rows in; returns owned immutable pool' },
    serializeEvaluationSpec: { intake: 'no-byte-intake', why: 'spec object in; returns fresh module-owned bytes' },
    serializeFitnessVector: { intake: 'no-byte-intake', why: 'evaluation object in; returns fresh module-owned bytes' },
    spawnPoseOnFlatStart: { intake: 'no-byte-intake', why: 'IR + options in, pose out' },
    canonicalizeEvaluationSpec: { intake: 'no-byte-intake', why: 'spec object in; returns fresh module-owned bytes + the record decoded from them' },
  },
  'src/sim/evolution-lineage.js': {
    deserializeLineage: { intake: 'gated', invoke: (u) => deserializeLineage(u) },
    serializeLineage: { intake: 'no-byte-intake', why: 'lineage object in; returns fresh module-owned bytes' },
    validateLineage: { intake: 'no-byte-intake', why: 'lineage object in' },
    crossCheckLineage: { intake: 'no-byte-intake', why: 'decoded lineage + two id arrays in' },
    lineageByteLength: { intake: 'no-byte-intake', why: 'count in, number out' },
    zeroLineageAccounting: { intake: 'no-byte-intake', why: 'no args' },
  },
  'src/sim/evolution-run.js': {
    createEvolutionRun: { intake: 'no-byte-intake', why: 'config object in, opaque run out' },
    // The resume seam validates and copies in its SYNCHRONOUS prologue, which
    // is why a fancy artifact throws here rather than rejecting later.
    resumeEvolutionRun: { intake: 'gated', invoke: (u) => resumeEvolutionRun(u) },
  },
  'src/sim/evolution-replay.js': {
    verifyHistoryArtifact: { intake: 'gated', invoke: (u) => verifyHistoryArtifact(u) },
    firstByteDifference: { intake: 'gated', invoke: (u) => firstByteDifference(u, Uint8Array.of(1)) },
    failReplayDivergence: {
      intake: 'gated',
      invoke: (u) => failReplayDivergence({
        stage: 'population', generationIndex: 0, expected: u, actual: Uint8Array.of(1), lastAgreedGenerationIndex: null,
      }),
    },
    captureExpectedIdentity: {
      intake: 'gated',
      invoke: (u) => captureExpectedIdentity({ expectedHistoryDigestBytes: u }, (b) => copyOrdinaryBytes(b)),
    },
    checkExpectedIdentity: { intake: 'no-byte-intake', why: 'consumes the module-owned capture captureExpectedIdentity produced' },
    checkRuntimeIdentity: { intake: 'no-byte-intake', why: 'two string records in' },
  },
  'src/sim/evolution-history.js': {
    // Every one of these accepts caller bytes, and every one refuses fancy
    // storage SYNCHRONOUSLY — which is why `assembleHistory` is not an `async
    // function` (a rejected promise would make this battery untestable).
    deserializeEvaluationMetadata: { intake: 'gated', invoke: (u) => deserializeEvaluationMetadata(u) },
    decodeEvolutionHeader: { intake: 'gated', invoke: (u) => decodeEvolutionHeader(u) },
    decodeGenerationPayload: { intake: 'gated', invoke: (u) => decodeGenerationPayload(u) },
    decodeHistoryFraming: { intake: 'gated', invoke: (u) => decodeHistoryFraming(u) },
    digestHeader: { intake: 'gated', invoke: (u) => digestHeader(u) },
    digestComponent: { intake: 'gated', invoke: (u) => digestComponent('population', u) },
    digestGeneration: { intake: 'gated', invoke: (u) => digestGeneration(u, Uint8Array.of(1)) },
    digestHistoryBody: { intake: 'gated', invoke: (u) => digestHistoryBody(u) },
    digestsEqual: { intake: 'gated', invoke: (u) => digestsEqual(u, Uint8Array.of(1)) },
    encodeEvolutionHeader: {
      intake: 'gated',
      invoke: (u) => encodeEvolutionHeader({ ...HISTORY_HEADER_FIXTURE, initializationManifestBytes: u }),
    },
    encodeGenerationPayload: {
      intake: 'gated',
      invoke: (u) => encodeGenerationPayload(
        { generationIndex: 0, terminalReason: 'none', components: { ...HISTORY_COMPONENTS_FIXTURE, population: u } },
        HISTORY_DIGESTS_FIXTURE,
      ),
    },
    assembleHistory: {
      intake: 'gated',
      invoke: (u) => assembleHistory({
        headerBytes: u,
        headerDigestBytes: new Uint8Array(32),
        generations: [{ payloadBytes: Uint8Array.of(1), generationDigestBytes: new Uint8Array(32) }],
      }),
    },
    serializeEvaluationMetadata: { intake: 'no-byte-intake', why: 'metadata record in; returns fresh module-owned bytes' },
  },
  'src/platform/sha256.js': {
    sha256: { intake: 'gated', invoke: (u) => sha256(u) },
  },
});

// Minimal module-owned fixtures for the two history encoders whose byte intake
// is a FIELD rather than the whole argument.
const HISTORY_HEADER_FIXTURE = Object.freeze({
  evolutionEngineVersion: 1,
  evolutionPolicyVersion: 1,
  generationRecordVersion: 1,
  lineageVersion: 1,
  evaluationMetadataVersion: 1,
  tournamentSelectionVersion: 1,
  elitismVersion: 1,
  parametricMutationVersion: 1,
  tournamentSize: 3,
  eliteCount: 2,
  physicsFlavor: 'deterministicCompat',
  packageName: '@dimforge/rapier3d-deterministic-compat',
  rapierVersion: '0.19.3',
  populationSize: 2,
  maxGenerations: 2,
  mutationProbability: 0.05,
  mutationMagnitude: 0.05,
  initializationManifestBytes: Uint8Array.of(1, 2),
  evaluationSpecBytes: Uint8Array.of(3, 4),
});

const HISTORY_COMPONENTS_FIXTURE = Object.freeze({
  population: Uint8Array.of(1),
  evaluationMetadata: serializeEvaluationMetadata({ worldMode: 'isolatedWorlds', effectiveDt: 1 / 60, executedSteps: 1 }),
  fitnessVector: Uint8Array.of(2),
  lineage: Uint8Array.of(3),
});

const HISTORY_DIGESTS_FIXTURE = Object.freeze({
  population: new Uint8Array(32),
  evaluationMetadata: new Uint8Array(32),
  fitnessVector: new Uint8Array(32),
  lineage: new Uint8Array(32),
});

describe('(0b) the byte-storage intake surface is derived and closed', () => {
  test('the classified module set IS the byte-family lint set, and every function export is classified', async () => {
    const families = (await byteFamilyFiles()).sort();
    // A file added to the lint block must join BOTH maps here — the storage
    // surface cannot lag the lint surface.
    expect(Object.keys(BYTE_FAMILY_NAMESPACES).sort()).toEqual(families);
    expect(Object.keys(BYTE_STORAGE_INTAKE).sort()).toEqual(families);
    for (const file of families) {
      const ns = BYTE_FAMILY_NAMESPACES[file];
      const fns = Object.keys(ns).filter((k) => typeof ns[k] === 'function').sort();
      const rows = BYTE_STORAGE_INTAKE[file];
      expect(Object.keys(rows).sort(), `${file}: classify every function export`).toEqual(fns);
      for (const [name, row] of Object.entries(rows)) {
        if (row.intake === 'gated') {
          expect(typeof row.invoke, `${file}#${name}: a gated seam needs an invoke thunk`).toBe('function');
        } else {
          expect(row.intake, `${file}#${name}: unknown intake class`).toBe('no-byte-intake');
          expect(typeof row.why, `${file}#${name}: an exemption needs a stated reason`).toBe('string');
        }
      }
    }
  });

  // Cross-realm was named in the ruling but never in the battery — an
  // implementation drift from `instanceof Uint8Array` to a broader brand
  // check would silently reopen cross-realm acceptance while the other three
  // axes stayed green. Node `vm` produces a genuinely cross-realm Uint8Array
  // (its constructor is a different function from this realm's). The
  // pattern targets the same-realm brand message the current gates fail on.
  // Cross-realm. The FIRST version of this row accepted a regex broad enough
  // to include `invalid` and `unknown key`, and that made it VACUOUS for
  // compareTraces: a cross-realm view is not `instanceof Uint8Array`, so it
  // missed the byte branch entirely, fell through to the plain-record path,
  // and died on its 128 indexed properties as "unknown key" — a rejection for
  // the WRONG reason that the broad regex scored as a storage-gate pass. That
  // is the "test written to the fix, not the rule" failure, committed inside a
  // battery whose whole point is to prove the rule. `compareTraces` now does a
  // realm-neutral `ArrayBuffer.isView` check before selecting the record path,
  // and this row demands the STORAGE diagnosis — the seam must reject it AS
  // foreign bytes, not merely fail somehow.
  const CROSS_REALM_STORE = ['cross-realm', () => vmRunInNewContext('new Uint8Array(128)'),
    /not an ordinary same-realm Uint8Array|Uint8Array required/];

  const FANCY_STORES = [
    ['detached', () => { const u = new Uint8Array(RECORD_BYTES); u.buffer.transfer(); return u; }, /detached/],
    ['SharedArrayBuffer-backed', () => new Uint8Array(new SharedArrayBuffer(RECORD_BYTES)), /SharedArrayBuffer/],
    ['resizable', () => new Uint8Array(new ArrayBuffer(RECORD_BYTES, { maxByteLength: RECORD_BYTES * 2 })), /resizable/],
    CROSS_REALM_STORE,
  ];

  test('every gated seam rejects all four fancy stores loud (round 14 adds cross-realm)', () => {
    for (const [file, rows] of Object.entries(BYTE_STORAGE_INTAKE)) {
      for (const [name, row] of Object.entries(rows)) {
        if (row.intake !== 'gated') continue;
        for (const [axis, make, pattern] of FANCY_STORES) {
          expect(() => row.invoke(make()), `${file}#${name} must reject ${axis}`).toThrow(pattern);
        }
      }
    }
  });
});

// ============================================================================
// (0c) THE CROSS-SIDE COMPARE-MUTATION CLASS — DOCUMENTED-NOT-DEFENDED (round 14)
// ============================================================================
//
// The class: any exported compare/diff function that walks two caller-owned
// collections while both sides are simultaneously live can be tricked by an
// ordinary caller-owned accessor (not a Proxy, no exotic storage) into
// rewriting the OPPOSING side's still-unread evidence to match, producing a
// silent false-identical for genuinely divergent streams.
//
// Round 11 I6 closed one exit (byte-content mutation via a plain-record
// entry — `copy.set(entry)`). The external round-14 review executed a
// different exit through an accessor descriptor on `records[i]`. A first
// attempt to fix the class installed accessor-descriptor pre-scans on both
// sides — which passed the reviewer's exact attack, and then FELL OVER
// against an accessor one level down (`records[i].translation.x`, envelope
// property getters). Refusing accessors at each discovered location is
// site-by-site enumeration, not class closure: there are always more nested
// keys the pre-scan does not cover.
//
// JP's ruling (see the codec doc §Round 14): DEFER, with the failure shape
// stated at both call sites.
//
// THE RATIONALE, CORRECTED (round-14 follow-up). This block first said the
// surface is "diagnostic-only — no lock, no fitness, no selection path
// consumes the return values". That is true of `compareTraces` and FALSE of
// `compareCheckpoints`: all three `test:determinism` files
// (evaluation-determinism, evaluation-golden, population-determinism) and both
// Chromium gates call it, and a lock gate is exactly a caller whose deception
// would matter. The claim was written without grepping the call sites — the
// same unverified-prose failure this suite exists to prevent, committed while
// documenting a deferral. The honest rationale is narrower and stronger:
// BOXCAR3D HAS NO UNTRUSTED INPUT. Every argument reaching these comparators
// is module-owned (TraceWriter output, committed lock literals, codec-decoded
// structures, structured-clone worker payloads), so exploiting the class means
// writing an accessor into this repo's own code to deceive this repo's own
// gates. Real bug, nil exposure. The expiry condition is explicit — and PR 3
// Commit 0 NARROWED it (approved; codec doc §Round 15) from the chronological
// "Phase 1B persists evolution history and reloads it" to the semantic trigger
// it always meant: this hardening expires when a NON-NULL trace crosses a
// persistence, replay, determinism-lock, or artifact-identity trust boundary.
// PR 3's evolution history is byte-only — evaluation is forced to trace mode
// 'none' and the record geometry admits exactly four component kinds
// (population snapshot, evaluation metadata, fitness vector, lineage) — so a
// trace has no byte walk to enter through. The narrowing is not prose-only:
// tests/evolution-run.test.js holds the static + runtime trace-exclusion
// teeth, so the premise fails a build if it ever stops being true.
//
// Two candidate atomic architectural fixes are recorded for Phase 1B's
// persisted-history milestone:
//   (A) hard API boundary — accept only pre-encoded Uint8Array records so no
//       caller code runs while both sides are live;
//   (B) total deep pre-scan — recursively refuse accessor descriptors on
//       every nested key of both sides before comparison begins.
// Freezing the outer envelopes alone is insufficient (Uint8Array contents
// stay mutable, and nested objects retain their own descriptors).
//
// This block deliberately holds NO test — a documented deferral. Adding a
// site-specific accessor-descriptor tooth here would re-enable the whack-a-
// mole pattern the deferral rejects.

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

  test('the declared surface is a set, not a multiset, across the family', () => {
    const reexported = new Set(Object.values(RE_EXPORTS).flat());
    const all = Object.entries(EXPECTED_EXPORTS)
      .flatMap(([module, names]) => [...names]
        .filter((n) => !(RE_EXPORTS[module] ?? []).includes(n)));
    // Names are unique once the declared RE-EXPORTS are excluded, which is what
    // lets the ownership verdicts below be keyed by bare name.
    expect(new Set(all).size).toBe(all.length);
    expect(reexported.size).toBeGreaterThan(0); // the exclusion is not vacuous
  });

  test('every declared re-export is the SAME BINDING, not a divergent copy', () => {
    // `evaluation.js` re-exports two trace constants as "one import point for
    // consumers". That is only safe if they are identical — a second module
    // exporting its own EVALUATION_TRACE_VERSION would be a silently forkable
    // contract, so the exclusion above is paid for with an identity check.
    // Every re-exporting module declares its OWNER, and the owner must itself
    // be a classified module — so a re-export cannot point at a namespace this
    // suite does not pin.
    expect(Object.keys(RE_EXPORT_OWNER).sort()).toEqual(Object.keys(RE_EXPORTS).sort());
    for (const [module, names] of Object.entries(RE_EXPORTS)) {
      const owner = RE_EXPORT_OWNER[module];
      expect(NAMESPACES[owner], `${module} declares an unclassified owner ${owner}`).toBeTruthy();
      for (const name of names) {
        expect(NAMESPACES[module][name], `${module}:${name}`).toBe(NAMESPACES[owner][name]);
      }
    }
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
  requireOrdinaryBytes: 'callerElements', // a pass-through validator: returns its input array unchanged
  typedArrayByteLength: 'scalar',
  bytesToHex: 'scalar',
  copyOrdinaryBytes: 'freshBytes',
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
  selectablePoolFromEvaluation: 'ownedCopy',
  canonicalizeEvaluationSpec: 'ownedCopy',
  // evolution-operators.js
  selectTournamentParent: 'scalar',
  selectElites: 'ownedCopy',
  mutateContinuousGenotype: 'ownedCopy',
  // evolution-contract.js
  // The error's `context` is copied key by key with every non-scalar coerced
  // to a string, so a thrown diagnostic can never retain a caller object or a
  // history buffer — asserted in the ownedCopy battery below.
  EvolutionError: 'ownedCopy',
  evolutionFail: 'ownedCopy',
  // evolution-lineage.js
  validateLineage: 'scalar',
  serializeLineage: 'freshBytes',
  deserializeLineage: 'ownedCopy',
  crossCheckLineage: 'scalar',
  // evolution-run.js — the run is opaque; `createEvolutionRun` returns an
  // object with no property reachable from the caller's config, and the
  // engine's behaviour under a mutated config is owned by
  // tests/evolution-run.test.js (it needs physics).
  createEvolutionRun: 'notExercised',
  // evolution-history.js
  // (serializeEvaluationMetadata reads only scalars — no callerCollections row,
  // so it declares no verdict, by the table's own rule.)
  deserializeEvaluationMetadata: 'ownedCopy',
  encodeEvolutionHeader: 'freshBytes',
  decodeEvolutionHeader: 'ownedCopy',
  encodeGenerationPayload: 'freshBytes',
  decodeGenerationPayload: 'ownedCopy',
  digestHeader: 'notExercised', // async; the freshness battery lives in tests/sha256.test.js
  digestComponent: 'notExercised',
  digestGeneration: 'notExercised',
  digestHistoryBody: 'notExercised',
  digestsEqual: 'scalar',
  assembleHistory: 'notExercised', // async; round-tripped in tests/evolution-history.test.js
  // The ONE declared aliasing seam in the evolution family: its returned views
  // are windows into the module-owned buffer it was handed, by contract.
  decodeHistoryFraming: 'sharedWindow',
  // src/platform/sha256.js
  sha256: 'notExercised', // async; freshness + copy-before-await in tests/sha256.test.js
  // evolution-replay.js — verification and reporting; owned by
  // tests/evolution-replay.test.js, which needs real artifacts (and physics).
  firstByteDifference: 'scalar',
  failReplayDivergence: 'notExercised', // always throws; its context is scalar-copied by EvolutionError
  verifyHistoryArtifact: 'notExercised',
  captureExpectedIdentity: 'ownedCopy',
  resumeEvolutionRun: 'notExercised',
  // integrity.js
  foldIntegrity: 'callerElements', // returns the caller's own state object, by contract (chaining)
  // trace.js
  decodeTraceRecord: 'ownedCopy',
  compareTraces: 'ownedCopy',
  compareCheckpoints: 'ownedCopy',
  // trace-forensics.js
  bodyReachMetadataForIR: 'ownedCopy',
  analyzeTrace: 'ownedCopy',
  offlineIntegrityView: 'ownedCopy',
  // evaluation.js — physics; its behaviour is owned by tests/evaluation.test.js
  runEvaluation: 'notExercised',
  // Round 14 — reclassified to reflect the actual defense; the ownership
  // regressions live in tests/evaluation-core.test.js (they need a live world).
  runRealizedEvaluationLoop: 'notExercised',
  // fnv1a.js
  fnv1aFold: 'scalar',
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
    // foldIntegrity returns the caller's own state object — the documented
    // chaining convention (`return state`, the foldProgress precedent), not an
    // accident. Its `reads` are never retained.
    foldIntegrity: () => {
      const state = createIntegrityState(1, 1 / 60);
      const reads = [{ finite: true, translation: { x: 0, y: 1, z: 0 }, linvel: { x: 1, y: 0, z: 0 } }];
      return foldIntegrity(state, 0, reads) === state;
    },
    // requireOrdinaryBytes returns the exact input array on success (a
    // pass-through storage-lifetime gate), so it deliberately hands the caller
    // its own object back.
    requireOrdinaryBytes: () => {
      const bytes = Uint8Array.of(1, 2, 3);
      return requireOrdinaryBytes(bytes, () => { throw new Error('unexpected'); }) === bytes;
    },
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
    ...(() => {
      const evaluation = {
        fitnessPolicyVersion: 2,
        populationSnapshotDigestState: 7,
        individuals: [{ individualId: 0, valid: true, integrityStatus: 'ok', fitness: 1 }],
      };
      const elitePopulation = twoMemberPopulation();
      const state = fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(elitePopulation));
      const elitePool = {
        selectionPoolVersion: 1,
        fitnessPolicyVersion: 2,
        populationSnapshotDigestState: state,
        evaluatedIndividualIds: [3, 9],
        individuals: [{ individualId: 3, fitness: 2 }, { individualId: 9, fitness: 1 }],
      };
      return [
        { name: 'selectablePoolFromEvaluation', result: EvaluationNS.selectablePoolFromEvaluation(evaluation), roots: [evaluation] },
        { name: 'selectElites', result: EvolutionNS.selectElites(elitePopulation, elitePool), roots: [elitePopulation, elitePool] },
        { name: 'mutateContinuousGenotype', result: EvolutionNS.mutateContinuousGenotype(g, { nextFloat: () => 0.5 }, { probability: 0, magnitude: 0 }), roots: [g] },
      ];
    })(),
    // PR 3's history codecs.
    ...(() => {
      const metadataBytes = serializeEvaluationMetadata(
        { worldMode: 'isolatedWorlds', effectiveDt: 1 / 60, executedSteps: 3 },
      );
      const headerSource = { ...HISTORY_HEADER_FIXTURE };
      const headerBytes = encodeEvolutionHeader(headerSource);
      const payloadSource = {
        generationIndex: 0,
        terminalReason: 'none',
        components: { ...HISTORY_COMPONENTS_FIXTURE },
      };
      const payloadBytes = encodeGenerationPayload(payloadSource, HISTORY_DIGESTS_FIXTURE);
      return [
        { name: 'deserializeEvaluationMetadata', result: deserializeEvaluationMetadata(metadataBytes), roots: [metadataBytes] },
        { name: 'decodeEvolutionHeader', result: decodeEvolutionHeader(headerBytes), roots: [headerBytes] },
        { name: 'decodeGenerationPayload', result: decodeGenerationPayload(payloadBytes), roots: [payloadBytes] },
      ];
    })(),
    // PR 3's evolution family.
    ...(() => {
      const cSpec = { ...resolvedFlat(), terrain: { ...resolvedFlat().terrain } };
      const lineageBytes = serializeLineage(sampleLineage());
      const context = { generationIndex: 1, offender: { live: 'object' } };
      let thrownByFail = null;
      try { evolutionFail('malformedHistory', 'probe', context); } catch (e) { thrownByFail = e; }
      return [
        { name: 'canonicalizeEvaluationSpec', result: canonicalizeEvaluationSpec(cSpec), roots: [cSpec] },
        { name: 'deserializeLineage', result: deserializeLineage(lineageBytes), roots: [lineageBytes] },
        // The error must not retain the caller's context object: every
        // non-scalar is coerced to a string on the way in, so a diagnostic can
        // never become a back door to live run state.
        { name: 'EvolutionError', result: new EvolutionError('invalidConfig', 'probe', context), roots: [context] },
        { name: 'evolutionFail', result: thrownByFail, roots: [context] },
        ...(() => {
          const digest = new Uint8Array(32);
          const options = { expectedHistoryDigestBytes: digest, expectedGenerationIndex: 3 };
          return [{
            name: 'captureExpectedIdentity',
            result: captureExpectedIdentity(options, (b) => copyOrdinaryBytes(b)),
            roots: [options, digest],
          }];
        })(),
      ];
    })(),
    // Round-11 additions: the diagnostic/forensic family, previously unpinned.
    ...(() => {
      const recBytes = encodeTraceRecord(baseTraceRecord());
      const exp = forensicTrace();
      const act = forensicTrace();
      // Divergent, so the REPORT path is what is inspected for retained refs.
      act.records[1] = encodeTraceRecord(forensicRecord(1, { linvel: { x: 99, y: 0, z: 0 } }));
      const cpA = forensicCheckpoints();
      const cpB = forensicCheckpoints();
      cpB[1].state = 4242;
      const fir = compileAssembly(canonicalGenotype());
      const traceIn = forensicTrace();
      const analysis = analyzeTrace(traceIn, { captureDt: 1 / 60 });
      return [
        { name: 'decodeTraceRecord', result: decodeTraceRecord(recBytes), roots: [recBytes] },
        { name: 'compareTraces', result: compareTraces(exp, act), roots: [exp, act] },
        { name: 'compareCheckpoints', result: compareCheckpoints(cpA, cpB), roots: [cpA, cpB] },
        { name: 'bodyReachMetadataForIR', result: bodyReachMetadataForIR(fir), roots: [fir] },
        { name: 'analyzeTrace', result: analysis, roots: [traceIn] },
        { name: 'offlineIntegrityView', result: offlineIntegrityView(analysis), roots: [analysis] },
      ];
    })(),
  ];
}

// A three-capture single-chassis full trace and its checkpoints — the smallest
// input that exercises the forensic walks and both comparators' report paths.
const forensicRecord = (stepIndex, overrides = {}) => ({
  ...baseTraceRecord(),
  stepIndex,
  bodyRole: 'chassis',
  axleIndex: null,
  wheelIndex: null,
  jointState: 'notApplicable',
  ...overrides,
});

const forensicTrace = () => ({
  version: EVALUATION_TRACE_VERSION,
  mode: 'full',
  recordBytes: RECORD_BYTES,
  records: [0, 1, 2].map((k) => encodeTraceRecord(forensicRecord(k))),
});

const forensicCheckpoints = () => [
  { stepIndex: 0, recordCount: 1, byteCount: RECORD_BYTES, state: 111 },
  { stepIndex: 1, recordCount: 2, byteCount: 2 * RECORD_BYTES, state: 222 },
];

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
    ...(() => {
      const lineage = sampleLineage();
      const headerSource = { ...HISTORY_HEADER_FIXTURE };
      const payloadSource = {
        generationIndex: 0,
        terminalReason: 'none',
        components: { ...HISTORY_COMPONENTS_FIXTURE },
      };
      const source = Uint8Array.of(1, 2, 3, 4);
      return [
        { name: 'serializeLineage', result: serializeLineage(lineage), roots: [lineage] },
        { name: 'copyOrdinaryBytes', result: copyOrdinaryBytes(source), roots: [source] },
        { name: 'encodeEvolutionHeader', result: encodeEvolutionHeader(headerSource), roots: [headerSource] },
        {
          name: 'encodeGenerationPayload',
          result: encodeGenerationPayload(payloadSource, HISTORY_DIGESTS_FIXTURE),
          roots: [payloadSource, HISTORY_DIGESTS_FIXTURE],
        },
      ];
    })(),
  ];
}

// The smallest lineage that carries both a sentinel row and real accounting.
const sampleLineage = () => ({
  lineageVersion: 1,
  generationIndex: 0,
  individuals: [
    { individualId: 0, parentIndividualId: null, origin: 'initialized', accounting: { ...zeroLineageAccounting() } },
    { individualId: 1, parentIndividualId: null, origin: 'initialized', accounting: { ...zeroLineageAccounting() } },
  ],
});

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
