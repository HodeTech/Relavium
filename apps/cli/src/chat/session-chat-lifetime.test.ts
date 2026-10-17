import { describe, expect, it, vi } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { SessionChatLifetime } from './session-chat-lifetime.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const f = invocationFixture();
  let interrupt: () => void = () => undefined;
  let termination: (signo: number) => void = () => undefined;
  const removeInterrupt = vi.fn();
  const removeTermination = vi.fn();
  const chat = new SessionChatLifetime(f.invocation, {
    onInterrupt: (callback) => {
      interrupt = callback;
      return removeInterrupt;
    },
    onTerminationSignal: (callback) => {
      termination = callback;
      return removeTermination;
    },
  });
  return {
    ...f,
    chat,
    interrupt: () => interrupt(),
    termination: (signo: number) => termination(signo),
    removeInterrupt,
    removeTermination,
  };
}

describe('original chat invocation and shared database tail', () => {
  it('joins all actual host roots before closing the shared database once', async () => {
    const f = fixture();
    const held = gate();
    const closeDb = vi.fn();
    f.chat.adoptStore({ close: closeDb });
    const run = f.chat.execute(async () => {
      await f.chat.hosts.construct((host) => {
        void host.work.enter(() => held.promise);
        return Promise.resolve();
      });
      return 4;
    });
    await turn();
    expect(closeDb, 'CHAT_ALL_HOSTS_BEFORE_SHARED_DB_CLOSE').not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(2);
    held.release();
    expect(await run).toBe(4);
    expect(closeDb).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.removeInterrupt).toHaveBeenCalledOnce();
    expect(f.removeTermination).toHaveBeenCalledOnce();
  });

  it('keeps cooperative force-end4 after the old driver listener was removed during held cleanup', async () => {
    const f = fixture();
    const held = gate();
    const first = vi.fn();
    const remove = f.chat.subscribeInterrupt(first);
    const run = f.chat.execute(async () => {
      await held.promise;
      return 4;
    });
    f.interrupt();
    expect(first).toHaveBeenCalledOnce();
    expect(f.registry.termination).toBeUndefined();
    remove();
    f.interrupt();
    expect(f.registry.observations.hasTerminatingSignal()).toBe(false);
    expect(f.registry.observations.exitCode()).toBe(4);
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(f.exit, 'CHAT_POST_DRIVER_FORCE_END_RETAINS_COOPERATIVE_4').not.toHaveBeenCalled();
    held.release();
    expect(await run).toBe(4);
    expect(await f.invocation.finiteExit.exited).toBe(4);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('yields SIGINT to an actual entered hatch without starting shutdown or consuming cooperative cancellation', async () => {
    const f = fixture();
    const body = gate();
    const listener = vi.fn();
    const remove = f.chat.subscribeInterrupt(listener);
    f.chat.suspendPort.attach(async (callback) => callback());
    const suspend = f.chat.suspendPort.current()?.(() => body.promise);
    f.interrupt();
    expect(listener).not.toHaveBeenCalled();
    expect(f.chat.interrupted).toBe(false);
    expect(f.registry.termination).toBeUndefined();
    body.release();
    await suspend;
    f.chat.suspendPort.attach(undefined);
    remove();
    await f.chat.execute(() => Promise.resolve(4));
  });

  it('a shared DB close refusal retains surface uncertainty and the same finite deadline', async () => {
    const f = fixture();
    const primary = new Error('PRIVATE_DB_CLOSE');
    f.chat.adoptStore({
      close: () => {
        throw primary;
      },
    });
    let settled = false;
    void f.chat
      .execute(() => Promise.resolve(4))
      .then(() => {
        settled = true;
      });
    await turn();
    expect(f.registry.observations.exitCode()).toBe(9);
    expect(f.registry.activeOwners).toBe(1);
    expect(settled).toBe(false);
    expect(
      f.removeInterrupt,
      'SESSION_SIGNAL_CUSTODY_THROUGH_DATABASE_RELEASE',
    ).not.toHaveBeenCalled();
    expect(f.removeTermination).not.toHaveBeenCalled();
    f.termination(15);
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(f.registry.observations.exitCode()).toBe(9);
    f.advance(3000);
    expect(await f.invocation.finiteExit.exited).toBe(9);
    expect(settled).toBe(false);
  });
});
