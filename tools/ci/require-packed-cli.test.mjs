import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
const outcomesCommand = `node --input-type=module -e "import { requirePackageJobResults } from './tools/cli-package/binding.mjs'; requirePackageJobResults(JSON.parse(process.env.RELAVIUM_PACKAGE_JOB_RESULTS ?? 'null'));"`;
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
    packId === 'pack-cli' ? [outcomesCommand, aggregateCommand] : [aggregateCommand],
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
  if (packId === 'pack-cli') {
    const outcomes = job.steps.find((step) => step.run === outcomesCommand);
    assert.deepEqual(outcomes.env, { RELAVIUM_PACKAGE_JOB_RESULTS: '${{ toJSON(needs) }}' });
    assert.ok(downloads.every((step) => job.steps.indexOf(outcomes) < job.steps.indexOf(step)));
  }
}

function checkUnprivilegedPackageJobs(workflow) {
  for (const id of ['pack-cli', 'packed-cli-consumer', 'packed-cli', 'map-controls']) {
    const job = workflow.jobs[id];
    for (const key of ['TURBO_TOKEN', 'TURBO_TEAM']) {
      assert.equal(job.env?.[key], '', `${id} must clear inherited ${key}`);
      for (const step of job.steps)
        if (Object.hasOwn(step.env ?? {}, key))
          assert.equal(step.env[key], '', `${id} step reintroduced ${key}`);
    }
  }
}

test('all PR-controlled installed-package jobs clear inherited remote-cache credentials', () => {
  checkUnprivilegedPackageJobs(readWorkflow('ci'));
});

for (const id of ['pack-cli', 'packed-cli-consumer', 'packed-cli', 'map-controls'])
  for (const key of ['TURBO_TOKEN', 'TURBO_TEAM'])
    for (const value of [undefined, '${{ secrets.REMOTE_CACHE_CREDENTIAL }}'])
      test(`package privilege guard refuses ${id} ${key}: ${String(value)}`, () => {
        const workflow = readWorkflow('ci');
        workflow.jobs[id].env[key] = value;
        assert.throws(() => checkUnprivilegedPackageJobs(workflow));
      });

for (const [name, mutate] of [
  ['removed outcome gate', (job, gate) => job.steps.splice(job.steps.indexOf(gate), 1)],
  [
    'outcome gate after downloads',
    (job, gate) => {
      job.steps.splice(job.steps.indexOf(gate), 1);
      job.steps.push(gate);
    },
  ],
  [
    'disabled outcome gate',
    (_job, gate) => {
      gate.if = '${{ false }}';
    },
  ],
])
  test(`aggregate refuses ${name}`, () => {
    const job = readWorkflow('ci').jobs['packed-cli'];
    mutate(
      job,
      job.steps.find((step) => step.run === outcomesCommand),
    );
    assert.throws(() => checkAggregate(job, 'pack-cli', 'packed-cli-consumer'));
  });

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

const mapControlsCommand = 'pnpm check:map-controls';
const mapControlsGuard = 'Require complete product map controls';

