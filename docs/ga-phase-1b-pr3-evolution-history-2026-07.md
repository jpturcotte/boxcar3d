# GA Phase 1B PR 3 — the deterministic evolution engine, byte-only history, replay, and identity

**Status:** implemented
**Date:** 2026-07-22
**Scope owner:** PR 3 only. PR 4 owns the empirical experiment and every tuning decision.

This is the durable format, contract, verification, and follow-up record for
what PR 3 landed. It describes the implementation that exists rather than the
superseded planning process that produced it.

---

## 1. What PR 3 is

One coherent history-owning evolution module behind a deliberately small public
interface. The module owns population bytes, evaluation bytes, lineage, strong
artifact identity, replay, and retry semantics. PR 2's operators are pure
implementation dependencies.

```js
createEvolutionRun(config)                      -> EvolutionRun     (synchronous)
await resumeEvolutionRun(historyBytes, opts?)   -> EvolutionRun
await run.advance()                             -> AdvanceResult
run.status()                                    -> EvolutionRunStatus (frozen scalars)
run.historyBytes()                              -> fresh ordinary Uint8Array
```

**There is deliberately no public `advanceGeneration(population, evaluation)`.**
A stateless transition would have to decide whether an independently supplied
population and fitness result belong together, and the only binding available
for that decision is the fitness vector's FNV-32 snapshot-digest state — which
PR 2 explicitly ruled a *same-source, in-process mismatch sentinel*, never
equality between independently supplied artifacts. Rather than build a public
seam whose safety depends on a hash documented not to provide it, the transition
is private to an opaque run: it decodes the population from bytes it owns,
evaluates exactly that population, and derives the fitness vector from the same
owned transition. The FNV state is still checked — as the sentinel it is.

### Modules

| File | Role |
|---|---|
| `src/sim/evolution-contract.js` | Error taxonomy + `EvolutionError`, the terminal enum in wire order, engine/policy versions, v1 caps, checked arithmetic. A leaf with no imports — which is what keeps the family cycle-free. |
| `src/sim/evolution-lineage.js` | Canonical lineage v1 codec + cross-generation agreement. |
| `src/sim/evolution-history.js` | The fixed history codec, the domain-separated digests, the evaluation-metadata component, and the byte ceilings. |
| `src/sim/evolution-replay.js` | Ordered verification (stages 3–7), the runtime and freshness gates, and first-divergence reporting. Private implementation, not a public seam. |
| `src/sim/evolution-run.js` | The opaque run: config capture, generation 0, the private transition, draft/commit atomicity, resume orchestration. |
| `src/platform/sha256.js` | The WebCrypto adapter — the one collision-resistant digest seam. |
| `src/sim/evolution-fixtures.js` / `evolution-locks.js` | The committed fixture and its measured literals. |
| `scripts/probe-evolution.js` | The identity-only instrument (`npm run probe:evolution`). |

`evolution-contract.js` is a deliberate implementation module, and
the reason is recorded in its header: three things are shared by all four named
modules (the error taxonomy, the terminal enum the history *encodes* and the run
*decides*, and the caps), and every placement inside one of them creates an
import cycle or forces a file to land a commit early.

---

## 2. Versions and caps (frozen by this PR)

```text
EVOLUTION_ENGINE_VERSION       = 1     EVOLUTION_HISTORY_VERSION      = 1
EVOLUTION_POLICY_VERSION       = 1     GENERATION_RECORD_VERSION      = 1
EVOLUTION_LINEAGE_VERSION      = 1     EVALUATION_METADATA_VERSION    = 1
SHA256_DIGEST_BYTES            = 32

MAX_EVOLUTION_POPULATION_SIZE  = 256           MAX_EVOLUTION_GENERATIONS  = 1024
MAX_EVOLUTION_EVALUATION_WORK  = 1,000,000 population-steps/generation
MAX_EVOLUTION_COMPONENT_BYTES  = 16 MiB        MAX_EVOLUTION_HEADER_BYTES = 16 MiB
MAX_EVOLUTION_RECORD_BYTES     = 16 MiB
MAX_EVOLUTION_HISTORY_BYTES    = 64 MiB
```

The numeric ceilings are current operational budgets, not persisted GA
semantics. They can be tuned from measured game workloads without redefining
the byte format; semantic ordering and component meaning remain versioned.

