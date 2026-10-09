import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import {
  WorkflowEngine,
  createAgentNodeExecutor,
  createInMemoryHost,
  InMemoryRunStore,
  parseWorkflow,
  reconstructCheckpointState,
  createDispatchingNodeExecutor,
} from '../index.js';
import type { BudgetDispatchPreparationResult } from './node-executor.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('not initialized');
  };
  let reject: (reason: Error) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const MODEL = 'independent-contracts';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 100000,
  maxOutputTokens: 1000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 1000000,
};
async function raceFixture() {
  let calls = 0;
  let keys = 0;
  let preparing = 0;
  const firstPreparation = deferred<BudgetDispatchPreparationResult>();
  const enteredPreparation = deferred<void>();
  const enteredDecision = deferred<void>();
  const releaseDecision = deferred<void>();
  const paused = deferred<void>();
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
      yield { type: 'text_delta', text: 'INDEPENDENT_REAL_OUTPUT' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const prices = new Map([[MODEL, price]]);
  const agent = createAgentNodeExecutor({
    resolveProvider: () => provider,
    keyFor: () => {
      keys++;
      return 'synthetic';
    },
    sleep: () => Promise.resolve(),
    tools: [],
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unused tool')),
    },
    resolvePrice: prices,
  });
  const runner = createDispatchingNodeExecutor({ agent });
  const prepare = runner.prepareBudgetDispatch?.bind(runner);
  if (prepare === undefined) throw new Error('real runner must prepare');
  const persistedDecisions: RunEvent[] = [];
  const store = new InMemoryRunStore();
  const base = createInMemoryHost({ store });
  const host = {
    ...base,
    store: {
      resolveWorkflowId: store.resolveWorkflowId.bind(store),
      readWorkflowSnapshot: store.readWorkflowSnapshot.bind(store),
      listInterruptedRuns: store.listInterruptedRuns.bind(store),
      persistEvent: async (...args: Parameters<typeof store.persistEvent>) => {
        const event = args[0];
        await store.persistEvent(...args);
        if (event.type === 'budget:authorization' && event.authorization.state === 'decided') {
          persistedDecisions.push(event);
          enteredDecision.resolve();
          await releaseDecision.promise;
        }
      },
    },
  };
  const executor = {
    execute: async (...args: Parameters<typeof runner.execute>) => {
      const outcome = await runner.execute(...args);
      return outcome.kind === 'paused'
        ? {
            ...outcome,
            gate: { ...outcome.gate, timeoutMs: 1000, timeoutAction: 'approve' as const },
          }
        : outcome;
    },
    prepareBudgetDispatch: (...args: Parameters<typeof prepare>) => {
      preparing++;
      if (preparing === 1) {
        enteredPreparation.resolve();
        return firstPreparation.promise;
      }
      return prepare(...args);
    },
  };
  const workflow = parseWorkflow(
    JSON.stringify({
      schema_version: '1.0',
      workflow: {
        id: 'independent-contracts',
        budget: { max_cost_microcents: 1, on_exceed: 'pause_for_approval', strict_cost_cap: true },
        agents: [{ id: 'a', provider: 'openai', model: MODEL, system_prompt: 's' }],
        nodes: [
          { id: 'agent', type: 'agent', agent_ref: 'a', prompt_template: 'hi', max_tokens: 64 },
        ],
        edges: [],
      },
    }),
  );
  const engine = new WorkflowEngine({ host, executor, resolvePrice: prices });
  const handle = engine.start({ workflow });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === 'run:paused') paused.resolve();
    }
  })();
  await Promise.race([paused.promise, drained]);
  const checkpoint = reconstructCheckpointState(events);
  const gate = checkpoint?.pendingGates[0];
  if (
    gate?.allowance?.kind !== 'frozen' ||
    gate.allowance.quote.kind !== 'quoted' ||
    gate.allowance.quote.quote.amount.kind !== 'representable'
  )
    throw new Error('expected real frozen quote: ' + JSON.stringify(events));
  return {
    base,
    engine,
    handle,
    events,
    drained,
    firstPreparation,
    enteredPreparation,
    enteredDecision,
    releaseDecision,
    persistedDecisions,
    gateId: gate.gateId,
    amount: gate.allowance.quote.quote.amount.microcents,
    calls: () => calls,
    keys: () => keys,
  };
}

