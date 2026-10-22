import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
function ports({ plantCache = false, failEmit = false } = {}) {
  const seen = {};
  return {
    seen,
    ports: {
      pnpm: async (args, options) => {
        assert.deepEqual(args, ['--version']);
        seen.pnpm = options;
        return { stdout: '9.12.3\n', stderr: '' };
      },
      excludesFile: async ({ repository }) => {
        seen.excludesRepository = repository;
        return '/developer/excludes';
      },
      prepare: async (options) => {
        seen.prepare = options;
        return { source: SHA, dirty: false, files: 7 };
      },
      emit: async (options) => {
        seen.emit = options;
        seen.stagingMode = statSync(options.staging).mode & 0o777;
        seen.rootMode = statSync(join(options.staging, '..')).mode & 0o777;
        mkdirSync(join(options.repository, 'apps', 'cli', 'dist'), { recursive: true });
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
  const result = await producePackage({
    repository,
    destination,
    environment: { HOME: '/home/someone', NPM_TOKEN: 'environment-npm-token' },
    temporary,
    ports: fakes,
  });
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
