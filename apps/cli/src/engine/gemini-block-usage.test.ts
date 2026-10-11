import {
  createAgentNodeExecutor,
  createInMemoryHost,
  parseWorkflow,
  WorkflowEngine,
} from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runCosts,
  runMigrations,
} from '@relavium/db';
import type { ModelPricing } from '@relavium/llm';
import { geminiAdapter } from '@relavium/llm/adapters';
import type { RunEvent } from '@relavium/shared';
import { eq, sum } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readRunUsageCoverage } from '../history/usage-coverage.js';
import { createHistoryCheckpointer } from './checkpointer.js';

const model = 'gemini-2.5-flash';
const timestamp = '2026-10-11T00:00:00.000Z';
const completeUsage = {
  promptTokenCount: 4,
  cachedContentTokenCount: 0,
  candidatesTokenCount: 0,
  thoughtsTokenCount: 0,
};
const cases = [
  { name: 'explicit zero', usage: { ...completeUsage, promptTokenCount: 0 }, inputTokens: 0 },
  { name: 'positive input', usage: completeUsage, inputTokens: 4 },
  { name: 'missing', usage: undefined, inputTokens: undefined },
  {
    name: 'partial thinking',
    usage: { promptTokenCount: 4, cachedContentTokenCount: 0, candidatesTokenCount: 0 },
    inputTokens: undefined,
  },
] as const;

afterEach(() => vi.unstubAllGlobals());

