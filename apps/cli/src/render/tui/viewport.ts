import stringWidth from 'string-width';
import type { MarkdownSpan } from '../markdown/types.js';
import type { MarginRole } from './chat-grid.js';

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
 * shifts. Which is why {@link displayWidth} is built on the SAME function ink measures with — `string-width` — rather than a
 * hand-rolled table (2.6.F Step 6g, [ADR-0069](../../../../docs/decisions/0069-string-width-for-the-cli-renderer.md)), and never counts less than
 * it (a cluster with an Indic linker or a Prepend letter counts every spacing character it holds, as a terminal draws it: MVP-11 unit 9, review
 * round 4); so a row measured to fit is never re-wrapped by ink.
 *
 * The table it replaces claimed to "never under-count vs ink". Measured across the BMP and SMP it under-counted 8 539
 * code points — Tangut (7 382 of them), Yijing hexagrams, Kana Supplement, Hangul Jamo Extended-A, vertical forms —
 * all East-Asian **Wide**, all rendered as 2 cells by every terminal and by ink, and all counted as 1 by us. It had
 * already been patched twice by review (BMP emoji presentation in Step 4b-2), and its own docstring recorded the
 * hardening as an open obligation. A Unicode width table is not Relavium's core, it rots with every Unicode release,
 * and getting it wrong corrupts the renderer.
 */

/** The per-entry render style a display line inherits from its transcript entry (mirrors `TranscriptLine`'s styles:
 *  user = bold words, assistant = default, notice = dim, summary = gray, hint = yellow). */
export type LineStyle = 'user' | 'assistant' | 'notice' | 'summary' | 'hint';

/**
 * One rendered display line of the transcript, on the chat's grid (`chat-grid.ts`, MVP-11 unit 9), tagged with its source entry's
 * {@link LineStyle}. `text` (and `spans`) is the row's CONTENT only, already at most the content column wide: every word a person or a model
 * wrote, and never a marker.
 */
