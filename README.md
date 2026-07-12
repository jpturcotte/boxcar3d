# BoxCar3D

Evolving 3D vehicles in a corridor world — a genetic-algorithm sandbox inspired
by BoxCar2D. Vehicles drive forward only (no steering, no AI) through
procedurally generated 3D terrain with elevations, craters, obstacles, and
surface types, bounded by physical walls. Morphology is the point: evolving
frames, multiple suspension types, and free wheel arrangements.

**Status:** Phase 1, the per-wheel surface-speed drive law landed. The
shared −10 rad/s wheel-speed target is gone: one `targetWheelSurfaceSpeed`
(default 5 m/s) now derives every driven wheel's own no-load target from
its radius (ω = −speed/radius), so mixed-radius vehicles stop fighting
themselves over a phantom driveshaft — each wheel's exact stall torque
(its share of the stall-torque budget) and the measured ForceBased gain
ruling are unchanged (what is preserved is the stall-torque budget, not
mechanical power). All three earlier golden fixtures were deliberately re-locked
under the documented workflow (step-0 spawn states identical; divergence
enters with the first motor step; fixture A's digest even reproduced, its
target shift being below the engine's f32 state resolution), and a fourth
locked fixture — genuinely mixed 0.3 m / 0.6 m radii on the flat pad —
now pins the per-wheel law across the same environments. This built on
the deterministic-evaluation trace and physics-budget gate: one canonical
headless runner (`src/sim/evaluation.js`, wall-clock-free) owns terrain
construction, vehicle realization, the fixed-step loop, and a versioned
per-step trace of every dynamic vehicle body (pose, velocities,
sleep/validity bits — raw little-endian f64, fixed 128-byte records,
streaming FNV-1a digests with per-step checkpoint states). The declared
fixtures are golden-locked on the deterministic Rapier flavor — ordinary
S0, mixed S0/S1 on the full composite corridor (craters/features/zones
on), the maximum 25-body/24-joint all-S1 topology, and the mixed-radius
lock — and reproduce **bit-exact across Ubuntu, Windows, and macOS
(Node 22) and pinned Chromium 149** (`npm run test:determinism`,
`npm run test:browser`; the browser gate transitively proves the whole
terrain path — noise, craters, zones, feature ray-seating — identical in
Chromium). `npm run bench:physics` measures the cost baseline on a real composite
corridor with the profiler off, using paired interleaved sampling (arms
run back-to-back, order alternated, median of per-pair ratios — which
cancels the run-order noise that unpaired medians cannot): on the
reference machine (i7-14650HX, Windows 11, Node 22, 2026-07-11) the
deterministic flavor's stepping tax is a consistent **≈1.0–1.13×** on
both composite and flat terrain, the determinism-trace instrument adds
**1.05–1.07×**, and 50 vehicles of the worst-case 25-body max-topology
fixture step at ≈21 ms/step on composite (≈29 ms on flat — the fully
active flat fleet is the true worst case) — comfortably affordable for
ordinary fixtures (≈3–3.7 ms/step at 50 vehicles) but over the 60-FPS
budget for 50 max-topology vehicles. The full labelled table is in
[`docs/bench-physics-reference-2026-07-11.md`](docs/bench-physics-reference-2026-07-11.md)
(machine-specific numbers, never a package property). Measured engine findings this PR recorded: `world.timestep`
reads back `Math.fround(1/60)` (the engine stores f32); the profiler's
`timing*()` methods are per-step milliseconds gated on `profilerEnabled`;
a pose read on a removed body panics the wasm module (the runner's
validity guard is load-bearing); and no legal input produces NaN on
0.19.3 — extreme velocities stay finite or panic loud. S1's rulings
stand unchanged (springs are honest N/m; the S1 witness, hub records,
and every earlier locked fingerprint are byte-identical). Backend R is
formally dropped (O3 resolved — Backend J is the sole canonical
backend). Next: GA Phase 1a — headless deterministic evolution (the
population seeder masks `suspType` away from S2); zone material response
and S2 are deferred behind it, each in its own PR. The design docs in
`docs/` define everything that comes after.

## Quickstart

```bash
npm install
npm run dev              # corridor terrain scene at http://localhost:5173
npm test                 # full suite: PRNG/terrain locks + headless Rapier (both flavors)
npm run test:determinism # the narrow golden-lock + fresh-module determinism gate
npm run test:browser     # the Chromium gate (one-time: npx playwright install chromium)
npm run bench:physics    # the physics cost matrix (instrument; -- --smoke for a quick pass)
npm run lint             # includes the determinism ban on src/sim
npm run build            # production bundle in dist/
```

Requires Node 20.19+ (built and verified on Node 22).

## CI and deployment

Every push to `main` runs lint + tests + build; runs can also be triggered
manually from the Actions tab (**Run workflow**). Green runs deploy `dist/`
to GitHub Pages at https://jpturcotte.github.io/boxcar3d/ — the Vite base
path derives from the repo name automatically. (Pages on a private repo
requires a plan that supports it; otherwise flip the repo public, or use
`npm run dev` locally.) The 2025 prototype survives in `legacy/` and in the
repo's history, joined by the "Join histories" merge.

## Working on this with Claude Code

Open the repo folder in Claude Code — it automatically reads `CLAUDE.md` at
session start, which carries the project's hard rules (determinism, sim-time
purity, tests-first, scope walls) and points into `docs/` for the full design.
Good first prompt: *"Read CLAUDE.md and docs/, then start Phase 1 step 1:
the composite corridor terrain, [V1] layout test first."*

## Repository map

```
CLAUDE.md                 Operating manual (auto-loaded by Claude Code)
docs/                     Canonical design docs: spec v2, migration delta, red team
src/sim/                  Deterministic core — prng.js, physics adapter; Node-safe
src/render/  src/ui/      Three.js rendering and controls (wall clock allowed here)
src/workers/              Population sharding (Phase 1, later steps)
tests/                    Vitest: locked PRNG stream, Rapier smoke (both flavors)
.github/workflows/ci.yml  Lint + test + build + deploy to Pages
```

## The rules that make seeds shareable

All simulation randomness flows from one integer seed through
`src/sim/prng.js` (xoshiro128**, per-vehicle forked streams); `Math.random`
and library trig are lint-banned in simulation code; every sim clock counts
fixed physics steps. Replay/seed mode runs on Rapier's deterministic build.
The why behind each rule lives in `docs/boxcar3d-red-team-2026-07.md`.
