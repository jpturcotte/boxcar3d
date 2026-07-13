# Physics Integrity — Finite-Explosion Reproduction and Ablation (2026-07-13)

> **Fact classes.** **Committed facts** are literals re-proved by CI (witness
> and reproducer genotype digests, the shared-loop equivalence and
> non-interference contracts, the A–D golden locks and Phase-1A population
> locks — all byte-identical throughout this PR). **Offline deterministic**
> figures — including the prevalence counts, the reproducer closure matrix,
> the free-space load discriminators, the contaminated-control finding, and
> every onset/localization number — reproduce from declared seeds via
> `npm run probe:physics-explosion -- --witness all --pass all`
> (deterministic Rapier 0.19.3 flavor; not CI-gated; the ordinary flavor's
> figures are per-process observations, never contracts — F10).
> **Machine-specific** is wall-clock only (reference: i7-14650HX, Windows 11,
> Node v22.19.0, 2026-07-13). **Design inference** and **unresolved** items
> are labeled inline. Negative experiments are reported deliberately.

## 1. Question and scope

GA Phase 1A found individuals catapulted to enormous-but-finite displacement
(up to 8.17e6 m at peak chassis speeds of 3.26e9 m/s) with `valid: true` on
the characterization terrain, and attributed the tail to "hitting terrain
features". This investigation answers: **what injects the enormous finite
energy, under precisely which conditions, and what is the narrowest correct
response?** In scope: reproduction, non-perturbing telemetry, terrain /
vehicle / engine ablations, a minimum reproducer, and a correction or
engine-limitation ruling. Out of scope (deferred to Phase 1B by mission
ruling): any fitness cap, plausibility threshold, or selection design —
`FITNESS_POLICY_VERSION` stays 1.

## 2. Known witnesses (committed identities)

All from `createInitialPopulation({seed, populationSize: 20})` on terrain
`{seed: 20260727, startFlatLength: 30, startBlendLength: 6}`, 300 steps,
deterministic, spawn `{x: -44, z: 0}`, targetWheelSurfaceSpeed 5,
wheelFriction 1 (`scripts/explosion-witnesses.js`, locked by
`tests/explosion-witnesses.test.js`):

| label | seed:id | genotype digest | morphology | chassis / wheels+hubs mass |
| --- | --- | --- | --- | --- |
| A | 20260725:19 | `ec8d42cf` | spine, asymmetric, 6 axles (5 co-located at the R5 frame-end cap), 10 wheels, S0×4+S1×2 | 18 kg / 418 kg |
| B | 20260728:4 | `393f7e0e` | spine, symmetric, 6 axles, 10 wheels, S0×1+S1×5 | 49 kg / 872 kg |
| C | 20260729:19 | `57faad4e` | hull, symmetric, 4 axles (3 co-located), 8×80 kg wheels, S0×1+S1×3 | 104 kg / 760 kg |
| S | 20260725:14 | `565f8c72` | hull, asymmetric, 3 axles, 5 wheels, all-S1 | 33 kg / 398 kg |

Passive-twin digests: `0afc0cd1` / `f1237fed` / `9f722379` / `09bb9a89`.

## 3. Initial hypotheses

H1 static-collider conflict (embedded feature + heightfield trap, overlap,
seams); H2 feature seating/geometry defect; H3 joint-island amplification
(S1 chains, hub inertia, drive joints, extreme mass ratios, solver-iteration
policy); H4 CCD interaction; H5 Rapier solver limitation; H6 multiple
mechanisms. The Phase-1A report's own framing favored H1/H2 ("individuals
hit terrain features and are catapulted").

## 4. Baseline reproduction (offline deterministic)

Every witness reproduces Phase 1A exactly: A driven maxForward
8,170,342 m (report: 8.17e6) with final chassis vx −143,188,704 m/s
(report: −1.43e8); B 2.957e3 driven / 0.527 passive; C 1.156e3 / 9.472e6;
S 3.635 / 128.5. Deterministic same-config repeats are byte-identical —
the FULL retained record streams via `compareTraces`, byte counts, and
checkpoint arrays, a HARD probe check. The ordinary flavor
reproduces the mechanism with identical onset steps and leading bodies
(magnitudes differ; e.g. A driven reaches 2.4e4 m instead of 8.2e6 m) and
was per-process repeatable in every observation. B's driven final
displacement is −2.35e7 m — the "small" Phase-1A maxForward numbers hide
backward/lateral catapults.

