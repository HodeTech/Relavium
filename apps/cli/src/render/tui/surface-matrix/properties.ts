import type { DOMElement } from 'ink';
import stringWidth from 'string-width';

import { cellsAreSound, type ScreenCell } from './terminal.js';
import type { Variant } from './variants.js';

/**
 * The properties that must hold for every screen of the product ([ADR-0122](../../../../../../docs/decisions/0122-the-home-is-the-interactive-product.md)
 * §7, MVP-11 §5.6). Pure functions over what a mounted surface left on the terminal, so each is tested on its own (against a surface that
 * breaks it on purpose) as well as through every mount.
 *
 * The sixth property of the plan, "every state the colour shows also has words", is not automated: it needs a reader, not a rule.
 */

export type PropertyId =
  | 'height'
  | 'width'
  | 'exit-key'
  | 'no-scrollback-clear'
  | 'no-colour'
  /** Not one of the five: the surface draws its selected row inverse, with colour on and off alike (ADR-0145 §5), for a surface that names one. */
  | 'selected-row'
  /** Not one of the five: the surface's own landmark (or, below the floor, its notice) is on screen, so a frame that never opened cannot pass. */
  | 'surface-shown'
  /** Not one of the five: the surface's own legend row is on ONE row of the frame, whole, so a layout that merges or overwrites it cannot pass. */
  | 'legend-row'
  /**
   * Not one of the five (ADR-0148 §2): the tree holds an absolutely positioned node only while a popup is open, exactly one, and it is the one
   * overlay slot, the last child of every node up to the root, so nothing can be drawn after it (z-order is tree order).
   */
  | 'overlay-layer'
  /**
   * Not one of the five (ADR-0148 §2, §4): a popup in the overlay draws exactly its own rows in its box (nothing over them) and changes no cell
   * outside its box; a popup in the flow is the live region and nothing else.
   */
  | 'popup-box'
  /**
   * Not one of the five (ADR-0148 §4): while a popup is open in the alternate screen with colour on, EVERY cell of the body outside the popup that
   * shows something carries the dim attribute, on a body that holds bold, inverse and coloured spans; the popup's own cells are not dimmed; with
   * colour off, or inline, nothing is dimmed by us.
   */
  | 'backdrop-dim';

export interface Violation {
  readonly property: PropertyId;
  readonly message: string;
}

/** What a mounted surface left on the terminal. */
export interface Observation {
  readonly variant: Variant;
  /** The screen's lines (styling absent). */
  readonly lines: readonly string[];
  /** Every byte written to the terminal, styling included. */
  readonly raw: string;
  /**
   * How many of the first `lines` Ink printed once through `<Static>` (the inline renderer's scrollback). They stay on the screen, but they are
   * not the live frame: the height and a popup's rows are measured over {@link liveLines}. Absent ⇒ none (a mount that cannot say).
   */
  readonly staticRows?: number | undefined;
}

/**
 * The rows of the live frame: the screen's lines but the first `staticRows`, which Ink printed once through `<Static>` and never redraws. A
 * count that is not a whole number of rows in range is no count (`0`): nothing is excluded on a guess, so a surface can never hide a row of
 * its live frame behind a bad number.
 */
export function liveLines(observation: Observation): readonly string[] {
  const rows = observation.staticRows ?? 0;
  return Number.isInteger(rows) && rows > 0 && rows <= observation.lines.length
    ? observation.lines.slice(rows)
    : observation.lines;
}

const ESC = String.fromCharCode(0x1b);
/** The scrollback-clear sequence Ink writes (inside its clear-terminal) when a frame fills the terminal. */
export const SCROLLBACK_CLEAR = `${ESC}[3J`;
const SGR = new RegExp(`${ESC}\\[([0-9;:]*)m`, 'gu');
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'gu');

/** The text of a string with every escape sequence removed: what a person reads. */
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/**
 * Whether one SGR parameter list sets a colour: a foreground 30–37 or 90–97, a background 40–47 or 100–107, or an extended colour 38 or 48.
 * Bold, dim, italic, underline, inverse, strike and their resets are not colour, nor are the "default colour" resets 39 and 49 (closing a
 * colour that was never opened changes nothing; an opening one is caught on its own).
 */
