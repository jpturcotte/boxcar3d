# BoxCar3D

A genetic algorithm evolves 3D wheeled vehicles that drive forward through a
procedurally generated corridor: 3D terrain (elevations, craters, obstacles,
sand/mud zones), physical left/right walls, no steering, no AI control.
Inspired by BoxCar2D; morphology is deliberately richer (frames, suspension
types, free wheel arrangement). Stack: Vite + Three r185 + Rapier 0.19.3,
tests in Vitest, deployed to GitHub Pages by CI.

Canonical design docs live in `docs/` — **read before structural work**:
- `boxcar3d-design-rulings-spec-v2.md` — rulings, genotype/terrain architecture, glossary. The source of truth.
- `boxcar3d-phase0-refresh-2026-07.md` — Rapier/Three migration mapping, Phase 1 checklist, [V1]–[V12] verification items.
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
- `npm test` / `npm run test:watch` — Vitest (Node env, headless Rapier works;
  excludes `tests/browser/**`)
- `npm run test:determinism` — the narrow golden-lock + fresh-module gate
  (the FOUR files CI's 3-OS matrix runs: the two evaluation files plus
  `cohort-determinism` and `population-determinism`)
- `npm run test:browser` — the Chromium gate (vitest browser mode + pinned
  playwright; one-time local setup: `npx playwright install chromium`)
- `npm run bench:physics` — the physics cost matrix (an INSTRUMENT, results
  pasted into PRs — never a CI threshold; `-- --smoke` for a quick pass)
- `npm run probe:timing` — the retained Rapier timing/timestep-semantics
  probe (exits 1 on engine-semantics DRIFT; re-run on any Rapier upgrade)
- `npm run probe:population` — the GA-population characterization instrument
  (distributions/viability/undriven-audit/cost/shared-world-recheck; markdown
  to stdout, `--json`; defaults SMALL for a light local run, big sweep opt-in;
  never a CI gate — its only touchpoint is the schema smoke)
- `npm run lint` — includes the determinism ban on `src/sim`
- `npm run build` — production bundle; CI deploys `dist/` to GitHub Pages

## Architecture map

- `src/sim/` — deterministic core: `prng.js`, `noise.js`, `terrain.js` (pure
  composite generator), `features.js` (pure descriptor→geometry: quats, hulls,
  support samples), `assembly.js` (the genome contract: genotype schema +
  compiler + repair v0 + the S1 hub policy), `physics/adapter.js` (the only
  Rapier seam: realization, seating, collision groups, chassis, the S0
  wheel/joint/motor kernel, and the S1 prismatic/hub suspension behind
  `realizeVehicle`'s explicit dispatch), `fnv1a.js` (the extracted house lock
  hash — streaming state-passing fold), `trace.js` (the versioned per-step
  trace: 128-byte records, TraceWriter, checkpoint + divergence diagnostics),
  `evaluation.js` (the ONE canonical headless runner — `runEvaluation`),
  `evaluation-fixtures.js` (declared fixtures A/B/C + `evaluationOptionsFor`),
  `evaluation-locks.js` (golden digests + per-step checkpoint states; literals
  only), `population.js` (canonical population CONTENT + snapshot encoding),
  `population-initializer.js` (the live seed→generation-0 policy: draw table,
  symmetry prior, S0/S1 mask, driven-by-construction, + the provenance
  manifest), `population-evaluation.js` (the deterministic per-individual
  evaluator on ISOLATED worlds: fitness policy, spawn placement, evaluation-
  spec + fitness-vector encodings, champion selection), `population-fixtures.js`
  + `population-locks.js` (the committed population/fitness contract, literals
  only), later: GA operators (selection/mutation — Phase 1B).
  Must run headless in Node (tests and CI depend on it).
