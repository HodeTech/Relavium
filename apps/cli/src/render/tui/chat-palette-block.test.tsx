import './force-color.js';

import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chatGrid } from './chat-grid.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
  type ChatSetup,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';

/**
 * The `/` palette of a chat, above the prompt ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §4, MVP-11 step 7a), in both hosts and both renderers: the list ends on the row directly above the prompt, the prompt row shows the typed
 * `/query`, the legend is the hint row (the last row of the frame), and there is no query line of the palette's own, no blank row between the
 * list and the prompt and no status line while it is open. The palette takes half the terminal with the prompt block (12 rows at 24, so a
 * window of 9 list lines), and the frame stays at most `rows − 1` rows tall in the alternate screen and inline alike.
 */
afterEach(cleanup);

const HOSTS = ['standalone-chat', 'chat'] as const;
type Host = (typeof HOSTS)[number];

const variant = (renderer: 'alt' | 'inline', cols: number, rows: number): Variant => ({
  renderer,
  color: false,
  size: { cols, rows },
});

const LEGEND = '↑/↓ select · Enter run · Esc close';

/**
 * The block stands in the content column of the grid (unit 9): every row of it begins `margin` columns from the left edge (6 at 80 columns, 8 from
 * 100), and the rule is the content column wide. `at(cols, pattern)` is a row that begins there with `pattern`; `indent` is the same as text.
 */
const at = (cols: number, pattern: string): RegExp =>
  new RegExp(`^ {${String(chatGrid(cols).margin)}}${pattern}`, 'u');
const indent = (cols: number, text: string): string =>
  `${' '.repeat(chatGrid(cols).margin)}${text}`;

/** A conversation of 30 turns, so the full-screen transcript has more than its viewport can show. */
const LONG: ChatSetup = {
  prepare: (store) => {
    for (let turn = 0; turn < 30; turn += 1) {
      store.appendUser(`question ${String(turn)} about the thing`);
      store.notice(`answer ${String(turn)} to it`);
    }
  },
};

async function openPalette(
  host: Host,
  shape: Variant,
  setup: ChatSetup = LONG,
): Promise<ChatMount> {
  const mount =
    host === 'chat' ? await mountHostedChat(shape, setup) : mountStandaloneChat(shape, setup);
  await mount.settle();
  mount.key('/');
  await mount.until(() => mount.text().includes('Enter run'));
  await mount.settle();
  return mount;
}

const isListRow = (row: string): boolean =>
  /^ +(?:> |\s{2})\/[a-z]+ {2,}\S/u.test(row) || /^\s*[▲▼^v] \d+ more/u.test(row);

