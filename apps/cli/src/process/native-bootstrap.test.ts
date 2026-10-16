import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureIo, OwnedTtyOutput } from '../test-support.js';
import type { ExitCode } from './exit-codes.js';
import type { OwnerRetirement } from './invocation-registry.js';
import { invocationFixture } from './invocation.test-support.js';
import { startNativeCli } from './native-bootstrap.js';
import { SignalCustody, subscribeWithSignalCustody } from './signal-custody.js';
import type { NativeInvocationPorts } from './native-invocation.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const f = invocationFixture();
  const invocation = { ...f.invocation, signalCustody: new SignalCustody() };
  const stdout = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  let fatal = (): void => undefined;
  let background: (reason: unknown) => void = () => undefined;
  let signal: (signo: number) => void = () => undefined;
  let exitCode: number | undefined;
  const removeSignals = vi.fn();
  const ports: NativeInvocationPorts = {
    stdout,
    stderr,
    schedule: () => () => undefined, // The original finite authority owns the clock/backstop.
    onFatal: (listener) => {
      fatal = listener;
      return () => undefined;
    },
    onBackground: (listener) => {
      background = listener;
      return () => undefined;
    },
    readExitCode: () => exitCode,
    setExitCode: (code) => {
      exitCode = code;
    },
    exit: vi.fn(), // A second physical exit authority must never be used.
  };
  const { io } = captureIo();
  const start = (load: Parameters<typeof startNativeCli>[4], args: string[] = []) => {
    const native = startNativeCli(
      ['node', 'relavium', ...args],
      io,
      invocation,
      ports,
      load,
      (listener) => {
        signal = listener;
        return removeSignals;
      },
    );
    cleanups.push(() => {
      native.dispose();
      stdout.destroy();
      stderr.destroy();
    });
    return native;
  };
  return {
    ...f,
    invocation,
    start,
    stderr,
    ports,
    fatal: () => fatal(),
    background: (cause: unknown) => background(cause),
    signal: (signo: number) => signal(signo),
    exitCode: () => exitCode,
  };
}

