/**
 * The native prompt channel as a popup body ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2 "One shared pure frame with two body drivers"): when a flow sets the channel's optional `popup` descriptor (through `framedFlow`,
 * `home/framed-flow.ts`), its prompt is drawn inside the popup frame instead of as a card. The channel keeps every rule it has (its keys, its
 * validation, its secret handling, its acknowledgement); this module only turns its snapshot into the frame's body rows and legend, and says
 * whether the whole prompt is on the page it is drawn on.
 *
 * - **Every prompt kind is framed**: a choice (`select`, a flow's persistent last step among them), a text or a masked field (`text`,
 *   `password`), a wait (`busy`, static: nothing ticks in a popup's body), a chord card (`chord`: its facts in the body, its answers named in
 *   the legend) and the session picker (`picker`: its filter, its rows in a window, its loading, empty and failed states).
 * - **Rows wrap, they are not cut** (§1, §4). A note, a message, a detail, an option's hint and an error are wrapped to the inner width with
 *   the frame model's one wrap (`wrapRows`), so a disclosure such as a provider's endpoint is never cut off a row: an option's later rows hang
 *   under its label. The list window and the body budget are counted in wrapped rows.
 * - **The whole prompt, or no answer.** A prompt whose notes, message, details and error, plus the least window of its list (three rows, or
 *   its tallest option and the two marker rows), do not fit its page is "not wholly on the page": {@link NativeBodyLayout.fits} is `false`, the
 *   slot draws the notice in its place and acknowledges nothing, so nothing on it answers (the form's `formFits` and the chord card's "a card
 *   that does not fit the terminal is never answered"). A chord step is on its page only when its legend row keeps `[Ctrl+Y]` too.
 * - **One flow, one box.** The overlay popup of a flow does not jump between its steps: it is never shorter than the tallest step the flow has
 *   shown and keeps the row its first prompt took, growing down from it ({@link NativePopupPin}); a resize or another flow drops that, and an
 *   inline popup is untouched. A flow's last step leads its sentence with its mark (`✓`, `✗`; `ok`, `x`), and a notice in place of a popup names
 *   only the keys that act on a frame nobody sees ({@link nativePopupNoticeKeys}).
 * - **Text is untrusted.** Every string is drawn through the inline floor (`popupText`: sanitised, host glyphs blanked, line separators
 *   folded). A chord step's body is a decision about what it says, so its message and details also have their key tokens and legend
 *   separators made inert (`inertLegendText`, ADR-0145 §5). What a flow composes from a project's or a provider's words it scrubs itself (the
 *   full scrub), as the doctor does: this module cannot tell a product sentence from a name inside it.
 */

import {
  exitKey,
  inertLegendText,
  type LegendExit,
  type LegendItem,
  type LegendKey,
} from '../render/tui/legend.js';
import { nativeLeave, type NativePromptSnapshot } from '../render/tui/native-prompt-channel.js';
import { sanitizeInline } from '../render/sanitize.js';
import { glyph } from '../render/tui/glyphs.js';
import { clipLine, type SheetLine } from '../render/tui/sheet-frame.js';
import { displayWidth, sliceDisplayColumns } from '../render/tui/viewport.js';
import { fittedLegendItems, popupNoticeLegend, popupText, wrapRows } from './frame-model.js';
import type { PopupBoxGeometry, PopupPlacement } from './geometry.js';

const FRAMED_KINDS: ReadonlySet<NativePromptSnapshot['kind']> = new Set([
  'select',
  'text',
  'password',
  'busy',
  'chord',
  'picker',
]);

/** Whether the channel's open prompt is drawn as a popup: a flow set the descriptor, and a prompt is open (every kind is framed). */
export function nativeFramed(snapshot: NativePromptSnapshot): boolean {
  return snapshot.active && snapshot.popup !== undefined && FRAMED_KINDS.has(snapshot.kind);
}

/** The fewest rows a list drawn in a window takes: a marker, the highlighted row and the other marker (ADR-0148 §5's overflow state). */
export const NATIVE_LIST_MIN_ROWS = 3;

/** The columns the selection marker and its space take: an option's later rows hang under its label, past them. */
const OPTION_HANG = 2;

