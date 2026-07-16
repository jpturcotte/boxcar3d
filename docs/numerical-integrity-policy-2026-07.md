# Numerical-Integrity Policy v1 — Decision Memo (2026-07)

> The production successor to the PR #17 finite-explosion investigation: a
> small, always-on, engine-neutral detector that prevents Rapier's
> constraint-solver divergence from becoming selectable GA fitness. This memo
> answers the mission's nine design questions from the committed code and the
> `probe:integrity` evidence; it does not restate the mechanism (see
> `docs/physics-integrity-finite-explosion-report-2026-07-13.md`) or the
> engine-viability verdict (see `docs/rapier-034-spike-2026-07.md`, Outcome B —
> the divergence persists on core 0.34, so this policy is the primary
> mitigation and is calibrated against the shipping stable engine).

## The contract, in one place

`src/sim/integrity.js` (pure, under the sim ESLint ban; `Math.sqrt` only):

- `INTEGRITY_POLICY_VERSION = 1`.
- Per-vehicle result block on **every** production evaluation:
  `integrity: { policyVersion, status, firstFailureStep, reasons[],
  observations: { peakBodySpeed, peakSpeedDelta, peakStepDisplacement,
  firstAlertStep, firstCatastrophicStep } }`.
- `status ∈ {'ok', 'nonFinite', 'numericalDivergence'}`.
- **Failure bound = nonFinite ∨ catastrophic crossing** (body speed > 1000 m/s,
  or one-capture displacement > (1000/60)·dtScale, ANY body). The **alert band**
  (25 m/s / 30 m·s⁻¹ / 25/60 m per capture) is a recorded OBSERVATION, never a
  failure — see Q "false positives/negatives".
- **Policy v1 classifies, never shortens**: the runner still executes exactly
  `maxSteps` after a failure (trace shape, executed-step semantics, and timing
  comparability preserved). Early termination is deferred to a later version.
- **Always-on**: the fold runs on every path through `runEvaluation`; the only
  off switch is a direct-caller `integrity: false` at the
  `runRealizedEvaluationLoop` seam (the `inspect` precedent) for cost and
  non-interference measurement. `runEvaluation` rejects an `integrity` option
  key — the GA can never evaluate with the detector disabled.

Fitness (`src/sim/population-evaluation.js`, `FITNESS_POLICY_VERSION = 2`):

- `selectable = isVehicleResultValid(v) && v.integrity.status === 'ok'`;
  `fitness = selectable ? maxForwardDistance : 0`. `isVehicleResultValid` is
  UNCHANGED (finite ∧ bodies ∧ joints) — validity and selectability are
  deliberately distinct predicates.
- `FITNESS_VECTOR_VERSION = 2`: header gains `integrityPolicyVersion`; each
  member gains an `integrityStatus` byte. An integrity-failed non-zero fitness
  can never be serialized (fail-loud).
- `selectableChampionFromEvaluation` returns the best valid∧integrity-clean
  individual or **null** when none exists — an integrity-failed vehicle never
  becomes champion merely because every fitness is zero.
  `championFromEvaluation` is retained as the DIAGNOSTIC best-observed selector
  (reports only, never selection/elitism).

## The nine questions

**1. What is the smallest signal set that reliably identifies the known
divergence class?** Three kinematic scalars per body — instantaneous speed
`|v|`, one-capture velocity change `|Δv|`, one-capture displacement `|Δx|` —
plus the finiteness flag. The **catastrophic** predicate on `|v|` and `|Δx|`
alone catches every known affected individual (the reproducer, all four
witnesses, and every affected member of the characterization populations),
INCLUDING the two that hide a >1000 m/s blow-up behind ordinary forward
distance (`20260725` ids 1 and 14) — cases no displacement/distance cutoff
catches. The `|Δv|` arm and the alert band are retained as OBSERVATIONS (they
sharpen onset diagnosis and feed the escalation-trigger evidence) but are not
part of the failure bound.

**2. Can those signals be collected online without full traces?** Yes. The
runner's `captureStep` already reads every body's `translation`/`linvel` once
per capture (shared by the non-finite latch and the trace). `foldIntegrity`
consumes that same `reads` array, keeps the previous capture's pose/velocity in
preallocated scratch (no per-step allocation), and folds a handful of running
maxima + first-crossing flags. No trace is retained; no engine query is made.
The one forensic signal that needs full history — `analyzeTrace`'s backward
causal scan — is a locator, dropped from the online detector.

