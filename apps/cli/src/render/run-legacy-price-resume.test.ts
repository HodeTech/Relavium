import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentNodeExecutor,
  createDispatchingNodeExecutor,
  createHumanGateNodeExecutor,
  createOutputNodeExecutor,
  parseWorkflow,
  WorkflowEngine,
  type RunHandle,
} from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import type { LlmProvider, ModelPricing } from '@relavium/llm';
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createHistoryCheckpointer } from '../engine/checkpointer.js';
import { createCliHost } from '../engine/host.js';
import { readRunUsageCoverage } from '../history/usage-coverage.js';
import { createRunStore } from './tui/run-store.js';

type FirstCall = 'unpriced-zero' | 'unpriced' | 'priced-zero' | 'priced-positive';
type SecondCall = 'unpriced' | 'priced-zero';

const cases: readonly {
  readonly name: string;
  readonly first: FirstCall;
  readonly second?: SecondCall;
  readonly expectedUnpriced: number;
}[] = [
  {
    name: 'explicit zero quantities with missing price',
    first: 'unpriced-zero',
    expectedUnpriced: 1,
  },
  { name: 'nonzero quantities with missing price', first: 'unpriced', expectedUnpriced: 1 },
  { name: 'genuinely priced zero', first: 'priced-zero', expectedUnpriced: 0 },
  {
    name: 'old and new unpriced calls',
    first: 'unpriced',
    second: 'unpriced',
    expectedUnpriced: 2,
  },
  {
    name: 'old unpriced then new priced zero',
    first: 'unpriced',
    second: 'priced-zero',
    expectedUnpriced: 1,
  },
  {
    name: 'old priced zero then new unpriced',
    first: 'priced-zero',
    second: 'unpriced',
    expectedUnpriced: 1,
  },
  {
    name: 'retained positive money',
    first: 'priced-positive',
    second: 'priced-zero',
    expectedUnpriced: 0,
  },
];

async function drainToPause(handle: RunHandle) {
  const events: RunEvent[] = [];
  let resolvePaused: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    resolvePaused = resolve;
  });
  const draining = (async () => {
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'run:paused') resolvePaused();
    }
  })();
  await Promise.race([
    paused,
    draining.then(() => {
      throw new Error('fixture run ended before its ordinary gate');
    }),
  ]);
  return { events, draining };
}

function price(model: string): ModelPricing {
  return {
    provider: 'openai',
    nativeId: model,
    displayName: model,
    contextWindowTokens: 10000,
    maxOutputTokens: 1000,
    inputPerMtokMicrocents: 100000000,
    outputPerMtokMicrocents: 0,
    cachedInputPerMtokMicrocents: 0,
  };
}

