#!/usr/bin/env node
// Run the repo-root coverage with ONLY the packages whose floor is a required CI check.
//
// Why a script and not `RELAVIUM_COVERAGE_ENFORCED_ONLY=1 vitest …` inline: that syntax is POSIX-only and
// fails on cmd.exe / PowerShell, and this repo runs a Windows CI leg and supports Windows developers. A
// `cross-env` dependency would need an ADR (CLAUDE.md rule 2) for something a few lines of Node already do.
//
// `vitest.config.ts` reads the env var and drops `packages/core` from the failing threshold set; see the
// comment there for the ruling that scopes it.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Resolve vitest's own entry through the module graph rather than letting the OS search `PATH`. Spawning a
// bare `vitest` would run whatever a writeable `PATH` entry shadows it with, and would need `shell: true` on
// Windows to find the `.cmd` shim — a second injection surface. `process.execPath` + an absolute script path
// needs neither.
const require = createRequire(join(repoRoot, 'package.json'));
let vitestEntry;
try {
  const pkgPath = require.resolve('vitest/package.json');
  vitestEntry = join(dirname(pkgPath), require('vitest/package.json').bin.vitest);
} catch (error) {
  console.error(`✗ cannot resolve the vitest entry point: ${error.message}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [vitestEntry, 'run', '--coverage'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, RELAVIUM_COVERAGE_ENFORCED_ONLY: '1' },
});

if (result.error) {
  console.error(`✗ could not start vitest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
