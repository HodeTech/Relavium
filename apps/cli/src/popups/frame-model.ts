/**
 * The popup's frame, as rows of text ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §4 and §5): the ONE pure model of what a popup draws, whichever driver feeds its body (the popup host's reducer, or the native prompt
 * channel's snapshot) and whichever placement it is drawn in. The view (`PopupFrameView` in `popup-slot.tsx`) only paints these rows.
 *
 * **Four parts, always in this order** (§1): the top edge (the command's name on the left, the origin on the right, and `step 2 of 3` for a
 * popup of more than one step, so a glyph is never the only carrier of the step); the step rail, only for more than one step, in the Home rail's
 * language (`✓ done ╌╌ ◉ current ╌╌ ○ to come`, each glyph from the table, with its plain form when colour is off); the body; and the legend,
 * which always ends with the way back and is the last thing truncated. A bottom edge closes the frame. While a notification is live the legend
 * row draws it in place of the legend's keys and still ends with the way back (`<notice> · Esc close`); the notification is cut with the
 * ellipsis, never wrapped, and never the way back (the hint row it is drawn on otherwise is under the popup). The rail marks a step done only
 * when the popup was on it.
 *
 * **Every row is exactly the frame's width** (§4). A row is filled with spaces to the width, because the spike showed that a row one cell short
 * lets the body behind it show through at its edge: the padding is what makes the popup opaque, and opacity is the safety property. The frame's
 * sides are open, a tray as the sheet's frame is (ADR-0147 §1): the glyph table has no vertical frame glyph, and the open sides are what the
 * inline form must draw anyway (§4: rules without side bars, which a screen reader would voice on every line). One column of margin inside
 * each side keeps a row's text off the body behind it, and the top and bottom rules keep it too (a blank cell at each end), so a rule never
 * touches a word of the backdrop and reads as part of it.
 *
 * **Text is untrusted.** A title, a row, a detail or a report line can carry a name a project, a provider or a model wrote, so every string is
 * passed through the inline sanitiser (control and bidirectional characters), the host-glyph blanking (a row cannot draw `✓`, `›` or a rule
 * the host draws) and the line-separator fold ({@link foldLineSeparators}), and is clipped to its row. The status glyphs and the selection
 * marker are drawn by the model from the table, by role. An `empty` or `error` state wraps its two sentences to the row, so what to do is
 * never cut off a row the popup still has.
 *
 * Pure and `.ts`: it reads the glyph form in force, so a view runs it inside `withGlyphForm(!color, …)` (`glyph-form-scope.test.ts`).
 */

import { sanitizeInline } from '../render/sanitize.js';
import {
  blankHostGlyphs,
  glyph,
  markWithWord,
  type GlyphRole,
  type StatusGlyphRole,
} from '../render/tui/glyphs.js';
import {
  fitLegend,
  inertLegendText,
  legend,
  LEGEND_SEPARATOR,
  legendSpans,
  type LegendExit,
  type LegendItem,
} from '../render/tui/legend.js';
import {
  clampSpans,
  clipLine,
  markedWindow,
  windowMarkers,
  wrappedLines,
  type SheetLine,
  type SheetRole,
  type SheetSpan,
} from '../render/tui/sheet-frame.js';
import { displayWidth, wrapWords } from '../render/tui/viewport.js';
import {
  POPUP_FLOOR,
  POPUP_SIDE_MARGIN,
  popupInnerWidth,
  type PopupBoxGeometry,
} from './geometry.js';

/** Where the popup was opened from, said on its top edge. */
export type PopupOrigin = 'home' | 'chat';

/** The words of an origin. */
export function originLabel(origin: PopupOrigin): string {
  return origin === 'home' ? 'from Home' : 'from chat';
}

/** One row of a list the body draws. */
export interface PopupListRow {
  /** What the row stands for: what an `Enter` on it is answered with. */
  readonly id: string;
  readonly label: string;
  /** Words after the label (a status word, a short detail), drawn after two spaces. */
  readonly detail?: string | undefined;
  /** A status the row carries, drawn as its glyph before the label (its word belongs in `detail`, or in `statusWord`). */
  readonly status?: StatusGlyphRole | undefined;
  /**
   * The status's own word, drawn beside its glyph (`✓ ok`, `⚠ warning`), so the glyph is never the only carrier of the status; written once
   * when the glyph's plain form IS the word (`ok`, colour off). Absent ⇒ the glyph alone (the word is in the detail).
   */
  readonly statusWord?: string | undefined;
  /** A heading inside the list (`Deep check · 3 min ago`): drawn plain and dim, with no marker; never selected (it is not `enabled`). */
  readonly section?: true | undefined;
  /** `false` ⇒ the row cannot act: it is drawn dim with `reason`, the arrows skip it and `Enter` on it answers nothing. */
  readonly enabled?: boolean | undefined;
  readonly reason?: string | undefined;
  /**
   * What choosing the row does, in a sentence or two (ADR-0148 §3: a setting states its effect before it applies): drawn as a paragraph
   * wrapped under the list while the row is highlighted. The room of the LONGEST effect of the list is kept whichever row is highlighted (a
   * row with none leaves it blank), so the frame never jumps when the highlight moves. A list none of whose rows has one draws no room.
   */
  readonly effect?: string | undefined;
  /** More words the filter searches and the row never draws (a model's display name beside its id). */
  readonly match?: string | undefined;
  /** The row survives every filter, where it sits (a row that acts on the list itself: `Refresh the list`). */
  readonly pinned?: true | undefined;
}

/**
 * One option of a form's field: what the form is answered with (`id`), its words, and for an option of a radio group the words after them
 * (`switches the model now; the conversation stays`) and the warning drawn while it is the chosen one.
 */
export interface PopupFormOption {
  readonly id: string;
  readonly label: string;
  /** A radio option's words after its label; a tab has none. */
  readonly detail?: string | undefined;
  /** A radio option's own warning, drawn in place of the form's while the option is chosen (the room of the longest is kept). */
  readonly warning?: string | undefined;
}

