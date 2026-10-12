import { describe, expect, it } from 'vitest';
import { countUnpinnedMedia, deInlineMedia } from './media-deinline.js';
import { admitMediaDescriptor, MediaAdmissionError } from './media-admission.js';
import type { MediaStore } from './content.js';
const handle = `media://sha256-${'a'.repeat(64)}`;
const media = () => ({
  type: 'media',
  mimeType: 'audio/L16',
  source: { kind: 'handle', ref: handle },
  durationMs: 3,
});
function store(): MediaStore {
  return {
    put: () => Promise.resolve(handle),
    get: () => Promise.resolve(new Uint8Array(2)),
    resolveForEgress: () => Promise.resolve({ kind: 'handle', ref: handle }),
    readRange: () => Promise.resolve(new Uint8Array(2)),
    validateMedia: (ref, descriptor) =>
      Promise.resolve(admitMediaDescriptor({ ...descriptor, handle: ref, byteLength: 2 })),
  };
}
function deferred() {
  let resolve: () => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('owned media publication', () => {
  it('checks actual streamed view capacity before copying despite dishonest length and slice', async () => {
    const s = store();
    let delivered = 0,
      closed = 0,
      overrides = 0;
    s.putStream = async (chunks) => {
      for await (const chunk of chunks) delivered += chunk.length;
      return handle;
    };
    const bytes = new Uint8Array(25 * 1024 * 1024 + 1);
    for (const key of ['length', 'byteLength', 'slice', Symbol.iterator])
      Object.defineProperty(bytes, key, {
        get() {
          overrides++;
          return 2;
        },
      });
    await expect(
      deInlineMedia(
        {
          type: 'media',
          mimeType: 'audio/L16',
          source: { kind: 'url', url: 'https://example.invalid' },
        },
        s,
        {
          streamUrl: () => ({
            [Symbol.asyncIterator]() {
              return {
                next: () => Promise.resolve({ done: false, value: bytes }),
                return() {
                  closed++;
                  return Promise.resolve({ done: true, value: undefined });
                },
              };
            },
          }),
        },
      ),
      'media-stream-before-copy-bound',
    ).rejects.toMatchObject({ code: 'object_limit' });
    expect([delivered, closed, overrides]).toEqual([0, 1, 0]);
  });
  it('owns media-free containers against callback and promise-gap introduction of media', async () => {
    for (const callbackMutation of [false, true]) {
      const value: { child: unknown; map: Map<unknown, unknown>; set: Set<unknown> } = {
        child: { type: 'text', text: 'before' },
        map: new Map(),
        set: new Set(),
      };
      const mutate = () => {
        value.child = media();
        value.map.set(media(), media());
        value.set.add(media());
      };
      const pending = deInlineMedia(value, undefined, undefined, () => {
        if (callbackMutation) mutate();
      });
      if (!callbackMutation) mutate();
      expect(await pending, 'media-free-owned-before-await').toEqual({
        child: { type: 'text', text: 'before' },
        map: new Map(),
        set: new Set(),
      });
    }
  });
  it('validates handle-only media afresh with independently supplied count, refusing no store', async () => {
    const s = store();
    let calls = 0;
    const validate = s.validateMedia.bind(s);
    s.validateMedia = (...args) => {
      calls++;
      return validate(...args);
    };
    expect(await deInlineMedia(media(), s)).toMatchObject({ byteLength: 2 });
    expect(await deInlineMedia(media(), s)).toMatchObject({ byteLength: 2 });
    expect(calls, 'media-handle-validation-required').toBe(2);
    await expect(deInlineMedia(media(), undefined)).rejects.toMatchObject({
      code: 'store_unavailable',
    });
    const text = { text: 'plain' };
    expect(await deInlineMedia(text, undefined)).toEqual(text);
  });
  it('owns all descriptors and siblings before the first await and before synchronous count callback', async () => {
    const gate = deferred(),
      s = store(),
      validate = s.validateMedia.bind(s);
    s.validateMedia = async (...args) => {
      await gate.promise;
      return validate(...args);
    };
    const first = media(),
      second = media(),
      set = new Set<unknown>([second]),
      map = new Map<unknown, unknown>([[first, set]]),
      value = { map, label: 'before' };
    const pending = deInlineMedia(value, s, undefined, (count) => {
      expect(count).toBe(0);
      first.mimeType = 'image/svg+xml';
      first.source.ref = 'secret';
      second.durationMs = 0;
      value.label = 'after';
      set.clear();
      map.clear();
    });
    gate.resolve();
    const result = await pending;
    expect(result, 'media-owned-descriptor-after-await').toMatchObject({ label: 'before' });
    expect(result).not.toBe(value);
    if (
      typeof result !== 'object' ||
      result === null ||
      !('map' in result) ||
      !(result.map instanceof Map)
    )
      throw new Error('missing owned map');
    expect(result.map.size).toBe(1);
    const entries = Array.from(result.map.entries());
    expect(entries[0]?.[0]).toMatchObject({ mimeType: 'audio/L16', durationMs: 3, byteLength: 2 });
  });
  it('does not invoke getters, custom serializers, or overridden container iterators', async () => {
    let calls = 0;
    const accessor = { media: media() };
    Object.defineProperty(accessor, 'secret', {
      get() {
        calls++;
        throw new Error('private-secret');
      },
    });
    await expect(deInlineMedia(accessor, store())).rejects.toMatchObject({ code: 'unsafe_value' });
    expect(() => countUnpinnedMedia(accessor)).toThrow(MediaAdmissionError);
    const map = new Map([['m', media()]]),
      set = new Set([media()]);
    for (const container of [map, set])
      Object.defineProperty(container, Symbol.iterator, {
        get() {
          calls++;
          throw new Error('private-secret');
        },
      });
    const copied = await deInlineMedia({ map, set }, store());
    expect(copied).not.toBeUndefined();
    const serializer = { text: 'hello' };
    Object.defineProperty(serializer, 'toJSON', {
      value() {
        calls++;
        return 'private-secret';
      },
    });
    await expect(deInlineMedia(serializer, store())).rejects.toMatchObject({
      code: 'unsafe_value',
    });
    expect(calls).toBe(0);
  });
  it('contains reflection faults with fixed errors and safely preserves __proto__ own data', async () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('private-reflection');
        },
      },
    );
    await expect(deInlineMedia(proxy, store())).rejects.toMatchObject({
      code: 'unsafe_value',
      message: 'Media publication requires inert data.',
    });
    const value: unknown = JSON.parse('{"__proto__":{"polluted":true}}');
    const out = await deInlineMedia({ value, media: media() }, store());
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(JSON.stringify(out)).toContain('"__proto__":{"polluted":true}');
  });
  it('rejects all original conflicts and invalid metadata before writes or fetches', async () => {
    const s = store();
    let calls = 0,
      validations = 0;
    const validate = s.validateMedia.bind(s);
    s.validateMedia = (...args) => {
      validations++;
      return validate(...args);
    };
    s.put = () => {
      calls++;
      return Promise.resolve(handle);
    };
    for (const invalid of [0, -1, undefined, '3']) {
      const bad = { ...media(), durationMs: invalid };
      await expect(
        deInlineMedia(
          [{ type: 'media', mimeType: 'audio/L16', source: { kind: 'base64', data: 'AAA=' } }, bad],
          s,
        ),
      ).rejects.toMatchObject({ code: 'invalid_descriptor' });
    }
    const [conflict] = await Promise.allSettled([
      deInlineMedia(
        [
          { ...media(), byteLength: 2 },
          { ...media(), byteLength: 4 },
        ],
        s,
      ),
    ]);
    expect(calls).toBe(0);
    expect(validations, 'FS_CAUSAL_MEDIA_SAME_HASH_BEFORE_READ').toBe(0);
    expect(conflict).toMatchObject({
      status: 'rejected',
      reason: { code: 'descriptor_conflict' },
    });
  });
  it('predecode inline cap and finite MIME refuse before host entry', async () => {
    let calls = 0;
    const s = store();
    s.put = () => {
      calls++;
      return Promise.resolve(handle);
    };
    for (const value of [
      {
        type: 'media',
        mimeType: 'audio/L16',
        source: { kind: 'base64', data: 'A'.repeat(349528) },
      },
      { type: 'media', mimeType: 'video/mp4', source: { kind: 'base64', data: 'AAA=' } },
    ])
      await expect(deInlineMedia(value, s), 'media-inline-predecode-bound').rejects.toMatchObject({
        code: 'inline_limit',
      });
    await expect(
      deInlineMedia(
        { type: 'media', mimeType: 'image/svg+xml', source: { kind: 'url', url: 'private' } },
        s,
        {
          streamUrl() {
            calls++;
            throw new Error('entered');
          },
        },
      ),
      'media-finite-mime-before-egress',
    ).rejects.toMatchObject({ code: 'unsupported_mime' });
    expect(calls).toBe(0);
  });
  it('rejects a missing runtime validator and mismatching returned evidence', async () => {
    const absent = store();
    Object.defineProperty(absent, 'validateMedia', { value: undefined });
    await expect(deInlineMedia(media(), absent)).rejects.toMatchObject({ code: 'store_contract' });
    for (const patch of [
      { handle: `media://sha256-${'b'.repeat(64)}` },
      { mimeType: 'audio/wav' },
      { byteLength: 4 },
      { durationMs: 7 },
    ]) {
      const s = store();
      s.validateMedia = (ref, d) =>
        Promise.resolve(admitMediaDescriptor({ ...d, handle: ref, byteLength: 2, ...patch }));
      await expect(deInlineMedia({ ...media(), byteLength: 2 }, s)).rejects.toMatchObject({
        code: 'store_contract',
      });
    }
  });
  it('closes a single acquired upstream even when an injected store never pulls or throws', async () => {
    for (const throws of [false, true]) {
      let acquired = 0,
        closed = 0,
        pulls = 0;
      const s = store();
      s.putStream = () =>
        throws ? Promise.reject(new MediaAdmissionError('source_failed')) : Promise.resolve(handle);
      const value = {
        type: 'media',
        mimeType: 'audio/L16',
        source: { kind: 'url', url: 'https://example.invalid' },
      };
      await expect(
        deInlineMedia(value, s, {
          streamUrl: () => ({
            [Symbol.asyncIterator]() {
              acquired++;
              return {
                next() {
                  pulls++;
                  return Promise.resolve({ done: false, value: new Uint8Array(2) });
                },
                return() {
                  closed++;
                  return Promise.resolve({ done: true, value: undefined });
                },
              };
            },
          }),
        }),
      ).rejects.toBeInstanceOf(MediaAdmissionError);
      expect([acquired, pulls, closed], 'media-stream-early-return-closes-source').toEqual([
        1, 0, 1,
      ]);
    }
  });
  it('does not wait forever for an arbitrary hostile return', async () => {
    const s = store();
    s.putStream = () => Promise.resolve(handle);
    await expect(
      deInlineMedia(
        {
          type: 'media',
          mimeType: 'audio/L16',
          source: { kind: 'url', url: 'https://example.invalid' },
        },
        s,
        {
          streamUrl: () => ({
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise(() => undefined),
                return: () => new Promise(() => undefined),
              };
            },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'stream_incomplete' });
  });
  it('owns reused borrowed stream chunks before the producer mutates them', async () => {
    const s = store(),
      borrowed = new Uint8Array([1, 2]);
    let count = 0;
    const seen: Uint8Array[] = [];
    s.putStream = async (chunks) => {
      for await (const chunk of chunks) seen.push(chunk);
      return handle;
    };
    s.validateMedia = (ref, d) =>
      Promise.resolve(admitMediaDescriptor({ ...d, handle: ref, byteLength: 4 }));
    await deInlineMedia(
      {
        type: 'media',
        mimeType: 'audio/L16',
        source: { kind: 'url', url: 'https://example.invalid' },
      },
      s,
      {
        streamUrl: () => ({
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (count++ === 2) return Promise.resolve({ done: true, value: undefined });
                if (count === 2) borrowed.fill(7);
                return Promise.resolve({ done: false, value: borrowed });
              },
            };
          },
        }),
      },
    );
    expect(seen, 'MEDIA_BORROWED_CHUNK_OWNERSHIP').toEqual([
      new Uint8Array([1, 2]),
      new Uint8Array([7, 7]),
    ]);
  });
});
