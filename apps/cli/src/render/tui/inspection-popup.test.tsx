/**
 * The inspection popup ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §7): the
 * approval's full view (`[v]`) and `/details` drawn as the large popup the approval sheet owns.
 *
 * - **One geometry.** `inspectionGeometry` sizes the box (`columns − 2` by `rows − 1`, 78 × 23 at 80×24) and the page every computation is
 *   given; the grid shows the box where the geometry says it is.
 * - **The frame.** The top edge names the popup and where it came from; the bottom edge closes it; the terminal's last row stays empty; inline
 *   it is the same framed block, at most `rows − 1` lines.
 * - **The sheet's keys and locks in the popup.** A chord answers from it as from the card; `Esc` steps back and never rejects; a mashed `Esc`
 *   right after the step back is ignored (the settle of the step back), and one after the settle rejects as before; `Ctrl+C` still stops.
 * - **Resize.** The popup is laid out again at the new size, and below the floor it is the refusal, where no answer counts.
 *
 * The ADR's two mutation tests of the content-node measurement (a row one cell too wide, one extra row) are run against
 * `tool-review-host.test.tsx`'s acknowledged-frame test (the unit-8 report lists them).
 */
import type { ToolApprovalRequest, ToolPreview } from '@relavium/core';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OwnedTtyInput, OwnedTtyOutput, PlainTtyOutput } from '../../test-support.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { APPROVAL_SETTLE_MS, toolReviewPage, type ApprovalGuard } from './tool-review-model.js';
import {
  FULL_SPARE_ROWS,
  INSPECTION_EDGE_ROWS,
  inspectionBottomEdge,
  inspectionGeometry,
  inspectionTopEdge,
} from './tool-review-screen.js';
import { withGlyphForm } from './glyphs.js';
import { displayWidth } from './viewport.js';

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
const SIXTY: ToolPreview = editedFilePreview(60, { 30: 'thirty', 52: 'fifty two' });
/** Every layer of the approval guard off: the keys of a test count at once (the guard has its own tests). */
const OFF: Required<ApprovalGuard> = {
  settleMs: 0,
  quietMs: 0,
  typeaheadMs: 0,
  lockoutMs: 0,
  confirmAlways: false,
};
const CTRL_Y = '\x19';
const CTRL_C = '\x03';
const ESC = '\x1b';

// eslint-disable-next-line no-control-regex -- stripping terminal control sequences from a captured frame
const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[78]/gu;
const TOP = /^ {2}- (?:Full diff|Full view|\/details) -+ from (?:the approval|chat) - *$/u;
const BOTTOM = /^ {2}-{20,} *$/u;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
    { approvalGuard: OFF },
  );
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
  let outcome: unknown;
  cleanups.push(() => {
    store.sealToolPreviews();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
  });
  /** The last frame written that holds `needle`, as rows, control sequences stripped. */
  const rowsWith = (needle: string): readonly string[] =>
    (
      output.frames
        .map((frame) => frame.replace(CONTROL, ''))
        .filter((frame) => frame.includes(needle))
        .at(-1) ?? ''
    ).split('\n');
  const openCard = async (): Promise<void> => {
    void store
      .requestApproval(REQUEST, true, undefined, { callId: 'inspect', preview: SIXTY })
      .then((value) => {
        outcome = value;
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(rowsWith('Esc stops the turn').length).toBeGreaterThan(1));
    await pause(60);
  };
  const openFull = async (): Promise<void> => {
    await openCard();
    input.push('v');
    await vi.waitFor(() => expect(store.getSnapshot().review?.screen).toBe('full'));
    await vi.waitFor(() => expect(rowsWith('Full diff').length).toBeGreaterThan(1));
    await pause(80);
  };
  return {
    store,
    input,
    output,
    rowsWith,
    openCard,
    openFull,
    outcome: () => outcome,
    resize: (cols: number, rows: number) => {
      output.columns = cols;
      output.rows = rows;
      output.emit('resize');
    },
  };
}

describe('one geometry for the frame and the page (ADR-0148 §7)', () => {
  it.each([
    [80, 24, 78, 23],
    [100, 30, 98, 29],
    [120, 40, 118, 39],
  ] as const)('at %i×%i the popup is %i × %i, one column in from each side', (cols, rows, w, h) => {
    const geometry = inspectionGeometry({ cols, rows });
    expect(geometry?.box).toEqual({ width: w, height: h, left: 1 });
    // The page is projected for the box: a row is the box's width (`columns − 2`), and the screen is the box less its two edges.
    expect(geometry?.page).toEqual({ cols, rows: h - INSPECTION_EDGE_ROWS + FULL_SPARE_ROWS });
  });

  it('below the floor there is no popup: the host draws the refusal', () => {
    expect(inspectionGeometry({ cols: 79, rows: 24 })).toBeUndefined();
    expect(inspectionGeometry({ cols: 80, rows: 23 })).toBeUndefined();
  });

  it('its edges are exactly the box’s width, in both glyph forms', () => {
    for (const plain of [false, true])
      for (const width of [78, 98, 118]) {
        const top = withGlyphForm(plain, () =>
          inspectionTopEdge('Full diff', 'from the approval', width),
        );
        expect(displayWidth(`${top.lead}${top.title}${top.rest}`)).toBe(width);
        expect(displayWidth(withGlyphForm(plain, () => inspectionBottomEdge(width)))).toBe(width);
      }
  });
});

