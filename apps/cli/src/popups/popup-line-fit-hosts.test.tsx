// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The whole line, or no answer, in the real hosts ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4, §8; MVP-11 step 4, review round 2, security F1): inline a popup's page is ten rows, so a confirmation line of 11 to 17 rows was drawn
 * cut (`▼ N more`), acknowledged and answered with what it named never wholly on screen. On the page each host really draws, a line that is cut
 * takes no answer and one that fits (the page exactly included) does; in the alternate screen the page of a two-step popup is 17 rows at the
 * floor and above it.
 *
 * Round 3 (security L2): the same for a line's WIDTH. The frame cuts each row to the popup's inner width (66 columns at 80 columns, both
 * placements; 74 from 88 columns), so a line with a row one column wider than that is drawn ending in `…`: it takes no answer and its legend
 * names none; a row of exactly the inner width is whole and answered; at 88 columns a row of 70 is whole, its legend names `Ctrl+Y` and it
 * is answered (the slot judges the legend on its own row, not the floor's).
 */
import { describe, expect, it, vi } from 'vitest';

import { mountStandaloneChat } from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import type { PopupSpec } from './popup-reducer.js';

/** The `count` rows of a line that names one origin per row. */
const originRows = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `  https://origin-${String(index + 1)}.example`);

/** A popup of two steps opened ON its confirmation line of `lines` (as `/doctor --deep` and `/cost --release` open). */
function lineSpec(lines: readonly string[], origin: 'home' | 'chat'): PopupSpec {
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
        content: { kind: 'report', lines },
        back: 0,
        holds: 'chord',
        chord: { verb: 'send' },
      },
    ],
  };
}

type Host = 'standalone-chat' | 'home';

/** Whether a deliberate `Ctrl+Y` answered the line of `lines` in `host`, and the screen it was pressed on. */
async function pressed(
  host: Host,
  variant: Variant,
  lines: readonly string[],
): Promise<{ readonly answered: boolean; readonly screen: string }> {
  const m = host === 'home' ? mountHome(variant) : mountStandaloneChat(variant);
  const chord = vi.fn();
  try {
    await m.settle();
    const opened = m.popups.openForUser(lineSpec(lines, host === 'home' ? 'home' : 'chat'), {
      chord,
    });
    expect(opened.opened).toBe(true);
    await m.until(() => m.frame().join('\n').includes('Confirm'));
    await m.settle();
    // Past the settle, the dwell, the quiet gap and any lockout: a deliberate press on the frame that is on screen.
    m.skip(2600);
    const screen = m.frame().join('\n');
    m.key(KEYS.ctrlY);
    await m.settle();
    await m.settle();
    return { answered: chord.mock.calls.length === 1, screen };
  } finally {
    m.unmount();
  }
}

async function answered(host: Host, variant: Variant, count: number): Promise<boolean> {
  return (await pressed(host, variant, originRows(count))).answered;
}

/** A line of two rows whose second is exactly `columns` wide (at least 18), ending in a word that is on screen only when the row is whole. */
const wideRows = (columns: number): string[] => [
  'Sends your key to:',
  `  https://${'a'.repeat(columns - 18)}.example`,
];

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

  describe.each(['alt', 'inline'] as const)(
    'a row of the line as wide as the popup (%s at 80×24: 66 columns)',
    (renderer) => {
      const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };

      it('one column wider is drawn cut: its legend names no Ctrl+Y and Ctrl+Y answers nothing', async () => {
        const { answered: yes, screen } = await pressed(host, variant, wideRows(67));
        expect(yes).toBe(false);
        expect(screen).toContain('…');
        expect(screen).not.toContain('.example');
        expect(screen).not.toContain('[Ctrl+Y] send');
      });

      it('exactly the inner width is whole: named and answered', async () => {
        const { answered: yes, screen } = await pressed(host, variant, wideRows(66));
        expect(screen).toContain('.example');
        expect(screen).toContain('[Ctrl+Y] send');
        expect(yes).toBe(true);
      });
    },
  );

  it('at 88×24 (74 columns) a row of 70 is whole: the legend names Ctrl+Y and it is answered', async () => {
    const variant: Variant = { renderer: 'alt', color: false, size: { cols: 88, rows: 24 } };
    const { answered: yes, screen } = await pressed(host, variant, wideRows(70));
    expect(screen).toContain('.example');
    expect(screen).toContain('[Ctrl+Y] send');
    expect(yes).toBe(true);
  });
});
