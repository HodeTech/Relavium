/**
 * The edges of the work page's allocation (MVP-11 unit 7, round 2), each pinned by the exact window or the exact number it gives:
 * where the first window ends and the list starts to scroll (`rawWindow`'s focus test), the rows a section needs to be there at all and to
 * show its first row (`minimumRows`: the rung of the ladder that stops where a section does not fit), the floor the notice and the draft
 * leave the list (`workListFloor`, one number per set of sections), and a demand that is not a whole number (`normalized`).
 * `home-work-budget.test.ts` pins the rules by property and by the maintainer's tables; an off-by-one in one of these edges kept every one of
 * those green.
 */
import { describe, expect, it } from 'vitest';

import {
  allocateWorkList,
  sectionWindow,
  workListFloor,
  type SectionDemand,
  type SectionWindow,
} from './home-work-budget.js';

const D = (loaded: number, total: number, focus?: number): SectionDemand =>
  focus === undefined ? { loaded, total } : { loaded, total, focus };
const window = (
  start: number,
  count: number,
  above: number,
  below: number,
  belowLoaded = true,
): SectionWindow => ({ start, count, above, below, belowLoaded });
const NOTHING = D(0, 0);
const NO_ROWS = window(0, 0, 0, 0);

describe('where the first window ends and the list starts to scroll', () => {
  // nine rows loaded; the first window is the rows from the top and the `▼`: `min(room − 1, cap)` rows
  it.each([
    // [room, cap, focus, the window]
    [3, Number.POSITIVE_INFINITY, 1, window(0, 2, 0, 7)],
    [3, Number.POSITIVE_INFINITY, 2, window(2, 1, 2, 6)],
    [4, 3, 2, window(0, 3, 0, 6)],
    [4, 3, 3, window(2, 2, 2, 5)],
    [4, Number.POSITIVE_INFINITY, 2, window(0, 3, 0, 6)],
    [4, Number.POSITIVE_INFINITY, 3, window(2, 2, 2, 5)],
    [5, Number.POSITIVE_INFINITY, 3, window(0, 4, 0, 5)],
    [5, Number.POSITIVE_INFINITY, 4, window(2, 3, 2, 4)],
    [6, 3, 2, window(0, 3, 0, 6)],
    [6, 4, 3, window(0, 4, 0, 5)],
    [8, Number.POSITIVE_INFINITY, 6, window(0, 7, 0, 2)],
    [8, Number.POSITIVE_INFINITY, 7, window(2, 7, 2, 0)],
  ] as const)('room %i, cap %s, the focus on row %i: %j', (room, cap, focus, expected) => {
    expect(sectionWindow(room, D(9, 9, focus), cap)).toEqual(expected);
  });

  it('the focus on the first window’s last row leaves the window at the top, whatever the room and the cap', () => {
    for (const room of [2, 3, 4, 5, 6, 7, 8]) {
      for (const cap of [2, 3, 4, Number.POSITIVE_INFINITY]) {
        const last = Math.min(room - 1, cap) - 1;
        const shown = sectionWindow(room, D(9, 9, last), cap);
        expect(shown.start, `room ${String(room)}, cap ${String(cap)}`).toBe(0);
        expect(shown.above, `room ${String(room)}, cap ${String(cap)}`).toBe(0);
        expect(shown.count, `room ${String(room)}, cap ${String(cap)}`).toBe(last + 1);
      }
    }
  });
});

describe('the rows a section needs to be there, and to show its first row', () => {
  it('a section with a total and nothing loaded is there as its marker alone: one row, so the rows after it still go to the agents', () => {
    // runs: four counted, none loaded (the marker says where they are); six rows: the `Continue` heading, the Runs title, the marker, the
    // Agents title and two agents
    const page = allocateWorkList({
      rows: 6,
      attention: NOTHING,
      sessions: NOTHING,
      runs: D(0, 4),
      agents: D(2, 2),
    });
    expect(page.runs).toEqual(window(0, 0, 0, 4, false));
    expect(page.agents).toEqual(window(0, 2, 0, 0));
    expect(page.rows).toBe(6);
  });

  it('a section with a single row asks for that one row: when it does not fit the ladder stops, and the spare row is not given to Attention', () => {
    // four rows: Attention's heading, its first row and its marker are three; the Runs' first row needs `Continue`, its title and the row: it
    // does not fit, so nothing below it is served and Attention does not grow into the row that is left
    const page = allocateWorkList({
      rows: 4,
      attention: D(3, 3),
      sessions: NOTHING,
      runs: D(1, 1),
      agents: NOTHING,
    });
    expect(page.attention).toEqual(window(0, 1, 0, 2));
    expect(page.runs).toEqual(NO_ROWS);
    expect(page.rows).toBe(3);
  });

  it('a section with a total and nothing loaded asks for its marker the same way: when the marker does not fit, nothing below it is served', () => {
    const page = allocateWorkList({
      rows: 4,
      attention: D(3, 3),
      sessions: NOTHING,
      runs: D(0, 4),
      agents: NOTHING,
    });
    expect(page.attention).toEqual(window(0, 1, 0, 2));
    expect(page.runs).toEqual(NO_ROWS);
    expect(page.rows).toBe(3);
  });

  it('with the room for it, the same single row is drawn', () => {
    const page = allocateWorkList({
      rows: 7,
      attention: D(3, 3),
      sessions: NOTHING,
      runs: D(1, 1),
      agents: NOTHING,
    });
    expect(page.runs).toEqual(window(0, 1, 0, 0));
    expect(page.attention.count + page.attention.below).toBe(3);
  });
});

