import { describe, expect, it } from 'vitest';
import { parseInline } from './inline.js';
import { layoutMarkdown } from './layout.js';
import { isAutolinkTarget } from './opaque-targets.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

describe('autolink target recognition', () => {
  it.each([
    ['https://example.test/a@b@c', true],
    ['http://x', true],
    ['https://', false],
    ['http://', false],
    ['HTTPS://example.test', false],
    ['mailto:a@b.c', true],
    ['a@b.c', true],
    ['a@...', true],
    ['a@..b', true],
    ['a@b..', true],
    ['𝑥@例.子', true],
    ['a@.', false],
    ['a@..', false],
    ['a@.b', false],
    ['a@b.', false],
    ['a@b.c@', false],
    ['@b.c', false],
    ['a.b.c', false],
    ['a@b c.d', false],
    ['https://a<b', false],
    ['https://a>b', false],
    ['a@b.c\n', false],
    ['https://a\u2028', false],
  ])('recognizes %j as %j', (target, expected) => {
    expect(isAutolinkTarget(target)).toBe(expected);
  });

  it('preserves the previous grammar across a bounded differential corpus', () => {
    // Only short candidates reach this historical oracle. Never apply its
    // backtracking email branch to the long resource-regression payload.
    const previous = /^(?:https?:\/\/[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/u;
    const atoms = ['a', '@', '.', ' ', '<', '>', '/', '\n', '\t', '𝑥', 'é', '\u00a0', '\ud835'];
    const prefixes = ['', 'http://', 'https://', 'HTTPS://'];
    let seed = 1931;
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    for (let candidate = 0; candidate < 10_000; candidate++) {
      const prefix = prefixes[random(prefixes.length)] ?? '';
      const target =
        prefix +
        Array.from({ length: random(17) }, () => atoms[random(atoms.length)] ?? '').join('');
      expect(isAutolinkTarget(target), JSON.stringify(target)).toBe(previous.test(target));
    }
  });

  it.each(['https://e.test/**x**', 'a@b..c', 'a@...', '𝑥@例.子', 'a@b.c@', 'a@..'])(
    'keeps cold and split live recognition identical for %j',
    (target) => {
      const source = `prefix <${target}>`;
      const expected = layoutMarkdown(parseMarkdown(source), 80);
      const inline = parseInline(source);
      expect(inline.map((span) => span.text).join('')).toBe(
        `prefix ${isAutolinkTarget(target) ? target : `<${target}>`}`,
      );
      for (let split = 0; split <= source.length; split++) {
        const stream = new MarkdownStream();
        stream.append(source.slice(0, split));
        stream.tail(80, 12);
        stream.append(source.slice(split));
        expect(stream.tail(80, 12)).toEqual(expected);
        expect(stream.finish()).toEqual(parseMarkdown(source));
      }
    },
  );
});
