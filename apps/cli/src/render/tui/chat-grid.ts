import { glyphOf, type GlyphRole } from './glyphs.js';
import { HOME_RAIL_MAX_WIDTH, homeMargin } from './home-layout.js';

/**
 * The chat's grid ([MVP-11 §4.8](../../../../../docs/roadmap/phases/mvp-11.md#48-the-chat), [ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §6, unit 9): a MARGIN column on the left that belongs to the host (the speaker marker, the tool glyph, and in the inline renderer the role
 * words) and a CONTENT column that holds every word a person or a model wrote. The content column starts where the Home's wordmark starts
 * ({@link homeMargin}: 6 columns for 80 to 99, 8 from 100) and is as wide as the Home's rail (`min(96, columns − 2 × margin)`: 68 at 80
 * columns, 84 at 100). Model text is laid out in the content column only, so it can never occupy the marker's place: that is the reason the
 * marker is a typed role here ({@link MarginRole}) and never a character of a row's text.
 *
 * Pure data and pure functions: this module imports no `ink`, `react` or `node:` module (ADR-0145 §10), only the glyph table and the Home's
 * layout constants. Nothing here is drawn from configuration or from a model: the margin cell is composed from product constants alone.
 *
 * **The marker's column.** The frames of the plan (`chat-idle-80x24.png`) put the glyph in the third column left of the content (column 3 at
 * 80 columns, 5 from 100): {@link ChatGrid.markerEnd} is the last column of a glyph, and two blank columns follow it before the content.
 * A glyph that does not fit (a plain form wider than the room, or a terminal so narrow that the margin has no marker column) is not drawn:
 * the margin stays blank and the row is still the person's turn by its weight (bold), never by a forged glyph.
 */

/** The narrowest content column the grid keeps: a terminal that cannot give a margin and this much text gives the margin up first. */
export const GRID_MIN_CONTENT_COLUMNS = 16;

/** The columns a glyph's two blank neighbours take: the marker ends this many columns before the content starts. */
export const MARKER_GAP_COLUMNS = 2;

/** The grid for one terminal width. Every field is a whole number of columns. */
export interface ChatGrid {
  /** The terminal's columns (0 for a suspended grid: a width that is not a number, or below 1). */
  readonly columns: number;
  /** The left margin: where the content column starts. 0 when the terminal is too narrow for a margin. */
  readonly margin: number;
  /** The content column's width: the room a row's text may take. */
  readonly content: number;
  /** The columns from the content column's start to the terminal's right edge (one-line rows: the status line, the hint). */
  readonly text: number;
  /** The last column of a marker glyph (`margin − 3`); below 0 there is no marker column. */
  readonly markerEnd: number;
}

/** The grid of a width that is not drawable (not a number, or below 1): no rows, no margin. */
export const SUSPENDED_GRID: ChatGrid = Object.freeze({
  columns: 0,
  margin: 0,
  content: 0,
  text: 0,
  markerEnd: -1,
});

/**
 * The grid for `columns`. The margin is the Home's; on a terminal too narrow to give it and {@link GRID_MIN_CONTENT_COLUMNS} columns of text
 * it shrinks to `floor((columns − 16) / 2)`, so that the text keeps its room before the margin does: 0 at 17 columns and fewer, 1 at 18 and 19,
 * 2 at 20 and 21, 3 at 22 and 23, 4 at 24 and 25, 5 at 26 and 27, the Home's 6 from 28. A glyph needs a margin of 3 (two blank columns
 * after it), so the marker is drawn from 22 columns; a word needs its length and one blank column. A width that is not a finite number of at
 * least 1 is the {@link SUSPENDED_GRID}.
 */
export function chatGrid(columns: number): ChatGrid {
  if (!Number.isFinite(columns) || columns < 1) return SUSPENDED_GRID;
  const wide = Math.floor(columns);
  const margin = Math.max(
    0,
    Math.min(homeMargin(wide), Math.floor((wide - GRID_MIN_CONTENT_COLUMNS) / 2)),
  );
  return {
    columns: wide,
    margin,
    content: Math.max(1, Math.min(HOME_RAIL_MAX_WIDTH, wide - 2 * margin)),
    text: Math.max(1, wide - margin),
    markerEnd: margin - (MARKER_GAP_COLUMNS + 1),
  };
}

