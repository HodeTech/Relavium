import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Directories that hold a SECOND checkout of this repo inside the working tree, and must never be collected
 * by a root run (`CR-90`).
 *
 * This is not hypothetical housekeeping. Measured on 2026-08-10: a root `vitest list` found **472** test
 * files, **234** of them under `.claude/worktrees/<id>/packages/...` — a full agent-tooling checkout,
 * complete with its own sources. So a repo-wide run was executing a foreign tree's tests, and the coverage
 * report was counting its sources (48.85% lines, against 96.95% once excluded).
 *
 * It hides well: `.claude/worktrees/` is excluded through `.git/info/exclude`, which is LOCAL and untracked,
 * so `git status` stays clean, a fresh clone does not even carry the rule, and Vitest never consulted git in
 * the first place. That also means CI, which checks out clean, never saw any of it — this list defends the
 * DEVELOPER's run, and the guard in `tools/test-isolation` is the part that defends CI.
 *
 * **A list of named locations, deliberately, not a structural predicate.** The obvious general rule — "a
 * workspace root nested inside another one", `'**\/*\/{packages,apps,tools}\/**'` — is wrong: it also matches
 * this repo's own `packages/core/src/tools/*.test.ts`, because `**` happily eats `packages/core` and leaves
 * `src` for the `*`. Verified: it drops exactly four real test files. A rule that silently drops real tests is
 * worse than the leak it closes.
 *
 * **Each entry must be a plantable directory path**, not an arbitrary glob: `tools/test-isolation` imports
 * this list and plants one fixture per entry, so a new entry is guarded automatically and the guard cannot
 * drift out of step with the list. The two dotted names are matched anywhere (`**\/`); the undotted one is
 * ROOT-ANCHORED on purpose — a product whose CLI manages git checkouts could plausibly grow
 * `apps/cli/src/worktrees/`, and `**\/worktrees\/**` would silently delete its tests from collection and its
 * sources from coverage.
 */
export const REPO_LOCAL_CHECKOUTS = ['**/.claude/**', '**/.worktrees/**', 'worktrees/**'];

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
    // `defaultExclude` is SPREAD, not replaced — setting `exclude` overrides Vitest's own list, and dropping
    // `**/node_modules/**` from it would be a far bigger collection bug than the one being fixed.
    exclude: [...defaultExclude, ...REPO_LOCAL_CHECKOUTS],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // cwd-tolerant: `**/src/**` matches whether the run is rooted at the repo or a package, so a
      // package-scoped `--coverage` run no longer reports a false 0%. Apps stay smoke-only (excluded).
      include: ['**/src/**/*.ts'],
      // Both halves matter and they fail differently: `test.exclude` stops a foreign tree's TESTS from
      // running, this stops its SOURCES from being counted. `test-exclude` globs with `dot: true`, so the
      // `include` above reaches straight into `.claude/` and a nested checkout's `packages/*/src/**` lands in
      // the report as 0%-covered files. Measured: 48.85% lines with the leak, 96.95% without.
      //
      // **It corrupts the reported number and the html/lcov artifact — it does NOT trip a threshold, and an
      // earlier version of this comment wrongly said it did.** Verified against vitest's own matcher: the
      // per-package thresholds below are matched ROOT-RELATIVE with no implicit leading `**`, so
      // `.claude/worktrees/x/packages/llm/src/a.ts` matches none of them and falls into the `global` group,
      // which sets no thresholds and is skipped. The counterfactual run exits 0 at 48.85%. Stated precisely
      // because this line becomes genuinely threshold-load-bearing the moment anyone adds a global threshold,
      // and a maintainer deciding whether it is still needed should not be reading a mechanism that does not
      // exist.
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/apps/**', ...REPO_LOCAL_CHECKOUTS],
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
