import { describe, expect, it } from 'vitest';
import { displayWidth } from '../tui/viewport.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import type { MarkdownBlock, MarkdownDisplayLine } from './types.js';

const NOTICE = 'table shown as records: its grid does not fit this width';
const LONG = 'a'.repeat(70);
const WIDE = [
  '| Claim | Evidence |',
  '| --- | --- |',
  `| ${LONG} | \`src/x.ts\` and **bold** |`,
  '| second | |',
].join('\n');

const rows = (source: string, columns: number): MarkdownDisplayLine[] =>
  layoutMarkdown(parseMarkdown(source), columns) as MarkdownDisplayLine[];
const texts = (source: string, columns: number): string[] =>
  rows(source, columns).map((r) => r.text);

/** The text of each grid column, read from the content lines in order, with the spaces dropped. */
function columnTexts(lines: readonly string[]): string[] {
  const columns: string[][] = [];
  for (const line of lines.filter((text) => text.startsWith('│'))) {
    line
      .split('│')
      .slice(1, -1)
      .forEach((segment, index) => {
        (columns[index] ??= []).push(segment.trim());
      });
  }
  return columns.map((segments) => segments.join('').replace(/\s+/gu, ''));
}

/** The width of each grid column, read from the top border. */
function gridWidths(lines: readonly string[]): number[] {
  const top = lines.find((text) => text.startsWith('┌')) ?? '';
  return top
    .slice(1, -1)
    .split('┬')
    .map((segment) => [...segment].length - 2);
}

