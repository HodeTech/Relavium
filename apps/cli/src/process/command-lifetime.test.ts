import { describe, expect, it, vi } from 'vitest';
import { captureIo } from '../test-support.js';
import { CliError } from './cli-error.js';
import { CommandLifetime } from './command-lifetime.js';
import { invocationFixture } from './invocation.test-support.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const f = invocationFixture();
  let signal: (signo: number) => void = () => undefined;
  const removeSignals = vi.fn();
  const registration = vi.spyOn(f.registry, 'register');
  const { io } = captureIo();
  const lifetime = new CommandLifetime(f.invocation, io, (listener) => {
    signal = listener;
    return removeSignals;
  });
  return { ...f, lifetime, removeSignals, registration, signal: (signo: number) => signal(signo) };
}

describe('management command lifetime', () => {
  it('adopts an early native close once across the returned-resource handoff', async () => {
    const f = fixture();
    const close = vi.fn();
    await f.lifetime.execute(() => {
      f.lifetime.acquire((captureClose) => {
        captureClose(close);
        captureClose(close);
        return { close };
      });
      return Promise.resolve(0);
    });
    expect(close).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('preserves the receiver of a legacy returned native resource', async () => {
    const f = fixture();
    const resource = {
      closed: false,
      close() {
        this.closed = true;
      },
    };
    await f.lifetime.execute(() => {
      expect(f.lifetime.acquire(() => resource)).toBe(resource);
      return Promise.resolve(0);
    });
    expect(resource.closed).toBe(true);
    expect(f.registry.activeOwners).toBe(0);
  });

  it('retains unknown partial acquisition and signal custody through the original deadline', async () => {
    const f = fixture();
    let settled = false;
    const command = f.lifetime.execute(() => {
      f.lifetime.acquire(() => {
        throw new Error('synthetic unknown partial creation');
      });
      return Promise.resolve(0);
    });
    void command.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await reactions();
    expect(f.registry.activeOwners, 'UNKNOWN_PARTIAL_COMMAND_ACQUISITION_IS_NOT_RETIREMENT').toBe(
      1,
    );
    expect(f.removeSignals).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    f.advance(3_000);
    expect(await f.invocation.finiteExit.exited).toBe(9);
    expect(f.registry.activeOwners).toBe(1);
  });

  it('preserves a classified no-resource storage refusal', async () => {
    const f = fixture();
    const refusal = new CliError('storage_unavailable', '');
    await expect(
      f.lifetime.execute(() => {
        f.lifetime.acquire(() => {
          throw refusal;
        });
        return Promise.resolve(0);
      }),
    ).rejects.toBe(refusal);
    expect(f.registry.activeOwners).toBe(0);
    expect(f.removeSignals).toHaveBeenCalledOnce();
    expect(f.registry.budget.deadline()).toBeUndefined();
  });

  it('adopts a resource that returns after reentrant stop before admitting business use', async () => {
    const f = fixture();
    const close = vi.fn();
    const use = vi.fn();
    await f.lifetime.execute(() => {
      f.lifetime.acquire((captureClose) => {
        captureClose(close);
        f.signal(15);
        return { close };
      });
      use();
      return Promise.resolve(0);
    });
    expect(use).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
    expect(await f.invocation.finiteExit.exited).toBe(143);
  });

  it.each([0, 1, 2] as const)(
    'preserves ordinary %s with a truthful no-health owner',
    async (code) => {
      const f = fixture();
      expect(f.registration).toHaveBeenCalledWith(expect.objectContaining({ kind: 'command' }));
      const close = vi.fn();
      f.lifetime.adoptCleanup(close);
      expect(await f.lifetime.execute(() => Promise.resolve(code))).toBe(code);
      expect(close).toHaveBeenCalledOnce();
      expect(f.removeSignals).toHaveBeenCalledOnce();
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.budget.deadline()).toBeUndefined();
      expect(f.exit).not.toHaveBeenCalled();
    },
  );

  it('joins raw work after a UX result before closing the command database', async () => {
    const f = fixture();
    const raw = gate();
    const close = vi.fn();
    f.lifetime.adoptCleanup(close);
    const command = f.lifetime.execute(() => {
      void f.lifetime.work.work.retainWork(() => raw.promise);
      return Promise.resolve(0);
    });
    await reactions();
    expect(close, 'COMMAND_RESULT_IS_NOT_RAW_SETTLEMENT').not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    f.signal(15);
    expect(f.lifetime.work.signal.aborted).toBe(true);
    expect(f.exit).not.toHaveBeenCalled();
    raw.release();
    await command;
    await reactions();
    expect(close).toHaveBeenCalledOnce();
    expect(f.removeSignals).toHaveBeenCalledOnce();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(143);
  });

  it('starts the common fault budget before a competing held raw operation', async () => {
    const f = fixture();
    const raw = gate();
    const close = vi.fn();
    f.lifetime.adoptCleanup(close);
    const command = f.lifetime.execute(() => {
      void f.lifetime.work.work.retainWork(() => raw.promise);
      throw new Error('PRIVATE_COMMAND_CAUSE');
    });
    await reactions();
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(f.registry.observations.exitCode()).toBe(9);
    expect(close).not.toHaveBeenCalled();
    raw.release();
    await expect(command).rejects.toMatchObject({ code: 'cli_internal', exitCode: 9 });
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps failed cleanup and original signal custody unacknowledged', async () => {
    const f = fixture();
    f.lifetime.adoptCleanup(() => {
      throw new Error('PRIVATE_CLOSE_FAILURE');
    });
    void f.lifetime.execute(() => Promise.resolve(0));
    await reactions();
    expect(f.registry.observations.exitCode()).toBe(9);
    expect(f.registry.activeOwners).toBe(1);
    expect(f.removeSignals).not.toHaveBeenCalled();
    f.advance(500);
    f.signal(15);
    expect(f.registry.budget.deadline()).toBe(3000);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(f.registry.activeOwners).toBe(1);
  });

  it('starts all independent releases before awaiting one and does not overwrite an operational refusal', async () => {
    const f = fixture();
    const held = gate();
    const later = vi.fn();
    f.lifetime.adoptCleanup(() => held.promise);
    f.lifetime.adoptCleanup(later);
    const refusal = new CliError('internal', 'known operational refusal');
    const command = f.lifetime.execute(() => Promise.reject(refusal));
    await reactions();
    expect(later).toHaveBeenCalledOnce();
    expect(f.removeSignals).not.toHaveBeenCalled();
    expect(f.registry.budget.deadline()).toBeUndefined();
    held.release();
    await expect(command).rejects.toBe(refusal);
    expect(f.registry.observations.exitCode()).toBe(1);
    expect(f.exit).not.toHaveBeenCalled();
  });

  it('classifies an actual output failure before raw-child cleanup and refuses late writes', async () => {
    const f = invocationFixture();
    const { io } = captureIo();
    const write = vi.fn(() => {
      throw new Error('PRIVATE_SINK_FAILURE');
    });
    const lifetime = new CommandLifetime(
      f.invocation,
      { ...io, writeOut: write },
      () => () => undefined,
    );
    const child = gate();
    const command = lifetime.execute(() => {
      void lifetime.work.work.retainWork(() => child.promise);
      lifetime.io.writeOut('requested result');
      return Promise.resolve(0);
    });
    await reactions();
    expect(f.registry.observations.infrastructureCode()).toBe('output_unavailable');
    expect(f.registry.budget.deadline()).toBe(3000);
    expect(() => lifetime.io.writeOut('late result')).toThrow('Command operation stopped.');
    expect(write).toHaveBeenCalledOnce();
    child.release();
    await expect(command).rejects.toMatchObject({ code: 'output_unavailable' });
  });
});
