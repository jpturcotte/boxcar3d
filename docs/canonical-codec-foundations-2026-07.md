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
`ownTerrain` copies each range by an explicit indexed loop, which cannot see an
overridden iterator, so `evaluatePopulation → resolveSpec → ownTerrain` was never
exposed. (That copy used `.slice()` when this section was first written, and the
argument was stated in those terms; `.slice` is itself a method looked up on the
caller's array, so it was later replaced by the indexed loop under the rule
below. The reachability conclusion is unchanged — the mechanism is not.) The
exposure is via direct calls to the public encoders — which is
exactly what the codec tests, the browser smoke, and any future replay or import
tooling do, and those are precisely the callers whose byte-exactness this PR
exists to guarantee.

**The rule for any future variable-length wire field:** count, allocation, and
payload must all come from one INDEXED reading of the caller's value — the same
reading the consumer of that field performs — never from two readings, and
never from an iterator when indices are what execution consumes.

## Where this stops: the threat model

This boundary was settled over three adversarial rounds, and the first draft of
it was wrong in a way worth recording.

A fifth review round probed whether "indices are the truth" survives attacks on
indexed access itself, and the boundary drawn from it — "plain data in scope,
hostile objects out" — lumped **caller-owned code** in with **lying exotic
objects**. A sixth round broke that line with ordinary JavaScript: a genuine
`Array` whose own `forEach` property is a no-op walked `'S2'` straight past the
initializer's suspension mask, and a caller who simply kept their reference to
a category array mutated the provenance record *after* generation. No `Proxy`,
no getter — the same general class as the overridden `Symbol.iterator` the PR
had treated as in scope from the start.

A full trust inventory then swept every public function in the family for one
question — *what does this code trust that a caller controls?* — across five
categories: unvalidated data reads, invoked caller-owned code, retained
mutable references, coercions, and anything else assumed without checking. It
examined 149 trust points and confirmed 20 findings (none refuted), including
two more of blocker class: the canonicality tooth itself could be turned
against a sibling (member B's own `axles.map`, invoked *by the tooth's own
`repairGenotype` call*, swapped already-validated member A for a raw draw the
snapshot then attested), and an own `length` data property on a genuine
`Uint8Array` — `length` is an inherited *accessor*, so ordinary
`Object.defineProperty` shadows it — made `bytesToHex` emit `'dead'` for a
buffer whose content is `deadbeef`.

**The boundary, corrected — the module owns what it attests:**

- **Copy on intake, by index.** Ownership boundaries (`captureGenotype` — this
  section originally named `cloneGenotype`, which §"The single-read invariant"
  below deleted in favour of one fused validate-and-copy walk —
  `ownTerrain`, the fitness-vector row preflight, `attestPopulation`) build
  module-owned structures from indexed reads before anything is trusted.
  `validatePopulation` is the deliberate exception and says so: it is a *gate*,
  not an attestation, and returns the caller's own individual objects in
  canonical order. Anything that must bind what it validated calls
  `attestPopulation`, which decodes each genotype from the very bytes it
  attests — so "what was compiled" and "what was hashed" are one object rather
  than two reads that happen to agree.
- **Never invoke caller-owned code.** No method looked up on a caller-supplied
  object is ever called — no `.map`, `.forEach`, `.indexOf`, `.slice`, no
  iteration protocols. **And borrowing the intrinsic is not always enough**:
  `%TypedArray%.prototype.subarray` performs species dispatch, reading the
  receiver's `constructor` and `constructor[Symbol.species]` and *constructing*
  the result, so `TA_SUBARRAY.call(bytes, …)` ran caller code and returned
  whatever that code chose. Measured on the snapshot decoder: a 1052-byte
  stream containing genotype A decoded to genotype B and re-encoded to 796
  different bytes, with every bounds check and `expectEnd` still passing. Byte
  windows are now built as `new Uint8Array(TA_BUFFER.call(x), TA_BYTE_OFFSET.call(x) + o, n)`
  and `subarray` is banned outright by lint in this family. The general rule:
  the geometry *accessors* are safe to borrow; a prototype *method* may be
  species-aware or otherwise observable — reach for a constructor, not a method.
- **Attest exactly what was validated.** `serializePopulationSnapshot` emits
  the very bytes the canonicality tooth checked (one validation walk returns
  `{individual, bytes}` pairs; the encoder re-reads nothing), and
  `serializeFitnessVector` writes from its preflight's module-owned rows.
  Nothing is re-read from the caller after it was checked. `validatedMembers`
  captures each member's `individualId` and `genotype` ONCE and every later
  consumer — sort, encoder, attestation, error text — uses the capture: an own
  accessor walking `0,0,0,7,9` had one member VALIDATED as id 0, ENCODED as id
  7, and RETURNED by `attestPopulation` as id 9, three identities from one
  member. **Owning the judgement is not the same as owning the return value.**
  Both champion selectors capture every compared field once and compare only
  the captures, but they still hand back the caller's winning row, because
  production rows carry a `diagnostics` block the diagnostic selector exists to
  report — narrowing that to a four-field summary would be an API change
  wearing a hardening costume. They also enforce the fitness-vector row domain,
  so a row that could not be serialized cannot be ranked.
