import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import {
  CI_ENV,
  CI_OWNED,
  LANES,
  planGate,
  resolveGit,
  resolvePnpmEntry,
  runGate,
  selectSteps,
  spawnStep,
  terminateAll,
  treeFingerprint,
} from './local-gate.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const ciScript = JSON.parse(read('package.json')).scripts.ci;
const ciSteps = ciScript.split(' && ');
const scriptOf = (step) => step.replace(/^pnpm /u, '');

test('every step of the root ci script is serial, a lane or CI’s — none can be dropped', () => {
  const plan = planGate(ciScript);
  const lane = new Set(LANES.keys());
  const serial = ciSteps.filter((step) => !CI_OWNED.has(step) && !lane.has(scriptOf(step)));
  // The serial steps keep the script's order, and the CI-environment test run follows them.
  assert.equal(plan.serial.length, serial.length + 1);
  assert.deepEqual(
    plan.serial.slice(0, -1).map((step) => step.args.join(' ')),
    serial.map((step) => (step.startsWith('turbo ') ? `exec ${step}` : scriptOf(step))),
  );
  // CI runs one workspace test task at a time (`turbo run test --concurrency=1`); the CI-environment run keeps that and adds --force.
  assert.deepEqual(plan.serial.at(-1).args, [
    'exec',
    'turbo',
    'run',
    'test',
    '--concurrency=1',
    '--force',
  ]);
  assert.deepEqual(
    plan.skipped,
    ciSteps.filter((step) => CI_OWNED.has(step)),
  );
  // Every name the runner treats specially is really in the script, so a rename cannot leave it inert.
  for (const script of LANES.keys()) assert.ok(ciSteps.includes(`pnpm ${script}`), script);
  for (const step of CI_OWNED) assert.ok(ciSteps.includes(step), step);
});

test('each causal-control family is cut into the shards CI runs, every shard once', () => {
  const plan = planGate(ciScript);
  for (const [script, shards] of LANES) {
    const lanes = plan.lanes.filter((step) => step.args[0] === script);
    if (shards === 1)
      assert.deepEqual(
        lanes.map((step) => step.args),
        [[script]],
      );
    else {
      assert.deepEqual(
        lanes.map((step) => step.args),
        Array.from({ length: shards }, (_, index) => [script, '--shard', `${index + 1}/${shards}`]),
      );
    }
  }
  assert.equal(new Set(plan.lanes.map((step) => step.name)).size, plan.lanes.length);
});

test('the local shard counts equal the ones the CI workflow runs', () => {
  const require = createRequire(new URL('../../apps/cli/package.json', import.meta.url));
  const { parse } = require('yaml');
  const workflow = parse(read('.github/workflows/ci.yml'));
  for (const [script, shards] of LANES) {
    const job = workflow.jobs[script.replace(/^check:/u, '')];
    const matrix = job.strategy?.matrix?.shard;
    assert.equal(matrix?.length ?? 1, shards, script);
    const command = job.steps.find((step) => step.run?.startsWith(`pnpm ${script}`));
    assert.equal(
      command.run,
      shards === 1 ? `pnpm ${script}` : `pnpm ${script} --shard \${{ matrix.shard }}/${shards}`,
    );
  }
});

test('the CI environment is set on the workspace tests and on coverage, and on nothing else', () => {
  for (const profile of ['safe', 'fast']) {
    const plan = planGate(ciScript, { profile });
    const all = [...plan.serial, ...plan.lanes, ...plan.after];
    const withEnvironment = all
      .filter((step) => Object.keys(step.env).length > 0)
      .map((step) => step.name);
    assert.deepEqual(new Set(withEnvironment), new Set(['workspace-tests-ci-env', 'coverage']));
    for (const step of all) {
      assert.deepEqual(step.env, withEnvironment.includes(step.name) ? CI_ENV : {}, step.name);
    }
  }
});

test('coverage runs alone after the lanes in safe, and as a lane in fast', () => {
  const safe = planGate(ciScript, { profile: 'safe' });
  assert.deepEqual(
    safe.after.map((step) => step.name),
    ['coverage'],
  );
  assert.ok(!safe.lanes.some((step) => step.name === 'coverage'));
  const fast = planGate(ciScript, { profile: 'fast' });
  assert.deepEqual(fast.after, []);
  assert.ok(fast.lanes.some((step) => step.name === 'coverage'));
  assert.equal(fast.lanes.length, safe.lanes.length + 1);
});

