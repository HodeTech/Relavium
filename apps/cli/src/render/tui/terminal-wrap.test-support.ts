import stringWidth from 'string-width';

/**
 * A SIMULATED TERMINAL for the margin's witness (MVP-11 unit 9, review rounds 1 and 2: S-1, S2-1, M2-4): the fake terminal of the surface matrix
 * places one cell per UTF-16 unit and Ink sizes a row with `string-width`, so neither can see what a real terminal does with a character the two
 * measure differently. This one re-draws the rows a frame holds with the widths tmux 3.7b (the reference terminal) DREW in review round 2's
 * measurements (`TMUX_MEASUREMENTS` in `terminal-widths.test.ts`: each string written after an `A`, the cursor read back with `ESC[6n`; the test
 * holds this function to every one of them): everything as `string-width` counts it, and on top of that, per grapheme cluster that is not an emoji
 * the layout already draws wide:
 *
 * - U+115F two columns; U+FFA0 and U+00AD one (every other default-ignorable code point, U+3164 included, none: as measured);
 * - U+FE0F one more on a cluster `string-width` counts one column (`a`+U+FE0F, a digit+U+FE0F: two);
 * - each skin tone U+1F3FB to U+1F3FF two more (`a`+U+1F3FD: three; five of them: eleven);
 * - each Thai or Lao AM (U+0E33, U+0EB3) one more;
 * - a pair of regional indicators that is not a flag one more (two columns);
 * - a lone surrogate one column (Node writes it as U+FFFD);
 * - a TAB moves to the next multiple of eight columns (or to the last column: it never wraps by itself);
 * - narrower than `string-width`: U+2028, U+2029 and a vowel or trailing Hangul jamo with no leading jamo, none.
 *
 * A row that is wider than the terminal under those widths WRAPS, as a terminal with autowrap on does: the rest of it starts at column 0 of the
 * next physical row, which is the margin.
 */

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');
const KEYCAP = new RegExp(
  `^[0-9#*]${String.fromCodePoint(0xfe0f)}?${String.fromCodePoint(0x20e3)}$`,
  'u',
);
const REGIONAL_PAIR = /^\p{Regional_Indicator}{2}$/u;
/**
 * What tmux 3.7b drew with no column where `string-width` counts one: the line and paragraph separators, and a vowel or trailing Hangul jamo with
 * no leading jamo before it (narrower on the terminal: harmless to the margin, here so the simulation matches the measurements exactly).
 */
const DRAWN_EMPTY = new RegExp(
  `^[${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x2029)}${String.fromCodePoint(0x1160)}-${String.fromCodePoint(0x11ff)}${String.fromCodePoint(0xd7b0)}-${String.fromCodePoint(0xd7ff)}]+$`,
  'u',
);

/** What tmux 3.7b drew for one code point on top of `string-width`'s count of its cluster (see the module header), outside an emoji. */
function measuredExtra(code: number): number {
  if (code === 0x115f) return 2;
  if (code === 0xffa0 || code === 0x00ad) return 1;
  if (code >= 0x1f3fb && code <= 0x1f3ff) return 2;
  if (code === 0x0e33 || code === 0x0eb3) return 1;
  if (code >= 0xd800 && code <= 0xdfff) return 1;
  return 0;
}

/** The columns the reference terminal draws one grapheme cluster in (see the module header; a TAB is the caller's: it depends on the column). */
export function terminalWidth(cluster: string): number {
  if (DRAWN_EMPTY.test(cluster)) return 0;
  const counted = stringWidth(cluster, { countAnsiEscapeCodes: true });
  if (RGI_EMOJI.test(cluster) || KEYCAP.test(cluster)) return counted;
  let extra = 0;
  let presentation = false;
  let first = true;
  for (const character of cluster) {
    const code = character.codePointAt(0) ?? 0;
    // a selector or a tone that starts a cluster has no base to widen: it is what `string-width` counts it (a tone alone is an emoji itself)
    if (code === 0xfe0f) presentation = !first;
    else if (!first || !(code >= 0x1f3fb && code <= 0x1f3ff)) extra += measuredExtra(code);
    first = false;
  }
  if (presentation && counted < 2) extra += 1;
  if (REGIONAL_PAIR.test(cluster) && counted < 2) extra += 1;
  return counted + extra;
}

/** The columns `text` takes on the reference terminal from column `start` (a TAB moves to the next multiple of eight). */
export function terminalColumns(text: string, start = 0): number {
  let column = start;
  for (const { segment } of SEGMENTER.segment(text))
    column = segment === '\t' ? column + 8 - (column % 8) : column + terminalWidth(segment);
  return column - start;
}

/** The physical rows a terminal `columns` wide shows for `rows` (each a row of a frame, its text only): a row too wide for it wraps. */
export function physicalRows(rows: readonly string[], columns: number): string[] {
  const out: string[] = [];
  for (const row of rows) {
    let current = '';
    let column = 0;
    for (const { segment } of SEGMENTER.segment(row)) {
      if (segment === '\t') {
        // a TAB moves to the next stop or to the last column, and never wraps by itself (what follows it does)
        column = Math.min(column + 8 - (column % 8), columns - 1);
        current += segment;
        continue;
      }
      const width = terminalWidth(segment);
      if (column + width > columns && column > 0) {
        out.push(current);
        current = '';
        column = 0;
      }
      current += segment;
      column += width;
    }
    out.push(current);
  }
  return out;
}

/**
 * The physical rows of `rows` that have something other than a space in the margin's columns `[0, margin)` and did not have it in the frame: the
 * continuation of a row a terminal wrapped. A frame row's own margin cell (the host's mark) is the frame's oracle's business, not this one's.
 */
export function wrappedIntoMargin(
  rows: readonly string[],
  columns: number,
  margin: number,
): string[] {
  const offenders: string[] = [];
  for (const row of rows) {
    const physical = physicalRows([row], columns);
    for (const continuation of physical.slice(1))
      if ([...continuation].slice(0, margin).join('').trim() !== '') offenders.push(continuation);
  }
  return offenders;
}
