// Committed golden locks for the evolution engine, history and identity —
// MEASURED values only, updated ONLY through the deliberate re-lock workflow in
// tests/evolution-determinism.test.js (set `historyDigest` to null, run the
// gate, paste the printed JSON, then Node AND pinned Chromium must agree before
// merge).
//
// LITERALS ONLY, ZERO IMPORTS (the evaluation-locks / population-locks ruling):
// the browser gate must import the SAME constants Vite serves to Node, and
// importing live version constants would auto-track drift and defeat the
// staleness teeth that exist to catch exactly that.
//
// WHAT EACH LOCK BINDS
//   versions / runtime  — every version constant the header encodes, plus the
//                         exact physics flavor, package and engine version. A
//                         dependency bump must FAIL here deliberately rather
//                         than surface later as replay divergence.
//   effectiveDt         — the engine's f32 timestep readback
//                         (Math.fround(1/60)), carried by the evaluation
//                         metadata component precisely because the fitness
//                         vector does not carry it.
//   headerDigest        — SHA-256 over the domain-separated header.
//   per generation      — the four component digests, the chained generation
//                         digest, the terminal reason, and the payload byte
//                         length: the diagnosable form of the history digest,
//                         so a failing environment reports WHICH component of
//                         WHICH generation moved rather than "the artifact
//                         differs".
//   lineage rows        — id, parent, origin and the accounting facts needed to
//                         tell a stale literal apart from a real behavioural
//                         change. These are MEASURED values, never thresholds:
//                         this file must not assert that mutation is "enough"
//                         or that fitness is "good" — PR 4 owns every empirical
//                         claim.
//   historyDigest       — SHA-256 over the whole artifact body, and the total
//                         artifact byte length.
//
// STRUCTURAL COVERAGE, asserted by the gate rather than assumed here:
// generation 0 is all-initialized; generations 1 and 2 carry elite copies AND
// mutated children; at least one child had NO leaf selected and at least one
// had several (so both mutation branches are inside the lock); and the final
// record is terminal.
export const EVOLUTION_GOLDEN_LOCKS = Object.freeze({
  'evolution-a-small-flat': Object.freeze({
    fixtureVersion: 1,
    // --- versions --------------------------------------------------------
    evolutionEngineVersion: 1,
    evolutionPolicyVersion: 1,
    evolutionHistoryVersion: 1,
    generationRecordVersion: 1,
    evolutionLineageVersion: 1,
    evaluationMetadataVersion: 1,
    tournamentSelectionVersion: 1,
    elitismVersion: 1,
    parametricMutationVersion: 1,
    tournamentSize: 3,
    eliteCount: 2,
    populationSnapshotVersion: 1,
    populationInitializerVersion: 1,
    evaluationSpecVersion: 1,
    fitnessVectorVersion: 2,
    fitnessPolicyVersion: 2,
    integrityPolicyVersion: 1,
    genotypeVersion: 1,
    // --- runtime identity -------------------------------------------------
    physicsFlavor: 'deterministicCompat',
    packageName: '@dimforge/rapier3d-deterministic-compat',
    rapierVersion: '0.19.3',
    effectiveDt: 0.01666666753590107, // Math.fround(1/60) — the engine's f32 readback
    executedSteps: 45,
    worldMode: 'isolatedWorlds',
    // --- fixture identity -------------------------------------------------
    populationSeed: 20260742,
    terrainSeed: 20260743,
    populationSize: 6,
    maxGenerations: 3,
    mutationProbability: 0.05,
    mutationMagnitude: 0.05,
    // --- the artifact -----------------------------------------------------
    headerByteLength: 536,
  headerDigest: '6b872cadac00b3a56463bcc8e0f55b14bc290c3c0b2e04568f4fc1d9bfcce51b',
    historyByteLength: 12126,
  historyDigest: 'da573ca5f22247cba5712a96c6738f48b360330c4b54d3ba5b16a4ed1ef20e55',
    generations: Object.freeze([
      Object.freeze({
        generationIndex: 0,
        terminalReason: 'none',
        payloadByteLength: 4824,
        populationByteLength: 4224,
        populationDigest: '1edbb642b26cbd006b4406f766793a68b4a0ae3c0b3645d2733072bf34936062',
        evaluationMetadataDigest: '141f4f5dd18c1cefc2279f9e37c1cc72283c6268da79f99d6864cb69600215b6',
        fitnessVectorDigest: 'b520a4bf33491c7c0235f436743a85fd03c5410e7d13a1935bf111b725e0315e',
        lineageDigest: 'c52861e2e49e01ee126e21aed5457a7861dc88bf2828fd1a43d6fd8958fb0df5',
      generationDigest: 'dd88aa0eed1654a92b6a5fa3b3b48caf821eb275dbdb9432355160ad282f8971',
        lineage: Object.freeze([
          Object.freeze({ individualId: 0, parentIndividualId: null, origin: 'initialized', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 1, parentIndividualId: null, origin: 'initialized', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 2, parentIndividualId: null, origin: 'initialized', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 3, parentIndividualId: null, origin: 'initialized', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 4, parentIndividualId: null, origin: 'initialized', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 5, parentIndividualId: null, origin: 'initialized', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
        ]),
      }),
      Object.freeze({
        generationIndex: 1,
        terminalReason: 'none',
        payloadByteLength: 3416,
        populationByteLength: 2816,
        populationDigest: '8c0d31a262b8fe0c8d637bf6e3e08e547fef5f494dd5e406504d946fa070913d',
        evaluationMetadataDigest: '141f4f5dd18c1cefc2279f9e37c1cc72283c6268da79f99d6864cb69600215b6',
        fitnessVectorDigest: '89f39db66be9f01b96ef828156333552f7cfe805e3fecaf34f7050129685f151',
        lineageDigest: '9cef6fec4c6b1e05032f39c66d54ac4c1d269587c46405e3e8909f6945cbd1b2',
      generationDigest: '49350627ba69804ec2ec8055ba49e883305ccee3e278b7f671b49279e866a510',
        lineage: Object.freeze([
          Object.freeze({ individualId: 6, parentIndividualId: 0, origin: 'eliteCopy', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 7, parentIndividualId: 5, origin: 'eliteCopy', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 8, parentIndividualId: 0, origin: 'continuousMutation', eligibleContinuousLeafCount: 43, selectedLeafCount: 2, finalChangedLeafCount: 2, finalByteDeltaCount: 9 }),
          Object.freeze({ individualId: 9, parentIndividualId: 5, origin: 'continuousMutation', eligibleContinuousLeafCount: 56, selectedLeafCount: 1, finalChangedLeafCount: 1, finalByteDeltaCount: 6 }),
          Object.freeze({ individualId: 10, parentIndividualId: 0, origin: 'continuousMutation', eligibleContinuousLeafCount: 43, selectedLeafCount: 3, finalChangedLeafCount: 3, finalByteDeltaCount: 17 }),
          Object.freeze({ individualId: 11, parentIndividualId: 5, origin: 'continuousMutation', eligibleContinuousLeafCount: 56, selectedLeafCount: 1, finalChangedLeafCount: 1, finalByteDeltaCount: 7 }),
        ]),
      }),
      Object.freeze({
        generationIndex: 2,
        terminalReason: 'generationLimitReached',
        payloadByteLength: 3160,
        populationByteLength: 2560,
        populationDigest: 'ad488da2fb9eeb6e3568e6efd7a26c15b9708bf74c319c707f8fa7fda821a8d4',
        evaluationMetadataDigest: '141f4f5dd18c1cefc2279f9e37c1cc72283c6268da79f99d6864cb69600215b6',
        fitnessVectorDigest: '49b79393b354b6fdfba24c21cfa94c5fb75378ae7f3be98e18e6d403929272f4',
        lineageDigest: '9da05866c4bdfa487ff2958b008bf4d62ca4800b9bdd93fb5913b370758178ff',
      generationDigest: 'a1dff918a04aaa495e21d7f2f0195245ace21435826808a9bc678098358e6bd8',
        lineage: Object.freeze([
          Object.freeze({ individualId: 12, parentIndividualId: 8, origin: 'eliteCopy', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 13, parentIndividualId: 6, origin: 'eliteCopy', eligibleContinuousLeafCount: 0, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 14, parentIndividualId: 10, origin: 'continuousMutation', eligibleContinuousLeafCount: 43, selectedLeafCount: 1, finalChangedLeafCount: 1, finalByteDeltaCount: 5 }),
          // selectedLeafCount 0: an UNSELECTED mutation — the child is a
          // byte-identical copy of its tournament parent, and the lock covers
          // that branch as deliberately as it covers the selected one.
          Object.freeze({ individualId: 15, parentIndividualId: 8, origin: 'continuousMutation', eligibleContinuousLeafCount: 43, selectedLeafCount: 0, finalChangedLeafCount: 0, finalByteDeltaCount: 0 }),
          Object.freeze({ individualId: 16, parentIndividualId: 7, origin: 'continuousMutation', eligibleContinuousLeafCount: 56, selectedLeafCount: 2, finalChangedLeafCount: 2, finalByteDeltaCount: 14 }),
          Object.freeze({ individualId: 17, parentIndividualId: 8, origin: 'continuousMutation', eligibleContinuousLeafCount: 43, selectedLeafCount: 2, finalChangedLeafCount: 2, finalByteDeltaCount: 11 }),
        ]),
      }),
    ]),
  }),
});
