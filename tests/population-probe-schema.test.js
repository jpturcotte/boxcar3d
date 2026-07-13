// The characterization script's only CI touchpoint — a schema smoke, never a
// distribution/timing threshold (the bench-schema precedent). Importing the
// module must NOT run the CLI, and the smoke config must produce a
// well-formed report with every pass present and the hard invariants
// (S2 frequency 0, undriven frequency 0, recompile stability) holding.

import { describe, test, expect } from 'vitest';
import { runCharacterization, smokeConfig, renderMarkdown } from '../scripts/characterize-population.js';

describe('population characterization schema', () => {
  test('smoke report is well-formed, hard invariants hold, and it renders to markdown', { timeout: 240000 }, async () => {
    const report = await runCharacterization({ ...smokeConfig(), argv: ['--smoke'] });
    expect(report.schema).toBe('boxcar3d.characterize-population/1');

    const d = report.distribution;
    expect(d.n).toBe(64);
    expect(d.s2Frequency).toBe(0); // the S2 mask holds
    expect(d.noDrivenFrequency).toBe(0); // driven-by-construction holds
    expect(d.recompileStable).toBe(64); // canonical fixed point
    expect(d.uniqueCanonical).toBeLessThanOrEqual(d.uniqueRaw);
    expect(d.repairFraction).toBeGreaterThanOrEqual(0);
    expect(d.repairFraction).toBeLessThanOrEqual(1);
    expect(d.axleCounts.every(([axles]) => axles >= 1 && axles <= 6)).toBe(true);

    expect(report.viability.length).toBe(1);
    expect(report.viability[0].valid).toBeLessThanOrEqual(report.viability[0].size);
    expect(report.viability[0].champion.individualId).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(report.viability[0].champion.peakChassisSpeed)).toBe(true);
    expect(report.viability[0].bySuspension.length).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(report.viability[0].rollback.median)).toBe(true);

    // champion + a 3-way fitness-sorted sample, per master seed (1 in smoke)
    expect(report.undriven.length).toBe(4);
    expect(report.undriven.map((u) => u.label)).toEqual(['champion', 'min-fitness', 'median-fitness', 'max-fitness']);
    expect(Number.isFinite(report.undriven[0].passiveMaxForward)).toBe(true);

    expect(report.cost.length).toBe(2);
    expect(report.cost.every((c) => c.totalMs > 0)).toBe(true);

    expect(typeof report.recheck.sharedWorldInvariant).toBe('boolean');

    const md = renderMarkdown(report);
    expect(md).toContain('# GA Phase 1A population characterization');
    expect(md).toContain('## Distributions');
  });
});
