// PR 4A — the deterministic N -> N+1 transition kernel: static boundary pins
// and an INDEPENDENT correctness oracle.
//
// The kernel (src/sim/evolution-transition.js) is an INTERNAL seam: the one
// authorized production importer today is evolution-run.js, and PR 4B will
// deliberately extend the allowlist with evolution-replay.js when the
// verified-artifact path starts reproducing persisted transitions. That
// allowlist is DECLARED below and pinned over every reference form, so an
// accidental production re-export or a second importer fails a build.
//
// ============================================================================
// THE ORACLE'S CLAIM BOUNDARY (read before trusting it)
// ============================================================================
//
// Moving deriveNextGeneration into a kernel and watching the existing suite
// stay green proves only behavior CONTINUITY. It does not protect against
// extracting a subtly wrong transition that the producer and the future PR 4B
// verifier will then share — the tautology the PR 4 split exists to avoid.
// The oracle below therefore derives its expected transition INDEPENDENTLY:
//
// NEVER CALLED to compute an expected result (the central subjects of the
// oracle): deriveNextGeneration, runGeneration, createEvolutionRun,
// selectElites, selectTournamentParent, mutateContinuousGenotype, any wrapper
// around them, and any fixture captured from the implementation under test.
// Elite ranking, the tournament winner, every mutation decision/delta/clamp,
// and all eleven accounting counters are re-derived inline from documented
// semantics with hand-written comparators and arithmetic, and the derived
// facts are asserted against COMMITTED literals so a reviewer reads the claim
// without re-running anything.
//
// SHARED lower-level primitives (locked elsewhere; NOT proven here):
//   - Rng (src/sim/prng.js) — the per-child stream derivation. The committed
//     tournament uint32 draws and mutation float draws pin the stream inside
//     this oracle too, but the xoshiro128** algorithm itself is proven by the
//     PRNG locks, not here.
//   - The canonical codecs (population, genotype, lineage serialize /
//     deserialize) and fnv1aFold — expected LOGICAL populations and lineages
//     are derived independently, then serialized through the shared codec;
//     this proves transition COMPOSITION, not codec internals (the codec
//     round-trip and golden-fixture tests prove those).
//   - compileAssembly / forEachGenotypeField / repairGenotype
//     (src/sim/assembly.js) — fixture preparation and the repair step of the
//     expected derivation. The expected field-walk PATHS are asserted against
//     committed literals, so a walk-order change fails this oracle rather
//     than being inherited from the shared walk.
//   - Policy literals ELITE_COUNT = 2 and TOURNAMENT_SIZE = 3, written as
//     literals here and pinned to the production constants in
//     tests/evolution-operators.test.js.
//
// PROVES: transition composition — canonical elite rank/order/count, the
// lower-id fitness tie-break, fresh-ID allocation, elite parent retention,
// the per-child RNG fork keyed by the FRESH child id, draw order (3 uint32
// tournament draws, then one decision float per eligible leaf, then one unit
// float per selected leaf), tournament sampling with replacement, the repair
// invocation point, final-vs-raw genotype selection (Case B is repair-
// sensitive: retaining rawGenotype instead of genotype changes the bytes),
// accounting propagation, population member order, lineage row order, and
// byte-exact serialization of the composed result.
//
// DOES NOT PROVE: the Rng algorithm, codec internals, repair's internal
// rules, or the selection/mutation operators against their own specs — all
// independently locked by their own suites. The immediate-decode and
// cross-check proof OBLIGATIONS (that the kernel re-decodes what it encoded,
// and cross-checks the decoded lineage against the decoded population and the
// preceding generation's ids) are pinned source-statically below, because
// they are unobservable from the outside when the input is well-formed.

import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Linter } from 'eslint';

import { deriveNextGeneration } from '../src/sim/evolution-transition.js';
import * as EvolutionRunNS from '../src/sim/evolution-run.js';
import { EvolutionError } from '../src/sim/evolution-contract.js';
import { Rng } from '../src/sim/prng.js';
import {
  compileAssembly, deserializeGenotype, forEachGenotypeField, repairGenotype, serializeGenotype,
} from '../src/sim/assembly.js';
import {
  POPULATION_SNAPSHOT_VERSION, deserializePopulationSnapshot, serializePopulationSnapshot,
} from '../src/sim/population.js';
import {
  EVOLUTION_LINEAGE_VERSION, deserializeLineage, serializeLineage,
} from '../src/sim/evolution-lineage.js';
import { FNV_OFFSET_BASIS, fnv1aFold } from '../src/sim/fnv1a.js';
import {
  FITNESS_POLICY_VERSION, SELECTION_POOL_VERSION,
} from '../src/sim/population-evaluation.js';

const KERNEL = 'src/sim/evolution-transition.js';

// ============================================================================
// (1) THE PRODUCTION IMPORTER / RE-EXPORT GUARD
// ============================================================================
//
// THE DECLARED production importer allowlist. Exactly one entry today; PR 4B
// adds 'src/sim/evolution-replay.js' here BY DECISION, with its own review —
// this set is pinned, not eternal. Tests import the kernel directly BY DESIGN
// (the declared test allowlist); the scan below walks EVERY local module, so
// both sets are pinned globally, not by directory convention.
const AUTHORIZED_PRODUCTION_IMPORTERS = Object.freeze({
  'src/sim/evolution-run.js': true,
});
const AUTHORIZED_TEST_IMPORTERS = Object.freeze({
  'tests/evolution-transition.test.js': true,
  'tests/ownership-boundary.test.js': true,
  'tests/single-read.test.js': true,
});

const walkModules = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walkModules(`${dir}/${e.name}`) : (/\.m?js$/.test(e.name) ? [`${dir}/${e.name}`] : [])
));

