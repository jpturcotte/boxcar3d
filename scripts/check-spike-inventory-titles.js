// check-spike-inventory-titles.js — DERIVED anti-drift gate for the spike
// expected-red inventory (.github/spike-expected-candidate-reds.json).
// Node-only, outside the src/sim ESLint ban; no engine, no wall-clock
// dependence in its logic.
//
// WHY THIS EXISTS (the PR #29 post-merge defect):
//   The spike adjudicator (compare-spike-runs.js --mode classify) pins
//   expected candidate failures by (file, assertion title substring,
//   message regex, exact count) plus positive must-pass title presence.
//   Those titles are DUPLICATED knowledge: they live in the real test
//   sources AND in the inventory. PR #29 renamed the independent-artifact
//   interop tests (Kimi v2 -> assembled v3) and changed their custom
//   failure message, but the inventory and the compare-spike-runs SYNTHETIC
//   fixtures kept the old titles — ordinary CI stayed green because the
//   synthetic reports agree with the inventory by construction, so nothing
//   compared the inventory against the REAL collected tests. A future
//   heavy=true engine-spike dispatch would then misclassify legitimate
//   engine-version lock movement as a project-contract regression.
//
// WHAT THIS CHECKS (derived, never a second hand-maintained title list):
//   It collects the REAL test titles via `vitest list --json` under BOTH
//   configs (vite.config.js = Node arm, vitest.browser.config.js = Chromium
//   arm) and audits every pinned title in the inventory against that
//   discovery:
//     node/browser.byFile[file]:
//       (1) the file collects >=1 test (a renamed/removed file is its own
//           diagnostic);
//       (2) every allowedFailureSignatures[].titleSubstring matches at
//           least one collected test IN THAT FILE;
//       (3) the in-file match multiplicity EQUALS the declared count
//           (a test split/merge changes the multiplicity at constant
//           title, e.g. the PR #28 one-test->two-tests interop split);
//     (4) every mustPassPresent[].titleSubstring matches arm-wide at
//         exactly passedCount (absence-of-failure cannot distinguish
//         passed from renamed/skipped — same rationale as schema /2);
//     (5) every mustPassAssertionSubstrings[] entry matches >=1 test;
//     (6) no collected test matches BOTH an allowed failure signature
//         and a must-pass title (the adjudicator cannot both allow and
//         forbid its failure);
//     (7) within each must-pass list, no two distinct substrings match
//         the same collected test (counts must stay attributable);
//     (8) within a byFile entry, no collected test matches TWO allowed
//         failure signatures — classify() assigns a failure to the FIRST
//         matching signature only, so an overlap lets both multiplicity
//         checks pass while a real candidate report can red just one of
//         them; the other would surface only at candidate adjudication,
//         the delayed discovery this gate exists to prevent.
//   Any issue exits 1 and names the arm, file, substring, expected vs
//   observed multiplicity, and the remediation: update the inventory in
//   the SAME commit as the test rename/restructure.
//
// EXECUTION MODEL:
//   Vitest is resolved from THIS checkout's node_modules via
//   createRequire(import.meta.url).resolve('vitest/vitest.mjs') and spawned
//   with process.execPath — the repo-pinned 3.2.7, never bare `npx` (which
//   may download a different version). The pure audit core
//   (auditInventoryTitles) is exported for the vitest unit suite, which
//   never spawns anything; the CLI runs only as the entrypoint (the
//   bench-physics guard idiom). Wired into ordinary CI as
//   `npm run check:spike-inventory` so the drift class cannot survive a
//   PR that renames tests without the inventory.
//
//   THE BROWSER ARM NEEDS THE BROWSER: browser-mode collection EXECUTES the
//   test files inside Chromium to enumerate the describe/test tree, so
//   `vitest list` under vitest.browser.config.js launches the pinned
//   headless Chromium (the Node arm needs no browser). With the binary
//   absent, vitest 3.2.7 prints "There were unhandled errors during test
//   collection" + the playwright install hint to STDERR and exits 0 with
//   EMPTY stdout — collectTasks treats empty stdout as a collection
//   failure and surfaces that stderr, never auditing partial data. The CI
//   gate therefore lives in the browser-determinism job, which already
//   installs the exact-pinned Chromium (the first version of this gate ran
//   in the browserless test job and failed closed on exactly this).

