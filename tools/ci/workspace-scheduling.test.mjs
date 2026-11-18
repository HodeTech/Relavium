import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const command = packageJson.scripts['ci:workspaces'];

test('actual enforced coverage entry keeps all cases in one file worker and propagates failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-coverage-scheduling-'));
  try {
    const entry = join(directory, 'tools', 'coverage-gate', 'run.mjs');
    const dependency = join(directory, 'node_modules', 'vitest');
    mkdirSync(join(directory, 'tools', 'coverage-gate'), { recursive: true });
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{}');
    writeFileSync(entry, readFileSync(new URL('tools/coverage-gate/run.mjs', root)));
    writeFileSync(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'vitest', bin: { vitest: 'entry.cjs' } }),
    );
    writeFileSync(
      join(dependency, 'entry.cjs'),
      `console.log(JSON.stringify({args:process.argv.slice(2),enforced:process.env.RELAVIUM_COVERAGE_ENFORCED_ONLY}));process.exit(37);`,
    );
    const result = spawnSync(process.execPath, [entry], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 37);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ['run', '--coverage', '--maxWorkers=1'],
      enforced: '1',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const [lintCode, testCode, expectedCode, calls] of [
  [0, 0, 0, ['lint typecheck', 'test --concurrency=1']],
  [31, 0, 31, ['lint typecheck']],
  [0, 42, 42, ['lint typecheck', 'test --concurrency=1']],
]) {
  test(`actual workspace command preserves order and failure: lint=${lintCode}, test=${testCode}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'relavium-workspace-scheduling-'));
    try {
      const script = join(directory, 'turbo.cjs');
      const log = join(directory, 'calls.jsonl');
      writeFileSync(
        script,
        `#!/usr/bin/env node
const {appendFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(args.shift()!=='run')process.exit(90);
appendFileSync(process.env.SCHEDULING_CALLS,JSON.stringify(args.join(' '))+'\\n');
if(args[0]==='lint')process.exit(${lintCode});
if(args[0]==='test')process.exit(${testCode});
process.exit(91);
`,
      );
      if (process.platform === 'win32')
        writeFileSync(join(directory, 'turbo.cmd'), '@node "%~dp0turbo.cjs" %*\r\n');
      else {
        writeFileSync(join(directory, 'turbo'), readFileSync(script));
        chmodSync(join(directory, 'turbo'), 0o700);
      }
      const result = spawnSync(command, {
        shell: true,
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
          SCHEDULING_CALLS: log,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedCode, result.stderr);
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), calls);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('required and local CI share all workspace tasks and uncached per-invocation DB evidence', () => {
  const require = createRequire(new URL('apps/cli/package.json', root));
  const { parse } = require('yaml');
  // TypeScript parses the repository's commented Turbo configuration without stripping strings.
  const { parseConfigFileTextToJson } = require('typescript');
  const turbo = parseConfigFileTextToJson(
    'turbo.json',
    readFileSync(new URL('turbo.json', root), 'utf8'),
  );
  assert.equal(turbo.error, undefined);
  assert.equal(command, 'turbo run lint typecheck && turbo run test --concurrency=1');
  assert.ok(packageJson.scripts.ci.split(' && ').includes('pnpm ci:workspaces'));
  const workflow = parse(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'));
  // The workspace job: the required `ci` context only aggregates it (pinned below with the guards).
  const ci = workflow.jobs['ci-work'];
  const workspace = ci.steps.find((step) => step.name === 'Lint, typecheck, test');
  assert.equal(workspace.run, 'pnpm ci:workspaces');
  assert.equal(workspace.if, undefined);
  assert.equal(workspace['continue-on-error'], undefined);
  assert.equal(ci['timeout-minutes'], 25);
  // It starts with the control jobs, after the native component only; a skipped or failed native build skips it, and the
  // aggregate refuses the skip.
  assert.equal(ci.needs, 'native-fs-assets');
  assert.equal(ci.if, undefined);
  assert.equal(ci['continue-on-error'], undefined);
  assert.equal(ci.defaults, undefined);
  const variable = 'RELAVIUM_DB_NATIVE_DIAGNOSTICS';
  assert.deepEqual(turbo.config.tasks['@relavium/db#test'].env, [variable]);
  assert.deepEqual(turbo.config.tasks['@relavium/db#test'].dependsOn, [
    '^build',
    '@relavium/db#build',
  ]);
  assert.equal(turbo.config.globalEnv, undefined);
  assert.equal(turbo.config.globalPassThroughEnv, undefined);
  const initialize = ci.steps.find(
    (step) => step.name === 'Initialize native DB scheduling diagnostics',
  );
  const directory = '${{ runner.temp }}/db-native-${{ github.run_id }}-${{ github.run_attempt }}';
  assert.equal(initialize.env[variable], `${directory}/events.jsonl`);
  assert.ok(initialize.run.includes('>> "$GITHUB_ENV"'));
  assert.ok(ci.steps.indexOf(initialize) < ci.steps.indexOf(workspace));
  const validate = ci.steps.find((step) => step.name === 'Require native DB execution diagnostics');
  assert.equal(validate.run, 'node tools/ci/require-native-db-diagnostics.mjs');
  assert.equal(validate.if, undefined);
  assert.equal(validate['continue-on-error'], undefined);
  assert.ok(ci.steps.indexOf(workspace) < ci.steps.indexOf(validate));
  assert.ok(
    packageJson.scripts['test:acceptance-tools']
      .split(' ')
      .includes('tools/ci/require-native-db-diagnostics.test.mjs'),
  );
  const artifact = ci.steps.find(
    (step) => step.name === 'Preserve native DB scheduling diagnostics',
  );
  assert.equal(artifact.if, '${{ always() }}');
  assert.equal(artifact.with.path, directory);
  assert.ok(ci.steps.indexOf(validate) < ci.steps.indexOf(artifact));
  const temporary = mkdtempSync(join(tmpdir(), 'relavium-ci-diagnostic-setup-'));
  try {
    const destination = join(temporary, 'diagnostic', 'events.jsonl');
    // Execute the workflow's actual Node body on every platform; its enclosing shell is Ubuntu bash.
    const source = initialize.run
      .split("node --input-type=module <<'NODE'\n")[1]
      ?.split('\nNODE\n')[0];
    assert.equal(typeof source, 'string');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, [variable]: destination },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(destination, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const context = JSON.parse(lines[0]);
    assert.equal(context.stage, 'ci-invocation');
    assert.equal(context.workspaceTestConcurrency, 1);
    // Execute the real required validator against the real setup output: setup is never execution.
    const validation = spawnSync(process.execPath, ['tools/ci/require-native-db-diagnostics.mjs'], {
      cwd: fileURLToPath(root),
      env: { ...process.env, [variable]: destination },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(validation.error, undefined);
    assert.equal(validation.status, 1);
    assert.equal(validation.stdout, '');
    assert.equal(validation.stderr, 'Native DB execution diagnostics are missing or invalid.\n');
    assert.ok(initialize.run.includes(`echo "${variable}=$${variable}" >> "$GITHUB_ENV"`));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const floor = workflow.jobs['floor-check'];
  assert.equal(floor['timeout-minutes'], 45);
  assert.equal(workflow.jobs.coverage['timeout-minutes'], 45);
  assert.equal(
    workflow.jobs.coverage.steps.find((step) => step.run === 'pnpm coverage:enforced')?.name,
    'Engine coverage floor (>=90% line+branch — llm, mcp enforced; core measured)',
  );
  assert.deepEqual(floor.env, { TURBO_TOKEN: '', TURBO_TEAM: '' });
  const floorCommand = floor.steps.find(
    (step) => step.name === 'Typecheck, test, build on the exact floor',
  );
  assert.deepEqual(floorCommand.run.trim().split('\n'), [
    'pnpm turbo run typecheck --force',
    'pnpm turbo run test --concurrency=1 --force -- --maxWorkers=1',
    'pnpm turbo run build --force',
  ]);
  assert.equal(floorCommand['continue-on-error'], undefined);
});

const nativeGuard = {
  name: 'Require all native component execution legs',
  env: { NATIVE_FS_RESULT: '${{ needs.native-fs-assets.result }}' },
  run: "node -e \"require('node:assert/strict').equal(process.env.NATIVE_FS_RESULT, 'success')\"",
};
function assertNativePrerequisite(job) {
  assert.equal(job.if, '${{ always() }}');
  assert.equal(job.needs, 'native-fs-assets');
  assert.equal(job.defaults, undefined);
  assert.equal(job['continue-on-error'], undefined);
  const guards = job.steps.filter((step) => step.name === nativeGuard.name);
  assert.deepEqual(guards, [nativeGuard]);
  const index = job.steps.indexOf(guards[0]);
  const setup = job.steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
  const download = job.steps.findIndex((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  assert.ok(setup >= 0);
  assert.equal(index, setup + 1, 'Native failure must refuse immediately after Node setup');
  assert.equal(download, index + 1, 'Artifact-dependent work must follow native admission');
}

test('required native admission refuses failed, missing and skipped dependency results before asset-dependent work', () => {
  const require = createRequire(new URL('apps/cli/package.json', root));
  const { parse } = require('yaml');
  const workflow = parse(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'));
  for (const id of ['coverage', 'windows-concurrency']) {
    assertNativePrerequisite(workflow.jobs[id]);
    for (const mutate of [
      (job) => {
        delete job.if;
      },
      (job) => {
        job.if = "${{ needs.native-fs-assets.result == 'success' }}";
      },
      (job) => {
        delete job.needs;
      },
      (job) => {
        job['continue-on-error'] = true;
      },
      (job) => {
        job.defaults = { run: { shell: 'true {0}' } };
      },
      (job) => {
        job.steps = job.steps.filter((step) => step.name !== nativeGuard.name);
      },
      (job) => {
        job.steps.find((step) => step.name === nativeGuard.name).if = '${{ success() }}';
      },
      (job) => {
        job.steps.find((step) => step.name === nativeGuard.name)['continue-on-error'] = true;
      },
      (job) => {
        job.steps.find((step) => step.name === nativeGuard.name).run = 'node -e "process.exit(0)"';
      },
      (job) => {
        const index = job.steps.findIndex((step) => step.name === nativeGuard.name);
        [job.steps[index], job.steps[index + 1]] = [job.steps[index + 1], job.steps[index]];
      },
    ]) {
      const changed = JSON.parse(JSON.stringify(workflow.jobs[id]));
      mutate(changed);
      assert.throws(() => assertNativePrerequisite(changed));
    }
    const guard = workflow.jobs[id].steps.find((step) => step.name === nativeGuard.name);
    const program = /^node -e "(.+)"$/u.exec(guard.run)?.[1];
    assert.equal(typeof program, 'string');
    for (const result of ['success', 'failure', 'cancelled', 'skipped', 'pending', '', undefined]) {
      const resultEnv = { ...process.env };
      delete resultEnv.NATIVE_FS_RESULT;
      if (result !== undefined) resultEnv.NATIVE_FS_RESULT = result;
      const execution = spawnSync(process.execPath, ['-e', program], {
        env: resultEnv,
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(execution.error, undefined);
      assert.equal(execution.signal, null);
      assert.equal(execution.status, result === 'success' ? 0 : 1);
      assert.equal(execution.stdout, '');
    }
  }
});

test('required checks keep their branch-protection names and cannot be skipped', () => {
  // An ordinary job-level `if` or failed dependency skips the job, which GitHub counts as passing.
  // The explicit always() + early native-result assertion keeps these required contexts fail-closed; a default or step shell can turn a step into a no-op. A rename leaves the required
  // context unreported and blocks merges, so the name pin keeps the job and branch protection in step
  // (D64 round-1 and round-3 findings on the PR #96 correction).
  const require = createRequire(new URL('apps/cli/package.json', root));
  const { parse } = require('yaml');
  const workflow = parse(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'));
  for (const [id, name] of [
    ['coverage', 'engine coverage floor (llm, mcp)'],
    ['windows-concurrency', 'windows · db concurrency + filesystem + headless smoke'],
  ]) {
    const job = workflow.jobs[id];
    assert.equal(job.name, name, id);
    assertNativePrerequisite(job);
    assert.equal(job['continue-on-error'], undefined, id);
    assert.equal(job.needs, 'native-fs-assets', id);
    assert.equal(job.defaults, undefined, id);
  }
  // The aggregate keeps its required context name (its `if: always()` is pinned with its needs).
  assert.equal(workflow.jobs.ci.name, 'lint · typecheck · test');
  // Its guard steps keep exactly their keys: no `if`, `continue-on-error` or `shell` can soften one.
  assert.equal(workflow.jobs.ci.defaults, undefined);
  const guards = workflow.jobs.ci.steps.filter((step) => step.name?.startsWith('Require '));
  assert.ok(guards.length >= 7);
  for (const guard of guards) {
    const keys = guard.env === undefined ? ['name', 'run'] : ['env', 'name', 'run'];
    assert.deepEqual(Object.keys(guard).sort(), keys, guard.name);
  }
  for (const step of workflow.jobs.coverage.steps) {
    assert.equal(step.if, undefined, step.name ?? step.uses);
    assert.equal(step['continue-on-error'], undefined, step.name ?? step.uses);
    assert.equal(step.shell, undefined, step.name ?? step.uses);
  }
  const steps = workflow.jobs['windows-concurrency'].steps;
  const build = steps.findIndex((step) => step.id === 'windows-build');
  assert.ok(build > 0);
  assert.ok(steps.length > build + 1);
  for (const step of steps.slice(0, build + 1)) {
    assert.equal(step.if, undefined, step.name ?? step.uses);
    assert.equal(step['continue-on-error'], undefined, step.name ?? step.uses);
  }
  for (const step of steps) {
    // Only the headless smoke names a shell, and only bash.
    const smoke = step.name?.startsWith('Headless no-TTY smoke') === true;
    assert.equal(step.shell, smoke ? 'bash' : undefined, step.name ?? step.uses);
  }
  for (const step of steps.slice(build + 1)) {
    assert.equal(
      step.if,
      "${{ !cancelled() && steps.windows-build.outcome == 'success' }}",
      step.name,
    );
    assert.equal(step['continue-on-error'], undefined, step.name);
  }
});

test('Windows cohorts retain twenty-four serial filesystem files and media cases', () => {
  const require = createRequire(new URL('apps/cli/package.json', root));
  const { parse } = require('yaml');
  const workflow = parse(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'));
  const job = workflow.jobs['windows-concurrency'];
  assert.equal(job['timeout-minutes'], 25);
  const step = job.steps.find(
    (candidate) =>
      candidate.name ===
      'Native CLI filesystem admission, containment, catalog and config (ADR-0105)',
  );
  assert.ok(step);
  assert.equal(step['continue-on-error'], undefined);
  assert.equal(step.if, "${{ !cancelled() && steps.windows-build.outcome == 'success' }}");
  const files = [
    'src/config/paths.test.ts',
    'src/engine/tool-host/fs-policy.test.ts',
    'src/engine/tool-host/fs-policy-native-paths.test.ts',
    'src/engine/tool-host/fs-ancestor-consumers.test.ts',
    'src/engine/tool-host/fs.test.ts',
    'src/engine/tool-host/fs-mvp3.test.ts',
    'src/engine/tool-host/fs-discovery-ignore-work.test.ts',
    'src/engine/tool-host/fs-path-component.test.ts',
    'src/engine/tool-host/fs-unicode-policy.test.ts',
    'src/engine/tool-host/fs-native-write.test.ts',
    'src/engine/tool-host/session-output-store.test.ts',
    'src/commands/fs-invocation.test.ts',
    'src/commands/fs-workspace-admission.test.ts',
    'src/workflows/catalog.test.ts',
    'src/config/resolve.test.ts',
    'src/engine/tool-host/fs-policy-scratch-composition.test.ts',
    'src/engine/tool-host/fs-rooted-glob.test.ts',
    'src/engine/tool-host/fs-write-floor-contract.test.ts',
    'src/engine/tool-host/fs-prepared.test.ts',
    'src/engine/tool-host/fs-creation-mask.test.ts',
    'src/engine/tool-host/fs-stage-inventory.test.ts',
    'src/engine/tool-host/fs-stage-namespace.test.ts',
    'src/engine/tool-host/prepared-replay.e2e.test.ts',
    'src/engine/host.test.ts',
  ];
  assert.equal(files.length, 24);
  for (const file of files) assert.ok(existsSync(new URL(`apps/cli/${file}`, root)), file);
  assert.deepEqual(step.run.trim().split(/\s+/), [
    'pnpm',
    '--filter',
    'relavium',
    'exec',
    'vitest',
    'run',
    '--no-file-parallelism',
    '--maxWorkers=1',
    ...files,
  ]);
  const cohorts = [
    {
      name: 'Shared media byte verification and publication (ADR-0106)',
      serial: false,
      workspace: '@relavium/shared',
      directory: 'packages/shared',
      files: [
        'src/media-admission.test.ts',
        'src/media-deinline.test.ts',
        'src/media-deinline-lifecycle.test.ts',
        'src/media-iterator.test.ts',
        'src/media-publication.test.ts',
        'src/media-verifier.test.ts',
        'src/media-verifier-invalid.test.ts',
        'src/media-verifier-variants.test.ts',
        'src/media-verifier-identity.test.ts',
        'src/media-generated-result.test.ts',
        'src/media-verifier-vorbis.test.ts',
        'src/media-verifier-box-size.test.ts',
        'src/media-verifier-opus.test.ts',
        'src/media-verifier-flac.test.ts',
      ],
    },
    {
      name: 'Native CLI media publication and offline temporary maintenance (ADR-0106)',
      serial: true,
      workspace: 'relavium',
      directory: 'apps/cli',
      files: [
        'src/engine/media-paid-publication.test.ts',
        'src/engine/media-provider-admission.test.ts',
        'src/engine/media-publication.e2e.test.ts',
        'src/engine/media-retention-ack.test.ts',
        'src/engine/media-gc.test.ts',
        'src/engine/media-gc-delete-races.test.ts',
        'src/run-media-prune.test.ts',
        'src/engine/media-generated-publication.test.ts',
      ],
    },
  ];
  for (const cohort of cohorts) {
    const selected = job.steps.find((candidate) => candidate.name === cohort.name);
    assert.ok(selected);
    assert.equal(selected.if, "${{ !cancelled() && steps.windows-build.outcome == 'success' }}");
    assert.equal(selected['continue-on-error'], undefined);
    for (const file of cohort.files)
      assert.ok(existsSync(new URL(`${cohort.directory}/${file}`, root)), file);
    assert.deepEqual(selected.run.trim().split(/\s+/), [
      'pnpm',
      '--filter',
      cohort.workspace,
      'exec',
      'vitest',
      'run',
      ...(cohort.serial ? ['--no-file-parallelism', '--maxWorkers=1'] : []),
      ...cohort.files,
    ]);
  }
  const db = job.steps.find(
    (candidate) =>
      candidate.name ===
      'DB concurrency suite (BEGIN IMMEDIATE + SQLITE_BUSY retry + WAL behave identically on Windows)',
  );
  assert.ok(db);
  assert.equal(db.if, "${{ !cancelled() && steps.windows-build.outcome == 'success' }}");
  assert.equal(db['continue-on-error'], undefined);
  assert.equal(db.run, 'pnpm --filter @relavium/db test');
});

/** The required `ci` context joins the workspace job (`ci-work`) and refuses every result but success; it does no work itself. */
function checkWorkspaceJoin(workflow) {
  const ci = workflow.jobs.ci;
  assert.ok(ci.needs.includes('ci-work'));
  assert.equal(ci.if, '${{ always() }}');
  assert.equal(ci.name, 'lint · typecheck · test');
  // The required result is the job's own: a job that tolerates failure would report success whatever its guards say.
  assert.equal(ci['continue-on-error'], undefined);
  // It runs repository code and needs no remote-cache credentials (the packed-CLI aggregate clears them the same way).
  assert.deepEqual(ci.env, { TURBO_TOKEN: '', TURBO_TEAM: '' });
  const guard = ci.steps.find((step) => step.name === 'Require complete workspace checks');
  assert.ok(guard);
  assert.deepEqual(Object.keys(guard).sort(), ['env', 'name', 'run']);
  assert.deepEqual(guard.env, { WORKSPACE_CHECKS_RESULT: '${{ needs.ci-work.result }}' });
  assert.equal(
    guard.run,
    "node -e \"require('node:assert/strict').equal(process.env.WORKSPACE_CHECKS_RESULT, 'success')\"",
  );
  assert.ok(
    !ci.steps.some(
      (step) => step.run === 'pnpm ci:workspaces' || step.run?.startsWith('pnpm install'),
    ),
    'the aggregate does no work of its own',
  );
  const work = workflow.jobs['ci-work'];
  assert.equal(work.needs, 'native-fs-assets');
  assert.equal(work.if, undefined);
  assert.equal(work['continue-on-error'], undefined);
  assert.ok(work.steps.some((step) => step.run === 'pnpm ci:workspaces'));
}

const readCiWorkflow = () => {
  const require = createRequire(new URL('apps/cli/package.json', root));
  const { parse } = require('yaml');
  return parse(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'));
};

test('the required ci context joins the workspace job and refuses every result but success', () => {
  checkWorkspaceJoin(readCiWorkflow());
});

for (const [name, mutate] of [
  [
    'the workspace job dropped from needs',
    (w) => (w.jobs.ci.needs = w.jobs.ci.needs.filter((id) => id !== 'ci-work')),
  ],
  [
    'the workspace guard removed',
    (w) =>
      (w.jobs.ci.steps = w.jobs.ci.steps.filter(
        (s) => s.name !== 'Require complete workspace checks',
      )),
  ],
  [
    'the workspace guard conditional',
    (w) =>
      (w.jobs.ci.steps.find((s) => s.name === 'Require complete workspace checks').if =
        '${{ false }}'),
  ],
  [
    'the workspace guard ignoring failure',
    (w) =>
      (w.jobs.ci.steps.find((s) => s.name === 'Require complete workspace checks')[
        'continue-on-error'
      ] = true),
  ],
  [
    'the workspace guard neutered',
    (w) =>
      (w.jobs.ci.steps.find((s) => s.name === 'Require complete workspace checks').run = 'true'),
  ],
  [
    'the workspace guard reading another job',
    (w) =>
      (w.jobs.ci.steps.find(
        (s) => s.name === 'Require complete workspace checks',
      ).env.WORKSPACE_CHECKS_RESULT = '${{ needs.packed-cli.result }}'),
  ],
  [
    'the workspace guard under another shell',
    (w) =>
      (w.jobs.ci.steps.find((s) => s.name === 'Require complete workspace checks').shell =
        'true {0}'),
  ],
  ['the aggregate no longer always running', (w) => delete w.jobs.ci.if],
  ['the aggregate inheriting the remote-cache credentials', (w) => delete w.jobs.ci.env],
  ['the aggregate tolerating failure', (w) => (w.jobs.ci['continue-on-error'] = true)],
  ['the workspace job conditional', (w) => (w.jobs['ci-work'].if = '${{ false }}')],
  ['the workspace job advisory', (w) => (w.jobs['ci-work']['continue-on-error'] = true)],
  ['the workspace job without its native prerequisite', (w) => delete w.jobs['ci-work'].needs],
  [
    'the workspace job doing no checks',
    (w) =>
      (w.jobs['ci-work'].steps = w.jobs['ci-work'].steps.filter(
        (s) => s.run !== 'pnpm ci:workspaces',
      )),
  ],
  [
    'the aggregate doing the work again',
    (w) => w.jobs.ci.steps.push({ run: 'pnpm ci:workspaces' }),
  ],
]) {
  test(`the workspace join refuses ${name}`, () => {
    const workflow = readCiWorkflow();
    mutate(workflow);
    assert.throws(() => checkWorkspaceJoin(workflow), assert.AssertionError);
  });
}

/** The commands the workspace job must run, each exactly once: the checks the required context stands for. */
const WORKSPACE_COMMANDS = [
  'pnpm install --frozen-lockfile',
  'pnpm ci:workspaces',
  'pnpm typecheck:tools',
  'pnpm turbo run build',
  'pnpm lint:bundle-closure',
  'pnpm smoke:cli-bootstrap',
  'pnpm db:sync-check',
  'pnpm turbo run format:check',
  'pnpm lint:fence-check',
  'pnpm lint:engine-deps',
  'pnpm lint:tools',
  'pnpm lint:test-isolation',
  'pnpm smoke:cli',
  'pnpm smoke:media-packaging',
  'pnpm smoke:overflow-capture',
  'pnpm smoke:budget-replay',
];

/** Every check of the workspace job is a real, unconditional step: none can be skipped, tolerated, or turned into an echo. */
function checkWorkspaceSteps(workflow) {
  const work = workflow.jobs['ci-work'];
  const checkout = work.steps[0];
  assert.ok(checkout.uses.startsWith('actions/checkout@'));
  // The replay check verifies frozen blobs against a predecessor commit, so the whole history is needed.
  assert.deepEqual(checkout.with, { 'persist-credentials': false, 'fetch-depth': 0 });
  assert.equal(work['timeout-minutes'], 25);
  for (const command of WORKSPACE_COMMANDS) {
    const steps = work.steps.filter((step) => step.run === command);
    assert.equal(steps.length, 1, `${command} must be exactly one step of the workspace job`);
  }
  // The root ci script's own steps (less the controls, the acceptance tools and CI's package checks) are all among them.
  const chain = packageJson.scripts.ci.split(' && ');
  const owned = new Set(['smoke:cli-package', 'check:map-controls', 'test:acceptance-tools']);
  for (const step of chain) {
    const script = step.replace(/^pnpm /u, '');
    if (step === 'turbo run build format:check') continue;
    if (owned.has(script) || /^check:.*-mutations$/u.test(script)) continue;
    assert.ok(
      WORKSPACE_COMMANDS.includes(step),
      `the ci script's ${step} must run in the workspace job`,
    );
  }
  for (const step of work.steps) {
    const name = step.name ?? step.uses;
    assert.equal(step['continue-on-error'], undefined, name);
    assert.equal(step['working-directory'], undefined, name);
    // Only the diagnostics upload is conditional (it must run after a failure); only the replay fetch picks a shell.
    const upload = step.name === 'Preserve native DB scheduling diagnostics';
    assert.equal(step.if, upload ? '${{ always() }}' : undefined, name);
    const bash = step.name === 'Ensure immutable replay predecessor is available';
    assert.equal(step.shell, bash ? 'bash' : undefined, name);
  }
}

