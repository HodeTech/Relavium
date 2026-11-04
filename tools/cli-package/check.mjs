/** Local full-CI counterpart: one new candidate and one actual-host consumer, never a platform aggregate. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyStore, globalExcludesFile, producerEnvironment } from './candidate.mjs';
import { forwardInterrupts, isolatedEnvironment, runCommand } from './process.mjs';

assert.equal(process.argv.length, 2, 'no arguments required');
/** Shortens each stage's deadline (milliseconds, at most the default 600000). */
const DEADLINE_ENV = 'RELAVIUM_LOCAL_CHECK_DEADLINE_MS';
const directory = fileURLToPath(new URL('.', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-local-package-check-')));
// The producer and the consumer run detached, and each stops its own child trees and removes its
// temporary directories on an interrupt, so the interrupt is forwarded to them instead of ending this
// check first. The check root, which holds those directories, goes once they have exited, and no
// later stage starts after an interrupt arrived.
const interrupts = forwardInterrupts();
const proceed = () =>
  assert.equal(interrupts.received(), undefined, 'PACKED_CLI_LOCAL_CHECK_INTERRUPTED');
try {
  // The producer runs with an isolated HOME, so the store and the developer's global Git excludes
  // file are found here, from the caller's own location variables, and handed over explicitly.
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const store = await dependencyStore({ repository, environment: process.env, home: root });
  const excludes = await globalExcludesFile({ repository, environment: process.env });
  const artifact = join(root, 'artifact'),
    reports = join(root, 'reports');
  // A stage past its deadline is interrupted first (SIGTERM), so it stops its own detached build
  // children and removes its private directories; only a stage that ignores that is killed. The
  // deadline can only be shortened, for the tests.
  const deadline = Number(process.env[DEADLINE_ENV] ?? 600_000);
  assert.ok(
    Number.isSafeInteger(deadline) && deadline > 0 && deadline <= 600_000,
    'PACKED_CLI_LOCAL_CHECK_DEADLINE',
  );
  const options = { env: isolatedEnvironment(root), timeoutMs: deadline, graceMs: 30_000 };
  proceed();
  await runCommand(process.execPath, [join(directory, 'pack.mjs'), artifact], {
    ...options,
    env: producerEnvironment(options.env, { store, excludes }),
  });
  proceed();
  await runCommand(process.execPath, [join(directory, 'consume.mjs'), artifact, reports], options);
  proceed();
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
} catch (error) {
  if (interrupts.received() === undefined) throw error;
} finally {
  // Retries absorb a child killed by the interrupt that was still finishing a write.
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  await interrupts.dispose();
}
const signal = interrupts.received();
if (signal !== undefined) process.exit(128 + (constants.signals[signal] ?? 0));