- **Read byte-boundary geometry through intrinsics.** `bytes.js` caches
  `length`/`buffer`/`byteOffset`/`byteLength`; `deserializeGenotype`,
  `trace.js` and `fnv1a.js` cache the subset each needs (module-local, because
  `assembly.js` and `fnv1a.js` are deliberately import-free). The reader
  exposes the captured length as a frozen `byteLength` getter, so a decoder
  needing an exact total-length identity has a safe source —
  `deserializeFitnessVector` read `bytes.byteLength` instead and *falsely
  rejected* byte-identical valid vectors, the exact-inverse claim failing in
  the direction no test looks for. `bytesEqual` and `fnv1aFold` bound their
  loops on the intrinsic too: both formerly read the shadowable `length`, so
  `deadbeef` compared equal to `dead0000` and a digest could attest a *prefix*
  of the bytes it was handed. The reader also wraps the caller's `fail`
  callback with an unconditional abort, so a log-and-continue callback can no
  longer resume the walk after a rejection (measured: a negative count
  *rewound* the cursor).
- **No retained caller references in attested records.** `resolvePolicy`
  returns an owned frozen category list; the IR shares no structure with the
  input genotype; a caller mutating their original objects after the call
  changes nothing the module produced (the self-contained-history test now
  mutates and re-proves).
- **Structural checks before dereference, coercion nowhere.**
  `spawn`/`featureTypeWeights`/`ir.chassis.aabb.min`/vector rows are shape-
  checked in the module dialect before any deep read; `deterministic` is a
  strict boolean (truthiness encoded the string `'false'` and a boxed
  `new Boolean(false)` as *true* — the field that selects the physics
  flavor); explicit `null` fails where absent defaults (`keepRaw`,
  `spawn.clearance`); unknown assembly option keys reject loud; the flat-pad
  guard validates the scalars it compares (NaN made it vacuously pass);
  `hubMassProperties` refuses the record shapes that silently returned
  all-NaN.

**What stays out of scope, and why the regress argument still holds there:**
exotic objects whose *fundamental operations* lie — a `Proxy` whose numeric-
index getter answers differently on successive reads, a lying
`[[GetPrototypeOf]]`, a `toString` that throws on an otherwise-valid value.
Against those, every property read in `src/sim` is attackable and the only
real defence is a deep structural clone at every entry point — a different,
larger design decision. The corrected line is *code vs data*: the module never
runs caller code and never re-reads caller data after validating it, but it
does assume that a plain data read returns what the runtime holds.

**Documented, deliberately not fixed** (each loud-on-first-use, none silent):
`randomGenotype`/`sampleInitialGenotype` trust their injected `rng`'s
capability and range (the documented injection contract — a missing method is
immediately loud, and out-of-range draws are contained by downstream domain
validation); the physics adapter trusts compiler-owned IRs (which, after the
`cloneGenotype` fix, share nothing with any caller), and the numbers it would
otherwise silently propagate are validated at the owning seam —
`spawnPoseOnFlatStart` now checks every scalar it combines, including the ones
reached through the adapter's transform records.

*Two items were removed from this list because the claim attached to it —
"each loud-on-first-use, none silent" — was false for them.* `bytesEqual` was
listed as trusting "whatever byte-likes it is given", on the reasoning that
every attesting caller passes module-produced arrays; but it read the
shadowable `length` and returned `true` for buffers whose real content
differed, silently, from the module that owns the canonicality comparison.
`fnv1a.js` was listed as "the locked house hash, byte-for-byte untouched" —
true of its constants and fold order, which are unchanged and still reproduce
every locked fingerprint, and irrelevant to its loop bound, which had the same
defect. Both are now fixed. The lesson is about the list, not the two entries:
a "documented, not fixed" register is only honest if each entry's *failure
mode* has been checked, not just its reachability argument.

**Two guards were considered and deliberately rejected**, which is worth
recording because the symmetry argument for them looks stronger than it is. The
fitness vector's member count and the manifest's category count are the only
two wire counts without an explicit bound, and adding them "for consistency"
with the three guards above is a false analogy: those three each close a
*reachable* gap and each carry a test that triggers it, whereas neither of
these can be triggered by any input. `Array.isArray` gates `individuals`, and a
genuine `Array` cannot exceed 4294967295 — exactly the u32 maximum
(`a.length = 0x100000000` throws `RangeError: Invalid array length`); the
category list is validated against `INITIAL_SUSPENSION_MASK` with duplicate
rejection before it is counted. A guard at either site would be unreachable by
the language spec or by an earlier validator, not merely unreachable today —
dead code defending a shape that cannot be constructed. Both sites carry a
comment saying so, so the asymmetry reads as a decision rather than an
oversight.

