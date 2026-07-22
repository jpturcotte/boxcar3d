// Canonical evolution lineage v1 — how one generation's individuals came to
// exist, as bytes.
//
// A generation record's lineage answers exactly one question per individual:
// where did this genome come from, and (for a mutated child) what did the
// operator actually do to it. It is a SEPARATE component from the population
// snapshot for the same reason the initialization manifest is separate from
// the snapshot: content and provenance are different contracts, and identical
// content must hash identically no matter how it was produced.
//
// LINEAGE ENCODING v1 (explicit little-endian walk; EVOLUTION_LINEAGE_VERSION
// bumps on ANY change to this order or any field meaning):
//   u16 lineageVersion
//   u32 generationIndex
//   u32 individualCount                (>= 1)
//   per individual, individualId STRICTLY ASCENDING:
//     u32 individualId
//     u32 parentIndividualId           (0xffffffff ONLY for initialized rows)
//     u8  origin                       (LINEAGE_ORIGINS index)
//     u32 x 11 accounting counters, in LINEAGE_ACCOUNTING_KEYS order
//
// THE PARENT SENTINEL. 0xffffffff means "no parent" and is reserved: an
// initialized row MUST carry it and a non-initialized row must NOT, in both
// directions. A real id of 0xffffffff is rejected rather than allowed to alias
// the sentinel — unreachable under the v1 caps (256 x 1024 ids), and that is
// exactly why the check is cheap and must exist before the caps ever move.
//
// THE ACCOUNTING CONTRACT. Initialized and elite-copy rows require ALL eleven
// counters to be zero: an elite is a byte-identical copy that consumed no RNG,
// so a non-zero counter on one is a contradiction, not a detail.
// Continuous-mutation rows carry the EXACT frozen accounting the PR 2 operator
// returned — copied field by field in declared order, never spread from the
// caller's object, so a row attests the eleven numbers this module read.
//
// Cross-generation agreement (lineage ids == population ids; every
// non-initialized parent exists exactly once in the PRECEDING generation) is
// `crossCheckLineage`, because it needs data this codec does not own.

import { createByteReader, typedArrayByteLength } from './bytes.js';
import {
  checkedAdd, checkedMultiply, evolutionFail, isEvolutionUint32,
} from './evolution-contract.js';

export const EVOLUTION_LINEAGE_VERSION = 1;

/** Wire order: the index IS the encoded origin byte. */
export const LINEAGE_ORIGINS = Object.freeze(['initialized', 'eliteCopy', 'continuousMutation']);

/** The reserved "no parent" u32. Only an `initialized` row may carry it. */
export const LINEAGE_NO_PARENT = 0xffffffff;

/**
 * The eleven mutation counters, in WIRE ORDER. This list is also the exact key
 * set `mutateContinuousGenotype` freezes into its `accounting` record — a
 * mismatch in either direction fails loud, so an operator that grows a counter
 * cannot silently stop being attested.
 */
export const LINEAGE_ACCOUNTING_KEYS = Object.freeze([
  'eligibleContinuousLeafCount',
  'selectedLeafCount',
  'rawChangedLeafCount',
  'clampedLeafCount',
  'repairChangedLeafCount',
  'repairIntroducedLeafCount',
  'repairErasedLeafCount',
  'repairRedirectedLeafCount',
  'finalChangedLeafCount',
  'rawByteDeltaCount',
  'finalByteDeltaCount',
]);

const LINEAGE_HEADER_BYTES = 2 + 4 + 4; // 10
const LINEAGE_ROW_BYTES = 4 + 4 + 1 + LINEAGE_ACCOUNTING_KEYS.length * 4; // 53

/** Exact byte length of a lineage stream carrying `count` rows. */
export function lineageByteLength(count) {
  return checkedAdd(
    LINEAGE_HEADER_BYTES,
    checkedMultiply(LINEAGE_ROW_BYTES, count, 'lineage row payload'),
    'lineage byte length',
  );
}

function fail(path, value) {
  evolutionFail('invalidConfig', `lineage: invalid ${path} (${String(value)})`, { path });
}

function decodeFail(path, value) {
  evolutionFail('malformedHistory', `lineage: invalid encoded lineage at ${path} (${String(value)})`, { path });
}

/** The all-zero accounting an initialized or elite-copy row must carry. */
export function zeroLineageAccounting() {
  const out = {};
  for (let i = 0; i < LINEAGE_ACCOUNTING_KEYS.length; i += 1) out[LINEAGE_ACCOUNTING_KEYS[i]] = 0;
  return Object.freeze(out);
}

