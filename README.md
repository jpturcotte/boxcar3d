# BoxCar3D

Evolving 3D vehicles in a corridor world — a genetic-algorithm sandbox inspired
by BoxCar2D. Vehicles drive forward only (no steering, no AI) through
procedurally generated 3D terrain with elevations, craters, obstacles, and
surface types, bounded by physical walls. Morphology is the point: evolving
frames, multiple suspension types, and free wheel arrangements.

**Status:** GA Phase 1A — the Deterministic Population and Fitness
Foundation — landed. This is the scientific instrument the genetic
algorithm will trust: given a population seed and a declared evaluation
configuration, BoxCar3D now produces a canonical repaired population and an
exact, reproducible fitness vector whose per-individual results are
independent of cohort membership and ordering. Selection and mutation are
deliberately NOT in this stage (that is Phase 1B). A live initializer
(`src/sim/population-initializer.js`, separate from the locked test-corpus
generator) turns a seed into 20-odd vehicles via one order-independent
`Rng.fork(individualId)` stream each, with the GA biases the corpus must
not have — bilateral symmetry defaults on (~80%), suspension is masked to
the realizable S0/S1 set (S2 unreachable by construction), every individual
has at least one axle and at least one drive-enabled wheel. The
**repaired** genotype (`compileAssembly(...).genotype`) is the heritable
truth, carried as canonical population content
(`src/sim/population.js`); a raw operator draw can never survive as a
hereditary record. Fitness is **maximum forward progress** from the spawn
position — a new `maxForwardDistance` result field on the canonical runner
(alongside `stepAtMaxForwardDistance` and `maxBackwardDistance`), folded
from the same per-step chassis read the trace already consumes, so the
existing A–D golden digests are byte-identical with no re-lock. This is a
**deterministic, reproducible baseline score contract** — exact and
cross-environment-locked — **not yet a selection-ready fitness policy** for
rough composite terrain (see the explosion-tail finding below); Phase 1B
must produce a policy v2 or constrain its training terrain before building
selection on it. The
mandatory empirical question — does an individual's exact result change
because unrelated ghost vehicles share its world or the cohort is permuted?
— was measured before the evaluator was built, and the answer is **no
under isolation, not under shared worlds**: a zero-axle sled's trajectory
diverges at the f64 bit level depending on cohort composition (with no
contact, proximity, or monotone rule required), so the evaluator runs **one
isolated world per individual** and an individual's result depends only on
its own genotype and the declared spec. A committed 20-individual fixture
(`population-a-initial-composite`) locks the canonical population digest,
the exact fitness-vector digest, every per-member fitness, the deterministic
champion, and the champion's trace digest, reproduced **bit-exact across
Ubuntu, Windows, and macOS (Node 22) and pinned Chromium 149**
(`npm run test:determinism`, `npm run test:browser`). The
[characterization report](docs/ga-phase-1a-population-fitness-report-2026-07-12.md)
(`npm run probe:population`) records what the seeder actually produces:
repair touches ~99.5% of raw draws (the repaired-ownership ruling is the
common path), distinct raw genomes never collapse to duplicate canonical
ones, and — the load-bearing Phase-1B finding — the raw max-progress metric
has a finite-physics-explosion tail on rough terrain (a minority of
individuals hit terrain features and are catapulted to enormous but finite
displacement), which future selection must handle. This builds on the
per-wheel surface-speed drive law and the deterministic-evaluation trace
and physics-budget gate: one canonical headless runner
(`src/sim/evaluation.js`, wall-clock-free) owning terrain construction,
vehicle realization, the fixed-step loop, and a versioned per-step trace
(raw little-endian f64, fixed 128-byte records, streaming FNV-1a digests
with per-step checkpoint states), with S0/S1 realization, honest N/m
springs, and every earlier locked fingerprint byte-identical.
`npm run bench:physics` still measures the physics cost baseline (paired
interleaved sampling; reference machine i7-14650HX, 2026-07-11: the
deterministic flavor's stepping tax is a consistent **≈1.0–1.13×**; full
table in
[`docs/bench-physics-reference-2026-07-11.md`](docs/bench-physics-reference-2026-07-11.md),
machine-specific, never a package property). **Physics Integrity:
Finite-Explosion Reproduction and Ablation — landed** (the corrective
investigation between Phase 1A and Phase 1B): the explosion tail is **not**
a terrain interaction — it is **Rapier 0.19.3 constraint-solver divergence
under the project's current legal multi-module joint realization**
(wide-track wheel anchors on a light chassis; no incorrect spawn, terrain,
motor, CCD, or initial-joint setup was found, while the realization
architecture itself remains a possibly-mitigable open design direction).
It reproduces on completely flat ground, undriven, on both engine flavors —
and under some ordinary load. The committed `load` pass runs the crossing in
genuinely free space (no floor at all, static colliders 0, zero gravity), so
a divergence there is unambiguously internal-load-driven: the fully unloaded
all-S0 island is quiescent on all four witnesses, and drive-motor load alone
(a single-variable comparison against that quiescent island) initiates the
divergence with no contact on three of four. An undriven S1 vehicle diverges
too, though that arm does not separate spring preload from the S1 topology.
Drive is not necessary and cannot account for the catastrophic energy, though
motor torque can excite the island. Directly measured constraint violations
(revolute anchors and prismatic off-axis errors > 2 cm, coordinates through
their limits) precede the kinematic anomaly; no tested exposed engine
setting cured it (more solver iterations accelerate it, dt 1/120 can worsen
it by ten orders of magnitude, CCD is inert, and gravity magnitude is
immaterial — 9.81 and the project's 20 give the same classification). The witnesses are frozen as reproducible
identities, a materialized two-axle minimal reproducer with its full
instrumented closure matrix is committed, and a forensic instrument
(`npm run probe:physics-explosion`; identity-only hard checks, physics as
observations, `-- --pass reproducer` as the engine-upgrade recheck) plus
the full report
([`docs/physics-integrity-finite-explosion-report-2026-07-13.md`](docs/physics-integrity-finite-explosion-report-2026-07-13.md))
document the ruling. Prevalence — regenerable from the committed
`prevalence` pass — is ~8% of generation-0 morphologies (5/60), two of
which hide catastrophic internal speeds behind ordinary-looking fitness —
so raw `maxForwardDistance` mis-ranks in both directions, on flat terrain
included. No production physics changed; every lock and version constant is
byte-identical; the score policy stays v1. **The Rapier core-0.34 verification
spike in PR #19 reports Outcome B** (a Layer-2 diagnostic, not a dependency
change): the npm pins are the latest stable JS packages (core ~0.30.1), and the
current upstream monorepo (`dimforge/rapier@c13133ad`, core 0.34) was built from
source and run against every committed contract — reproduced by a committed
`workflow_dispatch` experiment whose citable `heavy=true` run (a same-commit
stable-vs-candidate pair) confirmed the verdict at classification level.
**Verdict: the divergence persists on core 0.34** — the reproducer stays
catastrophic on both flavors, prevalence is the same 5/60, and a fresh seed adds
2/20. On the surfaces that complete on both arms the candidate is clean
(internally deterministic, no contract regression, and the population
fitness-vector digest agrees across Node and Chromium — the one digest
mechanically comparable across environments, not a broad cross-env claim);
**but a new CI finding reinforces Outcome B — core 0.34 cannot complete
the forensic witness matrix, crashing it unrecoverably (a `world.free()`
borrow-guard panic, then a `RuntimeError: unreachable` trap), while stable
0.19.3 completes it cleanly.** A new `--arm multibody`
reproducer arm shows reduced-coordinate realization is quiescent on both cores —
so the joint *representation* / constraint-enforcement regime (not the engine
version) is the lever, measured for the undriven reproducer only — but all
multibody motors/limits stay commented out of the JS bindings, so that path is
not yet usable for the driven phenotype. Full evidence, the controlled
`workflow_dispatch` experiment, and the `engine-assertion-taxonomy` triage map
are in [`docs/rapier-034-spike-2026-07.md`](docs/rapier-034-spike-2026-07.md);
no production dependency or lock changed. **The numerical-integrity policy then
landed** — the GA-safety gate that unblocks Phase 1B. A small, always-on,
engine-neutral online detector (`src/sim/integrity.js`, policy v1) folds three
kinematic scalars per body — instantaneous speed, one-capture velocity change,
one-capture displacement — from the per-body reads the runner already takes each
step (no trace, no engine query, no per-step allocation), and classifies each
vehicle `ok` / `nonFinite` / `numericalDivergence`. A catastrophic crossing
(body speed > 1000 m/s, any body) makes a vehicle **non-selectable** under
fitness policy v2 (`fitness = valid ∧ integrity-ok ? maxForwardDistance : 0`),
and `selectableChampionFromEvaluation` filters the unselectable out of selection
entirely (returning null when none survive) — so solver divergence can never
become selectable fitness, including the two known cases that hide a >1000 m/s
blow-up behind ordinary-looking forward distance. The online detector agrees
BITWISE with the offline `analyzeTrace` over the same run (shared arithmetic,
the pinned `effectiveDt` convention), the fold costs nothing measurable (it
reads values already in hand), and it required only one deliberate fitness-vector
re-lock — the committed fixture measured 20/20 integrity-clean, so every
per-member fitness, the champion, and the champion trace stayed bit-identical,
reproduced across Node (3-OS) and pinned Chromium. `npm run probe:integrity`
characterizes it (signals panel, prevalence, the mutation-neighborhood probe,
cost): the five known-affected subjects all become fitness 0, every control and
fixture stays selectable at 180–600× margin below failure, clean parents show no
false-positive halo, and the false-negative watch list is empty across all 60
characterization individuals and 48 neighborhood children. A review follow-up
hardened the seams without moving any lock: integrity is validated before the
validity short-circuit (malformed detector output is refused loud, never a
silent zero), the online/offline agreement check covers the full derivable
classification, the mutation-neighborhood jitter preserves categorical genes
(an accidental S2 crossing can no longer abort the experiment), and the
engine-upgrade tripwire now reads the fitness-vector lock from one source — a
structured mismatch marker validated against `population-locks.js` at
adjudication time — instead of a copied digest literal that staled on
re-lock. Full contract in
[`docs/numerical-integrity-policy-2026-07.md`](docs/numerical-integrity-policy-2026-07.md);
no physics changed and the A–D evaluation golden digests are byte-identical.
The first Phase-1B preparatory PR then landed the **canonical schema and codec
foundations**: one validated schema walk over the genotype
(`genotypeFieldWalk` / `forEachGenotypeField`, classifying every field as
version, structural, discrete, or continuous) plus lossless decoders for all
five canonical byte encodings — genotype, population snapshot, initialization
manifest, evaluation spec, and fitness vector — behind a shared strict
little-endian reader and a canonical lowercase-hex representation for JSON
envelopes. `serializeGenotype` stays the byte-layout authority and is
unrestructured; the schema is a mirror bound to it by a copy-declared literal
walk, tiling identities, and perturb-one-leaf byte exclusivity against the real
serializer. Each decoder mirrors exactly the validation its encoder performs —
which is why the evaluation-spec decoder deliberately does not run
`resolveSpec` (that would reject streams the encoder legally produces;
execution validation stays with `evaluatePopulation`) — and every decoder fails
loud on truncation, trailing bytes, unknown versions, and malformed data rather
than repairing it. Two encoders gained an additive digest-state input so a
decoded record can be re-encoded from itself, and two silent wire-overflow
holes (u8 axle count, u8 range length) now fail loud without changing any valid
stream. No evolutionary behaviour is implemented, and every committed
lock — terrain, noise, assembly, evaluation A–D, and all four population
digests — is byte-identical. Full contract in
[`docs/canonical-codec-foundations-2026-07.md`](docs/canonical-codec-foundations-2026-07.md).
Next: **GA Phase 1B — Mutation-Only Evolution** (selection, elitism,
deterministic mutation, generational replacement), now unblocked — elitism
consumes `selectableChampionFromEvaluation`; the multibody binding-extension
feasibility investigation, zone material response, S2 trailing arms, and worker
sharding are deferred behind it, each in its own PR. The design docs in `docs/`
define
everything that comes after.

