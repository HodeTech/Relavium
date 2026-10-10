import { expect, it } from 'vitest';
import {
  AgentSchema,
  SessionContextSchema,
  UsageCoverageFold,
  unwiredEffectJournal,
  type UsageEvidence,
  type UsageInvocation,
} from '@relavium/shared';
import { makeLlmError, type LlmInvocationOptions, type LlmProvider } from '@relavium/llm';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import { AgentSession } from './agent-session.js';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import {
  LedgerDurabilityError,
  MoneyDurability,
  type PendingUsageDraft,
  type SettledAttemptDraft,
  type TurnMoneyPort,
  type UsageDispositionDraft,
} from './money-durability.js';

type CostEvent = Parameters<NonNullable<TurnMoneyPort['emitCost']>>[0];
type Claim = Parameters<NonNullable<TurnMoneyPort['claimUsage']>>[1];

class PrivateMoneyPort implements TurnMoneyPort {
  readonly #inner: TurnMoneyPort;
  constructor(inner: TurnMoneyPort) {
    this.#inner = inner;
  }
  beginUsageInvocation(draft: PendingUsageDraft): Promise<UsageInvocation> {
    const inner = this.#inner;
    if (inner.beginUsageInvocation === undefined) throw new Error('missing pending capability');
    return inner.beginUsageInvocation(draft);
  }
  claimUsage(invocation: UsageInvocation, kind: Claim): boolean {
    return this.#inner.claimUsage?.(invocation, kind) ?? false;
  }
  usageDisposition(draft: UsageDispositionDraft): void {
    this.#inner.usageDisposition?.(draft);
  }
  accountingFailure(error: unknown): void {
    this.#inner.accountingFailure?.(error);
  }
  emitCost(event: CostEvent): void {
    this.#inner.emitCost?.(event);
  }
  record(draft: SettledAttemptDraft): void {
    this.#inner.record(draft);
  }
  join(): Promise<void> {
    return this.#inner.join();
  }
}

function ownMoneyPort(inner: TurnMoneyPort, enumerable: boolean): TurnMoneyPort {
  const port = {
    entries: 0,
    enter() {
      expect(this).toBe(port);
      this.entries++;
    },
    beginUsageInvocation(draft: PendingUsageDraft) {
      this.enter();
      if (inner.beginUsageInvocation === undefined) throw new Error('missing pending capability');
      return inner.beginUsageInvocation(draft);
    },
    claimUsage(invocation: UsageInvocation, kind: Claim) {
      this.enter();
      return inner.claimUsage?.(invocation, kind) ?? false;
    },
    usageDisposition(draft: UsageDispositionDraft) {
      this.enter();
      inner.usageDisposition?.(draft);
    },
    accountingFailure(error: unknown) {
      this.enter();
      inner.accountingFailure?.(error);
    },
    emitCost(event: CostEvent) {
      this.enter();
      inner.emitCost?.(event);
    },
    record(draft: SettledAttemptDraft) {
      this.enter();
      inner.record(draft);
    },
    join() {
      this.enter();
      return inner.join();
    },
  };
  if (!enumerable)
    for (const name of [
      'beginUsageInvocation',
      'claimUsage',
      'usageDisposition',
      'accountingFailure',
      'emitCost',
    ])
      Object.defineProperty(port, name, { enumerable: false });
  return port;
}

const shapes = ['literal', 'private-class', 'own-receiver', 'non-enumerable'] as const;
type Shape = (typeof shapes)[number];
const cases = {
  missing: { kind: 'missing', reason: 'not_reported' },
  partial: { kind: 'partial', known: { outputTokens: 2 }, reason: 'missing_fields' },
  positive: { kind: 'complete', usage: { inputTokens: 3, outputTokens: 2 } },
  zero: { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } },
} satisfies Record<string, UsageEvidence>;

