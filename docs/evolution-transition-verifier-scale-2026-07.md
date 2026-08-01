# Evolution transition-verifier scale validation (PR 4D) — evidence and measurement decision

> **Committed reference run — machine-specific, NOT a universal package property.**
> All numbers below come from the two machine-readable reports committed beside
> this document — `evolution-transition-verifier-scale-evidence-node-2026-07.json`
> and `evolution-transition-verifier-scale-evidence-browser-2026-07.json` —
> which carry the raw timing samples (per-row `samplesMs`, batch
> `perArtifactMs`, both paired-resume arm arrays). Per-sample event-loop
> histograms, frame-gap series, and memory snapshots are aggregated as
> disclosed in §3, not carried sample-by-sample. They are NOT asserted by any
> test; the only CI touchpoints are the schema smoke in
> `tests/evolution-verification-bench-schema.test.js` and the tiny browser
> liveness in `tests/browser/evolution-verification-bench-smoke.test.js`.

**Status: PR 4D evidence, pre-merge.** §8 is the branch's evidence-backed
recommendation. Final unblocking of the breeding-pool, false-negative and
mutation-default measurements remains contingent on this PR merging, on
independent review of this evidence, and on maintainer acceptance of the
decision. **Nothing under `src/` is changed by this PR.**

## 1. The question and the decision rule

PR 4D answers one question with reproducible evidence:

> Is the landed PR-4C verifier (exact persisted adjacent-transition
> authentication — `verifyPersistedTransitions`, `src/sim/evolution-replay.js`)
> operationally acceptable at representative measurement workloads and at the
> legal v1 envelope, for extraction and resume, in Node and in the browser?

The rule was fixed with the budgets (§4) BEFORE the measurement runs. The
budgets live as data in `scripts/bench-evolution-verification.js` and are
echoed verbatim into every report, so the predeclaration is verifiable by
diffing the instrument commit against this document.

- **GO** — every gating budget (B1, B2, B6) passes on the landed PR-4C code,
  no non-gating result worse than its declared classification, no trust defect.
- **GO WITH RESTRICTIONS** — all gating budgets pass; one or more named
  non-gating restrictions, each stated verbatim.
- **NO-GO** — a gating budget fails and the measured dominant cost does not
  yield to an in-scope byte-identical correction (which would have split the
  work into PR-4D1/PR-4D2), or a trust/correctness defect is found.

No production optimization was performed: no gating budget failed, so the
optimization phase never triggered (§6.8 measures why the obvious candidate
would barely have mattered).

## 2. Environments

| | Reference environment |
|---|---|
| CPU | Intel Core i7-14650HX, 24 logical cores |
| OS | Windows (win32) 10.0.26200, x64 |
| Node | v22.19.0 |
| Browser | Chromium 149.0.7827.55 (Playwright 1.61.1, headless) |
| Rapier | `@dimforge/rapier3d-compat` 0.19.3, `@dimforge/rapier3d-deterministic-compat` 0.19.3 |
| Node evidence commit | `ec21f4a…` (dirty tree: no), report generated 2026-07-31T02:22Z |
| Browser evidence commit | `5edca1b…` (dirty tree: no) |

Commit note, disclosed for exactness: the Node matrix was measured at `ec21f4a`.
The branch was then amended to `5edca1b`, changing only the parent's
child-resolution to wait for child exit (the `--profile-one` flush race fix).
Measured intervals are captured INSIDE the child processes and cannot be
affected by when the parent resolves a result; the amended code was
re-validated end-to-end (hostile mode) and the browser matrix ran on `5edca1b`.

Instruments (manual evidence commands, never CI jobs):
`npm run bench:evolution-verification` and
`npm run bench:evolution-verification:browser`.

## 3. Methodology (what each number means)

- **Four questions, never one timing.** (1) Shared pre-runtime verification
  (`extractHistoryObservations` — no runtime identity, no physics). (2) Resume
  pre-replay gate: a transition-honest artifact carrying a foreign runtime
  identity — it passes every shared gate including transition authentication
  and refuses at `runtimeVersionMismatch` before world creation; never labeled
  full resume. (3) Full genuine resume: only genuine physics-produced
  histories, replayed. (4) Event-loop/main-thread stall, measured on its own.
