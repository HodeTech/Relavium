import { describe, expect, it } from 'vitest';
import { layoutMarkdown, MarkdownStream, parseInline, parseMarkdown } from './index.js';

const text = (source: string, width = 80): string[] =>
  layoutMarkdown(parseMarkdown(source), width).map((row) => row.text);

describe('markdown projection', () => {
  it('keeps targets visible and treats unsupported links literally', () => {
    expect(parseInline('[site](https://example.test)')).toEqual([
      { text: 'site', linkURL: 'https://example.test' },
      { text: ' (https://example.test)', linkURL: 'https://example.test' },
    ]);
    expect(
      parseInline('[site](https://example.test "title")')
        .map((s) => s.text)
        .join(''),
    ).toBe('[site](https://example.test "title")');
    expect(text('![cat](https://example.test/cat)')).toEqual([
      '[image: cat] (https://example.test/cat)',
    ]);
  });
  it('honors rules, setext literals, headings, and fenced code', () => {
    expect(text('Title\n---')).toEqual(['Title', '---']);
    expect(text('- - -', 5)).toEqual(['─────']);
    expect(text('# Heading ##')).toEqual(['Heading']);
    expect(text('  ```ts\n  **x**\n  ```')).toEqual(['ts', '│ **x**']);
    expect(text('```x`y')).toEqual(['```x`y']);
  });
  it('renders fitting tables and falls back without hiding cell text', () => {
    const source = '| Name | Link |\n| --- | --- |\n| a | [x](https://x.test) |';
    expect(text(source)).toEqual([
      '┌──────┬────────────────────┐',
      '│ Name │ Link               │',
      '├──────┼────────────────────┤',
      '│ a    │ x (https://x.test) │',
      '└──────┴────────────────────┘',
    ]);
    expect(text(source, 12).join('')).toContain('https://x.');
  });
  it('uses a literal fallback when a table exceeds row or column limits', () => {
    const header = '| h |\n| --- |';
    const admitted = `${header}\n${Array.from({ length: 128 }, () => '| x |').join('\n')}`;
    const overflow = `${admitted}\n| y |`;
    expect(parseMarkdown(admitted)[0]?.kind).toBe('table');
    expect(parseMarkdown(overflow)[0]?.kind).toBe('literal');
    const row = (n: number, cell: string): string =>
      `| ${Array.from({ length: n }, () => cell).join(' | ')} |`;
    expect(parseMarkdown(`${row(32, 'h')}\n${row(32, '---')}`)[0]?.kind).toBe('table');
    expect(parseMarkdown(`${row(33, 'h')}\n${row(33, '---')}`)[0]?.kind).toBe('literal');
    expect(parseMarkdown('| h |\n| --- |\n| x | y |')[0]?.kind).toBe('literal');
  });
  it('wraps without splitting Unicode clusters and maintains the line invariant', () => {
    const rows = layoutMarkdown(parseMarkdown('alpha **👩‍💻** beta'), 7);
    expect(rows.map((r) => r.text).join('')).toContain('👩‍💻');
    for (const row of rows) expect(row.text).toBe(row.spans.map((s) => s.text).join(''));
    expect(text('界', 1)).toEqual(['?']);
  });
  it('preserves list depth, hanging continuations and excess-depth source', () => {
    expect(text('- one\n  - two\n    continuation\n- sibling')).toEqual([
      '• one',
      '  • two',
      '    continuation',
      '• sibling',
    ]);
    const lines = Array.from({ length: 9 }, (_, depth) => `${'  '.repeat(depth)}- item`);
    const rendered = text(lines.join('\n'));
    expect(rendered[7]).toBe('              • item');
    expect(rendered[8]).toBe('                - item');
  });
  it('keeps over-depth quotes literal', () => {
    expect(text('> '.repeat(9) + '**visible**')).toEqual(['> '.repeat(9) + '**visible**']);
  });
  it('is invariant to chunk boundaries at end of stream', () => {
    const source = 'First\n\n```ts\nhello\n```\n\n| h |\n| --- |\n| x |';
    const expected = text(source);
    for (let split = 0; split <= source.length; split++) {
      const stream = new MarkdownStream();
      stream.append(source.slice(0, split));
      stream.append(source.slice(split));
      expect(layoutMarkdown(stream.finish(), 80).map((row) => row.text)).toEqual(expected);
    }
  });
  it('keeps a pending table literal until it is complete', () => {
    const stream = new MarkdownStream();
    stream.append('| h |\n| --- |\n| x |');
    expect(layoutMarkdown(stream.snapshot(), 80).map((row) => row.text)).toEqual([
      '| h |',
      '| --- |',
      '| x |',
    ]);
    expect(layoutMarkdown(stream.finish(), 80).map((row) => row.text)[0]).toBe('┌───┐');
  });
  it('resets fence state between turns', () => {
    const stream = new MarkdownStream();
    stream.append('```\nopen');
    stream.finish();
    stream.append('# heading');
    expect(layoutMarkdown(stream.finish(), 80).map((row) => row.text)).toEqual(['heading']);
  });
});
