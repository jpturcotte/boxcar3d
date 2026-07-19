// The LIVE initial-population policy: populationSeed -> canonical generation-0
// population. Deliberately SEPARATE from assembly.js's randomGenotype (the
// locked test-corpus generator, corpus fingerprint 24cd0dd5): this module owns
// the biases the corpus must not have — symmetry defaults ON (spec §3.1.2),
// suspension categories masked to the realizable set (the Phase-1A S2 rule:
// the MASK, not landing S2, satisfies S2-before-GA), at least one axle, and
// at least one DRIVE-ENABLED wheel BY CONSTRUCTION (no rejection loop) — its
// driveTorque is > 0 whenever the power gene is > 0, which holds for every
// draw except the 2^-32 exact-zero-power corner (a legal zero-torque
// phenotype; see the DRIVEN-WHEEL GUARANTEE below). "Drive-enabled" is the
// precise invariant; "genuinely driven" (nonzero torque) holds for all but
// that corner.
//
// Stream architecture (ruling D7): one child stream per stable individualId —
//   new Rng(populationSeed).fork(individualId)
// fork reads only the ORIGINAL seed + streamId, so individual N never depends
// on how many draws any other individual consumed, on population size, or on
// evaluation order. Generation-0 individualIds are 0..populationSize-1 (the
// fork streamIds). A later generation (Phase 1B) must allocate fresh,
// non-overlapping stream ids before drawing any randomness of its own.
//
// DRAW TABLE v1 (POPULATION_INITIALIZER_VERSION bumps on ANY change to this
// order or any mapping; 36 + 17*axleCount draws, fixed given axleCount):
//   1  hue                nextFloat()
//   2  symmetric          bool(symmetricProbability), then nextFloat() -> the
//                         gene lands DIVERSE inside the chosen half-band:
//                         on ? 0.5 + v*0.5 : v*0.5 (boolGene threshold 0.5)
//   3  power              range(minInitialPowerGene, 1)
//   4  frameDensity       nextFloat()
//   5  frame.family       nextFloat()          (all three families reachable)
//   6  nodeCount          nextFloat()
//   7  6 node slots x {gap, height, halfWidth, thickness}   24 x nextFloat()
//   8  fam spine/ladder/hull                                 3 x nextFloat()
//   9  axleCount          int(minAxles, maxAxles + 1)        (>= 1 by config)
//  10  drivenAxleIndex    int(0, axleCount)   (drawn BEFORE the axle loop so
//                                              every axle's draw shape is
//                                              uniform)
//  11  per axle, AXLE_GENES then ASYM_GENES order:
//        posX01, paired, trackHalf, radius, width, density    6 x nextFloat()
//        suspType — CATEGORICAL, never scalar jitter:
//          catIndex = int(0, initialSuspensionTypes.length)
//          v        = nextFloat()
//          gene     = (SUSPENSION_TYPES.indexOf(category) + v) / 3
//          enumIdx(gene, 3) = floor(catIndex + v) = catIndex EXACTLY for
//          v in [0,1), so a masked category (S2) is unreachable by
//          construction while the within-band value stays heritable.
//        stiffness, damping, travel, restLength               4 x nextFloat()
//        driven — the forced axle (drivenAxleIndex) maps its draw into
//          [0.5, 1) via 0.5 + v*0.5; every other axle keeps the uniform draw
//          (one draw either way — the count stays uniform).
//        share                                                1 x nextFloat()
//        asym driveBias, sizeBias, centerOffset               3 x nextFloat()
//
// DRIVEN-WHEEL GUARANTEE (case analysis, relied on by tests): the forced axle
// decodes driven=true, so drivenWheels is non-empty; buildIR splits the power
// budget P with an equal-split fallback when every driven shareFrac is 0, so
// some driven wheel gets driveTorque > 0 whenever P > 0; and the repair pass
// never writes driven/share/power/suspType/symmetric while R1 cannot truncate
// (config caps maxAxles at ASSEMBLY_DEFAULTS.maxAxles). Documented corner: a
// power draw of EXACTLY 0 (probability 2^-32 per individual, only reachable
// when minInitialPowerGene is 0) emits a legal zero-torque phenotype that
// scores ~0 — recorded, not engineered away.
//
// minInitialPowerGene defaults to 0: the full gene range. A nonzero
// initialization prior only ever lands deliberately, from measurement, with
// an initializer-version bump — never because it "sounds reasonable".
//
// INITIALIZATION MANIFEST ENCODING v1 (explicit little-endian walk; binds
// PROVENANCE — how the content was produced — and closes over the content by
// snapshot digest state; the fitness vector never binds this manifest):
//   u16 initializerVersion
//   u16 genotypeVersion
//   u32 seed
//   u32 populationSize
//   u8  minAxles
//   u8  maxAxles
//   f64 symmetricProbability
//   f64 minInitialPowerGene
//   u8  categoryCount
//   u8[categoryCount] SUSPENSION_TYPES indices, config order
//   u32 populationSnapshotDigestState   (raw uint32 FNV state over the
//                                        snapshot encoding)