- **Phase separation.** Artifacts are constructed once per row before any
  measured interval (`constructionMs` reported separately) and reused
  byte-identically across samples. No construction is inside a reader interval.
- **Isolation.** Node: one fresh child process per measured sample (fork +
  IPC; stdout reserved for diagnostics), discarded warm-ups inside the child.
  Browser: one fresh page per sample; artifacts built Node-side, served by a
  benchmark-only endpoint, digest-verified by the page — never built in the
  measured page. Every browser row asserts DRIVER-TO-PAGE byte-identity (the
  page proves it received exactly the bytes the driver built; all
  `matchesDriverArtifact: true`). Cross-report identity holds for the two
  artifacts that exist in both evidence inventories (G2 and the legal
  maximum — identical SHA-256); the two browser-only synthetic rows' digests
  are byte-reproduced by the Node builder, pinned in CI.
- **Event loop.** Node: `monitorEventLoopDelay` (1 ms resolution) PRIMED two
  timer turns before t0 and DRAINED two turns after t1 — the histogram is
  timer-based, so without the turns it records nothing about the block
  (reproduced during review: unprimed, a 200 ms block reads count 0; primed
  and drained, max ≈ 201 ms). Browser: rAF + 4 ms timer heartbeats, primed and
  drained the same way. The PR-4C transition loop is synchronous once entered;
  the Promise API is not an asynchrony claim, and this report makes none.
- **Memory.** Node: before/after `process.memoryUsage` plus
  `process.resourceUsage().maxRSS` — the process-lifetime resident high-water
  in a fresh child — differenced against a NO-OP BASELINE CHILD that loads the
  artifact and runs nothing. Operation-moment heap peaks inside the
  synchronous verifier are unavailable by construction (no same-thread sampler
  can execute inside it; pinned by a harness self-test), and nothing here is
  called "peak memory". Browser: driver CDP `Performance.getMetrics` polling,
  labeled non-peak and non-process; in-page `performance.memory` is collected
  by the page but deliberately not aggregated into rows (deprecated, rounded).
- **Artifact classes.** Synthetic artifacts are kernel-honest (every successor
  is the production kernel's exact output over the previous record's persisted
  facts; extraction-only by design). Genuine artifacts are production-run
  output through the committed PR-4 campaign protocol shape. The corpus guard
  requires 8 distinct digests and complete production-run provenance; a
  synthetic substitute impersonating a genuine member diverges under genuine
  replay (pinned in the schema test).
- **Capacity.** The legal envelope is derived at runtime through the public
  creation refusal (`resourceLimitExceeded` context): **228 generations at
  population 256, 912 at 64** — both asserted and reported — with the policy
  maximum 1024 applying WITHOUT refusal at population 4. Nothing is hardcoded.
- **Statistics.** Median and p90, nearest-rank `ceil(p·N)`; raw samples in the
  JSON reports; whole-ms rounding; samples ≥ 3 per row (5 for most Node rows).
- **Drift control.** Corpus member G2's row is measured first and last in the
  Node session: 113 ms vs 111 ms — session drift ≈ 2 %. Run 1 (superseded by
  a fix, §6.9) and run 2 medians agree within ≈ 5 % across the shared rows.

## 4. Predeclared budgets

| ID | Scope | Budget | Gating? | Protects |
|---|---|---|---|---|
| B1 | genuine-corpus extraction, fresh child, Node | per-member median ≤ 2000 ms, p90 ≤ 3000 ms | yes | analyst iteration (204 histories per pass) |
| B2 | batch row, campaign proportions (156×30 + 48×60) | one-pass total ≤ 210 s (5 % of the 70-min campaign wall) | yes | campaign schedule |
| B3 | legal-max Node extraction (256/228) | median ≤ 60 s; high-water delta ≤ 512 MiB | no | legal-envelope batch operability |
| B4 | full genuine resume, population 20 | median(resume) ≤ 1.35 × median(production), paired arms | no | resume-dependent tooling |
| B5 | browser representative extraction | median max frame gap ≤ 1000 ms | no | interactive-use honesty |
| B6 | representative Node memory | per-row high-water delta ≤ 128 MiB | yes | CI/dev machines |

