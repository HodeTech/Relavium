import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HostDeniedError } from './errors.js';
import { FS_NATIVE_LOADER_SHA256 } from './fs-native-loader-integrity.js';
import { isWithinFsRoot } from './fs-policy.js';

declare const __RELAVIUM_CLI_NATIVE_PACKAGED__: boolean;
const packaged =
  typeof __RELAVIUM_CLI_NATIVE_PACKAGED__ !== 'undefined' && __RELAVIUM_CLI_NATIVE_PACKAGED__;
/** Pure host-derived locations; resolving them never loads the addon or accesses disk. */
const sourceRuntimeRoot = fileURLToPath(
  new URL(
    packaged ? '../native/fs-metadata/runtime/' : '../../../native/fs-metadata/runtime/',
    import.meta.url,
  ),
);
const packagedRuntimeRoot = fileURLToPath(
  new URL(packaged ? './native-fs/' : '../../../dist/native-fs/', import.meta.url),
);
export const nativeMetadataRuntimeRoot = packaged ? packagedRuntimeRoot : sourceRuntimeRoot;
export const nativeMetadataRuntimeRoots: readonly string[] = Object.freeze([
  sourceRuntimeRoot,
  packagedRuntimeRoot,
]);

export interface NativeRuntimeWriteFloor {
  assertPath(path: string): void;
}

/** Capture the generated asset root only for an actual model-selected write. */
export async function captureNativeRuntimeWriteFloor(): Promise<NativeRuntimeWriteFloor> {
  const roots = (
    await Promise.all(
      nativeMetadataRuntimeRoots.map(async (root): Promise<string[]> => {
        const lexical = resolve(root);
        try {
          return [lexical, await realpath(lexical)];
        } catch (error) {
          if (
            !(
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'ENOENT'
            )
          )
            throw new HostDeniedError('filesystem metadata protection is unavailable');
          return [lexical];
        }
      }),
    )
  ).flat();
  return Object.freeze({
    assertPath(path: string): void {
      const target = resolve(path);
      if (roots.some((root) => isWithinFsRoot(root, target)))
        throw new HostDeniedError('filesystem metadata runtime is protected');
    },
  });
}

/** The fixed first-party protocol identifies the loaded native component. */
interface NativeMetadataProtocol {
  protocolVersion(): unknown;
}

function isNativeMetadataProtocol(value: unknown): value is NativeMetadataProtocol {
  return (
    typeof value === 'object' &&
    value !== null &&
    'protocolVersion' in value &&
    typeof value.protocolVersion === 'function'
  );
}

async function verifyLoader(): Promise<void> {
  const path = join(nativeMetadataRuntimeRoot, 'loader.cjs');
  const observed = await lstat(path, { bigint: true });
  if (
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    observed.size < 1n ||
    observed.size > 65536n
  )
    throw new HostDeniedError('filesystem metadata protection is unavailable');
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== observed.dev ||
      before.ino !== observed.ino ||
      before.size !== observed.size ||
      before.mtimeNs !== observed.mtimeNs ||
      before.ctimeNs !== observed.ctimeNs
    )
      throw new HostDeniedError('filesystem metadata protection is unavailable');
    const data = Buffer.alloc(65537);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      BigInt(bytesRead) !== before.size ||
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.size !== before.size ||
      current.mtimeNs !== before.mtimeNs ||
      current.ctimeNs !== before.ctimeNs ||
      createHash('sha256').update(data.subarray(0, bytesRead)).digest('hex') !==
        FS_NATIVE_LOADER_SHA256
    )
      throw new HostDeniedError('filesystem metadata protection is unavailable');
  } finally {
    await file.close();
  }
}

