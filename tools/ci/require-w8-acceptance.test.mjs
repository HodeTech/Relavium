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
    'native-fs-assets',
    'ci-work',
    'wire-mutations',
    'usage-mutations',
    'fs-mutations',
    'secrets-mutations',
    'packed-cli',
    'map-controls',
  ]);
  const nativeGuard = ci.steps.find(
    (step) => step.name === 'Require all native component execution legs',
  );
  assert.deepEqual(nativeGuard, {
    name: 'Require all native component execution legs',
    env: { NATIVE_FS_RESULT: '${{ needs.native-fs-assets.result }}' },
    run: "node -e \"require('node:assert/strict').equal(process.env.NATIVE_FS_RESULT, 'success')\"",
  });
  // The workspace checks run in their own job beside the control jobs; the required context joins it like the others.
  assert.deepEqual(
    ci.steps.find((step) => step.name === 'Require complete workspace checks'),
    {
      name: 'Require complete workspace checks',
      env: { WORKSPACE_CHECKS_RESULT: '${{ needs.ci-work.result }}' },
      run: "node -e \"require('node:assert/strict').equal(process.env.WORKSPACE_CHECKS_RESULT, 'success')\"",
    },
  );
  const packedGuard = ci.steps.find((step) => step.name === 'Require complete packed CLI controls');
  assert.equal(packedGuard.env.PACKED_CLI_RESULT, '${{ needs.packed-cli.result }}');
  assert.equal(
    packedGuard.run,
    "node -e \"require('node:assert/strict').equal(process.env.PACKED_CLI_RESULT, 'success')\"",
  );
  assert.equal(packedGuard.if, undefined);
  assert.equal(packedGuard['continue-on-error'], undefined);
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
  // Both families run as legs that each run and export a disjoint part under the unchanged
  // 64-MiB retained-evidence bound, which one export of either whole cohort no longer fits.
  // The shard counts are the ones the local gate (`pnpm gate`) cuts the same families into; its own test keeps them equal.
  for (const [kind, directory, minutes, shards] of [
    ['fs', 'filesystem', 60, 2],
    ['secrets', 'secrets', 75, 3],
  ]) {
    const job = workflow.jobs[`${kind}-mutations`];
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job.if, undefined);
    assert.equal(job['timeout-minutes'], minutes);
    // The legs each run and export a disjoint part; none may stop another early.
    assert.deepEqual(job.strategy, {
      'fail-fast': false,
      matrix: { shard: Array.from({ length: shards }, (_, index) => index + 1) },
    });
    assert.ok(job.steps.some((step) => step.run === 'pnpm install --frozen-lockfile'));
    assert.ok(job.steps.some((step) => step.run === 'pnpm test:acceptance-tools'));
    assert.ok(job.steps.some((step) => step.with?.['node-version-file'] === '.nvmrc'));
    const command = job.steps.find(
      (step) => step.run === `pnpm check:${kind}-mutations --shard \${{ matrix.shard }}/${shards}`,
    );
    assert.equal(command['continue-on-error'], undefined);
    assert.equal(command.if, undefined);
    assert.equal(command.env.RELAVIUM_ACCEPTANCE_EVIDENCE, '${{ runner.temp }}/wave2-acceptance');
    const artifact = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(artifact.if, '${{ always() }}');
    assert.equal(artifact.with.path, `\${{ runner.temp }}/wave2-acceptance/${directory}`);
    assert.ok(
      artifact.with.name.startsWith(`wave2-${directory}-\${{ matrix.shard }}-of-${shards}-`),
      artifact.with.name,
    );
    assert.equal(artifact.with['retention-days'], 7);
  }
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
  // The product map controls run locally right after the producer and consumer smoke.
  assert.equal(
    packageJson.scripts['check:map-controls'],
    'node tools/cli-package/map-controls.mjs',
  );
  const chain = packageJson.scripts.ci.split(' && ');
  assert.ok(chain.indexOf('pnpm smoke:cli-package') >= 0);
  assert.equal(
    chain.indexOf('pnpm check:map-controls'),
    chain.indexOf('pnpm smoke:cli-package') + 1,
  );
  assert.equal(chain.filter((step) => step === 'pnpm check:map-controls').length, 1);
});
