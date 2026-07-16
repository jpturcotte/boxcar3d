// The spike adjudicator's committed contract (scripts/compare-spike-runs.js —
// classify / invariants / timing / compare). These are PURE JSON-fixture tests:
// no physics, no Rapier, no child processes — the mode functions are imported
// directly (the script uses the bench-physics entrypoint guard, so importing
// never runs the CLI). They exist because the dispatch workflow cannot execute
// before merge: everything a reviewer would desk-check about the adjudication
// logic is enforced HERE, in ordinary CI, against the COMMITTED
// .github/spike-expected-candidate-reds.json inventory (so an inventory edit
// that weakens a gate fails these tests, not a post-merge dispatch).
//
// Fixture titles and failure messages are VERBATIM shapes from the real test
// sources (tests/evaluation-determinism.test.js, tests/browser/*, etc.):
// the staleness custom message, the formatDivergence strings (Node padded
// `actual <hex8>` vs the Chromium champion's UNPADDED `(state <hex>)`), and
// vitest's received-first `.toBe` diff.

import { describe, test, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import {
  classify, invariants, timingGate, compare,
  failingByFile, measuredDigests, semanticDigestKey, parseDriftLines, reproducerSummary,
  borrowErrorScan, prevalenceCoverageIssues, readJsonSafe,
  witnessLogPanicSignature, classifyWitnessMatrix,
} from '../scripts/compare-spike-runs.js';

const EXPECTED = fileURLToPath(new URL('../.github/spike-expected-candidate-reds.json', import.meta.url));

let TMP;
beforeAll(() => { TMP = mkdtempSync(join(tmpdir(), 'spike-adjudicator-')); });
const writeJson = (name, obj) => {
  const p = join(TMP, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

// --- realistic vitest-json builders (titles/messages verbatim from source) ------

const EVAL_FIX = ['eval-a-s0-flat', 'eval-b-mixed-composite', 'eval-c-max-s1', 'eval-d-mixed-radius-flat'];
const passed = (fullName) => ({ fullName, status: 'passed', failureMessages: [] });
const failed = (fullName, message) => ({ fullName, status: 'failed', failureMessages: [message] });

// The candidate's expected Node report: 11 reds with their real failure
// signatures + every must-pass assertion present and passed.
function nodeCandidateReport({ fvMeasured = 'ee605286', champState = '0000dcba' } = {}) {
  return {
    numFailedTests: 11,
    testResults: [
      {
        name: '/w/tests/evaluation-determinism.test.js',
        assertionResults: [
          ...EVAL_FIX.map((fx) => passed(`gate (a): same-process fresh-world byte-identity (deterministic flavor) > ${fx}: two fresh worlds agree on digest, every checkpoint, counts, and metrics`)),
          passed('gate (c): default flavor > same-process repeatability only — the digest is per-process/per-platform and is NEVER locked (F10)'),
          failed('gate (d): golden locks (deterministic flavor) > lock staleness teeth: versions, record size, step counts, engine version',
            "eval-a-s0-flat: engine changed — re-lock deliberately: expected '0.19.3' to be '0.19.3-c13133ad.0' // Object.is equality"),
          // Node reporter TRUNCATES the .toBeNull() string value — the real
          // CI shape is `expected '<fx>: first divergent check…' to be null`,
          // with the state hex dropped. The signature is `to be null` (the
          // truncation-proof assertion structure), so evalActual is not in the
          // message (Node digests are not cross-env extractable).
          ...EVAL_FIX.map((fx) => failed(`gate (d): golden locks (deterministic flavor) > ${fx}: run matches the committed lock (digest, counts, every checkpoint state)`,
            `AssertionError: expected '${fx}: first divergent check…' to be null`)),
          passed('determinism-adjacent teeth (deterministic flavor) > profiler neutrality: profilerEnabled does not change the trace digest'),
          passed('determinism-adjacent teeth (deterministic flavor) > capture-mode invariance: full produces the identical digest and counts as digest mode'),
          passed('determinism-adjacent teeth (deterministic flavor) > the f32-backedness one-shot: every traced physical float of fixture A satisfies Math.fround(v) === v'),
          passed('determinism-adjacent teeth (deterministic flavor) > ghost isolation: vehicle 0 traces bit-equal, solo vs sharing the world with an identical ghost'),
        ],
      },
      {
        name: '/w/tests/evaluation-golden.test.js',
        assertionResults: [
          failed('gate (b): fresh-module reproduction of the golden lock > fixture A reproduces the committed digest and every checkpoint state from a cold module graph',
            "AssertionError: expected 'first divergent checkpoint 1 (state) …' to be null"),
        ],
      },
      {
        name: '/w/tests/population-determinism.test.js',
        assertionResults: [
          failed('population lock staleness teeth > lock set, versions, engine, dt, and internal consistency',
            "engine changed — re-lock deliberately: expected '0.19.3' to be '0.19.3-c13133ad.0' // Object.is equality"),
          passed('population lock staleness teeth > relational fitness identities — never magnitude floors'),
          passed('population initializer locks (pure — no physics) > snapshot and initialization-manifest digests reproduce from a fresh createInitialPopulation'),
          passed('population initializer locks (pure — no physics) > the champion genotype digest reproduces from the fresh population'),
          passed('population initializer locks (pure — no physics) > structural heterogeneity the fixture seed was scanned for (exact sets at this seed)'),
          failed('population evaluation gate (deterministic flavor) > two fresh evaluations agree byte-for-byte, and the second matches the committed lock',
            `expected '${fvMeasured}' to be 'bded0d30' // Object.is equality`),
          failed('population evaluation gate (deterministic flavor) > champion solo digest-mode rerun reproduces the locked trace AND the locked fitness exactly (the isolation sentinel)',
            `AssertionError: expected 'champion trace: first divergent check…' to be null // champState ${champState}`),
        ],
      },
      {
        name: '/w/tests/bench-schema.test.js',
        assertionResults: [
          failed('bench-physics schema > smoke matrix: valid schema, paired comparisons, finite timings, timing never enters trace bytes',
            "expected { compat: 'file:dl/dimforge-rapier3d-compat-0.19.3-c13133ad.0.tgz', …(1) } to deeply equal { compat: '0.19.3', deterministicCompat: '0.19.3' }"),
        ],
      },
      {
        name: '/w/tests/physics-explosion-probe-schema.test.js',
        assertionResults: [
          failed('physics-explosion probe schema > smoke config produces the versioned report shape with all hard checks green',
            "expected '0.19.3-c13133ad.0' to be '0.19.3' // Object.is equality"),
        ],
      },
    ],
  };
}

function browserCandidateReport({ evalActual = '6b83729e', fvMeasured = 'ee605286', champStateUnpadded = 'dcba' } = {}) {
  return {
    numFailedTests: 6,
    testResults: [
      {
        name: '/w/tests/browser/evaluation-determinism.test.js',
        assertionResults: EVAL_FIX.map((fx) => failed(
          `Chromium reproduces the committed deterministic-flavor locks > ${fx}: digest, counts, and every checkpoint state match the golden lock`,
          `${fx} [HeadlessChrome]: first divergent checkpoint 1 (state); last agreed step 0, first differing step 1; expected state 5a219735 actual ${evalActual} — rerun this fixture in Node full-capture mode around that step to identify the body and field`,
        )),
      },
      {
        name: '/w/tests/browser/population-determinism.test.js',
        assertionResults: [
          passed('population golden locks (Chromium) > pure initializer locks: snapshot + initialization digests'),
          failed('population golden locks (Chromium) > evaluation: fitness-vector digest, every fitness literal by individualId, champion',
            `expected '${fvMeasured}' to be 'bded0d30' // Object.is equality`),
          failed('population golden locks (Chromium) > champion solo digest-mode rerun matches the locked trace',
            `expected 'first divergent step 1 (state ${champStateUnpadded}) — capture the full record in Node for forensics' to be null`),
        ],
      },
    ],
  };
}

const reproJson = (dt = 0.01666666753590107) => ({ engine: { rapierVersion: '0.19.3-c13133ad.0', effectiveDt: dt }, reproducer: [] });

// --- classify: assertion-level enforcement ---------------------------------------

describe('classify — assertion-level candidate-red enforcement (node)', () => {
  test('the expected 11-red report passes all four layers', () => {
    const r = classify({ testJsonPath: writeJson('c-ok.json', nodeCandidateReport()), expectedPath: EXPECTED, label: 'node' });
    expect(r.ok).toBe(true);
  });

  test('a gate-(a) failure replacing a golden red at CONSTANT count is caught', () => {
    const rep = nodeCandidateReport();
    const evalFile = rep.testResults[0];
    // Replace the fixture-A golden failure with a gate-(a) two-fresh-worlds
    // failure: same file, still 5 failing — the pre-fix classifier passed this.
    const goldenIdx = evalFile.assertionResults.findIndex((a) => a.status === 'failed' && a.fullName.includes('eval-a-s0-flat: run matches'));
    const gateAIdx = evalFile.assertionResults.findIndex((a) => a.fullName.includes('eval-a-s0-flat: two fresh worlds agree'));
    evalFile.assertionResults[goldenIdx] = passed(evalFile.assertionResults[goldenIdx].fullName);
    evalFile.assertionResults[gateAIdx] = failed(evalFile.assertionResults[gateAIdx].fullName, 'expected 3005 to be 3006 // run-to-run divergence');
    const r = classify({ testJsonPath: writeJson('c-masked.json', rep), expectedPath: EXPECTED, label: 'node' });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/MUST-STAY-GREEN|SIGNATURE/);
  });

  test('the staleness red failing on an EARLIER contract (same title, same count) is caught by the signature', () => {
    const rep = nodeCandidateReport();
    const evalFile = rep.testResults[0];
    const staleIdx = evalFile.assertionResults.findIndex((a) => a.fullName.includes('lock staleness teeth'));
    // Same test title, but the failure moved to the recordBytes contract — the
    // committed 'engine changed — re-lock deliberately' signature must miss it.
    evalFile.assertionResults[staleIdx] = failed(evalFile.assertionResults[staleIdx].fullName,
      'eval-a-s0-flat: expected 128 to be 136 // Object.is equality');
    const r = classify({ testJsonPath: writeJson('c-moved.json', rep), expectedPath: EXPECTED, label: 'node' });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('SIGNATURE MISMATCH');
  });

  test('the population repeatability half failing instead of the golden half is caught', () => {
    const rep = nodeCandidateReport();
    const popFile = rep.testResults[2];
    const idx = popFile.assertionResults.findIndex((a) => a.fullName.includes('two fresh evaluations agree'));
    // Failure moves from the bded0d30 comparison to the a===b repeatability
    // assertion — same title, same file count, different message.
    popFile.assertionResults[idx] = failed(popFile.assertionResults[idx].fullName, 'expected false to be true // Object.is equality');
    const r = classify({ testJsonPath: writeJson('c-repeat.json', rep), expectedPath: EXPECTED, label: 'node' });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('SIGNATURE MISMATCH');
  });

  test('a must-pass assertion MISSING from the report (never ran) fails presence', () => {
    const rep = nodeCandidateReport();
    const evalFile = rep.testResults[0];
    // Drop one passed "two fresh worlds agree" fixture: 3 passed instead of 4.
    const idx = evalFile.assertionResults.findIndex((a) => a.fullName.includes('two fresh worlds agree'));
    evalFile.assertionResults.splice(idx, 1);
    const r = classify({ testJsonPath: writeJson('c-absent.json', rep), expectedPath: EXPECTED, label: 'node' });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('MUST-PASS PRESENCE');
  });

  test('a NON-inventory file that crashes at the SUITE level (0 failing assertions) is caught', () => {
    // An import panic / throwing beforeAll reports status:'failed' with an empty
    // assertionResults — it must not be invisible to the file-set check.
    const rep = nodeCandidateReport();
    rep.testResults.push({ name: '/w/tests/chassis-drop.test.js', status: 'failed', message: 'RuntimeError: unreachable — wasm import panic', assertionResults: [] });
    const r = classify({ testJsonPath: writeJson('c-suitecrash.json', rep), expectedPath: EXPECTED, label: 'node' });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('UNEXPECTED FAILURE');
  });

  test('an expected-red file carrying ALL its reds PLUS a file-level error (afterAll/teardown) is caught', () => {
    // The round-6 fix only handled the ZERO-assertion case; a file with its
    // normal golden failures AND a suite.message must still be rejected.
    const rep = nodeCandidateReport();
    rep.testResults[0].status = 'failed';
    rep.testResults[0].message = 'RuntimeError: unreachable in afterAll';
    const r = classify({ testJsonPath: writeJson('c-filelevel.json', rep), expectedPath: EXPECTED, label: 'node' });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/SIGNATURE MISMATCH|COUNT MISMATCH|file-level/);
  });

  test('DUPLICATE suite entries for the same file are ACCUMULATED, not last-write-wins (a hidden gate-(a) regression surfaces)', () => {
    const rep = nodeCandidateReport();
    // A second evaluation-determinism entry carrying a gate-(a) failure; a
    // last-write-wins failingByFile would discard the FIRST entry's real reds.
    rep.testResults.push({
      name: '/w/tests/evaluation-determinism.test.js',
      status: 'failed',
      assertionResults: [failed('gate (a): same-process fresh-world byte-identity (deterministic flavor) > eval-a-s0-flat: two fresh worlds agree on digest, every checkpoint, counts, and metrics', 'run-to-run divergence')],
    });
    const r = classify({ testJsonPath: writeJson('c-dupsuite.json', rep), expectedPath: EXPECTED, label: 'node' });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/MUST-STAY-GREEN|SIGNATURE COUNT/);
  });

  test('an unexpected failing file and an expected-red that fully passed both fail', () => {
    const extra = nodeCandidateReport();
    extra.testResults.push({ name: '/w/tests/chassis-drop.test.js', assertionResults: [failed('chassis-drop > containment', 'body escaped')] });
    expect(classify({ testJsonPath: writeJson('c-extra.json', extra), expectedPath: EXPECTED, label: 'node' }).ok).toBe(false);

    const flipped = nodeCandidateReport();
    flipped.testResults[1].assertionResults[0] = passed(flipped.testResults[1].assertionResults[0].fullName);
    const r = classify({ testJsonPath: writeJson('c-flip.json', flipped), expectedPath: EXPECTED, label: 'node' });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('EXPECTED RED PASSED');
  });

  test('browser: bootstrap counts accepted, but the pure-initializer test failing OR absent fails', () => {
    expect(classify({ testJsonPath: writeJson('b-ok.json', browserCandidateReport()), expectedPath: EXPECTED, label: 'browser' }).ok).toBe(true);

    const failing = browserCandidateReport();
    failing.testResults[1].assertionResults[0] = failed(failing.testResults[1].assertionResults[0].fullName, 'pure digest moved');
    expect(classify({ testJsonPath: writeJson('b-fail.json', failing), expectedPath: EXPECTED, label: 'browser' }).ok).toBe(false);

    const absent = browserCandidateReport();
    absent.testResults[1].assertionResults.splice(0, 1);
    const r = classify({ testJsonPath: writeJson('b-absent.json', absent), expectedPath: EXPECTED, label: 'browser' });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('MUST-PASS PRESENCE');
  });
});

