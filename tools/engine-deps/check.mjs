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
 * Checked: `dependencies` + `optionalDependencies` (both install and ship — an optional
 * runtime dep must not bypass the gate). Not checked: `devDependencies` (never ship),
 * `peerDependencies` (declared, not shipped; the strict CI peer gate polices drift), and
 * `bundledDependencies` (unused in this repo). `@relavium/db` is deliberately NOT an
 * engine package — it is host-bound by design (better-sqlite3). When `packages/ui` lands
 * (build phase 3), its internal layer boundaries get the same treatment via an ESLint
 * import-zone config rather than this list.
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
  // The engine: Relavium packages + Zod + the pure-JS `yaml` loader (ADR-0035, the YAML→object
  // decode for the 1.L parser), plus the ADR-0027 expression-sandbox runtime (1.AB):
  // `quickjs-emscripten-core` (pure-TS bindings) + a singlefile-SYNC variant that embeds the
  // wasm as bytes — instantiated via the WebAssembly global, never the node:fs-importing default
  // loader, so the engine stays platform-free (CLAUDE.md rule 5). See expression-sandbox-spec.md.
  // @relavium/db is deliberately ABSENT: the engine runs in the Tauri WebView with zero
  // platform imports (CLAUDE.md rule 5), and @relavium/db pulls the native better-sqlite3
  // runtime. Core may use its TYPES via a devDependency (the Checkpointer interface /
  // Drizzle schema types); the store itself is injected by the host surface (1.R).
  // @relavium/llm is deliberately ABSENT until the runner actually imports it (1.M+). Adding it
  // to the allowlist before declaring it in package.json defeats the guard: the commit that
  // introduces the runtime dependency must touch both package.json AND this allowlist — that
  // co-location is the gate's whole purpose. Re-add @relavium/llm here in that same change.
  'packages/core': [
    '@relavium/shared',
    'zod',
    'yaml',
    'quickjs-emscripten-core',
    '@jitl/quickjs-singlefile-mjs-release-sync',
  ],
};

let failed = false;

for (const [pkgDir, allowed] of Object.entries(ENGINE_ALLOWLISTS)) {
  const manifestPath = join(pkgDir, 'package.json');
  if (!existsSync(manifestPath)) {
    console.log(`- ${pkgDir}: not scaffolded yet — skipped (allowlist already reserved).`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deps = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
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