export function sgrSetsColour(params: string): boolean {
  const parts = params.split(/[;:]/u).filter((part) => part !== '');
  for (let index = 0; index < parts.length; index += 1) {
    const code = Number(parts[index]);
    if (code === 38 || code === 48) return true;
    if ((code >= 30 && code <= 37) || (code >= 40 && code <= 47)) return true;
    if ((code >= 90 && code <= 97) || (code >= 100 && code <= 107)) return true;
  }
  return false;
}

/** Every colour SGR in the raw bytes, as the sequence text (`ESC[31m` is shown as `\u001b[31m`). */
export function colourSequences(raw: string): string[] {
  const found: string[] = [];
  for (const match of raw.matchAll(SGR)) {
    if (sgrSetsColour(match[1] ?? '')) found.push(match[0].replaceAll(ESC, '\\u001b'));
  }
  return found;
}

const preview = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

/**
 * (1) The live frame has at most `rows - 1` lines: a frame as tall as the terminal makes Ink clear the whole terminal and scroll. The rows Ink
 * printed through `<Static>` are not the frame (Ink measures only the live region against the terminal, and they scroll into the history), so
 * they are not counted; every other row of the screen is, whatever it says.
 */
export function checkHeight(observation: Observation): Violation[] {
  const budget = observation.variant.size.rows - 1;
  const count = liveLines(observation).length;
  const scrollback = observation.lines.length - count;
  return count <= budget
    ? []
    : [
        {
          property: 'height',
          message: `${String(count)} lines on a ${String(observation.variant.size.rows)}-row terminal (at most ${String(budget)}${scrollback > 0 ? `; ${String(scrollback)} more row(s) are scrollback and not counted` : ''})`,
        },
      ];
}

/** (2) No line is wider than the terminal, by display width. */
export function checkWidth(observation: Observation): Violation[] {
  const columns = observation.variant.size.cols;
  const wide = observation.lines
    .map((line, index) => ({ index, width: stringWidth(line), line }))
    .filter((entry) => entry.width > columns);
  return wide.map((entry) => ({
    property: 'width',
    message: `line ${String(entry.index + 1)} is ${String(entry.width)} columns wide on a ${String(columns)}-column terminal: "${preview(entry.line)}"`,
  }));
}

/** (3) The surface's exit key is visible somewhere in the frame, as the words the surface declares (`Esc`, `Ctrl+C`). */
export function checkExitKey(observation: Observation, exitKey: string): Violation[] {
  return observation.lines.some((line) => line.includes(exitKey))
    ? []
    : [{ property: 'exit-key', message: `the exit key "${exitKey}" is not in the frame` }];
}

/** (4) Nothing the inline renderer wrote contains the scrollback-clear sequence: the user's earlier scrollback stays. */
export function checkNoScrollbackClear(observation: Observation): Violation[] {
  if (observation.variant.renderer !== 'inline') return [];
  return observation.raw.includes(SCROLLBACK_CLEAR)
    ? [
        {
          property: 'no-scrollback-clear',
          message: 'the inline output contains the scrollback-clear sequence \\u001b[3J',
        },
      ]
    : [];
}

/**
 * The styles active just before `index` in `raw`, on its own row: the SGR sequences from the start of the row (the last line feed before
 * `index`) up to `index`, read as the terminal reads them. `bold` and `dim` end together at 22, as they do on a terminal.
 */
export function stylesBefore(raw: string, index: number): ReadonlySet<string> {
  const rowStart = raw.lastIndexOf('\n', index - 1) + 1;
  const active = new Set<string>();
  for (const match of raw.slice(rowStart, index).matchAll(SGR)) {
    for (const code of (match[1] ?? '').split(/[;:]/u)) {
      switch (code === '' ? '0' : code) {
        case '0':
          active.clear();
          break;
        case '1':
          active.add('bold');
          break;
        case '2':
          active.add('dim');
          break;
        case '4':
          active.add('underline');
          break;
        case '7':
          active.add('inverse');
          break;
        case '22':
          active.delete('bold');
          active.delete('dim');
          break;
        case '24':
          active.delete('underline');
          break;
        case '27':
          active.delete('inverse');
          break;
        default:
      }
    }
  }
  return active;
}

/** The selection marker of ADR-0145 §5, written out here and not read from the glyph table: the table is what is being checked. */
export const SELECTION_MARKER = { unicode: '›', plain: '>' } as const;