// --- invariants: the required cross-env set (fitness-vector only) ----------------
//
// Measured on the first heavy dispatch: only the population fitness-vector
// digest is reliably comparable cross-env. Node's `.toBeNull()` on a formatted
// divergence string is TRUNCATED by the reporter (state hex dropped) while
// Chromium keeps the full `expect.fail` message — so the eval A-D + champion
// checkpoint states are NOT message-extractable in Node. Only fitness-vector
// (both reporters emit it via a short `.toBe('<digest>')`) is a semantic key.

describe('invariants — required Node<->Chromium digest set (fitness-vector)', () => {
  const args = (node, browser, repro = reproJson()) => ({
    nodeJson: writeJson(`i-n-${Math.abs(JSON.stringify(node).length)}.json`, node),
    browserJson: writeJson(`i-b-${Math.abs(JSON.stringify(browser).length)}.json`, browser),
    reproducerJson: writeJson(`i-r-${Math.abs(JSON.stringify(repro).length)}.json`, repro),
    expectedPath: EXPECTED,
  });

  test('fitness-vector extracted from BOTH envs with equal value passes', () => {
    const r = invariants(args(nodeCandidateReport(), browserCandidateReport()));
    expect(r.ok).toBe(true);
  });

  test('fitness-vector missing from the Chromium report fails (required key not extracted)', () => {
    const browser = browserCandidateReport();
    browser.testResults[1].assertionResults = browser.testResults[1].assertionResults.filter((a) => !a.fullName.includes('fitness-vector digest'));
    const r = invariants(args(nodeCandidateReport(), browser));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('population:fitness-vector');
  });

  test('a genuine cross-env fitness-vector disagreement fails', () => {
    const r = invariants(args(nodeCandidateReport({ fvMeasured: 'ee605286' }), browserCandidateReport({ fvMeasured: 'ffff0000' })));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('disagree');
  });

  test('the wrong dt readback fails', () => {
    const r = invariants(args(nodeCandidateReport(), browserCandidateReport(), reproJson(1 / 60)));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('dt-readback');
  });

  test('only fitness-vector is a semantic key; eval and champion titles are NOT (reporter asymmetry)', () => {
    // Node "two fresh evaluations agree byte-for-byte" and Chromium
    // "fitness-vector digest" both map to the one comparable key.
    expect(semanticDigestKey('population evaluation gate (deterministic flavor) > two fresh evaluations agree byte-for-byte, and the second matches the committed lock')).toBe('population:fitness-vector');
    expect(semanticDigestKey('population golden locks (Chromium) > evaluation: fitness-vector digest, every fitness literal by individualId, champion')).toBe('population:fitness-vector');
    // The truncation-affected eval + champion titles are deliberately unkeyed.
    expect(semanticDigestKey('gate (d): golden locks (deterministic flavor) > eval-b-mixed-composite: run matches the committed lock (digest, counts, every checkpoint state)')).toBeNull();
    expect(semanticDigestKey('population evaluation gate (deterministic flavor) > champion solo digest-mode rerun reproduces the locked trace')).toBeNull();
    // Extraction pulls the RECEIVED (measured) digest, first on the line, and
    // ignores stack-trace URLs (a `?v=<hex8>` chunk hash must not be a digest).
    const rep = browserCandidateReport({ fvMeasured: 'ee605286' });
    rep.testResults[1].assertionResults[1].failureMessages[0]
      += '\n    at http://localhost:63315/node_modules/@vitest/runner/dist/chunk-hooks.js?v=d9c9c21b:752:20';
    expect(measuredDigests(rep)['population:fitness-vector']).toBe('ee605286');
  });
});

