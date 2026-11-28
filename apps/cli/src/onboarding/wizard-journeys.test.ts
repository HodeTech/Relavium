/**
 * The setup's journeys on the native card (MVP-11 unit 6, A4): the assertions the deleted `@clack/prompts` path's tests made about what the
 * setup STORES, WRITES and SAYS, ported to the one setup that remains, on the REAL native prompt channel (a card: the stand-alone chat's
 * pre-chat mount draws it so; the popup's frame is `home/provider-popup.test.ts`'s). Only the key check, the keychain and the default-model
 * writer are fakes; the provider store is the real one over an in-memory database.
 */
import { Readable } from 'node:stream';

import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionWorkOwner } from '../chat/session-work-owner.js';
import {
  KNOWN_PROVIDERS,
  providerKeyEnvVar,
  type ProviderKeyValidation,
} from '../engine/providers.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import type { CliIo } from '../process/io.js';
import {
  createNativePromptChannel,
  type NativePromptSnapshot,
} from '../render/tui/native-prompt-channel.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import {
  KeychainUnavailableError,
  keychainAccount,
  type KeychainStore,
} from '../secrets/keychain.js';
import {
  runNativeSetup,
  SAVE_ANYWAY_HINT,
  SAVE_ANYWAY_LABEL,
  type NativeSetupResult,
} from './wizard.js';

const io: CliIo = {
  env: {},
  stdoutIsTty: true,
  stdinIsTty: true,
  stdin: Readable.from([]),
  writeOut: () => {},
  writeErr: () => {},
  writeOutAcknowledged: async () => {},
  writeErrAcknowledged: async () => {},
};
const KEY = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const OK: ProviderKeyValidation = { ok: true, reason: 'ok', detail: 'ok' };
const AUTH: ProviderKeyValidation = { ok: false, reason: 'auth', detail: 'x' };

/** An in-memory keychain; `throwOnSet` makes `set` raise `KeychainUnavailableError` (a locked keychain). */
function memKeychain(throwOnSet = false): KeychainStore & { readonly stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    stored,
    get: (account) => stored.get(account) ?? null,
    set: (account, secret) => {
      if (throwOnSet) throw new KeychainUnavailableError('keychain is locked');
      stored.set(account, secret);
    },
    delete: (account) => stored.delete(account),
  };
}

/** One step of a scripted journey: answer the open select by value, paste a key into the open key prompt, or press `Esc`. */
type Step = { readonly select: string } | { readonly key: string } | { readonly esc: true };

let client: DbClient;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  client.sqlite.close();
});
const store = (): ReturnType<typeof createProviderStore> =>
  createProviderStore(client.db, { uuid: () => 'id-fixed', now: () => 1 });

interface Journey {
  readonly result: NativeSetupResult;
  /** Every snapshot the card published, as text: what any frame showed. */
  readonly frames: string;
  /** The retry selects the card opened, in order (after the provider list). */
  readonly selects: readonly NativePromptSnapshot[];
  readonly lastNote: string;
}