## 5. Telemetry design and non-interference proof

Tier 1 (zero runner changes): full traces from the UNCHANGED `runEvaluation`
analyzed offline by `src/sim/trace-forensics.js` — per-body per-step speed,
one-step velocity delta, one-step displacement, |ω| and a per-body-reach tip
speed, plus a three-concept onset: **firstAlertStep** (diagnostic-threshold
locator: speed > 25 m/s, Δv > 30 m/s/step, or dx > 0.42 m/step — derived
from g·dt = 0.333 m/s, the 22 m/s worst legitimate fall, and 25 m of
legitimate travel), **firstCatastrophicStep** (>1000 m/s or a >16.7 m
teleport step), and **firstCausalCandidateStep** (backward scan from the
alert while any body's per-step velocity change exceeds the 1 m/s escalation
floor; the window expands backward, never clipped). Per-capture thresholds
are DEFINED at the reference capture interval 1/60 and scale linearly with
the trace's declared `captureDt` (the run's effectiveDt — the applied
thresholds and the captureDt are echoed in every output), so onsets from
different-timestep arms are never compared under mismatched units.
Thresholds are diagnostic options, consumed by no lock and no fitness path.

Threshold calibration and the contaminated-control finding: the calibration
procedure walks the fitness ranking of population 20260725 (witness ids
excluded) for min/median/max controls. **Its first max-fitness candidate —
id 1, fitness 14.02 m, the best-scoring non-witness — FAILED calibration
with an internal >1000 m/s blow-up (catastrophic at step 52). That failure
is itself a finding — fitness concealed the instability — and is what
triggered the complete prevalence pass (§8).** The committed procedure
reports every contaminated candidate as its own row and deterministically
substitutes the next-ranked alert-free member (the selected controls: id 16
min, id 15 median, id 13 max — clean, driven and passive, at default AND
half thresholds).

Tier 2 (earned by the decision record, §7): `runRealizedEvaluationLoop` was
extracted from `runEvaluation` (composed verbatim by the production path —
A–D golden digests and every checkpoint state byte-identical, zero re-locks)
with an explicit `requestedDt` — which must MATCH the engine's f32 timestep
readback or the loop fails loud (a 1/120 composition can never
mis-report itself as 1/60; negative-tested) — and an optional read-only
`inspect(stepIndex)` hook the production path never passes.
**Non-interference is a committed contract**
(`tests/evaluation-core.test.js`): a real contact-querying inspect
(narrow-phase manifold reads > 0) produces byte-identical trace records,
digests, results, and counts; composition equivalence with `runEvaluation`
is byte-exact on the composite witness terrain; the probe's engine pass
re-checks composed-vs-canonical digest equality per witness as a hard
check. Deterministic repeatability checks compare the FULL retained record
streams (`compareTraces`), byte counts, and checkpoint arrays — never the
FNV digest alone.

## 6. First-anomaly records (offline deterministic)

| witness | alert | causal candidate | catastrophic | leading body | chassis lag | alert spread ×0.5/×2 |
| --- | --- | --- | --- | --- | --- | --- |
| A driven | 20 | 10 | 60 | wheel(axle 2, w1) — an UNDRIVEN S0 station | 8 | 19/20/22 (3) |
| B driven | 21 | 13 | 56 | hub(axle 5, w1) | 5 | 20/21/23 (3) |
| C driven | 31 | 20 | 62 | wheel(axle 3, w1) | 6 | 29/31/34 (5) |
| S driven | 43 | 21 | 88 | hub(axle 1, w0) | 4 | 39/43/53 (14) |

Passive twins: same leading bodies, near-identical steps. All onsets occur
**on the exactly-flat start pad** (spawn x −44; the pad spans to x −30; at
these steps every vehicle has moved < 2 m). At spawn: zero contact pairs at
captures 0 AND 1 (the step-0 contact-graph question was answered
empirically, not assumed — the narrow phase reports no pairs before the
bodies fall the 0.02 m clearance), analytic wheel clearances exactly
+0.020 m, belly clearances +0.39–0.67 m — **no birth penetration**.
Contacts across the causal window are ordinary floor contacts: penetrations
1e-4–2e-3 m, impulses 10–140 N·s, zero wedge configurations at onset (C
shows 2 wedge candidates only post-blow-up near the walls at steps 74–79).

