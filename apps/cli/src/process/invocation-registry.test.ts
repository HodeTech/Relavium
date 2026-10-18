import { describe, expect, it, vi } from 'vitest';

import {
  InvocationRegistry,
  type InvocationClock,
  type InvocationCloseResult,
  type NativeOwner,
  type OwnerRetirement,
  type RemainingBudget,
  type SessionOwner,
  type WorkflowOwner,
} from './invocation-registry.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class ManualClock implements InvocationClock {
  time = 0;
  readonly timers = new Set<{ at: number; fire: () => void }>();
  readonly now = (): number => this.time;
  readonly schedule = (milliseconds: number, fire: () => void): (() => void) => {
    const timer = { at: this.time + milliseconds, fire };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  };
  advanceTo(time: number): void {
    expect(time).toBeGreaterThanOrEqual(this.time);
    this.time = time;
    for (const timer of [...this.timers]) {
      if (timer.at <= time && this.timers.delete(timer)) timer.fire();
    }
  }
}

function session(
  retired: Promise<OwnerRetirement>,
  overrides: Partial<SessionOwner> = {},
): SessionOwner {
  return {
    kind: 'session',
    surface: 'chat',
    retired,
    stop: () => undefined,
    join: () => undefined,
    classifyFailure: () => 'cli_internal',
    ...overrides,
  };
}

function native(
  retired: Promise<OwnerRetirement>,
  overrides: Partial<NativeOwner> = {},
): NativeOwner {
  return {
    ...session(retired),
    kind: 'native-pid',
    mayReap: () => true,
    reap: () => undefined,
    ...overrides,
  };
}

const settled: OwnerRetirement = Object.freeze({ kind: 'settled' });

// Awaiting the exact witness is an explicit observer-order barrier: registry registration
// attached its native Promise reaction first. No timer or guessed microtask count is used.
async function retire(
  witness: ReturnType<typeof deferred<OwnerRetirement>>,
  value = settled,
): Promise<void> {
  witness.resolve(value);
  await witness.promise;
}

