/**
 * Stored text that dresses up as the Home's own words, DRAWN (MVP-11 unit 7, round 2: F3 and F4). The oracle is the frame of the real `HomeView`
 * (the view `RootApp` mounts), read with its styling removed, and, at 120 columns, the screen of a real `RootApp` over a real controller in a
 * terminal emulator (the Ink test renderer is 100 columns wide). The code point tables are walked exhaustively in `home-lookalike-text.test.ts`;
 * here the wiring is proved on the real page, with one code point or more of every range:
 *
 * - **F3, page 2.** A session's title or agent, a workflow's slug, an agent's name and a run's id are stored text. Each started a row, and a row
 *   with no lead glyph starts in the marker column, where the allocator draws `▲ N more` and `▼ N more`. A name that began with a triangle (any
 *   of the lookalikes, or the plain form's `v N more`) drew a second marker. No row but the allocator's own may begin like a marker, and no
 *   lookalike triangle may stand anywhere else on the page.
 * - **F4, page 1.** The most urgent item's name is on the hint row, whose `↓` is the only arrow on it and whose keys are the hint's own. No other
 *   arrow, triangle or return key survives in the name, and no bracket (the CJK, mathematical and fullwidth ones included) around a key word.
 */
import { vi } from 'vitest';

// Ink draws colour only when the terminal supports it, and the test runs on none: the level is forced before ink is first loaded.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import { glyphOf } from './glyphs.js';
import {
  ARROW_LOOKALIKE_RANGES,
  BRACKET_PAIR_RANGES,
  type ParkedRunRow,
} from './home-attention.js';
import { classOfRanges, MARKER_LOOKALIKE_RANGES, type CodeRange } from './home-projection.js';
import { homeContentColumns } from './home-notice.js';
import { HomeView } from './home-view.js';
import { mountHome } from './surface-matrix/home-host.js';
import { displayWidth } from './viewport.js';
import { yieldBetweenTests } from '../event-loop.test-support.js';

// this file's tests run for seconds back to back: the event loop turns between them (`../event-loop.test-support.ts`)
yieldBetweenTests();

afterEach(cleanup);

const ch = (code: number): string => String.fromCodePoint(code);
/** The fullwidth square brackets `［` and `］`: the scrub folds them to the ASCII pair, so they are not a range of the table. */
const FULLWIDTH_OPEN = 0xff3b;
const FULLWIDTH_CLOSE = 0xff3d;
const ESC = ch(0x1b);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const LOOKALIKE = new RegExp(`[${classOfRanges(MARKER_LOOKALIKE_RANGES)}]`, 'u');
const ARROW = new RegExp(`[${classOfRanges(ARROW_LOOKALIKE_RANGES)}]`, 'gu');
const NON_ASCII_BRACKET = new RegExp(
  `[${ch(FULLWIDTH_OPEN)}${ch(FULLWIDTH_CLOSE)}${classOfRanges(BRACKET_PAIR_RANGES)}]`,
  'u',
);

/** The first, the middle and the last code point of each range: the wiring is shown for each range, the tables walk every code point. */
const picks = (ranges: readonly CodeRange[]): number[] => [
  ...new Set(ranges.flatMap(([from, to]) => [from, Math.floor((from + to) / 2), to])),
];

// ---- page 2 (F3) ------------------------------------------------------------------------------------------------------------------

const run = (id: string, slug: string | undefined, status: HomeRunRow['status']): HomeRunRow => ({
  runId: id,
  workflowSlug: slug,
  status,
  createdAt: ago(30),
  startedAt: ago(30),
  completedAt: ago(20),
  totalCostMicrocents: 0,
});
const sessionRow = (id: string, title: string | undefined, agent: string): HomeSessionRow => ({
  sessionId: id,
  title,
  agentSlug: agent,
  modelId: undefined,
  status: 'ended',
  updatedAt: ago(10),
  totalCostMicrocents: 0,
});

/**
 * A page with `value` in every stored field a row draws: a session's title, an untitled session's agent, a failed run's, a parked run's, a
 * recent run's and an unreadable run's workflow, a run named by its id, an agent. The totals exceed what is loaded, so the allocator draws its
 * own `▼ N more` markers beside them.
 */