Any semantic change to ordering, ID allocation, terminal precedence, RNG stream
ownership, reproduction row meaning, or record geometry requires the relevant
version bump and new lock literals. No existing codec version moved: the
genotype, population-snapshot, initializer, evaluation-spec, fitness-vector,
integrity, and trace versions are all byte-identical to `main`.

---

## 3. The transition

### Creation
1. Capture and validate the complete caller configuration under single-read
   rules (non-plain prototypes, non-enumerable own properties, and unknown keys
   all refused).
2. Reject an `evaluationSpec` carrying a `hooks` key — *even empty, even
   `undefined`* — and require `deterministic === true` after resolution.
3. Enforce the evolution population ceiling **before** `createInitialPopulation`
   allocates anything.
4. Normalize the initialization manifest, the population, and the evaluation
   spec through their own encoder/decoder pairs; retain only decoded values and
   owned bytes. Initializer diagnostics and raw genotypes are dropped.
5. Build generation-0 lineage (`origin = initialized`, no parent, zero
   counters); set `nextIndividualId = populationSize`.

Nothing is evaluated, digested or committed until the first successful
`advance()`.

### `advance()` — draft, then commit
Only one may be in flight; a concurrent call throws `advanceInProgress`
**synchronously**, before any microtask, so a second caller never observes the
draft. The draft evaluates, captures and validates evaluation metadata,
serializes then immediately decodes the fitness vector, discards the live
evaluation, builds the pool from the decoded vector, decides the terminal reason
*once*, derives the next generation if non-terminal, encodes the record, and
computes every digest. Only then does it replace committed state, in plain
assignments that cannot fail.

If anything throws, the committed run is byte-identical to its pre-call state,
and a retry produces the same result — because every child's randomness comes
from `(seed, childId)`, never from a mutable stream a failed attempt advanced.

### Replacement, IDs, lineage
Elites first, in `selectElites` rank order, each receiving a **fresh** id (the
previous id survives only as `parentIndividualId`); then mutated children in
ascending new-id order. All `N` ids are allocated as one checked contiguous
interval **before** any randomness is drawn. Each child derives
`new Rng(seed).fork(childId)`, calls `selectTournamentParent`, resolves that
parent in the owned current population, and calls `mutateContinuousGenotype`.

IDs are globally unique within a run, never inferred from array position, never
recycled, and never preserved on elite copies — which is what gives
non-overlapping RNG stream ids and unambiguous lineage.

### Terminal precedence
`noSelectableParents` → `generationLimitReached` → `individualIdExhausted` →
`none`. Decided before the record is encoded; a record is never mutated after
its digest and a terminal record is never appended twice (a terminal run repeats
its result and does no work). Under the v1 caps, `individualIdExhausted` is
mathematically unreachable (256 × 1024 ≪ 2³²); the enum and the checked
arithmetic stay so a future cap change fails safe.

**An empty selectable pool is terminal.** The engine never substitutes an
invalid or diagnostic champion.

---

## 4. History format v1

All integers unsigned little-endian; all lengths checked with safe-integer
arithmetic before any allocation; all strings length-prefixed canonical UTF-8
with no NUL.

```text
u8[8]  magic "BC3DEVO1"     u16 historyVersion
u32    headerByteLength     u8[] headerBytes      u8[32] headerDigest
u32    generationRecordCount
repeat: u32 payloadByteLength | u8[] payload | u8[32] generationDigest
u8[32] historyDigest
```

Each generation payload is `u16 recordVersion | u32 generationIndex |
u8 terminalReason`, then **exactly four** components in fixed order —
population snapshot, evaluation metadata, fitness vector, lineage — each
`u32 length | bytes | u8[32] digest`. Terminal records carry the same complete
components as non-terminal ones.

### Digest domains

```text
boxcar3d/evolution-history/header/v1\0        .../population/v1\0
.../evaluation-metadata/v1\0                  .../fitness-vector/v1\0
.../lineage/v1\0                              .../generation/v1\0
.../history/v1\0

headerDigest     = SHA256(HEADER_DOMAIN    || u32le(len) || headerBytes)
componentDigest  = SHA256(COMPONENT_DOMAIN || u32le(len) || componentBytes)
generationDigest = SHA256(GEN_DOMAIN || previousDigest32 || u32le(len) || payload)
historyDigest    = SHA256(HISTORY_DOMAIN   || u32le(len) || historyBody)
```

Generation 0 chains from the **header** digest, so the chain covers
configuration and runtime identity, not only records. `historyBody` is every
outer byte from magic through the final generation digest, excluding the
trailer — a digest cannot cover itself.

