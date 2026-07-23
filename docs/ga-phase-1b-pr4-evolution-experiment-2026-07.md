# GA Phase 1B PR 4 — Broad Evolution Experiment and Mutation-Default Decision (2026-07)

**Scope owner:** PR 4. This document reports one campaign, executed under a
protocol declared and committed *before* the first run.

**Decision: RETAIN `{ probability: 0.05, magnitude: 0.05 }`.** No production
behaviour changes in this PR.

**The predeclared gate returned `retune` to `(0.20, 0.20)`, and all six of its
checks passed.** That verdict is reported faithfully below and is committed
verbatim in the evidence file. It is **not adopted**, for a reason the gate could
not see and was never asked to: the fitness signal it ranks on is contaminated by
constraint-solver divergence that fitness policy v2 classifies as selectable.
The finding, not the tuning, is this PR's result.

Evidence: [`ga-phase-1b-pr4-evolution-experiment-evidence.json`](ga-phase-1b-pr4-evolution-experiment-evidence.json)
(`boxcar3d.evolution-experiment/1`, 204 runs, evidence digest
`75c849ce97a456e9ee5c12e958c22fb5d340e05f8b141ec842a5d2198ff99d6e`, every run
from the single clean commit `9c5f24c`). Vocabulary: [`../CONTEXT.md`](../CONTEXT.md).

---

## 1. The headline finding

**Mutation-only evolution on the composite corridor produces a selection signal
contaminated by Rapier constraint-solver divergence sitting inside the integrity
ALERT band — which policy v2 deliberately treats as an observation rather than a
failure, and therefore reports as `ok` and fully selectable.**

**This is not a new physics bug.** It is the divergence class PR #17 diagnosed
(ill-conditioned multi-module joint islands; onset on the flat pad during settle;
joint-constraint violation as the earliest measurable event) and that Phase 1A
first saw as the finite-explosion tail. What is new is the *band*: PR #17's and
Phase 1A's witnesses were **catastrophic** (>1000 m/s), and policy v2 already
makes those unselectable. These sit **below** that line, in the band PR-B
consciously left open.

### 1.1 A correction this report has to make about itself

The first version of this document claimed that the zero-mutation control
produced no over-ceiling champion in any replicate, and concluded that mutation
discovers the divergence-exploiting morphologies and that divergence "is not a
property of the initial population."

**Both statements are false, and the committed evidence contradicts them.** The
error came from checking the screening arms — where the control is genuinely
clean, 0 of 180 generations — and generalising to "any replicate" without
checking confirmation. An adversarial review caught it; the numbers below are the
correction, and the evidence now records contamination **per arm** and **at
generation 0** so the claim is checkable rather than asserted.

| arm | over-conservative-ceiling generation slots | distinct champion fitness values | max |
|---|---:|---:|---:|
| screening control `(0,0)` | 0 / 180 | 0 | 13.6 m |
| **confirmation control `(0,0)`** | **60 / 960** | **1** | **363.4 m** |

The confirmation control's 60 slots are **one** individual: replicate 2's
generation-0 champion, at 363.4 m, retained unchanged by elitism for all 60
generations. Re-evaluated through the production runner it peaks at **609.0 m/s**
with `firstAlertStep: 23` — unambiguous divergence, present in the **initial
draw**, before any operator has acted.

**So the honest causal picture is:**

- Divergence **capability exists in the representation before mutation acts**: of
  all 440 unmutated generation-0 individuals, **6.6 %** are alert-band (§1.5).
  This does not establish that mutation cannot *also* create divergent
  morphologies — see the limitation below.
- 5 of the 6 contaminated confirmation replicates have an elevated generation-0
  champion (49.8, 363.4, 49.0, 70.1, 31.3 m, against 7.0–12.6 m for all ten clean
  ones) — contamination is predicted by a **pre-treatment** covariate.
- Contamination is far better predicted by the **seed** than by the arm:
  screening replicate 2 has 24 of 26 arms contaminated, replicates 0/4/5 have
  none.
- Whether contamination incidence **rises with mutation magnitude is not
  resolved.** By magnitude, runs whose final champion exceeds the conservative
  ceiling are 7, 7, 8, 9, 9 out of 30 for m = 0.01 … 0.20 — *monotone
  non-decreasing*, and the Fisher two-sided m=0.01 vs m=0.20 test (**p = 0.771**)
  is underpowered at n = 30 per cell. By probability: 8, 9, 8, 7, 8. This is an
  absence of evidence, not evidence of absence.

