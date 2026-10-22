/**
 * The package producer (ADR-0111, Wave 3 Step 9a.1): owned candidate copy, fresh mapped dependency
 * emit, sole CLI prepack with candidate finalization, independent seal. It never builds in the
 * developer's workspace and never calls a cached build. The private maps, metafile and hash record
 * are staged owner-only outside the artifact directory and removed when production succeeds, fails or
 * is interrupted (SIGINT, SIGTERM, SIGHUP); a producer killed outright, a crash or a lost host can
 * leave its owner-only root in the temporary directory, and no secure erasure is claimed. Only the
 * tarball and its public receipt are published. `pack.mjs` is its command-line entry point; the ports
 * are tooling seams for tests, never shipped product hooks.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoBuildCache, globalExcludesFile, prepareCandidate } from './candidate.mjs';
import { within } from './paths.mjs';
import { exitOnInterrupt, isolatedEnvironment, runPnpm } from './process.mjs';
import { sealPackage } from './seal.mjs';
import { emitFreshPackage } from './pipeline.mjs';

/**
 * Produce one package-test artifact from the original checkout `repository` into the empty
 * `destination`. The candidate tree and its private staging are siblings in one temporary root,
 * owner-only where POSIX modes are observable, that shares no path with the artifact directory or the
 * checkout. That root and the build home are removed whether production succeeds or fails, each
 * attempted even when the other's removal fails. An interrupt (SIGINT, SIGTERM, SIGHUP) stops the
 * build's child trees, removes both directories and empties the artifact directory, which was empty
 * at the start, before the process exits with the signal's code — also when it arrives after the last
 * child exited, during the seal or during the final removal (`exitOnInterrupt`). A step of that
 * cleanup that fails leaves one fixed line, never a path, and the exit code stays the signal's.
 * @param {{repository: string, destination: string, environment: Record<string, string | undefined>,
 *   temporary?: string, ports?: {prepare?: typeof prepareCandidate, emit?: typeof emitFreshPackage,
 *   seal?: typeof sealPackage, noBuildCache?: typeof assertNoBuildCache,
 *   excludesFile?: typeof globalExcludesFile, pnpm?: typeof runPnpm,
 *   remove?: (path: string) => void}}} options
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
    // Retries absorb a child killed by the interrupt that was still finishing a write.
    remove = (path) => rmSync(path, { recursive: true, force: true, maxRetries: 3 }),
  } = ports;
  mkdirSync(destination, { recursive: true });
  assert.deepEqual(readdirSync(destination), [], 'PACKED_CLI_FRESH_DESTINATION_REQUIRED');
  const home = realpathSync.native(mkdtempSync(join(temporary, 'relavium-package-build-')));
  let root;
  // Every removal is attempted even when an earlier one fails; the first failure is rethrown.
  const discard = () => {
    let failure;
    for (const path of [root, home]) {
      if (path === undefined) continue;
      try {
        remove(path);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  };
  // An interrupt's cleanup never throws: a failed step leaves one fixed line, without a path, and
  // the producer still exits with the signal's code.
  const interrupted = () => {
    let failed = false;
    const attempt = (step) => {
      try {
        step();
      } catch {
        failed = true;
      }
    };
    attempt(discard);
    let names = [];
    attempt(() => {
      names = readdirSync(destination);
    });
    for (const name of names) {
      attempt(() =>
        rmSync(join(destination, name), { recursive: true, force: true, maxRetries: 3 }),
      );
    }
    if (failed)
      attempt(() => writeSync(2, '✗ CLI package production interrupted: CLEANUP_FAILED\n'));
  };
  return exitOnInterrupt(interrupted, async () => {
    try {
      root = realpathSync.native(mkdtempSync(join(temporary, 'relavium-package-candidate-')));
      chmodSync(root, 0o700);
      const candidate = join(root, 'source');
      const staging = join(root, 'staging');
      mkdirSync(candidate, { mode: 0o700 });
      mkdirSync(staging, { mode: 0o700 });
      chmodSync(staging, 0o700);
      // Native real paths carry the letter case the filesystem stores, so no alias passes for elsewhere.
      const published = realpathSync.native(destination);
      const checkout = realpathSync.native(repository);
      assert.ok(
        !within(root, published) && !within(published, root) && !within(checkout, root),
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
      // The interrupt handler is still installed: an interrupt during this removal is honoured once
      // it is done, never in the middle of it.
      discard();
    }
  });
}
