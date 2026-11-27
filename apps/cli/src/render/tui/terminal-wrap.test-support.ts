import stringWidth from 'string-width';

/**
 * A SIMULATED TERMINAL for the margin's witness (MVP-11 unit 9, review round 1, S-1): the fake terminal of the surface matrix places one cell per
 * UTF-16 unit and Ink sizes a row with `string-width`, so neither can see what a real terminal does with a character the two measure differently.
 * This one re-draws the rows a frame holds with a terminal's own widths (wcwidth-style, as tmux 3.7b measured them in the security sitting): the
 * Hangul fillers U+115F and U+3164 two columns, every other default-ignorable code point that is not a kept joiner or selector one column (U+FFA0
 * and U+00AD were measured one), everything else as `string-width` says. A row that is wider than the terminal under those widths WRAPS, as a
 * terminal with autowrap on does: the rest of it starts at column 0 of the next physical row, which is the margin.
 */

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const KEPT = new Set([0x200c, 0x200d, 0xfe0e, 0xfe0f]);
const TWO_COLUMNS = new Set([0x115f, 0x3164]);
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** The columns a terminal draws one grapheme cluster in (see the module header). */
export function terminalWidth(cluster: string): number {
  let extra = 0;
  for (const character of cluster) {
    const code = character.codePointAt(0) ?? 0;
    if (TWO_COLUMNS.has(code)) extra += 2;
    else if (
      !KEPT.has(code) &&
      !(code >= 0xe0020 && code <= 0xe007f) &&
      DEFAULT_IGNORABLE.test(character)
    )
      extra += 1;
  }
  return stringWidth(cluster, { countAnsiEscapeCodes: true }) + extra;
}

/** The physical rows a terminal `columns` wide shows for `rows` (each a row of a frame, its text only): a row too wide for it wraps. */
export function physicalRows(rows: readonly string[], columns: number): string[] {
  const out: string[] = [];
  for (const row of rows) {
    let current = '';
    let column = 0;
    for (const { segment } of SEGMENTER.segment(row)) {
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
