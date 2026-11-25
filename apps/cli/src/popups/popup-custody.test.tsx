// Chalk's level is read once, when it is first imported (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * Custody under a popup, in both orders, on an injected clock ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "One overlay-active predicate", "One owner of the chords at a time"; MVP-11 §5.5 rule 12), in the two chat hosts (the stand-alone chat and
 * the chat the Home hosts), on the real approval card and its real guards.
 *
 * - **A card first, then a popup** (only a race can do it: the open gate refuses it, so the test lifts the gate as a race would): the card's
 *   custody is revoked while the popup is open (no chord reaches it), and its acknowledgement and dwell origin are RESET, so once the popup
 *   closes the card is answerable only after a new measured frame and a new dwell, never at once on the frame it had before.
 * - **A popup first, then a card**: the sheet wins, the popup closes unanswered and says so, and the card's dwell counts from its own first
 *   acknowledged frame.
 *
 * Only the monotonic clock is faked (the guards read `performance.now`); the renderer's own timers are real, so a frame is flushed in real time.
 */
import type { ToolApprovalRequest } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { editedFilePreview } from '../render/tui/fixtures/edit-diff.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import { testReportPopup } from '../render/tui/surface-matrix/popup-fixture.js';
import { APPROVAL_SETTLE_MS } from '../render/tui/tool-review-model.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';

const VARIANT: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
const REQUEST: ToolApprovalRequest = {
  toolId: 'edit_file',
  action: 'fs_write',
  preview: { path: 'src/app.ts' },
  unredactedPreview: { path: 'src/app.ts' },
};
const CHORDS = {
  y: '\u0019',
  n: '\u000e',
  g: '\u0007',
  o: '\u000f',
  r: '\u0012',
} as const;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(Date.parse('2026-11-25T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

type Mount = (variant: Variant) => Promise<ChatMount>;
const HOSTS: readonly (readonly [string, Mount])[] = [
  ['the stand-alone chat', (variant) => Promise.resolve(mountStandaloneChat(variant))],
  ['the chat the Home hosts', (variant) => mountHostedChat(variant)],
];

/** Open an approval card and wait until its frame is drawn, flushed and acknowledged. Returns how it was answered. */
async function openCard(m: ChatMount): Promise<() => unknown> {
  let answered: unknown;
  void m.store
    .requestApproval(REQUEST, true, undefined, {
      callId: 'call-1',
      preview: editedFilePreview(4, { 1: 'changed' }),
    })
    .then((value) => {
      answered = value;
    });
  await vi.waitFor(() => expect(m.text()).toContain('Esc stops the turn'), {
    timeout: 3000,
    interval: 15,
  });
  await pause(60);
  return () => answered;
}

async function press(m: ChatMount, bytes: string): Promise<void> {
  m.key(bytes);
  await pause(20); // one key per chunk, never coalesced
}

describe.each(HOSTS)('%s', (_name, mount) => {
  it('a card first, then a popup (a race): no chord reaches the card while the popup is open', async () => {
    const m = await mount(VARIANT);
    try {
      const answered = await openCard(m);
      vi.advanceTimersByTime(5000);
      // The gate refuses it, so a race is what puts a popup over a card: lift the gate as a race would.
      expect(m.popups.openForUser(testReportPopup('chat'))).toEqual({
        opened: false,
        reason: 'card-open',
      });
      m.popups.bindOpenGate(undefined);
      expect(m.popups.openForUser(testReportPopup('chat')).opened).toBe(true);
      await m.settle();
      for (const chord of Object.values(CHORDS)) {
        await press(m, chord);
        vi.advanceTimersByTime(3000);
      }
      expect(answered(), 'one owner of the chords at a time: the popup has them').toBeUndefined();
      expect(m.store.getSnapshot().approval).toBeDefined();
      expect(m.popups.getSnapshot().open).toBe(true);
    } finally {
      m.unmount();
    }
  });

  it('a card first, then a popup (a race): the card’s acknowledgement and dwell origin are reset, so it is not answerable at once after', async () => {
    const m = await mount(VARIANT);
    try {
      const answered = await openCard(m);
      // Long past every guard: before the popup this card would answer a Ctrl+Y at once.
      vi.advanceTimersByTime(5000);
      m.popups.bindOpenGate(undefined);
      expect(m.popups.openForUser(testReportPopup('chat')).opened).toBe(true);
      await m.settle();
      // The popup closes with no key (the command's own close), so no key-history guard is in play: only the frame and the dwell are.
      m.popups.closeAll('command');
      await pause(60); // the card is drawn, measured and flushed again
      await press(m, CHORDS.y);
      expect(
        answered(),
        'the card was re-acknowledged a moment ago: its dwell starts over',
      ).toBeUndefined();
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS + 400);
      await press(m, CHORDS.y);
      await vi.waitFor(() => expect(answered()).toEqual({ outcome: 'approve', scope: 'once' }));
    } finally {
      m.unmount();
    }
  });

  it('a popup first, then a card: the sheet wins, the popup closes unanswered and says so, and the card dwells from its own frame', async () => {
    const m = await mount(VARIANT);
    try {
      const closed = vi.fn();
      expect(m.popups.openForUser(testReportPopup('chat'), { closed }).opened).toBe(true);
      await m.settle();
      vi.advanceTimersByTime(5000);
      const answered = await openCard(m);
      expect(m.popups.getSnapshot().open).toBe(false);
      expect(closed).toHaveBeenCalledWith('sheet');
      // the notification waits: a card is on screen and nothing paints over its rows
      expect(m.notifications.getSnapshot()).toMatchObject({ held: true, queued: 1 });
      await press(m, CHORDS.y);
      expect(answered(), 'the card has just appeared').toBeUndefined();
      vi.advanceTimersByTime(APPROVAL_SETTLE_MS + 400);
      await press(m, CHORDS.y);
      await vi.waitFor(() => expect(answered()).toEqual({ outcome: 'approve', scope: 'once' }));
      // the card is gone: the notification is shown now, on the hint row
      await vi.waitFor(() =>
        expect(m.notifications.getSnapshot().current?.text).toBe(
          'Test report closed: a question needs your answer',
        ),
      );
    } finally {
      m.unmount();
    }
  });
});
