/**
 * Page 1's words for the most urgent item, kind by kind (MVP-11 unit 7, round 2; `urgentWords`, `urgentName`, `attentionOrder`'s overdue mark,
 * `parkedRunRows`' kind): each parked kind says its own words, a failed run says `failed` and its age, an unreadable run has no name and says
 * so; a deadline is named in full and compact and is overdue from the instant it passes; the name is scrubbed (a bracket is the parenthesis of
 * its own side, an arrow is a space) and bounded to 24 columns; and a run with a human gate AND a budget gate open is `several`.
 */
import { describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeUnreadableRun } from '../../home/home-store.js';
import type { ProjectRunGates } from '../../home/run-gates.js';
import {
  attentionOrder,
  parkedRunRows,
  URGENT_NAME_COLUMNS,
  urgentName,
  urgentWords,
  type AttentionItem,
  type ParkedRunKind,
  type ParkedRunRow,
} from './home-attention.js';
import { snapshotOf } from './home-controller.test-support.js';
import { displayWidth } from './viewport.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const parked = (kind: ParkedRunKind, over: Partial<ParkedRunRow> = {}): ParkedRunRow => ({
  runId: 'run-0123456789',
  kind,
  gates: 1,
  workflow: 'release-notes',
  ...over,
});
const failed = (over: Partial<HomeRunRow> = {}): HomeRunRow => ({
  runId: 'fail-0123456789',
  workflowSlug: 'nightly',
  status: 'failed',
  createdAt: at(-200),
  startedAt: at(-190),
  completedAt: at(-180),
  totalCostMicrocents: 0,
  ...over,
});
const unreadable = (over: Partial<HomeUnreadableRun> = {}): HomeUnreadableRun => ({
  runId: 'bad-0123456789',
  reason: 'corrupt-row',
  createdAt: at(-30),
  ...over,
});
const only = (items: readonly AttentionItem[]): AttentionItem => {
  const [item] = items;
  if (item === undefined || items.length !== 1) throw new Error('expected one item');
  return item;
};
const parkedItem = (row: ParkedRunRow, nowMs?: number): AttentionItem =>
  only(attentionOrder([row], snapshotOf({}), nowMs));
const failedItem = (run: HomeRunRow): AttentionItem =>
  only(attentionOrder([], snapshotOf({ failedRuns: [run] }), NOW));
const unreadableItem = (run: HomeUnreadableRun): AttentionItem =>
  only(attentionOrder([], snapshotOf({ unreadableRuns: [run] }), NOW));

describe('page 1 says each kind of item in its own words', () => {
  it.each([
    ['approval', 1, 'needs approval'],
    ['input', 1, 'needs input'],
    ['review', 1, 'needs review'],
    ['budget', 1, 'hit a budget limit'],
    ['several', 3, 'has 3 open gates'],
    ['media', 0, 'is waiting for media'],
    ['none', 0, 'is parked'],
  ] as const)('a parked run of kind %s (%i gates): "%s"', (kind, gates, words) => {
    expect(urgentWords(parkedItem(parked(kind, { gates })), NOW)).toEqual({
      name: 'release-notes',
      words,
      deadline: undefined,
      deadlineCompact: undefined,
      overdue: false,
      partial: false,
    });
  });

  it('a parked run names its deadline in full and compact, and is overdue exactly once the deadline has passed', () => {
    expect(
      urgentWords(parkedItem(parked('approval', { expiresAt: at(5) }), NOW), NOW),
    ).toMatchObject({
      deadline: 'expires in 5m',
      deadlineCompact: '5m left',
      overdue: false,
    });
    expect(
      urgentWords(parkedItem(parked('approval', { expiresAt: at(-5) }), NOW), NOW),
    ).toMatchObject({
      deadline: 'expired',
      deadlineCompact: 'expired',
      overdue: true,
    });
    expect(
      urgentWords(parkedItem(parked('approval', { expiresAt: at(0) }), NOW), NOW),
    ).toMatchObject({
      deadline: 'expired',
      deadlineCompact: 'expired',
      overdue: true,
    });
  });

  it('a parked run with no workflow is named `run` and the first eight characters of its id', () => {
    const item = parkedItem(parked('approval', { workflow: undefined }));
    expect(urgentWords(item, NOW).name).toBe('run run-0123');
  });

  it('a parked run whose workflow is empty after the scrub is named by its id too', () => {
    const item = parkedItem(parked('approval', { workflow: '   ' }));
    expect(urgentWords(item, NOW).name).toBe('run run-0123');
  });

  it('a failed run: its name, `failed` and how long ago it ended, no deadline, never overdue (amber, not red)', () => {
    const item = failedItem(failed());
    expect(urgentWords(item, NOW)).toEqual({
      name: 'nightly',
      words: 'failed 3h ago',
      deadline: undefined,
      deadlineCompact: undefined,
      overdue: false,
      partial: false,
    });
    expect(item.overdue).toBe(false);
  });

  it('a failed run is aged from when it ended, else from when it started, else from when it was created', () => {
    expect(urgentWords(failedItem(failed({ completedAt: undefined })), NOW).words).toBe(
      'failed 3h ago',
    );
    expect(
      urgentWords(failedItem(failed({ completedAt: undefined, startedAt: undefined })), NOW).words,
    ).toBe('failed 3h ago');
    expect(urgentWords(failedItem(failed({ completedAt: at(-30) })), NOW).words).toBe(
      'failed 30m ago',
    );
    expect(
      urgentWords(failedItem(failed({ completedAt: undefined, startedAt: at(-90) })), NOW).words,
    ).toBe('failed 1h ago');
  });

  it('a failed run with no recorded time says only `failed`', () => {
    const run = failed({ createdAt: 'not a time', startedAt: undefined, completedAt: undefined });
    expect(urgentWords(failedItem(run), NOW).words).toBe('failed');
  });

  it('a run whose log cannot be read has no name, says so, and is never overdue', () => {
    const item = unreadableItem(unreadable());
    expect(urgentWords(item, NOW)).toEqual({
      name: undefined,
      words: 'a run cannot be read',
      deadline: undefined,
      deadlineCompact: undefined,
      overdue: false,
      partial: false,
    });
    expect(item.overdue).toBe(false);
  });
});