// Resolve a LOCAL specifier against the importing file and NORMALIZE to the
// repo-relative forward-slash form, so './evolution-transition.js',
// './evolution-transition', '../sim/evolution-transition.js' and the
// Vite-root-absolute '/src/sim/evolution-transition.js' all canonicalize to
// the one module path. Query/hash suffixes are stripped (Vite resolves
// them), and a '..' that would escape the repo never normalizes INTO it
// (round-3 review, I4). Root-absolute specifiers resolve against the REPO
// ROOT — Vite's documented behavior and this repo's own entry convention
// (index.html boots /src/main.js); the round-4 review showed a '.'-only
// model missed that whole class. Bare/package specifiers are NOT modeled:
// vite.config.js declares no resolve.alias, so no bare specifier can resolve
// to the kernel in this repo — a future alias that could reach it must be
// added to this resolver BY DECISION, with this guard updated in the same
// change.
function normalizeSpecifier(fromFile, spec) {
  const clean = spec.split(/[?#]/, 1)[0];
  const slash = fromFile.lastIndexOf('/');
  const dir = slash === -1 ? '' : fromFile.slice(0, slash);
  const baseParts = clean.startsWith('/') ? [] : dir.split('/');
  const out = [];
  for (const part of [...baseParts, ...clean.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return '<outside-repo>';
      out.pop();
    } else out.push(part);
  }
  const joined = out.join('/');
  return joined.endsWith('.js') ? joined : `${joined}.js`;
}

// ============================================================================
// THE AST REFERENCE SCANNER
// ============================================================================
//
// Round-3 external review (converging with the Codex bot's P2) killed the
// first version of this guard honestly: single-quote-only regexes missed
// double quotes, no-substitution template literals and zero-whitespace forms;
// the cycle walk traversed only two of the four module edge forms; and a
// computed import() was a documented residual. Scanning is now done on the
// PARSED module — espree through eslint's Linter, a devDependency the repo
// already has (the ownership-boundary F2 test uses the same programmatic
// route; NO new dependency, the lockfile is untouched) — over the four edge
// node types: ImportDeclaration, ExportNamedDeclaration.source,
// ExportAllDeclaration.source and ImportExpression. Quote style, whitespace,
// semicolons, comments and escape sequences can no longer matter, because the
// parser cooks them all before the guard ever sees a specifier.
//
// What is NOT modeled, deliberately — each item a recorded decision, not an
// oversight: bare/package specifiers (no resolve.alias exists, so none can
// reach the kernel; adding such an alias obligates updating the resolver
// above); the HTML entry extraction assumes this repo's own simple
// index.html (a NEW .html entrypoint must be added to ENTRYPOINT_FILES by
// decision); and anything that is not a literal local module edge is REFUSED
// rather than modeled — computed dynamic import() specifiers and Vite's
// import.meta.glob / globEager (which Vite rewrites into real imports that
// never appear in the authored source) are rejected in every scanned module.
//
// Round-4 external review closure: the round-3 version still walked only
// src/ + scripts and only '.'-relative specifiers, recording a src ->
// tests-helper -> kernel trampoline and index.html's inline module script as
// "accepted residuals" — ordinary production-graph escapes, demonstrated
// against that guard before this rewrite. There is no directory-defined
// "production" anymore: src/, scripts/, tests/, legacy/, the root config
// modules and the HTML entry's module scripts are ALL scanned, the kernel
// importer set is pinned globally (production allowlist + declared test
// allowlist), and a separate pin forbids any src/ module importing the
// tests/ tree at all.

const linter = new Linter();

// One parse per module. The rule visitors collect every module edge plus the
// call/declarator nodes the canonicalization pin consumes; the rule reports
// nothing, so a nonempty message list means the file did not parse — itself
// a failure.
function analyzeSource(file, code) {
  const refs = [];
  const calls = [];
  const declarators = [];
  const summarize = (node) => {
    if (node === null || node === undefined) return null;
    if (node.type === 'Identifier') return { type: 'Identifier', name: node.name };
    if (node.type === 'CallExpression') {
      return {
        type: 'CallExpression',
        calleeName: node.callee.type === 'Identifier' ? node.callee.name : null,
        args: node.arguments.map(summarize),
      };
    }
    return { type: node.type };
  };
  const specifierOf = (node) => {
    if (node.type === 'Literal') return { literal: true, value: node.value };
    // A no-substitution template literal IS a static specifier — the parser
    // has already cooked it. Anything with expressions is computed.
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
      return { literal: true, value: node.quasis[0].value.cooked };
    }
    return { literal: false, value: null };
  };
  const collect = {
    create() {
      return {
        ImportDeclaration: (node) => refs.push({ form: 'static', ...specifierOf(node.source) }),
        ExportNamedDeclaration: (node) => {
          if (node.source !== null) refs.push({ form: 're-export', ...specifierOf(node.source) });
        },
        ExportAllDeclaration: (node) => refs.push({ form: 're-export-star', ...specifierOf(node.source) }),
        ImportExpression: (node) => refs.push({ form: 'dynamic', ...specifierOf(node.source) }),
        CallExpression: (node) => {
          // Vite's import.meta.glob / globEager are transformed by Vite into
          // real static or dynamic imports — a kernel reference through them
          // leaves NO ImportDeclaration/ImportExpression in the authored
          // source (round-4 review). Classified as their own edge form and
          // REFUSED in every scanned module below (the repo uses neither).
          const callee = node.callee;
          if (callee.type === 'MemberExpression'
            && callee.object.type === 'MetaProperty'
            && callee.object.meta.name === 'import'
            && callee.object.property.name === 'meta'
            && callee.property.type === 'Identifier'
            && (callee.property.name === 'glob' || callee.property.name === 'globEager')) {
            refs.push({ form: 'import-meta-glob', literal: false, value: null });
          }
          calls.push({
            name: node.callee.type === 'Identifier' ? node.callee.name : null,
            pos: node.range[0],
            args: node.arguments.map(summarize),
          });
        },
        VariableDeclarator: (node) => declarators.push({
          name: node.id.type === 'Identifier' ? node.id.name : null,
          init: summarize(node.init),
        }),
      };
    },
  };
  const messages = linter.verify(code, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { probe: { rules: { collect } } },
    rules: { 'probe/collect': 'error' },
  }, file);
  const fatal = messages.find((m) => m.fatal);
  expect(fatal === undefined, `${file} must parse as an ES module (${fatal && fatal.message})`).toBe(true);
  return { refs, calls, declarators };
}

const analyzeModule = (file) => analyzeSource(file, readFileSync(file, 'utf8'));

// Only literal LOCAL specifiers can resolve into the repo: '.'-relative or
// Vite-root-absolute ('/src/...' — the round-4 escape class). Bare specifiers
// cannot (no resolve.alias — see normalizeSpecifier).
function localLiteralEdges(file, refs) {
  return refs
    .filter((r) => r.literal && typeof r.value === 'string'
      && (r.value.startsWith('.') || r.value.startsWith('/')))
    .map((r) => ({ form: r.form, resolved: normalizeSpecifier(file, r.value) }));
}

// The HTML entry's module scripts are part of Vite's production module graph
// — external src= (root-absolute against the repo root: index.html boots
// /src/main.js) AND inline <script type="module"> code. Extracted as scan
// units so the guard sees the ACTUAL entry surface (round-4 review). The
// extraction is deliberately small and assumes this repo's own simple entry
// file; inline units get virtual labels so a failure names the block.
function htmlEntryUnits(file, html) {
  const units = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let inlineCount = 0;
  while ((match = scriptPattern.exec(html)) !== null) {
    const attrs = match[1];
    if (!/type\s*=\s*["']module["']/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (src !== null) {
      units.push({ label: file, refs: [{ form: 'html-script-src', literal: true, value: src[1] }] });
    } else {
      // The virtual label ends in .js so eslint's default file matching
      // actually applies the probe config to it (an extensionless label is
      // silently skipped by the Linter — no parse, no refs, no fatal).
      const label = `${file}#inline-module-${inlineCount}.js`;
      inlineCount += 1;
      units.push({ label, refs: analyzeSource(label, match[2]).refs });
    }
  }
  return units;
}

// One file -> one or more scan units ({ label, refs }): a JS/ESM module is a
// single unit; an HTML entry contributes one unit per module script.
const analyzeEntryUnits = (file) => (/\.html$/.test(file)
  ? htmlEntryUnits(file, readFileSync(file, 'utf8'))
  : [{ label: file, refs: analyzeModule(file).refs }]);

// The reachability walk, injectable so the adversarial self-tests can feed it
// a synthetic graph.
function reachableFrom(start, refsOfFile) {
  const closure = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop();
    if (closure.has(file)) continue;
    closure.add(file);
    for (const edge of localLiteralEdges(file, refsOfFile(file))) stack.push(edge.resolved);
  }
  return closure;
}

