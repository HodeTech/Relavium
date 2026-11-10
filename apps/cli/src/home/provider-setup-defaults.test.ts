import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';
import { describe, expect, it, vi } from 'vitest';

import { prepareGlobalPreferences } from '../config/write.js';
import { createProviderResolver, KNOWN_PROVIDERS } from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { keychainAccount, type KeychainStore } from '../secrets/keychain.js';
import { captureIo } from '../test-support.js';
import type { OnboardingDefaultResult } from '../onboarding/wizard.js';
import { createProviderSetupCoordinator } from './provider-setup.js';

function scriptedFlow(answers: readonly string[]) {
  const remaining = [...answers];
  const messages: string[] = [];
  let abort = new AbortController();
  const flow: NativePromptFlow = {
    begin: () => {
      abort = new AbortController();
      return abort.signal;
    },
    end: () => Promise.resolve(),
    cancel: () => abort.abort(),
    note: (message) => {
      messages.push(message);
    },
    committedNote: (message) => {
      messages.push(message);
    },
    busy: () => {},
    select: ({ message, options }) => {
      messages.push(message, ...options.map((option) => `${option.label} ${option.hint ?? ''}`));
      return Promise.resolve(remaining.shift() ?? NATIVE_PROMPT_CANCEL);
    },
    confirm: () => Promise.resolve(false),
    text: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
    password: () => Promise.resolve('synthetic-new-key-4829'),
  };
  return { flow, messages };
}

const original =
  '# keep this exact preference and comments\n[preferences]\ndefault_model = "chosen-model"\ndefault_provider = "anthropic"\n';

function fixture(env: Record<string, string | undefined>, answers: readonly string[]) {
  const home = mkdtempSync(join(tmpdir(), 'relavium-provider-preferences-'));
  mkdirSync(join(home, '.relavium'));
  const path = join(home, '.relavium', 'config.toml');
  writeFileSync(path, original);
  const client = createClient(':memory:');
  runMigrations(client.db);
  const keys = new Map<string, string>();
  const keychain: KeychainStore = {
    get: (account) => keys.get(account) ?? null,
    set: (account, value) => {
      keys.set(account, value);
    },
    delete: (account) => keys.delete(account),
  };
  const policy = createStandardEnvKeyPolicy();
  const resolver = createProviderResolver(env, keychain, { standardEnvPolicy: policy });
  const script = scriptedFlow(answers);
  let sequence = 0;
  const writeDefaultModel = vi.fn(
    (modelId: string, provider: ProviderId, admit?: () => void): OnboardingDefaultResult => ({
      kind: 'saved',
      ...prepareGlobalPreferences(
        { defaultModel: modelId, defaultProvider: provider },
        home,
      ).publish(admit),
    }),
  );
  const coordinator = createProviderSetupCoordinator({
    flow: script.flow,
    resolver,
    policy,
    globalConfig: undefined,
    globalConfigPath: path,
    home,
    assertAdmitting: () => {},
    endpointContext: () => 'Official endpoint',
    publishPreference: (prepared, admit) => Promise.resolve(prepared.publish(admit)),
    wizard: {
      io: captureIo().io,
      store: createProviderStore(client.db, { uuid: () => `provider-${++sequence}`, now: () => 1 }),
      keychain,
      validate: () => Promise.resolve({ ok: true, reason: 'ok', detail: 'verified' }),
      writeDefaultModel,
    },
  });
  return {
    ...script,
    coordinator,
    resolver,
    policy,
    keys,
    path,
    writeDefaultModel,
    close: () => {
      client.sqlite.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('provider maintenance preserves model preference', () => {
  it.each(['connect', 'replace'] as const)(
    '%s stores the key without rewriting a saved model',
    async (action) => {
      const f = fixture(
        action === 'connect'
          ? { RELAVIUM_ANTHROPIC_API_KEY: 'synthetic-existing-key' }
          : { RELAVIUM_OPENAI_API_KEY: 'synthetic-existing-key' },
        action === 'connect' ? ['openai'] : ['openai', 'manual'],
      );
      try {
        expect(await f.coordinator.run('explicit')).toMatchObject({
          status: 'ready',
          changed: true,
        });
        expect(f.keys.get(keychainAccount('openai'))).toBe('synthetic-new-key-4829');
        expect(f.writeDefaultModel).not.toHaveBeenCalled();
        expect(readFileSync(f.path, 'utf8')).toBe(original);
        expect(f.messages.join('\n')).toContain('model preference is unchanged');
        expect(f.messages.join('\n')).not.toContain('4829');
        expect(f.resolver.keyFor('openai')).toBe('synthetic-new-key-4829');
      } finally {
        f.close();
      }
    },
  );

  it('still selects a starter when no source was usable before setup', async () => {
    const f = fixture({}, ['openai']);
    try {
      expect(await f.coordinator.run('explicit')).toMatchObject({ status: 'ready', changed: true });
      expect(f.writeDefaultModel).toHaveBeenCalledOnce();
      expect(readFileSync(f.path, 'utf8')).toContain(KNOWN_PROVIDERS.openai.testModel);
    } finally {
      f.close();
    }
  });

  it.each(['keychain', 'relavium-env', 'standard-env'] as const)(
    'names the usable %s source in the list and selected card',
    async (source) => {
      const name =
        source === 'keychain'
          ? 'OS keychain'
          : source === 'relavium-env'
            ? 'RELAVIUM_OPENAI_API_KEY'
            : 'OPENAI_API_KEY';
      const f = fixture(source === 'keychain' ? {} : { [name]: 'synthetic-existing-key-7361' }, [
        'openai',
        'cancel',
      ]);
      try {
        if (source === 'keychain')
          f.keys.set(keychainAccount('openai'), 'synthetic-existing-key-7361');
        if (source === 'standard-env') f.policy.allowForInvocation('openai');
        await f.coordinator.run('explicit');
        const sourceMessages = f.messages.filter((message) =>
          message.includes(`available from ${name}`),
        );
        expect(sourceMessages).toHaveLength(2); // list hint and the selected provider's source card
        expect(f.messages.join('\n')).not.toContain('7361');
        expect(f.writeDefaultModel).not.toHaveBeenCalled();
        expect(readFileSync(f.path, 'utf8')).toBe(original);
      } finally {
        f.close();
      }
    },
  );
});
