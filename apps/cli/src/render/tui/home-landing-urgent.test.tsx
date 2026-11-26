/**
 * Page 1 names the most urgent item (MVP-11 unit 7, the maintainer's ruling 5): `↓ release-notes needs approval · expires in 5m · +2 more need
 * you`, then the true session and run counts. The name is STORED text (a workflow's slug) on a NEW terminal sink, the landing's hint row:
 * scrubbed (`flowLine`), its brackets made parentheses and its arrows blanked, bounded, and fitted, so no bracket, separator, arrow or answer
 * chord a stored name brings can draw a key hint or another item of the row. The oracle is the drawn hint row of the real `HomeView`, read
 * item by item at its own separators, at 80, 100 and 120 columns, with an empty prompt and with a draft.
 */
import { vi } from 'vitest';

// Ink draws colour only when the terminal supports it, and the test runs on none: the level is forced before ink is first loaded.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeRunRow, HomeSnapshot } from '../../home/home-store.js';
import type { ParkedRunRow } from './home-attention.js';
import { URGENT_NAME_COLUMNS } from './home-attention.js';
import { homeContentColumns } from './home-notice.js';
import { HomeView } from './home-view.js';
import { mountHome } from './surface-matrix/home-host.js';
import { displayWidth } from './viewport.js';

afterEach(cleanup);

const ch = (code: number): string => String.fromCodePoint(code);
const ESC = ch(0x1b);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');
const BIDI_OR_INVISIBLE = new RegExp(
  `[${ch(0x061c)}${ch(0x200b)}-${ch(0x200f)}${ch(0x202a)}-${ch(0x202e)}${ch(0x2060)}-${ch(0x2069)}${ch(0xfeff)}]`,
  'u',
);
const NOW = Date.parse('2026-11-26T12:00:00.000Z');

const HOSTILE: Readonly<Record<string, string>> = {
  'an ESC sequence': `rel${ESC}[2J${ESC}[31mease`,
  'an OSC 8 link': `${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`,
  'a bidirectional override': `abc${ch(0x202e)}edom otua${ch(0x202c)}def`,
  'a fake `[Enter] open`': 'x [Enter] open',
  'a fake chord': 'x [Ctrl+Y] allow',
  'a separator': 'x · Esc start page · y',
  'an arrow head': '↓ 9 need you',
  'a 500-character name': 'n'.repeat(500),
  'a wide-character name': '日本語のワークフロー'.repeat(6),
  'a newline': 'one\nanthropic · evil',
  'a key': `sk-ant-api03-${'A'.repeat(90)}`,
};

const failed: HomeRunRow = {
  runId: 'f1000000-0000-4000-8000-000000000000',
  workflowSlug: 'other',
  status: 'failed',
  createdAt: '2026-11-26T10:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-26T10:00:00.000Z',
  totalCostMicrocents: 0,
};
const snapshot: HomeSnapshot = {
  attention: { failedRuns: [failed] },
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
  expiresAt: '2026-11-26T12:05:00.000Z',
});

function hintRow(workflow: string, cols: number, draft: string, color = false): string {
  const view = render(
    <HomeView
      page="start"
      snapshot={snapshot}
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
  const rows = frame.split('\n');
  return rows.find((row) => row.includes('[Ctrl+C] exit')) ?? '';
}

/** The items of a hint row, at the legend's own separator. */
const itemsOf = (row: string): string[] => row.replace(SGR, '').trim().split(' · ');
/** An item that names a key: a bracketed key, or a plain key the grammar writes unbracketed, at its start. */
const KEY_ITEM = /^(?:\[[^\]]+\]|Enter\b|Esc\b|Tab\b|↑|↓|PgUp|PgDn)/u;

/**
 * The hint row of the landing at 120×40, drawn by the surface matrix's terminal emulator (the Ink test renderer is 100 columns wide): the
 * parked run is the controller's own read, through the gate-card port, as `driveHome` wires it; a draft is typed key by key.
 */
