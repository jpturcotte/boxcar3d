"""Deliberate-sabotage sweep (plan section 17).

For each declared regression class: mutate the SOURCE, run the targeted test
file, require it to go RED, then restore the file byte-for-byte. A mutation
that stays green means the suite does not actually enforce the rule.
"""
import subprocess
import sys

MUTATIONS = [
    (
        'terminal precedence (noSelectableParents vs generationLimitReached)',
        'src/sim/evolution-run.js',
        """  if (pool.individuals.length === 0) return 'noSelectableParents';
  if (generationIndex + 1 >= maxGenerations) return 'generationLimitReached';""",
        """  if (generationIndex + 1 >= maxGenerations) return 'generationLimitReached';
  if (pool.individuals.length === 0) return 'noSelectableParents';""",
        'tests/evolution-run.test.js',
    ),
    (
        'one extra RNG draw per child',
        'src/sim/evolution-run.js',
        """    const childRng = new Rng(seed).fork(childId);
    const parentId = selectTournamentParent(pool, childRng);""",
        """    const childRng = new Rng(seed).fork(childId);
    childRng.nextFloat();
    const parentId = selectTournamentParent(pool, childRng);""",
        'tests/evolution-run.test.js',
    ),
    (
        'child-ID order (children before elites)',
        'src/sim/evolution-run.js',
        """    if (slot < eliteCount) {""",
        """    if (slot >= size - eliteCount) {""",
        'tests/evolution-determinism.test.js',
    ),
    (
        'one lineage parent (elite records its own new id)',
        'src/sim/evolution-run.js',
        """        parentIndividualId: elite.individualId,""",
        """        parentIndividualId: childId,""",
        'tests/evolution-determinism.test.js',
    ),
    (
        'one digest domain (population)',
        'src/sim/evolution-history.js',
        """  population: 'boxcar3d/evolution-history/population/v1\\0',""",
        """  population: 'boxcar3d/evolution-history/population/v2\\0',""",
        'tests/evolution-history.test.js',
    ),
    (
        'verification ORDER (whole-history digest before component digests)',
        'src/sim/evolution-replay.js',
        """  // Stage 5: every component digest, in generation order. One payload at a
  // time; nothing decoded is retained (see the memory model above).""",
        """  {
    const early = await digestHistoryBody(framing.body);
    if (!digestsEqual(early, framing.historyDigestBytes)) {
      evolutionFail('historyDigestMismatch', 'early whole-history check', {});
    }
  }""",
        'tests/evolution-replay.test.js',
    ),
    (
        'the runtime version check',
        'src/sim/evolution-replay.js',
        """    ['rapierVersion', header.rapierVersion, runtime.rapierVersion],""",
        """""",
        'tests/evolution-replay.test.js',
    ),
    (
        'a component-length ceiling',
        'src/sim/evolution-history.js',
        """    if (length > MAX_EVOLUTION_COMPONENT_BYTES) {
      limitFail(`components.${kind}.byteLength`, length, MAX_EVOLUTION_COMPONENT_BYTES);
    }""",
        """""",
        'tests/evolution-history.test.js',
    ),
    (
        'copy-before-await in the SHA-256 adapter',
        'src/platform/sha256.js',
        """  const input = copyOrdinaryBytes(bytes, fail); // synchronous: validate + own
  return digestOwned(input);""",
        """  return digestOwned(bytes);""",
        'tests/sha256.test.js',
    ),
    (
        'the fresh history copy (return the internal buffer)',
        'src/sim/evolution-run.js',
        """    return copyOrdinaryBytes(this.#historyBytes, bytesFail);""",
        """    return this.#historyBytes;""",
        'tests/evolution-run.test.js',
    ),
    (
        'the trace-mode-none physics seam',
        'src/sim/population-evaluation.js',
        """      trace: { mode: 'none' },""",
        """      trace: { mode: 'digest' },""",
        'tests/evolution-run.test.js',
    ),
    (
        'the generation chain (chain gen 0 from itself, not the header)',
        'src/sim/evolution-run.js',
        """    const previousDigestBytes = this.#generations.length === 0
      ? headerDigestBytes
      : this.#generations[this.#generations.length - 1].generationDigestBytes;""",
        """    const previousDigestBytes = this.#generations.length === 0
      ? new Uint8Array(32)
      : this.#generations[this.#generations.length - 1].generationDigestBytes;""",
        'tests/evolution-determinism.test.js',
    ),
]


def run(test_file):
    proc = subprocess.run(
        ['npx', 'vitest', 'run', test_file],
        capture_output=True, text=True, encoding='utf-8', errors='replace', shell=True,
    )
    return proc.returncode


def main():
    results = []
    for name, path, old, new, test_file in MUTATIONS:
        original = open(path, encoding='utf-8').read()
        if old not in original:
            results.append((name, 'ANCHOR MISS', path))
            continue
        try:
            open(path, 'w', encoding='utf-8').write(original.replace(old, new, 1))
            code = run(test_file)
            results.append((name, 'BITES' if code != 0 else 'SILENT', test_file))
        finally:
            open(path, 'w', encoding='utf-8').write(original)
        print(f'{results[-1][1]:12} {name}  [{test_file}]', flush=True)
    silent = [r for r in results if r[1] != 'BITES']
    print('\n--- summary ---')
    for name, verdict, where in results:
        print(f'{verdict:12} {name}')
    if silent:
        print(f'\n{len(silent)} mutation(s) did NOT bite')
        sys.exit(1)
    print(f'\nall {len(results)} mutations bite')


main()


