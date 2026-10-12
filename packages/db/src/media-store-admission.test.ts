import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { MAX_MEDIA_OBJECT_BYTES, MediaAdmissionError } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesystemMediaStore, InMemoryMediaStore } from './media-store.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-media-admission-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield await Promise.resolve(value);
}

// PCM is the approved structural-only arm: these are explicit aligned sample bytes, not
// fabricated image/container evidence. WAV below independently exercises real container identity.
function wav(size = 48): Uint8Array {
  const bytes = Buffer.alloc(size);
  bytes.write('RIFF');
  bytes.writeUInt32LE(size - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(size - 44, 40);
  return bytes;
}

// PNG 1x1 RGB scanline and ancillary padding, built from the PNG chunk grammar.
function png(size: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(type, 4);
    result.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const fixed = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(new Uint8Array([0, 0, 0, 0]))),
    chunk('IEND', new Uint8Array()),
  ];
  const padding = Buffer.alloc(
    size - fixed.reduce((count, value) => count + value.length, 0) - 12,
    65,
  );
  padding.write('Comment\0');
  fixed.splice(2, 0, chunk('tEXt', padding));
  return Buffer.concat(fixed);
}

describe.each(['memory', 'filesystem'] as const)('%s independent byte admission', (kind) => {
  const store = (): InMemoryMediaStore | FilesystemMediaStore =>
    kind === 'memory' ? new InMemoryMediaStore() : new FilesystemMediaStore(root);
  it('admits inline exact capacity and refuses +1 before format inspection', async () => {
    const target = store();
    const handle = await target.put(new Uint8Array(256 * 1024), 'audio/L16');
    expect((await target.get(handle)).length).toBe(256 * 1024);
    const [result] = await Promise.allSettled([
      target.put(new Uint8Array(256 * 1024 + 1), 'audio/L16'),
    ]);
    expect(result, 'MEDIA_STORE_INLINE_BOUND').toMatchObject({
      status: 'rejected',
      reason: { code: 'inline_limit' },
    });
    for (const mime of ['video/mp4', 'application/pdf'])
      await expect(target.put(new Uint8Array(2), mime)).rejects.toMatchObject({
        code: 'inline_limit',
      });
  });
  it('admits a structurally complete image at the exact inline limit and refuses +1', async () => {
    const target = store();
    const bytes = png(256 * 1024);
    const handle = await target.put(bytes, 'image/png');
    expect(
      await target.validateMedia(handle, { mimeType: 'image/png', modality: 'image' }),
    ).toMatchObject({ byteLength: bytes.length });
    const [result] = await Promise.allSettled([target.put(png(256 * 1024 + 1), 'image/png')]);
    expect(result, 'MEDIA_STORE_IMAGE_INLINE_BOUND').toMatchObject({
      status: 'rejected',
      reason: { code: 'inline_limit' },
    });
  });
  it('admits stream exact capacity separately from put and refuses cumulative +1', async () => {
    const target = store();
    const inline = vi.spyOn(target, 'put');
    const handle = await target.putStream(
      chunks(new Uint8Array(MAX_MEDIA_OBJECT_BYTES)),
      'audio/L16',
    );
    expect((await target.get(handle)).length).toBe(MAX_MEDIA_OBJECT_BYTES);
    expect(inline).not.toHaveBeenCalled();
    const [result] = await Promise.allSettled([
      target.putStream(
        chunks(new Uint8Array(MAX_MEDIA_OBJECT_BYTES), new Uint8Array(1)),
        'audio/L16',
      ),
    ]);
    expect(result, 'MEDIA_STORE_STREAM_BOUND').toMatchObject({
      status: 'rejected',
      reason: { code: 'object_limit' },
    });
    await expect(
      target.putStream(chunks(new Uint8Array(MAX_MEDIA_OBJECT_BYTES + 1)), 'audio/L16'),
    ).rejects.toMatchObject({ code: 'object_limit' });
  });
  it('refuses an oversized source chunk before allocating its owned copy', async () => {
    const target = store();
    const overflow = new Uint8Array(MAX_MEDIA_OBJECT_BYTES + 2);
    let excessCopies = 0;
    vi.stubGlobal(
      'Uint8Array',
      new Proxy(Uint8Array, {
        construct(constructor, args: unknown[]) {
          if (args[0] === overflow) excessCopies++;
          const result: unknown = Reflect.construct(constructor, args);
          if (!(result instanceof constructor))
            throw new Error('unexpected native constructor result');
          return result;
        },
      }),
    );
    const [result] = await Promise.allSettled([target.putStream(chunks(overflow), 'audio/L16')]);
    expect({ result, excessCopies }, 'MEDIA_STORE_STREAM_PRECOPY_BOUND').toMatchObject({
      result: { status: 'rejected', reason: { code: 'object_limit' } },
      excessCopies: 0,
    });
  });
  it('uses intrinsic byte counts even when caller typed-array getters lie', async () => {
    const target = store();
    const bytes = new Uint8Array(MAX_MEDIA_OBJECT_BYTES + 2);
    let getterCalls = 0;
    Object.defineProperty(bytes, 'byteLength', {
      get: () => {
        getterCalls++;
        return 2;
      },
    });
    Object.defineProperty(bytes, 'length', {
      get: () => {
        getterCalls++;
        return 2;
      },
    });
    const [streamed, inline] = await Promise.allSettled([
      target.putStream(chunks(bytes), 'audio/L16'),
      target.put(bytes, 'audio/L16'),
    ]);
    expect({ streamed, inline, getterCalls }, 'MEDIA_STORE_INTRINSIC_BYTE_BOUND').toMatchObject({
      streamed: { status: 'rejected', reason: { code: 'object_limit' } },
      inline: { status: 'rejected', reason: { code: 'inline_limit' } },
      getterCalls: 0,
    });
  });
  it('owns borrowed stream chunks and does not call inline put at finalization', async () => {
    const target = store();
    const mutable = new Uint8Array([1, 2]);
    const handle = await target.putStream(
      (async function* () {
        yield await Promise.resolve(mutable);
        mutable.fill(3);
        yield await Promise.resolve(mutable);
      })(),
      'audio/L16',
    );
    expect(await target.get(handle), 'MEDIA_STORE_OWNED_CHUNK').toEqual(
      new Uint8Array([1, 2, 3, 3]),
    );
  });
  it('requires finish and independent declared format evidence before publication', async () => {
    const target = store();
    const bytes = wav();
    const handle = await target.put(bytes, 'audio/x-wav');
    const metadata = await target.validateMedia(handle, {
      mimeType: 'audio/wav',
      modality: 'audio',
    });
    expect(metadata).toMatchObject({ handle, mimeType: 'audio/wav', byteLength: 48 });
    expect(Object.isFrozen(metadata)).toBe(true);
    const [result] = await Promise.allSettled([
      target.putStream(chunks(bytes.slice(0, -1)), 'audio/wav'),
    ]);
    expect(result, 'MEDIA_STORE_VERIFIER_FINISH').toMatchObject({
      status: 'rejected',
      reason: { code: 'invalid_format' },
    });
    const [wrongMime] = await Promise.allSettled([
      target.validateMedia(handle, { mimeType: 'image/png', modality: 'image' }),
    ]);
    expect(wrongMime, 'FS_CAUSAL_MEDIA_MEMORY_BYTE_VALIDATION').toMatchObject({
      status: 'rejected',
    });
    if (wrongMime.status === 'rejected')
      expect(wrongMime.reason, 'FS_CAUSAL_MEDIA_MEMORY_BYTE_VALIDATION').toBeInstanceOf(
        MediaAdmissionError,
      );
    await expect(
      target.validateMedia(handle, { mimeType: 'audio/wav', modality: 'audio', byteLength: 47 }),
    ).rejects.toMatchObject({ code: 'descriptor_conflict' });
    for (const durationMs of [0, -1, 1.5, Number.NaN])
      await expect(
        target.validateMedia(handle, { mimeType: 'audio/wav', modality: 'audio', durationMs }),
      ).rejects.toMatchObject({ code: 'invalid_descriptor' });
  });
  it('checks pre-abort and abort after awaiting resident delivery', async () => {
    const target = store();
    const handle = await target.put(wav(), 'audio/wav');
    const pre = new AbortController();
    pre.abort('private');
    const [result] = await Promise.allSettled([
      target.readRange(handle, { start: 0, end: 1 }, pre.signal),
    ]);
    expect(result, 'MEDIA_STORE_RANGE_PREABORT').toMatchObject({
      status: 'rejected',
      reason: { name: 'AbortError' },
    });
    const active = new AbortController();
    const pending = target.readRange(handle, { start: 0, end: 1 }, active.signal);
    active.abort();
    const [aborted] = await Promise.allSettled([pending]);
    expect(aborted, 'FS_CAUSAL_MEDIA_MEMORY_RANGE_SIGNAL').toMatchObject({
      status: 'rejected',
      reason: { name: 'AbortError' },
    });
  });
});

