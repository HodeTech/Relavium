import stringWidth from 'string-width';

/**
 * Pure line-wrapping + windowing math for the full-screen alt-screen transcript **viewport** (2.6.F Step 4b,
 * [ADR-0068](../../../../docs/decisions/0068-full-screen-tui-renderer-ink7-harness.md) §c). The alt buffer has no
 * native scrollback, so the transcript can no longer live in ink's `<Static>`; instead it is wrapped to fixed-width
 * display lines and a fixed window of them is rendered, with the offset driven by the scroll / auto-follow state
 * machine (Step 4b-2). This module owns the two delicate algorithms — **width-aware wrapping** (so the scroll math
 * counts RENDERED terminal rows, not logical lines) and **offset windowing** — kept pure so they are exhaustively
 * unit-testable with no ink mount.
 *
 * The load-bearing invariant is **1 DisplayLine == 1 real terminal row**: each wrapped line must fit ink's own
 * re-measure of it. An under-count makes a DisplayLine wider than `cols`, so ink re-wraps that `<Text>` to 2 real rows,
 * the viewport's `overflowY: hidden` clips the tail, and every scroll offset and mouse row→line mapping below it
 * shifts. Which is why {@link displayWidth} is now the SAME function ink measures with — `string-width` — rather than a
 * hand-rolled table (2.6.F Step 6g, [ADR-0069](../../../../docs/decisions/0069-string-width-for-the-cli-renderer.md)).
 *
 * The table it replaces claimed to "never under-count vs ink". Measured across the BMP and SMP it under-counted 8 539
 * code points — Tangut (7 382 of them), Yijing hexagrams, Kana Supplement, Hangul Jamo Extended-A, vertical forms —
 * all East-Asian **Wide**, all rendered as 2 cells by every terminal and by ink, and all counted as 1 by us. It had
 * already been patched twice by review (BMP emoji presentation in Step 4b-2), and its own docstring recorded the
 * hardening as an open obligation. A Unicode width table is not Relavium's core, it rots with every Unicode release,
 * and getting it wrong corrupts the renderer.
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
 * unit, never split mid-cluster. Created once (constructing one is not cheap).
 *
 * `string-width` segments with the same defaults internally, so a per-cluster sum equals `stringWidth` of the whole
 * string by construction — the two can never disagree about where a line ends.
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Printable ASCII: one code unit, one cluster, one cell. `string-width`'s own fast-path predicate. */
const ASCII_ONLY = /^[\u0020-\u007e]*$/;

/**
 * Terminal display width of ONE grapheme cluster in cells, as ink measures it.
 *
 * `countAnsiEscapeCodes: true` skips `string-width`'s `strip-ansi` pass. The text reaching here is already stripped of
 * ANSI/C0/C1 by `sanitizeInline`, and skipping it keeps the hot path (one cluster per character of a wrapped line) off
 * a regex it does not need.
 */
function graphemeWidth(cluster: string): number {
  return stringWidth(cluster, { countAnsiEscapeCodes: true });
}

/**
 * Terminal display width of a string in cells — exactly what ink's `Output` computes for the same string, because it
 * is the same function. An emoji ZWJ sequence, a keycap, a flag each count 2; a base + combining marks counts as the
 * base; a zero-width-only cluster is 0. `string-width` has an ASCII fast path, so the common line costs one regex.
 */
export function displayWidth(str: string): number {
  return stringWidth(str, { countAnsiEscapeCodes: true });
}

/** Which of the three pieces a grapheme cluster belongs to, relative to a display-column span. */
type ColumnPiece = 'before' | 'selected' | 'after';

/**
 * Walk `str`'s grapheme clusters and hand each one to `emit` exactly ONCE, tagged with the piece of the display-column
 * span `[startColumn, endColumn)` it belongs to. Both {@link sliceDisplayColumns} and {@link partitionDisplayColumns}
 * are thin readers of this walk, which is the whole point: they used to encode the same membership rule twice and
 * DRIFTED (Step-6 Opus review). Two invariants are now structural rather than asserted —
 *
 *   `partitionDisplayColumns(s, a, b).selected === sliceDisplayColumns(s, a, b)`   (highlight === clipboard)
 *   `before + selected + after === str`                                            (nothing lost, nothing moved)
 *
 * MEMBERSHIP. A cluster with width belongs to the span when its cell range INTERSECTS it — clicking either half of a
 * wide character takes the whole character, exactly as every terminal's own selection does.
 *
 * A ZERO-WIDTH cluster (a combining mark, a ZWJ, a lone variation selector) occupies no cell, so no click can ever
 * land on it. It rides the cluster it modifies: the one BEFORE it. A cluster that leads the string modifies nothing,
 * has no cell of its own, and previously fell through both tests into `after` — which physically MOVED it past its
 * base (`'́ab'` rendered as `'ab́'`) and dropped it from the copy. Such a leading run is held back and
 * emitted with the first cluster that does have a cell, so it stays where the user sees it. A string with no cells at
 * all is entirely `before`: there is nothing to select.
 */
