// The offline read seam: integrity evidence out of a persisted history, with
// NO physics — and refused outright when the artifact does not attest it.
//
// This is the capability fitness vector v3 exists to provide, so the central
// test is the negative one: before v3, "was this champion locomotion or solver
// divergence?" required re-simulating. The first test below answers it from
// bytes alone; the rest establish that it only ever answers from bytes a digest
// vouches for.
//
// The committed v3 interoperability artifact is the subject of most of this
// file (produced by an encoder written from the format spec —
// tests/fixtures/evolution-v3-independent.md), so those tests run no engine.
//
// The LAST block does run one, deliberately: the committed fixture is a single
// generation of four individuals whose ids happen to equal their array indices
// and whose every row is `initialized`, so it cannot exercise id-keyed lineage
// joins, elite provenance, cross-generation genotype identity, or the
// per-generation loop. Keying both maps by array index instead of individualId
// left this file green. A real multi-generation run is the only artifact that
// distinguishes them.

import {
  describe, test, expect, vi, beforeEach,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

// A pass-through spy purely to COUNT physics. The seam's headline promise is
// "evidence with no re-simulation", and a title is not an assertion: this is
// what turns it into one.
vi.mock('../src/sim/population-evaluation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    evaluatePopulation: async (population, spec) => {
      if (globalThis.__observationProbe) globalThis.__observationProbe.evaluations += 1;
      return original.evaluatePopulation(population, spec);
    },
  };
});

const {
  HISTORY_OBSERVATIONS_SCHEMA, extractHistoryObservations,
} = await import('../scripts/history-observations.js');
const { EvolutionError } = await import('../src/sim/evolution-contract.js');
const {
  decodeGenerationPayload, decodeHistoryFraming,
} = await import('../src/sim/evolution-history.js');
const { hexToBytes } = await import('../src/sim/bytes.js');
const { createEvolutionRun } = await import('../src/sim/evolution-run.js');
const { reforge } = await import('./helpers/evolution-artifacts.js');

beforeEach(() => { globalThis.__observationProbe = { evaluations: 0 }; });

const artifact = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v3-independent.base64', import.meta.url), 'utf8').trim(),
  'base64',
));
// Declared in tests/fixtures/evolution-v3-independent.md. Both are asserted
// below so the provenance document's identity block cannot go stale
// unnoticed — it recorded the WRONG header digest (a copy-paste of the golden
// evolution-lock fixture's, a different configuration entirely) and nothing
// caught it, because no test read that line.
const HISTORY_DIGEST = 'aea30ef11d4d6c75adc5af1a88b9a1a408e5ab51962690a29b7ec81dffd7e79c';
const HEADER_DIGEST = '312665978b18bdd920668a1ee3bc49b301a24b76d7497f9ef328732b6939bfce';

// The v2 artifact, which this seam must refuse for its FORMAT rather than
// silently read under v3 semantics.
const staleArtifact = () => new Uint8Array(Buffer.from(
  readFileSync(new URL('./fixtures/evolution-v1-kimi-k3max.base64', import.meta.url), 'utf8').trim(),
  'base64',
));

/** First index at which `needle` occurs in `haystack`, or -1. */
function indexOfSubarray(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let k = 0; k < needle.length; k += 1) {
      if (haystack[i + k] !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}

async function expectCode(fn, code) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  expect(threw, `expected a rejection with code ${code}`).toBeInstanceOf(EvolutionError);
  expect(threw.code).toBe(code);
  return threw;
}

