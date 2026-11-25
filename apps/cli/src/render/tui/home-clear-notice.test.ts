import { describe, expect, it } from 'vitest';

import { clearedNotice } from '../../chat/repl-info.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { createChatStore } from './chat-store.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * The notice the chat the Home hosts opens a fresh conversation with (MVP-11 Step 2 review round 2, Q5): `/resume continues it`, and not the
 * stand-alone chat's 'start Relavium without arguments', which sends a person who is already on the Home away from it. The Home's controller
 * calls `clearedNotice()` with no argument and relies on its default, which was unpinned: a default changed to the stand-alone surface
 * passed the whole suite. A new file (`chat/repl-info.test.ts` belongs to the permanent workload pin).
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
const HOME_SENTENCE =
  '✨ Started a fresh conversation. The previous one is saved; /resume continues it.';

function session(id: string, clear?: () => Promise<HomeChatSession>): HomeChatSession {
  let stopReason: 'exit' | 'clear' = 'exit';
  return {
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: id,
    processLine: (line) => {
      if (line === '/clear') stopReason = 'clear';
      return Promise.resolve();
    },
    shouldStop: () => stopReason === 'clear',
    stopReason: () => stopReason,
    teardown: () => Promise.resolve(),
    ...(clear === undefined ? {} : { clear }),
  };
}

describe('the notice a /clear in the chat the Home hosts opens the fresh conversation with', () => {
  it('is the Home’s sentence, which names /resume, and not the stand-alone chat’s', async () => {
    const fresh = session('fresh');
    const first = session('first', () => Promise.resolve(fresh));
    const c: HomeController = createHomeController({
      homeStore: { read: () => SNAPSHOT },
      startChat: () => Promise.resolve(first),
      onExit: () => {},
      onError: () => {},
    });
    for (const ch of 'hello') c.handleKey(ch, {});
    c.handleKey('', ENTER);
    await flush();
    await flush();
    expect(c.getSnapshot().session).toBe(first);
    c.handlePaste('/clear');
    c.handleKey('', ENTER);
    await flush();
    await flush();
    expect(c.getSnapshot().session, 'the chat was swapped for the fresh one').toBe(fresh);
    const transcript = fresh.store
      .getSnapshot()
      .state.transcript.map((entry) => entry.text)
      .join('\n');
    expect(transcript).toContain(HOME_SENTENCE);
    expect(transcript).not.toContain('start Relavium without arguments');
  });

  it('is the surface the Home chat is on by default, and the stand-alone chat names the Home in words', () => {
    expect(clearedNotice()).toBe(HOME_SENTENCE);
    expect(clearedNotice('home')).toBe(HOME_SENTENCE);
    expect(clearedNotice('standalone-chat')).toContain('start Relavium without arguments');
    expect(clearedNotice('standalone-chat')).not.toBe(HOME_SENTENCE);
  });
});
