// compare-spike-runs.js — the mechanical adjudicator for the core-0.34 spike
// experiment (.github/workflows/rapier-034-spike-experiment.yml). Node-only,
// outside the src/sim ESLint ban; pure fs + JSON, no engine, no wall-clock
// dependence in its logic.
//
// TWO MODES:
//   --mode classify  (the matrix job's candidate-arm GATE)
//     node scripts/compare-spike-runs.js --mode classify \
//       --test-json <vitest.json> --expected .github/spike-expected-candidate-reds.json \
//       --label node|browser
//     Parses a `vitest run --reporter=json` file, computes the observed failing
//     (file -> count) set, and asserts it EQUALS the committed expected set
//     EXACTLY: an additional failing file, a differing count, or an expected-red
//     file that fully PASSED (an engine flip -> re-triage) all exit 1. A bare
//     "11 failures" is insufficient — identities are enforced. Prints each
//     failing test's fullName so the first heavy run yields the exact titles to
//     tighten the inventory with (titlesPendingFirstHeavyRun).
//
//   --mode timing  (the matrix job's candidate-arm probe:timing GATE)
//     node scripts/compare-spike-runs.js --mode timing \
//       --log <timing.log> --exit <code> --expected <expected-reds.json>
//     Parses the probe's `  DRIFT <check name>[ — detail]` lines and asserts
//     every drifted check is in timing.allowedDriftChecks — the expected
//     class-(b) drift may not be a blanket pass for UNRELATED semantic drifts.
//     Exit-code/DRIFT-line inconsistency (exit 0 with drifts, exit 1 with none
//     — a crash, not a drift) fails. An allowlisted drift that VANISHED is
//     reported as a class-(b) flip-watch, not fatal (recorded, not a contract).
//
//   --mode compare  (the compare job)
//     node scripts/compare-spike-runs.js --mode compare \
//       --artifacts <downloaded-artifacts-dir> --out <dir>
//     Reads results-stable/ + results-candidate/ (+ perf/, provenance/), emits a
//     stable-vs-candidate side-by-side to `comparison.md` + a machine-readable
//     `result-manifest.json` + $GITHUB_STEP_SUMMARY. MISSING or failed arms are
//     reported EXPLICITLY, never silently skipped.

/* eslint no-console: 0 */

