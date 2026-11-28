import { glyphOf } from './glyphs.js';
import { PROMPT_WINDOW_MIN_ROWS } from './prompt-window.js';

/**
 * The empty Home's block as DATA ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §1, [MVP-11 §4.7](../../../../../docs/roadmap/phases/mvp-11.md#47-the-home)): the margins, the rail's width, the wordmark, the rail
 * (its nodes, its labels and notes, where each starts), the block's top gap and the prompt's example. Every number here is the one the
 * frames `home-empty-80x24.png` and `home-empty-100x30.png` were measured to carry (a label starts at column 25 of the 68-column rail at
 * 80 columns, and so on), and the tests hold them to it.
 *
 * Pure, with no wiring: the view that draws the block, the notice that counts its room and the controller that fills the example read these
 * constants and functions, so the three heights the old banner wrote in three places are {@link HOME_BLOCK_ROWS}. Nothing here
 * sanitises, because nothing here is drawn from configuration: the wordmark, the labels and the example are product constants.
 *
 * A data module: it imports nothing from `ink`, `react` or `node:` (ADR-0145 §10), only the glyph table and the prompt window's constants.
 */

/** The left margin, in columns: 8 from 100 columns, 6 below (the Home's floor is 80, so this is 80 to 99 in practice). */
export function homeMargin(columns: number): number {
  return columns >= 100 ? 8 : 6;
}

/** The widest the rail grows: past it a longer rail only spreads the three labels further apart. */
export const HOME_RAIL_MAX_WIDTH = 96;

/** The rail's width: the columns the two margins leave, at most {@link HOME_RAIL_MAX_WIDTH} (68 at 80 columns, 84 at 100, 96 from 112). */
export function homeRailWidth(columns: number): number {
  if (!Number.isFinite(columns)) return 0;
  return Math.max(0, Math.min(HOME_RAIL_MAX_WIDTH, columns - 2 * homeMargin(columns)));
}

/**
 * The rows a full-screen frame is bounded to: one fewer than the terminal, never fewer than one, and one for a size that is not a number. A
 * frame as tall as the terminal makes Ink treat it as full-screen and clear the whole terminal (the scrollback with it) on every update, so every
 * host of a frame (the Home's pages, the chat) leaves the last row alone, and every geometry reads THIS function: it is the one place the rule is written.
 */
export function frameRows(terminalRows: number): number {
  return Number.isFinite(terminalRows) ? Math.max(1, Math.floor(terminalRows) - 1) : 1;
}

/** The columns the Home's prompts spend before their text: the prompt's glyph (`›`, ASCII `>`) and the space after it, and the same width of spaces under it. */
export const HOME_PROMPT_LEAD_COLUMNS = 2;

/** The wordmark, letter-spaced with two spaces between letters (22 columns); the view draws it bold in the accent. */
export const WORDMARK = 'R  E  L  A  V  I  U  M';

/** The rows above the landing's prompt when the block is shown: the wordmark, a blank row, the rail, the labels and the notes. */
export const LANDING_BLOCK_HEAD_ROWS = 5;

/** The rows above the landing's prompt when the block is not shown: the one-line title (the spaced wordmark, {@link WORDMARK}). */
export const LANDING_TITLE_ROWS = 1;

/** The rows under the landing's prompt: the rule, the status line, a blank row and the hint. */
export const LANDING_FOOT_ROWS = 4;

/** The rows of the block: wordmark, blank, rail, tagline, note, blank, blank, prompt, rule, status, blank, hint. */
export const HOME_BLOCK_ROWS = LANDING_BLOCK_HEAD_ROWS + 2 + 1 + LANDING_FOOT_ROWS;

/**
 * Whether the landing draws the block (wordmark, rail, taglines, notes) or only the one-line title (maintainer, 2026-11-26): the block is
 * page 1's, and page 1 is the landing in BOTH states of the Home (nothing to continue, or something to continue behind `↓`), so `show_banner`
 * absent or `true` shows the block and `false` shows the one-line spaced wordmark instead, whatever the Home holds. The one rule: the view
 * and the notice's room ask here.
 */
export function showsLandingBlock(configShowBanner: boolean | undefined): boolean {
  return configShowBanner !== false;
}

