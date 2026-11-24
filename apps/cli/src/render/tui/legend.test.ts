import { describe, expect, it } from 'vitest';

import {
  LEGEND_SEPARATOR,
  exitKey,
  fitLegend,
  keyLabel,
  keyHint,
  keyToken,
  legendItems,
  legend,
  legendSpans,
  type LegendItem,
} from './legend.js';

const columnsOf = (text: string): number => [...text].length;

describe('keyToken: the bracket rule (ADR-0145 §3)', () => {
  it.each([
    'Enter',
    'Esc',
    'Tab',
    'Shift+Tab',
    'Space',
    'Backspace',
    'Del',
    '↑/↓',
    '←/→',
    'Tab/Shift+Tab',
  ])('writes the universal key %s plain', (key) => {
    expect(keyToken(key)).toBe(key);
  });

  it.each(['PgUp/PgDn', 'Home/End', 'PgUp', 'PgDn', 'Home', 'End'])(
    'writes the navigation key %s plain',
    (key) => {
      expect(keyToken(key)).toBe(key);
    },
  );

  it.each(['d', 'v', 'a', '1', 'Ctrl+Y', 'Ctrl+C', 'Ctrl+G', 'Alt+Enter', 'Ctrl+Shift+R'])(
    'brackets the letter or chord %s',
    (key) => {
      expect(keyToken(key)).toBe(`[${key}]`);
    },
  );

  it('is idempotent on a bracketed key, so a sentence can pass a token through twice', () => {
    expect(keyToken('[Ctrl+Y]')).toBe('[Ctrl+Y]');
    expect(keyToken(keyToken('d'))).toBe('[d]');
  });

  it('writes a list of keys joined by " / ", each by the same rule', () => {
    expect(keyLabel(['Esc', 'Ctrl+C'])).toBe('Esc / [Ctrl+C]');
    expect(keyLabel(['d', 'Del'])).toBe('[d] / Del');
    expect(keyLabel('Enter')).toBe('Enter');
  });

  it('joins a list that already holds a slash with a comma, so it reads', () => {
    expect(keyLabel(['↑/↓', 'PgUp/PgDn'])).toBe('↑/↓, PgUp/PgDn');
    expect(keyLabel(['←/→', '1'])).toBe('←/→, [1]');
  });

  it('does not know the arrow spellings the language retired', () => {
    expect(keyToken('↑↓')).toBe('[↑↓]');
    expect(keyToken('←→')).toBe('[←→]');
  });
});

describe('legend', () => {
  it('joins the items in the order given with the one separator, no full stop, and puts the key that leaves last', () => {
    expect(
      legend(
        [
          { keys: '↑/↓', verb: 'select' },
          { keys: 'd', verb: 'withdraw' },
        ],
        exitKey.close(),
      ),
    ).toBe('↑/↓ select · [d] withdraw · Esc close');
    expect(LEGEND_SEPARATOR).toBe(' · ');
  });

  it('is the exit alone for no items', () => {
    expect(legend([], exitKey.step())).toBe('Esc back');
  });

  it('draws free text between the keys as it is, dim, and an answer row with the one separator', () => {
    const items: readonly LegendItem[] = [
      { text: 'Notice 1–17 of 60' },
      { keys: 'PgUp/PgDn', verb: 'read' },
    ];
    expect(legend(items, exitKey.close())).toBe('Notice 1–17 of 60 · PgUp/PgDn read · Esc close');
    expect(
      legend(
        [
          { keys: 'Ctrl+Y', verb: 'Allow once', role: 'ok' },
          { keys: 'Ctrl+N', verb: 'Deny', role: 'danger' },
        ],
        exitKey.decide('stops the turn'),
      ),
    ).toBe('[Ctrl+Y] Allow once · [Ctrl+N] Deny · Esc stops the turn');
  });

  it('has the four Esc classes, each with its own words and no way to leave the effect out', () => {
    expect(legend([], exitKey.close())).toBe('Esc close');
    expect(legend([], exitKey.step())).toBe('Esc back');
    expect(legend([], exitKey.decide('stops the turn'))).toBe('Esc stops the turn');
    expect(legend([], exitKey.leave('leaves it running'))).toBe('Esc leaves it running');
    expect(legend([], exitKey.close(['Esc', 'Ctrl+C']))).toBe('Esc / [Ctrl+C] close');
    expect(exitKey.close().class).toBe('close');
    expect(exitKey.step().class).toBe('step');
    expect(exitKey.decide('stops').class).toBe('decide');
    expect(exitKey.leave('leaves').class).toBe('leave');
  });

  it('says where the keys, the verbs, the texts and the separators are, so a view can draw the keys apart from the words', () => {
    const items: readonly LegendItem[] = [
      { keys: '↑/↓', verb: 'select' },
      { text: 'reason' },
      { keys: 'd', verb: 'withdraw', role: 'danger' },
    ];
    const exit = exitKey.decide('stops the turn');
    const text = legend(items, exit);
    const spans = legendSpans(items, exit);
    // the spans cover the text exactly once, in order, with nothing left over
    expect(spans[0]?.from).toBe(0);
    expect(spans.at(-1)?.to).toBe(text.length);
    for (let i = 1; i < spans.length; i += 1) expect(spans[i]?.from).toBe(spans[i - 1]?.to);
    // each key is emphasised unless it names its own role (the deciding exit is a stop); words and separators are dim
    expect(spans.filter((span) => span.role !== 'dim').map((span) => span.role)).toEqual([
      'strong',
      'danger',
      'warn',
    ]);
    expect(
      spans.filter((span) => span.role !== 'dim').map((span) => text.slice(span.from, span.to)),
    ).toEqual(['↑/↓', '[d]', 'Esc']);
    expect(
      spans.filter((span) => span.role === 'dim').map((span) => text.slice(span.from, span.to)),
    ).toEqual([
      ' select',
      LEGEND_SEPARATOR,
      'reason',
      LEGEND_SEPARATOR,
      ' withdraw',
      LEGEND_SEPARATOR,
      ' stops the turn',
    ]);
  });

  it('indexes a bracketed key and a key list exactly', () => {
    const items: readonly LegendItem[] = [{ keys: ['d', 'Del'], verb: 'withdraw' }];
    const exit = exitKey.close(['Esc', 'Ctrl+C']);
    const text = legend(items, exit);
    const keys = legendSpans(items, exit)
      .filter((span) => span.role === 'strong')
      .map((span) => text.slice(span.from, span.to));
    expect(keys).toEqual(['[d] / Del', 'Esc / [Ctrl+C]']);
  });
});

