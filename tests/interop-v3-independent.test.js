// EXECUTABLE INDEPENDENCE FOR THE FITNESS-VECTOR-V3 ORACLE.
//
// The committed interop artifact is useful only if its producer stays separate
// from the implementation under test and can still reproduce the exact bytes.
// This suite enforces both claims, then hands the freshly produced artifact to
// the production verifier and resume path.

import { describe, expect, test } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { encodeInteropArtifact } from '../scripts/generate-evolution-v3-interop-fixture.js';
import { resumeEvolutionRun } from '../src/sim/evolution-run.js';
import {
  checkFitnessVectorCompatibility, verifyEvolutionArtifactSemantics,
  verifyFitnessVectorMetadataCoherence, verifyHistoryArtifact,
} from '../src/sim/evolution-replay.js';
import { EVOLUTION_FIXTURE_A } from '../src/sim/evolution-fixtures.js';
import { EVOLUTION_GOLDEN_LOCKS } from '../src/sim/evolution-locks.js';
import { bytesToHex } from '../src/sim/bytes.js';

const GENERATOR_URL = new URL('../scripts/generate-evolution-v3-interop-fixture.js', import.meta.url);
const INPUTS_URL = new URL('./fixtures/evolution-v1-fitness-vector-v3-oracle-inputs.json', import.meta.url);
const FIXTURE_URL = new URL('./fixtures/evolution-v1-fitness-vector-v3-kimi.base64', import.meta.url);

const inputs = () => JSON.parse(readFileSync(INPUTS_URL, 'utf8'));
const fixtureBytes = () => new Uint8Array(Buffer.from(
  readFileSync(FIXTURE_URL, 'utf8').trim(), 'base64',
));

describe('independent fitness-vector-v3 producer', () => {
  test('imports only Node built-ins, never production implementation modules', () => {
    const source = readFileSync(GENERATOR_URL, 'utf8');
    // Cover both `import x from '…'` and side-effect-only `import '…'`.
    const imports = [...source.matchAll(/\b(?:from\s+|import\s*)['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);

    expect(imports).toContain('node:crypto');
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  test('recreates the committed artifact byte-for-byte with literal v3 geometry', () => {
    const declared = inputs();
    const encoded = encodeInteropArtifact(declared);

    expect(encoded.artifact).toEqual(fixtureBytes());
    expect(encoded.fitnessVectorBytes.length)
      .toBe(22 + 48 * declared.generation.components.fitnessVector.individuals.length);
    expect(new DataView(
      encoded.fitnessVectorBytes.buffer,
      encoded.fitnessVectorBytes.byteOffset,
      encoded.fitnessVectorBytes.byteLength,
    ).getUint16(0, true)).toBe(3);
  });

  test('freshly encoded bytes verify, pass all pre-physics gates, resume, and continue', async () => {
    const { artifact } = encodeInteropArtifact(inputs());
    const verified = await verifyHistoryArtifact(artifact);
    expect(verified.finalGenerationIndex).toBe(0);
    expect(() => checkFitnessVectorCompatibility(verified)).not.toThrow();
    expect(() => verifyFitnessVectorMetadataCoherence(verified)).not.toThrow();
    expect(() => verifyEvolutionArtifactSemantics(verified)).not.toThrow();

    const resumed = await resumeEvolutionRun(artifact);
    let result;
    do { result = await resumed.advance(); } while (result.kind !== 'terminal');

    expect(bytesToHex(resumed.historyBytes().slice(-32)))
      .toBe(EVOLUTION_GOLDEN_LOCKS[EVOLUTION_FIXTURE_A.name].historyDigest);
  });
});
