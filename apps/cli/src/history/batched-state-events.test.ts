import {
  createClient,
  createRunHistoryReader,
  runMigrations,
  type Db,
  type DbClient,
  type RunStateEventsRead,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decidedGateNodes, pendingGateDisplays, pendingHumanGates } from '../gate/pending.js';
import { seedRun } from '../test-support.js';
import { batchedStateEvents, STATE_EVENT_BATCH_RUNS } from './batched-state-events.js';

describe('batchedStateEvents — the batch saves reads and never changes an answer', () => {
  it('reads in chunks the store accepts: 450 ids are three calls of 200, 200 and 50', () => {
    const loadRunStateEventsForRuns = vi.fn((ids: readonly string[]) => {
      return new Map(ids.map((id): [string, RunStateEventsRead] => [id, { events: [] }]));
    });
    const ids = Array.from({ length: 450 }, (_, index) => `run-${String(index)}`);
    const out = batchedStateEvents({ loadRunStateEventsForRuns }, ids);
    expect(loadRunStateEventsForRuns.mock.calls.map(([chunk]) => chunk.length)).toEqual([
      STATE_EVENT_BATCH_RUNS,
      STATE_EVENT_BATCH_RUNS,
      50,
    ]);
    expect(out.size).toBe(450);
  });

  it('a faulting chunk leaves its runs out, and the other chunks still answer', () => {
    const ids = Array.from({ length: 300 }, (_, index) => `run-${String(index)}`);
    const loadRunStateEventsForRuns = vi.fn((chunk: readonly string[]) => {
      if (chunk[0] === 'run-0') throw new Error('disk I/O error');
      return new Map(chunk.map((id): [string, RunStateEventsRead] => [id, { events: [] }]));
    });
    const out = batchedStateEvents({ loadRunStateEventsForRuns }, ids);
    expect(out.has('run-0')).toBe(false);
    expect(out.has('run-199')).toBe(false);
    expect(out.has('run-200')).toBe(true);
  });

  it('a corrupt answer is NOT kept: its run is read per run, which reports the corruption as before', () => {
    const loadRunStateEventsForRuns = vi.fn(
      (): ReadonlyMap<string, RunStateEventsRead> => new Map([['bad', { corrupt: true }]]),
    );
    const out = batchedStateEvents({ loadRunStateEventsForRuns }, ['bad']);
    expect(out.has('bad')).toBe(false);
  });
});

describe('the batched state events fold to the same gates as the per-run read (the oracle)', () => {
  let client: DbClient;
  let db: Db;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    db = client.db;
  });
  afterEach(() => {
    client.sqlite.close();
  });

  it('a paused run with a human gate and a finished run fold identically from state events and from the full log', async () => {
    const paused = await seedRun(db, {
      slug: 'a',
      runId: 'run-paused',
      state: 'paused',
      gate: {
        gateId: 'g-1',
        gateType: 'approval',
        message: 'Approve the draft?',
        nodeId: 'review',
      },
    });
    const finished = await seedRun(db, { slug: 'b', runId: 'run-done', state: 'completed' });
    const reader = createRunHistoryReader(db);

    const batched = batchedStateEvents(reader, [paused, finished]);
    for (const runId of [paused, finished]) {
      const answer = batched.get(runId);
      expect(answer, `${runId} has a healthy batched answer`).toBeDefined();
      if (answer === undefined || !('events' in answer)) continue;
      const fullLog = reader.loadRunEvents(runId);
      expect(pendingHumanGates(answer.events), `${runId}: pending gates`).toEqual(
        pendingHumanGates(fullLog),
      );
      expect(pendingGateDisplays(answer.events), `${runId}: pending displays`).toEqual(
        pendingGateDisplays(fullLog),
      );
      expect(decidedGateNodes(answer.events), `${runId}: decided nodes`).toEqual(
        decidedGateNodes(fullLog),
      );
    }
  });
});
