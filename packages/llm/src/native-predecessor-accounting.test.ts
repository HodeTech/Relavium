import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageEvidence, UsageInvocation } from '@relavium/shared';
import { clearLearnedParamRejections, createOpenAiAdapter } from './adapters/openai.js';
import { CostTracker } from './cost-tracker.js';
import type { ModelPricing } from './pricing.js';
import { FallbackChain, type AttemptRecord, type FallbackChainOptions } from './fallback-chain.js';
import { LlmProviderError, makeLlmError } from './llm-error.js';
import type { LlmInvocationOptions, LlmProvider, LlmRequest, StreamChunk } from './types.js';

const model = 'native-predecessor';
const zero: UsageEvidence = { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
const positive: UsageEvidence = { kind: 'complete', usage: { inputTokens: 7, outputTokens: 3 } };
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 1000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 0,
};
const identity = (ordinal: number): UsageInvocation => ({
  producerId: 'native',
  ordinal,
  dispatchId: 'turn',
  round: 1,
  chainAttempt: 1,
});
async function consume(
  chain: FallbackChain,
  streaming: boolean,
  request: LlmRequest,
): Promise<void> {
  if (!streaming) {
    await chain.generate(request);
    return;
  }
  for await (const chunk of chain.stream(request)) {
    if (chunk.type === 'error') throw new LlmProviderError(chunk.error);
  }
}
function externalProvider(usage: UsageEvidence, started: () => void): LlmProvider {
  // The exported hook supports accountable predecessor evidence. Current OpenAI HTTP 400
  // normalization does not supply usage; this control exercises an external seam implementer.
  const repair = async (options?: LlmInvocationOptions): Promise<void> => {
    await options?.beforeNativeRetry?.({
      ...makeLlmError({
        provider: 'openai',
        kind: 'bad_request',
        status: 400,
        message: 'parameter rejected',
      }),
      usage,
    });
    options?.nativeInvocationStarted?.();
    started();
  };
  return {
    ...createOpenAiAdapter(),
    customEndpoint: true,
    generate: async (_request, _key, options) => {
      await repair(options);
      return { content: [], stopReason: 'stop', usage: zero };
    },
    stream: async function* (_request, _key, options): AsyncGenerator<StreamChunk> {
      await repair(options);
      yield { type: 'stop', stopReason: 'stop', usage: zero };
    },
  };
}