/** The product map controls job: uncached, unprivileged, no upload, joined to required CI only. */
function checkMapControls(workflow) {
  const job = workflow.jobs['map-controls'];
  requiredJob(job);
  // Every step runs in the default shell with only the job's own environment.
  assert.equal(workflow.defaults, undefined);
  assert.equal(job.defaults, undefined);
  assert.equal(workflow.jobs.ci.defaults, undefined);
  assert.deepEqual(job.env, { TURBO_TOKEN: '', TURBO_TEAM: '' });
  assert.equal(job.needs, undefined);
  assert.equal(job.strategy, undefined);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  // Checkout, pnpm and Node only: no cache, upload or download action.
  assert.deepEqual(
    job.steps.filter((step) => step.uses).map((step) => step.uses),
    [actions.checkout, actions.pnpm, actions.node],
  );
  assert.deepEqual(job.steps.find((step) => step.uses === actions.checkout).with, {
    'persist-credentials': false,
  });
  assert.equal(job.steps.find((step) => step.uses === actions.pnpm).with, undefined);
  assert.deepEqual(job.steps.find((step) => step.uses === actions.node).with, {
    'node-version-file': '.nvmrc',
  });
  assert.deepEqual(
    job.steps.filter((step) => step.run).map((step) => step.run),
    ['pnpm install --frozen-lockfile', mapControlsCommand],
  );
  const controls = job.steps.find((step) => step.run === mapControlsCommand);
  assert.deepEqual(Object.keys(controls).sort(), ['env', 'name', 'run']);
  assert.deepEqual(controls.env, { RELAVIUM_PACKAGE_SOURCE_SHA: '${{ github.sha }}' });
  // Required CI waits for it and refuses every result except success; the package aggregate does not.
  const ci = workflow.jobs.ci;
  assert.ok(ci.needs.includes('map-controls'));
  assert.ok(![workflow.jobs['packed-cli'].needs].flat().includes('map-controls'));
  const guard = ci.steps.find((step) => step.name === mapControlsGuard);
  assert.ok(guard, mapControlsGuard);
  assert.deepEqual(Object.keys(guard).sort(), ['env', 'name', 'run']);
  assert.deepEqual(guard.env, { MAP_CONTROLS_RESULT: '${{ needs.map-controls.result }}' });
  assert.equal(
    guard.run,
    "node -e \"require('node:assert/strict').equal(process.env.MAP_CONTROLS_RESULT, 'success')\"",
  );
  assert.equal(guard.if, undefined);
  assert.equal(guard['continue-on-error'], undefined);
}

test('required CI runs the product map controls uncached and without uploads; release does not', () => {
  checkMapControls(readWorkflow('ci'));
  // The release workflow's graph belongs to Step 9d (the 2026-10-24 ruling).
  assert.equal(readWorkflow('release').jobs['map-controls'], undefined);
});

for (const [name, mutate] of [
  [
    'a pnpm cache',
    (job) => (job.steps.find((step) => step.uses === actions.node).with.cache = 'pnpm'),
  ],
  [
    'a cache action',
    (job) =>
      job.steps.splice(3, 0, {
        uses: 'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830',
        with: { path: '.turbo', key: 'turbo' },
      }),
  ],
  [
    'an upload',
    (job) => job.steps.push({ uses: actions.upload, with: { name: 'maps', path: 'x' } }),
  ],
  ['credentials kept in the checkout', (job) => (job.steps[0].with['persist-credentials'] = true)],
  ['a build before the controls', (job) => job.steps.splice(4, 0, { run: 'pnpm turbo run build' })],
  ['a tolerated failure', (job) => (job['continue-on-error'] = true)],
  ['a disabled job', (job) => (job.if = '${{ false }}')],
  ['a longer deadline', (job) => (job['timeout-minutes'] = 30)],
  [
    'no source identity',
    (job) => delete job.steps.find((step) => step.run === mapControlsCommand).env,
  ],
  [
    'a tolerated controls step',
    (job) =>
      (job.steps.find((step) => step.run === mapControlsCommand)['continue-on-error'] = true),
  ],
  [
    'a custom shell on the controls step',
    (job) => (job.steps.find((step) => step.run === mapControlsCommand).shell = 'true {0}'),
  ],
  ['a default shell for the job', (job) => (job.defaults = { run: { shell: 'true {0}' } })],
  ['a preload in the job environment', (job) => (job.env.NODE_OPTIONS = '--import ./x.mjs')],
  ['write permissions', (job) => (job.permissions = { contents: 'write' })],
  ['another platform', (job) => (job['runs-on'] = 'macos-latest')],
  ['a dependency', (job) => (job.needs = 'pack-cli')],
  ['a matrix', (job) => (job.strategy = { matrix: { os: ['ubuntu-latest'] } })],
  [
    'pnpm setup inputs',
    (job) => (job.steps.find((step) => step.uses === actions.pnpm).with = { version: '9.12.3' }),
  ],
])
  test(`map controls job refuses ${name}`, () => {
    const workflow = readWorkflow('ci');
    mutate(workflow.jobs['map-controls']);
    assert.throws(() => checkMapControls(workflow), assert.AssertionError);
  });

