import { createSessionHandle, RunEventBus } from '@relavium/core';
import type { ReasoningEffort } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { SessionWorkOwner } from '../../chat/session-work-owner.js';
import type { SettingsPort } from '../../popups/settings-port.js';
import { invocationFixture } from '../../process/invocation.test-support.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createSuspendPort } from '../suspend.js';
import { driveInk } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * The stand-alone chat's driver hands its chat the settings port and binds the session's announcements to the chat's own channel while it is
 * mounted ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §6; MVP-11 step 5): the
 * real `driveInk` over an installed Ink, a typed bare `/effort` opens the popup (it never reaches the session's dispatch), and the announcer is
 * bound on mount, draws on the chat's hint row, and is unbound when the chat ends.
 */
describe('driveInk wires the settings popups and the announcer', () => {
  it('a typed bare /effort opens the popup; the announcer is bound while mounted, drawn on the hint row, and unbound at the end', async () => {
    const f = invocationFixture();
    const owner = new SessionWorkOwner(f.invocation, 'chat', {
      cancel: () => undefined,
      cleanup: () => Promise.resolve(),
    });
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const bus = new RunEventBus({ now: () => new Date(0).toISOString() });
    const handle = createSessionHandle(
      bus,
      'settings-drive',
      () => undefined,
      16,
      'subscribe-only',
    );
    const lines: string[] = [];
    let requestedExit = false;
    let activated = false;
    const bound: (((text: string) => void) | undefined)[] = [];
    const setAnnouncer = vi.fn((announce: ((text: string) => void) | undefined) => {
      bound.push(announce);
    });
    const applied: ReasoningEffort[] = [];
    const settings: SettingsPort = {
      surface: 'standalone-chat',
      announce: (text) => bound.at(-1)?.(text),
      effort: {
        model: () => 'claude-sonnet-4-6',
        tiers: () => ['low', 'medium', 'high'],
        current: () => 'low',
        apply: (effort) => applied.push(effort),
      },
    };
    const driving = driveInk({
      workOwner: owner,
      handle,
      store,
      suspendPort: createSuspendPort(),
      subscribeInterrupt: () => () => undefined,
      startSession: () => undefined,
      onActivated: () => {
        activated = true;
      },
      processLine: (line) => {
        lines.push(line);
        if (line === '/exit') requestedExit = true;
        return Promise.resolve();
      },
      shouldStop: () => requestedExit,
      stopReason: () => 'exit',
      settings,
      setAnnouncer,
      io: {
        env: {},
        stdoutIsTty: true,
        stdinIsTty: true,
        stdin: input,
        nativeStdin: input,
        nativeStdout: output,
        nativeStderr: stderr,
        writeOut: (text) => {
          output.write(text);
        },
        writeErr: (text) => {
          stderr.write(text);
        },
        writeOutAcknowledged: (text) =>
          new Promise<void>((resolve, reject) => {
            output.write(text, (cause) =>
              cause === null || cause === undefined ? resolve() : reject(cause),
            );
          }),
        writeErrAcknowledged: (text) =>
          new Promise<void>((resolve, reject) => {
            stderr.write(text, (cause) =>
              cause === null || cause === undefined ? resolve() : reject(cause),
            );
          }),
      },
      global: {
        configPath: undefined,
        cwd: process.cwd(),
        json: false,
        color: false,
        verbosity: 'normal',
        noAltScreen: true,
      },
    });
    const settled = driving.then(
      () => undefined,
      () => undefined,
    );
    try {
      await vi.waitFor(() => expect(activated).toBe(true));
      await vi.waitFor(() => expect(setAnnouncer).toHaveBeenCalled());
      expect(typeof bound.at(-1)).toBe('function');
      input.push('/effort');
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.push('\r');
      await vi.waitFor(() => expect(output.frames.join('')).toContain('brief reasoning · current'));
      expect(lines).toEqual([]); // the line never reached the session's dispatch
      // What the session announces is drawn on the chat's own hint row (the chat's channel), not written into the transcript.
      bound.at(-1)?.('Reasoning effort: high · applies to the next message');
      input.push('\u001b'); // Esc closes the popup; the notification is on the hint row
      await vi.waitFor(() =>
        expect(output.frames.join('')).toContain(
          'Reasoning effort: high · applies to the next message',
        ),
      );
      expect(store.getSnapshot().state.transcript).toEqual([]);
      expect(applied).toEqual([]);
      input.push('/exit');
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.push('\r');
      await vi.waitFor(() => expect(lines).toEqual(['/exit']));
      await driving;
      // Unbound when the chat unmounted: a late announcement reaches nothing.
      expect(bound.at(-1)).toBeUndefined();
    } finally {
      requestedExit = true;
      await settled;
    }
  });
});
