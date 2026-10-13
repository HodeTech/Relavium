import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { MediaAdmissionError } from './media-admission.js';
import { closeMediaIterator, registerNativeMediaIterator } from './media-iterator.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const done = (): IteratorResult<Uint8Array> => ({ done: true, value: undefined });

describe('exact media iterator ownership', () => {
  it('observes foreign pending return once without joining it', async () => {
    const held = gate();
    const returned = held.promise.then(done);
    const operation = vi.fn(() => returned);
    const iterator: AsyncIterator<Uint8Array> = {
      next: () => Promise.resolve(done()),
      return: operation,
    };
    const first = closeMediaIterator(iterator);
    let settled = false;
    const observed = first.then(() => {
      settled = true;
    });
    try {
      expect(closeMediaIterator(iterator), 'MEDIA_ITERATOR_FOREIGN_ACK').toBe(first);
      await Promise.resolve();
      expect(settled, 'MEDIA_ITERATOR_FOREIGN_ACK').toBe(true);
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      held.release();
      await returned;
      await Promise.all([first, observed]);
    }
  });

  it.each(['throw', 'reject', 'then-getter'] as const)(
    'discards foreign %s diagnostics',
    async (kind) => {
      const sentinel = new Error('private foreign diagnostic');
      const held = gate();
      let returnRetired: Promise<void> | undefined;
      const iterator: AsyncIterator<Uint8Array> = {
        next: () => Promise.resolve(done()),
        return: () => {
          if (kind === 'throw') throw sentinel;
          if (kind === 'reject') {
            const rejected = Promise.reject(sentinel);
            void rejected.catch(() => undefined);
            return rejected;
          }
          // Keep the genuine Promise pending through the checkpoint so its fulfillment
          // cannot substitute for the prompt foreign ACK. Capture cleanup before poisoning.
          const result = held.promise.then(done);
          returnRetired = result.then(() => undefined);
          void Object.defineProperty(result, 'then', {
            get: () => {
              throw sentinel;
            },
          });
          return result;
        },
      };
      const acknowledgement = closeMediaIterator(iterator);
      const observed = acknowledgement.then(
        () => ({ kind: 'complete' }),
        (error: unknown) => ({ kind: 'rejected', error }),
      );
      // The checkpoint proves completion independently of the foreign diagnostic.
      // Under removal, a broken helper ACK owns no native work; never hang the test on it.
      try {
        expect(
          await Promise.race([observed, setImmediate().then(() => ({ kind: 'pending' }))]),
          'MEDIA_ITERATOR_FOREIGN_DIAGNOSTIC_FINITE',
        ).toEqual({ kind: 'complete' });
      } finally {
        held.release();
        await returnRetired;
      }
    },
  );

  it('caches native acknowledgement before re-entrant return and keeps it pending', async () => {
    const held = gate();
    let reentered: Promise<void> | undefined;
    let calls = 0;
    const returned = held.promise.then(done);
    const iterator: AsyncIterator<Uint8Array> = {
      next: () => Promise.resolve(done()),
      return: () => {
        if (++calls === 1) reentered = closeMediaIterator(iterator);
        return returned;
      },
    };
    expect(registerNativeMediaIterator(iterator)).toBe(iterator);
    let settled = false;
    const first = closeMediaIterator(iterator);
    const observed = first.then(() => {
      settled = true;
    });
    try {
      expect(reentered, 'MEDIA_ITERATOR_REENTRY_CACHE').toBe(first);
      expect(closeMediaIterator(iterator), 'MEDIA_ITERATOR_REENTRY_CACHE').toBe(first);
      expect(calls, 'MEDIA_ITERATOR_REENTRY_CACHE').toBe(1);
      await Promise.resolve();
      expect(settled, 'MEDIA_ITERATOR_NATIVE_ACK').toBe(false);
    } finally {
      held.release();
      await Promise.all([returned, first, observed, reentered]);
    }
  });

  it('captures the original native return and receiver before later property mutation', async () => {
    const held = gate();
    let originalCalls = 0,
      getterCalls = 0;
    const receivers: unknown[] = [];
    const returned = held.promise.then(done);
    const iterator: AsyncIterator<Uint8Array> = {
      next: () => Promise.resolve(done()),
      return() {
        receivers.push(this);
        originalCalls++;
        return returned;
      },
    };
    registerNativeMediaIterator(iterator);
    Object.defineProperty(iterator, 'return', {
      get: () => {
        getterCalls++;
        return () => returned;
      },
    });
    const acknowledgement = closeMediaIterator(iterator);
    try {
      expect([originalCalls, getterCalls], 'MEDIA_ITERATOR_CAPTURED_RETURN').toEqual([1, 0]);
      expect(receivers, 'MEDIA_ITERATOR_CAPTURED_RETURN').toEqual([iterator]);
    } finally {
      held.release();
      await Promise.all([returned, acknowledgement]);
    }
  });

  it('refuses duplicate registration before reading a replaced return getter', () => {
    const iterator: AsyncIterator<Uint8Array> = {
      next: () => Promise.resolve(done()),
      return: () => Promise.resolve(done()),
    };
    registerNativeMediaIterator(iterator);
    const getter = vi.fn(() => () => Promise.resolve(done()));
    Object.defineProperty(iterator, 'return', { get: getter });
    expect(() => registerNativeMediaIterator(iterator)).toThrowError(
      new MediaAdmissionError('source_failed'),
    );
    expect(getter, 'MEDIA_ITERATOR_DUPLICATE_PREFLIGHT').not.toHaveBeenCalled();
  });

  it('refuses late promotion when return capture re-enters a foreign close', async () => {
    let closing = false;
    let acknowledgement: Promise<void> | undefined;
    const iterator: AsyncIterator<Uint8Array> = { next: () => Promise.resolve(done()) };
    Object.defineProperty(iterator, 'return', {
      get: () => {
        if (!closing) {
          closing = true;
          acknowledgement = closeMediaIterator(iterator);
        }
        return () => Promise.resolve(done());
      },
    });
    expect(
      () => registerNativeMediaIterator(iterator),
      'MEDIA_ITERATOR_LATE_PROMOTION',
    ).toThrowError(new MediaAdmissionError('source_failed'));
    await acknowledgement;
  });

  it.each(['throw', 'reject'] as const)(
    'maps native close %s to the fixed refusal',
    async (kind) => {
      const iterator = registerNativeMediaIterator<AsyncIterator<Uint8Array>>({
        next: () => Promise.resolve(done()),
        return: () => {
          const privateFailure = new Error('private native diagnostic');
          if (kind === 'throw') throw privateFailure;
          return Promise.reject(privateFailure);
        },
      });
      const acknowledgement = closeMediaIterator(iterator);
      await expect(acknowledgement).rejects.toEqual(new MediaAdmissionError('source_failed'));
      expect(closeMediaIterator(iterator)).toBe(acknowledgement);
    },
  );

  it('does not inherit native ownership through a different iterator or copied prototype', async () => {
    const held = gate();
    const returned = held.promise.then(done);
    const native = registerNativeMediaIterator<AsyncIterator<Uint8Array>>({
      next: () => Promise.resolve(done()),
      return: () => returned,
    });
    const wrapper: AsyncIterator<Uint8Array> = {
      next: () => native.next(),
      return: () => returned,
    };
    const prototype: unknown = Object.getPrototypeOf(native);
    expect(typeof prototype).toBe('object');
    if (typeof prototype !== 'object') throw new Error('Expected object prototype');
    Object.setPrototypeOf(wrapper, prototype);
    const acknowledgement = closeMediaIterator(wrapper);
    let settled = false;
    const observed = acknowledgement.then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(settled).toBe(true);
    } finally {
      held.release();
      await Promise.all([returned, acknowledgement, observed, closeMediaIterator(native)]);
    }
  });

  it('joins native retirement queued by a preceding direct generator return exactly once', async () => {
    const entered = gate(),
      held = gate();
    let retirements = 0;
    const iterator = registerNativeMediaIterator(
      (async function* () {
        try {
          yield new Uint8Array([1, 2]);
        } finally {
          retirements++;
          entered.release();
          await held.promise;
        }
      })(),
    );
    await iterator.next();
    const direct = iterator.return(undefined);
    await entered.promise;
    let settled = false;
    const acknowledgement = closeMediaIterator(iterator);
    const observed = acknowledgement.then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(closeMediaIterator(iterator)).toBe(acknowledgement);
    } finally {
      held.release();
      await Promise.all([direct, acknowledgement, observed]);
    }
    expect(retirements).toBe(1);
  });

  it('refuses a native iterator without a return operation', () => {
    expect(() => registerNativeMediaIterator({ next: () => Promise.resolve(done()) })).toThrowError(
      new MediaAdmissionError('source_failed'),
    );
  });
});