for (const [name, mutate] of [
  [
    'removal from required CI',
    (jobs) => (jobs.ci.needs = jobs.ci.needs.filter((id) => id !== 'map-controls')),
  ],
  [
    'joining the package aggregate',
    (jobs) => (jobs['packed-cli'].needs = [...jobs['packed-cli'].needs, 'map-controls']),
  ],
  [
    'a removed guard',
    (jobs) => (jobs.ci.steps = jobs.ci.steps.filter((step) => step.name !== mapControlsGuard)),
  ],
  [
    'a disabled guard',
    (jobs) => (jobs.ci.steps.find((step) => step.name === mapControlsGuard).if = '${{ false }}'),
  ],
  [
    'a guard that admits other results',
    (jobs) => (jobs.ci.steps.find((step) => step.name === mapControlsGuard).run = 'true'),
  ],
  [
    'a guard reading another result',
    (jobs) =>
      (jobs.ci.steps.find((step) => step.name === mapControlsGuard).env = {
        MAP_CONTROLS_RESULT: '${{ needs.packed-cli.result }}',
      }),
  ],
  [
    'a tolerated guard',
    (jobs) =>
      (jobs.ci.steps.find((step) => step.name === mapControlsGuard)['continue-on-error'] = true),
  ],
  [
    'a custom shell on the guard',
    (jobs) => (jobs.ci.steps.find((step) => step.name === mapControlsGuard).shell = 'true {0}'),
  ],
  ['a default shell for ci', (jobs) => (jobs.ci.defaults = { run: { shell: 'true {0}' } })],
])
  test(`required CI refuses ${name} of the map controls`, () => {
    const workflow = readWorkflow('ci');
    mutate(workflow.jobs);
    assert.throws(() => checkMapControls(workflow), assert.AssertionError);
  });

test('a workflow-wide default shell refuses the map controls', () => {
  const workflow = readWorkflow('ci');
  workflow.defaults = { run: { shell: 'true {0}' } };
  assert.throws(() => checkMapControls(workflow), assert.AssertionError);
});

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
    [
      'node tools/cli-package/release-guard.mjs ./artifact',
      'npm publish ./artifact/*.tgz --provenance --access public',
    ],
  );
});

test('release publication is refused fail-closed until a verified release candidate exists', () => {
  const workflow = readWorkflow('release');
  const steps = workflow.jobs.publish.steps;
  const checkout = steps.find((step) => step.uses === actions.checkout);
  assert.deepEqual(checkout.with, {
    'persist-credentials': false,
    'sparse-checkout':
      '.nvmrc\ntools/cli-package/release-guard.mjs\ntools/cli-package/release-guard-core.mjs\n',
    'sparse-checkout-cone-mode': false,
  });
  const guard = steps.find(
    (step) => step.name === 'Refuse anything but a verified release candidate',
  );
  const publish = steps.find((step) => step.name === 'Publish');
  assert.equal(guard.run, 'node tools/cli-package/release-guard.mjs ./artifact');
  // An unconditional, non-advisory guard runs after the download and before any publish, under the
  // runner's default shell and directory: no condition, shell, environment or defaults at the step,
  // job or workflow level, and no earlier `run` step that could write the job's environment.
  assert.deepEqual(Object.keys(guard).sort(), ['name', 'run']);
  assert.deepEqual(Object.keys(workflow.jobs.publish).sort(), [
    'if',
    'name',
    'needs',
    'permissions',
    'runs-on',
    'steps',
    'timeout-minutes',
  ]);
  assert.deepEqual(Object.keys(workflow).sort(), ['concurrency', 'jobs', 'name', 'on']);
  assert.ok(steps.slice(0, steps.indexOf(guard)).every((step) => step.run === undefined));
  assert.ok(
    steps.indexOf(steps.find((step) => step.uses === actions.download)) < steps.indexOf(guard),
  );
  assert.equal(steps.indexOf(guard) + 1, steps.indexOf(publish));
  assert.equal(publish.if, undefined);
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

function checkRequiredSourceSmokes(workflow) {
  const job = workflow.jobs.ci;
  assert.ok(job, 'source smokes must run in the required ci job');
  assert.equal(job.if, '${{ always() }}');
  assert.equal(job['continue-on-error'], undefined);
  assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 30);
  assert.equal(workflow.defaults?.run?.['working-directory'], undefined);
  assert.equal(job.defaults?.run?.['working-directory'], undefined);
  const commands = [
    'pnpm install --frozen-lockfile',
    'pnpm turbo run build',
    'pnpm smoke:cli-bootstrap',
    'pnpm smoke:budget-replay',
  ];
  const indices = commands.map((command) => {
    const steps = job.steps.filter((step) => step.run === command);
    assert.equal(steps.length, 1, `${command} must be one actual required step`);
    const step = steps[0];
    assert.equal(step.if, undefined);
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step['working-directory'], undefined);
    assert.equal(step.uses, undefined);
    return job.steps.indexOf(step);
  });
  assert.ok(indices[0] < indices[1]);
  assert.ok(indices[1] < indices[2] && indices[1] < indices[3]);
}

