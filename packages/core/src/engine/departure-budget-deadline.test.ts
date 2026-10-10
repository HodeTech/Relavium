import { expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { createAgentNodeExecutor } from './agent-runner.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import { parseWorkflow } from '../parser.js';
import type { BudgetDispatchPreparationResult, NodeExecutor } from './node-executor.js';

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const model = 'offline-departure-budget';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 100000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};
for (const mode of [
  'refused',
  'held-refused',
  'held-live',
  'timer-overlap',
  'not-due',
  'human',
  'reject',
] as const) {
  it(`departure services a due budget gate exactly once: ${mode}`, async () => {
    let now = 0,
      preparations = 0,
      calls = 0;
    const entered = latch<void>();
    const release = latch<void>();
    const provider: LlmProvider = {
      id: 'openai',
      customEndpoint: true,
      supports: {
        tools: false,
        streaming: true,
        parallelToolCalls: false,
        vision: false,
        promptCache: false,
        reasoning: false,
        media: {
          input: { image: false, audio: false, video: false, document: false },
          outputCombinations: [],
        },
      },
      generate: () => Promise.reject(new Error('unused generate')),
      stream: async function* () {
        calls++;
        await Promise.resolve();
        yield { type: 'text_delta', text: 'actual output' };
        yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const prices = new Map([[model, price]]);
    const runner = createAgentNodeExecutor({
      resolveProvider: () => provider,
      keyFor: () => 'synthetic',
      sleep: () => Promise.resolve(),
      tools: [],
      registry: {
        has: () => false,
        list: () => [],
        dispatch: () => Promise.reject(new Error('unused tool')),
      },
      resolvePrice: prices,
    });
    const prepare = runner.prepareBudgetDispatch?.bind(runner);
    if (prepare === undefined) throw new Error('actual runner must prepare');
    const executor: NodeExecutor = {
      execute: async (ctx) => {
        const outcome =
          mode === 'human'
            ? {
                kind: 'paused' as const,
                gate: { gateType: 'approval' as const, message: 'ordinary gate' },
              }
            : await runner.execute(ctx);
        return outcome.kind === 'paused'
          ? {
              ...outcome,
              gate: {
                ...outcome.gate,
                timeoutMs: 1000,
                timeoutAction: mode === 'reject' ? 'reject' : 'approve',
              },
            }
          : outcome;
      },
      prepareBudgetDispatch: async (ctx): Promise<BudgetDispatchPreparationResult> => {
        preparations++;
        entered.resolve();
        if (mode === 'held-refused' || mode === 'held-live' || mode === 'timer-overlap')
          await release.promise;
        return mode === 'held-live'
          ? prepare(ctx)
          : {
              kind: 'failed',
              error: {
                code: 'validation',
                message: 'synthetic preparation refusal',
                retryable: false,
              },
            };
      },
    };
    const base = createInMemoryHost();
    const host: typeof base = { ...base, clock: { now: () => new Date(now).toISOString() } };
    const handle = new WorkflowEngine({ host, executor, resolvePrice: prices }).start({
      workflow: parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'departure-budget-deadline',
            budget: {
              max_cost_microcents: 1,
              on_exceed: 'pause_for_approval',
              strict_cost_cap: true,
            },
            agents: [{ id: 'a', provider: 'openai', model, system_prompt: 's' }],
            nodes: [
              { id: 'work', type: 'agent', agent_ref: 'a', prompt_template: 'hi', max_tokens: 64 },
            ],
            edges: [],
          },
        }),
      ),
    });
    const iterator = handle.events[Symbol.asyncIterator]();
    const events: RunEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error('expected actual pause');
      events.push(next.value);
      if (next.value.type === 'run:paused') break;
    }
    const drained = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        events.push(next.value);
      }
    })();
    now = mode === 'not-due' ? 999 : 1000;
    if (mode === 'timer-overlap') base.fireTimers();
    let returned = false;
    const departure = handle.depart().then((value) => {
      returned = true;
      return value;
    });
    if (mode === 'held-refused' || mode === 'held-live' || mode === 'timer-overlap') {
      await entered.promise;
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(preparations).toBe(1);
      expect(returned).toBe(false);
      expect(await host.runLeases.read(handle.runId)).toBeDefined();
      base.fireTimers();
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(preparations).toBe(1);
      expect(calls).toBe(0);
      release.resolve();
    }
    const first = await departure;
    await drained;
    expect(preparations).toBe(['human', 'reject', 'not-due'].includes(mode) ? 0 : 1);
    expect(first.kind).toBe(mode === 'not-due' ? 'detached' : 'continue');
    if (mode === 'not-due') {
      expect(
        events.some((event) => event.type === 'run:completed' || event.type === 'run:failed'),
      ).toBe(false);
    } else {
      expect(events.at(-1)).toMatchObject(
        mode === 'human' || mode === 'held-live'
          ? { type: 'run:completed' }
          : { type: 'run:failed', error: { code: 'run_timeout' } },
      );
      expect((await handle.depart()).kind).toBe('closed');
      expect(
        events.filter((event) =>
          ['run:completed', 'run:failed', 'run:cancelled'].includes(event.type),
        ),
      ).toHaveLength(1);
    }
    expect(calls).toBe(mode === 'held-live' ? 1 : 0);
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    expect(await host.runLeases.read(handle.runId)).toBeUndefined();
  });
}
