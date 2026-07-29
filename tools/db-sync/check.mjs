#!/usr/bin/env node
// The committed @relavium/db migration must match `src/schema.ts`. Regenerate; if that produces any change
// under `packages/db/drizzle`, the committed migration was stale — a silent staleness turned into a red gate.
//
// Node rather than an inline shell one-liner for the same reason as `tools/coverage-gate/run.mjs`: the
// `test -z "$(…)" || { …; }` form is POSIX-only and fails on cmd.exe / PowerShell, and this repo runs a
// Windows CI leg. `git status --porcelain` (not `git diff`) because a NEW migration file is untracked, and
// `git diff` does not see untracked files.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIZZLE_DIR = 'packages/db/drizzle';

function run(command, args) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', shell: false });
}

// pnpm is the process manager already running this script, so it is on PATH by construction here.
const generated = run('pnpm', ['--filter', '@relavium/db', 'db:generate']);
if (generated.error !== undefined) {
  console.error(`✗ could not run db:generate — ${generated.error.message}`);
  process.exit(1);
}
if (generated.status !== 0) {
  console.error(`✗ db:generate failed (exit ${generated.status})`);
  if (generated.stderr) console.error(generated.stderr.trim());
  process.exit(1);
}

const status = run('git', ['status', '--porcelain', DRIZZLE_DIR]);
if (status.error !== undefined) {
  console.error(`✗ could not run git status — ${status.error.message}`);
  process.exit(1);
}

const drift = (status.stdout ?? '').trim();
if (drift !== '') {
  console.error(drift);
  console.error(
    `✗ the committed @relavium/db migration is out of sync with src/schema.ts (or an upstream ` +
      `@relavium/shared enum the CHECKs derive from). Regenerate and commit: ` +
      `pnpm --filter @relavium/db db:generate`,
  );
  process.exit(1);
}

console.log('✓ the committed migration matches src/schema.ts.');
