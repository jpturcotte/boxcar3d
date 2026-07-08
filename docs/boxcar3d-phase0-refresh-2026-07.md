# BoxCar3D — Phase 0 Refresh (Migration Delta)

**Date:** 2026-07-08
**Supersedes:** version-specific API mappings in the original Phase 0 audit (written against `@dimforge/rapier3d-compat@0.11.2` and Three.js r128)
**Still valid from original Phase 0:** codebase audit findings, Cannon.js API inventory, regression metrics schema, port order (terrain → statics → chassis → wheels), rollback strategy, gene adapter concept

> **Amended 2026-07-08:** the "single browser file" constraint is relaxed to **"easily deployable frontend"** (user decision). See §7 for the full impact analysis; §2.1 and §3.1 should be read through that lens.

---

## 1. Version pin changes

| Library | Old pin (2025) | New target (July 2026) | Notes |
|---|---|---|---|
| three | r128, UMD `<script>` from cdnjs | **0.185.1 (r185)**, ES modules via import map | UMD script-tag builds no longer exist |
| @dimforge/rapier3d-compat | 0.11.2 (unpkg) | **0.19.3** | Several breaking releases in between; see §2 |
| rapier flavor (new) | n/a | `rapier3d-deterministic-compat@0.19.3` for replay/seed mode | See §2.1 — this is now mandatory for determinism |
| cannon.js | 0.6.2-era CDN build | Keep behind `PhysicsAdapter` flag during A/B only, then delete | cannon-es frozen at 0.20.0 (~4 years), rated Inactive |
| matter.js | PoC only | **Drop** | 2D PoC served its purpose |

---

## 2. Rapier 0.11.2 → 0.19.3: deltas that touch our port plan

### 2.1 Package flavor decision (new, important)

Since rapier.js **0.15.0**, the bindings ship in multiple flavors: `rapier3d`, `rapier3d-simd`, `rapier3d-deterministic`, each with a `-compat` variant that embeds the WASM as base64 (our single-file requirement).

⚠️ **Breaking behavioral change:** as of 0.15.0 the default `rapier3d` / `rapier3d-compat` packages are built **without** the `enhanced-determinism` feature. Our Phase 0 success criterion "deterministic replay" silently fails on the default package. Anyone relying on determinism is explicitly told to migrate to the `-deterministic` flavor.

**Decision:** make the flavor a boot-time constant in `PhysicsAdapter`:

- `rapier3d-compat` — default dev/play mode (fast, locally deterministic on one machine).
- `rapier3d-deterministic-compat` — "replay / seed-sharing" mode (cross-platform bit-exact, slower).
- `rapier3d-simd-compat` — optional "max population" demo mode (requires wasm SIMD128; effectively universal in 2026 browsers, but keep the plain build as fallback).

**Loading pattern** (replaces the 2025 Skypack/unpkg workaround):

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/",
    "rapier": "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.19.3/+esm",
    "rapier-det": "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-deterministic-compat@0.19.3/+esm"
  }
}
</script>
<script type="module">
  const RAPIER = (await import(CONFIG.deterministic ? 'rapier-det' : 'rapier')).default;
  await RAPIER.init();
  // ...boot
</script>
```

Notes: inline module scripts with https imports still work when the file is opened via `file://`. Pin exact versions. Keep a second CDN (unpkg) as a catch-and-retry fallback — lesson learned from the Skypack outage. *(This pattern is now "Shape 1" of two viable packaging shapes — the single-file constraint was relaxed after this section was written; see §7.)*

### 2.2 Solver & contact tuning (changed)

