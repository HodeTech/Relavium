import type { IncomingMessage, RequestOptions } from 'node:http';
import { expect, it, vi } from 'vitest';
import { fetchMediaBytes, streamMediaBytes, type MediaEgressDeps } from './media-egress.js';

const nativeLifetime = vi.hoisted(() => ({ requestClosed: false, responseClosed: false }));
vi.mock('node:http', async (original) => {
  const native = await original<typeof import('node:http')>();
  return {
    ...native,
    request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const request = native.request(options, (response) => {
        response.once('close', () => {
          nativeLifetime.responseClosed = true;
        });
        callback(response);
      });
      request.once('close', () => {
        nativeLifetime.requestClosed = true;
      });
      return request;
    },
  };
});

const aac = Uint8Array.from([255, 241, 80, 128, 1, 191, 252, 33, 16, 4, 96, 140, 28]);
const pcm = new Uint8Array([0, 0, 1, 0]);
function fixture(bytes: Uint8Array, header?: string) {
  const pull = vi.fn();
  const dispose = vi.fn();
  const returned = vi.fn();
  const deps: MediaEgressDeps = {
    resolveHost: () => Promise.resolve(['203.0.113.10']),
    openConnection: () =>
      Promise.resolve({
        status: 200,
        location: undefined,
        ...(header === undefined ? {} : { headers: { 'Content-Type': header } }),
        dispose,
        body: {
          async *[Symbol.asyncIterator]() {
            try {
              for (const byte of bytes) {
                pull();
                yield await Promise.resolve(new Uint8Array([byte]));
              }
            } finally {
              returned();
            }
          },
        },
      }),
  };
  return { deps, pull, dispose, returned };
}
it('MEDIA_HEADER_PREPULL: conflicting final type disposes before pulling body', async () => {
  const f = fixture(aac, 'image/png');
  const [result] = await Promise.allSettled([
    fetchMediaBytes(
      'https://media.example/fixture',
      { mimeType: 'audio/aac', maxBytes: 100 },
      f.deps,
    ),
  ]);
  expect(result, 'MEDIA_HEADER_PREPULL').toMatchObject({
    status: 'rejected',
    reason: { code: 'descriptor_conflict' },
  });
  expect(f.pull, 'MEDIA_HEADER_PREPULL').toHaveBeenCalledTimes(0);
  expect(f.dispose, 'MEDIA_HEADER_PREPULL').toHaveBeenCalled();
});
it.each([undefined, 'application/octet-stream', 'Audio/AAC; charset=binary'])(
  'MEDIA_BODY_EVIDENCE: fragmented ADTS admits header %s',
  async (header) => {
    const f = fixture(aac, header);
    expect(
      await fetchMediaBytes(
        'https://media.example/fixture',
        { mimeType: 'audio/aac', maxBytes: 100 },
        f.deps,
      ),
      'MEDIA_BODY_EVIDENCE',
    ).toEqual(aac);
    expect(f.returned).toHaveBeenCalledTimes(1);
  },
);
it.each([undefined, 'application/octet-stream', 'audio/wav'])(
  'MEDIA_PCM_HEADER_REQUIRED: PCM refuses insufficient header %s without pull',
  async (header) => {
    const f = fixture(pcm, header);
    const [result] = await Promise.allSettled([
      fetchMediaBytes(
        'https://media.example/fixture',
        { mimeType: 'audio/L16', maxBytes: 100 },
        f.deps,
      ),
    ]);
    expect(result, 'MEDIA_PCM_HEADER_REQUIRED').toMatchObject({
      status: 'rejected',
      reason: { code: 'descriptor_conflict' },
    });
    expect(f.pull, 'MEDIA_PCM_HEADER_REQUIRED').toHaveBeenCalledTimes(0);
  },
);
it('MEDIA_PCM_EXPLICIT: parameterized case-folded PCM header retains structural-only admission', async () => {
  const f = fixture(pcm, 'Audio/l16; rate=24000');
  expect(
    await fetchMediaBytes(
      'https://media.example/fixture',
      { mimeType: 'audio/L16', maxBytes: 100 },
      f.deps,
    ),
  ).toEqual(pcm);
});
it('MEDIA_BODY_FINISH: complete ADTS framing is required after a valid prefix', async () => {
  const f = fixture(aac.subarray(0, aac.length - 1), 'audio/aac');
  const [result] = await Promise.allSettled([
    fetchMediaBytes(
      'https://media.example/fixture',
      { mimeType: 'audio/aac', maxBytes: 100 },
      f.deps,
    ),
  ]);
  expect(result, 'MEDIA_BODY_FINISH').toMatchObject({
    status: 'rejected',
    reason: { code: 'invalid_format' },
  });
  expect(f.returned, 'MEDIA_BODY_FINISH').toHaveBeenCalledTimes(1);
});
it('MEDIA_SOURCE_ABANDON: consumer break closes an owned source', async () => {
  const f = fixture(aac, 'audio/aac');
  for await (const chunk of streamMediaBytes(
    'https://media.example/fixture',
    { mimeType: 'audio/aac', maxBytes: 100 },
    f.deps,
  )) {
    expect(chunk.length).toBeGreaterThan(0);
    break;
  }
  await Promise.resolve();
  expect(f.returned, 'MEDIA_SOURCE_ABANDON').toHaveBeenCalledTimes(1);
  expect(f.dispose).toHaveBeenCalled();
});

