/**
 * What the setup says on its Done step, and what it reports when it is stopped (MVP-11 unit 6, round 1: test gaps of the W family that survived a
 * mutation sweep of the rewritten `wizard.ts`). The setup is the real `runNativeSetup` on the real native channel, with the popup's steps replaced
 * by a recorder of the Done step (`stages.done`), so what the popup would draw is read as data: its sentence, its lines, its tone.
 *
 * - the Done step names the starter model exactly when the starter model is the default, and says what the default came to in its own words;
 * - a key that was stored is reported as stored whatever happened to the default, and a flow stopped after the key was stored says so once, as the
 *   host's line, without a Done step; a stop that is not the flow's own is a failure;
 * - a store fault that is not the keychain's is the generic failure (a failed Done step with the way back in), the keychain's is its own;
 * - a check that found no adapter to probe counts as made, and a network failure says it in the fixed words.
 */
import { Readable } from 'node:stream';

import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../config/errors.js';
import { KNOWN_PROVIDERS, type ProviderKeyValidation } from '../engine/providers.js';
import type { FramedDone } from '../home/framed-flow.js';
import { CliError } from '../process/cli-error.js';
import type { CliIo } from '../process/io.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import {
  KeychainUnavailableError,
  keychainAccount,
  type KeychainStore,
} from '../secrets/keychain.js';
import { SAVED_UNCONFIRMED, SETUP_NEXT_STEP } from './setup-notes.js';
import { runNativeSetup, type NativeSetupResult, type OnboardingDeps } from './wizard.js';

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
const ENTER = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: true,
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
const DOWN = { ...ENTER, return: false, downArrow: true };
const REJECTED: ProviderKeyValidation = { ok: false, reason: 'auth', detail: 'rejected' };
const OK: ProviderKeyValidation = { ok: true, reason: 'ok', detail: 'ok' };
const PROVIDER: ProviderId = 'anthropic';
const NAME = KNOWN_PROVIDERS.anthropic.displayName;
const MODEL = KNOWN_PROVIDERS.anthropic.starterModel;
const KEY = 'sk-done-step-0000';

function memKeychain(): KeychainStore & { readonly stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    stored,
    get: (account) => stored.get(account) ?? null,
    set: (account, secret) => {
      stored.set(account, secret);
    },
    delete: (account) => stored.delete(account),
  };
}

let client: DbClient;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  client.sqlite.close();
});
const providerStore = (): ReturnType<typeof createProviderStore> =>
  createProviderStore(client.db, { uuid: () => 'id-fixed', now: () => 1 });

interface Ran {
  readonly result: NativeSetupResult;
  readonly dones: readonly FramedDone[];
  readonly flow: ReturnType<typeof createNativePromptChannel>['flow'];
  /** The prompt the check left on screen when the run ended (a failed check's choices), as text. */
  readonly screen: string;
}