Responsiveness bands: ≤100 ms interactive; 100–250 noticeable; 250–1000
severely degraded; >1000 batch/non-interactive. Consequences of a miss:
gating budgets → optimize or NO-GO; non-gating → a named restriction, unless
catastrophic. A legal-max miss could not block the Node campaign on its own,
and Node success is never claimed as browser responsiveness.

## 5. Workloads

- **Genuine corpus (B1/B2/B6):** 8 members — control (0/0), defaults
  (0.05/0.05), aggressive (0.2/0.2), defaults-alt-seeds — at 30 and 60
  records, population 20, 300 steps, composite corridor, from the dedicated
  bench seed block 20260800–20260815 (never campaign-allocated seeds).
  Construction: production physics, 10.1–41.3 s per member, reported
  separately.
- **Scaling axes:** population 16/64/128/256 at 16 records; records
  1/8/16/32/64/128 at population 64; one interior cross (128/64).
- **Legal envelope (D1/D2):** population 256, 228 records (derived maximum),
  capacity-test configuration. Measured artifact: **55,711,346 bytes
  (53.13 MiB)**, SHA-256 `979db982…`, terminal `generationLimitReached`;
  construction 15.8 s (synthetic, kernel-honest). D2's artifact is the same
  base with a foreign runtime identity reforged in — **55,711,348 bytes**,
  SHA-256 `d1fe9da4…` (the two extra bytes are the longer version string).
  Genuine maximum-scale resume
  is NOT claimed: no genuine maximum history was constructed.
- **Hostile (E1/E2):** population 64, 32 records, population contradiction at
  pair 0 and at pair 30, both readers.
- **Resume (R3/R4):** pre-replay gate at pop 20/30 (synthetic + foreign
  identity); paired full resume at pop 20/30 and 20/60 (genuine).
- **Browser:** synthetic 20/30 and 20/60, genuine G2, legal-max — same bytes
  as Node (digests match), 3 fresh pages per row.

## 6. Results (Node)

### 6.1 B1 — representative extraction (gating): **PASS**

| Member | Arm / records | median ms | p90 ms | event-loop max ms | high-water delta MiB |
|---|---|---|---|---|---|
| G1 | control / 30 | 89 | 91 | 85 | 41 |
| G2 | defaults / 30 | 113 | 114 | 108 | 42 |
| G3 | aggressive / 30 | 116 | 119 | 113 | 43 |
| G4 | defaults-alt / 30 | 110 | 114 | 108 | 42 |
| G5 | control / 60 | 221 | 228 | 216 | 50 |
| G6 | defaults / 60 | 423 | 430 | 414 | 65 |
| G7 | aggressive / 60 | 225 | 230 | 218 | 50 |
| G8 | defaults-alt / 60 | 372 | 380 | 365 | 56 |

Every member is far below the 2000/3000 ms budget. The corpus proved its
necessity: transition cost is data-dependent — the two defaults-arm 60-record
histories are physically larger (1.37 MB and 1.22 MB vs 0.79 MB for
control/aggressive at 60 records) and cost ~1.7–1.9× the extraction time of
their same-record-count siblings. One convenient synthetic history would have
hidden this spread.

### 6.2 B2 — cumulative campaign overhead (gating): **PASS**

Batch row (one long-lived process, the 8-member corpus drawn in campaign
proportions — 156×30-record + 48×60-record):

| Pass | Total | Per-artifact median | Per-artifact p90 |
|---|---|---|---|
| 1 | 31,545 ms | 112 ms | 365 ms |
| 2 | 31,240 ms | 111 ms | 366 ms |
| 3 | 31,027 ms | 111 ms | 369 ms |

