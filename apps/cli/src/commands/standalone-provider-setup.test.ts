import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionChatLifetime } from '../chat/session-chat-lifetime.js';
import { loadResolvedConfig } from '../config/load.js';
import { createProviderResolver } from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { acknowledgeWrite } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import { SHOW_CURSOR } from '../render/alt-screen.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import {
  applyStandaloneDefault,
  runStandaloneProviderSetup,
  type StandaloneProviderSetupResult,
} from './standalone-provider-setup.js';

const INERT_SIGNALS = {
  onInterrupt: () => () => undefined,
  onTerminationSignal: () => () => undefined,
};
const INERT_JOB = {
  supported: false,
  onSuspend: () => () => undefined,
  onContinue: () => () => undefined,
  suspendSelf: () => undefined,
};
const credential = ['synthetic', 'credential', 'no-suffix-display'].join('-');

/**
 * The consent card opens on `Not now` (ADR-0146 §6, the interim before Step 6's input guards), so a test that means `Use it` moves there:
 * one Down arrow wraps from the last row to the first, and the key after it is read only once the card has drawn the row it moved to.
 */
async function chooseUseIt(f: {
  readonly stdin: { push(chunk: string): boolean };
  text(): string;
}): Promise<void> {
  expect(f.text()).toContain('❯ Not now');
  f.stdin.push('\x1b[B');
  await until(() => f.text().includes('❯ Use it'));
}

async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { interval: 10, timeout: 3000 });
}