/** The bullet a masked field is drawn with, one per character typed (the channel's display, at most 32). */
const SECRET_BULLET = '•';

/**
 * A drawn row of a masked field as the field is NOW (`live`, the channel's current snapshot): every bullet past what the field holds now is a
 * space (one column for one, so the row keeps its width). For the renderer's output phase (`Transform`), which runs on a resize BEFORE the
 * tree is re-rendered: a field the resize emptied is never drawn with the bullets of what was typed into it (ADR-0148 §4). Only a field's row
 * goes through it; a field that holds what it drew is left as it is.
 */
export function withLiveBullets(row: string, live: NativePromptSnapshot): string {
  const held =
    live.kind === 'password'
      ? Array.from(live.display).filter((c) => c === SECRET_BULLET).length
      : 0;
  return row.replace(
    /•+/gu,
    (run) =>
      `${SECRET_BULLET.repeat(Math.min(run.length, held))}${' '.repeat(Math.max(0, run.length - held))}`,
  );
}

/** The key a chord step's affirmative answer is named by on its legend row. */
const CHORD_ALLOW_KEY = 'Ctrl+Y';

/** What the picker says while its page loads (static, as every popup's loading state). */
export const NATIVE_PICKER_LOADING = 'Loading sessions…';
/** What the picker says when its page has no row. */
export const NATIVE_PICKER_EMPTY = 'No matching sessions';

/** The page a framed prompt's body is drawn on: its rows, the rows a list may use of them (ten inline), and the columns of each row. */
export interface NativeBodyGeometry {
  readonly bodyRows: number;
  readonly listRows: number;
  readonly innerWidth: number;
}

/** A framed prompt's body on its page. */
export interface NativeBodyLayout {
  /** The body's rows, each at most the inner width (the frame pads them). */
  readonly lines: readonly SheetLine[];
  /** The index in {@link lines} of a masked field's row (drawn through {@link withLiveBullets}); absent for every other prompt. */
  readonly secretRow?: number | undefined;
  /** Whether the WHOLE prompt is on its page; `false` ⇒ the slot draws the notice in its place and nothing on it answers. */
  readonly fits: boolean;
  /** How far `PgUp`/`PgDn` move a select's cursor when its list is drawn in a window; `undefined` when it is drawn whole. */
  readonly page: number | undefined;
}

/** A window of a list of options: `[start, end)`, the options hidden above and below it named by their marker rows. */
export interface NativeOptionWindow {
  readonly start: number;
  readonly end: number;
}

/** The scrub of a body text: the inline floor, and for a chord step its key tokens and separators made inert (see the module header). */
function scrubFor(snapshot: NativePromptSnapshot): (text: string) => string {
  return snapshot.kind === 'chord' ? (text) => inertLegendText(popupText(text)) : popupText;
}

/** `text` as body rows of `kind`, wrapped to `width`; none for an empty text. */
function wrapped(kind: SheetLine['kind'], text: string, width: number): SheetLine[] {
  if (text === '') return [];
  return wrapRows(text, width).map((row) => ({ kind, text: row }));
}

/**
 * A prompt's message as rows: a plain message is a question, the sentence of a flow's persistent last step leads with its mark (`✓` for a write
 * that happened, `✗` for one that did not, `ok` and `x` in the plain form) so the result is a glyph AND a word in both tones.
 */
function messageRows(snapshot: NativePromptSnapshot, text: string, width: number): SheetLine[] {
  if (snapshot.final === 'failed') return wrapped('failed', `${glyph('failed')} ${text}`, width);
  if (snapshot.final === 'ok') return wrapped('done', `${glyph('completed')} ${text}`, width);
  return wrapped('message', text, width);
}

/** The rows above a prompt's own part: its note (dim), its message, and the details of a chord step or a select (a blank one kept). */
function aboveRows(snapshot: NativePromptSnapshot, width: number): SheetLine[] {
  const scrub = scrubFor(snapshot);
  const rows = [
    ...wrapped('text', scrub(snapshot.note), width),
    ...messageRows(snapshot, scrub(snapshot.message), width),
  ];
  if (snapshot.kind === 'chord' || snapshot.kind === 'select')
    for (const detail of snapshot.details)
      rows.push(
        ...wrapRows(scrub(detail), width).map((text): SheetLine => ({ kind: 'row', text })),
      );
  return rows;
}

