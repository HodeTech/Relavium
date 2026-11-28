// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import './force-color.js';

/**
 * The keys `/help` lists for a chat ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10, MVP-11 step 4b): every one is PRESSED on a mounted chat and must do what its verb says, in the stand-alone chat and in the chat the Home
 * hosts, as the Home's `/help` popup is held to the landing (`home-landing-words.test.ts` presses each key of the landing). A help that names a key cannot name one the chat
 * does not have, or say it does something else, and a key added to the chat's own handler has to be listed here to be documented.
 */
import { describe, expect, it, vi } from 'vitest';

import { nextMode } from '../../chat/chat-mode.js';
import { CHAT_KEYS, type ChatKeyPress } from './chat-keys.js';
import { CHAT_HEADER_ROWS } from './chat-layout.js';
import { chatGrid } from './chat-grid.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';
import type { SessionViewSeed } from './session-view-model.js';
import type { ClipboardWriter } from '../clipboard.js';

type Id = keyof typeof CHAT_KEYS;
type Host = 'chat' | 'standalone-chat';

/** The bytes a terminal sends for a press the data module names (`Ctrl+J` is a line feed, `Shift+Tab` a back-tab, an arrow an escape sequence). */
function bytesOf({ input, key }: ChatKeyPress): string {
  // A modified arrow is a CSI sequence with the modifier (5 is Ctrl); a meta key is the letter after an escape; Home and End are their CSI finals.
  if (key.leftArrow === true) return key.ctrl === true ? '\u001b[1;5D' : '\u001b[D';
  if (key.rightArrow === true) return key.ctrl === true ? '\u001b[1;5C' : '\u001b[C';
  if (key.home === true) return '\u001b[H';
  if (key.end === true) return '\u001b[F';
  if (key.meta === true) return `\u001b${input}`;
  if (key.ctrl === true) return String.fromCharCode(input.toUpperCase().charCodeAt(0) - 64);
  if (key.return === true) return '\r';
  if (key.escape === true) return '\u001b';
  if (key.tab === true && key.shift === true) return '\u001b[Z';
  if (key.pageUp === true) return '\u001b[5~';
  if (key.pageDown === true) return '\u001b[6~';
  if (key.upArrow === true) return '\u001b[A';
  if (key.downArrow === true) return '\u001b[B';
  return input;
}

/** Left arrow, the way a terminal sends it: the editor's cursor motion the kill checks start from. */
const LEFT = '\u001b[D';

const pressAll = (m: ChatMount, id: Id, only?: number): void => {
  CHAT_KEYS[id].presses.forEach((press, index) => {
    if (only === undefined || index === only) m.key(bytesOf(press));
  });
};

const MENTION_READER = {
  list: () =>
    Promise.resolve([
      { name: 'src', type: 'directory' as const, path: 'src' },
      { name: 'README.md', type: 'file' as const, path: 'README.md' },
    ]),
  read: () => Promise.resolve({ content: 'x', sizeBytes: 1 }),
};

/** A conversation long enough to scroll in the full-screen view. */
const LONG: SessionViewSeed = {
  transcript: Array.from({ length: 40 }, (_, turn) => [
    { role: 'user' as const, text: `question ${String(turn)} about the thing` },
    { role: 'assistant' as const, text: `answer ${String(turn)}` },
  ]).flat(),
};

interface Mounted {
  readonly m: ChatMount;
  readonly onModeChange: ReturnType<typeof vi.fn>;
  readonly onAbort: ReturnType<typeof vi.fn>;
}

/** What a host is handed besides the session's ports: the job control request and the clipboard of the selection (both are RootApp's and ChatApp's own props). */
interface Wiring {
  readonly onSuspend?: () => void;
  readonly clipboard?: ClipboardWriter;
}

