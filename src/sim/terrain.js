// src/sim/terrain.js — pure composite-corridor generator (NO Rapier).
//
// Deterministic function of the seed: a base heightfield from layered value
// noise (macro elevation + micro roughness) with a flat start pad that
// smootherstep-blends into full terrain, craters baked in as smootherstep
// depressions, two physical corridor walls sized to the POST-crater bounds,
// a per-cell firm/sand/mud zone map, and boulder/ramp/log feature descriptors
// (composite from day one — spec §4 / red-team F13). Realization into a Rapier
// world lives in physics/adapter.js (the only Rapier seam); this module is
// pure data, so it runs headless and is trivially testable. Zones and features
// are data-only until PR #8 (colliders, collision groups, material response).
//
// Layout convention PROVEN by [V1] (tests/heightfield-layout.test.js):
//   * COLUMN-MAJOR heights, flat index k = col*(rows+1) + row
//   * col j -> world +X (corridor length),  row i -> world +Z (corridor width)
//   * field centered on the origin;  y = height*scale.y  (scale.y = 1 -> metres)

import { fbm2D } from './noise.js';
import { Rng } from './prng.js';

// Named fork stream IDs (ASCII tags) — the seed-format contract for the
// composite-terrain streams. Never renumber. Per-item parameters come from
// stream.fork(i), so a draw added to item i can never shift item i+1, and
// skipping item i perturbs nothing else (rule 1: order-independent streams).
const STREAM_CRATERS = 0x63726174; // 'crat'
const STREAM_ZONES = 0x7a6f6e65; // 'zone'
const STREAM_FEATURES = 0x66656174; // 'feat'

// Zone material IDs. FIRM must stay 0 (a zero-filled grid is all-firm and the
// coverage-0 config degenerates cleanly); WATER is the spec's roadmap slot.
export const MATERIALS = Object.freeze({ FIRM: 0, SAND: 1, MUD: 2 });

// Stamped-feature types. Array index doubles as the fingerprint type id —
// append-only, never reorder (locked features fingerprint).
export const FEATURE_TYPES = Object.freeze(['boulder', 'ramp', 'log']);

const DEFAULTS = {
  seed: 0,
  length: 120, // metres along +X (corridor length)
  width: 12, // metres along Z (between the walls)
  cellSize: 1, // heightfield cell size in metres
  startFlatLength: 4, // metres of exactly-flat start pad from the start line
  startBlendLength: 6, // metres of smootherstep blend into full terrain
  macroAmp: 2, // ± metres of gentle elevation
  macroFrequency: 0.03, // cycles per metre (long-wavelength hills)
  macroOctaves: 3,
  microAmp: 0.2, // ± metres of surface roughness
  microFrequency: 0.35, // cycles per metre (short-wavelength bumps)
  microOctaves: 2,
  wallClearance: 4, // wall top rises this far above the highest terrain
  wallEmbed: 1, // wall base sinks this far below the lowest terrain
  wallThickness: 0.5,
  wallRestitution: 0.1, // "firm nudge back into play", not a pinball bumper (spec §4)
  wallFriction: 0.8,
  floorFriction: 1,
  craterDensity: 0.5, // craters per 100 m² of post-envelope area (0 = Step-1a base field)
  craterRadiusRange: [2, 5], // metres
  craterDepthRatioRange: [0.08, 0.22], // depth = ratio*radius; max slope 1.875*ratio <= 0.41 (drivable)
  zoneFrequency: 0.05, // cycles per metre of the zone noise field (~20 m patches)
  zoneOctaves: 2,
  sandCoverage: 0.15, // exact fraction of post-envelope cells (quantile-assigned)
  mudCoverage: 0.05, // ditto; mud takes the highest-noise band (cores inside sand)
  featureDensity: 0.4, // features per 100 m² of post-envelope area
  featureTypeWeights: { boulder: 3, ramp: 1, log: 2 }, // relative; replaced wholesale by user config
  boulderRadiusRange: [0.4, 1.1], // metres
  rampLengthRange: [4, 8], // metres, along the ramp's local +X
  rampWidthRange: [2.5, 4],
  rampHeightRange: [0.6, 1.6], // rise over the length
  logRadiusRange: [0.25, 0.45],
  logLengthRange: [3, 7], // capsule axis length (caps extend by radius)
};

const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