## Why the rules are now executable

Everything above was, until this round, **prose with no build behind it**. That
turned out to be the actual defect, and it is worth stating plainly because the
same failure had already repeated three times: a defect was found, the *site*
where it was found was fixed, a *rule* was written here, and nothing bound the
two. The rule then held wherever someone had happened to look and nowhere else.

Two measurements settled it. Deleting the three cached intrinsic getters from
`deserializeGenotype` and reverting it to plain property reads left the entire
suite **green** — the hardening was a comment. And `tests/bytes.test.js`'s
tooth *"an own `subarray` property is never invoked by `r.bytes`"* asserted a
strictly weaker proposition than the rule it claimed to enforce: it checked
that an own `subarray` property was not called, which the intrinsic
`TA_SUBARRAY.call` satisfied while violating the rule outright via species
dispatch. **The test had been written to the fix, not to the rule.**

So each rule now has something that fails a build:

| rule | enforcement |
|---|---|
| intrinsic byte geometry | `no-restricted-syntax` on `.byteLength`/`.byteOffset`/`.buffer` member reads in the seven byte-handling modules; legal module-owned receivers carry a disable comment *naming the receiver*, so an edit that moves one onto caller data leaves a comment that is now false |
| never borrow a species-aware method | `.subarray` banned outright in those modules, with **no** module-owned exception |
| shadowed geometry is inert | `tests/ownership-boundary.test.js` feeds an own `length`/`byteLength`/`byteOffset`/`buffer` to every function in the repo that accepts caller bytes, and asserts the result is **identical to the un-shadowed call** or a rejection in that module's own dialect — never merely "it throws", which is what scored `deserializeFitnessVector` green while it was falsely rejecting valid vectors |
| the export surface is classified | the same file pins each module's exports as a copy-declared literal plus a per-export table of the caller collections and caller numbers it touches; a new export cannot ship unclassified, which is how an `export const` arrow (`wheelMass`) and a function just above a read window (`fitnessFromVehicleResult`) each survived a full round with no guard |
| copy on intake / no retained references | identity assertions driven by that table, including the explicit pinning of `validatePopulation`'s deliberate exception |
| exact inverse over the output domain | `tests/codec-roundtrip-property.test.js` — seeded boundary-value generation per pair, asserting byte-identical re-encode and `Object.is` leaf equality with the failing **path** reported |
| no silent invalid numbers | a table-driven sweep feeding well-shaped garbage to every seam that returns or embeds a number, plus a **permutation-invariance** check on both champion selectors — the literal "total order" claim in their own docblock, which a per-field guard would not have caught |
| provenance claims | negative legs beside the honest-producer tests, pinning what these records verify and what they only claim |

The generalizable lesson, since this is the third round it has cost: **a test
written to reproduce the bug you found is not enforcement of the rule you wrote
about it.** Assert the rule, on values, over the whole surface it claims — and
prove the assertion bites by reverting the fix and watching it fail.

## The single-read invariant (round 10)

The lesson above was learned one notch too low. Every rule in the table is
enforced over the surface it claims — but each was written to a round's
**mechanism** (shadowed TypedArray geometry; then a read-count tooth on one
champion helper), and a mechanism is not an invariant. Round 9 possessed the
precise instrument that finds this round's four blockers — a counting accessor
asserting a single read — and pointed it at the one function the review had
named, leaving ~40 exports unexamined. *Enforcement scoped to the mechanism is
still enforcement written to the fix.*

The invariant, stated once:

> Any caller-owned value used to **validate, order, attest, encode, or execute**
> must be captured into a module-owned local exactly once, and every subsequent
> operation must use that capture.

The exploit vehicle is an ordinary own accessor on a plain object or a genuine
Array — inside the CODE-vs-DATA boundary settled above, not the excluded exotic
class. A 6-area sweep with adversarial verification returned **39 confirmed, 7
refuted**. Representative outcomes, all reproduced:

| seam | validated | used |
|---|---|---|
| `repairGenotype` / `compileAssembly` | `hue` = 0.5 | `hue` = 1e6 → a *repaired* genotype outside `[0,1]`, an IR with a 300 km chassis half-extent, all finite so nothing failed loud |
| `serializeGenotype` | a finite gene | `NaN` on the wire — bytes its own decoder rejects |
| `serializeFitnessVector` | `valid: true` | `valid: false` carrying fitness 1 — a member combination the decoder refuses |
| `resolveSpec` | `spawn.x = -44`, on-pad | executed at `x = 100`, **off-pad**, with the spec digest attesting the position that never ran |
| both champion selectors | — | duplicate `individualId` made the documented total order position-dependent |

