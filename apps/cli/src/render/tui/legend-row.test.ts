import { describe, expect, it } from 'vitest';

import { LEGEND_SEPARATOR, exitKey, legend, legendItems, type LegendItem } from './legend.js';
import { exitRow, rowSegments, sentenceRow } from './legend-row.js';

const ITEMS: readonly LegendItem[] = [
  { keys: 'Ctrl+Y', verb: 'Allow once', role: 'ok' },
  { text: 'any other key cancels' },
  { keys: 'v', verb: 'full diff' },
];

describe('a key row of a card (ADR-0145 §3)', () => {
  it('is, with its exit, exactly what the builder writes, text and spans', () => {
    const exit = exitKey.decide('stops the turn');
    const row = exitRow(ITEMS, exit);
    expect(row.text).toBe(legend(ITEMS, exit));
    expect(row.text).toBe(
      '[Ctrl+Y] Allow once · any other key cancels · [v] full diff · Esc stops the turn',
    );
  });

  it('is, without an exit, the same text up to where the exit would start, and its spans stay inside it', () => {
    const row = legendItems(ITEMS);
    expect(row.text).toBe('[Ctrl+Y] Allow once · any other key cancels · [v] full diff');
    expect(row.text.endsWith(LEGEND_SEPARATOR)).toBe(false);
    for (const span of row.spans) expect(span.to).toBeLessThanOrEqual(row.text.length);
    // the keys keep the role their item gave them: the allow green, the other emphasised
    expect(
      rowSegments(row)
        .filter((segment) => segment.role !== 'dim')
        .map((segment) => `${segment.text}=${segment.role}`),
    ).toEqual(['[Ctrl+Y]=ok', '[v]=strong']);
  });

  it('is empty for no items, and one item is just that item', () => {
    expect(legendItems([])).toEqual({ text: '', spans: [] });
    expect(legendItems([{ keys: 'Enter', verb: 'find' }]).text).toBe('Enter find');
  });

  it('is a dim sentence where a legend would be, with no key in it', () => {
    const row = sentenceRow('(Allow is locked until you inspect the change)');
    expect(rowSegments(row)).toEqual([
      { text: '(Allow is locked until you inspect the change)', role: 'dim' },
    ]);
    expect(sentenceRow('')).toEqual({ text: '', spans: [] });
  });

  it('is cut at its spans’ edges without losing a character, and a stretch no span covers is dim', () => {
    for (const row of [
      exitRow(ITEMS, exitKey.leave('leaves it pending')),
      legendItems(ITEMS),
      sentenceRow('plain'),
      { text: 'abc', spans: [{ from: 1, to: 2, role: 'warn' as const }] },
    ])
      expect(
        rowSegments(row)
          .map((segment) => segment.text)
          .join(''),
      ).toBe(row.text);
    expect(rowSegments({ text: 'abc', spans: [{ from: 1, to: 2, role: 'warn' }] })).toEqual([
      { text: 'a', role: 'dim' },
      { text: 'b', role: 'warn' },
      { text: 'c', role: 'dim' },
    ]);
  });
});
