import { describe, it, expect } from 'vitest';
import { unwiredEffectJournal, type ContentPart, type RunEvent } from '@relavium/shared';
import {
  type LlmProvider,
  type LlmResult,
  type StreamChunk,
  type ModelPricing,
  LlmProviderError,
  makeLlmError,
  FallbackChain,
  CostTracker,
  type AttemptRecord,
} from '@relavium/llm';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore, createAbortController } from './execution-host.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import { parseWorkflow } from '../parser.js';
import { createToolRegistry } from '../tools/registry.js';
import {
  AgentTurnError,
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import { BudgetPauseError, CommitmentDurabilityError } from './budget-governor.js';
import {
  MoneyDurability,
  type SettledAttemptDraft,
  LedgerDurabilityError,
} from './money-durability.js';
const MODEL = 'r10-own-independent';
const PRICE: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 30000,
  maxOutputTokens: 512,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 3000000,
  cacheWritePerMtokMicrocents: 4000000,
  mediaOutputRates: { image: 17 },
};
const prices = new Map([[MODEL, PRICE]]);
const usage = () => ({
  inputTokens: 9,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  mediaUnits: [
    { modality: 'image' as const, direction: 'output' as const, unit: 'count' as const, units: 1 },
  ],
});
const CHARGE = 46;
const media: ContentPart = {
  type: 'media',
  mimeType: 'image/png',
  source: { kind: 'handle', ref: `media://sha256-${'b'.repeat(64)}` },
};
function provider(calls: { value: number }, result: () => LlmResult): LlmProvider {
  return {
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
        outputCombinations: [['image']],
        surface: 'chat',
      },
    },
    generate() {
      calls.value++;
      return Promise.resolve(result());
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      calls.value++;
      yield { type: 'text_delta', text: 'independent paid answer' };
      yield { type: 'stop', stopReason: 'stop', usage: usage() };
    },
  };
}
function params(p: LlmProvider, overrides: Partial<AgentTurnParams> = {}): AgentTurnParams {
  return {
    nodeId: 'r10-node',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'offline independent test' }] }],
    planEntries: [{ provider: p, model: MODEL, maxAttempts: 1 }],
    chainCapabilities: {
      keyFor: () => 'offline-synthetic-placeholder',
      sleep: () => Promise.resolve(),
    },
    signal: createAbortController().signal,
    emit: () => {},
    registry: createToolRegistry({ tools: [], host: {} }),
    dispatchContext: {
      nodeId: 'r10-node',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
    resolvePrice: prices,
    maxTokens: 8,
    ...overrides,
  };
}
async function workflow(p: LlmProvider, onClock?: () => void) {
  const store = new InMemoryRunStore();
  const host = createInMemoryHost({ store });
  const runner = createAgentNodeExecutor({
    resolveProvider: () => p,
    keyFor: () => 'offline-synthetic-placeholder',
    sleep: () => Promise.resolve(),
    tools: [],
    registry: createToolRegistry({ tools: [], host: {} }),
    resolvePrice: prices,
    resolveMediaSurface: () => 'chat',
  });
  const engine = new WorkflowEngine({
    host: {
      ...host,
      clock: {
        now: () => {
          onClock?.();
          return host.clock.now();
        },
      },
      setTimer: (ms, fire, kind) => {
        const disarm = host.setTimer(ms, fire, kind);
        if (kind === undefined || kind === 'work') queueMicrotask(() => host.fireTimers());
        return disarm;
      },
    },
    executor: createDispatchingNodeExecutor({ agent: runner }),
    resolvePrice: prices,
  });
  const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: r10-independent
  agents:
    - { id: a, provider: openai, model: r10-own-independent, system_prompt: offline }
  nodes:
    - { id: n, type: agent, agent_ref: a, prompt_template: independent, max_tokens: 8, output_modalities: [image], retry: { max: 2, backoff: linear, retry_on: [provider_unavailable] } }
  edges: []
`);
  const handle = engine.start({ workflow: wf, inputs: {} });
  const events: RunEvent[] = [];
  for await (const e of handle.events) {
    events.push(e);
    if (e.type === 'node:retrying') host.fireTimers();
    if (e.type === 'run:paused') engine.cancel(handle.runId);
  }
  const durable = store.eventsFor(handle.runId);
  return { events, durable };
}
function marker(kind: 'turn' | 'budget' | 'provider') {
  if (kind === 'turn')
    return new AgentTurnError('provider_unavailable', 'r10 PRIVATE nested result callback', true);
  if (kind === 'budget') return new BudgetPauseError(0, 11, 12);
  return new LlmProviderError(
    makeLlmError({
      provider: 'openai',
      kind: 'timeout',
      message: 'r10 PRIVATE nested result callback',
    }),
  );
}
function trappedContent(error: unknown): ContentPart[] {
  const part: ContentPart = {
    type: 'text',
    get text(): string {
      throw error;
    },
  };
  return [media, part];
}
describe('R10 independent actual generated ownership', () => {
  for (const kind of ['turn', 'budget', 'provider'] as const)
    it(`actual WorkflowEngine nested content/${kind} cannot authorise paid redispatch or false gate`, async () => {
      const calls = { value: 0 };
      const error = marker(kind);
      const h = await workflow(
        provider(calls, () => ({
          content: trappedContent(error),
          stopReason: 'stop',
          usage: usage(),
        })),
      );
      expect.soft(calls.value).toBe(1);
      expect
        .soft(
          h.events.some(
            (e) =>
              e.type === 'node:retrying' ||
              e.type === 'run:paused' ||
              e.type === 'human_gate:paused',
          ),
        )
        .toBe(false);
      expect.soft(h.events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'internal', retryable: false },
        cumulativeCostMicrocents: CHARGE,
      });
      expect.soft(h.durable.filter((e) => e.type === 'cost:attempt_settled')).toHaveLength(1);
      expect.soft(JSON.stringify(h.events)).not.toContain('PRIVATE');
    });
  it('actual successful plain generated content is accepted at one priced charge', async () => {
    const calls = { value: 0 };
    const h = await workflow(
      provider(calls, () => ({
        content: [media, { type: 'text', text: 'successful independent answer' }],
        stopReason: 'stop',
        usage: usage(),
      })),
    );
    expect(calls.value).toBe(1);
    expect(h.events.at(-1)).toMatchObject({ type: 'run:completed', totalCostMicrocents: CHARGE });
    expect(h.durable.filter((e) => e.type === 'cost:attempt_settled')).toHaveLength(1);
  });
  for (const field of ['content', 'stopReason', 'raw'] as const)
    it(`top-level result ${field} trap is contained before observers`, async () => {
      const calls = { value: 0 };
      const error = marker('turn');
      let reads = 0;
      let total = 0;
      const rows: SettledAttemptDraft[] = [];
      const money = new MoneyDurability({
        emit: (d) => {
          rows.push(d);
        },
      });
      const p = provider(calls, () => {
        const result: LlmResult = {
          content: [media],
          stopReason: 'stop',
          usage: usage(),
          raw: { safe: true },
        };
        Object.defineProperty(result, field, {
          get() {
            reads++;
            throw error;
          },
          enumerable: true,
        });
        return result;
      });
      const out = await captureAgentTurnOutcome(
        params(p, {
          outputModalities: ['image'],
          emit: (e) => {
            if (e.type === 'cost:updated') total += e.costMicrocents;
          },
          money: money.turnPort(() => total),
        }),
      );
      await money.join();
      expect(out).toMatchObject({
        kind: 'failed',
        failureOrigin: 'turn',
        engaged: true,
        usage: { input: 9, output: 5 },
      });
      expect(calls.value).toBe(1);
      expect(reads).toBe(1);
      expect(rows).toMatchObject([
        { costMicrocents: CHARGE, inputTokens: 9, outputTokens: 5, priced: true },
      ]);
      expect(out.kind === 'failed' && out.error).toMatchObject({
        code: 'internal',
        retryable: false,
      });
    });
});
describe('R10 independent chain terminal and quantity controls', () => {
  it('confirming provider read cannot revise held usage or retry classification', async () => {
    const calls = { value: 0 },
      records: AttemptRecord[] = [];
    const raw = usage();
    const p = provider(calls, () => ({ content: [media], stopReason: 'stop', usage: raw }));
    const q: LlmProvider = {
      ...p,
      stream: async function* () {
        await Promise.resolve();
        calls.value++;
        yield { type: 'stop', stopReason: 'stop', usage: raw };
        raw.inputTokens = 0;
        raw.outputTokens = 0;
        raw.cacheReadTokens = 0;
        raw.cacheWriteTokens = 0;
        raw.mediaUnits[0]!.units = 0;
        throw new Error('private teardown');
      },
    };
    const chain = new FallbackChain([{ provider: q, model: MODEL, maxAttempts: 2 }], {
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      costTracker: new CostTracker(prices),
      onAttempt: (r) => records.push(r),
    });
    const chunks: StreamChunk[] = [];
    for await (const c of chain.stream({ model: MODEL, messages: [] })) chunks.push(c);
    expect(calls.value).toBe(1);
    expect(chunks).toMatchObject([
      {
        type: 'stop',
        usage: { inputTokens: 9, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
      },
    ]);
    expect(records).toMatchObject([{ outcome: 'succeeded', cost: { costMicrocents: CHARGE } }]);
  });
  it('observer cannot mutate error diagnostics to obtain a retry', async () => {
    const calls = { value: 0 };
    const diag = makeLlmError({
      provider: 'openai',
      kind: 'bad_request',
      message: 'fixed ordinary refusal',
      status: 400,
    });
    const p = provider(calls, () => ({ content: [], stopReason: 'stop', usage: usage() }));
    const q: LlmProvider = {
      ...p,
      stream: async function* () {
        await Promise.resolve();
        calls.value++;
        yield { type: 'error', error: diag };
        diag.kind = 'transport';
        diag.retryable = true;
      },
    };
    const records: AttemptRecord[] = [];
    const chain = new FallbackChain([{ provider: q, model: MODEL, maxAttempts: 2 }], {
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      onAttempt: (r) => {
        records.push(r);
        if (r.error) Reflect.set(r.error, 'retryable', true);
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const c of chain.stream({ model: MODEL, messages: [] })) chunks.push(c);
    expect(calls.value).toBe(1);
    expect(chunks).toMatchObject([
      { type: 'error', error: { kind: 'bad_request', retryable: false, status: 400 } },
    ]);
    expect(Object.isFrozen(records[0]?.error)).toBe(true);
  });
});
describe('R10 returned content downstream and callback mutation', () => {
  it('downstream node outcome content reflection cannot acquire counterfeit ledger writer attribution', async () => {
    const calls = { value: 0 };
    let reads = 0;
    const fake = new LedgerDurabilityError(
      new Error('PRIVATE forged writer'),
      'r10-counterfeit-writer',
    );
    const part: ContentPart = {
      get type(): 'media' {
        if (++reads === 2) throw fake;
        return 'media';
      },
      mimeType: 'image/png',
      source: { kind: 'handle', ref: `media://sha256-${'c'.repeat(64)}` },
    };
    const h = await workflow(
      provider(calls, () => ({ content: [part], stopReason: 'stop', usage: usage() })),
    );
    expect.soft(calls.value).toBe(1);
    expect.soft(h.events.at(-1)).toMatchObject({
      type: 'run:failed',
      error: { code: 'internal', nodeId: 'n', retryable: false },
      cumulativeCostMicrocents: CHARGE,
    });
    expect.soft(JSON.stringify(h.events)).not.toContain('r10-counterfeit-writer');
    expect.soft(h.durable.filter((e) => e.type === 'cost:attempt_settled')).toHaveLength(1);
  });
  it('paid cost callback cannot install a text getter that grants a later node retry', async () => {
    const calls = { value: 0 };
    let pending = false;
    const part: ContentPart = { type: 'text', text: 'stable response' };
    const fault = new AgentTurnError(
      'provider_unavailable',
      'PRIVATE callback-installed text trap',
      true,
    );
    const h = await workflow(
      provider(calls, () => {
        pending = true;
        return { content: [media, part], stopReason: 'stop', usage: usage() };
      }),
      () => {
        if (pending) {
          pending = false;
          Object.defineProperty(part, 'text', {
            get: () => {
              throw fault;
            },
            configurable: true,
            enumerable: true,
          });
        }
      },
    );
    expect.soft(calls.value).toBe(1);
    expect.soft(h.events.some((e) => e.type === 'node:retrying')).toBe(false);
    expect
      .soft(h.events.at(-1))
      .toMatchObject({ type: 'run:completed', totalCostMicrocents: CHARGE });
    expect.soft(h.durable.filter((e) => e.type === 'cost:attempt_settled')).toHaveLength(1);
    expect.soft(JSON.stringify(h.events)).not.toContain('PRIVATE');
  });
});

