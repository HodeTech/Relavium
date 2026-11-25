// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * Where a person reads a notification while a popup is open, and what a popup's notice leaves of the body it covers
 * ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2, §4; MVP-11 step 4, review round 1),
 * in the real hosts:
 *
 * - at 80×24 a popup over the bare Home covers the hint row the notification is drawn on (and inline it replaces it), so the popup draws the
 *   live notification in its own legend row, whole, and the legend comes back when it expires;
 * - below the floor the notice in the popup's place covers its rows to the terminal's edge: no cell of the conversation behind is left at
 *   their end.
 */
import { describe, expect, it } from 'vitest';

import { mountStandaloneChat } from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome } from '../render/tui/surface-matrix/home-host.js';
import {
  popupBoxOf,
  TEST_POPUP_LEGEND_ROW,
  TEST_POPUP_TITLE,
  testReportPopup,
} from '../render/tui/surface-matrix/popup-fixture.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { NOTIFICATION_MS } from './notifications.js';

const NOTICE = 'Test report: sent 164 characters to the terminal clipboard.';
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a notification is read in the open popup’s own legend row (H6)', () => {
  it.each([
    ['alt', false],
    ['alt', true],
    ['inline', false],
  ] as const)(
    'on the bare Home at 80×24 (%s, colour %s): after [c] the text is whole in the popup, and the legend comes back',
    async (renderer, color) => {
      const variant: Variant = { renderer, color, size: { cols: 80, rows: 24 } };
      const m = mountHome(variant);
      try {
        await m.settle();
        m.popups.openForUser(testReportPopup('home'), {
          control: (context, key) => {
            if (key === 'c') context.notify(NOTICE);
          },
        });
        await m.until(() => m.text().includes(TEST_POPUP_TITLE));
        await m.settle();
        m.skip(600);
        m.key('c');
        await m.until(() => m.text().includes(NOTICE));
        const frame = m.frame();
        const box = popupBoxOf(m.popupFrame(), variant, NOTICE);
        const legendRow = box.rows[box.height - 2] ?? '';
        expect(legendRow.trim()).toBe(NOTICE);
        if (box.placement === 'overlay') {
          // The legend row of the popup, cell for cell, in the popup's own box.
          const drawn = frame[box.top + box.height - 2] ?? '';
          // (the screen's row is cut after its last drawn character when nothing styles the blank cells that follow)
          expect(drawn.slice(box.left, box.left + box.width).trimEnd()).toBe(legendRow.trimEnd());
          expect(drawn.slice(0, box.left + 1 + NOTICE.length).endsWith(NOTICE)).toBe(true);
          // The popup's legend is gone for the notification's lifetime.
          expect(frame.join('\n')).not.toContain(TEST_POPUP_LEGEND_ROW);
        } else {
          expect(frame.some((row) => row.trimEnd() === legendRow.trimEnd())).toBe(true);
        }
        // The frame with the notification in it is measured and acknowledged like any other: once it is flushed, a key that needs a seen
        // frame acts on it (a key before that acknowledgement is dropped, as on any frame).
        await m.settle();
        m.key(KEYS.down);
        await m.until(() => m.popups.getSnapshot().frame?.steps[0]?.selected === 1);
        expect(m.popups.getSnapshot().frame?.steps[0]?.selected).toBe(1);
        // Expired: the legend is back in its row.
        m.skip(0);
        await pause(NOTIFICATION_MS + 100);
        await m.until(() => m.text().includes(TEST_POPUP_LEGEND_ROW));
        expect(m.text()).not.toContain(NOTICE);
        m.key(KEYS.escape);
        await m.until(() => !m.popups.getSnapshot().open);
      } finally {
        m.unmount();
      }
    },
  );
});

describe('the notice in place of a popup leaves no cell of the body at the end of its rows (H11)', () => {
  const LONG = 'a long line of the conversation that runs to the edge of the terminal '.repeat(4);
  const SEED = {
    model: 'claude-sonnet-4-5',
    transcript: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: LONG,
    })),
  };

  it.each([
    [79, 24, false],
    [80, 23, false],
    [79, 24, true],
  ] as const)(
    'at %i×%i (colour %s), over a chat whose rows are full: every row of the notice is blank after its text',
    async (cols, rows, color) => {
      const variant: Variant = { renderer: 'alt', color, size: { cols, rows } };
      const m = mountStandaloneChat(variant, { seed: SEED });
      try {
        await m.settle();
        m.popups.openForUser(testReportPopup('chat'));
        await m.until(() => m.text().includes('Terminal too small for this popup'));
        await m.settle();
        const frame = m.frame();
        const reason = frame.findIndex((row) => row.includes('Terminal too small for this popup'));
        expect(reason).toBeGreaterThanOrEqual(0);
        for (const at of [reason, reason + 1]) {
          const row = frame[at] ?? '';
          const text =
            at === reason ? 'Terminal too small for this popup — enlarge it to 80×24' : 'Esc close';
          const end = row.indexOf(text) + text.length;
          expect(row.indexOf(text), JSON.stringify(row)).toBeGreaterThanOrEqual(0);
          expect(row.slice(end).trim(), JSON.stringify(row)).toBe('');
        }
      } finally {
        m.unmount();
      }
    },
  );
});
