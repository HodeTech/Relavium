import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiAdapter } from './openai.js';
import { createGeminiAdapter } from './gemini.js';

afterEach(() => vi.unstubAllGlobals());
const key = 'offline-fixture-key';
const pcm = 'AQACAAMABAA=';
function chatResponse() {
  return new Response(
    JSON.stringify({
      id: 'offline',
      model: 'gpt-4o-audio-preview',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            audio: { data: pcm, id: 'audio', expires_at: 0, transcript: 'fixture' },
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

describe('ADR-0106 owned native output selection', () => {
  it.each([
    ['aac', 'audio/aac'],
    ['opus', 'audio/opus'],
    ['pcm16', 'audio/L16'],
  ] as const)(
    'MEDIA_NATIVE_SELECTOR_MIME: native-only %s uses the admitted wire selector',
    async (format, mimeType) => {
      let body: unknown;
      const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
        body = parseWire(init?.body);
        return Promise.resolve(chatResponse());
      });
      const adapter = createOpenAiAdapter({ fetch });
      const result = await adapter.generate(
        {
          model: 'gpt-4o-audio-preview',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
          providerOptions: { modalities: ['text', 'audio'], audio: { voice: 'alloy', format } },
        },
        key,
      );
      expect(body, 'MEDIA_NATIVE_SELECTOR_MIME').toMatchObject({
        modalities: ['text', 'audio'],
        audio: { format },
      });
      expect(result.content, 'MEDIA_NATIVE_SELECTOR_MIME').toContainEqual(
        expect.objectContaining({ type: 'media', mimeType }),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    'MEDIA_SELECTOR_PREENTRY: unsupported chat format refuses canonical=%s before SDK entry',
    async (canonical) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(chatResponse()));
      const adapter = createOpenAiAdapter({ fetch });
      const nativeInvocationStarted = vi.fn();
      const [result] = await Promise.allSettled([
        adapter.generate(
          {
            model: 'gpt-4o-audio-preview',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
            ...(canonical ? { outputModalities: ['text', 'audio'] } : {}),
            providerOptions: {
              modalities: ['audio'],
              audio: { format: 'secret-unsupported-sentinel' },
            },
          },
          key,
          { nativeInvocationStarted, retainWork: (factory) => factory() },
        ),
      ]);
      expect(result, 'MEDIA_SELECTOR_PREENTRY').toMatchObject({
        status: 'rejected',
        reason: { llmError: { kind: 'bad_request' } },
      });
      expect(fetch, 'MEDIA_SELECTOR_PREENTRY').toHaveBeenCalledTimes(0);
      expect(nativeInvocationStarted, 'MEDIA_SELECTOR_PREENTRY').toHaveBeenCalledTimes(0);
    },
  );

  it.each([
    { modality: 'audio', mimeType: 'audio/ogg' },
    { modality: 'image', mimeType: 'image/gif' },
    { modality: 'video', mimeType: 'video/webm' },
    { modality: 'audio', providerOptions: { response_format: 'unknown' } },
    { modality: 'image', providerOptions: { output_format: 'unknown' } },
  ] as const)('MEDIA_GENERATOR_PREENTRY: unsupported OpenAI selection %#', async (selection) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(chatResponse()));
    await expect(
      createOpenAiAdapter({ fetch }).generateMedia?.(
        { model: 'fixture', prompt: 'fixture', ...selection },
        key,
      ),
    ).rejects.toMatchObject({ llmError: { kind: 'bad_request' } });
    expect(fetch, 'MEDIA_GENERATOR_PREENTRY').toHaveBeenCalledTimes(0);
  });

  it.each(['format', 'output_format', 'response_format'] as const)(
    'MEDIA_VIDEO_SELECTOR_PREENTRY: unsupported native %s refuses before SDK entry',
    async (field) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 'synthetic-video-job', status: 'queued' }), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
      const nativeInvocationStarted = vi.fn();
      const adapter = createOpenAiAdapter({ fetch });
      if (adapter.generateMedia === undefined) throw new Error('Expected media generator');
      const [result] = await Promise.allSettled([
        adapter.generateMedia(
          {
            model: 'sora-2',
            modality: 'video',
            prompt: 'synthetic fixture',
            providerOptions: { video: { [field]: 'secret-unsupported-sentinel' } },
          },
          key,
          { nativeInvocationStarted, retainWork: (factory) => factory() },
        ),
      ]);
      expect(result, 'MEDIA_VIDEO_SELECTOR_PREENTRY').toMatchObject({
        status: 'rejected',
        reason: {
          llmError: { kind: 'bad_request', message: 'Unsupported media output format' },
        },
      });
      expect(fetch, 'MEDIA_VIDEO_SELECTOR_PREENTRY').toHaveBeenCalledTimes(0);
      expect(nativeInvocationStarted, 'MEDIA_VIDEO_SELECTOR_PREENTRY').toHaveBeenCalledTimes(0);
    },
  );

  it.each([undefined, '720x1280'] as const)(
    'MEDIA_VIDEO_SELECTOR_DEFAULT: unspecified format preserves native video size=%s',
    async (size) => {
      const posts: { url: string; method: string | undefined; body: unknown }[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
        // The installed SDK can probe local FormData support with a data URL.
        const nativeUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        if (nativeUrl.startsWith('data:')) return Promise.resolve(new Response());
        posts.push({
          url: nativeUrl,
          method: init?.method,
          body: init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : null,
        });
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'synthetic-video-job', status: 'queued' }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      });
      const adapter = createOpenAiAdapter({ fetch });
      if (adapter.generateMedia === undefined) throw new Error('Expected media generator');
      const result = await adapter.generateMedia(
        {
          model: 'sora-2',
          modality: 'video',
          prompt: 'synthetic fixture',
          ...(size === undefined ? {} : { providerOptions: { video: { size } } }),
        },
        key,
      );
      expect(result.jobId, 'MEDIA_VIDEO_SELECTOR_DEFAULT').toEqual(expect.any(String));
      expect(posts, 'MEDIA_VIDEO_SELECTOR_DEFAULT').toEqual([
        {
          url: 'https://api.openai.com/v1/videos',
          method: 'POST',
          body: {
            model: 'sora-2',
            prompt: 'synthetic fixture',
            seconds: '4',
            ...(size === undefined ? {} : { size }),
          },
        },
      ]);
    },
  );

  it('MEDIA_GEMINI_IMAGEN_SELECTOR: installed SDK lowers canonical MIME and refuses unsupported native MIME', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ predictions: [{ bytesBase64Encoded: 'AQI=', mimeType: 'image/jpeg' }] }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const adapter = createGeminiAdapter();
    await expect(
      adapter.generateMedia?.(
        {
          model: 'imagen-3.0-generate-002',
          modality: 'image',
          prompt: 'fixture',
          providerOptions: { outputMimeType: 'image/gif' },
        },
        key,
      ),
    ).rejects.toMatchObject({ llmError: { kind: 'bad_request' } });
    expect(fetch, 'MEDIA_GEMINI_IMAGEN_SELECTOR').toHaveBeenCalledTimes(0);
    await adapter.generateMedia?.(
      {
        model: 'imagen-3.0-generate-002',
        modality: 'image',
        prompt: 'fixture',
        mimeType: 'image/jpg',
        providerOptions: { outputMimeType: 'image/gif' },
      },
      key,
    );
    const body: unknown = parseWire(fetch.mock.calls[0]?.[1]?.body);
    expect(body, 'MEDIA_GEMINI_IMAGEN_SELECTOR').toMatchObject({
      parameters: { outputOptions: { mimeType: 'image/jpeg' } },
    });
    expect(fetch, 'MEDIA_GEMINI_IMAGEN_SELECTOR').toHaveBeenCalledTimes(1);
  });

  it.each([
    { modality: 'image', mimeType: 'image/gif' },
    { modality: 'video', mimeType: 'video/webm' },
    { modality: 'video', providerOptions: { outputMimeType: 'video/mp4' } },
  ] as const)(
    'MEDIA_GEMINI_GENERATOR_PREENTRY: unsupported explicit selection %# reaches no installed SDK fetch',
    async (selection) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.reject(new Error('Unexpected native entry')),
      );
      vi.stubGlobal('fetch', fetch);
      await expect(
        createGeminiAdapter().generateMedia?.(
          { model: 'fixture', prompt: 'fixture', ...selection },
          key,
        ),
      ).rejects.toMatchObject({ llmError: { kind: 'bad_request' } });
      expect(fetch, 'MEDIA_GEMINI_GENERATOR_PREENTRY').toHaveBeenCalledTimes(0);
    },
  );

  it('MEDIA_GEMINI_JSON_TEXT: application/json remains a text response selector', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              { content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await createGeminiAdapter().generate(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
        providerOptions: { responseMimeType: 'application/json' },
      },
      key,
    );
    expect(result.content).toEqual([{ type: 'text', text: '{}' }]);
    expect(parseWire(fetch.mock.calls[0]?.[1]?.body), 'MEDIA_GEMINI_JSON_TEXT').toMatchObject({
      generationConfig: { responseMimeType: 'application/json' },
    });
  });
});

function parseWire(body: unknown): unknown {
  if (typeof body !== 'string') throw new Error('Expected native JSON request body');
  return JSON.parse(body);
}
