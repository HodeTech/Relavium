import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { BlockLineClassifier, parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const scopes = [
  { name: 'root', wrap: (lines: readonly string[]) => lines.join('\n') },
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

function parity(source: string): void {
  const parsed = parseMarkdown(source);
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
        const before = stream.tail(37, 100);
        stream.tail(13, 100);
        expect(stream.tail(37, 100)).toEqual(before);
      }
    }
    for (const width of [11, 37, 80])
      expect(stream.tail(width, 100), JSON.stringify({ source, chunk, draw, width })).toEqual(
        layoutMarkdown(parsed, width),
      );
    expect(stream.sourceTail()).toBe(source);
    expect(stream.work.lexical).toBeLessThan(source.length * 5);
    expect(stream.finish()).toEqual(parsed);
  }
}

const predecessors = [
  ['first **styled**'],
  ['# heading'],
  ['---'],
  ['```', '**raw**', '```'],
  ['~~~', '**raw**', '~~~'],
  ['<br>'],
  ['<div>', '**raw**', '</div>'],
  ['<!--', '**raw**', '-->'],
  ['- item'],
  ['- ```', '  **raw**', '  ```'],
];

describe('physical container lookahead ownership', () => {
  it.each(predecessors)('keeps a later quote line owned after %j', (...before) => {
    for (const { wrap } of scopes)
      for (const depth of [1, 2]) {
        const quote = '> '.repeat(depth);
        const lines = [...before, 'h | b'].map((line) => quote + line);
        const source = wrap([...lines, '--- | ---', 'x | y', '', 'END']);
        expect(parseMarkdown(source).some((block) => block.kind === 'table')).toBe(false);
        const classifier = new BlockLineClassifier();
        const physical = wrap(lines).split('\n');
        for (const line of physical) classifier.commit(line);
        const delimiter = wrap(['--- | ---']).split('\n').at(-1) ?? '';
        expect(classifier.preview(delimiter).revision).toBeUndefined();
        expect(classifier.commit(delimiter).tableBoundary).toBeUndefined();
        parity(source);
      }
  });

  it.each([
    'h | b',
    '# h | b',
    '--- | ---',
    '``` | b',
    '~~~ | b',
    '<div data-x="a|b">',
    '<br> | b',
    '<!-- h | b',
    '- # h | b',
    '- ``` | b',
  ])('retains first raw parent precedence for %j', (header) => {
    for (const { wrap } of scopes)
      for (const prefix of ['> ', '- ']) {
        const source = wrap([prefix + header, '--- | ---', 'body', '', 'END']);
        expect(parseMarkdown(source).filter((block) => block.kind === 'table')).toHaveLength(1);
        parity(source);
      }
  });

  it.each(scopes)('retires adopted child headers before the next table in $name', ({ wrap }) => {
    for (const prefix of ['>   ', '-   ']) {
      const lines = [
        prefix + '--- | ---',
        '  --- | ---',
        prefix + '--- | ---',
        '  --- | ---',
        '**body**',
        '',
        'END',
      ];
      const source = wrap(lines);
      expect(parseMarkdown(source).filter((block) => block.kind === 'table')).toHaveLength(2);
      const classifier = new BlockLineClassifier();
      let boundaries = 0;
      for (const line of source.split('\n')) {
        const preview = classifier.preview(line);
        const result = classifier.commit(line);
        expect(result).toEqual(preview);
        if (result.tableBoundary) boundaries++;
      }
      expect(boundaries).toBe(2);
      parity(source);
    }
  });

  it('starts a new quote gather after depth changes and actual container exits', () => {
    for (const { wrap } of scopes)
      for (const before of ['> first', '> > first', '> - first']) {
        const source = wrap([before, '> > > h | b', '--- | ---', 'body', '', 'END']);
        expect(parseMarkdown(source).filter((block) => block.kind === 'table')).toHaveLength(1);
        parity(source);
      }
    for (const source of [
      '> first\n\n> h | b\n--- | ---\nbody\n\nEND',
      '- first\nx\n---\n> h | b\n--- | ---\nbody\n\nEND',
      '- first\nx\n===\n> h | b\n--- | ---\nbody\n\nEND',
    ])
      parity(source);
  });

  it.each(['> ', '- '])('keeps provisional raw fence headers reversible after %j', (prefix) => {
    for (const { wrap } of scopes)
      for (const marker of ['```', '~~~'])
        for (const suffix of ['', 'x', '\n*outside*', '\n> quoted', '\n- item']) {
          const stream = new MarkdownStream();
          let source = '';
          const open = wrap([prefix + marker + ' | b']) + '\n';
          const delimiter = wrap(['--- | ---']).split('\n').at(-1) ?? '';
          // This line has left the tentative fence, but its initial '-' can
          // still grow into a valid delimiter that adopts the raw header.
          for (const unit of open + delimiter) {
            source += unit;
            stream.append(unit);
            const rows = stream.tail(37, 100);
            stream.tail(13, 100);
            expect(stream.tail(37, 100)).toEqual(rows);
            expect(stream.sourceTail()).toBe(source);
          }
          const raw = stream.tail(37, 100);
          expect(raw.map((line) => line.text).join('\n')).toContain(marker);
          expect(raw.every((line) => line.spans.every((span) => !span.code))).toBe(true);
          if (suffix === 'x') {
            stream.append('x');
            source += 'x';
            // A valid delimiter at EOF was only a preview. Extra text revokes
            // it and restores the actual code/paragraph owners immediately.
            expect(stream.tail(37, 100)).toEqual(layoutMarkdown(parseMarkdown(source), 37));
          }
          const addition = (suffix === 'x' ? '' : suffix) + '\n\nEND';
          for (const unit of addition) {
            source += unit;
            stream.append(unit);
            stream.tail(37, 100);
          }
          expect(stream.tail(37, 100), JSON.stringify({ prefix, marker, suffix, source })).toEqual(
            layoutMarkdown(parseMarkdown(source), 37),
          );
          expect(stream.sourceTail()).toBe(source);
          expect(stream.finish()).toEqual(parseMarkdown(source));
        }
  });

  it('preserves nested candidate ownership after an ordinary list item', () => {
    for (const header of ['> ``` | b', '> ~~~ | b', '> <!-- h | b'])
      for (const source of [
        '- first\n  ' + header + '\n  --- | ---\nx\n\nEND',
        '> - first\n>   ' + header + '\n>   --- | ---\n> x\n\nEND',
        '- first\n  - second\n    ' + header + '\n    --- | ---\nx\n\nEND',
      ])
        parity(source);
  });

  it('keeps indexed work and live state bounded across repeated child adoption', () => {
    for (const count of [40, 80, 160]) {
      const stream = new MarkdownStream();
      let source = '';
      const table = '>   --- | ---\n  --- | ---\n';
      for (let index = 0; index < count; index++) {
        stream.append(table);
        source += table;
        if (index % 7 === 0) stream.tail(37, 8);
      }
      source += '\nEND';
      stream.append('\nEND');
      const work = stream.checkpointWork;
      expect(stream.work.lexical).toBeLessThan(source.length * 5);
      expect(work.indexed).toBeLessThan(source.length * 128);
      expect(work.decisions).toBeLessThan(source.length * 4);
      expect(work.retained).toBeLessThan(source.length * 3);
      expect(work.scopeRetained).toBeLessThan(source.length * 6);
      expect(stream.sourceTail()).toBe(source.slice(-4000));
      expect(stream.tail(37, 8)).toEqual(layoutMarkdown(parseMarkdown(source), 37).slice(-8));
      expect(stream.finish()).toEqual(parseMarkdown(source));
      expect(stream.checkpointWork.scopeRetained).toBe(0);
    }
  });
});
