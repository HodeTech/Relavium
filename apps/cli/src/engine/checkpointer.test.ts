import {
  createClient,
  createRunHistoryStore,
  isUnreadableRunEventLogError,
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

  it('REFUSES the resume when a row was written by a NEWER binary (ADR-0075)', async () => {
    // This test previously asserted the OPPOSITE, and the change is deliberate (ADR-0075 amends ADR-0074 §5).
    //
    // What it used to pin: a skipped TAIL row left `lastSequenceNumber` below what is stored, so the resumed
    // run stamped a taken `seq`, `UNIQUE(run_id, seq)` rejected the write, and the engine settled
    // `run:failed`. The fix folded the skipped row's authoritative `seq` back in. That was a real repair —
    // and it addressed the write COLLISION while leaving the lost STATE unaddressed, which is the more
    // dangerous half: this binary cannot know whether the dropped row was a node terminal, a job submission,
    // a gate decision or a cost commitment, so the resumed run may re-run completed work or re-submit an
    // already-billed media job, silently and with no error at all.
    //
    // So the resume now REFUSES. The collision it used to repair cannot occur, because the resume does not
    // happen; every read-only surface still shows the run.
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

    const load = createHistoryCheckpointer(store).load('run-2');

    await expect(load).rejects.toThrow(/newer version of Relavium/);
    // Narrowed on the TYPE, not on "something threw" — and DISTINCT from `CorruptRunEventError`, because the
    // difference is the whole value of the message: the data is fine, this binary is too old, and the remedy
    // is an upgrade the user can actually perform.
    await expect(load).rejects.toSatisfy(isUnreadableRunEventLogError);
    // The diagnostic names the row by its authoritative `seq` COLUMN — the one number this binary can trust
    // about a payload it could not parse.
    await expect(load).rejects.toThrow(/seq 3/);

    // …and the run is NOT lost: the tolerant read that every display surface uses still returns it.
    expect(store.loadRunEventLog('run-2').events.map((e) => e.type)).toEqual([
      'run:started',
      'human_gate:paused',
      'run:paused',
    ]);
    expect(store.loadRunEventLog('run-2').skipped).toEqual([
      { sequenceNumber: 3, type: 'test:never_a_real_event' },
    ]);
  });
});
