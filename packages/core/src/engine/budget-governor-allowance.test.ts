import { describe, expect, it } from 'vitest';
import {
  InvalidTokenEstimateError,
  prepareOutputCapPlan,
  type LlmProvider,
  type LlmRequest,
  type ModelPricing,
  type PricingOverlay,
} from '@relavium/llm';
import {
  BudgetGovernor,
  BudgetPauseError,
  type BudgetAdmission,
  type GovernorEventDraft,
} from './budget-governor.js';
import type { PreEgressInfo } from './agent-turn.js';
import type { AllowanceQuoteContext } from './budget-allowance.js';

const MODEL = 'w7-dispatch-owned-cost';
const row: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 1000000,
  maxOutputTokens: 1000000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 0,
};
const prices: PricingOverlay = new Map([[MODEL, row]]);
type Options = ConstructorParameters<typeof BudgetGovernor>[0];
function governor(patch: Partial<Options> = {}): BudgetGovernor {
  return new BudgetGovernor({
    budget: { max_cost_microcents: 1000, on_exceed: 'pause_for_approval' },
    resolvePrice: prices,
    emit: () => Promise.resolve(),
    ...patch,
  });
}
function info(input = 1, output = 1, model = MODEL): PreEgressInfo {
  const plan = prepareOutputCapPlan({
    model,
    provider: 'openai',
    endpoint: 'custom',
    maxTokens: output,
    providerOptions: undefined,
  });
  return {
    ...plan,
    route: 'text',
    inputTokensEstimate: input,
    maxTokensEstimate: undefined,
    outputCapPlan: plan,
  };
}
function owner(
  gov: BudgetGovernor,
  amount: number,
  node = 'n',
  dispatchId = 1,
  isLive = () => true,
) {
  return gov.activateDispatchAllowance({
    nodeId: node,
    dispatchId,
    amountMicrocents: amount,
    isLive,
  });
}
async function admit(
  gov: BudgetGovernor,
  request: PreEgressInfo,
  token: ReturnType<typeof owner>,
): Promise<BudgetAdmission> {
  const lease = await gov.checkPreEgress(request, token);
  expect(lease).toBeDefined();
  if (lease === undefined) throw new Error('expected owned admission');
  return lease;
}
function latch() {
  let resolve = (): void => {
    throw new Error('uninitialized latch');
  };
  let reject: (error: unknown) => void = () => {
    throw new Error('uninitialized latch');
  };
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const observe = (promise: Promise<BudgetAdmission | undefined>) =>
  promise.then(
    (admission) => ({ kind: 'admitted', admission }) as const,
    (error: unknown) => ({ kind: 'refused', error }) as const,
  );

for (const cap of [0, 1, 1000])
  it(`debits every owned call under cap=${cap} and never grants unlimited redispatch`, async () => {
    const gov = governor({ budget: { max_cost_microcents: cap, on_exceed: 'pause_for_approval' } });
    const token = owner(gov, 5);
    for (let i = 0; i < 2; i++) (await admit(gov, info(), token)).settle(2);
    await expect(gov.checkPreEgress(info(), token)).rejects.toMatchObject({
      code: 'budget_exceeded',
      reason: 'allowance_exhausted',
    });
    await expect(gov.checkPreEgress(info(0, 0), token)).rejects.toMatchObject({
      reason: 'allowance_exhausted',
    });
  });

it('refunds underspend and proven pre-egress release, but retains uncertain spend once', async () => {
  const gov = governor();
  const token = owner(gov, 10);
  const first = await admit(gov, info(0, 8), token);
  first.settle(3);
  first.release();
  first.settle(0);
  expect(gov.dispatchAllowanceState(token)?.remaining).toBe(7);
  const second = await admit(gov, info(0, 7), token);
  second.release();
  second.release();
  expect(gov.dispatchAllowanceState(token)?.remaining).toBe(7);
  const third = await admit(gov, info(0, 7), token);
  third.settleAtReservedEstimate({ nodeId: 'n', attemptNumber: 3 });
  third.release();
  await gov.flushCommitments();
  expect(gov.conservativeCostMicrocents).toBe(7);
  await expect(gov.checkPreEgress(info(0, 1), token)).rejects.toMatchObject({
    reason: 'allowance_exhausted',
  });
});

it('allows only one final realized overrun and prevents every subsequent priced or unpriced call', async () => {
  const gov = governor();
  const token = owner(gov, 10);
  let actual = 0;
  for (const [estimate, realized] of [
    [2, 3],
    [2, 3],
    [2, 3],
    [1, 2],
  ]) {
    if (estimate === undefined || realized === undefined) throw new Error('invalid fixture');
    (await admit(gov, info(0, estimate), token)).settle(realized);
    actual += realized;
  }
  expect(actual).toBe(11);
  expect(actual).toBeLessThanOrEqual(10 + 1);
  for (const request of [info(0, 0), info(0, 1), info(0, 0, 'unknown')]) {
    await expect(gov.checkPreEgress(request, token)).rejects.toMatchObject({
      reason: 'allowance_exhausted',
    });
  }
});

it('isolates approved siblings, ordinary siblings and abandoned-dispatch stragglers', async () => {
  const gov = governor({ budget: { max_cost_microcents: 50, on_exceed: 'pause_for_approval' } });
  const old = owner(gov, 8, 'a');
  const oldLease = await admit(gov, info(0, 8), old);
  const next = owner(gov, 4, 'a', 2),
    other = owner(gov, 3, 'b');
  oldLease.settle(100);
  expect(gov.dispatchAllowanceState(next)?.remaining).toBe(4);
  await expect(gov.checkPreEgress(info(0, 0), old)).rejects.toMatchObject({
    reason: 'allowance_owner_invalid',
  });
  await expect(gov.checkPreEgress(info(0, 1))).rejects.toMatchObject({
    code: 'budget_paused',
    spentMicrocents: 100,
  });
  (await admit(gov, info(0, 4), next)).settle(4);
  (await admit(gov, info(0, 3), other)).settle(3);
  await expect(gov.checkPreEgress(info(0, 1), next)).rejects.toMatchObject({
    reason: 'allowance_exhausted',
  });
});

for (const known of [true, false])
  it(`holds single-flight through settlement predicate; global actual=${known}`, async () => {
    const gov = governor({ budget: { max_cost_microcents: 2, on_exceed: 'pause_for_approval' } });
    let reenter = false;
    let nested: ReturnType<typeof observe> | undefined;
    const token = owner(gov, 4, 'n', 1, () => {
      if (reenter) {
        reenter = false;
        nested = observe(gov.checkPreEgress(info(0, 0), token));
      }
      return true;
    });
    const lease = await admit(gov, known ? info(0, 2) : info(0, 0, 'unknown'), token);
    reenter = true;
    lease.settle(3);
    if (nested === undefined) throw new Error('missing reentrant attempt');
    const outcome = await nested;
    expect(outcome).toMatchObject({ kind: 'refused', error: { reason: 'allowance_in_flight' } });
    expect(gov.dispatchAllowanceState(token)).toMatchObject({ remaining: 1, inFlight: false });
    await expect(gov.checkPreEgress(info(0, 0))).rejects.toMatchObject({
      code: 'budget_paused',
      spentMicrocents: 3,
    });
  });

it('updates global actual before a settlement callback admits an ordinary sibling', async () => {
  const gov = governor({ budget: { max_cost_microcents: 2, on_exceed: 'pause_for_approval' } });
  let reenter = false;
  let nested: ReturnType<typeof observe> | undefined;
  const token = owner(gov, 4, 'n', 1, () => {
    if (reenter) {
      reenter = false;
      nested = observe(gov.checkPreEgress(info(0, 0)));
    }
    return true;
  });
  const lease = await admit(gov, info(0, 1), token);
  reenter = true;
  lease.settle(3);
  if (nested === undefined) throw new Error('missing reentrant sibling');
  expect(await nested).toMatchObject({
    kind: 'refused',
    error: { code: 'budget_paused', spentMicrocents: 3 },
  });
});

for (const kind of ['zero', 'unknown'] as const)
  it(`preserves ${kind} ownership without inventing a positive commitment`, async () => {
    const events: GovernorEventDraft[] = [];
    const gov = governor({
      emit: (e) => {
        events.push(e);
        return Promise.resolve();
      },
    });
    const token = owner(gov, 0);
    const request = kind === 'zero' ? info(0, 0) : info(0, 0, 'unknown');
    const lease = await admit(gov, request, token);
    expect(lease.reservedMicrocents).toBe(kind === 'zero' ? 0 : undefined);
    await expect(gov.checkPreEgress(request, token)).rejects.toMatchObject({
      reason: 'allowance_in_flight',
    });
    lease.settleAtReservedEstimate({ nodeId: 'n' });
    await gov.flushCommitments();
    expect(events).toEqual([]);
    expect(gov.conservativeCostMicrocents).toBe(0);
    (await admit(gov, request, token)).settle(1);
    await expect(gov.checkPreEgress(info(0, 0, 'unknown'), token)).rejects.toMatchObject({
      reason: 'allowance_exhausted',
    });
  });

for (const unknown of [true, false])
  it(`an allowance never overrides strict unpriced ${unknown ? 'model' : 'modality'} refusal`, async () => {
    const gov = governor({
      budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval', strict_cost_cap: true },
    });
    const token = owner(gov, 100);
    const request = unknown
      ? info(0, 0, 'unknown')
      : { ...info(), mediaUnitsEstimate: [{ modality: 'image', units: 0 }] as const };
    await expect(gov.checkPreEgress(request, token)).rejects.toMatchObject({
      reason: unknown ? 'unpriced_model' : 'unpriced_modality',
    });
    expect(gov.dispatchAllowanceState(token)).toMatchObject({ remaining: 100, inFlight: false });
  });

for (const sameOwner of [true, false])
  it(`notice reentry sees both owner debit and global reservation, sameOwner=${sameOwner}`, async () => {
    let nested: ReturnType<typeof observe> | undefined;
    const request = {
      ...info(0, 600),
      mediaUnitsEstimate: [{ modality: 'image', units: 0 }] as const,
    };
    const gov: BudgetGovernor = governor({
      budget: { max_cost_microcents: 1000, on_exceed: 'fail' },
      onUnpriced: () => {
        nested = observe(gov.checkPreEgress(request, sameOwner ? token : undefined));
      },
    });
    const token = owner(gov, 1200);
    const lease = await admit(gov, request, token);
    if (nested === undefined) throw new Error('missing reentrant notice');
    expect(await nested).toMatchObject({
      kind: 'refused',
      error: { reason: sameOwner ? 'allowance_in_flight' : 'projected_over_cap' },
    });
    expect(gov.dispatchAllowanceState(token)?.remaining).toBe(600);
    lease.release();
  });

it('refuses a reentrant notice takeover and returns no authority or debit to the successor', async () => {
  let next: ReturnType<typeof owner> | undefined;
  const gov: BudgetGovernor = governor({
    onUnpriced: () => {
      gov.closeDispatchAllowance(token);
      next = owner(gov, 3, 'n', 2);
    },
  });
  const token = owner(gov, 10);
  await expect(
    gov.checkPreEgress({ ...info(), mediaUnitsEstimate: [{ modality: 'image', units: 0 }] }, token),
  ).rejects.toMatchObject({ reason: 'allowance_owner_invalid' });
  if (next === undefined) throw new Error('missing successor');
  expect(gov.dispatchAllowanceState(next)).toMatchObject({ remaining: 3, inFlight: false });
  expect(gov.evaluatePreEgress(info(0, 999))).toMatchObject({ kind: 'allow' });
});

for (const failed of [true, false])
  it(`warning wait revalidates lifetime or rolls back after persistence failure=${failed}`, async () => {
    const write = latch();
    let live = true;
    const gov = governor({
      budget: { max_cost_microcents: 1, on_exceed: 'warn' },
      emit: () => write.promise,
    });
    const token = owner(gov, 10, 'n', 1, () => live);
    const pending = observe(gov.checkPreEgress(info(0, 2), token));
    await Promise.resolve();
    expect(gov.dispatchAllowanceState(token)).toMatchObject({ remaining: 8, inFlight: true });
    if (failed) write.reject(new Error('synthetic warning disk failure'));
    else {
      live = false;
      write.resolve();
    }
    try {
      const result = await pending;
      expect(result.kind).toBe('refused');
      expect(gov.dispatchAllowanceState(token)).toMatchObject(
        failed ? { remaining: 10, inFlight: false } : { closed: true, inFlight: false },
      );
    } finally {
      write.resolve();
      await pending;
    }
  });

it('cannot issue ownership after a conservative durability wait loses its dispatch', async () => {
  const write = latch();
  const gov = governor({ emit: () => write.promise });
  gov.reserveAcceptedCost(MODEL, 3)?.settleAtReservedEstimate({ nodeId: 'previous' });
  const token = owner(gov, 10);
  const pending = observe(gov.checkPreEgress(info(), token));
  gov.closeDispatchAllowance(token);
  write.resolve();
  try {
    expect(await pending).toMatchObject({
      kind: 'refused',
      error: { reason: 'allowance_owner_invalid' },
    });
  } finally {
    write.resolve();
    await pending;
    await gov.flushCommitments();
  }
});

it('cannot issue ownership after a legacy job hold loses its dispatch', async () => {
  const gov = governor();
  gov.registerLegacyMediaJob('old-job');
  const token = owner(gov, 10);
  const pending = observe(gov.checkPreEgress(info(), token));
  gov.closeDispatchAllowance(token);
  gov.clearLegacyMediaJob('old-job');
  try {
    expect(await pending).toMatchObject({
      kind: 'refused',
      error: { reason: 'allowance_owner_invalid' },
    });
  } finally {
    gov.releaseAllLegacyMediaJobHolds();
    await pending;
  }
});

it('preserves a reservation after malformed actual settlement so conservative fallback can close it', async () => {
  const gov = governor();
  const token = owner(gov, 10);
  const lease = await admit(gov, info(0, 8), token);
  expect(() => lease.settle(NaN)).toThrow(InvalidTokenEstimateError);
  expect(gov.dispatchAllowanceState(token)).toMatchObject({ remaining: 2, inFlight: true });
  lease.settleAtReservedEstimate();
  await gov.flushCommitments();
  expect(gov.conservativeCostMicrocents).toBe(8);
  (await admit(gov, info(0, 2), token)).release();
});

it('unrepresentable owned E fails closed once without creating another pause', async () => {
  const gov = governor();
  const token = owner(gov, 10);
  await expect(gov.checkPreEgress(info(Number.MAX_VALUE, 1), token)).rejects.toMatchObject({
    code: 'budget_exceeded',
    reason: 'unrepresentable_estimate',
  });
  await expect(gov.checkPreEgress(info(0, 0), token)).rejects.toMatchObject({
    reason: 'allowance_exhausted',
  });
});

describe('paused construction quote witness', () => {
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      vision: false,
      reasoning: false,
      promptCache: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [],
      },
    },
    generate: () => {
      throw new Error('unexpected egress');
    },
    stream: () => {
      throw new Error('unexpected egress');
    },
  };
  for (const unsafe of [true, false])
    it(`freezes a ${unsafe ? 'reject-only' : 'representable'} quote with no raw request in the gate`, async () => {
      const gov = governor({ budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval' } });
      const request: LlmRequest = {
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'must-not-enter-quote' }] }],
        maxTokens: 2,
      };
      const input = unsafe ? Number.MAX_VALUE : 3;
      const context: AllowanceQuoteContext = {
        route: 'text',
        entries: [{ model: MODEL, provider, maxAttempts: 2 }],
        request,
        inputTokensEstimate: input,
        maxTokensEstimate: undefined,
        maxToolTurns: 16,
      };
      let error: unknown;
      try {
        await gov.checkPreEgress({ ...info(input, 2), allowanceQuoteContext: context });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(BudgetPauseError);
      if (!(error instanceof BudgetPauseError)) throw new Error('missing pause');
      const quoted = error.allowanceQuote;
      expect(quoted?.kind).toBe('quoted');
      if (quoted?.kind !== 'quoted') throw new Error('missing quote witness');
      expect(quoted.quote.amount).toEqual(
        unsafe ? { kind: 'unrepresentable' } : { kind: 'representable', microcents: 10 },
      );
      expect(error.toGateRequest().allowanceQuote).toBe(quoted);
      expect(JSON.stringify(quoted)).not.toContain('must-not-enter-quote');
      expect(Object.isFrozen(quoted.quote.provenance.entries[0]?.estimate.basis)).toBe(true);
    });
});

