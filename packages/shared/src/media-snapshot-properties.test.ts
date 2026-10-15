import { describe, expect, it } from 'vitest';
import { admitMediaDescriptor } from './media-admission.js';
import { countUnpinnedMedia, deInlineMedia } from './media-deinline.js';
import { collectMediaForAdmission, snapshotMediaValue } from './media-publication.js';
import type { MediaStore } from './content.js';

const handle = `media://sha256-${'a'.repeat(64)}`;
function media() {
  return { type: 'media', mimeType: 'audio/L16', source: { kind: 'base64', data: 'AAA=' } };
}
function store(onWrite: () => void = () => undefined): MediaStore {
  return {
    put: () => {
      onWrite();
      return Promise.resolve(handle);
    },
    get: () => Promise.resolve(new Uint8Array(2)),
    resolveForEgress: () => Promise.resolve({ kind: 'handle', ref: handle }),
    readRange: () => Promise.resolve(new Uint8Array(2)),
    validateMedia: (ref, descriptor) =>
      Promise.resolve(admitMediaDescriptor({ ...descriptor, handle: ref, byteLength: 2 })),
  };
}
function field(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== 'object' || value === null) throw new Error('expected object');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) throw new Error('expected own data');
  const result: unknown = descriptor.value;
  return result;
}

describe('media snapshot collection own properties', () => {
  it.each(['map', 'set'] as const)(
    'preserves %s own data, nested media, non-enumerability, special keys and entry aliases',
    async (kind) => {
      const part = media();
      const shared = { label: 'before', part };
      const source =
        kind === 'map' ? new Map<unknown, unknown>([[shared, shared]]) : new Set([shared]);
      for (const [key, value] of [
        ['hidden', shared],
        ['__proto__', shared],
        ['length', shared],
      ] as const)
        Object.defineProperty(source, key, { value, enumerable: false });
      Object.defineProperty(source, 'self', { value: source, enumerable: true });
      let reserved = -1;
      const pending = deInlineMedia(source, store(), undefined, (count) => {
        reserved = count;
        shared.label = 'after';
        part.source.data = 'changed';
        source.clear();
      });
      const owned = await pending;
      const child = field(owned, 'hidden');
      expect(child).toMatchObject({
        label: 'before',
        part: { source: { kind: 'handle', ref: handle }, byteLength: 2 },
      });
      expect(child).not.toBe(shared);
      expect(field(owned, '__proto__')).toBe(child);
      expect(field(owned, 'length')).toBe(child);
      expect(field(owned, 'self')).toBe(owned);
      expect(Object.getOwnPropertyDescriptor(owned, 'hidden')).toMatchObject({ enumerable: false });
      expect(Object.getOwnPropertyDescriptor(owned, 'length')).toMatchObject({
        configurable: true,
      });
      if (owned instanceof Map) {
        expect(owned.size).toBe(1);
        expect(owned.get(child)).toBe(child);
      } else if (owned instanceof Set) {
        expect(owned.size).toBe(1);
        expect(owned.has(child)).toBe(true);
      } else throw new Error('expected owned collection');
      expect(reserved).toBe(1);
      expect(collectMediaForAdmission(owned)).toEqual([
        { handle, mimeType: 'audio/L16', modality: 'audio', byteLength: 2 },
      ]);
    },
  );

  it.each(['map', 'set'] as const)(
    'counts media reachable only through %s own properties',
    (kind) => {
      const source = kind === 'map' ? new Map() : new Set();
      Object.defineProperty(source, 'hidden', { value: { part: media() } });
      expect(countUnpinnedMedia(source)).toBe(1);
    },
  );

  it.each(['map', 'set'] as const)(
    'refuses %s own-property base64 aliases before reservation or writes',
    async (kind) => {
      const part = media();
      const source = kind === 'map' ? new Map() : new Set();
      Object.defineProperty(source, 'hidden', { value: part.source });
      let writes = 0;
      let reservations = 0;
      await expect(
        deInlineMedia(
          { part, source },
          store(() => writes++),
          undefined,
          () => reservations++,
        ),
      ).rejects.toMatchObject({ code: 'unsafe_value' });
      expect([writes, reservations]).toEqual([0, 0]);
    },
  );

  it.each(['map', 'set'] as const)(
    'bypasses only %s own Symbol.iterator and refuses other symbol properties',
    async (kind) => {
      let reads = 0;
      const source = kind === 'map' ? new Map([['x', 1]]) : new Set([1]);
      Object.defineProperty(source, Symbol.iterator, {
        get() {
          reads++;
          throw new Error('caller iterator getter');
        },
      });
      expect(await deInlineMedia(source, undefined)).toEqual(
        kind === 'map' ? new Map([['x', 1]]) : new Set([1]),
      );
      expect(collectMediaForAdmission(source)).toEqual([]);
      Object.defineProperty(source, Symbol('extra'), { value: 'data' });
      await expect(deInlineMedia(source, undefined)).rejects.toMatchObject({
        code: 'unsafe_value',
      });
      expect(() => collectMediaForAdmission(source)).toThrow(
        'Media publication requires inert data.',
      );
      expect(reads).toBe(0);
    },
  );

  it.each(['map', 'set'] as const)(
    'refuses %s own accessors without invoking them',
    async (kind) => {
      let reads = 0;
      const source = kind === 'map' ? new Map() : new Set();
      Object.defineProperty(source, 'hidden', {
        get() {
          reads++;
          return media();
        },
      });
      await expect(deInlineMedia(source, undefined)).rejects.toMatchObject({
        code: 'unsafe_value',
      });
      expect(() => collectMediaForAdmission(source)).toThrow(
        'Media publication requires inert data.',
      );
      expect(reads).toBe(0);
    },
  );

  it.each(['map', 'set'] as const)(
    'refuses unsupported values in %s own data instead of dropping them',
    async (kind) => {
      for (const value of [
        new Date(0),
        () => 'plain',
        new Uint8Array(2),
        'data:audio/L16;base64,AAA=',
      ]) {
        const source = kind === 'map' ? new Map() : new Set();
        Object.defineProperty(source, 'hidden', { value });
        await expect(deInlineMedia(source, undefined)).rejects.toMatchObject({
          code: 'unsafe_value',
        });
        expect(() => collectMediaForAdmission(source)).toThrow(
          'Media publication requires inert data.',
        );
      }
    },
  );

  it('keeps array length nonconfigurable and ordinary record length configurable', () => {
    const value = { array: [1, 2], record: { length: { label: 'data' } } };
    const owned = snapshotMediaValue(value).value;
    expect(Object.getOwnPropertyDescriptor(field(owned, 'array'), 'length')).toMatchObject({
      value: 2,
      configurable: false,
    });
    const record = field(owned, 'record');
    expect(Object.getOwnPropertyDescriptor(record, 'length')).toMatchObject({ configurable: true });
    expect(field(record, 'length')).not.toBe(value.record.length);
  });
});
