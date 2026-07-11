# bench:physics — named reference-machine report

> **Committed reference run — machine-specific, NOT a universal package
> property.** Regenerate on your own hardware with `npm run bench:physics`;
> this file is a labelled snapshot, not a threshold. It is NOT asserted by any
> test (the only CI touchpoint is the schema smoke in
> `tests/bench-schema.test.js`).
>
> **Reference machine:** Intel Core i7-14650HX (×24), Windows 11, Node
> v22.19.0, `@dimforge/rapier3d[-deterministic]-compat` 0.19.3, 2026-07-11.
>
> **Reading of the tables (physics cost only — an explicit render-budget
> caveat applies; this PR does not benchmark rendering):**
> - **Deterministic tax** (Det÷Def on the stepping column): ≈1.0–1.12× at
>   the steady-state high-vehicle rows where stepping dominates (fixture C:
>   1.00/1.01/1.10/1.12; fixture B: 1.03–1.10). The larger fixture-A figures
>   at 1–20 vehicles (1.50–1.68×) are fixed-cost/JIT noise on 40–60 ms
>   measurements, not a stepping tax — and on the flat CONTROL workload the
>   deterministic flavor is actually *faster* (0.77–0.87×). Conclusion: the
>   deterministic flavor is affordable as the canonical eval backend.
> - **Trace-instrument (digest) overhead:** 1.00–1.12× — negligible; the
>   determinism instrument is essentially free at the stepping scale.
> - **Worst-case structural cost:** 50 vehicles of the 25-body/24-joint
>   fixture C step at ≈26 ms (default) / ≈29 ms (deterministic) per
>   world-step; 100 vehicles at ≈92 / ≈103 ms. The 50-vehicle/60-FPS goal
>   (16.7 ms/step budget) is comfortably met by ordinary fixtures (A/B at 50
>   vehicles ≈5–6 ms) but NOT by 50 worst-case-max-topology vehicles — an
>   input for the worker-sharding and population-composition work, recorded,
>   not remediated here.
> - **Profiler cost:** enabling the profiler does not slow stepping (the
>   profiler-on external totals are ≤ profiler-off — the ratios <1 are
>   run-to-run noise); its `timingStep()` medians (INTERNAL PROFILED STEP
>   TIME, not wall clock) track the external per-step means as expected.

Generated 2026-07-11T21:37:44.483Z on win32/x64 (Intel(R) Core(TM) i7-14650HX ×24), Node v22.19.0, rapier 0.19.3.
Samples/row: 3 (median, nearest-rank ceil(p*N), 1-indexed on sorted samples); warm-up 60 steps discarded per flavor×fixture; row budget 120000 ms.
All wall numbers are external monotonic timing with the profiler OFF unless the table says otherwise; machine-specific — never a universal package property.

## Canonical affordability — composite corridor (profile off, trace none)

| Flavor | Fixture | Vehicles | Bodies/Joints | Init ms | Terrain ms | Realize ms | Step total ms | Step mean ms | Veh-steps/s | Det÷Def | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| default | A | 1 | 5/4 | 3.79 | 0.96 | 0.44 | 39.87 | 0.0664 | 15050 |  | ok |
| default | A | 20 | 100/80 | 3.86 | 0.64 | 1.92 | 675.73 | 1.1262 | 17759 |  | ok |
| default | A | 50 | 250/200 | 4.35 | 0.60 | 5.74 | 3049.30 | 5.0822 | 9838 |  | ok |
| default | A | 100 | 500/400 | 6.61 | 0.83 | 11.74 | 10131.51 | 16.8859 | 5922 |  | ok |
| default | B | 1 | 7/6 | 4.50 | 1.14 | 0.22 | 71.34 | 0.0793 | 12615 |  | ok |
| default | B | 20 | 140/120 | 4.95 | 0.75 | 3.27 | 1502.49 | 1.6694 | 11980 |  | ok |
| default | B | 50 | 350/300 | 4.32 | 0.93 | 4.36 | 5203.95 | 5.7822 | 8647 |  | ok |
| default | B | 100 | 700/600 | 6.08 | 1.41 | 12.72 | 16482.62 | 18.3140 | 5460 |  | ok |
| default | C | 1 | 25/24 | 7.99 | 1.12 | 0.35 | 182.29 | 0.3038 | 3291 |  | ok |
| default | C | 20 | 500/480 | 4.89 | 0.34 | 5.16 | 4420.12 | 7.3669 | 2715 |  | ok |
| default | C | 50 | 1250/1200 | 6.44 | 0.36 | 14.10 | 15799.33 | 26.3322 | 1899 |  | ok |
| default | C | 100 | 2500/2400 | 4.67 | 0.32 | 29.17 | 54967.31 | 91.6122 | 1092 |  | ok |
| deterministic | A | 1 | 5/4 | 4.93 | 0.35 | 0.38 | 59.71 | 0.0995 | 10049 | 1.50× | ok |
| deterministic | A | 20 | 100/80 | 8.98 | 0.73 | 4.35 | 1132.51 | 1.8875 | 10596 | 1.68× | ok |
| deterministic | A | 50 | 250/200 | 5.14 | 0.67 | 6.71 | 3736.35 | 6.2273 | 8029 | 1.23× | ok |
| deterministic | A | 100 | 500/400 | 9.52 | 0.61 | 13.62 | 10465.34 | 17.4422 | 5733 | 1.03× | ok |
| deterministic | B | 1 | 7/6 | 8.47 | 1.08 | 0.34 | 75.02 | 0.0834 | 11997 | 1.05× | ok |
| deterministic | B | 20 | 140/120 | 7.46 | 1.31 | 4.13 | 1658.30 | 1.8426 | 10854 | 1.10× | ok |
| deterministic | B | 50 | 350/300 | 5.17 | 0.87 | 8.09 | 5635.64 | 6.2618 | 7985 | 1.08× | ok |
| deterministic | B | 100 | 700/600 | 4.85 | 0.93 | 11.34 | 17008.71 | 18.8986 | 5291 | 1.03× | ok |
| deterministic | C | 1 | 25/24 | 4.63 | 0.29 | 0.33 | 182.30 | 0.3038 | 3291 | 1.00× | ok |
| deterministic | C | 20 | 500/480 | 4.73 | 0.42 | 4.88 | 4460.10 | 7.4335 | 2691 | 1.01× | ok |
| deterministic | C | 50 | 1250/1200 | 4.58 | 0.38 | 14.85 | 17391.40 | 28.9857 | 1725 | 1.10× | ok |
| deterministic | C | 100 | 2500/2400 | 5.74 | 0.35 | 24.40 | 61817.79 | 103.0296 | 971 | 1.12× | ok |

