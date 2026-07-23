// THE EVOLUTION EXPERIMENT — GA Phase 1B PR 4's empirical instrument.
//
//   npm run experiment:evolution -- --phase smoke     the fast end-to-end proof
//   npm run experiment:evolution -- --phase screen    the broad screening sweep
//   npm run experiment:evolution -- --phase confirm   the held-out confirmation
//   npm run experiment:evolution -- --phase report    build the evidence JSON
//
// WHAT IT IS. A resumable offline experiment that measures fitness, diversity,
// integrity, runtime and history growth across a predeclared mutation grid, and
// then confirms ONE candidate on held-out seeds under a gate declared before any
// number was seen. Its output is a normalized JSON evidence file plus a report;
// its authority is exactly the authority of that predeclaration.
//
// WHAT IT IS NOT, stated up front because instruments in this repo have drifted
// into oracles before (the evolution probe's header says the same thing for the
// same reason). This module establishes NO lock authority. It asserts no physics
// magnitude. It does not persist evolution history artifacts — it retains
// normalized summaries and digests. Nothing it measures may become a CI
// threshold: the broad phases never run in CI, and the committed tests check
// STRUCTURE, arithmetic and decision logic, never an empirical magnitude.
//
// THE ONE RULE THAT MAKES THE EVIDENCE WORTH ANYTHING. Screening PROPOSES and
// confirmation DECIDES, on disjoint seeds, against gates written down before the
// broad run. Choosing the best of 26 arms on 6 shared seeds picks noise a
// meaningful fraction of the time, so a screening win authorizes nothing on its
// own. The vocabulary — arm, replicate, screening set, confirmation set,
// selectable fitness, genotype uniqueness, gene-space dispersion — is defined
// once in CONTEXT.md and used here with exactly those meanings.
//
// SELECTABLE FITNESS ONLY. Every score here is fitness-policy v2's
// integrity-gated fitness, read from the persisted fitness vector. The raw
// progress metrics are deliberately not used: Phase 1A's finite-explosion tail
// (8.17e6 m at 1.43e8 m/s, `valid` true) would dominate any mean taken from
// them, and PR-B's whole point is that such an individual is not selectable.
//
// TRACE EXCLUSION HOLDS HERE TOO. This module imports no trace module and never
// asks for trace evidence; it reads only the four persisted component kinds
// through their public decoders. The PR 3 Commit 0 deferral's split trigger is
// therefore untouched.
//
// Node-only, outside the src/sim ESLint ban — wall clock, filesystem and git are
// allowed here, and nothing this module measures enters a simulation digest.
// Timing is an OBSERVATION: it is excluded from the tuning decision and from the
// evidence digest by construction, not by convention.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { Rng } from '../src/sim/prng.js';
import { createEvolutionRun } from '../src/sim/evolution-run.js';
import {
  decodeEvolutionHeader, decodeGenerationPayload, decodeHistoryFraming,
  deserializeEvaluationMetadata,
} from '../src/sim/evolution-history.js';
import { deserializeLineage, LINEAGE_ACCOUNTING_KEYS, LINEAGE_ORIGINS } from '../src/sim/evolution-lineage.js';
import {
  deserializeFitnessVector, spawnPoseOnFlatStart,
} from '../src/sim/population-evaluation.js';
import { runEvaluation } from '../src/sim/evaluation.js';
import { deserializePopulationSnapshot } from '../src/sim/population.js';
import { createInitialPopulation } from '../src/sim/population-initializer.js';
import {
  compileAssembly, genotypeFieldWalk, serializeGenotype,
} from '../src/sim/assembly.js';
import { bytesToHex } from '../src/sim/bytes.js';
import { TERRAIN_DEFAULTS } from '../src/sim/terrain.js';
import { MOTOR_TARGET_WHEEL_SURFACE_SPEED } from '../src/sim/physics/adapter.js';
import { sha256 } from '../src/platform/sha256.js';

export const EXPERIMENT_SCHEMA = 'boxcar3d.evolution-experiment/1';
export const EXPERIMENT_RUN_SCHEMA = 'boxcar3d.evolution-experiment-run/1';
export const EXPERIMENT_PROTOCOL_VERSION = 1;

/** The phases the CLI accepts. `report` executes nothing; it reads and decides. */
export const EXPERIMENT_PHASES = Object.freeze([
  'smoke', 'screen', 'confirm', 'report', 'forensics', 'escalation-cost',
]);

/**
 * The declared forensic sample: (replicate index, arm) pairs whose champions are
 * re-evaluated through the PRODUCTION runner so their integrity OBSERVATIONS
 * (peak body speed, first alert step) can be read directly.
 *
 * WHY THIS PHASE EXISTS. The persisted fitness vector stores an integrity
 * STATUS, not the observations behind it, so a history cannot answer "was this
 * champion locomotion or divergence?". Re-evaluation can. Without this phase the
 * report's central claim would rest on numbers produced by a throwaway script —
 * and this repo's standing rule is that every figure in an empirical report must
 * regenerate from a committed arm.
 *
 * The sample is DECLARED, not chosen after the fact: three replicates that
 * exhibited over-ceiling champions and three that did not, each sampled at its
 * lowest, median and highest selectable champion. That spread is what makes the
 * result falsifiable in both directions — it can show a high-fitness champion is
 * healthy, or a low-fitness one is not.
 */
export const FORENSIC_SAMPLE = Object.freeze([
  // Screening: three replicates that showed over-ceiling champions, three that
  // did not.
  Object.freeze({ phase: 'screen', replicateIndex: 1, armId: 'p0.025-m0.025' }),
  Object.freeze({ phase: 'screen', replicateIndex: 2, armId: 'p0.200-m0.100' }),
  Object.freeze({ phase: 'screen', replicateIndex: 3, armId: 'p0.200-m0.200' }),
  Object.freeze({ phase: 'screen', replicateIndex: 0, armId: 'p0.200-m0.200' }),
  Object.freeze({ phase: 'screen', replicateIndex: 4, armId: 'p0.200-m0.200' }),
  Object.freeze({ phase: 'screen', replicateIndex: 5, armId: 'p0.050-m0.200' }),
  // CONFIRMATION. The first draft could not express these at all — every case
  // resolved against `protocol.screen` and `runForensicCase` hard-coded
  // `phase: 'screen'` — so the phase carrying the report's strongest positive
  // claim had no re-evaluation evidence whatsoever. Replicate 2 is the
  // zero-mutation CONTROL's contaminated replicate, whose generation-0 champion
  // is already over the ceiling; replicate 0 is clean.
  Object.freeze({ phase: 'confirm', replicateIndex: 2, armId: 'control' }),
  Object.freeze({ phase: 'confirm', replicateIndex: 2, armId: 'p0.050-m0.050' }),
  Object.freeze({ phase: 'confirm', replicateIndex: 0, armId: 'p0.050-m0.050' }),
]);

/** Phases that produce citable evidence, and therefore require a clean tree. */
const CITABLE_PHASES = Object.freeze(['screen', 'confirm']);

/**
 * The symmetry gene's boolean threshold, restated here for the morphology
 * histogram.
 *
 * assembly.js does not export `boolGene`, and copying a decode rule is exactly
 * the class that bit this project before (reordering SUSPENSION_TYPES flipped
 * every archived axle's suspension while both locks stayed byte-identical). So
 * this constant is NOT trusted on its own: tests/evolution-experiment.test.js
 * binds it BEHAVIOURALLY to `compileAssembly` by straddling the threshold with a
 * genotype whose latent asym block is non-neutral and asserting the compiler
 * expresses asymmetry on exactly one side. If the production rule moves, that
 * test reddens.
 */
export const SYMMETRY_GENE_THRESHOLD = 0.5;

function fail(message, context = {}) {
  const error = new Error(`experiment-evolution: ${message}`);
  error.context = context;
  throw error;
}

// --- Canonical JSON ----------------------------------------------------------
//
// The evidence digest is a SHA-256 over bytes, so the JSON it covers must have
// exactly one spelling. Keys are emitted in sorted order (JSON object order is
// not semantic and insertion order would make the digest depend on construction
// accidents); arrays keep their order, which IS semantic. `undefined`,
// functions, NaN and +/-Infinity are refused rather than coerced — JSON.stringify
// silently turns the first two into holes and the last two into `null`, and a
// digest that cannot distinguish "absent" from "not a number" attests nothing.

/** Serialize `value` with sorted keys and no lossy coercion. */
export function canonicalJson(value, path = '$') {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) fail(`non-finite number at ${path} (${String(value)}) — use null`, { path });
    // Object.is separates -0 from 0; JSON.stringify(-0) is "0", which would make
    // two different values share a digest.
    return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const n = value.length; // captured once
    const parts = [];
    for (let i = 0; i < n; i += 1) parts.push(canonicalJson(value[i], `${path}[${i}]`));
    return `[${parts.join(',')}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(value).slice().sort();
    const parts = [];
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const v = value[k];
      if (v === undefined) fail(`undefined at ${path}.${k} — use null`, { path: `${path}.${k}` });
      parts.push(`${JSON.stringify(k)}:${canonicalJson(v, `${path}.${k}`)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return fail(`unserializable ${t} at ${path}`, { path });
}

/** SHA-256 hex over the canonical JSON of `value`. */
export async function canonicalDigest(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return bytesToHex(await sha256(bytes));
}

// --- Protocol ----------------------------------------------------------------

const MUTATION_GRID = Object.freeze([0.01, 0.025, 0.05, 0.1, 0.2]);

const BASELINE_ARM = Object.freeze({ probability: 0.05, magnitude: 0.05 });

/** Three decimals: the grid's finest value (0.01) and 0.025 both round exactly. */
function formatArmNumber(v) {
  return v.toFixed(3);
}

/** The stable id of an arm. `control` is named, never spelled `p0.000-m0.000`. */
export function armIdFor(probability, magnitude) {
  if (probability === 0 && magnitude === 0) return 'control';
  return `p${formatArmNumber(probability)}-m${formatArmNumber(magnitude)}`;
}

export const BASELINE_ARM_ID = armIdFor(BASELINE_ARM.probability, BASELINE_ARM.magnitude);
export const CONTROL_ARM_ID = 'control';

function armRecord(probability, magnitude) {
  return Object.freeze({ armId: armIdFor(probability, magnitude), probability, magnitude });
}

function replicateList(populationSeeds, terrainSeeds) {
  if (populationSeeds.length !== terrainSeeds.length) {
    fail(`replicate seed lists differ in length (${populationSeeds.length} vs ${terrainSeeds.length})`);
  }
  const out = [];
  for (let i = 0; i < populationSeeds.length; i += 1) {
    out.push(Object.freeze({
      replicateIndex: i,
      populationSeed: populationSeeds[i],
      terrainSeed: terrainSeeds[i],
    }));
  }
  return Object.freeze(out);
}

function seq(start, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(start + i);
  return Object.freeze(out);
}

/**
 * The predeclared protocol. Pure, deterministic, and the ONLY place any number
 * of the experimental design appears.
 *
 * `kind` is `full` (the real experiment) or `smoke` (a tiny end-to-end shape
 * proof that exercises every seam in seconds). The smoke protocol carries its
 * OWN seeds so a smoke workspace can never be confused with citable evidence,
 * and its `citable` flag is false by construction.
 */
