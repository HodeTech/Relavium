import { mediaByteLength, ownMediaBytes } from './media-byte-view.js';
import {
  decodedBase64ByteLength,
  decodeBase64,
  INLINE_MEDIA_CEILING,
  MEDIA_HANDLE_PATTERN,
  mediaModalityOf,
  type ContentPart,
  type DurableContentPart,
  type DurableMediaMeta,
  type MediaStore,
  type MediaEgressHooks,
} from './content.js';
import {
  admitMediaDescriptor,
  canonicalMediaMimeType,
  MAX_MEDIA_OBJECT_BYTES,
  MediaAdmissionError,
  mediaMimeTypesCompatible,
  reconcileMediaDescriptors,
} from './media-admission.js';
import { snapshotMediaValue } from './media-publication.js';
import { closeMediaIterator } from './media-iterator.js';
interface Occurrence {
  readonly node: Record<string, unknown>;
  readonly source: Record<string, unknown>;
  readonly descriptor: Omit<DurableMediaMeta, 'handle' | 'byteLength'> & {
    readonly byteLength?: number;
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function prepare(node: Record<string, unknown>): Occurrence {
  const source = node['source'];
  if (!record(source) || typeof node['mimeType'] !== 'string')
    throw new MediaAdmissionError('invalid_descriptor');
  const mimeType = canonicalMediaMimeType(node['mimeType']),
    modality = mediaModalityOf(mimeType);
  if (modality === undefined) throw new MediaAdmissionError('invalid_descriptor');
  const byteLength = node['byteLength'],
    durationMs = node['durationMs'];
  if (
    byteLength !== undefined &&
    (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0)
  )
    throw new MediaAdmissionError('invalid_descriptor');
  if (
    Object.hasOwn(node, 'durationMs') &&
    (typeof durationMs !== 'number' ||
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      (modality !== 'audio' && modality !== 'video'))
  )
    throw new MediaAdmissionError('invalid_descriptor');
  const kind = source['kind'];
  if (kind === 'handle') {
    if (typeof source['ref'] !== 'string' || !MEDIA_HANDLE_PATTERN.test(source['ref']))
      throw new MediaAdmissionError('invalid_descriptor');
  } else if (kind === 'base64') {
    if (typeof source['data'] !== 'string') throw new MediaAdmissionError('invalid_descriptor');
    const cap = INLINE_MEDIA_CEILING[modality];
    if (cap === 0 || source['data'].length > 4 * Math.ceil(cap / 3))
      throw new MediaAdmissionError('inline_limit');
    const n = decodedBase64ByteLength(source['data']);
    if (n === undefined) throw new MediaAdmissionError('invalid_descriptor');
    if (n > cap) throw new MediaAdmissionError('inline_limit');
    if (byteLength !== undefined && n !== byteLength)
      throw new MediaAdmissionError('descriptor_conflict');
  } else if (kind === 'url') {
    if (typeof source['url'] !== 'string') throw new MediaAdmissionError('invalid_descriptor');
  } else throw new MediaAdmissionError('invalid_descriptor');
  return {
    node,
    source,
    descriptor: Object.freeze({
      mimeType,
      modality,
      ...(typeof byteLength === 'number' ? { byteLength } : {}),
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
    }),
  };
}
function compareOriginal(items: readonly Occurrence[]): void {
  const seen = new Map<string, Occurrence>();
  for (const item of items) {
    if (item.source['kind'] !== 'handle') continue;
    const handle = item.source['ref'];
    if (typeof handle !== 'string') throw new MediaAdmissionError('invalid_descriptor');
    const prior = seen.get(handle);
    if (prior !== undefined) {
      const a = prior.descriptor,
        b = item.descriptor;
      if (
        (!mediaMimeTypesCompatible(a.mimeType, b.mimeType) &&
          !mediaMimeTypesCompatible(b.mimeType, a.mimeType)) ||
        a.modality !== b.modality ||
        (a.byteLength !== undefined &&
          b.byteLength !== undefined &&
          a.byteLength !== b.byteLength) ||
        (a.durationMs !== undefined && b.durationMs !== undefined && a.durationMs !== b.durationMs)
      )
        throw new MediaAdmissionError('descriptor_conflict');
      // Retain enriched claims so a missing middle occurrence cannot hide a later conflict.
      seen.set(handle, {
        ...item,
        descriptor: {
          ...b,
          ...(a.byteLength === undefined ? {} : { byteLength: a.byteLength }),
          ...(a.durationMs === undefined ? {} : { durationMs: a.durationMs }),
        },
      });
    } else seen.set(handle, item);
  }
}
export function deInlineMedia(
  parts: readonly ContentPart[],
  store: MediaStore | undefined,
  egress?: MediaEgressHooks,
  beforeStoreWrite?: (unpinnedCount: number) => void,
): Promise<DurableContentPart[]>;
export function deInlineMedia(
  value: unknown,
  store: MediaStore | undefined,
  egress?: MediaEgressHooks,
  beforeStoreWrite?: (unpinnedCount: number) => void,
): Promise<unknown>;
/** Own and preflight every occurrence before the first host call or await (ADR-0106). */
export async function deInlineMedia(
  value: unknown,
  store: MediaStore | undefined,
  egress?: MediaEgressHooks,
  beforeStoreWrite?: (unpinnedCount: number) => void,
): Promise<unknown> {
  const snapshot = snapshotMediaValue(value),
    items = snapshot.nodes.map(prepare);
  compareOriginal(items);
  const count = items.reduce((sum, item) => sum + (item.source['kind'] === 'handle' ? 0 : 1), 0);
  beforeStoreWrite?.(count);
  if (items.length === 0) return snapshot.value;
  if (store === undefined) throw new MediaAdmissionError('store_unavailable');
  if (typeof store.validateMedia !== 'function') throw new MediaAdmissionError('store_contract');
  const admitted: DurableMediaMeta[] = [];
  for (const item of items) {
    let handle = item.source['ref'],
      actualCount = item.descriptor.byteLength;
    if (item.source['kind'] === 'base64') {
      const data = item.source['data'];
      if (typeof data !== 'string') throw new MediaAdmissionError('invalid_descriptor');
      const bytes = decodeBase64(data);
      if (bytes === undefined) throw new MediaAdmissionError('invalid_descriptor');
      actualCount = bytes.length;
      handle = await store.put(bytes, item.descriptor.mimeType);
    } else if (item.source['kind'] === 'url') {
      const url = item.source['url'];
      if (typeof url !== 'string') throw new MediaAdmissionError('invalid_descriptor');
      if (typeof egress?.streamUrl !== 'function' || typeof store.putStream !== 'function')
        throw new MediaAdmissionError('source_unavailable');
      const stored = await storeStream(
        egress.streamUrl({
          url,
          mimeType: item.descriptor.mimeType,
          maxBytes: MAX_MEDIA_OBJECT_BYTES,
        }),
        store,
        item.descriptor.mimeType,
      );
      handle = stored.handle;
      actualCount = stored.byteLength;
    }
    if (typeof handle !== 'string' || !MEDIA_HANDLE_PATTERN.test(handle))
      throw new MediaAdmissionError('store_contract');
    if (item.descriptor.byteLength !== undefined && item.descriptor.byteLength !== actualCount)
      throw new MediaAdmissionError('descriptor_conflict');
    const descriptor = {
      ...item.descriptor,
      ...(actualCount === undefined ? {} : { byteLength: actualCount }),
    };
    const result = admitMediaDescriptor(await store.validateMedia(handle, descriptor));
    if (
      result.handle !== handle ||
      !mediaMimeTypesCompatible(item.descriptor.mimeType, result.mimeType) ||
      result.modality !== item.descriptor.modality ||
      (actualCount !== undefined && result.byteLength !== actualCount) ||
      result.durationMs !== item.descriptor.durationMs ||
      result.byteLength > MAX_MEDIA_OBJECT_BYTES
    )
      throw new MediaAdmissionError('store_contract');
    admitted.push(result);
    item.node['mimeType'] = result.mimeType;
    item.node['byteLength'] = result.byteLength;
    item.node['source'] = { kind: 'handle', ref: handle };
  }
  reconcileMediaDescriptors(admitted);
  return snapshot.value;
}
async function storeStream(
  source: AsyncIterable<Uint8Array>,
  store: MediaStore,
  mimeType: string,
): Promise<{ handle: string; byteLength: number }> {
  // Acquire once, even if the store never pulls. A generator's unstarted finally would not close it.
  const iterator = source[Symbol.asyncIterator]();
  let byteLength = 0,
    drained = false,
    failed = false;
  let acquired = false;
  const counted: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      if (acquired) throw new MediaAdmissionError('store_contract');
      acquired = true;
      return {
        async next() {
          const next = await iterator.next();
          if (next.done) {
            drained = true;
            return { done: true, value: undefined };
          }
          const chunk = next.value;
          const length = mediaByteLength(chunk);
          if (length > MAX_MEDIA_OBJECT_BYTES - byteLength)
            throw new MediaAdmissionError('object_limit');
          byteLength += length;
          return { done: false, value: ownMediaBytes(chunk, length) };
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          // The store must retire its file/temp first. The encompassing finally joins native ACK.
          void closeMediaIterator(iterator).catch(() => undefined);
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  try {
    if (store.putStream === undefined) throw new MediaAdmissionError('source_unavailable');
    const handle = await store.putStream(counted, mimeType);
    if (!drained) throw new MediaAdmissionError('stream_incomplete');
    return { handle, byteLength };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!drained) {
      await closeMediaIterator(iterator).catch(() => {
        // Preserve a primary store/refusal error; a close-only fault remains typed.
        if (!failed) throw new MediaAdmissionError('source_failed');
      });
    }
  }
}
/** Safe compatibility count; handle occurrences do not spend the existing rehost budget. */
export function countUnpinnedMedia(value: unknown): number {
  const snapshot = snapshotMediaValue(value, true);
  let count = 0;
  for (const node of snapshot.nodes) {
    const source = node['source'];
    if (
      typeof node['mimeType'] === 'string' &&
      record(source) &&
      typeof source['kind'] === 'string' &&
      source['kind'] !== 'handle'
    )
      count++;
  }
  return count;
}
