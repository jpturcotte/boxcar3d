# Rapier core-0.34 Verification Spike — Decision Record (2026-07)

> **Layer-2 independent verification** (see the plan's three-layer evidence
> model). This record is produced from a from-source build of the current
> upstream Rapier monorepo, run against BoxCar3D's committed contracts and the
> PR #17 explosion evidence. It is OBSERVATIONAL: nothing here changes the
> production dependency, and no golden lock is re-locked during the spike.
> PR-A's results are frozen BEFORE the draft-PR-#18 comparison (§9).

**Status: local investigation COMPLETE; controlled CI reproduction PENDING the
first `heavy=true` dispatch (§2/§4, Part C). Verdict: OUTCOME B** — core 0.34
retains substantially the same divergence (reproducer still catastrophic on
both flavors; prevalence 5/60, same individuals; +2/20 on a fresh seed). The
candidate is otherwise clean **over the surfaces the local run exercised**
(internally deterministic, every project contract preserved, no Class-1/3/4
regression on the Node suite + probes, no borrow error reproduced — see §6 for
the exact surfaces, and note candidate Chromium / Vite build + app smoke /
paired bench are the local run's SKIPS, run only by the controlled CI
experiment) — but there is no divergence-fix to adopt. **PR-B (the
numerical-integrity policy) proceeds on stable 0.19.3 as planned; the multibody
binding-extension investigation is the named follow-up.**
The multibody 2×2 shows the joint REPRESENTATION / constraint-enforcement regime
(not the engine version) is the lever — measured for the UNDRIVEN reproducer
only — but ALL multibody motor/limit methods are commented out of both bindings,
so the driven phenotype cannot take that path. Full evidence below; gate
rationale in §10.

