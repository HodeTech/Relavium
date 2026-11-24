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
  /** Not one of the five: the surface's own landmark (or, below the floor, its notice) is on screen, so a frame that never opened cannot pass. */
  | 'surface-shown';

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
}

/** All five properties over one observation. */
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
  ];
}