**What an embedded digest proves: framing and self-consistency.** Not freshness,
not authenticity, not provenance beyond the encoded header, and not that the
artifact is the newest save. There are no signatures, MACs, or encryption
anywhere in this PR.

### The evaluation-metadata component, and why it exists
`u16 version | u8 worldMode | f64 effectiveDt | u32 executedSteps` (15 bytes).
The fitness vector carries no world mode, no effective timestep and no executed
step count — exactly the determinism evidence the existing evaluation locks were
built around. Replay compares this component **before** fitness, because a
drifted timestep *explains* a fitness difference and reporting the fitness first
would bury the cause.

### Lineage v1
`u16 version | u32 generationIndex | u32 count`, then per row (ids strictly
ascending) `u32 id | u32 parent | u8 origin | 11 × u32 accounting`. The parent
sentinel `0xffffffff` is required for `initialized` rows and forbidden for every
other origin, in both directions. Initialized and elite-copy rows must carry
all-zero counters; continuous-mutation rows carry the exact frozen accounting
the PR 2 operator returned.

---

## 5. Replay, resume, and the error taxonomy

Ordered stages, each with its own code, because verifying only the outer digest
would collapse every corruption class into "the history digest is wrong":

1. ordinary storage + the 64 MiB ceiling — **before the first copy**
2. copy the caller's bytes — **before any `await`**
3. framing: magic, versions, counts, nested lengths, exact end-of-input
4. header digest, then header decode + version agreement
5. every component digest, in generation order
6. the generation chain, from the header digest forward
7. the whole-history digest
8. external expected identity (staleness, *not* corruption)
9. decoded spec requires `deterministic: true`, then deterministic flavor +
   exact Rapier version — **before physics**
10. deterministic replay, stopping at the first byte divergence

`resumeEvolutionRun` is **not** an `async function`: the artifact and any
expected-identity bytes are validated and copied in its synchronous prologue, so
"no caller bytes are borrowed across an `await`" is structural rather than a
convention. The same ruling applies to `sha256`, `assembleHistory` and
`verifyHistoryArtifact`.

### Stable error codes
`invalidConfig` · `historyUnavailable` · `advanceInProgress` ·
`resourceLimitExceeded` · `malformedHistory` · `unsupportedVersion` ·
`componentDigestMismatch` · `generationChainMismatch` · `historyDigestMismatch` ·
`staleOrWrongArtifact` · `runtimeVersionMismatch` · `replayDivergence`

Lower-level storage/codec/initializer errors ride along as `cause`; callers
branch on `code`, never on text. Invalid artifact bytes are `malformedHistory`,
while invalid expected-identity option bytes are `invalidConfig`. A
`replayDivergence` reports `stage`, `generationIndex`, `byteOffset`,
`expectedByte`/`actualByte`, and `lastAgreedGenerationIndex`.

### Freshness
Without an external expected digest or index, resume claims only that the
artifact is well-framed, self-consistent, current-version compatible, and
deterministically replayed. A valid *older* save verifies perfectly — that is
the point, and it is why `staleOrWrongArtifact` is a distinct code reached only
when the caller supplies what it expected.

