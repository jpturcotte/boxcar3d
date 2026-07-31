// PR 4D — THE BROWSER MEASURED-ROW PAGE MODULE.
//
// PROOF ROLE, stated up front: this module is the browser leg of the PR-4D
// scale benchmark. It measures the landed PR-4C persisted-history verifier —
// the `extractHistoryObservations` seam — inside the pinned Chromium, over
// PREBUILT artifacts fetched over HTTP, and hands the driver
// (scripts/bench-evolution-verification-browser.js) one JSON-safe row per
// measured sample. It owns the in-page wall-clock interval, the event-loop
// heartbeat evidence, and the page-side byte-identity tooth. It is a
// measurement harness, never an oracle: verification itself lives in
// scripts/history-observations.js and the production gates it shares.
//
// THE NEVER-BUILD RULE. A measured page must NEVER construct an artifact.
// In-page construction warms exactly the JIT/GC/wasm state the measurement is
// meant to observe cold-ish per sample, blocks the page before the heartbeat
// is primed (poisoning the event-loop evidence), and breaks the Node-vs-page
// byte-identity claim the driver asserts (the driver builds Node-side, writes
// tmp files, serves the bytes, and pins length + SHA-256; the page proves it
// received THOSE bytes before any measured interval). This module therefore
// imports NO builder — not bench-evolution-verification-artifacts.js, not the
// corpus module — and fetches every artifact it measures. (The ONE allowed
// in-page build is the CI smoke test's own liveness fixture, which is a test,
// not a measured row.)
//
// THE PRIMED/DRAINED CONTRACT. The event-loop instrument is a rAF channel and
// a 4 ms timer channel, both recording timestamps from BEFORE t0 until AFTER
// t1. PRIMED means each channel holds >= 2 timestamps before t0 exists;
// DRAINED means each channel records a timestamp after t1. Both are load-
// bearing: monitor nothing before the block and a synchronous operation's gap
// has no earlier timestamp to be measured against; stop at t1 and the delayed
// post-block timestamps are never recorded. Deleting either wait must fail the
// harness self-test (the browser leg of deliberate defects 8/9 — the smoke
// test's busy-block assertion is that tooth). Neither wait may hang the page:
// both carry a 10 s guard and report primed/drained: false on starvation.
//
// MEMORY LIMITATIONS. performance.memory is deprecated, Chromium-only, and
// rounded; a before/after pair is not a peak and says nothing about the
// mid-operation high-water mark inside a synchronous verifier. The row
// reports it labeled as exactly that; the driver's CDP polling carries the
// same limitation in the other direction. Neither is a process memory
// measure.
//
// WALL CLOCK IS ALLOWED HERE. This module is benchmark instrumentation,
// outside src/sim and its D7/F3 bans; performance.now() is the measurement
// quantity itself. Nothing here is simulation time.

import { sha256 } from '../../src/platform/sha256.js';
import { bytesToHex } from '../../src/sim/bytes.js';
import { extractHistoryObservations } from '../history-observations.js';

const HEARTBEAT_TICK_MS = 4;
const HEARTBEAT_TIMEOUT_MS = 10000;
const HEARTBEAT_METHOD = 'page rAF + 4 ms timer heartbeats, primed >= 2 pre-op timestamps before t0 and drained post-op timestamps after t1';
const MEMORY_METHOD = 'in-page performance.memory before/after (deprecated, Chromium-only, may over/under-estimate; NOT a peak)';

/**
 * A known synchronous busy block (+ optional touched allocation) for the
 * harness self-tests — the browser twin of the Node instrument's busyBlock,
 * kept line-for-line in step so "the heartbeat sees the block" means the same
 * thing in both environments. Returns the buffer (null when allocateBytes is
 * 0); the CALLER holds it across any post measurement so the allocation is
 * not collected early.
 */
export function busyBlock(blockMs, allocateBytes = 0) {
  let buffer = null;
  if (allocateBytes > 0) {
    buffer = new Uint8Array(allocateBytes);
    for (let i = 0; i < buffer.length; i += 4096) buffer[i] = 1;
  }
  const end = performance.now() + blockMs;
  while (performance.now() < end) { /* synchronous by construction */ }
  return buffer; // caller holds it across any post measurement
}

// Bounded condition wait on the timer channel: resolves true when predicate()
// holds, false at the deadline. The contract is NEVER HANG — a starved
// heartbeat (background tab, throttled rAF) is a failed measurement reported
// as primed/drained: false, not a stuck page.
async function waitForCondition(predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => { globalThis.setTimeout(resolve, HEARTBEAT_TICK_MS); });
  }
  return true;
}

function sampleMemory() {
  const memory = performance.memory;
  if (memory === undefined || memory === null) return null;
  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  };
}

function memoryReport(before, after) {
  if (before === null || after === null) return 'unavailable';
  return {
    method: MEMORY_METHOD,
    usedJSHeapSizeBefore: before.usedJSHeapSize,
    usedJSHeapSizeAfter: after.usedJSHeapSize,
    totalJSHeapSize: after.totalJSHeapSize,
    jsHeapSizeLimit: after.jsHeapSizeLimit,
  };
}

/**
 * Measure ONE operation with the heartbeat PRIMED before t0 and DRAINED after
 * t1 (the module header carries the contract). Returns
 * { elapsedMs, outcome, frameGap, memory } where outcome is { value } or
 * { error } — an operation failure is data (refusal rows exist), never a
 * harness crash. frameGap.maxGapMs is the maximum gap between consecutive
 * timestamps on either channel across the whole recording; gapsOver50ms
 * counts gaps above 50 ms on both channels. On prime starvation the returned
 * row carries primed: false and no elapsed interval; on drain starvation the
 * interval stands but drained: false marks the evidence incomplete. The
 * driver refuses both shapes — a hang is the one outcome this never produces.
 */