// World XZ of heightfield vertex (row i, col j) — the single source of truth for
// the [V1] mapping, reused by the collider realization and the render mesh so
// they cannot diverge.
export function indexToLocalXZ(row, col, terrain) {
  const { rows, cols, scale } = terrain;
  return {
    x: (col / cols - 0.5) * scale.x,
    z: (row / rows - 0.5) * scale.z,
  };
}

// Material at world (x, z) — the exact inverse of the indexToLocalXZ cell
// mapping, clamped to the edge cells so out-of-bounds queries (a wheel scraping
// a wall) return the nearest material instead of throwing. O(1); the wheel-
// contact response loop samples this every step in a later PR.
export function zoneAt(x, z, terrain) {
  const { scale, zones } = terrain;
  const col = Math.min(zones.cols - 1, Math.max(0, Math.floor((x / scale.x + 0.5) * zones.cols)));
  const row = Math.min(zones.rows - 1, Math.max(0, Math.floor((z / scale.z + 0.5) * zones.rows)));
  return zones.materials[col * zones.rows + row];
}

// World-space surface height at local (x, z): bilinear interpolation over the
// height grid via the [V1] convention, clamped into the field. PLACEMENT-grade,
// not collision-grade — Rapier triangulates each cell, so mid-cell values can
// deviate slightly from the collider surface (castRay tests use bands). Feature
// seating/embedding against the true triangle surface is PR #8's job.
export function heightAtLocal(x, z, terrain) {
  const { rows, cols, heights, scale } = terrain;
  const fc = Math.min(cols, Math.max(0, (x / scale.x + 0.5) * cols));
  const fr = Math.min(rows, Math.max(0, (z / scale.z + 0.5) * rows));
  const c0 = Math.min(cols - 1, Math.floor(fc));
  const r0 = Math.min(rows - 1, Math.floor(fr));
  const u = fc - c0;
  const v = fr - r0;
  const h = (row, col) => heights[col * (rows + 1) + row];
  const top = h(r0, c0) * (1 - u) + h(r0, c0 + 1) * u;
  const bot = h(r0 + 1, c0) * (1 - u) + h(r0 + 1, c0 + 1) * u;
  return (top * (1 - v) + bot * v) * scale.y;
}

// Flat-then-blend start envelope in [0, 1]: exactly 0 across the flat pad,
// smootherstep 0->1 across the blend, then 1. `worldX` measured from the start
// line at x = -length/2.
export function startEnvelope(worldX, { length, startFlatLength, startBlendLength }) {
  const d = worldX + length / 2;
  if (d <= startFlatLength) return 0;
  if (d >= startFlatLength + startBlendLength) return 1;
  return smootherstep((d - startFlatLength) / startBlendLength);
}

// Analytic total crater depression (metres, >= 0) at local (x, z) — the single
// source of the crater profile: depth * (1 - smootherstep(r/radius)) inside the
// radius, exactly zero at and beyond it (C1 at both ends; max slope
// 1.875*depth/radius at mid-radius). The bake stamps exactly this, so tests can
// compare field-vs-analytic vertex by vertex. Overlapping craters sum.
// Math.sqrt, not Math.hypot: sqrt is IEEE-754 correctly rounded (bit-exact
// across engines); hypot is implementation-approximated (ruling D7).
export function craterDepthAt(x, z, craters) {
  let d = 0;
  for (const c of craters) {
    const dx = x - c.x;
    const dz = z - c.z;
    const r = Math.sqrt(dx * dx + dz * dz);
    if (r >= c.radius) continue;
    d += c.depth * (1 - smootherstep(r / c.radius));
  }
  return d;
}

