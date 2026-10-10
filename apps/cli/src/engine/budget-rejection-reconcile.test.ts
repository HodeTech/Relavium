import { createInMemoryHost, WorkflowEngine, type NodeOutcome } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
  type RunHistoryStore,
} from '@relavium/db';
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const epoch = Date.parse('2026-10-04T00:00:00.000Z');
let client: DbClient;
let store: RunHistoryStore;
let id: number;
const ev = (
  type: RunEvent['type'],
  sequenceNumber: number,
  fields: Record<string, unknown>,
): RunEvent =>
  RunEventSchema.parse({
    type,
    runId: 'run-1',
    timestamp: new Date(epoch).toISOString(),
    sequenceNumber,
    ...fields,
  });
async function startRun(): Promise<void> {
  const workflowId = await store.resolveWorkflowId('budget-rejection');
  await store.persistEvent(
    ev('run:started', 0, { workflowId, inputs: {}, executionMode: 'local' }),
  );
}
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  id = 0;
  store = createRunHistoryStore(client.db, {
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    now: () => epoch,
    workflow: {
      slug: 'budget-rejection',
      name: 'Budget rejection',
      definitionJson: JSON.stringify({
        workflow: { id: 'budget-rejection', name: 'Budget rejection', nodes: [], edges: [] },
      }),
    },
  });
});
afterEach(() => {
  client.sqlite.close();
});

describe('native budget rejection crash recovery', () => {
  for (const companion of [false, true]) {
    it(`keeps a rejected budget decision recoverable until the native run terminal (companion=${companion})`, async () => {
      await startRun();
      await store.persistEvent(
        ev('budget:authorization', 1, {
          nodeId: 'agent',
          gateId: 'budget',
          authorization: {
            state: 'paused',
            allowance: { kind: 'legacy_no_allowance' },
            spentMicrocents: 2,
            limitMicrocents: 1,
          },
        }),
      );
      await store.persistEvent(
        ev('budget:authorization', 2, {
          nodeId: 'agent',
          gateId: 'budget',
          authorization: {
            state: 'decided',
            allowance: { kind: 'legacy_no_allowance' },
            decision: 'rejected',
            decidedBy: 'operator',
          },
        }),
      );
      if (companion)
        await store.persistEvent(
          ev('human_gate:resumed', 3, {
            nodeId: 'agent',
            gateId: 'budget',
            decision: 'rejected',
            decidedBy: 'operator',
          }),
        );
      const before = store.loadRunEventLogForReplay('run-1');
      expect(await store.listInterruptedRuns()).toEqual([
        expect.objectContaining({
          runId: 'run-1',
          resumable: false,
          budgetRejected: true,
          lastSequenceNumber: companion ? 3 : 2,
        }),
      ]);
      // The non-terminal row is a discovery index; a rejected decision grants no dispatch authority.
      expect(store.loadRun('run-1')?.status).toBe('running');
      const execute = vi.fn(
        (): Promise<NodeOutcome> => Promise.resolve({ kind: 'completed', output: '' }),
      );
      const engine = new WorkflowEngine({
        host: createInMemoryHost({
          store,
          runLeases: createRunLeasePort(store),
          baseEpochMs: epoch,
        }),
        executor: { execute },
      });
      const reconciled = await engine.reconcile();
      expect(reconciled).toHaveLength(1);
      expect(reconciled).toMatchObject([
        {
          type: 'run:failed',
          sequenceNumber: companion ? 4 : 3,
          error: { code: 'budget_exceeded' },
        },
      ]);
      expect(execute).not.toHaveBeenCalled();
      expect(store.loadRunEventLogForReplay('run-1').slice(0, before.length)).toEqual(before);
      expect(store.loadRun('run-1')?.status).toBe('failed');
      expect(store.loadRun('run-1')?.totalCostMicrocents).toBe(0);
      expect(store.leases.read('run-1')).toBeUndefined();
      expect(await engine.reconcile()).toEqual([]);
    });
  }
});