it('incremental validation never calls whole-object get and rescans changed files', async () => {
  const store = new FilesystemMediaStore(root);
  const bytes = wav();
  const handle = await store.put(bytes, 'audio/wav');
  const get = vi.spyOn(store, 'get');
  const descriptor = { mimeType: 'audio/wav', modality: 'audio' as const, durationMs: 1 };
  await expect(store.validateMedia(handle, descriptor)).resolves.toMatchObject({
    byteLength: bytes.length,
  });
  expect(get, 'MEDIA_STORE_INCREMENTAL_VALIDATION').not.toHaveBeenCalled();
  const digest = handle.slice('media://sha256-'.length);
  const path = join(root, digest.slice(0, 2), digest.slice(2));
  writeFileSync(path, wav(50));
  const [changed] = await Promise.allSettled([store.validateMedia(handle, descriptor)]);
  expect(changed, 'FS_CAUSAL_MEDIA_FS_BYTE_VALIDATION').toMatchObject({ status: 'rejected' });
  const reason: unknown = changed.status === 'rejected' ? changed.reason : undefined;
  expect(reason, 'FS_CAUSAL_MEDIA_FS_BYTE_VALIDATION').toBeInstanceOf(Error);
  if (reason instanceof Error)
    expect(reason.message, 'FS_CAUSAL_MEDIA_FS_BYTE_VALIDATION').toMatch(/content-address/);
});

