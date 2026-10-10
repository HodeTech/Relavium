import { expect, it } from 'vitest';
import { UsageCoverageFold, unwiredEffectJournal } from '@relavium/shared';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import type { ModelPricing, PreparedOutputCapPlan } from '@relavium/llm';
import { parseWorkflow } from '../parser.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { BudgetGovernor } from './budget-governor.js';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import { MoneyDurability, type SettledAttemptDraft } from './money-durability.js';

const model = 'native-repair-admission';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 10000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 0,
};
const prices = new Map([
  [model, price],
  ['native-repair-fallback', { ...price, nativeId: 'native-repair-fallback' }],
]);
function fixture({
  custom = true,
  cap = 20,
  final = 'zero',
  failDisposition = false,
  cancelBeforeRepair = false,
  pause = false,
  hold,
  fallback = false,
}: {
  custom?: boolean;
  cap?: number;
  final?: 'zero' | 'positive' | 'failure';
  failDisposition?: boolean;
  cancelBeforeRepair?: boolean;
  pause?: boolean;
  hold?: 'admission' | 'pending';
  fallback?: boolean;
} = {}) {
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timers = new Set<() => void>();
  const retained = new Set<Promise<unknown>>();
  const plans: PreparedOutputCapPlan[] = [];
  const fold = new UsageCoverageFold();
  fold.start('complete');
  let calls = 0,
    ordinal = 0,
    cost = 0,
    admissions = 0;
  const bodies: string[] = [],
    actions: string[] = [],
    settlements: SettledAttemptDraft[] = [];
  const governor = new BudgetGovernor({
    budget: { max_cost_microcents: cap, on_exceed: pause ? 'pause_for_approval' : 'fail' },
    resolvePrice: prices,
    emit: () => Promise.resolve(),
  });
  const money = new MoneyDurability({
    beginUsageInvocation: async (draft) => {
      const invocation = Object.freeze({
        producerId: 'repair',
        ordinal: ++ordinal,
        dispatchId: draft.nodeId,
        round: draft.round,
        chainAttempt: draft.chainAttempt,
      });
      if (hold === 'pending' && ordinal === 2) await held;
      fold.pending(draft.model, invocation);
      return invocation;
    },
    emitUsageDisposition: (draft) => {
      if (failDisposition) throw new Error('failed predecessor coverage write');
      fold.disposition(draft.model, draft.invocation, draft.disposition, draft.receiptPending);
    },
    emit: (draft) => {
      settlements.push(draft);
      if (draft.invocation !== undefined) fold.complete(draft.model, draft.invocation);
    },
    flushConservative: () => governor.flushCommitments(),
  });
  const provider = createOpenAiAdapter({
    ...(custom ? { baseURL: 'https://offline.invalid/v1' } : {}),
    maxRetries: 0,
    fetch: (_url, init) => {
      calls++;
      if (typeof init?.body !== 'string') throw new Error('expected native JSON request');
      bodies.push(init.body);
      if (calls === 1)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                message: 'Unsupported parameter: temperature',
                param: 'temperature',
                code: 'unsupported_parameter',
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        );
      if (final === 'failure')
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'invalid authorization' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        );
      return Promise.resolve(
        new Response(
          'data: ' +
            JSON.stringify({
              id: 'offline',
              choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 0,
                completion_tokens: final === 'positive' ? 2 : 0,
                prompt_tokens_details: { cached_tokens: 0 },
              },
            }) +
            '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    },
  });
  const params: AgentTurnParams = {
    nodeId: 'repair',
    messages: [],
    temperature: 0.7,
    maxTokens: 10,
    planEntries: [
      { provider, model, maxAttempts: 1 },
      ...(fallback ? [{ provider, model: 'native-repair-fallback', maxAttempts: 1 }] : []),
    ],
    chainCapabilities: {
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      newAbortController: () => new AbortController(),
      ...(hold === undefined
        ? {}
        : {
            attemptTimeoutMs: 5,
            setTimer: (_ms: number, callback: () => void) => {
              timers.add(callback);
              return () => {
                timers.delete(callback);
              };
            },
          }),
    },
    signal: controller.signal,
    retainWork: (factory) => {
      const raw = factory();
      retained.add(raw);
      void raw.then(
        () => retained.delete(raw),
        () => retained.delete(raw),
      );
      return raw;
    },
    emit: (event) => {
      if (event.type === 'cost:updated') {
        cost += event.costMicrocents;
        governor.updateCost(cost);
      }
    },
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unexpected tool')),
    },
    dispatchContext: {
      nodeId: 'repair',
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
    money: money.turnPort(() => cost),
    preEgress: async (info) => {
      admissions++;
      if (info.route !== 'text') throw new Error('expected text invocation');
      plans.push(info.outputCapPlan);
      const admission = await governor.checkPreEgress(info);
      if (admissions === 2 && hold === 'admission') await held;
      if (admissions === 2 && cancelBeforeRepair) controller.abort();
      if (admission === undefined) return;
      expect(admission.reservedMicrocents).toBe(10);
      if (admission.reservedMicrocents === undefined) throw new Error('missing estimate');
      return {
        reservedMicrocents: admission.reservedMicrocents,
        release: () => {
          actions.push('release');
          admission.release();
        },
        settle: (actual) => {
          actions.push(`actual:${actual}`);
          admission.settle(actual);
        },
        settleAtReservedEstimate: (context) => {
          actions.push('conservative');
          admission.settleAtReservedEstimate(context);
        },
      };
    },
  };
  return {
    params,
    provider,
    money,
    governor,
    fold,
    settlements,
    bodies,
    plans,
    release,
    pending: () => ordinal,
    retained,
    expire: () => {
      for (const fire of [...timers]) fire();
    },
    actions,
    calls: () => calls,
    admissions: () => admissions,
    cost: () => cost,
  };
}

