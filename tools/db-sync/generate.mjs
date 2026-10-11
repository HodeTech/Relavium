#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { portableRebuildChecks } from './portable-checks.mjs';

const packageRoot = fileURLToPath(new URL('../../packages/db/', import.meta.url));
const migrations = join(packageRoot, 'drizzle');
const before = new Set(readdirSync(migrations));
const require = createRequire(join(packageRoot, 'package.json'));
const entry = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
const generated = spawnSync(process.execPath, [entry, 'generate'], {
  cwd: packageRoot,
  stdio: 'inherit',
  shell: false,
});
if (generated.error) throw generated.error;
if (generated.status !== 0) process.exit(generated.status ?? 1);

// Historical/applied migrations are immutable. Normalize only files this invocation created;
// snapshots retain Drizzle's schema representation, which avoids a spurious schema diff.
for (const name of readdirSync(migrations)) {
  if (before.has(name) || !name.endsWith('.sql')) continue;
  const path = join(migrations, name);
  const source = readFileSync(path, 'utf8');
  const portable = portableRebuildChecks(source);
  if (portable !== source) writeFileSync(path, portable);
}
