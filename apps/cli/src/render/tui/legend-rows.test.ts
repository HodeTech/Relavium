import { describe, expect, it } from 'vitest';

import { exitKey, legend, legendRows, LEGEND_SEPARATOR, type LegendItem } from './legend.js';
import { TERMINAL_TOO_SMALL_TEXT } from './measured-frame-acknowledgement.js';
import { displayWidth } from './viewport.js';

/**
 * `legendRows` ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3): the refusal a card draws in place of itself
 * on a terminal below its floor is a legend, and a terminal too narrow for one row wrapped it in the middle of an item (`[Ctrl+C]` on one row,
 * `stops the turn` on the next). The rows are cut between items.
 */
const ITEMS: readonly LegendItem[] = [
  { text: TERMINAL_TOO_SMALL_TEXT },
  { keys: 'Ctrl+N', verb: 'Deny', role: 'danger' },
  { keys: 'Ctrl+C', verb: 'stops the turn', role: 'warn' },
];
const EXIT = exitKey.step();

describe('legendRows', () => {
  it('is the legend, in one row, where it fits', () => {
    expect(legendRows(ITEMS, EXIT, 200, displayWidth)).toEqual([legend(ITEMS, EXIT)]);
  });

  it('cuts BETWEEN items when it does not fit, never inside one', () => {
    const rows = legendRows(ITEMS, EXIT, 60, displayWidth);
    expect(rows.length).toBeGreaterThan(1);
    // the rows, put back, are the legend: the same items in the same order, none split
    expect(rows.join(' ')).toBe(legend(ITEMS, EXIT));
    for (const row of rows) expect(displayWidth(row), row).toBeLessThanOrEqual(60);
    // a key is never parted from its effect, and the key that leaves is the last thing said
    expect(rows.some((row) => row.includes('[Ctrl+C] stops the turn'))).toBe(true);
    expect(rows.at(-1)?.endsWith('Esc back')).toBe(true);
  });

  it('gives an item wider than a row a row of its own, and loses none', () => {
    const wide: LegendItem = { text: 'x'.repeat(50) };
    const rows = legendRows([wide], EXIT, 20, displayWidth);
    expect(rows).toEqual([`${'x'.repeat(50)} ·`, 'Esc back']);
  });

  it('holds over every width from 12 to 120: no item is split, every row fits unless one item is wider than the row', () => {
    const whole = legend(ITEMS, EXIT);
    for (let columns = 12; columns <= 120; columns += 1) {
      const rows = legendRows(ITEMS, EXIT, columns, displayWidth);
      expect(rows.join(' '), `${String(columns)} columns`).toBe(whole);
      for (const row of rows) {
        // a row holds one item (whose own width may exceed the row) or fits whole, the dot of its separator included
        const single = row.replace(/ ·$/u, '').includes(LEGEND_SEPARATOR) === false;
        expect(single || displayWidth(row) <= columns, `${String(columns)} columns: ${row}`).toBe(
          true,
        );
      }
    }
  });
});

describe('the sentence a card says on a terminal below its floor', () => {
  it('names the size it needs, and is one row with the keys that leave on the floor’s own width', () => {
    expect(TERMINAL_TOO_SMALL_TEXT).toContain('80×24');
    expect(TERMINAL_TOO_SMALL_TEXT.toLowerCase()).toContain('too small');
    // the longest refusal (a review's full view: the sentence, Deny, the stop key and Esc) fits 80 columns whole, in at most two rows
    const rows = legendRows(
      [
        { text: TERMINAL_TOO_SMALL_TEXT },
        { keys: 'Ctrl+N', verb: 'Deny', role: 'danger' },
        { keys: 'Ctrl+C', verb: 'stops the turn', role: 'warn' },
      ],
      exitKey.step(),
      80,
      displayWidth,
    );
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.join(' ')).toContain('[Ctrl+C] stops the turn');
  });
});
