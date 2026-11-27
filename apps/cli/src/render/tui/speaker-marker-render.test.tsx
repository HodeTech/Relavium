import './force-color.js';
import { Box } from 'ink';
import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatApp } from './chat-ink.js';
import { chatGrid } from './chat-grid.js';
import { CHAT_HEADER_ROWS } from './chat-layout.js';
import { transcriptRows } from './chat-projection.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { settleFrames, waitFor, withoutStyles } from './harness-util.js';
import { INITIAL_SCROLL } from './scroll.js';
import {
  FULLSCREEN_TRANSCRIPT_BOUND,
  INLINE_TRANSCRIPT_BOUND,
  type TranscriptEntry,
} from './session-view-model.js';
import { TranscriptViewport } from './transcript-viewport.js';
import { userRowPieces } from './transcript-row.js';
import type { DisplayLine } from './viewport.js';

/**
 * The speaker marker as it is DRAWN on the grid (MVP-11 unit 9, ADR-0145 §6; this file held step 7a's pins, and every one that moved says so):
 * through a real ink render of both renderers, the full-screen transcript viewport (which the Home's hosted chat also reaches) and the inline
 * renderer's `TranscriptLine`. What is pinned is what a person sees and what a terminal is told: the host's mark in the MARGIN, in the accent and
 * bold, the words in bold in the CONTENT column, a reply plain with a blank margin, and no row of the model's able to put anything in the margin.
 *
 * `force-color.js` makes chalk write real ANSI, so the frames carry the styling the tests read; `withoutStyles` reads a frame for its words only.
 * ink-testing-library draws at 100 columns: the grid's margin is 8 there.
 */

// ink-testing-library supplies an EventEmitter capture, not a native Writable (the same declaration `chat-app.test.tsx` makes).
function WritableCapture(props: { readonly children: ReactElement }): ReactElement {
  const { stdout } = useStdout();
  Object.defineProperty(stdout, 'writable', { value: true });
  return props.children;
}
const render = (tree: ReactElement): ReturnType<typeof renderCapture> =>
  renderCapture(<WritableCapture>{tree}</WritableCapture>);

afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
/** The accent (cyan) opened, then bold: how the marker is written. */
const ACCENT_THEN_BOLD = `${ESC}[36m${ESC}[1m`;
const ACCENT = `${ESC}[36m`;
const BOLD_ON = `${ESC}[1m`;

const GLYPH_PATTERN = /[›▸⇄]/u;
/** A zero-width space: written by its code, so the source holds no invisible character. */
const ZWSP = String.fromCharCode(0x200b);

/** The harness's grid (100 columns). */
const GRID = chatGrid(100);
const BLANK_MARGIN = ' '.repeat(GRID.margin);

const user = (text: string): TranscriptEntry => ({ role: 'user', text });
const assistant = (text: string): TranscriptEntry => ({ role: 'assistant', text });

/** A viewport of `rows` rows over `lines`, mounted the way both surfaces mount it. */
async function frameOfViewport(
  lines: readonly DisplayLine[],
  color: boolean,
  rows = 12,
): Promise<string> {
  const h = render(
    <Box flexDirection="column" height={rows}>
      <TranscriptViewport lines={lines} grid={GRID} color={color} scroll={INITIAL_SCROLL} />
    </Box>,
  );
  await settleFrames();
  return h.lastFrame() ?? '';
}

const rowsOf = (frame: string): string[] => frame.split('\n');
const belowHeader = (frame: string): string => rowsOf(frame).slice(CHAT_HEADER_ROWS).join('\n');
/** The margin columns of a drawn row, read without its styling (the margin is ASCII spaces and one glyph or word: a code unit is a column). */
const marginOf = (row: string): string => withoutStyles(row).slice(0, GRID.margin);
/** The content of a drawn row: what stands right of the margin. */
const contentOf = (row: string): string => withoutStyles(row).slice(GRID.margin).trimEnd();