// EVERY local module is scanned — there is no directory-defined "production"
// (round-4 review: the src+scripts walk left a src -> tests-helper -> kernel
// trampoline and the HTML entry as escapes). The root sweep picks up the
// config modules (vite/vitest/eslint); a new root-level module or a new
// .html entrypoint is scanned automatically / added to ENTRYPOINT_FILES.
const SCANNED_FILES = Object.freeze([
  ...walkModules('src'),
  ...walkModules('scripts'),
  ...walkModules('tests'),
  ...walkModules('legacy'),
  ...readdirSync('.', { withFileTypes: true })
    .filter((e) => e.isFile() && /\.m?js$/.test(e.name))
    .map((e) => e.name),
]);
const ENTRYPOINT_FILES = Object.freeze(['index.html']);

describe('the production importer / re-export guard', () => {
  // Parses every local module through espree — the full-tree scan is slow
  // under full-suite CPU contention, so it carries the repo's explicit
  // per-test timeout idiom rather than the 5 s default.
  test('exactly the declared allowlist references the kernel, over every local module and every module edge form', { timeout: 60000 }, () => {
    expect(SCANNED_FILES.length).toBeGreaterThan(60); // the walk is not vacuous
    // The scan REALLY covers the round-4 surfaces: a future refactor that
    // quietly drops tests/, helpers, or the root configs from it fails here.
    expect(SCANNED_FILES).toContain('tests/evolution-transition.test.js');
    expect(SCANNED_FILES).toContain('tests/helpers/evolution-artifacts.js');
    expect(SCANNED_FILES).toContain('legacy/PhysicsController.js');
    expect(SCANNED_FILES).toContain('vite.config.js');
    const importers = {};
    const computed = {};
    const globEdges = {};
    for (const file of [...SCANNED_FILES, ...ENTRYPOINT_FILES]) {
      for (const unit of analyzeEntryUnits(file)) {
        for (const ref of unit.refs) {
          if (ref.form === 'import-meta-glob') {
            globEdges[unit.label] = (globEdges[unit.label] ?? 0) + 1;
            continue;
          }
          if (ref.form === 'dynamic' && !ref.literal) {
            computed[unit.label] = (computed[unit.label] ?? 0) + 1;
            continue;
          }
          if (ref.literal && typeof ref.value === 'string'
            && (ref.value.startsWith('.') || ref.value.startsWith('/'))
            && normalizeSpecifier(unit.label, ref.value) === KERNEL) {
            (importers[unit.label] = importers[unit.label] ?? []).push(ref.form);
          }
        }
      }
    }
    expect(Object.keys(importers).sort()).toEqual(Object.keys({
      ...AUTHORIZED_PRODUCTION_IMPORTERS, ...AUTHORIZED_TEST_IMPORTERS,
    }).sort());
    for (const [file, forms] of Object.entries(importers)) {
      expect(forms, `${file} may only STATIC-import the kernel`).toEqual(['static']);
    }
    // Computed dynamic import() is REFUSED in every scanned module — the
    // round-3 two-file count allowlist pinned counts but not targets (a
    // retargeted variable left the count unchanged); the rapier probes and
    // the physics smoke now select between LITERAL loaders instead, so no
    // exception exists at all.
    expect(computed, 'computed dynamic import() is refused in every scanned module').toEqual({});
    expect(globEdges, 'import.meta.glob is refused in every scanned module (Vite rewrites it into real imports)').toEqual({});
  });

  test('no src/ module reaches into the tests tree — the trampoline class is closed, not recorded', () => {
    for (const file of walkModules('src')) {
      for (const edge of localLiteralEdges(file, analyzeModule(file).refs)) {
        expect(edge.resolved.startsWith('tests/'), `${file} must not import the tests tree (${edge.resolved})`).toBe(false);
      }
    }
  });

  test('evolution-run.js does not hand the kernel function out under any name', () => {
    // Re-export edges are covered by the scan above (a re-export of the kernel
    // would be a non-'static' kernel reference from this file). This is the
    // rename-proof runtime leg: NO value reachable from the run module's
    // namespace may BE the kernel's function, whatever local alias carried it.
    for (const key of Object.keys(EvolutionRunNS)) {
      expect(EvolutionRunNS[key], `evolution-run.js export ${key} must not be the kernel function`)
        .not.toBe(deriveNextGeneration);
    }
  });
});

// ============================================================================
// (2) CYCLE-FREE PLACEMENT
// ============================================================================

describe('cycle-free placement', () => {
  test('the kernel imports exactly the five declared lower-level modules', () => {
    const edges = localLiteralEdges(KERNEL, analyzeModule(KERNEL).refs);
    expect(edges.map((e) => e.form)).toEqual(['static', 'static', 'static', 'static', 'static']);
    expect(edges.map((e) => e.resolved).sort()).toEqual([
      'src/sim/evolution-contract.js',
      'src/sim/evolution-lineage.js',
      'src/sim/evolution-operators.js',
      'src/sim/population.js',
      'src/sim/prng.js',
    ]);
  });

  test('neither run orchestration nor replay verification is reachable from the kernel, over every edge form', () => {
    const closure = reachableFrom(KERNEL, (f) => analyzeModule(f).refs);
    expect(closure.has('src/sim/evolution-run.js')).toBe(false);
    expect(closure.has('src/sim/evolution-replay.js')).toBe(false);
  });
});

// ============================================================================
// (2b) THE SCANNER ITSELF, ADVERSARIALLY
// ============================================================================
//
// A guard that cannot be shown to bite is a comment with regexes in it. Every
// escape the round-2, round-3 and round-4 reviews demonstrated is fed to the
// scanner here as a synthetic source.