**The earliest measurable event is joint-constraint violation, not contact
anomaly — directly measured for BOTH joint types.** Revolute-anchor
separation (S0: chassis-anchor vs wheel; S1: hub vs wheel) and the
prismatic decomposition (chassis→hub anchor delta split into the along-axis
coordinate vs the [0, travel] limits and the OFF-AXIS separation) both come
from the trace:

| witness | first revolute >2 cm | first prismatic off-axis >2 cm | prismatic coordinate range vs travel |
| --- | --- | --- | --- |
| A | S0 station 2\|0 at step 6 (alert 20) | station 3\|0 at step 9 | [−2.0e7, +2.3e7] m vs 0.324 m |
| B | S1 station 5\|1 at step 24 | station 1\|0 at step 15 (alert 21) | [−1.4e7, +1.8e7] m vs 0.278 m |
| C | S0 station 0\|0 at step 31 | station 2\|0 at step 19 (alert 31) | [−9.8e6, +8.7e6] m vs 0.299 m |
| S | S1 station 1\|0 at step 88 | station 0\|0 at step 24 (alert 43) | [−1.8, +3.3] m vs 0.301 m |

Every witness shows a directly measured constraint violation at or before
its causal-candidate/alert steps, and every S1 prismatic coordinate blows
through its hard limits by orders of magnitude — the solver leaves both
joint types violated under ordinary loads, and its correction impulses grow
instead of converging.

Witness S's alert spread (14 steps across ×0.5/×2) flags it as the most
gradual of the four — nearest the stability boundary (§8) — while A/B are
discrete (spread ≤ 3).

## 7. Terrain and feature ablations (offline deterministic)

Coarse matrix (full / noFeatures / noCraters / roughnessOnly / flat ×
driven/passive × all witnesses; `roughnessOnly` covers both mission variants
4 and 6 — zones are inert data in v1): **onset step and leading body are
IDENTICAL across every variant for every witness**; only post-onset
ballistics change (maxForward swings chaotically, 0.53 m to 8.4e7 m). All
four witnesses reproduce on completely flat terrain (A worsens to 2.7e7 m).
The Tier-2 decision record followed from this pass: terrain content is not
necessary, so the remaining questions (solver parameters, contact identity,
exact component necessity) required the shared-loop seam. Local
feature-level ablations (translate/rotate/embedDepth/graft) were **not
applicable**: their trigger condition — a contacted or nearby feature at
onset — is empty for every witness. Feature-geometry diagnostics were not
run for the same reason (no implicated type). H1 and H2 are eliminated for
these witnesses.

## 8. Vehicle ablations

Ecological (genotype-level, edit → repair → compile; every arm digest
recorded): passive and power→0 twins explode identically for all four
witnesses (**drive is not necessary and cannot account for the catastrophic
energy magnitude** — the passive and motor-off islands reach the same 1e9+
m/s speeds; **motor torque can nevertheless excite the unstable island**,
witnessed by the motors-only free-space arm in §9). `targetWheelSurfaceSpeed:
0` with driven wheels is rejected pre-world by ruling, so power→0 is the legal
zero-drive analogue and produced bit-identical outcomes to the passive twin.
Power ×0.5/×0.25/×0.1 is non-monotone in magnitude. All-S0 conversions still
explode (S1 is not necessary). **Every single-module arm
and every chassis-only sled is completely stable** — at least two axle
modules on one chassis are required. Per-axle removal does not cure A/B/C
(several arms worsen); S is cured by removing ANY of its three axles.
Mass-ratio arms: frameDensity→1 cures B and S outright, dampens A
(no catastrophe, peak 653 m/s), and does NOT cure C (2 kg wheels on a 104 kg
chassis still catastrophic) — mass ratio is contributory, not the full
mechanism. wheelFriction {0, 0.5, 2} is non-monotone and never curative.

Phenotype-preserving (Stage 2; the ORIGINAL vehicle realized, then one
component disabled/removed — outside the genotype contract, labeled): motor
reconfiguration to zero gain (all stations, or the leading station) never
cures; removing the leading station's bodies does not cure A/B/C (the
island re-diverges through another station at reduced magnitude,
cat@37/52/44) and DOES cure S. **No single component is necessary; the
instability is a property of the multi-module island.**