/** A field of a form: a row of tabs (`←/→` changes it) or a radio group (`↑/↓` moves its choice). */
export interface PopupFormField {
  /** The field's heading (`Reasoning effort`, `Apply to`). */
  readonly label: string;
  /** What the field's keys do, as the legend names them (`←/→ effort`, `↑/↓ apply to`). */
  readonly verb: string;
  readonly options: readonly PopupFormOption[];
  /** The option the field opens on: the CURRENT value, so a bare `Enter` changes nothing (ADR-0148 §3). Absent or unknown ⇒ the first. */
  readonly initial?: string | undefined;
}

/**
 * A form ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1: "a list, a form or a
 * report"; the `/models` second step, `popup-models-step2-80x24.png`): a summary line, a row of tabs, a radio group and a warning, each
 * optional, answered as a whole by `Enter`. There is no focus to move between the fields: the tabs answer `←/→` and the radio group `↑/↓`.
 * A form is never windowed (the warning it states is part of what `Enter` applies): it is drawn whole or it offers no answer
 * ({@link formFits}).
 */
export interface PopupForm {
  readonly kind: 'form';
  /** One row above the fields that names what the form sets (`gpt-5  400k context · $1.25 / $10 per M · openai`); cut to the row. */
  readonly summary?: string | undefined;
  readonly tabs?: PopupFormField | undefined;
  readonly radio?: PopupFormField | undefined;
  /** The warning drawn under the fields (`⚠ This chat moves from Anthropic to OpenAI. …`), wrapped whole; a chosen radio option's replaces it. */
  readonly warning?: string | undefined;
}

/**
 * What a popup's body shows: the four content states every popup draws (§5) and the three bodies that hold data.
 *
 * - `loading`: a static `…`, and the elapsed seconds once past five (a display value from the host's clock, never at the frame rate, never
 *   inline); the legend names the cancel key it really has.
 * - `empty`: what is empty, and what to do.
 * - `error`: what failed, and the next action INSIDE the TUI (never a shell command: `no-shell-remedy.test.ts` reads this directory).
 * - `list`: rows to choose from, windowed with `▲ N more` / `▼ N more` and the highlighted row always in the window; a row's effect is drawn
 *   under it ({@link PopupListRow.effect}).
 * - `report`: lines to read, windowed the same way.
 * - `form`: fields set together and applied by `Enter` ({@link PopupForm}).
 */
export type PopupContent =
  | { readonly kind: 'loading'; readonly what: string }
  | { readonly kind: 'empty'; readonly what: string; readonly next: string }
  | { readonly kind: 'error'; readonly what: string; readonly next: string }
  | {
      readonly kind: 'list';
      readonly rows: readonly PopupListRow[];
      /** One line above the rows that says what they add up to (`⚠ doctor: 1 warning`), its glyph by role and its word beside it. */
      readonly heading?: PopupHeading | undefined;
    }
  | { readonly kind: 'report'; readonly lines: readonly string[] }
  | PopupForm;

/**
 * The line above a list's rows: the dominant outcome's glyph, then the text. A glyph whose plain form IS the status's word (`ok`, colour off) is
 * not repeated in front of a sentence that already says it (`doctor: all checks passed`), as the doctor's text report does.
 */
export interface PopupHeading {
  readonly status: StatusGlyphRole;
  readonly statusWord: string;
  readonly text: string;
}

/** How long a loading body says nothing but `…` before it shows the elapsed seconds (§5). */
export const LOADING_ELAPSED_AFTER_MS = 5000;

/** The elapsed text of a loading body at `elapsedMs`: nothing until five seconds, then whole seconds (`12 s`). Quantised: it changes once a second. */
export function loadingElapsedText(elapsedMs: number): string | undefined {
  if (!Number.isFinite(elapsedMs) || elapsedMs < LOADING_ELAPSED_AFTER_MS) return undefined;
  return `${String(Math.floor(elapsedMs / 1000))} s`;
}

/**
 * The line and paragraph separators (the `Zl` and `Zp` categories: U+2028 and U+2029). The inline sanitiser and the author-text scrub keep them,
 * the width measure counts each as one column and a terminal draws them as nothing, so a row that carried N of them would be drawn N cells
 * short and the body behind the popup would show through its edge (ADR-0148 §4: the padding is what makes the popup opaque).
 */
const LINE_SEPARATORS = /[\p{Zl}\p{Zp}]/gu;

/** `text` with every line or paragraph separator folded to one space (one UTF-16 unit for one: a span over the text does not move). */
export function foldLineSeparators(text: string): string {
  return text.replace(LINE_SEPARATORS, ' ');
}

/**
 * Text from a command, a project, a provider or a model, made safe to draw beside the host's own marks: sanitised, host-glyph blanked, and its
 * line separators folded (the last step for every row of untrusted text the frame draws).
 */
export function popupText(text: string): string {
  return foldLineSeparators(blankHostGlyphs(sanitizeInline(text)));
}

/** The body as the frame needs it: its rows (not yet padded) and the window's position, for a caller that keeps the selection in view. */
export interface PopupBody {
  readonly lines: readonly SheetLine[];
}

export interface PopupBodyState {
  /** The highlighted row of a list (an index into the rows its filter leaves), or the chosen option of a form's radio group. */
  readonly selected: number;
  /** The first line of a report that is shown. */
  readonly offset: number;
  /** The filter's text, when the step has a filter line (`undefined` ⇒ no filter line). */
  readonly filter?: string | undefined;
  /** The chosen option of a form's tabs (absent ⇒ the first). */
  readonly tab?: number | undefined;
}

/**
 * The rows of a list a filter leaves: the rows whose label, detail or match words contain it, case folded, and the rows pinned to the list
 * whatever is typed; every row with no filter typed. The ONE filter of a list: the key fold reads it (the highlighted row is an index into
 * what it leaves) and the body draws what it leaves.
 */
