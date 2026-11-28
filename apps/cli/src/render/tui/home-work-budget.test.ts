/**
 * The work page's allocation (MVP-11 unit 7, the maintainer's ruling 1: "max 4 under Attention, then an overflow marker and N more; Sessions
 * max 3, Runs max 3; the numbers may grow or shrink with the page; SHOW THESE NUMBERS TRUE"). Pure: (the list's rows, each section's total,
 * what it loaded and the focus) → each section's window and its `▲`/`▼` markers. The properties run over random cases from fixed seeds.
 * Round 2 (R2-W3a): 4/3/3 at 80×24 (whitespace gives way before words, words before rows), no re-flow under the cursor, no priority inversion
 * (a section with items is never gone while the rows to show it exist), and a marker that would hide exactly one row draws the row.
 */
import { describe, expect, it } from 'vitest';

import {
  allocateWorkList,
  sectionWindow,
  workListChrome,
  workListFloor,
  type SectionDemand,
  type WorkAllocation,
  type WorkBudgetInput,
} from './home-work-budget.js';
import { workListRows, WORK_LIST_MIN_ROWS } from './home-pages.js';

const none: SectionDemand = { loaded: 0, total: 0 };
const five: SectionDemand = { loaded: 5, total: 5 };
const input = (rows: number, over: Partial<WorkBudgetInput> = {}): WorkBudgetInput => ({
  rows,
  attention: none,
  sessions: none,
  runs: none,
  agents: none,
  ...over,
});

/** The list rows at a terminal size with the resting docked prompt (`workListRows`): 17 at 80×24 (no blank under the way back), 22 at 100×30, 32 at 120×40. */
const listAt = (rows: number): number => workListRows(rows, 5);

/** What a section draws: its item rows and its markers. */
const drawn = (window: WorkAllocation['attention']): number =>
  window.count + (window.above > 0 ? 1 : 0) + (window.below > 0 ? 1 : 0);
const shape = (window: WorkAllocation['attention']): string =>
  `${window.above > 0 ? `▲${String(window.above)} ` : ''}${String(window.count)}${window.below > 0 ? ` ▼${String(window.below)}` : ''}`;

describe('the list region at the three sizes', () => {
  it('is 17, 22 and 32 rows at 80×24, 100×30 and 120×40', () => {
    expect([listAt(24), listAt(30), listAt(40)]).toEqual([17, 22, 32]);
  });
});

describe('the table at (5, 5, 5): five Attention items, five sessions, five runs', () => {
  const at = (rows: number, agents: SectionDemand = none): WorkAllocation =>
    allocateWorkList(input(listAt(rows), { attention: five, sessions: five, runs: five, agents }));

  it('80×24: Attention shows all five (a `▼ 1 more` would take the line the fifth row takes), the sessions and the runs three each and their markers (17 rows)', () => {
    const page = at(24);
    expect([shape(page.attention), shape(page.sessions), shape(page.runs), shape(page.agents)]).toEqual([
      '5',
      '3 ▼2',
      '3 ▼2',
      '0',
    ]);
    expect(page.rows).toBe(17);
    expect(page.gap).toBe(false);
  }); // prettier-ignore

  it('100×30: the base layout fits with rows to spare, so the caps open: every item of the three sections (20 of 22 rows)', () => {
    const page = at(30);
    expect([shape(page.attention), shape(page.sessions), shape(page.runs)]).toEqual([
      '5',
      '5',
      '5',
    ]);
    expect(page.rows).toBe(20);
  });

  it('80×24 with fewer rows elsewhere: the base layout fits, so Attention shows all five (the caps open only into spare rows)', () => {
    const page = allocateWorkList(
      input(listAt(24), { attention: five, sessions: { loaded: 1, total: 1 } }),
    );
    expect([shape(page.attention), shape(page.sessions)]).toEqual(['5', '1']);
  });

  it('120×40: everything, and the agents last with what is left', () => {
    const page = at(40, { loaded: 3, total: 3 });
    expect([shape(page.attention), shape(page.sessions), shape(page.runs), shape(page.agents)]).toEqual([
      '5',
      '5',
      '5',
      '3',
    ]);
    expect(page.rows).toBeLessThanOrEqual(32);
  }); // prettier-ignore
});

