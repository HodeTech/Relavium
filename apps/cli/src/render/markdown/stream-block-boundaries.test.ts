import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown, BlockLineClassifier } from './parser.js';
import { MarkdownStream } from './stream.js';

const reviewed = [
  'a | b | c\n--- | ---\n*em*\n\nEND',
  '- a\nfoo\n---\n\nEND',
  '- a\n  ```\n```x\nfoo\n\nEND',
  '*em*\nx\ty\n    - c\n  ```\nEND',
  '- a\n  - b\n    ```\n\nEND',
];

function streamed(source: string, chunk: number, draw: boolean): MarkdownStream {
  const stream = new MarkdownStream();
  for (let at = 0; at < source.length; at += chunk) {
    stream.append(source.slice(at, at + chunk));
    if (draw) {
      const rows = stream.tail(80, 100);
      stream.tail(27, 100);
      expect(stream.tail(80, 100)).toEqual(rows);
    }
  }
  return stream;
}

describe('canonical block boundary ownership', () => {
  it.each(['# heading', '> q', '- nested\n    # heading'])(
    'ends a child table at a canonical scope boundary after %j',
    (before) => {
      for (const prefix of ['', '> '])
        for (const after of [
          'out | text',
          '# out | text',
          '> out | text',
          '- out | text',
          '```\nout | text',
        ]) {
          const lines = [
            '- a',
            ...before.split('\n').map((line) => '  ' + line),
            '  h | b',
            '  --- | ---',
            '  x | y',
            after,
            '',
            'END',
          ];
          const source = lines.map((line) => prefix + line).join('\n');
          for (const chunk of [source.length, 1, 3]) {
            const stream = streamed(source, chunk, true);
            expect(stream.tail(80, 100), JSON.stringify({ source, chunk })).toEqual(
              layoutMarkdown(parseMarkdown(source), 80),
            );
            expect(stream.sourceTail()).toBe(source);
            expect(stream.finish()).toEqual(parseMarkdown(source));
          }
        }
    },
  );

  it.each(['# ', '- item ', '> ', '```\n'])(
    'keeps an unterminated following block beyond the source budget after %j',
    (following) => {
      const source =
        '- a\n  # heading\n  h | b\n  --- | ---\n  x | y\n' +
        following +
        'x'.repeat(4500) +
        '\tEND';
      const expected = layoutMarkdown(parseMarkdown(source), 100_000);
      for (const chunk of [source.length, 17]) {
        const stream = streamed(source, chunk, true);
        // The source budget intentionally removes part of the logical line;
        // compare the retained suffix at one row, independently of rewrapping.
        const rows = stream.tail(100_000, 8);
        const final = rows.at(-1);
        const canonical = expected.at(-1);
        const content = final?.spans
          .filter((span) => !span.dim)
          .map((span) => span.text)
          .join('');
        expect(canonical?.text.endsWith(content ?? '')).toBe(true);
        expect(final?.spans.some((span) => span.heading)).toBe(following === '# ');
        expect(final?.spans.some((span) => span.code)).toBe(following === '```\n');
        expect(final?.text).toContain('END');
        expect(final?.text).toMatch(/ +END$/);
        expect(final?.text.match(/ +END$/)?.[0]).toBe(canonical?.text.match(/ +END$/)?.[0]);
        expect(stream.sourceTail()).toBe(source.slice(-4000));
        expect(stream.finish()).toEqual(parseMarkdown(source));
      }
    },
  );

  it.each([
    ['---', ' | ---'],
    ['```', 'a` | b'],
    ['- ', '\tx | y'],
    ['ordinary', ' | text'],
  ])('keeps a provisional table row reversible from %j', (begin, rest) => {
    const stream = new MarkdownStream();
    let source = 'h | b\n--- | ---\n' + begin;
    stream.append(source);
    stream.tail(80, 100);
    stream.append(rest + '\n\nEND');
    source += rest + '\n\nEND';
    expect(stream.tail(80, 100)).toEqual(layoutMarkdown(parseMarkdown(source), 80));
    expect(stream.finish()).toEqual(parseMarkdown(source));
  });
  it.each(['- a\n  ', '> ', '> - ', '- ```\n  '])(
    'applies raw pair lookahead before container interpretation after %j',
    (prefix) => {
      for (const [header, under] of [
        ['h | b', '--- | ---'],
        ['foo', '---'],
        ['**em**\tx', '==='],
      ] as const) {
        const source = prefix + header + '\n' + under + '\n*next*\n\nEND';
        for (const chunk of [1, 3, source.length]) {
          const stream = streamed(source, chunk, true);
          expect(stream.tail(80, 100), JSON.stringify({ source, chunk })).toEqual(
            layoutMarkdown(parseMarkdown(source), 80),
          );
          expect(stream.finish()).toEqual(parseMarkdown(source));
        }
      }
    },
  );

  it.each(reviewed)('retains source, styles, rows and columns for %j', (source) => {
    const expected = layoutMarkdown(parseMarkdown(source), 80);
    for (const [chunk, draw] of [
      [source.length, false],
      [1, false],
      [1, true],
      [3, true],
    ] as const) {
      const stream = streamed(source, chunk, draw);
      expect(stream.tail(80, 100)).toEqual(expected);
      expect(stream.sourceTail()).toBe(source);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it.each([
    '*em*\nx\ty',
    'a | b | c\n--- | ---',
    '- a\nfoo',
    '- a\n  - b',
    '- a\n  ```',
    '> - a\n>   ```',
  ])('composes later blocks after %j', (begin) => {
    for (const separation of ['\n', '\n\n'])
      for (const middle of ['---', '# h', '```x', '~~~x', '    ```', '*em*', 'x\ty', '- c'])
        for (const ending of ['\n\nEND', '\nfoo\n\nEND']) {
          const source = begin + separation + middle + ending;
          const expected = layoutMarkdown(parseMarkdown(source), 80);
          for (const [chunk, draw] of [
            [source.length, false],
            [1, false],
            [3, true],
          ] as const) {
            const stream = streamed(source, chunk, draw);
            expect(stream.tail(80, 100), JSON.stringify({ source, chunk, draw })).toEqual(expected);
            expect(stream.finish()).toEqual(parseMarkdown(source));
          }
        }
  });

  it.each([2, 33])(
    'recognizes exact table columns before applying the %i-column fallback',
    (columns) => {
      const header = Array.from({ length: columns }, () => 'h').join(' | ');
      for (const delimiters of [2, 3, 33, 34]) {
        const source =
          header +
          '\n' +
          Array.from({ length: delimiters }, () => '---').join(' | ') +
          '\n*em*\n\nEND';
        const classifier = new BlockLineClassifier();
        classifier.commit(header);
        expect(classifier.commit(source.split('\n')[1] ?? '').tableBoundary === true).toBe(
          columns === delimiters,
        );
        for (const chunk of [1, 17, source.length]) {
          const stream = streamed(source, chunk, true);
          expect(stream.tail(100_000, 100)).toEqual(layoutMarkdown(parseMarkdown(source), 100_000));
          expect(stream.finish()).toEqual(parseMarkdown(source));
        }
      }
    },
  );

  it.each([2, 3])(
    'retains the source-size table fallback only for an exact %i-column pair',
    (columns) => {
      const header = 'x'.repeat(65_536) + ' | b';
      const under = Array.from({ length: columns }, () => '---').join(' | ');
      const source = header + '\n' + under + '\n*em*\n\nEND';
      const classifier = new BlockLineClassifier();
      classifier.commit(header);
      expect(classifier.commit(under).tableBoundary === true).toBe(columns === 2);
      const expected = layoutMarkdown(parseMarkdown(source), 100_000)
        .map((line) => line.text)
        .join('\n');
      for (const chunk of [1024, source.length]) {
        const stream = streamed(source, chunk, false);
        const actual = stream
          .tail(100_000, 100)
          .map((line) => line.text)
          .join('\n');
        expect(expected.endsWith(actual)).toBe(true);
        expect(stream.sourceTail()).toBe(source.slice(-4000));
        expect(stream.work.lexical).toBeLessThan(source.length * 4);
        expect(stream.finish()).toEqual(parseMarkdown(source));
      }
    },
  );

  it.each(['- a\n  - b\n    ', '1. a\n   - b\n     ', '> - a\n>   - b\n>     '])(
    'keeps a continuation-fence blank owned at every enclosing gather level after %j',
    (begin) => {
      for (const marker of ['```', '~~~'])
        for (const blank of ['', ' ', '    ', '\t', '\t ']) {
          const source =
            begin + marker + '\n' + (begin.startsWith('>') ? '> ' : '') + blank + '\nEND';
          for (const chunk of [1, 3, source.length]) {
            const stream = streamed(source, chunk, true);
            expect(stream.tail(80, 100)).toEqual(layoutMarkdown(parseMarkdown(source), 80));
            expect(stream.sourceTail()).toBe(source);
            expect(stream.finish()).toEqual(parseMarkdown(source));
          }
        }
    },
  );
});
