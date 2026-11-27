import { describe, expect, it } from 'vitest';

import { startsWithMarginWord } from './chat-grid.js';
import { transcriptRows } from './chat-projection.js';
import { chatGrid } from './chat-grid.js';
import { dropOrphanMarks, dropScreenFillers, screenPieces, screenText } from './screen-text.js';
import { displayWidth, expandTabs, wrapText, wrapWords } from './viewport.js';

/**
 * The screen's filter is LINEAR (MVP-11 unit 9, review round 2, C2-1): the first version had a lookbehind (`(?<=🏴[tags]*)`) tried at every
 * position, quadratic on a run of tag characters: 64,000 of them stalled the event loop for 28 s on the real binary (a reply or an echoed tool
 * result can carry such a run: "ASCII smuggling" uses them). This file holds every function the unit added on the screen's path to a bound on a
 * 64,000-character hostile run of each class, and the forward rewrite to the old filter's answers where the classes are the old ones.
 */

const c = (code: number): string => String.fromCodePoint(code);
const N = 64_000;
/** The bound for one call on N characters: two orders above the measured cost on an idle machine, three below the defect. */
const BOUND_MS = 250;

/** The least of three runs of `run`, in milliseconds: the work's own cost, not a busy machine's (the suites run in parallel). */
function timed(run: () => unknown): number {
  let least = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = performance.now();
    run();
    least = Math.min(least, performance.now() - start);
  }
  return least;
}

/** A run of N characters of each hostile class the review measured or the code handles specially. */
const RUNS: readonly (readonly [string, string])[] = [
  ['tag characters', c(0xe0041).repeat(N)],
  ['tags after a black flag', `${c(0x1f3f4)}${c(0xe0041).repeat(N)}`],
  ['tags then a letter', `${c(0xe0041).repeat(N)}x`],
  ['Hangul fillers', c(0x115f).repeat(N)],
  ['presentation selectors', c(0xfe0f).repeat(N)],
  ['letter + presentation selector', `a${c(0xfe0f)}`.repeat(N / 2)],
  ['emoji + presentation selector', `${c(0x2764)}${c(0xfe0f)}`.repeat(N / 2)],
  ['zero width joiners', c(0x200d).repeat(N)],
  ['orphan combining marks', c(0x0301).repeat(N)],
  ['marks on a letter', `x${c(0x0301).repeat(N)}`],
  ['skin tones', c(0x1f3fd).repeat(N / 2)],
  ['skin tones on a letter', `x${c(0x1f3fd).repeat(N / 2)}`],
  ['Thai AM', `${c(0x0e01)}${c(0x0e33)}`.repeat(N / 2)],
  ['regional indicators', `${c(0x1f1e6)}${c(0x1f1e7)}`.repeat(N / 4)],
  ['lone surrogates', String.fromCharCode(0xd800).repeat(N)],
  ['prepended concatenation marks', c(0x0600).repeat(N)],
  ['tabs', '\t'.repeat(N)],
  ['spaces', ' '.repeat(N)],
  ['one long word', 'x'.repeat(N)],
];

describe('every screen function is linear on a hostile run (64,000 characters of each class)', () => {
  it.each(RUNS)('%s', (_name, run) => {
    for (const [label, work] of [
      ['screenText', () => screenText(run)],
      ['dropScreenFillers', () => dropScreenFillers(run)],
      ['dropOrphanMarks', () => dropOrphanMarks(run)],
      ['screenPieces', () => screenPieces([{ text: run }, { text: run.slice(0, 1000) }])],
      ['startsWithMarginWord', () => startsWithMarginWord(run)],
      ['startsWithMarginWord after the run', () => startsWithMarginWord(`${run}you`)],
      ['displayWidth', () => displayWidth(run)],
      ['expandTabs', () => expandTabs(run)],
      ['wrapWords', () => wrapWords(run, 68)],
      ['wrapWords, the hanging wrap', () => wrapWords(run, 68, true)],
      ['wrapText, the hanging wrap', () => wrapText(run, 68, true)],
    ] as const) {
      const ms = timed(work);
      expect(ms, `${label}: ${ms.toFixed(1)} ms`).toBeLessThan(BOUND_MS);
    }
  });

  it('one grapheme cluster of 32,000 skin tones on a letter, and one of 64,000 marks: filtered and measured', () => {
    for (const cluster of [`x${c(0x1f3fd).repeat(32_000)}`, `x${c(0x0301).repeat(N)}`]) {
      expect(timed(() => screenText(cluster))).toBeLessThan(BOUND_MS);
      expect(timed(() => displayWidth(screenText(cluster)))).toBeLessThan(BOUND_MS);
    }
  });

  it.each([true, false])(
    'a reply with a 64,000-tag run is laid out on the grid in bounded time (colour %s)',
    (color) => {
      const text = `Here is the answer. ${c(0xe0041).repeat(N)} and the rest of the reply.`;
      const ms = timed(() => transcriptRows([{ role: 'assistant', text }], chatGrid(80), color));
      expect(ms, `${ms.toFixed(1)} ms`).toBeLessThan(2_000);
    },
  );
});

describe('the forward filter gives the old filter’s answers on the old classes', () => {
  // The first version's pattern, kept here as the oracle (it is quadratic only on long tag runs; these strings are short).
  const ZWNJ = c(0x200c);
  const ZWJ = c(0x200d);
  const VS15 = c(0xfe0e);
  const VS16 = c(0xfe0f);
  const OLD = new RegExp(
    `(?!${ZWNJ}|${ZWJ}|${VS15}|${VS16})(?!(?<=${c(0x1f3f4)}[${c(0xe0020)}-${c(0xe007f)}]*)[${c(0xe0020)}-${c(0xe007f)}])\\p{Default_Ignorable_Code_Point}`,
    'gu',
  );
  /** The old classes: the flag, tags, the kept joiners and VS15, default-ignorable fillers, letters and spaces (no VS16, tone, surrogate, Cf). */
  const ALPHABET = [
    c(0x1f3f4),
    c(0xe0041),
    c(0xe0067),
    c(0xe007f),
    c(0xe0001),
    ZWNJ,
    ZWJ,
    VS15,
    c(0x115f),
    c(0x3164),
    c(0xffa0),
    c(0x00ad),
    c(0x034f),
    c(0x200b),
    c(0x2060),
    c(0xfe00),
    c(0xe0100),
    'a',
    ' ',
  ];

  it('200,000 random strings: no difference', () => {
    let state = 0x2b9e1c47;
    const next = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let differences = 0;
    let first = '';
    for (let index = 0; index < 200_000; index += 1) {
      let text = '';
      const length = 1 + Math.floor(next() * 12);
      for (let step = 0; step < length; step += 1)
        text += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? '';
      const old = text.replace(OLD, '');
      if (dropScreenFillers(text) !== old) {
        differences += 1;
        if (first === '') first = JSON.stringify([...text].map((ch) => ch.codePointAt(0)));
      }
    }
    expect(differences, first).toBe(0);
  });
});