/** The error row of a prompt, wrapped whole (a fixed product sentence or the validator's). */
function errorRows(snapshot: NativePromptSnapshot, width: number): SheetLine[] {
  return wrapped('failed', popupText(snapshot.error), width);
}

/** One option of a select as its rows: the marker, the label and the hint after two spaces, wrapped with its later rows under the label. */
function selectOptionRows(
  snapshot: NativePromptSnapshot,
  index: number,
  width: number,
): SheetLine[] {
  const option = snapshot.options[index];
  if (option === undefined) return [];
  const selected = index === snapshot.selected;
  const hint = option.hint === undefined ? '' : `  ${popupText(option.hint)}`;
  const marker = selected ? glyph('selection') : ' ';
  return wrapRows(`${popupText(option.label)}${hint}`, Math.max(1, width - OPTION_HANG)).map(
    (row, at): SheetLine => ({
      kind: selected ? 'selected' : 'row',
      text: `${at === 0 ? marker : ' '} ${row}`,
    }),
  );
}

/** One row of the picker as its rows: the marker and the label (wrapped, hanging), then its hint dim on rows of its own, as the card draws it. */
function pickerOptionRows(
  snapshot: NativePromptSnapshot,
  index: number,
  width: number,
): SheetLine[] {
  const option = snapshot.options[index];
  if (option === undefined) return [];
  const selected = index === snapshot.selected;
  const marker = selected ? glyph('selection') : ' ';
  const room = Math.max(1, width - OPTION_HANG);
  const label = wrapRows(popupText(option.label), room).map(
    (row, at): SheetLine => ({
      kind: selected ? 'selected' : 'row',
      text: `${at === 0 ? marker : ' '} ${row}`,
    }),
  );
  const hint =
    option.hint === undefined
      ? []
      : wrapRows(popupText(option.hint), room).map(
          (row): SheetLine => ({ kind: 'text', text: `  ${row}` }),
        );
  return [...label, ...hint];
}

/** The rows a window of the options `[start, end)` of `total` takes: theirs, and a marker row on each side that hides options. */
function windowRows(heights: readonly number[], start: number, end: number): number {
  let rows = (start > 0 ? 1 : 0) + (end < heights.length ? 1 : 0);
  for (let index = start; index < end; index += 1) rows += heights[index] ?? 0;
  return rows;
}

/**
 * The window of options, of the given heights in rows, that a list of `budget` rows draws around `selected`: every option when they all fit;
 * else the selected option, then one more below and one more above in turn while the rows (a marker row on each side that hides options
 * counted) still fit. `undefined` when even the selected option and its marker rows do not: the list is not wholly on its page. Pure.
 */
export function nativeOptionWindow(
  heights: readonly number[],
  selected: number,
  budget: number,
): NativeOptionWindow | undefined {
  const total = heights.length;
  if (windowRows(heights, 0, total) <= budget) return { start: 0, end: total };
  const at = Math.max(0, Math.min(total - 1, Math.trunc(selected)));
  let start = at;
  let end = at + 1;
  if (windowRows(heights, start, end) > budget) return undefined;
  let down = true;
  for (;;) {
    const canDown = end < total && windowRows(heights, start, end + 1) <= budget;
    const canUp = start > 0 && windowRows(heights, start - 1, end) <= budget;
    if (!canDown && !canUp) break;
    if ((down && canDown) || !canUp) end += 1;
    else start -= 1;
    down = !down;
  }
  return { start, end };
}

/**
 * How far `PgUp`/`PgDn` move the cursor from `selected` in `window` of `total` options: to the window's edge and no further, so no option is
 * paged over without having been drawn (where the window reaches an end of the list, the page is the other side's, which the end clamps).
 * `undefined` for a list drawn whole: the keys then do nothing, as on a card drawn whole.
 */
export function nativeWindowPage(
  window: NativeOptionWindow,
  selected: number,
  total: number,
): number | undefined {
  const up = selected - window.start;
  const down = window.end - 1 - selected;
  if (window.start === 0 && window.end >= total) return undefined;
  if (window.start === 0) return Math.max(1, down);
  if (window.end >= total) return Math.max(1, up);
  return Math.max(1, Math.min(up, down));
}

