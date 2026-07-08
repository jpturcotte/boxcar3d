# Legacy salvage inventory (private repo snapshot, 2025-08-30)

Recovered from the user's private `boxcar3d` repo — a Vite + Rapier migration
started in August 2025 via a brief to a coding agent ("Jules", see
`README-2025-08-jules-brief.md`), which reached a heightfield terrain and one
integration test before stalling. Files here are **read-only reference**; the
live code never imports from `legacy/`.

## What it validates (no plan changes)

Three independent convergences with the current plan: **Rapier** (`rapier3d-compat
^0.18.2`), **Vite + Vitest**, and a **heightfield** terrain
(`TerrainFactory.js`). The fall-through integration test (`Terrain.test.js`)
is the direct ancestor of our 1,000-spawn CI gate — carry the intent, fix the
flaws (it spawns with unseeded `Math.random()` and asserts only 20 spheres
over 100 steps).

## Adopted into the scaffold

- **License:** Apache-2.0 (root `LICENSE`), as chosen in the private repo.
- **Genotype convention:** all genes normalized to [0, 1], clamped on
  mutation; mapping tables do the physical scaling. Keep this in the new
  assembly-compiler schema — it makes crossover/mutation uniform and ranges
  auditable in one place.
- **Recovered gene mappings** (from `boxcar3d-improved.html`):
  wheel radius `g*0.5 + 0.2` (⇒ 0.2–0.7 m) · wheel posX/posZ `(g−0.5)*3`
  (⇒ ±1.5 m) · motor power `g*500` · wheel count `floor(g*maxWheels)+1` ·
  chassis vertex length `g*2 + 0.5` (⇒ 0.5–2.5 m) · gene[0] = hue.
- **Tuned defaults** (`params`, line ~381): populationSize 20 ·
  mutationRate 0.05 · eliteCount 2 · **maxWheels 4** (the brief's 1–4 lived
  here; today superseded by ruling O1 unlimited-with-cap) ·
  **gravity 20** — double Earth gravity was a deliberate feel choice; the new
  adapter defaults to it (configurable).
- **Motor model mapping:** legacy targets ~10 rad/s wheel angular velocity,
  scaled by motorPower/500 ⇒ in Rapier: `configureMotorVelocity(targetVel,
  factor)` with power mapping to the torque factor.

## Evidence appendix (red-team findings, now with line numbers)

- **F3 (wall-clock in fitness) — confirmed:** `age += deltaTime` and
  `stuckTime += deltaTime` where `deltaTime` is a `performance.now()` frame
  delta (lines ~578, ~610, ~966).
- **NEW sub-finding — time scale altered the physics:** wheel angular
  velocity is multiplied by `params.timeScale` (line ~585), so 2× time scale
  spun wheels twice as fast per *simulated* second. Evolution under different
  time scales selected different vehicles. Hence the strengthened rule: time
  scale is *more fixed steps per frame*, and never appears inside any force,
  velocity, or fitness expression.
- **F4 (JS trig nondeterminism) — present in the newest terrain code:**
  `TerrainFactory.js` builds heights from `Math.sin`/`Math.cos`, exactly the
  cross-browser seed-sharing hazard D7 bans; the replacement is hash-based
  noise from `src/sim/prng.js`.
- **Heightfield precedent for [V1]:** legacy used `nrows=50, ncols=200,
  scale=(200, 5, 500)`; the row/column-to-axis mapping was never tested —
  the [V1] known-peak layout test remains mandatory before terrain work.