describe('the reference scanner itself, adversarially', () => {
  const FAKE = 'src/sim/probe-target.js';
  const kernelEdges = (code) => localLiteralEdges(FAKE, analyzeSource(FAKE, code).refs)
    .filter((e) => e.resolved === KERNEL);

  test('double quotes, zero whitespace and a missing semicolon are all seen', () => {
    expect(kernelEdges('import { deriveNextGeneration } from "./evolution-transition.js";')).toHaveLength(1);
    expect(kernelEdges("import{x}from'./evolution-transition.js'")).toHaveLength(1);
    expect(kernelEdges("import { d } from './evolution-transition.js'")).toHaveLength(1);
  });

  test('a no-substitution template literal is a literal specifier; a computed one is refusal material', () => {
    const [templated] = kernelEdges('const p = import(`./evolution-transition.js`);');
    expect(templated.form).toBe('dynamic');
    expect(analyzeSource(FAKE, "const p = import('./evolution-' + 'transition.js');").refs)
      .toEqual([{ form: 'dynamic', literal: false, value: null }]);
  });

  test('query/hash suffixes and cooked escape sequences normalize to the real module', () => {
    expect(kernelEdges("import './evolution-transition.js?v=2';")).toHaveLength(1);
    expect(kernelEdges("import './evolution-transition.js#fragment';")).toHaveLength(1);
    expect(kernelEdges("import x from './evolution-transition\\u002ejs';")).toHaveLength(1);
  });

  test('a re-export edge creates a cycle the closure must see', () => {
    const graph = new Map([
      [KERNEL, "export {} from './evolution-run.js';"],
      ['src/sim/evolution-run.js', "import { deriveNextGeneration } from './evolution-transition.js';"],
    ]);
    const closure = reachableFrom(KERNEL, (f) => analyzeSource(f, graph.get(f) ?? '').refs);
    expect(closure.has('src/sim/evolution-run.js')).toBe(true);
  });

  test('a call that lives only in a comment produces NO call nodes', () => {
    const masked = '// crossCheckLineage(deserializeLineage(lineageBytes), nextGenerationIndex, populationIds(decoded), currentIds);\nconst x = 1;';
    expect(analyzeSource(KERNEL, masked).calls).toEqual([]);
  });

  test('a Vite root-absolute specifier resolves against the repo root and is seen (round-4)', () => {
    expect(kernelEdges("import { d } from '/src/sim/evolution-transition.js';")).toHaveLength(1);
    expect(kernelEdges("const p = import('/src/sim/evolution-transition.js');")).toHaveLength(1);
    expect(kernelEdges("export { d } from '/src/sim/evolution-transition.js';")).toHaveLength(1);
  });

  test('import.meta.glob is its own refused edge form — Vite rewrites it into real imports (round-4)', () => {
    expect(analyzeSource(FAKE, "const m = import.meta.glob('/src/sim/evolution-transition.js', { eager: true });").refs)
      .toEqual([{ form: 'import-meta-glob', literal: false, value: null }]);
    expect(analyzeSource(FAKE, "const m = import.meta.globEager('./evolution-*.js');").refs)
      .toEqual([{ form: 'import-meta-glob', literal: false, value: null }]);
  });

  test('the HTML entry surface: src= and inline module scripts are scanned (round-4)', () => {
    const units = htmlEntryUnits('index.html', [
      '<!doctype html><html><body>',
      '<script type="module" src="/src/main.js"></script>',
      '<script type="module">',
      "  import { deriveNextGeneration } from '/src/sim/evolution-transition.js';",
      '  window.leakedKernel = deriveNextGeneration;',
      '</script>',
      '<script>not a module — ignored</script>',
      '</body></html>',
    ].join('\n'));
    expect(units).toHaveLength(2);
    expect(units[0]).toEqual({
      label: 'index.html',
      refs: [{ form: 'html-script-src', literal: true, value: '/src/main.js' }],
    });
    expect(units[1].label).toBe('index.html#inline-module-0.js');
    // The inline kernel import normalizes to the kernel from the virtual label.
    expect(localLiteralEdges(units[1].label, units[1].refs).map((e) => e.resolved)).toEqual([KERNEL]);
  });
});

// ============================================================================
// (3) THE CANONICALIZATION-SEQUENCE PIN (AST-static, dataflow-bound)
// ============================================================================
//
// The immediate population decode and the lineage decode + cross-check are
// PROOF OBLIGATIONS: with a well-formed input they leave no observable trace,
// so no value-level test can see them being skipped. Pinned on the PARSED
// module — the round-3 review showed the raw-text version could be masked by
// a comment holding the original call text, and bound nothing: this version
// asserts the ARGUMENT SHAPES and the DECLARATOR INITIALIZERS, so the bytes
// that are decoded are provably the bytes that were encoded, and a call that
// lives only in a comment produces no nodes at all (self-tested above).

describe('the canonicalization sequence (AST-static)', () => {
  const { calls, declarators } = analyzeModule(KERNEL);
  const byName = (name) => calls.filter((c) => c.name === name);
  const only = (name) => {
    expect(byName(name), `exactly one ${name} call`).toHaveLength(1);
    return byName(name)[0];
  };
  const declarator = (name) => {
    const found = declarators.filter((d) => d.name === name);
    expect(found, `exactly one binding of ${name}`).toHaveLength(1);
    return found[0];
  };

  test('population serialize -> immediate decode -> lineage serialize -> decode + cross-check, each exactly once, in that order, bound by dataflow', () => {
    const serPop = only('serializePopulationSnapshot');
    const decPop = only('deserializePopulationSnapshot');
    const serLin = only('serializeLineage');
    const cross = only('crossCheckLineage');
    expect(decPop.pos).toBeGreaterThan(serPop.pos);
    expect(serLin.pos).toBeGreaterThan(decPop.pos);
    expect(cross.pos).toBeGreaterThan(serLin.pos);
    // The binding, not the text: `decoded` IS the decode of `populationBytes`,
    // and `populationBytes`/`lineageBytes` ARE the two serializations.
    expect(declarator('populationBytes').init)
      .toMatchObject({ type: 'CallExpression', calleeName: 'serializePopulationSnapshot' });
    expect(declarator('decoded').init).toMatchObject({
      type: 'CallExpression',
      calleeName: 'deserializePopulationSnapshot',
      args: [{ type: 'Identifier', name: 'populationBytes' }],
    });
    expect(declarator('lineageBytes').init)
      .toMatchObject({ type: 'CallExpression', calleeName: 'serializeLineage' });
  });

  test('the cross-check consumes the DECODED lineage, the DECODED population ids, and the PRECEDING generation ids', () => {
    expect(only('crossCheckLineage').args).toEqual([
      { type: 'CallExpression', calleeName: 'deserializeLineage', args: [{ type: 'Identifier', name: 'lineageBytes' }] },
      { type: 'Identifier', name: 'nextGenerationIndex' },
      { type: 'CallExpression', calleeName: 'populationIds', args: [{ type: 'Identifier', name: 'decoded' }] },
      { type: 'Identifier', name: 'currentIds' },
    ]);
  });
});

// ============================================================================
// (4) THE INDEPENDENT ORACLE
// ============================================================================
//
// Fixture shape copy-declared from tests/evolution-operators.test.js:19-45
// (extended with a hue parameter so members carry distinct genotype bytes).
// compileAssembly(...).genotype is the repaired canonical clone — fixture
// preparation only, under the stated boundary.

function genotype(axles = 0, hue = 0.5) {
  const axle = () => ({
    posX01: 0.5, paired: 1, trackHalf: 0.5, radius: 0.5, width: 0.5, density: 0.5,
    suspType: 0, stiffness: 0.5, damping: 0.5, travel: 0.5, restLength: 0.5,
    driven: 1, share: 0.5, asym: { driveBias: 0.5, sizeBias: 0.5, centerOffset: 0.5 },
  });
  return {
    version: 1, hue, symmetric: 1, power: 0.5, frameDensity: 0.5,
    frame: {
      family: 0, segments: [{ nodeCount: 0.5,
        nodes: Array.from({ length: 6 }, () => ({ gap: 0.5, height: 0.5, halfWidth: 0.5, thickness: 0.5 })),
        fam: { spine: { beamWidthFrac: 0.5 }, ladder: { crossFrac: 0.5 }, hull: { bulge: 0.5 } },
      }],
    },
    axles: Array.from({ length: axles }, axle),
  };
}

const canonical = (axles, hue) => compileAssembly(genotype(axles, hue)).genotype;

function oraclePool(population, rows) {
  return Object.freeze({
    selectionPoolVersion: SELECTION_POOL_VERSION,
    fitnessPolicyVersion: FITNESS_POLICY_VERSION,
    // The same-source FNV sentinel, folded over the population's own canonical
    // bytes — exactly the value production computes from the decoded vector.
    populationSnapshotDigestState: fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population)),
    evaluatedIndividualIds: Object.freeze(rows.map((r) => r.individualId)),
    individuals: Object.freeze(rows.map((r) => Object.freeze(r))),
  });
}

const fieldRows = (g) => {
  const rows = [];
  forEachGenotypeField(g, (e) => rows.push(e));
  return rows;
};

// --- The independent derivation. Hand-written arithmetic over the shared ---
// --- primitives named in the header; NEVER the production operators.      ---

