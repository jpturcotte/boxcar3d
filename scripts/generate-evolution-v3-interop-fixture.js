// THE INDEPENDENT FITNESS-VECTOR-V3 INTEROPERABILITY ENCODER (PR 29, R2).
//
// This tool independently encodes the CHANGED fitness-vector-v3 bytes and the
// downstream framing / digest assembly of a one-generation, non-terminal
// evolution history v1 artifact, from the DECLARED component inputs in
// tests/fixtures/evolution-v1-fitness-vector-v3-oracle-inputs.json (produced
// by capture-evolution-v3-oracle-inputs.js). It is generated FROM THE WRITTEN
// FORMAT SPEC and imports NOTHING from the implementation under test — in
// particular nothing from src/sim/evolution-history.js, evolution-lineage.js,
// population.js or population-evaluation.js — and hashes with Node's crypto
// rather than the platform adapter (src/platform/sha256.js).
//
// THE CLAIM IS DELIBERATELY NARROW. Fixture A's generation 0 contains a
// DERIVED population and lineage that an independent encoder cannot recreate
// without reimplementing the GA transition; the population, metadata and
// lineage component bytes (and the header bytes) are therefore CAPTURED
// LITERALS — inputs, not evidence. What this oracle attests is the encoding
// and assembly layer: the v3 member walk, the payload framing, and the
// domain-separated SHA-256 identity. It is NOT equivalent to the original
// Kimi v1 artifact (a wholly independent implementation), and
// tests/fixtures/evolution-v1-fitness-vector-v3-kimi.md says so.
//
// Usage: node scripts/generate-evolution-v3-interop-fixture.js
//   (writes tests/fixtures/evolution-v1-fitness-vector-v3-kimi.base64 and
//    prints the identity literals for the .md)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

const INPUTS_URL = new URL('../tests/fixtures/evolution-v1-fitness-vector-v3-oracle-inputs.json', import.meta.url);
const OUT_URL = new URL('../tests/fixtures/evolution-v1-fitness-vector-v3-kimi.base64', import.meta.url);

// --- Copy-declared format constants (from the written spec, never imported) --

const MAGIC = [0x42, 0x43, 0x33, 0x44, 0x45, 0x56, 0x4f, 0x31]; // ASCII "BC3DEVO1"
const EVOLUTION_HISTORY_VERSION = 1;
const GENERATION_RECORD_VERSION = 1;
const SHA256_DIGEST_BYTES = 32;
const TERMINAL_REASON_INDEX = { none: 0 };
const INTEGRITY_STATUS_INDEX = { ok: 0, nonFinite: 1, numericalDivergence: 2 };
const COMPONENT_KINDS = ['population', 'evaluationMetadata', 'fitnessVector', 'lineage'];
const DOMAINS = {
  header: 'boxcar3d/evolution-history/header/v1\0',
  population: 'boxcar3d/evolution-history/population/v1\0',
  evaluationMetadata: 'boxcar3d/evolution-history/evaluation-metadata/v1\0',
  fitnessVector: 'boxcar3d/evolution-history/fitness-vector/v1\0',
  lineage: 'boxcar3d/evolution-history/lineage/v1\0',
  generation: 'boxcar3d/evolution-history/generation/v1\0',
  history: 'boxcar3d/evolution-history/history/v1\0',
};
// The v3 fitness-vector walk: 22 B header, then 48 B per member
// (id u32 | valid u8 | status u8 | fitness f64 | peaks f64 x3
// | onset steps (flag u8 + payload u32) x2).
const VECTOR_HEADER_BYTES = 2 + 2 + 2 + 2 + 4 + 2 + 4 + 4;
const VECTOR_MEMBER_BYTES = 4 + 1 + 1 + 8 + 8 * 3 + (1 + 4) * 2;

const fail = (path, value) => {
  throw new Error(`generate-evolution-v3-interop-fixture: invalid ${path} (${String(value)})`);
};

// --- Small byte plumbing (hex, hash, writers) ---------------------------------

function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(hex)) fail('hex', hex);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

const u32le = (n) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};

/** SHA256(domain || u32le(len) || payload) — the spec's framing, verbatim. */
function domainDigest(domain, payload) {
  const domainBytes = new TextEncoder().encode(domain);
  const input = new Uint8Array(domainBytes.length + 4 + payload.length);
  input.set(domainBytes, 0);
  input.set(u32le(payload.length), domainBytes.length);
  input.set(payload, domainBytes.length + 4);
  return sha256(input);
}