describe('extractHistoryObservations — evidence without physics', () => {
  test('a committed history yields every observation, and no engine is loaded', async () => {
    const result = await extractHistoryObservations(artifact());
    expect(result.schema).toBe(HISTORY_OBSERVATIONS_SCHEMA);
    expect(result.fitnessVectorVersion).toBe(3);
    expect(result.historyDigest).toBe(HISTORY_DIGEST);
    expect(result.headerDigest).toBe(HEADER_DIGEST);
    expect(result.generations).toHaveLength(1);

    const g = result.generations[0];
    expect(g.generationIndex).toBe(0);
    expect(g.executedSteps).toBe(60);
    expect(g.individuals).toHaveLength(4);

    for (const row of g.individuals) {
      const o = row.observations;
      // The five fields are PRESENT and typed — the whole point of v3.
      expect(Object.keys(o).slice().sort()).toEqual([
        'firstAlertStep', 'firstCatastrophicStep',
        'peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement',
      ]);
      for (const k of ['peakBodySpeed', 'peakSpeedDelta', 'peakStepDisplacement']) {
        expect(typeof o[k], `${k} on individual ${row.individualId}`).toBe('number');
        expect(o[k] >= 0, `${k} must be non-negative`).toBe(true);
      }
      for (const k of ['firstAlertStep', 'firstCatastrophicStep']) {
        expect(o[k] === null || Number.isInteger(o[k]), `${k} is null or an integer`).toBe(true);
        // Gate B's bound, restated as a property of what came back.
        if (o[k] !== null) expect(o[k]).toBeLessThanOrEqual(g.executedSteps);
      }
      // Lineage provenance is joined by id, so a consumer can attribute an
      // observation to how the individual came to exist.
      expect(row.origin).toBe('initialized');
      expect(row.parentIndividualId).toBeNull();
    }
  });

  test('THE QUESTION v3 EXISTS TO ANSWER, asked of saved bytes only', async () => {
    // Under v2 this was unanswerable without re-running the physics: the
    // vector said 'ok' and stopped there. The distinction below — selectable
    // AND alert-bearing — is exactly the contamination class PR #26 had to
    // re-simulate to find, and is what the next PR will measure at scale.
    const result = await extractHistoryObservations(artifact());
    const rows = result.generations[0].individuals;
    const selectable = rows.filter((r) => r.valid && r.integrityStatus === 'ok');
    const alertBearing = rows.filter((r) => r.observations.firstAlertStep !== null);
    expect(selectable).toHaveLength(4);
    // This fixture is clean, and that is an OBSERVATION, not a threshold:
    // the assertion is that the question is answerable, not what the answer is.
    expect(alertBearing).toHaveLength(0);
    const peaks = rows.map((r) => r.observations.peakBodySpeed);
    expect(Math.max(...peaks)).toBeGreaterThan(0); // real measurements, not zeros
  });

  test('genotype digests are opt-in, and identify individuals where ids cannot', async () => {
    // Elitism gives a surviving individual a FRESH id each generation, so a
    // consumer counting distinct genomes needs the digest. Off by default
    // because it costs a serialization per member.
    const without = await extractHistoryObservations(artifact());
    expect(without.generations[0].individuals[0].genotypeDigest).toBeNull();
    const withDigests = await extractHistoryObservations(artifact(), { includeGenotypeDigest: true });
    const digests = withDigests.generations[0].individuals.map((r) => r.genotypeDigest);
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]+$/);
    expect(new Set(digests).size).toBe(4);
  });
});

