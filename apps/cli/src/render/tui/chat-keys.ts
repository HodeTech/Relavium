/**
 * The keys of a chat, as the chat handles them ([MVP-11 §4.4](../../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups),
 * [ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10): what `/help` lists beside the
 * commands in a chat, in the pattern of `HOME_KEYS` (`help-sheet.ts`). Each key has the verb that says what it does and the presses that do it,
 * so `chat-keys.test.ts` presses every one on a mounted chat and checks that it does what its verb says: a help that names a key cannot name one
 * the chat does not have, or say it does something else.
 *
 * Only the keys a person has at an idle chat prompt or during a turn are listed (`reduceChatKey`, the interrupt keymap and the overlays' openers
 * in `chat-ink.tsx`); the answers of an approval, a question or a checkpoint are on their cards' own legends. The verbs name no key (a key named
 * in a sentence is a bracketed token of the legend builder's grammar), so none of them is a hint the legend golden has to carry.
 *
 * A data module (ADR-0145 §10): it imports nothing from `ink`, `react` or `node:` and reads no global, so the fence that holds the registry
 * and the glyph table holds it.
 */

import type { HelpKey, HelpKeyEvent, HelpKeyPress } from './help-sheet.js';

/**
 * The press of a key of the chat: the landing's own flags and the ones the chat's editor reads besides (`↑` for the history, the horizontal arrows,
 * `Home`/`End` and the meta flag of `Alt+B`/`Alt+F` for the cursor), which the Home's `↓` row does not share.
 */
export interface ChatKeyPress extends HelpKeyPress {
  readonly key: HelpKeyEvent & {
    readonly upArrow?: boolean;
    readonly leftArrow?: boolean;
    readonly rightArrow?: boolean;
    readonly home?: boolean;
    readonly end?: boolean;
    readonly meta?: boolean;
  };
}

/** A key of the chat: how it is written, what it does, and the presses that do it. */
export interface ChatKeyDefinition extends Omit<HelpKey, 'presses'> {
  readonly presses: readonly ChatKeyPress[];
}

/**
 * The bytes of the mouse reports (SGR 1006) the full-screen chat reads: a wheel notch up or down, and a drag along the whole of the second row
 * of the screen (the press at its first column, the motion past its last, the release).
 */
const MOUSE_REPORTS = {
  wheelUp: '\u001b[<64;10;5M',
  wheelDown: '\u001b[<65;10;5M',
  press: '\u001b[<0;1;2M',
  drag: '\u001b[<32;99;2M',
  release: '\u001b[<0;99;2m',
} as const;

export const CHAT_KEYS = {
  send: {
    keys: 'Enter',
    verb: 'send what you typed, or run the command',
    presses: [{ input: '', key: { return: true } }],
  },
  newline: {
    keys: 'Ctrl+J',
    verb: 'add a line to what you are typing',
    presses: [{ input: 'j', key: { ctrl: true } }],
  },
  history: {
    keys: '↑/↓',
    verb: 'recall what you sent before, from the first or the last line of the prompt',
    presses: [
      { input: '', key: { upArrow: true } },
      { input: '', key: { downArrow: true } },
    ],
  },
  lineEdges: {
    keys: 'Ctrl+A/Ctrl+E',
    verb: 'move to the start or the end of the line',
    presses: [
      { input: 'a', key: { ctrl: true } },
      { input: 'e', key: { ctrl: true } },
    ],
  },
  lineEdgeKeys: {
    keys: 'Home/End',
    verb: 'move to the start or the end of the line',
    presses: [
      { input: '', key: { home: true } },
      { input: '', key: { end: true } },
    ],
  },
  wordMotion: {
    keys: 'Ctrl+←/Ctrl+→',
    verb: 'move back or forward by one word',
    presses: [
      { input: '', key: { ctrl: true, leftArrow: true } },
      { input: '', key: { ctrl: true, rightArrow: true } },
    ],
  },
  wordMotionAlt: {
    keys: 'Alt+B/Alt+F',
    verb: 'move back or forward by one word',
    presses: [
      { input: 'b', key: { meta: true } },
      { input: 'f', key: { meta: true } },
    ],
  },
  deleteWord: {
    keys: 'Ctrl+W',
    verb: 'delete the word before the cursor',
    presses: [{ input: 'w', key: { ctrl: true } }],
  },
  deleteToStart: {
    keys: 'Ctrl+U',
    verb: 'delete from the cursor back to the start of the line',
    presses: [{ input: 'u', key: { ctrl: true } }],
  },
  deleteToEnd: {
    keys: 'Ctrl+K',
    verb: 'delete from the cursor to the end of the line',
    presses: [{ input: 'k', key: { ctrl: true } }],
  },
  commands: {
    keys: '/',
    verb: 'the commands, from an empty prompt',
    presses: [{ input: '/', key: {} }],
  },
  files: {
    keys: '@',
    verb: 'attach a file by name, from the start of a word',
    presses: [{ input: '@', key: {} }],
  },
  search: {
    keys: 'Ctrl+R',
    verb: 'search the messages you sent before',
    presses: [{ input: 'r', key: { ctrl: true } }],
  },
  mode: {
    keys: 'Shift+Tab',
    verb: 'change the mode, between turns',
    presses: [{ input: '', key: { tab: true, shift: true } }],
  },
  thinking: {
    keys: 'Ctrl+T',
    verb: 'show or hide the reasoning of the model',
    presses: [{ input: 't', key: { ctrl: true } }],
  },
  stop: {
    keys: 'Esc',
    verb: 'stop the running turn and keep the chat',
    presses: [{ input: '', key: { escape: true } }],
  },
  scroll: {
    keys: 'PgUp/PgDn',
    verb: 'scroll the conversation (the full-screen view)',
    presses: [
      { input: '', key: { pageUp: true } },
      { input: '', key: { pageDown: true } },
    ],
  },
  wheel: {
    keys: 'Mouse wheel',
    verb: 'scroll the conversation (the full-screen view)',
    presses: [
      { input: MOUSE_REPORTS.wheelUp, key: {} },
      { input: MOUSE_REPORTS.wheelDown, key: {} },
    ],
  },
  select: {
    keys: 'Mouse drag',
    verb: 'select text and copy it (the full-screen view)',
    presses: [
      { input: MOUSE_REPORTS.press, key: {} },
      { input: MOUSE_REPORTS.drag, key: {} },
      { input: MOUSE_REPORTS.release, key: {} },
    ],
  },
  suspend: {
    keys: 'Ctrl+Z',
    verb: 'send the chat to the background of the shell, where the system has job control',
    presses: [{ input: 'z', key: { ctrl: true } }],
  },
  interrupt: {
    keys: 'Ctrl+C',
    verb: 'clear what you typed; on an empty prompt, press twice to end the chat',
    presses: [{ input: 'c', key: { ctrl: true } }],
  },
} as const satisfies Readonly<Record<string, ChatKeyDefinition>>;
