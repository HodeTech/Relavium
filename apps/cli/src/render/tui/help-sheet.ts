/**
 * The landing's `/help` sheet ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): the commands the Home answers to and the keys of the landing, drawn on the shared sheet frame. Framework-free and
 * pure, like the other sheets' models: {@link helpSheetLines} turns a size into lines, and `HelpScreen` of the Home controller holds
 * nothing else, because the sheet has nothing to remember.
 *
 * - **The commands** are the registry's own entries, never a copy of their text: every command of the bare Home's palette
 *   ({@link HOME_PALETTE_COMMANDS}: the table's placements on the Home, `/help` among them), in the Home's grouped order. A chat-only command (`/cost`, `/export`, ...) is not listed here: typing one at the landing answers with where it works.
 * - **The keys** are {@link HOME_KEYS}, the landing's keys, each with the key press that does it, so the test presses every one of them and
 *   checks that it does what its verb says. {@link HELP_SHEET_KEYS} are the sheet's own: `Esc` and `Ctrl+C` close it and every other key
 *   does nothing, a key of the landing included, because the sheet is a screen of the slot and owns every key while it is open.
 * - **At most {@link HELP_SHEET_ROWS} rows** at any terminal size, one row to a key, every line cut to the width. A command has a row of
 *   its own, with its description, while they all fit; when one more command would not, the last ones are listed by name alone, several to a
 *   row, so adding a command never takes another one off the sheet ({@link fitCommands}). Only when even the names do not fit does the sheet
 *   count what it leaves out. Below 80x24 it is two lines: the hint that says to enlarge, and the way out.
 */

import { HOME_PALETTE_COMMANDS, type ReplCommand } from '../../commands/repl-commands.js';
import { exitKey, legend, legendSpans, type LegendItem, type LegendKey } from './legend.js';
import { displayWidth } from './viewport.js';
import { sheetCanArm } from './permissions-sheet.js';
import {
  clampSpans,
  clipLine,
  usableColumns,
  type SheetGeometry,
  type SheetLine,
  type SheetSpan,
} from './sheet-frame.js';

/** The subset of ink's `Key` that a key of the sheet or of the landing needs, so a test presses it without ink. */
export interface HelpKeyEvent {
  readonly ctrl?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly downArrow?: boolean;
  readonly tab?: boolean;
  readonly shift?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
}

/** One key press as the controller receives it: the typed character (empty for a named key) and the key flags. */
export interface HelpKeyPress {
  readonly input: string;
  readonly key: HelpKeyEvent;
}

/** A key the sheet names: how it is written, what it does, and the presses that do it. */
export interface HelpKey extends LegendKey {
  readonly presses: readonly HelpKeyPress[];
}

/** The rows the sheet may use: what the Home's frame allows at 80x24, less the prompt's line (the tab host's own bound). */
export const HELP_SHEET_ROWS = 23;

/**
 * The keys of the sheet itself. Both close it and nothing else is bound, so the legend names exactly these, as the one key that leaves
 * (`Esc / [Ctrl+C] close`: ADR-0145 §2, Close, with two keys); the test presses each press and checks that the sheet is gone, and presses
 * every key of {@link HOME_KEYS} and checks that the sheet stays.
 */
export const HELP_SHEET_KEYS = {
  close: {
    ...exitKey.close(['Esc', 'Ctrl+C']),
    presses: [
      { input: '', key: { escape: true } },
      { input: 'c', key: { ctrl: true } },
    ],
  },
} as const satisfies Readonly<Record<string, HelpKey>>;

/**
 * The keys of the landing, as the landing handles them (`handleHomeKey` of the Home controller, and its interrupt keymap). The sheet draws
 * its Keys section from these, and the test presses each press on a landing and checks the verb. Only the keys that mean something at the
 * landing are listed: a letter typed is the message, and the editor's motions are the prompt's.
 */
export const HOME_KEYS = {
  send: {
    keys: 'Enter',
    verb: 'start a chat with what you typed, or open the row or the running run',
    presses: [{ input: '', key: { return: true } }],
  },
  newline: {
    keys: 'Ctrl+J',
    verb: 'add a line to what you are typing',
    presses: [{ input: 'j', key: { ctrl: true } }],
  },
  commands: {
    keys: '/',
    verb: 'the commands, from an empty prompt',
    presses: [{ input: '/', key: {} }],
  },
  rows: {
    keys: '↓',
    verb: 'move onto a row of the strip, from an empty prompt',
    presses: [{ input: '', key: { downArrow: true } }],
  },
  back: {
    keys: 'Esc',
    verb: 'back to the prompt from a row',
    presses: [{ input: '', key: { escape: true } }],
  },
  eof: {
    keys: 'Ctrl+D',
    verb: 'exit from an empty prompt; asks first while a run executes',
    presses: [{ input: 'd', key: { ctrl: true } }],
  },
  interrupt: {
    keys: 'Ctrl+C',
    verb: 'press twice to exit; asks first while a run executes',
    presses: [{ input: 'c', key: { ctrl: true } }],
  },
} as const satisfies Readonly<Record<string, HelpKey>>;

