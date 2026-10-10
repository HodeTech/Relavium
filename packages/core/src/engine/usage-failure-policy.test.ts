import { expect, it } from 'vitest';
import {
  AgentSchema,
  SessionContextSchema,
  UsageCoverageFold,
  unwiredEffectJournal,
  type UsageDisposition,
  type UsageEvidence,
} from '@relavium/shared';
import {
  LlmProviderError,
  makeLlmError,
  type LlmInvocationOptions,
  type LlmProvider,
  type ModelPricing,
  type StreamChunk,
} from '@relavium/llm';
import { parseWorkflow } from '../parser.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { WorkflowEngine } from './engine.js';
import { AgentSession, type SessionStreamEvent } from './agent-session.js';
import { BudgetGovernor } from './budget-governor.js';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import {
  LedgerDurabilityError,
  MoneyDurability,
  type SettledAttemptDraft,
} from './money-durability.js';

const model = 'usage-failure-policy';
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
const prices = new Map([[model, price]]);
const missing: UsageEvidence = { kind: 'missing', reason: 'not_reported' };
const partial: UsageEvidence = {
  kind: 'partial',
  known: { inputTokens: 5 },
  reason: 'missing_fields',
};
const partialZero: UsageEvidence = {
  kind: 'partial',
  known: { inputTokens: 0 },
  reason: 'missing_fields',
};
const completeZero: UsageEvidence = {
  kind: 'complete',
  usage: { inputTokens: 0, outputTokens: 0 },
};
const registry = {
  has: () => false,
  list: () => [],
  dispatch: () => Promise.reject(new Error('unexpected tool')),
};
type Primary = 'bad_request' | 'auth' | 'context_overflow' | 'cancelled' | 'observer' | 'success';
function fixture({
  mode = 'stream',
  evidence = missing,
  custom = false,
  budgeted = false,
  failDisposition = false,
  primary = 'bad_request',
  omitUsage = false,
  nativeRepair = false,
  visibleContent = false,
}: {
  mode?: 'generate' | 'stream';
  evidence?: UsageEvidence;
  custom?: boolean;
  budgeted?: boolean;
  failDisposition?: boolean;
  primary?: Primary;
  omitUsage?: boolean;
  nativeRepair?: boolean;
  visibleContent?: boolean;
} = {}) {
  const fold = new UsageCoverageFold();
  fold.start('complete');
  let calls = 0,
    ordinal = 0,
    cumulative = 0;
  const observerFailure = new Error('original observer failure');
  const dispositions: UsageDisposition[] = [],
    settlements: SettledAttemptDraft[] = [];
  const governor = new BudgetGovernor({
    budget: { max_cost_microcents: 10000, on_exceed: 'fail' },
    resolvePrice: prices,
    emit: () => Promise.resolve(),
  });
  const money = new MoneyDurability({
    beginUsageInvocation: (draft) => {
      const invocation = Object.freeze({
        producerId: 'failure-policy',
        ordinal: ++ordinal,
        dispatchId: draft.nodeId,
        round: draft.round,
        chainAttempt: draft.chainAttempt,
      });
      fold.pending(draft.model, invocation);
      return Promise.resolve(invocation);
    },
    emitUsageDisposition: (draft) => {
      dispositions.push(draft.disposition);
      if (failDisposition) throw new Error('secondary disposition failure');
      fold.disposition(draft.model, draft.invocation, draft.disposition, draft.receiptPending);
    },
    emit: (draft) => {
      if (primary === 'observer' && failDisposition)
        throw new Error('secondary actual write failure');
      settlements.push(draft);
      if (draft.invocation !== undefined) fold.complete(draft.model, draft.invocation);
    },
    ...(budgeted ? { flushConservative: () => governor.flushCommitments() } : {}),
  });
  const error = {
    ...makeLlmError({
      provider: 'openai',
      kind: primary === 'observer' || primary === 'success' ? 'bad_request' : primary,
      status: primary === 'auth' ? 401 : 400,
      message: 'original provider diagnosis',
    }),
    retryable: false,
    ...(omitUsage ? {} : { usage: evidence }),
  };
  const repair = async (options?: LlmInvocationOptions): Promise<void> => {
    await options?.beforeNativeRetry?.(error);
    options?.nativeInvocationStarted?.();
    calls++;
  };
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: custom,
    supports: {
      tools: false,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [['image']],
      },
    },
    generate: async (_request, _key, options) => {
      calls++;
      if (nativeRepair) {
        await repair(options);
        return { content: [], stopReason: 'stop', usage: completeZero };
      }
      return primary === 'success'
        ? Promise.resolve({ content: [], stopReason: 'stop', usage: evidence })
        : Promise.reject(new LlmProviderError(error));
    },
    stream: async function* (_request, _key, options): AsyncGenerator<StreamChunk> {
      calls++;
      await Promise.resolve();
      if (nativeRepair) {
        await repair(options);
        yield { type: 'stop', stopReason: 'stop', usage: completeZero };
        return;
      }
      if (visibleContent) yield { type: 'text_delta', text: 'visible' };
      if (primary === 'observer') yield { type: 'text_delta', text: 'visible' };
      if (primary === 'success' || primary === 'observer')
        yield { type: 'stop', stopReason: 'stop', usage: evidence };
      else yield { type: 'error', error };
    },
  };
  const moneyPort = money.turnPort(() => cumulative);
  const params: AgentTurnParams = {
    nodeId: 'policy',
    messages: [],
    planEntries: [{ provider, model, maxAttempts: 1 }],
    chainCapabilities: {
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      newAbortController: () => new AbortController(),
    },
    signal: new AbortController().signal,
    emit: (event) => {
      if (primary === 'observer' && event.type === 'cost:updated') throw observerFailure;
      if (event.type === 'cost:updated') {
        cumulative += event.costMicrocents;
        governor.updateCost(cumulative);
      }
    },
    registry,
    dispatchContext: {
      nodeId: 'policy',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
    maxTokens: 10,
    resolvePrice: prices,
    money: moneyPort,
    ...(mode === 'generate' ? { outputModalities: ['image'] } : {}),
    ...(budgeted ? { preEgress: (info) => governor.checkPreEgress(info) } : {}),
  };
  return {
    provider,
    fold,
    money,
    moneyPort,
    governor,
    params,
    dispositions,
    settlements,
    observerFailure,
    calls: () => calls,
  };
}