// Policy literals, pinned to the production constants in
// tests/evolution-operators.test.js — written out here so this file never
// imports the module whose composition it checks.
const ORACLE_ELITE_COUNT = 2;
const ORACLE_TOURNAMENT_SIZE = 3;

// Canonical fitness ranking: higher fitness first, ties to the LOWER id.
const oracleRanksHigher = (a, b) => a.fitness > b.fitness
  || (a.fitness === b.fitness && a.individualId < b.individualId);

function oracleEliteIds(rows) {
  const ranked = [...rows].sort((a, b) => (oracleRanksHigher(a, b) ? -1 : (oracleRanksHigher(b, a) ? 1 : 0)));
  return ranked.slice(0, ORACLE_ELITE_COUNT).map((r) => r.individualId);
}

// Three replacement samples from the child's own stream, best of three by the
// canonical ranking. Returns the committed-draw evidence as well as the winner.
function oracleTournament(childRng, rows) {
  const draws = [];
  let winner = null;
  for (let i = 0; i < ORACLE_TOURNAMENT_SIZE; i += 1) {
    const draw = childRng.nextUint32();
    draws.push(draw);
    const candidate = rows[draw % rows.length];
    if (winner === null || oracleRanksHigher(candidate, winner)) winner = candidate;
  }
  return { draws, winnerId: winner.individualId };
}

// The continuous-mutation semantics, re-derived: one decision float per
// eligible (continuous f64) leaf in field-walk order; a selected leaf draws
// one unit float, applies delta = (2*unit - 1) * magnitude, clamps the
// proposal to [0,1], and writes only when delta !== 0. Then exactly one
// repair, and the final genotype is the CANONICAL repaired form. Counters
// compared leaf-by-leaf with Object.is, byte deltas counted byte-by-byte.
function oracleMutation(parentGenotype, childRng, mutation) {
  const parentFields = fieldRows(parentGenotype);
  const parentBytes = serializeGenotype(parentGenotype);
  const rawBytes = new Uint8Array(parentBytes);
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  let eligibleContinuousLeafCount = 0;
  let selectedLeafCount = 0;
  let clampedLeafCount = 0;
  const selectedLeaves = [];
  for (let i = 0; i < parentFields.length; i += 1) {
    const entry = parentFields[i];
    if (!(entry.kind === 'continuous' && entry.type === 'f64')) continue;
    eligibleContinuousLeafCount += 1;
    const decision = childRng.nextFloat();
    if (decision >= mutation.probability) continue;
    selectedLeafCount += 1;
    const unit = childRng.nextFloat();
    const current = view.getFloat64(entry.byteOffset, true);
    const delta = (2 * unit - 1) * mutation.magnitude;
    const proposal = current + delta;
    let value = proposal;
    if (proposal < 0) { value = 0; clampedLeafCount += 1; } else if (proposal > 1) { value = 1; clampedLeafCount += 1; }
    if (delta !== 0) view.setFloat64(entry.byteOffset, value, true);
    selectedLeaves.push(Object.freeze({ path: entry.path, decision, unit, value }));
  }
  const rawGenotype = deserializeGenotype(rawBytes);
  const rawBytesCanonical = serializeGenotype(rawGenotype);
  // Shared repair primitive, under the stated boundary: repair's INTERNAL
  // rules are not proven here; its INVOCATION POINT and its effect on the
  // composed result are.
  const finalGenotype = deserializeGenotype(serializeGenotype(repairGenotype(rawGenotype)));
  const finalBytes = serializeGenotype(finalGenotype);
  const rawFields = fieldRows(rawGenotype);
  const finalFields = fieldRows(finalGenotype);
  let rawChangedLeafCount = 0;
  let repairChangedLeafCount = 0;
  let repairIntroducedLeafCount = 0;
  let repairErasedLeafCount = 0;
  let repairRedirectedLeafCount = 0;
  let finalChangedLeafCount = 0;
  const repairTouched = [];
  for (let i = 0; i < parentFields.length; i += 1) {
    const p = parentFields[i];
    if (!(p.kind === 'continuous' && p.type === 'f64')) continue;
    const rawChanged = !Object.is(p.value, rawFields[i].value);
    const finalChanged = !Object.is(p.value, finalFields[i].value);
    const repairChanged = !Object.is(rawFields[i].value, finalFields[i].value);
    if (rawChanged) rawChangedLeafCount += 1;
    if (finalChanged) finalChangedLeafCount += 1;
    if (repairChanged) repairChangedLeafCount += 1;
    let classification = null;
    if (!rawChanged && finalChanged) { repairIntroducedLeafCount += 1; classification = 'introduced'; } else if (rawChanged && !finalChanged) { repairErasedLeafCount += 1; classification = 'erased'; } else if (rawChanged && repairChanged) { repairRedirectedLeafCount += 1; classification = 'redirected'; }
    if (repairChanged) {
      repairTouched.push(Object.freeze({
        path: p.path, parent: p.value, raw: rawFields[i].value, final: finalFields[i].value, classification,
      }));
    }
  }
  const byteDeltaCount = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) n += 1;
    return n;
  };
  const accounting = {
    eligibleContinuousLeafCount,
    selectedLeafCount,
    rawChangedLeafCount,
    clampedLeafCount,
    repairChangedLeafCount,
    repairIntroducedLeafCount,
    repairErasedLeafCount,
    repairRedirectedLeafCount,
    finalChangedLeafCount,
    rawByteDeltaCount: byteDeltaCount(parentBytes, rawBytesCanonical),
    finalByteDeltaCount: byteDeltaCount(parentBytes, finalBytes),
  };
  return {
    accounting, finalGenotype, finalBytes, selectedLeaves, repairTouched, eligibleContinuousLeafCount,
  };
}

// One non-elite child, derived end to end: fork keyed by the FRESH child id,
// three tournament draws, then the mutation stream over the parent genotype.
function oracleChild(seed, childId, poolRows, genotypesById, mutation) {
  const childRng = new Rng(seed).fork(childId);
  const { draws, winnerId } = oracleTournament(childRng, poolRows);
  const parentGenotype = genotypesById.get(winnerId);
  const derived = oracleMutation(parentGenotype, childRng, mutation);
  return { draws, winnerId, parentGenotype, ...derived };
}

// The all-zero accounting an elite copy carries (key set written out by hand;
// the lineage codec itself rejects a wrong set).
const ZERO_ACCOUNTING = Object.freeze({
  eligibleContinuousLeafCount: 0,
  selectedLeafCount: 0,
  rawChangedLeafCount: 0,
  clampedLeafCount: 0,
  repairChangedLeafCount: 0,
  repairIntroducedLeafCount: 0,
  repairErasedLeafCount: 0,
  repairRedirectedLeafCount: 0,
  finalChangedLeafCount: 0,
  rawByteDeltaCount: 0,
  finalByteDeltaCount: 0,
});

