# bench:physics — named reference-machine report

> **Committed reference run — machine-specific, NOT a universal package
> property.** Regenerate on your own hardware with `npm run bench:physics`;
> this file is a labelled snapshot, not a threshold. It is NOT asserted by any
> test (the only CI touchpoint is the schema smoke in
> `tests/bench-schema.test.js`).
>
> **Reference machine:** Intel Core i7-14650HX (×24), Windows 11, Node
> v22.19.0, `@dimforge/rapier3d[-deterministic]-compat` 0.19.3. Run of
> 2026-07-11 (report UTC 2026-07-12T00:14), **5 paired samples/comparison**.
>
> **Methodology (both review amendments applied):**
> - **Real composite principal terrain.** The principal workload runs a
>   benchmark-owned composite corridor (seed 20260718, 20 m flat start pad,
>   craters/features/zones ON, composite from x=−34) — NOT the golden fixture
>   terrain (A and C disable composite features and would never leave their
>   flat pad). A reached-composite tooth marks any row whose vehicle failed to
>   drive onto composite ground as invalid; every row below is valid.
> - **Paired, interleaved sampling.** Every comparison runs its two arms
>   back-to-back within each sample, ALTERNATING order across samples, and
>   reports the **median of per-pair ratios** (raw arm medians preserved).
>   This cancels the slow run-order drift that made the previous unpaired run
>   report the deterministic flavor as *faster* than default on flat ground
>   (a pure artifact) — see the tightened, consistent ratios below.
>
> **Reading of the tables (physics cost only — an explicit render-budget
> caveat applies; this PR does not benchmark rendering):**
> - **Deterministic tax** (Det÷Def, paired): **≈1.0–1.13×** across the whole
>   matrix on BOTH composite (0.98–1.13×) and flat (1.00–1.10×) terrain. The
>   paired method removed the earlier unpaired run's spurious "faster on flat"
>   (0.77–0.87×) artifact; the honest tax is a small, consistent ~1.0–1.13×.
>   Conclusion: the deterministic flavor is affordable as the canonical eval
>   backend.
> - **Trace-instrument (digest) overhead** (paired): **1.05–1.07×** — tight
>   and negligible; the determinism instrument is essentially free at the
>   stepping scale.
> - **Profiler overhead** (paired): ~0.98–1.03× — within run-to-run noise;
>   enabling the profiler does not materially slow stepping. Its
>   `timingStep()` medians (INTERNAL PROFILED STEP TIME, not wall clock) track
>   the external per-step means.
> - **Maximum-topology cost — flat vs composite distinguished** (fixture C,
>   25 bodies / 24 joints per vehicle): at 50 vehicles, ≈**20.8 ms/step**
>   (composite, default) vs ≈**29.2 ms/step** (flat control); at 100 vehicles
>   ≈**80 ms** (composite) vs ≈**92 ms** (flat). Note the flat number is
>   HIGHER: on flat ground the vehicles stay maximally active (driving,
>   continuous contacts) for all 600 steps, whereas on composite they slow
>   against terrain, so structural cost — not terrain complexity — dominates,
>   and a fully-active fleet is the true worst case. The 50-vehicle/60-FPS
>   goal (16.7 ms/step budget) is comfortably met by ordinary fixtures (A/B at
>   50 vehicles ≈3.0–3.7 ms/step) but NOT by 50 worst-case max-topology
>   vehicles on either terrain — an input for worker-sharding and
>   population-composition work, recorded, not remediated here.

Generated 2026-07-12T00:14:47.364Z on win32/x64 (Intel(R) Core(TM) i7-14650HX ×24), Node v22.19.0, rapier 0.19.3.
Sampling: paired + interleaved (arms run back-to-back per sample, order alternated); reported ratio = median of per-pair ratios; 5 samples/comparison; warm-up 60 steps discarded per flavor×fixture; row budget 900000 ms.
Principal workload = composite corridor (seed 20260718, composite start x=-34); control = flat corridor. All wall numbers are external monotonic timing with the profiler OFF unless a table says otherwise — machine-specific, never a universal package property.

## Canonical affordability — composite corridor (profile off, trace none)

Every vehicle drives onto composite terrain (the reached-composite tooth marks any row that does not as invalid). Det÷Def is the median of per-pair ratios (default and deterministic arms run back-to-back, order alternated).