// Bake craters into the heightfield, IN INDEX ORDER, each over its clamped cell
// bounding box only. Zero craters => this never touches the buffer — the
// e2157c82 byte-identity guard is structural, not IEEE-edge-case reasoning
// (never rewrite this as a per-cell sum-over-craters pass). Float32 accumulation
// is order-sensitive in the last bit where craters overlap: never sort or
// filter the crater list between generation and baking.
function bakeCraters(terrain, craters) {
  const { rows, cols, heights, scale } = terrain;
  for (const c of craters) {
    const colMin = Math.max(0, Math.ceil(((c.x - c.radius) / scale.x + 0.5) * cols));
    const colMax = Math.min(cols, Math.floor(((c.x + c.radius) / scale.x + 0.5) * cols));
    const rowMin = Math.max(0, Math.ceil(((c.z - c.radius) / scale.z + 0.5) * rows));
    const rowMax = Math.min(rows, Math.floor(((c.z + c.radius) / scale.z + 0.5) * rows));
    for (let col = colMin; col <= colMax; col++) {
      for (let row = rowMin; row <= rowMax; row++) {
        const { x, z } = indexToLocalXZ(row, col, terrain);
        const dx = x - c.x;
        const dz = z - c.z;
        const r = Math.sqrt(dx * dx + dz * dz);
        if (r >= c.radius) continue;
        heights[col * (rows + 1) + row] -= c.depth * (1 - smootherstep(r / c.radius));
      }
    }
  }
}

// Crater descriptors from the dedicated 'crat' stream. Placement only — baking
// into the heightfield is a separate pass. Count is a pure function of config
// (never an RNG draw), over the POST-ENVELOPE area only, so density means what
// it says on the region craters may actually occupy. Craters sit fully inside
// the corridor and never touch the flat pad or the blend; a radius too big for
// the remaining room skips that crater (per-crater forks keep the rest stable).
function generateCraters(cfg, craterRng) {
  const { length, width, startFlatLength, startBlendLength } = cfg;
  const envelopeEndX = -length / 2 + startFlatLength + startBlendLength;
  const count = Math.round((cfg.craterDensity * (length - startFlatLength - startBlendLength) * width) / 100);
  const craters = [];
  for (let i = 0; i < count; i++) {
    const c = craterRng.fork(i);
    // Fixed draw order (seed-format contract): radius, depthRatio, x, z.
    const radius = c.range(cfg.craterRadiusRange[0], cfg.craterRadiusRange[1]);
    const depth = radius * c.range(cfg.craterDepthRatioRange[0], cfg.craterDepthRatioRange[1]);
    const xMin = envelopeEndX + radius;
    const xMax = length / 2 - radius;
    const zMin = -width / 2 + radius;
    const zMax = width / 2 - radius;
    if (xMin > xMax || zMin > zMax) continue; // no room for this radius
    craters.push({ x: c.range(xMin, xMax), z: c.range(zMin, zMax), radius, depth });
  }
  return craters;
}

// Zone material grid: one byte per heightfield CELL (not vertex), column-major
// k = col*rows + row, mirroring the [V1] convention. Materials come from a
// dedicated hash-noise field (spatial, order-independent — never a sequential
// per-cell stream) sampled at cell centers, with coverage assigned by EXACT
// QUANTILE over the eligible (post-envelope) cells: fbm output is bell-ish, so
// a raw threshold would not deliver the configured fraction; ranking does.
// Counts are capped sequentially so rounding can never assign more cells than
// exist. Start pad + blend cells are forced FIRM (fair starts). Pure data —
// the physics response table (friction/drag/torque per material, spec §4)
// samples this at wheel contacts in a later PR.
function generateZones(cfg, terrain, zoneSeed) {
  const { rows, cols } = terrain;
  const materials = new Uint8Array(rows * cols);
  const eligible = []; // {k, n} for post-envelope cells
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const { x, z } = indexToLocalXZ(row + 0.5, col + 0.5, terrain); // cell center
      if (startEnvelope(x, cfg) !== 1) continue; // start region stays FIRM (0)
      const n = fbm2D(x * cfg.zoneFrequency, z * cfg.zoneFrequency, zoneSeed, { octaves: cfg.zoneOctaves });
      eligible.push({ k: col * rows + row, n });
    }
  }
  // Highest noise first; index ascending breaks (rare) exact ties deterministically.
  eligible.sort((a, b) => b.n - a.n || a.k - b.k);
  const mudCount = Math.min(eligible.length, Math.round(cfg.mudCoverage * eligible.length));
  const sandCount = Math.min(eligible.length - mudCount, Math.round(cfg.sandCoverage * eligible.length));
  for (let i = 0; i < mudCount; i++) materials[eligible[i].k] = MATERIALS.MUD;
  for (let i = mudCount; i < mudCount + sandCount; i++) materials[eligible[i].k] = MATERIALS.SAND;
  return { rows, cols, materials };
}

