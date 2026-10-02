import { describe, expect, it } from 'vitest';
import type { CapabilityFlags, LlmProvider, PricingOverlay, StreamChunk } from '@relavium/llm';
import { unwiredEffectJournal, type DurableWriteContext, type RunEvent } from '@relavium/shared';
import { createAgentNodeExecutor } from './agent-runner.js';
import { DEFAULT_AGENT_TURN_LIMITS, runAgentTurn, type AgentTurnParams } from './agent-turn.js';
import { BudgetGovernor, CommitmentDurabilityError } from './budget-governor.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import {
  LedgerDurabilityError,
  MoneyDurability,
  type SettledAttemptDraft,
} from './money-durability.js';
import { parseWorkflow } from '../parser.js';

const MODEL = 'offline-money-freshness';
const PRICES: PricingOverlay = new Map([
  [
    MODEL,
    {
      provider: 'openai',
      nativeId: MODEL,
      displayName: MODEL,
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
    outputCombinations: [['image']],
  },
};
const REGISTRY: AgentTurnParams['registry'] = {
  has: () => false,
  list: () => [],
  dispatch: () => {
    throw new Error('unexpected tool dispatch');
  },
};

function deferred() {
  let resolve: () => void = () => {
    throw new Error('uninitialized deferred');
  };
  let reject: (error: Error) => void = () => {
    throw new Error('uninitialized deferred');
  };
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Only drain continuation jobs; owned promises determine the schedule, rather than wall-clock timing.
async function drainJobs(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
}

const draft = (nodeId: string): SettledAttemptDraft => ({
  nodeId,
  model: MODEL,
  attemptNumber: 1,
  inputTokens: 1,
  outputTokens: 0,
  costMicrocents: 1,
  priced: true,
});

type TurnOutcome = { kind: 'completed' } | { kind: 'refused'; error: unknown };

describe('money appended while the next attempt is waiting (ADR-0077)', () => {
  for (const mode of [
    'realized',
    'conservative',
    'realized-during-conservative',
    'conservative-during-realized',
  ] as const) {
    for (const budgeted of mode === 'realized' ? [false, true] : [true]) {
      for (const media of [false, true]) {
        for (const decision of ['resolve', 'reject', 'abort'] as const) {
          it(`${mode}, budgeted=${budgeted}, generate=${media}, ${decision}`, async () => {
            const first = deferred(),
              second = deferred();
            const firstEntered = deferred(),
              secondEntered = deferred();
            const controller = new AbortController();
            const calls = { admissions: 0, keys: 0, provider: 0, cleanup: 0 };
            let realizedCost = 0;
            const firstKind =
              mode === 'conservative' || mode === 'realized-during-conservative'
                ? 'conservative'
                : 'realized';
            const secondKind =
              mode === 'conservative' || mode === 'conservative-during-realized'
                ? 'conservative'
                : 'realized';
            const waitForWrite = (nodeId: string | undefined) => {
              if (nodeId === 'owner-1') {
                firstEntered.resolve();
                return first.promise;
              }
              if (nodeId === 'owner-2') {
                secondEntered.resolve();
                return second.promise;
              }
              return Promise.resolve();
            };
            const governor = new BudgetGovernor({
              budget: { max_cost_microcents: 10000, on_exceed: 'fail' },
              resolvePrice: PRICES,
              emit: (event) =>
                event.type === 'budget:estimate_committed'
                  ? waitForWrite(event.nodeId)
                  : Promise.resolve(),
            });
            const money = new MoneyDurability({
              emit: (record) => waitForWrite(record.nodeId),
              ...(budgeted ? { flushConservative: () => governor.flushCommitments() } : {}),
            });
            const record = (kind: 'realized' | 'conservative', nodeId: string) => {
              if (kind === 'realized') {
                realizedCost += 1;
                governor.updateCost(realizedCost);
                money.record(draft(nodeId), realizedCost);
              } else {
                const admission = governor.reserveAcceptedCost(MODEL, 2);
                if (admission === undefined) throw new Error('expected positive reservation');
                admission.settleAtReservedEstimate({ nodeId, attemptNumber: 1 });
              }
            };
            const provider: LlmProvider = {
              id: 'openai',
              customEndpoint: true,
              supports: SUPPORTS,
              generate: async () => {
                calls.provider += 1;
                await Promise.resolve();
                return {
                  content: [{ type: 'text', text: 'done' }],
                  stopReason: 'stop',
                  usage: { inputTokens: 1, outputTokens: 0 },
                };
              },
              stream: async function* (): AsyncGenerator<StreamChunk> {
                calls.provider += 1;
                try {
                  await Promise.resolve();
                  yield {
                    type: 'stop',
                    stopReason: 'stop',
                    usage: { inputTokens: 1, outputTokens: 0 },
                  };
                } finally {
                  calls.cleanup += 1;
                }
              },
            };
            const params: AgentTurnParams = {
              nodeId: 'candidate',
              messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
              planEntries: [{ provider, model: MODEL, maxAttempts: 1 }],
              chainCapabilities: {
                keyFor: () => {
                  calls.keys += 1;
                  return 'offline-synthetic';
                },
                sleep: () => Promise.resolve(),
              },
              signal: controller.signal,
              emit: (event) => {
                if (event.type === 'cost:updated') realizedCost += event.costMicrocents;
              },
              registry: REGISTRY,
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
              maxTokens: 7,
              resolvePrice: PRICES,
              // The conservative-only cases exercise the governor's own admission barrier directly.
              ...(mode === 'conservative' ? {} : { money: money.turnPort(() => realizedCost) }),
              ...(media ? { outputModalities: ['image'] } : {}),
              ...(budgeted
                ? {
                    preEgress: (info) => {
                      calls.admissions += 1;
                      return governor.checkPreEgress(info);
                    },
                  }
                : {}),
            };
            record(firstKind, 'owner-1');
            const active = runAgentTurn(params).then<TurnOutcome, TurnOutcome>(
              () => ({ kind: 'completed' }),
              (error: unknown) => ({ kind: 'refused', error }),
            );
            try {
              await firstEntered.promise;
              await drainJobs();
              expect(calls.keys).toBe(0);
              record(secondKind, 'owner-2');
              first.resolve();
              await secondEntered.promise;
              await drainJobs();
              expect.soft(calls.keys).toBe(0);
              expect.soft(calls.provider).toBe(0);
              expect.soft(calls.admissions).toBe(mode === 'conservative' ? 1 : 0);
              if (decision === 'abort') controller.abort();
              if (decision === 'reject')
                second.reject(new Error('synthetic owner-2 write failure'));
              else second.resolve();
              const result = await active;
              if (decision === 'resolve') {
                expect(result.kind).toBe('completed');
                expect(calls.keys).toBe(1);
                expect(calls.provider).toBe(1);
              } else {
                expect(result.kind).toBe('refused');
                if (result.kind !== 'refused') throw new Error('expected pre-egress refusal');
                if (decision === 'reject') {
                  expect(result.error).toBeInstanceOf(
                    secondKind === 'realized' ? LedgerDurabilityError : CommitmentDurabilityError,
                  );
                  expect(result.error).toHaveProperty('nodeId', 'owner-2');
                  expect(result.error).toHaveProperty(
                    'message',
                    secondKind === 'realized'
                      ? 'a realized-cost ledger write could not be made durable'
                      : 'a conservative budget commitment could not be made durable',
                  );
                } else expect(result.error).toHaveProperty('code', 'cancelled');
                expect(calls.keys).toBe(0);
                expect(calls.provider).toBe(0);
              }
              expect(calls.cleanup).toBe(media ? 0 : calls.provider);
              expect(governor.conservativeCostMicrocents).toBe(
                (firstKind === 'conservative' ? 2 : 0) + (secondKind === 'conservative' ? 2 : 0),
              );
              if (decision === 'reject') {
                expect(
                  secondKind === 'realized'
                    ? money.durabilityBroken
                    : governor.conservativeDurabilityBroken,
                ).toBe(true);
              }
              // One-shot failure reporting never refunds conservative money or clears the sticky flag.
              await money.join();
              await governor.flushCommitments();
            } finally {
              first.resolve();
              second.resolve();
              controller.abort();
              await active;
              await money.join().catch(() => undefined);
              await governor.flushCommitments().catch(() => undefined);
            }
          });
        }
      }
    }
  }

  for (const kind of ['realized', 'conservative'] as const) {
    it(`${kind}: a barrier follows a third write appended while awaiting the second`, async () => {
      const writes = [deferred(), deferred(), deferred()];
      const entered = [deferred(), deferred(), deferred()];
      const started: string[] = [];
      const emit = (nodeId: string | undefined) => {
        const index = Number(nodeId);
        started.push(String(nodeId));
        entered[index]?.resolve();
        return writes[index]?.promise ?? Promise.resolve();
      };
      const governor = new BudgetGovernor({
        budget: { max_cost_microcents: 10000, on_exceed: 'fail' },
        resolvePrice: PRICES,
        emit: (event) =>
          event.type === 'budget:estimate_committed' ? emit(event.nodeId) : Promise.resolve(),
      });
      const money = new MoneyDurability({ emit: (record) => emit(record.nodeId) });
      const record = (index: number) => {
        if (kind === 'realized') money.record(draft(String(index)), index + 1);
        else
          governor.reserveAcceptedCost(MODEL, 2)?.settleAtReservedEstimate({
            nodeId: String(index),
            attemptNumber: 1,
          });
      };
      record(0);
      let finished = false;
      const active = (kind === 'realized' ? money.join() : governor.flushCommitments()).then(() => {
        finished = true;
      });
      try {
        await entered[0]?.promise;
        record(1);
        writes[0]?.resolve();
        await entered[1]?.promise;
        await drainJobs();
        expect.soft(finished).toBe(false);
        record(2);
        writes[1]?.resolve();
        await entered[2]?.promise;
        await drainJobs();
        expect.soft(finished).toBe(false);
        writes[2]?.resolve();
        await active;
        expect(started).toEqual(['0', '1', '2']);
        expect(finished).toBe(true);
      } finally {
        for (const write of writes) write.resolve();
        await active;
      }
    });
  }
});

describe('actual sibling AgentRunner writes before candidate WorkflowEngine egress', () => {
  for (const budgeted of [false, true]) {
    for (const decision of ['resolve', 'reject'] as const) {
      it(`budgeted=${budgeted}, second persistence ${decision}s`, async () => {
        const first = deferred(),
          second = deferred();
        const firstEntered = deferred(),
          secondEntered = deferred();
        const outputFirst = deferred(),
          outputSecond = deferred();
        const candidateEntered = deferred(),
          startCandidate = deferred(),
          secondRecorded = deferred();
        const order: string[] = [];
        const keys: Record<string, number> = {},
          providers: Record<string, number> = {};
        class Store extends InMemoryRunStore {
          override async persistEvent(
            event: RunEvent,
            context?: DurableWriteContext,
          ): Promise<void> {
            if (event.type === 'cost:attempt_settled' && event.nodeId === 'owner-1') {
              firstEntered.resolve();
              await first.promise;
            }
            if (event.type === 'cost:attempt_settled' && event.nodeId === 'owner-2') {
              secondEntered.resolve();
              await second.promise;
            }
            await super.persistEvent(event, context);
          }
        }
        const provider: LlmProvider = {
          id: 'openai',
          customEndpoint: true,
          supports: SUPPORTS,
          generate: () => {
            throw new Error('unexpected inline generation');
          },
          stream: async function* (request): AsyncGenerator<StreamChunk> {
            const part = request.messages[0]?.content[0];
            if (part?.type !== 'text') throw new Error('missing synthetic prompt');
            const id = part.text;
            providers[id] = (providers[id] ?? 0) + 1;
            order.push(`provider:${id}`);
            if (id === 'owner-1') await outputFirst.promise;
            else if (id === 'owner-2') await outputSecond.promise;
            else await Promise.resolve();
            yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
          },
        };
        const engine = new WorkflowEngine({
          host: createInMemoryHost({ store: new Store() }),
          resolvePrice: PRICES,
          executor: {
            execute: async (context) => {
              const id = context.vertex.id;
              if (id === 'candidate') {
                candidateEntered.resolve();
                await startCandidate.promise;
              }
              const runner = createAgentNodeExecutor({
                resolveProvider: () => provider,
                keyFor: () => {
                  keys[id] = (keys[id] ?? 0) + 1;
                  order.push(`key:${id}`);
                  return 'offline-synthetic';
                },
                sleep: () => Promise.resolve(),
                registry: REGISTRY,
                tools: [],
                resolvePrice: PRICES,
              });
              const port = context.money;
              return runner.execute({
                ...context,
                ...(port === undefined
                  ? {}
                  : {
                      money: {
                        join: () => port.join(),
                        // Observation only: the real runner creates every cost row, through the actual engine port.
                        record: (record: SettledAttemptDraft) => {
                          port.record(record);
                          order.push(`record:${record.nodeId}`);
                          if (record.nodeId === 'owner-2') secondRecorded.resolve();
                        },
                      },
                    }),
              });
            },
          },
        });
        const workflow = parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'offline-money-freshness',
              ...(budgeted ? { budget: { max_cost_microcents: 10000, on_exceed: 'fail' } } : {}),
              agents: [
                { id: 'offline-agent', provider: 'openai', model: MODEL, system_prompt: 's' },
              ],
              nodes: ['owner-1', 'owner-2', 'candidate'].map((id) => ({
                id,
                type: 'agent',
                agent_ref: 'offline-agent',
                prompt_template: id,
                max_tokens: 7,
              })),
              edges: [],
            },
          }),
        );
        const events: RunEvent[] = [];
        const handle = engine.start({ workflow });
        const consuming = (async () => {
          for await (const event of handle.events) events.push(event);
        })();
        try {
          await candidateEntered.promise;
          await drainJobs();
          expect(providers['owner-1']).toBe(1);
          expect(providers['owner-2']).toBe(1);
          outputFirst.resolve();
          await firstEntered.promise;
          startCandidate.resolve();
          await drainJobs();
          expect(providers['candidate'] ?? 0).toBe(0);
          outputSecond.resolve();
          await secondRecorded.promise;
          first.resolve();
          await secondEntered.promise;
          await drainJobs();
          expect.soft(keys['candidate'] ?? 0, JSON.stringify(order)).toBe(0);
          expect.soft(providers['candidate'] ?? 0, JSON.stringify(order)).toBe(0);
          if (decision === 'resolve') second.resolve();
          else second.reject(new Error('synthetic owner persistence failure'));
          await consuming;
          if (decision === 'resolve') {
            expect(events.at(-1)).toHaveProperty('type', 'run:completed');
            expect(providers['candidate']).toBe(1);
            expect(events.filter((event) => event.type === 'cost:attempt_settled')).toHaveLength(3);
          } else {
            expect(events.at(-1)).toMatchObject({
              type: 'run:failed',
              error: { code: 'internal', nodeId: 'owner-2' },
            });
            expect(providers['candidate'] ?? 0).toBe(0);
          }
        } finally {
          outputFirst.resolve();
          outputSecond.resolve();
          startCandidate.resolve();
          first.resolve();
          second.resolve();
          await consuming;
        }
      });
    }
  }
});