describe('the floor of the list', () => {
  it.each([
    [{ attention: false, sessions: false, runs: false }, 0],
    [{ attention: true, sessions: false, runs: false }, 3],
    [{ attention: false, sessions: true, runs: false }, 4],
    [{ attention: false, sessions: false, runs: true }, 4],
    [{ attention: false, sessions: true, runs: true }, 7],
    [{ attention: true, sessions: true, runs: false }, 7],
    [{ attention: true, sessions: false, runs: true }, 7],
    [{ attention: true, sessions: true, runs: true }, 10],
  ] as const)(
    'the sections %j need %i rows: the heading, a row and a marker of each, and `Continue` once',
    (has, rows) => {
      expect(workListFloor(has)).toBe(rows);
    },
  );
});

describe('a demand that is not a whole number is made whole before it is used', () => {
  const base = { loaded: 5, total: 5 };
  const BAD_FOCUS = [undefined, -1, -0.5, 0.5, 2.5, Number.NaN, 5, 6, 99, Number.POSITIVE_INFINITY];

  it.each([
    [2, 3],
    [3, 3],
    [3, Number.POSITIVE_INFINITY],
    [4, 2],
    [6, Number.POSITIVE_INFINITY],
  ] as const)(
    'room %i, cap %s: a focus that is not the index of a loaded row changes nothing',
    (room, cap) => {
      const plain = sectionWindow(room, base, cap);
      for (const focus of BAD_FOCUS)
        expect(sectionWindow(room, { ...base, focus }, cap), `focus ${String(focus)}`).toEqual(
          plain,
        );
    },
  );

  it('a focus outside what was loaded does not move a partly loaded section either', () => {
    const part = { loaded: 3, total: 9 };
    for (const room of [2, 3, 4, 5])
      expect(sectionWindow(room, { ...part, focus: 3 })).toEqual(sectionWindow(room, part));
  });

  it('a count that is not a number is nothing loaded, never one row, and a total that is not a number is what was loaded', () => {
    expect(sectionWindow(5, { loaded: Number.NaN, total: 3 })).toEqual(window(0, 0, 0, 3, false));
    expect(sectionWindow(5, { loaded: 3, total: Number.NaN })).toEqual(
      sectionWindow(5, { loaded: 3, total: 3 }),
    );
    expect(sectionWindow(5, { loaded: -2, total: 3 })).toEqual(window(0, 0, 0, 3, false));
  });

  it('a fraction of a row is floored, and a size that is not a number or is below zero takes no rows', () => {
    const demand = D(5, 5, 3);
    expect(sectionWindow(3.9, demand)).toEqual(sectionWindow(3, demand));
    expect(sectionWindow(Number.NaN, demand).count).toBe(0);
    expect(sectionWindow(Number.POSITIVE_INFINITY, demand).count).toBe(0);
    expect(sectionWindow(-3, demand).count).toBe(0);
    expect(sectionWindow(0.9, demand).count).toBe(0);
    expect(sectionWindow(4, { loaded: 4.9, total: 4.9 }).count).toBe(4);
  });

  it('the list’s own rows are floored the same way: 16.9 is 16, and not a number or below zero is nothing', () => {
    const input = { attention: D(5, 5), sessions: D(5, 5), runs: D(5, 5), agents: NOTHING };
    expect(allocateWorkList({ rows: 16.9, ...input })).toEqual(
      allocateWorkList({ rows: 16, ...input }),
    );
    expect(allocateWorkList({ rows: 0.9, ...input }).rows).toBe(0);
    expect(allocateWorkList({ rows: Number.NaN, ...input }).rows).toBe(0);
    expect(allocateWorkList({ rows: Number.POSITIVE_INFINITY, ...input }).rows).toBe(0);
    expect(allocateWorkList({ rows: -5, ...input }).rows).toBe(0);
  });
});