describe('legacy missing-price evidence across SQLite workflow resume', () => {
  it.each(cases)('$name survives new calls, live output and a second reopen', async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'relavium-legacy-price-resume-'));
    const dbPath = join(root, 'history.db');
    let client: DbClient | undefined;
    let active: RunHandle | undefined;
    let draining: Promise<void> | undefined;
    const firstUnpriced = scenario.first.startsWith('unpriced') ? 1 : 0;
    const expectedCost = scenario.first === 'priced-positive' ? 1000 : 0;
    const workflow = parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'legacy-price-resume',
          agents: [
            {
              id: 'before',
              provider: 'openai',
              model: `first-${scenario.first}`,
              system_prompt: 'offline',
            },
            {
              id: 'after',
              provider: 'openai',
              model: `second-${scenario.second ?? 'priced-zero'}`,
              system_prompt: 'offline',
            },
          ],
          nodes: [
            { id: 'before', type: 'agent', agent_ref: 'before', prompt_template: 'before' },
            {
              id: 'gate-1',
              type: 'human_gate',
              gate_type: 'approval',
              message_template: 'first gate',
            },
            ...(scenario.second === undefined
              ? []
              : [{ id: 'after', type: 'agent', agent_ref: 'after', prompt_template: 'after' }]),
            {
              id: 'gate-2',
              type: 'human_gate',
              gate_type: 'approval',
              message_template: 'second gate',
            },
            { id: 'out', type: 'output' },
          ],
          edges: [
            { from: 'before', to: 'gate-1' },
            ...(scenario.second === undefined
              ? [{ from: 'gate-1', to: 'gate-2' }]
              : [
                  { from: 'gate-1', to: 'after' },
                  { from: 'after', to: 'gate-2' },
                ]),
            { from: 'gate-2', to: 'out' },
          ],
        },
      }),
    );
    let calls = 0;
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
          outputCombinations: [['text']],
        },
      },
      generate: () => Promise.reject(new Error('fixture requires streaming')),
      async *stream(request) {
        await Promise.resolve();
        calls += 1;
        const positive =
          request.model === 'first-unpriced' ||
          request.model === 'first-priced-positive' ||
          request.model === 'second-unpriced';
        yield { type: 'text_delta', text: 'offline' };
        yield {
          type: 'stop',
          stopReason: 'stop',
          usage: {
            kind: 'complete',
            usage: { inputTokens: positive ? 10 : 0, outputTokens: positive ? 3 : 0 },
          },
        };
      },
    };
    const resolvePrice = new Map([
      ['first-priced-zero', price('first-priced-zero')],
      ['first-priced-positive', price('first-priced-positive')],
      ['second-priced-zero', price('second-priced-zero')],
    ]);
    const executor = createDispatchingNodeExecutor({
      agent: createAgentNodeExecutor({
        resolveProvider: () => provider,
        resolvePrice,
        keyFor: () => 'offline-fixture',
        sleep: () => Promise.resolve(),
        tools: [],
        registry: {
          has: () => false,
          list: () => [],
          dispatch: () => Promise.reject(new Error('fixture has no tools')),
        },
      }),
      human_in_the_loop: createHumanGateNodeExecutor(),
      output: createOutputNodeExecutor(),
    });
    const firstHost = createCliHost();
    try {
      active = new WorkflowEngine({ host: firstHost, executor, resolvePrice }).start({ workflow });
      const runId = active.runId;
      const initial = await drainToPause(active);
      draining = initial.draining;
      const firstGate = initial.events.find((event) => event.type === 'human_gate:paused');
      if (firstGate?.type !== 'human_gate:paused') throw new Error('missing first fixture gate');
      await active.depart();
      await draining;
      active = undefined;
      expect(calls).toBe(1);

      client = createClient(dbPath);
      runMigrations(client.db, { dbPath });
      const dependencies = {
        uuid: randomUUID,
        now: Date.now,
        workflow: {
          slug: workflow.workflow.id,
          name: workflow.workflow.id,
          definitionJson: JSON.stringify(workflow),
        },
      };
      const store = createRunHistoryStore(client.db, dependencies);
      const workflowId = await store.resolveWorkflowId(workflow.workflow.id);
      let sequenceNumber = 0;
      // A schema-valid historical projection, not a frozen-predecessor execution claim.
      for (const event of initial.events) {
        if (
          event.type === 'cost:coverage_started' ||
          event.type === 'cost:usage_pending' ||
          event.type === 'cost:usage_disposition' ||
          event.type === 'cost:updated' ||
          event.type.startsWith('agent:')
        )
          continue;
        const legacy = { ...event };
        delete legacy.usageCoverage;
        delete legacy.cumulativeUnpricedCalls;
        if ('invocation' in legacy) delete legacy.invocation;
        await store.persistEvent(
          RunEventSchema.parse({
            ...legacy,
            ...(event.type === 'run:started' ? { workflowId } : {}),
            sequenceNumber: sequenceNumber++,
          }),
        );
      }
      const checkpoint = createHistoryCheckpointer(store);
      const inherited = await checkpoint.load(runId);
      expect(inherited?.cumulativeCostMicrocents).toBe(expectedCost);
      expect(inherited?.usageCoverage?.coverage).toEqual({
        unverified: true,
        pendingInvocations: 0,
        unknownCalls: 0,
      });
      // Check the persisted reader independently before using its checkpoint to execute.
      expect(readRunUsageCoverage(store, runId).unpricedCalls).toBe(firstUnpriced);

      const host = createCliHost(store, {
        checkpointer: checkpoint,
        runLeases: createRunLeasePort(store),
        terminalOutboxPath: join(root, 'terminal-outbox.ndjson'),
      });
      active = await new WorkflowEngine({ host, executor, resolvePrice }).resumeFromCheckpoint({
        runId,
        workflow,
        gateId: firstGate.gateId,
        decision: { decision: 'approved', decidedBy: 'offline-test' },
      });
      const resumed = await drainToPause(active);
      draining = resumed.draining;
      await active.depart();
      await draining;
      active = undefined;
      expect(calls).toBe(scenario.second === undefined ? 1 : 2);
      const view = createRunStore(false);
      for (const event of resumed.events) view.apply(event);
      view.flush();
      expect.soft(inherited?.cumulativeUnpricedCalls).toBe(firstUnpriced);
      expect.soft(resumed.events[0]?.cumulativeUnpricedCalls).toBe(firstUnpriced);
      expect.soft(view.getSnapshot().state.unpricedCalls).toBe(scenario.expectedUnpriced);
      expect.soft(view.getSnapshot().state.cumulativeCostMicrocents).toBe(expectedCost);
      expect.soft(view.getSnapshot().state.usageCoverage).toEqual({
        unverified: true,
        pendingInvocations: 0,
        unknownCalls: 0,
      });
      if (scenario.expectedUnpriced > 0)
        expect
          .soft(view.summaryText())
          .toContain(`price unknown for ${scenario.expectedUnpriced} call`);
      else expect.soft(view.summaryText()).not.toContain('price unknown');

      const secondGate = resumed.events.find((event) => event.type === 'human_gate:paused');
      if (secondGate?.type !== 'human_gate:paused') throw new Error('missing second fixture gate');
      client.sqlite.close();
      client = createClient(dbPath);
      runMigrations(client.db, { dbPath });
      const reopenedStore = createRunHistoryStore(client.db, dependencies);
      const reopenedCheckpoint = createHistoryCheckpointer(reopenedStore);
      const reopened = await reopenedCheckpoint.load(runId);
      expect.soft(reopened?.cumulativeUnpricedCalls).toBe(scenario.expectedUnpriced);
      const finalHost = createCliHost(reopenedStore, {
        checkpointer: reopenedCheckpoint,
        runLeases: createRunLeasePort(reopenedStore),
        terminalOutboxPath: join(root, 'terminal-outbox.ndjson'),
      });
      active = await new WorkflowEngine({
        host: finalHost,
        executor,
        resolvePrice,
      }).resumeFromCheckpoint({
        runId,
        workflow,
        gateId: secondGate.gateId,
        decision: { decision: 'approved', decidedBy: 'offline-test' },
      });
      const finalHandle = active;
      const finalEvents: RunEvent[] = [];
      draining = (async () => {
        for await (const event of finalHandle.events) finalEvents.push(event);
      })();
      await draining;
      expect(await active.depart()).toMatchObject({ kind: 'closed', moneyDurability: 'durable' });
      active = undefined;
      expect(calls).toBe(scenario.second === undefined ? 1 : 2);
      expect(finalEvents.at(-1)?.type).toBe('run:completed');
      const finalView = createRunStore(false);
      for (const event of finalEvents) {
        finalView.apply(event);
        finalView.flush();
        expect.soft(event.cumulativeUnpricedCalls).toBe(scenario.expectedUnpriced);
        expect.soft(finalView.getSnapshot().state.unpricedCalls).toBe(scenario.expectedUnpriced);
        expect.soft(finalView.getSnapshot().state.cumulativeCostMicrocents).toBe(expectedCost);
      }
      expect.soft(finalView.summaryText()).toContain('usage unverified');
      if (scenario.expectedUnpriced > 0)
        expect
          .soft(finalView.summaryText())
          .toContain(`price unknown for ${scenario.expectedUnpriced} call`);
      else expect.soft(finalView.summaryText()).not.toContain('price unknown');
      expect(readRunUsageCoverage(reopenedStore, runId)).toMatchObject({
        totalCostMicrocents: expectedCost,
        unpricedCalls: scenario.expectedUnpriced,
        usageCoverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
      });
    } finally {
      active?.cancel();
      await draining;
      await active?.depart();
      client?.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
