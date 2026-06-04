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
    // Pin tests to `*.test.ts` only — the project convention (docs/standards/testing.md).
    // Vitest's *default* include also matches `*.spec.ts`, which the build tsconfig does
    // not exclude, so a stray `*.spec.ts` could leak into dist/; restricting the runner
    // here keeps the runner and the build in lock-step. The `**/` prefix matches whether
    // Vitest runs from the repo root or inside a package (one ancestor-resolved config).
    include: ['**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});
