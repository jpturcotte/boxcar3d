// THE SINGLE-READ INVARIANT, enforced as a build failure — not as prose.
//
// The rule (round-10 external review, root cause of blockers across four
// consecutive rounds):
//
//   Any caller-owned value used to VALIDATE, ORDER, ATTEST, ENCODE, or
//   EXECUTE must be captured into a module-owned local exactly once, and
//   every subsequent operation must use that capture.
//
// Rounds 7–9 each fixed the reported SITES and wrote enforcement scoped to
// each round's MECHANISM (shadowed TypedArray geometry, then one champion
// read-count tooth). This suite is different by construction, not by
// enumeration: it deep-instruments every own enumerable property of a
// caller input with a COUNTING ACCESSOR — an ordinary own accessor, the
// exact in-scope exploit vehicle — and asserts no property is read more
// than once during the call. A property read at most once cannot be lied
// to: the invariant holds without this suite knowing anything about what
// any function does with the value.
//
// What the instrument can and cannot see (declared, so exemptions are
// decisions rather than gaps):
//   - Plain objects and genuine Arrays: every own enumerable property
//     (array elements included) becomes a counting accessor. Reads via
//     destructuring, spread, and Object.values all count; typeof checks,
//     Array.isArray, Object.keys, and hasOwn do NOT read values and are
//     free, as in the real threat model.
//   - A genuine Array's `length` is a non-configurable own data property, so
//     no ACCESSOR can be installed on it — but it is WRITABLE, and every
//     element read in a validation walk is caller code that may write it.
//     The exemption claimed here through round 10 ("exempt by the language")
//     was FALSE, and it was the rule behind three round-11 blockers: a
//     `radius` getter assigning `axles.length = 1` made a 3-axle genotype
//     serialize to 396 bytes attesting axleCount 1, and a member getter
//     assigning `individuals.length = 3` made attestPopulation return a
//     silent prefix. The honest statement is conditional: a repeated read of
//     Array `length` is safe ONLY when no caller code runs between the reads.
//     Because the counting instrument below rebuilds Arrays (and so discards
//     any length-mutating getter), it is structurally blind to this case —
//     the `LOOP_BOUND_CASES` battery is what covers it.
//   - TypedArrays pass through untouched (integer-indexed properties
//     cannot be redefined). The byte decoders read caller bytes through
//     cached intrinsics and a single reader cursor — audited separately in
//     tests/ownership-boundary.test.js.
//   - Functions (hooks) pass through: never invoked by the instrument.
//
// Each table case calls the export with a VALID canonical input and
// asserts (a) it does not throw, and (b) no instrumented path was read
// twice. The named regressions at the bottom are the round-10 reviewer's
// required poison tests (valid first read, poison second) — strictly
// weaker than the counting assertion, kept because they document the
// concrete failure each finding demonstrated.

import { describe, test, expect } from 'vitest';
import { Rng } from '../src/sim/prng.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from '../src/sim/fnv1a.js';
import * as AssemblyNS from '../src/sim/assembly.js';
import * as PopulationNS from '../src/sim/population.js';
import * as InitializerNS from '../src/sim/population-initializer.js';
import * as EvaluationNS from '../src/sim/population-evaluation.js';
import * as EvolutionNS from '../src/sim/evolution-operators.js';
import * as IntegrityNS from '../src/sim/integrity.js';
import * as TraceNS from '../src/sim/trace.js';
import * as ForensicsNS from '../src/sim/trace-forensics.js';
import {
  hubMassProperties, randomGenotype, repairGenotype, compileAssembly,
  validateGenotype, serializeGenotype, deserializeGenotype, forEachGenotypeField,
} from '../src/sim/assembly.js';
import {
  attestPopulation, serializePopulationSnapshot, validatePopulation,
} from '../src/sim/population.js';
import {
  createInitialPopulation, sampleInitialGenotype, serializePopulationInitialization,
} from '../src/sim/population-initializer.js';
import {
  championFromEvaluation, selectableChampionFromEvaluation,
  deserializeFitnessVector, fitnessFromVehicleResult,
  isVehicleResultSelectable, isVehicleResultValid,
  selectablePoolFromEvaluation, serializeEvaluationSpec, serializeFitnessVector, spawnPoseOnFlatStart,
} from '../src/sim/population-evaluation.js';
import {
  mutateContinuousGenotype, selectElites, selectTournamentParent,
} from '../src/sim/evolution-operators.js';
import { TERRAIN_DEFAULTS } from '../src/sim/terrain.js';
import {
  INTEGRITY_POLICY_VERSION, createIntegrityState, foldIntegrity,
} from '../src/sim/integrity.js';
import {
  EVALUATION_TRACE_VERSION, RECORD_BYTES, TraceWriter,
  compareCheckpoints, compareTraces, encodeTraceRecord,
} from '../src/sim/trace.js';
import {
  analyzeTrace, bodyReachMetadataForIR, offlineIntegrityView, scaledThresholds,
} from '../src/sim/trace-forensics.js';
import * as EvolutionContractNS from '../src/sim/evolution-contract.js';
import * as EvolutionLineageNS from '../src/sim/evolution-lineage.js';
import * as EvolutionRunNS from '../src/sim/evolution-run.js';
import {
  crossCheckLineage, deserializeLineage, serializeLineage, validateLineage,
  zeroLineageAccounting,
} from '../src/sim/evolution-lineage.js';
import { createEvolutionRun } from '../src/sim/evolution-run.js';
import * as EvolutionHistoryNS from '../src/sim/evolution-history.js';
import * as Sha256NS from '../src/platform/sha256.js';
import * as EvolutionReplayNS from '../src/sim/evolution-replay.js';
import {
  encodeEvolutionHeader, encodeGenerationPayload, serializeEvaluationMetadata,
} from '../src/sim/evolution-history.js';

// --- The instrument ---------------------------------------------------------

const isPlainData = (v) => typeof v === 'object' && v !== null
  && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer);

/**
 * Deep copy `value` where every own enumerable property is a counting
 * accessor returning the same (recursively instrumented) value on every
 * read. Behavior-neutral for compliant code; every read is tallied in
 * `counts` by path.
 */
function instrument(value, counts, path) {
  if (!isPlainData(value)) return value;
  const wrap = (target, key, child, childPath) => {
    const v = instrument(child, counts, childPath);
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get() {
        counts.set(childPath, (counts.get(childPath) ?? 0) + 1);
        return v;
      },
    });
  };
  if (Array.isArray(value)) {
    const out = [];
    out.length = value.length; // genuine Array; length stays a data property
    for (let i = 0; i < value.length; i += 1) wrap(out, i, value[i], `${path}[${i}]`);
    return out;
  }
  const out = {};
  for (const k of Object.keys(value)) wrap(out, k, value[k], `${path}.${k}`);
  return out;
}

const multiReads = (counts) => [...counts.entries()]
  .filter(([, n]) => n > 1)
  .map(([p, n]) => `${p} read ${n}x`);

/** Instrument args, run, and return {counts, threw, result}. */
function run(build, call) {
  const counts = new Map();
  const args = build().map((a, i) => instrument(a, counts, `arg${i}`));
  let threw = null;
  let result;
  try {
    result = call(...args);
  } catch (e) {
    threw = e;
  }
  return { counts, threw, result };
}

// --- Instrument self-checks (the suite's own teeth) -------------------------