// Feature descriptors from the dedicated 'feat' stream — pure data; colliders
// and collision groups are PR #8. Count is a pure function of config over the
// post-envelope area (like craters). Placement margins use each type's MAX
// half-extent from config (conservative — the drawn dims always fit), so the
// per-feature draw order stays fixed: type, x, z, yaw, dims, seed. The trailing
// per-feature seed is PR #8's handle for hull-vertex jitter etc. (boulders are
// convex hulls per spec §4) without re-deriving streams; new fields append
// after it. y samples the POST-crater surface — features are generated last.
//
// Yaw is a unit {cos, sin} heading, generated trig-free: Marsaglia disk
// rejection + Math.sqrt (IEEE-exact; the ESLint trig ban stays intact, and
// PR #8 builds the quaternion via half-angle sqrt identities — no trig module
// ever). The rejection loop's variable draw count is safe ONLY because it runs
// on the feature's own fork. Ramps instead take a small lateral jitter around
// +X so they read as ramps, not walls.
function generateFeatures(cfg, terrain, featureRng) {
  const { length, width, startFlatLength, startBlendLength } = cfg;
  const envelopeEndX = -length / 2 + startFlatLength + startBlendLength;
  const count = Math.round((cfg.featureDensity * (length - startFlatLength - startBlendLength) * width) / 100);
  const weights = FEATURE_TYPES.map((type) => cfg.featureTypeWeights[type] || 0);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const maxHalf = {
    boulder: cfg.boulderRadiusRange[1],
    ramp: Math.sqrt((cfg.rampLengthRange[1] / 2) ** 2 + (cfg.rampWidthRange[1] / 2) ** 2),
    log: cfg.logLengthRange[1] / 2 + cfg.logRadiusRange[1],
  };
  const features = [];
  for (let i = 0; i < count; i++) {
    if (totalWeight <= 0) break;
    const f = featureRng.fork(i);
    // Fixed draw order (seed-format contract): type, x, z, yaw, dims, seed.
    let pick = f.nextFloat() * totalWeight;
    let ti = 0;
    while (ti < weights.length - 1 && pick >= weights[ti]) {
      pick -= weights[ti];
      ti++;
    }
    const type = FEATURE_TYPES[ti];
    const half = maxHalf[type];
    const xMin = envelopeEndX + half;
    const xMax = length / 2 - half;
    const zMin = -width / 2 + half;
    const zMax = width / 2 - half;
    if (xMin > xMax || zMin > zMax) continue; // no room for this type
    const x = f.range(xMin, xMax);
    const z = f.range(zMin, zMax);
    let yaw;
    if (type === 'ramp') {
      const jitter = f.range(-0.35, 0.35);
      const inv = 1 / Math.sqrt(1 + jitter * jitter);
      yaw = { cos: inv, sin: jitter * inv };
    } else {
      for (;;) {
        const u = f.range(-1, 1);
        const v = f.range(-1, 1);
        const m = u * u + v * v;
        if (m > 1 || m < 1e-12) continue;
        const inv = 1 / Math.sqrt(m);
        yaw = { cos: u * inv, sin: v * inv };
        break;
      }
    }
    let dims;
    if (type === 'boulder') {
      dims = { radius: f.range(cfg.boulderRadiusRange[0], cfg.boulderRadiusRange[1]) };
    } else if (type === 'ramp') {
      dims = {
        length: f.range(cfg.rampLengthRange[0], cfg.rampLengthRange[1]),
        width: f.range(cfg.rampWidthRange[0], cfg.rampWidthRange[1]),
        height: f.range(cfg.rampHeightRange[0], cfg.rampHeightRange[1]),
      };
    } else {
      dims = {
        radius: f.range(cfg.logRadiusRange[0], cfg.logRadiusRange[1]),
        length: f.range(cfg.logLengthRange[0], cfg.logLengthRange[1]),
      };
    }
    const seed = f.nextUint32();
    features.push({ type, x, z, y: heightAtLocal(x, z, terrain), yaw, dims, seed });
  }
  return features;
}

function fullElevation(x, z, cfg, macroSeed, microSeed) {
  const macro = cfg.macroAmp * (fbm2D(x * cfg.macroFrequency, z * cfg.macroFrequency, macroSeed, { octaves: cfg.macroOctaves }) * 2 - 1);
  const micro = cfg.microAmp * (fbm2D(x * cfg.microFrequency, z * cfg.microFrequency, microSeed, { octaves: cfg.microOctaves }) * 2 - 1);
  return macro + micro;
}

