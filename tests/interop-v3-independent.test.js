// THE STRUCTURAL-INDEPENDENCE ORACLE (R2 / definition-of-done item 4).
//
// tests/fixtures/evolution-v3-interop.base64 holds the successful-replay role
// since fitness-vector v3. This suite proves the role is not circular: the
// artifact's fitness-vector encoding and its entire framing / digest assembly
// are reproduced BYTE-FOR-BYTE by scripts/interop-v3-encoder.js — a tool that
// imports nothing from src/ and hashes with Node's own crypto — from the
// written format spec plus the captured-literals manifest (header and derived
// population/metadata/lineage components ride as opaque inputs, not
// evidence; the claim is deliberately narrow and the fixture .md says so).
//
// Three teeth, in dependency order:
//   (1) the encoder's independence is STATIC — its import list is asserted
//       from source, so a convenience import of the real codec cannot
//       quietly hollow out the oracle;
//   (2) the independent encoding equals the committed fixture exactly;
//   (3) the independently assembled bytes verify, resume and CONTINUE to the
//       locked terminal digest — DoD 4 end-to-end, on the encoder's own
//       output rather than on the fixture it happens to match.

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';

import { encodeInteropArtifact, encodeFitnessVectorV3 } from '../scripts/interop-v3-encoder.js';
import { resumeEvolutionRun } from '../src/sim/evolution-run.js';
import {
  checkFitnessVectorCompatibility, verifyFitnessVectorMetadataCoherence, verifyHistoryArtifact,
} from '../src/sim/evolution-replay.js';
import { bytesToHex } from '../src/sim/bytes.js';

// Locked beside the replay suite and the producer script — one literal, three
// consumers, all of which must move together in a reviewed re-lock.
const INTEROP_TERMINAL_HISTORY_DIGEST = 'bc53c425b88c3cb549285749abc82282162a580f93b741632702028a6cbf247b';

const ENCODER_URL = new URL('../scripts/interop-v3-encoder.js', import.meta.url);

const manifest = () => JSON.parse(readFileSync(
  new URL('./fixtures/evolution-v3-interop.manifest.json', import.meta.url), 'utf8',
));

const fixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v3-interop.base64', import.meta.url), 'utf8').trim(),
  'base64',
));

describe('the structurally independent v3 encoder', () => {
  test('independence is enforced STATICALLY: every import is a node: builtin, crypto among them', () => {
    const source = readFileSync(fileURLToPath(ENCODER_URL), 'utf8');
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';?$/gm)]
      .map((m) => m[1]);
    // A tool with no imports at all would be suspicious too — the whole point
    // is that SHA-256 comes from node:crypto, not the platform adapter.
    expect(specifiers).toContain('node:crypto');
    for (const specifier of specifiers) {
      expect(specifier, `banned import ${specifier} — the encoder must stay independent of src/`)
        .toMatch(/^node:/);
    }
    // No side doors: neither dynamic import nor require can smuggle the real
    // codec in past the static list above.
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  test('the independent encoding reproduces the committed fixture byte-for-byte', () => {
    const encoded = encodeInteropArtifact(manifest());
    const fixture = fixtureBytes();
    expect(encoded.length).toBe(4160);
    expect(bytesToHex(encoded)).toBe(bytesToHex(fixture));
  });

  test('the independently encoded fitness vector alone matches the v3 geometry', () => {
    const vector = encodeFitnessVectorV3(manifest().generation.fitnessVector);
    // 22-byte header + 4 members × 48 bytes, and the version word leads.
    expect(vector.length).toBe(22 + 4 * 48);
    expect(vector[0] | (vector[1] << 8)).toBe(3);
  });

  test('the independently assembled artifact verifies, resumes and continues to the locked terminal digest (DoD 4)', async () => {
    const encoded = encodeInteropArtifact(manifest());
    // The full pre-physics battery over the encoder's own output: stages 3-7,
    // then Gate A and Gate B — the same seam every real artifact crosses.
    const verified = await verifyHistoryArtifact(encoded);
    expect(verified.finalGenerationIndex).toBe(0);
    expect(verified.finalTerminalReason).toBe('none');
    checkFitnessVectorCompatibility(verified);
    verifyFitnessVectorMetadataCoherence(verified);
    // Resume the independent bytes and continue the run to its terminal
    // record — real physics, and the terminal digest must land on the same
    // literal the producer script printed at re-lock time.
    const resumed = await resumeEvolutionRun(encoded);
    let result;
    do { result = await resumed.advance(); } while (result.kind !== 'terminal');
    expect(bytesToHex(resumed.historyBytes().slice(-32))).toBe(INTEROP_TERMINAL_HISTORY_DIGEST);
  });
});
