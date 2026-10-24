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
 * checkout. That root and the build home are removed whether production succeeds or fails — the
 * staging directory, which holds the private maps, first — each removal attempted even when another
 * fails. A failed production keeps its own error, also empties the artifact directory, which was empty
 * at the start, and reports a failed removal only as one fixed line. An interrupt (SIGINT, SIGTERM,
 * SIGHUP) stops the build's child trees, removes the staging directory, empties the artifact directory
 * and only then removes the candidate tree and the build home, before the process exits with the
 * signal's code — also when it arrives after the last child exited, during the seal or during the
 * final removal (`exitOnInterrupt`). A step of that cleanup that fails leaves one fixed line, never a
 * path, and the exit code stays the signal's.
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
  /** Remove each of `paths`, attempting every one; the first failure, if any. */
  const removeAll = (paths) => {
    let failure;
    for (const path of paths) {
      try {
        remove(path);
      } catch (error) {
        failure ??= error;
      }
    }
    return failure;
  };
  const staging = () => (root === undefined ? [] : [join(root, 'staging')]);
  const rest = () => (root === undefined ? [home] : [root, home]);
  /** Empty the artifact directory, which was empty at the start; the first failure, if any. */
  const emptyArtifact = () => {
    let names;
    try {
      names = readdirSync(destination);
    } catch (error) {
      return error;
    }
    return removeAll(names.map((name) => join(destination, name)));
  };
  /** One fixed diagnostic line; a failed write cannot replace the outcome it reports. */
  const report = (line) => {
    try {
      writeSync(2, line);
    } catch {
      // Nothing else can carry it.
    }
  };
  // An interrupt's cleanup never throws: a failed step leaves one fixed line, without a path, and
  // the producer still exits with the signal's code. The maps go first, then the artifact directory,
  // then the large candidate tree and the build home.
  const interrupted = () => {
    const failures = [removeAll(staging()), emptyArtifact(), removeAll(rest())];
    if (failures.some((failure) => failure !== undefined))
      report('✗ CLI package production interrupted: CLEANUP_FAILED\n');
  };
  return exitOnInterrupt(interrupted, async () => {
    let failed = false;
    let failure;
    let produced;
    try {
      root = realpathSync.native(mkdtempSync(join(temporary, 'relavium-package-candidate-')));
      chmodSync(root, 0o700);
      const candidate = join(root, 'source');
      const [privateStaging] = staging();
      // The symbolication run's home, project and captured frames: owner-only, outside the candidate.
      const work = join(root, 'symbolication');
      mkdirSync(candidate, { mode: 0o700 });
      for (const directory of [privateStaging, work]) {
        mkdirSync(directory, { mode: 0o700 });
        chmodSync(directory, 0o700);
      }
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
        staging: privateStaging,
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
            staging: privateStaging,
            source: identity.source,
            dirty: identity.dirty,
            checkout: repository,
            work,
          });
        },
      });
      produced = { receipt, identity };
    } catch (error) {
      failed = true;
      failure = error;
    }
    // The interrupt handler is still installed: an interrupt during this removal is honoured once it
    // is done, never in the middle of it.
    const removal = removeAll([...staging(), ...rest()]);
    if (failed) {
      // A failed production leaves no artifact and keeps its own error.
      const emptied = emptyArtifact();
      if (removal !== undefined || emptied !== undefined)
        report('✗ CLI package production cleanup failed: CLEANUP_FAILED\n');
      throw failure;
    }
    if (removal !== undefined) {
      // Without its cleanup the production failed: no artifact remains, and the removal's error is it.
      emptyArtifact();
      throw removal;
    }
    return produced;
  });
}
