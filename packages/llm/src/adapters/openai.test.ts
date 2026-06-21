import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { describe, expect, it } from 'vitest';

import { InvalidBaseUrlError, UnsupportedCapabilityError } from '../errors.js';
import { LlmProviderError } from '../llm-error.js';
import type {
  LlmProvider,
  LlmRequest,
  MediaGenRequest,
  MediaGenResult,
  StreamChunk,
} from '../types.js';
import {
  createOpenAiAdapter,
  deepseekAdapter,
  mapContent,
  mapStopReason,
  mapUsage,
  openaiAdapter,
  openaiErrorToLlmError,
  outputAudioMime,
} from './openai.js';

/** Call the adapter's optional `generateMedia` via `?.()` — a call (binds `this`), never an extraction, so the
 *  unbound-method lint stays happy; the `??` branch asserts the method is implemented. */
function genMedia(
  adapter: LlmProvider,
  req: MediaGenRequest,
  key: string,
): Promise<MediaGenResult> {
  return (
    adapter.generateMedia?.(req, key) ??
    Promise.reject(new Error('adapter implements no generateMedia'))
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  const raw = typeof init?.body === 'string' ? init.body : '{}';
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('expected a JSON object request body');
  }
  return parsed;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

const completion = (message: unknown, finishReason = 'stop'): string =>
  JSON.stringify({
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-5.5',
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const okResponse = (): Response =>
  new Response(completion({ role: 'assistant', content: 'ok', refusal: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Build an SSE Response from a list of chunk objects (shared across the streaming describes). */
const sse = (chunks: readonly unknown[]): Response =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

/** A single chat-completion stream chunk wrapping the given choices. */
const streamChunk = (choices: readonly unknown[]): Record<string, unknown> => ({
  id: 's',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'gpt-5.5',
  choices,
});

/** A one-choice stream chunk with the given delta + finish reason. */
const dchunk = (delta: unknown, finish: string | null = null): Record<string, unknown> => ({
  id: 's',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'gpt-5.5',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

describe('OpenAI-compatible adapter', () => {
  it('exposes openai + deepseek ids with their capability surfaces', () => {
    expect(openaiAdapter.id).toBe('openai');
    expect(deepseekAdapter.id).toBe('deepseek');
    // 1.AE: OpenAI wires image + audio media input and vision (the alias of media.input.image).
    // document stays false until handle resolution lands (1.AF — base64 document is blocked by the seam
    // ceiling). DeepSeek remains text-only (all-false media matrix, ADR-0031).
    expect(openaiAdapter.supports.vision).toBe(true);
    expect(openaiAdapter.supports.media).toEqual({
      input: { image: true, audio: true, video: false, document: false },
      outputCombinations: [['text'], ['text', 'audio']],
      surface: 'chat',
    });
    expect(openaiAdapter.supports.reasoning).toBe(false);
    expect(deepseekAdapter.supports.reasoning).toBe(true);
    expect(deepseekAdapter.supports.vision).toBe(false);
    expect(deepseekAdapter.supports.media.outputCombinations).toEqual([]);
  });

  it('rejects an unsupported media modality with a typed capability error (1.AE, ADR-0031)', async () => {
    // DeepSeek: all-false media matrix — every media part is rejected.
    const dsAdapter = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    const imageReq = {
      model: 'deepseek-reasoner',
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'media' as const,
              mimeType: 'image/png',
              source: { kind: 'base64' as const, data: 'aGVsbG8=' },
            },
          ],
        },
      ],
    };
    await expect(dsAdapter.generate(imageReq, 'k')).rejects.toThrowError(
      UnsupportedCapabilityError,
    );
    expect(() => dsAdapter.stream(imageReq, 'k')).toThrowError(UnsupportedCapabilityError);

    // OpenAI: video is unsupported → typed error (handle source: video ceiling=0 forbids inline).
    const oaiAdapter = createOpenAiAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    const videoReq = {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'media' as const,
              mimeType: 'video/mp4',
              source: { kind: 'handle' as const, ref: `media://sha256-${'f'.repeat(64)}` },
            },
          ],
        },
      ],
    };
    await expect(oaiAdapter.generate(videoReq, 'k')).rejects.toThrowError(
      UnsupportedCapabilityError,
    );
    expect(() => oaiAdapter.stream(videoReq, 'k')).toThrowError(UnsupportedCapabilityError);
  });

  it('lowers a supported media user message to image_url + input_audio (generate — the §1.AE textOf fix)', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
    });
    await adapter.generate(
      {
        model: 'gpt-5.5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe + transcribe' },
              {
                type: 'media',
                mimeType: 'image/png',
                source: { kind: 'base64', data: 'aW1hZ2U=' },
              },
              {
                type: 'media',
                mimeType: 'audio/mpeg',
                source: { kind: 'base64', data: 'YXVkaW8=' },
              },
            ],
          },
        ],
      },
      'k',
    );
    const messages = sent['messages'] as Record<string, unknown>[];
    const content = messages[0]?.['content'] as Record<string, unknown>[];
    expect(Array.isArray(content)).toBe(true); // unflattened to a content array, NOT a flat string
    expect(content).toContainEqual({ type: 'text', text: 'describe + transcribe' });
    expect(content).toContainEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
    });
    // audio/mpeg (the canonical MP3 MIME) → format 'mp3', NOT a silent 'wav' coercion (M4).
    expect(content).toContainEqual({
      type: 'input_audio',
      input_audio: { data: 'YXVkaW8=', format: 'mp3' },
    });
  });

  it('round-trips inline audio-out: lowers output_modalities → modalities+audio and parses the response (1.AG/ADR-0046)', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(
          new Response(
            completion({
              role: 'assistant',
              content: null,
              refusal: null,
              audio: {
                id: 'a1',
                data: 'YXVkaW8tYnl0ZXM=',
                transcript: 'spoken words',
                expires_at: 0,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    const result = await adapter.generate(
      {
        model: 'gpt-4o-audio-preview',
        outputModalities: ['text', 'audio'],
        providerOptions: { audio: { voice: 'verse', format: 'mp3' } },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'say hi' }] }],
      },
      'k',
    );
    // Request side: the node's audio output_modality lowers to modalities + the merged voice/format.
    expect(sent['modalities']).toEqual(['text', 'audio']);
    expect(sent['audio']).toEqual({ voice: 'verse', format: 'mp3' });
    // Response side: transcript surfaces as text PLUS the audio as an in-flight base64 media part (audio/mpeg).
    expect(result.content).toEqual([
      { type: 'text', text: 'spoken words' },
      {
        type: 'media',
        mimeType: 'audio/mpeg',
        source: { kind: 'base64', data: 'YXVkaW8tYnl0ZXM=' },
      },
    ]);
  });

  it('defaults the audio voice/format when providerOptions omits them', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
    });
    await adapter.generate(
      {
        model: 'gpt-4o-audio-preview',
        outputModalities: ['text', 'audio'],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'say hi' }] }],
      },
      'k',
    );
    expect(sent['modalities']).toEqual(['text', 'audio']);
    expect(sent['audio']).toEqual({ voice: 'alloy', format: 'wav' });
  });

  it('rejects a non-text outputModalities on the STREAM path — media-out is generate()-only (1.AG/ADR-0046)', () => {
    // The streaming media triad is host-deferred (ADR-0046 §4); the streaming fold drops media, so a stream()
    // requesting media output would silently lose it. The guard fails loud instead (never reaching egress).
    const adapter = createOpenAiAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    const req: LlmRequest = {
      model: 'gpt-4o-audio-preview',
      outputModalities: ['text', 'audio'],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'speak' }] }],
    };
    expect(() => adapter.stream(req, 'k')).toThrowError(UnsupportedCapabilityError);
  });

  it('generateMedia (image) returns a base64 PNG media part from images.generate (1.AG Section C/ADR-0045)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ created: 0, data: [{ b64_json: 'Z2VuLWltYWdl' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    const result = await genMedia(
      adapter,
      { model: 'gpt-image-1', prompt: 'a cat', modality: 'image' },
      'k',
    );
    expect(result.jobId).toBeUndefined(); // SYNC arm
    expect(result.media).toEqual({
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'base64', data: 'Z2VuLWltYWdl' },
    });
  });

  it('generateMedia (audio/TTS) base64-encodes audio.speech bytes into a media part + maps the format MIME (1.AH)', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        // audio.speech returns BINARY audio bytes; the replay string stands in for them.
        return Promise.resolve(
          new Response('FAKE-AUDIO-BYTES', {
            status: 200,
            headers: { 'content-type': 'audio/mpeg' },
          }),
        );
      },
    });
    const result = await genMedia(
      adapter,
      {
        model: 'gpt-4o-mini-tts',
        prompt: 'hello world',
        modality: 'audio',
        providerOptions: { audio: { voice: 'verse' } },
      },
      'k',
    );
    expect(result.jobId).toBeUndefined(); // SYNC arm
    expect(sent['input']).toBe('hello world');
    expect(sent['voice']).toBe('verse'); // from providerOptions.audio.voice
    expect(sent['response_format']).toBe('mp3'); // default when no req.mimeType
    expect(result.media?.mimeType).toBe('audio/mpeg');
    expect(result.media?.source).toEqual({
      kind: 'base64',
      data: Buffer.from('FAKE-AUDIO-BYTES').toString('base64'),
    });
  });

  it('generateMedia (audio) maps req.mimeType → response_format + result MIME (audio/opus → opus)', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(new Response('x', { status: 200 }));
      },
    });
    const result = await genMedia(
      adapter,
      { model: 'gpt-4o-mini-tts', prompt: 'hi', modality: 'audio', mimeType: 'audio/opus' },
      'k',
    );
    expect(sent['response_format']).toBe('opus');
    expect(result.media?.mimeType).toBe('audio/opus');
  });

  it('generateMedia rejects OpenAI video (no sync surface) + DeepSeek any modality with a typed capability error', async () => {
    const oai = createOpenAiAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      genMedia(oai, { model: 'sora-2', prompt: 'x', modality: 'video' }, 'k'),
    ).rejects.toThrowError(UnsupportedCapabilityError);
    const ds = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      genMedia(ds, { model: 'm', prompt: 'x', modality: 'image' }, 'k'),
    ).rejects.toThrowError(UnsupportedCapabilityError);
  });

  it('generateMedia maps a no-data image response to a typed bad_request LlmProviderError', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ created: 0, data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    await expect(
      genMedia(adapter, { model: 'gpt-image-1', prompt: 'x', modality: 'image' }, 'k'),
    ).rejects.toThrowError(LlmProviderError);
  });

  it('generateMedia rejects count > 1 (single-artifact SYNC seam) with a typed bad_request before any egress', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      genMedia(adapter, { model: 'gpt-image-1', prompt: 'x', modality: 'image', count: 3 }, 'k'),
    ).rejects.toMatchObject({ llmError: { kind: 'bad_request', retryable: false } });
  });

  it('generateMedia honors a requested output format (req.mimeType → output_format + result MIME)', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(
          new Response(JSON.stringify({ created: 0, data: [{ b64_json: 'aW1n' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    const result = await genMedia(
      adapter,
      { model: 'gpt-image-1', prompt: 'x', modality: 'image', mimeType: 'image/webp' },
      'k',
    );
    expect(sent['output_format']).toBe('webp');
    expect(result.media?.mimeType).toBe('image/webp');
  });

  it('generateMedia maps an image content-policy refusal to content_filter (the documented taxonomy)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'blocked', code: 'content_policy_violation' } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        ),
    });
    await expect(
      genMedia(adapter, { model: 'gpt-image-1', prompt: 'x', modality: 'image' }, 'k'),
    ).rejects.toMatchObject({ llmError: { kind: 'content_filter' } });
  });

  it('lowers media on the STREAM path too (shared buildCommonBody — the §1.AE both-paths requirement)', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
    });
    try {
      await collect(
        adapter.stream(
          {
            model: 'gpt-5.5',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'media',
                    mimeType: 'image/png',
                    source: { kind: 'base64', data: 'aW1hZ2U=' },
                  },
                ],
              },
            ],
          },
          'k',
        ),
      );
    } catch {
      // The request body is captured at fetch time; a non-SSE okResponse may end the stream early here.
    }
    expect(sent['stream']).toBe(true);
    const content = (sent['messages'] as Record<string, unknown>[])[0]?.['content'] as Record<
      string,
      unknown
    >[];
    expect(content).toContainEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
    });
  });

  it('rejects an unsupported audio subtype rather than mislabeling it as wav (audio/ogg — M4)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      adapter.generate(
        {
          model: 'gpt-5.5',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'media',
                  mimeType: 'audio/ogg',
                  source: { kind: 'base64', data: 'YXVkaW8=' },
                },
              ],
            },
          ],
        },
        'k',
      ),
    ).rejects.toThrow(/only mp3 and wav/);
  });

  it('gates document input off until 1.AF (a handle-source PDF is rejected, never sent as image_url — H3)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      adapter.generate(
        {
          model: 'gpt-5.5',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'media',
                  mimeType: 'application/pdf',
                  source: { kind: 'handle', ref: `media://sha256-${'a'.repeat(64)}` },
                },
              ],
            },
          ],
        },
        'k',
      ),
    ).rejects.toThrowError(UnsupportedCapabilityError);
  });

  it('rejects a url-source image rather than forwarding it to the provider (ADR-0031 §A7 — H1)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      adapter.generate(
        {
          model: 'gpt-5.5',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'media',
                  mimeType: 'image/png',
                  source: { kind: 'url', url: 'https://example.com/photo.png' },
                },
              ],
            },
          ],
        },
        'k',
      ),
    ).rejects.toThrow(/does not support url-source image input/);
  });

  it('rejects media on an assistant turn rather than silently dropping it via textOf (M2)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      adapter.generate(
        {
          model: 'gpt-5.5',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            {
              role: 'assistant',
              content: [
                {
                  type: 'media',
                  mimeType: 'image/png',
                  source: { kind: 'base64', data: 'aW1hZ2U=' },
                },
              ],
            },
          ],
        },
        'k',
      ),
    ).rejects.toThrow(/assistant-role media is not supported/);
  });

  it('maps finish reasons to the canonical enum (incl. graceful unknown → stop)', () => {
    expect(mapStopReason('stop')).toBe('stop');
    expect(mapStopReason('length')).toBe('length');
    expect(mapStopReason('tool_calls')).toBe('tool_use');
    expect(mapStopReason('function_call')).toBe('tool_use');
    expect(mapStopReason('content_filter')).toBe('content_filter');
    expect(mapStopReason(null)).toBe('stop');
    expect(mapStopReason(undefined)).toBe('stop');
    expect(mapStopReason('future_reason')).toBe('stop');
  });

  it('maps usage to NET, subtracting cache from gross prompt_tokens', () => {
    // OpenAI: prompt_tokens_details.cached_tokens
    expect(
      mapUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
      }),
    ).toEqual({ inputTokens: 70, outputTokens: 20, cacheReadTokens: 30 });
    // DeepSeek: top-level prompt_cache_hit_tokens
    expect(
      mapUsage({ prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 10 }),
    ).toEqual({
      inputTokens: 40,
      outputTokens: 5,
      cacheReadTokens: 10,
    });
    // No cache → no cacheReadTokens key; clamps at 0.
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(mapUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('mapContent keeps text + function tool_calls and skips custom (non-function) tool calls', () => {
    const parts = mapContent(
      {
        content: 'hi',
        tool_calls: [
          { id: 't1', function: { name: 'f', arguments: '{"a":1}' } },
          { id: 'c1' }, // a custom tool call (no function) — skipped
        ],
      },
      'openai',
    );
    expect(parts).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_call', id: 't1', name: 'f', args: { a: 1 } },
    ]);
  });

  it('mapContent treats empty tool arguments as {}', () => {
    const parts = mapContent(
      { content: null, tool_calls: [{ id: 't1', function: { name: 'f', arguments: '' } }] },
      'openai',
    );
    expect(parts).toEqual([{ type: 'tool_call', id: 't1', name: 'f', args: {} }]);
  });

  it('mapContent surfaces inline audio-out as a transcript text part PLUS a base64 media part (1.AG/ADR-0046)', () => {
    const parts = mapContent(
      { content: null, audio: { data: 'YXVkaW8tYnl0ZXM=', transcript: 'hello there' } },
      'openai',
      'audio/mpeg',
    );
    expect(parts).toEqual([
      { type: 'text', text: 'hello there' },
      {
        type: 'media',
        mimeType: 'audio/mpeg',
        source: { kind: 'base64', data: 'YXVkaW8tYnl0ZXM=' },
      },
    ]);
  });

  it('mapContent emits the audio media part even when the transcript is empty', () => {
    const parts = mapContent(
      { content: null, audio: { data: 'YXVkaW8=', transcript: '' } },
      'openai',
    );
    expect(parts).toEqual([
      { type: 'media', mimeType: 'audio/wav', source: { kind: 'base64', data: 'YXVkaW8=' } },
    ]);
  });

  it('mapContent ignores a null/empty audio field', () => {
    expect(mapContent({ content: 'x', audio: null }, 'openai')).toEqual([
      { type: 'text', text: 'x' },
    ]);
    expect(mapContent({ content: 'x', audio: { data: '', transcript: 't' } }, 'openai')).toEqual([
      { type: 'text', text: 'x' },
    ]);
  });

  it('outputAudioMime maps the requested providerOptions.audio.format (default wav)', () => {
    const mk = (format?: string): LlmRequest => ({
      model: 'gpt-4o-audio-preview',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'speak' }] }],
      ...(format === undefined ? {} : { providerOptions: { audio: { format } } }),
    });
    expect(outputAudioMime(mk('mp3'))).toBe('audio/mpeg');
    expect(outputAudioMime(mk('opus'))).toBe('audio/opus');
    expect(outputAudioMime(mk('flac'))).toBe('audio/flac');
    expect(outputAudioMime(mk('aac'))).toBe('audio/aac');
    expect(outputAudioMime(mk('pcm16'))).toBe('audio/L16');
    expect(outputAudioMime(mk('wav'))).toBe('audio/wav');
    expect(outputAudioMime(mk())).toBe('audio/wav'); // no providerOptions → default
    expect(outputAudioMime(mk('something-odd'))).toBe('audio/wav'); // unknown → default
  });
});

