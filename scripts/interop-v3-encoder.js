// THE STRUCTURALLY INDEPENDENT v3 ENCODER — R2's oracle for the encoding and
// assembly layer.
//
//   node scripts/interop-v3-encoder.js
//
// re-encodes the committed interop manifest and compares the result to the
// committed fixture, byte for byte.
//
// INDEPENDENCE CONTRACT (enforced as a static tooth over this file's source
// by tests/interop-v3-independent.test.js): this tool imports NOTHING from
// src/ — not evolution-history.js, evolution-lineage.js, population.js,
// population-evaluation.js, nor the platform sha256 adapter. SHA-256 is
// Node's own `crypto`. Every layout literal below is TRANSCRIBED from the
// written format spec (the framing docblock of evolution-history.js and the
// fitness-vector v3 walk of population-evaluation.js), never imported — that
// is the point: if the implementation ever drifts from its documentation,
// this encoder's output stops matching the committed fixture.
//
// THE CLAIM IS DELIBERATELY NARROW. A fixture generation contains DERIVED
// population and lineage content; an independent encoder cannot recreate
// those without reimplementing the GA transition. The header, population,
// evaluation-metadata and lineage bytes are therefore CAPTURED LITERALS from
// the manifest — inputs, not evidence. What this tool attests independently
// is (a) the fitness-vector v3 member encoding from semantic values and
// (b) the downstream framing / digest assembly, both from the written spec.
//
// Node-only, outside the src/sim ESLint ban.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';

// --- Spec literals, transcribed from the written format spec ---------------

/** ASCII "BC3DEVO1" (outer framing magic). */
const MAGIC = Uint8Array.from([0x42, 0x43, 0x33, 0x44, 0x45, 0x56, 0x4f, 0x31]);
const HISTORY_VERSION = 1;
const GENERATION_RECORD_VERSION = 1;
/** Wire order of the terminal-reason byte. */
const TERMINAL_REASONS = ['none', 'noSelectableParents', 'generationLimitReached', 'individualIdExhausted'];
/** Wire order of the fitness-vector integrity-status byte. */
const INTEGRITY_STATUS = ['ok', 'nonFinite', 'numericalDivergence'];
/** The fixed component order of a generation payload. */
const COMPONENT_KINDS = ['population', 'evaluationMetadata', 'fitnessVector', 'lineage'];
/** The version block a v3 vector header writes; this encoder speaks ONLY v3. */
const VECTOR_VERSIONS = Object.freeze({
  fitnessVectorVersion: 3,
  fitnessPolicyVersion: 2,
  integrityPolicyVersion: 1,
  snapshotVersion: 1,
  evaluationSpecVersion: 1,
});
/** v3 geometry: 22-byte vector header, 48-byte member stride. */
const VECTOR_HEADER_BYTES = 22;
const VECTOR_MEMBER_BYTES = 48;
/** NUL-terminated ASCII digest domains, verbatim from the spec. */
const DOMAINS = {
  header: 'boxcar3d/evolution-history/header/v1\0',
  population: 'boxcar3d/evolution-history/population/v1\0',
  evaluationMetadata: 'boxcar3d/evolution-history/evaluation-metadata/v1\0',
  fitnessVector: 'boxcar3d/evolution-history/fitness-vector/v1\0',
  lineage: 'boxcar3d/evolution-history/lineage/v1\0',
  generation: 'boxcar3d/evolution-history/generation/v1\0',
  history: 'boxcar3d/evolution-history/history/v1\0',
};

// --- Little-endian primitives ----------------------------------------------

function fail(path, value) {
  throw new Error(`interop-v3-encoder: invalid ${path} (${String(value)})`);
}

const isU32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

function u8(value) { return Uint8Array.of(value); }

function u16le(value) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, true);
  return b;
}

function u32le(value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, true);
  return b;
}

function f64le(value) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, true);
  return b;
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const TEXT_ENCODER = new TextEncoder();