export function filterListRows(
  rows: readonly PopupListRow[],
  filter: string | undefined,
): readonly PopupListRow[] {
  const query = (filter ?? '').trim().toLowerCase();
  if (query.length === 0) return rows;
  return rows.filter(
    (row) =>
      row.pinned === true ||
      row.label.toLowerCase().includes(query) ||
      (row.detail?.toLowerCase().includes(query) ?? false) ||
      (row.match?.toLowerCase().includes(query) ?? false),
  );
}

/** The columns a row is counted at when a caller gives none: the inner width of a standard popup at the floor (80 columns). */
const FLOOR_INNER_WIDTH = popupInnerWidth(POPUP_FLOOR.columns, 'standard');

/** The effect of `row` as its rows of `width` columns: none for a row that has no effect (or a heading). */
function effectRows(row: PopupListRow | undefined, width: number): readonly string[] {
  if (row?.effect === undefined || row.section === true) return [];
  return wrapRows(popupText(row.effect), width);
}

/** The rows the effect paragraph keeps under a list of `rows` at `width`: the longest effect's, or 0 when no row has one. */
function effectRoom(rows: readonly PopupListRow[], width: number): number {
  return rows.reduce((room, row) => Math.max(room, effectRows(row, width).length), 0);
}

/**
 * The paragraph under a list: a blank row, then the highlighted row's effect, padded with blank rows to the room of the longest effect of the
 * list (counted over EVERY row, the ones a filter hides included, so neither the highlight nor the filter makes the frame jump). Nothing for a
 * list none of whose rows has an effect.
 */
function effectBlock(
  rows: readonly PopupListRow[],
  highlighted: PopupListRow | undefined,
  width: number,
): SheetLine[] {
  const room = effectRoom(rows, width);
  if (room === 0) return [];
  const shown = effectRows(highlighted, width).map((text) => bodyLine('message', text, width));
  while (shown.length < room) shown.push(bodyLine('text', '', width));
  return [bodyLine('text', '', width), ...shown];
}

/** The index of `field`'s option `id`, else of its `initial` option, else the first: where a field opens and where it stays when it is rebuilt. */
export function formOptionIndex(field: PopupFormField | undefined, id?: string): number {
  if (field === undefined) return 0;
  const at = (wanted: string | undefined): number =>
    wanted === undefined ? -1 : field.options.findIndex((option) => option.id === wanted);
  const kept = at(id);
  if (kept >= 0) return kept;
  return Math.max(0, at(field.initial));
}

/** `index` kept inside a field of `count` options (0 for a field with none). */
function clampOption(index: number | undefined, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(Math.trunc(index ?? 0), count - 1));
}

/** The warning a form draws now: the chosen radio option's own, else the form's. */
function formWarning(form: PopupForm, radio: number): string | undefined {
  return (
    form.radio?.options[clampOption(radio, form.radio.options.length)]?.warning ?? form.warning
  );
}

/** `text` as the warning's rows of `width` columns: the warning glyph, then the sentence, its later rows under the sentence's first word. */
function warningRows(text: string, width: number): readonly string[] {
  const lead = `${glyph('warning')} `;
  const hang = ' '.repeat(displayWidth(lead));
  return wrapRows(popupText(text), Math.max(1, width - displayWidth(lead))).map(
    (row, index) => `${index === 0 ? lead : hang}${row}`,
  );
}

/** The rows the warning keeps: the longest of the form's own and every radio option's, so moving the choice never makes the frame jump. */
function warningRoom(form: PopupForm, width: number): number {
  const candidates = [form.warning, ...(form.radio?.options.map((option) => option.warning) ?? [])];
  return candidates.reduce(
    (room, text) => (text === undefined ? room : Math.max(room, warningRows(text, width).length)),
    0,
  );
}

/** `text` padded with spaces to `width` display columns (it is not cut). */
function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** A line cut to `width`, its spans cut with it (a span past the cut is dropped, one across it shortened). */
function clippedLine(
  kind: SheetLine['kind'],
  text: string,
  spans: SheetSpan[],
  width: number,
): SheetLine {
  const clipped = clipLine(text, width);
  return { kind, text: clipped, spans: [...clampSpans(spans, clipped.length)] };
}

/**
 * The tabs of a form as one row: each option's label, the chosen one led by the selection glyph and drawn as the selected item of the row
 * (bold and inverse, ADR-0145 §5: the glyph is not the only carrier). When the row is wider than `width` the options farthest from the chosen
 * one are left out first, and a side that lost one ends in the ellipsis, so the chosen option is always on the row.
 */
function tabsLine(field: PopupFormField, chosen: number, width: number): SheetLine {
  const parts = field.options.map(
    (option, index) => `${index === chosen ? glyph('selection') : ' '} ${popupText(option.label)}`,
  );
  const ellipsis = '…';
  const build = (from: number, to: number): { text: string; spans: SheetSpan[] } => {
    let text = from > 0 ? ` ${ellipsis} ` : ' ';
    const spans: SheetSpan[] = [];
    for (let index = from; index < to; index += 1) {
      if (index > from) text += '  ';
      const part = parts[index] ?? '';
      if (index === chosen)
        spans.push({
          from: text.length,
          to: text.length + part.length,
          role: 'strong',
          selected: true,
        });
      text += part;
    }
    if (to < parts.length) text += `  ${ellipsis}`;
    return { text, spans };
  };
  let from = 0;
  let to = parts.length;
  let line = build(from, to);
  // Leave out the option farthest from the chosen one until the row fits, never the chosen one itself.
  while (displayWidth(line.text) > width && to - from > 1) {
    if (chosen - from >= to - 1 - chosen) from += 1;
    else to -= 1;
    line = build(from, to);
  }
  return clippedLine('row', line.text, line.spans, width);
}

