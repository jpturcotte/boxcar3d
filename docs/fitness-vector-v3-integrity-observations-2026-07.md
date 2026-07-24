# Fitness Vector v3 — Persisted Integrity Observations (PR #28, 2026-07-24)

**Status: LANDED.** Representation and observability only. **No policy,
selection, or mutation behaviour changed.** `INTEGRITY_POLICY_VERSION` stays 1,
`FITNESS_POLICY_VERSION` stays 2, `PARAMETRIC_MUTATION_DEFAULTS` stays
`{ probability: 0.05, magnitude: 0.05 }`.

**An alert-bearing vehicle still reports `integrity.status: 'ok'` and is still
fully selectable on `main`.** This PR makes that fact *readable from a saved
artifact*. It does not change it, and it does not fix the underlying solver
defect — see §7.

---

## 1. Why

The online integrity detector (`src/sim/integrity.js`) already computes five
observations on every evaluation:

```
peakBodySpeed  peakSpeedDelta  peakStepDisplacement
firstAlertStep  firstCatastrophicStep
```

Through v2 the fitness vector persisted the *verdict* (`integrityStatus`) and
discarded the measurements behind it. So a saved history could not answer the
one question that matters for the alert band — **was this champion locomotion,
or constraint-solver divergence?** — and PR #26 had to re-simulate its own
campaign to diagnose contamination it had already recorded.

`docs/solver-divergence-remediation-2026-07.md` §2 names persisting them as
**step 1** of the Option A sequence, and makes the two measurements Option A
still needs — breeding-pool exposure and the false-negative side — depend on it.

## 2. The wire change

`FITNESS_VECTOR_VERSION` **2 → 3**. The header is unchanged (22 bytes) and every
pre-existing member field keeps its offset; a member grows **14 → 48 bytes**:

```
u32 individualId | u8 valid | u8 integrityStatus | f64 fitness
f64 peakBodySpeed | f64 peakSpeedDelta | f64 peakStepDisplacement
u8 firstAlertStepPresent        | u32 firstAlertStep
u8 firstCatastrophicStepPresent | u32 firstCatastrophicStep
```

### 2.1 Optional steps carry a flag, not a sentinel

