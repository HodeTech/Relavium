import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The scanners' lookaheads go through `Segments.find` and `Segments.lineEnd`, which remember what they searched and
 * charge what they read (ADR-0144). A scanner that searched the whole text with its own `indexOf` would read it again
 * on every miss, which is how a scan turns quadratic, and the work counter would not see it. This guard fails on that
 * shape in any scanner source, so the counter's proof of linearity stays whole.
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
