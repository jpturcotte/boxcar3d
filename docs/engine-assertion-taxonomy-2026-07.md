# Engine-Assertion Taxonomy — Triage Map for a Physics-Engine Change (2026-07-14)

> **Written against Rapier 0.19.3 (core ~0.30.1), BEFORE any candidate-engine
> result was examined.** This document classifies every committed assertion in
> the suite as it stood on 2026-07-14 so that the FIRST red test of the
> imminent Rapier core-0.34 verification spike — and every future engine bump —
> can be triaged instantly. No candidate digest, band, or behavior informed any
> classification below; the taxonomy is deliberately blind to what the new
> engine does, so it cannot be tuned to excuse a regression after the fact.

## 1. Purpose

Without a committed classification, a red test during an engine swap is
ambiguous: "the engine fixed a quirk we locked as a negative" is
indistinguishable from "the engine broke a contract we depend on". This
document assigns every committed assertion group to one of three classes so the
ambiguity is resolved by lookup, not by re-derivation under pressure.

- **(a) Project contract** — must hold on ANY engine. A red here is an
  adoption blocker or harness contamination, never an expected consequence of
  changing engines. Includes the pure-JS locks, which are engine-FREE: any
  movement means the change touched something it must not have.
- **(b) Engine-finding lock** — a measured 0.19.3 behavior deliberately locked
  as a positive or negative. A BETTER engine may legitimately flip it. Each
  flip is a recorded finding requiring reclassification, never a silent
  re-green.
- **(c) Golden digest / version literal** — expected red on ANY engine change.
  A committed byte-fingerprint or version string; re-lock deliberately once the
  behavioral gates are green.

Some assertions are borderline — a physical CLAIM asserted through a band
calibrated on 0.19.3. Those are classified `(a)/band (b)`: the claim is a
contract, the numeric window encodes 0.19.3 solver behavior. Each names what a
legitimate flip of the band would look like.

## 2. How to use this during an engine change (triage order)

1. **Run `npm run probe:timing` FIRST.** Its hard checks gate everything
   downstream. The single most load-bearing sub-check is the **dt readback**
   (`scripts/probe-rapier-timing.js:181–190`): `world.timestep = 1/60` must read
   back `Math.fround(1/60) = 0.01666666753590107`. Every golden digest, every
   `effectiveDt` literal, and every step-count derivation is bound to that
   value. If the timestep storage changes (e.g. f64 instead of f32), expect a
   *coherent* sweep of golden reds — that is the engine moving the substrate,
   not N independent regressions.
2. **Confirm the pure locks are byte-identical** (§4). Any pure-lock red halts
   the migration: it means the change reached engine-free code and the whole
   comparison is contaminated.
3. **Classify remaining reds against §5–§10.** For each red, look up its
   assertion group. (a) → investigate as a regression or harness break.
   (b) → record the finding, reclassify, re-lock deliberately. (c) → expected;
   re-lock after the behavioral gates pass unmodified (§3).

## 3. Migration protocol (binding rules)

1. **Physics-free locks are byte-identical or the migration halts.** The pure
   fingerprints and pure digests (§4) do not depend on the engine. A single
   changed byte there is a stop-the-line event, not a re-lock.
2. **Behavioral/physical gates must PASS UNMODIFIED before any golden re-lock.**
   The class-(a) engine-touching gates (containment, discriminators, isolation,
   fail-loud, transactional rollback) are green with no edits before a single
   digest literal is touched. A digest re-lock on top of a still-red behavioral
   gate is forbidden.
3. **Gate edits never share a PR with a re-lock.** A change to what a
   behavioral gate asserts and a change to a golden literal are separate,
   separately-reviewed diffs. This keeps "we loosened the gate" from hiding
   inside "we re-locked the digest".
4. **Band widenings are separate reviewed diffs with measured justification;
   tightenings are free.** Widening a class-(b) band (or a borderline band)
   requires a committed measurement showing the new engine's value and the
   margin rationale. Tightening never needs justification.
5. **Recorded-not-gated findings get an old-vs-new observation table in the
   adoption PR.** The findings the suite deliberately does NOT assert —
   solver-pump creep, in-chain sag γ, prismatic stop compliance, sleep/settle
   behavior — must be re-measured old-vs-new and tabled in any adoption PR, even
   though none of them can turn a test red.

---

## 4. Quick reference

### 4.1 Must-stay-green (pure) — byte-identical through ANY engine swap

These files (and the digests they bind) execute no Rapier stepping in the
asserted path. A red here is class-(a) and halts the migration.
(`tests/heightfield-layout.test.js` is deliberately NOT in this table even
though its claim is class (a): it builds a real heightfield and casts a real
ray, so its red means "the engine changed its layout contract" — an adoption
blocker per §5.1 — not harness contamination.)

| File | What must not move | Locked fingerprints |
| --- | --- | --- |
| `tests/prng.test.js` | Rng stream (ruling D7) | seed 1234567 stream; fnv `270d814f` (via fnv1a F4) |
| `tests/noise.test.js` | hash-based value/fbm noise | field `52f40f90` |
| `tests/terrain.test.js` | pure composite generator + config validation | base `e2157c82`, heights `48177e22`, craters `b9e05cf7`, zones `903a3d5f`, features `f3f86cbc` |
| `tests/features.test.js` | descriptor→geometry (quats, hulls, samples) | boulder hull `06f5fca4` |
| `tests/assembly.test.js` | genotype schema + compiler + repair | corpus `24cd0dd5`, chassis-geom `39bcd6c4` |
| `tests/fnv1a.test.js` | house lock hash | FNV vectors; cross-checks `270d814f`/`52f40f90` |
| `tests/trace.test.js` | 128-byte codec (encode/decode/compare) | golden LE bytes; enum codes |
| `tests/trace-writer.test.js` | TraceWriter fold + checkpoints | — |
| `tests/trace-forensics.test.js` | offline onset/peak analysis (pure) | — |
| `tests/population.test.js` | snapshot encoding + validation | — |
| `tests/population-initializer.test.js` | draw table + manifest encoding | snapshot `cae92db7`, init `7acb271d` (also in locks) |
| `tests/surface-speed-law.test.js` | `driveMotorForWheel` pure law | legacy gain bits at r=0.5 |
| `tests/explosion-witnesses.test.js` | witness/reproducer genotype identities | `ec8d42cf`/`393f7e0e`/`57faad4e`/`565f8c72`, reproducer `9fde1f1c` |
| `tests/evaluation-progress.test.js` (lines 136–186) | pure progress fold | — |
| `tests/population-evaluation.test.js` (lines 102–362) | fitness policy, champion order, spawn pose, spec/vector encoders | — |
| `src/sim/population-locks.js` (snapshot/init/spec digests + heterogeneity) | initializer/draw-table/spec content | `cae92db7`, `7acb271d`, `1bc14aba`, champion genotype `51370bfa` |
| `src/sim/population-fixtures.js` / `src/sim/evaluation-fixtures.js` | fixture inputs (genes/terrain/spawn) | — |