// --- timing: the DRIFT allowlist --------------------------------------------------

describe('timing — probe:timing DRIFT allowlist', () => {
  const log = (lines) => {
    const p = join(TMP, `t-${lines.length}-${lines.join('').length}.log`);
    writeFileSync(p, `${lines.join('\n')}\n`);
    return p;
  };
  const ALLOWED = '  DRIFT re-enable resumes per-step updates — resumed === frozen';
  const ROGUE = '  DRIFT timestep readback is idempotent — drifted';
  const COMMON = ['## deterministic flavor', '  OK    profilerEnabled is a get/set accessor', '  obs   warm-up spike — ratio 0.98', '36 checks, 1 DRIFT'];

  test('the allowlisted drift with exit 1 passes; a rogue drift fails; exit/DRIFT inconsistency fails', () => {
    expect(timingGate({ logPath: log([...COMMON, ALLOWED]), exitCode: '1', expectedPath: EXPECTED }).ok).toBe(true);
    expect(timingGate({ logPath: log([...COMMON, ALLOWED, ROGUE]), exitCode: '1', expectedPath: EXPECTED }).ok).toBe(false);
    expect(timingGate({ logPath: log([...COMMON, ALLOWED]), exitCode: '0', expectedPath: EXPECTED }).ok).toBe(false);
    expect(timingGate({ logPath: log(COMMON), exitCode: '1', expectedPath: EXPECTED }).ok).toBe(false);
    expect(timingGate({ logPath: log(COMMON), exitCode: 'missing', expectedPath: EXPECTED }).ok).toBe(false);
  });

  test('a fully green probe (flip-watch) is not fatal, and parseDriftLines strips detail after the em-dash', () => {
    expect(timingGate({ logPath: log(COMMON), exitCode: '0', expectedPath: EXPECTED }).ok).toBe(true);
    expect(parseDriftLines(`${ALLOWED}\n`)).toEqual(['re-enable resumes per-step updates']);
  });
});

// --- compare: verdict integrity ----------------------------------------------------