describe('a table too wide for one line keeps its grid (ADR-0143)', () => {
  it('draws a grid whose every line fits the width, and no notice at a usable width', () => {
    const lines = texts(WIDE, 40);
    expect(lines[0]?.startsWith('┌')).toBe(true);
    expect(lines.some((line) => line.includes(NOTICE))).toBe(false);
    for (const row of rows(WIDE, 40)) expect(displayWidth(row.text)).toBeLessThanOrEqual(40);
  });

  it('shrinks the widest column first and keeps every column at or above its floor', () => {
    // Floors: Claim 24 (its longest word, capped), Evidence 8. The 33 columns of content split 24 and 9.
    expect(gridWidths(texts(WIDE, 40))).toEqual([24, 9]);
  });

  it('starts a continuation line at its word, never at the space that broke the line', () => {
    const source = `| aaaaaaaa bbbb | ${'c'.repeat(20)} |\n| --- | --- |\n| x | y |`;
    expect(texts(source, 35)).toContain('│ bbbb     │                      │');
  });

  it('shares the excess in proportion to each column’s room above its floor, not first come', () => {
    // Natural widths 31, 36 and 13 share 40 columns of excess by room above their floors (23, 28, 5): proportional
    // shares 16, 20 and 3, then one more to the first column. First-come sharing would give 8, 19 and 13 instead.
    const source = `| ${'aaaaaaaa bbbbbbbb cccccccc dddd'} | ${'eeeeeeee ffffffff gggggggg hhhh iiii'} | ${'jjjjjjjj kkkk'} |\n| --- | --- | --- |\n| x | y | z |`;
    expect(gridWidths(texts(source, 50))).toEqual([14, 16, 10]);
  });

  it('draws the grid exactly at its floors, and records one column narrower', () => {
    // The floors of the sample are 24 and 8: 32 columns of content, so the grid needs a width of 39.
    expect(texts(WIDE, 39)[0]?.startsWith('┌')).toBe(true);
    expect(texts(WIDE, 38)[0]).toBe('table shown as records: its grid does ');
  });

  it('keeps every header and every cell, wrapped and never cropped', () => {
    const columns = columnTexts(texts(WIDE, 40));
    expect(columns[0]).toContain(LONG);
    expect(columns[0]).toContain('second');
    expect(columns[1]).toContain('Evidence');
    expect(columns[1]).toContain('src/x.ts');
    expect(columns[1]).toContain('andbold');
  });

  it('makes a row as tall as its tallest cell', () => {
    const lines = texts(WIDE, 40);
    const rules = lines.flatMap((line, index) => (line.startsWith('├') ? [index] : []));
    // The first body row lies between the rule under the header and the rule after it.
    const firstBody = lines.slice((rules[0] ?? 0) + 1, rules[1] ?? 0);
    expect(firstBody.length).toBeGreaterThan(1);
    expect(firstBody.every((line) => line.startsWith('│'))).toBe(true);
  });

  it('keeps inline styling in wrapped cell text and in the header labels', () => {
    const body = rows(WIDE, 40);
    expect(body.some((line) => line.spans.some((s) => s.code && s.text === 'src/x.ts'))).toBe(true);
    expect(body.some((line) => line.spans.some((s) => s.strong && s.text === 'bold'))).toBe(true);
    expect(body.some((line) => line.spans.some((s) => s.strong && s.text === 'Claim'))).toBe(true);
  });

  it('right aligns every wrapped line to the same edge', () => {
    // The break space must not count as content: each wrapped line of the right column ends one space before its border.
    expect(texts('| a | b |\n| ---: | --- |\n| one two three four | x |', 16)).toEqual([
      '┌──────────┬───┐',
      '│        a │ b │',
      '├──────────┼───┤',
      '│  one two │ x │',
      '│    three │   │',
      '│     four │   │',
      '└──────────┴───┘',
    ]);
  });

  it('centres every wrapped line, with the extra space on the right', () => {
    expect(
      texts(
        '| Description | n |\n| :---: | --- |\n| the quick brown fox jumps over the lazy dog | 1 |',
        24,
      ),
    ).toEqual([
      '┌──────────────────┬───┐',
      '│   Description    │ n │',
      '├──────────────────┼───┤',
      '│ the quick brown  │ 1 │',
      '│  fox jumps over  │   │',
      '│   the lazy dog   │   │',
      '└──────────────────┴───┘',
    ]);
  });

  it('keeps a run of spaces inside a cell from making a blank grid row', () => {
    const lines = texts(`| x${' '.repeat(200)}y | z |\n| --- | --- |\n| a | b |`, 40);
    const firstColumns = lines
      .filter((line) => line.startsWith('│'))
      .map((line) => line.split('│')[1]?.trim());
    expect(firstColumns).toEqual(['x', 'y', 'a']);
  });

  it('keeps a grapheme wider than its column whole, and never writes a question mark for it', () => {
    // Halfwidth katakana with combining voiced marks: one grapheme, 30 columns wide, taller than any floor.
    const wideGrapheme = `ｶ${'ﾞ'.repeat(29)}`;
    const lines = texts(`| h | b |\n| --- | --- |\n| ${wideGrapheme} | word word word |`, 40);
    expect(lines.join('\n')).toContain(wideGrapheme);
    expect(lines.join('')).not.toContain('?');
  });

  it('keeps a character wider than a record value line, as literal source, and never writes a question mark', () => {
    const lines = texts('| a | b |\n| --- | --- |\n| 漢 | 字 |', 3);
    expect(lines.join('')).not.toContain('?');
    expect(lines.join('')).toContain('漢');
  });

  it('does not expand a small table into a large transcript when its records would repeat a long header', () => {
    // Records repeat every header for every body row. Here they would be far larger than the source, so the table
    // stays literal and its output stays within a small multiple of its source.
    const header = Array.from({ length: 400 }, () => 'abcdefgh').join(' ');
    const source = `| ${header} | y |\n| --- | --- |\n${Array.from({ length: 127 }, () => '| x | y |').join('\n')}`;
    const lines = texts(source, 12);
    expect(lines.some((line) => line.includes('table shown as records'))).toBe(false);
    expect(lines.join('\n').length).toBeLessThan(4 * source.length);
  });

  it('keeps every record value on its two-space indent, with no stray leading space', () => {
    const lines = texts('| Claim | Evidence |\n| --- | --- |\n| aaaaaaaa bbbb text here | ok |', 8);
    const values = lines.filter((line) => line.startsWith(' '));
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((line) => /^ {2}\S/u.test(line))).toBe(true);
  });

  it('rules body rows apart only when some cell wraps', () => {
    const wrapping = texts(WIDE, 40);
    // The rule under the header, and one between the two body rows; no rule before the bottom border.
    expect(wrapping.filter((line) => line.startsWith('├')).length).toBe(2);
    const compact = texts('| a | b |\n| --- | --- |\n| x | y |\n| z | w |\n| p | q |', 80);
    expect(compact.filter((line) => line.startsWith('├')).length).toBe(1);
  });
});