/** The setup for one key, in the popup's steps (the Done step recorded); `stop` runs inside the default writer. */
async function run(options: {
  readonly deps?: Partial<OnboardingDeps>;
  readonly selectStarterDefault?: boolean;
  readonly writeDefaultModel?: (flow: Ran['flow'], admit: (() => void) | undefined) => unknown;
  /** Leave the key check to the setup's own (a resolver with no adapter to probe passes it). */
  readonly defaultCheck?: boolean;
  /** `card`: no popup steps (the stand-alone chat's card): the setup's last word is its card's note, committed to the host. */
  readonly surface?: 'popup' | 'card';
  /** A keychain or provider store built from the run's own flow and signal (a stop inside the keychain's or the store's write). */
  readonly around?: (context: {
    readonly flow: Ran['flow'];
    readonly signal: AbortSignal;
  }) => Partial<OnboardingDeps>;
  /** Stop the flow while the key's check is pending (a check that never answers). */
  readonly cancelDuringCheck?: boolean;
  /** The flow the setup is handed, in place of the channel's own (a card's flow that records its notes). */
  readonly wrapFlow?: (flow: Ran['flow']) => Ran['flow'];
  /** End the run as soon as the check's choices are on screen (the state is read, then the flow is stopped). */
  readonly stopAtFailedCheck?: boolean;
  /** Answer the failed check's choices with `Save it anyway` (the key is kept without a check). */
  readonly keepAnyway?: boolean;
}): Promise<Ran> {
  const channel = createNativePromptChannel();
  const signal = channel.flow.begin();
  const dones: FramedDone[] = [];
  const handed = options.wrapFlow?.(channel.flow) ?? channel.flow;
  const running = runNativeSetup(
    {
      initialProvider: PROVIDER,
      io,
      store: providerStore(),
      keychain: memKeychain(),
      resolver: { resolveProvider: () => undefined, keyFor: () => '' },
      ...(options.defaultCheck === true ? {} : { validate: () => Promise.resolve(OK) }),
      writeDefaultModel: (_model, _provider, admit) =>
        options.writeDefaultModel === undefined
          ? undefined
          : options.writeDefaultModel(channel.flow, admit),
      ...options.deps,
      ...options.around?.({ flow: channel.flow, signal }),
    },
    {
      flow: handed,
      signal,
      assertAdmitting: () => signal.throwIfAborted(),
      endpointContext: () => 'Official endpoint',
      ...(options.selectStarterDefault === undefined
        ? {}
        : { selectStarterDefault: options.selectStarterDefault }),
      ...(options.surface === 'card'
        ? {}
        : {
            stages: {
              provider: channel.flow,
              key: channel.flow,
              done: (done: FramedDone) => {
                dones.push(done);
                return Promise.resolve();
              },
            },
          }),
    },
  );
  let ended = false;
  void running.then(
    () => (ended = true),
    () => (ended = true),
  );
  const until = async (holds: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 400 && !ended && !holds(); turn += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await until(() => channel.ui.getSnapshot().kind === 'password');
  channel.ui.paste(KEY);
  channel.ui.input('\r', ENTER);
  let screen = '';
  if (options.cancelDuringCheck === true) {
    await until(() => channel.ui.getSnapshot().kind === 'busy');
    channel.flow.cancel();
  }
  if (options.keepAnyway === true) {
    await until(() => channel.ui.getSnapshot().kind === 'select');
    const target = channel.ui
      .getSnapshot()
      .options.findIndex((option) => option.value === 'continue');
    if (target < 0) throw new Error('the failed check offered no `Save it anyway`');
    for (let moves = 0; moves < target; moves += 1) channel.ui.input('', DOWN);
    channel.ui.input('\r', ENTER);
  }
  if (options.stopAtFailedCheck === true) {
    await until(() => channel.ui.getSnapshot().kind === 'select');
    screen = JSON.stringify(channel.ui.getSnapshot());
    channel.flow.cancel();
  }
  try {
    const result = await running;
    return { result, dones, flow: channel.flow, screen };
  } finally {
    await channel.flow.end();
  }
}

describe('the Done step names the model exactly when the model is the default', () => {
  it.each([
    [
      'saved',
      { kind: 'saved', durability: 'confirmed' },
      `Connected · ${NAME} · ${MODEL}`,
      [SETUP_NEXT_STEP],
    ],
    [
      'saved, durability unconfirmed',
      { kind: 'saved', durability: 'unconfirmed' },
      `Connected · ${NAME} · ${MODEL}`,
      [SAVED_UNCONFIRMED, SETUP_NEXT_STEP],
    ],
    [
      'selected for this invocation only',
      { kind: 'ephemeral' },
      `Connected · ${NAME} · ${MODEL}`,
      [`${MODEL} is selected for this invocation only; the default was not saved.`],
    ],
    [
      'cancelled',
      { kind: 'cancelled' },
      `Connected · ${NAME}`,
      ['The default was not saved. Choose a model with /models.'],
    ],
    [
      'answered null',
      null,
      `Connected · ${NAME}`,
      ['The default was not saved. Choose a model with /models.'],
    ],
    [
      'answered with nothing',
      undefined,
      `Connected · ${NAME}`,
      ['The default was not saved. Choose a model with /models.'],
    ],
    [
      'answered a saved write with no durability',
      { kind: 'saved' },
      `Connected · ${NAME}`,
      ['The default was not saved. Choose a model with /models.'],
    ],
    [
      'answered a kind it does not know',
      { kind: 'surprise', durability: 'confirmed' },
      `Connected · ${NAME}`,
      ['The default was not saved. Choose a model with /models.'],
    ],
    [
      'answered something that is not even a record',
      'saved',
      `Connected · ${NAME}`,
      ['The default was not saved. Choose a model with /models.'],
    ],
  ] as const)('a default that was %s', async (_name, written, message, lines) => {
    const { result, dones } = await run({ writeDefaultModel: () => written });
    expect(result).toEqual({ kind: 'finished', stored: true });
    expect(dones).toEqual([{ message, lines }]);
  });

  it('a default write that threw a config fault: the key is stored, the Done step points at /models and names no model', async () => {
    const { result, dones } = await run({
      writeDefaultModel: () => {
        throw new ConfigError('x', 'could not be written');
      },
    });
    expect(result).toEqual({ kind: 'finished', stored: true });
    expect(dones).toHaveLength(1);
    expect(dones[0]?.message).toBe(`Connected · ${NAME}`);
    expect(dones[0]?.lines).toEqual([
      `The default was not saved. Pick an ${NAME} model with /models.`,
    ]);
  });

  it('key maintenance (the host says a source already worked) leaves the model preference alone and writes no default', async () => {
    const written = vi.fn();
    const { result, dones } = await run({
      selectStarterDefault: false,
      writeDefaultModel: written,
    });
    expect(written).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'finished', stored: true });
    expect(dones).toEqual([
      {
        message: `Connected · ${NAME}`,
        lines: ['Your model preference is unchanged. Choose a model with /models.'],
      },
    ]);
  });
});

