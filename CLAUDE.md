# BoxCar3D

A genetic algorithm evolves 3D wheeled vehicles that drive forward through a
procedurally generated corridor: 3D terrain (elevations, craters, obstacles,
sand/mud zones), physical left/right walls, no steering, no AI control.
Inspired by BoxCar2D; morphology is deliberately richer (frames, suspension
types, free wheel arrangement). Stack: Vite + Three r185 + Rapier 0.19.3,
tests in Vitest, deployed to GitHub Pages by CI.

Canonical design docs live in `docs/` — **read before structural work**:
- `boxcar3d-design-rulings-spec-v2.md` — rulings, genotype/terrain architecture, glossary. The source of truth.
- `boxcar3d-phase0-refresh-2026-07.md` — Rapier/Three migration mapping, Phase 1 checklist, [V1]–[V9] verification items.
- `boxcar3d-red-team-2026-07.md` — why these rules exist (findings F1–F18).

`legacy/` holds the recovered 2025 private-repo snapshot: the last single-file
build, a stalled Rapier/Vite attempt, and `legacy/SALVAGE.md` — recovered gene
mappings, tuned defaults (gravity 20, population 20, mutation 0.05), and
evidence notes. Reference only; never import from `legacy/`.

## Hard rules

1. **IMPORTANT — Determinism (D7).** The ONLY randomness source in `src/sim`
   and `src/workers` is `src/sim/prng.js`. `Math.random` and library
   transcendentals are banned there (ESLint-enforced). Per-vehicle streams come
   from `rng.fork(vehicleId)` — never from a shared, order-dependent stream.
   Terrain noise must be hash-based, not trig-based. Never change the locked
   hash in `tests/prng.test.js` without bumping the seed-format version.
2. **IMPORTANT — Sim-time purity (F3).** Fitness, termination, stuck detection,
   and motor scheduling count fixed physics steps. Never `performance.now()`,
   `Date`, or frame deltas inside simulation logic. Time scale = more steps per
   frame at `FIXED_DT = 1/60`, never a larger dt — and `timeScale` must never
   appear inside any force, velocity, or fitness expression (the legacy build
   multiplied motor velocity by it, silently changing the physics; see
   `legacy/SALVAGE.md`).
3. **Tests first, seeds declared.** Every physics/GA feature lands with seeded
   Vitest tests. Statistical tests state their seed and sample size. CI must
   stay green; never weaken an assertion to make it pass.
4. **Incremental commits, never rewrites.** Small, reviewed diffs. Do not
   regenerate whole files or "start clean" — that failure mode killed a year of
   this project (see red-team F17).
5. **Scope walls.** Joint-based vehicles only (the ray-cast vehicle controller
   is intentionally out of scope — O3). No inter-vehicle collision, ever
   (ghost vehicles; worker sharding depends on it). No Cannon.js (D4).
6. **Schema discipline.** The frame genotype is a segment list (v1 compiles
   exactly one segment) and the gene schema carries a version field — keep both
   even when they look redundant (O4 plan-towards rule).

## Commands

- `npm run dev` — Vite dev server (smoke scene: falling cubes prove the stack)
- `npm test` / `npm run test:watch` — Vitest (Node env, headless Rapier works)
- `npm run lint` — includes the determinism ban on `src/sim`
- `npm run build` — production bundle; CI deploys `dist/` to GitHub Pages

## Architecture map

- `src/sim/` — deterministic core: `prng.js`, `physics/adapter.js` (the only
  Rapier seam), later: terrain gen, genotype + assembly compiler, GA operators.
  Must run headless in Node (tests and future CI evolution runs depend on it).
- `src/render/` — Three.js only; may use wall clock and `Math.*` freely.
- `src/workers/` — population sharding (Phase 1 step 6+); one physics world
  per worker; results merged by `postMessage`; shard-invariant by rule 1.
- `src/ui/` — controls panel (BoxCar2D-style options; see spec §5).
- `tests/` — `prng.test.js` (locked stream), `physics-smoke.test.js` (both
  Rapier flavors, headless, run-to-run identical), `heightfield-layout.test.js`
  ([V1] layout proof), `noise.test.js` + `terrain.test.js` (locked determinism
  fingerprints), `terrain-physics.test.js` (provisional floor/wall catch gate).

