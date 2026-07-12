// The benchmark's ONLY CI touchpoint: structure and honesty of the report —
// NEVER an absolute timing threshold (the 50-vehicle/60-FPS goal is assessed
// on a named reference machine in the PR/handoff, not asserted in shared CI).
// Importing the bench module must not run the CLI (the import.meta.url guard
// — this file importing it IS the tooth).

import { describe, test, expect } from 'vitest';
import { runBenchmark, smokeConfig, renderMarkdown, percentile } from '../scripts/bench-physics.js';

describe('bench:physics schema smoke', () => {
  test('percentile is nearest-rank ceil(p·N), 1-indexed', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
    expect(percentile([7], 0.5)).toBe(7);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  test('smoke matrix: valid schema, paired comparisons, finite timings, timing never enters trace bytes', { timeout: 240000 }, async () => {
    const a = await runBenchmark(smokeConfig());
    const b = await runBenchmark(smokeConfig());

    for (const report of [a, b]) {
      expect(report.schema).toBe('boxcar3d.bench-physics/2');
      // Metadata completeness.
      expect(typeof report.meta.generatedUtc).toBe('string');
      expect(report.meta.os).toMatchObject({ platform: expect.any(String), arch: expect.any(String) });
      expect(report.meta.cpu).toMatchObject({ model: expect.any(String), count: expect.any(Number) });
      expect(report.meta.node).toMatch(/^v\d+/);
      expect(report.meta.rapier).toEqual({ compat: '0.19.3', deterministicCompat: '0.19.3' });
      expect(Object.keys(report.meta.fixtures).sort()).toEqual(['A', 'B', 'C']);
      expect(report.meta.traceSchemaVersion).toBe(1);
      expect(report.meta.samples).toBe(2);
      expect(report.meta.warmupSteps).toBe(10);
      expect(report.meta.sampling).toContain('paired');
      expect(report.meta.percentileMethod).toContain('nearest-rank');
      expect(report.meta.principalTerrain.seed).toBe(20260718);
      expect(typeof report.meta.compositeStartX).toBe('number');
      expect(Array.isArray(report.meta.argv)).toBe(true);
      // Comparisons: every smoke comparison completes ok; all three families
      // are represented; both arms carry the paired data.
      expect(report.comparisons.length).toBeGreaterThan(0);
      expect(new Set(report.comparisons.map((c) => c.family)))
        .toEqual(new Set(['deterministicTax', 'profilerOverhead', 'digestOverhead']));
      for (const c of report.comparisons) {
        expect(c.status, `${c.family}/${c.fixture}: ${c.reason ?? c.error ?? ''}`).toBe('ok');
        expect(Number.isFinite(c.ratioMedian)).toBe(true);
        expect(c.ratioMedian).toBeGreaterThan(0);
        expect(c.ratioSamples).toHaveLength(2); // smoke samples = 2
        for (const arm of [c.denom, c.numer]) {
          expect(arm.counts.bodies).toBeGreaterThan(0);
          for (const [k, v] of Object.entries(arm.phases)) {
            expect(Number.isFinite(v), `${c.family} ${k}`).toBe(true);
            expect(v, `${c.family} ${k}`).toBeGreaterThanOrEqual(0);
          }
          expect(Number.isFinite(arm.meanStepMs)).toBe(true);
          expect(arm.vehicleStepsPerSec).toBeGreaterThan(0);
          expect(arm.health.nonFiniteVehicles).toBe(0);
          expect(arm.health.invalidBodies).toBe(0);
          expect(arm.health.invalidJoints).toBe(0);
        }
        // Engine numbers only on the profiler-on (numer) arm of profilerOverhead.
        if (c.family === 'profilerOverhead') {
          expect(c.numer.engine.stepMsMedian).toBeGreaterThanOrEqual(0);
          expect(c.numer.engine.stepMsP90).toBeGreaterThanOrEqual(c.numer.engine.stepMsMedian);
          expect(c.denom.engine).toBeNull();
        } else {
          expect(c.numer.engine).toBeNull();
          expect(c.denom.engine).toBeNull();
        }
        // Digest only on the digest (numer) arm of digestOverhead.
        if (c.family === 'digestOverhead') {
          expect(c.numer.digest).toMatch(/^[0-9a-f]{8}$/);
          expect(c.numer.recordCount).toBeGreaterThan(0);
          expect(c.numer.byteCount).toBe(c.numer.recordCount * 128);
          expect(c.denom.digest).toBeNull();
        }
      }
      expect(Array.isArray(report.derived.deterministicOverhead)).toBe(true);
      expect(report.derived.digestOverhead.length).toBeGreaterThan(0);
      expect(report.derived.profilerOverhead.length).toBeGreaterThan(0);
      // Markdown renders with every section.
      const md = renderMarkdown(report);
      for (const heading of ['Canonical affordability', 'Control', 'Profiler diagnostic', 'Trace-instrument overhead']) {
        expect(md).toContain(heading);
      }
    }

    // The timing-isolation tooth: wall timings are free to differ between the
    // two runs, but the digest arm's trace bytes must be identical — benchmark
    // timing can never enter the digest.
    const digestArms = (r) => r.comparisons.filter((c) => c.family === 'digestOverhead')
      .map((c) => ({ flavor: c.numer.flavor, fixture: c.fixture, digest: c.numer.digest, recordCount: c.numer.recordCount, byteCount: c.numer.byteCount }));
    expect(digestArms(b)).toEqual(digestArms(a));
  });
});
