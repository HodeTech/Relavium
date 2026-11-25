/**
 * The popup's frame, as rows of text ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §4 and §5): the ONE pure model of what a popup draws, whichever driver feeds its body (the popup host's reducer, or the native prompt
 * channel's snapshot) and whichever placement it is drawn in. The view (`popup-frame-view.tsx`) only paints these rows.
 *
 * **Four parts, always in this order** (§1): the top edge (the command's name on the left, the origin on the right, and `step 2 of 3` for a
 * popup of more than one step, so a glyph is never the only carrier of the step); the step rail, only for more than one step, in the Home rail's
 * language (`✓ done ╌╌ ◉ current ╌╌ ○ to come`, each glyph from the table, with its plain form when colour is off); the body; and the legend,
 * which always ends with the way back and is the last thing truncated. A bottom edge closes the frame.
 *
 * **Every row is exactly the frame's width** (§4). A row is filled with spaces to the width, because the spike showed that a row one cell short
 * lets the body behind it show through at its edge: the padding is what makes the popup opaque, and opacity is the safety property. The frame's
 * sides are open, a tray as the sheet's frame is (ADR-0147 §1): the glyph table has no vertical frame glyph, and the open sides are what the
 * inline form must draw anyway (§4: rules without side bars, which a screen reader would voice on every line). One column of margin inside
 * each side keeps a row's text off the body behind it.
 *
 * **Text is untrusted.** A title, a row, a detail or a report line can carry a name a project, a provider or a model wrote, so every string is
 * passed through the inline sanitiser (control and bidirectional characters) and the host-glyph blanking (a row cannot draw `✓`, `›` or a rule
 * the host draws), and is clipped to its row. The status glyphs and the selection marker are drawn by the model from the table, by role.
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
  legendSpans,
  type LegendExit,
  type LegendItem,
} from '../render/tui/legend.js';
import {
  clipLine,
  markedWindow,
  windowMarkers,
  wrappedLines,
  type SheetLine,
  type SheetSpan,
} from '../render/tui/sheet-frame.js';
import { displayWidth } from '../render/tui/viewport.js';
import { POPUP_MAX_WIDTH, POPUP_SIDE_MARGIN, type PopupBoxGeometry } from './geometry.js';

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
}

/**
 * What a popup's body shows: the four content states every popup draws (§5) and the two bodies that hold data.
 *
 * - `loading`: a static `…`, and the elapsed seconds once past five (a display value from the host's clock, never at the frame rate, never
 *   inline); the legend names the cancel key it really has.
 * - `empty`: what is empty, and what to do.
 * - `error`: what failed, and the next action INSIDE the TUI (never a shell command: `no-shell-remedy.test.ts` reads this directory).
 * - `list`: rows to choose from, windowed with `▲ N more` / `▼ N more` and the highlighted row always in the window.
 * - `report`: lines to read, windowed the same way.
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
  | { readonly kind: 'report'; readonly lines: readonly string[] };

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

/** Text from a command, a project, a provider or a model, made safe to draw beside the host's own marks: sanitised and host-glyph blanked. */
export function popupText(text: string): string {
  return blankHostGlyphs(sanitizeInline(text));
}

/** The body as the frame needs it: its rows (not yet padded) and the window's position, for a caller that keeps the selection in view. */
export interface PopupBody {
  readonly lines: readonly SheetLine[];
}

export interface PopupBodyState {
  /** The highlighted row of a list (an index into its rows). */
  readonly selected: number;
  /** The first line of a report that is shown. */
  readonly offset: number;
  /** The filter's text, when the step has a filter line (`undefined` ⇒ no filter line). */
  readonly filter?: string | undefined;
}

/**
 * How many body rows `content` would like: what the geometry is asked for. A list or a report asks for every row it has, or `maxListRows`
 * (a block in the flow windows a list to ten rows, `INLINE_LIST_MAX_ROWS`), so the block is never padded with rows its list cannot use.
 */
