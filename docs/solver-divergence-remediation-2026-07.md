# Solver-Divergence Remediation — Decision Record (2026-07)

**Status: PROPOSED.** Records the options and the feasibility evidence for
remediating the Rapier constraint-solver divergence that blocks GA mutation
tuning. Recommends a near-term path; the choice is the maintainer's and is **not
yet ratified**. Nothing here changes production code.

This is a forward-looking decision doc for the phase *after* PR 4, not part of
PR 4 itself. The feasibility evidence in §4 was gathered 2026-07-23 and is the
layer PR #19 named ("the multibody/binding-extension feasibility investigation
is the named follow-up") but never costed.

---

## 1. The blocker

BoxCar3D's legal multi-module vehicles trigger Rapier constraint-solver
divergence on ill-conditioned joint islands — one impulse joint per station on
long, off-centre chassis anchors — with onset on the flat start pad during
settle (diagnosed in `docs/physics-integrity-finite-explosion-report-2026-07-13.md`,
PR #17). PR-B (`docs/numerical-integrity-policy-2026-07.md`) made the
**catastrophic** band (>1000 m/s) a selection failure, but deliberately left the
**alert band** (25–1000 m/s) as an observation.

PR 4 then showed that this open band is not a corner case under **selection**:
~18.7 % of screening and ~22.9 % of confirmation generation-slots, and roughly a
quarter of final champions, are **over the plausibility ceiling** — implausibly
far for locomotion, fully selectable, `integrity.status: 'ok'`. Those are
over-threshold *exposure* rates (an implausibility proxy), not measured divergence
rates; the forensic arm confirmed actual divergence on every over-ceiling champion
it re-evaluated, which is what makes the contamination real even though the
whole-campaign rate is a proxy. Either way the signal the gate ranks on is
contaminated, which is why PR 4 could not responsibly tune the mutation defaults.
**The tuning decision stays blocked until this band is resolved.**

Two ways to resolve it. They are not mutually exclusive; A unblocks now, B fixes
the cause.

---

## 2. Option A — Escalate the alert band (band-aid)

Make an alert-band crossing a selection failure: bump `INTEGRITY_POLICY_VERSION`
/ `FITNESS_POLICY_VERSION`, so divergent morphologies become unselectable
(fitness 0) instead of dominating selection.

**What it costs (measured, PR 4 `--phase escalation-cost`, over all 440
generation-0 individuals):** 18 already unselectable (4.1 %), 29 alert-band
(6.6 %), **11 newly unselectable (2.5 %)** — peaks 142–994 m/s, **none below
50 m/s**, no cluster near the 25 m/s line. In 6 of 22 populations (27 %) the
generation-0 champion changes.

**Scope of that measurement (it bounds the claim):** this is **generation 0 only**
(unmutated), false-**positive** side only, on this one campaign's terrain. On that
sample the false-positive risk is favourable — nothing near the threshold — but it
is **not** established for evolved / breeding-pool populations, other terrains, or
the false-negative side. Option A stays conditional on the breeding-pool and
false-negative measurements listed below; the "no false positives" reading is a
*limited-sample* result, not a general property.

**What it does NOT do:** it removes divergent vehicles from *selection*; it does
not stop them from diverging. The physics defect is unchanged — an ordinary
legal vehicle still explodes; the GA just stops rewarding it. It also discards
2.5 % of legitimate-looking individuals and reshapes a quarter of gen-0 champion
pressure.

**Remaining work before it can land responsibly** (PR 4 left these open):
1. **The false-*negative* side** — divergence that still passes after escalation.
   PR-B's acceptance test requires it; PR 4 measured only false positives.
2. **Contamination in the breeding *pool*, not just at the champion** —
   tournament selection samples the whole pool, so the champion is not the
   mechanism.
3. Both of the above are far easier if the integrity **observations** (peak body
   speed, first alert step) are **persisted in the fitness vector** first (a
   versioned encoding change) — today the vector stores only status, which is
   why PR 4's diagnosis needed a forensic re-run.
4. The policy bump is a deliberate re-lock (Node 3-OS + pinned Chromium).

**Effort:** small–moderate, all in-repo, no dependency change.

---

## 3. Option B — Multibody representation (root cause)

Re-express the vehicle's joints as **reduced-coordinate multibody joints**
instead of maximal-coordinate impulse joints. PR #19's multibody 2×2
(`docs/rapier-034-spike-2026-07.md` §5.2) showed the **undriven** reproducer is
**quiescent** as a multibody realization on both cores (0.30.1: 1.42 m/s; 0.34:
1.40 m/s) while the impulse path is catastrophic on both. The lever is the joint
**representation / constraint-enforcement regime** — hard reduced-coordinate
constraints vs soft impulses the solver fails to converge — not the engine
version. This attacks the cause, not the symptom.

### 4. Feasibility (gathered 2026-07-23; not previously costed)

PR #19 recorded that "every multibody motor/limit method is commented out of the
TS bindings" and named the follow-up as an open question. The upstream evidence
makes it concrete:

- **The Rust core already supports our exact case.** Core 0.34's multibody
  solver applies motors AND limits to 1-DoF revolute/prismatic joints
  (`unit_joint_motor_constraint` per `motor_axes` bit, in
  `src/dynamics/joint/multibody_joint/multibody_joint.rs`) — that is S0
  (revolute) and S1 (prismatic + revolute). Core 0.34 also **added passive
  per-DoF springs** (`MultibodyJoint::set_spring()`, MuJoCo-style implicit
  spring/damper) and armature — the spring is a genuine S1 suspension primitive,
  a principled replacement for the ForceBased-motor-as-spring hack.
- **A binding patch already exists — and is stranded.**
  [dimforge/rapier.js#235](https://github.com/dimforge/rapier.js/pull/235)
  ("adding motors for multibody joints", 2023) copies the working impulse-joint
  motor code onto multibody joints — the right three files, a working test case.
  Open ~3 years, `CONFLICTING`, **zero review**. Its issue
  [rapier.js#146](https://github.com/dimforge/rapier.js/issues/146) (2022) also
  has zero response. `rapier.js` was archived and migrated into the monorepo on
  2026-07-12; **neither #146 nor #235 was carried over**, and the monorepo tracks
  no TS motor-binding work. So the fix is deferred/abandoned upstream, not
  planned — reviving #235 is also low-risk goodwill.
- **The gap is purely the JS binding**, commented out at both layers
  (`typescript/src.ts/dynamics/multibody_joint.ts` and the wasm wrapper
  `typescript/src/dynamics/multibody_joint.rs`), including under an "Unsupported
  by this alpha release" block. `set_spring`/armature are unbound too (the
  binding lags the core).
- **Not applicable to us but worth knowing:** spherical/ball multibody joints
  DO have core gaps — limits not enforced
  ([rapier#379](https://github.com/dimforge/rapier/issues/379)), angular momentum
  wrong ([rapier#656](https://github.com/dimforge/rapier/issues/656)). BoxCar3D
  uses no spherical joints, so this does not block it, but multibody support is
  not uniformly complete.

**Cost/shape:** revive PR #235 onto the monorepo → **source-build** the compat
packages at core 0.34 (PR #19's spike already demonstrated how; the stable
`0.19.3` npm package's core ~0.30.1 is too old and JS-unreleased) → re-realize
S0/S1 on `MultibodyJointSet` (motors, and possibly the new passive spring for
suspension) → measure whether the **driven** multibody island stays quiescent.

**The open risk that gates B:** PR #19's quiescence result is for the
**undriven** reproducer only. A **motorized** multibody realization's stability
is **unverified** — motor torque could re-excite the island. That single
experiment (drive the multibody 2×2, or a minimal S0 build, and measure peak
body speed) is the decision-quality gate for B, and it can be run against a
source build without committing to re-realizing the whole vehicle.

**Effort:** moderate–large, and it takes on a **source-build dependency** —
BoxCar3D would no longer consume the stable npm package. That is a standing
maintenance and supply-chain cost, not a one-off.

---

## 5. Recommendation

**Do A now; scope B as a parallel, evidence-gated track — do not block the GA on
it.**

- A is cheap, unblocks mutation tuning (the critical path to a working GA), and
  its false-positive cost was favourable **on the generation-0 sample measured**
  (§2) — a limited result, not a general guarantee, so A ships only after the
  breeding-pool and false-negative measurements below.
- B is the honest fix and is more tractable than PR #19 implied, but it is
  unproven for the driven case and adds a source-build dependency. Betting the GA
  timeline on speculative upstream/representation work would repeat the
  "start clean" failure mode the project warns against.
- The intellectually honest framing must survive: **A does not fix the physics;
  it makes the physics defect non-selectable.** Say so wherever the escalation
  lands, so a future reader does not mistake a masked defect for a solved one.

**Concrete sequence:**
1. Persist integrity observations in the fitness vector (enables A's pool +
   false-negative measurements, and makes contamination readable from history).
2. Land A (alert-band escalation) with the false-negative acceptance test —
   the version bump + re-lock.
3. Re-run PR 4's protocol on the now-clean signal → take the mutation-default
   decision (extend the grid past 0.20; add `p0.100-m0.200`).
4. **In parallel, one experiment for B:** source-build core 0.34 with PR #235
   revived, drive the multibody 2×2 / a minimal S0 build, measure peak body
   speed. If it stays quiescent under drive, B graduates from "named follow-up"
   to a real representation-migration proposal with its own decision record.

---

## 6. Decided / open / owner

- **Decided here:** nothing binding — this is a proposal. A and B are documented
  with their evidence and costs.
- **Open, and the maintainer's call:** whether to ratify A-now / B-parallel, and
  whether the source-build dependency B requires is acceptable at all.
- **Owner:** JP. This record exists so the fork is decided on evidence rather
  than re-derived; the feasibility layer is also captured in the
  `rapier-multibody-motor-binding` memory.

## 7. References

- `docs/physics-integrity-finite-explosion-report-2026-07-13.md` — the divergence
  diagnosis (PR #17).
- `docs/numerical-integrity-policy-2026-07.md` — policy v2; catastrophic
  unselectable, alert band left open (PR-B).
- `docs/rapier-034-spike-2026-07.md` §5.2, §6 — the multibody 2×2 and the named
  binding follow-up (PR #19).
- `docs/ga-phase-1b-pr4-evolution-experiment-2026-07.md` §1, §1.5, §10 — the
  contamination finding and the measured escalation cost (PR 4).
- Upstream: [rapier.js#146](https://github.com/dimforge/rapier.js/issues/146),
  [rapier.js#235](https://github.com/dimforge/rapier.js/pull/235),
  [rapier#379](https://github.com/dimforge/rapier/issues/379),
  [rapier#656](https://github.com/dimforge/rapier/issues/656); core 0.34
  `multibody_joint.rs` motor/limit/spring support.
