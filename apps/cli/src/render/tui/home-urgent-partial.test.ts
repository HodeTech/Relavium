/**
 * Page 1 does not claim the most urgent item when it cannot know (MVP-11 unit 7, round 2: correctness F1). The Home reads the newest eight paused
 * runs: a gate's deadline is in its run's log, one read each, and the OLDEST paused runs are the likeliest to have expired. So the first item of
 * the Attention order is the most urgent of the ones READ, and the most urgent of all only when every paused run was read. Where that is not so
 * (more attention items wait than were read, and eight paused runs were) the head leads with the count of everything that needs the person
 * and names the item after it as one of them (`↓ 10 need you · harness-gate needs approval`); where it is so, nothing changes
 * (`↓ release-notes needs approval · expires in 5m · +9 more`). The decision is made from counts the Home already holds: no read is added.
 *
 * The report's case: ten paused runs, the oldest expired, the head named the newest and never the expired one. Over a real `history.db`.
 */
import {
  createClient,
  createRunHistoryReader,
  createSessionStore,
  runMigrations,
  type DbClient,
  type RunHistoryReader,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildHomeSnapshot,
  type HomeRunRow,
  type HomeUnreadableRun,
} from '../../home/home-store.js';
import { seedRun } from '../../test-support.js';
import {
  attentionIsPartial,
  attentionOrder,
  PARKED_RUNS_MAX,
  readParkedRuns,
  urgentHeadOf,
  type AttentionItem,
  type ParkedRunRow,
} from './home-attention.js';
import { landingHint } from './home-pages.js';
import { displayWidth } from './viewport.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const HERE = '/work/here';

const parkedRow = (n: number, over: Partial<ParkedRunRow> = {}): ParkedRunRow => ({
  runId: `run-${String(n).padStart(3, '0')}`,
  kind: 'approval',
  gates: 1,
  workflow: `wf-${String(n)}`,
  ...over,
});
const failedRow = (n: number): HomeRunRow => ({
  runId: `fail-${String(n).padStart(3, '0')}`,
  workflowSlug: 'nightly',
  status: 'failed',
  createdAt: new Date(NOW - n * 60_000).toISOString(),
  startedAt: undefined,
  completedAt: new Date(NOW - n * 60_000).toISOString(),
  totalCostMicrocents: 0,
});
const unreadable = (n: number, status?: HomeUnreadableRun['status']): HomeUnreadableRun => ({
  runId: `bad-${String(n).padStart(3, '0')}`,
  reason: 'corrupt-row',
  createdAt: new Date(NOW - n * 60_000).toISOString(),
  ...(status === undefined ? {} : { status }),
});

/** The items of an Attention list: `parked` rows, `failed` rows and `broken` runs, in the one urgency order. */
function itemsOf(
  parked: readonly ParkedRunRow[],
  failed: readonly HomeRunRow[] = [],
  broken: readonly HomeUnreadableRun[] = [],
): readonly AttentionItem[] {
  return attentionOrder(parked, { attention: { failedRuns: failed }, unreadableRuns: broken }, NOW);
}
const many = (count: number, make: (n: number) => ParkedRunRow): ParkedRunRow[] =>
  Array.from({ length: count }, (_, n) => make(n));

describe('attentionIsPartial: when unread items may outrank the first', () => {
  it('every paused run was read, whatever else waits: no doubt', () => {
    expect(attentionIsPartial(itemsOf(many(3, parkedRow)), 3)).toBe(false);
    expect(attentionIsPartial(itemsOf(many(PARKED_RUNS_MAX - 1, parkedRow)), 40)).toBe(false);
  });

  it('eight paused runs were read and more items wait: the first is the most urgent of those read', () => {
    expect(attentionIsPartial(itemsOf(many(PARKED_RUNS_MAX, parkedRow)), PARKED_RUNS_MAX + 2)).toBe(
      true,
    );
  });

  it('eight paused runs and nothing else waiting: all were read, so no doubt', () => {
    expect(attentionIsPartial(itemsOf(many(PARKED_RUNS_MAX, parkedRow)), PARKED_RUNS_MAX)).toBe(
      false,
    );
  });

  it('an unreadable PAUSED run counts toward the eight, one of another status does not, one of an unknown status does (the doubt errs toward saying so)', () => {
    const five = many(5, parkedRow);
    const total = 12;
    expect(attentionIsPartial(itemsOf(five, [], [unreadable(1, 'paused'), unreadable(2, 'paused'), unreadable(3, 'paused')]), total)).toBe(true);
    expect(attentionIsPartial(itemsOf(five, [], [unreadable(1, 'completed'), unreadable(2, 'completed'), unreadable(3, 'completed')]), total)).toBe(false);
    expect(attentionIsPartial(itemsOf(five, [], [unreadable(1), unreadable(2), unreadable(3)]), total)).toBe(true);
  }); // prettier-ignore

  it('many FAILED runs are no doubt: the failed rows are newest first and rank after every parked run, so the first is the most urgent of them all', () => {
    const failed = Array.from({ length: 8 }, (_, n) => failedRow(n));
    expect(attentionIsPartial(itemsOf(many(2, parkedRow), failed), 2 + 20)).toBe(false);
    expect(attentionIsPartial(itemsOf([], failed), 20)).toBe(false);
  });
});

