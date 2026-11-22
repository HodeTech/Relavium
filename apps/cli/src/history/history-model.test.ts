import type { RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  HISTORY_STATUS_CYCLE,
  IN_THE_FUTURE,
  RUN_STATUS_GLYPH,
  ageText,
  buildHistoryRows,
  filterByStatus,
  nextCursor,
  nextStatusFilter,
} from './history-model.js';
import {
  MAX_IDENTIFIER_CHARS,
  MAX_PROJECT_ROOT_CHARS,
  SCRUB_INPUT_CHARS,
} from './run-detail-model.js';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const isoAgo = (deltaMs: number): string => new Date(NOW - deltaMs).toISOString();

const OPEN_FIELDS = {
  workflowId: 'workflow-id',
  status: 'completed',
  executionMode: 'local',
  triggerType: 'manual',
  startedAt: '2026-11-22T11:00:00.000Z',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 1234,
  createdAt: '2026-11-22T11:00:00.000Z',
  updatedAt: '2026-11-22T11:02:05.000Z',
} as const;

function run(id: string, overrides: Partial<RunSummaryRecord> = {}): RunSummaryRecord {
  return { ...OPEN_FIELDS, id, completedAt: '2026-11-22T11:02:05.000Z', ...overrides };
}

/** A run with a start but no completion time. */
function openRun(id: string, overrides: Partial<RunSummaryRecord> = {}): RunSummaryRecord {
  return { ...OPEN_FIELDS, id, ...overrides };
}

const rowsOf = (runs: readonly RunSummaryRecord[], pinned: readonly string[] = []) =>
  buildHistoryRows({ runs, nowMs: NOW, pinnedRunIds: new Set(pinned) });

describe('ageText', () => {
  it('says `now` under a minute, including a clock that is up to one minute ahead', () => {
    expect(ageText(isoAgo(0), NOW)).toBe('now');
    expect(ageText(isoAgo(59_999), NOW)).toBe('now');
    expect(ageText(isoAgo(-30_000), NOW)).toBe('now');
    // Exactly one minute ahead is still skew: the boundary is strict, `in the future` starts one millisecond past it.
    expect(ageText(isoAgo(-MINUTE), NOW)).toBe('now');
  });

  it('says `in the future` for a timestamp more than one minute ahead, never `now`', () => {
    expect(ageText(isoAgo(-MINUTE - 1), NOW)).toBe('in the future');
    expect(ageText(isoAgo(-HOUR), NOW)).toBe('in the future');
    expect(ageText(isoAgo(-10 * DAY), NOW)).toBe('in the future');
    // The words are the exported constant, so a view and a test cannot drift from them.
    expect(IN_THE_FUTURE).toBe('in the future');
  });

  it('starts each unit exactly at its boundary and rounds down', () => {
    expect(ageText(isoAgo(MINUTE), NOW)).toBe('1m ago');
    expect(ageText(isoAgo(5 * MINUTE + 59_999), NOW)).toBe('5m ago');
    expect(ageText(isoAgo(HOUR - 1), NOW)).toBe('59m ago');
    expect(ageText(isoAgo(HOUR), NOW)).toBe('1h ago');
    expect(ageText(isoAgo(3 * HOUR + 30 * MINUTE), NOW)).toBe('3h ago');
    expect(ageText(isoAgo(DAY - 1), NOW)).toBe('23h ago');
    expect(ageText(isoAgo(DAY), NOW)).toBe('1d ago');
    expect(ageText(isoAgo(2 * DAY + 5 * HOUR), NOW)).toBe('2d ago');
    expect(ageText(isoAgo(400 * DAY), NOW)).toBe('400d ago');
  });

  it('is empty for a timestamp it cannot read, never `NaN`', () => {
    expect(ageText('not a time', NOW)).toBe('');
    expect(ageText('', NOW)).toBe('');
  });
});