/**
 * A radio group's rows: `(•) This chat   switches the model now; …`, the chosen option's mark and label strong, every detail dim, the labels
 * padded to the longest so the details stand in one column. The mark is the table's bullet in parentheses (`(*)` with colour off).
 */
function radioLines(field: PopupFormField, chosen: number, width: number): SheetLine[] {
  const labelWidth = field.options.reduce(
    (widest, option) => Math.max(widest, displayWidth(popupText(option.label))),
    0,
  );
  return field.options.map((option, index) => {
    const head = `(${index === chosen ? glyph('bullet') : ' '}) ${padTo(popupText(option.label), labelWidth)}`;
    const detail = option.detail === undefined ? '' : popupText(option.detail);
    const text = detail.length === 0 ? head.trimEnd() : `${head}   ${detail}`;
    const spans: SheetSpan[] = [];
    if (index === chosen) spans.push({ from: 0, to: head.trimEnd().length, role: 'strong' });
    if (detail.length > 0) spans.push({ from: head.length + 3, to: text.length, role: 'dim' });
    return clippedLine('row', text, spans, width);
  });
}

/** How a form is laid out: its blocks with a blank row between each two (`spacious`), or one under the other (`compact`). */
export type FormLayout = 'spacious' | 'compact';

/**
 * The rows of a form at `width` in `layout`, with the tab and the radio option `state` chose: its summary, its tabs (heading and row), its
 * radio group (heading and rows) and its warning (padded to the room of the longest it can show). The ONE layout of a form: the rows the
 * geometry is asked for and the rows drawn are counted by it, so the two cannot disagree.
 */
export function formLines(
  form: PopupForm,
  state: Pick<PopupBodyState, 'selected' | 'tab'>,
  width: number,
  layout: FormLayout,
): SheetLine[] {
  const blocks: SheetLine[][] = [];
  if (form.summary !== undefined) blocks.push([bodyLine('row', popupText(form.summary), width)]);
  const tabs = form.tabs;
  if (tabs !== undefined)
    blocks.push([
      bodyLine('text', popupText(tabs.label), width),
      tabsLine(tabs, clampOption(state.tab, tabs.options.length), width),
    ]);
  const radio = form.radio;
  const chosen = clampOption(state.selected, radio?.options.length ?? 0);
  if (radio !== undefined)
    blocks.push([
      bodyLine('text', popupText(radio.label), width),
      ...radioLines(radio, chosen, width),
    ]);
  const room = warningRoom(form, width);
  if (room > 0) {
    const warning = formWarning(form, chosen);
    const rows = (warning === undefined ? [] : warningRows(warning, width)).map((text) =>
      bodyLine('notice', text, width),
    );
    while (rows.length < room) rows.push(bodyLine('text', '', width));
    blocks.push(rows);
  }
  const blank = (): SheetLine => bodyLine('text', '', width);
  return blocks.flatMap((block, index) =>
    layout === 'spacious' && index > 0 ? [blank(), ...block] : block,
  );
}

/** The rows a form takes at `width` in `layout` (the same for every choice: its warning's room is the longest it can show). */
export function formRowCount(form: PopupForm, width: number, layout: FormLayout): number {
  return formLines(form, { selected: 0, tab: 0 }, width, layout).length;
}

/**
 * Whether a form is WHOLLY on a page of `pageRows` rows of `innerWidth` columns, in its compact layout at least: a form is never windowed, so
 * one that is not whole offers no `Enter` (the legend names none and the host takes none), as a confirmation line cut short offers no
 * answer. The host's rule and the legend's are this one function.
 */
export function formFits(content: PopupContent, pageRows: number, innerWidth: number): boolean {
  return content.kind === 'form' && formRowCount(content, innerWidth, 'compact') <= pageRows;
}

/** The layout a form is drawn in on a page of `rows`: spacious when it fits, else compact. */
function formLayoutFor(form: PopupForm, width: number, rows: number): FormLayout {
  return formRowCount(form, width, 'spacious') <= rows ? 'spacious' : 'compact';
}

/**
 * `text` as rows of at most `width` columns, nothing cut (a long word is broken where it must be); never an empty list. A row after the first
 * starts at its first word: the word wrap breaks AFTER a row that fills the width exactly and so leaves the space of that break at the start of
 * the next row, which would be drawn one cell to the right of the rows around it.
 */
function wrapRows(text: string, width: number): readonly string[] {
  const rows = wrapWords(text, Math.max(1, width)).map((row, index) =>
    (index === 0 ? row : row.trimStart()).trimEnd(),
  );
  return rows.length === 0 ? [''] : rows;
}

/**
 * The rows an `empty` or an `error` state draws at `width`: what it says (an error's first row carries the failed glyph), then what to do, each
 * wrapped whole. One function for the count the geometry is asked for and for the rows drawn, so the two cannot disagree.
 */
function stateRows(
  content: Extract<PopupContent, { readonly kind: 'empty' | 'error' }>,
  width: number,
): { readonly what: readonly string[]; readonly next: readonly string[] } {
  const lead = content.kind === 'error' ? `${glyph('failed')} ` : '';
  return {
    what: wrapRows(`${lead}${popupText(content.what)}`, width),
    next: wrapRows(popupText(content.next), width),
  };
}

/**
 * How many body rows `content` would like: what the geometry is asked for. A list or a report asks for every row it has, or `maxListRows`
 * (a block in the flow windows a list to ten rows, `INLINE_LIST_MAX_ROWS`), so the block is never padded with rows its list cannot use; a list
 * whose rows have an effect adds its paragraph (a blank row and the room of the longest effect at `innerWidth`). An `empty` or `error` state
 * asks for the rows its two sentences wrap to at `innerWidth` (the geometry's, from `popupInnerWidth`); without one it asks for one row each,
 * and the body cuts what does not fit with the ellipsis. A form is never windowed: it asks for its spacious layout where that is within
 * `maxListRows` (inline, the ten rows of the page), else for its compact one (which the geometry gives it whole up to its tallest body).
 */