describe('a flow stopped around the default', () => {
  const interrupted = `${NAME} key stored · the default was not saved`;

  it('stopped inside the default write that then answers: the key is stored, and the host is told once, with no Done step', async () => {
    const { result, dones } = await run({
      writeDefaultModel: (flow) => {
        flow.cancel();
        return { kind: 'saved', durability: 'confirmed' };
      },
    });
    expect(result).toEqual({ kind: 'finished', stored: true, notice: interrupted });
    expect(dones).toEqual([]);
  });

  it('stopped inside the default write that then throws the flow’s own reason (its admission check): the same report', async () => {
    const { result, dones } = await run({
      writeDefaultModel: (flow, admit) => {
        flow.cancel();
        admit?.();
        return undefined;
      },
    });
    expect(result).toEqual({ kind: 'finished', stored: true, notice: interrupted });
    expect(dones).toEqual([]);
  });

  it('stopped inside the default write that then throws something else: the setup fails, and says so in its fixed words', async () => {
    await expect(
      run({
        writeDefaultModel: (flow) => {
          flow.cancel();
          throw new Error('disk exploded: private-detail');
        },
      }),
    ).rejects.toThrow('Provider setup failed.');
  });
});

describe('what a store fault says', () => {
  it('a fault of another kind (a CliError that is not the keychain’s) is the generic failure, with the way back in', async () => {
    const real = providerStore();
    const { result, dones } = await run({
      deps: {
        store: {
          ...real,
          setKeychainRef: () => {
            throw new CliError('invalid_invocation', 'the database refused it');
          },
        },
      },
    });
    expect(result).toEqual({ kind: 'finished', stored: false });
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ message: 'Setup could not be completed', tone: 'failed' });
    expect(JSON.stringify(dones)).not.toContain('keychain');
    expect(JSON.stringify(dones)).not.toContain('the database refused it');
  });

  it('the keychain’s own refusal names the variable and says the key was not saved', async () => {
    const keychain: KeychainStore = {
      get: () => null,
      set: () => {
        throw new KeychainUnavailableError('locked');
      },
      delete: () => false,
    };
    const { result, dones } = await run({ deps: { keychain } });
    expect(result).toEqual({ kind: 'finished', stored: false });
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ message: 'The key was not saved', tone: 'failed' });
    expect(dones[0]?.lines?.join(' ')).toContain('ANTHROPIC_API_KEY');
  });
});

