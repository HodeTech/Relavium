import { describe, expect, it, vi } from 'vitest';
import { captureIo } from '../test-support.js';
import { createCliInvocation } from '../process/invocation.js';
import { CliError } from '../process/cli-error.js';
import { WorkflowLifetime } from './workflow-lifetime.js';

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