describe('openaiErrorToLlmError — classification', () => {
  it('classifies the connection/abort error classes', () => {
    expect(openaiErrorToLlmError(new APIUserAbortError(), 'openai')).toMatchObject({
      kind: 'cancelled',
      retryable: false,
      provider: 'openai',
    });
    expect(openaiErrorToLlmError(new APIConnectionTimeoutError(), 'openai')).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
    expect(
      openaiErrorToLlmError(new APIConnectionError({ message: 'down' }), 'deepseek'),
    ).toMatchObject({ kind: 'transport', retryable: true, provider: 'deepseek' });
  });

  it('classifies an APIError by HTTP status; status-less → unknown', () => {
    expect(
      openaiErrorToLlmError(new APIError(429, undefined, 'rate limited', undefined), 'openai'),
    ).toMatchObject({ kind: 'rate_limit', retryable: true, status: 429 });
    expect(
      openaiErrorToLlmError(new APIError(401, undefined, 'unauthorized', undefined), 'openai'),
    ).toMatchObject({ kind: 'auth', retryable: false, status: 401 });
    expect(
      openaiErrorToLlmError(new APIError(undefined, undefined, 'mystery', undefined), 'openai'),
    ).toMatchObject({ kind: 'unknown', retryable: false });
  });

  it('classifies a content-policy / moderation code as content_filter regardless of HTTP status (1.AG §6)', () => {
    const policy = new APIError(400, undefined, 'blocked', undefined);
    Object.assign(policy, { code: 'content_policy_violation' });
    expect(openaiErrorToLlmError(policy, 'openai')).toMatchObject({ kind: 'content_filter' });
    const moderation = new APIError(400, undefined, 'blocked', undefined);
    Object.assign(moderation, { code: 'moderation_blocked' });
    expect(openaiErrorToLlmError(moderation, 'openai')).toMatchObject({ kind: 'content_filter' });
  });

  it('falls back to unknown for a non-Error throwable', () => {
    expect(openaiErrorToLlmError('boom', 'openai')).toMatchObject({
      kind: 'unknown',
      retryable: false,
    });
  });
});