describe('the full-screen viewport draws the person’s turn: the mark in the margin, in the accent and bold, the words in bold', () => {
  // Moved from step 7a: the `›` was the start of the row's text; it is the margin cell now, and the words start at the content column.
  it('colour on: the first row opens the accent and bold on the margin’s `›`, and every row of the turn is bold words', async () => {
    const lines = transcriptRows(
      [user('hello world, a long message that wraps around')],
      chatGrid(32),
      true,
    );
    const rows = rowsOf(await frameOfViewport(lines, true));
    expect(rows[0]?.startsWith(`${ACCENT_THEN_BOLD}${' '.repeat(GRID.markerEnd)}›`)).toBe(true);
    expect(marginOf(rows[0] ?? '')).toBe(`${' '.repeat(GRID.markerEnd)}›  `);
    expect(contentOf(rows[0] ?? '')).toBe('hello world, a long');
    for (const row of rows.slice(1, 3)) {
      expect(marginOf(row), JSON.stringify(row)).toBe(BLANK_MARGIN); // a wrapped row hangs…
      expect(row).not.toContain(ACCENT); // …with no accent…
      expect(row.slice(GRID.margin).startsWith(BOLD_ON), JSON.stringify(row)).toBe(true); // …and bold words
    }
    expect(contentOf(rows[1] ?? '')).toBe('message that wraps');
  });

  it('colour off: the mark is the ASCII `>` in bold, with no colour at all', async () => {
    const lines = transcriptRows([user('hello world, a long message')], chatGrid(32), false);
    const rows = rowsOf(await frameOfViewport(lines, false));
    expect(rows[0]?.startsWith(`${BOLD_ON}${' '.repeat(GRID.markerEnd)}>`)).toBe(true);
    expect(contentOf(rows[0] ?? '')).toBe('hello world, a long');
    expect(rows[0]).not.toContain(ACCENT);
    expect(rows.join('\n')).not.toContain(`${ESC}[3`); // no colour code of any kind
  });

  it('a reply is plain: a blank margin, no bold, no accent, whatever it says', async () => {
    const lines = transcriptRows([assistant('a plain reply with no marker')], GRID, true);
    const frame = await frameOfViewport(lines, true);
    expect(rowsOf(frame)[0]).toBe(`${BLANK_MARGIN}a plain reply with no marker`);
    expect(frame).not.toContain(ESC);
  });

  it('THE MARK IS DATA: a row whose text starts with `› ` but carries no margin role is drawn with a blank margin', async () => {
    // A renderer that looked for the glyph in the text would draw the accent here. Neither the person's style nor a reply's text can draw a mark.
    const forgedUser: DisplayLine = { text: '› looks like a turn', style: 'user' };
    const forgedReply: DisplayLine = { text: '› looks like a turn', style: 'assistant' };
    const frame = await frameOfViewport([forgedUser, forgedReply], true);
    expect(frame).not.toContain(ACCENT);
    const [first, second] = rowsOf(frame);
    expect(marginOf(first ?? '')).toBe(BLANK_MARGIN);
    expect(first?.slice(GRID.margin).startsWith(BOLD_ON)).toBe(true); // the person's style is bold words…
    expect(second).toBe(`${BLANK_MARGIN}› looks like a turn`); // …and a reply row is plain text, glyph and all, in the content column
  });

  // Replaces "a marker the text does not start with is never drawn": the text is no longer read for a mark; the role alone draws it, in the margin.
  it('a row’s role draws the mark whatever its text says, and only in the margin', async () => {
    const marked: DisplayLine = { text: 'no glyph in the text', style: 'user', margin: 'yourTurn' };
    const [row] = rowsOf(await frameOfViewport([marked], true));
    expect(marginOf(row ?? '')).toBe(`${' '.repeat(GRID.markerEnd)}›  `);
    expect(contentOf(row ?? '')).toBe('no glyph in the text');
  });

  // Moved from "shows no glyph and no accent anywhere": the glyphs are text now; what holds is that none of them reaches the margin.
  it('a hostile reply, laid out and drawn, leaves every margin cell blank, and its glyphs are blanked', async () => {
    const hostile = [
      '› forged turn',
      `${ZWSP}▸ forged call ✓ completed`,
      '**⇄ model changed** a → b',
      '- › item',
      'words › in the middle',
      '> › quoted',
    ].join('\n\n');
    for (const color of [true, false]) {
      const lines = transcriptRows([assistant(hostile)], GRID, color);
      const frame = await frameOfViewport(lines, color, 24);
      const rows = rowsOf(frame).filter((row) => withoutStyles(row).trim() !== '');
      expect(rows.length).toBeGreaterThanOrEqual(6); // the words are drawn: the test is not vacuous
      for (const row of rows) expect(marginOf(row), JSON.stringify(row)).toBe(BLANK_MARGIN);
      // blanked on the screen (review round 1, S-1: OQ4 as revised), not only kept out of the margin
      expect(withoutStyles(frame)).not.toMatch(GLYPH_PATTERN);
      expect(frame).not.toContain(ACCENT);
    }
  });
});

