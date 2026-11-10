import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

const containers = [
  { name: 'root', first: '', next: '' },
  { name: 'quote', first: '> ', next: '> ' },
  { name: 'list', first: '- ', next: '  ' },
  { name: 'quoted list', first: '> - ', next: '>   ' },
];

function check(source: string): void {
  const blocks = parseMarkdown(source);
  expect(blocks.map((block) => block.source).join('\n')).toBe(source);
  for (const chunk of [source.length, 1, 3]) {
    const stream = new MarkdownStream();
    for (let at = 0; at < source.length; at += chunk) {
      stream.append(source.slice(at, at + chunk));
      const rows = stream.tail(80, 100);
      stream.tail(29, 100);
      expect(stream.tail(80, 100)).toEqual(rows);
    }
    expect(stream.tail(80, 100)).toEqual(layoutMarkdown(blocks, 80));
    expect(stream.sourceTail()).toBe(source);
    expect(stream.finish()).toEqual(blocks);
  }
}

describe('non-LF physical source units', () => {
  it.each(['\u2028', '\u2029'])('preserves separator %j in code and container captures', (unit) => {
    for (const container of containers)
      for (const marker of ['```', '~~~']) {
        const lines = [
          marker + 'la' + unit + 'ng',
          '**body**' + unit,
          marker + unit,
          '**literal**',
        ];
        const source = lines
          .map((line, at) => (at ? container.next : container.first) + line)
          .join('\n');
        const blocks = parseMarkdown(source);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.kind).toBe('code');
        expect(blocks[0]?.info).toBe('la' + unit + 'ng');
        expect(blocks[0]?.text).toBe(lines.slice(1).join('\n'));
        const rows = layoutMarkdown(blocks, 80);
        expect(rows.flatMap((row) => row.spans).every((span) => !span.strong)).toBe(true);
        check(source);
      }
  });

  it.each(['\u2028', '\u2029'])(
    'retains separator %j inside and after styled list/quote content',
    (unit) => {
      for (const container of containers)
        for (const content of ['a' + unit + '**b**', '**b**' + unit, unit + '**b**']) {
          const source = container.first + content;
          const blocks = parseMarkdown(source);
          expect(blocks[0]?.text).toBe(
            content.startsWith(unit) && container.first.includes('-') ? '- ' + content : content,
          );
          expect(
            layoutMarkdown(blocks, 80)
              .flatMap((row) => row.spans)
              .some((span) => span.strong),
          ).toBe(true);
          check(source);
        }
    },
  );

  it.each(['\u2028', '\u2029'])('does not hide an invalid fence-info backtick after %j', (unit) => {
    for (const container of containers) {
      const content = '```a' + unit + '` **visible**';
      const source = container.first + content;
      expect(parseMarkdown(source).every((block) => block.kind !== 'code')).toBe(true);
      check(source);
    }
  });
});
