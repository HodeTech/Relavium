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
