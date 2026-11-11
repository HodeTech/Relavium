import { describe, expect, it } from 'vitest';
import { MarkdownStream } from './stream.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { parseInline } from './inline.js';
import { StaticInlineIndex } from './inline-index.js';
import { isValidLinkTarget } from './opaque-targets.js';

const flattened = (source: string): string =>
  parseInline(source)
    .map((span) => span.text)
    .join('');

describe('nested unsupported target indexing', () => {
  it('answers exact target validity for every subrange, including escaped punctuation and Unicode', () => {
    const source = 'a\\(b)c\u00a0d\te\nf🧪%20';
    const index = new StaticInlineIndex(source);
    for (let start = 0; start <= source.length; start++)
      for (let end = start; end <= source.length; end++)
        expect(index.validLinkTarget(start, end)).toBe(isValidLinkTarget(source.slice(start, end)));
  });

  it.each([
    '*[a](url(inner*secret*)) *tail*',
    '**[a](url(**hidden**))** and **visible**',
    '~~![a](url(~~target~~))~~ ~~next~~',
    '*[a](url(\\(escaped\\))) `literal`*',
    '[x]([y](`code*`)) **after**',
    '*[a](x(y(z))) [b](https://valid.test/**target**) tail*',
    '[a](x(y)) [b](x(z)) ~~outer~~',
  ])('preserves exact canonical source and styling across fragment schedules: %s', (source) => {
    const expected = layoutMarkdown(parseMarkdown(source), 500);
    for (const size of [1, 3, source.length]) {
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += size) {
        stream.append(source.slice(at, at + size));
        stream.tail(500, 4);
      }
      expect(stream.tail(500, 4)).toEqual(expected);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
    expect(flattened(source)).toContain('(');
  });

  it.each([200, 400, 800, 1600])('bounds ingestion and copying for nested targets (%i)', (n) => {
    const source = '[x]('.repeat(n) + ')'.repeat(n);
    for (const size of [1, source.length]) {
      const stream = new MarkdownStream();
      for (let at = 0; at < source.length; at += size) stream.append(source.slice(at, at + size));
      const work = stream.checkpointWork;
      expect(work.indexed).toBeLessThan(source.length * 225);
      expect(work.copied).toBeLessThan(source.length * 3);
      expect(work.decisions).toBeLessThan(source.length * 3);
      expect(work.cache).toBeLessThan(source.length * 400);
      expect(work.retained).toBeLessThan(source.length * 3);
      expect(work.indexRetained).toBeLessThanOrEqual(source.length * 2 + 1);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it('preserves styles and literal targets after the opener leaves the live window', () => {
    const prefix = 'p ' + 'x'.repeat(4100);
    const suffix = ' *[a](x(`h*`)) [z](https://valid.test/a) **last**';
    const source = prefix + suffix;
    const expected = layoutMarkdown(parseMarkdown(source), 10_000)[0];
    expect(expected).toBeDefined();
    for (const size of [1, 7, suffix.length]) {
      const stream = new MarkdownStream();
      stream.append(prefix);
      for (let at = 0; at < suffix.length; at += size) {
        stream.append(suffix.slice(at, at + size));
        stream.tail(10_000, 4);
      }
      const actual = stream.tail(10_000, 4)[0];
      expect(actual).toBeDefined();
      const semanticUnits = (line: NonNullable<typeof actual>): string[] =>
        line.spans.flatMap(({ text, ...flags }) =>
          Array.from(text, (character) => JSON.stringify([character, flags])),
        );
      const wanted = semanticUnits(expected ?? { text: '', spans: [] });
      const received = semanticUnits(actual ?? { text: '', spans: [] });
      expect(wanted.slice(-received.length)).toEqual(received);
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it.each([40, 80, 160])('bounds work while drawing each nested-target fragment (%i)', (n) => {
    const source = '[x]('.repeat(n) + ')'.repeat(n);
    const stream = new MarkdownStream();
    for (const unit of source) {
      stream.append(unit);
      stream.tail(80, 5);
    }
    expect(stream.tail(10_000, 5)).toEqual(layoutMarkdown(parseMarkdown(source), 10_000));
    const work = stream.checkpointWork;
    const geometry = stream.geometryWork;
    expect(work.indexed).toBeLessThan(source.length * 225);
    expect(work.copied).toBeLessThan(source.length * 3);
    expect(work.decisions).toBeLessThan(source.length * 3);
    expect(work.retained).toBeLessThan(source.length * 3);
    expect(work.indexRetained).toBeLessThanOrEqual(source.length * 2 + 1);
    // Drawing may revisit the fixed 4,000-unit live window on each frame.
    const previewBudget = source.length * 4_000;
    expect(work.cache).toBeLessThan(previewBudget);
    expect(geometry.visits).toBeLessThan(previewBudget);
    expect(geometry.nodes).toBeLessThan(previewBudget);
    expect(geometry.constructedUnits).toBeLessThan(previewBudget * 2);
    expect(geometry.sourceUnits).toBeLessThan(source.length * 20);
  });
});
