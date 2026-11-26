/**
 * OB71 / CO71 (unit 7, round 1): the Home's two prompts had no height bound. A paste of 14 lines took the landing's hint to row 24 of 24, a frame as
 * tall as the terminal, and Ink then clears the whole terminal (`ESC[2J ESC[3J`: the scrollback with it) on EVERY update; on the work page a long
 * draft pushed the list, the rule, the status line and the hint off the screen. Both prompts now draw a draft that does not fit as a window of its
 * rows around the cursor with a `▲/▼ N more` marker (`landingEditorRows`, `workEditorRows`: the chat's window, `prompt-window.ts`), so the frame is
 * ALWAYS `rows − 1` lines or fewer, the cursor row, the rule, the status line and the hint stay, and the whole draft is still what is sent.
 *
 * Drawn frames over the fake terminal (`surface-matrix`), the real renderer in both modes: the lines counted are the lines the terminal holds and the
 * chunks checked are the bytes it was sent.
 */
import { describe, expect, it } from 'vitest';

import type { ScreenCell } from './surface-matrix/terminal.js';
import { KEYS, mountHome, type HomeMount } from './surface-matrix/home-host.js';
import { POPULATED_SNAPSHOT } from './surface-matrix/home-fixtures.js';
import type { Variant } from './surface-matrix/variants.js';
import { WORDMARK } from './home-layout.js';

const CLEAR_TERMINAL = ['\u001b[2J', '\u001b[3J'] as const;
/** How often the slide between the pages is looked at while it lands (its own frames are 40 ms apart, 120 ms in all, on real timers here). */
const SLIDE_POLL_MS = 15;
/** The most polls to wait for it: 150 ms is enough, so this is a bound on a defect and nothing waits it out. */
const SLIDE_MAX_POLLS = 100;
/** A test that opens the Home many times waits for the slide each time. */
const MANY_PASTES_TIMEOUT_MS = 60_000;

