import stringWidth from 'string-width';

/**
 * A SIMULATED TERMINAL for the margin's witness (MVP-11 unit 9, review rounds 1 and 2: S-1, S2-1, M2-4): the fake terminal of the surface matrix
 * places one cell per UTF-16 unit and Ink sizes a row with `string-width`, so neither can see what a real terminal does with a character the two
 * measure differently. This one re-draws the rows a frame holds with the widths tmux 3.7b (the reference terminal) DREW in review round 2's
 * measurements (`TMUX_MEASUREMENTS` in `tmux-measurements.test-support.ts`: each string written after an `A`, the cursor read back with `ESC[6n`; the test
 * holds this function to every one of them): everything as `string-width` counts it, and on top of that, per grapheme cluster that is not an emoji
 * the layout already draws wide:
 *
 * - U+115F two columns; U+FFA0 and U+00AD one (every other default-ignorable code point, U+3164 included, none: as measured);
 * - U+FE0F one more on a cluster `string-width` counts one column (`a`+U+FE0F, a digit+U+FE0F: two);
 * - each skin tone U+1F3FB to U+1F3FF two more (`a`+U+1F3FD: three; five of them: eleven);
 * - each Thai or Lao AM (U+0E33, U+0EB3) one more;
 * - a pair of regional indicators that is not a flag one more (two columns);
 * - a lone surrogate one column (Node writes it as U+FFFD);
 * - (review round 3) the nine text-default emoji bases (`☝`, `✌`, …) one more without U+FE0F; a skin tone on one of the 64 bases tmux does not
 *   join a tone to two more; an emoji the layout draws wide only as a whole (a flag, `❤️`, a keycap) with more after it in its cluster two columns
 *   and what follows; a keycap without its selector one; the wide tone marks U+302E, U+302F, U+16FF0, U+16FF1 two more; U+2065, U+FFF0 to
 *   U+FFF8, U+E0000, U+E0002 to U+E001F one more (the sweep);
 * - (review rounds 4 and 5) an Indic conjunct, a Prepend cluster and a run of Kirat Rai vowel signs code point by code point (a letter right after a
 *   zero width joiner in the cell before it; U+FE0F widening a one-column cell to two); a spacing character after an emoji the layout draws wide
 *   as a whole (a halfwidth sound mark) in a cell of its own, unless it follows a zero width joiner, where tmux glues it into the emoji's cell;
 *   a chain of tag flags joined by joiners is NOT modelled (tmux draws it apart only when its cell overflows: `TMUX_SEQUENCE_FINDINGS`);
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
  if (code === 0x302e || code === 0x302f || code === 0x16ff0 || code === 0x16ff1) return 2;
  if (code === 0xffa0 || code === 0x00ad || code === 0x2065) return 1;
  if (
    (code >= 0xfff0 && code <= 0xfff8) ||
    code === 0xe0000 ||
    (code >= 0xe0002 && code <= 0xe001f)
  )
    return 1;
  if (code >= 0x1f3fb && code <= 0x1f3ff) return 2;
  if (code === 0x0e33 || code === 0x0eb3) return 1;
  if (code >= 0xd800 && code <= 0xdfff) return 1;
  return 0;
}

const isTone = (code: number): boolean => code >= 0x1f3fb && code <= 0x1f3ff;
/** The emoji modifier bases tmux 3.7b does NOT join a skin tone to (it draws the tone two more columns): measured in review round 3, all 138. */
const TONE_APART = new Set([
  0x261d, 0x26f9, 0x270a, 0x270b, 0x270c, 0x270d, 0x1f385, 0x1f3c2, 0x1f3c3, 0x1f3c4, 0x1f3c7,
  0x1f3ca, 0x1f3cb, 0x1f3cc, 0x1f442, 0x1f443, 0x1f446, 0x1f447, 0x1f448, 0x1f449, 0x1f44a, 0x1f46a,
  0x1f46b, 0x1f46c, 0x1f46d, 0x1f46f, 0x1f48f, 0x1f491, 0x1f574, 0x1f6a3, 0x1f6c0, 0x1f6cc, 0x1f90c,
  0x1f90f, 0x1f918, 0x1f919, 0x1f91a, 0x1f91b, 0x1f91c, 0x1f91d, 0x1f91e, 0x1f91f, 0x1f930, 0x1f931,
  0x1f932, 0x1f933, 0x1f934, 0x1f935, 0x1f936, 0x1f93c, 0x1f977, 0x1f9bb, 0x1fac3, 0x1fac4, 0x1fac5,
  0x1faf0, 0x1faf1, 0x1faf2, 0x1faf3, 0x1faf4, 0x1faf5, 0x1faf6, 0x1faf7, 0x1faf8,
]);
/** The nine text-default emoji bases tmux draws two columns (the layout one without U+FE0F). */
const NARROW_BASE = new RegExp('^(?!\\p{Emoji_Presentation})\\p{Emoji_Modifier_Base}', 'u');
/** An emoji the layout draws two columns only as a whole, at the start of a cluster: a flag, a narrow emoji with U+FE0F, a keycap. */
const WIDE_UNIT_PREFIX = new RegExp(
  `^(?:\\p{Regional_Indicator}{2}|(?!\\p{Emoji_Modifier})\\p{Emoji}${String.fromCodePoint(0xfe0f)}${String.fromCodePoint(0x20e3)}?)`,
  'u',
);

