import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import {
  MAX_MEDIA_OBJECT_BYTES,
  MediaAdmissionError,
  createMediaVerifier,
  type AbortSignalLike,
  type DurableMediaMeta,
} from '@relavium/shared';

import { exactStats, MediaStoreFilesystemError, MediaStorePaths } from './media-store-paths.js';

/** Internal typed cancellation; caller-provided abort reasons never become diagnostics. */
class MediaReadCancelledError extends Error {
  readonly code = 'media_read_cancelled';
  constructor() {
    super('media read was cancelled');
    this.name = 'AbortError';
  }
}

/** Cancellation stays content-free, including when a caller supplied a private abort reason. */
export function assertMediaNotAborted(signal?: AbortSignalLike): void {
  if (signal?.aborted === true) throw new MediaReadCancelledError();
}

interface MediaScanResult {
  readonly bytes?: Uint8Array;
  readonly evidence?: Readonly<Pick<DurableMediaMeta, 'mimeType' | 'modality' | 'byteLength'>>;
  readonly byteLength: number;
}

/** One opened fd owns size, bytes, hash and optional format evidence through joined close. */
export async function scanMediaFile(
  paths: MediaStorePaths,
  digest: string,
  collect: boolean,
  mimeType?: string,
  signal?: AbortSignalLike,
): Promise<MediaScanResult> {
  assertMediaNotAborted(signal);
  const path = paths.path(digest, false);
  if (path === undefined) throw new MediaStoreFilesystemError('missing');
  const admitted = paths.fileSnapshot(path);
  if (admitted === undefined) throw new MediaStoreFilesystemError('missing');
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  const checkAbort = (): void => {
    if (aborted) throw new MediaReadCancelledError();
    assertMediaNotAborted(signal);
  };
  signal?.addEventListener('abort', onAbort);
  try {
    checkAbort();
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: unknown) => {
      throw paths.error(error);
    });
    let result: MediaScanResult | undefined;
    let cleanupError: MediaStoreFilesystemError | undefined;
    try {
      checkAbort();
      const opened = exactStats(
        await file.stat({ bigint: true }).catch((error: unknown) => {
          throw paths.error(error);
        }),
      );
      if (opened.dev !== admitted.dev) throw new MediaStoreFilesystemError('unsafe_path');
      paths.assertReadableFile(path, opened);
      // This check precedes even the fixed read buffer and every whole-body allocation.
      if (
        !Number.isSafeInteger(opened.size) ||
        opened.size < 0 ||
        opened.size > MAX_MEDIA_OBJECT_BYTES
      )
        throw new MediaAdmissionError('object_limit');
      const buffer = new Uint8Array(64 * 1024);
      const chunks: Uint8Array[] = [];
      let collectionBlock: Uint8Array | undefined;
      let collectionUsed = 0;
      const hash = createHash('sha256');
      const verifier = mimeType === undefined ? undefined : createMediaVerifier(mimeType);
      let total = 0;
      while (true) {
        checkAbort();
        // Native reads are joined even if abort arrives while one is pending. No fd or late
        // delivery escapes: cancellation wins immediately after the actual read settles.
        const { bytesRead } = await file
          .read({ buffer, offset: 0, length: buffer.length, position: null })
          .catch((error: unknown) => {
            checkAbort();
            throw paths.error(error);
          });
        checkAbort();
        if (bytesRead === 0) break;
        if (bytesRead > MAX_MEDIA_OBJECT_BYTES - total)
          throw new MediaAdmissionError('object_limit');
        const chunk = buffer.subarray(0, bytesRead);
        verifier?.push(chunk);
        hash.update(chunk);
        if (collect) {
          let offset = 0;
          while (offset < chunk.length) {
            if (collectionBlock === undefined || collectionUsed === collectionBlock.length) {
              collectionBlock = new Uint8Array(64 * 1024);
              chunks.push(collectionBlock);
              collectionUsed = 0;
            }
            const count = Math.min(collectionBlock.length - collectionUsed, chunk.length - offset);
            collectionBlock.set(chunk.subarray(offset, offset + count), collectionUsed);
            collectionUsed += count;
            offset += count;
          }
        }
        total += bytesRead;
      }
      const finished = exactStats(
        await file.stat({ bigint: true }).catch((error: unknown) => {
          throw paths.error(error);
        }),
      );
      checkAbort();
      if (finished.dev !== opened.dev || finished.ino !== opened.ino)
        throw new MediaStoreFilesystemError('unsafe_path');
      paths.assertReadableFile(path, finished);
      if (finished.size > MAX_MEDIA_OBJECT_BYTES) throw new MediaAdmissionError('object_limit');
      if (finished.size !== total || hash.digest('hex') !== digest)
        throw new Error('media bytes failed their content-address (sha256) integrity check');
      const evidence = verifier?.finish();
      if (collect) {
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          const count = Math.min(chunk.length, total - offset);
          bytes.set(chunk.subarray(0, count), offset);
          offset += count;
        }
        result = { bytes, byteLength: total, ...(evidence === undefined ? {} : { evidence }) };
      } else result = { byteLength: total, ...(evidence === undefined ? {} : { evidence }) };
    } finally {
      try {
        await file.close();
      } catch (error) {
        cleanupError = paths.error(error);
      }
    }
    checkAbort();
    if (cleanupError !== undefined) throw cleanupError;
    if (result === undefined) throw new MediaStoreFilesystemError('io');
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