describe('the allocation table: five total sets at 24, 25, 26, 27 and 30 terminal rows (the maintainer’s 4 / 3 / 3 at 80×24)', () => {
  const demand = (total: number, loaded = Math.min(total, 8)): SectionDemand => ({ loaded, total });
  const at = (rows: number, a: number, s: number, r: number): WorkAllocation =>
    allocateWorkList(
      input(listAt(rows), {
        attention: demand(a),
        sessions: demand(s),
        runs: demand(r),
        agents: demand(3),
      }),
    );
  /** `[Attention, Sessions, Runs, gap]` as the shapes print them. */
  const table = (rows: number, totals: readonly [number, number, number]): string[] => {
    const page = at(rows, ...totals);
    return [
      shape(page.attention),
      shape(page.sessions),
      shape(page.runs),
      page.gap ? 'gap' : 'no gap',
    ];
  };

  it.each([
    // (12, 7, 8): rich: the caps at 24, 25 and 26 rows; Attention opens first, up to its eight
    [24, [12, 7, 8], ['4 ▼8', '3 ▼4', '3 ▼5', 'no gap']],
    [25, [12, 7, 8], ['4 ▼8', '3 ▼4', '3 ▼5', 'gap']],
    [26, [12, 7, 8], ['4 ▼8', '3 ▼4', '3 ▼5', 'gap']],
    [27, [12, 7, 8], ['5 ▼7', '3 ▼4', '3 ▼5', 'gap']],
    [30, [12, 7, 8], ['8 ▼4', '3 ▼4', '3 ▼5', 'gap']],
    // (5, 5, 5): Attention's fifth row takes the line of the `▼ 1 more`
    [24, [5, 5, 5], ['5', '3 ▼2', '3 ▼2', 'no gap']],
    [25, [5, 5, 5], ['5', '3 ▼2', '3 ▼2', 'gap']],
    [26, [5, 5, 5], ['5', '3 ▼2', '3 ▼2', 'gap']],
    [27, [5, 5, 5], ['5', '5', '3 ▼2', 'gap']],
    [30, [5, 5, 5], ['5', '5', '5', 'gap']],
    // (4, 3, 3): everything, at every size
    [24, [4, 3, 3], ['4', '3', '3', 'gap']],
    [25, [4, 3, 3], ['4', '3', '3', 'gap']],
    [26, [4, 3, 3], ['4', '3', '3', 'gap']],
    [27, [4, 3, 3], ['4', '3', '3', 'gap']],
    [30, [4, 3, 3], ['4', '3', '3', 'gap']],
    // (0, 5, 5): no Attention, no blank row to give up; the caps open into the spare rows
    [24, [0, 5, 5], ['0', '5', '5', 'gap']],
    [30, [0, 5, 5], ['0', '5', '5', 'gap']],
    // (6, 0, 0): Attention alone
    [24, [6, 0, 0], ['6', '0', '0', 'gap']],
    [30, [6, 0, 0], ['6', '0', '0', 'gap']],
  ] as const)('%i rows, totals %j', (rows, totals, expected) => {
    expect(table(rows, totals)).toEqual(expected);
  });

  it.each([24, 25, 26, 27, 30])('%i rows: shown + N more is the total in every section, for every set of totals', (rows) => {
    for (const totals of [[12, 7, 8], [5, 5, 5], [4, 3, 3], [0, 5, 5], [6, 0, 0]] as const) {
      const page = at(rows, totals[0], totals[1], totals[2]);
      const names = ['attention', 'sessions', 'runs'] as const;
      names.forEach((name, index) => {
        const window = page[name];
        expect(window.above + window.count + window.below, `${String(rows)} ${name} ${JSON.stringify(totals)}`).toBe(totals[index]);
      });
    }
  }); // prettier-ignore

  it('the blank row above `Continue` is drawn only when the base layout fits WITH it: 18 rows for (12, 7, 8)', () => {
    const rich = (rows: number): WorkAllocation =>
      allocateWorkList(input(rows, { attention: demand(12), sessions: demand(7), runs: demand(8) }));
    expect(rich(17).gap).toBe(false);
    expect(rich(18).gap).toBe(true);
    // and at 17 rows the numbers are the same 4 / 3 / 3: the blank costs no row of them
    expect([shape(rich(17).attention), shape(rich(17).sessions), shape(rich(17).runs)]).toEqual(['4 ▼8', '3 ▼4', '3 ▼5']);
  }); // prettier-ignore
});

