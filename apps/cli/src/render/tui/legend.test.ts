import { describe, expect, it } from 'vitest';

import {
  LEGEND_SEPARATOR,
  exitKey,
  fitLegend,
  inertLegendText,
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

  it('fits exactly: at the width of the text it keeps everything, and one column less drops the lowest priority', () => {
    const all = 'Enter apply · [v] full diff · [a] all · [f] filter · Esc close';
    const withoutV = 'Enter apply · [a] all · [f] filter · Esc close';
    const withoutVF = 'Enter apply · [a] all · Esc close';
    const bare = 'Enter apply · Esc close';
    for (const [text, smaller] of [
      [all, withoutV],
      [withoutV, withoutVF],
      [withoutVF, bare],
    ] as const) {
      expect(fits(columnsOf(text)), `at ${String(columnsOf(text))} columns`).toBe(text);
      expect(fits(columnsOf(text) - 1), `at ${String(columnsOf(text) - 1)} columns`).toBe(smaller);
    }
    // the same rule through a width function that is not the code-unit count: a wide mark costs two columns
    const wide = (text: string): number => [...text].length + (text.includes('漢') ? 1 : 0);
    const items = [{ item: { text: '漢' }, priority: 1 }];
    const fullWide = legend(fitLegend([], items, exit, 99, wide), exit);
    expect(fullWide).toBe('漢 · Esc close');
    expect(legend(fitLegend([], items, exit, wide(fullWide), wide), exit)).toBe(fullWide);
    expect(legend(fitLegend([], items, exit, wide(fullWide) - 1, wide), exit)).toBe('Esc close');
  });

  it('drops the later of two equal priorities first', () => {
    const equal = [
      { item: { keys: 'x', verb: 'first' } as const, priority: 1 },
      { item: { keys: 'y', verb: 'second' } as const, priority: 1 },
    ];
    expect(legend(fitLegend([], equal, exit, 28, columnsOf), exit)).toBe('[x] first · Esc close');
  });
});