// ONE capture per row. Every field a check consumes is read into a
// module-owned local before any check runs, and everything after — the
// ordering rule, the origin/parent coherence rule, the encoder's write pass —
// consumes only the capture. The `validatedRows` -> `encodeRows` split is the
// population.js `validatedMembers` ruling applied here: what was validated is,
// by construction, what is attested.
function captureAccounting(source, path, mustBeZero) {
  if (typeof source !== 'object' || source === null) fail(`${path}.accounting`, source);
  // Exact key-set equality against the declared walk, checked on a captured
  // enumeration. A caller record with an extra key is a different contract and
  // would be silently dropped by an indexed read of the declared keys alone.
  const keys = Object.keys(source);
  if (keys.length !== LINEAGE_ACCOUNTING_KEYS.length) {
    fail(`${path}.accounting`, `keys [${keys}] must equal the declared [${LINEAGE_ACCOUNTING_KEYS}]`);
  }
  const values = [];
  for (let i = 0; i < LINEAGE_ACCOUNTING_KEYS.length; i += 1) {
    const key = LINEAGE_ACCOUNTING_KEYS[i];
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      fail(`${path}.accounting.${key}`, 'missing');
    }
    const value = source[key];
    if (!isEvolutionUint32(value)) fail(`${path}.accounting.${key}`, value);
    if (mustBeZero && value !== 0) {
      fail(`${path}.accounting.${key}`, `${value} — an ${'initialized/eliteCopy'} row consumed no operator work and must carry zero counters`);
    }
    values.push(value);
  }
  return values;
}

function validatedRows(lineage) {
  if (typeof lineage !== 'object' || lineage === null) fail('lineage', lineage);
  const lineageVersion = lineage.lineageVersion;
  const generationIndex = lineage.generationIndex;
  const individuals = lineage.individuals;
  if (lineageVersion !== EVOLUTION_LINEAGE_VERSION) fail('lineageVersion', lineageVersion);
  if (!isEvolutionUint32(generationIndex)) fail('generationIndex', generationIndex);
  if (!Array.isArray(individuals)) fail('individuals', individuals);
  // Bound captured before the walk: the body reads caller elements, and a
  // genuine Array's `length` is writable (the round-11 loop-bound class).
  const count = individuals.length;
  if (count === 0) fail('individuals', individuals);
  const rows = [];
  let previousId = -1;
  for (let i = 0; i < count; i += 1) {
    const row = individuals[i];
    if (typeof row !== 'object' || row === null) fail(`individuals[${i}]`, row);
    const individualId = row.individualId;
    const parentIndividualId = row.parentIndividualId;
    const origin = row.origin;
    const accountingSource = row.accounting;
    if (!isEvolutionUint32(individualId)) fail(`individuals[${i}].individualId`, individualId);
    if (individualId === LINEAGE_NO_PARENT) {
      fail(`individuals[${i}].individualId`, `${individualId} is the reserved no-parent sentinel`);
    }
    if (individualId <= previousId) {
      fail(`individuals[${i}].individualId`, `${individualId} must be strictly ascending (previous ${previousId})`);
    }
    previousId = individualId;
    const originIndex = LINEAGE_ORIGINS.indexOf(origin);
    if (originIndex === -1) fail(`individuals[${i}].origin`, origin);
    // The sentinel rule, both directions. An initialized row has no parent; a
    // derived row must name one, and it must not be the sentinel in disguise.
    if (originIndex === 0) {
      if (parentIndividualId !== null) {
        fail(`individuals[${i}].parentIndividualId`, `${String(parentIndividualId)} — an initialized row has no parent (use null)`);
      }
    } else {
      if (!isEvolutionUint32(parentIndividualId) || parentIndividualId === LINEAGE_NO_PARENT) {
        fail(`individuals[${i}].parentIndividualId`, parentIndividualId);
      }
    }
    const accounting = captureAccounting(accountingSource, `individuals[${i}]`, originIndex !== 2);
    rows.push({
      individualId,
      parentIndividualId: originIndex === 0 ? LINEAGE_NO_PARENT : parentIndividualId,
      originIndex,
      accounting,
    });
  }
  return { generationIndex, rows };
}

/**
 * Validate lineage shape, ordering, origin/parent coherence, and accounting
 * domains. Returns nothing; it is a gate, not an attestation (the
 * validate-vs-attest distinction population.js draws). `serializeLineage` runs
 * the same walk and emits from ITS capture.
 */