### 4.2 Class (c) expected-red inventory — re-lock deliberately after (a)/(b) pass

| Location | Literal(s) |
| --- | --- |
| `src/sim/evaluation-locks.js` | A `5a219735`, B `02a80181`, C `6b83729e`, D `e2fc7625` — each with its full per-step `checkpointStates` array |
| `src/sim/evaluation-locks.js` | `effectiveDt: 0.01666666753590107` (×4), `rapierVersion: '0.19.3'` (×4) |
| `src/sim/population-locks.js` | `fitnessVectorDigest: 'bded0d30'`, 20 per-member f64 fitness literals, champion `fitness 12.484905242919922`, `championTrace.digest 'f5c5f0c7'` + its `checkpointStates`, `effectiveDt`, `rapierVersion` |
| `tests/evaluation-golden.test.js:28` | fresh-module reproduction of A's digest + checkpoints |
| `tests/browser/evaluation-determinism.test.js:39` | Chromium reproduces A–D digests + every checkpoint |
| `tests/browser/population-determinism.test.js:37,53` | Chromium reproduces population fitness vector + champion trace |
| `tests/evaluation-determinism.test.js:91,114` | staleness teeth `rapierVersion` + digest/checkpoint match |
| `tests/population-determinism.test.js:48,146,196` | `rapierVersion`, fitness-vector digest, champion-trace digest |
| `tests/bench-schema.test.js:29` | `report.meta.rapier === { compat: '0.19.3', deterministicCompat: '0.19.3' }` (reflects package.json pin) |

Notes: the checkpoint arrays are what make a class-(c) red *diagnosable* — the
gate reports the first divergent STEP, not merely "digest differs". A digest
change whose step-0 (spawn placement) still matches but which diverges at
step 1 is the signature of a physics-semantic engine change (this is exactly
how B/C behaved at the per-wheel surface-speed re-lock).

### 4.3 Class (b) flip-watch — a red MAY be the new engine being better

| Finding | Anchor | A flip means |
| --- | --- | --- |
| k=0 ∧ c=0 position-motor **0/0-freezes** the axis | `s1-prismatic.test.js:290` | engine no longer 0/0-locks a free slider; revisit the realizer's skip-motor rule and the `s1-sag.test.js:278` free-slider gate |
| colliderless additional-mass body reads **mass()/inertia() = 0 until first step** | `s1-prismatic.test.js:140` | creation-time readback now materializes without a collider; the collider-carrying-hub necessity argument is void |
| in-chain static sag inflates by **γ ≈ 0.33·c·dt/m_unsprung** | `s1-sag.test.js` header + damping tooth `:179` | solver convergence changed; re-measure γ and the load-bearing role of `ADDITIONAL_SOLVER_ITERATIONS` |
| **hard CCD is inert** vs the heightfield; **soft CCD** is load-bearing | `chassis-drop.test.js` (strip negatives), `assembly-physics.test.js:245,275` | fast bodies now caught without soft CCD; the SOFT_CCD_PREDICTION policy may be reducible |
| every traced float is **f32-representable** (`Math.fround(v)===v`) | `evaluation-determinism.test.js:164` | engine exposes f64 state; **pre-ruled: keep f64 encoding, record the fields**, do not narrow |
| **solver-pump drift** ~0.33 m/s on an awake undriven jointed vehicle (never sleeps) | `s0-motor.test.js:168–203`, `s1-drive.test.js:539` | drift magnitude/sign shifts or the island sleeps; re-measure the settle protocol and GA "undriven holds still" assumption |
| profiler **timing-member set** (16 methods) + profiler semantics | `probe-rapier-timing.js:94,97,100,110,111,152,157,169` | engine added/renamed/re-shaped timers; re-derive bench profiler policy and phase0-refresh §2.4 |
| **wasm panics on a removed-body pose read** ("unreachable") | `readBodyState` guard; exercised `evaluation.test.js:144` | the isValid()-guard idiom may relax; recorded, not gated |
| **setLinvel(NaN) is accepted** and persists | `evaluation.test.js:144` (non-finite classification) | engine may reject NaN velocities; the non-finite latch stays as defense |
| motor **solver-convergence ratio bands** (FB inertia ratio, torque prop, α-half, target invariance) | `s0-motor.test.js:244–330` | band placement moves; the CLAIM (real torque) is (a), the window is (b) — see §6.1 |
| prismatic **stop compliance ≈ 9e-6 m/N** leakage | `s1-prismatic.test.js:244` | stop stiffness changed; widen/tighten the leakage band per §3.4 |
| **dt readback = Math.fround(1/60)** | `probe-rapier-timing.js:181–190` | timestep storage precision changed; the GATE — see §2 step 1 |

---

## 5. Terrain, layout, and feature colliders

### 5.1 `tests/heightfield-layout.test.js` — [V1] the layout every terrain path relies on

The engine is exercised (heightfield build + one `castRay`), but the assertions
are a **project contract**: every seating, drop, and ray path in the codebase
assumes column-major `k = col*(rows+1)+row`, col→+X, row→+Z, origin-centered,
`y = height*scale.y`.

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| buffer length `(nrows+1)*(ncols+1)` | (a) | heights array shape | `:72` |
| plateau A/B world positions | (a) | col→+X, row→+Z mapping | `:77,:83` |
| flat control + anti-transpose controls | (a) | rules out a row↔col axis swap | `:89,:95` |
| plateau A is the unique global max | (a) | value placement | `:104` |

Flip semantics: a red here is NOT an engine-quirk flip. If a new engine changes
heightfield indexing, that is an adoption blocker requiring the terrain adapter
to be re-derived; the layout is a documented Rapier contract, not a tuning band.

### 5.2 `tests/physics-smoke.test.js` — the stack proves itself, both flavors

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| cube falls, settles, run-to-run identical (both flavors) | (a) | determinism-of-repeat + basic fall-through | `:29` |

