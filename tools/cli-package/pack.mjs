/**
 * Command-line entry point of the package producer (`produce.mjs`): one empty artifact directory in,
 * one tarball and its public receipt out. Never builds in the developer's workspace and never calls
 * a cached build. A failure prints only `productionFailure`'s fixed lines, never a child's captured
 * output, which can quote a map.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { producePackage } from './produce.mjs';
import { productionFailure } from './production-failure.mjs';

assert.equal(process.argv.length, 3, 'one empty artifact directory required');
let produced;
try {
  produced = await producePackage({
    repository: fileURLToPath(new URL('../../', import.meta.url)),
    destination: resolve(process.argv[2]),
    environment: process.env,
  });
} catch (error) {
  for (const line of productionFailure(error)) console.error(line);
  process.exit(1);
}
const { receipt, identity } = produced;
console.log(
  JSON.stringify({
    mode: receipt.mode,
    source: receipt.source,
    sha256: receipt.tarballSha256,
    files: receipt.files.length,
    candidateFiles: identity.files,
    privateMaps: 'staged privately, then discarded',
    privateManifest: 'sealed privately, then discarded',
    symbolication: 'actual packed CLI and core frames verified',
  }),
);
