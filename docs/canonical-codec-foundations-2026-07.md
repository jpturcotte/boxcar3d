# Canonical Schema and Codec Foundations — Decision Memo (2026-07)

> The GA Phase-1B prep PR: a genotype-schema walker, lossless decoders for all
> five canonical byte formats, shared binary-reader helpers, and the canonical
> lowercase-hex JSON-safe byte representation — landed with **zero change to
> any valid canonical byte and zero lock movement**. Phase 1B needs to
> enumerate genotype leaves for parametric mutation without touching
> discrete/structural fields, persist and reload populations/specs/fitness
> vectors losslessly, and account for repair-induced gene changes; until now
> the repo had canonical *encoders* only (one decoder precedent:
> `decodeTraceRecord`). This memo records the rulings; it does not restate
> the module headers, which carry the per-format contracts.

## Terminology: serializer-as-authority, schema-as-mirror (R-A)

`serializeGenotype` remains the **canonical byte-layout authority** — it alone
produces the locked stream (the `24cd0dd5` corpus fingerprint), stays
structurally intact, and gained only the R-D wire-representability guard. The
new schema walker (`genotypeFieldWalk` / `forEachGenotypeField`,
`src/sim/assembly.js`) is a **validated metadata mirror** of that walk and the
future parametric-mutation traversal — it defines no bytes. The drift
triangle in `tests/genotype-schema.test.js` proves exact conformance three
ways: a hand-computed literal walk, stride derivation + exact tiling, and
perturb-one-leaf byte exclusivity against the real serializer. A later
deliberate PR may refactor the serializer onto the schema once this
foundation has landed — not this one (see Follow-up concerns).

## The walk, the four kinds, and the latent groups (R-G)

One frozen entry per serialized field, in serialization order:
`{ path, key, type, kind, byteOffset, byteLength }` (+ `value` from
`forEachGenotypeField`). 36 fixed-prefix entries + 16 per axle (68 at 2
axles; `genotypeByteLength(n) = 268 + 128n`). `type ∈ u16|u8|f64` is the wire
width; `kind` classifies the leaf for operators:

- **version** — the `u16` schema version at byte 0;
- **structural** — the two array-length fields (`segmentCount`, `axleCount`),
  not genes;
- **discrete** — enum band / boolean threshold / slot count, single-sourced
  off `DISCRETE_GENE_KEYS`: a parametric operator preserves these verbatim
  (crossing a decode boundary is a STRUCTURAL mutation, a separate operator
  class);
- **continuous** — everything a parametric operator may perturb.

Entries carry **no expression/latency metadata** (deliberate, R-G). The
latent-capable groups — the three fam blocks, the per-axle asym blocks, node
slots beyond the active `nodeCount` prefix, and `nodes[0].gap` — are
documented in prose (schema header + here): they are always serialized,
never dropped by repair, and future parametric mutation perturbs them freely
(heritable neutral variation), so decoding, conformance, mutation traversal,
and repair-change counting need no expression flag — adding one would create
a separately-driftable semantic contract. Expression diagnostics arrive only
when a concrete consumer needs them. The schema serves parametric mutation
**without any change to the genotype format**: `GENOTYPE_VERSION` stays 1,
the gene layout and both locked fingerprints are untouched.

## R-C: decoders mirror their encoder's validation — no more, no less

Each decoder re-runs **exactly** the validation its encoder runs at encode
time, so the exact-inverse claim holds across the encoder's whole output
domain. Nothing anywhere silently normalizes; malformed data throws the
owning module's `...invalid encoded <thing> at ${path} (${value})` idiom.

- **genotype**: encoder runs `validateGenotype` → decoder re-runs it
  (rejects NaN/Inf/out-of-[0,1]). Never repairs. Raw [0,1] genes preserved
  bit-exact, −0 included.
- **snapshot**: encoder runs `validatePopulation` → decoder re-runs it (dup
  ids, canonical-uint32 ids, the repair-identity canonicality tooth — a
  hand-crafted snapshot carrying a raw draw must not re-enter as heredity
  through the decode side door) PLUS strict-ascending STREAM order: canonical
  bytes are ascending by construction, `validatePopulation` sorts a copy and
  cannot see stream order, and an unsorted stream would re-serialize sorted,
  breaking byte identity.
- **manifest**: encoder runs `resolveConfig` before writing → decoder re-runs
  it (the S2 mask, duplicate categories, domain violations reject
  identically).
- **evaluation spec** — the deliberate ASYMMETRY: the encoder does NOT run
  `resolveSpec`; it validates wire shape and finiteness only. The decoder
  therefore mirrors the serializer's wire validation exactly and returns the
  decoded shape **without calling resolveSpec** — `resolveSpec` additionally
  enforces execution-level constraints (clearance ∈ (0, 0.05], the flat-pad
  spawn guard, wheelFriction ≥ 0) that the encoder never checks, so calling
  it would reject encoder-producible bytes and break the inverse.
  `evaluatePopulation` remains the execution gate (it resolves specs on
  entry). Encoded values return verbatim — all 33 terrain knobs are explicit
  in the bytes, so the decoder never injects a default.
- **fitness vector**: the decoder mirrors the encoder's member checks
  verbatim, including the contradiction tooth with the encoder's own `!== 0`
  comparison (NOT `Object.is` — a legally-encoded −0 fitness on an
  unselectable member is preserved, not rejected).

