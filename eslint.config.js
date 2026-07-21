// ESLint flat config.
// The src/sim block enforces ruling D7 (cross-platform shareable seeds):
// no ambient randomness and no implementation-defined transcendentals in any
// simulation or generation path. Rendering/UI code is exempt.

const banMath = (props, why) =>
  props.map((property) => ({ object: 'Math', property, message: why }));

const DETERMINISM_MESSAGE =
  'Banned in src/sim (ruling D7): use src/sim/prng.js streams; library transcendentals are implementation-defined across JS engines. See docs/boxcar3d-design-rulings-spec-v2.md §6.1.';

// The D7/F3 syntax bans (globalThis back door, Math/Date/performance/crypto
// aliasing, the ** operator). SHARED so the byte-family block below can include
// them: flat-config `no-restricted-syntax` is REPLACED, not merged, when two
// matching blocks both define it — so the byte-family block's own selectors used
// to silently strip these determinism bans from the 7 most identity-critical
// modules (assembly.js, trace.js, …), where `x ** 2` and `globalThis.Math.random()`
// then linted clean (break-it sweep F2). Both blocks now spread this array.
const DETERMINISM_SYNTAX = [
  {
    selector: 'MemberExpression[object.name="globalThis"]',
    message: 'Reach nothing through globalThis in src/sim: it re-exposes Math/Date/performance/crypto past the D7/F3 bans.',
  },
  {
    // `const M = Math` / `const { random } = Math` — aliasing the object moves
    // every later call out of no-restricted-properties' sight.
    selector: 'VariableDeclarator[init.name=/^(Math|Date|performance|crypto)$/]',
    message: 'Do not alias Math/Date/performance/crypto in src/sim: the D7/F3 property bans only see direct access.',
  },
  {
    selector: ':matches(BinaryExpression, AssignmentExpression)[operator=/^\\*\\*=?$/]',
    message: 'The ** operator is Number::exponentiate — implementation-approximated exactly like the banned Math.pow (ruling D7). Use repeated multiplication, which IEEE 754 requires to be exact.',
  },
];

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'docs/**', 'legacy/**', 'rapier-upstream/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        URLSearchParams: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
  {
    // The Chromium determinism gate runs in a real browser page.
    files: ['tests/browser/**/*.js'],
    languageOptions: {
      globals: {
        navigator: 'readonly',
      },
    },
  },
  {
    files: ['src/sim/**/*.js', 'src/workers/**/*.js'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...banMath(
          // hypot/cbrt are implementation-approximated too (unlike sqrt, which
          // IEEE 754 requires to be correctly rounded).
          ['random', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'exp', 'log', 'hypot', 'cbrt'],
          DETERMINISM_MESSAGE
        ),
      ],
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: 'Sim time counts physics steps, never wall clock (red-team F3).' },
        { name: 'Date', message: 'Sim time counts physics steps, never wall clock (red-team F3).' },
        // Round-11: `crypto.getRandomValues` is ambient randomness by any other
        // name, and `self`/`globalThis` are the qualified back doors below.
        { name: 'crypto', message: DETERMINISM_MESSAGE },
        { name: 'self', message: 'Reach nothing through the global object in src/sim (rulings D7/F3).' },
      ],
      // The two rules above match a BARE `Math` object or a bare identifier
      // only. Measured (round-11): `globalThis.Math.random()`, `G.Math.sin(1)`,
      // `const M = Math; M.random()`, `globalThis.Date.now()`,
      // `new globalThis.Date()`, `globalThis.performance.now()` and
      // `globalThis.crypto.getRandomValues(...)` ALL linted clean in
      // src/sim/** and src/workers/**, so both hard rules claimed
      // "(ESLint-enforced)" for a ban with an open spelling. No live violation
      // existed; these close the spelling, not a defect.
      'no-restricted-syntax': ['error', ...DETERMINISM_SYNTAX],
    },
  },
  {
    // THE OWNERSHIP BOUNDARY, as a build failure rather than a paragraph.
    //
    // Why this block exists: the canonical codec modules declared their
    // ownership rules in prose, fixed each defect at the site where it was
    // found, and never swept the class — so the rules held wherever someone
    // had looked and nowhere else. Measured twice: deleting the cached
    // intrinsic getters from deserializeGenotype left the whole suite green,
    // and `bytesEqual` reported deadbeef equal to dead0000 for two review
    // rounds while the design memo listed it as "loud on first use".
    //
    // Scope is the byte-handling family: modules that accept a Uint8Array or a
    // collection from a caller and attest something about it.
    files: [
      'src/sim/bytes.js', 'src/sim/assembly.js', 'src/sim/population.js',
      'src/sim/population-initializer.js', 'src/sim/population-evaluation.js',
      'src/sim/trace.js', 'src/sim/fnv1a.js',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        // The D7/F3 determinism bans MUST be repeated here: flat-config replaces
        // `no-restricted-syntax` rather than merging it, so without this spread
        // the seven byte-family files (a subset of src/sim) would lose the
        // globalThis / Math-aliasing / ** bans the src/sim block declares (F2).
        ...DETERMINISM_SYNTAX,
        {
          // `length`/`byteLength`/`byteOffset`/`buffer` are INHERITED ACCESSORS
          // on %TypedArray%.prototype, so an own data property on a genuine
          // Uint8Array shadows them with ordinary defineProperty — no Proxy
          // needed. Legal reads go through a cached prototype getter
          // (`TA_BYTE_LENGTH.call(x)`), which is a CallExpression and does not
          // match this selector.
          selector: 'MemberExpression[computed=false][property.name=/^(byteLength|byteOffset|buffer)$/]',
          message: 'Byte geometry must come from a cached %TypedArray%.prototype getter (TA_BYTE_LENGTH.call(x) / typedArrayByteLength(x)), never a property read — an own data property on a genuine Uint8Array shadows the inherited accessor. If the receiver is provably module-owned, disable this line with a comment NAMING the receiver.',
        },
        {
          // Round-11: `MemberExpression[computed=false]` sees NEITHER computed
          // access NOR destructuring, both measured clean against the previous
          // selector — and `const { byteLength } = bytes` is the IDIOMATIC way
          // the shadowable read comes back. A computed access through a
          // variable key is not statically visible; that residue is recorded,
          // not claimed closed.
          selector: 'MemberExpression[computed=true][property.value=/^(byteLength|byteOffset|buffer|subarray)$/]',
          message: 'Computed access is the same read: byte geometry must come from a cached %TypedArray%.prototype getter, and subarray is banned outright.',
        },
        {
          selector: 'ObjectPattern > Property[key.name=/^(byteLength|byteOffset|buffer|subarray)$/]',
          message: 'Destructuring performs the same shadowable property read. Use the cached %TypedArray%.prototype getters.',
        },
        {
          // Reflect.get(bytes, 'byteLength') is a third spelling of the same
          // read and has no legitimate use in this family.
          selector: 'MemberExpression[object.name="Reflect"]',
          message: 'Reflect.* is banned in the byte family: it reaches caller-shadowable properties past the geometry rules.',
        },
        {
          // `subarray` is banned OUTRIGHT in this family, with no
          // module-owned exception, because it is unsafe even when borrowed
          // from the prototype: %TypedArray%.prototype.subarray performs
          // species dispatch, reading the receiver's `constructor` and
          // `constructor[Symbol.species]` and CONSTRUCTING the result. The
          // previous round replaced `bytes.subarray(...)` with
          // `TA_SUBARRAY.call(bytes, ...)` believing the intrinsic made it
          // safe; it did not, and the snapshot decoder returned a genotype
          // that was never in the stream. Use
          // `new Uint8Array(TA_BUFFER.call(x), TA_BYTE_OFFSET.call(x) + o, n)`.
          selector: 'MemberExpression[computed=false][property.name="subarray"]',
          message: 'subarray is banned here: it is SPECIES-AWARE, so it runs caller code and can return a foreign array even when called as TA_SUBARRAY.call(x). Build the window with new Uint8Array(TA_BUFFER.call(x), TA_BYTE_OFFSET.call(x) + offset, n).',
        },
        // DELIBERATELY NOT LINTED, recorded so the gap reads as a decision:
        // the broader "never invoke caller-owned code" rule (.map/.forEach/
        // .indexOf/.slice/iterators on caller values). A selector wide enough
        // to catch it flags ~50 sites in these files, essentially all of them
        // module-owned constants (WEIGHT_KEYS.every, SUSPENSION_TYPES.indexOf,
        // ASSEMBLY_OPTION_KEYS.join), and a wall of disable comments obscures
        // the audit trail it is meant to create. That rule is enforced
        // BEHAVIOURALLY instead, in tests/ownership-boundary.test.js, which
        // feeds hostile-but-plain data to every public export and asserts the
        // RESULT — a stronger check than a shape ban, since it caught the
        // species defect that a `.subarray` shape ban alone would have missed.
      ],
    },
  },
];
