/** Bundle the production TypeScript closure afresh, then exercise it in the native image. */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const esbuild = require(
  require.resolve('esbuild', { paths: [require.resolve('vitest/package.json')] }),
);
const tag = process.argv[2];
if (typeof tag !== 'string' || !/^relavium-native-[a-z0-9-]+$/u.test(tag))
  throw new Error('Invalid native image tag');
const outfile = resolve(
  `apps/cli/src/engine/tool-host/.lower-host-${randomBytes(12).toString('hex')}.mjs`,
);
let mayRemoveBundle = true;
let container;
let creationUncertain = false;
let primary;
let primaryFailed = false;
let cleanup;
let cleanupFailed = false;
const docker = (args, timeout = 10000) =>
  spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 16384, shell: false });
const success = (result) => !result.error && result.status === 0;
try {
  const result = await esbuild.build({
    entryPoints: ['apps/cli/src/engine/tool-host/lower-host-fixture.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    metafile: true,
    external: ['../../../native/fs-metadata/runtime/loader.cjs'],
    plugins: [
      {
        name: 'workspace-source',
        setup(build) {
          const sources = {
            '@relavium/core': 'packages/core/src/index.ts',
            '@relavium/core/tool-dispatch-error': 'packages/core/src/tools/dispatch-error.ts',
            '@relavium/shared': 'packages/shared/src/index.ts',
            '@relavium/shared/fs-root-limits': 'packages/shared/src/fs-root-limits.ts',
            '@relavium/shared/relavium-error': 'packages/shared/src/relavium-error.ts',
            '@relavium/shared/terminal-safe': 'packages/shared/src/terminal-safe.ts',
            '@relavium/llm': 'packages/llm/src/index.ts',
            '@relavium/llm/adapters': 'packages/llm/src/adapters/index.ts',
            '@relavium/llm/scrub-secrets': 'packages/llm/src/scrub-secrets.ts',
          };
          build.onResolve({ filter: /^@relavium\// }, (args) => {
            const source = sources[args.path];
            if (source === undefined) throw new Error(`Unmapped workspace input: ${args.path}`);
            return { path: resolve(source) };
          });
        },
      },
    ],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  const inputs = Object.keys(result.metafile.inputs).sort();
  if (
    !inputs.includes('apps/cli/src/engine/tool-host/fs.ts') ||
    !inputs.includes('packages/core/src/tools/registry.ts')
  )
    throw new Error('Missing production host or registry source');
  function digest() {
    const hash = createHash('sha256');
    for (const path of [...inputs, 'pnpm-lock.yaml', 'tools/native-fs/lower-host-run.mjs'])
      hash.update(path).update('\0').update(readFileSync(path)).update('\0');
    hash.update(readFileSync(outfile));
    return hash.digest('hex');
  }
  const binding = digest();
  process.stdout.write(
    `lower host fixture source and bundle SHA256 ${binding} (${inputs.length} inputs)\n`,
  );
  const name = `relavium-lower-host-${randomBytes(12).toString('hex')}`;
  creationUncertain = true;
  const created = docker([
    'create',
    '--name',
    name,
    '--network=none',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--volume',
    `${resolve('.')}:/source:ro`,
    tag,
    'node',
    `/source/${outfile.slice(resolve('.').length + 1)}`,
  ]);
  if (!success(created)) throw new Error('Lower host container create uncertain');
  container = name;
  creationUncertain = false;
  const child = docker(['start', '--attach', name], 120000);
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (!success(child)) throw new Error('Lower host fixture failed');
  if (digest() !== binding) throw new Error('Lower host source or bundle changed during execution');
} catch (error) {
  primary = error;
  primaryFailed = true;
}
try {
  if (container !== undefined) {
    const state = docker(['inspect', '--format', '{{.State.Running}}', container]);
    if (!success(state) || !['true', 'false'].includes(state.stdout.trim()))
      mayRemoveBundle = false;
    else if (state.stdout.trim() === 'true' && !success(docker(['kill', container])))
      mayRemoveBundle = false;
    if (
      mayRemoveBundle &&
      (!success(docker(['wait', container])) || !success(docker(['rm', container])))
    )
      mayRemoveBundle = false;
  }
  if (creationUncertain) mayRemoveBundle = false;
  if (mayRemoveBundle) rmSync(outfile, { force: true });
  else {
    cleanup = new Error(`Lower host container cleanup uncertain; retained bundle ${outfile}`);
    cleanupFailed = true;
  }
} catch (error) {
  cleanup = error;
  cleanupFailed = true;
}
if (primaryFailed && cleanupFailed)
  throw new AggregateError([primary, cleanup], 'Lower host fixture and cleanup failed');
if (primaryFailed) throw primary;
if (cleanupFailed) throw cleanup;