describe('records are the fallback when even the floors do not fit', () => {
  it('is drawn as one labelled record per body row, with a dim notice first', () => {
    const lines = texts(WIDE, 16);
    expect(
      lines
        .slice(0, 2)
        .map((line) => line.trim())
        .join(' '),
    ).toContain('table shown as');
    expect(lines).toContain('Claim');
    expect(lines).toContain('Evidence');
    // One blank line before each of the two records.
    expect(lines.filter((line) => line === '')).toHaveLength(2);
    expect(lines.some((line) => /[┌┬┐│─├┼┤└┴┘]/u.test(line))).toBe(false);
  });

  it('draws the notice in full, wrapped over its rows, at the narrow width', () => {
    const lines = texts(WIDE, 16);
    const notice = lines
      .slice(0, lines.indexOf(''))
      .map((line) => line.trim())
      .join(' ');
    expect(notice).toBe(NOTICE);
  });

  it('shows an empty cell as a dim dash and a blank header as its column number', () => {
    // Its grid needs 16 columns; at 12 even the floors do not fit, so the records are drawn.
    const source = '| | Evidence |\n| --- | --- |\n| a | |';
    const lines = rows(source, 12);
    const dash = lines.find((line) => line.text.trim() === '—');
    // The dash shares its span with the dim indent, so the whole line is dim.
    expect(dash?.spans.every((span) => span.dim === true)).toBe(true);
    expect(texts(source, 12)).toContain('column 1');
  });

  it('draws records inside a quote with the quote bar and no second bar', () => {
    const quoted = WIDE.split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const lines = texts(quoted, 16);
    expect(lines.every((line) => line.startsWith('│ '))).toBe(true);
    expect(lines.some((line) => line.startsWith('│ │'))).toBe(false);
    expect(lines).toContain('│ Claim');
  });

  it('keeps every line within the width from 5 to 60 columns, grid or records', () => {
    for (let columns = 5; columns <= 60; columns++) {
      for (const row of rows(WIDE, columns)) {
        expect(displayWidth(row.text), `width ${columns}: ${row.text}`).toBeLessThanOrEqual(
          columns,
        );
      }
    }
  });

  it('pairs each label with its own value, and draws labels bold and the notice dim', () => {
    const lines = texts(WIDE, 16);
    expect(lines[lines.indexOf('Claim') + 1]?.trimStart().startsWith('aaaaaaaa')).toBe(true);
    expect(lines[lines.indexOf('Evidence') + 1]?.trimStart().startsWith('src/x.ts')).toBe(true);
    const body = rows(WIDE, 16);
    const claim = body.find((line) => line.text === 'Claim');
    expect(claim?.spans.every((span) => span.strong === true)).toBe(true);
    const notice = body.find((line) => line.text.startsWith('table shown'));
    expect(notice?.spans.every((span) => span.dim === true)).toBe(true);
  });

  it('draws a header-only table as a grid when it fits, and keeps it literal only when it does not', () => {
    expect(texts('| a |\n| --- |', 80)).toEqual(['┌───┐', '│ a │', '├───┤', '└───┘']);
    const wide = texts(`| ${'h'.repeat(200)} |\n| --- |`, 40);
    expect(wide.join('')).toContain('|');
    expect(wide.some((line) => line.includes('┌'))).toBe(false);
  });

  it('draws a literal table by the geometry rule, which replaces a glyph wider than the line with a question mark', () => {
    // At a width of one column no grid, no record and no literal line can hold a double-width glyph (ADR-0143 decision 6).
    expect(texts('| a |\n| --- |\n| 漢 |', 1).join('')).toContain('?');
    expect(texts('| a |\n| --- |\n| 漢 |', 2).join('')).toContain('漢');
  });

  it('stays literal when only a header is too wide, because there is no record to draw', () => {
    const lines = texts(`| ${'h'.repeat(200)} |\n| --- |`, 40);
    expect(lines.some((line) => line.includes(NOTICE))).toBe(false);
    expect(lines.join('')).toContain('|');
  });

  it('stays literal at a width with no room past the record indent', () => {
    expect(texts(WIDE, 2).some((line) => line.includes(NOTICE))).toBe(false);
  });

  it('stays literal when a cell holds a hard break', () => {
    const block: MarkdownBlock = {
      kind: 'table',
      source: '| a | b |\n| --- | --- |\n| x | y |',
      text: '',
      rows: [
        ['a', 'b'],
        ['x\ny', 'z'],
      ],
      align: ['left', 'left'],
    };
    const lines = layoutMarkdown([block], 8).map((line) => line.text);
    expect(lines.some((line) => line.includes(NOTICE))).toBe(false);
    expect(lines.some((line) => line.startsWith('┌'))).toBe(false);
  });

  it('draws the grid at exactly its width, and records one column narrower', () => {
    // The grid of this table is 9 columns wide: 1 + (1 + 3) + (1 + 3).
    const source = '| a | b |\n| --- | --- |\n| x | y |';
    expect(texts(source, 9)[0]).toBe('┌───┬───┐');
    const narrow = texts(source, 8);
    expect(narrow.some((line) => line.startsWith('┌'))).toBe(false);
    const trimmed = narrow.map((line) => line.trim());
    expect(trimmed).toContain('a');
    expect(trimmed).toContain('x');
  });
});

