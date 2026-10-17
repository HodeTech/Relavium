import { describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/cli-error.js';
import { createInvocationFiniteExit } from '../process/invocation-finite-exit.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { captureIo } from '../test-support.js';
import { runSessionPrompt } from './session-prompt.js';
import { SessionTerminalOwner } from './session-terminal-owner.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fixture() {
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
  const registry = new InvocationRegistry(clock);
  const exit = vi.fn();
  const invocation = {
    registry,
    finiteExit: createInvocationFiniteExit(registry, clock, { exit, setExitCode: vi.fn() }),
    seedFileCatalogOnce: () => Promise.resolve(),
  };
  const failure = vi.fn(() => invocation.finiteExit.fail('cli_internal'));
  const owner = new SessionTerminalOwner(invocation, () => registry.assertAdmitting(), failure);
  return {
    owner,
    invocation,
    registry,
    failure,
    exit,
    advance: (time: number) => {
      now = time;
      for (const [fire, at] of [...timers]) if (at <= now && timers.delete(fire)) fire();
    },
  };
}

describe('session terminal acquisition and actual release', () => {
  it('joins an entered suspension before native final release and waits for actual exit', async () => {
    const f = fixture();
    const suspension = gate();
    const nativeExit = gate();
    const seal = vi.fn();
    const release = vi.fn(() => nativeExit.promise);
    f.owner.acquire((creation) => creation.adopt({ seal, release }));
    const raw = f.owner.enter(() => suspension.promise);
    expect(raw).toBe(suspension.promise);
    const closing = f.owner.close();
    expect(f.owner.close()).toBe(closing);
    await reactions();
    expect(seal).toHaveBeenCalledOnce();
    expect(release, 'SESSION_SUSPENSION_JOINS_BEFORE_FINAL_UNMOUNT').not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    suspension.release();
    await raw;
    await reactions();
    expect(release).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners, 'SESSION_NATIVE_EXIT_IS_NOT_UNMOUNT_RETURN').toBe(1);
    nativeExit.release();
    await closing;
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.failure).not.toHaveBeenCalled();
  });

  it('never treats a thrown constructor with no handle as no acquisition', async () => {
    const f = fixture();
    const cause = new Error('PRIVATE_PARTIAL_RENDER');
    expect(() =>
      f.owner.acquire(() => {
        throw cause;
      }),
    ).toThrow(cause);
    let settled = false;
    void f.owner.close().then(() => {
      settled = true;
    });
    await reactions();
    expect(f.failure).toHaveBeenCalledWith(cause);
    expect(f.registry.activeOwners).toBe(1);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(settled, 'SESSION_PARTIAL_RENDER_NEVER_FORGES_RELEASE').toBe(false);
  });

  it('accepts only an explicit trusted no-acquisition declaration', async () => {
    const f = fixture();
    f.owner.acquire((creation) => {
      creation.acknowledgeNoAcquisition();
      return 123;
    });
    await f.owner.close();
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.exit).not.toHaveBeenCalled();
  });

  it('retains unknown acquisition if capturing a partially acquired native lease throws', async () => {
    const f = fixture();
    const cause = new Error('PRIVATE_LEASE_CAPTURE_FAILURE');
    const release = vi.fn(async () => {});
    expect(() =>
      f.owner.acquire((creation) =>
        creation.adopt({
          get seal(): () => void {
            throw cause;
          },
          release,
        }),
      ),
    ).toThrow(cause);
    let settled = false;
    void f.owner.close().then(() => {
      settled = true;
    });
    await reactions();
    expect(release).not.toHaveBeenCalled();
    expect(f.registry.activeOwners, 'SESSION_LEASE_CAPTURE_PRECEDES_ACQUISITION_ACK').toBe(1);
    expect(settled).toBe(false);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
  });

  it('does not infer no-acquisition from an undeclared constructor return', async () => {
    const f = fixture();
    expect(() => f.owner.acquire(() => undefined)).toThrow();
    void f.owner.close();
    await reactions();
    expect(f.registry.activeOwners).toBe(1);
    expect(f.registry.observations.exitCode()).toBe(9);
  });

  it('adopts a late handle after reentrant stop and releases it once', async () => {
    const f = fixture();
    const seal = vi.fn();
    const release = vi.fn(async () => {});
    f.owner.acquire((creation) => {
      f.owner.seal();
      creation.adopt({ seal, release });
    });
    expect(seal).toHaveBeenCalledOnce();
    await f.owner.close();
    expect(release).toHaveBeenCalledOnce();
    expect(() => f.owner.enter(() => Promise.resolve())).toThrow();
  });

  it('retains a rejected native release and never retries its factory', async () => {
    const f = fixture();
    const release = vi.fn(() => Promise.reject(new Error('PRIVATE_EXIT_REFUSAL')));
    f.owner.acquire((creation) => creation.adopt({ seal: () => undefined, release }));
    const closing = f.owner.close();
    await reactions();
    expect(f.owner.close()).toBe(closing);
    expect(release).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(1);
    expect(f.registry.observations.exitCode()).toBe(9);
  });

  it('checks the unchanged budget after held suspension settlement before starting release', async () => {
    const f = fixture();
    const suspension = gate();
    const release = vi.fn(async () => {});
    f.owner.acquire((creation) => creation.adopt({ seal: () => undefined, release }));
    void f.owner.enter(() => suspension.promise);
    f.invocation.finiteExit.fail('cli_internal');
    f.advance(3000);
    await reactions();
    suspension.release();
    await reactions();
    expect(release, 'SESSION_EXPIRED_TERMINAL_CANNOT_ENTER_ASYNC_RELEASE').not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
  });

  it('retains a synchronous seal refusal despite a later fulfilled native release', async () => {
    const f = fixture();
    const release = vi.fn(async () => {});
    f.owner.acquire((creation) =>
      creation.adopt({
        seal: () => {
          throw new Error('PRIVATE_SEAL_REFUSAL');
        },
        release,
      }),
    );
    void f.owner.close();
    await reactions();
    expect(release).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(1);
    expect(f.registry.observations.exitCode()).toBe(9);
  });

  it('waits for prompt completion and captured cursor delivery before releasing terminal custody', async () => {
    const f = fixture();
    await f.owner.close(); // This fixture's empty mount is independent from the new prompt reservation.
    const prompt = gate();
    const delivered = gate();
    const io = captureIo();
    const write = vi.fn(() => delivered.promise);
    const abortCompletedPrompt = vi.fn();
    const answer = runSessionPrompt(
      f.invocation,
      { ...io.io, stdoutIsTty: true, writeOutAcknowledged: write },
      () => f.registry.assertAdmitting(),
      f.failure,
      async (signal) => {
        signal.addEventListener('abort', abortCompletedPrompt);
        await prompt.promise;
        return true;
      },
    );
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await reactions();
    expect(write).not.toHaveBeenCalled();
    prompt.release();
    await reactions();
    expect(write).toHaveBeenCalledExactlyOnceWith('\u001b[?25h');
    expect(f.registry.activeOwners).toBe(1);
    expect(settled).toBe(false);
    delivered.release();
    expect(await answer).toBe(true);
    expect(
      abortCompletedPrompt,
      'SESSION_FULFILLED_PROMPT_IS_NOT_ABORTED_AGAIN',
    ).not.toHaveBeenCalled();
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('a prompt refusal is neither input release nor cursor-delivery permission', async () => {
    const f = fixture();
    await f.owner.close();
    const io = captureIo();
    const write = vi.fn(async () => {});
    let settled = false;
    void runSessionPrompt(
      f.invocation,
      { ...io.io, stdoutIsTty: true, writeOutAcknowledged: write },
      () => f.registry.assertAdmitting(),
      f.failure,
      () => Promise.reject(new CliError('cli_internal', '')),
    ).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await reactions();
    expect(write).not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    f.advance(3000);
    await reactions();
    expect(settled).toBe(false);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
  });

  it('retains a refused captured cursor delivery with its output-unavailable diagnosis', async () => {
    const f = fixture();
    await f.owner.close();
    const io = captureIo();
    const write = vi.fn(() => Promise.reject(new CliError('output_unavailable', '')));
    void runSessionPrompt(
      f.invocation,
      { ...io.io, stdoutIsTty: true, writeOutAcknowledged: write },
      () => f.registry.assertAdmitting(),
      () => undefined,
      () => Promise.resolve(true),
    );
    await reactions();
    expect(write).toHaveBeenCalledOnce();
    expect(
      f.registry.observations.infrastructureCode(),
      'SESSION_TERMINAL_OUTPUT_FAILURE_STAYS_CLASSIFIED',
    ).toBe('output_unavailable');
    expect(f.registry.activeOwners).toBe(1);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
  });
});
