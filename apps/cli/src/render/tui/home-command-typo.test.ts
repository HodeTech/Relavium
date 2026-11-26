import { describe, expect, it, vi } from 'vitest';
import { createHomeController } from './home-controller.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { nearestCommandName } from './command-typo.js';

describe('Home command typo guidance', () => {
  it.each([false, true])('suggests /init locally without executing it (chat=%s)', async (chat) => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const processLine = vi.fn(() => Promise.resolve());
    const startChat = vi.fn(() =>
      Promise.resolve({
        store,
        sessionId: 'kept-session',
        processLine,
        shouldStop: () => false,
        stopReason: () => 'exit' as const,
        teardown: () => Promise.resolve(),
      }),
    );
    const initializeProject = vi.fn(() => Promise.resolve('initialized'));
    const controller = createHomeController({
      startChat,
      initializeProject,
      homeStore: {
        read: () => ({
          attention: { failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRuns: [],
          totals: { attention: 0, sessions: 0, runs: 0 },
          isEmpty: true,
        }),
      },
      onExit: () => {},
      onError: (error) => {
        throw error;
      },
    });
    const submit = (text: string) => {
      controller.handlePaste(text);
      controller.handleKey('', { return: true });
    };
    if (chat) {
      submit('local message');
      await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
    }
    const starts = startChat.mock.calls.length;
    const lines = processLine.mock.calls.length;
    submit('/inti');
    if (chat) {
      // `/init` is the Home's, not a chat's (ADR-0145 §7.5, OD-2): a chat's list does not carry it, so a near miss of it is not suggested
      // there. The chat's own dispatch answers the line, as it answers any word it does not know.
      expect(controller.getSnapshot().notice).toBeUndefined();
      await vi.waitFor(() => expect(processLine).toHaveBeenCalledTimes(lines + 1));
    } else {
      expect(controller.getSnapshot().notice).toBe('Unknown command. Did you mean /init?');
      expect(processLine).toHaveBeenCalledTimes(lines);
    }
    expect(controller.getSnapshot().input.text).toBe('');
    expect(startChat).toHaveBeenCalledTimes(starts);
    expect(initializeProject).not.toHaveBeenCalled();
    expect(controller.getSnapshot().mode).toBe(chat ? 'chat' : 'home');
    const before = processLine.mock.calls.length;
    submit('/init extra');
    if (chat) {
      // In a chat the typed word is answered with the one-line pointer to the Home, in the transcript; nothing opens and nothing is sent.
      expect(controller.getSnapshot().notice).toBeUndefined();
      expect(processLine).toHaveBeenCalledTimes(before);
      expect(
        store
          .getSnapshot()
          .state.transcript.some(
            (entry) =>
              entry.role === 'notice' && entry.text === '/init is available from the Home.',
          ),
      ).toBe(true);
    } else {
      expect(controller.getSnapshot().notice).toBe('/init accepts no arguments.');
    }
    expect(initializeProject).not.toHaveBeenCalled();
    if (chat) {
      submit('/mode plan');
      await vi.waitFor(() => expect(processLine).toHaveBeenCalledTimes(before + 1));
    }
    await controller.teardownActive();
  });

  it('bounds spelling work and never suggests an exact command or distant prose', () => {
    expect(nearestCommandName('/inti', ['/init', '/providers'])).toBe('/init');
    expect(nearestCommandName('/init', ['/init'])).toBeUndefined();
    expect(nearestCommandName('/' + 'i'.repeat(1000), ['/init'])).toBeUndefined();
    expect(nearestCommandName('ordinary prose', ['/init'])).toBeUndefined();
  });
});
