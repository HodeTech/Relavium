import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrdinaryFile } from '../files.mjs';
import { isolatedEnvironment, runCommand } from '../process.mjs';

/** The prefix of the worker's own temporary root under the support directory. */
export const INSTALLED_SMOKE_ROOT_PREFIX = 'installed-smoke-';

/**
 * For a caller that an interrupt ends while the worker runs: the worker is killed before its own
 * removal, so remove every worker root under `supportRoot`. The native fixture targets the installed
 * CLI started in their own process groups end on their own once that worker is gone.
 * @param {string} supportRoot
 */
export function abandonInstalledSmoke(supportRoot) {
  for (const name of readdirSync(supportRoot)) {
    if (!name.startsWith(INSTALLED_SMOKE_ROOT_PREFIX)) continue;
    // Retries absorb a killed process that was still finishing a write.
    rmSync(join(supportRoot, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Join native module lifetime before the caller removes the owned installation. */
export async function runInstalledSmoke({ packageRoot, supportRoot, artifactSha256, source }) {
  const result = await runCommand(
    process.execPath,
    [
      fileURLToPath(new URL('./worker.mjs', import.meta.url)),
      packageRoot,
      supportRoot,
      artifactSha256,
      source,
    ],
    { cwd: supportRoot, env: isolatedEnvironment(supportRoot), timeoutMs: 300_000 },
  );
  const report = JSON.parse(readOrdinaryFile(join(supportRoot, 'installed-smoke.json'), 2097152));
  assert.equal(result.stdout, '', 'Installed smoke worker emitted unexpected stdout');
  assert.equal(report.pid, result.pid, 'Installed smoke report is not from the joined worker');
  assert.equal(report.parentPid, process.pid, 'Installed smoke report has a different owner');
  assert.notEqual(report.pid, process.pid, 'Installation cleanup owner loaded native smoke');
  assert.equal(report.source, source);
  assert.equal(report.artifactSha256, artifactSha256);
  assert.equal(report.runtime, process.version);
  assert.equal(report.platform, process.platform);
  assert.equal(report.success, true, 'Installed smoke worker failed its cohort');
  return report;
}