export function validateLineage(lineage) {
  validatedRows(lineage);
}

function encodeRows(generationIndex, rows) {
  const view = new DataView(new ArrayBuffer(lineageByteLength(rows.length)));
  let o = 0;
  view.setUint16(o, EVOLUTION_LINEAGE_VERSION, true); o += 2;
  view.setUint32(o, generationIndex, true); o += 4;
  view.setUint32(o, rows.length, true); o += 4;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    view.setUint32(o, row.individualId, true); o += 4;
    view.setUint32(o, row.parentIndividualId, true); o += 4;
    view.setUint8(o, row.originIndex); o += 1;
    for (let k = 0; k < row.accounting.length; k += 1) {
      view.setUint32(o, row.accounting[k], true); o += 4;
    }
  }
  // receiver `view` is the module-owned DataView allocated above, not caller data.
  // eslint-disable-next-line no-restricted-syntax
  return new Uint8Array(view.buffer);
}

/** Serialize a lineage record (see the encoding walk above). */
export function serializeLineage(lineage) {
  const { generationIndex, rows } = validatedRows(lineage);
  return encodeRows(generationIndex, rows);
}

/**
 * The exact inverse of serializeLineage. Fail-loud, never repairing: the
 * version must be current (encoders write the current constant
 * unconditionally, which is what makes re-encode reproduce the bytes), ids
 * must be strictly ascending IN THE STREAM, the origin byte must be a declared
 * index, the parent sentinel rule holds in both directions, an
 * initialized/elite row's counters must all be zero, and the total length must
 * be the exact identity for the declared count.
 *
 * Returned FROZEN: a lineage is an attestation — a digest is folded over these
 * bytes — so letting a caller mutate the decoded record would let it disagree
 * with what it attests (the spec/vector/manifest decoders' ruling).
 */
export function deserializeLineage(bytes) {
  const r = createByteReader(bytes, decodeFail);
  const lineageVersion = r.u16('lineageVersion');
  if (lineageVersion !== EVOLUTION_LINEAGE_VERSION) {
    evolutionFail('unsupportedVersion', `lineage: unsupported lineageVersion ${lineageVersion}`, { lineageVersion });
  }
  const generationIndex = r.u32('generationIndex');
  const count = r.u32('individualCount');
  if (count < 1) decodeFail('individualCount', count);
  // The row stride is fixed, so the total length is an exact identity —
  // checked before the row loop so a lying count reports as a length mismatch
  // rather than a truncation deep inside a row (the fitness-vector precedent).
  const expected = lineageByteLength(count);
  const actual = typedArrayByteLength(bytes);
  if (actual !== expected) {
    decodeFail('byteLength', `${actual} (expected ${expected} for count ${count})`);
  }
  const individuals = [];
  let previousId = -1;
  for (let i = 0; i < count; i += 1) {
    const individualId = r.u32(`individuals[${i}].individualId`);
    if (individualId === LINEAGE_NO_PARENT) {
      decodeFail(`individuals[${i}].individualId`, `${individualId} is the reserved no-parent sentinel`);
    }
    if (individualId <= previousId) {
      decodeFail(`individuals[${i}].individualId`, `${individualId} must be strictly ascending (previous ${previousId})`);
    }
    previousId = individualId;
    const parentRaw = r.u32(`individuals[${i}].parentIndividualId`);
    const originIndex = r.u8(`individuals[${i}].origin`);
    if (originIndex >= LINEAGE_ORIGINS.length) decodeFail(`individuals[${i}].origin`, originIndex);
    if (originIndex === 0) {
      if (parentRaw !== LINEAGE_NO_PARENT) {
        decodeFail(`individuals[${i}].parentIndividualId`, `${parentRaw} — an initialized row must carry the no-parent sentinel`);
      }
    } else if (parentRaw === LINEAGE_NO_PARENT) {
      decodeFail(`individuals[${i}].parentIndividualId`, 'a derived row must name a parent');
    }
    const mustBeZero = originIndex !== 2;
    const accounting = {};
    for (let k = 0; k < LINEAGE_ACCOUNTING_KEYS.length; k += 1) {
      const key = LINEAGE_ACCOUNTING_KEYS[k];
      const value = r.u32(`individuals[${i}].accounting.${key}`);
      if (mustBeZero && value !== 0) {
        decodeFail(`individuals[${i}].accounting.${key}`,
          `${value} — a ${LINEAGE_ORIGINS[originIndex]} row must carry zero counters`);
      }
      accounting[key] = value;
    }
    individuals.push(Object.freeze({
      individualId,
      parentIndividualId: originIndex === 0 ? null : parentRaw,
      origin: LINEAGE_ORIGINS[originIndex],
      accounting: Object.freeze(accounting),
    }));
  }
  r.expectEnd('lineage');
  return Object.freeze({
    lineageVersion,
    generationIndex,
    individuals: Object.freeze(individuals),
  });
}

