// An INDEPENDENT encoder for the BoxCar3D evolution-history v1 artifact,
// written from the WRITTEN FORMAT SPEC rather than from the implementation.
//
// WHAT INDEPENDENCE MEANS HERE, stated precisely because the previous oracle's
// claim was looser than its construction:
//
//   INDEPENDENT (this file re-derives it from the spec):
//     - the fitness-vector v3 member walk, including the three peaks and the
//       two flagged optional onsets — the layer PR #28 actually changed;
//     - the lineage, evaluation-metadata and population-snapshot walks;
//     - the header payload walk;
//     - all seven domain-separated SHA-256 formulas, the generation chain, and
//       the outer framing.
//
//   DECLARED INPUT (captured once from a production run; not evidence):
//     - genotype BYTES, the initialization-manifest bytes and the
//       evaluation-spec bytes, as hex. Those encodings are unchanged by this
//       PR and are covered by their own codec suites; re-deriving them here
//       would test PR #23's work, not PR #28's.
//     - every physics-derived scalar (fitness, the observations, effectiveDt).
//       These are what the simulation produced. The bytes built around them
//       are what is under test.
//
// It imports NOTHING from src/sim/evolution-history.js, evolution-lineage.js,
// population.js or population-evaluation.js, and hashes with node:crypto rather
// than src/platform/sha256.js. If this repo's encoder ever drifts from the
// spec, the committed artifact stops verifying.
//
// Usage: node scripts/generate-independent-evolution-artifact.js <inputs.json>

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const sha256 = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

