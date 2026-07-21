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
import { URL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4173;
const PREVIEW_READY_TIMEOUT_MS = 60000;
const PAGE_READY_TIMEOUT_MS = 60000;
const OVERALL_GUARD_MS = 150000;
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// CSI SGR (colour) escape matcher, built from a string so the source has no
// literal ESC control char (eslint no-control-regex stays happy).
const ANSI_ESCAPE = new RegExp('\\x1b\\[[0-9;]*m', 'g');

// Kill the preview's whole process GROUP (negative pid), so the `vite preview`
// grandchild dies with npm instead of orphaning and holding the captured
// stdout pipe open. Best-effort; the process may already be gone.
function killTree(proc) {
  if (proc === null || proc === undefined || proc.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL');
    else proc.kill();
  } catch { /* already exited */ }
}

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
      // `detached` puts npm AND its `vite preview` grandchild in a fresh
      // process GROUP, so teardown can kill the whole tree (killPreview). A
      // plain proc.kill() reaps only npm and orphans vite, which then holds a
      // captured stdout pipe open and hangs the CI step indefinitely.
      // NO_COLOR/FORCE_COLOR=0: vite colours its "Local:" banner even when
      // piped in CI (measured), and the ANSI escapes broke the URL regex.
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        // Node 20+ refuses to spawn a `.cmd`/`.bat` (npm.cmd) without a shell —
        // EINVAL otherwise, on the project's own Windows dev platform (F8).
        shell: process.platform === 'win32',
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      },
    );
    let out = '';
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      killTree(proc);
      reject(new Error(`vite preview did not become ready in ${PREVIEW_READY_TIMEOUT_MS} ms.\n${out}`));
    }, PREVIEW_READY_TIMEOUT_MS);
    const onData = (buf) => {
      out += buf.toString();
      // Strip ANSI colour escapes before matching (belt-and-suspenders with
      // NO_COLOR above): the escapes appear BETWEEN "Local" and ":" and inside
      // the URL, so a raw match fails. Built from a string so the regex source
      // carries no literal control char (no-control-regex clean).
      const clean = out.replace(ANSI_ESCAPE, '');
      const m = /Local:\s*(http:\/\/\S+)/i.exec(clean);
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

    // Software WebGL: the corridor scene is Three.js, and headless Chromium
    // gates GPU/WebGL behind SwiftShader flags — without them the canvas never
    // initialises and the ready HUD never appears. (The determinism browser
    // tests pass without this because they run Rapier wasm, not WebGL.)
    browser = await chromium.launch({
      headless: true,
      args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    });
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
      try { killTree(preview.proc); } catch { /* teardown best-effort */ }
    }
  }
}

// Run ONLY when invoked directly (node scripts/probe-app-scene-smoke.js), never
// on import (F8): importing this module — e.g. from a schema test — used to boot
// Chromium and spawn `vite preview` as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
