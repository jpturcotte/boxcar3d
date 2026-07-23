# CONTEXT — BoxCar3D experiment vocabulary

Terms used by the GA Phase 1B PR 4 evolution experiment
(`scripts/experiment-evolution.js`, `docs/ga-phase-1b-pr4-evolution-experiment-2026-07.md`).
Each term is defined ONCE here; the code and the report use these words with
exactly these meanings and nothing else.

This file is deliberately small. It is a glossary, not an architecture
document — the canonical design docs live in `docs/`, and the module-level
rulings live in the module headers.

---

## experiment arm

One mutation configuration under test: the resolved pair
`{ probability, magnitude }` handed to `createEvolutionRun`'s
`evolution.mutation`. An arm is identified by a stable string `armId`
(`control` for `(0, 0)`; otherwise `p<probability>-m<magnitude>` with both
numbers formatted to three decimals, e.g. `p0.050-m0.050`).

An arm is a configuration, never a result. The same arm appears in both phases
with the same id.

Three arms have standing names:

- **baseline** — `(0.05, 0.05)`, the provisional Phase 1B defaults PR 2 shipped
  and this PR exists to validate or replace.
- **control** — `(0, 0)`, selection and elitism with no mutation at all. It is
  the *no-variation* reference: it measures how much of any observed gain comes
  from selection re-sorting generation 0 rather than from mutation producing
  anything new. **The control is never eligible to become the new default** —
  a zero-mutation default would make the operator inert.
- **candidate** — whichever eligible **non-control** arm screening ranks first,
  chosen by the screening rule and never by inspection. There is at most one.
  The baseline is ranked as an ordinary arm, so the candidate **may be the
  baseline itself** — and is, whenever no other arm outranks it or no arm is
  eligible at all. `candidateIsBaseline` records that state, and when it holds
  the only reachable decisions are `retainValidated` and `retainInconclusive`.
  (This entry said "non-baseline" while the code excluded only the control; the
  two disagreed about a state the code has an explicit field for.)

## replicate

One paired `(populationSeed, terrainSeed)` pair, drawn from a phase's declared
seed list by index. Every arm in a phase runs every replicate, so arms are
compared **paired**: arm A and arm B at replicate *r* face the same starting
population and the same terrain, and differ only in mutation parameters.

A replicate is an experimental unit, not a repetition for noise-averaging: the
comparison statistic is computed *within* a replicate and then aggregated
across replicates.

## run

One `createEvolutionRun` … `advance()`-to-terminal execution: one arm × one
replicate × one phase. Identified by `runId` = `<phase>:<armId>:r<replicateIndex>`.
A run is the unit of resumption — a run either completed and has a committed
record, or it did not and is executed again from the start.

## screening set

The first phase's seeds and arms: 26 arms (control + the 5×5 factorial grid)
× 6 replicates × 30 generations, population seeds 20260744–20260749 paired
with terrain seeds 20260750–20260755.

Screening **proposes**. It may not authorize a default change on its own,
because choosing the best of 26 arms on 6 shared seeds will pick noise some of
the time.

## confirmation set

The second phase's seeds and arms: the candidate, the baseline and the control
× 16 replicates × 60 generations, population seeds 20260756–20260771 paired
with terrain seeds 20260772–20260787.

**Disjoint from the screening set by construction** — no seed appears in both,
and the runner refuses a protocol where they overlap. Confirmation **decides**:
only its predeclared gate can authorize a default change.

## selectable fitness

Fitness policy v2's selection-eligible score
(`src/sim/population-evaluation.js`): an individual's `maxForwardDistance`
when its result is valid **and** its numerical-integrity status is `ok`, and
`0` otherwise.

Everything in this experiment that says "fitness" means selectable fitness. It
is the only score the engine will select on, so it is the only score a tuning
decision may be made from. Raw progress metrics are deliberately NOT used: the
Phase-1A finite-explosion tail (a vehicle catapulted to 8.17e6 m and still
`valid`) would dominate any mean computed from them.

**selectable champion** — the highest selectable fitness in a generation, or
`null` when the generation has no selectable individual at all. `null` is not
zero: it ranks below every finite result, and it is reported as `null`, never
as `NaN`, `Infinity`, or a sentinel number.

## genotype uniqueness

The count of DISTINCT canonical genotype byte streams in a generation
(`serializeGenotype`, compared as bytes), divided by the population size to
give `uniquenessRatio` ∈ (0, 1].

Exact and cheap, and it answers exactly one question: has the population
collapsed onto literally identical genomes? It does **not** detect near-clones
— a population of twenty genotypes differing in the last ulp of one gene scores
1.0. That is why the dispersion metric below exists, and why the gates use both.

## gene-space dispersion

Mean pairwise normalized L1 distance over canonical gene paths.

For a pair of individuals, walk the canonical genotype field walk
(`genotypeFieldWalk`, the metadata mirror of `serializeGenotype`) and take
every `f64` leaf — i.e. every `[0, 1]` gene, continuous and discrete alike.
Per path: the absolute difference where both individuals have that path, and
distance `1` where only one does (a genotype with more axles has strictly more
paths — the walk is a prefix-extension, so "only one side has it" is exactly
the extra-axle tail). Sum, divide by the size of the union. The result is in
`[0, 1]`.

The generation's dispersion is the mean over all `n(n−1)/2` unordered pairs,
accumulated in ascending-individualId order so the floating-point sum is
reproducible.

This is a **diversity floor guard**, not an objective. It exists so a tuning
that wins on fitness by collapsing the population cannot pass: a converged
population is a population that has stopped searching, and the gates require a
candidate to keep dispersion within a declared fraction of baseline's.

## eligible / candidate / decision

- **eligible** — an arm that passed screening's guardrails (termination
  behaviour, selectable rate, dispersion floor). Eligibility is a filter, not a
  ranking.
- **decision** — the **gate's** single verdict, one of:
  - `retune` — a non-baseline candidate passed every confirmation gate. This is
    the gate's finding, **not** a record that anything changed: whether
    `PARAMETRIC_MUTATION_DEFAULTS` actually moves is a separate maintainer
    disposition, recorded beside the verdict in `adoption` (`ADOPTION_RULING`).
    PR 4's gate returned `retune` and the maintainer declined it, so the two
    fields deliberately disagree in the committed artifact. Reading `decision`
    as "the defaults were changed" is exactly the adoption hazard `adoption`
    exists to prevent — an earlier version of this entry reintroduced it here.
  - `retainValidated` — the defaults stay at `0.05/0.05` AND baseline itself
    beat the control on the confirmation gate, so "mutation-only evolution
    works at the current defaults" is an evidenced claim.
  - `retainInconclusive` — the defaults stay, and nothing stronger is claimed.

`retainInconclusive` is a real, reportable outcome. It is not a failure of the
experiment and it must never be talked around.
