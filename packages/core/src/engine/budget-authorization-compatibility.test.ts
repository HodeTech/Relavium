import { expect, it } from 'vitest';
import { estimateResolvedRequestCost, type ModelPricing, type LlmProvider } from '@relavium/llm';
import { quoteBudgetAllowance } from './budget-allowance.js';
import {
  AllowanceQuoteResultSchema,
  BudgetAllowanceStateSchema,
  BudgetMicrocentsSchema,
  ResolvedRequestEstimateSchema,
  type AllowanceQuoteResult,
  type ResolvedRequestEstimate,
} from '@relavium/shared';
const MODEL = 'authorization-compatibility-model';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 1e6,
  maxOutputTokens: 1e6,
  inputPerMtokMicrocents: 1e6,
  outputPerMtokMicrocents: 1e6,
  cachedInputPerMtokMicrocents: 0,
};
const provider: LlmProvider = {
  id: 'openai',
  customEndpoint: true,
  supports: {
    streaming: true,
    tools: false,
    parallelToolCalls: false,
    vision: false,
    promptCache: false,
    reasoning: false,
    media: {
      input: { image: false, audio: false, video: false, document: false },
      outputCombinations: [],
    },
  },
  generate: () => Promise.reject(new Error('no egress')),
  stream: () => {
    throw new Error('no egress');
  },
};
const prices = new Map([[MODEL, price]]);
function quote(overlay = prices, input = 2) {
  return quoteBudgetAllowance({
    route: 'text',
    entries: [{ provider, model: MODEL, maxAttempts: 2 }],
    request: { model: MODEL, messages: [], maxTokens: 3 },
    inputTokensEstimate: input,
    maxTokensEstimate: undefined,
    maxToolTurns: 0,
    strictCostCap: false,
    overlay,
  });
}
it('actual kernel scalar output assigns to the inferred canonical shape and parses with readonly ownership', () => {
  const estimate: ResolvedRequestEstimate = estimateResolvedRequestCost(
    MODEL,
    2.5,
    3,
    [{ modality: 'image', units: 0 }],
    prices,
  );
  const parsed = ResolvedRequestEstimateSchema.parse(estimate);
  expect(parsed).toEqual(estimate);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.basis)).toBe(true);
  expect(Object.isFrozen(parsed.basis.media)).toBe(true);
  expect(Object.isFrozen(parsed.basis.media[0])).toBe(true);
});
it('actual frozen quote assigns to the inferred shape without duplicating construction or pricing', () => {
  const original: AllowanceQuoteResult = quote();
  const parsed = AllowanceQuoteResultSchema.parse(original);
  expect(parsed).toEqual(original);
  expect(parsed).toMatchObject({
    kind: 'quoted',
    quote: { amount: { kind: 'representable', microcents: 10 } },
  });
  if (parsed.kind !== 'quoted') throw new Error('expected quoted');
  expect(Object.isFrozen(parsed.quote.provenance.entries[0]?.estimate.basis)).toBe(true);
});
it('unsafe arithmetic keeps finite large provenance but omits the monetary amount', () => {
  const parsed = AllowanceQuoteResultSchema.parse(quote(prices, Number.MAX_VALUE));
  expect(parsed).toMatchObject({ kind: 'quoted', quote: { amount: { kind: 'unrepresentable' } } });
  if (parsed.kind !== 'quoted') throw new Error('expected quote');
  expect(Object.hasOwn(parsed.quote.amount, 'microcents')).toBe(false);
});
it('unpriced and genuinely zero quotes are structurally distinct', () => {
  expect(AllowanceQuoteResultSchema.parse(quote(new Map()))).toMatchObject({
    kind: 'unpriced',
    excludedEntries: [{ reason: 'unpriced_model' }],
  });
  expect(
    AllowanceQuoteResultSchema.parse(
      quote(
        new Map([[MODEL, { ...price, inputPerMtokMicrocents: 0, outputPerMtokMicrocents: 0 }]]),
      ),
    ),
  ).toMatchObject({ kind: 'quoted', quote: { amount: { kind: 'representable', microcents: 0 } } });
});
for (const amount of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5])
  it(`unsafe/malformed approved microcents ${amount} cannot become authority`, () => {
    expect(BudgetMicrocentsSchema.safeParse(amount).success).toBe(false);
  });
it('unrepresentable markers and scalar quote objects refuse accidental raw/private data', () => {
  const original = quote();
  if (original.kind !== 'quoted') throw new Error('expected quote');
  expect(
    AllowanceQuoteResultSchema.safeParse({
      ...original,
      quote: { ...original.quote, amount: { kind: 'unrepresentable', microcents: 0 } },
    }).success,
  ).toBe(false);
  expect(
    AllowanceQuoteResultSchema.safeParse({
      ...original,
      quote: { ...original.quote, providerOptions: { private: 'synthetic' } },
    }).success,
  ).toBe(false);
});
it('legacy no-allowance contains neither an invented zero nor an implicit quote', () => {
  expect(BudgetAllowanceStateSchema.parse({ kind: 'legacy_no_allowance' })).toEqual({
    kind: 'legacy_no_allowance',
  });
  expect(
    BudgetAllowanceStateSchema.safeParse({ kind: 'legacy_no_allowance', microcents: 0 }).success,
  ).toBe(false);
});