async function mount(
  host: Host,
  variant: Variant,
  seed?: SessionViewSeed,
  wiring: Wiring = {},
): Promise<Mounted> {
  const onModeChange = vi.fn();
  const onAbort = vi.fn();
  const ports = { mentionReader: MENTION_READER, onModeChange, onAbort };
  const m =
    host === 'chat'
      ? await mountHostedChat(variant, {
          ...(seed === undefined ? {} : { seed }),
          hosted: { session: ports, home: { props: wiring } },
        })
      : mountStandaloneChat(variant, {
          ...(seed === undefined ? {} : { seed }),
          standalone: { ...ports, ...wiring },
        });
  await m.settle();
  return { m, onModeChange, onAbort };
}

const ALT: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 30 } };

/**
 * A key that moves by a word: back from the end of `one two` to the start of `two` (where the `X` lands), and forward again past it (where the `Y`
 * lands), so each press moved by exactly one word and in its own direction.
 */
async function checkWordMotion(host: Host, id: 'wordMotion' | 'wordMotionAlt'): Promise<void> {
  const { m } = await mount(host, ALT);
  try {
    m.key('one two');
    await m.settle();
    pressAll(m, id, 0);
    await m.settle();
    m.key('X');
    await m.settle();
    pressAll(m, id, 1);
    await m.settle();
    m.key('Y');
    await m.settle();
    pressAll(m, 'send');
    await vi.waitFor(() => expect(m.submitted).toEqual(['one XtwoY']));
  } finally {
    m.unmount();
  }
}

