import { expect, it } from 'vitest';
import {
  InvalidTokenEstimateError,
  prepareOutputCapPlan,
  type LlmProvider,
  type ModelPricing,
  type PricingOverlay,
} from '@relavium/llm';
import { createAgentNodeExecutor, takeMediaJobAdmission } from './agent-runner.js';
import { BudgetGovernor, type GovernorEventDraft } from './budget-governor.js';
import type { PreEgressInfo } from './agent-turn.js';
import type { NodeExecContext, NodeStreamEvent } from './node-executor.js';
import type { SettledAttemptDraft } from './money-durability.js';
import type { AgentPlanConfig } from '../run-plan.js';

const MODEL = 'w7-runner-settlement';
function price(patch: Partial<ModelPricing> = {}): ModelPricing {
  return {
    provider: 'openai',
    nativeId: MODEL,
    displayName: MODEL,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 1_000_000,
    inputPerMtokMicrocents: 0,
    outputPerMtokMicrocents: 1_000_000,
    cachedInputPerMtokMicrocents: 0,
    mediaOutputRates: { image: 4 },
    ...patch,
  };
}
function provider(patch: Partial<LlmProvider> = {}): LlmProvider {
  return {
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
        outputCombinations: [['image']],
      },
    },
    generate: () =>
      Promise.resolve({
        content: [],
        stopReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 1 },
      }),
    async *stream() {
      await Promise.resolve();
      yield { type: 'text_delta', text: 'offline' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 1 } };
    },
    generateMedia: () =>
      Promise.resolve({
        media: { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aW1n' } },
        raw: {},
      }),
    ...patch,
  };
}
function setup(overlay: PricingOverlay, media: boolean, amount = 16, maxTokens = 1) {
  const durable: GovernorEventDraft[] = [];
  const events: NodeStreamEvent[] = [];
  const records: SettledAttemptDraft[] = [];
  const governor = new BudgetGovernor({
    budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval' },
    resolvePrice: overlay,
    emit: (event) => {
      durable.push(event);
      return Promise.resolve();
    },
  });
  const token = governor.activateDispatchAllowance({
    nodeId: 'work',
    dispatchId: 1,
    amountMicrocents: amount,
    isLive: () => true,
  });
  const config: AgentPlanConfig = {
    kind: 'agent',
    resolvedAgent: { id: 'agent', provider: 'openai', model: MODEL, system_prompt: 'offline' },
    node: {
      id: 'work',
      type: 'agent',
      agent_ref: 'agent',
      prompt_template: 'offline',
      max_tokens: maxTokens,
      ...(media ? { output_modalities: ['image'], count: 2 } : {}),
    },
  };
  const ctx: NodeExecContext = {
    vertex: {
      id: 'work',
      type: 'agent',
      dependencies: [],
      dependents: [],
      ancestors: [],
      inputSites: [],
      config,
    },
    runOutputs: new Map(),
    inputs: {},
    ctx: {},
    secretInputNames: new Set(),
    toolPolicy: {},
    emit: (event) => {
      events.push(event);
    },
    signal: new AbortController().signal,
    attemptNumber: 1,
    preEgress: (info) => governor.checkPreEgress(info, token),
    money: {
      record: (draft) => {
        records.push(draft);
      },
      join: () => governor.flushCommitments(),
    },
  };
  const execute = (
    p: LlmProvider,
    context = ctx,
    keyFor: () => Promise<string> | string = () => 'offline-synthetic-key',
  ) =>
    createAgentNodeExecutor({
      resolveProvider: () => p,
      resolvePrice: overlay,
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => Promise.reject(new Error('unexpected tool dispatch')),
      },
      tools: [],
      keyFor,
      sleep: () => Promise.resolve(),
      now: () => 0,
      ...(media ? { resolveMediaSurface: () => 'generative' as const } : {}),
    }).execute(context);
  return { governor, token, ctx, durable, events, records, execute };
}
function zeroInfo(): PreEgressInfo {
  const plan = prepareOutputCapPlan({
    model: MODEL,
    provider: 'openai',
    endpoint: 'custom',
    maxTokens: 0,
    providerOptions: undefined,
  });
  return {
    ...plan,
    route: 'text',
    inputTokensEstimate: 0,
    maxTokensEstimate: undefined,
    outputCapPlan: plan,
  };
}

