import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { emitChatHeader } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import {
  CHAT_HEADER_ROWS,
  chatFrameRows,
  chatSessionTitle,
  PROMPT_BLOCK_ROWS,
} from './chat-layout.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { RootApp } from './home-app.js';
import { WORDMARK } from './home-layout.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
  type ChatSetup,
} from './surface-matrix/chat-host.js';
import type { Variant } from './surface-matrix/variants.js';
import { waitFor } from './harness-util.js';
import { displayWidth } from './viewport.js';

/**
 * The chat's header, its row budget and its introduction ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §4, MVP-11 step 7a), in BOTH hosts (`relavium chat` and the chat the Home hosts) and both renderers: the full-screen frame is `rows − 1` rows
 * (23 at 80×24) of a 2-row header, a 16-row transcript at rest and the 5-row prompt block; inline the header is written once as the first thing
 * the chat prints and is not written again by a reseat or a `/clear`.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const ALT_80: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
const ALT_100: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 30 } };
const INLINE_80: Variant = { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } };

const HOSTS = ['standalone-chat', 'chat'] as const;
type Host = (typeof HOSTS)[number];

/** A conversation of `turns` turns, as the store holds it, whatever the renderer (the seed's transcript is carried by the full-screen store only). */
function setupWith(turns: number): ChatSetup {
  return {
    prepare: (store) => {
      for (let turn = 0; turn < turns; turn += 1) {
        store.appendUser(`question ${String(turn)} about the thing`);
        store.notice(`answer ${String(turn)} with a sentence that is not very long`);
      }
    },
    standalone: { provider: 'anthropic' },
    hosted: { session: { provider: 'anthropic' } },
  };
}

async function mountIn(host: Host, variant: Variant, setup: ChatSetup): Promise<ChatMount> {
  const mount =
    host === 'chat' ? await mountHostedChat(variant, setup) : mountStandaloneChat(variant, setup);
  await mount.settle();
  return mount;
}