/**
 * Whether the prompt shows its example: on the landing, with nothing typed. The view draws the example by this and `Tab` fills it by this,
 * so a key never fills what is not on screen.
 */
export function exampleIsShown(onLanding: boolean, draft: string): boolean {
  return onLanding && draft === '';
}

/** What the landing's height depends on besides the block: the prompt's rows, a notice's rows and the hosted run's row (all default to the resting case). */
export interface LandingRowParts {
  readonly promptRows?: number | undefined;
  readonly noticeRows?: number | undefined;
  readonly runRows?: number | undefined;
}

/** `value` as a whole count of at least `min`; `min` for a value that is not a number. */
function wholeCount(value: number | undefined, min: number): number {
  return value === undefined || !Number.isFinite(value) ? min : Math.max(min, Math.floor(value));
}

/**
 * The rows between the head and the prompt: two under the block, one under the one-line title. A notice stands in those rows, directly over
 * the prompt, with one blank row above it (the block's second blank row; the title has none to spare), so a notice of one row under the block
 * does not move the prompt at all (OB76) and a taller one, or any under the title, moves it by the rows it needs: with a notice of `n` rows the
 * gap is `max(resting, n + 1)`.
 */
export function landingGapRows(showBlock: boolean, noticeRows = 0): number {
  const notice = wholeCount(noticeRows, 0);
  const resting = showBlock ? 2 : 1;
  return notice > 0 ? Math.max(resting, notice + 1) : resting;
}

/**
 * The height of the landing in rows, WITHOUT its top gap: the head (the block's five rows, or the one-line title), the gap (or the notice with
 * its blank row above it), the prompt, the four rows under it, and the hosted run's row (between the status line and the hint: MVP-11 unit 7, the
 * study's frame 21). The ONE place that knows it: the banner's height used to be written in three places. The resting landing is
 * {@link HOME_BLOCK_ROWS}.
 */
export function landingRows(showBlock: boolean, parts: LandingRowParts = {}): number {
  return (
    landingRowsAbovePrompt(showBlock, parts) +
    wholeCount(parts.promptRows, 1) +
    LANDING_FOOT_ROWS +
    wholeCount(parts.runRows, 0)
  );
}

/**
 * The rows of the landing above its prompt, without the top gap: the head and the gap (or the notice with its blank row above it). What the
 * palette is drawn below, when it takes the prompt block's place (the hosted run's row is part of that block: it stands under the status line).
 */
export function landingRowsAbovePrompt(showBlock: boolean, parts: LandingRowParts = {}): number {
  const head = showBlock ? LANDING_BLOCK_HEAD_ROWS : LANDING_TITLE_ROWS;
  return head + landingGapRows(showBlock, parts.noticeRows);
}

/**
 * The most rows a notice may take on the landing: what the terminal's `rows − 1` leaves once the head, the hosted run's row, the notice's
 * blank row above it, the prompt and its four rows are drawn (the landing stays one row short of the terminal, as the chat's frame does), and
 * never fewer than two so a notice is always readable.
 */
export function landingNoticeRoom(
  rows: number,
  showBlock: boolean,
  parts: Omit<LandingRowParts, 'noticeRows'> = {},
): number {
  if (!Number.isFinite(rows)) return 2;
  return Math.max(2, frameRows(rows) - (landingRows(showBlock, { ...parts, noticeRows: 1 }) - 1));
}

/**
 * The most rows the landing's prompt editor may take (OB71): what `rows − 1` leaves once everything else of the landing is drawn (the head,
 * the gap or the notice, the four rows under the prompt and the hosted run's row), never fewer than a window can have
 * ({@link PROMPT_WINDOW_MIN_ROWS}). A draft that is longer is drawn as a window of its rows around the cursor with a `▲/▼ N more` marker, so
 * the head, the cursor, the rule, the status line and the hint stay on the screen and the frame is never as tall as the terminal. At 80×24 with
 * the block that is 12 rows (a draft of twelve lines is drawn whole, as it always was), 17 with the one-line title.
 */
export function landingEditorRows(
  rows: number,
  showBlock: boolean,
  parts: Omit<LandingRowParts, 'promptRows'> = {},
): number {
  return Math.max(
    PROMPT_WINDOW_MIN_ROWS,
    frameRows(rows) - (landingRows(showBlock, { ...parts, promptRows: 1 }) - 1),
  );
}