describe('the marker', () => {
  it('replaces the last row it hides: the rows shown and its N are the total', () => {
    const window = sectionWindow(4, { loaded: 8, total: 8 });
    expect(window).toEqual({ start: 0, count: 3, above: 0, below: 5, belowLoaded: true });
  });

  it('counts the TOTAL, not the rows loaded, and says where the rest are when `↓` cannot reach them', () => {
    expect(sectionWindow(4, { loaded: 8, total: 32 })).toEqual({
      start: 0,
      count: 3,
      above: 0,
      below: 29,
      belowLoaded: false,
    });
  });

  it('a marker that would hide exactly ONE row draws the row instead: `▼ 1 more` and `▲ 1 more` never appear where the row is loaded', () => {
    // five rows, a cap of four: the fifth takes the line the `▼ 1 more` would take
    expect(sectionWindow(5, { loaded: 5, total: 5 }, 4)).toEqual({
      start: 0,
      count: 5,
      above: 0,
      below: 0,
      belowLoaded: true,
    });
    // scrolled: rows 0..5, a window of two rows around the focus at 2 leaves one row above and three below: the row above is drawn
    expect(sectionWindow(4, { loaded: 6, total: 6, focus: 2 })).toEqual({
      start: 0,
      count: 3,
      above: 0,
      below: 3,
      belowLoaded: true,
    });
    // both single: a window of one row between a row above and a row below is the three rows
    expect(sectionWindow(3, { loaded: 3, total: 3, focus: 1 })).toEqual({
      start: 0,
      count: 3,
      above: 0,
      below: 0,
      belowLoaded: true,
    });
  });

  it('a single hidden row that was NOT loaded stays a marker, and says where it is (the row cannot be drawn)', () => {
    expect(sectionWindow(5, { loaded: 4, total: 5 })).toEqual({
      start: 0,
      count: 4,
      above: 0,
      below: 1,
      belowLoaded: false,
    });
  });

  it('a section whose rows are all shown has none', () => {
    expect(sectionWindow(5, { loaded: 5, total: 5 })).toEqual({
      start: 0,
      count: 5,
      above: 0,
      below: 0,
      belowLoaded: true,
    });
  });

  it('a window scrolled down to the focus says `▲ N more` above it, and `▼` below while rows remain', () => {
    expect(sectionWindow(5, { loaded: 12, total: 12, focus: 6 })).toEqual({
      start: 4,
      count: 3,
      above: 4,
      below: 5,
      belowLoaded: true,
    });
    // A focus inside the last window takes the window that ends at the last row: one marker, more rows.
    expect(sectionWindow(5, { loaded: 8, total: 8, focus: 5 })).toEqual({
      start: 4,
      count: 4,
      above: 4,
      below: 0,
      belowLoaded: true,
    });
    expect(sectionWindow(5, { loaded: 8, total: 8, focus: 7 })).toEqual({
      start: 4,
      count: 4,
      above: 4,
      below: 0,
      belowLoaded: true,
    });
  });

  it('with nothing loaded but a total, the marker alone says how many and where', () => {
    expect(sectionWindow(1, { loaded: 0, total: 3 })).toEqual({
      start: 0,
      count: 0,
      above: 0,
      below: 3,
      belowLoaded: false,
    });
    const page = allocateWorkList(input(16, { sessions: { loaded: 0, total: 3 } }));
    expect(shape(page.sessions)).toBe('0 ▼3');
  });
});

describe('the chrome the view draws is the chrome counted', () => {
  it('Attention alone: its heading; with a Continue section: the blank row, `Continue` and a title each', () => {
    expect(workListChrome({ attention: 1, sessions: 0, runs: 0, agents: 0 })).toBe(1);
    expect(workListChrome({ attention: 1, sessions: 1, runs: 0, agents: 0 })).toBe(4);
    expect(workListChrome({ attention: 0, sessions: 1, runs: 1, agents: 0 })).toBe(3);
    expect(workListChrome({ attention: 2, sessions: 3, runs: 3, agents: 1 })).toBe(6);
    expect(workListChrome({ attention: 0, sessions: 0, runs: 0, agents: 0 })).toBe(0);
  });

  it('without the blank row (`gap` false) the blank under Attention is not counted; with Attention alone there is none to count', () => {
    expect(workListChrome({ attention: 1, sessions: 1, runs: 0, agents: 0 }, false)).toBe(3);
    expect(workListChrome({ attention: 2, sessions: 3, runs: 3, agents: 1 }, false)).toBe(5);
    expect(workListChrome({ attention: 1, sessions: 0, runs: 0, agents: 0 }, true)).toBe(1);
    expect(workListChrome({ attention: 0, sessions: 1, runs: 1, agents: 0 }, false)).toBe(3);
  });
});

