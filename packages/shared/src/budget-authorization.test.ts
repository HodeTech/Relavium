import { expect, it } from 'vitest';
import {
  BudgetAuthorizationStateSchema,
  AllowanceQuoteResultSchema,
} from './budget-authorization.js';
import { deepStructuralEquals } from './deep-equal.js';
const basis = {
  inputTokensEstimate: 2,
  outputTokensReservation: 3,
  inputRateKind: 'non_cached',
  inputPerMtokMicrocents: 1e6,
  outputPerMtokMicrocents: 1e6,
  media: [],
};
const quoted = AllowanceQuoteResultSchema.parse({
  kind: 'quoted',
  quote: {
    amount: { kind: 'representable', microcents: 10 },
    provenance: {
      version: 1,
      route: 'text',
      calls: 1,
      attempts: 2,
      entries: [
        {
          index: 0,
          model: 'offline',
          provider: 'openai',
          endpoint: 'custom',
          attempts: 2,
          estimate: { kind: 'priced', microcents: 5, basis, unpricedModalities: [] },
        },
      ],
    },
    excludedEntries: [],
  },
});
const allowance = { kind: 'frozen', quote: quoted };
const decision = {
  state: 'decided',
  allowance,
  decision: 'approved',
  decidedBy: 'maintainer',
  approvedAmountMicrocents: 10,
};
it('known amount requires exact acknowledgement and remains deeply readonly', () => {
  const state = BudgetAuthorizationStateSchema.parse(decision);
  expect(state).toMatchObject(decision);
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.allowance)).toBe(true);
});
it('observational spend and authored limits retain the existing finite integer range without becoming grants', () => {
  const paused = {
    state: 'paused',
    allowance: { kind: 'legacy_no_allowance' },
    spentMicrocents: Number.MAX_SAFE_INTEGER + 1,
    limitMicrocents: Number.MAX_SAFE_INTEGER + 2,
  };
  expect(BudgetAuthorizationStateSchema.parse(paused)).toEqual(paused);
  expect(
    BudgetAuthorizationStateSchema.safeParse({
      ...decision,
      approvedAmountMicrocents: Number.MAX_SAFE_INTEGER + 1,
    }).success,
  ).toBe(false);
});
for (const amount of [undefined, 0, 9, 11, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 10.5]) {
  it(`mismatching or invalid acknowledgement ${amount} refuses`, () => {
    expect(
      BudgetAuthorizationStateSchema.safeParse({ ...decision, approvedAmountMicrocents: amount })
        .success,
    ).toBe(false);
  });
}
it('genuine zero is approvable only with explicit zero acknowledgement', () => {
  if (quoted.kind !== 'quoted') throw new Error('expected quote');
  const entries = quoted.quote.provenance.entries.map((entry) => ({
    ...entry,
    estimate: {
      ...entry.estimate,
      kind: 'priced',
      microcents: 0,
      basis: { ...entry.estimate.basis, inputPerMtokMicrocents: 0, outputPerMtokMicrocents: 0 },
    },
  }));
  const free = {
    ...decision,
    allowance: {
      kind: 'frozen',
      quote: {
        ...quoted,
        quote: {
          ...quoted.quote,
          amount: { kind: 'representable', microcents: 0 },
          provenance: { ...quoted.quote.provenance, entries },
        },
      },
    },
    approvedAmountMicrocents: 0,
  };
  expect(BudgetAuthorizationStateSchema.safeParse(free).success).toBe(true);
  expect(
    BudgetAuthorizationStateSchema.safeParse({ ...free, approvedAmountMicrocents: undefined })
      .success,
  ).toBe(false);
});
it('legacy approval grants neither implicit zero nor an amount', () => {
  const legacy = {
    ...decision,
    allowance: { kind: 'legacy_no_allowance' },
    approvedAmountMicrocents: undefined,
  };
  expect(BudgetAuthorizationStateSchema.safeParse(legacy).success).toBe(true);
  expect(
    BudgetAuthorizationStateSchema.safeParse({ ...legacy, approvedAmountMicrocents: 0 }).success,
  ).toBe(false);
});
it('unrepresentable and unpriced authorizations remain reject-only', () => {
  if (quoted.kind !== 'quoted') throw new Error('expected quote');
  for (const result of [
    { ...quoted, quote: { ...quoted.quote, amount: { kind: 'unrepresentable' } } },
    {
      kind: 'unpriced',
      excludedEntries: [
        {
          index: 0,
          model: 'offline',
          provider: 'openai',
          endpoint: 'custom',
          reason: 'unpriced_model',
        },
      ],
    },
  ]) {
    const unsafe = {
      ...decision,
      allowance: { kind: 'frozen', quote: result },
      approvedAmountMicrocents: undefined,
    };
    expect(BudgetAuthorizationStateSchema.safeParse(unsafe).success).toBe(false);
    expect(
      BudgetAuthorizationStateSchema.safeParse({ ...unsafe, decision: 'rejected' }).success,
    ).toBe(true);
  }
});
it('rejection cannot carry an amount and input_provided cannot become authority', () => {
  expect(
    BudgetAuthorizationStateSchema.safeParse({ ...decision, decision: 'rejected' }).success,
  ).toBe(false);
  expect(
    BudgetAuthorizationStateSchema.safeParse({
      ...decision,
      decision: 'rejected',
      approvedAmountMicrocents: undefined,
    }).success,
  ).toBe(true);
  expect(
    BudgetAuthorizationStateSchema.safeParse({ ...decision, decision: 'input_provided' }).success,
  ).toBe(false);
});
it('authority keeps the complete absolute deadline tuple, including immediate zero timeout', () => {
  const paused = { state: 'paused', allowance, spentMicrocents: 2, limitMicrocents: 1 };
  expect(BudgetAuthorizationStateSchema.safeParse(paused).success).toBe(true);
  const deadline = {
    timeoutMs: 0,
    timeoutAction: 'reject',
    expiresAt: '2026-10-03T01:00:00.000+03:00',
  };
  expect(BudgetAuthorizationStateSchema.parse({ ...paused, ...deadline })).toMatchObject(deadline);
  for (const partial of [
    { timeoutMs: 1 },
    { timeoutAction: 'reject' },
    { expiresAt: deadline.expiresAt },
    { timeoutMs: 1, timeoutAction: 'approve' },
  ])
    expect(BudgetAuthorizationStateSchema.parse({ ...paused, ...partial })).toMatchObject(partial);
});
it('private fields and process-local capabilities cannot ride in authority', () => {
  expect(
    BudgetAuthorizationStateSchema.safeParse({
      ...decision,
      providerOptions: { private: 'synthetic' },
    }).success,
  ).toBe(false);
  expect(
    BudgetAuthorizationStateSchema.safeParse({
      ...decision,
      allowance: { ...allowance, token: {} },
    }).success,
  ).toBe(false);
});
it('legacy authority preserves historical partial deadlines without inventing an expiry', () => {
  const legacy = {
    state: 'paused',
    allowance: { kind: 'legacy_no_allowance' },
    spentMicrocents: 2,
    limitMicrocents: 1,
    timeoutMs: 100,
  };
  expect(BudgetAuthorizationStateSchema.parse(legacy)).toEqual(legacy);
});
it('JSON persistence preserves the identity of a genuine zero price with negative-zero scalar inputs', () => {
  if (quoted.kind !== 'quoted') throw new Error('expected quote');
  const first = quoted.quote.provenance.entries[0];
  if (first === undefined) throw new Error('expected entry');
  const zero = AllowanceQuoteResultSchema.parse({
    ...quoted,
    quote: {
      ...quoted.quote,
      amount: { kind: 'representable', microcents: -0 },
      provenance: {
        ...quoted.quote.provenance,
        entries: [
          {
            ...first,
            index: -0,
            estimate: {
              ...first.estimate,
              microcents: -0,
              basis: {
                ...first.estimate.basis,
                inputTokensEstimate: -0,
                outputTokensReservation: -0,
                inputPerMtokMicrocents: -0,
                outputPerMtokMicrocents: -0,
              },
            },
          },
        ],
      },
    },
  });
  const raw: unknown = JSON.parse(JSON.stringify(zero));
  expect(deepStructuralEquals(zero, AllowanceQuoteResultSchema.parse(raw))).toBe(true);
});
