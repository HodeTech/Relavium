/** Assemble eight independent native execution outputs, refusing duplicates or source drift. */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectNativeAssets, nativeSourceBinding, writeNativeAssets } from './assets.mjs';
import { validateProfileEvidence } from './profile.mjs';
import { NATIVE_DIRECTORY, NATIVE_TARGETS } from './catalog.mjs';
if (process.argv.length !== 3) throw new Error('NATIVE_FS_ASSEMBLY_ARGUMENTS');
const repository = fileURLToPath(new URL('../..', import.meta.url));
const inputs = resolve(process.argv[2]);
const binding = nativeSourceBinding(repository);
const files = new Map();
const assets = [];
let base;
for (const name of readdirSync(inputs).sort()) {
  const checked = inspectNativeAssets(join(inputs, name), { binding });
  if (checked.manifest.scope !== 'development-current') throw new Error('NATIVE_FS_ASSEMBLY_SCOPE');
  base ??= checked.manifest;
  const asset = checked.manifest.assets[0];
  if (assets.some((present) => present.target === asset.target))
    throw new Error('NATIVE_FS_ASSEMBLY_DUPLICATE');
  validateProfileEvidence(asset.validation, asset.execution.platform, {
    requireDistinctOwner: true,
  });
  assets.push(asset);
  for (const [path, bytes] of checked.files)
    if (path !== 'native-assets.json') files.set(path, bytes);
}
assets.sort((left, right) => (left.target < right.target ? -1 : 1));
if (JSON.stringify(assets.map((asset) => asset.target)) !== JSON.stringify(NATIVE_TARGETS))
  throw new Error('NATIVE_FS_ASSEMBLY_INCOMPLETE');
writeNativeAssets(
  join(repository, 'apps/cli', NATIVE_DIRECTORY),
  { ...base, scope: 'release-complete', assets },
  files,
);
console.log(
  'Native asset assembly verified: eight source-bound native Rust/Node profile receipts; final whole-CLI and security acceptance separate.',
);
