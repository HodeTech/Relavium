import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemMediaStore, MediaTemporaryMaintenanceError } from '@relavium/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureIo } from '../test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { pruneTemporariesCommand } from './media.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relavium-media-origin-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});
const global: GlobalOptions = {
  json: true,
  color: false,
  cwd: '.',
  configPath: undefined,
  verbosity: 'normal',
};
const args = { legacyOffline: true, force: true };

it('output delivery after successful maintenance is fixed output 9, never maintenance/storage', async () => {
  const prune = vi.spyOn(FilesystemMediaStore.prototype, 'pruneLegacyTemporaries');
  const { io } = captureIo();
  const cause = Object.assign(new Error('PRIVATE_OUTPUT_BYTES'), { code: 'ENOSPC' });
  await expect(
    pruneTemporariesCommand(args, {
      global,
      homeDir: home,
      io: {
        ...io,
        writeOut: () => {
          throw cause;
        },
      },
    }),
  ).rejects.toMatchObject({ code: 'output_unavailable', exitCode: 9, cause });
  expect(prune).toHaveBeenCalledOnce();
});

it('known maintenance refusal retains invocation 2 and private cause', async () => {
  const cause = new MediaTemporaryMaintenanceError('producer_active');
  vi.spyOn(FilesystemMediaStore.prototype, 'pruneLegacyTemporaries').mockRejectedValueOnce(cause);
  await expect(
    pruneTemporariesCommand(args, { global, homeDir: home, io: captureIo().io }),
  ).rejects.toMatchObject({ code: 'invalid_invocation', exitCode: 2, cause });
});

it.each([
  Object.assign(new Error('PRIVATE_PLUGIN_ERRNO'), { code: 'EACCES' }),
  Object.assign(new Error('PRIVATE_IO_INVARIANT'), {
    name: 'MediaStoreFilesystemError',
    reason: 'io',
  }),
])('unowned maintenance failures are fixed infrastructure 9', async (cause) => {
  vi.spyOn(FilesystemMediaStore.prototype, 'pruneLegacyTemporaries').mockRejectedValueOnce(cause);
  await expect(
    pruneTemporariesCommand(args, { global, homeDir: home, io: captureIo().io }),
  ).rejects.toMatchObject({ code: 'cli_internal', exitCode: 9, cause });
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'actual unreadable media root retains native storage provenance',
  async () => {
    const root = join(home, '.relavium', 'media');
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o000);
    try {
      await expect(
        pruneTemporariesCommand(args, { global, homeDir: home, io: captureIo().io }),
      ).rejects.toMatchObject({ code: 'storage_unavailable', exitCode: 1 });
    } finally {
      chmodSync(root, 0o700);
    }
  },
);