export function buildExperimentProtocol(kind = 'full') {
  if (kind !== 'full' && kind !== 'smoke') fail(`unknown protocol kind '${String(kind)}'`);
  const smoke = kind === 'smoke';

  const grid = [];
  for (const probability of MUTATION_GRID) {
    for (const magnitude of MUTATION_GRID) grid.push(armRecord(probability, magnitude));
  }
  const screenArms = smoke
    ? Object.freeze([armRecord(0, 0), armRecord(0.05, 0.05), armRecord(0.2, 0.2)])
    : Object.freeze([armRecord(0, 0), ...grid]);

  const protocol = {
    schema: EXPERIMENT_SCHEMA,
    protocolVersion: EXPERIMENT_PROTOCOL_VERSION,
    kind,
    citable: !smoke,
    // The fixed workload. Identical in both phases: only mutation parameters,
    // seeds and the generation budget differ between arms and phases.
    workload: Object.freeze({
      populationSize: smoke ? 4 : 20,
      maxSteps: smoke ? 20 : 300,
      deterministic: true,
      worldMode: 'isolatedWorlds',
      spawn: Object.freeze({ x: -44, z: 0 }),
      // The established composite corridor: craters, features and zones all at
      // their defaults (ON). Only the start pad is declared, so the spawn sits
      // well inside a flat, exactly-zero-elevation approach.
      terrain: Object.freeze({ startFlatLength: 30, startBlendLength: 6 }),
    }),
    baselineArmId: BASELINE_ARM_ID,
    controlArmId: CONTROL_ARM_ID,
    // Scheduling only. This seed never reaches an evolution run: it permutes
    // the ORDER arms execute in within a replicate, so a monotone drift in
    // machine state (thermal, cache, background load) cannot systematically
    // favour whichever arm always ran first.
    schedulingSeed: smoke ? 20260788 : 20260788,
    screen: Object.freeze({
      phase: 'screen',
      generations: smoke ? 2 : 30,
      arms: screenArms,
      replicates: smoke
        ? replicateList(seq(20260789, 2), seq(20260791, 2))
        : replicateList(seq(20260744, 6), seq(20260750, 6)),
      // Guardrails, declared before any number was measured. An arm that fails
      // any of these is INELIGIBLE regardless of how well it scores: a tuning
      // that wins by terminating early, by breaking vehicles, or by collapsing
      // the population is not a tuning worth having.
      eligibility: Object.freeze({
        // Absolute, not relative: more starved runs than baseline is a hard no.
        maxNoSelectableParentsTerminationsVsBaseline: 0,
        // Percentage POINTS below baseline's median final selectable rate.
        selectableRateFloorPointsBelowBaseline: 10,
        // Fraction of baseline's median final dispersion.
        dispersionFloorFractionOfBaseline: 0.70,
      }),
    }),
    confirm: Object.freeze({
      phase: 'confirm',
      generations: smoke ? 2 : 60,
      // The arm SET is derived after screening (candidate + baseline + control,
      // deduplicated). The seeds and gates are predeclared here.
      replicates: smoke
        ? replicateList(seq(20260793, 2), seq(20260795, 2))
        : replicateList(seq(20260756, 16), seq(20260772, 16)),
      gates: Object.freeze({
        // Paired wins, ties counting as non-wins, out of the replicate count.
        minPairedWins: smoke ? 2 : 12,
        // Percentage POINTS below baseline. One-sided DELIBERATELY: a candidate
        // that is MORE selectable than baseline is strictly better, and failing
        // it for that would be perverse. The same reading applies to
        // uniqueness. Dispersion is one-sided in the plan's own wording.
        selectableRateFloorPointsBelowBaseline: 5,
        uniquenessFloorPointsBelowBaseline: 10,
        dispersionFloorFractionOfBaseline: 0.80,
        maxNoSelectableParentsTerminationsVsBaseline: 0,
      }),
    }),
  };
  validateProtocol(protocol);
  return deepFreeze(protocol);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) deepFreeze(value[keys[i]]);
  if (Array.isArray(value)) for (let i = 0; i < value.length; i += 1) deepFreeze(value[i]);
  return Object.freeze(value);
}

/**
 * Structural invariants a protocol must satisfy. The load-bearing one is
 * SEED DISJOINTNESS: if a confirmation seed also appeared in screening, the
 * "held-out" claim is false and the whole two-phase design collapses into one
 * over-fitted phase. That is checked here rather than trusted to the literals
 * above, because the literals are exactly what a careless edit changes.
 */
export function validateProtocol(protocol) {
  const screenPop = protocol.screen.replicates.map((r) => r.populationSeed);
  const screenTer = protocol.screen.replicates.map((r) => r.terrainSeed);
  const confirmPop = protocol.confirm.replicates.map((r) => r.populationSeed);
  const confirmTer = protocol.confirm.replicates.map((r) => r.terrainSeed);
  const screenSeeds = new Set([...screenPop, ...screenTer]);
  const confirmSeeds = new Set([...confirmPop, ...confirmTer]);
  for (const seed of confirmSeeds) {
    if (screenSeeds.has(seed)) {
      fail(`seed ${seed} appears in BOTH the screening and confirmation sets — confirmation would not be held out`,
        { seed });
    }
  }
  if (screenSeeds.size !== screenPop.length + screenTer.length) {
    fail('the screening set reuses a seed between its population and terrain lists');
  }
  if (confirmSeeds.size !== confirmPop.length + confirmTer.length) {
    fail('the confirmation set reuses a seed between its population and terrain lists');
  }
  const ids = protocol.screen.arms.map((a) => a.armId);
  if (new Set(ids).size !== ids.length) fail('duplicate armId in the screening arm list');
  if (!ids.includes(protocol.baselineArmId)) fail(`the screening arms omit the baseline ${protocol.baselineArmId}`);
  if (!ids.includes(protocol.controlArmId)) fail(`the screening arms omit the control ${protocol.controlArmId}`);
  if (protocol.confirm.gates.minPairedWins > protocol.confirm.replicates.length) {
    fail('minPairedWins exceeds the confirmation replicate count — the gate could never pass');
  }
  return protocol;
}

/**
 * The execution order for one phase: every (replicate, arm) pair, with the ARM
 * order permuted per replicate by the scheduling stream.
 *
 * Replicates run in ascending index (they are the outer loop, so a partial run
 * is a prefix of complete replicates plus one in progress — the shape that
 * resumes most usefully). Arms are shuffled WITHIN a replicate so no arm holds a
 * fixed position in the machine's warm-up/thermal profile.
 */
export function buildExecutionSchedule(protocol, phaseName, arms) {
  const phase = phaseFor(protocol, phaseName);
  const out = [];
  for (const replicate of phase.replicates) {
    const order = arms.slice();
    const rng = new Rng(protocol.schedulingSeed).fork(replicate.replicateIndex);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = rng.int(0, i + 1);
      const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    for (const arm of order) {
      out.push(Object.freeze({
        runId: `${phaseName}:${arm.armId}:r${replicate.replicateIndex}`,
        phase: phaseName,
        armId: arm.armId,
        probability: arm.probability,
        magnitude: arm.magnitude,
        replicateIndex: replicate.replicateIndex,
        populationSeed: replicate.populationSeed,
        terrainSeed: replicate.terrainSeed,
        generations: phase.generations,
      }));
    }
  }
  const ids = out.map((r) => r.runId);
  if (new Set(ids).size !== ids.length) fail('the execution schedule contains duplicate runIds');
  return Object.freeze(out);
}

function phaseFor(protocol, phaseName) {
  if (phaseName === 'screen') return protocol.screen;
  if (phaseName === 'confirm') return protocol.confirm;
  return fail(`no schedule for phase '${String(phaseName)}'`);
}

// --- Metrics -----------------------------------------------------------------

const INTEGRITY_STATUS_KEYS = Object.freeze(['ok', 'nonFinite', 'numericalDivergence']);

/** Quartiles by the "nearest rank, linear interpolation" convention, on a sorted copy. */
function quartiles(sortedValues) {
  const n = sortedValues.length;
  if (n === 0) return null;
  const at = (q) => {
    const pos = q * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sortedValues[lo];
    return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
  };
  return Object.freeze({
    min: sortedValues[0], q1: at(0.25), median: at(0.5), q3: at(0.75), max: sortedValues[n - 1],
  });
}

/**
 * Median of a list that may contain nulls.
 *
 * NULL RANKS BELOW EVERY FINITE VALUE (CONTEXT.md). The full ascending order is
 * therefore `[null … null, smallest finite … largest finite]`, and the median
 * positions index THAT list. A null landing on a median position makes the
 * median null.
 *
 * THIS FUNCTION WAS WRONG IN THE FIRST COMMITTED DRAFT, AND THE WAY IT WAS WRONG
 * IS WORTH KEEPING ON THE RECORD. The draft sorted the finite values ascending
 * and then indexed the median positions straight into that array — which places
 * the nulls at the TAIL, i.e. treats a run that produced no selectable
 * individual as the LARGEST observation. Its docstring said "ranks below every
 * finite value, so nulls sort last"; the "so" is a non-sequitur, and the code
 * followed the clause rather than the rule. The effect was not cosmetic: it
 * biased every median UPWARD by exactly the runs that failed outright, so an arm
 * was rewarded for its failures. Measured on the real module,
 * `[null, null, 0.095, 0.140, 0.182, 3.418]` scored 1.800 against a steady
 * baseline's 1.011 and won screening — the median window had slid onto the one
 * lucky long run, which is precisely the domination `runScore` uses log1p to
 * prevent. The committed test locked the wrong value in under a title its own
 * assertion falsified ("nulls … do not shift a still-finite median", asserting a
 * value the null had in fact shifted). Found by adversarial review before any
 * decision rested on it.
 *
 * The sibling rule in `pairedComparison` ("null loses to any finite value") was
 * correct all along; these two are the same declared rule and must agree.
 */
export function medianOrNull(values) {
  const n = values.length;
  if (n === 0) return null;
  const finite = [];
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`median input must be a finite number or null (${String(v)})`);
    finite.push(v);
  }
  finite.sort((a, b) => a - b);
  // Positions index the FULL ascending list, whose first `nullCount` entries are
  // nulls. Subtracting the null count maps a position into `finite`; a negative
  // index means the position landed on a null.
  const nullCount = n - finite.length;
  const lo = Math.floor((n - 1) / 2) - nullCount;
  const hi = Math.ceil((n - 1) / 2) - nullCount;
  if (lo < 0 || hi < 0) return null;
  return lo === hi ? finite[lo] : (finite[lo] + finite[hi]) / 2;
}

/**
 * The pairwise gene-space distance between two decoded genotypes.
 *
 * The canonical field walk is a PREFIX-EXTENSION in the axle count: walk(A) is a
 * byte-for-byte prefix of walk(A+1), so a genotype with more axles has strictly
 * more paths and the "present on only one side" set is exactly the extra-axle
 * tail. That property is asserted in the committed tests rather than assumed —
 * it is what makes an index-aligned comparison correct.
 */
export function geneDistance(genotypeA, genotypeB) {
  const a = geneVector(genotypeA);
  const b = geneVector(genotypeB);
  const shared = Math.min(a.length, b.length);
  const union = Math.max(a.length, b.length);
  if (union === 0) fail('a genotype with no gene leaves cannot be compared');
  let sum = 0;
  for (let i = 0; i < shared; i += 1) sum += Math.abs(a[i] - b[i]);
  sum += union - shared; // each unmatched path contributes exactly 1
  return sum / union;
}

/** Every `[0, 1]` gene leaf, in canonical walk order. Continuous AND discrete. */
function geneVector(genotype) {
  const walk = genotypeFieldWalk(genotype.axles.length);
  const out = [];
  for (let i = 0; i < walk.length; i += 1) {
    if (walk[i].type !== 'f64') continue;
    out.push(readGenePath(genotype, walk[i].path));
  }
  return out;
}

/**
 * Read one gene by its canonical path. The walk emits paths as literal
 * expressions over the genotype shape, so this resolver handles exactly the two
 * forms the walk produces: dotted keys and `[n]` indices.
 */
function readGenePath(genotype, path) {
  let node = genotype;
  let i = 0;
  const n = path.length;
  let token = '';
  const step = (key) => {
    if (node === null || typeof node !== 'object') fail(`gene path '${path}' does not resolve`);
    node = node[key];
  };
  while (i < n) {
    const ch = path[i];
    if (ch === '.') { if (token !== '') { step(token); token = ''; } i += 1; continue; }
    if (ch === '[') {
      if (token !== '') { step(token); token = ''; }
      let j = i + 1;
      let digits = '';
      while (j < n && path[j] !== ']') { digits += path[j]; j += 1; }
      step(Number(digits));
      i = j + 1;
      continue;
    }
    token += ch;
    i += 1;
  }
  if (token !== '') step(token);
  if (typeof node !== 'number' || !Number.isFinite(node)) fail(`gene path '${path}' is not a finite gene (${String(node)})`);
  return node;
}