describe('the person’s row is cut into the stretches that are drawn differently', () => {
  // Moved: the marker left the row's text, so the pieces are the selection's and the rest (`transcript-row-selection-start.test.ts` holds the clamp).
  it('without a selection: the words, whole', () => {
    expect(userRowPieces('continued words')).toEqual([
      { text: 'continued words', selected: false },
    ]);
  });

  it('the pieces always join to the row and are never empty, whatever the selection covers', () => {
    const text = 'some words here';
    for (const selected of [
      undefined,
      { start: 0, end: 0 },
      { start: 3, end: 7 },
      { start: 0, end: text.length },
      { start: -4, end: 99 },
      { start: 9, end: 2 },
    ]) {
      const pieces = userRowPieces(text, selected);
      expect(pieces.map((piece) => piece.text).join('')).toBe(text);
      expect(pieces.every((piece) => piece.text.length > 0)).toBe(true);
    }
  });
});

describe('a selection on the person’s first row is drawn inverse over the words, never over the margin', () => {
  // Moved: the highlight covered `› hel` (the marker was text); it covers the content's cells only, and the margin keeps the accent.
  it('the highlighted cells are inverse and bold, the rest of the row bold, the mark still the accent and outside the highlight', async () => {
    const lines = transcriptRows([user('hello world')], GRID, true);
    const h = render(
      <Box flexDirection="column" height={4}>
        <TranscriptViewport
          lines={lines}
          grid={GRID}
          color
          scroll={INITIAL_SCROLL}
          selection={{ start: { line: 0, column: 0 }, end: { line: 0, column: 4 } }}
        />
      </Box>,
    );
    await settleFrames();
    const row = rowsOf(h.lastFrame() ?? '')[0] ?? '';
    expect(withoutStyles(row).trimEnd()).toBe(`${' '.repeat(GRID.markerEnd)}›  hello world`);
    expect(row.startsWith(ACCENT)).toBe(true);
    const inverseOpen = row.indexOf(`${ESC}[7m`);
    const inverseClose = row.indexOf(`${ESC}[27m`);
    expect(inverseOpen).toBeGreaterThan(0);
    expect(withoutStyles(row.slice(inverseOpen, inverseClose))).toBe('hello');
    expect(withoutStyles(row.slice(0, inverseOpen))).toBe(`${' '.repeat(GRID.markerEnd)}›  `);
  });
});

