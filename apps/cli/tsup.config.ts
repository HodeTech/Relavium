import { chmodSync, cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';

import { defineConfig } from 'tsup';

// Stamp the published version into the bundle at build time (see `define` below + program.ts). Read from
// THIS package's manifest (resolved beside the config, not via cwd) so it is correct from any build entry point.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * The CLI distribution bundle (2.L, [ADR-0051](../../docs/decisions/0051-cli-distribution-thin-bundle-private-engine.md)).
 *
 * INLINE only the `@relavium/*` engine packages (`noExternal`); EXTERNALIZE every third-party
 * dependency — they are declared in `package.json` and installed normally by npm (the prebuilt native addons
 * `better-sqlite3` + `@napi-rs/keyring` cannot be bundled; the quickjs WASM + the vendor SDKs + `ink`/`react`
 * are bundler-hostile). `tools/bundle-closure/check.mjs` guards that this `external` list equals the declared
 * runtime `dependencies`, so the two can never drift.
 *
 * `minify: true` and no maps in `dist/`: the published package ships no source tree or maps. This is the npm
 * distribution boundary, not a claim that the public repository's sources are secret (ADR-0111).
 * The entry-source shebang makes `dist/index.js` directly executable as the `relavium` bin.
 *
 * Ordinary builds are map-free. A candidate build — this build with `RELAVIUM_CLI_CANDIDATE_STAGING` defined, which
 * the prepack lifecycle (`tools/cli-package/prepack.mjs`, Wave 3 Step 9a.1) runs only after it validates that
 * directory as private staging — emits external maps without embedded sources. The prepack finalizer
 * (`tools/cli-package/finalize.mjs`) then checks that they chain to original TypeScript, moves them and the
 * metafile out of the package and removes their link trailers before anything is hashed or packed; the ordinary
 * closure guard refuses any map that a build outside prepack leaves in `dist`.
 */
const CANDIDATE = process.env.RELAVIUM_CLI_CANDIDATE_STAGING !== undefined;
const THIRD_PARTY_EXTERNAL = [
  '@anthropic-ai/sdk',
  '@clack/prompts',
  '@google/genai',
  '@jitl/quickjs-singlefile-mjs-release-sync',
  // The MCP SDK is a vendor SDK like the others — externalize it (root + every subpath the stdio adapter
  // imports, e.g. `…/client/stdio.js`) so it and its own transitive deps install via npm, never inlined.
  // `@relavium/mcp` (inlined) is the only importer; the bundle then carries just `@modelcontextprotocol/sdk`.
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
  '@napi-rs/keyring',
  'better-sqlite3',
  'commander',
  'drizzle-orm',
  'ink',
  'openai',
  'quickjs-emscripten-core',
  'react',
  'smol-toml',
  'string-width',
  'yaml',
  'zod',
];

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: CANDIDATE,
  esbuildOptions(options) {
    // Original sources never enter a candidate map; the finalizer refuses any that does.
    if (CANDIDATE) options.sourcesContent = false;
  },
  minify: true,
  splitting: true,
  // Emit esbuild's metafile (`dist/metafile-esm.json`) — the authoritative record of every externalized import,
  // read by `tools/bundle-closure/check.mjs` to guard that the `external` list ≡ the declared `dependencies`. It
  // is EXCLUDED from the published tarball (the `files` negation in package.json): its `inputs` would reveal the
  // inlined engine's source-file layout, which ADR-0051 keeps unpublished.
  metafile: true,
  dts: false,
  noExternal: [/^@relavium\//],
  external: THIRD_PARTY_EXTERNAL,
  // Replace the `__RELAVIUM_CLI_VERSION__` token (program.ts) with the literal package version, so the
  // bundled `relavium --version` reports the real version with no runtime file read. Source runs (tsx/vitest)
  // have no define and fall back to a dev sentinel.
  define: { __RELAVIUM_CLI_VERSION__: JSON.stringify(version) },
  // The inlined `@relavium/db` resolves its drizzle migrations via `new URL('../drizzle', import.meta.url)`,
  // which — once bundled — points beside THIS bundle, not the db package. So ship the migration set alongside
  // `dist/` (`files: ["dist","drizzle"]`); `<pkg>/drizzle` is then what the bundled db code finds at runtime.
  onSuccess: async () => {
    // Only the executable entry owns a hashbang; lazy chunks are regular flat ESM files.
    for (const file of readdirSync('./dist')) {
      if (file.endsWith('.js')) chmodSync(`./dist/${file}`, file === 'index.js' ? 0o755 : 0o644);
    }
    // Clean first: cpSync merges (recursive) and never deletes, so a migration removed/renamed in the source
    // would otherwise linger here and ship stale. Recreate from the source of truth each build.
    rmSync('./drizzle', { recursive: true, force: true });
    cpSync('../../packages/db/drizzle', './drizzle', { recursive: true });
  },
});