/** Mean pairwise gene distance over a generation, in ascending-id pair order. */
export function geneSpaceDispersion(individuals) {
  const n = individuals.length;
  if (n < 2) return null; // a single individual has no pairwise distance
  const ordered = individuals.slice().sort((a, b) => a.individualId - b.individualId);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      sum += geneDistance(ordered[i].genotype, ordered[j].genotype);
      pairs += 1;
    }
  }
  return sum / pairs;
}

function morphologyOf(genotype) {
  const ir = compileAssembly(genotype);
  let wheelCount = 0;
  const suspension = { S0: 0, S1: 0, S2: 0 };
  for (const axle of ir.axles) {
    wheelCount += axle.wheels.length;
    suspension[axle.suspension.type] += 1;
  }
  return {
    frameFamily: ir.chassis.family,
    axleCount: ir.axles.length,
    wheelCount,
    // See SYMMETRY_GENE_THRESHOLD: bound behaviourally to compileAssembly.
    symmetric: genotype.symmetric >= SYMMETRY_GENE_THRESHOLD,
    suspension,
    drivenWheelCount: ir.power.drivenWheelCount,
  };
}

function emptyHistogram(keys) {
  const out = {};
  for (const k of keys) out[k] = 0;
  return out;
}

function bump(hist, key) {
  const k = String(key);
  hist[k] = (hist[k] ?? 0) + 1;
}

/**
 * Fold one generation's decoded fitness rows into the selectable-fitness view.
 *
 * Extracted so its edge cases — an all-unselectable generation, an
 * integrity-failed row carrying fitness 0, a tie at the top — are testable
 * DIRECTLY, without fabricating a whole valid history artifact to reach them.
 * Rows arrive strictly id-ascending from `deserializeFitnessVector`, and the
 * strict `>` therefore keeps the LOWEST id on a tie: the same total order
 * `selectableChampionFromEvaluation` documents, restated over decoded rows.
 *
 * `champion` is `null` — never `0` and never a sentinel — when no individual is
 * selectable. That distinction is the whole reason CONTEXT.md defines a missing
 * champion as ranking below every finite result.
 */
export function summarizeFitnessRows(rows) {
  const n = rows.length; // captured once
  const integrityStatusCounts = emptyHistogram(INTEGRITY_STATUS_KEYS);
  const selectableFitness = [];
  let validCount = 0;
  let champion = null;
  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    bump(integrityStatusCounts, row.integrityStatus);
    if (row.valid) validCount += 1;
    if (!(row.valid && row.integrityStatus === 'ok')) continue;
    selectableFitness.push(row.fitness);
    if (champion === null || row.fitness > champion.fitness) {
      champion = { individualId: row.individualId, fitness: row.fitness };
    }
  }
  return {
    champion,
    validCount,
    selectableCount: selectableFitness.length,
    integrityStatusCounts,
    quartiles: quartiles(selectableFitness.slice().sort((a, b) => a - b)),
  };
}

/**
 * Normalize ONE persisted evolution history into the summary the experiment
 * reasons over. Pure: it decodes bytes through the public codecs and runs no
 * physics, so every committed metric test is fast and engine-free.
 *
 * The artifact itself is NOT retained by the caller — this summary is. That is
 * what keeps a 200-run experiment's evidence a few hundred kilobytes of JSON
 * instead of hundreds of megabytes of history.
 */
export function summarizeEvolutionHistory(historyBytes) {
  const framing = decodeHistoryFraming(historyBytes);
  const header = decodeEvolutionHeader(framing.headerBytes);
  const generations = [];
  let metadata = null;

  const generationCount = framing.generations.length; // captured once
  for (let gi = 0; gi < generationCount; gi += 1) {
    const entry = framing.generations[gi];
    const payload = decodeGenerationPayload(entry.payloadBytes);
    const population = deserializePopulationSnapshot(payload.components.population);
    const fitness = deserializeFitnessVector(payload.components.fitnessVector);
    const lineage = deserializeLineage(payload.components.lineage);
    const meta = deserializeEvaluationMetadata(payload.components.evaluationMetadata);
    if (metadata === null) metadata = meta;

    const fitnessSummary = summarizeFitnessRows(fitness.individuals);

    const members = population.individuals;
    const digests = [];
    const frameFamily = {};
    const axleCount = {};
    const wheelCount = {};
    const suspensionComposition = {};
    let symmetricCount = 0;
    for (let i = 0; i < members.length; i += 1) {
      digests.push(bytesToHex(serializeGenotype(members[i].genotype)));
      const m = morphologyOf(members[i].genotype);
      bump(frameFamily, m.frameFamily);
      bump(axleCount, m.axleCount);
      bump(wheelCount, m.wheelCount);
      bump(suspensionComposition, `S0:${m.suspension.S0}/S1:${m.suspension.S1}/S2:${m.suspension.S2}`);
      if (m.symmetric) symmetricCount += 1;
    }
    const uniqueGenotypeCount = new Set(digests).size;

    const originCounts = emptyHistogram(LINEAGE_ORIGINS);
    const accountingTotals = emptyHistogram(LINEAGE_ACCOUNTING_KEYS);
    const parents = new Set();
    for (const row of lineage.individuals) {
      bump(originCounts, row.origin);
      for (const key of LINEAGE_ACCOUNTING_KEYS) accountingTotals[key] += row.accounting[key];
      if (row.origin !== 'initialized') parents.add(row.parentIndividualId);
    }

    generations.push({
      generationIndex: payload.generationIndex,
      terminalReason: payload.terminalReason,
      payloadByteLength: entry.payloadBytes.length,
      populationSize: members.length,
      champion: fitnessSummary.champion,
      selectableFitness: fitnessSummary.quartiles,
      validCount: fitnessSummary.validCount,
      selectableCount: fitnessSummary.selectableCount,
      selectableRate: members.length === 0 ? null : fitnessSummary.selectableCount / members.length,
      integrityStatusCounts: fitnessSummary.integrityStatusCounts,
      uniqueGenotypeCount,
      uniquenessRatio: members.length === 0 ? null : uniqueGenotypeCount / members.length,
      geneSpaceDispersion: geneSpaceDispersion(members),
      morphology: {
        frameFamily, axleCount, wheelCount, suspensionComposition, symmetricCount,
      },
      lineage: {
        originCounts,
        uniqueParentCount: parents.size,
        accountingTotals,
      },
      populationDigest: bytesToHex(payload.componentDigests.population),
      fitnessVectorDigest: bytesToHex(payload.componentDigests.fitnessVector),
    });
  }

  if (generations.length === 0) fail('a history with no generation record cannot be summarized');
  const last = generations[generations.length - 1];
  return deepFreeze({
    historyByteLength: historyBytes.length,
    historyDigest: bytesToHex(framing.historyDigestBytes),
    headerDigest: bytesToHex(framing.headerDigestBytes),
    generationCount: generations.length,
    terminalReason: last.terminalReason,
    header: {
      populationSize: header.populationSize,
      maxGenerations: header.maxGenerations,
      mutationProbability: header.mutationProbability,
      mutationMagnitude: header.mutationMagnitude,
      physicsFlavor: header.physicsFlavor,
      packageName: header.packageName,
      rapierVersion: header.rapierVersion,
      evolutionEngineVersion: header.evolutionEngineVersion,
      evolutionPolicyVersion: header.evolutionPolicyVersion,
      tournamentSize: header.tournamentSize,
      eliteCount: header.eliteCount,
    },
    evaluation: {
      worldMode: metadata.worldMode,
      effectiveDt: metadata.effectiveDt,
      executedSteps: metadata.executedSteps,
    },
    generations,
  });
}

// --- Per-run score -----------------------------------------------------------

/**
 * The per-run comparison statistic: `log1p(final champion) − log1p(generation-0
 * champion)`.
 *
 * WHY log1p AND NOT A RATIO OR A RAW DELTA. Fitness is a forward distance whose
 * spread across arms is multiplicative rather than additive, and a raw delta
 * would let one lucky long run dominate a median. log1p is defined at 0 (a
 * generation-0 champion of exactly 0 m is ordinary), monotone, and turns a
 * multiplicative gain into an additive one so the paired difference between two
 * arms is a log-ratio.
 *
 * `null` when either endpoint has no selectable champion. Within a replicate
 * every arm shares generation 0 EXACTLY (same population seed, same evaluation
 * spec, mutation has not acted yet), so the generation-0 term cancels in any
 * paired difference — a property the report cross-checks rather than assumes.
 */
export function runScore(summary) {
  const first = summary.generations[0];
  const last = summary.generations[summary.generations.length - 1];
  if (first.champion === null || last.champion === null) return null;
  return Math.log1p(last.champion.fitness) - Math.log1p(first.champion.fitness);
}

/** The last generation's record — every "final" metric reads from here. */
export function finalGeneration(summary) {
  return summary.generations[summary.generations.length - 1];
}

// --- Screening ---------------------------------------------------------------

function groupByArm(runs) {
  const byArm = new Map();
  for (const run of runs) {
    if (!byArm.has(run.armId)) byArm.set(run.armId, []);
    byArm.get(run.armId).push(run);
  }
  // Replicate order inside an arm is normalized so every aggregate is
  // independent of the shuffled EXECUTION order.
  for (const list of byArm.values()) list.sort((a, b) => a.replicateIndex - b.replicateIndex);
  return byArm;
}

function armAggregate(runs) {
  const scores = runs.map((r) => runScore(r.summary));
  const finals = runs.map((r) => finalGeneration(r.summary));
  return {
    replicateCount: runs.length,
    medianScore: medianOrNull(scores),
    scores,
    medianFinalSelectableRate: medianOrNull(finals.map((f) => f.selectableRate)),
    medianFinalUniquenessRatio: medianOrNull(finals.map((f) => f.uniquenessRatio)),
    medianFinalDispersion: medianOrNull(finals.map((f) => f.geneSpaceDispersion)),
    aggregateSelectableRate: aggregateRate(finals),
    noSelectableParentsTerminations: runs.filter((r) => r.summary.terminalReason === 'noSelectableParents').length,
    finalChampions: finals.map((f) => (f.champion === null ? null : f.champion.fitness)),
  };
}

/** Selectable individuals over TOTAL individuals across the arm's final generations. */
function aggregateRate(finals) {
  let selectable = 0;
  let total = 0;
  for (const f of finals) { selectable += f.selectableCount; total += f.populationSize; }
  return total === 0 ? null : selectable / total;
}

/**
 * Screening: filter by the predeclared guardrails, then rank the survivors by
 * median score.
 *
 * The CONTROL is excluded from candidacy by rule, not by score — a zero-mutation
 * default would make the parametric operator inert, so it could not be adopted
 * however well it performed. It is still aggregated and reported, because it is
 * the reference that says how much of any gain came from selection alone.
 */
export function screenCandidates(protocol, runs) {
  const rules = protocol.screen.eligibility;
  const byArm = groupByArm(runs);
  const baselineRuns = byArm.get(protocol.baselineArmId);
  if (baselineRuns === undefined) fail(`screening results contain no baseline arm '${protocol.baselineArmId}'`);
  const baseline = armAggregate(baselineRuns);

  const arms = [];
  for (const [armId, armRuns] of byArm) {
    const agg = armAggregate(armRuns);
    const reasons = [];
    if (agg.noSelectableParentsTerminations
      > baseline.noSelectableParentsTerminations + rules.maxNoSelectableParentsTerminationsVsBaseline) {
      reasons.push('noSelectableParentsTerminations');
    }
    if (!withinFloorPoints(agg.medianFinalSelectableRate, baseline.medianFinalSelectableRate,
      rules.selectableRateFloorPointsBelowBaseline)) {
      reasons.push('selectableRate');
    }
    if (!withinFloorFraction(agg.medianFinalDispersion, baseline.medianFinalDispersion,
      rules.dispersionFloorFractionOfBaseline)) {
      reasons.push('dispersion');
    }
    arms.push({
      armId,
      probability: armRuns[0].probability,
      magnitude: armRuns[0].magnitude,
      eligible: reasons.length === 0,
      ineligibleReasons: reasons,
      isControl: armId === protocol.controlArmId,
      isBaseline: armId === protocol.baselineArmId,
      ...agg,
    });
  }
  arms.sort((a, b) => compareArmId(a.armId, b.armId));

  const ranked = arms
    .filter((a) => a.eligible && !a.isControl && a.medianScore !== null)
    .slice()
    .sort(rankArms);

  const candidateArmId = ranked.length > 0 ? ranked[0].armId : protocol.baselineArmId;
  return deepFreeze({
    baselineArmId: protocol.baselineArmId,
    controlArmId: protocol.controlArmId,
    arms,
    ranking: ranked.map((a) => a.armId),
    candidateArmId,
    candidateIsBaseline: candidateArmId === protocol.baselineArmId,
  });
}

