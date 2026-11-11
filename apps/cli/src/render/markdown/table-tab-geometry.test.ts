import { describe, expect, it, vi } from 'vitest';
import { displayWidth } from '../tui/viewport.js';
import { layoutMarkdown } from './layout.js';
import { parseMarkdown } from './parser.js';
import type { MarkdownBlock } from './types.js';

function grid(
  rows: string[][],
  alignment: 'left' | 'right' | 'center',
  extra: Partial<MarkdownBlock> = {},
) {
  return layoutMarkdown(
    [
      {
        kind: 'table',
        text: '',
        source: 'literal fallback',
        rows,
        align: (rows[0] ?? []).map(() => alignment),
        ...extra,
      },
    ],
    120,
  );
}

describe('table tab geometry', () => {
  it.each([
    ['left', 2, 8],
    ['right', 16, 24],
    ['center', 7, 16],
  ] as const)('expands tabs at their displayed columns with %s alignment', (alignment, x, y) => {
    const row = grid([['abcdefghijklmnop'], ['x\tY']], alignment)[3]?.text ?? '';
    expect(row.indexOf('x')).toBe(x);
    expect(row.indexOf('Y')).toBe(y);
  });
  it('falls back literally when right aligned tab endpoints cannot agree', () => {
    expect(grid([['header'], ['x\tY'], ['x\tYY']], 'right').map((row) => row.text)).toEqual([
      'literal fallback',
    ]);
  });
  it('uses preceding column widths and continuation prefixes for every content row', () => {
    const result = grid(
      [
        ['a', 'abcdefghijklmnop'],
        ['b', 'x\tY'],
      ],
      'right',
      { prefix: '> - ', continuation: '>   ' },
    );
    const row = result[3]?.text ?? '';
    expect(row.startsWith('>   │')).toBe(true);
    expect(row.indexOf('Y') % 8).toBe(0);
    expect(row.indexOf('x')).toBeLessThan(row.indexOf('Y'));
  });
  it('accounts for differing first and continuation prefix widths when fitting', () => {
    const block: MarkdownBlock = {
      kind: 'table',
      source: 'literal fallback',
      text: '',
      prefix: '>',
      continuation: '       ',
      rows: [['abc']],
    };
    expect(layoutMarkdown([block], 9).map((row) => row.text)).toEqual(['literal ', 'fallback']);
  });
  it('retains inline styles, unicode, and exact link targets after expansion', () => {
    const rows = grid(
      [['abcdefghijklmnop'], ['**界**\t[label](https://example.test/**x**)']],
      'center',
    );
    const body = rows[3];
    expect(body?.text).toContain('https://example.test/**x**');
    expect(body?.spans.some((span) => span.strong && span.text === '界')).toBe(true);
    expect(body?.spans.some((span) => span.linkURL === 'https://example.test/**x**')).toBe(true);
  });
  it('preserves ordinary table output and literal fallback at narrow widths', () => {
    const source = '| a | b |\n| --- | ---: |\n| x | y |';
    expect(layoutMarkdown(parseMarkdown(source), 80).map((row) => row.text)).toEqual([
      '┌───┬───┐',
      '│ a │ b │',
      '├───┼───┤',
      '│ x │ y │',
      '└───┴───┘',
    ]);
    expect(
      layoutMarkdown(parseMarkdown(source), 3).every((row) => displayWidth(row.text) <= 3),
    ).toBe(true);
  });
  it('finds the minimal valid width for many tabbed cell combinations', () => {
    for (const alignment of ['left', 'right', 'center'] as const) {
      for (let header = 1; header <= 24; header++) {
        for (let lead = 1; lead <= 4; lead++) {
          const row =
            grid([['h'.repeat(header)], ['x'.repeat(lead) + '\tY']], alignment)[3]?.text ?? '';
          expect(row.indexOf('Y') % 8).toBe(0);
          const innerWidth = row.length - 4;
          const minimum = Array.from({ length: 80 }, (_, width) => width).find((width) => {
            if (width < header) return false;
            for (let before = 0; before <= width; before++) {
              const afterLead = 2 + before + lead;
              const measured = lead + (8 - (afterLead % 8)) + 1;
              const padding = width - measured;
              if (padding < 0) continue;
              const required =
                alignment === 'left'
                  ? 0
                  : alignment === 'right'
                    ? padding
                    : Math.floor(padding / 2);
              if (before === required) return true;
            }
            return false;
          });
          expect(innerWidth).toBe(minimum);
          const x = row.indexOf('x') - 2;
          const trailing = innerWidth - x - (row.indexOf('Y') - row.indexOf('x') + 1);
          expect(alignment === 'left' ? x : alignment === 'right' ? trailing : trailing - x).toBe(
            alignment === 'center'
              ? (innerWidth - (row.indexOf('Y') - row.indexOf('x') + 1)) % 2
              : 0,
          );
        }
      }
    }
  });
  it('keeps grapheme segmentation work linear as tabbed source grows', () => {
    const spy = vi.spyOn(Intl.Segmenter.prototype, 'segment');
    const measure = (length: number): number => {
      spy.mockClear();
      grid(
        [['h'.repeat(16)], ...Array.from({ length: 24 }, () => ['x'.repeat(length) + '\tY'])],
        'center',
      );
      return spy.mock.calls.reduce((sum, [text]) => sum + String(text).length, 0);
    };
    try {
      const small = measure(128);
      const large = measure(256);
      expect(small).toBeGreaterThan(128 * 24);
      expect(large).toBeLessThan(small * 2.2);
    } finally {
      spy.mockRestore();
    }
  });
});
