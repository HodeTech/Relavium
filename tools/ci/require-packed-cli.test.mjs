import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const require = createRequire(new URL('apps/cli/package.json', root));
const { parse } = require('yaml');
const currentNode = readFileSync(new URL('.nvmrc', root), 'utf8').trim();
const artifactDirectory = '${{ runner.temp }}/packed-cli-artifact';
const reportDirectory = '${{ runner.temp }}/packed-cli-report';
const reportsDirectory = '${{ runner.temp }}/packed-cli-reports';
const packCommand = `node tools/cli-package/pack.mjs "${artifactDirectory}"`;
const consumeCommand = `node tools/cli-package/consume.mjs "${artifactDirectory}" "${reportDirectory}"`;
const aggregateCommand = `node tools/cli-package/aggregate.mjs "${artifactDirectory}" "${reportsDirectory}"`;
const actions = {
  checkout: 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
  pnpm: 'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
  node: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  upload: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  download: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
};

function readWorkflow(name) {
  return parse(readFileSync(new URL(`.github/workflows/${name}.yml`, root), 'utf8'));
}

function requiredJob(job, always = false) {
  assert.ok(job);
  assert.equal(job.if, always ? '${{ always() }}' : undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 20);
  assert.deepEqual(job.permissions, { contents: 'read' });
  for (const step of job.steps) {
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step.if, undefined);
    if (step.uses) assert.ok(Object.values(actions).includes(step.uses), step.uses);
  }
}

function checkConsumer(job, packId) {
  requiredJob(job);
  assert.equal(job.needs, packId);
  assert.equal(job.strategy['fail-fast'], false);
  assert.deepEqual(job.strategy.matrix, {
    include: [
      { id: 'current-linux', os: 'ubuntu-latest', node: currentNode },
      { id: 'current-macos', os: 'macos-latest', node: currentNode },
      { id: 'current-windows', os: 'windows-latest', node: currentNode },
      { id: 'minimum-linux', os: 'ubuntu-latest', node: '22.0.0' },
    ],
  });
  assert.equal(job['runs-on'], '${{ matrix.os }}');
  const setupPnpm = job.steps.filter((step) => step.uses === actions.pnpm);
  assert.equal(setupPnpm.length, 1);
  assert.deepEqual(setupPnpm[0].with, { version: '9.12.3', run_install: false });
  const setupNode = job.steps.filter((step) => step.uses === actions.node);
  assert.equal(setupNode.length, 1);
  assert.deepEqual(setupNode[0].with, {
    'node-version': "${{ matrix.node == '22.0.0' && matrix.node || '' }}",
    'node-version-file': "${{ matrix.node != '22.0.0' && '.nvmrc' || '' }}",
  });
  const download = job.steps.filter((step) => step.uses === actions.download);
  assert.equal(download.length, 1);
  assert.deepEqual(download[0].with, {
    name: '${{ needs.' + packId + '.outputs.artifact-name }}',
    path: artifactDirectory,
  });
  // One runner owns the outside-workspace install and actual installed bootstrap/run/chat/native smokes.
  // An extra shell, workspace install or build step cannot silently substitute for this consumer.
  assert.deepEqual(
    job.steps.filter((step) => step.run).map((step) => step.run),
    [consumeCommand],
  );
  const consumer = job.steps.find((step) => step.run === consumeCommand);
  assert.deepEqual(consumer.env, {
    RELAVIUM_PACKAGE_LEG: '${{ matrix.id }}',
    RELAVIUM_PACKAGE_SOURCE_SHA: '${{ github.sha }}',
  });
  const receipts = job.steps.filter((step) => step.uses === actions.upload);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].with, {
    name: '${{ needs.' + packId + '.outputs.artifact-name }}-report-${{ matrix.id }}',
    overwrite: true,
    path: `${reportDirectory}/installed-consumer.json`,
    'retention-days': 7,
    'if-no-files-found': 'error',
  });
  assert.ok(job.steps.indexOf(receipts[0]) > job.steps.indexOf(consumer));
}

function checkAggregate(job, packId, consumerId) {
  requiredJob(job, true);
  assert.deepEqual(job.needs, [packId, consumerId]);
  assert.deepEqual(job.outputs, {
    'artifact-name': '${{ needs.' + packId + '.outputs.artifact-name }}',
  });
  assert.deepEqual(
    job.steps.filter((step) => step.run).map((step) => step.run),
    [aggregateCommand],
  );
  const validator = job.steps.find((step) => step.run === aggregateCommand);
  assert.deepEqual(validator.env, {
    RELAVIUM_PACKAGE_JOB_RESULTS: '${{ toJSON(needs) }}',
    RELAVIUM_PACKAGE_SOURCE_SHA: '${{ github.sha }}',
  });
  const downloads = job.steps.filter((step) => step.uses === actions.download);
  assert.deepEqual(
    downloads.map((step) => step.with),
    [
      { name: '${{ needs.' + packId + '.outputs.artifact-name }}', path: artifactDirectory },
      {
        pattern: '${{ needs.' + packId + '.outputs.artifact-name }}-report-*',
        path: reportsDirectory,
        'merge-multiple': false,
      },
    ],
  );
  assert.ok(downloads.every((step) => job.steps.indexOf(step) < job.steps.indexOf(validator)));
}

