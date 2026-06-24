import {
  createClient,
  createRunHistoryStore,
  runMigrations,
  type DbClient,
  type RunHistoryStore,
  type RunHistoryWorkflow,
} from '@relavium/db';
import type { RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHistoryCheckpointer } from './checkpointer.js';

const TS = '2026-06-24T10:00:00.000Z';
const WORKFLOW: RunHistoryWorkflow = {
  slug: 'demo',
  name: 'Demo',
  definitionJson: JSON.stringify({ workflow: { id: 'demo', name: 'Demo', nodes: [], edges: [] } }),
};

describe('createHistoryCheckpointer', () => {
  let client: DbClient;
  let store: RunHistoryStore;
  let n: number;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    n = 0;
    store = createRunHistoryStore(client.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => new Date(TS).getTime(),
      workflow: WORKFLOW,
    });
  });

  afterEach(() => {
    client.sqlite.close();
  });

  it('reconstructs a paused run`s checkpoint from the durable event log (the 2.G read path)', async () => {
    const wf = await store.resolveWorkflowId('demo');
    // A realistic pause emits the per-gate `human_gate:paused` AND the aggregate `run:paused` (the latter is
    // what folds the checkpoint's run-level status to 'paused'; the former adds the pending gate + node state).
    const events: RunEvent[] = [
      {
        type: 'run:started',
        runId: 'run-1',
        timestamp: TS,
        sequenceNumber: 0,
        workflowId: wf,
        inputs: {},
        executionMode: 'local',
      },
      {
        type: 'human_gate:paused',
        runId: 'run-1',
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'gate',
        gateId: 'g1',
        gateType: 'approval',
        message: 'ship it?',
      },
      {
        type: 'run:paused',
        runId: 'run-1',
        timestamp: TS,
        sequenceNumber: 2,
        pendingGateCount: 1,
        gateIds: ['g1'],
      },
    ];
    for (const event of events) {
      await store.persistEvent(event);
    }

    const checkpoint = await createHistoryCheckpointer(store).load('run-1');
    expect(checkpoint?.runStatus).toBe('paused');
    expect(checkpoint?.workflowId).toBe(wf);
    expect(checkpoint?.pendingGates.map((g) => g.gateId)).toEqual(['g1']);
    expect(checkpoint?.resolvedGateIds).toEqual([]);
  });

  it('returns undefined for a run with no persisted run:started (unknown / never-persisted)', async () => {
    expect(await createHistoryCheckpointer(store).load('nope')).toBeUndefined();
  });
});
