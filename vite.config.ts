// `vitest/config` rather than `vite` so the `test` block typechecks — tsc covers
// tests/ here, and vite's own defineConfig has no idea what `test` is.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/',
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'jsdom', globals: true },
});
