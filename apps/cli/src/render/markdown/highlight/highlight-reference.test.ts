import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SYNTAX_PALETTE, type SyntaxStyle } from '../../tui/syntax-palette.js';
import { MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINE } from './index.js';
import { HIGHLIGHT_LANGUAGES } from './languages.js';

/**
 * The reference's "Syntax highlighting" tables are compared with the code in BOTH directions, so a language, an alias,
 * a class or a colour changed in one place and not the other fails here. The reference is read from
 * `docs/reference/cli/markdown-rendering.md`; nothing is copied into this file.
 */
const REFERENCE = fileURLToPath(
  new URL('../../../../../../docs/reference/cli/markdown-rendering.md', import.meta.url),
);

function sectionLines(heading: string): string[] {
  const lines = readFileSync(REFERENCE, 'utf8').split('\n');
  const from = lines.findIndex((line) => line.trimEnd() === heading);
  if (from < 0) throw new Error(`the reference has no "${heading}" section`);
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((line) => line.startsWith('#'));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The data rows of the first table in `lines`, as trimmed cells. */
function tableRows(lines: readonly string[]): string[][] {
  return lines
    .filter((line) => line.startsWith('|'))
    .slice(2) // the header and its rule
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

/** Everything between a pair of backticks in `cell`. */
function ticks(cell: string | undefined): string[] {
  return [...(cell ?? '').matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? '');
}

function describeStyle(style: SyntaxStyle): string {
  if (style.color !== undefined) return style.color;
  if (style.bold === true) return 'bold';
  return style.dimColor === true ? 'dim' : 'default';
}

describe('the reference lists the languages the highlighter reads', () => {
  const rows = tableRows(sectionLines('### Languages'));

  it('has one row for each family of the code, and none for a family the code lacks', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => ticks(row[0])[0]).sort()).toEqual(
      HIGHLIGHT_LANGUAGES.map((language) => language.id).sort(),
    );
  });

  it('lists exactly the info strings the code accepts for each family', () => {
    for (const row of rows) {
      const id = ticks(row[0])[0];
      const language = HIGHLIGHT_LANGUAGES.find((candidate) => candidate.id === id);
      expect(ticks(row[1]).sort(), id).toEqual([...(language?.aliases ?? [])].sort());
    }
  });

  it('gives no info string to two families', () => {
    const all = HIGHLIGHT_LANGUAGES.flatMap((language) => language.aliases);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('the reference lists the classes and the colours the palette draws', () => {
  const rows = tableRows(sectionLines('### Classes and colours'));

  it('has one row for each class of the palette, and none for a class it lacks', () => {
    expect(rows.map((row) => ticks(row[0])[0]).sort()).toEqual(Object.keys(SYNTAX_PALETTE).sort());
  });

  it('names the colour, or bold, or dim, or the default, that the palette draws each class in', () => {
    for (const row of rows) {
      const token = ticks(row[0])[0] ?? '';
      const style = (SYNTAX_PALETTE as Readonly<Record<string, SyntaxStyle>>)[token];
      expect(row[1], token).toBe(describeStyle(style ?? {}));
    }
  });
});

describe('the reference states the limits the code enforces', () => {
  it('names the size and the line limit by their value', () => {
    const text = sectionLines('### Limits and fallbacks').join('\n');
    expect(text).toContain(MAX_HIGHLIGHT_CHARS.toLocaleString('en-US'));
    expect(text).toContain(MAX_HIGHLIGHT_LINE.toLocaleString('en-US'));
  });
});
