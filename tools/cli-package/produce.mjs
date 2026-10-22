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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoBuildCache, globalExcludesFile, prepareCandidate } from './candidate.mjs';
import { within } from './paths.mjs';
import { isolatedEnvironment, runPnpm, stopLiveCommands } from './process.mjs';
import { sealPackage } from './seal.mjs';
import { emitFreshPackage } from './pipeline.mjs';

/** The interrupts after which the producer still removes everything private before it exits. */
const INTERRUPTS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

/**
 * Produce one package-test artifact from the original checkout `repository` into the empty
 * `destination`. The candidate tree and its private staging are siblings in one owner-only temporary
 * root that shares no path with the artifact directory or the checkout. That root and the build home
 * are removed whether production succeeds or fails; an interrupt also stops the build's child trees
 * and empties the artifact directory, which was empty at the start, before the process exits with
 * the signal's code.
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
    remove = (path) => rmSync(path, { recursive: true, force: true }),
  } = ports;
  mkdirSync(destination, { recursive: true });
  assert.deepEqual(readdirSync(destination), [], 'PACKED_CLI_FRESH_DESTINATION_REQUIRED');
  const home = realpathSync.native(mkdtempSync(join(temporary, 'relavium-package-build-')));
  let root;
  const discard = () => {
    if (root !== undefined) remove(root);
    remove(home);
  };
  const interrupt = (signal) => {
    stopLiveCommands();
    discard();
    for (const name of readdirSync(destination)) {
      rmSync(join(destination, name), { recursive: true, force: true });
    }
    process.exit(128 + (constants.signals[signal] ?? 0));
  };
  for (const signal of INTERRUPTS) process.on(signal, interrupt);
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
    // The handlers stay until everything private is gone: a late interrupt waits for the removal
    // instead of ending the process in the middle of it.
    discard();
    for (const signal of INTERRUPTS) process.off(signal, interrupt);
  }
}
