// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import './force-color.js';

/**
 * What the body behind an open popup still says, in the real hosts at 80×24 in the alternate screen (ADR-0148 §2 "one owner of the keys",
 * "Notifications"; MVP-11 step 4, review round 1, the real-terminal observation):
 *
 * - **the hint row**: a notification is drawn in the popup's own legend row while the popup is open, so the hint row around the box does not
 *   draw it too (its dimmed edges showed beside the popup, `Doctor` in columns 0 to 5 on the bare Home); once the popup closes, the hint row
 *   shows it as before;
 * - **the composer's cursor**: the popup owns the keyboard, so the composer's cursor block (an inverse cell) is not drawn while it is open, and
 *   is drawn again once it closes.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import { KEYS, mountHome, type HomeMount } from './surface-matrix/home-host.js';
import { popupBoxOf, TEST_POPUP_TITLE, testReportPopup } from './surface-matrix/popup-fixture.js';
import type { ScreenCell } from './surface-matrix/terminal.js';
import type { Variant } from './surface-matrix/variants.js';

/** A notification no other text of these screens contains, short enough for the popup's legend row. */
const NOTICE = 'QXN notice: sent to the clipboard.';

type Mount = HomeMount | ChatMount;
const HOSTS: readonly (readonly [string, (variant: Variant) => Promise<Mount>])[] = [
  ['the bare Home', (variant) => Promise.resolve(mountHome(variant))],
  ['the stand-alone chat', (variant) => Promise.resolve(mountStandaloneChat(variant))],
  ['the chat the Home hosts', (variant) => mountHostedChat(variant)],
];

/** Open the test popup with `[c]` wired to the notification, and wait until it is drawn and past its settle time. */
async function openPopup(m: Mount): Promise<void> {
  const origin = 'controller' in m && !('store' in m) ? 'home' : 'chat';
  const opened = m.popups.openForUser(testReportPopup(origin), {
    control: (context, key) => {
      if (key === 'c') context.notify(NOTICE);
    },
  });
  expect(opened.opened).toBe(true);
  await m.until(() => m.text().includes(TEST_POPUP_TITLE));
  await m.settle();
  m.skip(600);
}

/** Wait until the popup is closed and its frame gone (a lone Esc is held back a moment while the input layer rules out an escape sequence). */
async function closed(m: Mount): Promise<void> {
  await vi.waitFor(
    async () => {
      await m.settle();
      expect(m.popups.getSnapshot().open).toBe(false);
      expect(m.text()).not.toContain(TEST_POPUP_TITLE);
    },
    { timeout: 3000, interval: 15 },
  );
}

/** Every row's cells outside the popup's box (the box's own columns, on its own rows, left out). */
function outsideTheBox(
  rows: readonly string[],
  box: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
  },
): readonly string[] {
  return rows.map((row, index) =>
    index >= box.top && index < box.top + box.height
      ? `${row.slice(0, box.left)}${' '.repeat(box.width)}${row.slice(box.left + box.width)}`
      : row,
  );
}

/** The composer's row: the last row that starts with the prompt's marker. */
function promptRow(frame: readonly string[]): number {
  return frame.findLastIndex((row) => row.startsWith('> '));
}

const inverseCells = (row: readonly ScreenCell[] | undefined): number =>
  (row ?? []).filter((cell) => cell.style.inverse).length;

describe.each(HOSTS)('%s at 80×24 in the alternate screen', (_name, mount) => {
  it.each([false, true])(
    'the hint row does not repeat the notification around an open popup, and shows it once the popup closes (colour %s)',
    async (color) => {
      const variant: Variant = { renderer: 'alt', color, size: { cols: 80, rows: 24 } };
      const m = await mount(variant);
      try {
        await m.settle();
        await openPopup(m);
        m.key('c');
        await m.until(() => m.text().includes(NOTICE));
        await m.settle();
        const box = popupBoxOf(m.popupFrame(), variant, NOTICE);
        const frame = m.frame();
        // In the popup's legend row, whole: where it is read.
        expect(frame[box.top + box.height - 2]?.includes(NOTICE)).toBe(true);
        // Nowhere outside the box, not even its first letters at the hint row's edge.
        const outside = outsideTheBox(frame, box);
        expect(outside.filter((row) => row.includes('QXN'))).toEqual([]);
        // Closed while it is still live: the hint row shows it again.
        m.key(KEYS.escape);
        await closed(m);
        await m.until(() => m.text().includes(NOTICE));
        expect(m.text()).not.toContain(TEST_POPUP_TITLE);
        expect(m.frame().some((row) => row.trimStart().startsWith(NOTICE))).toBe(true);
      } finally {
        m.unmount();
      }
    },
  );

  it('the composer draws no cursor block while the popup owns the keys, and draws it again once it closes', async () => {
    const variant: Variant = { renderer: 'alt', color: true, size: { cols: 80, rows: 24 } };
    const m = await mount(variant);
    try {
      await m.settle();
      const before = promptRow(m.frame());
      expect(before, 'the composer is on screen').toBeGreaterThanOrEqual(0);
      expect(inverseCells(m.cells()[before]), 'its cursor block, before').toBe(1);
      await openPopup(m);
      const open = m.frame();
      const row = promptRow(open);
      expect(row, 'the composer is still drawn behind the popup').toBeGreaterThanOrEqual(0);
      expect(inverseCells(m.cells()[row]), 'no cursor block while the popup is open').toBe(0);
      m.key(KEYS.escape);
      await closed(m);
      await m.settle();
      expect(m.text()).not.toContain(TEST_POPUP_TITLE);
      const after = promptRow(m.frame());
      expect(inverseCells(m.cells()[after]), 'its cursor block, after').toBe(1);
    } finally {
      m.unmount();
    }
  });
});