**3. Which signals are engine-neutral, and which are Rapier-specific?** All of
them are engine-neutral: `|v|`, `|Δv|`, `|Δx|`, and finiteness are properties
of body state any physics backend exposes. The thresholds derive from PROJECT
physics (gravity 20 ⇒ ~0.33 m/s per-capture quantum; ~22 m/s worst legitimate
fall; the 5 m/s drive law), not from engine identity. Nothing in the detector
or the fitness vector binds `rapierVersion` — engine identity stays a
lock-layer attestation. A future backend produces an equivalent classification
without imitating Rapier's joint math.

**4. What is the measured cost per evaluation and per population?** `probe:integrity`
`cost` pass, paired interleaved on-vs-off at the core-loop seam (the arms differ
only in the fold; trace `none`): fixture A, 5 pairs × 600 steps, median on
**57.79 ms** vs median off **59.33 ms** — a per-pair ratio of **0.9151**, i.e.
**within run-to-run noise** (the on-arm measuring faster is itself the tell that
the fold's true cost is below the measurement floor; it reads values already in
hand and touches no engine state, so it cannot actually accelerate stepping).
Memory: the per-vehicle state is O(bodyCount) floats in two preallocated
`Float64Array`s; nothing is retained across captures. Population cost is
unchanged versus the pre-policy baseline within measurement noise.