One full pass over the campaign's 204 histories costs **≈ 31.5 s = 0.75 % of
the 70-minute campaign production wall** (budget 210 s). Three measured passes
cost 93.8 s total; two passes calculate to 62.5 s; **6 passes fit within B2**.
Pass-over-pass stability is flat (no sustained-state degradation); the batch
process grew 8.6 → 13.3 MB heap with a 118 MB lifetime maxRSS over 612
extractions (762 between-operation sampler readings).

### 6.3 B3 — legal v1 envelope (non-gating): **PASS**

| Row | median ms | event-loop max ms | high-water delta MiB |
|---|---|---|---|
| D1 — extraction, 256/228 | 20,080 | 20,233 | 363 |
| D2 — resume pre-replay gate, 256/228 | 19,261 | 19,126 | 348 |

Budget: ≤ 60 s and ≤ 512 MiB. The legal envelope is a **batch operation**:
~20 s in one synchronous stage-11 block (event-loop max ≈ wall time) with a
~363 MiB resident high-water delta. This is a documented envelope
classification, not a failure; it matches the PR-4C review's starting
observations (~20 s, ~53.1 MiB) on the same machine class.

### 6.4 B4 — full genuine resume (non-gating): **PASS**

Paired arms (fresh processes, interleaved, zero warm-ups — physics dominates):
arm A = fresh production run; arm B = full resume of the preconstructed
genuine artifact.

| Shape | median production ms | median resume ms | ratio |
|---|---|---|---|
| G2 (20/30) | 13,711 | 13,656 | 0.996 |
| G6 (20/60) | 37,586 | 38,443 | 1.0228 |

Budget: ratio ≤ 1.35. Full resume ≈ production physics within ~2 %; the
verifier + framing share is bounded directly by the ratio, not by subtracting
unrelated medians. The resume pre-replay gate alone (R3, pop 20/30) costs
135 ms median.

### 6.5 B5 — browser (non-gating): **PASS, with one named restriction**

| Row | median ms | median max frame gap | band |
|---|---|---|---|
| B-synthetic-20-30 | 138 | 138 ms | noticeable |
| B-synthetic-20-60 | 233 | 233 ms | noticeable |
| B-genuine-G2 | 115 | 116 ms | noticeable |
| B-legal-max (256/228) | 13,884 | 13,885 ms | **batch/non-interactive** |

Budget: representative median max gap ≤ 1000 ms — met everywhere. See
restriction **R1** in §8 for the legal-max classification.

### 6.6 B6 — representative memory (gating): **PASS**

Corpus per-row high-water deltas (fresh-child `maxRSS` minus no-op baseline
child): **41–65 MiB** (table in §6.1) against the 128 MiB budget. Batch-row
sustained state in §6.2.

### 6.7 Hostile short-circuit (contract, not a speed benchmark)

| Row | reader | median ms | event-loop max ms | verifier kernel calls |
|---|---|---|---|---|
| E1, pair 0 | extraction | 124 | 115 | 1 |
| E1, pair 0 | resume | 129 | 117 | 1 |
| E2, pair 30 | extraction | 450 | 447 | 31 |
| E2, pair 30 | resume | 454 | 449 | 31 |

Both readers refuse `malformedHistory` / `persistedTransitionPopulationMismatch`
with `sourceGenerationIndex` exactly k — the first contradictory pair wins at
k + 1 verifier calls (the k + 1 identity is contract-pinned by
`tests/evolution-local-semantics.test.js` B4). A hostile history pays for the
prefix it makes the verifier authenticate, never the whole history.

### 6.8 Scaling and attribution

Records axis (population 64): 1 record 14 ms (fixed overhead, 0 kernel calls)
→ 8/110, 16/216, 32/452, 64/956, 128/1910 ms — linear at ≈ 14.8 ms per
record beyond the fixed digest/framing overhead. Population axis (16 records):
16/59, 64/215, 128/478, 256/1062 ms — ≈ ×2.2 per doubling: superlinear but
far from the O(population²) worst case the lookup scan permits. Interior
cross (128/64): 1963 ms.

