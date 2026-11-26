/**
 * What the provider setup coordinator reports when its key setup ends, and how it refuses a Home that is closing (MVP-11 unit 6, round 1: test gaps
 * of the P family that survived a mutation sweep of the rewritten `provider-setup.ts`). The key setup (`runNativeSetup`) is replaced by a script
 * that answers a result of the test's choosing, so the coordinator's own mapping is what is read:
 *
 * - every result of the key setup is ONE outcome (a stored key is `ready`, a setup that stored nothing is `incomplete`, a skip or an abort is
 *   `cancelled`, a step back from the first step is the skip);
 * - the automatic first run says how it ended in ONE notice, and says nothing where the setup said it itself or deferred;
 * - a closing Home is refused at the start of a run, and again before a remembered skip is written, and a stopped flow stops the setup's
 *   admission checks.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderStore } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../config/errors.js';
import { ConfigWriteRefusedError, globalConfigPath } from '../config/write.js';
import { createProviderResolver } from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import type { NativeOnboarding } from '../onboarding/wizard.js';
import { setupClosedNotice } from '../onboarding/setup-notes.js';
import { CliError } from '../process/cli-error.js';
import {
  NATIVE_PROMPT_BACK,
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { captureIo } from '../test-support.js';
import { createProviderSetupCoordinator, type ProviderSetupDeps } from './provider-setup.js';

/** What the replaced key setup answers, what it was handed, and what it does before it answers. */
const script = vi.hoisted(() => {
  const state: {
    result: unknown;
    during: (() => void) | undefined;
    native: unknown;
  } = { result: { kind: 'finished', stored: false }, during: undefined, native: undefined };
  return state;
});
vi.mock('../onboarding/wizard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../onboarding/wizard.js')>();
  return {
    ...actual,
    runNativeSetup: vi.fn((_deps: object, native: unknown) => {
      script.native = native;
      script.during?.();
      return Promise.resolve(script.result);
    }),
  };
});

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
const CLOSING = 'Home is closing.';