What mutation demonstrably does is **amplify the reward**: once such a morphology
exists, selection climbs it because in a 120 m corridor it outscores real
locomotion by one to two orders of magnitude.

**What this campaign does *not* establish — expanded from a later review, which
is why the bullets above are hedged rather than bold.** An earlier draft
summarised this section as *"mutation is not the source."* That is stronger than
the evidence, in two directions:

- **The dose-response null is underpowered, and it is not monotone in the
  direction the summary implied.** The by-magnitude counts 7, 7, 8, 9, 9 are
  monotone *non-decreasing*; at n = 30 per cell, separating a 23 % rate from a
  30 % one needs several hundred runs per cell. This is an absence of evidence,
  not evidence of absence.
- **The control cannot answer the question at all, and it is important to say
  why.** It is tempting to compare the control against the mutating arms: 49
  discordant arm × replicate pairs, every one of them with the mutating arm
  contaminated and its paired control clean. That is **an algebraic identity,
  not a measurement.** With zero mutation and elitism the control is a fixed
  point, so it is contaminated exactly when its generation-0 champion is — and
  by the pairing identity every arm at that replicate *shares* that champion.
  A "control contaminated, mutating arm clean" pair is therefore impossible by
  construction, and the committed evidence confirms it: 0 such pairs exist.
  This is the same trap as "baseline beats control 16/16" (§5); the one-sided
  count carries no information.

And there is direct evidence pointing the *other* way, which the first summary
missed: **screening replicate 3 became contaminated from a generation-0
population containing no alert-band individual at all** (seeds 20260747 /
20260753; 0 of 20 rows alert-band in the escalation-cost artifact, generation-0
champion 10.6 m). Confirmation replicate 10 is a second case with no *selectable*
alert-band individual at generation 0. Whatever the divergent morphologies in
those runs are, mutation produced them.

So the defensible statement is: **divergence capability is present in unmutated
populations, and the seed predicts contamination far better than the arm does;
whether mutation also creates it is not settled here, and there is at least one
replicate where it plainly did.** That matters for §10 step 4 — extending the
grid *upward* may raise the artifact rate in the very campaign meant to produce
a clean signal.

### 1.2 The forensic witness

