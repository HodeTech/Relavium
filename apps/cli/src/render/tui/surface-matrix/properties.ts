import stringWidth from 'string-width';

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
  | 'legend-row';

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

/** (1) The frame has at most `rows - 1` lines: a frame as tall as the terminal makes Ink clear the whole terminal and scroll. */
export function checkHeight(observation: Observation): Violation[] {
  const budget = observation.variant.size.rows - 1;
  const count = observation.lines.length;
  return count <= budget
    ? []
    : [
        {
          property: 'height',
          message: `${String(count)} lines on a ${String(observation.variant.size.rows)}-row terminal (at most ${String(budget)})`,
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

/**
 * (7) The surface's own legend row is on a row of the frame BY ITSELF, whole (`↑/↓ select · Enter run · Esc close`, and nothing else on
 * the row): a layout that squeezes a list into the legend's row, so that the two are drawn over each other, leaves an exit key and a
 * landmark on screen, and may leave the legend's words whole with another row's tail after them. Only a row that is exactly the legend
 * passes.
 */
export function checkLegendRow(observation: Observation, row: string): Violation[] {
  return observation.lines.some((line) => line.trim() === row)
    ? []
    : [
        {
          property: 'legend-row',
          message: `the legend row "${row}" is not on a row of the frame by itself, whole`,
        },
      ];
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
  readonly legendRow?: string | undefined;
  /**
   * Words only the surface's selected row has, or several such words (a list's selected row AND the selected tab above it); absent ⇒ the
   * selected row is not asserted (a surface with no selection, or below the floor).
   */
  readonly selectedRow?: string | readonly string[] | undefined;
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
      : checkLegendRow(observation, expectations.legendRow)),
  ];
}