## R-D: the two wire-representability guards (fail loud, no valid byte moves)

Two counts were written as `u8` with no cap while their validators capped
nothing, so an out-of-wire-range value emitted a wire-inconsistent stream
(the pre-S0 hardening PR's fail-loud precedent):

- `serializeGenotype` — `axles.length <= 255` (mirrored in
  `genotypeByteLength`); a 256+-axle domain-valid genotype previously emitted
  a wrapped count byte.
- `serializeEvaluationSpec` — range `length <= 255` in the size pass; a
  >255-element terrain range previously emitted a length byte inconsistent
  with the true element count.

Other counts audited clean: manifest categoryCount ≤ 3 by `resolveConfig`;
snapshot genotype lengths are bounded after the axle guard; member counts are
u32. With these guards the encoders cannot emit wire-inconsistent streams, so
the inverse claim is honest across every valid canonical encoding.

## R-E: the additive digest-state input paths

The literal inverse invariants `serializeX(deserializeX(bytes)) === bytes`
for the fitness vector and the manifest need an additive input: those
encoders derive their digest states internally from `evaluation.spec` /
`initialization.population`, which the bytes do not carry. Both serializers
now wrap the derivation in a presence branch — the original statements run
VERBATIM when the object is present (a simultaneously declared state must
AGREE, else fail loud), and a canonical-uint32 declared state
(`evaluation.evaluationSpecDigestState` /
`initialization.populationSnapshotDigestState`) is bound when it is absent.
Grep-verified: no existing caller passes either field, so production branches
execute identical statements in identical order and the locked
`a6d04f75` / `7acb271d` digests provably stand (the standing
population-determinism gate is the tripwire).

## R-F: version rejection

Every decoder rejects any version field that differs from its current module
constant — encoders write current constants unconditionally, which is also
exactly what makes re-encoding reproduce the bytes. Reading historical
versions is future append-only work.

## Binary identity vs JSON-envelope semantics

The canonical byte streams are the ONLY identity layer: digests bind bytes,
never JSON (JSON serialization is not a canonical byte contract). When a
byte stream must travel inside JSON, the envelope carries **canonical
lowercase hex** (`bytesToHex`/`hexToBytes`, `src/sim/bytes.js`) plus a
`boxcar3d.<name>/<version>` schema tag — never raw bytes (not JSON-safe),
never base64 (a second, separately-driftable representation), never
digests-over-JSON. Hex is lowercase by ruling: `hexToBytes` rejects
uppercase, odd length, and non-hex with one declared pattern, so exactly one
string denotes one byte string. Shared strict reading lives in
`createByteReader` (bounds-checked cursor over one subarray-safe DataView;
errors always surface in the CALLING module's fail idiom).

## Lock status

**Every committed lock/fingerprint byte-identical; zero re-locks.** The
`24cd0dd5` corpus fingerprint, the noise/terrain/features fingerprints, the
A–D evaluation golden digests, and the population locks
(`cae92db7`/`7acb271d`/`1bc14aba`/`a6d04f75` + champion trace) all stand —
verified by the full suite, the 4-file determinism gate, and the pinned-
Chromium gate. As evidence of the inverse, the committed `a6d04f75` fitness
vector is reconstructed WITHOUT physics in `tests/evaluation-codec.test.js`
(snapshot state + the lock's own per-member literals + the reconstructed
spec) and decoded/re-serialized byte-identical — through the imported lock,
with zero duplicated digest literals. No format or version constant changed.
Seeds allocated: **20260732** (the special-value sprinkle codec corpus);
20260733 (test-local negative-case draw scan).

## Reproduce

- `npm test` — the full suite; the codec files are
  `tests/bytes.test.js`, `tests/genotype-schema.test.js`,
  `tests/genotype-codec.test.js`, `tests/population-codec.test.js`,
  `tests/evaluation-codec.test.js` (74 tests, all pure — no Rapier).
- `npm run test:determinism` — the narrow fresh-module gate (the R-E edits
  touch locked byte paths).
- `npm run test:browser` — the pinned-Chromium gate incl.
  `tests/browser/codec-smoke.test.js` (the new decoders run in the browser).

## Follow-up concerns (recorded, not fixed)

- `validateGenotype` itself still has **no axle-count cap** — the R-D
  serializer guard contains the wire hole. Tightening the validator is a
  behavior change for in-memory-only genotypes (repair would newly reject
  what it currently truncates via R1) and is a separate deliberate PR if
  ever wanted.
- Decoded evaluation specs are wire-valid but **not execution-validated**
  (deliberate, R-C): a decoded spec may carry an off-band clearance, an
  off-pad spawn, or a negative wheelFriction. `evaluatePopulation` remains
  the execution gate; persisting decoded specs into execution without
  re-resolving is a caller bug the codec does not prevent.
- `trace.js hexBytes` / `scripts/characterize-population.js bytesToHex`
  duplicate the new hex helper — left deliberately (a locked module and an
  out-of-ban script; migrating widens the blast radius for zero gain). Noted
  in `bytes.js`'s header.
- A later deliberate PR may refactor `serializeGenotype` onto the schema
  walker now that this foundation has landed (R-A) — the drift triangle is
  the conformance proof that would make it safe.
