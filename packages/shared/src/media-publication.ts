import { isBase64DataUri, isBinaryBuffer, type DurableMediaMeta } from './content.js';
import {
  admitMediaDescriptor,
  MediaAdmissionError,
  mediaDataField,
  mediaHasField,
  reconcileMediaDescriptors,
} from './media-admission.js';
export interface MediaSnapshot {
  readonly value: unknown;
  readonly nodes: readonly Record<string, unknown>[];
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
/** Shared supported-domain check; neither publication path invokes caller serializers. */
function mediaContainer(value: unknown, countOnly: boolean): object | undefined {
  if (typeof value === 'string') {
    if (!countOnly && isBase64DataUri(value)) throw new MediaAdmissionError('unsafe_value');
    return undefined;
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    if (!countOnly) throw new MediaAdmissionError('unsafe_value');
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  if (isBinaryBuffer(value)) {
    if (!countOnly) throw new MediaAdmissionError('unsafe_value');
    return undefined;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    !(value instanceof Map) &&
    !(value instanceof Set) &&
    proto !== Object.prototype &&
    proto !== null
  )
    throw new MediaAdmissionError('unsafe_value');
  return value;
}
/** Intrinsic entries are visited separately, then every inert own string property. */
function forEachMediaProperty(
  source: object,
  countOnly: boolean,
  visit: (key: string, value: unknown, enumerable: boolean) => void,
): void {
  const collection = source instanceof Map || source instanceof Set;
  for (const key of Reflect.ownKeys(source)) {
    // Deliberately bypass the caller's collection iterator, including its descriptor getter.
    // Other symbols remain outside the publication domain instead of disappearing from data.
    if (collection && key === Symbol.iterator) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !('value' in descriptor))
      throw new MediaAdmissionError('unsafe_value');
    if (typeof key === 'symbol') {
      if (!countOnly) throw new MediaAdmissionError('unsafe_value');
      continue;
    }
    const value: unknown = descriptor.value;
    visit(key, value, descriptor.enumerable === true);
  }
}
/** Own the inert graph in this synchronous call. Transparent Proxy reflection may trap; faults refuse. */
export function snapshotMediaValue(value: unknown, countOnly = false): MediaSnapshot {
  const memo = new Map<object, object>(),
    pending: { source: object; clone: object }[] = [],
    nodes: Record<string, unknown>[] = [],
    incoming = new Map<object, number>(),
    sourceEdges = new Map<object, number>(),
    loose: object[] = [];
  const copy = (item: unknown): unknown => {
    const source = mediaContainer(item, countOnly);
    if (source === undefined) return item;
    const prior = memo.get(source);
    if (prior !== undefined) {
      incoming.set(prior, (incoming.get(prior) ?? 0) + 1);
      return prior;
    }
    let clone: object;
    if (Array.isArray(source)) clone = [];
    else if (source instanceof Map) clone = new Map<unknown, unknown>();
    else if (source instanceof Set) clone = new Set<unknown>();
    else clone = {};
    memo.set(source, clone);
    incoming.set(clone, 1);
    pending.push({ source, clone });
    return clone;
  };
  try {
    const owned = copy(value);
    for (let at = 0; at < pending.length; at++) {
      const entry = pending[at];
      if (entry === undefined) throw new MediaAdmissionError('unsafe_value');
      const { source, clone } = entry;
      if (source instanceof Map && clone instanceof Map) {
        Map.prototype.forEach.call(source, (v: unknown, k: unknown) => {
          Map.prototype.set.call(clone, copy(k), copy(v));
        });
      } else if (source instanceof Set && clone instanceof Set) {
        Set.prototype.forEach.call(source, (v: unknown) => {
          Set.prototype.add.call(clone, copy(v));
        });
      }
      forEachMediaProperty(source, countOnly, (key, v, enumerable) => {
        Object.defineProperty(clone, key, {
          value: copy(v),
          enumerable,
          writable: true,
          configurable: !(Array.isArray(clone) && key === 'length'),
        });
      });
      if (record(clone)) {
        if (mediaDataField(clone, 'type') === 'media') {
          nodes.push(clone);
          const source = mediaDataField(clone, 'source');
          if (record(source)) sourceEdges.set(source, (sourceEdges.get(source) ?? 0) + 1);
        }
        if (mediaDataField(clone, 'kind') === 'base64') loose.push(clone);
      }
    }
    // Replacing media.source cannot remove an alias elsewhere in the owned graph. Every incoming
    // edge of a base64 source must therefore be an original media.source slot, including Map/Set
    // entries and own properties; multiple genuine media nodes may still share one source.
    if (!countOnly && loose.some((item) => incoming.get(item) !== sourceEdges.get(item)))
      throw new MediaAdmissionError('unsafe_value');
    return { value: owned, nodes };
  } catch {
    throw new MediaAdmissionError('unsafe_value');
  }
}
/** Synchronously own only the admission descriptors, without cloning the enclosing graph again. */
export function collectMediaForAdmission(value: unknown): readonly DurableMediaMeta[] {
  const visited = new Set<object>(),
    pending: object[] = [],
    incoming = new Map<object, number>(),
    sourceEdges = new Map<object, number>(),
    loose: object[] = [],
    items: DurableMediaMeta[] = [];
  let descriptorFailure: MediaAdmissionError | undefined;
  const visit = (item: unknown): void => {
    const source = mediaContainer(item, false);
    if (source === undefined) return;
    incoming.set(source, (incoming.get(source) ?? 0) + 1);
    if (visited.has(source)) return;
    visited.add(source);
    pending.push(source);
  };
  try {
    visit(value);
    for (let at = 0; at < pending.length; at++) {
      const node = pending[at];
      if (node === undefined) throw new MediaAdmissionError('unsafe_value');
      if (node instanceof Map) {
        Map.prototype.forEach.call(node, (v: unknown, k: unknown) => {
          visit(k);
          visit(v);
        });
      } else if (node instanceof Set) {
        Set.prototype.forEach.call(node, (v: unknown) => visit(v));
      }
      forEachMediaProperty(node, false, (_key, item) => visit(item));
      if (mediaDataField(node, 'kind') === 'base64') loose.push(node);
      if (mediaDataField(node, 'type') !== 'media') continue;
      const source = mediaDataField(node, 'source');
      if (record(source)) sourceEdges.set(source, (sourceEdges.get(source) ?? 0) + 1);
      try {
        if (!record(source) || mediaDataField(source, 'kind') !== 'handle')
          throw new MediaAdmissionError('invalid_descriptor');
        const mimeType = mediaDataField(node, 'mimeType');
        items.push(
          admitMediaDescriptor({
            handle: mediaDataField(source, 'ref'),
            mimeType,
            modality:
              typeof mimeType === 'string'
                ? mimeType.toLowerCase().startsWith('image/')
                  ? 'image'
                  : mimeType.toLowerCase().startsWith('audio/')
                    ? 'audio'
                    : mimeType.toLowerCase().startsWith('video/')
                      ? 'video'
                      : 'document'
                : undefined,
            byteLength: mediaDataField(node, 'byteLength'),
            ...(mediaHasField(node, 'durationMs')
              ? { durationMs: mediaDataField(node, 'durationMs') }
              : {}),
          }),
        );
      } catch (error) {
        if (!(error instanceof MediaAdmissionError) || error.code === 'unsafe_value') throw error;
        // Keep full-graph safety/alias preflight ahead of descriptor refusal, as the snapshot did.
        descriptorFailure ??= error;
      }
    }
    if (loose.some((item) => incoming.get(item) !== sourceEdges.get(item)))
      throw new MediaAdmissionError('unsafe_value');
  } catch {
    // Reflection and collection inspection never choose a diagnostic code or supply its text.
    throw new MediaAdmissionError('unsafe_value');
  }
  // Only pure admission/reconciliation failures survive the complete unsafe-value preflight.
  if (descriptorFailure !== undefined) throw descriptorFailure;
  return reconcileMediaDescriptors(items);
}