const evidenceCases = [
  { label: 'omitted', evidence: missing, omitUsage: true },
  { label: 'missing', evidence: missing, omitUsage: false },
  { label: 'partial', evidence: partial, omitUsage: false },
  { label: 'partial-zero', evidence: partialZero, omitUsage: false },
  { label: 'complete-zero', evidence: completeZero, omitUsage: false },
];
for (const mode of ['generate', 'stream'] as const)
  for (const custom of [false, true])
    for (const nativeRepair of [false, true])
      for (const { label, evidence, omitUsage } of evidenceCases)
        it(`${mode} ${custom ? 'custom' : 'official'} 400 ${label} ${nativeRepair ? 'native predecessor' : 'direct'} preserves usage and cap obligations`, async () => {
          const h = fixture({ mode, custom, evidence, omitUsage, nativeRepair, budgeted: true });
          const outcome = await captureAgentTurnOutcome(h.params);
          expect(outcome.kind).toBe(nativeRepair ? 'succeeded' : 'failed');
          expect(h.calls()).toBe(nativeRepair ? 2 : 1);
          if (!nativeRepair && outcome.kind === 'failed')
            expect(outcome.error).toMatchObject({
              code: 'validation',
              message: 'original provider diagnosis',
            });
          const released = !custom && evidence.kind === 'missing';
          expect(h.fold.snapshot().coverage).toEqual({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: evidence.kind === 'complete' || released ? 0 : 1,
          });
          expect(h.governor.conservativeCostMicrocents > 0).toBe(
            evidence.kind !== 'complete' && !released,
          );
          expect(h.settlements).toHaveLength(
            (evidence.kind === 'complete' ? 1 : 0) + (nativeRepair ? 1 : 0),
          );
          for (const settlement of h.settlements)
            expect(settlement).toMatchObject({
              inputTokens: 0,
              outputTokens: 0,
              costMicrocents: 0,
              priced: true,
            });
          expect(h.dispositions).toEqual(
            evidence.kind === 'complete'
              ? []
              : [
                  released
                    ? { kind: 'official_refusal', reason: 'pre_content_refusal' }
                    : { kind: 'incomplete', evidence },
                ],
          );
        });