Prevalence (the committed `prevalence` pass — every characterization
individual, driven, forensically classified): **5/60 catastrophic**
(20260725 ids 1@52, 14@88, 19@60; 20260728 id 4@56; 20260729 id 19@62) and
55/60 alert-free. The Phase-1A >200 m label caught only 3 of 5: 20260725
id 14 (driven 3.63 m) and id 1 (fitness 14.02 m — §5's contaminated
control) hide >1000 m/s internal blow-ups behind healthy-looking forward
progress.

## 9. Engine and solver ablations (diagnostic, composed through the seam)

No arm abolishes the event for any witness:

- **dt 1/120 × 600 steps** (honest `requestedDt`; forensic thresholds
  dt-scaled by the declared captureDt so onsets are unit-consistent): does
  not cure; B becomes astronomically worse (peak 1.66e21 m/s). Not an
  integrator step-size problem.
- **Zero gravity (free space) — the committed `load` pass**: a dedicated
  pass crosses the two internal load sources on every witness and counts
  vehicle-vs-static touching contacts (manifold points with `contactDist ≤
  0`) at every capture, so "free space" is measured, not assumed. The
  witness-A crossing (all four witnesses in the pass table):
  | free-space arm (zero gravity) | internal loads | touching contacts | first alert / catastrophe |
  | --- | --- | --- | --- |
  | original | motors + springs | 60 (first @25) | alert@19 / cat@33 |
  | passive (driven→0) | springs only | 40 (first @38) | alert@35 / cat@48 |
  | drivenAllS0 (suspType→0) | motors only | 64 (first @20) | alert@24 / cat@36 |
  | passiveAllS0 (both off) | none | **0 (no touching contact ever)** | **no alert; peak body speed exactly 0** |
  All four full witnesses still diverge under zero gravity in the driven
  `original` arm (A cat@33, B cat@48, C cat@42, S cat@122). The crossing
  isolates the trigger: **S1 springs alone (cat@48) and drive motors alone
  (cat@36) each suffice; the fully unloaded island is quiescent** — the only
  arm with a MEASURED zero touching contacts (proximity pairs still exist
  over the pad's conservative heightfield AABB, but none carry a contact
  point). Every free-space claim regenerates from
  `npm run probe:physics-explosion -- --witness all --pass load`.
- **world.numSolverIterations 2/8/16**: MORE iterations make onset EARLIER
  and usually larger (A at 16: alert@9, cat@16; C at 16: peak 5.7e11) —
  iteration accelerates the divergence, the signature of a non-convergent
  constraint solve rather than convergence starvation.
- **chassis additionalSolverIterations 0/8**: 0 consistently delays and
  dampens (peaks drop to 1e3–1e5) but never cures; 8 matches
  world-iterations-8 behavior. The policy value 4 is not causal — and
  lowering it is a suppression, not a correction, by the mission's own
  standard.
- **CCD arms** (hard off / soft off / both off / prediction 0.1–2):
  magnitude shuffling only; onset essentially unchanged. H4 eliminated.
- **Gravity 9.81 vs 20** (on the reproducer): identical classification —
  the g = 20 policy is exonerated.
- Restitution arms were not run: the onset contact partner is the floor,
  whose restitution is already 0 (adapter default); no stored-contact-energy
  path exists at onset. Statics creation-order arms were not run: no static
  beyond the floor participates at onset.

## 10. Minimum reproducer (committed literal)

`MINIMAL_REPRODUCER` (`scripts/explosion-witnesses.js`, digest `9fde1f1c`,
canonical, gene-rounded to two decimals from witness A's axles 2+5 and
re-repaired): **two wide-track paired S0 axles (wheel centers z ≈ ±2.32 /
±1.88 m), four UNDRIVEN wheels of 8.8–22 kg, one 18 kg chassis (79 kg
total), no motors, no S1, on a completely flat corridor** — catastrophic
(>1000 m/s) by step ~46 of 300, identically on BOTH Rapier 0.19.3 flavors.
Necessary/sufficient closure — removing any single ingredient abolishes the
event: either axle alone (stable), trackHalf genes ≤ ~0.2 (stable),
frameDensity 1 (~160 kg chassis, stable), and zero load (free space:
quiescent with a measured zero static contacts). Axle co-location is
contributory, not necessary (spread axles still diverge). **The complete
closure matrix is instrumented**: the committed `reproducer` pass runs the
unchanged reproducer on both flavors plus every stabilizer arm and the
free-space discriminator, so the closure regenerates from one command.
Rerun after any engine bump:
`npm run probe:physics-explosion -- --pass reproducer` (identity and
deterministic byte-exact repeatability are hard checks; every onset/outcome
is an observation — no committed test asserts the explosion occurs).

