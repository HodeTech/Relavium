import { createElement, useLayoutEffect } from 'react';
import { render, Text, useApp, useInput } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { invocationFixture } from '../process/invocation.test-support.js';
import { createSuspendPort, type SuspendPort } from '../render/suspend.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { SessionInkMount } from './session-ink-mount.js';
import { SessionInkInput } from './session-ink-input.js';
import { ChatApp } from '../render/tui/chat-ink.js';
import { createChatStore } from '../render/tui/chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';

function Mounted({
  port,
  exitReady,
}: {
  readonly port: SuspendPort;
  readonly exitReady?: (exit: (error: Error) => void) => void;
}) {
  const app = useApp();
  useInput(() => undefined);
  useLayoutEffect(() => {
    port.attach((body) => app.suspendTerminal(body));
    exitReady?.((error) => app.exit(error));
    return () => port.attach(undefined);
  }, [app, port, exitReady]);
  return createElement(Text, undefined, 'Synthetic owned session');
}

describe('installed Ink session suspension and final native release', () => {
  it('seals mounted ChatApp input while native teardown remains pending', async () => {
    const f = invocationFixture();
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    let enabled = true;
    let drain: () => void = () => undefined;
    const drained = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const suspend = vi.fn();
    const submit = vi.fn(() => Promise.resolve());
    const mode = vi.fn();
    const failure = vi.fn(() => f.invocation.finiteExit.fail('cli_internal'));
    const mount = new SessionInkMount({
      invocation: f.invocation,
      assertEntering: () => f.registry.assertAdmitting(),
      failure,
      suspendPort: createSuspendPort(),
      stopInput: () => {
        enabled = false;
      },
      drainNative: () => drained,
      input: new SessionInkInput({
        input,
        invocation: f.invocation,
        failure,
        acknowledge: () => Promise.resolve(),
      }),
    });
    const instance = mount.acquire(() =>
      render(
        createElement(ChatApp, {
          store,
          inputEnabled: () => enabled,
          onSubmit: submit,
          onModeChange: mode,
          onSuspend: suspend,
          onExit: () => undefined,
          onError: failure,
          shouldStop: () => false,
          suspendPort: mount.port,
        }),
        {
          stdin: input,
          stdout: output,
          stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      ),
    );
    try {
      await instance.waitUntilRenderFlush();
      input.push('\x1a');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(suspend).toHaveBeenCalledOnce(); // Positive proof that the installed input route is live.
      const closing = mount.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(input.isRaw).toBe(true); // Native teardown deliberately remains held with the tree mounted.
      input.push('\x1a');
      input.push('\x1b[Z');
      input.push('\x1b[200~SEALED_PASTE\x1b[201~');
      input.push('SEALED_SUBMIT\r');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await instance.waitUntilRenderFlush();
      expect(suspend, 'SESSION_CHAT_MOUNTED_INPUT_SEAL').toHaveBeenCalledOnce();
      expect(mode).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(output.frames.join('')).not.toContain('SEALED_PASTE');
      drain();
      await closing;
      expect(input.isRaw).toBe(false);
      expect(f.registry.activeOwners).toBe(0);
    } finally {
      drain();
      instance.unmount();
      input.destroy();
      output.destroy();
      stderr.destroy();
    }
  });
  it('restores captured input after installed Ink exits autonomously during a suspension', async () => {
    const f = invocationFixture();
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    const parent = createSuspendPort();
    let exit: (error: Error) => void = () => undefined;
    let finishBody: () => void = () => undefined;
    const body = new Promise<void>((resolve) => {
      finishBody = resolve;
    });
    const failure = vi.fn(() => f.invocation.finiteExit.fail('cli_internal'));
    const mount = new SessionInkMount({
      invocation: f.invocation,
      assertEntering: () => f.registry.assertAdmitting(),
      failure,
      suspendPort: parent,
      stopInput: () => undefined,
      drainNative: () => Promise.resolve(),
      input: new SessionInkInput({
        input,
        invocation: f.invocation,
        failure,
        acknowledge: (text) =>
          new Promise<void>((resolve, reject) => {
            output.write(text, (cause) =>
              cause === null || cause === undefined ? resolve() : reject(cause),
            );
          }),
      }),
    });
    const instance = mount.acquire(() =>
      render(
        createElement(Mounted, {
          port: mount.port,
          exitReady: (callback) => {
            exit = callback;
          },
        }),
        {
          stdin: input,
          stdout: output,
          stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
          alternateScreen: false,
        },
      ),
    );
    try {
      await instance.waitUntilRenderFlush();
      const suspended = parent.current()?.(() => body);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(input.isRaw).toBe(false);
      const primary = new Error('PRIVATE_INSTALLED_INK_EXIT');
      exit(primary);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(failure).toHaveBeenCalledWith(primary);
      finishBody();
      await suspended;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(input.isRaw, 'SESSION_INSTALLED_INK_AUTONOMOUS_EXIT_FINAL_RELEASE').toBe(false);
      expect(input.listenerCount('readable')).toBe(0);
      expect(f.registry.activeOwners).toBe(1); // Rejection itself is not a positive native exit ACK.
    } finally {
      finishBody();
      instance.unmount();
      input.destroy();
      output.destroy();
      stderr.destroy();
    }
  });

  it('joins installed endSuspend before unmount restores synthetic input for the last time', async () => {
    const f = invocationFixture();
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    const raw = vi.spyOn(input, 'setRawMode');
    const parent = createSuspendPort();
    let finishBody: () => void = () => undefined;
    const body = new Promise<void>((resolve) => {
      finishBody = resolve;
    });
    const failure = vi.fn(() => f.invocation.finiteExit.fail('cli_internal'));
    const mount = new SessionInkMount({
      invocation: f.invocation,
      assertEntering: () => f.registry.assertAdmitting(),
      failure,
      suspendPort: parent,
      stopInput: () => undefined,
      drainNative: () => {
        finishBody();
        return Promise.resolve();
      },
      input: new SessionInkInput({
        input,
        invocation: f.invocation,
        failure,
        acknowledge: (text) =>
          new Promise<void>((resolve, reject) => {
            output.write(text, (cause) =>
              cause === null || cause === undefined ? resolve() : reject(cause),
            );
          }),
      }),
    });
    const instance = mount.acquire(() =>
      render(createElement(Mounted, { port: mount.port }), {
        stdin: input,
        stdout: output,
        stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
        alternateScreen: false,
      }),
    );
    try {
      await instance.waitUntilRenderFlush();
      expect(input.isRaw).toBe(true);
      const suspend = parent.current();
      expect(suspend).toBeDefined();
      const suspended = suspend?.(() => body);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(input.isRaw).toBe(false);
      await mount.close();
      await suspended;
      await mount.exited;
      expect(
        raw.mock.calls.map(([enabled]) => enabled),
        'SESSION_INSTALLED_INK_FINAL_RAW_RELEASE',
      ).toEqual([true, false, true, false]);
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount('readable')).toBe(0);
      expect(parent.current()).toBeUndefined();
      expect(f.registry.activeOwners).toBe(0);
      expect(failure).not.toHaveBeenCalled();
      expect(f.exit).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
      input.destroy();
      output.destroy();
      stderr.destroy();
    }
  });
});