The last two are the important ones. `resolveSpec` is an **execution** gate, not
a codec seam: the flat-pad guard is a physical constraint, and it was bypassed.
And duplicate ids are already outside the fitness vector's domain (its
strictly-ascending id rule rejects them), which fixes the principle: **a row that
cannot be serialized must not be ranked.**

Every fix is the same move — capture once, then read only the capture.
`captureGenotype` became THE ONE WALK (validate and copy in a single pass;
`cloneGenotype` is gone, since `validate(x)` followed by `clone(x)` is by
definition two readings backing one attestation). `validateRecord` returns a
frozen module-owned snapshot. `capturePerBody` and `captureVehicleResult` do the
same for the forensic and fitness paths.

`tests/single-read.test.js` is the enforcement. The INSTRUMENT is **universal
over an input's fields**: it deep-instruments every own property of a caller
input with a counting accessor and asserts ≤1 read per path, so a new FIELD on
an already-covered input is checked without anyone remembering. A property read
at most once cannot be lied to — so the tooth needs no knowledge of what any
function does. The INPUT SET, though, is a curated `CASES` table: a new EXPORT is
not instrumented automatically. A coverage tooth (round-12) therefore derives
the function-export set from the module namespaces and fails until each is a
CASES row or a declared exemption — the earlier "a new export is covered without
anyone remembering" was true of fields, not exports (break-it sweep F9).

Three exemptions were declared. **The first was false — see round 11 below.**
TypedArray byte geometry remains the round-8 suite's concern; and
the adapter's placement planner keeps its standing "trusts compiler-owned IRs"
ruling — `spawnPoseOnFlatStart` closes that at **its own** boundary with
`ownPlainData` rather than pushing the invariant into the physics realizer.

All 14 mutations bite. Two teeth exist only because a mutation was *silent*:
`compareCheckpoints` and `compareTraces` needed **divergent** fixtures, since
identical inputs never reach the reporting branch — exactly where a re-read
prints values that were never compared; and `resolveSpec`'s regression had to
live in `tests/population-evaluation.test.js`, because it is private and
reachable only through the physics path. **A fix no test can redden is not a
fix** — the corollary to the lesson above, and the reason the mutation pass is
run against every tooth rather than a sample.

## The exemption was false, and the instruments were scoped (round 11)

Round 10 wrote the invariant and built an instrument that is universal over
**fields**. Round 11 asked the next question — *what does that instrument
exempt, and who checks the exemptions?* — and found the class one notch below
the instruments themselves. Twenty defects survived adversarial verification;
three break the validated ≡ attested ≡ executed chain.

**The root: the Array-`length` exemption.** It was asserted as a language
guarantee in the enforcement suite, in CLAUDE.md's "declared non-exemptions",
and in two production comments. Half of it is true — `length` is
non-configurable, so no accessor can be installed. The other half — *"with no
caller code running between reads it cannot change"* — is **false for every
validation walk in this codebase**, because `length` is WRITABLE and element
reads on caller objects *are* caller code. Measured, with an ordinary own
accessor on a genuine Array:

- `captureGenotype` — a `radius` getter assigning `axles.length = 1` made a
  3-axle genotype serialize to **396 bytes attesting axleCount 1**: a short,
  well-formed, cleanly-decodable stream attesting a genotype the caller's
  object did not hold, reproduced through `attestPopulation` with the
  canonicality tooth passing.
- `validatedMembers` — a member getter assigning `individuals.length = 3` made
  `attestPopulation` return a silent **prefix**: 4 members in, 3 attested,
  1476 bytes instead of 1752, re-decoding cleanly.
- `compareTraces` / `snapshotCheckpoints` — a shrinking element getter made the
  determinism comparator return **`null` ("identical") for divergent traces**,
  in both directions.

Every loop bound over a caller collection is now captured before the walk, the
three false comments are corrected, and `LOOP_BOUND_CASES` in
`tests/single-read.test.js` supplies the input the counting instrument
*structurally cannot generate* (it rebuilds Arrays, discarding the mutating
getter). Its assertion is on the RESULT: a poisoned walk may fail loud in the
owning module's dialect, but it must never SUCCEED with a different answer.

**A trust axis nobody had posed: own-property ENUMERABILITY.** Presence was
gated with `Object.prototype.hasOwnProperty` (which sees non-enumerable own
properties) while execution came from `{ ...TERRAIN_DEFAULTS, ...terrain }`
(own **enumerable** only). One `Object.defineProperty(t, 'seed', { value })` —
plain data, no Proxy — passed the guard whose own message says *"a fitness
vector must never bind the default seed by accident"*, and `evaluatePopulation`
then ran and attested the **seed-0 default world**, byte-identical to an
explicit seed-0 run. Same shape in `runEvaluation`. The rule, now stated where
both guards live: *a guard that decides presence must use the same property
enumeration its consumer reads with* — plus a rejection of any terrain carrying
non-enumerable own properties, which closes the knob case too (a non-enumerable
`featureDensity` silently reverted to its default).

