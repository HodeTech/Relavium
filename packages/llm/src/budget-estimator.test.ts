import { describe, expect, it } from 'vitest';

import { estimateMaxNextCost } from './budget-estimator.js';
import { MODEL_PRICING } from './pricing.js';

describe('estimateMaxNextCost', () => {
  it('estimates output-only worst case at maxTokens', () => {
    const model = MODEL_PRICING['claude-sonnet-4-6'];
    // 10_000 output tokens @ $15/MTok = 150_000 micro-cents
    expect(estimateMaxNextCost('claude-sonnet-4-6', 10_000)).toBe(
      Math.round((10_000 * model.outputPerMtokMicrocents) / 1_000_000),
    );
  });

  it('returns 0 for non-positive maxTokens', () => {
    expect(estimateMaxNextCost('claude-sonnet-4-6', 0)).toBe(0);
    expect(estimateMaxNextCost('claude-sonnet-4-6', -1)).toBe(0);
  });

  it('throws UnknownModelError for an unlisted model', () => {
    expect(() => estimateMaxNextCost('not-a-real-model', 1_000)).toThrow('unknown model id');
  });

  it('uses the cheaper mini rate for a mini model', () => {
    const model = MODEL_PRICING['gpt-5.4-mini'];
    expect(estimateMaxNextCost('gpt-5.4-mini', 100_000)).toBe(
      Math.round((100_000 * model.outputPerMtokMicrocents) / 1_000_000),
    );
  });
});
