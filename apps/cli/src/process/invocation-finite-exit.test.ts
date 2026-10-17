import { describe, expect, it, vi } from 'vitest';
import { OwnedTtyOutput } from '../test-support.js';
import { createInvocationFiniteExit } from './invocation-finite-exit.js';
import {
  InvocationRegistry,
  type InvocationClock,
  type OwnerRetirement,
} from './invocation-registry.js';
import { installNativeInvocation } from './native-invocation.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Clock implements InvocationClock {
  time = 0;
  readonly timers = new Set<{ at: number; fire: () => void }>();
  readonly now = () => this.time;
  readonly schedule = (ms: number, fire: () => void) => {
    const timer = { at: this.time + ms, fire };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  };
  advance(time: number) {
    this.time = time;
    for (const timer of [...this.timers])
      if (timer.at <= time && this.timers.delete(timer)) timer.fire();
  }
}
function fixture() {
  const clock = new Clock();
  const registry = new InvocationRegistry(clock);
  const exit = vi.fn();
  const finite = createInvocationFiniteExit(registry, clock, { setExitCode: vi.fn(), exit });
  return { clock, registry, exit, finite };
}
function heldOwner(registry: InvocationRegistry, stop = vi.fn()) {
  const life = deferred<OwnerRetirement>();
  registry.register({
    kind: 'session',
    surface: 'chat',
    retired: life.promise,
    stop,
    join: () => undefined,
    classifyFailure: () => 'cli_internal',
  });
  return life;
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('invocation finite exit and explicit native handoff', () => {
  it('bounds forced cooperative chat end4 without recording a terminating signal or acknowledging held cleanup', async () => {
    const f = fixture();
    const life = heldOwner(f.registry);
    f.finite.cooperativeCancel(4);
    expect(f.registry.observations.hasTerminatingSignal()).toBe(false);
    expect(f.registry.observations.exitCode()).toBe(4);
    expect(f.registry.budget.deadline()).toBe(3000);
    f.clock.advance(900);
    f.finite.cooperativeCancel(4);
    expect(f.registry.budget.deadline(), 'CHAT_FORCE_END_SINGLE_FINITE_BUDGET').toBe(3000);
    f.clock.advance(3000);
    expect(await f.finite.exited).toBe(4);
    expect(f.registry.activeOwners).toBe(1);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(4);
    life.resolve({ kind: 'settled' });
  });

  it('exits forced cooperative end4 early only after every real owner retires', async () => {
    const f = fixture();
    const life = heldOwner(f.registry);
    f.finite.cooperativeCancel(4);
    await turn();
    expect(f.exit).not.toHaveBeenCalled();
    life.resolve({ kind: 'settled' });
    expect(await f.finite.exited).toBe(4);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('a competing fatal upgrades cooperative end to9 under the same original deadline', async () => {
    const f = fixture();
    const life = heldOwner(f.registry);
    f.finite.cooperativeCancel(4);
    f.clock.advance(700);
    f.finite.fail('cli_internal');
    life.resolve({ kind: 'settled' });
    await turn();
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(f.exit, 'CHAT_FORCE_END_CANNOT_SKIP_FATAL_DIAGNOSTIC').not.toHaveBeenCalled();
    f.clock.advance(3000);
    expect(await f.finite.exited).toBe(9);
  });

  it('hands cooperative end4 to native finalization without a signal or spurious diagnostic', async () => {
    const f = fixture();
    const life = heldOwner(f.registry);
    const stdout = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    f.finite.cooperativeCancel(4);
    const native = installNativeInvocation(
      f.registry,
      { json: true, verbosity: 'normal' },
      {
        stdout,
        stderr,
        schedule: f.clock.schedule,
        onFatal: () => () => undefined,
        onBackground: () => () => undefined,
        readExitCode: () => undefined,
        setExitCode: vi.fn(),
        exit: vi.fn(),
      },
      f.finite,
    );
    await turn();
    expect(f.exit).not.toHaveBeenCalled();
    life.resolve({ kind: 'settled' });
    expect(await f.finite.exited).toBe(4);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(4);
    expect(stderr.frames).toEqual([]);
    native.dispose();
    stdout.destroy();
    stderr.destroy();
  });

  it('starts the shared clock at the first owned fault and never exits before cleanup diagnostics can run', async () => {
    const f = fixture();
    const life = heldOwner(f.registry);
    f.finite.fail('cli_internal');
    expect(f.registry.budget.deadline(), 'WORKFLOW_FIRST_FAULT_BUDGET').toBe(3000);
    f.clock.advance(1200);
    f.finite.signal(15);
    life.resolve({ kind: 'settled' });
    await turn();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(f.exit, 'WORKFLOW_FATAL_DIAGNOSTIC_ORDER').not.toHaveBeenCalled();
    f.clock.advance(2999);
    await turn();
    expect(f.exit).not.toHaveBeenCalled();
    f.clock.advance(3000);
    expect(await f.finite.exited).toBe(9);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
  });

  it('hands an owned fault to native ACK finalization without renewing or double-exiting', async () => {
    const f = fixture();
    const life = heldOwner(f.registry);
    f.finite.fail('output_unavailable');
    f.clock.advance(700);
    const changed = vi.fn();
    const dispose = f.finite.handoff(f.registry, changed);
    life.resolve({ kind: 'settled' });
    await turn();
    expect(changed).toHaveBeenCalled();
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.registry.budget.deadline()).toBe(3000);
    f.finite.exitNow(); // Represents the later native finalizer's positive diagnostic ACK.
    expect(await f.finite.exited).toBe(9);
    f.clock.advance(5000);
    await turn();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    dispose();
  });
  it('constructs without taking the observer or arming timers', () => {
    const f = fixture();
    expect(f.clock.timers.size).toBe(0);
    expect(f.registry.termination).toBeUndefined();
    const remove = f.registry.observeTermination(() => undefined);
    remove();
    expect(f.exit).not.toHaveBeenCalled();
  });
  it('explicit fallback activation stays timer-free and never exits for ordinary termination', async () => {
    const f = fixture();
    f.finite.activateFallback();
    f.finite.activateFallback();
    expect(f.clock.timers.size).toBe(0);
    expect(f.registry.termination).toBeUndefined();
    await f.registry.terminate({ kind: 'normal' });
    await turn();
    expect(f.exit, 'WORKFLOW_ORDINARY_NO_EXIT').not.toHaveBeenCalled();
    expect(f.clock.timers.size).toBe(0);
    f.finite.signal(15);
    expect(await f.finite.exited).toBe(143);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(143);
  });
  it.each([2, 15, 1, 3])(
    'physically bounds signal %s without acknowledging a held owner',
    async (signal) => {
      const f = fixture();
      const life = heldOwner(f.registry);
      f.finite.signal(signal);
      f.clock.advance(2999);
      await turn();
      expect(f.exit).not.toHaveBeenCalled();
      f.clock.advance(3000);
      expect(await f.finite.exited).toBe(128 + signal);
      expect(f.registry.activeOwners).toBe(1);
      f.finite.exitNow();
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(128 + signal);
      life.resolve({ kind: 'settled' });
    },
  );
  it('requests every stop before physical expiry, preserves stronger real health and the earlier deadline', async () => {
    const f = fixture();
    const life = deferred<OwnerRetirement>();
    const trace: string[] = [];
    let safety: 5 | 8 = 5;
    f.registry.register({
      kind: 'workflow',
      retired: life.promise,
      readSafetyExit: () => safety,
      stop: () => {
        trace.push('workflow');
        f.clock.advance(700);
      },
      join: () => undefined,
      classifyFailure: () => 'cli_internal',
    });
    heldOwner(
      f.registry,
      vi.fn(() => trace.push('sibling')),
    );
    f.exit.mockImplementation(() => trace.push('exit'));
    void f.registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 700 });
    f.finite.signal(2);
    safety = 8;
    expect(f.registry.budget.deadline()).toBe(700);
    expect(trace).toEqual(['workflow', 'sibling']);
    expect(await f.finite.exited).toBe(8);
    expect(trace).toEqual(['workflow', 'sibling', 'exit']);
    life.resolve({ kind: 'settled' });
  });
  it('rejects malformed signals before partial activation and converts a broken clock to finite infrastructure exit', async () => {
    const f = fixture();
    for (const value of [0, 128, NaN, Infinity, 2.5])
      expect(() => f.finite.signal(value)).toThrow();
    expect(f.registry.termination).toBeUndefined();
    f.clock.time = NaN;
    expect(() => f.finite.signal(15)).not.toThrow();
    expect(await f.finite.exited).toBe(9);
  });
  it('invalidates a queued fallback completion when custody is handed off, and never revives it on disposal', async () => {
    const f = fixture();
    f.finite.signal(15);
    await Promise.resolve();
    const notify = vi.fn();
    const dispose = f.finite.handoff(f.registry, notify);
    await turn();
    expect(notify).toHaveBeenCalled();
    expect(f.exit).not.toHaveBeenCalled();
    expect(() => f.finite.handoff(new InvocationRegistry(f.clock), notify)).toThrow();
    expect(() => f.finite.handoff(f.registry, notify)).toThrow();
    dispose();
    f.clock.advance(9000);
    await turn();
    expect(f.exit).not.toHaveBeenCalled();
  });
  it('hands an existing deadline to native diagnosis, holds its actual ACK and uses exactly the shared physical exit', async () => {
    const f = fixture();
    const life = heldOwner(f.registry);
    class Held extends OwnedTtyOutput {
      readonly entered = deferred<void>();
      acknowledge: () => void = () => undefined;
      override _write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        this.frames.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        this.acknowledge = callback;
        this.entered.resolve();
      }
    }
    const stderr = new Held();
    const stdout = new OwnedTtyOutput();
    const wrongExit = vi.fn();
    f.finite.signal(15);
    f.clock.advance(1200);
    const native = installNativeInvocation(
      f.registry,
      { json: true, verbosity: 'normal' },
      {
        stdout,
        stderr,
        schedule: f.clock.schedule,
        onFatal: () => () => undefined,
        onBackground: () => () => undefined,
        readExitCode: () => undefined,
        setExitCode: vi.fn(),
        exit: wrongExit,
      },
      f.finite,
    );
    try {
      native.fail('cli_internal');
      life.resolve({ kind: 'settled' });
      await stderr.entered.promise;
      expect(f.registry.budget.deadline()).toBe(3000);
      expect(f.exit).not.toHaveBeenCalled();
      f.clock.advance(3000);
      expect(await native.finished).toBe(9);
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
      expect(wrongExit).not.toHaveBeenCalled();
      stderr.acknowledge();
      await turn();
      expect(f.exit).toHaveBeenCalledOnce();
    } finally {
      native.dispose();
      stdout.destroy();
      stderr.destroy();
    }
  });
});
