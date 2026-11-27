/**
 * The screen's text filter and its width classifier (MVP-11 unit 9, review rounds 1 and 2: S-1, S-3, S2-1, S2-4, C2-1, M2-3): what a row of untrusted
 * text may hold when it is drawn on a terminal, so that the layout and the terminal count it alike.
 *
 * **Why.** The chat lays a row out with the width the layout measures (`string-width`), and the grid's margin guarantee is exact in that layout:
 * a row is at most the content column wide, in a cell that starts at the margin. A terminal measures some characters differently, and a row the
 * layout sized to fit can then reach the right edge on screen: the terminal wraps it, and the rest starts at column 0 of the next physical row,
 * the margin, where the host draws who spoke. The reference terminal is tmux 3.7b, measured code point by code point in review round 2 (each
 * string written after an `A`, the cursor read back with `ESC[6n`); `terminal-widths.test.ts` holds that table, `terminal-wrap.test-support.ts`
 * draws with it, and the witness tests draw every frame through it. Two cures, by class, both leaving `string-width`'s count of the filtered text
 * at least what tmux draws (`terminal-widths.test.ts` proves it for every measured class):
 *
 * - **Dropped** ({@link dropScreenFillers}): what the layout measures as 0 columns, so a row keeps its measured width without it. The default-
 *   ignorable code points and the other format characters (`\p{Default_Ignorable_Code_Point}`, `\p{Cf}`: the Hangul fillers, the soft hyphen,
 *   the word joiner and its kin, the tag and variation-selector supplements, the prepended concatenation marks, …; tmux draws U+115F two columns
 *   and U+FFA0 and U+00AD one), the emoji presentation selector U+FE0F where it does not make an emoji the layout already draws two columns wide
 *   (tmux draws `a`+U+FE0F, a digit+U+FE0F two columns), a skin tone U+1F3FB to U+1F3FF that does not follow a base that takes one (tmux draws
 *   each two columns), and a lone surrogate (written as U+FFFD, one column).
 * - **Rewritten** to a form both measure alike (ordinary text a terminal draws wider than the layout counts; the rewrite measured on tmux too):
 *   the Thai and Lao vowel AM (U+0E33, U+0EB3: one column more than the layout counts after a base) as its compatibility decomposition
 *   (U+0E4D U+0E32, U+0ECD U+0EB2: the same glyphs, which the layout and tmux both count as one column), and a pair of regional indicators that
 *   is not a flag (tmux two columns, the layout one) with a zero width non-joiner between the two (two clusters: two columns to both).
 *
 * **What is kept as it is.** The zero width joiner and non-joiner (U+200D, U+200C: emoji sequences, Indic and Arabic shaping) and the text
 * presentation selector U+FE0E, which tmux draws with no column of their own after a letter; U+FE0F on an emoji the layout draws two columns
 * wide (`❤️`, `™️`, a keycap); a skin tone on a base that takes one (`👍🏽`); the tag characters of an emoji tag sequence (U+E0020 to U+E007F after
 * the black flag U+1F3F4: a subdivision flag); a flag's pair of regional indicators. Not every terminal agrees with tmux: a terminal without
 * zero-width-joiner support draws a family as its members, and a CJK locale draws the ambiguous-width characters two columns (recorded
 * residuals; the only general cure is autowrap off, not done).
 *
 * **An orphan mark** (S-3): a combining mark or a kept joiner that starts a line has no character of its own to sit on, and a terminal paints it
 * on the cell before the row: the margin's last column. It is dropped at the start of each line, after the drops and rewrites (a leading Thai or
 * Lao AM is a mark and a vowel by then: the mark goes).
 *
 * **The consent surfaces** (S2-4) never drop or rewrite what is approved: the approval card escapes every code point of the risky classes as
 * `<U+XXXX>` ({@link isWidthRiskCodePoint}, `tool-review-projection.ts`), so what a person sees is what they approve, and as wide as it is drawn.
 *
 * **Linear.** Every pattern here is forward and bounded (review round 2, C2-1: the first version had a lookbehind that was quadratic on a run of
 * tag characters, 28 s of a stalled event loop for 64,000 of them): `screen-text-performance.test.ts` holds each function to a bound on a
 * 64,000-character hostile run of every class.
 *
 * Pure: no `ink`, no `react`, no `node:` import (ADR-0145 §10).
 */

const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const VS15 = String.fromCodePoint(0xfe0e);
const VS16 = String.fromCodePoint(0xfe0f);
const KEYCAP = String.fromCodePoint(0x20e3);
const BLACK_FLAG = String.fromCodePoint(0x1f3f4);
const TAG_FIRST = String.fromCodePoint(0xe0020);
const TAG_LAST = String.fromCodePoint(0xe007f);
const THAI_AM = String.fromCodePoint(0x0e33);
const LAO_AM = String.fromCodePoint(0x0eb3);
/** The compatibility decompositions of the two AM vowels: NIKHAHIT + SARA AA, NIGGAHITA + LAO AA. */
const DECOMPOSED_AM: Readonly<Record<string, string>> = {
  [THAI_AM]: `${String.fromCodePoint(0x0e4d)}${String.fromCodePoint(0x0e32)}`,
  [LAO_AM]: `${String.fromCodePoint(0x0ecd)}${String.fromCodePoint(0x0eb2)}`,
};

/** An emoji the layout draws two columns wide (a recommended-for-general-interchange sequence, `string-width`'s own test). */
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');
/** A keycap, with or without its presentation selector (`string-width` draws it two columns wide too). */
const KEYCAP_SEQUENCE = new RegExp(`^[0-9#*]${VS16}?${KEYCAP}$`, 'u');

