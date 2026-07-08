import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';

// [V1] — Heightfield layout proof (docs/boxcar3d-phase0-refresh §6 "Open
// verifications"). MANDATORY before any terrain code exists.
//
// legacy/SALVAGE.md: the 2025 build's heightfield row/column -> world-axis
// mapping was NEVER tested. This test PROVES, by ray casts against a known
// field, the full convention every terrain/render path depends on:
//   * storage order: COLUMN-MAJOR — vertex (row i, col j) at heights[j*(nrows+1)+i]
//   * COL j -> world +X ,  ROW i -> world +Z   (no axis flipped)
//   * the field is CENTERED on the collider origin:
//       x = (j/ncols - 0.5) * scale.x ,  z = (i/nrows - 0.5) * scale.z ,
//       y = height * scale.y            (heights are NOT y-centered)
//   * SIGN: increasing j -> +X, increasing i -> +Z
//
// Method: two 2x2-vertex plateaus (a single vertex gives numerically ambiguous
// exact-vertex hits, so we probe FLAT CELL CENTERS instead), plus anti-transpose
// controls a row<->col swap would light up.
//
// Probe rule (from a live run on rapier3d-compat 0.19.3): every "flat" probe
// must sit in a cell whose FOUR corner vertices are all equal. A cell merely
// ADJACENT to a plateau bleeds elevation across the shared triangle edge — a
// zero-looking neighbour cell was observed reading ~1.5 m. "Interior" is not
// enough; the enclosing cell's corners must be uniform.
//
// Empirically verified here: storage is COLUMN-MAJOR, col j -> +X, row i -> +Z
// (low row index -> -Z side), origin-centered, plain {x,y,z} scale accepted,
// hit distance is `.timeOfImpact`. If any assertion changes, terrain generation
// and the render mesh must follow the DISCOVERY, not this prose.

const NROWS = 6; // Z cells
const NCOLS = 10; // X cells
const SCALE = { x: 10, y: 6, z: 6 }; // 1 m cells; X in [-5,5], Z in [-3,3]
const RAY_Y = 50; // cast origin, well above the tallest peak (6 m)

// Column-major flat index for vertex (row i, col j).
const idx = (i, j) => j * (NROWS + 1) + i;

let world;
let heights;

// Surface height at world (x,z): cast a unit ray straight down; because dir is
// unit length, timeOfImpact IS the world distance, so hitY = RAY_Y - toi.
function probeHeight(x, z) {
  const ray = new RAPIER.Ray({ x, y: RAY_Y, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, 100, true);
  return hit === null ? null : RAY_Y - hit.timeOfImpact;
}

describe('[V1] Rapier heightfield layout (column-major, col->+X, row->+Z)', () => {
  beforeAll(async () => {
    await RAPIER.init();
    world = new RAPIER.World({ x: 0, y: 0, z: 0 }); // static probe: no dynamics
    world.timestep = 1 / 60;

    heights = new Float32Array((NROWS + 1) * (NCOLS + 1)); // all 0
    // Plateau A: 2x2 vertices rows{2,3} x cols{7,8} = 1.0  (flat cell -> y=6)
    for (const i of [2, 3]) for (const j of [7, 8]) heights[idx(i, j)] = 1.0;
    // Plateau B: 2x2 vertices rows{4,5} x cols{2,3} = 0.5  (flat cell -> y=3)
    for (const i of [4, 5]) for (const j of [2, 3]) heights[idx(i, j)] = 0.5;

    world.createCollider(RAPIER.ColliderDesc.heightfield(NROWS, NCOLS, heights, SCALE));
    // MUST step once first: the standalone QueryPipeline is gone in 0.19.x and
    // the query BVH is built during step(). castRay before any step returns null
    // (verified live on rapier3d-compat 0.19.3).
    world.step();
  });

  afterAll(() => world && world.free());

  test('heights buffer length is (nrows+1)*(ncols+1)', () => {
    expect(heights.length).toBe((NROWS + 1) * (NCOLS + 1));
    expect(heights.length).toBe(77);
  });

  test('plateau A sits at world (x=+2.5, z=-0.5), height 6', () => {
    // cols{7,8} -> cell-center col 7.5 -> x=+2.5 (proves col->+X);
    // rows{2,3} -> cell-center row 2.5 -> z=-0.5 (proves row->+Z, negative side).
    expect(probeHeight(2.5, -0.5)).toBeCloseTo(6, 3);
  });

  test('plateau B sits at world (x=-2.5, z=+1.5), height 3', () => {
    // cols{2,3} -> x=-2.5 (negative X); rows{4,5} -> z=+1.5 (positive Z).
    // Distinct sign on both axes from A -> pins direction on X and Z.
    expect(probeHeight(-2.5, 1.5)).toBeCloseTo(3, 3);
  });

  test('control point is flat (cell i3,j4 — all four corners zero)', () => {
    // (-0.5, 0.5) is the center of cell (i=3,j=4); its corners (3,4)(3,5)(4,4)
    // (4,5) are all zero, so no plateau bleeds in via triangle interpolation.
    expect(probeHeight(-0.5, 0.5)).toBeCloseTo(0, 3);
  });

  test('anti-transpose controls are flat (rules out a row<->col axis swap)', () => {
    // The axis-swapped coordinates of each plateau probe. If rows mapped to X
    // and cols to Z, the plateaus would appear here. Both sit in all-zero-corner
    // cells (i5,j4) and (i0,j6), so a swap would make them tall, but the correct
    // mapping leaves them flat.
    expect(probeHeight(-0.5, 2.5)).toBeCloseTo(0, 3); // swap of A's (2.5,-0.5)
    expect(probeHeight(1.5, -2.5)).toBeCloseTo(0, 3); // swap of B's (-2.5,1.5)
  });

  test('plateau A is the unique global maximum of the field', () => {
    let max = -Infinity;
    let argmax = null;
    // Scan flat cell centers: x = col 0.5..9.5 -> -4.5..4.5; z = row 0.5..5.5 -> -2.5..2.5.
    for (let cx = -4.5; cx <= 4.5 + 1e-9; cx += 1) {
      for (let cz = -2.5; cz <= 2.5 + 1e-9; cz += 1) {
        const h = probeHeight(cx, cz);
        if (h !== null && h > max) {
          max = h;
          argmax = { x: cx, z: cz };
        }
      }
    }
    expect(max).toBeCloseTo(6, 3); // only plateau A's fully-flat cell reaches 6
    expect(argmax.x).toBeCloseTo(2.5, 6); // exact scan-grid coordinate
    expect(argmax.z).toBeCloseTo(-0.5, 6);
  });
});
