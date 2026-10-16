import { describe, expect, it, vi } from 'vitest';

import {
  InvocationRegistry,
  type InvocationClock,
  type InvocationCloseResult,
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