it('MEDIA_NATIVE_CLOSE_JOIN: consumer abandonment joins the real owned HTTP response close', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'audio/L16' });
    response.write(Buffer.from([0, 0]));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing fixture address');
  const stream = streamMediaBytes(`http://127.0.0.1:${address.port}/fixture`, {
    mimeType: 'audio/L16',
    maxBytes: 100,
    localEndpoint: { host: '127.0.0.1', port: address.port },
  });
  const iterator = stream[Symbol.asyncIterator]();
  try {
    expect((await iterator.next()).value).toEqual(Buffer.from([0, 0]));
    await iterator.return?.();
    expect(nativeLifetime, 'MEDIA_NATIVE_CLOSE_JOIN').toEqual({
      requestClosed: true,
      responseClosed: true,
    });
    expect(await iterator.next()).toMatchObject({ done: true });
  } finally {
    await iterator.return?.();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

it('MEDIA_HEADER_ALIAS: a reviewed WAV alias agrees with independently framed PCM WAV bytes', async () => {
  // RIFF size 38, WAVE PCM fmt(16), mono 8kHz/16bit, one two-byte sample.
  const wav = Uint8Array.from(
    Buffer.from(
      '524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000000',
      'hex',
    ),
  );
  const f = fixture(wav, 'Audio/X-Wav; arbitrary=parameter');
  expect(
    await fetchMediaBytes(
      'https://media.example/fixture',
      { mimeType: 'audio/wav', maxBytes: 100 },
      f.deps,
    ),
    'MEDIA_HEADER_ALIAS',
  ).toEqual(wav);
});
it('MEDIA_HEADER_BODY_CONFLICT: matching declared/header claims cannot relabel foreign bytes', async () => {
  const f = fixture(aac, 'image/png');
  await expect(
    fetchMediaBytes(
      'https://media.example/fixture',
      { mimeType: 'image/png', maxBytes: 100 },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: 'invalid_format' });
  expect(f.pull, 'MEDIA_HEADER_BODY_CONFLICT').toHaveBeenCalled();
  expect(f.dispose).toHaveBeenCalledTimes(1);
});

// Independent complete Ogg Opus pages: OpusHead, OpusTags, then EOS silence packet.
const opus = Uint8Array.from(
  Buffer.from(
    '4f6767530002000000000000000053455431000000002f8fa6e101134f707573486561640102000080bb00000000004f67675300000000000000000000534554310100000082f6e5de01104f7075735461677300000000000000004f6767530004c00300000000000053455431020000008eb19cdd0103f8fffe',
    'hex',
  ),
);
it.each([
  ['audio/opus', 'audio/ogg'],
  ['audio/ogg', 'audio/opus'],
])(
  'MEDIA_OGG_CODEC_AGREEMENT: declared %s and header %s agree only through verified Opus',
  async (mimeType, header) => {
    const valid = fixture(opus, header);
    expect(
      await fetchMediaBytes(
        'https://media.example/fixture',
        { mimeType, maxBytes: 200 },
        valid.deps,
      ),
      'MEDIA_OGG_CODEC_AGREEMENT',
    ).toEqual(opus);
    const truncated = fixture(opus.subarray(0, opus.length - 1), header);
    await expect(
      fetchMediaBytes('https://media.example/fixture', { mimeType, maxBytes: 200 }, truncated.deps),
      'MEDIA_OGG_CODEC_AGREEMENT',
    ).rejects.toMatchObject({ code: 'invalid_format' });
  },
);
