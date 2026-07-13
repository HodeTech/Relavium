import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { describe, expect, it } from 'vitest';

import type { AbortSignalLike, ReasoningEffort } from '@relavium/shared';

import { InvalidBaseUrlError, UnsupportedCapabilityError } from '../errors.js';
import { LlmProviderError } from '../llm-error.js';
import {
  MediaGenResultSchema,
  MediaJobStatusSchema,
  type LlmProvider,
  type LlmRequest,
  type MediaGenRequest,
  type MediaGenResult,
  type MediaJobStatus,
  type StreamChunk,
} from '../types.js';
import { encodeMediaJobId } from './shared.js';
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

/** Call the adapter's optional `pollMediaJob` via `?.()` (same unbound-method-safe pattern as genMedia). */
function pollMedia(
  adapter: LlmProvider,
  jobId: string,
  key: string,
  signal?: AbortSignalLike,
): Promise<MediaJobStatus> {
  return (
    adapter.pollMediaJob?.(jobId, key, signal) ??
    Promise.reject(new Error('adapter implements no pollMediaJob'))
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

  it('an UNKNOWN model gets NO reasoning field — on the OpenAI arm AND the DeepSeek arm', async () => {
    // Found by an adversarial review. Fixing Gemini and Anthropic left these two sending the field unconditionally:
    // an unknown model (a custom `base_url`, or one so new we have no metadata) was handed `reasoning_effort` /
    // `thinking` regardless. The host's gate already withholds — but `@relavium/llm` is a public SEAM, and it must
    // not depend on a caller having run the gate. Guessing at a model we cannot describe is the whole bug class.
    let sent: Record<string, unknown> = {};
    const capture = (): Response => {
      return okResponse();
    };
    const oai = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(capture());
      },
    });
    const deepseek = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(capture());
      },
    });
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }];

    for (const tier of ['off', 'low', 'high', 'max'] as const) {
      await oai.generate(
        { model: 'some-custom-endpoint-model', messages, reasoningEffort: tier },
        'k',
      );
      expect('reasoning_effort' in sent, `openai ${tier}`).toBe(false);

      await deepseek.generate(
        { model: 'some-custom-endpoint-model', messages, reasoningEffort: tier },
        'k',
      );
      expect('thinking' in sent, `deepseek ${tier}`).toBe(false);
    }

    // …and a model the catalog DOES know still gets it, so the guard is a filter and not a mute button.
    await oai.generate({ model: 'gpt-5.5', messages, reasoningEffort: 'high' }, 'k');
    expect(sent['reasoning_effort']).toBe('high');
  });

  it('THE DIALECT: official OpenAI gets `max_completion_tokens`; DeepSeek and a custom base_url keep `max_tokens`', async () => {
    // ADR-0071 §10a. OpenAI's official Chat Completions deprecated `max_tokens`, and its REASONING models reject it
    // outright — the second half of the maintainer's "max tokens errors". But this same adapter serves every custom
    // OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, LiteLLM, a gateway), most of which implement only the
    // legacy field. Switching globally would trade one broken population for another, so the rule is by ENDPOINT.
    let sent: Record<string, unknown> = {};
    const capture = (init: RequestInit | undefined): Response => {
      sent = parseJsonBody(init);
      return okResponse();
    };
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }];

    const official = createOpenAiAdapter({
      fetch: (_i, init) => Promise.resolve(capture(init)),
    });
    await official.generate({ model: 'gpt-5.5', messages, maxTokens: 100 }, 'k');
    expect(sent['max_completion_tokens']).toBe(100);
    expect('max_tokens' in sent).toBe(false); // the deprecated field must NOT ride alongside it

    // DeepSeek's own API is OFFICIAL — it is our default base URL, not a caller's override — and it takes the
    // legacy field. `official` is not a synonym for `openai`.
    const deepseek = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: (_i, init) => Promise.resolve(capture(init)),
    });
    await deepseek.generate({ model: 'deepseek-chat', messages, maxTokens: 100 }, 'k');
    expect(sent['max_tokens']).toBe(100);
    expect('max_completion_tokens' in sent).toBe(false);

    // A custom `base_url` under the `openai` provider id keeps the legacy field too — this is the D3 population
    // that a global switch would have broken.
    const custom = createOpenAiAdapter({
      baseURL: 'https://gateway.example.com/v1',
      fetch: (_i, init) => Promise.resolve(capture(init)),
    });
    await custom.generate({ model: 'gpt-5.5', messages, maxTokens: 100 }, 'k');
    expect(sent['max_tokens']).toBe(100);
    expect('max_completion_tokens' in sent).toBe(false);
  });

  it('CLAMPS an over-ceiling cap on an official endpoint — and leaves a custom endpoint alone', async () => {
    let sent: Record<string, unknown> = {};
    const capture = (init: RequestInit | undefined): Response => {
      sent = parseJsonBody(init);
      return okResponse();
    };
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }];

    // gpt-5.4-pro's ceiling is 128_000. An authored 200_000 is a 400 on every turn, not an ambitious request.
    const official = createOpenAiAdapter({
      fetch: (_i, init) => Promise.resolve(capture(init)),
    });
    await official.generate({ model: 'gpt-5.4-pro', messages, maxTokens: 200_000 }, 'k');
    expect(sent['max_completion_tokens']).toBe(128_000);

    // …but a custom endpoint may serve a different model under that id, with its own limits. We do not silently
    // lower a number the user typed on a model we cannot describe.
    const custom = createOpenAiAdapter({
      baseURL: 'https://gateway.example.com/v1',
      fetch: (_i, init) => Promise.resolve(capture(init)),
    });
    await custom.generate({ model: 'gpt-5.4-pro', messages, maxTokens: 200_000 }, 'k');
    expect(sent['max_tokens']).toBe(200_000);
  });

  it('NEVER sends BOTH cap fields — a providerOptions `max_tokens` cannot ride alongside the mapped one', async () => {
    // A REGRESSION the dialect rule introduced, caught by review. The escape-hatch merge is `{...providerOptions,
    // ...body}`, and `body` winning was automatic only while the mapped key and the escape-hatch key were the SAME
    // STRING. Renaming the mapped key on the official endpoint meant the old one no longer shadowed anything — so
    // both went out, and OpenAI rejects a request carrying both. A 400 on exactly the population §10a rescues.
    let sent: Record<string, unknown> = {};
    const oai = createOpenAiAdapter({
      fetch: (_i, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
    });
    await oai.generate(
      {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        maxTokens: 100,
        providerOptions: { max_tokens: 999 }, // the stale key the caller might still be carrying
      },
      'k',
    );
    expect(sent['max_completion_tokens']).toBe(100); // the mapped cap wins outright…
    expect('max_tokens' in sent).toBe(false); // …and the colliding key is GONE, not merely outranked
  });

  it('an escape-hatch cap with NO mapped cap still stands — the §10a override for an exotic gateway', async () => {
    // The gateway that speaks OpenAI's protocol but wants the modern field has no config key to ask with. It asks
    // through `providerOptions`, and that only works if we leave an un-mapped cap alone.
    let sent: Record<string, unknown> = {};
    const custom = createOpenAiAdapter({
      baseURL: 'https://gateway.example.com/v1',
      fetch: (_i, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
    });
    await custom.generate(
      {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        providerOptions: { max_completion_tokens: 256 }, // no req.maxTokens — theirs is the only cap
      },
      'k',
    );
    expect(sent['max_completion_tokens']).toBe(256);
    expect('max_tokens' in sent).toBe(false);
  });

  it("OpenAI's OWN url spelled out by hand is OFFICIAL — a trailing slash must not restore the bug", async () => {
    // The CLI stores a `--base-url` VERBATIM, so `https://api.openai.com/v1/` and `https://api.openai.com/v1` are
    // different strings. Classifying by "was a string passed" made the first one CUSTOM: deprecated field, no
    // clamp — the original bug, restored on the official endpoint by a typo. We classify by HOST.
    let sent: Record<string, unknown> = {};
    for (const url of [
      'https://api.openai.com/v1/', // a trailing slash
      'https://api.openai.com/v1',
      'https://api.openai.com', // no /v1 at all
      'https://API.OpenAI.com/v1', // host case is not significant
      'https://api.openai.com./v1', // a trailing-dot FQDN — DNS says this is the same host, and so do we
    ]) {
      const oai = createOpenAiAdapter({
        baseURL: url,
        fetch: (_i, init) => {
          sent = parseJsonBody(init);
          return Promise.resolve(okResponse());
        },
      });
      await oai.generate(
        {
          model: 'gpt-5.4-pro',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
          maxTokens: 200_000,
        },
        'k',
      );
      expect(sent['max_completion_tokens'], url).toBe(128_000); // the modern field AND the clamp
      expect('max_tokens' in sent, url).toBe(false);
    }
  });

  it('a LOOKALIKE host is NOT official — the classification must never slide the other way', async () => {
    // The dangerous direction. Misreading a gateway as official would send it the modern field AND clamp its cap
    // against a catalog that does not describe what it serves.
    let sent: Record<string, unknown> = {};
    for (const url of [
      'https://evil.api.openai.com.attacker.net/v1', // the official host as a SUBDOMAIN of someone else's
      'https://api.openai.com.evil.com/v1', // …and as a prefix
      'https://api-openai.com/v1', // a hyphen away
    ]) {
      const impostor = createOpenAiAdapter({
        baseURL: url,
        fetch: (_i, init) => {
          sent = parseJsonBody(init);
          return Promise.resolve(okResponse());
        },
      });
      await impostor.generate(
        {
          model: 'gpt-5.4-pro',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
          maxTokens: 200_000,
        },
        'k',
      );
      expect(sent['max_tokens'], url).toBe(200_000); // legacy field, NOT clamped — it is not OpenAI
      expect('max_completion_tokens' in sent, url).toBe(false);
    }
  });

  it('an EMPTY descriptor gets NO reasoning field either — `deepseek-reasoner` reasons, but publishes no knob', async () => {
    // The second adversarial review found this: the DeepSeek arm gated on `catalogModel(m)?.reasoning !== undefined`
    // and then sent `thinking` UNCONDITIONALLY. `deepseek-reasoner`'s descriptor is `{}` — not `undefined` — so the
    // gate opened, and every tier (including `off` → `thinking: {type:'disabled'}`) went on the wire for a model
    // whose controllable tiers upstream declined to describe. `acceptedTiers` returns the empty set for `{}`, which
    // is exactly what the picker already showed the user; the wire now agrees with it.
    let sent: Record<string, unknown> = {};
    const deepseek = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
    });
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }];

    for (const tier of ['off', 'low', 'medium', 'high', 'max'] as const) {
      await deepseek.generate({ model: 'deepseek-reasoner', messages, reasoningEffort: tier }, 'k');
      expect('thinking' in sent, `deepseek-reasoner ${tier}`).toBe(false);
    }
  });

  it('a tier OUTSIDE the published ladder is withheld — `gpt-5.4-pro` rejects both `low` and `off`', async () => {
    // MEMBERSHIP, not presence. The arm used to test that an effort axis existed and then send its own tier name.
    let sent: Record<string, unknown> = {};
    const oai = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
    });
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }];

    for (const tier of ['low', 'off'] as const) {
      await oai.generate({ model: 'gpt-5.4-pro', messages, reasoningEffort: tier }, 'k');
      expect('reasoning_effort' in sent, `gpt-5.4-pro ${tier}`).toBe(false);
    }
    // …but a tier it DOES publish rides.
    await oai.generate({ model: 'gpt-5.4-pro', messages, reasoningEffort: 'high' }, 'k');
    expect(sent['reasoning_effort']).toBe('high');
  });

  it('maps the reasoning-effort tier per provider: OpenAI reasoning_effort (max→xhigh, off→none) + DeepSeek thinking (ADR-0066)', async () => {
    let sent: Record<string, unknown> = {};
    const oai = createOpenAiAdapter({
      fetch: (_input, init) => {
        sent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
    });
    const base = {
      model: 'gpt-5.5',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
    };
    // All FIVE tiers, so a valid-but-wrong within-domain swap on any row is caught (medium is the picker default).
    await oai.generate({ ...base, reasoningEffort: 'low' }, 'k');
    expect(sent['reasoning_effort']).toBe('low');
    await oai.generate({ ...base, reasoningEffort: 'medium' }, 'k');
    expect(sent['reasoning_effort']).toBe('medium');
    await oai.generate({ ...base, reasoningEffort: 'high' }, 'k');
    expect(sent['reasoning_effort']).toBe('high');
    await oai.generate({ ...base, reasoningEffort: 'max' }, 'k');
    expect(sent['reasoning_effort']).toBe('xhigh'); // `max` → the provider's HIGHEST tier
    await oai.generate({ ...base, reasoningEffort: 'off' }, 'k');
    expect(sent['reasoning_effort']).toBe('none');
    await oai.generate({ ...base }, 'k'); // unset ⇒ omitted (provider default, unchanged behavior)
    expect('reasoning_effort' in sent).toBe(false);

    // DeepSeek (the other id this shared adapter serves) controls thinking via a `thinking` OBJECT, not the OpenAI
    // `reasoning_effort` key (ADR-0066): off→disabled; DeepSeek has only two graded levels, so low/medium/high→high
    // and max→max; unset ⇒ omitted.
    let dsSent: Record<string, unknown> = {};
    const ds = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: (_input, init) => {
        dsSent = parseJsonBody(init);
        return Promise.resolve(okResponse());
      },
    });
    const dsReq = (effort?: ReasoningEffort): Parameters<typeof ds.generate>[0] => ({
      model: 'deepseek-v4-flash',
      messages: base.messages,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
    await ds.generate(dsReq('high'), 'k');
    expect('reasoning_effort' in dsSent).toBe(false); // never the OpenAI key
    expect(dsSent['thinking']).toEqual({ type: 'enabled', reasoning_effort: 'high' });
    await ds.generate(dsReq('off'), 'k');
    expect(dsSent['thinking']).toEqual({ type: 'disabled' }); // off DISABLES thinking
    await ds.generate(dsReq('max'), 'k');
    expect(dsSent['thinking']).toEqual({ type: 'enabled', reasoning_effort: 'max' }); // top graded level
    await ds.generate(dsReq('low'), 'k');
    expect(dsSent['thinking']).toEqual({ type: 'enabled', reasoning_effort: 'high' }); // coarsened to high
    await ds.generate(dsReq(), 'k'); // unset ⇒ omitted (provider default)
    expect('thinking' in dsSent).toBe(false);

    // The streaming path spreads the SAME buildCommonBody, so the `thinking` control must reach the wire there too.
    let dsStreamSent: Record<string, unknown> = {};
    const dsStream = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: (_input, init) => {
        dsStreamSent = parseJsonBody(init);
        return Promise.resolve(
          sse([
            {
              id: 's',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'deepseek-v4-flash',
              choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
            },
          ]),
        );
      },
      maxRetries: 0,
    });
    await collect(dsStream.stream(dsReq('max'), 'k'));
    expect(dsStreamSent['thinking']).toEqual({ type: 'enabled', reasoning_effort: 'max' });
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
    // I3 structural guard: `raw` carries ONLY a non-byte diagnostic — never the audio bytes.
    expect(result.raw).toEqual({ responseFormat: 'mp3' });
  });

  it('generateMedia (audio) routes a TTS-call failure through the classifier (the catch is wired, not raw)', async () => {
    // Prove the try/catch around `audio.speech.create` + the body read routes ANY thrown provider
    // error through `openaiErrorToLlmError` — a rejected request surfaces as a typed `LlmProviderError`,
    // never a raw SDK error. A connection failure classifies as `transport` (retryable).
    const adapter = createOpenAiAdapter({
      maxRetries: 0,
      fetch: () => Promise.reject(new APIConnectionError({ message: 'socket hang up' })),
    });
    await expect(
      genMedia(adapter, { model: 'gpt-4o-mini-tts', prompt: 'x', modality: 'audio' }, 'k'),
    ).rejects.toMatchObject({ llmError: { kind: 'transport', retryable: true } });
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

  it('generateMedia (audio) maps an empty audio body to a typed bad_request LlmProviderError', async () => {
    const adapter = createOpenAiAdapter({
      fetch: () => Promise.resolve(new Response('', { status: 200 })),
    });
    await expect(
      genMedia(adapter, { model: 'gpt-4o-mini-tts', prompt: 'x', modality: 'audio' }, 'k'),
    ).rejects.toMatchObject({ llmError: { kind: 'bad_request', retryable: false } });
  });

  it('generateMedia rejects DeepSeek any modality with a typed capability error (OpenAI video is the async Sora arm — tested separately)', async () => {
    const ds = createOpenAiAdapter({
      providerId: 'deepseek',
      fetch: () => Promise.reject(new Error('must fail fast before any egress')),
    });
    await expect(
      genMedia(ds, { model: 'm', prompt: 'x', modality: 'image' }, 'k'),
    ).rejects.toThrowError(UnsupportedCapabilityError);
    await expect(
      genMedia(ds, { model: 'm', prompt: 'x', modality: 'video' }, 'k'),
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

  it('generateMedia (image) forwards valid size/quality knobs from providerOptions.image; drops invalid (1.AH A6)', async () => {
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
    await genMedia(
      adapter,
      {
        model: 'gpt-image-1',
        prompt: 'x',
        modality: 'image',
        providerOptions: { image: { size: '1536x1024', quality: 'high', bogus: 'x' } },
      },
      'k',
    );
    expect(sent['size']).toBe('1536x1024');
    expect(sent['quality']).toBe('high');
    expect(sent['bogus']).toBeUndefined(); // only the recognized knobs are forwarded (no spread)
  });

  it('generateMedia (image) drops an unrecognized size/quality (no 400-inducing passthrough)', async () => {
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
    await genMedia(
      adapter,
      {
        model: 'gpt-image-1',
        prompt: 'x',
        modality: 'image',
        providerOptions: { image: { size: '99x99', quality: 'ultra' } },
      },
      'k',
    );
    expect(sent['size']).toBeUndefined();
    expect(sent['quality']).toBeUndefined();
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
    // A NATIVE abort (DOMException/Error named 'AbortError') from a binary body read (TTS/Sora
    // arrayBuffer) bypasses APIUserAbortError → must still classify as cancelled, not unknown.
    expect(
      openaiErrorToLlmError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'openai'),
    ).toMatchObject({ kind: 'cancelled', retryable: false });
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

  it("EXACT-redacts the resolved key from an echoed error body (a custom endpoint's opaque key) (2.5.G S9)", () => {
    // A custom OpenAI-compatible endpoint's key has no `sk-`/`Bearer` shape, so the shape-based scrubSecrets can't
    // match it — a hostile/misconfigured proxy that echoes the received credential in its error body would leak the
    // real key into history.db / --json / the TUI unless the resolved key is exact-redacted (CLAUDE.md #6).
    const key = ['opaque', 'proxy', 'CREDENTIAL', '4f2a9'].join('-'); // no vendor key shape
    const echoed = new APIError(
      401,
      undefined,
      `rejected token '${key}' for this endpoint`,
      undefined,
    );
    // WITHOUT the key (the listModels path redacts separately) the opaque token would pass through...
    expect(openaiErrorToLlmError(echoed, 'openai').message).toContain(key);
    // ...WITH the resolved key threaded (generate/stream/media), it is exact-redacted before it can escape.
    const redacted = openaiErrorToLlmError(echoed, 'openai', key);
    expect(redacted.message).not.toContain(key);
    expect(redacted.kind).toBe('auth'); // classification is preserved
    // Also redacts a key echoed in the error CODE field.
    const codeEcho = new APIError(400, undefined, 'bad', undefined);
    Object.assign(codeEcho, { code: `token_${key}_invalid` });
    expect(openaiErrorToLlmError(codeEcho, 'openai', key).code).not.toContain(key);
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

describe('OpenAI-compatible adapter — Sora async video (generateMedia + pollMediaJob, 1.AH A3)', () => {
  const VIDEO_REQ: MediaGenRequest = {
    model: 'sora-2',
    prompt: 'a wave breaking on a beach',
    modality: 'video',
    durationSeconds: 4,
  };

  interface SoraCapture {
    createBody?: Record<string, unknown>;
    readonly signalByCall: Record<'create' | 'retrieve' | 'content', boolean>;
  }
  type SoraFetch = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
    capture: SoraCapture;
  };

  /** Route the SDK's videos.* HTTP calls: GET …/content → the MP4 bytes; create(POST)/retrieve(GET) → a
   *  Video JSON. Records the create POST body + per-call AbortSignal presence on `.capture`. */
  function soraFetch(video: Record<string, unknown>, bytes = 'FAKE-MP4-BYTES'): SoraFetch {
    const capture: SoraCapture = {
      signalByCall: { create: false, retrieve: false, content: false },
    };
    const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      let url: string;
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = input.url;
      }
      let call: 'content' | 'create' | 'retrieve';
      if (url.endsWith('/content')) {
        call = 'content';
      } else if (init?.method === 'POST') {
        call = 'create';
      } else {
        call = 'retrieve';
      }
      capture.signalByCall[call] = init?.signal instanceof AbortSignal;
      if (call === 'create') {
        // videos.create sends multipart/form-data (it supports file uploads), so the body is a FormData,
        // not a JSON string — read its text fields.
        const body = init?.body;
        capture.createBody =
          body instanceof FormData
            ? Object.fromEntries(
                [...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>']),
              )
            : parseJsonBody(init);
      }
      if (call === 'content') {
        return Promise.resolve(
          new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4' } }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(video), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    return Object.assign(fn, { capture });
  }

  it('generateMedia (video) ALWAYS returns an opaque jobId (no media), schema-valid, even on instant completion', async () => {
    const fetch = soraFetch({ id: 'video_xyz', status: 'completed', progress: 100 });
    const adapter = createOpenAiAdapter({ maxRetries: 0, fetch });
    const result = await genMedia(adapter, VIDEO_REQ, 'k');
    expect(result.media).toBeUndefined(); // ASYNC arm — completion is the engine poll loop's job
    expect(result.jobId).toBe(encodeMediaJobId('video_xyz'));
    expect(MediaGenResultSchema.safeParse(result).success).toBe(true);
    expect(result.raw).toEqual({ id: 'video_xyz', status: 'completed' }); // no bytes in raw (I3)
    // The create body forwards model/prompt/seconds (NOT a spread of providerOptions).
    expect(fetch.capture.createBody).toMatchObject({
      model: 'sora-2',
      prompt: VIDEO_REQ.prompt,
      seconds: '4',
    });
  });

  it('generateMedia (video) defaults seconds to 4 (no durationSeconds) and forwards a valid size knob', async () => {
    const fetch = soraFetch({ id: 'video_xyz', status: 'queued', progress: 0 });
    const adapter = createOpenAiAdapter({ maxRetries: 0, fetch });
    await genMedia(
      adapter,
      {
        ...VIDEO_REQ,
        durationSeconds: undefined,
        providerOptions: { video: { size: '1280x720' } },
      },
      'k',
    );
    expect(fetch.capture.createBody).toMatchObject({ seconds: '4', size: '1280x720' });
  });

  it('generateMedia (video) drops an unrecognized size from the create body (input filter)', async () => {
    const fetch = soraFetch({ id: 'video_xyz', status: 'queued', progress: 0 });
    const adapter = createOpenAiAdapter({ maxRetries: 0, fetch });
    await genMedia(adapter, { ...VIDEO_REQ, providerOptions: { video: { size: '99x99' } } }, 'k');
    expect(fetch.capture.createBody?.['size']).toBeUndefined();
  });

  it('generateMedia (video) forwards each valid durationSeconds (8, 12) to the create body', async () => {
    for (const n of [8, 12] as const) {
      const fetch = soraFetch({ id: 'video_xyz', status: 'queued', progress: 0 });
      const adapter = createOpenAiAdapter({ maxRetries: 0, fetch });
      await genMedia(adapter, { ...VIDEO_REQ, durationSeconds: n }, 'k');
      expect(fetch.capture.createBody?.['seconds']).toBe(String(n));
    }
  });

  it('generateMedia (video) threads the AbortSignal into videos.create', async () => {
    const fetch = soraFetch({ id: 'video_xyz', status: 'queued', progress: 0 });
    const adapter = createOpenAiAdapter({ maxRetries: 0, fetch });
    const controller = new AbortController();
    await genMedia(adapter, { ...VIDEO_REQ, signal: controller.signal }, 'k');
    expect(fetch.capture.signalByCall.create).toBe(true);
  });

  it('generateMedia (video) rejects a non-{4,8,12} durationSeconds with a typed bad_request before egress', async () => {
    let called = false;
    const adapter = createOpenAiAdapter({
      maxRetries: 0,
      fetch: (input, init) => {
        called = true;
        return soraFetch({ id: 'v', status: 'queued' })(input, init);
      },
    });
    await expect(
      genMedia(adapter, { ...VIDEO_REQ, durationSeconds: 5 }, 'k'),
    ).rejects.toMatchObject({ llmError: { kind: 'bad_request' } });
    expect(called).toBe(false); // rejected before any SDK call
  });

  it('pollMediaJob maps queued → pending and in_progress → pending with clamped 0-1 progress', async () => {
    const jobId = encodeMediaJobId('video_xyz');
    const queued = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({ id: 'video_xyz', status: 'queued', progress: 0 }),
    });
    expect(await pollMedia(queued, jobId, 'k')).toEqual({ state: 'pending' });

    const inProgress = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({ id: 'video_xyz', status: 'in_progress', progress: 50 }),
    });
    expect(await pollMedia(inProgress, jobId, 'k')).toEqual({ state: 'pending', progress: 0.5 });

    // Clamp an out-of-range progress to [0,1] (defends the engine's z.number().min(0).max(1) boundary).
    const over = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({ id: 'video_xyz', status: 'in_progress', progress: 150 }),
    });
    expect(await pollMedia(over, jobId, 'k')).toEqual({ state: 'pending', progress: 1 });
  });

  it('pollMediaJob completed-but-empty-bytes → a typed bad_request failed (defensive)', async () => {
    const adapter = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({ id: 'video_xyz', status: 'completed', progress: 100 }, ''),
    });
    expect(await pollMedia(adapter, encodeMediaJobId('video_xyz'), 'k')).toMatchObject({
      state: 'failed',
      error: { kind: 'bad_request' },
    });
  });

  it('pollMediaJob completed → downloads the MP4 and returns a base64 video/mp4 media part (done)', async () => {
    const jobId = encodeMediaJobId('video_xyz');
    const adapter = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({ id: 'video_xyz', status: 'completed', progress: 100 }, 'MP4-BYTES'),
    });
    const status = await pollMedia(adapter, jobId, 'k');
    expect(MediaJobStatusSchema.safeParse(status).success).toBe(true);
    expect(status).toEqual({
      state: 'done',
      media: {
        type: 'media',
        mimeType: 'video/mp4',
        source: { kind: 'base64', data: Buffer.from('MP4-BYTES').toString('base64') },
      },
    });
  });

  it('pollMediaJob failed → content_filter for a content-policy code, unknown for a null error', async () => {
    const jobId = encodeMediaJobId('video_xyz');
    const blocked = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({
        id: 'video_xyz',
        status: 'failed',
        progress: 0,
        error: { code: 'content_policy_violation', message: 'blocked' },
      }),
    });
    expect(await pollMedia(blocked, jobId, 'k')).toMatchObject({
      state: 'failed',
      error: { kind: 'content_filter', retryable: false },
    });

    const nullErr = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({ id: 'video_xyz', status: 'failed', progress: 0, error: null }),
    });
    expect(await pollMedia(nullErr, jobId, 'k')).toMatchObject({
      state: 'failed',
      error: { kind: 'unknown' },
    });
  });

  it('pollMediaJob failed with a runtime-ABSENT error field → unknown (no TypeError)', async () => {
    // The SDK types Video.error required-nullable, but a deviating response may omit it on a failed
    // status — mapVideoCreateError must treat undefined like null, not crash on err.code.
    const adapter = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({ id: 'video_xyz', status: 'failed', progress: 0 }), // no error field
    });
    expect(await pollMedia(adapter, encodeMediaJobId('video_xyz'), 'k')).toMatchObject({
      state: 'failed',
      error: { kind: 'unknown' },
    });
  });

  it('pollMediaJob in_progress with a runtime-ABSENT progress → pending progress 0 (no NaN)', async () => {
    // A missing progress would make undefined/100 NaN, failing the engine z.number().min(0).max(1).
    const adapter = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({ id: 'video_xyz', status: 'in_progress' }), // no progress field
    });
    expect(await pollMedia(adapter, encodeMediaJobId('video_xyz'), 'k')).toEqual({
      state: 'pending',
      progress: 0,
    });
  });

  it('pollMediaJob failed with an empty error code → unknown kind, omits the empty code field', async () => {
    const adapter = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({
        id: 'video_xyz',
        status: 'failed',
        progress: 0,
        error: { code: '', message: 'x' },
      }),
    });
    const status = await pollMedia(adapter, encodeMediaJobId('video_xyz'), 'k');
    expect(status).toMatchObject({ state: 'failed', error: { kind: 'unknown' } });
    if (status.state === 'failed') {
      expect(status.error.code).toBeUndefined(); // empty code is omitted, not surfaced as ''
    }
  });

  it('pollMediaJob maps an unrecognized SDK status to a FATAL unknown failed (the default arm)', async () => {
    // The SDK types status as a closed union; a future/unknown status must not fall through to undefined.
    const adapter = createOpenAiAdapter({
      maxRetries: 0,
      fetch: soraFetch({ id: 'video_xyz', status: 'rendering', progress: 0 }),
    });
    expect(await pollMedia(adapter, encodeMediaJobId('video_xyz'), 'k')).toMatchObject({
      state: 'failed',
      error: { kind: 'unknown' },
    });
  });

  it('pollMediaJob returns a FATAL failed (not a throw) for an unrecognized jobId token', async () => {
    let called = false;
    const adapter = createOpenAiAdapter({
      maxRetries: 0,
      fetch: (input, init) => {
        called = true;
        return soraFetch({ id: 'v', status: 'queued' })(input, init);
      },
    });
    const status = await pollMedia(adapter, 'not-a-relavium-token', 'k');
    expect(status).toMatchObject({ state: 'failed', error: { kind: 'bad_request' } });
    expect(called).toBe(false); // never reached the SDK — decode failed first
  });

  it('pollMediaJob threads the AbortSignal into BOTH retrieve and downloadContent (completed path)', async () => {
    const fetch = soraFetch({ id: 'video_xyz', status: 'completed', progress: 100 }, 'MP4');
    const adapter = createOpenAiAdapter({ maxRetries: 0, fetch });
    const controller = new AbortController();
    await pollMedia(adapter, encodeMediaJobId('video_xyz'), 'k', controller.signal);
    expect(fetch.capture.signalByCall.retrieve).toBe(true);
    expect(fetch.capture.signalByCall.content).toBe(true); // the download honors the run cancel too
  });

  it('DeepSeek has no async video: generateMedia(video) → capability error, pollMediaJob → failed', async () => {
    await expect(genMedia(deepseekAdapter, VIDEO_REQ, 'k')).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    const status = await pollMedia(deepseekAdapter, encodeMediaJobId('video_xyz'), 'k');
    expect(status).toMatchObject({ state: 'failed' });
  });
});
