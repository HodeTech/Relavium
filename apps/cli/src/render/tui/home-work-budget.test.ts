/**
 * The work page's allocation (MVP-11 unit 7, the maintainer's ruling 1: "max 4 under Attention, then an overflow marker and N more; Sessions
 * max 3, Runs max 3; the numbers may grow or shrink with the page; SHOW THESE NUMBERS TRUE"). Pure: (the list's rows, each section's total,
 * what it loaded and the focus) → each section's window and its `▲`/`▼` markers. The properties run over random cases from fixed seeds.
 */
import { describe, expect, it } from 'vitest';

import {
  allocateWorkList,
  sectionWindow,
  workListChrome,
  type SectionDemand,
  type WorkAllocation,
  type WorkBudgetInput,
} from './home-work-budget.js';
import { workListRows } from './home-pages.js';

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

/** The list rows at a terminal size with the resting docked prompt (`workListRows`): 16 at 80×24, 22 at 100×30, 32 at 120×40. */
const listAt = (rows: number): number => workListRows(rows, 5);

/** What a section draws: its item rows and its markers. */
const drawn = (window: WorkAllocation['attention']): number =>
  window.count + (window.above > 0 ? 1 : 0) + (window.below > 0 ? 1 : 0);
const shape = (window: WorkAllocation['attention']): string =>
  `${window.above > 0 ? `▲${String(window.above)} ` : ''}${String(window.count)}${window.below > 0 ? ` ▼${String(window.below)}` : ''}`;

describe('the list region at the three sizes', () => {
  it('is 16, 22 and 32 rows at 80×24, 100×30 and 120×40', () => {
    expect([listAt(24), listAt(30), listAt(40)]).toEqual([16, 22, 32]);
  });
});

describe('the table at (5, 5, 5): five Attention items, five sessions, five runs', () => {
  const at = (rows: number, agents: SectionDemand = none): WorkAllocation =>
    allocateWorkList(input(listAt(rows), { attention: five, sessions: five, runs: five, agents }));

  it('80×24: Attention keeps its four and a `▼ 1 more`, the sessions and the runs two each and their markers (16 rows: 4/3/3 and three markers need 18)', () => {
    const page = at(24);
    expect([shape(page.attention), shape(page.sessions), shape(page.runs), shape(page.agents)]).toEqual([
      '4 ▼1',
      '2 ▼3',
      '2 ▼3',
      '0',
    ]);
    expect(page.rows).toBe(16);
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

  it('then the first row of every section, Attention first: a short list keeps one of each before it grows any', () => {
    const page = allocateWorkList(input(11, { attention: five, sessions: five, runs: five }));
    expect([shape(page.attention), shape(page.sessions), shape(page.runs)]).toEqual([
      '1 ▼4',
      '1 ▼4',
      '1 ▼4',
    ]);
  });

  it('then Attention grows to its cap before the sessions and the runs grow, which then grow alternately', () => {
    expect(
      shape(allocateWorkList(input(14, { attention: five, sessions: five, runs: five })).attention),
    ).toBe('4 ▼1');
    const fifteen = allocateWorkList(input(15, { attention: five, sessions: five, runs: five }));
    expect([shape(fifteen.sessions), shape(fifteen.runs)]).toEqual(['2 ▼3', '1 ▼4']);
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

/** The least the focused section needs: its heading or titles, the focused row and the markers around it. */
function focusFloor(page: WorkBudgetInput): number {
  for (const name of SECTIONS) {
    const demand = page[name];
    if (demand.focus === undefined) continue;
    const markers =
      (demand.focus > 0 ? 1 : 0) +
      (demand.focus < Math.max(demand.total, demand.loaded) - 1 ? 1 : 0);
    return (name === 'attention' ? 1 : 2) + 1 + markers;
  }
  return 0;
}

describe.each([1, 7, 42, 2026, 31337])('properties, seed %i', (seed) => {
  const next = generator(seed);
  const cases = Array.from({ length: 400 }, () => randomCase(next));

  it('the page never takes more rows than it has', () => {
    for (const page of cases) {
      const result = allocateWorkList(page);
      const counted =
        workListChrome({
          attention: drawn(result.attention),
          sessions: drawn(result.sessions),
          runs: drawn(result.runs),
          agents: drawn(result.agents),
        }) + SECTIONS.reduce((sum, name) => sum + drawn(result[name]), 0);
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
        expect(window.above + window.count + window.below, `${name} ${JSON.stringify(page)}`).toBe(total);
        if (window.count === total) expect(window.above + window.below).toBe(0);
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
      const needed = workListChrome(want) + want.attention + want.sessions + want.runs;
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
      expect(result.attention.count, JSON.stringify(page)).toBeLessThanOrEqual(4);
      expect(result.sessions.count, JSON.stringify(page)).toBeLessThanOrEqual(3);
      expect(result.runs.count, JSON.stringify(page)).toBeLessThanOrEqual(3);
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