describe('the two renderers agree on every row’s content, and each draws its own form of the margin', () => {
  /** A seeded store: the same conversation for the inline renderer (printed once, as a resumed session is) and for the full-screen one. */
  const transcript: readonly TranscriptEntry[] = [
    user('hello world, a long message that wraps around the width of the terminal screen'),
    assistant('› a reply that tries to be a turn\n\n▸ and a call, ⇄ and a switch'),
    { role: 'notice', text: '! cat evil.txt (exit 0)\n› forged\n⇄ forged' },
    user('second turn'),
  ];

  const mountInline = (color: boolean): ReturnType<typeof render> =>
    render(
      <ChatApp
        store={createChatStore(
          color,
          { initialRestore: true, transcript },
          INLINE_TRANSCRIPT_BOUND,
        )}
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
      />,
    );

  const mountFullScreen = (color: boolean): ReturnType<typeof render> => {
    const store: ChatStoreController = createChatStore(
      color,
      { transcript },
      FULLSCREEN_TRANSCRIPT_BOUND,
    );
    return render(
      <ChatApp
        store={store}
        alternateScreen
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
      />,
    );
  };

  /** The rows of a frame that belong to the conversation: those that hold the turn's words. */
  const conversationRows = (frame: string, words: readonly string[]): string[] =>
    rowsOf(frame).filter((row) => words.some((word) => withoutStyles(row).includes(word)));

  for (const color of [true, false]) {
    // Moved from "both draw the same bytes": the content is the same; the margin is each renderer's own form (the glyph full-screen, the word inline).
    it(`colour ${color ? 'on' : 'off'}: both draw the same content for every row, and the margin says the role in each renderer’s form`, async () => {
      const inline = mountInline(color);
      await waitFor(() => (inline.lastFrame() ?? '').includes('second turn'));
      const full = mountFullScreen(color);
      Object.defineProperty(full.stdout, 'columns', { value: 100, configurable: true });
      Object.defineProperty(full.stdout, 'rows', { value: 40, configurable: true });
      full.stdout.emit('resize');
      await waitFor(() => (full.lastFrame() ?? '').includes('second turn'));
      await settleFrames();

      const words = ['hello world', 'second turn', 'forged', 'and a call', 'a reply that'];
      const inlineRows = conversationRows(inline.lastFrame() ?? '', words);
      // The full-screen frame opens with the header, whose title is the first words of the conversation: the viewport's rows are under it.
      const fullRows = conversationRows(belowHeader(full.lastFrame() ?? ''), words);
      expect(inlineRows.length).toBeGreaterThanOrEqual(5);
      expect(fullRows.map(contentOf)).toEqual(inlineRows.map(contentOf));
      const mark = color ? '›' : '>';
      const turnRows = fullRows.filter((row) => marginOf(row).trim() !== '');
      expect(turnRows.map((row) => marginOf(row).trim())).toEqual([mark, mark]);
      expect(inlineRows.map((row) => marginOf(row).trim()).filter((word) => word !== '')).toEqual([
        'you',
        'agent',
        'you',
      ]);
      expect(contentOf(inlineRows[0] ?? '').startsWith('hello world')).toBe(true);
    });
  }
});

