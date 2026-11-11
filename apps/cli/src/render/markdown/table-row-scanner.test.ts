import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const containers = [
  { first: '', next: '' },
  { first: '> ', next: '> ' },
  { first: '- ', next: '  ' },
  { first: '> - ', next: '>   ' },
];

function sourceIn(lines: readonly string[], container: (typeof containers)[number]): string {
  return lines.map((line, index) => (index ? container.next : container.first) + line).join('\n');
}

function check(source: string): void {
  for (const chunk of [source.length, 1, 17]) {
    const stream = new MarkdownStream();
    for (let at = 0; at < source.length; at += chunk) {
      stream.append(source.slice(at, at + chunk));
      if (chunk !== source.length) {
        const rows = stream.tail(80, 300);
        stream.tail(31, 300);
        expect(stream.tail(80, 300)).toEqual(rows);
      }
    }
    expect(stream.tail(80, 300), JSON.stringify({ source, chunk })).toEqual(
      layoutMarkdown(parseMarkdown(source), 80),
    );
    expect(stream.sourceTail()).toBe(source);
    expect(stream.finish()).toEqual(parseMarkdown(source));
  }
}

describe('table body admission and escape indexing', () => {
  it.each(['foo', '**styled**', 'a \\| b', '`a | b`', 'a `unmatched', '[a](https://x.test)'])(
    'pads a pipe-free body row %j without ending its table',
    (row) => {
      for (const container of containers) {
        const source = sourceIn(['| A | B |', '| --- | --- |', row, 'next', '', 'END'], container);
        const table = parseMarkdown(source).find((block) => block.kind === 'table');
        expect(table?.rows).toEqual([
          ['A', 'B'],
          [row, ''],
          ['next', ''],
        ]);
        check(source);
      }
    },
  );

  it.each([0, 1, 2, 3, 4, 5])(
    'indexes backtick escape parity after %i source slashes',
    (slashes) => {
      const row = '| a `foo | bar ' + '\\'.repeat(slashes) + '` |';
      const expected =
        slashes % 2
          ? ['a `foo', 'bar ' + '\\'.repeat(slashes) + '`']
          : ['a `foo | bar ' + '\\'.repeat(slashes) + '`'];
      const under = expected.map(() => '---').join(' | ');
      for (const container of containers) {
        const headerSource = sourceIn([row, '| ' + under + ' |', '', 'END'], container);
        expect(
          parseMarkdown(headerSource).find((block) => block.kind === 'table')?.rows?.[0],
        ).toEqual(expected);
        check(headerSource);
        const bodySource = sourceIn(['| A | B |', '| --- | --- |', row, '', 'END'], container);
        expect(
          parseMarkdown(bodySource).find((block) => block.kind === 'table')?.rows?.[1],
        ).toEqual(expected.length === 1 ? [...expected, ''] : expected);
        check(bodySource);
      }
    },
  );

  it.each([1, 2, 3])('pairs the remaining run after an escaped tick in a %i-tick run', (length) => {
    const run = '`'.repeat(length);
    const header = '| a ' + '`'.repeat(Math.max(1, length - 1)) + 'foo | bar \\' + run + ' |';
    const columns = length === 1 ? 2 : 1;
    const source =
      header + '\n| ' + Array.from({ length: columns }, () => '---').join(' | ') + ' |\n\nEND';
    expect(parseMarkdown(source).find((block) => block.kind === 'table')?.rows?.[0]).toHaveLength(
      columns,
    );
    check(source);
  });

  it.each(['# next', '- next', '> next', '```\nbody\n```'])(
    'ends pipe-free rows only at a block boundary %j',
    (end) => {
      const source = '| A | B |\n| --- | --- |\nfoo\n' + end + '\n\nEND';
      expect(parseMarkdown(source)[0]?.rows).toEqual([
        ['A', 'B'],
        ['foo', ''],
      ]);
      check(source);
    },
  );

  it.each([128, 129])('applies the existing body row cap to %i pipe-free rows', (count) => {
    const source =
      '| A | B |\n| --- | --- |\n' +
      Array.from({ length: count }, () => 'foo').join('\n') +
      '\n\nEND';
    const first = parseMarkdown(source)[0];
    expect(first?.kind).toBe(count > 128 ? 'literal' : 'table');
    expect(first?.source).toContain('foo\nfoo');
    check(source);
  });
});
