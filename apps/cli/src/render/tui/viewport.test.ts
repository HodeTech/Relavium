import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

/** What ink measures with (`ink/build/output.js` imports `string-width`). The tests compare against IT, not against
 *  `displayWidth`, so they still mean something if `displayWidth` is ever re-implemented. */
const inkWidth = (s_: string): number => stringWidth(s_);

import {
  clampOffset,
  displayWidth,
  maxOffset,
  windowLines,
  wrapLogicalLine,
  wrapText,
} from './viewport.js';

describe('displayWidth (2.6.F Step 4b, ADR-0068 §c)', () => {
  it('counts ASCII / Latin as one cell each', () => {
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('a b')).toBe(3);
    expect(displayWidth('Türkçe')).toBe(6); // precomposed ü is one code point, width 1
  });

  it('counts East-Asian wide + fullwidth glyphs as two cells', () => {
    expect(displayWidth('中')).toBe(2); // CJK ideograph
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('ＡＢ')).toBe(4); // fullwidth Latin
    expect(displayWidth('한글')).toBe(4); // Hangul syllables
    expect(displayWidth('あ')).toBe(2); // Hiragana
  });

  it('counts an astral emoji as two cells (one code point, not two UTF-16 units)', () => {
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('a🚀b')).toBe(4);
  });

  it('counts combining marks + zero-width joiners as zero', () => {
    expect(displayWidth('é')).toBe(1); // e + combining acute → one cell
    expect(displayWidth('​')).toBe(0); // zero-width space
    expect(displayWidth('a‍b')).toBe(2); // ZWJ contributes nothing
    expect(displayWidth('﻿')).toBe(0); // BOM
    // A LONE regional indicator is not an RGI emoji (a flag needs a pair), so `string-width` — and therefore ink —
    // gives it the East-Asian width of U+1F1F9, which is Neutral: 1. The old hand-rolled table said 2.
    expect(displayWidth('🇹️')).toBe(1);
  });

  it('counts control chars as zero (defensive — they are sanitized before display)', () => {
    expect(displayWidth('a\tb')).toBe(2);
    expect(displayWidth('\x1b[31m')).toBe(4); // ESC(0) + '[31m' (4) — a raw escape shows as its printable tail width
  });

  it('measures composed emoji clusters as ONE 2-cell glyph — never under- or over-counting (Step-4b-2 harden)', () => {
    // These are exactly the clusters a per-code-point sum got wrong; a grapheme-aware count must never under-count
    // (an under-count would make a wrapped line wider than cols → ink re-wraps → the viewport clips the tail).
    expect(displayWidth('1\u{FE0F}\u{20E3}')).toBe(2); // enclosing keycap 1️⃣ (was 1 — the dangerous under-count)
    expect(displayWidth('\u{2764}\u{FE0F}')).toBe(2); // VS16 heart ❤️ (a narrow base forced to emoji presentation)
    expect(displayWidth('\u{1F468}\u{200D}\u{1F469}')).toBe(2); // ZWJ sequence 👨‍👩 (was 4 — a safe over-count, now exact)
    expect(displayWidth('\u{1F44B}\u{1F3FD}')).toBe(2); // skin-tone modifier 👋🏽
    expect(displayWidth('\u{1F1F9}\u{1F1F7}')).toBe(2); // regional-indicator flag 🇹🇷 (a two-code-point pair, one glyph)
  });

  it('a DEGENERATE lone variation-selector / keycap cluster is 0 cells — not forced to 2 (Step-4b-2 Sonnet fix)', () => {
    // A stray VS16 / enclosing-keycap that `Intl.Segmenter` returns as its OWN cluster (no base to attach to) renders
    // as 0 cells, like ink. The VS16/keycap width-2 override must be gated on a base, else it over-counts the stray.
    expect(displayWidth('\u{FE0F}')).toBe(0); // lone VS16, no base
    expect(displayWidth('\u{20E3}')).toBe(0); // lone enclosing keycap, no base
  });

  it('BMP default-emoji-presentation singletons are 2 (as ink renders them) — text symbols stay 1 (Step-4b-2 Opus fix)', () => {
    // ✅❌⭐⚡✨❗➕⌚⛄✋ render 2 in a terminal WITHOUT a VS16 selector (Emoji_Presentation=Yes) — the per-code-point
    // table under-counted them to 1, drifting the scroll offset. Now 2.
    for (const emoji of ['✅', '❌', '⭐', '⚡', '✨', '❗', '➕', '⌚', '⛄', '✋', '⚽', '⛔']) {
      expect(displayWidth(emoji)).toBe(2);
    }
    // …but common TEXT symbols in the SAME blocks are NOT emoji-presentation → stay 1 (no cosmetic over-count).
    for (const text of ['→', '←', '✓', '✗', '•', '©', '®']) {
      expect(displayWidth(text)).toBe(1);
    }
  });
});