/** Declared tie-break: higher median score, then LOWER probability, then LOWER magnitude, then armId. */
function rankArms(a, b) {
  if (a.medianScore !== b.medianScore) return b.medianScore - a.medianScore;
  if (a.probability !== b.probability) return a.probability - b.probability;
  if (a.magnitude !== b.magnitude) return a.magnitude - b.magnitude;
  return compareArmId(a.armId, b.armId);
}

function compareArmId(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

/** `value` is not more than `points` percentage POINTS below `reference`. */
function withinFloorPoints(value, reference, points) {
  if (reference === null) return value !== null;
  if (value === null) return false;
  return value >= reference - points / 100;
}

/** `value` is at least `fraction` of `reference`. */
function withinFloorFraction(value, reference, fraction) {
  if (reference === null) return value !== null;
  if (value === null) return false;
  return value >= reference * fraction;
}

// --- Confirmation ------------------------------------------------------------

/**
 * The paired comparison of two arms over the same replicates.
 *
 * A WIN is strictly greater final selectable champion fitness. Ties count as
 * NON-wins by declaration — a tie is not evidence of superiority, and with an
 * exactly-shared generation 0 the control arm ties baseline on any replicate
 * where neither improves.
 */
export function pairedComparison(armRuns, referenceRuns) {
  const byReplicate = new Map();
  for (const r of referenceRuns) byReplicate.set(r.replicateIndex, r);
  const pairs = [];
  for (const run of armRuns.slice().sort((a, b) => a.replicateIndex - b.replicateIndex)) {
    const ref = byReplicate.get(run.replicateIndex);
    if (ref === undefined) fail(`replicate ${run.replicateIndex} has no reference run to pair with`);
    const armChampion = finalGeneration(run.summary).champion;
    const refChampion = finalGeneration(ref.summary).champion;
    const armFitness = armChampion === null ? null : armChampion.fitness;
    const refFitness = refChampion === null ? null : refChampion.fitness;
    const armScore = runScore(run.summary);
    const refScore = runScore(ref.summary);
    pairs.push({
      replicateIndex: run.replicateIndex,
      armFitness,
      referenceFitness: refFitness,
      // null loses to any finite value; null vs null is a tie, hence a non-win.
      win: armFitness !== null && (refFitness === null || armFitness > refFitness),
      scoreDifference: (armScore === null || refScore === null) ? null : armScore - refScore,
    });
  }
  return {
    replicateCount: pairs.length,
    wins: pairs.filter((p) => p.win).length,
    medianScoreDifference: medianOrNull(pairs.map((p) => p.scoreDifference)),
    pairs,
  };
}

/**
 * The confirmation decision. Every threshold comes from the protocol; nothing
 * here is chosen after the numbers were seen.
 */
export function confirmDecision(protocol, runs, candidateArmId) {
  const gates = protocol.confirm.gates;
  const byArm = groupByArm(runs);
  const need = [protocol.baselineArmId, protocol.controlArmId];
  for (const armId of need) {
    if (!byArm.has(armId)) fail(`confirmation results contain no '${armId}' arm`);
  }
  const baselineRuns = byArm.get(protocol.baselineArmId);
  const controlRuns = byArm.get(protocol.controlArmId);
  const baseline = armAggregate(baselineRuns);

  // Baseline-vs-control always runs: it is what distinguishes "the defaults are
  // validated" from "we simply could not tell".
  const baselineVsControl = pairedComparison(baselineRuns, controlRuns);
  const baselineBeatsControl = baselineVsControl.wins >= gates.minPairedWins
    && baselineVsControl.medianScoreDifference !== null
    && baselineVsControl.medianScoreDifference > 0;

  const candidateIsBaseline = candidateArmId === protocol.baselineArmId;
  let candidate = null;
  if (!candidateIsBaseline) {
    if (candidateArmId === protocol.controlArmId) {
      fail('the control arm can never be the candidate — a zero-mutation default would make the operator inert');
    }
    const candidateRuns = byArm.get(candidateArmId);
    if (candidateRuns === undefined) fail(`confirmation results contain no candidate arm '${candidateArmId}'`);
    const agg = armAggregate(candidateRuns);
    const comparison = pairedComparison(candidateRuns, baselineRuns);
    const checks = [
      { name: 'pairedWins', pass: comparison.wins >= gates.minPairedWins, value: comparison.wins, threshold: gates.minPairedWins },
      {
        name: 'medianScoreDifference',
        pass: comparison.medianScoreDifference !== null && comparison.medianScoreDifference > 0,
        value: comparison.medianScoreDifference,
        threshold: 0,
      },
      {
        name: 'noSelectableParentsTerminations',
        pass: agg.noSelectableParentsTerminations
          <= baseline.noSelectableParentsTerminations + gates.maxNoSelectableParentsTerminationsVsBaseline,
        value: agg.noSelectableParentsTerminations,
        threshold: baseline.noSelectableParentsTerminations + gates.maxNoSelectableParentsTerminationsVsBaseline,
      },
      {
        name: 'aggregateSelectableRate',
        pass: withinFloorPoints(agg.aggregateSelectableRate, baseline.aggregateSelectableRate,
          gates.selectableRateFloorPointsBelowBaseline),
        value: agg.aggregateSelectableRate,
        threshold: baseline.aggregateSelectableRate === null
          ? null : baseline.aggregateSelectableRate - gates.selectableRateFloorPointsBelowBaseline / 100,
      },
      {
        name: 'medianFinalUniqueness',
        pass: withinFloorPoints(agg.medianFinalUniquenessRatio, baseline.medianFinalUniquenessRatio,
          gates.uniquenessFloorPointsBelowBaseline),
        value: agg.medianFinalUniquenessRatio,
        threshold: baseline.medianFinalUniquenessRatio === null
          ? null : baseline.medianFinalUniquenessRatio - gates.uniquenessFloorPointsBelowBaseline / 100,
      },
      {
        name: 'medianFinalDispersion',
        pass: withinFloorFraction(agg.medianFinalDispersion, baseline.medianFinalDispersion,
          gates.dispersionFloorFractionOfBaseline),
        value: agg.medianFinalDispersion,
        threshold: baseline.medianFinalDispersion === null
          ? null : baseline.medianFinalDispersion * gates.dispersionFloorFractionOfBaseline,
      },
    ];
    candidate = {
      armId: candidateArmId,
      probability: candidateRuns[0].probability,
      magnitude: candidateRuns[0].magnitude,
      aggregate: agg,
      comparison,
      checks,
      passes: checks.every((c) => c.pass),
    };
  }

  let decision;
  if (candidate !== null && candidate.passes) decision = 'retune';
  else if (baselineBeatsControl) decision = 'retainValidated';
  else decision = 'retainInconclusive';

  return deepFreeze({
    candidateArmId,
    candidateIsBaseline,
    candidate,
    baseline: { armId: protocol.baselineArmId, aggregate: baseline },
    baselineVsControl: { comparison: baselineVsControl, passes: baselineBeatsControl },
    decision,
    // The resolved defaults this experiment authorizes. `retune` is the ONLY
    // decision that changes them.
    resolvedDefaults: decision === 'retune'
      ? { probability: candidate.probability, magnitude: candidate.magnitude }
      : { probability: BASELINE_ARM.probability, magnitude: BASELINE_ARM.magnitude },
  });
}

// --- Workspace ---------------------------------------------------------------

const MANIFEST_FILE = 'manifest.json';
const RUNS_DIR = 'runs';

function runFileName(runId) {
  // runIds contain ':' which Windows forbids in a filename. The mapping is
  // injective (':' is the only replaced character and '-' cannot appear in a
  // phase name or a replicate index; armIds use '-' but never ':').
  return `${runId.replace(/:/g, '__')}.json`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    fail(`could not read '${file}' as JSON — the workspace record is corrupt`, { file, cause: String(cause) });
    return null;
  }
}

/** Write atomically: a killed process leaves either the old file or the new one. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${canonicalJson(value)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * The source identity OF THIS MODULE'S REPOSITORY. Missing git is reported,
 * never guessed.
 *
 * The `cwd` is not optional and is not `process.cwd()`. Without it, git resolves
 * against whatever directory the process happened to be launched from, so
 * running the experiment from inside some other clean repository would report
 * `clean: true` for a repository that is not the one whose code is executing —
 * and `clean` is the hard gate that decides whether a phase may produce citable
 * evidence. Anchoring on `import.meta.url` binds the answer to the file actually
 * running. Found by adversarial review.
 */
export function readSourceIdentity() {
  const here = dirname(fileURLToPath(import.meta.url));
  const run = (args) => execFileSync('git', args, {
    cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    const commit = run(['rev-parse', 'HEAD']);
    const status = run(['status', '--porcelain']);
    return { commit, clean: status === '', available: true };
  } catch {
    return { commit: null, clean: false, available: false };
  }
}

/**
 * Open (or create) a workspace bound to `protocol`.
 *
 * IDENTITY IS THE POINT. The manifest stores the protocol's digest, and a
 * workspace whose digest disagrees with the protocol being executed is REFUSED
 * rather than migrated: half a sweep run under one design and half under another
 * is not evidence, it is an average of two experiments.
 */
export async function openWorkspace(workspace, protocol, options = {}) {
  const allowDirty = options.allowDirty === true;
  mkdirSync(join(workspace, RUNS_DIR), { recursive: true });
  const manifestFile = join(workspace, MANIFEST_FILE);
  const protocolDigest = await canonicalDigest(protocol);
  const source = readSourceIdentity();

  if (existsSync(manifestFile)) {
    const manifest = readJson(manifestFile);
    if (manifest.protocolDigest !== protocolDigest) {
      fail(`workspace '${workspace}' was created under a DIFFERENT protocol `
        + `(${String(manifest.protocolDigest)} != ${protocolDigest}) — use a fresh workspace`,
        { workspace, expected: protocolDigest, found: manifest.protocolDigest });
    }
    if (manifest.protocolVersion !== protocol.protocolVersion) {
      fail(`workspace protocolVersion ${String(manifest.protocolVersion)} != ${protocol.protocolVersion}`);
    }
    return { manifestFile, manifest, protocolDigest, source, allowDirty };
  }
  const manifest = {
    schema: EXPERIMENT_SCHEMA,
    protocolVersion: protocol.protocolVersion,
    protocolDigest,
    protocol,
    createdSource: source,
    candidateArmId: null,
  };
  writeJsonAtomic(manifestFile, manifest);
  return { manifestFile, manifest, protocolDigest, source, allowDirty };
}

/**
 * Load every completed run record, validating each against the protocol digest.
 *
 * A record that does not parse, whose runId disagrees with its filename, or
 * whose protocol digest differs is a REFUSAL, not a skip: silently ignoring a
 * corrupt record would re-run it and quietly change what the evidence covers.
 */
export function loadRunRecords(workspace, protocolDigest) {
  const dir = join(workspace, RUNS_DIR);
  const records = new Map();
  if (!existsSync(dir)) return records;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const file of files) {
    const full = join(dir, file);
    const record = readJson(full);
    if (record.schema !== EXPERIMENT_RUN_SCHEMA) {
      fail(`'${full}' is not a ${EXPERIMENT_RUN_SCHEMA} record`, { file: full });
    }
    if (record.protocolDigest !== protocolDigest) {
      fail(`'${full}' was produced under a different protocol digest`, { file: full });
    }
    if (runFileName(record.runId) !== file) {
      fail(`'${full}' carries runId '${String(record.runId)}', which does not match its filename`, { file: full });
    }
    if (records.has(record.runId)) {
      fail(`duplicate record for runId '${record.runId}'`, { runId: record.runId });
    }
    records.set(record.runId, record);
  }
  return records;
}

