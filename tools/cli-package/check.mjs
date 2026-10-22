/** Local full-CI counterpart: one new candidate and one actual-host consumer, never a platform aggregate. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyStore, globalExcludesFile, producerEnvironment } from './candidate.mjs';
import { isolatedEnvironment, runCommand } from './process.mjs';

assert.equal(process.argv.length, 2, 'no arguments required');
const directory = fileURLToPath(new URL('.', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-local-package-check-')));
try {
  // The producer runs with an isolated HOME, so the store and the developer's global Git excludes
  // file are found here, from the caller's own location variables, and handed over explicitly.
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const store = await dependencyStore({ repository, environment: process.env, home: root });
  const excludes = await globalExcludesFile({ repository, environment: process.env });
  const artifact = join(root, 'artifact'),
    reports = join(root, 'reports');
  const options = { env: isolatedEnvironment(root), timeoutMs: 600_000 };
  await runCommand(process.execPath, [join(directory, 'pack.mjs'), artifact], {
    ...options,
    env: producerEnvironment(options.env, { store, excludes }),
  });
  await runCommand(process.execPath, [join(directory, 'consume.mjs'), artifact, reports], options);
  const record = JSON.parse(readFileSync(join(reports, 'installed-consumer.json'), 'utf8'));
  assert.equal(record.leg, 'local');
  console.log(
    JSON.stringify({
      scope: 'actual local host only; required CI owns four platform legs',
      source: record.source,
      sha256: record.tarballSha256,
      node: record.node,
      platform: record.platform,
      controls: record.bootstrap.controls,
      smokeCases: record.smoke.cases.length,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