describe('the popup on the grid', () => {
  it.each([
    [80, 24],
    [100, 30],
  ] as const)(
    '%i×%i: the top edge, the screen, the bottom edge, and the terminal’s last row empty',
    async (cols, rows) => {
      const m = mount(true, { cols, rows });
      await pause(40);
      await m.openFull();
      const frame = m.rowsWith('Full diff');
      expect(frame).toHaveLength(rows);
      expect(frame[0], 'the top edge names the popup and where it came from').toMatch(TOP);
      expect(frame[rows - 2], 'the bottom edge').toMatch(BOTTOM);
      expect(frame[rows - 1], 'the last row of the terminal is left empty').toBe('');
      for (const row of frame.slice(0, rows - 1)) {
        expect(displayWidth(row), row).toBeLessThanOrEqual(cols - 1);
        expect(row === '' || row.startsWith(' '), `one column in: ${row}`).toBe(true);
      }
      // The screen it frames, its answers and its way back: the sheet's own keys, in the popup.
      const text = frame.join('\n');
      expect(text).toContain('[Ctrl+Y] Allow');
      expect(text).toContain(
        '[Ctrl+N] Deny · [b] back to the card · [Ctrl+C] stops the turn · Esc back',
      );
    },
  );

  it('inline: the same framed block, at most rows − 1 lines', async () => {
    const m = mount(false, { cols: 80, rows: 24 });
    await pause(40);
    await m.openFull();
    const frame = m
      .rowsWith('Full diff')
      .filter((row, index, all) => index < all.length - 1 || row !== '');
    expect(frame.length).toBeLessThanOrEqual(23);
    expect(frame.some((row) => TOP.test(row))).toBe(true);
    expect(frame.some((row) => BOTTOM.test(row))).toBe(true);
  });

  it('/details opens the call list in the same container, from chat, with no answer rows', async () => {
    const m = mount(true, { cols: 80, rows: 24 });
    await pause(40);
    await m.openCard();
    m.store.answerApproval({ outcome: 'reject' });
    await pause(40);
    m.store.openDetails();
    await vi.waitFor(() => expect(m.store.getSnapshot().review?.screen).toBe('list'));
    await vi.waitFor(() => expect(m.rowsWith('/details').length).toBeGreaterThan(1));
    const frame = m.rowsWith('/details');
    expect(frame[0]).toMatch(/^ {2}- \/details -+ from chat - *$/u);
    expect(frame.join('\n')).not.toContain('[Ctrl+Y]');
    expect(frame[23]).toBe('');
  });
});

