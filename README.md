# BoxCar3D

Evolving 3D vehicles in a corridor world — a genetic-algorithm sandbox inspired
by BoxCar2D. Vehicles drive forward only (no steering, no AI) through
procedurally generated 3D terrain with elevations, craters, obstacles, and
surface types, bounded by physical walls. Morphology is the point: evolving
frames, multiple suspension types, and free wheel arrangements.

**Status:** Phase 1, the S0 kernel landed — vehicles drive. A repaired,
all-S0 assembly IR now realizes through Rapier's native path: one dynamic
cylinder body per wheel, one chassis-to-wheel revolute joint on the lateral
axis, and real joint motors (`realizeS0Vehicle` in the adapter — validation
all before world mutation, S1/S2 axles rejected at realization while staying
legal IR data, transactional cleanup proven by induced mid-construction
failures). The motor ruling is measured, not assumed: ForceBased with a gain
conversion (`gain = driveTorque / |targetAngvel|`) so `driveTorque` is a
literal stall-torque budget falling linearly to zero at the target speed —
an airborne discriminator shows AccelerationBased normalizes wheel inertia
away (ω ratio 1.000 vs the physical 4.86) and is rejected. Wheel bodies
share the chassis' base rotation (Rapier's revolute axis is interpreted in
each body's local frame) with the Y→Z rotation on the collider only, so the
kernel works at any spawn yaw. A both-flavors forward-drive witness on a
declared 80 m flat-pad terrain proves the mechanism: driven +19.4 m in 10 s,
undriven twin stays put, reversed target drives −X; the R5 residual-overlap
case realizes and stays stable. `npm run dev` now drives a declared all-S0
vehicle ~46 m into the composite corridor, cylinder wheels rendered from the
same IR dims the colliders use (add `?zones` to tint the zone map). All
locked fingerprints byte-identical. Next is S1 vertical spring-damper
suspension (re-locking the provisional suspension gene ranges); zone
material response, S2, and the GA land in their own later PRs. The design
docs in `docs/` define everything that comes after.

## Quickstart

```bash
npm install
npm run dev      # corridor terrain scene at http://localhost:5173
npm test         # PRNG determinism + headless Rapier (both flavors)
npm run lint     # includes the determinism ban on src/sim
npm run build    # production bundle in dist/
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