describe('legendItems: a render with no key that leaves', () => {
  it('has the text of keyHint and the spans of a legend, covering the text once', () => {
    const items: readonly LegendItem[] = [
      { keys: 'Enter', verb: 'save' },
      { text: 'or' },
      { keys: 'd', verb: 'drop', role: 'danger' },
    ];
    const { text, spans } = legendItems(items);
    expect(text).toBe(keyHint(items));
    expect(text).toBe('Enter save · or · [d] drop');
    expect(spans[0]?.from).toBe(0);
    expect(spans.at(-1)?.to).toBe(text.length);
    for (let i = 1; i < spans.length; i += 1) expect(spans[i]?.from).toBe(spans[i - 1]?.to);
    expect(spans.filter((span) => span.role !== 'dim').map((span) => span.role)).toEqual([
      'strong',
      'danger',
    ]);
    expect(legendItems([])).toEqual({ text: '', spans: [] });
  });

  it('is the legend without its exit: legend(items, exit) = legendItems text + separator + exit', () => {
    const items: readonly LegendItem[] = [{ keys: 'v', verb: 'full diff' }];
    expect(legend(items, exitKey.close())).toBe(`${keyHint(items)} · Esc close`);
  });
});

describe('keyHint: a hint beside a row claims no exit', () => {
  it('is the same grammar without the key that leaves', () => {
    expect(keyHint([{ text: 'Notice 1–17 of 60' }, { keys: 'PgUp/PgDn', verb: 'read' }])).toBe(
      'Notice 1–17 of 60 · PgUp/PgDn read',
    );
    expect(keyHint([{ text: 'no key yet' }, { keys: 'Enter', verb: 'add one' }])).toBe(
      'no key yet · Enter add one',
    );
    expect(keyHint([{ keys: 'Ctrl+T', verb: 'toggle' }])).toBe('[Ctrl+T] toggle');
    expect(keyHint([])).toBe('');
  });
});

describe('fitLegend: the one fit-to-width rule', () => {
  const exit = exitKey.close();
  const required: readonly LegendItem[] = [{ keys: 'Enter', verb: 'apply' }];
  const optional = [
    { item: { keys: 'v', verb: 'full diff' } as const, priority: 1 },
    { item: { keys: 'a', verb: 'all' } as const, priority: 3 },
    { item: { keys: 'f', verb: 'filter' } as const, priority: 2 },
  ];
  const fits = (columns: number): string =>
    legend(fitLegend(required, optional, exit, columns, columnsOf), exit);

  it('keeps everything when it fits', () => {
    expect(fits(200)).toBe('Enter apply · [v] full diff · [a] all · [f] filter · Esc close');
  });

  it('drops the lowest priority first and never the required items or the exit', () => {
    expect(fits(52)).toBe('Enter apply · [a] all · [f] filter · Esc close');
    expect(fits(40)).toBe('Enter apply · [a] all · Esc close');
    expect(fits(1)).toBe('Enter apply · Esc close');
  });

  it('drops the later of two equal priorities first', () => {
    const equal = [
      { item: { keys: 'x', verb: 'first' } as const, priority: 1 },
      { item: { keys: 'y', verb: 'second' } as const, priority: 1 },
    ];
    expect(legend(fitLegend([], equal, exit, 28, columnsOf), exit)).toBe('[x] first · Esc close');
  });
});
