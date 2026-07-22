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
- `npm run test:determinism` — the five-file deterministic-contract gate CI's
  3-OS matrix runs: the two evaluation golden/fresh-module files plus
  `cohort-determinism`, `population-determinism`, and the pure operator suite
- `npm run test:browser` — the Chromium gate (vitest browser mode + pinned
  playwright; one-time local setup: `npx playwright install chromium`)
- `npm run bench:physics` — the physics cost matrix (an INSTRUMENT, results
  pasted into PRs — never a CI threshold; `-- --smoke` for a quick pass)
- `npm run probe:timing` — the retained Rapier timing/timestep-semantics
  probe (exits 1 on engine-semantics DRIFT; re-run on any Rapier upgrade)
- `npm run probe:physics-explosion` — the finite-explosion forensic
  instrument (witness reproduction, terrain/vehicle/engine ablations, the
  zero-gravity `load`-taxonomy matrix with vehicle-vs-static contact
  counting, contact localization, the minimal reproducer + its closure
  matrix, the complete-population prevalence scan; HARD checks are
  identity-class only — physics magnitudes are observations; `-- --smoke`
  for a light pass, `-- --witness all --pass all` for the full matrix,
  `-- --pass reproducer` is the engine-upgrade recheck)
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
  compiler + repair v0 + the S1 hub policy + the authoritative serializer, its
  validated schema WALK, and the genotype decoder), `physics/adapter.js` (the only
  Rapier seam: realization, seating, collision groups, chassis, the S0
  wheel/joint/motor kernel, and the S1 prismatic/hub suspension behind
  `realizeVehicle`'s explicit dispatch), `fnv1a.js` (the extracted house lock
  hash — streaming state-passing fold), `bytes.js` (the shared strict
  little-endian byte READER — bounds-checked, subarray-safe, trailing-byte
  refusing, errors routed through the calling module's fail idiom — plus
  `bytesToHex`/`hexToBytes`, the canonical-lowercase JSON-safe byte
  representation; bytes are the identity, JSON is only an envelope),
  `trace.js` (the versioned per-step
  trace: 128-byte records, TraceWriter, checkpoint + divergence diagnostics),
  `evaluation.js` (the ONE canonical headless runner — `runEvaluation` — plus
  `runRealizedEvaluationLoop`, the extracted simulate/capture/collect loop it
  composes verbatim: the physics-integrity investigation seam with explicit
  `requestedDt` and a read-only per-step `inspect` hook the production path
  never passes), `trace-forensics.js` (pure offline full-trace analysis:
  per-body kinematic series + the alert/catastrophic/causal-candidate onset
  split; thresholds are DIAGNOSTIC options, consumed by no lock and no
  fitness path),
  `evaluation-fixtures.js` (declared fixtures A/B/C + `evaluationOptionsFor`),
  `evaluation-locks.js` (golden digests + per-step checkpoint states; literals
  only), `population.js` (canonical population CONTENT + snapshot encoding),
  `population-initializer.js` (the live seed→generation-0 policy: draw table,
  symmetry prior, S0/S1 mask, driven-by-construction, + the provenance
  manifest), `population-evaluation.js` (the deterministic per-individual
  evaluator on ISOLATED worlds: fitness policy, spawn placement, evaluation-
  spec + fitness-vector encodings, champion selection, selection-pool capture),
  `population-fixtures.js` + `population-locks.js` (the committed population/
  fitness contract, literals only), `evolution-operators.js` (the pure Phase 1B
  tournament, elitism, and continuous-mutation operators),
  `evolution-contract.js` (the PR 3 leaf every evolution module binds: the
  stable error taxonomy + `EvolutionError`, the terminal enum in wire order,
  engine/policy versions, the v1 caps, checked arithmetic — no imports of its
  own), `evolution-lineage.js` (canonical lineage v1 + cross-generation
  agreement), `evolution-history.js` (the fixed byte-only history codec, the
  seven domain-separated SHA-256 formulas, the evaluation-metadata component,
  and the byte ceilings), `evolution-replay.js` (private ordered verification,
  the runtime/freshness gates, first-divergence reporting),
  `evolution-run.js` (THE deep module: the opaque run and the one private
  generation transition that `advance()` and replay share),
  `evolution-fixtures.js` + `evolution-locks.js` (the committed evolution
  identity contract, literals only).
- `src/platform/` — the ONE documented exception to the D7 ambient-global ban:
  `sha256.js`, the WebCrypto adapter behind persisted artifact identity. It is
  inside the byte-family lint scope and every derived ownership inventory; it is
  outside the determinism block because SHA-256 is a pure function of its bytes
  and affects artifact identity, never simulation state or randomness.
  Must run headless in Node (tests and CI depend on it).