Spike artifacts (identifiable by hash, §3): candidate tarballs +
build/probe logs preserved locally under
`C:\Users\jp2k5\GitHub\rapier-034-spike-artifacts\` (the two `.tgz` at the root
+ `spike-logs/`); the from-source build tree is disposable (Outcome B — not
adopting). These are the **historical local build** (§2); the reproducible,
artifact-audited evidence is the committed `workflow_dispatch` experiment
(`.github/workflows/rapier-034-spike-experiment.yml`, §2/§4). The fresh-seed
20260730 arm was originally run programmatically via
`runProbe({ passes:['prevalence'], prevalenceSeeds:[20260730] })`; the probe CLI
now exposes it directly too:
`npm run probe:physics-explosion -- --pass prevalence --prevalence-seeds 20260730`.

---

## 1. Identity block

| Field | Value |
| --- | --- |
| Upstream repo | `dimforge/rapier` |
| Upstream commit | `c13133ad293ee70c7f9cec9e498eac016c362169` ("Move rapier.js into this monorepo (#960)", 2026-07-12) |
| Rust core version | **0.34.0** (`crates/rapier3d/Cargo.toml` → `version.workspace = true`; workspace `version = "0.34.0"`) |
| Binding TS package self-id | `0.19.3` (template `version = "0.19.3"`, before patch) |
| `parry3d` pin | `0.29` (build template) |
| `wasm-bindgen` pin | `0.2.109` (build template) |
| BoxCar3D base SHA | `7bf46d1` (main; PR #17 landed) |
| BoxCar3D PR-A branch | `claude/numerical-integrity-rapier-policy-ac0a39` |
| Stable dep pins under test-against | `@dimforge/rapier3d-compat@0.19.3`, `@dimforge/rapier3d-deterministic-compat@0.19.3` (core ~0.30.1) |
| Toolchain (historical local build) | rustc/cargo 1.90.0, wasm-pack 0.13.1, Node 22.19.0, wasm-bindgen (wasm-pack-managed), Windows 11 x64 |
| Toolchain (CI experiment arm) | asserted per run — `command -v wasm-pack` absolute path + `wasm-pack --version` recorded BEFORE the build and written into the provenance bundle (§2); `build-rust.sh` is invoked directly, NOT via `npm run`, so upstream's `typescript/package.json` wasm-pack **0.12.1** devDep cannot PATH-shadow the intended system wasm-pack |
| Committed `package-lock.json` SHA-256 | `16882aeda3d037d26830d04b6cbbb06b516714b9e8985fb37f3b9f75f0a37ffa` (the stable-dependency lock the candidate arm rewrites; recorded so the candidate-install delta is auditable) |
| CI experiment commit SHA | resolved per dispatch to an immutable 40-char `github.sha` and written into every workflow artifact (§2) — deliberately NOT pinned in this record (the decision-record commit is legitimately newer than the experiment commit; pinning a "final PR-A head SHA" would be a self-reference loop) |
| npm dist-tags (2026-07-14) | `latest: 0.19.3`, `canary: 0.0.0-0fd32c1-20251105` (the canary is an OLDER commit than c13133ad — no published canary carries core 0.34 yet) |

Packaging identity patch (the only change to engine/wasm **source** — the CI
experiment arm, §2, runs upstream's packaging scripts UNMODIFIED, so on that
reproducible arm this patch is the sole tree edit; the historical local build
additionally trimmed packaging-only scripts, disclosed in §2). Keeps
`RAPIER.version()` distinguishable — the wasm bakes `CARGO_PKG_VERSION` at build
time, `typescript/src/lib.rs:16-17`:

```diff
# typescript/builds/prepare_builds/templates/Cargo.toml.tera
-version = "0.19.3"
+version = "0.19.3-c13133ad.0"
```

Tarball / wasm-binary / patched-file SHA-256 hashes: §3.

## 2. Build recipe (reproducible from the pinned commit)

> **Two builds, one verdict.** The §3–§5 evidence was first produced by a
> **historical local build** (Windows, 3D flavors only, with the packaging
> deviations disclosed below under "Build progress / deviations"). The
> **reproducible, artifact-audited arm** is the committed `workflow_dispatch`
> experiment (`.github/workflows/rapier-034-spike-experiment.yml`): it builds
> all six flavors from the pinned commit with upstream's packaging scripts
> **unmodified** (no `gen_src`/`rollup` trim), invokes `build-rust.sh` directly
> in the required order (deterministic-3D first), and asserts its own toolchain
> — so on the CI arm the §1 identity patch genuinely is the only tree edit. The
> exact CI recipe and its measured artifact hashes fold into §2/§3/§4 once a
> `heavy=true` dispatch lands (C5). **wasm is not byte-reproducible across
> environments**, so the CI wasm/tarball hashes will differ from §3's local
> hashes; the Outcome-B verdict reproduces at **classification level**
> (catastrophic vs quiescent, prevalence counts), not to the last m/s (§10).
> The historical local recipe follows.

Day-0 discovery findings (read before building):

- **The flavor system is GENERATED.** `typescript/builds/` holds only
  `prepare_builds/`. Running `builds/prepare_builds/prepare_all_projects.sh`
  (a `cargo run -p prepare_builds` over `{non-deterministic, deterministic,
  simd} × {dim2, dim3}`) renders per-flavor crate dirs from
  `templates/Cargo.toml.tera`. The `rapier-compat` `build` script alone does
  NOT create them — prepare must run first.
- **The deterministic flavor exists and maps to `enhanced-determinism`:**
  `prepare_builds/src/main.rs:60` → `FeatureSet::Deterministic => vec!["enhanced-determinism"]`;
  the generated `builds/rapier3d-deterministic/Cargo.toml` carries
  `rapier3d = { version = "0.34", features = ["enhanced-determinism", …] }`.
- **`[patch.crates-io]`** in `typescript/Cargo.toml` redirects `rapier3d` to
  `../crates/rapier3d` (in-repo core 0.34) — so the `version = "0.34"`
  requirement resolves to the local monorepo crate, not crates.io.
- **`version()` returns `CARGO_PKG_VERSION`** (`typescript/src/lib.rs:16-17`) —
  hence the identity patch (§1); without it a core-0.34 build reports `0.19.3`.
- **Compat package naming** is applied by `rapier-compat/rollup.config.js:34`
  (`@dimforge/rapier${features_postfix}-compat`, e.g. `3d-deterministic`).
- **Multibody motor/limit surface on core 0.34 (verified in the checked-out
  `src.ts/dynamics/multibody_joint.ts`, 2026-07-14):** `RevoluteMultibodyJoint`
  and `PrismaticMultibodyJoint` both extend `UnitMultibodyJoint`, whose
  `limitsEnabled`/`configureMotorModel`/`configureMotorVelocity`/
  `configureMotorPosition`/`configureMotor` are **all commented out**
  (lines 147–182). `SphericalMultibodyJoint` (a 3-DOF ball joint, lines
  200–221) is the same story — its four motor methods sit inside a
  `/* Unsupported by this alpha release. */` block, i.e. **also commented
  out** (and, taking `Vector`/`Quaternion` targets, unusable for a 1-DOF
  wheel revolute or a 1-DOF suspension prismatic even if they were exposed).
  So **EVERY** multibody motor/limit method — Unit and Spherical — is
  commented out on BOTH 0.19.3 and core 0.34; the Rust-0.34 multibody
  armature/per-DoF-spring features are not exposed through TS either.
  **Conclusion unchanged from 0.19.3 and in fact strengthened: NO multibody
  joint exposes a motor or a settable limit from JS, so the motorized
  production phenotype (S0 revolute velocity motor; S1 prismatic
  position-motor + limits) cannot be realized on multibody joints from JS,
  even on core 0.34.** The undriven multibody reproducer arm needs neither, so
  it remains possible.
- **Upstream CI status at this commit:** the "TypeScript bindings" workflow
  *run* shows **failure — but only in the `publish` job's "Publish projects"
  step** (an npm-auth/version-collision publish concern on a monorepo-merge
  commit). Both `build` and `build-compat` jobs (ubuntu + macos) **succeeded**.
  So the from-source build is expected to work; only publishing is broken
  upstream, which the spike does not need.
- **Windows caveat (LOAD-BEARING):** the `rapier-compat` npm scripts invoke
  `./build-rust.sh` directly. `npm run …` on Windows uses cmd.exe, which
  cannot execute a `.sh` — the scripts MUST be run through Git Bash
  (`bash ./build-rust.sh -f deterministic -d 3`), or with npm's script-shell
  set to bash. Running the npm script verbatim fails with
  `'.' is not recognized as an internal or external command`.

Command sequence (Git Bash, from `typescript/`):

```bash
rustup target add wasm32-unknown-unknown            # one-time
npm ci                                               # typescript/ workspace tools
sed -i 's/^version = "0.19.3"$/version = "0.19.3-c13133ad.0"/' \
    builds/prepare_builds/templates/Cargo.toml.tera  # identity patch
