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

**The classification contract is anchored independently.** Production classifies
a leaf by consulting `DISCRETE_GENE_KEYS`, so a test that derived its
*expectations* from that same constant would be circular: delete `suspType` from
it and production reclassifies the gene as continuous, the expectation follows,
the suite stays green — and a future parametric operator silently gains
permission to cross an enum-band boundary, which is the exact failure this
schema exists to prevent. `tests/genotype-schema.test.js` therefore copy-declares
`EXPECTED_DISCRETE_GENE_KEYS`, asserts the production constant equals it, and
derives every expected kind — including the probe cross-check's partition — from
the literal. Verified by mutation: removing `suspType` from the production
constant turns **six** tests red, where previously all of them passed.

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

## One source of truth per variable-length field

A guard on the declared length is not sufficient on its own. The spec encoder
took a range's `.length` for the allocation *and* the u8 count byte, then wrote
the values with `for...of` — two readings of the same input that an iterable can
make disagree:

- **under-yield** (`length: 2`, iterator yields one value) produced a
  correctly-*sized* 401-byte stream with a zero-filled hole shifting every later
  field. This is the worst failure mode precisely because the stream looks
  well-formed; whether a decoder happens to catch the shift downstream is luck,
  not contract.
- **over-yield** (`length: 1`, two values) overran the DataView with a foreign
  `RangeError: Offset is outside the bounds of the DataView` — contradicting the
  guarantee asserted one section above.

A cardinality check alone does not settle it either, and a third review round
showed why. Requiring the iterable's cardinality to match the declared length
makes the *count* single-sourced but leaves the *values* sourced from the
iterator — so a genuine `Array` carrying an overridden `Symbol.iterator` (and
`Array.isArray` stays true, so an isArray check was never the discriminator)
encodes whatever the iterator yields while its indices say something else.
Measured: `craterRadiusRange = [2, 5]` with an iterator yielding `9, 9` encoded
as `[9, 9]`, decoded cleanly, and re-encoded byte-identically, while terrain
generation would have used `2, 5`.

**The ruling: indices are the truth.** Terrain generation consumes every range
by index (`cfg.craterRadiusRange[0]`, `cfg.craterRadiusRange[1]` — `terrain.js`),
so a range's indexed content is what the described run actually executes on.
The encoder therefore **materializes each range by index** — `declared` values
read from `declared` slots, after the u8 bound check — and both passes consume
that one array. An overridden iterator becomes irrelevant rather than a special
case to detect, and the earlier failure modes vanish by construction: nothing
can under-yield, over-yield, or fail to terminate when nothing is iterated. A
slot holding anything but a finite number fails loud at the existing f64 gate,
so an iterable with no indices is refused rather than silently encoded. An
honest array-like still encodes, byte-identically to the equivalent real array.

**The class was systemic, not local to the spec encoder.** A sweep of every
canonical encoder found the same split — a count taken from `.length`, a payload
written by `for...of` — in three more places, each reproduced:

| encoder | field | pre-fix behaviour on an under-yielding iterator |
|---|---|---|
| `serializeEvaluationSpec` | terrain ranges | at an **early** range the decoder catches the shift; at the **last** range (`logLengthRange`) the stream decodes cleanly and re-encodes byte-identically — `[3, 0]` where `[3, 7]` was meant |
| `serializeGenotype` | `axles`, `nodes` | **worst case**: the unwritten axle's 128 zero bytes are all legal `[0,1]` genes, so the short stream **decoded cleanly into a different genotype** |
| `serializeFitnessVector` | `individuals` | zero-filled tail; caught downstream by the ascending-id check |
| `serializePopulationInitialization` | suspension categories | zero-filled byte, decoding as `'S0'` |
| `validatePopulation` | `individuals` | **validated one set of members, returned another** — see below |

A fourth review round found the same split one layer up, in the gate the
snapshot encoder depends on. `validatePopulation` checks members **by index**
and then returned `[...individuals]`, an **iterator** read. Reproduced: a
population whose indices hold repaired genotypes and whose iterator yields a
RAW draw passes validation — canonicality tooth and all — and
`serializePopulationSnapshot` then encodes the raw draw:

```
validatePopulation             = PASSED (validated the INDEXED members)
serializePopulationSnapshot    = SUCCEEDED, 1328 bytes
member 0 == the RAW draw       = true
member 0 == what was validated = false
```

That defeats this module's whole reason for existing — "a raw draw surviving as
a hereditary record is exactly the bug class this seam exists to stop" — and
produces a stream the codec's own decoder then refuses, because
`deserializePopulationSnapshot` re-runs the gate on an index-built array. A
producible, undecodable snapshot. The copy is now built by index.

The lesson generalizes past encoders: **any function that validates one reading
of a caller's collection and returns another has the same defect**, whether or
not bytes are involved.

The genotype and last-range spec cases are the load-bearing ones: they show a
downstream decoder cannot be the backstop, because a hole at the end of a stream
leaves nothing to run short. Over-yield leaked a foreign `RangeError` in every
case.

Every one of them now reads **by index**, which is immune to a tampered
`Symbol.iterator` and cannot desynchronize from the count. The spec's ranges are
array-*likes* rather than guaranteed arrays, so those are materialized into a
local array first — but by index, on the same ruling, not by iteration.

Two intermediate fixes are worth recording, because each looked complete and
was not. Materializing with an unbounded `Array.from` let an infinite generator
declaring `length: 2` exhaust memory instead of failing loud (measured at 47 MB
for 2,000,000 values). Bounding the materialization fixed the hang but still
read *values* from the iterator, which is the divergence above. Only the indexed
read closes both.

**Reachability, stated honestly.** The production path sanitizes this:
`ownTerrain` copies arrays with `.slice()`, which is index-based and drops an
overridden iterator, so `evaluatePopulation → resolveSpec → ownTerrain` was never
exposed. The exposure is via direct calls to the public encoders — which is
exactly what the codec tests, the browser smoke, and any future replay or import
tooling do, and those are precisely the callers whose byte-exactness this PR
exists to guarantee.

**The rule for any future variable-length wire field:** count, allocation, and
payload must all come from one INDEXED reading of the caller's value — the same
reading the consumer of that field performs — never from two readings, and
never from an iterator when indices are what execution consumes.

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
npm test                      # 48 files, 932 tests — the zero-lock-movement proof
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