## 11. Causal classification

- **Necessary in every tested witness reduction and in the committed
  minimal-reproducer closure** (NOT asserted as a universal theorem about
  every possible Rapier joint-island divergence — the conditioning boundary
  was probed one variable at a time, not factorially): ≥ 2 axle modules on
  one chassis; long lateral anchor arms (wide track relative to the chassis
  body); a light chassis relative to its wheel set (in the minimal
  configuration); and SOME ordinary load exciting the island — floor-contact
  settle, S1 spring preload, or drive-motor torque EACH suffice, and with
  none of them (passive all-S0 in free space) the island is quiescent
  (measured: zero touching contacts, zero alerts, peak body speed 0). No
  PARTICULAR load is necessary; ground contact is the observed initiating
  load in every evaluation-context run, not a necessary condition.
- **Sufficient**: the minimal reproducer's configuration, on a flat plane,
  under either flavor.
- **Contributory**: unsprung:chassis mass ratio (cures B/S, dampens A, does
  not cure C — the conditioning boundary is multi-dimensional); solver
  iterations (accelerate); chassis additional iterations (dampen at 0);
  axle co-location; S1 chains (raise magnitude; not necessary); drive
  torque (changes displacement outcome only).
- **Correlated only**: terrain features, craters, roughness (they scatter
  the post-onset ballistics — the Phase-1A "hit terrain features" inference
  was a final-state artifact); CCD; dt; gravity magnitude; the >200 m label.

Clustering: all four witnesses (and control 20260725:1) share ONE mechanism
class by intervention evidence — station-led onset on flat ground under
ordinary contacts, constraint stretch preceding or accompanying the alert,
iteration-acceleration, damping at additionalSolverIterations 0 — with
different conditioning margins (S sits nearest the boundary: any removal
cures it; A sits deepest). Witness B's Phase-1A "drive-dependence" decomposes
as **reachability only**: its passive twin diverges identically in velocity
(cat@67) but the catapult does not translate into +X displacement without
drive. The evidence supports **one observed mechanism class, with no evidence
of a second mechanism** (H6). It is NOT claimed fully closed: a behavioral
investigation without a Rapier-side source diagnosis cannot rule out a
distinct upstream mechanism that happens to present the same kinematic
signature.

## 12. Ruling: Rapier 0.19.3 constraint-solver divergence under BoxCar3D's
current legal multi-module joint realization

The impulse solver fails to converge on legal, in-band vehicle islands —
multiple wheel modules whose revolute/prismatic anchors sit on long lateral
lever arms of a light chassis — under any ordinary load (floor-contact
settle, spring preload, or motor torque). The divergence injects finite
energy (velocities to 1e9+ m/s within ~1 s of sim time) while every body
stays finite and every joint reports valid. No tested exposed engine setting
cured it: more iterations accelerate it, halving dt can worsen it
catastrophically, CCD and gravity are irrelevant.

**Scope of the ruling — what is and is not eliminated.** Eliminated by
intervention: incorrect spawn placement (no birth penetration), terrain
generation and feature seating (§7 — H1/H2), the drive law and motor
configuration (§8), the g = 20 policy, CCD policy, and the initial joint
setup (anchors exact at creation; §9). **NOT eliminated: the current
realization ARCHITECTURE as a possibly-mitigable design.** Exact creation
anchors rule out an initial mismatch, not the architecture itself — one
impulse joint per station with long off-center chassis anchors is what the
solver diverges ON, and no equivalent physical assembly was tested under an
alternative realization (e.g. multibody joints, intermediate bodies
shortening anchor arms, or split anchor frames). The solver may be at
fault while BoxCar3D could still later choose a better-conditioned
representation that preserves the phenotype — recorded as an open design
direction (*unresolved*), distinct from a defect: nothing in the current
realization is incorrect against Rapier's documented contracts.

**Why no project correction lands in this PR:**
- No candidate DEFECT survived intervention (list above): every component
  of the current setup is individually correct and in-band, and every
  "cure" available at the configuration level is a suppression by the
  mission's own standard (magnitude reduction without convergence).
