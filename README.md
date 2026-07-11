# BoxCar3D

Evolving 3D vehicles in a corridor world — a genetic-algorithm sandbox inspired
by BoxCar2D. Vehicles drive forward only (no steering, no AI) through
procedurally generated 3D terrain with elevations, craters, obstacles, and
surface types, bounded by physical walls. Morphology is the point: evolving
frames, multiple suspension types, and free wheel arrangements.

**Status:** Phase 1, the S1 suspension kernel landed — vehicles drive on
real springs. `realizeVehicle` in the adapter dispatches each axle
explicitly: S0 stays the rigid chassis→revolute→wheel kernel, and S1
realizes chassis → prismatic (VEHICLE-LOCAL vertical — a 180°-rolled
vehicle's suspension extends world-up, measured) → hub body → revolute →
wheel, with the spring as the prismatic's ForceBased position motor
(`configureMotorPosition(restLength, stiffness, damping)` + hard stops
`setLimits(0, travel)`; honest N/m — the isolated rig settles at
target ± m·g/k exactly, while AccelerationBased is mass-blind and
rejected). Coordinate 0 is full compression = the proven S0 wheel
position; spawns are quiescent at `clamp(restLength, 0, travel)`; preload
(rest beyond travel) and zero-travel (locked) are legal phenotypes. Hubs
are compiler-owned per-wheel IR records (mass/geometry scale with the
wheel; a small collision-inert cylinder makes mass/inertia read back at
creation — colliderless bodies read zero pre-step in 0.19.3, measured),
`ir.mass` now includes `hubsTotal`, and the IR version split from the gene
schema (ASSEMBLY_IR_VERSION 2, GENOTYPE_VERSION still 1: the calibration
matrix measured every provisional suspension range binding UNCHANGED, so
every locked fingerprint stands). The three-way rough-strip witness (seed
20260714, both flavors byte-identical) is the payoff: on 60 m of rough
fBm terrain, a mass-matched S1 vehicle cuts RMS chassis-vertical
acceleration to 0.15× its rigid S0 twin (1.29 vs 8.59 m/s²), holds
perfect wheel contact (1.00 vs 0.83), and still covers +85 m — with
travel mid-band and zero limit strikes. Transactionality now covers
joint-configuration failures (joints are ledgered before configuration);
the max legal topology (25 bodies / 24 joints) is stable under the
existing chassis solver-iteration policy; solver-pump drift is unchanged
by S1 (−0.33 m/s, recorded). `npm run dev` drives a mixed S0-front /
S1-rear vehicle ~53 m into the composite corridor with visible green
suspension struts and a live prismatic-coordinate HUD readout. Next is a
representative determinism/performance gate (S1 grew worst-case islands to
25 bodies — measure the deterministic flavor's cost before worker
sharding); zone material response, S2, and the GA land in their own later
PRs. The design docs in `docs/` define everything that comes after.

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
