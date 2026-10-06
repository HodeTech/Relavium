import { describe, expect, it } from 'vitest';
import {
  CostTracker,
  FallbackChain,
  LlmProviderError,
  makeLlmError,
  type AttemptRecord,
  type LlmProvider,
  type LlmResult,
  type ModelPricing,
} from '@relavium/llm';
import { createAbortController } from './execution-host.js';
import { BudgetPauseError } from './budget-governor.js';
const model = 'round13-capture';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 4000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 3000000,
  cacheWritePerMtokMicrocents: 4000000,
  mediaOutputRates: { image: 11 },
};
describe('generated semantic projection before host pricing', () => {
  for (const projection of ['success', 'raw-fault', 'content-fault'] as const)
    for (const pricing of ['priced', 'failure', 'unpriced'] as const)
      it(projection + '/' + pricing + ' preserves observed facts and precedence', async () => {
        const marker = new BudgetPauseError(2, 9, 11),
          outputFault = new Error('PRIVATE projection'),
          order: string[] = [],
          records: AttemptRecord[] = [];
        let calls = 0;
        const part = { type: 'text' as const, text: 'original semantic output' };
        const quantity = {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
          mediaUnits: [
            {
              modality: 'image' as const,
              direction: 'output' as const,
              unit: 'count' as const,
              units: 2,
            },
          ],
        };
        const result: LlmResult = { content: [part], stopReason: 'stop', usage: quantity };
        Object.defineProperty(result, 'raw', {
          enumerable: true,
          get() {
            order.push('raw');
            if (projection === 'raw-fault') throw outputFault;
            return { opaque: true };
          },
        });
        if (projection === 'content-fault')
          Object.defineProperty(part, 'text', {
            enumerable: true,
            get() {
              order.push('text-fault');
              throw outputFault;
            },
          });
        class Overlay extends Map<string, ModelPricing> {
          override get(key: string): ModelPricing | undefined {
            order.push('pricing');
            if (projection !== 'content-fault') part.text = 'mutated pricing text';
            quantity.inputTokens = 999;
            quantity.mediaUnits[0]!.units = 999;
            if (pricing === 'failure') throw marker;
            return pricing === 'unpriced' ? undefined : super.get(key);
          }
        }
        const tracker = new CostTracker(new Overlay([[model, price]]));
        const provider: LlmProvider = {
          id: 'openai',
          customEndpoint: true,
          supports: {
            tools: false,
            streaming: true,
            parallelToolCalls: false,
            vision: false,
            promptCache: true,
            reasoning: false,
            media: {
              input: { image: false, audio: false, video: false, document: false },
              outputCombinations: [],
            },
          },
          generate: () => {
            calls++;
            return Promise.resolve(result);
          },
          stream: () => {
            throw new Error('unused');
          },
        };
        const chain = new FallbackChain([{ provider, model, maxAttempts: 3 }], {
          keyFor: () => 'synthetic',
          sleep: () => Promise.resolve(),
          costTracker: tracker,
          onAttempt: (r) => {
            order.push('attempt');
            records.push(r);
          },
          newAbortController: createAbortController,
          setTimer: () => () => {
            order.push('cleanup');
          },
        });
        const observed = await chain.generate({ model, messages: [] }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        expect(calls).toBe(1);
        expect(records).toHaveLength(1);
        expect(records[0]?.usage?.inputTokens).toBe(3);
        expect(records[0]?.usage?.mediaUnits?.[0]?.units).toBe(2);
        expect(order.indexOf(projection === 'content-fault' ? 'text-fault' : 'raw')).toBeLessThan(
          order.indexOf('pricing'),
        );
        expect(order.indexOf('pricing')).toBeLessThan(order.indexOf('cleanup'));
        expect(order.at(-1)).toBe('attempt');
        expect(tracker.cumulativeCostMicrocents).toBe(pricing === 'priced' ? 40 : 0);
        expect(records[0]?.cost?.costMicrocents).toBe(pricing === 'priced' ? 40 : undefined);
        if (projection === 'success' && pricing !== 'failure') {
          expect(observed.ok).toBe(true);
          if (observed.ok)
            expect(observed.value.content).toEqual([
              { type: 'text', text: 'original semantic output' },
            ]);
        } else {
          expect(observed.ok).toBe(false);
          if (!observed.ok) {
            expect(observed.error).toBeInstanceOf(LlmProviderError);
            expect(observed.error).toMatchObject({
              llmError: {
                kind: 'unknown',
                retryable: false,
                cause: pricing === 'failure' ? marker : outputFault,
              },
            });
          }
        }
      });
  for (const kind of ['transport', 'bad_request'] as const)
    it('genuine ' + kind + ' remains correctly classified and retryable', async () => {
      let calls = 0;
      const records: AttemptRecord[] = [];
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
          calls++;
          if (calls === 1)
            throw new LlmProviderError(
              makeLlmError({ provider: 'openai', kind, message: 'fixed provider diagnostic' }),
            );
          return Promise.resolve({
            content: [],
            stopReason: 'stop',
            usage: { inputTokens: 0, outputTokens: 0 },
          });
        },
        stream: () => {
          throw new Error('unused');
        },
      };
      const chain = new FallbackChain([{ provider, model, maxAttempts: 2 }], {
        keyFor: () => 'synthetic',
        sleep: () => Promise.resolve(),
        costTracker: new CostTracker(new Map([[model, price]])),
        onAttempt: (r) => records.push(r),
      });
      await chain.generate({ model, messages: [] }).catch(() => undefined);
      expect(calls).toBe(kind === 'transport' ? 2 : 1);
      expect(records[0]?.error?.kind).toBe(kind);
      if (kind === 'transport')
        expect(records[1]).toMatchObject({ outcome: 'succeeded', cost: { costMicrocents: 0 } });
    });
});