- A repair-rule bound (e.g. on track width, module count, or mass ratio)
  would reject legitimate morphology to mask a solver limitation — the
  mission's overfitting guard ("do not globally reject strange morphology
  merely because it participated") — and the measured conditioning boundary
  is multi-dimensional (C resists the mass-ratio cure), so any simple clamp
  would be overfit to five witnesses. *Design inference:* if Phase 1B later
  chooses to constrain the search space, that is a fitness/GA policy
  decision to make with selection-level evidence, not a physics correction.
- An alternative realization architecture (above) is a research direction,
  not a narrow correction — it would re-realize every vehicle and re-lock
  every digest, and there is no measured candidate design yet.
- An engine upgrade is out of scope by mission constraint (Rapier pinned at
  0.19.3); the reproducer + probe pass exist precisely so a future bump
  re-answers the question in one command.

Consequence for the Phase-1A finding: the explosion tail is **not** a
terrain interaction and not limited to "one individual per seed" — it is a
solver-stability property of ~8% of generation-0 morphologies (5/60), two of
which hide behind ordinary-looking fitness values.

## 13. Regression evidence

Under an engine-limitation ruling, the bug's persistence is never a CI
requirement. Committed coverage: witness identity locks (digests,
initializer cross-check, passive-twin recipe equivalence, morphology
literals); the materialized reproducer's identity/canonicality/phenotype
tests; the shared-loop equivalence + observational non-interference +
honest-dt (mismatch-fails-loud) contracts; the probe schema smoke
(structure + hard identity checks only, incl. the load-taxonomy and
free-space contact-count shapes, the pass-normalization equivalence of
`['all']` / `['baseline,terrain']`, the single-pass `effectiveDt` readback,
and the prevalence pass shape).
All existing locks are byte-identical: noise, the five terrain
fingerprints, boulder hull, `24cd0dd5`, `39bcd6c4`, evaluation fixtures A–D
(digests `5a219735`/`02a80181`/`6b83729e`/`e2fc7625`), the Phase-1A
population/champion locks, and every version constant
(`GENOTYPE_VERSION` 1, `ASSEMBLY_IR_VERSION` 2, `EVALUATION_TRACE_VERSION`
1, `FITNESS_POLICY_VERSION` 1, all population/evaluation encodings). No
production physics change shipped; no re-lock occurred; no new seed was
allocated (all runs use the declared Phase-1A seeds and knob variants of
terrain 20260727).

## 14. Rejected explanations (negative results, kept deliberately)