/** SHA256(GENERATION_DOMAIN || previousDigest32 || u32le(len) || payload). */
function generationDigest(domain, previousDigestBytes, payload) {
  const domainBytes = new TextEncoder().encode(domain);
  const input = new Uint8Array(domainBytes.length + 32 + 4 + payload.length);
  input.set(domainBytes, 0);
  input.set(previousDigestBytes, domainBytes.length);
  input.set(u32le(payload.length), domainBytes.length + 32);
  input.set(payload, domainBytes.length + 32 + 4);
  return sha256(input);
}

// --- The v3 fitness vector, encoded from DECLARED rows ------------------------

function encodeFitnessVectorV3(vector) {
  const rows = vector.individuals;
  if (!Array.isArray(rows) || rows.length === 0) fail('fitnessVector.individuals', rows);
  for (const field of [
    'fitnessVectorVersion', 'fitnessPolicyVersion', 'integrityPolicyVersion',
    'snapshotVersion', 'evaluationSpecVersion',
    'populationSnapshotDigestState', 'evaluationSpecDigestState',
  ]) {
    if (!Number.isInteger(vector[field]) || vector[field] < 0) fail(`fitnessVector.${field}`, vector[field]);
  }
  const bytes = new Uint8Array(VECTOR_HEADER_BYTES + VECTOR_MEMBER_BYTES * rows.length);
  const view = new DataView(bytes.buffer);
  let o = 0;
  view.setUint16(o, vector.fitnessVectorVersion, true); o += 2;
  view.setUint16(o, vector.fitnessPolicyVersion, true); o += 2;
  view.setUint16(o, vector.integrityPolicyVersion, true); o += 2;
  view.setUint16(o, vector.snapshotVersion, true); o += 2;
  view.setUint32(o, vector.populationSnapshotDigestState, true); o += 4;
  view.setUint16(o, vector.evaluationSpecVersion, true); o += 2;
  view.setUint32(o, vector.evaluationSpecDigestState, true); o += 4;
  view.setUint32(o, rows.length, true); o += 4;
  let prevId = -1;
  rows.forEach((row, i) => {
    const observations = row.integrityObservations;
    if (!Number.isInteger(row.individualId) || row.individualId < 0 || row.individualId > 0xffffffff) {
      fail(`individuals[${i}].individualId`, row.individualId);
    }
    if (row.individualId <= prevId) fail(`individuals[${i}].individualId`, 'must be strictly ascending');
    prevId = row.individualId;
    if (typeof row.valid !== 'boolean') fail(`individuals[${i}].valid`, row.valid);
    if (!(row.integrityStatus in INTEGRITY_STATUS_INDEX)) fail(`individuals[${i}].integrityStatus`, row.integrityStatus);
    if (typeof row.fitness !== 'number' || !Number.isFinite(row.fitness) || row.fitness < 0) {
      fail(`individuals[${i}].fitness`, row.fitness);
    }
    const peaks = [observations.peakBodySpeed, observations.peakSpeedDelta, observations.peakStepDisplacement];
    peaks.forEach((peak, p) => {
      if (typeof peak !== 'number' || !(peak >= 0)) fail(`individuals[${i}].integrityObservations.peak[${p}]`, peak);
    });
    const steps = [
      [observations.firstAlertStep, 'firstAlertStep'],
      [observations.firstCatastrophicStep, 'firstCatastrophicStep'],
    ];
    for (const [step, name] of steps) {
      if (step !== null && (!Number.isInteger(step) || step < 0 || step > 0xffffffff)) {
        fail(`individuals[${i}].integrityObservations.${name}`, step);
      }
    }
    view.setUint32(o, row.individualId, true); o += 4;
    view.setUint8(o, row.valid ? 1 : 0); o += 1;
    view.setUint8(o, INTEGRITY_STATUS_INDEX[row.integrityStatus]); o += 1;
    view.setFloat64(o, row.fitness, true); o += 8;
    view.setFloat64(o, peaks[0], true); o += 8;
    view.setFloat64(o, peaks[1], true); o += 8;
    view.setFloat64(o, peaks[2], true); o += 8;
    // Flag+u32, never a sentinel; an absent step's payload is exactly 0.
    view.setUint8(o, observations.firstAlertStep === null ? 0 : 1); o += 1;
    view.setUint32(o, observations.firstAlertStep === null ? 0 : observations.firstAlertStep, true); o += 4;
    view.setUint8(o, observations.firstCatastrophicStep === null ? 0 : 1); o += 1;
    view.setUint32(o, observations.firstCatastrophicStep === null ? 0 : observations.firstCatastrophicStep, true); o += 4;
  });
  if (o !== bytes.length) fail('fitnessVector byte length', `${o} !== ${bytes.length}`);
  return bytes;
}

