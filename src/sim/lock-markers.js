// Structured determinism-lock mismatch markers — the protocol between the
// golden determinism tests and the engine-upgrade adjudicator.
//
// THE PROBLEM THIS SOLVES (the PR #20 cross-PR defect): the population
// fitness-vector digest is a MUTABLE production lock — a deliberate re-lock
// moves it (v1 'bded0d30' → v2 'a6d04f75') — and the engine-upgrade
// experiment's candidate-red inventory used to duplicate the then-current
// literal inside a failure-message regex ("to be 'bded0d30'"). The first
// deliberate re-lock silently staled that second copy: a real candidate run
// would then fail adjudication on exactly the permitted class-(c) golden
// movement. The correction principle: KEEP the production pin (the golden
// assertion still compares against the committed lock literal), ELIMINATE
// the duplicated pin. The determinism tests fail with a structured marker
// carrying both digests; the adjudicator parses it and validates `expected`
// against the authoritative lock module in the SAME checkout — one source of
// truth, zero copies, so a future re-lock cannot leave the adjudicator stale.
//
// THE MARKER IS DIAGNOSTIC, NEVER THE ASSERTION: both emitting tests attach
// it as the CUSTOM MESSAGE on a real `.toBe(lockDigest)` comparison (the
// staleness-teeth idiom), so the golden assertion still fails on a
// mismatched engine — the marker only makes that failure machine-parseable.
// Both vitest reporters render short custom messages untruncated (measured
// on the first heavy dispatch: truncation bites long DIFF VALUES, e.g. the
// `.toBeNull()` divergence strings, not custom messages).
//
// Consumers: tests/population-determinism.test.js and
// tests/browser/population-determinism.test.js (format), and
// scripts/compare-spike-runs.js (parse + authoritative validation). Pure,
// dependency-free, browser-safe, trivially inside the sim ESLint ban.

export const FITNESS_VECTOR_LOCK_MISMATCH = 'FITNESS_VECTOR_LOCK_MISMATCH';

const HEX8 = /^[0-9a-f]{8}$/;
// Every occurrence of the marker token; fields optional in the match so a
// token WITHOUT well-formed fields is detected as malformed, not invisible.
const MARKER_OCCURRENCE = /FITNESS_VECTOR_LOCK_MISMATCH(?: expected=([0-9a-f]{8}) actual=([0-9a-f]{8}))?/g;

function fail(path, value) {
  throw new Error(`lock-markers: invalid input at ${path} (${String(value)})`);
}

/** Format the marker. Inputs must be 8-hex lowercase digests — fail-loud. */
export function formatFitnessVectorLockMismatch(expected, actual) {
  if (typeof expected !== 'string' || !HEX8.test(expected)) fail('expected', expected);
  if (typeof actual !== 'string' || !HEX8.test(actual)) fail('actual', actual);
  return `${FITNESS_VECTOR_LOCK_MISMATCH} expected=${expected} actual=${actual}`;
}

/**
 * Parse a failure message (or any text) for the marker. Returns:
 *   { present: false, malformed: false, expected: null, actual: null }
 *       — the token never appears;
 *   { present: true, malformed: true, reason, expected: null, actual: null }
 *       — the token appears but is not parseable to ONE consistent
 *         (expected, actual) pair: missing/invalid fields, or duplicate
 *         occurrences that CONTRADICT each other. (Identical duplicates are
 *         tolerated — a reporter may echo the same message twice.)
 *   { present: true, malformed: false, expected, actual } — well-formed.
 * Trailing prose after the fields is fine (the emitting tests append a
 * human re-lock hint); the fields themselves must be exact 8-hex.
 */
export function parseFitnessVectorLockMismatch(text) {
  if (typeof text !== 'string') fail('text', text);
  const occurrences = [...text.matchAll(MARKER_OCCURRENCE)];
  if (occurrences.length === 0) {
    return { present: false, malformed: false, expected: null, actual: null };
  }
  const fieldless = occurrences.filter((m) => m[1] === undefined);
  if (fieldless.length > 0) {
    return {
      present: true,
      malformed: true,
      reason: 'marker token present without well-formed expected=/actual= 8-hex fields',
      expected: null,
      actual: null,
    };
  }
  const [first] = occurrences;
  const contradictory = occurrences.some((m) => m[1] !== first[1] || m[2] !== first[2]);
  if (contradictory) {
    return {
      present: true,
      malformed: true,
      reason: `contradictory duplicate markers (${occurrences.length} occurrences disagree)`,
      expected: null,
      actual: null,
    };
  }
  return { present: true, malformed: false, expected: first[1], actual: first[2] };
}