describe('InvocationRegistry ownership', () => {
  it('notifies the one process owner of autonomous faults without waiting for runtime completion', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const failure = deferred<void>();
    const lease = registry.register(session(life.promise, { join: () => failure.promise }));
    const notified = deferred<Promise<InvocationCloseResult>>();
    let notificationReceived = false;
    const remove = registry.observeTermination(() => {
      notificationReceived = true;
      const termination = registry.termination;
      if (termination !== undefined) notified.resolve(termination);
    });
    expect(() => registry.observeTermination(() => undefined)).toThrow();
    expect(registry.termination).toBeUndefined();
    const closing = lease.close();
    failure.reject(new Error('private owner failure while runtime is held'));
    await failure.promise.catch(() => undefined);
    expect(notificationReceived, 'REGISTRY_TERMINATION_OBSERVATION').toBe(true);
    const observed = notified.promise;
    expect(registry.termination).toBeDefined();
    expect(registry.budget.deadline()).toBe(3000);
    expect(registry.observations.exitCode()).toBe(9);
    await retire(life);
    expect(await closing).toEqual({ kind: 'retired' });
    expect(await observed).toEqual({ kind: 'settled', unacknowledgedOwners: 0 });
    remove();
  });

  it('shares its original deadline after owner settlement and reports a tighter final-flush deadline', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const budgets: RemainingBudget[] = [];
    const remove = registry.observeTermination(() => budgets.push(registry.budget));
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    await closing;
    expect(clock.timers.size).toBe(0);
    clock.advanceTo(700);
    expect(registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' })).toBe(
      closing,
    );
    expect(registry.budget.deadline()).toBe(3000);
    expect(registry.budget.remainingMs()).toBe(2300);
    void registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 1500 });
    expect(clock.timers.size).toBe(0);
    expect(registry.budget.remainingMs()).toBe(800);
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets.every((budget) => budget === registry.budget)).toBe(true);
    remove();
  });

  it('starts one fatal budget for the first output failure after normal cleanup has already settled', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const closing = registry.terminate({ kind: 'normal' });
    await closing;
    expect(registry.budget.deadline()).toBeUndefined();
    const deadlines: (number | undefined)[] = [];
    const remove = registry.observeTermination(() => deadlines.push(registry.budget.deadline()));
    clock.advanceTo(200);
    expect(registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' })).toBe(
      closing,
    );
    expect(registry.budget.deadline()).toBe(3200);
    clock.advanceTo(600);
    void registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    expect(registry.budget.deadline()).toBe(3200);
    expect(deadlines).toContain(3200);
    expect(clock.timers.size).toBe(0);
    remove();
  });

  it('guards process observer failure and reentry without skipping any sibling stop', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const stops: number[] = [];
    for (const index of [0, 1, 2])
      registry.register(
        session(life.promise, {
          stop: () => {
            stops.push(index);
          },
        }),
      );
    const remove = registry.observeTermination(() => {
      void registry.terminate({ kind: 'normal' });
      throw new Error('private observer failure');
    });
    const closing = registry.terminate({ kind: 'normal' });
    expect(stops).toEqual([0, 1, 2]);
    expect(registry.observations.exitCode()).toBe(9);
    expect(registry.budget.deadline()).toBe(3000);
    await retire(life);
    expect((await closing).kind).toBe('settled');
    remove();
    const next = registry.observeTermination(() => undefined);
    next();
  });

  it('registers before admission without joining an idle session, and closes only that instance', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const first = deferred<OwnerRetirement>();
    const second = deferred<OwnerRetirement>();
    const join = vi.fn();
    const lease = registry.register(session(first.promise, { join }));
    const sibling = registry.register(session(second.promise));
    expect(registry.activeOwners).toBe(2);
    expect(join).not.toHaveBeenCalled();
    lease.assertAdmitting();
    const closing = lease.close();
    expect(lease.close()).toBe(closing);
    expect(join).toHaveBeenCalledOnce();
    expect(() => lease.assertAdmitting()).toThrow();
    sibling.assertAdmitting();
    registry.assertAdmitting();
    expect(registry.activeOwners).toBe(2);
    await retire(first);
    expect(await closing).toEqual({ kind: 'retired' });
    expect(registry.activeOwners).toBe(1);
    await retire(second);
  });

  it('latches stop before a reentrant factory can admit work', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    let blocked = false;
    registry.register(
      session(life.promise, {
        stop: () => {
          try {
            registry.register(session(life.promise));
          } catch {
            blocked = true;
          }
        },
      }),
    );
    const closing = registry.terminate({ kind: 'normal' });
    expect(blocked).toBe(true);
    expect(() => registry.assertAdmitting()).toThrow();
    await retire(life);
    expect(await closing).toEqual({ kind: 'settled', unacknowledgedOwners: 0 });
  });

  it('enters all stops before tails despite throw, immediate rejection and held stop', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const trace: string[] = [];
    const lifetimes = Array.from({ length: 3 }, () => deferred<OwnerRetirement>());
    const held = deferred<void>();
    for (const [index, life] of lifetimes.entries()) {
      registry.register(
        session(life.promise, {
          stop: () => {
            trace.push(`stop${index}`);
            if (index === 0) throw new Error('stop failed');
            if (index === 1) return Promise.reject(new Error('rejected stop'));
            return held.promise;
          },
          join: () => {
            trace.push(`join${index}`);
          },
        }),
      );
    }
    const closing = registry.terminate({ kind: 'normal' });
    expect(trace).toEqual(['stop0', 'stop1', 'stop2', 'join0', 'join1', 'join2']);
    for (const life of lifetimes) await retire(life);
    held.resolve();
    expect((await closing).kind).toBe('settled');
    expect(registry.observations.exitCode()).toBe(9);
    expect(registry.failureKinds).toBe(1);
  });

  it('does not confuse settled cleanup attempts with actual lifetime retirement', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const lease = registry.register(
      session(life.promise, { join: () => Promise.reject(new Error('join refused')) }),
    );
    const ownerClose = lease.close();
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    expect(registry.activeOwners).toBe(1);
    clock.advanceTo(3000);
    expect(await ownerClose).toEqual({ kind: 'unacknowledged' });
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
    expect(registry.activeOwners).toBe(1);
    await retire(life);
    expect(registry.activeOwners).toBe(0);
  });

  it('keeps rejected retirement unacknowledged and retains settled publication failure', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const rejected = deferred<OwnerRetirement>();
    const published = deferred<OwnerRetirement>();
    registry.register(session(rejected.promise, { classifyFailure: () => 'storage_unavailable' }));
    registry.register(session(published.promise));
    rejected.reject(new Error('private publication details'));
    await rejected.promise.catch(() => undefined);
    await retire(published, { kind: 'settled', failure: 'storage_unavailable' });
    expect(registry.activeOwners).toBe(1);
    expect(registry.observations.exitCode()).toBe(1);
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    clock.advanceTo(3000);
    expect((await closing).unacknowledgedOwners).toBe(1);
  });

  it('restores terminal custody while an unrelated host join is held', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const host = deferred<OwnerRetirement>();
    const terminal = deferred<OwnerRetirement>();
    const hostJoin = deferred<void>();
    const trace: string[] = [];
    registry.register(session(host.promise, { join: () => hostJoin.promise }));
    registry.register({
      ...session(terminal.promise),
      kind: 'terminal',
      restore: () => {
        trace.push('restore');
      },
    });
    const closing = registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' });
    expect(trace).toEqual(['restore']);
    await retire(terminal);
    expect(registry.activeOwners).toBe(1);
    clock.advanceTo(3000);
    expect((await closing).kind).toBe('deadline');
    hostJoin.resolve();
    await retire(host);
  });

  it('attempts sibling restore and native reap after stop or restore failure', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const trace: string[] = [];
    registry.register({
      ...session(life.promise),
      kind: 'terminal',
      stop: () => {
        throw new Error('stop');
      },
      restore: () => {
        trace.push('restore1');
        throw new Error('restore');
      },
    });
    registry.register({
      ...session(life.promise),
      kind: 'terminal',
      restore: () => {
        trace.push('restore2');
      },
    });
    registry.register({
      ...session(life.promise),
      kind: 'native-pid',
      mayReap: () => true,
      reap: () => {
        trace.push('reap');
      },
    });
    const closing = registry.terminate({ kind: 'normal' });
    expect(trace).toEqual(['restore1', 'restore2', 'reap']);
    await retire(life);
    await closing;
    expect(registry.observations.exitCode()).toBe(9);
  });

  it('shares exact cleanup identity across stop and health reentry', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const nested: Promise<InvocationCloseResult>[] = [];
    const stop = vi.fn(() => {
      nested.push(registry.terminate({ kind: 'normal' }));
    });
    registry.register({
      ...session(life.promise),
      kind: 'workflow',
      stop,
      readSafetyExit: () => {
        nested.push(registry.terminate({ kind: 'normal' }));
        return 7;
      },
    });
    const closing = registry.terminate({ kind: 'normal' });
    expect(nested.length).toBeGreaterThan(0);
    for (const promise of nested) expect(promise).toBe(closing);
    expect(stop).toHaveBeenCalledOnce();
    await retire(life);
    await closing;
    expect(registry.observations.exitCode()).toBe(7);
  });

  it('escalates normal cleanup under one live shortened deadline without restarting callbacks', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const budgets: RemainingBudget[] = [];
    const stop = vi.fn((budget: RemainingBudget) => {
      budgets.push(budget);
    });
    registry.register(
      session(life.promise, {
        stop,
        join: (budget) => {
          budgets.push(budget);
        },
      }),
    );
    const closing = registry.terminate({ kind: 'normal' });
    expect(budgets.map((budget) => budget.remainingMs())).toEqual([undefined, undefined]);
    clock.advanceTo(100);
    expect(registry.terminate({ kind: 'infrastructure', code: 'cli_internal' })).toBe(closing);
    expect(budgets.map((budget) => budget.deadline())).toEqual([3100, 3100]);
    clock.advanceTo(200);
    expect(registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 500 })).toBe(closing);
    expect(registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' })).toBe(
      closing,
    );
    expect(budgets.map((budget) => budget.remainingMs())).toEqual([300, 300]);
    expect(stop).toHaveBeenCalledOnce();
    clock.advanceTo(500);
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
    expect(registry.observations.exitCode()).toBe(9);
    await retire(life);
  });

  it('never starts a tail/helper after the common budget expires during an earlier callback', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const join = vi.fn();
    const reap = vi.fn();
    registry.register({
      ...session(life.promise),
      kind: 'windows-live-root',
      stop: () => {
        clock.advanceTo(3000);
      },
      join,
      mayReap: () => true,
      reap,
    });
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    expect((await closing).kind).toBe('deadline');
    expect(join).not.toHaveBeenCalled();
    expect(reap).not.toHaveBeenCalled();
    expect(registry.activeOwners).toBe(1);
    await retire(life);
  });

  it('uses creation-kind eligibility: closed leader retains group authority but closed PID/root does not', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const trace: string[] = [];
    const rootClosed = true;
    for (const kind of ['native-group', 'native-pid', 'windows-live-root'] as const) {
      registry.register({
        ...session(life.promise),
        kind,
        mayReap: () => kind === 'native-group' || !rootClosed,
        reap: () => {
          trace.push(kind);
        },
      });
    }
    const closing = registry.terminate({ kind: 'normal' });
    expect(trace).toEqual(['native-group']);
    expect(registry.activeOwners).toBe(3); // A reap request does not acknowledge any target.
    await retire(life);
    await closing;
    expect(registry.activeOwners).toBe(0);
  });

  it.each([false, true])(
    'preserves actual workflow safety on returned/thrown join and after retirement (throw=%s)',
    async (throws) => {
      const registry = new InvocationRegistry(new ManualClock());
      const life = deferred<OwnerRetirement>();
      let safety: ReturnType<WorkflowOwner['readSafetyExit']> = 5;
      registry.register({
        ...session(life.promise),
        kind: 'workflow',
        readSafetyExit: () => safety,
        join: () => {
          if (throws) throw new Error('drive fault');
        },
      });
      const closing = registry.terminate({ kind: 'normal' });
      expect(registry.observations.exitCode()).toBe(5);
      safety = 8;
      await retire(life);
      safety = undefined;
      await closing;
      registry.observations.observeFailure('output_unavailable');
      registry.sampleWorkflowHealth();
      expect(registry.observations.exitCode()).toBe(8);
    },
  );

  it('retains a finite failure vocabulary after many retired instances without claiming GC', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    for (let index = 0; index < 1000; index++) {
      const life = deferred<OwnerRetirement>();
      registry.register(session(life.promise));
      await retire(life, { kind: 'settled', failure: 'storage_unavailable' });
    }
    expect(registry.activeOwners).toBe(0);
    expect(registry.failureKinds).toBe(1);
    expect(registry.observations.exitCode()).toBe(1);
  });

  it('snapshots caller-owned callback properties at registration', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const original = vi.fn();
    const replacement = vi.fn();
    const owner = { ...session(life.promise), stop: original };
    registry.register(owner);
    owner.stop = replacement;
    const closing = registry.terminate({ kind: 'normal' });
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    await retire(life);
    await closing;
  });

  it('uses fixed infrastructure failure when the owned classifier itself throws', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    registry.register(
      session(life.promise, {
        stop: () => {
          throw new Error('private');
        },
        classifyFailure: () => {
          throw new Error('classifier private');
        },
      }),
    );
    const closing = registry.terminate({ kind: 'normal' });
    await retire(life);
    await closing;
    expect(registry.observations.exitCode()).toBe(9);
    expect(registry.observations.infrastructureCode()).toBe('cli_internal');
  });

  it('background observation leaves admission and live owners running', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const stop = vi.fn();
    const lease = registry.register(session(life.promise, { stop }));
    registry.observations.observeBackgroundFailure();
    registry.assertAdmitting();
    lease.assertAdmitting();
    expect(stop).not.toHaveBeenCalled();
    expect(registry.observations.exitCode()).toBe(9);
    await retire(life);
  });

  it('bypasses an overridden native Promise.then without accepting a forged settlement', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const forgedThen = vi.fn(() => Promise.resolve(settled));
    void Object.defineProperty(life.promise, 'then', { value: forgedThen });
    registry.register(session(life.promise));
    expect(forgedThen).not.toHaveBeenCalled();
    expect(registry.activeOwners).toBe(1);
    life.resolve(settled);
    await life.promise; // Native await ignores the own .then for a genuine same-realm Promise.
    expect(registry.activeOwners).toBe(0);
  });

  it('does not accept a foreign thenable as native lifetime evidence', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const forged = {
      then: vi.fn((resolve: (value: OwnerRetirement) => void) => {
        resolve(settled);
      }),
    };
    // @ts-expect-error Deliberately exercise the runtime boundary with a non-Promise adapter.
    registry.register(session(forged));
    expect(forged.then).not.toHaveBeenCalled();
    expect(registry.activeOwners).toBe(1);
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    clock.advanceTo(3000);
    expect((await closing).unacknowledgedOwners).toBe(1);
  });

  it('does not invent retirement when native Promise species observation fails', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    void Object.defineProperty(life.promise, 'constructor', {
      get: () => {
        throw new Error('species unavailable');
      },
    });
    registry.register(session(life.promise));
    life.resolve(settled);
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    clock.advanceTo(3000);
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
    expect(registry.failureKinds).toBe(1);
  });

  it.each(['unknown', '__proto__', 'toString', undefined, null, 1])(
    'rejects an unknown runtime owner kind %j before admission',
    async (kind) => {
      const registry = new InvocationRegistry(new ManualClock());
      const life = deferred<OwnerRetirement>();
      const stop = vi.fn();
      const join = vi.fn();
      const owner = session(life.promise, { stop, join });
      Object.defineProperty(owner, 'kind', { value: kind });
      let failure: unknown;
      try {
        registry.register(owner);
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toMatchObject({ code: 'cli_internal', exitCode: 9 });
      expect(registry.activeOwners).toBe(0);
      expect(stop).not.toHaveBeenCalled();
      expect(join).not.toHaveBeenCalled();
      // Refusal grants no owner and does not poison later valid registration.
      const valid = registry.register(session(life.promise));
      await retire(life);
      expect(await valid.close()).toEqual({ kind: 'retired' });
      expect(registry.activeOwners).toBe(0);
    },
  );

  it('distinguishes an absent retirement failure from an explicitly undefined failure', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const valid = deferred<OwnerRetirement>();
    const malformed = deferred<OwnerRetirement>();
    registry.register(session(valid.promise));
    registry.register(session(malformed.promise));
    const payload: OwnerRetirement = { kind: 'settled' };
    // The exact optional protocol permits absence, not a present non-code value.
    Object.defineProperty(payload, 'failure', { value: undefined });
    await retire(valid);
    expect(registry.activeOwners).toBe(1);
    await retire(malformed, payload);
    expect(registry.activeOwners).toBe(1);
    expect(registry.observations.infrastructureCode()).toBe('cli_internal');
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    clock.advanceTo(3000);
    expect(await closing).toMatchObject({ kind: 'deadline', unacknowledgedOwners: 1 });
  });

  it('does not invoke hostile retirement payload getters or accept them as an ACK', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const getter = vi.fn(() => 'settled');
    const payload: OwnerRetirement = { kind: 'settled' };
    Object.defineProperty(payload, 'kind', { get: getter });
    registry.register(session(life.promise));
    await retire(life, payload);
    expect(getter).not.toHaveBeenCalled();
    expect(registry.activeOwners).toBe(1);
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    clock.advanceTo(3000);
    await closing;
  });

  it('removes completed fatal timer and does not rearm it on a later observation', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    await closing;
    expect(clock.timers.size).toBe(0);
    expect(registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 10 })).toBe(closing);
    expect(clock.timers.size).toBe(0);
  });

  it('rejects invalid termination input before poisoning the admission/cleanup latch', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    expect(() => registry.terminate({ kind: 'signal', signalNumber: 0 })).toThrow();
    registry.assertAdmitting();
    expect(await registry.terminate({ kind: 'normal' })).toEqual({
      kind: 'settled',
      unacknowledgedOwners: 0,
    });
  });

  it('does not read a session-shaped object as workflow health at runtime', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const readSafetyExit = vi.fn(() => 8);
    const owner = { ...session(life.promise), readSafetyExit };
    registry.register(owner);
    const closing = registry.terminate({ kind: 'normal' });
    await retire(life, { kind: 'settled', failure: 'storage_unavailable' });
    await closing;
    expect(readSafetyExit).not.toHaveBeenCalled();
    expect(registry.observations.exitCode()).toBe(1);
  });

  it('shares one decreasing budget across sequential callback entry', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const remaining: (number | undefined)[] = [];
    registry.register(
      session(life.promise, {
        stop: (budget) => {
          remaining.push(budget.remainingMs());
          clock.advanceTo(700);
        },
        join: (budget) => {
          remaining.push(budget.remainingMs());
        },
      }),
    );
    registry.register({
      ...session(life.promise),
      kind: 'native-group',
      stop: (budget) => {
        remaining.push(budget.remainingMs());
        clock.advanceTo(1100);
      },
      mayReap: () => true,
      reap: (budget) => {
        remaining.push(budget.remainingMs());
      },
    });
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    expect(remaining).toEqual([3000, 2300, 1900, 1900]);
    await retire(life);
    await closing;
  });

  it('keeps an unobserved stop attempt pending despite an independently retired resource', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const attempt = deferred<void>();
    void Object.defineProperty(attempt.promise, 'constructor', {
      get: () => {
        throw new Error('cannot observe cleanup');
      },
    });
    registry.register(session(life.promise, { stop: () => attempt.promise }));
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    await retire(life);
    attempt.resolve();
    clock.advanceTo(3000);
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 0 });
    expect(registry.observations.exitCode()).toBe(9);
  });

  it('does not reap a native owner which already actually retired', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const reap = vi.fn();
    const lease = registry.register({
      ...session(life.promise),
      kind: 'native-group',
      mayReap: () => true,
      reap,
    });
    await retire(life);
    expect(await lease.close()).toEqual({ kind: 'retired' });
    expect(reap).not.toHaveBeenCalled();
    expect(await registry.terminate({ kind: 'normal' })).toEqual({
      kind: 'settled',
      unacknowledgedOwners: 0,
    });
  });

  it('rejects a nonfinite signal deadline without poisoning admission', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    expect(() =>
      registry.terminate({ kind: 'signal', signalNumber: 15, deadline: Number.NaN }),
    ).toThrow();
    registry.assertAdmitting();
    expect(registry.observations.exitCode()).toBe(0);
    await registry.terminate({ kind: 'normal' });
  });

  it('starts the fatal budget when normal cleanup first observes an infrastructure callback fault', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    registry.register(
      session(life.promise, {
        stop: () => {
          throw new Error('unexpected owner failure');
        },
      }),
    );
    const closing = registry.terminate({ kind: 'normal' });
    expect(registry.observations.exitCode()).toBe(9);
    expect([...clock.timers].map((timer) => timer.at)).toEqual([3000]);
    clock.advanceTo(3000);
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
    await retire(life);
  });

  it('automatic fatal escalation from an individual close stops all siblings before starting tails', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const trace: string[] = [];
    const first = registry.register(
      session(life.promise, {
        stop: () => {
          trace.push('stop1');
          throw new Error('fatal stop');
        },
        join: () => {
          trace.push('join1');
        },
      }),
    );
    registry.register(
      session(life.promise, {
        stop: () => {
          trace.push('stop2');
          throw new Error('nested fatal stop');
        },
        join: () => {
          trace.push('join2');
        },
      }),
    );
    registry.register({
      ...session(life.promise),
      kind: 'terminal',
      stop: () => {
        trace.push('stop3');
      },
      join: () => {
        trace.push('join3');
      },
      restore: () => {
        trace.push('restore3');
      },
    });
    const closing = first.close();
    expect(trace).toEqual(['stop1', 'stop2', 'stop3', 'join1', 'join2', 'join3', 'restore3']);
    expect(() => registry.assertAdmitting()).toThrow();
    expect([...clock.timers].map((timer) => timer.at)).toEqual([3000]);
    clock.advanceTo(3000);
    expect(await closing).toEqual({ kind: 'unacknowledged' });
    expect((await registry.terminate({ kind: 'normal' })).kind).toBe('deadline');
    await retire(life);
  });

  it('does not let a reentrant owner close start tails before the all-stop pass finishes', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const trace: string[] = [];
    const second = registry.register(
      session(life.promise, {
        stop: () => {
          trace.push('stop2');
        },
        join: () => {
          trace.push('join2');
        },
      }),
    );
    registry.register(
      session(life.promise, {
        stop: () => {
          trace.push('stop1');
          void second.close();
        },
        join: () => {
          trace.push('join1');
        },
      }),
    );
    registry.register(
      session(life.promise, {
        stop: () => {
          trace.push('stop3');
        },
        join: () => {
          trace.push('join3');
        },
      }),
    );
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    expect(trace).toEqual(['stop2', 'stop1', 'stop3', 'join2', 'join1', 'join3']);
    await retire(life);
    await closing;
  });

  it.each(['clock', 'scheduler'] as const)(
    'a failed %s cannot leave fatal termination without a backstop or acknowledge an owner',
    async (fault) => {
      const clock: InvocationClock = {
        now: () => (fault === 'clock' ? Number.NaN : 0),
        schedule: () => {
          throw new Error('timer unavailable');
        },
      };
      const registry = new InvocationRegistry(clock);
      const life = deferred<OwnerRetirement>();
      const join = vi.fn();
      registry.register(session(life.promise, { join }));
      const closing = registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' });
      expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
      expect(join).not.toHaveBeenCalled();
      expect(registry.activeOwners).toBe(1);
      expect(registry.observations.exitCode()).toBe(9);
      await retire(life);
    },
  );

  it('does not grant sessions a workflow safety callback in the type contract', () => {
    const owner: SessionOwner = {
      ...session(new Promise<OwnerRetirement>(() => undefined)),
      // @ts-expect-error Sessions have no RunDeparture/5–8 health authority.
      readSafetyExit: () => 8,
    };
    expect(owner.kind).toBe('session');
  });
  it('classifies invalid runtime workflow health as infrastructure without acknowledging retirement', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const touched = vi.fn(() => {
      throw new Error('private value must not be inspected');
    });
    const invalidHealth = Object.defineProperties(
      {},
      {
        valueOf: { get: touched },
        toString: { get: touched },
        [Symbol.toPrimitive]: { get: touched },
      },
    );
    const owner: WorkflowOwner = {
      ...session(life.promise),
      kind: 'workflow',
      readSafetyExit: () => undefined,
    };
    expect(Reflect.defineProperty(owner, 'readSafetyExit', { value: () => invalidHealth })).toBe(
      true,
    );
    registry.register(owner);
    registry.sampleWorkflowHealth();
    expect(touched).not.toHaveBeenCalled();
    expect(registry.observations.exitCode()).toBe(9);
    expect(registry.observations.infrastructureCode()).toBe('cli_internal');
    expect(registry.activeOwners).toBe(1);
    expect(() => registry.assertAdmitting()).toThrow();
    expect([...clock.timers].map((timer) => timer.at)).toEqual([3000]);
    const closing = registry.terminate({ kind: 'normal' });
    clock.advanceTo(3000);
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
    await retire(life);
    expect(registry.activeOwners).toBe(0);
  });

  it('counts owned failure-classification time inside the first-fault fatal deadline', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    registry.register(
      session(life.promise, {
        stop: () => {
          throw new Error('first observed fault at time zero');
        },
        classifyFailure: () => {
          // Deterministic elapsed time, not a claim that the registry can preempt blocked JS.
          clock.advanceTo(700);
          return 'cli_internal';
        },
      }),
    );
    const closing = registry.terminate({ kind: 'normal' });
    expect([...clock.timers].map((timer) => timer.at)).toEqual([3000]);
    clock.advanceTo(3000);
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
    expect(registry.activeOwners).toBe(1);
    await retire(life);
  });
  it('does not make an owned operational refusal fatal merely because classification consumed time', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const lease = registry.register(
      session(life.promise, {
        stop: () => {
          throw new Error('owned storage refusal');
        },
        classifyFailure: () => {
          clock.advanceTo(700);
          return 'storage_unavailable';
        },
      }),
    );
    const closing = lease.close();
    expect(clock.timers.size).toBe(0);
    registry.assertAdmitting();
    expect(registry.observations.exitCode()).toBe(1);
    expect(registry.activeOwners).toBe(1);
    await retire(life);
    expect(await closing).toEqual({ kind: 'retired' });
  });
  it('requests finite sibling cancellation after fatal expiry without starting joins or native helpers', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const existingStopTail = deferred<void>();
    const trace: string[] = [];
    const join = vi.fn();
    const mayReap = vi.fn(() => true);
    const reap = vi.fn();
    registry.register(
      session(life.promise, {
        stop: () => {
          trace.push('first-stop');
          clock.advanceTo(3000);
          throw new Error('first stop failed after consuming the budget');
        },
        join,
      }),
    );
    registry.register(
      session(life.promise, {
        stop: (budget) => {
          trace.push(`sibling-cancel:${budget.remainingMs()}`);
          // This observes work already created above; it starts no helper at zero budget.
          return existingStopTail.promise;
        },
        join,
      }),
    );
    registry.register({
      ...session(life.promise),
      kind: 'native-pid',
      stop: (budget) => {
        trace.push(`native-cancel:${budget.remainingMs()}`);
      },
      join,
      mayReap,
      reap,
    });
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    expect(trace).toEqual(['first-stop', 'sibling-cancel:0', 'native-cancel:0']);
    expect(join).not.toHaveBeenCalled();
    expect(mayReap).not.toHaveBeenCalled();
    expect(reap).not.toHaveBeenCalled();
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 3 });
    expect(registry.activeOwners).toBe(3);
    existingStopTail.resolve();
    await retire(life);
    expect(registry.activeOwners).toBe(0);
  });
});

