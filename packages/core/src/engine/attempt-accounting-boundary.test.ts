import { describe, expect, it } from 'vitest';
import { CostTracker, FallbackChain, LlmProviderError, makeLlmError } from '@relavium/llm';
import type {
  CapabilityFlags,
  LlmProvider,
  StreamChunk,
  Usage,
  ModelPricing,
  AttemptRecord,
} from '@relavium/llm';
import { AgentSchema, SessionContextSchema, unwiredEffectJournal } from '@relavium/shared';
import { createToolRegistry } from '../tools/registry.js';
import { AgentSession, type SessionStreamEvent } from './agent-session.js';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import { BudgetGovernor } from './budget-governor.js';
import { MoneyDurability, type SettledAttemptDraft } from './money-durability.js';
import { createAbortController } from './execution-host.js';
import type { NodeStreamEvent } from './node-executor.js';

const MODEL = 'offline-accounting-model';
const PRICE: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 20000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
  cacheWritePerMtokMicrocents: 1000000,
};
const CAPS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: false,
  reasoning: true,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [['image'], ['text', 'image']],
    surface: 'chat',
  },
};
function providerFor(usage: Usage = { inputTokens: 5, outputTokens: 6 }): LlmProvider {
  return {
    id: 'openai',
    customEndpoint: true,
    supports: CAPS,
    generate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'paid' }],
        stopReason: 'stop',
        usage,
      }),
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      yield { type: 'text_delta', text: 'paid' };
      yield { type: 'stop', stopReason: 'stop', usage };
    },
  };
}
function paramsFor(
  provider: LlmProvider,
  overrides: Partial<AgentTurnParams> = {},
): AgentTurnParams {
  return {
    nodeId: 'accounting-node',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    planEntries: [{ provider, model: MODEL, maxAttempts: 1 }],
    chainCapabilities: { keyFor: () => 'offline-key', sleep: async () => {} },
    signal: new AbortController().signal,
    emit: () => {},
    registry: createToolRegistry({ tools: [], host: {} }),
    dispatchContext: {
      nodeId: 'accounting-node',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
    resolvePrice: new Map([[MODEL, PRICE]]),
    ...overrides,
  };
}
const GENERATED = { outputModalities: ['image' as const] };
function nestedError(field: 'contentCommitted' | 'status') {
  const replacement = new Error('private nested diagnostic');
  const diagnostic = makeLlmError({ provider: 'openai', kind: 'unknown', message: 'safe failure' });
  Object.defineProperty(diagnostic, field, {
    get: () => {
      throw replacement;
    },
    enumerable: true,
    configurable: true,
  });
  const marker = new LlmProviderError(
    makeLlmError({ provider: 'openai', kind: 'unknown', message: 'safe failure' }),
  );
  Object.defineProperty(marker, 'llmError', { value: diagnostic });
  return { marker, replacement };
}

describe('provider attempt accounting boundaries', () => {
  for (const path of ['generate', 'stream'] as const) {
    it(`nested typed contentCommitted trap retains invocation record ${path}`, async () => {
      const { marker, replacement } = nestedError('contentCommitted');
      let calls = 0;
      const records: AttemptRecord[] = [];
      const p = providerFor();
      Object.defineProperty(p, path, {
        value: function () {
          calls++;
          throw marker;
        },
      });
      const chain = new FallbackChain([{ provider: p, model: MODEL, maxAttempts: 1 }], {
        keyFor: () => 'offline-key',
        sleep: async () => {},
        onAttempt: (r) => records.push(r),
      });
      let escaped: unknown;
      try {
        if (path === 'generate') await chain.generate({ messages: [], model: MODEL });
        else
          for await (const chunk of chain.stream({ messages: [], model: MODEL })) {
            void chunk;
          }
      } catch (e) {
        escaped = e;
      }

      expect(escaped === replacement).toBe(false);
      expect(calls).toBe(1);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ providerInvoked: true, outcome: 'failed' });
      expect(records[0]?.error?.cause).toBe(marker);
    });
    for (const mutation of ['zero', 'nan'] as const)
      it(`successful pricing mutation uses validated quantities ${path}/${mutation}`, async () => {
        const raw: Usage = { inputTokens: 5, outputTokens: 6 };
        const prices = new Map<string, ModelPricing>();
        prices.get = () => {
          raw.inputTokens = mutation === 'zero' ? 0 : Number.NaN;
          raw.outputTokens = 0;
          return PRICE;
        };
        const events: NodeStreamEvent[] = [];
        const outcome = await captureAgentTurnOutcome(
          paramsFor(providerFor(raw), {
            ...(path === 'generate' ? GENERATED : {}),
            resolvePrice: prices,
            emit: (e) => events.push(e),
          }),
        );

        expect(outcome.kind).toBe('succeeded');
        if (outcome.kind !== 'succeeded') throw new Error('expected stable success');
        expect(outcome.result.usage).toEqual({ input: 5, output: 6 });
        expect(events.filter((e) => e.type === 'cost:updated')[0]).toMatchObject({
          inputTokens: 5,
          outputTokens: 6,
          costMicrocents: 11,
          priced: true,
        });
      });
  }
  it('generated pricing failure retains known usage but never publishes fully-priced zero', async () => {
    const marker = new Error('private pricing lookup');
    const prices = new Map<string, ModelPricing>();
    prices.get = () => {
      throw marker;
    };
    const events: NodeStreamEvent[] = [];
    const rows: { draft: SettledAttemptDraft; total: number }[] = [];
    let total = 13;
    const money = new MoneyDurability({
      emit: (draft, cumulative) => {
        rows.push({ draft, total: cumulative });
      },
    });
    const outcome = await captureAgentTurnOutcome(
      paramsFor(providerFor(), {
        ...GENERATED,
        resolvePrice: prices,
        money: money.turnPort(() => total),
        emit: (e) => {
          events.push(e);
          if (e.type === 'cost:updated') total += e.costMicrocents;
        },
      }),
    );
    await money.join();

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('expected failure');
    expect(outcome.engaged).toBe(true);
    expect(outcome.usage).toEqual({ input: 5, output: 6 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      draft: { inputTokens: 5, outputTokens: 6, costMicrocents: 0, priced: false },
      total: 13,
    });
  });
  for (const bad of [Number.NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    for (const field of ['inputTokens', 'cacheReadTokens', 'media'] as const)
      it(`invalid generated quantity is never invented ${field}/${bad}`, async () => {
        const raw: Usage = { inputTokens: 5, outputTokens: 6 };
        if (field === 'media')
          raw.mediaUnits = [{ modality: 'image', direction: 'output', unit: 'count', units: bad }];
        else raw[field] = bad;
        const p = providerFor(raw);
        const outcome = await captureAgentTurnOutcome(paramsFor(p, GENERATED));
        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error('expected invalid failure');
        expect(outcome.engaged).toBe(true);
        expect(outcome.usage).toEqual({ input: 0, output: 0 });
      });
  for (const usage of [
    { inputTokens: 0, outputTokens: 0 },
    { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 },
    {
      inputTokens: 5,
      outputTokens: 6,
      mediaUnits: [
        {
          modality: 'image' as const,
          direction: 'output' as const,
          unit: 'count' as const,
          units: 2,
        },
      ],
    },
  ])
    it(`generated pricing failure keeps validated known quantities ${JSON.stringify(usage)}`, async () => {
      const prices = new Map<string, ModelPricing>();
      prices.get = () => {
        throw new Error('private price');
      };
      const outcome = await captureAgentTurnOutcome(
        paramsFor(providerFor(usage), { ...GENERATED, resolvePrice: prices }),
      );
      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') throw new Error('expected pricing failure');
      expect(outcome.usage).toEqual({ input: usage.inputTokens, output: usage.outputTokens });
      expect(outcome.engaged).toBe(true);
    });
});

it('nested typed provider diagnostic still consumes the actual session slot', async () => {
  const { marker } = nestedError('contentCommitted');
  const p = providerFor();
  let calls = 0,
    key = 0;
  p.stream = () => {
    calls++;
    throw marker;
  };
  const events: SessionStreamEvent[] = [];
  const session = new AgentSession({
    sessionId: 'nested',
    agentRef: 'a',
    agent: AgentSchema.parse({
      id: 'a',
      model: MODEL,
      provider: 'openai',
      system_prompt: 'offline',
    }),
    context: SessionContextSchema.parse({ workingDir: '/offline', fsScopeTier: 'sandboxed' }),
    deps: {
      resolveProvider: () => p,
      tools: [],
      registry: createToolRegistry({ tools: [], host: {} }),
      maxTurns: 1,
      reserveEffectTurnKey: () => ++key,
      keyFor: () => 'offline-key',
      sleep: async () => {},
      newAbortController: createAbortController,
      emit: (e) => events.push(e),
    },
  });
  session.start();
  await session.sendMessage('one').catch(() => {});
  await session.sendMessage('two').catch(() => {});

  expect(calls).toBe(1);
  expect(events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
});
for (const path of ['generate', 'stream'] as const)
  it(`nested status getter cannot lose admission settlement ${path}`, async () => {
    const { marker } = nestedError('status');
    const p = providerFor();
    let calls = 0;
    Object.defineProperty(p, path, {
      value: function () {
        calls++;
        throw marker;
      },
    });
    const commitments: unknown[] = [];
    const governor = new BudgetGovernor({
      budget: { max_cost_microcents: 100000, on_exceed: 'fail' },
      resolvePrice: new Map([[MODEL, PRICE]]),
      defaultMaxTokensEstimate: 20,
      emit: (e) => {
        commitments.push(e);
        return Promise.resolve();
      },
    });
    const outcome = await captureAgentTurnOutcome(
      paramsFor(p, {
        ...(path === 'generate' ? GENERATED : {}),
        maxTokens: 20,
        maxTokensEstimate: 20,
        preEgress: (i) => governor.checkPreEgress(i),
      }),
    );
    await governor.flushCommitments();

    expect(calls).toBe(1);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.engaged).toBe(true);
    expect(governor.conservativeCostMicrocents).toBeGreaterThan(0);
    expect(commitments).toHaveLength(1);
  });

it('generated quantity accessor is captured once before repeated arithmetic reads', async () => {
  let reads = 0;
  const raw: Usage = { inputTokens: 5, outputTokens: 6 };
  Object.defineProperty(raw, 'inputTokens', {
    get: () => {
      reads++;
      return reads === 1 ? 5 : 0;
    },
    enumerable: true,
  });
  const outcome = await captureAgentTurnOutcome(paramsFor(providerFor(raw), GENERATED));

  expect(outcome.kind).toBe('succeeded');
  if (outcome.kind === 'succeeded') expect(outcome.result.usage).toEqual({ input: 5, output: 6 });
  expect(reads).toBe(1);
});

it('generated pricing failure never publishes a priced row while the real governor retains its reservation', async () => {
  let paid = false,
    retained = 0,
    total = 13;
  const prices = new Map<string, ModelPricing>();
  prices.get = () => {
    if (paid) throw new Error('private actual pricing');
    return PRICE;
  };
  const p = providerFor();
  p.generate = () => {
    paid = true;
    return Promise.resolve({
      content: [{ type: 'text', text: 'paid' }],
      stopReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 6 },
    });
  };
  const conservative: unknown[] = [];
  const rows: SettledAttemptDraft[] = [];
  const governor = new BudgetGovernor({
    budget: { max_cost_microcents: 100000, on_exceed: 'fail' },
    resolvePrice: prices,
    defaultMaxTokensEstimate: 20,
    emit: (e) => {
      conservative.push(e);
      return Promise.resolve();
    },
  });
  governor.updateCost(total);
  const money = new MoneyDurability({
    emit: (d) => {
      rows.push(d);
    },
    flushConservative: () => governor.flushCommitments(),
  });
  const outcome = await captureAgentTurnOutcome(
    paramsFor(p, {
      ...GENERATED,
      maxTokens: 20,
      maxTokensEstimate: 20,
      resolvePrice: prices,
      preEgress: async (info) => {
        const lease = await governor.checkPreEgress(info);
        retained = lease?.reservedMicrocents ?? 0;
        return lease;
      },
      money: money.turnPort(() => total),
      emit: (e) => {
        if (e.type === 'cost:updated') {
          total += e.costMicrocents;
          governor.updateCost(total);
        }
      },
    }),
  );
  await money.join();

  expect(retained).toBeGreaterThan(0);
  expect(governor.conservativeCostMicrocents).toBe(retained);
  expect(conservative).toHaveLength(1);
  expect(outcome.kind).toBe('failed');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    priced: false,
    costMicrocents: 0,
    inputTokens: 5,
    outputTokens: 6,
  });
  expect(total).toBe(13);
});

