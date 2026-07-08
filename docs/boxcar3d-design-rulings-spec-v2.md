# BoxCar3D — Design Rulings & Spec v2

**Date:** 2026-07-08
**Records:** your rulings of today, their cascade through the red-team decision queue, and the proposed genotype/terrain architecture that implements them.
**Supersedes:** the red-team report's §4 decision queue (this doc now owns the live queue); the "mirror BoxCar2D" fidelity constraint as originally worded.

---

## 1. Rulings recorded

**R1 — Corridor format (resolves D1).** Vehicles travel in one direction only. No steering, no controllers, no AI. All vehicles start abreast on a start line and drive forward through the level; the corridor has physical left and right walls that vehicles bounce off. Fitness remains distance along the corridor.

**R2 — Genuinely 3D terrain (amends the brief).** The corridor floor is real 3D terrain, not a decorated strip: elevation changes, craters, obstacles, and **terrain types with distinct driving properties** (sand, mud). Water is an explicit roadmap item, not v1. *Acknowledged gap: no existing build meets this — past terrain was a bumpy ribbon with scattered boxes, and walls were partly kill-bounds rather than physical surfaces. The terrain system is a redesign, not a port.*

**R3 — Morphology richness (amends the brief).** "Much richer and more complex" vehicle evolution: evolving scaffolding and frames, multiple **types** of suspension (not just parameter variation), and freedom in wheel arrangement — how many, where they sit, and which are driven. BoxCar2D remains the inspiration for the user-facing rules and options surface; it is no longer a ceiling on morphology.

---

## 2. Cascade through the open decisions

- **D3 is now resolved by implication.** Evolving suspension *topologies* requires real joint assemblies. The ray-cast vehicle controller has exactly one hard-coded suspension model with tunable parameters — it cannot express suspension types. **Backend J (joints) is the only canonical backend.** Recommendation: drop Backend R from Phase 1 scope entirely (→ **O3** to confirm) rather than carry a mode that can't represent the spec.
- **Joint-stability risk climbs back to HIGH.** Evolved assemblies multiply joints and produce configurations no human would design. Mitigation moves from "polish" to core: the assembly compiler (§3) *validates and repairs* every genotype before it touches the physics world, and chassis bodies get per-body additional solver iterations.
- **Physics budget rises; worker sharding becomes load-bearing.** A Tier-1 vehicle is 1 compound-collider chassis body + up to N wheel bodies + optional arm bodies, with 1–2 joints per wheel. The 50-vehicle target at 60 FPS now leans on the worker-shard design (red-team F9 invariants: no inter-vehicle interaction; shard-invariant per-vehicle RNG streams).
- **Ghost vehicles are implied and required.** "All start on the starting line" + no steering means vehicles will occupy the same space constantly. Non-colliding (ghost) vehicles is both the BoxCar2D convention and the precondition for sharding — recorded as the design, flagged for explicit confirmation (→ **O2**).

---

## 3. Genotype & assembly architecture (proposal)

### 3.1 Principles
1. **Constructive encoding:** genes are inputs to an *assembly procedure*, not raw physics values. Every genotype compiles to a physically sane vehicle — the compiler repairs (clamps, separates, re-seats) rather than rejects wherever possible.
2. **Symmetry as a gene.** Bilateral symmetry defaults on; asymmetric mutants are allowed but rarer. With no steering, symmetry is the difference between "drives forward" and "arcs into the wall" — evolution should be able to discover that, not fight the encoding to express it.
3. **Structural vs. parametric mutation are separate operators** with separate rates (structural rarer), so vehicle character can persist while parameters fine-tune.

### 3.2 Gene groups

**Frame ("scaffolding"):**
- Family enum: `spine` (central beam, nodes along it), `ladder` (twin rails + crossmembers), `hull` (convex blob, the legacy look).
- Node list along the longitudinal axis: position, height, half-width, beam thickness.
- Compiles to **one rigid body with compound colliders** (cuboids per beam, or a convex hull for `hull`) — rich shapes and honest mass distribution at single-body cost.
- **Tier 2 (deferred, → O4):** articulated spine — two frame segments joined by a stiffness-sprung revolute. Doubles chassis body count and joint surface; propose deferring until Tier 1 evolution is proven stable.