/**
 * The rows of blank space above the block. Inline there is none (nothing blank is pushed into the terminal's scrollback). In the alternate
 * screen the block sits above the middle: its centre is 3.5 rows above the terminal's centre (the frames), which is
 * `⌊(rows − block) / 2⌋ − 3`, floored at 0 (3 rows at 24, 6 at 30, 11 at 40). The result is also held to `gap + block ≤ rows − 1`, the
 * Home's bound of one row less than the screen; for every finite `rows` the formula already keeps to it (the clamp is the stated invariant,
 * not a case that arises), and a terminal too short for the block gets no gap.
 */
export function homeTopGap(rows: number, alternateScreen: boolean): number {
  if (!alternateScreen || !Number.isFinite(rows)) return 0;
  const centred = Math.floor((rows - HOME_BLOCK_ROWS) / 2) - 3;
  return Math.max(0, Math.min(centred, frameRows(rows) - HOME_BLOCK_ROWS));
}

/**
 * The landing's top gap: {@link homeTopGap} for the block, and nothing for the one-line title (it sits at the top), held to what `rows − 1`
 * leaves once the landing's own rows are drawn, so a notice, a hosted run's row or a prompt that has grown give the gap up before anything
 * else gives way. Inline there is none. An open `/` palette claims none of it (page 1 never moves, OB72): the palette is drawn below the prompt.
 */
export function landingTopGap(
  rows: number,
  alternateScreen: boolean,
  showBlock: boolean,
  parts: LandingRowParts = {},
): number {
  if (!showBlock || !Number.isFinite(rows)) return 0;
  const free = frameRows(rows) - landingRows(showBlock, parts);
  return Math.max(0, Math.min(homeTopGap(rows, alternateScreen), free));
}

/** One node of the rail with the words under it. `strong` is the label the view draws bold: where the user starts. */
export interface RailLabel {
  readonly label: string;
  readonly note: string;
  readonly strong?: true;
}

/** The tagline split across the rail's nodes, left to right, each with its note. The last note is revisited when history retention lands. */
export const RAIL_LABELS: readonly RailLabel[] = [
  { label: 'Start as an agent', note: 'talk to an agent', strong: true },
  { label: 'Ship the workflow', note: 'save it as YAML' },
  { label: 'Own every run', note: 'every run kept' },
];

/**
 * The columns of the rail's three nodes: the left end, the middle column `⌊(width − 1) / 2⌋`, the right end. For a rail narrower than
 * three columns two nodes share a column, and the first one drawn wins ({@link railRows} writes the right one first).
 */
export function railNodeColumns(width: number): readonly [number, number, number] {
  const last = Math.max(0, width - 1);
  return [0, Math.floor(last / 2), last];
}

/**
 * The narrowest rail that draws all three labels. Below it the rows keep the LEFT label and its note only: at 62 columns the three
 * labels are two or more columns apart, and a rail narrower than that is a terminal narrower than the Home's own floor, so this is the
 * documented fallback of a state the Home does not draw. A rail narrower than the first label draws no label at all, never half of one.
 */
export const RAIL_FULL_MIN_WIDTH = 62;

/** One label and its note placed on the rail: the column each starts at, and the node it hangs from. */
export interface RailPlacement {
  readonly label: string;
  readonly note: string;
  readonly strong: boolean;
  readonly nodeColumn: number;
  readonly labelStart: number;
  readonly noteStart: number;
}

/** The rail as three rows of plain text, each exactly `width` columns, and where each label and note starts (a view styles them by span). */
export interface RailRows {
  readonly node: string;
  readonly labels: string;
  readonly notes: string;
  readonly placements: readonly RailPlacement[];
}

/**
 * Where a text of `length` columns starts under the node at `nodeColumn`: the first hangs from column 0, the last ENDS at the rail's last
 * column, and the middle one is centred on its node (its start is the node column less half its length, rounded down).
 */
function startOf(
  index: number,
  count: number,
  length: number,
  nodeColumn: number,
  width: number,
): number {
  if (index === 0) return 0;
  if (index === count - 1) return width - length;
  return nodeColumn - Math.floor(length / 2);
}