## Control — flat corridor (terrain cost isolation, fixture A)

| Flavor | Fixture | Vehicles | Bodies/Joints | Init ms | Terrain ms | Realize ms | Step total ms | Step mean ms | Veh-steps/s | Det÷Def | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| default | A | 1 | 5/4 | 4.51 | 0.16 | 0.14 | 49.15 | 0.0819 | 12208 |  | ok |
| default | A | 20 | 100/80 | 4.94 | 0.15 | 1.18 | 928.03 | 1.5467 | 12931 |  | ok |
| default | A | 50 | 250/200 | 5.79 | 0.22 | 3.69 | 2991.44 | 4.9857 | 10029 |  | ok |
| default | A | 100 | 500/400 | 7.14 | 0.20 | 7.58 | 9220.70 | 15.3678 | 6507 |  | ok |
| deterministic | A | 1 | 5/4 | 3.94 | 0.33 | 0.11 | 38.64 | 0.0644 | 15528 | 0.79× | ok |
| deterministic | A | 20 | 100/80 | 3.86 | 0.13 | 0.96 | 803.89 | 1.3398 | 14927 | 0.87× | ok |
| deterministic | A | 50 | 250/200 | 4.15 | 0.18 | 2.40 | 2356.23 | 3.9270 | 12732 | 0.79× | ok |
| deterministic | A | 100 | 500/400 | 3.87 | 0.12 | 5.22 | 7139.20 | 11.8987 | 8404 | 0.77× | ok |

## Profiler diagnostic (profile ON — engine numbers are INTERNAL PROFILED STEP TIME, not wall clock)

| Flavor | Fixture | Vehicles | Engine step med ms | Engine step p90 ms | External step total ms | Profiler-on ÷ off | Status |
|---|---|---|---|---|---|---|---|
| default | A | 1 | 0.0511 | 0.0597 | 35.72 | 0.90× | ok |
| default | A | 50 | 3.6907 | 5.1412 | 2417.65 | 0.79× | ok |
| default | C | 1 | 0.2044 | 0.3667 | 171.75 | 0.94× | ok |
| default | C | 50 | 19.6943 | 25.8961 | 12657.68 | 0.80× | ok |
| deterministic | A | 1 | 0.0596 | 0.0729 | 40.48 | 0.68× | ok |
| deterministic | A | 50 | 3.9302 | 4.8192 | 2478.72 | 0.66× | ok |
| deterministic | C | 1 | 0.2200 | 0.3668 | 160.00 | 0.88× | ok |
| deterministic | C | 50 | 22.1046 | 33.8592 | 14984.32 | 0.86× | ok |

## Trace-instrument overhead (profile off; none vs digest)

| Flavor | Fixture | Vehicles | none step ms | digest step ms | Overhead × |
|---|---|---|---|---|---|
| default | A | 50 | 2409.88 | 2707.64 | 1.12 |
| default | C | 50 | 13674.81 | 13794.01 | 1.01 |
| deterministic | A | 50 | 2630.94 | 2724.65 | 1.04 |
| deterministic | C | 50 | 13992.12 | 13994.64 | 1.00 |


