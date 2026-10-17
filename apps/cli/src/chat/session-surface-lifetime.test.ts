import { describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/cli-error.js';
import { createInvocationFiniteExit } from '../process/invocation-finite-exit.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { SessionSurfaceLifetime } from './session-surface-lifetime.js';
import { SessionWorkOwner } from './session-work-owner.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function invocationFixture() {
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
  return {
    invocation,
    registry,
    exit,
    timers,
    advance: (time: number) => {
      now = time;
      for (const [fire, at] of [...timers]) if (at <= time && timers.delete(fire)) fire();
    },
  };
}

function fixture() {
  const f = invocationFixture();
  let signal: (signo: number) => void = () => undefined;
  const remove = vi.fn();
  const lifetime = new SessionSurfaceLifetime(f.invocation, 'home', (listener) => {
    signal = listener;
    return remove;
  });
  return { ...f, lifetime, remove, signal: (signo: number) => signal(signo) };
}

describe('surface roots outlive their shared preparation and database tails', () => {
  it('retains signal custody when a partial native acquisition supplies no release capability', async () => {
    const f = fixture();
    let settled = false;
    void f.lifetime
      .execute(() => {
        const failure = new Error('synthetic unknown partial acquisition');
        f.lifetime.work.cleanupUncertain(failure);
        throw failure;
      })
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    await reactions();
    expect(f.registry.activeOwners).toBe(1);
    expect(f.remove, 'UNKNOWN_PARTIAL_ACQUISITION_RETAINS_SIGNAL_CUSTODY').not.toHaveBeenCalled();
    expect(settled).toBe(false);
    f.advance(3_000);
    expect(await f.invocation.finiteExit.exited).toBe(9);
    expect(f.registry.activeOwners).toBe(1);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 4] as const)(
    'preserves actual surface outcome %s without creating a fatal timer or physical exit',
    async (outcome) => {
      const f = fixture();
      expect(f.registry.activeOwners).toBe(1);
      expect(await f.lifetime.execute(() => Promise.resolve(outcome))).toBe(outcome);
      await reactions();
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.observations.exitCode()).toBe(outcome);
      expect(f.remove).toHaveBeenCalledOnce();
      expect(f.exit).not.toHaveBeenCalled();
      expect(f.timers.size).toBe(0);
    },
  );

  it('does not turn a consumed inline refusal into the final Home outcome', async () => {
    const f = fixture();
    const host = new SessionWorkOwner(f.invocation, 'home', {
      cancel: () => undefined,
      cleanup: () => Promise.resolve(),
    });
    expect(
      await f.lifetime.execute(async () => {
        await expect(
          host.enter(() => Promise.reject(new CliError('invalid_invocation', 'inline refusal'))),
        ).rejects.toMatchObject({ code: 'invalid_invocation' });
        await host.close();
        return 0;
      }),
    ).toBe(0);
    expect(f.registry.observations.exitCode()).toBe(0);
  });

  it('retains a known escaping refusal and removes signals only after actual root cleanup', async () => {
    const f = fixture();
    const cause = new CliError('invalid_invocation', 'synthetic refusal');
    await expect(f.lifetime.execute(() => Promise.reject(cause))).rejects.toBe(cause);
    expect(f.registry.observations.exitCode()).toBe(2);
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.exit).not.toHaveBeenCalled();
  });

  it('keeps a competing infrastructure fault ahead of a later known refusal', async () => {
    const f = fixture();
    const refusal = new CliError('invalid_invocation', 'synthetic refusal');
    await expect(
      f.lifetime.execute(() => {
        f.lifetime.work.failure(new Error('PRIVATE_COMPETING_FAILURE'));
        return Promise.reject(refusal);
      }),
    ).rejects.toMatchObject({ code: 'cli_internal', exitCode: 9, cause: refusal });
    expect(f.registry.observations.exitCode()).toBe(9);
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it.each([5, 7, 8] as const)(
    'does not let a session invent workflow-only health %s',
    async (value) => {
      const f = fixture();
      expect(await f.lifetime.execute(() => Promise.resolve(value))).toBe(9);
      expect(f.registry.observations.exitCode()).toBe(9);
      expect(f.registry.observations.hasInfrastructureFailure()).toBe(true);
      f.advance(3000);
      await reactions();
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    },
  );

  it('keeps terminating-signal exit behind the shared database tail after the host itself retired', async () => {
    const f = fixture();
    const database = gate();
    const hostClosed = gate();
    const host = new SessionWorkOwner(f.invocation, 'home', {
      cancel: () => undefined,
      cleanup: () => Promise.resolve(),
    });
    let databaseClosed = false;
    const command = f.lifetime.execute(async () => {
      await host.close();
      hostClosed.release();
      await database.promise;
      databaseClosed = true;
      return 4;
    });
    await hostClosed.promise;
    f.signal(15);
    await reactions();
    expect(f.registry.activeOwners).toBe(1);
    expect(databaseClosed).toBe(false);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.exit, 'SESSION_SIGNAL_WAITS_SHARED_DATABASE_ROOT').not.toHaveBeenCalled();
    expect(f.registry.observations.exitCode()).toBe(143);
    database.release();
    expect(await command).toBe(4);
    await reactions();
    expect(databaseClosed).toBe(true);
    expect(f.registry.activeOwners).toBe(0);
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(143);
  });

  it('uses the original signal budget while held preparation survives competing signals', async () => {
    const f = fixture();
    const input = gate();
    const command = f.lifetime.execute(async () => {
      await input.promise;
      f.lifetime.work.assertAdmitting();
      return 0;
    });
    f.signal(2);
    expect(f.registry.budget.deadline()).toBe(3000);
    f.advance(500);
    f.signal(15);
    expect(f.registry.budget.deadline(), 'SESSION_SIGNALS_DO_NOT_RENEW_BUDGET').toBe(3000);
    expect(f.registry.observations.exitCode()).toBe(130);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(130);
    expect(f.registry.activeOwners).toBe(1);
    expect(f.remove).not.toHaveBeenCalled();
    input.release();
    // After actual expiry no new async cleanup enters and no positive retirement is fabricated.
    void command;
    await reactions();
    expect(f.registry.activeOwners).toBe(1);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('does not acknowledge partially acquired signal custody when registration throws', async () => {
    const f = invocationFixture();
    const cause = new Error('PRIVATE_PARTIAL_SIGNAL_REGISTRATION');
    expect(
      () =>
        new SessionSurfaceLifetime(f.invocation, 'agent', () => {
          throw cause;
        }),
    ).toThrow(cause);
    await reactions();
    expect(f.registry.activeOwners).toBe(1);
    expect(f.registry.observations.exitCode()).toBe(9);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(f.registry.activeOwners).toBe(1);
  });
});