### Peak memory
At the 64 MiB ceiling, the conservative append-side JavaScript peak is about five
history-sized buffers (segmented payloads, old aggregate, new aggregate,
domain-framed digest input, and SHA's defensive copy), or roughly 320 MiB before
component scratch, populations, physics, and opaque WebCrypto memory.
Verification itself decodes one payload at a time and discards it, but append
rebuilds the aggregate each generation and is O(G²) copying across a long run.
Segmented append storage and an advisory performance probe are explicit follow-up
work before treating the current maximums as normal campaign sizes.

Creation and resume also project the largest artifact permitted by the run's
fixed v1 geometry before any physics. The projection uses the largest starting
genotype for every future population row (selection may concentrate it), fixed
fitness/metadata/lineage widths, and maximum legal runtime-identity string
lengths. A configuration whose requested generation count cannot fit returns
`resourceLimitExceeded` with `maximumFeasibleGenerations`; it cannot enter a
permanently-ready run that fails every later `advance()` at the history ceiling.

---

## 6. Identity locks

Fixture `evolution-a-small-flat` v1 (population seed **20260742**, terrain seed
**20260743**): 6 individuals × 3 generations × 45 steps on the flat start pad,
terminating on the generation limit. It exercises initialized generation 0,
elite copying, tournament selection, both mutation branches (a child with zero
selected leaves *and* children with several), lineage accounting, and a terminal
record — and `tests/evolution-determinism.test.js` asserts that structural
coverage, so a fixture change cannot quietly narrow what the locks prove.

```text
header  (536 B)   6b872cad…bfcce51b
history (12126 B) da573ca5…1ef20e55
```

Reproduced by Node on Ubuntu/Windows/macOS (`npm run test:determinism`) and by
pinned Chromium (`npm run test:browser`) — the browser gate agreed on the first
run, including the SHA-256 seam, which is PR 3's one genuinely new cross-runtime
dependency.

The in-repository golden lock is intentionally not the sole oracle. A static
4,024-byte artifact produced independently by the Kimi implementation is
committed at `tests/fixtures/evolution-v1-kimi-k3max.base64`, with provenance
and literal digests in the adjacent Markdown file. Node and Chromium reproduce
its generation 0 bytes, resume it, and continue it to the same terminal digest.
The final cross-worktree harness also established byte-identical headers and
all four generation components, plus mutual Claude/Kimi resume. This closes the
principal circular-evidence risk of generating a codec's only fixture with the
same codec under test.

**Re-lock workflow:** set `historyDigest` to `null` in
`src/sim/evolution-locks.js`, run the Node gate — it fails printing the full
measured record as paste-ready JSON — paste it, get Node green, then pinned
Chromium must agree before merge.

---

## 7. Enforcement

Every new module is registered in the *derived* inventories rather than a
hand-kept list:

- the byte-family lint scope is now derived from **every** config block carrying
  the shared `BYTE_SAFETY_SYNTAX` selectors (previously a single-block lookup by
  filename, which would have silently stopped covering the family the moment the
  platform adapter got its own block), and the module walk covers `src/platform`
  as well as `src/sim`;
- `tests/ownership-boundary.test.js` pins the export surface, the role table,
  the ownership verdicts, and the storage-intake classification, with the
  four-axis fancy-storage battery (detached / SharedArrayBuffer / resizable /
  cross-realm) run against every gated seam;
- `tests/single-read.test.js` covers each new caller-data export or exempts it
  with a stated reason.

Two real defects were found by those instruments during implementation and fixed
at source rather than exempted: `crossCheckLineage` read its rows twice, and
`encodeGenerationPayload` read `record.components` once per component kind.

**Deliberate sabotage: 12 mutations, all bite.** Terminal precedence,
one extra RNG draw, child-ID order, one lineage parent, one digest domain,
verification order, the runtime version check, a component-length ceiling,
copy-before-await, the fresh history copy, the trace-mode-`none` seam, and the
generation chain. The verification-order mutation was **silent on the first
attempt** — the component-corruption tests reassembled the artifact, so they
recomputed the outer digest and would have stayed green if the whole-history
check ran first. Two in-place corruption tests now enforce the ordering
property; that is the round-10 lesson (*a test written to the fix is not
enforcement of the rule*) recurring inside this PR.

An additional test-oracle audit began from the hostile premise that tests had
been reverse-fitted to the implementation. It found one real vacuity in a new
mutation-boundary test: the test filtered lineage using a nonexistent origin
name, producing an empty collection. The filter now uses
`continuousMutation`, asserts that children are present, and verifies selection
and byte-delta accounting at `(p,m) = (0,1), (1,0), (1,1)`. Population
composition is also exercised at sizes 1, 2, 3, and 6 with tied selectable
pools. These tests now constrain observable contracts rather than merely
repeating implementation structure.

---

## 8. Trace policy (Commit 0)

PR 3 persists **byte-only** evolution history. Evaluation is forced to trace
mode `none`; trace records, checkpoints, live diagnostics and comparator
evidence are structurally absent from the format. The mutable-trace and
compare-class deferrals therefore expire when a **non-null trace** crosses a
persistence, replay, determinism-lock or artifact-identity trust boundary — not
merely when unrelated evolution bytes are persisted. The full decision record is
[`canonical-codec-foundations-2026-07.md` §Round 15](canonical-codec-foundations-2026-07.md);
the premise is enforced by static and runtime tests in
`tests/evolution-run.test.js`.

The §Round 12 **strong-digest deferral is discharged**, not narrowed: SHA-256
now provides artifact identity. FNV-1a32 keeps its unchanged role — drift/lock
digests and the same-input cross-environment determinism comparator — and no
evolution artifact identity is ever established by FNV.

---

## 9. PR 4 handoff — the empirical brief

PR 3 deliberately answers **no** empirical question. Everything below is PR 4's,
and nothing in PR 3 should be cited for any of it.

**What PR 4 owns**

1. **The full experiment.** A real population over many generations on real
   terrain, sized from the measured cost of the mechanism rather than from the
   3-generation identity fixture. `npm run probe:evolution` is identity-only and
   is explicitly not a performance or quality instrument.
2. **The empirical report.** Fitness trajectories, diversity, and whether
   anything resembling improvement occurs at all — stated as observations with
   their seeds and sample sizes, per the claim-to-committed-arm discipline that
   PR #17 and PR #19 paid for.
3. **Validation or deliberate tuning of the provisional mutation defaults.**
   `{ probability: 0.05, magnitude: 0.05 }` is a PR 2 baseline that has never
   been measured. The resolved numbers are encoded in every history header, so a
   retune is a visible, versioned act — but it *will* move the committed
   evolution locks, and that re-lock must be deliberate.

   > **CORRECTION (PR 4, 2026-07-22): the clause after the dash is FALSE.** A
   > mutation-default retune does **not** move the committed evolution locks.
   > `EVOLUTION_FIXTURE_A` declares its mutation parameters as LITERALS and
   > `evolutionRunConfigFor` passes them explicitly, so the locked artifact never
   > reads `PARAMETRIC_MUTATION_DEFAULTS` — a property the fixture's own comment
   > states deliberately ("PR 4 may deliberately retune the defaults, and that
   > must not silently re-point this fixture at new numbers"). Verified by
   > execution rather than by reading: setting the defaults to `(0.2, 0.2)` and
   > running `tests/evolution-determinism.test.js` leaves it green (5/5). Lock
   > stability across a default change is the EXPECTED behaviour, and unexpected
   > lock movement under such a change would be a blocker, not a re-lock.
   > See `docs/ga-phase-1b-pr4-evolution-experiment-2026-07.md` §8.
4. **Runtime and performance reporting.** The physics cost baseline
   (`docs/bench-physics-reference-2026-07-11.md`) says 50 max-topology vehicles
   do not meet the 60 FPS step budget; PR 4 should say what a realistic
   evolution run actually costs, and on what machine.

**What PR 3 already measured, and PR 4 should not re-derive**

- Generation-0 viability is real but modest (median ~2–3 m) — Phase 1A.
- Repair is near-universal on uniform raw draws; perturb genes freely and rely
  on repair for canonicalization — Phase 1A.
- Integrity failure ⇒ non-selectable, fitness 0, run per evaluation. Constraining
  the training terrain is *not* an escape hatch: mutation moves morphologies
  across the conditioning boundary both ways — PR-B.
- The mutation-neighborhood probe (`probe:integrity --pass neighborhood`) shows
  repair touching ~1.4–6.4 gene leaves per jittered child, with no false-positive
  integrity halo on that sample — PR-B.

**Known conditions PR 4 must handle rather than paper over**

- **An empty selectable pool is terminal.** With an integrity-hostile terrain or
  an unlucky seed a run can terminate at generation 0 with
  `noSelectableParents`. That is a result, not a bug, and the engine will not
  substitute a diagnostic champion.
- **Elitism is 2 of N.** At small `populationSize` that is a large fraction of
  the population; PR 4 should say whether it wants that.
- **Every generation costs `populationSize × maxSteps` isolated worlds**,
  sequentially. Worker sharding remains deferred (isolated-world evaluation is
  trivially shard-invariant, so the precondition is already met).

**Still deferred, unchanged:** crossover, structural mutation, discrete/
categorical mutation, adaptive selection, population resizing, novelty metrics,
trace persistence, a browser UI or storage provider, worker sharding, zone
material response, S2 trailing arms, and an evolvable per-genotype surface-speed
gene.

---

## 10. Reproduce

```bash
npm run lint
npm test                  # 59 files, 1541 tests
npm run test:determinism  # 6 files, 50 tests incl. evolution identity
npm run test:browser      # pinned Chromium 149.0.7827.55, 4 files, 20 tests
npm run build
npm run probe:evolution   # the identity instrument (--json for the report)
```

**Seeds allocated by this PR:** 20260740 (engine unit-test population),
20260741 (engine unit-test terrain), 20260742 (committed fixture population),
20260743 (committed fixture terrain).
