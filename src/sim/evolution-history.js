// EVOLUTION HISTORY v1 — the byte-only persisted artifact, and the
// domain-separated SHA-256 identity over it.
//
// THE FORMAT IS THE POLICY. Every record has a FIXED component order and
// exactly four component kinds — population snapshot, evaluation metadata,
// fitness vector, lineage — each a length-prefixed byte array with its own
// digest domain. There is no property bag, no optional component, and no
// diagnostics slot. That is not minimalism for its own sake: it is what makes
// PR 3 Commit 0's trace-exclusion policy a STRUCTURAL fact rather than a rule
// someone must remember. A trace, a checkpoint, a live diagnostic or comparator
// evidence has no byte walk to enter through.
//
// ALL INTEGERS ARE UNSIGNED LITTLE-ENDIAN. All lengths are byte lengths and are
// checked with safe-integer arithmetic BEFORE any allocation or slicing. All
// strings are length-prefixed canonical UTF-8 with no NUL.
//
// OUTER FRAMING
//   u8[8]  magic                  ASCII "BC3DEVO1"
//   u16    historyVersion
//   u32    headerByteLength
//   u8[]   headerBytes
//   u8[32] headerDigest
//   u32    generationRecordCount  1..MAX_EVOLUTION_GENERATIONS
//   repeat generationRecordCount:
//     u32    generationPayloadByteLength
//     u8[]   generationPayload
//     u8[32] generationDigest
//   u8[32] historyDigest
//
// The decoder requires EXACT end-of-input after historyDigest. Appended bytes,
// truncation, zero records, unsupported versions and non-canonical lengths all
// fail loud — a well-framed artifact is part of the identity, not a courtesy.
//
// HEADER PAYLOAD
//   u16 evolutionEngineVersion   u16 evolutionPolicyVersion
//   u16 generationRecordVersion  u16 lineageVersion
//   u16 evaluationMetadataVersion
//   u16 tournamentSelectionVersion u16 elitismVersion
//   u16 parametricMutationVersion
//   u8  tournamentSize  u8 eliteCount  u8 physicsFlavor
//   u8 packageNameByteLength   u8[] packageNameUtf8
//   u8 runtimeVersionByteLength u8[] runtimeVersionUtf8
//   u32 populationSize  u32 maxGenerations
//   f64 mutationProbability  f64 mutationMagnitude
//   u32 initializationManifestByteLength  u8[] initializationManifestBytes
//   u32 evaluationSpecByteLength          u8[] evaluationSpecBytes
//
// Every duplicated version must agree with the live constant at decode time and
// NO default is ever injected — an old artifact cannot silently acquire today's
// meaning by omission.
//
// GENERATION PAYLOAD (excludes its own generation digest, by construction)
//   u16 generationRecordVersion
//   u32 generationIndex            exactly previous + 1; starts at 0
//   u8  terminalReason             TERMINAL_REASONS index
//   then, for each of the four components IN THIS ORDER:
//     u32 componentByteLength  u8[] componentBytes  u8[32] componentDigest
//
// A terminal record carries the SAME complete components as a non-terminal one.
//
// DIGEST DOMAINS AND FORMULAS. Each domain is a literal NUL-TERMINATED ASCII
// string, so no two digest inputs can ever be confused for one another even if
// their payload bytes coincide:
//   headerDigest     = SHA256(HEADER_DOMAIN    || u32le(len) || headerBytes)
//   componentDigest  = SHA256(COMPONENT_DOMAIN || u32le(len) || componentBytes)
//   generationDigest = SHA256(GENERATION_DOMAIN || previousDigest32
//                             || u32le(len) || generationPayload)
//   historyDigest    = SHA256(HISTORY_DOMAIN   || u32le(len) || historyBody)
// For generation 0, `previousDigest32` is the headerDigest; later generations
// chain from the preceding generation digest. `historyBody` is every outer byte
// from magic through the FINAL generation digest, excluding the trailing
// history digest itself (a digest cannot cover itself).
//
// WHAT THE EMBEDDED DIGEST PROVES: framing and self-consistency. NOT freshness,
// NOT authenticity, NOT provenance outside the encoded header, and NOT that the
// artifact is the newest save. Staleness detection is the caller's externally
// held expected digest/index, passed to resume.

import { copyOrdinaryBytes, createByteReader, typedArrayByteLength } from './bytes.js';
import { sha256, SHA256_DIGEST_BYTES } from '../platform/sha256.js';
import { POPULATION_WORLD_MODE } from './population-evaluation.js';
import {
  MAX_EVOLUTION_GENERATIONS, TERMINAL_REASONS, checkedAdd, checkedMultiply,
  evolutionFail, isEvolutionUint32,
} from './evolution-contract.js';

export { SHA256_DIGEST_BYTES } from '../platform/sha256.js';

export const EVOLUTION_HISTORY_VERSION = 1;
export const GENERATION_RECORD_VERSION = 1;
export const EVALUATION_METADATA_VERSION = 1;

/** ASCII "BC3DEVO1" — 8 bytes, so the framing is recognizable in a hex dump. */
export const EVOLUTION_HISTORY_MAGIC = Object.freeze([0x42, 0x43, 0x33, 0x44, 0x45, 0x56, 0x4f, 0x31]);

// Resource ceilings. Checked BEFORE allocation, always.
export const MAX_EVOLUTION_COMPONENT_BYTES = 16 * 1024 * 1024;
export const MAX_EVOLUTION_HEADER_BYTES = 16 * 1024 * 1024;
export const MAX_EVOLUTION_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_EVOLUTION_HISTORY_BYTES = 64 * 1024 * 1024;

