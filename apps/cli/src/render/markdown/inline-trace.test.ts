import { describe, expect, it } from 'vitest';
import { interpretInline } from './inline.js';

function apply(source: string): string {
  const { spans, edits } = interpretInline(source);
  const changes = edits.filter((edit) => !edit.raw).sort((a, b) => a.start - b.start);
  let output = '';
  let offset = 0;
  for (const edit of changes) {
    expect(edit.start, JSON.stringify({ source, edit, changes })).toBeGreaterThanOrEqual(offset);
    output += source.slice(offset, edit.start) + edit.text;
    offset = edit.end;
  }
  output += source.slice(offset);
  expect(output).toBe(spans.map((span) => span.text).join(''));
  return output;
}

describe('canonical inline trace', () => {
  it('reproduces semantic text using source-indexed edits', () => {
    for (const source of [
      'hello **world**!',
      '***nested***',
      '*[x](https://evil.test/*x*/q)*',
      '*[**x**](https://evil.test/*x*/q)*',
      '*[x](https://evil.test/*x*/q "title")*',
      '`[x](https://evil.test/`x`/q)`',
      '**[<https://a.test/**x**>](https://b.test)**',
      '[**a**\t\tb](https://example.test)',
      '![a\t\tb](https://example.test)',
      '[https://a.test](https://a.test)',
      '<https://a.test/*q*>',
      '`**literal**`',
      'escaped \\* and two  \nlines',
      '\\ \\ \nnext',
    ])
      apply(source);
  });
  it('preserves source edit projection across varied nested and malformed syntax', () => {
    let seed = 0x12345678;
    const alphabet = ['a', ' ', '*', '_', '~', '`', '[', ']', '(', ')', '\\', '\t', '\n', 'é'];
    for (let example = 0; example < 1_000; example++) {
      let source = '';
      for (let at = 0; at < 24; at++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        source += alphabet[seed % alphabet.length];
      }
      apply(source);
    }
  });
  it('maps unresolved delimiter lookups to original UTF-16 offsets', () => {
    expect(interpretInline('prefix **unfinished').unresolved).toContainEqual({
      at: 7,
      token: '**',
    });
    expect(interpretInline('prefix `unfinished').unresolved).toContainEqual({ at: 7, token: '`' });
    expect(interpretInline('𝑥_').unresolved).toContainEqual({ at: 2, token: 'word' });
  });
});