async function hintRowAt120(workflow: string, draft: string): Promise<string> {
  const home = mountHome(
    { renderer: 'alt', color: false, size: { cols: 120, rows: 40 } },
    {
      snapshot,
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

/** What a hint row must be, whatever a stored workflow name brought, at `cols` columns with `draft` typed. */
function expectNoForgery(row: string, cols: number, draft: string): void {
  const first = draft === '' ? '[/] commands' : 'Enter start the chat';
  const text = row.replace(SGR, '');
  expect(text, 'no escape is left').not.toContain(ESC);
  expect(text).not.toMatch(BIDI_OR_INVISIBLE);
  expect(text, 'one row').not.toContain('\n');
  expect(displayWidth(text.trimEnd()), 'within the terminal').toBeLessThanOrEqual(cols);
  const items = itemsOf(text);
  expect(items[0]).toBe(first);
  expect(items.at(-1)).toBe('[Ctrl+C] exit (twice)');
  // The keys the row names are exactly the hint's own: its first item's, (with a draft, where it fits) `[Ctrl+J]`, the one `↓` and the exit.
  const keys = items.filter((item) => KEY_ITEM.test(item)).map((item) => item.split(' ')[0]);
  const own = draft === '' ? keys : keys.filter((key) => key !== '[Ctrl+J]');
  expect(own).toEqual([first.split(' ')[0], '↓', '[Ctrl+C]']);
  expect(text.match(/↓/gu), 'the head’s own arrow is the only one').toHaveLength(1);
  expect(text).not.toMatch(/\[Enter\]|\[Ctrl\+Y\]|↑/u);
  expect(text, 'no key from a value').not.toMatch(/sk-ant-api03-[A]{6}/u);
  // The name stays inside its bound.
  const head = items.find((item) => item.startsWith('↓')) ?? '';
  expect(displayWidth(head)).toBeLessThanOrEqual(
    2 + URGENT_NAME_COLUMNS + ' needs approval'.length,
  );
  expect(displayWidth(text.trim())).toBeLessThanOrEqual(homeContentColumns(cols));
}

const SURFACES = [
  ['an empty prompt', ''],
  ['a draft', 'hello there'],
] as const;

describe.each([80, 100])('at %i columns', (cols) => {
  describe.each(SURFACES)('with %s', (_surface, draft) => {
    it.each(Object.entries(HOSTILE))('a workflow name with %s cannot forge a key, an item or a row', (_name, value) => {
      expectNoForgery(hintRow(value, cols, draft), cols, draft);
    }); // prettier-ignore
  });
});

describe.each(SURFACES)('at 120 columns (the terminal emulator), with %s', (_surface, draft) => {
  it.each(Object.entries(HOSTILE))('a workflow name with %s cannot forge a key, an item or a row', async (_name, value) => {
    expectNoForgery(await hintRowAt120(value, draft), 120, draft);
  }); // prettier-ignore
});

describe('the head with a plain name', () => {
  it('reads `↓ release-notes needs approval · expires in 5m · +2 more need you` and the counts where the row has room, the head in the warning colour', async () => {
    const plain = (await hintRowAt120('release-notes', '')).trim();
    // 112 columns after the margin: the example and the counts give way (126 with them), the head keeps its deadline and the others
    expect(plain).toBe(
      '[/] commands · ↓ release-notes needs approval · expires in 5m · +2 more need you · [Ctrl+C] exit (twice)',
    );
    // The drawn colour, at 100 columns (the head and the words that stay with it are one span in the warning colour).
    const coloured = hintRow('release-notes', 100, '', true);
    expect(coloured).toContain(
      `${ESC}[33m↓ release-notes needs approval · +2 more need you${ESC}[39m`,
    );
  });

  it('gives way, as the row narrows, in this order: the counts, the deadline, then `need you`, then the name is cut; the `↓` and the count never', () => {
    const at = (cols: number): string => hintRow('release-notes', cols, '').replace(SGR, '').trim();
    // 92 columns after the margin: with its deadline the head is 104 wide, so the counts go, then the deadline
    expect(at(100)).toBe('[/] commands · ↓ release-notes needs approval · +2 more need you · [Ctrl+C] exit (twice)');
    // 74: then `need you`, then the name is cut to the eight columns the row leaves it
    expect(at(80)).toBe('[/] commands · ↓ release… needs approval · +2 more · [Ctrl+C] exit (twice)');
  }); // prettier-ignore

  it('an overdue item is drawn red, and says `expired` in words too', () => {
    const view = render(
      <HomeView
        page="start"
        snapshot={snapshot}
        parkedRuns={[{ ...parkedWith('release-notes'), expiresAt: '2026-11-26T11:00:00.000Z' }]}
        editor={{ text: '', cursor: 0 }}
        nowMs={NOW}
        cols={120}
        rows={40}
        color
        alternateScreen
      />,
    );
    const row = (view.lastFrame() ?? '').split('\n').find((line) => line.includes('needs approval')) ?? '';
    view.unmount();
    expect(row).toContain(`${ESC}[31m↓ release-notes needs approval · expired · +2 more need you`);
  }); // prettier-ignore
});
