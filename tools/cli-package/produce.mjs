/**
 * The package producer (ADR-0111, Wave 3 Step 9a.1): owned candidate copy, fresh mapped dependency
 * emit, sole CLI prepack with candidate finalization, independent seal. It never builds in the
 * developer's workspace and never calls a cached build. The private maps, metafile and hash record
 * are staged owner-only outside the artifact directory and discarded on every path; only the tarball
 * and its public receipt are published. `pack.mjs` is its command-line entry point; the ports are
 * tooling seams for tests, never shipped product hooks.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { assertNoBuildCache, globalExcludesFile, prepareCandidate } from './candidate.mjs';
import { isolatedEnvironment, runPnpm } from './process.mjs';
import { sealPackage } from './seal.mjs';
import { emitFreshPackage } from './pipeline.mjs';

/** @param {string} parent @param {string} child */
function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * Produce one package-test artifact from the original checkout `repository` into the empty
 * `destination`. The candidate tree and its private staging are siblings in one owner-only temporary
 * root that shares no path with the artifact directory or the checkout, and that root is removed
 * whether production succeeds or fails; no secure erasure is claimed.
 * @param {{repository: string, destination: string, environment: Record<string, string | undefined>,
 *   temporary?: string, ports?: {prepare?: typeof prepareCandidate, emit?: typeof emitFreshPackage,
 *   seal?: typeof sealPackage, noBuildCache?: typeof assertNoBuildCache,
 *   excludesFile?: typeof globalExcludesFile, pnpm?: typeof runPnpm}}} options
 */
export async function producePackage({
  repository,
  destination,
  environment,
  temporary = tmpdir(),
  ports = {},
}) {
  const {
    prepare = prepareCandidate,
    emit = emitFreshPackage,
    seal = sealPackage,
    noBuildCache = assertNoBuildCache,
    excludesFile = globalExcludesFile,
    pnpm = runPnpm,
  } = ports;
  mkdirSync(destination, { recursive: true });
  assert.deepEqual(readdirSync(destination), [], 'PACKED_CLI_FRESH_DESTINATION_REQUIRED');
  const home = realpathSync(mkdtempSync(join(temporary, 'relavium-package-build-')));
  let root;
  try {
    root = realpathSync(mkdtempSync(join(temporary, 'relavium-package-candidate-')));
    chmodSync(root, 0o700);
    const candidate = join(root, 'source');
    const staging = join(root, 'staging');
    mkdirSync(candidate, { mode: 0o700 });
    mkdirSync(staging, { mode: 0o700 });
    chmodSync(staging, 0o700);
    const published = realpathSync(destination);
    assert.ok(
      !within(root, published) && !within(published, root) && !within(repository, root),
      'PACKED_CLI_PRIVATE_STAGING_PLACEMENT',
    );
    const env = isolatedEnvironment(home);
    const version = await pnpm(['--version'], { cwd: repository, env });
    assert.equal(version.stdout.trim(), '9.12.3', 'PACKED_CLI_PNPM_VERSION');

    const excludes = await excludesFile({ repository, environment });
    const identity = await prepare({ repository, candidate, environment, home, env, excludes });
    const receipt = await emit({
      repository: candidate,
      destination,
      staging,
      env,
      pnpm,
      removeBuildState: (cwd) => {
        rmSync(join(cwd, 'dist'), { recursive: true, force: true });
        rmSync(join(cwd, 'tsconfig.build.tsbuildinfo'), { force: true });
      },
      seal: (artifactDirectory) => {
        noBuildCache(candidate);
        return seal(artifactDirectory, {
          repository: candidate,
          staging,
          source: identity.source,
          dirty: identity.dirty,
        });
      },
    });
    return { receipt, identity };
  } finally {
    // Private maps never outlive the producer.
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}