/**
 * What the margin of a row can say, closed on purpose: only the host sets one, from a fixed set, so no string of a model or a person can be one.
 * `yourTurn` is the first row of the person's turn (and the host's question record), `toolCall` a row of a tool call, `modelSwitch` the host's
 * model-switch notice, `agent` the first row of a reply, and `notice` a row of a notice. `agent` and `notice` have no glyph: they are drawn only
 * as the inline renderer's word (the full-screen reply and notice have no marker), which is also how a row of a reply or a notice that starts
 * with one of the words says whose it is there (review round 1, S-2).
 */
export type MarginRole = 'yourTurn' | 'toolCall' | 'modelSwitch' | 'agent' | 'notice';

/** How a margin cell is drawn: the table's glyph, its plain (ASCII) form, or the inline renderer's role word. */
export type MarginForm = 'glyph' | 'ascii' | 'word';

/**
 * The inline renderer's words (a screen reader reads them where it would skip a glyph). Closed and ASCII. A notice and the model-switch notice
 * share `note` (the switch's sentence starts with `model changed`, so the word `model` read twice; review round 1, D-5).
 */
export const MARGIN_WORDS: Readonly<Record<MarginRole, string>> = Object.freeze({
  yourTurn: 'you',
  toolCall: 'tool',
  modelSwitch: 'note',
  agent: 'agent',
  notice: 'note',
});

/** The words of {@link MARGIN_WORDS}, once each. */
const WORDS: readonly string[] = [...new Set(Object.values(MARGIN_WORDS))];

/**
 * A row's text that a screen reader could hear as a margin word: one of {@link MARGIN_WORDS} (any case, a whole word) at the start of the text,
 * after only what a reader does not announce or a person does not read as a word: white space, format and zero-width characters, combining marks
 * and the box-drawing gutters of a quotation or a code block (U+2500 to U+257F).
 */
const MARGIN_WORD_LEAD = new RegExp(
  `^[\\s\\p{Cf}\\p{M}${String.fromCodePoint(0x2500)}-${String.fromCodePoint(0x257f)}]*(?:${WORDS.join('|')})(?![\\p{L}\\p{N}_])`,
  'iu',
);

/**
 * Whether `text` starts with a margin word ({@link MARGIN_WORD_LEAD}): the inline renderer then puts the row's own entry's word in its margin, so
 * a reply or a notice row that begins `you   …` is read as `agent you …` or `note you …`, never as the person's turn (review round 1, S-2).
 */
export function startsWithMarginWord(text: string): boolean {
  return MARGIN_WORD_LEAD.test(text);
}

/** The glyph-table role each margin role draws as a glyph, when it has one (a reply and a notice have none). */
const GLYPH_OF_ROLE: Readonly<Partial<Record<MarginRole, GlyphRole>>> = {
  yourTurn: 'yourTurn',
  toolCall: 'toolCall',
  modelSwitch: 'modelSwitch',
};

/**
 * The margin cell of a row: exactly {@link ChatGrid.margin} columns of ASCII spaces and the role's mark, composed from product constants alone.
 * No row text goes in, so a margin cannot be made to say anything the table and the word list do not.
 *
 * - `glyph` and `ascii`: the table's mark, right-aligned so that it ends at {@link ChatGrid.markerEnd}; blank when the role has no glyph
 *   (a reply) or the mark does not fit.
 * - `word`: the role's word, left-aligned at column 0 with at least one blank column before the content; blank when it does not fit.
 * - no role (`undefined`): blank.
 */
export function marginCell(role: MarginRole | undefined, grid: ChatGrid, form: MarginForm): string {
  if (grid.margin <= 0) return '';
  const blank = ' '.repeat(grid.margin);
  if (role === undefined) return blank;
  if (form === 'word') {
    const word = MARGIN_WORDS[role];
    return word.length + 1 <= grid.margin ? word.padEnd(grid.margin) : blank;
  }
  const glyphRole = GLYPH_OF_ROLE[role];
  if (glyphRole === undefined) return blank;
  const mark = glyphOf(glyphRole, form === 'ascii');
  const width = [...mark].length;
  const start = grid.markerEnd - width + 1;
  if (start < 0) return blank;
  return `${' '.repeat(start)}${mark}${' '.repeat(grid.margin - start - width)}`;
}