/** Which piece a cell-bearing cluster at `column` (width `width`) belongs to. `empty` ⇒ a degenerate span, so
 *  nothing is `selected` however it straddles. Extracted so {@link walkDisplayColumns} is not a nested ternary. */
function classifyColumn(
  column: number,
  width: number,
  startColumn: number,
  endColumn: number,
  empty: boolean,
): ColumnPiece {
  if (!empty && column < endColumn && column + width > startColumn) return 'selected';
  if (column < startColumn) return 'before';
  return 'after';
}

function walkDisplayColumns(
  str: string,
  startColumn: number,
  endColumn: number,
  emit: (segment: string, piece: ColumnPiece) => void,
): void {
  const empty = endColumn <= startColumn; // a degenerate span selects nothing, whatever it straddles
  let column = 0;
  let leading = ''; // zero-width clusters seen before any cell — no cluster to ride yet
  let previous: ColumnPiece | undefined;

  for (const { segment } of graphemeSegmenter.segment(str)) {
    const width = graphemeWidth(segment);
    if (width === 0) {
      if (previous === undefined) leading += segment;
      else emit(segment, previous);
      continue;
    }
    const piece = classifyColumn(column, width, startColumn, endColumn, empty);
    if (leading !== '') {
      emit(leading, piece);
      leading = '';
    }
    emit(segment, piece);
    previous = piece;
    column += width;
  }
  if (leading !== '') emit(leading, 'before'); // the whole string is zero-width: no cell, nothing selectable
}

/**
 * Slice `str` to the DISPLAY-COLUMN half-open range `[startColumn, endColumn)` — the width-aware counterpart of
 * `String.slice`, for mouse selection (2.6.F Step 6). A terminal reports the CELL a click landed on, not a character
 * index, and a grapheme cluster may occupy 2 cells (CJK, emoji) or 0 (a combining mark).
 *
 * This is what lands on the CLIPBOARD. See {@link walkDisplayColumns} for the membership rule.
 */
export function sliceDisplayColumns(str: string, startColumn: number, endColumn: number): string {
  let out = '';
  walkDisplayColumns(str, startColumn, endColumn, (segment, piece) => {
    if (piece === 'selected') out += segment;
  });
  return out;
}

/**
 * Partition `str` into the three pieces around the display-column span `[startColumn, endColumn)`: the head before it,
 * the span itself, and the tail after. Each grapheme cluster lands in EXACTLY ONE piece.
 *
 * This is what the viewport RENDERS (`before`, an inverse `selected`, `after`). It cannot disagree with
 * {@link sliceDisplayColumns} because both read the one {@link walkDisplayColumns}.
 */
export function partitionDisplayColumns(
  str: string,
  startColumn: number,
  endColumn: number,
): { before: string; selected: string; after: string } {
  let before = '';
  let selected = '';
  let after = '';
  walkDisplayColumns(str, startColumn, endColumn, (segment, piece) => {
    if (piece === 'selected') selected += segment;
    else if (piece === 'before') before += segment;
    else after += segment;
  });
  return { before, selected, after };
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

  // FAST PATH: printable ASCII. Every character is its own grapheme cluster and every cluster is one cell, so the
  // wrap is a fixed-width chunking — no segmentation, no width lookup. This is the same predicate `string-width` uses
  // to short-circuit, and it matters: `Intl.Segmenter` costs ~32ms on a 200 000-character line, which the Step-6g
  // caps-lift made reachable (a long answer now enters the viewport whole instead of being clipped to 4 000 chars).
  // English prose and code take this path; the general path below is unchanged.
  if (ASCII_ONLY.test(line)) {
    const rows: string[] = [];
    for (let i = 0; i < line.length; i += cols) rows.push(line.slice(i, i + cols));
    return rows;
  }

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