describe('buildHistoryRows', () => {
  it('gives every status both a glyph and its word', () => {
    const statuses: RunStatus[] = [
      'pending',
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ];
    const rows = rowsOf(statuses.map((status, i) => run(`id-${i}-xxxxxxxx`, { status })));
    expect(rows.map((row) => [row.word, row.glyph])).toEqual([
      ['pending', '○'],
      ['running', '◐'],
      ['paused', '⏸'],
      ['completed', '✓'],
      ['failed', '✗'],
      ['cancelled', '⊘'],
    ]);
    expect(new Set(Object.values(RUN_STATUS_GLYPH)).size).toBe(6);
  });

  it('shows the short id (8 characters), the age and the pinned flag, and keeps the full id as identity', () => {
    const rows = rowsOf(
      [
        run('0123456789abcdef', { createdAt: isoAgo(5 * MINUTE) }),
        run('fedcba9876543210', { createdAt: isoAgo(3 * HOUR) }),
      ],
      ['fedcba9876543210'],
    );
    expect(rows.map((row) => [row.id, row.shortId, row.ageText, row.pinned])).toEqual([
      ['0123456789abcdef', '01234567', '5m ago', false],
      ['fedcba9876543210', 'fedcba98', '3h ago', true],
    ]);
  });

  it('labels a run with its workflow slug, else its workflow id, both through the sanitize floor', () => {
    const [named, unnamed] = buildHistoryRows({
      runs: [run('a', { workflowId: 'wf-1' }), run('b', { workflowId: 'wf\u001b[31m\n2' })],
      nowMs: NOW,
      pinnedRunIds: new Set(),
      workflowLabels: new Map([['wf-1', 'build\u001b]0;pwn\u0007\nstep']]),
    });
    expect(named?.label).toBe('build step');
    expect(unnamed?.label).toBe('wf 2');
  });

  it('bounds and scrubs the label and the project root read back from the history file', () => {
    const secret = `sk-ant-api03-${'P'.repeat(40)}`;
    // Values of exactly the scrub bound are scrubbed whole and then cut to the window each field shows.
    const [huge] = buildHistoryRows({
      runs: [
        run('a', {
          workflowId: 'w'.repeat(SCRUB_INPUT_CHARS),
          projectRoot: `/${'p'.repeat(SCRUB_INPUT_CHARS - 1)}`,
        }),
      ],
      nowMs: NOW,
      pinnedRunIds: new Set(),
    });
    expect(huge?.label).toBe(`${'w'.repeat(MAX_IDENTIFIER_CHARS)}…`);
    expect(huge?.projectRoot).toBe(`/${'p'.repeat(MAX_PROJECT_ROOT_CHARS - 1)}…`);
    // A value above the bound is not scrubbed and not shown in part: a fixed sentence says only its size.
    const [oversized] = buildHistoryRows({
      runs: [run('o', { workflowId: 'w'.repeat(200_000), projectRoot: `/${'p'.repeat(200_000)}` })],
      nowMs: NOW,
      pinnedRunIds: new Set(),
    });
    expect(oversized?.label).toBe('text too large to show (200000 bytes)');
    expect(oversized?.projectRoot).toBe('text too large to show (200001 bytes)');
    const [masked] = buildHistoryRows({
      runs: [run('b', { projectRoot: `/work/${secret}` })],
      nowMs: NOW,
      pinnedRunIds: new Set(),
      workflowLabels: new Map([['workflow-id', `flow ${secret}`]]),
    });
    expect(masked?.label).not.toContain('sk-ant-api03');
    expect(masked?.label.startsWith('flow ')).toBe(true);
    expect(masked?.projectRoot).not.toContain('sk-ant-api03');
    expect(masked?.projectRoot?.startsWith('/work/')).toBe(true);
    // An ordinary deep path is kept whole.
    const deep = `/${Array.from({ length: 40 }, () => 'segment').join('/')}`;
    expect(rowsOf([run('c', { projectRoot: deep })])[0]?.projectRoot).toBe(deep);
  });

  it('gives a duration for a finished run with both timestamps, and none otherwise', () => {
    const rows = rowsOf([
      run('done'),
      run('failed', { status: 'failed' }),
      openRun('open', { status: 'running' }),
      run('running-with-end', { status: 'running' }),
    ]);
    expect(rows[0]).toMatchObject({ durationMs: 125_000, durationText: '2m05s' });
    expect(rows[1]).toMatchObject({ durationMs: 125_000 });
    expect(rows[2]?.durationMs).toBeUndefined();
    expect(rows[3]?.durationMs).toBeUndefined();
  });

  it('clamps a clock-skewed negative duration to zero', () => {
    const [row] = rowsOf([
      run('a', { startedAt: '2026-11-22T11:10:00.000Z', completedAt: '2026-11-22T11:00:00.000Z' }),
    ]);
    expect(row?.durationMs).toBe(0);
  });

  it('carries the cursor position, the raw cost for the lazy qualified fetch, and the project', () => {
    const [row] = rowsOf([run('a', { createdAt: '2026-11-22T11:00:00.123Z', projectRoot: '/p' })]);
    expect(row).toMatchObject({
      createdAtMs: Date.parse('2026-11-22T11:00:00.123Z'),
      createdAt: '2026-11-22T11:00:00.123Z',
      totalCostMicrocents: 1234,
      projectRoot: '/p',
    });
    expect(rowsOf([run('b', { createdAt: 'garbage' })])[0]?.createdAtMs).toBeUndefined();
  });

  it('passes the project root and the short id through the one-line floor (both are read back from the history file)', () => {
    const [row] = rowsOf([
      run('ab\u001b[2Jcd\nef\u0007gh-tail', {
        projectRoot: '/work\u001b]0;pwn\u0007/\u202eevil\nroot',
      }),
    ]);
    expect(row?.projectRoot).toBe('/work/evil root');
    expect(row?.shortId).toBe('abcd');
    // The full id stays the identity a drill-down and a pin use.
    expect(row?.id).toBe('ab\u001b[2Jcd\nef\u0007gh-tail');
  });

  it('keeps the page order and drops nothing', () => {
    const rows = rowsOf([
      run('c', { status: 'running' }),
      run('a'),
      run('b', { status: 'paused' }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('filterByStatus', () => {
  const rows = rowsOf([
    run('a', { status: 'completed' }),
    run('b', { status: 'failed' }),
    run('c', { status: 'running' }),
    run('d', { status: 'cancelled' }),
    run('e', { status: 'paused' }),
    run('f', { status: 'pending' }),
    run('g', { status: 'failed' }),
  ]);

  it('with no status shows every FINISHED run — active runs belong to the Active tab', () => {
    expect(filterByStatus(rows).map((row) => row.id)).toEqual(['a', 'b', 'd', 'g']);
  });

  it('with a status shows only that status', () => {
    expect(filterByStatus(rows, 'failed').map((row) => row.id)).toEqual(['b', 'g']);
    expect(filterByStatus(rows, 'cancelled').map((row) => row.id)).toEqual(['d']);
    expect(filterByStatus(rows, 'completed').map((row) => row.id)).toEqual(['a']);
  });

  it('cycles all finished, completed, failed, cancelled, and back', () => {
    expect(HISTORY_STATUS_CYCLE).toEqual([undefined, 'completed', 'failed', 'cancelled']);
    expect(nextStatusFilter(undefined)).toBe('completed');
    expect(nextStatusFilter('completed')).toBe('failed');
    expect(nextStatusFilter('failed')).toBe('cancelled');
    expect(nextStatusFilter('cancelled')).toBeUndefined();
    // A status outside the cycle starts it over (at "every finished run") rather than throwing.
    expect(nextStatusFilter('paused')).toBeUndefined();
  });
});

describe('nextCursor', () => {
  const page = (count: number) =>
    rowsOf(
      Array.from({ length: count }, (_, i) =>
        run(`run-${i}`, {
          createdAt: new Date(Date.parse('2026-11-22T11:00:00.000Z') - i * 1000).toISOString(),
        }),
      ),
    );

  it('is the last row`s (createdAt ms, id) when the page is full', () => {
    expect(nextCursor(page(3), 3)).toEqual({
      createdAt: Date.parse('2026-11-22T11:00:00.000Z') - 2000,
      id: 'run-2',
    });
  });

  it('is undefined when the page is short — the list has ended', () => {
    expect(nextCursor(page(2), 3)).toBeUndefined();
    expect(nextCursor([], 20)).toBeUndefined();
  });

  it('is undefined for a non-positive limit or a last row whose time is unreadable', () => {
    expect(nextCursor(page(3), 0)).toBeUndefined();
    const unreadable = rowsOf([run('a'), run('b', { createdAt: 'garbage' })]);
    expect(nextCursor(unreadable, 2)).toBeUndefined();
  });

  it('is taken from the raw page, so a status filter cannot end paging early', () => {
    const raw = rowsOf([
      run('a', { status: 'completed', createdAt: '2026-11-22T11:00:03.000Z' }),
      run('b', { status: 'running', createdAt: '2026-11-22T11:00:02.000Z' }),
      run('c', { status: 'running', createdAt: '2026-11-22T11:00:01.000Z' }),
    ]);
    // After the filter the page looks short; the cursor of the raw page still says there is more.
    expect(filterByStatus(raw)).toHaveLength(1);
    expect(nextCursor(raw, 3)).toEqual({
      createdAt: Date.parse('2026-11-22T11:00:01.000Z'),
      id: 'c',
    });
    expect(nextCursor(filterByStatus(raw), 3)).toBeUndefined();
  });
});
