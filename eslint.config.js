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
];
