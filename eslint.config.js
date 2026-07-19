// ESLint flat config.
// The src/sim block enforces ruling D7 (cross-platform shareable seeds):
// no ambient randomness and no implementation-defined transcendentals in any
// simulation or generation path. Rendering/UI code is exempt.

const banMath = (props, why) =>
  props.map((property) => ({ object: 'Math', property, message: why }));

const DETERMINISM_MESSAGE =
  'Banned in src/sim (ruling D7): use src/sim/prng.js streams; library transcendentals are implementation-defined across JS engines. See docs/boxcar3d-design-rulings-spec-v2.md §6.1.';

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
      ],
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
