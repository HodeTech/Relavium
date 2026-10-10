import { describe, expect, it } from 'vitest';
import {
  CostTracker,
  FallbackChain,
  LlmProviderError,
  type AttemptRecord,
  type LlmProvider,
  type LlmResult,
  type ModelPricing,
} from '@relavium/llm';

const model = 'pricing-projection-precedence';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 1000,
  maxOutputTokens: 20,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 1000000,
};

describe('generated projection failure retains known accounting and pricing precedence', () => {
  for (const pricingThrows of [false, true]) {
    it(`a failed content projection still invokes pricing once, pricingThrows=${pricingThrows}`, async () => {
      const projectionFault = new Error('PRIVATE projection failure');
      const pricingFault = new Error('PRIVATE pricing failure');
      const usage = { inputTokens: 2, outputTokens: 3 };
      let contentReads = 0;
      let pricingReads = 0;
      let calls = 0;
      const result: LlmResult = {
        get content(): LlmResult['content'] {
          contentReads++;
          throw projectionFault;
        },
        stopReason: 'stop',
        usage,
      };
      const prices = new Map([[model, price]]);
      prices.get = () => {
        pricingReads++;
        usage.inputTokens = 9999;
        if (pricingThrows) throw pricingFault;
        return price;
      };
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
            outputCombinations: [['text']],
          },
        },
        generate: () => {
          calls++;
          return Promise.resolve(result);
        },
        stream: () => {
          throw new Error('unexpected stream dispatch');
        },
      };
      const records: AttemptRecord[] = [];
      const chain = new FallbackChain([{ provider, model, maxAttempts: 2 }], {
        keyFor: () => 'offline-synthetic',
        sleep: () => Promise.resolve(),
        costTracker: new CostTracker(prices),
        onAttempt: (record) => records.push(record),
      });
      let escaped: unknown;
      try {
        await chain.generate({ model, messages: [] });
      } catch (error) {
        escaped = error;
      }
      expect(escaped).toBeInstanceOf(LlmProviderError);
      if (!(escaped instanceof LlmProviderError)) throw new Error('missing typed seam failure');
      expect(
        Object.is(escaped.llmError.cause, pricingThrows ? pricingFault : projectionFault),
      ).toBe(true);
      expect(calls).toBe(1);
      expect(contentReads).toBe(1);
      expect(pricingReads).toBe(1);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        contentReceived: true,
        providerInvoked: true,
        outcome: 'failed',
        usage: { inputTokens: 2, outputTokens: 3 },
        error: { kind: 'unknown', retryable: false },
      });
      if (pricingThrows) {
        expect(records[0]?.priced).toBe(false);
        expect(records[0]?.cost).toBeUndefined();
      } else {
        expect(records[0]?.cost?.costMicrocents).toBe(8);
        expect(records[0]?.priced).toBeUndefined();
      }
      expect(JSON.stringify(records)).not.toContain('PRIVATE');
    });
  }
});