/**
 * The Indic conjunct linkers and the Prepend letters: a cluster with one in it (`क्ष`, `ൎy`) is ONE grapheme to `string-width` and several cells
 * to tmux, which draws every code point of it as it would alone (review round 4, R4-S-1: measured on the sequence differential, `TMUX_SEQUENCES`).
 */
const CLUSTER_JOINERS = new RegExp(
  `[${[
    0x094d, 0x09cd, 0x0acd, 0x0b4d, 0x0c4d, 0x0d4d, 0x1039, 0x17d2, 0x1a60, 0x1b44, 0x1bab, 0xa9c0,
    0xaaf6, 0x10a3f, 0x11133, 0x113d0, 0x1193e, 0x11a47, 0x11a99, 0x11f42, 0x0600, 0x0601, 0x0602,
    0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x0d4e, 0x110bd, 0x110cd,
    0x111c2, 0x111c3, 0x113d1, 0x1193f, 0x11941, 0x11a84, 0x11a85, 0x11a86, 0x11a87, 0x11a88,
    0x11a89, 0x11d46, 0x11f02,
    // review round 5 (R5-S-4): the Kirat Rai vowel signs, which this runtime joins as Hangul vowels are joined; tmux draws each in its own cell
    0x16d63,
    0x16d67, 0x16d68, 0x16d69, 0x16d6a,
  ]
    .map((code) => String.fromCodePoint(code))
    .join('')}]`,
  'u',
);
const ZWJ = String.fromCodePoint(0x200d);
const VS16 = String.fromCodePoint(0xfe0f);

/**
 * What tmux draws after an emoji it draws two columns, in the same cluster: a spacing character in a cell of its own (a halfwidth sound mark:
 * review round 5, R5-S-1), except right after a zero width joiner, where tmux glues it into the emoji's cell (a chain of pictographs: two
 * columns, measured); a tone two more unless the base takes it (`combined`), and the extras of the module header.
 */
function afterEmoji(rest: readonly string[], combined: boolean): number {
  return rest.reduce((sum, character, index) => {
    const code = character.codePointAt(0) ?? 0;
    if (isTone(code) && combined) return sum;
    const glued = rest[index - 1] === ZWJ;
    const own = glued || isTone(code) ? 0 : stringWidth(character, { countAnsiEscapeCodes: true });
    return sum + own + measuredExtra(code);
  }, 0);
}

/** The longest start of `characters` that is a recommended emoji sequence (at most 64 code points are tried), or `undefined`. */
function recommendedStart(characters: readonly string[]): number | undefined {
  for (let length = Math.min(characters.length - 1, 64); length > 0; length -= 1)
    if (RGI_EMOJI.test(characters.slice(0, length).join(''))) return length;
  return undefined;
}

/**
 * A cluster tmux does not join, drawn code point by code point (review rounds 4 and 5): each as it is alone, except a letter right after a zero
 * width joiner, which tmux draws in the cell before it (`क्‍ष` one cell, measured), and U+FE0F, which widens a one-column cell before it to two
 * (`ൎ❤️` 1 + 2, measured).
 */
function perCodePoint(characters: readonly string[]): number {
  let sum = 0;
  let cell = 0;
  characters.forEach((character, index) => {
    if (characters[index - 1] === ZWJ && /\p{L}/u.test(character)) return;
    if (character === VS16) {
      if (cell === 1) {
        sum += 1;
        cell = 2;
      }
      return;
    }
    const width = terminalWidth(character);
    if (width > 0) {
      sum += width;
      cell = width;
    }
  });
  return sum;
}

