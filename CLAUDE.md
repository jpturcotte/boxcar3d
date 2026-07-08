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
  Rapier flavors, headless, run-to-run identical).

## Current state & next steps (Phase 1)

Scaffold complete and verified: tests green, lint canary fires, build green,
[V8] verified, [V7] both flavors resolve. Known cosmetic issue: Rapier compat
prints a deprecation warning from its own internal init — ignore.

Next, in order (details in phase0-refresh §6 + spec §7):
1. Composite corridor terrain to spec R2: heightfield ([V1] layout test FIRST)
   + walls + stamped features + zone map. 2. Static obstacles + collision
   groups. 3. Chassis drop tests (1,000-spawn fall-through gate). 4. Assembly
   compiler + repair pass (spec §3). 5. Axle modules S0 → S1 → S2, each behind
   its own test gate. 6. Worker sharding with the 1-vs-4-workers equality test.
