/**
 * The TIME a parked run's row carries (MVP-11 unit 7, round 2: observation F2): a row with no deadline said nothing of time, so eight runs of one
 * workflow were told apart by their ids alone and a gate that had waited two days read like a five-minute one. The row now says how long the
 * run has waited (`‖ review-docs · review · waiting 2h · b1cf9111`) in the slot a deadline takes when it has one; a deadline stays the more urgent
 * fact and wins the slot. The time comes from the run's own record (`RunGates.parkedSince`: the summary the read already holds, no read of
 * the log of its own), and takes no part in the Attention order. The words come from `waitingLabel` and `compactExpiryLabel`.
 */
import {
  createClient,
  createRunHistoryReader,
  runMigrations,
  type DbClient,
  type RunHistoryReader,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunGates } from '../../home/run-gates.js';
import { readProjectRunGates } from '../../home/run-gates.js';
import { seedRun } from '../../test-support.js';
import {
  attentionOrder,
  parkedRunLabel,
  parkedRunRows,
  readParkedRuns,
  type ParkedRunRow,
} from './home-attention.js';
import { compactExpiryLabel, expiryLabel, waitingLabel } from './home-projection.js';
import { displayWidth } from './viewport.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const AT_80 = 80 - 6 - 4;
const AT_100 = 100 - 8 - 4;
const UUID = 'b1cf9111-9d41-4c6e-8a07-5e2d1c9b7f64';

describe('waitingLabel: how long a run has waited', () => {
  it.each([
    [0, 'waiting <1m'],
    [59_999, 'waiting <1m'],
    [MINUTE, 'waiting 1m'],
    [5 * MINUTE, 'waiting 5m'],
    [HOUR - 1, 'waiting 59m'],
    [HOUR, 'waiting 1h'],
    [2 * HOUR + 59 * MINUTE, 'waiting 2h'],
    [DAY, 'waiting 1d'],
    [3 * DAY + HOUR, 'waiting 3d'],
  ])('%i ms ago reads `%s`', (agoMs, words) => {
    expect(waitingLabel(iso(-agoMs), NOW)).toBe(words);
  });

  it('claims nothing for a time that is not there, one that does not parse, or one more than a minute ahead of the clock', () => {
    expect(waitingLabel(undefined, NOW)).toBeUndefined();
    expect(waitingLabel('soon', NOW)).toBeUndefined();
    expect(waitingLabel('', NOW)).toBeUndefined();
    expect(waitingLabel(iso(2 * MINUTE), NOW)).toBeUndefined();
    // a clock a few seconds behind the log is still "just parked", never a negative wait
    expect(waitingLabel(iso(30_000), NOW)).toBe('waiting <1m');
  });

  it('says days up to a year, and from a year on one closed word: a hand-edited 1970 `updated_at` is `waiting 1y+`, never `waiting 20783d` (round 2 sitting #2)', () => {
    expect(waitingLabel(iso(-364 * DAY), NOW)).toBe('waiting 364d');
    expect(waitingLabel(iso(-(365 * DAY - 1)), NOW)).toBe('waiting 364d');
    expect(waitingLabel(iso(-365 * DAY), NOW)).toBe('waiting 1y+');
    expect(waitingLabel('1970-01-01T00:00:00.000Z', NOW)).toBe('waiting 1y+');
    expect(waitingLabel('0001-01-01T00:00:00.000Z', NOW)).toBe('waiting 1y+');
    // the widest the words can be: a row's budget for this field is fixed
    expect(displayWidth('waiting 364d')).toBe(12);
  });
});

describe('compactExpiryLabel: the same deadline in fewer columns', () => {
  it.each([
    [30_000, 'expires in 30s', '30s left'],
    [5 * MINUTE, 'expires in 5m', '5m left'],
    [HOUR, 'expires in 1h', '1h left'],
    [3 * DAY, 'expires in 3d', '3d left'],
  ])('%i ms ahead: `%s` is `%s`', (aheadMs, long, compact) => {
    expect(expiryLabel(iso(aheadMs), NOW)).toBe(long);
    expect(compactExpiryLabel(iso(aheadMs), NOW)).toBe(compact);
  });

  it('`expired` is its own compact form, and nothing says nothing', () => {
    expect(compactExpiryLabel(iso(-1), NOW)).toBe('expired');
    expect(compactExpiryLabel(iso(0), NOW)).toBe('expired');
    expect(compactExpiryLabel(undefined, NOW)).toBeUndefined();
    expect(compactExpiryLabel('later', NOW)).toBeUndefined();
  });

  it('is the long form with `expires in X` read as `X left` at every moment (same clock, same rounding)', () => {
    for (let aheadMs = 1; aheadMs < 5 * DAY; aheadMs += 7 * MINUTE + 13_001) {
      const long = expiryLabel(iso(aheadMs), NOW) ?? '';
      expect(compactExpiryLabel(iso(aheadMs), NOW), String(aheadMs)).toBe(
        `${long.replace('expires in ', '')} left`,
      );
    }
  });
});

