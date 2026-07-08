// src/sim/terrain.js — pure corridor-floor generator (NO Rapier).
//
// Deterministic function of the seed: a base heightfield from layered value
// noise (macro elevation + micro roughness), a flat start pad that smootherstep-
// blends into full terrain, and the two physical corridor walls sized to the
// terrain's own bounds. Realization into a Rapier world lives in
// physics/adapter.js (the only Rapier seam); this module is pure data, so it
// runs headless and is trivially testable.
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

// Flat-then-blend start envelope in [0, 1]: exactly 0 across the flat pad,
// smootherstep 0->1 across the blend, then 1. `worldX` measured from the start
// line at x = -length/2.
export function startEnvelope(worldX, { length, startFlatLength, startBlendLength }) {
  const d = worldX + length / 2;
  if (d <= startFlatLength) return 0;
  if (d >= startFlatLength + startBlendLength) return 1;
  return smootherstep((d - startFlatLength) / startBlendLength);
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
  // `walls` is the composite seam for Step 1a. The composite-from-day-one rule
  // (spec §4 / red-team F13) also wants `features` (craters/boulders/ramps/logs)
  // and a `zones` map (sand/mud) — those are DELIBERATELY omitted here, not
  // forgotten: they land with the composite-terrain step (see CLAUDE.md
  // next-steps), added as sibling keys alongside `walls`.
  const terrain = { version: 1, seed, rows, cols, heights, scale, walls: [], bounds: null, floorFriction: cfg.floorFriction, craters: [] };

  // Independent macro/micro seeds from the base seed by integer mixing (not a
  // shared stream — order-independent, replay-safe). BYTE-FROZEN: these two
  // lines are part of the Step-1a seed format (locked fingerprint e2157c82).
  const macroSeed = (Math.imul(seed >>> 0, 0x2c1b3c6d) ^ 0x9e3779b9) >>> 0;
  const microSeed = (Math.imul(seed >>> 0, 0x297a2d39) ^ 0x85ebca6b) >>> 0;
  // Composite-terrain streams fork from the root by named ID — order-independent
  // (fork reads only the original seed), so these never disturb the base field.
  const root = new Rng(seed);

  let minY = Infinity;
  let maxY = -Infinity;
  for (let col = 0; col <= cols; col++) {
    for (let row = 0; row <= rows; row++) {
      const { x, z } = indexToLocalXZ(row, col, terrain);
      const k = col * (rows + 1) + row;
      const env = startEnvelope(x, cfg);
      // Flat pad is exactly +0 (guard avoids IEEE -0 from negative*+0, and skips
      // the noise evaluation there).
      heights[k] = env === 0 ? 0 : fullElevation(x, z, cfg, macroSeed, microSeed) * env;
      // Bounds are the WORLD height the collider produces (heights[k]*scale.y),
      // using the float32 round-trip so wall sizing matches what the collider
      // sees. scale.y is 1 today, but keep the multiply so a future scale.y
      // can't silently desync the walls from the floor.
      const worldY = heights[k] * scale.y;
      if (worldY < minY) minY = worldY;
      if (worldY > maxY) maxY = worldY;
    }
  }
  terrain.craters = generateCraters(cfg, root.fork(STREAM_CRATERS));

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
  return terrain;
}
