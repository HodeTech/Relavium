import { describe, expect, it, vi } from 'vitest';

import { createCliInvocation } from '../process/invocation.js';
import { captureIo } from '../test-support.js';
import { executeCommand } from './dispatch.js';
import { permissionsListCommand, permissionsRevokeCommand } from './permissions.js';

vi.mock('./permissions.js', () => ({
  permissionsListCommand: vi.fn(() => 0),
  permissionsRevokeCommand: vi.fn(() => 0),
}));

/**
 * The runtime dispatch table is the OTHER way into `relavium permissions` (the lazy route is the CLI's): it must forward the same
 * parsed arguments, never a fixed "all", and refuse an invalid invocation before the command core runs.
 */
function context() {
  const { io } = captureIo();
  return {
    io,
    invocation: createCliInvocation(),
    global: {
      json: false,
      color: false,
      cwd: '/work',
      configPath: undefined,
      verbosity: 'normal' as const,
    },
  };
}

describe('the dispatch table’s permissions executors', () => {
  it('list runs the list core, with the context it was given', async () => {
    vi.clearAllMocks();
    await expect(
      executeCommand('permissions.list', { positionals: [], options: {} }, context()),
    ).resolves.toBe(0);
    expect(permissionsListCommand).toHaveBeenCalledOnce();
    expect(permissionsRevokeCommand).not.toHaveBeenCalled();
  });

  it.each([
    { input: { positionals: ['4'], options: {} }, args: { all: false, index: 4 } },
    { input: { positionals: [], options: { all: true } }, args: { all: true } },
  ])('revoke forwards the PARSED arguments: %j', async ({ input, args }) => {
    vi.clearAllMocks();
    await executeCommand('permissions.revoke', input, context());
    expect(permissionsRevokeCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(permissionsRevokeCommand).mock.calls[0]?.[0]).toEqual(args);
    expect(permissionsListCommand).not.toHaveBeenCalled();
  });

  it.each([
    { positionals: [], options: {} },
    { positionals: ['1'], options: { all: true } },
    { positionals: ['abc'], options: {} },
  ])('revoke refuses an invalid invocation before the core runs: %j', async (input) => {
    vi.clearAllMocks();
    await expect(executeCommand('permissions.revoke', input, context())).rejects.toMatchObject({
      code: 'invalid_invocation',
    });
    expect(permissionsRevokeCommand).not.toHaveBeenCalled();
  });
});