export function naturalBodyRows(
  content: PopupContent,
  state: PopupBodyState,
  maxListRows = Number.POSITIVE_INFINITY,
  innerWidth?: number,
): number {
  const filterRows = state.filter === undefined ? 0 : 1;
  switch (content.kind) {
    case 'loading':
      return filterRows + 1;
    case 'empty':
    case 'error': {
      if (innerWidth === undefined) return filterRows + 2;
      const { what, next } = stateRows(content, innerWidth);
      return filterRows + what.length + next.length;
    }
    case 'list': {
      const room = effectRoom(content.rows, innerWidth ?? FLOOR_INNER_WIDTH);
      return (
        filterRows +
        (content.heading === undefined ? 0 : 1) +
        Math.min(maxListRows, Math.max(1, content.rows.length)) +
        (room === 0 ? 0 : 1 + room)
      );
    }
    case 'report':
      return filterRows + Math.min(maxListRows, Math.max(1, content.lines.length));
    case 'form': {
      const width = innerWidth ?? FLOOR_INNER_WIDTH;
      const spacious = formRowCount(content, width, 'spacious');
      return (
        filterRows + (spacious <= maxListRows ? spacious : formRowCount(content, width, 'compact'))
      );
    }
  }
}

/**
 * The rows of the page a step's body is drawn in, in `geometry`: a report's page ({@link reportPageRows}), a form's whole body, or the window
 * a list draws its rows in (below its filter line and its heading, above its effect paragraph, and at most the list window). What a page
 * moves by and what a confirmation line or a form must fit whole to be answered: the slot binds it, and the legend is judged on it.
 */
export function bodyPageRows(
  content: PopupContent,
  hasFilter: boolean,
  geometry: Pick<PopupBoxGeometry, 'bodyRows' | 'listRows' | 'innerWidth'>,
): number {
  const filterRows = hasFilter ? 1 : 0;
  switch (content.kind) {
    case 'report':
      return reportPageRows(geometry, hasFilter);
    case 'form':
      return Math.max(1, geometry.bodyRows - filterRows);
    case 'list': {
      const room = effectRoom(content.rows, geometry.innerWidth);
      const above = filterRows + (content.heading === undefined ? 0 : 1);
      return Math.min(
        geometry.listRows,
        Math.max(1, geometry.bodyRows - above - (room === 0 ? 0 : 1 + room)),
      );
    }
    case 'loading':
    case 'empty':
    case 'error':
      return geometry.listRows;
  }
}

/** A row of the body: `text` clipped to the inner width (the frame pads it), in a kind the painter styles. */
function bodyLine(kind: SheetLine['kind'], text: string, width: number): SheetLine {
  return { kind, text: clipLine(text, width) };
}

/** The marker column of a list row: the selection glyph when selected, a space otherwise. */
function marker(selected: boolean): string {
  return selected ? glyph('selection') : ' ';
}

/** A row's status, as it leads the row: its glyph, with its word where it has one, and two spaces; nothing for a row with no status. */
function statusText(row: PopupListRow): string {
  if (row.status === undefined) return '';
  const mark = glyph(row.status);
  const shown = row.statusWord === undefined ? mark : markWithWord(mark, popupText(row.statusWord));
  return `${shown}  `;
}

/** What follows a row's label: its detail, or, for a row that cannot act, why. */
function detailText(row: PopupListRow): string {
  if (row.enabled === false) return `  ${popupText(row.reason ?? 'unavailable')}`;
  return row.detail === undefined ? '' : `  ${popupText(row.detail)}`;
}

function listRowText(row: PopupListRow, selected: boolean): string {
  if (row.section === true) return `  ${popupText(row.label)}`;
  return `${marker(selected)} ${statusText(row)}${popupText(row.label)}${detailText(row)}`;
}

function rowKind(row: PopupListRow, selected: boolean): SheetLine['kind'] {
  if (row.enabled === false || row.section === true) return 'text';
  return selected ? 'selected' : 'row';
}

/** `count` rows of `total` from `start`, as a list window would draw them, the marker rows in the glyph form in force. */
function listLines(
  rows: readonly PopupListRow[],
  selected: number,
  height: number,
  width: number,
): SheetLine[] {
  if (rows.length === 0) return [bodyLine('text', 'Nothing to show.', width)];
  const window = markedWindow(rows.length, selected, height);
  const markers = windowMarkers(window);
  const out: SheetLine[] = [];
  for (let index = window.start; index < window.end; index += 1) {
    const first = index === window.start && markers.above !== undefined;
    const last = index === window.end - 1 && markers.below !== undefined;
    if (first && markers.above !== undefined)
      out.push(bodyLine('marker', `  ${markers.above}`, width));
    else if (last && markers.below !== undefined)
      out.push(bodyLine('marker', `  ${markers.below}`, width));
    else {
      const row = rows[index];
      if (row === undefined) continue;
      out.push(
        bodyLine(rowKind(row, index === selected), listRowText(row, index === selected), width),
      );
    }
  }
  return out;
}

/**
 * Whether a page of `height` rows draws its marker rows (`▲ N more` at the top while lines are hidden above, `▼ N more` at the bottom while
 * lines are hidden below), each in place of the line under it: from three rows on, so that a page always keeps at least one line of the report.
 */
function reportDrawsMarkers(height: number): boolean {
  return height >= 3;
}

/**
 * How far `PgUp` and `PgDn` move a report drawn in a page of `height` rows (at least one line): so far that the first line the next page draws
 * under its `▲` row is the line after the last one this page drew above its `▼` row, and nothing is skipped. Each marker row covers the line
 * under it, so a page that draws them moves by the rows between them, its content rows (`height` less its two marker rows), and moving by the
 * whole page would leave the two lines under the markers of each page boundary never on screen. Moving down from the first page (one marker)
 * is the same move: the next page's `▲` row covers the first page's last line.
 */