describe('extractHistoryObservations — it reads only what a digest attests', () => {
  test('a tampered observation byte is REFUSED, not returned as evidence', async () => {
    // THE REASON THIS SEAM VERIFIES. Decoding the framing and pulling the
    // components out would happily hand back an observation the stored
    // component digest no longer covers — evidence nothing vouches for,
    // presented as if it did.
    // The byte is LOCATED, not guessed: a blind offset could land in another
    // component and pass for a different reason than the one claimed.
    const bytes = artifact();
    const framing = decodeHistoryFraming(bytes);
    const payload = decodeGenerationPayload(framing.generations[0].payloadBytes);
    const vector = payload.components.fitnessVector;
    // Member 0's peakBodySpeed: header 22 + member offset 14, low mantissa byte.
    // The guard is on the SEARCH RESULT, not on the sum: a miss returns -1,
    // and -1 + 36 = 35 is a positive offset into the artifact's own header, so
    // the obvious `expect(target).toBeGreaterThan(0)` could never fail for the
    // reason its message states.
    const vectorAt = indexOfSubarray(bytes, vector);
    expect(vectorAt, 'the fitness-vector component must be locatable').toBeGreaterThanOrEqual(0);
    const target = vectorAt + 22 + 14;
    const before = bytes[target];
    bytes[target] ^= 0xff;
    expect(bytes[target]).not.toBe(before);
    const err = await expectCode(() => extractHistoryObservations(bytes), 'componentDigestMismatch');
    expect(err.context.component).toBe('fitnessVector');
  });

  test('a truncated artifact is refused as malformed', async () => {
    await expectCode(() => extractHistoryObservations(artifact().slice(0, 2000)), 'malformedHistory');
  });

  test('a STALE v2 artifact is refused for its FORMAT, sharing resume\'s taxonomy', async () => {
    // Not `malformedHistory` — those bytes are perfectly well-formed under the
    // version they declare. The same code and the same message the production
    // resume path produces, because it is literally the same gate.
    const err = await expectCode(() => extractHistoryObservations(staleArtifact()), 'unsupportedVersion');
    expect(err.message).toMatch(/fitness vector fitnessVectorVersion is 2; this build implements 3/);
  });

  test('an externally-held expected digest detects a stale-but-valid artifact', async () => {
    // A valid OLDER save verifies perfectly — that is the point of the
    // embedded digest and the reason freshness can only come from outside.
    await extractHistoryObservations(artifact(), {
      expectedHistoryDigestBytes: hexToBytes(HISTORY_DIGEST),
    });
    const wrong = hexToBytes(HISTORY_DIGEST.replace(/^ae/, 'af'));
    await expectCode(
      () => extractHistoryObservations(artifact(), { expectedHistoryDigestBytes: wrong }),
      'staleOrWrongArtifact',
    );
  });

  test('the returned record is frozen all the way down', async () => {
    const result = await extractHistoryObservations(artifact());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.generations)).toBe(true);
    expect(Object.isFrozen(result.generations[0])).toBe(true);
    expect(Object.isFrozen(result.generations[0].individuals[0])).toBe(true);
    expect(Object.isFrozen(result.generations[0].individuals[0].observations)).toBe(true);
  });

  test('the caller cannot mutate the artifact while verification is in flight', async () => {
    // Copy-before-await, the resume seam's rule restated at this boundary.
    const bytes = artifact();
    const pending = extractHistoryObservations(bytes);
    bytes.fill(0); // would break every digest if the copy were not already taken
    const result = await pending;
    expect(result.historyDigest).toBe(HISTORY_DIGEST);
  });

  test('the caller cannot mutate its EXPECTED DIGEST while verification is in flight', async () => {
    // The same rule for the other caller-owned input, which is a separate
    // guarantee and was a separate defect: the artifact was copied
    // synchronously while the expected digest was copied AFTER the first
    // await, so a post-call write flipped the verdict in both directions —
    // present the right digest then overwrite it and the file is "stale";
    // present a wrong one then correct it and the file passes.
    const correct = hexToBytes(HISTORY_DIGEST);
    const wrong = hexToBytes(HISTORY_DIGEST.replace(/^ae/, 'af'));

    const good = new Uint8Array(correct);
    const acceptPending = extractHistoryObservations(artifact(), { expectedHistoryDigestBytes: good });
    good.set(wrong); // too late: the identity was captured before any await
    await expect(acceptPending).resolves.toBeDefined();

    const bad = new Uint8Array(wrong);
    const rejectPending = extractHistoryObservations(artifact(), { expectedHistoryDigestBytes: bad });
    bad.set(correct);
    await expectCode(() => rejectPending, 'staleOrWrongArtifact');
  });

  test('a bad OPTION is invalidConfig — "your argument", not "the file"', async () => {
    // The seam shares resume's option intake rather than hand-building one, so
    // these codes and checks are not a second interpretation. Hand-building it
    // silently IGNORED unknown keys (turning `expectedGenerationIndex` off with
    // no error) and reported a short digest as `staleOrWrongArtifact` — sending
    // a caller to look for a different file over their own typo.
    const cases = [
      ['unknown key', { expectedHistoryDigest: hexToBytes(HISTORY_DIGEST) }, /not a known key/],
      ['short digest', { expectedHistoryDigestBytes: hexToBytes(HISTORY_DIGEST).slice(0, 16) }, /exactly 32 bytes/],
      ['non-bytes digest', { expectedHistoryDigestBytes: [1, 2, 3] }, /expectedHistoryDigestBytes/],
      ['non-boolean flag', { includeGenotypeDigest: 'yes' }, /includeGenotypeDigest/],
      ['non-object options', 'nope', /plain object/],
      ['bad generation index', { expectedGenerationIndex: -1 }, /expectedGenerationIndex/],
    ];
    for (const [label, options, pattern] of cases) {
      const err = await expectCode(() => extractHistoryObservations(artifact(), options), 'invalidConfig');
      expect(err.message, label).toMatch(pattern);
    }
  });

  test('expectedGenerationIndex is honoured, not silently dropped', async () => {
    await extractHistoryObservations(artifact(), { expectedGenerationIndex: 0 });
    await expectCode(
      () => extractHistoryObservations(artifact(), { expectedGenerationIndex: 5 }),
      'staleOrWrongArtifact',
    );
  });

  test('a bad argument THROWS rather than rejecting — the prologue is synchronous', () => {
    // Not an `async function`, deliberately: validation and copying happen
    // before the first await, so a caller's mistake surfaces immediately and
    // nothing they hand over can change afterwards.
    expect(() => extractHistoryObservations(artifact(), { nope: 1 })).toThrow(EvolutionError);
    expect(() => extractHistoryObservations(null)).toThrow(EvolutionError);
  });
});

