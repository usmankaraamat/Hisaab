import { defineConfig } from 'vite';

// Relative base so the same build works on GitHub Pages project sites
// (https://<user>.github.io/Hisaab/) without hardcoding the repo name.
export default defineConfig({
  base: './',
  server: { host: true },
  build: { target: 'es2022' },
});
