import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { CommandLifetime } from '../process/command-lifetime.js';
import { captureIo } from '../test-support.js';
import { readSecretFromStdin } from './read-secret.js';

class HeldCloseInput extends Readable {
  release: () => void = () => undefined;
  override _read(): void {}
  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.release = () => callback(error);
  }
}

describe('captured secret input lifetime', () => {
  it.each(['cap', 'partial-iterator', 'factory'] as const)(
    'joins actual native close before retiring a %s refusal',
    async (mode) => {
      const f = invocationFixture();
      const input = new HeldCloseInput();
      const { io } = captureIo();
      const lifetime = new CommandLifetime(f.invocation, { ...io, stdin: input }, () => () => {});
      const databaseClose = vi.fn();
      lifetime.adoptCleanup(databaseClose);
      if (mode === 'cap') input.push(Buffer.alloc(65_537, 'x'));
      else if (mode === 'factory') {
        input[Symbol.asyncIterator] = () => {
          throw new Error('synthetic iterator factory fault');
        };
      } else {
        let injected = false;
        input.on('newListener', (event) => {
          if (event === 'end' && !injected) {
            injected = true;
            throw new Error('synthetic iterator acquisition fault');
          }
        });
      }
      let settled = false;
      const reading = lifetime.execute(async () => {
        await readSecretFromStdin(undefined, input, {
          signal: lifetime.work.signal,
          onFailure: lifetime.work.failure,
        });
        expect.fail('invalid input cannot continue to a credential write');
      });
      const outcome = reading.then(
        () => {
          settled = true;
          return undefined;
        },
        (cause: unknown) => {
          settled = true;
          return cause;
        },
      );
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled, 'SECRET_REFUSAL_RETAINS_NATIVE_CLOSE').toBe(false);
        expect(input.destroyed, 'SECRET_REFUSAL_REQUESTS_NATIVE_CLOSE').toBe(true);
        expect(input.closed).toBe(false);
        expect(databaseClose).not.toHaveBeenCalled();
        expect(f.registry.activeOwners).toBe(1);
      } finally {
        // Test cleanup requests close even on the unfixed partial-acquisition path.
        input.destroy();
        input.release();
      }
      expect(await outcome).toMatchObject({ code: 'invalid_invocation', exitCode: 2 });
      expect(input.closed).toBe(true);
      expect(databaseClose).toHaveBeenCalledOnce();
      expect(f.registry.activeOwners).toBe(0);
    },
  );

  it('attempts destruction independently of failed close observation and grants no retirement', async () => {
    const f = invocationFixture();
    const input = new HeldCloseInput();
    const { io } = captureIo();
    const lifetime = new CommandLifetime(f.invocation, { ...io, stdin: input }, () => () => {});
    const databaseClose = vi.fn();
    lifetime.adoptCleanup(databaseClose);
    let injected = false;
    input.on('newListener', (event) => {
      if (event === 'close' && !injected) {
        injected = true;
        throw new Error('synthetic close observation fault');
      }
    });
    let settled = false;
    const reading = lifetime.execute(async () => {
      await readSecretFromStdin(undefined, input, {
        signal: lifetime.work.signal,
        onFailure: lifetime.work.failure,
      });
      return 0;
    });
    void reading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(input.destroyed, 'SECRET_CLOSE_OBSERVER_FAILURE_STILL_DESTROYS').toBe(true);
      expect(input.closed).toBe(false);
      expect(databaseClose).not.toHaveBeenCalled();
      expect(f.registry.activeOwners).toBe(1);
      f.advance(3_000);
      expect(await f.invocation.finiteExit.exited).toBe(9);
    } finally {
      input.destroy();
      input.release();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(input.closed).toBe(true);
    expect(settled).toBe(false);
    expect(databaseClose).not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
  });

  it('refuses an unconsumed native TTY without iterator or close acquisition', async () => {
    const input = new HeldCloseInput();
    Object.defineProperty(input, 'isTTY', { value: true });
    const acquire = vi.spyOn(input, Symbol.asyncIterator);
    const destroy = vi.spyOn(input, 'destroy');
    await expect(readSecretFromStdin(undefined, input)).rejects.toMatchObject({ exitCode: 2 });
    expect(acquire).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    input.destroy();
    input.release();
  });

  it('waits for actual native input close after cancellation before database cleanup', async () => {
    const f = invocationFixture();
    const input = new HeldCloseInput();
    const { io } = captureIo();
    const lifetime = new CommandLifetime(
      f.invocation,
      { ...io, stdin: input },
      () => () => undefined,
    );
    const databaseClose = vi.fn();
    lifetime.adoptCleanup(databaseClose);
    const reading = lifetime.execute(async () => {
      await readSecretFromStdin(undefined, input, {
        signal: lifetime.work.signal,
        onFailure: lifetime.work.failure,
      });
      expect.fail('cancelled input cannot continue to a credential write');
    });
    f.invocation.finiteExit.signal(15);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(input.destroyed).toBe(true);
    expect(input.closed).toBe(false);
    expect(databaseClose, 'SECRET_INPUT_DESTROY_IS_NOT_CLOSE_ACK').not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    input.release();
    await reading;
    expect(input.closed).toBe(true);
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.registry.observations.exitCode()).toBe(143);
  });

  it('refuses a stopped invocation before acquiring the source iterator', async () => {
    const controller = new AbortController();
    const reason = new Error('synthetic stop');
    controller.abort(reason);
    const iterator = vi.fn(async function* () {
      await Promise.resolve();
      yield 'synthetic';
    });
    await expect(
      readSecretFromStdin(
        undefined,
        { [Symbol.asyncIterator]: iterator },
        {
          signal: controller.signal,
          onFailure: vi.fn(),
        },
      ),
    ).rejects.toBe(reason);
    expect(iterator).not.toHaveBeenCalled();
  });
});