const draftOf = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line ${String(index + 1)} of the draft`).join('\n');

const SIZES = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 },
] as const;
const RENDERERS = ['alt', 'inline'] as const;

const variantOf = (renderer: Variant['renderer'], size: Variant['size']): Variant => ({
  renderer,
  color: false,
  size,
});

/** The Home, on the landing or (with something to continue and one `↓`) on the work page, ready for a paste. */
async function openHome(variant: Variant, page: 'start' | 'work'): Promise<HomeMount> {
  const m = mountHome(variant, { snapshot: POPULATED_SNAPSHOT });
  await m.settle();
  if (page === 'work') {
    m.key(KEYS.down);
    for (let poll = 0; poll < SLIDE_MAX_POLLS && !m.frame()[0]?.includes('start page'); poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, SLIDE_POLL_MS));
      await m.settle();
    }
    expect(m.frame()[0]).toContain('start page');
  }
  return m;
}

/** What the paste wrote to the terminal, and the frame it left. */
async function pasteInto(m: HomeMount, text: string): Promise<{ frame: string[]; chunk: string }> {
  const mark = m.raw().length;
  m.controller.handlePaste(text);
  await m.settle();
  return { frame: m.frame(), chunk: m.raw().slice(mark) };
}

const ruleOf = (frame: readonly string[]): number =>
  frame.findIndex((row) => /^ +-{20,}$/u.test(row));
/** The rows of the prompt: those between the last blank-or-gap row before the first draft row and the rule. */
const draftRows = (frame: readonly string[]): string[] =>
  frame.filter((row) => /^\s+(?:> )?(line \d+ of the draft|[\^v] \d+ more)\s*$/u.test(row));
/** Whether the cell at the end of the last draft row is the drawn cursor (an inverse block). */
const cursorAfterLastRow = (m: HomeMount): boolean => {
  const cells: ScreenCell[][] = m.cells();
  const row = cells.find((line) =>
    line
      .map((cell) => cell.char)
      .join('')
      .includes('line 40 of the draft'),
  );
  return row?.some((cell) => cell.style.inverse) ?? false;
};

describe.each(RENDERERS)('a long draft on the Home in the %s renderer', (renderer) => {
  describe.each(SIZES)('at $cols×$rows', (size) => {
    const variant = variantOf(renderer, size);

    it.each(['start', 'work'] as const)(
      'on the %s page, a 40-line paste leaves a frame shorter than the terminal, no clear-terminal, the cursor row and the hint',
      async (page) => {
        const m = await openHome(variant, page);
        try {
          const { frame, chunk } = await pasteInto(m, draftOf(40));
          expect(
            frame.length,
            'a frame as tall as the terminal makes Ink clear it',
          ).toBeLessThanOrEqual(size.rows - 1);
          for (const clear of CLEAR_TERMINAL)
            expect(chunk, JSON.stringify(clear)).not.toContain(clear);
          // The end of the draft, where the cursor is, is on screen, with the cursor cell drawn on it.
          expect(draftRows(frame).at(-1)?.trim()).toBe('line 40 of the draft');
          expect(cursorAfterLastRow(m), 'the cursor cell is drawn').toBe(true);
          // The rule, the status line and the hint are under the draft and on screen.
          const rule = ruleOf(frame);
          expect(rule).toBeGreaterThan(0);
          expect(frame[rule + 1]).toContain('next chat:');
          expect(frame.at(-1)).toContain('Enter start the chat');
          // The window says what it hides: one marker above, counting every row it hides (the marker's own row included).
          const markers = draftRows(frame).filter((row) => /more/u.test(row));
          expect(markers).toHaveLength(1);
          const shown = draftRows(frame).filter((row) => /of the draft/u.test(row)).length;
          const hidden = Number(/(\d+) more/u.exec(markers[0] ?? '')?.[1]);
          expect(
            hidden + shown,
            'every row of the draft is a row shown or one the marker counts',
          ).toBe(40);
        } finally {
          m.unmount();
        }
      },
    );

    it('on the landing the block, the status line and the hint stay: the window is the rows the head leaves', async () => {
      const m = await openHome(variant, 'start');
      try {
        const { frame } = await pasteInto(m, draftOf(40));
        expect(
          frame.some((row) => row.trim() === WORDMARK),
          'the wordmark is still drawn',
        ).toBe(true);
        expect(frame.some((row) => row.includes('Start as an agent'))).toBe(true);
        // The window is the most the landing leaves: 12 rows at 80×24 (the frame's 23, less the 11 of the block and what is under the prompt).
        expect(draftRows(frame).length).toBe(size.rows - 12);
      } finally {
        m.unmount();
      }
    });

    it('on the work page the way back and the first list rows stay: the Attention section does not vanish', async () => {
      const m = await openHome(variant, 'work');
      try {
        const { frame } = await pasteInto(m, draftOf(40));
        expect(frame[0]).toContain('start page');
        expect(frame.some((row) => row.includes('Attention required'))).toBe(true);
        expect(frame.some((row) => row.includes('ship-it'))).toBe(true);
      } finally {
        m.unmount();
      }
    });

    it('a 2,000-character single line is a window of its rows too, with the cursor on its last row', async () => {
      for (const page of ['start', 'work'] as const) {
        const m = await openHome(variant, page);
        try {
          const text = 'word '.repeat(400).trimEnd();
          const { frame, chunk } = await pasteInto(m, text);
          expect(frame.length).toBeLessThanOrEqual(size.rows - 1);
          for (const clear of CLEAR_TERMINAL) expect(chunk).not.toContain(clear);
          expect(
            frame.some((row) => /^\s+[\^v] \d+ more\s*$/u.test(row)),
            'it says what it hides',
          ).toBe(true);
          const rule = ruleOf(frame);
          // the row above the rule ends the text, and the rule, the status line and the hint are there
          expect(frame[rule - 1]?.trimEnd().endsWith('word')).toBe(true);
          expect(frame[rule + 1]).toContain('next chat:');
        } finally {
          m.unmount();
        }
      }
    });
  });
});

/** A seeded stream of numbers in [0, 1): the same prose every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    return state / 0x7f_ff_ff_ff;
  };
}
const proseOf = (words: number, random: () => number): string =>
  Array.from({ length: words }, () => 'x'.repeat(1 + Math.floor(random() * 11))).join(' ');

// Ink wraps at word boundaries, which takes MORE rows than a count of characters over the width: a measured prose paste of 90 to 130 words at 80×24
// drew 24 rows, a frame as tall as the terminal, where the hard wrap of the window counted 12. A draft "fits" only as Ink draws it
// (`wrappedRowCount`), so no paste, however it wraps, makes a frame as tall as the terminal.
describe('prose of any length never makes a frame as tall as the terminal (OB71: Ink wraps by words)', () => {
  // The zone by construction: words of 39 characters, one to a row at the Home's 74 columns (a second would not fit), so the draft takes as many
  // rows as it has words, where the hard wrap of the window packs 72 characters a row and counts about half as many. 13 to 21 words fit the hard
  // wrap's 12 rows and not Ink's.
  it.each(['start', 'work'] as const)(
    'on the %s page, 13 to 21 words that wrap one to a row are a window and the frame stays short',
    async (page) => {
      for (const words of [13, 15, 18, 21]) {
        const m = await openHome(variantOf('alt', { cols: 80, rows: 24 }), page);
        try {
          const { frame, chunk } = await pasteInto(m, Array(words).fill('x'.repeat(39)).join(' '));
          const label = `${String(words)} words`;
          expect(frame.length, label).toBeLessThanOrEqual(23);
          for (const clear of CLEAR_TERMINAL) expect(chunk, label).not.toContain(clear);
          expect(frame.at(-1), label).toContain('Enter start the chat');
        } finally {
          m.unmount();
        }
      }
    },
    MANY_PASTES_TIMEOUT_MS,
  );

  const COUNTS = [60, 90, 110, 130, 150, 200, 400];
  it.each(['start', 'work'] as const)(
    'on the %s page at 80×24, in the full-screen renderer: 21 seeded pastes',
    async (page) => {
      const random = seeded(7);
      const bad: string[] = [];
      for (const words of COUNTS)
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const m = await openHome(variantOf('alt', { cols: 80, rows: 24 }), page);
          try {
            const { frame, chunk } = await pasteInto(m, proseOf(words, random));
            const hint = frame.at(-1)?.includes('Enter start the chat') ?? false;
            if (frame.length > 23 || CLEAR_TERMINAL.some((clear) => chunk.includes(clear)) || !hint)
              bad.push(
                `${String(words)} words: ${String(frame.length)} rows, hint ${String(hint)}`,
              );
          } finally {
            m.unmount();
          }
        }
      expect(bad).toEqual([]);
    },
    MANY_PASTES_TIMEOUT_MS,
  );
});

describe('a draft that fits is drawn as it always was (OB71 leaves what fits alone)', () => {
  it('a 12-line draft on the landing at 80×24 is drawn whole, with no marker, as before', async () => {
    const m = await openHome(variantOf('alt', { cols: 80, rows: 24 }), 'start');
    try {
      const { frame } = await pasteInto(m, draftOf(12));
      expect(draftRows(frame)).toHaveLength(12);
      expect(frame.some((row) => /\d+ more/u.test(row))).toBe(false);
      expect(frame.length).toBe(23);
      expect(frame.at(-1)).toContain('Enter start the chat');
    } finally {
      m.unmount();
    }
  });

  it('a 5-line draft on the work page is drawn whole and the list keeps its rows', async () => {
    const m = await openHome(variantOf('alt', { cols: 80, rows: 24 }), 'work');
    try {
      const { frame } = await pasteInto(m, draftOf(5));
      expect(draftRows(frame)).toHaveLength(5);
      expect(frame.some((row) => /\d+ more/u.test(row))).toBe(false);
      expect(frame.length).toBe(23);
    } finally {
      m.unmount();
    }
  });
});
