import { describe, expect, it } from 'vitest';
import { MediaAdmissionError } from './media-admission.js';
import { deInlineMedia } from './media-deinline.js';
import { collectMediaForAdmission } from './media-publication.js';

const handle = `media://sha256-${'a'.repeat(64)}`;
function media() {
  return {
    type: 'media',
    mimeType: 'audio/L16',
    source: { kind: 'handle', ref: handle },
    byteLength: 2,
    durationMs: 3,
  };
}
class UnsupportedValue {
  readonly text = 'plain-looking class data';
}

describe('media publication inert domain', () => {
  const refused: readonly { name: string; make: () => unknown }[] = [
    { name: 'Date', make: () => new Date(0) },
    { name: 'RegExp', make: () => /plain/ },
    { name: 'class instance', make: () => new UnsupportedValue() },
    { name: 'function', make: () => () => 'plain' },
    { name: 'symbol', make: () => Symbol('plain') },
    { name: 'ArrayBuffer', make: () => new ArrayBuffer(2) },
    { name: 'typed array', make: () => new Uint8Array(2) },
    { name: 'DataView', make: () => new DataView(new ArrayBuffer(2)) },
    { name: 'data URI', make: () => 'data:audio/L16;base64,AAA=' },
  ];
  it.each(refused)('refuses media-free $name without normalizing it', async ({ make }) => {
    const value = { nested: [make()] };
    await expect(deInlineMedia(value, undefined)).rejects.toMatchObject({
      code: 'unsafe_value',
      message: 'Media publication requires inert data.',
    });
    expect(() => collectMediaForAdmission(value)).toThrow(MediaAdmissionError);
  });

  it('refuses accessors and serializers without invoking either', async () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'text', {
      get() {
        calls++;
        return 'plain';
      },
    });
    const serializer = {
      toJSON() {
        calls++;
        return { text: 'plain' };
      },
    };
    for (const value of [getter, serializer]) {
      await expect(deInlineMedia(value, undefined)).rejects.toMatchObject({ code: 'unsafe_value' });
      expect(() => collectMediaForAdmission(value)).toThrow(MediaAdmissionError);
    }
    expect(calls).toBe(0);
  });

  it('owns media-free plain, null-prototype, cyclic, Map and Set graphs', async () => {
    const plain = { label: 'before' };
    const nullPrototype: unknown = Object.create(null);
    if (typeof nullPrototype !== 'object' || nullPrototype === null)
      throw new Error('expected null-prototype record');
    Object.defineProperty(nullPrototype, 'plain', { value: plain, enumerable: true });
    const value: Record<string, unknown> = {
      plain,
      nullPrototype,
      array: [plain, undefined],
      map: new Map([[plain, plain]]),
      set: new Set([plain]),
    };
    value['self'] = value;
    const pending = deInlineMedia(value, undefined);
    plain.label = 'after';
    const owned = await pending;
    expect(owned).not.toBe(value);
    expect(owned).toMatchObject({ plain: { label: 'before' } });
    if (typeof owned !== 'object' || owned === null || !('self' in owned))
      throw new Error('missing owned graph');
    expect(owned.self).toBe(owned);
    expect(collectMediaForAdmission(owned)).toEqual([]);
  });

  it('keeps reflection errors fixed and content-free for the standalone collector', () => {
    for (const value of [
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('private prototype');
          },
        },
      ),
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('private keys');
          },
        },
      ),
      new Proxy(
        { text: 'plain' },
        {
          getOwnPropertyDescriptor: () => {
            throw new Error('private descriptor');
          },
        },
      ),
    ]) {
      expect(() => collectMediaForAdmission(value)).toThrow(
        'Media publication requires inert data.',
      );
    }
  });
});

describe('standalone admission descriptor ownership', () => {
  it('captures only owned primitive descriptors and reconciles shared cyclic collections', () => {
    const first = media();
    const second = media();
    const map = new Map<unknown, unknown>([[first, second]]);
    const set = new Set<unknown>([map, first]);
    map.set(set, map);
    Object.defineProperty(map, 'hidden', { value: second });
    Object.defineProperty(set, '__proto__', { value: first });
    const batch = collectMediaForAdmission({ map, set });
    first.source.ref = 'changed';
    first.byteLength = 400;
    second.mimeType = 'image/png';
    second.durationMs = 0;
    map.clear();
    set.clear();
    expect(batch).toEqual([
      { handle, mimeType: 'audio/L16', modality: 'audio', byteLength: 2, durationMs: 3 },
    ]);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch[0])).toBe(true);
    expect(
      Object.values(batch[0] ?? {}).every(
        (value) => typeof value === 'string' || typeof value === 'number',
      ),
    ).toBe(true);
  });

  it.each(['map', 'set'] as const)(
    'refuses incompatible handles found on %s own properties',
    (kind) => {
      const first = media();
      const second = { ...media(), byteLength: 4 };
      const collection = kind === 'map' ? new Map([['first', first]]) : new Set([first]);
      Object.defineProperty(collection, 'hidden', { value: second });
      expect(() => collectMediaForAdmission(collection)).toThrow('Media descriptors disagree.');
    },
  );

  it('does not read inherited collection type or kind getters', () => {
    let calls = 0;
    class Collection extends Map<unknown, unknown> {
      get type(): string {
        calls++;
        throw new Error('inherited type');
      }
      get kind(): string {
        calls++;
        throw new Error('inherited kind');
      }
    }
    const value = new Collection([['media', media()]]);
    Object.defineProperty(value, 'nested', { value: { text: 'plain' } });
    expect(collectMediaForAdmission(value)).toEqual([
      { handle, mimeType: 'audio/L16', modality: 'audio', byteLength: 2, durationMs: 3 },
    ]);
    expect(calls).toBe(0);
  });

  it.each(['record', 'map', 'set'] as const)('refuses loose base64 through %s', (kind) => {
    const source = { kind: 'base64', data: 'AAA=' };
    const container = kind === 'record' ? {} : kind === 'map' ? new Map() : new Set();
    Object.defineProperty(container, 'hidden', { value: source });
    expect(() => collectMediaForAdmission(container)).toThrow(
      'Media publication requires inert data.',
    );
    expect(() =>
      collectMediaForAdmission({
        part: { type: 'media', mimeType: 'audio/L16', source },
        container,
      }),
    ).toThrow('Media publication requires inert data.');
  });

  it('never admits an unpinned source or a missing/invalid own duration', () => {
    for (const source of [
      { kind: 'base64', data: 'AAA=' },
      { kind: 'url', url: 'https://example.invalid' },
    ])
      expect(() => collectMediaForAdmission({ ...media(), source })).toThrow(
        'Media descriptor is invalid.',
      );
    for (const durationMs of [undefined, 0, -1, '3'])
      expect(() => collectMediaForAdmission({ ...media(), durationMs })).toThrow(
        'Media descriptor is invalid.',
      );
  });
});