function pageWith(value: string): {
  readonly snapshot: HomeSnapshot;
  readonly parked: readonly ParkedRunRow[];
} {
  const snapshot: HomeSnapshot = {
    failedRuns: [run('f1000000-0000-4000-8000-000000000000', value, 'failed')],
    recentSessions: [
      sessionRow('s1', value, 'chat'),
      sessionRow('s2', undefined, value),
      sessionRow('s3', 'Plain title', 'chat'),
    ],
    recentRuns: [
      run('r1000000-0000-4000-8000-000000000000', value, 'completed'),
      run(value, undefined, 'completed'),
      run('r3000000-0000-4000-8000-000000000000', 'plain-flow', 'completed'),
    ],
    recentAgents: [{ agentSlug: value, lastUsedAt: ago(5) }],
    unreadableRuns: [
      {
        runId: `u1-${value}`,
        workflowSlug: value,
        status: 'failed',
        createdAt: ago(40),
        reason: 'corrupt-row',
      },
    ],
    totals: { attention: 4, sessions: 9, runs: 9 },
    isEmpty: false,
  };
  const parked: readonly ParkedRunRow[] = [
    { runId: `p-${value}`, kind: 'approval', gates: 1, workflow: value },
  ];
  return { snapshot, parked };
}

function workPage(value: string, color: boolean, cols = 100, rows = 50): string[] {
  const { snapshot, parked } = pageWith(value);
  const view = render(
    <HomeView
      page="work"
      snapshot={snapshot}
      parkedRuns={parked}
      editor={{ text: '', cursor: 0 }}
      nowMs={NOW}
      cols={cols}
      rows={rows}
      color={color}
      alternateScreen
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame.replace(SGR, '').split('\n');
}

/** The lines that begin like one of the allocator's markers, in the glyph form the page is in: a lookalike triangle, or the plain form's `^` or `v` and a number. */
function markerLikeLines(lines: readonly string[], color: boolean): string[] {
  const plain = new RegExp(
    `^(?:${glyphOf('moreAbove', !color).replace('^', '\\^')}|${glyphOf('moreBelow', !color)}) \\d`,
    'u',
  );
  return lines
    .map((line) => line.trim())
    .filter((line) => LOOKALIKE.test(line.slice(0, 2)) || plain.test(line));
}

describe('F3: a name that begins like the overflow marker cannot draw a second one', () => {
  const triangles = picks(MARKER_LOOKALIKE_RANGES);

  it('the page carries the allocator’s own markers (the control the hostile pages are compared with)', () => {
    for (const color of [true, false]) {
      const own = markerLikeLines(workPage('plain-name', color), color);
      expect(own.length, `colour ${String(color)}`).toBeGreaterThanOrEqual(2);
      expect(own.every((line) => /^\S \d+ more/u.test(line))).toBe(true);
    }
  });

  it.each([100, 80])(
    'every range, at %i columns, colour on: no triangle of a name stands on the page',
    (cols) => {
      const control = markerLikeLines(workPage('plain-name', true, cols, 40), true);
      for (const code of triangles) {
        const lines = workPage(`${ch(code)} 9 more · /resume`, true, cols, 40);
        expect(markerLikeLines(lines, true), `U+${code.toString(16)}`).toEqual(control);
        // no lookalike anywhere but the allocator's own marker rows
        const elsewhere = lines.filter(
          (line) => LOOKALIKE.test(line) && !control.includes(line.trim()),
        );
        expect(elsewhere, `U+${code.toString(16)}`).toEqual([]);
        // the words stay, so the row still says what it was: the name without its triangle
        expect(lines.some((line) => line.includes('9 more - /resume'))).toBe(true);
      }
    },
  );

  it('the same in the middle of a name, and after a lead glyph', () => {
    const lines = workPage(`release ${ch(0x25bc)} 3 more`, true);
    expect(
      lines
        .filter((line) => line.includes(ch(0x25bc)))
        .every((line) => /^\s*▼ \d+ more/u.test(line)),
    ).toBe(true);
    expect(lines.some((line) => line.includes('release   3 more'))).toBe(true);
  });

  it.each(['v 9 more', '^ 9 more', 'V 9 MORE'])(
    'colour off: the plain form `%s` is not a marker either',
    (value) => {
      const control = markerLikeLines(workPage('plain-name', false), false);
      const lines = workPage(value, false);
      expect(markerLikeLines(lines, false)).toEqual(control);
      expect(lines.some((line) => line.includes('9 more') || line.includes('9 MORE'))).toBe(true);
    },
  );

  it.each([[true], [false]])(
    'a name of nothing but triangles leaves a row that names its other fields (colour %s)',
    (color) => {
      const all = MARKER_LOOKALIKE_RANGES.flatMap(([from, to]) =>
        Array.from({ length: to - from + 1 }, (_, offset) => ch(from + offset)),
      ).join('');
      const lines = workPage(all, color);
      expect(markerLikeLines(lines, color)).toEqual(
        markerLikeLines(workPage('plain-name', color), color),
      );
      expect(
        lines.filter((line) => LOOKALIKE.test(line) && !/^\s*[▲▼] \d+ more/u.test(line)),
      ).toEqual([]);
    },
  );

  it('F4 on page 2: every row stays one line at its width, with the brackets and arrows of the corpus in every field', () => {
    for (const cols of [80, 100]) {
      const rows = cols === 80 ? 24 : 30;
      for (const color of [true, false]) {
        const value = `${ch(0x3010)}Enter${ch(0x3011)} ${ch(0x2b07)} ${ch(0x27e6)}Esc${ch(0x27e7)} ${ch(0x25bc)} 3 more`;
        const lines = workPage(value, color, cols, rows);
        expect(lines, 'the page is one row shorter than the terminal').toHaveLength(rows - 1);
        for (const line of lines) expect(displayWidth(line.trimEnd())).toBeLessThanOrEqual(cols);
        expect(markerLikeLines(lines, color)).toEqual(
          markerLikeLines(workPage('plain-name', color, cols, rows), color),
        );
      }
    }
  });
});

// ---- page 1 (F4) ------------------------------------------------------------------------------------------------------------------

const failedRow: HomeRunRow = {
  runId: 'f1000000-0000-4000-8000-000000000000',
  workflowSlug: 'other',
  status: 'failed',
  createdAt: ago(120),
  startedAt: undefined,
  completedAt: ago(120),
  totalCostMicrocents: 0,
};
const landing: HomeSnapshot = {
  failedRuns: [failedRow],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 3, sessions: 4, runs: 5 },
  isEmpty: false,
};
const parkedWith = (workflow: string): ParkedRunRow => ({
  runId: 'p1000000-0000-4000-8000-000000000000',
  kind: 'approval',
  gates: 1,
  workflow,
  expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
});