/**
 * The one forward pass of {@link dropScreenFillers}. At each position, in order: an emoji tag sequence (kept), a skin tone on a base that takes
 * one (kept), a run of regional indicators (its flags kept, every other indicator set apart), an emoji with its presentation selector and an optional keycap
 * (kept when the layout draws it wide, else the selector dropped), a kept joiner or the text selector (kept), the Thai or Lao AM (decomposed);
 * else a code point of the dropped classes. No lookbehind and no nested quantifier: linear.
 */
const SCREEN_PASS = new RegExp(
  [
    `(${BLACK_FLAG}[${TAG_FIRST}-${TAG_LAST}]*)`,
    '(\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier})',
    '(\\p{Regional_Indicator}+)',
    `((?!\\p{Emoji_Modifier})\\p{Emoji}${VS16}${KEYCAP}?)`,
    `(${ZWNJ}|${ZWJ}|${VS15})`,
    `(${THAI_AM}|${LAO_AM})`,
    '[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Emoji_Modifier}\\p{Cs}]',
  ].join('|'),
  'gu',
);

/**
 * A run of combining marks and kept joiners at the start of a line: nothing of its own to sit on. A leading Thai or Lao AM is among them: the
 * filter has decomposed it by then, and its NIKHAHIT (a mark) goes while its AA (a spacing vowel, a cell of its own) stays.
 */
const ORPHAN_LEAD = new RegExp(`^(?:\\p{M}|${ZWNJ}|${ZWJ})+`, 'gmu');

/** The code points a terminal may draw wider than the layout counts, wherever they stand (see {@link isWidthRiskCodePoint}). */
const WIDTH_RISK = new RegExp(
  `[\\p{Emoji_Modifier}\\p{Regional_Indicator}\\p{Cs}${VS16}${THAI_AM}${LAO_AM}]`,
  'u',
);

/**
 * A run of regional indicators as the screen draws it: taken in pairs from its start, as a terminal pairs them; a pair that is a flag stays a
 * pair, and every other indicator is set apart from the next by a zero width non-joiner, so no two of them that are not a flag form one cluster
 * (the layout counts such a cluster one column, tmux draws two). Linear in the run.
 */
function splitRegional(run: string): string {
  const indicators = [...run];
  const pieces: string[] = [];
  for (let at = 0; at < indicators.length; at += 2) {
    const pair = `${indicators[at] ?? ''}${indicators[at + 1] ?? ''}`;
    if (at + 1 < indicators.length && RGI_EMOJI.test(pair)) pieces.push(pair);
    else pieces.push(...[...pair]);
  }
  return pieces.join(ZWNJ);
}

/** What one match of {@link SCREEN_PASS} becomes: the kept groups as they are, the rest rewritten or dropped (see the pattern). */
function keepOrDrop(
  match: string,
  flag: string | undefined,
  toned: string | undefined,
  regional: string | undefined,
  presented: string | undefined,
  joiner: string | undefined,
  vowel: string | undefined,
): string {
  if (flag !== undefined || toned !== undefined || joiner !== undefined) return match;
  if (regional !== undefined) return splitRegional(regional);
  if (presented !== undefined)
    return RGI_EMOJI.test(presented) || KEYCAP_SEQUENCE.test(presented)
      ? presented
      : presented.replace(VS16, '');
  return vowel === undefined ? '' : (DECOMPOSED_AM[vowel] ?? '');
}

/**
 * `text` with the dropped classes dropped (see the module header): the code points the layout measures as 0 columns and a terminal may draw
 * wider. Newlines and everything else kept; one forward pass.
 */
export function dropScreenFillers(text: string): string {
  return text.replace(SCREEN_PASS, keepOrDrop);
}

/** `text` with the combining marks and joiners that start a line (the text's, and each after a newline) dropped (after {@link dropScreenFillers}). */
export function dropOrphanMarks(text: string): string {
  return text.replace(ORPHAN_LEAD, '');
}

/**
 * Untrusted text made fit for a row of the screen: the dropped classes dropped, then the orphan marks at the start of each line. Neither changes
 * the width the layout measures (both are 0 columns to it), so a row filtered after it was laid out keeps its place and its row count.
 */
export function screenText(text: string): string {
  return dropOrphanMarks(dropScreenFillers(text));
}

/**
 * The same filter over a row cut in styled pieces: the dropped classes dropped from every piece, and the orphan marks from the start of the ROW
 * (the first pieces, across an empty one). The pieces keep their order and their styles; a piece the filter empties is kept, empty. Returns the
 * very same array when nothing changed.
 */
export function screenPieces<Piece extends { readonly text: string }>(
  pieces: readonly Piece[],
): readonly Piece[] {
  let leading = true;
  let changed = false;
  const out = pieces.map((piece) => {
    let text = dropScreenFillers(piece.text);
    if (leading) {
      text = text.replace(ORPHAN_LEAD, '');
      if (text !== '') leading = false;
    }
    if (text === piece.text) return piece;
    changed = true;
    return { ...piece, text };
  });
  return changed ? out : pieces;
}

/**
 * Whether a code point is one a terminal may draw wider than the layout counts in SOME context: U+FE0F, a skin tone, a regional indicator, a
 * lone surrogate, the Thai or Lao AM. The approval card escapes every one of them as `<U+XXXX>` wherever it stands (a consent surface shows what
 * is approved and never drops it; it escapes U+FE0F and a surrogate already as invisible).
 */
export function isWidthRiskCodePoint(character: string): boolean {
  return WIDTH_RISK.test(character);
}
