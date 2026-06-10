/**
 * Engine dependency-allowlist guard — the SIZE half of the seam fence.
 *
 * The import-syntax fence (tools/lint-fixtures/assert-fence.mjs) polices WHAT crosses the
 * `@relavium/llm` seam; this guard polices HOW BIG the engine packages' runtime dependency
 * graphs may get. Each engine package's `dependencies` must be a subset of an explicit,
 * reviewed allowlist — hard-zero, no warn-only mode, no allowlist growth inside a feature
 * PR. Adding a runtime dependency to an engine package means editing THIS file in the same
 * change as the ADR that justifies the dependency (architectural-principles.md §9,
 * ADR-0003 zero-platform-imports, ADR-0011 seam discipline).
 *
 * `devDependencies` are not checked (they never ship); `@relavium/db` is deliberately NOT
 * an engine package — it is host-bound by design (better-sqlite3). When `packages/ui`
 * lands (build phase 3), its internal layer boundaries get the same treatment via an
 * ESLint import-zone config rather than this list.
 *
 * Exits non-zero so CI fails loudly. Run from the repo root:
 *   node tools/engine-deps/check.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * package path → allowed RUNTIME dependency names. A missing package is skipped with a
 * note (packages/core is scaffolded at 1.L); an existing package with a dep outside its
 * list fails the build.
 */
const ENGINE_ALLOWLISTS = {
  // The contract package: Zod is its ONLY runtime dependency (tech-stack.md).
  'packages/shared': ['zod'],
  // The seam package: the contract + Zod + the official provider SDKs the adapters wrap
  // (ADR-0011 — SDK types stay confined to packages/llm/src/adapters/*).
  'packages/llm': ['@relavium/shared', 'zod', '@anthropic-ai/sdk', 'openai', '@google/genai'],
  // The engine: Relavium packages only, plus the ADR-0027 sandbox runtime once the 1.AB
  // perf spike pins the package (added here, with the catalog pin, in that change).
  'packages/core': ['@relavium/shared', '@relavium/llm', '@relavium/db', 'zod'],
};

let failed = false;

for (const [pkgDir, allowed] of Object.entries(ENGINE_ALLOWLISTS)) {
  const manifestPath = join(pkgDir, 'package.json');
  if (!existsSync(manifestPath)) {
    console.log(`- ${pkgDir}: not scaffolded yet — skipped (allowlist already reserved).`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deps = Object.keys(manifest.dependencies ?? {});
  const offenders = deps.filter((d) => !allowed.includes(d));
  if (offenders.length > 0) {
    failed = true;
    console.error(
      `✗ ${pkgDir}: runtime dependencies outside the engine allowlist: ${offenders.join(', ')}\n` +
        `    Allowed: ${allowed.join(', ')}\n` +
        '    A new engine runtime dependency needs an ADR (architectural-principles.md §9) and a\n' +
        '    deliberate edit to tools/engine-deps/check.mjs in the same change.',
    );
  } else {
    console.log(`✓ ${pkgDir}: ${deps.length} runtime dep(s), all on the allowlist.`);
  }
}

if (failed) process.exit(1);
console.log('✓ Engine dependency graphs are within their reviewed allowlists.');