it('unsafe actual text cost conserves E exactly once and releases the in-flight slot before throwing', async () => {
  const overlay = new Map([[MODEL, price({ outputPerMtokMicrocents: 1_000_000_000_000_000 })]]);
  const test = setup(overlay, false, 2_000_000_000);
  let calls = 0;
  await expect(
    test.execute(
      provider({
        async *stream() {
          await Promise.resolve();
          calls += 1;
          yield { type: 'text_delta', text: 'billed' };
          yield {
            type: 'stop',
            stopReason: 'stop',
            usage: { inputTokens: 0, outputTokens: 10_000_000 },
          };
        },
      }),
    ),
  ).rejects.toBeInstanceOf(InvalidTokenEstimateError);
  await test.governor.flushCommitments();
  expect(calls).toBe(1);
  expect(test.governor.conservativeCostMicrocents).toBe(1_000_000_000);
  expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
    remaining: 1_000_000_000,
    inFlight: false,
  });
  expect(test.durable).toMatchObject([
    {
      type: 'budget:estimate_committed',
      nodeId: 'work',
      attemptNumber: 1,
      estimateMicrocents: 1_000_000_000,
    },
  ]);
  expect(test.durable).toHaveLength(1);
  expect(test.events.filter((event) => event.type === 'cost:updated')).toEqual([]);
  expect(test.records).toEqual([]);
  expect(test.governor.evaluatePreEgress(zeroInfo())).toMatchObject({
    kind: 'pause',
    error: { spentMicrocents: 0 },
  });
});

const priceChanges = [
  'missing-model',
  'missing-rate',
  'negative-rate',
  'nan-rate',
  'infinite-rate',
  'throwing',
  'unsafe',
] as const;
for (const change of priceChanges) {
  it(`post-egress media ${change} retains E without inventing realized spend`, async () => {
    const prices = new Map([[MODEL, price()]]);
    let accepted = false;
    class Overlay extends Map<string, ModelPricing> {
      override get(model: string): ModelPricing | undefined {
        if (accepted && change === 'throwing') throw new Error('synthetic pricing fault');
        return prices.get(model);
      }
    }
    const test = setup(new Overlay(), true);
    const p = provider({
      generateMedia: () => {
        accepted = true;
        if (change === 'missing-model') prices.delete(MODEL);
        if (change === 'missing-rate') prices.set(MODEL, price({ mediaOutputRates: {} }));
        if (change === 'negative-rate')
          prices.set(MODEL, price({ mediaOutputRates: { image: -1 } }));
        if (change === 'nan-rate') prices.set(MODEL, price({ mediaOutputRates: { image: NaN } }));
        if (change === 'infinite-rate')
          prices.set(MODEL, price({ mediaOutputRates: { image: Infinity } }));
        if (change === 'unsafe')
          prices.set(MODEL, price({ mediaOutputRates: { image: Number.MAX_SAFE_INTEGER } }));
        return Promise.resolve({
          media: { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aW1n' } },
          raw: {},
        });
      },
    });
    const result = test.execute(p);
    if (change === 'throwing') await expect(result).rejects.toThrow('synthetic pricing fault');
    else if (change === 'unsafe')
      await expect(result).rejects.toBeInstanceOf(InvalidTokenEstimateError);
    else await expect(result).resolves.toMatchObject({ kind: 'completed' });
    await test.governor.flushCommitments();
    expect(test.governor.conservativeCostMicrocents).toBe(8);
    expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
      remaining: 8,
      inFlight: false,
    });
    expect(test.durable).toMatchObject([
      { type: 'budget:estimate_committed', nodeId: 'work', estimateMicrocents: 8 },
    ]);
    expect(test.durable).toHaveLength(1);
    const costEvents = test.events.filter((event) => event.type === 'cost:updated');
    if (change === 'throwing' || change === 'unsafe') expect(costEvents).toEqual([]);
    else expect(costEvents).toMatchObject([{ costMicrocents: 0, priced: false }]);
    expect(test.records).toEqual([]);
    accepted = false;
    prices.set(MODEL, price());
    expect(test.governor.evaluatePreEgress(zeroInfo())).toMatchObject({
      kind: 'pause',
      error: { spentMicrocents: 0 },
    });
  });
}