describe('inertLegendText: text of another’s making inside a legend', () => {
  it('turns the legend’s separator into something that does not look like it, wherever it stands', () => {
    expect(inertLegendText('a · b')).toBe('a - b');
    expect(inertLegendText('a · b · c')).toBe('a - b - c');
    expect(inertLegendText('a  ·  b')).toBe('a  -  b');
    expect(inertLegendText(`a${LEGEND_SEPARATOR}Esc keeps them`)).not.toContain(LEGEND_SEPARATOR);
    // a dot with no spaces is not the separator
    expect(inertLegendText('a·b')).toBe('a·b');
  });

  it('parenthesises a bracketed letter, digit or chord, and leaves every other bracket alone', () => {
    expect(inertLegendText('[Ctrl+Y]')).toBe('(Ctrl+Y)');
    expect(inertLegendText('[ctrl+y] [Alt+Enter] [Ctrl+Shift+R] [Cmd+K]')).toBe(
      '(ctrl+y) (Alt+Enter) (Ctrl+Shift+R) (Cmd+K)',
    );
    expect(inertLegendText('[d] [v] [1] [é]')).toBe('(d) (v) (1) (é)');
    expect(inertLegendText('pages/[id].tsx [slug] [] [Enter] [a b]')).toBe(
      'pages/[id].tsx [slug] [] [Enter] [a b]',
    );
  });

  it('every legend key the grammar brackets is made inert, and the result holds no token keyToken would write', () => {
    for (const key of ['d', 'v', '1', 'Ctrl+Y', 'Ctrl+C', 'Alt+Enter', 'Ctrl+Shift+R']) {
      expect(inertLegendText(keyToken(key)), key).toBe(`(${key})`);
    }
  });

  it('leaves a plain text as it is', () => {
    expect(inertLegendText('')).toBe('');
    expect(inertLegendText('src/app.ts')).toBe('src/app.ts');
  });

  describe('a forgery that is not byte for byte the separator or the token (round-2 fix)', () => {
    // each spelling is built from escapes, so the test names what it holds
    const NBSP = '\u00A0';
    const THIN = '\u2009';
    const EM = '\u2003';
    const ZERO_WIDTH = '\u200B';

    it('any whitespace around the dot is the separator: a no-break, thin or em space, and a dot in a row of them', () => {
      for (const space of [NBSP, THIN, EM, '\t', '\u3000'])
        expect(inertLegendText(`a${space}·${space}b`), JSON.stringify(space)).toBe(
          `a${space}-${space}b`,
        );
      expect(inertLegendText(`a${NBSP}· b`)).toBe(`a${NBSP}- b`);
      expect(inertLegendText('a · · b')).toBe('a - - b');
      expect(inertLegendText('a  ·   ·  b')).toBe('a  -   -  b');
    });

    it('a lookalike of the dot is the separator too: the bullet and dot operators, the hyphenation point, the katakana and Greek middle dots', () => {
      for (const dot of ['\u2219', '\u22C5', '\uFF65', '\u2027', '\u30FB', '\u0387'])
        expect(
          inertLegendText(`a ${dot} Esc keeps them`),
          `U+${dot.codePointAt(0)?.toString(16)}`,
        ).toBe('a - Esc keeps them');
    });

    it('a dot with no whitespace on one side, or on both, is a name and not the separator, whatever the dot is', () => {
      for (const dot of ['·', '\u2219', '\u22C5', '\uFF65', '\u2027']) {
        expect(inertLegendText(`a${dot}b`), dot).toBe(`a${dot}b`);
        expect(inertLegendText(`a ${dot}b`), dot).toBe(`a ${dot}b`);
        expect(inertLegendText(`a${dot} b`), dot).toBe(`a${dot} b`);
      }
    });

    it('a zero-width character beside the dot does not hide it, and it stays where it was written', () => {
      expect(inertLegendText(`a${ZERO_WIDTH} · b`)).toBe(`a${ZERO_WIDTH} - b`);
      expect(inertLegendText(`a ·${ZERO_WIDTH} b`)).toBe(`a -${ZERO_WIDTH} b`);
      expect(inertLegendText(`a${ZERO_WIDTH}·${ZERO_WIDTH}b`)).toBe(
        `a${ZERO_WIDTH}·${ZERO_WIDTH}b`,
      );
      for (const invisible of [
        '\u200C',
        '\u200D',
        '\u2060',
        '\uFEFF',
        '\u00AD',
        '\u200E',
        '\u202E',
      ])
        expect(inertLegendText(`a ${invisible}·${invisible} b`), JSON.stringify(invisible)).toBe(
          `a ${invisible}-${invisible} b`,
        );
    });

    it('a character that draws a blank cell beside the dot is the whitespace of the separator: the Braille blank and the Hangul fillers', () => {
      for (const blank of ['\u2800', '\u115F', '\u1160', '\u3164', '\uFFA0']) {
        const label = `U+${blank.codePointAt(0)?.toString(16)}`;
        expect(inertLegendText(`a${blank}·${blank}b`), label).toBe(`a${blank}-${blank}b`);
        expect(inertLegendText(`a ·${blank}b`), label).toBe(`a -${blank}b`);
        expect(inertLegendText(`a${blank}· b`), label).toBe(`a${blank}- b`);
        // a blank on one side only is still a name, as a space on one side only is
        expect(inertLegendText(`a${blank}·b`), label).toBe(`a${blank}·b`);
      }
    });

    it('a chord is read by its shape: a Cyrillic or Greek letter in its name does not make it a different thing', () => {
      expect(inertLegendText('[\u0421trl+Y]')).toBe('(\u0421trl+Y)');
      expect(inertLegendText('[Ctrl+\u0423]')).toBe('(Ctrl+\u0423)');
      expect(inertLegendText('[\u0391lt+Enter]')).toBe('(\u0391lt+Enter)');
      expect(inertLegendText('[\u0443]')).toBe('(\u0443)');
    });

    it('a fullwidth bracket and a fullwidth plus are read as what they look like, and the characters written stay inside the parentheses', () => {
      expect(inertLegendText('\uFF3BCtrl+Y\uFF3D')).toBe('(Ctrl+Y)');
      expect(inertLegendText('[Ctrl\uFF0BY]')).toBe('(Ctrl\uFF0BY)');
      expect(inertLegendText('\uFF3BCtrl\uFF0BY\uFF3D')).toBe('(Ctrl\uFF0BY)');
      expect(inertLegendText('\uFF3Bd\uFF3D')).toBe('(d)');
    });

    it('a zero-width character inside the token does not hide it, and stays where it was written', () => {
      expect(inertLegendText(`[Ctrl+${ZERO_WIDTH}Y]`)).toBe(`(Ctrl+${ZERO_WIDTH}Y)`);
      expect(inertLegendText(`[${ZERO_WIDTH}Ctrl+Y]`)).toBe(`(${ZERO_WIDTH}Ctrl+Y)`);
      expect(inertLegendText(`[Ctrl${ZERO_WIDTH}+Y]`)).toBe(`(Ctrl${ZERO_WIDTH}+Y)`);
      expect(inertLegendText(`[Ctrl+Y${ZERO_WIDTH}]`)).toBe(`(Ctrl+Y${ZERO_WIDTH})`);
      expect(inertLegendText(`[${ZERO_WIDTH}d]`)).toBe(`(${ZERO_WIDTH}d)`);
    });

    it('a separator inside a chord is made inert as well as the chord', () => {
      expect(inertLegendText('[Ctrl+ · Y]')).toBe('(Ctrl+ - Y)');
    });

    it('an emoji sequence, a name in another script and a bracketed word are left exactly as written', () => {
      const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
      expect(inertLegendText(`${family} · ${family}`)).toBe(`${family} - ${family}`);
      expect(inertLegendText(`${family}.ts`)).toBe(`${family}.ts`);
      expect(inertLegendText('\u30C6\u30B9\u30C8\u30FB\u30D5\u30A1\u30A4\u30EB.ts')).toBe(
        '\u30C6\u30B9\u30C8\u30FB\u30D5\u30A1\u30A4\u30EB.ts',
      );
      expect(inertLegendText('x\uFB01le [id].tsx')).toBe('x\uFB01le [id].tsx');
    });

    it('is idempotent: what it returns holds no separator and no token for it to find again', () => {
      for (const text of [
        'a · · b',
        `a${NBSP}\u2219${THIN}b [Ctrl+Y] \uFF3Bd\uFF3D [\u0421trl+Y] [Ctrl+${ZERO_WIDTH}Y]`,
        '[Ctrl+ · Y] · [Alt+Enter]',
      ])
        expect(inertLegendText(inertLegendText(text)), text).toBe(inertLegendText(text));
    });
  });
});
