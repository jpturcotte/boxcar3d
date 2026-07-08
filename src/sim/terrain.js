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

function fullElevation(x, z, cfg, macroSeed, microSeed) {
  const macro = cfg.macroAmp * (fbm2D(x * cfg.macroFrequency, z * cfg.macroFrequency, macroSeed, { octaves: cfg.macroOctaves }) * 2 - 1);
  const micro = cfg.microAmp * (fbm2D(x * cfg.microFrequency, z * cfg.microFrequency, microSeed, { octaves: cfg.microOctaves }) * 2 - 1);
  return macro + micro;
}

export function generateCorridorTerrain(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const { seed, length, width, cellSize } = cfg;
  const rows = Math.round(width / cellSize); // Z cells  (row i -> +Z)
  const cols = Math.round(length / cellSize); // X cells  (col j -> +X)
  const scale = { x: length, y: 1, z: width }; // y=1 -> heights are literal metres
  const heights = new Float32Array((rows + 1) * (cols + 1));
  const terrain = { version: 1, seed, rows, cols, heights, scale, walls: [], bounds: null, floorFriction: cfg.floorFriction };

  // Independent macro/micro seeds from the base seed by integer mixing (not a
  // shared stream — order-independent, replay-safe).
  const macroSeed = (Math.imul(seed >>> 0, 0x2c1b3c6d) ^ 0x9e3779b9) >>> 0;
  const microSeed = (Math.imul(seed >>> 0, 0x297a2d39) ^ 0x85ebca6b) >>> 0;

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
      const stored = heights[k]; // float32 round-trip — what the collider sees
      if (stored < minY) minY = stored;
      if (stored > maxY) maxY = stored;
    }
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
  return terrain;
}
