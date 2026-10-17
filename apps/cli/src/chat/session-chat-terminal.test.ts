import { describe, expect, it, vi } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { EXIT_ALT_SCREEN } from '../render/alt-screen.js';
import { SessionChatLifetime } from './session-chat-lifetime.js';
import { SessionChatTerminal } from './session-chat-terminal.js';
import { SessionInkMount } from './session-ink-mount.js';
import { CliError } from '../process/cli-error.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(write?: (text: string) => Promise<void>) {
  const f = invocationFixture();
  const lifetime = new SessionChatLifetime(f.invocation, {
    onInterrupt: () => () => undefined,
    onTerminationSignal: () => () => undefined,
  });
  const captured = captureIo();
  const writes: string[] = [];
  const terminal = new SessionChatTerminal({
    lifetime,
    active: true,
    mouse: true,
    io: {
      ...captured.io,
      writeOutAcknowledged: (text) => {
        writes.push(text);
        return write?.(text) ?? Promise.resolve();
      },
    },
  });
  const remove = vi.fn();
  terminal.enter(() => remove);
  return { ...f, lifetime, terminal, writes, remove };
}

describe('persistent chat terminal and actual child mounts', () => {
  it('retains a partially registered exit fallback without acknowledging terminal cleanup', async () => {
    const f = invocationFixture();
    const lifetime = new SessionChatLifetime(f.invocation, {
      onInterrupt: () => () => undefined,
      onTerminationSignal: () => () => undefined,
    });
    const captured = captureIo();
    const write = vi.fn(() => Promise.resolve());
    const terminal = new SessionChatTerminal({
      lifetime,
      active: true,
      mouse: true,
      io: { ...captured.io, writeOutAcknowledged: write },
    });
    const cause = new TypeError('PRIVATE_PARTIAL_EXIT_REGISTRATION');
    let fallback: (() => void) | undefined;
    expect(() =>
      terminal.enter((callback) => {
        fallback = callback; // Registration happened; the API threw before returning its remover.
        throw cause;
      }),
    ).toThrow(cause);
    expect(lifetime.surface.work.firstFailure?.cause).toBe(cause);
    expect(lifetime.surface.work.hasCleanupUncertainty).toBe(true);
    expect(f.registry.observations.exitCode()).toBe(9);
    let acknowledged = false;
    void terminal.close().then(() => {
      acknowledged = true;
    });
    await turn();
    expect(write.mock.calls.flat().join('')).toContain(EXIT_ALT_SCREEN);
    const enteredWrites = write.mock.calls.length;
    if (fallback === undefined) throw new Error('missing partially registered exit fallback');
    expect(fallback).not.toThrow();
    await turn();
    expect(write).toHaveBeenCalledTimes(enteredWrites); // Exit fallback starts no async delivery.
    expect(acknowledged, 'CHAT_PARTIAL_EXIT_REGISTRATION_NOT_ACK').toBe(false);
    expect(f.registry.activeOwners).toBe(2);
    expect(lifetime.surface.work.firstFailure?.cause).toBe(cause);
    expect(captured.out() + captured.err()).not.toContain(cause.message);
    f.advance(3000);
    await turn();
    expect(f.exit).toHaveBeenCalledWith(9);
    expect(acknowledged).toBe(false);
    expect(f.registry.activeOwners).toBe(2);
  });

  it('preserves output failure immediately while a sibling native mount remains held', async () => {
    const held = gate();
    const f = fixture(() => Promise.reject(new CliError('output_unavailable', '')));
    const nativeExit = gate();
    const mount = new SessionInkMount({
      invocation: f.invocation,
      assertEntering: f.lifetime.surface.work.assertAdmitting,
      failure: f.lifetime.surface.work.failure,
      suspendPort: f.lifetime.suspendPort,
      stopInput: () => undefined,
      drainNative: () => held.promise,
    });
    f.terminal.adoptMount(mount);
    mount.acquire(() => ({ unmount: nativeExit.release, waitUntilExit: () => nativeExit.promise }));
    await turn();
    expect(
      f.registry.observations.infrastructureCode(),
      'CHAT_CONTROL_OUTPUT_FAILURE_BEFORE_HELD_JOIN',
    ).toBe('output_unavailable');
    expect(f.registry.activeOwners).toBe(3);
    held.release();
  });

  it('refuses final publication when an already-entered restoration ACK arrives after expiry', async () => {
    const delivery = gate();
    const f = fixture((text) =>
      text.includes(EXIT_ALT_SCREEN) ? delivery.promise : Promise.resolve(),
    );
    f.invocation.finiteExit.fail('cli_internal');
    const closing = f.terminal.close();
    await turn();
    expect(f.writes.join('')).toContain(EXIT_ALT_SCREEN);
    f.advance(3000);
    delivery.release();
    await closing;
    const prior = [...f.writes];
    expect(
      () => f.terminal.publishOut('late summary'),
      'CHAT_NO_FINAL_PUBLICATION_AFTER_EXPIRY',
    ).toThrow(CliError);
    expect(() => f.terminal.publishErr('late error')).toThrow(CliError);
    expect(f.writes).toEqual(prior);
  });
  it('drains the full native mount before delivering final alternate-screen restoration', async () => {
    const f = fixture();
    const held = gate();
    const nativeExit = gate();
    const unmount = vi.fn(nativeExit.release);
    const mount = new SessionInkMount({
      invocation: f.invocation,
      assertEntering: f.lifetime.surface.work.assertAdmitting,
      failure: f.lifetime.surface.work.failure,
      suspendPort: f.lifetime.suspendPort,
      stopInput: () => undefined,
      drainNative: () => held.promise,
    });
    f.terminal.adoptMount(mount);
    mount.acquire(() => ({ unmount, waitUntilExit: () => nativeExit.promise }));
    const closing = f.terminal.close();
    await turn();
    expect(unmount).not.toHaveBeenCalled();
    expect(f.writes.join(''), 'CHAT_FINAL_RESTORE_AFTER_ALL_NATIVE_MOUNTS').not.toContain(
      EXIT_ALT_SCREEN,
    );
    held.release();
    await closing;
    expect(unmount).toHaveBeenCalledOnce();
    expect(f.writes.join('')).toContain(EXIT_ALT_SCREEN);
    expect(f.remove).toHaveBeenCalledOnce();
    await f.lifetime.surface.work.close();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('keeps final delivery owed after the control sequence was enqueued', async () => {
    const delivered = gate();
    const f = fixture((text) =>
      text.includes(EXIT_ALT_SCREEN) ? delivered.promise : Promise.resolve(),
    );
    let restored = false;
    const closing = f.terminal.close().then(() => {
      restored = true;
    });
    await turn();
    expect(f.writes.join('')).toContain(EXIT_ALT_SCREEN);
    expect(restored, 'CHAT_FINAL_CONTROL_DELIVERY_REQUIRED').toBe(false);
    expect(f.remove).not.toHaveBeenCalled();
    delivered.release();
    await closing;
    expect(f.remove).toHaveBeenCalledOnce();
    await f.lifetime.surface.work.close();
  });

  it('starts every job finish before waiting and retains a failed restore under the original budget', async () => {
    const cause = new Error('PRIVATE_CONTROL_DELIVERY');
    const f = fixture((text) =>
      text.includes(EXIT_ALT_SCREEN) ? Promise.reject(cause) : Promise.resolve(),
    );
    const finishes: ReturnType<typeof vi.fn>[] = [];
    for (let index = 0; index < 2; index++) {
      const native = gate();
      const finish = vi.fn(() => {
        native.release();
        return native.promise;
      });
      finishes.push(finish);
      f.terminal.adoptJob({
        requestSuspend: vi.fn(),
        dispose: vi.fn(),
        finish,
        released: native.promise,
      });
    }
    let acknowledged = false;
    void f.terminal.close().then(() => {
      acknowledged = true;
    });
    await turn();
    for (const finish of finishes) expect(finish).toHaveBeenCalledOnce();
    expect(acknowledged).toBe(false);
    expect(f.registry.observations.exitCode()).toBe(9);
    f.advance(3000);
    await turn();
    expect(f.exit).toHaveBeenCalledWith(9);
  });

  it('does not start a new asynchronous restore after the original budget expires', async () => {
    const f = fixture();
    const held = gate();
    const native = gate();
    f.terminal.adoptJob({
      requestSuspend: vi.fn(),
      dispose: vi.fn(),
      finish: () => {
        native.release();
        return held.promise;
      },
      released: native.promise,
    });
    f.invocation.finiteExit.fail('cli_internal');
    const closing = f.terminal.close();
    void closing;
    await turn();
    f.advance(3000);
    held.release();
    await turn();
    expect(f.writes.join(''), 'CHAT_NO_NEW_CONTROL_AFTER_ORIGINAL_EXPIRY').not.toContain(
      EXIT_ALT_SCREEN,
    );
    expect(f.exit).toHaveBeenCalledWith(9);
  });
});
