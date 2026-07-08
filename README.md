# BoxCar3D

Evolving 3D vehicles in a corridor world — a genetic-algorithm sandbox inspired
by BoxCar2D. Vehicles drive forward only (no steering, no AI) through
procedurally generated 3D terrain with elevations, craters, obstacles, and
surface types, bounded by physical walls. Morphology is the point: evolving
frames, multiple suspension types, and free wheel arrangements.

**Status:** verified toolchain scaffold (Phase 1, step 1). `npm run dev` shows
a physics smoke scene; the design docs in `docs/` define everything that comes
next.

## Quickstart

```bash
npm install
npm run dev      # smoke scene at http://localhost:5173
npm test         # PRNG determinism + headless Rapier (both flavors)
npm run lint     # includes the determinism ban on src/sim
npm run build    # production bundle in dist/
```

Requires Node 20.19+ (built and verified on Node 22).

## Put it on GitHub

```bash
git remote add origin git@github.com:<you>/boxcar3d.git
git push -u origin main
```

Then in the repo settings: **Settings → Pages → Source: GitHub Actions.**
Every push to `main` runs lint + tests + build and deploys `dist/` to
`https://<you>.github.io/boxcar3d/`. The Vite base path is derived from the
repo name automatically, so renaming the repo needs no config change.

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