/** SHA256(domain || ...parts), via Node's own crypto — never the adapter. */
function domainDigest(domain, parts) {
  const hash = createHash('sha256');
  hash.update(TEXT_ENCODER.encode(DOMAINS[domain]));
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

// --- The independently encoded layer ----------------------------------------

/**
 * Encode a fitness-vector v3 component from SEMANTIC values:
 *   header (22 B): u16 vectorVersion | u16 fitnessPolicyVersion
 *     | u16 integrityPolicyVersion | u16 snapshotVersion
 *     | u32 populationSnapshotDigestState | u16 evaluationSpecVersion
 *     | u32 evaluationSpecDigestState | u32 memberCount
 *   member (48 B): u32 id | u8 valid | u8 status | f64 fitness
 *     | f64 peakBodySpeed | f64 peakSpeedDelta | f64 peakStepDisplacement
 *     | u8 alertPresent | u32 alertStep | u8 catPresent | u32 catStep
 * Absent onset ⇒ presence flag 0 AND u32 payload exactly 0 (canonical form).
 */
export function encodeFitnessVectorV3(vector) {
  for (const [name, expected] of Object.entries(VECTOR_VERSIONS)) {
    if (vector[name] !== expected) fail(`fitnessVector.${name}`, vector[name]);
  }
  if (!isU32(vector.populationSnapshotDigestState)) {
    fail('fitnessVector.populationSnapshotDigestState', vector.populationSnapshotDigestState);
  }
  if (!isU32(vector.evaluationSpecDigestState)) {
    fail('fitnessVector.evaluationSpecDigestState', vector.evaluationSpecDigestState);
  }
  const rows = vector.individuals;
  if (!Array.isArray(rows) || rows.length === 0) fail('fitnessVector.individuals', rows);
  const chunks = [
    u16le(VECTOR_VERSIONS.fitnessVectorVersion),
    u16le(VECTOR_VERSIONS.fitnessPolicyVersion),
    u16le(VECTOR_VERSIONS.integrityPolicyVersion),
    u16le(VECTOR_VERSIONS.snapshotVersion),
    u32le(vector.populationSnapshotDigestState),
    u16le(VECTOR_VERSIONS.evaluationSpecVersion),
    u32le(vector.evaluationSpecDigestState),
    u32le(rows.length),
  ];
  let prevId = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!isU32(row.individualId) || row.individualId <= prevId) {
      fail(`individuals[${i}].individualId`, row.individualId);
    }
    prevId = row.individualId;
    if (typeof row.valid !== 'boolean') fail(`individuals[${i}].valid`, row.valid);
    const statusIndex = INTEGRITY_STATUS.indexOf(row.integrityStatus);
    if (statusIndex === -1) fail(`individuals[${i}].integrityStatus`, row.integrityStatus);
    if (typeof row.fitness !== 'number') fail(`individuals[${i}].fitness`, row.fitness);
    for (const name of ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement']) {
      if (typeof row[name] !== 'number' || !(row[name] >= 0)) fail(`individuals[${i}].${name}`, row[name]);
    }
    for (const name of ['firstAlertStep', 'firstCatastrophicStep']) {
      if (row[name] !== null && !isU32(row[name])) fail(`individuals[${i}].${name}`, row[name]);
    }
    chunks.push(
      u32le(row.individualId),
      u8(row.valid ? 1 : 0),
      u8(statusIndex),
      f64le(row.fitness),
      f64le(row.peakBodySpeed),
      f64le(row.peakSpeedDelta),
      f64le(row.peakStepDisplacement),
      u8(row.firstAlertStep === null ? 0 : 1),
      u32le(row.firstAlertStep === null ? 0 : row.firstAlertStep),
      u8(row.firstCatastrophicStep === null ? 0 : 1),
      u32le(row.firstCatastrophicStep === null ? 0 : row.firstCatastrophicStep),
    );
  }
  const bytes = concatBytes(chunks);
  const expectedLength = VECTOR_HEADER_BYTES + VECTOR_MEMBER_BYTES * rows.length;
  if (bytes.length !== expectedLength) fail('fitnessVector byte length', bytes.length);
  return bytes;
}

