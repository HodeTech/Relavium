import { describe, expect, it } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';
import { EMPTY_HISTORY, historyPrev, recordHistory } from './input-history.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * A key typed at a chat's prompt is not recorded in the input history, on any surface (MVP-11 Step 2 review round 2, A3, Q4). The Home hands
 * a chat's slash line down to the chat's own dispatch (which answers a key with a fixed sentence, `chat-key-in-command.test.ts`), and
 * `recordHistory` is the one function every prompt records through, so Up and `Ctrl+R` cannot bring a pasted key back. A new file.
 */
const SNAPSHOT: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};
const ENTER = { return: true } as const;
const FILL = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
const KEYS = [
  `sk-ant-api03-${FILL}${FILL}`,
  `sk-proj-${FILL}${FILL}`,
  `sk-${'0123456789abcdef'.repeat(2)}`,
  `AIza${FILL}_-x`,
];
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const type = (c: HomeController, text: string): void => {
  for (const ch of text) c.handleKey(ch, {});
};

function chatSession(lines: string[]): HomeChatSession {
  return {
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: 'sess-key-line',
    processLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
}

async function homeChat(): Promise<{ c: HomeController; lines: string[] }> {
  const lines: string[] = [];
  const c = createHomeController({
    homeStore: { read: () => SNAPSHOT },
    startChat: () => Promise.resolve(chatSession(lines)),
    onExit: () => {},
    onError: () => {},
  });
  type(c, 'hello');
  c.handleKey('', ENTER);
  await flush();
  expect(c.getSnapshot().mode).toBe('chat');
  await flush();
  return { c, lines };
}

describe('the Home-hosted chat', () => {
  it.each(KEYS)(
    'hands a slash-led key down to the chat and records nothing of it: %#',
    async (key) => {
      const { c, lines } = await homeChat();
      c.handlePaste(`/${key}`);
      c.handleKey('', ENTER);
      await flush();
      expect(lines, 'the chat’s own dispatch answers it').toContain(`/${key}`);
      expect(c.getSnapshot().historyEntries, 'only the message that started the chat').toEqual([
        'hello',
      ]);
      c.handleKey('', { upArrow: true });
      expect(c.getSnapshot().input.text, 'Up recalls the message, not the key').toBe('hello');
    },
  );

  it.each(KEYS)('records no key typed as a message either: %#', async (key) => {
    const { c } = await homeChat();
    c.handlePaste(`here is my key ${key}`);
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().historyEntries).toEqual(['hello']);
  });

  it('still records an ordinary line, so Up recalls it', async () => {
    const { c } = await homeChat();
    c.handlePaste('/cost'); // pasted: a typed `/` at an empty prompt opens the palette, which owns Enter
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().historyEntries).toEqual(['hello', '/cost']);
  });
});

describe('recordHistory', () => {
  it.each(KEYS)(
    'skips a key, alone or in a sentence, and leaves the navigation reset: %#',
    (key) => {
      const kept = recordHistory(EMPTY_HISTORY, 'hello');
      expect(recordHistory(kept, key).entries).toEqual(['hello']);
      expect(recordHistory(kept, `my key is ${key} ok`).entries).toEqual(['hello']);
      const navigating = historyPrev(kept, '')?.history ?? kept;
      expect(navigating.navIndex).not.toBeNull();
      expect(recordHistory(navigating, key).navIndex, 'a skipped line still resets Up').toBeNull();
    },
  );
});