describe('priority when rows run short', () => {
  it('the focused row first: a focused run deep in its list is drawn even when the list has room for little else', () => {
    const page = allocateWorkList(
      input(6, { attention: five, sessions: five, runs: { loaded: 8, total: 8, focus: 6 } }),
    );
    const runs = page.runs;
    expect(runs.start <= 6 && 6 < runs.start + runs.count, shape(runs)).toBe(true);
    expect(page.rows).toBeLessThanOrEqual(6);
  });

  it('then the first row of every section, Attention first: a list of the floor (10 rows) keeps one row and its marker of each before any grows', () => {
    const page = allocateWorkList(input(10, { attention: five, sessions: five, runs: five }));
    expect([shape(page.attention), shape(page.sessions), shape(page.runs)]).toEqual([
      '1 ▼4',
      '1 ▼4',
      '1 ▼4',
    ]);
    expect(workListFloor({ attention: true, sessions: true, runs: true })).toBe(10);
    expect(WORK_LIST_MIN_ROWS).toBe(10);
  });

  it('then Attention grows to its cap before the sessions and the runs grow, which then grow alternately', () => {
    const thirteen = allocateWorkList(input(13, { attention: five, sessions: five, runs: five }));
    expect([shape(thirteen.attention), shape(thirteen.sessions), shape(thirteen.runs)]).toEqual([
      '5',
      '1 ▼4',
      '1 ▼4',
    ]);
    const fourteen = allocateWorkList(input(14, { attention: five, sessions: five, runs: five }));
    expect([shape(fourteen.sessions), shape(fourteen.runs)]).toEqual(['2 ▼3', '1 ▼4']);
    const fifteen = allocateWorkList(input(15, { attention: five, sessions: five, runs: five }));
    expect([shape(fifteen.sessions), shape(fifteen.runs)]).toEqual(['2 ▼3', '2 ▼3']);
  });

  it('the agents come last, only with the rows nothing else wants, and never more than three', () => {
    const tight = allocateWorkList(
      input(16, { attention: five, sessions: five, runs: five, agents: { loaded: 3, total: 3 } }),
    );
    expect(shape(tight.agents)).toBe('0');
    const roomy = allocateWorkList(
      input(16, { sessions: { loaded: 1, total: 1 }, agents: { loaded: 3, total: 3 } }),
    );
    expect(shape(roomy.agents)).toBe('3');
    const more = allocateWorkList(
      input(32, { sessions: { loaded: 1, total: 1 }, agents: { loaded: 6, total: 6 } }),
    );
    expect(shape(more.agents)).toBe('3 ▼3');
  });

  it('a taller page grows Attention first, up to eight, then the sessions and the runs alike', () => {
    const many: SectionDemand = { loaded: 12, total: 12 };
    const page = allocateWorkList(input(40, { attention: many, sessions: { loaded: 8, total: 20 }, runs: { loaded: 8, total: 20 } }));
    expect([shape(page.attention), shape(page.sessions), shape(page.runs)]).toEqual([
      '8 ▼4',
      '8 ▼12',
      '8 ▼12',
    ]);
  }); // prettier-ignore
});

