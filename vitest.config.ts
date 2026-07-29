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
    //
    // `.test.tsx` is the JSX-component-test convention (2.6.F Step 3, ADR-0068): ink components rendered
    // through ink-testing-library must live in a `.tsx` file so `react-jsx` transforms the markup. It is the
    // SAME `.test.` prefix — an additive extension, not the rejected `.spec.` suffix — and stays confined to
    // apps/cli's renderer layer (the coverage `exclude` below drops it, and apps are coverage-excluded anyway).
    include: ['**/*.test.ts', '**/*.test.tsx'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // cwd-tolerant: `**/src/**` matches whether the run is rooted at the repo or a package, so a
      // package-scoped `--coverage` run no longer reports a false 0%. Apps stay smoke-only (excluded).
      include: ['**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/apps/**'],
      // The enforced Phase-1 engine floor, scoped per-glob so it targets only the built engine
      // package(s) and never the not-yet-90% shared/db or the unbuilt core.
      //
      // KNOWN LIMIT (verified empirically): the floor fires only on a repo-ROOT run
      // (`pnpm coverage`). A package-scoped run (`cd packages/llm && vitest --coverage`) keys the
      // coverage map cwd-relative (`src/…`), so NO single glob can both stay package-targeted at
      // the root and still match there — a cwd-tolerant `src/**` would wrongly bind shared/db
      // package runs to the engine floor. The advisory `coverage` job (ci.yml) runs at the repo root,
      // which is exactly where this per-glob threshold is authoritative.
      // `RELAVIUM_COVERAGE_ENFORCED_ONLY=1` narrows the failing set to the packages whose floor is a REQUIRED
      // CI check, leaving `packages/core` measured and printed but non-blocking. That split is a maintainer
      // ruling (2026-07-29), not a lowered standard: measured margins are `llm` +7.30 and `mcp` +5.54 on
      // branch coverage, but `core` sits at 90.83 — **+0.83** — and Phase 2.5.5 Waves 1–3 edit `core` heavily
      // (registry, budget-governor, engine, tools). Blocking merges on a sub-1-point margin would red-CI real
      // work for no defect. `core` is promoted once Wave 3's test-coverage items land. A bare `pnpm coverage`
      // (the local default) still enforces all three, so the floor never silently relaxes for a developer.
      thresholds: {
        'packages/llm/src/**/*.ts': { lines: 90, branches: 90 },
        'packages/mcp/src/**/*.ts': { lines: 90, branches: 90 }, // the inbound-MCP fence + compiler — 2.R
        ...(process.env['RELAVIUM_COVERAGE_ENFORCED_ONLY'] === '1'
          ? {}
          : // engine floor — core landed at 1.L
            { 'packages/core/src/**/*.ts': { lines: 90, branches: 90 } }),
      },
    },
  },
});
