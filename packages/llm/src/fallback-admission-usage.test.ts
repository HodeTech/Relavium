import { describe, expect, it, vi } from 'vitest';

import { CostTracker } from './cost-tracker.js';
import { FallbackChain, type AttemptRecord, type FallbackChainOptions } from './fallback-chain.js';
import { LlmProviderError, makeLlmError } from './llm-error.js';
import type { ModelPricing } from './pricing.js';
import { createCustomOpenAiProvider } from './providers.js';
import type { LlmError, LlmProvider, LlmRequest, StreamChunk, Usage } from './types.js';

type CallPath = 'generate' | 'stream';
const paths: readonly CallPath[] = ['generate', 'stream'];
const MODEL = 'gpt-4o-mini';
const request: LlmRequest = {
  model: MODEL,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'offline control' }] }],
};
const oneMicrocentPerToken: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: 'Offline cost control',
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_384,
  inputPerMtokMicrocents: 1_000_000,
  outputPerMtokMicrocents: 1_000_000,
  cachedInputPerMtokMicrocents: 1_000_000,
};

function accounting() {
  const overlay = new Map([[MODEL, oneMicrocentPerToken]]);
  const tracker = new CostTracker(overlay);
  const record = vi.spyOn(tracker, 'record');
  return { overlay, tracker, record };
}

/** Exercise the public factory's official adapter without network or credential stores. */
function officialProvider(path: CallPath) {
  const fetch = vi.fn(() => {
    const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
    const common = { id: 'offline', created: 0, model: MODEL };
    const body =
      path === 'generate'
        ? JSON.stringify({
            ...common,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok', refusal: null },
                finish_reason: 'stop',
                logprobs: null,
              },
            ],
            usage,
          })
        : [
            {
              ...common,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
            },
            {
              ...common,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage,
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join('') + 'data: [DONE]\n\n';
    return Promise.resolve(
      new Response(body, {
        headers: {
          'content-type': path === 'generate' ? 'application/json' : 'text/event-stream',
        },
      }),
    );
  });
  const adapter = createCustomOpenAiProvider({
    providerId: 'openai',
    baseURL: 'https://api.openai.com/v1',
    fetch,
  });
  const generate = vi.fn(adapter.generate.bind(adapter));
  const stream = vi.fn(adapter.stream.bind(adapter));
  const provider: LlmProvider = { ...adapter, generate, stream };
  return { provider, generate, stream, fetch };
}

function hostFailure(usage: Usage): LlmProviderError {
  return new LlmProviderError({
    ...makeLlmError({
      provider: 'openai',
      kind: 'context_overflow',
      message: 'typed host refusal',
      code: 'host_refusal',
      status: 400,
      retryAfterMs: 17,
      cause: new Error('PRIVATE_HOST_CAUSE'),
    }),
    usage,
    contentCommitted: true,
  });
}

async function collect(chain: FallbackChain): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of chain.stream(request)) chunks.push(chunk);
  return chunks;
}

function invoke(chain: FallbackChain, path: CallPath) {
  return path === 'generate' ? chain.generate(request) : collect(chain);
}

async function failureOf(chain: FallbackChain, path: CallPath): Promise<LlmError> {
  if (path === 'generate') {
    try {
      await chain.generate(request);
    } catch (error) {
      if (error instanceof LlmProviderError) return error.llmError;
      throw error;
    }
    throw new Error('expected a generated failure');
  }
  const chunks = await collect(chain);
  expect(chunks).toHaveLength(1);
  const chunk = chunks[0];
  if (chunk?.type === 'error') return chunk.error;
  throw new Error('expected a streamed failure');
}

function chainFor(
  provider: LlmProvider,
  records: AttemptRecord[],
  options: FallbackChainOptions,
  maxAttempts = 1,
): FallbackChain {
  return new FallbackChain([{ provider, model: MODEL, maxAttempts }], {
    ...options,
    onAttempt: (record) => records.push(record),
  });
}

