import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { assertNoBuildCache } from './candidate.mjs';
import { isolatedEnvironment } from './process.mjs';
import { producePackage } from './produce.mjs';
import { productionFailure } from './production-failure.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-produce-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
const posixModes = process.platform !== 'win32';
let count = 0;

function fresh(name) {
  count += 1;
  const path = join(scratch, `${name}-${count}`);
  mkdirSync(path);
  return path;
}

const SHA = 'c'.repeat(40);

/**
 * Fake ports that record what the producer composes. The fake emit writes into the candidate it is
 * given, runs the producer's seal wrapper and can plant a build-cache marker first.
 */
function ports({ plantCache = false, failEmit = false, dirty = false } = {}) {
  const seen = {};
  return {
    seen,
    ports: {
      pnpm: async (args, options) => {
        assert.deepEqual(args, ['--version']);
        seen.pnpm = options;
        return { stdout: '9.12.3\n', stderr: '' };
      },
      excludesFile: async ({ repository, environment }) => {
        seen.excludesRepository = repository;
        seen.excludesEnvironment = environment;
        return '/developer/excludes';
      },
      prepare: async (options) => {
        seen.prepare = options;
        return { source: SHA, dirty, files: 7 };
      },
      emit: async (options) => {
        seen.emit = options;
        seen.stagingMode = statSync(options.staging).mode & 0o777;
        seen.rootMode = statSync(join(options.staging, '..')).mode & 0o777;
        mkdirSync(join(options.repository, 'apps', 'cli', 'dist'), { recursive: true });
        // Build state an engine package could carry; the emit removes it before each compile.
        const core = join(options.repository, 'packages', 'core');
        mkdirSync(join(core, 'dist'), { recursive: true });
        writeFileSync(join(core, 'dist', 'stale.js'), 'stale\n');
        writeFileSync(join(core, 'tsconfig.build.tsbuildinfo'), '{}\n');
        await options.removeBuildState(core);
        seen.buildStateLeft = ['dist', 'tsconfig.build.tsbuildinfo'].filter((name) =>
          existsSync(join(core, name)),
        );
        if (plantCache) writeFileSync(join(options.repository, '.turbo'), 'cache\n');
        if (failEmit) throw new Error('synthetic emit failure');
        writeFileSync(join(options.destination, 'relavium-0.1.1.tgz'), 'tarball');
        return options.seal(options.destination);
      },
      noBuildCache: (candidate) => {
        seen.noBuildCache = candidate;
        assertNoBuildCache(candidate);
      },
      seal: async (artifactDirectory, candidate) => {
        seen.seal = { artifactDirectory, ...candidate };
        return { mode: 'compiled_package_test', source: candidate.source, files: [] };
      },
    },
  };
}

function leftovers(temporary) {
  return readdirSync(temporary).filter((name) => name.startsWith('relavium-package-'));
}

const INTERRUPTS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const listeners = () => INTERRUPTS.map((signal) => process.listenerCount(signal));

/** Credentials, a preload and a registry in the caller's own environment, which no build may see. */
const PLANTED = Object.freeze({
  NPM_TOKEN: 'planted-npm-token',
  NODE_OPTIONS: '--require=/planted/preload.cjs',
  npm_config_registry: 'https://registry.planted.invalid/',
});

