// The Chromium evolution gate: pinned-browser reproduction of the committed
// evolution-a-small-flat locks. There is NO second implementation here — this
// file is imports plus assertions (the evaluation/population browser-gate
// ruling): the same production modules Vite serves to Node run in Chromium and
// must land the same header digest, the same per-generation component and
// chain digests, the same lineage rows, and the same whole-history digest.
//
// WHAT AGREEMENT HERE PROVES, and what it does not. Because the artifact binds
// the initializer draw table, the repair pass, every canonical encoding, the
// per-individual physics, the fitness policy, the integrity gate, the operator
// versions and the SHA-256 identity, cross-runtime agreement transitively
// covers all of them. It says nothing about rendering, and nothing about the
// default (non-deterministic) physics flavor, which is never locked (F10).
//
// The SHA-256 seam is the one genuinely new cross-runtime dependency in PR 3:
// Node's WebCrypto and Chromium's must produce identical digests, and this gate
// is where that stops being an assumption.

import { describe, test, expect } from 'vitest';

import { EVOLUTION_GOLDEN_LOCKS } from '../../src/sim/evolution-locks.js';
import { EVOLUTION_FIXTURE_A, evolutionRunConfigFor } from '../../src/sim/evolution-fixtures.js';
import { createEvolutionRun, resumeEvolutionRun } from '../../src/sim/evolution-run.js';
import { verifyHistoryArtifact } from '../../src/sim/evolution-replay.js';
import {
  decodeEvolutionHeader, decodeGenerationPayload, decodeHistoryFraming,
  deserializeEvaluationMetadata,
} from '../../src/sim/evolution-history.js';
import { deserializeLineage } from '../../src/sim/evolution-lineage.js';
import { bytesToHex } from '../../src/sim/bytes.js';
import { sha256 } from '../../src/platform/sha256.js';
import KIMI_FIXTURE_BASE64 from '../fixtures/evolution-v1-kimi-k3max.base64?raw';

const LOCK = EVOLUTION_GOLDEN_LOCKS[EVOLUTION_FIXTURE_A.name];