/** `placed` as a row of exactly `width` columns: each text at its start, spaces between. The texts are ASCII constants, so a length is a width. */
function rowOf(
  placed: readonly { readonly text: string; readonly start: number }[],
  width: number,
): string {
  let row = '';
  for (const { text, start } of placed) row += ' '.repeat(Math.max(0, start - row.length)) + text;
  return row + ' '.repeat(Math.max(0, width - row.length));
}

/** The labels this width can hold: all three from {@link RAIL_FULL_MIN_WIDTH}, the left one below it, none when even that one cannot fit. */
function labelsFor(width: number): readonly RailLabel[] {
  if (width >= RAIL_FULL_MIN_WIDTH) return RAIL_LABELS;
  const [first] = RAIL_LABELS;
  return first !== undefined && width >= Math.max(first.label.length, first.note.length)
    ? [first]
    : [];
}

/** The node row: the fill glyph everywhere but the three nodes, the current step at the left and a pending step at the other two. */
function nodeRow(width: number, ascii: boolean): string {
  if (width < 1) return '';
  const cells = Array.from({ length: width }, () => glyphOf('railLine', ascii));
  const [left, middle, right] = railNodeColumns(width);
  cells[right] = glyphOf('pending', ascii);
  cells[middle] = glyphOf('pending', ascii);
  cells[left] = glyphOf('currentStep', ascii);
  return cells.join('');
}

/**
 * The rail of the empty Home for a rail `width` columns wide: the node row (`◉╌╌…╌○╌╌…╌○`, or `@..…..o..…..o` without colour: the same
 * columns), the labels row and the notes row, each exactly `width` columns, plus the placement of every label and note. A label never
 * overlaps another or touches it (two columns or more between, from {@link RAIL_FULL_MIN_WIDTH}); below that width see
 * {@link RAIL_FULL_MIN_WIDTH}. At width 68: nodes at 0, 33 and 67, labels at 0, 25 and 55, notes at 0, 26 and 54.
 */
export function railRows(width: number, ascii: boolean): RailRows {
  const size = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const nodes = railNodeColumns(size);
  const labels = labelsFor(size);
  const placements = labels.map((entry, index): RailPlacement => {
    const nodeColumn = nodes[index] ?? 0;
    return {
      label: entry.label,
      note: entry.note,
      strong: entry.strong === true,
      nodeColumn,
      labelStart: startOf(index, labels.length, entry.label.length, nodeColumn, size),
      noteStart: startOf(index, labels.length, entry.note.length, nodeColumn, size),
    };
  });
  return {
    node: nodeRow(size, ascii),
    labels: rowOf(
      placements.map((place) => ({ text: place.label, start: place.labelStart })),
      size,
    ),
    notes: rowOf(
      placements.map((place) => ({ text: place.note, start: place.noteStart })),
      size,
    ),
    placements,
  };
}

/**
 * The example the empty prompt shows. It is never sent: the first keystroke replaces it, and the key that fills it in is the Home's own
 * (ADR-0146 §1).
 */
export const EXAMPLE_PROMPT = 'summarize the files in this folder';

/** The example as it is drawn: bare where colour dims it, with an `e.g.` in front where it cannot (dim is never relied on). */
export function exampleText(noColour: boolean): string {
  return noColour ? `e.g. ${EXAMPLE_PROMPT}` : EXAMPLE_PROMPT;
}

/** The widest rule {@link thinRule} draws: no terminal is wider, and a count past it is a defect upstream, never a string that long. */
export const THIN_RULE_MAX_WIDTH = 400;

/**
 * The thin rule under the prompt: the glyph table's thin rule repeated `width` times (nothing for a width of zero or less, and nothing for a
 * width that is not a number or not finite: a terminal that reports `Infinity` columns while it is suspended must not make `repeat` throw a
 * `RangeError`). A width past {@link THIN_RULE_MAX_WIDTH} is drawn that wide.
 */
export function thinRule(width: number, ascii: boolean): string {
  const count = Number.isFinite(width)
    ? Math.min(THIN_RULE_MAX_WIDTH, Math.max(0, Math.floor(width)))
    : 0;
  return glyphOf('thinRule', ascii).repeat(count);
}
