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
  failingByFile, measuredDigests, semanticDigestKey, parseDriftLines,
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
function nodeCandidateReport({ evalActual = '6b83729e', fvMeasured = 'ee605286', champState = '0000dcba' } = {}) {
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
          ...EVAL_FIX.map((fx) => failed(`gate (d): golden locks (deterministic flavor) > ${fx}: run matches the committed lock (digest, counts, every checkpoint state)`,
            `expected '${fx}: first divergent checkpoint index 1 (state); last agreed step 0, first differing step 1; expected state 5a219735 actual ${evalActual}' to be null`)),
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
            "expected 'first divergent checkpoint 1 (state) at step 1' to be null"),
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
            `expected 'champion trace: first divergent checkpoint index 1 (state); last agreed step 0, first differing step 1; expected state 000000aa actual ${champState}' to be null`),
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

// --- invariants: exact required cross-env set ------------------------------------

describe('invariants — complete required Node<->Chromium digest set', () => {
  const args = (node, browser, repro = reproJson()) => ({
    nodeJson: writeJson(`i-n-${Math.abs(JSON.stringify(node).length)}.json`, node),
    browserJson: writeJson(`i-b-${Math.abs(JSON.stringify(browser).length)}.json`, browser),
    reproducerJson: writeJson(`i-r-${Math.abs(JSON.stringify(repro).length)}.json`, repro),
    expectedPath: EXPECTED,
  });

  test('all six required keys extracted from BOTH envs with equal values (incl. the unpadded Chromium champion state) passes', () => {
    const r = invariants(args(nodeCandidateReport(), browserCandidateReport()));
    expect(r.ok).toBe(true);
  });

  test('Chromium missing one required key (champion) fails — Node-only agreement on the rest must NOT pass', () => {
    const browser = browserCandidateReport();
    browser.testResults[1].assertionResults = browser.testResults[1].assertionResults.filter((a) => !a.fullName.includes('champion solo'));
    const r = invariants(args(nodeCandidateReport(), browser));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('population:champion-trace');
  });

  test('a genuine cross-env digest disagreement fails', () => {
    const r = invariants(args(nodeCandidateReport({ evalActual: '6b83729e' }), browserCandidateReport({ evalActual: 'ffff0000' })));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('disagree');
  });

  test('the wrong dt readback fails', () => {
    const r = invariants(args(nodeCandidateReport(), browserCandidateReport(), reproJson(1 / 60)));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('dt-readback');
  });

  test('semantic keys: differently-titled Node/Chromium assertions map to the same identity, and the champion state pads', () => {
    expect(semanticDigestKey('gate (d): golden locks (deterministic flavor) > eval-b-mixed-composite: run matches the committed lock (digest, counts, every checkpoint state)')).toBe('evaluation:eval-b-mixed-composite');
    expect(semanticDigestKey('Chromium reproduces the committed deterministic-flavor locks > eval-b-mixed-composite: digest, counts, and every checkpoint state match the golden lock')).toBe('evaluation:eval-b-mixed-composite');
    const cD = measuredDigests(browserCandidateReport({ champStateUnpadded: 'dcba' }));
    expect(cD['population:champion-trace']).toBe('0000dcba');
    const nD = measuredDigests(nodeCandidateReport({ champState: '0000dcba' }));
    expect(nD['population:champion-trace']).toBe('0000dcba');
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
  function buildArtifacts(opts = {}) {
    const {
      candidatePassed = true, candidateReproPresent = true, heavy = false,
      prevalencePresent = true, perfOk = true,
    } = opts;
    const root = mkdtempSync(join(tmpdir(), 'spike-compare-'));
    const mk = (p) => mkdirSync(join(root, p), { recursive: true });
    const wj = (p, o) => writeFileSync(join(root, p), JSON.stringify(o, null, 2));
    mk('provenance'); mk('results-stable'); mk('results-candidate'); mk('perf'); mk('out');
    wj('provenance/candidate-provenance.json', { upstreamRef: 'c13133ad', wasmPack: 'wasm-pack 0.13.1', tarballs: {} });
    const repro = (ver, cat) => ({
      engine: { rapierVersion: ver, effectiveDt: 0.01666666753590107 },
      reproducer: [
        { arm: 'original', flavor: 'deterministic', result: { peakBodySpeed: 4785, maxForwardDistance: 3, onset: { firstCatastrophicStep: cat } } },
        { arm: 'multibody', flavor: 'deterministic', result: { peakBodySpeed: 1.4, maxForwardDistance: 0.1, onset: { firstCatastrophicStep: null } } },
      ],
    });
    const prev = (ver) => ({ engine: { rapierVersion: ver }, prevalence: [{ populationSeed: 20260725, catastrophicCount: 3, individuals: [] }] });
    wj('results-stable/reproducer.json', repro('0.19.3', 46));
    wj('results-stable/freshseed.json', prev('0.19.3'));
    wj('results-stable/arm-manifest.json', { arm: 'stable', resolvedSha: 'abc', heavy });
    wj('results-stable/adjudication.json', { schema: 'boxcar3d.adjudication/1', arm: 'stable', passed: true, heavy });
    if (heavy) wj('results-stable/prevalence.json', prev('0.19.3'));
    if (candidateReproPresent) wj('results-candidate/reproducer.json', repro('0.19.3-c13133ad.0', 107));
    wj('results-candidate/freshseed.json', prev('0.19.3-c13133ad.0'));
    wj('results-candidate/arm-manifest.json', { arm: 'candidate', resolvedSha: 'abc', heavy });
    wj('results-candidate/adjudication.json', { schema: 'boxcar3d.adjudication/1', arm: 'candidate', passed: candidatePassed, heavy });
    if (heavy && prevalencePresent) wj('results-candidate/prevalence.json', prev('0.19.3-c13133ad.0'));
    const run = (arm, i, ok) => ({ arm, i, exit: ok ? 0 : 1, json: ok ? { meta: {} } : null });
    const runs = [run('stable', 1, perfOk), run('candidate', 1, perfOk), run('candidate', 2, true), run('stable', 2, true)];
    const parsed = runs.filter((r) => r.json !== null).length;
    wj('perf/perf.json', { schema: 'boxcar3d.spike-perf/1', summary: { status: parsed === 4 ? 'ok' : 'incomplete', allParsed: parsed === 4, parsed, total: 4 }, runs });
    return root;
  }
  const md = (root) => readFileSync(join(root, 'out', 'comparison.md'), 'utf8');

  test('both arms usable -> established; heavy=false is PROVISIONAL, heavy=true citable', () => {
    let root = buildArtifacts({ heavy: false });
    let r = compare({ artifacts: root, out: join(root, 'out') });
    expect(r.ok).toBe(true);
    expect(r.manifest.verdict.established).toBe(true);
    expect(r.manifest.verdict.citable).toBe(false);
    expect(md(root)).toContain('PROVISIONAL');

    root = buildArtifacts({ heavy: true });
    r = compare({ artifacts: root, out: join(root, 'out') });
    expect(r.manifest.verdict.citable).toBe(true);
    expect(md(root)).not.toContain('PROVISIONAL');
  });

  test('a FAILED candidate adjudication or a MISSING reproducer classification is INCONCLUSIVE, never "Outcome B"', () => {
    let root = buildArtifacts({ candidatePassed: false });
    let r = compare({ artifacts: root, out: join(root, 'out') });
    expect(r.ok).toBe(false);
    expect(r.manifest.verdict.established).toBe(false);
    expect(md(root)).toContain('INCONCLUSIVE');
    expect(md(root)).not.toContain('Outcome B reproduced');

    root = buildArtifacts({ candidateReproPresent: false });
    r = compare({ artifacts: root, out: join(root, 'out') });
    expect(r.ok).toBe(false);
    expect(r.manifest.verdict.reproducerImpulse.sameClass).toBeNull();
    expect(md(root)).not.toContain('SAME class');
  });

  test('a heavy run missing the candidate prevalence file is unusable; incomplete perf reports honestly', () => {
    let root = buildArtifacts({ heavy: true, prevalencePresent: false });
    expect(compare({ artifacts: root, out: join(root, 'out') }).ok).toBe(false);
    expect(md(root)).toContain('prevalence.json missing');

    root = buildArtifacts({ perfOk: false });
    const r = compare({ artifacts: root, out: join(root, 'out') });
    expect(r.ok).toBe(true); // perf is not decision-relevant to the verdict
    expect(md(root)).toContain('perf INCOMPLETE/ERRORED');
    expect(r.manifest.findings.perf.status).not.toBe('ok');
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

  test('inventory self-consistency: signature counts sum to expectedFailures per Node file, and totals agree', () => {
    const inv = JSON.parse(readFileSync(EXPECTED, 'utf8'));
    let total = 0;
    for (const [file, spec] of Object.entries(inv.node.byFile)) {
      expect(Array.isArray(spec.allowedFailureSignatures), `${file}: Node reds must carry assertion-level signatures`).toBe(true);
      const sum = spec.allowedFailureSignatures.reduce((n, s) => n + s.count, 0);
      expect(sum, `${file}: signature counts must sum to expectedFailures`).toBe(spec.expectedFailures);
      for (const s of spec.allowedFailureSignatures) expect(() => new RegExp(s.messageRegex)).not.toThrow();
      total += spec.expectedFailures;
    }
    expect(total).toBe(inv.node.totalExpectedFailures);
    expect(inv.nodeChromiumRequiredKeys).toHaveLength(6);
    expect(inv.timing.allowedDriftChecks).toEqual(['re-enable resumes per-step updates']);
  });
});