function oracleTransition({
  ids, fitnesses, genotypesById, seed, mutation, baseIndividualId, generationIndex,
}) {
  const population = {
    snapshotVersion: POPULATION_SNAPSHOT_VERSION,
    individuals: ids.map((id) => ({ individualId: id, genotype: genotypesById.get(id) })),
  };
  const rows = ids.map((id, i) => ({ individualId: id, fitness: fitnesses[i] }));
  const pool = oraclePool(population, rows);
  const eliteIds = oracleEliteIds(rows);
  const individuals = [];
  const lineageRows = [];
  const children = new Map();
  for (let slot = 0; slot < ids.length; slot += 1) {
    const childId = baseIndividualId + slot;
    if (slot < eliteIds.length) {
      const eliteId = eliteIds[slot];
      individuals.push({ individualId: childId, genotype: genotypesById.get(eliteId) });
      lineageRows.push({
        individualId: childId, parentIndividualId: eliteId, origin: 'eliteCopy', accounting: ZERO_ACCOUNTING,
      });
      continue;
    }
    const child = oracleChild(seed, childId, rows, genotypesById, mutation);
    children.set(childId, child);
    individuals.push({ individualId: childId, genotype: child.finalGenotype });
    lineageRows.push({
      individualId: childId,
      parentIndividualId: child.winnerId,
      origin: 'continuousMutation',
      accounting: child.accounting,
    });
  }
  const expectedPopulationBytes = serializePopulationSnapshot({
    snapshotVersion: POPULATION_SNAPSHOT_VERSION, individuals,
  });
  const expectedLineageRows = lineageRows;
  const expectedLineageBytes = serializeLineage({
    lineageVersion: EVOLUTION_LINEAGE_VERSION, generationIndex: generationIndex + 1, individuals: lineageRows,
  });
  return {
    population, pool, eliteIds, children, expectedPopulationBytes, expectedLineageBytes, expectedLineageRows,
  };
}

// Assert the kernel's actual output against the independently derived
// expectation: exact bytes, then the decoded intermediate facts.
function expectTransitionMatches(actual, derived, expectedChildIds) {
  expect(actual.populationBytes).toEqual(derived.expectedPopulationBytes);
  expect(actual.lineageBytes).toEqual(derived.expectedLineageBytes);
  const decodedPopulation = deserializePopulationSnapshot(actual.populationBytes);
  expect(decodedPopulation.individuals.map((m) => m.individualId)).toEqual(expectedChildIds);
  const decodedLineage = deserializeLineage(actual.lineageBytes);
  expect(decodedLineage.individuals.map((r) => ({
    individualId: r.individualId,
    parentIndividualId: r.parentIndividualId,
    origin: r.origin,
    accounting: r.accounting,
  }))).toEqual(derived.expectedLineageRows.map((r) => ({
    individualId: r.individualId,
    parentIndividualId: r.parentIndividualId,
    origin: r.origin,
    accounting: r.accounting,
  })));
}

// The kernel must be READ-ONLY over its inputs (round-3 review, I6): an
// in-place population sort or pool rewrite would have passed every assertion
// above whenever it happened to be output-neutral, so the inputs are
// snapshotted before the call and asserted unchanged after it. The round-4
// review found the snapshot INCOMPLETE: the mutable `mutation` record was
// not covered at all (a kernel rewriting mutation.probability after
// consuming it still passed), and the pool was pinned only through JSON —
// blind to undefined keys and non-finite numbers. The population stays
// pinned BIT-EXACTLY through its canonical bytes; pool and mutation are
// pinned STRUCTURALLY against a pre-call deep clone.
//
// Explicit hand-rolled clone, NOT structuredClone — the lint env's globals
// do not define it (the genotype-schema.test.js / characterize-population.js
// convention). The oracle's pool/mutation are plain frozen data — own
// enumerable keys, arrays, primitives — so this preserves exactly what JSON
// would drop: NaN, -0 and undefined-valued keys.
const deepClone = (value) => {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)]));
  }
  return value;
};

function snapshotInputs(population, pool, mutation) {
  return {
    populationBytes: serializePopulationSnapshot(population),
    poolClone: deepClone(pool),
    mutationClone: deepClone(mutation),
  };
}

function expectInputsUnchanged(population, pool, mutation, snapshot) {
  expect(serializePopulationSnapshot(population)).toEqual(snapshot.populationBytes);
  expect(pool).toEqual(snapshot.poolClone);
  expect(mutation).toEqual(snapshot.mutationClone);
}