/** The four component kinds, in the fixed order a generation payload holds. */
export const COMPONENT_KINDS = Object.freeze([
  'population', 'evaluationMetadata', 'fitnessVector', 'lineage',
]);

/** Wire order for the metadata's world-mode byte. */
export const WORLD_MODES = Object.freeze([POPULATION_WORLD_MODE]);

// Wire order for the only physics flavor evolution v1 permits. This mapping is
// owned by the persisted format, not by the broader runtime adapter: adding or
// reordering runtime flavors must never reinterpret an existing history byte.
const PHYSICS_FLAVORS = Object.freeze(['deterministicCompat']);

const MAX_WIRE_STRING_BYTES = 0xff;
const HEADER_FIXED_BYTES = 8 * 2 + 3 + 1 + 1 + 4 + 4 + 8 + 8 + 4 + 4;
const GENERATION_PAYLOAD_FIXED_BYTES = 2 + 4 + 1
  + COMPONENT_KINDS.length * (4 + SHA256_DIGEST_BYTES);
const OUTER_FIXED_BYTES = 8 + 2 + 4 + SHA256_DIGEST_BYTES + 4 + SHA256_DIGEST_BYTES;

const TEXT_ENCODER = new TextEncoder();
// `fatal: true` rejects malformed and overlong sequences, so a decoded string
// is canonical UTF-8 by construction rather than by a later re-encode check.
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

const DIGEST_DOMAINS = Object.freeze({
  header: 'boxcar3d/evolution-history/header/v1\0',
  population: 'boxcar3d/evolution-history/population/v1\0',
  evaluationMetadata: 'boxcar3d/evolution-history/evaluation-metadata/v1\0',
  fitnessVector: 'boxcar3d/evolution-history/fitness-vector/v1\0',
  lineage: 'boxcar3d/evolution-history/lineage/v1\0',
  generation: 'boxcar3d/evolution-history/generation/v1\0',
  history: 'boxcar3d/evolution-history/history/v1\0',
});

/** The domain byte strings, encoded once at module load. */
const DOMAIN_BYTES = Object.freeze(Object.fromEntries(
  Object.entries(DIGEST_DOMAINS).map(([k, v]) => [k, TEXT_ENCODER.encode(v)]),
));

/** The literal domain strings, exported so a lock can pin them as text. */
export const EVOLUTION_DIGEST_DOMAINS = DIGEST_DOMAINS;

function encodeFail(path, value) {
  evolutionFail('invalidConfig', `evolution-history: invalid ${path} (${String(value)})`, { path });
}

function decodeFail(path, value) {
  evolutionFail('malformedHistory', `evolution-history: invalid encoded history at ${path} (${String(value)})`, { path });
}

function limitFail(path, value, limit) {
  evolutionFail('resourceLimitExceeded',
    `evolution-history: ${path} ${value} exceeds ${limit}`, { path, value, limit });
}

/**
 * Project the largest v1 artifact a run configuration can produce without
 * allocating it. Runtime identity strings use their full legal u8 lengths;
 * callers provide conservative component lengths for any generation.
 */
export function projectEvolutionHistoryCapacity({
  initializationManifestByteLength,
  evaluationSpecByteLength,
  generationCount,
  componentByteLengths,
}) {
  const lengths = [
    ['initializationManifestByteLength', initializationManifestByteLength],
    ['evaluationSpecByteLength', evaluationSpecByteLength],
  ];
  for (const [path, value] of lengths) {
    if (!Number.isSafeInteger(value) || value < 0) encodeFail(path, value);
    if (value > MAX_EVOLUTION_COMPONENT_BYTES) limitFail(path, value, MAX_EVOLUTION_COMPONENT_BYTES);
  }
  if (!Number.isInteger(generationCount) || generationCount < 1) {
    encodeFail('generationCount', generationCount);
  }
  if (generationCount > MAX_EVOLUTION_GENERATIONS) {
    limitFail('generationCount', generationCount, MAX_EVOLUTION_GENERATIONS);
  }
  if (typeof componentByteLengths !== 'object' || componentByteLengths === null) {
    encodeFail('componentByteLengths', componentByteLengths);
  }

  let generationPayloadBytes = GENERATION_PAYLOAD_FIXED_BYTES;
  for (let i = 0; i < COMPONENT_KINDS.length; i += 1) {
    const kind = COMPONENT_KINDS[i];
    const length = componentByteLengths[kind];
    if (!Number.isSafeInteger(length) || length < 0) {
      encodeFail(`componentByteLengths.${kind}`, length);
    }
    if (length > MAX_EVOLUTION_COMPONENT_BYTES) {
      limitFail(`componentByteLengths.${kind}`, length, MAX_EVOLUTION_COMPONENT_BYTES);
    }
    generationPayloadBytes = checkedAdd(generationPayloadBytes, length, 'projected generation payload');
  }
  if (generationPayloadBytes > MAX_EVOLUTION_RECORD_BYTES) {
    limitFail('projected generation payload', generationPayloadBytes, MAX_EVOLUTION_RECORD_BYTES);
  }

  const headerBytes = checkedAdd(
    checkedAdd(
      checkedAdd(HEADER_FIXED_BYTES, MAX_WIRE_STRING_BYTES * 2, 'projected header'),
      initializationManifestByteLength,
      'projected header',
    ),
    evaluationSpecByteLength,
    'projected header',
  );
  const generationFrameBytes = checkedAdd(
    checkedAdd(4, generationPayloadBytes, 'projected generation frame'),
    SHA256_DIGEST_BYTES,
    'projected generation frame',
  );
  const fixedBytes = checkedAdd(OUTER_FIXED_BYTES, headerBytes, 'projected history');
  const projectedBytes = checkedAdd(
    fixedBytes,
    checkedMultiply(generationFrameBytes, generationCount, 'projected history generations'),
    'projected history',
  );
  const maximumFeasibleGenerations = Math.max(0, Math.min(
    MAX_EVOLUTION_GENERATIONS,
    Math.floor((MAX_EVOLUTION_HISTORY_BYTES - fixedBytes) / generationFrameBytes),
  ));
  return Object.freeze({
    projectedBytes,
    maximumFeasibleGenerations,
    headerBytes,
    generationPayloadBytes,
    generationFrameBytes,
  });
}