describe('OpenAI-compatible adapter — request building + secret safety', () => {
  it('prepends system, splits tool results, and maps tool_choice + tools onto the body', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      providerId: 'openai',
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
      maxRetries: 0,
    });
    await adapter.generate(
      {
        model: 'gpt-5.5',
        system: 'be terse',
        toolChoice: 'required',
        tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', id: 'c1', name: 'get_weather', args: { city: 'Paris' } },
            ],
          },
          {
            role: 'tool',
            content: [{ type: 'tool_result', toolCallId: 'c1', result: { tempC: 18 } }],
          },
        ],
      },
      'k',
    );
    const messages = sent['messages'] as Array<{
      role: string;
      content?: unknown;
      tool_calls?: unknown[];
      tool_call_id?: string;
    }>;
    expect(messages[0]).toMatchObject({ role: 'system', content: 'be terse' });
    expect(messages[1]).toMatchObject({ role: 'assistant' });
    expect((messages[1]?.tool_calls as Array<{ id: string }>)[0]).toMatchObject({
      id: 'c1',
      type: 'function',
    });
    expect(messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
      content: JSON.stringify({ tempC: 18 }),
    });
    expect(sent['tool_choice']).toBe('required');
    expect(sent['tools']).toMatchObject([{ type: 'function', function: { name: 'get_weather' } }]);
  });

  it('forwards temperature/stopSequences and lets providerOptions only ADD (mapped fields win)', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
      maxRetries: 0,
    });
    await adapter.generate(
      {
        model: 'gpt-5.5',
        temperature: 0.5,
        stopSequences: ['STOP'],
        providerOptions: { seed: 42, model: 'attacker-override' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
      'k',
    );
    expect(sent['temperature']).toBe(0.5);
    expect(sent['stop']).toEqual(['STOP']);
    expect(sent['seed']).toBe(42); // escape-hatch field reached the wire
    expect(sent['model']).toBe('gpt-5.5'); // mapped field wins over providerOptions
  });

  it('maps tool_choice {name} to a named function choice', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
      maxRetries: 0,
    });
    await adapter.generate(
      {
        model: 'gpt-5.5',
        toolChoice: { name: 'get_weather' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
      'k',
    );
    expect(sent['tool_choice']).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('never leaks the API key into the surfaced LlmError', async () => {
    // Built at runtime so no contiguous key-like literal sits in source (the llm-error.test.ts
    // convention); ≥16 chars after `sk-` so the key matches the real scrub pattern (a shorter toy
    // key would dodge the regex and prove nothing). The vendor error body ECHOES the planted key
    // (security-review.md: each adapter plants a secret in a vendor error), so the scrubSecrets
    // backstop must actually fire — not merely find a message the key never reached.
    const SECRET = ['sk-', 'SECRET-DO-NOT-LEAK-123'].join('');
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { message: `unauthorized: ${SECRET}`, type: 'invalid_request_error' },
            }),
            {
              status: 401,
              headers: { 'content-type': 'application/json' },
            },
          ),
        ),
      maxRetries: 0,
    });
    let caught: unknown;
    try {
      await adapter.generate(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
        SECRET,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProviderError);
    if (caught instanceof LlmProviderError) {
      expect(caught.llmError.kind).toBe('auth'); // the 401 classification path ran too
      expect(JSON.stringify(caught.llmError)).not.toContain('SECRET');
      // Positive proof the scrub fired (the echoed key reached the message and was masked).
      expect(caught.llmError.message).toContain('[REDACTED]');
    }
  });
});

