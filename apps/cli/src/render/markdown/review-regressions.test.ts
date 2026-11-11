import { describe, expect, it } from 'vitest';
import { layoutMarkdown, parseInline, parseMarkdown, type MarkdownBlock } from './index.js';
import { parseHeading } from './parser.js';

const rows = (source: string, width = 80): string[] =>
  layoutMarkdown(parseMarkdown(source), width).map((line) => line.text);

describe('markdown review regressions', () => {
  it('ends list context at outer blocks', () => {
    for (const block of ['# title', '---', '```\ncode\n```', '| h |\n| --- |\n']) {
      const parsed = parseMarkdown(`- a\n${block}\nhello\nworld`);
      expect(parsed.at(-1)).toMatchObject({ kind: 'paragraph', text: 'hello\nworld' });
    }
    expect(rows('- a\n  # nested\n  tail')).toEqual(['• a', '  nested', '  tail']);
  });
  it('caps cumulative quote depth across spacing and list containers', () => {
    const eight = '>    '.repeat(8) + 'x';
    const nine = '>    '.repeat(9) + 'x';
    expect(rows(eight)).toEqual(['│ '.repeat(8) + '   x']);
    expect(rows(nine)).toEqual([nine]);
    expect(rows('>'.repeat(8) + ' x')).toEqual(['│ '.repeat(8) + 'x']);
    expect(rows('>'.repeat(9) + ' x')).toEqual(['>'.repeat(9) + ' x']);
    const mixedEight = '> - '.repeat(8) + 'x';
    expect(parseMarkdown(mixedEight)[0]?.raw).not.toBe(true);
    expect(rows(mixedEight, 200)[0]).toContain('x');
    const mixed = '> - '.repeat(9) + 'x';
    expect(rows(mixed, 200)).toEqual([mixed]);
    const large = '>    '.repeat(5000) + 'x';
    const parsed = parseMarkdown(large);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: 'literal', source: large, raw: true });
  });
  it('keeps all outer quote bars on hanging list rows', () => {
    expect(rows('> - > abcdefghijklmnopqrstuvwxyz', 12)).toEqual([
      '│ • │ abcdef',
      '│   │ ghijkl',
      '│   │ mnopqr',
      '│   │ stuvwx',
      '│   │ yz',
    ]);
  });
  it('bounds heading scanner work with long internal or closing spaces', () => {
    for (const size of [20000, 40000, 80000]) {
      for (const line of [`# x${' '.repeat(size)}y`, `# x${' '.repeat(size)}###  `]) {
        const counter = { steps: 0 };
        const result = parseHeading(line, counter);
        expect(result?.level).toBe(1);
        expect(counter.steps).toBeLessThanOrEqual(line.length * 2 + 8);
      }
    }
  });
  it('applies omitted display columns to first-line tab stops only', () => {
    const literal = [
      { kind: 'literal', source: '\tx\n\ty', text: '\tx\n\ty', tabOffset: 3 },
    ] satisfies readonly MarkdownBlock[];
    expect(layoutMarkdown(literal, 80).map((line) => line.text)).toEqual(['     x', '        y']);
    const code = [
      { kind: 'code', source: '\tx\n\ty', text: '\tx\n\ty', tabOffset: 3 },
    ] satisfies readonly MarkdownBlock[];
    expect(layoutMarkdown(code, 80).map((line) => line.text)).toEqual(['│    x', '│       y']);
    const styled = [
      {
        kind: 'paragraph',
        source: '\tx',
        text: '\tx',
        spans: [{ text: '\tx', strong: true }],
        prefix: '│ ',
        tabOffset: 3,
      },
    ] satisfies readonly MarkdownBlock[];
    expect(layoutMarkdown(styled, 80).map((line) => line.text)).toEqual(['│    x']);
  });
  it('shows the exact link target even when the label transforms', () => {
    for (const target of ['https://example.test/**secret**', 'https://example.test/\\*secret\\*']) {
      const result = parseInline(`[${target}](${target})`)
        .map((span) => span.text)
        .join('');
      expect(result).toContain(`(${target})`);
    }
    expect(
      parseInline('[https://example.test](https://example.test)')
        .map((span) => span.text)
        .join(''),
    ).toBe('https://example.test');
  });
});