// --- The payload and artifact framing, per the written spec -------------------

function encodeGenerationPayload({ generationIndex, terminalReason, components }) {
  if (!(terminalReason in TERMINAL_REASON_INDEX)) fail('terminalReason', terminalReason);
  let size = 2 + 4 + 1;
  for (const kind of COMPONENT_KINDS) size += 4 + components[kind].length + SHA256_DIGEST_BYTES;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let o = 0;
  view.setUint16(o, GENERATION_RECORD_VERSION, true); o += 2;
  view.setUint32(o, generationIndex, true); o += 4;
  view.setUint8(o, TERMINAL_REASON_INDEX[terminalReason]); o += 1;
  for (const kind of COMPONENT_KINDS) {
    const componentBytes = components[kind];
    view.setUint32(o, componentBytes.length, true); o += 4;
    bytes.set(componentBytes, o); o += componentBytes.length;
    bytes.set(domainDigest(DOMAINS[kind], componentBytes), o); o += SHA256_DIGEST_BYTES;
  }
  if (o !== bytes.length) fail('generation payload byte length', `${o} !== ${bytes.length}`);
  return bytes;
}

// --- Main ---------------------------------------------------------------------

const inputs = JSON.parse(readFileSync(INPUTS_URL, 'utf8'));
if (inputs.schema !== 'boxcar3d.evolution-v3-oracle-inputs/v1') fail('schema', inputs.schema);

const headerBytes = hexToBytes(inputs.headerBytesHex);
const fitnessVectorBytes = encodeFitnessVectorV3(inputs.generation.components.fitnessVector);
const components = {
  population: hexToBytes(inputs.generation.components.populationHex),
  evaluationMetadata: hexToBytes(inputs.generation.components.evaluationMetadataHex),
  fitnessVector: fitnessVectorBytes,
  lineage: hexToBytes(inputs.generation.components.lineageHex),
};
const payloadBytes = encodeGenerationPayload({
  generationIndex: inputs.generation.generationIndex,
  terminalReason: inputs.generation.terminalReason,
  components,
});

const headerDigestBytes = domainDigest(DOMAINS.header, headerBytes);
const generationDigestBytes = generationDigest(DOMAINS.generation, headerDigestBytes, payloadBytes);

// The outer framing: magic | u16 historyVersion | u32 headerByteLength |
// header | headerDigest | u32 recordCount | (u32 payloadLength | payload |
// generationDigest) x1 | historyDigest trailer. The history digest covers the
// body (magic .. final generation digest), never itself.
const bodyLength = 8 + 2 + 4 + headerBytes.length + SHA256_DIGEST_BYTES + 4
  + 4 + payloadBytes.length + SHA256_DIGEST_BYTES;
const artifact = new Uint8Array(bodyLength + SHA256_DIGEST_BYTES);
{
  const view = new DataView(artifact.buffer);
  let o = 0;
  artifact.set(MAGIC, o); o += MAGIC.length;
  view.setUint16(o, EVOLUTION_HISTORY_VERSION, true); o += 2;
  view.setUint32(o, headerBytes.length, true); o += 4;
  artifact.set(headerBytes, o); o += headerBytes.length;
  artifact.set(headerDigestBytes, o); o += SHA256_DIGEST_BYTES;
  view.setUint32(o, 1, true); o += 4; // one generation record
  view.setUint32(o, payloadBytes.length, true); o += 4;
  artifact.set(payloadBytes, o); o += payloadBytes.length;
  artifact.set(generationDigestBytes, o); o += SHA256_DIGEST_BYTES;
  if (o !== bodyLength) fail('history body byte length', `${o} !== ${bodyLength}`);
  artifact.set(domainDigest(DOMAINS.history, artifact.slice(0, bodyLength)), o);
}

writeFileSync(OUT_URL, `${Buffer.from(artifact).toString('base64')}\n`);
console.log(JSON.stringify({
  fixture: OUT_URL.pathname.split('/').pop(),
  byteLength: artifact.length,
  artifactSha256: sha256(artifact).toString('hex'),
  headerDigest: bytesToHex(headerDigestBytes),
  generationDigest: bytesToHex(generationDigestBytes),
  historyDigest: bytesToHex(artifact.slice(bodyLength)),
  fitnessVectorBytes: fitnessVectorBytes.length,
}, null, 2));
