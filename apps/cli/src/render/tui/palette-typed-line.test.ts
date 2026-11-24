import { describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * A line typed in a chat's `/` palette is a line, not a query to throw away (MVP-11 Step 2 review round 2, U1, B3). In a chat `/` at an empty
 * prompt opens the palette, so `/doctor --deep`, `/trim 20`, `/effort high` and `/mode plan` became a query that matches no row, and `Enter`
 * closed the palette and lost the text. A query that matches no row, or on which no row is highlighted (A2), is now sent down the chat's
 * own dispatch (which validates the tokens and answers an unknown word), after the Home has answered a line that is its own. The
 * Home-hosted chat here; the stand-alone chat is `palette-typed-line-chat.test.tsx`. A new file.
 */
const SNAPSHOT: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const ENTER = { return: true } as const;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

function chatSession(lines: string[]): HomeChatSession {
  return {
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: 'sess-typed-line',
    processLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
}

async function homeChat(): Promise<{
  readonly c: HomeController;
  readonly lines: string[];
  readonly notes: () => readonly string[];
}> {
  const lines: string[] = [];
  const session = chatSession(lines);
  const c = createHomeController({
    homeStore: { read: () => SNAPSHOT },
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => Promise.resolve(session),
    onExit: () => {},
    onError: () => {},
  });
  type(c, 'hello');
  c.handleKey('', ENTER);
  await flush();
  await flush();
  expect(c.getSnapshot().mode).toBe('chat');
  lines.length = 0; // the message that started the chat is not under test
  return {
    c,
    lines,
    notes: () => session.store.getSnapshot().state.transcript.map((entry) => entry.text),
  };
}

describe('a line typed in the palette of the chat the Home hosts', () => {
  it.each([
    '/doctor --deep',
    '/cost --release',
    '/trim 20',
    '/effort high',
    '/mode plan',
    '/exit now',
  ])('%s reaches the chat’s own dispatch, with its arguments', async (line) => {
    const { c, lines } = await homeChat();
    c.handleKey('/', {});
    expect(c.getSnapshot().palette, 'the palette is open').toBeDefined();
    type(c, line.slice(1));
    c.handleKey('', ENTER);
    await flush();
    expect(lines, 'sent down, not dropped').toEqual([line]);
    expect(c.getSnapshot().palette).toBeUndefined();
  });

  it.each(['/sta', '/start', '/fr', '/fresh', '/summari', '/end', '/hom', '/leave', '/go', '/ini'])(
    '%s, which no row is highlighted for, is dispatched as typed: nothing is run in its place',
    async (line) => {
      const { c, lines } = await homeChat();
      c.handleKey('/', {});
      type(c, line.slice(1));
      expect(c.getSnapshot().palette?.state.index, 'nothing is highlighted').toBe(-1);
      c.handleKey('', ENTER);
      await flush();
      expect(lines, 'the line the person typed, and not /clear, /compact, /exit or /trim').toEqual([
        line,
      ]);
    },
  );

  it('sends the line without the blanks around it', async () => {
    const { c, lines } = await homeChat();
    c.handleKey('/', {});
    type(c, 'trim 20  ');
    c.handleKey('', ENTER);
    await flush();
    expect(lines).toEqual(['/trim 20']);
  });

  it('still runs the highlighted row for a query that has one', async () => {
    const { c, lines } = await homeChat();
    c.handleKey('/', {});
    type(c, 'cost');
    c.handleKey('', ENTER);
    await flush();
    expect(lines).toEqual(['/cost']);
  });

  it('answers a word only the Home has with the pointer, and does not send it down (B3)', async () => {
    const { c, lines, notes } = await homeChat();
    c.handleKey('/', {});
    type(c, 'providers');
    c.handleKey('', ENTER);
    await flush();
    expect(lines, 'the Home answered it').toEqual([]);
    expect(notes().join('\n')).toContain('/providers');
    expect(notes().join('\n')).toContain('Home');
  });

  it('does nothing for an empty query: the palette closes, as it did', async () => {
    const { c, lines } = await homeChat();
    c.handleKey('/', {});
    type(c, '   ');
    c.handleKey('', { escape: true });
    expect(c.getSnapshot().palette).toBeUndefined();
    expect(lines).toEqual([]);
  });
});

describe('a line typed in the palette of the bare Home', () => {
  it('is still answered by the Home, as a pasted line is', async () => {
    const c = createHomeController({
      homeStore: { read: () => SNAPSHOT },
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      startChat: () => Promise.reject(new Error('no chat is built for a command line')),
      onExit: () => {},
      onError: () => {},
    });
    c.handleKey('/', {});
    type(c, 'run extra');
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().notice).toContain('/run accepts no arguments');
  });
});
