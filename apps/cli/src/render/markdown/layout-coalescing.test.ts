import { describe, expect, it } from 'vitest';
import { layoutMarkdown, parseMarkdown, type MarkdownBlock } from './index.js';

describe('display span retention', () => {
  it('keeps one span per row for a large plain entry', () => {
    const text = 'x'.repeat(200_000);
    const rows = layoutMarkdown(parseMarkdown(text), 80);
    expect(rows).toHaveLength(2_500);
    expect(rows.map((row) => row.text).join('')).toBe(text);
    expect(rows.reduce((count, row) => count + row.spans.length, 0)).toBe(2_500);
  });

  it('retains only gutter and content spans for long code', () => {
    const text = 'x'.repeat(8_000);
    const rows = layoutMarkdown(parseMarkdown(`\`\`\`\n${text}\n\`\`\``), 80);
    expect(rows.map((row) => row.text.slice(2)).join('')).toBe(text);
    expect(rows.every((row) => row.spans.length === 2)).toBe(true);
    expect(rows.every((row) => row.spans[0]?.dim && row.spans[1]?.code)).toBe(true);
  });

  it('bounds retained spans by rows and style transitions in long mixed text', () => {
    const text = 'a'.repeat(4_003) + 'b'.repeat(4_003) + 'c'.repeat(4_003);
    const block: MarkdownBlock = {
      kind: 'paragraph',
      source: text,
      text,
      spans: [
        { text: text.slice(0, 4_003) },
        { text: text.slice(4_003, 8_006), strong: true },
        { text: text.slice(8_006), code: true },
      ],
    };
    const rows = layoutMarkdown([block], 80);
    expect(rows.map((row) => row.text).join('')).toBe(text);
    expect(rows.reduce((count, row) => count + row.spans.length, 0)).toBeLessThanOrEqual(
      rows.length + 2,
    );
    expect(rows.flatMap((row) => row.spans).some((span) => span.strong)).toBe(true);
    expect(rows.flatMap((row) => row.spans).some((span) => span.code)).toBe(true);
  });

  it('preserves style changes and graphemes across adjacent spans', () => {
    const block: MarkdownBlock = {
      kind: 'paragraph',
      source: 'e\u0301 👩‍💻 strong link',
      text: '',
      spans: [
        { text: 'e' },
        { text: '\u0301 👩‍💻 ', strong: false },
        { text: 'str', strong: true },
        { text: 'ong', strong: true },
        { text: ' ' },
        { text: 'li', linkURL: 'https://example.test' },
        { text: 'nk', linkURL: 'https://example.test' },
      ],
    };
    const lines = layoutMarkdown([block], 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('e\u0301 👩‍💻 strong link');
    expect(lines[0]?.spans).toEqual([
      { text: 'e\u0301 👩‍💻 ' },
      { text: 'strong', strong: true },
      { text: ' ' },
      { text: 'link', linkURL: 'https://example.test' },
    ]);
  });
});
