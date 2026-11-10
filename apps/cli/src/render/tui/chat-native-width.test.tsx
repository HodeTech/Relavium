import './force-color.js';
import process from 'node:process';
import { render, type Instance } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { NativeInput, NativeOutput } from './fixtures/native-terminal.js';
import { flush, waitFor } from './harness-util.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/** Allow React's store commit, then await Ink's actual native-output acknowledgement. */
async function rendered(app: Instance): Promise<void> {
  await flush();
  await app.waitUntilRenderFlush();
}

describe.each([false, true])('native chat geometry (color %s)', (color) => {
  it.each(
    ['standalone', 'home'].flatMap((host) =>
      [false, true].flatMap((alternateScreen) =>
        [0, Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY].map((columns) => ({
          host,
          alternateScreen,
          columns,
        })),
      ),
    ),
  )(
    'recovers $columns width in $host alternate-screen=$alternateScreen',
    async ({ host, alternateScreen, columns }) => {
      const beforeExitListeners = process.listenerCount('beforeExit');
      const output = new NativeOutput();
      const input = new NativeInput();
      const store = createChatStore(
        color,
        undefined,
        alternateScreen ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
      );
      store.notice('ALREADYSHOWN');
      let aborted = 0;
      const abort = (): void => {
        aborted++;
      };
      const controller =
        host === 'home'
          ? createHomeController({
              startChat: () =>
                Promise.resolve({
                  store,
                  sessionId: 'native-width',
                  processLine: () => Promise.resolve(),
                  shouldStop: () => false,
                  stopReason: () => 'exit',
                  onAbort: abort,
                  teardown: () => Promise.resolve(),
                }),
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
              onError: (error) => {
                throw error;
              },
            })
          : undefined;
      const app = render(
        controller === undefined ? (
          <ChatApp
            store={store}
            onSubmit={() => Promise.resolve()}
            shouldStop={() => false}
            onExit={() => {}}
            onModeChange={() => {}}
            onAbort={abort}
            onError={(error) => {
              throw error;
            }}
            alternateScreen={alternateScreen}
          />
        ) : (
          <RootApp
            controller={controller}
            color={color}
            nowMs={() => 0}
            getSize={() => ({ cols: output.columns, rows: output.rows })}
            subscribeResize={(listener) => {
              output.on('resize', listener);
              return () => {
                output.off('resize', listener);
              };
            }}
            alternateScreen={alternateScreen}
          />
        ),
        {
          stdout: output,
          stderr: output,
          stdin: input,
          interactive: true,
          debug: false,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      try {
        if (controller !== undefined) {
          controller.handleKey('start', {});
          controller.handleKey('', { return: true });
          await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
        }
        await waitFor(() => output.chunks.join('').includes('ALREADYSHOWN'));
        await rendered(app);
        expect(output.chunks.join('')).toContain('ALREADYSHOWN');
        output.resize(columns);
        await rendered(app);
        const paused = output.chunks.length;
        store.notice('WAITINGFORWIDTH');
        await rendered(app);
        expect(output.chunks.slice(paused).join('')).not.toContain('WAITINGFORWIDTH');

        const beforeRecovery = output.chunks.length;
        output.resize(80);
        await waitFor(() =>
          output.chunks.slice(beforeRecovery).join('').includes('WAITINGFORWIDTH'),
        );
        await rendered(app);
        const recovery = output.chunks.slice(beforeRecovery).join('');
        expect(recovery.split('WAITINGFORWIDTH')).toHaveLength(2);
        if (!alternateScreen) expect(recovery).not.toContain('ALREADYSHOWN');
        await rendered(app);
        expect(output.chunks.slice(beforeRecovery).join('').split('WAITINGFORWIDTH')).toHaveLength(
          2,
        );

        store.apply({
          type: 'session:turn_started',
          sessionId: 'native-width',
          timestamp: '2026-11-10T00:00:00Z',
          sequenceNumber: 1,
        });
        output.resize(columns);
        await rendered(app);
        input.push(Buffer.from('\x1b'));
        await vi.waitFor(() => expect(aborted).toBe(1));
      } finally {
        // Register Ink's exit waiter while mounted so unmount removes its
        // beforeExit hook, rather than installing a new hook after cleanup.
        const exited = app.waitUntilExit();
        app.unmount();
        await exited;
        await controller?.teardownActive();
        expect(output.listenerCount('resize')).toBe(0);
        expect(input.isRaw).toBe(false);
        expect(process.listenerCount('beforeExit')).toBe(beforeExitListeners);
        output.destroy();
        input.destroy();
      }
    },
  );
});
