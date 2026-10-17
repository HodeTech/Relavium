import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CapturedNativeInput } from './native-input.js';

class HeldInput extends Readable {
  destructions = 0;
  release: () => void = () => {};
  override _read(): void {}
  override _destroy(cause: Error | null, done: (cause: Error | null) => void): void {
    this.destructions++;
    this.release = () => done(cause);
  }
}

describe('shared consumed native input authority', () => {
  it('a failed abort-listener removal still joins native delivery and retains cleanup uncertainty', async () => {
    const input = new HeldInput();
    const controller = new AbortController();
    const failure = vi.fn();
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = () => {
      throw new Error('synthetic listener removal refusal');
    };
    const captured = new CapturedNativeInput(
      input,
      { signal: controller.signal, onFailure: failure },
      'Synthetic stop.',
    );
    captured.open();
    let settled = false;
    void captured.close().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(input.destructions).toBe(1);
      expect(settled, 'FAILED_ABORT_REMOVAL_CANNOT_RELEASE_CONSUMED_INPUT').toBe(false);
      expect(failure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: 'cli_internal', exitCode: 9 }),
      );
      input.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(input.closed).toBe(true);
      expect(settled, 'DELIVERED_CLOSE_DOES_NOT_CLEAR_CLEANUP_UNCERTAINTY').toBe(false);
    } finally {
      controller.signal.removeEventListener = remove;
      input.release();
    }
  });

  it('joins one actual close across cancellation and repeated cleanup, preserving prior callbacks', async () => {
    const input = new HeldInput();
    const controller = new AbortController();
    const failure = vi.fn();
    const priorError = vi.fn();
    input.on('error', priorError);
    const captured = new CapturedNativeInput(
      input,
      { signal: controller.signal, onFailure: failure },
      'Synthetic stop.',
    );
    captured.open();
    controller.abort(new Error('synthetic invocation stop'));
    const closing = captured.close();
    expect(captured.close()).toBe(closing);
    captured.requestClose();
    let joined = false;
    void closing.then(() => {
      joined = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(input.destructions).toBe(1);
      expect(input.destroyed).toBe(true);
      expect(input.closed).toBe(false);
      expect(joined, 'CONSUMED_INPUT_REQUEST_IS_NOT_CLOSE_ACK').toBe(false);
    } finally {
      input.release();
    }
    await closing;
    expect(input.closed).toBe(true);
    expect(priorError).toHaveBeenCalledExactlyOnceWith(captured.cancelled);
    expect(input.listeners('error')).toEqual([priorError]);
    expect(failure).not.toHaveBeenCalled();
  });

  it('stopped-before-acquisition leaves the unconsumed native input untouched', async () => {
    const input = new HeldInput();
    const controller = new AbortController();
    const reason = new Error('synthetic stop before acquisition');
    controller.abort(reason);
    const captured = new CapturedNativeInput(
      input,
      { signal: controller.signal, onFailure: vi.fn() },
      'Synthetic stop.',
    );
    expect(() => captured.open()).toThrow(reason);
    await captured.close();
    expect(input.destructions).toBe(0);
    expect(input.eventNames()).toEqual([]);
    input.destroy();
    input.release();
  });
});