function fixture(
  shape: Shape,
  streaming: boolean,
  evidence: UsageEvidence,
  pendingFails = false,
  nativeRetry = false,
) {
  const fold = new UsageCoverageFold();
  fold.start('complete');
  const rows: SettledAttemptDraft[] = [];
  const dispositions: UsageDispositionDraft[] = [];
  const costEvents: CostEvent[] = [];
  const health: unknown[] = [];
  let pending = 0,
    invoked = 0,
    repaired = 0;
  const durability = new MoneyDurability({
    beginUsageInvocation: (draft) => {
      pending++;
      if (pendingFails) return Promise.reject(new Error('pending rejected'));
      const invocation = Object.freeze({
        producerId: 'money-port',
        ordinal: pending,
        dispatchId: 'turn',
        round: draft.round,
        chainAttempt: draft.chainAttempt,
      });
      fold.pending(draft.model, invocation);
      return Promise.resolve(invocation);
    },
    emitUsageDisposition: (draft) => {
      dispositions.push(draft);
      fold.disposition(draft.model, draft.invocation, draft.disposition, draft.receiptPending);
    },
    emit: (draft) => {
      rows.push(draft);
      if (draft.invocation !== undefined) fold.complete(draft.model, draft.invocation);
    },
  });
  const inner: TurnMoneyPort = {
    ...durability.turnPort(() => 0),
    accountingFailure: (error) => {
      health.push(error);
      durability.accountingFailure(error);
    },
    emitCost: (event) => {
      costEvents.push(event);
    },
  };
  const money =
    shape === 'literal'
      ? inner
      : shape === 'private-class'
        ? new PrivateMoneyPort(inner)
        : ownMoneyPort(inner, shape === 'own-receiver');
  async function repair(options?: LlmInvocationOptions) {
    if (!nativeRetry) return;
    await options?.beforeNativeRetry?.({
      ...makeLlmError({
        provider: 'openai',
        kind: 'bad_request',
        status: 400,
        message: 'parameter rejected',
      }),
      usage: evidence,
    });
    options?.nativeInvocationStarted?.();
    repaired++;
  }
  const provider: LlmProvider = {
    id: 'openai',
    supports: createOpenAiAdapter().supports,
    generate: async (_request, _key, options) => {
      invoked++;
      await repair(options);
      return { content: [{ type: 'text', text: 'reply' }], stopReason: 'stop', usage: evidence };
    },
    async *stream(_request, _key, options) {
      invoked++;
      await repair(options);
      yield { type: 'text_delta', text: 'reply' };
      yield { type: 'stop', stopReason: 'stop', usage: evidence };
    },
  };
  const params: AgentTurnParams = {
    nodeId: 'turn',
    messages: [],
    signal: new AbortController().signal,
    ...(streaming ? {} : { outputModalities: ['text', 'audio'] }),
    planEntries: [{ provider, model: 'gpt-4o', maxAttempts: 1 }],
    chainCapabilities: { keyFor: () => 'offline', sleep: () => Promise.resolve() },
    emit: () => undefined,
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unused tool')),
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
    money,
  };
  return {
    params,
    money,
    provider,
    durability,
    fold,
    rows,
    dispositions,
    costEvents,
    health,
    counts: () => ({ pending, invoked, repaired }),
  };
}