- The legacy PGS-era APIs are **gone**: `World.numAdditionalFrictionIterations`, `switchToStandardPgsSolver`, `switchToSmallStepsPgsSolver*` were removed. The modern ("small steps") solver is the only solver. Any Phase 0 notes that mapped Cannon's `solver.iterations = 20 / tolerance = 0.0001` onto solver-switching APIs are obsolete.
- Contact softness tuning was renamed upstream (Rapier 0.20): `erp` → `contactNaturalFrequency`; `allowedLinearError` / `predictionDistance` → `normalizedAllowedLinearError` / `normalizedPredictionDistance`. → **[V5]** confirm the exact accessors exposed on `World`/`IntegrationParameters` in the JS API at port time.
- Start with defaults (`world.numSolverIterations` at its default of 4) before tuning; the modern solver is far more stable than what the 2025 plan assumed. For the chassis (our most explosion-prone body), use per-body additional solver iterations → **[V2]** confirm API name (`RigidBodyDesc.setAdditionalSolverIterations` or similar).

### 2.3 Stepping model (porting item, unchanged API but different responsibility)

Cannon's `world.step(fixedTimeStep, deltaTime, maxSubSteps)` did sub-stepping for us. Rapier does not: we own the accumulator.

```js
world.timestep = 1/60;
// per frame: accumulate dt, while (acc >= 1/60) { world.step(eventQueue); acc -= 1/60 }
```

This also cleanly enables the "3× time scale" success criterion (run more fixed steps per frame) and is a prerequisite for deterministic replay (never step with variable dt).

### 2.4 Performance & lifecycle wins that map onto our bottlenecks

All of these landed after our 0.11.2 pin and directly serve the 50-vehicles-at-60-FPS goal:

- **Fully reworked broad-phase** (Rapier 0.27): large-scene perf gain; no per-frame rebuild of the acceleration structure.
- **CCD + modification perf** (Rapier 0.28): faster when CCD is active (all our chassis) and when colliders/bodies are modified — our GA rebuilds the entire population every generation.
- **Many-contacts perf** (Rapier 0.29): piles of vehicles on terrain = exactly this workload.
- **Crash fix:** removing colliders in insertion order used to crash — our per-generation teardown loop does precisely this. Another reason 0.11.2 was a landmine.
- **`RAPIER.reserveMemory(...)`**: pre-allocate before spawning a generation to avoid WASM heap growth stalls mid-run.
- **Built-in profiler:** `world.profilerEnabled = true` + `World.timing*` getters → wire directly into the Phase 0 metrics schema (`physicsStepMs` no longer needs manual `performance.now()` bracketing).
- Minor rename: `RigidBody.invPrincipalInertiaSqrt` → `invPrincipalInertia` (now returns the actual inverse inertia, not its square root) — only relevant if debug overlays read inertia.

### 2.5 Cannon → Rapier API mapping (refreshed for 0.19.3)