/** Each key's check: what its verb says, on a chat that has it. The table must name every key of the data module. */
const CHECKS: Readonly<Record<Id, (host: Host) => Promise<void>>> = {
  send: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      m.key('hello');
      await m.settle();
      pressAll(m, 'send');
      await vi.waitFor(() => expect(m.submitted).toEqual(['hello']));
      // `or run the command`: a typed command goes the same way.
      m.key('/mode');
      await m.settle();
      pressAll(m, 'send');
      await vi.waitFor(() => expect(m.submitted).toEqual(['hello', '/mode']));
    } finally {
      m.unmount();
    }
  },
  newline: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      m.key('a');
      await m.settle();
      pressAll(m, 'newline');
      m.key('b');
      await m.settle();
      // The line break is in what is sent: one message of two lines, and nothing was sent by the key itself.
      expect(m.submitted).toEqual([]);
      m.key('\r');
      await vi.waitFor(() => expect(m.submitted).toEqual(['a\nb']));
    } finally {
      m.unmount();
    }
  },
  history: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      m.key('earlier question');
      await m.settle();
      pressAll(m, 'send');
      await vi.waitFor(() => expect(m.submitted).toEqual(['earlier question']));
      await m.settle();
      expect(m.text()).not.toContain('earlier question');
      // `↑` on the first line brings back what was sent, and `↓` goes forward again to the empty prompt.
      pressAll(m, 'history', 0);
      await m.until(() => m.text().includes('earlier question'));
      expect(m.text()).toContain('earlier question');
      expect(m.submitted).toEqual(['earlier question']);
      pressAll(m, 'history', 1);
      await m.until(() => !m.text().includes('earlier question'));
      expect(m.text()).not.toContain('earlier question');
    } finally {
      m.unmount();
    }
  },
  lineEdges: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      m.key('abc');
      await m.settle();
      // One key at a time: bytes written together reach the terminal's reader as one chunk, which is text.
      pressAll(m, 'lineEdges', 0);
      await m.settle();
      m.key('X');
      await m.settle();
      pressAll(m, 'lineEdges', 1);
      await m.settle();
      m.key('Y');
      await m.settle();
      pressAll(m, 'send');
      // The start of the line took the `X`, and the end of the line took the `Y`.
      await vi.waitFor(() => expect(m.submitted).toEqual(['XabcY']));
    } finally {
      m.unmount();
    }
  },
  lineEdgeKeys: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      m.key('abc');
      await m.settle();
      pressAll(m, 'lineEdgeKeys', 0);
      await m.settle();
      m.key('X');
      await m.settle();
      pressAll(m, 'lineEdgeKeys', 1);
      await m.settle();
      m.key('Y');
      await m.settle();
      pressAll(m, 'send');
      // The start of the line took the `X`, and the end of the line took the `Y`.
      await vi.waitFor(() => expect(m.submitted).toEqual(['XabcY']));
    } finally {
      m.unmount();
    }
  },
  wordMotion: async (host) => {
    await checkWordMotion(host, 'wordMotion');
  },
  wordMotionAlt: async (host) => {
    await checkWordMotion(host, 'wordMotionAlt');
  },
  deleteWord: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      m.key('one two');
      await m.settle();
      pressAll(m, 'deleteWord');
      await m.settle();
      m.key('X');
      await m.settle();
      pressAll(m, 'send');
      // Only the word before the cursor went.
      await vi.waitFor(() => expect(m.submitted).toEqual(['one X']));
    } finally {
      m.unmount();
    }
  },
  deleteToStart: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      m.key('abcdef');
      await m.settle();
      m.key(LEFT.repeat(3));
      await m.settle();
      pressAll(m, 'deleteToStart');
      await m.settle();
      pressAll(m, 'send');
      // What was before the cursor went, what was after it stayed.
      await vi.waitFor(() => expect(m.submitted).toEqual(['def']));
    } finally {
      m.unmount();
    }
  },
  deleteToEnd: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      m.key('abcdef');
      await m.settle();
      m.key(LEFT.repeat(3));
      await m.settle();
      pressAll(m, 'deleteToEnd');
      await m.settle();
      pressAll(m, 'send');
      // What was after the cursor went, what was before it stayed.
      await vi.waitFor(() => expect(m.submitted).toEqual(['abc']));
    } finally {
      m.unmount();
    }
  },
  commands: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      pressAll(m, 'commands');
      await m.until(() => m.text().includes('Enter run'));
      expect(m.text()).toContain('Enter run');
      m.key('\u001b');
      // A lone `Esc` is told from the start of a key sequence after a short wait of the terminal's own, so this waits in real time.
      await vi.waitFor(() => expect(m.text()).not.toContain('Enter run'), {
        timeout: 3000,
        interval: 15,
      });
      // From an empty prompt only: with something typed, `/` is a character of the message.
      m.key('a');
      await m.settle();
      pressAll(m, 'commands');
      await m.settle();
      expect(m.text()).not.toContain('Enter run');
      m.key('\r');
      await vi.waitFor(() => expect(m.submitted).toEqual(['a/']));
    } finally {
      m.unmount();
    }
  },
  files: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      pressAll(m, 'files');
      await m.until(() => m.text().includes('README.md'));
      expect(m.text()).toContain('README.md');
      expect(m.submitted).toEqual([]);
    } finally {
      m.unmount();
    }
  },
  search: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      pressAll(m, 'search');
      await m.until(() => /search/iu.test(m.text()));
      expect(m.text()).toMatch(/search/iu);
      expect(m.submitted).toEqual([]);
    } finally {
      m.unmount();
    }
  },
  mode: async (host) => {
    const { m, onModeChange } = await mount(host, ALT);
    try {
      const was = m.store.getSnapshot().mode;
      pressAll(m, 'mode');
      await vi.waitFor(() => expect(onModeChange).toHaveBeenCalledOnce());
      expect(onModeChange).toHaveBeenCalledWith(nextMode(was));
    } finally {
      m.unmount();
    }
  },
  thinking: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      expect(m.store.getSnapshot().reasoningVisible).toBe(false);
      pressAll(m, 'thinking');
      await vi.waitFor(() => expect(m.store.getSnapshot().reasoningVisible).toBe(true));
      pressAll(m, 'thinking');
      await vi.waitFor(() => expect(m.store.getSnapshot().reasoningVisible).toBe(false));
    } finally {
      m.unmount();
    }
  },
  stop: async (host) => {
    const { m, onAbort } = await mount(host, ALT);
    try {
      // Idle, `Esc` stops nothing: it asks no turn to stop.
      pressAll(m, 'stop');
      await m.settle();
      expect(onAbort).not.toHaveBeenCalled();
      m.store.apply({
        type: 'session:turn_started',
        sessionId: 'matrix-session',
        sequenceNumber: 1,
        timestamp: '2026-11-25T00:00:00.000Z',
      });
      await m.settle();
      pressAll(m, 'stop');
      await vi.waitFor(() => expect(onAbort).toHaveBeenCalledOnce());
      // `keep the chat`: nothing ended it.
      expect(m.submitted).not.toContain('/cancel');
    } finally {
      m.unmount();
    }
  },
  scroll: async (host) => {
    const { m } = await mount(host, ALT, LONG);
    try {
      await m.until(() => m.text().includes('answer 39'));
      expect(m.text()).toContain('answer 39');
      // PgUp moves back through the conversation until the first turn is on screen, and PgDn brings the last one back.
      for (let page = 0; page < 12; page += 1) {
        pressAll(m, 'scroll', 0);
        await m.settle();
      }
      expect(m.text()).toContain('question 0 ');
      expect(m.text()).not.toContain('answer 39');
      for (let page = 0; page < 12; page += 1) {
        pressAll(m, 'scroll', 1);
        await m.settle();
      }
      expect(m.text()).toContain('answer 39');
      // `the full-screen view`: the inline view keeps the terminal's own scrollback, and these keys scroll nothing there.
      const inline = await mount(host, { ...ALT, renderer: 'inline' }, LONG);
      try {
        const shown = inline.m.text();
        for (let page = 0; page < 6; page += 1) {
          pressAll(inline.m, 'scroll', 0);
          await inline.m.settle();
        }
        expect(inline.m.text()).toBe(shown);
      } finally {
        inline.m.unmount();
      }
    } finally {
      m.unmount();
    }
  },
  wheel: async (host) => {
    const { m } = await mount(host, ALT, LONG);
    try {
      await m.until(() => m.text().includes('answer 39'));
      // Wheel up moves back through the conversation to the first turn, and wheel down brings the last one back.
      for (let notch = 0; notch < 40; notch += 1) {
        pressAll(m, 'wheel', 0);
        await m.settle();
      }
      expect(m.text()).toContain('question 0 ');
      expect(m.text()).not.toContain('answer 39');
      for (let notch = 0; notch < 40; notch += 1) {
        pressAll(m, 'wheel', 1);
        await m.settle();
      }
      expect(m.text()).toContain('answer 39');
      // The reports were consumed: none of their bytes were typed into the prompt.
      expect(m.text()).not.toContain('<64;');
      expect(m.submitted).toEqual([]);
    } finally {
      m.unmount();
    }
  },
  select: async (host) => {
    const copied: string[] = [];
    const { m } = await mount(host, ALT, LONG, {
      clipboard: (text) => {
        copied.push(text);
        return { kind: 'written', characters: text.length };
      },
    });
    try {
      await m.until(() => m.text().includes('answer 39'));
      // The header takes the rows above the viewport (ADR-0146 §4): the second row OF THE VIEWPORT is the one the presses are on. The copy is
      // the row's CONTENT, right of the grid's margin (MVP-11 unit 9, OQ9): the press at its first column lands in the margin and clamps.
      const row = (m.text().split('\n')[CHAT_HEADER_ROWS + 1] ?? '')
        .slice(chatGrid(ALT.size.cols).margin)
        .trimEnd();
      expect(row).toMatch(/question|answer/u);
      // Press at the start of the second row, drag past its end, release: the whole of that row is what was copied.
      for (const press of CHAT_KEYS.select.presses) {
        m.key(bytesOf(press));
        await m.settle();
      }
      await vi.waitFor(() => expect(copied.map((text) => text.trimEnd())).toEqual([row]));
      expect(m.submitted).toEqual([]);
    } finally {
      m.unmount();
    }
  },
  suspend: async (host) => {
    const onSuspend = vi.fn();
    const { m } = await mount(host, ALT, undefined, { onSuspend });
    try {
      m.key('draft');
      await m.settle();
      pressAll(m, 'suspend');
      await vi.waitFor(() => expect(onSuspend).toHaveBeenCalledOnce());
      // It is the shell's job control, not text and not a message: the draft is as it was, and nothing was sent.
      expect(m.text()).toContain('draft');
      expect(m.submitted).toEqual([]);
    } finally {
      m.unmount();
    }
  },
  interrupt: async (host) => {
    const { m } = await mount(host, ALT);
    try {
      m.key('draft text');
      await m.until(() => m.text().includes('draft text'));
      // With a draft the first press clears it and arms nothing: the next press is a first press again.
      pressAll(m, 'interrupt');
      await m.until(() => !m.text().includes('draft text'));
      expect(m.text()).not.toContain('draft text');
      expect(m.submitted).toEqual([]);
      // Empty, the first press arms and the second ends the chat.
      pressAll(m, 'interrupt');
      await m.settle();
      expect(m.submitted).not.toContain('/cancel');
      pressAll(m, 'interrupt');
      await vi.waitFor(() => expect(m.submitted).toContain('/cancel'));
    } finally {
      m.unmount();
    }
  },
};