describe('the check', () => {
  it('a resolver with no adapter to probe counts the key as checked: it is stored and the Done step says Connected', async () => {
    const keychain = memKeychain();
    const { result, dones } = await run({
      deps: { keychain },
      defaultCheck: true,
      writeDefaultModel: () => ({ kind: 'saved', durability: 'confirmed' }),
    });
    expect(result).toEqual({ kind: 'finished', stored: true });
    expect(keychain.stored.get(keychainAccount(PROVIDER))).toBe(KEY);
    expect(dones[0]?.message).toBe(`Connected · ${NAME} · ${MODEL}`);
  });

  it('a network failure says so in the fixed words, never in the provider’s own', async () => {
    const { screen } = await run({
      deps: {
        validate: () =>
          Promise.resolve({ ok: false, reason: 'network', detail: 'ECONNRESET sk-leak' }),
      },
      stopAtFailedCheck: true,
    });
    expect(screen).toContain('network unavailable');
    expect(screen).not.toContain('ECONNRESET');
    expect(screen).not.toContain('sk-leak');
  });

  it.each([
    ['auth', 'authentication failed'],
    ['other', 'verification failed'],
  ] as const)('a %s failure says %s', async (reason, words) => {
    const { screen } = await run({
      deps: { validate: () => Promise.resolve({ ok: false, reason, detail: 'x' }) },
      stopAtFailedCheck: true,
    });
    expect(screen).toContain(words);
  });
});

describe('a flow stopped around the key itself', () => {
  const interrupted = `${NAME} key stored · setup was interrupted`;

  it('stopped inside the keychain write that then refuses with the flow’s own reason: nothing was stored, and the setup is left', async () => {
    const { result, dones } = await run({
      around: ({ flow, signal }) => ({
        keychain: {
          get: () => null,
          set: () => {
            flow.cancel();
            throw signal.reason;
          },
          delete: () => false,
        },
      }),
    });
    expect(result).toEqual({ kind: 'cancelled' });
    expect(dones).toEqual([]);
  });

  it('stopped after the key reached the keychain, inside the store’s write that refuses with the flow’s own reason: the key is stored, and the host is told once', async () => {
    const real = providerStore();
    const { result, dones } = await run({
      around: ({ flow, signal }) => ({
        store: {
          ...real,
          setKeychainRef: () => {
            flow.cancel();
            throw signal.reason;
          },
        },
      }),
    });
    expect(result).toEqual({ kind: 'finished', stored: true, notice: interrupted });
    expect(dones).toEqual([]);
  });

  it('stopped inside the keychain write that then returns: the key is stored, and the host is told once', async () => {
    const stored = new Map<string, string>();
    const { result, dones } = await run({
      around: ({ flow }) => ({
        keychain: {
          get: (account) => stored.get(account) ?? null,
          set: (account, secret) => {
            stored.set(account, secret);
            flow.cancel();
          },
          delete: () => false,
        },
      }),
    });
    expect(result).toEqual({ kind: 'finished', stored: true, notice: interrupted });
    expect(dones).toEqual([]);
  });

  it('stopped inside the store’s last write, which then returns: the key is stored, and the host is told once', async () => {
    const real = providerStore();
    const { result, dones } = await run({
      around: ({ flow }) => ({
        store: {
          ...real,
          setKeychainRef: (name, ref) => {
            real.setKeychainRef(name, ref);
            flow.cancel();
          },
        },
      }),
    });
    expect(result).toEqual({ kind: 'finished', stored: true, notice: interrupted });
    expect(dones).toEqual([]);
  });

  it('stopped while the key is being checked: the check is abandoned, nothing is stored, and the setup is left at once', async () => {
    const keychain = memKeychain();
    const { result, dones } = await run({
      deps: { keychain, validate: () => new Promise<ProviderKeyValidation>(() => undefined) },
      cancelDuringCheck: true,
    });
    expect(result).toEqual({ kind: 'cancelled' });
    expect(keychain.stored.size).toBe(0);
    expect(dones).toEqual([]);
  });

  it('stopped inside a write that refuses with something that is not the flow’s reason: the setup fails in its fixed words', async () => {
    await expect(
      run({
        around: ({ flow }) => ({
          keychain: {
            get: () => null,
            set: () => {
              flow.cancel();
              throw new Error('disk exploded: private-detail');
            },
            delete: () => false,
          },
        }),
      }),
    ).rejects.toThrow('Provider setup failed.');
  });
});