/**
 * The marker of the row that holds `text`, as the frame shows it: the LAST row of the frame with those words must carry `›` when colour is
 * on and `>` when it is off (and never the other form with colour off), so a view that asks the glyph table for the wrong form, or draws no
 * marker, is named even though the row is bold and inverse in both.
 */
function checkSelectionMarker(observation: Observation, text: string): Violation[] {
  const color = observation.variant.color;
  const row = [...observation.lines].reverse().find((line) => line.includes(text));
  if (row === undefined) {
    return [
      {
        property: 'selected-row',
        message: `the selected row "${text}" is not on any row of the frame, so its marker cannot be read`,
      },
    ];
  }
  const want = color ? SELECTION_MARKER.unicode : SELECTION_MARKER.plain;
  const problems: string[] = [];
  if (!row.includes(want))
    problems.push(`has no \`${want}\` marker (colour ${color ? 'on' : 'off'})`);
  if (!color && row.includes(SELECTION_MARKER.unicode))
    problems.push(`draws the Unicode marker \`${SELECTION_MARKER.unicode}\` with colour off`);
  return problems.map((problem) => ({
    property: 'selected-row',
    message: `the selected row "${text}" ${problem}: "${preview(row)}"`,
  }));
}

/**
 * (6) For a surface that names its selected row: the last time `text` was written to the terminal it was drawn inverse and bold, in every
 * cell, colour off included ("no colour" means colour only: ADR-0145 §5, MVP-11 OD-6), and its row carries the selection marker in the
 * form of the cell (`›` with colour on, `>` with colour off). `text` is words that only the selected row has (a command's name, a model's),
 * not its marker.
 */
export function checkSelectedRow(observation: Observation, text: string): Violation[] {
  const at = observation.raw.lastIndexOf(text);
  if (at < 0) {
    return [
      {
        property: 'selected-row',
        message: `the selected row's words "${text}" were never written to the terminal`,
      },
    ];
  }
  const active = stylesBefore(observation.raw, at);
  const missing = ['inverse', 'bold'].filter((style) => !active.has(style));
  const style: Violation[] =
    missing.length === 0
      ? []
      : [
          {
            property: 'selected-row',
            message: `the selected row "${text}" is not ${missing.join(' and ')} (colour ${observation.variant.color ? 'on' : 'off'})`,
          },
        ];
  return [...style, ...checkSelectionMarker(observation, text)];
}

/** The text of `line` in the columns `[left, left + width)`, as the popup-box property reads a row (one cell per code point). */
const columnsOf = (line: string | undefined, left: number, width: number): string =>
  Array.from(line ?? '')
    .slice(left, left + width)
    .join('');

/**
 * (7) The surface's own legend row is on a row of the frame BY ITSELF, whole (`↑/↓ select · Enter run · Esc close`, and nothing else on
 * the row): a layout that squeezes a list into the legend's row, so that the two are drawn over each other, leaves an exit key and a
 * landmark on screen, and may leave the legend's words whole with another row's tail after them. Only a row that is exactly the legend
 * passes.
 *
 * **A popup in the alternate screen is drawn over the body, so the row is read in the popup's own box.** The popup covers part of the chat, and
 * on a short terminal that part includes the rows of the prompt block (the prompt, the thin rule): beside the open-sided popup the dimmed
 * backdrop legitimately shows their ends (ADR-0148 §4: the popup is centred over a body that stays drawn). Those cells are the body's and
 * `popup-box` and `backdrop-dim` hold them to it, so the legend is asked to be alone in the BOX's columns of one of the box's rows, which is
 * where a squeezed list, a cut or wrapped legend, or prompt text drawn over it, would show. A popup in the flow replaces the live region,
 * so it keeps the whole-row reading, and so does every surface that is not a popup (`box` absent).
 */
