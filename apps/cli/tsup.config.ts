import { defineConfig } from 'tsup';

// Build the CLI to a single ESM `bin` (ADR-0047). Pure-JS deps (commander; smol-toml at
// 2.B) are inlined; the native dep (@napi-rs/keyring at 2.C) is externalized in packaging
// (2.L). The shebang is prepended so the published `dist/index.js` is directly executable.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
});
