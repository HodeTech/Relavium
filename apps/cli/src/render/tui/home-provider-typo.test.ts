import { describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * A near miss of `/providers` (MVP-11 Step 2 review, C7): at the landing it says the word to type; in a chat the Home hosts, where
 * `/providers` itself answers with a pointer only, it must point at the Home too and not tell the person to type a word that does nothing.
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
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function session(): HomeChatSession {
  return {
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: 'sess-typo',
    processLine: () => Promise.resolve(),
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
}

const controller = (startChat: () => Promise<HomeChatSession>) =>
  createHomeController({
    homeStore: { read: () => SNAPSHOT },
    startChat,
    onExit: () => {},
    onError: () => {},
    providerSetup: { initialKeyless: false, open: () => Promise.resolve() },
  });

describe('/provider (the near miss)', () => {
  it('at the landing says the word to type', () => {
    const c = controller(vi.fn());
    c.handlePaste('/provider');
    c.handleKey('', ENTER);
    expect(c.getSnapshot().notice).toBe('Use /providers to connect or manage provider keys.');
    expect(c.getSnapshot().input.text).toBe('');
  });

  it('in a chat the Home hosts points at the Home instead, in the chat and not on the landing', async () => {
    const made = session();
    const c = controller(() => Promise.resolve(made));
    c.handlePaste('hello');
    c.handleKey('', ENTER);
    await flush();
    expect(c.getSnapshot().mode).toBe('chat');
    c.handlePaste('/provider');
    c.handleKey('', ENTER);
    const notes = made.store
      .getSnapshot()
      .state.transcript.map((entry) => entry.text)
      .join('\n');
    expect(notes).toContain('go back to it ([Ctrl+C] twice) and use /providers');
    expect(notes).not.toContain('Use /providers to connect');
    expect(c.getSnapshot().notice, 'nothing is left on the landing').toBeUndefined();
  });
});