describe('compare — verdict established only from usable arms', () => {
  // Small declared coverage the fixtures satisfy (real inventory = 3 masters +
  // fresh, 20 each; the shape is what matters here, not the numbers).
  const TEST_HEAVY = { prevalenceSeeds: [700, 701], freshSeeds: [730], individualsPerSeed: 3 };
  const mkPrev = (seeds, perSeed = TEST_HEAVY.individualsPerSeed) => ({
    engine: {},
    prevalence: seeds.map((seed) => ({
      populationSeed: seed,
      catastrophicCount: 1,
      individuals: Array.from({ length: perSeed }, (_, id) => ({ individualId: id, firstCatastrophicStep: id === 0 ? 5 : null })),
    })),
  });
  function buildArtifacts(opts = {}) {
    const {
      candidatePassed = true, candidateReproPresent = true, heavy = false,
      prevalencePresent = true, perfOk = true, prevalenceMalformed = false,
      perfErrored = false,
      prevalenceSeeds = TEST_HEAVY.prevalenceSeeds, freshseedMissing = false,
      bootstrapComplete = true,
      stableCat = 46, candidateCat = 107, // null => quiescent classification
      // Stable heavy run must PROVE a clean forensic matrix: default a valid
      // witnesses.json with empty freeErrors. null => omit (missing); a string
      // => raw/malformed; an object => that JSON (e.g. non-array freeErrors).
      stableWitnesses = { freeErrors: [] },
    } = opts;
    const root = mkdtempSync(join(tmpdir(), 'spike-compare-'));
    const mk = (p) => mkdirSync(join(root, p), { recursive: true });
    const wj = (p, o) => writeFileSync(join(root, p), JSON.stringify(o, null, 2));
    mk('provenance'); mk('results-stable'); mk('results-candidate'); mk('perf'); mk('out');
    wj('expected.json', { bootstrapComplete, heavyEvidence: TEST_HEAVY });
    wj('provenance/candidate-provenance.json', { requestedUpstreamRef: 'c13133ad', resolvedUpstreamSha: 'c13133ad293', wasmPack: 'wasm-pack 0.13.1', tarballs: {} });
    const repro = (ver, cat) => ({
      engine: { rapierVersion: ver, effectiveDt: 0.01666666753590107 },
      reproducer: [
        { arm: 'original', flavor: 'deterministic', result: { peakBodySpeed: 4785, maxForwardDistance: 3, onset: { firstCatastrophicStep: cat } } },
        { arm: 'multibody', flavor: 'deterministic', result: { peakBodySpeed: 1.4, maxForwardDistance: 0.1, onset: { firstCatastrophicStep: null } } },
      ],
    });
    for (const [arm, ver, cat] of [['stable', '0.19.3', stableCat], ['candidate', '0.19.3-c13133ad.0', candidateCat]]) {
      if (!(arm === 'candidate' && !candidateReproPresent)) wj(`results-${arm}/reproducer.json`, repro(ver, cat));
      if (!freshseedMissing) wj(`results-${arm}/freshseed.json`, mkPrev(TEST_HEAVY.freshSeeds));
      // The realistic heavy default: stable witnesses exit 0 (completes), candidate exit 1 (crashes).
      const exits = heavy ? { witnesses: arm === 'stable' ? 0 : 1 } : {};
      wj(`results-${arm}/arm-manifest.json`, { arm, resolvedSha: 'abc', heavy, exits });
      wj(`results-${arm}/adjudication.json`, { schema: 'boxcar3d.adjudication/1', arm, passed: arm === 'candidate' ? candidatePassed : true, heavy });
      if (heavy && (arm === 'stable' || prevalencePresent)) {
        // Malformed = no prevalence array at all (hits the array guard); an
        // empty array is instead caught by the seed-coverage check.
        wj(`results-${arm}/prevalence.json`, prevalenceMalformed ? { engine: {} } : mkPrev(prevalenceSeeds));
      }
    }
    // Stable heavy run's witnesses.json (fail-closed: present + valid + empty
    // freeErrors). The candidate's is intentionally absent (OBSERVE), but it DID
    // crash — write its witnesses.log with the recognized unreachable signature.
    if (heavy && stableWitnesses !== null) {
      writeFileSync(join(root, 'results-stable/witnesses.json'), typeof stableWitnesses === 'string' ? stableWitnesses : JSON.stringify(stableWitnesses));
    }
    if (heavy) writeFileSync(join(root, 'results-candidate/witnesses.log'), 'RuntimeError: unreachable\n    at wasm://wasm/0:1\n');
    // Realistic bench-physics report shape: status lives PER COMPARISON
    // (report.comparisons[].status), never top-level.
    const benchJson = (comparisons) => ({ schema: 'boxcar3d.bench-physics/2', meta: {}, comparisons, derived: {} });
    const run = (arm, i, ok) => ({ arm, i, exit: ok ? 0 : 1, json: ok ? benchJson([{ status: 'ok' }]) : null });
    const runs = [run('stable', 1, perfOk), run('candidate', 1, perfOk), run('candidate', 2, true), run('stable', 2, true)];
    // A caught bench comparison error still exits 0 and writes JSON carrying an
    // {status:'error'} entry — while the summary may still claim ok (the former
    // dead top-level-status read). compare must catch it per-comparison.
    if (perfErrored) runs[1].json = benchJson([{ status: 'ok' }, { status: 'error', error: 'borrow guard' }]);
    const parsed = runs.filter((r) => r.json !== null).length;
    wj('perf/perf.json', { schema: 'boxcar3d.spike-perf/1', summary: { status: parsed === 4 ? 'ok' : 'incomplete', allParsed: parsed === 4, parsed, total: 4 }, runs });
    return root;
  }
  const runCompare = (root) => compare({ artifacts: root, out: join(root, 'out'), expectedPath: join(root, 'expected.json') });
  const md = (root) => readFileSync(join(root, 'out', 'comparison.md'), 'utf8');

  test('both arms usable -> established; heavy=false is PROVISIONAL; heavy=true + bootstrapComplete is citable', () => {
    let root = buildArtifacts({ heavy: false });
    let r = runCompare(root);
    expect(r.ok).toBe(true);
    expect(r.manifest.verdict.established).toBe(true);
    expect(r.manifest.verdict.citable).toBe(false);
    expect(md(root)).toContain('PROVISIONAL');

    root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    r = runCompare(root);
    expect(r.manifest.verdict.citable).toBe(true);
    expect(md(root)).not.toContain('PROVISIONAL');
  });

  // P1b (round-7): the two-stage citability gate. The FIRST heavy run is the
  // BOOTSTRAP run — structurally non-citable even when Outcome B reproduces,
  // because the browser inventory is not finalized yet.
  test('bootstrapComplete=false forces citable=false even on a catastrophic-on-both heavy run', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: false });
    const r = runCompare(root);
    expect(r.ok).toBe(true); // Outcome B DID reproduce (the experiment succeeded)
    expect(r.manifest.verdict.outcomeBReproduced).toBe(true);
    expect(r.manifest.verdict.bootstrapComplete).toBe(false);
    expect(r.manifest.verdict.citable).toBe(false);
    expect(md(root)).toContain('BOOTSTRAP run');
  });

  test('a FAILED candidate adjudication or a MISSING reproducer classification is INCONCLUSIVE, never "Outcome B"', () => {
    let root = buildArtifacts({ candidatePassed: false });
    let r = runCompare(root);
    expect(r.ok).toBe(false);
    expect(r.manifest.verdict.established).toBe(false);
    expect(md(root)).toContain('INCONCLUSIVE');
    expect(md(root)).not.toContain('Outcome B reproduced');

    root = buildArtifacts({ candidateReproPresent: false });
    r = runCompare(root);
    expect(r.ok).toBe(false);
    expect(r.manifest.verdict.reproducerImpulse.sameClass).toBeNull();
    expect(md(root)).not.toContain('SAME class');
  });

  test('incomplete perf reports honestly (but does not sink the verdict)', () => {
    const root = buildArtifacts({ perfOk: false });
    const r = runCompare(root);
    expect(r.ok).toBe(true); // perf is not decision-relevant to the verdict
    expect(md(root)).toContain('perf INCOMPLETE/ERRORED');
    expect(r.manifest.findings.perf.status).not.toBe('ok');
  });

  // Round-8 (bash self-review): a bench comparison that ERRORED (bench-physics
  // catches the throw, pushes {status:'error'}, and STILL exits 0) must be
  // reported incomplete — even though all four JSON parsed and the workflow's
  // summary still claims status:'ok'. The former guard read a top-level
  // r.json.status that bench-physics never writes (status is per-comparison),
  // so it was dead and laundered an errored bench as clean.
  test('a perf run with an ERRORED comparison is reported incomplete even when the summary claims ok', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true, perfErrored: true });
    const r = runCompare(root);
    expect(r.manifest.findings.perf.status).not.toBe('ok');
    expect(r.manifest.findings.perf.status).toMatch(/errored/);
    expect(md(root)).toContain('perf INCOMPLETE/ERRORED');
    // Still not decision-relevant — the Outcome-B verdict is unaffected.
    expect(r.ok).toBe(true);
    expect(r.manifest.verdict.citable).toBe(true);
  });

  // P2 (round-7): heavy evidence must cover the EXACT declared seed set +
  // per-seed cardinality on both arms, not merely be a non-empty array.
  test('a heavy run missing a declared prevalence seed is unusable', () => {
    const root = buildArtifacts({ heavy: true, prevalenceSeeds: [700] }); // 701 missing
    expect(runCompare(root).ok).toBe(false);
    expect(md(root)).toContain('declared seed 701 MISSING');
  });

  test('a heavy run with an empty/malformed prevalence array is unusable', () => {
    const root = buildArtifacts({ heavy: true, prevalenceMalformed: true });
    expect(runCompare(root).ok).toBe(false);
    expect(md(root)).toContain('missing or malformed');
  });

  test('a heavy run missing the fresh-seed report is unusable', () => {
    const root = buildArtifacts({ heavy: true, freshseedMissing: true });
    expect(runCompare(root).ok).toBe(false);
    expect(md(root)).toContain('freshseed.json');
  });

  test('a heavy run missing the candidate prevalence file is unusable', () => {
    const root = buildArtifacts({ heavy: true, prevalencePresent: false });
    expect(runCompare(root).ok).toBe(false);
    expect(md(root)).toContain('prevalence.json');
  });

  // P1a (round-6): a DIFFERENT scientific outcome must NOT produce a green,
  // citable run — "experiment executed" is not "Outcome B reproduced".
  test('candidate QUIESCENT (divergence fixed) on a heavy run is CONTRADICTS + nonzero + not citable', () => {
    const root = buildArtifacts({ heavy: true, candidateCat: null });
    const r = runCompare(root);
    expect(r.ok).toBe(false);
    expect(r.manifest.verdict.established).toBe(true); // the experiment DID execute
    expect(r.manifest.verdict.outcomeBReproduced).toBe(false);
    expect(r.manifest.verdict.citable).toBe(false);
    expect(md(root)).toContain('CONTRADICTS Outcome B');
    expect(md(root)).not.toContain('Outcome B reproduced');
  });

  test('a QUIESCENT stable control (candidate still catastrophic) is CONTRADICTS DIFFERENT + nonzero', () => {
    const root = buildArtifacts({ heavy: true, stableCat: null });
    const r = runCompare(root);
    expect(r.ok).toBe(false);
    expect(r.manifest.verdict.outcomeBReproduced).toBe(false);
    expect(md(root)).toContain('DIFFERENT');
  });

  test('BOTH arms quiescent (harness broken — stable 0.19.3 is known catastrophic) is CONTRADICTS + nonzero', () => {
    const root = buildArtifacts({ heavy: true, stableCat: null, candidateCat: null });
    const r = runCompare(root);
    expect(r.ok).toBe(false);
    expect(r.manifest.verdict.outcomeBReproduced).toBe(false);
    expect(md(root)).toContain('harness/reproducer is broken');
  });

  test('catastrophic-on-both heavy run with bootstrapComplete is the ONLY citable state', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    const r = runCompare(root);
    expect(r.ok).toBe(true);
    expect(r.manifest.verdict.outcomeBReproduced).toBe(true);
    expect(r.manifest.verdict.citable).toBe(true);
  });

  // F3 — a truncated/interrupted artifact must NOT crash compare(): it becomes
  // an explicit arm issue (arm unusable), and comparison.md + result-manifest.json
  // are STILL written (the stated "failed/incomplete arms are reported and
  // preserved" behavior).
  test('a MALFORMED candidate artifact does not crash compare — arm issue + artifacts still written', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    writeFileSync(join(root, 'results-candidate/adjudication.json'), '{ "passed": tr'); // truncated
    let r;
    expect(() => { r = runCompare(root); }).not.toThrow();
    expect(existsSync(join(root, 'out', 'comparison.md'))).toBe(true);
    expect(existsSync(join(root, 'out', 'result-manifest.json'))).toBe(true);
    expect(r.manifest.arms.candidate.issues.some((i) => /MALFORMED JSON/.test(i))).toBe(true);
    expect(r.manifest.arms.candidate.usable).toBe(false);
    expect(r.manifest.verdict.citable).toBe(false);
  });

  // F6 — the forensic witness matrix is classified honestly by exit + signature;
  // only a recognized ownership/unreachable signature is "Outcome-B evidence".
  const setWitness = (root, arm, { exit, log, freeErrors }) => {
    writeFileSync(join(root, `results-${arm}/arm-manifest.json`), JSON.stringify({ arm, resolvedSha: 'abc', heavy: true, exits: { witnesses: exit } }));
    if (log !== undefined) writeFileSync(join(root, `results-${arm}/witnesses.log`), log);
    if (freeErrors !== undefined) writeFileSync(join(root, `results-${arm}/witnesses.json`), JSON.stringify({ freeErrors }));
  };

  test('witness matrix: recognized unreachable signature = engine CRASH (Outcome-B evidence); clean stable = completed', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    setWitness(root, 'candidate', { exit: 1, log: 'RuntimeError: unreachable\n    at wasm://wasm/0:1\n' });
    setWitness(root, 'stable', { exit: 0, freeErrors: [] });
    runCompare(root);
    const text = md(root);
    expect(text).toMatch(/candidate:.*engine CRASH.*RuntimeError: unreachable.*Outcome-B evidence/);
    expect(text).toMatch(/stable:.*completed the full forensic matrix cleanly/);
  });

  test('witness matrix: a bare non-zero (no signature) is UNEXPLAINED, a 124 is TIMEOUT — NOT crash evidence', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    setWitness(root, 'candidate', { exit: 7, log: 'some unrelated failure\n' });
    setWitness(root, 'stable', { exit: 124, log: '' });
    runCompare(root);
    const text = md(root);
    expect(text).toMatch(/candidate:.*UNEXPLAINED FAILURE.*NOT Outcome-B evidence/);
    expect(text).not.toMatch(/candidate:.*THIS is the Outcome-B evidence/); // never the crash-evidence label
    expect(text).toMatch(/stable:.*TIMED OUT.*NOT observed-engine-crash evidence/);
  });

  test('witness matrix: a COMPLETED reference arm that recorded freeErrors is NOT clean', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    setWitness(root, 'stable', { exit: 0, freeErrors: ['attempted to take ownership of Rust value while it was borrowed'] });
    setWitness(root, 'candidate', { exit: 1, log: 'RuntimeError: unreachable\n' });
    runCompare(root);
    const text = md(root);
    expect(text).toMatch(/stable:.*recorded 1 world\.free\(\) borrow-guard observation.*FAILURE, not clean/);
  });

  // P1 (re-review) — FAIL-CLOSED: a stable heavy run whose witnesses.json is
  // absent / truncated / schema-invalid must FAIL the stable arm (unusable =>
  // NOT citable), never pass as "completed cleanly" on exit-0 alone.
  test('stable heavy: a MISSING witnesses.json fails the arm (unusable, not citable)', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true, stableWitnesses: null });
    setWitness(root, 'stable', { exit: 0 }); // exit 0 but no JSON (a --json regression)
    const r = runCompare(root);
    expect(r.manifest.arms.stable.issues.some((i) => /witnesses\.json MISSING/.test(i))).toBe(true);
    expect(r.manifest.arms.stable.usable).toBe(false);
    expect(r.manifest.verdict.citable).toBe(false);
    expect(md(root)).toMatch(/stable:.*exit 0 but witnesses\.json is ABSENT.*NOT provably clean/);
  });

  test('stable heavy: a TRUNCATED witnesses.json fails the arm', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true, stableWitnesses: '{ "freeErrors": [' });
    const r = runCompare(root);
    expect(r.manifest.arms.stable.issues.some((i) => /witnesses\.json MALFORMED/.test(i))).toBe(true);
    expect(r.manifest.arms.stable.usable).toBe(false);
    expect(r.manifest.verdict.citable).toBe(false);
  });

  test('stable heavy: a MISSING or NON-ARRAY freeErrors fails the arm (schema-invalid)', () => {
    const noKey = buildArtifacts({ heavy: true, bootstrapComplete: true, stableWitnesses: { notFreeErrors: 1 } });
    expect(runCompare(noKey).manifest.arms.stable.issues.some((i) => /no freeErrors ARRAY/.test(i))).toBe(true);
    const nonArr = buildArtifacts({ heavy: true, bootstrapComplete: true, stableWitnesses: { freeErrors: 'nope' } });
    const r = runCompare(nonArr);
    expect(r.manifest.arms.stable.issues.some((i) => /no freeErrors ARRAY/.test(i))).toBe(true);
    expect(r.manifest.verdict.citable).toBe(false);
  });

  test('a recognized panic signature on the STABLE arm is a FAILURE even at exit 0 (never clean)', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    setWitness(root, 'stable', { exit: 0, log: 'RuntimeError: unreachable\n', freeErrors: [] });
    runCompare(root);
    expect(md(root)).toMatch(/stable:.*engine CRASH on the REFERENCE arm.*FAILURE, not evidence/);
  });

  // P1 (re-review 2) — witness cleanliness is a real USABILITY condition, not
  // just a rendered classification. Each of these must make r.ok=false,
  // stable.usable=false, citable=false — NOT merely print the wording.
  const expectStableGated = (root) => {
    const r = runCompare(root);
    expect(r.ok).toBe(false);
    expect(r.manifest.arms.stable.usable).toBe(false);
    expect(r.manifest.verdict.citable).toBe(false);
    return r;
  };

  test('stable witness TIMEOUT (exit 124) fails the arm, not citable', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    setWitness(root, 'stable', { exit: 124, freeErrors: [] });
    const r = expectStableGated(root);
    expect(r.manifest.arms.stable.issues.some((i) => /witnesses exit 124/.test(i))).toBe(true);
  });

  test('stable witness UNEXPLAINED nonzero exit (7) fails the arm, not citable', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    setWitness(root, 'stable', { exit: 7, freeErrors: [] });
    expectStableGated(root);
  });

  test('a MISSING stable witness exit fails the arm, not citable', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    // arm-manifest with no exits.witnesses => wexit null => classification missing.
    writeFileSync(join(root, 'results-stable/arm-manifest.json'), JSON.stringify({ arm: 'stable', resolvedSha: 'abc', heavy: true, exits: {} }));
    const r = expectStableGated(root);
    expect(r.manifest.arms.stable.issues.some((i) => /witnesses exit missing/.test(i))).toBe(true);
  });

  test('a stable panic signature at exit 0 fails the arm, not citable (the disconnect the classification alone missed)', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    setWitness(root, 'stable', { exit: 0, log: 'RuntimeError: unreachable\n', freeErrors: [] });
    const r = expectStableGated(root);
    expect(r.manifest.arms.stable.issues.some((i) => /recognized panic signature in witnesses\.log/.test(i))).toBe(true);
  });

  // Round-8 (self-review): the reference arm must free cleanly in EVERY pass, not
  // just the witness matrix. safeFreeWorld swallows a wasm-bindgen ownership guard
  // into report.freeErrors and the probe STILL exits 0, so a reproducer/freshseed/
  // prevalence borrow-guard on stable is invisible to the exit-code gate — it must
  // still make the arm unusable and the run not citable (the same fail-closed
  // principle as the witnesses gate). The borrow signal is otherwise only RENDERED
  // in the scan section next to citable:true — the classify-but-don't-gate class.
  const setReportFreeErrors = (root, arm, name, freeErrors) => {
    const p = join(root, `results-${arm}/${name}.json`);
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    obj.freeErrors = freeErrors;
    writeFileSync(p, JSON.stringify(obj));
  };
  const BORROW = 'attempted to take ownership of Rust value while it was borrowed';

  for (const name of ['reproducer', 'freshseed', 'prevalence']) {
    test(`stable ${name}.json with a non-empty freeErrors fails the arm, not citable`, () => {
      const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
      setReportFreeErrors(root, 'stable', name, [BORROW]);
      const r = expectStableGated(root);
      expect(r.manifest.arms.stable.issues.some((i) => new RegExp(`stable ${name}\\.json recorded 1 world\\.free\\(\\)`).test(i))).toBe(true);
    });
  }

  test('a recognized panic signature in a stable PROBE stdout log (reproducer.log) fails the arm, not citable', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    writeFileSync(join(root, 'results-stable/reproducer.log'),
      `## world.free() borrow-guard panics (observations)\n\n1 recorded:\n- \`${BORROW}\` x1\n`);
    const r = expectStableGated(root);
    expect(r.manifest.arms.stable.issues.some((i) => /recognized borrow\/panic signature in a reference-arm probe log/.test(i))).toBe(true);
  });

  // The asymmetry is deliberate and must hold: the CANDIDATE is OBSERVE — a
  // freeError or a probe-log panic on the candidate is Outcome-B evidence, NOT a
  // usability failure. Over-gating the candidate here would suppress the very
  // signal the experiment is built to record, so this pins candidate exemption.
  test('a CANDIDATE freeError + probe-log panic is OBSERVE — candidate stays usable, run stays citable', () => {
    const root = buildArtifacts({ heavy: true, bootstrapComplete: true });
    setReportFreeErrors(root, 'candidate', 'reproducer', [BORROW]);
    writeFileSync(join(root, 'results-candidate/reproducer.log'), `- \`${BORROW}\` x1\n`);
    const r = runCompare(root);
    expect(r.ok).toBe(true);
    expect(r.manifest.arms.candidate.usable).toBe(true);
    expect(r.manifest.verdict.citable).toBe(true);
  });
});