- Terrain launch off features/craters (Phase 1A §4.3's inference): onset
  precedes any feature contact; identical onset on flat ground.
- Ground contact as THE necessary trigger: the free-space arms show any
  ordinary load suffices (S1 springs alone or drive motors alone diverge
  witness islands in zero gravity) while the fully unloaded island is
  quiescent — contact is the observed initiating load in evaluation
  context, not a necessary condition.
- Birth penetration / bad spawn: analytic clearances positive; captures 0–1
  contact-free.
- Feature seating/geometry defects (H2): no feature participates at onset.
- Static wedges (H1): zero wedge configurations at onset.
- CCD interaction (H4): all CCD arms near-inert.
- Integrator step size: dt 1/120 does not cure (worsens B by 10 orders).
- Convergence starvation curable by iterations: more iterations accelerate
  divergence.
- Drive/motor energy injection as the NECESSARY source: passive, power→0,
  and motor-off arms all diverge to the same magnitude, so drive cannot
  account for the catastrophic energy — though motor torque alone can excite
  the island (§9 free-space motors-only arm), it is an excitation, not the
  energy source.
- The deterministic build: the ordinary flavor reproduces onset-for-onset.
- Gravity 20: 9.81 reproduces.
- A knife-edge numeric coincidence: 2-decimal gene rounding reproduces.

## 15. Known limitations

- Conditioning boundary not fully mapped: the wide-track/light-chassis/
  module-count surface was probed one variable at a time plus the minimal
  closure; no full factorial of the boundary was run (*unresolved*: the
  exact analytic conditioning criterion).
- No equivalent physical assembly was tested under an ALTERNATIVE
  realization architecture — the current one-impulse-joint-per-station
  design is not exonerated as a possibly-mitigable representation
  (*unresolved*; §12).
- Wedge normals use the manifold `flipped` flag orientation convention
  (*design inference* on the normal frame, used only diagnostically; the
  collector fails loud on a contacts-without-normal invariant break).
- Prismatic motor-target error is not decomposed (the telemetry measures
  off-axis separation and the coordinate vs limits; spring-target tracking
  error is not separately reported).
- The ordinary flavor is observed per-process only (F10); no cross-platform
  claim.
- One characterization terrain seed family; prevalence (5/60) is for
  generation 0 on that terrain.
- Upstream (Rapier-side) root cause is characterized behaviorally, not at
  the Rust source level.

## 16. Consequences for GA Phase 1B

1. The numerical-integrity policy Phase 1B must design now has a principled
   detector: the forensic alert/catastrophic classification (peak body
   speed, one-step Δv) identifies every diverged individual including those
   whose fitness looks ordinary — unlike any displacement threshold (200 m
   caught 3 of 5). `analyzeTrace` is reusable as-is; whether its thresholds
   become a validity bound, a rank guard, or a re-evaluation trigger is
   Phase 1B's decision (*explicitly deferred by this PR*).
2. Raw `maxForwardDistance` mis-ranks in BOTH directions on affected
   individuals: catapults inflate it (A) and hide it (B backward, id 1
   ordinary-looking). Selection must not consume it unguarded on any
   terrain, flat included — the flat-terrain reproduction removes the
   "constrain the training terrain" escape hatch suggested in Phase 1A §9.
3. ~8% of generation-0 individuals are affected; mutation can move
   morphologies across the conditioning boundary in both directions, so the
   detector must run per evaluation, not once per lineage.
4. On any Rapier upgrade:
   `npm run probe:physics-explosion -- --pass reproducer` (then
   `--witness all --pass all` if the reproducer's behavior changed).

## 17. Process retrospective

- **What changed the implementation**: the Stage-1 trace-only pass
  overturned the terrain hypothesis within ~40 runs and redirected the whole
  Gate-4 local-ablation program (never needed); the joint-stretch series —
  computable offline from the existing trace — produced the earliest causal
  marker, before any contact telemetry existed; the maintainer's
  evidence-first ordering (Tier-1 before the core extraction) meant the
  seam was built already knowing WHICH questions it had to answer.
- **Dead ends kept**: the mass-ratio story (cures B/S, fails C) — half a
  mechanism is not a mechanism; friction and CCD sweeps (non-monotone
  noise); restitution/creation-order arms (mooted by localization).
- **Instrument lessons**: physics magnitudes must never be probe hard-checks
  (identity/repeatability/dt only) or the instrument dies with the first
  correction; the `>200 m` label is a displacement statistic, not a
  stability detector — per-body kinematic forensics is the honest
  instrument; final-state numbers (Phase 1A's tables) actively misled about
  the mechanism (chaotic post-onset ballistics), exactly the final-state
  fallacy the mission warned against. Fitness-selected calibration controls
  can be CONTAMINATED by the very effect under study — the first
  max-fitness control (id 1) concealed a blow-up behind 14.02 m of forward
  progress; its calibration failure is what triggered the prevalence pass,
  and the committed procedure now substitutes contaminated candidates
  deterministically while reporting them as findings.
- **Review lessons (the request-changes round)**: claims must regenerate
  from the committed command before the report may say so (the prevalence
  and closure figures were originally scratch-run only); "contact is
  necessary" was a final-state-shaped over-claim the zero-gravity
  discriminator corrected to "some ordinary load is necessary"; and
  "realization exonerated" over-reached what exact-anchor evidence can
  eliminate.
- **Review lessons (round 2)**: a "regenerates from `--pass all`" claim is
  only true once the crossing it names is a committed PASS (the spring-only
  / motor-only / unloaded discriminators were still scratch-run, so the
  dedicated `load` pass had to construct all four arms and contact-count
  each before the report could cite them); a validated config value that is
  then discarded is a latent API bug (pass selection was validated but
  dispatched from the raw array, so `['all']` ran nothing) — normalize once,
  through one authority, and test the programmatic entry; a nullable global
  populated only by one pass misreports every OTHER single-pass run
  (`effectiveDt`); and precise excitation-vs-energy-source wording matters
  ("drive can excite the island but is not the energy source" is the honest
  claim, not "drive is never the energy source").
- **Wall-clock** (machine-specific): the full Stage-1 matrix (~230 runs)
  9.5 s; the Stage-2 engine/local/vehicle matrix 10.2 s; the prevalence
  scan (60 traced runs) ~7 s.
