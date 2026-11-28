/**
 * The sheet frame on the drawn grid ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md)
 * §1, §2): the rows a sheet leaves the conversation, derived from the code's own constants; the heavy rule beside the thin one without colour;
 * and what a pending sheet writes to the terminal while it waits (nothing inline, at most a frame a second in the alternate screen).
 *
 * The chat is mounted as `relavium chat` mounts it (`ChatApp` over a store), on a terminal double that records every write.
 */
import type { SessionStreamHandleEvent, ToolApprovalRequest, ToolPreview } from '@relavium/core';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnedTtyInput, OwnedTtyOutput, PlainTtyOutput } from '../../test-support.js';
import { chatGrid } from './chat-grid.js';
import { ChatApp } from './chat-ink.js';
import { CHAT_HEADER_ROWS, chatFrameRows } from './chat-layout.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { CARD_FRAME_HEADER_ROWS, cardRowBudget } from './tool-review-card.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

const REQUEST: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
/** A turn starts: the store's tick flushes on every frame while it runs and is not blocked on the person. */
const TURN: readonly SessionStreamHandleEvent[] = [
  {
    type: 'session:started',
    sessionId: 'grid',
    sequenceNumber: 0,
    timestamp: '2026-11-27T09:00:00.000Z',
    agentRef: 'relavium-chat',
    model: 'claude-sonnet-4-6',
    context: { workingDir: '/w', fsScopeTier: 'sandboxed' },
  },
  {
    type: 'session:turn_started',
    sessionId: 'grid',
    sequenceNumber: 1,
    timestamp: '2026-11-27T09:00:01.000Z',
  },
];
/** A change the card cannot show whole at any size here: it fills the card's whole budget. */
const LONG: ToolPreview = editedFilePreview(100, { 5: 'five', 90: 'ninety' });

// eslint-disable-next-line no-control-regex -- stripping terminal control sequences from a captured frame
const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[78]/gu;