for (const rate of [0, 1, 4]) {
  it(`known realized media rate ${rate} reconciles once, including genuine zero and underspend`, async () => {
    const prices = new Map([[MODEL, price()]]);
    const test = setup(prices, true);
    await expect(
      test.execute(
        provider({
          generateMedia: () => {
            prices.set(MODEL, price({ mediaOutputRates: { image: rate } }));
            return Promise.resolve({
              media: {
                type: 'media',
                mimeType: 'image/png',
                source: { kind: 'base64', data: 'aW1n' },
              },
              raw: {},
            });
          },
        }),
      ),
    ).resolves.toMatchObject({ kind: 'completed' });
    await test.governor.flushCommitments();
    expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
      remaining: 16 - 2 * rate,
      inFlight: false,
    });
    expect(test.governor.conservativeCostMicrocents).toBe(0);
    expect(test.durable).toEqual([]);
    expect(test.events.filter((event) => event.type === 'cost:updated')).toMatchObject([
      { costMicrocents: 2 * rate },
    ]);
    expect(
      test.events
        .filter((event) => event.type === 'cost:updated')
        .every((event) => event.priced === undefined),
    ).toBe(true);
  });
}

it('a media event-sink failure after known actual settlement does not duplicate conservative spend', async () => {
  const test = setup(new Map([[MODEL, price()]]), true);
  await expect(
    test.execute(provider(), {
      ...test.ctx,
      emit: () => {
        throw new Error('synthetic sink fault');
      },
    }),
  ).rejects.toThrow('synthetic sink fault');
  await test.governor.flushCommitments();
  expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
    remaining: 8,
    inFlight: false,
  });
  expect(test.governor.conservativeCostMicrocents).toBe(0);
  expect(test.durable).toEqual([]);
  expect(test.governor.evaluatePreEgress(zeroInfo())).toMatchObject({
    kind: 'pause',
    error: { spentMicrocents: 8 },
  });
});

for (const media of [false, true]) {
  for (const fault of ['credential-failure', 'cancel-during-key'] as const) {
    it(`proven pre-egress ${fault}, media=${media}, refunds E and never calls the provider`, async () => {
      const test = setup(new Map([[MODEL, price()]]), media);
      const controller = new AbortController();
      let calls = 0;
      const p = provider({
        async *stream() {
          await Promise.resolve();
          calls += 1;
          yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 1 } };
        },
        generateMedia: () => {
          calls += 1;
          return Promise.reject(new Error('unexpected generation'));
        },
      });
      const outcome = await test.execute(
        p,
        { ...test.ctx, signal: controller.signal },
        async () => {
          await Promise.resolve();
          if (fault === 'credential-failure') throw new Error('PRIVATE-CREDENTIAL-DETAIL');
          controller.abort();
          return 'offline-synthetic-key';
        },
      );
      expect(outcome).toMatchObject({
        kind: 'failed',
        error: { code: fault === 'credential-failure' ? 'provider_auth' : 'cancelled' },
      });
      expect(JSON.stringify(outcome)).not.toContain('PRIVATE-CREDENTIAL-DETAIL');
      expect(calls).toBe(0);
      await test.governor.flushCommitments();
      expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
        remaining: 16,
        inFlight: false,
      });
      expect(test.governor.conservativeCostMicrocents).toBe(0);
      expect(test.durable).toEqual([]);
      expect(test.governor.evaluatePreEgress(zeroInfo())).toEqual({ kind: 'allow' });
    });
  }
}

it('a failed media submission after possible egress retains E exactly once', async () => {
  const test = setup(new Map([[MODEL, price()]]), true);
  await expect(
    test.execute(
      provider({ generateMedia: () => Promise.reject(new Error('synthetic provider fault')) }),
    ),
  ).rejects.toThrow('synthetic provider fault');
  await test.governor.flushCommitments();
  expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
    remaining: 8,
    inFlight: false,
  });
  expect(test.governor.conservativeCostMicrocents).toBe(8);
  expect(test.durable).toHaveLength(1);
});

it('an accepted async media job transfers its admission without premature release or retention', async () => {
  const test = setup(new Map([[MODEL, price()]]), true);
  const outcome = await test.execute(
    provider({ generateMedia: () => Promise.resolve({ jobId: 'offline-job', raw: {} }) }),
  );
  if (outcome.kind !== 'media_job') throw new Error('expected async job');
  expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
    remaining: 8,
    inFlight: true,
  });
  expect(test.governor.conservativeCostMicrocents).toBe(0);
  const admission = takeMediaJobAdmission(outcome.job);
  expect(admission).toBeDefined();
  expect(takeMediaJobAdmission(outcome.job)).toBeUndefined();
  admission?.settle(8);
  admission?.release();
  await test.governor.flushCommitments();
  expect(test.governor.dispatchAllowanceState(test.token)).toMatchObject({
    remaining: 8,
    inFlight: false,
  });
  expect(test.governor.conservativeCostMicrocents).toBe(0);
  expect(test.durable).toEqual([]);
});