## Quickstart

```bash
npm install
npm run dev              # corridor terrain scene at http://localhost:5173
npm test                 # full suite: PRNG/terrain locks + headless Rapier (both flavors)
npm run test:determinism # the narrow golden-lock + fresh-module determinism gate
npm run test:browser     # the Chromium gate (one-time: npx playwright install chromium)
npm run bench:physics    # the physics cost matrix (instrument; -- --smoke for a quick pass)
npm run lint             # includes the determinism ban on src/sim
npm run build            # production bundle in dist/
```

Requires Node 20.19+ (built and verified on Node 22).

## CI and deployment

Every push to `main` runs lint + tests + build; runs can also be triggered
manually from the Actions tab (**Run workflow**). Green runs deploy `dist/`
to GitHub Pages at https://jpturcotte.github.io/boxcar3d/ — the Vite base
path derives from the repo name automatically. (Pages on a private repo
requires a plan that supports it; otherwise flip the repo public, or use
`npm run dev` locally.) The 2025 prototype survives in `legacy/` and in the
repo's history, joined by the "Join histories" merge.

## Working on this with Claude Code

Open the repo folder in Claude Code — it automatically reads `CLAUDE.md` at
session start, which carries the project's hard rules (determinism, sim-time
purity, tests-first, scope walls) and points into `docs/` for the full design.
Good first prompt: *"Read CLAUDE.md and docs/, then start Phase 1 step 1:
the composite corridor terrain, [V1] layout test first."*

## Repository map

```
CLAUDE.md                 Operating manual (auto-loaded by Claude Code)
docs/                     Canonical design docs: spec v2, migration delta, red team
src/sim/                  Deterministic core — prng.js, physics adapter; Node-safe
src/render/  src/ui/      Three.js rendering and controls (wall clock allowed here)
src/workers/              Population sharding (Phase 1, later steps)
tests/                    Vitest: locked PRNG stream, Rapier smoke (both flavors)
.github/workflows/ci.yml  Lint + test + build + deploy to Pages
```

## The rules that make seeds shareable

All simulation randomness flows from one integer seed through
`src/sim/prng.js` (xoshiro128**, per-vehicle forked streams); `Math.random`
and library trig are lint-banned in simulation code; every sim clock counts
fixed physics steps. Replay/seed mode runs on Rapier's deterministic build.
The why behind each rule lives in `docs/boxcar3d-red-team-2026-07.md`.
