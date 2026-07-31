// The PR-4D browser bench harness gate (Chromium): the in-page measured-row
// machinery must work in the pinned browser, not just in the driver's manual
// evidence runs.
//
// TWO OBLIGATIONS. Test 1 is LIVENESS: a small kernel-honest artifact built
// in-page (allowed HERE and nowhere else — this is a CI smoke fixture, not a
// measured row; the measured-row never-build rule is the page module's own
// header contract) verifies through the heartbeat wrapper, returning the
// digest, the generation rows, primed/drained heartbeat evidence, and a
// labeled memory shape. Test 2 is the HEARTBEAT SELF-TEST: a known 200 ms
// synchronous busy block must appear as a >= 150 ms max frame gap with the
// heartbeat primed and drained. Deleting the PRIMED wait leaves no pre-op
// timestamp for the block's gap to be measured against; deleting the DRAIN
// wait stops the recording before the post-block timestamps exist — either
// deletion kills the >= 150 ms assertion, which is the browser leg of the
// primed/drained deliberate defects (8/9).

import { describe, test, expect } from 'vitest';

import {
  buildScaleArtifact, readBenchRuntimeIdentity,
} from '../../scripts/bench-evolution-verification-artifacts.js';
import { measureWithHeartbeat, busyBlock } from '../../scripts/browser-bench/page.js';
import { extractHistoryObservations } from '../../scripts/history-observations.js';

describe('PR-4D browser bench harness (Chromium)', () => {
  test('liveness: a measured extraction returns the digest, the rows, and primed/drained heartbeat evidence', async () => {
    // In-page build is allowed ONLY in this CI smoke (the smallest honest
    // shape — the Node instrument's S1): never in a measured page.
    const runtime = await readBenchRuntimeIdentity();
    const artifact = await buildScaleArtifact(runtime, {
      populationSize: 4, recordCount: 3, maxGenerations: 4,
    });
    const measured = await measureWithHeartbeat(() => extractHistoryObservations(artifact.bytes));
    expect(measured.outcome.error).toBeUndefined();
    const value = measured.outcome.value;
    expect(value.historyDigestBytes).toHaveLength(32);
    expect(value.generations).toHaveLength(3);
    expect(measured.frameGap.primed).toBe(true);
    expect(measured.frameGap.drained).toBe(true);
    expect(Number.isFinite(measured.elapsedMs)).toBe(true);
    expect(measured.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(measured.frameGap.maxGapMs)).toBe(true);
    expect(measured.frameGap.maxGapMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(measured.frameGap.gapsOver50ms)).toBe(true);
    expect(measured.frameGap.gapsOver50ms).toBeGreaterThanOrEqual(0);
    if (measured.memory === 'unavailable') {
      expect(measured.memory).toBe('unavailable');
    } else {
      expect(Number.isFinite(measured.memory.usedJSHeapSizeBefore)).toBe(true);
      expect(Number.isFinite(measured.memory.usedJSHeapSizeAfter)).toBe(true);
    }
  });

  test('heartbeat self-test: a 200 ms busy block reads as a >= 150 ms max frame gap', async () => {
    // THE PRIMED/DRAINED TOOTH (defects 8/9, browser leg): deleting the
    // priming wait removes every pre-op timestamp, and deleting the drain
    // wait removes every post-op one — in both cases the block's gap never
    // enters either channel's consecutive-timestamp recording and this
    // assertion fails. The margin (150 < 200) absorbs timer coarsening; the
    // block is synchronous, so BOTH heartbeat channels must register it.
    const measured = await measureWithHeartbeat(() => busyBlock(200));
    expect(measured.frameGap.primed).toBe(true);
    expect(measured.frameGap.drained).toBe(true);
    expect(measured.frameGap.maxGapMs).toBeGreaterThanOrEqual(150);
  });
});