describe('Gemini prompt block through WorkflowEngine, AgentRunner and native SQLite', () => {
  for (const capped of [false, true]) {
    for (const control of cases) {
      it(`${capped ? 'capped' : 'uncapped'} ${control.name}: accounts once without retrying the content filter`, async () => {
        const complete = control.inputTokens !== undefined;
        const expectedCost = control.inputTokens ?? 0;
        const expectedCoverage = {
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: complete ? 0 : 1,
        };
        const client = createClient(':memory:');
        try {
          runMigrations(client.db);
          const workflow = parseWorkflow(
            JSON.stringify({
              schema_version: '1.0',
              workflow: {
                id: 'gemini-block-usage',
                ...(capped ? { budget: { max_cost_microcents: 100000, on_exceed: 'fail' } } : {}),
                agents: [
                  { id: 'worker', provider: 'gemini', model, system_prompt: 'Offline control.' },
                ],
                nodes: [
                  {
                    id: 'blocked',
                    type: 'agent',
                    agent_ref: 'worker',
                    prompt_template: 'Offline prompt block.',
                    max_tokens: 16,
                  },
                ],
                edges: [],
              },
            }),
          );
          let sequence = 0;
          const store = createRunHistoryStore(client.db, {
            uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
            now: () => Date.parse(timestamp),
            workflow: {
              slug: workflow.workflow.id,
              name: workflow.workflow.id,
              definitionJson: JSON.stringify(workflow),
            },
          });
          const host = createInMemoryHost({ store, runLeases: createRunLeasePort(store) });
          const price: ModelPricing = {
            provider: 'gemini',
            nativeId: model,
            displayName: model,
            contextWindowTokens: 100000,
            maxOutputTokens: 1000,
            inputPerMtokMicrocents: 1000000,
            outputPerMtokMicrocents: 2000000,
            cachedInputPerMtokMicrocents: 0,
          };
          const resolvePrice = new Map([[model, price]]);
          // The shipping default adapter uses the installed SDK; only HTTP is intercepted.
          const fetch = vi.fn(() => {
            const beforeEgress = store.loadRunEventLogForReplay(handle.runId);
            expect(
              beforeEgress.filter((event) => event.type === 'cost:usage_pending'),
            ).toHaveLength(1);
            return Promise.resolve(
              new Response(
                `data: ${JSON.stringify({
                  promptFeedback: { blockReason: 'SAFETY' },
                  ...(control.usage === undefined ? {} : { usageMetadata: control.usage }),
                })}\n\n`,
                { headers: { 'content-type': 'text/event-stream' } },
              ),
            );
          });
          vi.stubGlobal('fetch', fetch);
          const executor = createAgentNodeExecutor({
            resolveProvider: () => geminiAdapter,
            resolvePrice,
            registry: {
              has: () => false,
              list: () => [],
              dispatch: () => Promise.reject(new Error('unexpected tool dispatch')),
            },
            tools: [],
            keyFor: () => 'offline-fixture',
            sleep: () => Promise.resolve(),
            newAbortController: host.newAbortController,
            setTimer: host.setTimer,
          });
          const engine = new WorkflowEngine({ host, executor, resolvePrice });
          const handle = engine.start({ workflow });
          const events: RunEvent[] = [];
          for await (const event of handle.events) events.push(event);
          expect(await handle.depart()).toMatchObject({
            kind: 'closed',
            moneyDurability: 'durable',
          });
          expect(fetch).toHaveBeenCalledTimes(1);
          // Text prompt blocks retain the existing successful, empty-output workflow outcome.
          expect(events.at(-1)).toMatchObject({
            type: 'run:completed',
            totalCostMicrocents: expectedCost,
          });
          const durable = store.loadRunEventLogForReplay(handle.runId);
          expect(durable.filter((event) => event.type === 'node:started')).toHaveLength(1);
          expect(durable.filter((event) => event.type === 'node:completed')).toMatchObject([
            { output: '' },
          ]);
          expect(durable.filter((event) => event.type === 'node:failed')).toEqual([]);
          const pending = durable.filter((event) => event.type === 'cost:usage_pending');
          expect(pending).toHaveLength(1);
          const settled = durable.filter((event) => event.type === 'cost:attempt_settled');
          const dispositions = durable.filter((event) => event.type === 'cost:usage_disposition');
          const actual = events.filter((event) => event.type === 'cost:updated');
          expect(settled).toHaveLength(complete ? 1 : 0);
          expect(actual).toHaveLength(complete ? 1 : 0);
          if (complete) {
            expect(settled[0]).toMatchObject({
              invocation: pending[0]?.invocation,
              inputTokens: control.inputTokens,
              outputTokens: 0,
              costMicrocents: expectedCost,
              priced: true,
            });
            expect(actual[0]).toMatchObject({
              inputTokens: control.inputTokens,
              outputTokens: 0,
              costMicrocents: expectedCost,
            });
            expect(dispositions).toEqual([]);
          } else {
            expect(dispositions).toHaveLength(1);
            expect(dispositions[0]).toMatchObject({ invocation: pending[0]?.invocation });
          }
          const estimates = durable.filter((event) => event.type === 'budget:estimate_committed');
          expect(estimates).toHaveLength(capped && !complete ? 1 : 0);
          const conservative = estimates.reduce(
            (total, event) => total + event.estimateMicrocents,
            0,
          );
          if (capped && !complete) expect(conservative).toBeGreaterThan(0);
          else expect(conservative).toBe(0);
          const rows = client.db
            .select()
            .from(runCosts)
            .where(eq(runCosts.runId, handle.runId))
            .all();
          // The established terminal row telescopes to zero after the sole actual attempt row.
          expect(rows).toHaveLength(complete ? 2 : 1);
          if (complete) {
            expect(rows[0]).toMatchObject({
              inputTokens: control.inputTokens,
              outputTokens: 0,
              costMicrocents: expectedCost,
            });
          }
          expect(rows.at(-1)).toMatchObject({
            inputTokens: control.inputTokens ?? 0,
            outputTokens: 0,
            costMicrocents: 0,
          });
          const aggregate = client.db
            .select({ total: sum(runCosts.costMicrocents).mapWith(Number) })
            .from(runCosts)
            .where(eq(runCosts.runId, handle.runId))
            .get();
          expect(aggregate?.total ?? 0).toBe(expectedCost);
          expect(store.loadRun(handle.runId)).toMatchObject({ totalCostMicrocents: expectedCost });
          const usage = readRunUsageCoverage(store, handle.runId);
          expect(usage).toMatchObject({
            totalCostMicrocents: expectedCost,
            unpricedCalls: 0,
            usageCoverage: expectedCoverage,
          });
          expect(usage.nodes.get('blocked')).toEqual(expectedCoverage);
          expect(await createHistoryCheckpointer(store).load(handle.runId)).toMatchObject({
            cumulativeCostMicrocents: expectedCost,
            conservativeCostMicrocents: conservative,
            usageCoverage: { coverage: expectedCoverage },
          });
        } finally {
          client.sqlite.close();
        }
      });
    }
  }
});