describe('extractHistoryObservations — across generations, on a real run', () => {
  const POPULATION_SEED = 20260740;
  const TERRAIN_SEED = 20260741;
  // Copy-declared from tests/evolution-replay.test.js — same seeds, same shape.
  const config = () => ({
    initialization: { seed: POPULATION_SEED, populationSize: 6 },
    evaluationSpec: {
      terrain: {
        seed: TERRAIN_SEED, startFlatLength: 30, startBlendLength: 6, craterDensity: 0, featureDensity: 0,
      },
      maxSteps: 45,
      deterministic: true,
      spawn: { x: -44, z: 0 },
    },
    evolution: { maxGenerations: 3 },
  });

  async function runToTerminal() {
    const run = createEvolutionRun(config());
    let result;
    do { result = await run.advance(); } while (result.kind !== 'terminal');
    return run.historyBytes();
  }

  test('per-generation rows carry id-keyed lineage, and elites keep their genome', async () => {
    // What the single-generation fixture cannot reach. Every row there is
    // `initialized` with a null parent and ids equal to indices, so an
    // index-keyed join is indistinguishable from an id-keyed one. Here elites
    // get FRESH ids each generation while keeping their genotype, which is
    // exactly the case `includeGenotypeDigest` exists for.
    const bytes = await runToTerminal();
    const before = globalThis.__observationProbe.evaluations;
    const result = await extractHistoryObservations(bytes, { includeGenotypeDigest: true });

    // THE NO-PHYSICS CLAIM, as an assertion rather than a title.
    expect(globalThis.__observationProbe.evaluations - before,
      'reading evidence must not re-simulate anything').toBe(0);

    expect(result.generations.length).toBeGreaterThan(1);
    let elitesSeen = 0;
    for (let g = 0; g < result.generations.length; g += 1) {
      const gen = result.generations[g];
      expect(gen.generationIndex).toBe(g);
      expect(gen.individuals).toHaveLength(6);
      // Ids are unique within a generation, and after generation 0 they are
      // fresh — so an index-keyed join would be reading another row's origin.
      const ids = gen.individuals.map((r) => r.individualId);
      expect(new Set(ids).size).toBe(6);
      if (g > 0) expect(Math.min(...ids)).toBeGreaterThanOrEqual(6);

      const previous = g === 0 ? null : result.generations[g - 1];
      for (const row of gen.individuals) {
        expect(row.genotypeDigest).toMatch(/^[0-9a-f]+$/);
        if (g === 0) {
          expect(row.origin).toBe('initialized');
          expect(row.parentIndividualId).toBeNull();
          continue;
        }
        expect(row.origin).toMatch(/^(eliteCopy|continuousMutation)$/);
        const parent = previous.individuals.find((p) => p.individualId === row.parentIndividualId);
        expect(parent, `generation ${g} parent ${row.parentIndividualId} must exist`).toBeDefined();
        if (row.origin === 'eliteCopy') {
          elitesSeen += 1;
          // An elite is the SAME genome under a new id — the property that
          // makes ids useless for counting distinct individuals.
          expect(row.genotypeDigest).toBe(parent.genotypeDigest);
        }
      }
    }
    expect(elitesSeen, 'the run must actually produce elites, or this proves nothing')
      .toBeGreaterThan(0);
  });

  test('GATE B runs here too: an onset beyond the executed steps is refused', async () => {
    // The seam claims to run BOTH pre-physics gates. Gate A is covered by the
    // stale v2 artifact above; gate B had no tooth here at all — deleting the
    // call left this file green, and the seam then happily returned a
    // firstCatastrophicStep of four billion as evidence.
    const bytes = await runToTerminal();
    const broken = await reforge(bytes, {
      mutateRecord: (record, i) => {
        if (i !== 1) return; // a LATER generation, so the walk is covered too
        const v = new Uint8Array(record.components.fitnessVector);
        const view = new DataView(v.buffer, v.byteOffset, v.byteLength);
        view.setUint8(22 + 38, 1); // firstAlertStep PRESENT
        view.setUint32(22 + 39, 4000000000, true);
        record.components.fitnessVector = v;
      },
    });
    const err = await expectCode(() => extractHistoryObservations(broken), 'malformedHistory');
    expect(err.message).toMatch(/generation 1 individual \d+ declares firstAlertStep 4000000000/);
    expect(err.context.executedSteps).toBe(45);
  });
});