test('every check of the workspace job is a real, unconditional step', () => {
  checkWorkspaceSteps(readCiWorkflow());
});

for (const [name, mutate] of [
  [
    'a check turned into an echo',
    (w) =>
      (w.jobs['ci-work'].steps.find((s) => s.run === 'pnpm smoke:cli').run = 'echo pnpm smoke:cli'),
  ],
  [
    'a check removed',
    (w) =>
      (w.jobs['ci-work'].steps = w.jobs['ci-work'].steps.filter(
        (s) => s.run !== 'pnpm lint:tools',
      )),
  ],
  ['a check run twice', (w) => w.jobs['ci-work'].steps.push({ run: 'pnpm db:sync-check' })],
  [
    'a check tolerating failure',
    (w) =>
      (w.jobs['ci-work'].steps.find((s) => s.run === 'pnpm turbo run format:check')[
        'continue-on-error'
      ] = true),
  ],
  [
    'a check made conditional',
    (w) =>
      (w.jobs['ci-work'].steps.find((s) => s.run === 'pnpm smoke:overflow-capture').if =
        '${{ false }}'),
  ],
  [
    'a check run from another directory',
    (w) =>
      (w.jobs['ci-work'].steps.find((s) => s.run === 'pnpm lint:fence-check')['working-directory'] =
        'scratch'),
  ],
  [
    'a check under another shell',
    (w) => (w.jobs['ci-work'].steps.find((s) => s.run === 'pnpm smoke:cli').shell = 'true {0}'),
  ],
  ['the history checkout shortened', (w) => delete w.jobs['ci-work'].steps[0].with['fetch-depth']],
  [
    'the checkout keeping its credentials',
    (w) => delete w.jobs['ci-work'].steps[0].with['persist-credentials'],
  ],
  [
    'the diagnostics upload no longer unconditional',
    (w) =>
      delete w.jobs['ci-work'].steps.find(
        (s) => s.name === 'Preserve native DB scheduling diagnostics',
      ).if,
  ],
]) {
  test(`the workspace steps refuse ${name}`, () => {
    const workflow = readCiWorkflow();
    mutate(workflow);
    assert.throws(() => checkWorkspaceSteps(workflow), assert.AssertionError);
  });
}
