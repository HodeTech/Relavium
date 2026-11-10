import { render } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createChatStore } from './chat-store.js';
import { createHomeController } from './home-controller.js';
import { RootApp } from './home-app.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

describe.each([true, false])('Continue prompt edits alternate=%s', (alternate) => {
  it.each(['typed', 'pasted'] as const)(
    'submits %s text without resuming the previously focused row',
    async (kind) => {
      const input = new OwnedTtyInput(),
        output = new OwnedTtyOutput(),
        stderr = new OwnedTtyOutput();
      output.columns = 80;
      output.rows = 24;
      const processLine = vi.fn(() => Promise.resolve());
      const bound = alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND;
      const fresh = {
        sessionId: 'fresh',
        store: createChatStore(false, undefined, bound),
        processLine,
        shouldStop: () => false,
        stopReason: () => 'exit' as const,
        teardown: () => Promise.resolve(),
      };
      const resume = vi.fn(() =>
        Promise.resolve({
          ...fresh,
          sessionId: 'saved',
          store: createChatStore(false, undefined, bound),
        }),
      );
      const start = vi.fn(() => Promise.resolve(fresh));
      const controller = createHomeController({
        startChat: start,
        resumeChat: resume,
        homeStore: {
          read: () => ({
            attention: { gates: [], failedRuns: [] },
            recentSessions: [
              {
                sessionId: 'saved',
                title: 'Saved conversation',
                workingDir: '/workspace',
                agentSlug: 'chat',
                modelId: undefined,
                status: 'ended',
                updatedAt: '2026-11-10T00:00:00.000Z',
                totalCostMicrocents: 0,
              },
            ],
            recentRuns: [],
            recentAgents: [],
            unreadableRunIds: [],
            isEmpty: false,
          }),
        },
        doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
        onExit: () => {},
        onError: () => {},
      });
      const mounted = render(
        <RootApp
          controller={controller}
          color={false}
          nowMs={() => 0}
          alternateScreen={alternate}
          getSize={() => ({ cols: 80, rows: 24 })}
          subscribeResize={() => () => {}}
        />,
        {
          stdin: input,
          stdout: output,
          stderr,
          interactive: true,
          alternateScreen: alternate,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      try {
        await vi.waitFor(() => expect(output.frames.join('')).toContain('Saved conversation'));
        input.push('\x1b[B');
        await vi.waitFor(() => expect(controller.getSnapshot().continueSessionId).toBe('saved'));
        const text = kind === 'pasted' ? 'my prompt\nsecond line' : 'my typed prompt';
        input.push(kind === 'pasted' ? '\x1b[200~my prompt\r\nsecond line\x1b[201~' : text);
        await vi.waitFor(() => expect(controller.getSnapshot().input.text).toBe(text));
        expect(controller.getSnapshot().continueSessionId).toBeUndefined();
        input.push('\r');
        await vi.waitFor(() => expect(processLine).toHaveBeenCalledWith(text, text));
        expect(start).toHaveBeenCalledOnce();
        expect(resume).not.toHaveBeenCalled();
        expect(controller.getSnapshot().session?.sessionId).toBe('fresh');
      } finally {
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
