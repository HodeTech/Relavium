import assert from 'node:assert/strict';
import { join } from 'node:path';

/** One ordered emitter; ports are tooling boundaries, never shipped product hooks. */
export async function emitFreshPackage({ repository, destination, env, pnpm, removeDist, seal }) {
  for (const name of ['shared', 'llm', 'core', 'db', 'mcp']) {
    const cwd = join(repository, 'packages', name);
    await removeDist(join(cwd, 'dist'));
    await pnpm(['exec', 'tsc', '-p', 'tsconfig.build.json', '--incremental', 'false'], {
      cwd,
      env,
    });
  }
  const packed = await pnpm(['pack', '--pack-destination', destination], {
    cwd: join(repository, 'apps/cli'),
    env,
  });
  // Independently observe the installed packer's sole prepack build, rather than merely counting API calls.
  assert.equal(
    (packed.stdout.match(/\bESM Build start\b/gu) ?? []).length,
    1,
    'PACKED_CLI_SOLE_PREPACK_BUILD_REQUIRED',
  );
  return seal(destination);
}
