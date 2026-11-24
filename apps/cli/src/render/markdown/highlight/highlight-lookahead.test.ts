import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { highlightCode, MAX_HIGHLIGHT_LINE } from './index.js';
import { HIGHLIGHT_LANGUAGES } from './languages.js';
import { Segments } from './segments.js';

/**
 * The scanners' lookaheads go through `Segments.find` and `Segments.lineEnd`, which remember what they searched and
 * charge what they read (ADR-0144). A scanner that searched the whole text with its own `indexOf` would read it again
 * on every miss, which is how a scan turns quadratic, and the work counter would not see it. This guard fails on that
 * shape in any scanner source, so the counter's proof of linearity stays whole.
 *
 * The bounded lookaheads that read ahead by hand (a colon after a string, the 512 characters after a CSS property name,
 * the key of a YAML line, the blanks before a TOML `=`) cannot go through `find`, because they stop at a character
 * class and not at a delimiter. They charge what they read themselves with `Segments.charge`; the second block below
 * holds each one to it, so the counter's claim that it sees every character a lookahead reads is a test and not a hope.
 */
const DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const SCANNERS = readdirSync(DIRECTORY).filter(
  (name) => name.endsWith('.ts') && !name.includes('.test.') && name !== 'segments.ts',
);

/** A search over the whole text: `source.indexOf(`, `.lastIndexOf(`, `.search(`, `.match(` and the like. */
const WHOLE_TEXT_SEARCH = /\bsource\.(indexOf|lastIndexOf|search|match|matchAll|split)\(/u;

describe('no scanner searches the whole text on its own', () => {
  it('finds the scanner sources it is meant to guard', () => {
    expect(SCANNERS).toEqual(
      expect.arrayContaining(['generic.ts', 'shell.ts', 'yaml.ts', 'toml.ts', 'markup.ts']),
    );
  });

  for (const name of SCANNERS) {
    it(`${name} reads ahead only through Segments`, () => {
      const lines = readFileSync(`${DIRECTORY}${name}`, 'utf8').split('\n');
      const offending = lines
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(
          ({ line }) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'),
        )
        .filter(({ line }) => WHOLE_TEXT_SEARCH.test(line));
      expect(
        offending.map(({ number, line }) => `${name}:${String(number)} ${line.trim()}`),
      ).toEqual([]);
    });
  }
});

/** The work one scan counted, under a budget no scan reaches, so the number is what it read and not where it stopped. */
function workOf(languageId: string, text: string): number {
  const language = HIGHLIGHT_LANGUAGES.find((candidate) => candidate.id === languageId);
  if (!language) throw new Error(`no language ${languageId}`);
  const out = new Segments(text, Number.MAX_SAFE_INTEGER);
  language.scan(text, out);
  return out.work;
}

describe('a lookahead that reads ahead by hand charges what it read (ADR-0144)', () => {
  /**
   * Each case is a text whose cost is dominated by one hand-written lookahead, and the least work per character the scan
   * must count for it. Every minimum sits above what the scan counts when that lookahead does not charge (a step a
   * character, or about that), and below what it counts when it does, so removing one charge fails its case.
   */
  const CASES: readonly {
    readonly language: string;
    readonly name: string;
    readonly text: string;
    readonly perCharacter: number;
  }[] = [
    {
      language: 'css',
      name: 'a property name, 100 times, that looks 512 characters ahead for its `;`',
      text: `{${'/**/a:'.repeat(100)}`,
      perCharacter: 20,
    },
    {
      language: 'css',
      name: 'a name followed by 400 blanks before its colon',
      text: `{a${' '.repeat(400)}:`,
      perCharacter: 1.5,
    },
    {
      language: 'json',
      name: 'a string followed by 200 blanks that the colon search looks past, 50 times',
      text: `"k"${' '.repeat(200)}`.repeat(50),
      perCharacter: 1.5,
    },
    {
      language: 'yaml',
      name: 'lines of plain words with no colon, whose key search reads each to its end',
      text: `${'word '.repeat(40)}\n`.repeat(50),
      perCharacter: 1.5,
    },
    {
      language: 'yaml',
      name: 'a flow sequence of scalars, each searched for a colon',
      text: `[${'ab,'.repeat(300)}]`,
      perCharacter: 3.2,
    },
    {
      language: 'toml',
      name: 'an inline table whose keys look past their blanks for an `=`',
      text: `{${'a = 1, '.repeat(100)}}`,
      perCharacter: 2.2,
    },
    {
      language: 'ini',
      name: 'keys followed by 100 blanks before their `=`',
      text: `k${' '.repeat(100)}= v\n`.repeat(50),
      perCharacter: 1.8,
    },
  ];

  for (const { language, name, text, perCharacter } of CASES) {
    it(`${language}: ${name}`, () => {
      expect(workOf(language, text)).toBeGreaterThanOrEqual(perCharacter * text.length);
    });
  }

  it('turns a block whose lookaheads cost more than the budget into a plain one, not a slow one', () => {
    // 49 steps a character against a budget of eight: the scanner throws and the caller does not highlight the block. The line
    // stays under the line limit, so it is the budget that refuses it and not the limit.
    const hostile = `{${'/**/a:'.repeat(600)}`;
    expect(hostile.length).toBeLessThan(MAX_HIGHLIGHT_LINE);
    expect(highlightCode(hostile, 'css')).toBeUndefined();
    // An ordinary stylesheet reads each declaration's value once to find its `;`, and stays far under the budget.
    const sheet = 'a { color: red; margin: 0 auto; }\nb:hover { top: 1px }\n'.repeat(40);
    expect(highlightCode(sheet, 'css')).toBeDefined();
  });
});
