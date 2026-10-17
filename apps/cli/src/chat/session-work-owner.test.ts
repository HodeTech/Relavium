import { describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/cli-error.js';
import { createInvocationFiniteExit } from '../process/invocation-finite-exit.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { SessionWorkOwner, type SessionWorkOwnerPorts } from './session-work-owner.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fixture(ports: Partial<SessionWorkOwnerPorts> = {}) {
  let now = 0;
  const timers = new Map<() => void, number>();
  const clock = {
    now: () => now,
    schedule: (ms: number, fire: () => void) => {
      timers.set(fire, now + ms);
      return () => {
        timers.delete(fire);
      };
    },
  };
  const exit = vi.fn();
  const registry = new InvocationRegistry(clock);
  const invocation = {
    registry,
    finiteExit: createInvocationFiniteExit(registry, clock, { exit, setExitCode: vi.fn() }),
    seedFileCatalogOnce: () => Promise.resolve(),
  };
  const cancel = ports.cancel ?? vi.fn();
  const cleanup = ports.cleanup ?? vi.fn(() => Promise.resolve());
  const owner = new SessionWorkOwner(invocation, 'chat', { cancel, cleanup });
  return {
    owner,
    invocation,
    registry,
    exit,
    timers,
    cancel,
    cleanup,
    advance: (time: number) => {
      now = time;
      for (const [fire, at] of [...timers]) if (at <= time && timers.delete(fire)) fire();
    },
  };
}

describe('creation-owned session work and actual cleanup', () => {
  it('reserves before construction without arming an ordinary timer, and returns exact raw work', async () => {
    const f = fixture();
    const entered = gate();
    expect(f.registry.activeOwners).toBe(1);
    expect(f.timers.size).toBe(0);
    const factory = vi.fn(() => {
      expect(f.registry.activeOwners).toBe(1);
      return entered.promise;
    });
    expect(f.owner.enter(factory)).toBe(entered.promise);
    const closing = f.owner.close();
    await reactions();
    expect(factory).toHaveBeenCalledOnce();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    entered.release();
    await closing;
    await reactions();
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
  });

  it('keeps transferred descendants owed after their root settles and admission seals', async () => {
    const f = fixture();
    const child = gate();
    await f.owner.enter(() => {
      void f.owner.work.retainWork(() => child.promise);
      return Promise.resolve();
    });
    const closing = f.owner.close();
    await reactions();
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    expect(() => f.owner.enter(() => Promise.resolve())).toThrow('Session operation stopped.');
    expect(() => f.owner.work.retainWork(() => Promise.resolve())).toThrow();
    child.release();
    await closing;
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('does not promote a descendant transport rejection into an unexpected root failure', async () => {
    const f = fixture();
    const cause = new Error('PRIVATE_TRANSPORT_CANCELLATION');
    const transport = f.owner.work.retainWork(() => Promise.reject(cause));
    await expect(transport).rejects.toBe(cause);
    expect(f.registry.termination).toBeUndefined();
    expect(f.owner.firstFailure).toBeUndefined();
    await f.owner.close();
  });

  it('keeps cleanup-tail transfer open until already-entered roots actually settle', async () => {
    const f = fixture();
    const rootGate = gate();
    const tail = gate();
    const raw = f.owner.enter(async () => {
      await rootGate.promise;
      void f.owner.work.retainWork(() => tail.promise);
    });
    const closing = f.owner.close();
    rootGate.release();
    await raw;
    await reactions();
    expect(f.owner.firstFailure).toBeUndefined();
    expect(f.cleanup, 'SESSION_ADMITTED_ROOT_CAN_TRANSFER_CLEANUP_TAIL').not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    expect(() => f.owner.work.retainWork(() => Promise.resolve())).toThrow();
    tail.release();
    await closing;
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('does not let an overridden raw then fabricate settlement', async () => {
    const f = fixture();
    const work = gate();
    const fakeThen = vi.fn(() => {
      throw new Error('PRIVATE_FAKE_THEN');
    });
    void Object.defineProperty(work.promise, 'then', { value: fakeThen });
    expect(f.owner.enter(() => work.promise)).toBe(work.promise);
    const closing = f.owner.close();
    await reactions();
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(fakeThen).not.toHaveBeenCalled();
    work.release();
    await closing;
    expect(fakeThen).not.toHaveBeenCalled();
  });

  it('starts the original budget before a rejected root can be held behind cleanup', async () => {
    const cleanup = gate();
    const f = fixture({ cleanup: () => cleanup.promise });
    const cause = new Error('PRIVATE_ROOT_FAILURE');
    f.advance(500);
    await expect(f.owner.enter(() => Promise.reject(cause))).rejects.toBe(cause);
    await reactions();
    expect(f.owner.firstFailure?.cause).toBe(cause);
    expect(f.owner.signal.aborted).toBe(true);
    expect(f.registry.budget.deadline(), 'SESSION_ROOT_FAULT_STARTS_BUDGET').toBe(3500);
    expect(f.registry.activeOwners).toBe(1);
    f.advance(1000);
    f.owner.failure(new Error('PRIVATE_LATER_FAILURE'));
    expect(f.registry.budget.deadline()).toBe(3500);
    expect(f.owner.firstFailure?.cause).toBe(cause);
    f.advance(3499);
    await reactions();
    expect(f.exit).not.toHaveBeenCalled();
    f.advance(3500);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(f.registry.activeOwners).toBe(1);
    cleanup.release();
    await f.owner.close();
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.exit).toHaveBeenCalledOnce();
  });

  it('retains an opaque root rejection even when its value is undefined', async () => {
    const f = fixture();
    const rejected = new Promise<void>((_resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Foreign promises can reject undefined; presence cannot be tested by truthiness.
      reject(undefined);
    });
    await expect(f.owner.enter(() => rejected)).rejects.toBeUndefined();
    await f.owner.close();
    expect(f.owner.firstFailure).toEqual({ cause: undefined });
    expect(f.registry.observations.exitCode()).toBe(9);
  });

  it('keeps a known inline refusal out of the eventual surface outcome and future admission', async () => {
    const f = fixture();
    const refusal = new CliError('invalid_invocation', 'fixture refusal');
    await expect(f.owner.enter(() => Promise.reject(refusal))).rejects.toBe(refusal);
    expect(f.registry.termination).toBeUndefined();
    expect(f.registry.observations.exitCode()).toBe(0);
    expect(f.owner.firstFailure).toBeUndefined();
    expect(await f.owner.enter(() => Promise.resolve(42))).toBe(42);
    await f.owner.close();
    expect(f.registry.observations.exitCode()).toBe(0);
  });

  it('shares actual cleanup before synchronous cancellation callback reentry', async () => {
    const slot: { owner?: SessionWorkOwner } = {};
    let reentered: Promise<void> | undefined;
    const cleanup = gate();
    const f = fixture({
      cancel: () => {
        reentered = slot.owner?.close();
      },
      cleanup: () => cleanup.promise,
    });
    const owner = f.owner;
    slot.owner = owner;
    const first = owner.close();
    expect(reentered).toBe(first);
    expect(owner.close()).toBe(first);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await reactions();
    expect(settled, 'SESSION_SHARED_CLEANUP_IS_ACTUAL').toBe(false);
    expect(f.registry.activeOwners).toBe(1);
    cleanup.release();
    await first;
    await reactions();
    expect(settled).toBe(true);
    expect(f.registry.activeOwners).toBe(0);
  });

  it('does not retire a callback-reported failure when its manager close fulfils', async () => {
    const cleanup = vi.fn(() => Promise.resolve());
    const f = fixture({ cleanup });
    f.owner.cleanupUncertain(new Error('PRIVATE_MANAGER_CALLBACK_FAILURE'));
    let retired = false;
    void f.owner.close().then(() => {
      retired = true;
    });
    await reactions();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(retired, 'SESSION_CALLBACK_FAULT_WITHHOLDS_RETIREMENT').toBe(false);
    expect(f.registry.activeOwners).toBe(1);
    expect(f.registry.observations.exitCode()).toBe(9);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(f.registry.activeOwners).toBe(1);
    expect(retired).toBe(false);
  });

  it('keeps cleanup rejection distinct from an actual fulfilled cleanup acknowledgement', async () => {
    const cause = new Error('PRIVATE_CLEANUP_FAILURE');
    const f = fixture({ cleanup: () => Promise.reject(cause) });
    let retired = false;
    void f.owner.close().then(() => {
      retired = true;
    });
    await reactions();
    expect(retired).toBe(false);
    expect(f.owner.firstFailure?.cause).toBe(cause);
    expect(f.registry.activeOwners).toBe(1);
    expect(f.registry.observations.exitCode()).toBe(9);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(retired).toBe(false);
  });

  it('does not enter a new async cleanup after a held root outlives the original deadline', async () => {
    const f = fixture();
    const root = gate();
    void f.owner.enter(() => root.promise);
    f.owner.failure(new Error('PRIVATE_FIRST_FAULT'));
    const closing = f.owner.close();
    f.advance(3000);
    await reactions();
    root.release();
    await reactions();
    expect(f.cleanup, 'SESSION_NO_NEW_CLEANUP_AFTER_EXPIRY').not.toHaveBeenCalled();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(f.registry.activeOwners).toBe(1);
    expect(f.owner.close()).toBe(closing);
  });

  it('treats a synchronous cancellation fault as retained uncertainty without skipping cleanup', async () => {
    const f = fixture({
      cancel: () => {
        throw new Error('PRIVATE_CANCEL_FAILURE');
      },
    });
    void f.owner.close();
    await reactions();
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(1);
    expect(f.registry.observations.exitCode()).toBe(9);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
  });

  it('tracks distinct pending/replaced host instances independently of a shared surface', async () => {
    const first = gate();
    const second = gate();
    const f = fixture({ cleanup: () => first.promise });
    const other = new SessionWorkOwner(f.invocation, 'chat', {
      cancel: vi.fn(),
      cleanup: () => second.promise,
    });
    expect(f.registry.activeOwners).toBe(2);
    const one = f.owner.close();
    const two = other.close();
    first.release();
    await one;
    await reactions();
    expect(f.registry.activeOwners, 'SESSION_DISTINCT_HOST_OWNERS').toBe(1);
    second.release();
    await two;
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.exit).not.toHaveBeenCalled();
  });
});
