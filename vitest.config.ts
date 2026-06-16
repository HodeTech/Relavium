import { defineConfig } from 'vitest/config';

/**
 * Root, workspace-aware Vitest config. Per-package `test` scripts run `vitest run`
 * in their own directory; this root config governs a repo-wide run and holds the
 * coverage harness.
 *
 * Coverage uses the V8 provider with branch reporting. The Phase-1 **>= 90% line + branch**
 * engine floor (docs/standards/testing.md#coverage-expectations) is the threshold the built engine
 * package(s) must meet under `pnpm coverage` (run from the repo ROOT — the threshold glob below is
 * root-relative). NOTE: `pnpm coverage` runs as an ADVISORY (non-required) `coverage` job in ci.yml
 * (promote it to a required check once the core-branch margin is confirmed stable). Surfaces stay smoke-only.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Pin tests to `*.test.ts` only — the project's single test-file convention
    // (docs/standards/testing.md). Vitest's *default* include also collects `*.spec.ts`; we do
    // not use that suffix, so pinning keeps the runner aligned with the convention. A file
    // mistakenly named `*.spec.ts` simply does not run — which the coverage floor below surfaces
    // (its target code loses coverage). The `**/` prefix matches whether Vitest runs from the repo
    // root or inside a package (one ancestor-resolved config).
    include: ['**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // cwd-tolerant: `**/src/**` matches whether the run is rooted at the repo or a package, so a
      // package-scoped `--coverage` run no longer reports a false 0%. Apps stay smoke-only (excluded).
      include: ['**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/apps/**'],
      // The enforced Phase-1 engine floor, scoped per-glob so it targets only the built engine
      // package(s) and never the not-yet-90% shared/db or the unbuilt core.
      //
      // KNOWN LIMIT (verified empirically): the floor fires only on a repo-ROOT run
      // (`pnpm coverage`). A package-scoped run (`cd packages/llm && vitest --coverage`) keys the
      // coverage map cwd-relative (`src/…`), so NO single glob can both stay package-targeted at
      // the root and still match there — a cwd-tolerant `src/**` would wrongly bind shared/db
      // package runs to the engine floor. The advisory `coverage` job (ci.yml) runs at the repo root,
      // which is exactly where this per-glob threshold is authoritative.
      thresholds: {
        'packages/llm/src/**/*.ts': { lines: 90, branches: 90 },
        'packages/core/src/**/*.ts': { lines: 90, branches: 90 }, // engine floor — core landed at 1.L
      },
    },
  },
});
