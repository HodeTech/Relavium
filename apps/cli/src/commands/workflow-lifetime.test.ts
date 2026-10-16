import { describe, expect, it, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { captureIo } from '../test-support.js';
import { createCliInvocation } from '../process/invocation.js';
import { CliError } from '../process/cli-error.js';
import { WorkflowLifetime } from './workflow-lifetime.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { createInvocationFiniteExit } from '../process/invocation-finite-exit.js';
import { createNativeProcessController } from '../process/native-process-owner.js';

function fixture() {
  const captured = captureIo();
  const invocation = createCliInvocation({ exit: vi.fn(), setExitCode: vi.fn() });
  let signal: (signo: number) => void = () => undefined;
  const remove = vi.fn();
  const lifetime = new WorkflowLifetime(invocation, captured.io, (listener) => {
    signal = listener;
    return remove;
  });
  return { ...captured, invocation, lifetime, remove, signal: (signo: number) => signal(signo) };
}

describe('workflow command lifetime and bounded shared observations', () => {
  it('physically bounds an autonomous native helper fault without a later workflow failure or signal', async () => {
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
    const advance = (time: number): void => {
      now = time;
      for (const [fire, at] of [...timers]) if (at <= now && timers.delete(fire)) fire();
    };
    const registry = new InvocationRegistry(clock);
    const exit = vi.fn();
    const finiteExit = createInvocationFiniteExit(registry, clock, { exit, setExitCode: vi.fn() });
    const lifetime = new WorkflowLifetime(
      { registry, finiteExit, seedFileCatalogOnce: () => Promise.resolve() },
      captureIo().io,
      () => () => undefined,
    );
    let releaseBody: (code: 0) => void = () => undefined;
    const body = new Promise<0>((resolve) => {
      releaseBody = resolve;
    });
    let settled = false;
    const work = lifetime.execute(() => body);
    void work.then(() => {
      settled = true;
    });
    const target = new ChildProcess();
    Object.defineProperty(target, 'pid', { value: 70 });
    vi.spyOn(target, 'kill').mockReturnValue(true);
    const helper = new ChildProcess();
    vi.spyOn(helper, 'kill').mockReturnValue(true);
    const controller = createNativeProcessController(registry, {
      platform: 'win32',
      now: clock.now,
      schedule: clock.schedule,
      signal: () => undefined,
      verifyWindows: () => Promise.resolve({ spawn: () => helper }),
      subscribeExit: () => () => undefined,
    });
    const native = await controller.reserve('pid');
    native.bindChild(target);
    void native.stop();
    advance(500);
    helper.emit('error', new Error('PRIVATE_AUTONOMOUS_HELPER_FAULT'));
    expect(lifetime.signal.aborted).toBe(true);
    expect(registry.budget.deadline()).toBe(3500);
    advance(3499);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exit).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    advance(3500);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(exit, 'WORKFLOW_AUTONOMOUS_NATIVE_EXIT').toHaveBeenCalledExactlyOnceWith(9);
    expect(registry.budget.deadline()).toBe(3500);
    expect(registry.activeOwners).toBeGreaterThanOrEqual(2);
    expect(settled).toBe(false);
    target.emit('close', null);
    helper.emit('close', 0);
    await native.whenClosed;
    releaseBody(0);
    expect(await work).toBe(9);
    expect(registry.activeOwners).toBe(0);
    expect(exit).toHaveBeenCalledOnce();
  });
  it('reserves both owners before the first preparation, and retires them after actual body/terminal cleanup', async () => {
    const f = fixture();
    expect(f.invocation.registry.activeOwners).toBe(2);
    expect(await f.lifetime.execute(() => Promise.resolve(0))).toBe(0);
    expect(f.invocation.registry.activeOwners).toBe(0);
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.out()).toBe('');
  });
  it('a first SIGINT cooperatively stops preparation with an identity-owned marker, without starting the finite exit', async () => {
    const f = fixture();
    expect(
      await f.lifetime.execute(() => {
        f.signal(2);
        expect(f.lifetime.signal.aborted).toBe(true);
        expect(f.invocation.registry.termination).toBeUndefined();
        f.lifetime.checkpoint();
        return Promise.resolve(0);
      }),
    ).toBe(1);
    expect(f.invocation.registry.activeOwners).toBe(0);
  });
  it('an unrelated failure racing cancellation keeps its own fixed infrastructure classification', async () => {
    const f = fixture();
    const fault = new Error('PRIVATE_FAILURE_AFTER_ABORT');
    await expect(
      f.lifetime.execute(() => {
        f.signal(2);
        throw fault;
      }),
    ).rejects.toBe(fault);
    expect(f.invocation.registry.observations.exitCode()).toBe(9);
    expect(f.invocation.registry.activeOwners).toBe(0);
  });
  it.each([8, 7, 5, 6] as const)(
    'actual published health %s outranks a later opaque/falsy throw and survives retirement',
    async (safety) => {
      const f = fixture();
      expect(
        await f.lifetime.execute(() => {
          f.lifetime.publish(safety, true);
          // Hostile embeddings may throw undefined; presence must not be tested by truthiness.
          return new Promise<never>((_resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Adversarial boundary regression: a foreign promise can reject undefined.
            reject(undefined);
          });
        }),
      ).toBe(safety);
      expect(f.invocation.registry.activeOwners).toBe(0);
      expect(f.invocation.registry.observations.exitCode()).toBe(safety);
    },
  );
  it('never downgrades stronger earlier health and preserves safe outcomes from a later success', async () => {
    const f = fixture();
    expect(
      await f.lifetime.execute(() => {
        f.lifetime.publish(7, true);
        f.lifetime.publish(5, true);
        return Promise.resolve(0);
      }),
    ).toBe(7);
    expect(f.invocation.registry.observations.exitCode()).toBe(7);
  });
  it('a competing infrastructure fault outranks an escaping operational refusal without losing its private cause', async () => {
    const f = fixture();
    const primary = new CliError('invalid_invocation', 'bounded fixture refusal');
    await expect(
      f.lifetime.execute(() => {
        f.lifetime.failure(new Error('PRIVATE_SECONDARY_FAULT'));
        throw primary;
      }),
    ).rejects.toMatchObject({ code: 'cli_internal', exitCode: 9, cause: primary });
    expect(f.invocation.registry.observations.exitCode()).toBe(9);
  });
  it('a cleanup rejection does not retire a workflow or remove its terminating-signal capability', async () => {
    const f = fixture();
    let finished = false;
    const work = f.lifetime.execute(() => {
      f.lifetime.cleanupFailed(new Error('PRIVATE_CLOSE'));
      return Promise.resolve(0);
    });
    void work.then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.invocation.registry.activeOwners).toBe(1);
    expect(f.invocation.registry.observations.exitCode()).toBe(9);
  });
});

it('publishes a returned infrastructure exit before owner retirement instead of turning it into success', async () => {
  const f = fixture();
  expect(await f.lifetime.execute(() => Promise.resolve(9))).toBe(9);
  expect(f.invocation.registry.observations.exitCode()).toBe(9);
  expect(f.invocation.registry.activeOwners).toBe(0);
});
