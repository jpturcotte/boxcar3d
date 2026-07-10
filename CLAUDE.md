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
  support samples), `assembly.js` (the genome contract: genotype schema +
  compiler + repair v0), `physics/adapter.js` (the only Rapier seam:
  realization, seating, collision groups, chassis), later: GA operators.
  Must run headless in Node (tests and CI depend on it).
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
  both flavors, policy readback + negative teeth).

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
behavior change for in-domain project inputs (all seven locked fingerprints
byte-identical); garbage and newly ruled-out inputs now fail loud:**
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
  locks the propagate path via `/octaves/`).
- ESLint sim block bans `Date` alongside `performance` (hard rule 2 /
  red-team F3); no sim file used it — teeth verified by stdin probe.
- Dev-scene debris carries the dual-CCD policy (hard CCD alone is
  heightfield-inert per the PR #9 finding; a 12 m drop into the deepest
  crater reaches the ~23 m/s tunneling threshold).
- Assembly options guards locked against ±Infinity; comment-only f32-ulp
  precision note on the corpus clearance teeth.
- [V2]/[V4] recorded in phase0-refresh's verification queue ([V4] = signature
  resolved; parameter ranges still bind at S1).

Next (details in phase0-refresh §6 + spec §7) — **narrowed by maintainer
ruling, July 2026, which supersedes the older single-PR S0→S1→S2 plan:**
1. **The S0 kernel ONLY** (spec §3.2): one dynamic cylinder body per IR
   wheel; one chassis-to-wheel revolute joint per wheel on the lateral axis;
   `WHEEL_GROUPS` + dual CCD (`setCcdEnabled(true)` AND
   `setSoftCcdPrediction(SOFT_CCD_PREDICTION)`) on every wheel body; driven
   wheels via `configureMotorVelocity` with the IR's precomputed
   `driveTorque` as the factor; REALIZATION-TIME pre-world validation
   rejects any axle whose `suspension.type !== 'S0'` — S1/S2 modules must
   never silently realize as rigid axles. (Rejection lives in the wheel
   realizer, NEVER in repair/compile: `SUSPENSION_TYPES` stays
   `['S0','S1','S2']`, and the 24cd0dd5 corpus lock plus the
   every-suspension-type corpus assertion require S1/S2 to stay legal as IR
   data.) Transactional cleanup — a failed realization removes every joint
   and body it created, world counts unchanged. Both Rapier flavors tested,
   plus a driven-vs-undriven forward-drive witness on a DECLARED witness
   terrain with a raised `startFlatLength`. **Measured fact:** at the locked
   seed and defaults the pad is exactly flat for only `startFlatLength = 4`
   m (`heightAtLocal` spans exactly 0 over the first 4 m at seed 20260708),
   then the 6 m blend — too short a runway for a drive-distance witness; a
   witness terrain with its own declared seed and a longer flat pad touches
   NO locked default-config fingerprint. **Verified Rapier 0.19.3 facts for
   that session** (checked against the installed rapier3d-compat typings):
   `ColliderDesc.cylinder(halfHeight, radius)` — the cylinder axis is LOCAL
   Y and halfHeight is a HALF-height, so IR wheel width w maps to w/2; the
   Y→lateral-Z wheel rotation is the +90°-about-X quaternion
   `(Math.sqrt(0.5), 0, 0, Math.sqrt(0.5))` — expressible under the sim trig
   ban; `JointData.revolute(anchor1, anchor2, axis)` takes body-LOCAL
   anchors and axis — prefer UNROTATED wheel bodies with the rotation
   applied to the collider only, so axis `(0, 0, 1)` means the same thing in
   both bodies' local frames; `configureMotorVelocity(targetVel, factor)`
   exists AND `configureMotorModel(model)` exists — the MotorModel choice
   (AccelerationBased vs ForceBased) decides whether `driveTorque` acts as a
   true torque limit: a MANDATORY pre-code question for the S0 PR, with a
   teeth test (same vehicle, doubled chassis mass, same driveTorque, expect
   lower acceleration); `configureMotorPosition(targetPos, stiffness,
   damping)` and `setLimits(min, max)` exist verbatim — [V4] signature
   resolved (recorded in phase0-refresh), for the S1 PR.
2. **Explicitly deferred — NOT in the S0 kernel:** zone material response
   (its own later PR; `zoneAt(x, z, terrain)` is ready), the
   suspension-parameter-range re-lock (binds to `configureMotorPosition` in
   the S1 PR), the S1/S2 suspension modules themselves, GA operators (spec
   §3.3: module-exchange crossover, structural vs parametric mutation) + the
   population seeder (symmetry default-on bias lives there), worker sharding
   with the 1-vs-4-workers equality test, and the full replay-determinism
   criterion. Still owed from PR #10's review: revisit whether
   visually-overlapping wheels (the repair cap's accepted residual) are
   acceptable for evolution even though physics ignores them.
