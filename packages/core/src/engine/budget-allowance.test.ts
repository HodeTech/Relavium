import { it, expect, vi } from 'vitest';
// The controlled refresh and its consumers share the actual source catalog, not separate dist/source globals.
vi.mock('@relavium/llm', async () => import('../../../llm/src/index.js'));
import { clearCatalogRefresh, installCatalogRefresh } from '../../../llm/src/catalog/lookup.js';
import {
  estimateResolvedRequestCost,
  cost,
  FallbackChain,
  LlmProviderError,
  makeLlmError,
  InvalidTokenEstimateError,
  type LlmProvider,
  type LlmRequest,
  type ModelPricing,
  type ProviderId,
  type PricingOverlay,
  type FallbackPlanEntry,
  type CatalogModel,
  type StreamChunk,
} from '@relavium/llm';
import {
  quoteBudgetAllowance,
  budgetAllowancePricesMatch,
  sameBudgetAllowanceQuote,
  type AllowanceQuote,
  type AllowanceQuoteInput,
} from './budget-allowance.js';

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function truth(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function invalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    truth(error instanceof InvalidTokenEstimateError, 'expected typed estimate refusal');
    equal(error.reason, 'invalid_estimate');
    return;
  }
  throw new Error('expected invalid estimate refusal');
}
function price(patch: Partial<ModelPricing> = {}): ModelPricing {
  return {
    provider: 'openai',
    nativeId: 'review-model',
    displayName: 'review',
    contextWindowTokens: 1000000,
    maxOutputTokens: 1000000,
    inputPerMtokMicrocents: 1000000,
    outputPerMtokMicrocents: 1000000,
    cachedInputPerMtokMicrocents: 1,
    ...patch,
  };
}
function provider(id: ProviderId = 'openai', patch: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id,
    supports: {
      tools: true,
      streaming: true,
      parallelToolCalls: true,
      vision: true,
      promptCache: true,
      reasoning: true,
      media: {
        input: { image: true, document: true, audio: true, video: true },
        outputCombinations: [['text', 'image'], ['image'], ['audio'], ['video']],
      },
    },
    generate() {
      return Promise.resolve({
        model: 'review-model',
        content: [],
        stopReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
    async *stream(): AsyncIterable<StreamChunk> {
      await Promise.resolve();
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
    },
    ...patch,
  };
}
function textInput(
  patch: Partial<Extract<AllowanceQuoteInput, { route: 'text' }>> = {},
): Extract<AllowanceQuoteInput, { route: 'text' }> {
  return {
    route: 'text',
    entries: [{ provider: provider(), model: 'review-model', maxAttempts: 2 }],
    request: { model: 'review-model', messages: [], maxTokens: 10 },
    inputTokensEstimate: 1,
    maxTokensEstimate: undefined,
    maxToolTurns: 16,
    strictCostCap: false,
    overlay: new Map([['review-model', price()]]),
    ...patch,
  };
}
function quote(input: AllowanceQuoteInput): AllowanceQuote {
  const result = quoteBudgetAllowance(input);
  truth(result.kind === 'quoted', 'expected quote');
  return result.quote;
}
function priced(model: string, input: number, output: number, overlay: PricingOverlay) {
  const result = estimateResolvedRequestCost(model, input, output, [], overlay);
  truth(result.kind === 'priced', 'expected safe amount');
  return result;
}
const test = it;

test('copies finite media quantities before a pricing callback can mutate the original volume', () => {
  const entry = { modality: 'image' as const, units: 1 };
  class MutatingPrice extends Map<string, ModelPricing> {
    override get(key: string): ModelPricing | undefined {
      entry.units = Infinity;
      return super.get(key);
    }
  }
  const result = estimateResolvedRequestCost(
    'review-model',
    1,
    1,
    [entry],
    new MutatingPrice([['review-model', price({ mediaOutputRates: { image: 3 } })]]),
  );
  expect(result.kind).toBe('priced');
  if (result.kind !== 'priced') throw new Error('expected snapshotted price');
  expect(result.microcents).toBe(5);
  expect(result.basis.media).toEqual([{ modality: 'image', units: 1, rateMicrocents: 3 }]);
});

test('class rounding matches realized accounting', () => {
  const overlay = new Map([
    ['review-model', price({ inputPerMtokMicrocents: 500000, outputPerMtokMicrocents: 500000 })],
  ]);
  equal(priced('review-model', 1, 1, overlay).microcents, 2);
  equal(cost('review-model', { inputTokens: 1, outputTokens: 1 }, overlay).microcents, 2);
});
test('highest threshold, not largest numeric rates or array order', () => {
  const overlay = new Map([
    [
      'review-model',
      price({
        inputPerMtokMicrocents: 9000000,
        outputPerMtokMicrocents: 9000000,
        contextTiers: [
          {
            aboveContextTokens: 100,
            inputPerMtokMicrocents: 2000000,
            outputPerMtokMicrocents: 3000000,
          },
          {
            aboveContextTokens: 20,
            inputPerMtokMicrocents: 8000000,
            outputPerMtokMicrocents: 8000000,
          },
        ],
      }),
    ],
  ]);
  const result = priced('review-model', 1, 1, overlay);
  equal(result.microcents, 5);
  equal(result.basis.contextTierAboveTokens, 100);
  equal(result.basis.inputRateKind, 'non_cached');
});
test('one price lookup covers tokens, media and evidence', () => {
  let reads = 0;
  class CountingMap extends Map<string, ModelPricing> {
    override get(key: string): ModelPricing | undefined {
      reads++;
      return super.get(key);
    }
  }
  const overlay = new CountingMap([['review-model', price({ mediaOutputRates: { image: 3 } })]]);
  const result = estimateResolvedRequestCost(
    'review-model',
    1,
    2,
    [{ modality: 'image', units: 4 }],
    overlay,
  );
  equal(reads, 1);
  truth(result.kind === 'priced', 'priced');
  equal(result.microcents, 15);
  equal(result.basis.media[0]?.rateMicrocents, 3);
});
test('basis and nested arrays/entries are frozen', () => {
  const result = estimateResolvedRequestCost(
    'review-model',
    1,
    2,
    [{ modality: 'image', units: 1 }],
    new Map([['review-model', price()]]),
  );
  for (const v of [
    result,
    result.basis,
    result.basis.media,
    result.basis.media[0],
    result.unpricedModalities,
  ])
    truth(Object.isFrozen(v), 'all nested evidence frozen');
});
test('unknown model and priced zero are distinct', () => {
  const unknown = quoteBudgetAllowance(textInput({ overlay: new Map() }));
  equal(unknown.kind, 'unpriced');
  const zero = quote(
    textInput({
      overlay: new Map([
        ['review-model', price({ inputPerMtokMicrocents: 0, outputPerMtokMicrocents: 0 })],
      ]),
    }),
  );
  equal(zero.amount, { kind: 'representable', microcents: 0 });
});
test('heterogeneous raw caps bind separately including official DeepSeek modern-only fallback', () => {
  const entries: FallbackPlanEntry[] = ['openai', 'deepseek', 'anthropic', 'gemini'].map(
    (id, index) => ({
      provider: provider(
        index === 0 ? 'openai' : index === 1 ? 'deepseek' : index === 2 ? 'anthropic' : 'gemini',
      ),
      model: id,
      maxAttempts: index + 1,
    }),
  );
  const overlay = new Map(entries.map((entry) => [entry.model, price()]));
  const result = quote(
    textInput({
      entries,
      overlay,
      request: {
        model: 'openai',
        messages: [],
        providerOptions: { max_completion_tokens: 200000 },
      },
      maxTokensEstimate: 17,
      inputTokensEstimate: 3,
    }),
  );
  equal(
    result.provenance.entries.map((entry) => entry.estimate.basis.outputTokensReservation),
    [200000, 17, 4096, 17],
  );
  equal(result.provenance.attempts, 10);
  equal(result.amount, { kind: 'representable', microcents: 2000030 });
});
test('native cap remains above catalog ceiling through final quote', () => {
  const result = quote(
    textInput({
      entries: [{ provider: provider(), model: 'gpt-5.5', maxAttempts: 1 }],
      overlay: new Map([['gpt-5.5', price()]]),
      request: {
        model: 'gpt-5.5',
        messages: [],
        providerOptions: { max_completion_tokens: 500000 },
      },
      inputTokensEstimate: 2,
    }),
  );
  equal(result.provenance.entries[0]?.estimate.basis.outputTokensReservation, 500000);
  equal(result.amount, { kind: 'representable', microcents: 500002 });
});
test('tool loop uses lowered tools and inline route remains single-shot', () => {
  const tools: NonNullable<LlmRequest['tools']> = [
    { name: 'example', parameters: { type: 'object' } },
  ];
  equal(quote(textInput()).provenance.calls, 1);
  equal(
    quote(textInput({ request: { model: 'review-model', messages: [], maxTokens: 10, tools } }))
      .provenance.calls,
    17,
  );
  equal(
    quote(
      textInput({
        request: {
          model: 'review-model',
          messages: [],
          maxTokens: 10,
          outputModalities: ['text', 'image'],
        },
        mediaUnitsEstimate: [{ modality: 'image', units: 0 }],
      }),
    ).provenance.calls,
    1,
  );
});
test('text-stream skips and inline-generate eligibility differ', () => {
  const p = provider();
  const noStream = provider('openai', { supports: { ...p.supports, streaming: false } });
  const entries = [{ provider: noStream, model: 'review-model', maxAttempts: 2 }];
  const streamed = quoteBudgetAllowance(textInput({ entries }));
  truth(streamed.kind === 'unpriced', 'unpriced');
  equal(streamed.excludedEntries[0]?.reason, 'unsupported');
  const inline = quote(
    textInput({
      entries,
      request: { model: 'review-model', messages: [], maxTokens: 10, outputModalities: ['image'] },
    }),
  );
  equal(inline.provenance.attempts, 2);
});
test('per-model capability remains authoritative only on official endpoint', () => {
  const p: CatalogModel = {
    ...price(),
    modelId: 'review-capability',
    requestCapabilities: { toolCall: false },
  };
  installCatalogRefresh({ 'review-capability': p });
  try {
    const tools: NonNullable<LlmRequest['tools']> = [
      { name: 'example', parameters: { type: 'object' } },
    ];
    const request: LlmRequest = { model: 'review-capability', messages: [], tools, maxTokens: 10 };
    const base = textInput({
      request,
      entries: [{ model: 'review-capability', provider: provider(), maxAttempts: 1 }],
      overlay: new Map([['review-capability', price()]]),
    });
    const official = quoteBudgetAllowance(base);
    truth(official.kind === 'unpriced', 'unsupported');
    equal(official.excludedEntries[0]?.reason, 'unsupported');
    equal(
      quote({
        ...base,
        entries: [
          {
            model: 'review-capability',
            provider: provider('openai', { customEndpoint: true }),
            maxAttempts: 1,
          },
        ],
      }).provenance.entries.length,
      1,
    );
  } finally {
    clearCatalogRefresh();
  }
});
test('generative prices primary only with calls=attempts=1 and zero text', () => {
  const gen = provider('openai', {
    generateMedia() {
      return Promise.resolve({ jobId: 'job' });
    },
  });
  const result = quote({
    route: 'generative',
    entries: [
      { model: 'review-model', provider: gen, maxAttempts: 7 },
      { model: 'second', provider: provider(), maxAttempts: 9 },
    ],
    strictCostCap: false,
    mediaUnitsEstimate: [{ modality: 'image', units: 2 }],
    overlay: new Map([['review-model', price({ mediaOutputRates: { image: 19 } })]]),
  });
  equal(result.provenance.calls, 1);
  equal(result.provenance.attempts, 1);
  equal(result.provenance.entries.length, 1);
  equal(result.provenance.entries[0]?.estimate.basis.inputTokensEstimate, 0);
  equal(result.provenance.entries[0]?.estimate.basis.outputTokensReservation, 0);
  equal(result.amount, { kind: 'representable', microcents: 38 });
});
test('strict media gaps exclude; nonstrict keeps priced component; zero volume still gaps', () => {
  const input = textInput({ mediaUnitsEstimate: [{ modality: 'image', units: 0 }] });
  const result = quote(input);
  equal(result.provenance.entries[0]?.estimate.unpricedModalities, ['image']);
  equal(result.amount, { kind: 'representable', microcents: 22 });
  const strict = quoteBudgetAllowance({ ...input, strictCostCap: true });
  truth(strict.kind === 'unpriced', 'unpriced');
  equal(strict.excludedEntries[0]?.reason, 'unpriced_modality');
});
test('safe token/media components with unsafe final sum reject only', () => {
  const result = estimateResolvedRequestCost(
    'review-model',
    1,
    0,
    [{ modality: 'image', units: 1 }],
    new Map([
      [
        'review-model',
        price({
          inputPerMtokMicrocents: Number.MAX_SAFE_INTEGER * 1000000,
          mediaOutputRates: { image: 1 },
        }),
      ],
    ]),
  );
  equal(result.kind, 'unrepresentable');
});
test('safe per-attempt cost and unsafe aggregate A reject only', () => {
  const result = quote(
    textInput({
      inputTokensEstimate: 0,
      request: { model: 'review-model', messages: [], maxTokens: Number.MAX_SAFE_INTEGER },
    }),
  );
  equal(result.amount, { kind: 'unrepresentable' });
});
test('valid finite arithmetic overflow differs from invalid input', () => {
  const result = estimateResolvedRequestCost(
    'review-model',
    Number.MAX_VALUE,
    2,
    [],
    new Map([['review-model', price()]]),
  );
  equal(result.kind, 'unrepresentable');
  invalid(() =>
    estimateResolvedRequestCost('review-model', NaN, 2, [], new Map([['review-model', price()]])),
  );
  invalid(() =>
    estimateResolvedRequestCost('review-model', 1, -1, [], new Map([['review-model', price()]])),
  );
});
test('known media quantity malformed values fail typed and without raw echo', () => {
  for (const units of [NaN, Infinity, -1])
    invalid(() =>
      estimateResolvedRequestCost(
        'review-model',
        1,
        1,
        [{ modality: 'image', units }],
        new Map([['review-model', price()]]),
      ),
    );
});
test('changing price, tier threshold or excluded-model pricedness changes serialized quote evidence', () => {
  const input = textInput({
    entries: [
      { provider: provider(), model: 'review-model', maxAttempts: 2 },
      { provider: provider(), model: 'unpriced-review', maxAttempts: 1 },
    ],
  });
  const old = quote(input);
  const change = quote({
    ...input,
    overlay: new Map([
      ['review-model', price()],
      ['unpriced-review', price()],
    ]),
  });
  truth(
    JSON.stringify(old) !== JSON.stringify(change),
    'new price on excluded entry must be visible',
  );
  equal(old.excludedEntries[0]?.reason, 'unpriced_model');
  equal(change.provenance.entries.length, 2);
  const changedRate = quote({
    ...input,
    overlay: new Map([['review-model', price({ inputPerMtokMicrocents: 2000000 })]]),
  });
  truth(JSON.stringify(old) !== JSON.stringify(changedRate), 'changed rate must be visible');
});

test('CR-55 unusable media rates stay named gaps for zero and positive assumed volume', () => {
  for (const rate of [-1, NaN, Infinity])
    for (const units of [0, 1]) {
      const overlay = new Map([['review-model', price({ mediaOutputRates: { image: rate } })]]);
      const estimate = estimateResolvedRequestCost(
        'review-model',
        1,
        1,
        [{ modality: 'image', units }],
        overlay,
      );
      truth(estimate.kind === 'priced', 'priced token part');
      equal(estimate.microcents, 2);
      equal(estimate.unpricedModalities, ['image']);
      equal(estimate.basis.media, [{ modality: 'image', units }]);
      const strict = quoteBudgetAllowance(
        textInput({
          overlay,
          mediaUnitsEstimate: [{ modality: 'image', units }],
          strictCostCap: true,
        }),
      );
      truth(strict.kind === 'unpriced', 'strict must keep unpriced modality exclusion');
      equal(strict.excludedEntries[0]?.reason, 'unpriced_modality');
    }
});
test('malformed media quantities refuse even when the model has no price', () => {
  for (const units of [NaN, Infinity, -1])
    invalid(() =>
      quoteBudgetAllowance(
        textInput({ overlay: new Map(), mediaUnitsEstimate: [{ modality: 'image', units }] }),
      ),
    );
});

test('actual stream-chain skip and inline-generate selection match quote', async () => {
  const ordinary = provider();
  const silent = provider('openai', { supports: { ...ordinary.supports, streaming: false } });
  const entries = [
    { model: 'first', provider: silent, maxAttempts: 1 },
    { model: 'second', provider: provider('gemini'), maxAttempts: 1 },
  ];
  const overlay = new Map([
    ['first', price()],
    ['second', price()],
  ]);
  const input = textInput({
    entries,
    overlay,
    request: { model: 'first', messages: [], maxTokens: 10 },
  });
  const quoted = quote(input);
  equal(
    quoted.provenance.entries.map((entry) => entry.index),
    [1],
  );
  const records: { model: string; outcome: string }[] = [];
  const chain = new FallbackChain(entries, {
    keyFor: () => 'synthetic-review-only',
    sleep: async () => {},
    onAttempt: (r) => records.push({ model: r.model, outcome: r.outcome }),
  });
  for await (const chunk of chain.stream(input.request)) {
    void chunk;
  }
  equal(records, [
    { model: 'first', outcome: 'skipped' },
    { model: 'second', outcome: 'succeeded' },
  ]);
  const inline = {
    ...input,
    request: { ...input.request, outputModalities: ['image'] },
  } satisfies AllowanceQuoteInput;
  equal(
    quote(inline).provenance.entries.map((entry) => entry.index),
    [0, 1],
  );
  records.length = 0;
  await chain.generate(inline.request);
  equal(records, [{ model: 'first', outcome: 'succeeded' }]);
});
test('actual chain cooldown does not exclude priced candidate from allowance', async () => {
  const first = provider('openai', {
    generate() {
      throw new LlmProviderError(
        makeLlmError({
          provider: 'openai',
          kind: 'rate_limit',
          message: 'synthetic rate limit',
          status: 429,
        }),
      );
    },
  });
  const entries = [
    { model: 'first', provider: first, maxAttempts: 1 },
    { model: 'second', provider: provider('gemini'), maxAttempts: 1 },
  ];
  const records: { model: string; outcome: string }[] = [];
  const chain = new FallbackChain(entries, {
    keyFor: () => 'synthetic-review-only',
    sleep: async () => {},
    now: () => 0,
    onAttempt: (r) => records.push({ model: r.model, outcome: r.outcome }),
  });
  const request: LlmRequest = { model: 'first', messages: [], maxTokens: 10 };
  await chain.generate(request);
  equal(records, [
    { model: 'first', outcome: 'failed' },
    { model: 'second', outcome: 'succeeded' },
  ]);
  records.length = 0;
  await chain.generate(request);
  equal(records, [
    { model: 'first', outcome: 'skipped' },
    { model: 'second', outcome: 'succeeded' },
  ]);
  const result = quote(
    textInput({
      entries,
      request,
      overlay: new Map([
        ['first', price({ outputPerMtokMicrocents: 9000000 })],
        ['second', price()],
      ]),
    }),
  );
  equal(
    result.provenance.entries.map((entry) => entry.model),
    ['first', 'second'],
  );
  equal(result.provenance.attempts, 2);
  equal(result.amount, { kind: 'representable', microcents: 182 });
});

it('compares the entire frozen basis even when every monetary amount stays zero', () => {
  const row = price({ inputPerMtokMicrocents: 0, outputPerMtokMicrocents: 0 });
  const input = textInput({ overlay: new Map([['review-model', row]]) });
  const baseline = quoteBudgetAllowance(input);
  expect(sameBudgetAllowanceQuote(baseline, quoteBudgetAllowance(input))).toBe(true);
  const changedInputs: AllowanceQuoteInput[] = [
    { ...input, inputTokensEstimate: 2 },
    { ...input, request: { ...input.request, maxTokens: 20 } },
    { ...input, entries: [{ model: 'review-model', provider: provider(), maxAttempts: 3 }] },
    {
      ...input,
      entries: [
        {
          model: 'review-model',
          provider: provider('openai', { customEndpoint: true }),
          maxAttempts: 2,
        },
      ],
    },
    {
      ...input,
      entries: [{ model: 'review-model', provider: provider('deepseek'), maxAttempts: 2 }],
    },
    {
      ...input,
      request: { ...input.request, tools: [{ name: 'example', parameters: { type: 'object' } }] },
    },
    { ...input, mediaUnitsEstimate: [{ modality: 'image', units: 0 }] },
    {
      ...input,
      overlay: new Map([
        [
          'review-model',
          {
            ...row,
            contextTiers: [
              { aboveContextTokens: 50, inputPerMtokMicrocents: 0, outputPerMtokMicrocents: 0 },
            ],
          },
        ],
      ]),
    },
  ];
  for (const changed of changedInputs) {
    const current = quoteBudgetAllowance(changed);
    expect(current.kind).toBe('quoted');
    if (current.kind !== 'quoted') throw new Error('expected comparison quote');
    expect(current.quote.amount).toEqual({ kind: 'representable', microcents: 0 });
    expect(sameBudgetAllowanceQuote(baseline, current)).toBe(false);
  }
});

it('detects a newly priced excluded entry and a zero-volume media gap without relying on A', () => {
  const row = price({ inputPerMtokMicrocents: 0, outputPerMtokMicrocents: 0 });
  const input = textInput({
    entries: [
      { model: 'review-model', provider: provider(), maxAttempts: 1 },
      { model: 'excluded', provider: provider(), maxAttempts: 1 },
    ],
    overlay: new Map([['review-model', row]]),
  });
  const before = quoteBudgetAllowance(input);
  const current = quoteBudgetAllowance({
    ...input,
    overlay: new Map([
      ['review-model', row],
      ['excluded', row],
    ]),
  });
  expect(sameBudgetAllowanceQuote(before, current)).toBe(false);
  const media = { ...input, mediaUnitsEstimate: [{ modality: 'image', units: 0 }] as const };
  expect(
    sameBudgetAllowanceQuote(
      quoteBudgetAllowance(media),
      quoteBudgetAllowance({
        ...media,
        overlay: new Map([['review-model', { ...row, mediaOutputRates: { image: 0 } }]]),
      }),
    ),
  ).toBe(false);
});

it('compares finite values without invoking a serializer and normalizes negative zero equality', () => {
  const input = textInput({ inputTokensEstimate: 0 });
  const baseline = quoteBudgetAllowance(input);
  const current = quoteBudgetAllowance({ ...input, inputTokensEstimate: -0 });
  expect(sameBudgetAllowanceQuote(baseline, current)).toBe(true);
});

it('selects the highest finite context threshold even beyond the safe integer sentinel', () => {
  for (const threshold of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const overlay = new Map([
      [
        'review-model',
        price({
          contextTiers: [
            {
              aboveContextTokens: threshold,
              inputPerMtokMicrocents: 9000000,
              outputPerMtokMicrocents: 9000000,
            },
          ],
        }),
      ],
    ]);
    const result = estimateResolvedRequestCost('review-model', 1, 1, [], overlay);
    expect(result.kind).toBe('priced');
    if (result.kind !== 'priced') throw new Error('expected finite-tier quote');
    expect(result.microcents).toBe(18);
    expect(result.basis.contextTierAboveTokens).toBe(threshold);
    expect(cost('review-model', { inputTokens: 1, outputTokens: 1 }, overlay).microcents).toBe(2);
  }
});

it('early price refusal detects rate drift even when rounded A is unchanged', () => {
  const input = textInput();
  const frozen = quoteBudgetAllowance(input);
  const currentPrices = new Map([['review-model', price({ inputPerMtokMicrocents: 1000001 })]]);
  const current = quoteBudgetAllowance({ ...input, overlay: currentPrices });
  expect(frozen.kind).toBe('quoted');
  expect(current.kind).toBe('quoted');
  if (frozen.kind !== 'quoted' || current.kind !== 'quoted') throw new Error('missing quote');
  expect(frozen.quote.amount).toEqual(current.quote.amount);
  expect(budgetAllowancePricesMatch(frozen, input.overlay)).toBe(true);
  expect(budgetAllowancePricesMatch(frozen, currentPrices)).toBe(false);
});

it('early pricing preserves resolved output quantities and detects a zero-volume media price change', () => {
  const row = price({ maxOutputTokens: 1 });
  const input = textInput({
    request: { model: 'review-model', messages: [], providerOptions: { max_tokens: 250000 } },
    mediaUnitsEstimate: [{ modality: 'image', units: 0 }],
    overlay: new Map([['review-model', row]]),
  });
  const frozen = quoteBudgetAllowance(input);
  expect(frozen.kind).toBe('quoted');
  if (frozen.kind !== 'quoted') throw new Error('missing quote');
  expect(frozen.quote.provenance.entries[0]?.estimate.basis.outputTokensReservation).toBe(250000);
  expect(budgetAllowancePricesMatch(frozen, input.overlay)).toBe(true);
  expect(
    budgetAllowancePricesMatch(
      frozen,
      new Map([['review-model', { ...row, mediaOutputRates: { image: 0 } }]]),
    ),
  ).toBe(false);
  expect(budgetAllowancePricesMatch(frozen, new Map())).toBe(false);
});

it('an early price match never replaces complete eligibility validation', () => {
  const input = textInput({
    entries: [
      { model: 'review-model', provider: provider(), maxAttempts: 1 },
      { model: 'newly-priced', provider: provider(), maxAttempts: 1 },
    ],
  });
  const frozen = quoteBudgetAllowance(input);
  const currentPrices = new Map([
    ['review-model', price()],
    ['newly-priced', price()],
  ]);
  expect(budgetAllowancePricesMatch(frozen, currentPrices)).toBe(true);
  expect(
    sameBudgetAllowanceQuote(frozen, quoteBudgetAllowance({ ...input, overlay: currentPrices })),
  ).toBe(false);
});
