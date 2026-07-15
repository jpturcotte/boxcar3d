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
    // vitest 3.2.7 reports a FILE-LEVEL error (a throwing afterAll/beforeAll,
    // a teardown/module/wasm error) in `suite.message`, INDEPENDENTLY of
    // assertion failures — a file can carry all its expected golden reds AND a
    // file-level error. Append a synthetic failure whenever `message` is
    // non-empty (so counts/signatures no longer match) regardless of how many
    // assertions also failed.
    if (typeof suite.message === 'string' && suite.message.trim() !== '') {
      failedAssertions.push({ name: `${key} > <file-level error>`, message: suite.message.trim() });
    }
    // Fallback: a suite that FAILED with NEITHER assertion failures NOR a
    // message (status 'failed' alone) is still not invisible.
    if (failedAssertions.length === 0 && suite.status === 'failed') {
      failedAssertions.push({
        name: `${key} > <suite-level failure>`,
        message: '(suite failed with no assertion-level failures or message — import/hook error?)',
      });
    }
    if (failedAssertions.length > 0) {
      // Merge duplicate relTestKey suites by ACCUMULATION (never last-write-wins,
      // which would let a second entry silently discard the first's regression).
      const prior = out[key]?.failedAssertions ?? [];
      const merged = [...prior, ...failedAssertions];
      out[key] = { failed: merged.length, failedNames: merged.map((f) => f.name), failedAssertions: merged };
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
  // Require EXACTLY ONE deterministic row per arm. Zero = missing; more than
  // one = malformed (a duplicate/fabricated catastrophic row must not win
  // first-match over a genuine quiescent one). No cross-flavor fallback — the
  // verdict is about the DETERMINISTIC flavor, so ordinary-flavor data must
  // never be silently substituted under a "deterministic" label.
  const pick = (arm) => report.reproducer.filter((r) => r.arm === arm && r.flavor === 'deterministic');
  const describe = (rows) => {
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (row === undefined || row.result === null || row.result === undefined) return null;
    // An arm that declares the reproducer UNSUPPORTED on this build has no
    // valid measurement — treat as missing, never surface a live classification.
    if (row.unsupported === true) return null;
    // Absence is MISSING (=> arm unusable), NOT quiescent. Only an onset object
    // that OWNS a firstCatastrophicStep of exactly null is a valid explicit
    // quiescent result; a non-negative integer is catastrophic; anything else
    // (missing onset, missing key, non-finite, negative, non-integer) is a
    // malformed report and must not classify as a scientific outcome.
    const { onset } = row.result;
    if (onset === null || onset === undefined || !Object.hasOwn(onset, 'firstCatastrophicStep')) return null;
    const cat = onset.firstCatastrophicStep;
    if (cat !== null && (!Number.isInteger(cat) || cat < 0)) return null;
    return {
      peakBodySpeed: row.result.peakBodySpeed ?? null,
      firstCatastrophicStep: cat,
      classification: cat === null ? 'quiescent' : 'catastrophic',
      maxForwardDistance: row.result.maxForwardDistance ?? null,
      unsupported: false,
    };
  };
  return { original: describe(pick('original')), multibody: describe(pick('multibody')) };
}

// Heavy-evidence coverage: the report must cover EXACTLY the declared seeds,
// each with the declared number of UNIQUE individuals — not merely a non-empty
// array. Returns issue strings (empty = ok).
function prevalenceCoverageIssues(report, expectedSeeds, perSeed, label) {
  const rows = Array.isArray(report?.prevalence) ? report.prevalence : null;
  if (rows === null) return [`${label}: prevalence array missing or malformed`];
  const issues = [];
  const bySeed = new Map(rows.map((r) => [r.populationSeed, r]));
  for (const seed of expectedSeeds) {
    const row = bySeed.get(seed);
    if (row === undefined) { issues.push(`${label}: declared seed ${seed} MISSING`); continue; }
    const ids = (row.individuals ?? []).map((i) => i.individualId);
    const uniq = new Set(ids);
    if (uniq.size !== perSeed) issues.push(`${label}: seed ${seed} has ${uniq.size} unique individuals, expected ${perSeed}`);
  }
  for (const r of rows) {
    if (!expectedSeeds.includes(r.populationSeed)) issues.push(`${label}: UNDECLARED seed ${r.populationSeed} present (coverage must be exact)`);
  }
  return issues;
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
  /already (?:mutably )?borrowed|Borrow(?:Mut)?Error|attempted to take ownership of Rust value while it was borrowed|panicked at|thread '[^']*' panicked|recursive use of an object|unsafe aliasing|RuntimeError: unreachable|unreachable executed/;