**Axle modules (variable count — this is the wheel-arrangement richness):**
- Longitudinal position on the frame; paired (left+right) or single (centerline).
- Track half-width; wheel radius, width, density. Wheels compile to **cylinders** (honest rolling contact), not spheres.
- **Suspension type enum:**
  - `S0` rigid mount — wheel revolute directly on the frame (cheapest, 1 joint).
  - `S1` vertical spring-damper — prismatic (vertical, spring via motor-position + limits) carrying the wheel revolute (the Phase 0 dual-joint; 2 joints).
  - `S2` trailing arm — small arm body on a laterally-axised sprung revolute, wheel revolute at its end (arc-travel dynamics; 2 joints + 1 body).
  - Menu is extensible (wishbone, swing axle later) — the enum is the extension point.
- Suspension params: stiffness, damping, travel, rest length (meaning per type).

**Drivetrain:**
- Per wheel: `driven?` + torque-share gene.
- **Global power budget** `P` split across driven wheels by normalized shares. Richness lever *and* selection pressure: all-wheels-max-torque stops being free, which blunts the monster-truck convergence (red-team F11) without touching the fitness function.

**Wheel count** emerges from module count × pairing. **No structural limit by ruling (O1)** — a generous runtime cap remains as a user option, with "uncapped" as an experimental setting (§6.1).

### 3.3 Operators
- **Crossover:** longitudinal-aligned axle-module exchange between parents + frame-family-aware frame gene mixing, followed by the repair pass. (Avoids the competing-conventions trap of raw-array crossover — red-team F16.)
- **Mutation:** parametric (jitter within ranges) vs. structural (add/remove/duplicate module, flip suspension type, flip symmetry, change frame family) at separate rates.
- **Repair pass (assembly rules):** enforce minimum ground clearance at rest pose, non-overlapping wheels, wheels below frame, track width within corridor sanity, mass bounds, joint anchor validity. Repairs are deterministic functions of the genotype (replay-safe).

### 3.4 Compile targets (module → Rapier)

| Genotype element | Physics realization |
|---|---|
| Frame nodes/beams | 1 `RigidBodyDesc.dynamic()` + compound `cuboid`/`convexHull` colliders; CCD on |
| Wheel | `cylinder` collider on its own body, density from gene |
| S0 | `JointData.revolute` (lateral axis) + `configureMotorVelocity` if driven |
| S1 | `JointData.prismatic` (vertical, `configureMotorPosition(rest, stiffness, damping)`, `setLimits`) + wheel revolute |
| S2 | arm body + sprung revolute (motor-position) + wheel revolute |
| Torque share | per-wheel `configureMotorVelocity(targetVel, share × P)` |

---

## 4. Terrain architecture v2

