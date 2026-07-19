# Canonical Schema and Codec Foundations — Decision Memo (2026-07)

> The infrastructure PR between the numerical-integrity policy
> (`numerical-integrity-policy-2026-07.md`) and GA Phase 1B. It adds the
> genotype schema walk and lossless decoders for all five canonical byte
> encodings, with **zero change to any valid canonical stream and zero lock
> movement**. It implements no evolutionary behaviour: no mutation, selection,
> elitism, evolution RNG stream, replacement, lineage, generation stepping,
> evolution run format, evolution lock, or crossover.

## Why this exists

Phase 1B needs three things the repo did not have. It must enumerate genotype
leaves to jitter continuous genes while leaving discrete and structural fields
alone. It must persist and reload populations, evaluation identities, and
fitness vectors without losing a bit. And it must account for which gene leaves
a repair pass moved. Until now every canonical format was encode-only: five
hand-written little-endian walks with exactly one decoder anywhere in the sim
layer (`decodeTraceRecord`, the 128-byte trace record codec).

## Roles: authority vs mirror

`serializeGenotype` remains the **canonical byte-layout authority**. It alone
produces the stream the `24cd0dd5` corpus fingerprint hashes, and this PR does
not restructure it (hard rule 4). The new `genotypeFieldWalk` /
`forEachGenotypeField` is a **validated metadata mirror**: the same fields, in
the same order, at the same offsets, annotated with the classification a future
parametric operator needs. `tests/genotype-schema.test.js` binds them with
three legs so neither can move alone:

1. a copy-declared literal walk (paths, kinds, types, hand-computed offsets)
   equals `genotypeFieldWalk(n)` — this catches a schema and serializer that
   move *together*, plus reordering, omission, one-sided additions, and
   discrete↔continuous reclassification;
2. derivation identities — axle blocks are a uniform stride-128 template at
   every count, and entries tile `[0, serializeGenotype(...).length)` exactly;
3. perturb-one-leaf byte **exclusivity** against the real serializer: changing
   a single gene moves bytes inside that entry's window and nowhere else.

Refactoring serialization onto the walk is a deliberate later PR, never an
accident of this one.

## The walk

36 fixed-prefix entries + 16 per axle (68 at two axles); `268 + 128·axleCount`
bytes. Each entry is `{path, key, type, kind, byteOffset, byteLength}`, plus
`value` when iterating a genotype.

| `kind` | what it is | mutation stance |
|---|---|---|
| `version` | the u16 schema version | never touched |
| `structural` | an array length on the wire (segment count, axle count) | changed only by a structural operator |
| `discrete` | a gene whose decode crosses a threshold — enum band (`family`, `suspType`), boolean (`symmetric`, `paired`, `driven`), slot count (`nodeCount`); single-sourced from `DISCRETE_GENE_KEYS` | a parametric operator preserves these verbatim |
| `continuous` | every other gene leaf | free to jitter inside [0,1] |

**Latent genes are documented, not encoded as metadata.** Node slots beyond the
active `nodeCount` prefix, `nodes[0].gap`, the two inactive `fam` blocks, and
the symmetry-gated `asym` block do not reach the compiled phenotype for a given
genotype — but they are always serialized, repair never erases them, and
parametric mutation perturbs them freely (latent drift is heritable neutral
variation). Encoding expression in the schema would create a second semantic
contract, drifting independently of the byte layout, and would make the walk a
function of gene *values* rather than of axle count. Whether a leaf is
*expressed* is a question about `buildIR`; if a consumer ever needs it, it
belongs in its own derived helper.

The walk describes **serialization order only**. `randomGenotype` happens to
draw in that order (a convenience for auditable re-locks);
`sampleInitialGenotype`'s draw table deliberately does not, and is separately
versioned.

## Decoder contract

Five inverses, each living beside its encoder:
`deserializeGenotype`, `deserializePopulationSnapshot`,
`deserializePopulationInitialization`, `deserializeEvaluationSpec`,
`deserializeFitnessVector`.

**Fail-loud, never repairing.** Truncation, trailing bytes, unknown versions,
out-of-range enum and flag bytes, lying length prefixes, out-of-domain values,
and internally contradictory records all throw the owning module's
`<module>: invalid encoded <thing> at <path> (<value>)` idiom. Nothing is
normalized into the nearest legal value — a decoder that quietly repaired would
be a side door for raw or corrupt data to enter the population layer wearing a
canonical face.

**Validation depth: mirror the encoder exactly — no more, no less.** This is
the rule that makes each decoder a true inverse across its encoder's whole
output domain:

| stream | the encoder validates | so the decoder re-runs |
|---|---|---|
| genotype | `validateGenotype` | `validateGenotype` |
| snapshot | `validatePopulation` (ids, duplicates, repair-identity canonicality) | `validatePopulation`, plus strict-ascending **stream** order |
| manifest | `resolveConfig` | `resolveConfig` |
| evaluation spec | wire shape + finiteness **only** | wire shape + finiteness only |
| fitness vector | wire shape + the unselectable⇒fitness-0 coherence tooth | the same, with the encoder's own `!== 0` comparison |

The evaluation spec is the load-bearing asymmetry. `resolveSpec` additionally
enforces execution constraints the encoder never applies — the spawn-clearance
band, the flat-pad guard, a non-negative wheel friction — so calling it in the
decoder would reject byte streams `serializeEvaluationSpec` legally produces.
Execution validation stays where it already lives: `evaluatePopulation` resolves
every spec it runs. A committed test asserts positively that
encoder-producible-but-execution-invalid streams decode cleanly.

The snapshot decoder's stream-order check is the mirror image: canonical bytes
are ascending by construction, `validatePopulation` sorts a copy and so cannot
see stream order, and a decoder that silently re-sorted would accept
non-canonical bytes while breaking byte identity on re-encode.

## Replay: a resolved spec re-enters the resolver

`deserializeEvaluationSpec` returns the **resolved** shape, because that is what
`serializeEvaluationSpec` consumes. The natural next move — rerun the evaluation
those bytes describe — used to fail: `resolveSpec` rejects unknown keys, and
`termination` was absent from `SPEC_KEYS` because the resolver *derives* it. So
`resolveSpec` was not idempotent on its own output, and a spec decoded from
canonical bytes could not be handed to `evaluatePopulation`.

`termination` is now an accepted input key, validated against `TERMINATIONS`
(an unknown value still fails loud — it is never coerced to the default). This
is additive and byte-neutral: the resolver already emitted exactly this value,
so no digest moves. A committed test replays a decoded spec through
`evaluatePopulation` and asserts the re-resolved spec re-encodes to
byte-identical bytes — meaning a persisted fitness vector stays comparable
across a reload.

**Only current-version streams decode.** Every encoder writes its current
version constant unconditionally, so accepting an older version would either
misread bytes or re-encode under a different version and break
`serialize(deserialize(bytes)) === bytes`. Reading historical versions, if ever
needed, is separate append-only work.

**Values are returned exactly as encoded.** Signed zero keeps its sign bit;
denormals survive; nothing is `Math.fround`-ed; the spec decoder never
re-resolves a knob against current `TERRAIN_DEFAULTS`, so a future default
change cannot silently rewrite an old spec's meaning.

## The additive digest-state input paths

Two encoders derive a digest from an object the bytes do not carry:
`serializeFitnessVector` folds `evaluation.spec`, and
`serializePopulationInitialization` folds `initialization.population`. A decoded
record holds only the resulting uint32 state — a digest is one-way — so without
a second input path neither could be re-encoded from its own decoded form.

Both encoders now resolve that state from **either** source: the original
object (production path, statements unchanged and in their original order) or a
pre-computed canonical uint32. When both are present they must agree; when
neither is, it fails loud. No existing caller passes the new field, so the
production branch is bit-for-bit what it was — and the standing
population-determinism gate is the tripwire that says so.

## Wire-representability guards

Three encoders could silently emit malformed bytes, because a count that does
not fit its wire field wrapped instead of failing:

- `serializeGenotype` wrote `axles.length` as a u8 while `validateGenotype`
  imposes no axle cap (`maxAxles` is repair *policy*, not domain);
- `serializeEvaluationSpec` wrote each range length as a u8 while its size pass
  used the true length — a >255-element range would have produced a count byte
  disagreeing with the payload that followed;
- `serializePopulationInitialization` wrote `populationSize` as a u32 while
  `resolveConfig` bounds it below (≥ 1) but not above. On the population path an
  array length bounded it implicitly; the digest-only path has no such array, so
  `0x100000001` would have wrapped to `1` and produced a manifest that decodes
  and **rebuilds a different population** while carrying the original's digest
  state.

All three now fail loud, and **no valid stream changes** — this converts silent
corruption into a loud error, and it is what makes the "exact inverse" claim
honest rather than scoped to inputs that happen never to occur.