describe('the independent transition oracle', () => {
  test('Case A — selection, elitism, tie-break, fresh ids and lineage shape (zero-probability mutation)', () => {
    // Five members (more than the elite count), axles=0 genotypes with
    // distinct hues. Fitnesses carry a TIE at 7 between ids 11 and 12,
    // resolved to the lower id first: canonical elite order is [11, 12].
    const ids = [10, 11, 12, 13, 14];
    const hues = [0.1, 0.2, 0.3, 0.4, 0.5];
    const fitnesses = [5, 7, 7, 1, 3];
    const genotypesById = new Map(ids.map((id, i) => [id, canonical(0, hues[i])]));
    const seed = 20260728;
    const mutation = { probability: 0, magnitude: 0 };
    const baseIndividualId = 20;
    const generationIndex = 0;

    const derived = oracleTransition({
      ids, fitnesses, genotypesById, seed, mutation, baseIndividualId, generationIndex,
    });

    // COMMITTED FACT 1: the tie-break. 11 and 12 both have fitness 7; the
    // lower id ranks first. Elites are placed FIRST, in this order.
    expect(derived.eliteIds).toEqual([11, 12]);

    // COMMITTED FACT 2: the per-child tournament evidence. Each child's
    // stream is forked by its FRESH id (22, 23, 24 — never a slot index, and
    // no generation-global stream); three uint32 draws index the pool WITH
    // replacement (child 22 draws row 14 twice). Child 23's winner is id 10 —
    // a tournament-selected NON-ELITE parent.
    const expectedDraws = new Map([
      [22, [2571769194, 2999783284, 4013469867]],
      [23, [4153418890, 104060178, 433345798]],
      [24, [262507811, 3456338957, 419922519]],
    ]);
    const expectedWinners = new Map([[22, 12], [23, 10], [24, 11]]);
    for (const [childId, child] of derived.children) {
      expect(child.draws).toEqual(expectedDraws.get(childId));
      expect(child.winnerId).toBe(expectedWinners.get(childId));
    }

    // COMMITTED FACT 3: with probability 0 every decision draws and skips, so
    // the accounting is exactly the eligible-leaf count of the axles=0 walk
    // (30 continuous f64 leaves) and nothing else, and each child's final
    // genotype is byte-identical to its parent's.
    expect(derived.children.get(22).eligibleContinuousLeafCount).toBe(30);
    for (const [, child] of derived.children) {
      expect(child.accounting).toEqual({ ...ZERO_ACCOUNTING, eligibleContinuousLeafCount: 30 });
      expect(child.selectedLeaves).toEqual([]);
      expect(child.repairTouched).toEqual([]);
      expect(child.finalBytes).toEqual(serializeGenotype(child.parentGenotype));
    }

    const inputsSnapshot = snapshotInputs(derived.population, derived.pool, mutation);
    const actual = deriveNextGeneration({
      population: derived.population,
      pool: derived.pool,
      seed,
      mutation,
      baseIndividualId,
      generationIndex,
    });
    expectInputsUnchanged(derived.population, derived.pool, mutation, inputsSnapshot);
    expectTransitionMatches(actual, derived, [20, 21, 22, 23, 24]);

    // The decoded elite rows retain the OLD parent ids; every row order is
    // the fresh-id order (population member order == lineage row order).
    const lineage = deserializeLineage(actual.lineageBytes);
    expect(lineage.generationIndex).toBe(1);
    expect(lineage.individuals.slice(0, 2).map((r) => [r.individualId, r.parentIndividualId, r.origin]))
      .toEqual([[20, 11, 'eliteCopy'], [21, 12, 'eliteCopy']]);
    expect(lineage.individuals.slice(2).map((r) => [r.individualId, r.parentIndividualId, r.origin]))
      .toEqual([[22, 12, 'continuousMutation'], [23, 10, 'continuousMutation'], [24, 11, 'continuousMutation']]);
  });

  test('Case B — nonzero mutation, repair sensitivity and exact accounting', () => {
    // Four members, axles=1 genotypes with distinct hues; elites [31, 33].
    // Mutation probability 0.05 / magnitude 0.3 over the 43-leaf walk, seed
    // 35 (chosen at authoring time so both children mutate and child 42's
    // radius leaf is repair-sensitive), then committed as literals. Magnitude
    // 0.3, NOT 0.5: with 0.5-magnitude and all-0.5 parent leaves the proposal
    // degenerates to exactly the unit draw (0.5 + (2u-1)/2 == u), so a
    // defective operator assigning `unit` outright would pass (round-3 P3 —
    // demonstrated, then fixed here; every committed value below differs from
    // its unit, and the case asserts that).
    const ids = [30, 31, 32, 33];
    const hues = [0.1, 0.2, 0.3, 0.4];
    const fitnesses = [4, 9, 2, 6];
    const genotypesById = new Map(ids.map((id, i) => [id, canonical(1, hues[i])]));
    const seed = 35;
    const mutation = { probability: 0.05, magnitude: 0.3 };
    const baseIndividualId = 40;
    const generationIndex = 3;

    // COMMITTED FACT 1: the axles=1 field walk the mutation consumes, in
    // canonical serialization order. A walk-order or eligibility change fails
    // HERE rather than being inherited from the shared walk primitive.
    const expectedWalk = [
      'version', 'hue', 'symmetric', 'power', 'frameDensity', 'frame.family',
      'frame.segments.length', 'frame.segments[0].nodeCount',
      'frame.segments[0].nodes[0].gap', 'frame.segments[0].nodes[0].height',
      'frame.segments[0].nodes[0].halfWidth', 'frame.segments[0].nodes[0].thickness',
      'frame.segments[0].nodes[1].gap', 'frame.segments[0].nodes[1].height',
      'frame.segments[0].nodes[1].halfWidth', 'frame.segments[0].nodes[1].thickness',
      'frame.segments[0].nodes[2].gap', 'frame.segments[0].nodes[2].height',
      'frame.segments[0].nodes[2].halfWidth', 'frame.segments[0].nodes[2].thickness',
      'frame.segments[0].nodes[3].gap', 'frame.segments[0].nodes[3].height',
      'frame.segments[0].nodes[3].halfWidth', 'frame.segments[0].nodes[3].thickness',
      'frame.segments[0].nodes[4].gap', 'frame.segments[0].nodes[4].height',
      'frame.segments[0].nodes[4].halfWidth', 'frame.segments[0].nodes[4].thickness',
      'frame.segments[0].nodes[5].gap', 'frame.segments[0].nodes[5].height',
      'frame.segments[0].nodes[5].halfWidth', 'frame.segments[0].nodes[5].thickness',
      'frame.segments[0].fam.spine.beamWidthFrac', 'frame.segments[0].fam.ladder.crossFrac',
      'frame.segments[0].fam.hull.bulge', 'axles.length',
      'axles[0].posX01', 'axles[0].paired', 'axles[0].trackHalf', 'axles[0].radius',
      'axles[0].width', 'axles[0].density', 'axles[0].suspType', 'axles[0].stiffness',
      'axles[0].damping', 'axles[0].travel', 'axles[0].restLength', 'axles[0].driven',
      'axles[0].share', 'axles[0].asym.driveBias', 'axles[0].asym.sizeBias',
      'axles[0].asym.centerOffset',
    ];
    expect(fieldRows(genotypesById.get(31)).map((e) => e.path)).toEqual(expectedWalk);

    const derived = oracleTransition({
      ids, fitnesses, genotypesById, seed, mutation, baseIndividualId, generationIndex,
    });
    expect(derived.eliteIds).toEqual([31, 33]);

    // COMMITTED FACT 2: tournament evidence. Children 42 and 43 (fresh ids
    // base + slot), each forked from (seed, childId).
    expect(derived.children.get(42).draws).toEqual([4144057290, 2041815096, 1639505013]);
    expect(derived.children.get(42).winnerId).toBe(31);
    expect(derived.children.get(43).draws).toEqual([1681298795, 21421303, 112781956]);
    expect(derived.children.get(43).winnerId).toBe(33);

    // COMMITTED FACT 3: child 42's mutation. Four selected leaves with their
    // exact decision/unit draws and written values — every value differs from
    // its unit (the anti-degeneracy assertion above), and the radius leaf is
    // drawn DOWN to 0.3864052654709667, below the repair floor.
    expect(derived.children.get(42).selectedLeaves).toEqual([
      { path: 'frame.segments[0].nodes[3].thickness', decision: 0.04597651003859937, unit: 0.647209434537217, value: 0.5883256607223302 },
      { path: 'frame.segments[0].nodes[5].halfWidth', decision: 0.02310334239155054, unit: 0.9455797320697457, value: 0.7673478392418474 },
      { path: 'frame.segments[0].fam.ladder.crossFrac', decision: 0.03145399014465511, unit: 0.15243082772940397, value: 0.2914584966376424 },
      { path: 'axles[0].radius', decision: 0.04479147074744105, unit: 0.31067544245161116, value: 0.3864052654709667 },
    ]);
    for (const [, child] of derived.children) {
      for (const leaf of child.selectedLeaves) {
        expect(Object.is(leaf.value, leaf.unit),
          `${leaf.path}: value must follow the signed-delta formula, not the raw unit`).toBe(false);
      }
    }

    // COMMITTED FACT 4: child 42 is REPAIR-SENSITIVE, and this is what makes
    // the final-vs-raw distinction observable. Repair clamps the radius gene
    // UP to its feasibility floor: raw 0.3864052654709667 becomes
    // 0.4000000000000001 while the parent's 0.5 stays changed — a REDIRECTED
    // leaf. At that floor the size-bias feasibility bound lands one ulp above
    // the parent's saturated 0.5, so repair also nudges sizeBias from 0.5 to
    // 0.5000000000000001 without any mutation draw touching it — an
    // INTRODUCED leaf. The derivation reproduces both bit-exactly; a kernel
    // that retained rawGenotype, skipped repair, or repaired before mutating
    // would produce different bytes and different counters.
    expect(derived.children.get(42).repairTouched).toEqual([
      {
        path: 'axles[0].radius', parent: 0.5, raw: 0.3864052654709667, final: 0.4000000000000001, classification: 'redirected',
      },
      {
        path: 'axles[0].asym.sizeBias', parent: 0.5, raw: 0.5, final: 0.5000000000000001, classification: 'introduced',
      },
    ]);

    // COMMITTED FACT 5: child 43's single nonzero mutation, no repair effect.
    expect(derived.children.get(43).selectedLeaves).toEqual([
      { path: 'frame.segments[0].nodes[0].height', decision: 0.0383961817715317, unit: 0.08694990770891309, value: 0.25216994462534786 },
    ]);
    expect(derived.children.get(43).repairTouched).toEqual([]);

    // COMMITTED FACT 6: all eleven accounting counters, both children.
    expect(derived.children.get(42).accounting).toEqual({
      eligibleContinuousLeafCount: 43,
      selectedLeafCount: 4,
      rawChangedLeafCount: 4,
      clampedLeafCount: 0,
      repairChangedLeafCount: 2,
      repairIntroducedLeafCount: 1,
      repairErasedLeafCount: 0,
      repairRedirectedLeafCount: 1,
      finalChangedLeafCount: 5,
      rawByteDeltaCount: 28,
      finalByteDeltaCount: 29,
    });
    expect(derived.children.get(43).accounting).toEqual({
      eligibleContinuousLeafCount: 43,
      selectedLeafCount: 1,
      rawChangedLeafCount: 1,
      clampedLeafCount: 0,
      repairChangedLeafCount: 0,
      repairIntroducedLeafCount: 0,
      repairErasedLeafCount: 0,
      repairRedirectedLeafCount: 0,
      finalChangedLeafCount: 1,
      rawByteDeltaCount: 7,
      finalByteDeltaCount: 7,
    });

    const inputsSnapshot = snapshotInputs(derived.population, derived.pool, mutation);
    const actual = deriveNextGeneration({
      population: derived.population,
      pool: derived.pool,
      seed,
      mutation,
      baseIndividualId,
      generationIndex,
    });
    expectInputsUnchanged(derived.population, derived.pool, mutation, inputsSnapshot);
    expectTransitionMatches(actual, derived, [40, 41, 42, 43]);

    // The lineage generation index is the NEXT generation's, and the elite
    // rows retain the old parent ids with zero accounting.
    const lineage = deserializeLineage(actual.lineageBytes);
    expect(lineage.generationIndex).toBe(4);
    expect(lineage.individuals.slice(0, 2).map((r) => [r.individualId, r.parentIndividualId, r.origin]))
      .toEqual([[40, 31, 'eliteCopy'], [41, 33, 'eliteCopy']]);
    expect(lineage.individuals[2].accounting).toEqual(derived.children.get(42).accounting);
    expect(lineage.individuals[3].accounting).toEqual(derived.children.get(43).accounting);
  });
});