/**
 * Cross-generation agreement, which the codec cannot check on its own:
 *
 *  - lineage ids must EXACTLY equal `individualIds` (the paired population's
 *    ids, ascending) — same length, same values, same order;
 *  - `generationIndex` must be the record's own index;
 *  - every non-initialized parent must exist in `previousIndividualIds`, and
 *    generation 0 must be all-initialized (previousIndividualIds === null).
 *
 * Both id arrays are the CALLER's; they are walked by index against captured
 * bounds and never mutated. Raises `malformedHistory` on disagreement, because
 * every reachable caller (the transition and replay) is checking a record that
 * claims to be well-formed.
 */
export function crossCheckLineage(lineage, generationIndex, individualIds, previousIndividualIds) {
  const rows = lineage.individuals;
  const rowCount = rows.length;
  const idCount = individualIds.length;
  if (lineage.lineageVersion !== EVOLUTION_LINEAGE_VERSION) {
    evolutionFail('unsupportedVersion', `lineage: unsupported lineageVersion ${lineage.lineageVersion}`,
      { lineageVersion: lineage.lineageVersion });
  }
  if (lineage.generationIndex !== generationIndex) {
    evolutionFail('malformedHistory',
      `lineage: generationIndex ${lineage.generationIndex} does not match the record's ${generationIndex}`,
      { lineageGenerationIndex: lineage.generationIndex, generationIndex });
  }
  if (rowCount !== idCount) {
    evolutionFail('malformedHistory',
      `lineage: ${rowCount} rows for a population of ${idCount}`,
      { rowCount, populationCount: idCount, generationIndex });
  }
  // ONE capture of every row and every id, before either check runs. The two
  // walks below used to index `rows` and `individualIds` independently — and
  // the diagnostic re-read `rows[i].individualId` a third time — so the id
  // that was compared need not have been the id that was reported, and the
  // parent walk could see a different row than the agreement walk approved.
  // In production these are decoded, frozen, module-owned records, so nothing
  // was reachable; the rule is enforced anyway, because "unreachable today"
  // is exactly how the previous rounds' defects were argued into existence.
  const captured = [];
  const expectedIds = [];
  for (let i = 0; i < rowCount; i += 1) {
    const row = rows[i];
    captured.push({
      individualId: row.individualId, parentIndividualId: row.parentIndividualId, origin: row.origin,
    });
    expectedIds.push(individualIds[i]);
  }
  for (let i = 0; i < rowCount; i += 1) {
    if (captured[i].individualId !== expectedIds[i]) {
      evolutionFail('malformedHistory',
        `lineage: row ${i} id ${captured[i].individualId} does not match population id ${expectedIds[i]}`,
        { index: i, lineageId: captured[i].individualId, populationId: expectedIds[i], generationIndex });
    }
  }
  const parents = new Set();
  if (previousIndividualIds !== null) {
    const previousCount = previousIndividualIds.length;
    for (let i = 0; i < previousCount; i += 1) parents.add(previousIndividualIds[i]);
  }
  for (let i = 0; i < rowCount; i += 1) {
    const row = captured[i];
    if (row.origin === 'initialized') {
      if (previousIndividualIds !== null) {
        evolutionFail('malformedHistory',
          `lineage: row ${i} (id ${row.individualId}) is 'initialized' in generation ${generationIndex}, which has a predecessor`,
          { index: i, individualId: row.individualId, generationIndex });
      }
      continue;
    }
    if (previousIndividualIds === null) {
      evolutionFail('malformedHistory',
        `lineage: row ${i} (id ${row.individualId}) has origin '${row.origin}' in generation 0, which has no predecessor`,
        { index: i, individualId: row.individualId, origin: row.origin, generationIndex });
    }
    if (!parents.has(row.parentIndividualId)) {
      evolutionFail('malformedHistory',
        `lineage: row ${i} (id ${row.individualId}) names parent ${row.parentIndividualId}, which is not in generation ${generationIndex - 1}`,
        { index: i, individualId: row.individualId, parentIndividualId: row.parentIndividualId, generationIndex });
    }
  }
}