describe('OpenAI-compatible adapter — stream edge cases', () => {
  const REQ = {
    model: 'gpt-5.5',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  };

  it('yields a single error chunk when the stream fails to start (429)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'rl', type: 'rate_limit_exceeded' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('error');
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('rate_limit');
    }
  });

  it('ignores a tool_calls delta with no id/name on first delta (defensive)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          sse([
            {
              id: 's',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt-5.5',
              // a fragment with no preceding id+name for index 0 — can't start a tool, skipped
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 's',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt-5.5',
              choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
            },
          ]),
        ),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.some((c) => c.type === 'tool_call_start')).toBe(false);
    expect(chunks.some((c) => c.type === 'tool_call_delta')).toBe(false);
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('stop');
  });

  it('threads an AbortSignal to the request options', async () => {
    let sawSignal = false;
    const adapter = createOpenAiAdapter({
      fetch: (_input, init) => {
        sawSignal = init?.signal instanceof AbortSignal;
        return Promise.resolve(okResponse());
      },
      maxRetries: 0,
    });
    const controller = new AbortController();
    await adapter.generate({ ...REQ, signal: controller.signal }, 'k');
    expect(sawSignal).toBe(true);
  });
});

describe('OpenAI-compatible adapter — additional fold + generate branches', () => {
  const REQ = {
    model: 'gpt-5.5',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  };

  it('emits a tool_call_delta when the first tool delta already carries arguments', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          sse([
            streamChunk([
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'f', arguments: '{"a":1}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ]),
            streamChunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
          ]),
        ),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    const start = chunks.find((c) => c.type === 'tool_call_start');
    const delta = chunks.find((c) => c.type === 'tool_call_delta');
    const end = chunks.find((c) => c.type === 'tool_call_end');
    expect(start).toMatchObject({ type: 'tool_call_start', id: 'call_1', name: 'f' });
    expect(delta).toMatchObject({
      type: 'tool_call_delta',
      id: 'call_1',
      argsJsonDelta: '{"a":1}',
    });
    expect(end).toMatchObject({ type: 'tool_call_end', id: 'call_1' });
  });

  it('folds a mid-stream error into an error chunk', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          sse([
            streamChunk([{ index: 0, delta: { content: 'partial' }, finish_reason: null }]),
            { error: { message: 'mid-stream failure', type: 'server_error', code: null } },
          ]),
        ),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('error');
  });

  it('generate tolerates an empty-choices completion (no content, zero usage)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'c',
              object: 'chat.completion',
              created: 0,
              model: 'gpt-5.5',
              choices: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      maxRetries: 0,
    });
    const result = await adapter.generate(REQ, 'k');
    expect(result.content).toEqual([]);
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('OpenAI-compatible adapter — reasoning + structured output (ADR-0030)', () => {
  const REQ = {
    model: 'deepseek-chat',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  };

  it('folds DeepSeek reasoning_content into reasoning_start/delta/end before the text', async () => {
    const adapter = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: () =>
        Promise.resolve(
          sse([
            dchunk({ role: 'assistant', reasoning_content: 'let me think' }),
            dchunk({ reasoning_content: ' more' }),
            dchunk({ content: 'answer' }, 'stop'),
          ]),
        ),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    const types = chunks.map((c) => c.type);
    expect(types.indexOf('reasoning_start')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('reasoning_end')).toBeLessThan(types.indexOf('text_delta')); // reasoning closes before text
    expect(chunks.filter((c) => c.type === 'reasoning_delta')).toHaveLength(2);
  });

  it('mapContent emits a reasoning part from reasoning_content', () => {
    const parts = mapContent({ content: 'answer', reasoning_content: 'because' }, 'deepseek');
    expect(parts[0]).toEqual({ type: 'reasoning', text: 'because' });
    expect(parts[1]).toEqual({ type: 'text', text: 'answer' });
  });

  it('DROPS a prior-turn reasoning part on egress — reasoning_content is output-only, replay would 400 (ADR-0030/0039)', async () => {
    // DeepSeek/Kimi `reasoning_content` is captured INBOUND (mapContent above) but is output-only: the API
    // rejects it if echoed back in an input message, and deepseek-reasoner does not require prior reasoning
    // to continue. So a same-provider continuation must NOT replay it. This pins the drop so a future change
    // cannot start round-tripping reasoning into the request body (which would 400 the whole turn).
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: (_i, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
      maxRetries: 0,
    });
    await adapter.generate(
      {
        model: 'deepseek-reasoner',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          // a prior assistant turn the engine replays: the ephemeral reasoning + the visible answer
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'internal chain of thought' },
              { type: 'text', text: 'the answer' },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'continue' }] },
        ],
      },
      'k',
    );
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null;
    const messages: readonly unknown[] = Array.isArray(sent['messages']) ? sent['messages'] : [];
    const assistant = messages.find(
      (m): m is Record<string, unknown> => isRecord(m) && m['role'] === 'assistant',
    );
    expect(assistant?.['content']).toBe('the answer'); // the visible text survives the replay…
    expect(JSON.stringify(sent)).not.toContain('internal chain of thought'); // …the reasoning never does
    expect(JSON.stringify(sent)).not.toContain('reasoning_content');
  });

  it('mapUsage surfaces reasoning_tokens as reasoningTokens', () => {
    expect(
      mapUsage({
        prompt_tokens: 10,
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 12 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, reasoningTokens: 12 });
  });

  it('mapUsage surfaces audio tokens as a mediaUnits entry (raw count, no seconds — 1.AF/ADR-0044)', () => {
    expect(
      mapUsage({
        prompt_tokens: 30,
        completion_tokens: 40,
        prompt_tokens_details: { audio_tokens: 7 },
        completion_tokens_details: { audio_tokens: 13 },
      }),
    ).toEqual({
      inputTokens: 30,
      outputTokens: 40,
      mediaUnits: [
        { modality: 'audio', direction: 'input', units: 7, unit: 'count' },
        { modality: 'audio', direction: 'output', units: 13, unit: 'count' },
      ],
    });
    // No audio tokens ⇒ no mediaUnits axis at all.
    expect(mapUsage({ prompt_tokens: 5, completion_tokens: 5 }).mediaUnits).toBeUndefined();
  });

  it('lowers responseFormat json to response_format json_schema', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_i, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
      maxRetries: 0,
    });
    await adapter.generate(
      {
        model: 'gpt-5.5',
        responseFormat: { type: 'json', schema: { type: 'object' }, name: 'out' },
        messages: REQ.messages,
      },
      'k',
    );
    expect(sent['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
    });
  });

  it('lowers responseFormat json to json_object for DeepSeek (json_schema 400s there)', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: (_i, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
      maxRetries: 0,
    });
    await adapter.generate(
      {
        model: 'deepseek-chat',
        responseFormat: { type: 'json', schema: { type: 'object' }, name: 'out' },
        messages: REQ.messages,
      },
      'k',
    );
    expect(sent['response_format']).toEqual({ type: 'json_object' });
  });
});