test('the producer builds and seals only the owned candidate, never the original checkout', async (t) => {
  const repository = fresh('original-checkout');
  const destination = join(fresh('artifact-parent'), 'artifact');
  const temporary = fresh('tmp');
  const { seen, ports: fakes } = ports();
  const before = listeners();
  const saved = Object.fromEntries(Object.keys(PLANTED).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, PLANTED);
  const environment = { HOME: '/home/someone', NPM_TOKEN: 'environment-npm-token' };
  const result = await producePackage({
    repository,
    destination,
    environment,
    temporary,
    ports: fakes,
  });
  // The developer's global excludes and dependency store are looked up in the caller's own
  // environment, never in the isolated build environment.
  assert.equal(seen.excludesEnvironment, environment);
  assert.equal(seen.prepare.environment, environment);
  assert.deepEqual(result.identity, { source: SHA, dirty: false, files: 7 });
  // The whole build — pnpm, the candidate's preparation and the emit with its pack — runs in the
  // isolated environment of the private build home, never with the caller's own variables.
  const home = seen.prepare.home;
  assert.equal(dirname(home), temporary);
  assert.match(basename(home), /^relavium-package-build-/u);
  assert.deepEqual(seen.prepare.env, isolatedEnvironment(home));
  assert.deepEqual(seen.emit.env, seen.prepare.env);
  assert.deepEqual(seen.pnpm.env, seen.prepare.env);
  for (const key of Object.keys(PLANTED)) assert.equal(key in seen.prepare.env, false);
  const candidate = seen.prepare.candidate;
  // The candidate and its staging are siblings in one private root outside the checkout and the artifact.
  assert.notEqual(candidate, repository);
  assert.equal(seen.prepare.repository, repository);
  assert.equal(seen.prepare.excludes, '/developer/excludes');
  assert.equal(seen.excludesRepository, repository);
  assert.equal(seen.emit.repository, candidate);
  assert.equal(seen.emit.destination, destination);
  assert.equal(seen.emit.staging, join(candidate, '..', 'staging'));
  assert.equal(seen.noBuildCache, candidate);
  assert.deepEqual(seen.buildStateLeft, []);
  assert.deepEqual(seen.seal, {
    artifactDirectory: destination,
    repository: candidate,
    staging: seen.emit.staging,
    source: SHA,
    dirty: false,
  });
  if (posixModes) {
    assert.equal(seen.stagingMode, 0o700);
    assert.equal(seen.rootMode, 0o700);
  }
  // The private root and the build home are gone, and only the tarball remains in the artifact.
  assert.deepEqual(leftovers(temporary), []);
  // The interrupt handlers are gone too.
  assert.deepEqual(listeners(), before);
  assert.equal(existsSync(candidate), false);
  assert.deepEqual(readdirSync(destination), ['relavium-0.1.1.tgz']);
});

test('another pnpm than the pinned one refuses before anything is prepared', async () => {
  const temporary = fresh('tmp');
  const { seen, ports: fakes } = ports();
  fakes.pnpm = async () => ({ stdout: '9.12.4\n', stderr: '' });
  await assert.rejects(
    producePackage({
      repository: fresh('original-checkout'),
      destination: join(fresh('artifact-parent'), 'artifact'),
      environment: {},
      temporary,
      ports: fakes,
    }),
    /PACKED_CLI_PNPM_VERSION/u,
  );
  assert.equal(seen.prepare, undefined);
  assert.deepEqual(leftovers(temporary), []);
});

test(
  'the private root and staging are exactly 0700 under a umask without the owner write bit',
  { skip: !posixModes },
  async () => {
    const seen = {};
    // The test's own directories exist before the umask applies.
    const repository = fresh('original-checkout');
    const destination = join(fresh('artifact-parent'), 'artifact');
    const temporary = fresh('tmp');
    const previous = process.umask(0o277);
    try {
      await producePackage({
        repository,
        destination,
        environment: {},
        temporary,
        ports: {
          pnpm: async () => ({ stdout: '9.12.3\n', stderr: '' }),
          excludesFile: async () => undefined,
          prepare: async () => ({ source: SHA, dirty: false, files: 1 }),
          emit: async ({ staging, destination, seal }) => {
            seen.staging = statSync(staging).mode & 0o777;
            seen.root = statSync(join(staging, '..')).mode & 0o777;
            return seal(destination);
          },
          noBuildCache: () => {},
          seal: () => ({ mode: 'compiled_package_test' }),
        },
      });
    } finally {
      process.umask(previous);
    }
    assert.deepEqual(seen, { staging: 0o700, root: 0o700 });
    assert.deepEqual(leftovers(temporary), []);
  },
);

test('a dirty source identity reaches the seal and the returned identity', async () => {
  const { seen, ports: fakes } = ports({ dirty: true });
  const result = await producePackage({
    repository: fresh('original-checkout'),
    destination: join(fresh('artifact-parent'), 'artifact'),
    environment: {},
    temporary: fresh('tmp'),
    ports: fakes,
  });
  assert.equal(seen.seal.dirty, true);
  assert.equal(result.identity.dirty, true);
});

