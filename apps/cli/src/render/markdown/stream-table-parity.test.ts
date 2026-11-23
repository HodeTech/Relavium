import { describe, expect, it } from 'vitest';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import { MarkdownStream } from './stream.js';

describe('a pending table streams as it finally draws (ADR-0143)', () => {
  it('lays out a pending table over the row limit exactly as the finished table', () => {
    // 129 body rows is one more than the limit, so the table is literal. While it is still pending, its wrapped
    // lines must match the finished literal table, or the transcript reflows when the stream ends.
    const source = `| h |\n| --- |\n${'| abcdefghij k |\n'.repeat(129)}`;
    const stream = new MarkdownStream();
    stream.append(source);
    expect(stream.tail(12, 400)).toEqual(layoutMarkdown(parseMarkdown(source), 12).slice(-400));
  });
});