// P1b (round-6): reproducerSummary must treat ABSENCE as missing (=> arm
// unusable), never silently classify a malformed report as quiescent. Only an
// onset object OWNING firstCatastrophicStep===null is a valid quiescent result.
describe('reproducerSummary — malformed reports are missing, not quiescent', () => {
  const row = (result) => ({ reproducer: [{ arm: 'original', flavor: 'deterministic', result }] });
  const cls = (result) => reproducerSummary(row(result))?.original?.classification ?? 'MISSING';

  test('explicit null firstCatastrophicStep is the ONLY valid quiescent', () => {
    expect(cls({ onset: { firstCatastrophicStep: null } })).toBe('quiescent');
  });
  test('a valid non-negative integer is catastrophic', () => {
    expect(cls({ onset: { firstCatastrophicStep: 107 } })).toBe('catastrophic');
    expect(cls({ onset: { firstCatastrophicStep: 0 } })).toBe('catastrophic');
  });
  test('missing onset / missing firstCatastrophicStep are MISSING (not quiescent)', () => {
    expect(cls({})).toBe('MISSING');
    expect(cls({ onset: {} })).toBe('MISSING');
    expect(cls({ onset: undefined })).toBe('MISSING');
    expect(cls({ onset: null })).toBe('MISSING');
  });
  test('non-integer / negative / non-finite firstCatastrophicStep are MISSING', () => {
    expect(cls({ onset: { firstCatastrophicStep: -1 } })).toBe('MISSING');
    expect(cls({ onset: { firstCatastrophicStep: 1.5 } })).toBe('MISSING');
    expect(cls({ onset: { firstCatastrophicStep: 'NaN' } })).toBe('MISSING');
    expect(cls({ onset: { firstCatastrophicStep: Number.NaN } })).toBe('MISSING');
  });
  test('a null/absent result row is MISSING', () => {
    expect(cls(null)).toBe('MISSING');
    expect(cls(undefined)).toBe('MISSING');
  });

  // Sibling holes surfaced by the round-6 adversarial sweep.
  const clsRaw = (reproducer) => reproducerSummary({ reproducer })?.original?.classification ?? 'MISSING';
  test('an unsupported:true row is MISSING, not a live classification', () => {
    expect(clsRaw([{ arm: 'original', flavor: 'deterministic', unsupported: true, result: { onset: { firstCatastrophicStep: 46 } } }])).toBe('MISSING');
  });
  test('DUPLICATE deterministic rows are MISSING (a fabricated catastrophic must not first-win over a real quiescent)', () => {
    expect(clsRaw([
      { arm: 'original', flavor: 'deterministic', result: { onset: { firstCatastrophicStep: 46 } } },
      { arm: 'original', flavor: 'deterministic', result: { onset: { firstCatastrophicStep: null } } },
    ])).toBe('MISSING');
  });
  test('NO deterministic row (only ordinary flavor) is MISSING — no cross-flavor fallback under a "deterministic" verdict', () => {
    expect(clsRaw([{ arm: 'original', flavor: 'ordinary', result: { onset: { firstCatastrophicStep: 46 } } }])).toBe('MISSING');
  });
});

