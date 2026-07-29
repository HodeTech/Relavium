#!/usr/bin/env node
// Run the repo-root coverage with ONLY the packages whose floor is a required CI check.
//
// Why a script and not `RELAVIUM_COVERAGE_ENFORCED_ONLY=1 vitest …` inline: that syntax is POSIX-only and
// fails on cmd.exe / PowerShell, and this repo runs a Windows CI leg and supports Windows developers. A
// `cross-env` dependency would need an ADR (CLAUDE.md rule 2) for something ten lines of Node already do.
//
// `vitest.config.ts` reads the env var and drops `packages/core` from the failing threshold set; see the
// comment there for the ruling that scopes it.
import { spawnSync } from 'node:child_process';

const result = spawnSync('vitest', ['run', '--coverage'], {
  stdio: 'inherit',
  shell: process.platform === 'win32', // resolve the .cmd shim on Windows
  env: { ...process.env, RELAVIUM_COVERAGE_ENFORCED_ONLY: '1' },
});

if (result.error) {
  console.error(`✗ could not start vitest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
