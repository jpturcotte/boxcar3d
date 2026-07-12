# GA Phase 1A — Population & Fitness Foundation: process & characterization report

> **Committed contract facts** (Node + pinned Chromium, deterministic flavor,
> rapier 0.19.3) are the digests and per-member fitness literals in
> `src/sim/population-locks.js`, re-proved by `npm run test:determinism` and
> `npm run test:browser`. **Offline characterization** (this document's
> distribution/viability/undriven tables) is deterministic at the declared
> seeds but is NOT asserted by any CI gate. **Machine-specific** figures are
> the wall-clock cost table only (reference machine: i7-14650HX, Windows 11,
> Node 22, 2026-07-12). **Design inference** is called out inline. All numeric
> claims below come from `npm run probe:population -- --pass all --n 1000
> --seeds 20260725,20260728,20260729 --size 20` unless stated otherwise.

This PR builds the scientific instrument GA Phase 1B (deterministic
mutation-only evolution) will trust: a canonical repaired population, stable
individual identities, a transparent maximum-progress fitness, exact
per-individual results independent of cohort membership and ordering, and
reproducible population/fitness byte encodings — with the empirical question
of shared-world cohort independence answered by measurement rather than
assumption.

---

## 1. Initial hypotheses

- **Seeder viability:** most initial individuals would move at least a little;
  a meaningful minority would be inert (near-zero power, bad geometry).
- **Repair frequency:** repair would touch a *modest* fraction of raw draws —
  the R2/R5 rules fire on unlucky geometry, expected well under half.
- **Duplicate collapse:** repair clamps could collapse distinct raw genomes to
  identical canonical genomes at a measurable rate.
- **Rollback:** `maxForwardDistance − forwardDistance` would be small for most
  individuals (a few tenths of a metre of settle/backslide).
- **Cohort independence:** shared-world ghost evaluation would be bit-exact
  across cohort composition and order — the fixture-A identical-ghost lock
  made this look likely, so one shared world for the whole population would be
  the cheap, correct architecture.

## 2. Pre-implementation (measurement-independent) decisions

- **Fitness = maxForwardDistance**, gated on validity, else 0 (spec §5
  "Fitness = max distance"). No drift subtraction, mass division, efficiency,
  complexity, terrain normalization, or multiobjective terms — one transparent
  baseline (mission ruling).
- **Repaired genotype is the heritable truth** (`ir.genotype`); raw operator
  output is diagnostic only. The population layer rejects a non-canonical
  genotype loud rather than silently repairing at evaluation.
- **Initializer separate from `randomGenotype`** (the locked corpus generator,
  `24cd0dd5`, must not change). Fresh declared draw table with the Phase-1A
  biases: symmetry prior 0.8, categorical S0/S1 suspType mask, ≥1 axle, ≥1
  driven wheel by construction.
- **Symmetry prior 0.8** (spec §3.1.2 "bilateral symmetry defaults on") via a
  two-draw half-band split so the gene stays heritable.
- **`minInitialPowerGene = 0`** — the FULL range. An earlier plan proposed a
  0.1 floor; it was rejected pre-measurement as an unjustified prior (the
  driven-by-construction + ≥1-axle + no-S2 + symmetry biases already give the
  population substantial viability, and a floor would exclude 10% of the range
  before learning whether low power is actually a problem).
- **Identity is an explicit `individualId`**, never array position; public
  seams accept any order and canonicalize by sorting a copy.
- **Versioned byte encodings** for content (snapshot), provenance
  (initialization), evaluation identity (spec), and fitness (vector), on
  separate version axes.

## 3. Probe results

### 3.1 Distributions (pure, N=1000, master seed 20260725)

