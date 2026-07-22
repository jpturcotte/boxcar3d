// The shared evolution contract: stable error codes, the module-owned error
// type, the terminal-reason enum, and the engine/policy versions and resource
// ceilings the whole PR 3 family agrees on.
//
// WHY THIS MODULE EXISTS (a deliberate addition to the plan's file list). The
// plan names evolution-run.js, evolution-lineage.js, evolution-history.js and
// evolution-replay.js. Three things are shared by all four — the error
// taxonomy, the terminal enum (which the generation payload ENCODES, so the
// history codec needs it, and which the transition DECIDES, so the run needs
// it), and the caps — and every placement inside one of those four creates an
// import cycle or forces a file to land a commit early. A tiny leaf module
// with no imports of its own is the honest shape: the contract every layer
// binds, owned by none of them.
//
// ERROR RULING: public callers branch on `code`, never on message text. Every
// code below is stable and appears in the documented taxonomy; a lower-level
// module error (assembly, population, population-evaluation, bytes) may ride
// along as `cause`, but it is never the thing a caller is asked to parse.
// `context` is a frozen, module-owned record of scalars — never caller objects,
// never bytes — so an error can be logged or serialized without dragging a
// live reference (or a 64 MiB buffer) into a diagnostic.

/**
 * The complete public error taxonomy. Ordered by the stage that raises it:
 * configuration, run lifecycle, resources, then the framing/identity/replay
 * ladder (which is deliberately fine-grained — a resume failure must say WHICH
 * check failed, because "the history is bad" localizes nothing).
 */
export const EVOLUTION_ERROR_CODES = Object.freeze([
  'invalidConfig',
  'historyUnavailable',
  'advanceInProgress',
  'resourceLimitExceeded',
  'malformedHistory',
  'unsupportedVersion',
  'componentDigestMismatch',
  'generationChainMismatch',
  'historyDigestMismatch',
  'staleOrWrongArtifact',
  'runtimeVersionMismatch',
  'replayDivergence',
]);

const CODE_SET = new Set(EVOLUTION_ERROR_CODES);

/**
 * The module-owned error. `code` is one of EVOLUTION_ERROR_CODES; `context` is
 * a frozen scalar record. An unknown code is itself a programming error and
 * fails loud here rather than shipping an unbranchable failure to a caller.
 */
export class EvolutionError extends Error {
  constructor(code, message, context = {}, cause = undefined) {
    if (!CODE_SET.has(code)) {
      throw new Error(`evolution: unknown error code (${String(code)}) — declare it in EVOLUTION_ERROR_CODES`);
    }
    super(`evolution [${code}]: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'EvolutionError';
    this.code = code;
    // Own the context: copy the caller's keys by enumeration into a frozen
    // plain record. Nothing here may retain a live reference to run state, to
    // a history buffer, or to a caller object — an error is a diagnostic, not
    // a back door into private bytes.
    const owned = {};
    for (const key of Object.keys(context)) {
      const value = context[key];
      const kind = typeof value;
      owned[key] = (value === null || kind === 'number' || kind === 'string'
        || kind === 'boolean' || kind === 'undefined') ? value : String(value);
    }
    this.context = Object.freeze(owned);
  }
}

/** Raise a taxonomy error. The one throw idiom in the evolution family. */
export function evolutionFail(code, message, context = {}, cause = undefined) {
  throw new EvolutionError(code, message, context, cause);
}

/**
 * The terminal-reason enum, in WIRE ORDER (the index is the encoded byte).
 * 'none' is index 0, so a non-terminal record encodes a zero byte.
 *
 * PRECEDENCE (evaluated after evaluation and pool construction, exactly once,
 * BEFORE the record is encoded — a terminal is never discovered after a digest
 * exists, and a terminal record is never appended twice):
 *   1. noSelectableParents     — the selectable pool is empty
 *   2. generationLimitReached  — this record satisfies maxGenerations
 *   3. individualIdExhausted   — a full next population cannot receive fresh
 *                                uint32 ids
 *   4. none
 *
 * Under the v1 caps (256 x 1024 << 2^32) with generation-0 ids starting at
 * zero, exhaustion is mathematically unreachable. The enum and the checked
 * arithmetic stay so a future cap or version change fails SAFE rather than
 * wrapping, and so malformed imported state is rejected rather than normalized.
 */
export const TERMINAL_REASONS = Object.freeze([
  'none', 'noSelectableParents', 'generationLimitReached', 'individualIdExhausted',
]);

/** The deterministic generation/replacement engine's semantic version. */
export const EVOLUTION_ENGINE_VERSION = 1;

/**
 * The evolution POLICY version: replacement shape (elites first in rank order,
 * then mutated children in ascending new-id order), id allocation, terminal
 * precedence, and RNG stream ownership. Distinct from the engine version so a
 * pure implementation change and a semantic change are separable.
 */
export const EVOLUTION_POLICY_VERSION = 1;

// --- Resource ceilings (v1, frozen by the plan) ------------------------------
//
// Checked BEFORE allocation everywhere, never after. The population ceiling is
// far below population-initializer's own MAX_POPULATION_SIZE (1e6) on purpose:
// that one only stops a heap abort, while evolution multiplies its population
// by up to 1024 generations of retained history.

export const MAX_EVOLUTION_POPULATION_SIZE = 256;
export const MAX_EVOLUTION_GENERATIONS = 1024;
// Product-level compute budget per generation. This is deliberately a total
// population × step budget rather than a narrow per-individual cap, so future
// gameplay can trade larger populations for shorter trials (or vice versa)
// without allowing a forged save to request billions of physics steps.
export const MAX_EVOLUTION_EVALUATION_WORK = 1_000_000;

/** Guard for any uint32 that reaches a wire field or an id computation. */
export function isEvolutionUint32(v) {
  return Number.isInteger(v) && v >= 0 && v <= 0xffffffff && !Object.is(v, -0);
}

/**
 * Checked addition for every size/id equation in the family. Returns the sum
 * only when both inputs and the result are safe non-negative integers;
 * otherwise raises `resourceLimitExceeded` with the operands in context.
 *
 * Not a nicety: the framing decoder derives offsets from caller-declared
 * lengths, and a silent float or a 2^53 overflow there turns a length check
 * into a no-op.
 */
export function checkedAdd(a, b, what) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0) {
    evolutionFail('resourceLimitExceeded', `${what}: non-integer or negative operand`, { a: String(a), b: String(b) });
  }
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    evolutionFail('resourceLimitExceeded', `${what}: sum exceeds the safe integer range`, { a, b });
  }
  return sum;
}

/** Checked multiplication, same contract as checkedAdd. */
export function checkedMultiply(a, b, what) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0) {
    evolutionFail('resourceLimitExceeded', `${what}: non-integer or negative operand`, { a: String(a), b: String(b) });
  }
  const product = a * b;
  if (!Number.isSafeInteger(product)) {
    evolutionFail('resourceLimitExceeded', `${what}: product exceeds the safe integer range`, { a, b });
  }
  return product;
}