it('retains unsupported and oversized legacy bytes, refusing even a tiny range', async () => {
  const bytes = new Uint8Array(MAX_MEDIA_OBJECT_BYTES + 2);
  const digest = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(join(root, digest.slice(0, 2)));
  const path = join(root, digest.slice(0, 2), digest.slice(2));
  writeFileSync(path, bytes);
  const store = new FilesystemMediaStore(root);
  const handle = 'media://sha256-' + digest;
  const [result] = await Promise.allSettled([store.readRange(handle, { start: 0, end: 0 })]);
  expect(result, 'MEDIA_STORE_FD_SIZE_BOUND').toMatchObject({
    status: 'rejected',
    reason: { code: 'object_limit' },
  });
  expect(statSync(path).size).toBe(bytes.length);
  expect((await store.listHandles()).map((item) => item.handle)).toEqual([handle]);
  expect(readdirSync(root)).toHaveLength(1);
});

it('memory stream collection handles bytewise fragmentation and empty chunks across owned blocks', async () => {
  const store = new InMemoryMediaStore();
  const expected = new Uint8Array(65538);
  expected.fill(7);
  const handle = await store.putStream(
    (async function* () {
      for (const byte of expected) {
        yield await Promise.resolve(new Uint8Array());
        yield new Uint8Array([byte]);
      }
    })(),
    'audio/L16',
  );
  expect(await store.get(handle)).toEqual(expected);
});