// --- Execution ---------------------------------------------------------------

/** Build one run's `createEvolutionRun` config from the protocol and the plan row. */
export function runConfigFor(protocol, plan) {
  const w = protocol.workload;
  return {
    initialization: { seed: plan.populationSeed, populationSize: w.populationSize },
    evaluationSpec: {
      terrain: { seed: plan.terrainSeed, ...w.terrain },
      maxSteps: w.maxSteps,
      deterministic: w.deterministic,
      spawn: { ...w.spawn },
    },
    evolution: {
      maxGenerations: plan.generations,
      mutation: { probability: plan.probability, magnitude: plan.magnitude },
    },
  };
}

/**
 * Execute ONE run to termination and normalize it.
 *
 * ANALYZER OVERHEAD IS KEPT OUT OF THE TIMING. `historyBytes()` returns a fresh
 * copy every call and appending is O(G^2) copy work, so calling it per
 * generation would both distort the per-advance timings and add a second
 * quadratic path. It is called ONCE, after termination.
 */
export async function executeRun(protocol, plan) {
  const startedAt = performance.now();
  const run = createEvolutionRun(runConfigFor(protocol, plan));
  const advanceMs = [];
  let result;
  do {
    const t = performance.now();
    result = await run.advance();
    advanceMs.push(performance.now() - t);
  } while (result.kind !== 'terminal');
  const evolveMs = performance.now() - startedAt;
  const bytes = run.historyBytes();
  const t1 = performance.now();
  const summary = summarizeEvolutionHistory(bytes);
  const summarizeMs = performance.now() - t1;
  if (summary.header.mutationProbability !== plan.probability
    || summary.header.mutationMagnitude !== plan.magnitude) {
    fail(`run '${plan.runId}' persisted mutation parameters that differ from its plan`, { runId: plan.runId });
  }
  return {
    summary,
    performance: {
      evolveMs, summarizeMs,
      advanceMsTotal: advanceMs.reduce((s, v) => s + v, 0),
      advanceMsMax: advanceMs.length === 0 ? null : Math.max(...advanceMs),
      advanceMsMean: advanceMs.length === 0 ? null : advanceMs.reduce((s, v) => s + v, 0) / advanceMs.length,
      generationCount: advanceMs.length,
    },
  };
}

/**
 * Run (or resume) one phase.
 *
 * Resumption skips EXACT run ids that already have a valid record and nothing
 * else. There is no partial-run state: a run that did not finish is executed
 * again from the start, which is sound because a run is deterministic in its
 * seeds and its parameters.
 */
export async function executeExperimentPhase({
  phase, workspace, protocol, log = () => {}, allowDirty = false,
}) {
  if (phase !== 'screen' && phase !== 'confirm') {
    fail(`executeExperimentPhase does not execute phase '${String(phase)}'`);
  }
  const phaseName = phase;
  const ws = await openWorkspace(workspace, protocol, { allowDirty });

  if (protocol.citable && CITABLE_PHASES.includes(phaseName) && !allowDirty) {
    if (!ws.source.available) {
      fail('git is unavailable, so the source identity of a citable run cannot be recorded');
    }
    if (!ws.source.clean) {
      fail('the working tree is dirty — a citable phase must run from a clean commit '
        + '(pass allowDirty to run anyway; the evidence is then marked non-citable)');
    }
  }

  let arms;
  if (phaseName === 'screen') {
    arms = protocol.screen.arms;
  } else {
    const screenRecords = [...loadRunRecords(workspace, ws.protocolDigest).values()]
      .filter((r) => r.phase === 'screen');
    const expected = buildExecutionSchedule(protocol, 'screen', protocol.screen.arms).length;
    if (screenRecords.length !== expected) {
      fail(`confirmation needs all ${expected} screening runs; the workspace has ${screenRecords.length}`);
    }
    const screening = screenCandidates(protocol, screenRecords);
    const candidateArmId = screening.candidateArmId;
    if (ws.manifest.candidateArmId !== null && ws.manifest.candidateArmId !== candidateArmId) {
      fail(`the manifest pinned candidate '${String(ws.manifest.candidateArmId)}' but screening now selects `
        + `'${candidateArmId}' — the screening records changed under a resumed confirmation`);
    }
    if (ws.manifest.candidateArmId === null) {
      ws.manifest.candidateArmId = candidateArmId;
      writeJsonAtomic(ws.manifestFile, ws.manifest);
    }
    const wanted = [candidateArmId, protocol.baselineArmId, protocol.controlArmId];
    const seen = new Set();
    arms = [];
    for (const armId of wanted) {
      if (seen.has(armId)) continue; // dedup when screening selected the baseline
      seen.add(armId);
      const source = protocol.screen.arms.find((a) => a.armId === armId);
      if (source === undefined) fail(`confirmation arm '${armId}' is not a declared screening arm`);
      arms.push(source);
    }
    log(`confirmation arms: ${arms.map((a) => a.armId).join(', ')}`);
  }

  const schedule = buildExecutionSchedule(protocol, phaseName, arms);
  const existing = loadRunRecords(workspace, ws.protocolDigest);
  const todo = schedule.filter((plan) => !existing.has(plan.runId));
  log(`${phaseName}: ${schedule.length} runs planned, ${schedule.length - todo.length} already complete, ${todo.length} to execute`);

  let executed = 0;
  for (const plan of todo) {
    const t = performance.now();
    const { summary, performance: perf } = await executeRun(protocol, plan);
    const record = {
      schema: EXPERIMENT_RUN_SCHEMA,
      runId: plan.runId,
      phase: plan.phase,
      armId: plan.armId,
      probability: plan.probability,
      magnitude: plan.magnitude,
      replicateIndex: plan.replicateIndex,
      populationSeed: plan.populationSeed,
      terrainSeed: plan.terrainSeed,
      plannedGenerations: plan.generations,
      protocolDigest: ws.protocolDigest,
      // OBSERVATIONS. Excluded from the evidence digest and from every gate.
      source: ws.source,
      citable: protocol.citable && ws.source.available && ws.source.clean,
      performance: perf,
      summary,
    };
    writeJsonAtomic(join(workspace, RUNS_DIR, runFileName(plan.runId)), record);
    executed += 1;
    const champ = finalGeneration(summary).champion;
    log(`  [${executed}/${todo.length}] ${plan.runId} — ${((performance.now() - t) / 1000).toFixed(1)}s, `
      + `final champion ${champ === null ? 'null' : champ.fitness.toFixed(2)}, ${summary.terminalReason}`);
  }
  return { phase: phaseName, planned: schedule.length, executed, skipped: schedule.length - todo.length };
}

// --- Forensics ---------------------------------------------------------------

/**
 * Re-run one declared case and re-evaluate its lowest, median and highest
 * selectable champion through the production runner.
 *
 * Every number this returns is an OBSERVATION of the physics, exactly like the
 * explosion and integrity probes: no threshold here gates anything, and no
 * committed test asserts a magnitude. The `plausible` flag compares against the
 * DERIVED ceiling and is reported so the ceiling's own false-negative rate is
 * visible rather than assumed.
 */
/**
 * The PURE half of a forensic case: which replicate, which seeds, how many
 * generations. Separated from the physics so the phase ROUTING is testable
 * without a 30-generation run — the first version hard-coded `phase: 'screen'`
 * here, and no test could see it because every test that touched forensics read
 * a committed artifact rather than exercising this code.
 */
export function forensicCasePlan(protocol, replicate, arm, phaseName = 'screen') {
  const phase = phaseFor(protocol, phaseName);
  return {
    runId: `forensics:${phaseName}:${arm.armId}:r${replicate.replicateIndex}`,
    phase: phaseName,
    armId: arm.armId,
    probability: arm.probability,
    magnitude: arm.magnitude,
    replicateIndex: replicate.replicateIndex,
    populationSeed: replicate.populationSeed,
    terrainSeed: replicate.terrainSeed,
    generations: phase.generations,
  };
}

/**
 * Run one forensic case from an ALREADY-RESOLVED plan.
 *
 * It deliberately takes no phase argument. When it took one, the routing existed
 * in two places — here and in `forensicSamplePlans` — and a sabotage pass could
 * hard-code `'screen'` at the call site while the tested resolver stayed
 * correct. One source of routing, so there is nothing to disagree with.
 */
export async function runForensicCase(protocol, plan) {
  const run = createEvolutionRun(runConfigFor(protocol, plan));
  let result;
  do { result = await run.advance(); } while (result.kind !== 'terminal');
  const framing = decodeHistoryFraming(run.historyBytes());

  const champions = [];
  for (let gi = 0; gi < framing.generations.length; gi += 1) {
    const payload = decodeGenerationPayload(framing.generations[gi].payloadBytes);
    const vector = deserializeFitnessVector(payload.components.fitnessVector);
    const snapshot = deserializePopulationSnapshot(payload.components.population);
    const best = summarizeFitnessRows(vector.individuals).champion;
    if (best === null) continue;
    const members = snapshot.individuals;
    let genotype = null;
    for (let i = 0; i < members.length; i += 1) {
      if (members[i].individualId === best.individualId) { genotype = members[i].genotype; break; }
    }
    if (genotype === null) fail(`champion ${best.individualId} is absent from its own population snapshot`);
    champions.push({ generationIndex: payload.generationIndex, fitness: best.fitness, genotype });
  }
  if (champions.length === 0) return [];
  champions.sort((a, b) => a.fitness - b.fitness);
  const picks = [
    { label: 'lowest', champion: champions[0] },
    { label: 'median', champion: champions[Math.floor(champions.length / 2)] },
    { label: 'highest', champion: champions[champions.length - 1] },
  ];

  const ceiling = fitnessPlausibilityCeiling(protocol).conservativeCeiling;
  const rows = [];
  for (const pick of picks) {
    const ir = compileAssembly(pick.champion.genotype);
    const evaluation = await runEvaluation({
      deterministic: protocol.workload.deterministic,
      terrain: { seed: plan.terrainSeed, ...protocol.workload.terrain },
      vehicles: [{ ir, spawn: spawnPoseOnFlatStart(ir, { ...protocol.workload.spawn }) }],
      maxSteps: protocol.workload.maxSteps,
      termination: 'maxSteps',
      trace: { mode: 'none' },
    });
    const vehicle = evaluation.vehicles[0];
    const observations = vehicle.integrity.observations;
    rows.push({
      phase: plan.phase,
      armId: plan.armId,
      replicateIndex: plan.replicateIndex,
      populationSeed: plan.populationSeed,
      terrainSeed: plan.terrainSeed,
      pick: pick.label,
      generationIndex: pick.champion.generationIndex,
      fitness: pick.champion.fitness,
      reevaluatedMaxForwardDistance: vehicle.maxForwardDistance,
      finalX: vehicle.finalPose.translation.x,
      integrityStatus: vehicle.integrity.status,
      peakBodySpeed: observations.peakBodySpeed,
      firstAlertStep: observations.firstAlertStep,
      firstCatastrophicStep: observations.firstCatastrophicStep,
      plausible: pick.champion.fitness <= ceiling,
    });
  }
  return rows;
}

/** Run every declared forensic case and summarize what the sample shows. */
/**
 * Resolve every declared forensic case to its (replicate, arm, phase) triple.
 *
 * PURE, and separated from the physics for one reason: the phase routing lives
 * HERE, and when it was inline in the runner a sabotage pass could replace
 * `entry.phase` with a hard-coded `'screen'` and every test stayed green,
 * because the only tests that touched forensics read a committed artifact.
 */
export function forensicSamplePlans(protocol) {
  const plans = [];
  for (const entry of FORENSIC_SAMPLE) {
    const phase = phaseFor(protocol, entry.phase);
    const replicate = phase.replicates[entry.replicateIndex];
    const arm = protocol.screen.arms.find((a) => a.armId === entry.armId);
    if (replicate === undefined || arm === undefined) {
      fail(`forensic case ${entry.phase}:${entry.armId}:r${entry.replicateIndex} is not in the protocol`);
    }
    plans.push({ entry, replicate, arm, plan: forensicCasePlan(protocol, replicate, arm, entry.phase) });
  }
  return plans;
}

