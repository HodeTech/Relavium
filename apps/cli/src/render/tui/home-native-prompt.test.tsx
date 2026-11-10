import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativePromptChannel, NATIVE_PROMPT_CANCEL } from './native-prompt-channel.js';
import { createHomeController } from './home-controller.js';
import { RootApp } from './home-app.js';
import { createChatStore } from './chat-store.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { bracketed, settleFrames, waitFor } from './harness-util.js';

afterEach(cleanup);
describe('Home native prompt custody', () => {
  it.each([true, false])(
    'keeps prompt bytes out of Home and consumes a coalesced cancel, color=%s',
    async (color) => {
      const channel = createNativePromptChannel();
      const controller = createHomeController({
        doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
        startChat: () => {
          throw new Error('unexpected chat');
        },
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
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      const h = render(
        <RootApp
          controller={controller}
          nativePrompt={channel.ui}
          nowMs={() => 0}
          color={color}
          getSize={() => ({ cols: 80, rows: 24 })}
          subscribeResize={() => () => {}}
        />,
      );
      channel.flow.begin();
      const answer = channel.flow.password({ message: 'Secret key' });
      await waitFor(() => (h.lastFrame() ?? '').includes('Secret key'));
      h.stdin.write(bracketed('secret-value-4829'));
      await waitFor(() => channel.ui.getSnapshot().display !== '');
      h.stdin.write('\x1bsecret-suffix');
      expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
      await channel.flow.end();
      await settleFrames();
      expect(JSON.stringify(controller.getSnapshot())).not.toContain('secret');
      expect(h.lastFrame()).not.toContain('4829');
      expect(h.lastFrame()).not.toContain('suffix');
      channel.ui.dispose();
    },
  );
  it.each([true, false])(
    'keeps the chat owner mounted while prompting, alternate=%s',
    async (alternate) => {
      const channel = createNativePromptChannel();
      const store = createChatStore(
        false,
        undefined,
        alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
      );
      const session = {
        store,
        sessionId: 'id',
        processLine: async () => {},
        shouldStop: () => false,
        stopReason: () => 'exit' as const,
        teardown: () => Promise.resolve(),
      };
      const controller = createHomeController({
        doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
        startChat: () => Promise.resolve(session),
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
        onExit: vi.fn(),
        onError: vi.fn(),
      });
      let resize = () => {};
      let width = 80;
      const h = render(
        <RootApp
          controller={controller}
          nativePrompt={channel.ui}
          nowMs={() => 0}
          color={false}
          alternateScreen={alternate}
          getSize={() => ({ cols: width, rows: 24 })}
          subscribeResize={(callback) => {
            resize = callback;
            return () => {};
          }}
        />,
      );
      controller.handleKey('h', {});
      controller.handleKey('i', {});
      controller.handleKey('', { return: true });
      await waitFor(() => controller.getSnapshot().mode === 'chat');
      store.appendUser('existing transcript');
      channel.flow.begin();
      const answer = channel.flow.password({ message: 'Enter key' });
      await waitFor(() => (h.lastFrame() ?? '').includes('Enter key'));
      expect(controller.getSnapshot().session?.store).toBe(store);
      width = 60;
      resize();
      await settleFrames();
      expect(controller.getSnapshot().session?.store).toBe(store);
      expect(h.lastFrame()).toContain('Enter key');
      channel.flow.cancel();
      expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
      await channel.flow.end();
      await settleFrames();
      expect(controller.getSnapshot().session?.store).toBe(store);
      expect(JSON.stringify(store.getSnapshot().state.transcript)).toContain('existing transcript');
      channel.ui.dispose();
    },
  );
});