function mount(alternate: boolean, size: { cols: number; rows: number }) {
  const input = new OwnedTtyInput();
  const output = new PlainTtyOutput();
  const stderr = new OwnedTtyOutput();
  output.columns = size.cols;
  output.rows = size.rows;
  const store: ChatStoreController = createChatStore(
    false,
    undefined,
    alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
  );
  for (let n = 1; n <= 40; n += 1) store.appendUser(`message ${String(n)}`);
  const instance = render(
    createElement(ChatApp, {
      store,
      onSubmit: () => Promise.resolve(),
      shouldStop: () => false,
      onExit: () => {},
      onError: () => {},
      onModeChange: () => {},
      alternateScreen: alternate,
    }),
    {
      stdin: input,
      stdout: output,
      stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateScreen: alternate,
    },
  );
  cleanups.push(() => {
    store.sealToolPreviews();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
  });
  const open = (): void => {
    // As in a real turn: the turn runs, and its approval card opens (the turn stays `running` while it waits).
    for (const event of TURN) store.apply(event);
    store
      .requestApproval(REQUEST, true, undefined, { callId: 'grid', preview: LONG })
      .catch(() => undefined);
  };
  /** The last frame written that holds `needle`, as rows, control sequences stripped. */
  const rowsWith = (needle: string): readonly string[] =>
    (
      output.frames
        .map((frame) => frame.replace(CONTROL, ''))
        .filter((frame) => frame.includes(needle))
        .at(-1) ?? ''
    ).split('\n');
  return { store, output, open, rowsWith };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** The start of a synchronized update: one per frame the renderer writes. */
const SYNC_BEGIN = `${String.fromCharCode(27)}[?2026h`;

describe('the rows a docked sheet leaves the conversation, from the code’s constants (ADR-0147 §1)', () => {
  it('the header rows the budget counts are the chat’s own', () => {
    expect(CARD_FRAME_HEADER_ROWS).toBe(CHAT_HEADER_ROWS);
  });

  it.each([
    [80, 24, 12, 9],
    [100, 30, 18, 9],
  ] as const)(
    'at %i×%i a full sheet is %i rows and the conversation keeps %i rows above it',
    async (cols, rows, sheetRows, transcriptRows) => {
      // The arithmetic first: a frame of rows − 1, the header, the transcript, the sheet: nothing else beside them.
      expect(cardRowBudget(rows)).toBe(sheetRows);
      expect(chatFrameRows(rows) - CHAT_HEADER_ROWS - cardRowBudget(rows)).toBe(transcriptRows);
      const m = mount(true, { cols, rows });
      await pause(40);
      m.open();
      await vi.waitFor(() => expect(m.rowsWith('Esc stops the turn').length).toBeGreaterThan(1));
      await pause(40);
      const frame = m.rowsWith('Esc stops the turn');
      const rule = frame.findIndex((row) => row.startsWith('== Approval needed '));
      const last = frame.findLastIndex((row) => row.trim() !== '');
      expect(rule, frame.join('\n')).toBe(CHAT_HEADER_ROWS + transcriptRows);
      expect(last - rule + 1, 'the sheet is its whole budget').toBe(sheetRows);
      expect(last + 1, 'the frame is rows − 1').toBe(chatFrameRows(rows));
      // The transcript's rows are the conversation's: the newest message is the row right above the sheet.
      // (the person's turn marker ends at the grid's marker column, with the two blank columns before the words: unit 9; or the separator row above it)
      const grid = chatGrid(cols);
      expect(frame[rule - 1]).toMatch(
        new RegExp(
          `^ {${String(grid.markerEnd)}}[›>] {${String(grid.margin - grid.markerEnd - 1)}}message 40$|^$`,
          'u',
        ),
      );
      // Nothing of the prompt block is drawn while the sheet is open (its rule stands in the content column, after the margin).
      expect(frame.join('\n')).not.toMatch(/ask mode · \d+ turn|\(twice\)|^ *-{20,}$/mu);
    },
  );

  it('without colour the sheet’s heavy rule is `=` and the chat’s thin rule `-`: the two read apart on the grid', async () => {
    const m = mount(true, { cols: 80, rows: 24 });
    await pause(40);
    const before = m.rowsWith('commands');
    expect(
      // the rule is the content column wide, after exactly the margin (6 columns at 80)
      before.some(
        (row) => row === `${' '.repeat(chatGrid(80).margin)}${'-'.repeat(chatGrid(80).content)}`,
      ),
      'the prompt block’s thin rule',
    ).toBe(true);
    m.open();
    await vi.waitFor(() => expect(m.rowsWith('Esc stops the turn').length).toBeGreaterThan(1));
    const frame = m.rowsWith('Esc stops the turn');
    const rule = frame.find((row) => row.startsWith('== '));
    expect(rule).toMatch(/^== Approval needed =+ waiting 0:\d\d ==$/u);
    expect(rule?.includes('-')).toBe(false);
  });
});

describe('what a pending sheet writes while it waits (ADR-0147 §2: the byte-count regression)', () => {
  /** Write the frame loop's ticks for `ms` (one every 80 ms, the chat's frame rate) and count the bytes and frames written meanwhile. */
  async function waitWithTicks(
    m: ReturnType<typeof mount>,
    ms: number,
  ): Promise<{
    readonly bytes: number;
    readonly frames: number;
    /** The rows of the frame on screen before the wait, then of each frame written during it (the renderer rewrites the whole frame). */
    readonly shown: readonly (readonly string[])[];
  }> {
    const from = m.output.frames.length;
    const timer = setInterval(() => m.store.tick(), 80);
    await pause(ms);
    clearInterval(timer);
    const written = m.output.frames.slice(from).join('');
    const rowsOf = (segment: string): readonly string[] => segment.replace(CONTROL, '').split('\n');
    const before = m.output.frames.slice(0, from).join('').split(SYNC_BEGIN).at(-1) ?? '';
    // A frame is one synchronized update (`ESC [?2026h` … `ESC [?2026l`): the renderer writes each in a few chunks.
    const during = written.split(SYNC_BEGIN).slice(1);
    return {
      bytes: written.length,
      frames: during.length,
      shown: [rowsOf(before), ...during.map(rowsOf)],
    };
  }

  it('inline: the rule says `waiting since HH:MM` and N ticks write ZERO bytes', async () => {
    const m = mount(false, { cols: 80, rows: 24 });
    await pause(40);
    m.open();
    await vi.waitFor(() => expect(m.rowsWith('Esc stops the turn').length).toBeGreaterThan(1));
    await pause(120);
    expect(m.rowsWith('Esc stops the turn').join('\n')).toMatch(
      /^== Approval needed =+ waiting since \d\d:\d\d ==$/mu,
    );
    const written = await waitWithTicks(m, 2500);
    expect(
      { bytes: written.bytes, frames: written.frames },
      'not one byte while the sheet waits',
    ).toEqual({ bytes: 0, frames: 0 });
  });

  it('alternate screen: at most one frame a second, the clock’s, while the frame loop ticks at its own rate', async () => {
    const m = mount(true, { cols: 80, rows: 24 });
    await pause(40);
    m.open();
    await vi.waitFor(() => expect(m.rowsWith('Esc stops the turn').length).toBeGreaterThan(1));
    await pause(120);
    const seconds = 3;
    const written = await waitWithTicks(m, seconds * 1000);
    // Each second the clock's text changes once: one frame per second, against the frame loop's 37 ticks.
    expect(written.frames).toBeGreaterThan(0);
    expect(written.frames).toBeLessThanOrEqual(seconds + 1);
    // And every one of them is the clock's: each frame written differs from the one before it in the sheet's rule row alone, and there only in
    // the clock's text (unit 8 fix wave, D-5: the bytes are the clock's frames and nothing else's).
    for (let index = 1; index < written.shown.length; index += 1) {
      const previous = written.shown[index - 1] ?? [];
      const next = written.shown[index] ?? [];
      expect(next.length, 'the frame keeps its rows').toBe(previous.length);
      const changed = next.flatMap((row, at) => (row === previous[at] ? [] : [at]));
      expect(changed, `frame ${String(index)} changes one row`).toHaveLength(1);
      const row = changed[0] ?? -1;
      expect(next[row]).toMatch(/^== Approval needed =+ waiting 0:\d\d ==$/u);
      expect(next[row]?.replace(/waiting 0:\d\d/u, '')).toBe(
        previous[row]?.replace(/waiting 0:\d\d/u, ''),
      );
    }
    const clock = m.rowsWith('Esc stops the turn').find((row) => row.startsWith('== '));
    expect(clock).toMatch(/waiting 0:0[2-5] ==$/u);
  });
});

describe('the agent’s question and the continue checkpoint wear the clock too (ADR-0147 §1, §2)', () => {
  const QUESTION = {
    questions: [
      {
        header: 'Pick',
        question: 'Which file?',
        multiSelect: false,
        options: [
          { label: 'a.ts', description: 'first' },
          { label: 'b.ts', description: 'second' },
        ],
      },
    ],
  };
  const CARDS = [
    [
      'the agent’s question',
      'Which file?',
      /^== Question from the agent .{1,3} not an approval =+ CLOCK ==$/u,
    ],
    ['the continue checkpoint', 'Stop here', /^== Checkpoint =+ CLOCK ==$/u],
  ] as const;

  it.each(CARDS)(
    '%s: ticking in the alternate screen, `waiting since HH:MM` inline',
    async (name, needle, rule) => {
      for (const alternate of [true, false]) {
        const m = mount(alternate, { cols: 80, rows: 24 });
        await pause(40);
        for (const event of TURN) m.store.apply(event);
        if (name.includes('question'))
          void m.store.requestQuestion(QUESTION).catch(() => undefined);
        else void m.store.requestCheckpoint({ rounds: 12, interval: 8 }).catch(() => undefined);
        await vi.waitFor(() => expect(m.rowsWith(needle).length).toBeGreaterThan(1));
        await pause(120);
        const clock = alternate ? 'waiting 0:\\d\\d' : 'waiting since \\d\\d:\\d\\d';
        const expected = new RegExp(rule.source.replace('CLOCK', clock), 'u');
        const rows = m.rowsWith(needle);
        expect(
          rows.find((row) => row.startsWith('== ')),
          rows.join('\n'),
        ).toMatch(expected);
      }
    },
  );
});
