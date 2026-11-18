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

// Coverage instrumentation and unrelated file workers must not compete for the admitted-size
// controls' unchanged case budgets. Every package file, threshold and explicit native concurrency remain.
//
// Only the `packages/` tests run here (`--dir packages`). The floor is enforced on `packages/llm` and
// `packages/mcp` only, and `vitest.config.ts` excludes `apps/**` from the coverage denominator, so the
// `apps/` tests (about three quarters of the run time, 917 files in all) add nothing to any enforced
// figure; they still run, uninstrumented, in the workspace tests (`ci-work`, `pnpm gate`). Measured
// 2026-11-18: the 407 package files passed in 4 min 44 s and every line and branch figure for llm, mcp,
// core and db equalled the full 917-file run of the same tree to two decimals (only `shared`, which has
// no floor, moved: lines 96.72 -> 96.62). The directory is relative to `cwd`, the repository root, so the
// root-relative thresholds stay authoritative. Do not widen this back without re-measuring: the full run
// took 29 to 45+ minutes on identical code, depending on the runner.
const result = spawnSync(
  process.execPath,
  [vitestEntry, 'run', '--coverage', '--maxWorkers=1', '--dir', 'packages'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, RELAVIUM_COVERAGE_ENFORCED_ONLY: '1' },
  },
);

if (result.error) {
  console.error(`✗ could not start vitest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