export function checkLegendRow(
  observation: Observation,
  row: string | readonly string[],
  box?: PopupBox,
): Violation[] {
  // A surface whose legend depends on whether its content overflows the page (a report that scrolls inline and fits in the alternate screen)
  // names every form it may draw: one of them must be on a row by itself, whole.
  const accepted = typeof row === 'string' ? [row] : row;
  const forms = accepted.map((form) => `"${form}"`).join(' or ');
  if (box?.placement === 'overlay') {
    const inBox = observation.lines
      .slice(box.top, box.top + box.height)
      .map((line) => columnsOf(line, box.left, box.width));
    return inBox.some((cells) => accepted.includes(cells.trim()))
      ? []
      : [
          {
            property: 'legend-row',
            message: `the legend row ${forms} is not on a row of the popup's box by itself, whole (columns ${String(box.left + 1)}–${String(box.left + box.width)}, rows ${String(box.top + 1)}–${String(box.top + box.height)})`,
          },
        ];
  }
  return observation.lines.some((line) => accepted.includes(line.trim()))
    ? []
    : [
        {
          property: 'legend-row',
          message: `the legend row ${forms} is not on a row of the frame by itself, whole`,
        },
      ];
}

/**
 * Every element of the tree under `root` that is positioned absolutely, but the renderer's own `<Static>` region (Ink lays out the lines it
 * prints to the scrollback in an absolutely positioned box of its own, marked `internal_static`, outside the live frame).
 */
export function absoluteNodes(root: DOMElement): DOMElement[] {
  const found: DOMElement[] = [];
  const visit = (node: DOMElement): void => {
    if (node.internal_static === true) return;
    if (node.style.position === 'absolute') found.push(node);
    for (const child of node.childNodes) if (child.nodeName !== '#text') visit(child);
  };
  visit(root);
  return found;
}

/** Whether `node` is the last child of its parent, and its parent of its own, all the way up to the root. */
function lastAllTheWayUp(node: DOMElement, root: DOMElement): boolean {
  for (let current = node; current !== root; ) {
    const parent = current.parentNode;
    if (parent === undefined) return false;
    if (parent.childNodes.at(-1) !== current) return false;
    current = parent;
  }
  return true;
}

/**
 * (8) The overlay layer (ADR-0148 §2): with no popup open the tree positions nothing absolutely; with one open it positions exactly one node,
 * and that node is the last child of everything above it, so no later sibling can be drawn over the popup. `root` absent (a mount without the
 * probe) ⇒ not asserted.
 */
export function checkOverlayLayer(root: DOMElement | undefined, popup: boolean): Violation[] {
  if (root === undefined) return [];
  const absolute = absoluteNodes(root);
  const expected = popup ? 1 : 0;
  if (absolute.length !== expected)
    return [
      {
        property: 'overlay-layer',
        message: `${String(absolute.length)} absolutely positioned node(s) in the tree, expected ${String(expected)}`,
      },
    ];
  const slot = absolute[0];
  if (slot !== undefined && !lastAllTheWayUp(slot, root))
    return [
      {
        property: 'overlay-layer',
        message:
          'the absolutely positioned node is not the last child of the root: a later sibling can be drawn over it',
      },
    ];
  return [];
}

/** Where a popup is drawn and what its rows are, from the one geometry function and the frame model. */
export interface PopupBox {
  readonly placement: 'overlay' | 'replace';
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
}

/**
 * (9) The popup's box (ADR-0148 §2, §4): in the overlay, the drawn frame holds exactly the popup's own rows in its box (the occlusion check the
 * bounds check cannot make) and every cell outside the box is the cell of the frame it was opened over; in the flow, the live region (the
 * screen's rows but the ones Ink printed through `<Static>`) is the popup's rows and nothing else. Rows are compared with their trailing spaces
 * trimmed, as the renderer writes them.
 */
export function checkPopupBox(
  observation: Observation,
  before: readonly string[],
  box: PopupBox,
): Violation[] {
  const problems =
    box.placement === 'replace'
      ? replaceBoxProblems(observation, box)
      : overlayBoxProblems(observation, before, box);
  return problems.map((message) => ({ property: 'popup-box', message }));
}

/** A popup in the flow: the live region is the popup's rows. What Ink printed once through `<Static>` above it is history, not part of it. */
function replaceBoxProblems(observation: Observation, box: PopupBox): string[] {
  const drawn = liveLines(observation).map((line) => line.trimEnd());
  const want = box.rows.map((row) => row.trimEnd());
  return drawn.join('\n') === want.join('\n')
    ? []
    : ['the live region is not exactly the popup’s rows'];
}