describe('the name page 1 draws is scrubbed and bounded', () => {
  it('the bound is 24 columns, and a name of exactly 24 columns is kept whole', () => {
    expect(URGENT_NAME_COLUMNS).toBe(24);
    expect(displayWidth(urgentName('x'.repeat(60)))).toBe(24);
    expect(displayWidth(urgentName('y'.repeat(25)))).toBe(24);
    expect(urgentName('z'.repeat(24))).toBe('z'.repeat(24));
    expect(urgentName('z'.repeat(23))).toBe('z'.repeat(23));
  });

  it('every arrow of the block U+2190 to U+21FF becomes a space, and the characters on either side stay', () => {
    const arrow = (code: number): string => `a${String.fromCodePoint(code)}b`;
    for (const code of [0x2190, 0x2193, 0x21ff]) expect(urgentName(arrow(code))).toBe('a b');
    // the code points just outside the block are not arrows: U+218F (unassigned) and U+2200 (for all)
    for (const code of [0x218f, 0x2200]) expect(urgentName(arrow(code))).toBe(arrow(code));
  });

  it('a square bracket becomes the parenthesis of its own side', () => {
    expect(urgentName('[Enter]')).toBe('(Enter)');
    expect(urgentName('a[b]c')).toBe('a(b)c');
  });
});

describe('an item is overdue from the instant of its deadline, and only with a clock', () => {
  const overdue = (expiresAt: string | undefined, nowMs?: number): boolean =>
    parkedItem(parked('approval', { expiresAt }), nowMs).overdue;

  it('the deadline itself is overdue, a millisecond ahead is not, and no clock marks nothing', () => {
    expect(overdue(at(0), NOW)).toBe(true);
    expect(overdue(new Date(NOW + 1).toISOString(), NOW)).toBe(false);
    expect(overdue(at(-60), NOW)).toBe(true);
    expect(overdue(at(-60))).toBe(false);
    expect(overdue(undefined, NOW)).toBe(false);
  });
});

describe('the kind of a parked run counts its human gates AND its budget gates', () => {
  const gate = {
    runId: 'r1',
    gateId: 'g1',
    nodeId: 'n',
    gateType: 'approval',
    message: 'm',
    accepts: ['approved', 'rejected'],
  } satisfies ProjectRunGates['runs'][number]['gates'][number];
  const budget = {
    gateId: 'b1',
    nodeId: 'n',
    allowance: { kind: 'amount', microcents: 1 },
  } satisfies ProjectRunGates['runs'][number]['budgetGates'][number];
  const project = (
    gates: ProjectRunGates['runs'][number]['gates'],
    budgetGates: ProjectRunGates['runs'][number]['budgetGates'],
  ): ProjectRunGates => ({
    runs: [{ runId: 'r1', workflowId: 'wf', gates, budgetGates, degraded: false }],
    degradedRunIds: [],
    truncated: false,
  });

  it('one human gate and one budget gate are two open gates: several', () => {
    expect(parkedRunRows(project([gate], [budget]))).toEqual([
      { runId: 'r1', kind: 'several', gates: 2 },
    ]);
  });

  it('one gate of either kind is its own kind', () => {
    expect(parkedRunRows(project([gate], []))).toEqual([
      { runId: 'r1', kind: 'approval', gates: 1 },
    ]);
    expect(parkedRunRows(project([], [budget]))).toEqual([
      { runId: 'r1', kind: 'budget', gates: 1 },
    ]);
  });
});
