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

## Land it on your existing private repo

This scaffold is designed to become the next commit of your existing private
`boxcar3d` repo (its 2025 snapshot is preserved under `legacy/`), keeping your
history:

```bash
# 1. Clone your private repo — its history stays intact throughout
git clone git@github.com:<you>/boxcar3d.git && cd boxcar3d

# 2. Clear the old working tree (files only; history is safe in .git)
git rm -rq .

# 3. Copy the scaffold in — after removing ITS bundled .git,
#    so your repo's history is never touched
rm -rf /path/to/scaffold/.git
cp -r /path/to/scaffold/. .

# 4. Commit and push
git add -A
git commit -m "v2: verified Vite+Rapier scaffold; 2025 code preserved in legacy/"
git push
```

(If you'd rather start clean, the scaffold is already an initialized repo —
just add your remote and push.) Then in the repo settings:
**Settings → Pages → Source: GitHub Actions.** Every push to `main` runs
lint + tests + build and deploys `dist/` to `https://<you>.github.io/boxcar3d/`.
The Vite base path is derived from the repo name automatically. Note: GitHub
Pages on a **private** repo requires a plan that supports it — otherwise flip
the repo to public or skip Pages and use `npm run preview` locally.

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
