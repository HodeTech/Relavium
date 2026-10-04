import { describe, expect, it } from 'vitest';
import { prepareOutputCapPlan } from '@relavium/llm';
import type { CapabilityFlags, LlmProvider, PricingOverlay, StreamChunk } from '@relavium/llm';
import { unwiredEffectJournal } from '@relavium/shared';
import { DEFAULT_AGENT_TURN_LIMITS, runAgentTurn, type AgentTurnParams } from './agent-turn.js';
import { BudgetGovernor } from './budget-governor.js';
import { LedgerDurabilityError, MoneyDurability } from './money-durability.js';

const MODEL = 'offline-money-admission';
const PRICES: PricingOverlay = new Map([
  [
    MODEL,
    {
      provider: 'openai',
      nativeId: MODEL,
      displayName: 'Offline ledger boundary',
      contextWindowTokens: 10000,
      maxOutputTokens: 1000,
      inputPerMtokMicrocents: 1000000,
      outputPerMtokMicrocents: 1000000,
      cachedInputPerMtokMicrocents: 0,
    },
  ],
]);
const SUPPORTS: CapabilityFlags = {
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
};
type TurnOutcome =
  | { kind: 'completed'; result: Awaited<ReturnType<typeof runAgentTurn>> }
  | { kind: 'refused'; error: unknown };

describe('B1 joins the shared ledger before the next provider admission (ADR-0077)', () => {
  for (const budgeted of [false, true]) {
    for (const decision of ['resolve', 'reject', 'abort'] as const) {
      it(`budgeted=${budgeted}: a pending sibling write ${decision}s before admission, credentials and egress`, async () => {
        let resolveWrite: () => void = () => {
          throw new Error('pending write not initialized');
        };
        let rejectWrite: (error: Error) => void = () => {
          throw new Error('pending write not initialized');
        };
        const write = new Promise<void>((resolve, reject) => {
          resolveWrite = resolve;
          rejectWrite = reject;
        });
        const controller = new AbortController();
        const calls = { admissions: 0, credentials: 0, provider: 0 };
        const governor = new BudgetGovernor({
          budget: { max_cost_microcents: 1000, on_exceed: 'fail' },
          resolvePrice: PRICES,
          emit: () => Promise.resolve(),
        });
        governor.updateCost(1);
        const money = new MoneyDurability({
          emit: (draft) => (draft.nodeId === 'earlier-sibling' ? write : undefined),
          ...(budgeted ? { flushConservative: () => governor.flushCommitments() } : {}),
        });
        money.record(
          {
            nodeId: 'earlier-sibling',
            model: MODEL,
            attemptNumber: 1,
            inputTokens: 1,
            outputTokens: 0,
            costMicrocents: 1,
            priced: true,
          },
          1,
        );
        const provider: LlmProvider = {
          id: 'openai',
          customEndpoint: true,
          supports: SUPPORTS,
          generate: () => {
            throw new Error('unexpected non-streaming call');
          },
          stream: async function* (): AsyncGenerator<StreamChunk> {
            calls.provider += 1;
            await Promise.resolve();
            yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 0 } };
          },
        };
        const params: AgentTurnParams = {
          nodeId: 'next-node',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          planEntries: [{ provider, model: MODEL, maxAttempts: 1 }],
          chainCapabilities: {
            keyFor: () => {
              calls.credentials += 1;
              return 'offline-synthetic-credential';
            },
            sleep: () => Promise.resolve(),
          },
          signal: controller.signal,
          emit: () => undefined,
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => {
              throw new Error('unexpected tool dispatch');
            },
          },
          dispatchContext: {
            nodeId: 'next-node',
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
          resolvePrice: PRICES,
          money: money.turnPort(() => 2),
          ...(budgeted
            ? {
                preEgress: (info) => {
                  calls.admissions += 1;
                  return governor.checkPreEgress(info);
                },
              }
            : {}),
        };
        // Attach rejection handling before releasing or failing the actual shared writer.
        const active = runAgentTurn(params).then<TurnOutcome, TurnOutcome>(
          (result) => ({ kind: 'completed', result }),
          (error: unknown) => ({ kind: 'refused', error }),
        );
        try {
          // Drain queued continuation jobs; no real time, transport or synthetic money-port replacement.
          for (let i = 0; i < 20; i += 1) await Promise.resolve();
          expect(calls).toEqual({ admissions: 0, credentials: 0, provider: 0 });
          if (decision === 'abort') controller.abort();
          if (decision === 'reject') rejectWrite(new Error('synthetic sibling write failure'));
          else resolveWrite();
          const outcome = await active;
          if (decision === 'resolve') {
            expect(outcome.kind).toBe('completed');
            expect(calls).toEqual({ admissions: budgeted ? 1 : 0, credentials: 1, provider: 1 });
          } else {
            expect(outcome.kind).toBe('refused');
            if (outcome.kind !== 'refused') throw new Error('expected refusal before egress');
            if (decision === 'reject') {
              expect(outcome.error).toBeInstanceOf(LedgerDurabilityError);
              expect(outcome.error).toHaveProperty('nodeId', 'earlier-sibling');
            } else expect(outcome.error).toHaveProperty('code', 'cancelled');
            expect(calls).toEqual({ admissions: 0, credentials: 0, provider: 0 });
          }
        } finally {
          // A failed assertion must not strand the real writer or leave an unobserved turn rejection.
          resolveWrite();
          await active;
          await money.join().catch(() => undefined);
        }
      });
    }
  }
});