// An uncaught wasm crash makes Node print the offending module SOURCE line —
// for rapier.mjs that is one minified ~2 MB line that happens to contain the
// borrow/unreachable trigger literals. Skip lines this long: a real panic
// MESSAGE is short; a multi-KB line is a source dump, not evidence.
const MAX_SCAN_LINE = 2000;

// CSI SGR (colour) matcher, built from a string so the source carries no literal
// ESC control char (eslint no-control-regex stays happy). Vitest colours its
// captured-output headers even when piped in CI, so we strip before matching.
const ANSI_ESCAPE = new RegExp('\\x1b\\[[0-9;]*m', 'g');
// Vitest attributes each captured console block to a test via a header line
// `stdout | <file> > <test>` / `stderr | <file> > <test>`. The owning file lets
// us drop console output that a pure unit test PRINTED (never an engine fault).
const CAPTURE_HEADER = /^\s*(?:stdout|stderr)\s*\|\s*(\S+)/;
// The run of horizontal-line glyphs vitest prints around its failed-tests /
// unhandled-errors summary — the boundary where captured console output ends.
// vitest 3.x uses U+23AF (⎯); include U+2500/U+2501 for other builds. Excludes
// the em-dash U+2014 that appears in prose test names, so a ≥4 run never matches
// a describe/test title.
const VITEST_SUMMARY_BOUNDARY = /[⎯─━]{4,}/;
// The self-referential contract test: scripts/compare-spike-runs.js's OWN unit
// suite deliberately feeds synthetic borrow/panic/unreachable FIXTURES through
// classify(), which prints them to stdout/stderr. That captured output lands in
// npmtest.log and is NOT an engine panic — it appears identically on BOTH arms
// (same `npm test`) and would falsely read as a "project-contract regression" on
// the fully-green stable arm. This test never touches Rapier, so attributing and
// skipping its captured blocks can never hide a real engine fault.
const SELF_CONTRACT_TEST = 'compare-spike-runs.test.js';

function borrowErrorScan(dir) {
  if (!existsSync(dir)) return { scanned: 0, matches: [] };
  const matches = [];
  let scanned = 0;
  for (const f of readdirSync(dir)) {
    if (!/\.(log|txt)$/.test(f)) continue;
    scanned += 1;
    const text = readFileSync(join(dir, f), 'utf8');
    // Track which test owns the current captured-console block. Owner persists
    // until the next header; the summary boundary resets it (a real engine panic
    // in the summary dump carries its own file header, but the reset also
    // defends against a stale owner leaking across the boundary).
    let capturedOwner = null;
    for (const raw of text.split(/\r?\n/)) {
      if (raw.length > MAX_SCAN_LINE) continue; // minified source dump, not a message
      const line = raw.replace(ANSI_ESCAPE, '');
      const header = CAPTURE_HEADER.exec(line);
      if (header !== null) { capturedOwner = header[1]; continue; }
      if (VITEST_SUMMARY_BOUNDARY.test(line)) { capturedOwner = null; continue; }
      if (!BORROW_SIGNATURE.test(line)) continue;
      if (capturedOwner !== null && capturedOwner.endsWith(SELF_CONTRACT_TEST)) continue;
      matches.push(`${f}: ${line.trim()}`);
    }
  }
  return { scanned, matches };
}

// ONLY the population fitness-vector digest is reliably comparable across Node
// and Chromium: BOTH reporters emit it via a short `.toBe('<digest>')` whose
// message is not truncated. The eval A-D checkpoint states and the champion
// trace are deliberately NOT semantic keys — Node's `.toBeNull()` on a
// formatted divergence string is TRUNCATED by the reporter (the state hex is
// dropped) while Chromium keeps the full `expect.fail` message, so scraping
// them yields Chromium-only extractions that would fail set-equality for a
// reason unrelated to determinism. (Measured on the first heavy dispatch; see
// nodeChromiumRequiredKeysRationale in the inventory.)
const DIGEST_SEMANTIC_RULES = [
  { re: /two fresh evaluations agree byte-for-byte|fitness-vector digest/, key: () => 'population:fitness-vector' },
];