// --- helpers + inventory self-consistency -------------------------------------------

describe('helpers and the committed inventory', () => {
  test('failingByFile carries per-assertion messages for signature matching', () => {
    const fbf = failingByFile(nodeCandidateReport());
    expect(fbf['tests/population-determinism.test.js'].failed).toBe(3);
    expect(fbf['tests/population-determinism.test.js'].failedAssertions
      .some((a) => /engine changed — re-lock deliberately/.test(a.message))).toBe(true);
  });

  const sumSignatures = (spec, file) => {
    expect(Array.isArray(spec.allowedFailureSignatures), `${file}: reds must carry assertion-level signatures`).toBe(true);
    const sum = spec.allowedFailureSignatures.reduce((n, s) => n + s.count, 0);
    expect(sum, `${file}: signature counts must sum to expectedFailures`).toBe(spec.expectedFailures);
    for (const s of spec.allowedFailureSignatures) expect(() => new RegExp(s.messageRegex)).not.toThrow();
    return spec.expectedFailures;
  };

  test('inventory self-consistency: signature counts sum to expectedFailures per Node file, and totals agree', () => {
    const inv = JSON.parse(readFileSync(EXPECTED, 'utf8'));
    let total = 0;
    for (const [file, spec] of Object.entries(inv.node.byFile)) total += sumSignatures(spec, file);
    expect(total).toBe(inv.node.totalExpectedFailures);
    expect(inv.nodeChromiumRequiredKeys).toEqual(['population:fitness-vector']);
    expect(inv.timing.allowedDriftChecks).toEqual(['re-enable resumes per-step updates']);
    expect(inv.heavyEvidence.prevalenceSeeds).toEqual([20260725, 20260728, 20260729]);
    expect(inv.heavyEvidence.freshSeeds).toEqual([20260730]);
    expect(inv.heavyEvidence.individualsPerSeed).toBe(20);
  });

  test('browser inventory self-consistency: signatures sum to expectedFailures per file, totals agree', () => {
    const inv = JSON.parse(readFileSync(EXPECTED, 'utf8'));
    let total = 0;
    for (const [file, spec] of Object.entries(inv.browser.byFile)) total += sumSignatures(spec, file);
    expect(total).toBe(inv.browser.totalExpectedFailures);
  });

  test('bootstrapComplete is TRUE and its structural precondition holds: every browser file has an integer count + signatures', () => {
    // Stage 2 of the two-stage citability gate: the flag may be true ONLY when
    // the browser inventory is finalized. Guard it so a future flip cannot
    // out-run the browser section (which would let citable=true certify an
    // unenforced browser arm).
    const inv = JSON.parse(readFileSync(EXPECTED, 'utf8'));
    expect(inv.bootstrapComplete).toBe(true);
    expect(inv.titlesPendingFirstHeavyRun).toBe(false);
    for (const [file, spec] of Object.entries(inv.browser.byFile)) {
      expect(Number.isInteger(spec.expectedFailures), `${file}: bootstrapComplete requires an integer count`).toBe(true);
      expect(Array.isArray(spec.allowedFailureSignatures), `${file}: bootstrapComplete requires signatures`).toBe(true);
    }
  });
});