// Fail loud on config that would otherwise yield degenerate terrain, Infinity,
// NaN, or a RangeError from the Float32Array allocation (review A.1).
function validateConfig(cfg) {
  if (!(cfg.cellSize > 0)) throw new Error('generateCorridorTerrain: cellSize must be > 0');
  if (!(cfg.length > 0) || !(cfg.width > 0)) throw new Error('generateCorridorTerrain: length and width must be > 0');
  if (!(cfg.wallThickness > 0)) throw new Error('generateCorridorTerrain: wallThickness must be > 0');
  if (cfg.wallClearance < 0 || cfg.wallEmbed < 0) throw new Error('generateCorridorTerrain: wallClearance and wallEmbed must be >= 0');
  if (cfg.startFlatLength < 0 || cfg.startBlendLength < 0) throw new Error('generateCorridorTerrain: start lengths must be >= 0');
  if (cfg.startFlatLength + cfg.startBlendLength > cfg.length) {
    throw new Error('generateCorridorTerrain: startFlatLength + startBlendLength cannot exceed length');
  }
  for (const key of ['craterDensity', 'featureDensity']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 0) {
      throw new Error(`generateCorridorTerrain: ${key} must be a finite number >= 0`);
    }
  }
  // Frequency knobs are multiplied into the noise coordinates BEFORE fbm2D
  // (not passed as its `frequency` option), so fbm2D's own frequency guard
  // never sees them. A 0/NaN/Infinity frequency silently collapses or poisons
  // the field (every cell ties, so the zone quantile degenerates to index
  // order) instead of failing loud — validate here for all three noise fields.
  for (const key of ['macroFrequency', 'microFrequency', 'zoneFrequency']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] <= 0) {
      throw new Error(`generateCorridorTerrain: ${key} must be a finite number > 0`);
    }
  }
  for (const key of [
    'craterRadiusRange', 'craterDepthRatioRange', 'boulderRadiusRange',
    'rampLengthRange', 'rampWidthRange', 'rampHeightRange', 'logRadiusRange', 'logLengthRange',
  ]) {
    const r = cfg[key];
    if (!Array.isArray(r) || r.length !== 2 || !Number.isFinite(r[0]) || !Number.isFinite(r[1]) || !(r[0] > 0) || !(r[0] <= r[1])) {
      throw new Error(`generateCorridorTerrain: ${key} must be [min, max] with 0 < min <= max`);
    }
  }
  for (const key of ['sandCoverage', 'mudCoverage']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 0 || cfg[key] > 1) {
      throw new Error(`generateCorridorTerrain: ${key} must be a coverage fraction within [0, 1]`);
    }
  }
  if (cfg.sandCoverage + cfg.mudCoverage > 1) {
    throw new Error('generateCorridorTerrain: sandCoverage + mudCoverage cannot exceed 1');
  }
  const weights = cfg.featureTypeWeights;
  if (typeof weights !== 'object' || weights === null) {
    throw new Error('generateCorridorTerrain: featureTypeWeights must be an object of type -> weight');
  }
  for (const [type, w] of Object.entries(weights)) {
    // Unknown keys throw: { asteroid: 1 } would otherwise pass a total-weight
    // check while producing no known feature type.
    if (!FEATURE_TYPES.includes(type)) {
      throw new Error(`generateCorridorTerrain: featureTypeWeights has unknown feature type '${type}'`);
    }
    if (!Number.isFinite(w) || w < 0) {
      throw new Error(`generateCorridorTerrain: featureTypeWeights.${type} must be a finite number >= 0`);
    }
  }
  // Sum in canonical FEATURE_TYPES order — the SAME order generateFeatures uses.
  // Float addition is not associative, so summing over Object.entries (user key
  // order) instead would make this depend on config-key order; keep one order in
  // the file so a future de-dup can only ever copy the correct one.
  const totalWeight = FEATURE_TYPES.reduce((sum, type) => sum + (weights[type] || 0), 0);
  const featureCount = Math.round((cfg.featureDensity * (cfg.length - cfg.startFlatLength - cfg.startBlendLength) * cfg.width) / 100);
  if (totalWeight <= 0 && featureCount > 0) {
    throw new Error('generateCorridorTerrain: featureTypeWeights total must be > 0 when features are requested');
  }
}

