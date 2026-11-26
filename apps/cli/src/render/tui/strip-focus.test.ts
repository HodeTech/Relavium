/**
 * The strip's focus ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §6), pure: the focus is the identity of a row, so a read that moves the row never moves the focus off it; a row that is gone takes the
 * focus with it (no other row is moved onto); and the list `↑`/`↓` walk is the one the strip draws, in its order, with only the rows `Enter` can open.
 */
import { describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { ParkedRunRow } from './home-attention.js';
import {
  focusAt,
  focusFor,
  isFocused,
  resolveFocus,
  stepFocus,
  stripRows,
  type StripFocus,
  type StripRow,
} from './strip-focus.js';

const run = (id: string): StripRow => ({ kind: 'run', id, role: 'recent' });
const session = (id: string): StripRow => ({ kind: 'session', id, role: 'session' });
const focus = (kind: 'run' | 'session', id: string): StripFocus => ({ kind, id });

describe('focusFor: the focus is looked up by identity', () => {
  it('finds the row the focus names wherever it moved to: a row inserted above moves the index and not the focus', () => {
    const before = [run('a'), run('b'), run('c')];
    const focused = focus('run', 'b');
    expect(focusFor(before, focused)).toBe(1);
    const after = [run('new'), ...before];
    expect(focusFor(after, focused), 'b is now at index 2, and the focus followed it').toBe(2);
  });

  it('does not take a session for a run of the same id: the kind is part of the identity', () => {
    const rows = [session('x'), run('x')];
    expect(focusFor(rows, focus('run', 'x'))).toBe(1);
    expect(focusFor(rows, focus('session', 'x'))).toBe(0);
  });

  it('gives no row when the identity is gone: the focus is not handed to the row now standing at its old place', () => {
    const rows = [run('a'), session('b'), run('c')];
    expect(focusFor(rows, focus('run', 'gone'))).toBeUndefined();
    expect(
      focusFor(rows, focus('session', 'a')),
      'a run of that id is not a session',
    ).toBeUndefined();
    expect(focusFor([run('a')], focus('run', 'b'))).toBeUndefined();
  });

  it('gives no focus for an empty list, and none when nothing was focused', () => {
    expect(focusFor([], focus('run', 'a'))).toBeUndefined();
    expect(focusFor([run('a')], undefined)).toBeUndefined();
    expect(focusFor([], undefined)).toBeUndefined();
  });
});

describe('resolveFocus: the focus as it is on the rows now', () => {
  it('is the same object while the row is on the strip, wherever it moved to (a refresh that changed nothing changes no state)', () => {
    const focused = focus('run', 'b');
    expect(resolveFocus([run('a'), run('b')], focused)).toBe(focused);
    expect(resolveFocus([run('new'), run('a'), run('b')], focused)).toBe(focused);
  });

  it('drops the focus when its row is gone, and never moves it onto another row; is none for an empty list or no focus', () => {
    const focused = focus('run', 'b');
    expect(resolveFocus([run('a'), run('c')], focused)).toBeUndefined();
    expect(resolveFocus([run('a')], focused)).toBeUndefined();
    expect(resolveFocus([], focused)).toBeUndefined();
    expect(resolveFocus([run('a')], undefined)).toBeUndefined();
  });
});

describe('stepFocus', () => {
  const rows = [run('a'), run('b'), session('s')];

  it('goes down from the prompt onto the first row, and from row to row; the last row stays', () => {
    const first = stepFocus(rows, undefined, 1);
    expect(first).toEqual(focus('run', 'a'));
    const second = stepFocus(rows, first, 1);
    expect(second).toEqual(focus('run', 'b'));
    const last = stepFocus(rows, second, 1);
    expect(last).toEqual(focus('session', 's'));
    expect(stepFocus(rows, last, 1), 'nothing below the last row').toEqual(last);
  });

  it('goes up row by row, and from the first row back to the prompt; up from the prompt stays there', () => {
    expect(stepFocus(rows, focus('session', 's'), -1)).toEqual(focus('run', 'b'));
    expect(stepFocus(rows, focus('run', 'a'), -1)).toBeUndefined();
    expect(stepFocus(rows, undefined, -1)).toBeUndefined();
  });

  it('steps from where the focus stands now when its row moved, and starts again from the prompt when its row is gone', () => {
    expect(stepFocus([run('new'), ...rows], focus('run', 'a'), 1)).toEqual(focus('run', 'b'));
    expect(stepFocus([run('x'), run('y')], focus('run', 'gone'), 1)).toEqual(focus('run', 'x'));
    expect(stepFocus([run('x'), run('y')], focus('run', 'gone'), -1)).toBeUndefined();
  });

  it('has nowhere to go over no rows', () => {
    expect(stepFocus([], undefined, 1)).toBeUndefined();
    expect(stepFocus([], focus('run', 'a'), -1)).toBeUndefined();
  });
});

describe('focusAt and isFocused', () => {
  it('names a row by its identity alone; there is none past the rows', () => {
    expect(focusAt([run('a'), session('s')], 1)).toEqual(focus('session', 's'));
    expect(focusAt([run('a')], 3)).toBeUndefined();
    expect(isFocused(run('a'), focus('run', 'a')), 'only the kind and the id name a row').toBe(
      true,
    );
    expect(isFocused(run('a'), focus('session', 'a'))).toBe(false);
    expect(isFocused(run('a'), undefined)).toBe(false);
  });
});

describe('stripRows: the rows `↑`/`↓` reach, in the order the strip draws them', () => {
  const runRow = (runId: string, status: HomeRunRow['status']): HomeRunRow => ({
    runId,
    workflowSlug: 'wf',
    status,
    createdAt: '2026-11-23T00:00:00.000Z',
    startedAt: undefined,
    completedAt: undefined,
    totalCostMicrocents: 0,
  });
  const sessionRow = (sessionId: string): HomeSessionRow => ({
    sessionId,
    workingDir: '/work',
    title: undefined,
    agentSlug: 'chat',
    modelId: undefined,
    status: 'ended',
    updatedAt: '2026-11-23T00:00:00.000Z',
    totalCostMicrocents: 0,
  });
  const parked = (runId: string): ParkedRunRow => ({ runId, kind: 'approval', gates: 1 });
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

  it('lists the parked runs, then the failed runs, then the sessions, then the recent runs', () => {
    const rows = stripRows(
      [parked('p1'), parked('p2')],
      snapshot({
        attention: { failedRuns: [runRow('f1', 'failed')] },
        recentSessions: [sessionRow('s1'), sessionRow('s2')],
        recentRuns: [runRow('r1', 'completed'), runRow('r2', 'running')],
      }),
    );
    expect(rows.map((row) => `${row.role}:${row.id}`)).toEqual([
      'parked:p1',
      'parked:p2',
      'failed:f1',
      'session:s1',
      'session:s2',
      'recent:r1',
      'recent:r2',
    ]);
    expect(
      rows.filter((row) => row.role === 'session').every((row) => row.kind === 'session'),
    ).toBe(true);
  });

  it('lists a run once: an unreadable run is one unreadable row, never also a parked, failed or recent row', () => {
    const rows = stripRows(
      [parked('p1')],
      snapshot({
        attention: { failedRuns: [runRow('u1', 'failed'), runRow('f1', 'failed')] },
        recentRuns: [runRow('p1', 'paused'), runRow('r1', 'completed')],
        unreadableRuns: [{ runId: 'u1', reason: 'corrupt-row' }],
      }),
    );
    expect(rows.map((row) => `${row.role}:${row.id}`)).toEqual([
      'parked:p1',
      'failed:f1',
      'unreadable:u1',
      'recent:r1',
    ]);
  });

  it('focuses an unreadable run (Enter says why it cannot be read): a run row by its id, after the failed runs, in the Attention order', () => {
    const rows = stripRows(
      [parked('p1')],
      snapshot({
        attention: { failedRuns: [runRow('f1', 'failed')] },
        unreadableRuns: [
          { runId: 'u1', reason: 'newer-version' },
          { runId: 'u2', reason: 'could-not-read' },
        ],
        recentSessions: [sessionRow('s1')],
        recentAgents: [{ agentSlug: 'coder', lastUsedAt: '2026-11-23T00:00:00.000Z' }],
      }),
    );
    expect(rows).toEqual([
      { kind: 'run', id: 'p1', role: 'parked' },
      { kind: 'run', id: 'f1', role: 'failed' },
      { kind: 'run', id: 'u1', role: 'unreadable' },
      { kind: 'run', id: 'u2', role: 'unreadable' },
      { kind: 'session', id: 's1', role: 'session' },
    ]);
  });

  it('has no row for an agent, which only displays', () => {
    const rows = stripRows(
      [],
      snapshot({
        recentAgents: [{ agentSlug: 'coder', lastUsedAt: '2026-11-23T00:00:00.000Z' }],
      }),
    );
    expect(rows).toEqual([]);
  });
});
