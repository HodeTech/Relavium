/** Closed native inputs for isolated source controls. No compiler, addon loading or original-code fallback. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readOrdinaryFile } from '../cli-package/files.mjs';
import {
  captureNativeInputs,
  copyNativeAssets,
  inspectNativeAssets,
  nativeSourceBinding,
  sha256,
} from './assets.mjs';
import { NATIVE_DIRECTORY, NATIVE_LIMITS } from './catalog.mjs';

function verify(root, entries) {
  for (const entry of entries) {
    const bytes = readOrdinaryFile(join(root, entry.path), NATIVE_LIMITS.sourceBytes);
    assert.ok(
      bytes.length === entry.bytes && sha256(bytes) === entry.sha256,
      'NATIVE_FS_CAUSAL_INPUT_CHANGED',
    );
  }
}
export function verifyCausalNativeInputs(repository, capture) {
  assert.deepEqual(
    captureNativeInputs(repository),
    capture.original,
    'NATIVE_FS_CAUSAL_SOURCE_CHANGED',
  );
  verify(repository, capture.inputs);
}
export function verifyCausalNativeAssets(candidate, capture) {
  const checked = inspectNativeAssets(join(candidate, 'apps/cli', NATIVE_DIRECTORY), {
    binding: nativeSourceBinding(candidate),
  });
  const inventory = [...checked.files].map(([name, bytes]) => ({
    path: join('apps/cli', NATIVE_DIRECTORY, name).split('\\').join('/'),
    bytes: bytes.length,
    sha256: sha256(bytes),
  }));
  assert.deepEqual(inventory, capture.assets, 'NATIVE_FS_CAUSAL_ASSET_CHANGED');
  verify(candidate, capture.inputs);
}
export function captureCausalNativeAssets(repository, candidate) {
  const original = captureNativeInputs(repository);
  // Already-captured source/helper bytes are compared, never overwritten from a later developer tree.
  for (const entry of original.files) {
    const bytes = readOrdinaryFile(join(repository, entry.path), NATIVE_LIMITS.sourceBytes);
    assert.ok(
      bytes.length === entry.bytes && sha256(bytes) === entry.sha256,
      'NATIVE_FS_CAUSAL_INPUT_CHANGED',
    );
    const target = join(candidate, entry.path);
    if (existsSync(target)) {
      const present = readOrdinaryFile(target, NATIVE_LIMITS.sourceBytes);
      assert.ok(isDeepStrictEqual(present, bytes), 'NATIVE_FS_CAUSAL_CAPTURE_MISMATCH');
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
    }
  }
  const destination = join(candidate, 'apps/cli', NATIVE_DIRECTORY);
  // This validates the artifact against the isolated chosen source before writing its runtime inputs.
  copyNativeAssets({ repository, candidate, destination });
  const checked = inspectNativeAssets(destination, { binding: original.binding });
  const capture = {
    original,
    inputs: original.files,
    assets: [...checked.files].map(([name, bytes]) => ({
      path: join('apps/cli', NATIVE_DIRECTORY, name).split('\\').join('/'),
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  verifyCausalNativeInputs(repository, capture);
  verifyCausalNativeAssets(candidate, capture);
  return capture;
}