for (const shape of shapes) {
  for (const streaming of [false, true]) {
    it(`${shape}/${streaming}: pending refusal prevents provider entry`, async () => {
      const h = fixture(shape, streaming, cases.missing, true);
      const outcome = await captureAgentTurnOutcome(h.params);
      expect({
        kind: outcome.kind,
        ...h.counts(),
        rows: h.rows.length,
        dispositions: h.dispositions.length,
      }).toEqual({ kind: 'failed', pending: 1, invoked: 0, repaired: 0, rows: 0, dispositions: 0 });
    });
    for (const [name, evidence] of Object.entries(cases)) {
      it(`${shape}/${streaming}/${name}: the original port owns durable settlement exactly once`, async () => {
        const h = fixture(shape, streaming, evidence);
        const outcome = await captureAgentTurnOutcome(h.params);
        expect(outcome.kind).toBe('succeeded');
        const complete = evidence.kind === 'complete';
        expect(h.counts()).toEqual({ pending: 1, invoked: 1, repaired: 0 });
        expect(h.dispositions).toHaveLength(complete ? 0 : 1);
        expect(h.rows).toHaveLength(complete ? 1 : 0);
        if (complete) {
          expect(h.rows[0]?.costMicrocents).toEqual(name === 'zero' ? 0 : expect.any(Number));
          if (name === 'positive') expect(h.rows[0]?.costMicrocents).toBeGreaterThan(0);
          expect(h.rows[0]).toMatchObject({
            inputTokens: evidence.usage.inputTokens,
            outputTokens: evidence.usage.outputTokens,
            priced: true,
          });
        }
        expect(h.fold.snapshot().coverage).toEqual({
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: complete ? 0 : 1,
        });
        expect(h.fold.retainedInvocations).toBe(0);
      });
    }
    it(`${shape}/${streaming}: native predecessor cost uses its original optional receiver`, async () => {
      const h = fixture(shape, streaming, cases.positive, false, true);
      expect((await captureAgentTurnOutcome(h.params)).kind).toBe('succeeded');
      expect(h.counts()).toEqual({ pending: 2, invoked: 1, repaired: 1 });
      expect(h.costEvents).toHaveLength(1);
      expect(h.costEvents[0]).toMatchObject({ inputTokens: 3, outputTokens: 2, priced: true });
      expect(h.rows).toHaveLength(2);
      expect(h.fold.snapshot().coverage).toEqual({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 0,
      });
    });
    it(`${shape}/${streaming}: secondary accounting health reaches its original receiver`, async () => {
      const h = fixture(shape, streaming, cases.positive);
      const primary = new Error('actual admission failed');
      const secondary = new Error('conservative admission failed');
      let estimates = 0;
      const outcome = await captureAgentTurnOutcome({
        ...h.params,
        preEgress: () => ({
          settle: () => {
            throw primary;
          },
          release: () => {
            throw new Error('unexpected release');
          },
          settleAtReservedEstimate: () => {
            if (++estimates === 1) throw secondary;
          },
        }),
      });
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.error).toBe(primary);
        expect(outcome.failureOrigin).toBe('turn');
      }
      expect(h.health).toEqual([secondary]);
      expect(h.durability.durabilityBroken).toBe(true);
      expect(h.counts()).toEqual({ pending: 1, invoked: 1, repaired: 0 });
      expect(estimates).toBe(2);
    });
  }
  for (const entry of ['main', 'summary']) {
    for (const pendingFails of [false, true]) {
      it(`${shape}/${entry}/${pendingFails}: public sessions forward the same accounting protocol`, async () => {
        const h = fixture(shape, true, cases.missing, pendingFails);
        const session = AgentSession.resume(
          {
            sessionId: 'public-port',
            agentRef: 'a',
            agent: AgentSchema.parse({
              id: 'a',
              provider: 'openai',
              model: 'gpt-4o',
              system_prompt: 'offline',
              memory: { type: 'summary' },
            }),
            context: SessionContextSchema.parse({
              workingDir: '/offline',
              fsScopeTier: 'sandboxed',
            }),
            deps: {
              money: h.money,
              resolveProvider: () => h.provider,
              registry: h.params.registry,
              tools: [],
              keyFor: () => 'offline',
              sleep: () => Promise.resolve(),
              newAbortController: () => new AbortController(),
              emit: () => undefined,
              reserveEffectTurnKey: () => 1,
              autoCompact: false,
            },
          },
          {
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'old' }] },
              { role: 'user', content: [{ type: 'text', text: 'latest' }] },
            ],
            completedTurnSpans: [
              { start: 0, end: 1 },
              { start: 1, end: 2 },
            ],
            turnCount: 2,
            cumulativeCostMicrocents: 0,
            conservativeCostMicrocents: 0,
          },
        );
        if (entry === 'main') await session.sendMessage('next').catch(() => undefined);
        else expect((await session.compact()).kind).toBe(pendingFails ? 'failed' : 'compacted');
        expect(h.counts()).toEqual({ pending: 1, invoked: pendingFails ? 0 : 1, repaired: 0 });
        expect(h.dispositions).toHaveLength(pendingFails ? 0 : 1);
        expect(h.fold.snapshot().coverage).toEqual({
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: pendingFails ? 0 : 1,
        });
      });
    }
  }
}

class VolatileMoneyPort implements TurnMoneyPort {
  #rows = 0;
  #joins = 0;
  record(): void {
    this.#rows++;
  }
  join(): Promise<void> {
    this.#joins++;
    return Promise.resolve();
  }
  snapshot() {
    return { rows: this.#rows, joins: this.#joins };
  }
}
for (const streaming of [false, true]) {
  it(`${streaming}: absent optional capabilities retain volatile accounting`, async () => {
    const h = fixture('literal', streaming, cases.positive);
    const money = new VolatileMoneyPort();
    const outcome = await captureAgentTurnOutcome({ ...h.params, money });
    expect(outcome.kind).toBe('succeeded');
    expect(money.snapshot()).toEqual({ rows: 1, joins: 1 });
    expect(h.counts()).toEqual({ pending: 0, invoked: 1, repaired: 0 });
  });
}

for (const streaming of [false, true]) {
  for (const boundary of ['record', 'join']) {
    it(`${streaming}/${boundary}: class forwarding preserves the established failure origin`, async () => {
      const h = fixture('literal', streaming, cases.positive);
      const joinError = new LedgerDurabilityError(Object.freeze({ boundary }));
      const primary = boundary === 'join' ? joinError : Object.freeze({ boundary });
      class RequiredFaultPort implements TurnMoneyPort {
        readonly #primary = primary;
        readonly #joinError = joinError;
        record(): void {
          if (boundary === 'record') {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- The public callback may throw an opaque host value.
            throw this.#primary;
          }
        }
        join(): Promise<void> {
          return boundary === 'join' ? Promise.reject(this.#joinError) : Promise.resolve();
        }
      }
      const outcome = await captureAgentTurnOutcome({
        ...h.params,
        money: new RequiredFaultPort(),
      });
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.error).toBe(primary);
        expect(outcome.failureOrigin).toBe(boundary === 'record' ? 'observer' : 'turn');
      }
      expect(h.counts().invoked).toBe(boundary === 'record' ? 1 : 0);
    });
  }
}