for (const path of ['generate', 'stream'] as const)
  it(`cancellation during resolved provider method lookup prevents invocation ${path}`, async () => {
    const abort = new AbortController();
    const p = providerFor();
    const method = p[path];
    let calls = 0;
    Object.defineProperty(p, path, {
      get() {
        abort.abort();
        return function (this: LlmProvider, ...args: Parameters<LlmProvider['generate']>) {
          calls++;
          const result: unknown = Reflect.apply(method, this, args);
          return result;
        };
      },
    });
    const records: AttemptRecord[] = [];
    const chain = new FallbackChain([{ provider: p, model: MODEL, maxAttempts: 1 }], {
      keyFor: () => 'offline',
      sleep: async () => {},
      onAttempt: (r) => records.push(r),
    });
    const request = { messages: [], model: MODEL, signal: abort.signal };
    try {
      if (path === 'generate') await chain.generate(request);
      else
        for await (const chunk of chain.stream(request)) {
          void chunk;
        }
    } catch {
      // The failed attempt record, rather than error delivery form, is asserted below.
    }

    expect(calls).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      providerInvoked: false,
      outcome: 'failed',
      error: { kind: 'cancelled' },
    });
  });

for (const missing of ['inputTokens', 'outputTokens'] as const)
  it(`missing required generated quantity is invalid ${missing}`, async () => {
    const raw: Usage = { inputTokens: 5, outputTokens: 6 };
    Object.defineProperty(raw, missing, { value: undefined, enumerable: true });
    const events: NodeStreamEvent[] = [];
    const outcome = await captureAgentTurnOutcome(
      paramsFor(providerFor(raw), { ...GENERATED, emit: (e) => events.push(e) }),
    );

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.engaged).toBe(true);
      expect(outcome.usage).toEqual({ input: 0, output: 0 });
    }
    expect(events.filter((e) => e.type === 'cost:updated')).toHaveLength(0);
  });

