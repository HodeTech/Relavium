import { cpSync } from 'node:fs';

import { defineConfig } from 'tsup';

/**
 * The CLI distribution bundle (2.L, [ADR-0051](../../docs/decisions/0051-cli-distribution-thin-bundle-private-engine.md)).
 *
 * INLINE only the proprietary `@relavium/*` engine packages (`noExternal`); EXTERNALIZE every third-party
 * dependency — they are declared in `package.json` and installed normally by npm (the prebuilt native addons
 * `better-sqlite3` + `@napi-rs/keyring` cannot be bundled; the quickjs WASM + the vendor SDKs + `ink`/`react`
 * are bundler-hostile). `tools/bundle-closure/check.mjs` guards that this `external` list equals the declared
 * runtime `dependencies`, so the two can never drift.
 *
 * `sourcemap: false` + `minify: true`: the published `dist/` must ship **no** original engine source — a source
 * map would embed the inlined engine's TypeScript into the tarball and defeat keeping it unpublished (ADR-0051).
 * The shebang banner makes `dist/index.js` directly executable as the `relavium` bin.
 */
const THIRD_PARTY_EXTERNAL = [
  '@anthropic-ai/sdk',
  '@clack/prompts',
  '@google/genai',
  '@jitl/quickjs-singlefile-mjs-release-sync',
  '@napi-rs/keyring',
  'better-sqlite3',
  'commander',
  'drizzle-orm',
  'ink',
  'openai',
  'quickjs-emscripten-core',
  'react',
  'smol-toml',
  'yaml',
  'zod',
];

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: false,
  minify: true,
  dts: false,
  noExternal: [/^@relavium\//],
  external: THIRD_PARTY_EXTERNAL,
  banner: { js: '#!/usr/bin/env node' },
  // The inlined `@relavium/db` resolves its drizzle migrations via `new URL('../drizzle', import.meta.url)`,
  // which — once bundled — points beside THIS bundle, not the db package. So ship the migration set alongside
  // `dist/` (`files: ["dist","drizzle"]`); `<pkg>/drizzle` is then what the bundled db code finds at runtime.
  onSuccess: async () => {
    cpSync('../../packages/db/drizzle', './drizzle', { recursive: true });
  },
});