import { Rng } from './prng.js';
import {
  ASSEMBLY_DEFAULTS, GENOTYPE_VERSION, NODE_SLOTS, SUSPENSION_TYPES,
  compileAssembly, serializeGenotype,
} from './assembly.js';
import { POPULATION_SNAPSHOT_VERSION, bytesEqual, serializePopulationSnapshot } from './population.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from './fnv1a.js';
import { createByteReader } from './bytes.js';

export const POPULATION_INITIALIZER_VERSION = 1;

// Categories the INITIAL population may draw — initializer POLICY, distinct
// from the evaluator's REALIZABLE_SUSPENSION_TYPES (engine capability). They
// coincide today; the policy list is what a config may narrow.
const INITIAL_SUSPENSION_MASK = Object.freeze(['S0', 'S1']);

export const INITIAL_POPULATION_DEFAULTS = Object.freeze({
  populationSize: 20, // the SALVAGE tuned legacy default
  minAxles: 1, // >= 1: generation 0 is a locomotion population, not sleds
  maxAxles: ASSEMBLY_DEFAULTS.maxAxles,
  symmetricProbability: 0.8, // spec §3.1.2: bilateral symmetry defaults on
  initialSuspensionTypes: INITIAL_SUSPENSION_MASK,
  minInitialPowerGene: 0,
});

function fail(path, value) {
  throw new Error(`population-initializer: invalid config at ${path} (${String(value)})`);
}

const CONFIG_KEYS = Object.freeze(['seed', ...Object.keys(INITIAL_POPULATION_DEFAULTS)]);

function isProbability(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

// Policy-field resolution shared by the sampler (which ignores seed and
// populationSize) and the full config resolution below. Unknown keys reject
// against the FULL key set so a resolved config round-trips.
function resolvePolicy(config) {
  if (typeof config !== 'object' || config === null) fail('config', config);
  for (const k of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(k)) fail(k, 'unknown key');
  }
  const cfg = { ...INITIAL_POPULATION_DEFAULTS, ...config };
  if (!Number.isInteger(cfg.minAxles) || cfg.minAxles < 1) fail('minAxles', cfg.minAxles);
  if (!Number.isInteger(cfg.maxAxles) || cfg.maxAxles < cfg.minAxles
    || cfg.maxAxles > ASSEMBLY_DEFAULTS.maxAxles) {
    fail('maxAxles', cfg.maxAxles);
  }
  if (!isProbability(cfg.symmetricProbability)) fail('symmetricProbability', cfg.symmetricProbability);
  if (!isProbability(cfg.minInitialPowerGene)) fail('minInitialPowerGene', cfg.minInitialPowerGene);
  const cats = cfg.initialSuspensionTypes;
  if (!Array.isArray(cats) || cats.length === 0) fail('initialSuspensionTypes', cats);
  cats.forEach((c, i) => {
    if (!INITIAL_SUSPENSION_MASK.includes(c)) {
      fail(`initialSuspensionTypes[${i}]`, `${String(c)} — initial seeding masks to ${INITIAL_SUSPENSION_MASK.join('/')} (S2 lands with its realization PR)`);
    }
    if (cats.indexOf(c) !== i) fail(`initialSuspensionTypes[${i}]`, `duplicate ${c}`);
  });
  return cfg;
}