// Fresh contrasts: same exception identity only gets control authority at current pre-attempt admission.
describe('R10 exact pre-attempt ownership and truthful generated accounting', () => {
  for (const origin of ['admission', 'provider', 'pricing'] as const)
    for (const kind of ['pause', 'commitment'] as const)
      it(`${origin}/${kind} grants control authority only to exact admission owner`, async () => {
        const calls = { value: 0 };
        const fault =
          kind === 'pause'
            ? new BudgetPauseError(2, 41, 70)
            : new CommitmentDurabilityError(
                new Error('PRIVATE actual commitment sink'),
                'r10-real-admission-owner',
              );
        class Overlay extends Map<string, ModelPricing> {
          override get(model: string): ModelPricing | undefined {
            if (origin === 'pricing' && calls.value > 0) throw fault;
            return super.get(model);
          }
        }
        const p = provider(calls, () => {
          if (origin === 'provider')
            throw new LlmProviderError(
              makeLlmError({
                provider: 'openai',
                kind: 'unknown',
                message: 'fixed upstream failure',
                cause: fault,
              }),
            );
          return { content: [media], stopReason: 'stop', usage: usage() };
        });
        const out = await captureAgentTurnOutcome(
          params(p, {
            outputModalities: ['image'],
            resolvePrice: new Overlay([[MODEL, PRICE]]),
            ...(origin === 'admission'
              ? {
                  preEgress: () => {
                    throw fault;
                  },
                }
              : {}),
          }),
        );
        expect(out.kind).toBe('failed');
        if (out.kind !== 'failed') return;
        if (origin === 'admission') {
          expect(out.error).toBe(fault);
          expect(calls.value).toBe(0);
          expect(out.engaged).toBe(false);
        } else {
          expect(out.error).not.toBe(fault);
          expect(out.error).toMatchObject({ code: 'internal', retryable: false });
          expect(calls.value).toBe(1);
          expect(out.engaged).toBe(true);
          if (origin === 'pricing') expect(out.usage).toMatchObject({ input: 9, output: 5 });
        }
      });
  for (const field of ['usage', 'content', 'stopReason', 'raw'] as const)
    it(`generated ${field} getter completes before attempt observer and retains paid fold when known`, async () => {
      const calls = { value: 0 },
        sequence: string[] = [],
        records: AttemptRecord[] = [];
      const fault = new AgentTurnError('provider_unavailable', 'PRIVATE generated getter', true);
      const p = provider(calls, () => {
        const result: LlmResult = {
          content: [media],
          stopReason: 'stop',
          usage: usage(),
          raw: { opaque: 'retained' },
        };
        Object.defineProperty(result, field, {
          get() {
            sequence.push(field);
            throw fault;
          },
          enumerable: true,
        });
        return result;
      });
      const chain = new FallbackChain([{ provider: p, model: MODEL, maxAttempts: 2 }], {
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        costTracker: new CostTracker(prices),
        onAttempt: (r) => {
          sequence.push('observer');
          records.push(r);
        },
      });
      await expect(chain.generate({ model: MODEL, messages: [] })).rejects.toMatchObject({
        llmError: { kind: 'unknown', retryable: false },
      });
      expect(calls.value).toBe(1);
      expect(sequence).toEqual([field, 'observer']);
      expect(records).toHaveLength(1);
      if (field === 'usage') {
        expect(records[0]?.usage).toBeUndefined();
        expect(records[0]?.cost).toBeUndefined();
      } else
        expect(records[0]).toMatchObject({
          usage: { inputTokens: 9, outputTokens: 5 },
          cost: { costMicrocents: CHARGE },
        });
    });
  it('actual MoneyDurability pricing failure retains known quantities as unpriced zero placeholder', async () => {
    const calls = { value: 0 };
    class Overlay extends Map<string, ModelPricing> {
      override get(model: string): ModelPricing | undefined {
        if (calls.value > 0) throw new BudgetPauseError(0, 99, 101);
        return super.get(model);
      }
    }
    const p = provider(calls, () => ({ content: [media], stopReason: 'stop', usage: usage() }));
    const rows: SettledAttemptDraft[] = [];
    const money = new MoneyDurability({
      emit: (r) => {
        rows.push(r);
      },
    });
    const out = await captureAgentTurnOutcome(
      params(p, {
        outputModalities: ['image'],
        resolvePrice: new Overlay([[MODEL, PRICE]]),
        money: money.turnPort(() => 0),
      }),
    );
    await money.join();
    expect(calls.value).toBe(1);
    expect(out).toMatchObject({ kind: 'failed', engaged: true, usage: { input: 9, output: 5 } });
    expect(rows).toMatchObject([
      { inputTokens: 9, outputTokens: 5, priced: false, costMicrocents: 0 },
    ]);
  });
});