// --- Digests -----------------------------------------------------------------

/**
 * `domain || u32le(payload.length) || payload`, allocated once.
 *
 * The explicit length prefix is what makes concatenation unambiguous: without
 * it, a domain whose payload happens to begin with another domain's bytes could
 * produce the same input for two different (domain, payload) pairs.
 */
function digestInput(domainBytes, payloadLength, write) {
  const domainLength = domainBytes.length;
  const total = checkedAdd(checkedAdd(domainLength, 4, 'digest input'), payloadLength, 'digest input');
  const out = new Uint8Array(total);
  // receiver `out` is the module-owned array allocated on the line above.
  out.set(domainBytes, 0);
  // receiver `out` is module-owned; the DataView is built over its own buffer.
  // eslint-disable-next-line no-restricted-syntax
  new DataView(out.buffer).setUint32(domainLength, payloadLength, true);
  write(out, checkedAdd(domainLength, 4, 'digest input'));
  return out;
}

const setAt = (out, offset, bytes) => {
  // receiver `out` is the module-owned digest-input buffer.
  out.set(bytes, offset);
};

/** SHA256(HEADER_DOMAIN || u32le(len) || headerBytes). */
export function digestHeader(headerBytes) {
  const length = typedArrayByteLength(headerBytes);
  return sha256(digestInput(DOMAIN_BYTES.header, length, (out, at) => setAt(out, at, headerBytes)));
}

/** SHA256(COMPONENT_DOMAIN || u32le(len) || componentBytes). */
export function digestComponent(kind, componentBytes) {
  if (!COMPONENT_KINDS.includes(kind)) encodeFail('component kind', kind);
  const length = typedArrayByteLength(componentBytes);
  if (length > MAX_EVOLUTION_COMPONENT_BYTES) {
    limitFail(`component ${kind} byte length`, length, MAX_EVOLUTION_COMPONENT_BYTES);
  }
  return sha256(digestInput(DOMAIN_BYTES[kind], length, (out, at) => setAt(out, at, componentBytes)));
}

/**
 * SHA256(GENERATION_DOMAIN || previousDigest32 || u32le(len) || payload).
 *
 * The chain link sits BETWEEN the domain and the length prefix, at a fixed
 * 32-byte width, so a payload can never be read as a chain link or vice versa.
 */
export function digestGeneration(previousDigestBytes, payloadBytes) {
  const previousLength = typedArrayByteLength(previousDigestBytes);
  if (previousLength !== SHA256_DIGEST_BYTES) {
    encodeFail('previous digest length', previousLength);
  }
  const payloadLength = typedArrayByteLength(payloadBytes);
  const domainBytes = DOMAIN_BYTES.generation;
  const domainLength = domainBytes.length;
  const prefix = checkedAdd(domainLength, SHA256_DIGEST_BYTES, 'generation digest input');
  const total = checkedAdd(checkedAdd(prefix, 4, 'generation digest input'), payloadLength, 'generation digest input');
  const out = new Uint8Array(total);
  // receiver `out` is the module-owned array allocated on the line above.
  out.set(domainBytes, 0);
  setAt(out, domainLength, previousDigestBytes);
  // receiver `out` is module-owned; the DataView is built over its own buffer.
  // eslint-disable-next-line no-restricted-syntax
  new DataView(out.buffer).setUint32(prefix, payloadLength, true);
  setAt(out, checkedAdd(prefix, 4, 'generation digest input'), payloadBytes);
  return sha256(out);
}

/** SHA256(HISTORY_DOMAIN || u32le(len) || historyBody). */
export function digestHistoryBody(bodyBytes) {
  const length = typedArrayByteLength(bodyBytes);
  if (length > MAX_EVOLUTION_HISTORY_BYTES) {
    limitFail('history body byte length', length, MAX_EVOLUTION_HISTORY_BYTES);
  }
  return sha256(digestInput(DOMAIN_BYTES.history, length, (out, at) => setAt(out, at, bodyBytes)));
}

