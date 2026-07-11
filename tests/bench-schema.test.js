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

  test('smoke matrix: valid schema, finite timings, all classes present, timing never enters trace bytes', { timeout: 240000 }, async () => {
    const a = await runBenchmark(smokeConfig());
    const b = await runBenchmark(smokeConfig());

    for (const report of [a, b]) {
      expect(report.schema).toBe('boxcar3d.bench-physics/1');
      // Metadata completeness.
      expect(typeof report.meta.generatedUtc).toBe('string');
      expect(report.meta.os).toMatchObject({ platform: expect.any(String), arch: expect.any(String) });
      expect(report.meta.cpu).toMatchObject({ model: expect.any(String), count: expect.any(Number) });
      expect(report.meta.node).toMatch(/^v\d+/);
      expect(report.meta.rapier).toEqual({ compat: '0.19.3', deterministicCompat: '0.19.3' });
      expect(Object.keys(report.meta.fixtures).sort()).toEqual(['A', 'B', 'C']);
      expect(report.meta.fixtures.A).toMatchObject({ name: 'eval-a-s0-flat', version: 1, terrainSeed: 20260715 });
      expect(report.meta.traceSchemaVersion).toBe(1);
      expect(report.meta.samples).toBe(2);
      expect(report.meta.warmupSteps).toBe(10);
      expect(report.meta.percentileMethod).toContain('nearest-rank');
      expect(report.meta.rowBudgetMs).toBeGreaterThan(0);
      expect(Array.isArray(report.meta.argv)).toBe(true);
      // Rows: every smoke row completes ok; the three classes and both
      // workloads are represented; trace-disabled and digest rows stay distinct.
      expect(report.rows.length).toBeGreaterThan(0);
      expect(new Set(report.rows.map((r) => r.class))).toEqual(new Set(['canonical', 'profiler', 'traceOverhead']));
      expect(new Set(report.rows.map((r) => r.workload))).toEqual(new Set(['principal', 'control']));
      for (const row of report.rows) {
        expect(row.status, `${row.class}/${row.flavor}/${row.fixture}: ${row.reason ?? row.error ?? ''}`).toBe('ok');
        expect(row.counts.bodies).toBeGreaterThan(0);
        expect(row.counts.joints).toBeGreaterThanOrEqual(0);
        for (const [k, v] of Object.entries(row.phases)) {
          expect(Number.isFinite(v), `${row.class} ${k}`).toBe(true);
          expect(v, `${row.class} ${k}`).toBeGreaterThanOrEqual(0);
        }
        expect(Number.isFinite(row.meanStepMs)).toBe(true);
        expect(row.vehicleStepsPerSec).toBeGreaterThan(0);
        expect(row.health.nonFiniteVehicles).toBe(0);
        expect(row.health.invalidBodies).toBe(0);
        expect(row.health.invalidJoints).toBe(0);
        if (row.class === 'profiler') {
          expect(row.engine.stepMsMedian).toBeGreaterThanOrEqual(0);
          expect(row.engine.stepMsP90).toBeGreaterThanOrEqual(row.engine.stepMsMedian);
          expect(row.engine.sampleCount).toBe(row.measuredSteps * row.samples);
        } else {
          expect(row.engine).toBeNull();
        }
        // Digest only where the trace instrument is on.
        if (row.traceMode === 'digest') {
          expect(row.digest).toMatch(/^[0-9a-f]{8}$/);
          expect(row.recordCount).toBeGreaterThan(0);
          expect(row.byteCount).toBe(row.recordCount * 128);
        } else {
          expect(row.digest).toBeNull();
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
    // two runs, but trace bytes must be identical — benchmark timing can
    // never enter the digest. (Both flavors are run-to-run deterministic
    // within one process, so this holds for every digest row.)
    const digestRows = (r) => r.rows.filter((x) => x.traceMode === 'digest')
      .map((x) => ({ flavor: x.flavor, fixture: x.fixture, digest: x.digest, recordCount: x.recordCount, byteCount: x.byteCount }));
    expect(digestRows(b)).toEqual(digestRows(a));
  });
});