for (const [name, packId, consumerId] of [
  ['ci', 'pack-cli', 'packed-cli-consumer'],
  ['release', 'pack', 'smoke'],
]) {
  test(`${name} packs once without a duplicate CLI build or build cache`, () => {
    const workflow = readWorkflow(name);
    const job = workflow.jobs[packId];
    assert.deepEqual(job.outputs, {
      'artifact-name': 'relavium-tarball-${{ github.run_id }}-${{ github.run_attempt }}',
    });
    // Release has existing explicit tag/main admission steps, which are preserved below.
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job.if, undefined);
    assert.deepEqual(job.permissions, { contents: 'read' });
    assert.ok(job.steps.every((step) => step['continue-on-error'] === undefined));
    assert.ok(job.steps.every((step) => !step.uses || Object.values(actions).includes(step.uses)));
    const commands = job.steps.filter((step) => step.run).map((step) => step.run);
    assert.equal(commands.filter((command) => command === packCommand).length, 1);
    assert.equal(
      commands.filter((command) => command === 'pnpm install --frozen-lockfile').length,
      1,
    );
    assert.ok(commands.indexOf('pnpm install --frozen-lockfile') < commands.indexOf(packCommand));
    assert.ok(
      commands.every(
        (command) => !/\b(?:turbo|prepack|pnpm\s+pack|pnpm\s+[^\n]*\bbuild)\b/.test(command),
      ),
    );
    assert.equal(job.steps.find((step) => step.run === packCommand).if, undefined);
    const uploads = job.steps.filter((step) => step.uses === actions.upload);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].if, undefined);
    assert.deepEqual(uploads[0].with, {
      name: 'relavium-tarball-${{ github.run_id }}-${{ github.run_attempt }}',
      path: `${artifactDirectory}/*.tgz\n${artifactDirectory}/package-test-receipt.json\n`,
      'retention-days': 7,
      'if-no-files-found': 'error',
    });
    assert.ok(
      job.steps.indexOf(uploads[0]) > job.steps.findIndex((step) => step.run === packCommand),
    );
  });

  test(`${name} requires three current platforms and the separate exact public Node floor`, () => {
    checkConsumer(readWorkflow(name).jobs[consumerId], packId);
  });

  test(`${name} always aggregates actual pack/matrix outcomes and all same-artifact receipts`, () => {
    checkAggregate(readWorkflow(name).jobs['packed-cli'], packId, consumerId);
  });
}

test('required CI joins packed acceptance and explicitly refuses every result except success', () => {
  const job = readWorkflow('ci').jobs.ci;
  assert.ok(job.needs.includes('packed-cli'));
  assert.equal(job.if, '${{ always() }}');
  const guard = job.steps.find((step) => step.name === 'Require complete packed CLI controls');
  assert.deepEqual(guard.env, { PACKED_CLI_RESULT: '${{ needs.packed-cli.result }}' });
  assert.equal(
    guard.run,
    "node -e \"require('node:assert/strict').equal(process.env.PACKED_CLI_RESULT, 'success')\"",
  );
  assert.equal(guard.if, undefined);
  assert.equal(guard['continue-on-error'], undefined);
});

test('release keeps main ancestry, version, real-push publication and npm provenance on the same tarball', () => {
  const jobs = readWorkflow('release').jobs;
  const ancestry = jobs.pack.steps.find(
    (step) => step.name === 'Release ref is reachable from `main`',
  );
  assert.equal(
    ancestry.if,
    "${{ startsWith(github.ref, 'refs/tags/v') || !inputs.allow_off_main }}",
  );
  assert.match(ancestry.run, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  const version = jobs.pack.steps.find(
    (step) => step.name === 'Tag matches the CLI package version',
  );
  assert.equal(version.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.match(version.run, /test "\$TAG" = "\$PKG"/);
  assert.equal(jobs.publish.needs, 'packed-cli');
  assert.equal(
    jobs.publish.if,
    "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}",
  );
  assert.deepEqual(jobs.publish.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(
    jobs.publish.steps.find((step) => step.uses === actions.download).with.name,
    '${{ needs.packed-cli.outputs.artifact-name }}',
  );
  assert.deepEqual(
    jobs.publish.steps.filter((step) => step.run).map((step) => step.run),
    ['npm publish ./artifact/*.tgz --provenance --access public'],
  );
});

for (const [label, alter] of [
  ['missing minimum-runtime leg', (job) => job.strategy.matrix.include.pop()],
  ['advisory platform job', (job) => (job['continue-on-error'] = true)],
  ['hidden workspace install', (job) => job.steps.push({ run: 'pnpm install --frozen-lockfile' })],
  ['hidden CLI build', (job) => job.steps.push({ run: 'pnpm --filter relavium build' })],
  [
    'pnpm implicit install',
    (job) => (job.steps.find((step) => step.uses === actions.pnpm).with.run_install = true),
  ],
  [
    'always-upload receipt',
    (job) => (job.steps.find((step) => step.uses === actions.upload).if = '${{ always() }}'),
  ],
  [
    'private report directory upload',
    (job) => (job.steps.find((step) => step.uses === actions.upload).with.path = reportDirectory),
  ],
  [
    'different tarball',
    (job) =>
      (job.steps.find((step) => step.uses === actions.download).with.name = 'rebuilt-tarball'),
  ],
]) {
  test(`workflow structure refuses ${label}`, () => {
    const job = readWorkflow('ci').jobs['packed-cli-consumer'];
    alter(job);
    assert.throws(() => checkConsumer(job, 'pack-cli'));
  });
}