function resolveConfig(config) {
  const cfg = resolvePolicy(config);
  // Seeds are canonical uint32 BY RULING (the terrain-seed precedent): -1,
  // 1.5, 2^32, NaN must fail loud, never alias another population.
  if (!Number.isInteger(cfg.seed) || cfg.seed < 0 || cfg.seed > 0xffffffff) fail('seed', cfg.seed);
  if (!Number.isInteger(cfg.populationSize) || cfg.populationSize < 1) fail('populationSize', cfg.populationSize);
  return cfg;
}

/**
 * Draw ONE initial genotype from an individual's own child stream, following
 * the documented draw table exactly. `config` carries the policy fields
 * (seed/populationSize are accepted and ignored, so a resolved
 * createInitialPopulation config passes through unchanged).
 */
export function sampleInitialGenotype(rng, config = {}) {
  const cfg = resolvePolicy(config);
  const hue = rng.nextFloat();
  const symmetricOn = rng.bool(cfg.symmetricProbability);
  const symmetricValue = rng.nextFloat();
  const symmetric = symmetricOn ? 0.5 + symmetricValue * 0.5 : symmetricValue * 0.5;
  const power = rng.range(cfg.minInitialPowerGene, 1);
  const frameDensity = rng.nextFloat();
  const family = rng.nextFloat();
  const nodeCount = rng.nextFloat();
  const nodes = [];
  for (let i = 0; i < NODE_SLOTS; i += 1) {
    const gap = rng.nextFloat();
    const height = rng.nextFloat();
    const halfWidth = rng.nextFloat();
    const thickness = rng.nextFloat();
    nodes.push({ gap, height, halfWidth, thickness });
  }
  const beamWidthFrac = rng.nextFloat();
  const crossFrac = rng.nextFloat();
  const bulge = rng.nextFloat();
  const axleCount = rng.int(cfg.minAxles, cfg.maxAxles + 1);
  const drivenAxleIndex = rng.int(0, axleCount);
  const axles = [];
  for (let i = 0; i < axleCount; i += 1) {
    const posX01 = rng.nextFloat();
    const paired = rng.nextFloat();
    const trackHalf = rng.nextFloat();
    const radius = rng.nextFloat();
    const width = rng.nextFloat();
    const density = rng.nextFloat();
    const catIndex = rng.int(0, cfg.initialSuspensionTypes.length);
    const catValue = rng.nextFloat();
    const suspType = (SUSPENSION_TYPES.indexOf(cfg.initialSuspensionTypes[catIndex]) + catValue) / 3;
    const stiffness = rng.nextFloat();
    const damping = rng.nextFloat();
    const travel = rng.nextFloat();
    const restLength = rng.nextFloat();
    const drivenDraw = rng.nextFloat();
    const driven = i === drivenAxleIndex ? 0.5 + drivenDraw * 0.5 : drivenDraw;
    const share = rng.nextFloat();
    const driveBias = rng.nextFloat();
    const sizeBias = rng.nextFloat();
    const centerOffset = rng.nextFloat();
    axles.push({
      posX01, paired, trackHalf, radius, width, density,
      suspType, stiffness, damping, travel, restLength,
      driven, share,
      asym: { driveBias, sizeBias, centerOffset },
    });
  }
  return {
    version: GENOTYPE_VERSION,
    hue,
    symmetric,
    power,
    frameDensity,
    frame: {
      family,
      segments: [{
        nodeCount,
        nodes,
        fam: { spine: { beamWidthFrac }, ladder: { crossFrac }, hull: { bulge } },
      }],
    },
    axles,
  };
}

