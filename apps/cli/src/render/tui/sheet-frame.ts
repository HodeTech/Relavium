import { glyph } from './glyphs.js';
import { displayWidth, sliceDisplayColumns, wrapWords } from './viewport.js';

/**
 * The small, pure frame a sheet is drawn on ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §5): the roles of its lines, the width a line may use, how a line is cut to it, how a label and a value share one row, and the window of a
 * long list that keeps the cursor on a real line. Nothing here knows what a sheet is about; the popup frames (`popups/frame-model.ts`) and the tab host's
 * lines are built on it, and `legend.ts` is its other half.
 */

/** The role of one drawn line, so a view colours by role and never by guessing from the text. */
export type SheetLineKind =
  | 'rule'
  | 'heading'
  | 'row'
  | 'selected'
  | 'armed'
  | 'text'
  | 'marker'
  | 'note'
  | 'hint'
  | 'message'
  | 'done'
  | 'failed'
  | 'notice'
  | 'question'
  | 'legend';

/** A role a stretch of a line can take over the style of its kind: a dimmed value, an emphasised key, a danger, a success, an attention. */
export type SheetRole = 'dim' | 'strong' | 'danger' | 'ok' | 'warn';

/** A stretch of a line's text, by JS string index (`from` inclusive, `to` exclusive), that takes a role. */
export interface SheetSpan {
  readonly from: number;
  readonly to: number;
  readonly role: SheetRole;
  /**
   * The stretch is the selected item of a line that holds several (the current tab of the strip): it carries the selection marker, so it is
   * also drawn as the selected row is, bold and inverse (ADR-0145 §5). A line that is one item as a whole says so by its kind (`selected`).
   */
  readonly selected?: true;
}

export interface SheetLine {
  readonly kind: SheetLineKind;
  readonly text: string;
  /** Stretches of {@link SheetLine.text} that override the line's own style; absent ⇒ the whole line takes its kind's style. */
  readonly spans?: readonly SheetSpan[];
}

/** The spans that still lie inside `text` once it has been cut to `length` characters; a span that straddles the cut is shortened. */
export function clampSpans(spans: readonly SheetSpan[], length: number): readonly SheetSpan[] {
  return spans
    .filter((span) => span.from < length)
    .map((span) => (span.to <= length ? span : { ...span, to: length }));
}

/** The marker row that stands for `count` hidden rows above a window: `▲ 3 more`. One word and one glyph for every list of every surface. */
export function moreAboveText(count: number): string {
  return `${glyph('moreAbove')} ${String(count)} more`;
}

/** The marker row that stands for `count` hidden rows below a window: `▼ 3 more`. */
export function moreBelowText(count: number): string {
  return `${glyph('moreBelow')} ${String(count)} more`;
}

/** A rule of `width` columns drawn with the thin rule of the glyph table. */
export function thinRuleText(width: number): string {
  return glyph('thinRule').repeat(Math.max(0, width));
}

export interface SheetGeometry {
  readonly columns: number;
  readonly terminalRows: number;
}

/** The widest a sheet's lines are drawn: on a wide terminal a row's value would otherwise sit a hundred columns from its label. */
export const SHEET_MAX_COLUMNS = 100;

/** The columns a line may use: a margin on each side, and no wider than {@link SHEET_MAX_COLUMNS}. */
export function usableColumns(columns: number): number {
  return Math.max(1, Math.min(columns - 2, SHEET_MAX_COLUMNS));
}

/**
 * `text` cut to at most `width` display columns, the cut shown by `…`; whole when it fits. A wide character (CJK, an emoji sequence) that
 * straddles the cut is left out, never counted over the width.
 */
export function clipLine(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return sliceDisplayColumns(text, 0, Math.max(0, width));
  let cut = sliceDisplayColumns(text, 0, width - 1);
  if (displayWidth(cut) > width - 1) cut = sliceDisplayColumns(text, 0, width - 2);
  return `${cut}…`;
}

/** `text` wrapped to `width` into at most `max` lines, a cut shown by `…` on the last; never an empty list. */
export function wrappedLines(text: string, width: number, max: number): readonly string[] {
  const wrapped = wrapWords(text, Math.max(1, width)).map((line) => line.trimEnd());
  if (wrapped.length <= max) return wrapped;
  const kept = wrapped.slice(0, max);
  kept[max - 1] = clipLine(`${kept[max - 1] ?? ''}…`, width);
  return kept;
}

/**
 * The rule that opens a sheet and carries its title, as the card's rule carries `Approval needed`: it also separates the sheet from the
 * conversation above. The title is clipped to leave room for the lead (`─ ` and a space) and two dashes, so the rule is never wider than
 * `width`, and drawn strong; the dashes are dim.
 */