for (const custom of [false, true])
  for (const cap of [10, 20])
    for (const final of ['zero', 'positive'] as const)
      it(`actual SDK ${custom ? 'custom' : 'official'} repair reserves each call (cap=${cap}, final=${final})`, async () => {
        const h = fixture({ custom, cap, final });
        const outcome = await captureAgentTurnOutcome(h.params);
        const blocked = custom && cap === 10;
        expect(outcome.kind).toBe(blocked ? 'failed' : 'succeeded');
        expect(h.calls()).toBe(blocked ? 1 : 2);
        expect(h.admissions()).toBe(2);
        expect(h.plans[1]).toBe(h.plans[0]);
        expect(Object.isFrozen(h.plans[0])).toBe(true);
        expect(h.governor.conservativeCostMicrocents).toBe(custom ? 10 : 0);
        expect(h.cost()).toBe(!blocked && final === 'positive' ? 2 : 0);
        expect(h.actions).toEqual([
          custom ? 'conservative' : 'release',
          ...(blocked ? [] : [`actual:${final === 'positive' ? 2 : 0}`]),
        ]);
        expect(h.fold.snapshot().coverage).toEqual({
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: custom ? 1 : 0,
        });
        expect(h.settlements).toHaveLength(blocked ? 0 : 1);
        for (const body of h.bodies)
          expect(JSON.parse(body)).toMatchObject(
            custom ? { max_tokens: 10 } : { max_completion_tokens: 10 },
          );
      });

for (const custom of [false, true])
  it(`actual SDK repaired auth failure keeps each ${custom ? 'custom unknown' : 'official refusal'} obligation`, async () => {
    const h = fixture({ custom, final: 'failure' });
    const outcome = await captureAgentTurnOutcome(h.params);
    expect(outcome.kind).toBe('failed');
    expect(h.calls()).toBe(2);
    expect(h.actions).toEqual(custom ? ['conservative', 'conservative'] : ['release', 'release']);
    expect(h.governor.conservativeCostMicrocents).toBe(custom ? 20 : 0);
    expect(h.fold.snapshot().coverage.unknownCalls).toBe(custom ? 2 : 0);
    expect(h.settlements).toEqual([]);
  });

it('failed native predecessor durability blocks repair before fresh admission or SDK create', async () => {
  const h = fixture({ failDisposition: true });
  expect((await captureAgentTurnOutcome(h.params)).kind).toBe('failed');
  expect(h.calls()).toBe(1);
  expect(h.admissions()).toBe(1);
  expect(h.actions).toEqual(['conservative']);
  expect(h.money.durabilityBroken).toBe(true);
  expect(h.governor.conservativeCostMicrocents).toBe(10);
});

it('cancellation during fresh native admission releases only that uninvoked repair', async () => {
  const h = fixture({ cancelBeforeRepair: true });
  expect((await captureAgentTurnOutcome(h.params)).kind).toBe('failed');
  expect(h.calls()).toBe(1);
  expect(h.admissions()).toBe(2);
  expect(h.actions).toEqual(['conservative', 'release']);
  expect(h.governor.conservativeCostMicrocents).toBe(10);
  expect(h.fold.snapshot().coverage).toEqual({
    unverified: false,
    pendingInvocations: 0,
    unknownCalls: 1,
  });
});