/** The hint row of page 1 at 80 or 100 columns, in the Ink test renderer. */
function hintRowAt(workflow: string, cols: number, draft: string, color: boolean): string {
  const view = render(
    <HomeView
      page="start"
      snapshot={landing}
      parkedRuns={[parkedWith(workflow)]}
      editor={{ text: draft, cursor: draft.length }}
      nowMs={NOW}
      cols={cols}
      rows={cols === 80 ? 24 : 40}
      color={color}
      alternateScreen
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return (frame.split('\n').find((row) => row.includes('[Ctrl+C] exit')) ?? '').replace(SGR, '');
}

/** The hint row at 120 columns, drawn by the surface matrix's terminal emulator. */
async function hintRowAt120(workflow: string, draft: string, color: boolean): Promise<string> {
  const home = mountHome(
    { renderer: 'alt', color, size: { cols: 120, rows: 40 } },
    {
      snapshot: landing,
      props: { nowMs: () => NOW },
      deps: {
        gateCards: {
          list: () => [parkedWith(workflow)],
          read: () => undefined,
          resume: () => new Promise(() => {}),
          guard: { settleMs: 0, quietMs: 0, typeaheadMs: 0, lockoutMs: 0 },
        },
      },
    },
  );
  try {
    await home.settle();
    for (const key of draft) home.key(key);
    await home.settle();
    return (
      home
        .text()
        .split('\n')
        .find((row) => row.includes('[Ctrl+C] exit')) ?? ''
    );
  } finally {
    home.unmount();
  }
}

/** The keys of the hint's own grammar: a bracketed one, or the plain ones the legend writes unbracketed, or an arrow, at the start of an item. */
const KEY_ITEM = /^(?:\[[^\]]+\]|Enter\b|Esc\b|Tab\b|↑|↓|PgUp|PgDn)/u;
const OWN_BRACKETED = new Set(['[/]', '[Ctrl+C]', '[Ctrl+J]']);