/** The first column in which `was` and `now` differ, leaving out the box's own columns when the row is one of the box's rows. */
function firstChangedColumn(
  was: readonly string[],
  now: readonly string[],
  box: PopupBox,
  inside: boolean,
): number | undefined {
  for (let column = 0; column < Math.max(was.length, now.length); column += 1) {
    if (inside && column >= box.left && column < box.left + box.width) continue;
    if ((was[column] ?? ' ') !== (now[column] ?? ' ')) return column;
  }
  return undefined;
}

/** A popup in the overlay: its own rows in its box, and every cell outside the box the cell the frame had before the popup opened. */
function overlayBoxProblems(
  observation: Observation,
  before: readonly string[],
  box: PopupBox,
): string[] {
  const problems: string[] = [];
  const lines = observation.lines;
  const cells = (row: string | undefined): string[] => Array.from(row ?? '');
  box.rows.forEach((row, index) => {
    const drawn = cells(lines[box.top + index])
      .slice(box.left, box.left + box.width)
      .join('')
      .trimEnd();
    if (drawn !== row.trimEnd())
      problems.push(`row ${String(index + 1)} of the popup is not its own: "${preview(drawn)}"`);
  });
  const height = Math.max(before.length, lines.length);
  for (let row = 0; row < height; row += 1) {
    const inside = row >= box.top && row < box.top + box.height;
    const column = firstChangedColumn(cells(before[row]), cells(lines[row]), box, inside);
    if (column !== undefined)
      problems.push(`the cell ${String(row + 1)}:${String(column + 1)} outside the popup changed`);
  }
  return problems;
}

/** What `checkBackdropDim` reads: the screen's cells before the popup opened and with it open, and the popup's box. */
export interface BackdropObservation {
  readonly variant: Variant;
  readonly before: readonly (readonly ScreenCell[])[];
  readonly now: readonly (readonly ScreenCell[])[];
  readonly box: PopupBox;
  /**
   * The surface says its body holds no inverse cell by design (`SurfaceBase.backdropHasNoInverse`): the one demand it drops is that the body held an
   * inverse cell before the popup opened. Absent or `false`: the whole demand.
   */
  readonly bodyHasNoInverse?: boolean | undefined;
}

/** A cell that shows something: a character, or an inverse or background block (a cursor, a selected row's blank tail). A plain space shows nothing. */
const showsSomething = (cell: ScreenCell): boolean =>
  cell.char !== ' ' || cell.style.inverse || cell.style.bg !== undefined;

const insideBox = (box: PopupBox, row: number, column: number): boolean =>
  row >= box.top &&
  row < box.top + box.height &&
  column >= box.left &&
  column < box.left + box.width;

const at = (
  rows: readonly (readonly ScreenCell[])[],
  row: number,
  column: number,
): ScreenCell | undefined => rows[row]?.[column];

/** The cells outside `box` of `rows` that `want` is true of, as `row:column` and the character, at most `limit` of them and their count. */
function cellsOutside(
  rows: readonly (readonly ScreenCell[])[],
  box: PopupBox,
  want: (cell: ScreenCell, row: number, column: number) => boolean,
): { count: number; first: string[] } {
  let count = 0;
  const first: string[] = [];
  rows.forEach((cells, row) => {
    cells.forEach((cell, column) => {
      if (insideBox(box, row, column) || !want(cell, row, column)) return;
      count += 1;
      if (first.length < 3) first.push(`${String(row + 1)}:${String(column + 1)} "${cell.char}"`);
    });
  });
  return { count, first };
}

/**
 * (10) The backdrop (ADR-0148 §4). In the alternate screen with colour on, every cell outside the popup's box that shows something is dim,
 * on a body that is not vacuous: before the popup opened the same screen held a bold cell, an inverse cell and a coloured one (so the check
 * cannot pass on a plain body; a surface that says its body has no inverse cell by design drops that one demand, and no other), and a dim cell
 * that the popup's own rows hold is a popup that was drawn inside the dimmed subtree. With colour off no cell outside the box is dimmer than it
 * was (chalk prints no dim, and the backdrop is simply not dimmed); inline there is no backdrop and nothing is checked. A row the box crosses must be read soundly (`cellsAreSound`): a column of the emulator is a column of the terminal.
 */
