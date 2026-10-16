/** Fresh dependency emit, sole CLI prepack, independent seal. Never calls a cached build. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment, runPnpm } from './process.mjs';
import { sealPackage } from './seal.mjs';
import { emitFreshPackage } from './pipeline.mjs';

assert.equal(process.argv.length, 3, 'one empty artifact directory required');
const repository = fileURLToPath(new URL('../../', import.meta.url));
const destination = resolve(process.argv[2]);
mkdirSync(destination, { recursive: true });
assert.deepEqual(readdirSync(destination), [], 'PACKED_CLI_FRESH_DESTINATION_REQUIRED');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-package-build-')));
try {
  const env = isolatedEnvironment(home);
  const version = await runPnpm(['--version'], { cwd: repository, env });
  assert.equal(version.stdout.trim(), '9.12.3', 'PACKED_CLI_PNPM_VERSION');
  const receipt = await emitFreshPackage({
    repository,
    destination,
    env,
    pnpm: runPnpm,
    removeDist: (path) => rmSync(path, { recursive: true, force: true }),
    seal: sealPackage,
  });
  console.log(
    JSON.stringify({
      mode: receipt.mode,
      source: receipt.source,
      sha256: receipt.tarballSha256,
      files: receipt.files.length,
      mapsAndSymbolication: 'not implemented until Wave 3 Step 9',
    }),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}
