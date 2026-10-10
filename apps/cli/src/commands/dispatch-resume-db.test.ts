import { fileURLToPath } from 'node:url';
import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import { expect, it, vi } from 'vitest';
import { captureIo } from '../test-support.js';
import { openLocalDb } from '../db/open.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import { budgetCommand, gateCommand, type GateCommandDeps } from './gate.js';
import { executeCommand } from './dispatch.js';

vi.mock('../db/open.js', () => ({
  openLocalDb: vi.fn(() => {
    throw new Error('resume must not open a second history connection');
  }),
}));
vi.mock('../secrets/os-keychain.js', () => ({ createOsKeychainStore: vi.fn() }));
vi.mock('./gate.js', () => ({ budgetCommand: vi.fn(), gateCommand: vi.fn() }));

it.each(['gate', 'budget.resume'] as const)(
  '%s builds its actual custom-endpoint resolver over the command-owned native db',
  async (command) => {
    vi.clearAllMocks();
    const client = createClient(':memory:');
    runMigrations(client.db);
    const keychain = {
      get: vi.fn(() => {
        throw new Error('constructing a resolver must not read a credential');
      }),
      set: vi.fn(() => undefined),
      delete: vi.fn(() => false),
    };
    vi.mocked(createOsKeychainStore).mockReturnValue(keychain);
    try {
      createProviderStore(client.db, { uuid: () => 'offline-provider', now: () => 1 }).upsert({
        name: 'openai',
        displayName: 'offline endpoint',
        baseUrl: 'https://gateway.example.invalid/v1',
        kind: 'openai-compatible',
      });
      const inspect = (deps: GateCommandDeps): void => {
        const keys = deps.resolveKeys?.(client.db);
        expect(keys?.providers.resolveProvider('openai')?.customEndpoint).toBe(true);
        expect(typeof keys?.mcpSecretResolver).toBe('function');
      };
      vi.mocked(gateCommand).mockImplementation((_args, deps) => {
        inspect(deps);
        return Promise.resolve(0);
      });
      vi.mocked(budgetCommand).mockImplementation((_args, deps) => {
        inspect(deps);
        return Promise.resolve(0);
      });
      const { io } = captureIo();
      await expect(
        executeCommand(
          command,
          {
            positionals: ['offline-run'],
            options: command === 'gate' ? { approve: true } : { approveAmount: '0' },
          },
          {
            io,
            global: {
              json: false,
              color: false,
              cwd: fileURLToPath(new URL('.', import.meta.url)),
              configPath: undefined,
              verbosity: 'normal',
            },
          },
        ),
      ).resolves.toBe(0);
      expect(openLocalDb).not.toHaveBeenCalled();
      expect(createOsKeychainStore).toHaveBeenCalledTimes(1);
      expect(keychain.get).not.toHaveBeenCalled();
      expect(keychain.set).not.toHaveBeenCalled();
      expect(keychain.delete).not.toHaveBeenCalled();
      expect(command === 'gate' ? gateCommand : budgetCommand).toHaveBeenCalledTimes(1);
    } finally {
      client.sqlite.close();
    }
  },
);