// The borrow/panic scan reads the RAW test-suite logs (npmtest.log/browser.log),
// which interleave vitest's captured console output with its reporter tree. THIS
// suite is the one pure-JSON unit test whose captured output deliberately quotes
// engine-panic strings ("RuntimeError: unreachable", "panicked at") as classify()
// fixtures — verified pure: scripts/compare-spike-runs.js imports only node:*
// builtins, and this file imports only its adjudicator functions, so no Rapier
// instance and no subprocess can run under a compare-spike-runs.test.js header.
// The scan must therefore ATTRIBUTE by the capturing test (skip this suite's
// blocks) rather than content-match, or the stable arm — which is 0-failing —
// falsely reads a "project-contract regression". Both directions are locked here.
describe('borrowErrorScan — reports engine faults, ignores the adjudicator suite own captured fixtures', () => {
  const scanOf = (name, content) => {
    const dir = mkdtempSync(join(tmpdir(), 'spike-borrowscan-'));
    writeFileSync(join(dir, name), content);
    return borrowErrorScan(dir);
  };

  test('the self-contract test captured "RuntimeError: unreachable" fixture is NOT reported (the exact stable-arm false positive)', () => {
    // classify() prints its SIGNATURE MISMATCH diagnostic (which quotes the
    // fixture "RuntimeError: unreachable in afterAll") under a captured-stderr
    // header vitest colours with ANSI even when piped — proves the ANSI strip.
    const ansiHeader = '\x1b[90mstderr\x1b[2m | \x1b[22m\x1b[2mtests/compare-spike-runs.test.js\x1b[2m > \x1b[22mclassify > file-level error is caught';
    const log = [
      ansiHeader,
      '',
      'CLASSIFY FAIL (node) — the candidate failed-test set does not match the inventory:',
      '  SIGNATURE MISMATCH — tests/evaluation-determinism.test.js: failing assertion "<file-level error>" matches NO allowed failure signature. Message head: RuntimeError: unreachable in afterAll',
      '',
    ].join('\n');
    const r = scanOf('npmtest.log', log);
    expect(r.scanned).toBe(1);
    expect(r.matches).toEqual([]);
  });

  test('a genuine engine panic captured under a DIFFERENT test header IS reported', () => {
    const log = [
      'stderr | tests/evaluation-determinism.test.js > gate (a): fresh-world byte-identity',
      'RuntimeError: unreachable',
      '    at wasm://wasm/0123abcd:1:1234',
      '',
    ].join('\n');
    const r = scanOf('npmtest.log', log);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]).toMatch(/RuntimeError: unreachable/);
  });

  test('a panic in the vitest failed-tests summary IS reported even after a self-test block (owner reset at the ⎯ banner)', () => {
    const log = [
      'stdout | tests/compare-spike-runs.test.js > classify > prints its report',
      '# candidate-red classification (node)',
      '⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯',
      ' FAIL  tests/evaluation-determinism.test.js > teardown',
      'RuntimeError: unreachable in afterAll',
      '',
    ].join('\n');
    const r = scanOf('npmtest.log', log);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]).toMatch(/unreachable in afterAll/);
  });

  test('attribution not content: the IDENTICAL sentence is hidden under a self-test header, surfaced under a real one', () => {
    const sentence = 'SIGNATURE MISMATCH — foo: Message head: RuntimeError: unreachable in afterAll';
    const hidden = scanOf('npmtest.log', ['stderr | tests/compare-spike-runs.test.js > x', sentence, ''].join('\n'));
    const shown = scanOf('npmtest.log', ['stderr | tests/evaluation-determinism.test.js > x', sentence, ''].join('\n'));
    expect(hidden.matches).toEqual([]);
    expect(shown.matches.length).toBe(1);
  });

  test('a non-vitest log (no capture headers) still reports a raw Rust panic — owner stays null', () => {
    const r = scanOf('build.log', "thread 'main' panicked at 'assertion failed', src/lib.rs:42\n");
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]).toMatch(/panicked at/);
  });

  test('benign build-log strings (panic = "abort", "no borrow errors") are not matched', () => {
    const r = scanOf('build.log', 'panic = "abort"\nno borrow errors detected\n');
    expect(r.matches).toEqual([]);
  });

  test('the wasm-bindgen borrow-GUARD message is matched (core-0.34 world.free() panic)', () => {
    // The candidate's first crash class — distinct wording from "already
    // borrowed"/"BorrowMutError", so the signature must name it explicitly.
    const r = scanOf('witnesses.log', 'Error: attempted to take ownership of Rust value while it was borrowed\n');
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]).toMatch(/attempted to take ownership/);
  });

  test('the unrecoverable "RuntimeError: unreachable" wasm trap is matched (candidate step() crash)', () => {
    const r = scanOf('witnesses.log', 'RuntimeError: unreachable\n    at wasm://wasm/0067f38e:1:1\n');
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]).toMatch(/RuntimeError: unreachable/);
  });

  test('a multi-KB minified source-dump line is skipped, not reported (no report bloat on an uncaught crash)', () => {
    // Node prints the offending rapier.mjs SOURCE on an uncaught wasm crash —
    // one ~2 MB minified line that contains the trigger literals. The short
    // real crash message is still reported; the giant source line is not.
    const sourceDump = `class A{free(){throw "attempted to take ownership of Rust value while it was borrowed"}}${'x'.repeat(3000)}`;
    const r = scanOf('witnesses.log', `${sourceDump}\nRuntimeError: unreachable\n`);
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]).toMatch(/RuntimeError: unreachable/);
    expect(r.matches.every((m) => m.length < 2100)).toBe(true);
  });
});

