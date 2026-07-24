# Independent evolution v3 interoperability fixture

`evolution-v3-independent.base64` is a 4,160-byte, one-generation, non-terminal
history carrying a **fitness vector v3**. It was produced by
`scripts/generate-independent-evolution-artifact.js`, an encoder written from
the *written format spec* rather than from the implementation.

## What its independence covers — and what it does not

This claim is deliberately narrower than the one made for the superseded Kimi
artifact, because the construction is different and the earlier wording was
looser than what it actually established.

**Independently re-derived by the generator** (this is the evidence):

- the fitness-vector **v3** member walk — the three f64 peaks and the two
  flagged optional onset steps, including the rule that an *absent* step writes
  a zero payload. This is the layer PR #27 changed;
- the lineage, evaluation-metadata and population-snapshot walks;
- the header payload walk;
- all seven domain-separated SHA-256 formulas, the generation chain (generation
  0 chaining from the *header* digest), and the outer framing with its trailing
  history digest.

The generator imports **nothing** from `src/sim/evolution-history.js`,
`src/sim/evolution-lineage.js`, `src/sim/population.js` or
`src/sim/population-evaluation.js`, and hashes with Node's `crypto` rather than
`src/platform/sha256.js`. Its enum orders, digest domain strings and field
walks are copy-declared from the spec. If this repo's encoder drifts from the
spec, this artifact stops verifying.

**Declared input, captured once from a production run — NOT evidence:**

- genotype bytes, the initialization-manifest bytes and the evaluation-spec
  bytes, supplied as hex. Those encodings are unchanged by this PR and have
  their own codec suites; re-deriving them here would attest PR #23's work;
- every physics-derived scalar — fitness values, the integrity observations,
  `effectiveDt`. These are what the simulation produced. The bytes assembled
  around them are what is under test.

**Structural, not organizational.** This artifact was authored in the same
repository as the code it checks, so it catches an encoder that drifts from the
spec — it does not catch a misreading of the spec made twice. That is a real
limitation and it is why the hand-computed expected-bytes literal in
`tests/evaluation-codec.test.js` is kept as a second, narrower oracle for the
v3 member layout.

## Identity

- Artifact SHA-256: `58973f6205852217d4d4666642f4ddfba7a99a8ba4f0feb1b8d1d1b142e576e3`
- Header digest: `312665978b18bdd920668a1ee3bc49b301a24b76d7497f9ef328732b6939bfce`
  (identical to the v2 Kimi artifact's, as it must be: both are the same
  interop configuration, and a change to an opaque component's contents cannot
  reach the header. Asserted in `tests/history-observations.test.js` — this
  line previously carried the golden evolution-lock fixture's header digest,
  a different configuration entirely, and no test read it.)
- One-generation history digest: `aea30ef11d4d6c75adc5af1a88b9a1a408e5ab51962690a29b7ec81dffd7e79c`
- Expected terminal continuation digest: `bc53c425b88c3cb549285749abc82282162a580f93b741632702028a6cbf247b`
- Expected terminal artifact SHA-256: `e6b2babe4ffa1dee2a69dd36dc1c6b0095aa48fcc41b9750db31bd14cec409f8`

The canonical config is declared beside the consuming test: population seed
`20260721`, terrain seed `20260722`, population 4, 60 steps, 3 generations,
deterministic physics, mutation probability `0.5`, magnitude `0.1`.

## What the test asserts

1. The local implementation's generation-0 artifact is **byte-identical** to
   this static fixture — the independent encoding and this repo's agree.
2. Resuming the static bytes and continuing to termination reproduces the
   literal terminal digest above.

## Relationship to the v2 Kimi fixture

`evolution-v1-kimi-k3max.base64` was produced by a genuinely foreign
implementation and is *organizationally* independent in a way this artifact is
not. It embeds a **v2** fitness vector, so it can no longer be resumed. It is
retained as the early-refusal witness — its framing, header digest, all four
component digests, chain and whole-history digest still verify, and resume must
then fail with `unsupportedVersion` naming the fitness-vector field. Its
successful-replay digests remain recorded in its own `.md` as historical,
pinned to the pre-v3 commit.

Re-establishing a *foreign* v3 artifact is a worthwhile follow-up; it is not a
blocker, because the two oracles above cover the changed encoding from
different directions.