describe.each(HOSTS)('the full-screen chat frame, in the %s host', (host) => {
  it('is rows − 1 tall: 23 rows at 80×24 and 29 at 100×30, a row of the terminal left alone', async () => {
    for (const variant of [ALT_80, ALT_100]) {
      const m = await mountIn(host, variant, setupWith(40));
      try {
        expect(m.frame(), JSON.stringify(variant.size)).toHaveLength(
          chatFrameRows(variant.size.rows),
        );
      } finally {
        m.unmount();
      }
    }
  });

  it('is a 2-row header, 16 rows of transcript at rest and the 5-row prompt block, at 80×24', async () => {
    const m = await mountIn(host, ALT_80, setupWith(40));
    try {
      const rows = m.frame();
      const shown = rows.map((row, index) => `${String(index)}|${row}`).join('\n');
      expect(chatFrameRows(24), 'the budget the layout states').toBe(
        CHAT_HEADER_ROWS + 16 + PROMPT_BLOCK_ROWS,
      );
      // The header: the wordmark, then a blank row.
      expect(rows[0]?.startsWith(WORDMARK), shown).toBe(true);
      expect(rows[1]?.trim(), shown).toBe('');
      // The transcript: 16 rows, every one of them a line of the conversation (the 40-turn conversation fills a viewport of any height).
      const transcript = rows.slice(CHAT_HEADER_ROWS, CHAT_HEADER_ROWS + 16);
      expect(
        transcript.every((row) => row.trim() !== ''),
        shown,
      ).toBe(true);
      expect(transcript.at(-1), shown).toContain('answer 39');
      expect(transcript.join('\n'), 'the oldest line is out of the viewport').not.toContain(
        'answer 0 ',
      );
      // The prompt block: a blank row, the prompt, a thin rule, the status line and the hint.
      expect(rows[CHAT_HEADER_ROWS + 16]?.trim(), shown).toBe('');
      expect(rows[CHAT_HEADER_ROWS + 17], shown).toMatch(/^> reply to continue/u);
      expect(rows[CHAT_HEADER_ROWS + 18], shown).toBe('-'.repeat(80));
      expect(rows[CHAT_HEADER_ROWS + 19], shown).toContain(' · ask mode · ');
      expect(rows[CHAT_HEADER_ROWS + 20], shown).toMatch(/^\[\/\] commands · \[Ctrl\+C\] /u);
      expect(rows).toHaveLength(CHAT_HEADER_ROWS + 16 + PROMPT_BLOCK_ROWS);
    } finally {
      m.unmount();
    }
  });

  it('has the wordmark at the left edge and the session title ending at the last column', async () => {
    const m = await mountIn(host, ALT_80, setupWith(3));
    try {
      const first = m.frame()[0] ?? '';
      expect(first.startsWith(WORDMARK)).toBe(true);
      expect(
        displayWidth(first.trimEnd()),
        'the row is the whole width: the title is right-aligned',
      ).toBe(80);
      // The title is the first user line, derived as the persister derives it.
      const title = chatSessionTitle('question 0 about the thing');
      expect(title).toBe('question 0 about the thing');
      expect(first.trimEnd().endsWith(title)).toBe(true);
    } finally {
      m.unmount();
    }
  });

  it('has the wordmark alone before the first message', async () => {
    const m = await mountIn(host, ALT_80, { standalone: { provider: 'anthropic' } });
    try {
      const first = (m.frame()[0] ?? '').trimEnd();
      if (host === 'standalone-chat') expect(first).toBe(WORDMARK);
      else expect(first.startsWith(WORDMARK)).toBe(true);
    } finally {
      m.unmount();
    }
  });

  it('keeps a hostile first message out of the header: no escape, no secret, nothing that could forge the status line', async () => {
    const key = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcdef'].join('-');
    const m = await mountIn(host, ALT_80, {
      prepare: (store) => {
        store.appendUser(`a · b ▸ c › d ${ESC}[31m${key} ${ESC}]0;pwned\u0007`);
      },
    });
    try {
      const first = m.frame()[0] ?? '';
      expect(first).not.toContain(key);
      expect(first).not.toContain(ESC);
      expect(first).not.toContain('pwned');
      expect(first).not.toContain(' · ');
      expect(first).not.toContain('▸');
    } finally {
      m.unmount();
    }
  });
});

describe('the inline chat header', () => {
  it('is not part of the stand-alone chat’s frame: that chat writes it before it mounts', async () => {
    const m = await mountIn('standalone-chat', INLINE_80, setupWith(2));
    try {
      expect(m.frame().join('\n')).not.toContain(WORDMARK);
    } finally {
      m.unmount();
    }
  });

  it('is the first thing the chat the Home hosts prints, once, above the conversation', async () => {
    const m = await mountIn('chat', INLINE_80, setupWith(2));
    try {
      const rows = m.frame();
      expect(rows[0]?.trimEnd()).toBe(WORDMARK);
      expect(rows[1]?.trim()).toBe('');
      expect(rows.filter((row) => row.includes(WORDMARK))).toHaveLength(1);
    } finally {
      m.unmount();
    }
  });
});

describe('the stand-alone chat writes its inline header once per process', () => {
  const bold = (text: string): string => `${ESC}[1m${text}${ESC}[22m`;

  it('writes the wordmark in bold and a blank row', () => {
    const written: string[] = [];
    emitChatHeader(false, {}, (text) => written.push(text));
    expect(written).toEqual([`${bold(WORDMARK)}\n\n`]);
  });

  it('writes nothing for the full-screen renderer, whose header is the first child of its frame', () => {
    const written: string[] = [];
    emitChatHeader(true, {}, (text) => written.push(text));
    expect(written).toEqual([]);
  });

  it('writes it once for the same owner: a /clear or a reseat mounts the next chat over the same io and prints nothing', () => {
    const written: string[] = [];
    const io = {};
    emitChatHeader(false, io, (text) => written.push(text));
    emitChatHeader(false, io, (text) => written.push(text));
    emitChatHeader(false, io, (text) => written.push(text));
    expect(written).toHaveLength(1);
    // Another process (another owner) is another introduction.
    emitChatHeader(false, {}, (text) => written.push(text));
    expect(written).toHaveLength(2);
  });

  it('does not spend the once on a full-screen mount: the same owner prints when it is later mounted inline', () => {
    const written: string[] = [];
    const io = {};
    emitChatHeader(true, io, (text) => written.push(text));
    emitChatHeader(false, io, (text) => written.push(text));
    expect(written).toHaveLength(1);
  });
});

