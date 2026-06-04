import { defineConfig } from 'vitest/config';

/**
 * Root, workspace-aware Vitest config. Per-package `test` scripts run `vitest run`
 * in their own directory; this root config governs a repo-wide run and holds the
 * coverage harness.
 *
 * Coverage uses the V8 provider with branch reporting available now; the >= 90%
 * engine threshold is *enforced* from Phase 1 (see docs/standards/testing.md), so no
 * failing threshold is set on the Phase-0 scaffold yet.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Use Vitest's default include (`**/*.test.ts`, with node_modules/dist excluded).
    // Vitest searches ancestors for this config, so one root config governs every
    // package and the glob resolves correctly whether run from the root or a package.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});