/** Constant-shape byte comparison over two module-owned digests. */
export function digestsEqual(a, b) {
  const aLength = typedArrayByteLength(a);
  const bLength = typedArrayByteLength(b);
  if (aLength !== bLength) return false;
  for (let i = 0; i < aLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// --- Evaluation metadata -----------------------------------------------------

const METADATA_BYTES = 2 + 1 + 8 + 4; // 15

/**
 * Serialize the evaluation metadata component.
 *
 * WHY THIS COMPONENT EXISTS. The fitness vector binds fitness, validity,
 * integrity and two digest states — and carries NO world mode, NO effective
 * timestep and NO executed step count. Those three are exactly the determinism
 * evidence the existing evaluation locks were built around: an engine whose f32
 * timestep readback drifted, or a run that silently executed a different number
 * of steps, would produce a different trajectory and could still land the same
 * fitness bytes. Replay therefore compares this component BEFORE fitness.
 */
export function serializeEvaluationMetadata(metadata) {
  if (typeof metadata !== 'object' || metadata === null) encodeFail('metadata', metadata);
  const worldMode = metadata.worldMode;
  const effectiveDt = metadata.effectiveDt;
  const executedSteps = metadata.executedSteps;
  const modeIndex = WORLD_MODES.indexOf(worldMode);
  if (modeIndex === -1) encodeFail('metadata.worldMode', worldMode);
  if (typeof effectiveDt !== 'number' || !Number.isFinite(effectiveDt) || effectiveDt <= 0) {
    encodeFail('metadata.effectiveDt', effectiveDt);
  }
  if (!isEvolutionUint32(executedSteps)) encodeFail('metadata.executedSteps', executedSteps);
  const view = new DataView(new ArrayBuffer(METADATA_BYTES));
  let o = 0;
  view.setUint16(o, EVALUATION_METADATA_VERSION, true); o += 2;
  view.setUint8(o, modeIndex); o += 1;
  view.setFloat64(o, effectiveDt, true); o += 8;
  view.setUint32(o, executedSteps, true); o += 4;
  // receiver `view` is the module-owned DataView allocated above.
  // eslint-disable-next-line no-restricted-syntax
  return new Uint8Array(view.buffer);
}

/** The exact inverse of serializeEvaluationMetadata. Frozen; never repairing. */
export function deserializeEvaluationMetadata(bytes) {
  const r = createByteReader(bytes, decodeFail);
  const version = r.u16('evaluationMetadataVersion');
  if (version !== EVALUATION_METADATA_VERSION) {
    evolutionFail('unsupportedVersion', `evolution-history: unsupported evaluationMetadataVersion ${version}`, { version });
  }
  const modeIndex = r.u8('worldMode');
  if (modeIndex >= WORLD_MODES.length) decodeFail('worldMode', modeIndex);
  const effectiveDt = r.finiteF64('effectiveDt');
  if (effectiveDt <= 0) decodeFail('effectiveDt', effectiveDt);
  const executedSteps = r.u32('executedSteps');
  r.expectEnd('evaluationMetadata');
  return Object.freeze({
    evaluationMetadataVersion: version,
    worldMode: WORLD_MODES[modeIndex],
    effectiveDt,
    executedSteps,
  });
}

// --- Header ------------------------------------------------------------------

function encodeUtf8Field(value, path) {
  if (typeof value !== 'string' || value.length === 0) encodeFail(path, value);
  const bytes = TEXT_ENCODER.encode(value);
  const length = bytes.length;
  if (length > 0xff) limitFail(`${path} byte length`, length, 255);
  for (let i = 0; i < length; i += 1) {
    if (bytes[i] === 0) encodeFail(path, 'contains a NUL byte');
  }
  return bytes;
}

/**
 * Serialize the header payload (see the walk in the module header).
 *
 * The header binds THREE things a caller cannot re-derive from the components:
 * the exact runtime identity (flavor + package + engine version, so a
 * dependency bump reports as `runtimeVersionMismatch` rather than as
 * deterministic divergence discovered halfway through a replay), the resolved
 * operator versions and constants, and the resolved mutation parameters — which
 * are encoded as their NUMERIC VALUES, never as "the defaults", so a future
 * change to PARAMETRIC_MUTATION_DEFAULTS cannot silently rewrite an old
 * artifact's meaning.
 */
export function encodeEvolutionHeader(header) {
  if (typeof header !== 'object' || header === null) encodeFail('header', header);
  const u16s = [
    ['evolutionEngineVersion', header.evolutionEngineVersion],
    ['evolutionPolicyVersion', header.evolutionPolicyVersion],
    ['generationRecordVersion', header.generationRecordVersion],
    ['lineageVersion', header.lineageVersion],
    ['evaluationMetadataVersion', header.evaluationMetadataVersion],
    ['tournamentSelectionVersion', header.tournamentSelectionVersion],
    ['elitismVersion', header.elitismVersion],
    ['parametricMutationVersion', header.parametricMutationVersion],
  ];
  for (const [path, value] of u16s) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) encodeFail(`header.${path}`, value);
  }
  const tournamentSize = header.tournamentSize;
  const eliteCount = header.eliteCount;
  for (const [path, value] of [['tournamentSize', tournamentSize], ['eliteCount', eliteCount]]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) encodeFail(`header.${path}`, value);
  }
  const flavorIndex = PHYSICS_FLAVORS.indexOf(header.physicsFlavor);
  if (flavorIndex === -1) encodeFail('header.physicsFlavor', header.physicsFlavor);
  const packageBytes = encodeUtf8Field(header.packageName, 'header.packageName');
  const runtimeBytes = encodeUtf8Field(header.rapierVersion, 'header.rapierVersion');
  const populationSize = header.populationSize;
  const maxGenerations = header.maxGenerations;
  if (!isEvolutionUint32(populationSize) || populationSize < 1) encodeFail('header.populationSize', populationSize);
  if (!isEvolutionUint32(maxGenerations) || maxGenerations < 1) encodeFail('header.maxGenerations', maxGenerations);
  const probability = header.mutationProbability;
  const magnitude = header.mutationMagnitude;
  for (const [path, value] of [['mutationProbability', probability], ['mutationMagnitude', magnitude]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      encodeFail(`header.${path}`, value);
    }
  }
  const manifestBytes = copyOrdinaryBytes(header.initializationManifestBytes, encodeFail);
  const specBytes = copyOrdinaryBytes(header.evaluationSpecBytes, encodeFail);
  const manifestLength = manifestBytes.length;
  const specLength = specBytes.length;
  if (manifestLength > MAX_EVOLUTION_COMPONENT_BYTES) {
    limitFail('header.initializationManifestBytes', manifestLength, MAX_EVOLUTION_COMPONENT_BYTES);
  }
  if (specLength > MAX_EVOLUTION_COMPONENT_BYTES) {
    limitFail('header.evaluationSpecBytes', specLength, MAX_EVOLUTION_COMPONENT_BYTES);
  }
  let size = 8 * 2 + 3 + 1 + packageBytes.length + 1 + runtimeBytes.length + 4 + 4 + 8 + 8;
  size = checkedAdd(size, checkedAdd(4, manifestLength, 'header manifest'), 'header size');
  size = checkedAdd(size, checkedAdd(4, specLength, 'header spec'), 'header size');
  if (size > MAX_EVOLUTION_HEADER_BYTES) {
    limitFail('header byte length', size, MAX_EVOLUTION_HEADER_BYTES);
  }
  const view = new DataView(new ArrayBuffer(size));
  // receiver `view` is the module-owned DataView allocated above.
  // eslint-disable-next-line no-restricted-syntax
  const out = new Uint8Array(view.buffer);
  let o = 0;
  for (const [, value] of u16s) { view.setUint16(o, value, true); o += 2; }
  view.setUint8(o, tournamentSize); o += 1;
  view.setUint8(o, eliteCount); o += 1;
  view.setUint8(o, flavorIndex); o += 1;
  view.setUint8(o, packageBytes.length); o += 1;
  setAt(out, o, packageBytes); o += packageBytes.length;
  view.setUint8(o, runtimeBytes.length); o += 1;
  setAt(out, o, runtimeBytes); o += runtimeBytes.length;
  view.setUint32(o, populationSize, true); o += 4;
  view.setUint32(o, maxGenerations, true); o += 4;
  view.setFloat64(o, probability, true); o += 8;
  view.setFloat64(o, magnitude, true); o += 8;
  view.setUint32(o, manifestLength, true); o += 4;
  setAt(out, o, manifestBytes); o += manifestLength;
  view.setUint32(o, specLength, true); o += 4;
  setAt(out, o, specBytes); o += specLength;
  return out;
}

