/**
 * The keys of the Home's landing, as a table ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5; MVP-11 unit 8): the one list the Home's `/help` popup draws its Keys section from (`popups/home-help-popup.ts`, through the
 * controller's port) and a test presses through a mounted Home to check that each key does what its verb says. The sheet this file used to draw (the
 * Home's `/help` screen, which cut rows at 80 columns) is the popup now; the table stayed, with the few words the popup has the room for.
 * Framework-free and pure.
 *
 * - **The keys** are {@link HOME_KEYS}, the landing's keys, each with the key press that does it, so the test presses every one of them and checks
 *   that it does what its verb says. Only the keys that mean something at the landing are listed: a letter typed is the message, and the editor's
 *   motions are the prompt's.
 * - The chat's own table, in the same pattern, is `chat-keys.ts` (`CHAT_KEYS`).
 */

import type { LegendKey } from './legend.js';

/** The subset of ink's `Key` that a key of the landing or of a chat needs, so a test presses it without ink. */
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

/** A key a help page names: how it is written, what it does, and the presses that do it. */
export interface HelpKey extends LegendKey {
  readonly presses: readonly HelpKeyPress[];
  /**
   * The same verb in the few words the Home's `/help` popup has the room for (it lists every key on one page with no scroll, MVP-11 unit 8, D6):
   * a PRODUCT constant, as `verb` is. Absent ⇒ the popup writes `verb`.
   */
  readonly short?: string;
}

/**
 * The keys of the landing, as the landing handles them (`handleHomeKey` of the Home controller, and its interrupt keymap). The `/help` popup
 * draws its Keys section from these (their `short` words), and the test presses each press on a landing and checks the verb. Only the keys that
 * mean something at the landing are listed: a letter typed is the message, and the editor's motions are the prompt's.
 */
export const HOME_KEYS = {
  send: {
    keys: 'Enter',
    verb: 'start a chat with what you typed, or open the row or the running run',
    short: 'start a chat with what you typed, or open the row',
    presses: [{ input: '', key: { return: true } }],
  },
  newline: {
    keys: 'Ctrl+J',
    verb: 'add a line to what you are typing',
    short: 'add a line to what you are typing',
    presses: [{ input: 'j', key: { ctrl: true } }],
  },
  commands: {
    keys: '/',
    verb: 'the commands, from an empty prompt',
    short: 'the commands, from an empty prompt',
    presses: [{ input: '/', key: {} }],
  },
  rows: {
    keys: '↓',
    verb: 'down to the work page and its first row',
    short: 'down to the work page',
    presses: [{ input: '', key: { downArrow: true } }],
  },
  back: {
    keys: 'Esc',
    verb: 'back up to the start page from the work page',
    short: 'back up to the start page',
    presses: [{ input: '', key: { escape: true } }],
  },
  eof: {
    keys: 'Ctrl+D',
    verb: 'exit from an empty prompt; asks first while a run executes',
    short: 'exit from an empty prompt (asks while a run executes)',
    presses: [{ input: 'd', key: { ctrl: true } }],
  },
  interrupt: {
    keys: 'Ctrl+C',
    verb: 'press twice to exit; asks first while a run executes',
    short: 'twice to exit (asks while a run executes)',
    presses: [{ input: 'c', key: { ctrl: true } }],
  },
} as const satisfies Readonly<Record<string, HelpKey>>;
