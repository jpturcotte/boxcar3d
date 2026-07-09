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

- `src/sim/` — deterministic core: `prng.js`, `noise.js`, `terrain.js` (pure
  composite generator), `features.js` (pure descriptor→geometry: quats, hulls,
  support samples), `physics/adapter.js` (the only Rapier seam: realization,
  seating, collision groups), later: genotype + assembly compiler, GA
  operators. Must run headless in Node (tests and CI depend on it).
- `src/render/` — Three.js only; may use wall clock and `Math.*` freely.
- `src/workers/` — population sharding (Phase 1 step 6+); one physics world
  per worker; results merged by `postMessage`; shard-invariant by rule 1.
- `src/ui/` — controls panel (BoxCar2D-style options; see spec §5).
- `tests/` — `prng.test.js` (locked stream), `physics-smoke.test.js` (both
  Rapier flavors, headless, run-to-run identical), `heightfield-layout.test.js`
  ([V1] layout proof), `noise.test.js` + `terrain.test.js` (locked determinism
  fingerprints), `terrain-physics.test.js` (provisional floor/wall catch gate),
  `features.test.js` (pure geometry contract + locked hull fingerprint),
  `feature-physics.test.js` (feature colliders + collision groups, BOTH
  flavors via `describe.each` × `createPhysics`).

## Current state & next steps (Phase 1)

> **Landing a PR updates two handoffs, not one:** this section AND the README
> **Status** paragraph. They drift independently — external review caught a
> stale README on PR #7 and again on PR #8 — so treat "does the README still
> describe reality?" as part of every PR's done criteria.

Scaffold + corridor floor + composite data contract (`terrain.version` 2)
verified. **PR #8 landed — the composite terrain is physically real: static
feature colliders + collision groups + dev-scene rendering:**
- **[V1] proven** (`tests/heightfield-layout.test.js`): Rapier heightfield is
  column-major (`k = col*(rows+1)+row`), col j → world +X, row i → world +Z,
  origin-centered, `y = height*scale.y`; `castRay` needs one `world.step()`
  first (hit distance `.timeOfImpact`). Every terrain path relies on this.
- **`src/sim/terrain.js`** — pure composite generator, UNCHANGED by PR #8
  beyond comments (fingerprints prove it): base heightfield (macro fBm + micro
  roughness, flat start pad; `src/sim/noise.js`, locked `52f40f90`), craters
  baked as smootherstep depressions, `terrain.zones` firm/sand/mud cell grid +
  `zoneAt`, `terrain.features` boulder/ramp/log descriptors (trig-free
  `{cos, sin}` yaw, trailing per-feature `seed`). **Features may overlap each
  other — deliberate ruling** (clusters read as rock piles; static colliders
  coexist fine); overlap rejection, if ever wanted, is its own re-lock +
  version bump.
- **`src/sim/features.js`** (new, pure, under the ESLint sim ban) — the single
  source of descriptor→geometry: quaternions via half-angle sqrt identities
  (clamped radicands, `sgn(0)=+1` — no trig module ever) under one convention —
  `rot(yawToQuaternion(yaw), +X) == (cos, 0, sin)`, so a feature's length/roll
  axis points along its heading and the collider, render mesh, and seating
  support samples cannot disagree laterally (locked by a heading discriminator
  test; a mirrored yaw passes every norm/component check but fails it). Boulder
  hull points
  from `new Rng(feature.seed).fork(i)` (Marsaglia directions × radial jitter,
  `Math.fround`-quantized once so collider f32 and render mesh share exact
  vertices), per-type `shape` params and `supportSamples` with per-sample
  `bottomOffset` (ramp sign table locked by an ordering test: pitch +φ about
  Z, local +X uphill, low end faces −yaw). Geometry knobs
  (`boulderVertexCount`/`boulderJitterRange`/`rampThickness`) validated
  fail-loud.
- **`src/sim/physics/adapter.js`** — collision groups defined once:
  `GROUP_GROUND 0x0001` / `GROUP_CHASSIS 0x0002` / `GROUP_WHEEL 0x0004`,
  unsigned `packGroups`, policy constants `GROUND_GROUPS`/`CHASSIS_GROUPS`/
  `WHEEL_GROUPS` (+ documented ghost-vehicle matrix for PR #9 — chassis/wheels
  filter GROUND only; primitives `addHeightfield`/`addStaticBox` stay
  group-free). `addFeatures(RAPIER, world, terrain, floor, options)`: validates
  every knob (`embedDepth`/`friction`/`restitution` + geometry pass-through)
  BEFORE its single statics-only `world.step()` ([V1] BVH), then seats each
  feature on its HIGHEST castRay support sample (floor-handle predicate — never
  walls or other features) embedded by `embedDepth`, and builds convexHull /
  cuboid / capsule colliders; a degenerate hull throws the F16 diagnosis.
  `addCorridorWithFeatures` = corridor + features; returns realized records
  `{feature, collider, position, rotation, points, shape}` — render MUST use
  these (the seated pose does not exist in `terrain.features`).
- **`src/main.js`** — renders seated features from the realized records
  (ConvexGeometry from the same hull points / Box / Capsule), plus a zone
  debug overlay behind the repo's first dev flag (`?zones` URL param).
  Verified live: everything seated, ramp low edges face the start line.
- **Locked fingerprints** (seed 20260708): base field `e2157c82` (permanent
  Step-1a byte-identity guard via `craterDensity: 0`); default-config heights
  `48177e22`, craters `b9e05cf7`, zones `903a3d5f`, features `f3f86cbc` — all
  five UNCHANGED by PR #8; new: boulder hull points `06f5fca4`
  (`tests/features.test.js`). Any change is a deliberate re-lock + seed-format
  version bump.
- **`tests/feature-physics.test.js`** — BOTH Rapier flavors
  (`describe.each` × `createPhysics`): group wiring readback, no-burial /
  tight-seating castRay bounds, presence bands, blocked-drop proof on an
  isolated boulder, solver group matrix (positive, fall-through negative,
  ghost-ghost coexistence, filterGroups query arg, ungrouped-legacy), realized
  poses run-to-run identical per flavor, adapter knob negatives. The 20-sphere
  gate in `terrain-physics.test.js` is untouched (still the provisional gate,
  default flavor only — **not** the canonical 1,000-spawn criterion).
- `npm run lint && npm test && npm run build` all green; the Rapier init
  deprecation warning is still cosmetic — ignore.

Next, in order (details in phase0-refresh §6 + spec §7):
1. **PR #9 — chassis drop tests:** the canonical 1,000-spawn fall-through gate
   (Phase 0 success #1) over the full composite terrain (features realized),
   run on both Rapier flavors, superseding the provisional 20-sphere smoke
   gate; chassis bodies use `CHASSIS_GROUPS` + CCD. 2. Assembly compiler +
   repair pass (spec §3). 3. Axle modules S0 → S1 → S2, each behind its own
   test gate; zone material response (friction/drag/torque per `zoneAt`
   sample) lands with wheels, using `WHEEL_GROUPS`. 4. Worker sharding with
   the 1-vs-4-workers equality test.