export function reportPageStep(height: number): number {
  const rows = Math.max(1, Math.trunc(height));
  return reportDrawsMarkers(rows) ? rows - 2 : rows;
}

/**
 * Whether every line of a report is drawn whole in a row of `innerWidth` columns: the line AS DRAWN ({@link popupText}: sanitised, host glyphs
 * blanked, separators folded) is no wider than the row, so `reportLines` cuts none of them with the ellipsis.
 */
export function reportLinesFit(lines: readonly string[], innerWidth: number): boolean {
  return lines.every((line) => displayWidth(popupText(line)) <= innerWidth);
}

/** A report's lines from `offset`, `height` of them, with a marker row where lines are hidden (the line under it counted, as a list counts). */
function reportLines(
  lines: readonly string[],
  offset: number,
  height: number,
  width: number,
): SheetLine[] {
  const total = lines.length;
  if (total === 0) return [bodyLine('text', 'Nothing to show.', width)];
  if (total <= height) return lines.map((line) => bodyLine('row', popupText(line), width));
  const start = Math.max(0, Math.min(offset, total - height));
  const end = start + height;
  const markers = reportDrawsMarkers(height);
  const out: SheetLine[] = [];
  for (let index = start; index < end; index += 1) {
    if (markers && index === start && start > 0)
      out.push(bodyLine('marker', `  ${glyph('moreAbove')} ${String(start + 1)} more`, width));
    else if (markers && index === end - 1 && end < total)
      out.push(
        bodyLine('marker', `  ${glyph('moreBelow')} ${String(total - end + 1)} more`, width),
      );
    else out.push(bodyLine('row', popupText(lines[index] ?? ''), width));
  }
  return out;
}

/** A list's heading as it is drawn, in the glyph form in force: the mark, unless it is the very word of the status, then the text. */
function headingText(heading: PopupHeading): string {
  const mark = glyph(heading.status);
  const lead = mark === heading.statusWord ? '' : `${mark} `;
  return `${lead}${popupText(heading.text)}`;
}

/**
 * The rows a report is drawn in by {@link popupBody} in `geometry`: the body's rows less the filter line, and at most the list window. A report
 * of more lines than this overflows its page (it scrolls, and the legend names `↑/↓ scroll`).
 */
export function reportPageRows(
  geometry: Pick<PopupBoxGeometry, 'bodyRows' | 'listRows'>,
  hasFilter: boolean,
): number {
  return Math.min(Math.max(1, geometry.bodyRows - (hasFilter ? 1 : 0)), geometry.listRows);
}

/** The furthest a report of `total` lines scrolls in a body of `height` rows. */
export function reportMaxOffset(total: number, height: number): number {
  return Math.max(0, total - height);
}

/**
 * The body rows of `content` in a body of `bodyRows` rows, a list in at most `listRows` of them (fewer inline): what the frame draws between
 * its rail and its legend. `elapsed` is the loading clock's text (the host's display value; absent inline, where nothing ticks).
 */
export function popupBody(
  content: PopupContent,
  state: PopupBodyState,
  geometry: Pick<PopupBoxGeometry, 'bodyRows' | 'listRows' | 'innerWidth'>,
  elapsed?: string,
): PopupBody {
  const width = geometry.innerWidth;
  const lines: SheetLine[] = [];
  if (state.filter !== undefined)
    lines.push(bodyLine('row', `Filter: ${popupText(state.filter)}${glyph('caret')}`, width));
  const room = Math.max(1, geometry.bodyRows - lines.length);
  switch (content.kind) {
    case 'loading': {
      const clock = elapsed === undefined ? '' : `  ${elapsed}`;
      lines.push(bodyLine('message', `${popupText(content.what)}…${clock}`, width));
      break;
    }
    case 'empty':
    case 'error': {
      // Both sentences whole, wrapped to the row; only a popup that has no more rows cuts them, the last row it keeps ending in the ellipsis.
      const { what, next } = stateRows(content, width);
      const wrapped: SheetLine[] = [
        ...what.map((text) =>
          bodyLine(content.kind === 'error' ? 'failed' : 'message', text, width),
        ),
        ...next.map((text) => bodyLine('text', text, width)),
      ];
      if (wrapped.length > room) {
        const kept = wrapped.slice(0, room);
        const last = kept.at(-1);
        if (last !== undefined) kept[kept.length - 1] = bodyLine(last.kind, `${last.text}…`, width);
        lines.push(...kept);
      } else lines.push(...wrapped);
      break;
    }
    case 'list': {
      if (content.heading !== undefined)
        lines.push(bodyLine('message', headingText(content.heading), width));
      // The rows the filter leaves (the highlighted row is an index into them), and under them the highlighted row's effect.
      const shown = filterListRows(content.rows, state.filter);
      lines.push(
        ...listLines(
          shown,
          state.selected,
          bodyPageRows(content, state.filter !== undefined, geometry),
          width,
        ),
        ...effectBlock(content.rows, shown[state.selected], width),
      );
      break;
    }
    case 'report':
      lines.push(
        ...reportLines(
          content.lines,
          state.offset,
          reportPageRows(geometry, state.filter !== undefined),
          width,
        ),
      );
      break;
    case 'form':
      lines.push(...formBody(content, state, room, width));
      break;
  }
  return { lines: lines.slice(0, geometry.bodyRows) };
}

/**
 * A form in a body of `rows` rows: spacious when it fits, else compact; and a form that does not fit even then is drawn cut, its last row a
 * `▼ N more` marker (it offers no `Enter` then: {@link formFits}).
 */
function formBody(
  form: PopupForm,
  state: Pick<PopupBodyState, 'selected' | 'tab'>,
  rows: number,
  width: number,
): SheetLine[] {
  const drawn = formLines(form, state, width, formLayoutFor(form, width, rows));
  if (drawn.length <= rows) return drawn;
  const kept = drawn.slice(0, Math.max(0, rows - 1));
  return [
    ...kept,
    bodyLine('marker', `  ${glyph('moreBelow')} ${String(drawn.length - kept.length)} more`, width),
  ];
}

