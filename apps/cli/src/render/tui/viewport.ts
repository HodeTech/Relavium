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
 * avoids a `string-width` runtime dependency (see chat-projection.ts). The load-bearing invariant is **1 DisplayLine
 * == 1 real terminal row**: each wrapped line must fit ink's own re-measure of it. That holds as long as
 * `displayWidth` never UNDER-counts relative to ink (which uses the full Unicode tables via `string-width`) — an
 * under-count makes a DisplayLine wider than `cols`, so ink re-wraps that `<Text>` to 2 real rows and the viewport's
 * `overflowY: hidden` clips the tail. OVER-counting is the safe direction (the wrap just breaks a cell early → a
 * slightly narrower line). Today's condensed table over-counts a ZWJ emoji sequence (safe) but can under-count a
 * composed emoji-presentation cluster (a VS16 `❤️` / an enclosing keycap `1️⃣`) — cosmetic at Step 4b-1 (tail-follow
 * is a row-INDEX with no persisted offset, so nothing corrupts), but the 1:1 invariant becomes load-bearing for the
 * Step-4b-2 persisted-offset scroll, where the table should be hardened (grapheme-aware, e.g. `Intl.Segmenter`) so it
 * never under-counts. Tracked as a Step-4b-2 obligation.
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
 * Grapheme segmenter (Node 22 has `Intl.Segmenter`, ADR-0067 floor) — so a composed glyph (an emoji ZWJ sequence, a
 * VS16 emoji, an enclosing keycap, a regional-indicator flag, a base + combining marks) is measured + wrapped as ONE
 * unit, never split mid-cluster and never mis-summed per code point. Created once (constructing one is not cheap).
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Terminal display width of ONE grapheme cluster in cells. A cluster renders as a single glyph: an emoji-presentation
 * cluster (one that carries VS16 `U+FE0F` or the enclosing keycap `U+20E3` OVER a base, or whose base is a wide/emoji
 * code point) is 2 cells; a base + combining marks is the base's width; a zero-width-only cluster is 0. Biased so it
 * NEVER UNDER-counts vs a terminal (an under-count would make a wrapped line wider than `cols`, so ink re-wraps it to 2
 * real rows and the viewport clips the tail — the load-bearing 1-DisplayLine-==-1-real-row invariant, ADR-0068 §c).
 */
function graphemeWidth(cluster: string): number {
  let base = 0;
  let emojiPresentation = false;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x20e3) emojiPresentation = true; // VS16 / enclosing keycap ⇒ forces 2 cells (on a base)
    const w = codePointWidth(cp);
    if (w > base) base = w; // the widest constituent (a wide/emoji base survives its combining/joiner code points)
  }
  // The VS16/keycap width-2 override applies only when there IS a base: a DEGENERATE lone selector cluster (a stray
  // `U+FE0F`/`U+20E3` that `Intl.Segmenter` returns as its own cluster with nothing to attach to) renders as 0 cells,
  // like ink — forcing it to 2 would over-count that cluster (Step-4b-2 Sonnet review).
  return emojiPresentation && base > 0 ? 2 : base;
}

/**
 * Terminal display width of a string in cells — the sum over its GRAPHEME CLUSTERS, so an astral emoji, a ZWJ
 * sequence, a keycap, or a flag each count once (2), and a base + combining marks counts as the base. See
 * {@link graphemeWidth}. Zero-width-only content is 0. Never under-counts vs ink (the safe direction).
 */
export function displayWidth(str: string): number {
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(str)) {
    width += graphemeWidth(segment);
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
    isBmpEmojiPresentation(cp) || // BMP default-emoji-presentation singletons (✅⭐⚡… render 2 without VS16)
    (cp >= 0x1f000 && cp <= 0x1f2ff) || // Mahjong / Domino / Playing cards / enclosed
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji + symbols + pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+ (astral wide)
  );
}

/**
 * BMP code points with `Emoji_Presentation=Yes` (they render as a 2-cell emoji by DEFAULT, without a VS16 selector)
 * — Misc Symbols/Dingbats/Misc-Symbols-and-Arrows emoji (✅ ❌ ⭐ ⚡ ✨ ❗ ➕ ⌚ ⏰ ⛄ ✋ …). The per-code-point table
 * skips these (they are outside the astral 0x1F3xx emoji blocks), so `displayWidth` UNDER-counted them (1) vs a
 * terminal's 2 — the load-bearing under-count the 4b-2 scroll exposes (Step-4b-2 Opus review). The canonical Unicode
 * Emoji_Presentation set for the BMP:
 */
function isBmpEmojiPresentation(cp: number): boolean {
  return (
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55
  );
}

/**
 * Break ONE logical line (must contain no `\n`) into segments each ≤ `cols` display cells, char-wrapping on a
 * GRAPHEME-CLUSTER, width-aware boundary — so an emoji sequence / keycap / flag is never split mid-glyph and its
 * width is measured once (no word-wrap: a URL/token never overflows the viewport width; word-wrap is a later polish).
 * An empty line → `['']` (it still occupies one rendered row). A non-positive `cols` degrades to `[line]` (never
 * loops). A single cluster wider than `cols` (a wide glyph in a 1-col terminal) still lands alone on its row.
 */
export function wrapLogicalLine(line: string, cols: number): string[] {
  if (cols <= 0 || line === '') return [line];
  const rows: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(line)) {
    const w = graphemeWidth(segment);
    if (currentWidth + w > cols && current !== '') {
      rows.push(current);
      current = '';
      currentWidth = 0;
    }
    current += segment;
    currentWidth += w;
  }
  rows.push(current); // the trailing segment (always at least '' if the input was non-empty per the guard above)
  return rows;
}

/**
 * Wrap a multi-line block: split on `\n` (each logical line is a rendered row group) then width-wrap each. Preserves
 * empty lines as blank rows. This is the row count the viewport scroll math is defined over. PURE — the transcript
 * memoization is a per-ENTRY cache in `wrapTranscript` (chat-projection.ts), which never thrashes because it is keyed
 * on the immutable, append-only entry object (Step-4b-3 Opus review — the earlier per-line LRU thrashed to a 0% hit
 * rate once a session exceeded the cache size, the exact case it was introduced for).
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