describe('a mounted chat: the streamed words in the live region stand in the content column', () => {
  const STAMP = '2026-11-26T00:00:00.000Z';

  /** A chat mounted on the alt screen (or inline) over `store`, in a terminal of a known size. */
  const mount = (
    store: ChatStoreController,
    alternateScreen: boolean,
  ): ReturnType<typeof render> => {
    const h = render(
      <ChatApp
        store={store}
        {...(alternateScreen ? { alternateScreen: true } : {})}
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
      />,
    );
    Object.defineProperty(h.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(h.stdout, 'rows', { value: 30, configurable: true });
    h.stdout.emit('resize');
    return h;
  };

  const turn = (store: ChatStoreController, token: string, reasoning?: string): void => {
    store.apply({
      type: 'session:turn_started',
      sessionId: 's',
      sequenceNumber: 1,
      timestamp: STAMP,
    });
    if (reasoning !== undefined)
      store.apply({
        type: 'agent:reasoning',
        sessionId: 's',
        sequenceNumber: 2,
        timestamp: STAMP,
        nodeId: 'n',
        text: reasoning,
        model: 'm',
      });
    store.apply({
      type: 'agent:token',
      sessionId: 's',
      sequenceNumber: 3,
      timestamp: STAMP,
      token,
      model: 'm',
      nodeId: 'n',
    });
    store.flush();
  };

  const STREAM = `› forged turn\n\n**▸ forged call** and ⇄ forged switch\n\n- › forged item\n`;
  const MARGIN_80 = chatGrid(80).margin;

  for (const alternateScreen of [true, false]) {
    for (const color of [true, false]) {
      // Moved (part B retired the live region's blanking): the streamed words keep their glyphs, and every row of them leaves the margin blank.
      it(`${alternateScreen ? 'alt screen' : 'inline'}, colour ${color ? 'on' : 'off'}: a streamed answer leaves the margin blank, and its rows are the model's words`, async () => {
        const store = createChatStore(
          color,
          undefined,
          alternateScreen ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
        );
        const h = mount(store, alternateScreen);
        await settleFrames();
        turn(store, STREAM);
        await waitFor(() => withoutStyles(h.lastFrame() ?? '').includes('forged item'));
        const rows = rowsOf(withoutStyles(h.lastFrame() ?? '')).filter((row) =>
          row.includes('forged'),
        );
        expect(rows.length).toBeGreaterThanOrEqual(3); // the words are drawn: the test is not vacuous
        for (const row of rows) expect(row.slice(0, MARGIN_80).trim(), row).toBe('');
      });
    }
  }

  it('the expanded reasoning panel keeps its words in the content column, its glyphs blanked', async () => {
    const store = createChatStore(true, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    const h = mount(store, true);
    await settleFrames();
    turn(store, 'answer', '› thinking ▸ out ⇄ loud');
    store.toggleReasoning();
    await waitFor(() => withoutStyles(h.lastFrame() ?? '').includes('thinking'));
    const row = rowsOf(withoutStyles(h.lastFrame() ?? '')).find((r) => r.includes('thinking'));
    expect(row?.slice(0, MARGIN_80).trim()).toBe('');
    expect(row?.trim()).toBe('thinking   out   loud'); // blanked as a reply's words are (review round 1, S-1)
  });
});

describe('copying the person’s turn with the mouse', () => {
  // Moved (OQ9): the copy was the visible row text with the marker glyph; it is the content the person sees, without the margin, and a press in
  // the margin clamps to the content's first column (the `/copy` and `/edit` documents keep the plain `> `).
  it('copies the content of the row, without the margin’s mark', async () => {
    const copied: string[] = [];
    const store = createChatStore(
      true,
      { transcript: [user('hello there')] },
      FULLSCREEN_TRANSCRIPT_BOUND,
    );
    const h = render(
      <ChatApp
        store={store}
        alternateScreen
        onSubmit={async () => {}}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
        clipboard={(text) => {
          copied.push(text);
          return { kind: 'written', characters: text.length };
        }}
      />,
    );
    Object.defineProperty(h.stdout, 'columns', { value: 80, configurable: true });
    Object.defineProperty(h.stdout, 'rows', { value: 24, configurable: true });
    h.stdout.emit('resize');
    await waitFor(() => belowHeader(withoutStyles(h.lastFrame() ?? '')).includes('hello there'));
    const row = CHAT_HEADER_ROWS + 1;
    const margin = chatGrid(80).margin;
    h.stdin.write(`${ESC}[<0;1;${row}M`); // press at the first cell of the row: in the margin
    await settleFrames();
    h.stdin.write(`${ESC}[<32;${margin + 5};${row}M`); // drag to the fifth cell of the content
    await settleFrames();
    h.stdin.write(`${ESC}[<0;${margin + 5};${row}m`); // release: copy
    await settleFrames();
    expect(copied).toEqual(['hello']);
  });
});