it('native repair capacity refusal preserves budget pause provenance', async () => {
  const h = fixture({ cap: 10, pause: true });
  const outcome = await captureAgentTurnOutcome(h.params);
  expect(outcome.kind).toBe('failed');
  if (outcome.kind === 'failed') {
    expect(outcome.failureOrigin).toBe('turn');
    expect(outcome.error).toMatchObject({ name: 'BudgetPauseError' });
  }
  expect(h.calls()).toBe(1);
  expect(h.governor.conservativeCostMicrocents).toBe(10);
});

for (const hold of ['admission', 'pending'] as const)
  it(`native deadline during repair ${hold} disposes only the late uninvoked lease`, async () => {
    const h = fixture({ hold });
    const running = captureAgentTurnOutcome(h.params);
    for (let i = 0; i < 1000 && (hold === 'pending' ? h.pending() < 2 : h.admissions() < 2); i++)
      await Promise.resolve();
    expect(h.admissions()).toBe(2);
    if (hold === 'pending') expect(h.pending()).toBe(2);
    h.expire();
    // Give the public deadline its opportunity to report the exact non-invoked slot.
    for (let i = 0; i < 100; i++) await Promise.resolve();
    h.release();
    const outcome = await running;
    expect(outcome.kind).toBe('failed');
    while (h.retained.size > 0) await Promise.allSettled([...h.retained]);
    await h.money.join();
    expect(h.calls()).toBe(1);
    expect(h.actions).toEqual(['conservative', 'release']);
    expect(h.governor.conservativeCostMicrocents).toBe(10);
    expect(h.fold.snapshot().coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 1,
    });
  });

it('a repair admission completing after a newer fallback settles cannot consume that fallback lease', async () => {
  const h = fixture({ hold: 'admission', fallback: true, cap: 30 });
  const running = captureAgentTurnOutcome(h.params);
  for (let i = 0; i < 1000 && h.admissions() < 2; i++) await Promise.resolve();
  expect(h.admissions()).toBe(2);
  h.expire();
  const outcome = await running;
  expect(outcome.kind).toBe('succeeded');
  expect(h.calls()).toBe(2);
  expect(h.admissions()).toBe(3);
  expect(h.actions).toEqual(['conservative', 'actual:0']);
  h.release();
  while (h.retained.size > 0) await Promise.allSettled([...h.retained]);
  await h.money.join();
  expect(h.actions).toEqual(['conservative', 'actual:0', 'release']);
  expect(h.governor.conservativeCostMicrocents).toBe(10);
  expect(h.fold.snapshot().coverage).toEqual({
    unverified: false,
    pendingInvocations: 0,
    unknownCalls: 1,
  });
});

for (const custom of [false, true])
  for (const cap of [10, 20])
    it(`actual workflow persists native repair exposure (custom=${custom}, cap=${cap})`, async () => {
      const h = fixture({ custom });
      const actualPrices = new Map([[model, { ...price, inputPerMtokMicrocents: 0 }]]);
      const store = new InMemoryRunStore(),
        host = createInMemoryHost({ store });
      const executor = createAgentNodeExecutor({
        resolveProvider: () => h.provider,
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        registry: h.params.registry,
        tools: [],
        resolvePrice: actualPrices,
      });
      const workflow = parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'native-repair-admission',
            budget: { max_cost_microcents: cap, on_exceed: 'fail' },
            agents: [
              {
                id: 'a',
                provider: 'openai',
                model,
                system_prompt: 'offline',
                temperature: 0.7,
                max_tokens: 10,
              },
            ],
            nodes: [{ id: 'a', type: 'agent', agent_ref: 'a', prompt_template: 'hi' }],
            edges: [],
          },
        }),
      );
      const handle = new WorkflowEngine({ host, executor, resolvePrice: actualPrices }).start({
        workflow,
      });
      for await (const event of handle.events) expect(event.runId).toBe(handle.runId);
      const blocked = custom && cap === 10;
      const events = store.eventsFor(handle.runId);
      expect(events.at(-1)?.type).toBe(blocked ? 'run:failed' : 'run:completed');
      expect(h.calls()).toBe(blocked ? 1 : 2);
      const cp = await host.checkpointer.load(handle.runId);
      expect(cp?.cumulativeCostMicrocents).toBe(0);
      expect(cp?.conservativeCostMicrocents).toBe(custom ? 10 : 0);
      expect(cp?.usageCoverage?.coverage).toEqual({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: custom ? 1 : 0,
      });
      expect(events.filter((event) => event.type === 'budget:estimate_committed')).toHaveLength(
        custom ? 1 : 0,
      );
      expect(await handle.depart()).toMatchObject({ moneyDurability: 'durable' });
    });