for (const omitUsage of [false, true])
  it(`actual visible content retains missing usage uncertainty (omitted=${omitUsage})`, async () => {
    const h = fixture({ omitUsage, visibleContent: true, budgeted: true });
    const outcome = await captureAgentTurnOutcome(h.params);
    expect(outcome.kind).toBe('failed');
    expect(h.calls()).toBe(1);
    expect(h.fold.snapshot().coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 1,
    });
    expect(h.governor.conservativeCostMicrocents).toBeGreaterThan(0);
    expect(h.settlements).toEqual([]);
    expect(h.dispositions).toEqual([{ kind: 'incomplete', evidence: missing }]);
  });

for (const budgeted of [false, true])
  for (const primary of ['auth', 'context_overflow', 'cancelled', 'observer'] as const)
    it(`preserves ${primary} primary identity/origin while draining secondary write failure (cap=${budgeted})`, async () => {
      const h = fixture({
        primary,
        budgeted,
        failDisposition: true,
        ...(primary === 'observer' ? { evidence: completeZero } : {}),
      });
      const outcome = await captureAgentTurnOutcome(h.params);
      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') throw new Error('missing failure');
      if (primary === 'observer') {
        expect(outcome.error).toBe(h.observerFailure);
        expect(outcome.failureOrigin).toBe('observer');
      } else {
        expect(outcome.failureOrigin).toBe('turn');
        expect(outcome.error).toMatchObject({
          code:
            primary === 'auth'
              ? 'provider_auth'
              : primary === 'context_overflow'
                ? 'context_overflow'
                : 'cancelled',
        });
        if (primary === 'context_overflow') expect(outcome.overflowEntry).toMatchObject({ model });
      }
      expect(h.money.durabilityBroken).toBe(true);
      await h.money.waitForWrites();
      expect(h.dispositions).toHaveLength(primary === 'observer' ? 0 : 1);
      const next = await captureAgentTurnOutcome(h.params);
      expect(next.kind).toBe('failed');
      expect(h.calls()).toBe(1);
    });

for (const budgeted of [false, true])
  for (const failDisposition of [false, true])
    it(`actual session keeps provider_auth as primary (cap=${budgeted}, failed write=${failDisposition})`, async () => {
      const h = fixture({ primary: 'auth', budgeted, failDisposition });
      const events: SessionStreamEvent[] = [];
      const session = new AgentSession({
        sessionId: 'policy',
        agentRef: 'policy',
        agent: AgentSchema.parse({
          id: 'policy',
          provider: 'openai',
          model,
          system_prompt: 'offline',
          max_tokens: 10,
        }),
        context: SessionContextSchema.parse({ workingDir: '/workspace', fsScopeTier: 'sandboxed' }),
        deps: {
          resolveProvider: () => h.provider,
          keyFor: () => 'offline',
          sleep: () => Promise.resolve(),
          registry,
          tools: [],
          newAbortController: () => new AbortController(),
          reserveEffectTurnKey: () => 1,
          money: h.moneyPort,
          resolvePrice: prices,
          autoCompact: false,
          emit: (event) => {
            events.push(event);
          },
          ...(budgeted ? { preEgress: (info) => h.governor.checkPreEgress(info) } : {}),
        },
      });
      session.start();
      await expect(session.sendMessage('hello')).resolves.toBeUndefined();
      expect(events.find((event) => event.type === 'session:turn_completed')).toMatchObject({
        error: { code: 'provider_auth', message: 'original provider diagnosis' },
      });
      expect(h.money.durabilityBroken).toBe(failDisposition);
      expect(h.settlements).toEqual([]);
      if (failDisposition) {
        await session.sendMessage('must not spend');
        expect(h.calls()).toBe(1);
      }
    });

it('a previously successful turn still fails its money boundary and blocks the next invocation', async () => {
  const h = fixture({ primary: 'success', failDisposition: true });
  const outcome = await captureAgentTurnOutcome(h.params);
  expect(outcome.kind).toBe('failed');
  if (outcome.kind === 'failed') expect(outcome.error).toBeInstanceOf(LedgerDurabilityError);
  expect(h.money.durabilityBroken).toBe(true);
  await captureAgentTurnOutcome(h.params);
  expect(h.calls()).toBe(1);
});