const hexToBytes = (hex) => {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// A minimal append-only writer. Deliberately not the repo's byte helpers.
class Writer {
  constructor() { this.parts = []; }

  u8(v) { this.parts.push(Uint8Array.of(v & 0xff)); return this; }

  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.parts.push(b); return this; }

  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.parts.push(b); return this; }

  f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this.parts.push(b); return this; }

  raw(b) { this.parts.push(Uint8Array.from(b)); return this; }

  utf8Field(text) {
    const b = new TextEncoder().encode(text);
    if (b.length > 0xff) throw new Error('wire string too long');
    return this.u8(b.length).raw(b);
  }

  bytes() {
    let n = 0;
    for (const p of this.parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

// --- The declared enum orders, copied from the format spec -------------------
const INTEGRITY_STATUS = ['ok', 'nonFinite', 'numericalDivergence'];
const LINEAGE_ORIGINS = ['initialized', 'eliteCopy', 'continuousMutation'];
const LINEAGE_NO_PARENT = 0xffffffff;
const ACCOUNTING_KEYS = [
  'eligibleContinuousLeafCount', 'selectedLeafCount', 'rawChangedLeafCount',
  'clampedLeafCount', 'repairChangedLeafCount', 'repairIntroducedLeafCount',
  'repairErasedLeafCount', 'repairRedirectedLeafCount', 'finalChangedLeafCount',
  'rawByteDeltaCount', 'finalByteDeltaCount',
];
const WORLD_MODES = ['isolatedWorlds'];
const PHYSICS_FLAVORS = ['deterministicCompat'];
const TERMINAL_REASONS = ['none', 'noSelectableParents', 'generationLimitReached', 'individualIdExhausted'];
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

const MAGIC = [0x42, 0x43, 0x33, 0x44, 0x45, 0x56, 0x4f, 0x31]; // "BC3DEVO1"

// domain || u32le(len) || payload
const domainDigest = (domain, payload) => sha256(
  new Writer().raw(new TextEncoder().encode(domain)).u32(payload.length).raw(payload).bytes(),
);

// GENERATION_DOMAIN || previousDigest32 || u32le(len) || payload
const generationDigest = (previous, payload) => sha256(
  new Writer().raw(new TextEncoder().encode(DOMAINS.generation)).raw(previous)
    .u32(payload.length).raw(payload)
    .bytes(),
);

// --- Component encoders ------------------------------------------------------

// u16 version | u16 genotypeVersion | u32 count | per member: u32 id, u32 len, bytes
function encodePopulationSnapshot(members) {
  const w = new Writer().u16(1).u16(1).u32(members.length);
  for (const m of members) {
    const g = hexToBytes(m.genotypeHex);
    w.u32(m.individualId).u32(g.length).raw(g);
  }
  return w.bytes();
}

// u16 version | u8 worldMode | f64 effectiveDt | u32 executedSteps
function encodeEvaluationMetadata(md) {
  const mode = WORLD_MODES.indexOf(md.worldMode);
  if (mode === -1) throw new Error(`unknown world mode ${md.worldMode}`);
  return new Writer().u16(1).u8(mode).f64(md.effectiveDt).u32(md.executedSteps)
    .bytes();
}

// THE LAYER UNDER TEST — fitness vector v3.
//   u16 vectorVersion | u16 policyVersion | u16 integrityPolicyVersion
//   u16 snapshotVersion | u32 snapshotDigestState | u16 specVersion
//   u32 specDigestState | u32 count
//   per member: u32 id | u8 valid | u8 status | f64 fitness
//               | f64 peakBodySpeed | f64 peakSpeedDelta | f64 peakStepDisplacement
//               | u8 alertPresent | u32 alertStep
//               | u8 catastrophicPresent | u32 catastrophicStep
// An ABSENT optional step writes a ZERO payload — one semantic value, one
// byte string.
function encodeFitnessVectorV3(v) {
  const w = new Writer()
    .u16(3).u16(2).u16(1).u16(1)
    .u32(v.populationSnapshotDigestState)
    .u16(1)
    .u32(v.evaluationSpecDigestState)
    .u32(v.individuals.length);
  for (const r of v.individuals) {
    const status = INTEGRITY_STATUS.indexOf(r.integrityStatus);
    if (status === -1) throw new Error(`unknown integrity status ${r.integrityStatus}`);
    const o = r.integrityObservations;
    w.u32(r.individualId).u8(r.valid ? 1 : 0).u8(status).f64(r.fitness);
    w.f64(o.peakBodySpeed).f64(o.peakSpeedDelta).f64(o.peakStepDisplacement);
    w.u8(o.firstAlertStep === null ? 0 : 1).u32(o.firstAlertStep === null ? 0 : o.firstAlertStep);
    w.u8(o.firstCatastrophicStep === null ? 0 : 1)
      .u32(o.firstCatastrophicStep === null ? 0 : o.firstCatastrophicStep);
  }
  return w.bytes();
}

// u16 version | u32 generationIndex | u32 count | per row: u32 id, u32 parent,
// u8 origin, u32 x 11 accounting counters
function encodeLineage(l) {
  const w = new Writer().u16(1).u32(l.generationIndex).u32(l.individuals.length);
  for (const r of l.individuals) {
    const origin = LINEAGE_ORIGINS.indexOf(r.origin);
    if (origin === -1) throw new Error(`unknown origin ${r.origin}`);
    w.u32(r.individualId);
    w.u32(r.parentIndividualId === null ? LINEAGE_NO_PARENT : r.parentIndividualId);
    w.u8(origin);
    for (const k of ACCOUNTING_KEYS) w.u32(r.accounting[k]);
  }
  return w.bytes();
}

function encodeHeader(h) {
  const flavor = PHYSICS_FLAVORS.indexOf(h.physicsFlavor);
  if (flavor === -1) throw new Error(`unknown flavor ${h.physicsFlavor}`);
  const manifest = hexToBytes(h.initializationManifestHex);
  const spec = hexToBytes(h.evaluationSpecHex);
  return new Writer()
    .u16(h.evolutionEngineVersion).u16(h.evolutionPolicyVersion)
    .u16(h.generationRecordVersion).u16(h.lineageVersion)
    .u16(h.evaluationMetadataVersion).u16(h.tournamentSelectionVersion)
    .u16(h.elitismVersion).u16(h.parametricMutationVersion)
    .u8(h.tournamentSize).u8(h.eliteCount).u8(flavor)
    .utf8Field(h.packageName)
    .utf8Field(h.rapierVersion)
    .u32(h.populationSize).u32(h.maxGenerations)
    .f64(h.mutationProbability).f64(h.mutationMagnitude)
    .u32(manifest.length)
    .raw(manifest)
    .u32(spec.length)
    .raw(spec)
    .bytes();
}

// u16 recordVersion | u32 generationIndex | u8 terminalReason
// then per component IN ORDER: u32 len | bytes | u8[32] digest
function encodeGenerationPayload(generationIndex, terminalReason, components) {
  const terminal = TERMINAL_REASONS.indexOf(terminalReason);
  if (terminal === -1) throw new Error(`unknown terminal reason ${terminalReason}`);
  const w = new Writer().u16(1).u32(generationIndex).u8(terminal);
  for (const kind of COMPONENT_KINDS) {
    const bytes = components[kind];
    w.u32(bytes.length).raw(bytes).raw(domainDigest(DOMAINS[kind], bytes));
  }
  return w.bytes();
}

// --- The artifact ------------------------------------------------------------

export function buildArtifact(inputs) {
  const components = {
    population: encodePopulationSnapshot(inputs.population),
    evaluationMetadata: encodeEvaluationMetadata(inputs.metadata),
    fitnessVector: encodeFitnessVectorV3(inputs.fitness),
    lineage: encodeLineage(inputs.lineage),
  };
  const headerBytes = encodeHeader(inputs.header);
  const headerDigestBytes = domainDigest(DOMAINS.header, headerBytes);
  const payloadBytes = encodeGenerationPayload(0, 'none', components);
  // Generation 0 chains from the HEADER digest, so the chain covers
  // configuration and runtime identity rather than only the records.
  const genDigest = generationDigest(headerDigestBytes, payloadBytes);

  const body = new Writer()
    .raw(MAGIC).u16(1).u32(headerBytes.length)
    .raw(headerBytes)
    .raw(headerDigestBytes)
    .u32(1) // generationRecordCount
    .u32(payloadBytes.length)
    .raw(payloadBytes)
    .raw(genDigest)
    .bytes();
  // The history digest is a TRAILER outside the body — a digest cannot cover
  // itself.
  const historyDigestBytes = domainDigest(DOMAINS.history, body);
  const artifact = new Writer().raw(body).raw(historyDigestBytes).bytes();
  return { artifact, headerDigestBytes, historyDigestBytes };
}

const inputPath = process.argv[2];
if (inputPath) {
  const inputs = JSON.parse(readFileSync(inputPath, 'utf8'));
  const { artifact, headerDigestBytes, historyDigestBytes } = buildArtifact(inputs);
  process.stdout.write(JSON.stringify({
    base64: Buffer.from(artifact).toString('base64'),
    byteLength: artifact.length,
    headerDigestHex: bytesToHex(headerDigestBytes),
    historyDigestHex: bytesToHex(historyDigestBytes),
    artifactSha256Hex: bytesToHex(sha256(artifact)),
  }, null, 2));
}