function decodeUtf8Field(r, path) {
  const length = r.u8(`${path}ByteLength`);
  if (length === 0) decodeFail(path, 'empty');
  const bytes = r.bytes(length, path);
  for (let i = 0; i < length; i += 1) if (bytes[i] === 0) decodeFail(path, 'contains a NUL byte');
  let text;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch (cause) {
    evolutionFail('malformedHistory', `evolution-history: ${path} is not canonical UTF-8`, { path }, cause);
  }
  return text;
}

/** The exact inverse of encodeEvolutionHeader. Frozen; never repairing. */
export function decodeEvolutionHeader(bytes) {
  const r = createByteReader(bytes, decodeFail);
  const read = (path) => r.u16(path);
  const evolutionEngineVersion = read('evolutionEngineVersion');
  const evolutionPolicyVersion = read('evolutionPolicyVersion');
  const generationRecordVersion = read('generationRecordVersion');
  const lineageVersion = read('lineageVersion');
  const evaluationMetadataVersion = read('evaluationMetadataVersion');
  const tournamentSelectionVersion = read('tournamentSelectionVersion');
  const elitismVersion = read('elitismVersion');
  const parametricMutationVersion = read('parametricMutationVersion');
  const tournamentSize = r.u8('tournamentSize');
  const eliteCount = r.u8('eliteCount');
  const flavorIndex = r.u8('physicsFlavor');
  if (flavorIndex >= PHYSICS_FLAVORS.length) decodeFail('physicsFlavor', flavorIndex);
  const packageName = decodeUtf8Field(r, 'packageName');
  const rapierVersion = decodeUtf8Field(r, 'runtimeVersion');
  const populationSize = r.u32('populationSize');
  if (populationSize < 1) decodeFail('populationSize', populationSize);
  const maxGenerations = r.u32('maxGenerations');
  if (maxGenerations < 1) decodeFail('maxGenerations', maxGenerations);
  const mutationProbability = r.finiteF64('mutationProbability');
  const mutationMagnitude = r.finiteF64('mutationMagnitude');
  for (const [path, value] of [['mutationProbability', mutationProbability], ['mutationMagnitude', mutationMagnitude]]) {
    if (value < 0 || value > 1) decodeFail(path, value);
  }
  const manifestLength = r.u32('initializationManifestByteLength');
  if (manifestLength > MAX_EVOLUTION_COMPONENT_BYTES) {
    limitFail('initializationManifestByteLength', manifestLength, MAX_EVOLUTION_COMPONENT_BYTES);
  }
  const initializationManifestBytes = copyOrdinaryBytes(r.bytes(manifestLength, 'initializationManifestBytes'), decodeFail);
  const specLength = r.u32('evaluationSpecByteLength');
  if (specLength > MAX_EVOLUTION_COMPONENT_BYTES) {
    limitFail('evaluationSpecByteLength', specLength, MAX_EVOLUTION_COMPONENT_BYTES);
  }
  const evaluationSpecBytes = copyOrdinaryBytes(r.bytes(specLength, 'evaluationSpecBytes'), decodeFail);
  r.expectEnd('header');
  return Object.freeze({
    evolutionEngineVersion,
    evolutionPolicyVersion,
    generationRecordVersion,
    lineageVersion,
    evaluationMetadataVersion,
    tournamentSelectionVersion,
    elitismVersion,
    parametricMutationVersion,
    tournamentSize,
    eliteCount,
    physicsFlavor: PHYSICS_FLAVORS[flavorIndex],
    packageName,
    rapierVersion,
    populationSize,
    maxGenerations,
    mutationProbability,
    mutationMagnitude,
    initializationManifestBytes,
    evaluationSpecBytes,
  });
}

