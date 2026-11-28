/**
 * The `@` file picker on the Home's two pages, drawn (ADR-0061 on the Home; `mention-home.tsx`): on the landing it opens BELOW the prompt row,
 * which does not move, with the rule under it, the picker's header and list, and its hint on the page's last row in the alternate screen; on
 * the work page it runs up from the docked prompt; the page is never taller than the terminal less its last row, at 80×24 and 100×30, in the
 * alternate screen and inline, with colour and without. A hostile file name (an escape, a bidirectional control, a `▼ 9 more` lookalike, a
 * bracketed key, 500 characters) is drawn through the Home's row scrub, on one row.
 */
import { vi } from 'vitest';

// Ink draws colour only when the terminal supports it, and the test runs on none: the level is forced before ink is first loaded.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { EditorState } from './chat-input.js';
import { HomeView } from './home-view.js';
import { MENTION_HINT } from './home-pages.js';
import type { MentionCandidate, MentionState } from './mention.js';

afterEach(cleanup);

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');
const BIDI = String.fromCharCode(0x202e);
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const EMPTY: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const WITH_SESSION: HomeSnapshot = {
  ...EMPTY,
  recentSessions: [
    {
      sessionId: 's1',
      title: 'An earlier chat',
      agentSlug: 'chat',
      modelId: undefined,
      status: 'ended',
      updatedAt: '2026-11-26T11:00:00.000Z',
      totalCostMicrocents: 0,
    },
  ],
  totals: { attention: 0, sessions: 1, runs: 0 },
  isEmpty: false,
};

const file = (name: string): MentionCandidate => ({ name, type: 'file', path: name });
const FEW: MentionState = {
  dir: '',
  filter: '',
  candidates: [{ name: 'src', type: 'directory', path: 'src' }, file('notes.md'), file('plan.md')],
  selected: 1,
  loading: false,
};
const MANY: MentionState = {
  ...FEW,
  candidates: Array.from({ length: 30 }, (_, i) => file(`file-${String(i).padStart(2, '0')}.md`)),
  selected: 0,
};
const HOSTILE_NAMES = [
  `evil${ESC}[2Jname.md`,
  `rtl${BIDI}txt.md`,
  '▼ 9 more',
  '[Enter] approve.md',
  `${'long-'.repeat(100)}.md`,
];
const HOSTILE: MentionState = { ...FEW, candidates: HOSTILE_NAMES.map(file), selected: 0 };

const DRAFT: EditorState = { text: 'compare ', cursor: 8 };

interface Draw {
  readonly editor?: EditorState;
  readonly mention?: MentionState;
  readonly page?: 'start' | 'work';
  readonly alternateScreen?: boolean;
  readonly color?: boolean;
  readonly snapshot?: HomeSnapshot;
}

function pageOf(size: readonly [number, number], over: Draw): readonly string[] {
  const view = render(
    <HomeView
      snapshot={over.snapshot ?? EMPTY}
      editor={over.editor ?? DRAFT}
      nowMs={NOW}
      cols={size[0]}
      rows={size[1]}
      color={over.color ?? false}
      alternateScreen={over.alternateScreen ?? true}
      showBanner
      page={over.page ?? 'start'}
      mention={over.mention}
    />,
  );
  const lines = (view.lastFrame() ?? '')
    .replace(SGR, '')
    .split('\n')
    .map((row) => row.trimEnd());
  view.unmount();
  return lines;
}

/** The index of the prompt row: the row with the draft. */
const promptRowOf = (page: readonly string[]): number =>
  page.findIndex((row) => /^\s+[>›] compare/u.test(row));

const SIZES = [
  [80, 24],
  [100, 30],
] as const;
const VARIANTS = [
  ['alternate screen', true, false],
  ['alternate screen, colour', true, true],
  ['inline', false, false],
  ['inline, colour', false, true],
] as const;