describe('what the provider setup reports', () => {
  let home: string;
  let closing: boolean;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'relavium-setup-outcomes-'));
    closing = false;
    script.result = { kind: 'finished', stored: false };
    script.during = undefined;
    script.native = undefined;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function fixture(
    options: {
      answers?: (string | symbol)[];
      env?: Record<string, string>;
      rememberSkip?: boolean;
      onEnd?: () => void;
      popup?: boolean;
      /** What the setup's default-model write answers (or throws). */
      writeDefaultModel?: (admit: (() => void) | undefined) => unknown;
      /** Replaces the Home's publication of a config write. */
      publish?: ProviderSetupDeps['publishPreference'];
      /** Runs when a select with this message is answered (before its answer is returned). */
      onAsked?: (message: string) => void;
      /** The keychain the resolver reads (default: an empty one). */
      keychain?: KeychainStore;
    } = {},
  ) {
    const answers = [...(options.answers ?? [])];
    const selects: { message: string; escape: unknown }[] = [];
    let controller = new AbortController();
    const calls = { begin: 0 };
    const flow: NativePromptFlow = {
      pick: () => Promise.reject(new Error('no picker here')),
      begin: () => {
        calls.begin += 1;
        controller = new AbortController();
        return controller.signal;
      },
      end: () => {
        options.onEnd?.();
        return Promise.resolve();
      },
      cancel: () => controller.abort(),
      note: () => {},
      busy: () => {},
      select: (asked) => {
        selects.push({ message: asked.message, escape: asked.escape });
        options.onAsked?.(asked.message);
        return Promise.resolve(answers.shift() ?? NATIVE_PROMPT_CANCEL);
      },
      confirm: () => Promise.resolve(false),
      text: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
      password: () => Promise.resolve(NATIVE_PROMPT_CANCEL),
    };
    const policy = createStandardEnvKeyPolicy();
    const resolver = createProviderResolver(options.env ?? {}, options.keychain ?? keychain, {
      standardEnvPolicy: policy,
    });
    const deps: ProviderSetupDeps = {
      flow,
      resolver,
      policy,
      globalConfig: undefined,
      home,
      globalConfigPath: globalConfigPath(home),
      assertAdmitting: () => {
        if (closing) throw new CliError('invalid_invocation', CLOSING);
      },
      endpointContext: () => 'Official endpoint',
      publishPreference:
        options.publish ??
        ((prepared, assertAdmitting) => Promise.resolve(prepared.publish(assertAdmitting))),
      ...(options.rememberSkip === true ? { rememberSkip: true } : {}),
      ...(options.popup === true ? { popup: true } : {}),
      wizard: {
        store,
        keychain,
        io: captureIo().io,
        writeDefaultModel: (_model, _provider, admit) => options.writeDefaultModel?.(admit),
      },
    };
    return { deps, flow, policy, calls, selects, cancel: () => controller.abort() };
  }

  describe('the key setup’s result is ONE outcome', () => {
    it.each([
      [
        'stored nothing',
        { kind: 'finished', stored: false },
        { status: 'incomplete', changed: true },
      ],
      ['stored a key', { kind: 'finished', stored: true }, { status: 'ready', changed: true }],
      [
        'stored a key and has a line for the host',
        { kind: 'finished', stored: true, notice: 'Stored in the keychain.' },
        { status: 'ready', changed: true, notice: 'Stored in the keychain.' },
      ],
      ['was skipped', { kind: 'skipped' }, { status: 'cancelled', changed: true }],
      [
        'was left before it stored anything',
        { kind: 'cancelled' },
        { status: 'incomplete', changed: true },
      ],
    ] as const)(
      'on /providers, a setup that %s comes out as the one outcome the host reads',
      async (_name, result, expected) => {
        script.result = result;
        const f = fixture({ answers: ['anthropic'] });
        expect(await createProviderSetupCoordinator(f.deps).run('explicit')).toEqual(expected);
      },
    );

    it('a setup that stored nothing and was stopped is cancelled, not merely incomplete', async () => {
      script.result = { kind: 'finished', stored: false };
      const f = fixture({ answers: ['anthropic'] });
      script.during = f.cancel;
      expect(await createProviderSetupCoordinator(f.deps).run('explicit')).toEqual({
        status: 'cancelled',
        changed: true,
      });
    });

    it('a step back with no step before it, on /providers, returns to the list and is not an outcome', async () => {
      // The list is asked again after the step back; the second answer closes it.
      script.result = { kind: 'back' };
      const f = fixture({ answers: ['anthropic', NATIVE_PROMPT_CANCEL] });
      expect(await createProviderSetupCoordinator(f.deps).run('explicit')).toEqual({
        status: 'cancelled',
        changed: false,
      });
    });
  });

  describe('the automatic first run says how it ended in ONE notice, and nothing where the setup said it itself', () => {
    it.each([
      ['a step back from the first step (the skip)', { kind: 'back' }],
      ['a skipped setup', { kind: 'skipped' }],
    ] as const)('%s, not remembered here, says the popup opens again', async (_name, result) => {
      script.result = result;
      const outcome = await createProviderSetupCoordinator(fixture().deps).run('automatic');
      expect(outcome.status).toBe('cancelled');
      expect(outcome.notice).toBe(setupClosedNotice('home'));
    });

    it('a setup that stored nothing and was not left says nothing more (the setup said it)', async () => {
      script.result = { kind: 'finished', stored: false };
      expect(await createProviderSetupCoordinator(fixture().deps).run('automatic')).toEqual({
        status: 'incomplete',
        changed: true,
      });
    });

    it('a setup that stored a key says nothing of its own', async () => {
      script.result = { kind: 'finished', stored: true };
      expect(await createProviderSetupCoordinator(fixture().deps).run('automatic')).toEqual({
        status: 'ready',
        changed: true,
      });
    });

    it('a run that DEFERS (every environment source already said Not now in this process) has no notice', async () => {
      const f = fixture({ env: { OPENAI_API_KEY: 'never-display-this' } });
      f.policy.defer('openai');
      expect(await createProviderSetupCoordinator(f.deps).run('automatic')).toEqual({
        status: 'deferred',
        changed: false,
      });
    });

    it('a /providers the person opened and closed says nothing: its closing is not the first run’s', async () => {
      const f = fixture({ answers: [NATIVE_PROMPT_CANCEL] });
      expect(await createProviderSetupCoordinator(f.deps).run('explicit')).toEqual({
        status: 'cancelled',
        changed: false,
      });
    });
  });

  describe('a closing Home is refused', () => {
    it('at the start of a run: nothing is begun, sampled or asked', async () => {
      const f = fixture({ answers: ['anthropic'] });
      closing = true;
      await expect(createProviderSetupCoordinator(f.deps).run('explicit')).rejects.toThrow(CLOSING);
      expect(f.calls.begin, 'no flow was begun').toBe(0);
    });

    it('before a remembered skip is written: a Home that began to close while the popup closed writes nothing', async () => {
      script.result = { kind: 'skipped' };
      const f = fixture({ rememberSkip: true, onEnd: () => (closing = true) });
      await expect(createProviderSetupCoordinator(f.deps).run('automatic')).rejects.toThrow(
        CLOSING,
      );
      expect(existsSync(globalConfigPath(home)), 'the skip was not written').toBe(false);
    });

    it('before a remembered skip is looked at when a config exists: the Home’s word is the refusal, not "not saved"', async () => {
      mkdirSync(join(home, '.relavium'));
      writeFileSync(globalConfigPath(home), '# hand made\n[preferences]\ntheme = "dark"\n');
      script.result = { kind: 'skipped' };
      const f = fixture({ rememberSkip: true, onEnd: () => (closing = true) });
      await expect(createProviderSetupCoordinator(f.deps).run('automatic')).rejects.toThrow(
        CLOSING,
      );
      expect(readFileSync(globalConfigPath(home), 'utf8')).toBe(
        '# hand made\n[preferences]\ntheme = "dark"\n',
      );
    });
  });

  describe('the list of providers', () => {
    it('a row answered after the flow was stopped starts nothing and is no outcome of its own', async () => {
      // The person's answer arrives, and the flow had been stopped by then (the Home leaving).
      const f = fixture({ answers: ['anthropic'], onAsked: () => f.cancel() });
      expect(await createProviderSetupCoordinator(f.deps).run('explicit')).toEqual({
        status: 'cancelled',
        changed: false,
      });
      expect(script.native, 'no key setup was started for a stopped flow').toBeUndefined();
    });
  });

  describe('the action on a provider whose key already works', () => {
    const USABLE = { RELAVIUM_OPENAI_API_KEY: 'never-display-this' };

    it('`Done` leaves the setup and starts no key setup', async () => {
      const f = fixture({ answers: ['openai', 'cancel'], env: USABLE });
      expect(await createProviderSetupCoordinator(f.deps).run('explicit')).toEqual({
        status: 'cancelled',
        changed: false,
      });
      expect(script.native, 'no key setup was started').toBeUndefined();
    });

    it('`Enter a different key` runs the key setup for that provider', async () => {
      const f = fixture({ answers: ['openai', 'manual'], env: USABLE });
      expect(await createProviderSetupCoordinator(f.deps).run('explicit')).toEqual({
        status: 'incomplete',
        changed: true,
      });
      expect(script.native, 'the key setup was started').toBeDefined();
    });

    it('`Enter a different key` answered after the flow was stopped starts nothing', async () => {
      // The person's answer arrives, and the flow had been stopped by then (the Home leaving).
      const f = fixture({
        answers: ['openai', 'manual'],
        env: USABLE,
        onAsked: (message) => {
          if (message === 'Provider action') f.cancel();
        },
      });
      await createProviderSetupCoordinator(f.deps).run('explicit');
      expect(script.native, 'no key setup was started for a stopped flow').toBeUndefined();
    });

    it('on a card `Esc` leaves the action (the card has no step back)', async () => {
      const f = fixture({ answers: ['openai', 'cancel'], env: USABLE });
      await createProviderSetupCoordinator(f.deps).run('explicit');
      expect(f.selects.find((asked) => asked.message === 'Provider action')?.escape).toBe('cancel');
    });
  });

  describe('a way out of the environment-key consent declines the source for the process', () => {
    const ENV = { OPENAI_API_KEY: 'never-display-this' };

    it('on the first run a step back from the consent (its skip) declines it, so it is not offered again this process', async () => {
      const f = fixture({ answers: [NATIVE_PROMPT_BACK], env: ENV });
      const outcome = await createProviderSetupCoordinator(f.deps).run('automatic');
      expect(outcome.status).toBe('cancelled');
      expect(f.policy.isDeferred('openai')).toBe(true);
    });

    it('on /providers a step back from the consent returns to the list and declines nothing', async () => {
      const f = fixture({
        answers: ['openai', NATIVE_PROMPT_BACK, NATIVE_PROMPT_CANCEL],
        env: ENV,
      });
      await createProviderSetupCoordinator(f.deps).run('explicit');
      expect(f.policy.isDeferred('openai')).toBe(false);
      expect(f.selects.map((asked) => asked.message)).toEqual([
        'Providers',
        expect.stringContaining('OPENAI_API_KEY') as string,
        'Providers',
      ]);
    });

    it('`Not now` on the first run declines it and says the popup opens again; on /providers it says nothing', async () => {
      const first = fixture({ answers: ['defer'], env: ENV });
      expect(await createProviderSetupCoordinator(first.deps).run('automatic')).toEqual({
        status: 'deferred',
        changed: false,
        notice: setupClosedNotice('home'),
      });
      expect(first.policy.isDeferred('openai')).toBe(true);
      const explicit = fixture({ answers: ['openai', 'defer'], env: ENV });
      expect(await createProviderSetupCoordinator(explicit.deps).run('explicit')).toEqual({
        status: 'deferred',
        changed: false,
      });
    });
  });

  describe('what a granted environment key says about the starter default (the notice, and the Done step’s headline)', () => {
    const ENV = { OPENAI_API_KEY: 'never-display-this' };
    const SAVED = 'Source consent saved.';
    const grant = async (writeDefaultModel: () => unknown, popup = false) => {
      const f = fixture({ answers: ['use'], env: ENV, writeDefaultModel, popup });
      const outcome = await createProviderSetupCoordinator(f.deps).run('automatic');
      return { outcome, selects: f.selects };
    };

    it.each([
      [
        'saved',
        { kind: 'saved', durability: 'confirmed' },
        `${SAVED} Starter default saved. Project settings may override it.`,
      ],
      [
        'saved, durability unconfirmed',
        { kind: 'saved', durability: 'unconfirmed' },
        `${SAVED} Starter default saved; crash persistence is unconfirmed. Project settings may override it.`,
      ],
      [
        'selected for this invocation only',
        { kind: 'ephemeral' },
        `${SAVED} Starter model selected for this invocation only.`,
      ],
      ['cancelled', { kind: 'cancelled' }, `${SAVED} Starter default was not saved.`],
      ['answered with nothing', undefined, `${SAVED} Check the starter model with /models.`],
      ['answered null', null, `${SAVED} Check the starter model with /models.`],
      [
        'answered a saved write with no durability',
        { kind: 'saved' },
        `${SAVED} Check the starter model with /models.`,
      ],
      [
        'answered a kind it does not know',
        { kind: 'surprise', durability: 'confirmed' },
        `${SAVED} Check the starter model with /models.`,
      ],
    ] as const)('a default write that %s: the one notice', async (_name, written, notice) => {
      const { outcome } = await grant(() => written);
      expect(outcome).toEqual({ status: 'ready', changed: true, notice });
    });

    it('a default write that threw a config fault: the one notice, and the key is still granted', async () => {
      const { outcome } = await grant(() => {
        throw new ConfigError('x', 'could not be written');
      });
      expect(outcome).toEqual({
        status: 'ready',
        changed: true,
        notice: `${SAVED} Starter default could not be saved; select a model with /models.`,
      });
    });

    const writes = {
      saved: () => ({ kind: 'saved', durability: 'confirmed' }),
      unconfirmed: () => ({ kind: 'saved', durability: 'unconfirmed' }),
      ephemeral: () => ({ kind: 'ephemeral' }),
      cancelled: () => ({ kind: 'cancelled' }),
      unknown: () => undefined,
      failed: () => {
        throw new ConfigError('x', 'could not be written');
      },
    } as const;
    const NAMED = 'Using OPENAI_API_KEY · OpenAI · gpt-5.4-mini';
    const BARE = 'Using OPENAI_API_KEY · OpenAI';
    it.each([
      ['saved', writes.saved, NAMED],
      ['saved, unconfirmed', writes.unconfirmed, NAMED],
      ['for this invocation only', writes.ephemeral, NAMED],
      ['not saved (cancelled)', writes.cancelled, BARE],
      ['not understood', writes.unknown, BARE],
      ['not written (a config fault)', writes.failed, BARE],
    ] as const)(
      'the Done step’s headline, for a default that is %s, names the model exactly when the model is the default',
      async (_name, write, headline) => {
        const { selects } = await grant(write, true);
        expect(selects.at(-1)?.message).toBe(headline);
      },
    );

    it('a Home that began to close after the consent was written chooses no starter default', async () => {
      const writeDefaultModel = vi.fn(() => ({ kind: 'saved', durability: 'confirmed' }));
      const f = fixture({
        answers: ['use'],
        env: ENV,
        writeDefaultModel,
        publish: (prepared, assertAdmitting) => {
          const written = prepared.publish(assertAdmitting);
          closing = true;
          return Promise.resolve(written);
        },
      });
      await expect(createProviderSetupCoordinator(f.deps).run('automatic')).rejects.toThrow(
        CLOSING,
      );
      expect(writeDefaultModel).not.toHaveBeenCalled();
    });

    it('a flow stopped inside the default write, which then refuses with the flow’s own reason, is still a grant: the host is told the default was not saved', async () => {
      const f = fixture({
        answers: ['use'],
        env: ENV,
        popup: true,
        writeDefaultModel: (admit) => {
          f.cancel();
          admit?.();
        },
      });
      expect(await createProviderSetupCoordinator(f.deps).run('automatic')).toEqual({
        status: 'ready',
        changed: true,
        notice: 'OPENAI_API_KEY allowed · the default was not saved',
      });
      expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
    });
  });

  describe('the recovery after a consent that could not be written', () => {
    const ENV = { OPENAI_API_KEY: 'never-display-this' };
    const failing: ProviderSetupDeps['publishPreference'] = () =>
      Promise.reject(new ConfigError('x', 'could not be written'));

    it('`Retry saving` writes again, and the second write is the grant', async () => {
      let attempts = 0;
      const f = fixture({
        answers: ['use', 'retry'],
        env: ENV,
        publish: (prepared, assertAdmitting) => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new ConfigError('x', 'could not be written'));
          return Promise.resolve(prepared.publish(assertAdmitting));
        },
      });
      const outcome = await createProviderSetupCoordinator(f.deps).run('automatic');
      expect(outcome.status).toBe('ready');
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
    });

    it.each([
      ['Cancel', 'cancel', true],
      ['a way out of the card', NATIVE_PROMPT_CANCEL, true],
      // A row the card does not offer is no answer: nothing is granted, and nothing is said about the source either.
      ['a row the card does not offer', 'surprise', false],
    ] as const)('%s grants nothing', async (_name, answer, declined) => {
      const f = fixture({ answers: ['use', answer], env: ENV, publish: failing });
      const outcome = await createProviderSetupCoordinator(f.deps).run('automatic');
      expect(outcome.status).toBe('cancelled');
      expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
      expect(f.policy.isDeferred('openai')).toBe(declined);
    });

    it('`Use it for this invocation only` is refused once the Home is closing: nothing is granted', async () => {
      const f = fixture({
        answers: ['use', 'once'],
        env: ENV,
        publish: failing,
        onAsked: (message) => {
          if (message === 'How would you like to continue?') closing = true;
        },
      });
      await expect(createProviderSetupCoordinator(f.deps).run('automatic')).rejects.toThrow(
        CLOSING,
      );
      expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
    });

    it('`Use it for this invocation only` grants the source for this process and says nothing was saved', async () => {
      const f = fixture({ answers: ['use', 'once'], env: ENV, publish: failing });
      const outcome = await createProviderSetupCoordinator(f.deps).run('automatic');
      expect(outcome.status).toBe('ready');
      expect(outcome.notice).toContain('Source allowed for this invocation only.');
      expect(f.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
    });
  });

  describe('the keychain step (the OS keychain is unavailable)', () => {
    const DOWN: KeychainStore = {
      get: () => {
        throw new KeychainUnavailableError('private detail');
      },
      set: () => {},
      delete: () => false,
    };

    it.each([
      ['`Not now`', 'cancel'],
      ['a way out of the card', NATIVE_PROMPT_CANCEL],
      ['a row the card does not offer', 'surprise'],
    ] as const)(
      '%s leaves it with nothing written and nothing remembered',
      async (_name, answer) => {
        const f = fixture({ answers: [answer], keychain: DOWN });
        const outcome = await createProviderSetupCoordinator(f.deps).run('automatic');
        expect(outcome).toEqual({
          status: 'cancelled',
          changed: false,
          notice: setupClosedNotice('home'),
        });
        expect(existsSync(globalConfigPath(home))).toBe(false);
      },
    );

    it('an answer that arrives after the flow was stopped is no answer: `Retry keychain` samples nothing again', async () => {
      const f = fixture({ answers: ['retry'], keychain: DOWN, onAsked: () => f.cancel() });
      expect(await createProviderSetupCoordinator(f.deps).run('automatic')).toEqual({
        status: 'cancelled',
        changed: false,
        notice: setupClosedNotice('home'),
      });
      expect(f.selects, 'the card was not asked again').toHaveLength(1);
    });

    it('`Remember this` says it was saved, or that it was saved without confirmation of its durability', async () => {
      const confirmed = fixture({ answers: ['ack'], keychain: DOWN });
      expect((await createProviderSetupCoordinator(confirmed.deps).run('automatic')).notice).toBe(
        'Keychain reminder saved.',
      );
      rmSync(globalConfigPath(home), { force: true });
      const unconfirmed = fixture({
        answers: ['ack'],
        keychain: DOWN,
        publish: (prepared, assertAdmitting) => {
          prepared.publish(assertAdmitting);
          return Promise.resolve({ durability: 'unconfirmed' });
        },
      });
      expect((await createProviderSetupCoordinator(unconfirmed.deps).run('automatic')).notice).toBe(
        'Saved, but persistence after a crash is unconfirmed.',
      );
    });

    it('a reminder that could not be written asks again; a config that is a link is no reminder and ends the step; any other fault is not swallowed', async () => {
      const asksAgain = fixture({
        answers: ['ack', 'cancel'],
        keychain: DOWN,
        publish: () => Promise.reject(new ConfigError('x', 'could not be written')),
      });
      expect(await createProviderSetupCoordinator(asksAgain.deps).run('automatic')).toEqual({
        status: 'cancelled',
        changed: false,
        notice: setupClosedNotice('home'),
      });
      expect(asksAgain.selects, 'the keychain card was asked again').toHaveLength(2);

      const link = fixture({
        answers: ['ack'],
        keychain: DOWN,
        publish: () => Promise.reject(new ConfigWriteRefusedError()),
      });
      expect(await createProviderSetupCoordinator(link.deps).run('automatic')).toEqual({
        status: 'incomplete',
        changed: false,
      });

      const defect = fixture({
        answers: ['ack'],
        keychain: DOWN,
        publish: () => Promise.reject(new Error('a defect')),
      });
      await expect(createProviderSetupCoordinator(defect.deps).run('automatic')).rejects.toThrow(
        'a defect',
      );
    });
  });

  describe('the admission the setup is handed', () => {
    it('stops the setup once its flow was stopped, and asks the Home too', async () => {
      const f = fixture({ answers: ['anthropic'] });
      await createProviderSetupCoordinator(f.deps).run('explicit');
      const native = script.native as NativeOnboarding;
      expect(() => native.assertAdmitting()).not.toThrow();
      f.cancel();
      expect(() => native.assertAdmitting(), 'the flow was stopped').toThrow();
      const g = fixture({ answers: ['anthropic'] });
      await createProviderSetupCoordinator(g.deps).run('explicit');
      const other = script.native as NativeOnboarding;
      closing = true;
      expect(() => other.assertAdmitting(), 'the Home is closing').toThrow(CLOSING);
    });

    it('a step back is NATIVE_PROMPT_BACK itself (the setup’s caller reads that symbol, never a copy)', () => {
      expect(typeof NATIVE_PROMPT_BACK).toBe('symbol');
    });
  });
});
