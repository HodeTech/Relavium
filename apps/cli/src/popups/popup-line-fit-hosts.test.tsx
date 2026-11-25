// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The whole line, or no answer, in the real hosts ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4, §8; MVP-11 step 4, review round 2, security F1): inline a popup's page is ten rows, so a confirmation line of 11 to 17 rows was drawn
 * cut (`▼ N more`), acknowledged and answered with what it named never wholly on screen. On the page each host really draws, a line that is cut
 * takes no answer and one that fits (the page exactly included) does; in the alternate screen the page of a two-step popup is 17 rows at the
 * floor and above it.
 */
import { describe, expect, it, vi } from 'vitest';

import { mountStandaloneChat } from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import type { PopupSpec } from './popup-reducer.js';

/** A popup of two steps opened ON its confirmation line of `count` rows (as `/doctor --deep` and `/cost --release` open). */
function lineSpec(count: number, origin: 'home' | 'chat'): PopupSpec {
  return {
    id: 'line-fit',
    title: '/line',
    origin,
    rail: 'path',
    initialStep: 1,
    steps: [
      { name: 'Checks', content: { kind: 'list', rows: [{ id: 'a', label: 'alpha' }] } },
      {
        name: 'Confirm',
        content: {
          kind: 'report',
          lines: Array.from(
            { length: count },
            (_, index) => `  https://origin-${String(index + 1)}.example`,
          ),
        },
        back: 0,
        holds: 'chord',
        chord: { verb: 'send' },
      },
    ],
  };
}

type Host = 'standalone-chat' | 'home';

async function answered(host: Host, variant: Variant, count: number): Promise<boolean> {
  const m = host === 'home' ? mountHome(variant) : mountStandaloneChat(variant);
  const chord = vi.fn();
  try {
    await m.settle();
    const opened = m.popups.openForUser(lineSpec(count, host === 'home' ? 'home' : 'chat'), {
      chord,
    });
    expect(opened.opened).toBe(true);
    await m.until(() => m.frame().join('\n').includes('origin-1.example'));
    await m.settle();
    // Past the settle, the dwell, the quiet gap and any lockout: a deliberate press on the frame that is on screen.
    m.skip(2600);
    m.key(KEYS.ctrlY);
    await m.settle();
    await m.settle();
    return chord.mock.calls.length === 1;
  } finally {
    m.unmount();
  }
}

describe.each(['standalone-chat', 'home'] as const)('%s', (host) => {
  describe.each([
    [80, 24],
    [100, 30],
  ] as const)('inline at %i×%i: the page is ten rows', (cols, rows) => {
    const variant: Variant = { renderer: 'inline', color: false, size: { cols, rows } };

    it.each([11, 14, 17])('a line of %i rows is cut: Ctrl+Y answers nothing', async (count) => {
      expect(await answered(host, variant, count)).toBe(false);
    });

    it('a line of exactly ten rows is whole: Ctrl+Y answers it', async () => {
      expect(await answered(host, variant, 10)).toBe(true);
    });
  });

  describe('in the alternate screen at 80×24: the page of a two-step popup is 17 rows', () => {
    const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };

    it('a line of 17 rows is whole: answered', async () => {
      expect(await answered(host, variant, 17)).toBe(true);
    });

    it('a line of 18 rows is cut: Ctrl+Y answers nothing', async () => {
      expect(await answered(host, variant, 18)).toBe(false);
    });
  });
});
