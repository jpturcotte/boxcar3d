// The WebCrypto SHA-256 adapter — the ONE collision-resistant digest seam.
//
// WHY THIS LIVES IN src/platform AND NOT src/sim. The D7 ruling bans ambient
// globals in the simulation family, `crypto` explicitly among them, because
// `crypto.getRandomValues` is ambient randomness by another name and a
// simulation that reaches a host global is not a shareable seed. SHA-256 is
// the opposite kind of dependency: it is a pure, fully-specified function of
// its input bytes with no state, no entropy, and no platform variance, and it
// affects PERSISTED ARTIFACT IDENTITY rather than simulation state. Putting it
// behind a platform adapter keeps the sim ban absolute (no exception carved
// into src/sim) while still giving history one documented, enforced seam.
//
// WHY SHA-256 AND NOT THE HOUSE FNV. JP's standing ruling: FNV-1a32 is a
// drift/lock digest and the determinism comparator — it compares the SAME input
// recomputed across environments, where a collision cannot fool it — and is
// NEVER artifact identity. A 32-bit hash collides by the birthday bound in
// seconds. Persisted evolution history is exactly the case that ruling deferred
// to Phase 1B, so this is that deferral being DISCHARGED, not narrowed.
//
// WHAT A DIGEST HERE PROVES. Framing and self-consistency. NOT freshness, NOT
// authenticity, NOT provenance beyond the encoded header, and NOT that an
// artifact is the newest save. There are no signatures, no MACs and no
// encryption anywhere in this PR; a caller that needs staleness detection
// passes an externally-held expected digest to `resumeEvolutionRun`.
//
// THE BYTE RULES APPLY HERE TOO. This file is inside the byte-family lint
// scope (eslint.config.js shares BYTE_SAFETY_SYNTAX between the sim family and
// this adapter) and is classified in the derived export/role/storage/
// single-read inventories exactly like a sim byte module. What it does NOT
// inherit is the determinism block's global ban — that is the one documented
// exception, and it is the reason this module is here rather than there.

import { copyOrdinaryBytes } from '../sim/bytes.js';

/** The digest length this repo binds. Every returned digest is exactly this. */
export const SHA256_DIGEST_BYTES = 32;

/** Fixed. There is deliberately no algorithm parameter to get wrong. */
const DIGEST_ALGORITHM = 'SHA-256';

function fail(what, value) {
  throw new Error(`platform-sha256: invalid ${what} (${String(value)})`);
}

/**
 * Resolve WebCrypto's SubtleCrypto, or fail with a STABLE module error.
 *
 * Node 22 and every browser this repo targets expose `crypto.subtle` on the
 * global; a non-secure browser context does not. That difference must surface
 * as this module's own diagnosis, not as a `TypeError: Cannot read properties
 * of undefined` from three frames down — a history layer needs to be able to
 * say "this environment cannot verify artifacts" and mean it.
 */
function resolveSubtle() {
  const provider = typeof crypto === 'undefined' ? undefined : crypto;
  const subtle = provider === undefined || provider === null ? undefined : provider.subtle;
  if (subtle === undefined || subtle === null || typeof subtle.digest !== 'function') {
    throw new Error('platform-sha256: crypto.subtle is unavailable — SHA-256 artifact identity requires WebCrypto (Node 18+, or a secure browser context)');
  }
  return subtle;
}

/**
 * SHA-256 over ordinary caller bytes. Returns a Promise of a FRESH 32-byte
 * `Uint8Array`; the same input always yields a new array.
 *
 * NOT an `async function`, deliberately. The caller's bytes are validated and
 * COPIED in this function's synchronous prologue, before any `await` exists to
 * suspend at — so the copy-before-await rule is structural here rather than a
 * convention someone has to preserve while editing. It also means a hostile or
 * merely fancy storage shape (detached / SharedArrayBuffer / resizable /
 * cross-realm) is refused with a synchronous throw, which is what the derived
 * storage battery in tests/ownership-boundary.test.js can actually assert.
 *
 * A caller that mutates its own buffer after calling — including during the
 * await — cannot change the result, because the value being hashed is this
 * module's copy.
 */
export function sha256(bytes) {
  const input = copyOrdinaryBytes(bytes, fail); // synchronous: validate + own
  return digestOwned(input);
}

async function digestOwned(input) {
  const subtle = resolveSubtle();
  const result = await subtle.digest(DIGEST_ALGORITHM, input);
  if (result === null || typeof result !== 'object') fail('digest result', result);
  // WebCrypto returns a fresh ArrayBuffer. Wrap it, check the length that the
  // whole format depends on, and hand back an owned copy: a 32-byte identity
  // is load-bearing geometry in every record, so a platform returning
  // something else must fail here rather than shift every later field.
  const view = new Uint8Array(result);
  const length = view.length;
  if (length !== SHA256_DIGEST_BYTES) {
    fail('digest length', `${length} (expected ${SHA256_DIGEST_BYTES})`);
  }
  return copyOrdinaryBytes(view, fail);
}
