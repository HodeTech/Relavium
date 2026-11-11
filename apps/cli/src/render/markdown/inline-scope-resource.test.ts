import { describe, expect, it } from 'vitest';
import { MarkdownStream } from './stream.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';

const families = [
  (n: number): string => '*[x]('.repeat(n) + ')*'.repeat(n),
  (n: number): string => '*' + '[a]('.repeat(n) + ')*'.repeat(n),
  (n: number): string => '***' + '[x]('.repeat(n) + ')**'.repeat(n),
  (n: number): string => '~~' + '[x]('.repeat(n) + ')~~'.repeat(n),
];

describe('growing styled inline scopes', () => {
  it.each(families.map((family, index) => ({ family, index })))(
    'indexes only affected scope facts for family $index',
    ({ family }) => {
      for (const n of [100, 200, 400, 800]) {
        const source = family(n);
        const stream = new MarkdownStream();
        let maximumScopeRetained = 0;
        for (const unit of source) {
          stream.append(unit);
          maximumScopeRetained = Math.max(
            maximumScopeRetained,
            stream.checkpointWork.scopeRetained,
          );
        }
        const work = stream.checkpointWork;
        expect(work.indexed).toBeLessThan(source.length * 500);
        // Triple-marker decisions inspect multiple short marker slices.
        expect(work.copied).toBeLessThan(source.length * 6);
        expect(work.decisions).toBeLessThan(source.length * 4);
        expect(work.cache).toBeLessThan(source.length * 2_500);
        expect(work.retained).toBeLessThan(source.length * 3);
        expect(work.indexRetained).toBeLessThan(source.length * 3);
        expect(maximumScopeRetained).toBeLessThan(source.length * 6);
        expect(stream.finish()).toEqual(parseMarkdown(source));
        expect(stream.checkpointWork.scopeRetained).toBe(0);
      }
    },
  );

  it.each([
    '*[x](inner(**literal**))* **after**',
    '**[a](x(y)) _visible_** [b](https://valid.test/*target*)',
    '~~[x](x(`hidden*`))~~ `outer`',
    '*[x](a(\\(b\\))) **child**[y](https://example.test) tail*',
    ...families.map((family) => family(8)),
  ])('preserves text and styling at every incremental boundary: %s', (source) => {
    for (const size of [1, 3, 13, source.length]) {
      const stream = new MarkdownStream();
      let prefix = '';
      for (let at = 0; at < source.length; at += size) {
        const fragment = source.slice(at, at + size);
        prefix += fragment;
        stream.append(fragment);
        expect(stream.tail(10_000, 4)).toEqual(layoutMarkdown(parseMarkdown(prefix), 10_000));
      }
      expect(stream.finish()).toEqual(parseMarkdown(source));
    }
  });

  it.each([100, 200, 400])('bounds indexed and preview work with repeated draws (%i)', (n) => {
    const source = families[0]?.(n) ?? '';
    const stream = new MarkdownStream();
    let draws = 0;
    for (let at = 0; at < source.length; at += 13) {
      stream.append(source.slice(at, at + 13));
      stream.tail(80, 8);
      draws++;
    }
    expect(stream.tail(10_000, 5)).toEqual(layoutMarkdown(parseMarkdown(source), 10_000));
    const work = stream.checkpointWork;
    const geometry = stream.geometryWork;
    expect(work.indexed).toBeLessThan(source.length * 500);
    expect(work.copied).toBeLessThan(source.length * 6);
    expect(work.decisions).toBeLessThan(source.length * 4);
    expect(work.retained).toBeLessThan(source.length * 3);
    expect(work.indexRetained).toBeLessThan(source.length * 3);
    const previewBudget = (draws + 1) * 4_000;
    expect(work.cache).toBeLessThan(previewBudget * 4);
    expect(geometry.visits).toBeLessThan(previewBudget * 8);
    expect(geometry.constructedUnits).toBeLessThan(previewBudget * 20);
  });

  it('keeps scoped opacity and styling after the opener leaves the live window', () => {
    const prefix = 'p ' + 'x'.repeat(4_100) + ' *';
    const suffix = '[a](outer(`hidden*`)) [b](https://example.test/**raw**) **visible** tail*';
    const source = prefix + suffix;
    const expected = layoutMarkdown(parseMarkdown(source), 10_000)[0];
    const units = (line: NonNullable<typeof expected>): string[] =>
      line.spans.flatMap(({ text, ...style }) =>
        Array.from(text, (character) => JSON.stringify([character, style])),
      );
    for (const size of [1, 7, suffix.length]) {
      const stream = new MarkdownStream();
      stream.append(prefix);
      for (let at = 0; at < suffix.length; at += size) {
        stream.append(suffix.slice(at, at + size));
        stream.tail(80, 5);
      }
      const actual = stream.tail(10_000, 5)[0];
      expect(expected).toBeDefined();
      expect(actual).toBeDefined();
      if (!expected || !actual) continue;
      const rendered = units(actual);
      expect(units(expected).slice(-rendered.length)).toEqual(rendered);
      expect(stream.finish()).toEqual(parseMarkdown(source));
      expect(stream.checkpointWork.scopeRetained).toBe(0);
    }
  });
});