describe('the instrument itself', () => {
  test('counts every read by path and preserves values, -0 and NaN included', () => {
    const counts = new Map();
    const x = instrument({ a: 1, b: { c: -0 }, d: [NaN, 2] }, counts, 'x');
    expect(Object.is(x.b.c, -0)).toBe(true);
    expect(Number.isNaN(x.d[0])).toBe(true);
    expect(x.a + x.a).toBe(2);
    expect(counts.get('x.a')).toBe(2); // a leaf read twice is visible
    expect(counts.get('x.b')).toBe(1); // container read once for the chain
    expect(counts.get('x.b.c')).toBe(1);
  });

  test('a double-reading function is caught; a capturing one passes', () => {
    const doubleRead = (o) => o.v + o.v;
    const capture = (o) => { const v = o.v; return v + v; };
    const c1 = new Map();
    doubleRead(instrument({ v: 1 }, c1, 'o'));
    expect(multiReads(c1)).toEqual(['o.v read 2x']);
    const c2 = new Map();
    capture(instrument({ v: 1 }, c2, 'o'));
    expect(multiReads(c2)).toEqual([]);
  });

  test('spread and destructuring count as exactly one read per property', () => {
    const counts = new Map();
    const o = instrument({ a: 1, b: 2 }, counts, 'o');
    const { a } = o;
    const s = { ...o };
    expect(a + s.b).toBe(3);
    expect(counts.get('o.a')).toBe(2); // destructure + spread
    expect(counts.get('o.b')).toBe(1); // spread only — s.b reads the module-owned copy, which is free
  });
});

// --- Shared builders (plain canonical data, rebuilt per case) ---------------

const genotype = (fork = 1) => repairGenotype(randomGenotype(new Rng(20260710).fork(fork)));

// randomGenotype can draw the legal-but-unrealizable S2 suspension band, which
// the adapter's placement planner rejects by design. Cases that must reach a
// REALIZER path use an initializer-drawn genotype instead — the live
// initializer masks suspension types to S0/S1 by construction.
const realizableGenotype = () => createInitialPopulation(
  { seed: 20260721, populationSize: 1 },
).population.individuals[0].genotype;

const smallPopulation = () => createInitialPopulation({ seed: 20260721, populationSize: 3 }).population;

const initialization = () => createInitialPopulation({ seed: 20260721, populationSize: 2 });

// A resolved evaluation spec in the exact shape serializeEvaluationSpec
// consumes (the deserialize-return shape).
const resolvedSpec = () => ({
  deterministic: true,
  termination: 'maxSteps',
  maxSteps: 300,
  spawn: { x: -44, z: 0, clearance: 0.02 },
  targetWheelSurfaceSpeed: 5,
  wheelFriction: 1,
  terrain: { ...TERRAIN_DEFAULTS, seed: 20260722 },
});

const okVehicleResult = () => ({
  finite: true,
  bodies: { allValid: true },
  joints: { allValid: true },
  maxForwardDistance: 3.25,
  integrity: { policyVersion: INTEGRITY_POLICY_VERSION, status: 'ok' },
});

const fitnessEvaluation = () => ({
  fitnessPolicyVersion: 2,
  populationSnapshotDigestState: 12345,
  evaluationSpecDigestState: 67890,
  individuals: [
    { individualId: 0, valid: true, integrityStatus: 'ok', fitness: 2.5 },
    { individualId: 1, valid: false, integrityStatus: 'ok', fitness: 0 },
    { individualId: 2, valid: true, integrityStatus: 'numericalDivergence', fitness: 0 },
  ],
});

const championEvaluation = () => ({
  individuals: [
    { individualId: 0, valid: true, integrityStatus: 'ok', fitness: 2.5, diagnostics: { tag: 'a' } },
    { individualId: 1, valid: true, integrityStatus: 'ok', fitness: 7.5, diagnostics: { tag: 'b' } },
    { individualId: 2, valid: false, integrityStatus: 'ok', fitness: 0, diagnostics: { tag: 'c' } },
  ],
});

