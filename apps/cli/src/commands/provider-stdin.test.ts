import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openLocalDb } from '../db/open.js';
import { CliError } from '../process/errors.js';
import { renderError } from '../process/render-error.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import { captureIo } from '../test-support.js';
import { executeCommand } from './dispatch.js';

vi.mock('../db/open.js', () => ({ openLocalDb: vi.fn() }));
vi.mock('../secrets/os-keychain.js', () => ({ createOsKeychainStore: vi.fn() }));
vi.mock('../config/load.js', () => ({
  loadResolvedConfig: () => ({ homeDir: '/unused-fixture-home' }),
}));

const CAP = 65_536;

describe('provider dispatch uses the production bounded stdin reader', () => {
  let client: DbClient;
  const keychain = { get: vi.fn(() => null), set: vi.fn(), delete: vi.fn(() => false) };
  const close = vi.fn();
  let stdin: PropertyDescriptor | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    client = createClient(':memory:');
    runMigrations(client.db);
    vi.mocked(openLocalDb).mockReturnValue({ db: client.db, close });
    vi.mocked(createOsKeychainStore).mockReturnValue(keychain);
  });
  afterEach(() => {
    if (stdin !== undefined) Object.defineProperty(process, 'stdin', stdin);
    client.sqlite.close();
  });

  function invoke(input: AsyncIterable<unknown> & { isTTY?: boolean }) {
    Object.defineProperty(process, 'stdin', { configurable: true, value: input });
    const io = captureIo();
    return {
      io,
      result: executeCommand(
        'provider.set-key',
        { positionals: ['openai'], options: {} },
        {
          io: io.io,
          global: {
            json: false,
            color: false,
            cwd: '/unused-fixture-cwd',
            configPath: undefined,
            verbosity: 'normal',
          },
        },
      ),
    };
  }

  it('stores exactly the provider-trimmed value after accepting an exact-capacity payload', async () => {
    const value = 'x'.repeat(CAP - 4);
    const { result } = invoke({
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield ` ${value} \r\n`;
      },
    });
    await expect(result).resolves.toBe(0);
    expect(keychain.set).toHaveBeenCalledExactlyOnceWith('openai:default', value);
    expect(
      createProviderStore(client.db, { uuid: () => 'unused', now: () => 0 }).get('openai')
        ?.apiKeyKeychainRef,
    ).toBe('openai:default');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(['over-cap', 'TTY', 'empty', 'source-fault'] as const)(
    'refuses %s before key or provider-row writes and closes its opened db',
    async (mode) => {
      const opaque = 'opaque-provider-stdin-729';
      const next = vi.fn(() => {
        if (mode === 'source-fault')
          return Promise.reject(new CliError('invalid_invocation', opaque));
        return Promise.resolve({
          done: false,
          value: mode === 'empty' ? '  ' : opaque + 'x'.repeat(CAP),
        });
      });
      let pulled = false;
      const { io, result } = invoke({
        isTTY: mode === 'TTY',
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (pulled) return Promise.resolve({ done: true, value: undefined });
            pulled = true;
            return next();
          },
        }),
      });
      const error = await result.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CliError);
      if (!(error instanceof CliError)) throw new Error('expected invocation refusal');
      expect(error.exitCode).toBe(2);
      if (mode === 'over-cap')
        expect(error.message, 'secrets-provider-real-reader-cap').toContain('65536-byte limit');
      if (mode === 'TTY') expect(next).not.toHaveBeenCalled();
      expect(keychain.set).not.toHaveBeenCalled();
      expect(keychain.get).not.toHaveBeenCalled();
      expect(
        createProviderStore(client.db, { uuid: () => 'unused', now: () => 0 }).get('openai'),
      ).toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      expect(io.out()).toBe('');
      for (const json of [false, true])
        for (const verbose of [false, true]) {
          const rendered = captureIo();
          renderError(error, { json, verbose }, rendered.io);
          expect(rendered.out()).toBe('');
          expect(rendered.err()).not.toContain(opaque);
        }
    },
  );
});
