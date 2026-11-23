/**
 * The read behind the History tab's run detail ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, §4, MVP-8 step 4): a run's log is read page by page with the cursor on the store's `scannedThroughSeq`, so a row a newer binary wrote
 * is counted once and never read again; and a run whose terminal is held in the outbox is built as over, so nothing on its page says
 * `in progress`. Every claim runs over a real in-memory `history.db`.
 */
import {
  createClient,
  createRunHistoryReader,
  runEvents,
  runMigrations,
  type DbClient,
  type RunHistoryReader,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedRun } from '../test-support.js';
import {
  RUN_DETAIL_MAX_PAGES,
  createRunDetailLoader,
  pageRunEvents,
  readRunDetail,
  type RunDetailLoad,
  type RunDetailRead,
} from './run-detail-source.js';

const T0 = 1_750_000_000_000;

let client: DbClient;
let reader: RunHistoryReader;
let tailCalls: ReturnType<typeof vi.fn<RunHistoryReader['loadRunEventsAfter']>>;

beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  reader = createRunHistoryReader(client.db);
  tailCalls = vi.fn(reader.loadRunEventsAfter);
});
afterEach(() => {
  client.sqlite.close();
});

/** The reads the detail makes, with the tail wrapped so a test can see where each call started. */
const counted = () => ({ ...reader, loadRunEventsAfter: tailCalls });

const highestSeq = (runId: string): number => {
  const row = client.sqlite
    .prepare('SELECT max(seq) AS seq FROM run_events WHERE run_id = ?')
    .get(runId);
  if (typeof row !== 'object' || row === null || !('seq' in row) || typeof row.seq !== 'number')
    throw new Error('the run has no events');
  return row.seq;
};

/** A row a NEWER binary wrote: an event type this binary has never heard of. */
const insertNewerRow = (runId: string, seq: number): void => {
  client.db
    .insert(runEvents)
    .values({
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      runId,
      seq,
      eventType: 'future:event',
      payloadJson: JSON.stringify({ type: 'future:event', runId, sequenceNumber: seq }),
      ts: 0,
    })
    .run();
};

function ready(load: RunDetailLoad): RunDetailRead {
  if (load.kind !== 'ready') throw new Error(`the detail is ${load.kind}`);
  return load.detail;
}

describe('the log is read page by page, with the cursor on scannedThroughSeq', () => {
  it('moves over a trailing row of a newer type and counts it once: the skipped row is not read again', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-a', state: 'completed', atMs: T0 });
    const last = highestSeq('run-a');
    insertNewerRow('run-a', last + 1);

    const read = ready(readRunDetail({ reader: counted(), runId: 'run-a', terminalHeld: false }));
    expect(read.skippedRows, 'one row, counted once').toBe(1);
    expect(read.eventsComplete).toBe(true);
    expect(read.events).toHaveLength(last + 1);
    // The second call starts at the mark the first one scanned to (the skipped row), not at the last event.
    expect(tailCalls.mock.calls.map(([, afterSeq]) => afterSeq)).toEqual([-1, last + 1]);
  });

  it('pages a log across several calls without reading an event twice, and without losing a skipped row in the middle', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-b', state: 'completed', atMs: T0 });
    const last = highestSeq('run-b');
    insertNewerRow('run-b', last + 1);
    insertNewerRow('run-b', last + 2);

    const paged = pageRunEvents(counted(), 'run-b', { page: 2 });
    expect(paged.complete).toBe(true);
    expect(paged.skipped).toBe(2);
    expect(paged.events.map((event) => event.sequenceNumber)).toEqual(
      Array.from({ length: last + 1 }, (_, seq) => seq),
    );
    // Every call starts where the one before it stopped scanning: strictly increasing, never the same mark twice.
    const starts = tailCalls.mock.calls.map(([, afterSeq]) => afterSeq);
    expect(new Set(starts).size).toBe(starts.length);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(starts.at(-1)).toBe(last + 2);
  });

  it('stops at the page limit and says the log goes on, and says it ended when the limit falls exactly on the end', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-c', state: 'completed', atMs: T0 });
    const total = highestSeq('run-c') + 1;
    const cut = pageRunEvents(counted(), 'run-c', { page: 2, maxPages: 1 });
    expect(cut.events).toHaveLength(2);
    expect(cut.complete, 'more events lie past the page read').toBe(false);
    const exact = pageRunEvents(counted(), 'run-c', { page: total, maxPages: 1 });
    expect(exact.events).toHaveLength(total);
    expect(exact.complete, 'the pages used were exactly the log').toBe(true);
    expect(RUN_DETAIL_MAX_PAGES).toBeGreaterThan(1);

    const read = ready(
      readRunDetail({
        reader: counted(),
        runId: 'run-c',
        terminalHeld: false,
        eventPage: 2,
        maxPages: 1,
      }),
    );
    expect(read.eventsComplete).toBe(false);
  });
});