### 5.3 `tests/terrain-physics.test.js` — provisional catch gate (superseded by chassis-drop)

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| 20 spheres land on the surface band, none tunnel | (a)/band (b) | containment claim; the surface band is measured | `:22` |
| walls physically contain laterally-driven spheres | (a) | corridor walls block escape | `:81` |
| crater castRay: full depth center, ~0 outside, intermediate rim | (a)/band (b) | crater bake is physically real; depth values are 0.19.3-measured | `:145` |
| dropped sphere settles on crater floor, not base surface | (a)/band (b) | crater is a real depression | `:175` |

Band flip: a new engine that settles bodies a few cm differently could nudge
the catch bands. The containment CLAIM (nothing tunnels/escapes) is the
contract; the exact settle depths are the (b) band.

### 5.4 `tests/feature-physics.test.js` — collision groups + seating, both flavors

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| `packGroups` packs `membership<<16 \| filter`, unsigned | (a) pure | bit layout | `:62` |
| `GROUND_GROUPS` is the packed ground policy | (a) pure | policy constant | `:70` |
| floor/walls/features carry `GROUND_GROUPS` | (a) | wiring readback | `:79` |
| seating: never buried past `embedDepth`; governing support embedded exactly | (a)/band (b) | seating rule; castRay bounds are measured | `:94` |
| presence: every feature stands proud within its height budget | (a)/band (b) | seated pose | `:141` |
| dropped sphere blocked by an isolated boulder, then settles | (a) | collider is solid | `:166` |
| solver positive: `CHASSIS_GROUPS` body caught by grouped ground | (a) | group matrix | `:204` |
| solver negative (ghost proof): filter without GROUND falls through everything | (a) | ghost-vehicle matrix | `:218` |
| ghost-ghost: two `CHASSIS_GROUPS` bodies coexist, no mutual ejection | (a) | no inter-vehicle collision (scope rule 5) | `:232` |
| castRay `filterGroups` (real arg) respects the matrix | (a) | query path | `:254` |
| legacy ungrouped body still collides with grouped ground | (a) | default 0xFFFFFFFF | `:275` |
| realized poses run-to-run identical within a flavor | (a) | determinism-of-repeat | `:289` |
| adapter knobs fail loud (NaN/non-finite/out-of-range) | (a) | fail-loud matrix | `:309` |
| degenerate hull throws instead of vanishing (F16) | (a) | fail-loud | `:341` |

### 5.5 `tests/chassis-drop.test.js` — the canonical 1,000-spawn containment gate

The Phase-0 fall-through criterion. Both flavors × 20 batches × 50 chassis.

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| every body finite, contained, above the −50 net, in the clearance band, at rest | (a)/band (b) | **containment contract**; floor-ray `≥ floorY+0.10` and topmost-ray `≤ surfaceY+1.2` bounds are 0.19.3-measured (observed max 0.935) | `:1–60` header + gate |
| strip soft CCD → a 45 m/s probe tunnels (implicit) | (b) | proves soft CCD is load-bearing (hard CCD inert) | see §4.3 |

Band flip: the topmost band was deliberately tightened from 2.6 to 1.2 against
the measured 0.935. A new engine that legitimately rests a body higher (better
contact resolution) could require a *measured, reviewed* widening (§3.4). The
containment claim (finite, no tunnel, no escape) never relaxes.

### 5.6 `tests/assembly-physics.test.js` — compiled chassis on composite terrain

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| 14-IR corpus settles caught: per-IR floor/topmost rays, containment, settle band | (a)/band (b) | containment; reach bands `≥0.6·minFace` / `≤reach+0.35` measured | `:124` |
| emitted body carries full policy: dual CCD, solver iters, `CHASSIS_GROUPS`, one dynamic body | (a) | realization contract readback | `:215` |
| strip soft CCD loses a 45 m/s probe (hard CCD inert) | (a) neg / (b) finding | negative tooth; the underlying finding is (b) | `:245` |
| strip GROUND filter loses a rest drop | (a) neg | groups are load-bearing | `:275` |
| degenerate hull fails loud, leaves no body (both F16 modes) | (a) | fail-loud + transactional cleanup | `:296` |
| malformed IR/spawn fail loud before the world is touched | (a) | fail-loud | `:319` |

---

## 6. Motor, suspension, and drive (the physical-law seam)

### 6.1 `tests/s0-motor.test.js` — the motor-is-a-real-torque discriminator

The centerpiece class-(a) discriminator: motors are ForceBased and the adapter
converts IR torque to Rapier's velocity-servo gain. The DISCRIMINATOR (a real
torque tracks inertia; AccelerationBased normalizes it away) is a contract; the
numeric bands are 0.19.3 solver observations.

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| `MotorModel.ForceBased`/`AccelerationBased` exist and are distinct | (a) | symbolic enum resolution | `:233` |
| discriminator: FB first-step ω ∝ 1/I; AB compensates inertia away | (a)/band (b) | **the ruling**; FB ratio band [3.5,5.5] (meas 4.86), AB band ±0.05 (meas 1.000) | `:244` |
| torque proportionality: 2T ≈ 2× first-step ω (FB) | (a)/band (b) | linear-in-torque; band [1.7,2.0] (meas 1.905) | `:264` |
| target-speed invariance: fixed driveTorque keeps stall α across targets | (a)/band (b) | the gain conversion; spread band ≤1.15 (meas 1.077) | `:272` |
| torque falls with speed: α@half ≈ ½·α@rest; ω approaches target from below | (a)/band (b) | linear servo law; band [0.40,0.65] (meas 0.523); approach ≥0.90× | `:284` |
| vehicle mass sensitivity: heavier chassis accelerates less | (a)/band (b) | mass-sensitivity; ratio ≥1.5 (meas 2.20) | `:316` |
| vehicle torque proportionality: 2T ≈ 2× dx@15 | (a)/band (b) | band [1.6,2.0] (meas 1.798) | `:324` |
| motor sign: negative target ω drives +X, positive drives −X | (a) | **sign lock** (contact-point kinematics) | `:332` |

Underlying (b) finding wired into the harness: the **solver-pump drift** forces
the braked-settle protocol (`:168–203`). If the drift vanishes or reverses on a
new engine, the settle assertion (`SETTLE_RESIDUAL 0.05`) may change — re-measure.

Band-flip meaning: a legitimate band flip is a new engine whose discrete solver
gives a different implicit-step shortfall (the reason FB ratio reads 4.86 not
5.06). The claim "FB is a real torque, AB is inertia-normalized (rejected)"
must still hold — if AB stopped normalizing inertia, THAT is a contract break,
not a band widening.

