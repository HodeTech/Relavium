import { describe, expect, it } from 'vitest';
import {
  CostTracker,
  FallbackChain,
  makeLlmError,
  type AttemptRecord,
  type LlmProvider,
  type ModelPricing,
  type StreamChunk,
  type Usage,
} from './index.js';

const MODEL = 'r9-held-price';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 20000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
  cacheWritePerMtokMicrocents: 1000000,
  mediaOutputRates: { image: 13 },
};

describe('independently designed held-terminal controls', () => {
  for (const ending of ['eof', 'throw', 'duplicate'] as const)
    for (const quantity of ['nonzero', 'zero', 'unpriced'] as const)
      it(
        ending + '/' + quantity + ' observes owned usage before confirming provider read',
        async () => {
          const raw: Usage = {
            inputTokens: quantity === 'zero' ? 0 : 2,
            outputTokens: quantity === 'zero' ? 0 : 3,
            cacheReadTokens: quantity === 'zero' ? 0 : 1,
            cacheWriteTokens: quantity === 'zero' ? 0 : 2,
            mediaUnits: [
              {
                modality: 'image',
                direction: 'output',
                unit: 'count',
                units: quantity === 'zero' ? 0 : 4,
              },
            ],
          };
          const records: AttemptRecord[] = [];
          let calls = 0;
          const provider: LlmProvider = {
            id: 'openai',
            customEndpoint: true,
            supports: {
              tools: false,
              streaming: true,
              parallelToolCalls: false,
              vision: false,
              promptCache: false,
              reasoning: false,
              media: {
                input: { image: false, audio: false, video: false, document: false },
                outputCombinations: [],
              },
            },
            generate: () => {
              throw new Error('unexpected generate');
            },
            stream: async function* (): AsyncGenerator<StreamChunk> {
              await Promise.resolve();
              calls++;
              yield { type: 'text_delta', text: 'committed paid response' };
              yield { type: 'stop', stopReason: 'stop', usage: raw };
              Object.assign(raw, {
                inputTokens: 90,
                outputTokens: 90,
                cacheReadTokens: 90,
                cacheWriteTokens: 90,
              });
              if (raw.mediaUnits?.[0] !== undefined)
                Object.assign(raw.mediaUnits[0], { units: 90 });
              if (ending === 'throw') throw new Error('private teardown');
              if (ending === 'duplicate')
                yield { type: 'stop', stopReason: 'tool_use', usage: raw };
            },
          };
          const tracker = new CostTracker(
            quantity === 'unpriced' ? new Map() : new Map([[MODEL, price]]),
          );
          const chain = new FallbackChain([{ provider, model: MODEL, maxAttempts: 2 }], {
            keyFor: () => 'synthetic-no-key',
            sleep: () => Promise.resolve(),
            costTracker: tracker,
            onAttempt: (record) => {
              records.push(record);
              if (record.error !== undefined) {
                try {
                  Object.assign(record.error, {
                    retryable: true,
                    message: 'private observer replacement',
                  });
                } catch {
                  /* frozen observation */
                }
              }
            },
          });
          const chunks: StreamChunk[] = [];
          for await (const c of chain.stream({
            model: MODEL,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
          }))
            chunks.push(c);
          expect(calls).toBe(1);
          expect(records).toHaveLength(1);
          if (ending === 'duplicate') {
            expect(records[0]?.usage).toBeUndefined();
            expect(records[0]).toMatchObject({
              outcome: 'failed',
              providerInvoked: true,
              contentReceived: true,
            });
          } else
            expect(records[0]?.usage).toMatchObject({
              inputTokens: quantity === 'zero' ? 0 : 2,
              outputTokens: quantity === 'zero' ? 0 : 3,
              cacheReadTokens: quantity === 'zero' ? 0 : 1,
              cacheWriteTokens: quantity === 'zero' ? 0 : 2,
              mediaUnits: [
                {
                  modality: 'image',
                  direction: 'output',
                  unit: 'count',
                  units: quantity === 'zero' ? 0 : 4,
                },
              ],
            });
          if (ending === 'duplicate') expect(records[0]?.cost).toBeUndefined();
          else if (quantity === 'unpriced') expect(records[0]?.priced).toBe(false);
          else expect(records[0]?.cost?.costMicrocents).toBe(quantity === 'zero' ? 0 : 60);
          if (ending === 'duplicate')
            expect(chunks.at(-1)).toMatchObject({
              type: 'error',
              error: { kind: 'protocol', retryable: false, contentCommitted: true },
            });
          else expect(chunks.at(-1)).toMatchObject({ type: 'stop', stopReason: 'stop' });
          expect(JSON.stringify(chunks)).not.toContain('private');
        },
      );

  for (const ending of ['eof', 'throw', 'duplicate'] as const)
    it(
      'held diagnostic/' + ending + ' cannot mutate decision after confirming read or observer',
      async () => {
        const diagnostic = makeLlmError({
          provider: 'openai',
          kind: 'bad_request',
          message: 'canonical diagnostic',
        });
        const provider: LlmProvider = {
          id: 'openai',
          customEndpoint: true,
          supports: {
            tools: false,
            streaming: true,
            parallelToolCalls: false,
            vision: false,
            promptCache: false,
            reasoning: false,
            media: {
              input: { image: false, audio: false, video: false, document: false },
              outputCombinations: [],
            },
          },
          generate: () => {
            throw new Error('unexpected generate');
          },
          stream: async function* (): AsyncGenerator<StreamChunk> {
            await Promise.resolve();
            yield { type: 'error', error: diagnostic };
            Object.assign(diagnostic, {
              kind: 'timeout',
              retryable: true,
              message: 'private provider replacement',
            });
            if (ending === 'throw') throw new Error('private teardown');
            if (ending === 'duplicate') yield { type: 'error', error: diagnostic };
          },
        };
        let records = 0;
        const chain = new FallbackChain([{ provider, model: MODEL, maxAttempts: 1 }], {
          keyFor: () => 'synthetic-no-key',
          sleep: () => Promise.resolve(),
          onAttempt: (record) => {
            records++;
            expect(Object.isFrozen(record.error)).toBe(true);
            try {
              Object.assign(record.error ?? {}, {
                kind: 'auth',
                retryable: true,
                message: 'private observer replacement',
              });
            } catch {
              /* frozen observation */
            }
          },
        });
        const chunks: StreamChunk[] = [];
        for await (const c of chain.stream({
          model: MODEL,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        }))
          chunks.push(c);
        expect(records).toBe(1);
        expect(chunks.at(-1)).toMatchObject({
          type: 'error',
          error: { kind: ending === 'duplicate' ? 'protocol' : 'bad_request', retryable: false },
        });
        expect(JSON.stringify(chunks)).not.toContain('private');
      },
    );
});