describe('native predecessor settlement', () => {
  afterEach(() => clearLearnedParamRejections());
  for (const streaming of [false, true]) {
    for (const typed of [false, true]) {
      it(`actual SDK observer preserves identity and settles once (${streaming}/${typed})`, async () => {
        const marker = typed
          ? new LlmProviderError(
              makeLlmError({ provider: 'openai', kind: 'rate_limit', message: 'private observer' }),
            )
          : new Error('private observer');
        const fetch = vi.fn(() =>
          Promise.resolve(
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
          ),
        );
        const provider = createOpenAiAdapter({
          baseURL: 'https://native-predecessor.test/v1',
          fetch,
          maxRetries: 0,
        });
        const records: AttemptRecord[] = [];
        const admission = vi.fn();
        const chain = new FallbackChain([{ provider, model, maxAttempts: 2 }], {
          keyFor: () => 'offline',
          sleep: () => Promise.resolve(),
          preAttempt: admission,
          onAttempt: (record) => {
            records.push(record);
            if (record.coverageOnly) throw marker;
          },
        });
        await expect(
          consume(chain, streaming, { model, messages: [], temperature: 0.5 }),
        ).rejects.toBe(marker);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(admission).toHaveBeenCalledTimes(1);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          providerInvoked: true,
          coverageOnly: true,
          error: { kind: 'bad_request' },
        });
      });
    }
    for (const usage of [
      positive,
      zero,
      { kind: 'partial', known: { inputTokens: 7 }, reason: 'not_reported' },
      { kind: 'missing', reason: 'not_reported' },
    ] satisfies UsageEvidence[]) {
      it(`prices only complete predecessor evidence (${streaming}/${JSON.stringify(usage)})`, async () => {
        const tracker = new CostTracker(new Map([[model, price]]));
        const recordCost = vi.spyOn(tracker, 'record');
        const started = vi.fn();
        const records: AttemptRecord[] = [];
        let ordinal = 0;
        const admission = vi.fn();
        const chain = new FallbackChain(
          [{ provider: externalProvider(usage, started), model, maxAttempts: 2 }],
          {
            keyFor: () => 'offline',
            sleep: () => Promise.resolve(),
            preAttempt: admission,
            costTracker: tracker,
            beginUsageInvocation: () => Promise.resolve(identity(++ordinal)),
            onAttempt: (record) => records.push(record),
          },
        );
        await consume(chain, streaming, { model, messages: [] });
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({ invocation: identity(1), usage, coverageOnly: true });
        expect(records[1]).toMatchObject({ invocation: identity(2), usage: zero });
        expect(records[0]?.cost?.costMicrocents).toBe(
          usage.kind === 'complete'
            ? usage.usage.inputTokens + usage.usage.outputTokens
            : undefined,
        );
        expect(recordCost).toHaveBeenCalledTimes(usage.kind === 'complete' ? 2 : 1);
        expect(admission).toHaveBeenCalledTimes(2);
        expect(started).toHaveBeenCalledTimes(1);
      });
    }
    for (const unpriced of ['model', 'media'] as const) {
      it(`discloses unpriced ${unpriced} predecessor (${streaming})`, async () => {
        const usage: UsageEvidence =
          unpriced === 'media'
            ? {
                kind: 'complete',
                usage: {
                  inputTokens: 7,
                  outputTokens: 3,
                  mediaUnits: [{ modality: 'image', direction: 'output', units: 1, unit: 'count' }],
                },
              }
            : positive;
        const records: AttemptRecord[] = [];
        const chain = new FallbackChain(
          [{ provider: externalProvider(usage, () => undefined), model, maxAttempts: 1 }],
          {
            keyFor: () => 'offline',
            sleep: () => Promise.resolve(),
            costTracker: new CostTracker(
              unpriced === 'model' ? new Map() : new Map([[model, price]]),
            ),
            onAttempt: (record) => records.push(record),
          },
        );
        await consume(chain, streaming, { model, messages: [] });
        expect(records).toHaveLength(2);
        expect(records[0]?.priced).toBe(false);
        expect(records[0]?.cost?.costMicrocents).toBe(unpriced === 'model' ? undefined : 10);
      });
    }
    for (const observerFails of [false, true]) {
      it(`pricing failure keeps evidence once and prevents fresh admission (${streaming}/${observerFails})`, async () => {
        const marker = new Error('private pricing');
        const observer = new Error('private observer');
        const recordCost = vi.fn(() => {
          throw marker;
        });
        const started = vi.fn();
        const admission = vi.fn();
        const records: AttemptRecord[] = [];
        const options: FallbackChainOptions = {
          keyFor: () => 'offline',
          sleep: () => Promise.resolve(),
          preAttempt: admission,
          costTracker: { record: recordCost },
          onAttempt: (record) => {
            records.push(record);
            if (observerFails) throw observer;
          },
        };
        const chain = new FallbackChain(
          [{ provider: externalProvider(positive, started), model, maxAttempts: 2 }],
          options,
        );
        const call = consume(chain, streaming, { model, messages: [] });
        if (observerFails) await expect(call).rejects.toBe(observer);
        else
          await expect(call).rejects.toMatchObject({
            llmError: { kind: 'unknown', retryable: false, cause: marker },
          });
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          usage: positive,
          priced: false,
          error: { cause: marker },
        });
        expect(recordCost).toHaveBeenCalledTimes(1);
        expect(admission).toHaveBeenCalledTimes(1);
        expect(started).not.toHaveBeenCalled();
      });
    }
  }
});