/* eslint no-console: 0 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { relTestKey } from './compare-spike-runs.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const REMEDIATION = 'update .github/spike-expected-candidate-reds.json in the same commit as the test rename/restructure';

// Parse `vitest list --json` stdout into normalized tasks
// { name, fileKey }. STRICT: a malformed report (truncated JSON, missing
// name/file, non-array top level) throws — a collection that cannot be
// parsed must fail the gate loudly, never audit against partial data.
// vitest 3.2.7 emits a pure JSON array of
// { "name": "describe > … > test", "file": "<abs path, either separator>",
//   "projectName": "chromium" (browser config only) }.
function parseVitestListJson(stdout, label) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`vitest list --json (${label}) produced malformed JSON: ${err?.message ?? err}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`vitest list --json (${label}) produced a non-array top level — expected the 3.2.7 pure JSON array`);
  }
  return parsed.map((item, i) => {
    if (typeof item?.name !== 'string' || typeof item?.file !== 'string') {
      throw new Error(`vitest list --json (${label}) entry ${i} lacks a string name/file — the 3.2.7 list shape changed; update this parser and the inventory audit together`);
    }
    return { name: item.name, fileKey: relTestKey(item.file) };
  });
}

// The pure audit core: inventory object + per-arm normalized task lists ->
// human-readable issue strings (empty = aligned). No I/O, no spawning.
function auditInventoryTitles(inventory, { nodeTasks, browserTasks }) {
  return [
    ...auditArm('node', inventory?.node ?? {}, nodeTasks),
    ...auditArm('browser', inventory?.browser ?? {}, browserTasks),
  ];
}

function auditArm(arm, armInv, tasks) {
  const issues = [];
  const byFile = armInv.byFile ?? {};
  const tasksByFile = new Map();
  for (const t of tasks) {
    if (!tasksByFile.has(t.fileKey)) tasksByFile.set(t.fileKey, []);
    tasksByFile.get(t.fileKey).push(t);
  }

  // (1)-(3): per-file failure-signature presence + exact multiplicity.
  const failureMatches = []; // { sig, file, name } for rule (6)
  for (const [file, entry] of Object.entries(byFile)) {
    const fileTasks = tasksByFile.get(file) ?? [];
    if (fileTasks.length === 0) {
      issues.push(`[${arm}] byFile entry '${file}' collects ZERO tests under the live config — the file was renamed/removed or the config include changed; ${REMEDIATION}`);
      continue;
    }
    for (const sig of entry.allowedFailureSignatures ?? []) {
      const matches = fileTasks.filter((t) => t.name.includes(sig.titleSubstring));
      if (matches.length === 0) {
        issues.push(`[${arm}] ${file}: allowed failure signature '${sig.titleSubstring}' matches NO collected test (declared count ${sig.count}) — the test was renamed or restructured; ${REMEDIATION}`);
      } else if (matches.length !== sig.count) {
        issues.push(`[${arm}] ${file}: allowed failure signature '${sig.titleSubstring}' matches ${matches.length} collected test(s) but declares count ${sig.count} — a test split/merge changed the multiplicity; ${REMEDIATION}`);
      }
      for (const m of matches) failureMatches.push({ sig: sig.titleSubstring, file, name: m.name });
    }
    // (8): allowed-red substrings in one file must be mutually exclusive.
    // classify() consumes a failure with the FIRST matching signature, so a
    // test matching TWO signatures satisfies both multiplicity checks while
    // only one can ever red — the second fails only at candidate
    // adjudication, the delayed discovery this gate exists to prevent.
    for (const t of fileTasks) {
      const hits = (entry.allowedFailureSignatures ?? []).filter((s) => t.name.includes(s.titleSubstring));
      if (hits.length > 1) {
        issues.push(`[${arm}] ${file}: collected test '${t.name}' matches ${hits.length} allowed failure signatures (${hits.map((h) => `'${h.titleSubstring}'`).join(', ')}) — the adjudicator assigns a failure to the FIRST matching signature only, so the other can never red at the declared count; use non-overlapping substrings`);
      }
    }
  }

  const mustPassPresent = armInv.mustPassPresent ?? [];
  const mustPassAssertionSubs = armInv.mustPassAssertionSubstrings ?? [];

  // (4): positive presence at exact arm-wide multiplicity.
  for (const p of mustPassPresent) {
    const matches = tasks.filter((t) => t.name.includes(p.titleSubstring));
    if (matches.length !== p.passedCount) {
      issues.push(`[${arm}] mustPassPresent '${p.titleSubstring}' matches ${matches.length} collected test(s) but declares passedCount ${p.passedCount} — the positive-presence pin drifted; ${REMEDIATION}`);
    }
  }

  // (5): absence-of-failure titles must still name a real test.
  for (const sub of mustPassAssertionSubs) {
    if (!tasks.some((t) => t.name.includes(sub))) {
      issues.push(`[${arm}] mustPassAssertionSubstrings entry '${sub}' matches NO collected test — a renamed test would silently drop this green-teeth pin; ${REMEDIATION}`);
    }
  }

  // (6): a test may not be both an allowed red and a must-pass green.
  const mustPassSubs = [...mustPassAssertionSubs, ...mustPassPresent.map((p) => p.titleSubstring)];
  for (const { sig, file, name } of failureMatches) {
    for (const mp of mustPassSubs) {
      if (name.includes(mp)) {
        issues.push(`[${arm}] test '${name}' in ${file} matches BOTH allowed failure signature '${sig}' and must-pass title '${mp}' — the adjudicator cannot both allow and forbid its failure; disambiguate the inventory`);
      }
    }
  }

  // (7): within one must-pass list, two distinct substrings naming the same
  // test make its count unattributable.
  ambiguousMustPassPairs(arm, mustPassAssertionSubs, 'mustPassAssertionSubstrings', tasks, issues);
  ambiguousMustPassPairs(arm, mustPassPresent.map((p) => p.titleSubstring), 'mustPassPresent', tasks, issues);

  return issues;
}

function ambiguousMustPassPairs(arm, subs, listName, tasks, issues) {
  for (let i = 0; i < subs.length; i += 1) {
    for (let j = i + 1; j < subs.length; j += 1) {
      const both = tasks.find((t) => t.name.includes(subs[i]) && t.name.includes(subs[j]));
      if (both !== undefined) {
        issues.push(`[${arm}] ${listName} substrings '${subs[i]}' and '${subs[j]}' both match collected test '${both.name}' — counts are unattributable; use longer, non-overlapping substrings`);
      }
    }
  }
}

// Spawn the checkout-pinned vitest in LIST mode under one config. Never
// bare `npx`: resolution is createRequire(...).resolve from THIS file's
// node_modules, executed by the running node — no download path exists.
function collectTasks(configArgs, label) {
  const require = createRequire(import.meta.url);
  const vitestEntry = require.resolve('vitest/vitest.mjs');
  const res = spawnSync(
    process.execPath,
    [vitestEntry, 'list', '--json', ...configArgs],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) throw new Error(`failed to spawn pinned vitest (${label}): ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`vitest list --json (${label}) exited ${res.status}:\n${res.stderr}\n${res.stdout}`);
  }
  if (res.stdout.trim() === '') {
    // vitest 3.2.7 browser-mode collection with the Chromium binary missing
    // exits 0 with EMPTY stdout and the real error on stderr ("There were
    // unhandled errors during test collection" + the playwright install
    // hint). Surface THAT, never parse nothing into an empty arm.
    throw new Error(`vitest list --json (${label}) produced NO output on stdout — browser-mode collection launches the pinned Chromium; install it (\`npx playwright install chromium\`) or run where CI provides it. stderr:\n${res.stderr}`);
  }
  try {
    return parseVitestListJson(res.stdout, label);
  } catch (err) {
    // A parse failure must show what vitest ACTUALLY said — the bare JSON
    // error hides the cause (the first CI run's "Unexpected end of JSON
    // input" was the missing-browser stderr above).
    throw new Error(`${err?.message ?? err}\nstderr:\n${res.stderr}\nstdout (first 400 chars):\n${res.stdout.slice(0, 400)}`);
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      expected: { type: 'string', default: '.github/spike-expected-candidate-reds.json' },
    },
  });
  const inventory = JSON.parse(readFileSync(resolve(REPO_ROOT, values.expected), 'utf8'));
  // Node arm = vite.config.js (tests/** minus tests/browser/**) — no
  // browser needed. Chromium arm = vitest.browser.config.js
  // (tests/browser/** only): browser-mode collection EXECUTES the test
  // files inside the pinned headless Chromium to enumerate the tree, so
  // this arm requires the browser binary (CI: the browser-determinism
  // job's playwright install).
  const nodeTasks = collectTasks([], 'node');
  const browserTasks = collectTasks(['--config', 'vitest.browser.config.js'], 'browser');
  const issues = auditInventoryTitles(inventory, { nodeTasks, browserTasks });
  if (issues.length > 0) {
    console.error(`spike-inventory title drift: ${issues.length} issue(s) — the expected-red inventory no longer matches the real collected tests:`);
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log(`spike-inventory OK — every pinned title resolves against live vitest collection (node: ${nodeTasks.length} tests, browser: ${browserTasks.length} tests)`);
}

export { auditInventoryTitles, parseVitestListJson };

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
