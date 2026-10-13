import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const command = packageJson.scripts['ci:workspaces'];

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
  const ci = workflow.jobs.ci;
  const workspace = ci.steps.find((step) => step.name === 'Lint, typecheck, test');
  assert.equal(workspace.run, 'pnpm ci:workspaces');
  assert.equal(workspace.if, undefined);
  assert.equal(workspace['continue-on-error'], undefined);
  assert.equal(ci['timeout-minutes'], 15);
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
  const artifact = ci.steps.find(
    (step) => step.name === 'Preserve native DB scheduling diagnostics',
  );
  assert.equal(artifact.if, '${{ always() }}');
  assert.equal(artifact.with.path, directory);
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
    assert.ok(initialize.run.includes(`echo "${variable}=$${variable}" >> "$GITHUB_ENV"`));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const floor = workflow.jobs['floor-check'];
  assert.equal(floor['timeout-minutes'], 15);
  assert.deepEqual(floor.env, { TURBO_TOKEN: '', TURBO_TEAM: '' });
  const floorCommand = floor.steps.find(
    (step) => step.name === 'Typecheck, test, build on the exact floor',
  );
  assert.deepEqual(floorCommand.run.trim().split('\n'), [
    'pnpm turbo run typecheck --force',
    'pnpm turbo run test --concurrency=1 --force',
    'pnpm turbo run build --force',
  ]);
  assert.equal(floorCommand['continue-on-error'], undefined);
});

test('Windows native CLI filesystem cohort runs serially with all nine physical files', () => {
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
  const files = [
    'src/config/paths.test.ts',
    'src/engine/tool-host/fs-policy.test.ts',
    'src/engine/tool-host/fs-policy-native-paths.test.ts',
    'src/engine/tool-host/fs-ancestor-consumers.test.ts',
    'src/engine/tool-host/fs.test.ts',
    'src/commands/fs-invocation.test.ts',
    'src/commands/fs-workspace-admission.test.ts',
    'src/workflows/catalog.test.ts',
    'src/config/resolve.test.ts',
  ];
  assert.equal(files.length, 9);
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
});
