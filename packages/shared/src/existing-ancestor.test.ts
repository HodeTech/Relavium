import { describe, expect, it, vi } from 'vitest';

import {
  deepestExistingReal,
  ExistingAncestorError,
  type ExistingAncestorOperations,
} from './existing-ancestor.js';

function hostError(code: string): Error & { code: string; path: string } {
  return Object.assign(new Error('PRIVATE'), { code, path: 'PRIVATE' });
}

function operations(): ExistingAncestorOperations {
  return {
    realpath: vi.fn((path: string) =>
      path === '/root' ? Promise.resolve('/canonical') : Promise.reject(hostError('ENOENT')),
    ),
    lstat: vi.fn((path: string) =>
      path === '/canonical'
        ? Promise.resolve({ isDirectory: () => true })
        : Promise.reject(hostError('ENOENT')),
    ),
    dirname: (path) => path.slice(0, path.lastIndexOf('/')) || '/',
    isMissing: (error) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  };
}

describe('deepestExistingReal — host-injected fail-closed ancestor admission', () => {
  it('climbs genuinely absent descendants and verifies the resolved directory', async () => {
    const ops = operations();
    await expect(deepestExistingReal('/root/new/deep', ops)).resolves.toBe('/canonical');
    expect(ops.realpath).toHaveBeenNthCalledWith(1, '/root/new/deep');
    expect(ops.realpath).toHaveBeenNthCalledWith(2, '/root/new');
    expect(ops.realpath).toHaveBeenNthCalledWith(3, '/root');
    expect(ops.lstat).toHaveBeenLastCalledWith('/canonical');
  });

  it.each(['EACCES', 'ELOOP', 'ENOTDIR', 'EIO'])('does not climb after %s', async (code) => {
    const ops = operations();
    const realpath = vi.fn(() => Promise.reject(hostError(code)));
    await expect(deepestExistingReal('/root/new', { ...ops, realpath })).rejects.toMatchObject({
      name: 'ExistingAncestorError',
      reason: 'unresolvable',
      message: 'the existing ancestor directory could not be admitted',
    });
    expect(realpath).toHaveBeenCalledTimes(1);
    expect(ops.lstat).not.toHaveBeenCalled();
  });

  it('refuses an existing dangling link, including above missing descendants', async () => {
    const ops = operations();
    const lstat = vi.fn((path: string) =>
      path === '/root/link'
        ? Promise.resolve({ isDirectory: () => false })
        : Promise.reject(hostError('ENOENT')),
    );
    await expect(deepestExistingReal('/root/link/new', { ...ops, lstat })).rejects.toBeInstanceOf(
      ExistingAncestorError,
    );
    expect(ops.realpath).toHaveBeenCalledTimes(2);
    expect(ops.realpath).not.toHaveBeenCalledWith('/root');
  });

  it('does not interpret an inaccessible lexical inspection as absence', async () => {
    const ops = operations();
    const lstat = vi.fn(() => Promise.reject(hostError('EACCES')));
    await expect(deepestExistingReal('/root/new', { ...ops, lstat })).rejects.toBeInstanceOf(
      ExistingAncestorError,
    );
    expect(ops.realpath).toHaveBeenCalledTimes(1);
  });

  it('requires a directory at the canonical target and does not climb a file', async () => {
    const ops = operations();
    const lstat = vi.fn(() => Promise.resolve({ isDirectory: () => false }));
    await expect(deepestExistingReal('/root', { ...ops, lstat })).rejects.toMatchObject({
      reason: 'not_directory',
    });
    expect(ops.realpath).toHaveBeenCalledTimes(1);
  });

  it('refuses a vanished canonical target and never leaks the host error', async () => {
    const ops = operations();
    const lstat = vi.fn(() => Promise.reject(new Error('PRIVATE /sensitive/path')));
    const error: unknown = await deepestExistingReal('/root', { ...ops, lstat }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(ExistingAncestorError);
    if (error instanceof ExistingAncestorError) {
      expect(error.message).not.toContain('PRIVATE');
      expect(error.cause).toBeUndefined();
    }
  });

  it('terminates when even the host root is absent', async () => {
    const ops = operations();
    await expect(deepestExistingReal('/', ops)).rejects.toMatchObject({ reason: 'no_ancestor' });
    expect(ops.realpath).toHaveBeenCalledTimes(1);
  });
});