describe('R10 independently constructed real shared money barrier', () => {
  it('B1 retains actual earlier writer and prevents current provider invocation', async () => {
    const calls = { value: 0 };
    const cause = new Error('PRIVATE acknowledged sink refusal');
    const delivered: SettledAttemptDraft[] = [];
    const money = new MoneyDurability({
      emit: (row) => {
        delivered.push(row);
        return Promise.reject(cause);
      },
    });
    money
      .turnPort(() => CHARGE)
      .record({
        nodeId: 'r10-earlier-peer',
        model: MODEL,
        attemptNumber: 1,
        inputTokens: 9,
        outputTokens: 5,
        costMicrocents: CHARGE,
        priced: true,
      });
    const out = await captureAgentTurnOutcome(
      params(
        provider(calls, () => ({ content: [media], stopReason: 'stop', usage: usage() })),
        { outputModalities: ['image'], money: money.turnPort(() => CHARGE) },
      ),
    );
    expect(out).toMatchObject({
      kind: 'failed',
      failureOrigin: 'turn',
      engaged: false,
      usage: { input: 0, output: 0 },
    });
    expect(calls.value).toBe(0);
    expect(out.kind === 'failed' && out.error).toMatchObject({ nodeId: 'r10-earlier-peer', cause });
    expect(out.kind === 'failed' && out.error).toBeInstanceOf(LedgerDurabilityError);
    expect(delivered).toMatchObject([
      { nodeId: 'r10-earlier-peer', costMicrocents: CHARGE, priced: true },
    ]);
    expect(money.durabilityBroken).toBe(true);
  });
});
