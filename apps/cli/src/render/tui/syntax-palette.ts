import type { SyntaxToken } from '../markdown/types.js';

/** The ink `<Text>` props a syntax class is drawn with. */
export interface SyntaxStyle {
  readonly color?: 'magenta' | 'green' | 'yellow' | 'cyan' | 'red';
  readonly bold?: true;
  readonly dimColor?: true;
}

/**
 * The colour of each syntax class (ADR-0144). Only five named ANSI colours, bold and dim, so the terminal's own palette
 * decides the exact shade and a light or a dark theme needs no detection. Blue and the bright variants are left out on
 * purpose: blue is the weakest contrast on a dark background, and the bright shades are the weakest on a light one.
 * A comment is dim, not a grey, because a grey is a palette entry that some themes draw as the background.
 * Every class has a place here: the type is a complete record, so a new class cannot be left without a style.
 */
export const SYNTAX_PALETTE: Readonly<Record<SyntaxToken, SyntaxStyle>> = Object.freeze({
  text: {},
  keyword: { color: 'magenta' },
  string: { color: 'green' },
  number: { color: 'yellow' },
  constant: { color: 'yellow' },
  comment: { dimColor: true },
  type: { color: 'cyan' },
  function: { bold: true },
  property: { color: 'cyan' },
  variable: { color: 'cyan' },
  meta: { color: 'yellow' },
  inserted: { color: 'green' },
  deleted: { color: 'red' },
  hunk: { color: 'cyan' },
});

export function syntaxStyle(token: SyntaxToken): SyntaxStyle {
  return SYNTAX_PALETTE[token];
}
