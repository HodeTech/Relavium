/**
 * The Attention order (MVP-11 unit 7, the maintainer's ruling 3: Attention by urgency): ONE pure function merges the parked rows, the
 * failed runs and the runs whose log cannot be read into one list, and the work page's rows, the `↑/↓` walk and page 1's "most urgent" all
 * read it. Expired deadlines first (the longest overdue first), then the soonest deadline, then the parked runs with no deadline (newest
 * first, the read's order), then the failed runs newest first, then the unreadable runs. A tie breaks on the run id, so the order is total
 * and the same on every refresh, and a run is ONE item whatever lists it is in.
 */
import { describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSnapshot, HomeUnreadableRun } from '../../home/home-store.js';
import { attentionOrder, type ParkedRunRow } from './home-attention.js';
import { stripRows } from './strip-focus.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const parked = (runId: string, expiresAt?: string): ParkedRunRow => ({
  runId,
  kind: 'approval',
  gates: 1,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const failed = (runId: string, createdAt: string): HomeRunRow => ({
  runId,
  workflowSlug: 'wf',
  status: 'failed',
  createdAt,
  startedAt: undefined,
  completedAt: undefined,
  totalCostMicrocents: 0,
});
const unreadable = (runId: string, createdAt?: string): HomeUnreadableRun => ({
  runId,
  reason: 'corrupt-row',
  ...(createdAt === undefined ? {} : { createdAt }),
});
const snapshot = (over: Partial<HomeSnapshot>): HomeSnapshot => ({
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: false,
  ...over,
});

const ids = (items: readonly { readonly runId: string }[]): string[] =>
  items.map((item) => item.runId);

describe('attentionOrder: urgency first, a total order', () => {
  it('puts expired deadlines first (the longest overdue first), then the soonest deadline, then no deadline, then failed, then unreadable', () => {
    const order = attentionOrder(
      [
        parked('p-none-new'),
        parked('p-soon', at(5)),
        parked('p-late', at(120)),
        parked('p-expired-long', at(-90)),
        parked('p-none-old'),
        parked('p-expired-short', at(-1)),
      ],
      snapshot({
        attention: { failedRuns: [failed('f-old', at(-600)), failed('f-new', at(-60))] },
        unreadableRuns: [unreadable('u-1', at(-30)), unreadable('u-2', at(-700))],
      }),
      NOW,
    );
    expect(ids(order)).toEqual([
      'p-expired-long',
      'p-expired-short',
      'p-soon',
      'p-late',
      'p-none-new',
      'p-none-old',
      'f-new',
      'f-old',
      'u-1',
      'u-2',
    ]);
    expect(order.map((item) => item.kind)).toEqual([
      'parked',
      'parked',
      'parked',
      'parked',
      'parked',
      'parked',
      'failed',
      'failed',
      'unreadable',
      'unreadable',
    ]);
  });

  it('marks an item overdue only once its deadline has passed at the clock given, and never without a clock', () => {
    const rows = [parked('late', at(-1)), parked('fresh', at(1)), parked('none')];
    const withClock = attentionOrder(rows, snapshot({}), NOW);
    expect(withClock.map((item) => [item.runId, item.overdue])).toEqual([
      ['late', true],
      ['fresh', false],
      ['none', false],
    ]);
    expect(attentionOrder(rows, snapshot({})).every((item) => !item.overdue)).toBe(true);
    expect(withClock[0]?.deadlineMs).toBe(Date.parse(at(-1)));
    expect(withClock[2]?.deadlineMs).toBeUndefined();
  });

  it('breaks a tie on the run id, so two refreshes that hand the rows back in another order give the same list', () => {
    const same = at(10);
    const a = attentionOrder(
      [parked('p-b', same), parked('p-a', same)],
      snapshot({
        attention: { failedRuns: [failed('f-b', at(-5)), failed('f-a', at(-5))] },
        unreadableRuns: [unreadable('u-b', at(-5)), unreadable('u-a', at(-5))],
      }),
    );
    const b = attentionOrder(
      [parked('p-a', same), parked('p-b', same)],
      snapshot({
        attention: { failedRuns: [failed('f-a', at(-5)), failed('f-b', at(-5))] },
        unreadableRuns: [unreadable('u-a', at(-5)), unreadable('u-b', at(-5))],
      }),
    );
    expect(ids(a)).toEqual(['p-a', 'p-b', 'f-a', 'f-b', 'u-a', 'u-b']);
    expect(ids(b)).toEqual(ids(a));
  });

  it('keeps the read order of the parked runs with no deadline (the read is newest first): their position is their age', () => {
    expect(ids(attentionOrder([parked('z'), parked('a'), parked('m')], snapshot({})))).toEqual([
      'z',
      'a',
      'm',
    ]);
  });

  it('a deadline that does not parse is no deadline, and a creation time that does not parse sorts last among its kind', () => {
    const order = attentionOrder(
      [parked('p-bad', 'soon'), parked('p-due', at(3))],
      snapshot({
        attention: { failedRuns: [failed('f-bad', 'yesterday'), failed('f-ok', at(-9))] },
        unreadableRuns: [unreadable('u-none'), unreadable('u-ok', at(-9))],
      }),
      NOW,
    );
    expect(ids(order)).toEqual(['p-due', 'p-bad', 'f-ok', 'f-bad', 'u-ok', 'u-none']);
  });

  it('lists a run once: an unreadable run is one unreadable item, never also a parked or failed item; a parked run is never also failed', () => {
    const order = attentionOrder(
      [parked('both'), parked('broken')],
      snapshot({
        attention: { failedRuns: [failed('both', at(-1)), failed('broken', at(-1))] },
        unreadableRuns: [unreadable('broken', at(-1))],
      }),
    );
    expect(order.map((item) => `${item.kind}:${item.runId}`)).toEqual([
      'parked:both',
      'unreadable:broken',
    ]);
  });

  it('carries what a row and page 1 need: the workflow by kind, and the source row', () => {
    const order = attentionOrder(
      [{ ...parked('p'), workflow: 'release-notes' }],
      snapshot({
        attention: { failedRuns: [failed('f', at(-1))] },
        unreadableRuns: [{ ...unreadable('u'), workflowSlug: 'nightly' }],
      }),
    );
    expect(order.map((item) => item.workflow)).toEqual(['release-notes', 'wf', 'nightly']);
  });
});

describe('the keys walk the same order (strip-focus)', () => {
  it('stripRows lists the Attention items in the urgency order, then the sessions, then the runs', () => {
    const snap = snapshot({
      attention: { failedRuns: [failed('f', at(-1))] },
      unreadableRuns: [unreadable('u', at(-2))],
      recentRuns: [{ ...failed('r', at(-3)), status: 'completed' }],
    });
    const rows = stripRows([parked('p-none'), parked('p-due', at(30))], snap);
    expect(rows.map((row) => `${row.role}:${row.id}`)).toEqual([
      'parked:p-due',
      'parked:p-none',
      'failed:f',
      'unreadable:u',
      'recent:r',
    ]);
    expect(rows.map((row) => row.id).slice(0, 4)).toEqual(
      ids(attentionOrder([parked('p-none'), parked('p-due', at(30))], snap)),
    );
  });
});