describe('a table over the fixed limit stays literal, and wraps without leading spaces', () => {
  it('starts each continuation line at its text, not at the space that broke it', () => {
    const header = `| ${Array.from({ length: 33 }, (_, i) => `c${i + 1}`).join(' | ')} |`;
    const separator = `| ${Array.from({ length: 33 }, () => '---').join(' | ')} |`;
    const lines = texts([header, separator].join('\n'), 80);
    expect(lines.filter((line) => line.startsWith(' '))).toEqual([]);
    expect(lines).toContain('c29 | c30 | c31 | c32 | c33 |');
  });
});

describe('a table that fits as a grid', () => {
  it('leaves the single-line grid as it was', () => {
    expect(texts('| a | b |\n| --- | --- |\n| x | y |', 80)[0]).toBe('┌───┬───┐');
  });
});

/**
 * The grid of text that is not ASCII (ADR-0143): glyphs that take two cells, marks and joiners that take none, and
 * cells that read right to left. Every drawn row must be as wide as every other, whatever the cells hold.
 */
describe('a grid of non-ASCII text keeps its rows aligned and loses no glyph', () => {
  const CASES: readonly (readonly [string, readonly (readonly string[])[]])[] = [
    [
      'CJK glyphs that take two cells',
      [
        ['名前', '説明'],
        ['漢字テスト漢字テスト', 'こんにちは 世界 こんにちは 世界 こんにちは 世界'],
        ['ab', '한국어 한국어 한국어 한국어'],
      ],
    ],
    [
      'combining marks, alone and stacked',
      [
        ['word', 'note'],
        [
          'e\u0301a\u0300\u0301e\u0301a\u0300\u0301e\u0301a\u0300\u0301 e\u0301',
          'n\u0303o '.repeat(8).trim(),
        ],
        ['x', 'Z\u0308'],
      ],
    ],
    [
      'emoji ZWJ sequences, a flag with a variation selector and a skin tone',
      [
        ['a', 'b'],
        [
          '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'.repeat(6),
          '\u{1F3F3}\uFE0F\u200D\u{1F308} '.repeat(6).trim(),
        ],
        ['\u{1F469}\u{1F3FD}\u200D\u{1F4BB}', 'ok'],
      ],
    ],
    [
      'Hebrew and Arabic cells',
      [
        ['עברית', 'عربى'],
        ['שלום עולם שלום עולם שלום עולם', 'مرحبا بالعالم مرحبا بالعالم مرحبا'],
        ['a', 'ב'],
      ],
    ],
  ];

  const sourceOf = (cells: readonly (readonly string[])[]): string => {
    const [header = [], ...body] = cells;
    const line = (row: readonly string[]): string => `| ${row.join(' | ')} |`;
    return [line(header), line(header.map(() => '---')), ...body.map(line)].join('\n');
  };

  it.each(CASES)('%s', (_name, cells) => {
    const source = sourceOf(cells);
    const expected = (cells[0] ?? []).map((_cell, column) =>
      cells
        .map((row) => row[column] ?? '')
        .join('')
        .replace(/\s+/gu, ''),
    );
    let drawn = 0;
    let wrapped = 0;
    for (let width = 6; width <= 90; width++) {
      const lines = texts(source, width);
      if (!lines[0]?.startsWith('┌')) continue; // the records and the literal table are not the grid under test
      drawn++;
      const where = `at width ${width}`;
      // Every drawn row, border or content, is as wide as every other, and none is wider than the line.
      expect(new Set(lines.map(displayWidth)), where).toEqual(new Set([displayWidth(lines[0])]));
      expect(displayWidth(lines[0]), where).toBeLessThanOrEqual(width);
      // No glyph of the source is lost or moved: each column reads back as its cells, in order.
      expect(columnTexts(lines), where).toEqual(expected);
      if (lines.filter((line) => line.startsWith('│')).length > cells.length) wrapped++;
    }
    // The sweep is not vacuous: the grid is drawn at some widths, and a cell wraps in it at some of them.
    expect(drawn).toBeGreaterThan(0);
    if (cells.some((row) => row.some((cell) => cell.includes(' ')))) {
      expect(wrapped).toBeGreaterThan(0);
    }
  });
});
