import {
  createClient,
  createRunHistoryStore,
  runMigrations,
  type DbClient,
  type RunHistoryStore,
  runEvents,
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

  it('keeps lastSequenceNumber true when a row written by a NEWER binary is the log`s tail (ADR-0074 §5)', async () => {
    // The destructive shape this guards. `resumeFromCheckpoint` seeds the bus with `lastSequenceNumber + 1`, and a
    // row whose `type` this binary does not know is DROPPED from the fold (§5). If that row is the tail, folding
    // only the readable events yields a mark BELOW what is stored, the resumed run stamps a `seq` that is already
    // taken, `UNIQUE(run_id, seq)` rejects the durable write, and the engine settles `run:failed`. A run that
    // merely needed a newer binary to read ONE row would become terminally unresumable — by either binary. Note
    // this is strictly worse than the pre-§5 behaviour, where the read threw and the run stayed cleanly paused.
    const wf = await store.resolveWorkflowId('demo');
    const events: RunEvent[] = [
      {
        type: 'run:started',
        runId: 'run-2',
        timestamp: TS,
        sequenceNumber: 0,
        workflowId: wf,
        inputs: {},
        executionMode: 'local',
      },
      {
        type: 'human_gate:paused',
        runId: 'run-2',
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'gate',
        gateId: 'g1',
        gateType: 'approval',
        message: 'ship it?',
      },
      {
        type: 'run:paused',
        runId: 'run-2',
        timestamp: TS,
        sequenceNumber: 2,
        pendingGateCount: 1,
        gateIds: ['g1'],
      },
    ];
    for (const event of events) {
      await store.persistEvent(event);
    }
    // Straight through drizzle: `persistEvent` validates on the way in, which is exactly why only a NEWER binary
    // can produce this row. Seq 3 is the TAIL — the number the next durable write must not re-use.
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-000000000099',
        runId: 'run-2',
        seq: 3,
        eventType: 'test:never_a_real_event',
        payloadJson: JSON.stringify({ type: 'test:never_a_real_event', estimateMicrocents: 500 }),
        ts: new Date(TS).getTime(),
      })
      .run();

    const checkpoint = await createHistoryCheckpointer(store).load('run-2');
    // 3, not 2 — the fold saw only seq 0..2, so the skipped row's authoritative `seq` column is folded back in.
    expect(checkpoint?.lastSequenceNumber).toBe(3);
    // The rest of the reconstruction is unaffected: the unreadable row is skipped, not fatal.
    expect(checkpoint?.runStatus).toBe('paused');
  });
});
