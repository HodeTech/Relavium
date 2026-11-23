import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const stripMarker = (text: string): string => text.replace(/^(> |│ )/u, '');

describe('a pending table streams as it finally draws (ADR-0143)', () => {
  it('lays out a pending table over the row limit exactly as the finished table', () => {
    // 129 body rows is one more than the limit, so the table is literal. While it is still pending, its wrapped
    // lines must match the finished literal table, or the transcript reflows when the stream ends.
    const source = `| h |\n| --- |\n${'| abcdefghij k |\n'.repeat(129)}`;
    const stream = new MarkdownStream();
    stream.append(source);
    expect(stream.tail(12, 400)).toEqual(layoutMarkdown(parseMarkdown(source), 12).slice(-400));
  });
  it('is wrapped to the full width with raw quote marks inside a quote, and re-wrapped inside its bar at the end', () => {
    // The pending lines are literal source with no container prefix; the finished table has the bar (decision 10).
    const source = `> | h |\n> | --- |\n${'> | abcdefghij k |\n'.repeat(129)}`;
    const stream = new MarkdownStream();
    stream.append(source);
    const live = stream.tail(12, 400).map((row) => row.text);
    const finished = layoutMarkdown(parseMarkdown(source), 12)
      .slice(-400)
      .map((row) => row.text);
    // Nothing is lost between the two: the same characters, apart from the bar, the raw marks and the blanks.
    const content = (rows: readonly string[]): string =>
      rows
        .map(stripMarker)
        .join('')
        .replace(/[>│\s]/gu, '');
    expect(content(live)).toBe(content(finished));
    expect(live[0]?.startsWith('> ')).toBe(true);
    expect(finished[0]?.startsWith('│ ')).toBe(true);
  });

  it('is literal while it arrives and a grid afterwards, when the table fits: its widths depend on every row', () => {
    const stream = new MarkdownStream();
    stream.append('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(stream.tail(40, 20).some((row) => row.text.includes('┌'))).toBe(false);
    stream.append('\n\ndone');
    expect(stream.tail(40, 20).some((row) => row.text.includes('┌'))).toBe(true);
  });
});
