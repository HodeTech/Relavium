import {
  createDispatchingNodeExecutor,
  createInMemoryHost,
  createInputNodeExecutor,
  createOutputNodeExecutor,
  parseWorkflow,
  WorkflowEngine,
} from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
} from '@relavium/db';
import type { RunEvent, UsageCoverage, UsageCoverageBasis } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { statusCommand } from '../commands/status.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { readRunUsageCoverage } from './usage-coverage.js';

const timestamp = '2026-10-11T00:00:00.000Z';
const complete: UsageCoverage = { unverified: false, pendingInvocations: 0, unknownCalls: 0 };
const unverified: UsageCoverage = { ...complete, unverified: true };

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function status(client: ReturnType<typeof createClient>): Promise<readonly unknown[]> {
  const { io, out } = captureIo();
  expect(
    await statusCommand({
      io,
      global: {
        json: true,
        color: false,
        cwd: process.cwd(),
        configPath: undefined,
        verbosity: 'normal',
      },
      openDb: () => ({ db: client.db, close: () => {} }),
      readTerminalOutbox: () => Promise.resolve([]),
    }),
  ).toBe(0);
  return parseNdjson(out());
}

function history(client: ReturnType<typeof createClient>, definitionJson = '{}') {
  let id = 0;
  return createRunHistoryStore(client.db, {
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    now: () => Date.parse(timestamp),
    workflow: { slug: 'step-basis', name: 'step-basis', definitionJson },
  });
}

/** Synthetic legacy-style rows, authored here; these are not captured predecessor fixtures. */
async function syntheticHistory(client: ReturnType<typeof createClient>) {
  const store = history(client);
  const workflowId = await store.resolveWorkflowId('step-basis');
  const envelope = { runId: 'r', timestamp, sequenceNumber: 0 };
  let sequenceNumber = 0;
  const put = (event: RunEvent): Promise<void> =>
    store.persistEvent({ ...event, sequenceNumber: sequenceNumber++ });
  await put({ ...envelope, type: 'run:started', workflowId, inputs: {}, executionMode: 'local' });
  return { store, envelope, put };
}