describe('realized recording survives a post-aggregation cost notification fault (ADR-0076/0077)', () => {
  for (const fault of [
    'notification',
    'ledger',
    'snapshot',
    'notification_and_ledger',
    'notification_and_snapshot',
  ] as const) {
    it(fault, async () => {
      const notification = new Error('private notification error');
      const storage = new Error('private storage error');
      let cumulative = 0;
      const rows: { cost: number; cumulative: number; attempt: number }[] = [];
      const governor = new BudgetGovernor({
        budget: { max_cost_microcents: 20, on_exceed: 'fail' },
        resolvePrice: PRICES,
        defaultMaxTokensEstimate: 10,
        emit: () => Promise.resolve(),
      });
      const money = new MoneyDurability({
        emit: (draft, total) => {
          if (fault === 'ledger' || fault === 'notification_and_ledger') throw storage;
          rows.push({
            cost: draft.costMicrocents,
            cumulative: total,
            attempt: draft.attemptNumber,
          });
        },
        flushConservative: () => governor.flushCommitments(),
      });
      const provider: LlmProvider = {
        id: 'openai',
        customEndpoint: true,
        supports: SUPPORTS,
        generate: () => {
          throw new Error('unused');
        },
        stream: async function* (): AsyncGenerator<StreamChunk> {
          await Promise.resolve();
          yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 7, outputTokens: 10 } };
        },
      };
      const params: AgentTurnParams = {
        nodeId: 'paid-node',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        planEntries: [{ provider, model: MODEL, maxAttempts: 1 }],
        chainCapabilities: {
          keyFor: () => 'synthetic-offline-key',
          sleep: () => Promise.resolve(),
        },
        signal: new AbortController().signal,
        maxTokens: 10,
        maxTokensEstimate: 10,
        resolvePrice: PRICES,
        emit: (event) => {
          if (event.type !== 'cost:updated') return;
          cumulative += event.costMicrocents;
          governor.updateCost(cumulative);
          if (fault.startsWith('notification')) throw notification;
        },
        registry: {
          has: () => false,
          list: () => [],
          dispatch: () => {
            throw new Error('unused');
          },
        },
        dispatchContext: {
          nodeId: 'paid-node',
          grantedToolIds: new Set(),
          config: {},
          toolPolicy: {},
          fsScope: 'sandboxed',
          gateApproved: false,
          effects: unwiredEffectJournal(),
          effectSlot: 0,
        },
        limits: DEFAULT_AGENT_TURN_LIMITS,
        preEgress: (info) => governor.checkPreEgress(info),
        money: money.turnPort(() => {
          if (fault === 'snapshot' || fault === 'notification_and_snapshot') throw storage;
          return cumulative;
        }),
      };
      if (fault.includes('snapshot')) await expect(runAgentTurn(params)).rejects.toBe(storage);
      else if (fault.startsWith('notification'))
        await expect(runAgentTurn(params)).rejects.toBe(notification);
      else
        await expect(runAgentTurn(params)).resolves.toHaveProperty('usage', {
          input: 7,
          output: 10,
        });
      expect(cumulative).toBe(17);
      // A fault does not release a settled charge or make room for a second11-unit reservation.
      const plan = prepareOutputCapPlan({
        model: MODEL,
        provider: 'openai',
        endpoint: 'custom',
        maxTokens: 10,
        providerOptions: undefined,
      });
      await expect(
        governor.checkPreEgress({
          route: 'text',
          model: MODEL,
          maxTokens: 10,
          maxTokensEstimate: 10,
          provider: 'openai',
          endpoint: 'custom',
          providerOptions: undefined,
          outputCapPlan: plan,
          inputTokensEstimate: 1,
        }),
      ).rejects.toMatchObject({ code: 'budget_exceeded', spentMicrocents: 17 });
      if (fault.includes('ledger')) {
        try {
          await money.join();
          throw new Error('ledger fault was not surfaced');
        } catch (error) {
          expect(error).toBeInstanceOf(LedgerDurabilityError);
          expect(error).toHaveProperty('nodeId', 'paid-node');
          expect(error).toHaveProperty('cause', storage);
        }
        expect(money.durabilityBroken).toBe(true);
      } else await money.join();
      expect(rows).toEqual(
        fault === 'notification' ? [{ cost: 17, cumulative: 17, attempt: 1 }] : [],
      );
    });
  }
});