export interface DisplayLine {
  readonly text: string;
  readonly style: LineStyle;
  readonly spans?: readonly MarkdownSpan[];
  /**
   * What the margin of the row says (ADR-0145 §6): a role of the closed {@link MarginRole} set, set only by the host where it builds the row
   * (`wrapEntry`), on the first row of the person's turn, of a tool call, of a reply and of a notice line the host leads. A renderer draws it with
   * `marginCell`, which takes no text, so nothing a model or a person wrote can occupy the margin. Absent on every other row: a wrapped row hangs
   * under the text with a blank margin.
   */
  readonly margin?: MarginRole;
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
 * The code points that make ONE grapheme cluster of more than one spacing character (MVP-11 unit 9, review round 4, R4-S-1): the Indic conjunct
 * LINKERS (a virama or invisible stacker between two consonants, Unicode 17's `Indic_Conjunct_Break=Linker`: V8's regular expressions do not know
 * the property, so the list is explicit, and `terminal-widths.test.ts` re-derives it from this runtime's `Intl.Segmenter`) and the PREPEND
 * letters (`Grapheme_Cluster_Break=Prepend`; the format ones among them never reach a row, the screen's filter drops them). `string-width` counts a
 * cluster by its first code point, so `क्ष` (one cluster) is 1 and `ൎy` is 1; a terminal draws each spacing character in a cell of its own (tmux
 * 3.7b: 2 and 2; `राष्ट्रीय स्वास्थ्य मिशन` 10 counted, 15 drawn).
 */
/** The Indic conjunct linkers (Unicode 17 `Indic_Conjunct_Break=Linker`, as this runtime's segmenter joins them: see {@link CLUSTER_JOINERS}). */
const LINKERS = [
  0x094d, 0x09cd, 0x0acd, 0x0b4d, 0x0c4d, 0x0d4d, 0x1039, 0x17d2, 0x1a60, 0x1b44, 0x1bab, 0xa9c0,
  0xaaf6, 0x10a3f, 0x11133, 0x113d0, 0x1193e, 0x11a47, 0x11a99, 0x11f42,
]
  .map((code) => String.fromCodePoint(code))
  .join('');
/** The Prepend letters and format characters (`Grapheme_Cluster_Break=Prepend`, as this runtime's segmenter joins them). */
const PREPENDS = [
  0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x0d4e,
  0x110bd, 0x110cd, 0x111c2, 0x111c3, 0x113d1, 0x1193f, 0x11941, 0x11a84, 0x11a85, 0x11a86, 0x11a87,
  0x11a88, 0x11a89, 0x11d46, 0x11f02,
]
  .map((code) => String.fromCodePoint(code))
  .join('');
const CLUSTER_JOINERS = new RegExp(`[${LINKERS}${PREPENDS}]`, 'u');
/** Where {@link inkSafe} sets a zero width non-joiner: after a linker (and the marks and joiner after it) before a letter, after a Prepend before anything. */
const INK_SPLIT = new RegExp(
  `([${LINKERS}][\\p{M}${String.fromCodePoint(0x200d)}]*)(?=\\p{L})|([${PREPENDS}])(?=[^${String.fromCodePoint(0x200c)}\\n])`,
  'gu',
);

/**
 * `text` as ink must be given it where INK fits a text to its box itself (a `wrap` or `truncate` cell the repo did not fit first): a zero width
 * non-joiner after every Indic linker that joins two letters and after every Prepend letter (MVP-11 unit 9, review round 4, R4-S-1). It breaks the
 * one grapheme cluster `string-width` would count by its first code point into the clusters a terminal draws, so ink counts the text as
 * {@link displayWidth} does and as tmux draws it (`क्‌क` two columns to all three; the non-joiner draws nothing). Display only: the text a row
 * holds, a copy and a document keep their bytes. The cost, recorded: a terminal that shapes Indic scripts draws the explicit virama there.
 */
export function inkSafe(text: string): string {
  if (!CLUSTER_JOINERS.test(text)) return text;
  return text.replace(INK_SPLIT, (match) => `${match}${String.fromCodePoint(0x200c)}`);
}

/**
 * Terminal display width of ONE grapheme cluster in cells: what `string-width` (ink's own measure) counts, and for a cluster with an Indic
 * linker or a Prepend letter in it ({@link CLUSTER_JOINERS}) the sum of what it counts for each of its code points, the larger of the two (review
 * round 4, R4-S-1: every spacing character of such a cluster takes a cell on the terminal; a mark takes none to both). Never less than ink counts,
 * so a row this measures to fit is never re-wrapped or cut by ink.
 *
 * `countAnsiEscapeCodes: true` skips `string-width`'s `strip-ansi` pass. The text reaching here is already stripped of
 * ANSI/C0/C1 by `sanitizeInline`, and skipping it keeps the hot path (one cluster per character of a wrapped line) off
 * a regex it does not need.
 */
function graphemeWidth(cluster: string): number {
  const counted = stringWidth(cluster, { countAnsiEscapeCodes: true });
  if (!CLUSTER_JOINERS.test(cluster)) return counted;
  // a cluster with a joiner costs a pass over its code points: a syllable of natural text recurs, so its width is remembered (short clusters only,
  // so a hostile one cannot hold memory; the memo is emptied when full, so its size is bounded)
  if (cluster.length <= MEMO_CLUSTER_UNITS) {
    const known = joinedWidths.get(cluster);
    if (known !== undefined) return known;
  }
  let spacing = 0;
  for (const character of cluster)
    spacing += stringWidth(character, { countAnsiEscapeCodes: true });
  const width = Math.max(counted, spacing);
  if (cluster.length <= MEMO_CLUSTER_UNITS) {
    if (joinedWidths.size >= MEMO_SIZE) joinedWidths.clear();
    joinedWidths.set(cluster, width);
  }
  return width;
}
const MEMO_CLUSTER_UNITS = 16;
const MEMO_SIZE = 4096;
const joinedWidths = new Map<string, number>();

/**
 * Terminal display width of a string in cells: `string-width` (the function ink's `Output` measures with), except a cluster with an Indic linker
 * or a Prepend letter in it, which counts every spacing character it holds ({@link graphemeWidth}; review round 4, R4-S-1). An emoji ZWJ
 * sequence, a keycap, a flag each count 2; a base + combining marks counts as the base; a zero-width-only cluster is 0. `string-width` has an
 * ASCII fast path, and a string with no linker or Prepend letter in it costs one more regex. Never less than ink counts. (Where a terminal draws a
 * character wider than this, the screen's filter rewrites or drops it; it runs on untrusted text BEFORE the text is laid out, so this measures the
 * text as it is drawn: `screen-text.ts`, review rounds 3 and 4.)
 */
export function displayWidth(str: string): number {
  if (!CLUSTER_JOINERS.test(str)) return stringWidth(str, { countAnsiEscapeCodes: true });
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(str)) width += graphemeWidth(segment);
  return width;
}

/**
 * `text` followed by spaces up to `width` display columns; it is never cut, and text that is already `width` columns or wider is returned as it is.
 * The one place a list's columns are aligned: a code-point count would misalign a wide glyph (a CJK name is two cells a character) and a
 * combining mark (none), which is what `displayWidth` counts (review round 1 of MVP-11 unit 8, D-7).
 */
export function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
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

/** Expand display tabs to eight-cell stops, after sanitization and before width math. */
export function expandTabs(text: string, startColumn = 0): string {
  if (!text.includes('\t')) return text;
  const parts: string[] = [];
  let column = Math.max(0, Math.trunc(startColumn));
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (segment === '\n') {
      column = 0;
      parts.push(segment);
    } else if (segment === '\t') {
      const cells = 8 - (column % 8);
      parts.push(' '.repeat(cells));
      column += cells;
    } else {
      parts.push(segment);
      column += graphemeWidth(segment);
    }
  }
  return parts.join('');
}

/** The first index at or after `start` that is not a break space (`isSpace`): where a wrap-created continuation row begins its text. */
function afterBreakSpaces(start: number, length: number, isSpace: (at: number) => boolean): number {
  let at = start;
  while (at < length && isSpace(at)) at += 1;
  return at;
}

/** The ASCII fast path of {@link wrapWords}: every character is one cluster of one cell. */
function wrapAscii(expanded: string, width: number, dropBreakSpace: boolean): string[] {
  const rows: string[] = [];
  for (let start = 0; start < expanded.length; ) {
    if (dropBreakSpace && start > 0) {
      start = afterBreakSpaces(start, expanded.length, (at) => expanded.charAt(at) === ' ');
      if (start >= expanded.length) break;
    }
    let end = Math.min(start + width, expanded.length);
    if (end < expanded.length && expanded.charAt(end) !== ' ') {
      // Search only this row, never an ever-growing prefix of a long URL.
      const boundary = expanded.slice(start, end).lastIndexOf(' ');
      if (boundary >= 0) end = start + boundary + 1;
    }
    rows.push(expanded.slice(start, end));
    start = end;
  }
  return rows;
}

/** The grapheme path of {@link wrapWords}: clusters measured once, a cluster wider than the row drawn as `?`. */
function wrapClusters(expanded: string, width: number, dropBreakSpace: boolean): string[] {
  const clusters = Array.from(graphemeSegmenter.segment(expanded), ({ segment }) => {
    const cells = graphemeWidth(segment);
    return cells > width ? { text: '?', cells: 1 } : { text: segment, cells };
  });
  const rows: string[] = [];
  for (let start = 0; start < clusters.length; ) {
    if (dropBreakSpace && start > 0) {
      start = afterBreakSpaces(start, clusters.length, (at) => clusters[at]?.text === ' ');
      if (start >= clusters.length) break;
    }
    let end = start;
    let cells = 0;
    let boundary = start;
    while (end < clusters.length) {
      const cluster = clusters[end];
      if (cluster === undefined || cells + cluster.cells > width) break;
      cells += cluster.cells;
      end += 1;
      if (/^\s+$/u.test(cluster.text)) boundary = end;
    }
    if (end < clusters.length && !/^\s+$/u.test(clusters[end]?.text ?? '') && boundary > start)
      end = boundary;
    // Every cluster fits alone; even a zero-width-only string advances.
    if (end === start) end += 1;
    rows.push(
      clusters
        .slice(start, end)
        .map((cluster) => cluster.text)
        .join(''),
    );
    start = end;
  }
  return rows;
}

/**
 * Word-wrap display text while retaining whitespace and graphemes. A token wider
 * than a row falls back to character wrapping. Zero/invalid widths suspend paint;
 * a glyph wider than the positive row becomes `?` in this display projection only.
 *
 * `dropBreakSpace` (off by default: the contract above, which the selection and `viewport.test.ts` pin) is the chat transcript's hanging wrap
 * (MVP-11 unit 9, review round 1, D-2): a row the WRAP starts (never the line's first row, so never a source indent) begins at its text, the
 * spaces the line broke at dropped, as the markdown layout's own `dropBreakSpace` does for its prose blocks. The rows after it are filled from
 * there, so the plain reply and the live plain tail (the layout's literal block) wrap alike.
 */
export function wrapWords(line: string, cols: number, dropBreakSpace = false): string[] {
  if (!Number.isFinite(cols) || cols < 1) return [];
  const width = Math.trunc(cols);
  const expanded = expandTabs(line);
  if (expanded === '') return [''];
  return ASCII_ONLY.test(expanded)
    ? wrapAscii(expanded, width, dropBreakSpace)
    : wrapClusters(expanded, width, dropBreakSpace);
}

/**
 * Wrap a multi-line block: split on `\n` (each logical line is a rendered row group) then width-wrap each. Preserves
 * empty lines as blank rows. This is the row count the viewport scroll math is defined over. PURE — the transcript
 * memoization is a per-ENTRY cache in `wrapTranscript` (chat-projection.ts), which never thrashes because it is keyed
 * on the immutable, append-only entry object (Step-4b-3 Opus review — the earlier per-line LRU thrashed to a 0% hit
 * rate once a session exceeded the cache size, the exact case it was introduced for). `dropBreakSpace` as {@link wrapWords}.
 */
export function wrapText(text: string, cols: number, dropBreakSpace = false): string[] {
  return text.split('\n').flatMap((line) => wrapWords(line, cols, dropBreakSpace));
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
