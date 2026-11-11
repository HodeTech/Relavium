import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { HtmlTagLine, parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const contexts = [
  { name: 'root', first: '', next: '' },
  { name: 'quote', first: '> ', next: '> ' },
  { name: 'list', first: '- ', next: '  ' },
  { name: 'quoted-list', first: '> - ', next: '>   ' },
];

function wrap(lines: readonly string[], context: (typeof contexts)[number]): string {
  return lines.map((line, at) => (at ? context.next : context.first) + line).join('\n');
}

function check(source: string): void {
  const expected = parseMarkdown(source);
  expect(expected.map((block) => block.source).join('\n')).toBe(source);
  for (const chunk of [source.length, 1, 3]) {
    const stream = new MarkdownStream();
    for (let at = 0; at < source.length; at += chunk) {
      stream.append(source.slice(at, at + chunk));
      const rows = stream.tail(80, 100);
      stream.tail(29, 100);
      expect(stream.tail(80, 100)).toEqual(rows);
    }
    expect(stream.tail(80, 100), JSON.stringify({ source, chunk })).toEqual(
      layoutMarkdown(expected, 80),
    );
    expect(stream.sourceTail()).toBe(source);
    expect(stream.finish()).toEqual(expected);
  }
}

describe('literal HTML region ownership', () => {
  it.each([
    ['<!-- **text** -->', '**outside**'],
    ['<!--', '**text**', '', '# literal', '-->', '**outside**'],
    ['<!--', '```', '<pre>', '--> **also literal**', '**outside**'],
    ['<!--', '**unclosed**', '', 'END'],
    ['<!DOCTYPE html PUBLIC "**literal**">', '**outside**'],
  ])('keeps comments and declaration source literal: %j', (...lines) => {
    for (const context of contexts) {
      const source = wrap(lines, context);
      const rows = layoutMarkdown(parseMarkdown(source), 80);
      const strong = rows.flatMap((row) => row.spans).filter((span) => span.strong);
      expect(strong.every((span) => span.text === 'outside')).toBe(true);
      expect(rows.some((row) => row.text.includes('**'))).toBe(true);
      check(source);
    }
  });

  it('shares exact tag-prefix escape-free recognition for whole and split input', () => {
    for (const source of [
      '<pre>',
      '</pre>',
      '<pre/>',
      '<pre x="a>b">',
      '<!--',
      '<!DOCTYPE html>',
      '<pre> trailing',
      '<a-b c>',
      '<p',
      '<p/x>',
      '    <pre>',
      '<a@b.test>',
    ]) {
      const whole = new HtmlTagLine();
      whole.append(source);
      const split = new HtmlTagLine();
      for (const unit of source) split.append(unit);
      expect(split.literal).toBe(whole.literal);
      expect(split.work).toBe(whole.work);
      expect(split.work).toBeLessThanOrEqual(source.length);
    }
  });

  it.each(
    [
      { label: 'attributes', opening: '<pre ' },
      { label: 'long name', opening: '<' + 'n'.repeat(5000) + ' ' },
      { label: 'comment', opening: '<!--' },
      { label: 'doctype', opening: '<!DOCTYPE html ' },
    ].flatMap((form) => contexts.map((context) => ({ ...form, context, container: context.name }))),
  )('retains a $label line completed beyond the prefix in $container', ({ opening, context }) => {
    const source = wrap(
      [opening + 'x'.repeat(5000) + ' **literal**' + (opening === '<!--' ? '-->' : '>')],
      context,
    );
    for (const chunk of [source.length, 17]) {
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += chunk) {
        stream.append(source.slice(at, at + chunk));
        stream.tail(80, 8);
      }
      expect(
        stream
          .tail(80, 8)
          .flatMap((row) => row.spans)
          .some((span) => span.strong),
      ).toBe(false);
      expect(stream.sourceTail()).toBe(source.slice(-4000));
      expect(stream.columnWork.context).toBeLessThan(source.length * 40);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it.each(['pre', 'DIV', 'custom-element'])(
    'keeps paired %s source raw across Markdown-looking content',
    (name) => {
      for (const context of contexts) {
        const source = wrap(
          [
            '<' + name + ' data-x="value">',
            '**literal**',
            '# raw',
            '',
            '```',
            'h | b',
            '--- | ---',
            '</' + name.toLowerCase() + '>',
            '*outside*',
          ],
          context,
        );
        const rows = layoutMarkdown(parseMarkdown(source), 80);
        expect(rows.flatMap((row) => row.spans).filter((span) => span.strong)).toEqual([]);
        expect(rows.some((row) => row.text.includes('**literal**'))).toBe(true);
        expect(
          rows.flatMap((row) => row.spans).some((span) => span.emphasis && span.text === 'outside'),
        ).toBe(true);
        check(source);
      }
    },
  );

  it.each(['pre', 'div'])(
    'counts same-name nested %s tags without interpreting other tags',
    (name) => {
      for (const context of contexts) {
        const source = wrap(
          [
            '<' + name + '>',
            '<' + name.toUpperCase() + '>',
            '**inner**',
            '</' + name + '>',
            '**outer**',
            '<other>',
            '</other>',
            '</' + name + '>',
            '*outside*',
          ],
          context,
        );
        expect(parseMarkdown(source)[0]?.text).toContain('**outer**');
        expect(
          layoutMarkdown(parseMarkdown(source), 80)
            .flatMap((row) => row.spans)
            .some((span) => span.strong),
        ).toBe(false);
        check(source);
      }
    },
  );

  it.each(['pre', 'div'])(
    'keeps an unclosed %s region raw through EOF, including blanks',
    (name) => {
      for (const context of contexts) {
        const source = wrap(
          [
            '<' + name + '>',
            '**literal**',
            '',
            '# raw',
            '<' + name + '>',
            '</' + name + '>',
            '**still literal**',
          ],
          context,
        );
        const rows = layoutMarkdown(parseMarkdown(source), 80);
        expect(
          rows
            .flatMap((row) => row.spans)
            .some((span) => span.strong || span.emphasis || span.heading || span.code),
        ).toBe(false);
        check(source);
        check(source + '\n');
        check(source + '\n' + context.next);
      }
    },
  );

  it.each([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'source',
    'track',
    'wbr',
  ])('keeps void element %s on one literal line', (name) => {
    for (const context of contexts) {
      const source = wrap(['<' + name.toUpperCase() + '>', '**outside**'], context);
      expect(
        layoutMarkdown(parseMarkdown(source), 80)
          .flatMap((row) => row.spans)
          .some((span) => span.strong && span.text === 'outside'),
      ).toBe(true);
      check(source);
    }
  });

  it.each([
    '<pre/>',
    '<pre />',
    '<pre> trailing',
    '<pre>\u2028',
    '<pre>\u2029',
    '</pre>',
    '<pre><div>',
    '<pre data-x="a>b">',
  ])('does not open a raw region for ambiguous or one-line form %j', (opening) => {
    for (const context of contexts) {
      const source = wrap([opening, '**outside**'], context);
      expect(
        layoutMarkdown(parseMarkdown(source), 80)
          .flatMap((row) => row.spans)
          .some((span) => span.strong && span.text === 'outside'),
      ).toBe(true);
      check(source);
    }
  });

  it.each([
    '> <pre>\n> **literal**\n**outside**',
    '- <pre>\n  **literal**\n# outside',
    '> - <pre>\n>   **literal**\n# outside',
  ])('ends a raw region at an enclosing container boundary: %j', (source) => check(source));

  it.each([2000, 4000])(
    'keeps raw state incremental beyond a %i-unit tag name and source cut',
    (length) => {
      const name = 'a'.repeat(length);
      const source =
        '<' +
        name +
        '>\n' +
        Array.from({ length: 150 }, () => '**raw**\tvalue\n').join('') +
        '</' +
        name +
        '>\n\nEND';
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += 17) {
        stream.append(source.slice(at, at + 17));
        if (at % 119 === 0) stream.tail(80, 8);
      }
      expect(stream.sourceTail()).toBe(source.slice(-4000));
      expect(
        stream
          .tail(80, 8)
          .flatMap((row) => row.spans)
          .some((span) => span.strong),
      ).toBe(false);
      expect(stream.work.lexical).toBeLessThan(source.length * 5);
      expect(stream.columnWork.context).toBeLessThan(source.length * 40);
      expect(stream.checkpointWork.indexed).toBeLessThan(source.length * 200);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    },
  );
});
