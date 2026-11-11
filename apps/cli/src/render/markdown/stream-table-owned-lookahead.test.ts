import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { BlockLineClassifier, parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const containers = [
  { name: 'root', wrap: (lines: readonly string[]) => lines.join('\n') },
  {
    name: 'quote',
    wrap: (lines: readonly string[]) => lines.map((line) => '> ' + line).join('\n'),
  },
  {
    name: 'list',
    wrap: (lines: readonly string[]) =>
      lines.map((line, index) => (index ? '  ' : '- ') + line).join('\n'),
  },
  {
    name: 'quoted list',
    wrap: (lines: readonly string[]) =>
      lines.map((line, index) => (index ? '>   ' : '> - ') + line).join('\n'),
  },
  {
    name: 'nested list',
    wrap: (lines: readonly string[]) =>
      ['- # outer', '  - # inner', ...lines.map((line) => '    ' + line)].join('\n'),
  },
];

function verify(source: string): void {
  const blocks = parseMarkdown(source);
  expect(blocks.some((block) => block.kind === 'rule')).toBe(true);
  for (const [chunk, draw] of [
    [source.length, false],
    [1, false],
    [1, true],
    [17, true],
  ] as const) {
    const stream = new MarkdownStream();
    for (let at = 0; at < source.length; at += chunk) {
      stream.append(source.slice(at, at + chunk));
      if (draw) {
        const before = stream.tail(37, 100);
        stream.tail(11, 100);
        expect(stream.tail(37, 100)).toEqual(before);
      }
    }
    for (const columns of [11, 37, 80])
      expect(stream.tail(columns, 100), JSON.stringify({ source, chunk, draw, columns })).toEqual(
        layoutMarkdown(blocks, columns),
      );
    expect(stream.sourceTail()).toBe(source);
    const continued = source + '\n\nNEXT';
    stream.append('\n\nNEXT');
    expect(stream.tail(37, 100)).toEqual(layoutMarkdown(parseMarkdown(continued), 37));
    expect(stream.sourceTail()).toBe(continued);
    expect(stream.work.lexical).toBeLessThan(continued.length * 5);
    expect(stream.finish()).toEqual(parseMarkdown(continued));
  }
}

describe('table-owned physical lookahead', () => {
  it.each(containers)('does not revise a table delimiter or body in $name', ({ wrap }) => {
    for (const body of [[], ['row'], ['r | s'], ['==='], ['===', 'row']]) {
      const lines = wrap(['h | b', '--- | ---', ...body]).split('\n');
      const classifier = new BlockLineClassifier();
      const headerAt = lines.length - body.length - 2;
      for (const line of lines.slice(0, headerAt)) classifier.commit(line);
      const header = classifier.commit(lines[headerAt] ?? '');
      expect(header.tableBoundary).toBeUndefined();
      expect(classifier.commit(lines[headerAt + 1] ?? '').tableBoundary).toBe(true);
      for (const line of lines.slice(headerAt + 2)) {
        const row = classifier.commit(line);
        expect(row.tableRow).toBe(true);
        expect(row.revision).toBeUndefined();
      }
      const rule = wrap(['h | b', '--- | ---', '---']).split('\n').at(-1) ?? '';
      const preview = classifier.preview(rule);
      expect(preview.revision).toBeUndefined();
      expect(preview.block.kind).toBe('rule');
      const committed = classifier.commit(rule);
      expect(committed.revision).toBeUndefined();
      expect(committed.block.kind).toBe('rule');
    }
  });

  it.each(containers)('preserves rule and equals chains after tables in $name', ({ wrap }) => {
    for (const body of [[], ['row'], ['r | s'], ['==='], ['===', 'row']])
      for (const chain of [['---'], ['---', '===', '---'], ['===', '---']])
        verify(wrap(['h | b', '--- | ---', ...body, ...chain, '', 'END']));
  });

  it('still recognizes a fresh header after an actual table boundary', () => {
    for (const { wrap } of containers) {
      const source = wrap([
        'h | b',
        '--- | ---',
        'row',
        '---',
        '',
        'new | header',
        '--- | ---',
        'body',
        '---',
        '',
        'END',
      ]);
      expect(parseMarkdown(source).filter((block) => block.kind === 'table')).toHaveLength(2);
      verify(source);
    }
  });
});
