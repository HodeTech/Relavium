/**
 * CLI bundle-closure guard (2.L, [ADR-0051](../../docs/decisions/0051-cli-distribution-thin-bundle-private-engine.md)).
 *
 * The published `relavium` bundle inlines ONLY the proprietary `@relavium/*` engine and externalizes every
 * third-party dependency, which must be DECLARED in `apps/cli/package.json` `dependencies` so a global install
 * resolves them. The danger is drift: an engine package adds a runtime dep, the bundle imports it, but the CLI
 * manifest is not updated — and a user's `npm i -g relavium` fails with `Cannot find module …`.
 *
 * This guard reads the BUILT bundle, extracts every external (bare-specifier) import it still carries, and
 * asserts that set equals the declared runtime `dependencies` exactly:
 *   - a bundle import NOT declared  → ERROR (a broken install — the dangerous direction);
 *   - a declared dep NOT imported   → ERROR (dead dependency / stale manifest).
 * `@relavium/*` must NOT appear (they are inlined); node builtins and relative imports are ignored.
 *
 * Build the CLI first, then run from the repo root:
 *   pnpm --filter relavium build && node tools/bundle-closure/check.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

const BUNDLE = 'apps/cli/dist/index.js';
const MANIFEST = 'apps/cli/package.json';

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Collapse a specifier to its package name: `@scope/n/sub` → `@scope/n`; `name/sub` → `name`. */
function toPackageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

if (!existsSync(BUNDLE)) {
  console.error(`✗ ${BUNDLE} not found — build the CLI first (pnpm --filter relavium build).`);
  process.exit(1);
}

const code = readFileSync(BUNDLE, 'utf8');
// Every external-import form esbuild can emit — minified (no spaces) or not: `from "x"`, side-effect
// `import "x"`, dynamic `import("x")`, and CJS-interop `require("x")`. `import\s*\(` precedes the bare
// `import\s*` branch so a dynamic import is matched by the former, not mis-split by the latter.
const SPEC_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)["']([^"']+)["']/g;
// A real bare specifier is a MODULE PATH (`scope/name`, a `node:` builtin, `~`/`.` segments) — never arbitrary
// code. The regex alone can mis-read import-like text INSIDE a string literal as a specifier (the minified
// bundle carries no comments) — e.g. the dispatch command-id `"import"` in `executeCommand("import", …)`, whose
// closing quote the bare `import\s*["']` branch swallows, capturing the following minified code. Requiring the
// capture to look like a module path drops those false matches (they carry `{ ( , ;` …), so help text, a notice,
// or a string-valued command id can never invent an external dependency. (A simpler regex, no lookbehind.)
const MODULE_SPEC = /^[\w@][\w@./:~-]*$/;
const imported = new Set();
for (const match of code.matchAll(SPEC_RE)) {
  const spec = match[1];
  // MODULE_SPEC also excludes relative (`./…`) + absolute (`/…`) specifiers (they fail the `^[\w@]` anchor).
  if (!MODULE_SPEC.test(spec) || BUILTINS.has(spec)) continue;
  imported.add(toPackageName(spec));
}

const declared = new Set(
  Object.keys(JSON.parse(readFileSync(join(MANIFEST), 'utf8')).dependencies ?? {}),
);

const leakedEngine = [...imported].filter((p) => p.startsWith('@relavium/'));
const missing = [...imported].filter((p) => !p.startsWith('@relavium/') && !declared.has(p));
const dead = [...declared].filter((p) => !imported.has(p));

let failed = false;
if (leakedEngine.length > 0) {
  failed = true;
  console.error(
    `✗ engine package(s) NOT inlined (imported at runtime, but must be bundled): ${leakedEngine.join(', ')}`,
  );
}
if (missing.length > 0) {
  failed = true;
  console.error(
    `✗ bundle imports undeclared dependenc(ies) — a published install would fail: ${missing.join(', ')}\n` +
      `    Add them to ${MANIFEST} "dependencies" (catalog:), per ADR-0051.`,
  );
}
if (dead.length > 0) {
  failed = true;
  console.error(
    `✗ declared dependenc(ies) the bundle never imports — stale manifest: ${dead.join(', ')}\n` +
      `    Remove them from ${MANIFEST} "dependencies" (or confirm they are runtime-required).`,
  );
}

if (failed) process.exit(1);
console.log(
  `✓ CLI bundle closure matches the declared dependencies (${declared.size} third-party dep(s); ` +
    `the @relavium/* engine is inlined).`,
);
