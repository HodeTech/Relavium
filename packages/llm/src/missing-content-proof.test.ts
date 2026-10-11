import { expect, it } from 'vitest';
import type { UsageEvidence } from '@relavium/shared';
import { createOpenAiAdapter } from './adapters/openai.js';
import { FallbackChain, type AttemptRecord } from './fallback-chain.js';
import { LlmProviderError, makeLlmError } from './llm-error.js';
import type { LlmError, LlmInvocationOptions, LlmProvider, StreamChunk } from './types.js';

const missing: UsageEvidence = { kind: 'missing', reason: 'not_reported' };
const zero: UsageEvidence = { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
const evidenceCases = [
  { label: 'omitted', usage: undefined },
  { label: 'missing', usage: missing },
  {
    label: 'partial',
    usage: { kind: 'partial', known: { inputTokens: 7 }, reason: 'missing_fields' },
  },
  {
    label: 'partial-zero',
    usage: { kind: 'partial', known: { inputTokens: 0 }, reason: 'missing_fields' },
  },
  { label: 'complete-zero', usage: zero },
] satisfies { label: string; usage: UsageEvidence | undefined }[];

async function consume(chain: FallbackChain, streaming: boolean): Promise<LlmError | undefined> {
  if (!streaming) {
    try {
      await chain.generate({ model: 'primary', messages: [] });
      return undefined;
    } catch (error) {
      if (error instanceof LlmProviderError) return error.llmError;
      throw error;
    }
  }
  for await (const chunk of chain.stream({ model: 'primary', messages: [] }))
    if (chunk.type === 'error') return chunk.error;
  return undefined;
}

for (const streaming of [false, true])
  for (const customEndpoint of [false, true])
    for (const nativeRepair of [false, true])
      for (const { label, usage } of evidenceCases)
        it(`${streaming ? 'stream' : 'generate'} ${customEndpoint ? 'custom' : 'official'} ${nativeRepair ? 'native predecessor' : 'direct'} ${label} owns content proof`, async () => {
          const records: AttemptRecord[] = [];
          const cause = new Error('private original cause');
          const error: LlmError = {
            ...makeLlmError({
              provider: 'openai',
              kind: 'bad_request',
              status: 400,
              message: 'pre-content refusal',
              cause,
            }),
            ...(usage === undefined ? {} : { usage }),
            // A provider's flag is not chain-owned proof of content.
            contentCommitted: true,
          };
          let calls = 0;
          const repair = async (options?: LlmInvocationOptions): Promise<void> => {
            await options?.beforeNativeRetry?.(error);
            options?.nativeInvocationStarted?.();
            calls++;
          };
          const provider: LlmProvider = {
            ...createOpenAiAdapter(),
            customEndpoint,
            generate: async (_request, _key, options) => {
              calls++;
              if (!nativeRepair) throw new LlmProviderError(error);
              await repair(options);
              return { content: [], stopReason: 'stop', usage: zero };
            },
            stream: async function* (_request, _key, options): AsyncGenerator<StreamChunk> {
              calls++;
              if (!nativeRepair) {
                yield { type: 'error', error };
                return;
              }
              await repair(options);
              yield { type: 'stop', stopReason: 'stop', usage: zero };
            },
          };
          const chain = new FallbackChain([{ provider, model: 'primary', maxAttempts: 1 }], {
            keyFor: () => 'offline',
            sleep: () => Promise.resolve(),
            onAttempt: (record) => records.push(record),
          });
          const failure = await consume(chain, streaming);
          expect(calls).toBe(nativeRepair ? 2 : 1);
          expect(records).toHaveLength(nativeRepair ? 2 : 1);
          const hasObservation = usage !== undefined && usage.kind !== 'missing';
          expect(records[0]).toMatchObject({
            providerInvoked: true,
            customEndpoint,
            contentReceived: (nativeRepair || !streaming) && hasObservation,
            usage: usage ?? missing,
            error: { kind: 'bad_request', status: 400, message: 'pre-content refusal', cause },
          });
          if (nativeRepair) {
            expect(failure).toBeUndefined();
            expect(records[1]).toMatchObject({ providerInvoked: true, usage: zero });
          } else {
            expect(failure).toMatchObject({
              kind: 'bad_request',
              retryable: false,
              status: 400,
              cause,
            });
            expect(failure?.contentCommitted).toBe(!streaming && hasObservation ? true : undefined);
          }
        });

for (const { streaming, visible } of [
  { streaming: false, visible: false },
  { streaming: true, visible: false },
  { streaming: true, visible: true },
])
  for (const explicit of [false, true]) {
    it(`${streaming ? 'stream' : 'generate'} transport ${explicit ? 'missing' : 'omitted'} ${visible ? 'visible content' : 'pre-content'} preserves failover`, async () => {
      const records: AttemptRecord[] = [];
      let primaryCalls = 0,
        fallbackCalls = 0;
      const error: LlmError = {
        ...makeLlmError({ provider: 'openai', kind: 'transport', message: 'connection lost' }),
        ...(explicit ? { usage: missing } : {}),
      };
      const primary: LlmProvider = {
        ...createOpenAiAdapter(),
        generate: () => {
          primaryCalls++;
          return Promise.reject(new LlmProviderError(error));
        },
        stream: async function* (): AsyncGenerator<StreamChunk> {
          primaryCalls++;
          await Promise.resolve();
          if (visible) yield { type: 'text_delta', text: 'visible' };
          yield { type: 'error', error };
        },
      };
      const fallback: LlmProvider = {
        ...createOpenAiAdapter(),
        generate: () => {
          fallbackCalls++;
          return Promise.resolve({ content: [], stopReason: 'stop', usage: zero });
        },
        stream: async function* (): AsyncGenerator<StreamChunk> {
          fallbackCalls++;
          await Promise.resolve();
          yield { type: 'stop', stopReason: 'stop', usage: zero };
        },
      };
      const chain = new FallbackChain(
        [
          { provider: primary, model: 'primary', maxAttempts: 1 },
          { provider: fallback, model: 'fallback', maxAttempts: 1 },
        ],
        {
          keyFor: () => 'offline',
          sleep: () => Promise.resolve(),
          onAttempt: (record) => records.push(record),
        },
      );
      const failure = await consume(chain, streaming);
      expect(primaryCalls).toBe(1);
      expect(fallbackCalls).toBe(visible ? 0 : 1);
      expect(records[0]).toMatchObject({ contentReceived: visible, usage: missing });
      if (visible) expect(failure).toMatchObject({ kind: 'transport', contentCommitted: true });
      else expect(failure).toBeUndefined();
    });
  }

for (const streaming of [false, true])
  it(`resolved ${streaming ? 'stream' : 'generate'} with missing usage remains processed`, async () => {
    const records: AttemptRecord[] = [];
    const provider: LlmProvider = {
      ...createOpenAiAdapter(),
      generate: () => Promise.resolve({ content: [], stopReason: 'stop', usage: missing }),
      stream: async function* (): AsyncGenerator<StreamChunk> {
        await Promise.resolve();
        yield { type: 'text_delta', text: '' };
        yield { type: 'stop', stopReason: 'stop', usage: missing };
      },
    };
    const chain = new FallbackChain([{ provider, model: 'primary', maxAttempts: 1 }], {
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      onAttempt: (record) => records.push(record),
    });
    expect(await consume(chain, streaming)).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ contentReceived: true, usage: missing });
  });
