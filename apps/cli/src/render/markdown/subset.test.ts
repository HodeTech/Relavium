import { describe, expect, it } from 'vitest';
import { displayWidth, wrapText } from '../tui/viewport.js';
import { layoutMarkdown, parseInline, parseMarkdown, type MarkdownBlock } from './index.js';

const rows = (source: string, width = 80): string[] =>
  layoutMarkdown(parseMarkdown(source), width).map((row) => row.text);

describe('markdown subset and geometry', () => {
  it('parses nested constructs in quotes, including fences and headings', () => {
    expect(rows('> # Title\n> ```ts\n>   x\n> ```')).toEqual(['│ Title', '│ ts', '│ │   x']);
    expect(rows('> - one\n>   - two')).toEqual(['│ • one', '│   • two']);
  });
  it('recognizes blocks inside list items with hanging indentation', () => {
    expect(rows('- # Head')).toEqual(['• Head']);
    expect(rows('- > quoted')).toEqual(['• │ quoted']);
    expect(rows('- ```ts\n  code\n  ```')).toEqual(['• ts', '  │ code']);
    expect(rows('- first\n  ```\n  code\n  ```')).toEqual(['• first', '  │ code']);
    expect(rows('- # heading with words', 12)).toEqual(['• heading ', '  with words']);
    expect(rows('- | h |\n  | --- |\n  | x |')).toEqual([
      '• ┌───┐',
      '  │ h │',
      '  ├───┤',
      '  │ x │',
      '  └───┘',
    ]);
  });
  it('retains tab cells beyond the list content column', () => {
    expect(rows('- item\n\tcontinuation')).toEqual(['• item', '        continuation']);
    expect(rows('123456. item\n\tcontinuation')).toEqual(['123456. item', '        continuation']);
    expect(rows('1. item\n\tcontinuation')).toEqual(['1. item', '        continuation']);
  });
  it('retains tab-indented fenced text as code and closes only within three relative spaces', () => {
    const lines = layoutMarkdown(parseMarkdown('- ```\n\t**literal**\n\t```'), 80);
    expect(lines.map((line) => line.text)).toEqual(['• │       **literal**', '  │       ```']);
    const codeSpans = lines[0]?.spans.filter((span) => span.code) ?? [];
    expect(codeSpans.map((span) => span.text).join('')).toBe('      **literal**');
    expect(codeSpans.every((span) => !span.strong)).toBe(true);
    expect(rows('- ```\n\t**literal**\n\t```\n# next')).toEqual([
      '• │       **literal**',
      '  │       ```',
      'next',
    ]);
    expect(rows('12345. ```\n\t**literal**\n\t```\n# next')).toEqual([
      '12345. │  **literal**',
      'next',
    ]);
    expect(rows('- ```\n  a\n\n  b\n  ```\nafter')).toEqual(['• │ a', '  │ ', '  │ b', 'after']);
    expect(rows('- first\n  ```\n\t**literal**\n\n  ```\nafter')).toEqual([
      '• first',
      '  │       **literal**',
      '  │ ',
      'after',
    ]);
    expect(rows('123456. ```\n\t**literal**\n\t```\nafter')).toEqual([
      '123456. │ **literal**',
      'after',
    ]);
  });
  it('preserves a single over-depth list line literally', () => {
    const source = '- '.repeat(9) + 'text';
    expect(rows(source)).toEqual([source]);
    expect(rows('> ' + source)).toEqual(['> ' + source]);
  });
  it('keeps lazy list continuations literal until a new block', () => {
    expect(rows('- first\n**literal**\n*also literal*\n\n**styled**')).toEqual([
      '• first',
      '**literal**',
      '*also literal*',
      '',
      'styled',
    ]);
  });
  it('splits table cells on unescaped pipes outside code', () => {
    const table = '| a | b |\n| --- | --- |\n| `x|y` | x\\|y |';
    expect(rows(table)).toEqual([
      '┌─────┬─────┐',
      '│ a   │ b   │',
      '├─────┼─────┤',
      '│ x|y │ x|y │',
      '└─────┴─────┘',
    ]);
  });
  it('styles matching inline delimiters without hiding escaped closers', () => {
    expect(parseInline('***x***')).toEqual([{ text: 'x', strong: true, emphasis: true }]);
    expect(parseInline('*a \\* b*')).toEqual([{ text: 'a * b', emphasis: true }]);
    expect(parseInline('a_b_c')).toEqual([{ text: 'a_b_c' }]);
    expect(parseInline('`**x**`')).toEqual([{ text: '**x**', code: true }]);
  });
  it('preserves link and image destinations and identifies the supported inline styles', () => {
    expect(rows('[https://a.test](https://a.test)')).toEqual(['https://a.test']);
    expect(rows('<person@example.test>')).toEqual(['person@example.test']);
    expect(parseInline('~~strike~~')).toEqual([{ text: 'strike', strike: true }]);
    expect(parseInline('\\*literal\\*')).toEqual([{ text: '*literal*' }]);
    expect(parseInline('![cat](https://a.test/cat)')).toEqual([
      { text: '[image: cat] (https://a.test/cat)', dim: true, linkURL: 'https://a.test/cat' },
    ]);
  });
  it('resolves markup inside a grapheme to one consistent style', () => {
    const line = layoutMarkdown(parseMarkdown('x**\u0301**y'), 10)[0];
    expect(line?.text).toBe('x\u0301y');
    expect(line?.spans).toEqual([{ text: 'x\u0301y' }]);
  });
  it('keeps nested emphasis when the closer is a triple delimiter', () => {
    expect(parseInline('**bold *italic***')).toEqual([
      { text: 'bold ', strong: true },
      { text: 'italic', strong: true, emphasis: true },
    ]);
    expect(parseInline('*italic **bold***')).toEqual([
      { text: 'italic ', emphasis: true },
      { text: 'bold', emphasis: true, strong: true },
    ]);
  });
  it('keeps unsupported link forms completely literal', () => {
    for (const value of ['[**label**](url "title")', '[**label**][reference]']) {
      expect(parseInline(value)).toEqual([{ text: value }]);
    }
  });
  it('honors fences and keeps invalid fences literal', () => {
    expect(rows('  ~~~ rust\n    x\n ~~~')).toEqual(['rust', '│   x']);
    expect(rows('```bad`info')).toEqual(['```bad`info']);
    expect(rows('````\nx\n```\ny\n````')).toEqual(['│ x', '│ ```', '│ y']);
  });
  it('preserves unsupported structures and recognizes later setext pairs', () => {
    expect(rows('first\nTitle\n---')).toEqual(['first', 'Title', '---']);
    expect(rows('<div>**literal**</div>')).toEqual(['<div>**literal**</div>']);
    expect(rows('<https://example.test>')).toEqual(['https://example.test']);
    expect(rows('[name]: https://example.test/**literal**')).toEqual([
      '[name]: https://example.test/**literal**',
    ]);
  });
  it('expands tabs at display stops in a grid and keeps all rows aligned', () => {
    const lines = rows('| A | B |\n| --- | --- |\n| x\ty | z |');
    expect(lines[0]?.startsWith('┌')).toBe(true);
    expect(new Set(lines.map(displayWidth)).size).toBe(1);
    expect(lines.join('')).not.toContain('\t');
    expect(lines.join('')).toContain('x     y');
  });
  it('enforces the pending table source limit at the exact UTF-16 boundary', () => {
    const prefix = '| h |\n| --- |\n| ';
    const suffix = ' |';
    const full = prefix + 'x'.repeat(65536 - prefix.length - suffix.length) + suffix;
    expect(full.length).toBe(65536);
    expect(parseMarkdown(full)[0]?.kind).toBe('table');
    expect(parseMarkdown(full.replace(suffix, `x${suffix}`))[0]?.kind).toBe('literal');
  });
  it('honors hard breaks and matching fence lengths', () => {
    expect(rows('one  \ntwo')).toEqual(['one', 'two']);
    expect(rows('one\\\ntwo')).toEqual(['one', 'two']);
    expect(rows('> '.repeat(8) + 'x')).toEqual(['│ '.repeat(8) + 'x']);
  });
  it('does not lose text for pathological unmatched delimiters', () => {
    const input = '['.repeat(10000) + 'x';
    expect(
      parseInline(input)
        .map((span) => span.text)
        .join(''),
    ).toBe(input);
  });
  it('matches plain wrapping for literal text, tabs, and blank logical lines', () => {
    for (const source of [
      '',
      ' leading  trailing ',
      '1234567X\tz',
      'a\tb\n',
      '\n\n',
      '界 👩‍💻\tx',
      ' a  b   c ',
    ]) {
      for (const width of [1, 2, 6, 8, 80]) {
        const literal: MarkdownBlock[] = [{ kind: 'literal', source, text: source }];
        expect(
          layoutMarkdown(literal, width).map((row) => row.text),
          `${JSON.stringify(source)} at ${width}`,
        ).toEqual(wrapText(source, width));
        const styled: MarkdownBlock[] = [
          { kind: 'paragraph', source, text: source, spans: [{ text: source, strong: true }] },
        ];
        expect(layoutMarkdown(styled, width).map((row) => row.text)).toEqual(
          wrapText(source, width),
        );
      }
    }
  });
  it('expands tabs before wrapping, accounting for the quote prefix', () => {
    expect(rows('> 1234567X\tz', 6)).toEqual(['│ 1234', '│ 567X', '│     ', '│   z']);
  });
  it('never emits a row wider than the available width, including narrow prefixes', () => {
    for (const source of ['> 界', '- 👩‍💻 test', '```\n界\n```', 'a\tb', 'x**́**y']) {
      for (let width = 1; width <= 12; width++) {
        const lines = layoutMarkdown(parseMarkdown(source), width);
        for (const line of lines) {
          expect(displayWidth(line.text), `${source} at ${width}`).toBeLessThanOrEqual(width);
          expect(line.spans.map((span) => span.text).join('')).toBe(line.text);
        }
      }
    }
  });
});