/** The rows a list needs at least to be on its page: all of them, or the least window (three rows, or its tallest option and two markers). */
function listNeed(heights: readonly number[]): number {
  const all = windowRows(heights, 0, heights.length);
  return Math.min(all, Math.max(NATIVE_LIST_MIN_ROWS, Math.max(0, ...heights) + 2));
}

/** A list of options (each one's rows) in `budget` rows around `selected`: its drawn rows and its page, or `undefined` when it cannot be on the page. */
function listLayout(
  options: readonly (readonly SheetLine[])[],
  selected: number,
  budget: number,
): { readonly lines: readonly SheetLine[]; readonly page: number | undefined } | undefined {
  const heights = options.map((rows) => rows.length);
  if (budget < listNeed(heights)) return undefined;
  const window = nativeOptionWindow(heights, selected, budget);
  if (window === undefined) return undefined;
  const lines: SheetLine[] = [];
  if (window.start > 0)
    lines.push({ kind: 'marker', text: `  ${glyph('moreAbove')} ${String(window.start)} more` });
  for (let index = window.start; index < window.end; index += 1)
    lines.push(...(options[index] ?? []));
  if (window.end < options.length)
    lines.push({
      kind: 'marker',
      text: `  ${glyph('moreBelow')} ${String(options.length - window.end)} more`,
    });
  return { lines, page: nativeWindowPage(window, selected, options.length) };
}

/** A body that is not on its page: nothing of it is drawn (the slot draws the notice) and nothing on it answers. */
const OFF_PAGE: NativeBodyLayout = { lines: [], fits: false, page: undefined };

/** A body drawn whole, with nothing windowed: on its page when its rows fit the body. */
function whole(lines: readonly SheetLine[], geometry: NativeBodyGeometry): NativeBodyLayout {
  return lines.length <= geometry.bodyRows ? { lines, fits: true, page: undefined } : OFF_PAGE;
}

/** A select: its rows above, its options in a window, its error under them. */
function selectLayout(
  snapshot: NativePromptSnapshot,
  geometry: NativeBodyGeometry,
): NativeBodyLayout {
  const width = geometry.innerWidth;
  const above = aboveRows(snapshot, width);
  const below = errorRows(snapshot, width);
  const options = snapshot.options.map((_, index) => selectOptionRows(snapshot, index, width));
  const budget = Math.min(geometry.listRows, geometry.bodyRows - above.length - below.length);
  const list = listLayout(options, snapshot.selected, budget);
  if (list === undefined) return OFF_PAGE;
  return { lines: [...above, ...list.lines, ...below], fits: true, page: list.page };
}

/**
 * What a field shows of `text` after `prefix` in a row of `width`: all of it, or its END after an ellipsis (a field scrolls to where one types).
 * The text is what the person typed or pasted (the channel's display: bullets for a secret); it is drawn as typed, host glyphs included, and
 * sanitised again here, so a display that reached the frame by another road can draw no control or bidirectional character either.
 */
function fieldRow(prefix: string, typed: string, width: number): string {
  const text = sanitizeInline(typed);
  const all = `${prefix}${text}`;
  if (displayWidth(all) <= width) return all;
  const total = displayWidth(text);
  const room = Math.max(0, width - displayWidth(prefix) - 1);
  return clipLine(`${prefix}…${sliceDisplayColumns(text, total - room, total)}`, width);
}

/** A text or a masked field: its rows above, the field (the channel's display: bullets for a secret, never the secret), its error. */
function fieldLayout(
  snapshot: NativePromptSnapshot,
  geometry: NativeBodyGeometry,
): NativeBodyLayout {
  const width = geometry.innerWidth;
  const above = aboveRows(snapshot, width);
  const layout = whole(
    [
      ...above,
      { kind: 'row', text: fieldRow('> ', snapshot.display, width) },
      ...errorRows(snapshot, width),
    ],
    geometry,
  );
  return snapshot.kind === 'password' && layout.fits
    ? { ...layout, secretRow: above.length }
    : layout;
}