for (const path of ['generate', 'stream'] as const) {
  it(`hostile pricing reflection preserves the original cause ${path}`, async () => {
    const replacement = new Error('private reflection');
    const original = new Proxy(new Error('PRIVATE original'), {
      getPrototypeOf() {
        throw replacement;
      },
    });
    const prices = new Map<string, ModelPricing>();
    prices.get = () => {
      throw original;
    };
    const records: AttemptRecord[] = [];
    const chain = new FallbackChain([{ provider: providerFor(), model: MODEL, maxAttempts: 1 }], {
      keyFor: () => 'offline-key',
      sleep: async () => {},
      costTracker: new CostTracker(prices),
      onAttempt: (record) => records.push(record),
    });
    if (path === 'generate') await chain.generate({ model: MODEL, messages: [] }).catch(() => {});
    else
      for await (const chunk of chain.stream({ model: MODEL, messages: [] })) {
        void chunk;
      }
    expect(records).toHaveLength(1);
    expect(records[0]?.error?.cause === original).toBe(true);
    expect(records[0]?.providerInvoked).toBe(true);
  });

  it(`stop-readiness mutation cannot rewrite captured quantities ${path}`, async () => {
    const raw: Usage = { inputTokens: 5, outputTokens: 6 };
    let stopAvailable = false;
    const provider = providerFor(raw);
    provider.stream = async function* () {
      await Promise.resolve();
      yield { type: 'text_delta', text: 'paid' };
      stopAvailable = true;
      yield { type: 'stop', stopReason: 'stop', usage: raw };
    };
    const outcome = await captureAgentTurnOutcome(
      paramsFor(provider, {
        ...(path === 'generate' ? GENERATED : {}),
        whenReady: () => {
          if (stopAvailable) {
            raw.inputTokens = 0;
            raw.outputTokens = 0;
          }
          return Promise.resolve();
        },
      }),
    );
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind === 'succeeded') expect(outcome.result.usage).toEqual({ input: 5, output: 6 });
  });
}

