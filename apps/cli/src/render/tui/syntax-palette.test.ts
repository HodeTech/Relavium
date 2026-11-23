import { describe, expect, it } from 'vitest';

import { SYNTAX_PALETTE, syntaxStyle } from './syntax-palette.js';

const ALLOWED_COLORS = new Set(['magenta', 'green', 'yellow', 'cyan', 'red']);

describe('the syntax palette (ADR-0144)', () => {
  it('uses only five named ANSI colours, bold and dim: the terminal decides the shade, so no theme detection is needed', () => {
    for (const [token, style] of Object.entries(SYNTAX_PALETTE)) {
      if (style.color !== undefined) expect(ALLOWED_COLORS.has(style.color), token).toBe(true);
      expect(
        Object.keys(style).every((key) => ['color', 'bold', 'dimColor'].includes(key)),
        token,
      ).toBe(true);
    }
  });

  it('leaves out blue, the bright shades and grey, whose contrast fails on a dark or a light theme', () => {
    const colors = Object.values(SYNTAX_PALETTE).map((style) => style.color ?? '');
    for (const color of colors) {
      expect(color).not.toMatch(/blue|bright|gr[ae]y|black|white/iu);
      expect(color).not.toMatch(/^#|^rgb/u);
    }
  });

  it('draws a comment dim and nothing else, a call bold and nothing else, and plain code with no style', () => {
    expect(syntaxStyle('comment')).toEqual({ dimColor: true });
    expect(syntaxStyle('function')).toEqual({ bold: true });
    expect(syntaxStyle('text')).toEqual({});
  });

  it('draws an added line green, a removed line red and a hunk header cyan, as the approval card draws a diff', () => {
    expect(syntaxStyle('inserted')).toEqual({ color: 'green' });
    expect(syntaxStyle('deleted')).toEqual({ color: 'red' });
    expect(syntaxStyle('hunk')).toEqual({ color: 'cyan' });
  });

  it('gives a string, a keyword and a number three different colours, so the three read apart', () => {
    const colors = [
      syntaxStyle('string').color,
      syntaxStyle('keyword').color,
      syntaxStyle('number').color,
    ];
    expect(new Set(colors).size).toBe(3);
  });
});
