// App-scene boot smoke — a standalone Playwright instrument (Node-only, outside
// the src/sim ESLint ban). It answers one question: does the PRODUCTION Vite
// bundle boot the composite corridor scene in a real Chromium, or does it throw?
// It is the matrix job's step-6 GATE for the core-0.34 spike experiment
// (.github/workflows/rapier-034-spike-experiment.yml) and reusable for any
// engine swap.
//
// DETERMINISTIC BASE (amendment 9): build, `vite preview`, and this smoke all
// run under the SAME `GITHUB_REPOSITORY` env, so the Vite `base` is identical
// across all three. In CI that base is `/<repo>/` (e.g. `/boxcar3d/`); locally
// (unset) it is `/`. We spawn `vite preview` (which inherits the env, so it
// serves at that base), parse the ACTUAL served URL from its stdout, assert its
// path matches the base we derived from `GITHUB_REPOSITORY`, and navigate there.
//
// DETECTION: the WASM is inlined (base64), so there is no `.wasm` request to
// 404 on — boot success/failure is observed through the page instead:
//   - success: `#app canvas` exists AND `#hud` contains `corridor` + `fixed
//     steps:` (src/main.js's ready HUD), and `#hud` is NOT `boot failed:`.
//   - failure: any `pageerror`, any console `error`, any `requestfailed`
//     (favicon excepted), a `boot failed:` HUD, or a readiness timeout.
//
// Uses the `playwright` package directly (the pinned 1.61.1), NOT
// `@playwright/test`. The chromium binary must be installed
// (`npx playwright install chromium`).
//
// USAGE:  node scripts/probe-app-scene-smoke.js   (after `npm run build`)

/* eslint no-console: 0 */

import { spawn } from 'node:child_process';
import { setTimeout as setTimer, clearTimeout as clearTimer } from 'node:timers';
import { URL } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4173;
const PREVIEW_READY_TIMEOUT_MS = 60000;
const PAGE_READY_TIMEOUT_MS = 60000;
const OVERALL_GUARD_MS = 150000;
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const repo = process.env.GITHUB_REPOSITORY; // "owner/boxcar3d" in CI, unset locally
const base = repo ? `/${repo.split('/')[1]}/` : '/';

// Spawn `vite preview` and resolve with { proc, url } when its "Local:" line
// appears, or reject on timeout / early exit. The preview inherits our env, so
// GITHUB_REPOSITORY drives its base to match `base` above.
function startPreview() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      npmCmd,
      ['run', 'preview', '--', '--port', String(PORT), '--strictPort'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`vite preview did not become ready in ${PREVIEW_READY_TIMEOUT_MS} ms.\n${out}`));
    }, PREVIEW_READY_TIMEOUT_MS);
    const onData = (buf) => {
      out += buf.toString();
      const m = /Local:\s*(http:\/\/\S+)/i.exec(out);
      if (m !== null && !settled) {
        settled = true;
        clearTimer(timer);
        resolve({ proc, url: m[1] });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      reject(new Error(`vite preview exited early (code ${code}) before becoming ready.\n${out}`));
    });
  });
}

async function main() {
  const errors = [];
  let preview = null;
  let browser = null;
  // Hard overall guard: never hang a CI job on a stuck preview/browser.
  const guard = setTimer(() => {
    console.error(`\nApp-scene smoke exceeded the ${OVERALL_GUARD_MS} ms guard — forcing exit 1.`);
    process.exit(1);
  }, OVERALL_GUARD_MS);
  guard.unref();

  try {
    console.log(`GITHUB_REPOSITORY=${repo ?? '(unset)'} -> Vite base ${base}`);
    preview = await startPreview();
    // The served URL vite printed is authoritative; assert its path matches the
    // base we independently derived (they must agree, or build/preview/smoke
    // disagree on base — a real defect, not a smoke pass).
    const servedPath = new URL(preview.url).pathname;
    const expectPath = base === '/' ? '/' : base;
    if (!servedPath.startsWith(expectPath)) {
      throw new Error(`preview serves ${servedPath} but the derived base is ${expectPath} `
        + '(build/preview/smoke env disagree on base)');
    }
    const navUrl = `http://localhost:${PORT}${base}`;
    console.log(`preview ready at ${preview.url}; navigating to ${navUrl}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    page.on('requestfailed', (req) => {
      if (req.url().endsWith('/favicon.ico')) return; // benign, not part of the app
      const failure = req.failure();
      errors.push(`requestfailed: ${req.url()} ${failure ? failure.errorText : ''}`);
    });

    await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_READY_TIMEOUT_MS });

    // Wait for the ready HUD; throw fast (rejecting waitForFunction) on boot
    // failure so we don't burn the full timeout on a known-dead page.
    // waitForFunction's signature is (pageFunction, ARG, options) — the second
    // parameter is the page-function argument, so the options object must be
    // THIRD (with an explicit undefined arg) or the timeout/polling are
    // silently ignored.
    await page.waitForFunction(
      () => {
        const hud = document.querySelector('#hud');
        const canvas = document.querySelector('#app canvas');
        const text = hud ? hud.textContent : '';
        if (text.startsWith('boot failed:')) throw new Error(`HUD boot failure: ${text}`);
        return Boolean(canvas) && text.includes('corridor') && text.includes('fixed steps:');
      },
      undefined,
      { timeout: PAGE_READY_TIMEOUT_MS, polling: 250 },
    );

    const hudText = await page.$eval('#hud', (el) => el.textContent);
    console.log(`  OK   #app canvas present; HUD ready: ${JSON.stringify(hudText)}`);

    if (errors.length > 0) {
      throw new Error(`page/console/network errors during boot:\n  - ${errors.join('\n  - ')}`);
    }
    console.log('\nAPP-SCENE SMOKE OK — production bundle boots the corridor scene in Chromium.');
  } catch (err) {
    console.error(`\nAPP-SCENE SMOKE FAIL — ${err.message}`);
    if (errors.length > 0) console.error(`  captured: ${errors.join('; ')}`);
    process.exitCode = 1;
  } finally {
    clearTimer(guard);
    if (browser !== null) {
      try { await browser.close(); } catch { /* teardown best-effort */ }
    }
    if (preview !== null) {
      try { preview.proc.kill(); } catch { /* teardown best-effort */ }
    }
  }
}

await main();