| Flavor | Fixture | Vehicles | Bodies/Joints | Init ms | Terrain ms | Realize ms | Step total ms | Step mean ms | Veh-steps/s | Det÷Def (paired) | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| default | A | 1 | 5/4 | 3.62 | 0.95 | 0.21 | 31.91 | 0.0532 | 18805 |  | ok |
| deterministic | A | 1 | 5/4 | 3.92 | 0.89 | 0.19 | 35.21 | 0.0587 | 17038 | 1.10× | ok |
| default | A | 20 | 100/80 | 3.86 | 0.69 | 1.83 | 632.25 | 1.0538 | 18980 |  | ok |
| deterministic | A | 20 | 100/80 | 4.11 | 0.74 | 1.67 | 712.49 | 1.1875 | 16842 | 1.09× | ok |
| default | A | 50 | 250/200 | 3.78 | 0.81 | 4.29 | 2149.16 | 3.5819 | 13959 |  | ok |
| deterministic | A | 50 | 250/200 | 4.06 | 0.94 | 4.72 | 2224.78 | 3.7080 | 13484 | 1.09× | ok |
| default | A | 100 | 500/400 | 4.02 | 0.78 | 7.12 | 5862.87 | 9.7715 | 10234 |  | ok |
| deterministic | A | 100 | 500/400 | 3.87 | 0.85 | 7.17 | 6134.69 | 10.2245 | 9780 | 1.03× | ok |
| default | B | 1 | 7/6 | 3.73 | 0.64 | 0.19 | 37.67 | 0.0419 | 23892 |  | ok |
| deterministic | B | 1 | 7/6 | 3.63 | 0.65 | 0.19 | 37.09 | 0.0412 | 24266 | 0.98× | ok |
| default | B | 20 | 140/120 | 3.82 | 0.68 | 1.55 | 827.52 | 0.9195 | 21752 |  | ok |
| deterministic | B | 20 | 140/120 | 3.72 | 0.76 | 1.51 | 887.19 | 0.9858 | 20289 | 1.08× | ok |
| default | B | 50 | 350/300 | 3.92 | 0.72 | 3.85 | 2737.95 | 3.0422 | 16436 |  | ok |
| deterministic | B | 50 | 350/300 | 3.79 | 0.75 | 3.93 | 2835.31 | 3.1503 | 15871 | 1.01× | ok |
| default | B | 100 | 700/600 | 4.15 | 0.82 | 7.95 | 8832.82 | 9.8142 | 10189 |  | ok |
| deterministic | B | 100 | 700/600 | 4.16 | 0.74 | 6.63 | 8850.51 | 9.8339 | 10169 | 1.00× | ok |
| default | C | 1 | 25/24 | 3.83 | 0.57 | 0.28 | 121.38 | 0.2023 | 4943 |  | ok |
| deterministic | C | 1 | 25/24 | 3.77 | 0.67 | 0.26 | 130.57 | 0.2176 | 4595 | 1.08× | ok |
| default | C | 20 | 500/480 | 3.85 | 0.76 | 5.30 | 3261.32 | 5.4355 | 3679 |  | ok |
| deterministic | C | 20 | 500/480 | 3.83 | 0.74 | 4.03 | 3642.04 | 6.0701 | 3295 | 1.08× | ok |
| default | C | 50 | 1250/1200 | 4.09 | 0.80 | 13.20 | 12458.75 | 20.7646 | 2408 |  | ok |
| deterministic | C | 50 | 1250/1200 | 3.96 | 1.71 | 12.13 | 13821.85 | 23.0364 | 2170 | 1.13× | ok |
| default | C | 100 | 2500/2400 | 4.03 | 1.01 | 23.52 | 48123.31 | 80.2055 | 1247 |  | ok |
| deterministic | C | 100 | 2500/2400 | 4.55 | 0.92 | 26.62 | 49978.36 | 83.2973 | 1201 | 1.00× | ok |

## Control — flat corridor (terrain-cost isolation; fixture C here is max topology on FLAT ground)

Compare fixture C here (max topology, flat) against fixture C in the composite table above (max topology, composite) to separate structural cost from terrain cost.