`null` ("never crossed") and step `0` ("crossed at the post-realization
capture") are **different facts**, and a sentinel would have to consume a legal
step value to tell them apart. An **absent** step's `u32` payload is
canonically `0` — written unconditionally by the encoder, *rejected when
nonzero* by the decoder. Without that rule `00 00000000`, `00 01000000` and
`00 ffffffff` would all decode to the same `null`, giving one semantic value
2³² byte identities and breaking `decode → encode` identity.

### 2.2 Peaks may be `+Infinity`, and that is not an oversight

`isCanonicalPeak` is `typeof v === 'number' && v >= 0`. It **admits
`+Infinity`** and rejects `NaN` and `-Infinity` (both comparisons are false);
the `typeof` gate is what stops the string `'3'` passing.

The obvious-looking "peaks must be finite" rule is **wrong**, and would have
been a live defect. `foldIntegrity` takes `sqrt(vx² + vy² + vz²)` as the peak
whenever it is greater, then evaluates the catastrophic predicates **before**
the non-finite one — so on that same capture the status becomes
`numericalDivergence` while the peak stays infinite.
`{ status: 'numericalDivergence', peakBodySpeed: Infinity }` is legal policy-v1
output, and a finiteness rule would make `serializeFitnessVector` **throw inside
`evaluatePopulation`** on the run's own defensive-net result: a codec stricter
than its own producer, failing exactly on the results most worth persisting.

`+Infinity` has one f64 representation (`000000000000f07f`) and round-trips
`Object.is`-true, so nothing about the encoding needs it excluded. A `NaN` peak
is unreachable from the producer (`speed > peak` is false for `NaN`, and peaks
start at `+0`), so rejecting it still mirrors the producer exactly.

**Consequence for Next PR:** `canonicalJson` in `scripts/experiment-evolution.js`
refuses non-finite numbers, and v3 histories can now carry one. An evidence-JSON
representation for `+Infinity` is needed before those observations are
summarized.

### 2.3 Coherence rules are POLICY-V1-CONDITIONAL

Shared by the encoder and decoder through one `validatedObservations` walk, so
the two cannot drift, and conditioned on `integrityPolicyVersion === 1`:

1. `firstCatastrophicStep !== null ⟹ firstAlertStep !== null ∧ ≤ it`
2. `status === 'ok' ⟹ firstCatastrophicStep === null`
3. `status === 'numericalDivergence' ⟹ firstCatastrophicStep !== null`

Rule 1 is **derived, not decreed**: within one capture the same body is tested
against both bands, and the alert thresholds sit below the catastrophic ones — a
drift tooth in `tests/evaluation-codec.test.js` pins that ordering, because rule
1 is only true while it holds.

The conditioning is deliberate. **PR #29 is expected to classify an alert-only
crossing as `numericalDivergence` with no catastrophic step.** Writing rules 2
and 3 down as eternal vector-v3 invariants would force a needless v4 bump — or
an undo — the moment the policy moves. The wire layout is stable across that
change; only these predicates are not.

`nonFinite` is unconstrained in both directions: the status is *latched* at the
first failure, so a body that went non-finite at capture 3 keeps that status
even when another body crosses catastrophically at capture 5 — and a non-finite
result whose peaks all stayed finite is equally legal.

## 3. Capture discipline

`captureEvaluationMemberResult` is a **new** internal capture, deliberately not
an extension of `captureVehicleResult`. That helper backs
`isVehicleResultValid`, whose contract is narrow and **integrity-independent by
design** (`finite && bodies.allValid && joints.allValid`); folding observation
validation into it would let `isVehicleResultValid` throw because an
observations block was missing — a production semantic change in the one PR
promising none.

It also collapses `evaluatePopulation`'s three independent readings of one
vehicle result (`fitnessFromVehicleResult`, `isVehicleResultValid`, then
`v.integrity.status`) into one, which is the class this module has closed
everywhere else.

## 4. History and replay: two new pre-physics gates

The fitness vector is an **opaque component** to the history format — the outer
header binds every *other* version but not the vector's. So neither a stale
vector nor one contradicting its sibling component is visible to any existing
verification stage, and both surfaced at stage 10 as `replayDivergence`, *after*
a full generation had been re-simulated. **That reads as engine or environment
drift when the truth is that the file is old or malformed.**

`EVOLUTION_HISTORY_VERSION` stays **1** and the outer header is untouched. Two
gates in `evolution-replay.js`, called from the resume path between
`checkExpectedIdentity` and `checkRuntimeIdentity`:

| Stage | Gate | Code |
|---|---|---|
| 8a | `checkFitnessVectorCompatibility` | `unsupportedVersion` |
| 8b | `verifyFitnessVectorMetadataCoherence` | `malformedHistory` |

**Two distinct properties are at stake here, and only one of them depends on the
gates' position.** An earlier draft of this section — and of the comment in
`evolution-replay.js` — credited the position with both; a sabotage pass that
moved a gate one line earlier left every test green, which is how the overclaim
was found.

- *"A stale artifact still proves its framing, all four component digests, its
  chain and its whole-history digest before being refused"* — what lets a
  superseded artifact keep serving as a regression witness — is guaranteed by
  the gates running **outside `verifyHistoryArtifact` at all**. Stages 3–7
  complete before either check, so it holds wherever they sit afterwards.
- *"Wrong artifact outranks unsupported format"* — the ordering against
  `checkExpectedIdentity` — **does** depend on the position, and is the reason
  the calls sit after it. When a caller holds an expected digest and the file is
  both the wrong one *and* an old format, the actionable answer is
  `staleOrWrongArtifact`: go find the right file. Telling them the format is
  stale sends them to a migration they may not need. Pinned by the
  `WRONG ARTIFACT outranks UNSUPPORTED FORMAT` test.

Both gates also raise what the component walk **captured** rather than threw:
a failure discovered at stage 5 that belongs to the malformed-current-format
rung waits until after the chain, whole-history and identity checks, so a
doubly-broken artifact is diagnosed by the more actionable of its two faults.

The escalation ladder is preserved end to end:

```
corruption → wrong artifact → unsupported format → malformed current format
→ runtime mismatch → deterministic divergence
```

**Gate A is layered.** `peekFitnessVectorVersions` reads
`fitnessVectorVersion` first; if it is not this build's, **nothing further is
read**, because the rest of the layout is unknown under an unrecognized version
and parsing it would be guesswork reported as fact. Only when the layout is
known are the remaining four declared versions compared. The error names the
exact field.

**Gate B is the check no single component can make.** The vector carries onset
*steps*; the evaluation metadata carries the *executed step count*. Its bound is
**inclusive**: captures are indexed `0..maxSteps` — `captureStep(0)` runs
post-realization and the loop captures through `i <= maxSteps` — so a first
crossing at exactly `executedSteps` is legal, and a `<` bound would reject
correct artifacts, and only the most interesting ones. Each generation is
checked against **its own** persisted metadata, never the header's spec.

Gate B also refuses a vector whose **member count** disagrees with its
generation's population component. This is the same shape of fault: the
vector's `count` is bound only to its own byte length, so a vector scoring five
of a generation's six individuals is perfectly well-formed in isolation,
reaches physics, and comes back as `replayDivergence` at stage `fitnessVector`
— "the engine drifted" for a fault entirely inside the file. The count comes
from `peekPopulationSnapshotCount`, a count-only peek placed beside its own
codec for the same reason `peekFitnessVectorVersions` is: decoding every
snapshot to count it would cost a quarter of a million genotype decodes on a
max-length artifact, and reading the `u32` at a hard-coded offset from another
module would be a second interpretation of that layout, drifting the moment the
header changes. It is compared against the *population component*, not the
header's `populationSize`, so a forged header is still diagnosed by its cause
(the header-versus-manifest check, which runs later) rather than by this
symptom.

Facts are collected during stage 5 as **scalars only**: a max is a complete
check against an upper bound, so the worst offender's numbers are all a
diagnosis needs. Retaining decoded rows would hold a second copy of every vector
and break verification's documented one-payload-at-a-time memory model. Nothing
in that walk throws: a foreign decoder's failure — a truncated version prefix,
an unreadable vector — is **captured** and re-raised by gate B, wearing this
family's `code`. Throwing at stage 5 would let a content complaint preempt the
chain, whole-history and identity checks, and would let
`population-evaluation`'s dialect escape a verification call as a plain `Error`
with no `code` for callers to branch on.

### 4.1 A wider member also shrinks the capacity projection

`assertHistoryCapacity` projects a run's worst-case artifact size from
`fitnessVectorByteLength(populationSize)`, so a member growing 14 → 48 bytes
moves a **public production refusal**: measured, population 20 is unchanged
(still capped at 1024 generations), population 64 goes 940 → 912, and
population 256 goes 235 → 228 maximum feasible generations. This is correct —
the projection tracks the real format, and a gate that did not move would be
the bug — but it is outside the four things this PR promises are unchanged
(policy, selection, mutation, physics), and no committed literal records it, so
it is recorded here for the next reader of a `resourceLimitExceeded`.

`REPLAY_STAGES` is **not** modified — it is stage 10's per-component comparison
vocabulary, not the verification ladder.

## 5. The lock movement, and what it proves

The re-lock was performed with throwaway scripts that asserted the unchanged
half rather than trusting it — they refused to write a lock if an unrelated
digest moved. **Those scripts are not committed**, so what enforces the table
below at HEAD is not them: it is `tests/population-determinism.test.js` and
`tests/evolution-determinism.test.js`, which assert every literal in both files
live, plus the whole-suite fingerprint gates. Anyone re-locking again should
expect to write that assertion themselves; the committed gates compare
measurement against whatever literals are present, so they cannot on their own
tell a deliberate re-lock from an accidental one.

| | moved | unchanged |
|---|---|---|
| `population-locks.js` | `fitnessVectorDigest a6d04f75 → fd4222eb` | every per-member fitness/valid literal bit-exact, the champion, the champion trace, `populationSnapshotDigest`, `populationInitializationDigest`, `evaluationSpecDigest` |
| `evolution-locks.js` | every `fitnessVectorDigest` and `payloadByteLength`, therefore every `generationDigest`; `historyDigest da573ca5 → 8cab787f`; `historyByteLength 12126 → 12738` | **`headerDigest`**, and every `populationDigest`, `evaluationMetadataDigest`, `lineageDigest` |

**`headerDigest` not moving is the load-bearing observation.** The outer header
binds no vector version, so an opaque component's contents cannot reach it. Had
it moved, this would not have been a representation change.

Nothing outside those two files moved: the A–D evaluation digests, the five
terrain locks, the noise and boulder-hull fingerprints, and every version
constant except `FITNESS_VECTOR_VERSION` are byte-identical. Node (3-OS) and
pinned Chromium reproduce every re-locked digest; Chromium agreed on the first
run.

### 5.1 The lock now carries the observations

Necessarily: under v2 a clean status alone determined the bytes, and it no
longer does, so without them *"the committed digest is reproducible without
physics"* would have quietly become false.

They are also the first committed record of the fixture's integrity margins —
**20/20 members alert-free, peak body speed 0.9696–4.8661 m/s, i.e. 5.14×
below the 25 m/s alert line at the worst member.** Measured values, never
thresholds: the lock files must not assert a margin.

## 6. Oracles

- **`tests/fixtures/evolution-v3-independent.base64`** — produced by
  `scripts/generate-independent-evolution-artifact.js`, an encoder written from
  the *written format spec*, importing nothing from `evolution-history.js`,
  `evolution-lineage.js`, `population.js` or `population-evaluation.js`, and
  hashing with `node:crypto`. It reproduces production's bytes exactly. Its
  independence is **structural, not organizational** — authored in this repo, it
  catches an encoder that drifts from the spec, not a spec misread twice.
- **A hand-computed 118-byte expected-stream literal** in
  `tests/evaluation-codec.test.js`, written out from the walk and verified
  against IEEE-754. It is the second, narrower oracle for the member layout
  specifically, and its two members are the null-vs-zero discriminator: member 0
  has both onsets absent, member 1 carries `firstAlertStep = 0` present, and
  their step payloads are byte-identical zeros separated only by the flag.
- **`tests/fixtures/evolution-v1-kimi-k3max.base64`** (v2, foreign) — preserved,
  **not regenerated**. Regenerating it through this repo's own encoder would
  have destroyed the only property that made it valuable. It keeps every leg the
  outer format owns and becomes the early-refusal witness, in Node and Chromium.

Re-establishing a genuinely *foreign* v3 artifact is a worthwhile follow-up; it
is not a blocker, because the two oracles above cover the changed encoding from
different directions.

## 7. What this does NOT do

- **It does not fix the physics.** The Rapier constraint-solver divergence
  diagnosed in PR #17 is unchanged. An ordinary legal vehicle still explodes.
- **It does not change selection.** Alert-bearing results remain `ok` and remain
  selectable. Option A is a *selection mitigation*, not a physics fix, and this
  PR is not even that — it is the evidence layer beneath it.
- **It does not decide anything.** No escalation, no threshold, no policy bump.
- **Multibody / Rapier source-build work is deferred** by maintainer choice and
  is absent from this diff.

## 8. What it enables

`scripts/history-observations.js` — `extractHistoryObservations(historyBytes,
{ expectedHistoryDigestBytes?, includeGenotypeDigest? })` — returns the decoded
per-individual evidence from a **cryptographically verified** artifact, with no
physics. It runs the same `verifyHistoryArtifact` and both gates the production
resume path runs, and shares their error taxonomy; there is deliberately no
second, script-local notion of what a valid history is.

Its scope is decoded rows and nothing else — no aggregation, rates,
distributions, thresholds or counterfactuals. Those belong to Next PR, and
keeping them out is what stops an offline reader from quietly becoming a second,
unversioned fitness policy.

## 9. Handoff to Next PR

Confirmed findings, reproduced against `main`, carried forward so they are not
rediscovered:

**Adjudication**
- `analyzeTrace` **cannot adjudicate a sub-alert case** — it uses the same three
  thresholds, and `trace-forensics.js:436` skips alert-free bodies, so the
  causal scan never runs. An *independent* rule is required. The instruments
  exist: joint-constraint violation (`probe-physics-explosion.js:1235-1253` —
  PR #17's earliest signature, a constraint metric rather than a kinematic one),
  `passiveTwinOf`, and the `freeSpace` / `gravityOff` ablations.
- **Whole-run peaks do not measure boundary proximity at first crossing.** The
  five fields give later maxima plus one combined onset; they cannot say *which*
  predicate fired first or how far over it was at that moment. Use forensic
  onset measurements, or call the metric **whole-run severity** — never
  "boundary clustering". (Persisting value-at-first-alert would change policy-v1
  observation semantics and was deliberately out of scope here.)

**Infrastructure**
- `executeExperimentPhase` hard-fails outside `screen`/`confirm`, and `confirm`
  demands all 156 screening runs — Next PR needs its own schema, phases and file.
- Workspace helpers are mutation-experiment-specific (the manifest carries
  `candidateArmId`).
- `executeRun` returns `{summary, performance}` — history bytes are dropped.
- Retained binary histories must bind atomically to their JSON records.
- **Persisted artifacts must be verified before being read as evidence** — §8's
  rule applies to every consumer, not only the extraction seam.

**Analysis**
- A filtered-pool counterfactual needs a reconstruction tooth: the *unfiltered*
  pool must first reproduce the persisted elite ids and per-child tournament
  parents exactly.
- Counterfactual reconstruction needs population, fitness vector,
  next-generation lineage, run seed, child ids and pool identity — not just
  vector and lineage rows.
- Exclusion is an **OR over three predicates**, so any distance metric needs a
  normalized margin across all three, with per-predicate attribution.

**Protocol**
- Gate numbers must be literal and predeclared, with a maintainer checkpoint
  after the protocol-only commit and before broad execution; forensic sampling
  must define ordering, strata, deduplication, backfill, tie-breaks and
  empty-set semantics.
- Cost gates evaluate per arm and per seed block.
- `+Infinity` needs an evidence-JSON representation (§2.2).

## 10. References

- `docs/solver-divergence-remediation-2026-07.md` §2 — Option A and its
  prerequisites; step 1 is discharged by this PR.
- `docs/numerical-integrity-policy-2026-07.md` — policy v1/v2, the alert band
  left open.
- `docs/ga-phase-1b-pr4-evolution-experiment-2026-07.md` §1, §1.5 — the
  contamination finding this PR makes readable.
- `docs/ga-phase-1b-pr3-evolution-history-2026-07.md` — the history format.
- `docs/canonical-codec-foundations-2026-07.md` — the codec rulings this
  encoding follows.
