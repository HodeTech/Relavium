/**
 * The landing's `/help` sheet ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): the commands the Home answers to and the keys of the landing, drawn on the shared sheet frame. Framework-free and
 * pure, like the other sheets' models: {@link helpSheetLines} turns a size into lines, and `HelpScreen` of the Home controller holds
 * nothing else, because the sheet has nothing to remember.
 *
 * - **The commands** are the registry's own entries, never a copy of their text: `/help` itself, then every command of the bare Home's
 *   palette ({@link HOME_PALETTE_COMMANDS}: the registry entries whose `availableIn` names the Home, and the Home's own commands), by
 *   name. A chat-only command (`/cost`, `/export`, ...) is not listed here: typing one at the landing answers with where it works.
 * - **The keys** are {@link HOME_KEYS}, the landing's keys, each with the key press that does it, so the test presses every one of them and
 *   checks that it does what its verb says. {@link HELP_SHEET_KEYS} are the sheet's own: `Esc` and `Ctrl+C` close it and every other key
 *   does nothing, a key of the landing included, because the sheet is a screen of the slot and owns every key while it is open.
 * - **At most {@link HELP_SHEET_ROWS} rows** at any terminal size, one row to a command and to a key, every line cut to the width. Below
 *   80x24 it is two lines: the hint that says to enlarge, and the way out.
 */

import {
  HOME_PALETTE_COMMANDS,
  REPL_COMMANDS,
  type ReplCommand,
} from '../../commands/repl-commands.js';
import { legend, legendSpans, type LegendItem } from './legend.js';
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
}

/** One key press as the controller receives it: the typed character (empty for a named key) and the key flags. */
export interface HelpKeyPress {
  readonly input: string;
  readonly key: HelpKeyEvent;
}

/** A key the sheet names: how it is written, what it does, and the presses that do it. */
export interface HelpKey extends LegendItem {
  readonly presses: readonly HelpKeyPress[];
}

/** The rows the sheet may use: what the Home's frame allows at 80x24, less the prompt's line (the tab host's own bound). */
export const HELP_SHEET_ROWS = 23;

/**
 * The keys of the sheet itself. Both close it and nothing else is bound, so the legend names exactly these; the test presses each press
 * and checks that the sheet is gone, and presses every key of {@link HOME_KEYS} and checks that the sheet stays.
 */
export const HELP_SHEET_KEYS = {
  close: {
    keys: 'Esc / Ctrl+C',
    verb: 'close',
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
    verb: 'start a chat with what you typed, or open the row you moved onto',
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
    verb: 'move onto a parked run or a saved session, from an empty prompt',
    presses: [{ input: '', key: { downArrow: true } }],
  },
  back: {
    keys: 'Esc',
    verb: 'back to the prompt from a row',
    presses: [{ input: '', key: { escape: true } }],
  },
  eof: {
    keys: 'Ctrl+D',
    verb: 'exit, from an empty prompt',
    presses: [{ input: 'd', key: { ctrl: true } }],
  },
  interrupt: {
    keys: 'Ctrl+C',
    verb: 'press twice to exit',
    presses: [{ input: 'c', key: { ctrl: true } }],
  },
} as const satisfies Readonly<Record<string, HelpKey>>;

/** The hint below the floor: the sheet cannot be drawn, and says how to get rid of it. */
export const HELP_TOO_SMALL = 'Enlarge the terminal — Esc closes.';

const LEGEND_ITEMS: readonly LegendItem[] = [HELP_SHEET_KEYS.close];

/**
 * What the sheet lists: `/help` first among the registry's words (it is a word of the landing, though the registry marks it as a chat's),
 * then the bare Home's palette commands, all by name.
 */
export const HOME_HELP_COMMANDS: readonly ReplCommand[] = Object.freeze(
  [...REPL_COMMANDS.filter((command) => command.name === 'help'), ...HOME_PALETTE_COMMANDS].sort(
    (a, b) => a.name.localeCompare(b.name, 'en'),
  ),
);

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
  const text = clipLine(legend(LEGEND_ITEMS), width);
  return { kind: 'legend', text, spans: clampSpans(legendSpans(LEGEND_ITEMS), text.length) };
}

/**
 * The sheet's lines, top to bottom, for a terminal of this size: the commands, the keys and the legend. Never more than
 * {@link HELP_SHEET_ROWS} lines and never wider than the sheet frame's width. A list of commands too long for the rows left is cut and
 * says how many it left out, so the keys and the way out always stay on screen.
 */
export function helpSheetLines(
  geometry: SheetGeometry,
  commands: readonly ReplCommand[] = HOME_HELP_COMMANDS,
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
  const shown = commands.length > room ? commands.slice(0, Math.max(0, room - 1)) : commands;
  const nameWidth = Math.max(0, ...shown.map((command) => command.name.length + 1));
  const commandRows = shown.map((command) =>
    labelled(`/${command.name}`, nameWidth, command.description, width),
  );
  const left = commands.length - shown.length;
  const more: readonly SheetLine[] =
    left === 0
      ? []
      : [{ kind: 'note', text: clipLine(`${INDENT}and ${String(left)} more`, width) }];
  return [
    heading('Commands'),
    ...commandRows,
    ...more,
    heading('Keys of the Home'),
    ...keyRows,
    legendLine(width),
  ];
}