describe('standalone native provider setup lifecycle', () => {
  let root: string;
  let client: DbClient;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-standalone-setup-'));
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(env: Readonly<Record<string, string | undefined>> = {}) {
    const global: GlobalOptions = {
      cwd: root,
      configPath: join(root, 'selected.toml'),
      json: false,
      color: false,
      noAltScreen: true,
      verbosity: 'normal',
    };
    const loaded = loadResolvedConfig({ cwd: root, configPath: global.configPath, home: root });
    const f = invocationFixture();
    const lifetime = new SessionChatLifetime(f.invocation, INERT_SIGNALS);
    const stdin = new OwnedTtyInput();
    const stdout = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    const captured = captureIo();
    const io = {
      ...captured.io,
      env,
      stdin,
      stdoutIsTty: true,
      stdinIsTty: true,
      nativeStdin: stdin,
      nativeStdout: stdout,
      nativeStderr: stderr,
      writeOutAcknowledged: (text: string) => acknowledgeWrite(stdout, text),
    };
    const policy = createStandardEnvKeyPolicy(loaded.globalConfig?.preferences);
    const keychain = { get: vi.fn(() => null), set: vi.fn(), delete: vi.fn(() => false) };
    const resolver = createProviderResolver(env, keychain, {
      standardEnvPolicy: policy,
      credentialSurface: 'standalone-chat',
    });
    const store = createProviderStore(client.db, { uuid: () => 'provider-1', now: () => 0 });
    let outcome: StandaloneProviderSetupResult | undefined;
    const run = () =>
      lifetime.execute(async () => {
        outcome = await runStandaloneProviderSetup({
          lifetime,
          loaded,
          global,
          io,
          resolver,
          policy,
          store,
          keychain,
          jobControlLifecycle: INERT_JOB,
        });
        return 0;
      });
    return {
      ...f,
      global,
      loaded,
      stdin,
      stdout,
      stderr,
      io,
      keychain,
      policy,
      resolver,
      run,
      outcome: () => outcome,
      text: () => stdout.frames.join(''),
      err: captured.err,
    };
  }

  it.each(['\x1b', '\x03'])(
    'cancels native setup without a failure or a residual input owner (%j)',
    async (key) => {
      const f = fixture();
      const baseline = f.stdin.listeners('readable');
      const running = f.run();
      await until(() => f.text().includes('Which provider?'));
      f.stdin.push('\r');
      await until(() => f.text().includes('API key'));
      f.stdin.push(key);
      expect(await running).toBe(0);
      expect(f.outcome()?.status).toBe('cancelled');
      expect(f.registry.activeOwners).toBe(0);
      expect(f.exit).not.toHaveBeenCalled();
      expect(f.stdin.isRaw).toBe(false);
      expect(f.stdin.listeners('readable')).toEqual(baseline);
      expect(f.text()).toContain(DISABLE_BRACKETED_PASTE);
      expect(f.text()).toContain(SHOW_CURSOR);
      expect(f.keychain.set).not.toHaveBeenCalled();
    },
  );

  it('publishes named-source consent and starter default only after a visible rewrite notice, quarantining Enter suffix', async () => {
    const f = fixture({ OPENAI_API_KEY: credential });
    let noticeBeforeDefault = false;
    f.stdout.onFrame = (frame) => {
      if (frame.includes('Saving preferences')) {
        const text = readFileSync(f.loaded.globalConfigPath, 'utf8');
        if (!text.includes('default_model')) noticeBeforeDefault = true;
      }
    };
    const running = f.run();
    await until(() => f.text().includes('Allow this source?'));
    expect(() => f.resolver.keyFor('openai')).toThrow('has not been allowed');
    await chooseUseIt(f);
    f.stdin.push('\rtrailing-secret');
    expect(await running).toBe(0);
    expect(f.resolver.keyFor('openai')).toBe(credential);
    const loaded = loadResolvedConfig({
      cwd: root,
      home: root,
      configPath: f.loaded.globalConfigPath,
    });
    expect(loaded.globalConfig?.preferences?.standard_env_key_consent).toEqual({
      openai: 'OPENAI_API_KEY',
    });
    expect(loaded.config.chat.defaultProvider).toBe('openai');
    expect(noticeBeforeDefault).toBe(true);
    expect(f.registry.activeOwners).toBe(0);
    expect(f.stdin.isRaw).toBe(false);
    expect(f.text() + f.err()).not.toContain(credential);
    expect(f.text() + f.err()).not.toContain('trailing-secret');
    expect(f.keychain.set).not.toHaveBeenCalled();
  });

  it('a bare Enter on the environment-key consent grants nothing: the card opens on Not now, and the config is never written', async () => {
    const f = fixture({ OPENAI_API_KEY: credential });
    const before = existsSync(f.loaded.globalConfigPath)
      ? readFileSync(f.loaded.globalConfigPath, 'utf8')
      : undefined;
    const running = f.run();
    await until(() => f.text().includes('Allow this source?'));
    expect(f.text()).toContain('❯ Not now');
    f.stdin.push('\r');
    expect(await running).toBe(0);
    expect(f.outcome()?.status).toBe('deferred');
    expect(() => f.resolver.keyFor('openai')).toThrow('has not been allowed');
    expect(
      existsSync(f.loaded.globalConfigPath)
        ? readFileSync(f.loaded.globalConfigPath, 'utf8')
        : undefined,
    ).toBe(before);
    expect(f.keychain.set).not.toHaveBeenCalled();
  });

  it('requires independent explicit invocation choices for source consent and model defaults after symlink refusal', async () => {
    const target = join(root, 'target.toml');
    writeFileSync(target, '# Keep this file\n');
    symlinkSync(target, join(root, 'selected.toml'));
    const f = fixture({ OPENAI_API_KEY: credential });
    const running = f.run();
    await until(() => f.text().includes('Allow this source?'));
    await chooseUseIt(f); // the consent opens on `Not now`; this test means `Use it`
    f.stdin.push('\r');
    // Two recovery cards in a row, each naming what it uses: the source first (the variable), then the model (round 2, B6).
    await until(() => f.text().includes('Use OPENAI_API_KEY for this invocation only'));
    expect(f.text()).not.toContain('Use for this invocation only');
    expect(() => f.resolver.keyFor('openai')).toThrow('has not been allowed');
    const afterSource = f.stdout.frames.length;
    f.stdin.push('\r');
    await until(() =>
      /Use (?!OPENAI_API_KEY)\S+ for this invocation only/u.test(
        f.stdout.frames.slice(afterSource).join(''),
      ),
    );
    // Authorizing the named source did not implicitly choose an ephemeral model default.
    expect(f.resolver.keyFor('openai')).toBe(credential);
    expect(f.outcome()).toBeUndefined();
    f.stdin.push('\r');
    expect(await running).toBe(0);
    expect(f.outcome()?.ephemeralDefault?.provider).toBe('openai');
    expect(readFileSync(target, 'utf8')).toBe('# Keep this file\n');
    expect(f.err()).toContain('not saved');
    expect(f.exit).not.toHaveBeenCalled();
  });

  it('does not mount setup for a currently usable key', async () => {
    const f = fixture({ RELAVIUM_OPENAI_API_KEY: credential });
    expect(await f.run()).toBe(0);
    expect(f.outcome()).toEqual({ status: 'ready', changed: false });
    expect(f.text()).toBe('');
    expect(f.stdin.isRaw).toBe(false);
    expect(f.registry.activeOwners).toBe(0);
  });

  it('applies invocation defaults below validated project/workspace chat model choices', () => {
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    const selected = join(root, 'selected.toml');
    writeFileSync(
      selected,
      '[preferences]\ndefault_model="gpt-fixture"\ndefault_provider="openai"\n',
    );
    const binding = { model: 'gemini-fixture', provider: 'gemini' as const };
    let loaded = loadResolvedConfig({ cwd, home: root, configPath: selected });
    expect(applyStandaloneDefault(loaded, binding).config.chat.defaultModel).toBe('gemini-fixture');
    mkdirSync(join(cwd, '.relavium'));
    for (const file of ['workspace.toml', 'project.toml']) {
      writeFileSync(
        join(cwd, '.relavium', file),
        '[chat]\ndefault_model="claude-project"\ndefault_provider="anthropic"\n',
      );
      loaded = loadResolvedConfig({ cwd, home: root, configPath: selected });
      expect(applyStandaloneDefault(loaded, binding).config.chat.defaultModel).toBe(
        'claude-project',
      );
      expect(applyStandaloneDefault(loaded, binding).config.chat.defaultProvider).toBe('anthropic');
      rmSync(join(cwd, '.relavium', file));
    }
    expect(readFileSync(selected, 'utf8')).toContain('gpt-fixture');
  });
});