**Guards run before allocation.** The spec encoder's range check lives in the
size pass, not the write pass, because the size pass multiplies the *declared*
length by 8 to size the buffer. Validating later let a pathological length size
the allocation first — measured: ~17 GB reserved at length 2³¹, and a generic
`RangeError: Array buffer allocation failed` escaping at 2⁴⁰ instead of this
module's diagnosis. A committed test asserts no foreign `RangeError` escapes at
2³¹, 2⁴⁰, 2⁵⁰, and `MAX_SAFE_INTEGER`.

## Binary identity vs the JSON envelope

The canonical bytes **are** the identity. FNV digests are folded over them and
never over JSON. When a stream must travel through a JSON artifact it travels
as `bytesToHex` output — lossless, deterministic, canonical **lowercase** —
inside an envelope carrying a `boxcar3d.<name>/<v>` schema tag, the existing
probe-report convention. `hexToBytes` rejects odd lengths, uppercase, and
non-hex characters rather than normalizing them: an uppercase digest silently
lowercased is exactly how two artifacts that differ in bytes come to compare
equal. Base64 is deliberately absent — nothing in this repo speaks it, and hex
diffs readably against the hand-built byte literals the tests assert.

`createByteReader` is the shared strict cursor: little-endian, bounds-checked
before every read, `byteOffset` folded in so a subarray reads its own window,
cursor state exposed as getters on a frozen object, and every failure routed
through the *calling* module's fail idiom so a decoder's diagnostics stay in one
dialect. `expectEnd` is how trailing bytes are refused — no format here has
framing or padding, so "consumed exactly to the end" is part of each stream's
identity.

Recorded duplication: `hexBytes` (trace.js) and `bytesToHex`
(scripts/characterize-population.js) implement the same byte→hex idiom and stay
where they are. One lives inside a byte-locked module, the other in a script
outside the sim ESLint ban; migrating either widens this PR's blast radius into
locked territory for no behavioural gain.

## What did not move

Every committed lock and version constant is byte-identical. Verified by the
full suite, the determinism gate, and the pinned-Chromium gate:

- assembly `24cd0dd5` (repaired-genotype corpus) and `39bcd6c4` (chassis
  geometry); the noise lock `52f40f90`; the five terrain fingerprints; the
  boulder-hull lock `06f5fca4`; the PRNG lock `270d814f`;
- evaluation golden digests A–D (`5a219735`, `02a80181`, `6b83729e`,
  `e2fc7625`) with every checkpoint state;
- population locks: snapshot `cae92db7`, initialization `7acb271d`,
  evaluation spec `1bc14aba`, fitness vector `a6d04f75`, all 20 per-member
  fitness literals, the champion and its trace;
- `GENOTYPE_VERSION` 1, `ASSEMBLY_IR_VERSION` 2, `EVALUATION_TRACE_VERSION` 1,
  `POPULATION_SNAPSHOT_VERSION` 1, `POPULATION_INITIALIZER_VERSION` 1,
  `EVALUATION_SPEC_VERSION` 1, `FITNESS_POLICY_VERSION` 2,
  `FITNESS_VECTOR_VERSION` 2, `INTEGRITY_POLICY_VERSION` 1.

No lock file was edited. `src/sim/population-locks.js` and
`src/sim/evaluation-locks.js` are untouched, and the new tests bind themselves
to the committed artifacts by recomputation and by importing the lock objects —
they duplicate no digest literal, so a future deliberate re-lock gains no
hidden extra touchpoint.

**Seed allocated:** 20260732 — the genotype boundary-value sprinkle corpus
(`tests/genotype-codec.test.js`).

## Reproduce

```
npm run lint
npm test                      # 48 files, 915 tests — the zero-lock-movement proof
npm run test:determinism      # the narrow 4-file fresh-module gate
npm run build
npm run test:browser          # pinned Chromium 149.0.7827.55, incl. the new codec smoke
```

The browser codec smoke (`tests/browser/codec-smoke.test.js`) exists because
`vitest.browser.config.js` collects only `tests/browser/**`: without it no line
of the codec family would ever execute in Chromium, and "usable in Node and the
pinned browser" would be an untested claim. It carries no golden lock of its
own.

## Follow-ups (recorded, not fixed here)

- `validateGenotype` still imposes no axle cap. The serializer guard contains
  the wire hole; tightening the validator would change behaviour for
  in-memory-only genotypes and belongs in its own deliberate PR.
- Decoded evaluation specs are wire-valid but not execution-validated, by the
  ruling above. `evaluatePopulation` remains the execution gate.
- A later PR may refactor `serializeGenotype` onto the schema walk now that the
  conformance tests exist to prove such a change byte-neutral.
