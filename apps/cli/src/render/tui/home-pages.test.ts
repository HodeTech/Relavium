/**
 * The Home's two pages as data (MVP-11 unit 7, `home-pages.ts`): the key reducer over every key and every state, the slide's offsets, the
 * indicator's counts and the two hint rows. The controller applies what the reducer says (`home-pages-controller.test.ts`); the view draws the
 * pages (`home-pages-frames.test.tsx`).
 */
import { describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { EditorState } from './chat-input.js';
import {
  cursorOnFirstLine,
  cursorOnLastLine,
  indicatorParts,
  landingHint,
  needsYouWords,
  reducePageKey,
  slideFrames,
  slideOffsetAt,
  slideOffsets,
  slideTravel,
  workCounts,
  workHeadRows,
  workHint,
  workListRows,
  type HintRow,
  type PageKey,
  type PageKeyOutcome,
  type PageKeyState,
  type WorkCounts,
} from './home-pages.js';
import { HOSTED_RUN_ENTER_ITEM } from './home-projection.js';
import { displayWidth } from './viewport.js';

const editor = (text: string, cursor = text.length): EditorState => ({ text, cursor });
const EMPTY = editor('');
const ONE_LINE = editor('fix the flaky test');
/** A two-line draft with the cursor on its first line, and the same with the cursor on its last. */
const MULTI_TOP = editor('first line\nsecond line', 3);
const MULTI_BOTTOM = editor('first line\nsecond line');

describe('the slide travels rows − 1 in four equal steps: three frames between, then the arrival', () => {
  it.each([
    [24, [6, 12, 18, 23]],
    [30, [8, 15, 22, 29]],
    [40, [10, 20, 30, 39]],
  ] as const)('at %i rows the offsets are %j', (rows, offsets) => {
    expect(slideOffsets(rows)).toEqual(offsets);
    expect(slideTravel(rows)).toBe(rows - 1);
  });

  it.each([24, 25, 30, 33, 40, 60, 120])(
    'at %i rows they rise strictly, end at the target and have three frames between',
    (rows) => {
      const offsets = slideOffsets(rows);
      expect(offsets).toHaveLength(4);
      expect(offsets.at(-1)).toBe(rows - 1);
      for (let n = 1; n < offsets.length; n += 1)
        expect(offsets[n] ?? 0).toBeGreaterThan(offsets[n - 1] ?? 0);
      expect(offsets[0] ?? 0).toBeGreaterThan(0);
    },
  );

  it('up to the landing it is the same frames in reverse, then the landing at rest', () => {
    expect(slideFrames(24, 'work')).toEqual([6, 12, 18, 23]);
    expect(slideFrames(24, 'start')).toEqual([18, 12, 6, 0]);
    expect(slideFrames(30, 'start')).toEqual([22, 15, 8, 0]);
  });

  it('a frame past the last is the arrival, and no slide has no offset', () => {
    expect(slideOffsetAt(24, undefined)).toBeUndefined();
    expect(slideOffsetAt(24, { to: 'work', frame: 0 })).toBe(6);
    expect(slideOffsetAt(24, { to: 'work', frame: 9 })).toBe(23);
    expect(slideOffsetAt(24, { to: 'start', frame: -3 })).toBe(18);
  });

  it('a size that is not a number travels nothing', () => {
    expect(slideTravel(Number.NaN)).toBe(0);
    expect(slideOffsets(Number.POSITIVE_INFINITY)).toEqual([0]);
  });
});

describe('where the cursor is in the draft', () => {
  it.each([
    [EMPTY, true, true],
    [ONE_LINE, true, true],
    [MULTI_TOP, true, false],
    [MULTI_BOTTOM, false, true],
    [editor('\nsecond', 0), true, false],
    [editor('first\n', 6), false, true],
  ] as const)('%j: first line %s, last line %s', (draft, first, last) => {
    expect(cursorOnFirstLine(draft)).toBe(first);
    expect(cursorOnLastLine(draft)).toBe(last);
  });
});

// ---- The key reducer, every key in every state ----------------------------------------------------------------------------------

const KEYS: readonly PageKey[] = ['down', 'up', 'escape', 'return', 'types', 'other'];
const DRAFTS: readonly (readonly [string, EditorState])[] = [
  ['empty', EMPTY],
  ['one line', ONE_LINE],
  ['multi-line, cursor on its first line', MULTI_TOP],
  ['multi-line, cursor on its last line', MULTI_BOTTOM],
];
/** The three places the focus can be, as the reducer reads them (a row by its index among `rowCount`). */
const FOCUSES = [
  { name: 'start-prompt', page: 'start', rowIndex: undefined },
  { name: 'first row', page: 'work', rowIndex: 0 },
  { name: 'middle row', page: 'work', rowIndex: 1 },
  { name: 'last row', page: 'work', rowIndex: 2 },
  { name: 'docked-prompt', page: 'work', rowIndex: undefined },
] as const;

/** What the design says a key does in a state (the brief's table), written out once and independently of the reducer. */
function expected(key: PageKey, state: PageKeyState): PageKeyOutcome {
  const pass: PageKeyOutcome = { kind: 'pass' };
  if (state.paletteOpen) return pass;
  if (state.page === 'start') {
    if (key !== 'down' || !state.canContinue || !cursorOnLastLine(state.draft)) return pass;
    return { kind: 'to-work', focus: state.rowCount > 0 ? 'rows' : 'docked-prompt' };
  }
  if (state.rowIndex !== undefined && state.rowIndex < state.rowCount) {
    if (key === 'escape') return { kind: 'to-start' };
    if (key === 'return') return { kind: 'open-row' };
    if (key === 'up') return state.rowIndex === 0 ? { kind: 'to-start' } : { kind: 'step-row', delta: -1 };
    if (key === 'down')
      return state.rowIndex === state.rowCount - 1
        ? { kind: 'to-docked', afterwards: 'none' }
        : { kind: 'step-row', delta: 1 };
    return { kind: 'to-docked', afterwards: 'type' };
  }
  if (key === 'escape') return { kind: 'to-start' };
  if (key === 'up' && state.rowCount > 0 && cursorOnFirstLine(state.draft)) return { kind: 'to-last-row' };
  return pass;
} // prettier-ignore

/** Every state the reducer can be asked about: 5 places × 4 drafts × palette × something to continue × rows or none. */
function allStates(): PageKeyState[] {
  const states: PageKeyState[] = [];
  for (const focus of FOCUSES)
    for (const [, draft] of DRAFTS)
      for (const paletteOpen of [false, true])
        for (const canContinue of [true, false])
          for (const rowCount of [3, 0]) {
            // a row is focused only where there are rows; with nothing to continue there is no work page
            if (focus.rowIndex !== undefined && rowCount === 0) continue;
            if (focus.page === 'work' && !canContinue) continue;
            states.push({
              page: focus.page,
              rowIndex: focus.rowIndex,
              rowCount,
              draft,
              paletteOpen,
              canContinue,
            });
          }
  return states;
}

describe('reducePageKey: every key in every state', () => {
  const states = allStates();

  it('covers every key in every state the Home can be in', () => {
    // the landing: 4 drafts × palette × something to continue × rows or none (32); the work page: 4 places with rows and the docked prompt
    // without them, × 4 drafts × palette (40)
    expect(states).toHaveLength(72);
    expect(states.length * KEYS.length).toBe(432);
  });

  it.each(KEYS)('`%s` does in every state what the design says', (key) => {
    for (const state of states)
      expect(reducePageKey(key, state), `${key} in ${JSON.stringify(state)}`).toEqual(
        expected(key, state),
      );
  });

  it('an open palette takes every key, `Esc` included: it closes first and the page stays', () => {
    for (const state of states.filter((candidate) => candidate.paletteOpen))
      for (const key of KEYS) expect(reducePageKey(key, state)).toEqual({ kind: 'pass' });
  });

  it('nothing is lost and there is no dead state: on the work page every place has a key that leaves it, and the landing has `↓`', () => {
    for (const state of states.filter((candidate) => !candidate.paletteOpen)) {
      const leaves = KEYS.map((key) => reducePageKey(key, state)).filter(
        (outcome) => outcome.kind !== 'pass',
      );
      if (state.page === 'work') expect(leaves.length, JSON.stringify(state)).toBeGreaterThan(0);
      else if (state.canContinue && cursorOnLastLine(state.draft))
        expect(leaves).toEqual([
          { kind: 'to-work', focus: state.rowCount > 0 ? 'rows' : 'docked-prompt' },
        ]);
    }
  });

  it('property: from any state of the work page, `Esc` then `↓` is the work page again (the palette closed, the cursor on the draft’s last line)', () => {
    for (const state of states.filter(
      (candidate) =>
        candidate.page === 'work' && !candidate.paletteOpen && cursorOnLastLine(candidate.draft),
    )) {
      expect(reducePageKey('escape', state)).toEqual({ kind: 'to-start' });
      const landing: PageKeyState = { ...state, page: 'start', rowIndex: undefined };
      expect(reducePageKey('down', landing).kind, JSON.stringify(state)).toBe('to-work');
    }
  });

  it('`↓` with a draft lands on the FIRST row, the draft kept (the reducer moves only the focus)', () => {
    const landing: PageKeyState = {
      page: 'start',
      rowIndex: undefined,
      rowCount: 3,
      draft: ONE_LINE,
      paletteOpen: false,
      canContinue: true,
    };
    expect(reducePageKey('down', landing)).toEqual({ kind: 'to-work', focus: 'rows' });
    expect(
      reducePageKey('down', { ...landing, draft: MULTI_TOP }),
      'the cursor moves first',
    ).toEqual({
      kind: 'pass',
    });
  });

  it('with nothing to continue `↓` does nothing at all (there is no work page)', () => {
    for (const draft of [EMPTY, ONE_LINE])
      expect(
        reducePageKey('down', {
          page: 'start',
          rowIndex: undefined,
          rowCount: 0,
          draft,
          paletteOpen: false,
          canContinue: false,
        }),
      ).toEqual({ kind: 'pass' });
  });

  it('a work page with nothing that can be focused (display rows only) lands on the docked prompt, and `↑` there has no row to go to', () => {
    const landing: PageKeyState = {
      page: 'start',
      rowIndex: undefined,
      rowCount: 0,
      draft: EMPTY,
      paletteOpen: false,
      canContinue: true,
    };
    expect(reducePageKey('down', landing)).toEqual({ kind: 'to-work', focus: 'docked-prompt' });
    expect(reducePageKey('up', { ...landing, page: 'work' })).toEqual({ kind: 'pass' });
  });
});

// ---- The indicator ----------------------------------------------------------------------------------------------------------

const snapshotOf = (over: Partial<HomeSnapshot> = {}): HomeSnapshot => ({
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: false,
  ...over,
});
const run = (id: string) => ({
  runId: id,
  workflowSlug: 'wf',
  status: 'completed' as const,
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: undefined,
  totalCostMicrocents: 0,
});
const session = (id: string) => ({
  sessionId: id,
  workingDir: '/w',
  title: id,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended' as const,
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});

describe('the indicator says the true totals of this directory (MVP-11 unit 7)', () => {
  it("counts the snapshot's totals, never the rows a list loaded or a section draws", () => {
    // Two failed rows, five unreadable runs, two sessions and two runs are LOADED; the store counted 40 under Attention (32 parked runs
    // among them), 12 sessions and 9 runs. The indicator says the store's numbers.
    const snapshot = snapshotOf({
      failedRuns: [run('f1'), run('f2')],
      unreadableRuns: ['u1', 'u2', 'u3', 'u4', 'u5'].map((runId) => ({
        runId,
        reason: 'corrupt-row' as const,
      })),
      recentSessions: [session('s1'), session('s2')],
      recentRuns: [run('r1'), run('r2')],
      totals: { attention: 40, sessions: 12, runs: 9 },
    });
    expect(workCounts(snapshot)).toEqual({ attention: 40, sessions: 12, runs: 9 });
    // More unreadable runs than the section draws at 80×24 (its cap is four rows) are still each counted.
    expect(snapshot.unreadableRuns.length).toBeGreaterThan(4);
  });

  it('says `1 needs you` for one and `2 need you` for two', () => {
    expect(needsYouWords(1)).toBe('1 needs you');
    expect(needsYouWords(2)).toBe('2 need you');
    expect(needsYouWords(12)).toBe('12 need you');
  });

  it.each([
    [{ attention: 1, sessions: 2, runs: 2 }, '↓ 1 needs you', '2 sessions', '2 runs'],
    [{ attention: 0, sessions: 1, runs: 3 }, '↓ 1 session', undefined, '3 runs'],
    [{ attention: 0, sessions: 0, runs: 1 }, '↓ 1 run', undefined, undefined],
    [{ attention: 2, sessions: 0, runs: 0 }, '↓ 2 need you', undefined, undefined],
  ] as const)('%j: the `↓` stands on the first count, a zero count is not drawn', (counts, head, s, r) => {
    const parts = indicatorParts(counts);
    expect(parts && `${String(parts.head.keys)} ${parts.head.verb}`).toBe(head);
    expect(parts?.sessions && 'text' in parts.sessions ? parts.sessions.text : undefined).toBe(s);
    expect(parts?.runs && 'text' in parts.runs ? parts.runs.text : undefined).toBe(r);
    expect(parts?.head.role === 'warn').toBe(counts.attention > 0);
  }); // prettier-ignore

  it('has nothing to say when there is nothing to continue', () => {
    expect(indicatorParts({ attention: 0, sessions: 0, runs: 0 })).toBeUndefined();
  });
});

// ---- The landing's hint -------------------------------------------------------------------------------------------------------

const landing = (over: {
  counts?: WorkCounts;
  draft?: EditorState;
  keyless?: boolean;
  runCanBeShown?: boolean;
  armed?: boolean;
  columns?: number;
}): HintRow =>
  landingHint(
    {
      interruptArmed: over.armed === true,
      draft: over.draft ?? EMPTY,
      keyless: over.keyless === true,
      runCanBeShown: over.runCanBeShown === true,
      counts: over.counts ?? { attention: 0, sessions: 0, runs: 0 },
      columns: over.columns ?? 74,
    },
    displayWidth,
  );
const H3 = { attention: 1, sessions: 2, runs: 2 };

describe('the landing’s hint', () => {
  it('is the study’s H3 at 80 columns (74 after the margin): the indicator, its counts, the exit', () => {
    expect(landing({ counts: H3 }).text).toBe(
      '[/] commands · ↓ 1 needs you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
    );
  });

  it('marks exactly the attention part for the warning colour', () => {
    const row = landing({ counts: { attention: 2, sessions: 1, runs: 0 } });
    expect(row.warn && row.text.slice(row.warn.from, row.warn.to)).toBe('↓ 2 need you');
    expect(landing({ counts: { attention: 0, sessions: 1, runs: 0 } }).warn).toBeUndefined();
  });

  it('drops the runs first, then the sessions, never the `↓` or the exit, as the row narrows', () => {
    const counts = { attention: 12, sessions: 10, runs: 10 };
    expect(landing({ counts, columns: 200 }).text).toBe(
      '[/] commands · ↓ 12 need you · 10 sessions · 10 runs · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    expect(landing({ counts, columns: 74 }).text).toBe(
      '[/] commands · ↓ 12 need you · 10 sessions · [Ctrl+C] exit (twice)',
    );
    expect(landing({ counts, columns: 62 }).text).toBe(
      '[/] commands · ↓ 12 need you · [Ctrl+C] exit (twice)',
    );
    expect(landing({ counts, columns: 10 }).text, 'what cannot be dropped stays').toBe(
      '[/] commands · ↓ 12 need you · [Ctrl+C] exit (twice)',
    );
    for (const columns of [52, 60, 74, 92, 120]) {
      const row = landing({ counts, columns });
      expect(displayWidth(row.text), `${String(columns)}`).toBeLessThanOrEqual(columns);
      expect(row.text.endsWith('[Ctrl+C] exit (twice)')).toBe(true);
      expect(row.warn && row.text.slice(row.warn.from, row.warn.to)).toBe('↓ 12 need you');
    }
  });

  it('with nothing to continue is the empty Home’s hint, with no `↓` at all', () => {
    expect(landing({ columns: 92 }).text).toBe(
      '[/] commands · type a message to chat · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    expect(landing({}).text).not.toContain('↓');
  });

  it('with no key keeps the call to connect while it fits, and it gives way before the counts do (the status line says it too)', () => {
    expect(landing({ keyless: true, counts: H3, columns: 120 }).text).toBe(
      'Enter connect a provider · [/] commands · ↓ 1 needs you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
    );
    expect(landing({ keyless: true, counts: H3 }).text).toBe(
      '[/] commands · ↓ 1 needs you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)',
    );
    expect(landing({ keyless: true, columns: 92 }).text).toBe(
      'Enter connect a provider · [/] commands · Tab fill the example · [Ctrl+C] exit (twice)',
    );
    expect(
      landing({ keyless: true }).text,
      'nothing to continue: the call stays, the example goes',
    ).toBe('Enter connect a provider · [/] commands · [Ctrl+C] exit (twice)');
  });

  it('with a draft says the draft’s keys, then the indicator’s `↓`, which `[Ctrl+J] newline` gives way to', () => {
    expect(landing({ draft: ONE_LINE, counts: H3, columns: 120 }).text).toBe(
      'Enter start the chat · [Ctrl+J] newline · ↓ 1 needs you · [Ctrl+C] exit (twice)',
    );
    // MVP-11 unit 7, round 1 (OB73): at 80 columns the cue stays and the newline key goes (it was the other way round).
    expect(landing({ draft: ONE_LINE, counts: H3 }).text).toBe(
      'Enter start the chat · ↓ 1 needs you · [Ctrl+C] exit (twice)',
    );
    expect(landing({ draft: editor('/mod'), counts: H3, columns: 120 }).text).toBe(
      'Enter run · [Ctrl+J] newline · ↓ 1 needs you · [Ctrl+C] exit (twice)',
    );
    expect(landing({ draft: ONE_LINE, keyless: true }).text).toBe(
      'Enter connect a provider · your message is kept · [Ctrl+C] exit (twice)',
    );
  });

  it('leaves `Enter show it` to the run’s own row, and armed says only the second `Ctrl+C`', () => {
    expect(landing({ runCanBeShown: true, counts: H3 }).text).not.toContain('show it');
    expect(landing({ runCanBeShown: true, keyless: true }).text, 'Enter shows the run first').not.toContain(
      'connect',
    );
    expect(landing({ armed: true, counts: H3 })).toEqual({ text: '[Ctrl+C] exit (again)' });
  }); // prettier-ignore
});

// ---- The work page's hint -----------------------------------------------------------------------------------------------------

const work = (over: {
  row?: Parameters<typeof workHint>[0]['row'];
  draft?: EditorState;
  keyless?: boolean;
  runCanBeShown?: boolean;
  hasRows?: boolean;
  armed?: boolean;
  columns?: number;
}): string =>
  workHint(
    {
      interruptArmed: over.armed === true,
      row: over.row,
      draft: over.draft ?? EMPTY,
      keyless: over.keyless === true,
      runCanBeShown: over.runCanBeShown === true,
      hasRows: over.hasRows ?? true,
      columns: over.columns ?? 74,
    },
    HOSTED_RUN_ENTER_ITEM,
    displayWidth,
  ).text;

describe('the work page’s hint', () => {
  it.each([
    // MVP-11 unit 7: the rows name no key; the hint names the focused row's `Enter` in the maintainer's words, per kind.
    [{ role: 'session' as const }, '↑/↓ select session · Enter resume · type to chat · Esc start page'],
    [{ role: 'failed' as const }, '↑/↓ select · Enter details · type to chat · Esc start page'],
    [{ role: 'recent' as const }, '↑/↓ select · Enter details · type to chat · Esc start page'],
    [{ role: 'unreadable' as const }, '↑/↓ select · Enter why · type to chat · Esc start page'],
    [{ role: 'parked' as const, waits: 'approval' as const }, '↑/↓ select · Enter open · type to chat · Esc start page'],
    [{ role: 'parked' as const, waits: 'review' as const }, '↑/↓ select · Enter open · type to chat · Esc start page'],
    [{ role: 'parked' as const, waits: 'budget' as const }, '↑/↓ select · Enter open · type to chat · Esc start page'],
    [{ role: 'parked' as const, waits: 'several' as const }, '↑/↓ select · Enter open · type to chat · Esc start page'],
    [{ role: 'parked' as const, waits: 'input' as const }, '↑/↓ select · Enter show how to answer · type to chat · Esc start page'],
    [{ role: 'parked' as const, waits: 'media' as const }, '↑/↓ select · Enter ask to continue · type to chat · Esc start page'],
    [{ role: 'parked' as const, waits: 'none' as const }, '↑/↓ select · Enter say why · type to chat · Esc start page'],
    [{ role: 'parked' as const, waits: undefined }, '↑/↓ select · Enter open · type to chat · Esc start page'],
  ])('on a row (%j) names the arrows, what `Enter` does there, and the way back last', (row, text) => {
    expect(work({ row })).toBe(text);
  }); // prettier-ignore

  it('on the docked prompt says what `Enter` does with what is typed (frame 08), and the way back', () => {
    expect(work({ draft: ONE_LINE })).toBe(
      'Enter start the chat · ↑ back to the list · Esc start page',
    );
    expect(work({ draft: ONE_LINE, columns: 120 })).toBe(
      'Enter start the chat · ↑ back to the list · [Ctrl+J] newline · Esc start page',
    );
    expect(work({ draft: editor('/mod') })).toBe(
      'Enter run · ↑ back to the list · [Ctrl+J] newline · Esc start page',
    );
    expect(work({ draft: ONE_LINE, keyless: true, columns: 120 })).toBe(
      'Enter connect a provider · your message is kept · ↑ back to the list · Esc start page',
    );
    expect(work({ draft: ONE_LINE, keyless: true }), '84 columns: `↑` gives way').toBe(
      'Enter connect a provider · your message is kept · Esc start page',
    );
  });

  it('on the empty docked prompt says what `Enter` does on an empty prompt: the run, the setup, or nothing (the palette’s key instead)', () => {
    expect(work({})).toBe('[/] commands · ↑ back to the list · Esc start page');
    expect(work({ keyless: true })).toBe(
      'Enter connect a provider · ↑ back to the list · Esc start page',
    );
    expect(work({ runCanBeShown: true, keyless: true })).toBe(
      'Enter show it · ↑ back to the list · Esc start page',
    );
  });

  it('names `↑` only when there is a row to go back to, and armed only the second `Ctrl+C`', () => {
    expect(work({ hasRows: false })).toBe('[/] commands · Esc start page');
    expect(work({ armed: true, row: { role: 'session' } })).toBe('[Ctrl+C] exit (again)');
  });

  it('fits the row at 80 columns in every state', () => {
    for (const draft of [EMPTY, ONE_LINE, editor('/mod')])
      for (const keyless of [false, true])
        for (const runCanBeShown of [false, true])
          expect(displayWidth(work({ draft, keyless, runCanBeShown }))).toBeLessThanOrEqual(74);
  });
});

describe('the work page’s list region', () => {
  it('is 17 rows at 80×24 with the docked prompt (the way back and the five rows of the block are the rest of 23: no blank row under the way back below 26 rows) and 22 at 100×30 (with it)', () => {
    expect(workListRows(24, 5)).toBe(17);
    expect(workListRows(25, 5)).toBe(18);
    expect(workListRows(26, 5)).toBe(18);
    expect(workListRows(30, 5)).toBe(22);
  });

  it('keeps the blank row under the way back from 26 terminal rows: whitespace gives way before words', () => {
    expect([24, 25, 26, 30].map((rows) => workHeadRows(rows))).toEqual([1, 1, 2, 2]);
    expect(workHeadRows(Number.NaN)).toBe(1);
  });

  it('gives a notice its rows and its blank row, and is never negative', () => {
    expect(workListRows(24, 5, 4)).toBe(12);
    expect(workListRows(24, 30)).toBe(0);
    expect(workListRows(Number.NaN, 5)).toBe(0);
  });
});