**`validateOptions` returned the caller's objects by reference**, and
`runEvaluation` re-read them after `hooks.onPhase(...)` and across
`await createPhysics(...)`. Measured: a run validated with `trace.mode:'none'`
executed in `'full'`; a spawn validated at x=−25 realized at x=−13; a vehicle
carrying the removed `targetAngvel` tombstone realized silently at the default
surface speed. Indexing the loop (round 9) fixed holes and iterator divergence
— it did not make the two readings one. It now returns a module-owned capture;
`ir` stays a captured *reference* under the standing compiler-owned-IR ruling.

**Also closed:** `resolveSpecDigestState` read `evaluation.spec` twice (its
documented twin had been fixed by caller capture in this same PR);
`ownTerrain` densified a caller-DECLARED range length before any validation,
reaching an uncatchable `FATAL ERROR: heap limit` V8 abort at 2^26 on the
production path, one function away from the identical committed guard;
`ownPlainData` passed `Object.create(null)` and class instances through **by
reference**, dropped an own `"__proto__"` key through the inherited setter, and
recursed unbounded; `resolveReachMap` walked `bodies` with the CALLER's
`forEach`; `bodyReachMetadataForIR` returned chassis-only metadata with no
error for a non-array `wheels` (a silent path this PR's own indexed rewrite
introduced); two diagnostics re-read the caller inside their own message and
printed values that were never rejected; and three `Object.hasOwn` defaults
over-corrected, rejecting explicit `undefined` where five sibling keys accept
it.

**Why G9 mattered more than G1–G8.** The instruments were each scoped to the
round that built them: `tests/ownership-boundary.test.js` pinned export lists
for **five** modules while `single-read.test.js` cited it as the backstop for
all of them (47 exports across `integrity.js`, `trace.js`,
`trace-forensics.js`, `evaluation.js`, `fnv1a.js` were unpinned); every CASES
row asserted the call must SUCCEED, so no rejection branch anywhere was
instrumented; the `serializeFitnessVector` row used a fixture with no `spec`,
so its PRODUCTION branch was never entered; and the byte-family lint block
scoped itself with a hard-coded seven-file list that no test read — the same
probe file elsewhere in `src/sim` produced zero diagnostics. The lint selectors
matched one spelling each: `bytes['byteLength']`, `const { byteLength } =
bytes`, `Reflect.get(bytes, 'byteLength')`, `globalThis.Math.random()`,
`const M = Math; M.random()` and `globalThis.Date.now()` all linted **clean**,
while both hard rules claim "(ESLint-enforced)". All of that is now closed, and
`(0) the byte-family lint scope` reads the real directory and the real config,
so a new `src/sim` module fails until it is classified.

**One arithmetic change, verified.** `**` was not banned although `Math.pow`
is, and it was live in the locked terrain feature generator feeding
`maxHalf.ramp` → every ramp's placement draw. `x ** 2` is
`Number::exponentiate`, which the spec leaves implementation-approximated
exactly like the banned `Math.pow`; it is now `x * x`, which IEEE 754 requires
to be exact, the operator is lint-banned, and all five terrain fingerprints are
byte-identical across the change.

**And the completeness pass found the largest gap, which is pre-existing.**
Every codec test asks *"do the same bytes come back?"*; none asked *"do the same
bytes still describe the same vehicle?"* Reordering `SUSPENSION_TYPES` to
`['S1','S0','S2']` flips every archived axle's suspension type while **both**
locked fingerprints stay byte-identical (`24cd0dd5` hashes raw genes;
`39bcd6c4` hashes chassis colliders, which derive only from frame genes). The
sole prior guard was one incidental assertion in a repair test, and
`genotype-codec.test.js` was self-referential on both sides — the exact shape
`genotype-schema.test.js` bans for `DISCRETE_GENE_KEYS`. A decode-table golden
now pins the enum orders as copy-declared literals and hashes the **decoded
phenotype** of the seed-20260710 corpus (`341c2830`).

**All 27 mutations bite, 0 silent** — including four teeth that exist only
because a mutation *was* silent, each a lesson about what an assertion has to
be able to distinguish: `compareTraces` needed a case whose shrink target
equals the loop bound, or the truncated walk always threw before reaching the
verdict; `analyzeTrace` had to assert per-body capture counts rather than
`perBody.length`, which is 1 either way for a one-body trace; the non-array
`wheels` case had to use `{}` rather than a string, because a string has a
`length` and fails on its first character instead of taking the silent path;
and `bodyReachMetadataForIR`/`resolveReachMap` needed BOTH a `forEach` and a
`Symbol.iterator` poison, since they are one defect wearing two names.