/** The frame's parts besides its body: the title and origin of its top edge, its steps, and its legend. */
export interface PopupFrameParts {
  /** The command's name (`/doctor`), drawn on the top edge. */
  readonly title: string;
  readonly origin: PopupOrigin;
  /** The steps' names, in order; the rail is drawn for more than one. */
  readonly steps: readonly string[];
  readonly stepIndex: number;
  /**
   * Parallel to `steps`: whether each step before the current one was done (the popup was on it). One that was not is drawn as a step not done
   * (`○`), never `✓`. Absent ⇒ every step before the current one was.
   */
  readonly done?: readonly boolean[] | undefined;
  /**
   * The legend's items and its way back, built from the same constants the key fold reads. Items are dropped from the end when they do not fit
   * (or by `priority`, parallel to `items`, higher kept longer); the way back never is.
   */
  readonly legend: {
    readonly items: readonly LegendItem[];
    readonly exit: LegendExit;
    readonly priority?: readonly number[] | undefined;
  };
  /**
   * The live notification while a popup is open (the host's channel, through the popup host's snapshot), drawn in the legend row for its
   * lifetime in place of the legend's keys, with the way back still at the end (`<notice> · Esc close`): the hint row it is drawn on otherwise
   * is under the popup. Absent ⇒ the legend.
   */
  readonly notice?: string | undefined;
}