/** Whether a chord step's legend row keeps its affirmative answer (`[Ctrl+Y]`) at `width`: a step whose answer is not named is never answered. */
function chordAnswerNamed(snapshot: NativePromptSnapshot, width: number): boolean {
  // Judged on the row as it is drawn while the card's `Ctrl+Y` waits (`(wait)`), the longer of its two: a step whose answer that row would
  // drop is on its page in neither state, so the lock opening never turns a notice into a frame (which would be a new frame to read).
  return fittedLegendItems(nativePopupLegend(snapshot, false, true), width).some(
    (item) => 'keys' in item && item.keys === CHORD_ALLOW_KEY,
  );
}

/** A chord step: its message and its facts, on its page only when its answer is named on the legend row too. */
function chordLayout(
  snapshot: NativePromptSnapshot,
  geometry: NativeBodyGeometry,
): NativeBodyLayout {
  const layout = whole(aboveRows(snapshot, geometry.innerWidth), geometry);
  return layout.fits && chordAnswerNamed(snapshot, geometry.innerWidth) ? layout : OFF_PAGE;
}

/** The picker's filter line: the filter typed so far, the caret where the editor's cursor is. */
function pickerFilterRow(snapshot: NativePromptSnapshot, width: number): string {
  const cursor = Math.max(
    0,
    Math.min(snapshot.picker?.cursor ?? snapshot.display.length, snapshot.display.length),
  );
  const text = `${snapshot.display.slice(0, cursor)}${glyph('caret')}${snapshot.display.slice(cursor)}`;
  return fieldRow('Filter: ', text, width);
}

/** What the picker's page says instead of rows: loading, a failed read, or no row. */
function pickerStateRows(snapshot: NativePromptSnapshot, width: number): SheetLine[] {
  if (snapshot.picker?.loading === true) return [{ kind: 'message', text: NATIVE_PICKER_LOADING }];
  if (snapshot.error !== '') return errorRows(snapshot, width);
  if (snapshot.options.length === 0) return [{ kind: 'text', text: NATIVE_PICKER_EMPTY }];
  return [];
}

/** The picker: its question, its scope and page, its filter line, its state, and its rows in a window. */
function pickerLayout(
  snapshot: NativePromptSnapshot,
  geometry: NativeBodyGeometry,
): NativeBodyLayout {
  const width = geometry.innerWidth;
  const scope = snapshot.picker?.allDirectories === true ? 'All directories' : 'This directory';
  const head: SheetLine[] = [
    ...wrapped('message', popupText(snapshot.message), width),
    { kind: 'text', text: `${scope} · Page ${String(snapshot.picker?.page ?? 1)}` },
    { kind: 'row', text: pickerFilterRow(snapshot, width) },
    ...pickerStateRows(snapshot, width),
  ];
  const options = snapshot.options.map((_, index) => pickerOptionRows(snapshot, index, width));
  const list = listLayout(
    options,
    snapshot.selected,
    Math.min(geometry.listRows, geometry.bodyRows - head.length),
  );
  if (list === undefined) return OFF_PAGE;
  // The picker pages by loading the next page (its own `PgUp`/`PgDn`), never by a window.
  return { lines: [...head, ...list.lines], fits: true, page: undefined };
}

/**
 * A framed prompt's body on its page: its rows, whether the whole prompt is on the page, and how far a windowed select pages. Run inside
 * `withGlyphForm`: the markers and the selection glyph are drawn in the form in force.
 */
export function nativePopupLayout(
  snapshot: NativePromptSnapshot,
  geometry: NativeBodyGeometry,
): NativeBodyLayout {
  switch (snapshot.kind) {
    case 'select':
      return selectLayout(snapshot, geometry);
    case 'text':
    case 'password':
      return fieldLayout(snapshot, geometry);
    case 'chord':
      return chordLayout(snapshot, geometry);
    case 'picker':
      return pickerLayout(snapshot, geometry);
    case 'busy':
    case 'idle':
      return whole(aboveRows(snapshot, geometry.innerWidth), geometry);
  }
}

/**
 * The body rows a framed prompt would like at `innerWidth`, before any window: every wrapped row it has (what the geometry is asked for).
 * Run inside `withGlyphForm`, as the layout is.
 */
export function nativeNaturalRows(snapshot: NativePromptSnapshot, innerWidth: number): number {
  return nativePopupLayout(snapshot, {
    bodyRows: Number.POSITIVE_INFINITY,
    listRows: Number.POSITIVE_INFINITY,
    innerWidth,
  }).lines.length;
}

