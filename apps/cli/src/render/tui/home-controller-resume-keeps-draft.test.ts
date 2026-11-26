/**
 * A draft survives a conversation resumed from the work page (MVP-11 unit 7, round 1: SE74; `draftToKeep`): it was not sent, so the chat
 * starts with an empty composer and the Home's prompt has the draft again when the chat ends. Only an empty draft and a draft that looks like a
 * provider key are not kept, so a one-character draft is kept as much as a longer one.
 */
import { describe, expect, it } from 'vitest';

import { createChatStore } from './chat-store.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { DOWN, ENTER, sessionRow, snapshotOf, until } from './home-controller.test-support.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

const SESSIONS = snapshotOf({
  recentSessions: [sessionRow('s1')],
  totals: { attention: 0, sessions: 1, runs: 0 },
});

describe('a draft is kept across a conversation resumed from the work page', () => {
  it.each(['x', 'ab'])(
    'the draft %j is back on the Home prompt when the conversation ends',
    async (draft) => {
      let stopped = false;
      const session: HomeChatSession = {
        store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
        sessionId: 's1',
        processLine: () => {
          stopped = true;
          return Promise.resolve();
        },
        shouldStop: () => stopped,
        stopReason: () => 'exit',
        teardown: () => Promise.resolve(),
      };
      const controller = createHomeController({
        startChat: () => new Promise(() => {}),
        homeStore: { read: () => SESSIONS },
        resumeChat: () => Promise.resolve(session),
        onExit: () => {},
        onError: (cause) => {
          throw cause;
        },
      });
      controller.handlePaste(draft);
      controller.handleKey('', DOWN);
      controller.handleKey('', ENTER);
      await until(() => controller.getSnapshot().mode === 'chat');
      controller.handlePaste('/exit');
      controller.handleKey('', ENTER);
      await until(() => controller.getSnapshot().mode === 'home');
      expect(controller.getSnapshot().input.text).toBe(draft);
    },
  );
});