### 6.2 `tests/s1-prismatic.test.js` — raw spring model + coordinate contract

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| S1 API surface exists; MotorModel resolves symbolically | (a) | API-drift guard | `:123` |
| **colliderless mass reads 0 until first step**; collider body reads exact at creation | (b) | the finding forcing collider-carrying hubs | `:140` |
| body placement sets initial coordinate; coincident anchors read 0 | (a)/band (b) | coordinate contract; f32 band 1e-5 | `:177` |
| position-motor target is ABSOLUTE, not spawn-relative | (a)/band (b) | coordinate semantics; band 2e-3 | `:185` |
| spring honesty: FB sag tracks m·g/k both sides; AB mass-blind (REJECTED) | (a)/band (b) | **[V12] the spring IS the position motor**; settle bands 2e-3 | `:195` |
| stiffness sensitivity: greater k ⇒ less displacement | (a)/band (b) | k is honest N/m; ratio band [3,5] | `:217` |
| damping changes decay, NOT equilibrium | (a)/band (b) | separation of transient/static | `:228` |
| limits enforce both ends; readbacks agree; **leakage load-scaled, bounded (≈9e-6 m/N)** | (a)/band (b) | limits are real; stop-compliance band is (b) | `:244` |
| preload target beyond limit sits pinned at stop as a STATIC state | (a)/band (b) | preload semantics | `:267` |
| zero travel `setLimits(0,0)` engine-safe (locked suspension) | (a) | legal edge phenotype | `:275` |
| huge load clamps finitely at the stop | (a)/band (b) | limits are constraints | `:282` |
| **k=0 ∧ c=0 FREEZES the axis** (0/0 motor); damper-only works; true free slider reaches stop | (b) | the degeneracy behind the realizer skip-motor rule | `:290` |
| vehicle-local covariance: axis rotates with body; world-vertical FAR off at pitch/roll; roll-180 REVERSES extension | (a)/band (b) | **[V11] SUSPENSION_AXIS is vehicle-local**; the direct-negative discriminator | `:314` |

### 6.3 `tests/s1-sag.test.js` — static sag relational teeth (vehicle level)

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| heavier chassis ⇒ more compression; stiffer ⇒ less; coords inside limits | (a)/band (b) | relational sag; measured windows | `:157` |
| damping leaves static equilibrium materially unchanged; transient overshoot deeper at low c | (a)/band (b) | runs on the heavy-unsprung fixture to keep **γ ≤ ~0.02** | `:179` |
| weak spring under heavy chassis bottoms out FINITELY (legal poor phenotype) | (a) | strange-but-legal, never repaired | `:199` |
| preload rides pinned against the extension stop (static) | (a)/band (b) | preload semantics | `:214` |
| S0 twin shows ZERO prismatic-equivalent displacement while S1 sags | (a) | S0/S1 dispatch is real | `:240` |
| `HUB_GROUPS` touches NOTHING: hub-grouped body falls through where a wheel twin lands | (a) | group isolation | `:253` |
| hand-edited k=0 ∧ c=0 realizes as an honest FREE SLIDER (not the 0/0 lock) | (b)-dependent | the realizer's skip-motor rule; depends on the engine's 0/0 freeze | `:278` |

The **in-chain sag γ ≈ 0.33·c·dt/m_unsprung** inflation (header note) is the
governing (b) finding here: the damping tooth is deliberately placed on the
heavy-wheel fixture so γ stays small enough to assert equilibrium. A new engine
that converges the chain differently changes γ and may free the tooth to run on
the light-wheel fixture too.

### 6.4 `tests/s0-drive.test.js` — the forward-drive witness

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| witness fixture is repair-stable (genes ARE the phenotype) | (a) pure | repair identity | `:194` |
| driven beats undriven toward +X; reversed target drives −X; stays sane | (a)/band (b) | drive causality; +19.4 vs −0.06 m windows | `:203` |
| gain semantics through the shipped path: surface speed = no-load speed, shares = thrust | (a)/band (b) | the drive law end-to-end | `:235` |
| residual-overlap witness (R5 cap): realizes, bounded, no detach/explosion | (a) | strange-but-stable | `:256` |

### 6.5 `tests/s1-drive.test.js` — the three-way rough-strip witness

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| witness repair-stable; mass-matched S1 equals S0 twin in CANONICAL total | (a) pure | repair + mass accounting | `:393` |
| three-way: mass-matched S1 changes ride in the intended direction, still makes progress | (a)/band (b) | **suspension effect claim**; RMS-accel 8.585→1.288 (0.150×) etc. are (b) | `:414` |
| 180°-rolled S1 lands on its back, stays finite, suspension presses world-UP | (a) | vehicle-local axis under gravity | `:456` |
| max legal topology (25 bodies/24 joints) stable under existing solver policy | (a) | topology ceiling stable | `:473` |
| deliberately strange asymmetric phenotype: finite, bounded, contract-valid | (a) | strange allowed, invalid not | `:496` |
| drive-torque reaction: hub does not tilt the wheel plane | (a) | reaction through the prismatic rotational lock | `:519` |
| findings ledger: solver-pump under S1; mixed radii re-measured; R5-cap overlap | (b) recorded | recorded observations, not gates | `:539` |

Band flip: the ride-improvement ratios (0.150× RMS, peak 32.1→5.7) are
0.19.3 solver-and-suspension observations. The CLAIM is directional (S1 reduces
chassis vertical accel and keeps progress); the magnitudes are (b).

### 6.6 `tests/surface-speed-drive.test.js` — per-wheel target law, both flavors

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| mixed-radius witness repair-stable, emits declared phenotype | (a) pure | repair + r 0.3/0.6 | `:244` |
| airborne per-wheel spin: each wheel → its own ω=−speed/r; negation flips every sign | (a)/band (b) | per-wheel law through the realizer; targets differ 2.02×, |ω·r|=5 | `:265` |
| grounded per-wheel law drives cleanly; the EXACT old shared-ω law fights itself on the twin | (a) | law claim; the old-law arm is **bit-exact arithmetic**, not a golden digest | `:302` |
| small-radius/high-speed corner (ω −25, r 0.3): finite, contained, drives | (a) | stability corner | `:357` |

### 6.7 `tests/surface-speed-law.test.js` — the pure drive law (engine-free)

Class (a) **pure** (listed in §4.1). `driveMotorForWheel` derives {ω, gain}
with no Rapier. Identity corner reproduces legacy gain bits (`:34`); ω·r and
gain·|ω| recover inputs (`:50`); sign law (`:64`); policy constant
`MOTOR_TARGET_WHEEL_SURFACE_SPEED === 5` (`:74`); out-of-domain → non-finite
fields (`:81`).

