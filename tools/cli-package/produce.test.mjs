import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { assertNoBuildCache } from './candidate.mjs';
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
      pnpm: async (args) => {
        assert.deepEqual(args, ['--version']);
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

test('the producer builds and seals only the owned candidate, never the original checkout', async () => {
  const repository = fresh('original-checkout');
  const destination = join(fresh('artifact-parent'), 'artifact');
  const temporary = fresh('tmp');
  const { seen, ports: fakes } = ports();
  const result = await producePackage({
    repository,
    destination,
    environment: { HOME: '/home/someone' },
    temporary,
    ports: fakes,
  });
  assert.deepEqual(result.identity, { source: SHA, dirty: false, files: 7 });
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
