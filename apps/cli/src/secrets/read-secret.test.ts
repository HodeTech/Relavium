import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/errors.js';
import { renderError } from '../process/render-error.js';
import { captureIo } from '../test-support.js';
import { readSecretFromStdin } from './read-secret.js';

const CAP = 65_536;
const READ_ERROR = 'could not read secret input from stdin.';
const LIMIT_ERROR = 'secret input from stdin exceeds the 65536-byte limit.';
const CONTEXT = { pipeHint: 'pipe this command', emptyMessage: 'this command needs input' };

function source(
  chunks: readonly unknown[],
  isTTY?: boolean,
): AsyncIterable<unknown> & { isTTY?: boolean } {
  return {
    ...(isTTY === undefined ? {} : { isTTY }),
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* chunks;
    },
  };
}

async function rejection(
  operation: Promise<unknown>,
  marker = 'expected reader refusal',
): Promise<CliError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  expect.fail(marker);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bounded secret stdin (ADR-0107)', () => {
  it.each([
    ['single Buffer', [Buffer.alloc(CAP, 'x')], Buffer.alloc(1, 'x')],
    ['single string', ['x'.repeat(CAP)], 'x'],
    ['mixed chunks', [Buffer.alloc(CAP / 2, 'x'), 'x'.repeat(CAP / 2)], 'x'],
  ])('admits exact capacity and refuses aggregate overflow: %s', async (_name, chunks, extra) => {
    await expect(readSecretFromStdin(CONTEXT, source(chunks))).resolves.toBe('x'.repeat(CAP));
    const error = await rejection(
      readSecretFromStdin(CONTEXT, source([...chunks, extra])),
      'secrets-stdin-aggregate-cap',
    );
    expect(error.message, 'secrets-stdin-aggregate-cap').toBe(LIMIT_ERROR);
  });

  it.each([
    ['single Buffer', Buffer.alloc(CAP + 1, 'x')],
    ['single string', 'x'.repeat(CAP + 1)],
    ['whitespace', ' '.repeat(CAP + 1)],
  ])('refuses a single oversized chunk before copying or scanning: %s', async (_name, chunk) => {
    const copy = vi.spyOn(Buffer, 'from');
    const allocate = vi.spyOn(Buffer, 'allocUnsafe');
    const scan = vi.spyOn(Buffer, 'byteLength');
    const error = await rejection(
      readSecretFromStdin(CONTEXT, source([chunk])),
      'secrets-stdin-single-cap',
    );
    expect(error.message, 'secrets-stdin-single-cap').toBe(LIMIT_ERROR);
    expect(copy).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
  });

  it('checks encoded string size before conversion and counts lone surrogates', async () => {
    const copy = vi.spyOn(Buffer, 'from');
    const error = await rejection(readSecretFromStdin(CONTEXT, source(['€'.repeat(21_846)])));
    expect(error.message).toBe(LIMIT_ERROR);
    expect(copy).not.toHaveBeenCalled();
    await expect(
      readSecretFromStdin(CONTEXT, source(['x'.repeat(CAP - 3), '\ud800'])),
    ).resolves.toBe('x'.repeat(CAP - 3) + '\ufffd');
    await expect(
      readSecretFromStdin(CONTEXT, source(['x'.repeat(CAP - 2), '\ud800'])),
    ).rejects.toThrow(LIMIT_ERROR);
  });

  it('counts astral string bytes at exact capacity and one byte over', async () => {
    await expect(readSecretFromStdin(CONTEXT, source(['x'.repeat(CAP - 4), '🦋']))).resolves.toBe(
      'x'.repeat(CAP - 4) + '🦋',
    );
    await expect(readSecretFromStdin(CONTEXT, source(['x'.repeat(CAP - 3), '🦋']))).rejects.toThrow(
      LIMIT_ERROR,
    );
  });

  it('owns admitted Buffer bytes before advancing a source that reuses them', async () => {
    const buffer = Buffer.from('first');
    const reused = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield buffer;
        buffer.write('later');
        yield buffer;
      },
    };
    expect(await readSecretFromStdin(CONTEXT, reused), 'secrets-stdin-buffer-ownership').toBe(
      'firstlater',
    );
  });

  it('skips zero-byte chunks without retaining or copying them', async () => {
    const emptyChunks = Array.from({ length: 100 }, () => [Buffer.alloc(0), '']).flat();
    const chunks = [...emptyChunks, Buffer.from('x'), ...emptyChunks];
    const copy = vi.spyOn(Buffer, 'allocUnsafe');
    const concat = vi.spyOn(Buffer, 'concat');
    expect(await readSecretFromStdin(CONTEXT, source(chunks))).toBe('x');
    expect(
      copy.mock.calls.every(([size]) => size > 0),
      'secrets-stdin-zero-copy',
    ).toBe(true);
    expect(concat.mock.calls[0]?.[0].length, 'secrets-stdin-zero-inventory').toBe(1);
    await expect(
      readSecretFromStdin(CONTEXT, source([Buffer.alloc(CAP, 'x'), '', Buffer.alloc(0)])),
    ).resolves.toBe('x'.repeat(CAP));
  });

  it('uses intrinsic Buffer bytes despite shadowed lengths and conversion hooks', async () => {
    for (const size of [CAP, CAP + 1]) {
      const chunk = Buffer.alloc(size, 'x');
      const access = vi.fn(() => {
        throw new Error('foreign Buffer hook');
      });
      for (const property of ['byteLength', 'length', 'valueOf', Symbol.iterator]) {
        Object.defineProperty(chunk, property, { get: access });
      }
      const allocate = vi.spyOn(Buffer, 'allocUnsafe');
      const operation = readSecretFromStdin(CONTEXT, source([chunk]));
      if (size === CAP) await expect(operation).resolves.toBe('x'.repeat(CAP));
      else {
        await expect(operation).rejects.toThrow(LIMIT_ERROR);
        expect(allocate).not.toHaveBeenCalled();
      }
      expect(access).not.toHaveBeenCalled();
      allocate.mockRestore();
    }
  });

  it('decodes split Buffer Unicode once, including exact-boundary and malformed bytes', async () => {
    const unicode = Buffer.from('€🦋');
    for (let split = 0; split <= unicode.length; split += 1) {
      await expect(
        readSecretFromStdin(
          CONTEXT,
          source([
            Buffer.alloc(CAP - unicode.length, 'x'),
            unicode.subarray(0, split),
            unicode.subarray(split),
          ]),
        ),
      ).resolves.toBe('x'.repeat(CAP - unicode.length) + '€🦋');
    }
    await expect(readSecretFromStdin(CONTEXT, source([Buffer.alloc(CAP, 0xff)]))).resolves.toBe(
      '\ufffd'.repeat(CAP),
    );
    await expect(readSecretFromStdin(CONTEXT, source(['\ud83e', '\udd8b']))).resolves.toBe(
      '\ufffd\ufffd',
    );
  });

  it('preserves whitespace, ignores unsupported shapes without coercion, and owns caller hints', async () => {
    const hostile = {
      toString: () => {
        throw new Error('must not coerce');
      },
    };
    for (const tty of [undefined, false]) {
      await expect(
        readSecretFromStdin(CONTEXT, source([hostile, null, 8, ' \tvalue  \r\n'], tty)),
      ).resolves.toBe(' \tvalue  \r\n');
    }
    for (const chunks of [[], [' \t\r\n']])
      await expect(readSecretFromStdin(CONTEXT, source(chunks))).rejects.toThrow(
        CONTEXT.emptyMessage,
      );
    const acquire = vi.fn(() => source([])[Symbol.asyncIterator]());
    await expect(
      readSecretFromStdin(CONTEXT, { isTTY: true, [Symbol.asyncIterator]: acquire }),
    ).rejects.toThrow(CONTEXT.pipeHint);
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('secret source failure isolation and iterator ownership', () => {
  const opaque = 'opaque-stdin-sentinel-729';
  const failures: readonly unknown[] = [
    new Error(opaque),
    new CliError('invalid_invocation', opaque),
    opaque,
    42,
    {
      get message() {
        throw new Error('message accessed');
      },
      toString() {
        throw new Error('coerced');
      },
    },
  ];
  const boundaries = [
    'isTTY',
    'factory-get',
    'factory-call',
    'next-get',
    'next-call',
    'next-reject',
    'done',
    'value',
    'buffer-size',
  ] as const;

  it.each(boundaries)(
    'normalizes every foreign failure at %s to a fresh fixed error',
    async (boundary) => {
      for (const cause of failures) {
        let closes = 0;
        const fail = (): never => {
          throw cause;
        };
        const iterator: AsyncIterator<unknown> = {
          next: () => Promise.resolve({ done: false, value: 'x' }),
          return: () => {
            closes += 1;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
        const input = { [Symbol.asyncIterator]: () => iterator };
        if (boundary === 'isTTY') Object.defineProperty(input, 'isTTY', { get: fail });
        if (boundary === 'factory-get')
          Object.defineProperty(input, Symbol.asyncIterator, { get: fail });
        if (boundary === 'factory-call') input[Symbol.asyncIterator] = fail;
        if (boundary === 'next-get') Object.defineProperty(iterator, 'next', { get: fail });
        if (boundary === 'next-call') iterator.next = fail;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- hostile sources may reject arbitrary values
        if (boundary === 'next-reject') iterator.next = () => Promise.reject(cause);
        if (boundary === 'done')
          iterator.next = () =>
            Promise.resolve({
              get done(): false {
                return fail();
              },
              value: 'x',
            });
        if (boundary === 'value')
          iterator.next = () =>
            Promise.resolve({
              done: false,
              get value(): unknown {
                return fail();
              },
            });
        if (boundary === 'buffer-size') {
          const chunk = new Proxy(Buffer.from('x'), { getPrototypeOf: fail });
          iterator.next = () => Promise.resolve({ done: false, value: chunk });
        }
        const error = await rejection(readSecretFromStdin(CONTEXT, input));
        expect(error.message, 'secrets-stdin-source-error').toBe(READ_ERROR);
        expect(error).not.toBe(cause);
        expect(error.cause).toBe(cause);
        expect(closes).toBe(['isTTY', 'factory-get', 'factory-call'].includes(boundary) ? 0 : 1);
        for (const json of [false, true])
          for (const verbose of [false, true]) {
            const io = captureIo();
            renderError(error, { json, verbose }, io.io);
            expect(io.out()).toBe('');
            expect(io.err()).not.toContain(opaque);
            expect(io.err()).toContain(READ_ERROR);
            if (json)
              expect(JSON.parse(io.err())).toEqual({
                type: 'error',
                code: 'invalid_invocation',
                message: READ_ERROR,
              });
          }
      }
    },
  );

  it('normalizes malformed iterator results and proxy Buffer internal-slot faults', async () => {
    const iterator: AsyncIterator<unknown> = {
      next: () => Promise.resolve({ done: false, value: new Proxy(Buffer.from('x'), {}) }),
    };
    const input = { [Symbol.asyncIterator]: () => iterator };
    expect((await rejection(readSecretFromStdin(CONTEXT, input))).message).toBe(READ_ERROR);
    for (const value of [null, undefined, 7, 'not a result']) {
      Object.defineProperty(iterator, 'next', {
        value: () => Promise.resolve(value),
        configurable: true,
      });
      expect((await rejection(readSecretFromStdin(CONTEXT, input))).message).toBe(READ_ERROR);
    }
  });

  it('normalizes a throwing default stdin getter', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    const cause = new CliError('invalid_invocation', opaque);
    try {
      Object.defineProperty(process, 'stdin', {
        configurable: true,
        get: () => {
          throw cause;
        },
      });
      const error = await rejection(readSecretFromStdin());
      expect(error.message).toBe(READ_ERROR);
      expect(error.cause).toBe(cause);
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'stdin', original);
    }
  });

  it.each(['getter', 'call', 'reject', 'missing'] as const)(
    'preserves primary failure when return has %s behavior',
    async (mode) => {
      const cause = new Error(opaque);
      let closes = 0;
      const iterator: AsyncIterator<unknown> = { next: () => Promise.reject(cause) };
      if (mode === 'getter')
        Object.defineProperty(iterator, 'return', {
          get: () => {
            closes += 1;
            throw new Error('cleanup sentinel');
          },
        });
      if (mode === 'call')
        iterator.return = () => {
          closes += 1;
          throw new Error('cleanup sentinel');
        };
      if (mode === 'reject')
        iterator.return = () => {
          closes += 1;
          return Promise.reject(new Error('cleanup sentinel'));
        };
      const error = await rejection(
        readSecretFromStdin(CONTEXT, { [Symbol.asyncIterator]: () => iterator }),
      );
      expect(error.message).toBe(READ_ERROR);
      expect(error.cause).toBe(cause);
      expect(closes).toBe(mode === 'missing' ? 0 : 1);
    },
  );

  it('awaits early cleanup exactly once with its receiver and does not pull after overflow', async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const next = vi.fn(() => Promise.resolve({ done: false, value: Buffer.alloc(CAP + 1, 'x') }));
    let closes = 0;
    const iterator: AsyncIterator<unknown> = {
      next,
      async return() {
        expect(this).toBe(iterator);
        closes += 1;
        entered?.();
        await barrier;
        return { done: true, value: undefined };
      },
    };
    let settled = false;
    const result = rejection(
      readSecretFromStdin(CONTEXT, { [Symbol.asyncIterator]: () => iterator }),
    ).then((error) => {
      settled = true;
      return error;
    });
    try {
      await closing;
      // Drain this turn's promise observers; only the explicit cleanup barrier may keep refusal pending.
      await setImmediate();
      expect(settled, 'secrets-stdin-cleanup-awaited').toBe(false);
      expect(closes, 'secrets-stdin-cleanup-once').toBe(1);
    } finally {
      release?.();
    }
    expect((await result).message).toBe(LIMIT_ERROR);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(['x', ' '])(
    'does not close again after normal EOF, including empty refusal: %j',
    async (value) => {
      let read = false;
      const close = vi.fn(() => Promise.resolve({ done: true, value: undefined }));
      const iterator: AsyncIterator<unknown> = {
        next: () => {
          const done = read;
          read = true;
          return Promise.resolve({ done, value });
        },
        return: close,
      };
      const acquire = vi.fn(() => iterator);
      const operation = readSecretFromStdin(CONTEXT, { [Symbol.asyncIterator]: acquire });
      if (value === ' ') await expect(operation).rejects.toThrow(CONTEXT.emptyMessage);
      else await expect(operation).resolves.toBe(value);
      expect(close).not.toHaveBeenCalled();
      expect(acquire).toHaveBeenCalledTimes(1);
    },
  );
});