- `scripts/` — Node-only instruments OUTSIDE the sim ESLint ban (wall clock
  allowed): `probe-rapier-timing.js`, `bench-physics.js`,
  `characterize-population.js`.
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
  flavors via `describe.each` × `createPhysics`), `chassis-drop.test.js`
  (the canonical 1,000-spawn chassis fall-through gate, both flavors),
  `assembly.test.js` (genome contract: repair identity/idempotence/
  no-mutation, per-rule corrections, symmetry, two locked fingerprints),
  `assembly-physics.test.js` (compiled chassis on the composite terrain,
  both flavors, policy readback + negative teeth), `s0-motor.test.js` (the
  motor-model ruling at the raw Rapier level: inertia discriminator,
  torque/target/speed teeth, sign lock, solver-pump finding),
  `s0-kernel.test.js` (realizeS0Vehicle's creation-time contract: pure pose
  math, readbacks, the S1/S2 gate, Proxy-induced transactional-cleanup
  teeth, legal edge shapes), `s0-drive.test.js` (the forward-drive witness
  on the declared flat-pad terrain + the residual-overlap witness),
  `s1-prismatic.test.js` (the raw prismatic/spring-model ground truth:
  coordinate contract, ForceBased honesty vs the rejected AccelerationBased,
  limits/preload/zero-travel, vehicle-local covariance + the world-vertical
  negative, the colliderless-readback and k=0∧c=0-freeze engine findings),
  `s1-kernel.test.js` (realizeVehicle's creation-time contract: helpers vs
  the oracle, counts/groups/CCD/anchors/quiescent spawn, dispatch gates,
  tamper + API-drift negatives, transactionality incl. joint-config-stage
  traps), `s1-sag.test.js` (static relational teeth on flat ground),
  `s1-drive.test.js` (the three-way rough-strip witness + roll-180, max
  topology, strange phenotype, findings ledger), `fnv1a.test.js` (published
  vectors, incremental≡one-shot, equivalence with two pre-existing locked
  hashes), `trace.test.js` + `trace-writer.test.js` (the 128-byte codec
  contract, capture modes, checkpoints, every compare mismatch class),
  `evaluation.test.js` (runner + fixture contract, `readBodyState`
  classifications against real engine states), `evaluation-progress.test.js`
  (the max-forward-progress metrics: pure fold contract + both-flavor
  trace-recompute witnesses), `evaluation-determinism.test.js`
  + `evaluation-golden.test.js` (the golden-lock gates — `test:determinism`),
  `population.test.js` + `population-initializer.test.js` (the pure population
  layer: encodings, draw-table invariants, config validation),
  `population-evaluation.test.js` (evaluator + fitness + spawn + champion),
  `cohort-invariance.test.js` (the full heterogeneous isolation-contract
  protocol) + `cohort-determinism.test.js` (its matrix-narrowed cross-OS
  gate — `test:determinism`), `population-determinism.test.js` (the committed
  population/fitness golden gate — `test:determinism`),
  `population-probe-schema.test.js` (the characterization instrument's only
  CI touchpoint), `bench-schema.test.js` (the bench's only CI touchpoint),
  and `tests/browser/evaluation-determinism.test.js` +
  `tests/browser/population-determinism.test.js` (the Chromium gates, own
  config `vitest.browser.config.js`, excluded from `npm test`); plus the
  committed instruments `s1-calibration-probe.js` (`npm run probe:s1`) —
  NOT tests.

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
  gate in `terrain-physics.test.js` stays as a fast smoke check (default
  flavor only), superseded as the criterion by PR #9's canonical gate.

**PR #9 landed — the canonical 1,000-spawn chassis fall-through gate (Phase 0
success #1), and a load-bearing physics finding:**
- **`tests/chassis-drop.test.js`** — BOTH flavors × 20 batches × 50 chassis
  cuboids (half extents 0.9/0.25/0.45, `CHASSIS_GROUPS`, fresh world per
  batch, seeds declared: terrain 20260708, spawns 20260709). Per batch: 40
  rest drops (post-envelope corridor x ∈ [−49, 52], random yaw + ≤ ~22° tilt,
  impact ≈ 23–28 m/s) + 10 high-velocity CCD probes (`setLinvel` 40–50 m/s ≈
  0.68–0.87 m/step > the 0.5 m box thickness — speeds rest drops physically
  cannot reach, so a CCD regression actually fails the gate; feature-clear by
  bounded rejection). After 360 steps every body must be: finite, contained
  (`|z| < 5.9`, `|x| < 59.5` — the x-ends are open), above the −50 free-fall
  net, and inside the center-clearance band — `p.y ≥ floorY + 0.10` against a
  floor-only ray (slope-independent burial teeth; the topmost surface would
  false-fail under ramp overhangs) and `p.y ≤ surfaceY + 1.2` against the
  `filterGroups = CHASSIS_GROUPS` topmost ray (tightened from a looser 2.6 —
  observed max is 0.935, so a body perched/bridged high now fails) — and at
  rest (velocities inside the settle band). Violations report
  seed/batch/index/spawn/pose/surface diagnostics. Calibrated extremes over
  all 2,000 landings are recorded in the file header band comment.
- **The finding — hard CCD is INERT against the heightfield in rapier 0.19.3:**
  CCD'd cuboids AND balls tunnel the floor from ~23 m/s up with the identical
  failure set as non-CCD bodies. What catches fast bodies is **soft CCD**
  (`RigidBodyDesc.setSoftCcdPrediction`). Adapter policy export
  `SOFT_CCD_PREDICTION = 1` (metre; covers 60 m/s per step): every dynamic
  chassis/wheel body MUST set `.setCcdEnabled(true)` (convex-vs-convex cover)
  AND `.setSoftCcdPrediction(SOFT_CCD_PREDICTION)`. The assembly compiler
  (next PR) must apply both to every body it emits.
- Terrain/features/fingerprints untouched (adapter gained only the constant +
  policy comment); teeth verified both ways locally: gate fails with soft-CCD
  removed and with a GROUND-less filter.
- `npm run lint && npm test && npm run build` all green; the Rapier init
  deprecation warning is still cosmetic — ignore.

**PR #10 landed — assembly compiler + repair pass v0 (spec §3 / §7 step 7):
pure genotype → repaired assembly IR, chassis realization only. The genotype
schema is a locked design ruling — treat it like the terrain seed format:**
- **`src/sim/assembly.js`** (pure, no Rapier, under the sim ban) — the genome
  contract. Genotype: integer `version` (O4) + `[0,1]` genes with affine
  decoders (SALVAGE convention; `GENE_RANGES` is the single scaling table;
  wheel radius `g·0.5+0.2` kept verbatim; `gene[0]=hue` kept as top-level
  `hue` = canonical flat index 0; divergences D1–D7 documented in the module
  header + schema comments). Frame: segment LIST (v1 requires exactly length
  1) × FIXED 6 node slots (`nodeCount` gene selects the active prefix;
  cumulative `gap` spacing makes node x monotone by construction; per-family
  latent blocks make family flips non-destructive), families
  spine/ladder/hull — compound cuboids for spine/ladder, one f32 convex hull
  for `hull` (points `Math.fround`-quantized ONCE, the features.js vertex
  discipline; ≥2 nodes at distinct x ⇒ never degenerate from a valid
  genotype). Axles: variable-length module list (cap `maxAxles` 6 ⇒ ≤12
  wheels, the O1 default; corpus pinned to defaults), decoded/bounded/
  snapped/repaired as **IR data only** — S0 realization is the S0 kernel PR. Symmetry:
  core gene, neutral 0.5 decoder (default-on is the future population
  seeder's bias, NOT the decoder), expanded at build: paired modules mirror
  exactly, singles snap to centerline; flips are count-stable; the per-module
  latent `asym` block ({driveBias, sizeBias, centerOffset}) is gated, never
  erased. Per-wheel `driveTorque` is PRE-computed from the global power
  budget (`g·500`, split by normalized shares) so the split never appears
  inside a force/velocity expression later (the legacy timeScale bug class).
- **Repair contract: domain-invalid throws (`{path, value}`); physical
  invalidity repairs.** Every correction is a fused clamp on the target gene
  (bounds inverted through the affine decoder once — the target never
  round-trips decode→modify→re-encode) in a forward DAG: single writer per
  gene, position-independent bounds (`maxHalfHeight`, never
  `heightAt(posX)` — that feedback loop is the known idempotence killer).
  Repair is exactly idempotent, proven corpus-wide by BYTE-equality of the
  canonical flat encoding — that guard is non-negotiable. Repair bounds the
  EMITTED vehicle, not just base genes (external-review blocker, fixed
  pre-merge): rules in order: axle-count cap → wheels-below-frame +
  clearance (radius up; mount at frame vertical center, `mountY = 0`
  explicit in IR) → wheel mass [2, 80] kg (density) → size-bias feasibility
  (the sizeBias gene re-satisfies clearance + mass for the biased second
  wheel a paired module emits; always feasible since f = 1 is in-band) →
  track/offset vs corridor walls → longitudinal non-overlap (max-sweep by
  the EMITTED max radius — expression-gated so a latent bias never shapes
  the phenotype — capped at the frame end; residual overlap accepted —
  collision-inert because vehicle self-pairs filter GROUND only) → chassis
  mass [5, 500] kg. Corpus tests assert clearance + mass band over EVERY
  emitted wheel. Anchor validity holds by construction (posX = fraction
  of span). 0-axle / 0-driven genotypes are legal (sled, scores ~0).
- **Two new locks @ seed 20260710, N=256** (`tests/assembly.test.js`):
  repaired-genotype corpus `24cd0dd5` (f64 LE, the documented
  `serializeGenotype` walk — array order, never object keys; re-locked
  in-review for the R3b/R5 fix, still version 1 — the pre-review hash never
  merged) and chassis-geometry `39bcd6c4` (IR colliders; hull points f32
  LE; UNCHANGED by the re-lock — colliders derive only from never-repaired
  frame genes). Changing either is a deliberate re-lock + genotype-version
  bump. Suspension param
  ranges (stiffness/damping/travel/restLength) are PROVISIONAL — the S1 PR
  binds them to `configureMotorPosition` (expected re-lock, documented).
- **`realizeChassis(RAPIER, world, ir, {position, rotation, linvel})`**
  (adapter) — exactly ONE dynamic body per IR: `CHASSIS_GROUPS` on every
  collider, dual CCD, and `.setAdditionalSolverIterations(
  ADDITIONAL_SOLVER_ITERATIONS = 4)` — [V2] resolved, verified locally
  against BOTH installed 0.19.3 flavors' typings (desc setter chainable +
  `additionalSolverIterations()` readback; wheels inherit the budget through
  the chassis joint island, so the S0 PR does not set it per wheel). Validates
  everything before touching the world; degenerate hulls fail loud and the
  half-built body is removed. **Finding:** a COPLANAR hull cloud does NOT
  fail 0.19.3 hull construction — it builds a zero-volume shape; the
  post-create mass/inertia sanity assertion is the fail-loud that catches it
  (all-identical points still hit the F16 null-desc/lazy-throw path). Both
  modes locked as negatives.
- **`tests/assembly-physics.test.js`** — BOTH flavors: 14-IR corpus (all
  three families, symmetric/asymmetric, one repaired-from-violating) + 3
  high-velocity probes on the full composite terrain; the PR #9 teeth
  generalized per-IR (floor-only ray ≥ 0.6·`supports.minFace`, topmost
  `CHASSIS_GROUPS` ray ≤ `supports.reach` + 0.35 — measured extremes in the
  header band comment); full policy readback; strip-soft-CCD and
  strip-GROUND-filter negatives both lose the body. NOT a new 1,000-spawn
  gate — PR #9 stays the canonical criterion.
- Dev scene: one compiled ladder chassis (declared corpus fork 9) drops at
  the start line, hue-tinted, meshes from the same IR colliders. Terrain
  paths and all five terrain fingerprints untouched.

**Pre-S0 hardening PR landed — five external-review findings closed. Zero
behavior change for in-domain project inputs (every existing locked
fingerprint byte-identical — the noise lock, the five terrain locks, the
boulder-hull geometry lock, and the two assembly locks); garbage and newly
ruled-out inputs now fail loud:**
- **`validateConfig` is function-wide** (`src/sim/terrain.js`): every scalar
  knob carries `Number.isFinite` + its documented domain. The NaN/`!(x > 0)`
  comparison bug class the frequency block had fixed once existed in every
  older knob — NaN `startFlatLength` silently poisoned heights AND walls,
  `length`/`width` Infinity died as a raw typed-array RangeError, and
  `floorFriction` had no validation at all. Frictions are finite ≥ 0 with NO
  upper bound (the addFeatures convention); `wallRestitution` within [0, 1]
  (the adapter's restitution domain); amps finite, sign-free. **Seeds are
  canonical uint32 BY RULING** (integer in [0, 0xffffffff]): the PRNG
  canonicalizes with `>>> 0` but `terrain.seed` stores the input verbatim, so
  −1 / 1.5 / 2³² silently aliased another world under a different identifier
  (a NaN seed produced the seed-0 world byte-for-byte). `TERRAIN_DEFAULTS` is
  the exported, DEEP-frozen public contract, enumerated programmatically by
  the sweep in `tests/terrain.test.js` — `SCALAR_DOMAINS` must equal the
  scalar knobs by exact set equality, so a new knob fails until it declares a
  domain. Octaves stay validated downstream in fbm2D (deliberate; the sweep
  locks the propagate path via `/octaves/`). A finite-yet-degenerate grid
  (tiny cellSize, huge dimension, or an over-budget product) no longer
  RangeErrors or over-allocates silently — `MAX_TERRAIN_VERTICES` (2^22, a
  documented resource-budget ceiling) fails it loud before the Float32Array
  allocation (external-review blocker).
- ESLint sim block bans `Date` alongside `performance` (hard rule 2 /
  red-team F3); no sim file used it — teeth verified by stdin probe.
- Dev-scene debris carries the dual-CCD policy (hard CCD alone is
  heightfield-inert per the PR #9 finding; a 12 m drop into the deepest
  crater reaches the ~23 m/s tunneling threshold).
- Assembly options guards locked against ±Infinity; comment-only f32-ulp
  precision note on the corpus clearance teeth.
- [V2]/[V4] recorded in phase0-refresh's verification queue ([V4] = signature
  resolved; parameter ranges still bind at S1).

**The S0 kernel PR landed — the mechanism proof (spec §3.2/§3.4): a
repaired, all-S0 assembly IR realizes through Rapier's native
cylinder/revolute/joint-motor path and propels a canonical vehicle toward
world +X on declared flat terrain. Movement is joint-motor causality only —
nothing anywhere calls setAngvel, applies impulses/forces, or writes poses
after creation:**
- **`realizeS0Vehicle(RAPIER, world, ir, {position, rotation, linvel,
  targetAngvel, wheelFriction})`** (adapter) — one dynamic cylinder body per
  IR wheel (`ColliderDesc.cylinder(width/2, radius)`), one chassis-to-wheel
  revolute per wheel (`JointData.revolute(chassisLocalCenter, origin,
  REVOLUTE_AXIS)`), `WHEEL_GROUPS` + dual CCD on every wheel body, NO
  per-wheel solver iterations (the chassis carries the joint-island budget).
  ALL validation is pre-world (axle/wheel domains, mass-vs-πr²wρ
  consistency, unit spawn quaternion to 1e-6, finite options); S1/S2 axles
  are rejected HERE — never in repair/compile (`SUSPENSION_TYPES` stays
  `['S0','S1','S2']`; the 24cd0dd5 corpus lock and the every-suspension-type
  assertion keep them legal as IR data). Transactional cleanup: a failure
  after partial construction removes every created joint (reverse order),
  every wheel body, then the chassis — counts provably unchanged
  (Proxy-induced mid-construction throws in `tests/s0-kernel.test.js`).
  Zero-axle IRs realize chassis-only sleds; zero-driven realize free-rolling.
- **The pose/hinge-frame contract (supersedes the earlier "prefer UNROTATED
  wheel bodies" advice, which was correct only at identity spawn):** Rapier's
  revolute takes ONE axis vector interpreted in EACH body's local frame, so
  the hinge frames agree in world space only while the bodies share a base
  orientation. Therefore: wheel body base rotation = chassis spawn rotation
  (every spawn), the +90°-about-X `WHEEL_COLLIDER_ROTATION`
  `(√.5, 0, 0, √.5)` is applied to the COLLIDER only, chassis-local wheel
  center = `{axle.posX, axle.mountY, wheel.z}` (exported pure math:
  `s0WheelTransforms`), anchors = that local center / wheel origin, axis
  `REVOLUTE_AXIS (0,0,1)` in both aligned frames. Validated at yaw-90:
  creation anchor error ~1.5e-6 at the |x|≈45 spawn (f32 scale — one ULP
  there is ~3.8e-6, so readback tolerances MUST scale with |coordinate|;
  the ~4e-8 figure is the identity spawn at small coords, not yaw-90),
  ≤ 7.2e-3 over 600 driven steps.
- **The motor ruling (measured; `tests/s0-motor.test.js`): ForceBased +
  gain conversion.** Rapier's motor factor is a velocity-servo GAIN (no
  JS-reachable max-force exists in 0.19.3), so the adapter derives
  `gain = driveTorque / |targetAngvel|` ⇒ signed law τ = gain × (targetAngvel
  − ω) = sign(targetAngvel) × driveTorque × (1 − ω/targetAngvel): stall
  MAGNITUDE = driveTorque EXACTLY (sign follows targetAngvel — the canonical
  −10 gives −driveTorque stall), zero at the target (no-load) speed. Airborne
  discriminator: same driveTorque on wheels of 5.06× inertia
  → first-step ω ratio 4.86 under ForceBased (a real torque) vs 1.000 under
  AccelerationBased (inertia normalized away — REJECTED; its factor is not a
  torque and wheel size would silently rescale thrust; note it is NOT
  mass-insensitive at the vehicle level, where traction dynamics dominate —
  the airborne rig is the discriminator). Teeth: torque doubling ×1.905,
  target-speed invariance ±4%, α at half-target 0.523× (theory 0.5), vehicle
  mass tooth 2.20× at 3.4× mass, T-vs-2T dx ratio 1.80. Policy constants:
  `S0_MOTOR_MODEL_NAME = 'ForceBased'` (symbolic, resolved per flavor,
  fail-loud if missing), `MOTOR_TARGET_ANGVEL = -10` rad/s (NEGATIVE about
  local +Z drives +X — contact-point kinematics, locked by the sign test;
  magnitude is the SALVAGE legacy default) **[SUPERSEDED — the per-wheel
  surface-speed PR replaced this shared constant with
  `MOTOR_TARGET_WHEEL_SURFACE_SPEED = 5` m/s and per-wheel targets
  ω_i = −speed/radius_i; see that PR's block. The ForceBased gain
  conversion and the sign lock stand]**, `WHEEL_FRICTION = 1` (explicit —
  Rapier's silent default is 0.5). Every motor gain
  (`driveTorque / |targetAngvel|`) is derived and validated pre-world: a
  zero target with any motorized wheel is rejected, AND any non-finite gain
  is rejected (a finite denormal-tiny target overflows to `Infinity`). No
  magnitude floor on FINITE gains — a large finite gain (~6.25e9 at target
  1e-8) is stable in-probe, so only non-finite is out of domain.
- **The forward-drive witness** (`tests/s0-drive.test.js`, both flavors):
  declared terrain seed 20260713, `startFlatLength: 80` (pad x ∈ [−60, +20],
  exactly-zero elevation), craters/features/zones off per knob, default
  amplitudes KEPT (real terrain beyond the pad; NO locked fingerprint
  involved). Canonical repair-stable 2-paired-axle vehicle: driven +19.4 m
  over 600 steps vs undriven −0.06 m; reversed target (+10, via the
  `targetAngvel` option, spawned at x = 0 — the corridor x-ends are OPEN)
  drives −19.2 m; |dz| ≤ 0.18; gain semantics through the shipped path
  (target −5 vs −10: vx@15 within 0.2%, cruise cap halves; power-gene
  doubling: vx@15 ×1.92). Residual-overlap witness: the R5 cap case (axle
  spacing 0.195 m < combined radii 1.0 m) realizes, 300 steps finite, no
  detach/explosion — whether visually-overlapping wheels are acceptable for
  EVOLUTION is still the open schema-ruling question from PR #10's review.
- **Findings for later PRs:** (1) solver-pump drift — an awake free-rolling
  jointed vehicle under the chassis `ADDITIONAL_SOLVER_ITERATIONS` policy
  self-accelerates to ~0.33 m/s on a flat cuboid and never sleeps (sign and
  magnitude shift with contact rounding; soft CCD irrelevant; without the
  extra iterations it settles); the motor teeth settle behind a parking
  brake (native motor path, target 0) — GA fitness must not assume an
  undriven vehicle holds still on cuboid ground (on the heightfield pad the
  witness undriven twin DID sleep at rest). (2) Mixed-radius wheels under
  the single shared `MOTOR_TARGET_ANGVEL` fight each other (disagreeing
  no-load surface speeds — the dev scene's old fork(9) pick cannot move)
  **[RESOLVED — the per-wheel surface-speed PR: each wheel derives its own
  target ω_i = −targetWheelSurfaceSpeed/radius_i from one no-load surface
  speed, so every wheel agrees on contact-surface speed by construction;
  measured by the mixed-radius drive witness and locked as fixture D]**;
  thrust/weight under ~6% stalls on the start-blend grade at gravity 20
  (a GRADE limit, distinct from and NOT resolved by the drive law — stall
  thrust is driveTorque/r, preserved by design; still stands).
  The dev scene now drives a declared hand-built all-S0 build (~23%
  thrust/weight) ~46 m into the composite terrain, wheels rendered from the
  same IR dims and synced as body rotation × `WHEEL_COLLIDER_ROTATION`.
- Full suite green both flavors; every locked fingerprint byte-identical
  (terrain paths untouched; assembly.js changes comment-only).

**The S1 suspension kernel PR landed — the first honest deformable
suspension (spec §3.2's S1): chassis → prismatic → hub → revolute → wheel,
with explicit mixed S0/S1 dispatch. Every ruling below is measured, both
flavors, byte-identical at the declared seeds:**
- **`realizeVehicle(RAPIER, world, ir, options)`** (adapter) — explicit
  per-axle dispatch: S0 = the S0 kernel's original statements (all-S0
  counts, call order, rollback, and every existing test UNCHANGED);
  S1 = one hub body + one chassis→hub prismatic + one hub→wheel revolute
  per wheel; S2/unknown types rejected pre-world. `realizeS0Vehicle` stays
  the S0-only fail-loud wrapper (legacy return shape). One shared
  validation pass (all pre-world: spring params, stored hub records vs the
  policy, `ir.mass.hubsTotal`, the S1 API surface via prototype checks) +
  one transactional pass — joints enter the rollback ledger BEFORE any
  configuration call, so throws inside `setLimits`/`configureMotor*`
  unwind too (rollback: drive joints → prismatics → wheel bodies → hub
  bodies → chassis; proven by world-method AND proxied-joint-method traps).
- **The coordinate contract ([V11], measured):** `SUSPENSION_AXIS (0,−1,0)`
  is VEHICLE-LOCAL by ruling — at roll-180 the suspension extends world-UP
  (locked with a direct world-vertical negative: the wrong placement misses
  by 2× the coordinate). Coordinate 0 = full compression = the S0-safe
  wheel position `{posX, mountY, z}` (extension only ADDS clearance — R2
  needs no S1 variant); positive = extension; limits `[0, travel]` with
  measured stop compliance ≈ 9e-6 m/N; the motor target is ABSOLUTE;
  placement sets the initial coordinate. Spawns are QUIESCENT at
  `clamp(restLength, 0, travel)`; preload (rest > travel) spawns pressed
  into the droop stop — its static state; travel 0 = locked (legal). NO
  native coordinate readback exists in 0.19.3 — the pure
  `projectedPrismaticCoordinate` is the only source, and its bands must
  scale with the WORLD-ANCHOR magnitudes, never the small projected value.
- **The spring ruling ([V12], measured):** the spring IS the prismatic's
  ForceBased position motor (`S1_SPRING_MOTOR_MODEL_NAME`, symbolic) —
  isolated-rig statics are EXACT (target ± m·g/k on both sides; damping
  changes decay, not equilibrium); AccelerationBased settles 5 kg and
  50 kg identically (mass-blind) → REJECTED. Engine findings: a k=0∧c=0
  position motor 0/0-FREEZES the axis (the realizer skips motor config for
  that phenotype — no motor IS the honest free slider), and IN-CHAIN static
  sag inflates by γ ≈ 0.33·c·dt/m_unsprung (solver convergence starvation;
  exact at c=0 or heavy wheels; the chassis
  `ADDITIONAL_SOLVER_ITERATIONS = 4` policy is LOAD-BEARING — without it
  the same vehicle bottoms outright). Recorded, not remediated.
- **Hubs are compiler-owned IR data (assembly.js):** `hubMassProperties(
  wheel)` → `{mass, radius, halfWidth, density, principalInertia}` — a
  small solid cylinder coaxial with the wheel (mass = clamp(0.25·wheelMass,
  [0.5, 20] = 0.25 × the wheel band), geometry scales with wheel radius AND
  width, so equal-mass hubs on different wheels differ in inertia). Stored
  per S1 wheel as `wheel.hub` (null on S0/S2); `ir.mass.hubsTotal` +
  `total` include hubs; the realizer CONSUMES the stored record and the
  policy recomputation is the tamper guard (the wheelMass pattern).
  Collider-carrying by MEASURED necessity: colliderless additional-mass
  bodies read mass()/inertia() ZERO until the first `world.step()` (both
  the desc API and the runtime setter — locked as a negative), which would
  defeat the creation-time readback cross-check; `HUB_GROUPS =
  packGroups(GROUP_HUB 0x0010, 0)` touches NOTHING (0x0008 stays reserved)
  + dual CCD. Principal-inertia readbacks come back in the PRINCIPAL
  frame's ordering (axial on the y slot for the rotated cylinder) — tests
  compare the value SET.
- **The version split (review ruling):** `ASSEMBLY_IR_VERSION = 2` (the
  compiled physical-record contract — v2 carries hub records,
  mass.hubsTotal, genotypeVersion; v1 hubless IRs are REJECTED loud, the
  migration tooth) is now separate from `GENOTYPE_VERSION = 1` (the gene
  schema — UNCHANGED: the calibration matrix measured every provisional
  suspension range binding to real physics with its numbers intact, so
  this is their first physical binding, NOT a re-lock; the corpus
  fingerprint hashes raw [0,1] genes and stands at `24cd0dd5`. This
  consciously supersedes the previous handoff's "expected corpus re-lock"
  phrasing — the expectation conflated binding with changing). Committed
  Gate-5 instrument: `npm run probe:s1` (13 bench + 20 chain declared
  rows × both flavors; regenerate before touching any suspension range).
- **The three-way rough-strip witness** (`tests/s1-drive.test.js`, seed
  20260714, pad [−60,−40], rough segment x ∈ [−30,+30] on DEFAULT fBm
  amplitudes): rigid S0 twin vs MASS-MATCHED S1 (chassis density reduced by
  the hub total; compiled AND realized totals equal) vs native-cost S1
  (recorded). Measured: RMS chassis-local vertical accel 8.585 → 1.288
  (0.150×), peak 32.1 → 5.7, contact continuity 0.83 → 1.00, dx 82.4 →
  85.4 m, travel mid-band with zero limit strikes. The teeth are the
  suspension effect + an absolute progress floor — deliberately NO
  not-slower-than-S0 guard. The witness fixture is small-wheeled on a low
  frame (thrust/weight ≈ 1.0): a 29% build STALLED on this seed's blend
  grade (the S0-era stall finding re-measured — witness fixtures must
  clear the approach before their claims mean anything).
- **Findings for later PRs (recorded, unchanged rulings):** solver-pump
  drift is UNCHANGED by S1 (undriven all-S1 on a cuboid creeps at
  −0.327 m/s ≈ the S0 0.33 finding; a preloaded suspension pressed into
  its stop also never sleeps — residual creep 0.565 m/s); the
  mixed-radius shared-target conflict persists under suspension travel
  **[RESOLVED — the per-wheel surface-speed PR; witnessed on flat ground:
  the r 0.5/0.42 build's small wheels no longer drag the big ones]**;
  the R5-cap residual overlap stays stable with S1 modules; the max legal
  topology (6 paired S1 axles = 25 bodies / 24 joints) is stable and
  drives under the existing chassis solver-iteration policy.
- Dev scene: mixed S0-front / S1-rear declared build drives ~53 m of the
  composite corridor (the all-S0 build managed ~46 m), rear coordinate
  breathing across [0.08, 0.25] of 0.30 m travel; invisible hubs, thin
  green anchor→hub struts, live `rearQ` HUD readout via the pure
  projection. Render reads poses only.
- Full suite green both flavors; every locked fingerprint byte-identical
  (noise, five terrain locks, boulder hull, `24cd0dd5`, `39bcd6c4`).

**The deterministic-trace + physics-budget gate PR landed — the
representative determinism/performance instrument (phase0-refresh §6 item
8's superset), plus the O3 documentation resolution. Every ruling below is
measured; every earlier locked fingerprint is byte-identical:**
- **The canonical runner (`src/sim/evaluation.js`, wall-clock-free):**
  `runEvaluation({deterministic, terrain (must carry its own seed),
  vehicles: [{ir, spawn, targetWheelSurfaceSpeed?, wheelFriction?}], maxSteps,
  termination:'maxSteps', trace:{mode, checkpointInterval?}, profile,
  hooks:{onPhase}})` owns createPhysics, terrain (+ the one statics
  BVH pre-step), realization, the fixed-step loop, per-step capture,
  metrics, and `world.free()`. Vehicles enter as COMPILED IRs (a
  genotype-accepting runner would silently repair — the digest must
  attest to what the caller saw). Callers own elapsed time:
  `hooks.onPhase(name)` fires names only. Capture indices 0..maxSteps
  (0 = post-realization: spawn placement is under the digest); the run
  always executes exactly maxSteps (no data-dependent early exit — a
  non-finite vehicle LATCHES `{step, reason:'nonFinite'}` and keeps
  being stepped and traced shape-static). Unknown option keys reject
  loud everywhere. Result: per-vehicle forwardDistance/finalPose/
  finalVelocity/finite/terminated/validity/sleep counts, world counts,
  the trace envelope, `timing.stepMs` (per-step `timingStep()` when
  `profile`), and `{requestedDt, effectiveDt}`.
- **The dt ruling (measured, probe-locked):** the engine stores the
  timestep as f32 — `world.timestep = 1/60` reads back
  `Math.fround(1/60)` = 0.01666666753590107, NOT the f64 1/60; the
  runner asserts that readback and the locks bind it. An exact-f64
  assertion would fail on every run.
- **The trace contract (`src/sim/trace.js`, EVALUATION_TRACE_VERSION 1
  — its own axis: a trace-version change means the ENCODED contract
  changed, not physics):** fixed 128-byte records — u32 LE
  stepIndex/vehicleIndex/axleIndex/wheelIndex (`NO_INDEX` 0xffffffff;
  u32 so the format imposes no station ceiling below the runtime
  guard), 8 flag/enum bytes (bodyRole chassis/hub/wheel, bodyValid,
  bodySleeping, jointState invalid/valid/notApplicable, terminated,
  terminationReason none/nonFinite, finiteState, reserved), 13 raw LE
  f64 floats (translation/rotation/linvel/angvel). NO normalization
  (−0, denormals, ±Inf, quaternion sign bit-preserved) EXCEPT NaN →
  canonical quiet NaN via explicit setUint32 writes (setFloat64's NaN
  pattern is implementation-defined per the ES spec; wasm NaN payloads
  are nondeterministic — raw NaN bits would break the cross-env gate
  exactly in the blow-up case). Joint tri-state: chassis = AND over the
  vehicle's joints ('notApplicable' for a sled), hub = its prismatic,
  wheel = its drive revolute. Canonical order (vehicle → chassis →
  stations axle-then-wheel, hub before wheel) is a WRITE-TIME invariant
  in TraceWriter. Capture modes: none (literal no work) / digest
  (streaming fold, retains nothing) / full (scratch COPIES, identical
  digest). Checkpoints `{stepIndex, recordCount, byteCount, state}`
  carry the raw cumulative uint32 FNV state (O(1) — the state IS the
  hash); finish() appends a terminal checkpoint only when the last
  endStep didn't already make one. `compareTraces` reports the first
  divergence (version/size/field-with-bytes/ordering/missing/extra);
  `compareCheckpoints` accepts partial lock-style entries.
  `src/sim/fnv1a.js` is the extracted house hash (0x811c9dc5 /
  Math.imul 0x01000193), proven byte-identical to two pre-existing
  locked constants; existing test-local loops stay untouched.
- **Golden locks (`src/sim/evaluation-locks.js`, literals only, zero
  imports)** @ deterministic flavor 0.19.3, digest mode, interval 1:
  `eval-a-s0-flat` v1 (seed 20260715, 600 steps, 3005 records/384640
  bytes) digest `5a219735`; `eval-b-mixed-composite` v1 (seed 20260716,
  composite defaults ON, 900 steps, 6307/807296) `65f9e2fd`;
  `eval-c-max-s1` v1 (seed 20260717, 25 bodies/24 joints, 600 steps,
  15025/1923200) `bc71517b` — each with its FULL per-step
  checkpoint-state array committed (≈2,103 uint32s total), so a failing
  environment reports its first divergent STEP against the lock, not
  just "digest differs". Re-lock workflow: set digest null → the gate
  prints the full measured record as paste-ready JSON → Node green →
  Chromium must agree before merge. Locks carry
  fixtureVersion/traceVersion/recordBytes/rapierVersion (checked at run
  time via `RAPIER.version()`)/effectiveDt/executedSteps/captureCount/
  checkpointCount.
- **Environments actually verified (no broader claim):** fresh-world ×2
  and fresh-module (a second Vitest file = fresh module graph + fresh
  world under the measured forks pool — NOT claimed as a fresh OS
  process or fresh wasm instantiation) on Windows dev + CI
  ubuntu/windows/macos Node 22 (`node-determinism` matrix, only
  `test:determinism`), and pinned Chromium 149.0.7827.55 via vitest
  browser mode + playwright 1.61.1 exact (`browser-determinism` job,
  cached binaries keyed on the playwright version; deploy now needs all
  three jobs). Chromium reproduced all three digests and every
  checkpoint state on the first run. Because fixture B keeps the
  composite defaults, the browser gate transitively proves the
  integer-noise field, crater baking, zone quantiles, feature
  generation, and the addCorridorWithFeatures castRay-seating path
  bit-identical in Chromium — nothing is claimed about rendering.
  Default flavor: per-process repeatability asserted; digest never
  locked (F10).
- **Measured engine findings (recorded, load-bearing):** (1) a pose
  read on a REMOVED body panics the wasm module ("unreachable") and can
  poison later calls — `readBodyState`'s isValid() guard + canonical-NaN
  readout is the only safe idiom; (2) raw `setLinvel(NaN)` is ACCEPTED
  and the NaN persists through stepping — the finite flag detects it;
  (3) NO legal runner input produces NaN on 0.19.3 — velocities to 1e25
  m/s stay finite 60+ steps and ~3e38 hard-panics wasm (a thrown error,
  not a NaN trace), so the non-finite latch is a defensive net, tested
  at the readBodyState seam (its 6-line wiring is negative-covered
  only — a recorded limitation); (4) the ghost-isolation lock: vehicle
  0's FULL 3005-record trace is bit-equal solo vs sharing its world
  with an identical ghost — the worker-sharding equivalence witness;
  (5) profiler timing*() methods are per-step MILLISECONDS gated on the
  `profilerEnabled` accessor (default false; disable freezes, re-enable
  resumes; components do NOT sum to timingStep; the ~1.5 ms warm-up
  spike attaches to a fresh module's FIRST step, not to enablement) —
  `npm run probe:timing` re-verifies all of this and exits 1 on drift;
  (6) `profilerEnabled` does not change the digest (semantic
  non-interference — cost is measured separately, never inferred).
- **The cost baseline (`npm run bench:physics`, reference machine:
  i7-14650HX, Windows 11, Node v22.19.0, 2026-07-11, 5 paired samples —
  machine-specific, never a package property; full table in
  `docs/bench-physics-reference-2026-07-11.md`):** measured on a REAL
  composite corridor (a benchmark-owned PRINCIPAL_TERRAIN, not the flat
  fixture terrain) with PAIRED interleaved sampling (arms back-to-back,
  order alternated, median of per-pair ratios). The deterministic
  flavor's stepping tax is a consistent **≈1.0–1.13×** on BOTH composite
  (0.98–1.13×) and flat (1.00–1.10×) terrain — the paired method removed
  the earlier unpaired run's spurious "faster on flat" (0.77–0.87×)
  artifact, so the honest tax is small and uniform. Digest instrument
  overhead **1.05–1.07×** (tight); profiler overhead ~0.98–1.03×
  (within noise). Max-topology cost, flat vs composite distinguished
  (fixture C): at 50 vehicles ≈20.8 ms/step composite vs ≈29.2 ms flat;
  at 100 vehicles ≈80 vs ≈92 ms — the flat number is HIGHER because a
  fully-active fleet (driving, continuous contacts all 600 steps) is the
  true worst case, so structural cost dominates terrain complexity. The
  50-vehicle/60-FPS goal (16.7 ms/step) is met by ordinary A/B fixtures
  (≈3.0–3.7 ms at 50 vehicles) but NOT by 50 max-topology vehicles on
  either terrain — an input to worker sharding and population
  composition, recorded not remediated. Physics cost only (explicit
  render-budget caveat; this PR does not benchmark rendering).
- **All-flavors f32 finding:** every one of fixture A's 39,065 traced
  floats is exactly f32-representable (`Math.fround(v) === v`) — the
  engine's exposed state is f32-backed; the trace keeps lossless f64
  encoding regardless (pre-ruled: if the tooth ever fails, keep f64 and
  record the fields).

**The per-wheel surface-speed drive PR landed — the shared `targetAngvel`
(−10 rad/s) option is replaced by per-wheel `targetWheelSurfaceSpeed`
(default 5 m/s): each driven wheel derives its OWN no-load target
ω_i = −targetWheelSurfaceSpeed/radius_i and gain_i = driveTorque_i·(1/|ω_i|),
so unequal radii agree on contact-surface speed instead of fighting a
phantom driveshaft. What is preserved EXACTLY is the [V10] stall-torque
contract (stall magnitude = driveTorque_i verbatim) and the global
stall-torque budget split — NOT mechanical power (at a common surface speed
smaller wheels run larger ω, so equal stall torques imply different peak
powers). No genotype/IR version change. "Surface speed" is the wheel's
no-load CIRCUMFERENTIAL speed (rolling-without-slip); actual vehicle speed
differs under slip, terrain, suspension motion, collisions, and solver
behavior:**
- **The law + rename (`src/sim/physics/adapter.js`):** the pure
  `driveMotorForWheel(targetWheelSurfaceSpeed, wheel)` derives {ω, gain}
  (the reciprocal-MULTIPLY shape is load-bearing — at the r 0.5 identity
  corner it reproduces the legacy gain bits for every torque; a divide does
  not). `validateVehicleIR` builds a per-wheel `motorPlan` Map (ω checked
  before gain — a huge speed overflows ω while the gain collapses to 0; a
  denormal speed overflows the gain); the one shared S0/S1 config site does
  `configureMotorVelocity(plan.omega, plan.gain)`. `MOTOR_TARGET_WHEEL_SURFACE_SPEED
  = 5` (= the legacy 10 rad/s × the canonical 0.5 m wheel, confirmed by the
  preflight matrix). Migration tombstones at BOTH public seams (the adapter
  and the evaluation runner) reject the removed `targetAngvel` with the
  rename diagnosis. Public surface renamed through realizeVehicle/
  realizeS0Vehicle, the runner (`VEHICLE_KEYS`), the fixtures, and the dev
  scene.
- **Behavioral witnesses** (`tests/surface-speed-drive.test.js`, both
  flavors, seed 20260720, declared mixed r 0.3/0.6): airborne per-wheel spin
  through the shipped realizer — each wheel to ITS OWN −5/r (chassis held;
  a free assembly tumbles under the reaction torque), targets differ 2.02×,
  |ω·r| = 5 for both, sign flips under −5; grounded per-wheel law
  (dx +37.7, cruise 4.24 m/s, every wheel under its own target) vs the EXACT
  old shared-ω law on the identical twin (dx +30.2: small wheels dragged PAST
  −10 — motor braking — while big wheels lag at −5.6, the fight signature);
  a small-radius/high-speed stability corner (ω −25, r 0.3 at 7.5 m/s).
  s0-drive reproduces its numbers unchanged (r ≈ 0.5 → f32 −10); s1-drive
  pins its legacy operating points (3 m/s at r 0.3, 4.2 at r 0.42, both
  → exactly −10) and re-measures the mixed-radius ledger case — separating a
  law-invariant GRADE stall (stands) from the shared-target CONFLICT (closed,
  witnessed on flat ground: old-law cruise 4.43 m/s vs new 4.89 m/s).
- **Deliberate golden re-lock** (cause: intended physics-semantic change;
  Node + pinned Chromium agreed on every digest and checkpoint state on the
  first run): A `5a219735` REPRODUCED (its wheels decode to r
  0.49999999999999994 → ω −10.000000000000002, 1 f64 ulp off −10, below the
  engine's f32 state resolution) — only its fixtureVersion bumped 1→2;
  B `65f9e2fd → 02a80181`, C `bc71517b → 6b83729e`, both first-diverging at
  step 1 with step 0 (spawn placement) identical. **Fixture D**
  (`eval-d-mixed-radius-flat`, seed 20260719, digest `e2fc7625`) is the
  first LOCKED fixture with genuinely mixed radii (0.3/0.6 m, ω −16.667/
  −8.333, gains 3.75/7.5 from equal 62.5 N·m stall torques) — A/B/C are all
  uniform-radius and only prove ONE target per vehicle; D puts the per-wheel
  law inside the Node/Chromium determinism gate. The bench deliberately
  stays A/B/C (D adds a semantic path, not a cost class; smoke green).
- **Deferred idea (recorded, out of scope):** evolvable per-genotype
  surface speed — a gene — is a GA-era experiment; the target stays a
  realizer option + policy constant, never IR or a gene, per this ruling.
- Full suite green both flavors; the noise/terrain/boulder-hull/`24cd0dd5`/
  `39bcd6c4` fingerprints byte-identical; dev scene now drives ~56 m of the
  composite corridor (was ~53 m — the r 0.4 wheels' no-load surface speed
  rose 4→5 m/s).

**GA Phase 1A landed — Deterministic Population and Fitness Foundation
(the scientific instrument the GA will trust; NO selection/mutation). Roadmap
naming adopted: GA Phase 1 — Headless Deterministic Evolution, with peer
stages Phase 1A (this PR) and Phase 1B — Mutation-Only Evolution; Phase 1C
extended operators only if evidence supports (never promised as crossover):**
- **Max-progress metrics on `runEvaluation` (`src/sim/evaluation.js`):**
  per-vehicle `maxForwardDistance` / `stepAtMaxForwardDistance` /
  `maxBackwardDistance`, folded in `captureStep` from the SAME chassis read
  the latch and trace consume (`createProgressState`/`foldProgress`, exported
  pure). Strict `>` keeps the earliest tie; capture 0 baselines both at
  exactly 0 (reverse-only ⇒ 0); latch/finite-guarded. **Result fields only —
  zero trace-byte change; A–D golden digests
  (`5a219735`/`02a80181`/`6b83729e`/`e2fc7625`) byte-identical, NO re-lock.**
- **Canonical population content (`src/sim/population.js`,
  `POPULATION_SNAPSHOT_VERSION 1`):** individualId is explicit uint32 identity
  (never array position); seams accept any order, canonicalize by sorting a
  copy; only repair-IDENTICAL genotypes are storable (raw draws as heredity
  fail loud); snapshot encoding = version + genotype-version + count + per
  individual (id-ascending) id/length/`serializeGenotype` bytes.
- **Live initializer (`src/sim/population-initializer.js`,
  `POPULATION_INITIALIZER_VERSION 1`)** — SEPARATE from the locked
  `randomGenotype` (`24cd0dd5` untouched). `new Rng(seed).fork(individualId)`
  per member (order/size-independent), a documented 36+17n draw table:
  symmetry prior 0.8 (two-draw half-band split), CATEGORICAL S0/S1 suspType
  (`(catIndex+v)/3` ⇒ S2 unreachable by construction), ≥1 axle, ≥1 driven
  wheel by construction (forced-axle remap + the buildIR equal-split
  fallback), `minInitialPowerGene 0` (full range — a nonzero prior only lands
  deliberately/measured/version-bumped). Provenance is a SEPARATE manifest
  (`serializePopulationInitialization`); diagnostics (`wasRepaired`,
  keepRaw-gated `rawGenotype`) never serialize.
- **Deterministic evaluator (`src/sim/population-evaluation.js`):** fitness =
  `maxForwardDistance` iff finite ∧ bodies ∧ joints valid, else 0
  (`FITNESS_POLICY_VERSION 1`; no drift/mass/efficiency/complexity/
  normalization terms). `spawnPoseOnFlatStart` (pure; the fixture
  coherence-tooth formula, sled AABB fallback). Self-contained
  `serializeEvaluationSpec` (`EVALUATION_SPEC_VERSION 1`) binds EVERY resolved
  terrain knob (declared walk asserted set-equal to `TERRAIN_DEFAULTS`) +
  flavor/maxSteps/spawn/target/wheelFriction/termination — never leans on a
  fixture version. `serializeFitnessVector` (`FITNESS_VECTOR_VERSION 1`) binds
  the SNAPSHOT digest + spec digest, then id/validity-byte/exact-f64 fitness.
  `championFromEvaluation` = argmax, exact tie → lowest id.
- **THE COHORT-INVARIANCE RULING (measured, the centerpiece):**
  `POPULATION_WORLD_MODE = 'isolatedWorlds'` — one world per individual.
  Shared-world ghost evaluation is NOT invariant under cohort composition on
  0.19.3 deterministic: a zero-axle sled diverges at the f64 bit level (from
  its initial contact solve; ~1e-4 m by step ~100) depending on which OTHER
  vehicles share its world, with NO contact / NO proximity / NO monotone-rule
  dependence needed. Every WHEELED member and the fixture-A identical-ghost
  lock stayed bit-identical — rounding coincidences, not an engine contract.
  The divergence is RECORDED (report + headers), never enshrined as a
  must-still-diverge assertion; a shared-world recheck probe ships in
  `probe:population --pass recheck` for engine-upgrade re-runs. Result: an
  individual's exact result depends only on its own genotype + declared spec.
- **Committed contract (`population-a-initial-composite` v1, seeds 20260721
  population / 20260722 terrain):** 20 individuals, composite terrain,
  isolated worlds, 300 steps. Locks (`src/sim/population-locks.js`, literals
  only): snapshot `cae92db7`, initialization `7acb271d`, spec `1bc14aba`,
  fitness-vector `bded0d30`, 20 exact per-member f64 fitness literals,
  champion id 10 (12.484905242919922, genotype `51370bfa`), champion solo
  trace `f5c5f0c7`. Node 3-OS (`cohort-determinism` + `population-determinism`
  appended to `test:determinism`) + pinned Chromium agree — Chromium on the
  FIRST run.
- **Seeds allocated:** 20260721 population · 20260722 pop-lock terrain ·
  20260723 cohort-gate terrain · 20260724 rollback-witness terrain ·
  20260725/28/29 characterization masters · 20260726 pure property sample ·
  20260727 characterization viability terrain.
- **Characterization findings (`docs/ga-phase-1a-population-fitness-report-
  2026-07-12.md`, `npm run probe:population`):** repair is NEARLY UNIVERSAL
  (99.5% of raw draws changed — the repaired-ownership ruling is the common
  path); ZERO canonical collapse (1000 raw → 1000 canonical); and **the
  load-bearing Phase-1B finding — the raw `maxForwardDistance` metric has a
  finite-physics-EXPLOSION tail on rough terrain**: a minority of individuals
  hit terrain features and are catapulted to enormous but FINITE displacement
  (8.17e6 m at 1.43e8 m/s, `valid` true — the non-finite latch never fires),
  which would dominate selection. Median viability is sane (~2–3 m). The
  COMMITTED fixture (terrain 20260722) is unaffected (max 12.48 m).
- Full suite green both flavors; noise/terrain/boulder-hull/`24cd0dd5`/
  `39bcd6c4` and A–D fingerprints byte-identical; `GENOTYPE_VERSION`,
  `ASSEMBLY_IR_VERSION`, `EVALUATION_TRACE_VERSION` unchanged.

Next — **GA Phase 1B: Mutation-Only Evolution** (the peer milestone that
delivers the evolutionary process: selection, elitism, deterministic
mutation, generational replacement, champion history — a generational loop
over `evaluatePopulation`, sim-time pure). Build it on the Phase-1A trusted
contracts: `createInitialPopulation`, the snapshot/initialization/spec/
fitness-vector encodings, `evaluatePopulation` (isolatedWorlds, id-keyed),
`championFromEvaluation`, and the max-progress result fields. **DECIDE FIRST
(with a probe, before building selection): the physics-explosion-tail policy**
— the raw `maxForwardDistance` metric rewards finite solver blow-ups on rough
terrain (report §9.1); a plausibility validity bound, a finite fitness cap, or
rank/tournament selection robust to magnitude outliers are candidates.
Empirical guidance: initial viability is real but modest (median ~2–3 m);
repair is near-universal (perturb genes freely, rely on repair); no category
is starved (parametric mutation first, structural second); start parametric
rates moderately aggressive (repair damps them), structural rates
conservative (spec §3.1.3). **Deferred (unchanged):** Phase 1C extended
operators (evidence-driven, NOT promised as crossover); worker sharding with
the 1-vs-4-workers equality test (the ghost-isolation lock is its
precondition, in place — note isolated-world population evaluation is
trivially shard-invariant); full replay closure; zone material response
(`zoneAt` pure, fixture B carries the grid through the gate); S2 trailing
arms; an evolvable per-genotype surface-speed gene; the solver-pump /
residual-overlap rulings. Open ruling question carried from PR #10 review:
are visually-overlapping wheels acceptable for evolution? Physics ignores
them (collision-inert, stable, no detach), but they read as one thick wheel
on screen.