| quantity | result |
| --- | --- |
| axle counts 1..6 | 156 / 173 / 179 / 184 / 146 / 162 (near-uniform, as drawn) |
| wheel counts | 1..12, peak at 3 (125); tail to 12 (5) |
| driven wheels | 1..10, mode 2 (224); every individual ≥ 1 |
| frame families | hull 340 / ladder 318 / spine 342 |
| symmetry | **802 symmetric / 198 asymmetric** (prior 0.8) |
| suspension modules | S0 1691 / S1 1786 (roughly even, as masked) |
| S2 frequency | **0** (mask holds) |
| undriven individuals | **0** (driven-by-construction holds) |
| power | [0.1, 498.2] median 237.0 N·m |
| canonical mass | [84.4, 1575.8] median 800.0 kg |
| max wheel radius | [0.344, 0.806] m |
| **repair-touched raw draws** | **99.5%** |
| recompile-stable | 1000 / 1000 |
| unique raw → unique canonical | 1000 → 1000 (**collapse rate 0.00%**, max multiplicity 1) |

### 3.2 Physical viability (isolatedWorlds, composite terrain seed 20260727, 300 steps)

| seed | valid | zero-fit | ≥1m | ≥5m | ≥10m | Q1/Q2/Q3 max-fwd (m) | **rollback-max (m)** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20260725 | 20/20 | 1 | 15 | 6 | 2 | 1.34 / 3.26 / 5.63 | 4.3×10⁶ |
| 20260728 | 20/20 | 0 | 12 | 4 | 2 | 0.03 / 2.05 / 4.65 | 2.3×10⁷ |
| 20260729 | 20/20 | 1 | 15 | 4 | 2 | 1.26 / 3.00 / 3.58 | 3.6×10⁶ |

Median forward progress is **~2–3 m** across all three seeds; ~60–75% of
individuals clear 1 m, ~20–30% clear 5 m, ~10% clear 10 m. **But the maxima
and rollbacks are absurd** (millions of metres) — see the surprise below.

### 3.3 Undriven audit (champions, all drive genes zeroed — diagnostic only)

| seed | champ id | driven fitness (m) | passive max-fwd (m) |
| --- | --- | --- | --- |
| 20260725 | 19 | 8.17×10⁶ | 1.8×10⁷ |
| 20260728 | 4 | 2.96×10³ | 0.53 |
| 20260729 | 19 | 1.16×10³ | 9.5×10⁶ |

### 3.4 Cohort cost (WALL-CLOCK, machine-specific)

| population size | total ms | ms/step | ms/individual |
| --- | --- | --- | --- |
| 5 | 154.9 | 0.516 | 31.0 |
| 10 | 296.1 | 0.987 | 29.6 |
| 20 | 664.3 | 2.214 | 33.2 |

Cost is ~linear in population size at ~30 ms/individual for a 300-step
isolated-world evaluation (~3.7 ms/individual per 300 steps of a *simple*
morphology; the average here includes 12-wheel individuals). A 20-individual
generation costs ~0.7 s of physics on the reference machine.

## 4. Surprises

1. **Repair is nearly universal (99.5%), not modest.** Uniform geometry genes
   almost always violate R2 (wheel-below-frame clearance) or R5 (longitudinal
   non-overlap), so the repair pass touches essentially every raw draw. The
   64-member pure sample already showed 64/64; the 1000-member sample confirms
   99.5%. **Implication:** "the operator output" and "the heritable genome" are
   almost never the same object — the repaired-ownership ruling is not a
   corner case, it is the common path.

2. **Zero canonical collapse.** Despite near-universal repair, 1000 distinct
   raw genomes produced 1000 distinct canonical genomes (max multiplicity 1).
   Repair clamps individual genes toward feasibility but does not funnel
   distinct genomes to a common fixed point at this sample size — distinct raw
   diversity survives canonicalization. (Hypothesis: the clamps act on
   different genes for different individuals, and the un-repaired genes —
   hue, power, family, node geometry, symmetry — carry enough entropy to keep
   canonical forms distinct.)