import {
  readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ARMS = ['stable', 'candidate'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonIf(path) {
  return existsSync(path) ? readJson(path) : null;
}

// Normalize a vitest testResults[].name (absolute path, either separator) to a
// repo-relative `tests/...test.js` key.
function relTestKey(name) {
  const unix = String(name).replace(/\\/g, '/');
  const idx = unix.lastIndexOf('tests/');
  return idx === -1 ? unix : unix.slice(idx);
}

// { fileKey -> { failed, failedNames[], failedAssertions[{name, message}] } }
// for files with >=1 failing assertion. `message` joins failureMessages so
// signature regexes can classify WHICH assertion inside a test failed.
function failingByFile(vitestJson) {
  const out = {};
  for (const suite of vitestJson.testResults ?? []) {
    const key = relTestKey(suite.name);
    const failedAssertions = (suite.assertionResults ?? [])
      .filter((a) => a.status === 'failed')
      .map((a) => ({
        name: String(a.fullName ?? a.title ?? ''),
        message: (a.failureMessages ?? []).join('\n'),
      }));
    if (failedAssertions.length > 0) {
      out[key] = {
        failed: failedAssertions.length,
        failedNames: failedAssertions.map((f) => f.name),
        failedAssertions,
      };
    }
  }
  return out;
}

// { fileKey -> { titleSubstring -> passedCount } } support: count PASSED
// assertions across the WHOLE report whose fullName contains a substring.
function passedCountsBySubstring(vitestJson, substrings) {
  const counts = Object.fromEntries(substrings.map((s) => [s, 0]));
  for (const suite of vitestJson.testResults ?? []) {
    for (const a of suite.assertionResults ?? []) {
      if (a.status !== 'passed') continue;
      const name = String(a.fullName ?? a.title ?? '');
      for (const s of substrings) if (name.includes(s)) counts[s] += 1;
    }
  }
  return counts;
}

function classify({ testJsonPath, expectedPath, label }) {
  const vitest = readJson(testJsonPath);
  const expected = readJson(expectedPath);
  const section = expected[label];
  if (section === undefined) {
    console.error(`classify: expected-reds has no '${label}' section`);
    return { ok: false, errors: [`expected-reds has no '${label}' section`] };
  }
  const observed = failingByFile(vitest);
  const expectedFiles = section.byFile ?? {};
  const errors = [];

  console.log(`# candidate-red classification (${label})`);
  console.log(`observed failing files: ${Object.keys(observed).length}; `
    + `total failing tests: ${Object.values(observed).reduce((n, f) => n + f.failed, 0)}`);
  for (const [file, info] of Object.entries(observed)) {
    console.log(`  ${file}  (${info.failed} failing)`);
    for (const n of info.failedNames) console.log(`      - ${n}`);
  }

  // 1. every expected-red file must be present with the expected count (when a
  //    count is committed; browser counts may be null pending the first run).
  for (const [file, spec] of Object.entries(expectedFiles)) {
    const obs = observed[file];
    if (obs === undefined) {
      errors.push(`EXPECTED RED PASSED — ${file} produced NO failures (class-(b) engine flip? re-triage)`);
      continue;
    }
    if (typeof spec.expectedFailures === 'number' && obs.failed !== spec.expectedFailures) {
      errors.push(`COUNT MISMATCH — ${file}: expected ${spec.expectedFailures} failures, observed ${obs.failed}`);
    }
    // 1b. ASSERTION-LEVEL classification (when signatures are committed): every
    //     failing assertion in an expected-red file must match exactly one
    //     allowed signature — BOTH its title substring AND its failure-message
    //     regex — and each signature must be hit its expected number of times.
    //     This closes the within-test masking hole: a red test like "lock
    //     staleness teeth" checks many project contracts BEFORE the engine
    //     version, so a failure moving to an earlier contract keeps the same
    //     title and file count but changes the failure MESSAGE — the signature
    //     ("engine changed — re-lock deliberately") catches the move.
    const sigs = spec.allowedFailureSignatures;
    if (Array.isArray(sigs)) {
      const hits = sigs.map(() => 0);
      for (const fa of obs.failedAssertions) {
        const idx = sigs.findIndex((s) => fa.name.includes(s.titleSubstring)
          && new RegExp(s.messageRegex).test(fa.message));
        if (idx === -1) {
          errors.push(`SIGNATURE MISMATCH — ${file}: failing assertion "${fa.name}" matches NO allowed `
            + 'failure signature (the failure moved to a different assertion inside an expected-red test — '
            + `a project-contract regression, not the allowed class-(c) move). Message head: ${fa.message.slice(0, 200)}`);
        } else {
          hits[idx] += 1;
        }
      }
      sigs.forEach((s, i) => {
        if (hits[i] !== s.count) {
          errors.push(`SIGNATURE COUNT — ${file}: signature "${s.titleSubstring}" + /${s.messageRegex}/ `
            + `expected ${s.count} matching failure(s), observed ${hits[i]}`);
        }
      });
    }
  }
  // 2. no failing file outside the expected set.
  for (const file of Object.keys(observed)) {
    if (!(file in expectedFiles)) {
      errors.push(`UNEXPECTED FAILURE — ${file} is not in the expected candidate-red inventory`);
    }
  }
  // 3. assertions that MUST stay green on the candidate (internal-determinism
  //    gate-(a) + pure/structural teeth) may NOT appear in the failing set.
  const mustPass = section.mustPassAssertionSubstrings ?? [];
  for (const info of Object.values(observed)) {
    for (const name of info.failedNames) {
      for (const sub of mustPass) {
        if (String(name).includes(sub)) {
          errors.push(`MUST-STAY-GREEN ASSERTION FAILED — "${name}" matches "${sub}" `
            + '(internal-determinism / pure-structural regression — NOT an allowed class-(c) golden move)');
        }
      }
    }
  }
  // 4. POSITIVE presence: the must-stay-green assertions must appear in the
  //    report with status 'passed' at their exact multiplicity (e.g. FOUR
  //    passed "two fresh worlds agree" fixtures). Absence-of-failure alone
  //    cannot distinguish "passed" from "never ran / renamed / skipped".
  const present = section.mustPassPresent ?? [];
  if (present.length > 0) {
    const counts = passedCountsBySubstring(vitest, present.map((p) => p.titleSubstring));
    for (const p of present) {
      if (counts[p.titleSubstring] !== p.passedCount) {
        errors.push(`MUST-PASS PRESENCE — expected exactly ${p.passedCount} PASSED assertion(s) matching `
          + `"${p.titleSubstring}", observed ${counts[p.titleSubstring]} (renamed, skipped, or failing?)`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`\nCLASSIFY FAIL (${label}) — the candidate failed-test set does not match the inventory:`);
    for (const e of errors) console.error(`  ${e}`);
    return { ok: false, errors };
  }
  console.log(`\nCLASSIFY OK (${label}) — failing set matches the committed inventory exactly `
    + '(files, counts, per-assertion failure signatures, and must-pass presence).');
  return { ok: true, errors: [] };
}

// --- timing mode ----------------------------------------------------------------

// probe-rapier-timing.js prints `  DRIFT <name>[ — <detail>]` per drifted check
// (per flavor; the same check name may appear once per flavor — occurrences are
// not constrained, identities are). `obs`/`OK` lines and the trailing
// `N checks, M DRIFT` summary never match this shape.
function parseDriftLines(logText) {
  const names = [];
  for (const line of logText.split(/\r?\n/)) {
    const m = /^\s*DRIFT (.+)$/.exec(line);
    if (m !== null) names.push(m[1].split(' — ')[0].trim());
  }
  return names;
}

function timingGate({ logPath, exitCode, expectedPath }) {
  const expected = readJson(expectedPath);
  const allowed = expected.timing?.allowedDriftChecks;
  if (!Array.isArray(allowed)) {
    console.error('timing: expected-reds has no timing.allowedDriftChecks array');
    return { ok: false, errors: ['expected-reds has no timing.allowedDriftChecks array'] };
  }
  if (!existsSync(logPath)) {
    console.error(`timing: log missing (${logPath}) — cannot verify the drift set`);
    return { ok: false, errors: [`log missing (${logPath})`] };
  }
  const drifts = parseDriftLines(readFileSync(logPath, 'utf8'));
  const uniqueDrifts = [...new Set(drifts)];
  const errors = [];

  console.log('# candidate probe:timing drift classification');
  console.log(`probe exit: ${exitCode}; DRIFT lines: ${drifts.length} (${uniqueDrifts.length} distinct)`);
  for (const d of uniqueDrifts) console.log(`  - ${d}${allowed.includes(d) ? '  (allowlisted)' : '  (NOT allowlisted)'}`);

  for (const d of uniqueDrifts) {
    if (!allowed.includes(d)) {
      errors.push(`UNEXPECTED DRIFT — "${d}" is not in timing.allowedDriftChecks (a real semantic drift, not the recorded class-(b) finding)`);
    }
  }
  // Exit-code / DRIFT-line consistency: the probe exits 1 iff it saw >=1 drift.
  if (exitCode === '0' && drifts.length > 0) {
    errors.push(`INCONSISTENT — probe exit 0 but ${drifts.length} DRIFT line(s) parsed`);
  }
  if (exitCode !== '0' && drifts.length === 0) {
    errors.push(`INCONSISTENT — probe exit ${exitCode} with NO DRIFT lines (a crash or format change, not a drift; read the log)`);
  }
  if (exitCode !== '0' && exitCode !== '1') {
    errors.push(`ABNORMAL EXIT — probe exit ${exitCode} is neither 0 (green) nor 1 (drift); read the log`);
  }

  if (errors.length > 0) {
    console.error(`\nTIMING GATE FAIL:\n  ${errors.join('\n  ')}`);
    return { ok: false, errors };
  }
  const vanished = allowed.filter((a) => !uniqueDrifts.includes(a));
  if (vanished.length > 0) {
    console.log(`\nFLIP-WATCH — allowlisted class-(b) drift(s) did NOT appear: ${vanished.join('; ')}`);
    console.log('The recorded engine-finding vanished on this run — re-triage the finding (not fatal; it is recorded, not a contract).');
  }
  console.log('\nTIMING GATE OK — every drifted check is allowlisted and the exit code is consistent.');
  return { ok: true, errors: [] };
}

// --- compare mode ---------------------------------------------------------------

const HEX8 = /\b[0-9a-f]{8}\b/;

function armDir(artifacts, arm) {
  return join(artifacts, `results-${arm}`);
}

// The reproducer 'original' + 'multibody' rows (deterministic flavor).
function reproducerSummary(report) {
  if (report === null || !Array.isArray(report.reproducer)) return null;
  const pick = (arm) => report.reproducer.find((r) => r.arm === arm && r.flavor === 'deterministic')
    ?? report.reproducer.find((r) => r.arm === arm);
  const describe = (row) => {
    if (row === undefined || row.result === null || row.result === undefined) return null;
    const cat = row.result.onset?.firstCatastrophicStep ?? null;
    return {
      peakBodySpeed: row.result.peakBodySpeed ?? null,
      firstCatastrophicStep: cat,
      classification: cat === null ? 'quiescent' : 'catastrophic',
      maxForwardDistance: row.result.maxForwardDistance ?? null,
      unsupported: row.unsupported ?? false,
    };
  };
  return { original: describe(pick('original')), multibody: describe(pick('multibody')) };
}

// prevalence: { seed -> { catastrophic, total, ids } }
function prevalenceSummary(report) {
  if (report === null || !Array.isArray(report.prevalence)) return null;
  const out = {};
  for (const p of report.prevalence) {
    out[p.populationSeed] = {
      catastrophic: p.catastrophicCount,
      total: (p.individuals ?? []).length,
      ids: (p.individuals ?? [])
        .filter((i) => i.firstCatastrophicStep !== null && i.firstCatastrophicStep !== undefined)
        .map((i) => `${i.individualId}@${i.firstCatastrophicStep}`),
    };
  }
  return out;
}

function rapierVersionOf(report) {
  return report?.engine?.rapierVersion ?? null;
}

// Scan every *.log / *.txt under an arm dir for ACTUAL Rust/wasm-bindgen borrow
// or panic signatures. Deliberately specific — the words "panic"/"borrow" appear
// benignly in build logs (Cargo `panic = "abort"`, "no borrow errors"), so we
// match only real error strings: `already (mutably) borrowed`, `Borrow(Mut)Error`,
// `panicked at`, wasm-bindgen's `recursive use of an object` / `unsafe aliasing`,
// and `RuntimeError: unreachable` / `unreachable executed`.
const BORROW_SIGNATURE =
  /already (?:mutably )?borrowed|Borrow(?:Mut)?Error|panicked at|thread '[^']*' panicked|recursive use of an object|unsafe aliasing|RuntimeError: unreachable|unreachable executed/;

function borrowErrorScan(dir) {
  if (!existsSync(dir)) return { scanned: 0, matches: [] };
  const matches = [];
  let scanned = 0;
  for (const f of readdirSync(dir)) {
    if (!/\.(log|txt)$/.test(f)) continue;
    scanned += 1;
    const text = readFileSync(join(dir, f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (BORROW_SIGNATURE.test(line)) matches.push(`${f}: ${line.trim()}`);
    }
  }
  return { scanned, matches };
}

// The Node and Chromium determinism assertions for the SAME fixture digest
// carry DELIBERATELY DIFFERENT titles (Node "eval-a-s0-flat: run matches the
// committed lock ..." vs Chromium "eval-a-s0-flat: digest, counts, and every
// checkpoint state match the golden lock"; population likewise), so keying a
// digest by the raw vitest fullName can NEVER match across environments — the
// agreement check would find zero shared keys and hard-fail on every run for
// a reason unrelated to determinism. These rules map both environments' titles
// to ONE stable SEMANTIC key. Each pattern lives entirely within a single
// describe/it leaf, so it is independent of however the reporter joins the
// describe chain.
const DIGEST_SEMANTIC_RULES = [
  // Evaluation fixtures A-D: both env titles carry the `eval-<x>-...:` fixture
  // token AND render the divergence as `... actual <hex> ...` (the same
  // first-divergent checkpoint state, identical cross-env under determinism).
  { re: /(eval-[a-z0-9-]+):/, key: (m) => `evaluation:${m[1]}` },
  // Population fitness-vector digest (Node "two fresh evaluations agree
  // byte-for-byte, and the second matches the committed lock" fails at the
  // fitnessVector .toBe; Chromium "evaluation: fitness-vector digest, ...").
  { re: /two fresh evaluations agree byte-for-byte|fitness-vector digest/, key: () => 'population:fitness-vector' },
  // Population champion solo-trace digest (both env titles share the phrase).
  { re: /champion solo digest-mode rerun/, key: () => 'population:champion-trace' },
];

function semanticDigestKey(fullName) {
  for (const rule of DIGEST_SEMANTIC_RULES) {
    const m = rule.re.exec(fullName);
    if (m !== null) return rule.key(m);
  }
  return null;
}

// Digest extraction from a determinism vitest json's failure messages, keyed by
// SEMANTIC fixture identity (see DIGEST_SEMANTIC_RULES) so Node and Chromium
// digests for the same fixture compare. Assertions with no semantic key
// (version pins, non-digest teeth) are skipped. Returns { semanticKey -> digest }.
function measuredDigests(vitestJson) {
  const out = {};
  if (vitestJson === null) return out;
  for (const suite of vitestJson.testResults ?? []) {
    if (!/determinism/.test(relTestKey(suite.name))) continue;
    for (const a of suite.assertionResults ?? []) {
      if (a.status !== 'failed') continue;
      const key = semanticDigestKey(a.fullName ?? a.title ?? '');
      if (key === null || out[key] !== undefined) continue;
      const msg = (a.failureMessages ?? []).join('\n');
      // Extraction rules, most-specific first:
      //  1. an explicit "actual <hex8>" (both formatDivergence variants pad);
      //  2. "(state <hex>)" — the Chromium champion-trace message prints the
      //     divergent state UNPADDED via toString(16) in that exact bracket
      //     shape, so accept 1-8 hex chars and left-pad to the canonical 8;
      //  3. the first bare hex8 (vitest's `.toBe` diff renders the RECEIVED —
      //     i.e. measured — value first: "expected '<measured>' to be '<lock>'").
      const actual = /(?:actual|received|got)[^0-9a-f]{0,20}([0-9a-f]{8})/i.exec(msg);
      const stateBracket = /\(state ([0-9a-f]{1,8})\)/.exec(msg);
      const any = HEX8.exec(msg);
      const digest = actual ? actual[1]
        : (stateBracket ? stateBracket[1].padStart(8, '0') : (any ? any[0] : null));
      if (digest !== null) out[key] = digest;
    }
  }
  return out;
}

function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [
    line(headers),
    line(headers.map(() => '---')),
    ...rows.map((r) => line(r.map((c) => (c === null || c === undefined ? '—' : String(c))))),
  ].join('\n');
}

function compare({ artifacts, out }) {
  const L = [];
  const manifest = { schema: 'boxcar3d.spike-comparison/1', arms: {}, findings: {} };
  const push = (s) => L.push(s);

  push('# Rapier core-0.34 spike — controlled stable-vs-candidate comparison');
  push('');

  // Arm presence + USABILITY. An arm's directory existing is NOT enough — the
  // Outcome-B verdict may only rest on an arm whose adjudication PASSED, whose
  // reproducer classification exists, and (heavy) whose prevalence file is
  // present. A partial/failed arm still leaves a dir behind.
  const armReports = {};
  for (const arm of ARMS) {
    const dir = armDir(artifacts, arm);
    const present = existsSync(dir);
    const reproducer = present ? readJsonIf(join(dir, 'reproducer.json')) : null;
    const freshseed = present ? readJsonIf(join(dir, 'freshseed.json')) : null;
    const prevalence = present ? readJsonIf(join(dir, 'prevalence.json')) : null;
    const npmTest = present ? readJsonIf(join(dir, 'npm-test.json')) : null;
    const browser = present ? readJsonIf(join(dir, 'browser.json')) : null;
    const armManifest = present ? readJsonIf(join(dir, 'arm-manifest.json')) : null;
    const adjudication = present ? readJsonIf(join(dir, 'adjudication.json')) : null;
    const issues = [];
    if (!present) issues.push('artifact dir missing (job did not upload — build failure, cancelled, or skipped)');
    else {
      if (adjudication === null) issues.push('adjudication.json missing (arm did not reach the adjudicate step)');
      else if (adjudication.passed !== true) issues.push('adjudication FAILED');
      if (reproducerSummary(reproducer)?.original?.classification == null) issues.push('reproducer original classification missing');
      if (armManifest?.heavy === true && prevalence === null) issues.push('heavy run but prevalence.json missing');
    }
    const usable = issues.length === 0;
    armReports[arm] = {
      present, dir, reproducer, freshseed, prevalence, npmTest, browser, armManifest, adjudication, usable, issues,
    };
    manifest.arms[arm] = {
      present,
      usable,
      issues,
      adjudicationPassed: adjudication?.passed ?? null,
      rapierVersion: rapierVersionOf(reproducer) ?? rapierVersionOf(prevalence),
      resolvedSha: armManifest?.resolvedSha ?? null,
      npmTestFailures: npmTest?.numFailedTests ?? null,
    };
  }
  const missing = ARMS.filter((a) => !armReports[a].present);
  const unusable = ARMS.filter((a) => !armReports[a].usable);
  if (unusable.length > 0) {
    push(`> **WARNING — unusable arm(s): ${unusable.map((a) => `${a} (${armReports[a].issues.join('; ')})`).join(' · ')}.** `
      + 'The verdict below is INCOMPLETE and does NOT establish Outcome B. This is reported, not silently skipped, '
      + 'and the compare step exits nonzero.');
    push('');
  }

  push('## Provenance');
  const prov = readJsonIf(join(artifacts, 'provenance', 'candidate-provenance.json'));
  push(mdTable(['field', 'value'], [
    ['resolved BoxCar3D SHA (stable)', armReports.stable.armManifest?.resolvedSha],
    ['resolved BoxCar3D SHA (candidate)', armReports.candidate.armManifest?.resolvedSha],
    ['upstream Rapier ref', prov?.upstreamRef],
    ['candidate wasm-pack', prov?.wasmPack],
    ['candidate rapierVersion()', rapierVersionOf(armReports.candidate.reproducer)],
    ['stable rapierVersion()', rapierVersionOf(armReports.stable.reproducer)],
    ['candidate tarball SHA-256 (ordinary)', prov?.tarballs?.ordinary],
    ['candidate tarball SHA-256 (deterministic)', prov?.tarballs?.deterministic],
  ]));
  push('');
  manifest.findings.provenance = prov ?? null;

  // Reproducer (peak / onset / class).
  push('## Minimum reproducer (deterministic flavor)');
  const repro = {};
  for (const arm of ARMS) repro[arm] = reproducerSummary(armReports[arm].reproducer);
  const reproRow = (armSum, key) => {
    const s = armSum?.[key];
    if (!s) return ['—', '—', '—'];
    return [s.classification, s.firstCatastrophicStep ?? '—', s.peakBodySpeed === null ? '—' : s.peakBodySpeed.toExponential(3)];
  };
  push(mdTable(
    ['arm', 'original class', 'original cat@', 'original peak m/s', 'multibody class', 'multibody cat@', 'multibody peak m/s'],
    ARMS.map((arm) => [arm, ...reproRow(repro[arm], 'original'), ...reproRow(repro[arm], 'multibody')]),
  ));
  push('');
  push('_The verdict is the CLASSIFICATION column (catastrophic vs quiescent), not the exact peak — wasm is not byte-reproducible across environments._');
  push('');
  manifest.findings.reproducer = repro;

  // Prevalence incl. the fresh seed on BOTH arms.
  push('## Prevalence (per population seed: catastrophic / total)');
  const prev = {};
  for (const arm of ARMS) {
    const merged = { ...(prevalenceSummary(armReports[arm].prevalence) ?? {}), ...(prevalenceSummary(armReports[arm].freshseed) ?? {}) };
    prev[arm] = merged;
  }
  const seeds = [...new Set(ARMS.flatMap((a) => Object.keys(prev[a])))].sort();
  push(mdTable(
    ['population seed', ...ARMS.map((a) => `${a} cat/total`), ...ARMS.map((a) => `${a} ids`)],
    seeds.map((seed) => [
      seed,
      ...ARMS.map((a) => (prev[a][seed] ? `${prev[a][seed].catastrophic}/${prev[a][seed].total}` : '—')),
      ...ARMS.map((a) => (prev[a][seed] ? prev[a][seed].ids.join(' ') : '—')),
    ]),
  ));
  push('');
  manifest.findings.prevalence = prev;

  // Test failed-set diff.
  push('## Unit-suite failed-test sets');
  for (const arm of ARMS) {
    const t = armReports[arm].npmTest;
    if (t === null) { push(`- **${arm}:** npm-test.json MISSING`); continue; }
    const fbf = failingByFile(t);
    const files = Object.keys(fbf);
    push(`- **${arm}:** ${t.numFailedTests ?? '?'} failing`
      + (files.length ? ` across ${files.length} files — ${files.map((f) => `${f}(${fbf[f].failed})`).join(', ')}` : ' (all green)'));
  }
  push('');
  manifest.findings.tests = Object.fromEntries(ARMS.map((a) => [a, armReports[a].npmTest
    ? { numFailedTests: armReports[a].npmTest.numFailedTests, byFile: failingByFile(armReports[a].npmTest) }
    : null]));

  // Determinism digests + Node<->Chromium agreement (candidate).
  push('## Determinism digests (candidate: Node vs Chromium)');
  const nodeD = measuredDigests(armReports.candidate.npmTest);
  const chromeD = measuredDigests(armReports.candidate.browser);
  const keys = [...new Set([...Object.keys(nodeD), ...Object.keys(chromeD)])];
  if (keys.length === 0) {
    push('_No determinism failure digests could be extracted — either both green (unexpected on candidate) or the failure-message format changed. See raw logs._');
    manifest.findings.nodeChromiumAgreement = { extracted: false };
  } else {
    let agree = true;
    push(mdTable(['determinism assertion', 'Node digest', 'Chromium digest', 'agree'],
      keys.map((k) => {
        const n = nodeD[k] ?? null; const c = chromeD[k] ?? null;
        const ok = n !== null && c !== null && n === c;
        if (n !== null && c !== null && !ok) agree = false;
        return [k, n, c, ok ? 'yes' : (n === null || c === null ? 'n/a' : 'NO')];
      })));
    push('');
    push(agree
      ? '_Node and Chromium agree on every extracted candidate digest (cross-env determinism holds on core 0.34)._'
      : '> **Node↔Chromium DISAGREEMENT on a candidate digest — investigate before any claim of cross-env determinism.**');
    manifest.findings.nodeChromiumAgreement = { extracted: true, agree, node: nodeD, chromium: chromeD };
  }
  push('');

  // Borrow-error scan.
  push('## `world.free()` borrow/panic scan');
  for (const arm of ARMS) {
    const scan = borrowErrorScan(armReports[arm].dir);
    push(`- **${arm}:** scanned ${scan.scanned} log(s); ${scan.matches.length} borrow/ownership/unreachable/panic match(es)`
      + (scan.matches.length ? `:\n  - ${scan.matches.slice(0, 10).join('\n  - ')}` : '.'));
    manifest.findings[`borrow_${arm}`] = scan;
  }
  push('');

  // Paired bench. NOT decision-relevant to Outcome B, but the summary must not
  // claim JSON was collected when it wasn't: validate the four run objects and
  // report perf as INCOMPLETE/ERRORED explicitly instead of echoing a fixed note.
  push('## Paired bench (same-runner, alternating)');
  const perf = readJsonIf(join(artifacts, 'perf', 'perf.json'));
  let perfStatus = 'missing';
  if (perf === null) {
    push('- perf.json MISSING — the perf job did not upload results.');
  } else {
    const runs = Array.isArray(perf.runs) ? perf.runs : [];
    const parsed = runs.filter((r) => r && r.json !== null && r.json !== undefined);
    const errored = parsed.filter((r) => r.json && r.json.status === 'error');
    const declaredOk = perf.summary?.status === 'ok' || perf.summary?.allParsed === true;
    perfStatus = (runs.length >= 4 && parsed.length === runs.length && errored.length === 0 && declaredOk)
      ? 'ok'
      : `incomplete (${parsed.length}/${runs.length || 4} JSON parsed${errored.length ? `, ${errored.length} errored` : ''})`;
    if (perfStatus === 'ok') {
      push('```json');
      push(JSON.stringify(perf.summary ?? perf, null, 2).slice(0, 4000));
      push('```');
    } else {
      push(`> **perf INCOMPLETE/ERRORED — ${perfStatus}.** The paired bench did not produce four parseable runs; `
        + 'its numbers are NOT reported as valid. (Perf is not decision-relevant to Outcome B.)');
    }
  }
  manifest.findings.perf = { status: perfStatus, summary: perf?.summary ?? null };
  push('');

  // Verdict (classification level) — established ONLY when both arms are usable
  // and both original-reproducer classifications exist. When either is missing,
  // undefined===undefined must NOT read as "SAME class"; emit INCONCLUSIVE.
  const bothUsable = ARMS.every((a) => armReports[a].usable);
  const cStable = repro.stable?.original?.classification ?? null;
  const cCand = repro.candidate?.original?.classification ?? null;
  const mStable = repro.stable?.multibody?.classification ?? null;
  const mCand = repro.candidate?.multibody?.classification ?? null;
  const canJudge = bothUsable && cStable !== null && cCand !== null;
  const impulseSame = canJudge ? (cStable === cCand) : null;
  // Only a heavy=true run (full all-witness + 60-member prevalence) may be
  // cited in the decision record (C5); a heavy=false debug run can still show a
  // real catastrophic-on-both classification, so label it PROVISIONAL rather
  // than let a green debug compare read as citable evidence.
  const isHeavy = ARMS.every((a) => armReports[a].armManifest?.heavy === true);
  const citable = canJudge && isHeavy;
  push('## Verdict (classification level)');
  if (!canJudge) {
    push(`- reproducer (impulse): stable **${cStable ?? '?'}**, candidate **${cCand ?? '?'}** `
      + '→ **INCONCLUSIVE — verdict NOT established** (a missing/failed arm or absent classification; NOT "Outcome B holds")');
  } else {
    const tag = impulseSame ? 'SAME class (Outcome B reproduced)' : 'DIFFERENT — re-examine';
    push(`- reproducer (impulse): stable **${cStable}**, candidate **${cCand}** → ${tag}`
      + (citable ? '' : ' _(PROVISIONAL — heavy=false debug run; NOT citable for C5)_'));
  }
  push(`- reproducer (multibody): stable **${mStable ?? '?'}**, candidate **${mCand ?? '?'}**`);
  manifest.verdict = {
    established: canJudge,
    citable,
    heavy: isHeavy,
    reproducerImpulse: { stable: cStable, candidate: cCand, sameClass: impulseSame },
    reproducerMultibody: { stable: mStable, candidate: mCand },
    bothArmsUsable: bothUsable,
    armIssues: Object.fromEntries(ARMS.map((a) => [a, armReports[a].issues])),
    missingArms: missing,
    perfStatus,
  };

  const md = L.join('\n');
  writeFileSync(join(out, 'comparison.md'), `${md}\n`);
  writeFileSync(join(out, 'result-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(`comparison.md + result-manifest.json written to ${out}`);
  // Nonzero when the verdict is not established, so a green compare job
  // genuinely means "controlled pair complete + Outcome B judged" (the review's
  // finding 1: a merely-existing arm dir must never read as SAME class).
  // comparison.md/manifest are already written above — the if:always upload
  // preserves the evidence either way.
  if (!canJudge) {
    console.error(`\nCOMPARISON INCONCLUSIVE — verdict NOT established. Arm issues: `
      + `${JSON.stringify(Object.fromEntries(ARMS.map((a) => [a, armReports[a].issues])))}`);
    return { ok: false, manifest };
  }
  if (missing.length > 0) console.log(`NOTE: ${missing.length} arm(s) missing — comparison is incomplete.`);
  return { ok: true, manifest };
}

// The candidate arm's must-PASS invariants (amendment 4), a GATE independent of
// the expected-red set: the dt readback stays f32(1/60), and the candidate's
// Node and Chromium determinism digests agree (cross-env determinism holds).
const F32_DT = 0.01666666753590107;

function invariants({ nodeJson, browserJson, reproducerJson, expectedPath }) {
  const errors = [];

  const repro = readJsonIf(reproducerJson);
  if (repro === null) {
    errors.push(`dt-readback: reproducer json missing (${reproducerJson})`);
  } else if (repro.engine?.effectiveDt !== F32_DT) {
    errors.push(`dt-readback: engine.effectiveDt ${repro.engine?.effectiveDt} != f32(1/60) ${F32_DT}`);
  } else {
    console.log(`  OK   dt readback = ${F32_DT} (f32(1/60))`);
  }

  // The DECLARED required cross-env set: every semantic digest that moves on
  // the candidate and exists in BOTH environments (evaluation A-D + both
  // population digests). Set-membership alone is a false-pass hole — Node
  // extracting A-D while Chromium extracts only A must NOT pass on A's
  // agreement — so the extracted key set must EQUAL the required set in each
  // environment, and every key's measured value must agree.
  const required = readJson(expectedPath).nodeChromiumRequiredKeys;
  if (!Array.isArray(required) || required.length === 0) {
    errors.push('expected-reds has no nodeChromiumRequiredKeys array — the required cross-env set must be declared');
    console.error(`\nINVARIANTS FAIL:\n  ${errors.join('\n  ')}`);
    return { ok: false, errors };
  }
  const nD = measuredDigests(readJsonIf(nodeJson));
  const cD = measuredDigests(readJsonIf(browserJson));
  console.log(`  required cross-env keys: ${required.join('; ')}`);
  console.log(`  extracted Node digests: ${JSON.stringify(nD)}`);
  console.log(`  extracted Chromium digests: ${JSON.stringify(cD)}`);
  for (const k of required) {
    const n = nD[k]; const c = cD[k];
    if (n === undefined) errors.push(`required key "${k}" NOT extracted from the Node report (renamed test, format change, or an unexpected pass)`);
    if (c === undefined) errors.push(`required key "${k}" NOT extracted from the Chromium report (renamed test, format change, or an unexpected pass)`);
    if (n !== undefined && c !== undefined) {
      if (n === c) console.log(`  OK   Node==Chromium on "${k}" (${n})`);
      else errors.push(`node<->chromium disagree on "${k}": Node ${n} vs Chromium ${c}`);
    }
  }
  // Set EQUALITY in both directions: an extracted key outside the declared set
  // means the semantic rules matched something unexpected — fail loud, never
  // informational.
  for (const k of Object.keys(nD)) {
    if (!required.includes(k)) errors.push(`Node extracted an UNDECLARED semantic key "${k}" (${nD[k]}) — the semantic rules or the test set changed; update nodeChromiumRequiredKeys deliberately`);
  }
  for (const k of Object.keys(cD)) {
    if (!required.includes(k)) errors.push(`Chromium extracted an UNDECLARED semantic key "${k}" (${cD[k]}) — the semantic rules or the test set changed; update nodeChromiumRequiredKeys deliberately`);
  }

  if (errors.length > 0) {
    console.error(`\nINVARIANTS FAIL:\n  ${errors.join('\n  ')}`);
    return { ok: false, errors };
  }
  console.log('\nINVARIANTS OK — dt readback holds and Node<->Chromium agree on the COMPLETE required digest set.');
  return { ok: true, errors: [] };
}

function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      'test-json': { type: 'string' },
      expected: { type: 'string' },
      label: { type: 'string', default: 'node' },
      artifacts: { type: 'string', default: 'artifacts' },
      out: { type: 'string', default: '.' },
      'node-json': { type: 'string' },
      'browser-json': { type: 'string' },
      'reproducer-json': { type: 'string' },
      log: { type: 'string' },
      exit: { type: 'string' },
    },
  });
  let result;
  if (values.mode === 'classify') {
    if (values['test-json'] === undefined || values.expected === undefined) {
      console.error('compare-spike-runs: --mode classify needs --test-json and --expected');
      process.exit(2);
    }
    result = classify({ testJsonPath: values['test-json'], expectedPath: values.expected, label: values.label });
  } else if (values.mode === 'compare') {
    result = compare({ artifacts: values.artifacts, out: values.out });
  } else if (values.mode === 'invariants') {
    if (values.expected === undefined) {
      console.error('compare-spike-runs: --mode invariants needs --expected (the required cross-env key set)');
      process.exit(2);
    }
    result = invariants({
      nodeJson: values['node-json'],
      browserJson: values['browser-json'],
      reproducerJson: values['reproducer-json'],
      expectedPath: values.expected,
    });
  } else if (values.mode === 'timing') {
    if (values.log === undefined || values.exit === undefined || values.expected === undefined) {
      console.error('compare-spike-runs: --mode timing needs --log, --exit, and --expected');
      process.exit(2);
    }
    result = timingGate({ logPath: values.log, exitCode: values.exit, expectedPath: values.expected });
  } else {
    console.error("compare-spike-runs: --mode must be 'classify', 'compare', 'invariants', or 'timing'");
    process.exit(2);
  }
  if (result.ok !== true) process.exit(1);
}

// Adjudication paths are exported for the committed vitest coverage
// (tests/compare-spike-runs.test.js — pure JSON fixtures, no physics); the CLI
// runs only when this file is the entrypoint (the bench-physics guard idiom).
export {
  classify, invariants, timingGate, compare,
  failingByFile, measuredDigests, semanticDigestKey, parseDriftLines,
  passedCountsBySubstring, relTestKey, F32_DT,
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