for (const site of ['provider', 'prehook'] as const) {
  it(`hostile cause maps to one fixed Session failure with truthful engagement ${site}`, async () => {
    const reflection = new Error('PRIVATE reflection');
    const original = new Proxy(new Error('PRIVATE original'), {
      getPrototypeOf() {
        throw reflection;
      },
    });
    let calls = 0,
      key = 0;
    const provider = providerFor();
    provider.stream = () => {
      calls++;
      throw original;
    };
    const events: SessionStreamEvent[] = [];
    const session = new AgentSession({
      sessionId: 'hostile',
      agentRef: 'a',
      agent: AgentSchema.parse({
        id: 'a',
        model: MODEL,
        provider: 'openai',
        system_prompt: 'offline',
      }),
      context: SessionContextSchema.parse({ workingDir: '/offline', fsScopeTier: 'sandboxed' }),
      deps: {
        resolveProvider: () => provider,
        tools: [],
        registry: createToolRegistry({ tools: [], host: {} }),
        maxTurns: 1,
        reserveEffectTurnKey: () => ++key,
        keyFor: () => 'offline',
        sleep: async () => {},
        newAbortController: createAbortController,
        emit: (event) => events.push(event),
        ...(site === 'prehook'
          ? {
              preEgress: () => {
                throw original;
              },
            }
          : {}),
      },
    });
    session.start();
    await expect(session.sendMessage('one')).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === 'session:turn_completed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ error: { code: 'internal' } });
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
    await session.sendMessage('two');
    expect(calls).toBe(site === 'provider' ? 1 : 0);
    if (site === 'provider') expect(events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
  });
}

it('direct CostTracker prices owned cache and media quantities before overlay mutation', () => {
  const raw: Usage = {
    inputTokens: 5,
    outputTokens: 6,
    cacheReadTokens: 7,
    cacheWriteTokens: 8,
    mediaUnits: [{ modality: 'image', direction: 'output', unit: 'count', units: 2 }],
  };
  const prices = new Map<string, ModelPricing>();
  prices.get = () => {
    raw.inputTokens = 0;
    raw.outputTokens = 0;
    raw.cacheReadTokens = 0;
    raw.cacheWriteTokens = 0;
    const media = raw.mediaUnits?.[0];
    if (media !== undefined) media.units = 0;
    return { ...PRICE, mediaOutputRates: { image: 7 } };
  };
  const tracker = new CostTracker(prices);
  expect(tracker.record(MODEL, raw)).toMatchObject({
    inputTokens: 5,
    outputTokens: 6,
    costMicrocents: 40,
  });
  expect(tracker.cumulativeCostMicrocents).toBe(40);
});

for (const missing of ['inputTokens', 'outputTokens'] as const)
  it(`direct CostTracker refuses a missing required quantity ${missing}`, () => {
    const raw: Usage = { inputTokens: 5, outputTokens: 6 };
    Object.defineProperty(raw, missing, { value: undefined });
    const tracker = new CostTracker(new Map([[MODEL, PRICE]]));
    expect(() => tracker.record(MODEL, raw)).toThrow(TypeError);
    expect(tracker.cumulativeCostMicrocents).toBe(0);
  });

it('generated result and AttemptRecord share the captured original quantities', async () => {
  const raw: Usage = { inputTokens: 5, outputTokens: 6 };
  const prices = new Map<string, ModelPricing>();
  prices.get = () => {
    raw.inputTokens = 500;
    return PRICE;
  };
  const records: AttemptRecord[] = [];
  const chain = new FallbackChain([{ provider: providerFor(raw), model: MODEL, maxAttempts: 1 }], {
    keyFor: () => 'offline',
    sleep: async () => {},
    costTracker: new CostTracker(prices),
    onAttempt: (record) => records.push(record),
  });
  const result = await chain.generate({ model: MODEL, messages: [] });
  expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  expect(records[0]?.usage).toBe(result.usage);
  expect(raw.inputTokens).toBe(500);
});
