import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const prefixes = ['- ', ' - ', '  - ', '1. ', '> ', '> - ', '- > ', '- 1. '];

function feed(source: string, chunk: number, draw: boolean): MarkdownStream {
  const stream = new MarkdownStream();
  for (let at = 0; at < source.length; at += chunk) {
    stream.append(source.slice(at, at + chunk));
    if (draw) {
      const before = stream.tail(40, 100);
      stream.tail(17, 100);
      expect(stream.tail(40, 100)).toEqual(before);
    }
  }
  return stream;
}

describe('streaming block transitions', () => {
  it.each(
    [3, 300, 1000, 5000].flatMap((length) =>
      ['`', '~'].flatMap((character) =>
        ['', '> ', '- ', '- a\n  '].map((prefix) => ({ length, character, prefix })),
      ),
    ),
  )(
    'projects an EOF $length-unit $character closer after $prefix without stabilizing it',
    ({ length, character, prefix }) => {
      const marker = character.repeat(length);
      const indentation = prefix.startsWith('-') ? '  ' : prefix;
      const initial =
        prefix + marker + '\n' + indentation + 'x'.repeat(5000) + '\n' + indentation + marker;
      for (const chunk of [initial.length, 17, 1]) {
        const stream = new MarkdownStream();
        let source = initial;
        for (let at = 0; at < initial.length; at += chunk) {
          stream.append(initial.slice(at, at + chunk));
          if (chunk === 17 && at % (17 * 13) === 0) stream.tail(80, 20);
        }
        const hidden = (): void => {
          const lines = stream.tail(80, 20);
          expect(lines.some((line) => line.text.includes(character))).toBe(false);
          stream.tail(40, 20);
          expect(stream.tail(80, 20)).toEqual(lines);
          expect(stream.sourceTail()).toBe(source.slice(-4000));
        };
        hidden();
        stream.append('\t  ');
        source += '\t  ';
        hidden();
        // Non-whitespace revokes this same physical closer and must reveal it
        // as code again, including tabs whose column preceded the raw cut.
        stream.append('X');
        source += 'X';
        const actual = stream.tail(100_000, 20).at(-1)?.text;
        const expected = layoutMarkdown(parseMarkdown(source), 100_000).at(-1)?.text;
        expect(actual?.includes(character)).toBe(true);
        expect(actual?.slice(-40)).toBe(expected?.slice(-40));
        stream.append('\n\nEND');
        source += '\n\nEND';
        expect(stream.tail(80, 20).at(-1)).toEqual(
          layoutMarkdown(parseMarkdown(source), 80).at(-1),
        );
        expect(stream.finish()).toEqual(parseMarkdown(source));

        const closed = new MarkdownStream();
        closed.append(initial + '\t\n\nEND');
        const end = closed.tail(80, 20).at(-1);
        expect(end).toEqual(layoutMarkdown(parseMarkdown(initial + '\t\n\nEND'), 80).at(-1));
        expect(end?.spans.some((span) => span.code)).toBe(false);
      }
    },
  );

  it.each(prefixes)('stabilizes contained fences and later blocks after %j', (prefix) => {
    for (const marker of ['```', '~~~'])
      for (const blanks of ['\n', '\n\n']) {
        for (const following of ['*x*', '  - # hi', '`x`\nnext', '# next', '\tb\t']) {
          const source = prefix + marker + blanks + following + '\n\nout';
          const expected = layoutMarkdown(parseMarkdown(source), 40);
          for (const [chunk, draw] of [
            [source.length, false],
            [1, false],
            [1, true],
            [3, true],
          ] as const) {
            const stream = feed(source, chunk, draw);
            expect(stream.tail(40, 100), JSON.stringify({ source, chunk, draw })).toEqual(expected);
            expect(stream.sourceTail()).toBe(source);
            expect(stream.finish()).toEqual(parseMarkdown(source));
          }
        }
      }
  });

  it.each(['  - a\n    ', '  1. a\n\t', '- a\n  '])(
    'keeps continuation-fence blanks owned by the fence after %j',
    (prefix) => {
      for (const marker of ['```', '~~~']) {
        const source = prefix + marker + '\n\n# h\n\nEND';
        for (const chunk of [1, 3, source.length]) {
          const stream = feed(source, chunk, true);
          expect(stream.tail(40, 100)).toEqual(layoutMarkdown(parseMarkdown(source), 40));
          expect(stream.finish()).toEqual(parseMarkdown(source));
        }
      }
    },
  );

  it.each(['', '- ', '> ', '> - ', '1. '])(
    'revokes provisional backtick info and its tab projection after %j',
    (prefix) => {
      for (const size of [0, 300, 4000]) {
        const source = prefix + '```a\t' + 'x'.repeat(size) + '\tb`\ntext\n\nEND';
        const expected = layoutMarkdown(parseMarkdown(source), 100_000);
        for (const chunk of [1, 17, source.length])
          for (const draw of [false, true]) {
            const stream = feed(source, chunk, draw && size < 4000);
            const actual = stream.tail(100_000, 100);
            if (source.length <= 4000) expect(actual).toEqual(expected);
            const actualTab = actual
              .find((line) => line.text.includes('b`'))
              ?.text.match(/ +b`(?: text)?$/)?.[0];
            expect(actualTab).toBeDefined();
            expect(actualTab).toBe(
              expected.find((line) => line.text.includes('b`'))?.text.match(/ +b`(?: text)?$/)?.[0],
            );
            expect(actual.slice(-2)).toEqual(expected.slice(-2));
            // Includes fixed-depth position-index visits and one retraction of
            // old opener annotations; no accumulated info-prefix replay per token.
            expect(stream.columnWork.interpretation).toBeLessThan(source.length * 256 + 4096);
            expect(stream.finish()).toEqual(parseMarkdown(source));
          }
      }
    },
  );

  it.each(['```', '~~~'])('closes %s on TAB whitespace before a later paragraph', (marker) => {
    for (const prefix of ['', '- ', '> ']) {
      const indent = prefix === '- ' ? '  ' : prefix;
      const source = prefix + marker + '\n' + indent + 'a\n' + indent + marker + '\t\nb\n\nEND';
      for (const chunk of [1, 3, source.length]) {
        const stream = feed(source, chunk, true);
        expect(stream.tail(40, 100)).toEqual(layoutMarkdown(parseMarkdown(source), 40));
        expect(stream.finish()).toEqual(parseMarkdown(source));
      }
    }
  });

  it('retains literal code spans when a continuation fence opener leaves the source window', () => {
    const source = '  - a\n    ```\n    ' + '**literal**'.repeat(1000);
    const stream = feed(source, 17, false);
    const tail = stream.tail(80, 8);
    expect(tail.some((line) => line.text.includes('**literal**'))).toBe(true);
    expect(tail.flatMap((line) => line.spans).some((span) => span.code)).toBe(true);
    expect(tail.flatMap((line) => line.spans).some((span) => span.strong)).toBe(false);
    expect(stream.sourceTail()).toBe(source.slice(-4000));
    expect(stream.finish()).toEqual(parseMarkdown(source));
  });
});