describe('no priority inversion (R2-W3a, correctness F2)', () => {
  it('the sweep case of the review: (5, 5, 5), the focus on the third session, eight list rows: Attention is there, not given to the runs', () => {
    const page = allocateWorkList(
      input(8, { attention: five, sessions: { loaded: 5, total: 5, focus: 2 }, runs: five }),
    );
    // Attention first: its marker or its row beside the focused session row; the runs get nothing before it
    expect(drawn(page.attention), shape(page.attention)).toBeGreaterThanOrEqual(1);
    expect(drawn(page.runs), shape(page.runs)).toBeLessThanOrEqual(drawn(page.attention));
    const sessions = page.sessions;
    expect(sessions.start <= 2 && 2 < sessions.start + sessions.count).toBe(true);
    expect(page.rows).toBeLessThanOrEqual(8);
  });

  it('a section that cannot start is not served by the rows a higher one could not use: with five rows and the focus nowhere, Attention and one session start, the runs wait', () => {
    const page = allocateWorkList(input(5, { attention: five, sessions: five, runs: five }));
    expect([shape(page.attention), shape(page.sessions), shape(page.runs)]).toEqual([
      '0 ▼5',
      '0 ▼5',
      '0',
    ]);
  });

  it('a stalled ladder grows nothing, and a higher section’s first row comes before a lower one’s marker: with six rows Attention has its row, the one session its marker, the runs wait', () => {
    const six = allocateWorkList(input(6, { attention: five, sessions: five, runs: five }));
    expect([shape(six.attention), shape(six.sessions), shape(six.runs)]).toEqual(['1 ▼4', '0 ▼5', '0']);
    expect(six.rows).toBe(6);
    // four rows: Attention's row and marker; the row left over is not given to Attention's second row (the sessions could not start: nothing grows)
    const four = allocateWorkList(input(4, { attention: five, sessions: five, runs: five }));
    expect([shape(four.attention), shape(four.sessions), shape(four.runs)]).toEqual(['1 ▼4', '0', '0']);
    expect(four.rows).toBe(3);
  }); // prettier-ignore

  it('collapsed: with seven rows (a long draft with a notice that cannot give any more) every section is there as its marker alone, Attention first', () => {
    const page = allocateWorkList(input(7, { attention: five, sessions: five, runs: five }));
    expect([shape(page.attention), shape(page.sessions), shape(page.runs)]).toEqual([
      '0 ▼5',
      '0 ▼5',
      '0 ▼5',
    ]);
    expect(page.rows).toBe(7);
  });
});

// ---- Properties over random cases (fixed seeds) -----------------------------------------------------------------------------------

/** A small deterministic generator (mulberry32): the same seed gives the same cases on every run and machine. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SECTIONS = ['attention', 'sessions', 'runs', 'agents'] as const;

function randomCase(next: () => number): WorkBudgetInput {
  const int = (max: number): number => Math.floor(next() * (max + 1));
  const demand = (maxLoaded: number, extraTotal: number): SectionDemand => {
    const loaded = int(maxLoaded);
    return { loaded, total: loaded === maxLoaded ? loaded + int(extraTotal) : loaded };
  };
  const sections = {
    attention: demand(14, 30),
    sessions: demand(8, 40),
    runs: demand(8, 40),
    agents: demand(3, 0),
  };
  // The focus: on a loaded row of a focusable section, or none.
  const focusable = (['attention', 'sessions', 'runs'] as const).filter(
    (name) => sections[name].loaded > 0,
  );
  const pick = int(focusable.length);
  const focused = focusable[pick];
  const withFocus =
    focused === undefined
      ? sections
      : {
          ...sections,
          [focused]: { ...sections[focused], focus: int(sections[focused].loaded - 1) },
        };
  // The rows: the three sizes and everything from a short page (a notice took most of it) to a tall one.
  const rows = [listAt(24), listAt(30), listAt(40), 7 + int(30)][int(3)] ?? 16;
  return { rows, ...withFocus };
}

/** The least the focused row needs to be drawn: its heading or titles and the row itself (the markers around it come later in the ladder). */
function focusFloor(page: WorkBudgetInput): number {
  for (const name of SECTIONS) {
    if (page[name].focus === undefined) continue;
    return (name === 'attention' ? 1 : 2) + 1;
  }
  return 0;
}

/** The rows a focused window needs for its row and the markers around it: with fewer, the `▲` gives way first, then the `▼`. */
function markersFloor(demand: SectionDemand): number {
  const focus = demand.focus ?? 0;
  const total = Math.max(demand.total, demand.loaded);
  return 1 + (focus > 0 ? 1 : 0) + (focus < total - 1 ? 1 : 0);
}