## Current state & next steps (Phase 1)

Scaffold + corridor floor verified. **Step 1b slice 1 (the pure R2
composite-terrain data contract) landed — `terrain.version` is now 2:**
- **[V1] proven** (`tests/heightfield-layout.test.js`): Rapier heightfield is
  column-major (`k = col*(rows+1)+row`), col j → world +X, row i → world +Z,
  origin-centered, `y = height*scale.y`; `castRay` needs one `world.step()`
  first (hit distance `.timeOfImpact`). Every terrain path relies on this.
- **`src/sim/noise.js`** — deterministic hash-based 2D value noise (no trig;
  built on `prng.js` `splitmix32`), locked fingerprint `52f40f90` (unchanged).
- **`src/sim/terrain.js`** — pure composite generator. Base heightfield (macro
  fBm + micro roughness, flat start pad) plus, all from dedicated ASCII-tagged
  `Rng.fork` streams ('crat'/'zone'/'feat', per-item `fork(i)`; the macro/micro
  integer-mix seed lines are byte-frozen):
  - **Craters** baked as smootherstep depressions (`craterDepthAt` is the
    analytic profile; depth = ratio×radius keeps rims drivable; fully inside
    the corridor, clear of the start envelope; overlaps sum in index order).
    `terrain.craters` descriptors kept as ground truth. Bounds and walls are
    sized **after** the bake (a crater can undercut the base minimum).
  - **Zones** — `terrain.zones`: per-heightfield-cell firm/sand/mud grid
    (`MATERIALS`, exact-quantile coverage with capped counts, start region
    forced firm) + `zoneAt(x, z)`, the clamped inverse cell mapping.
  - **Features** — `terrain.features`: boulder/ramp/log descriptors with
    trig-free unit `{cos, sin}` yaw (Marsaglia + sqrt; PR #8 builds quaternions
    via half-angle sqrt identities — no trig module ever), post-crater `y` via
    the bilinear `heightAtLocal` export, and a trailing per-feature `seed` for
    PR #8 hull-vertex jitter.
  - Zones and features are **data only** — no colliders, not rendered yet.
    Craters show through the rendered heightfield mesh automatically.
- **Locked fingerprints** (seed 20260708): base field `e2157c82` — pinned via
  `craterDensity: 0`, the permanent Step-1a byte-identity guard; default-config
  heights `48177e22`, craters `b9e05cf7`, zones `903a3d5f`, features
  `f3f86cbc`. Any change is a deliberate re-lock + seed-format version bump.
- **`tests/terrain-physics.test.js`** — the 20-sphere smoke gate is pinned to
  `craterDensity: 0` (byte-identical to the terrain its assertions were
  reviewed against); crater'd ground is covered by the new castRay crater probe
  (twin heightfields in one world, band assertions) and a crater settle test.
  Still the provisional gate, default flavor only — **not** the canonical
  1,000-spawn criterion, which must run both flavors.
- ESLint determinism ban now also covers `Math.hypot`/`cbrt` (implementation-
  approximated; `Math.sqrt` is correctly-rounded and stays allowed).
- `npm run lint && npm test && npm run build` all green; the Rapier init
  deprecation warning is still cosmetic — ignore.

Next, in order (details in phase0-refresh §6 + spec §7):
1. **PR #8 — realize the features:** boulder (convex hull seeded by the
   per-feature `seed`) / ramp (cuboid) / log (capsule) colliders through the
   adapter seam, collision groups (0x0001 ground, 0x0002 chassis, 0x0004
   wheels), render zones + features. 2. Chassis drop tests — the canonical
   1,000-spawn fall-through gate (Phase 0 success #1), run on both Rapier
   flavors, superseding the provisional 20-sphere smoke gate. 3. Assembly
   compiler + repair pass (spec §3). 4. Axle modules S0 → S1 → S2, each behind
   its own test gate; zone material response (friction/drag/torque per
   `zoneAt` sample) lands with wheels. 5. Worker sharding with the
   1-vs-4-workers equality test.