test('a step the runner cannot classify, or an unknown profile, fails closed', () => {
  assert.throws(() => planGate('pnpm lint && ./deploy.sh'), /cannot classify/u);
  assert.throws(
    () => planGate('pnpm lint && curl http://example.invalid | sh'),
    /cannot classify/u,
  );
  assert.throws(() => planGate('pnpm'), /cannot classify/u);
  assert.throws(() => planGate(ciScript, { profile: 'turbo' }), /Unknown profile/u);
});

test('the steps CI owns are skipped by default and run, in order, on request', () => {
  const included = planGate(ciScript, { includeCiOwned: true });
  assert.deepEqual(included.skipped, []);
  for (const step of CI_OWNED)
    assert.ok(
      included.serial.some((entry) => entry.args[0] === scriptOf(step)),
      step,
    );
});

const stepNamed = (name, extra = {}) => ({ name, args: [name], env: {}, ...extra });
const outcome = (code) => ({ code, seconds: 0 });

test('a failing serial step stops everything after it, the lanes included', async () => {
  const plan = {
    serial: [stepNamed('a'), stepNamed('b'), stepNamed('c')],
    lanes: [stepNamed('l1')],
    after: [stepNamed('z')],
    skipped: [],
  };
  const ran = [];
  const { results, ok } = await runGate(plan, {
    outDir: '/x',
    execute: async (step) => {
      ran.push(step.name);
      return outcome(step.name === 'b' ? 1 : 0);
    },
  });
  assert.equal(ok, false);
  assert.deepEqual(ran, ['a', 'b']);
  assert.deepEqual(
    results.map((result) => [result.name, result.code]),
    [
      ['a', 0],
      ['b', 1],
      ['c', undefined],
      ['l1', undefined],
      ['z', undefined],
    ],
  );
});

test('--keep-going runs the rest after a failure and still reports it', async () => {
  const plan = {
    serial: [stepNamed('a'), stepNamed('b')],
    lanes: [stepNamed('l1')],
    after: [stepNamed('z')],
    skipped: [],
  };
  const ran = [];
  const { ok } = await runGate(plan, {
    outDir: '/x',
    keepGoing: true,
    execute: async (step) => {
      ran.push(step.name);
      return outcome(step.name === 'a' ? 2 : 0);
    },
  });
  assert.equal(ok, false);
  assert.deepEqual(ran, ['a', 'b', 'l1', 'z']);
});

test(
  'the lanes run together, and the steps after them wait for every lane',
  { timeout: 10_000 },
  async () => {
    const plan = {
      serial: [],
      lanes: [stepNamed('l1'), stepNamed('l2'), stepNamed('l3')],
      after: [stepNamed('z')],
      skipped: [],
    };
    const events = [];
    let started = 0;
    let release;
    const everyLaneStarted = new Promise((resolve) => (release = resolve));
    const { ok } = await runGate(plan, {
      outDir: '/x',
      execute: async (step) => {
        events.push(`start ${step.name}`);
        if (step.name !== 'z') {
          // A lane finishes only once all three have started: run one after another, the first would wait for ever.
          if (++started === 3) release();
          await everyLaneStarted;
          await new Promise((resolve) => setTimeout(resolve, step.name === 'l1' ? 30 : 5));
        }
        events.push(`end ${step.name}`);
        return outcome(0);
      },
    });
    assert.equal(ok, true);
    assert.deepEqual(events.slice(0, 3).sort(), ['start l1', 'start l2', 'start l3']);
    assert.deepEqual(events.slice(-2), ['start z', 'end z']);
    assert.ok(
      ['end l1', 'end l2', 'end l3'].every(
        (event) => events.indexOf(event) < events.indexOf('start z'),
      ),
    );
  },
);

