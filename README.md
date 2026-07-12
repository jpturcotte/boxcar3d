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
has at least one axle and at least one genuinely driven wheel. The
**repaired** genotype (`compileAssembly(...).genotype`) is the heritable
truth, carried as canonical population content
(`src/sim/population.js`); a raw operator draw can never survive as a
hereditary record. Fitness is **maximum forward progress** from the spawn
position — a new `maxForwardDistance` result field on the canonical runner
(alongside `stepAtMaxForwardDistance` and `maxBackwardDistance`), folded
from the same per-step chassis read the trace already consumes, so the
existing A–D golden digests are byte-identical with no re-lock. The
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
machine-specific, never a package property). Next: **GA Phase 1B —
Mutation-Only Evolution** (selection, elitism, deterministic mutation,
generational replacement), which must first decide how to handle the
physics-explosion fitness tail; zone material response, S2 trailing arms,
and worker sharding are deferred behind it, each in its own PR. The design
docs in `docs/` define everything that comes after.

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
