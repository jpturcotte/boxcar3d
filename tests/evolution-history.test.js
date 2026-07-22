// EVOLUTION HISTORY v1 — the byte format and its domain-separated identity.
//
// Pure: no physics, no Rapier, no clock. Component bytes here are opaque
// fillers, deliberately — this suite is about FRAMING and IDENTITY, and using
// real population/fitness bytes would make it depend on the engine it is meant
// to be independent of.
//
// Four legs:
//   (1) a COPY-DECLARED byte layout, asserted against literals and against a
//       hand-built stream, so a geometry change cannot move both the encoder
//       and its test at once;
//   (2) round trips in both directions for every codec;
//   (3) the digest formulas verified against INDEPENDENTLY constructed inputs
//       — the domain string, the length prefix and the chaining are rebuilt
//       here from copy-declared literals and hashed with the same primitive,
//       so a change to any of them reddens this file rather than quietly
//       redefining identity;
//   (4) every malformed-stream class rejected with the STABLE code a caller
//       branches on, and every resource ceiling checked at the exact value and
//       one past it.

import { describe, test, expect } from 'vitest';

import {
  COMPONENT_KINDS, EVALUATION_METADATA_VERSION, EVOLUTION_DIGEST_DOMAINS,
  EVOLUTION_HISTORY_MAGIC, EVOLUTION_HISTORY_VERSION, GENERATION_RECORD_VERSION,
  MAX_EVOLUTION_COMPONENT_BYTES, MAX_EVOLUTION_HEADER_BYTES,
  MAX_EVOLUTION_HISTORY_BYTES, MAX_EVOLUTION_RECORD_BYTES,
  SHA256_DIGEST_BYTES, WORLD_MODES, assembleHistory, decodeEvolutionHeader,
  decodeGenerationPayload, decodeHistoryFraming, deserializeEvaluationMetadata,
  digestComponent, digestGeneration, digestHeader, digestHistoryBody, digestsEqual,
  encodeEvolutionHeader, encodeGenerationPayload, serializeEvaluationMetadata,
} from '../src/sim/evolution-history.js';
import { EvolutionError, MAX_EVOLUTION_GENERATIONS, TERMINAL_REASONS } from '../src/sim/evolution-contract.js';
import { sha256 } from '../src/platform/sha256.js';
import { bytesToHex } from '../src/sim/bytes.js';

// COPY-DECLARED literals. Never derived from the module under test.
const DECLARED_MAGIC = 'BC3DEVO1';
const DECLARED_METADATA_BYTES = 15; // u16 + u8 + f64 + u32
const DECLARED_DOMAINS = Object.freeze({
  header: 'boxcar3d/evolution-history/header/v1\0',
  population: 'boxcar3d/evolution-history/population/v1\0',
  evaluationMetadata: 'boxcar3d/evolution-history/evaluation-metadata/v1\0',
  fitnessVector: 'boxcar3d/evolution-history/fitness-vector/v1\0',
  lineage: 'boxcar3d/evolution-history/lineage/v1\0',
  generation: 'boxcar3d/evolution-history/generation/v1\0',
  history: 'boxcar3d/evolution-history/history/v1\0',
});

const filler = (n, seed = 1) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

const HEADER = Object.freeze({
  evolutionEngineVersion: 1,
  evolutionPolicyVersion: 1,
  generationRecordVersion: GENERATION_RECORD_VERSION,
  lineageVersion: 1,
  evaluationMetadataVersion: EVALUATION_METADATA_VERSION,
  tournamentSelectionVersion: 1,
  elitismVersion: 1,
  parametricMutationVersion: 1,
  tournamentSize: 3,
  eliteCount: 2,
  physicsFlavor: 'deterministicCompat',
  packageName: '@dimforge/rapier3d-deterministic-compat',
  rapierVersion: '0.19.3',
  populationSize: 6,
  maxGenerations: 3,
  mutationProbability: 0.05,
  mutationMagnitude: 0.05,
});

const header = (overrides = {}) => ({
  ...HEADER,
  initializationManifestBytes: filler(33, 7),
  evaluationSpecBytes: filler(64, 11),
  ...overrides,
});

