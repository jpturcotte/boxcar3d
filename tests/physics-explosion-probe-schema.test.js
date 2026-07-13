// The physics-explosion probe's only CI touchpoint — a schema smoke, never a
// physics gate (the population-probe-schema precedent). Importing the module
// must NOT run the CLI. DELIBERATELY ABSENT: any assertion on a physics
// magnitude or onset VALUE — pre-correction explosion behavior must never
// become a must-still-explode CI requirement (the investigation plan's
// regression asymmetry), so this test checks structure, identity checks, and
// rendering only.

import { describe, test, expect } from 'vitest';
import {
  PROBE_SCHEMA, renderMarkdown, runProbe, smokeConfig,
} from '../scripts/probe-physics-explosion.js';

const HEX8 = /^[0-9a-f]{8}$/;
const ONSET_KEYS = [
  'firstAlertStep', 'lastOrdinaryStep', 'firstCatastrophicStep',
  'firstCausalCandidateStep', 'leadingBody', 'chassisLagSteps',
];

describe('probe schema smoke', () => {
  test('smoke config produces the versioned report shape with all hard checks green', { timeout: 240000 }, async () => {
    const report = await runProbe({ ...smokeConfig(), argv: ['--smoke'] });

    expect(report.schema).toBe(PROBE_SCHEMA);
    expect(report.schema).toBe('boxcar3d.physics-explosion/1');
    expect(report.engine.rapierVersion).toBe('0.19.3');
    expect(report.engine.deterministic).toBe(true);
    expect(report.engine.effectiveDt).toBe(Math.fround(1 / 60));

    // Hard identity/repeatability/dt checks must all pass on an unmodified
    // repo — these ARE contracts (unlike every physics observation).
    expect(report.checks.length).toBeGreaterThan(0);
    for (const c of report.checks) {
      expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
    }
    expect(report.checks.some((c) => c.name.startsWith('identity:'))).toBe(true);
    expect(report.checks.some((c) => c.name.startsWith('repeat:'))).toBe(true);

    // Baseline: witness A driven + passive, structurally complete.
    expect(report.baseline).toHaveLength(2);
    for (const b of report.baseline) {
      expect(b.witness).toBe('A');
      expect(b.genotypeDigest).toMatch(HEX8);
      expect(Number.isFinite(b.result.maxForwardDistance)).toBe(true);
      expect(Number.isFinite(b.result.peakBodySpeed)).toBe(true);
      expect(b.result.traceDigest).toMatch(HEX8);
      expect(Object.keys(b.result.onset).sort()).toEqual([...ONSET_KEYS].sort());
      expect(Object.keys(b.sensitivity).sort())
        .toEqual(['alertAtDefault', 'alertAtDouble', 'alertAtHalf', 'spread']);
    }
    expect(report.baseline.map((b) => b.passive)).toEqual([false, true]);
    // Smoke skips ordinary-flavor observations and controls.
    expect(report.baseline.every((b) => b.ordinary === null)).toBe(true);
    expect(report.controls).toBeNull();

    // Terrain: 2 smoke variants x driven/passive.
    expect(report.terrain).toHaveLength(4);
    for (const t of report.terrain) {
      expect(['full', 'flat']).toContain(t.variant);
      expect(Number.isFinite(t.result.maxForwardDistance)).toBe(true);
      expect(Object.keys(t.result.onset).sort()).toEqual([...ONSET_KEYS].sort());
    }

    // Vehicle: the 3 smoke ecological arms + the smoke phenotype-preserving
    // arm, each with its own canonical arm digest.
    expect(report.vehicle.map((v) => v.arm))
      .toEqual(['passive', 'powerZero', 'sled', 'motorOff:all']);
    expect(report.vehicle.map((v) => v.kind))
      .toEqual(['ecological', 'ecological', 'ecological', 'phenotype-preserving']);
    for (const v of report.vehicle) {
      expect(v.armGenotypeDigest).toMatch(HEX8);
      expect(v.error).toBeNull();
      expect(Number.isFinite(v.result.maxForwardDistance)).toBe(true);
    }

    // Engine: the smoke arms — the composed baseline (whose digest equality
    // vs runEvaluation is a HARD check, asserted green above) + one solver
    // arm; honest dt reporting present on every row.
    expect(report.engineAblations.map((e) => e.arm)).toEqual(['baselineComposed', 'solverIters:8']);
    expect(report.checks.some((c) => c.name === 'composed:A')).toBe(true);
    for (const e of report.engineAblations) {
      expect(Number.isFinite(e.requestedDt)).toBe(true);
      expect(Number.isFinite(e.effectiveDt)).toBe(true);
      expect(Number.isFinite(e.result.maxForwardDistance)).toBe(true);
    }

    // Localization: one row per witness with the mandated evidence fields.
    expect(report.localization).toHaveLength(1);
    const loc = report.localization[0];
    expect(loc.witness).toBe('A');
    expect(Number.isInteger(loc.step0Pairs)).toBe(true);
    expect(Number.isInteger(loc.step1Pairs)).toBe(true);
    expect(Number.isFinite(loc.spawn.minWheelClearance)).toBe(true);
    expect(Number.isFinite(loc.spawn.bellyClearance)).toBe(true);
    expect(Array.isArray(loc.windowContacts)).toBe(true);
    expect(Array.isArray(loc.jointStretch)).toBe(true);
    expect(Number.isInteger(loc.wedgeCandidates)).toBe(true);

    // Reproducer: both flavors + the smoke closure arm, identity +
    // deterministic byte-exact repeat hard-checked; onset values are
    // OBSERVATIONS (no must-explode assertion, ever).
    expect(report.reproducer.map((r) => `${r.arm}:${r.flavor}`))
      .toEqual(['original:deterministic', 'original:ordinary', 'freeSpace:deterministic']);
    expect(report.checks.some((c) => c.name === 'identity:reproducer')).toBe(true);
    expect(report.checks.some((c) => c.name === 'repeat:reproducer')).toBe(true);
    for (const r of report.reproducer) {
      expect(r.genotypeDigest).toMatch(HEX8);
      expect(Number.isFinite(r.result.maxForwardDistance)).toBe(true);
      expect(Object.keys(r.result.onset).sort()).toEqual([...ONSET_KEYS].sort());
    }
    // The free-space arm MEASURES its no-static-contact premise.
    const freeSpace = report.reproducer.find((r) => r.arm === 'freeSpace');
    expect(Number.isInteger(freeSpace.staticContacts)).toBe(true);

    // Prevalence: one smoke seed, all 20 members classified.
    expect(report.prevalence).toHaveLength(1);
    expect(report.prevalence[0].populationSeed).toBe(20260725);
    expect(report.prevalence[0].individuals).toHaveLength(20);
    expect(Number.isInteger(report.prevalence[0].alertCount)).toBe(true);
    expect(Number.isInteger(report.prevalence[0].catastrophicCount)).toBe(true);
    for (const i of report.prevalence[0].individuals) {
      expect(i.genotypeDigest).toMatch(HEX8);
      expect(Number.isFinite(i.maxForwardDistance)).toBe(true);
      expect(Number.isFinite(i.peakBodySpeed)).toBe(true);
    }

    const md = renderMarkdown(report);
    expect(md).toContain('# Physics-explosion probe');
    expect(md).toContain('## Checks');
    expect(md).toContain('## Baseline (witness reproduction)');
    expect(md).toContain('## Terrain ablations');
    expect(md).toContain('## Vehicle ablations');
    expect(md).toContain('## Engine ablations');
    expect(md).toContain('## Localization');
    expect(md).toContain('## Minimum reproducer');
    expect(md).toContain('## Prevalence');
  });

  test('unknown passes and selectors fail loud', async () => {
    await expect(runProbe({ ...smokeConfig(), passes: ['bogus'] }))
      .rejects.toThrow(/unknown pass/);
    await expect(runProbe({ ...smokeConfig(), witnesses: ['Z'] }))
      .rejects.toThrow(/unknown witness/);
    await expect(runProbe({ ...smokeConfig(), witnesses: ['1:2'] }))
      .rejects.toThrow(/unknown witness/);
  });
});