/** The PURE forensic report: provenance, ceiling and the derived summary. */
export function buildForensicReport({ protocolDigest, ceiling, rows }) {
  const ordered = rows.slice().sort((a, b) => a.fitness - b.fitness);
  const over = ordered.filter((r) => !r.plausible);
  const under = ordered.filter((r) => r.plausible);
  return {
    schema: 'boxcar3d.evolution-experiment-forensics/1',
    // PROVENANCE. Without these the artifact was checked only for internal
    // consistency, so a stale file from an earlier sample or protocol stayed
    // green.
    protocolDigest,
    declaredSample: FORENSIC_SAMPLE,
    ceiling,
    rows: ordered,
    summary: {
      sampled: ordered.length,
      // DISTINCT individuals, not rows: the lowest/median/highest picks of one
      // run can be the same elite, and the first report turned a row count into
      // a claim about that many sampled champions.
      distinctOverCeilingIndividuals: new Set(over.map((r) => `${r.armId}:r${r.replicateIndex}:${r.generationIndex}:${r.fitness}`)).size,
      overCeiling: over.length,
      // NOTE: this field CANNOT come back false while the ceiling exceeds
      // alertSpeed x runSeconds, so it is entailed by arithmetic rather than
      // measured. Kept because its absence would be conspicuous, and documented
      // so nobody cites it as evidence.
      overCeilingAllAlertBand: over.length > 0 && over.every((r) => r.firstAlertStep !== null),
      overCeilingAnyCatastrophic: over.some((r) => r.firstCatastrophicStep !== null),
      // THE FALSE-NEGATIVE RATE OF THE CEILING — the number that turns the
      // prevalence figures into a LOWER BOUND rather than an estimate.
      underCeilingAlertBand: under.filter((r) => r.firstAlertStep !== null).length,
      underCeiling: under.length,
    },
  };
}

export async function runForensicSample(protocol, log = () => {}) {
  const protocolDigest = await canonicalDigest(protocol);
  const rows = [];
  for (const { plan } of forensicSamplePlans(protocol)) {
    log(`  ${plan.phase} ${plan.armId} r${plan.replicateIndex} …`);
    rows.push(...await runForensicCase(protocol, plan));
  }
  return buildForensicReport({
    protocolDigest,
    ceiling: fitnessPlausibilityCeiling(protocol).conservativeCeiling,
    rows,
  });
}

/**
 * The maintainer's disposition of the gate verdict, declared in code so it
 * travels with the artifact instead of living only in prose.
 *
 * `gateVerdictAdopted: false` is not a bug and not an oversight: the gate ranks
 * on selectable fitness, and this campaign measured that the signal it ranks on
 * is contaminated by constraint-solver divergence which policy v2 reports as
 * `ok`. The gate could not see that and was never asked to. Changing the gate
 * after seeing its answer would be the reverse-fitting the protocol exists to
 * prevent; recording that its premise failed is not.
 */
export const ADOPTION_RULING = Object.freeze({
  gateVerdictAdopted: false,
  adoptedDefaults: Object.freeze({ probability: 0.05, magnitude: 0.05 }),
  reasonCode: 'fitnessSignalContaminated',
  reason: 'The selectable-fitness signal is contaminated by integrity alert-band '
    + 'constraint-solver divergence that fitness policy v2 classifies as selectable. '
    + 'The candidate is additionally on the grid boundary, and its identity is not '
    + 'robust to the contamination in screening. Retune deferred, not refuted.',
  prerequisite: 'Resolve the alert band (see the escalation-cost arm), then re-run this protocol.',
});

// --- Escalation cost ---------------------------------------------------------

/**
 * What would ALERT-AS-FAILURE actually remove?
 *
 * PR-B left the integrity alert band as an observation and named escalation a
 * policy-v2 trigger. This campaign supplies the evidence that the trigger is
 * met — but "escalate" is only a responsible recommendation if the COST of
 * escalating has been measured, and the first draft of the report recommended it
 * without measuring anything.
 *
 * This arm evaluates every GENERATION-0 population in the protocol — unmutated,
 * so what it measures is a property of the initializer and the realization, not
 * of any arm — and records the integrity OBSERVATIONS the production fold
 * already computes but the fitness vector does not persist. From those it
 * derives exactly one number that matters: how many individuals would newly
 * become unselectable, and what their peak speeds are.
 *
 * IT CHANGES NO POLICY. Escalation itself is a production change (an
 * `INTEGRITY_POLICY_VERSION` / `FITNESS_POLICY_VERSION` bump and a deliberate
 * re-lock) and belongs to the PR that owns that seam. This measures; it does not
 * decide. It also measures only the FALSE-POSITIVE side (healthy vehicles
 * wrongly removed); PR-B's acceptance test also requires the false-negative side
 * (divergence that still passes), which is out of scope here and stated as such.
 */
export async function runEscalationCost(protocol, log = () => {}) {
  const replicates = [
    ...protocol.screen.replicates.map((r) => ({ phase: 'screen', ...r })),
    ...protocol.confirm.replicates.map((r) => ({ phase: 'confirm', ...r })),
  ];
  const rows = [];
  for (const replicate of replicates) {
    log(`  ${replicate.phase} population ${replicate.populationSeed} …`);
    const { population } = createInitialPopulation({
      seed: replicate.populationSeed,
      populationSize: protocol.workload.populationSize,
    });
    const terrain = { seed: replicate.terrainSeed, ...protocol.workload.terrain };
    const members = population.individuals;
    for (let i = 0; i < members.length; i += 1) {
      const ir = compileAssembly(members[i].genotype);
      const evaluation = await runEvaluation({
        deterministic: protocol.workload.deterministic,
        terrain,
        vehicles: [{ ir, spawn: spawnPoseOnFlatStart(ir, { ...protocol.workload.spawn }) }],
        maxSteps: protocol.workload.maxSteps,
        termination: 'maxSteps',
        trace: { mode: 'none' },
      });
      const vehicle = evaluation.vehicles[0];
      const o = vehicle.integrity.observations;
      rows.push({
        phase: replicate.phase,
        populationSeed: replicate.populationSeed,
        terrainSeed: replicate.terrainSeed,
        individualId: members[i].individualId,
        maxForwardDistance: vehicle.maxForwardDistance,
        integrityStatus: vehicle.integrity.status,
        peakBodySpeed: o.peakBodySpeed,
        firstAlertStep: o.firstAlertStep,
        firstCatastrophicStep: o.firstCatastrophicStep,
      });
    }
  }

  return summarizeEscalationRows(rows);
}

/**
 * The PURE accounting behind the escalation-cost arm. Separated from the physics
 * so every count is testable on synthetic rows — the first version computed
 * these inline, and the only test read a committed artifact, so a miscount in
 * this arithmetic could not be caught.
 *
 * `newlyUnselectable` is deliberately NOT "everything alert-band": an individual
 * that policy v2 already refuses is not a NEW cost of escalating.
 */
export function summarizeEscalationRows(rows) {
  const total = rows.length;
  const currentlyUnselectable = rows.filter((r) => r.integrityStatus !== 'ok');
  const alertBand = rows.filter((r) => r.firstAlertStep !== null);
  const newlyUnselectable = rows.filter((r) => r.integrityStatus === 'ok' && r.firstAlertStep !== null);
  const peaks = newlyUnselectable.map((r) => r.peakBodySpeed).sort((a, b) => a - b);

  // Would the generation-0 CHAMPION change? That is what sets selection pressure.
  const byPopulation = new Map();
  for (const r of rows) {
    const key = `${r.phase}:${r.populationSeed}`;
    if (!byPopulation.has(key)) byPopulation.set(key, []);
    byPopulation.get(key).push(r);
  }
  let championChanges = 0;
  for (const [, members] of byPopulation) {
    const best = (xs) => {
      let top = null;
      for (const x of xs) if (top === null || x.maxForwardDistance > top.maxForwardDistance) top = x;
      return top;
    };
    const now = best(members.filter((r) => r.integrityStatus === 'ok'));
    const after = best(members.filter((r) => r.integrityStatus === 'ok' && r.firstAlertStep === null));
    if (now === null || after === null || now.individualId !== after.individualId) championChanges += 1;
  }

  return {
    schema: 'boxcar3d.evolution-experiment-escalation-cost/1',
    scope: 'generation-0 populations only (unmutated); FALSE-POSITIVE side only',
    individuals: total,
    populations: byPopulation.size,
    currentlyUnselectable: currentlyUnselectable.length,
    alertBand: alertBand.length,
    newlyUnselectable: newlyUnselectable.length,
    newlyUnselectablePeakSpeed: peaks.length === 0 ? null : quartiles(peaks),
    newlyUnselectableBelow50: peaks.filter((p) => p < 50).length,
    generationZeroChampionChanges: championChanges,
    rows,
  };
}

// --- Report ------------------------------------------------------------------

/**
 * Build the committed evidence document from a completed workspace.
 *
 * EVERY CONCLUSION IS RECOMPUTED HERE FROM THE RUN SUMMARIES. Nothing is carried
 * forward from execution, so the committed JSON can be re-derived from its own
 * raw rows — which is exactly what the committed test does, and what makes the
 * report mechanically checkable rather than a claim about a run nobody can see.
 */
export async function buildExperimentReport({ workspace, protocol = undefined }) {
  const manifestFile = join(workspace, MANIFEST_FILE);
  if (!existsSync(manifestFile)) fail(`no manifest in workspace '${workspace}'`);
  const manifest = readJson(manifestFile);
  const activeProtocol = protocol ?? manifest.protocol;
  validateProtocol(activeProtocol);
  const protocolDigest = await canonicalDigest(activeProtocol);
  if (protocolDigest !== manifest.protocolDigest) {
    fail('the workspace manifest protocol does not re-digest to its recorded value');
  }
  const records = [...loadRunRecords(workspace, protocolDigest).values()]
    .sort((a, b) => compareArmId(a.runId, b.runId));

  const screenRuns = records.filter((r) => r.phase === 'screen');
  const confirmRuns = records.filter((r) => r.phase === 'confirm');
  const screenExpected = buildExecutionSchedule(activeProtocol, 'screen', activeProtocol.screen.arms).length;
  if (screenRuns.length !== screenExpected) {
    fail(`the report needs all ${screenExpected} screening runs; found ${screenRuns.length}`);
  }
  const screening = screenCandidates(activeProtocol, screenRuns);

  let confirmation = null;
  if (confirmRuns.length > 0) {
    const armCount = new Set(confirmRuns.map((r) => r.armId)).size;
    const expected = armCount * activeProtocol.confirm.replicates.length;
    if (confirmRuns.length !== expected) {
      fail(`confirmation is incomplete: ${confirmRuns.length} runs for ${armCount} arms `
        + `over ${activeProtocol.confirm.replicates.length} replicates (expected ${expected})`);
    }
    confirmation = confirmDecision(activeProtocol, confirmRuns, screening.candidateArmId);
  }

  const coherence = pairingCoherence(records);
  const citable = activeProtocol.citable
    && records.length > 0
    && records.every((r) => r.citable === true)
    && new Set(records.map((r) => r.source.commit)).size === 1
    && confirmation !== null
    && coherence.every((c) => c.pass);

  // The DETERMINISTIC SUBSET: everything a re-run on another machine must
  // reproduce byte-for-byte. Timing, machine identity, execution order and the
  // source commit are deliberately outside it — the first three are properties
  // of the machine and the last would make the digest change when this very
  // document is committed.
  const evidence = evidenceSubset({
    protocol: activeProtocol,
    protocolDigest,
    runs: records.map(projectRunForEvidence),
    screening,
    confirmation,
  });
  const evidenceDigest = await canonicalDigest(evidence);

  return {
    schema: EXPERIMENT_SCHEMA,
    protocolVersion: activeProtocol.protocolVersion,
    evidenceDigest,
    citable,
    decision: confirmation === null ? null : confirmation.decision,
    resolvedDefaults: confirmation === null ? null : confirmation.resolvedDefaults,
    // WHAT THE MAINTAINER ACTUALLY DID WITH THE GATE'S VERDICT.
    //
    // The first draft shipped a digest-signed, citable artifact whose `decision`
    // field read `retune` while every prose handoff said the retune was
    // declined. A tool or a reader taking the machine-readable file at face
    // value would have adopted parameters the PR deliberately refused. The gate
    // verdict above is untouched — this records the disposition beside it, and
    // sits OUTSIDE the evidence digest because it is a human ruling, not a
    // measurement.
    adoption: ADOPTION_RULING,
    ...evidence,
    coherence,
    // OBSERVATIONS ONLY — never an input to any gate above.
    observations: {
      source: manifest.createdSource,
      runSources: [...new Set(records.map((r) => r.source.commit))],
      performance: performanceObservations(records),
      // Raw per-run timing, OUTSIDE the digest, so the envelope figures quoted
      // in the report are re-derivable from the committed artifact.
      perRunTiming: records.map((r) => ({
        runId: r.runId,
        generationCount: r.summary.generationCount,
        evolveMs: r.performance.evolveMs,
        summarizeMs: r.performance.summarizeMs,
      })),
      historyGrowth: historyGrowthObservations(records),
      fitnessPlausibility: fitnessPlausibilityObservations(activeProtocol, records),
    },
  };
}