describe('wrapLogicalLine', () => {
  it('leaves a line that fits untouched (single row)', () => {
    expect(wrapLogicalLine('hello', 10)).toEqual(['hello']);
    expect(wrapLogicalLine('hello', 5)).toEqual(['hello']); // exactly cols
  });

  it('char-wraps an over-wide line at the width boundary', () => {
    expect(wrapLogicalLine('abcdef', 3)).toEqual(['abc', 'def']);
    expect(wrapLogicalLine('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
  });

  it('accounts for wide glyphs when wrapping (a 2-cell char does not overfill)', () => {
    // '中' is 2 cells; at cols=3 only one fits per row alongside a 1-cell char.
    expect(wrapLogicalLine('中a中', 3)).toEqual(['中a', '中']);
    expect(wrapLogicalLine('中中', 3)).toEqual(['中', '中']); // 2+2 > 3 ⇒ split
    expect(wrapLogicalLine('中中', 4)).toEqual(['中中']); // 2+2 = 4 ⇒ fits
  });

  it('keeps an empty line as one blank row', () => {
    expect(wrapLogicalLine('', 10)).toEqual(['']);
  });

  it('places a single glyph wider than cols alone on its row (never loops / drops it)', () => {
    expect(wrapLogicalLine('中', 1)).toEqual(['中']); // one 2-cell glyph in a 1-col terminal
    expect(wrapLogicalLine('a中b', 1)).toEqual(['a', '中', 'b']);
  });

  it('never splits a multi-code-point grapheme cluster mid-glyph (Step-4b-2 harden)', () => {
    // A 2-cell emoji + a 1-cell char at cols=2: the emoji lands on its own row (1+2 > 2), never split into surrogates.
    expect(wrapLogicalLine('a\u{1F680}b', 2)).toEqual(['a', '\u{1F680}', 'b']);
    // A ZWJ family emoji is ONE 2-cell cluster — it wraps as a unit, not per joined code point.
    expect(wrapLogicalLine('\u{1F468}\u{200D}\u{1F469}x', 2)).toEqual([
      '\u{1F468}\u{200D}\u{1F469}',
      'x',
    ]);
  });

  it('degrades to the whole line on a non-positive width (never infinite-loops)', () => {
    expect(wrapLogicalLine('abc', 0)).toEqual(['abc']);
    expect(wrapLogicalLine('abc', -5)).toEqual(['abc']);
  });
});

describe('wrapText (multi-line)', () => {
  it('splits on newlines then width-wraps each logical line', () => {
    expect(wrapText('ab\ncdef', 3)).toEqual(['ab', 'cde', 'f']);
  });

  it('preserves empty lines as blank rows', () => {
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
    expect(wrapText('', 10)).toEqual(['']); // a single empty logical line
  });

  it('a trailing newline yields a trailing blank row', () => {
    expect(wrapText('a\n', 10)).toEqual(['a', '']);
  });
});

describe('maxOffset', () => {
  it('is zero when the content fits the height', () => {
    expect(maxOffset(3, 10)).toBe(0);
    expect(maxOffset(10, 10)).toBe(0);
  });

  it('is total - height when the content overflows', () => {
    expect(maxOffset(25, 10)).toBe(15);
  });

  it('clamps a non-positive height to a zero floor', () => {
    expect(maxOffset(25, 0)).toBe(25);
    expect(maxOffset(25, -5)).toBe(25);
  });
});

describe('clampOffset', () => {
  it('clamps into [0, maxOffset] and truncates a fractional offset', () => {
    expect(clampOffset(-3, 25, 10)).toBe(0);
    expect(clampOffset(999, 25, 10)).toBe(15); // maxOffset
    expect(clampOffset(7, 25, 10)).toBe(7);
    expect(clampOffset(7.9, 25, 10)).toBe(7); // truncated
  });

  it('clamps a NaN offset to zero', () => {
    expect(clampOffset(Number.NaN, 25, 10)).toBe(0);
  });
});

describe('windowLines', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);

  it('returns the height-sized window at a clamped offset', () => {
    expect(windowLines(lines, 0, 5)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
    expect(windowLines(lines, 3, 3)).toEqual(['L3', 'L4', 'L5']);
  });

  it('never reads past the bottom (an over-large offset clamps to the last full screen)', () => {
    expect(windowLines(lines, 999, 5)).toEqual(['L15', 'L16', 'L17', 'L18', 'L19']);
  });

  it('returns everything when the content fits', () => {
    expect(windowLines(lines.slice(0, 3), 0, 10)).toEqual(['L0', 'L1', 'L2']);
  });

  it('returns empty for a non-positive height', () => {
    expect(windowLines(lines, 0, 0)).toEqual([]);
  });
});

/**
 * `displayWidth` IS ink's width function (2.6.F Step 6g, ADR-0069). The load-bearing invariant is
 * **1 DisplayLine == 1 real terminal row**: a line we think fits must fit ink's own re-measure, or ink re-wraps that
 * `<Text>` to two rows, `overflowY: hidden` clips the tail, and every scroll offset and mouse row→line mapping below
 * it shifts by one.
 *
 * The hand-rolled table this replaced claimed to "never under-count vs ink". Measured across the BMP and SMP it
 * under-counted 8 539 code points, all East-Asian Wide. These are the biggest families.
 */
describe('displayWidth agrees with the terminal on the wide scripts the old table missed', () => {
  it.each([
    ['Tangut', '\u{17000}', 2], // 7 382 code points, every one counted as 1 before
    ['Tangut components', '\u{18800}', 2],
    ['Yijing hexagram', '\u{4DC0}', 2],
    ['Kana Supplement', '\u{1B000}', 2],
    ['Hangul Jamo Extended-A', '\u{A960}', 2],
    ['Vertical form', '\u{FE10}', 2],
    ['Small form variant', '\u{FE50}', 2],
    ['Angle bracket', '\u{2329}', 2],
    ['Tai Xuan Jing symbol', '\u{1D300}', 2],
  ])('%s is two cells', (_name, char, cells) => {
    expect(displayWidth(char)).toBe(cells);
  });

  it('a Tangut line fills twice the cells the old table budgeted for it', () => {
    // 40 Tangut ideographs = 80 cells. The old table said 40, so the line was wrapped at 80 columns, rendered at 160,
    // and every DisplayLine after it was one real row out of step.
    const line = '\u{17000}'.repeat(40);
    expect(displayWidth(line)).toBe(80);
    expect(wrapLogicalLine(line, 80)).toHaveLength(1);
    expect(wrapLogicalLine(line, 40)).toHaveLength(2);
  });

  it('NEVER under-counts a single code point — the invariant the whole viewport rests on', () => {
    // Exhaustive over the assigned planes a transcript can realistically carry: ~196 000 code points. Structural
    // today (`displayWidth` IS `inkWidth`), and the guard the moment anyone re-hand-rolls it.
    //
    // Two things it deliberately does NOT do, both learned from CI:
    //   - it does not call `expect` per code point. Vitest's `expect` overhead alone took ~7 s on a runner.
    //   - it does not segment each code point first. A single code point is ALWAYS exactly one grapheme cluster
    //     (verified over the same range), so that guard was dead weight costing seconds.
    // What remains is inherently a long sweep, so it carries an explicit timeout rather than sitting a hair under
    // the default and flaking on a slow runner.
    const underCounted: string[] = [];
    for (let cp = 0x20; cp <= 0x2ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates are not text
      const ch = String.fromCodePoint(cp);
      if (displayWidth(ch) < inkWidth(ch) && underCounted.length < 10) {
        underCounted.push(`U+${cp.toString(16).toUpperCase()}`);
      }
    }
    expect(underCounted).toEqual([]);
  }, 30_000);

  it('a wrapped line never exceeds `cols` by ink’s own measure', () => {
    const messy = '日本語です a👍b \u{17000}\u{17001} café \u{A960}\u{1160} ❤️ 1️⃣ 🇹🇷 end';
    for (const cols of [10, 20, 37, 80]) {
      for (const row of wrapLogicalLine(messy, cols)) {
        expect(inkWidth(row), `cols=${cols} row=${JSON.stringify(row)}`).toBeLessThanOrEqual(cols);
      }
    }
  });
});

/**
 * `wrapLogicalLine`'s ASCII FAST PATH (2.6.F Step 6g). `Intl.Segmenter` costs ~32 ms on a 200 000-character line, and
 * the caps-lift made such a line reachable — a long answer now enters the viewport whole instead of being clipped to
 * 4 000 characters. Printable ASCII needs no segmentation: every character is its own cluster and every cluster is one
 * cell. The risk is that the two paths DISAGREE, so they are compared directly.
 */
describe('wrapLogicalLine — the ASCII fast path is the general path', () => {
  /** The general path, expressed independently, so this is a comparison and not a tautology. */
  const generalPath = (line: string, cols: number): string[] => {
    if (cols <= 0 || line === '') return [line];
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const rows: string[] = [];
    let current = '';
    let width = 0;
    for (const { segment } of segmenter.segment(line)) {
      const w = displayWidth(segment);
      if (width + w > cols && current !== '') {
        rows.push(current);
        current = '';
        width = 0;
      }
      current += segment;
      width += w;
    }
    rows.push(current);
    return rows;
  };

  it('agrees with the general path on 3 200 (line, cols) pairs of printable ASCII', () => {
    const alphabet = ' !"#$%&()*+,-./0123456789:;<=>?@ABCabc~';
    for (let trial = 0; trial < 400; trial += 1) {
      const length = 1 + ((trial * 7) % 60);
      let line = '';
      for (let i = 0; i < length; i += 1) {
        line += alphabet[(trial * 13 + i * 5) % alphabet.length];
      }
      for (const cols of [1, 2, 3, 7, 20, 79, 80, 200]) {
        expect(wrapLogicalLine(line, cols), `${JSON.stringify(line)} @ ${String(cols)}`).toEqual(
          generalPath(line, cols),
        );
      }
    }
  });

  it('a NON-ASCII line takes the general path — one wide glyph is enough to disqualify it', () => {
    expect(wrapLogicalLine('ab日', 2)).toEqual(['ab', '日']); // fixed-width chunking would give ['ab', '日']… by luck
    expect(wrapLogicalLine('a日b', 2)).toEqual(['a', '日', 'b']); // …here it would give ['a日', 'b'] and overflow
  });

  it('a TAB or an ESC is not printable ASCII, so it does not take the fast path', () => {
    // 0x09 and 0x1b are outside [0x20,0x7e] and are ZERO-width, so fixed-width chunking would break the row. Both are
    // stripped upstream; the guard is what keeps the paths honest. The width must be small enough for the zero-width
    // control to matter — at `cols = 80` both paths agree by accident, which a break-verify proved.
    for (const line of ['a\tbc', 'a\x1bbc', '\tabc']) {
      expect(wrapLogicalLine(line, 2), JSON.stringify(line)).toEqual(generalPath(line, 2));
    }
  });
});