---

## 7. Realization kernels (creation-time contracts)

### 7.1 `tests/s0-kernel.test.js` — S0 realization contract

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| pure pose math (repair-stable fixture, `WHEEL_COLLIDER_ROTATION`, wheel centers, yaw-90 rotation, shared hinge axis, no-mutation) | (a) pure | `s0WheelTransforms` math | `:91–150` |
| full creation-time contract: counts, per-wheel readbacks, chassis policy, joints, anchors | (a)/band (b) | anchors exact to f32-scaled tolerance | `:158` |
| motor-model policy resolves symbolically per flavor | (a) | symbolic enum | `:237` |
| non-identity yaw spawn: whole contract holds at yaw-90 | (a)/band (b) | f32 anchor error scales with |coordinate| | `:251` |
| suspension gate: S1/S2 compile as IR but rejected at realization pre-world | (a) | dispatch gate | `:279` |
| malformed IR/options fail loud BEFORE the world is touched | (a) | fail-loud | `:310` |
| Rapier build without the ruled motor model fails loud pre-world | (a) | API-drift guard | `:367` |
| transactional cleanup: induced mid-construction throws leave counts unchanged | (a) | **transactional rollback** | `:380` |
| motor domain: denormal-tiny targetWheelSurfaceSpeed rejected (non-finite gain) | (a) | derived-quantity validated pre-world | `:429` |
| legal edge shapes: sled, undriven, centerline singles, asymmetric radii, three axles | (a) | legal phenotypes | `:460` |

### 7.2 `tests/s1-kernel.test.js` — S1 dispatch + creation contract

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| declared fixtures repair-stable | (a) pure | repair identity | `:124` |
| `suspensionAnchorLocal`/`s1SpawnCoordinate` coordinate contract (pure) | (a) pure | coordinate math | `:138` |
| `vehicleWheelTransforms`: S0 exact; S1 drops by quiescent coordinate along rotated axis | (a) pure | placement math | `:154` |
| `vehicleWheelTransforms` THROWS on S2/unknown (no silent rigid fallback) | (a) | fail-loud | `:193` |
| `vehicleWorldAxes`: roll-180 REVERSES the suspension axis (pure) | (a) pure | vehicle-local ruling | `:206` |
| `projectedPrismaticCoordinate` recovers a synthetic coordinate (oracle) | (a) pure | projection math | `:220` |
| full all-S1 creation contract: counts, groups, CCD, solver policy, anchors, limits, quiescent spawn, hub readbacks | (a)/band (b) | creation contract; readback bands world-anchor-scaled f32 | `:243` |
| yaw-90 far spawn: anchors coincide, coordinate reads back in scaled f32 bands | (a)/band (b) | f32 tolerance scaling | `:328` |
| roll-180 covariance at creation: hub above anchor; world-vertical ~2×coord away | (a) | vehicle-local at creation | `:360` |
| dispatch counts: all-S0 UNCHANGED; each S1 wheel adds +1 body/+1 collider/+1 joint | (a) | dispatch arithmetic | `:388` |
| dispatch gates: sled, zero-driven, single centerline S1, asymmetric pair, max topology | (a) | legal phenotypes | `:422` |
| S2/unknown rejected pre-world by realizeVehicle; realizeS0Vehicle rejects S1+S2 | (a) | gates | `:471` |
| tamper negatives: edited hub records/hubsTotal/spring params — pre-world, counts unchanged | (a) | tamper guard + rollback | `:496` |
| motor-model names resolve symbolically off injected RAPIER | (a) | symbolic (drive + S1 spring) | `:548` |
| API-drift negatives: build missing any S1 surface fails loud pre-world | (a) | API-drift guard | `:566` |
| transactional cleanup at EVERY construction stage leaves counts unchanged | (a) | **transactional rollback** | `:599` |
| no direct-force/impulse/angvel/post-creation-pose shortcut | (a) | joint-motor-causality-only ruling | `:702` |
| zero-travel and preload IRs realize with ruled semantics | (a) | legal edge phenotypes | `:747` |

---

## 8. Determinism, golden locks, and cohort invariance

### 8.1 `tests/evaluation.test.js` — runner + fixtures + readBodyState

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| declared fixtures repair-stable, mutation-isolated, descriptor coherence, options build/validate | (a) pure | fixture contract | `:38–107` |
| runEvaluation options validation: every malformed option fails loud pre-world | (a) | fail-loud matrix | `:110` |
| `readBodyState` valid/non-finite/invalid classifications (both flavors) | (a) | classification handles the wasm-panic + setLinvel(NaN) findings | `:144` |
| fixtures A/B/C complete finite, expected counts, forward progress | (a)/band (b) | completion + counts (exact); progress bands generous | `:182,:205,:223` |
| ghost multi-vehicle: identical spawns coexist, counts double, order kept | (a) | ghost isolation | `:241` |
| zero-axle sled: legal, chassis-only, jointState notApplicable | (a) | legal phenotype + trace shape | `:256` |
| hooks receive exactly six phase names, in order, no payload | (a) | hook contract (sim-time pure) | `:274` |
| profiler plumbing: samples when on, null when off; magnitudes never asserted | (a) | profiler neutrality of the digest path | `:289` |
| digest trace: shape-static record count across vehicles/captures | (a) | trace shape | `:304` |

### 8.2 `tests/evaluation-progress.test.js` — split (pure fold + engine recompute)

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| progress fold contract (pure): strict-> ties, capture-0 baseline, −0 handling, non-finite skip, chainable | (a) pure | the fold | `:136–186` |
| max-progress recomputed EXACTLY from the full trace (both flavors) | (a) | fold == trace recompute (engine path) | `:189` |
| rollback / reverse-only / sled / two-vehicle witnesses vs trace | (a) | fold correctness against real traces | `:199–289` |

### 8.3 `tests/evaluation-determinism.test.js` — the Node determinism gate

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| gate (a): two fresh worlds agree on digest, every checkpoint, counts, metrics (A–D) | (a) | **determinism-of-repeat** (deterministic flavor) | `:49` |
| gate (c): default flavor same-process repeatability; digest NEVER locked (F10) | (a) | repeat only — no literal | `:77` |
| gate (d): staleness teeth — versions, record size, step counts, engine version | (a) structure / (c) `rapierVersion` | fail-loud on drift | `:91` |
| gate (d): run matches committed lock (digest, counts, every checkpoint) | (c) | golden A–D | `:114` |
| profiler neutrality: profilerEnabled does not change the digest | (a) | semantic non-interference | `:145` |
| capture-mode invariance: full == digest digest/counts | (a) | mode invariance | `:154` |
| **f32-backedness one-shot**: every traced float `Math.fround(v)===v` | (b) | pre-ruled: keep f64 if it flips | `:164` |
| ghost isolation: vehicle 0 bit-equal solo vs sharing with an identical ghost | (a) | worker-sharding precondition | `:186` |

