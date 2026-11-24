/**
 * `loadRunStateEventsForRuns` over a real SQLite database (ADR-0140 §4 and §10, ADR-0074 §5, ADR-0075): the batched twin of the per-run
 * `loadRunStateEvents`, which `status` and the no-argument `gate list` call over MANY runs. Its contract, and what each test pins:
 *
 * - **A damaged run is that run's problem only.** One corrupt row marks THAT run `{ corrupt: true }`; every other run in the batch is
 *   answered with its own events. (The per-run read throws; the batch isolates it, so a listing names the run it cannot read and still
 *   lists the rest: `readPerRunOrDegrade`'s reason, taken to the statement.)
 * - **A streaming row is validated BEFORE it is excluded.** The state read leaves `agent:token`-style rows out of its answer, but a
 *   damaged one must still be seen as damage: filtering by the SQL discriminator first would hide a corrupt row behind a type name.
 * - **A type this binary does not know is skipped, never corrupt.** A newer binary wrote it (ADR-0074 §5): the run keeps the events it
 *   can read, and the neighbours are untouched.
 * - **One statement, on the `(run_id, seq)` index.** The batch is a single `IN` lookup ordered by `(run_id, seq)`; the plan is read from
 *   the statement the reader really prepares, not from a copy of its text.
 */
import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  CorruptRunEventError,
  createRunHistoryReader,
  createRunHistoryStore,
  type RunHistoryReader,
  type RunHistoryStore,
} from './run-history-store.js';
import { runEvents } from './schema.js';

const TS_MS = Date.parse('2026-11-24T10:00:00.000Z');
const TS = new Date(TS_MS).toISOString();

let client: DbClient;
let reader: RunHistoryReader;
let store: RunHistoryStore;
let next = 0;

beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  reader = createRunHistoryReader(client.db);
  next = 0;
  store = createRunHistoryStore(client.db, {
    uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    now: () => TS_MS,
    workflow: {
      slug: 'wf',
      name: 'wf',
      definitionJson: JSON.stringify({ workflow: { id: 'wf', name: 'wf', nodes: [], edges: [] } }),
    },
  });
});
afterEach(() => {
  client.sqlite.close();
});

const event = (runId: string, seq: number, fields: Record<string, unknown>): RunEvent =>
  RunEventSchema.parse({ runId, timestamp: TS, sequenceNumber: seq, ...fields });

/** One run with `run:started` then one node start: two readable state events. */
async function seed(runId: string): Promise<void> {
  const workflowId = await store.resolveWorkflowId('wf');
  await store.persistEvent(
    event(runId, 0, { type: 'run:started', workflowId, inputs: {}, executionMode: 'local' }),
  );
  await store.persistEvent(
    event(runId, 1, { type: 'node:started', nodeId: 'n1', nodeType: 'agent' }),
  );
}

/** A row put straight into `run_events`: `persistEvent` validates on the way in, and the point here is what a damaged or newer file holds. */
let rawId = 9_000;
function insertRaw(runId: string, seq: number, eventType: string, payloadJson: string): void {
  rawId += 1;
  client.db
    .insert(runEvents)
    .values({
      id: `00000000-0000-4000-8000-${String(rawId).padStart(12, '0')}`,
      runId,
      seq,
      eventType,
      payloadJson,
      ts: TS_MS,
    })
    .run();
}

const typesOf = (answer: ReturnType<RunHistoryReader['loadRunStateEventsForRuns']>, id: string) => {
  const read = answer.get(id);
  if (read === undefined || 'corrupt' in read) return read;
  return read.events.map((e) => e.type);
};

describe('loadRunStateEventsForRuns over real rows: a damaged run is that run only', () => {
  it('answers a corrupt run A as `corrupt` and a healthy run B with its own events', async () => {
    await seed('run-a');
    await seed('run-b');
    // A known type with a body that cannot be one: damage, not forward evolution.
    insertRaw(
      'run-a',
      2,
      'node:started',
      JSON.stringify({
        type: 'node:started',
        runId: 'run-a',
        sequenceNumber: 2,
        timestamp: TS,
        nodeId: '',
        nodeType: 'agent',
      }),
    );
    const answer = reader.loadRunStateEventsForRuns(['run-a', 'run-b']);
    expect(answer.get('run-a')).toEqual({ corrupt: true });
    expect(typesOf(answer, 'run-b')).toEqual(['run:started', 'node:started']);
    // The per-run read of the same row throws: the batch is its isolating twin, not a laxer reader.
    expect(() => reader.loadRunStateEvents('run-a')).toThrow(CorruptRunEventError);
    expect(reader.loadRunStateEvents('run-b').map((e) => e.type)).toEqual([
      'run:started',
      'node:started',
    ]);
  });

  it('unreadable JSON marks only its own run, wherever its row sits in the batch', async () => {
    await seed('run-a');
    await seed('run-b');
    await seed('run-c');
    insertRaw('run-b', 2, 'node:started', '{ not json');
    const answer = reader.loadRunStateEventsForRuns(['run-a', 'run-b', 'run-c']);
    expect(typesOf(answer, 'run-a')).toEqual(['run:started', 'node:started']);
    expect(answer.get('run-b')).toEqual({ corrupt: true });
    expect(typesOf(answer, 'run-c')).toEqual(['run:started', 'node:started']);
  });

  it('a corrupt row followed by readable rows of the same run keeps the run corrupt (nothing is read past it)', async () => {
    await seed('run-a');
    insertRaw('run-a', 2, 'node:started', '{ not json');
    // A readable row AFTER the damaged one, in the same run.
    insertRaw(
      'run-a',
      3,
      'node:completed',
      JSON.stringify({
        type: 'node:completed',
        runId: 'run-a',
        sequenceNumber: 3,
        timestamp: TS,
        nodeId: 'n1',
        output: 'ok',
        tokensUsed: { input: 1, output: 1 },
        durationMs: 5,
      }),
    );
    expect(reader.loadRunStateEventsForRuns(['run-a']).get('run-a')).toEqual({ corrupt: true });
  });
});

