import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedTtyOutput } from '../test-support.js';
import {
  InvocationRegistry,
  type InvocationClock,
  type OwnerRetirement,
  type SessionOwner,
} from './invocation-registry.js';
import { installNativeInvocation, type NativeInvocationPorts } from './native-invocation.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class Clock implements InvocationClock {
  time = 0;
  readonly timers = new Set<{ at: number; fire: () => void }>();
  readonly now = () => this.time;
  readonly schedule = (milliseconds: number, fire: () => void) => {
    const timer = { at: this.time + milliseconds, fire };
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

class HeldOutput extends OwnedTtyOutput {
  readonly entered = deferred<void>();
  acknowledge: (error?: Error | null) => void = () => undefined;
  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.frames.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    this.acknowledge = callback;
    this.entered.resolve();
  }
}

function owner(retired: Promise<OwnerRetirement>, extra: Partial<SessionOwner> = {}): SessionOwner {
  return {
    kind: 'session',
    surface: 'chat',
    retired,
    stop: () => undefined,
    join: () => undefined,
    classifyFailure: () => 'cli_internal',
    ...extra,
  };
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function fixture(stderr: OwnedTtyOutput = new OwnedTtyOutput(), stdout = new OwnedTtyOutput()) {
  const clock = new Clock();
  const registry = new InvocationRegistry(clock);
  let fatal: () => void = () => undefined;
  let background: (reason: unknown) => void = () => undefined;
  let exitCode: string | number | undefined;
  const exit = vi.fn();
  const removeFatal = vi.fn();
  const removeBackground = vi.fn();
  const ports: NativeInvocationPorts = {
    stdout,
    stderr,
    schedule: clock.schedule,
    onFatal: (listener) => {
      fatal = listener;
      return removeFatal;
    },
    onBackground: (listener) => {
      background = listener;
      return removeBackground;
    },
    readExitCode: () => exitCode,
    setExitCode: (code) => {
      exitCode = code;
    },
    exit,
  };
  const native = installNativeInvocation(registry, { json: true, verbosity: 'verbose' }, ports);
  cleanup.push(() => {
    native.dispose();
    stdout.destroy();
    stderr.destroy();
  });
  return {
    registry,
    clock,
    native,
    stdout,
    stderr,
    fatal: () => fatal(),
    background: (reason: unknown) => background(reason),
    exit,
    exitCode: () => exitCode,
    removeFatal,
    removeBackground,
  };
}

describe('inert native invocation foundation', () => {
  it('registers captured hooks without installing global process listeners and disposes them once', () => {
    const before = [
      process.listenerCount('uncaughtException'),
      process.listenerCount('unhandledRejection'),
    ];
    const f = fixture();
    expect([
      process.listenerCount('uncaughtException'),
      process.listenerCount('unhandledRejection'),
    ]).toEqual(before);
    f.native.dispose();
    f.native.dispose();
    expect(f.removeFatal).toHaveBeenCalledOnce();
    expect(f.removeBackground).toHaveBeenCalledOnce();
    expect(f.stdout.listenerCount('error')).toBe(0);
    expect(f.stderr.listenerCount('error')).toBe(0);
  });

  it('autonomously observes an individual owner close fault while runtime work stays unresolved', async () => {
    const f = fixture();
    const life = deferred<OwnerRetirement>();
    const stop = vi.fn();
    const runtime = deferred<void>();
    const lease = f.registry.register(
      owner(life.promise, {
        stop,
        join: () => {
          throw new Error('opaque join fault');
        },
      }),
    );
    const closing = lease.close();
    expect(f.registry.termination).toBeDefined();
    expect(() => f.registry.assertAdmitting()).toThrow();
    f.clock.advance(3000);
    expect(await f.native.finished).toBe(9);
    expect(await closing).toEqual({ kind: 'unacknowledged' });
    expect(f.registry.activeOwners).toBe(1);
    expect(stop).toHaveBeenCalledOnce();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(f.stderr.frames).toEqual([]); // Deadline does not begin a new flush.
    runtime.resolve();
    life.resolve({ kind: 'settled' });
  });

  it('keeps the original deadline through owner retirement and held final diagnostic ACK', async () => {
    const stderr = new HeldOutput();
    const f = fixture(stderr);
    const life = deferred<OwnerRetirement>();
    const stop = vi.fn();
    f.registry.register(owner(life.promise, { stop }));
    f.native.fail('cli_internal');
    f.clock.advance(1900);
    life.resolve({ kind: 'settled' });
    await stderr.entered.promise;
    expect(f.registry.activeOwners).toBe(0);
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(f.registry.budget.remainingMs()).toBe(1100);
    expect(f.exit).not.toHaveBeenCalled();
    f.native.fail('cli_internal');
    f.clock.advance(2999);
    expect(f.exit).not.toHaveBeenCalled();
    f.clock.advance(3000);
    expect(await f.native.finished).toBe(9);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(stderr.frames).toHaveLength(1);
    expect(stop).toHaveBeenCalledOnce();
    stderr.acknowledge();
  });

  it('tightens the native backstop on a later absolute signal deadline without restarting diagnosis', async () => {
    const stderr = new HeldOutput();
    const f = fixture(stderr);
    f.native.fail('cli_internal');
    await stderr.entered.promise;
    f.clock.advance(100);
    f.native.signal(15, 700);
    expect(f.registry.budget.deadline()).toBe(700);
    f.clock.advance(700);
    expect(await f.native.finished).toBe(9);
    expect(stderr.frames).toHaveLength(1);
    stderr.acknowledge();
  });

  it('finishes normal cleanup with the actual published outcome and no forced native exit', async () => {
    const f = fixture();
    f.registry.observations.observeOutcome(3);
    expect(await f.native.complete()).toBe(3);
    expect(f.exitCode()).toBe(3);
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.stderr.frames).toEqual([]);
  });

  it('starts one fatal budget after normal owner settlement when a later real stream fails', async () => {
    const f = fixture();
    expect(await f.native.complete()).toBe(0);
    f.clock.advance(4000);
    f.stdout.emit('error', new Error('opaque native failure'));
    expect(f.registry.budget.deadline()).toBe(7000);
    // Delivery, rather than the already-resolved complete promise, is the exit barrier.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.exit, 'NATIVE_FINALIZATION_LATE_FAULT').toHaveBeenCalledExactlyOnceWith(9);
    expect(f.stderr.frames.join('')).toContain('output_unavailable');
  });

  it.each(['stdout', 'stderr'] as const)(
    'observes direct %s errors and never redirects diagnosis to stdout',
    async (sink) => {
      const f = fixture();
      f[sink].emit('error', new Error('private output canary'));
      expect(await f.native.finished).toBe(9);
      expect(f.stdout.frames).toEqual([]);
      if (sink === 'stderr') expect(f.stderr.frames).toEqual([]);
      else expect(f.stderr.frames.join('')).toContain('output_unavailable');
      expect(f.stderr.frames.join('')).not.toContain('canary');
    },
  );

  it.each(['stdout', 'stderr'] as const)(
    'detects an already ended %s at installation',
    async (sink) => {
      const stdout = new OwnedTtyOutput();
      const stderr = new OwnedTtyOutput();
      const stream = sink === 'stdout' ? stdout : stderr;
      await new Promise<void>((resolve) => stream.end(resolve));
      const f = fixture(stderr, stdout);
      expect(await f.native.finished).toBe(9);
      expect(stdout.frames).toEqual([]);
      if (sink === 'stderr') expect(stderr.frames).toEqual([]);
    },
  );

  it('treats failed diagnostic callback as output failure without retry or stdout fallback', async () => {
    const stderr = new HeldOutput();
    const f = fixture(stderr);
    f.native.fail('cli_internal');
    await stderr.entered.promise;
    stderr.acknowledge(new Error('private callback details'));
    expect(await f.native.finished).toBe(9);
    expect(f.registry.observations.infrastructureCode()).toBe('output_unavailable');
    expect(stderr.frames).toHaveLength(1);
    expect(f.stdout.frames).toEqual([]);
  });

  it('restores terminal custody before the single final diagnosis and ignores opaque fatal reasons', async () => {
    const f = fixture();
    const terminal = deferred<OwnerRetirement>();
    const trace: string[] = [];
    f.stderr.onFrame = () => trace.push('diagnostic');
    f.registry.register({
      ...owner(terminal.promise),
      kind: 'terminal',
      stop: () => {
        trace.push('stop');
      },
      restore: () => {
        trace.push('restore');
        terminal.resolve({ kind: 'settled' });
      },
    });
    f.fatal();
    f.fatal();
    f.native.fail('output_unavailable');
    expect(await f.native.finished).toBe(9);
    expect(trace).toEqual(['stop', 'restore', 'diagnostic']);
    expect(f.stderr.frames).toHaveLength(1);
    expect(f.exit).toHaveBeenCalledOnce();
  });

  it('preserves background keepalive without sealing admission or forcing exit', async () => {
    const f = fixture();
    const touched = vi.fn(() => {
      throw new Error('private getter');
    });
    const hostile = Object.defineProperties(
      {},
      { message: { get: touched }, stack: { get: touched }, cause: { get: touched } },
    );
    for (let index = 0; index < 10_000; index++) f.background(hostile);
    f.registry.assertAdmitting();
    expect(f.registry.termination).toBeUndefined();
    expect(f.exit).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.stderr.frames).toHaveLength(6);
    expect(await f.native.complete()).toBe(9);
    expect(f.exit).not.toHaveBeenCalled();
  });

  it('samples actual workflow safety again at deadline despite competing fatal, output and signal facts', async () => {
    const f = fixture();
    const life = deferred<OwnerRetirement>();
    let safety: 5 | 8 = 5;
    f.registry.register({ ...owner(life.promise), kind: 'workflow', readSafetyExit: () => safety });
    f.native.signal(15, 3000);
    f.native.fail('cli_internal');
    f.native.fail('output_unavailable');
    safety = 8;
    f.clock.advance(3000);
    expect(await f.native.finished).toBe(8);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(8);
    expect(f.registry.activeOwners).toBe(1);
    life.resolve({ kind: 'settled' });
  });

  it('does not preempt sibling finite stop requests when the first stop consumes the entire deadline', async () => {
    const f = fixture();
    const life = deferred<OwnerRetirement>();
    const trace: string[] = [];
    f.exit.mockImplementation(() => trace.push('exit'));
    f.registry.register(
      owner(life.promise, {
        stop: () => {
          trace.push('first');
          f.clock.advance(3000);
        },
      }),
    );
    f.registry.register(
      owner(life.promise, {
        stop: (budget) => {
          trace.push(`second:${budget.remainingMs()}`);
        },
      }),
    );
    f.native.fail('cli_internal');
    expect(trace).toEqual(['first', 'second:0']);
    expect(await f.native.finished).toBe(9);
    expect(trace).toEqual(['first', 'second:0', 'exit']);
    life.resolve({ kind: 'settled' });
  });
});
