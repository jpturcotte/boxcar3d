# BoxCar3D — Red Team Report

**Date:** 2026-07-08
**Scope:** every assumption from the original brief (2025) through this week's decisions, including Claude's own recommendations (Phase 0 audit, migration delta, Amendment A). Attribution is marked on each finding: **[brief]** = stated by you in the original spec, **[build]** = implicit in what was actually built, **[claude]** = my proposal.
**Method:** for each assumption — the attack, the consequence if the attack lands, the cheapest test or mitigation, and whether it requires a decision from you (feeds the D-queue in §4).

---

## 1. CRITICAL findings — these change the gene schema, corrupt results silently, or contradict the spec

### F1. The project never decided whether it is 2.5D or 3D **[brief + build]**
**Assumption:** "The rules and options should mirror BoxCar2D" is coherent in 3D.
**Attack:** BoxCar2D needs no steering because 2D has no lateral axis. In 3D, a vehicle with fixed wheels on procedurally rough ground will drift laterally and either needs (a) walls, or (b) steering. Every build to date silently chose (a): track walls, z-bound kill conditions, fitness = distance along +x. That is a **2.5D corridor sim with 3D graphics** — a legitimate product, but an unexamined one. True open-3D evolution requires steering genes or a control policy, which BoxCar2D's rules cannot mirror because they don't exist there.
**Consequence:** the gene schema, fitness function, and terrain generator all differ between the two answers. Building Phase 1 wheels before answering this risks a third rewrite.
**Mitigation:** decide explicitly (→ **D1**). The corridor answer is cheaper, truer to the "mirror BoxCar2D" constraint, and matches everything built so far; it just deserves to be chosen on purpose.

### F2. Procedural terrain makes fitness non-stationary unless a policy says otherwise **[brief + build]**
**Assumption:** "procedural generation for the levels" coexists with meaningful selection pressure.
**Attack:** if terrain regenerates between generations, fitness comparisons across generations compare performance on *different problems* — selection signal gets noisy, lineages churn, "best fitness" charts lie. If terrain is fixed per run, evolution overfits one track (which is exactly what BoxCar2D does, and is fine — but then "procedural" means "seeded once"). Past plans also floated "progressive difficulty," a third, stronger form of non-stationarity, never reconciled with the mirror constraint.
**Mitigation:** pick a stationarity policy (→ **D2**): fixed-per-run (BoxCar2D-faithful, default recommendation), fixed-for-N-generations, or curriculum. Whatever is chosen must be encoded in the seed so replays are honest.

### F3. Wall-clock time has leaked into fitness before, and nothing prevents it recurring **[build]**
**Assumption:** fitness and termination depend only on simulation state.
**Attack:** at least one prior build accumulated stuck-timers from render-frame deltas (`stuckTime += deltaTime`) and tracked lifetime in a way entangled with frame rate. That means **selection pressure varied with the viewer's GPU** — a slower machine killed vehicles on different schedules than a fast one. This silently corrupts results, breaks replay, and invalidates any cross-machine comparison, regardless of how deterministic the physics engine is.
**Mitigation:** hard rule, enforceable by test: every clock feeding fitness, termination, or motor scheduling counts **fixed physics steps**, never `performance.now()` or frame deltas. Add a CI test that runs the same seed at 1× and 3× time scale and asserts identical fitness. No decision needed — adopt.

### F4. "Deterministic replay" dies at the JavaScript boundary even with the deterministic Rapier build **[claude]**
**Assumption (mine, in the delta doc):** `rapier3d-deterministic-compat` ⇒ cross-platform bit-exact replay.
**Attack:** the deterministic build guarantees the *physics step* is deterministic **given identical inputs**. Our inputs are generated in JS: terrain uses `Math.sin`/`Math.cos`, whose precision is implementation-defined in ECMAScript — different JS engines may return different low bits. Different terrain bits ⇒ different heightfield ⇒ divergent runs, and the physics engine is innocent. Same trap for any `Math.random()` remnants and for float accumulation order in our own code.
**Consequence:** seed-sharing across users on different browsers breaks in a way that looks like a physics bug and isn't.
**Mitigation:** determinism scope decision (→ **D7**). If cross-platform seeds matter: integer-state PRNG (e.g., PCG/xoshiro), terrain from PRNG output without library transcendentals (table/polynomial trig or precomputed terrain data), and a cross-browser hash test in CI. If same-machine replay suffices, document that limit honestly in the UI.

