// TWO OBLIGATIONS. Test 1 is LIVENESS: a small kernel-honest artifact built
// in-page (allowed HERE and nowhere else — this is a CI smoke fixture, not a
// measured row; the measured-row never-build rule is the page module's own
// header contract) verifies through the heartbeat wrapper, returning the
// digest, the generation rows, primed/drained heartbeat evidence, and a
// labeled memory shape. Test 2 is the HEARTBEAT SELF-TEST: a known 200 ms
// synchronous busy block must appear as a >= 150 ms max frame gap with the
// heartbeat primed and drained.
//
// THE PRIME TOOTH RIDES THE TICK CHANNEL (post-review correction). Chromium's
// rAF timestamps are frame-BEGIN times: the first callback after a sync block
// carries a pre-block vsync timestamp, so the rAF channel SELF-PRIMES even
// when the priming wait is deleted (the review reproduced a deleted-prime run
// passing 6/6). The 4 ms tick channel has no such mercy — a deleted priming
// wait makes its first recorded tick land after t0 — so the structural prime
// assertion is `tickPrimedBeforeT0`. The DRAIN tooth works on both channels:
// a deleted drain leaves no post-t1 timestamp and the >= 150 ms gap
// assertion fails (defects 8/9, browser leg).

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
    expect(measured.frameGap.tickPrimedBeforeT0).toBe(true);
    expect(Number.isFinite(measured.elapsedMs)).toBe(true);
    expect(measured.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(measured.frameGap.maxGapMs)).toBe(true);
    expect(measured.frameGap.maxGapMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(measured.frameGap.gapsOver50ms)).toBe(true);
    expect(measured.frameGap.gapsOver50ms).toBeGreaterThanOrEqual(0);
    // The memory shape is one of exactly two honest outcomes — a single
    // DISJUNCTIVE assertion (never a tautology): if the field were missing
    // or malformed, `honest` is false and this fails.
    const honest = measured.memory === 'unavailable'
      || (typeof measured.memory === 'object' && measured.memory !== null
        && Number.isFinite(measured.memory.usedJSHeapSizeBefore)
        && Number.isFinite(measured.memory.usedJSHeapSizeAfter));
    expect(honest, 'memory must be the labeled-unavailable marker or finite before/after fields').toBe(true);
  });

  test('heartbeat self-test: a 200 ms busy block reads as a >= 150 ms max frame gap', async () => {
    // THE PRIMED/DRAINED TEETH (defects 8/9, browser leg). DRAIN: deleting
    // the drain wait removes every post-op timestamp, so the block's gap
    // never enters either channel and the >= 150 ms assertion fails. PRIME:
    // deleting the priming wait makes the first recorded TICK land after t0
    // (rAF self-primes and cannot carry this tooth — the file header cites
    // the measured mechanism), so the tickPrimedBeforeT0 assertion fails.
    // The margin (150 < 200) absorbs timer coarsening; the block is
    // synchronous, so the tick channel must register it.
    const measured = await measureWithHeartbeat(() => busyBlock(200));
    expect(measured.frameGap.primed).toBe(true);
    expect(measured.frameGap.drained).toBe(true);
    expect(measured.frameGap.tickPrimedBeforeT0).toBe(true);
    expect(measured.frameGap.maxGapMs).toBeGreaterThanOrEqual(150);
  });
});
