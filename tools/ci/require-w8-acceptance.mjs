import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export function requireW8Acceptance(needs) {
  assert.ok(
    needs !== null && typeof needs === 'object' && !Array.isArray(needs),
    'W8_ACCEPTANCE_RESULTS_MISSING',
  );
  for (const id of ['wire-mutations', 'usage-mutations']) {
    const job = needs[id];
    assert.ok(
      job !== null && typeof job === 'object' && job.result === 'success',
      `W8_ACCEPTANCE_JOB_NOT_SUCCESSFUL: ${id}`,
    );
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireW8Acceptance(JSON.parse(process.env.RELAVIUM_W8_JOB_RESULTS ?? 'null'));
}