### F5. Backend R (ray-cast vehicle controller) arguably violates the "accurate 3D physics" constraint **[claude vs. brief]**
**Assumption (mine):** joints-vs-raycast is a free A/B decided by metrics.
**Attack:** you specified *accurate* physics. Ray-cast wheels are virtual — no wheel-as-body contact, no honest behavior when flipped, no wheel–obstacle collision. By the letter of the brief, Backend R is out of spec no matter how well it benchmarks. My A/B framing quietly demoted a stated constraint to a preference.
**Mitigation:** decision (→ **D3**): either (a) Backend J is canonical and R is an explicitly-labeled "turbo/approximate" toggle, or (b) amend the accuracy constraint. Also note the A/B's "evolutionary interestingness" comparison is confounded anyway — the two backends define different fitness landscapes, so cross-backend fitness curves are apples and oranges; the A/B can legitimately decide perf and stability, not which evolution is "better."

---

## 2. HIGH findings — expensive if ignored, cheap if handled now

### F6. The dual-engine PhysicsAdapter (Cannon kept behind a flag) is a sunk-cost artifact **[claude]**
The parallel-engine rollback strategy made sense in the single-artifact era. With Shape 2, rollback is `git revert`. The Cannon baseline is already condemned as broken — A/B against a broken control produces no useful signal, and maintaining the second path taxes every feature. **Recommendation: delete the Cannon path entirely at Phase 1 start** (→ **D4**). The adapter abstraction stays (it still serves J/R backends and a future Box3D), but with one engine behind it.

### F7. Rapier is pre-1.0 and we already paid the drift tax once **[claude]**
The maintainers explicitly advise staying on the latest version until 1.0 because breaking changes land routinely — which is exactly how a one-year pause turned 0.11.2 into eight versions of archaeology. Assuming "migrate once, done" repeats the mistake. **Mitigation:** pin exactly, vendor the package in the lockfile, and schedule a quarterly bump task in the repo (a 30-minute chore beats a second archaeology dig). Also: the 2–5× 2025 perf claims I quoted are the vendor's benchmarks, not our workload — treat as hypothesis until our own profiler numbers exist.

### F8. The WASM↔JS boundary may be the real per-frame cost, not the solver **[claude]**
My delta doc assumed solver time dominates. Every `body.translation()` / `body.rotation()` call crosses the wasm-bindgen boundary and allocates; at 100 vehicles × 5 bodies × 60 Hz that's ~60k boundary crossings and allocations per second before rendering. **Mitigation:** benchmark boundary cost in the Phase 1 skeleton (one week-one task), and design the adapter to read poses in as few batched calls as the API allows. If it's ugly, this—not solver speed—decides how many vehicles per world are viable.

### F9. Worker sharding is only sound under two invariants nobody has verified **[claude]**
(a) **No inter-vehicle interaction** — believed true (BoxCar2D semantics, collision groups) but never confirmed as a rule; if you ever want vehicle–vehicle contact, sharding is off the table. (b) **Shard-invariance** — results must not depend on how vehicles are distributed across workers, which requires per-vehicle PRNG streams and per-world seeding; a shared RNG consumed in scheduling order silently breaks replay. **Mitigation:** write both invariants into the architecture doc; CI test = same seed, 1 worker vs. 4 workers, identical fitness vector. Feeds **D1** (interaction question) and **D7**.

### F10. CI will test a build users don't run **[claude]**
The determinism tests must run on the deterministic flavor; the shipped default is the fast, non-deterministic flavor. If CI only exercises one, the other rots. **Mitigation:** CI matrix runs both flavors — exact-hash assertions on deterministic, statistical thresholds (e.g., fall-through rate, explosion rate over 1,000 spawns) on default. Physics tests without fixed seeds are flake generators; every test declares its seed.

---