**The generalization, one notch above round 10's.** Round 10 learned *a test
written to reproduce the bug you found is not enforcement of the rule you wrote
about it*. Round 11 is the same lesson applied to the instruments: **enforcement
scoped to a round's mechanism is still enforcement written to the fix.** The
exemption that excuses the loop bound, the fixture that misses the production
branch, the export table covering five of ten modules, the lint selector that
sees one spelling — each was a rule holding exactly where its author had
looked. The counter-move is the same every time: make the scope itself derived
rather than enumerated, and check the exemptions as carefully as the rules.

## Round 12: the break-it sweep, and two scope rulings

A 20-lens adversarial pass whose success criterion was BREAKAGE (42 confirmed
findings after refuting verification) proved round 11 falsified several of its
own guarantees, and surfaced a class no prior round had named. All fixed across
seven commits; every committed lock stayed byte-identical.

**The blockers were round 11's own headline invariant.** "Validated ≡ attested ≡
executed" was false four in-scope ways, each via an ordinary own accessor on a
plain object: `runEvaluation` captured `spawn.position` but left
`spawn.rotation`/`spawn.linvel` BY REFERENCE (a validated identity quaternion
executed as yaw-90; a reading that passed the unit-quaternion gate realized
|q|²=3.24); `resolveSpec`'s seed guard was bypassable by an accessor deleting
`terrain.seed` between the presence walk and the spread (the seed-0 default world
attested); and the new `ownTerrainOptions` re-introduced the `__proto__`
poisoning round 11 fixed one module over. Round 11's "every loop bound is
captured" and "a poisoned walk never succeeds with a different answer" were
overclaims: `capturePerBody` and `compareTraces`'s record bytes were still
uncaptured. The enforcement was hollow in three places: the D7/F3 determinism
lint bans were disabled in the 7 byte-family files (flat-config replaces
`no-restricted-syntax`), the decode-table golden folded 5 of ~20 decoded
quantities (a GENE_RANGES rescale left all three locks identical), and the
single-read suite's "universal by construction" was true of fields, not exports.

**THE STORAGE-LIFETIME RULING (JP).** *Canonical bytes must be ordinary
same-realm, fixed-size, non-shared, non-detached `ArrayBuffer`-backed
`Uint8Array`; anything fancy is rejected loud at the door.* The round-8 property
boundary (CODE vs DATA — reject lies, trust plain reads) never named an axis:
a genuine `Uint8Array` whose BACKING STORE is transient or foreign. A detached
buffer reads as empty (`bytesToHex` → "", `fnv1aFold` unchanged); a
`SharedArrayBuffer` can be scrambled cross-thread mid-fold, digesting a state
that never existed; a resizable buffer can shrink under a live reader; a
cross-realm view fails the same-realm brand. The ruling is REJECTION, not
support — no shared-memory publication protocol, no cross-realm bridging.
`requireOrdinaryBytes(bytes, fail)` (bytes.js) enforces it across the DERIVED
byte-intake surface — the reader (behind the four sequential decoders),
`bytesToHex`, `typedArrayByteLength`, `decodeTraceRecord`, the
`encodeTraceRecord` output buffer, `compareTraces` record entries,
`bytesEqual` (both sides), and — inline, preserving each module's zero-import
ruling — `deserializeGenotype` and `fnv1aFold`. Round 12 wrote "at every
intake seam" while gating TWO of these; the corrected claim is pinned, not
prose: `tests/ownership-boundary.test.js` (0b) derives the module set from
the byte-family lint block and the export set from the real namespaces, and
every function export must classify as 'gated' (its thunk run against all
three fancy stores) or 'no-byte-intake' with a stated reason (§Round 13). The
intrinsic geometry getters (round 8) and this gate are complementary: the
first defeats a caller that LIES about shape, the second a caller whose
STORAGE is transient.

**THE FNV-IDENTITY RULING (JP).** *FNV-1a32 is a drift/lock digest and the
cross-platform determinism comparator, NOT persistent content identity.* A
32-bit hash collides by the birthday bound (~50% at ~77k artifacts; one appears
in seconds), so it must never be leaned on for artifact identity, dedup,
provenance, or equality of two independently-supplied artifacts. It is adequate
where it is used: the determinism gate compares the SAME input recomputed across
Node/Chromium, never two different artifacts, so a collision cannot fool it —
the "except cross-platform determinism" clause is satisfied. Verified: nowhere
concludes two byte arrays are EQUAL from their digests when the bytes are in
hand — `bytesEqual` compares bytes directly, and every digest `===` is against a
golden literal or a same-source dual-state agreement. A collision-resistant
digest (SHA-256) for persisted evolution history is DEFERRED to Phase 1B,
introduced only when artifact identity is actually needed; adding it now would
move no lock and serve no consumer.