export function naturalBodyRows(
  content: PopupContent,
  state: PopupBodyState,
  maxListRows = Number.POSITIVE_INFINITY,
): number {
  const filterRows = state.filter === undefined ? 0 : 1;
  switch (content.kind) {
    case 'loading':
      return filterRows + 1;
    case 'empty':
    case 'error':
      return filterRows + 2;
    case 'list':
      return (
        filterRows +
        (content.heading === undefined ? 0 : 1) +
        Math.min(maxListRows, Math.max(1, content.rows.length))
      );
    case 'report':
      return filterRows + Math.min(maxListRows, Math.max(1, content.lines.length));
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

function listRowText(row: PopupListRow, selected: boolean): string {
  if (row.section === true) return `  ${popupText(row.label)}`;
  const mark = row.status === undefined ? undefined : glyph(row.status);
  const status =
    mark === undefined
      ? ''
      : `${row.statusWord === undefined ? mark : markWithWord(mark, popupText(row.statusWord))}  `;
  const enabled = row.enabled !== false;
  const detail = enabled
    ? row.detail === undefined
      ? ''
      : `  ${popupText(row.detail)}`
    : `  ${popupText(row.reason ?? 'unavailable')}`;
  return `${marker(selected)} ${status}${popupText(row.label)}${detail}`;
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
  const out: SheetLine[] = [];
  for (let index = start; index < end; index += 1) {
    if (height >= 3 && index === start && start > 0)
      out.push(bodyLine('marker', `  ${glyph('moreAbove')} ${String(start + 1)} more`, width));
    else if (height >= 3 && index === end - 1 && end < total)
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
    case 'loading':
      lines.push(
        bodyLine(
          'message',
          `${popupText(content.what)}…${elapsed === undefined ? '' : `  ${elapsed}`}`,
          width,
        ),
      );
      break;
    case 'empty':
      lines.push(bodyLine('message', popupText(content.what), width));
      lines.push(bodyLine('text', popupText(content.next), width));
      break;
    case 'error':
      lines.push(bodyLine('failed', `${glyph('failed')} ${popupText(content.what)}`, width));
      lines.push(bodyLine('text', popupText(content.next), width));
      break;
    case 'list': {
      if (content.heading !== undefined)
        lines.push(bodyLine('message', headingText(content.heading), width));
      const left = Math.max(1, geometry.bodyRows - lines.length);
      lines.push(
        ...listLines(content.rows, state.selected, Math.min(left, geometry.listRows), width),
      );
      break;
    }
    case 'report':
      lines.push(
        ...reportLines(content.lines, state.offset, Math.min(room, geometry.listRows), width),
      );
      break;
  }
  return { lines: lines.slice(0, geometry.bodyRows) };
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
   * The legend's items and its way back, built from the same constants the key fold reads. Items are dropped from the end when they do not fit
   * (or by `priority`, parallel to `items`, higher kept longer); the way back never is.
   */
  readonly legend: {
    readonly items: readonly LegendItem[];
    readonly exit: LegendExit;
    readonly priority?: readonly number[] | undefined;
  };
}

/** `text` filled with spaces to exactly `width` columns (it is already clipped to fit). */
function fill(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** A row of the frame: the margin, the content clipped to the inner width, then spaces to the frame's width. Spans move with the margin. */
function framedRow(line: SheetLine, geometry: PopupBoxGeometry): SheetLine {
  const margin = ' '.repeat(POPUP_SIDE_MARGIN);
  const content = clipLine(line.text, geometry.innerWidth);
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

/** The top edge: `─ title ───── from Home · step 2 of 3 ─`, exactly the frame's width; the title is clipped first. */
function topEdge(parts: PopupFrameParts, geometry: PopupBoxGeometry): SheetLine {
  const rule = glyph('thinRule');
  const right =
    parts.steps.length > 1
      ? `${originLabel(parts.origin)} · step ${String(parts.stepIndex + 1)} of ${String(parts.steps.length)}`
      : originLabel(parts.origin);
  // `─ ` + title + ` ` + at least two rules + ` ` + right + ` ─`
  const room = geometry.width - displayWidth(right) - 7;
  const title = clipLine(popupText(parts.title), Math.max(1, room));
  const lead = `${rule} ${title} `;
  const tail = ` ${right} ${rule}`;
  const between = Math.max(0, geometry.width - displayWidth(lead) - displayWidth(tail));
  const text = clipLine(`${lead}${rule.repeat(between)}${tail}`, geometry.width);
  // The rule and the origin are dim; the command's name is what the eye looks for.
  const titleEnd = Math.min(text.length, 2 + title.length);
  return {
    kind: 'rule',
    text: fill(text, geometry.width),
    spans: [
      { from: 0, to: 2, role: 'dim' },
      { from: 2, to: titleEnd, role: 'strong' },
      { from: titleEnd, to: text.length, role: 'dim' },
    ],
  };
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
    const role: GlyphRole =
      index < parts.stepIndex ? 'completed' : index === parts.stepIndex ? 'currentStep' : 'pending';
    const node = `${glyph(role)} ${popupText(name)}`;
    spans.push({
      from: text.length,
      to: text.length + node.length,
      role: index < parts.stepIndex ? 'ok' : index === parts.stepIndex ? 'strong' : 'dim',
    });
    text += node;
  });
  return framedRow({ kind: 'row', text, spans }, geometry);
}

/** The legend, fitted to the inner width: the way back is always kept and the other items go from the end first. */
function legendRow(parts: PopupFrameParts, geometry: PopupBoxGeometry): SheetLine {
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
    {
      kind: 'rule',
      text: glyph('thinRule').repeat(geometry.width),
      spans: [{ from: 0, to: geometry.width, role: 'dim' }],
    },
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
 * one width so the notice is opaque as the frame is. At most `columns` wide.
 */
export function popupNoticeLines(
  reason: 'below-floor' | 'no-room',
  keys: { readonly items: readonly LegendItem[]; readonly exit: LegendExit },
  columns: number,
): readonly SheetLine[] {
  const width = Math.max(1, Math.min(columns, POPUP_MAX_WIDTH));
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