## 3. MEDIUM findings — real, but bounded

- **F11. Fitness = distance converges to monster trucks. [brief]** Big wheels + max torque wins early and evolution flatlines — this is BoxCar2D's own known failure mode, so "mirroring" includes mirroring its boringness. Countermeasures (stability scoring, efficiency terms, speciation) all *deviate* from the mirror constraint. Flag for a post-MVP decision rather than smuggling my Phase 6 fitness ideas in as if they were spec.
- **F12. 1-wheel (and most 3-wheel) morphologies are dead weight in 3D. [brief]** Statically unstable without control; in a corridor they mostly die instantly, wasting population slots. Cheap mitigation: keep 1–4 per spec (re-pin from the 1–6 drift) but let the initializer bias toward viable configs; evolution can still discover the weird ones.
- **F13. Heightfields can't express everything the level design wants. [claude]** No overhangs, no undersides of ramps; "gaps" require either explicit hole support (verify) or composite terrain (heightfield + cuboid ramps/bridges). Fine — but the terrain generator API should assume *composite* from day one so obstacles aren't bolted on later.
- **F14. Post-sharding, rendering becomes the bottleneck. [build]** Per-vehicle meshes with shadows won't scale to the populations workers enable. Pull `InstancedMesh` forward from "polish" into Phase 1's render skeleton — cheap now, painful later.
- **F15. Per-generation teardown may be the wrong lifecycle. [claude]** My plan assumed "remove all bodies, reuse world." A fresh `World` per generation (per worker) is leak-proof by construction, determinism-friendly, and possibly faster than mass removal. Benchmark both in week one; pick with data.
- **F16. Direct fixed-length gene encoding has known GA pathologies. [build]** Crossover on raw vertex/wheel arrays breaks building blocks (competing conventions); chassis vertex genes can produce degenerate/self-intersecting hulls needing repair. Not urgent — but the gene adapter (Phase 1 step 7) should normalize/repair genotypes, and the schema doc should say *why*.

---

## 4. Decision queue

| # | Decision | Options | Red-team recommendation |
|---|---|---|---|
| **D1** | Product identity | 2.5D corridor (walls, no steering) vs. open 3D (+steering genes) | **Corridor**, chosen explicitly; revisit steering as a post-MVP mode |
| **D2** | Terrain stationarity | fixed-per-run / fixed-per-N-gens / curriculum | **Fixed-per-run**, seed-encoded (BoxCar2D-faithful) |
| **D3** | Accuracy constraint vs. Backend R | J canonical + R as labeled "turbo" / amend the constraint / drop R | **J canonical, R as labeled toggle** |
| **D4** | Cannon parallel path | keep behind flag / delete now | **Delete now**; git is the rollback |
| **D5** | Sim-time purity rule | — | Adopt (not really optional); CI-enforced per F3 |
| **D6** | Wheel count | re-pin 1–4 per brief / keep 1–6 drift | **Re-pin 1–4** |
| **D7** | Determinism scope | cross-platform seeds (deterministic PRNG + no library trig in gen) / same-machine replay only | Your call — cross-platform is ~2 extra days of plumbing; decide before terrain gen is written |

## 5. Process findings

- **F17. The rewrite loop was structural, not accidental.** Five-plus full rebuilds in the project history were partly an artifact of the single-artifact workflow: no diffs, no tests, no branches — every "improve on the previous attempt" became a rewrite. Shape 2 (repo + tests + CI) is the mitigation already chosen; the discipline that makes it stick is *incremental commits gated by the test suite*, never regenerate-from-scratch.
- **F18. Physics was treated as the critical path; the GA design questions actually are.** D1, D2, and D7 change the gene schema and terrain generator; the physics port is mechanical by comparison. **Re-sequencing recommendation:** insert a short "Phase 0.5 — design rulings" (the D-queue) before any wheel/vehicle code. Terrain heightfield, chassis drop tests, and the repo scaffold are unaffected by the D-queue and can proceed immediately in parallel.

---

*Cross-references: Phase 0 audit (2025), Phase 0 Refresh / Migration Delta incl. Amendment A (2026-07-08).*