function decodeBase64(text) {
  const binary = globalThis.atob(text.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe('evolution golden locks (Chromium)', () => {
  test('WebCrypto SHA-256 agrees with the known-answer vector', async () => {
    console.log(`evolution browser gate on: ${navigator.userAgent}`);
    const digest = await sha256(new TextEncoder().encode('abc'));
    expect(bytesToHex(digest)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('the committed artifact reproduces exactly in the browser', { timeout: 240000 }, async () => {
    const run = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
    let result;
    do { result = await run.advance(); } while (result.kind !== 'terminal');
    const bytes = run.historyBytes();
    const framing = decodeHistoryFraming(bytes);
    const header = decodeEvolutionHeader(framing.headerBytes);

    expect(header.rapierVersion, 'engine changed — re-lock deliberately via the Node gate').toBe(LOCK.rapierVersion);
    expect(header.physicsFlavor).toBe(LOCK.physicsFlavor);
    expect(header.packageName).toBe(LOCK.packageName);
    expect(framing.headerBytes.length).toBe(LOCK.headerByteLength);
    expect(bytesToHex(framing.headerDigestBytes)).toBe(LOCK.headerDigest);

    const metadata = deserializeEvaluationMetadata(
      decodeGenerationPayload(framing.generations[0].payloadBytes).components.evaluationMetadata,
    );
    expect(Object.is(metadata.effectiveDt, LOCK.effectiveDt), `effectiveDt ${metadata.effectiveDt} !== locked ${LOCK.effectiveDt}`).toBe(true);
    expect(metadata.executedSteps).toBe(LOCK.executedSteps);

    expect(framing.generations.length).toBe(LOCK.generations.length);
    framing.generations.forEach((g, i) => {
      const locked = LOCK.generations[i];
      const payload = decodeGenerationPayload(g.payloadBytes);
      expect(payload.generationIndex, `generation ${i} index`).toBe(locked.generationIndex);
      expect(payload.terminalReason, `generation ${i} terminalReason`).toBe(locked.terminalReason);
      expect(bytesToHex(payload.componentDigests.population), `generation ${i} population digest`).toBe(locked.populationDigest);
      expect(bytesToHex(payload.componentDigests.evaluationMetadata), `generation ${i} metadata digest`).toBe(locked.evaluationMetadataDigest);
      expect(bytesToHex(payload.componentDigests.fitnessVector), `generation ${i} fitness digest`).toBe(locked.fitnessVectorDigest);
      expect(bytesToHex(payload.componentDigests.lineage), `generation ${i} lineage digest`).toBe(locked.lineageDigest);
      expect(bytesToHex(g.generationDigestBytes), `generation ${i} chained digest`).toBe(locked.generationDigest);
      const lineage = deserializeLineage(payload.components.lineage);
      expect(lineage.individuals.length).toBe(locked.lineage.length);
      lineage.individuals.forEach((row, r) => {
        const lockedRow = locked.lineage[r];
        expect(row.individualId, `generation ${i} row ${r} id`).toBe(lockedRow.individualId);
        expect(row.parentIndividualId, `generation ${i} row ${r} parent`).toBe(lockedRow.parentIndividualId);
        expect(row.origin, `generation ${i} row ${r} origin`).toBe(lockedRow.origin);
        expect(row.accounting.selectedLeafCount, `generation ${i} row ${r} selected`).toBe(lockedRow.selectedLeafCount);
        expect(row.accounting.eligibleContinuousLeafCount).toBe(lockedRow.eligibleContinuousLeafCount);
        expect(row.accounting.finalByteDeltaCount).toBe(lockedRow.finalByteDeltaCount);
      });
    });

    expect(bytes.length).toBe(LOCK.historyByteLength);
    expect(bytesToHex(framing.historyDigestBytes)).toBe(LOCK.historyDigest);
    expect(bytesToHex(result.historyDigestBytes)).toBe(LOCK.historyDigest);
  });

  test('the artifact resumes and replays in the browser too', { timeout: 240000 }, async () => {
    const run = createEvolutionRun(evolutionRunConfigFor(EVOLUTION_FIXTURE_A));
    let result;
    do { result = await run.advance(); } while (result.kind !== 'terminal');
    const bytes = run.historyBytes();
    // Resume re-verifies every digest and re-runs every generation's physics,
    // so a browser-only divergence would surface as `replayDivergence` with a
    // located stage rather than as a bare digest mismatch.
    const resumed = await resumeEvolutionRun(bytes, {
      expectedHistoryDigestBytes: result.historyDigestBytes,
      expectedGenerationIndex: LOCK.generations.length - 1,
    });
    expect(resumed.status().phase).toBe('terminal');
    expect(bytesToHex(resumed.historyBytes())).toBe(bytesToHex(bytes));
  });

  test('the v2 Kimi artifact is refused as unsupportedVersion (pre-PR-27 role: historical)', { timeout: 240000 }, async () => {
    const fixture = decodeBase64(KIMI_FIXTURE_BASE64);
    expect(fixture.length).toBe(4024);
    expect(fixture[14 + 18]).toBe(0);

    // The v2 artifact passes self-consistency (framing, header, digests, chain)
    // but is refused as unsupportedVersion before physics — the fitness vector
    // version is 2, this build implements 3.
    const verified = await verifyHistoryArtifact(fixture);
    expect(verified.finalGenerationIndex).toBe(0);

    // Resume fails with unsupportedVersion naming the fitness-vector field.
    let caught = null;
    try {
      await resumeEvolutionRun(fixture);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('unsupportedVersion');
    expect(caught.context.field).toBe('fitnessVectorVersion');
    expect(caught.context.generationIndex).toBe(0);
  });
});