/**
 * Assemble the full artifact from the manifest's captured literals plus the
 * independently encoded fitness vector. Digest formulas, verbatim:
 *   headerDigest     = SHA256(HEADER_DOMAIN    || u32le(len) || headerBytes)
 *   componentDigest  = SHA256(COMPONENT_DOMAIN || u32le(len) || componentBytes)
 *   generationDigest = SHA256(GENERATION_DOMAIN || previousDigest32
 *                             || u32le(len) || generationPayload)
 *   historyDigest    = SHA256(HISTORY_DOMAIN   || u32le(len) || historyBody)
 * Generation 0 chains from the header digest; the history body is every outer
 * byte from magic through the final generation digest.
 */
export function encodeInteropArtifact(manifest) {
  if (typeof manifest !== 'object' || manifest === null) fail('manifest', manifest);
  if (manifest.format !== 'boxcar3d/evolution-v3-interop-manifest/v1') {
    fail('manifest.format', manifest.format);
  }
  const generation = manifest.generation;
  const headerBytes = new Uint8Array(Buffer.from(manifest.headerBytesBase64, 'base64'));
  const componentBytes = {
    population: new Uint8Array(Buffer.from(generation.components.populationBase64, 'base64')),
    evaluationMetadata: new Uint8Array(Buffer.from(generation.components.evaluationMetadataBase64, 'base64')),
    fitnessVector: encodeFitnessVectorV3(generation.fitnessVector),
    lineage: new Uint8Array(Buffer.from(generation.components.lineageBase64, 'base64')),
  };
  if (!isU32(generation.generationIndex)) fail('generation.generationIndex', generation.generationIndex);
  const terminalIndex = TERMINAL_REASONS.indexOf(generation.terminalReason);
  if (terminalIndex === -1) fail('generation.terminalReason', generation.terminalReason);

  // Generation payload: u16 recordVersion | u32 index | u8 terminalReason,
  // then each component as u32 length | bytes | 32-byte domain digest.
  const payloadChunks = [
    u16le(GENERATION_RECORD_VERSION),
    u32le(generation.generationIndex),
    u8(terminalIndex),
  ];
  for (const kind of COMPONENT_KINDS) {
    const bytes = componentBytes[kind];
    payloadChunks.push(u32le(bytes.length), bytes, domainDigest(kind, [u32le(bytes.length), bytes]));
  }
  const payload = concatBytes(payloadChunks);

  const headerDigest = domainDigest('header', [u32le(headerBytes.length), headerBytes]);
  const generationDigest = domainDigest('generation', [headerDigest, u32le(payload.length), payload]);
  const body = concatBytes([
    MAGIC,
    u16le(HISTORY_VERSION),
    u32le(headerBytes.length),
    headerBytes,
    headerDigest,
    u32le(1), // generationRecordCount
    u32le(payload.length),
    payload,
    generationDigest,
  ]);
  const historyDigest = domainDigest('history', [u32le(body.length), body]);
  return concatBytes([body, historyDigest]);
}

// --- CLI: re-encode the committed manifest, compare to the fixture ----------

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const manifest = JSON.parse(readFileSync(
    fileURLToPath(new URL('../tests/fixtures/evolution-v3-interop.manifest.json', import.meta.url)), 'utf8',
  ));
  const fixture = new Uint8Array(Buffer.from(readFileSync(
    fileURLToPath(new URL('../tests/fixtures/evolution-v3-interop.base64', import.meta.url)), 'utf8',
  ).trim(), 'base64'));
  const encoded = encodeInteropArtifact(manifest);
  const identical = encoded.length === fixture.length
    && encoded.every((byte, i) => byte === fixture[i]);
  const sha = createHash('sha256').update(encoded).digest('hex');
  process.stdout.write([
    `independently encoded: ${encoded.length} bytes`,
    `artifact SHA-256: ${sha}`,
    `byte-identical to committed fixture: ${identical}`,
    '',
  ].join('\n'));
  if (!identical) process.exitCode = 1;
}
