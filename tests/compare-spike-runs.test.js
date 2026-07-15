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
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import {
  classify, invariants, timingGate, compare,
  failingByFile, measuredDigests, semanticDigestKey, parseDriftLines, reproducerSummary,
  borrowErrorScan,
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
      prevalenceSeeds = TEST_HEAVY.prevalenceSeeds, freshseedMissing = false,
      bootstrapComplete = true,
      stableCat = 46, candidateCat = 107, // null => quiescent classification
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
      wj(`results-${arm}/arm-manifest.json`, { arm, resolvedSha: 'abc', heavy });
      wj(`results-${arm}/adjudication.json`, { schema: 'boxcar3d.adjudication/1', arm, passed: arm === 'candidate' ? candidatePassed : true, heavy });
      if (heavy && (arm === 'stable' || prevalencePresent)) {
        // Malformed = no prevalence array at all (hits the array guard); an
        // empty array is instead caught by the seed-coverage check.
        wj(`results-${arm}/prevalence.json`, prevalenceMalformed ? { engine: {} } : mkPrev(prevalenceSeeds));
      }
    }
    const run = (arm, i, ok) => ({ arm, i, exit: ok ? 0 : 1, json: ok ? { meta: {} } : null });
    const runs = [run('stable', 1, perfOk), run('candidate', 1, perfOk), run('candidate', 2, true), run('stable', 2, true)];
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
});
