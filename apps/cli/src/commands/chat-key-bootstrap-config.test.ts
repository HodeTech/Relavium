import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import { afterEach, expect, it, vi } from 'vitest';
import { loadResolvedConfig } from '../config/load.js';
import { openLocalDb } from '../db/open.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import { captureIo } from '../test-support.js';
import {
  chatCommand,
  chatResumeCommand,
  type ChatCommandDeps,
  type ChatResolvedKeys,
} from './chat.js';
import { executeCommand } from './dispatch.js';

vi.mock('../db/open.js', () => ({ openLocalDb: vi.fn() }));
vi.mock('../secrets/os-keychain.js', () => ({ createOsKeychainStore: vi.fn() }));
vi.mock('./chat.js', async (original) => ({
  ...(await original<typeof import('./chat.js')>()),
  chatCommand: vi.fn(),
  chatResumeCommand: vi.fn(),
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it.each(
  ['chat', 'chat-resume'].flatMap((command) =>
    [true, false].map((interactive) => ({ command, interactive })),
  ),
)(
  '$command key bootstrap uses its validated home without reopening config (interactive=$interactive)',
  async ({ command, interactive }) => {
    const root = mkdtempSync(join(tmpdir(), 'rlv-bootstrap-snapshot-'));
    roots.push(root);
    const home = join(root, 'operator');
    const cwd = join(root, 'workspace');
    mkdirSync(join(home, '.relavium'), { recursive: true });
    mkdirSync(cwd);
    const configPath = join(home, '.relavium', 'config.toml');
    writeFileSync(configPath, '[preferences]\ndefault_mode="auto"\n');
    const loaded = loadResolvedConfig({ cwd, home });
    writeFileSync(configPath, 'invalid TOML [');
    const client = createClient(':memory:');
    runMigrations(client.db);
    const close = vi.fn();
    const keychain = { get: vi.fn(() => null), set: vi.fn(), delete: vi.fn(() => false) };
    vi.mocked(createOsKeychainStore).mockReturnValue(keychain);
    vi.mocked(openLocalDb).mockReturnValue({ db: client.db, close });
    createProviderStore(client.db, { uuid: () => 'bootstrap-provider', now: () => 1 }).upsert({
      name: 'openai',
      displayName: 'offline endpoint',
      baseUrl: 'https://gateway.example.invalid/v1',
      kind: 'openai-compatible',
    });
    let failure: unknown;
    let keys: ChatResolvedKeys | undefined;
    const inspect = (deps: ChatCommandDeps): Promise<4> => {
      try {
        keys = deps.resolveKeys?.(undefined, loaded);
      } catch (cause) {
        failure = cause;
      }
      return Promise.resolve(4);
    };
    vi.mocked(chatCommand).mockImplementation((_args, deps) => inspect(deps));
    vi.mocked(chatResumeCommand).mockImplementation((_args, deps) => inspect(deps));
    const { io } = captureIo();
    try {
      await expect(
        executeCommand(
          command,
          { positionals: command === 'chat' ? [] : ['saved-session'], options: {} },
          {
            io: { ...io, stdoutIsTty: interactive },
            global: { cwd, configPath, json: false, color: false, verbosity: 'normal' },
          },
        ),
      ).resolves.toBe(4);
      expect(failure, 'MVP3_CHAT_KEY_BOOTSTRAP_SNAPSHOT').toBeUndefined();
      expect(keys?.providers?.resolveProvider('openai')?.customEndpoint).toBe(true);
      expect(openLocalDb).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openLocalDb).mock.calls[0]?.[0]).toBe(home);
      expect(close).toHaveBeenCalledTimes(1);
      expect(keychain.get).not.toHaveBeenCalled();
      expect(keychain.set).not.toHaveBeenCalled();
      expect(keychain.delete).not.toHaveBeenCalled();
    } finally {
      client.sqlite.close();
    }
  },
);
