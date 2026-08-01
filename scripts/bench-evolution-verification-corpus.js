// PR 4D — THE GENUINE CORPUS BUILDER (NODE-ONLY).
//
// Separate from bench-evolution-verification-artifacts.js for one structural
// reason: the corpus reproduces the committed PR-4 campaign shape through
// scripts/experiment-evolution.js, which imports node: builtins — so this
// module is Node-only, while the artifact module stays browser-safe (the
// browser bench page and the Chromium smoke test import it). The instrument
// and the Playwright driver import the corpus from here.
//
// The 8-member stratified genuine corpus (campaign protocol shape: population
// 20, 300 steps, composite corridor, isolatedWorlds, deterministic). Arms
// cover zero-mutation control, retained defaults, an aggressive arm, and a
// defaults/alt-seeds member, at both 30- and 60-record shapes. Transition
// cost is data-dependent — fitness ordering selects parents, parents select
// cloned/mutated genotypes — so the campaign-gating budgets (B1/B2) measure
// THESE histories, not one convenient synthetic shape.

import { createEvolutionRun } from '../src/sim/evolution-run.js';
import { buildExperimentProtocol, runConfigFor } from './experiment-evolution.js';

// The PR-4D bench seed block, declared in CLAUDE.md's PR-4D entry: bench
// corpus population seeds 20260800-20260807, terrain seeds 20260808-20260815.
// NEVER campaign-allocated seeds: bench artifacts are measurement inputs,
// not campaign evidence.
export const GENUINE_CORPUS_PLANS = Object.freeze([
  Object.freeze({ id: 'G1', label: 'control-30', probability: 0, magnitude: 0, generations: 30, populationSeed: 20260800, terrainSeed: 20260808 }),
  Object.freeze({ id: 'G2', label: 'defaults-30', probability: 0.05, magnitude: 0.05, generations: 30, populationSeed: 20260801, terrainSeed: 20260809 }),
  Object.freeze({ id: 'G3', label: 'aggressive-30', probability: 0.2, magnitude: 0.2, generations: 30, populationSeed: 20260802, terrainSeed: 20260810 }),
  Object.freeze({ id: 'G4', label: 'defaults-alt-30', probability: 0.05, magnitude: 0.05, generations: 30, populationSeed: 20260803, terrainSeed: 20260811 }),
  Object.freeze({ id: 'G5', label: 'control-60', probability: 0, magnitude: 0, generations: 60, populationSeed: 20260804, terrainSeed: 20260812 }),
  Object.freeze({ id: 'G6', label: 'defaults-60', probability: 0.05, magnitude: 0.05, generations: 60, populationSeed: 20260805, terrainSeed: 20260813 }),
  Object.freeze({ id: 'G7', label: 'aggressive-60', probability: 0.2, magnitude: 0.2, generations: 60, populationSeed: 20260806, terrainSeed: 20260814 }),
  Object.freeze({ id: 'G8', label: 'defaults-alt-60', probability: 0.05, magnitude: 0.05, generations: 60, populationSeed: 20260807, terrainSeed: 20260815 }),
]);

/**
 * Build ONE genuine corpus member through the production run path using the
 * committed PR-4 campaign protocol shape (buildExperimentProtocol +
 * runConfigFor imported from scripts/experiment-evolution.js — the campaign's
 * own config function, so the shape cannot drift from the campaign's).
 * `protocolKind: 'smoke'` smoke-shapes the run for CI (population 4, 20
 * steps). Returns { bytes, provenance } — provenance identifies the member
 * as 'production-run-genuine' output with its exact construction inputs.
 */
export async function buildGenuineCorpusMember(plan, { protocolKind = 'full' } = {}) {
  const protocol = buildExperimentProtocol(protocolKind);
  const runPlan = {
    runId: `bench-${plan.id}`,
    phase: 'bench',
    populationSeed: plan.populationSeed,
    terrainSeed: plan.terrainSeed,
    generations: plan.generations,
    probability: plan.probability,
    magnitude: plan.magnitude,
  };
  const config = runConfigFor(protocol, runPlan);
  const startedAt = performance.now();
  const run = createEvolutionRun(config);
  let result;
  let advanceCount = 0;
  do {
    result = await run.advance(); // sequential generations are the protocol
    advanceCount += 1;
  } while (result.kind !== 'terminal');
  const evolveMs = performance.now() - startedAt;
  const bytes = run.historyBytes();
  return Object.freeze({
    bytes,
    provenance: Object.freeze({
      construction: 'production-run-genuine',
      id: plan.id,
      label: plan.label,
      protocolKind,
      populationSize: protocol.workload.populationSize,
      generations: plan.generations,
      probability: plan.probability,
      magnitude: plan.magnitude,
      populationSeed: plan.populationSeed,
      terrainSeed: plan.terrainSeed,
      // MEASURED, never asserted from the plan: the run's actual advance
      // count and terminal verdict (an early noSelectableParents termination
      // would show up here instead of silently falsifying provenance).
      advanceCount,
      terminalReason: result.reason ?? null,
      evolveMs,
    }),
  });
}

/**
 * THE CAMPAIGN-SHAPE GATE for genuine corpus members (external review, PR
 * #37 finding 1). B1/B2 claim to measure exact 30/60-record campaign shapes,
 * so a genuine run that TERMINATED EARLY (e.g. noSelectableParents) must
 * never be published as its planned shape — not by the Node artifact record,
 * not by row assembly's kernel-call count, not by the batch draw classes,
 * and not by the browser driver's artifact metadata. This is the one shared
 * loud refusal every one of those paths calls. A member that legitimately
 * terminates early is a fine artifact for other purposes; it is not a
 * campaign-shaped corpus member.
 */
export function assertGenuineMemberShape(plan, provenance) {
  if (!provenance || !Number.isInteger(provenance.advanceCount)
    || provenance.advanceCount !== plan.generations
    || provenance.terminalReason !== 'generationLimitReached') {
    throw new Error(
      `bench: genuine corpus member '${plan.id}' did not reach its planned campaign shape — planned ${plan.generations} generations, measured advanceCount ${provenance?.advanceCount}, terminalReason '${provenance?.terminalReason}' (expected ${plan.generations} + generationLimitReached). B1/B2 cannot measure it as a planned-shape artifact`,
    );
  }
  return true;
}