| quantity | value |
|---|---|
| reported selectable fitness | **1450.0 m** |
| final chassis x | **1406 m** (the corridor's +X end is at **+60**) |
| `integrity.observations.peakBodySpeed` | **818.76 m/s** |
| `integrity.observations.firstAlertStep` | **16** |
| `integrity.observations.firstCatastrophicStep` | **null** |
| `integrity.status` | **`ok`** → selectable |

The catastrophic threshold is 1000 m/s. This individual peaked at 82 % of it and
never crossed it.

### 1.3 The two ceilings, and why the first one was wrong

The first version derived a single "plausibility ceiling" as
`corridor forward distance + no-load speed × run duration` = 104 + 25 = **129 m**
and described it as the distance a vehicle could reach. **That is not a bound on
distance travelled.** It adds a spatial extent to a time-integral: at 5 m/s the
corridor's own 104 m would take 20.8 s, four times the whole run, so the two
terms cannot both be realised. The ceiling was roughly 5× too generous — which is
precisely why the report then "discovered" false negatives and reported them as a
surprise.

Both bounds are now named for what they are — bounds on plausible **locomotion**
distance, **not divergence detectors**:

```
kinematicCeiling    = noLoadSurfaceSpeed × runSeconds   = 5 × 5   =  25 m
conservativeCeiling = corridorForwardDistance + kinematic = 104 + 25 = 129 m
```

25 m is the real **displacement** bound: a wheel rolling without slip at the
no-load surface speed cannot carry the chassis further in the run. 129 m is a
deliberately over-generous envelope. A champion past either is **implausible for
locomotion** — a proxy that flags a slot for suspicion — **not confirmed
divergence.** Only the integrity re-evaluation in §1.2 / §1.4 confirms divergence,
and it does so for the *sampled* champions, not for all 1,537 over-envelope slots.
So the counts below are **over-threshold exposure (an implausibility proxy)**, and
the over-conservative count is a strict lower bound on the over-kinematic one.
Neither feeds any eligibility rule, gate or decision. The contamination is real —
the forensic arm confirms it on every champion it re-evaluated — but "18.7 %" is
an over-threshold rate, not a measured divergence rate.

| phase | generations | over kinematic (25 m) | over conservative (129 m) | distinct champion fitness values |
|---|---:|---:|---:|---:|
| screening | 4,680 | **1,106 (23.6 %)** | 877 (18.7 %) | 106 |
| confirmation | 2,880 | **956 (33.2 %)** | 660 (22.9 %) | 44 |

The last column matters: elitism re-counts one surviving individual every
generation, so the slot counts are an **exposure** measure, not a prevalence. A
statement like "one champion in five" is true of generation slots and false of
individuals. That column is keyed on **`(replicate, fitness)`, not on genotype**
— a retained elite collapses correctly, but two different genotypes with equal
forward distance would also collapse, so **106 and 44 are lower bounds on
distinct individuals**, not exact counts. (The forensic sample in §1.2 uses a
genotype digest for exactly this reason; these per-generation summaries do not
carry the champion genotype, and adding it would mean re-running the campaign.)

The distribution is starkly **bimodal** — a locomotion mode and an artifact mode
with a sparse gap between them:

| champion band | count (screening) |
|---|---|
| below the 25 m kinematic ceiling | 3,574 (76.4 %) |
| 25–150 m — the transition region | 250 (5.3 %) |
| 150 m and above | 846 (18.1 %) |

*(These three bands **partition** the 4,680 screening generations. An earlier
version of this table listed 0–30 / 30–120 / 150–2000 and omitted the 55
champions in [120, 150) — an interval straddling the 129 m conservative ceiling,
i.e. precisely the region that decides how empty the trough is. It made the gap
read 28 % emptier than the data: 195 (4.2 %) rather than 250 (5.3 %). The
bimodality finding stands; the table did not support it as printed.)*

Quantiles across all 4,680 screening champions: p50 **12.7 m**, p75 19.4, p90
**322.7**, p95 546.1, p99 1137.8.

### 1.4 The forensic sample — measured, not inferred

Champion magnitude says a champion is *implausible*; only re-evaluation says it
is *divergent*. `npm run experiment:evolution -- --phase forensics` re-runs nine
declared cases — six screening (three contaminated replicates, three clean) and
**three confirmation**, including the zero-mutation control's contaminated
replicate — and re-evaluates each one's lowest, median and highest selectable
champion through the production runner. Committed output:
[`ga-phase-1b-pr4-evolution-forensics.json`](ga-phase-1b-pr4-evolution-forensics.json).

*(The first version could not express a confirmation case at all: every case
resolved against `protocol.screen` and the runner hard-coded `phase: 'screen'`,
so the phase carrying the strongest positive claim had no re-evaluation evidence.
That is fixed, and the sample now includes the control.)*

| fitness (m) | peak body speed (m/s) | first alert | first catastrophic | status | case |
|---:|---:|---:|---:|---|---|
| 6.1 | 2.1 | null | null | ok | screen p0.200-m0.200 r4 |
| 12.2 | 3.7 | null | null | ok | confirm baseline r0 |
| **12.9** | **142.4** | **39** | null | **ok** | screen p0.200-m0.100 r2 |
| 16.3 | 4.5 | null | null | ok | confirm baseline r0 |
| 23.8 | 6.6 | null | null | ok | screen p0.200-m0.200 r4 |
| **363.4** | **609.0** | **23** | null | **ok** | **confirm CONTROL r2** |
| 635.6 | 646.6 | 18 | null | ok | confirm baseline r2 |
| 1203.9 | 798.0 | 20 | null | ok | confirm baseline r2 |
| 1450.0 | 818.8 | 16 | null | ok | screen p0.025-m0.025 r1 |

27 rows sampled — **23 distinct individuals**; the JSON has all of them. The
distinction is not pedantry: the lowest/median/highest picks of one run can be
the same elite, and paired arms share generation 0, so a row count overstates how
much independent evidence the sample carries. The artifact reports both
(`sampled`, `distinctSampledIndividuals`), keyed on the champion's genotype
digest rather than on its fitness or its id — elitism gives one surviving
individual a fresh id every generation.

**Three results:**

1. **Every over-ceiling row sampled is divergence: 12 of 12 rows — 8 distinct
   individuals — none catastrophic, all `ok`.** But note the sharp limitation
   below: this check *cannot fail*.
2. **The control's contaminated champion is real divergence** (609.0 m/s,
   alert@23) and is a generation-0 individual. This is the measurement behind
   §1.1.
3. **The conservative ceiling has false negatives.** One sampled champion
   reported **12.9 m** — inside the normal locomotion band — while peaking at
   **142.4 m/s**. Under the ceiling, 1 of 15 sampled champions was alert-band.