/** The columns the reference terminal draws one grapheme cluster in (see the module header; a TAB is the caller's: it depends on the column). */
export function terminalWidth(cluster: string): number {
  if (DRAWN_EMPTY.test(cluster)) return 0;
  const characters = [...cluster];
  // a conjunct, a Prepend cluster or a run of Kirat Rai vowel signs: each code point drawn as it is alone ({@link perCodePoint})
  if (characters.length > 1 && CLUSTER_JOINERS.test(cluster)) return perCodePoint(characters);
  const counted = stringWidth(cluster, { countAnsiEscapeCodes: true });
  const codes = [...cluster].map((character) => character.codePointAt(0) ?? 0);
  const base = codes[0] ?? 0;
  const tonesApart = TONE_APART.has(base) ? codes.slice(1).filter(isTone).length * 2 : 0;
  // a keycap without its selector: the layout counts two, tmux one
  if (KEYCAP.test(cluster) && !cluster.includes(String.fromCodePoint(0xfe0f))) return 1;
  if (RGI_EMOJI.test(cluster) || KEYCAP.test(cluster)) return counted + tonesApart;
  // an emoji drawn wide only as a whole, with more after it in the cluster: tmux draws the emoji two columns and the rest after it; the layout,
  // which no longer recognises the cluster, counts its first code point
  const unit = WIDE_UNIT_PREFIX.exec(cluster)?.[0];
  if (unit !== undefined && RGI_EMOJI.test(unit) && unit.length < cluster.length) {
    const combined = !TONE_APART.has(base) && NARROW_BASE.test(cluster);
    return 2 + afterEmoji([...cluster.slice(unit.length)], combined);
  }
  // a recommended sequence with more after it in its cluster (a family, then halfwidth sound marks: review round 5, R5-S-1)
  if (cluster.includes(ZWJ) && !codes.some(isTone)) {
    const start = recommendedStart(characters);
    if (start !== undefined) return 2 + afterEmoji(characters.slice(start), false);
  }
  let extra = tonesApart;
  let presentation = false;
  let first = true;
  for (const character of cluster) {
    const code = character.codePointAt(0) ?? 0;
    // a selector or a tone that starts a cluster has no base to widen: it is what `string-width` counts it (a tone alone is an emoji itself);
    // a tone on a base tmux joins it to adds nothing, on one it does not join it to it is counted above
    if (code === 0xfe0f) presentation = !first;
    else if (
      isTone(code) &&
      (first || TONE_APART.has(base) || /\p{Emoji_Modifier_Base}/u.test(String.fromCodePoint(base)))
    ) {
      // counted above, or joined
    } else extra += measuredExtra(code);
    first = false;
  }
  if (presentation && counted < 2) extra += 1;
  if (REGIONAL_PAIR.test(cluster) && counted < 2) extra += 1;
  // a narrow emoji base with no presentation selector: tmux two columns, the layout one
  if (NARROW_BASE.test(cluster) && !presentation && counted < 2) extra += 1;
  return counted + extra;
}

/**
 * Each grapheme cluster of `text` with the columns the reference terminal draws it in (a TAB is the caller's): {@link terminalWidth}, and one more for
 * a recommended sequence of several code points holding U+FE0F right after a cluster ending in U+200D (review round 6, R6-S-1: tmux glues it into the
 * cell the joiner left open, widens the cell with the sequence's selector and, the cell's buffer full, draws the sequence in a new two-column cell; measured
 * four where the two clusters alone are three).
 */
function* drawnClusters(
  text: string,
): Generator<{ readonly segment: string; readonly width: number }> {
  let afterJoiner = false;
  for (const { segment } of SEGMENTER.segment(text)) {
    const glued =
      afterJoiner && [...segment].length > 1 && segment.includes(VS16) && RGI_EMOJI.test(segment);
    yield { segment, width: segment === '\t' ? 0 : terminalWidth(segment) + (glued ? 1 : 0) };
    afterJoiner = segment.endsWith(ZWJ);
  }
}

/** The columns `text` takes on the reference terminal from column `start` (a TAB moves to the next multiple of eight). */
export function terminalColumns(text: string, start = 0): number {
  let column = start;
  for (const { segment, width } of drawnClusters(text))
    column = segment === '\t' ? column + 8 - (column % 8) : column + width;
  return column - start;
}

/** The physical rows a terminal `columns` wide shows for `rows` (each a row of a frame, its text only): a row too wide for it wraps. */
export function physicalRows(rows: readonly string[], columns: number): string[] {
  const out: string[] = [];
  for (const row of rows) {
    let current = '';
    let column = 0;
    for (const { segment, width } of drawnClusters(row)) {
      if (segment === '\t') {
        // a TAB moves to the next stop or to the last column, and never wraps by itself (what follows it does)
        column = Math.min(column + 8 - (column % 8), columns - 1);
        current += segment;
        continue;
      }
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