### 8.4 `tests/evaluation-golden.test.js` / `tests/browser/evaluation-determinism.test.js`

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| fresh-module reproduction of A's digest + checkpoints (cold module graph) | (c) | golden A | `evaluation-golden:28` |
| Chromium reproduces A–D digests + every checkpoint | (c) | golden A–D cross-env | `browser/eval-det:39` |

### 8.5 `tests/evaluation-core.test.js` — the shared-loop seam

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| composition identical to runEvaluation reproduces result byte-for-byte | (a) | seam equivalence | `:69` |
| a REAL contact-querying inspect is observationally inert (identical bytes/results) | (a) | non-interference contract | `:84` |
| requestedDt is the caller declaration; effectiveDt is the engine readback; mismatch fails loud | (a)/literal (b) | honest-dt contract; `Math.fround(1/120)` readback is the (b) literal | `:128` |
| direct-caller guards fail loud (requestedDt/maxSteps/traceMode/staticColliders/inspect) | (a) | fail-loud | `:156` |

### 8.6 `tests/cohort-invariance.test.js` / `tests/cohort-determinism.test.js`

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| protocol premise: input orders cover ≥2 distinct positions; members heterogeneous/canonical | (a) pure | protocol setup | `cohort-inv:155,:163` |
| input permutation invisible: identical ID-keyed results + identical fitness-vector BYTES | (a) | **cohort-invariance ruling** | `cohort-inv:173` |
| isolation contract: EVERY member leaf-exact equal to a manual solo runEvaluation | (a) | isolatedWorlds invariance | `cohort-inv:183` |
| every wheeled member makes progress, sled scores ~0 (generous bands) | (a)/band (b) | sanity | `cohort-inv:221` |
| matrix-narrowed cross-OS gate: canonical/reversed/permuted → identical bytes + leaf-equal | (a) | cross-OS determinism-of-repeat (not a golden literal — compares runs) | `cohort-det:95` |

### 8.7 `tests/population-determinism.test.js` / `tests/browser/population-determinism.test.js`

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| lock staleness teeth: versions, engine, dt, internal consistency | (a) structure / (c) `rapierVersion` + `effectiveDt` | fail-loud on drift | `pop-det:48` |
| relational fitness identities (never magnitude floors); champion recomputed from lock | (a) | selection order is a contract | `pop-det:74` |
| pure initializer locks: snapshot + initialization-manifest digests reproduce | (a) pure | `cae92db7`/`7acb271d` | `pop-det:108` |
| champion genotype digest reproduces from fresh population | (a) pure | `51370bfa` | `pop-det:115` |
| structural heterogeneity exact sets at this seed | (a) pure | draw-table content | `pop-det:122` |
| evaluation gate: two fresh evaluations agree byte-for-byte; second matches lock | (a) determinism / (c) digest+fitness literals | `bded0d30` + 20 fitness literals | `pop-det:146` |
| champion solo digest-mode rerun reproduces locked trace AND locked fitness (isolation sentinel) | (c) trace `f5c5f0c7` / (a) isolation | golden champion trace | `pop-det:196` |
| Chromium reproduces fitness vector + champion (browser) | (c) | golden cross-env | `browser/pop-det:37,:53` |

Split note: within `src/sim/population-locks.js`, `populationSnapshotDigest`,
`populationInitializationDigest`, `evaluationSpecDigest`, and
`champion.genotypeDigest` are engine-FREE → class (a) pure (§4.1). The
`fitnessVectorDigest`, per-member fitness literals, `champion.fitness`, the
champion-trace digest/checkpoints, `effectiveDt`, and `rapierVersion` are
engine-dependent → class (c) (§4.2). Which individualId wins the champion slot
follows from engine-dependent fitness, so the SELECTED id (10) can move with a
re-lock even though the genotype digest of whoever wins is a pure fingerprint.

---

## 9. Population/fitness pure layer (engine-free encoders)

### 9.1 `tests/population.test.js` — snapshot encoding + validation (pure)

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| validatePopulation sorts by id, never mutates, rejects dupes/non-canonical/domain-invalid | (a) pure | canonical-heredity contract | `:52–103` |
| snapshot encoding v1: hand-built bytes; order-invisible; variable-length framing | (a) pure | `POPULATION_SNAPSHOT_VERSION 1` | `:104–145` |

### 9.2 `tests/population-initializer.test.js` — draw table + manifest (pure)

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| determinism + fork independence; reproduce locked fingerprints | (a) pure | `cae92db7`/`7acb271d` | `:44–76` |
| draw-table invariants: domain-valid, 1..6 axles, S2 unreachable, driven-by-construction, symmetry prior, family spread | (a) pure | initializer policy | `:82–126` |
| repair ownership: every stored genotype repair-identical (fixed point); wasRepaired coherent; rawGenotype keepRaw-only | (a) pure | canonical heredity | `:134–151` |
| config validation fail-loud matrix; S2 rejection names the mask ruling | (a) pure | fail-loud | `:160–195` |
| manifest encoding v1: hand-built bytes; rejects seed/config/size/version drift | (a) pure | `POPULATION_INITIALIZER_VERSION 1` | `:202–239` |
| `INITIAL_POPULATION_DEFAULTS` frozen, carries Phase-1A policy | (a) pure | defaults contract | `:247` |

### 9.3 `tests/population-evaluation.test.js` — split (pure encoders + engine evaluator)

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| fitness policy: fitness IS maxForwardDistance verbatim f64 | (a) pure | `FITNESS_POLICY_VERSION 1` | `:111` |
| championFromEvaluation total order (greater fitness; valid over invalid; lowest id) | (a) pure | selection order | `:131–169` |
| spawnPoseOnFlatStart reproduces hand-derived spawn-y; sled fallback; version guard | (a) pure | placement math | `:170–210` |
| evaluation-spec encoding v1: hand-decoded offsets; any knob changes bytes; fail-loud | (a) pure | `EVALUATION_SPEC_VERSION 1` | `:228–288` |
| fitness-vector encoding v1: header/walk; exact f64 round-trip; fail-loud matrix | (a) pure | `FITNESS_VECTOR_VERSION 1` | `:315–355` |
| evaluatePopulation validation: S2 fails loud with id/path; non-canonical rejected | (a) | gate | `:384,:390` |
| evaluatePopulation (deterministic): id-keyed results, isolation vs manual solo, permutation-invariance | (a) | isolatedWorlds invariance (engine) | `:401` |
| adversarial hook mutating caller mid-run changes nothing (evaluator owns inputs) | (a) | ownership contract | `:462` |
| zero-axle sled imports as a valid ~0-fitness individual | (a) | legal phenotype | `:491` |