const chassisRecord = (stepIndex = 0, overrides = {}) => ({
  stepIndex,
  vehicleIndex: 0,
  bodyRole: 'chassis',
  axleIndex: null,
  wheelIndex: null,
  bodyValid: true,
  bodySleeping: false,
  jointState: 'notApplicable',
  terminated: false,
  terminationReason: 'none',
  finiteState: true,
  translation: { x: 0, y: 0.5, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  linvel: { x: 1, y: 0, z: 0 },
  angvel: { x: 0, y: 0, z: 0 },
  ...overrides,
});

const fullTrace = () => ({
  version: EVALUATION_TRACE_VERSION,
  mode: 'full',
  recordBytes: RECORD_BYTES,
  records: [0, 1, 2].map((k) => encodeTraceRecord(chassisRecord(k))),
});

// Every module's fail-loud dialect, so "rejected" can be distinguished from
// "escaped as a foreign TypeError/RangeError". Shared by every section below
// that asserts a malformed input is refused rather than silently absorbed.
const MODULE_DIALECT = /^(assembly|population|population-initializer|population-evaluation|trace|trace-forensics|integrity):/;

// A two-row generation-0 lineage: the smallest input that exercises both the
// sentinel rule and the accounting walk.
const sampleLineage = () => ({
  lineageVersion: 1,
  generationIndex: 0,
  individuals: [0, 1].map((individualId) => ({
    individualId, parentIndividualId: null, origin: 'initialized', accounting: { ...zeroLineageAccounting() },
  })),
});

// Module-owned history fixtures for the encoder rows above.
const historyHeader = () => ({
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
  initializationManifestBytes: Uint8Array.of(1, 2, 3),
  evaluationSpecBytes: Uint8Array.of(4, 5, 6),
});

const historyComponents = () => ({
  population: Uint8Array.of(1),
  evaluationMetadata: serializeEvaluationMetadata({ worldMode: 'isolatedWorlds', effectiveDt: 1 / 60, executedSteps: 1 }),
  fitnessVector: Uint8Array.of(2),
  lineage: Uint8Array.of(3),
});

const historyDigests = () => ({
  population: new Uint8Array(32),
  evaluationMetadata: new Uint8Array(32),
  fitnessVector: new Uint8Array(32),
  lineage: new Uint8Array(32),
});

// The smallest legal evolution config (no physics runs at creation).
const evolutionConfig = () => ({
  initialization: { seed: 20260740, populationSize: 2 },
  evaluationSpec: {
    terrain: { seed: 20260741, startFlatLength: 30, startBlendLength: 6 },
    maxSteps: 10,
    deterministic: true,
    spawn: { x: -44, z: 0 },
  },
  evolution: { maxGenerations: 2 },
});

// A full-trace analysis with TWO bodies, the second catastrophic (|v| ≫ 1000),
// so offlineIntegrityView returns a non-'ok' status derived from perBody[1].
const catastrophicAnalysis = () => {
  const rec = (vehicleIndex, k, vx) => ({
    ...chassisRecord(k, { linvel: { x: vx, y: 0, z: 0 } }), vehicleIndex,
  });
  const records = [];
  for (let k = 0; k < 3; k += 1) {
    records.push(encodeTraceRecord(rec(0, k, 1)));
    records.push(encodeTraceRecord(rec(1, k, 2000)));
  }
  return analyzeTrace(
    { version: EVALUATION_TRACE_VERSION, mode: 'full', recordBytes: RECORD_BYTES, records },
    { captureDt: 1 / 60 },
  );
};

// One per-body capture in the runner's `reads` shape.
const integrityReads = () => [
  { finite: true, translation: { x: 0, y: 0.5, z: 0 }, linvel: { x: 1, y: 0, z: 0 } },
  { finite: true, translation: { x: 0.2, y: 0.4, z: 0 }, linvel: { x: 2, y: 0, z: 0 } },
];

const checkpoints = () => [
  { stepIndex: 0, recordCount: 1, byteCount: RECORD_BYTES, state: 111 },
  { stepIndex: 1, recordCount: 2, byteCount: 2 * RECORD_BYTES, state: 222 },
];

// --- The table --------------------------------------------------------------
//
// Every case: valid canonical input, must succeed, and no instrumented
// property may be read more than once. Add a row when a public export that
// consumes caller data is added; tests/ownership-boundary.test.js pins the
// export lists, so an unlisted export fails there first.

const CASES = [
  ['assembly.validateGenotype', () => [genotype()], (g) => validateGenotype(g)],
  ['assembly.repairGenotype', () => [genotype()], (g) => repairGenotype(g)],
  ['assembly.compileAssembly', () => [genotype()], (g) => compileAssembly(g)],
  ['assembly.serializeGenotype', () => [genotype()], (g) => serializeGenotype(g)],
  ['assembly.forEachGenotypeField', () => [genotype()],
    (g) => forEachGenotypeField(g, () => {})],
  ['assembly.hubMassProperties', () => [{ mass: 20, radius: 0.4, width: 0.3 }],
    (w) => hubMassProperties(w)],
  ['population.validatePopulation', () => [smallPopulation()], (p) => validatePopulation(p)],
  ['population.serializePopulationSnapshot', () => [smallPopulation()],
    (p) => serializePopulationSnapshot(p)],
  ['population.attestPopulation', () => [smallPopulation()], (p) => attestPopulation(p)],
  ['population-initializer.createInitialPopulation',
    () => [{ seed: 20260721, populationSize: 2 }], (c) => createInitialPopulation(c)],
  ['population-initializer.sampleInitialGenotype',
    () => [{ seed: 1, populationSize: 2 }],
    (c) => sampleInitialGenotype(new Rng(7), c)],
  ['population-initializer.serializePopulationInitialization (production path)',
    () => [initialization()], (i) => serializePopulationInitialization(i)],
  ['population-initializer.serializePopulationInitialization (digest-state path)',
    () => {
      const init = initialization();
      const rest = { ...init };
      delete rest.population; // the digest-state branch: no population carried
      return [{ ...rest, populationSnapshotDigestState: 42 }];
    },
    (i) => serializePopulationInitialization(i)],
  ['population-evaluation.spawnPoseOnFlatStart',
    () => [compileAssembly(realizableGenotype()), { x: -44, z: 0 }],
    (ir, opts) => spawnPoseOnFlatStart(ir, opts)],
  ['population-evaluation.serializeEvaluationSpec', () => [resolvedSpec()],
    (s) => serializeEvaluationSpec(s)],
  // The hook-free canonicalizer resolves a caller's spec exactly once; the
  // resolver, the encoder, and the returned decoded record must all be that
  // one reading (the resolveSpec `spawn.x` regression, one seam up).
  // …and unlike its sibling encoder, this one runs the EXECUTION gate, so its
  // fixture must satisfy the flat-pad guard (a longer start pad).
  ['population-evaluation.canonicalizeEvaluationSpec',
    () => [{ ...resolvedSpec(), terrain: { ...TERRAIN_DEFAULTS, seed: 20260741, startFlatLength: 30 } }],
    (s) => EvaluationNS.canonicalizeEvaluationSpec(s)],
  ['population-evaluation.serializeFitnessVector (digest-state path)', () => [fitnessEvaluation()],
    (e) => serializeFitnessVector(e)],
  // EVERY presence-selected optional input needs its own row: the row above
  // carries `evaluationSpecDigestState` and no `spec`, so the PRODUCTION branch
  // — which serializes the spec and folds it into the attestation — was never
  // instrumented, and its double read of `evaluation.spec` survived round 10.
  // The sibling encoder already had two rows for exactly this reason.
  ['population-evaluation.serializeFitnessVector (production spec path)',
    () => {
      const e = fitnessEvaluation();
      delete e.evaluationSpecDigestState;
      return [{ ...e, spec: resolvedSpec() }];
    },
    (e) => serializeFitnessVector(e)],
  ['population-evaluation.isVehicleResultValid', () => [okVehicleResult()],
    (v) => isVehicleResultValid(v)],
  ['population-evaluation.isVehicleResultSelectable', () => [okVehicleResult()],
    (v) => isVehicleResultSelectable(v)],
  ['population-evaluation.fitnessFromVehicleResult', () => [okVehicleResult()],
    (v) => fitnessFromVehicleResult(v)],
  ['population-evaluation.championFromEvaluation', () => [championEvaluation()],
    (e) => championFromEvaluation(e)],
  ['population-evaluation.selectableChampionFromEvaluation', () => [championEvaluation()],
    (e) => selectableChampionFromEvaluation(e)],
  ['population-evaluation.selectablePoolFromEvaluation', () => [fitnessEvaluation()],
    (e) => selectablePoolFromEvaluation(e)],
  ['evolution-operators.selectTournamentParent', () => [{
    selectionPoolVersion: 1,
    fitnessPolicyVersion: 2,
    populationSnapshotDigestState: 1,
    evaluatedIndividualIds: [0],
    individuals: [{ individualId: 0, fitness: 1 }],
  }], (p) => selectTournamentParent(p, { nextUint32: () => 0 })],
  ['evolution-operators.selectElites', () => {
    const p = smallPopulation();
    const ids = p.individuals.map((x) => x.individualId).sort((a, b) => a - b);
    const bytes = serializePopulationSnapshot(p);
    const state = fnv1aFold(FNV_OFFSET_BASIS, bytes);
    return [p, {
      selectionPoolVersion: 1,
      fitnessPolicyVersion: 2,
      populationSnapshotDigestState: state,
      evaluatedIndividualIds: ids,
      individuals: ids.map((individualId) => ({ individualId, fitness: 1 })),
    }];
  }, (p, q) => selectElites(p, q)],
  ['evolution-operators.mutateContinuousGenotype', () => [genotype(), { probability: 0, magnitude: 0 }],
    (g, o) => mutateContinuousGenotype(g, { nextFloat: () => 0 }, o)],
  ['trace.encodeTraceRecord', () => [chassisRecord()], (r) => encodeTraceRecord(r)],
  ['trace.TraceWriter.record', () => [chassisRecord()], (r) => {
    const w = new TraceWriter({ mode: 'digest', checkpointInterval: 1 });
    w.record(r);
    w.endStep(0);
    return w.finish();
  }],
  ['trace.compareTraces', () => [fullTrace(), fullTrace()],
    (a, b) => compareTraces(a, b)],
  ['trace.compareCheckpoints', () => [checkpoints(), checkpoints()],
    (a, b) => compareCheckpoints(a, b)],
  // The DIVERGENT cases matter as much as the agreeing ones: the reporting
  // branches are where a re-read prints values that were never compared, and
  // an all-identical fixture never reaches them (a mutation that reported from
  // the caller went undetected until these were added).
  ['trace.compareCheckpoints (divergent — exercises the report path)',
    () => {
      const b = checkpoints();
      b[1].state = 999;
      return [checkpoints(), b];
    },
    (a, b) => compareCheckpoints(a, b)],
  ['trace.compareCheckpoints (length mismatch)',
    () => [checkpoints(), [checkpoints()[0]]],
    (a, b) => compareCheckpoints(a, b)],
  ['trace.compareTraces (divergent — exercises the report path)',
    () => {
      const b = fullTrace();
      b.records[1] = encodeTraceRecord(chassisRecord(1, { linvel: { x: 42, y: 0, z: 0 } }));
      return [fullTrace(), b];
    },
    (a, b) => compareTraces(a, b)],
  ['trace-forensics.scaledThresholds',
    () => [2, { alertSpeed: 25, catastrophicSpeed: 1000 }],
    (f, t) => scaledThresholds(f, t)],
  ['trace-forensics.bodyReachMetadataForIR', () => [compileAssembly(realizableGenotype())],
    (ir) => bodyReachMetadataForIR(ir)],
  ['trace-forensics.analyzeTrace', () => [fullTrace(), { captureDt: 1 / 60 }],
    (t, o) => analyzeTrace(t, o)],
  ['trace-forensics.offlineIntegrityView',
    () => [analyzeTrace(fullTrace())],
    (a) => offlineIntegrityView(a)],
  // PR 3's evolution family. The lineage codec walks a caller's rows and the
  // run's config capture walks three caller containers — both are exactly the
  // shape this instrument exists for.
  ['evolution-lineage.validateLineage', () => [sampleLineage()], (l) => validateLineage(l)],
  ['evolution-lineage.serializeLineage', () => [sampleLineage()], (l) => serializeLineage(l)],
  ['evolution-lineage.crossCheckLineage',
    () => [deserializeLineage(serializeLineage(sampleLineage())), [0, 1], null],
    (l, ids, previous) => crossCheckLineage(l, 0, ids, previous)],
  ['evolution-run.createEvolutionRun', () => [evolutionConfig()], (c) => createEvolutionRun(c)],
  ['evolution-replay.captureExpectedIdentity',
    () => [{ expectedHistoryDigestBytes: new Uint8Array(32), expectedGenerationIndex: 2 }],
    (o) => EvolutionReplayNS.captureExpectedIdentity(o, (b) => new Uint8Array(b))],
  ['evolution-history.serializeEvaluationMetadata',
    () => [{ worldMode: 'isolatedWorlds', effectiveDt: 1 / 60, executedSteps: 45 }],
    (m) => serializeEvaluationMetadata(m)],
  ['evolution-history.encodeEvolutionHeader', () => [historyHeader()],
    (h) => encodeEvolutionHeader(h)],
  ['evolution-history.encodeGenerationPayload',
    () => [
      { generationIndex: 0, terminalReason: 'none', components: historyComponents() },
      historyDigests(),
    ],
    (record, digests) => encodeGenerationPayload(record, digests)],
  ['integrity.foldIntegrity', () => [integrityReads()], (reads) => {
    const state = createIntegrityState(2, 1 / 60);
    return foldIntegrity(state, 0, reads);
  }],
];

describe('single-read invariant over the public surface', () => {
  test.each(CASES)('%s reads every caller property at most once', (name, build, call) => {
    const { counts, threw } = run(build, call);
    if (threw) throw threw; // valid input must succeed
    expect(multiReads(counts)).toEqual([]);
  });
});

// F9: the INSTRUMENT is universal over an input's own properties, but the input
// SET (CASES) is a curated table — a new export does NOT get instrumentation
// automatically. This tooth makes the enumeration DERIVED and enforced: every
// function export of the caller-data modules is either covered by a single-read
// mechanism (a CASES/LOOP_BOUND row or a dedicated test) or exempt with a stated
// reason. A new export fails here until classified — closing the "21 exports
// unrowed" gap the break-it sweep named.
const NS = { assembly: AssemblyNS, population: PopulationNS, initializer: InitializerNS,
  evaluation: EvaluationNS, evolution: EvolutionNS, integrity: IntegrityNS, trace: TraceNS, forensics: ForensicsNS,
  evolutionContract: EvolutionContractNS, evolutionLineage: EvolutionLineageNS, evolutionRun: EvolutionRunNS,
  evolutionHistory: EvolutionHistoryNS, sha256: Sha256NS, evolutionReplay: EvolutionReplayNS };

// Function exports that consume caller DATA but are covered outside the CASES
// table (a dedicated describe block above) or need no single-read coverage.
const SINGLE_READ_COVERAGE = Object.freeze({
  // dedicated tests in this file
  compareTraces: 'dedicated: sibling-record byte-poison + loop-bound rows',
  compareCheckpoints: 'CASES + loop-bound rows',
  foldIntegrity: 'CASES + loop-bound + field-guard rows',
  analyzeTrace: 'loop-bound rows (records + bodies)',
  offlineIntegrityView: 'loop-bound row (perBody)',
  bodyReachMetadataForIR: 'malformed-collections + loop-bound rows',
  spawnPoseOnFlatStart: 'CASES + malformed-collections + loop-bound rows',
  // no caller-DATA object: reads numbers/bytes/handles the instrument skips
  deserializeGenotype: 'exempt: decodes a TypedArray (byte family, not plain data)',
  deserializePopulationSnapshot: 'exempt: TypedArray input',
  deserializePopulationInitialization: 'exempt: TypedArray input',
  deserializeEvaluationSpec: 'exempt: TypedArray input',
  deserializeFitnessVector: 'exempt: TypedArray input',
  decodeTraceRecord: 'exempt: TypedArray input',
  encodeTraceRecord: 'exempt: covered by trace.TraceWriter.record CASES row',
  TraceWriter: 'CASES row (trace.TraceWriter.record)',
  hubMassProperties: 'CASES row',
  fitnessFromVehicleResult: 'CASES row',
  isVehicleResultValid: 'CASES row',
  isVehicleResultSelectable: 'CASES row',
  scaledThresholds: 'CASES row',
  createIntegrityState: 'exempt: reads two scalars, no caller object',
  finalizeIntegrity: 'exempt: reads module-owned state',
  norm3: 'exempt: reads {x,y,z} numbers only',
  norm3xyz: 'exempt: three scalar args',
  dist3: 'exempt: two {x,y,z} vectors of numbers',
  createProgressState: 'exempt: no args',
  foldProgress: 'exempt: reads one number',
  readBodyState: 'exempt: Rapier handle, not caller data',
  randomGenotype: 'exempt: rng injection contract (documented)',
  sampleInitialGenotype: 'exempt: rng injection contract (documented)',
  runEvaluation: 'exempt: physics (tests/evaluation.test.js)',
  runRealizedEvaluationLoop: 'exempt: physics',
  evaluatePopulation: 'exempt: physics (tests/population-evaluation.test.js)',
  createByteReader: 'exempt: TypedArray reader (tests/ownership-boundary.test.js)',
  typedArrayByteLength: 'exempt: TypedArray input',
  bytesToHex: 'exempt: TypedArray input',
  hexToBytes: 'exempt: string input',
  fnv1aFold: 'exempt: TypedArray input',
  fnv1aHex: 'exempt: number input',
  fnv1aHexOf: 'exempt: number input',
  genotypeFieldWalk: 'exempt: number arg (axleCount)',
  genotypeByteLength: 'exempt: number arg',
  wheelMass: 'exempt: three scalar args (radius, width, density)',
  isCanonicalUint32: 'exempt: one scalar arg',
  bytesEqual: 'exempt: two TypedArrays (byte family, ownership-boundary battery)',
  // PR 3's evolution family
  canonicalizeEvaluationSpec: 'CASES row',
  deserializeLineage: 'exempt: TypedArray input',
  lineageByteLength: 'exempt: one number arg',
  fitnessVectorByteLength: 'exempt: one number arg',
  zeroLineageAccounting: 'exempt: no args',
  EvolutionError: 'exempt: copies its scalar context by key enumeration (ownership-boundary ownedCopy case)',
  evolutionFail: 'exempt: same as EvolutionError',
  isEvolutionUint32: 'exempt: one scalar arg',
  checkedAdd: 'exempt: two scalar args',
  checkedMultiply: 'exempt: two scalar args',
  copyOrdinaryBytes: 'exempt: TypedArray input',
  // evolution-history.js / src/platform/sha256.js
  deserializeEvaluationMetadata: 'exempt: TypedArray input',
  decodeEvolutionHeader: 'exempt: TypedArray input',
  decodeGenerationPayload: 'exempt: TypedArray input',
  decodeHistoryFraming: 'exempt: TypedArray input',
  digestHeader: 'exempt: TypedArray input',
  digestComponent: 'exempt: kind string + TypedArray input',
  digestGeneration: 'exempt: two TypedArray inputs',
  digestHistoryBody: 'exempt: TypedArray input',
  digestsEqual: 'exempt: two TypedArray inputs',
  assembleHistory: 'exempt: module-owned byte rows; round-tripped in tests/evolution-history.test.js',
  projectEvolutionHistoryCapacity: 'exempt: module-private scalar length record; exercised through createEvolutionRun capacity tests',
  sha256: 'exempt: TypedArray input (tests/sha256.test.js owns its battery)',
  // evolution-replay.js
  firstByteDifference: 'exempt: two TypedArray inputs',
  failReplayDivergence: 'exempt: scalars + TypedArray inputs; always throws',
  verifyHistoryArtifact: 'exempt: TypedArray input',
  checkExpectedIdentity: 'exempt: module-owned capture in',
  checkRuntimeIdentity: 'exempt: two string records in',
  captureExpectedIdentity: 'CASES row',
  resumeEvolutionRun: 'exempt: TypedArray input + physics (tests/evolution-replay.test.js)',
});

const casesCovered = new Set(CASES.map(([name]) => name.split(' ')[0].split('.').pop()));

describe('single-read coverage is derived from the export surface, not hand-picked (F9)', () => {
  test('every caller-data function export is covered by a single-read mechanism or exempt', () => {
    const uncovered = [];
    for (const ns of Object.values(NS)) {
      for (const [name, value] of Object.entries(ns)) {
        if (typeof value !== 'function') continue;
        if (casesCovered.has(name) || Object.prototype.hasOwnProperty.call(SINGLE_READ_COVERAGE, name)) continue;
        uncovered.push(name);
      }
    }
    expect(uncovered, 'add a CASES row or a SINGLE_READ_COVERAGE entry with a reason').toEqual([]);
  });
});

// --- The loop-bound battery (round 11) --------------------------------------
//
// The counting instrument cannot see this class: it rebuilds Arrays, which
// discards a length-mutating element getter, so no input it constructs can
// exhibit the defect. This battery supplies that input directly.
//
// `shrinkingArray` is ordinary data — a genuine Array whose FIRST element read
// assigns its own `length`. Assigning length deletes the trailing indices, so
// a walk that re-reads its bound mid-iteration silently processes a prefix.
//
// The assertion is on the RESULT, not on "it throws": a function may legally
// reject the truncated input in its own dialect (the captured bound reaches a
// now-deleted index), but it must never SUCCEED with a different answer. That
// is the outcome every one of these produced before the bounds were captured —
// a short well-formed genotype stream, a truncated attested population, and a
// `compareTraces` verdict of null ("identical") for divergent traces.

function shrinkingArray(values, shrinkTo) {
  const arr = [];
  arr.length = values.length;
  let fired = false;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    Object.defineProperty(arr, i, {
      configurable: true,
      enumerable: true,
      get() {
        if (!fired) { fired = true; arr.length = shrinkTo; }
        return v;
      },
    });
  }
  return arr;
}

