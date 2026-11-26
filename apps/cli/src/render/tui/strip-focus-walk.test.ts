/**
 * `stepFocus` walks the strip's rows one at a time in both directions, and `stripRows` lists a run once however many lists name it (MVP-11
 * unit 7, round 2): `↑` from the SECOND row is the first (not the prompt), from the third the second, from the first the prompt; `↓` stays on
 * the last row; and a recent run a snapshot lists twice is one row.
 */
import { describe, expect, it } from 'vitest';

import { runRow, snapshotOf } from './home-controller.test-support.js';
import { focusAt, stepFocus, stripRows, type StripRow } from './strip-focus.js';

const row = (id: string): StripRow => ({ kind: 'run', id, role: 'recent' });
const ROWS = [row('a'), row('b'), row('c')];

describe('stepFocus walks the rows one at a time, in both directions', () => {
  it('↑ from the second row is the first, from the third the second, from the first the prompt', () => {
    expect(stepFocus(ROWS, focusAt(ROWS, 1), -1)).toEqual({ kind: 'run', id: 'a' });
    expect(stepFocus(ROWS, focusAt(ROWS, 2), -1)).toEqual({ kind: 'run', id: 'b' });
    expect(stepFocus(ROWS, focusAt(ROWS, 0), -1)).toBeUndefined();
  });

  it('↓ steps down and stays on the last row', () => {
    expect(stepFocus(ROWS, focusAt(ROWS, 0), 1)).toEqual({ kind: 'run', id: 'b' });
    expect(stepFocus(ROWS, focusAt(ROWS, 1), 1)).toEqual({ kind: 'run', id: 'c' });
    expect(stepFocus(ROWS, focusAt(ROWS, 2), 1)).toEqual({ kind: 'run', id: 'c' });
  });

  it('from no focus (or a focus whose row is gone) ↓ lands on the first row and ↑ stays at the prompt; with no rows there is no focus', () => {
    expect(stepFocus(ROWS, undefined, 1)).toEqual({ kind: 'run', id: 'a' });
    expect(stepFocus(ROWS, undefined, -1)).toBeUndefined();
    expect(stepFocus(ROWS, { kind: 'run', id: 'gone' }, 1)).toEqual({ kind: 'run', id: 'a' });
    expect(stepFocus(ROWS, { kind: 'run', id: 'gone' }, -1)).toBeUndefined();
    expect(stepFocus([], focusAt(ROWS, 1), 1)).toBeUndefined();
  });
});

describe('a run is one row however many lists name it', () => {
  it('a recent run listed twice by the snapshot is one row, at its first place', () => {
    const rows = stripRows(
      [],
      snapshotOf({ recentRuns: [runRow('r1'), runRow('r2'), runRow('r1')] }),
    );
    expect(rows.map((entry) => entry.id)).toEqual(['r1', 'r2']);
  });
});
