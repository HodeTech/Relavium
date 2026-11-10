import { describe, expect, it } from 'vitest';
import { parseInline } from './inline.js';
import { findOpaqueTargets } from './opaque-targets.js';

const flattened = (source: string): string =>
  parseInline(source)
    .map((span) => span.text)
    .join('');

describe('opaque inline targets', () => {
  it('shows exact link and image targets inside every supported wrapper', () => {
    for (const marker of ['*', '**', '~~', '`']) {
      const target = `https://evil.test/${marker}secret${marker}/foo`;
      for (const label of ['[label]', '![alt]']) {
        const source = `${marker}${label}(${target})${marker}`;
        expect(flattened(source), source).toContain(target);
      }
    }
  });
  it('shows autolinks without interpreting markup inside their targets', () => {
    for (const marker of ['*', '**', '~~', '`']) {
      const target = `https://example.test/${marker}literal${marker}`;
      expect(flattened(`${marker}<${target}>${marker}`)).toContain(target);
    }
    expect(flattened('`[label](https://example.test/a)`')).toBe('[label](https://example.test/a)');
    expect(flattened('*[<https://a.test/*x*>](https://b.test)*')).toContain('https://a.test/*x*');
  });
  it('keeps unsupported links literal and identifies only supported target intervals', () => {
    const source = '*[label](https://example.test/*x*/q "title")*';
    expect(findOpaqueTargets(source).map((range) => source.slice(range.start, range.end))).toEqual([
      '[label](https://example.test/*x*/q "title")',
    ]);
    expect(
      findOpaqueTargets('![x](https://a.test/**x**) <https://b.test/*y*>').map((range) =>
        '![x](https://a.test/**x**) <https://b.test/*y*>'.slice(range.start, range.end),
      ),
    ).toEqual(['[x](https://a.test/**x**)', '<https://b.test/*y*>']);
    expect(flattened('**[label](https://a.test/**x**)**')).toBe('label (https://a.test/**x**)');
  });
  it('isolates label and image content from outer markers, preserving code precedence', () => {
    expect(flattened('**[**label**](https://example.test)**')).toBe('label (https://example.test)');
    expect(
      parseInline('**[`label`](https://example.test)**').some(
        (span) => span.text === 'label' && span.code && span.strong,
      ),
    ).toBe(true);
    expect(flattened('**![**alt**](https://example.test)**')).toBe(
      '[image: **alt**] (https://example.test)',
    );
    for (const ticks of ['`', '``']) {
      const inside = '[**label**](https://example.test/foo)';
      expect(parseInline(`${ticks}${inside}${ticks}`)).toEqual([{ text: inside, code: true }]);
    }
    const ambiguous = '`[label](https://example.test/`secret`/foo)`';
    const spans = parseInline(ambiguous);
    expect(spans.map((span) => span.text).join('')).toBe(
      '[label](https://example.test/`secret`/foo)',
    );
    expect(spans.filter((span) => span.code).map((span) => span.text)).toEqual([
      '[label](https://example.test/',
      '/foo)',
    ]);
  });
  it('keeps unsupported links literal inside outer formatting', () => {
    for (const marker of ['*', '**', '~~', '`']) {
      const literal = `[label](https://evil.test/${marker}secret${marker}/foo "title")`;
      expect(flattened(`${marker}${literal}${marker}`)).toBe(literal);
      const image = `![alt](https://evil.test/${marker}secret${marker}/foo "title")`;
      expect(flattened(`${marker}${image}${marker}`)).toBe(image);
    }
    expect(flattened('*[**literal**][reference]*')).toBe('[**literal**][reference]');
    for (const marker of ['*', '**', '~~']) {
      const literal = `[x](https://e.test/a(b)${marker}secret${marker})`;
      expect(flattened(`${marker}${literal}${marker}`)).toBe(literal);
    }
    const title = `[x](https://e.test/a '(title)*x*')`;
    expect(flattened(`*${title}*`)).toBe(title);
    const escaped = '[x](https://e.test/a\\(b\\)*secret*)';
    expect(flattened(`*${escaped}*`)).toBe(escaped);
    const nested = `[x](https://e.test/${'('.repeat(12_000)}*secret*${')'.repeat(12_000)})`;
    expect(flattened(`*${nested}*`)).toBe(nested);
  });
  it('handles long malformed candidates without losing input', () => {
    const source = '['.repeat(10_000) + 'x';
    expect(findOpaqueTargets(source)).toEqual([]);
    expect(flattened(source)).toBe(source);
  });
});