/** The hint below the floor: the sheet cannot be drawn. The way out is the legend under it, which names the keys and their effect. */
export const HELP_TOO_SMALL = 'Enlarge the terminal.';

/** The sheet's legend names no key but the one that leaves. */
const LEGEND_ITEMS: readonly LegendItem[] = [];

const INDENT = '  ';
const GAP = '  ';

function heading(text: string): SheetLine {
  return { kind: 'heading', text };
}

/** A row of a key (or a command) column and its words: the key emphasised, the rest in the row's own style, the whole cut to `width`. */
function labelled(label: string, labelWidth: number, words: string, width: number): SheetLine {
  const text = clipLine(`${INDENT}${label.padEnd(labelWidth)}${GAP}${words}`, width);
  const spans: readonly SheetSpan[] = [
    { from: INDENT.length, to: INDENT.length + label.length, role: 'strong' },
  ];
  return { kind: 'row', text, spans: clampSpans(spans, text.length) };
}

function legendLine(width: number): SheetLine {
  const text = clipLine(legend(LEGEND_ITEMS, HELP_SHEET_KEYS.close), width);
  return {
    kind: 'legend',
    text,
    spans: clampSpans(legendSpans(LEGEND_ITEMS, HELP_SHEET_KEYS.close), text.length),
  };
}

/** One row of command names with no description (several to a row), and how many names it holds. */
interface NameRow {
  readonly text: string;
  readonly count: number;
}

/** `commands` as rows of names alone, filled left to right up to `width` columns; a name wider than the row is cut. */
function nameRows(commands: readonly ReplCommand[], width: number): readonly NameRow[] {
  const rows: NameRow[] = [];
  let text = '';
  let count = 0;
  for (const command of commands) {
    const name = `/${command.name}`;
    const joined = count === 0 ? `${INDENT}${name}` : `${text}${GAP}${name}`;
    if (count > 0 && displayWidth(joined) > width) {
      rows.push({ text: clipLine(text, width), count });
      text = `${INDENT}${name}`;
      count = 1;
    } else {
      text = joined;
      count += 1;
    }
  }
  if (count > 0) rows.push({ text: clipLine(text, width), count });
  return rows;
}

/**
 * How `commands` share `room` rows: the first `described` get a row each, with their description, and the rest are rows of names. The most
 * commands keep their description that still lets every command be named; only when the names alone do not fit in `room` rows is the tail
 * of them cut, and `left` says how many were left out (the sheet then names that count).
 */
function fitCommands(
  commands: readonly ReplCommand[],
  room: number,
  width: number,
): { readonly described: number; readonly names: readonly NameRow[]; readonly left: number } {
  let described = Math.min(commands.length, Math.max(0, room));
  for (; described > 0; described -= 1) {
    const names = nameRows(commands.slice(described), width);
    if (described + names.length <= room) return { described, names, left: 0 };
  }
  const names = nameRows(commands, width);
  if (names.length <= room) return { described: 0, names, left: 0 };
  // The note takes a row of its own: the names that are shown fill the rows before it.
  const shown = names.slice(0, Math.max(0, room - 1));
  const kept = shown.reduce((sum, row) => sum + row.count, 0);
  return { described: 0, names: shown, left: commands.length - kept };
}

/**
 * The sheet's lines, top to bottom, for a terminal of this size: the commands, the keys and the legend. Never more than
 * {@link HELP_SHEET_ROWS} lines and never wider than the sheet frame's width. A list of commands too long for the rows left gives up
 * descriptions before it gives up a command ({@link fitCommands}), so the keys and the way out always stay on screen.
 */
export function helpSheetLines(
  geometry: SheetGeometry,
  commands: readonly ReplCommand[] = HOME_PALETTE_COMMANDS,
): readonly SheetLine[] {
  const width = usableColumns(geometry.columns);
  if (!sheetCanArm(geometry)) {
    return [{ kind: 'text', text: clipLine(HELP_TOO_SMALL, width) }, legendLine(width)];
  }
  const keys = Object.values(HOME_KEYS);
  const keyWidth = Math.max(...keys.map((key) => key.keys.length));
  const keyRows = keys.map((key) => labelled(key.keys, keyWidth, key.verb, width));
  // The headings, the keys and the legend always stay; the commands take the rows that are left.
  const room = HELP_SHEET_ROWS - keyRows.length - 3;
  const { described, names, left } = fitCommands(commands, room, width);
  const shown = commands.slice(0, described);
  const nameWidth = Math.max(0, ...shown.map((command) => command.name.length + 1));
  const commandRows = shown.map((command) =>
    labelled(`/${command.name}`, nameWidth, command.description, width),
  );
  const nameLines = names.map((row): SheetLine => ({ kind: 'row', text: row.text }));
  const more: readonly SheetLine[] =
    left === 0
      ? []
      : [{ kind: 'note', text: clipLine(`${INDENT}and ${String(left)} more`, width) }];
  return [
    heading('Commands'),
    ...commandRows,
    ...nameLines,
    ...more,
    heading('Keys of the Home'),
    ...keyRows,
    legendLine(width),
  ];
}