const outcomeOf = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, message: e.message };
  }
};

const multiAxleGenotype = () => {
  for (let i = 0; i < 200; i += 1) {
    const g = genotype(i);
    if (g.axles.length >= 2) return g;
  }
  throw new Error('no multi-axle genotype in the corpus');
};

// [name, honest builder, poisoned builder, call]
const LOOP_BOUND_CASES = [
  ['assembly.serializeGenotype (axles)',
    () => [multiAxleGenotype()],
    () => {
      const g = multiAxleGenotype();
      return [{ ...g, axles: shrinkingArray(g.axles, 1) }];
    },
    (g) => serializeGenotype(g)],
  ['assembly.repairGenotype (axles)',
    () => [multiAxleGenotype()],
    () => {
      const g = multiAxleGenotype();
      return [{ ...g, axles: shrinkingArray(g.axles, 1) }];
    },
    (g) => serializeGenotype(repairGenotype(g))],
  ['population.attestPopulation (individuals)',
    () => [smallPopulation()],
    () => {
      const p = smallPopulation();
      return [{ ...p, individuals: shrinkingArray(p.individuals, 2) }];
    },
    (p) => attestPopulation(p).bytes],
  ['population.serializePopulationSnapshot (individuals)',
    () => [smallPopulation()],
    () => {
      const p = smallPopulation();
      return [{ ...p, individuals: shrinkingArray(p.individuals, 2) }];
    },
    (p) => serializePopulationSnapshot(p)],
  ['population-evaluation.serializeFitnessVector (individuals)',
    () => [fitnessEvaluation()],
    () => {
      const e = fitnessEvaluation();
      return [{ ...e, individuals: shrinkingArray(e.individuals, 2) }];
    },
    (e) => serializeFitnessVector(e)],
  ['population-initializer.createInitialPopulation (initialSuspensionTypes)',
    () => [{ seed: 20260721, populationSize: 2, initialSuspensionTypes: ['S0', 'S1'] }],
    () => [{
      seed: 20260721,
      populationSize: 2,
      initialSuspensionTypes: shrinkingArray(['S0', 'S1'], 1),
    }],
    // The manifest bytes: a silently-narrowed category list changes the draw
    // table, so the whole generation differs while the manifest still attests
    // to a two-category policy.
    (c) => serializePopulationInitialization(createInitialPopulation(c))],
  ['population-evaluation.spawnPoseOnFlatStart (ir.axles)',
    () => [compileAssembly(realizableGenotype()), { x: -44, z: 0 }],
    () => {
      const ir = compileAssembly(realizableGenotype());
      return [{ ...ir, axles: shrinkingArray(ir.axles, 0) }, { x: -44, z: 0 }];
    },
    (ir, opts) => spawnPoseOnFlatStart(ir, opts)],
  ['trace.compareTraces (records — divergent pair)',
    () => {
      const b = fullTrace();
      b.records[2] = encodeTraceRecord(chassisRecord(2, { linvel: { x: 42, y: 0, z: 0 } }));
      return [fullTrace(), b];
    },
    () => {
      const b = fullTrace();
      b.records[2] = encodeTraceRecord(chassisRecord(2, { linvel: { x: 42, y: 0, z: 0 } }));
      const a = fullTrace();
      return [{ ...a, records: shrinkingArray(a.records, 1) }, b];
    },
    (a, b) => compareTraces(a, b)],
  // The COUNT verdict specifically: shrink to exactly the loop's bound so the
  // walk completes and execution REACHES the missing/extra branches. Without
  // this the two verdict re-reads were unreachable, and reverting them stayed
  // green — the truncated walk always threw first.
  ['trace.compareTraces (records — the missingRecord verdict)',
    () => {
      const a = fullTrace(); // 3 records
      const b = fullTrace();
      b.records.length = 2; // 2 records: a genuine missingRecord
      return [a, b];
    },
    () => {
      const a = fullTrace();
      const b = fullTrace();
      b.records.length = 2;
      // Shrinks 3 -> 2, which is exactly `n`, so indices 0..1 stay readable.
      return [{ ...a, records: shrinkingArray(a.records, 2) }, b];
    },
    (a, b) => compareTraces(a, b)],
  ['trace.compareTraces (records — the extraRecord verdict)',
    () => {
      const a = fullTrace();
      a.records.length = 2;
      return [a, fullTrace()];
    },
    () => {
      const a = fullTrace();
      a.records.length = 2;
      const b = fullTrace();
      return [a, { ...b, records: shrinkingArray(b.records, 2) }];
    },
    (a, b) => compareTraces(a, b)],
  ['trace.compareCheckpoints (entries — divergent pair)',
    () => {
      const b = checkpoints();
      b[1].state = 999;
      return [checkpoints(), b];
    },
    () => {
      const b = checkpoints();
      b[1].state = 999;
      return [shrinkingArray(checkpoints(), 1), b];
    },
    (a, b) => compareCheckpoints(a, b)],
  // `perBody.length` would NOT discriminate here (all three captures belong to
  // one body), so the assertion reads the per-body CAPTURE COUNT and the step
  // range — the values a truncated walk actually changes. A tooth that cannot
  // tell the two apart is not a tooth.
  ['trace-forensics.analyzeTrace (records)',
    () => [fullTrace(), { captureDt: 1 / 60 }],
    () => {
      const t = fullTrace();
      return [{ ...t, records: shrinkingArray(t.records, 1) }, { captureDt: 1 / 60 }];
    },
    (t, o) => {
      const a = analyzeTrace(t, o);
      return { bodies: a.perBody.length, captures: a.perBody[0].captureCount, range: a.stepRange };
    }],
  ['trace-forensics.analyzeTrace (bodies — the reach map)',
    () => [fullTrace(), { captureDt: 1 / 60, bodies: bodyReachMetadataForIR(compileAssembly(realizableGenotype())) }],
    () => {
      const bodies = bodyReachMetadataForIR(compileAssembly(realizableGenotype()));
      return [fullTrace(), { captureDt: 1 / 60, bodies: shrinkingArray(bodies, 1) }];
    },
    (t, o) => analyzeTrace(t, o).perBody.length],
  ['trace-forensics.bodyReachMetadataForIR (ir.axles)',
    () => [compileAssembly(realizableGenotype())],
    () => {
      const ir = compileAssembly(realizableGenotype());
      return [{ ...ir, axles: shrinkingArray(ir.axles, 0) }];
    },
    (ir) => bodyReachMetadataForIR(ir).length],
  ['integrity.foldIntegrity (reads)',
    () => [integrityReads()],
    () => [shrinkingArray(integrityReads(), 1)],
    (reads) => {
      const state = createIntegrityState(2, 1 / 60);
      foldIntegrity(state, 0, reads);
      return state.peakBodySpeed;
    }],
  // C9/I3: offlineIntegrityView folds analysis.perBody. capturePerBody re-read
  // that bound inside the walk, so a shrinking getter dropped a catastrophic
  // body and the view returned status:'ok'. The status derived from the walked
  // rows must not change when the poison shrinks the array behind a captured
  // bound — either the same status, or a loud failure.
  ['trace-forensics.offlineIntegrityView (analysis.perBody)',
    () => [catastrophicAnalysis()],
    () => {
      const a = catastrophicAnalysis();
      return [{ ...a, perBody: shrinkingArray(a.perBody, 0) }];
    },
    (a) => offlineIntegrityView(a).status],
];