function semanticDigestKey(fullName) {
  for (const rule of DIGEST_SEMANTIC_RULES) {
    if (rule.guard !== undefined && !rule.guard.test(fullName)) continue;
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
      // Scan ONLY the first line (the assertion message). The stack-trace lines
      // that follow carry vitest bundle URLs like `?v=d9c9c21b` whose 8-hex
      // query hash would be a false digest match. The fitness-vector digest is
      // the RECEIVED (measured) value, which vitest renders first in the
      // `.toBe` diff: "expected '<measured>' to be '<lock>'".
      const msg = ((a.failureMessages ?? []).join('\n').split('\n')[0]) ?? '';
      const m = HEX8.exec(msg);
      if (m !== null) out[key] = m[0];
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

function compare({ artifacts, out, expectedPath }) {
  const L = [];
  const manifest = { schema: 'boxcar3d.spike-comparison/1', arms: {}, findings: {} };
  const push = (s) => L.push(s);
  // The committed inventory drives the two-stage citability gate + the heavy
  // coverage contract. Absent/unreadable => fail-safe: bootstrapComplete false
  // (never citable) and the heavy check falls back to a non-empty array.
  const expected = expectedPath !== undefined ? readJsonIf(expectedPath) : null;
  const bootstrapComplete = expected?.bootstrapComplete === true;
  const heavyEvidence = expected?.heavyEvidence ?? null;

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
      // A heavy run must carry the DECLARED evidence coverage — the exact
      // prevalence seed set (each with the declared individual count) AND the
      // fresh-seed report — not merely a non-empty array. A one-row or
      // missing-fresh-seed artifact must not participate in a citable verdict.
      if (armManifest?.heavy === true) {
        if (heavyEvidence !== null) {
          issues.push(...prevalenceCoverageIssues(prevalence, heavyEvidence.prevalenceSeeds, heavyEvidence.individualsPerSeed, 'prevalence.json'));
          issues.push(...prevalenceCoverageIssues(freshseed, heavyEvidence.freshSeeds, heavyEvidence.individualsPerSeed, 'freshseed.json'));
        } else if (!(Array.isArray(prevalence?.prevalence) && prevalence.prevalence.length > 0)) {
          issues.push('heavy run but prevalence.json missing or malformed (no declared heavyEvidence to check against)');
        }
      }
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
    ['upstream Rapier ref (requested)', prov?.requestedUpstreamRef ?? prov?.upstreamRef],
    ['upstream Rapier SHA (resolved)', prov?.resolvedUpstreamSha],
    ['candidate identity suffix', prov?.identitySuffix],
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

  // Borrow-error scan (computed once per arm; reused by the forensic-matrix
  // OBSERVE report below).
  const armScan = Object.fromEntries(ARMS.map((a) => [a, borrowErrorScan(armReports[a].dir)]));
  push('## `world.free()` borrow/panic scan');
  for (const arm of ARMS) {
    const scan = armScan[arm];
    push(`- **${arm}:** scanned ${scan.scanned} log(s); ${scan.matches.length} borrow/ownership/unreachable/panic match(es)`
      + (scan.matches.length ? `:\n  - ${scan.matches.slice(0, 10).join('\n  - ')}` : '.'));
    manifest.findings[`borrow_${arm}`] = scan;
  }
  push('');

  // Forensic witness matrix (`--witness all --pass all`): a GATE on stable
  // (must complete cleanly), OBSERVE on the candidate (its crash IS Outcome-B
  // evidence — core 0.34 cannot complete the matrix — not a defect to gate on).
  // Citability rests on the reproducer + prevalence, both green on the
  // candidate; this section records the asymmetry as first-class evidence.
  push('## Forensic witness matrix (`--witness all --pass all`) — stable GATE / candidate OBSERVE');
  push('');
  for (const arm of ARMS) {
    const wexit = armReports[arm].armManifest?.exits?.witnesses ?? null;
    const completed = wexit === 0;
    const witnessCrash = (armScan[arm].matches.find((m) => m.startsWith('witnesses.log:')) ?? null);
    const sig = witnessCrash === null ? null : witnessCrash.replace(/^witnesses\.log:\s*/, '');
    push(`- **${arm}:** witnesses exit ${wexit ?? '?'} — `
      + (completed
        ? 'completed the full forensic matrix cleanly.'
        : `**CRASHED**${sig === null ? '' : ` — \`${sig}\``} (recorded Outcome-B evidence; not gated on the candidate).`));
    manifest.findings[`witnessMatrix_${arm}`] = { exit: wexit, completed, crashSignature: sig };
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

  // Verdict (classification level). Three distinct states, never conflated:
  //   INCONCLUSIVE   — a missing/failed arm or an absent/malformed classification
  //                    (undefined===undefined must NOT read as "SAME class").
  //   CONTRADICTS    — the experiment ran cleanly but the impulse reproducer is
  //                    NOT catastrophic on BOTH arms (candidate quiescent =>
  //                    the divergence was FIXED on core 0.34; stable quiescent
  //                    => the control/harness is broken). Either way the run
  //                    does NOT reproduce Outcome B and must exit nonzero.
  //   REPRODUCED     — catastrophic on both; heavy=true => citable for C5.
  const bothUsable = ARMS.every((a) => armReports[a].usable);
  const cStable = repro.stable?.original?.classification ?? null;
  const cCand = repro.candidate?.original?.classification ?? null;
  const mStable = repro.stable?.multibody?.classification ?? null;
  const mCand = repro.candidate?.multibody?.classification ?? null;
  const canJudge = bothUsable && cStable !== null && cCand !== null;
  const impulseSame = canJudge ? (cStable === cCand) : null;
  // Outcome B = the impulse reproducer diverges (catastrophic) on BOTH the
  // stable control and the candidate. "Experiment executed" (canJudge) is NOT
  // "Outcome B reproduced": a DIFFERENT classification (candidate quiescent)
  // is a scientific contradiction that must fail the gate, not a green run.
  const outcomeBReproduced = canJudge && cStable === 'catastrophic' && cCand === 'catastrophic';
  const isHeavy = ARMS.every((a) => armReports[a].armManifest?.heavy === true);
  // Citable in the decision record (C5) ONLY when Outcome B reproduced on a
  // full heavy=true run AND the browser inventory has been finalized
  // (bootstrapComplete). The FIRST heavy run is the bootstrap run: it is
  // structurally non-citable, whatever it shows, because an unrelated browser
  // regression cannot yet be caught (null browser counts / no signatures).
  const citable = outcomeBReproduced && isHeavy && bootstrapComplete;
  push('## Verdict (classification level)');
  if (!canJudge) {
    push(`- reproducer (impulse): stable **${cStable ?? '?'}**, candidate **${cCand ?? '?'}** `
      + '→ **INCONCLUSIVE — verdict NOT established** (a missing/failed arm or absent/malformed classification; NOT "Outcome B holds")');
  } else if (!outcomeBReproduced) {
    const detail = impulseSame
      ? 'SAME class but QUIESCENT — the stable control did not diverge, so the harness/reproducer is broken (stable 0.19.3 is known catastrophic)'
      : 'DIFFERENT — the classification changed (the candidate may have FIXED the divergence on core 0.34); re-examine';
    push(`- reproducer (impulse): stable **${cStable}**, candidate **${cCand}** `
      + `→ **CONTRADICTS Outcome B — ${detail}.** `
      + 'The controlled run executed but did NOT reproduce catastrophic-on-both; this run is NOT citable and the '
      + 'compare job fails so the result cannot be silently folded in as Outcome-B evidence.');
  } else {
    let note = '';
    if (!citable) {
      const why = !isHeavy ? 'heavy=false debug run'
        : (!bootstrapComplete ? 'BOOTSTRAP run — browser inventory not yet finalized (bootstrapComplete=false); commit the browser counts/signatures from this run, flip the flag, and re-dispatch'
          : 'not citable');
      note = ` _(PROVISIONAL — ${why}; NOT citable for C5)_`;
    }
    push(`- reproducer (impulse): stable **${cStable}**, candidate **${cCand}** → SAME class (Outcome B reproduced)${note}`);
  }
  push(`- reproducer (multibody): stable **${mStable ?? '?'}**, candidate **${mCand ?? '?'}** `
    + '_(OBSERVATIONAL — the multibody quiescence is the representation-lever finding, NOT part of the '
    + 'Outcome-B gate; it does not affect established/citable)_');
  manifest.verdict = {
    established: canJudge,
    multibodyIsGating: false,
    outcomeBReproduced,
    citable,
    bootstrapComplete,
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
  // Nonzero unless the controlled pair REPRODUCED Outcome B (catastrophic on
  // both), so a green compare job cannot mean "inconclusive" OR "the candidate
  // fixed the divergence" — only "controlled pair complete + Outcome B held".
  // comparison.md/manifest are already written above — the if:always upload
  // preserves the evidence either way.
  if (!canJudge) {
    console.error('\nCOMPARISON INCONCLUSIVE — verdict NOT established. Arm issues: '
      + `${JSON.stringify(Object.fromEntries(ARMS.map((a) => [a, armReports[a].issues])))}`);
    return { ok: false, manifest };
  }
  if (!outcomeBReproduced) {
    console.error(`\nCONTROLLED RESULT CONTRADICTS Outcome B — stable ${cStable}, candidate ${cCand} `
      + '(expected catastrophic on both). The experiment executed; the scientific conclusion changed. '
      + 'Failing the compare job so this is reviewed, not folded in as Outcome-B evidence.');
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
    result = compare({ artifacts: values.artifacts, out: values.out, expectedPath: values.expected });
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
  passedCountsBySubstring, relTestKey, reproducerSummary, borrowErrorScan, F32_DT,
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