| Cannon.js (current code) | Rapier 0.19.3 target |
|---|---|
| `new CANNON.World(); world.gravity.set(...)` | `await RAPIER.init(); new RAPIER.World({x,y,z})` |
| `world.step(fixed, dt, maxSub)` | own accumulator + `world.step(eventQueue)` (§2.3) |
| `world.add/remove(body)` | `world.createRigidBody(desc)` / `world.removeRigidBody(rb)` |
| `world.addConstraint(c)` | `world.createImpulseJoint(JointData..., b1, b2, true)` |
| `new CANNON.Body({mass, position, ...})` | `RigidBodyDesc.dynamic().setTranslation(x,y,z)`; mass via collider density or `setAdditionalMass` |
| `type: CANNON.Body.STATIC` | `RigidBodyDesc.fixed()` |
| `body.addShape(shape, offset)` | one `world.createCollider(desc, rb)` per shape; offset via `ColliderDesc.setTranslation` |
| `CANNON.Box(halfExtents)` | `ColliderDesc.cuboid(hx, hy, hz)` |
| `CANNON.Sphere(r)` (wheels) | `ColliderDesc.ball(r)` — or upgrade wheels to `cylinder`/`roundCylinder` for honest rolling contact |
| terrain: 200+ boxes | `ColliderDesc.heightfield(nrows, ncols, heights, scale)` → **[V1]** verify row/column-major layout with a known-peak unit test before anything else |
| `material` / `defaultContactMaterial` | per-collider `setFriction` / `setRestitution` (+ combine rules) |
| `collisionFilterGroup/Mask` | `setCollisionGroups((membership << 16) \| filter)` — 16-bit halves packed into one u32 |
| `allowSleep`, `sleepSpeedLimit`, ... | `RigidBodyDesc.setCanSleep(bool)` (thresholds are engine-managed) |
| `linearDamping` / `angularDamping` | `setLinearDamping` / `setAngularDamping` |
| `PointToPointConstraint` (wheel attach) | dual joints per wheel: `JointData.revolute` (axle+motor) + `JointData.prismatic` (suspension) — per original plan |
| motor hack: `wheel.angularVelocity.set(...)` | `revolute.configureMotorVelocity(targetVel, factor)` — a real torque-limited motor |
| suspension spring (didn't exist) | prismatic `configureMotorPosition(target, stiffness, damping)` + `setLimits(min,max)` → **[V4]** confirm signature |
| reads: `body.position/quaternion` | `rb.translation()` / `rb.rotation()` (copy into THREE.Vector3/Quaternion each frame) |
| contact detection (collide events) | colliders opt in via `ActiveEvents.COLLISION_EVENTS`; drain `EventQueue` after each step |

If any obstacle still needs a trimesh, note that trimesh flags for fixing internal-edge (ghost) collisions were added post-0.13 → **[V6]**; heightfield remains the preferred terrain path regardless.

### 2.6 NEW: vehicle backend A/B — joints vs. built-in vehicle controller

Rapier's JS API now ships `DynamicRayCastVehicleController` (added around 0.12, after our pin): a raycast-wheel vehicle model with per-wheel suspension stiffness/damping/rest-length, engine force, and friction parameters. **[V3]** confirm current parameter names.

Implement both behind the adapter and let the metrics decide:

- **Backend J (joints)** — the original plan. Wheels are real rigid bodies; morphology is fully physical (wheel–obstacle and wheel–wheel contact, flipped vehicles behave honestly). Cost: ~5 bodies + 8 joints per 4-wheel vehicle. Genes map to joint motor/limit params.
- **Backend R (raycast controller)** — 1 rigid body per vehicle; suspension genes map directly onto controller params; joint explosions are impossible by construction. Cost: wheels are virtual (no wheel-as-body contact), so the fitness landscape differs from BoxCar2D's spirit.

**Decision protocol:** identical seeds + terrain, 30 generations each, compare `fellThroughTerrain`, `jointFailures` (J only), `physicsStepMs` at 20/50/100 vehicles, and best-fitness curves. Expected outcome: R wins raw perf, J wins evolutionary interestingness — if so, ship both as a user-facing "physics fidelity" toggle, since the gene schema can target either.

---

## 3. Three.js r128 → r185: deltas that touch our file

### 3.1 Loading
UMD script-tag builds (`three.min.js`) were removed from the library years ago (~r160); r185 is ES-modules-only. Use the import map from §2.1. No bundler needed; single-file + `file://` still works because imports resolve to https CDN URLs.

### 3.2 Appearance changes to expect (will hit us on first run)
- **Color management is on by default** (since r152) and `outputEncoding` was replaced by `outputColorSpace` (default `SRGBColorSpace`). Our hex palette (`0x87CEEB` sky, `0x4a7c4a` terrain, fitness color-coding) will shift slightly — review, don't panic-tune.
- **Physically correct lighting is the default** (legacy lighting mode removed): point/spot intensities are now physical (candela, `decay = 2`). Expect to retune `AmbientLight`/`DirectionalLight`/any `PointLight` intensities once, then lock them.

### 3.3 Renderer strategy
Keep `WebGLRenderer` for Phase 1 — don't stack a renderer migration on top of a physics migration. `WebGPURenderer` has been zero-config with automatic WebGL 2 fallback since r171; revisit it in the performance phase together with `InstancedMesh` for chassis/wheels (the biggest render win for 50–100 vehicles).

### 3.4 Audit of APIs our code actually uses
`PerspectiveCamera`, `Scene`, `Fog`, `MeshLambertMaterial`, `BufferGeometry` position-attribute editing, `computeVertexNormals`, shadow-map settings (`PCFSoftShadowMap`) — all unchanged and fine on r185. Optional modernization: replace the manual `requestAnimationFrame` loop with `renderer.setAnimationLoop`.

---

## 4. Risk matrix — delta rows only

| Component | 2025 rating | 2026 rating | Why it changed |
|---|---|---|---|
| Terrain collision | CRITICAL | CRITICAL (plan unchanged) | Heightfield-first still the fix; add [V1] layout test; reworked broad-phase reduces perf risk |
| Joint stability | HIGH | **MEDIUM** | Modern solver is default and only; per-body extra iterations; Backend R eliminates the failure class entirely |
| Async loading | HIGH | **MEDIUM** | Pattern is now standard; -compat embeds WASM; pinned versions + CDN fallback chain |
| Determinism (NEW) | — | **HIGH if ignored** | Default package no longer deterministic since 0.15.0 → use `-deterministic-compat` for replay mode + bit-exact CI test |
| Visual regression (NEW) | — | LOW | r152/r155 color & lighting defaults; one-time retune + reference screenshot |
| Memory management | MEDIUM | MEDIUM→LOW | Collider-removal crash fixed upstream; `reserveMemory` before each generation |

---

## 5. Success criteria — updates

1. Zero vehicles through terrain over 1,000 spawns — **unchanged**.
2. 50+ vehicles at 60 FPS (baseline was ~20) — **unchanged**, now with `World.timing*` as the measurement source.
3. Stable at 3× time scale — **unchanged**, enabled cleanly by §2.3.
4. Replay determinism — **tightened**: bit-exact across runs *and platforms* under `rapier3d-deterministic-compat` (was: "within floating-point tolerance"). New sub-task: measure the deterministic build's step-time tax vs. the default build and record it in the metrics.

---

## 6. Phase 1 kickoff checklist (ordered)

1. Scaffold the new single-file skeleton: import map (§2.1), async boot, `PhysicsAdapter` with `{engine: cannon|rapier}` × `{vehicles: joints|raycast}` flags.
2. Port the test framework first (standing project rule) and wire `world.profilerEnabled` timings into the metrics schema.
3. Heightfield terrain + **[V1]** known-peak layout test + safety plane at y = −50; enable CCD on chassis bodies.
4. Static obstacles + collision groups (`0x0001` ground, `0x0002` chassis, `0x0004` wheels).
5. Chassis-only drop test → run the 1,000-spawn fall-through criterion before any wheels exist.
6. Backend J (dual joints), then Backend R (vehicle controller); A/B harness on fixed seeds (§2.6).
7. Gene adapter layer (25-gene legacy → extended schema) — unchanged from original Phase 0.
8. Determinism smoke test: same seed, two runs, hash the per-step chassis transforms; must match bit-exact under the deterministic flavor.

### Open verifications
- **[V1]** Heightfield `heights` memory layout (row- vs column-major) — unit test with a single known peak.
- **[V2]** Per-body additional solver iterations API name.
- **[V3]** `DynamicRayCastVehicleController` current parameter names/signatures.
- **[V4]** Prismatic `configureMotorPosition(target, stiffness, damping)` signature for suspension springs.
- **[V5]** JS accessors for `contactNaturalFrequency` / normalized error params.
- **[V6]** Trimesh internal-edge flags availability (only if trimesh obstacles are kept).

---

## 7. Amendment A — constraint change (2026-07-08): "single file" → "easily deployable frontend"

**Working definition:** static-hostable output with no server-side runtime, deployable in one step to GitHub Pages / Netlify / Vercel / itch.io. A build step is acceptable when CI runs it automatically.

### A.1 Two viable packaging shapes

- **Shape 1 — no-build static folder.** `index.html` + ES-module source files + the §2.1 import map for CDN dependencies. Deploy = upload the folder. Near-zero toolchain; closest to the current workflow.
- **Shape 2 — Vite + Vitest + CI (recommended).** npm-pinned dependencies with a lockfile, dev server with hot reload, minified production bundle, and deployment via GitHub Actions → Pages (or Netlify/Vercel auto-build). Buys three things Shape 1 can't: real dependency pinning, proper `.wasm` asset handling — we can drop the `-compat` base64 flavor for the default build (smaller payload, streaming instantiation) → **[V7]** confirm the deterministic flavor also works un-embedded under Vite — and above all a real test runner.

### A.2 New capabilities unlocked (either shape)

- **Web Worker physics sharding — the big one.** If inter-vehicle collision stays off (BoxCar2D semantics: vehicles are ghosts to each other — **confirm this**, since we've always simulated the whole population simultaneously), the population partitions cleanly across N workers, each owning an independent Rapier world, merging results via `postMessage`. Near-linear speedup with cores, no SharedArrayBuffer and therefore no COOP/COEP headers needed — GitHub Pages stays viable. Success criterion #2 (50+ vehicles @ 60 FPS) becomes a floor, not a target.
- **Headless testing in CI.** The 1,000-spawn fall-through criterion and the determinism hash test become Vitest jobs running in Node on every commit, instead of manual browser rituals — this finally gives the standing "tests first" rule real teeth. **[V8]** confirm the chosen Rapier package runs cleanly headless in Node 20+.
- **Code splitting.** GA / physics adapter / rendering / test framework become separate modules; the 5,000-line single-artifact era ends.

### A.3 Impact on earlier sections

- §2.1 loading: import map stays for Shape 1; Shape 2 imports from npm. The flavor strategy (default vs. deterministic vs. simd) is unchanged.
- §4 risk matrix: *Async loading* drops MEDIUM → **LOW** under Shape 2 (bundled deps, no runtime CDN dependency). New one-time cost: toolchain/CI setup.
- Box3D watch item: two of its browser blockers soften (no more single-file WASM inlining; COOP/COEP headers are trivial on Netlify/Vercel/Cloudflare Pages if a threaded build ever matters). The primary blocker — no JS bindings exist — is unchanged, so the recommendation stands.
- Phase 1 checklist step 1 becomes: scaffold the repo (Vite vanilla template) or static folder, per the A.4 decision; everything downstream is unaffected.

### A.4 Decision record

**Shape 1 vs. Shape 2 — DECIDED 2026-07-08: Shape 2** (Vite + Vitest + GitHub Actions CI), on the strength of CI-gated physics tests and clean wasm/worker handling. Phase 1 step 1 = repo scaffold from the Vite vanilla template.

---

## 8. References

- rapier.js changelog: https://github.com/dimforge/rapier.js/blob/master/CHANGELOG.md
- Rapier npm package flavors (simd / deterministic / compat): https://www.npmjs.com/package/@dimforge/rapier3d
- Dimforge 2025 review & 2026 goals (perf work, SIMD packages): https://dimforge.com/blog/2026/01/09/the-year-2025-in-dimforge/
- Upstream renames (erp → contactNaturalFrequency, normalized params): https://github.com/pmndrs/react-three-rapier/releases
- Three.js migration guide (per-release breaking changes): https://github.com/mrdoob/three.js/wiki/Migration-Guide
- Three.js current release: https://www.npmjs.com/package/three
- WebGPU zero-config since r171: https://www.utsubo.com/blog/threejs-2026-what-changed
- Watch item — Box3D (reevaluate when a compat-style JS/WASM package appears): https://github.com/erincatto/box3d
