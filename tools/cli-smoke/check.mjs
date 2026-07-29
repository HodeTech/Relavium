#!/usr/bin/env node
// Execute the COMPILED CLI bundle — the artifact that actually ships.
//
// Shared by `.github/workflows/ci.yml`'s required job and the root `pnpm run ci` script, so the local gate
// and the real gate cannot drift on this check the way they did on `lint:tools` and the migration-sync check
// (#312). Nothing in the required gate ran the binary before (#294): a bundle that compiled but could not
// boot merged green.
//
// The `run --json` leg is load-bearing beyond "it boots": it opens `history.db`, which proves the drizzle
// migrations resolved beside the bundle. That is the failure `apps/cli/drizzle/**` becoming a declared turbo
// output (#315) exists to prevent — a cache-hit replay leaving `dist/` fresh next to a missing `drizzle/`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BUNDLE = 'apps/cli/dist/index.js';
const FIXTURE = 'apps/cli/src/harness/fixtures/sequential.relavium.yaml';

if (!existsSync(BUNDLE)) {
  console.error(`✗ ${BUNDLE} is missing — run \`pnpm turbo run build\` first.`);
  process.exit(1);
}

const steps = [
  { label: '--version', args: ['--version'] },
  { label: '--help', args: ['--help'] },
  {
    label: 'run --json (opens history.db → proves the migrations resolve)',
    args: ['run', FIXTURE, '--input', 'n=21', '--json'],
  },
];

for (const { label, args } of steps) {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`✗ compiled CLI failed: ${label} (exit ${r.status})`);
    if (r.stderr) console.error(r.stderr.trim());
    process.exit(1);
  }
}

console.log(
  '✓ compiled CLI smoke passed (boots, renders help, and runs a workflow against history.db).',
);