/** `page` with the focus moved to row `index` of `name` (and nowhere else). */
function focusedAt(
  page: WorkBudgetInput,
  name: (typeof SECTIONS)[number],
  index: number,
): WorkBudgetInput {
  const base = { ...page };
  for (const other of SECTIONS) base[other] = { ...page[other], focus: undefined };
  return { ...base, [name]: { ...page[name], focus: index } };
}

/** The rows a section takes, markers included: what the view draws of it. */
const takes = (window: WorkAllocation['attention']): number => drawn(window);

/** The rows a section needs to be there at all: its marker alone, or its only row (`0` for a section with nothing). */
const hasItems = (demand: SectionDemand): boolean => Math.max(demand.total, demand.loaded) > 0;

describe.each([1, 7, 42, 2026, 31337])('properties, seed %i', (seed) => {
  const next = generator(seed);
  const cases = Array.from({ length: 400 }, () => randomCase(next));

  it('no re-flow under the cursor: while the focus walks inside one section, no section takes more or fewer rows, and the blank row stays', () => {
    for (const page of cases) {
      for (const name of ['attention', 'sessions', 'runs'] as const) {
        const loaded = page[name].loaded;
        if (loaded === 0) continue;
        const first = allocateWorkList(focusedAt(page, name, 0));
        for (let index = 1; index < loaded; index += 1) {
          const result = allocateWorkList(focusedAt(page, name, index));
          const label = `${name} ${String(index)} ${JSON.stringify(page)}`;
          expect(result.gap, label).toBe(first.gap);
          for (const other of SECTIONS) {
            expect(takes(result[other]), `${other} ${label}`).toBe(takes(first[other]));
            // a section the focus is not in is the same window, not only the same rows
            if (other !== name) expect(result[other], `${other} ${label}`).toEqual(first[other]);
          }
        }
      }
    }
  });

  it('the focused window has two rows beside its markers when the page has them: the rows the other sections keep at their first row leave it four (or the whole section)', () => {
    for (const page of cases) {
      for (const name of ['attention', 'sessions', 'runs'] as const) {
        const demand = page[name];
        if (demand.loaded < 2) continue;
        const total = Math.max(demand.total, demand.loaded);
        const comfort = Math.min(4, demand.loaded === total ? total : demand.loaded + 1);
        // the others at their first row (a marker alone when the first row is not wanted), the focused section at its comfort
        const others = (['attention', 'sessions', 'runs'] as const).filter((other) => other !== name);
        const want = { attention: 0, sessions: 0, runs: 0, agents: 0 };
        for (const other of others) {
          const t = Math.max(page[other].total, page[other].loaded);
          want[other] = t === 0 ? 0 : t === 1 || page[other].loaded === 0 ? 1 : 2;
        }
        want[name] = comfort;
        const needed = workListChrome(want, false) + want.attention + want.sessions + want.runs;
        if (page.rows < needed) continue;
        const index = Math.floor(demand.loaded / 2);
        const result = allocateWorkList(focusedAt(page, name, index));
        const window = result[name];
        expect(window.count, `${name} ${String(index)} ${JSON.stringify(page)}`).toBeGreaterThanOrEqual(Math.min(2, demand.loaded));
        // the focus is inside the window, and what is hidden is counted by a marker
        expect(window.start <= index && index < window.start + window.count).toBe(true);
        expect(window.above + window.count + window.below).toBe(total);
      }
    }
  }); // prettier-ignore

  it('no priority inversion: among the sections the focus is not in, a lower one is drawn only when every higher one that has items is', () => {
    for (const page of cases) {
      const result = allocateWorkList(page);
      const order = ['attention', 'sessions', 'runs'] as const;
      for (let low = 1; low < order.length; low += 1)
        for (let high = 0; high < low; high += 1) {
          const lowName = order[low];
          const highName = order[high];
          if (lowName === undefined || highName === undefined) continue;
          if (page[lowName].focus !== undefined || page[highName].focus !== undefined) continue;
          if (!hasItems(page[highName])) continue;
          if (takes(result[lowName]) > 0)
            expect(takes(result[highName]), `${highName} before ${lowName} ${JSON.stringify(page)}`).toBeGreaterThan(0);
        }
    }
  }); // prettier-ignore

  it('no section with items is gone when the list keeps the collapsed floor (every section as its marker alone, the focused row drawn)', () => {
    for (const page of cases) {
      const present = { attention: 0, sessions: 0, runs: 0, agents: 0 };
      for (const name of ['attention', 'sessions', 'runs'] as const) present[name] = hasItems(page[name]) ? 1 : 0;
      const floor = workListChrome(present, false) + present.attention + present.sessions + present.runs;
      if (page.rows < floor) continue;
      const result = allocateWorkList(page);
      for (const name of ['attention', 'sessions', 'runs'] as const) {
        if (!hasItems(page[name])) continue;
        expect(takes(result[name]), `${name} ${JSON.stringify(page)}`).toBeGreaterThanOrEqual(1);
        const focus = page[name].focus;
        if (focus !== undefined)
          expect(result[name].start <= focus && focus < result[name].start + result[name].count, `${name} ${JSON.stringify(page)}`).toBe(true);
      }
    }
  }); // prettier-ignore

  it('the floor of the list (`workListFloor`) is enough for the first row and the marker of every section that has items', () => {
    for (const page of cases) {
      const has = {
        attention: hasItems(page.attention),
        sessions: hasItems(page.sessions),
        runs: hasItems(page.runs),
      };
      if (page.rows < workListFloor(has)) continue;
      if (SECTIONS.some((name) => page[name].focus !== undefined)) continue;
      const result = allocateWorkList(page);
      for (const name of ['attention', 'sessions', 'runs'] as const) {
        if (!has[name]) continue;
        const demand = page[name];
        const total = Math.max(demand.total, demand.loaded);
        // the first row (when it is loaded) and, when it hides more, the marker
        if (demand.loaded > 0) expect(result[name].count, `${name} ${JSON.stringify(page)}`).toBeGreaterThanOrEqual(1);
        if (total > result[name].count) expect(result[name].below, `${name} ${JSON.stringify(page)}`).toBeGreaterThan(0);
      }
    }
  }); // prettier-ignore

  it('the blank row is drawn only when the base layout fits with it, and the page never takes more rows than it has with or without it', () => {
    for (const page of cases) {
      const result = allocateWorkList(page);
      const target = (demand: SectionDemand, cap: number): number => {
        const total = Math.max(demand.total, demand.loaded);
        if (total === 0) return 0;
        return total <= cap && total <= demand.loaded ? total : Math.min(cap, demand.loaded) + 1;
      };
      const base = { attention: target(page.attention, 4), sessions: target(page.sessions, 3), runs: target(page.runs, 3), agents: 0 };
      const withGap = workListChrome(base, true) + base.attention + base.sessions + base.runs;
      expect(result.gap, JSON.stringify(page)).toBe(withGap <= page.rows);
    }
  }); // prettier-ignore

  it('the page never takes more rows than it has', () => {
    for (const page of cases) {
      const result = allocateWorkList(page);
      const counted =
        workListChrome(
          {
            attention: drawn(result.attention),
            sessions: drawn(result.sessions),
            runs: drawn(result.runs),
            agents: drawn(result.agents),
          },
          result.gap,
        ) + SECTIONS.reduce((sum, name) => sum + drawn(result[name]), 0);
      expect(counted, JSON.stringify(page)).toBe(result.rows);
      expect(result.rows, JSON.stringify(page)).toBeLessThanOrEqual(page.rows);
    }
  });

  it('the focused row is always drawn, wherever it is in its list', () => {
    for (const page of cases) {
      if (page.rows < focusFloor(page)) continue;
      const result = allocateWorkList(page);
      for (const name of SECTIONS) {
        const focus = page[name].focus;
        if (focus === undefined) continue;
        const window = result[name];
        expect(window.start <= focus && focus < window.start + window.count, `${name} ${JSON.stringify(page)}`).toBe(true);
      }
    }
  }); // prettier-ignore

  it('rows shown + N is the total in every section that is drawn, and a section with all its rows shown has no marker', () => {
    for (const page of cases) {
      if (page.rows < focusFloor(page)) continue;
      const result = allocateWorkList(page);
      for (const name of SECTIONS) {
        const window = result[name];
        const demand = page[name];
        const total = Math.max(demand.total, demand.loaded);
        if (drawn(window) === 0) continue;
        // the one documented exception: a focused window shorter than its row and its markers (`▲` gives way first, then `▼`)
        if (demand.focus !== undefined && drawn(window) < markersFloor(demand)) continue;
        expect(window.above + window.count + window.below, `${name} ${JSON.stringify(page)}`).toBe(total);
        if (window.count === total) expect(window.above + window.below).toBe(0);
        // a marker never hides exactly one row that is loaded: the row is drawn in its place
        if (window.above === 1) throw new Error(`a \`▲ 1 more\` ${name} ${JSON.stringify(page)}`);
        if (window.below === 1) expect(window.start + window.count, `${name} ${JSON.stringify(page)}`).toBeGreaterThanOrEqual(demand.loaded);
        // the `▼` names a destination exactly when it counts rows `↓` cannot reach
        if (window.below > 0) expect(window.belowLoaded).toBe(total <= demand.loaded);
        // never a row that was not loaded
        expect(window.start + window.count).toBeLessThanOrEqual(demand.loaded);
      }
    }
  }); // prettier-ignore

  it('every non-empty section keeps at least its first row when the rows permit, Attention first', () => {
    for (const page of cases) {
      if (SECTIONS.some((name) => page[name].focus !== undefined)) continue;
      const result = allocateWorkList(page);
      const firstRows = (name: (typeof SECTIONS)[number]): number => {
        const demand = page[name];
        if (Math.max(demand.total, demand.loaded) === 0) return 0;
        return demand.loaded === 0 || Math.max(demand.total, demand.loaded) === 1 ? 1 : 2;
      };
      const want = { attention: firstRows('attention'), sessions: firstRows('sessions'), runs: firstRows('runs'), agents: 0 };
      const needed = workListChrome(want, false) + want.attention + want.sessions + want.runs;
      if (page.rows < needed) continue;
      for (const name of ['attention', 'sessions', 'runs'] as const) {
        if (want[name] === 0) continue;
        expect(drawn(result[name]), `${name} ${JSON.stringify(page)}`).toBeGreaterThanOrEqual(want[name]);
        if (page[name].loaded > 0) expect(result[name].count).toBeGreaterThanOrEqual(1);
      }
    }
  }); // prettier-ignore

  it('the base caps hold (Attention four, sessions and runs three) whenever the base layout does not fit with rows to spare', () => {
    // The rows each section takes at its base cap: its items up to the cap, and a marker when it has more.
    const base = (demand: SectionDemand, cap: number): number => {
      const total = Math.max(demand.total, demand.loaded);
      if (total === 0) return 0;
      return total <= cap && total <= demand.loaded ? total : Math.min(cap, demand.loaded) + 1;
    };
    for (const page of cases) {
      const want = {
        attention: base(page.attention, 4),
        sessions: base(page.sessions, 3),
        runs: base(page.runs, 3),
        agents: 0,
      };
      const needed = workListChrome(want) + want.attention + want.sessions + want.runs;
      if (needed <= page.rows) continue;
      const result = allocateWorkList(page);
      // a section whose total is its cap plus one shows all its rows: the marker would hide exactly one
      const most = (demand: SectionDemand, cap: number): number =>
        Math.max(demand.total, demand.loaded) === cap + 1 && demand.loaded > cap ? cap + 1 : cap;
      expect(result.attention.count, JSON.stringify(page)).toBeLessThanOrEqual(
        most(page.attention, 4),
      );
      expect(result.sessions.count, JSON.stringify(page)).toBeLessThanOrEqual(
        most(page.sessions, 3),
      );
      expect(result.runs.count, JSON.stringify(page)).toBeLessThanOrEqual(most(page.runs, 3));
    }
  });
});

describe('a list shorter than the focused row and its markers', () => {
  it('keeps the focused row: the `▲` gives way first, then the `▼`', () => {
    expect(sectionWindow(2, { loaded: 8, total: 8, focus: 4 })).toEqual({
      start: 4,
      count: 1,
      above: 0,
      below: 3,
      belowLoaded: true,
    });
    expect(sectionWindow(1, { loaded: 8, total: 8, focus: 4 })).toEqual({
      start: 4,
      count: 1,
      above: 0,
      below: 0,
      belowLoaded: true,
    });
  });

  it('takes no rows for a size that is not a number', () => {
    const page = allocateWorkList(input(Number.NaN, { attention: five }));
    expect(page.rows).toBe(0);
    expect(drawn(page.attention)).toBe(0);
  });
});
