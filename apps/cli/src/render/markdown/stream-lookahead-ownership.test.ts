import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { BlockLineClassifier, closesMarkdownFence, parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

function check(source: string, chunk: number, draw: boolean): void {
  const stream = new MarkdownStream();
  for (let at = 0; at < source.length; at += chunk) {
    stream.append(source.slice(at, at + chunk));
    if (draw) {
      const before = stream.tail(80, 100);
      stream.tail(27, 100);
      expect(stream.tail(80, 100)).toEqual(before);
    }
  }
  expect(stream.tail(80, 100), JSON.stringify({ source, chunk })).toEqual(
    layoutMarkdown(parseMarkdown(source), 80),
  );
  expect(stream.sourceTail()).toBe(source);
  expect(stream.finish()).toEqual(parseMarkdown(source));
}

const containers = [
  (lines: readonly string[]) => lines.join('\n'),
  (lines: readonly string[]) => lines.map((line) => '> ' + line).join('\n'),
  (lines: readonly string[]) => lines.map((line, at) => (at ? '  ' : '- ') + line).join('\n'),
  (lines: readonly string[]) => lines.map((line, at) => (at ? '>   ' : '> - ') + line).join('\n'),
];

describe('physical lookahead ownership', () => {
  it.each(['\n', '\r', '\u2028', '\u2029', '\v', '\f'])(
    'rejects every non-space/TAB unit in the shared closer suffix: %j',
    (suffix) => {
      for (const marker of ['```', '~~~']) {
        expect(closesMarkdownFence(marker + suffix, marker)).toBe(false);
        expect(closesMarkdownFence(marker + ' \t', marker)).toBe(true);
      }
    },
  );
  it.each(['\u00a0', '\u2003'])('keeps a fence open after non-ASCII suffix %j', (suffix) => {
    for (const marker of ['```', '~~~']) {
      expect(closesMarkdownFence(marker + suffix, marker)).toBe(false);
      for (const wrap of containers) {
        const source = wrap([marker, 'code', marker + suffix, '**literal**']);
        const blocks = parseMarkdown(source);
        expect(blocks.every((block) => block.kind === 'code')).toBe(true);
        for (const [chunk, draw] of [
          [source.length, false],
          [1, false],
          [1, true],
          [3, true],
        ] as const)
          check(source, chunk, draw);
      }
    }
  });

  it.each(['```', '~~~'])('revises a provisional %s closer without stabilizing it', (marker) => {
    for (const wrap of containers) {
      const stream = new MarkdownStream();
      for (const suffix of [
        '',
        ' ',
        '\t',
        '\u00a0',
        '\n**literal**',
        '\n' + marker,
        '\t',
        '\n*outside*',
      ]) {
        const next = wrap([marker, 'body', marker + suffix]);
        // Each branch starts from the same open fence; both valid and invalid
        // closers must follow canonical state before and after the newline.
        stream.reset();
        for (const character of next) {
          stream.append(character);
          stream.tail(80, 100);
        }
        expect(stream.tail(80, 100)).toEqual(layoutMarkdown(parseMarkdown(next), 80));
        expect(stream.finish()).toEqual(parseMarkdown(next));
      }
    }
  });

  it.each(
    (
      [
        [3, '`'],
        [3, '~'],
        [300, '`'],
        [300, '~'],
        [5000, '`'],
        [5000, '~'],
      ] as const
    ).flatMap(([length, marker]) =>
      containers.map((wrap, container) => ({ length, marker, wrap, container })),
    ),
  )(
    'keeps arbitrary cut fence marker $length $marker exact in container $container',
    ({ length, marker, wrap }) => {
      const run = marker.repeat(length);
      const stream = new MarkdownStream();
      let source = wrap([run, 'x'.repeat(4100), run]);
      for (let at = 0; at < source.length; at += 17) {
        stream.append(source.slice(at, at + 17));
        if (at % 119 === 0) stream.tail(80, 20);
      }
      for (const addition of [
        '\t',
        '\u2003',
        '\n' +
          (wrap === containers[1]
            ? '> '
            : wrap === containers[3]
              ? '>   '
              : wrap === containers[2]
                ? '  '
                : '') +
          '**literal**',
      ]) {
        stream.append(addition);
        source += addition;
        const rows = stream.tail(80, 20);
        stream.tail(31, 20);
        expect(stream.tail(80, 20)).toEqual(rows);
        expect(rows.every((row) => row.spans.every((span) => !span.strong))).toBe(true);
        expect(stream.sourceTail()).toBe(source.slice(-4000));
      }
      expect(stream.work.lexical).toBeLessThan(source.length * 5);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    },
  );

  it.each([
    ['foo', '===', '---'],
    ['foo', '===', '===', '---'],
    ['foo', '---', '===', '---'],
    ['foo', '===', 'next', '---'],
    ['- a', 'foo', '---'],
    ['- a', 'x', 'b', '---'],
    ['- a', 'x', 'b', '===', '---'],
    ['- a', 'x', '**b**', '--- | ---'],
  ])('keeps completed physical ownership across %j', (...lines) => {
    for (const wrap of containers) {
      const source = wrap([...lines, '', 'END']);
      for (const [chunk, draw] of [
        [source.length, false],
        [1, false],
        [1, true],
        [3, true],
      ] as const)
        check(source, chunk, draw);
    }
  });

  it('never reuses a consumed underline or an already-owned lazy line as Setext header', () => {
    for (const source of ['foo\n===\n---', '- a\nx\nb\n---'])
      expect(parseMarkdown(source).at(-1)?.kind).toBe('rule');
    const pair = new BlockLineClassifier();
    pair.commit('foo');
    expect(pair.commit('===').revision).toBeDefined();
    expect(pair.preview('---').revision).toBeUndefined();
    expect(pair.commit('---').block.kind).toBe('rule');
    const lazy = new BlockLineClassifier();
    lazy.commit('- a');
    lazy.commit('x');
    expect(lazy.preview('---').revision).toBeDefined();
    lazy.commit('b');
    expect(lazy.preview('---').revision).toBeUndefined();
    expect(lazy.commit('---').block.kind).toBe('rule');
    const unmatched = parseMarkdown('- a\nx\n**b**\n--- | ---\n\nEND');
    expect(unmatched.find((block) => block.source === '**b**')).toEqual({
      kind: 'literal',
      source: '**b**',
      text: '**b**',
      raw: true,
    });
  });

  it.each([
    '- - a\n  ' + 'h'.repeat(700) + '\n  ---\n\nEND',
    '12345. - a\n\tfoo\n\t---\n\nEND',
    '> 12345. - a\n> \tfoo\n> \t---\n\nEND',
    '12345. - a\n\tx\n\t**h** | **b**\n\t--- | ---\n\nEND',
  ])('projects complete revised container text, including residual TAB cells: %j', (source) => {
    for (const chunk of [source.length, 1, 17]) check(source, chunk, true);
  });

  it.each([2, 3, 33].flatMap((columns) => [1, 2, 3, 33, 34].map((count) => ({ columns, count }))))(
    'leaves lazy fallback only for a matching $columns-column header/$count-column delimiter',
    ({ columns, count }) => {
      const header = Array.from({ length: columns }, () => '**h**').join(' | ');
      const under = Array.from({ length: count }, () => '---').join(' | ');
      for (const wrap of containers) {
        const source = wrap(['- a', 'x', header, under, '', 'END']);
        const blocks = parseMarkdown(source);
        if (count !== columns) {
          const ownedHeader = blocks.find((block) => block.source.includes(header));
          expect(ownedHeader?.raw).toBe(true);
          expect(ownedHeader?.text).toContain('**h**');
        }
        for (const chunk of [source.length, 1, 17]) check(source, chunk, chunk !== source.length);
      }
    },
  );
});