// --- Generation payload ------------------------------------------------------

/**
 * Encode one generation payload. `componentDigests` is the module-owned map of
 * already-computed 32-byte component digests (they are async, so they cannot be
 * computed inside a synchronous encoder — and passing them in keeps this
 * function a pure byte walk).
 */
export function encodeGenerationPayload(record, componentDigests) {
  if (typeof record !== 'object' || record === null) encodeFail('record', record);
  const generationIndex = record.generationIndex;
  const terminalReason = record.terminalReason;
  if (!isEvolutionUint32(generationIndex)) encodeFail('record.generationIndex', generationIndex);
  if (generationIndex >= MAX_EVOLUTION_GENERATIONS) {
    limitFail('record.generationIndex', generationIndex, MAX_EVOLUTION_GENERATIONS - 1);
  }
  const terminalIndex = TERMINAL_REASONS.indexOf(terminalReason);
  if (terminalIndex === -1) encodeFail('record.terminalReason', terminalReason);
  // ONE read of each caller container before the walk. The loop body used to
  // read `record.components` (and `componentDigests`) once per kind — four
  // readings backing one attestation, so a component could be validated from
  // one container and encoded from another.
  const sourceComponents = record.components;
  const sourceDigests = componentDigests;
  if (typeof sourceComponents !== 'object' || sourceComponents === null) {
    encodeFail('record.components', sourceComponents);
  }
  if (typeof sourceDigests !== 'object' || sourceDigests === null) {
    encodeFail('componentDigests', sourceDigests);
  }
  const components = [];
  let size = 2 + 4 + 1;
  for (let i = 0; i < COMPONENT_KINDS.length; i += 1) {
    const kind = COMPONENT_KINDS[i];
    const componentBytes = copyOrdinaryBytes(sourceComponents[kind], encodeFail);
    const digest = copyOrdinaryBytes(sourceDigests[kind], encodeFail);
    const length = componentBytes.length;
    if (length > MAX_EVOLUTION_COMPONENT_BYTES) {
      limitFail(`record.components.${kind}`, length, MAX_EVOLUTION_COMPONENT_BYTES);
    }
    if (digest.length !== SHA256_DIGEST_BYTES) encodeFail(`componentDigests.${kind}`, digest.length);
    components.push({ componentBytes, digest, length });
    size = checkedAdd(size, checkedAdd(checkedAdd(4, length, 'component'), SHA256_DIGEST_BYTES, 'component'), 'payload size');
  }
  if (size > MAX_EVOLUTION_RECORD_BYTES) limitFail('generation payload', size, MAX_EVOLUTION_RECORD_BYTES);
  const view = new DataView(new ArrayBuffer(size));
  // receiver `view` is the module-owned DataView allocated above.
  // eslint-disable-next-line no-restricted-syntax
  const out = new Uint8Array(view.buffer);
  let o = 0;
  view.setUint16(o, GENERATION_RECORD_VERSION, true); o += 2;
  view.setUint32(o, generationIndex, true); o += 4;
  view.setUint8(o, terminalIndex); o += 1;
  for (let i = 0; i < components.length; i += 1) {
    const c = components[i];
    view.setUint32(o, c.length, true); o += 4;
    setAt(out, o, c.componentBytes); o += c.length;
    setAt(out, o, c.digest); o += SHA256_DIGEST_BYTES;
  }
  return out;
}

/** The exact inverse of encodeGenerationPayload. Component bytes are copies. */
export function decodeGenerationPayload(bytes) {
  const r = createByteReader(bytes, decodeFail);
  const version = r.u16('generationRecordVersion');
  if (version !== GENERATION_RECORD_VERSION) {
    evolutionFail('unsupportedVersion', `evolution-history: unsupported generationRecordVersion ${version}`, { version });
  }
  const generationIndex = r.u32('generationIndex');
  if (generationIndex >= MAX_EVOLUTION_GENERATIONS) {
    limitFail('generationIndex', generationIndex, MAX_EVOLUTION_GENERATIONS - 1);
  }
  const terminalIndex = r.u8('terminalReason');
  if (terminalIndex >= TERMINAL_REASONS.length) decodeFail('terminalReason', terminalIndex);
  const components = {};
  const componentDigests = {};
  for (let i = 0; i < COMPONENT_KINDS.length; i += 1) {
    const kind = COMPONENT_KINDS[i];
    const length = r.u32(`components.${kind}.byteLength`);
    if (length > MAX_EVOLUTION_COMPONENT_BYTES) {
      limitFail(`components.${kind}.byteLength`, length, MAX_EVOLUTION_COMPONENT_BYTES);
    }
    components[kind] = copyOrdinaryBytes(r.bytes(length, `components.${kind}`), decodeFail);
    componentDigests[kind] = copyOrdinaryBytes(
      r.bytes(SHA256_DIGEST_BYTES, `components.${kind}.digest`), decodeFail,
    );
  }
  r.expectEnd('generationPayload');
  return Object.freeze({
    generationRecordVersion: version,
    generationIndex,
    terminalReason: TERMINAL_REASONS[terminalIndex],
    components: Object.freeze(components),
    componentDigests: Object.freeze(componentDigests),
  });
}