describe('a run whose terminal is held in the outbox is not in progress', () => {
  /** A run the engine never closed: its row says `running`, and no total was written to it. */
  async function seedLiveRun(runId: string): Promise<void> {
    await seedRun(client.db, { slug: 'wf', runId, state: 'running', atMs: T0 });
    client.sqlite
      .prepare('UPDATE runs SET total_input_tokens = 0, total_output_tokens = 0 WHERE id = ?')
      .run(runId);
  }

  it('says in progress for a run that is running, and never for the same run once its end is held', async () => {
    await seedLiveRun('run-live');
    const running = ready(
      readRunDetail({ reader: reader, runId: 'run-live', terminalHeld: false }),
    );
    expect(running.terminalHeld).toBe(false);
    expect(JSON.stringify(running.model), 'the control: a live run reads in progress').toContain(
      'in progress',
    );

    const held = ready(readRunDetail({ reader: reader, runId: 'run-live', terminalHeld: true }));
    expect(held.terminalHeld).toBe(true);
    expect(held.status, 'its row still says running: the page says held, from the flag').toBe(
      'running',
    );
    expect(JSON.stringify(held.model), 'a held run is over').not.toContain('in progress');
    expect(held.model.header.tokensText).toBe('not recorded');
  });

  it('ignores the flag for a run that is finished: its end is durable, so it is not held', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-done', state: 'completed', atMs: T0 });
    const read = ready(readRunDetail({ reader: reader, runId: 'run-done', terminalHeld: true }));
    expect(read.terminalHeld).toBe(false);
  });

  it('reads the outbox first: a run named there is held, an outbox that cannot be read is said so for an unfinished run only', async () => {
    await seedLiveRun('run-live');
    await seedRun(client.db, { slug: 'wf', runId: 'run-done', state: 'completed', atMs: T0 });
    const held = createRunDetailLoader({
      reader,
      listHeld: () => Promise.resolve([{ runId: 'other' }, { runId: 'run-live' }]),
    });
    expect(ready(await held('run-live')).terminalHeld).toBe(true);
    expect(ready(await held('run-done')).terminalHeld).toBe(false);

    const unreadable = createRunDetailLoader({
      reader,
      listHeld: () => Promise.reject(new Error('no outbox')),
    });
    const live = ready(await unreadable('run-live'));
    expect(live.terminalHeld).toBe(false);
    expect(live.heldUnread, 'it may be held, and the page cannot say').toBe(true);
    expect(ready(await unreadable('run-done')).heldUnread).toBe(false);
  });
});

describe('what a detail can come to', () => {
  it('is missing for a run that is not there, and unreadable for a run whose log is damaged', async () => {
    expect(readRunDetail({ reader, runId: 'nope', terminalHeld: false })).toEqual({
      kind: 'missing',
    });

    await seedRun(client.db, { slug: 'wf', runId: 'run-bad', state: 'completed', atMs: T0 });
    client.db
      .insert(runEvents)
      .values({
        id: '00000000-0000-4000-8000-0000000000b1',
        runId: 'run-bad',
        seq: 900,
        eventType: 'node:started',
        payloadJson: JSON.stringify({ type: 'node:started', nodeId: 42 }),
        ts: 0,
      })
      .run();
    expect(readRunDetail({ reader, runId: 'run-bad', terminalHeld: false })).toEqual({
      kind: 'unreadable',
    });
  });

  it('reads the events of the run it was asked for and no other', async () => {
    await seedRun(client.db, { slug: 'wf', runId: 'run-x', state: 'completed', atMs: T0 });
    await seedRun(client.db, { slug: 'wf', runId: 'run-y', state: 'failed', atMs: T0 + 1 });
    const read = ready(readRunDetail({ reader, runId: 'run-x', terminalHeld: false }));
    expect(read.status).toBe('completed');
    expect(read.events.length).toBe(highestSeq('run-x') + 1);
    expect(read.model.header.runId).toBe('run-x');
  });
});