/** The terminal a pin was taken in (and the one a frame is drawn in). */
export interface NativePopupSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * What the popup of ONE flow remembers while it is open, so that its steps do not jump (ADR-0148 §4; the overlay only: an inline popup is a
 * block in the flow and takes the rows it takes): the tallest body any of its prompts has had, and the row its first prompt's popup took. The
 * popup never shrinks below that body and keeps that top row, growing DOWN from it; where the taller box would not fit below the pinned row, the
 * geometry's own centring places it (and that row is the new one to keep).
 *
 * It belongs to the flow it was taken in (its title, origin and step count) and to the terminal it was taken in: another flow, or ANY resize,
 * drops it, so a pin can neither carry one flow's height into the next nor hold a box a smaller terminal cannot. It is bounded by the geometry
 * (`popupGeometry` clamps a body to the rows a terminal gives), so it can never trap the person below the floor either: there the popup is not
 * drawn at all. The popup slot keeps it for as long as the flow's popup is mounted, so a flow's next popup starts fresh.
 */
export interface NativePopupPin {
  readonly flow: string;
  readonly cols: number;
  readonly rows: number;
  readonly bodyRows: number;
  readonly top: number;
}

/** What names a flow's popup for its pin: the descriptor's title, origin and step count (a frame with none has no flow). */
function pinFlow(snapshot: NativePromptSnapshot): string | undefined {
  const descriptor = snapshot.popup;
  return descriptor === undefined
    ? undefined
    : [descriptor.title, descriptor.origin, String(descriptor.stepCount)].join('\u0000');
}

/** The pin that still holds for this frame: the overlay's, of this flow, in this terminal; anything else is no pin. */
export function livePin(
  pin: NativePopupPin | undefined,
  snapshot: NativePromptSnapshot,
  placement: PopupPlacement,
  size: NativePopupSize,
): NativePopupPin | undefined {
  if (pin === undefined || placement !== 'overlay') return undefined;
  const same = pin.flow === pinFlow(snapshot) && pin.cols === size.cols && pin.rows === size.rows;
  return same ? pin : undefined;
}

/** The body rows a frame asks the geometry for: what its content wants, and never fewer than the flow's tallest step so far. */
export function pinnedBodyRows(naturalRows: number, pin: NativePopupPin | undefined): number {
  return Math.max(naturalRows, pin?.bodyRows ?? 0);
}

/** The frame's top row: the pinned one while the whole box fits below it, else where the geometry centred it. */
export function pinnedTop(
  geometry: PopupBoxGeometry,
  pin: NativePopupPin | undefined,
  terminalRows: number,
): number {
  if (pin === undefined || geometry.placement !== 'overlay') return geometry.top;
  return pin.top + geometry.height <= terminalRows ? pin.top : geometry.top;
}

/**
 * The pin the next frame of this flow starts from, given the box just drawn (`box`, its top already pinned): the first PROMPT of a flow takes
 * it (a wait before it, the frame right after `begin`, establishes nothing: it is not a step the person stays on), and every later frame, a
 * wait included, only raises its height and moves its row when the box had to move. A frame drawn in a window (`windowed`: a long list) takes
 * no part in it. `undefined` for an inline popup.
 */
export function nextPin(
  pin: NativePopupPin | undefined,
  snapshot: NativePromptSnapshot,
  placement: PopupPlacement,
  size: NativePopupSize,
  box: PopupBoxGeometry,
  windowed = false,
): NativePopupPin | undefined {
  if (placement !== 'overlay') return undefined;
  // A list drawn in a window takes every row the terminal gives (the `/pricing` model list is 21 rows): it neither sets the height the flow's
  // other steps keep nor moves the row they keep, or a one-line price field would sit in a box as tall as the list.
  if (pin !== undefined)
    return windowed
      ? pin
      : { ...pin, bodyRows: Math.max(pin.bodyRows, box.bodyRows), top: box.top };
  const flow = pinFlow(snapshot);
  if (windowed || flow === undefined || snapshot.kind === 'busy' || snapshot.kind === 'idle')
    return undefined;
  return { flow, cols: size.cols, rows: size.rows, bodyRows: box.bodyRows, top: box.top };
}

