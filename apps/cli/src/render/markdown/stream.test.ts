import { describe, expect, it, vi } from 'vitest';
import { MarkdownStream } from './stream.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import * as parser from './parser.js';
import * as layout from './layout.js';

const rows = (stream: MarkdownStream, columns = 80, count = 12): string[] =>
  stream.tail(columns, count).map((line) => line.text);

function oneByteAtATime(source: string): MarkdownStream {
  const stream = new MarkdownStream();
  for (const character of source) stream.append(character);
  return stream;
}

describe('incremental markdown stream', () => {
  it('reports geometry elision independently of the source tail budget', () => {
    const stream = new MarkdownStream();
    stream.append('x'.repeat(2_000));
    expect(stream.elided).toBe(false);
    expect(stream.tail(80, 7)).toHaveLength(7);
    expect(stream.elided).toBe(true);
    stream.tail(80, 100);
    expect(stream.elided).toBe(false);
    stream.reset();
    expect(stream.elided).toBe(false);
  });

  it('keeps completed tables literal until a blank or unambiguous block closes them', () => {
    const stream = oneByteAtATime('| h |\n| --- |\n| x |');
    expect(rows(stream)).toEqual(['| h |', '| --- |', '| x |']);
    stream.append('\n\n');
    expect(rows(stream)[0]).toBe('┌───┐');
    stream.append('# next\n');
    expect(rows(stream)).toContain('next');
  });

  it('retains code-fence state before the visible source window', () => {
    const stream = oneByteAtATime('```ts\n' + 'x'.repeat(12_000));
    expect(stream.elided).toBe(true);
    const lines = stream.tail(40, 4);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.text.startsWith('│ '))).toBe(true);
    expect(lines.every((line) => line.spans.some((span) => span.code))).toBe(true);
    expect(stream.sourceTail()).toHaveLength(4_000);
    stream.append('\n```\n# next\n');
    expect(rows(stream)).toContain('next');
  });

  it('matches delimiters whose opener has left the visible tail', () => {
    for (const marker of ['**', '*', '__', '_', '~~', '`', '``']) {
      const stream = oneByteAtATime(marker + 'a '.repeat(5_000));
      stream.append(marker);
      const spans = stream.tail(60, 3).flatMap((line) => line.spans);
      const flag =
        marker[0] === '`'
          ? 'code'
          : marker === '~~'
            ? 'strike'
            : marker.length === 2
              ? 'strong'
              : 'emphasis';
      expect(spans.some((span) => span[flag])).toBe(true);
      expect(spans.map((span) => span.text).join('')).not.toContain(marker);
    }
  });

  it('retains a visible target when the link label has left the tail', () => {
    const stream = oneByteAtATime('[label](https://example.test/' + 'x'.repeat(9_000));
    stream.append(')');
    const lines = stream.tail(60, 2);
    expect(
      lines
        .flatMap((line) => line.spans)
        .some((span) => span.linkURL?.startsWith('https://example.test/')),
    ).toBe(true);
    expect(lines.map((line) => line.text).join('')).not.toContain(')');
  });

  it('retains container fences before the tail and deindents admitted body lines', () => {
    for (const [opening, body, closing, prefix] of [
      ['> ```ts\n', '> ' + 'x'.repeat(5_000), '\n> ```\n', '│ │ '],
      ['- ```ts\n', '  ' + 'x'.repeat(5_000), '\n  ```\n', '  │ '],
      ['  ```ts\n', '  x\n'.repeat(2_000), '  ```\n', '│ '],
    ]) {
      const stream = oneByteAtATime((opening ?? '') + (body ?? ''));
      expect(stream.tail(40, 3).every((line) => line.text.startsWith(prefix ?? ''))).toBe(true);
      stream.append(closing ?? '');
      stream.append('# next\n');
      expect(rows(stream)).toContain('next');
    }
  });

  it('preserves historical delimiters inside link labels and always shows the complete target', () => {
    for (const [marker, flag] of [
      ['**', 'strong'],
      ['*', 'emphasis'],
      ['~~', 'strike'],
      ['`', 'code'],
      ['``', 'code'],
    ]) {
      const stream = new MarkdownStream();
      stream.append('[' + marker + 'x'.repeat(8_000) + marker + '](https://x.test)');
      const spans = stream.tail(80, 3).flatMap((line) => line.spans);
      const label = spans.find(
        (span) => span.text.includes('x') && span.linkURL === 'https://x.test',
      );
      expect(label).toMatchObject({ [flag ?? 'strong']: true, linkURL: 'https://x.test' });
      expect(spans.map((span) => span.text).join('')).toContain(' (https://x.test)');
      expect(spans.map((span) => span.text).join('')).not.toContain(marker);
    }
  });

  it('keeps tab-indented list-fence bodies literal after the opener leaves the live tail', () => {
    const stream = new MarkdownStream();
    stream.append('- ```\n');
    for (let row = 0; row < 1_000; row++) stream.append('\t**literal**\n');
    const literalRows = stream.tail(80, 5).filter((line) => line.text.includes('literal'));
    expect(literalRows.length).toBeGreaterThan(0);
    for (const line of literalRows) {
      expect(line.text).toContain('│       **literal**');
      expect(line.spans.some((span) => span.code)).toBe(true);
      expect(line.spans.some((span) => span.strong)).toBe(false);
    }
    stream.append('\n\t```\n');
    expect(stream.tail(80, 5).some((line) => line.text.includes('│       ```'))).toBe(true);
    stream.append('# next');
    const next = stream.tail(80, 5).find((line) => line.text === 'next');
    expect(next?.spans.some((span) => span.heading === 1 && !span.code)).toBe(true);
  });

  it('accepts a tabbed closer when only one structural cell remains after list indentation', () => {
    const stream = new MarkdownStream();
    stream.append('12345. ```\n' + '\t**literal**\n'.repeat(1_000));
    const literalRows = stream.tail(80, 5).filter((line) => line.text.includes('literal'));
    expect(literalRows.length).toBeGreaterThan(0);
    expect(literalRows.every((line) => line.text.includes('│  **literal**'))).toBe(true);
    stream.append('\t```\n# next');
    const lines = stream.tail(80, 5);
    expect(lines.some((line) => line.text.includes('```'))).toBe(false);
    expect(
      lines
        .find((line) => line.text === 'next')
        ?.spans.some((span) => span.heading === 1 && !span.code),
    ).toBe(true);
  });

  it('retains autolink context before the tail', () => {
    const stream = oneByteAtATime('<https://example.test/' + 'x'.repeat(8_000));
    stream.append('>');
    const spans = stream.tail(60, 2).flatMap((line) => line.spans);
    expect(spans.some((span) => span.linkURL?.startsWith('https://example.test/'))).toBe(true);
    expect(spans.map((span) => span.text).join('')).not.toContain('>');
  });

  it('caches a finalized table grid across following token frames and invalidates on resize', () => {
    const stream = new MarkdownStream();
    stream.append('| h |\n| --- |\n| x |\n\n');
    const draw = vi.spyOn(layout, 'layoutMarkdown');
    stream.tail(80, 12);
    for (const character of 'following words') {
      stream.append(character);
      stream.tail(80, 12);
    }
    expect(
      draw.mock.calls.filter(([blocks]) => blocks.some((block) => block.kind === 'table')),
    ).toHaveLength(1);
    stream.tail(40, 12);
    expect(
      draw.mock.calls.filter(([blocks]) => blocks.some((block) => block.kind === 'table')),
    ).toHaveLength(2);
    draw.mockRestore();
  });

  it('consumes long delimiter runs once rather than growing a rescanned lexer buffer', () => {
    const stream = oneByteAtATime('`'.repeat(30_000));
    expect(stream.work.lexical).toBe(30_000);
    stream.tail(80, 3);
    expect(stream.work.lexical).toBe(30_000);
    stream.append('x');
    expect(stream.work.lexical).toBe(30_001);
  });

  it('keeps Unicode clusters intact when the source budget cuts through them', () => {
    for (const cluster of ['界', 'e\u0301', '👩‍💻', '🇹🇷']) {
      const stream = new MarkdownStream();
      stream.append('prefix '.repeat(1_000) + cluster + 'x'.repeat(3_999));
      expect(stream.sourceTail()).toBe((cluster.length === 1 ? cluster : '') + 'x'.repeat(3_999));
      expect(
        stream
          .tail(60, 2)
          .map((line) => line.text)
          .join(''),
      ).toMatch(/^x+$/);
    }
  });

  it('does not leak inline styles out of historical code and strong delimiters', () => {
    const stream = new MarkdownStream();
    stream.append('**`' + 'x'.repeat(8_000) + '`** plain');
    const spans = stream.tail(80, 2).flatMap((line) => line.spans);
    expect(spans.some((span) => span.code && span.strong)).toBe(true);
    expect(spans.find((span) => span.text.includes('plain'))?.strong).not.toBe(true);
    expect(spans.map((span) => span.text).join('')).not.toContain('**');
  });

  it('holds a quoted table body and finalizes it before a following quoted heading', () => {
    const stream = oneByteAtATime('> | h |\n> | --- |\n> | x |');
    expect(rows(stream).join('')).not.toContain('┌');
    stream.append('\n> # next\n');
    expect(rows(stream).join('')).toContain('┌');
    expect(rows(stream).join('')).toContain('x');
  });

  it('preserves a heading prefix outside a long unfinished line', () => {
    const stream = oneByteAtATime('# ' + 'word '.repeat(2_000));
    expect(
      stream
        .tail(60, 2)
        .flatMap((line) => line.spans)
        .some((span) => span.heading === 1),
    ).toBe(true);
  });

  it('does not hand an accumulated unfinished line or paragraph to the block parser per frame', () => {
    const parse = vi.spyOn(parser, 'parseMarkdown');
    const stream = new MarkdownStream();
    const source = '**' + 'word '.repeat(2_000);
    for (let at = 0; at < source.length; at++) {
      stream.append(source[at] ?? '');
      if (at % 31 === 0) stream.tail(80, 8);
    }
    expect(Math.max(...parse.mock.calls.map(([source]) => source.length))).toBeLessThanOrEqual(
      4_000,
    );
    expect(stream.work.lexical).toBeLessThan(source.length * 3);
    expect(stream.work.blocks).toBe(0);
    stream.append('\n' + 'more words\n'.repeat(2_000));
    const before = stream.work;
    stream.tail(80, 8);
    stream.tail(40, 8);
    expect(stream.work).toEqual(before);
    stream.append('\n');
    expect(stream.work.blocks).toBeLessThan(source.length + 25_000);
    expect(stream.work.inline).toBeLessThan(source.length + 25_000);
    parse.mockRestore();
  });

  it('bounds unfinished table layout even after row and source overflow', () => {
    const stream = new MarkdownStream();
    stream.append('| h |\n| --- |\n');
    const parse = vi.spyOn(parser, 'parseMarkdown');
    for (let i = 0; i < 160; i++) {
      stream.append('| ' + 'x'.repeat(500) + ' |\n');
      const before = stream.work;
      expect(stream.tail(80, 5)).toHaveLength(5);
      expect(stream.work).toEqual(before);
    }
    expect(parse).not.toHaveBeenCalled();
    stream.append('\n');
    expect(rows(stream).join('')).not.toContain('┌');
    expect(stream.work.blocks).toBeLessThan(90_000);
    parse.mockRestore();
  });

  it('caches the bounded layout and preserves canonical final parsing at every split', () => {
    const source = 'Title\n---\n\n- one\n  - two\n\n```ts\n**x**\n```\n\n| h |\n| --- |\n| x |';
    for (let at = 0; at <= source.length; at++) {
      const stream = new MarkdownStream();
      stream.append(source.slice(0, at));
      stream.append(source.slice(at));
      expect(stream.tail(40, 8)).toBe(stream.tail(40, 8));
      expect(layoutMarkdown(stream.finish(), 40)).toEqual(
        layoutMarkdown(parseMarkdown(source), 40),
      );
    }
  });

  it('clears all fence, delimiter and source-tail state at reset and finish', () => {
    const stream = new MarkdownStream();
    stream.append('```\n' + 'x'.repeat(5_000));
    stream.reset();
    expect(stream.sourceTail()).toBe('');
    expect(stream.elided).toBe(false);
    stream.append('**next**');
    expect(rows(stream)).toEqual(['next']);
    stream.finish();
    stream.append('# next');
    expect(rows(stream)).toEqual(['next']);
  });
});