describe('InvocationRegistry native budget and exit capabilities', () => {
  it('delivers the current ordinary budget before native creation without taking the process observer', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const stop = vi.fn();
    const join = vi.fn();
    const budgets: RemainingBudget[] = [];
    const coordinator = vi.fn();
    const remove = registry.observeTermination(coordinator);
    registry.register(
      native(life.promise, {
        stop,
        join,
        budgetChanged: (budget) => {
          budgets.push(budget);
          expect(budget.deadline()).toBeUndefined();
          expect(budget.remainingMs()).toBeUndefined();
        },
      }),
    );
    expect(budgets).toEqual([registry.budget]);
    expect(stop).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
    expect(coordinator).not.toHaveBeenCalled();
    expect(() => registry.observeTermination(() => undefined)).toThrow();
    expect(clock.timers.size).toBe(0);
    await retire(life);
    await registry.terminate({ kind: 'normal' });
    expect(coordinator).toHaveBeenCalled();
    remove();
  });

  it('notifies native owners only for accepted earlier deadlines and actual expiry', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const states: { deadline: number | undefined; remaining: number | undefined }[] = [];
    registry.register(
      native(life.promise, {
        budgetChanged: (budget) => {
          states.push({ deadline: budget.deadline(), remaining: budget.remainingMs() });
        },
      }),
    );
    const closing = registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 1000 });
    clock.advanceTo(100);
    void registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 1000 });
    void registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 2000 });
    void registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' });
    expect(states).toEqual([
      { deadline: undefined, remaining: undefined },
      { deadline: 1000, remaining: 1000 },
    ]);
    void registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 500 });
    clock.advanceTo(500);
    expect(states.slice(2)).toEqual([
      { deadline: 500, remaining: 400 },
      { deadline: 500, remaining: 0 },
    ]);
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
    expect(registry.activeOwners).toBe(1);
    await retire(life);
  });

  it('tightens an already-entered ordinary helper without restarting cleanup or acknowledging native close', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const targetClosed = deferred<OwnerRetirement>();
    const helperClosed = deferred<void>();
    let helperStarted = false;
    let helperCancellation = 0;
    let disarmHelper: (() => void) | undefined;
    const helperDeadline = 10_000;
    const adjustHelper = (budget: RemainingBudget): void => {
      if (!helperStarted) return;
      disarmHelper?.();
      const remaining = budget.remainingMs();
      const delay = Math.min(helperDeadline - clock.time, remaining ?? Number.POSITIVE_INFINITY);
      if (delay <= 0) {
        helperCancellation += 1;
        disarmHelper = undefined;
      } else {
        disarmHelper = clock.schedule(delay, () => {
          helperCancellation += 1;
          disarmHelper = undefined;
        });
      }
    };
    const stop = vi.fn();
    const reap = vi.fn((budget: RemainingBudget) => {
      helperStarted = true;
      adjustHelper(budget);
      return helperClosed.promise;
    });
    const lease = registry.register(
      native(targetClosed.promise, { stop, reap, budgetChanged: adjustHelper }),
    );
    const ordinaryClose = lease.close();
    expect(helperStarted).toBe(true);
    expect([...clock.timers].map((timer) => timer.at)).toEqual([helperDeadline]);
    expect(registry.budget.deadline()).toBeUndefined();
    clock.advanceTo(200);
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    expect([...clock.timers].map((timer) => timer.at)).toEqual([3200, 3200]);
    clock.advanceTo(300);
    void registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 500 });
    expect([...clock.timers].map((timer) => timer.at)).toEqual([500, 500]);
    clock.advanceTo(400);
    void registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' });
    expect([...clock.timers].map((timer) => timer.at)).toEqual([500, 500]);
    expect(stop).toHaveBeenCalledOnce();
    expect(reap).toHaveBeenCalledOnce();
    clock.advanceTo(500);
    expect(helperCancellation).toBe(1);
    expect(await ordinaryClose).toEqual({ kind: 'unacknowledged' });
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
    expect(registry.activeOwners).toBe(1);
    helperClosed.resolve();
    await helperClosed.promise;
    expect(registry.activeOwners).toBe(1);
    await retire(targetClosed);
    expect(registry.activeOwners).toBe(0);
  });

  it('releases native budget and exit callbacks only on actual retirement', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const remaining: (number | undefined)[] = [];
    const exitReap = vi.fn();
    const lease = registry.register(
      native(life.promise, {
        budgetChanged: (budget) => remaining.push(budget.remainingMs()),
        exitReap,
      }),
    );
    const ordinaryClose = lease.close();
    registry.reapNativeAtExit();
    expect(exitReap).toHaveBeenCalledOnce();
    expect(registry.activeOwners).toBe(1);
    await retire(life);
    expect(await ordinaryClose).toEqual({ kind: 'retired' });
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    registry.reapNativeAtExit();
    clock.advanceTo(3000);
    await closing;
    expect(remaining).toEqual([undefined]);
    expect(exitReap).toHaveBeenCalledOnce();
    expect(registry.activeOwners).toBe(0);
  });

  it('isolates fixed budget faults without reading their causes or skipping siblings', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const touched = vi.fn(() => {
      throw new Error('private fault must not be inspected');
    });
    const privateFault = Object.defineProperties(new Error('synthetic callback failure'), {
      message: { get: touched },
      cause: { get: touched },
      stack: { get: touched },
    });
    const classify = vi.fn(() => 'storage_unavailable' as const);
    const stops: number[] = [];
    const states: (number | undefined)[] = [];
    registry.register(
      native(life.promise, {
        classifyFailure: classify,
        stop: () => {
          stops.push(1);
        },
        budgetChanged: (budget) => {
          if (budget.remainingMs() !== undefined) throw privateFault;
        },
      }),
    );
    registry.register(
      native(life.promise, {
        stop: () => {
          stops.push(2);
        },
        budgetChanged: (budget) => {
          states.push(budget.remainingMs());
        },
      }),
    );
    const closing = registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 1000 });
    expect(stops).toEqual([1, 2]);
    expect(states).toEqual([undefined, 1000]);
    expect(touched).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(registry.observations.infrastructureCode()).toBe('cli_internal');
    expect(registry.failureKinds).toBe(1);
    clock.advanceTo(1000);
    expect(states).toEqual([undefined, 1000, 0]);
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 2 });
    await retire(life);
  });

  it('revisits an earlier sibling after a reentrant tightening without restarting the process observer', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const first: (number | undefined)[] = [];
    const second: (number | undefined)[] = [];
    registry.register(
      native(life.promise, {
        budgetChanged: (budget) => {
          first.push(budget.remainingMs());
        },
      }),
    );
    registry.register(
      native(life.promise, {
        budgetChanged: (budget) => {
          second.push(budget.remainingMs());
          if (budget.deadline() === 3000)
            void registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 1000 });
        },
      }),
    );
    const observer = vi.fn();
    const remove = registry.observeTermination(observer);
    const closing = registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' });
    expect(first).toEqual([undefined, 3000, 1000]);
    expect(second).toEqual([undefined, 3000, 1000]);
    expect(registry.budget.deadline()).toBe(1000);
    expect(registry.failureKinds).toBe(0);
    expect(observer).toHaveBeenCalled();
    expect(() => registry.observeTermination(() => undefined)).toThrow();
    await retire(life);
    await closing;
    remove();
  });

  it('bounds repeated self-tightening and delivers a final zero budget to every active native owner', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const sibling: (number | undefined)[] = [];
    const reentrant: (number | undefined)[] = [];
    registry.register(
      native(life.promise, {
        budgetChanged: (budget) => {
          sibling.push(budget.remainingMs());
        },
      }),
    );
    registry.register(
      native(life.promise, {
        budgetChanged: (budget) => {
          reentrant.push(budget.remainingMs());
          const deadline = budget.deadline();
          if (deadline !== undefined)
            void registry.terminate({
              kind: 'signal',
              signalNumber: 15,
              deadline: deadline - 0.001,
            });
        },
      }),
    );
    const closing = registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 1000 });
    expect(reentrant).toHaveLength(4);
    expect(sibling).toHaveLength(4);
    expect(reentrant.at(-1)).toBe(0);
    expect(sibling.at(-1)).toBe(0);
    expect(registry.observations.infrastructureCode()).toBe('cli_internal');
    expect(registry.failureKinds).toBe(1);
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 2 });
    expect(registry.activeOwners).toBe(2);
    await retire(life);
  });

  it.each(['clock', 'scheduler'] as const)(
    'delivers fail-closed expiry after a %s fault and never reads a failed clock after expiry',
    async (fault) => {
      const life = deferred<OwnerRetirement>();
      const now = vi.fn(() => {
        if (fault === 'clock') throw new Error('private unavailable clock');
        return 0;
      });
      const registry = new InvocationRegistry({
        now,
        schedule: () => {
          throw new Error('private unavailable scheduler');
        },
      });
      const states: { deadline: number | undefined; remaining: number | undefined }[] = [];
      registry.register(
        native(life.promise, {
          budgetChanged: (budget) => {
            states.push({ deadline: budget.deadline(), remaining: budget.remainingMs() });
          },
        }),
      );
      expect(states).toEqual([{ deadline: undefined, remaining: undefined }]);
      const closing = registry.terminate({ kind: 'infrastructure', code: 'output_unavailable' });
      expect(states.at(-1)).toEqual({
        deadline: fault === 'clock' ? undefined : 3000,
        remaining: 0,
      });
      const reads = now.mock.calls.length;
      expect(registry.budget.remainingMs()).toBe(0);
      expect(registry.budget.remainingMs()).toBe(0);
      expect(now).toHaveBeenCalledTimes(reads);
      expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
      await retire(life);
    },
  );

  it('expires on a later live-budget clock read failure without throwing through the helper callback', async () => {
    const clock = new ManualClock();
    let failedClock = false;
    const registry = new InvocationRegistry({
      now: () => {
        if (failedClock) throw new Error('private clock failure');
        return clock.time;
      },
      schedule: clock.schedule,
    });
    const life = deferred<OwnerRetirement>();
    const states: (number | undefined)[] = [];
    registry.register(
      native(life.promise, {
        budgetChanged: (budget) => {
          states.push(budget.remainingMs());
        },
      }),
    );
    const closing = registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 1000 });
    failedClock = true;
    expect(registry.budget.remainingMs()).toBe(0);
    expect(states).toEqual([undefined, 1000, 0]);
    expect(registry.observations.infrastructureCode()).toBe('cli_internal');
    expect(await closing).toEqual({ kind: 'deadline', unacknowledgedOwners: 1 });
    await retire(life);
  });

  it('ignores native-shaped budget hooks on other owner kinds at runtime', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    const budgetChanged = vi.fn();
    const sessionOwner = { ...session(life.promise), budgetChanged };
    const terminalOwner = {
      ...session(life.promise),
      kind: 'terminal' as const,
      restore: () => undefined,
      budgetChanged,
    };
    const workflowOwner = {
      ...session(life.promise),
      kind: 'workflow' as const,
      readSafetyExit: () => undefined,
      budgetChanged,
    };
    registry.register(sessionOwner);
    registry.register(terminalOwner);
    registry.register(workflowOwner);
    const closing = registry.terminate({ kind: 'infrastructure', code: 'cli_internal' });
    expect(budgetChanged).not.toHaveBeenCalled();
    await retire(life);
    await closing;
  });

  it('attempts only eligible creation-native exit callbacks without tails, acknowledgement or deadline reset', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const stop = vi.fn();
    const join = vi.fn();
    const reap = vi.fn();
    const restore = vi.fn();
    const readSafetyExit = vi.fn(() => 8 as const);
    const foreignExit = vi.fn();
    const trace: string[] = [];
    for (const kind of ['native-group', 'native-pid', 'windows-live-root'] as const)
      registry.register(
        native(life.promise, {
          kind,
          stop,
          join,
          reap,
          mayReap: () => kind !== 'native-pid',
          exitReap: () => {
            trace.push(kind);
            registry.reapNativeAtExit();
          },
        }),
      );
    const sessionOwner = { ...session(life.promise, { stop, join }), exitReap: foreignExit };
    const terminalOwner = {
      ...session(life.promise, { stop, join }),
      kind: 'terminal' as const,
      restore,
      exitReap: foreignExit,
    };
    const workflowOwner = {
      ...session(life.promise, { stop, join }),
      kind: 'workflow' as const,
      readSafetyExit,
      exitReap: foreignExit,
    };
    registry.register(sessionOwner);
    registry.register(terminalOwner);
    registry.register(workflowOwner);
    registry.reapNativeAtExit();
    expect(trace).toEqual(['native-group', 'windows-live-root']);
    for (const callback of [stop, join, reap, restore, readSafetyExit, foreignExit])
      expect(callback).not.toHaveBeenCalled();
    expect(registry.termination).toBeUndefined();
    expect(registry.budget.deadline()).toBeUndefined();
    expect(clock.timers.size).toBe(0);
    expect(registry.activeOwners).toBe(6);
    registry.assertAdmitting();
    await retire(life);
    registry.reapNativeAtExit();
    expect(trace).toEqual(['native-group', 'windows-live-root']);
    expect(registry.activeOwners).toBe(0);
  });

  it('isolates exit eligibility and callback faults without classification, normal termination or skipped siblings', async () => {
    const clock = new ManualClock();
    const registry = new InvocationRegistry(clock);
    const life = deferred<OwnerRetirement>();
    const classify = vi.fn(() => 'storage_unavailable' as const);
    const exit = vi.fn();
    registry.register(
      native(life.promise, {
        classifyFailure: classify,
        mayReap: () => {
          throw new Error('private eligibility failure');
        },
        exitReap: exit,
      }),
    );
    registry.register(
      native(life.promise, {
        kind: 'native-group',
        classifyFailure: classify,
        exitReap: () => {
          throw new Error('private reap failure');
        },
      }),
    );
    registry.register(native(life.promise, { kind: 'windows-live-root', exitReap: exit }));
    registry.reapNativeAtExit();
    expect(exit).toHaveBeenCalledOnce();
    expect(classify).not.toHaveBeenCalled();
    expect(registry.observations.infrastructureCode()).toBe('cli_internal');
    expect(registry.failureKinds).toBe(2);
    expect(registry.termination).toBeUndefined();
    expect(registry.budget.remainingMs()).toBeUndefined();
    expect(clock.timers.size).toBe(0);
    expect(registry.activeOwners).toBe(3);
    await retire(life);
  });

  it('uses current exit eligibility and frozen callback identity rather than a cached PID decision', async () => {
    const registry = new InvocationRegistry(new ManualClock());
    const life = deferred<OwnerRetirement>();
    let eligible = true;
    const original = vi.fn();
    const replacement = vi.fn();
    const owner = native(life.promise, { mayReap: () => eligible, exitReap: original });
    registry.register(owner);
    expect(Reflect.set(owner, 'exitReap', replacement)).toBe(true);
    eligible = false;
    registry.reapNativeAtExit();
    expect(original).not.toHaveBeenCalled();
    eligible = true;
    registry.reapNativeAtExit();
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    await retire(life);
  });
});