| Flavor | Fixture | Vehicles | Bodies/Joints | Init ms | Terrain ms | Realize ms | Step total ms | Step mean ms | Veh-steps/s | Det÷Def (paired) | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| default | A | 1 | 5/4 | 3.62 | 0.15 | 0.11 | 33.93 | 0.0565 | 17684 |  | ok |
| deterministic | A | 1 | 5/4 | 3.70 | 0.18 | 0.10 | 36.61 | 0.0610 | 16388 | 1.08× | ok |
| default | A | 20 | 100/80 | 3.71 | 0.11 | 0.89 | 708.21 | 1.1804 | 16944 |  | ok |
| deterministic | A | 20 | 100/80 | 3.90 | 0.12 | 0.94 | 767.43 | 1.2790 | 15637 | 1.10× | ok |
| default | A | 50 | 250/200 | 3.59 | 0.12 | 2.09 | 2199.80 | 3.6663 | 13638 |  | ok |
| deterministic | A | 50 | 250/200 | 3.72 | 0.12 | 2.12 | 2367.11 | 3.9452 | 12674 | 1.10× | ok |
| default | A | 100 | 500/400 | 4.33 | 0.14 | 5.64 | 6566.12 | 10.9435 | 9138 |  | ok |
| deterministic | A | 100 | 500/400 | 3.93 | 0.13 | 4.17 | 8550.47 | 14.2508 | 7017 | 1.08× | ok |
| default | C | 1 | 25/24 | 4.58 | 0.16 | 0.37 | 217.17 | 0.3620 | 2763 |  | ok |
| deterministic | C | 1 | 25/24 | 7.46 | 0.18 | 0.39 | 210.21 | 0.3504 | 2854 | 1.02× | ok |
| default | C | 20 | 500/480 | 4.86 | 0.14 | 5.17 | 4041.36 | 6.7356 | 2969 |  | ok |
| deterministic | C | 20 | 500/480 | 4.72 | 0.16 | 7.11 | 4439.70 | 7.3995 | 2703 | 1.10× | ok |
| default | C | 50 | 1250/1200 | 4.53 | 0.14 | 16.00 | 17549.10 | 29.2485 | 1709 |  | ok |
| deterministic | C | 50 | 1250/1200 | 4.81 | 0.17 | 13.81 | 17559.55 | 29.2659 | 1708 | 1.00× | ok |
| default | C | 100 | 2500/2400 | 4.51 | 0.18 | 30.11 | 55268.29 | 92.1138 | 1086 |  | ok |
| deterministic | C | 100 | 2500/2400 | 5.22 | 0.18 | 26.95 | 59087.88 | 98.4798 | 1015 | 1.06× | ok |

## Profiler diagnostic (profile ON — engine numbers are INTERNAL PROFILED STEP TIME, not wall clock)

| Flavor | Fixture | Vehicles | Engine step med ms | Engine step p90 ms | Ext step (off) ms | Ext step (on) ms | ProfOn÷Off (paired) | Status |
|---|---|---|---|---|---|---|---|---|
| default | A | 1 | 0.0504 | 0.0830 | 42.41 | 39.77 | 0.85× | ok |
| default | A | 50 | 2.9491 | 3.9174 | 1971.61 | 1934.11 | 0.98× | ok |
| default | C | 1 | 0.1857 | 0.2118 | 123.35 | 128.12 | 1.03× | ok |
| default | C | 50 | 19.2081 | 27.4014 | 12655.87 | 12792.91 | 0.99× | ok |
| deterministic | A | 1 | 0.0518 | 0.0616 | 34.15 | 33.72 | 1.00× | ok |
| deterministic | A | 50 | 3.3113 | 4.3585 | 2105.23 | 2069.32 | 0.98× | ok |
| deterministic | C | 1 | 0.2036 | 0.2359 | 138.16 | 140.56 | 1.01× | ok |
| deterministic | C | 50 | 19.4497 | 28.0272 | 13589.79 | 12874.74 | 1.00× | ok |

## Trace-instrument overhead (profile off; none vs digest, paired)

| Flavor | Fixture | Vehicles | none step ms | digest step ms | Digest÷None (paired) | Status |
|---|---|---|---|---|---|---|
| default | A | 50 | 1952.25 | 2065.19 | 1.06× | ok |
| default | C | 50 | 12471.63 | 12751.25 | 1.06× | ok |
| deterministic | A | 50 | 2116.15 | 2240.64 | 1.05× | ok |
| deterministic | C | 50 | 12238.52 | 13173.74 | 1.07× | ok |

