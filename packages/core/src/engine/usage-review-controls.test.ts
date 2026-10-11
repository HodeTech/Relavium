import { expect, it, vi } from 'vitest';
import {
  AgentSchema,
  SessionContextSchema,
  UsageCoverageFold,
  unwiredEffectJournal,
  type UsageEvidence,
  type UsageInvocation,
} from '@relavium/shared';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import type { LlmProvider, StreamChunk } from '@relavium/llm';
import { AgentSession } from './agent-session.js';
import { DEFAULT_AGENT_TURN_LIMITS, runAgentTurn, type AgentTurnParams } from './agent-turn.js';
import { MoneyDurability, type SettledAttemptDraft } from './money-durability.js';

const adversarial = vi.hoisted(() => ({ finalHint: false }));
vi.mock('@relavium/llm', async (original) => {
  const llm = await original<typeof import('@relavium/llm')>();
  return {
    ...llm,
    FallbackChain: class extends llm.FallbackChain {
      constructor(...[entries, options]: ConstructorParameters<typeof llm.FallbackChain>) {
        super(entries, {
          ...options,
          onAttempt: (record) =>
            options.onAttempt?.(
              adversarial.finalHint && record.receiptFinal === true
                ? { ...record, receiptPending: true }
                : record,
            ),
        });
      }
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function accounting(provider: LlmProvider) {
  const fold = new UsageCoverageFold();
  fold.start('complete');
  let ordinal = 0,
    cost = 0,
    writes = 0;
  const ids: UsageInvocation[] = [];
  const settlements: SettledAttemptDraft[] = [];
  const money = new MoneyDurability({
    beginUsageInvocation: (draft) => {
      const id = Object.freeze({
        producerId: 'review',
        ordinal: ++ordinal,
        dispatchId: draft.nodeId,
        round: draft.round,
        chainAttempt: draft.chainAttempt,
      });
      ids.push(id);
      fold.pending(draft.model, id);
      return Promise.resolve(id);
    },
    emitUsageDisposition: (draft) => {
      fold.disposition(draft.model, draft.invocation, draft.disposition, draft.receiptPending);
    },
    emit: (draft) => {
      settlements.push(draft);
      writes++;
      if (draft.invocation !== undefined) fold.complete(draft.model, draft.invocation);
    },
  });
  const registry = {
    has: () => false,
    list: () => [],
    dispatch: () => Promise.reject(new Error('unexpected tool')),
  };
  const params: AgentTurnParams = {
    nodeId: 'review',
    messages: [],
    temperature: 0.7,
    planEntries: [{ provider, model: 'repair-review-fixture', maxAttempts: 1 }],
    chainCapabilities: {
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      newAbortController: () => new AbortController(),
    },
    signal: new AbortController().signal,
    emit: (event) => {
      if (event.type === 'cost:updated') cost += event.costMicrocents;
    },
    registry,
    dispatchContext: {
      nodeId: 'review',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
    money: money.turnPort(() => cost),
  };
  return { fold, money, params, ids, settlements, writes: () => writes };
}
function nativeRepair() {
  let calls = 0;
  const provider = createOpenAiAdapter({
    baseURL: 'https://offline.invalid/v1',
    maxRetries: 0,
    fetch: () => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? new Response(
              JSON.stringify({
                error: {
                  message: 'Unsupported parameter: temperature',
                  type: 'invalid_request_error',
                  param: 'temperature',
                  code: 'unsupported_parameter',
                },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            )
          : new Response(
              'data: ' +
                JSON.stringify({
                  id: 'offline',
                  choices: [{ index: 0, delta: { content: 'summary' }, finish_reason: null }],
                }) +
                '\n\ndata: ' +
                JSON.stringify({
                  id: 'offline',
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  usage: {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    prompt_tokens_details: { cached_tokens: 0 },
                  },
                }) +
                '\n\ndata: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            ),
      );
    },
  });
  return { provider, calls: () => calls };
}

it('actual custom SDK repair unknown survives both durable coverage and returned turn coverage', async () => {
  const native = nativeRepair();
  const h = accounting(native.provider);
  const result = await runAgentTurn(h.params);
  expect(native.calls()).toBe(2);
  expect(result.text).toBe('summary');
  expect(result.usageCoverage).toEqual({
    unverified: false,
    pendingInvocations: 0,
    unknownCalls: 1,
  });
  expect(h.fold.snapshot().coverage).toEqual(result.usageCoverage);
});

it('actual custom SDK summary repair remains unknown in successful compaction coverage', async () => {
  const native = nativeRepair();
  const h = accounting(native.provider);
  const messages = ['old context', 'middle context', 'latest'].map((text) => ({
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
  }));
  const session = AgentSession.resume(
    {
      sessionId: 'review',
      agentRef: 'review',
      agent: AgentSchema.parse({
        id: 'review',
        provider: 'openai',
        model: 'repair-review-fixture',
        system_prompt: 'offline',
        temperature: 0.7,
      }),
      context: SessionContextSchema.parse({ workingDir: '/workspace', fsScopeTier: 'sandboxed' }),
      deps: {
        resolveProvider: () => native.provider,
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        registry: h.params.registry,
        tools: [],
        newAbortController: () => new AbortController(),
        reserveEffectTurnKey: () => 1,
        emit: () => undefined,
        money: h.money.turnPort(() => 0),
        autoCompact: false,
      },
    },
    {
      messages,
      completedTurnSpans: messages.map((_, i) => ({ start: i, end: i + 1 })),
      turnCount: 3,
      cumulativeCostMicrocents: 0,
      conservativeCostMicrocents: 0,
    },
  );
  const result = await session.compact();
  expect(native.calls()).toBe(2);
  expect(result).toMatchObject({
    kind: 'compacted',
    summaryUsageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 1 },
  });
  expect(h.fold.snapshot().coverage.unknownCalls).toBe(1);
});

for (const forcedHint of [false, true])
  it(`final incomplete raw receipt retires identity while preserving uncertainty (stale hint=${forcedHint})`, async () => {
    const raw = deferred<IteratorResult<StreamChunk>>(),
      entered = deferred<void>();
    const native = nativeRepair();
    const provider: LlmProvider = {
      ...native.provider,
      stream: (): AsyncIterableIterator<StreamChunk> => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => {
          entered.resolve();
          return raw.promise;
        },
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    };
    const h = accounting(provider);
    const abort = new AbortController();
    const retained: Promise<unknown>[] = [];
    let fire: (() => void) | undefined;
    adversarial.finalHint = forcedHint;
    try {
      const turn = runAgentTurn({
        ...h.params,
        signal: abort.signal,
        chainCapabilities: {
          ...h.params.chainCapabilities,
          attemptTimeoutMs: 5,
          setTimer: (_ms, callback) => {
            fire = callback;
            return () => undefined;
          },
        },
        retainWork: (work) => {
          const p = work();
          retained.push(p);
          return p;
        },
      }).catch(() => undefined);
      await Promise.race([
        entered.promise,
        turn.then(() => {
          throw new Error('turn ended before raw read');
        }),
      ]);
      if (fire === undefined) throw new Error('missing deadline');
      fire();
      await turn;
      expect(h.fold.retainedInvocations).toBe(1);
      raw.resolve({
        done: false,
        value: {
          type: 'stop',
          stopReason: 'stop',
          usage: { kind: 'missing', reason: 'not_reported' } satisfies UsageEvidence,
        },
      });
      await Promise.allSettled(retained);
      await h.money.join();
      expect(h.fold.retainedInvocations).toBe(0);
      expect(h.fold.snapshot().coverage).toEqual({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 1,
      });
      const id = h.ids[0];
      if (id === undefined) throw new Error('missing receipt');
      expect(h.money.claimUsage(id, 'complete')).toBe(false);
    } finally {
      adversarial.finalHint = false;
    }
  });

it('late pricing failure persists complete quantities and unpriced coverage before the money health join fails', async () => {
  const raw = deferred<IteratorResult<StreamChunk>>(),
    entered = deferred<void>();
  const native = nativeRepair();
  const provider: LlmProvider = {
    ...native.provider,
    stream: (): AsyncIterableIterator<StreamChunk> => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        entered.resolve();
        return raw.promise;
      },
      return: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
  const h = accounting(provider);
  const retained: Promise<unknown>[] = [];
  let fire: (() => void) | undefined;
  const pricingFault = new Error('PRIVATE late price resolver');
  let failPricing = false;
  const prices = new Map<string, import('@relavium/llm').ModelPricing>();
  const nativeGet = prices.get.bind(prices);
  prices.get = (key) => {
    if (failPricing) throw pricingFault;
    return nativeGet(key);
  };
  const turn = runAgentTurn({
    ...h.params,
    resolvePrice: prices,
    chainCapabilities: {
      ...h.params.chainCapabilities,
      attemptTimeoutMs: 5,
      setTimer: (_ms, callback) => {
        fire = callback;
        return () => undefined;
      },
    },
    retainWork: (work) => {
      const p = work();
      retained.push(p);
      return p;
    },
  }).catch(() => undefined);
  await entered.promise;
  if (fire === undefined) throw new Error('missing deadline');
  fire();
  await turn;
  failPricing = true;
  raw.resolve({
    done: false,
    value: {
      type: 'stop',
      stopReason: 'stop',
      usage: { kind: 'complete', usage: { inputTokens: 3, outputTokens: 2 } },
    },
  });
  await Promise.allSettled(retained);
  await h.money.waitForWrites();
  expect(h.writes()).toBe(1);
  expect(h.settlements).toMatchObject([
    { inputTokens: 3, outputTokens: 2, priced: false, costMicrocents: 0 },
  ]);
  expect(h.fold.snapshot().coverage).toEqual({
    unverified: false,
    pendingInvocations: 0,
    unknownCalls: 0,
  });
  expect(h.money.durabilityBroken).toBe(true);
  await expect(h.money.join()).rejects.toMatchObject({
    name: 'LedgerDurabilityError',
    cause: pricingFault,
  });
});