**The generalization, one more notch.** Round 10: a test written to the fix is
not enforcement of the rule. Round 11: enforcement scoped to a round's mechanism
is still enforcement written to the fix. Round 12: an adversary whose success
criterion is *finding a break* attacks the guarantees, not the sites — and it
found that the previous round's claims, comments, and even its own new code were
where the next defects hid. The invariant is only as strong as the surface the
enforcement actually covers, and the honest way to know that surface is to try
to break it.

## Round 13: external-review validation — the storage closure and the first explicit deferral

An external review of the full PR history was validated claim-by-claim at
head; both of its blockers were CONFIRMED by direct execution. JP ruled: fix
Blocker 1, explicitly defer Blocker 2.

**Blocker 1 (FIXED): the byte-storage gate covered two seams while the doc
said "every intake seam."** Executed at head: `fnv1aFold(state, detached)`
returned the state UNCHANGED — a digest attesting zero bytes it was never
handed, the exact motivating failure this document itself cites — and
`bytesEqual` reported a detached `[1,2,3]` EQUAL to a fresh empty array and
to a detached `[9,9]`. Five seams closed (fnv1aFold inline; the gated
`typedArrayByteLength`; `bytesEqual` through it; the `encodeTraceRecord`
output buffer; `compareTraces` record entries — where a resizable entry
shrinking between the size identity and the copy compared all-zero bytes that
never existed, reported as "identical"). Fancy storage at a compare seam
THROWS as invalid input; it is never reported as a divergence, because it is
not one. The enforcement is DERIVED, not enumerated:
`tests/ownership-boundary.test.js` (0b) takes the module set from the
byte-family lint block, the export set from the real namespaces, and requires
every function export classified — 'gated' rows carry an invoke thunk run
against detached/SharedArrayBuffer/resizable (all must throw); exemptions
state a reason. The two seams C12 gated but never tested
(`decodeTraceRecord`, `deserializeGenotype`) received their batteries. Seven
mutations, all bite. This is the round-11 lesson applied to round 12's own
claim: a rule declared universal and enforced at discovered sites is not
closed until the surface is derived.