./builds/prepare_builds/prepare_all_projects.sh      # generate flavor crates
cd rapier-compat && npm ci                            # compat build tools
bash ./build-rust.sh -f deterministic -d 3           # wasm (core 0.34, enhanced-determinism)
bash ./build-rust.sh -f non-deterministic -d 3       # wasm (core 0.34, ordinary)
# then gen_src + rollup to produce the consumable compat packages, npm pack
```

Build progress / deviations:

- Both flavors built cleanly. Rust core 0.34.0 compiled in ~1m24s (deterministic)
  and ~1m23s (ordinary), then wasm-pack ran wasm-bindgen + wasm-opt (`-O4`).
  Upstream's own math stack is visible in the compile: `glamx v0.3.0` +
  `parry3d v0.29.0` + `nalgebra v0.35.0` (the 0.32 nalgebra→glam migration).
- **Windows deviations (all packaging, none touching engine source):**
  (1) ran every `.sh` through Git Bash, not `npm run` (the cmd.exe mismatch,
  §2); (2) `gen_src.sh` and `rollup.config.js` both iterate all six flavors and
  fail on the 2D crates that were not built — ran the 3D packaging loop-body
  directly and trimmed `rollup.config.js` to the two 3D `config(...)` entries
  (a copy, `rollup.config.js.orig`, is kept). Neither touches the wasm or the
  bindings, only which flavors are assembled.
- Consumability smoke (`scripts/probe-rapier-package-smoke.js` against the
  installed tarballs) is GREEN on both flavors (§3).

## 3. Tarball + binary hashes and consumability

| Artifact | SHA-256 |
| --- | --- |
| `dimforge-rapier3d-compat-0.19.3-c13133ad.0.tgz` (2,771,434 B) | `0ea91b57b02210a5df28f5f13cd2607a0fd1fc9cc614056493d0e75f63d2df64` |
| `dimforge-rapier3d-deterministic-compat-0.19.3-c13133ad.0.tgz` (2,815,253 B) | `41c109ba8ed2e6b35e835e8ff1b9fb3f103e10802f67b91170181e6202309d7c` |
| ordinary `rapier_wasm3d_bg.wasm` | `f27e14eee2ebbe4b501e28d00256b394b3c40bc6dd617fbebfe00ff5ced82095` |
| deterministic `rapier_wasm3d_bg.wasm` | `5c0a3f6273dd8ffbba1a221d96224da7e10d9938e983c2d5f08cc5e385ae3473` |
| patched `templates/Cargo.toml.tera` (the identity patch) | `1d51a7df68c4712da9869fb0910bda3efcfb5c1989cfaeff7bea1f9bf8dd394e` |

Consumability smoke (matrix step 0), both flavors installed from the tarballs:

- import + `init()` OK; world constructed + 10 steps OK; final state finite; ball
  fell under gravity; deterministic flavor same-config repeat **bit-identical**.
- `version()` = **`0.19.3-c13133ad.0`** on both — the identity patch works, so
  every `rapierVersion` staleness tooth will go red as designed (never silently
  green over a different engine).
- `world.timestep` readback = **`0.01666666753590107` = `Math.fround(1/60)`** on
  both — **the dt-readback gate is UNCHANGED**, so the runner's dt tooth
  (`evaluation.js:432-434`) will not cascade-red the whole physics suite. This
  is the single most important pre-suite result (per the taxonomy triage order).
- **OBSERVATION worth flagging:** the trivial ball-on-slab drop lands at
  `y = 2.715278148651123` on core 0.34 — **byte-identical** to the same drop on
  stable core 0.30.1 (measured this session). A simple single-body contact
  integrates identically across the two cores; the PR #17 divergence is specific
  to the multi-joint islands, not a wholesale integrator change. (One data
  point, not a determinism claim — the golden fixtures in §4 are the real test.)

## 4. Rerun matrix results

Run on the isolated worktree `spike/rapier-034-c13133ad` (off BoxCar3D
`148f2bdc`, which carries the PR-A instruments), consuming the candidate
tarballs. One command at a time; no lock ever re-locked.

| # | Command | Result | Notes |
| --- | --- | --- | --- |
| 0 | package smoke | **PASS** | both flavors; `version()` = `0.19.3-c13133ad.0`; dt readback = `Math.fround(1/60)`; det repeat bit-identical (§3) |
| 2 | `npm run probe:timing` | **DRIFT (exit 1), adoption-critical sub-checks GREEN** | The **dt-readback gate is GREEN** (default + set-1/60 both read back `0.01666666753590107`, idempotent) and `RigidBody.isValid()/isSleeping()`, `ImpulseJoint.isValid()` all present, cross-flavor identical. The single DRIFT is "re-enable resumes per-step updates" — a **profiler re-enable semantic**, which the taxonomy classes (b) engine-finding (not adoption-critical). 36 checks, 1 drift. The dt tooth passing means the physics suite will NOT cascade-red on timestep. |

| 3 | `npm test` | **599 pass / 11 fail — ALL class (c)** | Every failure is a golden digest or version literal (the expected-red inventory). **All 13 class-(a) contract gates PASS** (chassis-drop containment, s0/s1-kernel API-drift + transactional rollback, physics-smoke repeatability, [V1] heightfield-layout, assembly/feature-physics, s0-motor discriminator, s1-prismatic, cohort-invariance/determinism, evaluation-core, surface-speed). Determinism **gate (a) PASSES on A–D** ("two fresh worlds agree on digest, every checkpoint" — the candidate is internally byte-identical run-to-run); only gate (d) "matches committed lock" moved. Candidate fitnessVectorDigest `bded0d30`→`ee605286` (deterministic, self-consistent). **NO borrow/ownership/panic error anywhere** — the PR #18 `world.free()` error did NOT reproduce in the full suite. |

Class map of the 11 reds (all class (c), zero class 1/3/4):
- `evaluation-determinism.test.js` ×5: staleness `rapierVersion` (`0.19.3`→`0.19.3-c13133ad.0`) + eval-A/B/C/D golden digests.
- `evaluation-golden.test.js` ×1: fixture-A cold-module digest.
- `population-determinism.test.js` ×3: staleness `rapierVersion`/dt, fitness-vector digest, champion-trace digest.
- `bench-schema.test.js` ×1: `meta.rapier` package.json version pin.
- `physics-explosion-probe-schema.test.js` ×1: the probe's `engine.rapierVersion` pin (`0.19.3`).

**Signature: Class-2 (expected numerical trajectory change) with NO Class-1/3/4
regression.** The candidate is internally deterministic and preserves every
project contract; only the 0.19.3-calibrated golden values moved.

| 7 | `probe:physics-explosion --pass reproducer` (incl. multibody arm) | **reproducer STILL catastrophic; closure holds; multibody quiescent** | See §5.1/§5.2 — the decisive divergence result. |
| 8 | witnesses (via prevalence classification) | **all 4 still catastrophic** | A cat@51, B cat@45, C cat@62, S cat@227 (§5.3). |
| 9 | `--pass prevalence` (the committed 60) | **5/60 — same 5 individuals** | Identical to frozen; both fitness-hidden cases persist (§5.3). |
| 10 | fresh-seed prevalence (20260730, 20) | **2/20 — confound removed** | New population also diverges (§5.3). |

Steps SKIPPED and why (all defensible under Outcome B — see §10):
- **1 `npm run lint`** — engine-independent; not informative for an engine spike
  (the candidate branch changes only `node_modules` + the lockfile).
- **4 `npm run test:determinism` (standalone)** — its four files already ran
  inside step 3 (`npm test`); determinism gate (a) PASSED on A–D (candidate
  internally byte-identical), gate (d) moved as expected. No new information.
- **5 `npm run test:browser`** — Node-vs-Chromium agreement on the NEW digests
  is an **Outcome-A adoption precondition only**; under Outcome B (stay on
  stable) it commits no claim. Skipped per the plan's "local-only determinism is
  sufficient for gates B/C/D". A heavy Chromium run avoided.
- **6 `npm run build` + dev-scene smoke** — the package smoke (step 0) already
  proved the candidate loads/steps in Node; a Vite bundle check is an
  adoption-path concern, deferred with the rest of Outcome-A.
- **11 `npm run bench:physics`** — the full bench is an **Outcome-A** input
  ("only if Outcome A is live"); a paired stable-vs-candidate cost comparison is
  not decision-relevant when the recommendation is to stay on stable. Deferred.

> **Update (Part C) — the skip framing above is superseded for the reproducible
> arm.** Deferring these as "Outcome-A-only" *after* observing Outcome B is
> exactly the auditability gap the review flagged, so the committed
> `workflow_dispatch` experiment (§2) RUNS every one of them on BOTH the stable
> and candidate arms of a controlled same-commit pair — candidate Chromium
> (step 5, Node↔Chromium digest agreement), the Vite build + app-scene smoke
> (step 6, a **GATE**), and paired `bench:physics --smoke` (step 11). They are
> no longer skipped-then-reclassified; their measured results fold into
> §4/§5/§8 once a `heavy=true` dispatch lands (C5). The local run's skips remain
> recorded above as the honest historical state.

## 5. Headline comparison (0.19.3 frozen vs core-0.34 measured)

### 5.1 Minimum reproducer — the divergence PERSISTS on core 0.34

| arm | core 0.30.1 (0.19.3) | core 0.34 (candidate) |
| --- | --- | --- |
| `original` det + ord | **catastrophic** — peak 5,452 m/s, alert@22 causal@4 cat@46 | **catastrophic** — peak 4,785 m/s, alert@22 causal@6 **cat@107** |
| `removeAxle:0` | quiescent (peak 1.44) | quiescent (peak 1.43) |
| `removeAxle:1` | quiescent (peak 1.43) | quiescent (peak 1.43) |
| `narrowTrack` | quiescent (peak 1.44) | quiescent (peak 1.44) |
| `heavyChassis` | quiescent (peak 1.55) | quiescent (peak 1.37) |
| `gravity9.81` | catastrophic (peak 3,097) | catastrophic (peak 2,667, cat@45) |
| `gravityOff` (floor kept) | quiescent (0) | quiescent (0) |
| `freeSpace` (no statics) | quiescent (0) | quiescent (0) |

**The core-0.34 solver does NOT fix the divergence.** The committed reproducer
(`9fde1f1c`) still reaches catastrophic internal speeds (~4,785 m/s) on both
flavors. Onset is DELAYED (cat 46→107) and the peak is marginally lower
(5,452→4,785 m/s), but the classification is unchanged: an undriven,
wide-track, light-chassis two-module impulse island diverges. Every documented
stabilizer still stabilizes — the necessary/sufficient closure is intact on the
new core.

### 5.2 The multibody 2×2 — representation-vs-solver discriminator (COMPLETE)

| realization | core 0.30.1 | core 0.34 |
| --- | --- | --- |
| impulse joints (production path) | **catastrophic** 5,452 m/s | **catastrophic** 4,785 m/s |
| multibody joints (undriven reproducer) | **quiescent** 1.42 m/s | **quiescent** 1.40 m/s |

The divergence is **impulse-solver-specific AND representation-dependent, not
version-specific.** Re-expressing the identical undriven island (same bodies,
masses, anchors, axis) as reduced-coordinate multibody joints removes it on
BOTH cores. This is not a relabeling: the swap changes the
**constraint-enforcement regime**. Reduced-coordinate multibody joints
eliminate the constrained DOFs from the coordinate space and enforce the joint
as a HARD constraint; the impulse path keeps maximal coordinates and enforces
the joint as a SOFT constraint the solver satisfies iteratively (and, on these
ill-conditioned islands, fails to converge — the PR #17 mechanism). The lever is
the joint REPRESENTATION / constraint-enforcement regime, not the engine
version — a result the version-only spike could not have produced without the
arm. **Caveat (load-bearing):** this quiescence is measured only for the
UNDRIVEN reproducer. The production S0/S1 phenotype needs a revolute velocity
motor and a prismatic position-motor + limits, and §2 confirms EVERY multibody
motor/limit method (Unit and Spherical) is commented out of the TS bindings on
BOTH 0.19.3 and core 0.34. So multibody demonstrably removes the divergence for
the *undriven failure mechanism*, but it is NOT a usable production path today —
and the undriven result does not by itself establish that a MOTORIZED multibody
realization (with the extra constraint forces a motor and limits inject) would
stay quiescent — without upstream binding work.

### 5.3 Prevalence + witnesses + fresh-seed arm

| corpus | core 0.30.1 (frozen, PR #17) | core 0.34 (candidate) |
| --- | --- | --- |
| seed 20260725 (20) | 3 catastrophic (ids 1, 14, 19) | **3** — ids 1@53, 14@227, 19@51 |
| seed 20260728 (20) | 1 catastrophic (id 4) | **1** — id 4@45 |
| seed 20260729 (20) | 1 catastrophic (id 19) | **1** — id 19@62 |
| **the committed 60** | **5/60** | **5/60 — the SAME 5 individuals** |
| fresh seed 20260730 (20) | not previously run | **2/20** (ids 0@106, 5@48) |
| **combined** | — | **7/80 catastrophic on core 0.34** |

> **Controlled-pair note (B4/Blocker 3).** In THIS (historical local) table the
> stable column is the **frozen PR #17 corpus**, not a fresh rerun, and the
> fresh seed 20260730 was measured on the **candidate only** ("not previously
> run" on stable). That is exactly the controlled-pair gap the review flagged.
> The committed `workflow_dispatch` experiment (§2, Part C) closes it: it runs
> a **fresh same-commit stable rerun** alongside the candidate — including
> 20260730 on **both** arms — from one immutable `github.sha`, and the
> generated `comparison.md` reports both columns side by side. Regenerable via
> `npm run probe:physics-explosion -- --pass prevalence --prevalence-seeds 20260730`.
> The frozen columns here are replaced by the CI pair's measured stable rerun
> once a `heavy=true` dispatch lands (C5).

- The **witnesses are confirmed by the prevalence classification itself**:
  A (20260725:19) cat@51, B (20260728:4) cat@45, C (20260729:19) cat@62,
  S (20260725:14) cat@227 — all four still catastrophic on core 0.34.
- **Onset-window margin (flag):** the classification window is
  `WITNESS_SPEC.maxSteps = 300`. The reproducer (`cat@107`) and witnesses A/B/C
  (cat@45–62) have wide margin, but witness S's catastrophic onset is `@227` —
  only ~73 steps inside the window. A future onset DELAY like the reproducer's
  own 46→107 shift on this very core could push a marginal case past step 300
  and silently reclassify it *quiescent*, blinding the tripwire. Recommend
  widening `WITNESS_SPEC.maxSteps` (or asserting a per-witness onset-margin
  floor) on the next engine bump so the classification cannot go dark by onset
  drift alone.
- The **two fitness-hidden cases persist**: 20260725 id 1 (peak 89,035 m/s) and
  id 14 (peak 6.45e7 m/s) are catastrophic on internal speed while their forward
  distance looks ordinary — exactly the pattern no displacement cutoff catches.
  This is the load-bearing argument that the integrity detector must key on
  body speed, not distance, on ANY engine.
- The **fresh-seed arm removes the selection confound**: 20260730 was never
  evaluated on either core, yet 2/20 of its members diverge. The class is a
  property of the realization under the solver, not an artifact of the
  population it was discovered in. (80 evaluated, 7 catastrophic — the
  rule-of-three does not apply here because the count is nonzero; the point
  estimate is ~9%, consistent with the frozen ~8%.)

## 6. Blocker inventory (Class 1/3/4 findings)

**None found.** No Class-1 (API/semantic regression): the S0/S1 kernel
API-drift teeth, the runner dt tooth, `additionalSolverIterations`, `isValid`/
`isSleeping`/`ImpulseJoint.isValid`, and [V1] heightfield-layout all passed.
No Class-3 (determinism failure): determinism gate (a) is byte-identical on
A–D and the fitness-vector is internally self-consistent across two fresh
evaluations. No Class-4 (unacceptable physics): every containment gate
(chassis-drop, assembly/feature-physics) passed, the motor-is-a-real-torque
discriminator held, and prevalence did not worsen (5/60, same individuals).
The only Class-1-shaped observation is the single **profiler re-enable DRIFT**
in `probe:timing` — a class-(b) engine-finding (profiler semantics), not a
contract. The PR #18 `world.free()` borrow error did **not** reproduce (§9).

**Scope of this claim (honest).** "No Class-1/3/4 regression" is asserted over
the surfaces the historical local build exercised: the full Node unit suite
(all 13 class-(a) gates), `probe:timing`, and the reproducer/prevalence probes.
Candidate **Chromium** (Node↔Chromium determinism agreement on the new digests),
the **Vite build + app-scene smoke**, and the **paired bench** were NOT exercised
locally — §4 "Steps SKIPPED" recorded them as Outcome-A adoption preconditions.
The committed CI experiment (§2/§4, Part C) closes exactly those surfaces on a
controlled same-commit pair; its candidate arm additionally asserts Node↔Chromium
digest agreement. So once a `heavy=true` dispatch lands (C5), this claim is
**substantiated across the required surfaces** rather than scoped to the
Node-only local run — and until then it is honestly the narrower claim.

## 7. Lock-migration inventory (would re-lock ONLY on a future adoption)

Cross-referenced to `docs/engine-assertion-taxonomy-2026-07.md` §4.2. Recorded
for completeness; **nothing is re-locked in this spike or by Outcome B.** On a
hypothetical adoption the deliberate re-locks would be exactly the 11 observed
reds:

- `evaluation-locks.js`: A/B/C/D digests + checkpoint arrays; `rapierVersion`
  (×4); `effectiveDt` unchanged (dt readback identical → these literals stand).
- `population-locks.js`: `fitnessVectorDigest` (`bded0d30`→`ee605286` measured),
  the 20 per-member fitness literals, champion identity/fitness, champion-trace
  digest; `rapierVersion`; `effectiveDt` stands.
- `bench-schema.test.js` `meta.rapier`; `physics-explosion-probe-schema.test.js`
  `engine.rapierVersion` pin.

**Pure locks held byte-identical** through the candidate run (noise, terrain,
boulder-hull, `24cd0dd5`, `39bcd6c4`, snapshot `cae92db7`, initialization
`7acb271d`, champion genotype `51370bfa`) — the §6-migration-rule-1 invariant
(physics-free locks do not move) is satisfied, confirming the engine change
reached only the physics path.

## 8. Performance (paired, same-runner)

Deferred by the gate (§10 Outcome B): the full paired bench is an Outcome-A
adoption input. Qualitatively, both Rust builds compiled in ~1m24s and the
candidate ran the full unit suite in a comparable wall time to stable; no
performance pathology was observed. A proper same-runner paired comparison is
part of any future adoption evaluation, not this diagnostic.

## 9. PR #18 comparison (frozen-first)

PR-A's numbers (§3–§5) were measured and recorded **before** consulting PR #18's
archived observations. **PR #18 is an UNCOMMITTED draft comparator** (not in the
repo history), so this section is CORROBORATION, not primary evidence — the
primary same-commit stable-vs-candidate evidence is the controlled CI pair
(§2/§4, Part C), whose fresh stable rerun stands independently of #18.
Comparison against the draft-#18 record (per the plan):

| Observation | PR #18 (archived) | PR-A (independent) | Verdict |
| --- | --- | --- | --- |
| reproducer classification | catastrophic on candidate | catastrophic (both flavors) | **AGREE** |
| reproducer onset (det) | alert 22, cat 107, peak 4,785 m/s | alert@22, cat@107, peak 4,785 m/s | **AGREE (exact)** |
| stabilizer closure | axle-removal / narrow-track / gravity-off / free-space stable | all quiescent | **AGREE** |
| gravity 9.81 | catastrophic | catastrophic (cat@45) | **AGREE** |
| witness A | catastrophic | catastrophic (cat@51) | **AGREE** |
| smoke prevalence seed 20260725 | ids 1, 14, 19 | ids 1, 14, 19 | **AGREE** |
| full 60-member prevalence | not run | 5/60 (same 5) | PR-A extends |
| `version()` on candidate | `0.19.3` | `0.19.3-c13133ad.0` | differs by the identity patch (expected — PR-A patched the crate version; §1) |
| multibody motor exposure | unavailable | unavailable (verified in src.ts) | **AGREE** |
| `world.free()` borrow error | hit on one deterministic fixture | **NOT reproduced** in the full unit suite, all probes, and the smoke — zero `borrow`/`ownership`/`unreachable`/`panic` matches across hundreds of `world.free()` calls | **REPRODUCIBILITY FINDING** — see below |

**The `world.free()` borrow-error reproducibility finding:** PR-A did not
reproduce it. The full unit suite (which frees a world in every fixture, every
batch of chassis-drop's 1,000 spawns, every determinism gate), the reproducer /
prevalence / fresh-seed probe runs, and the package smoke together exercise
`world.free()` many hundreds of times on the candidate deterministic flavor
without a single borrow/ownership panic. This does not prove it never occurs —
it may be intermittent or specific to a build/environment detail of the #18
artifact (a different local build of the same commit; wasm builds are not
guaranteed byte-reproducible across environments, and PR-A's tarball hashes
are recorded in §3 precisely so the *exact* artifact is identifiable). Recorded
as an open reproducibility question, not a confirmed candidate defect.

Agreement on every physics observation (including the exact reproducer onset)
raises confidence in the divergence verdict. The one disagreement is a
non-physics artifact detail, filed as a reproducibility finding rather than a
blocker.

## 10. Gate decision — **OUTCOME B**

**Core 0.34 retains substantially the same divergence.** The verdict, from the
frozen evidence (§5, §9):

1. The committed minimal reproducer is **still catastrophic on both flavors**
   (~4,785 m/s), onset delayed 46→107 but classification unchanged; every
   stabilizer still stabilizes.
2. Prevalence is **5/60 — the identical five individuals**, both fitness-hidden
   cases intact; a fresh seed adds 2/20, removing the selection confound.
3. The **multibody 2×2** shows the lever is the joint REPRESENTATION /
   constraint-enforcement regime (reduced-coordinate hard constraints vs
   maximal-coordinate soft impulses), not the engine version — but this is
   measured for the UNDRIVEN reproducer only, and the motorized S0/S1 phenotype
   cannot use multibody joints in either binding (§2, §5.2).
4. The candidate is otherwise **excellent**: internally deterministic, every
   project contract preserved, no Class-1/3/4 regression, no borrow error
   reproduced. The 11 test reds are all expected class-(c) golden/version
   movement.

**Consequences (per the plan's Outcome B):**
- **PR #17's scientific conclusions extend to the current core.** Update their
  version scope: the constraint-solver divergence on legal multi-module impulse
  islands is present on Rapier core **0.30.1 AND 0.34** — it is not an
  already-fixed-upstream bug.
- **PR-B (the numerical-integrity policy) proceeds as the primary mitigation**,
  calibrated against the shipping stable engine (0.19.3 / core 0.30.1), exactly
  as planned. No spike outcome changed its contract.
- **The multibody/binding-extension investigation is the named follow-up** (NOT
  this PR): the 2×2 makes reduced-coordinate realization the most promising
  structural DIRECTION (demonstrated only for the undriven mechanism), but it is
  blocked on exposing multibody revolute velocity motors + prismatic
  position-motors/limits through the TS/Wasm bindings — an upstreamable patch
  whose cost must be weighed against staying on impulse + the (small) integrity
  detector, and whose payoff is unproven until a MOTORIZED multibody realization
  is measured. That evaluation is future work.
- **Do NOT adopt the source build.** There is no divergence-fix to adopt
  (Outcome A's premise fails), and adopting an unreleased, self-built,
  version-mislabeled binding to gain only "delayed onset" would take on private
  fork cost for no correctness benefit. Stay on stable npm 0.19.3.

**Backend-comparison trigger status:** not yet met. The impulse divergence
persists, but the multibody representation is a candidate in-engine mitigation
path — demonstrated for the undriven mechanism only, pending binding work — so a
whole-backend comparison is premature. Revisit only if the multibody
binding-extension proves infeasible AND the integrity detector grows beyond a
small contract (the §-plan triggers).

### Named follow-ups
1. **PR-B — numerical-integrity policy** (next; contract frozen in the plan).
2. **Multibody binding-extension feasibility** (after PR-B): can a small,
   upstreamable TS/Wasm patch expose revolute/prismatic multibody motors +
   limits? The undriven 2×2 says the mechanism is fixed by representation; this
   asks whether the *driven* phenotype can follow.
3. Re-run this spike's `--pass reproducer` on the next official npm release that
   carries core ≥0.33 (the reproducer stays the engine-upgrade tripwire).