describe('loop bounds captured before caller code runs (round-11)', () => {
  test.each(LOOP_BOUND_CASES)('%s: a shrinking element getter never yields a different answer',
    (name, honest, poisoned, call) => {
      const expected = outcomeOf(() => call(...honest()));
      expect(expected.ok).toBe(true); // the control must be a real success
      const actual = outcomeOf(() => call(...poisoned()));
      if (actual.ok) {
        // Succeeded — then it must be the SAME answer, not a silent prefix.
        expect(actual.value).toEqual(expected.value);
      } else {
        // Rejected — then loudly, in the owning module's dialect.
        expect(actual.message).toMatch(MODULE_DIALECT);
      }
    });

  test('the battery is honest: an uncaptured bound is caught', () => {
    // A deliberately-broken walk with the exact defect shape, proving the
    // assertion above reddens rather than passing vacuously.
    const broken = (arr) => {
      const out = [];
      for (let i = 0; i < arr.length; i += 1) out.push(arr[i]);
      return out;
    };
    const fixed = (arr) => {
      const n = arr.length;
      const out = [];
      for (let i = 0; i < n; i += 1) out.push(arr[i]);
      return out;
    };
    expect(broken([1, 2, 3])).toEqual([1, 2, 3]);
    expect(broken(shrinkingArray([1, 2, 3], 1))).toEqual([1]); // silent prefix
    expect(fixed(shrinkingArray([1, 2, 3], 1))).toEqual([1, undefined, undefined]);
  });
});