// F5 — coverage validator rejects duplicate rows, padded/duplicated individuals,
// and wrong cardinality (not just unique-count). The old last-write-wins Map +
// unique-only check let malformed heavy reports through into a citable verdict.
describe('prevalenceCoverageIssues — exact raw + unique cardinality, one row per seed', () => {
  const indiv = (id) => ({ individualId: id, maxForwardDistance: 1, peakBodySpeed: 1 });
  const seedRow = (seed, ids) => ({ populationSeed: seed, individuals: ids.map(indiv) });
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const rep = (rows) => ({ prevalence: rows });
  const SEEDS = [100, 200];
  const PER = 20;

  test('a valid report (one row per seed, exactly PER unique individuals) has no issues', () => {
    const r = prevalenceCoverageIssues(rep([seedRow(100, range(20)), seedRow(200, range(20))]), SEEDS, PER, 'x');
    expect(r).toEqual([]);
  });

  test('DUPLICATE seed rows are detected (the last-write-wins hole)', () => {
    const r = prevalenceCoverageIssues(rep([seedRow(100, range(20)), seedRow(100, range(20)), seedRow(200, range(20))]), SEEDS, PER, 'x');
    expect(r.some((i) => /3 rows, expected exactly 2/.test(i))).toBe(true);
    expect(r.some((i) => /seed 100 has 2 rows/.test(i))).toBe(true);
  });

  test('a row PADDED past PER individuals fails raw cardinality (20 unique + 20 padding)', () => {
    const r = prevalenceCoverageIssues(rep([seedRow(100, range(40)), seedRow(200, range(20))]), SEEDS, PER, 'x');
    expect(r.some((i) => /seed 100 has 40 individuals, expected 20/.test(i))).toBe(true);
  });

  test('PER rows but DUPLICATED individualIds fails unique cardinality (20 ids, 19 unique)', () => {
    const r = prevalenceCoverageIssues(rep([seedRow(100, [...range(19), 18]), seedRow(200, range(20))]), SEEDS, PER, 'x');
    expect(r.some((i) => /seed 100 has 19 unique of 20 individuals/.test(i))).toBe(true);
  });

  test('a missing declared seed and an undeclared seed both fail', () => {
    const miss = prevalenceCoverageIssues(rep([seedRow(100, range(20))]), SEEDS, PER, 'x');
    expect(miss.some((i) => /declared seed 200 MISSING/.test(i))).toBe(true);
    const extra = prevalenceCoverageIssues(rep([seedRow(100, range(20)), seedRow(200, range(20)), seedRow(999, range(20))]), SEEDS, PER, 'x');
    expect(extra.some((i) => /UNDECLARED seed 999/.test(i))).toBe(true);
  });
});

// F3 — a structured, NON-throwing read so a truncated/interrupted artifact
// surfaces as an issue instead of crashing compare() before it writes anything.
describe('readJsonSafe — distinguishes missing / valid / malformed, never throws', () => {
  const write = (name, text) => { const p = join(TMP, name); writeFileSync(p, text); return p; };

  test('a missing file: present false, valid false, no error', () => {
    const r = readJsonSafe(join(TMP, 'does-not-exist.json'));
    expect(r).toEqual({ present: false, valid: false, value: null, error: null });
  });

  test('a valid file: present true, valid true, parsed value', () => {
    const r = readJsonSafe(write('valid.json', JSON.stringify({ a: 1 })));
    expect(r.present).toBe(true);
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  test('a malformed (truncated) file: present true, valid false, error set — no throw', () => {
    const p = write('truncated.json', '{ "a": 1, "b":');
    let r;
    expect(() => { r = readJsonSafe(p); }).not.toThrow();
    expect(r.present).toBe(true);
    expect(r.valid).toBe(false);
    expect(r.value).toBeNull();
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
  });
});

// The SHARED panic scanner + classifier — one regex source used by both the
// workflow (via --mode witness-scan) and compare()'s stable usability check.
describe('witnessLogPanicSignature + classifyWitnessMatrix', () => {
  const write = (name, text) => { const p = join(TMP, name); writeFileSync(p, text); return p; };

  test('witnessLogPanicSignature returns the panic line, null on a clean or missing log', () => {
    expect(witnessLogPanicSignature(write('ws-clean.log', 'all good\nno errors\n'))).toBeNull();
    expect(witnessLogPanicSignature(join(TMP, 'ws-absent.log'))).toBeNull();
    expect(witnessLogPanicSignature(write('ws-panic.log', 'RuntimeError: unreachable\n    at wasm\n'))).toMatch(/RuntimeError: unreachable/);
    expect(witnessLogPanicSignature(write('ws-borrow.log', 'Error: attempted to take ownership of Rust value while it was borrowed\n'))).toMatch(/attempted to take ownership/);
  });

  test('classifyWitnessMatrix folds exit + signature + witnesses.json into one class, fail-closed', () => {
    const w = (freeErrors) => ({ present: true, valid: true, value: { freeErrors } });
    // completed ONLY with exit 0 + valid json + empty freeErrors + no signature.
    expect(classifyWitnessMatrix('stable', 0, null, w([])).classification).toBe('completed');
    // a signature dominates even at exit 0 — and is a FAILURE on the reference arm.
    expect(classifyWitnessMatrix('stable', 0, 'RuntimeError: unreachable', w([])).classification).toBe('engineCrash');
    expect(classifyWitnessMatrix('candidate', 1, 'RuntimeError: unreachable', { present: false }).blurb).toMatch(/Outcome-B evidence/);
    // exit 0 but no valid json is NOT clean.
    expect(classifyWitnessMatrix('stable', 0, null, { present: false, valid: false }).classification).toBe('exit0NoValidJson');
    expect(classifyWitnessMatrix('stable', 0, null, w('nope')).classification).toBe('exit0NoValidJson');
    // freeErrors non-empty, timeout, missing, unexplained.
    expect(classifyWitnessMatrix('stable', 0, null, w(['x'])).classification).toBe('completedWithFreeErrors');
    expect(classifyWitnessMatrix('stable', 124, null, w([])).classification).toBe('timeout');
    expect(classifyWitnessMatrix('stable', null, null, w([])).classification).toBe('missing');
    expect(classifyWitnessMatrix('stable', 7, null, w([])).classification).toBe('unexplained');
  });
});
