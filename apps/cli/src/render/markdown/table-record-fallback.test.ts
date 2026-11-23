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

  it('aligns every wrapped line of a right aligned column', () => {
    const source = '| a | b |\n| ---: | --- |\n| one two three four | x |';
    const lines = texts(source, 16).filter((line) => line.startsWith('│'));
    // Every content line closes its first column at the same position, so the right edge holds.
    const firstBorders = lines.map((line) => line.indexOf('│', 1));
    expect(new Set(firstBorders).size).toBe(1);
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