describe('the head, for the report’s case: ten paused runs, the oldest expired', () => {
  // The Home reads the newest eight; the oldest (the ninth and tenth) are never read, and the oldest of all has an expired gate.
  const readEight = many(PARKED_RUNS_MAX, parkedRow);
  const items = itemsOf(readEight);

  it('says the count of everything first, and names the item read after it: no `+N more`, no claim to be the most urgent', () => {
    const head = urgentHeadOf(items, 10, NOW);
    expect(head?.partial).toBe(true);
    const text = landingHint(
      {
        interruptArmed: false,
        draft: { text: '', cursor: 0 },
        keyless: false,
        runCanBeShown: false,
        counts: { attention: 10, sessions: 0, runs: 0 },
        urgent: head,
        columns: 120,
      },
      displayWidth,
    ).text;
    expect(text).toBe(
      '[/] commands · ↓ 10 need you · wf-0 needs approval · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    expect(text).not.toMatch(/\+\d+ more/u);
  });

  it('a Home whose paused runs were all read keeps the maintainer’s head: the item, then the others', () => {
    const head = urgentHeadOf(itemsOf(many(3, parkedRow)), 3, NOW);
    expect(head?.partial).toBe(false);
    const text = landingHint(
      {
        interruptArmed: false,
        draft: { text: '', cursor: 0 },
        keyless: false,
        runCanBeShown: false,
        counts: { attention: 3, sessions: 0, runs: 0 },
        urgent: head,
        columns: 120,
      },
      displayWidth,
    ).text;
    expect(text).toBe(
      '[/] commands · ↓ wf-0 needs approval · +2 more need you · Tab fill the example · [Ctrl+C] exit (twice)',
    );
  });

  it('is the named item of an unreadable run too (it has no name: its words say it), and none without items', () => {
    expect(urgentHeadOf([], 0, NOW)).toBeUndefined();
    const head = urgentHeadOf(itemsOf([], [], [unreadable(1, 'paused')]), 1, NOW);
    expect(head).toMatchObject({ name: undefined, words: 'a run cannot be read', partial: false });
  });
});

describe('over a real history.db: ten paused runs, the Home reads eight', () => {
  let client: DbClient;
  let reader: RunHistoryReader;
  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    reader = createRunHistoryReader(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
  });

  async function parkMany(count: number): Promise<void> {
    for (let n = 0; n < count; n += 1) {
      const runId = `run-${String(n).padStart(3, '0')}`;
      await seedRun(client.db, {
        slug: 'wf',
        runId,
        state: 'paused',
        atMs: NOW - 10 * 86_400_000 + n * 1_000,
        gates: [{ gateId: `g-${runId}`, gateType: 'approval' }],
      });
      client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(HERE, runId);
    }
  }
  const snapshotOf = () =>
    buildHomeSnapshot({
      sessions: createSessionStore(client.db),
      runs: reader,
      projectRoot: HERE,
      workingDir: HERE,
      now: () => NOW,
    });

  it('the true count is ten, eight rows were read (and no log beyond them), and the head is partial', async () => {
    await parkMany(10);
    const snapshot = snapshotOf();
    const rows = readParkedRuns(reader, HERE);
    expect(snapshot.totals.attention).toBe(10);
    expect(rows).toHaveLength(PARKED_RUNS_MAX);
    // the newest eight, never the two oldest (the oldest is the likeliest to have expired)
    expect(rows.map((row) => row.runId)).not.toContain('run-000');
    const head = urgentHeadOf(attentionOrder(rows, snapshot, NOW), snapshot.totals.attention, NOW);
    expect(head?.partial).toBe(true);
  });

  it.each([
    [7, false],
    [8, false],
    [9, true],
  ] as const)('%i paused runs: the head is partial = %s', async (count, partial) => {
    await parkMany(count);
    const snapshot = snapshotOf();
    const rows = readParkedRuns(reader, HERE);
    const head = urgentHeadOf(attentionOrder(rows, snapshot, NOW), snapshot.totals.attention, NOW);
    expect(head?.partial).toBe(partial);
  });
});