describe('every key `/help` lists for a chat does what its verb says', () => {
  it('has a check for every key of the data module, and none for a key that is not in it', () => {
    expect(Object.keys(CHECKS).sort()).toEqual(Object.keys(CHAT_KEYS).sort());
  });

  it('says exactly these words for exactly these keys, in this order (a verb changed to say something else is a decision, not a drift)', () => {
    expect(Object.entries(CHAT_KEYS).map(([id, key]) => [id, key.keys, key.verb])).toEqual([
      ['send', 'Enter', 'send what you typed, or run the command'],
      ['newline', 'Ctrl+J', 'add a line to what you are typing'],
      [
        'history',
        '↑/↓',
        'recall what you sent before, from the first or the last line of the prompt',
      ],
      ['lineEdges', 'Ctrl+A/Ctrl+E', 'move to the start or the end of the line'],
      ['lineEdgeKeys', 'Home/End', 'move to the start or the end of the line'],
      ['wordMotion', 'Ctrl+←/Ctrl+→', 'move back or forward by one word'],
      ['wordMotionAlt', 'Alt+B/Alt+F', 'move back or forward by one word'],
      ['deleteWord', 'Ctrl+W', 'delete the word before the cursor'],
      ['deleteToStart', 'Ctrl+U', 'delete from the cursor back to the start of the line'],
      ['deleteToEnd', 'Ctrl+K', 'delete from the cursor to the end of the line'],
      ['commands', '/', 'the commands, from an empty prompt'],
      ['files', '@', 'attach a file by name, from the start of a word'],
      ['search', 'Ctrl+R', 'search the messages you sent before'],
      ['mode', 'Shift+Tab', 'change the mode, between turns'],
      ['thinking', 'Ctrl+T', 'show or hide the reasoning of the model'],
      ['stop', 'Esc', 'stop the running turn and keep the chat'],
      ['scroll', 'PgUp/PgDn', 'scroll the conversation (the full-screen view)'],
      ['wheel', 'Mouse wheel', 'scroll the conversation (the full-screen view)'],
      ['select', 'Mouse drag', 'select text and copy it (the full-screen view)'],
      [
        'suspend',
        'Ctrl+Z',
        'send the chat to the background of the shell, where the system has job control',
      ],
      [
        'interrupt',
        'Ctrl+C',
        'clear what you typed; on an empty prompt, press twice to end the chat (back to the Home, in a chat the Home opened)',
      ],
    ]);
  });

  it('names each key once, with a verb that names no key (a key in a sentence is the legend builder’s token)', () => {
    const names = Object.values(CHAT_KEYS).map((key) => key.keys);
    expect(new Set(names).size).toBe(names.length);
    for (const key of Object.values(CHAT_KEYS)) {
      expect(key.presses.length).toBeGreaterThan(0);
      expect(key.verb).not.toMatch(/\b(?:Esc|Enter|Ctrl\+|Tab|PgUp|PgDn)\b/u);
    }
  });

  describe.each(['standalone-chat', 'chat'] as const)('in the %s host', (host) => {
    it.each(Object.keys(CHAT_KEYS) as Id[])('%s', async (id) => {
      await CHECKS[id](host);
    });
  });
});
