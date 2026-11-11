import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { HeadingContent, parseHeading, parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const contexts = [
  { name: 'list', first: '- ', next: '  ' },
  { name: 'ordinal', first: '12. ', next: '    ' },
  { name: 'quoted-list', first: '> - ', next: '>   ' },
  { name: 'nested-list', first: '- - ', next: '    ' },
];
const literals = ['<div>x</div>', '<br>', '<pre/>', '[ref]: https://example.test'];

function wrap(first: string, rest: string, context: (typeof contexts)[number]): string {
  return (
    context.first +
    first +
    '\n' +
    rest
      .split('\n')
      .map((line) => context.next + line)
      .join('\n')
  );
}

function assertLive(stream: MarkdownStream, source: string): void {
  const parsed = parseMarkdown(source);
  for (const width of [8, 31, 80])
    expect(stream.tail(width, 100), JSON.stringify({ source, width })).toEqual(
      layoutMarkdown(parsed, width).slice(-100),
    );
  expect(stream.sourceTail()).toBe(source);
}

describe('canonical detached owner projection', () => {
  it.each([
    [' x ### ', 'x'],
    ['###', '###'],
    ['x ### y', 'x ### y'],
    ['x ### ##', 'x ###'],
    ['\\###', '\\###'],
    ['x \t### ', 'x \t###'],
    ['x ###\t', 'x ###\t'],
    ['   ### ', '###'],
    ['   ', ''],
  ])('shares exact heading suffix semantics for %j', (source, expected) => {
    for (const chunk of [source.length || 1, 1, 3]) {
      const content = new HeadingContent();
      for (let at = 0; at < source.length; at += chunk)
        content.append(source.slice(at, at + chunk));
      expect(source.slice(content.start, content.end)).toBe(expected);
      expect(content.work).toBe(source.length);
    }
    expect(parseHeading('# ' + source)?.text).toBe(expected);
  });

  it.each(
    contexts.flatMap((context) =>
      [false, true].map((preceded) => ({ context, container: context.name, preceded })),
    ),
  )(
    'retains heading suffix ownership across the cut in $container, preceded=$preceded',
    ({ context, preceded }) => {
      let source = wrap('<div>x</div>', '# ' + (preceded ? 'x ' : '') + '#'.repeat(5000), context);
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += 17) {
        stream.append(source.slice(at, at + 17));
        if (at % 119 === 0) stream.tail(31, 8);
      }
      const body = stream
        .tail(100_000, 8)
        .at(-1)
        ?.spans.filter((span) => !span.dim)
        .map((span) => span.text)
        .join('');
      expect(body).toBe(preceded ? '' : '#'.repeat(4000));
      // A TAB revokes closing-hash syntax. The omitted run becomes ordinary
      // heading content again, without replaying its accumulated prefix.
      stream.append('\t');
      source += '\t';
      const rows = stream.tail(100_000, 8);
      expect(rows.at(-1)?.text).toContain('#'.repeat(3900));
      expect(rows.at(-1)?.spans.some((span) => span.heading === 1 && span.strong)).toBe(true);
      expect(stream.sourceTail()).toBe(source.slice(-4000));
      expect(stream.work.lexical).toBeLessThan(source.length * 5);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    },
  );
  it.each([
    '# hi ###',
    '> # hi ###',
    '---',
    '> ---',
    '*next*',
    '> *next*',
    '- child\n  text',
    '| h | b |\n| --- | --- |\nplain\n\nEND',
    '```js\na\t**raw**\n```',
    '> ```js\n> a\t**raw**\n> ```',
    '<pre>\n**raw**\n</pre>',
    'Title\n===',
  ])('preserves each later block owner after a contained literal: %j', (following) => {
    for (const context of contexts)
      for (const first of literals) {
        const source = wrap(first, following, context);
        for (const [chunk, draw] of [
          [source.length, false],
          [1, false],
          [1, true],
          [3, true],
        ] as const) {
          const stream = new MarkdownStream();
          for (let at = 0; at < source.length; at += chunk) {
            stream.append(source.slice(at, at + chunk));
            if (draw) {
              const rows = stream.tail(80, 100);
              stream.tail(19, 100);
              expect(stream.tail(80, 100)).toEqual(rows);
            }
          }
          assertLive(stream, source);
          const addition = '\n' + context.next + 'next\n' + context.next + 'END';
          stream.append(addition);
          assertLive(stream, source + addition);
          expect(stream.finish()).toEqual(parseMarkdown(source + addition));
        }
      }
  });

  it.each(
    [200, 4500].flatMap((length) => ['', ' ###', '###'].map((closing) => ({ length, closing }))),
  )(
    'keeps complete heading semantics at $length units with closing $closing',
    ({ length, closing }) => {
      for (const context of contexts)
        for (const quote of ['', '> ']) {
          const source = wrap('<div>x</div>', quote + '# ' + 'x'.repeat(length) + closing, context);
          for (const chunk of [source.length, 17]) {
            const stream = new MarkdownStream();
            for (let at = 0; at < source.length; at += chunk) {
              stream.append(source.slice(at, at + chunk));
              if (at % 119 === 0) stream.tail(31, 8);
            }
            const rows = stream.tail(100_000, 8);
            const body =
              rows
                .at(-1)
                ?.spans.filter((span) => !span.dim)
                .map((span) => span.text)
                .join('') ?? '';
            const expected = 'x'.repeat(length) + (closing === ' ###' ? '' : closing);
            expect(expected.endsWith(body)).toBe(true);
            expect(body).not.toBe('');
            expect(body.endsWith('###')).toBe(closing === '###');
            expect(rows.at(-1)?.spans.some((span) => span.heading === 1 && span.strong)).toBe(true);
            if (source.length <= 4000) assertLive(stream, source);
            expect(stream.sourceTail()).toBe(source.slice(-4000));
            expect(stream.finish()).toEqual(parseMarkdown(source));
          }
        }
    },
  );

  it.each(
    contexts.flatMap((context) =>
      [3, 300].map((length) => ({ context, container: context.name, length })),
    ),
  )(
    'keeps reversible quoted fence closure in $container with $length markers',
    ({ context, length }) => {
      const marker = '`'.repeat(length);
      for (const bodyLength of [20, 4500]) {
        const source = wrap(
          '<div>x</div>',
          '> ' + marker + '\n> ' + 'x'.repeat(bodyLength) + '\n> ' + marker,
          context,
        );
        for (const chunk of [source.length, bodyLength === 20 ? 1 : 17]) {
          const stream = new MarkdownStream();
          for (let at = 0; at < source.length; at += chunk) {
            stream.append(source.slice(at, at + chunk));
            if (bodyLength === 20 || at % 119 === 0) stream.tail(80, 20);
          }
          let current = source;
          for (const suffix of [
            '\t',
            '\u2003',
            '\n' + context.next + '> **literal**',
            '\n' + context.next + '> ' + marker,
            '\n' + context.next + '*outside*',
          ]) {
            stream.append(suffix);
            current += suffix;
            const before = stream.tail(80, 20);
            stream.tail(31, 20);
            expect(stream.tail(80, 20)).toEqual(before);
            if (current.length <= 4000) assertLive(stream, current);
            const visible = stream.tail(100_000, 100);
            expect(visible.flatMap((row) => row.spans).some((span) => span.strong)).toBe(false);
            expect(stream.sourceTail()).toBe(current.slice(-4000));
          }
          expect(stream.work.lexical).toBeLessThan(current.length * 5);
          expect(stream.finish()).toEqual(parseMarkdown(current));
        }
      }
    },
  );
});