describe('persisted step usage basis', () => {
  it('qualifies actual input/output engine steps before the first provider invocation', async () => {
    const client = createClient();
    const terminalEntered = deferred();
    const releaseTerminal = deferred();
    let drained: Promise<void> | undefined;
    try {
      runMigrations(client.db);
      const workflow = parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'step-basis',
            nodes: [
              { id: 'input', type: 'input' },
              { id: 'output', type: 'output' },
            ],
            edges: [{ from: 'input', to: 'output' }],
          },
        }),
      );
      const store = history(client, JSON.stringify(workflow));
      const base = createInMemoryHost({ store, runLeases: createRunLeasePort(store) });
      const host = {
        ...base,
        store: {
          ...store,
          persistEvent: async (...args: Parameters<typeof store.persistEvent>) => {
            if (args[0].type === 'run:completed' || args[0].type === 'run:failed') {
              terminalEntered.resolve();
              await releaseTerminal.promise;
            }
            await store.persistEvent(...args);
          },
        },
      };
      const executor = createDispatchingNodeExecutor({
        input: createInputNodeExecutor(),
        output: createOutputNodeExecutor(),
      });
      const handle = new WorkflowEngine({ host, executor }).start({ workflow });
      const publicEvents: RunEvent[] = [];
      drained = (async () => {
        for await (const event of handle.events) publicEvents.push(event);
      })();
      await terminalEntered.promise;
      const events = store.loadRunEventLogForReplay(handle.runId);
      expect(events.filter((event) => event.type === 'cost:coverage_started')).toMatchObject([
        { basis: 'complete' },
      ]);
      expect(events.filter((event) => event.type === 'node:started')).toMatchObject([
        { nodeId: 'input' },
        { nodeId: 'output' },
      ]);
      expect(events.some((event) => event.type === 'cost:usage_pending')).toBe(false);
      expect(events.some((event) => event.type === 'cost:usage_disposition')).toBe(false);
      expect(events.some((event) => event.type === 'cost:attempt_settled')).toBe(false);
      expect(await status(client)).toEqual([
        expect.objectContaining({
          runId: handle.runId,
          totalCostMicrocents: 0,
          unpricedCalls: 0,
          usageCoverage: complete,
          steps: ['input', 'output'].map((nodeId): unknown =>
            expect.objectContaining({
              nodeId,
              status: 'completed',
              costMicrocents: 0,
              usageCoverage: complete,
            }),
          ),
        }),
      ]);
      releaseTerminal.resolve();
      await drained;
      expect(publicEvents.at(-1)?.type).toBe('run:completed');
      expect(await handle.depart()).toMatchObject({ kind: 'closed', moneyDurability: 'durable' });
    } finally {
      releaseTerminal.resolve();
      await drained;
      client.sqlite.close();
    }
  });

  it.each<UsageCoverageBasis | undefined>([undefined, 'legacy_unverified'])(
    'retains unverified synthetic zero-money steps with basis %s',
    async (basis) => {
      const client = createClient();
      try {
        runMigrations(client.db);
        const { envelope, put } = await syntheticHistory(client);
        if (basis !== undefined) await put({ ...envelope, type: 'cost:coverage_started', basis });
        await put({ ...envelope, type: 'node:started', nodeId: 'old', nodeType: 'input' });
        await put({
          ...envelope,
          type: 'node:completed',
          nodeId: 'old',
          output: {},
          tokensUsed: { input: 0, output: 0 },
          durationMs: 1,
        });
        expect(await status(client)).toEqual([
          expect.objectContaining({
            totalCostMicrocents: 0,
            usageCoverage: unverified,
            steps: [expect.objectContaining({ nodeId: 'old', usageCoverage: unverified })],
          }),
        ]);
      } finally {
        client.sqlite.close();
      }
    },
  );

  it('does not retroactively qualify an existing synthetic pre-basis step after a later basis', async () => {
    const client = createClient();
    try {
      runMigrations(client.db);
      const { envelope, put } = await syntheticHistory(client);
      await put({ ...envelope, type: 'node:started', nodeId: 'old', nodeType: 'input' });
      // Deliberately ordered synthetic input: a later basis cannot rewrite the old node's basis.
      await put({ ...envelope, type: 'cost:coverage_started', basis: 'complete' });
      await put({ ...envelope, type: 'node:started', nodeId: 'fresh', nodeType: 'output' });
      await put({
        ...envelope,
        type: 'node:skipped',
        nodeId: 'untaken',
        reason: 'branch_not_taken',
      });
      expect(await status(client)).toEqual([
        expect.objectContaining({
          totalCostMicrocents: 0,
          usageCoverage: complete,
          steps: [
            expect.objectContaining({ nodeId: 'old', usageCoverage: unverified }),
            expect.objectContaining({ nodeId: 'fresh', usageCoverage: complete }),
          ],
        }),
      ]);
    } finally {
      client.sqlite.close();
    }
  });

  it.each<UsageCoverageBasis | undefined>([undefined, 'legacy_unverified', 'complete'])(
    'preserves correlated token pending and unknown counts with basis %s',
    async (basis) => {
      const client = createClient();
      try {
        runMigrations(client.db);
        const { store, envelope, put } = await syntheticHistory(client);
        if (basis !== undefined) await put({ ...envelope, type: 'cost:coverage_started', basis });
        await put({ ...envelope, type: 'node:started', nodeId: 'token', nodeType: 'agent' });
        const invocation = {
          producerId: 'producer',
          ordinal: 1,
          dispatchId: 'dispatch',
          round: 0,
          chainAttempt: 1,
        };
        const accounting = { ...envelope, nodeId: 'token', model: 'model', invocation };
        const startingCoverage = basis === 'complete' ? complete : unverified;
        const assertCoverage = async (coverage: UsageCoverage): Promise<void> => {
          const read = readRunUsageCoverage(store, envelope.runId);
          expect(read.usageCoverage).toEqual(coverage);
          expect(read.nodes.get('token')).toEqual(coverage);
          expect(await status(client)).toEqual([
            expect.objectContaining({
              totalCostMicrocents: 0,
              usageCoverage: coverage,
              steps: [expect.objectContaining({ nodeId: 'token', usageCoverage: coverage })],
            }),
          ]);
        };
        await put({ ...accounting, type: 'cost:usage_pending' });
        await assertCoverage({ ...startingCoverage, pendingInvocations: 1 });
        await put({
          ...accounting,
          type: 'cost:usage_disposition',
          disposition: {
            kind: 'incomplete',
            evidence: { kind: 'missing', reason: 'not_reported' },
          },
        });
        await assertCoverage({ ...startingCoverage, unknownCalls: 1 });
        const later = { ...accounting, invocation: { ...invocation, ordinal: 2, round: 1 } };
        await put({ ...later, type: 'cost:usage_pending' });
        await assertCoverage({ ...startingCoverage, pendingInvocations: 1, unknownCalls: 1 });
        await put({
          ...later,
          type: 'cost:attempt_settled',
          attemptNumber: 1,
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: 0,
          cumulativeCostMicrocents: 0,
          priced: true,
        });
        await assertCoverage({ ...startingCoverage, unknownCalls: 1 });
      } finally {
        client.sqlite.close();
      }
    },
  );
});
