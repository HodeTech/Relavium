/**
 * Command-line entry point of the package producer (`produce.mjs`): one empty artifact directory in,
 * one tarball and its public receipt out. Never builds in the developer's workspace and never calls
 * a cached build.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { producePackage } from './produce.mjs';

assert.equal(process.argv.length, 3, 'one empty artifact directory required');
const { receipt, identity } = await producePackage({
  repository: fileURLToPath(new URL('../../', import.meta.url)),
  destination: resolve(process.argv[2]),
  environment: process.env,
});
console.log(
  JSON.stringify({
    mode: receipt.mode,
    source: receipt.source,
    sha256: receipt.tarballSha256,
    files: receipt.files.length,
    candidateFiles: identity.files,
    privateMaps: 'staged privately, then discarded',
    symbolication: 'not implemented until Wave 3 Step 9a.2',
  }),
);