const metadata = (overrides = {}) => ({
  worldMode: 'isolatedWorlds',
  effectiveDt: 0.01666666753590107,
  executedSteps: 45,
  ...overrides,
});

const components = (seed = 1) => ({
  population: filler(96, seed),
  evaluationMetadata: serializeEvaluationMetadata(metadata()),
  fitnessVector: filler(50, seed + 1),
  lineage: filler(63, seed + 2),
});

async function digestsFor(cs) {
  const out = {};
  for (const kind of COMPONENT_KINDS) out[kind] = await digestComponent(kind, cs[kind]);
  return out;
}

async function buildArtifact({ generationCount = 2, terminalAt = 1 } = {}) {
  const headerBytes = encodeEvolutionHeader(header());
  const headerDigestBytes = await digestHeader(headerBytes);
  const generations = [];
  let previous = headerDigestBytes;
  for (let i = 0; i < generationCount; i += 1) {
    const cs = components(i + 1);
    const payloadBytes = encodeGenerationPayload({
      generationIndex: i,
      terminalReason: i === terminalAt ? 'generationLimitReached' : 'none',
      components: cs,
    }, await digestsFor(cs));
    const generationDigestBytes = await digestGeneration(previous, payloadBytes);
    previous = generationDigestBytes;
    generations.push({ payloadBytes, generationDigestBytes });
  }
  const assembled = await assembleHistory({ headerBytes, headerDigestBytes, generations });
  return {
    ...assembled, headerBytes, headerDigestBytes, generations,
  };
}

const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

