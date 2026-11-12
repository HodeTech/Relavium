/** Reject a native leg accidentally running/emitting the wrong architecture. */
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { inspectNativeAssets, nativeSourceBinding } from './assets.mjs';
import { validateProfileEvidence } from './profile.mjs';
import { NATIVE_DIRECTORY, NATIVE_TARGETS } from './catalog.mjs';
export function checkNativeTarget(
  repository,
  target,
  directory = join(repository, 'apps/cli', NATIVE_DIRECTORY),
) {
  if (!NATIVE_TARGETS.includes(target)) throw new Error('NATIVE_FS_EXPECTED_TARGET');
  const checked = inspectNativeAssets(directory, { binding: nativeSourceBinding(repository) });
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
    { requireDistinctOwner: true },
  );
  // Test-only environment hooks/checkpoint receipts must never enter the shipped addon.
  const binary = checked.files.get(`${target}.node`);
  if (binary === undefined || binary.includes(Buffer.from('RELAVIUM_NATIVE_')))
    throw new Error('NATIVE_FS_TEST_ONLY_BINARY');
  return checked;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.env.RELAVIUM_EXPECTED_NATIVE_TARGET;
  checkNativeTarget(fileURLToPath(new URL('../..', import.meta.url)), target);
  console.log(
    `Verified ${target}: native Node 22.0.0 protocol, declared Rust profile population and eleven Node lifecycle cases executed; release bytes exclude test markers; whole-CLI acceptance separate.`,
  );
}
