import { isBase64DataUri, isBinaryBuffer, type DurableMediaMeta } from './content.js';
import {
  admitMediaDescriptor,
  MediaAdmissionError,
  mediaDataField,
  reconcileMediaDescriptors,
} from './media-admission.js';
export interface MediaSnapshot {
  readonly value: unknown;
  readonly nodes: readonly Record<string, unknown>[];
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
/** Own the inert graph in this synchronous call. Transparent Proxy reflection may trap; faults refuse. */
export function snapshotMediaValue(value: unknown, countOnly = false): MediaSnapshot {
  const memo = new Map<object, unknown>(),
    pending: { source: object; clone: object }[] = [],
    nodes: Record<string, unknown>[] = [],
    sources = new Set<object>(),
    loose: object[] = [];
  const copy = (item: unknown): unknown => {
    if (typeof item === 'string') {
      if (!countOnly && isBase64DataUri(item)) throw new MediaAdmissionError('unsafe_value');
      return item;
    }
    if (typeof item === 'function' || typeof item === 'symbol') {
      if (!countOnly) throw new MediaAdmissionError('unsafe_value');
      return item;
    }
    if (typeof item !== 'object' || item === null) return item;
    if (isBinaryBuffer(item)) {
      if (!countOnly) throw new MediaAdmissionError('unsafe_value');
      return item;
    }
    if (memo.has(item)) return memo.get(item);
    const proto: unknown = Object.getPrototypeOf(item);
    let clone: object;
    if (Array.isArray(item)) clone = [];
    else if (item instanceof Map) clone = new Map<unknown, unknown>();
    else if (item instanceof Set) clone = new Set<unknown>();
    else {
      if (proto !== Object.prototype && proto !== null)
        throw new MediaAdmissionError('unsafe_value');
      clone = {};
    }
    memo.set(item, clone);
    pending.push({ source: item, clone });
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
        continue;
      }
      if (source instanceof Set && clone instanceof Set) {
        Set.prototype.forEach.call(source, (v: unknown) => {
          Set.prototype.add.call(clone, copy(v));
        });
        continue;
      }
      for (const key of Reflect.ownKeys(source)) {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor === undefined) throw new MediaAdmissionError('unsafe_value');
        if (!('value' in descriptor)) throw new MediaAdmissionError('unsafe_value');
        const v: unknown = descriptor.value;
        if (typeof key === 'symbol') {
          if (!countOnly) throw new MediaAdmissionError('unsafe_value');
          continue;
        }
        Object.defineProperty(clone, key, {
          value: copy(v),
          enumerable: descriptor.enumerable === true,
          writable: true,
          configurable: key !== 'length',
        });
      }
      if (record(clone)) {
        if (clone['type'] === 'media') {
          nodes.push(clone);
          if (record(clone['source'])) sources.add(clone['source']);
        }
        if (clone['kind'] === 'base64') loose.push(clone);
      }
    }
    if (!countOnly && loose.some((item) => !sources.has(item)))
      throw new MediaAdmissionError('unsafe_value');
    return { value: owned, nodes };
  } catch (error) {
    if (error instanceof MediaAdmissionError) throw error;
    throw new MediaAdmissionError('unsafe_value');
  }
}
export function collectMediaForAdmission(value: unknown): readonly DurableMediaMeta[] {
  const snapshot = snapshotMediaValue(value),
    items: DurableMediaMeta[] = [];
  for (const node of snapshot.nodes) {
    const source = mediaDataField(node, 'source');
    if (!record(source) || source['kind'] !== 'handle')
      throw new MediaAdmissionError('invalid_descriptor');
    const mimeType = node['mimeType'];
    items.push(
      admitMediaDescriptor({
        handle: source['ref'],
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
        byteLength: node['byteLength'],
        ...(Object.hasOwn(node, 'durationMs') ? { durationMs: node['durationMs'] } : {}),
      }),
    );
  }
  return reconcileMediaDescriptors(items);
}
