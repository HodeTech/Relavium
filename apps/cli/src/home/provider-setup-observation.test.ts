import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderStore } from '@relavium/db';
import { afterEach, expect, it } from 'vitest';

import { StartingModeAuthority, startingModeConfigObserver } from '../chat/starting-mode.js';
import { globalConfigPath } from '../config/write.js';
import { createProviderResolver } from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { captureIo } from '../test-support.js';
import { createProviderSetupCoordinator } from './provider-setup.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const providerStore: ProviderStore = {
  list: () => [],
  get: () => undefined,
  upsert: () => {
    throw new Error('unexpected wizard');
  },
  setKeychainRef: () => {},
  clearKeychainRef: () => {},
};
const keychain: KeychainStore = { get: () => null, set: () => {}, delete: () => false };

it.each(['consent', 'acknowledgement'] as const)(
  'revokes starting auto from the real %s preference preparation before publication',
  async (kind) => {
    const home = mkdtempSync(join(tmpdir(), 'relavium-provider-observation-'));
    homes.push(home);
    mkdirSync(join(home, '.relavium'));
    const path = globalConfigPath(home);
    const auto = { mode: 'auto', source: 'global', globalMode: 'auto', hintShown: false } as const;
    writeFileSync(path, '[preferences]\ndefault_mode = "auto"\n');
    const authority = new StartingModeAuthority(true, auto);
    const selection = authority.resolve(() => auto);
    writeFileSync(path, '[preferences]\ndefault_mode = "ask"\n');
    const policy = createStandardEnvKeyPolicy();
    const store =
      kind === 'acknowledgement'
        ? {
            ...keychain,
            get: () => {
              throw new KeychainUnavailableError('fixture');
            },
          }
        : keychain;
    const resolver = createProviderResolver(
      kind === 'consent' ? { OPENAI_API_KEY: 'fixture-only' } : {},
      store,
      { standardEnvPolicy: policy },
    );
    const controller = new AbortController();
    const flow: NativePromptFlow = {
      pick: () => Promise.reject(new Error('unexpected picker')),
      begin: () => controller.signal,
      end: () => Promise.resolve(),
      cancel: () => controller.abort(),
      note: () => {},
      busy: () => {},
      select: () => Promise.resolve(kind === 'consent' ? 'use' : 'ack'),
      confirm: () => Promise.resolve(false),
      text: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
      password: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
    };
    let publications = 0;
    const coordinator = createProviderSetupCoordinator({
      flow,
      resolver,
      policy,
      home,
      globalConfig: undefined,
      globalConfigPath: path,
      configReadObserver: startingModeConfigObserver(authority),
      assertAdmitting: () => {},
      endpointContext: () => 'Official endpoint',
      publishPreference: (prepared, assertAdmitting) => {
        publications += 1;
        expect(() => authority.assertDispatch(selection, 'write_file')).toThrow(/revoked/);
        return Promise.resolve(prepared.publish(assertAdmitting));
      },
      wizard: {
        store: providerStore,
        keychain: store,
        io: captureIo().io,
        writeDefaultModel: () => {},
      },
    });
    const result = await coordinator.run('automatic');
    expect(result.changed).toBe(true);
    expect(publications).toBe(1);
    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('default_mode = "ask"');
    expect(contents).toContain(
      kind === 'consent' ? 'OPENAI_API_KEY' : 'keychain_unavailable_acknowledged = true',
    );
    writeFileSync(path, '[preferences]\ndefault_mode = "auto"\n');
    expect(() => authority.resolve(() => auto)).toThrow(/no longer admitted/);
  },
);