`--profile-one` attribution at the legal maximum (one profiled extraction,
attribution only — not timing evidence): `captureGenotype` 30.0 %, garbage
collection 18.5 %, `serializeGenotype` 11.9 %, `deserializeGenotype` 5.0 %,
`repairGenotype` 4.5 %, `validateGenotype` 3.4 %, `assertStableShape` 3.2 %,
then `forEachGenotypeField`/`push`/`validatedMembers`/`genotypeEntries`/
`mutateContinuousGenotype` ≈ 1.7–2.7 % each. **The dominant costs are the
per-child mutation/codec obligations — several of them AST-pinned proof
obligations — while the O(population²) parent lookup does not register in the
top 20.** The obvious optimization candidate (a per-transition id map) would
have addressed a cost the profile cannot even see; the costs it would leave
untouched are structural. With every budget green, no optimization was
proposed or made.

### 6.9 Instrument defects found and fixed before evidence (disclosure)

Three instrument defects were caught by the integration runs and fixed before
the final evidence: a result-shape mismatch in the no-op baseline child, an
R4 dispatch field-name mismatch (paired arms not invoked), and a
message-vs-exit race in child resolution (the `--profile-one` flush). None is
in the measured paths of the final evidence; the hostile/scaling/legal-max
rows were measured twice across the pre-fix and final runs and agreed within
≈ 5 %, which is reported as the run-over-run repeatability bound.

## 7. Results (Chromium)

Covered in §6.5 (B5). Additional platform notes: the browser legal-max
extraction (13.9 s) ran FASTER than Node's (20.1 s) — different V8 builds;
reported as an observation, not a portable claim. Browser memory is recorded
as CDP-poll/before-after JS heap with the in-block-peak limitation stated;
no process memory exists on the platform and none is estimated. The tiny CI
browser smoke (population 4, 3 records) remains the only browser test; the
full matrix stays a manual command.

## 8. Decision

**GO WITH RESTRICTIONS.**

All gating budgets pass on the landed PR-4C code with no production change:
B1 (representative extraction ≤ 430 ms p90 vs 2000/3000 ms), B2 (one
verification pass ≈ 0.75 % of the campaign wall vs 5 %), B6 (≤ 65 MiB vs
128 MiB). Every non-gating budget also passes (B3 20.1 s/363 MiB vs 60 s/
512 MiB; B4 ratios 0.996/1.0228 vs 1.35; B5 representative gaps ≤ 233 ms vs
1000 ms). The restrictions, named verbatim:

- **R1 — browser legal envelope is batch/non-interactive.** At the legal v1
  maximum (population 256, 228 records, 53.13 MiB), Chromium extraction is a
  ~13.9 s synchronous main-thread block (band: batch/non-interactive).
  Browser imported-history verification AT THAT ENVELOPE is classified
  non-interactive; representative shapes (≤ 60 records, population 20) sit in
  the "noticeable" band (≤ 233 ms median max gap). A worker/yielding design
  for the browser envelope is real architectural follow-up — gate ordering,
  capture-once across awaits, transfer costs — and is explicitly NOT this PR.

Documented classifications that are NOT restrictions (they passed their
budgets): the legal-max Node read is a ~20 s, one-synchronous-block batch
operation with ~363 MiB high-water delta; full genuine resume costs ≈ the
production physics it replays (ratio ≈ 1.00–1.02).

**What this means for the deferred measurements:** the PR-4C verifier is
operationally acceptable for the Node measurement workflow at the PR-4
campaign shape and at the legal v1 envelope, and the evidence recommends
proceeding — subject to R1 and to the standing rule: **the breeding-pool,
false-negative and mutation-default measurements remain blocked until PR 4D
is merged, this evidence is independently reviewed, and the maintainer
accepts the decision.**

## 9. Limitations and residual risks

- One machine, one OS, one Node, one Chromium; numbers are machine-specific
  reference points, never thresholds (the CI touchpoints assert no timing).
- `maxRSS` is a process-lifetime mark; the no-op baseline isolates the
  operation share, but operation-moment heap peaks inside the synchronous
  verifier remain unobserved by design. Browser in-block peaks likewise.