describe('OpenAI-compatible adapter — reasoning close edges', () => {
  const REQ = {
    model: 'deepseek-chat',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  };

  it('closes reasoning before a tool call', async () => {
    const adapter = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: () =>
        Promise.resolve(
          sse([
            dchunk({ reasoning_content: 'think' }),
            dchunk({
              tool_calls: [
                { index: 0, id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } },
              ],
            }),
            dchunk({}, 'tool_calls'),
          ]),
        ),
      maxRetries: 0,
    });
    const types = (await collect(adapter.stream(REQ, 'k'))).map((c) => c.type);
    expect(types.indexOf('reasoning_end')).toBeLessThan(types.indexOf('tool_call_start'));
  });

  it('closes reasoning at finish when no content follows', async () => {
    const adapter = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: () =>
        Promise.resolve(sse([dchunk({ reasoning_content: 'think' }), dchunk({}, 'stop')])),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.some((c) => c.type === 'reasoning_end')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('stop');
  });
});

describe('OpenAI-compatible adapter — robustness (review fixes)', () => {
  it('parseToolArgs degrades malformed tool arguments to {} (via mapContent)', () => {
    const parts = mapContent(
      {
        content: null,
        tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{not json' } }],
      },
      'openai',
    );
    expect(parts).toEqual([{ type: 'tool_call', id: 't1', name: 'f', args: {} }]);
  });

  it('sanitizes an invalid json_schema name to OpenAI rules', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = createOpenAiAdapter({
      fetch: (_i, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
      maxRetries: 0,
    });
    await adapter.generate(
      {
        model: 'gpt-5.5',
        responseFormat: { type: 'json', schema: { type: 'object' }, name: 'my schema!' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
      'k',
    );
    const rf = sent['response_format'] as { json_schema: { name: string } };
    expect(rf.json_schema.name).toBe('my_schema_'); // spaces/'!' → '_'
  });

  it('classifies an APIError code via firstNonEmptyString', () => {
    const err = new APIError(400, undefined, 'bad', undefined);
    Object.assign(err, { code: 'invalid_request' });
    expect(openaiErrorToLlmError(err, 'openai')).toMatchObject({
      kind: 'bad_request',
      code: 'invalid_request',
    });
  });
});

describe('OpenAI-compatible adapter — baseURL SSRF guard', () => {
  it('accepts a public HTTPS base URL', () => {
    expect(() => createOpenAiAdapter({ baseURL: 'https://api.openai.com/v1' })).not.toThrow();
  });

  it('rejects a non-HTTPS base URL', () => {
    const insecure = 'http://api.openai.com'; // NOSONAR — cleartext URL is the exact input under test
    expect(() => createOpenAiAdapter({ baseURL: insecure })).toThrow(InvalidBaseUrlError);
  });

  it('rejects the cloud-metadata link-local address', () => {
    expect(() => createOpenAiAdapter({ baseURL: 'https://169.254.169.254/latest' })).toThrow(
      InvalidBaseUrlError,
    );
  });

  it('rejects loopback and RFC-1918 private ranges', () => {
    for (const url of [
      'https://localhost:8080',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://192.168.1.1',
      'https://172.16.0.1',
      'https://172.31.255.255',
      'https://service.internal',
      'https://0.0.0.0',
    ]) {
      expect(() => createOpenAiAdapter({ baseURL: url })).toThrow(InvalidBaseUrlError);
    }
  });

  it('rejects evasions the URL parser normalizes (userinfo, decimal IP, trailing dot, IPv6)', () => {
    for (const url of [
      'https://evil.com@169.254.169.254/latest', // userinfo trick — real host is the metadata IP
      'https://2130706433/', // decimal-encoded 127.0.0.1
      'https://0x7f000001/', // hex-encoded 127.0.0.1
      'https://0177.0.0.1/', // octal-encoded 127.0.0.1
      'https://127.0.0.1./', // trailing-dot loopback
      'https://LOCALHOST/', // case-variant localhost
      'https://[::1]/', // IPv6 loopback
      'https://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6 loopback
      'https://[::ffff:169.254.169.254]/', // IPv4-mapped IPv6 → cloud metadata
      'https://[::ffff:10.0.0.1]/', // IPv4-mapped IPv6 → private 10/8
      'https://[::ffff:192.168.1.1]/', // IPv4-mapped IPv6 → private 192.168/16
      'https://[::ffff:172.16.0.1]/', // IPv4-mapped IPv6 → private 172.16/12
      'https://[64:ff9b::169.254.169.254]/', // NAT64 → cloud metadata
      'https://[fd00::1]/', // IPv6 unique-local
      'https://[fe80::1]/', // IPv6 link-local
      'https://0.0.0.0/', // unspecified 0.0.0.0/8
      'https://100.64.0.1/', // CGNAT 100.64.0.0/10
      'https://100.127.255.255/', // CGNAT upper bound
    ]) {
      expect(() => createOpenAiAdapter({ baseURL: url })).toThrow(InvalidBaseUrlError);
    }
  });

  it('redacts embedded credentials from InvalidBaseUrlError — never leaks user:pass into the error', () => {
    // A base URL with userinfo + a blocked host: neither the credentials, the path, nor the query may
    // appear in the thrown error or its `.url` field (security-review.md §Network/outbound URLs).
    let caught: InvalidBaseUrlError | undefined;
    try {
      createOpenAiAdapter({ baseURL: 'https://leakuser:s3cr3tpass@127.0.0.1/v1?token=leaktoken' });
    } catch (err) {
      caught = err instanceof InvalidBaseUrlError ? err : undefined;
    }
    expect(caught).toBeInstanceOf(InvalidBaseUrlError);
    for (const secret of ['leakuser', 's3cr3tpass', 'leaktoken', '@']) {
      expect(caught?.message).not.toContain(secret);
      expect(caught?.url).not.toContain(secret);
    }
    expect(caught?.url).toBe('https://127.0.0.1'); // only the credential-free scheme+host summary survives
  });

  it('accepts an uppercase HTTPS scheme (normalized) and a public host', () => {
    expect(() => createOpenAiAdapter({ baseURL: 'HTTPS://API.OPENAI.COM/v1' })).not.toThrow();
  });

  it('does not reject the safe public 172.x range outside 16–31', () => {
    expect(() => createOpenAiAdapter({ baseURL: 'https://172.32.0.1' })).not.toThrow();
  });

  it('does not validate the built-in DeepSeek default (no caller baseURL)', () => {
    expect(() => createOpenAiAdapter({ providerId: 'deepseek' })).not.toThrow();
  });
});

describe('OpenAI-compatible adapter — truncation + refusal normalization', () => {
  const REQ = {
    model: 'gpt-5.5',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  };

  it('emits a transport error (not a clean stop) when a stream ends without finish_reason', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () => Promise.resolve(sse([dchunk({ content: 'partial' }, null)])),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    const last = chunks.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') {
      expect(last.error.kind).toBe('transport');
      expect(last.error.retryable).toBe(true);
    }
  });

  it('normalizes a streamed refusal to a content_filter stop', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          sse([dchunk({ role: 'assistant', refusal: "I can't help with that" }, 'stop')]),
        ),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    const stop = chunks.at(-1);
    expect(stop?.type).toBe('stop');
    if (stop?.type === 'stop') {
      expect(stop.stopReason).toBe('content_filter');
    }
  });

  it('drops an empty-string content delta (no zero-length text_delta)', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(sse([dchunk({ content: '' }), dchunk({ content: 'real' }, 'stop')])),
      maxRetries: 0,
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    const textDeltas = chunks.filter((c) => c.type === 'text_delta');
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0]).toMatchObject({ text: 'real' });
  });

  it('normalizes a non-streaming refusal to a content_filter stop', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'c',
              object: 'chat.completion',
              created: 0,
              model: 'gpt-5.5',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: null, refusal: "I won't do that" },
                  finish_reason: 'stop',
                  logprobs: null,
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      maxRetries: 0,
    });
    const result = await adapter.generate(REQ, 'k');
    expect(result.content).toEqual([]);
    expect(result.stopReason).toBe('content_filter');
  });
});
