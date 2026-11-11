import { describe, expect, it } from 'vitest';
import { MarkdownStream } from './stream.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { parseInline } from './inline.js';

describe('inline source parity and unsupported shortcut references', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('uses raw backslash parity before newline (%i)', (slashes) => {
    const source = 'foo' + '\\'.repeat(slashes) + '\nbar';
    const expectedText =
      slashes % 2
        ? ['foo' + '\\'.repeat(Math.floor(slashes / 2)), 'bar']
        : ['foo' + '\\'.repeat(slashes / 2) + ' bar'];
    const expected = layoutMarkdown(parseMarkdown(source), 100);
    expect(expected.map((line) => line.text)).toEqual(expectedText);
    for (const size of [1, 2, 3, source.length]) {
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += size) {
        stream.append(source.slice(at, at + size));
        stream.tail(100, 5);
      }
      expect(stream.tail(100, 5)).toEqual(expected);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it.each([1, 2, 3, 4, 6])('preserves styled prefixes across raw escape parity (%i)', (slashes) => {
    const source = '**foo**' + '\\'.repeat(slashes) + '\nbar';
    const expected = layoutMarkdown(parseMarkdown(source), 100);
    const first = expected[0];
    expect(first?.spans.some((span) => span.text === 'foo' && span.strong)).toBe(true);
    const expectedText =
      slashes % 2
        ? ['foo' + '\\'.repeat(Math.floor(slashes / 2)), 'bar']
        : ['foo' + '\\'.repeat(slashes / 2) + ' bar'];
    expect(expected.map((line) => line.text)).toEqual(expectedText);
    const stream = new MarkdownStream();
    for (const unit of source) {
      stream.append(unit);
      stream.tail(100, 5);
    }
    expect(stream.tail(100, 5)).toEqual(expected);
    expect(stream.sourceTail()).toBe(source);
  });
  it.each([
    '[**ref**]: https://example.test\n\n[**ref**]',
    '[**bold**]',
    '[x\\]**y**]',
    '[a[**nested**]]',
    '![**alt**]',
  ])('retains ambiguous bare bracket source literally: %s', (source) => {
    const rows = layoutMarkdown(parseMarkdown(source), 100);
    const flattened = rows.map((line) => line.text).join('\n');
    expect(flattened).toContain(source.split('\n').at(-1));
    for (const size of [1, 3, source.length]) {
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += size) stream.append(source.slice(at, at + size));
      expect(stream.tail(100, 10)).toEqual(rows);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });
  it('still interprets labels in completed inline links and images', () => {
    const spans = parseInline('[**bold**](url)');
    expect(spans).toContainEqual({ text: 'bold', strong: true, linkURL: 'url' });
    expect(
      parseInline('![**alt**](url)')
        .map((span) => span.text)
        .join(''),
    ).toBe('[image: **alt**] (url)');
  });

  it.each(['*', '**', '~~', '_', '__'])(
    'preserves shortcut markers inside %s wrappers',
    (marker) => {
      const group = '[' + marker + 'ref' + marker + ']';
      const source = marker + group + marker;
      const expected = layoutMarkdown(parseMarkdown(source), 100);
      expect(expected.map((line) => line.text).join('\n')).toContain(group);
      const stream = new MarkdownStream();
      let prefix = '';
      for (const unit of source) {
        prefix += unit;
        stream.append(unit);
        expect(stream.tail(100, 5)).toEqual(layoutMarkdown(parseMarkdown(prefix), 100));
      }
      expect(stream.tail(100, 5)).toEqual(expected);
    },
  );

  it('upgrades a provisional bare group to a styled inline link at every boundary', () => {
    const source = '**outer [**label**](url) tail**';
    const stream = new MarkdownStream();
    let prefix = '';
    for (const unit of source) {
      prefix += unit;
      stream.append(unit);
      expect(stream.tail(100, 5)).toEqual(layoutMarkdown(parseMarkdown(prefix), 100));
    }
    expect(
      stream
        .tail(100, 5)
        .flatMap((line) => line.spans)
        .some((span) => span.text.includes('label') && span.strong && span.linkURL === 'url'),
    ).toBe(true);
  });

  it('preserves existing code precedence when a code span crosses a bare group', () => {
    const source = '`foo [bar`baz] blah`';
    const expected = layoutMarkdown(parseMarkdown(source), 100);
    expect(expected.map((line) => line.text).join('\n')).toBe('foo [barbaz] blah`');
    const stream = new MarkdownStream();
    for (const unit of source) stream.append(unit);
    expect(stream.tail(100, 5)).toEqual(expected);
  });

  it.each(['`[**lab`el**](url)` tail', '**[a`b**c`](url)** tail', '`![**lab`el**](url)` tail'])(
    'keeps code ownership consistent as a bare group becomes a target: %s',
    (source) => {
      const stream = new MarkdownStream();
      let prefix = '';
      for (const unit of source) {
        prefix += unit;
        stream.append(unit);
        expect(stream.tail(100, 5)).toEqual(layoutMarkdown(parseMarkdown(prefix), 100));
      }
    },
  );

  it.each([128, 256, 512])('bounds streamed provisional shortcut ownership (%i groups)', (n) => {
    const source = '**' + '[**a**] '.repeat(n);
    for (const size of [1, 13]) {
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += size) stream.append(source.slice(at, at + size));
      const work = stream.checkpointWork;
      expect(work.indexed).toBeLessThan(source.length * 400);
      expect(work.cache).toBeLessThan(source.length * 1_100);
      expect(work.copied).toBeLessThan(source.length * 4);
      expect(work.decisions).toBeLessThan(source.length * 3);
      expect(work.retained).toBeLessThan(source.length * 2);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });
});