function expectUninvoked(records: AttemptRecord[], diagnostic: LlmError): void {
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    outcome: 'failed',
    providerInvoked: false,
    contentReceived: false,
    customEndpoint: false,
  });
  for (const field of ['usage', 'cost', 'priced']) {
    expect(Object.hasOwn(records[0] ?? {}, field)).toBe(false);
  }
  for (const error of [diagnostic, records[0]?.error]) {
    expect(Object.hasOwn(error ?? {}, 'usage')).toBe(false);
    expect(Object.hasOwn(error ?? {}, 'contentCommitted')).toBe(false);
    expect(Object.isFrozen(error)).toBe(true);
  }
}

describe('fallback usage requires provider invocation', () => {
  for (const path of paths) {
    for (const hookTiming of ['sync', 'async']) {
      for (const quantity of ['positive', 'zero', 'malformed']) {
        it(`${path}: ${hookTiming} preAttempt ${quantity} usage cannot invent a charge or commitment`, async () => {
          const sdk = officialProvider(path);
          const money = accounting();
          const originalUsage: Usage = {
            inputTokens: quantity === 'zero' ? 0 : 19,
            outputTokens: quantity === 'zero' ? 0 : quantity === 'malformed' ? -1 : 7,
          };
          const refusal = hostFailure(originalUsage);
          const preAttempt = vi.fn(() => {
            if (hookTiming === 'async') return Promise.reject(refusal);
            throw refusal;
          });
          const keyFor = vi.fn(() => 'offline-key');
          const records: AttemptRecord[] = [];
          const diagnostic = await failureOf(
            chainFor(sdk.provider, records, {
              keyFor,
              preAttempt,
              costTracker: money.tracker,
              sleep: () => Promise.resolve(),
            }),
            path,
          );

          expectUninvoked(records, diagnostic);
          expect(preAttempt).toHaveBeenCalledTimes(1);
          expect(keyFor).not.toHaveBeenCalled();
          expect(sdk.generate).not.toHaveBeenCalled();
          expect(sdk.stream).not.toHaveBeenCalled();
          expect(sdk.fetch).not.toHaveBeenCalled();
          expect(money.record).not.toHaveBeenCalled();
          expect(money.tracker.cumulativeCostMicrocents).toBe(0);
          if (quantity === 'malformed') {
            expect(diagnostic).toMatchObject({ kind: 'unknown', retryable: false });
            expect(diagnostic.cause).toBe(refusal);
          } else {
            expect(diagnostic).toMatchObject({
              kind: 'context_overflow',
              retryable: false,
              code: 'host_refusal',
              status: 400,
              retryAfterMs: 17,
              message: 'typed host refusal',
            });
            expect(diagnostic.cause).toBe(refusal.llmError.cause);
          }
          expect(diagnostic.message).not.toContain('PRIVATE_HOST_CAUSE');
          expect(Object.isFrozen(refusal.llmError.cause)).toBe(false);
          expect(refusal.llmError.usage).toBe(originalUsage);
          expect(refusal.llmError.contentCommitted).toBe(true);
          expect(Object.isFrozen(refusal.llmError)).toBe(false);
        });
      }
    }

    for (const timing of ['sync', 'async']) {
      it(`${path}: ${timing} key resolution still normalizes a typed usage-bearing failure to safe auth`, async () => {
        const sdk = officialProvider(path);
        const money = accounting();
        const refusal = hostFailure({ inputTokens: 19, outputTokens: 7 });
        const keyFor = vi.fn(() => {
          if (timing === 'async') return Promise.reject(refusal);
          throw refusal;
        });
        const records: AttemptRecord[] = [];
        const diagnostic = await failureOf(
          chainFor(sdk.provider, records, {
            keyFor,
            costTracker: money.tracker,
            sleep: () => Promise.resolve(),
          }),
          path,
        );
        expectUninvoked(records, diagnostic);
        expect(diagnostic).toMatchObject({
          kind: 'auth',
          retryable: false,
          message: 'credential resolution failed for provider openai',
        });
        expect(Object.hasOwn(diagnostic, 'cause')).toBe(false);
        expect(keyFor).toHaveBeenCalledTimes(1);
        expect(sdk.generate).not.toHaveBeenCalled();
        expect(sdk.stream).not.toHaveBeenCalled();
        expect(sdk.fetch).not.toHaveBeenCalled();
        expect(money.record).not.toHaveBeenCalled();
        expect(money.tracker.cumulativeCostMicrocents).toBe(0);
      });
    }

    for (const setup of ['controller', 'timer']) {
      it(`${path}: ${setup} setup failure is uninvoked even after credentials resolve`, async () => {
        const sdk = officialProvider(path);
        const money = accounting();
        const refusal = hostFailure({ inputTokens: 19, outputTokens: 7 });
        const keyFor = vi.fn(() => 'offline-key');
        const newAbortController = vi.fn(() => {
          if (setup === 'controller') throw refusal;
          return new AbortController();
        });
        const setTimer = vi.fn(() => {
          throw refusal;
        });
        const records: AttemptRecord[] = [];
        const diagnostic = await failureOf(
          chainFor(sdk.provider, records, {
            keyFor,
            newAbortController,
            setTimer,
            costTracker: money.tracker,
            sleep: () => Promise.resolve(),
          }),
          path,
        );
        expectUninvoked(records, diagnostic);
        expect(diagnostic.kind).toBe('context_overflow');
        expect(diagnostic.cause).toBe(refusal.llmError.cause);
        expect(keyFor).toHaveBeenCalledTimes(1);
        expect(newAbortController).toHaveBeenCalledTimes(1);
        expect(setTimer).toHaveBeenCalledTimes(setup === 'timer' ? 1 : 0);
        expect(sdk.generate).not.toHaveBeenCalled();
        expect(sdk.stream).not.toHaveBeenCalled();
        expect(sdk.fetch).not.toHaveBeenCalled();
        expect(money.record).not.toHaveBeenCalled();
        expect(money.tracker.cumulativeCostMicrocents).toBe(0);
      });
    }

    it(`${path}: a provider method getter failure is observed before invocation`, async () => {
      const sdk = officialProvider(path);
      const money = accounting();
      const refusal = hostFailure({ inputTokens: 19, outputTokens: 7 });
      const getter = vi.fn(() => {
        throw refusal;
      });
      Object.defineProperty(sdk.provider, path, { get: getter });
      const keyFor = vi.fn(() => 'offline-key');
      const records: AttemptRecord[] = [];
      const diagnostic = await failureOf(
        chainFor(sdk.provider, records, {
          keyFor,
          costTracker: money.tracker,
          sleep: () => Promise.resolve(),
        }),
        path,
      );
      expectUninvoked(records, diagnostic);
      expect(diagnostic.kind).toBe('context_overflow');
      expect(diagnostic.cause).toBe(refusal.llmError.cause);
      expect(getter).toHaveBeenCalledTimes(1);
      expect(keyFor).toHaveBeenCalledTimes(1);
      expect(sdk.generate).not.toHaveBeenCalled();
      expect(sdk.stream).not.toHaveBeenCalled();
      expect(sdk.fetch).not.toHaveBeenCalled();
      expect(money.record).not.toHaveBeenCalled();
      expect(money.tracker.cumulativeCostMicrocents).toBe(0);
    });

    for (const quantity of ['positive', 'zero']) {
      it(`${path}: an invoked failed provider still accounts ${quantity} usage once in a frozen snapshot`, async () => {
        const sdk = officialProvider(path);
        const money = accounting();
        const originalUsage: Usage = {
          inputTokens: quantity === 'zero' ? 0 : 19,
          outputTokens: quantity === 'zero' ? 0 : 7,
        };
        const expectedUsage: Usage = { ...originalUsage };
        const refusal = hostFailure(originalUsage);
        const generate = vi.fn(() => Promise.reject(refusal));
        const stream = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
          yield await Promise.resolve({
            type: 'error',
            error: refusal.llmError,
          } satisfies StreamChunk);
        });
        const provider: LlmProvider = { ...sdk.provider, generate, stream };
        const keyFor = vi.fn(() => 'offline-key');
        const records: AttemptRecord[] = [];
        const diagnostic = await failureOf(
          chainFor(provider, records, {
            keyFor,
            costTracker: money.tracker,
            sleep: () => Promise.resolve(),
          }),
          path,
        );
        const amount = quantity === 'zero' ? 0 : 26;
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          outcome: 'failed',
          providerInvoked: true,
          contentReceived: path === 'generate',
          usage: expectedUsage,
          cost: { costMicrocents: amount, cumulativeCostMicrocents: amount },
        });
        expect(Object.hasOwn(records[0] ?? {}, 'priced')).toBe(false);
        expect(diagnostic.kind).toBe('context_overflow');
        expect(diagnostic.usage).toEqual(expectedUsage);
        expect(diagnostic.contentCommitted).toBe(path === 'generate' ? true : undefined);
        expect(diagnostic.cause).toBe(refusal.llmError.cause);
        expect(Object.isFrozen(diagnostic)).toBe(true);
        expect(Object.isFrozen(diagnostic.usage)).toBe(true);
        expect(Object.isFrozen(records[0]?.usage)).toBe(true);
        expect(money.record).toHaveBeenCalledExactlyOnceWith(MODEL, expectedUsage);
        expect(Object.isFrozen(money.record.mock.calls[0]?.[1])).toBe(true);
        expect(money.tracker.cumulativeCostMicrocents).toBe(amount);
        expect(keyFor).toHaveBeenCalledTimes(1);
        expect(generate).toHaveBeenCalledTimes(path === 'generate' ? 1 : 0);
        expect(stream).toHaveBeenCalledTimes(path === 'stream' ? 1 : 0);
        expect(sdk.fetch).not.toHaveBeenCalled();
        originalUsage.outputTokens = 999;
        expect(records[0]?.usage).toEqual(expectedUsage);
        expect(diagnostic.usage).toEqual(expectedUsage);
        expect(money.tracker.cumulativeCostMicrocents).toBe(amount);
      });
    }

    it(`${path}: pricing failure stays loud and retains invoked failed-response quantities`, async () => {
      const sdk = officialProvider(path);
      const money = accounting();
      const pricingCause = new Error('PRIVATE_PRICING_CAUSE');
      const priceLookup = vi.spyOn(money.overlay, 'get').mockImplementation(() => {
        throw pricingCause;
      });
      const usage: Usage = { inputTokens: 19, outputTokens: 7 };
      const refusal = hostFailure(usage);
      const generate = vi.fn(() => Promise.reject(refusal));
      const stream = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
        yield await Promise.resolve({
          type: 'error',
          error: refusal.llmError,
        } satisfies StreamChunk);
      });
      const records: AttemptRecord[] = [];
      const diagnostic = await failureOf(
        chainFor(
          { ...sdk.provider, generate, stream },
          records,
          {
            keyFor: () => 'offline-key',
            costTracker: money.tracker,
            sleep: () => Promise.resolve(),
          },
          3,
        ),
        path,
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        outcome: 'failed',
        providerInvoked: true,
        contentReceived: path === 'generate',
        usage,
        priced: false,
      });
      expect(Object.hasOwn(records[0] ?? {}, 'cost')).toBe(false);
      expect(diagnostic).toMatchObject({
        kind: 'unknown',
        retryable: false,
        message: 'cost accounting failed after a failed provider response',
        usage,
      });
      expect(diagnostic.cause).toBe(pricingCause);
      expect(diagnostic.message).not.toContain('PRIVATE_PRICING_CAUSE');
      expect(Object.isFrozen(diagnostic.usage)).toBe(true);
      expect(Object.isFrozen(records[0]?.usage)).toBe(true);
      expect(money.record).toHaveBeenCalledExactlyOnceWith(MODEL, usage);
      expect(priceLookup).toHaveBeenCalledTimes(1);
      expect(money.tracker.cumulativeCostMicrocents).toBe(0);
      expect(generate).toHaveBeenCalledTimes(path === 'generate' ? 1 : 0);
      expect(stream).toHaveBeenCalledTimes(path === 'stream' ? 1 : 0);
      expect(sdk.fetch).not.toHaveBeenCalled();
    });

    it(`${path}: a retryable preAttempt diagnostic cannot commit or charge the later real success`, async () => {
      const sdk = officialProvider(path);
      const money = accounting();
      const refusal = new LlmProviderError({
        ...makeLlmError({
          provider: 'openai',
          kind: 'transport',
          message: 'transient host failure',
        }),
        usage: { inputTokens: 19, outputTokens: 7 },
        contentCommitted: true,
      });
      let hookCalls = 0;
      const preAttempt = vi.fn(() => {
        hookCalls++;
        if (hookCalls === 1) throw refusal;
      });
      const keyFor = vi.fn(() => 'offline-key');
      const sleep = vi.fn(() => Promise.resolve());
      const records: AttemptRecord[] = [];
      await invoke(
        chainFor(
          sdk.provider,
          records,
          { keyFor, preAttempt, sleep, costTracker: money.tracker },
          2,
        ),
        path,
      );
      expect(records).toHaveLength(2);
      const first = records[0];
      if (first?.error === undefined) throw new Error('expected first admission failure');
      expectUninvoked([first], first.error);
      expect(first.error).toMatchObject({ kind: 'transport', retryable: true });
      expect(records[1]).toMatchObject({
        outcome: 'succeeded',
        providerInvoked: true,
        contentReceived: true,
        usage: { inputTokens: 2, outputTokens: 1 },
        cost: { costMicrocents: 3, cumulativeCostMicrocents: 3 },
      });
      expect(preAttempt).toHaveBeenCalledTimes(2);
      expect(keyFor).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sdk.generate).toHaveBeenCalledTimes(path === 'generate' ? 1 : 0);
      expect(sdk.stream).toHaveBeenCalledTimes(path === 'stream' ? 1 : 0);
      expect(sdk.fetch).toHaveBeenCalledTimes(1);
      expect(money.record).toHaveBeenCalledExactlyOnceWith(MODEL, {
        inputTokens: 2,
        outputTokens: 1,
      });
      expect(money.tracker.cumulativeCostMicrocents).toBe(3);
    });

    it(`${path}: an admission observer exception escapes with its exact identity once`, async () => {
      const sdk = officialProvider(path);
      const money = accounting();
      const refusal = hostFailure({ inputTokens: 19, outputTokens: 7 });
      const observerCause = new Error('PRIVATE_OBSERVER_CAUSE');
      const records: AttemptRecord[] = [];
      const onAttempt = vi.fn((record: AttemptRecord) => {
        records.push(record);
        throw observerCause;
      });
      const keyFor = vi.fn(() => 'offline-key');
      const chain = new FallbackChain([{ provider: sdk.provider, model: MODEL, maxAttempts: 3 }], {
        keyFor,
        costTracker: money.tracker,
        sleep: () => Promise.resolve(),
        preAttempt: () => {
          throw refusal;
        },
        onAttempt,
      });
      await expect(invoke(chain, path)).rejects.toBe(observerCause);
      expect(onAttempt).toHaveBeenCalledTimes(1);
      const observed = records[0]?.error;
      if (observed === undefined) throw new Error('expected observed admission failure');
      expectUninvoked(records, observed);
      expect(keyFor).not.toHaveBeenCalled();
      expect(sdk.generate).not.toHaveBeenCalled();
      expect(sdk.stream).not.toHaveBeenCalled();
      expect(sdk.fetch).not.toHaveBeenCalled();
      expect(money.record).not.toHaveBeenCalled();
      expect(money.tracker.cumulativeCostMicrocents).toBe(0);
    });
  }
});
