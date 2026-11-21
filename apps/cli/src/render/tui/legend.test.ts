import { describe, expect, it } from 'vitest';

import { LEGEND_SEPARATOR, legend, legendSpans } from './legend.js';

describe('legend', () => {
  it('joins key and verb pairs in the order given with the one separator, no full stop', () => {
    expect(
      legend([
        { keys: '↑/↓', verb: 'select' },
        { keys: 'd', verb: 'withdraw' },
        { keys: 'Esc', verb: 'close' },
      ]),
    ).toBe('↑/↓ select · d withdraw · Esc close');
    expect(LEGEND_SEPARATOR).toBe(' · ');
  });

  it('is empty for no items and a bare pair for one', () => {
    expect(legend([])).toBe('');
    expect(legend([{ keys: 'Esc', verb: 'close' }])).toBe('Esc close');
  });

  it('says where the keys, the verbs and the separators are, so a view can draw the keys apart from the words', () => {
    const items = [
      { keys: '↑/↓', verb: 'select' },
      { keys: '[d / Del]', verb: 'withdraw', role: 'danger' },
      { keys: 'Esc', verb: 'close' },
    ] as const;
    const text = legend(items);
    const spans = legendSpans(items);
    // the spans cover the text exactly once, in order, with nothing left over
    expect(spans[0]?.from).toBe(0);
    expect(spans.at(-1)?.to).toBe(text.length);
    for (let i = 1; i < spans.length; i += 1) expect(spans[i]?.from).toBe(spans[i - 1]?.to);
    // each key is emphasised unless it names its own role; verbs and separators are dim
    expect(spans.filter((span) => span.role !== 'dim').map((span) => span.role)).toEqual([
      'strong',
      'danger',
      'strong',
    ]);
    expect(
      spans.filter((span) => span.role !== 'dim').map((span) => text.slice(span.from, span.to)),
    ).toEqual(['↑/↓', '[d / Del]', 'Esc']);
    expect(
      spans.filter((span) => span.role === 'dim').map((span) => text.slice(span.from, span.to)),
    ).toEqual([' select', LEGEND_SEPARATOR, ' withdraw', LEGEND_SEPARATOR, ' close']);
    expect(legendSpans([])).toEqual([]);
  });
});
