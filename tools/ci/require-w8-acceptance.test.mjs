import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireW8Acceptance } from './require-w8-acceptance.mjs';

for (const wire of ['success', 'failure', 'cancelled', 'skipped', 'pending']) {
  for (const usage of ['success', 'failure', 'cancelled', 'skipped', 'pending']) {
    test(`required result: wire=${wire}, usage=${usage}`, () => {
      const check = () =>
        requireW8Acceptance({
          'wire-mutations': { result: wire },
          'usage-mutations': { result: usage },
        });
      if (wire === 'success' && usage === 'success') assert.doesNotThrow(check);
      else assert.throws(check, /W8_ACCEPTANCE_JOB_NOT_SUCCESSFUL/);
    });
  }
}
for (const needs of [
  undefined,
  null,
  [],
  {},
  { 'wire-mutations': { result: 'success' } },
  { 'usage-mutations': { result: 'success' } },
]) {
  test(`refuses incomplete needs ${JSON.stringify(needs)}`, () =>
    assert.throws(() => requireW8Acceptance(needs)));
}

test('the actual required workflow joins both full offline controls and checks their outcomes', async () => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../apps/cli/package.json', import.meta.url));
  const { parse } = require('yaml');
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );
  const ci = workflow.jobs.ci;
  assert.deepEqual(ci.needs, [
    'wire-mutations',
    'usage-mutations',
    'fs-mutations',
    'secrets-mutations',
  ]);
  const fsGuard = ci.steps.find(
    (step) => step.name === 'Require complete filesystem causal controls',
  );
  assert.equal(fsGuard.env.FS_CONTROLS_RESULT, '${{ needs.fs-mutations.result }}');
  assert.equal(
    fsGuard.run,
    "node -e \"require('node:assert/strict').equal(process.env.FS_CONTROLS_RESULT, 'success')\"",
  );
  assert.equal(fsGuard.if, undefined);
  assert.equal(fsGuard['continue-on-error'], undefined);
  assert.equal(ci.if, '${{ always() }}');
  const guard = ci.steps.find((step) => step.run === 'node tools/ci/require-w8-acceptance.mjs');
  assert.equal(guard.env.RELAVIUM_W8_JOB_RESULTS, '${{ toJSON(needs) }}');
  for (const kind of ['wire', 'usage']) {
    const job = workflow.jobs[`${kind}-mutations`];
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job.if, undefined);
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60);
    const command = job.steps.find((step) => step.run === `pnpm check:${kind}-mutations`);
    assert.ok(command);
    assert.equal(command['continue-on-error'], undefined);
    assert.equal(command.env.RELAVIUM_ACCEPTANCE_EVIDENCE, '${{ runner.temp }}/w8-acceptance');
    assert.ok(job.steps.some((step) => step.run === 'pnpm install --frozen-lockfile'));
    assert.ok(job.steps.some((step) => step.run === 'pnpm test:acceptance-tools'));
    const artifact = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(artifact.if, '${{ always() }}');
    assert.equal(artifact.with['retention-days'], 7);
  }
  const secretsGuard = ci.steps.find(
    (step) => step.name === 'Require complete secrets causal controls',
  );
  assert.equal(secretsGuard.env.SECRETS_CONTROLS_RESULT, '${{ needs.secrets-mutations.result }}');
  assert.equal(
    secretsGuard.run,
    "node -e \"require('node:assert/strict').equal(process.env.SECRETS_CONTROLS_RESULT, 'success')\"",
  );
  assert.equal(secretsGuard.if, undefined);
  assert.equal(secretsGuard['continue-on-error'], undefined);
  for (const kind of ['secrets']) {
    const job = workflow.jobs[`${kind}-mutations`];
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job.if, undefined);
    assert.equal(job['timeout-minutes'], 30);
    assert.ok(job.steps.some((step) => step.run === 'pnpm install --frozen-lockfile'));
    assert.ok(job.steps.some((step) => step.run === 'pnpm test:acceptance-tools'));
    assert.ok(job.steps.some((step) => step.with?.['node-version-file'] === '.nvmrc'));
    const command = job.steps.find((step) => step.run === `pnpm check:${kind}-mutations`);
    assert.equal(command['continue-on-error'], undefined);
    assert.equal(command.if, undefined);
    assert.equal(command.env.RELAVIUM_ACCEPTANCE_EVIDENCE, '${{ runner.temp }}/wave2-acceptance');
    const artifact = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(artifact.if, '${{ always() }}');
    assert.equal(artifact.with.path, '${{ runner.temp }}/wave2-acceptance/secrets');
    assert.equal(artifact.with['retention-days'], 7);
  }
  const filesystem = workflow.jobs['fs-mutations'];
  assert.equal(filesystem['continue-on-error'], undefined);
  assert.equal(filesystem.if, undefined);
  assert.equal(filesystem['timeout-minutes'], 60);
  assert.ok(filesystem.steps.some((step) => step.run === 'pnpm install --frozen-lockfile'));
  const fsCommand = filesystem.steps.find((step) => step.run === 'pnpm check:fs-mutations');
  assert.equal(fsCommand['continue-on-error'], undefined);
  assert.equal(fsCommand.env.RELAVIUM_ACCEPTANCE_EVIDENCE, '${{ runner.temp }}/wave2-acceptance');
  const fsArtifact = filesystem.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.equal(fsArtifact.if, '${{ always() }}');
  assert.equal(fsArtifact.with.path, '${{ runner.temp }}/wave2-acceptance/filesystem');
  assert.equal(fsArtifact.with['retention-days'], 7);
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['check:fs-mutations'],
    'node tools/fs-policy-controls/check.mjs',
  );
  assert.equal(
    packageJson.scripts['check:secrets-mutations'],
    'node tools/secrets-controls/check.mjs',
  );
  for (const kind of ['wire', 'usage', 'fs', 'secrets'])
    assert.ok(packageJson.scripts.ci.split(' && ').includes(`pnpm check:${kind}-mutations`));
});
