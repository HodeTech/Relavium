/**
 * Control characters in a draft (MVP-11 unit 7, round 2: F6). A write that carries a control character with the text before or after it
 * reaches the editor as ONE chunk (`↓`, `Enter`, `Ctrl+N` in a single write; `a` and `Ctrl+N`), and a paste may carry an escape sequence or a
 * C1 control. Both went into the draft as text, and from the draft into a message, a title and a log. Now every C0 control but TAB and LF,
 * DEL and every C1 control is dropped before the text enters the draft, typed or pasted, by ONE function (`draftText`) that the chat's
 * keystroke reducer and both bracketed-paste handlers call.
 *
 * The ranges are named once, here: C0 U+0000 to U+0008 and U+000B to U+001F, DEL U+007F, C1 U+0080 to U+009F; kept: TAB U+0009 and LF U+000A
 * (a CR or a CRLF inside text is one LF, never an Enter: only a key event of its own submits).
 *
 * The oracle is the draft the editor holds (the controller's `input.text`, or the line a chat hands its session), after REAL key bytes written
 * to a real mounted terminal: the Home's landing and docked prompts, the chat the Home hosts and the stand-alone chat.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import {
  DRAFT_CONTROL_RANGES,
  draftText,
  reduceChatKey,
  reduceEditorMotion,
} from './chat-input.js';
import { bracketed } from './harness-util.js';
import { mountHostedChat, mountStandaloneChat } from './surface-matrix/chat-host.js';
import { KEYS, mountHome, type HomeMount } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';

const ch = (code: number): string => String.fromCodePoint(code);
const ESC = ch(0x1b);
const CTRL_N = ch(0x0e);
const C1_CSI = ch(0x9b);
const TAB = ch(0x09);
const LF = ch(0x0a);
const CR = ch(0x0d);

/** Every code point the draft drops: the ranges of the contract, as this file states them (not read from the code). */
const DROPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
];
const allCodes = DROPPED_RANGES.flatMap(([from, to]) =>
  Array.from({ length: to - from + 1 }, (_, offset) => from + offset),
);
/** The carriage return is inside the range but is not dropped: it is a line break first (a CR or a CRLF is one LF), so it is tested apart. */
const droppedCodes = allCodes.filter((code) => code !== 0x0d);
const CONTROLS = new RegExp(
  `[${DROPPED_RANGES.map(([from, to]) => `${ch(from)}-${ch(to)}`).join('')}]`,
  'u',
);

const variant: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 30 } };
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const session: HomeSessionRow = {
  sessionId: 'session-1',
  title: 'Earlier conversation',
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: new Date(NOW - 600_000).toISOString(),
  totalCostMicrocents: 0,
};
const SNAPSHOT: HomeSnapshot = {
  failedRuns: [],
  recentSessions: [session],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 1, runs: 0 },
  isEmpty: false,
};

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const mount of mounted.splice(0)) mount.unmount();
});

async function openHome(): Promise<HomeMount> {
  const home = mountHome(variant, { snapshot: SNAPSHOT, props: { nowMs: () => NOW } });
  mounted.push(home);
  await home.settle();
  return home;
}

/** The draft of the Home, once a write has landed. */
const draftOf = (home: HomeMount): string => home.controller.getSnapshot().input.text;

/** What a chunk of keys writes: the text with a control character glued to it. */
const CHUNKS: readonly (readonly [name: string, chunk: string, draft: string])[] = [
  ['a letter and Ctrl+N', `a${CTRL_N}`, 'a'],
  ['a letter and a C1 control sequence introducer', `a${C1_CSI}2J`, 'a2J'],
  ['a bell between two words', `one${ch(0x07)}two`, 'onetwo'],
  ['a vertical tab and a form feed', `a${ch(0x0b)}${ch(0x0c)}b`, 'ab'],
  ['a file separator and a C1 next line', `a${ch(0x1c)}${ch(0x85)}b`, 'ab'],
  ['a text with a tab in it keeps the tab', `a${TAB}b`, `a${TAB}b`],
];

describe('the C0, DEL and C1 controls are dropped from what enters the draft', () => {
  it('names the ranges the code holds', () => {
    expect(DRAFT_CONTROL_RANGES).toEqual(DROPPED_RANGES);
    expect(allCodes).toHaveLength(9 + 21 + 33);
    expect(droppedCodes).toHaveLength(9 + 21 + 33 - 1);
  });

  it('drops every one of them from a chunk, whatever surrounds it, and nothing else', () => {
    for (const code of droppedCodes) {
      expect(draftText(`a${ch(code)}b`), `U+${code.toString(16)}`).toBe('ab');
    }
    // the two it keeps, and a carriage return that becomes a line feed
    expect(draftText(`a${TAB}b${LF}c`)).toBe(`a${TAB}b${LF}c`);
    expect(draftText(`a${CR}${LF}b${CR}c`)).toBe(`a${LF}b${LF}c`);
    // the neighbours of each range are text
    for (const code of [0x20, 0x7e, 0xa0, 0xa1]) expect(draftText(ch(code))).toBe(ch(code));
  });

  it('the keystroke reducer appends the text without them, and a chunk of nothing but controls edits nothing', () => {
    for (const code of droppedCodes) {
      expect(reduceEditorMotion(`a${ch(code)}b`, {}), `U+${code.toString(16)}`).toEqual({
        kind: 'append',
        char: 'ab',
      });
      expect(reduceEditorMotion(ch(code), {}), `U+${code.toString(16)}`).toBeUndefined();
    }
  });

  it('a carriage return inside a chunk is a line break, never an Enter', () => {
    expect(reduceChatKey(`${CR}${CTRL_N}`, {}, 'draft', false)).toEqual({
      kind: 'append',
      char: LF,
    });
    expect(reduceChatKey(`text${CR}`, {}, 'draft', false)).toEqual({
      kind: 'append',
      char: `text${LF}`,
    });
    // a key event of its own is the Enter
    expect(reduceChatKey('', { return: true }, 'draft', false)).toEqual({
      kind: 'submit',
      line: 'draft',
    });
  });

  it('keeps what the chat keeps: a multi-line paste keeps its newlines, a tab stays, a typed letter is a letter', () => {
    expect(draftText(`first${LF}second${CR}${LF}third${TAB}x`)).toBe(
      `first${LF}second${LF}third${TAB}x`,
    );
    expect(reduceEditorMotion('a', {})).toEqual({ kind: 'append', char: 'a' });
    expect(reduceEditorMotion('', { tab: true })).toBeUndefined();
    expect(reduceEditorMotion('x', { ctrl: true })).toBeUndefined();
  });
});

