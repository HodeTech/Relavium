/**
 * CLI bundle-closure guard (2.L, [ADR-0051](../../docs/decisions/0051-cli-distribution-thin-bundle-private-engine.md)).
 *
 * The published `relavium` bundle inlines ONLY the proprietary `@relavium/*` engine and externalizes every
 * third-party dependency, which must be DECLARED in `apps/cli/package.json` `dependencies` so a global install
 * resolves them. The danger is drift: an engine package adds a runtime dep, the bundle imports it, but the CLI
 * manifest is not updated — and a user's `npm i -g relavium` fails with `Cannot find module …`.
 *
 * This guard reads esbuild's BUILD METAFILE (`dist/metafile-esm.json`, emitted by tsup with `metafile: true`) —
 * the bundler's OWN authoritative record of every import the output carries — and asserts the external set equals
 * the declared runtime `dependencies` exactly:
 *   - a bundle import NOT declared  → ERROR (a broken install — the dangerous direction);
 *   - a declared dep NOT imported   → ERROR (dead dependency / stale manifest).
 * Reading the metafile (not regex-scanning the minified bundle) means import-like text inside a string literal /
 * comment / regex can never be mistaken for a dependency, and a real (e.g. dynamic `import()`) import can never be
 * missed. `@relavium/*` must NOT appear (they are inlined); node builtins and relative imports are ignored.
 *
 * Build the CLI first (the build writes the metafile), then run from the repo root:
 *   pnpm --filter relavium build && node tools/bundle-closure/check.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

const METAFILE = 'apps/cli/dist/metafile-esm.json';
const MANIFEST = 'apps/cli/package.json';

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Collapse a specifier to its package name: `@scope/n/sub` → `@scope/n`; `name/sub` → `name`. */
function toPackageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

if (!existsSync(METAFILE)) {
  console.error(`✗ ${METAFILE} not found — build the CLI first (pnpm --filter relavium build).`);
  process.exit(1);
}

const meta = JSON.parse(readFileSync(METAFILE, 'utf8'));
const outputKey = Object.keys(meta.outputs ?? {}).find((k) => k.endsWith('index.js'));
if (outputKey === undefined) {
  console.error(
    `✗ ${METAFILE} has no index.js output — the build did not produce the expected bundle.`,
  );
  process.exit(1);
}

const imported = new Set();
for (const imp of meta.outputs[outputKey].imports ?? []) {
  const spec = imp.path;
  // Relative (`./…`) / absolute (`/…`) specifiers are internal (the bundler inlined them); node builtins (listed
  // by esbuild with or without the `node:` prefix, incl. subpaths like `fs/promises`) resolve without a package.
  if (spec.startsWith('.') || spec.startsWith('/')) continue;
  const pkg = toPackageName(spec);
  if (BUILTINS.has(spec) || BUILTINS.has(pkg)) continue;
  imported.add(pkg);
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
