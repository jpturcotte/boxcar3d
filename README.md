# BoxCar3D

Evolving 3D vehicles in a corridor world — a genetic-algorithm sandbox inspired
by BoxCar2D. Vehicles drive forward only (no steering, no AI) through
procedurally generated 3D terrain with elevations, craters, obstacles, and
surface types, bounded by physical walls. Morphology is the point: evolving
frames, multiple suspension types, and free wheel arrangements.

**Status:** Phase 1, PR #10 landed. The assembly compiler + repair pass v0
turns `[0,1]` genotypes into physically sane vehicles: three frame families
(spine, ladder, convex hull), default-on bilateral symmetry with asymmetry
still expressible, axle modules carried as data, and a deterministic,
exactly-idempotent repair pass — domain-invalid genotypes fail loud,
physically invalid ones are clamped, separated, and re-seated. Compiled
chassis realize as single dynamic bodies carrying the collision-group,
dual-CCD, and per-body solver-iteration policy, and a both-flavors physics
gate proves they stay caught by the composite terrain (with negatives
proving the gate's teeth). The genome contract is locked by two fingerprints
(corpus `24cd0dd5`, chassis geometry `39bcd6c4`). `npm run dev` drops one
compiled, hue-tinted ladder chassis at the start line (add `?zones` to tint
the zone map). A pre-S0 hardening pass makes every terrain config knob fail
loud (programmatic domain sweep; seeds are canonical uint32), bans `Date`
from simulation code, and puts the dev-scene debris on the dual-CCD policy —
all locked fingerprints untouched. Next is S0: real cylinder wheels on rigid
revolute joints, a deliberately narrow kernel; S1/S2 suspension, zone
material response, and the GA land in their own later PRs. The design docs
in `docs/` define everything that comes after.

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