describe('the parked row says its time', () => {
  const row = (over: Partial<ParkedRunRow> = {}): ParkedRunRow => ({
    runId: UUID,
    kind: 'review',
    gates: 1,
    workflow: 'review-docs',
    parkedSince: iso(-2 * HOUR),
    ...over,
  });

  it('with no deadline it is the time the run has waited, before its id: `‖ review-docs · review · waiting 2h · b1cf9111`', () => {
    expect(parkedRunLabel(row(), AT_80, NOW)).toBe(
      '‖ review-docs · review · waiting 2h · b1cf9111',
    );
  });

  it('a deadline is the more urgent fact and wins the slot, `expired` too', () => {
    expect(parkedRunLabel(row({ expiresAt: iso(5 * MINUTE) }), AT_80, NOW)).toBe(
      '‖ review-docs · review · expires in 5m · b1cf9111',
    );
    expect(parkedRunLabel(row({ expiresAt: iso(-MINUTE) }), AT_80, NOW)).toBe(
      '‖ review-docs · review · expired · b1cf9111',
    );
  });

  it('a deadline that does not parse is no deadline: the row says how long it has waited', () => {
    expect(parkedRunLabel(row({ expiresAt: 'whenever' }), AT_80, NOW)).toBe(
      '‖ review-docs · review · waiting 2h · b1cf9111',
    );
  });

  it('no clock, no time word; no time of its own, no word either (the slot is empty, not a placeholder)', () => {
    expect(parkedRunLabel(row(), AT_80)).toBe('‖ review-docs · review · b1cf9111');
    expect(parkedRunLabel(row({ parkedSince: undefined }), AT_80, NOW)).toBe(
      '‖ review-docs · review · b1cf9111',
    );
  });

  it('eight identical runs are told apart by how long each has waited, not by the id alone', () => {
    const rows = [5, 30, 90, 180, 600, 1_500, 2_880, 5_000].map((minutes) =>
      parkedRunLabel(
        row({
          runId: `${String(minutes).padStart(8, '0')}-0000`,
          parkedSince: iso(-minutes * MINUTE),
        }),
        AT_80,
        NOW,
      ),
    );
    expect(new Set(rows.map((text) => /waiting \S+/u.exec(text)?.[0])).size).toBe(8);
  });

  describe('a narrow row gives it up after the workflow’s tail and before its id, at 80 and at 100 columns', () => {
    const long = row({ workflow: 'nightly-release-pipeline-for-the-eu-region' });

    it('at 80 columns (70 for the row)', () => {
      // the name is bounded to 40 columns however wide the row, and keeps what the rest leaves it: the time and the id both fit
      expect(parkedRunLabel(long, AT_80, NOW)).toBe(
        '‖ nightly-release-pipeline-for-the-e… · review · waiting 2h · b1cf9111',
      );
      // narrower: the name's tail goes first, down to its floor of 12 columns...
      expect(parkedRunLabel(long, 47, NOW)).toBe('‖ nightly-rel… · review · waiting 2h · b1cf9111');
      // ...then the time goes (and the name has its room back), then the id, then the name below its floor; the kind never
      expect(parkedRunLabel(long, 46, NOW)).toBe('‖ nightly-release-pipelin… · review · b1cf9111');
      expect(parkedRunLabel(long, 34, NOW)).toBe('‖ nightly-rel… · review · b1cf9111');
      expect(parkedRunLabel(long, 33, NOW)).toBe('‖ nightly-release-pipel… · review');
      expect(parkedRunLabel(long, 12, NOW)).toBe('‖ review');
    });

    it('at 100 columns (88 for the row) the whole row is there, the name bounded', () => {
      expect(parkedRunLabel(long, AT_100, NOW)).toBe(
        '‖ nightly-release-pipeline-for-the-eu-reg… · review · waiting 2h · b1cf9111',
      );
    });

    it('never wider than its columns, the kind always there, and the id the last word whenever it is there at all', () => {
      for (let columns = 12; columns <= 120; columns += 1) {
        const label = parkedRunLabel(long, columns, NOW);
        expect(displayWidth(label), String(columns)).toBeLessThanOrEqual(columns);
        expect(label, String(columns)).toContain('review');
        if (label.includes('b1cf9111'))
          expect(label.endsWith('b1cf9111'), String(columns)).toBe(true);
        // the time never outlives the id: when the id is gone the time is gone with it
        if (label.includes('waiting')) expect(label, String(columns)).toContain('b1cf9111');
      }
    });
  });
});

