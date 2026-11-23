import { describe, expect, it } from 'vitest';

import { SYNTAX_PALETTE } from '../../tui/syntax-palette.js';
import { scanLanguage } from './index.js';
import { HIGHLIGHT_LANGUAGES } from './languages.js';
import { Segments } from './segments.js';

/** Pieces that stress every scanner: delimiters, escapes, openers that never close, and awkward Unicode. */
const FRAGMENTS = [
  "'",
  '"',
  '`',
  '/',
  '*',
  '#',
  '{',
  '}',
  '${',
  '\\',
  '\n',
  '\n',
  ' ',
  ' ',
  '\t',
  '$',
  '<',
  '>',
  '-',
  '@',
  '(',
  ')',
  '[',
  ']',
  ':',
  ';',
  '=',
  '!',
  '&',
  '|',
  '0',
  '1',
  '.',
  'e',
  'a',
  'Foo',
  'if',
  'true',
  'null',
  '😀',
  'é',
  '́',
  '‍',
  '---',
  '+++',
  '@@',
  '"""',
  "'''",
  '/*',
  '*/',
  '<!--',
  '-->',
  'r#"',
  '\r',
  '%',
  '+',
  ',',
  '?',
  '~',
  '^',
] as const;

/** A small seeded generator, so a failing text can be reproduced from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(random: () => number): string {
  const count = 1 + Math.floor(random() * 120);
  let text = '';
  for (let index = 0; index < count; index++) {
    text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? '';
  }
  return text;
}

const KNOWN_TOKENS = new Set(Object.keys(SYNTAX_PALETTE));

/** Run a scanner directly, so a fault is seen and not swallowed, and report what it did. */
function scan(
  languageId: string,
  text: string,
): { runs: ReturnType<typeof scanLanguage>; work: number } {
  const language = HIGHLIGHT_LANGUAGES.find((candidate) => candidate.id === languageId);
  if (!language) throw new Error(`no language ${languageId}`);
  const out = new Segments(text, 8 * text.length + 256);
  language.scan(text, out);
  return { runs: out.finish(), work: out.work };
}

/**
 * What a scan may cost: its own steps and the characters its lookaheads read, which `Segments` counts together. The
 * scanners are held to eight per character (a hard budget that turns a fault into "not highlighted"); the tests hold
 * them to four, which the worst input found so far stays well under.
 */
const WORK_PER_CHARACTER = 4;

function expectSound(languageId: string, text: string): void {
  const { runs, work } = scan(languageId, text);
  expect(runs.map((run) => run.text).join('')).toBe(text); // nothing lost, repeated or reordered
  for (const [index, run] of runs.entries()) {
    expect(run.text.length).toBeGreaterThan(0);
    expect(KNOWN_TOKENS.has(run.token)).toBe(true);
    if (index > 0) {
      expect(run.token).not.toBe(runs[index - 1]?.token); // neighbours with one class are merged
      const before = runs[index - 1]?.text.at(-1)?.charCodeAt(0) ?? 0;
      const after = run.text.charCodeAt(0);
      // a boundary never falls inside a surrogate pair: a character is never split between two classes
      expect(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff).toBe(
        false,
      );
    }
  }
  expect(work).toBeLessThanOrEqual(WORK_PER_CHARACTER * text.length + 16);
}

describe('every scanner, on any text', () => {
  for (const language of HIGHLIGHT_LANGUAGES) {
    it(`${language.id}: the runs join to the text, are classed, and cost at most four steps a character`, () => {
      const random = mulberry32(0x5eed + language.id.length);
      for (let index = 0; index < 300; index++) expectSound(language.id, randomText(random));
    });

    it(`${language.id}: every prefix of a text is sound, as a streamed answer shows it`, () => {
      const random = mulberry32(0xbeef + language.id.length);
      const text = randomText(random) + randomText(random);
      for (let end = 0; end <= text.length; end++) expectSound(language.id, text.slice(0, end));
    });
  }
});

describe('adversarial text of the size limit', () => {
  const SIZE = 65_536;
  const patterns: readonly (readonly [string, string])[] = [
    ['unclosed quotes', '\'"'.repeat(SIZE / 2)],
    ['template holes', '`${'.repeat(SIZE / 3)],
    ['comment openers', '/*'.repeat(SIZE / 2)],
    ['open tags', '<a '.repeat(SIZE / 3)],
    ['brackets', '[['.repeat(SIZE / 2)],
    ['dashes', '-'.repeat(SIZE)],
    ['backslashes', '\\'.repeat(SIZE)],
    ['keys', 'a:'.repeat(SIZE / 2)],
    ['blocks', '{a:'.repeat(SIZE / 3)],
    ['hunks', '@@\n'.repeat(SIZE / 3)],
    ['hashes', '# '.repeat(SIZE / 2)],
    ['substitutions', '$('.repeat(SIZE / 2)],
    ['lines of a quote', '"\n'.repeat(SIZE / 2)],
    ['blanks', ' '.repeat(SIZE)],
    ['apostrophes', "'".repeat(SIZE)],
    ['assignments', '=\n'.repeat(SIZE / 2)],
    ['angle brackets', '<>'.repeat(SIZE / 2)],
    ['quote and colon', '":'.repeat(SIZE / 2)],
    ['declarations', 'a{b:c'.repeat(SIZE / 5)],
    ['dollar braces', '${'.repeat(SIZE / 2)],
    ['open brackets per line', '[\n'.repeat(SIZE / 2)],
    ['flow lines with no colon', '[a,a,a]\n'.repeat(SIZE / 8)],
    ['attributes with no close', '#[a\n'.repeat(SIZE / 4)],
    ['include with no close', '#include <\n'.repeat(SIZE / 11)],
    ['regex openers', '(/['.repeat(SIZE / 3)],
    ['arithmetic openers', '$(('.repeat(SIZE / 3)],
    ['comment openers in tags', '<!--'.repeat(SIZE / 4)],
    ['raw string openers', 'r#"'.repeat(SIZE / 3)],
  ];

  for (const language of HIGHLIGHT_LANGUAGES) {
    it(`${language.id}: no pattern costs more than four steps a character, or a second`, () => {
      for (const [name, text] of patterns) {
        const started = performance.now();
        const { runs, work } = scan(language.id, text);
        const elapsed = performance.now() - started;
        expect(runs.map((run) => run.text).join(''), name).toBe(text);
        expect(work, name).toBeLessThanOrEqual(WORK_PER_CHARACTER * text.length + 16);
        expect(elapsed, name).toBeLessThan(1000); // a coarse net only: the work counter is the proof
      }
    });

    it(`${language.id}: four times the text costs four times the work, not sixteen`, () => {
      // The counter charges every step and every character a lookahead reads, so this is deterministic: a lookahead
      // that fails again and again (a quadratic scan) would show here as a ratio near sixteen, not four.
      for (const [name, text] of patterns) {
        const small = scan(language.id, text.slice(0, SIZE / 4)).work;
        const large = scan(language.id, text).work;
        expect(large, name).toBeLessThanOrEqual(4.5 * small + 64);
      }
    });
  }
});
