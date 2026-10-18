import { createSessionHandle, RunEventBus } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { SessionWorkOwner } from '../../chat/session-work-owner.js';
import { CliError } from '../../process/cli-error.js';
import { invocationFixture } from '../../process/invocation.test-support.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createSuspendPort } from '../suspend.js';
import { driveInk } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import type { MentionCandidate } from './mention.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

describe('installed chat asynchronous publication during native suspension', () => {
  it.each([
    { kind: 'shell', stopped: false },
    { kind: 'shell', stopped: true },
    { kind: 'mention', stopped: false },
    { kind: 'mention', stopped: true },
  ])('$kind preserves live reporting and respects stop=$stopped', async ({ kind, stopped }) => {
    const f = invocationFixture();
    const owner = new SessionWorkOwner(f.invocation, 'chat', {
      cancel: () => undefined,
      cleanup: () => Promise.resolve(),
    });
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    const port = createSuspendPort();
    let release = (): void => undefined;
    const body = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refuse: (cause: unknown) => void = () => undefined;
    const raw = new Promise<never>((_resolve, reject) => {
      refuse = reject;
    });
    void raw.catch(() => undefined); // Cleanup may refuse a fixture before its shell entry is reached.
    const runner = vi.fn(() => owner.enter(() => raw));
    let finishList: (candidates: readonly MentionCandidate[]) => void = () => undefined;
    const listing = new Promise<readonly MentionCandidate[]>((resolve) => {
      finishList = resolve;
    });
    const list = vi.fn(() => listing);
    const read = vi.fn(() => Promise.resolve({ content: 'Unused fixture', sizeBytes: 14 }));
    const candidate: MentionCandidate = {
      name: 'arriving-candidate.ts',
      path: 'arriving-candidate.ts',
      type: 'file',
    };
    const bus = new RunEventBus({ now: () => new Date(0).toISOString() });
    const handle = createSessionHandle(
      bus,
      'owned-completion-publication',
      () => undefined,
      16,
      'subscribe-only',
    );
    const primary = new Error('PRIVATE_ORIGINAL_COMPLETION_STOP');
    const refusal = new CliError('invalid_invocation', 'PRIVATE_CLASSIFIED_SHELL_REFUSAL');
    const warning = '! shell command failed unexpectedly';
    const marker = kind === 'shell' ? warning : candidate.name;
    let activated = false;
    let requestedExit = false;
    const driving = driveInk({
      workOwner: owner,
      handle,
      store,
      suspendPort: port,
      subscribeInterrupt: () => () => undefined,
      startSession: () => undefined,
      onActivated: () => {
        activated = true;
      },
      processLine: () => {
        requestedExit = true;
        return Promise.resolve();
      },
      shouldStop: () => requestedExit,
      stopReason: () => 'exit',
      runShellCommand: runner,
      mentionReader: { list, read },
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
    // Retain both outcomes immediately; cleanup must join the actual driver even if an assertion fails.
    const settled = driving.then(
      () => undefined,
      () => undefined,
    );
    let suspended: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(activated).toBe(true));
      if (kind === 'shell') {
        input.push('!synthetic');
        await new Promise<void>((resolve) => setImmediate(resolve));
        input.push('\r');
        await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
        expect(list).not.toHaveBeenCalled();
      } else {
        input.push('@');
        await vi.waitFor(() => expect(list).toHaveBeenCalledExactlyOnceWith(''));
        expect(runner).not.toHaveBeenCalled();
      }
      const suspend = port.current();
      if (suspend === undefined) throw new Error('Installed chat suspension was not attached.');
      suspended = suspend(() => body);
      await vi.waitFor(() => expect(input.isRaw).toBe(false));
      if (stopped) {
        owner.failure(primary);
        expect(f.registry.observations.exitCode()).toBe(9);
        expect(owner.firstFailure?.cause).toBe(primary);
        expect(port.current()).toBeUndefined();
      }
      const frameIndex = output.frames.length;
      if (kind === 'shell') {
        refuse(refusal);
        await raw.catch(() => undefined);
      } else {
        finishList([candidate]);
        await listing;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.registry.activeOwners).toBeGreaterThan(0);
      expect(output.frames.slice(frameIndex).join('')).not.toContain(marker);
      release();
      await suspended; // Actual installed Ink endSuspend redraws before the final native unmount.
      if (stopped) {
        await driving;
        expect(
          output.frames.slice(frameIndex).join(''),
          kind === 'shell' ? 'SESSION_STOPPED_SHELL_RENDER' : 'SESSION_STOPPED_MENTION_RENDER',
        ).not.toContain(marker);
        if (kind === 'shell')
          expect(store.getSnapshot().state.warnings, 'SESSION_STOPPED_SHELL_NOTICE').not.toContain(
            warning,
          );
        expect(f.registry.observations.exitCode()).toBe(9);
        expect(owner.firstFailure?.cause).toBe(primary);
      } else {
        await vi.waitFor(() => expect(output.frames.slice(frameIndex).join('')).toContain(marker));
        if (kind === 'shell') expect(store.getSnapshot().state.warnings).toContain(warning);
        expect(f.registry.observations.exitCode()).toBe(0);
        expect(owner.firstFailure).toBeUndefined();
        if (kind === 'shell') {
          input.push('/exit');
          await new Promise<void>((resolve) => setImmediate(resolve));
          input.push('\r');
        } else {
          f.invocation.finiteExit.cooperativeCancel(4);
        }
        await driving;
      }
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount('readable')).toBe(0);
      expect(port.current()).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
      expect(output.frames.join('') + stderr.frames.join('')).not.toContain('PRIVATE_');
    } finally {
      refuse(refusal);
      finishList([]);
      release();
      await suspended;
      f.invocation.finiteExit.cooperativeCancel(4);
      await settled;
      await owner.close();
      input.destroy();
      output.destroy();
      stderr.destroy();
    }
    expect(f.registry.activeOwners).toBe(0);
    expect(f.exit).not.toHaveBeenCalled();
  });
});
