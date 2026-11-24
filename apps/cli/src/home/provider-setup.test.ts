import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderStore } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../config/errors.js';
import { globalConfigPath } from '../config/write.js';
import { loadConfigFile } from '../config/load.js';
import { GlobalConfigSchema } from '@relavium/shared';
import { createProviderResolver } from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { captureIo } from '../test-support.js';
import { createProviderSetupCoordinator, type ProviderSetupDeps } from './provider-setup.js';

vi.mock('../onboarding/wizard.js', () => ({ runOnboardingWizard: vi.fn(() => Promise.resolve()) }));
import { runOnboardingWizard } from '../onboarding/wizard.js';

const store: ProviderStore = {
  list: () => [],
  get: () => undefined,
  upsert: () => {
    throw new Error('unexpected');
  },
  setKeychainRef: () => {},
  clearKeychainRef: () => {},
};
const keychain: KeychainStore = { get: () => null, set: () => {}, delete: () => false };
const unavailable: KeychainStore = {
  ...keychain,
  get: () => {
    throw new KeychainUnavailableError('private detail');
  },
};

function scriptedFlow(answers: (string | symbol)[]) {
  let controller = new AbortController();
  const messages: string[] = [];
  const flow: NativePromptFlow = {
    pick: () => Promise.reject(new Error('Unexpected session picker in credential fixture.')),
    begin: () => {
      controller = new AbortController();
      return controller.signal;
    },
    end: () => Promise.resolve(),
    cancel: () => controller.abort(),
    note: (m) => {
      messages.push(m);
    },
    busy: () => {},
    select: ({ message, options }) => {
      messages.push(message, ...options.map((o) => `${o.label} ${o.hint ?? ''}`));
      return Promise.resolve(answers.shift() ?? NATIVE_PROMPT_CANCEL);
    },
    confirm: () => Promise.resolve(false),
    text: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
    password: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
  };
  return { flow, messages };
}

