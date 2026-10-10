import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentNodeExecutor,
  createInMemoryHost,
  parseWorkflow,
  reconstructCheckpointState,
  WorkflowEngine,
  type RunEventDraft,
} from '@relavium/core';
import {
  createClient,
  createRunHistoryReader,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import type { ModelPricing } from '@relavium/llm';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import { UsageCoverageFold, type RunEvent, type UsageCoverage } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createRunStore } from './run-store.js';

function latch() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function coverageOf(events: readonly RunEvent[]): UsageCoverage {
  const fold = new UsageCoverageFold();
  for (const event of events) fold.apply(event);
  return fold.snapshot().coverage;
}

const pending: UsageCoverage = {
  unverified: false,
  pendingInvocations: 1,
  unknownCalls: 0,
};
const complete: UsageCoverage = {
  unverified: false,
  pendingInvocations: 0,
  unknownCalls: 0,
};

describe.each([false, true])('actual workflow settlement ACK (refused=%s)', (refused) => {
  it.each([0, 10])(
    'keeps every public total qualified until SQLite acknowledges %i input tokens',
    async (inputTokens) => {
      const directory = mkdtempSync(join(tmpdir(), 'relavium-workflow-usage-ack-'));
      const path = join(directory, 'history.db');
      const client = createClient(path);
      runMigrations(client.db);
      const ledgerEntered = latch();
      const releaseLedger = latch();
      let id = 0;
      const workflow = parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'actual-usage-ack',
            agents: [{ id: 'a', provider: 'openai', model: 'offline', system_prompt: 'offline' }],
            nodes: [{ id: 'n', type: 'agent', agent_ref: 'a', prompt_template: 'offline' }],
            edges: [],
          },
        }),
      );
      const store = createRunHistoryStore(client.db, {
        uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
        now: () => Date.parse('2026-10-10T00:00:00Z'),
        workflow: {
          slug: workflow.workflow.id,
          name: workflow.workflow.id,
          definitionJson: JSON.stringify(workflow),
        },
      });
      const base = createInMemoryHost({ store, runLeases: createRunLeasePort(store) });
      const host = {
        ...base,
        store: {
          ...store,
          persistEvent: async (...args: Parameters<typeof store.persistEvent>) => {
            if (args[0].type === 'cost:attempt_settled') {
              ledgerEntered.resolve();
              await releaseLedger.promise;
              if (refused) throw new Error('offline actual settlement refusal');
            }
            await store.persistEvent(...args);
          },
        },
      };
      let calls = 0;
      const provider = createOpenAiAdapter({
        maxRetries: 0,
        fetch: () => {
          calls += 1;
          return Promise.resolve(
            new Response(
              `data: ${JSON.stringify({
                id: 'offline',
                choices: [{ index: 0, delta: { content: 'offline' }, finish_reason: 'stop' }],
                usage: {
                  prompt_tokens: inputTokens,
                  completion_tokens: 0,
                  prompt_tokens_details: { cached_tokens: 0 },
                },
              })}\n\ndata: [DONE]\n\n`,
              { headers: { 'content-type': 'text/event-stream' } },
            ),
          );
        },
      });
      const pricing: ModelPricing = {
        provider: 'openai',
        nativeId: 'offline',
        displayName: 'offline',
        contextWindowTokens: 10000,
        maxOutputTokens: 100,
        inputPerMtokMicrocents: 100000000,
        outputPerMtokMicrocents: 0,
        cachedInputPerMtokMicrocents: 0,
      };
      const resolvePrice = new Map([['offline', pricing]]);
      const handle = new WorkflowEngine({
        host,
        resolvePrice,
        executor: createAgentNodeExecutor({
          resolveProvider: () => provider,
          keyFor: () => 'offline-fixture',
          resolvePrice,
          sleep: () => Promise.resolve(),
          tools: [],
          registry: {
            has: () => false,
            list: () => [],
            dispatch: () => Promise.reject(new Error('tools forbidden')),
          },
        }),
      }).start({ workflow });
      const events: RunEvent[] = [];
      const projections: {
        readonly event: RunEvent;
        readonly coverage: UsageCoverage | undefined;
      }[] = [];
      const view = createRunStore(false);
      const drain = (async () => {
        for await (const event of handle.events) {
          events.push(event);
          view.apply(event);
          view.flush();
          projections.push({ event, coverage: view.getSnapshot().state.usageCoverage });
        }
      })();
      try {
        // The actual ledger port, rather than a tick count or timer, defines this observation cut.
        await Promise.race([
          ledgerEntered.promise,
          drain.then(() => {
            throw new Error('run ended before the actual settlement write');
          }),
        ]);
        const prefix = store.loadRunEventLogForReplay(handle.runId);
        const heldCoverage = view.getSnapshot().state.usageCoverage;
        const observation = events.find((event) => event.type === 'cost:updated');
        const checkpoint = reconstructCheckpointState(prefix);
        const heldSummary = view.summaryText();
        releaseLedger.resolve();
        await drain;
        const departure = await handle.depart();
        const finalCoverage = refused ? pending : complete;
        expect(calls).toBe(1);
        expect(coverageOf(prefix)).toEqual(pending);
        expect(checkpoint?.usageCoverage?.coverage).toEqual(pending);
        expect(prefix.some((event) => event.type === 'cost:attempt_settled')).toBe(false);
        expect(heldCoverage).toEqual(pending);
        expect(observation).toMatchObject({
          type: 'cost:updated',
          costMicrocents: inputTokens * 100,
          usageCoverage: pending,
        });
        // This live observation is not the workflow completion authority. The private ledger retains it.
        expect(observation?.type === 'cost:updated' ? observation.invocation : undefined).toBe(
          undefined,
        );
        expect(heldSummary).toContain('1 usage pending');
        expect(departure).toMatchObject({
          kind: 'closed',
          moneyDurability: refused ? 'uncertain' : 'durable',
        });
        expect(events.at(-1)).toMatchObject({
          type: refused ? 'run:failed' : 'run:completed',
          usageCoverage: finalCoverage,
        });
        expect(view.getSnapshot().state.usageCoverage).toEqual(finalCoverage);
        const settled = events.filter((event) => event.type === 'cost:attempt_settled');
        expect(settled).toHaveLength(1);
        // Failed durable asks remain delivered under ADR-0078; only the ACKed row belongs to replay.
        if (!refused) expect(settled[0]?.invocation).toBeDefined();
        for (const projection of projections) {
          if (projection.event.type === 'cost:attempt_settled') {
            expect(projection.coverage).toEqual(finalCoverage);
            expect(projection.event.usageCoverage).toEqual(refused ? pending : undefined);
          }
        }
        client.sqlite.close();
        const reopened = createClient(path);
        try {
          const durable = createRunHistoryReader(reopened.db).loadRunEventLogForReplay(
            handle.runId,
          );
          const restored = createRunStore(false);
          for (const event of durable) restored.apply(event);
          restored.flush();
          expect(durable.filter((event) => event.type === 'cost:attempt_settled')).toHaveLength(
            refused ? 0 : 1,
          );
          expect(coverageOf(durable)).toEqual(finalCoverage);
          expect(durable.at(-1)?.usageCoverage).toEqual(finalCoverage);
          expect(restored.getSnapshot().state.usageCoverage).toEqual(finalCoverage);
          expect(restored.summaryText().includes('1 usage pending')).toBe(refused);
        } finally {
          reopened.sqlite.close();
        }
      } finally {
        releaseLedger.resolve();
        await drain;
        await handle.depart();
        if (client.sqlite.open) client.sqlite.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

it.each(['basis', 'pending', 'disposition', 'actual'] as const)(
  'a qualified failed %s ask does not consume the workflow reader correlation',
  (kind) => {
    const view = createRunStore(false);
    let sequenceNumber = 0;
    const apply = (event: RunEventDraft): void => {
      view.apply({ ...event, sequenceNumber: sequenceNumber++, timestamp: '2026-10-10T00:00:00Z' });
      view.flush();
    };
    const invocation = {
      producerId: 'owner',
      ordinal: 1,
      dispatchId: 'dispatch',
      round: 0,
      chainAttempt: 1,
    };
    const start: RunEventDraft = {
      type: 'cost:coverage_started',
      runId: 'run',
      basis: 'complete',
    };
    const begun: RunEventDraft = {
      type: 'cost:usage_pending',
      runId: 'run',
      nodeId: 'n',
      model: 'offline',
      invocation,
    };
    const actual: RunEventDraft = {
      type: 'cost:attempt_settled',
      runId: 'run',
      nodeId: 'n',
      model: 'offline',
      invocation,
      attemptNumber: 1,
      inputTokens: 0,
      outputTokens: 0,
      costMicrocents: 0,
      cumulativeCostMicrocents: 0,
      priced: true,
    };
    if (kind === 'basis') {
      const unverified = { ...complete, unverified: true };
      apply({ ...start, basis: 'legacy_unverified', usageCoverage: unverified });
      expect(view.getSnapshot().state.usageCoverage).toEqual(unverified);
      apply(start);
      expect(view.getSnapshot().state.usageCoverage).toEqual(complete);
      return;
    }
    apply(start);
    if (kind === 'pending') {
      apply({ ...begun, usageCoverage: complete });
      expect(view.getSnapshot().state.usageCoverage).toEqual(complete);
      // The same ordinal is still new to the reader: the failed ask never acknowledged it.
      apply(begun);
      expect(view.getSnapshot().state.usageCoverage).toEqual(pending);
      return;
    }
    apply(begun);
    const refused: RunEventDraft =
      kind === 'actual'
        ? actual
        : {
            type: 'cost:usage_disposition',
            runId: 'run',
            nodeId: 'n',
            model: 'offline',
            invocation,
            disposition: { kind: 'not_invoked', reason: 'cancelled' },
          };
    apply({ ...refused, usageCoverage: pending });
    expect(view.getSnapshot().state.usageCoverage).toEqual(pending);
    apply(actual);
    expect(view.getSnapshot().state.usageCoverage).toEqual(complete);
  },
);