**5. What stable controls and mutation-neighbourhood samples were used to
estimate false positives?** `probe:integrity` `signals` pass runs the three
clean calibration controls (population `20260725` ids 13/15/16 — the PR #17
procedure's selections) and fixtures A–D; all eight classify **ok** with peak
body speeds **1.6–5.6 m/s** — versus the 25 m/s alert band and the 1000 m/s
failure bound, a **180–600× margin** below failure. The `neighborhood` pass
perturbs every gene of three declared parents (control `20260725:13`, witness A
`20260725:19`, champion `20260721:10`; seed 20260731) at ±0.01/±0.05,
re-repairs, and classifies each child. **Result (48 children): the clean
control and the champion produced 0/16 failed children each at both magnitudes —
no false-positive halo — while every one of witness A's 16 children stayed
`numericalDivergence` (the class is robust across the neighborhood, not a
jitter-sensitive knife-edge). Zero "alert-but-ok" children anywhere.** The
COMMITTED fixture
(`population-a-initial-composite`, terrain 20260722) measured **20/20
integrity-clean**, so the deliberate v2 re-lock kept every per-member fitness
literal, the champion, and the champion trace bit-identical — only the vector
bytes moved.

**6. How does integrity affect fitness eligibility, ranking, champion
selection, and result serialization?** Eligibility: only valid ∧ integrity-ok
individuals are selectable; all others score exactly 0. Ranking/champion:
`selectableChampionFromEvaluation` filters the unselectable out entirely and
returns null on an all-unselectable generation (Phase 1B must handle that
condition deliberately). Serialization: the fitness vector binds
`integrityPolicyVersion` and a per-member status byte, so an integrity-failed 0
is byte-distinct from a merely-poor valid 0; raw task metrics and the full
integrity block remain in `diagnostics` — failures stay observable, never
silently converted to a bare zero.

**7. Does the resulting policy remain small enough that Rapier is still the
rational backend?** Yes. The detector is one pure module (~200 lines), a
result-only fold on reads already taken, one fitness predicate, and one champion
selector — no full traces in the ordinary path, no morphology-specific tables,
no second solver, no per-lineage bookkeeping. It cost one deliberate lock
re-lock and zero physics change. This is squarely the "acceptable integrity
policy" category, not the "unacceptable compensating architecture" the mission
warns against. Rapier + the current impulse realization remains rational; the
policy would transfer to another backend unchanged in shape.

**8. Is a Rapier multibody-realization spike required now, deferred with a clear
trigger, or unnecessary?** Deferred with a clear trigger. The core-0.34 spike's
multibody 2×2 (`docs/rapier-034-spike-2026-07.md` §5.2) shows reduced-coordinate
realization is quiescent on both cores for the UNDRIVEN reproducer — the joint
representation is the real lever — but multibody revolute/prismatic MOTORS and
settable LIMITS are unavailable in the JS bindings on both 0.19.3 and core 0.34,
so the driven S0/S1 phenotype cannot use that path without an upstreamable
binding patch. The multibody/binding-extension feasibility investigation is the
named follow-up; it is not required for GA Phase 1B to proceed safely, because
this detector makes divergence non-selectable regardless of representation.

**9. What evidence would trigger a future backend comparison?** (a) The
multibody binding-extension proves infeasible AND impulse divergence persists;
(b) false positives appear in ordinary viable populations (a clean vehicle
tripping the catastrophic bound — none observed, 40–500× margin); (c) missed
failures after mutation gain selection-relevant progress below the catastrophic
bound (the false-negative watch list — none observed); (d) the detector is
forced to grow beyond this small contract (morphology-specific thresholds, a
second solver, per-lineage state); (e) material population-throughput loss from
the policy (measured ~0% here); or (f) a new numerical-failure class needing
unrelated thresholds. None are currently met.

## The escalation question (alert-as-failure), and the false-negative gate

The alert band is an observation, not a failure, because the failure bound must
not treat extreme-but-finite motion as invalid without control calibration
(the mission's explicit constraint), and the catastrophic bound already catches
every known case. Escalating alert to a failure bound is a documented policy-v2
trigger, gated by the **false-negative acceptance test**: before v1's
catastrophic-only bound is trusted for selection, inspect the held-out and
mutation-neighborhood samples for any vehicle that (a) shows clear numerical
runaway, (b) gains selection-relevant progress from it, and (c) stays below
both catastrophic thresholds. `probe:integrity` reports exactly this
"alert-but-ok" watch list per population and per neighborhood. **MEASURED: the
watch list is EMPTY on the entire tested corpus** — all 60 characterization
individuals, all 48 neighborhood children, and the eight-subject signals panel.
No vehicle gained selection-relevant progress from sub-catastrophic runaway, so
the catastrophic-only bound meets the evolutionary-safety requirement on the
tested set, and alert-as-failure escalation is not currently warranted (the
trigger stands, unmet).

## Review follow-up (2026-07-16): four corrections, no lock movement

Landed on the PR #20 branch after PR #19/#21 merged; every committed
lock/fingerprint byte-identical, `fitnessVectorDigest` stays `a6d04f75`.

**1. Integrity is validated BEFORE the validity short-circuit.**
`isVehicleResultSelectable` used to evaluate `isVehicleResultValid(v) &&
requireIntegrity(v)...`, so an INVALID result (non-finite / bad bodies / bad
joints) with `integrity: null` or a malformed block returned a silent `false`
— an unversioned policy for exactly the results most likely to need
diagnosis. `requireIntegrity` now runs unconditionally first; both policy
entry points (`isVehicleResultSelectable`, `fitnessFromVehicleResult`) refuse
missing/null/wrong-version/unknown-status integrity LOUD on every validity
combination (regression suite committed). `isVehicleResultValid` keeps its
narrow, integrity-free meaning.

**2. The online≡offline agreement claim is now the FULL derivable contract.**
The probe's `agreement` hard check and the equivalence witnesses used to
compare only the five shared observations while claiming block-level
agreement. `analyzeTrace` now records per-body per-reason first steps
(additive diagnostics), and the ONE shared projection
(`offlineIntegrityView`) derives the complete production classification —
`status`, `firstFailureStep`, the ORDERED `reasons` array — per the online
fold's documented scan order (capture → canonical body order →
catastrophicSpeed → catastrophicStepDisplacement → nonFinite). A pure
codec-fed suite feeds the SAME synthetic series through both detectors and
pins every ordering rule (class precedence, same-body and cross-body
same-step ties, reason order, the captureDt convention) as an arithmetic
identity; the engine-fed witnesses stay outcome-agnostic. (The
"Measured characterization" section below predates this widening; its
agreement checks compared observations + onsets, which the fuller contract
subsumes — re-running the probe re-attests everything under the full check.)

**3. Parametric neighborhood jitter preserves discrete-decode genes.**
The jitter walker perturbed EVERY numeric leaf, including the categorical
`suspType` — a draw near the S1/S2 decode boundary produced a legal compiled
S2 IR the realizer rejects pre-world, aborting the whole neighborhood
experiment. `assembly.js` now declares `DISCRETE_GENE_KEYS`
(family/suspType/symmetric/paired/driven/nodeCount — enum band / boolean
threshold / slot count), and the walker preserves them verbatim: a
parametric instrument measures the local CONTINUOUS neighborhood; decode-
boundary crossings are structural mutations (spec §3.1.3), a different
operator. S2 is never clamped or masked — it is simply unreachable by
jitter. A deterministic S1→S2 boundary regression is committed. The
neighborhood table below was **re-measured under this discrete-preserving
walker** (2026-07-16), so it regenerates from the shipped code; the three
qualitative findings are unchanged from the original PR-B measurement (0/32
clean-parent failures, 16/16 witness failures, empty alert-but-ok watch list),
and only the mean repair-touched-leaves column shifted (fewer leaves
perturbed, RNG stream consumed differently).

**4. The engine-upgrade tripwire no longer duplicates the mutable lock.**
PR #21's candidate-red inventory embedded the then-current fitness-vector
digest in a failure-message regex (`"to be 'bded0d30'"`); this PR's
deliberate re-lock silently staled it — a real core-0.34 run would have
failed adjudication on the permitted class-(c) movement. Both population
determinism gates now fail with a structured marker
(`src/sim/lock-markers.js`: `FITNESS_VECTOR_LOCK_MISMATCH expected=<lock>
actual=<measured>`, the custom message on the still-real `.toBe` golden
assertion), and the adjudicator (inventory schema/3) parses it and validates
`expected=` against the authoritative digest imported LIVE from
`src/sim/population-locks.js` at adjudication time. Cross-env digest
extraction reads `actual=` from the marker (never Vitest diff scraping).
Committed sync teeth: no signature field may embed a mutable digest literal,
the authoritative set must equal the lock module's values, and
mismatch/malformed/contradictory-marker paths are unit-tested. The July 2026
C5 evidence (recorded under fitness policy v1 against `bded0d30`) is
historical and untouched; `tests/integrity-probe-schema.test.js` joins the
expected candidate reds (its `rapierVersion` pin; Node totals 11 → 12).

**Core-0.34 revalidation under policy v2 (run 29527892757, 2026-07-16,
heavy=true, dispatched from this branch): every job GREEN on the first
dispatch — the updated inventory matches the REAL candidate contract.**
Measured, both arms usable, verdict `citable: true`:

- **Candidate Node reds: exactly the declared 12**, at assertion level —
  evaluation-determinism(5), evaluation-golden(1), population-determinism(3,
  incl. the fitness-vector red via the STRUCTURED MARKER), bench-schema(1),
  physics-explosion-probe-schema(1), and the NEW integrity-probe-schema(1)
  (its `rapierVersion` pin, exactly as classified). Stable arm: 0 failing —
  every PR #20 test (integrity, lock-markers, adjudicator, probe schemas)
  green on stable in CI.
- **The marker protocol proved itself end-to-end on a real candidate**: Node
  and Chromium both extracted the candidate's policy-v2 fitness-vector
  digest `087b5149` from the marker (agree, zero marker problems), and
  `expected=a6d04f75` validated against the live population-locks import.
  Note `087b5149` ≠ the July v1-era candidate digest `ee605286` (the vector
  encoding changed at v2) — under the stale pre-/3 inventory this run would
  have FAILED adjudication on exactly the permitted class-(c) movement,
  which is the defect this protocol closes.
- **Outcome B reproduced at classification level** (the July verdict
  extends to PR #20's tree): impulse reproducer catastrophic on BOTH arms
  (stable cat@46, peak 5.45e3 m/s; candidate cat@107, peak 4.78e3 m/s);
  multibody arm quiescent on BOTH (1.42 / 1.40 m/s); prevalence identical
  on both arms and to the July result — 20260725: ids 1, 14, 19;
  20260728: id 4; 20260729: id 19; fresh 20260730: ids 0, 5 (7/80 total);
  the candidate still CRASHES the full forensic witness matrix
  (`RuntimeError: unreachable`) while stable completes it cleanly
  (`freeErrors` empty); paired perf ok. The integrity policy's target
  failure class is unchanged on the current upstream core, and the detector
  gates it identically there.

## Reproduce

- `npm run probe:integrity` — the characterization (signals/population/
  neighborhood/cost; defaults SMALL, the full sweep is Phase 1B's experiment).
- `npx vitest run tests/integrity.test.js` — the pure contract + the
  online≡offline equivalence witnesses (outcome-agnostic).
- `npx vitest run tests/lock-markers.test.js tests/compare-spike-runs.test.js`
  — the marker protocol + the one-source adjudication teeth.
- `npm run test:determinism` + `npm run test:browser` — the v2 re-lock
  reproduces across Node (3-OS) and pinned Chromium.

Seeds allocated: 20260731 (the mutation-neighborhood jitter).

## Measured characterization (`npm run probe:integrity`, deterministic flavor, rapier 0.19.3)

All 18 hard checks green (identity digests, online≡offline agreement per
subject, f32 dt). Every number below is an OBSERVATION — no committed test
asserts any subject diverges.

**Signals panel** (each row's online block agrees bitwise with `analyzeTrace`
over the same run):

| subject | status | peak body (m/s) | maxFwd (m) | selectable | fitness (m) |
| --- | --- | --- | --- | --- | --- |
| witness A | numericalDivergence | 8.67e9 | 8.17e6 | false | 0 |
| witness B | numericalDivergence | 8.01e9 | 2.96e3 | false | 0 |
| witness C | numericalDivergence | 2.91e9 | 1.16e3 | false | 0 |
| witness S | numericalDivergence | 1.07e3 | **3.63** | false | 0 |
| reproducer | numericalDivergence | 5.45e3 | 1.30 | false | 0 |
| control 13 | ok | 2.29 | 6.59 | true | 6.59 |
| control 15 | ok | 3.58 | 2.88 | true | 2.88 |
| control 16 | ok | 1.58 | 4.98e-3 | true | 0 (settle noise) |
| fixture A | ok | 2.83 | 19.43 | true | 19.43 |
| fixture B | ok | 5.64 | 28.53 | true | 28.53 |
| fixture C | ok | 2.05 | 13.28 | true | 13.28 |
| fixture D | ok | 3.59 | 25.80 | true | 25.80 |

Reason attribution over the panel: `catastrophicSpeed` fired on 5 subjects,
`catastrophicStepDisplacement` on 4 — both predicates contribute; neither alone
covers the panel. **Witness S is the load-bearing row**: 3.63 m of forward
progress (ordinary-looking) with a 1070 m/s internal blow-up — caught by peak
body speed, invisible to any distance cutoff; now unselectable, fitness 0.
Witness A is the opposite failure mode (8.17e6 m of catapult distance) — also
zeroed. Both are the mis-ranking cases PR #17 flagged.

**Prevalence** (production path, `evaluatePopulation`, isolated worlds, 300
steps):

| seed | status counts | catastrophic ids | median fitness (m) | alert-but-ok |
| --- | --- | --- | --- | --- |
| 20260725 | 17 ok / 3 divergence | 1, 14, 19 | 2.16 | 0 |
| 20260728 | 19 ok / 1 divergence | 4 | 1.94 | 0 |
| 20260729 | 19 ok / 1 divergence | 19 | 2.98 | 0 |

**5/60 catastrophic — exactly the known individuals** (the four witnesses + the
id-1 control). Median viability ~2–3 m, unchanged. No false negatives.

**Mutation neighborhood** (seed 20260731; every CONTINUOUS gene ±magnitude,
discrete-decode genes preserved, re-repaired) — **re-measured 2026-07-16 under
the current discrete-preserving walker** (`npm run probe:integrity --pass
neighborhood`, default config), so this table regenerates from the shipped
code:

| parent | parent status | mag | children | failed | alert-but-ok | mean repair-touched leaves |
| --- | --- | --- | --- | --- | --- | --- |
| control 20260725:13 | ok | 0.01 | 8 | 0 | 0 | 1.4 |
| control 20260725:13 | ok | 0.05 | 8 | 0 | 0 | 2.0 |
| witness A 20260725:19 | numericalDivergence | 0.01 | 8 | 8 | 0 | 5.5 |
| witness A 20260725:19 | numericalDivergence | 0.05 | 8 | 8 | 0 | 6.4 |
| champion 20260721:10 | ok | 0.01 | 8 | 0 | 0 | 2.9 |
| champion 20260721:10 | ok | 0.05 | 8 | 0 | 0 | 3.5 |

Clean parents have **no false-positive halo** (0/32 clean-parent children
failed); the affected parent's children all stay affected (16/16); the
alert-but-ok watch list is **empty across all 48 children**. Repair touched a
handful of gene leaves per child (it is NOT a no-op on jitter, but it does not,
on this sample, push clean children across the conditioning boundary or rescue
affected ones). The three qualitative findings are IDENTICAL to the original
PR-B (pre-walker-fix) measurement — 0/32, 16/16, empty watch list — only the
mean repair-touched-leaves column shifted (the discrete-preserving walker
perturbs fewer leaves and consumes the RNG stream differently, so child
identities differ). This is the Phase-1B mutation-neighborhood probe's first
data; the full sweep (larger parent set, finer magnitudes, structural mutation)
is Phase 1B's experiment.

**Cost**: 5 pairs × 600 steps, median on 57.79 ms / off 59.33 ms, ratio 0.9151 —
within noise (the fold is below the measurement floor).