// --- Outer framing -----------------------------------------------------------

const MAGIC_BYTES = Uint8Array.from(EVOLUTION_HISTORY_MAGIC);
const FRAME_PREFIX_BYTES = 8 + 2 + 4; // magic + historyVersion + headerByteLength

/**
 * Assemble the complete artifact from the header, its digest, and the committed
 * generations (payload bytes + generation digest each). Returns
 * `{ bytes, historyDigestBytes }`.
 *
 * The body is built once per call and the history digest is computed over it.
 * This function allocates the new artifact, a domain-framed digest input, and
 * sha256's defensive input copy. Its caller may simultaneously retain the old
 * aggregate and segmented generation payloads. See the documented conservative
 * peak model; verification still avoids retaining decoded generations.
 *
 * NOT an `async function`, for the same reason `sha256` is not: every input is
 * validated and every byte written in the synchronous prologue, so a bad input
 * throws before an `await` exists to swallow it into a rejected promise — which
 * is what the derived storage battery can actually assert.
 */
export function assembleHistory({ headerBytes, headerDigestBytes, generations }) {
  const headerLength = typedArrayByteLength(headerBytes);
  if (headerLength > MAX_EVOLUTION_HEADER_BYTES) {
    limitFail('header byte length', headerLength, MAX_EVOLUTION_HEADER_BYTES);
  }
  if (typedArrayByteLength(headerDigestBytes) !== SHA256_DIGEST_BYTES) {
    encodeFail('headerDigestBytes', typedArrayByteLength(headerDigestBytes));
  }
  if (!Array.isArray(generations)) encodeFail('generations', generations);
  const count = generations.length;
  if (count < 1) encodeFail('generations', 'a history carries at least one generation record');
  if (count > MAX_EVOLUTION_GENERATIONS) {
    limitFail('generationRecordCount', count, MAX_EVOLUTION_GENERATIONS);
  }
  // ONE capture of every generation before any allocation, so the size pass and
  // the write pass cannot read different values (the serializeEvaluationSpec
  // one-source-of-truth ruling).
  const rows = [];
  // The BODY is magic..final generation digest. The 32-byte history digest is a
  // TRAILER outside it — a digest cannot cover itself — so it is added only to
  // the total allocation, never to the length that is hashed.
  let bodyLength = checkedAdd(
    checkedAdd(FRAME_PREFIX_BYTES, headerLength, 'history size'),
    checkedAdd(SHA256_DIGEST_BYTES, 4, 'history size'),
    'history size',
  );
  for (let i = 0; i < count; i += 1) {
    const generation = generations[i];
    const payloadBytes = generation.payloadBytes;
    const generationDigestBytes = generation.generationDigestBytes;
    const payloadLength = typedArrayByteLength(payloadBytes);
    if (payloadLength > MAX_EVOLUTION_RECORD_BYTES) {
      limitFail(`generations[${i}] payload`, payloadLength, MAX_EVOLUTION_RECORD_BYTES);
    }
    if (typedArrayByteLength(generationDigestBytes) !== SHA256_DIGEST_BYTES) {
      encodeFail(`generations[${i}].generationDigestBytes`, 'not a 32-byte digest');
    }
    rows.push({ payloadBytes, generationDigestBytes, payloadLength });
    bodyLength = checkedAdd(bodyLength, checkedAdd(checkedAdd(4, payloadLength, 'generation frame'), SHA256_DIGEST_BYTES, 'generation frame'), 'history size');
  }
  const total = checkedAdd(bodyLength, SHA256_DIGEST_BYTES, 'history size');
  if (total > MAX_EVOLUTION_HISTORY_BYTES) {
    limitFail('history byte length', total, MAX_EVOLUTION_HISTORY_BYTES);
  }
  const out = new Uint8Array(total);
  // receiver `out` is the module-owned array allocated on the line above.
  // eslint-disable-next-line no-restricted-syntax
  const view = new DataView(out.buffer);
  let o = 0;
  setAt(out, o, MAGIC_BYTES); o += MAGIC_BYTES.length;
  view.setUint16(o, EVOLUTION_HISTORY_VERSION, true); o += 2;
  view.setUint32(o, headerLength, true); o += 4;
  setAt(out, o, headerBytes); o += headerLength;
  setAt(out, o, headerDigestBytes); o += SHA256_DIGEST_BYTES;
  view.setUint32(o, count, true); o += 4;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    view.setUint32(o, row.payloadLength, true); o += 4;
    setAt(out, o, row.payloadBytes); o += row.payloadLength;
    setAt(out, o, row.generationDigestBytes); o += SHA256_DIGEST_BYTES;
  }
  if (o !== bodyLength) encodeFail('history body length', `${o} !== ${bodyLength}`);
  // receiver `out` is the module-owned artifact buffer allocated above; the
  // body window deliberately excludes the trailing history digest, which a
  // digest cannot cover.
  // eslint-disable-next-line no-restricted-syntax
  const body = new Uint8Array(out.buffer, 0, bodyLength);
  return digestHistoryBody(body).then((historyDigestBytes) => {
    setAt(out, bodyLength, historyDigestBytes);
    return { bytes: out, historyDigestBytes };
  });
}

