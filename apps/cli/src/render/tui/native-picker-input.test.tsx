import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createHomeController } from './home-controller.js';
import { RootApp } from './home-app.js';
import { NativePromptHost } from './native-prompt-host.js';
import { createNativePromptChannel, NATIVE_PROMPT_CANCEL } from './native-prompt-channel.js';

/** Hold a real native write acknowledgement; no timing/performance threshold stands in for backpressure. */
class HeldOutput extends OwnedTtyOutput {
  holding = false;
  heldAck: (() => void) | undefined;
  constructor() {
    super();
    Object.defineProperty(this, '_writev', { value: undefined });
  }
  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (cause?: Error | null) => void,
  ): void {
    super._write(chunk, encoding, (cause) => {
      if (this.holding) this.heldAck = () => callback(cause);
      else callback(cause);
    });
  }
  release(): void {
    this.holding = false;
    const pending = this.heldAck;
    this.heldAck = undefined;
    pending?.();
  }
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe.each(['home', 'standalone'] as const)(
  'picker input under native backpressure in %s',
  (surface) => {
    describe.each([true, false])('alternate=%s', (alternate) => {
      it.each([true, false])(
        'retains edits while keeping result activation gated (color=%s)',
        async (color) => {
          const input = new OwnedTtyInput(),
            output = new HeldOutput(),
            stderr = new OwnedTtyOutput();
          output.columns = 80;
          output.rows = 24;
          const channel = createNativePromptChannel();
          const controller = createHomeController({
            startChat: () => Promise.reject(new Error('Unexpected chat submission')),
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
          const load = vi.fn((query: string) =>
            Promise.resolve({
              options: [{ value: query || 'initial', label: `Result ${query || 'initial'}` }],
            }),
          );
          let answer: Promise<string | symbol> | undefined;
          try {
            channel.flow.begin();
            answer = channel.flow.pick({ message: 'Resume a session', load });
            const chosen = vi.fn();
            void answer.then(chosen);
            await vi.waitFor(() => channel.ui.assertVisible(channel.ui.getSnapshot()));
            output.holding = true;
            input.push('a');
            await vi.waitFor(() => expect(channel.ui.getSnapshot().display).toBe('a'));
            await vi.waitFor(() => expect(output.heldAck).toBeDefined());
            for (const ch of 'bcd') {
              input.push(ch);
              await tick();
            }
            expect(channel.ui.getSnapshot().display).toBe('abcd');
            input.push('\x7f');
            await tick();
            input.push('\x1b[200~e\x1b[201~');
            await tick();
            expect(channel.ui.getSnapshot().display).toBe('abce');
            await vi.waitFor(() => expect(channel.ui.getSnapshot().picker?.loading).toBe(false));
            expect(() => channel.ui.assertVisible(channel.ui.getSnapshot())).toThrow();
            input.push('\x1b[B\t\x1b[6~\r');
            await tick();
            expect(chosen).not.toHaveBeenCalled();
            expect(channel.ui.getSnapshot().selected).toBe(0);
            expect(channel.ui.getSnapshot().picker?.allDirectories).toBe(false);
            expect(channel.ui.getSnapshot().picker?.page).toBe(1);
            output.columns = 40;
            output.emit('resize');
            input.push('HIDDEN\x1b[200~HIDDEN\x1b[201~');
            await tick();
            expect(channel.ui.getSnapshot().display).toBe('abce');
            output.columns = 80;
            output.emit('resize');
            output.release();
            await vi.waitFor(() => channel.ui.assertVisible(channel.ui.getSnapshot()));
            input.push('\r');
            expect(await answer).toBe('abce');
            await channel.flow.end();
            // A new card cannot inherit the earlier editor's evidence; cancellation still works without paint.
            output.holding = true;
            channel.flow.begin();
            answer = channel.flow.pick({ message: 'Resume a session', load });
            input.push('UNSEEN');
            await tick();
            expect(channel.ui.getSnapshot().display).toBe('');
            input.push('\x1b');
            expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
          } finally {
            output.release();
            channel.flow.cancel();
            await answer;
            await channel.flow.end();
            channel.ui.dispose();
            await controller.teardownActive();
            mounted.unmount();
            await mounted.waitUntilExit();
            input.destroy();
            output.destroy();
            stderr.destroy();
          }
        },
      );
    });
  },
);