test('a build cache left in the candidate refuses before the seal, and nothing private remains', async () => {
  const temporary = fresh('tmp');
  const { seen, ports: fakes } = ports({ plantCache: true });
  await assert.rejects(
    producePackage({
      repository: fresh('original-checkout'),
      destination: join(fresh('artifact-parent'), 'artifact'),
      environment: {},
      temporary,
      ports: fakes,
    }),
    /CANDIDATE_BUILD_CACHE/u,
  );
  assert.equal(seen.seal, undefined);
  assert.deepEqual(leftovers(temporary), []);
});

test('a failure inside the build still removes the private root', async () => {
  const temporary = fresh('tmp');
  const { ports: fakes } = ports({ failEmit: true });
  const before = listeners();
  await assert.rejects(
    producePackage({
      repository: fresh('original-checkout'),
      destination: join(fresh('artifact-parent'), 'artifact'),
      environment: {},
      temporary,
      ports: fakes,
    }),
    /synthetic emit failure/u,
  );
  assert.deepEqual(leftovers(temporary), []);
  assert.deepEqual(listeners(), before);
});

test('private staging never shares a path with the checkout or the artifact', async () => {
  // A temporary directory inside the original checkout would put the private root there.
  const repository = fresh('original-checkout');
  const inside = join(repository, 'tmp');
  mkdirSync(inside);
  const { seen, ports: fakes } = ports();
  await assert.rejects(
    producePackage({
      repository,
      destination: join(fresh('artifact-parent'), 'artifact'),
      environment: {},
      temporary: inside,
      ports: fakes,
    }),
    /PRIVATE_STAGING_PLACEMENT/u,
  );
  assert.equal(seen.prepare, undefined);
  assert.deepEqual(leftovers(inside), []);
  // A directory whose name merely starts with two dots is inside the checkout too.
  const dotted = join(repository, '..tmp');
  mkdirSync(dotted);
  await assert.rejects(
    producePackage({
      repository,
      destination: join(fresh('artifact-parent'), 'artifact'),
      environment: {},
      temporary: dotted,
      ports: ports().ports,
    }),
    /PRIVATE_STAGING_PLACEMENT/u,
  );
  assert.deepEqual(leftovers(dotted), []);
  // On a case-insensitive filesystem, another letter case of the checkout is the checkout.
  const variant = join(dirname(repository), basename(repository).toUpperCase());
  if (existsSync(variant)) {
    await assert.rejects(
      producePackage({
        repository,
        destination: join(fresh('artifact-parent'), 'artifact'),
        environment: {},
        temporary: join(variant, 'tmp'),
        ports: ports().ports,
      }),
      /PRIVATE_STAGING_PLACEMENT/u,
    );
    assert.deepEqual(leftovers(inside), []);
    // The same holds when the checkout itself is named in another letter case.
    const { seen: cased, ports: casedFakes } = ports();
    await assert.rejects(
      producePackage({
        repository: variant,
        destination: join(fresh('artifact-parent'), 'artifact'),
        environment: {},
        temporary: inside,
        ports: casedFakes,
      }),
      /PRIVATE_STAGING_PLACEMENT/u,
    );
    assert.equal(cased.prepare, undefined);
    assert.deepEqual(leftovers(inside), []);
  }
  // So would a temporary directory inside the artifact directory.
  const artifact = join(fresh('artifact-parent'), 'artifact');
  mkdirSync(artifact);
  const { seen: inArtifact, ports: artifactFakes } = ports();
  await assert.rejects(
    producePackage({
      repository,
      destination: artifact,
      environment: {},
      temporary: artifact,
      ports: artifactFakes,
    }),
    /PRIVATE_STAGING_PLACEMENT/u,
  );
  assert.equal(inArtifact.prepare, undefined);
  assert.deepEqual(readdirSync(artifact), []);
  // A non-empty artifact directory refuses before anything private exists.
  const temporary = fresh('tmp');
  const destination = fresh('artifact');
  writeFileSync(join(destination, 'stale.tgz'), 'old');
  await assert.rejects(
    producePackage({ repository, destination, environment: {}, temporary, ports: fakes }),
    /FRESH_DESTINATION_REQUIRED/u,
  );
  assert.deepEqual(leftovers(temporary), []);
});