- **Corridor:** configurable width; physical walls with low restitution (a firm nudge back into play, not a pinball bumper — tune to the ruling's "bounce"). Start line abreast; ghost vehicles (O2).
- **Composite ground:** base heightfield from layered noise (macro elevation + micro roughness), then **stamped features**: craters as radial depressions baked into the heightfield; boulders (convex hulls), ramps (cuboids), logs (capsules) as separate colliders. The generator treats terrain as *composite from day one* (red-team F13).
- **Terrain types (sand, mud):** a 2D **zone map** over the corridor (per-cell material). At each wheel's contact, the update loop samples the zone and applies per-wheel response: friction scalar, velocity-proportional drag, torque-efficiency scalar. Engine-agnostic and cheap; avoids depending on engine-level contact-modification hooks (logged as **[V9]** if we ever want native material response).
- **Water (roadmap, not v1):** sensor volumes + buoyancy/drag forces; slots into the same zone-map concept.
- **Stationarity (D2, still open):** recommendation stands — fixed-per-run, seed-encoded; difficulty (crater density, roughness amplitude, zone coverage) as user options, so "harder terrain" is a chosen setting rather than silent drift.

---

## 5. User-facing options surface (BoxCar2D-inspired)

Population size, elite count, tournament size, structural/parametric mutation rates, wheel count range, corridor width, terrain seed, terrain difficulty knobs (roughness, crater density, zone coverage), time scale (1–3×). Fitness display, generation charts, and champion replay as before. Fitness = max distance; all timeout/stuck logic counted in **physics steps** (red-team F3 rule — CI-enforced).

---

## 6. Live decision & confirmation queue (supersedes red-team §4)

| # | Item | Status |
|---|---|---|
| D1 | Product identity | ✅ **Resolved — R1 corridor** |
| D3 | Backend / accuracy | ✅ **Resolved by R3 — Backend J canonical** |
| D4 | Cannon path | ✅ Delete (proceeding) |
| D5 | Sim-time purity | ✅ Adopted, CI-enforced |
| D2 | Terrain stationarity | ✅ **Ruled — fixed-per-run seed** |
| D7 | Determinism scope | ✅ **Ruled — cross-platform shareable seeds** (consequences in §6.1) |
| O1 | Wheel count range | ✅ **Ruled — unlimited by design**; perf-guard cap as a user option (§6.1) |
| O2 | Ghost vehicles | ✅ **Confirmed** |
| O3 | Drop Backend R from scope entirely | ⏳ Awaiting confirmation — plain-language explanation in §8 glossary; recommendation stands |
| O4 | Tier-2 articulated frame | ✅ **Ruled — defer, but architect toward it** (§6.1) |

### 6.1 Second-pass ruling consequences (2026-07-08)

**D7 — shareable deterministic seeds** commits us to:
- An integer-state PRNG (PCG32 or xoshiro128\*\*) as the *only* randomness source in terrain generation, genetics, and simulation scheduling, with per-vehicle child streams so results are shard-invariant.
- A repo-wide ban on `Math.random` and `Math.sin/cos/tan/pow/exp` in any generation or simulation path, enforced by an ESLint `no-restricted-properties` rule (rendering code exempt). Generation-side trig uses our own deterministic implementation.
- Seed mode runs on `rapier3d-deterministic-compat`: a shared seed reproduces the same terrain, population history, and champion on any machine or browser.
- CI: cross-environment hash test (same seed → identical terrain hash + fitness vector) on both Chromium and Node.

**O1 — wheel count**: the genotype has no structural limit (axle modules are a variable-length list), and the economics already push back on wheel spam — every wheel adds mass and joints while the drivetrain's power budget is fixed, so more wheels means less torque each and more to haul. Terrain types make the trade genuinely interesting: soft zones (sand/mud) should favor more/wider wheels, firm ground fewer. A **runtime cap stays as a user option** (generous default, e.g. 12; "uncapped" exposed as an experimental setting) purely as a performance guard, since population × wheels is the physics cost product.

**O4 — plan-towards rule**: the frame genotype is a *segment list* from day one; v1 always compiles exactly one segment. Tier-2 articulation then becomes an additive change (allow length > 1 plus one sprung joint type between segments) instead of a schema migration. The gene schema carries a version field from the first commit.

---

## 7. Impact on the Phase 1 checklist

Steps 1–5 (repo scaffold, tests-first, heightfield **now built to R2's composite-corridor spec with physical walls**, static features, chassis drop tests) proceed unchanged and are unaffected by the open items above. Step 6 becomes the **axle-module system**, landing suspension types incrementally — S0, then S1, then S2 — each behind its own test gate. Step 7 (gene adapter) becomes the **assembly compiler + repair pass** described in §3. Backend R work is removed from scope pending O3.

---

## 8. Glossary (plain language)

- **Backend J ("joints")** — wheels are real physical objects, each its own rigid body, connected to the frame by joints (hinges and sliders carrying springs and motors). Everything is honestly simulated: wheels ride over obstacles, get deflected, and still matter when the vehicle flips. The only backend that can represent different suspension *types* — canonical by ruling R3/D3.
- **Backend R ("ray-cast")** — Rapier's built-in shortcut vehicle: the car is one rigid box, and each "wheel" is an invisible ray probing the ground with a spring formula deciding how hard to push up. Very fast and explosion-proof, but the wheels aren't objects — one fixed suspension model, no wheel-vs-obstacle contact, nothing honest when flipped.
- **Shape 1 / Shape 2** — the two deployment styles after relaxing the single-file constraint: a no-build static folder (1) vs. the chosen Vite + Vitest + GitHub Actions repo (2).
- **`-compat` / `-deterministic` flavors** — Rapier package variants: `-compat` embeds the physics WASM inside the JavaScript file (no special hosting needed); `-deterministic` guarantees identical simulation results across machines and platforms, at some speed cost.
- **Heightfield** — a terrain collider defined by a grid of height values: fast and gap-free, but unable to express overhangs — which is why obstacles are separate colliders on top.
- **Ghost vehicles** — vehicles don't collide with each other; they share the track like ghosts in a racing-game time trial.
- **Assembly compiler** — the code that turns genes into an actual vehicle, applying the assembly rules and repairing anything physically invalid before it enters the world.
- **Zone map** — the grid over the corridor recording each patch's surface type (normal / sand / mud / later water); wheels sample it on contact for friction and drag.
- **Worker sharding** — splitting the population across browser worker threads, each simulating its slice in an independent physics world, for near-linear speedup on multi-core machines.