---

## 10. Instruments, schema smokes, and the timing probe

### 10.1 `scripts/probe-rapier-timing.js` — the engine-semantics gate (hard checks)

Run FIRST during any engine change (§2). The hard checks exit 1 on drift.

| Hard check | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| timing member set matches the 16-method 0.19.3 measurement | (b) | profiler surface | `:94` |
| every timing* member is an instance method | (b) | method-ness | `:97` |
| `profilerEnabled` is a get/set accessor | (b) | accessor shape | `:100` |
| `profilerEnabled` defaults to false; sticks after set | (b) | default + set | `:110,:114` |
| unstepped world: every timer reads 0 | (b) | zero baseline | `:111` |
| repeated reads stable (reading does not reset) | (b) | read semantics | `:129` |
| disable FREEZES values; re-enable resumes per-step | (b) | enable/disable semantics | `:152,:157` |
| profiler off after stepping: main timers read 0 | (b) | off semantics | `:169` |
| default timestep already `Math.fround(1/60)` | (a)/(b) | **the dt-readback gate** | `:181` |
| set 1/60 reads back `Math.fround(1/60)`, NOT f64 1/60; stable; set(readback) idempotent | (a)/(b) | **the dt-readback gate** — every effectiveDt literal binds here | `:185,:188,:190` |
| `RigidBody.isValid()`/`isSleeping()`/`ImpulseJoint.isValid()` present | (a) | API the trace contract depends on | `:201–203` |
| cross-flavor timing member sets identical; timestep readback identical | (b) | flavor parity | `:216,:218` |

Flip action for any (b) drift: the probe exits 1 and names the affected
rulings (runner dt tooth, bench profiler policy, phase0-refresh §2.4). Record
the finding, reclassify, re-derive downstream. The dt-readback checks are
marked (a)/(b): the CONTRACT (the runner and every lock bind to the engine's
own readback, whatever it is) is (a); the specific value `0.01666666753590107`
that appears as an `effectiveDt` literal is the (b)/(c)-shaped substrate that a
storage-precision change would move.

### 10.2 `tests/physics-explosion-probe-schema.test.js` — the explosion probe's CI touchpoint

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| smoke config: versioned report shape, all hard checks green | (a) | structure + identity-class hard checks only | `:24` |
| pass selection normalizes identically (API and CLI) | (a) | dispatch normalization | `:185` |
| `['baseline,terrain']` dispatches exactly those passes | (a) | dispatch | `:196` |
| single-pass run reports the real global timestep, never null | (a)/(b) | dt readback echoed | `:212` |
| unknown passes/selectors fail loud | (a) | fail-loud | `:232` |

By design the probe asserts identity-class facts only (genotype digests,
deterministic-repeat over full record streams + checkpoints, f32 dt). No
committed check asserts the explosion occurs — a future engine that converges
the ill-conditioned islands turns the probe's magnitudes quiet without a red,
and the ruling gets re-evaluated (see `docs/physics-integrity-finite-explosion-report-2026-07-13.md` §12, §16).

### 10.3 `tests/explosion-witnesses.test.js` — witness/reproducer identities (pure)

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| witness table well-formed; declared evaluation identity matches Phase-1A spec | (a) pure | identity metadata | `:25,:34` |
| per-witness: reconstruction reproduces committed genotype digest; canonical repair-identical; standalone recipe byte-identical to the initializer member; passive-twin digest + recipe | (a) pure | `ec8d42cf`/`393f7e0e`/`57faad4e`/`565f8c72` + passive twins | `:47–101` |
| unknown witness fails loud | (a) pure | fail-loud | `:119` |
| minimum reproducer: materialized genotype matches digest, canonical; documented phenotype; flat ablation terrain | (a) pure | `9fde1f1c` | `:126–147` |

Deliberately NEVER a must-explode assertion — these are identity locks, engine-free.

### 10.4 `tests/bench-schema.test.js` — the bench's CI touchpoint

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| percentile is nearest-rank ceil(p·N), 1-indexed | (a) pure | pure math | `:11` |
| smoke matrix: valid schema, paired comparisons, finite timings, timing never enters trace bytes | (a) structure / (c) `meta.rapier` | structure + the digest-arm isolation tooth | `:18` |
| `report.meta.rapier === { compat: '0.19.3', deterministicCompat: '0.19.3' }` | (c) | reflects package.json dependency pin | `:29` |

Never an absolute timing threshold (F-note: the reference-machine table lives
in the PR, not CI). The `meta.rapier` literal is the class-(c) package.json pin
that turns this smoke red on an engine bump.

### 10.5 `tests/population-probe-schema.test.js` — the characterization instrument's CI touchpoint

| Group | Class | Asserts | Anchor |
| --- | --- | --- | --- |
| smoke report well-formed, hard invariants hold, renders to markdown | (a) | structure + hard invariants | `:11` |

---

## 11. Lock and fixture modules (data, not tests)

| Module | Class | What it binds |
| --- | --- | --- |
| `src/sim/evaluation-locks.js` | (c) | A `5a219735`, B `02a80181`, C `6b83729e`, D `e2fc7625` + checkpoint arrays; `effectiveDt`, `rapierVersion`, fixtureVersion/traceVersion/recordBytes/counts (structural literals, re-lock on schema change) |
| `src/sim/population-locks.js` | (a) pure + (c) | pure: snapshot `cae92db7`, init `7acb271d`, spec `1bc14aba`, champion genotype `51370bfa`, heterogeneity. (c): fitness-vector `bded0d30`, 20 fitness literals, champion fitness, champion-trace `f5c5f0c7` + checkpoints, `effectiveDt`, `rapierVersion` |
| `src/sim/evaluation-fixtures.js` | (a) pure | A–D genotypes/terrain/spawn/target inputs (COPY-DECLARE; a change is a fixtureVersion bump, not an engine event) |
| `src/sim/population-fixtures.js` | (a) pure | the generation-0 fixture seeds/config/terrain/spawn inputs |

