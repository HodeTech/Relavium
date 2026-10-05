import { describe, expect, it } from 'vitest';
import { unwiredEffectJournal } from '@relavium/shared';
import type { LlmProvider, StreamChunk, ModelPricing } from '@relavium/llm';
import { createAbortController } from './execution-host.js';
import { MoneyDurability } from './money-durability.js';
import { BudgetGovernor } from './budget-governor.js';
import { runAgentTurn, DEFAULT_AGENT_TURN_LIMITS, type AgentTurnParams } from './agent-turn.js';
const model = 'r11-fresh-b1';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 1000,
  maxOutputTokens: 20,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 0,
};
function gate() {
  let resolve: () => void = () => undefined,
    reject: (e: Error) => void = () => undefined;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
describe('R11 fresh joined real MoneyDurability and current governor pre-egress', () => {
  for (const budgeted of [false, true])
    for (const choice of ['ack', 'fail', 'abort'] as const)
      it(`budget=${budgeted}, older realized and newly queued conservative write: ${choice}`, async () => {
        const realized = gate(),
          cons = gate(),
          entered = gate(),
          consEntered = gate(),
          controller = createAbortController();
        let keys = 0,
          calls = 0,
          admissions = 0,
          cost = 1;
        const prices = new Map([[model, price]]);
        const governor = new BudgetGovernor({
          budget: { max_cost_microcents: 10000, on_exceed: 'fail' },
          resolvePrice: prices,
          emit: (e) => {
            if (e.type === 'budget:estimate_committed') {
              consEntered.resolve();
              return cons.promise;
            }
            return Promise.resolve();
          },
        });
        const money = new MoneyDurability({
          emit: (e) => {
            if (e.nodeId === 'older-realized') {
              entered.resolve();
              return realized.promise;
            }
            return Promise.resolve();
          },
          ...(budgeted ? { flushConservative: () => governor.flushCommitments() } : {}),
        });
        money.record(
          {
            nodeId: 'older-realized',
            model,
            attemptNumber: 1,
            inputTokens: 1,
            outputTokens: 0,
            costMicrocents: 1,
            priced: true,
          },
          1,
        );
        const p: LlmProvider = {
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
              outputCombinations: [['text']],
            },
          },
          generate: () => Promise.reject(new Error('stream control only')),
          stream: async function* (): AsyncGenerator<StreamChunk> {
            await Promise.resolve();
            calls++;
            yield { type: 'text_delta', text: 'r11' };
            yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 } };
          },
        };
        const params: AgentTurnParams = {
          nodeId: 'candidate',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'offline' }] }],
          planEntries: [{ provider: p, model, maxAttempts: 1 }],
          chainCapabilities: {
            keyFor: () => {
              keys++;
              return 'offline-synthetic';
            },
            sleep: () => Promise.resolve(),
          },
          signal: controller.signal,
          emit: (e) => {
            if (e.type === 'cost:updated') cost += e.costMicrocents;
          },
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => Promise.reject(new Error('unexpected tool')),
          },
          dispatchContext: {
            nodeId: 'candidate',
            grantedToolIds: new Set(),
            config: {},
            toolPolicy: {},
            fsScope: 'sandboxed',
            gateApproved: false,
            effects: unwiredEffectJournal(),
            effectSlot: 0,
          },
          limits: DEFAULT_AGENT_TURN_LIMITS,
          maxTokens: 8,
          resolvePrice: prices,
          money: money.turnPort(() => cost),
          ...(budgeted
            ? {
                preEgress: (info) => {
                  admissions++;
                  return governor.checkPreEgress(info);
                },
              }
            : {}),
        };
        const running = runAgentTurn(params).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await entered.promise;
        for (let i = 0; i < 30; i++) await Promise.resolve();
        expect(keys).toBe(0);
        expect(calls).toBe(0);
        expect(admissions).toBe(0);
        if (budgeted) {
          const lease = governor.reserveAcceptedCost(model, 2);
          if (lease === undefined) throw new Error('expected bounded lease');
          lease.settleAtReservedEstimate({ nodeId: 'newer-conservative', attemptNumber: 1 });
          await consEntered.promise;
        }
        if (budgeted) {
          realized.resolve();
          for (let i = 0; i < 30; i++) await Promise.resolve();
          expect(keys).toBe(0);
          expect(calls).toBe(0);
          expect(admissions).toBe(0);
          if (choice === 'abort') controller.abort();
          if (choice === 'fail') cons.reject(new Error('PRIVATE real conservative writer'));
          else cons.resolve();
        } else {
          if (choice === 'abort') controller.abort();
          if (choice === 'fail') realized.reject(new Error('PRIVATE real realized writer'));
          else realized.resolve();
        }
        const result = await running;
        if (choice !== 'ack') {
          expect(result.ok).toBe(false);
          expect(keys).toBe(0);
          expect(calls).toBe(0);
        } else {
          expect(result.ok).toBe(true);
          expect(keys).toBe(1);
          expect(calls).toBe(1);
          expect(admissions).toBe(budgeted ? 1 : 0);
        }
      });
});