// --- The rejection paths (round-11) -----------------------------------------
//
// Every CASES row asserts the call SUCCEEDS (`if (threw) throw threw`), so no
// error branch in the repo was instrumented — and a diagnostic that re-reads
// the caller inside its own message is invisible to a success-only table. Two
// were measured: a `snapshotVersion` rejected at 7 and PRINTED as 4242, and an
// `ir.version` rejected at 77 and printed as 2 — the currently-VALID version,
// a report that contradicts the rejection it explains.
//
// Each row: a two-faced accessor whose first read is the rejected value. The
// message must name THAT value, never the later one.

const twoFaced = (first, later) => {
  let n = 0;
  return { get value() { n += 1; return n === 1 ? first : later; } };
};

const REJECTION_CASES = [
  ['population.validatePopulation (snapshotVersion)',
    () => {
      const p = smallPopulation();
      const v = twoFaced(7, 4242);
      return [{ get snapshotVersion() { return v.value; }, individuals: p.individuals }];
    },
    (p) => validatePopulation(p),
    /snapshotVersion \(7\)/],
  ['population-evaluation.spawnPoseOnFlatStart (ir.version)',
    () => {
      const ir = compileAssembly(realizableGenotype());
      const v = twoFaced(77, 2);
      return [{ ...ir, get version() { return v.value; } }, { x: -44, z: 0 }];
    },
    (ir, opts) => spawnPoseOnFlatStart(ir, opts),
    /ir\.version \(77\)/],
];

describe('rejection paths name the value that was rejected (round-11)', () => {
  test.each(REJECTION_CASES)('%s', (name, build, call, re) => {
    expect(() => call(...build())).toThrow(re);
  });
});

// --- Structural guards on caller collections (round-11) ---------------------
//
// Ordinary malformed data must leave a public seam in the OWNING module's
// dialect, never as a foreign TypeError and never as a silently narrower
// answer. `bodyReachMetadataForIR`'s non-array `wheels` is the sharpest case:
// the indexed rewrite made it return chassis-only metadata with NO error,
// nulling every wheel and hub tip-speed proxy, where the previous shape threw.

