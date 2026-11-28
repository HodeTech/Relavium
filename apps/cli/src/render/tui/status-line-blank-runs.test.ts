/**
 * Runs of blank characters in a status line's values (MVP-11 unit 7, round 2: F5). The Home's line is `<provider> · <model> · <mode> mode`, THREE
 * spaces and the directory, and the three spaces are what says the directory is not one of the defaults. A model id (`[chat].default_model`
 * reaches it from the repository's own layer) that carried three spaces drew the gap itself, and `claude-x   ~/work/other` drew a second,
 * false directory beside the real one. Every free value now has each run of blank characters (the space, the tab, the no-break space,
 * U+2000 to U+200A, U+3000, the line breaks and the braille blank) turned into ONE space, so the only run of blanks the line can hold is its
 * own gap.
 *
 * The oracle is independent of the module: the text's runs of two or more blank characters, read with this file's own class.
 */
import { describe, expect, it } from 'vitest';

import { statusLine, type ChatStatusInput, type HomeStatusInput } from './status-line.js';
import { displayWidth } from './viewport.js';

const ch = (code: number): string => String.fromCodePoint(code);

/** The blank characters, as this file names them: the ones `\s` matches, and the braille blank a terminal draws as a space. */
const BLANK_RANGES: readonly (readonly [number, number, string])[] = [
  [0x09, 0x0d, 'the tab, the line breaks, the vertical tab and the form feed'],
  [0x20, 0x20, 'the space'],
  [0xa0, 0xa0, 'the no-break space'],
  [0x1680, 0x1680, 'the Ogham space mark'],
  [0x2000, 0x200a, 'the quads and spaces of U+2000 to U+200A'],
  [0x2028, 0x2029, 'the line and paragraph separators'],
  [0x202f, 0x202f, 'the narrow no-break space'],
  [0x205f, 0x205f, 'the medium mathematical space'],
  [0x3000, 0x3000, 'the ideographic space'],
  [0x2800, 0x2800, 'the braille blank'],
];
const BLANK_CODES = BLANK_RANGES.flatMap(([from, to]) =>
  Array.from({ length: to - from + 1 }, (_, offset) => from + offset),
);
const BLANK_RUN = new RegExp(
  `[${BLANK_RANGES.map(([from, to]) => `${ch(from)}-${ch(to)}`).join('')}]{2,}`,
  'gu',
);

const GAP = '   ';
const HOME: HomeStatusInput = {
  surface: 'home',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  mode: 'ask',
  directory: '~/work/here',
};
const CHAT: ChatStatusInput = {
  surface: 'chat',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  mode: 'ask',
  turns: 2,
  cost: { full: '$0.01', short: '$0.01', qualified: false },
};
const WIDTHS = [60, 80, 100, 120, 200] as const;

/** The runs of blanks in a line. */
const runsOf = (text: string): string[] => text.match(BLANK_RUN) ?? [];

/** What a line may hold of them: its own gap, once, or nothing (a narrow line may have given its directory up). */
const ownGapAtMost = (text: string): string[] => {
  const runs = runsOf(text);
  return runs.every((run) => run === GAP) && runs.length <= 1 ? [] : runs;
};

const hex = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

/** The Home's input with `value` in one of its free fields. */
function homeWith(
  field: 'provider' | 'model' | 'effort' | 'mode' | 'directory',
  value: string,
): HomeStatusInput {
  const base: HomeStatusInput = { ...HOME, effort: 'high' };
  switch (field) {
    case 'provider':
      return { ...base, provider: value };
    case 'model':
      return { ...base, model: value };
    case 'effort':
      return { ...base, effort: value };
    case 'mode':
      return { ...base, mode: value };
    case 'directory':
      return { ...base, directory: `~/${value}` };
  }
}

