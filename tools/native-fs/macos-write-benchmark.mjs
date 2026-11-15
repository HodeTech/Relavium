/** Contributor-only source-bound APFS benchmark. Run before/after the correction. */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectNativeAssets, nativeSourceBinding } from './assets.mjs';
import { hostTarget, NATIVE_DIRECTORY } from './catalog.mjs';
if (
  process.platform !== 'darwin' ||
  !['baseline', 'corrected'].includes(process.argv[2]) ||
  process.argv.length !== 3
)
  throw new Error('MACOS_BENCHMARK_ARGUMENTS');
const binding = nativeSourceBinding(resolve('.'));
const assets = inspectNativeAssets(resolve('apps/cli', NATIVE_DIRECTORY), { binding });
const target = hostTarget();
if (!assets.manifest.assets.some((asset) => asset.target === target))
  throw new Error('MACOS_BENCHMARK_ASSET');
const require = createRequire(import.meta.url);
const esbuild = require(
  require.resolve('esbuild', { paths: [require.resolve('vitest/package.json')] }),
);
const outfile = resolve(
  `apps/cli/src/engine/tool-host/.adr127-benchmark-${randomBytes(12).toString('hex')}.mjs`,
);
try {
  const result = await esbuild.build({
    entryPoints: ['apps/cli/src/engine/tool-host/macos-write-benchmark.ts'],
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
            if (!sources[args.path]) throw new Error(`unmapped workspace input ${args.path}`);
            return { path: resolve(sources[args.path]) };
          });
        },
      },
    ],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  const inputs = Object.keys(result.metafile.inputs).sort();
  function digest() {
    const hash = createHash('sha256');
    for (const path of [...inputs, 'pnpm-lock.yaml'])
      hash.update(path).update('\0').update(readFileSync(path)).update('\0');
    const currentBinding = nativeSourceBinding(resolve('.'));
    const currentAssets = inspectNativeAssets(resolve('apps/cli', NATIVE_DIRECTORY), {
      binding: currentBinding,
    });
    hash.update(JSON.stringify(currentBinding)).update(JSON.stringify(currentAssets.manifest));
    for (const [name, bytes] of [...currentAssets.files].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ))
      hash.update(name).update('\0').update(bytes).update('\0');
    return hash.update(readFileSync(outfile)).digest('hex');
  }
  const source = digest();
  process.stdout.write(`source-and-bundle-sha256 ${source} (${inputs.length} inputs)\n`);
  const child = spawnSync(process.execPath, [outfile, process.argv[2]], {
    stdio: 'inherit',
    timeout: 240000,
    shell: false,
  });
  if (child.status !== 0 || child.error) throw new Error('host benchmark failed');
  if (digest() !== source) throw new Error('MACOS_BENCHMARK_SOURCE_CHANGED');
} finally {
  rmSync(outfile, { force: true });
}