export function titleRule(title: string, width: number): SheetLine {
  const shown = clipLine(title, Math.max(1, width - 5));
  const rule = glyph('thinRule');
  const lead = `${rule} ${shown} `;
  const text = `${lead}${rule.repeat(Math.max(2, width - displayWidth(lead)))}`;
  return {
    kind: 'rule',
    text,
    spans: [
      { from: 0, to: 2, role: 'dim' },
      { from: 2, to: 2 + shown.length, role: 'strong' },
      { from: 2 + shown.length, to: text.length, role: 'dim' },
    ],
  };
}

/**
 * The widest text the wait clock can be ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md)
 * §2): the inline form of a wait that began on an earlier day, `waiting since Nov 25 14:05`, is the longest of both forms (the ticking form is at
 * most `waiting 23h 59m`, the inline one of the same day `waiting since 14:05`, of another year `waiting since Nov 25 2026`), so the room a rule
 * keeps for its clock is this many columns whichever form it shows and whatever the time is. The label is clipped against it, so a tick never
 * changes what the rule's label shows.
 */
export const WAIT_CLOCK_COLUMNS = 26;

/** The months as the inline clock names them: fixed English words, the product's language, never the locale's. */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `n` as two digits. */
function twoDigits(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The alternate screen's wait clock for `elapsedMs` of waiting (ADR-0147 §2), quantised to the unit it shows: seconds for the first minute
 * (`waiting 0:41`), then minutes only (`waiting 2m`), then hours and minutes (`waiting 1h 07m`), then days and hours, and `waiting 99d+`
 * beyond. A negative or non-finite elapsed time (a display clock stepped back) is `waiting 0:00`. Display only: no guard reads it.
 */
export function waitClockText(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.floor(elapsedMs / 1000) : 0;
  if (seconds < 60) return `waiting 0:${twoDigits(seconds)}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `waiting ${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `waiting ${String(hours)}h ${twoDigits(minutes % 60)}m`;
  const days = Math.floor(hours / 24);
  return days < 100 ? `waiting ${String(days)}d ${twoDigits(hours % 24)}h` : 'waiting 99d+';
}

/**
 * The inline renderer's wait clock (ADR-0147 §2): a static `waiting since HH:MM` in local time, because a live region rewritten every second is
 * hostile to assistive tools and costly over SSH. A wait that began on an earlier day than `nowMs` says the day too (`waiting since Nov 25
 * 14:05`), and one of an earlier year the day and the year (`waiting since Nov 25 2026`), so a gate parked yesterday never reads as today. An
 * origin that is not a time draws `waiting`.
 */
export function waitSinceText(sinceMs: number, nowMs: number = Date.now()): string {
  const at = new Date(sinceMs);
  if (!Number.isFinite(at.getTime())) return 'waiting';
  const time = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
  const now = new Date(nowMs);
  // A display clock stepped back below the origin (or one that is not a time) is no later day: the time alone.
  if (!(nowMs > sinceMs) || sameLocalDay(at, now)) return `waiting since ${time}`;
  const day = `${MONTHS[at.getMonth()] ?? ''} ${String(at.getDate())}`;
  return at.getFullYear() === now.getFullYear()
    ? `waiting since ${day} ${time}`
    : `waiting since ${day} ${String(at.getFullYear())}`;
}

/** Whether `a` and `b` fall on the same calendar day in local time. */
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The heavy rule that opens a sheet ([ADR-0147](../../../../../docs/decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md)
 * §1): `━━ <label> ━━━━━━ <clock> ━━`, `width` columns. The label is what the sheet asks, and the clock is the display value of how long it has
 * waited (absent: no clock). The label is clipped against {@link WAIT_CLOCK_COLUMNS}, the room reserved for the widest clock, never against the
 * clock shown, and the run of rule glyphs between them absorbs the clock's length: the rule is the same width and shows the same label whatever
 * the clock says, so a tick never changes its geometry. Without colour the heavy glyph is `=` and the thin one `-` (the glyph table), so a sheet's
 * rule and a thin rule stay apart. The label is `strong`; the view colours the whole rule (amber for a decision, cyan for the agent's question).
 */
export function sheetRule(label: string, clock: string, width: number): SheetLine {
  const heavy = glyph('heavyRule');
  const lead = `${heavy}${heavy} `;
  const tail = ` ${heavy}${heavy}`;
  // `━━ ` + label + ` ` + at least two rule glyphs + ` ` + the reserved clock + ` ━━`
  const room = width - displayWidth(lead) - 1 - 2 - 1 - WAIT_CLOCK_COLUMNS - displayWidth(tail);
  const shown = clipLine(label, Math.max(1, room));
  const head = `${lead}${shown} `;
  // With no clock the rule runs on unbroken to its end.
  const end = clock === '' ? `${heavy}${heavy}` : ` ${clipLine(clock, WAIT_CLOCK_COLUMNS)}${tail}`;
  const between = Math.max(2, width - displayWidth(head) - displayWidth(end));
  return {
    kind: 'rule',
    text: `${head}${heavy.repeat(between)}${end}`,
    spans: [{ from: lead.length, to: lead.length + shown.length, role: 'strong' }],
  };
}

/** The gap kept between a row's label and what flushes right. */
const GAP = 2;
/** The least room the label keeps before the right-hand value is dropped instead of squeezing it. */
const MIN_LABEL = 12;

/** `left` and `right` on one row, `right` flush to the edge; `left` is clipped first, and `right` is dropped when it would leave no room. */
export function flushRow(left: string, right: string, width: number): string {
  if (right.length === 0) return clipLine(left, width);
  const room = width - displayWidth(right) - GAP;
  if (room < MIN_LABEL) return clipLine(left, width);
  const clipped = clipLine(left, room);
  return `${clipped}${' '.repeat(Math.max(GAP, width - displayWidth(clipped) - displayWidth(right)))}${right}`;
}

/** A window of a list and how many entries it hides on each side ({@link markedWindow}). */
export interface MarkedWindow {
  readonly start: number;
  readonly end: number;
  /** How many entries a `▲ N more` marker on the window's FIRST row stands for, the entry under it counted. Absent when nothing is hidden above. */
  readonly above?: number;
  /** How many a `▼ N more` marker on the window's LAST row stands for. Absent when nothing is hidden below. */
  readonly below?: number;
}

/**
 * The window of `height` rows of `total` entries around `selected`, with the marker rows of the lists of the Home: a window that hides
 * entries is marked on its first and last row (the entry under the marker counted, as every list counts them), and `windowBody` keeps
 * `selected` off those two rows. The window is as tall as it was without markers, so a list that scrolled silently keeps its height. A window
 * of fewer than three rows cannot hold a marker, a selected row and the other marker, and is marked on neither side. Pure and in numbers: the
 * words are {@link windowMarkers}, written in the glyph form in force.
 */
export function markedWindow(total: number, selected: number, height: number): MarkedWindow {
  const { start, end } = windowBody(total, selected, height);
  const marked = end - start >= 3;
  return {
    start,
    end,
    ...(marked && start > 0 ? { above: start + 1 } : {}),
    ...(marked && end < total ? { below: total - end + 1 } : {}),
  };
}

/** The marker rows of a {@link MarkedWindow} as text (`▲ 3 more`), in the glyph form in force: a caller draws them inside the form its colour asks for. */
export function windowMarkers(window: MarkedWindow): {
  readonly above: string | undefined;
  readonly below: string | undefined;
} {
  return {
    above: window.above === undefined ? undefined : moreAboveText(window.above),
    below: window.below === undefined ? undefined : moreBelowText(window.below),
  };
}

/**
 * The window of `height` lines of `total` around `cursorLine`. It starts centred on the cursor and, if the caller's `accept` check refuses it,
 * moves outward one line at a time to the nearest start it accepts; a caller that accepts nothing gets the centred window.
 *
 * `accept(start, end)` says whether the window `[start, end)` is a good one for this content: the caller knows what its lines are, so only it
 * can say that a marker would stand in for no row, that a heading would be left alone above one, or that the cursor would sit on one. The
 * default accepts any window that keeps the cursor off the first and last lines when lines are hidden on that side (every hidden line
 * counted as a row), which a window of fewer than three lines cannot do. Pure so the arithmetic is unit-checkable.
 */
export function windowBody(
  total: number,
  cursorLine: number,
  height: number,
  accept?: (start: number, end: number) => boolean,
): { readonly start: number; readonly end: number } {
  if (total <= height) return { start: 0, end: total };
  const last = total - height;
  const centred = Math.max(0, Math.min(cursorLine - Math.floor((height - 1) / 2), last));
  const ok =
    accept ??
    ((start: number, end: number): boolean =>
      cursorLine >= start + (start > 0 ? 1 : 0) && cursorLine < end - (end < total ? 1 : 0));
  for (let offset = 0; offset <= last; offset += 1) {
    for (const start of offset === 0 ? [centred] : [centred - offset, centred + offset]) {
      if (start < 0 || start > last) continue;
      if (ok(start, start + height)) return { start, end: start + height };
    }
  }
  return { start: centred, end: centred + height };
}
