/** Reject a native leg accidentally running/emitting the wrong architecture. */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { inspectNativeAssets, nativeSourceBinding } from './assets.mjs';
import { validateProfileEvidence } from './profile.mjs';
import { NATIVE_DIRECTORY, NATIVE_TARGETS } from './catalog.mjs';
const root = fileURLToPath(new URL('../..', import.meta.url));
const target = process.env.RELAVIUM_EXPECTED_NATIVE_TARGET;
if (!NATIVE_TARGETS.includes(target)) throw new Error('NATIVE_FS_EXPECTED_TARGET');
const checked = inspectNativeAssets(join(root, 'apps/cli', NATIVE_DIRECTORY), {
  binding: nativeSourceBinding(root),
});
if (
  checked.manifest.scope !== 'development-current' ||
  checked.manifest.assets[0].target !== target ||
  checked.manifest.assets[0].execution.node !== 'v22.0.0'
)
  throw new Error('NATIVE_FS_EXECUTED_TARGET');
const { libc, libcVersion } = checked.manifest.assets[0].execution;
if ((libc === 'gnu' && libcVersion !== '2.28') || (libc === 'musl' && libcVersion !== '1.2.5'))
  throw new Error('NATIVE_FS_EXECUTED_BASELINE');
validateProfileEvidence(
  checked.manifest.assets[0].validation,
  checked.manifest.assets[0].execution.platform,
);
console.log(
  `Verified ${target}: native Node 22.0.0 protocol, declared Rust profile population and eleven Node lifecycle cases executed; whole-CLI acceptance separate.`,
);
