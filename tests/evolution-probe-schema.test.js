// The evolution probe's ONLY CI touchpoint.
//
// The standing regression-asymmetry rule for instruments in this repo: a probe
// is not a gate, so CI checks its STRUCTURE and its HARD IDENTITY claims and
// nothing else. No magnitude, no fitness, no timing, no "the population
// improved". If a future engine or a future tuning changes what the probe
// OBSERVES, this file must stay green; if the probe stops producing a
// well-formed, versioned report — or starts making an identity claim it cannot
// back — this file must go red.
//
// It also pins the one property that is easy to lose by accident: importing the
// probe module must NOT start a run. The module is imported here, and a
// top-level side effect would show up as this file taking seconds to collect.

import { describe, test, expect } from 'vitest';

import {
  EVOLUTION_PROBE_SCHEMA, configFromArgs, runEvolutionProbe,
} from '../scripts/probe-evolution.js';
import { EVOLUTION_FIXTURE_A } from '../src/sim/evolution-fixtures.js';
import { EVOLUTION_GOLDEN_LOCKS } from '../src/sim/evolution-locks.js';
import { COMPONENT_KINDS } from '../src/sim/evolution-history.js';

const LOCK = EVOLUTION_GOLDEN_LOCKS[EVOLUTION_FIXTURE_A.name];

describe('evolution probe: argument parsing', () => {
  test('the default config is identity mode, markdown out', () => {
    expect(configFromArgs([])).toEqual({ mode: 'identity', json: false });
  });

  test('--json and --mode identity are accepted', () => {
    expect(configFromArgs(['--json'])).toEqual({ mode: 'identity', json: true });
    expect(configFromArgs(['--mode', 'identity', '--json'])).toEqual({ mode: 'identity', json: true });
  });

  test.each([
    ['an unknown flag', ['--fast']],
    ['an unknown mode', ['--mode', 'experiment']],
    ['a missing mode value', ['--mode']],
  ])('%s is refused loud', (_name, argv) => {
    // Documented-but-unwired options are a real defect class in this repo (the
    // PR #19 P2 finding), so the parser is tested rather than assumed.
    expect(() => configFromArgs(argv)).toThrow(/probe-evolution/);
  });
});

describe('evolution probe: report schema and hard identity', () => {
  test('the report is well-formed, versioned, and every hard check passes', { timeout: 240000 }, async () => {
    const report = await runEvolutionProbe({ mode: 'identity', json: true });

    expect(report.schema).toBe(EVOLUTION_PROBE_SCHEMA);
    expect(EVOLUTION_PROBE_SCHEMA).toMatch(/^boxcar3d\.probe-evolution\/\d+$/);
    expect(report.mode).toBe('identity');
    expect(typeof report.disclaimer).toBe('string');
    // The disclaimer is load-bearing: it is what stops a pasted report being
    // read as an empirical result. Assert it names what it disclaims.
    expect(report.disclaimer).toMatch(/no lock authority/i);
    expect(report.disclaimer).toMatch(/PR 4/);

    // Fixture identity, echoed rather than re-derived.
    expect(report.fixture.name).toBe(EVOLUTION_FIXTURE_A.name);
    expect(report.fixture.version).toBe(EVOLUTION_FIXTURE_A.version);
    expect(report.fixture.populationSeed).toBe(EVOLUTION_FIXTURE_A.populationSeed);
    expect(report.fixture.terrainSeed).toBe(EVOLUTION_FIXTURE_A.terrainSeed);

    // Runtime and version blocks are present and non-empty.
    for (const key of ['physicsFlavor', 'packageName', 'rapierVersion', 'worldMode']) {
      expect(typeof report.runtime[key], `runtime.${key}`).toBe('string');
      expect(report.runtime[key].length).toBeGreaterThan(0);
    }
    expect(Number.isFinite(report.runtime.effectiveDt)).toBe(true);
    expect(Number.isInteger(report.runtime.executedSteps)).toBe(true);
    for (const [key, value] of Object.entries(report.versions)) {
      expect(Number.isInteger(value), `versions.${key}`).toBe(true);
    }

    // The artifact block: hex digests of the right shape, plausible lengths.
    expect(report.artifact.headerDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.artifact.historyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.artifact.generationRecordCount).toBe(EVOLUTION_FIXTURE_A.maxGenerations);
    expect(report.artifact.historyByteLength).toBeGreaterThan(report.artifact.headerByteLength);

    // Per generation: every component digest present, in the declared set.
    expect(report.generations.length).toBe(EVOLUTION_FIXTURE_A.maxGenerations);
    report.generations.forEach((g, i) => {
      expect(g.generationIndex).toBe(i);
      expect(Object.keys(g.componentDigests).sort()).toEqual([...COMPONENT_KINDS].sort());
      for (const kind of COMPONENT_KINDS) {
        expect(g.componentDigests[kind], `${kind} digest`).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(g.generationDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(g.chainedFrom).toBe(i === 0 ? 'header' : i - 1);
      expect(g.individualIds.length).toBe(EVOLUTION_FIXTURE_A.populationSize);
      expect(g.parentIndividualIds.length).toBe(EVOLUTION_FIXTURE_A.populationSize);
    });

    // The advance log mirrors the records, with the terminal last.
    expect(report.advances.length).toBe(EVOLUTION_FIXTURE_A.maxGenerations);
    expect(report.advances[report.advances.length - 1].kind).toBe('terminal');
    expect(report.advances.slice(0, -1).every((a) => a.kind === 'advanced')).toBe(true);

    // HARD CHECKS: identity-class only, and all of them must pass.
    expect(report.hard.length).toBeGreaterThanOrEqual(5);
    const failed = report.hard.filter((c) => !c.pass);
    expect(failed.map((c) => c.name), 'hard identity checks must all pass').toEqual([]);
    // …and the probe genuinely compares against the committed lock rather than
    // against itself, so a stale lock reddens the probe too.
    expect(report.artifact.historyDigest).toBe(LOCK.historyDigest);
    expect(report.hard.some((c) => /committed lock/.test(c.name))).toBe(true);
  });

  test('the probe is NOT its own oracle: it names the lock as the authority', () => {
    // The failure mode this guards is a probe that "verifies" a run against
    // values it just computed. The lock module is literals-only with zero
    // imports, so the comparison above is against a committed artifact.
    expect(typeof LOCK.historyDigest).toBe('string');
    expect(LOCK.historyDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