/** `Tab` flips the picker between this directory and all of them, and the legend says which one it goes to. */
function scopeKey(snapshot: NativePromptSnapshot): LegendKey {
  return {
    keys: 'Tab',
    verb: snapshot.picker?.allDirectories === true ? 'this directory' : 'all directories',
  };
}

/**
 * The picker's legend, as parts: what its keys do, or, after a failed read, how to try again or change the filter. Its leaving keys are the
 * prompt's own ({@link nativeLeave}). The card's one-line legend (`native-prompt-view.tsx` `pickerLegend`) is this, joined.
 */
export function pickerLegendParts(snapshot: NativePromptSnapshot): {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
} {
  const { before, exit } = nativeLeave(snapshot.escape === 'back');
  if (snapshot.error === '')
    return {
      items: [
        { keys: '↑/↓', verb: 'select' },
        { keys: 'Enter', verb: 'resume' },
        scopeKey(snapshot),
        { keys: 'PgUp/PgDn', verb: 'page' },
        ...before,
      ],
      exit,
    };
  const next: LegendItem =
    snapshot.picker?.retryable === true
      ? { keys: 'Enter', verb: 'retry' }
      : { text: 'Edit filter' };
  return { items: [next, ...before], exit };
}

/** What `Enter` says on a text or a masked field: the step's own verb where its flow gave one (a product constant), else `continue`. */
function enterVerbOf(snapshot: NativePromptSnapshot): string {
  const verb = snapshot.popup?.enterVerb;
  return verb === undefined || verb === '' ? 'continue' : verb;
}

/** The mark of a key its guard holds now ({@link LegendKey.wait}: dim, `(wait)`), or nothing. */
function waiting(locked: boolean): { readonly wait?: true } {
  return locked ? { wait: true } : {};
}

/** Whether the select's highlighted option is the guarded one: the only option whose `Enter` the lock holds (every other answers at once). */
function onGuardedRow(snapshot: NativePromptSnapshot): boolean {
  return snapshot.options[snapshot.selected]?.guarded === true;
}

/**
 * The ONE legend of a prompt of the channel, as parts, for both of its surfaces: the card (`native-prompt-view.tsx` joins them into its one
 * line) and the popup frame (which fits them to its row and names the way back in the descriptor's words). They differ in one place only: a
 * chord CARD draws its answers as rows of its own, so its legend is the way back alone, where the popup names the answers on the legend row.
 * `windowed` names `PgUp/PgDn page` for a select drawn in a window. `locked` is the channel's lock (`NativePromptUi.lock`): while it holds, the
 * affirmative's part waits (`[Ctrl+Y] <allow> (wait)`, and `Enter choose (wait)` while the guarded option is highlighted).
 */
export function nativeLegendParts(
  snapshot: NativePromptSnapshot,
  windowed: boolean,
  surface: 'card' | 'popup',
  locked = false,
): { readonly items: readonly LegendItem[]; readonly exit: LegendExit } {
  const back = snapshot.escape === 'back';
  switch (snapshot.kind) {
    case 'select': {
      const { before, exit } = nativeLeave(back);
      const paging: readonly LegendItem[] = windowed ? [{ keys: 'PgUp/PgDn', verb: 'page' }] : [];
      return {
        items: [
          { keys: '↑/↓', verb: 'select' },
          ...paging,
          { keys: 'Enter', verb: 'choose', ...waiting(locked && onGuardedRow(snapshot)) },
          ...before,
        ],
        exit,
      };
    }
    case 'text':
    case 'password': {
      const { before, exit } = nativeLeave(back);
      return { items: [{ keys: 'Enter', verb: enterVerbOf(snapshot) }, ...before], exit };
    }
    case 'chord': {
      // The answers, named on the legend row: the affirmative first (it is kept longest), then the refusal, then the way back (which refuses).
      const { before, exit } = nativeLeave(back, 'denies');
      if (surface === 'card') return { items: before, exit };
      const label = (value: string): string =>
        snapshot.options.find((option) => option.value === value)?.label ?? value;
      return {
        items: [
          { keys: CHORD_ALLOW_KEY, verb: label('allow'), role: 'ok', ...waiting(locked) },
          { keys: 'Ctrl+N', verb: label('deny'), role: 'danger' },
          ...before,
        ],
        exit,
      };
    }
    case 'picker':
      return pickerLegendParts(snapshot);
    case 'busy':
    case 'idle': {
      const { before, exit } = nativeLeave(back, 'cancels it');
      return { items: [...before], exit };
    }
  }
}

