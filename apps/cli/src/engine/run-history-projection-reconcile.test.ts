import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryHost, WorkflowEngine, type NodeOutcome } from '@relavium/core';
import {
  CorruptRunEventError,
  createClient,
  createRunHistoryStore,
  createRunLeasePort,
  runMigrations,
  type DbClient,
  type RunHistoryStore,
} from '@relavium/db';
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('native reconciliation refuses a corrupted known suspension discriminator', () => {
  const epoch = Date.parse('2026-10-07T00:00:00.000Z');
  let client: DbClient;
  let store: RunHistoryStore;
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'reconcile-event-projection-'));
    client = createClient(join(directory, 'history.db'));
    runMigrations(client.db);
    let ordinal = 0;
    store = createRunHistoryStore(client.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++ordinal).padStart(12, '0')}`,
      now: () => epoch,
      workflow: {
        slug: 'projection',
        name: 'Projection',
        definitionJson: JSON.stringify({
          workflow: { id: 'projection', name: 'Projection', nodes: [], edges: [] },
        }),
      },
    });
  });

  afterEach(() => {
    client.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function populate(type: 'human_gate:paused' | 'budget:authorization'): Promise<RunEvent> {
    const workflowId = await store.resolveWorkflowId('projection');
    let damagedPause: RunEvent | undefined;
    for (const runId of ['healthy', 'damaged']) {
      const identity = { runId, timestamp: new Date(epoch).toISOString() };
      await store.persistEvent(
        RunEventSchema.parse({
          ...identity,
          type: 'run:started',
          sequenceNumber: 0,
          workflowId,
          inputs: {},
          executionMode: 'local',
        }),
      );
      const pause = RunEventSchema.parse({
        ...identity,
        sequenceNumber: 1,
        nodeId: 'agent',
        gateId: 'gate',
        ...(type === 'human_gate:paused'
          ? { type, gateType: 'approval', message: 'approve' }
          : {
              type,
              authorization: {
                state: 'paused',
                allowance: { kind: 'legacy_no_allowance' },
                spentMicrocents: 2,
                limitMicrocents: 1,
              },
            }),
      });
      await store.persistEvent(pause);
      if (runId === 'damaged') damagedPause = pause;
    }
    if (damagedPause === undefined) throw new Error('test fixture did not persist its pause');
    return damagedPause;
  }

  function recovery() {
    const execute = vi.fn(
      (): Promise<NodeOutcome> => Promise.resolve({ kind: 'completed', output: '' }),
    );
    return {
      execute,
      engine: new WorkflowEngine({
        host: createInMemoryHost({
          store,
          runLeases: createRunLeasePort(store),
          baseEpochMs: epoch,
        }),
        executor: { execute },
      }),
    };
  }

  for (const type of ['human_gate:paused', 'budget:authorization'] as const) {
    it(`refuses ${type} corruption before acquiring a lease or writing any terminal`, async () => {
      const pause = await populate(type);
      client.sqlite
        .prepare('UPDATE run_events SET payload_json = ? WHERE run_id = ? AND seq = ?')
        .run(JSON.stringify({ ...pause, type: 'future:pause' }), 'damaged', 1);
      const evidence = client.sqlite.prepare('SELECT * FROM run_events ORDER BY run_id, seq').all();
      const runs = client.sqlite.prepare('SELECT * FROM runs ORDER BY id').all();
      const { engine, execute } = recovery();

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(engine.reconcile()).rejects.toBeInstanceOf(CorruptRunEventError);
        expect(
          client.sqlite.prepare('SELECT * FROM run_events ORDER BY run_id, seq').all(),
        ).toEqual(evidence);
        expect(client.sqlite.prepare('SELECT * FROM runs ORDER BY id').all()).toEqual(runs);
        expect(store.leases.read('damaged')).toBeUndefined();
        expect(store.leases.read('healthy')).toBeUndefined();
      }
      expect(store.loadRun('damaged')?.status).toBe('paused');
      expect(store.loadRun('healthy')?.status).toBe('paused');
      expect(execute).not.toHaveBeenCalled();
    });

    it(`preserves both genuine ${type} suspensions without dispatch or terminal writes`, async () => {
      await populate(type);
      const evidence = client.sqlite.prepare('SELECT * FROM run_events ORDER BY run_id, seq').all();
      const { engine, execute } = recovery();
      expect(await engine.reconcile()).toEqual([]);
      expect((await store.listInterruptedRuns()).every((run) => run.resumable)).toBe(true);
      expect(client.sqlite.prepare('SELECT * FROM run_events ORDER BY run_id, seq').all()).toEqual(
        evidence,
      );
      expect(execute).not.toHaveBeenCalled();
    });
  }
});