for (const rate of [-1, NaN, Infinity])
  for (const units of [0, 1]) {
    it(`keeps unusable media rate ${rate} at volume ${units} on the established gap policy`, async () => {
      const overlay: PricingOverlay = new Map([
        [MODEL, { ...row, mediaOutputRates: { image: rate } }],
      ]);
      const notices: unknown[] = [];
      const nonstrict = governor({
        resolvePrice: overlay,
        onUnpriced: (_model, _cap, modalities) => notices.push(modalities),
      });
      const request = { ...info(), mediaUnitsEstimate: [{ modality: 'image', units }] as const };
      const lease = await nonstrict.checkPreEgress(request);
      expect(lease?.reservedMicrocents).toBe(2);
      expect(notices).toEqual([['image']]);
      lease?.release();
      const strict = governor({
        resolvePrice: overlay,
        budget: {
          max_cost_microcents: 1000,
          on_exceed: 'pause_for_approval',
          strict_cost_cap: true,
        },
      });
      await expect(strict.checkPreEgress(request)).rejects.toMatchObject({
        reason: 'unpriced_modality',
      });
    });
  }

for (const mode of ['fail', 'pause_for_approval', 'warn'] as const) {
  it(`announces a partial gap even when unsafe cost refuses ${mode} admission`, async () => {
    const notices: unknown[] = [];
    const gov = governor({
      budget: { max_cost_microcents: 1, on_exceed: mode },
      onUnpriced: (_model, _cap, modalities) => notices.push(modalities),
    });
    await expect(
      gov.checkPreEgress({
        ...info(Number.MAX_VALUE, 1),
        mediaUnitsEstimate: [{ modality: 'image', units: 0 }],
      }),
    ).rejects.toMatchObject({
      code: mode === 'pause_for_approval' ? 'budget_paused' : 'budget_exceeded',
    });
    expect(notices).toEqual([['image']]);
    expect(gov.conservativeCostMicrocents).toBe(0);
  });
}