describe.each(HOSTS)('the palette over a chat, in the %s host', (host) => {
  describe.each([
    [80, 24, 9],
    [100, 30, 12],
  ] as const)('at %s×%s', (cols, rows, listLines) => {
    it('lists the entries directly above the prompt, in a window of half the terminal less the prompt block', async () => {
      const m = await openPalette(host, variant('alt', cols, rows));
      try {
        const frame = m.frame();
        const shown = frame.map((row, index) => `${String(index)}|${row}`).join('\n');
        const promptAt = frame.findIndex((row) => at(cols, '> \\/ ?$').test(row));
        expect(promptAt, shown).toBeGreaterThan(0);
        // The list: contiguous list rows from its first row to the row above the prompt.
        const first = frame.findIndex(isListRow);
        expect(first, shown).toBeGreaterThan(1);
        for (let row = first; row < promptAt; row += 1)
          expect(isListRow(frame[row] ?? ''), `row ${String(row)} of ${shown}`).toBe(true);
        expect(promptAt - first, `the window: ${shown}`).toBe(listLines);
        // Nothing separates the list from the prompt: the row above the prompt is the first entry, highlighted.
        expect(frame[promptAt - 1], shown).toMatch(at(cols, '> \\/models {2,}'));
        // The rule (the content column wide), then the legend as the hint row, the last row of the frame.
        expect(frame[promptAt + 1], shown).toBe(indent(cols, '-'.repeat(chatGrid(cols).content)));
        expect(frame[promptAt + 2], shown).toBe(indent(cols, LEGEND));
        expect(frame, shown).toHaveLength(promptAt + 3);
      } finally {
        m.unmount();
      }
    });

    it('has no query line, no status line and no blank row of its own, and the frame is rows − 1 tall', async () => {
      const m = await openPalette(host, variant('alt', cols, rows));
      try {
        const frame = m.frame();
        const shown = frame.join('\n');
        expect(frame, shown).toHaveLength(rows - 1);
        expect(frame.includes(indent(cols, '/')), 'no line of the query by itself').toBe(false);
        expect(
          frame.some((row) => / · \d+ turns? · /u.test(row)),
          'no status line while it is open',
        ).toBe(false);
        expect(
          frame.filter((row) => row === indent(cols, LEGEND)),
          'the legend once, as the hint row',
        ).toHaveLength(1);
        // The transcript gives way and keeps the rows the header, the list and the prompt block leave: 23 − 2 − list − 3.
        const first = frame.findIndex(isListRow);
        expect(first - 2, 'the transcript viewport').toBe(rows - 1 - 2 - listLines - 3);
      } finally {
        m.unmount();
      }
    });
  });

  it('is windowed inline too, so the frame stays short of the terminal: at most rows − 1 lines at 80×24', async () => {
    // No conversation: what the inline renderer prints into the terminal's own scrollback is not the live frame under test.
    const m = await openPalette(host, variant('inline', 80, 24), {});
    try {
      const frame = m.frame();
      const shown = frame.join('\n');
      expect(frame.length, shown).toBeLessThanOrEqual(23);
      const promptAt = frame.findIndex((row) => at(80, '> \\/ ?$').test(row));
      const first = frame.findIndex(isListRow);
      expect(promptAt - first, `a window of 9 list lines: ${shown}`).toBe(9);
      expect(
        frame.some((row) => /^\s*[▲^] \d+ more/u.test(row)),
        shown,
      ).toBe(true);
      expect(frame.at(-1)).toBe(indent(80, LEGEND));
    } finally {
      m.unmount();
    }
  });

  it('shows what is typed on the prompt row, and follows it', async () => {
    const m = await openPalette(host, variant('alt', 80, 24));
    try {
      m.key('co');
      await m.until(() => m.frame().some((row) => at(80, '> \\/co ?$').test(row)));
      const frame = m.frame();
      const promptAt = frame.findIndex((row) => at(80, '> \\/co ?$').test(row));
      expect(frame[promptAt - 1], frame.join('\n')).toMatch(at(80, '> \\/[a-z]+ {2}'));
      expect(frame.at(-1)).toBe(indent(80, LEGEND));
    } finally {
      m.unmount();
    }
  });

  it('names only the key that closes when nothing matches, on the hint row, with the row of no match on the row above the prompt', async () => {
    const m = await openPalette(host, variant('alt', 80, 24));
    try {
      m.key('zzz');
      await m.until(() => m.text().includes('no matching command'));
      const frame = m.frame();
      const promptAt = frame.findIndex((row) => at(80, '> \\/zzz ?$').test(row));
      expect(frame[promptAt - 1], frame.join('\n')).toBe(indent(80, 'no matching command'));
      expect(frame.at(-1)).toBe(indent(80, 'Esc close'));
    } finally {
      m.unmount();
    }
  });

  it('gives the idle prompt block back when it closes: the status line, the prompt and the idle hint', async () => {
    const m = await openPalette(host, variant('alt', 80, 24));
    try {
      m.key('\u001b');
      // A lone Esc is held back a moment while the input layer rules out an escape sequence: a ceiling on a defect, never a delay anything waits out.
      await vi.waitFor(() => expect(m.text()).not.toContain('Enter run'), {
        timeout: 10_000,
        interval: 15,
      });
      await m.settle();
      const frame = m.frame();
      expect(frame.at(-1)).toMatch(at(80, '\\[/\\] commands · \\[Ctrl\\+C\\] '));
      expect(
        frame.some((row) => /ask mode · /u.test(row)),
        'the status line is back',
      ).toBe(true);
      expect(frame.some((row) => at(80, '> reply to continue').test(row))).toBe(true);
    } finally {
      m.unmount();
    }
  });
});