export function generateCorridorTerrain(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  validateConfig(cfg);
  const { seed, length, width, cellSize } = cfg;
  const rows = Math.round(width / cellSize); // Z cells  (row i -> +Z)
  const cols = Math.round(length / cellSize); // X cells  (col j -> +X)
  // Positive length/width can still round to zero cells (e.g. width < cellSize/2);
  // a heightfield needs at least one cell per axis.
  if (rows < 1 || cols < 1) {
    throw new Error('generateCorridorTerrain: length/width round to fewer than one cell — increase them or decrease cellSize');
  }
  const scale = { x: length, y: 1, z: width }; // y=1 -> heights are literal metres
  const heights = new Float32Array((rows + 1) * (cols + 1));
  // The composite seam (spec §4 / red-team F13), complete as data: `walls`,
  // `craters` (baked into `heights`; descriptors kept as ground truth), `zones`
  // (per-cell material grid), `features` (boulder/ramp/log descriptors —
  // colliders and collision groups are the NEXT step, PR #8).
  // version 2: craters bake into the default heights (same seed, different
  // bytes than v1) and the composite sibling keys land — the seed-format bump
  // the locked-fingerprint rule requires.
  const terrain = { version: 2, seed, rows, cols, heights, scale, walls: [], bounds: null, floorFriction: cfg.floorFriction, craters: [], zones: null, features: [] };

  // Independent macro/micro seeds from the base seed by integer mixing (not a
  // shared stream — order-independent, replay-safe). BYTE-FROZEN: these two
  // lines are part of the Step-1a seed format (locked fingerprint e2157c82).
  const macroSeed = (Math.imul(seed >>> 0, 0x2c1b3c6d) ^ 0x9e3779b9) >>> 0;
  const microSeed = (Math.imul(seed >>> 0, 0x297a2d39) ^ 0x85ebca6b) >>> 0;
  // Composite-terrain streams fork from the root by named ID — order-independent
  // (fork reads only the original seed), so these never disturb the base field.
  const root = new Rng(seed);

  for (let col = 0; col <= cols; col++) {
    for (let row = 0; row <= rows; row++) {
      const { x, z } = indexToLocalXZ(row, col, terrain);
      const k = col * (rows + 1) + row;
      const env = startEnvelope(x, cfg);
      // Flat pad is exactly +0 (guard avoids IEEE -0 from negative*+0, and skips
      // the noise evaluation there).
      heights[k] = env === 0 ? 0 : fullElevation(x, z, cfg, macroSeed, microSeed) * env;
    }
  }

  terrain.craters = generateCraters(cfg, root.fork(STREAM_CRATERS));
  bakeCraters(terrain, terrain.craters);

  // Bounds are computed AFTER the crater bake (a crater floor can undercut the
  // base field's minimum — walls sized from pre-crater bounds would leave a gap
  // underneath). They are the WORLD height the collider produces
  // (heights[k]*scale.y), read back from the Float32Array so wall sizing matches
  // what the collider sees; scale.y is 1 today, but keep the multiply so a
  // future scale.y can't silently desync the walls from the floor.
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    const worldY = heights[k] * scale.y;
    if (worldY < minY) minY = worldY;
    if (worldY > maxY) maxY = worldY;
  }
  terrain.bounds = { length, width, minY, maxY };

  // Walls sized to the terrain's own bounds: base below the lowest dip, top
  // clearing the highest peak (never a fixed height that a tall peak overtops).
  const wallBottom = minY - cfg.wallEmbed;
  const wallTop = maxY + cfg.wallClearance;
  const wall = (sign) => ({
    half: { x: length / 2, y: (wallTop - wallBottom) / 2, z: cfg.wallThickness / 2 },
    pos: { x: 0, y: (wallTop + wallBottom) / 2, z: sign * (width / 2 + cfg.wallThickness / 2) },
    restitution: cfg.wallRestitution,
    friction: cfg.wallFriction,
  });
  terrain.walls = [wall(-1), wall(1)]; // -Z wall, +Z wall (inner faces flush at z = ±width/2)

  terrain.zones = generateZones(cfg, terrain, root.fork(STREAM_ZONES).seed);
  terrain.features = generateFeatures(cfg, terrain, root.fork(STREAM_FEATURES));
  return terrain;
}