export function checkBackdropDim(observation: BackdropObservation): Violation[] {
  const { variant, before, now, box, bodyHasNoInverse } = observation;
  if (variant.renderer !== 'alt' || box.placement !== 'overlay') return [];
  const problems: string[] = [];
  if (!variant.color) {
    const dimmer = cellsOutside(
      now,
      box,
      (cell, row, column) => cell.style.dim && at(before, row, column)?.style.dim !== true,
    );
    if (dimmer.count > 0)
      problems.push(
        `${String(dimmer.count)} cell(s) outside the popup were dimmed with colour off, first ${dimmer.first.join(', ')}`,
      );
    return problems.map((message) => ({ property: 'backdrop-dim', message }));
  }
  const holds = (want: (cell: ScreenCell) => boolean): boolean =>
    before.some((row) => row.some((cell) => cell.char !== ' ' && want(cell)) || false);
  if (!holds((cell) => cell.style.bold))
    problems.push(
      'the body behind the popup held no bold cell before it opened: the check would pass on a plain body',
    );
  if (bodyHasNoInverse !== true && !before.some((row) => row.some((cell) => cell.style.inverse)))
    problems.push(
      'the body behind the popup held no inverse cell before it opened: the check would pass on a plain body',
    );
  if (!holds((cell) => cell.style.fg !== undefined || cell.style.bg !== undefined))
    problems.push(
      'the body behind the popup held no coloured cell before it opened: the check would pass on a plain body',
    );
  const crossed = now.slice(box.top, box.top + box.height);
  if (!cellsAreSound(crossed))
    problems.push(
      'a row the popup crosses holds a character that is not one column wide, so its columns cannot be read: the fixture must not draw one there',
    );
  const bright = cellsOutside(now, box, (cell) => showsSomething(cell) && !cell.style.dim);
  if (bright.count > 0)
    problems.push(
      `${String(bright.count)} cell(s) of the body outside the popup are not dim, first ${bright.first.join(', ')}`,
    );
  const own = now
    .slice(box.top, box.top + box.height)
    .flatMap((row) => row.slice(box.left, box.left + box.width))
    .filter((cell) => cell.style.inverse && cell.style.dim);
  if (own.length > 0)
    problems.push(
      `${String(own.length)} inverse cell(s) of the popup itself are dim: the popup was drawn inside the dimmed subtree`,
    );
  return problems.map((message) => ({ property: 'backdrop-dim', message }));
}

/** (5) With colour off the raw bytes carry no colour SGR (bold, dim, inverse and underline are allowed). */
export function checkNoColour(observation: Observation): Violation[] {
  if (observation.variant.color) return [];
  const found = colourSequences(observation.raw);
  return found.length === 0
    ? []
    : [
        {
          property: 'no-colour',
          message: `${String(found.length)} colour sequence(s) with colour off, first ${found[0] ?? ''}`,
        },
      ];
}

export interface PropertyExpectations {
  /** The words of the key that leaves the surface; absent ⇒ the exit key is not asserted (a below-floor notice has none). */
  readonly exitKey?: string | undefined;
  /** The surface's own legend row, exactly as written; absent ⇒ not asserted (a surface with no one row of its own, or below the floor). */
  readonly legendRow?: string | readonly string[] | undefined;
  /**
   * Words only the surface's selected row has, or several such words (a list's selected row AND the selected tab above it); absent ⇒ the
   * selected row is not asserted (a surface with no selection, or below the floor).
   */
  readonly selectedRow?: string | readonly string[] | undefined;
  /** The popup's box, when the surface is a popup: the legend row is then read in the box ({@link checkLegendRow}). */
  readonly popupBox?: PopupBox | undefined;
}

const selectedWords = (selected: string | readonly string[] | undefined): readonly string[] =>
  selected === undefined ? [] : typeof selected === 'string' ? [selected] : selected;

/** The five properties, and the sixth for a surface that names its selected row, over one observation. */
export function checkProperties(
  observation: Observation,
  expectations: PropertyExpectations,
): Violation[] {
  return [
    ...checkHeight(observation),
    ...checkWidth(observation),
    ...(expectations.exitKey === undefined ? [] : checkExitKey(observation, expectations.exitKey)),
    ...checkNoScrollbackClear(observation),
    ...checkNoColour(observation),
    ...selectedWords(expectations.selectedRow).flatMap((text) =>
      checkSelectedRow(observation, text),
    ),
    ...(expectations.legendRow === undefined
      ? []
      : checkLegendRow(observation, expectations.legendRow, expectations.popupBox)),
  ];
}
