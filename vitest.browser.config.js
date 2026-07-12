import { defineConfig } from 'vitest/config';

// The Chromium determinism gate ONLY (tests/browser/**). Invoked via
// `npm run test:browser` (= vitest run --config vitest.browser.config.js);
// this config REPLACES vite.config.js entirely, so the main suite's
// environment:'node' cannot leak in, and bare `npm test` never collects the
// browser files (vite.config.js excludes tests/browser/**).
//
// Pinning: vitest 3.2.7 + @vitest/browser 3.2.7 (1:1 version lock) +
// playwright 1.61.1 exact — the playwright version hard-pins the Chromium
// build (149.0.7827.55 at 1.61.1), so version, browser binary, and the CI
// cache key rotate together on a deliberate bump. One-time local setup:
// `npx playwright install chromium`.
export default defineConfig({
  test: {
    include: ['tests/browser/**/*.test.js'],
    testTimeout: 240_000, // three fixtures incl. the 25-body C, cold wasm init per flavor module
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      screenshotFailures: false, // nothing is rendered; digests are the output
      instances: [{ browser: 'chromium' }],
    },
  },
});