**Blocker 2 (EXPLICITLY DEFERRED — JP's ruling): mutable trace evidence after
attestation.** The checked failure mode, stated up front per the round-8
register discipline: `TraceWriter.finish()` returns its LIVE private
`#records` and `#checkpoints` arrays, and neither `analyzeTrace` nor
`compareTraces` re-verifies caller-held record bytes against the trace's
digest, recordCount, byteCount, or checkpoint states. A caller can therefore
mutate a record's bytes, a checkpoint state, or array membership AFTER the
digest was computed, and offline forensics will describe evidence the digest
never attested. The rounds 11–12 copy-on-intake fixes defend the WALK
(mid-comparison mutation), not the PROVENANCE (post-attestation
substitution) — a different axis, and C15's storage gate is a third
(backing-store lifetime of ordinary bytes).

Why deferral is sound: this surface is DIAGNOSTIC-only. No lock, no fitness
path, and no selection path consumes `analyzeTrace` or `compareTraces`
output; production traces are produced and analyzed inside one process's
`runEvaluation` result. Corrupting caller-held diagnostic evidence deceives
only its holder. The fix belongs to Phase 1B's persisted-history format —
the same milestone as the strong-digest deferral — because evidence lifetime
becomes a real contract exactly when traces are persisted and replayed across
processes. The recorded decision space, either of:

- **Value model** — `finish()` returns immutable representations (copied
  frozen checkpoint rows; records as one canonical concatenated artifact or
  copied buffers).
- **Verified-evidence model** — a `verifyFullTrace(trace)` that recomputes
  digest, counts, ordering, and checkpoint states; `analyzeTrace` accepts
  only its verified/module-owned result.

Freezing the outer arrays alone is insufficient — `Uint8Array` contents stay
mutable. The deferral is marked at both sites (`finish()`, `analyzeTrace`)
and in the (0b) classification (`TraceWriter`'s exemption row names it).

## Round 14: two fixes and one honest deferral (avoiding the whack-a-mole trap)

A second external review after the round-13 push reported three findings.
Two closed as real structural fixes; the third — the P1 blocker — was
initially attempted as a fix, adversarially checked, found to be
whack-a-mole, and reverted in favor of an explicit deferral.

**runRealizedEvaluationLoop caller-collection ownership (FIXED).** The seam
consumed `realized.map` / `.flatMap` / for-of and declared
`callerCollections: []` on the reasoning "usually called with module
output" — which effectively exempted it from every hostile-collection
battery. Executed at HEAD: a genuine Array with an own no-op `.map`
returned `vehicles.length === 0` while the world stepped maxSteps and
`counts.staticColliders` matched — silent contradiction of every documented
ownership rule. Fixed by captured-length integer walks over both `realized`
and each `rec.wheels`; classification updated honestly to
`callerCollections: ['realized', 'realized[].wheels']`. Two regressions in
`tests/evaluation-core.test.js` mutation-verified. Not whack-a-mole:
replacing method calls with indexed loops closes the class structurally at
that seam.

**Cross-realm coverage (P2 finding, FIXED).** Round 13's storage battery
ran detached / SAB / resizable but not cross-realm — the fourth named
policy axis. A Node `vm.runInNewContext('new Uint8Array(128)')` view now
runs through the (0b) FANCY_STORES matrix against all 12 gated seams, and a
same-origin iframe view runs through the pinned Chromium codec smoke. A
drift from `instanceof Uint8Array` to a broader brand check would need
active cross-realm rejection to keep both green.

**The compare-class attack: DEFERRED (JP's ruling).** `compareTraces`
silently returned `null` for streams that genuinely differed when an
ordinary accessor descriptor on `records[i]` — no Proxy, no exotic
storage — mutated the opposing side to match. Same shape reproduced in
`compareCheckpoints` via field accessors on entry objects. This is a real
false-identical vulnerability, executed live against HEAD.

**Why this was deferred rather than fixed.** A candidate fix installed
accessor-descriptor pre-scans (`Object.getOwnPropertyDescriptor` never
invokes getters by spec) on `records[i]` and on entry fields. The
reviewer's specific attack was defeated. JP asked "are we sure this isn't
whack-a-mole?" — and I attacked my own fix. An accessor one level down
still worked:

```js
// Passes the round-14 pre-scan: records[0] is a plain data property.
// records[0].translation.x is a getter that runs during encodeTraceRecord's
// validateRecord walk, and mutates actEnv.records[1] to match exp[1].
records[0] = { ...recA, translation: { get x() { actEnv.records[1] = recB; return 1; }, y: 0, z: 0 } };
// Result: compareTraces returns null for streams that ORIGINALLY differed at 1.
```

Executed. Reproduced silent-null. Refusing accessors at each discovered
location is by definition site-by-site enumeration, not class closure —
there are always more nested keys the pre-scan does not cover. The
candidate fix was reverted in the same PR.

**Two candidate atomic architectural fixes, recorded for Phase 1B.** Either
one closes the class structurally at compareTraces / compareCheckpoints,
without ever having to enumerate specific descriptor locations:

- **(A) Hard API boundary** — `compareTraces` accepts only pre-encoded
  Uint8Array records (no plain records, no envelope accessors). All
  caller-code-triggering conversion happens BEFORE both sides are live in
  the same call. The test API convenience of hand-writing plain records is
  migrated to a pre-encoding helper the caller runs first. Mechanically
  precludes cross-side mutation because no caller code from either side
  runs while both are in scope.
- **(B) Total deep pre-scan** — recursively refuse accessor descriptors on
  every nested key of both sides before comparison begins. Heavier
  discipline, but preserves the plain-record convenience. Still relies on
  enumerating "what counts as caller-reachable" (Symbol properties,
  prototype-chain edge cases).

**Why deferral is sound.** This surface is DIAGNOSTIC-only. No lock, no
fitness path, and no selection path consumes `compareTraces` /
`compareCheckpoints` return values; production traces are produced and
compared inside one process's test tooling. A silent false-identical
deceives only its own caller. Same reasoning as the round-13
mutable-trace-evidence deferral, and the fix belongs to the same Phase-1B
persisted-history milestone. The failure shape is now stated at both call
sites so the deferral cannot silently rot into forgotten prose. Test
tooling that must trust a comparison is expected to encode both sides via
`encodeTraceRecord()` before calling, which mechanically closes the class
for that caller (option A applied per-caller).

**The generalization the round produced.** Round 11 said "enforcement
scoped to a round's MECHANISM is still enforcement written to the fix."
Rounds 12 and 13 each repeated that lesson one notch up. Round 14 caught
its own compareTraces fix falsifying it — the pattern the review was
warning about, reproduced live inside the fix meant to close it. The
escape from the ladder is not "one more clever check"; it is to recognize
when a class needs a real architectural boundary (defer to when it can be
made) versus a site-level guarantee (fix now). This round did both — the
runRealizedEvaluationLoop fix is structural at its seam, and the compare
class is deferred with two named candidate architectures for the milestone
that will need them.

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

**Seeds allocated:** 20260732 — the genotype boundary-value sprinkle corpus
(`tests/genotype-codec.test.js`); 20260733 — the codec round-trip property
corpus (`tests/codec-roundtrip-property.test.js`).

## Reproduce

```
npm run lint
npm test                      # the zero-lock-movement proof (every lock-bearing file runs here)
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