describe('the three shapes of the report, at every width', () => {
  it.each(WIDTHS)('a model that carries the gap and a mode (%i columns)', (columns) => {
    const { text } = statusLine({ ...HOME, model: 'claude-x   auto mode' }, columns);
    expect(ownGapAtMost(text)).toEqual([]);
    if (columns >= 80) expect(text).toBe('anthropic · claude-x auto mode · ask mode   ~/work/here');
  });

  it.each(WIDTHS)('a model that carries the gap and a second directory (%i columns)', (columns) => {
    const { text } = statusLine({ ...HOME, model: 'claude-x   ~/work/other' }, columns);
    expect(ownGapAtMost(text), 'one gap, so one directory after it').toEqual([]);
    if (columns >= 80) {
      expect(text).toBe('anthropic · claude-x ~/work/other · ask mode   ~/work/here');
      expect(text.endsWith(`${GAP}~/work/here`)).toBe(true);
      expect(text.split(GAP)).toHaveLength(2);
    }
  });

  it.each(WIDTHS)(
    'a model of no-break spaces, which the scrub folds to spaces (%i columns)',
    (columns) => {
      const model = `claude-x${ch(0xa0)}${ch(0xa0)}${ch(0xa0)}~/work/other`;
      const { text } = statusLine({ ...HOME, model }, columns);
      expect(ownGapAtMost(text)).toEqual([]);
      if (columns >= 80)
        expect(text).toBe('anthropic · claude-x ~/work/other · ask mode   ~/work/here');
    },
  );
});

describe.each(
  BLANK_RANGES.map(([from, to, label]) => ({
    range: from === to ? hex(from) : `${hex(from)} to ${hex(to)}`,
    label,
    from,
    to,
  })),
)('$range ($label) in a value', ({ from, to }) => {
  const codes = Array.from({ length: to - from + 1 }, (_, offset) => from + offset);

  it.each(['provider', 'model', 'effort', 'mode', 'directory'] as const)(
    'in the Home’s %s',
    (field) => {
      for (const code of codes) {
        const value = `first${ch(code).repeat(3)}second`;
        const input = homeWith(field, value);
        for (const columns of [100, 200]) {
          const { text } = statusLine(input, columns);
          expect(runsOf(text), `${hex(code)} in ${field} at ${String(columns)}`).toEqual([GAP]);
          expect(text.split(GAP), 'the gap is where it was').toHaveLength(2);
        }
      }
    },
  );

  it('in a chat, where there is no gap at all', () => {
    for (const code of codes) {
      const value = `first${ch(code).repeat(3)}second`;
      for (const field of ['provider', 'model', 'mode'] as const) {
        const { text } = statusLine({ ...CHAT, [field]: value }, 200);
        expect(runsOf(text), `${hex(code)} in ${field}`).toEqual([]);
      }
    }
  });
});

describe('what the pass leaves alone', () => {
  it('draws the real gap exactly: three spaces, whatever the width the ladder cuts to', () => {
    for (let columns = 60; columns <= 140; columns += 1) {
      const { text } = statusLine(HOME, columns);
      expect(ownGapAtMost(text), `${String(columns)} columns`).toEqual([]);
      expect(displayWidth(text)).toBeLessThanOrEqual(columns - (columns >= 100 ? 8 : 6));
    }
  });

  it('a value with single spaces is not changed, and one blank character is one space', () => {
    expect(statusLine({ ...HOME, model: 'a b c' }, 120).text).toBe(
      'anthropic · a b c · ask mode   ~/work/here',
    );
    expect(statusLine({ ...HOME, model: `a${ch(0x3000)}b` }, 120).text).toBe(
      'anthropic · a b · ask mode   ~/work/here',
    );
  });

  it('an effort and a mode are words, so the line has no blank run but the gap with all of them set', () => {
    const { text } = statusLine({ ...HOME, effort: 'max' }, 120);
    expect(text).toBe('anthropic · claude-haiku-5-5 · ask mode · effort max   ~/work/here');
    expect(BLANK_CODES.length).toBeGreaterThan(20);
  });
});