/**
 * The pairing cross-check: within one phase and one replicate, every arm must
 * report the SAME generation-0 population digest and the same generation-0
 * champion.
 *
 * Generation 0 is drawn before mutation acts, so this is an identity, not a
 * tendency. If it ever fails, the arms were not paired and every paired
 * statistic in the report is meaningless — which is why it is a hard check
 * rather than a footnote.
 */
export function pairingCoherence(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.phase}:r${r.replicateIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, group] of [...groups.entries()].sort((a, b) => compareArmId(a[0], b[0]))) {
    const digests = new Set(group.map((r) => r.summary.generations[0].populationDigest));
    const champions = new Set(group.map((r) => {
      const c = r.summary.generations[0].champion;
      return c === null ? 'null' : `${c.individualId}:${c.fitness}`;
    }));
    out.push({
      group: key,
      armCount: group.length,
      pass: digests.size === 1 && champions.size === 1,
      generation0PopulationDigests: [...digests].sort(),
      generation0Champions: [...champions].sort(),
    });
  }
  return out;
}

/**
 * The DETERMINISTIC SUBSET the evidence digest is computed over.
 *
 * Exactly these five keys, in one place, so the digest's scope is a definition
 * rather than a field list repeated at every call site. Everything a re-run on
 * another machine must reproduce byte-for-byte is inside; timing, machine
 * identity, execution order and the source commit are outside — the first three
 * are properties of the machine, and the last would make the digest change when
 * this very document is committed.
 *
 * A caller that adds a key gets a loud failure rather than a silently different
 * digest, and `tests/evolution-experiment.test.js` pins the key set against a
 * copy-declared literal so a scope change cannot pass unnoticed.
 */
export const EVIDENCE_DIGEST_KEYS = Object.freeze([
  'protocol', 'protocolDigest', 'runs', 'screening', 'confirmation',
]);

export function evidenceSubset(source) {
  const keys = Object.keys(source).slice().sort();
  const expected = EVIDENCE_DIGEST_KEYS.slice().sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    fail(`the evidence subset must carry exactly [${expected}] (got [${keys}])`);
  }
  const out = {};
  for (const key of EVIDENCE_DIGEST_KEYS) out[key] = source[key];
  return out;
}

/**
 * The per-generation fields the committed evidence keeps for EVERY generation.
 *
 * WHY THE EVIDENCE IS PROJECTED AT ALL. The workspace record holds the full
 * summary — per-generation morphology histograms, lineage accounting, integrity
 * counts and fitness quartiles. Across 204 runs and ~7,500 generations that is
 * 17 MB of JSON, which is not a reviewable artifact. The projection keeps every
 * field any consumer READS: the decision layer reads only the first and last
 * generation (via `runScore` and `finalGeneration`), and the plausibility
 * observation reads every generation's champion.
 *
 * THE RULE THE PROJECTION MUST SATISFY: every figure quoted in the committed
 * report must be recomputable from the committed evidence alone. So the first
 * and last generation are kept in FULL (they carry the morphology, lineage and
 * integrity detail the report discusses), and every generation in between keeps
 * the five quantities the trajectory and the observations are built from.
 * Nothing is rounded — the gates compare exact f64 medians.
 */
const TRAJECTORY_FIELDS = Object.freeze([
  'generationIndex', 'champion', 'selectableCount', 'uniqueGenotypeCount', 'geneSpaceDispersion',
]);

function projectRunForEvidence(record) {
  const gens = record.summary.generations;
  const lastIndex = gens.length - 1;
  const generations = [];
  for (let i = 0; i < gens.length; i += 1) {
    if (i === 0 || i === lastIndex) { generations.push(gens[i]); continue; }
    const compact = {};
    for (const key of TRAJECTORY_FIELDS) compact[key] = gens[i][key];
    generations.push(compact);
  }
  return {
    runId: record.runId,
    phase: record.phase,
    armId: record.armId,
    probability: record.probability,
    magnitude: record.magnitude,
    replicateIndex: record.replicateIndex,
    populationSeed: record.populationSeed,
    terrainSeed: record.terrainSeed,
    plannedGenerations: record.plannedGenerations,
    // PROVENANCE SURVIVES THE PROJECTION. The report claims "every run from the
    // single clean commit X" and marks the artifact citable; the first draft
    // dropped both fields here, so that claim rested on data the committed
    // artifact no longer carried and no test could re-derive it.
    sourceCommit: record.source.commit,
    sourceClean: record.source.clean,
    citable: record.citable,
    // TIMING IS DELIBERATELY ABSENT HERE. It belongs to the machine, not to the
    // experiment, and `runs` is inside the evidence digest — putting per-run
    // milliseconds here made a resumed campaign produce a different digest from
    // an uninterrupted one, which the resume test caught immediately. Per-run
    // timing lives in `observations.perRunTiming`, outside the digest.
    summary: {
      historyByteLength: record.summary.historyByteLength,
      historyDigest: record.summary.historyDigest,
      headerDigest: record.summary.headerDigest,
      generationCount: record.summary.generationCount,
      terminalReason: record.summary.terminalReason,
      header: record.summary.header,
      evaluation: record.summary.evaluation,
      generations,
    },
  };
}

/**
 * Two bounds on the forward distance a vehicle could reach by LOCOMOTION.
 *
 * THE FIRST DRAFT OF THIS FUNCTION WAS ANALYTICALLY WRONG, AND THE ERROR IS
 * INSTRUCTIVE. It returned `corridorForwardDistance + noLoadSpeed × runSeconds`
 * (104 + 25 = 129 m) and described it as the distance a vehicle "could reach".
 * That adds a SPATIAL EXTENT to a TIME-INTEGRAL. Displacement in T seconds is
 * bounded by v_max × T and by nothing else; the corridor's length constrains
 * WHERE a vehicle can be, not HOW FAR it can travel. At 5 m/s the corridor's own
 * 104 m would take 20.8 s, four times the whole run — so the two terms cannot
 * both be realized and their sum bounds nothing. The consequence was a ceiling
 * ~5× too generous, which is exactly why the report then discovered
 * "false negatives" and reported them as a surprise.
 *
 * So this returns both, named for what they are:
 *   kinematicCeiling    = noLoadSurfaceSpeed × runSeconds — the real bound.
 *   conservativeCeiling = corridorForwardDistance + kinematicCeiling — an
 *                         unarguable envelope, retained ONLY because a count
 *                         taken against it is a strict LOWER bound on
 *                         contamination and the first report quoted it.
 *
 * BOTH ARE HEURISTICS AND OBSERVATIONS, NEVER GATES. Terrain slopes can push a
 * vehicle past its no-load speed, so a champion moderately over the kinematic
 * ceiling is not proof of anything; what carries the finding is the integrity
 * OBSERVATION (peak body speed), measured by `--phase forensics`. No threshold
 * here feeds any eligibility rule, any confirmation gate, or the decision —
 * adding one after seeing results is the reverse-fitting this protocol exists to
 * avoid.
 *
 * The terrain length comes from the RESOLVED workload when it declares one, not
 * unconditionally from `TERRAIN_DEFAULTS`: a protocol that overrode
 * `terrain.length` would otherwise have its ceiling silently computed from 120 m.
 */
export function fitnessPlausibilityCeiling(protocol, dt = 1 / 60) {
  const w = protocol.workload;
  const terrainLength = w.terrain.length === undefined ? TERRAIN_DEFAULTS.length : w.terrain.length;
  const corridorEnd = terrainLength / 2 - w.spawn.x;
  const runSeconds = w.maxSteps * dt;
  const kinematic = MOTOR_TARGET_WHEEL_SURFACE_SPEED * runSeconds;
  return {
    terrainLength,
    spawnX: w.spawn.x,
    corridorForwardDistance: corridorEnd,
    noLoadSurfaceSpeed: MOTOR_TARGET_WHEEL_SURFACE_SPEED,
    runSeconds,
    // THE bound: displacement in T seconds cannot exceed v_max x T.
    kinematicCeiling: kinematic,
    // A deliberately unarguable envelope, kept only so a count taken against it
    // is a strict lower bound. It is NOT a displacement bound (see above).
    conservativeCeiling: corridorEnd + kinematic,
  };
}

/**
 * Contamination counts, broken down so the report's CAUSAL claims are backed by
 * data rather than by prose.
 *
 * THE FIRST DRAFT AGGREGATED BY PHASE ONLY, and that is precisely how a false
 * claim shipped: the report asserted "the (0,0) control produced zero
 * over-ceiling champions in any replicate" and concluded that mutation, not the
 * initial draw, discovers divergence. Both were wrong — the confirmation control
 * has 60 over-ceiling generations, and the individual responsible is present at
 * GENERATION 0, before any operator has acted. Neither fact could redden
 * anything, because nothing counted per arm or at generation 0.
 *
 * So the breakdown now carries `perArm` (the control is an arm like any other)
 * and `generationZero` (pre-treatment, shared by every arm at a replicate by the
 * pairing identity). A claim about what mutation does is now checkable against
 * the artifact that is supposed to support it.
 *
 * Counts are reported two ways because they answer different questions:
 *   championGenerations   — generation-SLOTS whose champion is over the ceiling.
 *                           Elitism re-counts one surviving individual every
 *                           generation, so this is an exposure measure.
 *   distinctChampionIds   — DISTINCT individual ids, which is what "one champion
 *                           in five" would have to mean to be a prevalence.
 */
export function fitnessPlausibilityObservations(protocol, records) {
  if (records.length === 0) return null;
  const basis = fitnessPlausibilityCeiling(protocol);

  const blank = () => ({
    runs: 0,
    generations: 0,
    championGenerationsOverKinematic: 0,
    championGenerationsOverConservative: 0,
    finalChampionsOverConservative: 0,
    distinctChampionsOverConservative: 0,
    maxChampion: 0,
    contaminatedReplicates: [],
  });
  const phases = {};
  const perArm = {};
  const generationZero = {};
  const distinctIds = new Map();

  for (const record of records) {
    const buckets = [];
    if (phases[record.phase] === undefined) phases[record.phase] = blank();
    buckets.push(phases[record.phase]);
    const armKey = `${record.phase}:${record.armId}`;
    if (perArm[armKey] === undefined) perArm[armKey] = blank();
    buckets.push(perArm[armKey]);
    for (const b of buckets) {
      b.runs += 1;
      if (distinctIds.get(b) === undefined) distinctIds.set(b, new Set());
    }

    const gens = record.summary.generations;
    for (let i = 0; i < gens.length; i += 1) {
      const champion = gens[i].champion;
      const value = champion === null ? 0 : champion.fitness;
      for (const b of buckets) {
        b.generations += 1;
        if (value > b.maxChampion) b.maxChampion = value;
        if (value > basis.kinematicCeiling) b.championGenerationsOverKinematic += 1;
        if (value > basis.conservativeCeiling) {
          b.championGenerationsOverConservative += 1;
          if (!b.contaminatedReplicates.includes(record.replicateIndex)) {
            b.contaminatedReplicates.push(record.replicateIndex);
          }
          if (champion !== null) distinctIds.get(b).add(`r${record.replicateIndex}:${champion.fitness}`);
        }
      }
    }
    const last = gens[gens.length - 1].champion;
    if (last !== null && last.fitness > basis.conservativeCeiling) {
      for (const b of buckets) b.finalChampionsOverConservative += 1;
    }

    // Generation 0 is PRE-TREATMENT: drawn before mutation acts, and identical
    // across every arm at a replicate. Recorded once per (phase, replicate).
    const zeroKey = `${record.phase}:r${record.replicateIndex}`;
    const zero = gens[0].champion;
    if (generationZero[zeroKey] === undefined) {
      generationZero[zeroKey] = {
        championFitness: zero === null ? null : zero.fitness,
        overKinematic: zero !== null && zero.fitness > basis.kinematicCeiling,
        overConservative: zero !== null && zero.fitness > basis.conservativeCeiling,
      };
    }
  }

  for (const bucket of [...Object.values(phases), ...Object.values(perArm)]) {
    bucket.contaminatedReplicates.sort((a, b) => a - b);
    bucket.distinctChampionsOverConservative = distinctIds.get(bucket).size;
  }
  return { basis, phases, perArm, generationZero };
}