- `scripts/` — Node-only instruments OUTSIDE the sim ESLint ban (wall clock
  allowed): `probe-rapier-timing.js`, `bench-physics.js`,
  `characterize-population.js`, `probe-physics-explosion.js` (the
  finite-explosion forensic instrument), `explosion-witnesses.js` (the
  frozen witness identities + the materialized minimal reproducer —
  investigation fixtures, not a production contract).
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
  `evolution-operators.test.js` (the pure selection/elitism/mutation contract —
  `test:determinism`),
  `population-probe-schema.test.js` (the characterization instrument's only
  CI touchpoint), `bench-schema.test.js` (the bench's only CI touchpoint),
  `explosion-witnesses.test.js` (witness + reproducer identity locks —
  digests, initializer cross-check, passive-twin recipe; NEVER a
  must-explode assertion), `trace-forensics.test.js` (pure codec-fed onset/
  peak/backward-scan contract), `evaluation-core.test.js` (the shared-loop
  seam: byte-exact composition equivalence + observational non-interference
  of a real contact-querying inspect, deterministic flavor),
  `physics-explosion-probe-schema.test.js` (the explosion probe's only CI
  touchpoint — structure + hard identity checks, no physics magnitudes),
  `compare-spike-runs.test.js` (the spike adjudicator's committed contract:
  classify/invariants/timing/compare over pure JSON fixtures with verbatim
  determinism-test titles/messages, bound to the committed expected-red
  inventory — no physics, no Rapier),
  `genotype-schema.test.js` (the schema-walk drift triangle: copy-declared
  literal walk, stride/tiling derivation, perturb-one-leaf byte exclusivity
  against the real serializer, classification teeth anchored to a COPY-DECLARED
  `EXPECTED_DISCRETE_GENE_KEYS` literal — never to the production constant,
  which production classifies BY, so deriving expectations from it would let a
  reclassification move both sides together and stay green; proven by mutation
  (deleting `suspType` from the constant reddens 6 tests) — and the
  path-multiset cross-check against probe-integrity's independent walk,
  partitioned by that same literal),
  `genotype-codec.test.js` + `population-codec.test.js` +
  `evaluation-codec.test.js` (the five decoders: round trips both
  directions, the locked-corpus inversion, the self-contained-history proof,
  the committed fitness vector reconstructed without physics, and every
  malformed-stream rejection), `bytes.test.js` (the reader + hex codec),
  and `tests/browser/evaluation-determinism.test.js` +
  `tests/browser/population-determinism.test.js` +
  `tests/browser/codec-smoke.test.js` (the Chromium gates, own
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
  (`(catIndex+v)/3` ⇒ S2 unreachable by construction), ≥1 axle, ≥1
  DRIVE-ENABLED wheel by construction (forced-axle remap + the buildIR
  equal-split fallback; driveTorque > 0 whenever the power gene > 0 — the
  2⁻³² exact-zero-power corner is a legal zero-torque phenotype),
  `minInitialPowerGene 0` (full range — a nonzero prior only lands
  deliberately/measured/version-bumped). Provenance is a SEPARATE manifest
  (`serializePopulationInitialization`); diagnostics (`wasRepaired`,
  keepRaw-gated `rawGenotype`) never serialize.
- **Deterministic evaluator (`src/sim/population-evaluation.js`):** fitness =
  `maxForwardDistance` iff finite ∧ bodies ∧ joints valid, else 0
  (`FITNESS_POLICY_VERSION 1`; no drift/mass/efficiency/complexity/
  normalization terms). This is a **reproducible baseline SCORE contract, NOT
  a selection-ready fitness policy** for rough composite terrain (the
  explosion tail below) — Phase 1B produces a policy v2 or constrains its
  terrain before selection. The evaluator OWNS its inputs: it captures the
  snapshot bytes synchronously before the first hook/await (a hook mutating a
  post-compile genotype cannot re-attest the vector) and deep-copies +
  deep-freezes the resolved terrain (`ownTerrain` — a hook cannot change what
  a later individual runs on). `spawnPoseOnFlatStart` (pure; the fixture
  coherence-tooth formula, sled AABB fallback). Self-contained
  `serializeEvaluationSpec` (`EVALUATION_SPEC_VERSION 1`) binds EVERY resolved
  terrain knob (declared walk asserted set-equal to `TERRAIN_DEFAULTS`) +
  flavor/maxSteps/spawn/target/wheelFriction/termination — never leans on a
  fixture version; every f64 write and the u32 maxSteps are canonical-value
  gated (NaN/Inf/overflow rejected at the seam). `serializeFitnessVector`
  (`FITNESS_VECTOR_VERSION 1`) binds the SNAPSHOT digest + spec digest, then
  id/validity-byte/exact-f64 fitness (non-finite/negative rejected; invalid ⇒
  fitness 0 enforced). `championFromEvaluation` = total order: greater fitness
  → VALID over invalid on a tie → lowest id.
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
  **[MECHANISM SUPERSEDED — the physics-integrity PR: the tail is NOT a
  terrain-feature interaction (onset is identical on fully flat ground,
  before any feature contact) but Rapier 0.19.3 constraint-solver
  divergence on ill-conditioned multi-module joint islands under the
  current legal realization; the >200 m label undercounts (5/60 affected,
  2 hidden behind ordinary-looking fitness). The finite-tail EXISTENCE
  finding and every committed lock stand; see that PR's block below.]**
- Full suite green both flavors; noise/terrain/boulder-hull/`24cd0dd5`/
  `39bcd6c4` and A–D fingerprints byte-identical; `GENOTYPE_VERSION`,
  `ASSEMBLY_IR_VERSION`, `EVALUATION_TRACE_VERSION` unchanged.

**Physics Integrity: Finite-Explosion Reproduction and Ablation landed —
the corrective investigation between Phase 1A and Phase 1B (NOT a roadmap
stage). Verdict: the Phase-1A explosion tail is Rapier 0.19.3
constraint-solver DIVERGENCE under BoxCar3D's current legal multi-module
joint realization — not a terrain interaction; no incorrect spawn, terrain,
motor, CCD, or initial-joint setup was found. The realization ARCHITECTURE
itself (one impulse joint per station on long off-center chassis anchors)
is NOT exonerated as a possibly-mitigable design — an alternative
better-conditioned representation preserving the phenotype is an open
direction, not a defect. Full evidence:
`docs/physics-integrity-finite-explosion-report-2026-07-13.md`:**
- **The mechanism (measured, both flavors):** onset occurs on the
  exactly-flat start pad during settle (all four witnesses; onset unchanged
  across the four terrain-CONTENT variants, and on fully flat ground shifts
  only for the marginal witness S — alert 43→37 — with B/C/S leading body
  flipping between the hub and its coaxial wheel of the same station; A/B/C
  alert steps identical everywhere; all four still diverge on flat, the
  load-bearing point);
  contacts at onset are ordinary floor contacts (all partners the floor,
  zero wedges at onset, no birth penetration; penetrations grow from settle
  scale ~1e-3 m to ~6e-2 m and impulses to ~570 N·s through the window as
  the divergence builds — captures 0/1 are
  contact-free, spawn clearances +0.02 m); the earliest measurable event is
  JOINT-CONSTRAINT VIOLATION, directly measured for BOTH joint types —
  revolute anchor separation (witness A's leading S0 station > 2 cm at step
  6 vs kinematic alert at 20) AND the prismatic decomposition (off-axis
  error > 2 cm at steps 9/15/19/24 for A/B/C/S, coordinates blowing through
  the [0, travel] limits by orders of magnitude) — the solver leaves
  constraints violated under ordinary load and its corrections pump energy.
  MORE solver iterations ACCELERATE the divergence (A at 16 iters:
  catastrophic by step 16); dt 1/120 worsens witness B to 1.66e21 m/s; no
  TESTED exposed engine setting cured it (the committed `gravity9.81`
  reproducer arm gives the same cat@46 as g=20 — the g=20 magnitude is not
  the cause; CCD inert). Drive is NOT necessary — every drive-removed arm
  still reaches catastrophic (>1000 m/s), though the peak MAGNITUDE varies by
  witness (A ~8.8e9, B ~6.4e3), so drive is not the energy source; motor
  torque can EXCITE the island. Single modules and sleds are ALL stable (≥ 2
  modules required). **The trigger is SOME ordinary load, not ground contact
  per se — the committed `load` pass runs the crossing in GENUINELY free
  space (NO floor/corridor at all, staticColliders 0 hard-checked, zero
  gravity). Two conclusions are CLEAN (single-variable): the fully unloaded
  all-S0 island is quiescent on all four (peak 0); and MOTOR load alone
  initiates the divergence with no contact — drivenAllS0 vs the quiescent
  passiveAllS0 differ only in drive, catastrophic on A/B/C and alert-only on
  S (782 m/s). An undriven S1 realization also diverges without contact, but
  that arm changes the S1 topology (hub bodies/mass, prismatics, chain) as
  well as the spring, so it does NOT isolate "springs alone" — a
  phenotype-preserving spring-off arm is the deferred isolator. No PARTICULAR
  load is necessary; floor contact is the observed initiating load in
  evaluation context. Track-width and mass-ratio necessity are established
  only in the minimal-reproducer closure (narrowTrack/heavyChassis arms), not
  every witness reduction — not asserted as a universal theorem.**
- **Witness identities frozen** (`scripts/explosion-witnesses.js` +
  `tests/explosion-witnesses.test.js`): A 20260725:19 `ec8d42cf`,
  B 20260728:4 `393f7e0e`, C 20260729:19 `57faad4e`, S 20260725:14
  `565f8c72` (+ passive-twin digests), reconstruction proven byte-identical
  to the createInitialPopulation members. Prevalence (the committed
  `prevalence` pass — every characterization individual forensically
  classified): **5/60** catastrophic (>1000 m/s internal speeds) — the
  report's >200 m label caught only 3; two (incl. 20260725 id 1, fitness
  14.02 m) hide blow-ups behind ordinary-looking forward progress. Id 1 was
  the probe's own first fitness-selected calibration control — its
  contamination is a recorded finding, and the committed control procedure
  now substitutes contaminated candidates deterministically.
- **Minimum reproducer (MATERIALIZED literal, digest `9fde1f1c`):** two
  wide-track paired S0 axles (wheel centers z ≈ ±2.3/±1.9 m), four UNDRIVEN
  9.1–21.3 kg wheels (the re-repaired masses), one 18 kg chassis, no motors,
  FLAT ground →
  catastrophic by step ~46 on both flavors; removing ANY ingredient (either
  axle, trackHalf ≤ ~0.2, frameDensity 1, or the load itself — the genuinely
  static-free `freeSpace` arm, no floor at all, leaves this undriven island
  quiescent) stabilizes, and the `gravity9.81` arm confirms the g=20
  magnitude is not the cause (same cat@46). The FULL closure matrix is
  instrumented in the probe's `reproducer` pass. RERUN ON RAPIER BUMP:
  `npm run probe:physics-explosion -- --pass reproducer`.
- **Telemetry:** `src/sim/trace-forensics.js` (pure, offline over FULL
  traces): per-body kinematic series + the three-concept onset —
  firstAlertStep (diagnostic locator), firstCatastrophicStep,
  firstCausalCandidateStep (backward scan) — thresholds are DIAGNOSTIC
  options defined at the 1/60 reference capture interval and dt-scaled via
  the declared `captureDt` (echoed with the applied values), consumed by no
  lock and no fitness path. `runRealizedEvaluationLoop` extracted from
  `runEvaluation` (composed verbatim by production; A–D digests
  byte-identical, zero re-locks) with explicit `requestedDt` — which must
  match the engine's f32 readback or the loop fails loud — and a read-only
  `inspect(stepIndex)` hook the production path never passes; equivalence +
  observational non-interference + the honest-dt negative are committed
  contracts (`tests/evaluation-core.test.js`).
- **The instrument:** `npm run probe:physics-explosion` (schema
  `boxcar3d.physics-explosion/1`; passes baseline/terrain/vehicle/engine/
  load/local/reproducer/prevalence; witness selector; pass selection
  normalizes 'all'/comma-lists identically in the CLI and the programmatic
  API, and any single pass reports the real f32 timestep). HARD checks are
  identity-class only (genotype digests, deterministic repeat equality over
  the FULL record streams + checkpoints, f32 dt); every physics magnitude
  is an observation — no committed test asserts the explosion occurs (a
  future engine that converges these islands turns the probe's observations
  quiet, and the ruling gets re-evaluated).
- **No production physics change; zero re-locks; no new seeds.** All
  fingerprints and version constants byte-identical, `FITNESS_POLICY_VERSION`
  stays 1 by mission ruling (no fitness cap/plausibility threshold here).

**The Rapier core-0.34 verification spike in PR #19 reports Outcome B (PR-A) —
a Layer-2 diagnostic, NOT a roadmap stage and NOT a production dependency change.
Verdict OUTCOME B: the current upstream Rapier core (0.34) retains substantially
the same constraint-solver divergence; PR #17's conclusions extend to it. Full
evidence: `docs/rapier-034-spike-2026-07.md`:**
- **The version model (corrected):** the npm pins
  `@dimforge/rapier3d{,-deterministic}-compat@0.19.3` are the LATEST stable JS
  packages (Nov 2025), built on Rust core ~0.30.1 — current, not stale. The JS
  package number (0.19.x) and the Rust core number (0.30+) are separate streams.
  Upstream merged rapier.js into the `dimforge/rapier` monorepo on 2026-07-12
  (commit `c13133ad`); its in-tree TS bindings still self-id as 0.19.3 but build
  against in-repo core **0.34**.
- **The spike (two builds, one verdict):** built both compat flavors from
  source at `c13133ad` (core 0.34.0) with a packaging-only identity patch (crate
  version `0.19.3-c13133ad.0`, so `RAPIER.version()` is distinguishable and the
  staleness teeth fire honestly), consumed them as `npm pack` tarballs, and ran
  the rerun matrix. Tarball + wasm SHA-256s are in the decision record §3. The
  ORIGINAL evidence is a HISTORICAL LOCAL build (Windows, 3D flavors only, on an
  isolated worktree `spike/rapier-034-c13133ad`, never merged; deviations were
  packaging-only — Git Bash for the `.sh` scripts, `gen_src`/rollup trimmed to
  the two 3D flavors; artifacts under
  `C:\Users\jp2k5\GitHub\rapier-034-spike-artifacts\`, build tree disposable).
  The REPRODUCIBLE, artifact-audited arm is the committed `workflow_dispatch`
  experiment (`.github/workflows/rapier-034-spike-experiment.yml`, Part C): it
  builds all six flavors with upstream's packaging scripts UNMODIFIED, on a
  controlled same-commit stable-vs-candidate pair, and preserves JSON + logs +
  a provenance bundle — so its numbers, not the local ones, are the citable
  evidence (wasm is not byte-reproducible across environments; the verdict
  reproduces at classification level).
- **The verdict (measured, both flavors):** the committed minimal reproducer
  (`9fde1f1c`) is STILL catastrophic (~4,785 m/s; onset delayed cat 46→107 but
  classification unchanged); prevalence is **5/60 — the SAME five individuals**,
  both fitness-hidden cases (20260725 ids 1, 14) intact; a fresh seed
  (**20260730**, allocated) adds 2/20, removing the selection confound (7/80).
  On the surfaces that COMPLETE on both arms the candidate is CLEAN: internally
  deterministic (determinism gate (a) byte-identical on A–D), every project
  contract (all 13 class-(a) gates) preserved, NO Class-1/3/4 regression on the
  Node suite/probes, and the PR #18 `world.free()` borrow error did NOT
  reproduce in the Node suite. The 11 unit-suite reds are all expected class-(c)
  golden/version movement. **The citable `heavy=true` CI dispatch (run
  29447984460, C5) landed and CONFIRMED this** — candidate Chromium GREEN
  (Node↔Chromium `population:fitness-vector` = `ee605286` on both), Vite build +
  app-scene smoke GREEN, paired bench GREEN — **and it surfaced a NEW finding
  that REINFORCES Outcome B: core 0.34 CANNOT complete the full forensic witness
  matrix (`--witness all --pass all`) — it crashes it UNRECOVERABLY** (a
  wasm-bindgen borrow-guard panic at `world.free()`, and once that is caught, a
  `RuntimeError: unreachable` trap at `world.step()`), while stable 0.19.3
  completes the identical matrix cleanly. So the forensic matrix is
  OBSERVE-on-candidate (stable GATE), citability rests on reproducer +
  prevalence (both green on the candidate), and "otherwise clean" is scoped to
  the completing surfaces — NOT absolute (see the decision record §5.4; the
  probe now RECORDS a free() panic via `safeFreeWorld`/`report.freeErrors`
  rather than dying on it).
- **The multibody 2×2 (the representation-vs-solver discriminator, via the new
  `probe:physics-explosion --pass reproducer --arm multibody`):** re-expressing
  the UNDRIVEN reproducer's revolutes as reduced-coordinate multibody joints is
  quiescent on BOTH cores (0.30.1: 1.42 m/s; 0.34: 1.40 m/s) while the impulse
  path is catastrophic on both. The lever is the joint REPRESENTATION /
  constraint-enforcement regime (reduced-coordinate HARD constraints vs
  maximal-coordinate SOFT impulses the solver fails to converge), not the engine
  version — but MEASURED FOR THE UNDRIVEN REPRODUCER ONLY. BUT every multibody
  motor/limit method — `UnitMultibodyJoint` (revolute/prismatic) AND
  `SphericalMultibodyJoint` (inside a `/* Unsupported by this alpha release. */`
  block) — is commented out of the TS bindings on both 0.19.3 and core 0.34
  (verified in `src.ts`), so the motorized S0/S1 phenotype cannot use that path
  today without upstream binding work, and the undriven result does not by
  itself prove a motorized multibody realization would stay quiescent.
- **New instruments (main-side, green on stable 0.19.3, no dependency/lock
  change):** `docs/engine-assertion-taxonomy-2026-07.md` (every committed
  assertion classified (a) project-contract / (b) engine-finding / (c) golden,
  the triage map for any engine swap — reusable, load-bearing for Outcome C
  disambiguation; §10.6 covers this PR's own new assertions); the `--arm
  multibody` reproducer arm (observation-only, hard check is the swap's
  structural premise, never a physics outcome) plus the `--arm`/
  `--prevalence-seeds` CLI options via an extracted `configFromArgs` (the P2
  fix: they were documented but `parseArgs` threw on them — now wired + tested);
  `scripts/probe-rapier-package-smoke.js` (`npm run probe:package-smoke`, the
  pre-suite consumability check — `version()`/dt readback as observations,
  deterministic repeat bit-identical); and the committed `workflow_dispatch`
  experiment (`.github/workflows/rapier-034-spike-experiment.yml`,
  `scripts/compare-spike-runs.js`, `scripts/probe-app-scene-smoke.js`) that
  builds the candidate from source and runs the controlled stable-vs-candidate
  pair with machine-enforced expected-red classification at the ASSERTION
  level: per-red failure-message signatures (each staleness red must fail on
  its committed 'engine changed — re-lock deliberately' message, each golden
  on the checkpoint-divergence formatter — a failure MOVING to an earlier
  project contract inside the same red test fails the arm), POSITIVE
  must-pass presence (the gate-(a)/pure teeth must appear with status
  'passed' at exact multiplicity), the probe:timing DRIFT allowlist, and the
  dt + declared-set Node↔Chromium digest invariants (the declared
  `nodeChromiumRequiredKeys` — currently just `population:fitness-vector`, the
  ONE digest both reporters emit untruncated — with set equality both
  directions, so a Node-only or Chromium-only extraction fails; NOT a broad
  cross-env determinism claim over the A-D/champion traces, which Node
  truncates).
  The adjudicator itself is under ordinary CI:
  `tests/compare-spike-runs.test.js` (pure JSON fixtures with verbatim
  titles/messages, no physics, bound to the committed
  `.github/spike-expected-candidate-reds.json` schema/2 inventory).
  **The two-stage citability gate (`bootstrapComplete`, machine-enforced):**
  the inventory ships `bootstrapComplete: false`, so `compare()` forces
  `citable=false` on EVERY run — the FIRST `heavy=true` dispatch is the
  BOOTSTRAP run (it reproduces Outcome B and exits 0, but is structurally
  non-citable because the browser inventory is not finalized). C5's human
  step commits the browser counts/signatures from that run AND flips the
  flag; only a SECOND heavy run can be citable. The verdict also separates
  "experiment executed" from "Outcome B reproduced" (catastrophic on BOTH
  impulse arms — a candidate that came back quiescent CONTRADICTS and exits
  nonzero), rejects malformed/absent/duplicate/unsupported/wrong-flavor
  reproducer rows as unusable, and enforces the DECLARED heavy coverage
  (`heavyEvidence`: prevalence seeds 20260725/28/29 + fresh 20260730, 20
  individuals each, both arms) rather than a non-empty array. Full suite
  green both flavors on stable; every fingerprint byte-identical.
- **Consequence:** do NOT adopt the source build (no divergence-fix to gain).
  PR-B (numerical-integrity policy) proceeds on stable 0.19.3 as planned; the
  multibody/binding-extension feasibility investigation is the named follow-up
  (can a small upstreamable TS patch expose the revolute/prismatic multibody
  motors + limits the driven phenotype needs?). Re-run
  `probe:physics-explosion -- --pass reproducer` on the next official npm
  release carrying core ≥0.33 — the reproducer stays the engine-upgrade
  tripwire.

**The numerical-integrity policy PR (PR-B) landed — the GA-safety gate that
unblocks Phase 1B: a small, always-on, engine-neutral online detector that
makes Rapier's constraint-solver divergence non-selectable, calibrated on
stable 0.19.3. Full evidence: `docs/numerical-integrity-policy-2026-07.md`:**
- **`src/sim/integrity.js`** (new, pure, under the sim ban — `Math.sqrt` only):
  `INTEGRITY_POLICY_VERSION 1`; frozen production thresholds (copies of the
  forensic alert/catastrophic values, versioned SEPARATELY from the tweakable
  diagnostic defaults — a drift tooth asserts they still agree);
  `createIntegrityState`/`foldIntegrity`/`finalizeIntegrity` — a per-vehicle
  fold over the SAME per-body reads `captureStep` already takes (previous
  linvel/translation in preallocated `Float64Array` scratch, NO per-step
  allocation, no engine query). `norm3`/`dist3` moved here and imported back by
  `trace-forensics.js` so the ONLINE and OFFLINE detectors share one
  arithmetic. Status `'ok'|'nonFinite'|'numericalDivergence'`; **failure bound =
  nonFinite ∨ catastrophic crossing** (|v| > 1000 m/s, or one-capture |Δx| >
  (1000/60)·dtScale, ANY body); the alert band is an OBSERVATION, never a
  failure (escalation is a documented policy-v2 trigger gated by the
  false-negative acceptance test). `captureDt = effectiveDt` (the f32 engine
  readback, the pinned convention — the online fold and `analyzeTrace` apply
  identical dt-scaling, so online≡offline classification is bit-exact,
  witnessed in `tests/integrity.test.js` on the reproducer + a healthy
  fixture, OUTCOME-AGNOSTICALLY).
- **Result-only field** on every production evaluation
  (`src/sim/evaluation.js`): the per-vehicle `integrity` block, observations
  populated on EVERY status. Policy v1 CLASSIFIES but never shortens (still
  exactly maxSteps after a failure — trace shape/executed-steps/timing
  preserved). Always-on: the only off switch is a direct-caller
  `integrity: false` at the `runRealizedEvaluationLoop` seam (the `inspect`
  precedent, for cost/non-interference measurement); `runEvaluation` rejects the
  key. **Zero trace-byte change — the A–D golden digests are byte-identical, no
  re-lock** (the `maxForwardDistance` precedent; determinism gate (a) confirms).
- **Fitness policy v2** (`src/sim/population-evaluation.js`,
  `FITNESS_POLICY_VERSION 1→2`): `selectable = isVehicleResultValid(v) &&
  v.integrity.status === 'ok'`; `fitness = selectable ? maxForwardDistance : 0`.
  `isVehicleResultValid` is UNCHANGED (validity ≠ selectability, deliberately).
  `FITNESS_VECTOR_VERSION 1→2`: header +`integrityPolicyVersion`, per-member
  +`integrityStatus` byte (an integrity-failed non-zero fitness can never
  serialize). New `selectableChampionFromEvaluation` returns the best
  valid∧integrity-clean individual or **null** when none exists — an
  integrity-failed vehicle never becomes champion merely because every fitness
  is 0; `championFromEvaluation` stays as the DIAGNOSTIC best-observed selector
  (reports only). Raw metrics + the full integrity block stay in diagnostics —
  failures observable, never silently zeroed.
- **One deliberate re-lock** (`src/sim/population-locks.js`, cause: intended
  policy/encoding change): `fitnessVectorDigest bded0d30 → a6d04f75`,
  `fitnessPolicyVersion`/`fitnessVectorVersion` 1→2, +`integrityPolicyVersion 1`.
  MEASURED first: the committed fixture is **20/20 integrity-clean**, so every
  per-member fitness literal, the champion (id 10), and the champion trace are
  byte-identical — only the vector bytes moved (new header field + status
  byte). Node 3-OS (`test:determinism`) AND pinned Chromium
  (`test:browser`) reproduce `a6d04f75` — the browser gate agreed first run.
- **`scripts/probe-integrity.js`** (`npm run probe:integrity`, schema
  `boxcar3d.probe-integrity/1`, defaults SMALL) — the characterization
  instrument: **signals** (the known-subject panel — 4 witnesses + reproducer +
  3 clean controls + fixtures A–D, each with online≡offline agreement
  HARD-checked), **population** (the committed 60, production path, with the
  false-negative "alert-but-ok" watch list), **neighborhood** (deterministic
  gene-jitter around 3 declared parents, seed **20260731** — the Phase-1B
  mutation-neighborhood probe's first data), **cost** (paired interleaved
  on-vs-off at the core-loop seam). One schema-smoke CI touchpoint
  (`tests/integrity-probe-schema.test.js`; structure/identity/agreement only,
  no magnitudes — the regression-asymmetry rule). MEASURED: all 5 known-affected
  subjects (incl. witness S, 3.63 m of ordinary-looking distance hiding a
  1070 m/s blow-up) → unselectable, fitness 0; all controls/fixtures ok at
  180–600× margin below failure; 5/60 prevalence; **no false-positive halo**
  (0/32 clean-parent children fail) and the alert-but-ok watch list EMPTY across
  all 60 individuals + 48 neighborhood children; cost within noise.
- Full suite green both flavors (41 files, 652 tests); every terrain/assembly
  fingerprint and the A–D evaluation golden digests byte-identical;
  `GENOTYPE_VERSION`/`ASSEMBLY_IR_VERSION`/`EVALUATION_TRACE_VERSION`/snapshot/
  initializer/spec versions unchanged.
- **Review follow-up (2026-07-16, on-branch; no lock movement, `a6d04f75`
  stands):** (1) `requireIntegrity` now runs BEFORE the validity
  short-circuit — an INVALID result with missing/null/malformed integrity is
  refused LOUD at both policy entry points, never a silent 0 (regression
  suite committed; `isVehicleResultValid` unchanged). (2) The online≡offline
  agreement contract is the FULL derivable classification: `analyzeTrace`
  records per-body per-reason first steps and the shared
  `offlineIntegrityView` derives status/firstFailureStep/ordered-reasons per
  the online scan-order contract; a pure codec-fed suite pins every ordering
  rule (incl. same-step ties) as an arithmetic identity between the two
  detectors. (3) The neighborhood jitter walker preserves the declared
  `DISCRETE_GENE_KEYS` (assembly.js: family/suspType/symmetric/paired/
  driven/nodeCount) — a suspType crossing into the legal-but-unrealizable S2
  band can no longer abort the experiment (S1→S2 boundary regression
  committed; S2 never clamped, just unreachable by parametric jitter).
  (4) **The cross-PR defect closed:** the spike inventory's copied
  `"to be 'bded0d30'"` regex (staled by this PR's re-lock) is replaced by the
  structured marker protocol — `src/sim/lock-markers.js`
  (`FITNESS_VECTOR_LOCK_MISMATCH expected=<lock> actual=<measured>`, the
  custom message on the still-real `.toBe` golden assertion in BOTH
  population determinism gates), adjudicated by `compare-spike-runs.js`
  against `AUTHORITATIVE_FITNESS_VECTOR_DIGESTS` imported LIVE from
  population-locks at adjudication time (inventory schema/3; no mutable
  digest literal in any signature — sync-tooth-enforced;
  `tests/integrity-probe-schema.test.js` joins the expected candidate reds,
  Node totals 11→12; the July 2026 C5 evidence stays historical/untouched).

**Canonical schema + codec foundations landed (Phase-1B prep PR 1) — the
genotype schema walk and lossless decoders for all five canonical byte
encodings. NO evolutionary behavior (no mutation/selection/elitism/evolution
RNG/replacement/lineage/generation stepping/evolution formats or locks/
crossover), ZERO change to any valid canonical stream, ZERO lock movement.
Full contract: `docs/canonical-codec-foundations-2026-07.md`:**
- **Roles, stated once:** `serializeGenotype` stays the canonical
  byte-layout AUTHORITY (unrestructured — hard rule 4, the `24cd0dd5` lock);
  the new `genotypeFieldWalk(axleCount)` / `forEachGenotypeField(genotype,
  visit)` (assembly.js) is a validated METADATA MIRROR. 36 fixed-prefix
  entries + 16 per axle (68 at 2 axles), `{path, key, type, kind, byteOffset,
  byteLength}`; `kind` ∈ version/structural/discrete/continuous, with
  `discrete` single-sourced from `DISCRETE_GENE_KEYS`.
  `tests/genotype-schema.test.js` binds mirror to authority with three legs —
  a copy-declared literal walk, the stride-128/tiling derivation identities,
  and perturb-one-leaf byte EXCLUSIVITY against the real serializer — plus a
  path-MULTISET cross-check against `probe-integrity.js`'s independent
  reflection walk (multiset, not key set: keys repeat across node slots and
  axles). Refactoring serialization onto the walk is a deliberate later PR.
- **Latent genes are PROSE, not metadata (ruling):** node slots past the
  active prefix, `nodes[0].gap`, the two idle `fam` blocks, and the
  symmetry-gated `asym` block are always serialized, never erased by repair,
  and freely perturbable by parametric mutation (heritable neutral
  variation). Encoding expression would create a second semantic contract
  drifting independently of the byte layout and make the walk a function of
  gene VALUES rather than axle count. Expression is a `buildIR` question; if
  a consumer ever needs it, it gets its own derived helper.
- **Five decoders, each beside its encoder:** `deserializeGenotype`
  (assembly.js), `deserializePopulationSnapshot` (population.js),
  `deserializePopulationInitialization` (population-initializer.js),
  `deserializeEvaluationSpec` + `deserializeFitnessVector`
  (population-evaluation.js). Fail-loud, NEVER repairing (truncation,
  trailing bytes, unknown versions, out-of-range enum/flag bytes, lying
  length prefixes, out-of-domain values, contradictory records). Round-trip
  invariants committed both directions: `serialize(deserialize(bytes))`
  byte-identical, `deserialize(serialize(x))` leaf-equal under `Object.is`
  (−0 sign bit and denormals preserved; nothing `Math.fround`-ed).
- **THE VALIDATION-DEPTH RULING — mirror the encoder exactly, no more, no
  less** (this is what makes each decoder a true inverse across its
  encoder's whole output domain): genotype re-runs `validateGenotype`;
  snapshot re-runs `validatePopulation` (incl. the repair-identity
  canonicality tooth — no raw-draw side door) PLUS strict-ascending STREAM
  order (validatePopulation sorts a copy and cannot see stream order; a
  decoder that re-sorted would accept non-canonical bytes and break
  re-encode identity); manifest re-runs `resolveConfig`. The evaluation spec
  is the load-bearing asymmetry: its encoder does NOT run `resolveSpec`, so
  the decoder must not either — `resolveSpec` enforces EXECUTION constraints
  (clearance band, flat-pad guard, non-negative friction) the encoder never
  applies, and calling it would reject encoder-producible bytes. Execution
  validation stays `evaluatePopulation`'s job; a committed positive test
  asserts such streams decode cleanly. Only CURRENT-version streams decode
  (encoders write current constants unconditionally — that ruling is what
  makes re-encode reproduce the bytes).
- **Two ADDITIVE digest-state input paths** (`serializeFitnessVector`,
  `serializePopulationInitialization`): a digest is one-way, so a decoded
  record cannot reconstruct the `spec` / `population` its encoder folds.
  Both encoders now accept EITHER the original object (production path,
  statements verbatim and in original order) OR a pre-computed canonical
  uint32; both present must AGREE, neither fails loud. No existing caller
  passes the new field ⇒ the production branch is bit-for-bit unchanged
  (`a6d04f75` / `7acb271d` stand; the population-determinism gate is the
  tripwire).
- **ONE SOURCE OF TRUTH per variable-length field — and INDICES ARE THE TRUTH
  (the ruling, settled over three review rounds):** every canonical encoder
  reads a variable-length field BY INDEX, the same reading its consumer
  performs. `serializeEvaluationSpec` materializes each terrain range by index
  once and both the size pass and the write pass consume that snapshot.
  Sizing/counting from a declared `.length` while writing by `for...of` let an
  iterable whose cardinality disagreed with its length emit a correctly-SIZED
  but semantically wrong stream (under-yield ⇒ a zero-filled hole shifting
  every later field — the worst failure mode, since the stream looks
  well-formed) or overrun the DataView with a FOREIGN RangeError (over-yield);
  measured both ways. **The class was SYSTEMIC** — a sweep of every encoder
  found it in three more places, each reproduced: `serializeGenotype`
  (`axles`/`nodes` — the WORST case: the unwritten axle's 128 zero bytes are
  all legal [0,1] genes, so the short stream DECODED CLEANLY into a different
  genotype), `serializeFitnessVector` (`individuals`), and
  `serializePopulationInitialization` (categories). A fourth round found it
  one layer UP, in the gate the snapshot encoder depends on:
  `validatePopulation` checked members BY INDEX and returned `[...individuals]`
  — an ITERATOR read — so a population whose indices held repaired genotypes
  and whose iterator yielded a RAW draw passed validation (canonicality tooth
  included) and then SERIALIZED the raw draw, defeating the one bug class that
  seam exists to stop, and producing a stream the codec's own decoder refuses.
  **The rule is therefore not about encoders: any function that validates one
  reading of a caller's collection and returns another has this defect.**
  Two related shapes closed with it — `validateGenotype` used
  `Array.prototype.forEach`, which SKIPS HOLES, so a sparse `axles`/`nodes`
  (exactly what a structural operator produces by growing `.length`) passed
  validation with its genes unchecked and died as a FOREIGN TypeError inside
  the serializer; and a hole in `initialSuspensionTypes` made
  `indexOf(undefined)` = −1 wrap to byte 255, encoding and folding into the
  digest before the decoder caught it. **Two intermediate fixes
  looked complete and were not, and both are recorded because the class is
  subtle:** materializing with an unbounded `Array.from` let an INFINITE
  generator declaring `length: 2` exhaust memory instead of failing loud
  (measured 47 MB for 2,000,000 values); bounding it fixed the hang but still
  took the VALUES from the iterator, so a genuine Array carrying an overridden
  `Symbol.iterator` (`Array.isArray` stays true — it was never the
  discriminator; the READ is) encoded `[9, 9]` while `terrain.js`, which reads
  `cfg.craterRadiusRange[0]/[1]`, would have used `[2, 5]` — decoding cleanly
  and re-encoding byte-identically, a digest attesting a terrain that never
  existed. The indexed read closes both by construction: nothing can
  under-yield, over-yield, or fail to terminate when nothing is iterated, and
  a slot that is not a finite number fails loud at the existing f64 gate. The
  u8 bound is still checked BEFORE materializing. Reachability, honestly:
  `ownTerrain` copies each range by an indexed loop (it used `.slice()` when
  this was written; `.slice` is itself a caller-looked-up method and was
  replaced under the ownership boundary — the conclusion stands, the mechanism
  changed), so the `evaluatePopulation →
  resolveSpec` production path was never exposed — the exposure is direct
  calls to the public encoders, i.e. exactly the replay and import tooling
  whose byte-exactness this PR exists to guarantee. Any future
  variable-length wire field must follow this rule: count, allocation, and
  payload from ONE INDEXED reading, never from an iterator when indices are
  what execution consumes.
- **THE OWNERSHIP BOUNDARY (the ruling that superseded the first threat-model
  draft):** the fifth adversarial round drew the line at "plain data in scope,
  hostile objects out" — and a sixth round broke that line with ordinary
  JavaScript (a genuine Array's own no-op `forEach` walked 'S2' past the
  suspension mask; a caller's retained reference rewrote provenance after
  generation). A FULL TRUST INVENTORY then swept every public function for one
  question — what does this code trust that a caller controls? — 149 trust
  points, 20 confirmed findings, 0 refuted, incl. two more blockers: member
  B's own `axles.map`, invoked BY the canonicality tooth's own repairGenotype
  call, swapped already-validated member A for a raw draw the snapshot then
  attested; and an own `length` DATA property on a genuine Uint8Array (length
  is an inherited ACCESSOR — plain defineProperty shadows it) made bytesToHex
  emit 'dead' for content deadbeef. **The corrected boundary — the module owns
  what it attests:** copy on intake by index (`captureGenotype` — round 8's
  `cloneGenotype`, superseded when round 10 fused validation and copy into one
  walk — `ownTerrain`, the vector row preflight); NEVER invoke caller-owned code (no method looked up
  on caller objects — no .map/.forEach/.indexOf/.slice/.subarray/iterators);
  attest exactly what was validated (`serializePopulationSnapshot` emits the
  very bytes the tooth checked via the shared `validatedMembers` walk;
  `serializeFitnessVector` writes from its preflight's module-owned rows —
  nothing re-reads the caller after validation); byte-boundary geometry via
  cached `%TypedArray%.prototype` intrinsic getters (bytes.js +
  deserializeGenotype), and the reader wraps the caller `fail` callback with
  an unconditional abort (a returning fail could REWIND the cursor); no
  retained caller references in attested records (resolvePolicy returns an
  owned frozen category list; the IR shares nothing with the input genotype);
  structural checks before every deep dereference and coercion nowhere
  (strict-boolean `deterministic` — truthiness encoded the string 'false' and
  a boxed Boolean as TRUE, the field that selects the physics flavor; explicit
  null fails where absent defaults — keepRaw, spawn.clearance; unknown
  assembly option keys loud; the flat-pad guard validates the scalars it
  compares — NaN made it vacuously pass; hubMassProperties refuses the shapes
  that silently returned all-NaN; spawnPose/validity/champion entry points
  shape-check rows and read them BY INDEX). **Still out of scope (the regress
  argument holds only here):** exotic objects whose FUNDAMENTAL operations lie
  — Proxy non-idempotent getters, lying prototypes, throwing toString on
  otherwise-valid values. The line is CODE vs DATA: never run caller code,
  never re-read caller data after validating it, but assume a plain data read
  returns what the runtime holds. **Documented-not-fixed (loud-on-first-use,
  none silent):** bytesEqual's inputs; the rng injection contract
  (randomGenotype/sampleInitialGenotype — downstream domain validation
  contains out-of-range draws); fnv1a.js (locked, untouched); the adapter
  trusts compiler-owned IRs. **Two guards considered and REJECTED** (recorded
  so the asymmetry reads as a decision): u32 fitness-vector member count and
  u8 category count — unlike the three shipping guards, each closing a
  REACHABLE gap with a triggering test, neither can be triggered at all
  (`Array.isArray` gates `individuals` and a genuine Array maxes at exactly
  the u32 bound 4294967295; categories are mask-validated with duplicate
  rejection before counting) — dead code defending an unconstructable shape.
- **Three wire-representability guards (fail loud; NO valid bytes change):**
  `serializeGenotype` caps `axles.length` at the u8 bound (validateGenotype has
  no axle cap — `maxAxles` is repair POLICY); `serializeEvaluationSpec` caps
  each range length **in the SIZE pass, before allocation** (validating at the
  write let a pathological declared length size the buffer first — measured
  ~17 GB reserved at 2^31 and a foreign `RangeError: Array buffer allocation
  failed` at 2^40 escaping instead of the module's diagnosis); and
  `serializePopulationInitialization` caps `populationSize` at the u32 bound —
  `resolveConfig` bounds it below but not above, and the digest-only path has
  no population array to bound it implicitly, so `0x100000001` wrapped to 1 and
  produced a manifest that REBUILDS a different population while carrying the
  original's digest state. All unreachable today; each converts silent
  corruption into a loud error and is what makes the exact-inverse claim honest
  rather than scoped.
- **Replay ruling:** `deserializeEvaluationSpec` returns the RESOLVED shape
  (what `serializeEvaluationSpec` consumes), so rerunning the evaluation those
  bytes describe must work — but `resolveSpec` rejected `termination` as an
  unknown key (it DERIVES it), making the resolver non-idempotent on its own
  output and a decoded spec unusable with `evaluatePopulation`. `termination`
  is now an accepted input key validated against `TERMINATIONS` (an unknown
  value still fails loud, never coerced). Additive and byte-neutral — the
  resolver already emitted that exact value, no digest moves; a committed test
  replays a decoded spec and asserts the re-resolved spec re-encodes
  byte-identically, so a persisted fitness vector stays comparable across a
  reload.
- **`src/sim/bytes.js`** (new, pure) — `createByteReader(bytes, fail)`
  (little-endian, bounds-checked before every read, `byteOffset` folded in so
  a subarray reads its own window, cursor state as GETTERS on a frozen
  object, failures routed through the CALLING module's fail idiom,
  `expectEnd` for trailing-byte refusal) + `bytesToHex`/`hexToBytes`, the
  lossless canonical-LOWERCASE JSON-safe representation (odd length,
  uppercase, and non-hex rejected — never normalized). **Binary identity vs
  JSON envelope:** the bytes ARE the identity, digests are folded over them
  and never over JSON; JSON carries hex inside a `boxcar3d.<name>/<v>`
  envelope. No base64. `trace.js hexBytes` / `characterize-population.js
  bytesToHex` stay put (recorded duplication — locked module / out-of-ban
  script).
- **Tests:** `tests/genotype-schema.test.js`, `genotype-codec.test.js`
  (incl. the seed-20260710 corpus inverted per member — binding the decoder
  to the `24cd0dd5` corpus with NO duplicated digest literal — and the NEW
  seed **20260732** boundary-value sprinkle corpus), `population-codec.test.js`
  (incl. the SELF-CONTAINED HISTORY proof: decoded config →
  `createInitialPopulation` → byte-identical manifest + matching snapshot
  digest state), `evaluation-codec.test.js` (the committed `a6d04f75` vector
  reconstructed WITHOUT physics from the fixture builder + the imported lock),
  `bytes.test.js`, and `tests/browser/codec-smoke.test.js` — the last exists
  because `vitest.browser.config.js` collects only `tests/browser/**`, so
  without it no codec line would ever run in Chromium. No new lock anywhere;
  no `*-locks.js` file touched.
- **THE ENFORCEMENT RULING (review round 8 — the correction that matters most
  for future work):** every ruling above had been written as PROSE with nothing
  binding it to the code. That was the actual defect, and it had already
  repeated three review rounds: a defect is found, the SITE is fixed, a RULE is
  written, the class is never swept — so the rule holds wherever someone looked
  and nowhere else. Two measurements settled it: deleting the three cached
  intrinsic getters from `deserializeGenotype` left the WHOLE SUITE GREEN, and
  the committed tooth "an own `subarray` property is never invoked by r.bytes"
  asserted a strictly WEAKER proposition than the rule it claimed to enforce —
  **the test had been written to the fix, not to the rule.** A 5-dimension
  whole-surface sweep (39 candidates, **35 CONFIRMED by reproduction, 0
  refuted**) then found what instance-fixing had left, including two that broke
  the PR's headline claim: (1) **`TA_SUBARRAY.call` still runs caller code** —
  `%TypedArray%.prototype.subarray` is SPECIES-AWARE (it reads the receiver's
  `constructor[Symbol.species]` and CONSTRUCTS the result), so an own
  `constructor` data property on a genuine Uint8Array made the snapshot decoder
  return genotype B from a 1052-byte stream containing genotype A and re-encode
  to 796 different bytes, with every bounds check and `expectEnd` passing.
  **Borrowing the intrinsic is only safe for the geometry ACCESSORS; a
  prototype METHOD may be species-aware — reach for a constructor, not a
  method.** Byte windows are now
  `new Uint8Array(TA_BUFFER.call(x), TA_BYTE_OFFSET.call(x) + o, n)` and
  `subarray` is lint-banned outright in the family. (2) **`bytesEqual` returned
  true for deadbeef vs dead0000 and `fnv1aFold` digested a PREFIX** — both read
  the shadowable `length`, and both were listed in the memo under "documented,
  deliberately not fixed — each loud-on-first-use, none silent", a claim that
  was false for both; a not-fixed register is only honest if each entry's
  FAILURE MODE was checked, not just its reachability. Also closed: `-0` passed
  every uint32 gate while setUint32 erased the sign (silent normalization
  breaking the Object.is round-trip claim — `isCanonicalUint32` now rejects it,
  and f64 gene leaves deliberately still accept it since setFloat64 preserves
  the bit); `evaluatePopulation` read the caller's population FOUR times to back
  ONE attestation (now `attestPopulation` — one walk returning the bytes plus
  genotypes DECODED FROM THOSE BYTES, which makes the codec's exact-inverse
  property load-bearing in production, not only in its own tests);
  `fitnessFromVehicleResult` returned NaN/Infinity/-5/the STRING '12' unchecked
  — the PRODUCER behind the champion-poisoning hole, where `>` and `!==` against
  NaN are both false so the first eligible row wins permanently; both champion
  selectors now judge MODULE-OWNED VALUES captured in one read while still
  RETURNING the caller's winning row (production rows carry a full diagnostics
  block the diagnostic selector exists to report; a compact summary would have
  silently narrowed a working API under cover of hardening), and both enforce
  the fitness vector's row domain — a row that cannot be SERIALIZED must not be
  RANKED, so an unknown integrity status or an unselectable row carrying
  non-zero fitness is refused rather than quietly filtered. Adjacent
  modules fixed in the same class: `trace.js` geometry + its diagnostic byte
  windows (a divergence reporter printing bytes not in the stream),
  `trace-forensics.js` and `evaluation.js` caller-iterator/hole walks.
  **The rules now fail a build:** `eslint.config.js` bans caller-visible byte
  geometry in the seven byte-handling modules (legal module-owned receivers
  carry a disable comment NAMING the receiver — that comment IS the audit
  trail) and bans `subarray` with no exception; `tests/ownership-boundary.test.js`
  pins each module's export list as a copy-declared literal plus a per-export
  classification table (a new export cannot ship unclassified — that is how an
  `export const` arrow and a function 16 lines above a read window each survived
  a full round unguarded), runs the shadowed-geometry battery asserting the
  RESULT is identical to the un-shadowed call rather than merely "it throws"
  (which scored `deserializeFitnessVector` green while it FALSELY REJECTED valid
  vectors), and asserts copy-on-intake/freeze/no-retained-reference;
  `tests/codec-roundtrip-property.test.js` (seed **20260733**, 200 samples ×
  5 pairs) generates boundary-value encoder outputs and asserts byte-identical
  re-encode + Object.is leaf equality with the failing PATH, carrying its own
  coverage teeth and broken-codec self-checks; a table-driven unvalidated-field
  sweep plus a permutation-invariance check pin the "total order" claim the
  selectors' own docblock makes. **Every tooth was mutation-verified — revert
  the fix, watch it fail, restore.** Generalizable rule, since this cost three
  rounds: *a test written to reproduce the bug you found is not enforcement of
  the rule you wrote about it.*
- **THE SINGLE-READ INVARIANT (review round 10 — the rule rounds 7–9 kept
  fixing one site at a time).** Stated once, now enforced:
  *any caller-owned value used to VALIDATE, ORDER, ATTEST, ENCODE or EXECUTE
  must be captured into a module-owned local exactly once, and every
  subsequent operation must use that capture.* The exploit vehicle is an
  ORDINARY own accessor on a plain object or genuine Array — squarely inside
  the round-8 ownership boundary (CODE vs DATA), not the excluded exotic
  class. Round 9 already had the exact instrument that finds these (a counting
  accessor asserting one read) and applied it to ONE function, because that is
  where the reported finding was; ~40 exports went unchecked. **Enforcement
  scoped to a round's MECHANISM is still enforcement written to the fix** —
  that is the generalization of round 8's lesson, one notch up, and it is why
  this round exists.
  A 6-area sweep with adversarial skeptic verification found **39 confirmed,
  7 refuted**, closing the four reported blockers and 35 more. Fix shapes, all
  one move: `assembly.js` — `captureGenotype` is now THE ONE WALK (validate and
  copy in the same pass; `cloneGenotype` is deleted, and `repairGenotype` /
  `serializeGenotype` / `forEachGenotypeField` / `compileAssembly` all consume
  the capture, since `validate(x)`-then-`clone(x)` let a `hue` getter answering
  0.5 then 1e6 produce a REPAIRED genotype outside `[0,1]`, an IR with a 300 km
  chassis half-extent, and a NaN on the wire the module's own decoder rejects);
  `population.js` — the canonicality tooth serializes ONCE and repairs the
  decoded copy, so it can no longer compare one reading against the repair of
  another; `population-evaluation.js` — `captureVehicleResult` backs all three
  fitness predicates (six reads of `bodies` became one), `resolveSpec` and
  `serializeEvaluationSpec` capture every scalar and materialize every terrain
  value, the fitness-vector preflight captures all four row fields BEFORE any
  check, and `championCandidates` is one shared capture that also **refuses
  duplicate individualIds** (both comparators tie-break on id, so duplicates
  made the documented total order position-dependent — and the vector encoder's
  strictly-ascending rule already rejected them: *a row that cannot be
  SERIALIZED must not be RANKED*); `trace.js` — `validateRecord` returns a
  frozen module-owned snapshot that the writer encodes AND derives its ordering
  key from; `trace-forensics.js` — copy-on-intake for `perBody` and `records`
  (`maxOf` also evaluated `sel(b).value` twice, so the value that won the
  comparison need not have been the one stored).
  **The blocker was an EXECUTION gate, not a codec seam:** `resolveSpec` read
  `spawn.x` five times, so an accessor passed the flat-pad guard at −44 and the
  vehicle RAN at x=100, off-pad, with the spec digest attesting the position
  that never executed.
  **`tests/single-read.test.js` is the enforcement.** The INSTRUMENT is
  universal over an input's fields: it deep-instruments every own property of a
  caller input with a counting accessor and asserts ≤1 read per path, so a new
  FIELD on an already-covered input is checked without anyone remembering. A
  property read at most once cannot be lied to, which is why the tooth needs no
  knowledge of what any function does. The INPUT SET, however, is a curated
  `CASES` table — a new EXPORT does not get instrumented automatically — so a
  coverage tooth (round-12, break-it sweep F9) derives the function-export set
  from the module namespaces and fails until each is a CASES row or a declared
  exemption; the corrected earlier claim was that a new export is covered
  "without anyone remembering", which was true of fields, not exports.
  Declared non-exemptions: a genuine Array's `length` is a non-configurable own
  DATA property and cannot lie (exempt BY THE LANGUAGE, not by choice);
  TypedArray byte geometry stays round-8's concern; and the adapter's placement
  planner keeps its "trusts compiler-owned IRs" ruling — `spawnPoseOnFlatStart`
  closes that at ITS OWN boundary via `ownPlainData` instead of pushing the rule
  into the realizer. **All 14 mutations bite**, including two teeth added only
  because a mutation was silent: `compareCheckpoints`/`compareTraces` needed
  DIVERGENT fixtures (identical inputs never reach the reporting branch, where a
  re-read prints values that were never compared), and `resolveSpec`'s
  regression had to live in `tests/population-evaluation.test.js` because it is
  private and reachable only through physics — *a fix no test can redden is not
  a fix.*
- **THE EXEMPTION WAS FALSE, AND THE INSTRUMENTS WERE SCOPED (round 11 — the
  class one notch BELOW the instruments themselves).** Round 10 built a tooth
  that is universal over FIELDS; round 11 asked what that tooth EXEMPTS and who
  checks the exemptions. 20 defects survived adversarial verification (44
  candidates, 11 refuted); three break the validated ≡ attested ≡ executed
  chain. **The root: the Array-`length` exemption.** Half true — `length` is
  non-configurable, so no accessor can be installed — and half FALSE: it is
  WRITABLE, and every element read in a validation walk IS caller code running
  between two readings of the bound. Measured with an ordinary own accessor on
  a genuine Array: a `radius` getter assigning `axles.length = 1` made a 3-axle
  genotype serialize to 396 bytes attesting axleCount 1 (short, well-formed,
  cleanly decodable, reproduced through `attestPopulation` with the canonicality
  tooth passing); a member getter assigning `individuals.length = 3` made
  `attestPopulation` return a silent PREFIX (4 in, 3 attested, 1476 bytes not
  1752); and a shrinking element getter made `compareTraces` /
  `compareCheckpoints` return **null — "identical" — for divergent traces**, in
  both directions. Every caller-collection loop bound is now captured before the
  walk, the three false comments are corrected, and `LOOP_BOUND_CASES`
  (`tests/single-read.test.js`) supplies the input the counting instrument
  STRUCTURALLY cannot generate (it rebuilds Arrays, discarding the mutating
  getter) — asserting the RESULT: a poisoned walk may fail loud in the owning
  module's dialect, never SUCCEED with a different answer.
  **A trust axis never posed before — own-property ENUMERABILITY:** presence
  gated by `hasOwnProperty` (sees non-enumerable own props) while execution came
  from `{ ...TERRAIN_DEFAULTS, ...terrain }` (own ENUMERABLE only), so one
  `Object.defineProperty(t,'seed',{value})` — plain data — passed the guard whose
  own message says a vector must never bind the default seed, and
  `evaluatePopulation` ran and attested the **seed-0 DEFAULT world**,
  byte-identical to an explicit seed-0 run. Same shape in `runEvaluation`. Rule:
  *a guard that decides presence must use the same property enumeration its
  consumer reads with* — plus rejection of any terrain carrying non-enumerable
  own properties (a non-enumerable `featureDensity` silently reverted too).
  **`validateOptions` returned the caller's `terrain`/`vehicles` BY REFERENCE**
  and `runEvaluation` re-read them after `hooks.onPhase(...)` and across
  `await createPhysics(...)`: a run validated `trace.mode:'none'` executed
  'full'; a spawn validated at x=−25 realized at x=−13; a removed-`targetAngvel`
  tombstone was bypassed so the vehicle ran at the default surface speed.
  Indexing the loop (round 9) fixed holes and iterator divergence — it did not
  make the two readings ONE. It now returns a module-owned capture (`ir` stays a
  captured REFERENCE under the standing compiler-owned-IR ruling).
  **Also closed:** `resolveSpecDigestState`'s double read of `evaluation.spec`
  (its documented twin was fixed by caller capture in this same PR);
  `ownTerrain` densifying a caller-DECLARED range length before any validation
  — an uncatchable `FATAL ERROR: heap limit` V8 abort at 2^26 on the production
  path, one function from the identical committed guard; `ownPlainData` passing
  `Object.create(null)`/class instances BY REFERENCE, dropping an own
  `"__proto__"` key through the inherited setter, and recursing unbounded;
  `resolveReachMap` walking `bodies` with the CALLER's `forEach`;
  `bodyReachMetadataForIR` returning chassis-only metadata with NO error for a
  non-array `wheels` (a silent path this PR's own indexed rewrite introduced);
  two diagnostics printing values that were never rejected; and three
  `Object.hasOwn` defaults over-correcting to reject explicit `undefined` where
  five sibling keys accept it.
  **G9 — the enforcement surface — mattered more than the fixes.** Each
  instrument was scoped to the round that built it:
  `tests/ownership-boundary.test.js` pinned export lists for FIVE modules while
  `single-read.test.js` cited it as the backstop for all (47 exports across
  `integrity.js`/`trace.js`/`trace-forensics.js`/`evaluation.js`/`fnv1a.js`
  unpinned — now pinned, with `RE_EXPORTS` declared and asserted
  reference-identical); every CASES row asserted SUCCESS, so no rejection branch
  was instrumented (now a rejection table); the `serializeFitnessVector` row
  carried no `spec`, so its PRODUCTION branch was never entered (now two rows,
  the sibling's pattern); and the byte-family lint block scoped itself with a
  hard-coded seven-file list no test read — a probe file elsewhere in `src/sim`
  produced ZERO diagnostics. `(0) the byte-family lint scope` now reads the real
  directory and the real config, so a new `src/sim` module fails until it is
  classified in `BYTE_FAMILY_EXEMPT` or the lint block. Selectors widened:
  `bytes['byteLength']`, `const { byteLength } = bytes`, `Reflect.get(...)`,
  `globalThis.Math.random()`, `const M = Math; M.random()` and
  `globalThis.Date.now()` all linted CLEAN while both hard rules claimed
  "(ESLint-enforced)"; no live violation existed — the spelling was open, not
  the ban. **One arithmetic change, verified:** `**` was unbanned though
  `Math.pow` is, and lived in the locked terrain feature generator feeding
  `maxHalf.ramp` → every ramp's placement draw; `x ** 2` is
  `Number::exponentiate` (implementation-approximated exactly like `Math.pow`),
  now `x * x` (IEEE-exact), operator lint-banned, all five terrain fingerprints
  byte-identical across the change.
  **The completeness pass found the largest gap, and it is PRE-EXISTING:** every
  codec test asks "do the same bytes come back?", none asked "do the same bytes
  still describe the same VEHICLE?" Reordering `SUSPENSION_TYPES` to
  `['S1','S0','S2']` flips every archived axle's suspension while BOTH locks stay
  byte-identical (`24cd0dd5` hashes raw genes; `39bcd6c4` hashes chassis
  colliders, which derive only from frame genes) — the sole guard was one
  incidental repair-test assertion, and `genotype-codec.test.js` was
  self-referential on both sides. A decode-table golden now pins the enum orders
  as copy-declared literals and hashes the DECODED PHENOTYPE of the
  seed-20260710 corpus (`341c2830`); changing it is a genotype-VERSION event.
  **All 27 mutations bite, 0 silent** — four teeth exist only because a mutation
  WAS silent, each a lesson in what an assertion must distinguish (a
  `compareTraces` case whose shrink target equals the loop bound, or the walk
  throws before the verdict; per-body capture counts rather than
  `perBody.length`, which is 1 either way; `{}` rather than a string for the
  non-array `wheels`, since a string has a `length`; and BOTH a `forEach` and a
  `Symbol.iterator` poison, one defect wearing two names).
  **The generalization, one notch above round 10's:** *enforcement scoped to a
  round's mechanism is still enforcement written to the fix.* Make the SCOPE
  derived rather than enumerated, and check the exemptions as carefully as the
  rules.
- Full suite green (51 files, 1152 tests), determinism gate green, pinned
  Chromium green, lint + build clean. Every terrain/noise/boulder/assembly
  fingerprint, the A–D evaluation digests, all four population digests, the
  per-member fitness literals, the champion trace, and every version constant
  byte-identical. **Zero lock movement in round 11 either** — no committed
  digest moved under any of the twenty fixes.

**Round 12 — the break-it sweep (a 20-lens adversarial pass whose success
criterion was BREAKAGE, 42 confirmed findings) proved round 11 falsified its own
guarantees, and drew two scope rulings. Seven commits; every committed lock
byte-identical.**
- **The blockers were round 11's own headline invariant.** "Validated ≡ attested
  ≡ executed" was false four in-scope ways: `runEvaluation` captured
  `spawn.position` but left `spawn.rotation`/`spawn.linvel` BY REFERENCE (a
  validated identity quaternion executed as yaw-90; a |q|²=1 reading passed the
  unit-quaternion gate and realized |q|²=3.24, `integrity:'ok'`); `resolveSpec`'s
  seed guard was bypassable by an accessor deleting `terrain.seed` between the
  presence walk and the spread (seed-0 default world attested); and the new
  `ownTerrainOptions` re-introduced the `__proto__` poisoning round 11 fixed in
  `ownPlainData` one module over. Spawn components are captured component-wise
  now; the terrain is captured ONCE and both sites reject a non-plain prototype
  and non-enumerable/`__proto__` keys.
- **"Every loop bound is captured" and "a poisoned walk never succeeds with a
  different answer" were overclaims.** `capturePerBody` still re-read its bound
  (offlineIntegrityView returned 'ok' for a catastrophic analysis), and
  `compareTraces` still returned null ("identical") for divergent traces via a
  sibling-record byte overwrite — the loop BOUND was captured, the record BYTES
  were not. Both fixed; `spawnPoseOnFlatStart` and `foldIntegrity` gained the
  field guards their comments already claimed.
- **Four allocations round 11 left unbounded** reach an uncatchable V8 heap abort
  from a validated input (terrain descriptor counts, `populationSize`,
  `maxSteps`+profile buffer, `ownPlainData` array length) — each now bounded
  before it allocates, verified under `--max-old-space-size=256`.
- **The enforcement was hollow in three places, now real:** the D7/F3
  determinism lint bans were DISABLED in the 7 byte-family files (flat-config
  replaces `no-restricted-syntax`) — `x ** 2` and `globalThis.Math.random()`
  linted clean in assembly.js; the decode-table golden folded 5 of ~20 decoded
  quantities (a GENE_RANGES rescale left all three locks identical) → widened to
  `12c0bcd3`; and the single-read suite's "universal by construction... a new
  export covered without anyone remembering" was true of FIELDS, not exports → a
  coverage tooth derives the function-export surface and fails until each is
  covered or exempted.
- **THE STORAGE-LIFETIME RULING (JP): canonical bytes must be ORDINARY —
  same-realm, fixed-size, non-shared, non-detached; anything fancy rejected loud
  at the door.** The round-8 property boundary never named a genuine Uint8Array
  whose BACKING STORE is transient/foreign: a detached buffer reads empty
  (`bytesToHex`→"", `fnv1aFold` unchanged), a SharedArrayBuffer races
  cross-thread, a resizable buffer shrinks under a reader.
  `requireOrdinaryBytes` (bytes.js) enforces it — round 12 wrote "at every
  intake seam" while gating TWO; the claim was false until round 13 closed the
  derived surface (see below).
- **THE FNV-IDENTITY RULING (JP): FNV-1a32 is a drift/lock digest + the
  determinism comparator, NOT persistent content identity.** A 32-bit collision
  appears in seconds but cannot fool the determinism gate (it compares the SAME
  input across environments, never two artifacts). Verified no equality-by-FNV
  where bytes are in hand (`bytesEqual` compares bytes). A strong digest for
  persisted history is DEFERRED to Phase 1B, unneeded until artifact identity is.
- Report-only + hygiene: `characterize-population.js` reported 0 explosions on a
  population holding the 8.17e6 m witness (it read the policy-v2 integrity-GATED
  `fitness`, not the raw `maxForwardDistance`; the undriven audit printed
  `passive max-fwd 0.00` beside `passive final 2.10e2`) — fixed, §3.3 corrected;
  `-0` rejected in the trace u32 fields; the R4 wall-clearance guard tightened by
  the trackHalf floor; the causal scan vehicle-scoped and its chain rule
  corrected; the app-scene smoke fixed on Windows (shell:true) and no longer
  runs at import.
- **Full suite green (51 files, 1183 tests), determinism + pinned Chromium
  green.** Every terrain/noise/boulder/assembly fingerprint, the A–D evaluation
  digests, all four population digests, the per-member fitness literals, the
  champion trace, and every version constant byte-identical — **zero committed
  lock moved under any round-12 fix** (the widened decode golden `12c0bcd3` is a
  test-internal literal, not a production lock). The generalization: an adversary
  whose success criterion is *finding a break* attacks the guarantees, not the
  sites — and found the previous round's claims, comments, and own new code were
  where the next defects hid.

**Round 13 — external-review validation: the byte-storage closure and the
first EXPLICIT deferral.** An external review of the full PR history was
validated claim-by-claim at head (both blockers CONFIRMED by execution, a few
precision errors, disposition upheld). JP ruled: fix Blocker 1, explicitly
defer Blocker 2. Two commits; zero lock movement; 51 files, 1196 tests.**
- **Blocker 1 CLOSED (the round-12 pattern, one notch up):** round 12 wrote
  "`requireOrdinaryBytes` enforces it at every intake seam" and gated TWO
  seams. Executed at head: `fnv1aFold(state, detached)` returned the state
  UNCHANGED — a digest attesting zero bytes it was never handed, the exact
  motivating failure bytes.js itself cites — and `bytesEqual` reported a
  detached `[1,2,3]` EQUAL to a fresh empty array AND to a detached `[9,9]`.
  Five seams closed: `fnv1aFold` (inline — the lock hash stays import-free by
  ruling; rejection in its own dialect, since `String(detached)` dies as a
  FOREIGN join error), `typedArrayByteLength` (detached geometry is 0 — true
  and still a lie), `bytesEqual` (both sides), `encodeTraceRecord`'s
  caller-supplied `out` (shared/resizable slipped past the RECORD_BYTES
  identity; detached failed it only incidentally), and `compareTraces` record
  entries (a resizable entry shrinking between the size identity and the copy
  compared all-zero bytes that never existed — silently, as "identical";
  fancy storage now THROWS as invalid input, never reported as divergence).
  **The enforcement is DERIVED:** `tests/ownership-boundary.test.js` (0b)
  takes the module set from the byte-family LINT block, the export set from
  the real namespaces, and requires every function export classified —
  'gated' (invoke thunk run against detached/SAB/resizable, all must throw)
  or 'no-byte-intake' (stated reason). The two seams C12 gated but never
  tested (decodeTraceRecord, deserializeGenotype) got their batteries. All 7
  mutations bite.
- **Blocker 2 EXPLICITLY DEFERRED (JP's ruling — the first entry in this
  project's deferral register that states its CHECKED failure mode up
  front):** `TraceWriter.finish()` returns its LIVE private
  `#records`/`#checkpoints` arrays, and `analyzeTrace`/`compareTraces` never
  re-verify caller-held record bytes against the digest/recordCount/
  byteCount/checkpoint states — so a caller can mutate evidence AFTER
  attestation and offline forensics will describe bytes the digest never
  attested. Deferral is sound because the surface is DIAGNOSTIC-only (no
  lock, no fitness, no selection path consumes it; production traces live
  and die inside one process's `runEvaluation` result), and the fix belongs
  to Phase 1B's persisted-history format alongside the strong-digest
  deferral: EITHER the value model (finish() returns immutable/copied
  representations) OR the verified-evidence model (`verifyFullTrace`
  recomputes digest/counts/ordering/checkpoints; `analyzeTrace` accepts only
  verified results). Freezing the outer array alone is insufficient —
  Uint8Array contents stay mutable. Recorded at both sites (finish(),
  analyzeTrace) and in the codec doc §Round 13.
- The review's historical audit (trust-boundary reversal, champion-API flip,
  Array-length exemption, the universal-claim ladder, the `__proto__`
  recreation, spawn-capture propagation) matched the independent churn audit;
  its "should not be reopened" list is adopted as stable.

**Round 14 — two real fixes and one honest deferral (avoiding the whack-a-mole trap).** A second external review after the round-13 push reported three findings; verified two blockers by direct execution at HEAD, then asked "are we sure we're not playing whack-a-mole?" — a fair question, so I attacked the first candidate fix and it fell over one level down. That fix was reverted and replaced with an explicit deferral. Net result: one commit, zero lock movement; 51 files, 1199 tests.**
- **runRealizedEvaluationLoop caller-collection ownership — FIXED (real,
  structural).** The seam consumed `realized.map` / `.flatMap` / for-of, and
  its ownership classification declared `callerCollections: []` on the
  reasoning "usually called with module output" — which effectively exempted
  it from every hostile-collection battery. Executed at HEAD: a genuine
  Array with an own no-op `.map` returned `vehicles.length === 0` while the
  world stepped maxSteps and `counts.staticColliders` matched — silent
  contradiction of every documented ownership rule. Fixed by
  captured-length integer walks over BOTH `realized` and each `rec.wheels`
  (the codebase-wide rule from round 8+); classification updated honestly
  to `callerCollections: ['realized', 'realized[].wheels']`. Two
  regressions in `tests/evaluation-core.test.js` mutation-verified against
  the pre-fix walks (outer `.map` and inner `.flatMap` shadows both bite).
  Not whack-a-mole: replacing method calls with indexed loops closes the
  class structurally at that seam.
- **Cross-realm coverage (P2 finding) — FIXED.** Round 13's storage battery
  ran detached / SAB / resizable but not cross-realm — the fourth named
  policy axis. A Node `vm.runInNewContext('new Uint8Array(128)')` view now
  runs through the (0b) FANCY_STORES matrix against all 12 gated seams, and
  a same-origin iframe view runs through the pinned Chromium codec smoke.
  A drift from `instanceof Uint8Array` to a broader brand check would need
  active cross-realm rejection to keep both green.
- **THE COMPARE-CLASS DEFERRAL (JP's ruling) — the meta-point of the round.**
  compareTraces silently returned `null` for streams that genuinely differed
  when an ordinary accessor descriptor on `records[i]` — no Proxy, no
  exotic storage — mutated the opposing side to match. Same shape reproduced
  in `compareCheckpoints` via field accessors. A first fix installed accessor-
  descriptor pre-scans on both sides; JP asked "are we sure this isn't
  whack-a-mole?" and I attacked my own fix — an accessor one level down
  (getter on `records[i].translation.x`, or on `envelope.version`, or on
  `envelope.records`) still ran during capture and reproduced the silent
  false-identical. Refusing accessors at each discovered location is by
  definition site-by-site, not class closure. The candidate fix was
  REVERTED and the class DEFERRED, with the failure shape stated at both
  call sites and the two candidate atomic architectural fixes recorded for
  Phase-1B persisted history: (A) accept only pre-encoded Uint8Array
  records (hard API boundary), or (B) total deep pre-scan of nested
  descriptors. Test tooling that must trust a comparison is expected to
  encode both sides via `encodeTraceRecord()` before calling, which
  mechanically closes the class for that caller.
- **THE DEFERRAL RATIONALE WAS WRONG, AND THE CORRECTION IS THE LESSON.**
  The first version said the surface is "DIAGNOSTIC-only — no lock, no
  fitness, no selection path consumes the return values". True of
  `compareTraces`; **FALSE of `compareCheckpoints`**, which all three
  `test:determinism` files (evaluation-determinism, evaluation-golden,
  population-determinism) and both Chromium gates call. Published across
  five files without grepping the call sites — the project's signature
  failure (unenforced prose read as an audited guarantee), committed inside
  a deferral rationale, where the prose IS the justification. The honest
  reason is narrower and stronger and does not depend on which gate calls
  what: **BoxCar3D has no untrusted input.** Every argument reaching these
  comparators is module-owned (TraceWriter output, committed lock literals,
  codec-decoded structures, structured-clone worker payloads), so
  exploiting the class means writing an accessor into this repo's own
  source to deceive this repo's own gates. Real bug, nil exposure, and a
  32-call-site migration to close it. **Explicit expiry: Phase 1B persists
  evolution history and reloads it — the first moment a trace crosses a
  trust boundary. Revisit there, not before.** **[SUPERSEDED by PR 3
  Commit 0 — approved policy decision, codec doc §Round 15: the expiry is
  SEMANTIC, not chronological. PR 3 persists BYTE-ONLY evolution history and
  forces evaluation to trace mode `none`; the generation record's fixed
  geometry admits exactly four component kinds (population snapshot,
  evaluation metadata, fitness vector, lineage), so trace records,
  checkpoints, live diagnostics and comparator evidence have no byte walk to
  enter through. The hardening therefore expires when a NON-NULL trace
  crosses a persistence, replay, determinism-lock, or artifact-identity trust
  boundary — not merely when unrelated evolution bytes are persisted. The
  premise is executable, not prose: `tests/evolution-run.test.js` holds the
  static (no trace import anywhere in the evolution module family) and
  runtime (`mode: 'none'`, null trace) exclusion teeth, and the split
  trigger stands — if any evolution code starts accepting, retaining,
  encoding, comparing, or deriving identity from non-null trace evidence,
  trace hardening lands first.]**
- **Three follow-up fixes, all cheap, all mutation-verified:**
  `runRealizedEvaluationLoop` checks `Array.isArray(realized)` before
  reading `.length` (measured: `{length: 0}` returned a clean `vehicles: []`
  while the world stepped `maxSteps`; `null` leaked a foreign TypeError —
  fixing the ELEMENT walk had left the COLLECTION the only unguarded input;
  a genuine empty array stays legal); `compareTraces` does a realm-neutral
  `ArrayBuffer.isView` check before the plain-record path; and the
  cross-realm storage-battery row, whose regex accepted `invalid`/`unknown
  key` and was therefore **vacuous for `compareTraces`** (the foreign view
  missed the byte branch, fell to the record path, died on "unknown key" —
  a wrong-reason rejection scored as a storage-gate pass), now demands the
  storage diagnosis. Tightening it immediately exposed a second site
  (`deserializeGenotype`'s generic message), now aligned. *A test that
  passes for the wrong reason is worse than no test.*
- **The generalization.** Round 11 said "enforcement scoped to a round's
  MECHANISM is still enforcement written to the fix." Round 12 said it
  again about round-11 claims. Round 13 said it about round-12's storage
  claim. Round 14 caught round-14's own compareTraces fix falsifying it —
  the pattern the review was warning about, reproduced live inside the fix
  meant to close it. The escape from the ladder is not "one more clever
  check"; it is to recognize when a class needs a real architectural
  boundary (defer to when it can be made) versus a site-level guarantee
  (fix now). This round did both.
- **No format or lock movement.** Every version constant unchanged; every
  committed fingerprint byte-identical. Lint clean, full suite 51 files /
  1199 tests, determinism gate 4/23, build clean, pinned Chromium 3 files /
  15 tests (up 1 for the cross-realm iframe smoke).

**GA Phase 1B PR 2 landed — Pure Evolution Operators:** immutable selectable
pools, deterministic tournament selection, owned elites, and continuous
parametric mutation with repair accounting. PR 4 owns the full experiment,
empirical report, and validation or tuning of the provisional mutation defaults.
**PR 3 consumes the Phase-1A + policy-v2 contracts**:
`createInitialPopulation`, the snapshot/initialization/spec/fitness-vector(v2)
encodings, `evaluatePopulation` (isolatedWorlds, id-keyed, integrity-gated), and
PR 2's `selectablePoolFromEvaluation`, `selectTournamentParent`, `selectElites`,
and `mutateContinuousGenotype` operators. An empty selectable pool is an explicit
terminal condition, never permission to substitute the diagnostic champion.
The integrity disposition is
DECIDED (PR-B): the threshold is a fitness-eligibility bound (integrity failure
⇒ non-selectable, fitness 0), run per evaluation — constraining the training
terrain is not an escape hatch, since mutation moves morphologies across the
conditioning boundary both ways (measured: witness A's whole neighborhood stays
divergent; clean parents' neighborhoods stay clean). Alert-as-failure escalation
remains a policy-v2 trigger, unmet on the tested corpus. Empirical
guidance: initial viability is real but modest (median ~2–3 m); repair is
near-universal on uniform raw draws (perturb genes freely and rely on
repair for canonicalization; the mutation-neighborhood probe
(`probe:integrity --pass neighborhood`, discrete-preserving walker) has data —
repair touches ~1.4–6.4 gene leaves per jittered child and does not, on that
sample, push clean children across the boundary or rescue affected ones); no
category is starved
(parametric mutation first, structural second; structural rates
conservative, spec §3.1.3). **Deferred (unchanged):** Phase 1C extended
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

**GA Phase 1B PR 3 landed — the deterministic evolution engine, byte-only
history, replay, and strong artifact identity. Full contract:
`docs/ga-phase-1b-pr3-evolution-history-2026-07.md`:**
- **The deep module (`src/sim/evolution-run.js`):** `createEvolutionRun(config)`
  (SYNCHRONOUS — validation and generation 0 are pure), `await run.advance()`,
  `run.status()` (frozen scalars), `run.historyBytes()` (a FRESH copy every
  call; `historyUnavailable` before the first commit), and
  `await resumeEvolutionRun(historyBytes, {expectedHistoryDigestBytes?,
  expectedGenerationIndex?})`. **There is deliberately NO public
  `advanceGeneration(population, evaluation)`:** a stateless transition would
  have to decide whether an independently supplied population and fitness result
  belong together, and the only binding available is the fitness vector's FNV-32
  snapshot-digest state — which PR 2 ruled a same-source in-process mismatch
  SENTINEL, never equality between independently supplied artifacts. The
  transition is therefore PRIVATE to an opaque run: it decodes the population
  from bytes it owns, evaluates exactly that population, and derives the vector
  from the same owned transition; the FNV state is still checked, as the
  sentinel it is. `advance()` and replay call the SAME free transition function,
  which is what makes replay a replay rather than a second implementation kept
  in agreement by hand.
- **New modules:** `evolution-contract.js` (error taxonomy + `EvolutionError`
  with a scalar-copied context, the terminal enum in wire order, engine/policy
  versions, caps, checked arithmetic — a leaf with no imports, which is what
  keeps the family cycle-free; a deliberate addition to the plan's file list,
  reason recorded in its header), `evolution-lineage.js`, `evolution-history.js`,
  `evolution-replay.js` (private; ordered verification, not a public seam),
  `evolution-fixtures.js`, `evolution-locks.js`, `src/platform/sha256.js`, and
  `scripts/probe-evolution.js`.
- **Transition rulings:** elites FIRST in `selectElites` rank order, each with a
  FRESH id (the previous id survives only as `parentIndividualId`), then mutated
  children in ascending new-id order; all N ids allocated as one CHECKED
  contiguous interval BEFORE any randomness is drawn; each child derives
  `new Rng(seed).fork(childId)` and consumes exactly the PR 2 budget
  (3 `nextUint32` + 1 `nextFloat` per eligible continuous leaf + 1 more per
  selected leaf). No generation-global RNG exists — evaluation order, array
  order, diagnostics, wall clock, an exception after a draft, and sibling draws
  cannot reach a child's stream (proven by rebuilding every generation-1 child
  OUTSIDE the engine and requiring byte identity). Terminal precedence
  `noSelectableParents` → `generationLimitReached` → `individualIdExhausted` →
  `none`, decided ONCE before the record is encoded; a terminal run repeats its
  result and appends nothing. `individualIdExhausted` is unreachable under the
  v1 caps (256 × 1024 ≪ 2³²) — the enum and the checked arithmetic stay so a
  future cap change fails SAFE. Draft/commit atomicity: a failure leaves the
  committed artifact BYTE-IDENTICAL and a retry reproduces the same generation;
  a concurrent `advance()` throws `advanceInProgress` SYNCHRONOUSLY, before any
  microtask.
- **History v1 (byte-only):** `BC3DEVO1` magic, versioned framing, a header
  binding runtime identity + every operator version + the RESOLVED mutation
  NUMBERS (never "the defaults") + the initialization manifest + the evaluation
  spec, then per generation a payload with EXACTLY FOUR components in fixed
  order — population snapshot, evaluation metadata, fitness vector, lineage —
  each length-prefixed with its own SHA-256 digest. Domain-separated digests
  (seven literal NUL-terminated domains); generation 0 chains from the HEADER
  digest so the chain covers configuration and runtime identity, not only
  records; the history digest covers the body and excludes its own trailer. The
  embedded digest proves FRAMING AND SELF-CONSISTENCY — not freshness, not
  authenticity, not "newest save" (no signatures, MACs or encryption anywhere).
  **The evaluation-metadata component exists because fitness normalization drops
  determinism evidence:** the fitness vector carries no world mode, no
  effective timestep and no executed step count, so replay compares metadata
  BEFORE fitness — a drifted timestep EXPLAINS a fitness difference and
  reporting the fitness first would bury the cause.
- **`src/platform/sha256.js` — the one collision-resistant digest seam, and the
  §Round 12 strong-digest deferral DISCHARGED** (not narrowed). It lives outside
  `src/sim` so the D7 ambient-global ban stays absolute: SHA-256 is a pure
  function of its input with no state or entropy, and it affects PERSISTED
  ARTIFACT IDENTITY rather than simulation state. FNV-1a32 keeps its unchanged
  role (drift/lock digests + the same-input cross-environment comparator); no
  evolution artifact identity is ever established by FNV. `sha256` is NOT an
  `async function` — the caller's bytes are validated and COPIED in a
  synchronous prologue, so copy-before-await is structural, and a fancy storage
  shape is refused with a THROW rather than a rejected promise (the same ruling
  now applies to `assembleHistory`, `verifyHistoryArtifact` and
  `resumeEvolutionRun`).
- **`copyOrdinaryBytes` (bytes.js)** — the one intake move for bytes that must
  outlive a call: storage-lifetime gate first, then geometry from the intrinsic
  getters, then a fresh exactly-sized array. NOT `new Uint8Array(bytes)`, which
  reads the caller's shadowable `length` (measured: a 4-byte array claiming
  `length: 2` copies a PREFIX).
- **Ordered replay (10 stages, each with its own code):** storage + the 64 MiB
  ceiling BEFORE the copy → copy BEFORE any await → framing → header digest +
  version agreement → every component digest in generation order → the chain →
  the whole-history digest → external expected identity → the runtime gate →
  deterministic replay stopping at the first byte divergence (reporting `stage`,
  `generationIndex`, `byteOffset`, `expectedByte`/`actualByte`, and
  `lastAgreedGenerationIndex`). Twelve stable error codes; lower-level module
  errors ride as `cause` and callers branch on `code`, never on text. A valid
  OLDER artifact verifies perfectly — that is the point, and it is why
  `staleOrWrongArtifact` exists and is only reachable when the caller supplies
  what it expected. **Peak retention:** the artifact, at most one history-sized
  append/SHA input, ONE decoded payload (≤16 MiB), and the current/next working
  populations — verification decodes one payload at a time and discards it,
  never a second parsed copy and never decoded objects for all generations.
- **Locks:** fixture `evolution-a-small-flat` v1 (seeds **20260742** population /
  **20260743** terrain; 6 individuals × 3 generations × 45 steps on the flat pad,
  terminating on the generation limit) — header `015f2747…5ccf3ea9`, history
  `2e084233…cca497f9`, plus every generation's four component digests, its
  chained digest, and every lineage row. `test:determinism` gained
  `tests/evolution-determinism.test.js`; pinned Chromium
  (`tests/browser/evolution-determinism.test.js`) reproduced every literal —
  including the SHA-256 seam, PR 3's one genuinely new cross-runtime dependency —
  **on the first run**. The gate also asserts STRUCTURAL coverage (elites exist,
  both mutation branches occur incl. a zero-selection child, the last record is
  terminal), so a fixture change cannot quietly narrow what the locks prove.
- **Enforcement is DERIVED, not enumerated.** The byte-family lint scope now
  comes from EVERY config block carrying the shared `BYTE_SAFETY_SYNTAX`
  selectors (it was a single-block lookup by filename, which would have silently
  stopped covering the family the moment the platform adapter got its own
  block), and the module walk covers `src/platform` as well as `src/sim`. Two
  real defects were found by the standing instruments and fixed AT SOURCE rather
  than exempted: `crossCheckLineage` read its rows twice, and
  `encodeGenerationPayload` read `record.components` once per component kind.
- **Deliberate sabotage: 12 mutations, ALL BITE** (terminal precedence, one RNG
  draw, child-ID order, one lineage parent, one digest domain, verification
  order, the runtime version check, a component-length ceiling,
  copy-before-await, the fresh history copy, the trace-mode-`none` seam, the
  generation chain). **The verification-order mutation was SILENT on the first
  attempt** — the component-corruption tests reassembled the artifact, so they
  recomputed the outer digest and would have stayed green if the whole-history
  check ran first. Two in-place corruption tests now enforce the ordering
  property. That is round 10's lesson (*a test written to the fix is not
  enforcement of the rule*) recurring inside this PR, caught by running the
  sabotage checklist rather than by assuming it.
- **Zero lock movement, zero version movement elsewhere.** Every terrain, noise,
  boulder, assembly (`24cd0dd5`/`39bcd6c4`), A–D evaluation and population
  digest is byte-identical; `GENOTYPE_VERSION`, `ASSEMBLY_IR_VERSION`,
  `EVALUATION_TRACE_VERSION`, snapshot/initializer/spec/fitness-vector/integrity
  versions all unchanged. Full suite green (59 files, 1515 tests), determinism
  6 files, pinned Chromium 4 files, lint + build clean.
- **Seeds allocated:** 20260740 engine unit-test population · 20260741 engine
  unit-test terrain · 20260742 committed fixture population · 20260743 committed
  fixture terrain.

### Phase 1B PR 2 operator boundary

`SELECTION_POOL_VERSION = 1` is an immutable, non-wire selection view over
fitness-policy v2 evaluation rows. Capture the declared snapshot state before
any row accessor, retain all evaluated ids ascending, and retain selectable
rows only (`valid && integrityStatus === 'ok'`). Tournament selection uses
exactly three `nextUint32` calls whenever the pool is nonempty (including a
one-member pool), with replacement; an empty selectable set returns `null`
without reading RNG. Elitism attests population bytes and compares FNV state
only as an in-process mismatch sentinel—never claim that FNV establishes
cryptographic identity or equality.

Parametric mutation owns a canonical parent through a one-member attestation,
walks every continuous f64 field in serialization order, and consumes one
`nextFloat` decision plus a selected-leaf delta draw. Its signed interval is
`[-magnitude, +magnitude)`, and it repairs exactly once after raw mutation.
The `{ probability: 0.05, magnitude: 0.05 }` defaults are provisional Phase 1B
baselines; PR 4 owns their empirical validation or tuning.
`rawGenotype` is diagnostic-only; neither it nor final `genotype` may alias the
parent or each other. Both outputs retain the complete parent schema and exact
version, structural, and discrete bytes. Accounting leaf counts cover
continuous f64 leaves, while byte counts cover the whole canonical stream.
PR 3 owns generation/replacement, child IDs, lineage, persisted history/codecs,
strong artifact digests, replay/determinism gates, and the evolution probe.
PR 4 owns the full empirical experiment/report and validation or tuning of the
provisional defaults. Do not smuggle crossover, structural/discrete mutation,
codecs, or determinism-lock changes into this PR.
