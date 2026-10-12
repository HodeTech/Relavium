import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { admitMediaDescriptor, MediaAdmissionError } from './media-admission.js';
import type { MediaStore } from './content.js';
import { deInlineMedia } from './media-deinline.js';
import { registerNativeMediaIterator } from './media-iterator.js';

const handle = `media://sha256-${'a'.repeat(64)}`;
const part = {
  type: 'media',
  mimeType: 'audio/L16',
  source: { kind: 'url', url: 'https://fixture.invalid/media' },
};
function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function store(putStream: NonNullable<MediaStore['putStream']>): MediaStore {
  return {
    putStream,
    put: () => Promise.resolve(handle),
    get: () => Promise.resolve(new Uint8Array(2)),
    resolveForEgress: () => Promise.resolve({ kind: 'handle', ref: handle }),
    readRange: () => Promise.resolve(new Uint8Array(2)),
    validateMedia: (ref, descriptor) =>
      Promise.resolve(admitMediaDescriptor({ ...descriptor, handle: ref, byteLength: 2 })),
  };
}

describe('de-inline source retirement', () => {
  it.each(['resolve', 'reject'] as const)(
    'lets the counted consumer clean before joining native %s, preserving its primary error',
    async (kind) => {
      const held = gate(),
        closeStarted = gate();
      let cleaned = false,
        settled = false,
        closeCalls = 0;
      const primary = new MediaAdmissionError('invalid_format');
      const returned = held.promise.then(() => {
        if (kind === 'reject') throw new Error('private native close diagnostic');
        return { done: true, value: undefined } as const;
      });
      const returnedObserved = returned.catch(() => undefined);
      const source = registerNativeMediaIterator<AsyncIterableIterator<Uint8Array>>({
        next: () => Promise.resolve({ done: false, value: new Uint8Array([1, 2]) }),
        return: () => {
          closeCalls++;
          closeStarted.release();
          return returned;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      });
      const target = store(async (chunks) => {
        try {
          for await (const chunk of chunks) {
            expect(chunk).toEqual(new Uint8Array([1, 2]));
            throw primary;
          }
          return handle;
        } finally {
          cleaned = true;
        }
      });
      const result = deInlineMedia(part, target, { streamUrl: () => source }).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        await closeStarted.promise;
        await setImmediate();
        expect(cleaned, 'MEDIA_COUNTED_RETURN_PROMPT').toBe(true);
        expect(settled, 'MEDIA_DEINLINE_NATIVE_JOIN').toBe(false);
        expect(closeCalls).toBe(1);
        held.release();
        expect(await result, 'MEDIA_DEINLINE_PRIMARY_PRECEDENCE').toEqual({ error: primary });
      } finally {
        held.release();
        await Promise.all([returnedObserved, result]);
      }
    },
  );

  it('finishes foreign interruption while its return is still held', async () => {
    const held = gate(),
      closeStarted = gate();
    let cleaned = false,
      settled = false;
    const primary = new MediaAdmissionError('invalid_format');
    const returned = held.promise.then(() => ({ done: true, value: undefined }) as const);
    const source: AsyncIterableIterator<Uint8Array> = {
      next: () => Promise.resolve({ done: false, value: new Uint8Array([1, 2]) }),
      return: () => {
        closeStarted.release();
        return returned;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const result = deInlineMedia(
      part,
      store(async (chunks) => {
        try {
          for await (const chunk of chunks) {
            expect(chunk).toEqual(new Uint8Array([1, 2]));
            throw primary;
          }
          return handle;
        } finally {
          cleaned = true;
        }
      }),
      { streamUrl: () => source },
    ).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await closeStarted.promise;
      await setImmediate();
      expect([cleaned, settled], 'MEDIA_DEINLINE_FOREIGN_FINITE').toEqual([true, true]);
      expect(await result).toEqual({ error: primary });
    } finally {
      held.release();
      await Promise.all([returned, result]);
    }
  });

  it('joins the native source even when the store never acquires the counted iterator', async () => {
    const held = gate(),
      closeStarted = gate();
    let settled = false,
      pulls = 0;
    const returned = held.promise.then(() => ({ done: true, value: undefined }) as const);
    const source = registerNativeMediaIterator<AsyncIterableIterator<Uint8Array>>({
      next: () => {
        pulls++;
        return Promise.resolve({ done: true, value: undefined });
      },
      return: () => {
        closeStarted.release();
        return returned;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    });
    const result = deInlineMedia(
      part,
      store(() => Promise.resolve(handle)),
      { streamUrl: () => source },
    ).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await closeStarted.promise;
      await setImmediate();
      expect(pulls).toBe(0);
      expect(settled, 'MEDIA_DEINLINE_UNPULLED_NATIVE_JOIN').toBe(false);
      held.release();
      expect(await result).toEqual({ error: new MediaAdmissionError('stream_incomplete') });
    } finally {
      held.release();
      await Promise.all([returned, result]);
    }
  });
});