function expectCode(fn, code, re) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  expect(threw, `expected a throw with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  if (re) expect(threw.message).toMatch(re);
  return threw;
}

// ============================================================================
// (1) DECLARED GEOMETRY
// ============================================================================

describe('the framing geometry is declared, not derived', () => {
  test('the magic is exactly ASCII "BC3DEVO1"', () => {
    expect(EVOLUTION_HISTORY_MAGIC.length).toBe(8);
    expect(String.fromCharCode(...EVOLUTION_HISTORY_MAGIC)).toBe(DECLARED_MAGIC);
  });

  test('the component order and kind set are the copy-declared literal', () => {
    // Order is wire-significant: swapping two kinds produces a stream that
    // decodes cleanly into a record whose components are misattributed.
    expect([...COMPONENT_KINDS]).toEqual([
      'population', 'evaluationMetadata', 'fitnessVector', 'lineage',
    ]);
  });

  test('deterministicCompat is format-owned physics flavor ordinal 0', () => {
    // This byte is part of evolution history v1. It must not be derived from
    // the adapter's broader runtime choices or reordered with them.
    const bytes = encodeEvolutionHeader(header());
    expect(bytes[18]).toBe(0);
    expect(decodeEvolutionHeader(bytes).physicsFlavor).toBe('deterministicCompat');
  });

  test('the digest domains are the copy-declared, NUL-terminated literals', () => {
    // A domain change silently redefines every identity in every artifact
    // ever written. This is the tooth that makes it a deliberate act.
    expect({ ...EVOLUTION_DIGEST_DOMAINS }).toEqual({ ...DECLARED_DOMAINS });
    for (const [kind, domain] of Object.entries(DECLARED_DOMAINS)) {
      expect(domain.endsWith('\0'), `${kind} must be NUL-terminated`).toBe(true);
      expect(domain.startsWith('boxcar3d/evolution-history/')).toBe(true);
    }
    // No two domains coincide — the whole point of separating them.
    expect(new Set(Object.values(DECLARED_DOMAINS)).size).toBe(Object.keys(DECLARED_DOMAINS).length);
  });

  test('the outer frame is magic, version, headerLength, header, headerDigest, count', async () => {
    const artifact = await buildArtifact({ generationCount: 1, terminalAt: 0 });
    const view = new DataView(artifact.bytes.buffer, artifact.bytes.byteOffset, artifact.bytes.byteLength);
    for (let i = 0; i < 8; i += 1) expect(artifact.bytes[i]).toBe(DECLARED_MAGIC.charCodeAt(i));
    expect(view.getUint16(8, true)).toBe(EVOLUTION_HISTORY_VERSION);
    const headerLength = view.getUint32(10, true);
    expect(headerLength).toBe(artifact.headerBytes.length);
    expect(view.getUint32(14 + headerLength + SHA256_DIGEST_BYTES, true)).toBe(1);
  });

  test('the evaluation metadata is exactly 15 bytes, at the declared offsets', () => {
    const bytes = serializeEvaluationMetadata(metadata());
    expect(bytes.length).toBe(DECLARED_METADATA_BYTES);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(0, true)).toBe(EVALUATION_METADATA_VERSION);
    expect(view.getUint8(2)).toBe(0); // isolatedWorlds
    expect(view.getFloat64(3, true)).toBe(0.01666666753590107);
    expect(view.getUint32(11, true)).toBe(45);
    expect([...WORLD_MODES]).toEqual(['isolatedWorlds']);
  });

  test('a generation payload holds all four components even when TERMINAL', async () => {
    const cs = components();
    const payload = encodeGenerationPayload(
      { generationIndex: 4, terminalReason: 'noSelectableParents', components: cs },
      await digestsFor(cs),
    );
    const decoded = decodeGenerationPayload(payload);
    expect(decoded.terminalReason).toBe('noSelectableParents');
    expect(Object.keys(decoded.components).sort()).toEqual([...COMPONENT_KINDS].sort());
    for (const kind of COMPONENT_KINDS) {
      expect(bytesEqual(decoded.components[kind], cs[kind]), kind).toBe(true);
    }
  });

  test('THE TRACE-EXCLUSION PREMISE: the payload admits exactly four component kinds', async () => {
    // PR 3 Commit 0's policy rests on this being STRUCTURAL. A record has no
    // property bag and no optional component, so a trace, a checkpoint, a live
    // diagnostic or comparator evidence has no byte walk to enter through.
    const cs = { ...components(), trace: filler(8), diagnostics: filler(8) };
    const decoded = decodeGenerationPayload(encodeGenerationPayload(
      { generationIndex: 0, terminalReason: 'none', components: cs }, await digestsFor(cs),
    ));
    expect(Object.keys(decoded.components).sort()).toEqual([...COMPONENT_KINDS].sort());
    expect(Object.prototype.hasOwnProperty.call(decoded.components, 'trace')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(decoded.components, 'diagnostics')).toBe(false);
  });
});

// ============================================================================
// (2) ROUND TRIPS
// ============================================================================

describe('round trips, both directions', () => {
  test('the header survives encode -> decode -> encode byte-identically', () => {
    const source = header();
    const bytes = encodeEvolutionHeader(source);
    const decoded = decodeEvolutionHeader(bytes);
    expect(bytesEqual(encodeEvolutionHeader(decoded), bytes)).toBe(true);
    expect(decoded.physicsFlavor).toBe('deterministicCompat');
    expect(decoded.packageName).toBe(source.packageName);
    expect(decoded.rapierVersion).toBe('0.19.3');
    expect(Object.is(decoded.mutationProbability, 0.05)).toBe(true);
    expect(Object.is(decoded.mutationMagnitude, 0.05)).toBe(true);
    expect(bytesEqual(decoded.initializationManifestBytes, source.initializationManifestBytes)).toBe(true);
    expect(bytesEqual(decoded.evaluationSpecBytes, source.evaluationSpecBytes)).toBe(true);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  test('the decoded header owns its byte fields — no alias to the stream', () => {
    const bytes = encodeEvolutionHeader(header());
    const decoded = decodeEvolutionHeader(bytes);
    expect(decoded.initializationManifestBytes.buffer).not.toBe(bytes.buffer);
    expect(decoded.evaluationSpecBytes.buffer).not.toBe(bytes.buffer);
  });

  test('evaluation metadata round-trips with the exact f64 timestep', () => {
    const source = metadata();
    const decoded = deserializeEvaluationMetadata(serializeEvaluationMetadata(source));
    expect(Object.is(decoded.effectiveDt, source.effectiveDt)).toBe(true);
    expect(decoded.worldMode).toBe('isolatedWorlds');
    expect(decoded.executedSteps).toBe(45);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(bytesEqual(serializeEvaluationMetadata(decoded), serializeEvaluationMetadata(source))).toBe(true);
  });

  test.each(TERMINAL_REASONS)('a generation payload round-trips with terminalReason %s', async (reason) => {
    const cs = components();
    const digests = await digestsFor(cs);
    const bytes = encodeGenerationPayload({ generationIndex: 2, terminalReason: reason, components: cs }, digests);
    const decoded = decodeGenerationPayload(bytes);
    expect(decoded.terminalReason).toBe(reason);
    expect(decoded.generationIndex).toBe(2);
    expect(bytesEqual(
      encodeGenerationPayload(decoded, decoded.componentDigests), bytes,
    )).toBe(true);
  });

  test('a whole artifact re-frames byte-identically from its decoded parts', async () => {
    const artifact = await buildArtifact({ generationCount: 3, terminalAt: 2 });
    const framing = decodeHistoryFraming(artifact.bytes);
    expect(framing.historyVersion).toBe(EVOLUTION_HISTORY_VERSION);
    expect(framing.generations.length).toBe(3);
    const rebuilt = await assembleHistory({
      headerBytes: framing.headerBytes,
      headerDigestBytes: framing.headerDigestBytes,
      generations: framing.generations.map((g) => ({
        payloadBytes: g.payloadBytes, generationDigestBytes: g.generationDigestBytes,
      })),
    });
    expect(bytesEqual(rebuilt.bytes, artifact.bytes)).toBe(true);
    expect(bytesEqual(rebuilt.historyDigestBytes, artifact.historyDigestBytes)).toBe(true);
  });
});

// ============================================================================
// (3) DIGEST FORMULAS AND CHAIN SEMANTICS
// ============================================================================

describe('domain-separated digest formulas, rebuilt independently', () => {
  const encoder = new TextEncoder();
  const independentDigest = async (domain, ...parts) => {
    const domainBytes = encoder.encode(domain);
    const total = domainBytes.length + parts.reduce((n, p) => n + p.length, 0);
    const input = new Uint8Array(total);
    input.set(domainBytes, 0);
    let o = domainBytes.length;
    for (const p of parts) { input.set(p, o); o += p.length; }
    return bytesToHex(await sha256(input));
  };
  const u32le = (n) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n, true);
    return out;
  };

  test('headerDigest = SHA256(HEADER_DOMAIN || u32le(len) || headerBytes)', async () => {
    const headerBytes = encodeEvolutionHeader(header());
    expect(bytesToHex(await digestHeader(headerBytes)))
      .toBe(await independentDigest(DECLARED_DOMAINS.header, u32le(headerBytes.length), headerBytes));
  });

  test.each(COMPONENT_KINDS)('componentDigest(%s) = SHA256(DOMAIN || u32le(len) || bytes)', async (kind) => {
    const payload = filler(37, 5);
    expect(bytesToHex(await digestComponent(kind, payload)))
      .toBe(await independentDigest(DECLARED_DOMAINS[kind], u32le(payload.length), payload));
  });

  test('generationDigest = SHA256(GEN_DOMAIN || previousDigest32 || u32le(len) || payload)', async () => {
    const previous = await sha256(filler(4));
    const payload = filler(77, 3);
    expect(bytesToHex(await digestGeneration(previous, payload))).toBe(
      await independentDigest(DECLARED_DOMAINS.generation, previous, u32le(payload.length), payload),
    );
  });

  test('historyDigest = SHA256(HISTORY_DOMAIN || u32le(len) || body)', async () => {
    const body = filler(129, 9);
    expect(bytesToHex(await digestHistoryBody(body)))
      .toBe(await independentDigest(DECLARED_DOMAINS.history, u32le(body.length), body));
  });

  test('DOMAIN SEPARATION IS REAL: identical payload bytes hash differently per domain', async () => {
    const payload = filler(64, 2);
    const seen = new Set();
    for (const kind of COMPONENT_KINDS) seen.add(bytesToHex(await digestComponent(kind, payload)));
    seen.add(bytesToHex(await digestHeader(payload)));
    seen.add(bytesToHex(await digestHistoryBody(payload)));
    expect(seen.size).toBe(COMPONENT_KINDS.length + 2);
  });

  test('the LENGTH PREFIX removes concatenation ambiguity', async () => {
    // Without u32le(len), SHA256(D || "ab" || "c") and SHA256(D || "a" || "bc")
    // would be the same input. With it they cannot be.
    const a = bytesToHex(await digestComponent('population', Uint8Array.of(1, 2, 3)));
    const b = bytesToHex(await digestComponent('population', Uint8Array.of(1, 2)));
    expect(a).not.toBe(b);
  });

  test('generation 0 chains from the HEADER digest; later ones from their predecessor', async () => {
    const artifact = await buildArtifact({ generationCount: 3, terminalAt: 2 });
    let previous = artifact.headerDigestBytes;
    for (let i = 0; i < artifact.generations.length; i += 1) {
      const expected = await digestGeneration(previous, artifact.generations[i].payloadBytes);
      expect(digestsEqual(expected, artifact.generations[i].generationDigestBytes), `generation ${i}`).toBe(true);
      previous = artifact.generations[i].generationDigestBytes;
    }
  });

  test('the chain BINDS the header: changing one header byte changes every generation digest', async () => {
    const artifact = await buildArtifact({ generationCount: 2, terminalAt: 1 });
    const otherHeaderBytes = encodeEvolutionHeader(header({ populationSize: 7 }));
    const otherHeaderDigest = await digestHeader(otherHeaderBytes);
    const rechained = await digestGeneration(otherHeaderDigest, artifact.generations[0].payloadBytes);
    expect(digestsEqual(rechained, artifact.generations[0].generationDigestBytes)).toBe(false);
  });

  test('the history digest covers the body but NOT itself', async () => {
    const artifact = await buildArtifact({ generationCount: 2, terminalAt: 1 });
    const framing = decodeHistoryFraming(artifact.bytes);
    expect(framing.body.length).toBe(artifact.bytes.length - SHA256_DIGEST_BYTES);
    expect(digestsEqual(await digestHistoryBody(framing.body), framing.historyDigestBytes)).toBe(true);
    // The trailer really is the last 32 bytes of the artifact.
    for (let i = 0; i < SHA256_DIGEST_BYTES; i += 1) {
      expect(artifact.bytes[framing.body.length + i]).toBe(artifact.historyDigestBytes[i]);
    }
  });

  test('digestsEqual compares content, and length mismatches are not equal', async () => {
    const a = await sha256(filler(4));
    const b = await sha256(filler(4));
    expect(digestsEqual(a, b)).toBe(true);
    b[31] ^= 0xff;
    expect(digestsEqual(a, b)).toBe(false);
    expect(digestsEqual(a, filler(31))).toBe(false);
  });
});

// ============================================================================
// (4) MALFORMED STREAMS AND CEILINGS
// ============================================================================

describe('malformed streams are rejected with the stable code', () => {
  test('a wrong magic is not a BoxCar3D history', async () => {
    const artifact = await buildArtifact();
    artifact.bytes[0] = 0x00;
    expectCode(() => decodeHistoryFraming(artifact.bytes), 'malformedHistory', /magic/);
  });

  test.each([
    ['the outer history version', 8, 2],
    ['the generation record version', null, null],
  ])('an unsupported version is `unsupportedVersion` (%s)', async (_name, offset, value) => {
    if (offset === null) {
      const cs = components();
      const payload = encodeGenerationPayload({ generationIndex: 0, terminalReason: 'none', components: cs }, await digestsFor(cs));
      new DataView(payload.buffer, payload.byteOffset).setUint16(0, 9, true);
      expectCode(() => decodeGenerationPayload(payload), 'unsupportedVersion', /generationRecordVersion/);
      return;
    }
    const artifact = await buildArtifact();
    new DataView(artifact.bytes.buffer, artifact.bytes.byteOffset).setUint16(offset, value, true);
    expectCode(() => decodeHistoryFraming(artifact.bytes), 'unsupportedVersion', /historyVersion/);
  });

  test('an unsupported evaluationMetadataVersion is `unsupportedVersion`', () => {
    const bytes = serializeEvaluationMetadata(metadata());
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(0, 3, true);
    expectCode(() => deserializeEvaluationMetadata(bytes), 'unsupportedVersion');
  });

  test('truncation is refused', async () => {
    const artifact = await buildArtifact();
    for (const cut of [1, SHA256_DIGEST_BYTES, 100]) {
      expectCode(() => decodeHistoryFraming(artifact.bytes.slice(0, artifact.bytes.length - cut)),
        'malformedHistory');
    }
  });

  test('APPENDED bytes are refused — exact end-of-input is part of the identity', async () => {
    const artifact = await buildArtifact();
    const extended = new Uint8Array(artifact.bytes.length + 1);
    extended.set(artifact.bytes, 0);
    expectCode(() => decodeHistoryFraming(extended), 'malformedHistory', /trailing/);
  });

  test('zero generation records is refused', async () => {
    const artifact = await buildArtifact({ generationCount: 1, terminalAt: 0 });
    const view = new DataView(artifact.bytes.buffer, artifact.bytes.byteOffset);
    const headerLength = view.getUint32(10, true);
    view.setUint32(14 + headerLength + SHA256_DIGEST_BYTES, 0, true);
    expectCode(() => decodeHistoryFraming(artifact.bytes), 'malformedHistory', /generationRecordCount/);
  });

  test('a LYING record count is caught before the record walk iterates', async () => {
    const artifact = await buildArtifact({ generationCount: 1, terminalAt: 0 });
    const view = new DataView(artifact.bytes.buffer, artifact.bytes.byteOffset);
    const headerLength = view.getUint32(10, true);
    view.setUint32(14 + headerLength + SHA256_DIGEST_BYTES, 900, true);
    expectCode(() => decodeHistoryFraming(artifact.bytes), 'malformedHistory', /cannot fit/);
  });

  test('a record count above the generation ceiling is a resource refusal', async () => {
    const artifact = await buildArtifact({ generationCount: 1, terminalAt: 0 });
    const view = new DataView(artifact.bytes.buffer, artifact.bytes.byteOffset);
    const headerLength = view.getUint32(10, true);
    view.setUint32(14 + headerLength + SHA256_DIGEST_BYTES, MAX_EVOLUTION_GENERATIONS + 1, true);
    expectCode(() => decodeHistoryFraming(artifact.bytes), 'resourceLimitExceeded', /generationRecordCount/);
  });

  test('a lying nested component length is refused', async () => {
    const cs = components();
    const payload = encodeGenerationPayload({ generationIndex: 0, terminalReason: 'none', components: cs }, await digestsFor(cs));
    // The first component length sits after u16 version + u32 index + u8 terminal.
    new DataView(payload.buffer, payload.byteOffset).setUint32(7, 0xffff, true);
    expectCode(() => decodeGenerationPayload(payload), 'malformedHistory');
  });

  test('an out-of-range terminal byte and an unknown flavor byte are refused', async () => {
    const cs = components();
    const payload = encodeGenerationPayload({ generationIndex: 0, terminalReason: 'none', components: cs }, await digestsFor(cs));
    new DataView(payload.buffer, payload.byteOffset).setUint8(6, 9);
    expectCode(() => decodeGenerationPayload(payload), 'malformedHistory', /terminalReason/);
    const headerBytes = encodeEvolutionHeader(header());
    new DataView(headerBytes.buffer, headerBytes.byteOffset).setUint8(18, 9);
    expectCode(() => decodeEvolutionHeader(headerBytes), 'malformedHistory', /physicsFlavor/);
  });

  test.each([
    ['an unknown physicsFlavor', { physicsFlavor: 'nope' }],
    ['an empty packageName', { packageName: '' }],
    ['a non-string rapierVersion', { rapierVersion: 7 }],
    ['a NUL inside a string field', { rapierVersion: 'a\0b' }],
    ['populationSize 0', { populationSize: 0 }],
    ['maxGenerations 0', { maxGenerations: 0 }],
    ['a mutation probability above 1', { mutationProbability: 1.5 }],
    ['a NaN mutation magnitude', { mutationMagnitude: NaN }],
    ['a u16 version out of range', { elitismVersion: 70000 }],
    ['a u8 constant out of range', { tournamentSize: 300 }],
  ])('the header encoder refuses %s', (_name, overrides) => {
    expectCode(() => encodeEvolutionHeader(header(overrides)), 'invalidConfig');
  });

  test('non-canonical UTF-8 in a header string field is refused at decode', () => {
    const bytes = encodeEvolutionHeader(header());
    // The package-name field begins after 8 u16s + 3 u8s + its own length byte.
    const nameStart = 16 + 3 + 1;
    bytes[nameStart] = 0xff; // never a valid UTF-8 lead byte
    expectCode(() => decodeEvolutionHeader(bytes), 'malformedHistory', /canonical UTF-8/);
  });

  test('metadata with a bad world mode, a non-positive dt, or a bad step count is refused', () => {
    expectCode(() => serializeEvaluationMetadata(metadata({ worldMode: 'shared' })), 'invalidConfig');
    expectCode(() => serializeEvaluationMetadata(metadata({ effectiveDt: 0 })), 'invalidConfig');
    expectCode(() => serializeEvaluationMetadata(metadata({ effectiveDt: NaN })), 'invalidConfig');
    expectCode(() => serializeEvaluationMetadata(metadata({ executedSteps: -1 })), 'invalidConfig');
    const bytes = serializeEvaluationMetadata(metadata());
    new DataView(bytes.buffer, bytes.byteOffset).setFloat64(3, -1, true);
    expectCode(() => deserializeEvaluationMetadata(bytes), 'malformedHistory', /effectiveDt/);
  });
});

describe('resource ceilings, at the exact value and one past it', () => {
  test('the current operational ceilings are coherent, positive integer budgets', () => {
    for (const value of [
      MAX_EVOLUTION_COMPONENT_BYTES, MAX_EVOLUTION_HEADER_BYTES,
      MAX_EVOLUTION_RECORD_BYTES, MAX_EVOLUTION_HISTORY_BYTES,
      MAX_EVOLUTION_GENERATIONS,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(MAX_EVOLUTION_HEADER_BYTES).toBeLessThanOrEqual(MAX_EVOLUTION_HISTORY_BYTES);
    expect(MAX_EVOLUTION_COMPONENT_BYTES).toBeLessThanOrEqual(MAX_EVOLUTION_RECORD_BYTES);
    expect(MAX_EVOLUTION_RECORD_BYTES).toBeLessThan(MAX_EVOLUTION_HISTORY_BYTES);
  });

  test('the combined header is accepted at its cap and refused one byte over', () => {
    const empty = header({
      initializationManifestBytes: new Uint8Array(0),
      evaluationSpecBytes: new Uint8Array(0),
    });
    const fixedBytes = encodeEvolutionHeader(empty).length;
    const atCap = header({
      initializationManifestBytes: new Uint8Array(MAX_EVOLUTION_HEADER_BYTES - fixedBytes),
      evaluationSpecBytes: new Uint8Array(0),
    });
    const encoded = encodeEvolutionHeader(atCap);
    expect(encoded.length).toBe(MAX_EVOLUTION_HEADER_BYTES);
    expect(decodeEvolutionHeader(encoded).initializationManifestBytes.length)
      .toBe(MAX_EVOLUTION_HEADER_BYTES - fixedBytes);

    const over = header({
      initializationManifestBytes: new Uint8Array(MAX_EVOLUTION_HEADER_BYTES - fixedBytes),
      evaluationSpecBytes: new Uint8Array(1),
    });
    expectCode(() => encodeEvolutionHeader(over), 'resourceLimitExceeded', /header byte length/);
  });

  test('a DECLARED component length past the ceiling is refused BEFORE any slice', async () => {
    // Reaching the ceiling with a real buffer would allocate 16 MiB per case;
    // the check that matters is the DECLARED length in the stream, which is
    // what a hostile artifact controls and what must be rejected before the
    // decoder tries to read that many bytes.
    const cs = components();
    const payload = encodeGenerationPayload({ generationIndex: 0, terminalReason: 'none', components: cs }, await digestsFor(cs));
    new DataView(payload.buffer, payload.byteOffset).setUint32(7, MAX_EVOLUTION_COMPONENT_BYTES + 1, true);
    expectCode(() => decodeGenerationPayload(payload), 'resourceLimitExceeded', /components\.population/);
  });

  test('a declared header length past the component ceiling is refused', async () => {
    const artifact = await buildArtifact({ generationCount: 1, terminalAt: 0 });
    new DataView(artifact.bytes.buffer, artifact.bytes.byteOffset)
      .setUint32(10, MAX_EVOLUTION_COMPONENT_BYTES + 1, true);
    expectCode(() => decodeHistoryFraming(artifact.bytes), 'resourceLimitExceeded', /headerByteLength/);
  });

  test('a declared generation payload length past the record ceiling is refused', async () => {
    const artifact = await buildArtifact({ generationCount: 1, terminalAt: 0 });
    const view = new DataView(artifact.bytes.buffer, artifact.bytes.byteOffset);
    const headerLength = view.getUint32(10, true);
    view.setUint32(14 + headerLength + SHA256_DIGEST_BYTES + 4, MAX_EVOLUTION_RECORD_BYTES + 1, true);
    expectCode(() => decodeHistoryFraming(artifact.bytes), 'resourceLimitExceeded', /payloadByteLength/);
  });

  test('a generationIndex at or past the generation ceiling is refused on both sides', async () => {
    const cs = components();
    const digests = await digestsFor(cs);
    expectCode(
      () => encodeGenerationPayload({ generationIndex: MAX_EVOLUTION_GENERATIONS, terminalReason: 'none', components: cs }, digests),
      'resourceLimitExceeded', /generationIndex/,
    );
    // The last legal index encodes fine.
    const ok = encodeGenerationPayload(
      { generationIndex: MAX_EVOLUTION_GENERATIONS - 1, terminalReason: 'none', components: cs }, digests,
    );
    expect(decodeGenerationPayload(ok).generationIndex).toBe(MAX_EVOLUTION_GENERATIONS - 1);
    new DataView(ok.buffer, ok.byteOffset).setUint32(2, MAX_EVOLUTION_GENERATIONS, true);
    expectCode(() => decodeGenerationPayload(ok), 'resourceLimitExceeded', /generationIndex/);
  });

  test('assembleHistory refuses a record count above the ceiling before allocating', async () => {
    const headerBytes = encodeEvolutionHeader(header());
    const headerDigestBytes = await digestHeader(headerBytes);
    const one = { payloadBytes: filler(8), generationDigestBytes: headerDigestBytes };
    const tooMany = new Array(MAX_EVOLUTION_GENERATIONS + 1).fill(one);
    expectCode(() => assembleHistory({ headerBytes, headerDigestBytes, generations: tooMany }),
      'resourceLimitExceeded', /generationRecordCount/);
    expectCode(() => assembleHistory({ headerBytes, headerDigestBytes, generations: [] }),
      'invalidConfig', /at least one generation/);
  });

  test('the 64 MiB history ceiling is checked at the EXACT value and one past it', () => {
    // A shadowed `length` would be defeated by the intrinsic geometry read, so
    // the only honest way to test this boundary is a real buffer. One 64 MiB
    // allocation, two windows over it: at the ceiling the size check PASSES and
    // the walk proceeds to fail on the magic (a different code — which is what
    // proves the ceiling is not simply rejecting everything large), one past it
    // the refusal is `resourceLimitExceeded` BEFORE any read happens.
    const buffer = new ArrayBuffer(MAX_EVOLUTION_HISTORY_BYTES + 1);
    const onePast = new Uint8Array(buffer);
    expectCode(() => decodeHistoryFraming(onePast), 'resourceLimitExceeded', /history byte length/);
    const atCeiling = new Uint8Array(buffer, 0, MAX_EVOLUTION_HISTORY_BYTES);
    expectCode(() => decodeHistoryFraming(atCeiling), 'malformedHistory', /magic/);
  });
});
