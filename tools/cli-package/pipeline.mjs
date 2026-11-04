import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CANDIDATE_STAGING_ENV, ENGINE_PACKAGES } from './finalize.mjs';

/** The installed compiler's candidate overrides: external upstream maps, no embedded sources or incremental state. */
export const CANDIDATE_TSC_ARGS = Object.freeze([
  'exec',
  'tsc',
  '-p',
  'tsconfig.build.json',
  '--sourceMap',
  'true',
  '--inlineSources',
  'false',
  '--incremental',
  'false',
]);

/**
 * One ordered emitter for an owned candidate tree; ports are tooling boundaries, never shipped
 * product hooks. The inlined dependencies compile fresh with upstream maps, then prepack performs
 * the sole final CLI build and finalizes the candidate into the private `staging` directory.
 */
export async function emitFreshPackage({
  repository,
  destination,
  staging,
  env,
  pnpm,
  removeBuildState,
  seal,
}) {
  for (const name of ENGINE_PACKAGES) {
    const cwd = join(repository, 'packages', name);
    await removeBuildState(cwd);
    await pnpm([...CANDIDATE_TSC_ARGS], { cwd, env });
  }
  const packed = await pnpm(['pack', '--pack-destination', destination], {
    cwd: join(repository, 'apps/cli'),
    env: { ...env, [CANDIDATE_STAGING_ENV]: staging },
  });
  // Independently observe the installed packer's sole prepack build and its one finalization,
  // rather than merely counting API calls.
  assert.equal(
    (packed.stdout.match(/\bESM Build start\b/gu) ?? []).length,
    1,
    'PACKED_CLI_SOLE_PREPACK_BUILD_REQUIRED',
  );
  assert.equal(
    (packed.stdout.match(/^✓ CLI candidate finalized: /gmu) ?? []).length,
    1,
    'PACKED_CLI_CANDIDATE_FINALIZATION_REQUIRED',
  );
  return seal(destination);
}