describe('loadRunStateEventsForRuns over real rows: a streaming row is validated before it is left out', () => {
  const STREAMING = 'agent:token';

  it('leaves out a WELL-FORMED streaming row, and the run is still healthy', async () => {
    await seed('run-s');
    insertRaw(
      'run-s',
      2,
      STREAMING,
      JSON.stringify({
        type: STREAMING,
        runId: 'run-s',
        sequenceNumber: 2,
        timestamp: TS,
        nodeId: 'n1',
        token: 'hi',
        model: 'm',
      }),
    );
    const answer = reader.loadRunStateEventsForRuns(['run-s']);
    expect(typesOf(answer, 'run-s'), 'the state read has no streaming event').toEqual([
      'run:started',
      'node:started',
    ]);
  });

  it('a DAMAGED streaming row makes its run corrupt: it is not hidden behind its type name', async () => {
    await seed('run-s');
    await seed('run-ok');
    // The column says a streaming type, the body is not that event: a filter on the column first would have skipped it unread.
    insertRaw('run-s', 2, STREAMING, JSON.stringify({ type: STREAMING, runId: 'run-s' }));
    const answer = reader.loadRunStateEventsForRuns(['run-s', 'run-ok']);
    expect(answer.get('run-s')).toEqual({ corrupt: true });
    expect(typesOf(answer, 'run-ok')).toEqual(['run:started', 'node:started']);
    expect(() => reader.loadRunStateEvents('run-s')).toThrow(CorruptRunEventError);
  });

  it('a streaming row whose column and body disagree on the type is damage too', async () => {
    await seed('run-s');
    insertRaw(
      'run-s',
      2,
      STREAMING,
      JSON.stringify({
        type: 'node:started',
        runId: 'run-s',
        sequenceNumber: 2,
        timestamp: TS,
        nodeId: 'n1',
        nodeType: 'agent',
      }),
    );
    expect(reader.loadRunStateEventsForRuns(['run-s']).get('run-s')).toEqual({ corrupt: true });
  });
});

describe('loadRunStateEventsForRuns over real rows: a type this binary does not know is skipped, never corrupt', () => {
  it('keeps every readable event of the run, in order, and leaves the neighbour alone', async () => {
    await seed('run-n');
    await seed('run-other');
    // A newer binary's row in the MIDDLE of the log, and another as its TAIL.
    insertRaw('run-n', 2, 'future:something', JSON.stringify({ type: 'future:something' }));
    insertRaw(
      'run-n',
      3,
      'node:completed',
      JSON.stringify({
        type: 'node:completed',
        runId: 'run-n',
        sequenceNumber: 3,
        timestamp: TS,
        nodeId: 'n1',
        output: 'ok',
        tokensUsed: { input: 1, output: 1 },
        durationMs: 5,
      }),
    );
    insertRaw('run-n', 4, 'future:tail', JSON.stringify({ type: 'future:tail' }));
    const answer = reader.loadRunStateEventsForRuns(['run-n', 'run-other']);
    expect(typesOf(answer, 'run-n')).toEqual(['run:started', 'node:started', 'node:completed']);
    expect(typesOf(answer, 'run-other')).toEqual(['run:started', 'node:started']);
  });
});

describe('loadRunStateEventsForRuns: the one statement is a lookup on `idx_run_events_run_seq`', () => {
  /** Every statement text the connection prepares while `act` runs. */
  function preparedWhile(act: () => void): string[] {
    const seen: string[] = [];
    const real = client.sqlite.prepare.bind(client.sqlite);
    // The connection's own `prepare` is wrapped for the duration of one call and put back; nothing else is changed.
    Object.assign(client.sqlite, {
      prepare: (source: string) => {
        seen.push(source);
        return real(source);
      },
    });
    try {
      act();
    } finally {
      Object.assign(client.sqlite, { prepare: real });
    }
    return seen;
  }

  it('prepares one statement over `run_events` for a batch, and its plan searches the (run_id, seq) index without a sort', async () => {
    await seed('run-a');
    await seed('run-b');
    const statements = preparedWhile(() => {
      reader.loadRunStateEventsForRuns(['run-a', 'run-b']);
    }).filter((source) => /from\s+"run_events"/iu.test(source));
    expect(statements, 'one statement for the whole batch').toHaveLength(1);
    const [statement] = statements;
    if (statement === undefined) throw new Error('no statement was prepared');
    const plan = client.sqlite.prepare(`EXPLAIN QUERY PLAN ${statement}`).all('run-a', 'run-b') as {
      detail: string;
    }[];
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toMatch(/idx_run_events_run_seq/u);
    expect(details, 'the index order is the order: no temporary sort').not.toMatch(
      /USE TEMP B-TREE/u,
    );
    expect(details, 'never a table scan').not.toMatch(/\bSCAN run_events\b/u);
  });

  it('prepares nothing for an empty batch', () => {
    const statements = preparedWhile(() => {
      expect(reader.loadRunStateEventsForRuns([]).size).toBe(0);
    });
    expect(statements.filter((source) => /run_events/iu.test(source))).toEqual([]);
  });
});