/** `text` filled with spaces to exactly `width` columns (it is already clipped to fit). */
function fill(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * A row of the frame: the margin, the content clipped to the inner width, then spaces to the frame's width. Spans move with the margin. The
 * content's line separators are folded first, whatever built it: the width measure and the terminal must agree on every cell.
 */
function framedRow(line: SheetLine, geometry: PopupBoxGeometry): SheetLine {
  const margin = ' '.repeat(POPUP_SIDE_MARGIN);
  const content = clipLine(foldLineSeparators(line.text), geometry.innerWidth);
  const spans = line.spans
    ?.map(
      (span): SheetSpan => ({
        ...span,
        from: span.from + margin.length,
        to: span.to + margin.length,
      }),
    )
    .filter((span) => span.from < margin.length + content.length)
    .map((span) =>
      span.to <= margin.length + content.length
        ? span
        : { ...span, to: margin.length + content.length },
    );
  return {
    kind: line.kind,
    text: fill(`${margin}${content}`, geometry.width),
    ...(spans === undefined ? {} : { spans }),
  };
}

/**
 * The top edge: ` ─ title ───── from Home · step 2 of 3 ─ `, exactly the frame's width; the title is clipped first. The rule spans the inner
 * width, with the side margin's blank cell at each end: it never touches a word of the body behind the popup (a backdrop drawn without dim,
 * colour off, would read as part of the title row otherwise).
 */
function topEdge(parts: PopupFrameParts, geometry: PopupBoxGeometry): SheetLine {
  const rule = glyph('thinRule');
  const width = geometry.innerWidth;
  const right =
    parts.steps.length > 1
      ? `${originLabel(parts.origin)} · step ${String(parts.stepIndex + 1)} of ${String(parts.steps.length)}`
      : originLabel(parts.origin);
  // `─ ` + title + ` ` + at least two rules + ` ` + right + ` ─`
  const room = width - displayWidth(right) - 7;
  const title = clipLine(popupText(parts.title), Math.max(1, room));
  const lead = `${rule} ${title} `;
  const tail = ` ${right} ${rule}`;
  const between = Math.max(0, width - displayWidth(lead) - displayWidth(tail));
  const text = clipLine(`${lead}${rule.repeat(between)}${tail}`, width);
  const gutter = ' '.repeat(POPUP_SIDE_MARGIN);
  const at = gutter.length;
  // The rule and the origin are dim; the command's name is what the eye looks for.
  const titleEnd = Math.min(at + text.length, at + 2 + title.length);
  return {
    kind: 'rule',
    text: fill(`${gutter}${text}`, geometry.width),
    spans: [
      { from: at, to: at + 2, role: 'dim' },
      { from: at + 2, to: titleEnd, role: 'strong' },
      { from: titleEnd, to: at + text.length, role: 'dim' },
    ],
  };
}

/** The bottom edge: the rule over the inner width, the side margin's blank cell at each end (as the top edge). */
function bottomEdge(geometry: PopupBoxGeometry): SheetLine {
  const at = POPUP_SIDE_MARGIN;
  return {
    kind: 'rule',
    text: fill(`${' '.repeat(at)}${glyph('thinRule').repeat(geometry.innerWidth)}`, geometry.width),
    spans: [{ from: at, to: at + geometry.innerWidth, role: 'dim' }],
  };
}

/**
 * How a rail node is drawn: the current step strong, a step before it that was done (visited, {@link PopupFrameParts.done}) with the
 * completed glyph, and every other step, one the popup opened past included, as a step not done.
 */
function railNode(
  parts: PopupFrameParts,
  index: number,
): { readonly glyph: GlyphRole; readonly role: SheetRole } {
  if (index === parts.stepIndex) return { glyph: 'currentStep', role: 'strong' };
  if (index < parts.stepIndex && parts.done?.[index] !== false)
    return { glyph: 'completed', role: 'ok' };
  return { glyph: 'pending', role: 'dim' };
}

/** The rail: `✓ done ╌╌ ◉ current ╌╌ ○ to come`, each node's glyph from the table by its state. */
function rail(parts: PopupFrameParts, geometry: PopupBoxGeometry): SheetLine {
  const spans: SheetSpan[] = [];
  let text = '';
  const join = ` ${glyph('railLine').repeat(2)} `;
  parts.steps.forEach((name, index) => {
    if (index > 0) {
      spans.push({ from: text.length, to: text.length + join.length, role: 'dim' });
      text += join;
    }
    const look = railNode(parts, index);
    const node = `${glyph(look.glyph)} ${popupText(name)}`;
    spans.push({ from: text.length, to: text.length + node.length, role: look.role });
    text += node;
  });
  return framedRow({ kind: 'row', text, spans }, geometry);
}

/**
 * The legend row while a notification is live ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1.4: the legend always ends with the way back): the notification, then the separator and the step's way back, whole. The notification
 * is what is cut, with the ellipsis, when the two do not fit the inner width together (`POPUP_NOTICE_MAX_COLUMNS` is the room it has beside
 * `Esc close` at the floor); it is never wrapped (the frame's height is the geometry's). Its line separators are folded by `framedRow` (one
 * unit for one: the measure is the same before and after).
 */
function noticeRow(notice: string, exit: LegendExit, geometry: PopupBoxGeometry): SheetLine {
  const way = `${LEGEND_SEPARATOR}${legend([], exit)}`;
  const room = Math.max(1, geometry.innerWidth - displayWidth(way));
  const said = clipLine(notice, room);
  const at = said.length + LEGEND_SEPARATOR.length;
  const spans: SheetSpan[] = [
    { from: said.length, to: at, role: 'dim' },
    ...legendSpans([], exit).map((span) => ({ ...span, from: span.from + at, to: span.to + at })),
  ];
  return framedRow({ kind: 'notice', text: `${said}${way}`, spans }, geometry);
}

/**
 * The legend, fitted to the inner width: the way back is always kept and the other items go from the end first. While a notification is live
 * the row draws it in place of the other items ({@link noticeRow}).
 */
function legendRow(parts: PopupFrameParts, geometry: PopupBoxGeometry): SheetLine {
  if (parts.notice !== undefined) return noticeRow(parts.notice, parts.legend.exit, geometry);
  const items = parts.legend.items.map((item) =>
    'text' in item ? { text: inertLegendText(sanitizeInline(item.text)) } : item,
  );
  // The keys that leave are kept to the last (they are how out); the others go from the end first.
  const leaves = (item: LegendItem): boolean =>
    'keys' in item && (item.keys === 'Ctrl+C' || item.keys === 'Esc');
  const kept = fitLegend(
    [],
    items.map((item, index) => ({
      item,
      priority: leaves(item)
        ? Number.MAX_SAFE_INTEGER
        : (parts.legend.priority?.[index] ?? items.length - index),
    })),
    parts.legend.exit,
    geometry.innerWidth,
    displayWidth,
  );
  return framedRow(
    {
      kind: 'legend',
      text: legend(kept, parts.legend.exit),
      spans: legendSpans(kept, parts.legend.exit),
    },
    geometry,
  );
}

/**
 * The popup's rows: exactly `geometry.height` of them, each exactly `geometry.width` wide. The body is padded with blank rows to its height,
 * or cut to it; nothing a body says can make the frame taller or wider (the measured-frame check refuses a frame that is either).
 */
export function popupFrameLines(
  parts: PopupFrameParts,
  body: PopupBody,
  geometry: PopupBoxGeometry,
): readonly SheetLine[] {
  const blank: SheetLine = { kind: 'row', text: ' '.repeat(geometry.width) };
  const bodyRows = body.lines.slice(0, geometry.bodyRows).map((line) => framedRow(line, geometry));
  while (bodyRows.length < geometry.bodyRows) bodyRows.push(blank);
  return [
    topEdge(parts, geometry),
    ...(geometry.railRows > 0 ? [rail(parts, geometry)] : []),
    ...bodyRows,
    legendRow(parts, geometry),
    bottomEdge(geometry),
  ];
}

/**
 * The keys a notice in a popup's place names: the popup's own leaving keys on its step (`[Ctrl+C] close` where `Esc` does not close) and its
 * way back, so the notice says what they do there. Every other key does nothing on a frame nobody can see.
 */
export function popupNoticeLegend(parts: {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
}): { readonly items: readonly LegendItem[]; readonly exit: LegendExit } {
  return {
    items: parts.items.filter(
      (item) => 'keys' in item && (item.keys === 'Esc' || item.keys === 'Ctrl+C'),
    ),
    exit: parts.exit,
  };
}

/** What a popup says in place of its frame when the terminal cannot hold it. */
export function popupNoticeText(reason: 'below-floor' | 'no-room'): string {
  return reason === 'below-floor'
    ? 'Terminal too small for this popup — enlarge it to 80×24'
    : 'No room for this popup — enlarge the terminal';
}

/**
 * The notice a popup draws in place of its frame (§4: below 80×24, or a block with no room): the reason and the way back, each row filled to
 * the terminal's width, `columns`, so the notice is opaque as the frame is and no cell of the body it covers is left at the end of its rows.
 */
export function popupNoticeLines(
  reason: 'below-floor' | 'no-room',
  keys: { readonly items: readonly LegendItem[]; readonly exit: LegendExit },
  columns: number,
): readonly SheetLine[] {
  const width = Math.max(1, Math.trunc(columns));
  // The reason wraps (at most three rows) rather than losing its end on a narrow terminal; the keys row is the way back.
  const reasonRows = wrappedLines(popupNoticeText(reason), Math.max(1, width - 1), 3);
  const row = clipLine(` ${legend(keys.items, keys.exit)}`, width);
  const spans = legendSpans(keys.items, keys.exit)
    .map((span) => ({ ...span, from: span.from + 1, to: span.to + 1 }))
    .filter((span) => span.from < row.length)
    .map((span) => (span.to <= row.length ? span : { ...span, to: row.length }));
  return [
    ...reasonRows.map((text): SheetLine => ({ kind: 'notice', text: fill(` ${text}`, width) })),
    { kind: 'legend', text: fill(row, width), spans },
  ];
}