- The batch row re-reads 8 distinct artifacts in campaign proportions; the
  real workflow may read up to 204 distinct histories. Distinctness effects
  beyond cache warmth are unmeasured (digests are content-addressed; the
  verifier's cost is shape- and content-driven, both covered by the corpus).
- The deferred campaigns' own shapes are not pinned anywhere; §10's formula
  re-derives overhead if the measurement PR's shape differs from the PR-4
  protocol's.
- The genuine corpus spans 3 arms × 2 seed pairs × 2 record counts; wider
  genotype-geometry variance would widen the extraction spread (§6.1 shows
  the effect exists — 89 ms to 423 ms within the corpus).
- Headless-Chromium rAF fidelity differs from headed; the 4 ms timer channel
  cross-checks it; results are a lower bound on interactive jank.
- The deferred `populationSize = 1` oracle-hardening case is unchanged and
  remains deferred.

## 10. Handoff to the measurement PR

- **Reuse-or-declare.** One shared verified extraction per history per
  analysis pass is the declared handoff: 1 pass ≈ 31.5 s (0.75 % of the
  campaign wall). If the breeding-pool and false-negative analyses cannot
  share one extraction result, budget `passes × perPassMs`; **6 passes fit
  within B2** on this machine. Formula: `overhead = passes × perPassMs`,
  `perPassMs` from the batch row at the campaign's shape.
- **Reproduction.** `npm run bench:evolution-verification[ :browser]` with
  the committed instrument at this branch's commit reproduces both JSON
  reports byte-comparably (artifact digests are content-addressed).
- **Retained histories.** Whether histories are retained at production time
  or regenerated (runs are seed-deterministic) stays the measurement PR's
  decision; verifier overhead per retained history is §6.1's per-member cost.
- **Browser.** Imported-history browser verification is fine at representative
  shapes; at the legal envelope it is R1-classified — do not promise
  interactivity there without the worker/yielding follow-up.

## 11. Post-review hardening (2026-07-31)

After the evidence commits, the branch went through a six-round adversarial
audit (21 parallel agents: spec-axis reviewers, implementation reviewers,
skeptics, critics, and a test-layer pass). Its headline conclusions are worth
recording here because they are independent confirmation of this document's
load-bearing claims:

- **Zero hard spec violations.** No `src/` changes, no deferred-campaign
  execution, documentation-truth wording clean, budgets provably frozen before
  measurement (byte-identical echo in both evidence JSONs), and the red-first
  claims verified against the PR-4C merge commit.
- **The evidence's core mechanics were independently re-proven:** driver-to-page
  byte-identity on every browser row plus cross-report identity for the two
  artifacts existing in both inventories (G2, legal maximum — matching
  SHA-256s), the foreign-runtime artifact
  executing all 227 kernel calls before `runtimeVersionMismatch`, the digest
  chain-of-custody (recomputed with `node:crypto`, bypassing the repo codecs),
  and every spot-checked headline number (0.75 %, 20,080 ms, 363 MiB, 0.996,
  13,885 ms) recomputing exactly from the committed JSONs.

The audit also found real defects — none in the measured paths, so the
evidence above stands unchanged — and they were fixed in a follow-up
hardening commit on this branch:

1. **The construction-order test tooth was broken** (set-membership, not
   order; vacuous on an empty event stream). Rewritten as a single-pass
   prefix guard with a non-vacuity canary and cardinality asserts.
2. **The browser prime-deletion tooth was dead:** Chromium rAF timestamps are
   frame-begin times, so the rAF channel self-primes even with the priming
   wait deleted (reproduced 6/6). The structural prime tooth now rides the
   4 ms tick channel (`tickPrimedBeforeT0`, asserted in CI and by the driver's
   row guard); the drain tooth was always real.
3. **In-page memory was collected but silently dropped while three places
   claimed it.** The claim, not the data channel, was wrong: driver method
   strings and this document now say CDP-only, with in-page
   `performance.memory` explicitly not aggregated.
4. **Budget evaluation re-hardcoded the thresholds it echoed.** Evaluation
   now reads `BUDGETS` by id; null is reported honestly where a channel is
   unmeasured (no false failures).
5. **`withContradictionAtPair` silently returned honest bytes for invalid k.**
   It now validates the pair index loudly.
6. **CI-presence gaps closed:** the B2 batch path (`runBatchSample` +
   `assembleBatchReport`), the browser driver's assembly guards
   (`assembleBrowserRow`, incl. the tick-tooth refusal), the corpus plan, and
   the full row matrix (`buildNodeRows`) are all exported and pinned in the
   schema test; the smoke matrix gained a genuine `resume-full` row so the
   `physics: true` leg is exercised in CI.
7. **Latent plumbing fixes:** the CDP poll loop now terminates in `finally`
   on the error path; `runBatchSample`'s sampler clears in `finally`;
   lone `--population`/`--records` and vacuous `--smoke` mode combinations
   refuse loudly; corpus provenance counts advances and records the actual
   terminal verdict instead of asserting them from the plan; reforged
   artifacts record their format history digest (the 32-byte trailer) instead
   of `null`; a stale `POLICY_DECLARED_REFERENCES` entry is now loud, and the
   star re-export regex covers `export * as ns`.

Disclosure, in the same spirit as §2: these fixes touch reporting fields,
guards, tests, and documentation — never a measured interval (t0/t1 are
captured inside the child processes and pages), so the committed evidence
JSONs remain valid as measured. The schema test now byte-pins the smoke
artifact's SHA-256, so any construction drift these fixes might have caused
would have failed loudly; it did not.

## 12. External-review corrections (PR #37, 2026-07-31)

The external review of PR #37 found **zero production-simulation or PR-4C
correctness regressions** and upheld the substantive GO WITH RESTRICTIONS
result, but required changes to the benchmark/reporting layer before merge.
All five findings were verified against the code and fixed in a follow-up
commit; none enters a measured t0–t1 interval, so the committed evidence
above stands. Each fix carries a failing-on-removal test in
`tests/evolution-verification-bench-schema.test.js`.

1. **Genuine-history provenance now flows through every reporting path.** The
   latent defect: `assembleRow` derived `verifierKernelCalls` from the plan's
   *requested* generations, batch draw classes used planned record counts, and
   the browser driver's genuine artifact hardcoded `30` /
   `generationLimitReached`. A shared campaign-shape gate
   (`assertGenuineMemberShape`, corpus module) now refuses any genuine run
   that terminates early — planned vs measured values in the message — at
   construction time on both the Node and browser legs; row assembly and
   batch envelopes consume the *measured* `advanceCount`; corpus validation
   requires complete campaign-shaped provenance. The committed G2 evidence
   genuinely is 30 records + `generationLimitReached`, so this was latent,
   not a wrong headline — and the schema test proves a 30-planned /
   7-advanced / `noSelectableParents` stub cannot be published as a
   30-record artifact on any of the three paths.
2. **B5 follows the predeclared budget object.** The browser driver evaluated
   its outcome against a literal `1000` while echoing `BUDGETS`; it now
   resolves the threshold from the same frozen `BUDGETS` by id
   (`assembleB5Outcome`, injectable — a test proves the verdict tracks the
   supplied budget, not a literal).
3. **The `--records 1024` CLI boundary now builds.** Custom rows used
   `maxGenerations = records + 1`, which became the illegal 1025 at the
   policy cap; at the cap the artifact is terminal (`maxGenerations: 1024`).
   Boundary-tested at 1023 (partial last record), 1024 (terminal), and 1025
   (refused at parse), including a real 1024-record build through the
   production verifier.
4. **Cross-environment byte-identity is claimed exactly where it is proven.**
   The earlier wording implied Node↔browser identity for all four browser
   artifacts, but only G2 and the legal maximum have Node-evidence
   counterparts. The claim is now: driver-to-page identity on every browser
   row (the driver's per-row assertion), cross-report identity for those two
   artifacts — and, pinned in CI, the Node builder byte-reproduces the two
   browser-only synthetic rows' committed SHA-256s.
5. **Memory units are consistent.** The legal-envelope high-water delta
   (380,157,952 bytes = 362.5 MiB) is now reported as **363 MiB** everywhere
   (the "~380 MiB" phrasing is gone from this document and CLAUDE.md).
