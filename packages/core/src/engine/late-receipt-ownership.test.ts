import { expect, it } from 'vitest';
import type { LlmProvider, LlmResult } from '@relavium/llm';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import { UsageCoverageFold, unwiredEffectJournal } from '@relavium/shared';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import { MoneyDurability, type SettledAttemptDraft } from './money-durability.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return;
    await Promise.resolve();
  }
  expect.fail('expected receipt boundary was not reached');
}

function result(text: string, tokens: number): LlmResult {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { kind: 'complete', usage: { inputTokens: tokens, outputTokens: tokens } },
  };
}

function fixture(first: LlmProvider, second: LlmProvider, onFallbackCost: () => void = () => {}) {
  const timers = new Set<() => void>();
  const retained: Promise<unknown>[] = [];
  const records: SettledAttemptDraft[] = [];
  const fold = new UsageCoverageFold();
  fold.start('complete');
  let ordinal = 0;
  const money = new MoneyDurability({
    beginUsageInvocation: (draft) => {
      const invocation = {
        producerId: 'late-receipt',
        ordinal: ++ordinal,
        dispatchId: 'turn',
        round: draft.round,
        chainAttempt: draft.chainAttempt,
      };
      fold.pending(draft.model, invocation);
      return Promise.resolve(invocation);
    },
    emitUsageDisposition: (draft) => {
      fold.disposition(draft.model, draft.invocation, draft.disposition, draft.receiptPending);
    },
    emit: (draft) => {
      records.push(draft);
      if (draft.invocation !== undefined) fold.complete(draft.model, draft.invocation);
    },
  });
  const params: AgentTurnParams = {
    nodeId: 'turn',
    signal: new AbortController().signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    // Exercise generate through the normal turn selection, including the real SDK control.
    outputModalities: ['text', 'audio'],
    maxTokens: 3,
    planEntries: [
      { provider: first, model: 'old', maxAttempts: 1 },
      { provider: second, model: 'new', maxAttempts: 1 },
    ],
    chainCapabilities: {
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      newAbortController: () => new AbortController(),
      setTimer: (_ms, callback) => {
        timers.add(callback);
        return () => {
          timers.delete(callback);
        };
      },
    },
    retainWork: (factory) => {
      const work = factory();
      retained.push(work);
      return work;
    },
    emit: (event) => {
      if (event.type === 'cost:updated' && event.model === 'new') onFallbackCost();
    },
    money: money.turnPort(() => 0),
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unexpected tool dispatch')),
    },
    dispatchContext: {
      nodeId: 'turn',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
  };
  return {
    params,
    records,
    fold,
    expire: () => {
      expect(timers.size).toBe(1);
      for (const timer of [...timers]) timer();
    },
    join: async () => {
      const settled = await Promise.allSettled(retained);
      expect(settled.every((entry) => entry.status === 'fulfilled')).toBe(true);
      await money.join();
    },
  };
}

for (const schedule of ['fallback-inflight', 'before-return', 'after-return']) {
  it(`a late receipt preserves the answer owner and refines only its original call: ${schedule}`, async () => {
    const old = deferred<LlmResult>();
    const fallback = deferred<LlmResult>();
    let oldCalls = 0;
    let fallbackCalls = 0;
    const first: LlmProvider = {
      id: 'openai',
      supports: createOpenAiAdapter().supports,
      generate: () => {
        oldCalls++;
        return old.promise;
      },
      async *stream() {
        yield await Promise.reject(new Error('unexpected stream'));
      },
    };
    const second: LlmProvider = {
      ...first,
      generate: () => {
        fallbackCalls++;
        return schedule === 'fallback-inflight'
          ? fallback.promise
          : Promise.resolve(result('fallback', 1));
      },
    };
    const f = fixture(first, second, () => {
      if (schedule === 'before-return') old.resolve(result('late old answer', 7));
    });
    const running = captureAgentTurnOutcome(f.params);
    await until(() => oldCalls === 1);
    f.expire();
    if (schedule === 'fallback-inflight') {
      await until(() => fallbackCalls === 1);
      old.resolve(result('late old answer', 7));
      await until(() => f.records.length === 1);
      fallback.resolve(result('fallback', 1));
    }
    const outcome = await running;
    const published = JSON.stringify(outcome);
    if (schedule === 'after-return') old.resolve(result('late old answer', 7));
    await f.join();
    expect(JSON.stringify(outcome)).toBe(published);
    expect(oldCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(outcome).toMatchObject({
      kind: 'succeeded',
      result: {
        model: 'new',
        text: 'fallback',
        usage: schedule === 'after-return' ? { input: 1, output: 1 } : { input: 8, output: 8 },
        usageCoverage: {
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: schedule === 'after-return' ? 1 : 0,
        },
      },
    });
    expect(
      f.records.map((record) => [
        record.model,
        record.attemptNumber,
        record.invocation?.chainAttempt,
      ]),
    ).toEqual(
      schedule === 'fallback-inflight'
        ? [
            ['old', 1, 1],
            ['new', 2, 2],
          ]
        : [
            ['new', 2, 2],
            ['old', 1, 1],
          ],
    );
    expect(f.fold.snapshot().coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
    expect(f.fold.retainedInvocations).toBe(0);
  });
}

it('the installed OpenAI SDK late generate receipt retains its original ledger diagnostic', async () => {
  const old = deferred<Response>();
  let oldCalls = 0;
  let fallbackCalls = 0;
  const wire = (text: string, tokens: number) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: text }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: tokens,
          completion_tokens: tokens,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { audio_tokens: 0 },
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const first = createOpenAiAdapter({
    baseURL: 'https://late-old.invalid/v1',
    fetch: () => {
      oldCalls++;
      return old.promise;
    },
  });
  const second = createOpenAiAdapter({
    baseURL: 'https://late-new.invalid/v1',
    fetch: () => {
      fallbackCalls++;
      return Promise.resolve(wire('fallback', 1));
    },
  });
  const f = fixture(first, second, () => old.resolve(wire('late old answer', 7)));
  const running = captureAgentTurnOutcome(f.params);
  await until(() => oldCalls === 1);
  f.expire();
  const outcome = await running;
  const published = JSON.stringify(outcome);
  await f.join();
  expect(JSON.stringify(outcome)).toBe(published);
  expect(outcome).toMatchObject({ kind: 'succeeded', result: { model: 'new', text: 'fallback' } });
  expect(oldCalls).toBe(1);
  expect(fallbackCalls).toBe(1);
  expect(
    f.records.map((record) => [
      record.model,
      record.attemptNumber,
      record.invocation?.chainAttempt,
    ]),
  ).toEqual([
    ['new', 2, 2],
    ['old', 1, 1],
  ]);
  expect(f.fold.snapshot().coverage.unknownCalls).toBe(0);
  expect(f.fold.retainedInvocations).toBe(0);
});
