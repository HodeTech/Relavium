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
      doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
      homeStore: {
        read: () => ({
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
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
    expect(controller.getSnapshot().notice).toBe('Unknown command. Did you mean /init?');
    expect(controller.getSnapshot().input.text).toBe('');
    expect(startChat).toHaveBeenCalledTimes(starts);
    expect(processLine).toHaveBeenCalledTimes(lines);
    expect(initializeProject).not.toHaveBeenCalled();
    expect(controller.getSnapshot().mode).toBe(chat ? 'chat' : 'home');
    submit('/init extra');
    expect(controller.getSnapshot().notice).toBe('/init accepts no arguments.');
    expect(initializeProject).not.toHaveBeenCalled();
    if (chat) {
      submit('/mode plan');
      await vi.waitFor(() => expect(processLine).toHaveBeenCalledTimes(lines + 1));
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
