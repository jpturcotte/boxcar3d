// The integrity probe's only CI touchpoint — a schema smoke, never a physics
// gate (the physics-explosion-probe-schema precedent). Importing the module
// must NOT run the CLI. DELIBERATELY ABSENT: any assertion on a status,
// magnitude, count, or timing — a future engine that converges the divergent
// islands must turn the probe's observations quiet WITHOUT a red. This test
// checks structure, the identity/agreement/dt HARD checks, and rendering only.

import { describe, test, expect } from 'vitest';
import {
  PROBE_SCHEMA, renderMarkdown, runIntegrityProbe, smokeConfig,
} from '../scripts/probe-integrity.js';
import { INTEGRITY_POLICY_VERSION, INTEGRITY_STATUS } from '../src/sim/integrity.js';

describe('integrity probe schema smoke', () => {
  test('smoke config produces the versioned report shape with all hard checks green', { timeout: 240000 }, async () => {
    const report = await runIntegrityProbe({ ...smokeConfig(), argv: ['--smoke'] });

    expect(report.schema).toBe(PROBE_SCHEMA);
    expect(report.schema).toBe('boxcar3d.probe-integrity/1');
    expect(report.passes).toEqual(['signals', 'population', 'neighborhood', 'cost']);
    expect(report.policy.integrityPolicyVersion).toBe(INTEGRITY_POLICY_VERSION);
    expect(report.engine.rapierVersion).toBe('0.19.3');
    expect(report.engine.effectiveDt).toBe(Math.fround(1 / 60));

    // Hard checks (identity/agreement/dt) must ALL pass on an unmodified repo —
    // these ARE contracts (unlike every status/magnitude observation).
    expect(report.checks.length).toBeGreaterThan(0);
    for (const c of report.checks) {
      expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
    }
    expect(report.checks.some((c) => c.name === 'dt:f32-readback')).toBe(true);
    expect(report.checks.some((c) => c.name.startsWith('identity:'))).toBe(true);
    expect(report.checks.some((c) => c.name.startsWith('agreement:'))).toBe(true);

    // Signals: structurally complete rows; each carries a valid status enum,
    // finite observations, and the selectable/fitness contract shape.
    expect(report.signals.rows.length).toBe(smokeConfig().signalSubjects.length);
    for (const r of report.signals.rows) {
      expect(INTEGRITY_STATUS).toContain(r.status);
      expect(Array.isArray(r.reasons)).toBe(true);
      expect(Number.isFinite(r.peakBodySpeed)).toBe(true);
      expect(Number.isFinite(r.maxForwardDistance)).toBe(true);
      expect(typeof r.selectable).toBe('boolean');
      expect(Number.isFinite(r.fitness)).toBe(true);
      // The v2 gate as a STRUCTURAL invariant (not a physics claim):
      // unselectable ⇒ fitness exactly 0.
      if (!r.selectable) expect(r.fitness).toBe(0);
    }
    expect(typeof report.signals.reasonCounts).toBe('object');

    // Population: one smoke seed, 20 members, status counts keyed by the enum.
    expect(report.population).toHaveLength(1);
    expect(report.population[0].populationSeed).toBe(20260725);
    expect(report.population[0].members).toHaveLength(20);
    for (const k of Object.keys(report.population[0].statusCounts)) {
      expect(INTEGRITY_STATUS).toContain(k);
    }
    expect(Array.isArray(report.population[0].alertButOk)).toBe(true);

    // Neighborhood: one parent, the declared child count, structural rows.
    expect(report.neighborhood).toHaveLength(1);
    const nb = report.neighborhood[0];
    expect(nb.parent).toBe('control');
    expect(nb.children).toBe(smokeConfig().childrenPerParent);
    expect(Number.isInteger(nb.failedCount)).toBe(true);
    expect(Number.isFinite(nb.meanRepairTouchedLeaves)).toBe(true);
    for (const child of nb.childRows) {
      expect(child.genotypeDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(INTEGRITY_STATUS).toContain(child.status);
    }

    // Cost: paired arms present, finite timings, a finite ratio.
    expect(report.cost.pairs).toHaveLength(smokeConfig().costPairs);
    for (const p of report.cost.pairs) {
      expect(Number.isFinite(p.onMs)).toBe(true);
      expect(Number.isFinite(p.offMs)).toBe(true);
    }
    expect(Number.isFinite(report.cost.ratioMedian)).toBe(true);

    const md = renderMarkdown(report);
    expect(md).toContain('# Numerical-integrity probe');
    expect(md).toContain('## Checks');
    expect(md).toContain('## Signals');
    expect(md).toContain('## Population');
    expect(md).toContain('## Mutation neighborhood');
    expect(md).toContain('## Cost');
  });

  test('a single-pass run dispatches exactly that pass', { timeout: 240000 }, async () => {
    const report = await runIntegrityProbe({ ...smokeConfig(), passes: ['signals'] });
    expect(report.passes).toEqual(['signals']);
    expect(report.signals).not.toBeNull();
    expect(report.population).toBeNull();
    expect(report.neighborhood).toBeNull();
    expect(report.cost).toBeNull();
    for (const c of report.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
  });

  test('an unknown pass fails loud', async () => {
    await expect(runIntegrityProbe({ ...smokeConfig(), passes: ['bogus'] }))
      .rejects.toThrow(/unknown pass/);
  });
});