test('a step runs through the given entry point, writes its log and returns its exit code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-gate-test-'));
  try {
    const entry = join(directory, 'pnpm.cjs');
    writeFileSync(
      entry,
      'console.log(JSON.stringify({ args: process.argv.slice(2), ci: process.env.CI ?? null, actions: process.env.GITHUB_ACTIONS ?? null })); process.exit(Number(process.argv[2]));',
    );
    const clean = { PATH: process.env.PATH };
    const ok = await spawnStep(
      { name: 'ok', args: ['0', 'x'], env: CI_ENV },
      join(directory, 'ok.log'),
      { entry, cwd: directory, env: clean },
    );
    assert.equal(ok.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'ok.log'), 'utf8')), {
      args: ['0', 'x'],
      ci: 'true',
      actions: 'true',
    });
    const bad = await spawnStep({ name: 'bad', args: ['3'], env: {} }, join(directory, 'bad.log'), {
      entry,
      cwd: directory,
      env: clean,
    });
    assert.equal(bad.code, 3);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'bad.log'), 'utf8')), {
      args: ['3'],
      ci: null,
      actions: null,
    });
    const missing = await spawnStep(
      { name: 'gone', args: [], env: {} },
      join(directory, 'gone.log'),
      { entry: join(directory, 'nope.cjs'), cwd: directory, env: clean },
    );
    assert.notEqual(missing.code, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only pnpm’s own entry point is accepted, never npm’s, a missing file or nothing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-gate-test-'));
  try {
    const pnpm = join(directory, 'pnpm.cjs');
    const npm = join(directory, 'npm-cli.js');
    writeFileSync(pnpm, '');
    writeFileSync(npm, '');
    assert.equal(resolvePnpmEntry({ npm_execpath: pnpm }), pnpm);
    assert.throws(() => resolvePnpmEntry({ npm_execpath: npm }), /pnpm gate/u);
    assert.throws(
      () => resolvePnpmEntry({ npm_execpath: join(directory, 'pnpm-missing.cjs') }),
      /pnpm gate/u,
    );
    assert.throws(() => resolvePnpmEntry({}), /pnpm gate/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the tree fingerprint changes with a tracked edit, a new file and an untracked edit, and returns with them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-gate-test-'));
  const git = (...args) => {
    const result = spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git('init', '-q');
    writeFileSync(join(directory, 'tracked.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const clean = treeFingerprint(directory);
    assert.equal(treeFingerprint(directory), clean);
    writeFileSync(join(directory, 'tracked.txt'), 'two\n');
    const edited = treeFingerprint(directory);
    assert.notEqual(edited, clean);
    writeFileSync(join(directory, 'tracked.txt'), 'one\n');
    assert.equal(treeFingerprint(directory), clean);
    writeFileSync(join(directory, 'new.txt'), 'a\n');
    const added = treeFingerprint(directory);
    assert.notEqual(added, clean);
    writeFileSync(join(directory, 'new.txt'), 'b\n');
    assert.notEqual(treeFingerprint(directory), added);
    rmSync(join(directory, 'new.txt'));
    assert.equal(treeFingerprint(directory), clean);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--only keeps the named steps in their phases and order, and a name that is no step throws', () => {
  const plan = planGate(ciScript);
  const some = selectSteps(plan, ['check-wire-mutations', 'lint-test-isolation', 'coverage']);
  assert.deepEqual(
    some.serial.map((step) => step.name),
    ['lint-test-isolation'],
  );
  assert.deepEqual(
    some.lanes.map((step) => step.name),
    ['check-wire-mutations'],
  );
  assert.deepEqual(
    some.after.map((step) => step.name),
    ['coverage'],
  );
  assert.throws(
    () => selectSteps(plan, ['lint-test-isolation', 'no-such-step']),
    /No step named "no-such-step"/u,
  );
  assert.throws(() => selectSteps(plan, ['']), /No step named/u);
});

test('a step that cannot be started settles once with a failure instead of crashing the gate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-gate-test-'));
  try {
    const entry = join(directory, 'pnpm.cjs');
    writeFileSync(entry, 'process.exit(0);');
    // A directory that does not exist makes the spawn itself fail: `error` and `close` both fire, and the log must close once.
    const result = await spawnStep({ name: 'x', args: [], env: {} }, join(directory, 'x.log'), {
      entry,
      cwd: join(directory, 'does-not-exist'),
      env: { PATH: process.env.PATH },
    });
    assert.notEqual(result.code, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const POSIX = process.platform !== 'win32';

test(
  'a step that runs too long is stopped and its log says so',
  { skip: !POSIX, timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relavium-gate-test-'));
    try {
      const entry = join(directory, 'pnpm.cjs');
      writeFileSync(entry, 'setInterval(() => {}, 1000);');
      const started = Date.now();
      const result = await spawnStep(
        { name: 'slow', args: [], env: {} },
        join(directory, 'slow.log'),
        {
          entry,
          cwd: directory,
          env: { PATH: process.env.PATH },
          timeoutMs: 300,
        },
      );
      assert.notEqual(result.code, 0);
      assert.ok(Date.now() - started < 8000);
      assert.match(
        readFileSync(join(directory, 'slow.log'), 'utf8'),
        /slow ran longer than \d+ s and was stopped/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'stopping the steps stops their whole process group, grandchildren included',
  { skip: !POSIX, timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relavium-gate-test-'));
    const marker = join(directory, 'grandchild.pid');
    try {
      const entry = join(directory, 'pnpm.cjs');
      // The step starts a grandchild that outlives it unless the whole group is signalled, and records its pid.
      writeFileSync(
        entry,
        `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs');
       const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       writeFileSync(${JSON.stringify(marker)}, String(child.pid)); setInterval(() => {}, 1000);`,
      );
      const pending = spawnStep({ name: 'tree', args: [], env: {} }, join(directory, 'tree.log'), {
        entry,
        cwd: directory,
        env: { PATH: process.env.PATH },
      });
      for (let waited = 0; waited < 5000; waited += 25) {
        try {
          readFileSync(marker);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      const grandchild = Number(readFileSync(marker, 'utf8'));
      assert.doesNotThrow(() => process.kill(grandchild, 0));
      terminateAll('SIGTERM');
      const result = await pending;
      assert.notEqual(result.code, 0);
      let alive = true;
      for (let waited = 0; waited < 3000 && alive; waited += 25) {
        try {
          process.kill(grandchild, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, 'the grandchild survived the stop');
    } finally {
      // Never leave the grandchild behind, whatever failed above.
      try {
        process.kill(Number(readFileSync(marker, 'utf8')), 'SIGKILL');
      } catch {
        // Gone, or never started.
      }
      terminateAll('SIGKILL');
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// A fake `git` is a plain executable file; resolveGit only looks at where it is, so its content does not matter.
const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
function fakeGit(directory) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, gitName);
  writeFileSync(file, '');
  chmodSync(file, 0o755);
  return file;
}

test('git is taken from the PATH, never from inside the repository, a relative entry or a link into it', () => {
  const base = mkdtempSync(join(tmpdir(), 'relavium-gate-test-'));
  try {
    const repository = join(base, 'repository');
    const outside = join(base, 'outside');
    const later = join(base, 'later');
    const inRepository = fakeGit(join(repository, 'node_modules', '.bin'));
    const outsideGit = fakeGit(outside);
    const laterGit = fakeGit(later);
    const path = (...entries) => ({ PATH: entries.join(delimiter) });
    // pnpm puts the repository's `.bin` first: the git beside it is skipped, the first one outside is taken.
    assert.equal(
      resolveGit(path(join(repository, 'node_modules', '.bin'), outside, later), repository),
      outsideGit,
    );
    assert.equal(resolveGit(path(outside, later), repository), outsideGit);
    // An empty or relative entry means the current directory; a directory without a git is passed over.
    assert.equal(
      resolveGit(path('', 'node_modules/.bin', '.', join(base, 'none'), later), repository),
      laterGit,
    );
    // A relative entry that really leads to a git is still refused: it means "wherever the gate happens to run".
    const relativeEntry = relative(process.cwd(), join(base, 'relative'));
    fakeGit(join(base, 'relative'));
    if (!isAbsolute(relativeEntry)) {
      assert.equal(resolveGit(path(relativeEntry, later), repository), laterGit);
      assert.throws(
        () => resolveGit(path(relativeEntry), repository),
        /not found on the PATH outside/u,
      );
    }
    // Only the repository's own binaries, or nothing at all: refused, not run.
    assert.throws(
      () => resolveGit(path(join(repository, 'node_modules', '.bin')), repository),
      /not found on the PATH outside/u,
    );
    assert.throws(
      () => resolveGit(path('', 'relative'), repository),
      /not found on the PATH outside/u,
    );
    assert.throws(() => resolveGit({}, repository), /not found on the PATH outside/u);
    assert.ok(inRepository);
    if (process.platform !== 'win32') {
      // A directory outside the repository whose `git` is a link into it is the repository's binary.
      const linked = join(base, 'linked');
      mkdirSync(linked);
      symlinkSync(inRepository, join(linked, gitName));
      assert.equal(resolveGit(path(linked, later), repository), laterGit);
      assert.throws(() => resolveGit(path(linked), repository), /not found on the PATH outside/u);
      // A `git` that is not executable, or is a directory, is not a program.
      const plain = join(base, 'plain');
      mkdirSync(plain);
      writeFileSync(join(plain, gitName), '');
      chmodSync(join(plain, gitName), 0o644);
      const folder = join(base, 'folder');
      mkdirSync(join(folder, gitName), { recursive: true });
      assert.equal(resolveGit(path(plain, folder, later), repository), laterGit);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the tree fingerprint runs the git resolveGit found, and refuses when there is none', () => {
  const base = mkdtempSync(join(tmpdir(), 'relavium-gate-test-'));
  const saved = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.throws(() => treeFingerprint(base), /not found on the PATH outside/u);
    if (process.platform !== 'win32') {
      // A stand-in git on the PATH records how it was called and answers every question with nothing.
      const bin = join(base, 'bin');
      mkdirSync(bin);
      const record = join(base, 'calls.txt');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${record}'\n`);
      chmodSync(join(bin, 'git'), 0o755);
      process.env.PATH = bin;
      assert.match(treeFingerprint(base), /^[0-9a-f]{16}$/u);
      const calls = readFileSync(record, 'utf8').trim().split('\n');
      assert.deepEqual(calls.slice(0, 4), [
        'rev-parse HEAD',
        'status --porcelain=v1 -z',
        'diff --binary',
        'diff --cached --binary',
      ]);
    }
  } finally {
    process.env.PATH = saved;
    rmSync(base, { recursive: true, force: true });
  }
});

test('the tree fingerprint refuses to answer when git cannot, instead of returning one constant', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relavium-gate-test-'));
  try {
    assert.throws(() => treeFingerprint(directory), /cannot be fingerprinted/u);
    assert.throws(() => treeFingerprint(join(directory, 'missing')), /cannot be fingerprinted/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * The whole command, run for real in a throwaway repository: the real script is copied to `<root>/tools/ci/`, so its root is
 * the throwaway, and pnpm is a stand-in entry point that exits 3 for a step named `fail`, writes a file into the tree for
 * `touch`, and succeeds for anything else.
 */
function runCommand(ciScript, args) {
  const base = mkdtempSync(join(tmpdir(), 'relavium-gate-main-'));
  try {
    const root = join(base, 'repo');
    mkdirSync(join(root, 'tools', 'ci'), { recursive: true });
    copyFileSync(
      new URL('./local-gate.mjs', import.meta.url),
      join(root, 'tools', 'ci', 'local-gate.mjs'),
    );
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { ci: ciScript } }));
    const git = (...gitArgs) =>
      spawnSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...gitArgs,
        ],
        { cwd: root },
      );
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const entry = join(base, 'pnpm.cjs');
    writeFileSync(
      entry,
      `const [name] = process.argv.slice(2);
       if (name === 'fail') { console.log('line one\\nthe reason it failed'); process.exit(3); }
       if (name === 'touch') require('node:fs').writeFileSync('changed-during-the-gate.txt', 'x');`,
    );
    const outDir = join(base, 'logs');
    const result = spawnSync(
      process.execPath,
      [join(root, 'tools', 'ci', 'local-gate.mjs'), '--out', outDir, ...args(root)],
      {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, npm_execpath: entry },
        timeout: 60_000,
      },
    );
    return { ...result, outDir };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('the command passes when every step passes, and says it was the whole gate', () => {
  const result = runCommand('pnpm one && pnpm two', () => []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /✓ the local gate passed/u);
  assert.match(result.stdout, /✓ one /u);
  assert.match(result.stdout, /✓ coverage /u);
});

test('a partial run (--only) says it was not the whole gate', () => {
  const result = runCommand('pnpm one && pnpm two', () => ['--only', 'one']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /partial gate, not the whole gate/u);
  assert.doesNotMatch(result.stdout, /✓ the local gate passed/u);
});

test('a failing step fails the command, prints the end of its log and leaves the later steps unrun', () => {
  const result = runCommand('pnpm one && pnpm fail && pnpm three', () => []);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /✗ fail exited 3/u);
  assert.match(result.stdout, /the reason it failed/u);
  assert.match(result.stdout, /· three did not run/u);
  assert.match(result.stdout, /✗ the local gate failed/u);
});

test('a change to the tree while the gate runs fails it with exit code 2', () => {
  const result = runCommand('pnpm one && pnpm touch', () => []);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /working tree changed while the gate ran/u);
});

test('logs inside the repository, and unknown arguments, are refused before anything runs', () => {
  const inside = runCommand('pnpm one', (root) => ['--out', join(root, 'logs')]);
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /outside the repository/u);
  const unknown = runCommand('pnpm one', () => ['--fast']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown argument "--fast"/u);
  const timeout = runCommand('pnpm one', () => ['--step-timeout', '0']);
  assert.equal(timeout.status, 1);
  assert.match(timeout.stderr, /positive number of minutes/u);
});

test('the load is logged while the lanes run, so a machine stall can be told from a defect', async () => {
  const plan = { serial: [], lanes: [stepNamed('l1')], after: [], skipped: [] };
  const lines = [];
  await runGate(plan, {
    outDir: '/x',
    sampleMs: 20,
    log: (line) => lines.push(line),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return outcome(0);
    },
  });
  assert.ok(
    lines.some((line) => /^· load \d+\.\d$/u.test(line)),
    lines.join(' | '),
  );
});