3. **THE BIG ONE — a finite physics-explosion tail dominates the raw metric on
   rough terrain.** On composite terrain seed 20260727, a minority of initial
   individuals hit terrain features (craters/ramps/logs) and are catapulted to
   **enormous but FINITE displacement**: the seed-20260725 champion reaches
   `maxForwardDistance = 8.17×10⁶ m` with a final chassis velocity of
   **1.43×10⁸ m/s** while `valid` stays true (finite, all bodies/joints
   valid). This is the trace PR's "velocities to 1e25 m/s stay finite" finding
   manifesting at population scale: the solver does not produce NaN, so the
   non-finite latch never fires, and the raw `maxForwardDistance` metric
   faithfully rewards the blow-up. Median viability is sane (~2–3 m); the
   *tail* is the problem. **The committed contract fixture is unaffected** —
   population seed 20260721 on terrain seed 20260722 tops out at 12.48 m — so
   this is a characterization-terrain phenomenon, not a contract defect, but
   it is the single most important input to Phase 1B (§9).

4. **Shared-world cohort evaluation is NOT invariant** (hypothesis 5 was
   wrong) — see §5.

## 5. Implementation changes caused by evidence

1. **The evaluator runs one isolated world per individual, not one shared
   ghost world.** The pre-implementation cohort-invariance probe (run BEFORE
   any evaluator code was committed) measured, on a flat pad (seed 20260723,
   deterministic flavor), a 5-member heterogeneous cohort (plain S0 / mixed
   S0-S1 / 3-axle S1 / mixed-radius S0 / zero-axle sled). Every **wheeled**
   member was bit-identical solo vs canonical vs reversed vs permuted, but the
   **sled diverged** from its solo trajectory at the f64 bit level in every
   ordering — first at its initial contact solve (capture 3, `translation.x`;
   ~1×10⁻⁴ m by step ~100). Refinement probes established the mechanism:
   - the divergence needs **no inter-vehicle contact** (a neighbor dropped
     from 8 m, airborne for 50+ steps with zero contacts, still perturbs the
     sled at step 3);
   - it needs **no broadphase proximity** (5 m separation, no AABB overlap,
     still diverges);
   - it follows **no monotone composition rule** (`sled+heavy` identical yet
     `heavy+sled` diverges; `sled+s0` diverges yet `sled+s0+heavy` identical).

   The invariant-looking cases (all wheeled members; sled+identical-sled,
   which reproduced the fixture-A ghost-isolation lock) are rounding
   coincidences absent an engine contract, not a guarantee — and evolved
   phenotypes flip, crash, and rest on their chassis, so no phenotype class can
   be exempted. Conclusion: `POPULATION_WORLD_MODE = 'isolatedWorlds'`. An
   individual's exact result then depends only on its own genotype and the
   declared spec, by construction. This is the mission's stated fallback ("if
   Claim D is false … land the simplest architecture that restores exact
   per-individual evaluation — most likely isolated one-vehicle worlds"). The
   divergence is recorded here and in the test/module headers, **never** as a
   permanent must-still-diverge assertion; a shared-world recheck probe rides
   in `scripts/characterize-population.js --pass recheck` for deliberate
   re-runs on an engine upgrade (it still reports divergence today, at step 92
   for the probe's chosen pair).

2. **The evaluation-spec digest binds every resolved terrain knob**, not just
   the seed. An earlier plan bound only `terrainSeed` in the fitness vector
   and leaned on the fixture version for the rest. That is insufficient for a
   general `serializeFitnessVector`: two evaluations sharing a seed but
   differing in any physics-affecting knob must not share an evaluation
   identity. The spec encoding now walks all 33 terrain knobs (via a declared
   walk asserted set-equal to `TERRAIN_DEFAULTS` — a new knob fails the encoder
   loud until declared), maxSteps, flavor, spawn, drive target, and
   wheelFriction-even-when-defaulted.

3. **Population content and initialization provenance are separate
   artifacts.** `serializePopulationSnapshot` binds only ids + canonical
   genotype bytes (identical content hashes identically regardless of how it
   was produced — the format Phase 1B's mutated generations reuse);
   `serializePopulationInitialization` binds the seed/config/manifest. The
   fitness vector binds the snapshot digest, never the initialization manifest.

## 6. Rejected alternatives

- **Modifying `randomGenotype` / reusing its stream.** Rejected: it is the
  locked corpus generator (`24cd0dd5`); a fresh draw table keeps the policy →
  stream map auditable and the corpus lock untouched.
- **Rejection-loop seeding** (redraw until ≥1 driven wheel). Rejected: a
  forced-axle construction (draw the driven axle index up front, remap its
  driven gene into [0.5,1)) gives the guarantee with a *fixed* draw count, so
  no individual's stream depends on another's rejections.
- **Final-displacement fitness.** Rejected: the max-progress metric earns its
  keep even on the clean contract population (individuals 4 and 15 have
  negative final displacement but positive maximum progress).
- **Drift-floor subtraction / passive-motion subtraction.** Rejected (scope):
  the undriven audit measures passive motion for learning but never subtracts
  it; Phase 1A establishes one transparent metric.
- **Approximate cohort equality** (`toBeCloseTo` on shared-world results).
  Rejected: correctness before speed — measure the divergence and isolate,
  never weaken the assertion.
- **A `minInitialPowerGene` 0.1 floor.** Rejected pre-measurement as an
  unjustified prior (§2).
- **Premature caching** of compiled IRs / evaluations. Rejected (scope): no
  caching in this PR.

## 7. Review findings (self-review)

- **Object.is on nested result objects would silently pass** (reference
  identity is always false, but a recursive comparator applying Object.is only
  at leaves is what the cohort/isolation tests actually need). Fixed: every
  cross-run comparison uses a leaf-level exact-tree comparator or byte
  equality — never `Object.is` on an object, never `toBeCloseTo`.
- **Encoder-vs-itself circularity.** Every encoding test asserts against
  hand-built `DataView` bytes on a declared literal (offsets + spot literals),
  not a second call to the encoder.
- **Array-position identity.** The cohort tests use non-contiguous
  individualIds (3/11/27/42/64) and compare strictly by id, so nothing can
  pass by position.
- **Fitness floors disguised as determinism locks.** The population
  determinism gate asserts exact `toBe` literals and *relational* identities
  only (valid⇒fitness===maxForwardDistance; invalid⇒0; champion===recomputed
  argmax-lowest-id); behavioral floors live only in witness tests.
- **Spawn-y f64 vs the fixtures' decimal literals.** `spawnPoseOnFlatStart`
  computes `drop + clearance` in f64, one ulp off the fixtures' rounded
  decimals (0.52 vs 0.5199999999999999). The coherence claim is `≤ EPSILON`;
  the helper's own arithmetic is locked exactly.

## 8. Known limitations

- **One fixed terrain seed for the committed contract** (20260722). No
  cross-seed robustness is claimed.
- **No mutation or selection** (that is Phase 1B).
- **No S2, no zone material response, no worker sharding.**
- **No claim that the initial fitness distribution is scientifically optimal**
  — the lock proves reproducibility, not that one seed is good.
- **The physics-explosion tail (§4.3) is characterized, not remediated** —
  the raw metric is deliberately preserved (scope); handling the tail is a
  Phase 1B decision (§9).
- **The default (non-deterministic) Rapier flavor is never locked** (F10).

## 9. Consequences for GA Phase 1B (deterministic mutation-only evolution)

1. **The raw `maxForwardDistance` metric has a physics-explosion tail that
   will dominate tournament/elitist selection on rough terrain.** A single
   catapulted individual scoring 8×10⁶ m will win every tournament and
   monopolize elitism, even though it is a solver artifact (1.4×10⁸ m/s), not
   locomotion. **Phase 1B must decide how to handle this** — candidate
   approaches (design inference, to be measured there): a physical-plausibility
   validity bound (e.g. reject a result whose peak chassis speed exceeds a
   generous multiple of the drive surface speed), a finite-but-bounded fitness
   cap, or rank/tournament selection that is inherently robust to magnitude
   outliers. This is the single most important carry-over. It does not change
   the Phase-1A metric (scope), but Phase 1B should not build selection on the
   raw metric without addressing it.

2. **Initial viability is real but modest:** median ~2–3 m, ~10% clearing
   10 m, ~5% effectively inert. Mutation has a viable but low base to improve —
   there is clear headroom and clear signal.

3. **Repair is nearly universal (99.5%), collapse is zero.** Mutation
   operators can perturb genes freely in [0,1] and rely on repair to
   canonicalize; they should expect the repaired child to differ from the raw
   mutant almost always, and they need not fear immediate duplicate collapse —
   distinct mutants stay distinct after repair at this scale. Phase 1B's
   population digest should hash canonical children (this PR's snapshot format
   is ready for that).

4. **No category is starved after repair:** all three frame families,
   both suspension types, wheel counts 1–12, and driven counts 1–10 appear.
   Structural mutation is not required to *reach* diversity in generation 0;
   it is required to *move* between structures across generations. Parametric
   (gene-jitter) mutation on a rich initial population is a reasonable first
   operator; structural mutation (add/remove axle, flip suspension, flip
   symmetry, change family) is the second.

5. **Mutation rates:** the near-universal repair means small parametric jitter
   is mostly absorbed by re-clamping — start **moderately aggressive** on
   parametric rates (repair damps them) and **conservative** on structural
   rates (they change vehicle character; spec §3.1.3 keeps them rarer). To be
   measured in Phase 1B.

6. **Trusted contracts Phase 1B may build on** (stable, versioned, locked):
   `createInitialPopulation` / `sampleInitialGenotype` (draw table v1);
   `serializePopulationSnapshot` (content digest) and
   `serializePopulationInitialization` (provenance); `evaluatePopulation`
   (isolatedWorlds, id-keyed results, per-individual diagnostics);
   `fitnessFromVehicleResult`, `serializeFitnessVector`,
   `championFromEvaluation` (exact tie → lowest id); `spawnPoseOnFlatStart`;
   and the runner's `maxForwardDistance` / `stepAtMaxForwardDistance` /
   `maxBackwardDistance` result fields. Version axes:
   `POPULATION_SNAPSHOT_VERSION`, `POPULATION_INITIALIZER_VERSION`,
   `FITNESS_POLICY_VERSION`, `FITNESS_VECTOR_VERSION`, `EVALUATION_SPEC_VERSION`
   (all 1).

## 10. Process retrospective

- **What made it slower/riskier:** the cohort-invariance question was the real
  risk, and probing it *before* writing the evaluator (rather than committing a
  shared-world evaluator and hoping) is what kept the architecture decision
  clean. Bisecting the sled divergence (contact? proximity? order?) took four
  probe iterations but produced a defensible ruling instead of a guess.
- **Which tests caught real issues:** the exact-tree leaf comparator caught
  that naive `Object.is` on nested objects would have passed vacuously; the
  hand-decoded byte tests caught nothing wrong but are the reason the encodings
  are trustworthy; the characterization instrument caught the physics-explosion
  tail, which no unit test would have surfaced.
- **Which probes were unnecessary:** none were wasted, but the "sled APART"
  rows in an early bisect probe used a mismatched baseline and had to be
  redone — declare the control baseline at the same spawn as the treatment.
- **Repo conventions the next agent should follow:** literals-only lock
  modules with the digest-null re-lock workflow; COPY-DECLARE test genotypes
  (never import fixture objects into new tests); seeds declared per file in the
  2026-07-2x family; `test:determinism` is a hard-coded file list (append new
  determinism files by hand); keep the local run footprint light (this repo's
  sims are CPU-heavy — run narrow vitest files during iteration, full suites
  once at the end).
- **What to do differently in the mutation-only PR:** decide the
  physics-explosion-tail policy (§9.1) FIRST, with a probe, before building
  selection — selection semantics depend on it.