describe("the Home's landing prompt", () => {
  it.each(CHUNKS)('a typed chunk of %s', async (_name, chunk, draft) => {
    const home = await openHome();
    home.key(chunk);
    await home.settle();
    expect(draftOf(home)).toBe(draft);
  });

  it('`↓`, `Enter` and `Ctrl+N` in one write leave a line feed, never a control character', async () => {
    const home = await openHome();
    home.key(`${KEYS.down}${KEYS.enter}${CTRL_N}`);
    await home.settle();
    expect(draftOf(home)).not.toMatch(CONTROLS);
    expect(draftOf(home)).toBe(LF);
  });

  it('`a` and Ctrl+N in one write, then Enter, start the chat with `a`, and nothing else is the pending message', async () => {
    const home = await openHome();
    home.key(`a${CTRL_N}`);
    await home.settle();
    home.key(KEYS.enter);
    await home.until(() => home.controller.getSnapshot().pendingMessage !== '');
    expect(home.controller.getSnapshot().pendingMessage).toBe('a');
  });

  it('`a` and a C1 control sequence introducer in one write, then Enter, start the chat with no control in the message', async () => {
    const home = await openHome();
    home.key(`a${C1_CSI}2J`);
    await home.settle();
    home.key(KEYS.enter);
    await home.until(() => home.controller.getSnapshot().pendingMessage !== '');
    expect(home.controller.getSnapshot().pendingMessage).toBe('a2J');
  });

  it('a bracketed paste keeps its newlines and tabs and loses its escape sequences and controls', async () => {
    const home = await openHome();
    home.key(
      bracketed(`one${ESC}]52;c;ZXZpbA==${ch(0x07)}two${C1_CSI}2Jthree${CR}${LF}four${TAB}five`),
    );
    await home.settle();
    expect(draftOf(home)).toBe(`one]52;c;ZXZpbA==two2Jthree${LF}four${TAB}five`);
    expect(draftOf(home)).not.toMatch(CONTROLS);
  });

  it('a multi-line paste is untouched', async () => {
    const home = await openHome();
    home.key(bracketed(`a${LF}b${CR}${LF}c${CR}d`));
    await home.settle();
    expect(draftOf(home)).toBe(`a${LF}b${LF}c${LF}d`);
  });

  it('a paste of nothing but controls leaves the prompt as it was', async () => {
    const home = await openHome();
    home.key(bracketed(`${ch(0x07)}${CTRL_N}${C1_CSI}`));
    await home.settle();
    expect(draftOf(home)).toBe('');
  });
});

describe("the Home's docked prompt (page 2, a row focused)", () => {
  async function onWorkPage(): Promise<HomeMount> {
    const home = await openHome();
    home.key(KEYS.down);
    await home.settle();
    await home.until(() => home.controller.getSnapshot().homePage === 'work');
    expect(home.controller.getSnapshot().stripFocus?.id).toBe('session-1');
    return home;
  }

  it.each(CHUNKS)('a typed chunk of %s', async (_name, chunk, draft) => {
    const home = await onWorkPage();
    home.key(chunk);
    await home.settle();
    expect(draftOf(home)).toBe(draft);
    // typing gives the focus back to the prompt, as it does for any text
    expect(home.controller.getSnapshot().stripFocus).toBeUndefined();
  });

  it('a bracketed paste loses its escape sequences and controls and keeps its newlines', async () => {
    const home = await onWorkPage();
    home.key(bracketed(`x${ESC}[2J${ch(0x07)}y${LF}z${C1_CSI}`));
    await home.settle();
    expect(draftOf(home)).toBe(`x[2Jy${LF}z`);
  });
});

describe.each([
  ['the chat the Home hosts', 'hosted'],
  ['the stand-alone chat', 'standalone'],
] as const)('%s', (_name, host) => {
  const open = async () => {
    const chat = host === 'hosted' ? await mountHostedChat(variant) : mountStandaloneChat(variant);
    mounted.push(chat);
    await chat.settle();
    return chat;
  };

  it.each(CHUNKS)(
    'a typed chunk of %s is sent without its controls',
    async (_name, chunk, draft) => {
      const chat = await open();
      await chat.typeLine(chunk);
      expect(chat.submitted).toEqual([draft]);
    },
  );

  it('a bracketed paste is sent without its escape sequences and controls, its newlines kept', async () => {
    const chat = await open();
    chat.key(bracketed(`p${ESC}]0;title${ch(0x07)}q${CR}${LF}r${C1_CSI}s`));
    await chat.settle();
    chat.key(KEYS.enter);
    await chat.settle();
    expect(chat.submitted).toEqual([`p]0;titleq${LF}rs`]);
  });
});