describe('native product bootstrap', () => {
  it.each([0, 1, 2, 3, 4, 6] satisfies ExitCode[])(
    'settles the actual entry root before normal exit %s',
    async (code) => {
      const f = fixture();
      const native = f.start(() => Promise.resolve({ run: () => Promise.resolve(code) }));
      expect(await native.finished).toBe(code);
      expect(f.registry.activeOwners).toBe(0);
      expect(f.exitCode()).toBe(code);
      expect(f.exit).not.toHaveBeenCalled();
      expect(f.ports.exit).not.toHaveBeenCalled();
    },
  );

  it.each([{ args: [] }, { args: ['--json', '--verbose'] }])(
    'reports a loader rejection once without its private text (%j)',
    async ({ args }) => {
      const f = fixture();
      const native = f.start(() => Promise.reject(new Error('PRIVATE_LOADER_FAILURE')), args);
      expect(await native.finished).toBe(9);
      const text = f.stderr.frames.join('');
      expect(text).toContain(args.length === 0 ? 'relavium:' : '"code":"cli_internal"');
      expect(text).not.toContain('PRIVATE_LOADER_FAILURE');
      expect(f.stderr.frames).toHaveLength(1);
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
      expect(f.registry.activeOwners).toBe(0);
    },
  );

  it('keeps a held runtime import owned until the original fatal deadline and refuses its late entry', async () => {
    const f = fixture();
    const loaded = deferred<{ run: (typeof import('../run.js'))['run'] }>();
    const run = vi.fn(() => Promise.resolve<ExitCode>(0));
    const native = f.start(() => loaded.promise);
    expect(f.registry.activeOwners).toBe(1);
    f.fatal();
    expect(f.registry.budget.deadline()).toBe(3000);
    f.advance(3000);
    expect(await native.finished).toBe(9);
    expect(f.registry.activeOwners).toBe(1);
    expect(f.stderr.frames).toEqual([]);
    loaded.resolve({ run });
    await vi.waitFor(() => expect(f.registry.activeOwners).toBe(0));
    expect(run, 'BOOTSTRAP_STOPPED_IMPORT_HAS_NO_RUNTIME_ENTRY').not.toHaveBeenCalled();
    expect(f.exit).toHaveBeenCalledOnce();
  });

  it('preserves SIGTERM during a suspended import without reclassifying cancellation as infrastructure', async () => {
    const f = fixture();
    const loaded = deferred<{ run: (typeof import('../run.js'))['run'] }>();
    const run = vi.fn(() => Promise.resolve<ExitCode>(0));
    const native = f.start(() => loaded.promise);
    f.signal(15);
    loaded.resolve({ run });
    expect(await native.finished).toBe(143);
    expect(run).not.toHaveBeenCalled();
    expect(f.registry.observations.hasInfrastructureFailure()).toBe(false);
    expect(f.stderr.frames).toEqual([]);
  });

  it('upgrades an unrelated loader failure racing a terminating signal', async () => {
    const f = fixture();
    const loaded = deferred<{ run: (typeof import('../run.js'))['run'] }>();
    const native = f.start(() => loaded.promise);
    f.signal(15);
    loaded.reject(new Error('PRIVATE_RACING_LOADER_FAILURE'));
    expect(await native.finished).toBe(9);
    expect(f.stderr.frames.join('')).not.toContain('PRIVATE_RACING_LOADER_FAILURE');
  });

  it('yields first Ctrl-C to explicit runtime custody and covers the later gap', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const done = deferred<void>();
    const runtimeSignal = vi.fn();
    let callback: (signo: number) => void = () => undefined;
    const native = f.start(() =>
      Promise.resolve({
        run: async () => {
          const remove = subscribeWithSignalCustody(
            f.invocation.signalCustody,
            (listener) => {
              callback = listener;
              return () => undefined;
            },
            runtimeSignal,
          );
          entered.resolve();
          await done.promise;
          remove();
          f.signal(15); // Actual surface released its net; the original bootstrap fallback resumes custody.
          return 0;
        },
      }),
    );
    await entered.promise;
    f.signal(2);
    callback(2);
    expect(runtimeSignal).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.registry.termination).toBeUndefined();
    done.resolve();
    expect(await native.finished).toBe(143);
  });

  it('retains real workflow health over a later infrastructure failure without minting health from a return code', async () => {
    const f = fixture();
    const native = f.start(() =>
      Promise.resolve({
        run: () => {
          const retired = deferred<OwnerRetirement>();
          f.registry.register({
            kind: 'workflow',
            retired: retired.promise,
            stop: () => retired.resolve({ kind: 'settled' }),
            join: () => undefined,
            readSafetyExit: () => 8,
            classifyFailure: () => 'cli_internal',
          });
          throw new Error('PRIVATE_AFTER_PAID_WORK');
        },
      }),
    );
    expect(await native.finished).toBe(8);
    expect(f.stderr.frames.join('')).not.toContain('PRIVATE_AFTER_PAID_WORK');
    const forged = fixture();
    const invalid = forged.start(() => Promise.resolve({ run: () => Promise.resolve(8) }));
    expect(await invalid.finished).toBe(9);
  });

  it('keeps background keepalive observation after normal completion without overwriting an established nonzero', async () => {
    const f = fixture();
    const native = f.start(() => Promise.resolve({ run: () => Promise.resolve(2) }));
    expect(await native.finished).toBe(2);
    f.background(new Error('PRIVATE_BACKGROUND_REASON'));
    await vi.waitFor(() => expect(f.stderr.frames).toHaveLength(1));
    expect(f.exitCode()).toBe(2);
    expect(f.stderr.frames.join('')).not.toContain('PRIVATE_BACKGROUND_REASON');
    expect(f.exit).not.toHaveBeenCalled();
  });

  it('does not escalate a background-only exit 9 returned by a completed runtime surface into fatal shutdown', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const done = deferred<void>();
    const native = f.start(() =>
      Promise.resolve({
        run: async () => {
          entered.resolve();
          await done.promise;
          return 9;
        },
      }),
    );
    await entered.promise;
    f.background(new Error('PRIVATE_RECOVERABLE_BACKGROUND'));
    await vi.waitFor(() => expect(f.stderr.frames).toHaveLength(1));
    done.resolve();
    expect(await native.finished).toBe(9);
    expect(f.registry.observations.hasInfrastructureFailure()).toBe(false);
    expect(f.registry.budget.deadline()).toBeUndefined();
    expect(f.stderr.frames).toHaveLength(1);
    expect(f.exit).not.toHaveBeenCalled();
  });
});
