import './force-color.js';
import { render, type Instance } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { NativeInput, NativeOutput } from './fixtures/native-terminal.js';
import { flush, waitFor } from './harness-util.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/** Allow React's store commit, then await Ink's actual native-output acknowledgement. */
async function rendered(app: Instance): Promise<void> {
  await flush();
  await app.waitUntilRenderFlush();
}

describe.each([false, true])('native ChatApp geometry (color %s)', (color) => {
  it.each(
    [false, true].flatMap((alternateScreen) =>
      [0, Number.NaN].map((columns) => ({ alternateScreen, columns })),
    ),
  )(
    'recovers $columns width in alternate-screen=$alternateScreen',
    async ({ alternateScreen, columns }) => {
      const output = new NativeOutput();
      const input = new NativeInput();
      const store = createChatStore(
        color,
        undefined,
        alternateScreen ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
      );
      store.notice('ALREADYSHOWN');
      let aborted = 0;
      const app = render(
        <ChatApp
          store={store}
          onSubmit={() => Promise.resolve()}
          shouldStop={() => false}
          onExit={() => {}}
          onModeChange={() => {}}
          onAbort={() => {
            aborted++;
          }}
          onError={(error) => {
            throw error;
          }}
          alternateScreen={alternateScreen}
        />,
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
        app.unmount();
        await app.waitUntilExit();
        expect(output.listenerCount('resize')).toBe(0);
        expect(input.isRaw).toBe(false);
        output.destroy();
        input.destroy();
      }
    },
  );
});
