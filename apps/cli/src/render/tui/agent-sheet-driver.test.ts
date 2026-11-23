import { createSessionHandle, RunEventBus } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { boundAgentView } from '../../chat/bound-agent-view.js';
import { buildDefaultChatAgent } from '../../chat/default-agent.js';
import { SessionWorkOwner } from '../../chat/session-work-owner.js';
import { invocationFixture } from '../../process/invocation.test-support.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createSuspendPort } from '../suspend.js';
import { driveInk } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * The `/agent` sheet through the REAL ink driver (ADR-0140 §3): `driveInk` is what builds the `ChatApp` element from the driver context, so a
 * field the line handler produced and the context carried is dead unless that one passthrough forwards it. `agent-sheet-host.test.tsx`
 * mounts `ChatApp` with its props and cannot see it.
 */
describe('driveInk hands the bound-agent view to the chat it mounts', () => {
  it('a typed /agent opens the sheet over the driver’s own view, Esc closes it, and the chat then ends on /exit', async () => {
    const f = invocationFixture();
    const owner = new SessionWorkOwner(f.invocation, 'chat', {
      cancel: () => undefined,
      cleanup: () => Promise.resolve(),
    });
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const handle = createSessionHandle(
      new RunEventBus({ now: () => new Date(0).toISOString() }),
      'agent-sheet-driver',
      () => undefined,
      16,
      'subscribe-only',
    );
    const view = boundAgentView(
      buildDefaultChatAgent('claude-opus-4-8', 'high', 'anthropic'),
      'high',
    );
    const lines: string[] = [];
    let requestedExit = false;
    let activated = false;
    const driving = driveInk({
      workOwner: owner,
      suspendPort: createSuspendPort(),
      handle,
      store,
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
      boundAgent: () => view,
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
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect.poll(() => activated, { timeout: 5000 }).toBe(true);
      input.push('/agent');
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.push('\r');
      await expect
        .poll(() => output.frames.join('').includes('Agent · relavium-chat'), { timeout: 5000 })
        .toBe(true);
      expect(output.frames.join('')).toContain('claude-opus-4-8');
      expect(lines, 'the command opened the sheet and was not dispatched').toEqual([]);
      input.push('\u001b');
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      input.push('/exit');
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.push('\r');
      await expect.poll(() => lines, { timeout: 5000 }).toEqual(['/exit']);
      await driving;
    } finally {
      requestedExit = true;
      f.invocation.finiteExit.cooperativeCancel(4);
      await settled;
      await owner.close();
      input.destroy();
      output.destroy();
      stderr.destroy();
    }
    expect(f.registry.activeOwners).toBe(0);
  });
});
