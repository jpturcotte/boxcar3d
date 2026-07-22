# PR3 deliberate-sabotage result

- Run date: 2026-07-22
- Command: `python scripts/adversarial/pr3-sabotage.py`
- Environment: Windows, Node 22.19.0, Python 3.13
- Result: 12/12 mutations made their targeted test suite fail; the harness
  restored each source file byte-for-byte in `finally`.

| Mutation | Target test | Verdict |
|---|---|---|
| Terminal precedence | `tests/evolution-run.test.js` | BITES |
| One extra RNG draw per child | `tests/evolution-run.test.js` | BITES |
| Child-ID order | `tests/evolution-determinism.test.js` | BITES |
| Elite lineage parent | `tests/evolution-determinism.test.js` | BITES |
| Population digest domain | `tests/evolution-history.test.js` | BITES |
| Verification order | `tests/evolution-replay.test.js` | BITES |
| Runtime version check | `tests/evolution-replay.test.js` | BITES |
| Component-length ceiling | `tests/evolution-history.test.js` | BITES |
| SHA copy-before-await | `tests/sha256.test.js` | BITES |
| Fresh history return copy | `tests/evolution-run.test.js` | BITES |
| Trace-mode-none seam | `tests/evolution-run.test.js` | BITES |
| Generation-0 chain anchor | `tests/evolution-determinism.test.js` | BITES |

This is mutation evidence, not a proof of complete correctness. It shows that
the named regression classes are observable by the named suites.
