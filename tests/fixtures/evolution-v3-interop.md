# Committed evolution v3-vector interop fixture

`evolution-v3-interop.base64` is a 4,160-byte, one-generation, non-terminal
history carrying fitness-vector v3 (the five per-member integrity
observations). It holds the SUCCESSFUL-REPLAY role that
`evolution-v1-kimi-k3max.base64` held before fitness-vector v3; the Kimi
artifact's bytes are deliberately unmodified and it now serves as the
standing EARLY-REFUSAL witness (a stale wire version must be refused as
`unsupportedVersion` before any physics).

- Producer: `scripts/relock-evolution-interop.js` (this implementation) at
  fitness-vector v3 — unlike the Kimi fixture this is NOT an independent
  implementation; its interoperability value is as a durable committed
  oracle against silent encoding drift, re-locked only deliberately.
- Artifact SHA-256: `58973f6205852217d4d4666642f4ddfba7a99a8ba4f0feb1b8d1d1b142e576e3`
- Header digest: `312665978b18bdd920668a1ee3bc49b301a24b76d7497f9ef328732b6939bfce`
  (byte-identical to the Kimi fixture's header — the history format itself
  did not move at v3; only the fitness-vector component bytes did)
- One-generation history digest: `aea30ef11d4d6c75adc5af1a88b9a1a408e5ab51962690a29b7ec81dffd7e79c`
- Expected terminal continuation digest: `bc53c425b88c3cb549285749abc82282162a580f93b741632702028a6cbf247b`
- Expected terminal artifact SHA-256: `e6b2babe4ffa1dee2a69dd36dc1c6b0095aa48fcc41b9750db31bd14cec409f8`

The canonical config is declared directly beside the consuming Node and
Chromium tests (and duplicated in the producer script): population seed
`20260721`, terrain seed `20260722`, population 4, 60 steps, 3 generations,
deterministic physics, mutation probability `0.5`, and magnitude `0.1`.

The tests first require the local implementation's generation-0 artifact to
be byte-identical to this static fixture, then resume the static bytes and
require the literal terminal continuation digest above. Regeneration is a
reviewed re-lock via the producer script, never an incidental update.