**A limitation the first version missed, and it is sharp.** The summary field
`overCeilingAllAlertBand` cannot come back false: `alertSpeed` is 25 m/s and the
run lasts 5 s, so 25 × 5 = 125 m < the 129 m conservative ceiling — anything past
the ceiling *must* have crossed the alert threshold at some point. So "12/12 are
alert-band" is entailed by arithmetic, not evidence. What *does* carry
information is the **peak magnitudes** — **372–855 m/s** across the twelve
over-ceiling rows, orders of magnitude past the 25 m/s line with no cluster near
it — and the **absence of catastrophic crossings**; neither is entailed.

*(An earlier version quoted this range as "142–855 m/s". 142.4 m/s is the single
**under**-ceiling false negative discussed two bullets above — a 12.9 m champion
— not a member of the over-ceiling group. Mixing it in understated that group's
floor by 2.6× and blurred the report's own strongest point, which is that no
over-ceiling champion comes anywhere near the alert line.)*

### 1.5 What escalating the alert band would cost

The obvious fix is to make an alert-band crossing a selection failure. The first
version of this report recommended that without measuring its cost.
`npm run experiment:evolution -- --phase escalation-cost` measures it, over every
generation-0 population in the protocol (unmutated, so this is a property of the
initializer and the realization). Committed output:
[`ga-phase-1b-pr4-escalation-cost.json`](ga-phase-1b-pr4-escalation-cost.json).

| | count | of 440 |
|---|---:|---:|
| currently unselectable (policy v2) | 18 | 4.1 % |
| alert-band at any point | 29 | 6.6 % |
| **would newly become unselectable** | **11** | **2.5 %** |

Peak body speed of the newly-failing group: min **142.4**, median **421.9**, max
**994.2** m/s. **None is below 50 m/s.**

That distribution is the answer. If escalation were dangerous, the newly-failing
group would cluster just above the 25 m/s alert line — transient impacts, a wheel
spinning up, a drop into a crater. There is no such cluster: a clean gap
separates healthy vehicles from a group travelling at hundreds of metres per
second. **At this threshold the false-positive risk is effectively nil, and the
cost is 2.5 %, not the 5–15 % feared.**

And in **6 of 22 populations (27 %) the generation-0 champion changes** under
escalation — i.e. in a quarter of runs the individual setting selection pressure
before evolution even starts is an artifact.

**Scope, stated plainly:** this measures the **false-positive** side only.
PR-B's acceptance test also requires the **false-negative** side (divergence that
still passes after escalation), which this campaign does not attempt. Escalation
itself is a production policy change — an `INTEGRITY_POLICY_VERSION` /
`FITNESS_POLICY_VERSION` bump and a deliberate re-lock — and belongs to the PR
that owns that seam, not to this one.

### What it means for PR-B

PR-B recorded that alert-as-failure escalation "remains a policy-v2 trigger,
unmet on the tested corpus." **The trigger is now met**, and §1.5 supplies the
cost measurement that a responsible escalation needs.

One correction to how the first version explained *why* PR-B's corpus did not
meet it. It attributed the gap solely to the absence of selection. That is part
of the story but not all of it: PR-B's population pass evaluates its three
population seeds against a **single terrain realization**, so the corpus varied
populations but not worlds — and this campaign's evidence shows contamination is
predicted far better by the seed pairing than by anything else (§1.1). A corpus
with one world is unlikely to see the effect regardless of selection.

## 2. The protocol, as declared before the first run

Committed in `scripts/experiment-evolution.js` and frozen by
`tests/evolution-experiment.test.js` at commit `44955a9`, before any broad run
executed. Every threshold is pinned to its exact value by a test.

Fixed workload: population 20, 300 steps, deterministic Rapier, isolated worlds,
spawn `{ x: −44, z: 0 }`, established composite terrain with
`startFlatLength: 30`, `startBlendLength: 6` and all other terrain defaults
(craters, features, zones) **on**.

| | screening | confirmation |
|---|---|---|
| arms | control + 5×5 factorial (26) | candidate + baseline + control |
| replicates | 6 | 16 |
| generations | 30 | 60 |
| population seeds | 20260744–20260749 | 20260756–20260771 |
| terrain seeds | 20260750–20260755 | 20260772–20260787 |