// ============================================================================
// (5) THE KERNEL REFUSAL GUARDS (round-2 review: previously coverage-dark)
// ============================================================================
//
// GUARD 1 (null tournament parent) is unreachable in PRODUCTION — the
// terminal policy refuses an empty selectable pool before the transition is
// ever derived — but it is reachable through the kernel's own contract with a
// hand-built pool, which is exactly what a misplaced refusal would hide
// behind. Pinned here: the code, the message, and the child-id context. The
// pinned MESSAGE is the base implementation's pre-existing wording
// ("...from a non-empty selectable pool"), preserved VERBATIM under PR 4A's
// behavior-parity ruling even though it reads inversely to the trigger —
// error behavior is behavior, an extraction must not change it, and the
// wording correction is a deliberately scoped follow-up (round-3 I1 asked
// for the correction; the round-4 review and the task's no-behavior-change
// constraint overruled it).
//
// GUARD 2 (tournament winner missing from the population) is unreachable
// through any HONEST pool: capturePool binds every selectable row to an
// evaluated id, and selectElites binds the evaluated ids to the population's
// members exactly, so an honest winner is necessarily a member id. The
// round-3 review demolished the earlier "structurally unreachable" claim,
// though: a STATEFUL-ACCESSOR pool — this repo's own hostile-caller idiom —
// can present honest ids to selectElites and a foreign row to the tournament,
// reaching the guard with zero stubs. That input violates the kernel's
// module-owned-values contract, but the refusal is precisely what stands
// between such a pool and an opaque lookup failure — so it is pinned that
// way, and the earlier comment is corrected here.

describe('the kernel refusal guards', () => {
  test('an empty selectable pool is refused as malformedHistory, naming the child id', () => {
    // A WELL-FORMED pool whose selectable row set is empty: the evaluated ids
    // still bind the population exactly (selectElites runs, finds no elites),
    // so the tournament itself returns null and the kernel must refuse loudly
    // rather than surface an opaque parent-lookup failure two lines later.
    const ids = [10, 11, 12, 13, 14];
    const hues = [0.1, 0.2, 0.3, 0.4, 0.5];
    const genotypesById = new Map(ids.map((id, i) => [id, canonical(0, hues[i])]));
    const population = {
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      individuals: ids.map((id) => ({ individualId: id, genotype: genotypesById.get(id) })),
    };
    const pool = Object.freeze({
      selectionPoolVersion: SELECTION_POOL_VERSION,
      fitnessPolicyVersion: FITNESS_POLICY_VERSION,
      populationSnapshotDigestState: fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population)),
      evaluatedIndividualIds: Object.freeze(ids),
      individuals: Object.freeze([]),
    });
    let thrown = null;
    try {
      deriveNextGeneration({
        population,
        pool,
        seed: 20260728,
        mutation: { probability: 0, magnitude: 0 },
        baseIndividualId: 20,
        generationIndex: 0,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EvolutionError);
    expect(thrown.code).toBe('malformedHistory');
    expect(thrown.message).toMatch(/tournament returned no parent from a non-empty selectable pool/);
    expect(thrown.context).toEqual({ childId: 20 });
  });

  test('a stateful-accessor pool presenting a foreign row to the tournament is refused, naming the parent and generation', () => {
    // The hostile-caller idiom from the single-read suite, applied to the
    // kernel's second guard. selectElites' capturePool runs FIRST and sees
    // the honest presentation (evaluated ids == population ids, three honest
    // rows); selectTournamentParent's capturePool re-reads the same
    // properties and is shown a pool whose only selectable row is id 99 — a
    // foreign id that passes capturePool because it IS the (second)
    // evaluated id. The kernel must refuse the lookup loudly.
    const ids = [10, 11, 12, 13, 14];
    const hues = [0.1, 0.2, 0.3, 0.4, 0.5];
    const genotypesById = new Map(ids.map((id, i) => [id, canonical(0, hues[i])]));
    const population = {
      snapshotVersion: POPULATION_SNAPSHOT_VERSION,
      individuals: ids.map((id) => ({ individualId: id, genotype: genotypesById.get(id) })),
    };
    const honestRows = [
      { individualId: 10, fitness: 3 }, { individualId: 11, fitness: 2 }, { individualId: 12, fitness: 1 },
    ];
    let evaluatedReads = 0;
    let individualReads = 0;
    const pool = {
      selectionPoolVersion: SELECTION_POOL_VERSION,
      fitnessPolicyVersion: FITNESS_POLICY_VERSION,
      populationSnapshotDigestState: fnv1aFold(FNV_OFFSET_BASIS, serializePopulationSnapshot(population)),
      get evaluatedIndividualIds() {
        evaluatedReads += 1;
        return evaluatedReads === 1 ? ids : [99];
      },
      get individuals() {
        individualReads += 1;
        return individualReads === 1 ? honestRows : [{ individualId: 99, fitness: 1 }];
      },
    };
    let thrown = null;
    try {
      deriveNextGeneration({
        population,
        pool,
        seed: 7,
        mutation: { probability: 0, magnitude: 0 },
        baseIndividualId: 20,
        generationIndex: 0,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EvolutionError);
    expect(thrown.code).toBe('malformedHistory');
    expect(thrown.message).toMatch(/tournament selected id 99, which is not in generation 0/);
    expect(thrown.context).toEqual({ parentId: 99, generationIndex: 0 });
  });
});
