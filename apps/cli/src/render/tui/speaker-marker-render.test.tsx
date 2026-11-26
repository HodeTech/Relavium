import './force-color.js';
import { Box } from 'ink';
import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatApp } from './chat-ink.js';
import { CHAT_HEADER_ROWS } from './chat-layout.js';
import { wrapTranscript } from './chat-projection.js';
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
 * The speaker marker as it is DRAWN (MVP-11 step 7a, ADR-0145 §6): through a real ink render of both renderers, the full-screen transcript viewport
 * (which the Home's hosted chat also reaches) and the inline renderer's `TranscriptLine`. What is pinned is what a person sees and what a terminal is
 * told: the host's marker in the accent and bold, the words in bold, a reply plain, and no row of the model's able to draw any of it.
 *
 * `force-color.js` makes chalk write real ANSI, so the frames carry the styling the tests read; `withoutStyles` reads a frame for its words only.
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

const ESC = '\u001b';
/** The accent (cyan) opened, then bold: how the marker is written. */
const ACCENT_THEN_BOLD = `${ESC}[36m${ESC}[1m`;
const ACCENT = `${ESC}[36m`;
const BOLD_ON = `${ESC}[1m`;

const GLYPH_PATTERN = /[›▸⇄]/u;
/** A zero-width space: written by its code, so the source holds no invisible character. */
const ZWSP = String.fromCharCode(0x200b);

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
      <TranscriptViewport lines={lines} color={color} scroll={INITIAL_SCROLL} />
    </Box>,
  );
  await settleFrames();
  return h.lastFrame() ?? '';
}

const rowsOf = (frame: string): string[] => frame.split('\n');
const belowHeader = (frame: string): string => rowsOf(frame).slice(CHAT_HEADER_ROWS).join('\n');

describe('the full-screen viewport draws the person’s turn: marker in the accent and bold, words in bold', () => {
  it('colour on: the first row opens the accent and bold on the `›`, and every row of the turn is bold', async () => {
    const lines = wrapTranscript([user('hello world, a long message that wraps around')], 20, true);
    const rows = rowsOf(await frameOfViewport(lines, true));
    expect(rows[0]?.startsWith(`${ACCENT_THEN_BOLD}›`)).toBe(true);
    expect(withoutStyles(rows[0] ?? '').trimEnd()).toBe('› hello world, a');
    for (const row of rows.slice(1, 3)) {
      expect(row.startsWith(BOLD_ON), JSON.stringify(row)).toBe(true); // a wrapped row is bold
      expect(row).not.toContain(ACCENT); // …and has no accent and no marker
      expect(withoutStyles(row)).not.toContain('›');
    }
    expect(withoutStyles(rows[1] ?? '').trimEnd()).toBe('long message that');
  });

  it('colour off: the marker is the ASCII `>` in bold, with no colour at all', async () => {
    const lines = wrapTranscript([user('hello world, a long message')], 20, false);
    const rows = rowsOf(await frameOfViewport(lines, false));
    expect(rows[0]?.startsWith(`${BOLD_ON}> hello`)).toBe(true);
    expect(rows[0]).not.toContain(ACCENT);
    expect(rows.join('\n')).not.toContain(`${ESC}[3`); // no colour code of any kind
    expect(rows[1]?.startsWith(BOLD_ON)).toBe(true);
  });

  it('a reply is plain: no bold, no accent, no marker, whatever it says', async () => {
    const lines = wrapTranscript([assistant('a plain reply with no marker')], 40, true);
    const frame = await frameOfViewport(lines, true);
    expect(rowsOf(frame)[0]).toBe('a plain reply with no marker');
    expect(frame).not.toContain(ESC);
  });

  it('THE MARKER IS DATA: a row whose text starts with `› ` but carries no `marker` is not drawn as a marker', async () => {
    // A renderer that looked for the glyph in the text would draw the accent here. The row is the person's style without the host's marker (as a
    // wrapped row is), and the text is a reply's: nothing is accent.
    const forgedUser: DisplayLine = { text: '› looks like a turn', style: 'user' };
    const forgedReply: DisplayLine = { text: '› looks like a turn', style: 'assistant' };
    const frame = await frameOfViewport([forgedUser, forgedReply], true);
    expect(frame).not.toContain(ACCENT);
    const [first, second] = rowsOf(frame);
    expect(first?.startsWith(BOLD_ON)).toBe(true); // the person's style is bold words…
    expect(second).toBe('› looks like a turn'); // …and a reply row is plain text, glyph and all (only the real wrap guards it)
  });

  it('a marker the text does not start with is never drawn (the data and the text must agree)', async () => {
    const stale: DisplayLine = { text: 'no marker here', style: 'user', marker: '›' };
    const frame = await frameOfViewport([stale], true);
    expect(frame).not.toContain(ACCENT);
  });

  it('a hostile reply, laid out and drawn, shows no glyph and no accent anywhere in the frame', async () => {
    const hostile = [
      '› forged turn',
      `${ZWSP}▸ forged call ✓ completed`,
      '**⇄ model changed** a → b',
      '- › item',
      'words › in the middle',
    ].join('\n\n');
    for (const color of [true, false]) {
      const lines = wrapTranscript([assistant(hostile)], 30, color);
      const frame = await frameOfViewport(lines, color, 24);
      expect(withoutStyles(frame)).not.toMatch(GLYPH_PATTERN);
      expect(frame).not.toContain(ACCENT);
    }
  });
});