describe('independent actual runner deadline/decision ordering', () => {
  it.each(['approved', 'rejected'] as const)(
    'preserves a human %s claim awaiting its durable acknowledgement when timeout preparation rejects',
    async (decision) => {
      const r = await raceFixture();
      r.base.fireTimers();
      await r.enteredPreparation.promise;
      const manual = r.engine.resume(r.handle.runId, r.gateId, {
        decision,
        decidedBy: 'independent-human',
        ...(decision === 'approved' ? { approvedAmountMicrocents: r.amount } : {}),
      });
      await r.enteredDecision.promise;
      expect(r.persistedDecisions).toHaveLength(1);
      r.firstPreparation.reject(new Error('synthetic late preparation refusal'));
      for (let i = 0; i < 80; i++) await Promise.resolve();
      r.releaseDecision.resolve();
      await manual;
      await r.drained;
      expect(
        r.events.filter(
          (e) =>
            e.type === 'run:failed' || e.type === 'run:completed' || e.type === 'run:cancelled',
        ),
      ).toHaveLength(1);
      expect(r.events.at(-1)).toMatchObject(
        decision === 'approved'
          ? { type: 'run:completed' }
          : { type: 'run:failed', error: { code: 'budget_exceeded' } },
      );
      expect(r.calls()).toBe(decision === 'approved' ? 1 : 0);
      expect(r.keys()).toBe(decision === 'approved' ? 1 : 0);
      expect(r.base.armedCount()).toBe(0);
      await expect.poll(() => r.base.livenessCount()).toBe(0);
    },
  );
  it('a timeout preparation failure without a competing claim terminates as run_timeout', async () => {
    const r = await raceFixture();
    r.base.fireTimers();
    await r.enteredPreparation.promise;
    r.firstPreparation.reject(new Error('synthetic preparation refusal'));
    for (let i = 0; i < 120; i++) await Promise.resolve();
    const terminal = r.events.at(-1);
    if (terminal?.type === 'run:paused') r.handle.cancel();
    r.releaseDecision.resolve();
    await r.drained;
    expect(terminal).toMatchObject({ type: 'run:failed', error: { code: 'run_timeout' } });
    expect(r.calls()).toBe(0);
    expect(r.keys()).toBe(0);
  });
});

it.each(['approved', 'rejected'] as const)(
  'keeps already acknowledged human %s after a later timeout preparation failure',
  async (decision) => {
    const r = await raceFixture();
    r.base.fireTimers();
    await r.enteredPreparation.promise;
    const manual = r.engine.resume(r.handle.runId, r.gateId, {
      decision,
      decidedBy: 'independent-human',
      ...(decision === 'approved' ? { approvedAmountMicrocents: r.amount } : {}),
    });
    await r.enteredDecision.promise;
    r.releaseDecision.resolve();
    await manual;
    await r.drained;
    r.firstPreparation.reject(new Error('late synthetic refusal'));
    for (let i = 0; i < 80; i++) await Promise.resolve();
    expect(r.events.at(-1)).toMatchObject(
      decision === 'approved'
        ? { type: 'run:completed' }
        : { type: 'run:failed', error: { code: 'budget_exceeded' } },
    );
    expect(r.calls()).toBe(decision === 'approved' ? 1 : 0);
  },
);
it('preserves cancellation while deadline preparation is awaiting host completion', async () => {
  const r = await raceFixture();
  r.base.fireTimers();
  await r.enteredPreparation.promise;
  r.handle.cancel();
  await r.drained;
  r.firstPreparation.reject(new Error('late synthetic refusal'));
  for (let i = 0; i < 80; i++) await Promise.resolve();
  expect(r.events.at(-1)?.type).toBe('run:cancelled');
  expect(r.calls()).toBe(0);
  expect(r.keys()).toBe(0);
  expect(r.base.armedCount()).toBe(0);
  expect(r.base.livenessCount()).toBe(0);
});
