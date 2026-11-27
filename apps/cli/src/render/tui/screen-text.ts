/**
 * The screen's text filter (MVP-11 unit 9, review round 1, S-1 and S-3): what a row of untrusted text may hold when it is drawn on a terminal.
 *
 * **Why.** The chat lays a row out with the width Ink measures (`string-width`), and the grid's margin guarantee is exact in that layout: a row
 * is at most the content column wide, in a cell that starts at the margin. A terminal measures some characters differently. The default-ignorable
 * code points (`\p{Default_Ignorable_Code_Point}`: the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, the soft hyphen U+00AD, the combining
 * grapheme joiner U+034F, the Khmer and Mongolian invisible vowels and selectors, the word joiner and its kin, the tag and variation-selector
 * supplements, …) measure 0 columns to the layout, and a terminal may draw them 1 or 2 columns wide (tmux draws U+115F two columns). A row the
 * layout sizes to fit can then reach the right edge on screen, the terminal wraps it, and the rest of the row starts at column 0 of the next
 * physical row: the margin, where the host draws who spoke. So these code points are dropped from every row of untrusted text on its way to the
 * screen; the documents (`/edit`, `/copy`, `/scrollback`) keep them, byte for byte.
 *
 * **What is kept.** The joiners and selectors that build what a person reads, and that every terminal draws with no column of their own: the zero
 * width joiner and non-joiner (U+200D, U+200C: emoji sequences, Indic and Arabic shaping), the text and emoji presentation selectors (U+FE0E,
 * U+FE0F: a keycap, an emoji), and the tag characters of an emoji tag sequence (U+E0020 to U+E007F after the black flag U+1F3F4: a subdivision
 * flag). It is the set core already refuses in a model's question (`INVISIBLE_LETTER`, `packages/core/src/tools/ask-user.ts`), less those.
 *
 * **An orphan mark** (S-3): a combining mark (or a kept joiner) that starts a row has no character of its own to sit on, and a terminal paints it
 * on the cell before the row: the margin's last column. It is dropped at the start of each line.
 *
 * Pure: no `ink`, no `react`, no `node:` import (ADR-0145 §10).
 */

const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const VS15 = String.fromCodePoint(0xfe0e);
const VS16 = String.fromCodePoint(0xfe0f);
const BLACK_FLAG = String.fromCodePoint(0x1f3f4);
const TAG_FIRST = String.fromCodePoint(0xe0020);
const TAG_LAST = String.fromCodePoint(0xe007f);

/**
 * A default-ignorable code point that is not one of the kept joiners and selectors, and not a tag character of an emoji tag sequence (one that
 * follows the black flag and the tags before it).
 */
const SCREEN_FILLER = new RegExp(
  `(?!${ZWNJ}|${ZWJ}|${VS15}|${VS16})(?!(?<=${BLACK_FLAG}[${TAG_FIRST}-${TAG_LAST}]*)[${TAG_FIRST}-${TAG_LAST}])\\p{Default_Ignorable_Code_Point}`,
  'gu',
);

/** A run of combining marks and kept joiners at the start of a line: nothing of its own to sit on. */
const ORPHAN_LEAD = new RegExp(`^(?:\\p{M}|${ZWNJ}|${ZWJ})+`, 'gmu');

/** `text` with the fillers a terminal may draw wider than the layout measures dropped (see the module header). Newlines and everything else kept. */
export function dropScreenFillers(text: string): string {
  return text.replace(SCREEN_FILLER, '');
}

/** `text` with the combining marks and joiners that start a line (the text's, and each after a newline) dropped. */
export function dropOrphanMarks(text: string): string {
  return text.replace(ORPHAN_LEAD, '');
}

/**
 * Untrusted text made fit for a row of the screen: the fillers dropped, then the orphan marks at the start of each line. Neither changes the
 * width the layout measures (both are 0 columns to it), so a row filtered after it was laid out keeps its place and its row count.
 */
export function screenText(text: string): string {
  return dropOrphanMarks(dropScreenFillers(text));
}

/**
 * The same filter over a row cut in styled pieces: the fillers dropped from every piece, and the orphan marks from the start of the ROW (the first
 * pieces, across an empty one). The pieces keep their order and their styles; a piece the filter empties is kept, empty. Returns the very same
 * array when nothing changed.
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
