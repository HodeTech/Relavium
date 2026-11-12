import type { AbortSignalLike } from '@relavium/shared';

import { HostDeniedError } from './errors.js';
import type { NativeMetadataWriteAdapter } from './fs-native-metadata.js';

interface NativeStageInput {
  readonly adapter: NativeMetadataWriteAdapter;
  readonly prepared: unknown;
  readonly before: Buffer | null;
  readonly after: Buffer;
  readonly home: string;
  readonly nonce: string;
  readonly creationMask: () => Promise<number | undefined>;
  readonly signal?: AbortSignalLike;
}

/** Own the stage, mask child, publication and cleanup until their native producers settle. */
export async function runNativeStage(input: NativeStageInput): Promise<void> {
  const { adapter, signal } = input;
  const cancellation = adapter.createWriteCancellation();
  const cancel = (): void => adapter.cancelWrite(cancellation);
  let stage: unknown;
  let hasStage = false;
  let failed = false;
  signal?.addEventListener('abort', cancel);
  try {
    if (signal?.aborted === true) cancel();
    const stageMask = await input.creationMask();
    if (signal?.aborted === true) cancel();
    stage =
      input.before === null
        ? await adapter.stageNewMetadata(
            input.prepared,
            input.home,
            input.after,
            input.nonce,
            stageMask,
            cancellation,
          )
        : await adapter.stageExistingMetadata(
            input.prepared,
            input.home,
            input.before,
            input.after,
            input.nonce,
            stageMask,
            cancellation,
          );
    hasStage = true;
    const publishMask = await input.creationMask();
    if (signal?.aborted === true) cancel();
    await adapter.publishMetadata(stage, publishMask, cancellation);
  } catch {
    // Native exception text can expose metadata or paths. Publication may have
    // occurred, so this is always fatal and never treated as a retry hint.
    failed = true;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (hasStage) {
      try {
        await adapter.releaseMetadataStage(stage);
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw new HostDeniedError('filesystem metadata operation failed');
}