/** What a hint row must be, whatever a stored workflow name brought. */
function expectOnlyTheHintsOwn(row: string, cols: number, draft: string, label: string): void {
  const text = row.trimEnd();
  const first = draft === '' ? '[/] commands' : 'Enter start the chat';
  expect(text, `${label}: one row`).not.toContain('\n');
  expect(displayWidth(text.trim()), label).toBeLessThanOrEqual(homeContentColumns(cols));
  const items = text.trim().split(' · ');
  expect(items[0], label).toBe(first);
  expect(items.at(-1), label).toBe('[Ctrl+C] exit (twice)');
  // the one arrow of the row is the head's `↓`: no other arrow, triangle or return key
  expect(text.match(ARROW) ?? [], `${label}: arrows`).toEqual(['↓']);
  // no bracket of another script, and no bracketed key but the hint's own
  expect(text, `${label}: brackets`).not.toMatch(NON_ASCII_BRACKET);
  const bracketed = (text.match(/\[[^\]]*\]/gu) ?? []).filter((key) => !OWN_BRACKETED.has(key));
  expect(bracketed, `${label}: bracketed keys`).toEqual([]);
  // the keys the row names are exactly the hint's own: its first item's, the one `↓` and the exit
  const keys = items.filter((item) => KEY_ITEM.test(item)).map((item) => item.split(' ')[0]);
  const own = keys.filter((key) => key !== '[Ctrl+J]');
  expect(own, label).toEqual([first.split(' ')[0], '↓', '[Ctrl+C]']);
}

const WORDS = ['Enter', 'Esc', 'Ctrl+Y', 'Ctrl+N', 'Tab', '/'] as const;
/** A pair of each kind: the ASCII one, the fullwidth one and the first pair of each range. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['[', ']'],
  [ch(FULLWIDTH_OPEN), ch(FULLWIDTH_CLOSE)],
  ...BRACKET_PAIR_RANGES.map(([from]): readonly [string, string] => [ch(from), ch(from + 1)]),
];
const SURFACES = [
  ['an empty prompt', ''],
  ['a draft', 'hello there'],
] as const;

/**
 * The names drawn: the middle code point of each range of the arrow table and the six the report names (`⬇ ⤓ 🡓 ▼ ⟱ ⯆`); and a key word in the
 * brackets of each kind, every one of the six words for the ASCII, the fullwidth and the CJK black lenticular pair, `Enter` for the rest. The
 * tables walk every code point (`home-lookalike-text.test.ts`): here is the wiring of the real page, which a frame costs ~30 ms to prove.
 */
const REPORT_ARROWS = [0x2b07, 0x2913, 0x1f853, 0x25bc, 0x27f1, 0x2bc6];
const ARROW_NAMES: readonly string[] = [
  ...new Set([
    ...ARROW_LOOKALIKE_RANGES.map(([from, to]) => Math.floor((from + to) / 2)),
    ...REPORT_ARROWS,
  ]),
].map((code) => `${ch(code)} release ${ch(code)} notes`);
const BRACKET_NAMES: readonly string[] = PAIRS.flatMap(([open, close], index) =>
  (index < 3 ? WORDS : (['Enter'] as const)).map((word) => `${open}${word}${close} open`),
);
const SLOW = 120_000;

describe.each([80, 100])('F4: page 1 at %i columns', (cols) => {
  describe.each(SURFACES)('with %s', (_surface, draft) => {
    it.each([true, false])(
      'an arrow, an arrowhead, a triangle or a return key in the name, colour %s',
      (color) => {
        for (const name of ARROW_NAMES)
          expectOnlyTheHintsOwn(hintRowAt(name, cols, draft, color), cols, draft, name);
      },
      SLOW,
    );

    it.each([true, false])(
      'a key word in the brackets of every script, colour %s',
      (color) => {
        for (const name of BRACKET_NAMES)
          expectOnlyTheHintsOwn(hintRowAt(name, cols, draft, color), cols, draft, name);
      },
      SLOW,
    );
  });
});

describe.each(SURFACES)(
  'F4: page 1 at 120 columns (the terminal emulator) with %s',
  (_surface, draft) => {
    it.each([true, false])(
      'an arrow, a triangle or a bracketed key word in the name, colour %s',
      async (color) => {
        for (const name of [...ARROW_NAMES, ...BRACKET_NAMES].filter((_, index) => index % 2 === 0))
          expectOnlyTheHintsOwn(await hintRowAt120(name, draft, color), 120, draft, name);
      },
      SLOW,
    );
  },
);
