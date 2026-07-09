/**
 * Pure line-wrapping + windowing math for the full-screen alt-screen transcript **viewport** (2.6.F Step 4b,
 * [ADR-0068](../../../../docs/decisions/0068-full-screen-tui-renderer-ink7-harness.md) §c). The alt buffer has no
 * native scrollback, so the transcript can no longer live in ink's `<Static>`; instead it is wrapped to fixed-width
 * display lines and a fixed window of them is rendered, with the offset driven by the scroll / auto-follow state
 * machine (Step 4b-2). This module owns the two delicate algorithms — **width-aware wrapping** (so the scroll math
 * counts RENDERED terminal rows, not logical lines) and **offset windowing** — kept pure so they are exhaustively
 * unit-testable with no ink mount.
 *
 * Display width is a PRAGMATIC hand-roll (wide/emoji = 2, zero-width/combining = 0, else 1) — the repo deliberately
 * avoids a `string-width` runtime dependency (see chat-projection.ts). It over-counts a ZWJ emoji sequence (each
 * joined code point is measured on its own) and does not consult the full Unicode East-Asian-Width table, so a rare
 * exotic glyph can wrap a cell early/late; that is cosmetic and self-corrects on the next resize/measure — never a
 * scroll-position corruption, because the SAME width function measures both the wrap and the window.
 */

/** The per-entry render style a display line inherits from its transcript entry (mirrors `TranscriptLine`'s colors:
 *  user = cyan, assistant = default, notice = dim, summary = gray, hint = yellow). */
export type LineStyle = 'user' | 'assistant' | 'notice' | 'summary' | 'hint';

/** One rendered display line (already ≤ cols wide) tagged with its source entry's {@link LineStyle}. */
export interface DisplayLine {
  readonly text: string;
  readonly style: LineStyle;
}

/**
 * Terminal display width of a string in cells. Iterates by code point (so an astral char counts once, not as two
 * UTF-16 units). Zero-width (combining marks, ZWJ/ZWSP, variation selectors, BOM) → 0; East-Asian wide / fullwidth /
 * emoji ranges → 2; control chars (which the display boundary sanitizes out anyway) → 0; everything else → 1.
 */
export function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    width += codePointWidth(cp);
  }
  return width;
}

function codePointWidth(cp: number): number {
  // Zero-width: C0/C1 controls (sanitized upstream, defensive here), combining marks, and the invisible joiners.
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // control
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x0483 && cp <= 0x0489) || // combining cyrillic
    (cp >= 0x0591 && cp <= 0x05bd) || // combining hebrew
    (cp >= 0x0610 && cp <= 0x061a) || // combining arabic
    (cp >= 0x064b && cp <= 0x065f) || // combining arabic marks
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical marks supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
    (cp >= 0xfe20 && cp <= 0xfe2f) || // combining half marks
    cp === 0x200b || // zero-width space
    cp === 0x200c || // zero-width non-joiner
    cp === 0x200d || // zero-width joiner (ZWJ)
    cp === 0xfeff || // BOM / zero-width no-break space
    (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
  ) {
    return 0;
  }
  return isWide(cp) ? 2 : 1;
}

/** East-Asian Wide / Fullwidth + emoji ranges → double-width. A condensed, pragmatic subset of the Unicode tables. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / Kangxi / CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f000 && cp <= 0x1f2ff) || // Mahjong / Domino / Playing cards / enclosed
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji + symbols + pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+ (astral wide)
  );
}

/**
 * Break ONE logical line (must contain no `\n`) into segments each ≤ `cols` display cells, char-wrapping on a
 * width-aware boundary (no word-wrap — a URL/token never overflows the viewport width; word-wrap is a later polish).
 * An empty line → `['']` (it still occupies one rendered row). A non-positive `cols` degrades to `[line]` (never
 * loops). A single code point wider than `cols` (a wide glyph in a 1-col terminal) still lands alone on its row.
 */
export function wrapLogicalLine(line: string, cols: number): string[] {
  if (cols <= 0 || line === '') return [line];
  const rows: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const ch of line) {
    const w = codePointWidth(ch.codePointAt(0) ?? 0);
    if (currentWidth + w > cols && current !== '') {
      rows.push(current);
      current = '';
      currentWidth = 0;
    }
    current += ch;
    currentWidth += w;
  }
  rows.push(current); // the trailing segment (always at least '' if the input was non-empty per the guard above)
  return rows;
}

/**
 * Wrap a multi-line block: split on `\n` (each logical line is a rendered row group) then width-wrap each. Preserves
 * empty lines as blank rows. This is the row count the viewport scroll math is defined over.
 */
export function wrapText(text: string, cols: number): string[] {
  return text.split('\n').flatMap((line) => wrapLogicalLine(line, cols));
}

/** The maximum scroll offset — the top-line index at which the LAST full screen is shown (0 when it all fits). */
export function maxOffset(totalLines: number, height: number): number {
  return Math.max(0, totalLines - Math.max(0, height));
}

/** Clamp a scroll offset to `[0, maxOffset]`. A NaN / negative offset clamps to 0. */
export function clampOffset(offset: number, totalLines: number, height: number): number {
  const max = maxOffset(totalLines, height);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(Math.trunc(offset), max);
}

/** The visible window `lines[offset : offset + height]`, offset first clamped so it never reads past the ends. */
export function windowLines<T>(lines: readonly T[], offset: number, height: number): readonly T[] {
  if (height <= 0) return [];
  const start = clampOffset(offset, lines.length, height);
  return lines.slice(start, start + height);
}