describe('the chat the Home hosts, inline: the header belongs to a chat’s start and not to a swap of its conversation', () => {
  const SNAPSHOT = {
    attention: { failedRuns: [] },
    recentSessions: [],
    recentRuns: [],
    recentAgents: [],
    unreadableRuns: [],
    totals: { attention: 0, sessions: 0, runs: 0 },
    isEmpty: true,
  };
  const ENTER = { return: true } as const;

  /** A session whose `/clear` and `/exit` end it the way the line handler's do: the chat swaps (`clear`) or returns to the Home (`exit`). */
  function session(id: string, clear?: () => Promise<HomeChatSession>): HomeChatSession {
    let stopReason: 'exit' | 'clear' = 'exit';
    let stopped = false;
    return {
      store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
      sessionId: id,
      processLine: (line) => {
        if (line === '/clear') {
          stopReason = 'clear';
          stopped = true;
        }
        if (line === '/exit') stopped = true;
        return Promise.resolve();
      },
      shouldStop: () => stopped,
      stopReason: () => stopReason,
      teardown: () => Promise.resolve(),
      ...(clear === undefined ? {} : { clear }),
    };
  }

  it('is written when the chat starts, and a /clear that swaps the conversation does not write it again; a new chat does', async () => {
    const fresh = session('fresh');
    const first = session('first', () => Promise.resolve(fresh));
    const later = session('later');
    const sessions = [first, later];
    const controller = createHomeController({
      homeStore: { read: () => SNAPSHOT },
      startChat: () => {
        const next = sessions.shift();
        if (next === undefined) throw new Error('no session left');
        return Promise.resolve(next);
      },
      onExit: () => {},
      onError: () => {},
    });
    const harness = render(
      <RootApp
        controller={controller}
        nowMs={() => Date.now()}
        color={false}
        getSize={() => ({ cols: 80, rows: 24 })}
        subscribeResize={() => () => {}}
      />,
    );
    const frame = (): string => harness.lastFrame() ?? '';
    for (const ch of 'hello') controller.handleKey(ch, {});
    controller.handleKey('', ENTER);
    await waitFor(() => controller.getSnapshot().session === first);
    await waitFor(() => frame().includes('commands'));
    expect(frame(), 'the chat printed its header when it started').toContain(WORDMARK);

    // A /clear swaps the conversation under the same root: the same chat goes on, and nothing of its introduction is written again. A test
    // renderer's frame holds the static output of the live tree only (the old chat's is gone from it), so a header found in this frame was
    // printed by the NEW tree, which is what a swap must not do.
    controller.handlePaste('/clear');
    controller.handleKey('', ENTER);
    await waitFor(() => controller.getSnapshot().session === fresh);
    await waitFor(() => frame().includes('Started a fresh conversation'));
    expect(frame(), 'a swapped conversation is not a new introduction').not.toContain(WORDMARK);

    // Going back to the Home and starting another chat is a new start: its introduction is written.
    controller.handlePaste('/exit');
    controller.handleKey('', ENTER);
    await waitFor(() => controller.getSnapshot().mode === 'home');
    for (const ch of 'again') controller.handleKey(ch, {});
    controller.handleKey('', ENTER);
    await waitFor(() => controller.getSnapshot().session === later);
    await waitFor(() => frame().includes('type a message'));
    expect(frame(), 'a new chat prints its own header').toContain(WORDMARK);
  });
});
