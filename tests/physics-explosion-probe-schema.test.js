// The physics-explosion probe's only CI touchpoint — a schema smoke, never a
// physics gate (the population-probe-schema precedent). Importing the module
// must NOT run the CLI. DELIBERATELY ABSENT: any assertion on a physics
// magnitude or onset VALUE — pre-correction explosion behavior must never
// become a must-still-explode CI requirement (the investigation plan's
// regression asymmetry), so this test checks structure, identity checks, and
// rendering only.

import { describe, test, expect } from 'vitest';
import {
  PROBE_SCHEMA, configFromArgs, normalizePasses, parsePrevalenceSeeds,
  renderMarkdown, runProbe, selectReproducerArm, smokeConfig,
} from '../scripts/probe-physics-explosion.js';

const HEX8 = /^[0-9a-f]{8}$/;
const ALL_PASSES = [
  'baseline', 'terrain', 'vehicle', 'engine', 'load', 'local', 'reproducer', 'prevalence',
];
const ONSET_KEYS = [
  'firstAlertStep', 'lastOrdinaryStep', 'firstCatastrophicStep',
  'firstCausalCandidateStep', 'leadingBody', 'chassisLagSteps',
];

describe('probe schema smoke', () => {
  test('smoke config produces the versioned report shape with all hard checks green', { timeout: 240000 }, async () => {
    // passes: ['all'] deliberately exercises the programmatic normalization
    // end-to-end (the round-2 review finding: 'all' used to validate and
    // then dispatch nothing) — every section assertion below is its teeth.
    const report = await runProbe({ ...smokeConfig(), passes: ['all'], argv: ['--smoke'] });

    expect(report.schema).toBe(PROBE_SCHEMA);
    expect(report.schema).toBe('boxcar3d.physics-explosion/1');
    expect(report.passes).toEqual(ALL_PASSES);
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

    // Load taxonomy: the smoke crossing endpoints (all internal loads vs the
    // fully unloaded island), run GENUINELY static-free (no floor at all).
    // Every arm's free-space premise is a HARD check (staticColliders 0,
    // zero touching, zero proximity pairs). Physics outcomes stay OBSERVATIONS.
    expect(report.load.map((l) => l.arm)).toEqual(['original', 'passiveAllS0']);
    for (const l of report.load) {
      expect(l.witness).toBe('A');
      expect(l.armGenotypeDigest).toMatch(HEX8);
      expect(typeof l.internalLoads.motors).toBe('boolean');
      expect(typeof l.internalLoads.springs).toBe('boolean');
      // Genuinely free space: no statics, nothing touched.
      expect(l.staticColliders).toBe(0);
      expect(l.contacts.touchingContacts).toBe(0);
      expect(l.contacts.proximityPairs).toBe(0);
      expect(l.contacts.firstTouchingStep).toBeNull();
      expect(Object.keys(l.result.onset).sort()).toEqual([...ONSET_KEYS].sort());
    }
    expect(report.load.find((l) => l.arm === 'passiveAllS0').internalLoads)
      .toEqual({ motors: false, springs: false });
    // The free-space premise is hard-checked per arm.
    expect(report.checks.some((c) => c.name === 'freeSpace:A:original')).toBe(true);
    expect(report.checks.some((c) => c.name === 'freeSpace:A:passiveAllS0')).toBe(true);

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

    // Reproducer: both flavors + the smoke closure arms, identity +
    // deterministic byte-exact repeat hard-checked; onset values are
    // OBSERVATIONS (no must-explode assertion, ever).
    expect(report.reproducer.map((r) => `${r.arm}:${r.flavor}`))
      .toEqual(['original:deterministic', 'original:ordinary',
        'gravity9.81:deterministic', 'gravityOff:deterministic', 'freeSpace:deterministic',
        'multibody:deterministic']);
    expect(report.checks.some((c) => c.name === 'identity:reproducer')).toBe(true);
    expect(report.checks.some((c) => c.name === 'repeat:reproducer')).toBe(true);
    for (const r of report.reproducer) {
      expect(r.genotypeDigest).toMatch(HEX8);
      if (r.unsupported === true) continue; // record-and-drop rows carry no result
      expect(Number.isFinite(r.result.maxForwardDistance)).toBe(true);
      expect(Object.keys(r.result.onset).sort()).toEqual([...ONSET_KEYS].sort());
    }
    // The free-space arm is genuinely static-free (no floor at all),
    // hard-checked: 0 static colliders, nothing touched.
    const freeSpace = report.reproducer.find((r) => r.arm === 'freeSpace');
    expect(freeSpace.contacts.touchingContacts).toBe(0);
    expect(freeSpace.contacts.proximityPairs).toBe(0);
    expect(freeSpace.contacts.firstTouchingStep).toBeNull();
    expect(report.checks.some((c) => c.name === 'freeSpace:reproducer')).toBe(true);
    // The gravity-magnitude control keeps the floor (a gravity comparison,
    // not a free-space arm) — it contacts the pad.
    const gravityArm = report.reproducer.find((r) => r.arm === 'gravity9.81');
    expect(Number.isInteger(gravityArm.contacts.touchingContacts)).toBe(true);
    // The gravity-PRESENCE isolator keeps the floor but zeroes gravity — the
    // single-variable partner of `original`. Its outcome stays an OBSERVATION
    // (no must-be-quiescent assertion), but it carries a contacts shape.
    const gravityOff = report.reproducer.find((r) => r.arm === 'gravityOff');
    expect(Number.isInteger(gravityOff.contacts.touchingContacts)).toBe(true);
    expect(Object.keys(gravityOff.result.onset).sort()).toEqual([...ONSET_KEYS].sort());
    // The multibody representation discriminator: SUPPORTED on this pinned
    // 0.19.3 build (this test already pins rapierVersion above, so the
    // capability assertion is version-scoped, not a physics claim). The
    // swap's structural premise is a hard check; the outcome — does the
    // reduced-coordinate island diverge? — stays an OBSERVATION.
    const multibody = report.reproducer.find((r) => r.arm === 'multibody');
    expect(multibody.unsupported).toBe(false);
    expect(Number.isInteger(multibody.contacts.touchingContacts)).toBe(true);
    expect(Number.isFinite(multibody.result.maxForwardDistance)).toBe(true);
    expect(report.checks.some((c) => c.name === 'multibody:reproducer')).toBe(true);

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
    expect(md).toContain('## Load taxonomy');
    expect(md).toContain('## Localization');
    expect(md).toContain('## Minimum reproducer');
    expect(md).toContain('## Prevalence');
  });

  test('pass selection normalizes identically for the programmatic API and the CLI', () => {
    expect(normalizePasses(['all'])).toEqual(ALL_PASSES);
    expect(normalizePasses('all')).toEqual(ALL_PASSES);
    expect(normalizePasses(['baseline,terrain'])).toEqual(['baseline', 'terrain']);
    expect(normalizePasses(['baseline', 'terrain'])).toEqual(['baseline', 'terrain']);
    // Dedupe preserves first-seen order.
    expect(normalizePasses(['baseline', 'baseline,terrain'])).toEqual(['baseline', 'terrain']);
    expect(() => normalizePasses(['bogus'])).toThrow(/unknown pass/);
    expect(() => normalizePasses(['baseline,bogus'])).toThrow(/unknown pass/);
  });

  test("passes: ['baseline,terrain'] dispatches exactly those passes", { timeout: 240000 }, async () => {
    const report = await runProbe({ ...smokeConfig(), passes: ['baseline,terrain'] });
    expect(report.passes).toEqual(['baseline', 'terrain']);
    expect(report.baseline).not.toBeNull();
    expect(report.terrain).not.toBeNull();
    expect(report.vehicle).toBeNull();
    expect(report.engineAblations).toBeNull();
    expect(report.load).toBeNull();
    expect(report.localization).toBeNull();
    expect(report.reproducer).toBeNull();
    expect(report.prevalence).toBeNull();
    for (const c of report.checks) {
      expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
    }
  });

  test('a single-pass run reports the real global timestep, never null', { timeout: 240000 }, async () => {
    // The documented engine-upgrade recheck is `--pass reproducer` — its
    // report heading must carry the real f32 timestep readback even though
    // baselinePass (which used to be the only writer) never ran.
    const report = await runProbe({
      ...smokeConfig(), passes: ['reproducer'], reproducerArms: ['original'],
    });
    expect(report.passes).toEqual(['reproducer']);
    expect(report.engine.effectiveDt).toBe(Math.fround(1 / 60));
    expect(report.baseline).toBeNull();
    expect(report.reproducer.map((r) => `${r.arm}:${r.flavor}`))
      .toEqual(['original:deterministic', 'original:ordinary']);
    for (const c of report.checks) {
      expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
    }
    const md = renderMarkdown(report);
    expect(md).toContain(`effectiveDt ${Math.fround(1 / 60)}`);
    expect(md).not.toContain('effectiveDt null');
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

describe('CLI parser (configFromArgs + validators)', () => {
  // These exercise the SAME parse + validation the CLI runs (main() is a thin
  // configFromArgs(process.argv.slice(2)) caller), so `--arm multibody` and
  // `--prevalence-seeds` — documented in the USAGE header, the PR body, and the
  // decision record — are proven wired, not just declared (round-2 P2: the old
  // parseArgs declared only smoke/witness/pass/json, so `--arm` threw in strict
  // mode). No child_process: configFromArgs is a pure argv -> config function.

  test('--arm selects exactly one reproducer arm', () => {
    const cfg = configFromArgs(['--pass', 'reproducer', '--arm', 'multibody']);
    expect(cfg.reproducerArms).toEqual(['multibody']);
    expect(cfg.passes).toBe('reproducer');
  });

  test('--prevalence-seeds parses a canonical uint32 list; argv round-trips', () => {
    const argv = ['--pass', 'prevalence', '--prevalence-seeds', '20260730'];
    const cfg = configFromArgs(argv);
    expect(cfg.prevalenceSeeds).toEqual([20260730]);
    // config.argv records the PASSED argv (not process.argv) so it flows into
    // report.argv for a programmatic run.
    expect(cfg.argv).toEqual(argv);
  });

  test('--prevalence-seeds accepts a comma list in order and the domain boundaries', () => {
    expect(configFromArgs(['--prevalence-seeds', '20260725,20260730']).prevalenceSeeds)
      .toEqual([20260725, 20260730]);
    expect(configFromArgs(['--prevalence-seeds', '0,4294967295']).prevalenceSeeds)
      .toEqual([0, 4294967295]);
  });

  test('absent options leave the defaults untouched', () => {
    const cfg = configFromArgs([]);
    expect(cfg.reproducerArms).toBeNull();
    expect(cfg.prevalenceSeeds).toEqual([20260725, 20260728, 20260729]);
    expect(cfg.jsonOut).toBeNull();
    expect(cfg.argv).toEqual([]);
  });

  test('--smoke selects the smoke config and --json sets jsonOut', () => {
    const cfg = configFromArgs(['--smoke', '--json', 'out.json']);
    expect(cfg.prevalenceSeeds).toEqual([20260725]);
    expect(cfg.jsonOut).toBe('out.json');
  });

  test('an unknown --arm fails loud', () => {
    expect(() => configFromArgs(['--arm', 'bogus'])).toThrow(/unknown reproducer arm/);
    expect(() => selectReproducerArm('bogus')).toThrow(/unknown reproducer arm/);
    expect(selectReproducerArm('multibody')).toBe('multibody');
  });

  test('invalid --prevalence-seeds fails loud (non-integer, blank, out-of-domain)', () => {
    for (const bad of ['abc', '', ' ', '20260730,', '1.5', '4294967296']) {
      expect(() => configFromArgs(['--prevalence-seeds', bad]), bad)
        .toThrow(/invalid prevalence seed/);
    }
    // A negative reaches the validator only via the `=` form — a BARE
    // "--prevalence-seeds -1" is rejected earlier by parseArgs itself
    // (dash-prefixed value is ambiguous). Both are rejections.
    expect(() => configFromArgs(['--prevalence-seeds=-1'])).toThrow(/invalid prevalence seed/);
    expect(() => configFromArgs(['--prevalence-seeds', '-1'])).toThrow();
  });

  test('parsePrevalenceSeeds is the shared fail-loud authority', () => {
    expect(parsePrevalenceSeeds('20260730')).toEqual([20260730]);
    expect(() => parsePrevalenceSeeds('nope')).toThrow(/invalid prevalence seed/);
  });

  test('an unknown option is rejected by strict parseArgs', () => {
    expect(() => configFromArgs(['--bogus'])).toThrow();
  });
});