Re-lock discipline (both lock modules): set the stale digest to `null` → the
determinism gate prints the measured record as paste-ready JSON → paste → Node
green (both determinism files) → pinned Chromium must agree BEFORE merge. The
commit message must state the cause: trace-schema change, fixture change,
dependency change, intended physics-semantic change, or diagnosed regression.
For an engine adoption the cause is "dependency change"; per §3, the behavioral
gates are green unmodified before any of these literals are touched.

---

## 12. Borderline register — claims held through 0.19.3-calibrated bands

Collected for review. In each, the CLAIM is class (a) (must hold on any engine)
and the numeric WINDOW is class (b) (a legitimate flip re-measures the band via
a separate reviewed diff, §3.4).

| Claim (a) | Band (b) — a legitimate flip looks like | Anchor |
| --- | --- | --- |
| ForceBased motor is a real torque (ω ∝ 1/I); AB normalizes inertia (rejected) | FB ratio drifts within/near [3.5,5.5] as the discrete implicit-step shortfall changes; AB stays ~1.000 or the CLAIM breaks | `s0-motor.test.js:244` |
| Spring is an honest N/m position motor (sag = target ± m·g/k) | settle windows (2e-3) move with solver convergence; AB stays mass-blind or the CLAIM breaks | `s1-prismatic.test.js:195` |
| Vehicle-local suspension axis (roll-180 reverses extension) | covariant-agreement band (2e-3) tightens/loosens with f32 + settle | `s1-prismatic.test.js:314` |
| Chassis containment (finite, no tunnel, no escape) | floor/topmost catch bands re-measured if the engine rests bodies higher/lower | `chassis-drop.test.js`, `assembly-physics.test.js:124` |
| S1 suspension reduces chassis vertical accel while keeping progress | the 0.150× RMS / peak-reduction magnitudes move | `s1-drive.test.js:414` |
| Terrain features/craters are physically real depressions/obstacles | castRay depth + settle-band values move | `terrain-physics.test.js:145,:175` |
| Per-wheel drive law: each wheel to its own no-load surface speed | approach/cruise windows move; sign + |ω·r| identity must hold | `surface-speed-drive.test.js:265` |
| The runner/locks bind to the engine's OWN dt readback | the `effectiveDt` literal `0.01666666753590107` moves if timestep storage precision changes | `evaluation-core.test.js:128`, `probe-rapier-timing.js:181` |

---

## 13. Coverage and open classification questions

**Files covered (45):** 40 test files under `tests/` (incl.
`tests/browser/evaluation-determinism.test.js` and
`tests/browser/population-determinism.test.js`), the hard checks of
`scripts/probe-rapier-timing.js`, and the four lock/fixture modules
(`src/sim/evaluation-locks.js`, `src/sim/population-locks.js`,
`src/sim/evaluation-fixtures.js`, `src/sim/population-fixtures.js`).

**Assertion-group counts by class** (borderline groups counted under their
class-(a) home, with the band tracked in §12; split files counted in both
halves):

- Class (a) pure (engine-free, must stay byte-identical): ~19 files / ~70 groups
  — all of §4.1 plus the pure halves of §8.7, §9, §10.3, §10.4, §11.
- Class (a) engine-touching contract: ~60 groups across §5–§10 (containment,
  discriminators, fail-loud, transactional rollback, isolation, determinism-of-
  repeat, symbolic-enum/API-drift).
- Class (b) engine-finding lock: 12 distinct findings (§4.3), plus the ~30
  borderline bands catalogued in §12 whose windows are (b).
- Class (c) golden/version literal: the full §4.2 inventory — 4 evaluation
  digests + checkpoint arrays, the population fitness/champion/vector literals,
  the `effectiveDt` and `rapierVersion` literals, the two browser gates, and the
  bench `meta.rapier` pin.

**Open classification questions for your review** — cases where I made a call
that a maintainer may want to move:

1. **The dt-readback checks** (`probe-rapier-timing.js:181–190`,
   `evaluation-core.test.js:128`). I marked them `(a)/(b)`: the contract that
   the codebase binds to the engine's own readback is (a), but the specific
   value `Math.fround(1/60)` is what the class-(c) `effectiveDt` literals
   encode. It is arguably purely (c). I kept the dual mark because the check is
   the gate for everything else — flag if you want it reclassified to pure (c).

2. **`cohort-determinism.test.js:95` and `evaluation-determinism.test.js:49`
   ("two fresh worlds/orders agree").** I classified these (a) determinism-of-
   repeat because they compare two RUNS to each other, not to a committed
   literal — so they should stay green on any deterministic engine. But if the
   new engine is non-deterministic in a way that only these catch (never the
   golden digest), a red here is an adoption blocker, not a re-lock. Confirm you
   want them under (a) and not treated as a de-facto (c) gate.

3. **`s1-sag.test.js:278` (k=0∧c=0 free-slider realizer behavior).** This is a
   class-(a) claim (the realizer emits an honest free slider) that is only
   meaningful BECAUSE of the class-(b) engine 0/0-freeze it works around. I
   marked it "(b)-dependent". If the engine stops 0/0-freezing, the realizer's
   skip-motor rule may become unnecessary and this gate's premise dissolves —
   is that a (b) reclassification or an (a) contract you want preserved
   regardless?

4. **The strip-soft-CCD / strip-GROUND negatives** (`assembly-physics.test.js:245,275`,
   chassis-drop). I classified the negatives themselves (a) (soft CCD / GROUND
   filter are load-bearing) while the underlying "hard CCD is inert vs the
   heightfield" is the (b) finding. If a better engine makes hard CCD sufficient,
   the strip-soft-CCD negative could legitimately stop failing — that would make
   the negative itself a (b). I left it (a); flag if you'd rather pre-mark it (b).

5. **Borderline containment bands** (`chassis-drop`, `assembly-physics`,
   `terrain-physics`). I treated the containment CLAIM as (a) and the exact
   catch/settle windows as (b). A stricter reading would call the whole gate (a)
   and forbid any band movement on adoption. I went with the repo's own
   "tightenings free, widenings measured-and-reviewed" rule (§3.4); confirm that
   is the intent for the containment gates specifically.

6. **`bench-schema.test.js:29` `meta.rapier`.** I called it (c) because it
   mirrors the package.json dependency string and will go red on a version bump.
   It is not a physics digest, so re-locking it is trivial (update the string)
   — but it IS a version literal, which is why it belongs in the (c) inventory.