/** The key of a legend item that pages a windowed select: the first to go when the row is too short (the choice outranks it). */
const PAGING_KEYS = 'PgUp/PgDn';

/**
 * How long each legend item is kept when the row does not fit (higher is kept longer; the keys that leave are kept by the frame whatever this
 * says): by position, except that paging gives way to every other key, `Enter choose` included. Absent when nothing pages, so the frame's own
 * order by position stands.
 */
function legendPriority(items: readonly LegendItem[]): readonly number[] | undefined {
  if (!items.some((item) => 'keys' in item && item.keys === PAGING_KEYS)) return undefined;
  return items.map((item, index) =>
    'keys' in item && item.keys === PAGING_KEYS ? 0 : items.length - index,
  );
}

/**
 * The `Esc` of a prompt that steps back, in its step's own word where the flow gave one (`skip for now` on the first run's first step, whose
 * step back is the skip: `NativePopupDescriptor.escapeVerb`, a product constant), else the `back` the channel names it by.
 */
function withEscapeVerb(
  items: readonly LegendItem[],
  snapshot: NativePromptSnapshot,
): readonly LegendItem[] {
  const verb = snapshot.popup?.escapeVerb;
  if (verb === undefined || verb === '') return items;
  return items.map((item) => ('keys' in item && item.keys === 'Esc' ? { ...item, verb } : item));
}

/**
 * The rail's `done` marks of a framed prompt (`PopupFrameParts.done`, parallel to its steps): `false` for a step the flow passed without doing
 * it (`NativePopupDescriptor.skipped`), so the rail draws it as not done; `undefined` when the flow skipped none (every step before is done).
 */
export function nativeRailDone(snapshot: NativePromptSnapshot): readonly boolean[] | undefined {
  const descriptor = snapshot.popup;
  const skipped = descriptor?.skipped;
  if (descriptor === undefined || skipped === undefined || skipped.length === 0) return undefined;
  return Array.from({ length: descriptor.stepCount }, (_, index) => !skipped.includes(index));
}

/**
 * The legend of a framed prompt: what its keys do, and the way back the channel's `escape` gives it, in the descriptor's words where it
 * closes. A flow's persistent last step says `Enter / Esc close` and nothing else; a select drawn in a window names `PgUp/PgDn page`, which
 * is the first thing a short row drops. `locked`: the channel's lock (see {@link nativeLegendParts}); the row keeps a waiting part before every
 * other key but the ways out (`fittedLegendItems`).
 */
export function nativePopupLegend(
  snapshot: NativePromptSnapshot,
  windowed = false,
  locked = false,
): {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
  readonly priority?: readonly number[];
} {
  if (snapshot.kind === 'select' && snapshot.final !== undefined)
    return { items: [], exit: exitKey.close(['Enter', 'Esc'], 'close') };
  const parts = nativeLegendParts(snapshot, windowed, 'popup', locked);
  const { exit } = parts;
  const items = withEscapeVerb(parts.items, snapshot);
  const label = snapshot.popup?.exitLabel ?? '';
  const named = exit.class === 'close' && label !== '' ? exitKey.close(exit.keys, label) : exit;
  const priority = legendPriority(items);
  return priority === undefined ? { items, exit: named } : { items, exit: named, priority };
}

/**
 * The keys a framed prompt names in the notice drawn in its place (below the floor, no room, too long): only the ones that act on a frame
 * nobody can see. `Esc` and `Ctrl+C` reach the channel blind and do what the prompt says they do; `Enter` and a chord's answers do not (nothing
 * on an unseen frame answers), so the Done step's `Enter / Esc close` is `Esc close` here.
 */
export function nativePopupNoticeKeys(snapshot: NativePromptSnapshot): {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
} {
  if (snapshot.kind === 'select' && snapshot.final !== undefined)
    return { items: [], exit: exitKey.close('Esc', 'close') };
  return popupNoticeLegend(nativePopupLegend(snapshot));
}