/**
 * Seed a full generation-0 population. Returns provenance SEPARATE from
 * identity: `population` is the canonical content (repaired genotypes,
 * explicit individualIds), `diagnostics` carries wasRepaired (repair changed
 * the raw draw) and, only under keepRaw, the raw draw itself — diagnostics
 * never enter any serialization.
 */
export function createInitialPopulation(config, options = {}) {
  const cfg = resolveConfig(config);
  if (typeof options !== 'object' || options === null) fail('options', options);
  for (const k of Object.keys(options)) {
    if (k !== 'keepRaw') fail(`options.${k}`, 'unknown key');
  }
  const keepRaw = options.keepRaw ?? false;
  if (typeof keepRaw !== 'boolean') fail('options.keepRaw', keepRaw);

  const root = new Rng(cfg.seed);
  const individuals = [];
  const diagnostics = [];
  for (let individualId = 0; individualId < cfg.populationSize; individualId += 1) {
    const raw = sampleInitialGenotype(root.fork(individualId), cfg);
    const ir = compileAssembly(raw);
    const genotype = ir.genotype; // the repaired clone — the heritable truth
    const wasRepaired = !bytesEqual(serializeGenotype(raw), serializeGenotype(genotype));
    individuals.push({ individualId, genotype });
    const d = { individualId, wasRepaired };
    if (keepRaw) d.rawGenotype = raw;
    diagnostics.push(d);
  }
  return {
    initializerVersion: POPULATION_INITIALIZER_VERSION,
    seed: cfg.seed,
    config: Object.freeze({ ...cfg }),
    population: { snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals },
    diagnostics,
  };
}

/** Serialize the provenance manifest (see the encoding walk above). */
export function serializePopulationInitialization(initialization) {
  if (typeof initialization !== 'object' || initialization === null) fail('initialization', initialization);
  if (initialization.initializerVersion !== POPULATION_INITIALIZER_VERSION) {
    fail('initialization.initializerVersion', initialization.initializerVersion);
  }
  if (initialization.config === null || typeof initialization.config !== 'object') {
    fail('initialization.config', initialization.config);
  }
  if (Object.hasOwn(initialization.config, 'seed') && initialization.config.seed !== initialization.seed) {
    fail('initialization.seed', `${initialization.seed} disagrees with config.seed ${initialization.config.seed}`);
  }
  const cfg = resolveConfig({ ...initialization.config, seed: initialization.seed });
  // Ruling R-E (additive digest-state input): the manifest's digest-state
  // bytes do not carry the population itself, so the literal inverse
  // invariant needs a population-free path. When initialization.population
  // is present the original statements run VERBATIM (and a simultaneously
  // declared state must AGREE, else fail loud); when absent, a declared
  // canonical-uint32 initialization.populationSnapshotDigestState is bound.
  // No existing caller passes the new field, so the production branch
  // executes identical statements in identical order and the locked
  // a6d04f75-class manifest digests stand.
  let snapshotState;
  if (initialization.population !== undefined) {
    const snapshotBytes = serializePopulationSnapshot(initialization.population);
    if (initialization.population.individuals.length !== cfg.populationSize) {
      fail('initialization.population.individuals.length', `${initialization.population.individuals.length} !== populationSize ${cfg.populationSize}`);
    }
    snapshotState = fnv1aFold(FNV_OFFSET_BASIS, snapshotBytes);
    if (initialization.populationSnapshotDigestState !== undefined
      && initialization.populationSnapshotDigestState !== snapshotState) {
      fail('initialization.populationSnapshotDigestState',
        `${initialization.populationSnapshotDigestState} disagrees with the digest of initialization.population (${snapshotState})`);
    }
  } else {
    snapshotState = initialization.populationSnapshotDigestState;
    if (!Number.isInteger(snapshotState) || snapshotState < 0 || snapshotState > 0xffffffff) {
      fail('initialization.populationSnapshotDigestState', snapshotState);
    }
  }
  const cats = cfg.initialSuspensionTypes;
  const view = new DataView(new ArrayBuffer(2 + 2 + 4 + 4 + 1 + 1 + 8 + 8 + 1 + cats.length + 4));
  let o = 0;
  view.setUint16(o, POPULATION_INITIALIZER_VERSION, true); o += 2;
  view.setUint16(o, GENOTYPE_VERSION, true); o += 2;
  view.setUint32(o, cfg.seed, true); o += 4;
  view.setUint32(o, cfg.populationSize, true); o += 4;
  view.setUint8(o, cfg.minAxles); o += 1;
  view.setUint8(o, cfg.maxAxles); o += 1;
  view.setFloat64(o, cfg.symmetricProbability, true); o += 8;
  view.setFloat64(o, cfg.minInitialPowerGene, true); o += 8;
  view.setUint8(o, cats.length); o += 1;
  for (const c of cats) { view.setUint8(o, SUSPENSION_TYPES.indexOf(c)); o += 1; }
  view.setUint32(o, snapshotState, true); o += 4;
  return new Uint8Array(view.buffer);
}

