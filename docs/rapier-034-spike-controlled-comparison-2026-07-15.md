# Rapier core-0.34 spike — controlled stable-vs-candidate comparison

## Provenance
| field | value |
| --- | --- |
| resolved BoxCar3D SHA (stable) | 6c05d053bd774442f4eca433a88382dd7c9f9579 |
| resolved BoxCar3D SHA (candidate) | 6c05d053bd774442f4eca433a88382dd7c9f9579 |
| upstream Rapier ref (requested) | c13133ad293ee70c7f9cec9e498eac016c362169 |
| upstream Rapier SHA (resolved) | c13133ad293ee70c7f9cec9e498eac016c362169 |
| candidate identity suffix | 0.19.3-c13133ad.0 |
| candidate wasm-pack | wasm-pack 0.13.1 |
| candidate rapierVersion() | 0.19.3-c13133ad.0 |
| stable rapierVersion() | 0.19.3 |
| candidate tarball SHA-256 (ordinary) | dc5964404b105878522beb47d40eedcedca05427f4342410d18e29045e51b243 |
| candidate tarball SHA-256 (deterministic) | 997a169e9917ca494d93e346ad4bff011bd2fe11eb0b671c11df5a0a07621416 |

## Minimum reproducer (deterministic flavor)
| arm | original class | original cat@ | original peak m/s | multibody class | multibody cat@ | multibody peak m/s |
| --- | --- | --- | --- | --- | --- | --- |
| stable | catastrophic | 46 | 5.452e+3 | quiescent | — | 1.420e+0 |
| candidate | catastrophic | 107 | 4.785e+3 | quiescent | — | 1.399e+0 |

_The verdict is the CLASSIFICATION column (catastrophic vs quiescent), not the exact peak — wasm is not byte-reproducible across environments._

## Prevalence (per population seed: catastrophic / total)
| population seed | stable cat/total | candidate cat/total | stable ids | candidate ids |
| --- | --- | --- | --- | --- |
| 20260725 | 3/20 | 3/20 | 1@52 14@88 19@60 | 1@53 14@227 19@51 |
| 20260728 | 1/20 | 1/20 | 4@56 | 4@45 |
| 20260729 | 1/20 | 1/20 | 19@62 | 19@62 |
| 20260730 | 2/20 | 2/20 | 0@76 5@45 | 0@106 5@48 |

## Unit-suite failed-test sets
- **stable:** 0 failing (all green)
- **candidate:** 11 failing across 5 files — tests/bench-schema.test.js(1), tests/evaluation-determinism.test.js(5), tests/evaluation-golden.test.js(1), tests/physics-explosion-probe-schema.test.js(1), tests/population-determinism.test.js(3)

## Determinism digests (candidate: Node vs Chromium)
| determinism assertion | Node digest | Chromium digest | agree |
| --- | --- | --- | --- |
| population:fitness-vector | ee605286 | ee605286 | yes |

_Node and Chromium agree on every extracted candidate digest (cross-env determinism holds on core 0.34)._

## `world.free()` borrow/panic scan
- **stable:** scanned 22 log(s); 0 borrow/ownership/unreachable/panic match(es).
- **candidate:** scanned 22 log(s); 1 borrow/ownership/unreachable/panic match(es):
  - witnesses.log: RuntimeError: unreachable

## Forensic witness matrix (`--witness all --pass all`) — stable GATE / candidate OBSERVE

- **stable:** witnesses exit 0 — completed the full forensic matrix cleanly.
- **candidate:** witnesses exit 1 — **CRASHED** — `RuntimeError: unreachable` (recorded Outcome-B evidence; not gated on the candidate).

## Paired bench (same-runner, alternating)
```json
{
  "order": [
    "stable#1",
    "candidate#1",
    "candidate#2",
    "stable#2"
  ],
  "status": "ok",
  "allParsed": true,
  "parsed": 4,
  "total": 4,
  "errored": 0,
  "note": "four bench runs parsed; paired ratio computed in C5"
}
```

## Verdict (classification level)
- reproducer (impulse): stable **catastrophic**, candidate **catastrophic** → SAME class (Outcome B reproduced)
- reproducer (multibody): stable **quiescent**, candidate **quiescent** _(OBSERVATIONAL — the multibody quiescence is the representation-lever finding, NOT part of the Outcome-B gate; it does not affect established/citable)_
