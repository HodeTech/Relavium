import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageEvidence, UsageInvocation } from '@relavium/shared';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createGeminiAdapter } from '../adapters/gemini.js';
import { createOpenAiAdapter } from '../adapters/openai.js';
import { FallbackChain, type AttemptRecord } from '../fallback-chain.js';
import type { LlmProvider, LlmRequest, ProviderId, StreamChunk, LlmResult } from '../types.js';

const key = 'offline-w8-evidence';
const providers: readonly ProviderId[] = ['openai', 'deepseek', 'anthropic', 'gemini'];
const request = (provider: ProviderId): LlmRequest => ({
  model: provider === 'gemini' ? 'gemini-2.5-flash' : `w8-evidence-${provider}`,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
});
const zeros: Record<ProviderId, Record<string, unknown>> = {
  openai: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
  deepseek: {
    prompt_tokens: 0,
    completion_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
  },
  anthropic: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  gemini: {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    cachedContentTokenCount: 0,
    thoughtsTokenCount: 0,
  },
};
function sse(data: unknown, event?: string): string {
  return `${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}
function response(
  provider: ProviderId,
  streaming: boolean,
  usage: unknown,
  terminal = true,
): Response {
  const hasUsage = usage === undefined ? {} : { usage };
  let body: string;
  if (provider === 'anthropic') {
    const message = {
      id: 'msg_w8',
      type: 'message',
      role: 'assistant',
      model: request(provider).model,
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      ...hasUsage,
    };
    body = streaming
      ? sse(
          { type: 'message_start', message: { ...message, stop_reason: null } },
          'message_start',
        ) +
        (terminal
          ? sse(
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                ...hasUsage,
              },
              'message_delta',
            ) + sse({ type: 'message_stop' }, 'message_stop')
          : '')
      : JSON.stringify(message);
  } else if (provider === 'gemini') {
    const data = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hello' }] },
          ...(terminal ? { finishReason: 'STOP' } : {}),
        },
      ],
      ...(usage === undefined ? {} : { usageMetadata: usage }),
    };
    body = streaming ? sse(data) : JSON.stringify(data);
  } else {
    const base = {
      id: 'chatcmpl_w8',
      object: streaming ? 'chat.completion.chunk' : 'chat.completion',
      created: 0,
      model: request(provider).model,
    };
    body = streaming
      ? sse({
          ...base,
          choices: [
            { index: 0, delta: { content: 'hello' }, finish_reason: terminal ? 'stop' : null },
          ],
        }) +
        sse({ ...base, choices: [], ...hasUsage }) +
        (terminal ? 'data: [DONE]\n\n' : '')
      : JSON.stringify({
          ...base,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
          ],
          ...hasUsage,
        });
  }
  return new Response(body, {
    status: 200,
    headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
  });
}
function adapter(provider: ProviderId, fetch: typeof globalThis.fetch): LlmProvider {
  if (provider === 'anthropic') return createAnthropicAdapter({ fetch });
  if (provider === 'gemini') {
    vi.stubGlobal('fetch', fetch);
    return createGeminiAdapter();
  }
  return createOpenAiAdapter({
    providerId: provider,
    fetch,
    ...(provider === 'deepseek' ? { baseURL: 'https://api.deepseek.com' } : {}),
  });
}
async function evidence(
  provider: LlmProvider,
  req: LlmRequest,
  streaming: boolean,
): Promise<UsageEvidence> {
  if (!streaming) return (await provider.generate(req, key)).usage;
  let terminal: StreamChunk | undefined;
  for await (const chunk of provider.stream(req, key)) terminal = chunk;
  if (terminal?.type === 'stop') return terminal.usage;
  if (terminal?.type === 'error' && terminal.error.usage !== undefined) return terminal.error.usage;
  throw new Error('Expected accountable terminal evidence');
}

describe('native usage evidence through actual offline SDK HTTP', () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const provider of providers)
    for (const streaming of [false, true]) {
      const label = `${provider} ${streaming ? 'stream' : 'generate'}`;
      it(`${label}: omitted usage and empty usage cannot become complete zero`, async () => {
        for (const raw of [undefined, {}]) {
          const fetch = vi.fn(() => Promise.resolve(response(provider, streaming, raw)));
          expect(
            (await evidence(adapter(provider, fetch), request(provider), streaming)).kind,
            'USAGE_CAUSAL_NATIVE_OMISSION',
          ).toBe('missing');
          expect(fetch).toHaveBeenCalledTimes(1);
        }
      });
      it(`${label}: explicit applicable zero counts are complete and owned`, async () => {
        const output = await evidence(
          adapter(provider, () => Promise.resolve(response(provider, streaming, zeros[provider]))),
          request(provider),
          streaming,
        );
        expect(output.kind).toBe('complete');
        if (output.kind !== 'complete') throw new Error('Expected complete zero');
        expect(output.usage.inputTokens).toBe(0);
        expect(output.usage.outputTokens).toBe(0);
        expect(Object.isFrozen(output.usage)).toBe(true);
      });
      it(`${label}: missing required input preserves independent output`, async () => {
        const raw =
          provider === 'anthropic'
            ? { output_tokens: 7 }
            : provider === 'gemini'
              ? { candidatesTokenCount: 5, thoughtsTokenCount: 2 }
              : { completion_tokens: 7 };
        const output = await evidence(
          adapter(provider, () => Promise.resolve(response(provider, streaming, raw))),
          request(provider),
          streaming,
        );
        expect(output).toMatchObject({
          kind: 'partial',
          known: { outputTokens: 7 },
          reason: 'missing_fields',
        });
        expect(output.kind === 'partial' && output.known.inputTokens).toBeUndefined();
      });
      it(`${label}: invalid unsafe input cannot be billed or concealed`, async () => {
        const raw = {
          ...zeros[provider],
          ...(provider === 'anthropic'
            ? { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 7 }
            : provider === 'gemini'
              ? { promptTokenCount: -1, candidatesTokenCount: 7 }
              : { prompt_tokens: -1, completion_tokens: 7 }),
        };
        expect(
          await evidence(
            adapter(provider, () => Promise.resolve(response(provider, streaming, raw))),
            request(provider),
            streaming,
          ),
        ).toMatchObject({ kind: 'partial', known: { outputTokens: 7 }, reason: 'invalid_fields' });
      });
    }
  for (const provider of ['openai', 'deepseek', 'gemini'] as const)
    for (const streaming of [false, true]) {
      it(`${provider}/${streaming}: gross without cache split is partial and contradiction never clamps`, async () => {
        const gross =
          provider === 'gemini'
            ? { promptTokenCount: 10, candidatesTokenCount: 7, thoughtsTokenCount: 0 }
            : { prompt_tokens: 10, completion_tokens: 7 };
        const bad =
          provider === 'gemini'
            ? { ...gross, cachedContentTokenCount: 11 }
            : provider === 'deepseek'
              ? { ...gross, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 7 }
              : { ...gross, prompt_tokens_details: { cached_tokens: 11 } };
        for (const [raw, reason] of [
          [gross, 'missing_fields'],
          [bad, 'contradictory_fields'],
        ] as const) {
          const output = await evidence(
            adapter(provider, () => Promise.resolve(response(provider, streaming, raw))),
            request(provider),
            streaming,
          );
          expect(output).toMatchObject({ kind: 'partial', known: { outputTokens: 7 }, reason });
          expect(output.kind === 'partial' && output.known.inputTokens).toBeUndefined();
        }
      });
    }
  it('Anthropic absent start input stays unknown after an authoritative final output; cumulative output replaces', async () => {
    const body =
      sse(
        {
          type: 'message_start',
          message: {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: 'w8',
            content: [],
            usage: { output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        'message_start',
      ) +
      sse(
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
        'message_delta',
      ) +
      sse({ type: 'message_stop' }, 'message_stop');
    const a = adapter('anthropic', () =>
      Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
    );
    expect(await evidence(a, request('anthropic'), true)).toEqual({
      kind: 'partial',
      reason: 'missing_fields',
      known: { outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });
  for (const provider of providers)
    it(`${provider}: truncation preserves trustworthy observed quantities`, async () => {
      const observed: Record<ProviderId, Record<string, unknown>> = {
        openai: {
          prompt_tokens: 14,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 3 },
        },
        deepseek: {
          prompt_tokens: 14,
          completion_tokens: 7,
          prompt_cache_hit_tokens: 3,
          prompt_cache_miss_tokens: 11,
        },
        anthropic: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
        gemini: {
          promptTokenCount: 14,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 3,
          thoughtsTokenCount: 2,
        },
      };
      const output = await evidence(
        adapter(provider, () =>
          Promise.resolve(response(provider, true, observed[provider], false)),
        ),
        request(provider),
        true,
      );
      expect(output).toEqual({
        kind: 'partial',
        known: {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 3,
          ...(provider === 'anthropic' ? { cacheWriteTokens: 2 } : {}),
          ...(provider === 'gemini' ? { reasoningTokens: 2 } : {}),
        },
        reason: 'interrupted',
      });
    });
});

function identity(call: number): UsageInvocation {
  return Object.freeze({
    producerId: 'producer',
    ordinal: call,
    dispatchId: 'dispatch',
    round: 1,
    chainAttempt: call,
  });
}
describe('native parameter repair joins fresh coverage before another SDK egress', () => {
  for (const streaming of [false, true])
    for (const custom of [false, true]) {
      it(`${streaming}/${custom}: prior unknown/refused call and final complete zero have distinct identities`, async () => {
        const order: string[] = [];
        let calls = 0;
        const records: AttemptRecord[] = [];
        const fetch = vi.fn(() => {
          calls++;
          order.push(`fetch-${calls}`);
          return Promise.resolve(
            calls === 1
              ? new Response(
                  JSON.stringify({
                    error: {
                      message: 'Unsupported parameter: temperature',
                      type: 'invalid_request_error',
                      param: 'temperature',
                      code: 'unsupported_parameter',
                    },
                  }),
                  { status: 400, headers: { 'content-type': 'application/json' } },
                )
              : response('openai', streaming, zeros.openai),
          );
        });
        const provider = createOpenAiAdapter({
          fetch,
          ...(custom ? { baseURL: 'https://example.test/v1' } : {}),
        });
        let pending = 0;
        const ids: UsageInvocation[] = [];
        const chain = new FallbackChain(
          [{ provider, model: `w8-repair-${streaming}-${custom}`, maxAttempts: 1 }],
          {
            keyFor: () => key,
            sleep: () => Promise.resolve(),
            beginUsageInvocation: () => {
              pending++;
              const id = identity(pending);
              ids.push(id);
              order.push(`pending-${pending}`);
              return Promise.resolve(id);
            },
            onAttempt: (record) => {
              records.push(record);
              order.push(record.coverageOnly ? 'prior-disposition' : 'final');
            },
          },
        );
        const req = { ...request('openai'), temperature: 0.7 };
        if (streaming) {
          for await (const chunk of chain.stream(req)) {
            expect(chunk.type).not.toBe('error');
          }
        } else await chain.generate(req);
        expect(order).toEqual([
          'pending-1',
          'fetch-1',
          'prior-disposition',
          'pending-2',
          'fetch-2',
          'final',
        ]);
        expect(records).toHaveLength(2);
        expect(records[0]?.invocation).toBe(ids[0]);
        expect(records[1]?.invocation).toBe(ids[1]);
        expect(records[0]).toMatchObject({
          coverageOnly: true,
          providerInvoked: true,
          customEndpoint: custom,
          usage: { kind: 'missing' },
          error: { kind: 'bad_request', status: 400 },
        });
        expect(records[1]).toMatchObject({
          usage: { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } },
        });
      });
    }
});

describe('coverage receipt correlation and complete-only accounting', () => {
  const supports = createOpenAiAdapter().supports;
  function deferred<T>() {
    let resolve: (value: T) => void = () => {
      throw new Error('uninitialized');
    };
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await Promise.resolve();
    }
    throw new Error('Expected retained receipt transition');
  }
  for (const streaming of [false, true])
    it(`${streaming}: late complete evidence owns the original correlation and charges once`, async () => {
      const release = deferred<void>();
      const records: AttemptRecord[] = [];
      const retained = new Set<Promise<unknown>>();
      const id = identity(1);
      const complete: UsageEvidence = {
        kind: 'complete',
        usage: { inputTokens: 3, outputTokens: 2 },
      };
      let fire: () => void = () => {
        throw new Error('timer not armed');
      };
      let invoked = false;
      let folds = 0;
      const provider: LlmProvider = {
        id: 'openai',
        supports,
        async generate() {
          invoked = true;
          await release.promise;
          return { content: [], stopReason: 'stop', usage: complete };
        },
        async *stream() {
          invoked = true;
          await release.promise;
          yield { type: 'stop', stopReason: 'stop', usage: complete };
        },
      };
      const chain = new FallbackChain([{ provider, model: 'w8-late', maxAttempts: 1 }], {
        keyFor: () => key,
        sleep: () => Promise.resolve(),
        beginUsageInvocation: () => Promise.resolve(id),
        newAbortController: () => new AbortController(),
        setTimer: (_ms, callback) => {
          fire = callback;
          return () => undefined;
        },
        retainWork: (factory) => {
          const promise = factory();
          retained.add(promise);
          void promise.then(
            () => retained.delete(promise),
            () => retained.delete(promise),
          );
          return promise;
        },
        costTracker: {
          record: (_model, usage) => {
            folds++;
            return { ...usage, costMicrocents: 5, cumulativeCostMicrocents: 5 };
          },
        },
        onAttempt: (record) => records.push(record),
      });
      const call = streaming
        ? (async () => {
            for await (const chunk of chain.stream(request('openai')))
              expect(chunk.type).toBe('error');
          })()
        : chain.generate(request('openai')).catch(() => undefined);
      await until(() => invoked);
      fire();
      await call;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ receiptPending: true, usage: { kind: 'missing' } });
      expect(retained.size).toBeGreaterThan(0);
      release.resolve();
      await until(() => records.length === 2 && retained.size === 0);
      expect(records[1]).toMatchObject({ receiptFinal: true, coverageOnly: true, usage: complete });
      expect(records[0]?.invocation).toBe(id);
      expect(records[1]?.invocation).toBe(id);
      expect(folds).toBe(1);
    });
  it('a receipt ready in the deadline checkpoint is published after its pending observation', async () => {
    const result = deferred<LlmResult>();
    const records: AttemptRecord[] = [];
    const id = identity(1);
    const usage: UsageEvidence = { kind: 'complete', usage: { inputTokens: 3, outputTokens: 2 } };
    let invoked = false;
    let fire: () => void = () => {
      throw new Error('timer not armed');
    };
    const cost = vi.fn(
      (_model: string, quantities: { inputTokens: number; outputTokens: number }) => ({
        ...quantities,
        costMicrocents: 5,
        cumulativeCostMicrocents: 5,
      }),
    );
    const provider: LlmProvider = {
      id: 'openai',
      supports,
      generate: () => {
        invoked = true;
        return result.promise;
      },
      async *stream() {
        await Promise.resolve();
        yield { type: 'stop', stopReason: 'stop', usage };
      },
    };
    const chain = new FallbackChain([{ provider, model: 'w8-late', maxAttempts: 1 }], {
      keyFor: () => key,
      sleep: () => Promise.resolve(),
      beginUsageInvocation: () => Promise.resolve(id),
      newAbortController: () => new AbortController(),
      setTimer: (_ms, callback) => {
        fire = callback;
        return () => undefined;
      },
      retainWork: (factory) => factory(),
      costTracker: { record: cost },
      onAttempt: (record) => records.push(record),
    });
    const call = chain.generate(request('openai')).catch(() => undefined);
    await until(() => invoked);
    fire();
    result.resolve({ content: [], stopReason: 'stop', usage });
    await call;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ receiptPending: true, usage: { kind: 'missing' } });
    expect(records[1]).toMatchObject({ receiptFinal: true, coverageOnly: true, usage });
    expect(records.map((record) => record.invocation)).toEqual([id, id]);
    expect(cost).toHaveBeenCalledTimes(1);
  });
  for (const evidence of [
    { kind: 'partial', known: { outputTokens: 7 }, reason: 'missing_fields' },
    { kind: 'missing', reason: 'not_reported' },
  ] satisfies UsageEvidence[])
    it(`${evidence.kind}: useful success is owned without a paid retry or a price`, async () => {
      const calls = vi.fn();
      const record = vi.fn();
      const records: AttemptRecord[] = [];
      const provider: LlmProvider = {
        id: 'openai',
        supports,
        generate: () => {
          calls();
          return Promise.resolve({ content: [], stopReason: 'stop', usage: evidence });
        },
        async *stream() {
          await Promise.resolve();
          calls();
          yield { type: 'stop', stopReason: 'stop', usage: evidence };
        },
      };
      const chain = new FallbackChain([{ provider, model: 'w8-partial', maxAttempts: 3 }], {
        keyFor: () => key,
        sleep: () => Promise.resolve(),
        costTracker: { record },
        onAttempt: (attempt) => records.push(attempt),
      });
      const result = await chain.generate(request('openai'));
      expect(result.usage).toEqual(evidence);
      expect(Object.isFrozen(result.usage)).toBe(true);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(record).not.toHaveBeenCalled();
      expect(records[0]).toMatchObject({ outcome: 'succeeded', usage: evidence });
    });
});

describe('native dialect applicability and independent quantities', () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const streaming of [false, true]) {
    it(`DeepSeek ${streaming}: hit/miss native counters, derivation and compatible alias agreement`, async () => {
      for (const raw of [
        { prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6, completion_tokens: 3 },
        { prompt_tokens: 10, prompt_cache_hit_tokens: 4, completion_tokens: 3 },
        { prompt_tokens: 10, prompt_cache_miss_tokens: 6, completion_tokens: 3 },
        {
          prompt_tokens: 10,
          prompt_cache_hit_tokens: 4,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens: 3,
        },
      ])
        expect(
          await evidence(
            adapter('deepseek', () => Promise.resolve(response('deepseek', streaming, raw))),
            request('deepseek'),
            streaming,
          ),
        ).toEqual({
          kind: 'complete',
          usage: { inputTokens: 6, cacheReadTokens: 4, outputTokens: 3 },
        });
      expect(
        await evidence(
          adapter('deepseek', () =>
            Promise.resolve(
              response('deepseek', streaming, {
                prompt_tokens: 10,
                prompt_cache_hit_tokens: 4,
                prompt_tokens_details: { cached_tokens: 5 },
                completion_tokens: 3,
              }),
            ),
          ),
          request('deepseek'),
          streaming,
        ),
      ).toEqual({ kind: 'partial', known: { outputTokens: 3 }, reason: 'contradictory_fields' });
    });
    it(`Gemini ${streaming}: thinking and tool prompt absence are unknown when applicable`, async () => {
      const raw = { promptTokenCount: 10, cachedContentTokenCount: 0, candidatesTokenCount: 3 };
      expect(
        await evidence(
          adapter('gemini', () => Promise.resolve(response('gemini', streaming, raw))),
          request('gemini'),
          streaming,
        ),
      ).toEqual({
        kind: 'partial',
        known: { inputTokens: 10, cacheReadTokens: 0 },
        reason: 'missing_fields',
      });
      const tools = [{ name: 'weather', parameters: { type: 'object' as const, properties: {} } }];
      expect(
        await evidence(
          adapter('gemini', () =>
            Promise.resolve(response('gemini', streaming, { ...raw, thoughtsTokenCount: 0 })),
          ),
          { ...request('gemini'), tools },
          streaming,
        ),
      ).toEqual({
        kind: 'partial',
        known: { outputTokens: 3, cacheReadTokens: 0, reasoningTokens: 0 },
        reason: 'missing_fields',
      });
      expect(
        await evidence(
          adapter('gemini', () => Promise.resolve(response('gemini', streaming, raw))),
          { ...request('gemini'), reasoningEffort: 'off' },
          streaming,
        ),
      ).toEqual({
        kind: 'complete',
        usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0 },
      });
    });
  }
  it('OpenAI inline audio without units is incomplete; explicit zero units remain present', async () => {
    for (const reported of [false, true]) {
      const raw = {
        prompt_tokens: 10,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 0 },
        ...(reported ? { completion_tokens_details: { audio_tokens: 0 } } : {}),
      };
      const req = {
        ...request('openai'),
        model: 'gpt-audio',
        outputModalities: ['text', 'audio'] as ['text', 'audio'],
      };
      const output = await evidence(
        adapter('openai', () => Promise.resolve(response('openai', false, raw))),
        req,
        false,
      );
      expect(output.kind).toBe(reported ? 'complete' : 'partial');
      if (output.kind === 'complete')
        expect(output.usage.mediaUnits).toEqual([
          { modality: 'audio', direction: 'output', units: 0, unit: 'count' },
        ]);
    }
  });
});

describe('repair coverage failure and cancellation', () => {
  for (const streaming of [false, true])
    for (const afterAck of [false, true]) {
      it(`${streaming}/${afterAck}: a refused next marker or cancellation sends no repair and never settles the old identity twice`, async () => {
        const controller = new AbortController();
        let calls = 0;
        let begins = 0;
        const records: AttemptRecord[] = [];
        const ids: UsageInvocation[] = [];
        const provider = createOpenAiAdapter({
          baseURL: 'https://repair-coverage.test/v1',
          fetch: () => {
            calls++;
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  error: {
                    message: 'Unsupported parameter: temperature',
                    param: 'temperature',
                    code: 'unsupported_parameter',
                  },
                }),
                { status: 400, headers: { 'content-type': 'application/json' } },
              ),
            );
          },
        });
        const chain = new FallbackChain(
          [{ provider, model: `w8-repair-block-${streaming}-${afterAck}`, maxAttempts: 1 }],
          {
            keyFor: () => key,
            sleep: () => Promise.resolve(),
            beginUsageInvocation: () => {
              begins++;
              if (begins === 2 && !afterAck)
                return Promise.reject(new Error('pending storage refused'));
              const id = identity(begins);
              ids.push(id);
              if (begins === 2) controller.abort();
              return Promise.resolve(id);
            },
            onAttempt: (record) => records.push(record),
          },
        );
        const req = { ...request('openai'), temperature: 0.5, signal: controller.signal };
        if (streaming) {
          for await (const chunk of chain.stream(req)) expect(chunk.type).toBe('error');
        } else await expect(chain.generate(req)).rejects.toBeDefined();
        expect(begins).toBe(2);
        expect(calls).toBe(1);
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
          coverageOnly: true,
          providerInvoked: true,
          usage: { kind: 'missing' },
        });
        expect(records[0]?.invocation).toBe(ids[0]);
        expect(records[1]?.providerInvoked).toBe(false);
        expect(records[1]?.invocation).toBe(afterAck ? ids[1] : undefined);
        expect(records[1]?.usage).toBeUndefined();
      });
    }
});

it('Anthropic invalid cumulative replacement retains earlier trustworthy quantities without claiming completeness', async () => {
  const body =
    sse(
      {
        type: 'message_start',
        message: {
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'w8',
          content: [],
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      'message_start',
    ) +
    sse(
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: -1 } },
      'message_delta',
    ) +
    sse({ type: 'message_stop' }, 'message_stop');
  const a = adapter('anthropic', () =>
    Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
  );
  expect(await evidence(a, request('anthropic'), true)).toEqual({
    kind: 'partial',
    reason: 'invalid_fields',
    known: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
});