describe('on a card (no popup steps) the setup’s last word is its note, committed to the host', () => {
  /** The card's flow, recording what was committed and what was only noted. */
  const recording = () => {
    const committed: string[] = [];
    const noted: string[] = [];
    const wrapFlow = (flow: Ran['flow']): Ran['flow'] => ({
      ...flow,
      committedNote: (message, title) => {
        committed.push(`${title ?? ''}|${message}`);
        flow.note(message, title);
      },
      note: (message, title) => {
        noted.push(`${title ?? ''}|${message}`);
        flow.note(message, title);
      },
    });
    return { committed, noted, wrapFlow };
  };

  it('a stored key and its default: one committed note, a fact the host keeps', async () => {
    const r = recording();
    const { result, dones } = await run({
      surface: 'card',
      wrapFlow: r.wrapFlow,
      writeDefaultModel: () => ({ kind: 'saved', durability: 'confirmed' }),
    });
    expect(result).toEqual({ kind: 'finished', stored: true });
    expect(dones, 'a card draws no Done step').toEqual([]);
    expect(r.committed).toHaveLength(1);
    expect(r.committed[0]).toContain('Connected|');
    expect(r.committed[0]).toContain(`Your default model is ${MODEL}.`);
  });

  it('a default that could not be written: the key is stored, and the card says where to pick a model (a note, not a committed fact)', async () => {
    const r = recording();
    const { result } = await run({
      surface: 'card',
      wrapFlow: r.wrapFlow,
      writeDefaultModel: () => {
        throw new ConfigError('x', 'could not be written');
      },
    });
    expect(result).toEqual({ kind: 'finished', stored: true });
    expect(r.noted.some((note) => note.includes(`Pick an ${NAME} model with /models.`))).toBe(true);
  });

  it.each([
    [
      'the keychain write returned',
      (flow: Ran['flow'], keychain: KeychainStore): Partial<OnboardingDeps> => ({
        keychain: {
          ...keychain,
          set: (account, secret) => {
            keychain.set(account, secret);
            flow.cancel();
          },
        },
      }),
    ],
    [
      'the store’s write then refused with the flow’s own reason',
      (
        flow: Ran['flow'],
        keychain: KeychainStore,
        signal: AbortSignal,
      ): Partial<OnboardingDeps> => ({
        keychain,
        store: {
          ...providerStore(),
          setKeychainRef: () => {
            flow.cancel();
            throw signal.reason;
          },
        },
      }),
    ],
  ])(
    'W27 a flow stopped after a key kept anyway reached the keychain (%s): the card’s last note is titled `Saved`, never `Connected` (no connection was made)',
    async (_case, depsFor) => {
      const r = recording();
      const keychain = memKeychain();
      const { result } = await run({
        surface: 'card',
        wrapFlow: r.wrapFlow,
        keepAnyway: true,
        deps: { validate: () => Promise.resolve(REJECTED) },
        around: ({ flow, signal }) => depsFor(flow, keychain, signal),
      });
      expect(result).toEqual({ kind: 'finished', stored: true });
      expect([...keychain.stored.values()], 'the key was stored').toEqual([KEY]);
      expect(r.committed).toHaveLength(1);
      expect(r.committed[0]?.startsWith('Saved|')).toBe(true);
      expect(r.committed[0]).toContain(`Your ${NAME} key was stored in the OS keychain`);
      expect(r.committed[0]).not.toContain('Connected');
    },
  );

  it('the same stop after a CHECKED key is titled `Connected` (the title follows what was verified)', async () => {
    const r = recording();
    const stored = new Map<string, string>();
    await run({
      surface: 'card',
      wrapFlow: r.wrapFlow,
      around: ({ flow }) => ({
        keychain: {
          get: (account) => stored.get(account) ?? null,
          set: (account, secret) => {
            stored.set(account, secret);
            flow.cancel();
          },
          delete: () => false,
        },
      }),
    });
    expect(r.committed).toHaveLength(1);
    expect(r.committed[0]?.startsWith('Connected|')).toBe(true);
  });
});