Seed sets are disjoint by construction, and `validateProtocol` refuses an
overlapping protocol rather than trusting the literals. (It earned its keep: it
caught a collision in the *smoke* protocol's own seeds on the first run.)

Arms execute in a per-replicate shuffled order (scheduling seed 20260788) so no
arm holds a fixed position in the machine's thermal profile. The scheduling
stream never reaches an evolution run.

**Pairing is verified, not assumed.** Within a phase and replicate, every arm
must report an identical generation-0 population digest and champion — generation
0 is drawn before mutation acts, so this is an identity. All 22 groups pass.

---

## 3. Screening results

Median per-run score is `log1p(final selectable champion) − log1p(generation-0
selectable champion)`.

| arm | p | m | median score | median final dispersion | median final uniqueness |
|---|---|---|---|---|---|
| **p0.200-m0.200** | 0.20 | 0.20 | **2.5216** | 0.0713 | 1.00 |
| p0.050-m0.200 | 0.05 | 0.20 | 1.7748 | 0.0146 | 1.00 |
| p0.100-m0.200 | 0.10 | 0.20 | 1.0544 | 0.0380 | 1.00 |
| p0.200-m0.100 | 0.20 | 0.10 | 1.0064 | 0.0387 | 1.00 |
| p0.100-m0.100 | 0.10 | 0.10 | 0.9826 | 0.0260 | 1.00 |
| *baseline* p0.050-m0.050 | 0.05 | 0.05 | 0.5301 | 0.0063 | 0.95 |
| *control* | 0 | 0 | 0.0000 | 0.0000 | 0.05 |

Selected candidate: **`p0.200-m0.200`**.

**Observations worth recording:**

- **13 of 26 arms are ineligible, every one of them on the dispersion floor.**
  The other two guardrails never *bound* — but "inert" (the first version's word)
  overstates it. The selectable-rate guardrail is evaluated on a **median**, and
  the median conceals a heavy tail: individual generations range from 20/20
  selectable down to 5/20, and integrity failures occur throughout. What is true
  is that no arm's *median* fell far enough to trip the floor, and that there
  were zero `noSelectableParents` terminations in 204 runs. A guardrail that
  never fires because it is measured on the wrong statistic is not the same as
  one that never had anything to catch.
- **The control collapses completely** — dispersion 0.0000, uniqueness 0.05
  (one distinct genotype in a population of 20) by generation 4, and its champion
  never changes from generation 0. Pure elitism plus tournament selection with no
  variation is exactly a fixed point, and the numbers show it.
- **Magnitude dominates probability.** Every one of the top three arms carries
  m = 0.20.
- **The candidate sits on the grid boundary** (the maximum of both axes). The
  optimum may lie outside the tested range; this campaign cannot say.

---

## 4. Confirmation results (held-out seeds)

| gate | value | threshold | |
|---|---|---|---|
| paired wins | 13 / 16 | ≥ 12 | PASS |
| median paired score difference | +0.2244 | > 0 | PASS |
| `noSelectableParents` terminations | 0 | ≤ 0 | PASS |
| aggregate selectable rate | 0.9219 | ≥ 0.8719 | PASS |
| median final uniqueness | 1.0000 | ≥ 0.9000 | PASS |
| median final dispersion | 0.0612 | ≥ 0.0041 | PASS |

**Gate verdict: `retune` to `(0.20, 0.20)`.**

Baseline vs control: **16 / 16 paired wins**, median difference **+0.6433**.

---

## 5. Sensitivity to the contamination (post-hoc)

Post-hoc analysis, labelled as such. It changed no threshold and no protocol —
adding a contamination filter to the gates after seeing the results would be
exactly the reverse-fitting this design exists to prevent.

**Screening — the candidate's identity is NOT robust.** Restricting to the three
uncontaminated replicates `[0, 4, 5]`:

| arm | median (all 6) | median (clean 3) |
|---|---|---|
| p0.200-m0.200 | 2.5216 | 0.9480 |
| p0.100-m0.200 | 1.0544 | **1.0239** |
| p0.050-m0.050 | 0.5301 | 0.4606 |

The selected candidate **flips** from `p0.200-m0.200` to `p0.100-m0.200`. The
arm that entered confirmation was chosen partly on artifacts.

**But that flip is a property of the ranking STATISTIC, not of the comparison —
a correction from a later review.** Screening is a fully crossed paired design:
both arms ran all six replicates against the same starting populations and the
same terrain, which is the comparison unit CONTEXT.md defines. Run the project's
own `pairedComparison` on them and the ordering reverses:

| comparison | wins | median paired score difference |
|---|---:|---:|
| p0.200-m0.200 vs p0.100-m0.200, all 6 replicates | **5 / 6** | **+0.1191** |
| the same, on the clean `[0, 4, 5]` | **2 / 3** | **+0.0790** |

On the very data that is said to reject it, the paired comparator **prefers**
`p0.200-m0.200`. The median-of-three disagrees because the two arms' clean scores
are (0.8178, 1.2442, 0.9480) and (0.7388, 1.0850, 1.0239): `p0.200-m0.200` has
both the higher minimum and the higher maximum and loses only on which value
lands in the middle. Over all twenty three-replicate subsets of the six screening
replicates, median-of-three ranks `p0.200-m0.200` above `p0.100-m0.200` in
**17**; the clean set is one of the three exceptions.

So the honest statement is narrower: **at n = 3 the median-of-k ranking statistic
is unstable**, which is a good reason to defer a retune and a poor reason to
prefer a specific alternative arm.

**Confirmation — the comparison against baseline IS robust.** On the ten
uncontaminated replicates `[0, 3, 5, 6, 7, 8, 9, 12, 13, 14]`:

| comparison | all 16 | clean 10 |
|---|---|---|
| candidate vs baseline | 13/16 wins, +0.2244 | **10/10 wins**, +0.2244 |
| baseline vs control | 16/16 wins, +0.6433 | 10/10 wins, +0.6020 |

**The baseline-vs-control row is an algebraic identity, not a measurement, and
the first version of this report leaned on it as though it were evidence.** With
`ELITE_COUNT = 2` elitism, zero mutation and deterministic per-genotype
evaluation, the control's champion is a mathematical fixed point: its final
champion equals its generation-0 champion, so `runScore(control) ≡ 0` in all 22
control runs (verified: the set of distinct control run-scores is exactly `{0}`,
and 22/22 control runs have an unchanged champion). Since every arm shares
generation 0 by the pairing identity, the control can never win a replicate.

"Baseline beats control 16/16" therefore means only **"baseline improved over its
own generation 0 in all 16 replicates"** — which is exactly what the data shows,
and is a real fact about mutation-only evolution, but carries none of the
comparative weight a 16/16 head-to-head appears to carry. It is restated in those
terms wherever it appears.

And the clean-replicate final champions are entirely plausible — 3.5–4.8 m/s
against a 5 m/s drive law:

| arm | final champions on the 10 clean replicates (m) |
|---|---|
| control | 7.5, 12.4, 12.6, 8.5, 9.4, 7.0, 7.3, 9.9, 9.8, 10.6 |
| baseline | 16.3, 21.2, 18.1, 16.8, 17.5, 14.5, 15.6, 13.6, 19.3, 17.5 |
| candidate | 22.2, 23.9, 23.0, 21.2, 23.5, 17.5, 22.3, 22.8, 23.7, 21.1 |

**This cuts both ways, and both directions are reported.** The contamination does
not manufacture the candidate's advantage over baseline — it survives on clean
data, on every clean replicate. What the contamination does undermine is the
*selection* of that particular arm: on clean screening data the median-of-three
ranking puts a different arm first, though the paired comparison on the same data
does not, and neither arm has ever been compared against the other on **held-out
confirmation seeds**.

---

## 6. Why the retune is not adopted

Three independent reasons, none of which the predeclared gate could see:

1. **The premise is violated.** The gate assumes selectable fitness measures
   locomotion. On roughly a quarter of the values it reads, the champion is over
   the plausibility ceiling — implausible for locomotion, and confirmed divergence
   wherever the forensic arm re-evaluated. A tuning decision made on that signal is
   partly a decision about which parameters find solver exploits fastest.
2. **The candidate's identity is not robust** (§5): on the clean replicates the
   median-of-three ranking selects `p0.100-m0.200` instead. This is the weakest
   of the three reasons and is stated as such — the paired comparator, which is
   the design's declared comparison unit, prefers `p0.200-m0.200` on that same
   clean data (2/3, +0.0790). What the disagreement establishes is that the
   ranking statistic is unstable at n = 3, not that another arm is better.
3. **The candidate is on the grid boundary**, so "0.20/0.20 is best" is not
   something this campaign can support even on clean data.

Reason 3 is unarguable; reason 1 is measured but is a caveat rather than a
refutation, since §5 shows the candidate's advantage survives on clean data; and
reason 2 is the weak one. **The decision is therefore best read as a deferral
resting on the contaminated signal and the grid boundary** — not as evidence that
0.05/0.05 is right. No clean comparison in this campaign supports 0.05/0.05 over
either candidate arm, and the report says so below.

What *is* supported, robustly and on clean data: **mutation-only evolution works
at the current defaults** (baseline beats control 16/16, and 10/10 on clean
replicates), and **0.05/0.05 is very probably not the best setting** — every
top-ranked arm carries a larger magnitude, and the candidate beats baseline on
every clean confirmation replicate.

Retaining is therefore the conservative reading, not an evidence-free one. The
retune is **deferred, not refuted.**

---

## 7. Runtime and storage envelope

Reference machine: i7-14650HX, Windows 11, Node v22.19.0, deterministic Rapier
0.19.3. Machine-specific; never a CI threshold. Every figure below is re-derivable
from `observations.perRunTiming` and `observations.historyGrowth` in the evidence
file (per-run timing is recorded there, and deliberately **outside** the evidence
digest — a resumed campaign re-executes runs, and timing inside the digest made
an interrupted run produce a different digest from an uninterrupted one).

- **Total evolution time: 70 minutes** for 204 runs, sequential.
- Median run, **split by generation count** (the first version quoted a pooled
  median and labelled it as the 30-generation figure):

  | generations | runs | median | max |
  |---:|---:|---:|---:|
  | 30 | 156 | **15.8 s** | 22.7 s |
  | 60 | 48 | **35.0 s** | 59.1 s |

- Median cost ~**535 ms per generation** — 20 individuals × 300 steps on isolated
  composite worlds, i.e. ~89 µs per vehicle-step.
- **History growth is linear: 12.2 KB per generation**, measured identically at
  30 and 60 generations.

  | generations | median | **max** |
  |---:|---:|---:|
  | 30 | 366 KB | 0.55 MiB |
  | 60 | 731 KB | **1.27 MiB** |

**The margin against PR #25's ~1.35 MiB worst-case projection is thin, not
large.** The first version compared the *median* (0.73 MB) to that worst case and
called the result comfortable; the correct comparison is the observed **maximum**,
1.27 MiB, which is 94 % of the projection. PR #25's estimate is therefore
*confirmed as accurate* rather than shown to be conservative. The 64 MiB v1
ceiling is still far away and the segmented-history refactor is not triggered at
60 generations — but a campaign at materially more generations should re-measure
rather than extrapolate from the median.

Summarize cost (the O(G²) concern) is 351 ms median at 30 generations and 729 ms
median / 1,209 ms max at 60 — small in absolute terms, and visibly superlinear in
the generation count, which is what the O(G²) append predicts.

## 8. Corrections to the record

**PR #25's handoff (§9) says a mutation-default retune "*will* move the committed
evolution locks." This is false.** `EVOLUTION_FIXTURE_A` declares its mutation
parameters as literals and `evolutionRunConfigFor` passes them explicitly, so the
locked artifact never reads `PARAMETRIC_MUTATION_DEFAULTS`.

Verified by execution, not by reading: setting the defaults to `(0.2, 0.2)` and
running `tests/evolution-determinism.test.js` leaves it **green** (5/5). Lock
stability across a default change is the expected behaviour, and it is a
deliberate property of the fixture, which says so in its own comment.

### 8.1 The two digests, and a stale figure in the handoff

The evidence artifact carries **two** identities, because they answer different
questions:

| field | scope | answers |
|---|---|---|
| `evidenceDigest` | protocol, runs **including per-run provenance**, screening, confirmation | "is this exact artifact, with its citability claim, intact?" |
| `resultDigest` | the same, with per-run provenance projected away | "did two campaigns produce the same science?" |

The split exists because an earlier docblock claimed the source commit was
"deliberately outside" the digest while the run projection put it *in*, and a
committed test required it there — two correct intents and one false summary
sentence, with nothing able to falsify it because the scope test inspected
top-level keys only. Per-run provenance belongs inside: the artifact's headline
claim is that every run came from one clean commit, and a digest that excluded it
would let provenance be swapped under a still-valid digest. `resultDigest` gives
the cross-commit comparison that motivated the objection.

**CLAUDE.md quoted `1e9614c8…24fc0e32` as this artifact's digest; the artifact's
`evidenceDigest` is `75c849ce…8ff99d6e`.** That figure was not wrong when it was
written — it is the digest of the evidence subset *before* per-run provenance was
added to the projection, and the report was updated while the handoff was not. It
is now exactly this artifact's `resultDigest`, which is a proof that the new
`resultDigest` strips precisely the fields that were added and nothing else.
Corrected in CLAUDE.md; the report's figure was right throughout.

---

## 9. Limitations

- **One campaign, one machine, one terrain family, one population size, one step
  budget, one spawn.** Tournament size (3) and elite count (2) are module
  constants **outside** the protocol and therefore outside `protocolDigest` — a
  gap worth closing in a protocol v2, and one that matters because the control
  arm's fixed-point behaviour (§5) is a consequence of elitism.
- **This report corrected two of its own headline claims** after adversarial
  review: the control-arm claim and its causal corollary (§1.1), and the
  plausibility-ceiling derivation (§1.3). Both corrections are in the direction of
  *more* contamination, not less.
- **The conservative ceiling has measured false negatives** (§1.4), and the
  "all over-ceiling champions are alert-band" check is entailed by arithmetic
  rather than measured. Counts against it are lower bounds.
- **Slot counts are exposure, not prevalence.** Elitism re-counts one surviving
  individual every generation; the distinct-champion column is the honest
  collapse.
- **Contamination is measured at the CHAMPION only.** Tournament selection samples
  the whole selectable pool, so the champion is not the selection mechanism. How
  far the artifact mode penetrates the breeding pool is unmeasured.
- **The forensic sample is 27 rows — 23 distinct individuals — from 9 of 22
  replicates**, and the escalation-cost measurement covers **generation 0 only**
  and only the false-positive side.
- **Multiple comparisons are not corrected for.** Screening takes the best of 26
  arms on 6 shared replicates; the confirmation margin (13/16 against a threshold
  of 12) is thin for a candidate chosen that way. This is one more reason the
  retune is deferred rather than adopted.
- **The persisted fitness vector stores integrity *status*, not the peak-speed
  observation**, so per-generation contamination cannot be read back from history
  — which is why §1.4 and §1.5 need re-evaluation at all.

## 10. Recommended next steps (not implemented here)

1. **Escalate the alert band — the cost is now measured.** §1.5: escalation makes
   **2.5 %** of unmutated individuals unselectable, all peaking **≥142 m/s** with
   no cluster near the 25 m/s line, and corrects the generation-0 champion in
   **27 %** of populations. What remains before it can land is PR-B's
   **false-negative** half (divergence that still passes after escalation) and the
   version bump plus deliberate re-lock. That is a PR-B/PR-5 change, not this one.
2. **Persist the integrity OBSERVATIONS** (peak body speed, first alert step) in
   the fitness vector, so contamination is measurable from history rather than by
   re-evaluation. A versioned encoding change.
3. **Re-run this exact protocol afterwards** (~70 minutes, committed and
   resumable) and take the tuning decision on a clean signal.
4. **Extend the grid past 0.20** and add `p0.100-m0.200` — the arm the clean
   median-of-three ranks first, though *not* the one the paired comparator
   prefers (§5) — to the confirmation arms, so the boundary and the alternative
   are both covered. Note the caution in §1.1: extending the grid *upward* may
   also raise the artifact rate.
5. **Bind `ELITE_COUNT` and `TOURNAMENT_SIZE` into the protocol** in a v2, so the
   digest covers every constant the conclusions depend on.
6. **Measure contamination in the breeding POOL, not just at the champion**, since
   tournament selection samples the pool.
7. Structural mutation, worker sharding and segmented history stay **out of scope
   and unaffected** — though §7 notes the history margin is thinner than first
   reported, so a longer campaign should re-measure.

## 11. Reproduce

```bash
npm run experiment:evolution -- --phase smoke     # ~4 s, end-to-end shape proof
npm run experiment:evolution -- --phase screen    # ~46 min, 156 runs
npm run experiment:evolution -- --phase confirm   # ~24 min, 48 runs
npm run experiment:evolution -- --phase report    # writes evidence.json
# ~4 min, regenerates the §1.4 table
npm run experiment:evolution -- --phase forensics --out docs/ga-phase-1b-pr4-evolution-forensics.json
# ~2 min, regenerates the §1.5 table
npm run experiment:evolution -- --phase escalation-cost --out docs/ga-phase-1b-pr4-escalation-cost.json
```

Both broad phases require a clean tree and refuse to run otherwise; provenance is
re-read **per run**, so a tree edited or a HEAD moved mid-phase is refused rather
than silently attested. `--phase report` also requires a clean tree to mark its
output citable, because it recomputes screening, confirmation and both digests
with the *current* analysis code — `observations.reportSource` records the commit
it was built from, which legitimately differs from the commit the runs executed
at. Phases resume by exact run id after an interruption, and every loaded record
is checked against the declared schedule and against its own persisted history,
so a workspace that is not this experiment is refused rather than averaged in.
CI runs only `tests/evolution-experiment.test.js` (131 tests, ~10 s) — structure,
arithmetic and decision logic, never a magnitude.

**Seeds allocated by this PR:** 20260744–20260749 (screening population),
20260750–20260755 (screening terrain), 20260756–20260771 (confirmation
population), 20260772–20260787 (confirmation terrain), 20260788 (arm scheduling),
20260789–20260796 (smoke protocol, non-citable).