export async function measureWithHeartbeat(operation) {
  const frames = []; // rAF timestamps (performance.now() clock)
  const ticks = []; // 4 ms timer timestamps (same clock)
  let running = true;
  const frameLoop = (timestamp) => {
    if (!running) return;
    frames.push(timestamp);
    requestAnimationFrame(frameLoop);
  };
  const tickLoop = () => {
    if (!running) return;
    ticks.push(performance.now());
    globalThis.setTimeout(tickLoop, HEARTBEAT_TICK_MS);
  };
  requestAnimationFrame(frameLoop);
  globalThis.setTimeout(tickLoop, HEARTBEAT_TICK_MS);

  // PRIMED: both channels must hold >= 2 pre-op timestamps before t0 exists.
  const primed = await waitForCondition(
    () => frames.length >= 2 && ticks.length >= 2,
    HEARTBEAT_TIMEOUT_MS,
  );
  if (!primed) {
    running = false;
    return {
      elapsedMs: null,
      outcome: {
        error: new Error('measureWithHeartbeat: heartbeat failed to prime within 10 s (rAF/timer starvation) — the row is invalid, not slow'),
      },
      frameGap: Object.freeze({
        method: HEARTBEAT_METHOD,
        primed: false,
        drained: false,
        maxGapMs: null,
        gapsOver50ms: null,
        frameCount: frames.length,
        tickCount: ticks.length,
      }),
      memory: memoryReport(sampleMemory(), sampleMemory()),
    };
  }

  const memoryBefore = sampleMemory();
  const t0 = performance.now();
  let outcome;
  try {
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  }
  const t1 = performance.now();

  // DRAINED: both channels must record a timestamp AFTER t1 — without it the
  // operation's last blocked interval never appears in either recording.
  const drained = await waitForCondition(
    () => frames[frames.length - 1] > t1 && ticks[ticks.length - 1] > t1,
    HEARTBEAT_TIMEOUT_MS,
  );
  running = false;
  const memoryAfter = sampleMemory();

  let maxGapMs = 0;
  let gapsOver50ms = 0;
  for (const channel of [frames, ticks]) {
    for (let i = 1; i < channel.length; i += 1) {
      const gap = channel[i] - channel[i - 1];
      if (gap > maxGapMs) maxGapMs = gap;
      if (gap > 50) gapsOver50ms += 1;
    }
  }
  return {
    elapsedMs: t1 - t0,
    outcome,
    frameGap: Object.freeze({
      method: HEARTBEAT_METHOD,
      primed: true,
      drained,
      maxGapMs,
      gapsOver50ms,
      frameCount: frames.length,
      tickCount: ticks.length,
    }),
    memory: memoryReport(memoryBefore, memoryAfter),
  };
}

/**
 * Run ONE measured extraction row over a PREBUILT artifact:
 *   1. fetch the bytes (UNTIMED — transport is never the measured interval);
 *   2. THE BYTE-IDENTITY TOOTH: the received length and SHA-256 must equal
 *      the driver's, or the page would be measuring an artifact the driver
 *      did not build — a loud throw, never a quiet row;
 *   3. one heartbeat-measured extractHistoryObservations pass.
 * The returned object is JSON-safe (the driver reads it over
 * page.evaluate): a refusal outcome is reported as a verdict, matching the
 * Node instrument's taxonomy; a success carries the history digest the
 * report backfills into the artifact entry.
 */
export async function runBrowserExtractionRow({
  artifactUrl, expectedByteLength, expectedSha256Hex, rowId,
}) {
  const response = await globalThis.fetch(artifactUrl);
  if (!response.ok) {
    throw new Error(`browser-bench page: artifact fetch for row '${rowId}' returned HTTP ${response.status} — the driver's artifact middleware is not serving`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== expectedByteLength) {
    throw new Error(`browser-bench page: byte-length mismatch for row '${rowId}' — page received ${bytes.length}, driver built ${expectedByteLength}`);
  }
  const sha256Hex = bytesToHex(await sha256(bytes));
  if (sha256Hex !== expectedSha256Hex) {
    throw new Error(`browser-bench page: SHA-256 mismatch for row '${rowId}' — the page is not measuring the artifact the driver built`);
  }
  const measured = await measureWithHeartbeat(() => extractHistoryObservations(bytes));
  const pageSaw = Object.freeze({ byteLength: bytes.length, sha256Hex });
  if (measured.outcome.error) {
    const err = measured.outcome.error;
    return {
      rowId,
      verdict: Object.freeze({
        refused: err && typeof err.code === 'string' ? err.code : 'unknown',
        rule: err && err.context && typeof err.context.rule === 'string' ? err.context.rule : null,
        sourceGenerationIndex: err && err.context && Number.isInteger(err.context.sourceGenerationIndex)
          ? err.context.sourceGenerationIndex : null,
      }),
      elapsedMs: measured.elapsedMs,
      frameGap: measured.frameGap,
      memory: measured.memory,
      pageSaw,
    };
  }
  return {
    rowId,
    verdict: Object.freeze({
      success: true,
      historyDigestHex: bytesToHex(measured.outcome.value.historyDigestBytes),
    }),
    elapsedMs: measured.elapsedMs,
    frameGap: measured.frameGap,
    memory: measured.memory,
    pageSaw,
  };
}
