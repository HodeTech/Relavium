#!/usr/bin/env node
// Execute the COMPILED CLI bundle — the artifact that actually ships.
//
// Shared by `.github/workflows/ci.yml`'s required job and the root `ci` script, so the local gate and the
// real gate cannot drift on this check the way they did on `lint:tools` and the migration-sync check (#312).
// Nothing in the required gate ran the binary before (#294): a bundle that compiled but could not boot
// merged green.
//
// The `run --json` leg is load-bearing beyond "it boots": it opens `history.db`, which proves the drizzle
// migrations resolved beside the bundle. That is the failure `apps/cli/drizzle/**` becoming a declared turbo
// output (#315) exists to prevent — a cache-hit replay leaving `dist/` fresh next to a missing `drizzle/`.
//
// HERMETIC BY CONSTRUCTION. `history.db` lives at `~/.relavium/history.db` (`db/open.ts` → `paths.ts`
// → `os.homedir()`), and there is no config override for that root — so a naive smoke run opens and MIGRATES
// the developer's real database, the hazard already tracked in deferred-tasks.md. `os.homedir()` honours
// `$HOME` on POSIX and `%USERPROFILE%` on Windows, so pointing both at a throwaway directory is the one
// lever that isolates it. Setting `cwd` would NOT: the path is home-relative, not cwd-relative.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(repoRoot, 'apps/cli/dist/index.js');
const FIXTURE = join(repoRoot, 'apps/cli/src/harness/fixtures/sequential.relavium.yaml');
const STEP_TIMEOUT_MS = 120_000;

if (!existsSync(BUNDLE)) {
  console.error(`✗ ${BUNDLE} is missing — run \`pnpm turbo run build\` first.`);
  process.exit(1);
}

const sandboxHome = mkdtempSync(join(tmpdir(), 'relavium-smoke-'));

const steps = [
  { label: '--version', args: ['--version'] },
  { label: '--help', args: ['--help'] },
  {
    label: 'run --json (opens history.db → proves the migrations resolve)',
    args: ['run', FIXTURE, '--input', 'n=21', '--json'],
  },
];

try {
  for (const { label, args } of steps) {
    const r = spawnSync(process.execPath, [BUNDLE, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: STEP_TIMEOUT_MS,
      env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome },
    });

    // A hung CLI must fail this check, not sit until the CI job's own timeout kills the whole run with no
    // usable signal. `spawnSync` reports a timeout kill via `signal`, and surfaces spawn faults via `error`.
    if (r.error !== undefined) {
      console.error(`✗ compiled CLI failed to run: ${label} — ${r.error.message}`);
      process.exit(1);
    }
    if (r.signal !== null) {
      console.error(
        `✗ compiled CLI was killed (${r.signal}) on: ${label} — likely the ${STEP_TIMEOUT_MS} ms timeout.`,
      );
      if (r.stderr) console.error(r.stderr.trim());
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`✗ compiled CLI failed: ${label} (exit ${r.status})`);
      if (r.stderr) console.error(r.stderr.trim());
      process.exit(1);
    }
  }
  console.log(
    '✓ compiled CLI smoke passed (boots, renders help, runs a workflow against an isolated DB).',
  );
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}
