import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { BlockLineClassifier, parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const regions = [
  { name: 'comment', open: '<!--', close: '-->' },
  { name: 'tag', open: '<div>', close: '</div>' },
  { name: 'indented tag closer', open: '<div>', close: '  </div>' },
];
const scopes = [
  { name: 'root', wrap: (lines: readonly string[]) => lines.join('\n') },
  {
    name: 'quote',
    wrap: (lines: readonly string[]) => lines.map((line) => '> ' + line).join('\n'),
  },
  {
    name: 'list',
    wrap: (lines: readonly string[]) =>
      ['- # owner', ...lines.map((line) => '  ' + line)].join('\n'),
  },
  {
    name: 'quoted list',
    wrap: (lines: readonly string[]) =>
      ['> - # owner', ...lines.map((line) => '>   ' + line)].join('\n'),
  },
];

function assertLive(stream: MarkdownStream, source: string): void {
  const blocks = parseMarkdown(source);
  for (const width of [1, 2, 17, 40, 80])
    expect(stream.tail(width, 1000), JSON.stringify({ source, width })).toEqual(
      layoutMarkdown(blocks, width),
    );
  expect(stream.sourceTail()).toBe(source);
}

function verify(source: string): void {
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
        const rows = stream.tail(40, 1000);
        stream.tail(2, 1000);
        expect(stream.tail(40, 1000)).toEqual(rows);
      }
    }
    assertLive(stream, source);
    expect(stream.work.lexical).toBeLessThan(source.length * 5);
    expect(stream.finish()).toEqual(parseMarkdown(source));
  }
}

describe('HTML-owned raw grouping', () => {
  it.each(
    regions.flatMap((region) =>
      ['- > a', '- a', '1. **raw**', '> **raw**', '# raw', '```', 'h | b\n--- | ---'].map(
        (body) => ({ region, name: region.name, body }),
      ),
    ),
  )('keeps $body literal in $name before an actual fence', ({ region, body }) => {
    for (const { wrap } of scopes)
      for (const marker of ['```', '~~~']) {
        const lines = [region.open, ...body.split('\n'), region.close, '  ' + marker, 'x'];
        const source = wrap(lines);
        const regionBlock = parseMarkdown(source).find(
          (block) => block.kind === 'literal' && block.source.includes(region.open),
        );
        // An additional quote marker can leave the opener's physical quote
        // gather. Assert HTML ownership only while that actual scope survives;
        // the full static/live oracle below also covers the container exit.
        const ownsCloser = regionBlock?.source.includes(region.close) === true;
        const classifier = new BlockLineClassifier();
        const htmlEnd = wrap(lines.slice(0, -2)).split('\n').length;
        const physical = source.split('\n');
        const htmlStart = physical.length - lines.length;
        for (const [index, line] of physical.entries()) {
          const classified = classifier.commit(line);
          if (ownsCloser && index >= htmlStart && index < htmlEnd) {
            expect(classified.htmlLine).toBe(true);
            expect(classified.block.kind).toBe('literal');
            expect(classified.fenceBoundary).toBeUndefined();
          }
        }
        verify(source);
        verify(wrap([...lines, '  ' + marker, '*after*', '', 'END']));
      }
  });

  it.each(regions)('does not carry an earlier root list through $name', (region) => {
    for (const body of ['- > a', '- a'])
      for (const marker of ['```', '~~~']) {
        const lines = ['- prior', region.open, body, region.close, '  ' + marker, 'x'];
        verify(lines.join('\n'));
        verify([...lines, '  ' + marker, '*after*', '', 'END'].join('\n'));
      }
  });

  it.each(regions)('preserves raw EOF and later termination in $name', (region) => {
    for (const { wrap } of scopes) {
      const lines = [region.open, '- > **raw**', '', '  ```', '# raw'];
      const stream = new MarkdownStream();
      let source = wrap(lines);
      for (const unit of source) {
        stream.append(unit);
        stream.tail(40, 1000);
      }
      assertLive(stream, source);
      const continuation = wrap([...lines, region.close, '  ~~~', '**code**', '  ~~~']);
      stream.append(continuation.slice(source.length));
      source = continuation;
      assertLive(stream, source);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it.each(['<!-- h | b', '<div data-x="a|b">', '<br> | b'])(
    'preserves first raw parent table precedence for an HTML-containing header %j',
    (header) => {
      for (const scope of scopes)
        for (const prefix of ['> ', '- ']) {
          const source = scope.wrap([prefix + header, '--- | ---', 'body', '', 'END']);
          if (scope.name !== 'quote')
            expect(parseMarkdown(source).filter((block) => block.kind === 'table')).toHaveLength(1);
          verify(source);
        }
    },
  );

  it.each(
    scopes.flatMap((scope) =>
      [80, 160, 320, 640].flatMap((count) =>
        [false, true].map((prior) => ({ ...scope, count, prior })),
      ),
    ),
  )(
    'bounds $count repeated raw markers across source cuts in $name (prior list: $prior)',
    ({ wrap, count, prior }) => {
      const previous = prior ? ['- prior'] : [];
      const stream = new MarkdownStream();
      const source = wrap([
        ...previous,
        '<!--',
        ...Array.from({ length: count }, () => '- > **raw**'),
        '-->',
        '  ```',
        'x',
      ]);
      for (let at = 0; at < source.length; at += 17) {
        stream.append(source.slice(at, at + 17));
        if (at % 119 === 0) stream.tail(40, 8);
      }
      const work = stream.checkpointWork;
      expect(stream.work.lexical).toBeLessThan(source.length * 5);
      expect(work.indexed).toBeLessThan(source.length * 128);
      expect(work.decisions).toBeLessThan(source.length * 4);
      expect(work.retained).toBeLessThan(source.length * 3);
      expect(work.scopeRetained).toBeLessThan(source.length * 6);
      expect(stream.sourceTail()).toBe(source.slice(-4000));
      expect(stream.tail(40, 8)).toEqual(layoutMarkdown(parseMarkdown(source), 40).slice(-8));
      expect(stream.finish()).toEqual(parseMarkdown(source));
      expect(stream.checkpointWork.scopeRetained).toBe(0);
    },
  );
});
