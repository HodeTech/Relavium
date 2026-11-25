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

import type { HelpKey } from './help-sheet.js';

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
  interrupt: {
    keys: 'Ctrl+C',
    verb: 'clear what you typed; on an empty prompt, press twice to end the chat',
    presses: [{ input: 'c', key: { ctrl: true } }],
  },
} as const satisfies Readonly<Record<string, HelpKey>>;