for (const budgeted of [false, true])
  for (const summarising of [false, true])
    it(`actual session ${summarising ? 'summary' : 'turn'} partial refusal stays unknown (cap=${budgeted})`, async () => {
      const h = fixture({ evidence: partial, budgeted });
      const events: SessionStreamEvent[] = [];
      const init = {
        sessionId: 'policy',
        agentRef: 'policy',
        agent: AgentSchema.parse({
          id: 'policy',
          provider: 'openai',
          model,
          system_prompt: 'offline',
          max_tokens: 10,
        }),
        context: SessionContextSchema.parse({ workingDir: '/workspace', fsScopeTier: 'sandboxed' }),
        deps: {
          resolveProvider: () => h.provider,
          keyFor: () => 'offline',
          sleep: () => Promise.resolve(),
          registry,
          tools: [],
          newAbortController: () => new AbortController(),
          reserveEffectTurnKey: () => 1,
          money: h.moneyPort,
          resolvePrice: prices,
          autoCompact: false,
          emit: (event: SessionStreamEvent) => {
            events.push(event);
          },
          ...(budgeted ? { preEgress: h.params.preEgress } : {}),
        },
      };
      const messages = ['old context', 'middle context', 'latest'].map((text) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text }],
      }));
      const session = summarising
        ? AgentSession.resume(init, {
            messages,
            completedTurnSpans: messages.map((_, i) => ({ start: i, end: i + 1 })),
            turnCount: 3,
            cumulativeCostMicrocents: 0,
            conservativeCostMicrocents: 0,
          })
        : new AgentSession(init);
      if (summarising)
        expect(await session.compact()).toMatchObject({
          kind: 'failed',
          message: 'original provider diagnosis',
        });
      else {
        session.start();
        await session.sendMessage('hello');
        expect(events.find((event) => event.type === 'session:turn_completed')).toMatchObject({
          error: { code: 'validation', message: 'original provider diagnosis' },
        });
      }
      expect(h.calls()).toBe(1);
      expect(h.fold.snapshot().coverage).toEqual({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 1,
      });
      expect(h.dispositions).toEqual([{ kind: 'incomplete', evidence: partial }]);
      expect(h.settlements).toEqual([]);
      expect(h.governor.conservativeCostMicrocents > 0).toBe(budgeted);
    });

for (const budgeted of [false, true])
  for (const failedWrite of [false, true])
    it(`actual workflow ${failedWrite ? 'auth with secondary write failure' : 'partial refusal'} preserves durable qualifications (cap=${budgeted})`, async () => {
      const h = fixture({
        primary: failedWrite ? 'auth' : 'bad_request',
        evidence: failedWrite ? missing : partial,
      });
      class Store extends InMemoryRunStore {
        override persistEvent(...args: Parameters<InMemoryRunStore['persistEvent']>) {
          if (failedWrite && args[0].type === 'cost:usage_disposition')
            return Promise.reject(new Error('secondary disposition failure'));
          return super.persistEvent(...args);
        }
      }
      const store = new Store(),
        host = createInMemoryHost({ store });
      const workflow = parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'usage-failure-policy',
            agents: [
              { id: 'a', provider: 'openai', model, system_prompt: 'offline', max_tokens: 10 },
            ],
            nodes: [{ id: 'a', type: 'agent', agent_ref: 'a', prompt_template: 'hello' }],
            edges: [],
            ...(budgeted ? { budget: { max_cost_microcents: 10000, on_exceed: 'fail' } } : {}),
          },
        }),
      );
      const executor = createAgentNodeExecutor({
        resolveProvider: () => h.provider,
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        tools: [],
        registry,
        resolvePrice: prices,
      });
      const handle = new WorkflowEngine({ host, executor, resolvePrice: prices }).start({
        workflow,
      });
      for await (const event of handle.events) {
        expect(event.runId).toBe(handle.runId);
      }
      expect(h.calls()).toBe(1);
      const checkpoint = await host.checkpointer.load(handle.runId);
      expect(checkpoint?.cumulativeCostMicrocents).toBe(0);
      expect(checkpoint?.usageCoverage?.coverage).toEqual({
        unverified: false,
        pendingInvocations: failedWrite ? 1 : 0,
        unknownCalls: failedWrite ? 0 : 1,
      });
      expect(
        store.eventsFor(handle.runId).filter((event) => event.type === 'cost:attempt_settled'),
      ).toEqual([]);
      expect(await handle.depart()).toMatchObject({
        moneyDurability: failedWrite ? 'uncertain' : 'durable',
      });
      if (!failedWrite) {
        expect(
          store.eventsFor(handle.runId).find((event) => event.type === 'cost:usage_disposition'),
        ).toMatchObject({ disposition: { kind: 'incomplete', evidence: partial } });
        expect((checkpoint?.conservativeCostMicrocents ?? 0) > 0).toBe(budgeted);
      }
    });
