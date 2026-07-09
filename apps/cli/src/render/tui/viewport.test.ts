import { describe, expect, it } from 'vitest';

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
    expect(displayWidth('🇹️')).toBe(2); // regional indicator (wide) + variation selector (0)
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