function decodeFail(path, value) {
  throw new Error(`population-initializer: invalid encoded initialization at ${path} (${String(value)})`);
}

/**
 * Decode serializePopulationInitialization's bytes back into the provenance
 * manifest SHAPE (population-free — the bytes close over the content by
 * digest state only). Exact inverse across the encoder's output domain
 * (ruling R-C): the decoder re-runs resolveConfig on the decoded fields —
 * EXACTLY the validation the encoder runs — so the S2 mask, duplicate
 * categories, and every domain violation reject identically. Category stream
 * order is preserved (config order is the wire order). The returned frozen
 * `{ initializerVersion, genotypeVersion, seed, config,
 * populationSnapshotDigestState }` feeds serializePopulationInitialization
 * LITERALLY via the R-E population-absent path and reproduces the bytes.
 */
export function deserializePopulationInitialization(bytes) {
  const r = createByteReader(bytes, decodeFail);
  const initializerVersion = r.u16('initializerVersion');
  if (initializerVersion !== POPULATION_INITIALIZER_VERSION) decodeFail('initializerVersion', initializerVersion);
  const genotypeVersion = r.u16('genotypeVersion');
  if (genotypeVersion !== GENOTYPE_VERSION) decodeFail('genotypeVersion', genotypeVersion);
  const seed = r.u32('seed');
  const populationSize = r.u32('populationSize');
  const minAxles = r.u8('minAxles');
  const maxAxles = r.u8('maxAxles');
  const symmetricProbability = r.finiteF64('symmetricProbability');
  const minInitialPowerGene = r.finiteF64('minInitialPowerGene');
  const categoryCount = r.u8('categoryCount');
  const initialSuspensionTypes = [];
  for (let i = 0; i < categoryCount; i += 1) {
    const index = r.u8(`initialSuspensionTypes[${i}]`);
    if (index >= SUSPENSION_TYPES.length) decodeFail(`initialSuspensionTypes[${i}]`, index);
    initialSuspensionTypes.push(SUSPENSION_TYPES[index]);
  }
  const populationSnapshotDigestState = r.u32('populationSnapshotDigestState');
  r.expectEnd('bytes');
  const config = resolveConfig({
    seed, populationSize, minAxles, maxAxles,
    symmetricProbability, minInitialPowerGene, initialSuspensionTypes,
  });
  return Object.freeze({
    initializerVersion,
    genotypeVersion,
    seed,
    config: Object.freeze({ ...config }),
    populationSnapshotDigestState,
  });
}