/** Only an admitted prepared-write operation may call this lazy, fixed-asset loader. */
export async function loadNativeMetadataProtocol(): Promise<NativeMetadataProtocol> {
  try {
    await verifyLoader();
    const { loadFsMetadataAddon } = await import('../../../native/fs-metadata/runtime/loader.cjs');
    const addon = loadFsMetadataAddon();
    if (!isNativeMetadataProtocol(addon) || addon.protocolVersion() !== 1) {
      throw new HostDeniedError('filesystem metadata protection is unavailable');
    }
    return addon;
  } catch {
    // Native errors may contain library paths or metadata and never cross the host boundary.
    throw new HostDeniedError('filesystem metadata protection is unavailable');
  }
}

/** Host-private opaque handles; callers own every returned native promise until it settles. */
export interface NativeMetadataWriteAdapter extends NativeMetadataProtocol {
  requiresCreationMaskProbe(): unknown;
  createWriteCancellation(): unknown;
  cancelWrite(cancellation: unknown): void;
  recoverMetadataStaging(home: string, cancellation: unknown): Promise<unknown>;
  prepareExistingMetadata(
    path: string,
    append: boolean,
    mask: number | undefined,
  ): Promise<unknown>;
  existingMetadataIdentity(prepared: unknown): Promise<unknown>;
  releaseExistingMetadata(prepared: unknown): Promise<unknown>;
  prepareNewMetadata(path: string, mask: number | undefined): Promise<unknown>;
  recheckNewMetadata(prepared: unknown, mask: number | undefined): Promise<unknown>;
  releaseNewMetadata(prepared: unknown): Promise<unknown>;
  stageExistingMetadata(
    prepared: unknown,
    home: string,
    before: Buffer,
    after: Buffer,
    nonce: string,
    mask: number | undefined,
    cancellation: unknown,
  ): Promise<unknown>;
  stageNewMetadata(
    prepared: unknown,
    home: string,
    after: Buffer,
    nonce: string,
    mask: number | undefined,
    cancellation: unknown,
  ): Promise<unknown>;
  publishMetadata(
    stage: unknown,
    mask: number | undefined,
    cancellation: unknown,
  ): Promise<unknown>;
  releaseMetadataStage(stage: unknown): Promise<unknown>;
}

function isNativeMetadataWriteAdapter(value: unknown): value is NativeMetadataWriteAdapter {
  return (
    isNativeMetadataProtocol(value) &&
    'requiresCreationMaskProbe' in value &&
    typeof value.requiresCreationMaskProbe === 'function' &&
    'createWriteCancellation' in value &&
    typeof value.createWriteCancellation === 'function' &&
    'cancelWrite' in value &&
    typeof value.cancelWrite === 'function' &&
    'recoverMetadataStaging' in value &&
    typeof value.recoverMetadataStaging === 'function' &&
    'prepareExistingMetadata' in value &&
    typeof value.prepareExistingMetadata === 'function' &&
    'existingMetadataIdentity' in value &&
    typeof value.existingMetadataIdentity === 'function' &&
    'releaseExistingMetadata' in value &&
    typeof value.releaseExistingMetadata === 'function' &&
    'prepareNewMetadata' in value &&
    typeof value.prepareNewMetadata === 'function' &&
    'recheckNewMetadata' in value &&
    typeof value.recheckNewMetadata === 'function' &&
    'releaseNewMetadata' in value &&
    typeof value.releaseNewMetadata === 'function' &&
    'stageExistingMetadata' in value &&
    typeof value.stageExistingMetadata === 'function' &&
    'stageNewMetadata' in value &&
    typeof value.stageNewMetadata === 'function' &&
    'publishMetadata' in value &&
    typeof value.publishMetadata === 'function' &&
    'releaseMetadataStage' in value &&
    typeof value.releaseMetadataStage === 'function'
  );
}

/** Resolves the fixed asset only; this does not itself authorize enabling a profile. */
export async function loadNativeMetadataWriteAdapter(): Promise<NativeMetadataWriteAdapter> {
  const adapter = await loadNativeMetadataProtocol();
  if (!isNativeMetadataWriteAdapter(adapter)) {
    throw new HostDeniedError('filesystem metadata protection is unavailable');
  }
  return adapter;
}
