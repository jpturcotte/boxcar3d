# BoxCar3D

Evolving 3D vehicles in a corridor world — a genetic-algorithm sandbox inspired
by BoxCar2D. Vehicles drive forward only (no steering, no AI) through
procedurally generated 3D terrain with elevations, craters, obstacles, and
surface types, bounded by physical walls. Morphology is the point: evolving
frames, multiple suspension types, and free wheel arrangements.

**Status:** GA Phase 1B PR 3 — the deterministic evolution engine, byte-only
history, replay, and strong artifact identity — landed on the Phase 1A
population/fitness foundation and PR 2's pure operators. **BoxCar3D now evolves
end to end and can persist, verify, and replay a run.** Given a population seed
and a declared evaluation configuration it produces a canonical repaired
population and an exact, reproducible fitness vector whose per-individual
results are independent of cohort membership and ordering; it then advances
generation over generation — elites copied with fresh ids, children drawn from
their own `(seed, childId)` streams — and commits each generation to a
versioned artifact with SHA-256 component, chain, and whole-history digests
that Node (three OSes) and pinned Chromium reproduce byte-for-byte. PR 4 owns
the empirical experiment, the fitness/diversity report, and validation or
deliberate tuning of the provisional mutation defaults, which PR 3 records in
every history header but has never measured. A live initializer
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
cross-environment-locked. It was *not* selection-ready as first written,
because of the explosion-tail finding below; the numerical-integrity PR
answered that with **fitness policy v2**, which ships today
(`FITNESS_POLICY_VERSION = 2`): an integrity-failed individual is
unselectable and scores 0, and `selectableChampionFromEvaluation` returns an
explicit `null` when a generation has no selectable member. The
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
than repairing it. A decoded spec is directly replayable: `resolveSpec` now
accepts the `termination` key it derives, so a resolved spec re-enters the
resolver and re-encodes byte-identically. Two encoders gained an additive
digest-state input so a decoded record can be re-encoded from itself; three
silent wire-overflow holes (u8 axle count, u8 range length, u32 initialization
`populationSize`) now fail loud without changing any valid stream; and the
codec family enforces an ownership boundary settled by a full caller-trust
inventory — every variable-length field is read by index (the same reading its
consumer performs), no caller-owned method is ever invoked, encoders attest
exactly the bytes their validation checked, byte geometry comes from intrinsic
TypedArray getters, and no attested record retains a caller reference — so a
count byte, its allocation, its payload, and the record a digest attests can
no longer disagree with each other or with what the run executes. **Those rules
are now enforced by the build rather than by prose** — a lint ban on
caller-visible byte geometry (and on `subarray`, which is species-aware and ran
caller code even when borrowed from the prototype), plus an ownership-boundary
suite that feeds shadowed geometry to every function accepting caller bytes and
asserts the *result* is identical to the un-shadowed call, a seeded
boundary-value round-trip harness, and a permutation-invariance check on the
champion selectors. On top of that sits the **single-read invariant**: any
caller-owned value used to validate, order, attest, encode or execute is
captured once and every later operation reads the capture, so a value cannot be
checked on one reading and used on another — enforced by a suite that
instruments every own property of a caller input with a counting accessor and
asserts at most one read per path (universal over an input's fields; the input
set is a curated table, backstopped by a coverage tooth that derives the
function-export surface and fails until each export is covered or exempted).
That closed an execution-constraint bypass (a spawn position
approved on the flat pad and then *run* off it, with the digest attesting the
position that never executed) and made duplicate individual ids a loud refusal
in both champion selectors. A further pass then went after the *instruments*
themselves, on the principle that enforcement scoped to one round's mechanism
is still enforcement written to the fix. It found the exemption those
instruments declared to be false — a genuine Array's `length` cannot be an
accessor, but it *is* writable, and every element read in a validation walk is
caller code that may write it, which let a three-axle genotype attest itself as
one axle and made the determinism comparator report "identical" for divergent
traces — plus a trust axis nobody had posed, own-property *enumerability*,
where a presence check that saw a non-enumerable `seed` and a spread that did
not made an evaluation run and attest the default world. Loop bounds are now
captured before any walk, presence gates use the enumeration their consumer
reads with, the runner validates a module-owned capture rather than the
caller's objects, the export tables and lint scope are derived from the real
directory instead of hand-enumerated, and a decode-table golden pins what the
archived bytes *mean* — reordering the suspension enum reinterprets every
stored genotype while both byte fingerprints stay identical, which nothing
previously caught. A final adversarial pass whose success criterion was
*breakage* then proved that round had, in turn, falsified its own guarantees:
the runner captured a spawn's position but not its rotation or velocity, so a
validated orientation executed as a different one; a seed guard was slipped by
an accessor that deleted the key between the check and the read; and the
determinism lint bans were silently disabled in the seven most important files.
Those are fixed too — spawn poses captured component-by-component, terrain
captured once, the lint bans re-applied and proven to fire, the decode golden
widened to cover the gene-decode scales it had missed, and fancy byte storage
(detached, shared, resizable, cross-realm) rejected at the door rather than
silently read as empty. Each tooth was mutation-verified: revert the fix, watch
it fail. An external review then proved the storage claim was itself scoped to
the discovered sites — the digest fold still returned its state unchanged for
a detached buffer, and byte equality called two detached arrays equal — so the
gate now covers a *derived* classification of every byte-family export
(module set from the lint block, export set from the real namespaces, every
gated seam battered against all three fancy stores), and the one remaining
finding — trace evidence staying mutable after its digest is computed — is an
explicit, documented deferral, its failure mode stated at both sites, rather
than an open hole. Its expiry was written chronologically ("when Phase 1B
persists history") and PR 3's Commit 0 narrows it, by approved decision, to the
semantic trigger it always meant: the hardening expires when a *non-null trace*
crosses a persistence, replay, determinism-lock, or artifact-identity boundary.
PR 3's evolution history is byte-only and evaluates at trace mode `none`, so
persisting evolution bytes moves no trace across any boundary — and that premise
is enforced by static and runtime trace-exclusion tests, not by prose.

**GA Phase 1B PR 3 then closed the loop:** a deterministic
evolution engine now runs generations end to end and persists them as a
**byte-only, versioned history with SHA-256 artifact identity**. The public
surface is deliberately tiny — create a run, advance it, ask its status, take a
fresh copy of its history, or resume one — and there is no public
`advanceGeneration(population, evaluation)` at all, because a stateless
transition would have to decide whether an independently supplied population and
fitness result belong together, and the only binding available for that is a
32-bit hash this repo has already ruled is *not* identity. So the transition is
private to an opaque run that decodes the population from bytes it owns and
evaluates exactly those. Elites are copied with **fresh** ids, every child draws
from its own `(seed, childId)` stream, terminal conditions are decided once
before any digest exists, and a failed advance leaves the committed artifact
byte-identical — a retry reproduces the same generation. Resume verifies in ten
ordered stages (framing, header, every component digest, the chain, the whole
artifact, external freshness, then the exact engine version — all *before* any
physics runs) and replays deterministically, reporting the first divergence by
generation, stage and byte offset rather than "the history digest is wrong".
The `evolution-a-small-flat` locks reproduce on Ubuntu, Windows, macOS and
pinned Chromium, which agreed on the first run — including the new WebCrypto
seam. Twelve deliberate sabotage mutations all redden a test; one of them was
*silent* on the first attempt and exposed a real gap in the ordering tests,
which is exactly why the checklist is run rather than assumed. Every committed
lock — terrain, noise, assembly, evaluation A–D, and all four population
digests — remains byte-identical. Full contracts in
[`docs/canonical-codec-foundations-2026-07.md`](docs/canonical-codec-foundations-2026-07.md)
and
[`docs/ga-phase-1b-pr3-evolution-history-2026-07.md`](docs/ga-phase-1b-pr3-evolution-history-2026-07.md).
That durable contract also records the adversarial test-evidence audit,
independent Kimi interoperability fixture, resource ceilings, known O(G²)
append cost, and deferred extensibility/runtime roadmap. The reproducible
sabotage harness and its 12/12 result live under `scripts/adversarial/`.
Next: **GA Phase 1B PR 4 — the empirical experiment**: a real population over
many generations, the fitness and diversity report, runtime cost, and the
validation or deliberate tuning of the provisional mutation defaults, which PR 3
records in every history header but has never measured. The multibody
binding-extension feasibility investigation, zone material response, S2 trailing
arms, and worker sharding are deferred behind it, each in its own PR. The design
docs in `docs/` define everything that comes after.

## Quickstart

```bash
npm install
npm run dev              # corridor terrain scene at http://localhost:5173
npm test                 # full suite: PRNG/terrain locks + headless Rapier (both flavors)
npm run test:determinism # 6-file golden/fresh-module + operator + evolution gate
npm run test:browser     # the Chromium gate (one-time: npx playwright install chromium)
npm run probe:evolution  # the identity-only evolution instrument (--json for the report)
npm run bench:physics    # the physics cost matrix (instrument; -- --smoke for a quick pass)
npm run lint             # includes the determinism ban on src/sim
npm run build            # production bundle in dist/
```

Requires Node >=22.12 and <23, matching `package.json`; the repository pins
npm 10.9.3 through its `packageManager` field.

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

## Phase 1B PR 2 operators

`selectablePoolFromEvaluation` creates an immutable v1 in-memory selection
pool from a v2 fitness evaluation: it retains every evaluated id in ascending
order, and only `valid && integrityStatus === 'ok'` members can compete.
`evolution-operators.js` applies a three-draw tournament with replacement
(higher fitness, then lower id) and returns up to two canonical, owned elites.
Elitism attests the population bytes and compares the pool's FNV-1a state as an
**in-process mismatch sentinel only**; it is not cryptographic identity or
equality.

Continuous mutation uses provisional Phase 1B baseline defaults of
`{ probability: 0.05, magnitude: 0.05 }`.
It consumes one `nextFloat()` decision per continuous f64 leaf and a second
draw for every selected leaf. The signed delta is in
`[-magnitude, +magnitude)`, values clamp to `[0, 1]`, and repair runs once.
`rawGenotype` is diagnostic-only; `genotype` is the owned repaired hereditary
result. Raw and final schemas remain identical to the parent, and structural,
discrete, and version bytes remain bit-exact. Frozen accounting separates
continuous-leaf changes from complete-stream byte deltas and records repair
introduced, erased, and redirected effects. PR 3 remains responsible for the
generation engine, child ids, lineage, persisted history/codecs, replay/
determinism gates, and the evolution probe. PR 4 owns the empirical report and
validation or tuning of those defaults. Crossover, structural mutation, and
discrete mutation are explicitly deferred.