/** A producer run whose build is a long-lived child, as `pnpm pack` is, behind fake ports. */
function interruptedProducer(temporary, destination, pidFile, grandchildFile) {
  const url = (name) => JSON.stringify(new URL(name, import.meta.url).href);
  const script = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { producePackage } from ${url('./produce.mjs')};
import { isolatedEnvironment, runCommand } from ${url('./process.mjs')};
await producePackage({
  repository: ${JSON.stringify(join(temporary, 'checkout'))},
  destination: ${JSON.stringify(destination)},
  environment: {},
  temporary: ${JSON.stringify(temporary)},
  ports: {
    pnpm: async () => ({ stdout: '9.12.3\\n', stderr: '' }),
    excludesFile: async () => undefined,
    prepare: async () => ({ source: '${SHA}', dirty: false, files: 1 }),
    emit: async ({ staging, destination }) => {
      writeFileSync(join(staging, 'index.js.map'), 'private map');
      writeFileSync(join(destination, 'relavium-0.1.1.tgz'), 'unsealed');
      await runCommand(process.execPath, ['-e', ${JSON.stringify(
        `const { spawn } = require('node:child_process');` +
          `const { writeFileSync } = require('node:fs');` +
          // A grandchild in the same process group, as tsup is under pnpm pack and prepack.
          `spawn(process.execPath, ['-e', ${JSON.stringify(
            `require('node:fs').writeFileSync(${JSON.stringify(grandchildFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
          )}], { stdio: 'ignore' });` +
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
          `setInterval(() => {}, 1000);`,
      )}], { env: isolatedEnvironment(${JSON.stringify(temporary)}), timeoutMs: 60_000 });
    },
  },
});
`;
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  test(
    `an interrupted producer (${signal}) stops its build and removes everything private`,
    { skip: !posixModes },
    async () => {
      const temporary = fresh('tmp');
      mkdirSync(join(temporary, 'checkout'));
      const destination = join(fresh('artifact-parent'), 'artifact');
      const pids = fresh('pid');
      const pidFile = join(pids, 'sleeper.pid');
      const grandchildFile = join(pids, 'grandchild.pid');
      const child = interruptedProducer(temporary, destination, pidFile, grandchildFile);
      const tree = [];
      try {
        for (const file of [pidFile, grandchildFile]) {
          for (
            let waited = 0;
            !existsSync(file) || readFileSync(file, 'utf8') === '';
            waited += 25
          ) {
            assert.ok(waited < 20_000, 'the fake build never started');
            await delay(25);
          }
          tree.push(Number(readFileSync(file, 'utf8')));
        }
        assert.ok(tree.every(alive));
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill(signal);
        assert.equal(await exited, code);
        // The whole build tree is stopped, not only the process the producer started.
        for (let waited = 0; tree.some(alive); waited += 25) {
          assert.ok(waited < 5_000, 'part of the build tree outlived the interrupt');
          await delay(25);
        }
        assert.deepEqual(leftovers(temporary), []);
        assert.deepEqual(readdirSync(destination), []);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        for (const pid of tree) if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    },
  );
}

test('a failed removal still removes the other private directory and rethrows', async () => {
  const temporary = fresh('tmp');
  const { ports: fakes } = ports();
  const refusal = Object.assign(new Error('EACCES: synthetic refusal'), { code: 'EACCES' });
  fakes.remove = (path) => {
    if (path.includes('relavium-package-candidate-')) throw refusal;
    rmSync(path, { recursive: true, force: true });
  };
  const before = listeners();
  await assert.rejects(
    producePackage({
      repository: fresh('original-checkout'),
      destination: join(fresh('artifact-parent'), 'artifact'),
      environment: {},
      temporary,
      ports: fakes,
    }),
    (error) => error === refusal,
  );
  // The build home is gone although the private root's removal failed first.
  assert.deepEqual(
    leftovers(temporary).map((name) => name.replace(/-[^-]+$/u, '')),
    ['relavium-package-candidate'],
  );
  assert.deepEqual(listeners(), before);
});

test(
  'a failed removal during an interrupt leaves one fixed line and still exits with the signal',
  { skip: !posixModes },
  async () => {
    const temporary = fresh('tmp');
    mkdirSync(join(temporary, 'checkout'));
    const destination = join(fresh('artifact-parent'), 'artifact');
    const pidFile = join(fresh('pid'), 'build.pid');
    const url = (name) => JSON.stringify(new URL(name, import.meta.url).href);
    const script = `
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { producePackage } from ${url('./produce.mjs')};
import { isolatedEnvironment, runCommand } from ${url('./process.mjs')};
await producePackage({
  repository: ${JSON.stringify(join(temporary, 'checkout'))},
  destination: ${JSON.stringify(destination)},
  environment: {},
  temporary: ${JSON.stringify(temporary)},
  ports: {
    pnpm: async () => ({ stdout: '9.12.3\\n', stderr: '' }),
    excludesFile: async () => undefined,
    prepare: async () => ({ source: '${SHA}', dirty: false, files: 1 }),
    emit: async ({ destination }) => {
      writeFileSync(join(destination, 'relavium-0.1.1.tgz'), 'unsealed');
      await runCommand(process.execPath, ['-e', ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      )}], { env: isolatedEnvironment(${JSON.stringify(temporary)}), timeoutMs: 60_000 });
    },
    remove: (path) => {
      if (path.includes('relavium-package-candidate-'))
        throw Object.assign(new Error('EACCES: permission denied, unlink ' + JSON.stringify(path)), { code: 'EACCES' });
      rmSync(path, { recursive: true, force: true });
    },
  },
});
`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    let build;
    try {
      for (
        let waited = 0;
        !existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '';
        waited += 25
      ) {
        assert.ok(waited < 20_000, 'the fake build never started');
        await delay(25);
      }
      build = Number(readFileSync(pidFile, 'utf8'));
      const exited = new Promise((resolve) =>
        child.once('exit', (code, signal) => resolve([code, signal])),
      );
      child.kill('SIGINT');
      assert.deepEqual(await exited, [130, null]);
      assert.equal(stderr, '✗ CLI package production interrupted: CLEANUP_FAILED\n');
      assert.equal(alive(build), false);
      // The other steps still ran: the build home is gone and the artifact directory is empty.
      assert.deepEqual(
        leftovers(temporary).map((name) => name.replace(/-[^-]+$/u, '')),
        ['relavium-package-candidate'],
      );
      assert.deepEqual(readdirSync(destination), []);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (build !== undefined && alive(build)) process.kill(build, 'SIGKILL');
    }
  },
);

/**
 * A producer whose interrupt arrives after its build's last child exited: during the seal or during
 * the private root's removal, both synchronous. The fake emit's last await completes from an I/O
 * callback, as pnpm pack's exit does, so the producer's tail runs inside the event loop's poll phase.
 */
function lateInterrupt(temporary, destination, during) {
  const url = (name) => JSON.stringify(new URL(name, import.meta.url).href);
  const script = `
import { readFile } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { producePackage } from ${url('./produce.mjs')};
const interrupt = () => {
  process.kill(process.pid, 'SIGINT');
  // The rest of the synchronous work, during which the signal is only caught.
  for (const until = Date.now() + 50; Date.now() < until; );
};
await producePackage({
  repository: ${JSON.stringify(join(temporary, 'checkout'))},
  destination: ${JSON.stringify(destination)},
  environment: {},
  temporary: ${JSON.stringify(temporary)},
  ports: {
    pnpm: async () => ({ stdout: '9.12.3\\n', stderr: '' }),
    excludesFile: async () => undefined,
    prepare: async () => ({ source: '${SHA}', dirty: false, files: 1 }),
    emit: async ({ staging, destination, seal }) => {
      writeFileSync(join(staging, 'index.js.map'), 'private map');
      writeFileSync(join(destination, 'relavium-0.1.1.tgz'), 'tarball');
      await readFile(join(staging, 'index.js.map'));
      return seal(destination);
    },
    noBuildCache: () => {},
    seal: () => {
      if (${JSON.stringify(during)} === 'seal') interrupt();
      return { mode: 'compiled_package_test' };
    },
    remove: (path) => {
      if (${JSON.stringify(during)} === 'removal' && path.includes('relavium-package-candidate-'))
        interrupt();
      rmSync(path, { recursive: true, force: true });
    },
  },
});
console.log('produced');
`;
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

for (const during of ['seal', 'removal'])
  test(
    `an interrupt during the ${during}, after the last child exited, still ends the producer`,
    { skip: !posixModes },
    async () => {
      const temporary = fresh('tmp');
      mkdirSync(join(temporary, 'checkout'));
      const destination = join(fresh('artifact-parent'), 'artifact');
      const child = lateInterrupt(temporary, destination, during);
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      const [code, signal] = await new Promise((resolve) =>
        child.once('exit', (exitCode, signalCode) => resolve([exitCode, signalCode])),
      );
      // Honoured once the synchronous work is done: the removal completes, the artifact is emptied
      // and the producer exits with the signal's code instead of reporting success.
      assert.equal(signal, null);
      assert.equal(code, 130);
      assert.equal(stdout, '');
      assert.deepEqual(leftovers(temporary), []);
      assert.deepEqual(readdirSync(destination), []);
    },
  );

/** Output a failed build child could carry: a pnpm lifecycle header and esbuild quoting a map. */
const QUOTED_MAP = 'zzMAPMARKERzz';
const REFUSAL =
  '✗ CLI candidate finalization refused: UPSTREAM_MAP_SHAPE (packages/core/dist/index.js.map)';
function failedChild() {
  const error = new Error('PACKED_CLI_CHILD_FAILED: 1');
  error.result = {
    stdout: `> relavium@0.1.1 prepack /private/candidate/apps/cli\n1 │ {"names":["${QUOTED_MAP}"],"mappings":"AAAA;!!"}\n`,
    stderr: `${REFUSAL}\n✗ CLI ${QUOTED_MAP} │ {"names":[]}\n${QUOTED_MAP}\n`,
  };
  return error;
}

test('a failed production prints only prepack diagnostics and a fixed code, never child output', () => {
  assert.deepEqual(productionFailure(failedChild()), [
    REFUSAL,
    '✗ CLI package production failed: PACKED_CLI_CHILD_FAILED',
  ]);
  // A system error gives its code, never its message with a host path; anything else is unexpected.
  const missing = Object.assign(new Error("ENOENT: no such file, open '/private/x'"), {
    code: 'ENOENT',
  });
  assert.deepEqual(productionFailure(missing), ['✗ CLI package production failed: ENOENT']);
  for (const other of [new Error('a message with /private/paths'), 'thrown text', undefined])
    assert.deepEqual(productionFailure(other), ['✗ CLI package production failed: UNEXPECTED']);
});

test('the producer entry point prints only the fixed failure lines and exits 1', () => {
  // The real entry point and failure report, with a producer stand-in that fails as a build child.
  const directory = fresh('entry');
  for (const name of ['pack.mjs', 'production-failure.mjs'])
    writeFileSync(join(directory, name), readFileSync(new URL(name, import.meta.url)));
  writeFileSync(
    join(directory, 'produce.mjs'),
    `export async function producePackage() {\n` +
      `  const error = new Error('PACKED_CLI_CHILD_FAILED: 1');\n` +
      `  error.result = ${JSON.stringify(failedChild().result)};\n` +
      `  throw error;\n}\n`,
  );
  const result = spawnSync(
    process.execPath,
    [join(directory, 'pack.mjs'), join(directory, 'out')],
    {
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `${REFUSAL}\n✗ CLI package production failed: PACKED_CLI_CHILD_FAILED\n`,
  );
  assert.equal(result.stderr.includes(QUOTED_MAP), false);
});
