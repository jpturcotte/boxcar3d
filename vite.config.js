import { defineConfig } from 'vite';

// On GitHub Actions, serve from /<repo-name>/ so GitHub Pages project sites work
// out of the box. Locally, serve from /.
const repo = process.env.GITHUB_REPOSITORY; // e.g. "user/boxcar3d"
const base = repo ? `/${repo.split('/')[1]}/` : '/';

export default defineConfig({
  base,
  build: {
    // rapier3d-compat inlines its WASM as base64 (~2 MB); silence the size nag.
    chunkSizeWarningLimit: 4096,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