describe('provider setup coordinator', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-setup-'));
    vi.clearAllMocks();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  function fixture(
    answers: (string | symbol)[],
    options: {
      env?: Record<string, string>;
      keychain?: KeychainStore;
      acknowledged?: boolean;
    } = {},
  ) {
    const policy = createStandardEnvKeyPolicy();
    const resolver = createProviderResolver(options.env ?? {}, options.keychain ?? keychain, {
      standardEnvPolicy: policy,
    });
    const scripted = scriptedFlow(answers);
    const deps: ProviderSetupDeps = {
      flow: scripted.flow,
      resolver,
      policy,
      globalConfig: options.acknowledged
        ? { preferences: { keychain_unavailable_acknowledged: true } }
        : undefined,
      home,
      globalConfigPath: globalConfigPath(home),
      assertAdmitting: () => {},
      endpointContext: () => 'Official endpoint',
      publishPreference: (prepared, assertAdmitting) =>
        Promise.resolve(prepared.publish(assertAdmitting)),
      wizard: { store, keychain, io: captureIo().io, writeDefaultModel: () => {} },
    };
    return { deps, policy, resolver, ...scripted };
  }

  it('suppresses setup when any env key works even if the keychain is unavailable', async () => {
    const f = fixture([], {
      env: { RELAVIUM_OPENAI_API_KEY: 'never-display-this' },
      keychain: unavailable,
    });
    expect(await createProviderSetupCoordinator(f.deps).run('automatic')).toEqual({
      status: 'ready',
      changed: false,
    });
    expect(f.messages).toEqual([]);
  });

  it('publishes explicit source consent and a fresh policy can read it after restart', async () => {
    const f = fixture(['use'], { env: { OPENAI_API_KEY: 'never-display-this' } });
    expect(await createProviderSetupCoordinator(f.deps).run('automatic')).toMatchObject({
      status: 'ready',
      changed: true,
    });
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
    const text = readFileSync(globalConfigPath(home), 'utf8');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).not.toContain('never-display-this');
    const restarted = createStandardEnvKeyPolicy(
      loadConfigFile(globalConfigPath(home), GlobalConfigSchema)?.preferences,
    );
    expect(restarted.allows('openai', 'OPENAI_API_KEY')).toBe(true);
    expect(f.messages.join(' ')).not.toContain('never-display-this');
  });

  it('defers cancellation and allows explicit provider selection to reoffer consent', async () => {
    const f = fixture([NATIVE_PROMPT_CANCEL, 'openai', 'use'], {
      env: { OPENAI_API_KEY: 'never-display-this' },
    });
    const coordinator = createProviderSetupCoordinator(f.deps);
    expect((await coordinator.run('automatic')).status).toBe('cancelled');
    expect((await coordinator.run('automatic')).status).toBe('deferred');
    expect((await coordinator.run('explicit')).status).toBe('ready');
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
  });

  it('routes different key to selected provider without consent', async () => {
    const f = fixture(['manual'], { env: { OPENAI_API_KEY: 'secret' } });
    await createProviderSetupCoordinator(f.deps).run('automatic');
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
    expect(runOnboardingWizard).toHaveBeenCalledWith(
      expect.objectContaining({ initialProvider: 'openai' }),
    );
  });

  it('requires separate invocation-only confirmation after prepublication failure', async () => {
    const f = fixture(['use', 'once'], { env: { OPENAI_API_KEY: 'secret' } });
    const deps = {
      ...f.deps,
      publishPreference: () => Promise.reject(new ConfigError('x', 'fail')),
    };
    const outcome = await createProviderSetupCoordinator(deps).run('automatic');
    expect(outcome.notice).toContain('invocation only');
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
    expect(f.messages.join(' ')).not.toContain('secret');
  });

  it('does not grant after a failed write followed by cancel', async () => {
    const f = fixture(['use', 'cancel'], { env: { OPENAI_API_KEY: 'secret' } });
    const deps = {
      ...f.deps,
      publishPreference: () => Promise.reject(new ConfigError('x', 'fail')),
    };
    expect((await createProviderSetupCoordinator(deps).run('automatic')).status).toBe('cancelled');
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
  });

  it('retains the published grant when cancellation arrives after rename', async () => {
    const f = fixture(['use'], { env: { OPENAI_API_KEY: 'secret' } });
    const deps: ProviderSetupDeps = {
      ...f.deps,
      publishPreference: (prepared, assertAdmitting) => {
        prepared.publish(assertAdmitting);
        f.flow.cancel();
        return Promise.resolve({ durability: 'unconfirmed' });
      },
    };
    const outcome = await createProviderSetupCoordinator(deps).run('automatic');
    expect(outcome.status).toBe('ready');
    expect(outcome.notice).toContain('unconfirmed');
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
  });

  it('remembers only explicit acknowledgement of genuine keychain failure', async () => {
    const f = fixture(['ack'], { keychain: unavailable });
    const coordinator = createProviderSetupCoordinator(f.deps);
    expect((await coordinator.run('automatic')).status).toBe('deferred');
    expect(readFileSync(globalConfigPath(home), 'utf8')).toContain(
      'keychain_unavailable_acknowledged = true',
    );
    expect((await coordinator.run('automatic')).notice).toContain('retry');
    expect(f.policy.allows('anthropic', 'ANTHROPIC_API_KEY')).toBe(false);
  });

  it('refuses a linked target without retry and still requires an explicit invocation choice', async () => {
    const f = fixture(['use', 'cancel'], { env: { OPENAI_API_KEY: 'secret' } });
    mkdirSync(join(home, '.relavium'));
    symlinkSync(join(home, 'absent'), globalConfigPath(home));
    await createProviderSetupCoordinator(f.deps).run('automatic');
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
    expect(f.messages.join(' ')).not.toContain('Retry saving');
    expect(f.messages.join(' ')).toContain('symbolic link');
  });

  it('explains custom endpoint ineligibility before opening the chosen manual flow', async () => {
    const f = fixture(['openai']);
    const resolver = {
      ...f.resolver,
      availability: (id: 'anthropic' | 'openai' | 'gemini' | 'deepseek') =>
        id === 'openai'
          ? {
              status: 'ineligible-custom-endpoint' as const,
              keychainHealth: 'available' as const,
              source: { kind: 'standard-env' as const, name: 'OPENAI_API_KEY' as const },
            }
          : { status: 'missing' as const, keychainHealth: 'available' as const },
    };
    const deps = { ...f.deps, resolver, endpointContext: () => 'Configured custom endpoint' };
    await createProviderSetupCoordinator(deps).run('explicit');
    expect(f.messages.join(' ')).toContain('Configured custom endpoint');
    expect(runOnboardingWizard).toHaveBeenCalledWith(
      expect.objectContaining({ initialProvider: 'openai' }),
    );
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
  });

  it('sets a starter default after the first consent and keeps grant when default is cancelled', async () => {
    const f = fixture(['use'], { env: { OPENAI_API_KEY: 'secret' } });
    const writeDefaultModel = vi.fn((model: string, provider: string) => {
      if (!model || !provider) throw new Error('missing model');
      return { kind: 'cancelled' };
    });
    const coordinator = createProviderSetupCoordinator({
      ...f.deps,
      wizard: { ...f.deps.wizard, writeDefaultModel },
    });
    const result = await coordinator.run('automatic');
    expect(writeDefaultModel).toHaveBeenCalledOnce();
    expect(writeDefaultModel.mock.calls[0]?.slice(0, 2)).toEqual(['gpt-5.4-mini', 'openai']);
    expect(result.notice).toContain('Starter default was not saved');
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
  });

  it('does not switch starter default when another provider already works', async () => {
    const f = fixture(['openai', 'use'], {
      env: { OPENAI_API_KEY: 'secret', RELAVIUM_ANTHROPIC_API_KEY: 'other-secret' },
    });
    const writeDefaultModel = vi.fn();
    const coordinator = createProviderSetupCoordinator({
      ...f.deps,
      wizard: { ...f.deps.wizard, writeDefaultModel },
    });
    expect((await coordinator.run('explicit')).status).toBe('ready');
    expect(writeDefaultModel).not.toHaveBeenCalled();
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
  });

  it('preserves the wizard’s committed key note after a late cancellation', async () => {
    const f = fixture([]);
    vi.mocked(runOnboardingWizard).mockImplementationOnce((deps) => {
      deps.native?.flow.cancel();
      deps.native?.flow.committedNote?.(
        'The provider key was stored; the default was not saved.',
        'Connected',
      );
      return Promise.resolve();
    });
    const result = await createProviderSetupCoordinator(f.deps).run('automatic');
    expect(result).toEqual({
      status: 'ready',
      changed: true,
      notice: 'Connected: The provider key was stored; the default was not saved.',
    });
  });

  it('does not swallow an unrelated failure merely because cancellation also happened', async () => {
    const f = fixture(['use'], { env: { OPENAI_API_KEY: 'secret' } });
    const failure = new Error('unexpected failure');
    const deps = {
      ...f.deps,
      publishPreference: () => {
        f.flow.cancel();
        return Promise.reject(failure);
      },
    };
    await expect(createProviderSetupCoordinator(deps).run('automatic')).rejects.toBe(failure);
    expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
  });

  it('does not invent a keychain failure for a missing key', async () => {
    const f = fixture([]);
    await createProviderSetupCoordinator(f.deps).run('automatic');
    expect(runOnboardingWizard).toHaveBeenCalled();
    expect(f.messages.join(' ')).not.toContain('unavailable');
  });

  // ── MVP-11 Step 2.4 (ADR-0146 §6): one first screen, no dead end ───────────────────────────────────────────────────────────

  describe('the explicit Providers list', () => {
    it('says what each row is and what Enter does, by display name, and never points at the screen it is on', async () => {
      const f = fixture([NATIVE_PROMPT_CANCEL]);
      await createProviderSetupCoordinator(f.deps).run('explicit');
      const list = f.messages.filter((message) => message.includes('no key yet'));
      expect(list).toEqual([
        'Anthropic no key yet · Enter to add one',
        'OpenAI no key yet · Enter to add one',
        'Google Gemini no key yet · Enter to add one',
        'DeepSeek no key yet · Enter to add one',
      ]);
      const text = f.messages.join('\n');
      expect(text).not.toContain('open `/providers`');
      expect(text).not.toContain("provider 'anthropic'");
    });

    it('offers an environment key that was declined with Not now again, and Enter on its row asks for the consent again', async () => {
      const f = fixture(['defer', 'openai', 'use'], {
        env: { OPENAI_API_KEY: 'never-display-this' },
      });
      const coordinator = createProviderSetupCoordinator(f.deps);
      expect((await coordinator.run('automatic')).status).toBe('deferred');
      expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
      const before = f.messages.length;
      const explicit = await coordinator.run('explicit');
      expect(f.messages.slice(before)).toContain(
        'OpenAI OPENAI_API_KEY is set · Enter to allow it',
      );
      expect(
        f.messages.filter((message) => message.includes('Allow this source?')),
        'the consent card was asked a second time, from the list',
      ).toHaveLength(2);
      expect(explicit.status).toBe('ready');
      expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
      expect(f.messages.join(' ')).not.toContain('never-display-this');
    });
  });

  describe('a skip says so, and only a first run skips', () => {
    it.each([
      ['home' as const, 'Setup skipped · /providers connects a provider any time'],
      [
        'standalone-chat' as const,
        'Setup skipped · restart this chat to open provider setup any time',
      ],
    ])(
      'Esc on the first card of a keyless first run, on %s, leaves the skip line as the notice',
      async (surface, line) => {
        const f = fixture([NATIVE_PROMPT_CANCEL], { env: { OPENAI_API_KEY: 'x-secret' } });
        const result = await createProviderSetupCoordinator({
          ...f.deps,
          credentialSurface: surface,
        }).run('automatic');
        expect(result).toEqual({ status: 'cancelled', changed: false, notice: line });
      },
    );

    it('Not now on the environment key is a skip too', async () => {
      const f = fixture(['defer'], { env: { OPENAI_API_KEY: 'x-secret' } });
      const result = await createProviderSetupCoordinator(f.deps).run('automatic');
      expect(result).toEqual({
        status: 'deferred',
        changed: false,
        notice: 'Setup skipped · /providers connects a provider any time',
      });
    });

    it('closing the Providers list while keyless is a skip', async () => {
      const f = fixture([NATIVE_PROMPT_CANCEL]);
      expect(await createProviderSetupCoordinator(f.deps).run('explicit')).toEqual({
        status: 'cancelled',
        changed: false,
        notice: 'Setup skipped · /providers connects a provider any time',
      });
    });

    it('closing the Providers list of a Home that already has a key skips nothing, and says nothing', async () => {
      const f = fixture([NATIVE_PROMPT_CANCEL], { env: { RELAVIUM_OPENAI_API_KEY: 'a-key' } });
      expect(await createProviderSetupCoordinator(f.deps).run('explicit')).toEqual({
        status: 'cancelled',
        changed: false,
      });
    });
  });

  describe('a locked keychain is said first', () => {
    it('offers Retry keychain, the remembered reminder and Not now; no Enter a key (it would be checked and then lost)', async () => {
      const f = fixture(['cancel'], { keychain: unavailable });
      await createProviderSetupCoordinator(f.deps).run('automatic');
      const text = f.messages.join('\n');
      expect(text).toContain('Retry keychain');
      expect(text).toContain('Remember this and continue without a key');
      expect(text).toContain('Not now');
      expect(text).not.toContain('Enter a key');
      expect(text).not.toContain('Enter a different key');
      expect(runOnboardingWizard, 'no key prompt was opened').not.toHaveBeenCalled();
    });

    it('names the environment variable once, as a variable name, and no shell command; says what Remember saves', async () => {
      const f = fixture(['cancel'], { keychain: unavailable });
      await createProviderSetupCoordinator(f.deps).run('automatic');
      const text = f.messages.join('\n');
      expect(text.split('RELAVIUM_ANTHROPIC_API_KEY')).toHaveLength(2);
      expect(text).not.toContain('export');
      expect(text).not.toContain('relavium provider');
      expect(text).toContain('saved in your global config');
    });

    it('leaves out the reminder once it is remembered, and still offers no key entry', async () => {
      // The list opens first (explicit); picking a provider reaches the keychain step.
      const f = fixture(['anthropic', 'cancel'], { keychain: unavailable, acknowledged: true });
      await createProviderSetupCoordinator(f.deps).run('explicit');
      const text = f.messages.join('\n');
      expect(text, 'the keychain step was reached').toContain('Retry keychain');
      expect(text).not.toContain('Remember this');
      expect(text).not.toContain('Enter a key');
    });
  });

  it('shows the intro note on the card from its first row', async () => {
    const f = fixture([NATIVE_PROMPT_CANCEL]);
    const notes: string[] = [];
    const flow = { ...f.deps.flow, note: (message: string) => notes.push(message) };
    await createProviderSetupCoordinator({ ...f.deps, flow }).run('explicit', 'Why this opened.');
    expect(notes[0]).toBe('Why this opened.');
  });
});