describe('malformed caller collections fail loud, never silently narrow', () => {
  const ir = () => compileAssembly(realizableGenotype());

  test.each([
    ['axles[0] is not an object', (x) => { x.axles = [42]; }],
    ['axles[0] is null', (x) => { x.axles = [null]; }],
    // `{}` specifically, not a string: a string has a `length`, so the loop
    // still runs and fails on its first character. An object with NO length
    // makes the loop run zero times — the SILENT path (chassis-only metadata,
    // every wheel and hub tip-speed proxy nulled, no error) that this module's
    // indexed rewrite introduced and that a string never exposes.
    ['axles[0].wheels is not an array', (x) => { x.axles = [{ ...x.axles[0], wheels: {} }]; }],
    ['axles[0].wheels[0] is null', (x) => { x.axles = [{ ...x.axles[0], wheels: [null] }]; }],
  ])('bodyReachMetadataForIR: %s', (label, mutate) => {
    const x = { ...ir(), axles: [...ir().axles] };
    mutate(x);
    expect(() => bodyReachMetadataForIR(x)).toThrow(MODULE_DIALECT);
  });

  test.each([
    ['axles[0] is not an object', (x) => { x.axles = [42]; }],
    ['axles[0] is null', (x) => { x.axles = [null]; }],
    // `{}` specifically, not a string: a string has a `length`, so the loop
    // still runs and fails on its first character. An object with NO length
    // makes the loop run zero times — the SILENT path (chassis-only metadata,
    // every wheel and hub tip-speed proxy nulled, no error) that this module's
    // indexed rewrite introduced and that a string never exposes.
    ['axles[0].wheels is not an array', (x) => { x.axles = [{ ...x.axles[0], wheels: {} }]; }],
    ['a hole in axles', (x) => { const a = [...x.axles]; a.length = a.length + 1; x.axles = a; }],
    // C9/I9: vehicleWheelTransforms dereferences axle.suspension.type; a missing
    // suspension escaped as a foreign TypeError the guard comment claims to close.
    ['axles[0].suspension is missing', (x) => { const a = { ...x.axles[0] }; delete a.suspension; x.axles = [a]; }],
    ['axles[0].suspension is null', (x) => { x.axles = [{ ...x.axles[0], suspension: null }]; }],
  ])('spawnPoseOnFlatStart: %s', (label, mutate) => {
    const x = { ...ir(), axles: [...ir().axles] };
    mutate(x);
    expect(() => spawnPoseOnFlatStart(x, { x: -44, z: 0 })).toThrow(MODULE_DIALECT);
  });

  test.each([
    ['linvel is a primitive', (r) => { r.linvel = 5; }],
    ['linvel is missing', (r) => { delete r.linvel; }],
    ['translation is a primitive', (r) => { r.translation = 'x'; }],
    ['translation is null', (r) => { r.translation = null; }],
  ])('foldIntegrity: %s fails loud, never a silent status:ok', (label, mutate) => {
    // C9/F14: the guard checked the entry but not the fields it dereferences, so
    // a primitive linvel read `.x` === undefined → NaN comparisons all false →
    // status stayed 'ok' over unread data; a missing one escaped as a foreign
    // TypeError off `.linvel`.
    const reads = integrityReads();
    mutate(reads[0]);
    const state = createIntegrityState(2, 1 / 60);
    expect(() => foldIntegrity(state, 0, reads)).toThrow(MODULE_DIALECT);
  });

  test('compareTraces: a sibling-record getter cannot overwrite the opposing byte array to fake "identical"', () => {
    // C9/I6: `e.bytes` used to be the caller's Uint8Array BY REFERENCE, so
    // encoding the OTHER side's plain-record entry could run a getter that
    // overwrote it to match, and compareTraces returned null for a divergent
    // pair. Bytes are copied on intake now.
    const expRec0 = encodeTraceRecord(chassisRecord(0));
    const actRecord = chassisRecord(0, { linvel: { x: 42, y: 0, z: 0 } });
    const actBytes = encodeTraceRecord(actRecord); // what the poison will paste
    const exp = { version: EVALUATION_TRACE_VERSION, recordBytes: RECORD_BYTES, records: [expRec0] };
    // act[0] is a plain record equal to actRecord, but reading `.translation`
    // during encode overwrites exp's byte array to actBytes.
    const poisoned = {
      ...actRecord,
      get translation() { expRec0.set(actBytes); return actRecord.translation; },
    };
    const act = { version: EVALUATION_TRACE_VERSION, recordBytes: RECORD_BYTES, records: [poisoned] };
    const result = compareTraces(exp, act);
    expect(result).not.toBeNull(); // the divergence must be reported, not hidden
    expect(result.kind).toBe('fieldMismatch');
  });

  test('analyzeTrace: an own forEach on bodies cannot skip the validation walk', () => {
    // `bodies.forEach` was looked up on the CALLER's array, so a no-op own
    // forEach silently produced an EMPTY reach map: every malformed entry
    // passed and tip speed came back null with no error. The walk is indexed
    // now, so the malformed entry is what it always should have been — loud.
    const bodies = [{ vehicleIndex: 0, bodyRole: 'chassis', axleIndex: null, wheelIndex: null, reach: -1 }];
    Object.defineProperty(bodies, 'forEach', { value: () => {}, configurable: true });
    expect(() => analyzeTrace(fullTrace(), { captureDt: 1 / 60, bodies }))
      .toThrow(/bodies\[0\]\.reach/);
  });

  test('analyzeTrace: an own Symbol.iterator on bodies cannot substitute the walk', () => {
    // The other half of "never walk a caller collection through caller code":
    // `forEach` and `Symbol.iterator` are the same defect wearing two names.
    // Index 0 holds a malformed entry; the iterator yields a valid one. An
    // iterator-driven walk validates what it was HANDED and the map keys what
    // the indices hold — two different collections.
    const bad = { vehicleIndex: 0, bodyRole: 'chassis', axleIndex: null, wheelIndex: null, reach: -1 };
    const good = { vehicleIndex: 0, bodyRole: 'chassis', axleIndex: null, wheelIndex: null, reach: 1 };
    const bodies = [bad];
    Object.defineProperty(bodies, Symbol.iterator, {
      configurable: true,
      value: function* iterate() { yield good; },
    });
    expect(() => analyzeTrace(fullTrace(), { captureDt: 1 / 60, bodies }))
      .toThrow(/bodies\[0\]\.reach/);
  });

  test('analyzeTrace: a two-faced reach cannot store a value no check saw', () => {
    // A nonzero angvel, so tip speed = |angvel| * reach actually depends on the
    // stored value and the assertion cannot pass vacuously at 0.
    const spinning = () => ({
      version: EVALUATION_TRACE_VERSION,
      mode: 'full',
      recordBytes: RECORD_BYTES,
      records: [0, 1, 2].map((k) => encodeTraceRecord(
        chassisRecord(k, { angvel: { x: 0, y: 0, z: 4 } }),
      )),
    });
    const body = (reach) => ({
      vehicleIndex: 0, bodyRole: 'chassis', axleIndex: null, wheelIndex: null, reach,
    });
    let n = 0;
    const poisoned = [{ ...body(1), get reach() { n += 1; return n === 1 ? 1 : 1e6; } }];
    const a = analyzeTrace(spinning(), { captureDt: 1 / 60, bodies: poisoned });
    expect(n).toBe(1);
    const control = analyzeTrace(spinning(), { captureDt: 1 / 60, bodies: [body(1)] });
    expect(control.perBody[0].peakTipSpeed.value).toBeGreaterThan(0); // discriminating
    expect(a.perBody[0].peakTipSpeed).toEqual(control.perBody[0].peakTipSpeed);
  });
});

// --- ownPlainData fidelity (round-11) ---------------------------------------
//
// The copy that makes `spawnPoseOnFlatStart`'s ownership boundary true is new
// in this PR and was the least-reviewed code in it. Three gaps, each measured:
// a non-Object.prototype container passed through BY REFERENCE (so the planner
// re-read caller data and a caller-installed `forEach` ran inside the module —
// spawn y 50.42 vs 0.54); `out[key] = ...` on an own `"__proto__"` key invoked
// the inherited SETTER, dropping the property and giving the copy a
// caller-chosen prototype; and unbounded recursion turned a cyclic IR into a
// foreign RangeError.

