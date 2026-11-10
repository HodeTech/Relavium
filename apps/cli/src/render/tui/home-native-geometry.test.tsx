import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoticeFlush } from '../../engine/effect-retention.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createChatStore } from './chat-store.js';
import { createHomeController } from './home-controller.js';
import { RootApp } from './home-app.js';
import { createNativePromptChannel, NATIVE_PROMPT_CANCEL } from './native-prompt-channel.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

describe.each([true, false])('native Home geometry alternate=%s', (alternate) => {
  it.each([true, false])(
    'keeps the chat owner while invalid geometry blocks consent, color=%s',
    async (color) => {
      const input = new OwnedTtyInput(),
        output = new OwnedTtyOutput(),
        stderr = new OwnedTtyOutput();
      output.columns = 80;
      output.rows = 24;
      const store = createChatStore(
        color,
        undefined,
        alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
      );
      const session = {
        store,
        sessionId: 'id',
        processLine: async () => {},
        shouldStop: () => false,
        stopReason: () => 'exit' as const,
        teardown: async () => {},
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
        onExit: () => {},
        onError: () => {},
      });
      const channel = createNativePromptChannel();
      let flush: NoticeFlush | undefined;
      const instance = render(
        createElement(RootApp, {
          controller,
          nativePrompt: channel.ui,
          nowMs: () => 0,
          color,
          getSize: () => ({ cols: output.columns, rows: output.rows }),
          subscribeResize: (cb) => {
            output.on('resize', cb);
            return () => {
              output.off('resize', cb);
            };
          },
          alternateScreen: alternate,
          onRendererReady: (ready) => {
            flush = ready;
          },
        }),
        {
          stdin: input,
          stdout: output,
          stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
          alternateScreen: alternate,
        },
      );
      cleanup.push(() => {
        channel.ui.dispose();
        instance.unmount();
        input.destroy();
        output.destroy();
        stderr.destroy();
      });
      controller.handleKey('h', {});
      controller.handleKey('i', {});
      controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
      store.appendUser('visible prior transcript');
      channel.flow.begin();
      const answer = channel.flow.select({
        message: 'Allow source?',
        options: [{ value: 'yes', label: 'Yes' }],
      });
      await vi.waitFor(() => expect(output.frames.join('')).toContain('Allow source?'));
      output.columns = 0.5;
      output.emit('resize');
      input.push('\r');
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      expect(channel.ui.getSnapshot().kind).toBe('select');
      expect(controller.getSnapshot().session?.store).toBe(store);
      expect(flush).toBeDefined();
      if (!flush) throw new Error('missing flush');
      const waiting = flush(() => channel.flow.note('Saving preferences removes comments.'));
      let done = false;
      void waiting.then(
        () => {
          done = true;
        },
        () => {},
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      expect(done).toBe(false);
      output.columns = 80;
      output.emit('resize');
      await waiting;
      expect(output.frames.join('')).toContain('Saving preferences removes comments.');
      channel.flow.cancel();
      expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
      await channel.flow.end();
      expect(JSON.stringify(store.getSnapshot().state.transcript)).toContain(
        'visible prior transcript',
      );
    },
  );
});

describe.each([true, false])('bare Home model rewrite visibility alternate=%s', (alternate) => {
  it.each([true, false])(
    'flushes a complete busy card with the picker retained, color=%s',
    async (color) => {
      const input = new OwnedTtyInput(),
        output = new OwnedTtyOutput(),
        stderr = new OwnedTtyOutput();
      output.columns = 80;
      output.rows = 24;
      const channel = createNativePromptChannel();
      let flush: NoticeFlush | undefined;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acknowledged = false;
      let effective: string | undefined;
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
        onExit: () => {},
        onError: () => {},
        models: {
          load: () => ({
            entries: [
              {
                modelId: 'fixture-model',
                provider: 'openai',
                displayName: 'Fixture model',
                pricingSource: 'catalog',
                priceKnown: true,
                available: true,
                deprecated: false,
              },
            ],
            refreshedAt: undefined,
          }),
          refreshIfStale: () => Promise.resolve(undefined),
          refresh: () => Promise.resolve({ providers: [] }),
          currentDefault: () => effective,
          currentEffort: () => undefined,
          writeDefault: async (id) => {
            channel.flow.begin();
            channel.flow.busy('Saving preferences…');
            if (!flush) throw new Error('missing flush');
            await flush(() =>
              channel.flow.note(
                'Saving preferences rewrites the global config and removes its comments and ordering.',
              ),
            );
            channel.ui.assertVisible(channel.ui.getSnapshot());
            acknowledged = true;
            await held;
            effective = id;
            await channel.flow.end();
            return { durability: 'confirmed' };
          },
        },
      });
      const instance = render(
        createElement(RootApp, {
          controller,
          nativePrompt: channel.ui,
          nowMs: () => 0,
          color,
          getSize: () => ({ cols: output.columns, rows: output.rows }),
          subscribeResize: (cb) => {
            output.on('resize', cb);
            return () => {
              output.off('resize', cb);
            };
          },
          alternateScreen: alternate,
          onRendererReady: (ready) => {
            flush = ready;
          },
        }),
        {
          stdin: input,
          stdout: output,
          stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
          alternateScreen: alternate,
        },
      );
      cleanup.push(() => {
        channel.ui.dispose();
        instance.unmount();
        input.destroy();
        output.destroy();
        stderr.destroy();
      });
      await vi.waitFor(() => expect(flush).toBeDefined());
      for (const ch of '/models') controller.handleKey(ch, {});
      controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(controller.getSnapshot().modelPicker).toBeDefined());
      const picker = controller.getSnapshot().modelPicker;
      controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(acknowledged).toBe(true));
      expect(controller.getSnapshot().modelPicker).toBe(picker);
      expect(output.frames.join('')).toContain(
        'Saving preferences rewrites the global config and removes its comments and',
      );
      expect(output.frames.join('')).toContain('ordering.');
      release();
      await vi.waitFor(() => expect(controller.getSnapshot().modelPicker).toBeUndefined());
      expect(effective).toBe('fixture-model');
    },
  );
});