/**
 * Parse the outer framing of a MODULE-OWNED history buffer.
 *
 * OWNERSHIP, stated because it is a deliberate exception: the returned header
 * and payload views ALIAS `bytes`. That is what keeps the peak-memory model
 * honest — the resume path already copies the caller's artifact once, and a
 * second full parsed-body copy would double a 64 MiB ceiling for nothing. The
 * contract is therefore: pass bytes this module family owns. Everything the
 * decoder returns to a PUBLIC caller downstream is copied at that seam instead.
 *
 * This is the structural pass only: framing, magic, versions, counts, nested
 * lengths, ceilings, checked arithmetic and exact end-of-input. Digest
 * verification is the replay layer's ordered job, because localizing WHICH
 * check failed is the entire point of doing them separately.
 */
export function decodeHistoryFraming(bytes) {
  const total = typedArrayByteLength(bytes);
  if (total > MAX_EVOLUTION_HISTORY_BYTES) {
    limitFail('history byte length', total, MAX_EVOLUTION_HISTORY_BYTES);
  }
  const r = createByteReader(bytes, decodeFail);
  const magic = r.bytes(MAGIC_BYTES.length, 'magic');
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (magic[i] !== MAGIC_BYTES[i]) decodeFail('magic', 'not a BoxCar3D evolution history');
  }
  const historyVersion = r.u16('historyVersion');
  if (historyVersion !== EVOLUTION_HISTORY_VERSION) {
    evolutionFail('unsupportedVersion', `evolution-history: unsupported historyVersion ${historyVersion}`, { historyVersion });
  }
  const headerLength = r.u32('headerByteLength');
  if (headerLength > MAX_EVOLUTION_HEADER_BYTES) {
    limitFail('headerByteLength', headerLength, MAX_EVOLUTION_HEADER_BYTES);
  }
  const headerBytes = r.bytes(headerLength, 'headerBytes');
  const headerDigestBytes = r.bytes(SHA256_DIGEST_BYTES, 'headerDigest');
  const count = r.u32('generationRecordCount');
  // The count is checked BEFORE the record loop iterates, so a lying count can
  // never drive an unbounded walk.
  if (count < 1) decodeFail('generationRecordCount', count);
  if (count > MAX_EVOLUTION_GENERATIONS) {
    limitFail('generationRecordCount', count, MAX_EVOLUTION_GENERATIONS);
  }
  // …and it must be arithmetically possible in the bytes that remain: each
  // record costs at least 4 + 0 + 32 bytes plus the 32-byte trailer.
  const minimumRemaining = checkedAdd(
    checkedMultiply(count, 4 + SHA256_DIGEST_BYTES, 'minimum record payload'),
    SHA256_DIGEST_BYTES, 'minimum remaining',
  );
  if (r.remaining < minimumRemaining) {
    decodeFail('generationRecordCount', `${count} records cannot fit in ${r.remaining} remaining bytes`);
  }
  const generations = [];
  for (let i = 0; i < count; i += 1) {
    const payloadLength = r.u32(`generations[${i}].payloadByteLength`);
    if (payloadLength > MAX_EVOLUTION_RECORD_BYTES) {
      limitFail(`generations[${i}].payloadByteLength`, payloadLength, MAX_EVOLUTION_RECORD_BYTES);
    }
    const payloadBytes = r.bytes(payloadLength, `generations[${i}].payload`);
    const generationDigestBytes = r.bytes(SHA256_DIGEST_BYTES, `generations[${i}].digest`);
    generations.push(Object.freeze({ payloadBytes, generationDigestBytes }));
  }
  const bodyLength = r.offset;
  const historyDigestBytes = r.bytes(SHA256_DIGEST_BYTES, 'historyDigest');
  r.expectEnd('history');
  // The body window: magic through the final generation digest, excluding the
  // trailer. Built from the module's own %Uint8Array% over the intrinsic
  // buffer/offset — never `subarray`, which is species-aware.
  const body = new Uint8Array(
    // receiver `bytes` reaches its geometry through the gated helper below.
    bytesBuffer(bytes), bytesOffset(bytes), bodyLength,
  );
  return Object.freeze({
    historyVersion,
    headerBytes,
    headerDigestBytes,
    generations: Object.freeze(generations),
    historyDigestBytes,
    body,
    totalByteLength: total,
  });
}

// Geometry accessors, isolated so the byte-family lint rule has exactly one
// place to look. `bytes` is module-owned by decodeHistoryFraming's contract;
// these still read the INTRINSIC accessors rather than the shadowable ones.
const TA_PROTO = Object.getPrototypeOf(Object.getPrototypeOf(new Uint8Array(0)));
const TA_BUFFER = Object.getOwnPropertyDescriptor(TA_PROTO, 'buffer').get;
const TA_BYTE_OFFSET = Object.getOwnPropertyDescriptor(TA_PROTO, 'byteOffset').get;
const bytesBuffer = (b) => TA_BUFFER.call(b);
const bytesOffset = (b) => TA_BYTE_OFFSET.call(b);