describe('the time comes from the run’s own record, with no read of the log of its own', () => {
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
  const HERE = '/work/here';
  const T0 = Date.parse('2026-11-26T09:00:00.000Z');

  async function park(runId: string, atMs: number): Promise<void> {
    await seedRun(client.db, {
      slug: 'wf',
      runId,
      state: 'paused',
      atMs,
      gates: [{ gateId: `g-${runId}`, gateType: 'review' }],
    });
    client.sqlite.prepare('UPDATE runs SET project_root = ? WHERE id = ?').run(HERE, runId);
  }

  it('the run the read returns names when it parked: the run record’s update time, an ISO text', async () => {
    await park('run-a', T0);
    const [run] = readProjectRunGates(reader, HERE).runs;
    expect(run?.parkedSince).toBe(new Date(T0).toISOString());
    const [parked] = readParkedRuns(reader, HERE);
    expect(parked?.parkedSince).toBe(new Date(T0).toISOString());
    expect(parkedRunLabel(parked as ParkedRunRow, AT_80, T0 + 3 * HOUR + 5)).toContain(
      'waiting 3h',
    );
  });

  it('is the one read the gates already make: the summary list and one log read per run, nothing more', async () => {
    await park('run-a', T0);
    await park('run-b', T0 + 1);
    const calls = { summaries: 0, logs: 0, details: 0 };
    const counting = {
      listRunSummaries: (...args: Parameters<RunHistoryReader['listRunSummaries']>) => {
        calls.summaries += 1;
        return reader.listRunSummaries(...args);
      },
      loadRunStateEvents: (runId: string) => {
        calls.logs += 1;
        return reader.loadRunStateEvents(runId);
      },
      loadRunDetail: (runId: string) => {
        calls.details += 1;
        return reader.loadRunDetail(runId);
      },
    };
    const rows = parkedRunRows(readProjectRunGates(counting, HERE, { maxRuns: 8 }));
    expect(rows.map((parked) => parked.parkedSince)).toEqual([
      new Date(T0 + 1).toISOString(),
      new Date(T0).toISOString(),
    ]);
    expect(calls).toEqual({ summaries: 1, logs: 2, details: 0 });
  });

  it('a run record with no time leaves the field out (a stand-in read, a reader that returns none)', () => {
    const bare: RunGates = {
      runId: 'r',
      workflowId: 'w',
      gates: [],
      budgetGates: [],
      degraded: false,
    };
    const [row] = parkedRunRows({ runs: [bare], degradedRunIds: [], truncated: false });
    expect(row).toEqual({ runId: 'r', kind: 'none', gates: 0 });
    expect(row !== undefined && 'parkedSince' in row).toBe(false);
  });
});

describe('the time takes no part in the Attention order', () => {
  const snapshot = { attention: { failedRuns: [] }, unreadableRuns: [] } as const;
  const parked = (
    runId: string,
    since: string,
    over: Partial<ParkedRunRow> = {},
  ): ParkedRunRow => ({
    runId,
    kind: 'approval',
    gates: 1,
    parkedSince: since,
    ...over,
  });

  it('parked runs with no deadline keep the read’s order (newest first) whatever each has waited', () => {
    const rows = [parked('c', iso(-MINUTE)), parked('b', iso(-3 * DAY)), parked('a', iso(-HOUR))];
    expect(attentionOrder(rows, snapshot, NOW).map((item) => item.runId)).toEqual(['c', 'b', 'a']);
  });

  it('a deadline still ranks before waiting, and the sooner deadline first, however long each has waited', () => {
    const rows = [
      parked('open', iso(-9 * DAY)),
      parked('late', iso(-MINUTE), { expiresAt: iso(2 * HOUR) }),
      parked('soon', iso(-8 * DAY), { expiresAt: iso(10 * MINUTE) }),
    ];
    expect(attentionOrder(rows, snapshot, NOW).map((item) => item.runId)).toEqual([
      'soon',
      'late',
      'open',
    ]);
  });
});