describe.each(SIZES)('the landing at %i×%i', (cols, rows) => {
  const size = [cols, rows] as const;

  it.each(VARIANTS)(
    '%s: the prompt row does not move, the rule is under it, the page fits rows − 1, the hint is the picker’s',
    (_name, alternateScreen, color) => {
      const rest = pageOf(size, { alternateScreen, color });
      const shown = pageOf(size, { alternateScreen, color, mention: MANY });
      const at = promptRowOf(shown);
      expect(at, 'the prompt row').toBe(promptRowOf(rest));
      expect(shown.slice(0, at)).toEqual(rest.slice(0, at));
      expect(shown[at + 1]?.trim(), 'the rule').toMatch(/^[-─]{10,}…?$/u);
      expect(shown[at + 2]?.trim(), 'the header').toBe('@ ./');
      expect(shown.length).toBeLessThanOrEqual(rows - 1);
      expect(shown[shown.length - 1]?.trim()).toBe(MENTION_HINT);
      if (alternateScreen) expect(shown).toHaveLength(rows - 1);
      // a window of eight rows, its markers counting what it does not show
      const listed = shown.filter((row) => /^\s+(?:\S )?file-\d\d\.md$/u.test(row)).length;
      const hidden = Number(
        shown.map((row) => /^\s+[v▼] (\d+) more$/u.exec(row)?.[1]).find(Boolean) ?? 0,
      );
      expect(listed + hidden).toBe(30);
    },
  );

  it('a short list leaves the hint on the last row with the blank rows after the list (alternate screen), and inline the block is as tall as it is', () => {
    const alt = pageOf(size, { mention: FEW });
    const at = promptRowOf(alt);
    expect(alt.slice(at + 3, at + 6).map((row) => row.trim())).toEqual([
      'src/',
      '> notes.md',
      'plan.md',
    ]);
    expect(alt.slice(at + 6, -1).every((row) => row === '')).toBe(true);
    const inline = pageOf(size, { mention: FEW, alternateScreen: false });
    const inlineAt = promptRowOf(inline);
    expect(inline).toHaveLength(inlineAt + 1 + 1 + 1 + 3 + 1);
  });
});

describe.each(SIZES)('the landing at %i×%i with a long draft', (cols, rows) => {
  const size = [cols, rows] as const;
  const text = ['compare these', 'two', 'three', 'four', 'five', 'six'].join('\n');
  const editor: EditorState = { text, cursor: text.length };

  it.each([
    ['alternate screen', true],
    ['inline', false],
  ] as const)(
    '%s: nothing above the prompt gives way (the prompt does not move); the list takes what is left',
    (_name, alternateScreen) => {
      const rest = pageOf(size, { editor, alternateScreen });
      const shown = pageOf(size, { editor, alternateScreen, mention: MANY });
      const at = promptRowOf(shown);
      expect(at).toBe(promptRowOf(rest));
      expect(shown.slice(0, at)).toEqual(rest.slice(0, at));
      expect(shown.length).toBeLessThanOrEqual(rows - 1);
      expect(shown[shown.length - 1]?.trim()).toBe(MENTION_HINT);
      expect(shown.some((row) => row.trim() === '@ ./')).toBe(true);
      expect(
        shown.some((row) => /file-\d\d\.md$/u.test(row)),
        'at least one row of the list',
      ).toBe(true);
    },
  );
});

describe.each(SIZES)('the work page at %i×%i', (cols, rows) => {
  const size = [cols, rows] as const;

  it.each(VARIANTS)(
    '%s: the picker runs up from the docked prompt, the page fits rows − 1, the hint is the picker’s',
    (_name, alternateScreen, color) => {
      const shown = pageOf(size, {
        page: 'work',
        snapshot: WITH_SESSION,
        alternateScreen,
        color,
        mention: MANY,
      });
      const at = promptRowOf(shown);
      expect(at).toBeGreaterThan(0);
      expect(shown.length).toBeLessThanOrEqual(rows - 1);
      expect(shown[at + 1]?.trim(), 'the rule under the docked prompt').toMatch(/^[-─]{10,}…?$/u);
      expect(shown[at + 2]?.trim()).toBe(MENTION_HINT);
      const header = shown.findIndex((row) => row.trim() === '@ ./');
      expect(header, 'the header is above the prompt').toBeGreaterThan(0);
      expect(header).toBeLessThan(at);
      expect(
        shown.some((row) => row.includes('An earlier chat')),
        'the list region is still drawn',
      ).toBe(true);
    },
  );
});

describe('a hostile file name is drawn through the Home’s row scrub, on one row', () => {
  it.each(SIZES)('at %i×%i', (cols, rows) => {
    const shown = pageOf([cols, rows], { mention: HOSTILE });
    const text = shown.join('\n');
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(BIDI);
    expect(text).not.toContain('[Enter]');
    expect(text).toContain('(Enter) approve.md');
    // no row of the list begins with a marker the window did not draw
    expect(shown.filter((row) => /^\s+[v▼^▲] \d+ more$/u.test(row))).toEqual([]);
    expect(shown.length).toBeLessThanOrEqual(rows - 1);
    // the 500-column name is cut on its one row (the test terminal is 100 columns wide; the real one cuts at its own edge)
    const long = shown.filter((row) => row.includes('long-long'));
    expect(long).toHaveLength(1);
    expect(long[0]?.endsWith('…')).toBe(true);
    expect(cols).toBeGreaterThan(0);
  });
});
