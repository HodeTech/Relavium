import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClient,
  createSessionStore,
  runMigrations,
  FilesystemMediaStore,
} from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';
import { CommandLifetime } from '../process/command-lifetime.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import { chatListCommand } from './chat-list.js';
import { pruneTemporariesCommand } from './media.js';

const global = {
  json: true,
  color: false,
  cwd: tmpdir(),
  configPath: undefined,
  verbosity: 'normal',
} as const;
const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('management cleanup is an actual obligation', () => {
  it('retains a failed reader close despite a successfully rendered empty listing', async () => {
    const f = invocationFixture();
    const client = createClient(':memory:');
    runMigrations(client.db);
    const { io } = captureIo();
    const lifetime = new CommandLifetime(f.invocation, io, () => () => undefined);
    const close = vi.fn(() => {
      throw new Error('PRIVATE_READER_CLOSE');
    });
    try {
      void lifetime.execute(() =>
        Promise.resolve(
          chatListCommand({
            io: lifetime.io,
            global,
            commandLifetime: lifetime,
            openSessionStore: () => ({
              db: client.db,
              store: createSessionStore(client.db),
              close,
            }),
          }),
        ),
      );
      await reactions();
      expect(close).toHaveBeenCalledOnce();
      expect(client.sqlite.open).toBe(true);
      expect(f.registry.activeOwners, 'LISTING_WARNING_CANNOT_ACKNOWLEDGE_DATABASE_CLOSE').toBe(1);
      expect(f.registry.observations.exitCode()).toBe(9);
      f.advance(3000);
      await reactions();
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      client.sqlite.close();
    }
  });

  it('retains an already-entered maintenance operation and suppresses publication after stop', async () => {
    const f = invocationFixture();
    const homeDir = mkdtempSync(join(tmpdir(), 'relavium-owned-maintenance-'));
    const { io, out } = captureIo();
    let settle: () => void = () => undefined;
    const raw = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const prune = vi
      .spyOn(FilesystemMediaStore.prototype, 'pruneLegacyTemporaries')
      .mockImplementation(async () => {
        expect(f.registry.activeOwners).toBe(1);
        await raw;
        return { removed: 0, retained: 0, reasons: {} };
      });
    const command = pruneTemporariesCommand(
      { legacyOffline: true, force: true },
      {
        io,
        global,
        homeDir,
        invocation: f.invocation,
      },
    );
    try {
      expect(prune).toHaveBeenCalledOnce();
      f.invocation.finiteExit.fail('cli_internal');
      await reactions();
      expect(f.registry.activeOwners, 'MAINTENANCE_RAW_OPERATION_IS_STILL_OWED').toBe(1);
      expect(f.registry.budget.deadline()).toBe(3000);
      expect(out()).toBe('');
      settle();
      await expect(command).rejects.toMatchObject({ code: 'cli_internal', exitCode: 9 });
      expect(out()).toBe('');
      expect(f.registry.activeOwners).toBe(0);
    } finally {
      settle();
      prune.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