test('required CI executes bootstrap and replay source smokes after install/build', () => {
  checkRequiredSourceSmokes(readWorkflow('ci'));
  const scripts = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts;
  assert.equal(scripts['smoke:cli-bootstrap'], 'node tools/cli-bootstrap/check.mjs');
  assert.equal(scripts['smoke:budget-replay'], 'node tools/budget-replay-compat/check.mjs');
});

for (const command of ['pnpm smoke:cli-bootstrap', 'pnpm smoke:budget-replay']) {
  for (const [name, mutate] of [
    ['removed', (job, step) => job.steps.splice(job.steps.indexOf(step), 1)],
    [
      'name-only',
      (_job, step) => {
        step.name = command;
        delete step.run;
      },
    ],
    [
      'echo-only',
      (_job, step) => {
        step.run = `echo ${command}`;
      },
    ],
    [
      'conditional',
      (_job, step) => {
        step.if = '${{ false }}';
      },
    ],
    [
      'ignored failure',
      (_job, step) => {
        step['continue-on-error'] = true;
      },
    ],
    [
      'different checkout directory',
      (_job, step) => {
        step['working-directory'] = 'scratch';
      },
    ],
    [
      'before build',
      (job, step) => {
        job.steps.splice(job.steps.indexOf(step), 1);
        job.steps.unshift(step);
      },
    ],
    [
      'advisory job',
      (job) => {
        job['continue-on-error'] = true;
      },
    ],
    [
      'disabled job',
      (job) => {
        job.if = '${{ false }}';
      },
    ],
  ]) {
    test(`required source smoke guard rejects ${command}: ${name}`, () => {
      const workflow = readWorkflow('ci');
      const job = workflow.jobs.ci;
      const step = job.steps.find((step) => step.run === command);
      mutate(job, step);
      assert.throws(() => checkRequiredSourceSmokes(workflow));
    });
  }
}

test('every CLI package, closure, bootstrap and CI tooling test runs in test:acceptance-tools', () => {
  // The list is the only place CI runs these files, so an unlisted test would silently never run.
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const listed = new Set(manifest.scripts['test:acceptance-tools'].split(' '));
  for (const directory of [
    'tools/cli-package',
    'tools/cli-package/smoke',
    'tools/bundle-closure',
    'tools/cli-bootstrap',
    'tools/ci',
  ]) {
    for (const name of readdirSync(new URL(directory, root))) {
      if (name.endsWith('.test.mjs')) assert.ok(listed.has(`${directory}/${name}`), name);
    }
  }
});