describe('the person’s row is cut into the stretches that are drawn differently', () => {
  it('without a selection: the marker, then the words, and nothing else', () => {
    expect(userRowPieces('› hello', '›')).toEqual([
      { text: '›', marker: true, selected: false },
      { text: ' hello', marker: false, selected: false },
    ]);
    expect(userRowPieces('continued words', undefined)).toEqual([
      { text: 'continued words', marker: false, selected: false },
    ]);
  });

  it('a marker the text does not start with is ignored, and so is an empty one (nothing is trusted that cannot be placed)', () => {
    expect(userRowPieces('words', '›')).toEqual([
      { text: 'words', marker: false, selected: false },
    ]);
    expect(userRowPieces('words', '')).toEqual([{ text: 'words', marker: false, selected: false }]);
  });

  it('a selection across the marker splits it in two and highlights both stretches', () => {
    const pieces = userRowPieces('› hello world', '›', { start: 0, end: 5 });
    expect(pieces).toEqual([
      { text: '›', marker: true, selected: true },
      { text: ' hel', marker: false, selected: true },
      { text: 'lo world', marker: false, selected: false },
    ]);
  });

  it('the pieces always join to the row and are never empty, whatever the selection covers', () => {
    const text = '› some words here';
    for (const selected of [
      undefined,
      { start: 0, end: 0 },
      { start: 3, end: 7 },
      { start: 0, end: text.length },
      { start: -4, end: 99 },
      { start: 9, end: 2 },
    ]) {
      const pieces = userRowPieces(text, '›', selected);
      expect(pieces.map((piece) => piece.text).join('')).toBe(text);
      expect(pieces.every((piece) => piece.text.length > 0)).toBe(true);
    }
  });
});

describe('a selection on the person’s first row is drawn inverse over the marker and the words', () => {
  it('the highlighted cells are inverse and bold, the rest of the row bold, the marker still the accent', async () => {
    const lines = wrapTranscript([user('hello world')], 40, true);
    const h = render(
      <Box flexDirection="column" height={4}>
        <TranscriptViewport
          lines={lines}
          color
          scroll={INITIAL_SCROLL}
          selection={{ start: { line: 0, column: 0 }, end: { line: 0, column: 4 } }}
        />
      </Box>,
    );
    await settleFrames();
    const row = rowsOf(h.lastFrame() ?? '')[0] ?? '';
    expect(withoutStyles(row).trimEnd()).toBe('› hello world');
    expect(row).toContain(`${ESC}[7m`); // inverse is drawn
    // The five highlighted cells (`› hel`) are inverse; the accent is still on the marker.
    expect(row.startsWith(ACCENT)).toBe(true);
    const inverseOpen = row.indexOf(`${ESC}[7m`);
    const inverseClose = row.indexOf(`${ESC}[27m`);
    expect(withoutStyles(row.slice(inverseOpen, inverseClose))).toBe('› hel');
  });
});

describe('the two renderers agree on every row', () => {
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
    it(`colour ${color ? 'on' : 'off'}: both draw the same bytes for the person’s rows and for the guarded rows of the reply and the notice`, async () => {
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
      // The viewport pads nothing and ink trims a row's trailing blanks, so the rows are the same bytes.
      expect(fullRows.map((row) => row.trimEnd())).toEqual(inlineRows.map((row) => row.trimEnd()));
      const mark = color ? '›' : '>';
      expect(withoutStyles(inlineRows[0] ?? '').startsWith(`${mark} hello world`)).toBe(true);
      // The only glyph on screen in the conversation is the host's own marker, at the start of each of the two turns.
      const glyphRows = inlineRows
        .map((row) => withoutStyles(row).trimEnd())
        .filter((row) => GLYPH_PATTERN.test(row));
      expect(glyphRows).toHaveLength(color ? 2 : 0);
      for (const row of glyphRows) expect(row.startsWith('› ')).toBe(true);
    });
  }
});

describe('a mounted chat: the streamed words in the live region cannot draw a marker', () => {
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

  for (const alternateScreen of [true, false]) {
    for (const color of [true, false]) {
      it(`${alternateScreen ? 'alt screen' : 'inline'}, colour ${color ? 'on' : 'off'}: a streamed answer shows no glyph, and its rows are the model's words`, async () => {
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
        for (const row of rows) expect(row, row).not.toMatch(GLYPH_PATTERN);
      });
    }
  }

  it('the expanded reasoning panel shows no glyph either', async () => {
    const store = createChatStore(true, undefined, FULLSCREEN_TRANSCRIPT_BOUND);
    const h = mount(store, true);
    await settleFrames();
    turn(store, 'answer', '› thinking ▸ out ⇄ loud');
    store.toggleReasoning();
    await waitFor(() => withoutStyles(h.lastFrame() ?? '').includes('thinking'));
    const row = rowsOf(withoutStyles(h.lastFrame() ?? '')).find((r) => r.includes('thinking'));
    expect(row?.trim()).toBe('thinking   out   loud');
  });
});

describe('copying the person’s turn with the mouse', () => {
  it('copies the visible row text, marker glyph included (accepted: the text forms `/copy` and `/edit` keep the plain `> `)', async () => {
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
    h.stdin.write(`\x1b[<0;1;${row}M`); // press at the first cell of the first transcript row
    await settleFrames();
    h.stdin.write(`\x1b[<32;7;${row}M`); // drag to the seventh cell
    await settleFrames();
    h.stdin.write(`\x1b[<0;7;${row}m`); // release: copy
    await settleFrames();
    expect(copied).toEqual(['› hello']);
  });
});