describe('ownPlainData copies with fidelity or refuses (round-11)', () => {
  const baseIr = () => compileAssembly(realizableGenotype());
  const withAxles = (axles) => ({ ...baseIr(), axles });

  test('a null-prototype axle is copied, not aliased — and still yields the honest pose', () => {
    const ir = baseIr();
    const control = spawnPoseOnFlatStart(ir, { x: -44, z: 0 });
    const dictAxles = ir.axles.map((a) => Object.assign(Object.create(null), a));
    const got = spawnPoseOnFlatStart(withAxles(dictAxles), { x: -44, z: 0 });
    expect(got).toEqual(control);
  });

  test('a class-instance axle is refused rather than silently passed by reference', () => {
    class Axle {}
    const ir = baseIr();
    const exotic = ir.axles.map((a) => Object.assign(new Axle(), a));
    expect(() => spawnPoseOnFlatStart(withAxles(exotic), { x: -44, z: 0 }))
      .toThrow(MODULE_DIALECT);
  });

  test('an own "__proto__" key cannot smuggle structure through the copy', () => {
    // Exactly what `JSON.parse('{"__proto__": {...}}')` yields — plain data, an
    // own data property, not the inherited accessor. With `out[key] = ...` the
    // ASSIGNMENT invoked that inherited setter: the property vanished from the
    // copy and the copy's PROTOTYPE became the caller's object, so an axle with
    // no own `wheels` silently acquired one and the guards below saw a
    // well-formed axle that the caller's data never contained.
    // `defineProperty` stores it as data, so the missing `wheels` stays missing
    // and is refused.
    const ir = baseIr();
    const axle = { ...ir.axles[0] };
    delete axle.wheels;
    Object.defineProperty(axle, '__proto__', {
      value: { wheels: [] }, enumerable: true, configurable: true, writable: true,
    });
    // Premise: the own key really is own and enumerable (not the accessor).
    expect(Object.keys(axle)).toContain('__proto__');
    expect(() => spawnPoseOnFlatStart(withAxles([axle]), { x: -44, z: 0 }))
      .toThrow(/ir\.axles\[0\]\.wheels/);
  });

  test('a cyclic IR fails in the module dialect, never as a foreign RangeError', () => {
    const ir = baseIr();
    const axles = ir.axles.map((a) => ({ ...a }));
    axles[0].self = axles[0]; // an ordinary cycle in plain data
    let message = '';
    try {
      spawnPoseOnFlatStart(withAxles(axles), { x: -44, z: 0 });
    } catch (e) {
      message = e.message;
    }
    expect(message).toMatch(MODULE_DIALECT);
    expect(message).not.toMatch(/call stack/);
  });
});

// --- Optional-key defaulting (round-11) -------------------------------------

describe('absent and explicit-undefined default; explicit null is loud', () => {
  test('spawnPoseOnFlatStart clearance: undefined defaults, null fails', () => {
    const ir = compileAssembly(realizableGenotype());
    const control = spawnPoseOnFlatStart(ir, { x: -44, z: 0 });
    // `{clearance: opts.clearance}` forwarding produces exactly this shape, and
    // the round-10 `Object.hasOwn` guard rejected it where main ran.
    expect(spawnPoseOnFlatStart(ir, { x: -44, z: 0, clearance: undefined })).toEqual(control);
    expect(() => spawnPoseOnFlatStart(ir, { x: -44, z: 0, clearance: null }))
      .toThrow(/spawn\.clearance/);
  });

  test('createInitialPopulation keepRaw: undefined defaults, null fails', () => {
    const cfg = { seed: 20260721, populationSize: 2 };
    const control = createInitialPopulation(cfg);
    const got = createInitialPopulation(cfg, { keepRaw: undefined });
    expect(got.population.individuals).toHaveLength(control.population.individuals.length);
    expect(got.population.individuals[0].rawGenotype).toBeUndefined();
    expect(() => createInitialPopulation(cfg, { keepRaw: null })).toThrow(/keepRaw/);
  });
});

// --- Non-enumerable own properties (round-11) -------------------------------
//
// The counting instrument copies own ENUMERABLE properties, so this axis was
// invisible to it. The class: a guard that decides PRESENCE with
// `hasOwnProperty` (which sees non-enumerable own properties) while the
// consumer reads with a SPREAD (which does not). Ordinary data — one
// `Object.defineProperty` call, no Proxy.
//
// The two production seams are execution paths behind Rapier, so their
// regressions live with the physics harness (tests/evaluation.test.js and
// tests/population-evaluation.test.js). What is pinned here is the language
// fact the guards must respect, so the rule is stated where the invariant is.

describe('presence gates and their consumers use one enumeration (round-11)', () => {
  test('hasOwnProperty sees what a spread drops — the split that hid a seed', () => {
    const t = { length: 120 };
    Object.defineProperty(t, 'seed', { value: 20260722, enumerable: false });
    expect(Object.prototype.hasOwnProperty.call(t, 'seed')).toBe(true);
    expect(Object.keys(t).includes('seed')).toBe(false);
    expect({ seed: 0, ...t }.seed).toBe(0); // the default survives the "present" key
    expect(Object.getOwnPropertyNames(t).length).not.toBe(Object.keys(t).length);
  });
});

// --- The round-10 named regressions (poison getters) ------------------------
//
// Each reproduces the concrete reviewer finding: first read valid, second
// read poison. With the invariant holding these poisons are UNREACHABLE —
// asserted directly on top of the counting proof above.

describe('round-10 poison regressions', () => {
  test('F1: a valid-then-NaN gene getter cannot reach the genotype wire', () => {
    const g = genotype();
    const base = g.hue;
    let reads = 0;
    Object.defineProperty(g, 'hue', {
      configurable: true,
      get() { reads += 1; return reads === 1 ? base : NaN; },
    });
    const bytes = serializeGenotype(g);
    expect(reads).toBe(1); // exactly one read: the validated one is the encoded one
    const decoded = deserializeGenotype(bytes); // the decoder must accept encoder output
    expect(Object.is(decoded.hue, base)).toBe(true);
    expect(serializeGenotype(decoded)).toEqual(bytes); // re-encode byte-identical
  });

  test('F2: a valid-true-true-false validity getter cannot emit a contradictory member', () => {
    let validReads = 0;
    const evaluation = {
      populationSnapshotDigestState: 1,
      evaluationSpecDigestState: 2,
      individuals: [{
        individualId: 0,
        get valid() { validReads += 1; return validReads < 3; },
        integrityStatus: 'ok',
        fitness: 1,
      }],
    };
    const bytes = serializeFitnessVector(evaluation);
    expect(validReads).toBe(1);
    const decoded = deserializeFitnessVector(bytes); // must not be rejected
    expect(decoded.individuals[0].valid).toBe(true);
    expect(decoded.individuals[0].fitness).toBe(1);
  });

  test('F3: a valid-then-off-pad spawn.x getter cannot move the resolved spawn', () => {
    // The public pure seam for the resolved-spawn shape: the encoder. (The
    // execution seam, resolveSpec via evaluatePopulation, is covered by the
    // same capture — its regression lives in tests/population-evaluation.test.js
    // where the physics harness already runs.)
    let reads = 0;
    const spec = resolvedSpec();
    Object.defineProperty(spec.spawn, 'x', {
      configurable: true,
      get() { reads += 1; return reads === 1 ? -44 : 100; },
    });
    const bytes = serializeEvaluationSpec(spec);
    expect(reads).toBe(1);
    // The encoded spawn.x is the validated one.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // spawn.x is the first f64 after u16 version + u8 flag + u8 termination + u32 maxSteps.
    expect(view.getFloat64(8, true)).toBe(-44);
  });

  test('F4: duplicate individualIds are refused by both selectors, in every order', () => {
    const row = (tag) => ({
      individualId: 3, valid: true, integrityStatus: 'ok', fitness: 10, diagnostics: { tag },
    });
    const a = row('a');
    const b = row('b');
    for (const individuals of [[a, b], [b, a]]) {
      expect(() => championFromEvaluation({ individuals }))
        .toThrow(/population-evaluation: .*duplicate/);
      expect(() => selectableChampionFromEvaluation({ individuals }))
        .toThrow(/population-evaluation: .*duplicate/);
    }
  });
});
