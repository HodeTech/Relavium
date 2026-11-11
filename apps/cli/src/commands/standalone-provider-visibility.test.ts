import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publicationRace = vi.hoisted((): { beforeRename: (() => void) | undefined } => ({
  beforeRename: undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      fs.fsyncSync(fd);
      const race = publicationRace.beforeRename;
      publicationRace.beforeRename = undefined;
      race?.();
    },
  };
});

import { SessionChatLifetime } from '../chat/session-chat-lifetime.js';
import { loadResolvedConfig } from '../config/load.js';
import { createProviderResolver } from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { acknowledgeWrite } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import {
  runStandaloneProviderSetup,
  type StandaloneProviderSetupResult,
} from './standalone-provider-setup.js';

const SIGNALS = { onInterrupt: () => () => undefined, onTerminationSignal: () => () => undefined };
const JOB = {
  supported: false,
  onSuspend: () => () => undefined,
  onContinue: () => () => undefined,
  suspendSelf: () => undefined,
};
const credential = ['synthetic', 'provider', 'visibility-only'].join('-');
const initial = '# Preserve this config until a visible rewrite is admitted\n';

async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { interval: 10, timeout: 3000 });
}

describe('standalone rewrite visibility at actual publication', () => {
  let root: string;
  let client: DbClient;
  beforeEach(() => {
    publicationRace.beforeRename = undefined;
    root = mkdtempSync(join(tmpdir(), 'relavium-standalone-visibility-'));
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    publicationRace.beforeRename = undefined;
    client.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['cancel', 'resize'] as const)(
    'rechecks after file sync, then permits only %s to settle the pending geometry wait',
    async (outcome) => {
      const selected = join(root, 'selected.toml');
      writeFileSync(selected, initial);
      const loaded = loadResolvedConfig({ cwd: root, home: root, configPath: selected });
      const global: GlobalOptions = {
        cwd: root,
        configPath: selected,
        json: false,
        color: false,
        noAltScreen: true,
        verbosity: 'normal',
      };
      const f = invocationFixture();
      const lifetime = new SessionChatLifetime(f.invocation, SIGNALS);
      const stdin = new OwnedTtyInput();
      const stdout = new OwnedTtyOutput();
      const stderr = new OwnedTtyOutput();
      const captured = captureIo();
      const env = { OPENAI_API_KEY: credential };
      const io = {
        ...captured.io,
        env,
        stdin,
        stdinIsTty: true,
        stdoutIsTty: true,
        nativeStdin: stdin,
        nativeStdout: stdout,
        nativeStderr: stderr,
        writeOutAcknowledged: (text: string) => acknowledgeWrite(stdout, text),
      };
      const keychain = { get: () => null, set: vi.fn(), delete: () => false };
      const policy = createStandardEnvKeyPolicy(loaded.globalConfig?.preferences);
      const resolver = createProviderResolver(env, keychain, { standardEnvPolicy: policy });
      let id = 0;
      const store = createProviderStore(client.db, {
        uuid: () => `visible-provider-${++id}`,
        now: () => 0,
      });
      let result: StandaloneProviderSetupResult | undefined;
      const running = lifetime.execute(async () => {
        result = await runStandaloneProviderSetup({
          lifetime,
          loaded,
          global,
          io,
          resolver,
          policy,
          store,
          keychain,
          jobControlLifecycle: JOB,
        });
        return 0;
      });
      await until(() => stdout.frames.join('').includes('Allow this source?'));
      let changedSize = false;
      publicationRace.beforeRename = () => {
        changedSize = true;
        stdout.columns = 40;
        stdout.emit('resize');
      };
      stdin.push('\r');
      await until(() => changedSize && stdout.frames.join('').includes('Terminal too small'));
      expect(readFileSync(selected, 'utf8')).toBe(initial);
      expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(() => resolver.keyFor('openai')).toThrow('has not been allowed');
      expect(result).toBeUndefined();
      if (outcome === 'cancel') stdin.push('\x03');
      else {
        stdout.columns = 100;
        stdout.emit('resize');
      }
      expect(await running).toBe(0);
      expect(f.registry.activeOwners).toBe(0);
      expect(f.registry.observations.exitCode()).toBe(0);
      expect(f.exit).not.toHaveBeenCalled();
      expect(stdin.isRaw).toBe(false);
      if (outcome === 'cancel') {
        expect(result?.status).toBe('cancelled');
        expect(readFileSync(selected, 'utf8')).toBe(initial);
        expect(() => resolver.keyFor('openai')).toThrow('has not been allowed');
      } else {
        expect(result?.status).toBe('ready');
        expect(resolver.keyFor('openai')).toBe(credential);
        expect(
          loadResolvedConfig({ cwd: root, home: root, configPath: selected }).globalConfig
            ?.preferences?.standard_env_key_consent,
        ).toEqual({ openai: 'OPENAI_API_KEY' });
      }
      expect(stdout.frames.join('') + captured.err()).not.toContain(credential);
      expect(keychain.set).not.toHaveBeenCalled();
    },
  );
});