describe('the sheet’s keys in its popup (ADR-0148 §7, MVP-11 §5.5 rule 17)', () => {
  it('a chord answers from the popup exactly as from the card', async () => {
    const m = mount(true, { cols: 80, rows: 24 });
    await pause(40);
    await m.openFull();
    m.input.push(CTRL_Y);
    await vi.waitFor(() => expect(m.outcome()).toEqual({ outcome: 'approve', scope: 'once' }));
  });

  it('a page whose rows fill the box is acknowledged and answered: the page is fitted to the box it is drawn in', async () => {
    // A changed line of 300 characters: the projection fills every row it wraps to the page's width, so a page fitted to a wider box than the
    // one drawn would wrap a row, make the content taller than the box and be refused (ADR-0148 §7's one-cell mutation).
    const m = mount(true, { cols: 80, rows: 24 });
    await pause(40);
    void m.store
      .requestApproval(REQUEST, true, undefined, {
        callId: 'wide',
        preview: editedFilePreview(40, { 20: 'x'.repeat(300) }),
      })
      .then((value) => {
        answered.push(value);
      })
      .catch(() => undefined);
    const answered: unknown[] = [];
    await vi.waitFor(() => expect(m.rowsWith('Esc stops the turn').length).toBeGreaterThan(1));
    await pause(60);
    m.input.push('v');
    await vi.waitFor(() => expect(m.rowsWith('Full diff').length).toBeGreaterThan(1));
    await pause(120);
    m.input.push(CTRL_Y);
    await vi.waitFor(() => expect(answered).toEqual([{ outcome: 'approve', scope: 'once' }]));
    // The answer counted for a frame whose body rows filled the box: the test is about the box's edge.
    expect(
      m.rowsWith('Full diff').some((row) => displayWidth(row) >= 78 && row.includes('xxxx')),
      'a body row fills the box',
    ).toBe(true);
  });

  it('Esc steps back to the card and answers nothing; Ctrl+C from the popup stops the turn', async () => {
    const m = mount(true, { cols: 80, rows: 24 });
    await pause(40);
    await m.openFull();
    m.input.push(ESC);
    await vi.waitFor(() => expect(m.store.getSnapshot().review?.screen).toBe('card'));
    await pause(60);
    expect(m.outcome(), 'stepping back answers nothing').toBeUndefined();
    expect(m.store.getSnapshot().approval).toBeDefined();
    m.input.push('v');
    await vi.waitFor(() => expect(m.store.getSnapshot().review?.screen).toBe('full'));
    await pause(60);
    m.input.push(CTRL_C);
    await vi.waitFor(() => expect(m.outcome()).toEqual({ outcome: 'reject' }));
  });

  it('a resize lays the popup out again, and below the floor it is the refusal where Ctrl+Y answers nothing', async () => {
    const m = mount(true, { cols: 80, rows: 24 });
    await pause(40);
    await m.openFull();
    m.resize(100, 30);
    // The box is 98 wide one column in: its top edge ends at column 98 (its last cell is the blank of its side margin).
    await vi.waitFor(() => expect(m.rowsWith('Full diff')[0]?.trimEnd().length).toBe(98));
    expect(m.rowsWith('Full diff')).toHaveLength(30);
    expect(m.rowsWith('Full diff')[28]).toMatch(BOTTOM);
    m.resize(60, 20);
    await vi.waitFor(() => expect(m.rowsWith('Terminal too small').length).toBeGreaterThan(0));
    expect(m.rowsWith('Terminal too small').join('\n')).not.toMatch(TOP);
    await pause(60);
    m.input.push(CTRL_Y);
    await pause(120);
    expect(m.outcome(), 'no answer below the floor').toBeUndefined();
    m.resize(80, 24);
    await vi.waitFor(() => expect(m.rowsWith('Full diff')[0]).toMatch(TOP));
  });
});

describe('a mashed Esc does not reject by accident (ADR-0148 §7)', () => {
  // The store with the product's real guard, the host's acknowledgement played by hand, and the monotonic clock faked.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function rig() {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    let shown: unknown;
    store.bindReviewVisibility(() => shown !== undefined && store.getSnapshot().review === shown);
    const answers: unknown[] = [];
    void store
      .requestApproval(REQUEST, true, undefined, { callId: 'mash', preview: SIXTY })
      .then((answer) => answers.push(answer));
    const show = (): void => {
      const review = store.getSnapshot().review;
      if (review === undefined) return;
      shown = review;
      store.acknowledgeReviewFrame(review, toolReviewPage(review, 80, 22));
    };
    const key = (
      input: string,
      key: Parameters<ChatStoreController['handleReviewInput']>[1] = {},
    ) => store.handleReviewInput(input, key);
    const toFull = (): void => {
      show();
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS + 50);
      key('v');
      expect(store.getSnapshot().review?.screen).toBe('full');
      show();
      vi.advanceTimersByTime(100);
    };
    return { store, answers, show, key, toFull };
  }

  it('an Esc inside the settle after the step back is ignored: nothing is rejected and the turn goes on', async () => {
    const r = rig();
    r.toFull();
    expect(r.key('', { escape: true }), 'the step back').toBe('handled');
    expect(r.store.getSnapshot().review?.screen).toBe('card');
    vi.advanceTimersByTime(APPROVAL_SETTLE_MS - 1);
    expect(r.key('', { escape: true }), 'the mashed Esc stops nothing').toBe('handled');
    await Promise.resolve();
    expect(r.answers, 'and rejects nothing').toEqual([]);
    expect(r.store.getSnapshot().approval).toBeDefined();
  });

  it('an Esc after the settle rejects and stops the turn, as on the card it always did', async () => {
    const r = rig();
    r.toFull();
    r.key('', { escape: true });
    vi.advanceTimersByTime(APPROVAL_SETTLE_MS);
    expect(r.key('', { escape: true })).toBe('abort');
    await Promise.resolve();
    expect(r.answers).toEqual([{ outcome: 'reject' }]);
  });

  it('Ctrl+C is never held back: inside the settle it still stops the turn', async () => {
    const r = rig();
    r.toFull();
    r.key('', { escape: true });
    vi.advanceTimersByTime(10);
    expect(r.key('c', { ctrl: true })).toBe('abort');
    await Promise.resolve();
    expect(r.answers).toEqual([{ outcome: 'reject' }]);
  });

  it('the settle only ever suppresses a rejection: an Esc on a card that was never left rejects at once', async () => {
    const r = rig();
    r.show();
    vi.advanceTimersByTime(10);
    expect(r.key('', { escape: true })).toBe('abort');
    await Promise.resolve();
    expect(r.answers).toEqual([{ outcome: 'reject' }]);
  });
});