function performanceObservations(records) {
  if (records.length === 0) return null;
  const evolve = records.map((r) => r.performance.evolveMs).sort((a, b) => a - b);
  const perGeneration = records
    .map((r) => r.performance.advanceMsMean)
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  // SPLIT BY GENERATION COUNT. A pooled median over 30- and 60-generation runs
  // is a number describing neither, and quoting it as "the 30-generation median"
  // was a confirmed defect in the first report.
  const byGenerations = {};
  for (const record of records) {
    const key = String(record.summary.generationCount);
    if (byGenerations[key] === undefined) byGenerations[key] = { evolveMs: [], summarizeMs: [] };
    byGenerations[key].evolveMs.push(record.performance.evolveMs);
    byGenerations[key].summarizeMs.push(record.performance.summarizeMs);
  }
  for (const key of Object.keys(byGenerations)) {
    const b = byGenerations[key];
    byGenerations[key] = {
      runCount: b.evolveMs.length,
      evolveMs: quartiles(b.evolveMs.slice().sort((a, c) => a - c)),
      summarizeMs: quartiles(b.summarizeMs.slice().sort((a, c) => a - c)),
    };
  }
  return {
    runCount: records.length,
    totalEvolveMs: evolve.reduce((s, v) => s + v, 0),
    evolveMs: quartiles(evolve),
    meanMsPerGeneration: quartiles(perGeneration),
    summarizeMsTotal: records.reduce((s, r) => s + r.performance.summarizeMs, 0),
    byGenerationCount: byGenerations,
  };
}

function historyGrowthObservations(records) {
  if (records.length === 0) return null;
  const byGenerations = new Map();
  for (const r of records) {
    const key = r.summary.generationCount;
    if (!byGenerations.has(key)) byGenerations.set(key, []);
    byGenerations.get(key).push(r.summary.historyByteLength);
  }
  return [...byGenerations.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([generationCount, sizes]) => ({
      generationCount,
      runCount: sizes.length,
      historyBytes: quartiles(sizes.slice().sort((a, b) => a - b)),
      bytesPerGeneration: quartiles(sizes.slice().sort((a, b) => a - b).map((s) => s / generationCount)),
    }));
}

// --- CLI ---------------------------------------------------------------------

export function configFromArgs(argv) {
  const config = {
    phase: 'smoke', workspace: null, out: null, allowDirty: false, json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--allow-dirty') { config.allowDirty = true; continue; }
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--phase' || arg === '--workspace' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`experiment-evolution: ${arg} needs a value`);
      }
      if (arg === '--phase') {
        if (!EXPERIMENT_PHASES.includes(value)) {
          throw new Error(`experiment-evolution: unknown --phase '${value}' (phases: ${EXPERIMENT_PHASES.join(', ')})`);
        }
        config.phase = value;
      } else if (arg === '--workspace') config.workspace = value;
      else config.out = value;
      i += 1;
      continue;
    }
    throw new Error(`experiment-evolution: unknown argument '${arg}'`);
  }
  return config;
}

const DEFAULT_WORKSPACE = 'experiment-workspace';
const SMOKE_WORKSPACE = 'experiment-workspace-smoke';

/**
 * Clear a SMOKE workspace, and refuse to clear anything else.
 *
 * The smoke phase wants a fresh directory every time, and the first draft simply
 * `rmSync(workspace, { recursive: true, force: true })`-ed whatever `--workspace`
 * named. Since `configFromArgs` DEFAULTS the phase to `smoke`, that made
 * `--workspace experiment-workspace` — with no `--phase` at all — a recursive
 * delete of the real, possibly hours-old citable evidence, before any
 * protocol-identity check could fire. Found by adversarial review.
 *
 * The rule now: an existing directory is cleared only if it is demonstrably a
 * smoke workspace, i.e. its manifest declares `protocol.kind === 'smoke'`. A
 * directory that does not exist is fine (nothing to lose). Anything else —
 * a full-protocol workspace, or a directory with no readable manifest — is
 * REFUSED, because a delete that cannot prove what it is deleting is not a
 * delete anyone should run twice.
 */
export function resetSmokeWorkspace(workspace) {
  if (!existsSync(workspace)) return;
  const manifestFile = join(workspace, MANIFEST_FILE);
  if (!existsSync(manifestFile)) {
    fail(`refusing to clear '${workspace}': it exists but holds no ${MANIFEST_FILE}, `
      + 'so it cannot be shown to be a smoke workspace', { workspace });
  }
  const manifest = readJson(manifestFile);
  const kind = manifest === null || manifest.protocol === undefined || manifest.protocol === null
    ? undefined : manifest.protocol.kind;
  if (kind !== 'smoke') {
    fail(`refusing to clear '${workspace}': its manifest declares protocol kind `
      + `'${String(kind)}', not 'smoke' — pass a different --workspace`, { workspace, kind: String(kind) });
  }
  rmSync(workspace, { recursive: true, force: true });
}

async function main() {
  const config = configFromArgs(process.argv.slice(2));
  const log = (line) => console.log(line);

  if (config.phase === 'smoke') {
    const protocol = buildExperimentProtocol('smoke');
    const workspace = config.workspace ?? SMOKE_WORKSPACE;
    resetSmokeWorkspace(workspace);
    log(`smoke: fresh workspace '${workspace}'`);
    await executeExperimentPhase({ phase: 'screen', workspace, protocol, log, allowDirty: true });
    await executeExperimentPhase({ phase: 'confirm', workspace, protocol, log, allowDirty: true });
    const report = await buildExperimentReport({ workspace, protocol });
    log(`smoke: decision ${report.decision}, candidate ${report.screening.candidateArmId}, `
      + `evidence ${report.evidenceDigest.slice(0, 16)}…, citable ${report.citable}`);
    if (report.citable !== false) {
      throw new Error('experiment-evolution: the smoke protocol must never produce citable evidence');
    }
    log('smoke: OK');
    return;
  }

  const protocol = buildExperimentProtocol('full');
  const workspace = config.workspace ?? DEFAULT_WORKSPACE;
  if (config.phase === 'forensics') {
    log('forensics: re-running declared cases and re-evaluating their champions');
    const report = await runForensicSample(protocol, log);
    log('');
    log(' fitness(m)  peak(m/s)  firstAlert  firstCat  status  finalX   pick     arm/replicate');
    for (const r of report.rows) {
      log(`${r.fitness.toFixed(1).padStart(11)}${r.peakBodySpeed.toFixed(1).padStart(11)}`
        + `${String(r.firstAlertStep).padStart(12)}${String(r.firstCatastrophicStep).padStart(10)}`
        + `${r.integrityStatus.padStart(8)}${r.finalX.toFixed(0).padStart(9)}  ${r.pick.padEnd(8)} `
        + `${r.armId}/r${r.replicateIndex}`);
    }
    const s = report.summary;
    log('');
    log(`ceiling ${report.ceiling} m — over: ${s.overCeiling}/${s.sampled}`
      + ` (all alert-band: ${s.overCeilingAllAlertBand}, any catastrophic: ${s.overCeilingAnyCatastrophic})`);
    log(`under the ceiling: ${s.underCeilingAlertBand}/${s.underCeiling} were ALSO alert-band`
      + ' — the ceiling under-counts, so prevalence is a LOWER BOUND');
    if (config.out !== null) {
      writeFileSync(config.out, `${canonicalJson(report)}\n`, 'utf8');
      log(`written: ${config.out}`);
    }
    return;
  }
  if (config.phase === 'escalation-cost') {
    log('escalation-cost: evaluating every generation-0 population (unmutated)');
    const out = await runEscalationCost(protocol, log);
    const pct = (k) => `${((100 * k) / out.individuals).toFixed(1)}%`;
    log('');
    log(`generation-0 individuals evaluated: ${out.individuals} (${out.populations} populations, UNMUTATED)`);
    log(`  currently unselectable (policy v2): ${out.currentlyUnselectable}  ${pct(out.currentlyUnselectable)}`);
    log(`  alert-band at any point:            ${out.alertBand}  ${pct(out.alertBand)}`);
    log(`  WOULD NEWLY become unselectable:    ${out.newlyUnselectable}  ${pct(out.newlyUnselectable)}`);
    if (out.newlyUnselectablePeakSpeed !== null) {
      const q = out.newlyUnselectablePeakSpeed;
      log(`  their peak body speed (m/s): min ${q.min.toFixed(1)} median ${q.median.toFixed(1)} max ${q.max.toFixed(1)}`);
      log(`  of those, peaking below 50 m/s (near the 25 m/s alert line): ${out.newlyUnselectableBelow50}`);
    }
    log(`  generation-0 champion changes: ${out.generationZeroChampionChanges}/${out.populations} populations`);
    if (config.out !== null) {
      writeFileSync(config.out, `${canonicalJson(out)}
`, 'utf8');
      log(`written: ${config.out}`);
    }
    return;
  }
  if (config.phase === 'report') {
    const report = await buildExperimentReport({ workspace, protocol });
    const out = config.out ?? join(workspace, 'evidence.json');
    // CANONICAL, not pretty-printed. Three reasons: the committed artifact is
    // then byte-stable across rebuilds (a real git diff, not a whitespace
    // reflow), it is the same spelling the evidence digest is computed over, and
    // `JSON.stringify(_, null, 2)` tripled the file for indentation alone. Use
    // `jq` to read it.
    writeFileSync(out, `${canonicalJson(report)}\n`, 'utf8');
    log(`report: ${out}`);
    log(`  decision        ${report.decision}`);
    log(`  candidate       ${report.screening.candidateArmId}`);
    log(`  resolved        ${JSON.stringify(report.resolvedDefaults)}`);
    log(`  evidence digest ${report.evidenceDigest}`);
    log(`  citable         ${report.citable}`);
    if (config.json) console.log(JSON.stringify(report, null, 2));
    return;
  }
  const summary = await executeExperimentPhase({
    phase: config.phase, workspace, protocol, log, allowDirty: config.allowDirty,
  });
  log(`${summary.phase}: ${summary.executed} executed, ${summary.skipped} skipped, ${summary.planned} planned`);
}

/**
 * Whether `argv1` names THIS file being run as a script.
 *
 * A named, exported predicate rather than an inline `endsWith`, because the
 * inline form was an untested string comparison that silently governed whether
 * the CLI did anything at all — and the test file claimed to pin its behaviour
 * while asserting nothing about it. The basename must MATCH, not merely be a
 * suffix: `.../experiment-evolution.js.snap` ends with neither.
 */
export function shouldRunAsScript(argv1) {
  if (typeof argv1 !== 'string' || argv1 === '') return false;
  const base = argv1.slice(Math.max(argv1.lastIndexOf('/'), argv1.lastIndexOf('\\')) + 1);
  return base === 'experiment-evolution.js';
}

// Only when invoked as a script — importing this module (the committed tests do)
// must never start an experiment.
if (shouldRunAsScript(process.argv[1])) {
  await main();
}
