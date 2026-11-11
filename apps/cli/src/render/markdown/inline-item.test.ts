import { describe, expect, it } from 'vitest';
import { sanitizeInline } from '../sanitize.js';
import { StaticInlineIndex } from './inline-index.js';
import { interpretInlineItem, type InlineItemStyle } from './inline-item.js';
import { parseInline } from './inline.js';
import type { MarkdownSpan } from './types.js';

function fromItems(source: string, style: InlineItemStyle = {}, depth = 0): MarkdownSpan[] {
  const index = new StaticInlineIndex(source);
  const result: MarkdownSpan[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain) result.push({ text: plain, ...style });
    plain = '';
  };
  for (let at = 0; at < source.length; ) {
    const item = interpretInlineItem(
      index,
      at,
      source.length,
      depth,
      plain.slice(-2),
      (start, end, childDepth, flags, flatten) => {
        const input = source.slice(start, end);
        const spans = fromItems(
          flatten ? sanitizeInline(input) : input,
          { ...style, ...flags },
          childDepth,
        );
        return { text: spans.map((span) => span.text).join(''), value: spans };
      },
    );
    if (!item.plain) flush();
    if (item.trimPlain) plain = plain.slice(0, -item.trimPlain);
    for (const part of item.parts) {
      if (part.kind === 'child') {
        for (const span of part.value) result.push(span);
        continue;
      }
      const text =
        part.kind === 'text'
          ? part.text
          : part.flatten
            ? sanitizeInline(source.slice(part.start, part.end))
            : source.slice(part.start, part.end);
      if (item.plain) plain += text;
      else result.push({ text, ...style, ...part.style });
    }
    at = item.end;
  }
  flush();
  return result;
}
function styledUnits(spans: readonly MarkdownSpan[]): string[] {
  return spans.flatMap((span) =>
    Array.from(span.text, (character) => JSON.stringify({ ...span, text: character })),
  );
}

describe('indexed canonical inline decisions', () => {
  it('scopes opaque links to outer searches without hiding child label markup', () => {
    const source = '**[**label**](https://example.test)**';
    const index = new StaticInlineIndex(source);
    expect(index.next('**', 2, source.length)).toBe(source.length - 2);
    const label = new StaticInlineIndex('**label**');
    expect(label.next('**', 2, label.length)).toBe(7);
    const ticks = new StaticInlineIndex('`[x](https://example.test/`y`)`');
    expect(ticks.tickClose(0, ticks.length)).toBe(26);
    expect(ticks.tickClose(0, 26)).toBe(-1);
  });
  it('match the existing parser on wrappers, links and Unicode', () => {
    for (const source of [
      '*[**label**](https://x.test/*a*)*',
      '**![alt](https://x.test)**',
      '`[x](https://x.test/`a`)`',
      '𝑥__𝑦__𝑧',
      '[a\t\tb](https://x.test)',
      '***hello***',
      '*x **y***',
      'a  \nb',
    ]) {
      expect(styledUnits(fromItems(source)), source).toEqual(styledUnits(parseInline(source)));
    }
  });
  it('match the existing parser across deterministic malformed inputs', () => {
    let seed = 0x12345678;
    const alphabet = ['a', ' ', '*', '_', '~', '`', '[', ']', '(', ')', '\\', '\t', '\n', 'é'];
    for (let example = 0; example < 3_000; example++) {
      let source = '';
      for (let at = 0; at < 24; at++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        source += alphabet[seed % alphabet.length];
      }
      expect(styledUnits(fromItems(source)), JSON.stringify(source)).toEqual(
        styledUnits(parseInline(source)),
      );
    }
  });
});
