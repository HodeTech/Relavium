import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, toUserFacing } from './errors.js';
import {
  chmodForStorage,
  mkdirForStorage,
  storageBoundaryError,
  writeFileForStorage,
} from './owned-storage.js';

vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return { ...native, chmodSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});
afterEach(() => vi.resetAllMocks());

const operations = [
  { name: 'mkdir', native: vi.mocked(mkdirSync), run: () => mkdirForStorage('PRIVATE_PATH') },
  {
    name: 'chmod',
    native: vi.mocked(chmodSync),
    run: () => chmodForStorage('PRIVATE_PATH', 0o600),
  },
  {
    name: 'write',
    native: vi.mocked(writeFileSync),
    run: () => writeFileForStorage('PRIVATE_PATH', 'PRIVATE_BYTES', false),
  },
];

describe('actual CLI filesystem boundaries', () => {
  for (const operation of operations) {
    it.each(['EACCES', 'EPERM', 'ENOSPC', 'EROFS'])(
      `${operation.name}: owns native %s without exposing native detail`,
      (code) => {
        const cause = Object.assign(new Error('PRIVATE_NATIVE_TEXT'), { code });
        operation.native.mockImplementationOnce(() => {
          throw cause;
        });
        let failure: unknown;
        try {
          operation.run();
        } catch (error) {
          failure = error;
        }
        expect(failure, 'CLI_ORIGIN_FS_BOUNDARY').toBeInstanceOf(CliError);
        expect(failure).toMatchObject({ code: 'storage_unavailable', exitCode: 1, cause });
        expect(JSON.stringify(toUserFacing(failure))).not.toContain('PRIVATE_');
      },
    );

    it(`${operation.name}: leaves unknown faults and target refusals without storage authority`, () => {
      for (const code of ['EEXIST', 'EISDIR', 'ENOTDIR', 'ENOENT', 'ERR_DLOPEN_FAILED']) {
        const failure = Object.assign(new Error('PRIVATE_NATIVE_TEXT'), { code });
        operation.native.mockImplementationOnce(() => {
          throw failure;
        });
        expect(operation.run).toThrow(failure);
        expect(toUserFacing(failure).code).toBe('cli_internal');
      }
    });

    it(`${operation.name}: does not invoke inherited/accessor errno or reflection traps`, () => {
      const getter = vi.fn(() => 'ENOSPC');
      const accessor = Object.defineProperty({}, 'code', { get: getter });
      const inherited: unknown = Object.create({ code: 'ENOSPC' });
      const trapped = new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error('PRIVATE_TRAP');
          },
        },
      );
      for (const failure of [accessor, inherited, trapped]) {
        operation.native.mockImplementationOnce(() => {
          throw failure;
        });
        let observed: unknown;
        try {
          operation.run();
        } catch (error) {
          observed = error;
        }
        expect(observed).toBe(failure);
      }
      expect(getter).not.toHaveBeenCalled();
    });
  }

  it('never promotes an errno-shaped error from an injected opener outside owned I/O', () => {
    const cause = Object.assign(new Error('PRIVATE_PLUGIN_BYTES'), { code: 'ENOSPC' });
    const error = storageBoundaryError(cause);
    expect(error).toMatchObject({ code: 'cli_internal', exitCode: 9, cause });
    expect(error.message).not.toContain('PRIVATE_');
  });

  it('does not remap an already classified known operational failure', () => {
    const error = new CliError('internal', 'known departure refusal');
    expect(storageBoundaryError(error)).toBe(error);
    expect(error.exitCode).toBe(1);
  });
});
