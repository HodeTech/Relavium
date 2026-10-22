import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The orchestrator runs from a copied tooling tree with a fake tsup that only records that it ran,
// so no case can rebuild the real CLI even if the orchestration regresses.
const tooling = fileURLToPath(new URL('../', import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-prepack-orchestrator-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

function fixture({ buildExit = 0, tsup: installed = true } = {}) {
  count += 1;
  const root = join(scratch, `repository-${count}`);
  for (const path of [
    'cli-package/prepack.mjs',
    'cli-package/finalize.mjs',
    'cli-package/files.mjs',
    'cli-package/paths.mjs',
    'bundle-closure/closure.mjs',
    'bundle-closure/inventory.mjs',
    'bundle-closure/check.mjs',
  ]) {
    mkdirSync(dirname(join(root, 'tools', path)), { recursive: true });
    copyFileSync(join(tooling, path), join(root, 'tools', path));
  }
  symlinkSync(
    fileURLToPath(new URL('../../node_modules', import.meta.url)),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const cli = join(root, 'apps', 'cli');
  const tsup = join(cli, 'node_modules', 'tsup');
  const marker = join(root, 'build-ran');
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'relavium', dependencies: {} }));
  if (!installed) return { root, cli, marker };
  mkdirSync(join(tsup, 'dist'), { recursive: true });
  writeFileSync(
    join(tsup, 'package.json'),
    JSON.stringify({ name: 'tsup', type: 'module', bin: { tsup: 'dist/cli.js' } }),
  );
  writeFileSync(
    join(tsup, 'dist', 'cli.js'),
    `import { appendFileSync } from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(marker)}, (process.env.RELAVIUM_CLI_CANDIDATE_STAGING ?? 'ordinary') + '\\n');\n` +
      `console.log('ESM Build start');\nprocess.exit(${buildExit});\n`,
  );
  return { root, cli, marker };
}

function prepack({ cli, root }, { cwd = cli, staging } = {}) {
  const env = { ...process.env };
  delete env.RELAVIUM_CLI_CANDIDATE_STAGING;
  if (staging !== undefined) env.RELAVIUM_CLI_CANDIDATE_STAGING = staging;
  const result = spawnSync(process.execPath, [join(root, 'tools', 'cli-package', 'prepack.mjs')], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

function privateStaging() {
  count += 1;
  const staging = join(scratch, `staging-${count}`);
  mkdirSync(staging);
  chmodSync(staging, 0o700);
  return staging;
}

test('prepack runs only in the CLI package directory', () => {
  const candidate = fixture();
  const result = prepack(candidate, { cwd: candidate.root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /✗ CLI prepack must run in its package directory/u);
  assert.equal(existsSync(candidate.marker), false);
});

test('an unusable staging directory refuses before anything is built', () => {
  for (const staging of ['relative', join(scratch, 'absent')]) {
    const candidate = fixture();
    const result = prepack(candidate, { staging });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLI candidate finalization refused: STAGING_PATH/u);
    assert.equal(existsSync(candidate.marker), false);
  }
});

test('a failed build stops before the closure gate or finalization', () => {
  const candidate = fixture({ buildExit: 3 });
  const staging = privateStaging();
  const result = prepack(candidate, { staging });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /✗ CLI build failed/u);
  assert.equal(readFileSync(candidate.marker, 'utf8'), `${staging}\n`);
  assert.equal(existsSync(join(staging, 'maps')), false);
});

test('one build runs, then the ordinary closure gate or the candidate finalizer judges its output', () => {
  // The fake build emits nothing, so both judges must refuse the missing output after one build.
  const ordinary = fixture();
  const plain = prepack(ordinary);
  assert.equal(plain.status, 1);
  assert.equal(readFileSync(ordinary.marker, 'utf8'), 'ordinary\n');
  assert.match(plain.stdout, /ESM Build start/u);
  assert.match(plain.stderr, /✗ CLI bundle closure: cannot read valid build inventory/u);

  const candidate = fixture();
  const staging = privateStaging();
  const mapped = prepack(candidate, { staging });
  assert.equal(mapped.status, 1);
  assert.equal(readFileSync(candidate.marker, 'utf8'), `${staging}\n`);
  assert.match(
    mapped.stderr,
    /✗ CLI candidate finalization refused: UNREADABLE_FILE \(metafile\)/u,
  );
  assert.doesNotMatch(mapped.stdout, /CLI candidate finalized/u);
});

test('an unexpected error prints only its code, never its message or a host path', () => {
  // Without an installed tsup the resolution fails with an error whose message names absolute
  // fixture paths; only its code may reach the pack log.
  const candidate = fixture({ tsup: false });
  const staging = privateStaging();
  const result = prepack(candidate, { staging });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '✗ CLI candidate finalization failed: MODULE_NOT_FOUND\n');
  assert.equal(existsSync(candidate.marker), false);
});
