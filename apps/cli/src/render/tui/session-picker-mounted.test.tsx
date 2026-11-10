import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createChatStore } from './chat-store.js';
import { createHomeController } from './home-controller.js';
import { RootApp } from './home-app.js';
import { NativePromptHost } from './native-prompt-host.js';
import { createNativePromptChannel, NATIVE_PROMPT_CANCEL } from './native-prompt-channel.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

describe.each(['home', 'standalone'] as const)('mounted searchable picker in %s', (surface) => {
  describe.each([true, false])('alternate=%s', (alternate) => {
    it.each([true, false])(
      'fits 80x24, preserves its owner and refuses hidden selection (color=%s)',
      async (color) => {
        const input = new OwnedTtyInput(),
          output = new OwnedTtyOutput(),
          stderr = new OwnedTtyOutput();
        output.columns = 80;
        output.rows = 24;
        const channel = createNativePromptChannel();
        const store = createChatStore(
          color,
          undefined,
          alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
        );
        const session = {
          store,
          sessionId: 'live',
          processLine: async () => {},
          shouldStop: () => false,
          stopReason: () => 'exit' as const,
          teardown: async () => {},
        };
        const controller = createHomeController({
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
          doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
          onExit: () => {},
          onError: () => {},
        });
        const mounted = render(
          surface === 'home'
            ? createElement(RootApp, {
                controller,
                nativePrompt: channel.ui,
                nowMs: () => 0,
                color,
                alternateScreen: alternate,
                getSize: () => ({ cols: output.columns, rows: output.rows }),
                subscribeResize: (listener) => {
                  output.on('resize', listener);
                  return () => {
                    output.off('resize', listener);
                  };
                },
              })
            : createElement(NativePromptHost, { ui: channel.ui, color }),
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
        try {
          if (surface === 'home') {
            controller.handleKey('hi', {});
            controller.handleKey('', { return: true });
            await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
            store.appendUser('existing live conversation');
          }
          channel.flow.begin();
          const load = vi.fn(() =>
            Promise.resolve({
              options: Array.from({ length: 6 }, (_, n) => ({
                value: `saved-${n}`,
                label: `Session ${n} ${'very long title '.repeat(50)}`,
                hint: `/workspace/${'long-directory/'.repeat(30)}`,
              })),
            }),
          );
          const answer = channel.flow.pick({ message: 'Resume a session', load });
          await vi.waitFor(() => expect(channel.ui.getSnapshot().options).toHaveLength(6));
          await vi.waitFor(() => expect(output.frames.join('')).toContain('Session 0'));
          input.push('\x1b[200~' + 'q'.repeat(256) + '\x1b[201~');
          await vi.waitFor(() => expect(channel.ui.getSnapshot().display).toHaveLength(256));
          await vi.waitFor(() => expect(channel.ui.getSnapshot().options).toHaveLength(6));
          await vi.waitFor(() => expect(output.frames.at(-1)).not.toContain('cannot fit'));
          expect(channel.ui.getSnapshot().active).toBe(true);
          const invalidRenderStart = output.frames.length;
          input.push('\x1b[200~' + 'x'.repeat(257) + '\x1b[201~');
          await vi.waitFor(() => expect(channel.ui.getSnapshot().error).not.toBe(''));
          await vi.waitFor(() =>
            expect(output.frames.slice(invalidRenderStart).join('')).toContain('Edit filter'),
          );
          input.push('\x7f');
          await vi.waitFor(() => expect(channel.ui.getSnapshot().error).toBe(''));
          await vi.waitFor(() => expect(channel.ui.getSnapshot().options).toHaveLength(6));
          if (surface === 'home') expect(controller.getSnapshot().session?.store).toBe(store);
          output.columns = 40;
          output.emit('resize');
          await vi.waitFor(() => expect(output.frames.join('')).toContain('Terminal too small'));
          input.push('\r');
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          expect(channel.ui.getSnapshot().kind).toBe('picker');
          input.push('\x1b');
          expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
          await channel.flow.end();
          expect(channel.ui.getSnapshot().active).toBe(false);
          expect(stderr.frames.join('')).toBe('');
        } finally {
          channel.ui.dispose();
          mounted.unmount();
          await mounted.waitUntilExit();
          input.destroy();
          output.destroy();
          stderr.destroy();
        }
        expect(input.isRaw).toBe(false);
      },
    );
  });
});
