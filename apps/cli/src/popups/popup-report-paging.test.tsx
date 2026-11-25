// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * A long report read by `PgDn` alone shows every line, and `PgUp` alone is its mirror, in the real hosts ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3; MVP-11 step 4, review round 3, correctness): a page moved by its whole height while the `▲ N more` and `▼ N more` rows each cover the
 * line under them, so the two lines at every page boundary were never on screen (`/help` is about ninety lines: in the alternate screen lines
 * 17, 18, 35, 36 …, inline 9, 10, 19, 20 …). A page now moves by the rows between its markers.
 */
import { describe, expect, it } from 'vitest';

import { mountStandaloneChat, type ChatMount } from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome, type HomeMount } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import type { PopupSpec } from './popup-reducer.js';

type Mount = HomeMount | ChatMount;

const TOTAL = 46;

/** A one-step report of {@link TOTAL} numbered lines. */
function longReport(origin: 'home' | 'chat'): PopupSpec {
  return {
    id: 'long-report',
    title: '/long',
    origin,
    steps: [
      {
        name: 'Report',
        content: {
          kind: 'report',
          lines: Array.from({ length: TOTAL }, (_, index) => `report line ${String(index + 1)}`),
        },
      },
    ],
  };
}

/** The report lines on screen now, by number. */
function linesOnScreen(m: Mount): number[] {
  return [
    ...m
      .frame()
      .join('\n')
      .matchAll(/report line (\d+)\b/gu),
  ].map((found) => Number(found[1]));
}

/** Open the report (at its end for `pageUp`), then press `key` until the screen stops changing; every page's lines, in order. */
async function read(
  host: 'home' | 'standalone-chat',
  variant: Variant,
  key: 'pageDown' | 'pageUp',
): Promise<number[][]> {
  const m: Mount = host === 'home' ? mountHome(variant) : mountStandaloneChat(variant);
  try {
    await m.settle();
    expect(m.popups.openForUser(longReport(host === 'home' ? 'home' : 'chat')).opened).toBe(true);
    await m.until(() => linesOnScreen(m).includes(1));
    await m.settle();
    m.skip(600);
    if (key === 'pageUp') {
      m.key('\u001b[F'); // End
      await m.until(() => linesOnScreen(m).includes(TOTAL));
      // A key counts only on a frame that was acknowledged: let the scrolled frame's acknowledgement land.
      await m.settle();
    }
    const pages: number[][] = [linesOnScreen(m)];
    for (let turn = 0; turn < TOTAL; turn += 1) {
      const before = m.frame().join('\n');
      m.key(KEYS[key]);
      await m.settle();
      await m.settle();
      if (m.frame().join('\n') === before) return pages;
      pages.push(linesOnScreen(m));
    }
    throw new Error('the pages never ended');
  } finally {
    m.unmount();
  }
}

describe.each(['standalone-chat', 'home'] as const)('%s', (host) => {
  describe.each(['alt', 'inline'] as const)('%s at 80×24', (renderer) => {
    const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };

    it('PgDn alone shows every line, and no line twice before the last page', async () => {
      const pages = await read(host, variant, 'pageDown');
      expect(pages.length).toBeGreaterThan(2);
      expect(new Set(pages.flat())).toEqual(
        new Set(Array.from({ length: TOTAL }, (_, index) => index + 1)),
      );
      for (let at = 1; at < pages.length - 1; at += 1)
        expect(Math.min(...(pages[at] ?? []))).toBe(Math.max(...(pages[at - 1] ?? [])) + 1);
    });

    it('PgUp alone, from the end, shows every line, and no line twice before the first page', async () => {
      const pages = await read(host, variant, 'pageUp');
      expect(pages.length).toBeGreaterThan(2);
      expect(new Set(pages.flat())).toEqual(
        new Set(Array.from({ length: TOTAL }, (_, index) => index + 1)),
      );
      for (let at = 1; at < pages.length - 1; at += 1)
        expect(Math.max(...(pages[at] ?? []))).toBe(Math.min(...(pages[at - 1] ?? [])) - 1);
    });
  });
});
