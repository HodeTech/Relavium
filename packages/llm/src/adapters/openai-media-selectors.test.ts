import { describe, expect, it, vi } from 'vitest';
import type { MediaGenRequest } from '../types.js';
import { createOpenAiAdapter } from './openai.js';

const key = 'offline-fixture-key';
const modalities = ['image', 'audio', 'video'] as const;
const selectors = [
  { namespace: 'root', field: 'output_format' },
  { namespace: 'root', field: 'response_format' },
  { namespace: 'modality', field: 'format' },
  { namespace: 'modality', field: 'output_format' },
  { namespace: 'modality', field: 'response_format' },
] as const;
const canonical = {
  image: { model: 'gpt-image-1', mimeType: 'image/png', format: 'png' },
  audio: { model: 'gpt-4o-mini-tts', mimeType: 'audio/opus', format: 'opus' },
  video: { model: 'sora-2', mimeType: 'video/mp4', format: 'mp4' },
} as const;

function request(modality: MediaGenRequest['modality']): MediaGenRequest {
  return {
    modality,
    model: canonical[modality].model,
    mimeType: canonical[modality].mimeType,
    prompt: 'synthetic fixture',
  };
}

function nativeOptions(
  modality: MediaGenRequest['modality'],
  selector: (typeof selectors)[number],
  value: unknown,
): Record<string, unknown> {
  return selector.namespace === 'root'
    ? { [selector.field]: value }
    : { [modality]: { [selector.field]: value } };
}

// Opaque response sentinels test selector lowering only; they are not media-publication evidence.
function syntheticResponse(modality: MediaGenRequest['modality']): Response {
  if (modality === 'audio')
    return new Response(new Uint8Array([1, 2]), {
      headers: { 'content-type': 'application/octet-stream' },
    });
  return new Response(
    JSON.stringify(
      modality === 'image'
        ? { data: [{ b64_json: 'AQI=' }] }
        : { id: 'synthetic-video-job', status: 'queued' },
    ),
    { headers: { 'content-type': 'application/json' } },
  );
}

describe.each(modalities)('OpenAI separate-endpoint %s output selectors', (modality) => {
  it.each(
    selectors.flatMap((selector) =>
      ['known', 'null', 'unknown'].map((valueKind) => ({ ...selector, valueKind })),
    ),
  )(
    'refuses $namespace.$field=$valueKind before invocation even with canonical MIME',
    async (selection) => {
      const { valueKind } = selection;
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(syntheticResponse(modality)),
      );
      const nativeInvocationStarted = vi.fn();
      const adapter = createOpenAiAdapter({ fetch });
      if (adapter.generateMedia === undefined) throw new Error('Expected media generator');
      const value =
        valueKind === 'known'
          ? canonical[modality].format
          : valueKind === 'null'
            ? null
            : 'private-unsupported-selector';
      await expect(
        adapter.generateMedia(
          {
            ...request(modality),
            providerOptions: nativeOptions(modality, selection, value),
          },
          key,
          { nativeInvocationStarted, retainWork: (factory) => factory() },
        ),
        'MEDIA_SEPARATE_SELECTOR_DEFINED_PREENTRY',
      ).rejects.toMatchObject({
        llmError: {
          kind: 'bad_request',
          message: 'Unsupported media output format',
          retryable: false,
        },
      });
      expect(fetch, 'MEDIA_SEPARATE_SELECTOR_DEFINED_PREENTRY').not.toHaveBeenCalled();
      // Supplementary only: this marker belongs to repaired calls, absent from successful generateMedia too.
      expect(
        nativeInvocationStarted,
        'MEDIA_SEPARATE_SELECTOR_DEFINED_PREENTRY',
      ).not.toHaveBeenCalled();
    },
  );
});

const supported = [
  { modality: 'image', model: 'gpt-image-1', mimeType: 'image/png', format: 'png' },
  { modality: 'image', model: 'gpt-image-1', mimeType: 'image/jpeg', format: 'jpeg' },
  { modality: 'image', model: 'gpt-image-1', mimeType: 'image/webp', format: 'webp' },
  { modality: 'audio', model: 'gpt-4o-mini-tts', mimeType: 'audio/mpeg', format: 'mp3' },
  { modality: 'audio', model: 'gpt-4o-mini-tts', mimeType: 'audio/opus', format: 'opus' },
  { modality: 'audio', model: 'gpt-4o-mini-tts', mimeType: 'audio/aac', format: 'aac' },
  { modality: 'audio', model: 'gpt-4o-mini-tts', mimeType: 'audio/flac', format: 'flac' },
  { modality: 'audio', model: 'gpt-4o-mini-tts', mimeType: 'audio/wav', format: 'wav' },
  { modality: 'audio', model: 'gpt-4o-mini-tts', mimeType: 'audio/L16', format: 'pcm' },
] as const;

describe.each(['absent', 'undefined'] as const)('OpenAI native selectors %s', (selection) => {
  it.each(supported)(
    'preserves canonical $mimeType lowering to $format',
    async ({ modality, model, mimeType, format }) => {
      const bodies: unknown[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected native JSON request');
        const body: unknown = JSON.parse(init.body);
        bodies.push(body);
        return Promise.resolve(syntheticResponse(modality));
      });
      const adapter = createOpenAiAdapter({ fetch });
      if (adapter.generateMedia === undefined) throw new Error('Expected media generator');
      const providerOptions =
        selection === 'absent'
          ? {}
          : {
              output_format: undefined,
              response_format: undefined,
              [modality]: {
                format: undefined,
                output_format: undefined,
                response_format: undefined,
              },
            };
      const result = await adapter.generateMedia(
        { model, modality, mimeType, prompt: 'synthetic fixture', providerOptions },
        key,
        { retainWork: (factory) => factory() },
      );
      expect(result.media?.mimeType, 'MEDIA_SEPARATE_SELECTOR_CANONICAL_WIRE').toBe(mimeType);
      expect(bodies, 'MEDIA_SEPARATE_SELECTOR_CANONICAL_WIRE').toEqual([
        modality === 'image'
          ? { model, prompt: 'synthetic fixture', output_format: format }
          : { model, input: 'synthetic fixture', voice: 'alloy', response_format: format },
      ]);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, '720x1280'] as const)(
    'preserves video MP4 default and size=%s',
    async (size) => {
      const posts: { url: string; method: string | undefined; body: unknown }[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
        const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        // The installed SDK probes local FormData support without a provider request.
        if (address.startsWith('data:')) return Promise.resolve(new Response());
        posts.push({
          url: address,
          method: init?.method,
          body: init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : null,
        });
        return Promise.resolve(syntheticResponse('video'));
      });
      const adapter = createOpenAiAdapter({ fetch });
      if (adapter.generateMedia === undefined) throw new Error('Expected media generator');
      const result = await adapter.generateMedia(
        {
          model: 'sora-2',
          modality: 'video',
          prompt: 'synthetic fixture',
          providerOptions: {
            ...(selection === 'absent'
              ? {}
              : { output_format: undefined, response_format: undefined }),
            video: {
              ...(size === undefined ? {} : { size }),
              ...(selection === 'absent'
                ? {}
                : { format: undefined, output_format: undefined, response_format: undefined }),
            },
            // A selector in an unrelated modality namespace has no authority on this request.
            audio: { format: 'opus' },
            image: { output_format: 'png' },
          },
        },
        key,
      );
      expect(result.jobId, 'MEDIA_SEPARATE_SELECTOR_VIDEO_DEFAULT').toEqual(expect.any(String));
      expect(posts, 'MEDIA_SEPARATE_SELECTOR_VIDEO_DEFAULT').toEqual([
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
});