async function journey(options: {
  readonly steps: readonly Step[];
  readonly validate?: (id: ProviderId, key: string) => Promise<ProviderKeyValidation>;
  readonly keychain?: KeychainStore;
  readonly providerStore?: ReturnType<typeof createProviderStore>;
  readonly writeDefaultModel?: ReturnType<typeof vi.fn>;
  readonly initialProvider?: ProviderId;
}): Promise<Journey> {
  // An injected clock and a host that acknowledges every frame it is given, as the card's host does (`native-prompt-host.tsx`): a GUARDED
  // row (`Retry the check`, SE-L3) answers only on a frame that was shown, after its lockout.
  let clock = 10_000;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility((expected) => channel.ui.getSnapshot() === expected);
  const signal = channel.flow.begin();
  const published: NativePromptSnapshot[] = [];
  channel.ui.subscribe(() => {
    const frame = channel.ui.getSnapshot();
    published.push(frame);
    queueMicrotask(() => {
      if (channel.ui.getSnapshot() === frame) channel.ui.shown(frame);
    });
  });
  const running = runNativeSetup(
    {
      ...(options.initialProvider === undefined
        ? {}
        : { initialProvider: options.initialProvider }),
      io,
      store: options.providerStore ?? store(),
      keychain: options.keychain ?? memKeychain(),
      resolver: { resolveProvider: () => undefined, keyFor: () => '' },
      validate: options.validate ?? (() => Promise.resolve(OK)),
      writeDefaultModel: options.writeDefaultModel ?? vi.fn(),
    },
    {
      flow: channel.flow,
      signal,
      assertAdmitting: () => signal.throwIfAborted(),
      endpointContext: () => 'Official endpoint',
    },
  );
  let settled = false;
  void running.then(
    () => (settled = true),
    () => (settled = true),
  );
  const until = async (predicate: (s: NativePromptSnapshot) => boolean): Promise<void> => {
    for (let turn = 0; turn < 400; turn += 1) {
      if (predicate(channel.ui.getSnapshot())) return;
      if (settled)
        throw new Error(`the setup ended before ${JSON.stringify(channel.ui.getSnapshot())}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(
      `the card never reached the expected state: ${JSON.stringify(channel.ui.getSnapshot())}`,
    );
  };
  const selects: NativePromptSnapshot[] = [];
  for (const step of options.steps) {
    if ('esc' in step) {
      await until((s) => s.kind === 'select' || s.kind === 'password');
      channel.ui.input('', { ...KEY, escape: true });
    } else if ('key' in step) {
      await until((s) => s.kind === 'password' && s.display === '');
      channel.ui.paste(step.key);
      channel.ui.input('\r', { ...KEY, return: true });
    } else {
      await until((s) => s.kind === 'select' && s.options.some((o) => o.value === step.select));
      const open = channel.ui.getSnapshot();
      if (open.message !== 'Which provider?') selects.push(open);
      const at = open.options.findIndex((o) => o.value === step.select);
      while (channel.ui.getSnapshot().selected !== at)
        channel.ui.input('', {
          ...KEY,
          downArrow: channel.ui.getSnapshot().selected < at,
          upArrow: channel.ui.getSnapshot().selected > at,
        });
      // A guarded row is answered by ONE deliberate `Enter` after its lockout (the moved highlight's frame acknowledged first).
      if (open.options[at]?.guarded === true) {
        await Promise.resolve();
        clock += APPROVAL_LOCKOUT_MS + 100;
      }
      channel.ui.input('\r', { ...KEY, return: true });
    }
  }
  const result = await running;
  const lastNote = channel.ui.getSnapshot().note;
  await channel.flow.end();
  return { result, frames: JSON.stringify(published), selects, lastNote };
}

describe('what the setup stores (ported from the deleted clack path’s tests)', () => {
  it.each(['anthropic', 'openai'] as const)(
    '%s: stores the TRIMMED key under the provider’s account, registers its row and keychain ref, and sets THAT provider’s starter model; no frame carries the key',
    async (provider) => {
      const keychain = memKeychain();
      const s = store();
      const writeDefaultModel = vi.fn(() => ({ kind: 'saved', durability: 'confirmed' }));
      const { result, frames } = await journey({
        steps: [{ select: provider }, { key: '  sk-native-supersecret-1234  ' }],
        keychain,
        providerStore: s,
        writeDefaultModel,
      });
      expect(result).toEqual({ kind: 'finished', stored: true });
      expect(keychain.stored.get(keychainAccount(provider))).toBe('sk-native-supersecret-1234');
      expect(s.get(provider)?.apiKeyKeychainRef).toBe(keychainAccount(provider));
      expect(writeDefaultModel).toHaveBeenCalledWith(
        KNOWN_PROVIDERS[provider].starterModel,
        provider,
        expect.any(Function),
      );
      expect(frames).toContain(KNOWN_PROVIDERS[provider].starterModel);
      // The card shows no part of the key, not even its last four (the clack path showed `••••1234`).
      expect(frames).not.toContain('supersecret');
      expect(frames).not.toContain('1234');
    },
  );

  it('Esc on the card’s provider list is a skip: no key is asked for, nothing is stored, no default is written', async () => {
    const keychain = memKeychain();
    const writeDefaultModel = vi.fn();
    const { result, frames } = await journey({
      steps: [{ esc: true }],
      keychain,
      writeDefaultModel,
    });
    expect(result).toEqual({ kind: 'skipped' });
    expect(frames).not.toContain('"kind":"password"');
    expect(keychain.stored.size).toBe(0);
    expect(writeDefaultModel).not.toHaveBeenCalled();
  });

  it('leaving the card’s key prompt stores nothing and registers no row', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { result } = await journey({
      steps: [{ select: 'openai' }, { esc: true }],
      keychain,
      providerStore: s,
      writeDefaultModel,
    });
    expect(result).toEqual({ kind: 'skipped' });
    expect(keychain.stored.size).toBe(0);
    expect(s.get('openai')).toBeUndefined();
    expect(writeDefaultModel).not.toHaveBeenCalled();
  });

  it('a keychain write that fails names the variable, stores nothing (no row, no default), never echoes the key, and ends cleanly', async () => {
    const keychain = memKeychain(true);
    const s = store();
    const writeDefaultModel = vi.fn();
    const { result, frames, lastNote } = await journey({
      steps: [{ select: 'gemini' }, { key: 'sk-gem-secret-9999' }],
      keychain,
      providerStore: s,
      writeDefaultModel,
    });
    expect(result).toEqual({ kind: 'finished', stored: false });
    expect(keychain.stored.size).toBe(0);
    expect(s.get('gemini')).toBeUndefined();
    expect(writeDefaultModel).not.toHaveBeenCalled();
    expect(lastNote).toContain(providerKeyEnvVar('gemini'));
    expect(lastNote.toLowerCase()).toContain('keychain');
    expect(frames).not.toContain('sk-gem-secret');
    expect(frames).not.toContain('9999');
  });

  it('a store fault AFTER the keychain write is the generic failure: never labelled a keychain failure, its message never shown, the key stays stored, no default', async () => {
    const keychain = memKeychain();
    const real = store();
    const writeDefaultModel = vi.fn();
    const { result, frames, lastNote } = await journey({
      steps: [{ select: 'deepseek' }, { key: 'sk-ds-1234' }],
      keychain,
      providerStore: {
        ...real,
        setKeychainRef: () => {
          throw new Error('db write failed: sensitive-context-xyz');
        },
      },
      writeDefaultModel,
    });
    expect(result).toEqual({ kind: 'finished', stored: false });
    expect(lastNote).toContain('Setup failed');
    expect(frames).not.toContain('Keychain unavailable');
    expect(frames).not.toContain('db write failed');
    expect(frames).not.toContain('sk-ds-1234');
    expect(keychain.stored.get(keychainAccount('deepseek'))).toBe('sk-ds-1234');
    expect(writeDefaultModel).not.toHaveBeenCalled();
  });
});

describe('the check and the choices after it failed (ported)', () => {
  /** A check that answers from a queue, recording every key it was given. */
  const queued = (results: ProviderKeyValidation[]) => {
    const checked: string[] = [];
    return {
      checked,
      validate: (_id: ProviderId, key: string): Promise<ProviderKeyValidation> => {
        checked.push(key);
        return Promise.resolve(results.shift() ?? OK);
      },
    };
  };

  it('an auth failure → Enter a different key → a good key: the SECOND key is stored and the card says Connected; no frame carries either key', async () => {
    const keychain = memKeychain();
    const check = queued([AUTH, OK]);
    const { frames, lastNote } = await journey({
      steps: [
        { select: 'openai' },
        { key: 'sk-bad-first' },
        { select: 'retry' },
        { key: 'sk-good-second' },
      ],
      keychain,
      validate: check.validate,
    });
    expect(check.checked).toEqual(['sk-bad-first', 'sk-good-second']);
    expect(keychain.stored.get(keychainAccount('openai'))).toBe('sk-good-second');
    expect(lastNote).toContain('Verified and stored');
    expect(frames).not.toContain('sk-bad-first');
    expect(frames).not.toContain('sk-good-second');
  });

  it('an auth failure → Save it anyway: the FIRST key is stored unverified (`Saved`, how to check it later); a key-shaped detail of the check never reaches a frame', async () => {
    const keychain = memKeychain();
    const { frames, lastNote, selects } = await journey({
      steps: [{ select: 'openai' }, { key: 'sk-unverified-key' }, { select: 'continue' }],
      keychain,
      validate: () =>
        Promise.resolve({ ok: false, reason: 'auth', detail: 'LEAKED-sk-unverified-key rejected' }),
    });
    expect(keychain.stored.get(keychainAccount('openai'))).toBe('sk-unverified-key');
    expect(lastNote.startsWith('Saved: ')).toBe(true);
    expect(lastNote).toContain("couldn't be verified");
    expect(lastNote).toContain('/doctor');
    // The auth branch pre-selects `Enter a different key`; the check's own text is never shown (the setup's fixed word is).
    expect(selects[0]?.options[selects[0].selected]?.value).toBe('retry');
    expect(selects[0]?.message).toContain('authentication failed');
    expect(frames).not.toContain('LEAKED');
    expect(frames).not.toContain('sk-unverified-key');
  });

  it('a network failure → an explicit Save it anyway still stores the key, but the pre-selected row is Retry the check', async () => {
    const keychain = memKeychain();
    const writeDefaultModel = vi.fn();
    const { selects } = await journey({
      steps: [{ select: 'gemini' }, { key: 'sk-offline-key' }, { select: 'continue' }],
      keychain,
      writeDefaultModel,
      validate: () => Promise.resolve({ ok: false, reason: 'network', detail: 'timeout' }),
    });
    expect(keychain.stored.get(keychainAccount('gemini'))).toBe('sk-offline-key');
    expect(writeDefaultModel).toHaveBeenCalledWith(
      KNOWN_PROVIDERS.gemini.starterModel,
      'gemini',
      expect.any(Function),
    );
    expect(selects[0]?.options[selects[0].selected]?.value).toBe('recheck');
  });

  it.each(['auth', 'other'] as const)(
    'after a %s failure: Enter a different key (pre-selected), Save it anyway (its hint says unverified and names the doctor), Skip setup; no retry of the check',
    async (reason) => {
      const { selects } = await journey({
        steps: [{ select: 'openai' }, { key: 'sk-x' }, { select: 'skip' }],
        validate: () => Promise.resolve({ ok: false, reason, detail: 'failed' }),
      });
      const open = selects[0];
      if (open === undefined) throw new Error('no choices after the failed check');
      expect(open.options.map((o) => [o.value, o.label])).toEqual([
        ['retry', 'Enter a different key'],
        ['continue', SAVE_ANYWAY_LABEL],
        ['skip', 'Skip setup'],
      ]);
      expect(SAVE_ANYWAY_LABEL).toBe('Save it anyway');
      expect(open.options[open.selected]?.value).toBe('retry');
      expect(open.options.find((o) => o.value === 'continue')?.hint).toBe(SAVE_ANYWAY_HINT);
    },
  );

  it('an `other` failure says Couldn’t verify, never that the person is offline', async () => {
    const { selects } = await journey({
      steps: [{ select: 'openai' }, { key: 'sk-x' }, { select: 'skip' }],
      validate: () =>
        Promise.resolve({ ok: false, reason: 'other', detail: 'bad_request: model retired' }),
    });
    expect(selects[0]?.message).toContain("Couldn't verify");
    expect(selects[0]?.message).not.toContain('offline');
  });

  it('Retry the check runs the SAME check with the SAME key, any number of times: nothing is asked for again, and the key that verifies is stored', async () => {
    const keychain = memKeychain();
    const check = queued([
      { ok: false, reason: 'network', detail: 'timeout' },
      { ok: false, reason: 'network', detail: 'timeout' },
      OK,
    ]);
    const { frames, selects } = await journey({
      steps: [
        { select: 'anthropic' },
        { key: 'sk-held-twice' },
        { select: 'recheck' },
        { select: 'recheck' },
      ],
      keychain,
      validate: check.validate,
    });
    expect(check.checked).toEqual(['sk-held-twice', 'sk-held-twice', 'sk-held-twice']);
    expect(frames.split('"kind":"password"').length - 1, 'the key prompt').toBeGreaterThan(0);
    expect(selects.map((s) => s.options[s.selected]?.value)).toEqual(['recheck', 'recheck']);
    // SE-L3: on the card too the row that re-sends the key is guarded (each deliberate `Enter` above came after its lockout).
    expect(selects.map((s) => s.options[s.selected]?.guarded)).toEqual([true, true]);
    expect(keychain.stored.get(keychainAccount('anthropic'))).toBe('sk-held-twice');
  });

  it('the key is threaded across several Enter-a-different-key turns: the third key is the one stored', async () => {
    const keychain = memKeychain();
    await journey({
      steps: [
        { select: 'openai' },
        { key: 'sk-bad1' },
        { select: 'retry' },
        { key: 'sk-bad2' },
        { select: 'retry' },
        { key: 'sk-good3' },
      ],
      keychain,
      validate: queued([AUTH, AUTH, OK]).validate,
    });
    expect(keychain.stored.get(keychainAccount('openai'))).toBe('sk-good3');
  });

  it('an auth failure → Enter a different key → leaving the re-prompt stores nothing and writes no default', async () => {
    const keychain = memKeychain();
    const writeDefaultModel = vi.fn();
    const { result } = await journey({
      steps: [{ select: 'openai' }, { key: 'sk-bad' }, { select: 'retry' }, { esc: true }],
      keychain,
      writeDefaultModel,
      validate: queued([AUTH]).validate,
    });
    expect(result).toEqual({ kind: 'skipped' });
    expect(keychain.stored.size).toBe(0);
    expect(writeDefaultModel).not.toHaveBeenCalled();
  });

  it('Skip setup stores nothing and writes no default', async () => {
    const keychain = memKeychain();
    const writeDefaultModel = vi.fn();
    const { result } = await journey({
      steps: [{ select: 'openai' }, { key: 'sk-bad' }, { select: 'skip' }],
      keychain,
      writeDefaultModel,
      validate: queued([AUTH]).validate,
    });
    expect(result).toEqual({ kind: 'skipped' });
    expect(keychain.stored.size).toBe(0);
    expect(writeDefaultModel).not.toHaveBeenCalled();
  });

  it('a check that rejects ends the setup as the fixed `Provider setup failed.`: nothing of its cause, nothing stored', async () => {
    const keychain = memKeychain();
    await expect(
      journey({
        steps: [{ select: 'openai' }, { key: 'sk-x' }],
        keychain,
        validate: () => Promise.reject(new Error('probe boom sk-x')),
      }),
    ).rejects.toThrow(/^Provider setup failed\.$/u);
    expect(keychain.stored.size).toBe(0);
  });
});

describe('the setup admits every write against its own flow (M1)', () => {
  it('a flow cancelled inside the keychain write registers no provider row, even where the host’s own admission does not read the flow', async () => {
    const channel = createNativePromptChannel();
    const signal = channel.flow.begin();
    const s = store();
    const stored: string[] = [];
    const running = runNativeSetup(
      {
        initialProvider: 'openai',
        io,
        store: s,
        keychain: {
          get: () => null,
          set: (_account, value) => {
            stored.push(value);
            channel.flow.cancel(); // the person leaves while the key is being written
          },
          delete: () => false,
        },
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        validate: () => Promise.resolve(OK),
        writeDefaultModel: vi.fn(),
      },
      {
        flow: channel.flow,
        signal,
        // A host whose own admission says nothing of the flow: the setup's admission must read the flow's signal itself.
        assertAdmitting: () => undefined,
        endpointContext: () => 'Official endpoint',
      },
    );
    channel.ui.paste('credential-6203');
    channel.ui.input('\r', { ...KEY, return: true });
    const result = await running;
    await channel.flow.end();
    expect(stored, 'the keychain write had happened').toEqual(['credential-6203']);
    expect(result).toEqual({ kind: 'finished', stored: true });
    expect(s.get('openai'), 'no row was registered after the cancel').toBeUndefined();
  });
});

describe('a stop of the work owner (ported)', () => {
  it.each(['select', 'password', 'validation'] as const)(
    'a stop during the %s prevents the next prompt, the key write and the config write',
    async (point) => {
      const f = invocationFixture();
      const owner = new SessionWorkOwner(f.invocation, 'home', {
        cancel: () => undefined,
        cleanup: () => Promise.resolve(),
      });
      const keychain = memKeychain();
      const writeDefaultModel = vi.fn();
      const channel = createNativePromptChannel();
      const signal = channel.flow.begin();
      const validate = vi.fn(() => {
        if (point === 'validation') owner.stop();
        return Promise.resolve(OK);
      });
      const running = runNativeSetup(
        {
          workOwner: owner,
          io,
          store: store(),
          keychain,
          resolver: { resolveProvider: () => undefined, keyFor: () => '' },
          validate,
          writeDefaultModel,
        },
        {
          flow: channel.flow,
          signal,
          assertAdmitting: () => signal.throwIfAborted(),
          endpointContext: () => 'Official endpoint',
        },
      );
      // Observed from the start: the setup may fail while the script below still waits for a prompt that never opens.
      const failure = running.then(
        () => undefined,
        (cause: unknown) => cause,
      );
      const next = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
      for (let turn = 0; turn < 50 && channel.ui.getSnapshot().kind !== 'select'; turn += 1)
        await next();
      if (point === 'select') owner.stop();
      channel.ui.input('\r', { ...KEY, return: true });
      for (let turn = 0; turn < 50 && channel.ui.getSnapshot().kind !== 'password'; turn += 1)
        await next();
      if (point === 'password') owner.stop();
      channel.ui.paste('synthetic-wizard-key');
      channel.ui.input('\r', { ...KEY, return: true });
      const caught = await failure;
      expect(caught instanceof Error ? caught.message : caught).toBe('Provider setup failed.');
      await channel.flow.end();
      await owner.close();
      expect(keychain.stored.size, 'ONBOARDING_STOP_PREVENTS_CREDENTIAL_WRITE').toBe(0);
      expect(writeDefaultModel).not.toHaveBeenCalled();
      if (point !== 'validation') expect(validate).not.toHaveBeenCalled();
      expect(f.registry.activeOwners).toBe(0);
    },
  );
});
