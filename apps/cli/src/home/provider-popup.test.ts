/**
 * The `/providers` POPUP of the Home and its first run (MVP-11 unit 6, 6.2; ADR-0146 §6, ADR-0148 §1, §3, §6), driven on the REAL native channel
 * with an injected clock and the real provider setup coordinator, wizard and config writers (only the key check, the keychain and the store are
 * fakes): the rail and its words, `Esc` back, the skip and `Ctrl+C`, the Done step, the remembered skip, the guarded consent that a held `Enter`
 * never answers, the secret field's custody inside the frame, and the hostile text every value a provider, an endpoint or a variable wrote can
 * carry.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import type { Key } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '../config/errors.js';
import {
  globalConfigPath,
  prepareGlobalPreferences,
  type ConfigWriteResult,
  type PreparedConfigWrite,
} from '../config/write.js';
import {
  createProviderResolver,
  KNOWN_PROVIDERS,
  providerEndpointContext,
  type ProviderKeyValidation,
  type ProviderResolver,
} from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  keyCheckText,
  keyStepNote,
  SETUP_SKIP_NOT_SAVED,
  setupClosedNotice,
  setupSkippedNotice,
  UNKNOWN_KEY_HOST,
} from '../onboarding/setup-notes.js';
import {
  keyDestinationHost,
  SAVE_ANYWAY_HINT,
  scrubSetupText,
  UNVERIFIED_KEY_LINE,
} from '../onboarding/wizard.js';
import { foldLineSeparators } from '../popups/frame-model.js';
import { nativePopupLegend } from '../popups/native-popup-body.js';
import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import { nativePopupFrameLines, nativePopupGeometry } from '../popups/popup-slot.js';
import { scrubPopupText } from '../popups/popup-text.js';
import { legend } from '../render/tui/legend.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_RESIZED,
  type NativePromptSnapshot,
} from '../render/tui/native-prompt-channel.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import {
  keychainAccount,
  KeychainUnavailableError,
  type KeychainStore,
} from '../secrets/keychain.js';
import { captureIo } from '../test-support.js';
import {
  consentMessage,
  createProviderSetupCoordinator,
  FIRST_RUN_POPUP_TITLE,
  FIRST_STEP_ESCAPE_VERB,
  KEY_STEP_ENTER_VERB,
  PROVIDER_STEP_NAMES,
  PROVIDERS_POPUP_TITLE,
} from './provider-setup.js';

const NONE: Key = {
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
const ENTER: Key = { ...NONE, return: true };
const ESC: Key = { ...NONE, escape: true };
const UP: Key = { ...NONE, upArrow: true };
const DOWN: Key = { ...NONE, downArrow: true };
const SECRET = 'synthetic-popup-credential-6604';
const OK: ProviderKeyValidation = { ok: true, reason: 'ok', detail: 'ok' };
const NETWORK: ProviderKeyValidation = { ok: false, reason: 'network', detail: 'timeout' };
const baseline = '# hand-made\n[preferences]\ntheme = "dark"\n';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The keychain: in memory, or one whose backend is known to be down (its reads throw). */
function memoryKeychain(down = false): KeychainStore & { readonly stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    stored,
    get: (account) => {
      if (down) throw new KeychainUnavailableError('synthetic locked keychain');
      return stored.get(account) ?? null;
    },
    set: (account, value) => void stored.set(account, value),
    delete: (account) => stored.delete(account),
  };
}

function rig(
  options: {
    readonly env?: Record<string, string>;
    readonly config?: 'none' | 'hand-made' | 'symlink';
    readonly validate?: (
      id: string,
      key: string,
      signal?: AbortSignal,
    ) => Promise<ProviderKeyValidation>;
    /**
     * The starter default is written as the hosts write it (prepared, passed through the run's view of its own writes, published through
     * `publishPreference`), instead of the fake that writes nothing.
     */
    readonly hostStarter?: boolean;
    /** Called as publication `index` (from 0) reaches the host, before it publishes: another writer may change the file there. */
    readonly beforePublish?: (index: number, path: string) => void;
    /** With `hostStarter`: called before the host prepares the starter default (another writer may change the file there). */
    readonly beforeStarter?: (path: string) => void;
    readonly keychainDown?: boolean;
    /** A keychain of the test's own (one that recovers, say); default an in-memory one, down when `keychainDown`. */
    readonly keychain?: KeychainStore & { readonly stored: Map<string, string> };
    readonly resolver?: (resolver: ProviderResolver) => ProviderResolver;
    /** The coordinator's admission (the Home's `assertAdmitting`: it throws once the Home began closing). */
    readonly admit?: () => void;
    /** What the default-model writer returns; default a confirmed save. */
    readonly writeDefault?: () => unknown;
    /** Count every visible publication of a config write (the Home's `publishPreference`). */
    readonly published?: { count: number };
    /** Every publication reports a durability after a crash that could not be confirmed. */
    readonly unconfirmed?: boolean;
    /** The keychain reminder is already remembered in the global config. */
    readonly acknowledged?: boolean;
    /** The surface whose words the setup speaks (the Home's by default). */
    readonly surface?: 'home' | 'standalone-chat';
  } = {},
) {
  let clock = 10_000;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility((expected) => channel.ui.getSnapshot() === expected);
  const published: NativePromptSnapshot[] = [];
  channel.ui.subscribe(() => published.push(channel.ui.getSnapshot()));
  const home = mkdtempSync(join(tmpdir(), 'relavium-provider-popup-'));
  roots.push(home);
  const path = globalConfigPath(home);
  if (options.config === 'hand-made' || options.config === 'symlink') {
    // `globalConfigPath` is `<home>/.relavium/config.toml`: the directory is made by the writer, and by the fixture for a hand-made one.
    mkdirSync(join(home, '.relavium'), { recursive: true });
    if (options.config === 'hand-made') writeFileSync(path, baseline);
    else {
      writeFileSync(join(home, 'real.toml'), baseline);
      symlinkSync(join(home, 'real.toml'), path);
    }
  }
  const policy = createStandardEnvKeyPolicy();
  const keychain = options.keychain ?? memoryKeychain(options.keychainDown === true);
  const base = createProviderResolver(options.env ?? {}, keychain, { standardEnvPolicy: policy });
  const resolver = options.resolver?.(base) ?? base;
  const db = createClient(':memory:');
  runMigrations(db.db);
  const written: Array<readonly [string, string]> = [];
  /** Whether each publication reached the host needing the rewrite notice (what the host draws it by), in order. */
  const rewrites: boolean[] = [];
  const publishPreference = (
    prepared: PreparedConfigWrite,
    admit: () => void,
  ): Promise<ConfigWriteResult> => {
    if (options.published !== undefined) options.published.count += 1;
    rewrites.push(prepared.rewriteNeeded);
    options.beforePublish?.(rewrites.length - 1, path);
    const result = prepared.publish(admit);
    return Promise.resolve(options.unconfirmed === true ? { durability: 'unconfirmed' } : result);
  };
  const coordinator = createProviderSetupCoordinator({
    flow: channel.flow,
    resolver,
    policy,
    globalConfig:
      options.acknowledged === true
        ? { preferences: { keychain_unavailable_acknowledged: true } }
        : undefined,
    globalConfigPath: path,
    ...(options.surface === undefined ? {} : { credentialSurface: options.surface }),
    home,
    assertAdmitting: () => options.admit?.(),
    endpointContext: (id) => providerEndpointContext(resolver, id),
    publishPreference,
    popup: true,
    rememberSkip: true,
    wizard: {
      store: createProviderStore(db.db, { uuid: () => 'provider-id', now: () => 1 }),
      keychain,
      io: captureIo().io,
      writeDefaultModel: async (model, provider, admit, runWrite) => {
        written.push([model, provider]);
        if (options.hostStarter !== true)
          return options.writeDefault?.() ?? { kind: 'saved', durability: 'confirmed' };
        options.beforeStarter?.(path);
        const prepared = prepareGlobalPreferences(
          { defaultModel: model, defaultProvider: provider },
          home,
        );
        const saved = await publishPreference(
          runWrite === undefined ? prepared : runWrite(prepared),
          admit ?? (() => {}),
        );
        return { kind: 'saved', durability: saved.durability };
      },
      validate: options.validate ?? (() => Promise.resolve(OK)),
    },
  });
  const snapshot = (): NativePromptSnapshot => channel.ui.getSnapshot();
  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((r) => setImmediate(r));
  };
  return {
    channel,
    coordinator,
    policy,
    keychain,
    path,
    home,
    written,
    rewrites,
    published,
    snapshot,
    flush,
    advance: (ms: number): void => {
      clock += ms;
    },
    /** The frame on screen now was measured and flushed (the live host's acknowledgement). */
    show: (): void => channel.ui.shown(channel.ui.getSnapshot()),
    key: (key: Key, input = ''): boolean => channel.ui.input(input, key),
    /**
     * A deliberate `Esc` on the open prompt: its frame shown, the key a moment after it (an `Esc` that arrived before the popup's first frame
     * is a close, never a step back: ADR-0146 §6, W7 item 4).
     */
    esc: (): void => {
      channel.ui.shown(channel.ui.getSnapshot());
      clock += 1;
      channel.ui.input('', ESC);
    },
    async until(predicate: (s: NativePromptSnapshot) => boolean): Promise<void> {
      for (let turn = 0; turn < 400; turn += 1) {
        if (predicate(channel.ui.getSnapshot())) return;
        await new Promise<void>((r) => setImmediate(r));
      }
      throw new Error(`the popup never reached the expected state: ${JSON.stringify(snapshot())}`);
    },
    /** Answer the open select with `value`: shown, the opening settle passed, highlighted with the popup's arrows, `Enter`. */
    async choose(value: string): Promise<void> {
      await this.until(
        (s) => s.kind === 'select' && s.options.some((option) => option.value === value),
      );
      this.show();
      clock += POPUP_SELECT_SETTLE_MS;
      const target = snapshot().options.findIndex((option) => option.value === value);
      while (snapshot().selected !== target) {
        channel.ui.input('', snapshot().selected < target ? DOWN : UP);
        this.show();
      }
      const guarded = snapshot().options[target]?.guarded === true;
      clock += guarded ? APPROVAL_LOCKOUT_MS + 100 : 10;
      channel.ui.input('\r', ENTER);
      await this.flush();
    },
    async paste(secret: string): Promise<void> {
      await this.until((s) => s.kind === 'password');
      this.show();
      clock += POPUP_SELECT_SETTLE_MS;
      channel.ui.paste(secret);
    },
    async closeDone(how: 'enter' | 'esc'): Promise<void> {
      await this.until((s) => s.final !== undefined);
      this.show();
      clock += POPUP_SELECT_SETTLE_MS;
      channel.ui.input(how === 'enter' ? '\r' : '', how === 'enter' ? ENTER : ESC);
      await this.flush();
    },
    close: (): void => {
      db.sqlite.close();
    },
  };
}

describe('the frame of the setup popup', () => {
  it('the automatic first run is titled `Connect a provider` (O7), from the Home, on `Provider · Key · Done`; its first step steps back, so `Esc` (the skip) is told from `Ctrl+C` (close)', async () => {
    const r = rig();
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.message === 'Which provider?');
    expect(r.snapshot().popup).toEqual({
      title: FIRST_RUN_POPUP_TITLE,
      origin: 'home',
      stepIndex: 0,
      stepCount: 3,
      stepNames: PROVIDER_STEP_NAMES,
      exitLabel: 'close',
      // W7 item 1: the first step's `Esc` is the skip, and its legend says so.
      escapeVerb: FIRST_STEP_ESCAPE_VERB,
      depth: 1,
    });
    expect(FIRST_RUN_POPUP_TITLE).toBe('Connect a provider');
    expect(PROVIDER_STEP_NAMES).toEqual(['Provider', 'Key', 'Done']);
    expect(r.snapshot().escape, 'Esc on the first step is a step back: the skip').toBe('back');
    r.channel.flow.cancel();
    await running;
    r.close();
  });

  it('an explicit `/providers` closes with `close`, and `Esc` on a prompt reached from its list steps back to the list', async () => {
    const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-1101' } });
    const running = r.coordinator.run('explicit');
    await r.until((s) => s.message === 'Which provider?');
    expect(r.snapshot().popup?.exitLabel).toBe('close');
    expect(r.snapshot().popup?.title, 'the person typed `/providers`').toBe(PROVIDERS_POPUP_TITLE);
    await r.choose('openai');
    await r.until((s) => s.message.startsWith('OPENAI_API_KEY is set for OpenAI.'));
    expect(r.snapshot().escape).toBe('back');
    expect(r.snapshot().popup?.exitLabel).toBe('close');
    r.key(ESC);
    await r.until((s) => s.message === 'Which provider?');
    r.key(ESC);
    const outcome = await running;
    expect(outcome.status).toBe('cancelled');
    r.close();
  });
});

describe('a card host is never framed', () => {
  it('without `popup` (the stand-alone chat’s pre-chat mount, which has no popup slot) no prompt carries a descriptor, and `Esc` on the key leaves', async () => {
    const channel = createNativePromptChannel({ now: () => 10_000 });
    channel.ui.bindVisibility((expected) => channel.ui.getSnapshot() === expected);
    const published: NativePromptSnapshot[] = [];
    channel.ui.subscribe(() => published.push(channel.ui.getSnapshot()));
    const home = mkdtempSync(join(tmpdir(), 'relavium-provider-card-'));
    roots.push(home);
    const policy = createStandardEnvKeyPolicy();
    const keychain = memoryKeychain();
    const resolver = createProviderResolver({}, keychain, { standardEnvPolicy: policy });
    const db = createClient(':memory:');
    runMigrations(db.db);
    const running = createProviderSetupCoordinator({
      flow: channel.flow,
      resolver,
      policy,
      globalConfig: undefined,
      globalConfigPath: globalConfigPath(home),
      home,
      assertAdmitting: () => {},
      endpointContext: (id) => providerEndpointContext(resolver, id),
      publishPreference: (prepared, admit) => Promise.resolve(prepared.publish(admit)),
      credentialSurface: 'standalone-chat',
      wizard: {
        store: createProviderStore(db.db, { uuid: () => 'card', now: () => 1 }),
        keychain,
        io: captureIo().io,
        writeDefaultModel: () => ({ kind: 'saved', durability: 'confirmed' }),
        validate: () => Promise.resolve(OK),
      },
    }).run('automatic');
    for (let turn = 0; turn < 50 && channel.ui.getSnapshot().kind !== 'select'; turn += 1)
      await new Promise<void>((r) => setImmediate(r));
    channel.ui.input('\r', ENTER);
    for (let turn = 0; turn < 50 && channel.ui.getSnapshot().kind !== 'password'; turn += 1)
      await new Promise<void>((r) => setImmediate(r));
    expect(channel.ui.getSnapshot().escape, 'a card’s Esc leaves, as it always did').toBe('cancel');
    channel.ui.input('', ESC);
    const outcome = await running;
    expect(published.every((snapshot) => snapshot.popup === undefined)).toBe(true);
    expect(outcome.notice).toBe(setupSkippedNotice('standalone-chat'));
    expect(existsSync(globalConfigPath(home)), 'a card host remembers no skip').toBe(false);
    db.sqlite.close();
  });

  it('W7: on a card the key check’s wait does not step back: `Esc` there leaves the setup, as it always did, and the check is aborted', async () => {
    const channel = createNativePromptChannel({ now: () => 10_000 });
    channel.ui.bindVisibility((expected) => channel.ui.getSnapshot() === expected);
    const home = mkdtempSync(join(tmpdir(), 'relavium-provider-card-check-'));
    roots.push(home);
    const policy = createStandardEnvKeyPolicy();
    const keychain = memoryKeychain();
    const resolver = createProviderResolver({}, keychain, { standardEnvPolicy: policy });
    const db = createClient(':memory:');
    runMigrations(db.db);
    let checkSignal: AbortSignal | undefined;
    const running = createProviderSetupCoordinator({
      flow: channel.flow,
      resolver,
      policy,
      globalConfig: undefined,
      globalConfigPath: globalConfigPath(home),
      home,
      assertAdmitting: () => {},
      endpointContext: (id) => providerEndpointContext(resolver, id),
      publishPreference: (prepared, admit) => Promise.resolve(prepared.publish(admit)),
      credentialSurface: 'standalone-chat',
      wizard: {
        store: createProviderStore(db.db, { uuid: () => 'card', now: () => 1 }),
        keychain,
        io: captureIo().io,
        writeDefaultModel: () => ({ kind: 'saved', durability: 'confirmed' }),
        validate: (_id, _key, signal) => {
          checkSignal = signal;
          return new Promise<ProviderKeyValidation>(() => {});
        },
      },
    }).run('automatic');
    const turn = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
    for (let at = 0; at < 50 && channel.ui.getSnapshot().kind !== 'select'; at += 1) await turn();
    channel.ui.input('\r', ENTER);
    for (let at = 0; at < 50 && channel.ui.getSnapshot().kind !== 'password'; at += 1) await turn();
    channel.ui.paste(SECRET);
    channel.ui.input('\r', ENTER);
    for (let at = 0; at < 50 && checkSignal === undefined; at += 1) await turn();
    expect(channel.ui.getSnapshot().kind).toBe('busy');
    expect(channel.ui.getSnapshot().escape, 'a card’s wait has no step back').toBe('cancel');
    channel.ui.input('', ESC);
    const outcome = await running;
    expect(outcome.status).toBe('cancelled');
    expect(checkSignal?.aborted).toBe(true);
    expect(keychain.stored.size).toBe(0);
    db.sqlite.close();
  });
});

describe('the key step (ADR-0146 §6, G20) and its secret, inside the frame', () => {
  it('says where the key is kept and where it goes, discloses the check, never shows the key, clears it on a resize and on a step back, and ends in Done', async () => {
    const r = rig();
    const running = r.coordinator.run('automatic');
    await r.choose('openai');
    await r.until((s) => s.kind === 'password');
    expect(r.snapshot().popup).toMatchObject({
      stepIndex: 1,
      exitLabel: 'close',
      enterVerb: KEY_STEP_ENTER_VERB,
    });
    // O9: the key's `Enter` says what it does, it sends the key to be checked (ADR-0145 §3).
    expect(KEY_STEP_ENTER_VERB).toBe('check');
    expect(nativePopupLegend(r.snapshot()).items[0]).toMatchObject({
      keys: 'Enter',
      verb: 'check',
    });
    expect(r.snapshot().note).toBe(
      'Stored in your OS keychain, never on disk. Sent only to https://api.openai.com, once, to check it.',
    );
    expect(r.snapshot().message).toBe('Paste your OpenAI API key');
    expect(r.snapshot().escape).toBe('back');
    await r.paste(SECRET);
    expect(r.snapshot().display).toBe('•'.repeat(SECRET.length));
    // Any resize clears the key (ADR-0148 §4): nothing of it survives, and the field says so.
    r.channel.ui.resized();
    expect(r.snapshot().display).toBe('');
    expect(r.snapshot().error).toBe(NATIVE_PROMPT_RESIZED);
    r.channel.ui.paste(SECRET);
    // `Esc` steps back to the provider list: the key is cleared, and the rail rewinds.
    r.key(ESC);
    await r.until((s) => s.message === 'Which provider?');
    expect(r.snapshot().popup?.stepIndex).toBe(0);
    await r.choose('openai');
    await r.paste(SECRET);
    r.key(ENTER, '\r');
    await r.until((s) => s.final === 'ok');
    expect(
      r.published.some((s) => s.message === keyCheckText('OpenAI', 'https://api.openai.com')),
    ).toBe(true);
    expect(r.snapshot().message).toBe('Connected · OpenAI · gpt-5.4-mini');
    expect(r.snapshot().details).toEqual([
      'Type a message to start, or /init to set up this folder',
    ]);
    expect(r.snapshot().popup?.stepIndex).toBe(2);
    await r.closeDone('enter');
    const outcome = await running;
    expect(outcome).toEqual({ status: 'ready', changed: true });
    expect(r.keychain.stored.get(keychainAccount('openai'))).toBe(SECRET);
    expect(r.written).toEqual([['gpt-5.4-mini', 'openai']]);
    // The key is in no frame, no notice, no config.
    expect(JSON.stringify(r.published)).not.toContain('6604');
    expect(JSON.stringify(outcome)).not.toContain('6604');
    expect(existsSync(r.path) ? readFileSync(r.path, 'utf8') : '').not.toContain('6604');
    r.close();
  });

  it('a failed check: `Retry the check` first after a network failure, `Save it anyway` never pre-selected and its hint names the doctor, `Esc` returns to the key, and an unverified key ends in `Saved`', async () => {
    const outcomes = [NETWORK, NETWORK];
    const r = rig({ validate: () => Promise.resolve(outcomes.shift() ?? NETWORK) });
    const running = r.coordinator.run('automatic');
    await r.choose('anthropic');
    await r.paste(SECRET);
    r.key(ENTER, '\r');
    await r.until((s) => s.kind === 'select' && s.options.some((o) => o.value === 'recheck'));
    const failed = r.snapshot();
    expect(failed.options.map((option) => option.label)).toEqual([
      'Retry the check',
      'Enter a different key',
      'Save it anyway · not verified',
      'Skip setup',
    ]);
    expect(failed.options[failed.selected]?.value).toBe('recheck');
    expect(failed.options.find((o) => o.value === 'continue')?.hint).toBe(SAVE_ANYWAY_HINT);
    expect(SAVE_ANYWAY_HINT).toBe('not checked · verify later with /doctor, then [d]');
    expect(failed.popup?.stepIndex, 'the choices are the key step’s').toBe(1);
    r.key(ESC);
    await r.until((s) => s.kind === 'password');
    expect(r.snapshot().display, 'the key step again, empty').toBe('');
    await r.paste(SECRET);
    r.key(ENTER, '\r');
    await r.choose('continue');
    await r.until((s) => s.final === 'ok');
    expect(r.snapshot().message).toBe('Saved · Anthropic · claude-haiku-5-5');
    expect(r.snapshot().details).toEqual([
      UNVERIFIED_KEY_LINE,
      'Type a message to start, or /init to set up this folder',
    ]);
    await r.closeDone('esc');
    // `Esc` on the Done step closes it as a step back: the stored key is not read as a cancel.
    expect((await running).status).toBe('ready');
    r.close();
  });
});

describe('what a held key and a closing Home cannot do to the key check', () => {
  const HELD_RATES = [30, 100, 300] as const;
  /** How long the key is held down: well past the guarded row's lockout, which every refused repeat restarts. */
  const HELD_MS = 6000;
  it.each(
    HELD_RATES.flatMap((rate) =>
      (['plain', 'kitty'] as const).map((kind) => [rate, kind] as const),
    ),
  )(
    'S5: the `Enter` that submitted the key, held (a repeat every %i ms, %s), never answers the pre-selected `Retry the check`: the key is sent once; one patient `Enter` after the lockout sends it again',
    async (rate, kind) => {
      let checks = 0;
      const r = rig({
        validate: () => {
          checks += 1;
          return Promise.resolve(NETWORK);
        },
      });
      const running = r.coordinator.run('automatic');
      await r.choose('anthropic');
      await r.paste(SECRET);
      r.key(ENTER, '\r'); // the press that submits the key, held down from here
      await r.until((s) => s.kind === 'select' && s.options.some((o) => o.value === 'recheck'));
      r.show();
      expect(r.snapshot().options[r.snapshot().selected]).toMatchObject({
        value: 'recheck',
        guarded: true,
      });
      for (let at = 0; at <= HELD_MS; at += rate) {
        r.advance(rate);
        r.key(kind === 'kitty' ? { ...ENTER, eventType: 'repeat' } : ENTER, '\r');
        await r.flush();
      }
      expect(checks, 'the held key re-sent nothing').toBe(1);
      expect(
        r.snapshot().options.some((o) => o.value === 'recheck'),
        'still asking',
      ).toBe(true);
      // The key is released; a deliberate `Enter`, pressed once after the lockout, checks the same key again.
      r.advance(APPROVAL_LOCKOUT_MS + 100);
      r.key(ENTER, '\r');
      await r.flush();
      expect(checks).toBe(2);
      r.channel.flow.cancel();
      await running;
      r.close();
    },
  );

  it('M1: a Home that began closing while the key was being checked stores nothing and writes no default (the setup asks the coordinator’s admission at every step)', async () => {
    let closing = false;
    const r = rig({
      admit: () => {
        if (closing) throw new Error('Home is closing.');
      },
      validate: () => {
        closing = true; // the Home begins to close while the check is in flight
        return Promise.resolve(OK);
      },
    });
    const failure = r.coordinator.run('automatic').then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await r.choose('gemini');
    await r.paste(SECRET);
    r.key(ENTER, '\r');
    const caught = await failure;
    expect(caught instanceof Error ? caught.message : caught).toBe('Provider setup failed.');
    expect(r.keychain.stored.size, 'no key was stored for a Home that is closing').toBe(0);
    expect(r.written, 'no default was written').toEqual([]);
    expect(existsSync(r.path), 'no config was written').toBe(false);
    r.close();
  });
});

describe('a skip of the first run is remembered (ADR-0146 §6, ruled 2026-11-24)', () => {
  it('with no config: `Esc` on the first step writes the skip with no card, and the host says it in one notification', async () => {
    const r = rig();
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.message === 'Which provider?');
    r.esc();
    const outcome = await running;
    expect(outcome).toMatchObject({ status: 'cancelled', notice: setupSkippedNotice('home') });
    expect(readFileSync(r.path, 'utf8')).toBe('[preferences]\nfirst_run_setup_skipped = true\n');
    expect(setupSkippedNotice('home').length, 'a notification fits 54 columns').toBeLessThanOrEqual(
      54,
    );
    r.close();
  });

  it('C-F3: on a hand-made config `Esc` remembers nothing: the config is byte for byte as it was, nothing is published, no popup opens again, and the one line says it opens again next launch', async () => {
    const published = { count: 0 };
    const r = rig({ config: 'hand-made', published });
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.message === 'Which provider?');
    r.esc();
    const outcome = await running;
    expect(outcome.notice).toBe(SETUP_SKIP_NOT_SAVED);
    expect(SETUP_SKIP_NOT_SAVED.length, 'a notification fits 54 columns').toBeLessThanOrEqual(54);
    expect(readFileSync(r.path, 'utf8'), 'its comment and its order are kept').toBe(baseline);
    expect(published.count, 'no rewrite was published').toBe(0);
    expect(r.snapshot().active, 'no second popup for a disclosure').toBe(false);
    expect(
      r.published.some((s) => s.final !== undefined),
      'no Done step for a skip',
    ).toBe(false);
    r.close();
  });

  it('a skip whose write is refused (a symbolic link) is the one “not saved” notification, and nothing is written through the link', async () => {
    const r = rig({ config: 'symlink' });
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.message === 'Which provider?');
    r.esc();
    expect((await running).notice).toBe(SETUP_SKIP_NOT_SAVED);
    expect(readFileSync(join(r.home, 'real.toml'), 'utf8')).toBe(baseline);
    r.close();
  });

  it('`Skip setup` after a failed check is a remembered skip too', async () => {
    const r = rig({ validate: () => Promise.resolve(NETWORK) });
    const running = r.coordinator.run('automatic');
    await r.choose('gemini');
    await r.paste(SECRET);
    r.key(ENTER, '\r');
    await r.choose('skip');
    expect((await running).notice).toBe(setupSkippedNotice('home'));
    expect(readFileSync(r.path, 'utf8')).toContain('first_run_setup_skipped = true');
    expect(r.keychain.stored.size).toBe(0);
    r.close();
  });

  it('S3: `Ctrl+C` on the first step of the first run leaves it: nothing is written, and the one line says it opens again next launch', async () => {
    const r = rig();
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.message === 'Which provider?');
    r.key({ ...NONE, ctrl: true }, 'c');
    const outcome = await running;
    expect(outcome).toEqual({
      status: 'cancelled',
      changed: true,
      notice: setupClosedNotice('home'),
    });
    expect(setupClosedNotice('home')).toBe('Setup closed · it opens again next launch');
    expect(setupClosedNotice('home').length).toBeLessThanOrEqual(54);
    expect(existsSync(r.path), 'a Ctrl+C writes no remembered skip').toBe(false);
    r.close();
  });

  it.each([
    ['the environment-key consent', { env: { OPENAI_API_KEY: 'synthetic-env-6120' } }, 'use'],
    ['the keychain step', { keychainDown: true }, 'retry'],
  ] as const)(
    'S3: on %s of the first run, `Esc` is the remembered skip and `Ctrl+C` writes nothing',
    async (_step, options, row) => {
      for (const how of ['esc', 'ctrl+c'] as const) {
        const r = rig(options);
        const running = r.coordinator.run('automatic');
        await r.until((s) => s.kind === 'select' && s.options.some((o) => o.value === row));
        expect(r.snapshot().escape, 'opened to step back: the channel tells Esc from Ctrl+C').toBe(
          'back',
        );
        if (how === 'esc') r.esc();
        else r.key({ ...NONE, ctrl: true }, 'c');
        const outcome = await running;
        if (how === 'esc') {
          expect(outcome.notice).toBe(setupSkippedNotice('home'));
          expect(readFileSync(r.path, 'utf8')).toContain('first_run_setup_skipped = true');
        } else {
          expect(outcome.notice).toBe(setupClosedNotice('home'));
          expect(existsSync(r.path), 'nothing written for a Ctrl+C').toBe(false);
        }
        r.close();
      }
    },
  );

  it('the first run’s `Esc` on the environment-key consent declines the source for the process, as `Not now` does', async () => {
    const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-6121' } });
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.kind === 'select' && s.options.some((o) => o.value === 'use'));
    r.key(ESC);
    await running;
    expect(r.policy.isDeferred('openai')).toBe(true);
    expect(r.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
    r.close();
  });

  it('C-F5: `Not now` on the environment-key consent and on the keychain step is not remembered, and says it opens again next launch', async () => {
    for (const options of [
      { env: { OPENAI_API_KEY: 'synthetic-env-7031' } },
      { keychainDown: true },
    ] as const) {
      const r = rig(options);
      const running = r.coordinator.run('automatic');
      await r.choose(options.env === undefined ? 'cancel' : 'defer');
      const outcome = await running;
      expect(outcome.notice).toBe(setupClosedNotice('home'));
      expect(existsSync(r.path), 'a Not now writes nothing').toBe(false);
      r.close();
    }
  });

  it('`Ctrl+C` at the key step is a cancel: not remembered, and says it opens again next launch', async () => {
    const r = rig();
    const running = r.coordinator.run('automatic');
    await r.choose('deepseek');
    await r.paste(SECRET);
    r.key({ ...NONE, ctrl: true }, 'c');
    expect((await running).notice).toBe(setupClosedNotice('home'));
    expect(existsSync(r.path)).toBe(false);
    r.close();
  });

  it('O13: an explicit `/providers` closed while keyless is no remembered skip and says nothing', async () => {
    const r = rig();
    const running = r.coordinator.run('explicit');
    await r.until((s) => s.message === 'Which provider?');
    r.key(ESC);
    expect((await running).notice).toBeUndefined();
    expect(existsSync(r.path)).toBe(false);
    r.close();
  });

  it('P06: an explicit `/providers` whose `Skip setup` after a failed check writes no first-run skip and says nothing', async () => {
    const r = rig({ validate: () => Promise.resolve(NETWORK) });
    const running = r.coordinator.run('explicit');
    await r.choose('gemini');
    await r.paste(SECRET);
    r.key(ENTER, '\r');
    await r.choose('skip');
    expect((await running).notice).toBeUndefined();
    expect(existsSync(r.path), 'an explicit setup writes no first-run skip').toBe(false);
    r.close();
  });
});

describe('the environment-key consent (ADR-0146 §6, G15; ADR-0148 §3)', () => {
  it('names the variable, the provider, the model and where it is saved; `Use it` is the guarded first row; it opens on `Not now`', async () => {
    const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-2207' } });
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.kind === 'select' && s.options.some((o) => o.value === 'use'));
    const consent = r.snapshot();
    expect(consent.message).toBe(
      'OPENAI_API_KEY is set for OpenAI. Use it, with gpt-5.4-mini as your default model? Saved to your global config; the variable stays yours.',
    );
    expect(consent.options.map((o) => [o.value, o.label, o.guarded === true])).toEqual([
      ['use', 'Use it', true],
      ['manual', 'Enter a different key', false],
      ['defer', 'Not now', false],
    ]);
    expect(consent.options[consent.selected]?.value).toBe('defer');
    expect(consent.popup?.exitLabel).toBe('close');
    expect(consent.escape, 'Esc on the first step is the skip').toBe('back');
    r.channel.flow.cancel();
    await running;
    r.close();
  });

  const DELAYS = [250, 600, 1000, 1400, 1800] as const;
  const RATES = [30, 120, 500, 1000, 1800] as const;
  const HOLD_MS = 6000;
  it.each(
    DELAYS.flatMap((delay) =>
      RATES.flatMap((rate) =>
        (['plain', 'kitty'] as const).map((kind) => [delay, rate, kind] as const),
      ),
    ),
  )(
    'a held Enter on `Use it` (first %i ms after it appeared, then every %i ms, %s repeats) never grants the source',
    async (delay, rate, kind) => {
      const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-3318' } });
      const running = r.coordinator.run('automatic');
      await r.until((s) => s.kind === 'select' && s.options.some((o) => o.value === 'use'));
      // The popup appears (its first frame is acknowledged); the highlight moves to `Use it` at once (the arrows act at once), and the held
      // `Enter` starts `delay` ms after the select appeared.
      r.show();
      r.advance(10);
      r.key(UP);
      r.show();
      r.key(UP);
      r.show();
      expect(r.snapshot().options[r.snapshot().selected]?.value).toBe('use');
      r.advance(delay - 10);
      for (let at = 0, press = 0; at <= HOLD_MS; at += rate, press += 1) {
        r.key(kind === 'kitty' && press > 0 ? { ...ENTER, eventType: 'repeat' } : ENTER, '\r');
        r.advance(rate);
      }
      await r.flush();
      expect(
        r.snapshot().options.some((o) => o.value === 'use'),
        'still asking',
      ).toBe(true);
      expect(r.policy.allows('openai', 'OPENAI_API_KEY')).toBe(false);
      expect(existsSync(r.path), 'nothing was written').toBe(false);
      r.channel.flow.cancel();
      await running;
      r.close();
    },
  );

  it('one patient `Enter` after the lockout grants it, writes the consent and the starter, and ends in Done', async () => {
    const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-4471' } });
    const running = r.coordinator.run('automatic');
    await r.choose('use');
    await r.until((s) => s.final === 'ok');
    expect(r.snapshot().message).toBe('Using OPENAI_API_KEY · OpenAI · gpt-5.4-mini');
    expect(r.snapshot().details).toEqual([
      'Saved to your global config; the variable stays yours.',
      'Type a message to start, or /init to set up this folder',
    ]);
    expect(r.policy.allows('openai', 'OPENAI_API_KEY')).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toContain('OPENAI_API_KEY');
    expect(readFileSync(r.path, 'utf8')).not.toContain('4471');
    await r.closeDone('enter');
    expect((await running).status).toBe('ready');
    r.close();
  });

  it('when the consent cannot be published to a symbolic link, the recovery’s first row is guarded too', async () => {
    const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-5590' }, config: 'symlink' });
    const running = r.coordinator.run('automatic');
    await r.choose('use');
    await r.until((s) => s.options.some((o) => o.value === 'once'));
    expect(r.snapshot().options.map((o) => [o.value, o.guarded === true])).toEqual([
      ['once', true],
      ['cancel', false],
    ]);
    r.channel.flow.cancel();
    await running;
    r.close();
  });
});

describe('a keychain known to be unavailable (G19)', () => {
  it('names the variable once, offers no key prompt, and says what is remembered', async () => {
    const r = rig({ keychainDown: true });
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.options.some((o) => o.value === 'retry'));
    const card = r.snapshot();
    expect(card.message.split('RELAVIUM_ANTHROPIC_API_KEY')).toHaveLength(2);
    expect(card.options.map((o) => o.label)).toEqual([
      'Retry keychain',
      'Remember this and continue without a key',
      'Not now',
    ]);
    expect(card.popup).toMatchObject({ stepIndex: 0, exitLabel: 'close' });
    await r.choose('ack');
    await r.until((s) => s.final === 'ok');
    expect(r.snapshot().message).toBe('Remembered · the OS keychain is unavailable');
    await r.closeDone('esc');
    expect((await running).status).toBe('deferred');
    expect(readFileSync(r.path, 'utf8')).toContain('keychain_unavailable_acknowledged = true');
    r.close();
  });
});

describe('the gaps the mutation review found (MVP-11 unit 6, round 1: M6)', () => {
  it('P14: `Esc` on the key step reached from an environment-key consent in an explicit `/providers` returns to the list, not to the consent', async () => {
    const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-9911' } });
    const running = r.coordinator.run('explicit');
    await r.choose('openai');
    await r.choose('manual');
    await r.until((s) => s.kind === 'password');
    r.key(ESC);
    await r.until((s) => s.kind === 'select');
    expect(r.snapshot().message).toBe('Which provider?');
    r.channel.flow.cancel();
    await running;
    r.close();
  });

  /** A keychain that is down until `recover()`: what a person who unlocked it and chose `Retry keychain` finds. */
  function recoveringKeychain(): KeychainStore & {
    readonly stored: Map<string, string>;
    readonly recover: () => void;
  } {
    const inner = memoryKeychain();
    let down = true;
    return {
      ...inner,
      stored: inner.stored,
      recover: () => {
        down = false;
      },
      get: (account) => {
        if (down) throw new KeychainUnavailableError('synthetic locked keychain');
        return inner.get(account);
      },
    };
  }

  it('P22: `Retry keychain` after the keychain recovered goes on to the key step', async () => {
    const keychain = recoveringKeychain();
    const r = rig({ keychain });
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.options.some((o) => o.value === 'retry'));
    keychain.recover();
    await r.choose('retry');
    await r.until((s) => s.kind === 'password' || s.note === 'The keychain is still unavailable.');
    expect(r.snapshot().kind, 'the key step opened').toBe('password');
    r.channel.flow.cancel();
    await running;
    r.close();
  });

  it('P21: `Retry keychain` that finds a usable key ends the setup as ready, changing nothing', async () => {
    const keychain = recoveringKeychain();
    const r = rig({ keychain });
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.options.some((o) => o.value === 'retry'));
    keychain.recover();
    keychain.stored.set(keychainAccount('anthropic'), 'synthetic-stored-key');
    await r.choose('retry');
    expect(await running).toEqual({ status: 'ready', changed: false });
    expect(existsSync(r.path), 'nothing written').toBe(false);
    r.close();
  });

  it.each([
    ['home', 'Keychain is unavailable. Open /providers to retry.'],
    ['standalone-chat', 'Keychain is unavailable. Restart this chat to retry setup.'],
  ] as const)(
    'P25: the automatic run of a keychain already remembered as unavailable asks nothing and says how to retry on %s',
    async (surface, line) => {
      const r = rig({ keychainDown: true, acknowledged: true, surface });
      const outcome = await r.coordinator.run('automatic');
      expect(outcome).toEqual({ status: 'deferred', changed: false, notice: line });
      // On the Home the line is a notification (54 columns); a stand-alone chat writes it as a line of its own.
      expect(surface === 'home' ? line.length : 0).toBeLessThanOrEqual(54);
      expect(r.published.some((s) => s.kind === 'select')).toBe(false);
      r.close();
    },
  );

  it('P42: the consent of a Home that already has a usable key names no default model (none will be chosen)', async () => {
    const r = rig({
      env: {
        RELAVIUM_ANTHROPIC_API_KEY: 'synthetic-usable-1',
        OPENAI_API_KEY: 'synthetic-env-7782',
      },
    });
    const running = r.coordinator.run('explicit');
    await r.choose('openai');
    await r.until((s) => s.kind === 'select' && s.options.some((o) => o.value === 'use'));
    expect(r.snapshot().message).toBe(consentMessage('OPENAI_API_KEY', 'OpenAI'));
    expect(r.snapshot().message).not.toContain('default model');
    r.channel.flow.cancel();
    await running;
    r.close();
  });

  it('W08: a key pasted with whitespace around it is checked and stored trimmed', async () => {
    const seen: string[] = [];
    const r = rig({
      validate: (_id, key) => {
        seen.push(key);
        return Promise.resolve(OK);
      },
    });
    const running = r.coordinator.run('automatic');
    await r.choose('gemini');
    await r.paste(`  ${SECRET} `);
    r.key(ENTER, '\r');
    await r.until((s) => s.final !== undefined);
    expect(seen).toEqual([SECRET]);
    expect([...r.keychain.stored.values()]).toEqual([SECRET]);
    await r.closeDone('esc');
    await running;
    r.close();
  });

  it('W22: a starter model selected for this invocation only is named on the Done step', async () => {
    const r = rig({ writeDefault: () => ({ kind: 'ephemeral' }) });
    const running = r.coordinator.run('automatic');
    await r.choose('gemini');
    await r.paste(SECRET);
    r.key(ENTER, '\r');
    await r.until((s) => s.final !== undefined);
    const model = KNOWN_PROVIDERS.gemini.starterModel;
    expect(r.snapshot().message).toBe(`Connected · Google Gemini · ${model}`);
    expect(r.snapshot().details).toEqual([
      `${model} is selected for this invocation only; the default was not saved.`,
    ]);
    await r.closeDone('esc');
    await running;
    r.close();
  });

  it('W16: the flow cancelled just after the key was written says the key is stored and the setup was interrupted, and registers no row', async () => {
    let cancel = (): void => {};
    const inner = memoryKeychain();
    const r = rig({
      keychain: {
        ...inner,
        stored: inner.stored,
        set: (account, value) => {
          inner.set(account, value);
          cancel();
        },
      },
    });
    cancel = () => r.channel.flow.cancel();
    const running = r.coordinator.run('automatic');
    await r.choose('gemini');
    await r.paste(SECRET);
    r.key(ENTER, '\r');
    const outcome = await running;
    expect(outcome.notice).toBe('Google Gemini key stored · setup was interrupted');
    expect(outcome.status, 'a stored key is a change').toBe('ready');
    expect(r.written, 'no default was written after the cancel').toEqual([]);
    r.close();
  });
});

describe('what the moved consent and keychain steps say (A3: the mutation spot-check of the refactor)', () => {
  /** Grant `OPENAI_API_KEY` on the first run and return the Done step. */
  async function granted(options: Parameters<typeof rig>[0]): Promise<{
    readonly r: ReturnType<typeof rig>;
    readonly done: NativePromptSnapshot;
    readonly running: Promise<unknown>;
  }> {
    const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-8120' }, ...options });
    const running = r.coordinator.run('automatic');
    await r.choose('use');
    await r.until((s) => s.final !== undefined);
    return { r, done: r.snapshot(), running };
  }
  const model = KNOWN_PROVIDERS.openai.starterModel;

  it('a consent saved with an unconfirmed durability says so on its Done step', async () => {
    const { r, done, running } = await granted({ unconfirmed: true });
    expect(done.details.slice(0, 2)).toEqual([
      'Saved to your global config; the variable stays yours.',
      'Saved, but persistence after a crash is unconfirmed.',
    ]);
    await r.closeDone('esc');
    await running;
    r.close();
  });

  it('a starter selected for this invocation only after a consent is named, and its Done step says the default was not saved', async () => {
    const { r, done, running } = await granted({ writeDefault: () => ({ kind: 'ephemeral' }) });
    expect(done.message).toBe(`Using OPENAI_API_KEY · OpenAI · ${model}`);
    expect(done.details).toContain(
      `${model} is selected for this invocation only; the default was not saved.`,
    );
    await r.closeDone('esc');
    await running;
    r.close();
  });

  it('a starter saved with an unconfirmed durability after a consent says so', async () => {
    const { r, done, running } = await granted({
      writeDefault: () => ({ kind: 'saved', durability: 'unconfirmed' }),
    });
    expect(done.details).toContain(
      'The default model was saved, but persistence after a crash is unconfirmed.',
    );
    await r.closeDone('esc');
    await running;
    r.close();
  });

  it('a starter whose write fails with a config fault keeps the granted source and says to pick a model; any other fault is not swallowed', async () => {
    const { r, done, running } = await granted({
      writeDefault: () => {
        throw new ConfigError('synthetic.toml', 'synthetic config fault');
      },
    });
    expect(done.message).toBe('Using OPENAI_API_KEY · OpenAI');
    expect(done.details).toContain(
      'The starter default could not be saved; select a model with /models.',
    );
    await r.closeDone('esc');
    await running;
    r.close();
    const other = rig({
      env: { OPENAI_API_KEY: 'synthetic-env-8121' },
      writeDefault: () => {
        throw new Error('synthetic private failure');
      },
    });
    const failure = other.coordinator.run('automatic').then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await other.choose('use');
    const caught = await failure;
    expect(caught instanceof Error ? caught.message : caught).toBe('synthetic private failure');
    other.close();
  });

  it('a stored key whose starter default was not saved names no model on its Done step', async () => {
    const r = rig({ writeDefault: () => ({ kind: 'cancelled' }) });
    const running = r.coordinator.run('automatic');
    await r.choose('gemini');
    await r.paste(SECRET);
    r.key(ENTER, '\r');
    await r.until((s) => s.final !== undefined);
    expect(r.snapshot().message).toBe('Connected · Google Gemini');
    expect(r.snapshot().details).toEqual([
      'The default was not saved. Choose a model with /models.',
    ]);
    await r.closeDone('esc');
    await running;
    r.close();
  });

  /** A keychain that is down until `recover()`, with an environment key waiting for consent once it is up. */
  function recovering(): KeychainStore & {
    readonly stored: Map<string, string>;
    readonly recover: () => void;
  } {
    const inner = memoryKeychain();
    let down = true;
    return {
      ...inner,
      stored: inner.stored,
      recover: () => {
        down = false;
      },
      get: (account) => {
        if (down) throw new KeychainUnavailableError('synthetic locked keychain');
        return inner.get(account);
      },
    };
  }

  it('`Esc` on the consent that `Retry keychain` led to in a `/providers` the person opened returns to the list', async () => {
    const keychain = recovering();
    const r = rig({ keychain, env: { OPENAI_API_KEY: 'synthetic-env-8122' } });
    const running = r.coordinator.run('explicit');
    await r.choose('anthropic');
    await r.until((s) => s.options.some((o) => o.value === 'retry'));
    keychain.recover();
    await r.choose('retry');
    await r.until((s) => s.options.some((o) => o.value === 'use'));
    r.key(ESC);
    await r.until((s) => s.kind === 'select' && s.message === 'Which provider?');
    expect(
      r.snapshot().options.some((o) => o.value === 'retry'),
      'not the keychain step',
    ).toBe(false);
    r.channel.flow.cancel();
    await running;
    r.close();
  });
});

describe('hostile text a provider, an endpoint or a variable wrote', () => {
  const CORPUS = [
    '\u001b[31mred\u001b[0m',
    '\u001b]52;c;Zm9v\u0007clip',
    '\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007',
    'c1\u0085\u009b[2Jx',
    'bidi‮evil⁦x⁩',
    'zero​width‍﻿',
    'line sep para',
    '[Ctrl+Y] Allow · Esc close',
    '［Ｃｔｒｌ＋Ｙ］ fullwidth',
    'sk-ant-api03-' + 'A'.repeat(40),
    'long '.repeat(400).trim(),
  ];
  /** A character no drawn row may carry: a C0 control but the tab, DEL or a C1 control, a bidirectional control, a line separator. */
  const carriesEscape = (text: string): boolean =>
    Array.from(text).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        (code < 0x20 && code !== 0x09) ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) ||
        code === 0x2028 ||
        code === 0x2029
      );
    });

  it.each(CORPUS)(
    '%j: the setup’s scrub is the popups’ full scrub, its line separators folded',
    (text) => {
      expect(scrubSetupText(text)).toBe(foldLineSeparators(scrubPopupText(text)));
      expect(carriesEscape(scrubSetupText(text))).toBe(false);
      expect(scrubSetupText(text)).not.toContain('[Ctrl+Y]');
      expect(scrubSetupText(text)).not.toContain('A'.repeat(40));
    },
  );

  it.each(CORPUS)(
    '%j as an endpoint’s destination: every option hint and note of the popup is scrubbed, and the key step names no origin it cannot prove',
    async (text) => {
      const r = rig({
        resolver: (resolver) => ({
          ...resolver,
          endpointContext: () => `Custom endpoint: ${text}`,
        }),
      });
      const running = r.coordinator.run('automatic');
      await r.choose('openai');
      await r.until((s) => s.kind === 'password');
      expect(r.snapshot().note).toBe(keyStepNote(UNKNOWN_KEY_HOST));
      for (const snapshot of r.published) {
        const words = [
          snapshot.message,
          snapshot.note,
          ...snapshot.options.flatMap((o) => [o.label, o.hint ?? '']),
          ...snapshot.details,
        ];
        for (const word of words) {
          expect(carriesEscape(word), JSON.stringify(word)).toBe(false);
          expect(word).not.toContain('[Ctrl+Y]');
          expect(word).not.toContain('A'.repeat(40));
        }
      }
      r.channel.flow.cancel();
      await running;
      r.close();
    },
  );

  it.each(CORPUS)(
    '%j as a variable, a provider or a model: the consent sentence composed of scrubbed parts carries none of it',
    (text) => {
      const clean = scrubSetupText(text);
      const sentence = consentMessage(clean, clean, clean);
      expect(carriesEscape(sentence)).toBe(false);
      expect(sentence).not.toContain('[Ctrl+Y]');
      expect(keyCheckText(clean, clean)).not.toContain('[Ctrl+Y]');
      expect(carriesEscape(keyStepNote(clean))).toBe(false);
    },
  );

  it('a pinned origin is named whole and exactly; a destination that is not an https origin is never guessed', () => {
    const resolver = (context: string): ProviderResolver => ({
      resolveProvider: () => undefined,
      keyFor: () => '',
      endpointContext: () => context,
    });
    expect(
      keyDestinationHost(resolver('Custom endpoint: https://old.example:8443'), 'openai'),
    ).toBe('https://old.example:8443');
    expect(keyDestinationHost(resolver('Custom endpoint: http://plain.example'), 'openai')).toBe(
      UNKNOWN_KEY_HOST,
    );
    expect(
      keyDestinationHost(resolver('Custom endpoint: https://x.example/path?q=secret'), 'openai'),
    ).toBe(UNKNOWN_KEY_HOST);
    expect(
      keyDestinationHost(resolver('Configured custom endpoint (origin unavailable).'), 'openai'),
    ).toBe(UNKNOWN_KEY_HOST);
  });
});

describe('MVP-11 unit 6, round 1 second pass (W7): the first run’s ways out, its rail and its writes', () => {
  /** The legend row of a framed prompt, as text (the rows of these steps fit 80 columns whole). */
  const legendOf = (snapshot: NativePromptSnapshot): string => {
    const { items, exit } = nativePopupLegend(snapshot);
    return legend(items, exit);
  };
  const SKIP_LEGEND = '↑/↓ select · Enter choose · Esc skip for now · [Ctrl+C] close';
  const BACK_LEGEND = '↑/↓ select · Enter choose · Esc back · [Ctrl+C] close';

  /** The rail row of the frame the overlay draws at 80×24, in colour or in the plain glyphs. */
  const railRow = (snapshot: NativePromptSnapshot, color: boolean): string => {
    const { geometry, layout } = nativePopupGeometry(
      snapshot,
      'overlay',
      { cols: 80, rows: 24 },
      color,
    );
    if (!geometry.fits || layout === undefined || !layout.fits)
      throw new Error('the frame does not fit 80x24');
    const rows = nativePopupFrameLines(snapshot, geometry, layout, color).map((line) =>
      line.text.trim(),
    );
    expect(rows.some((row) => row.includes('step 3 of 3'))).toBe(true);
    const rail = rows.find((row) => row.includes('Provider') && row.includes('Done'));
    if (rail === undefined) throw new Error('no rail row');
    return rail;
  };

  /** A resolver whose provider sample is the test's own (`availability`), every other port the real one's. */
  const sampled =
    (availability: NonNullable<ProviderResolver['availability']>) =>
    (resolver: ProviderResolver): ProviderResolver => ({ ...resolver, availability });

  describe('item 1: the first step’s `Esc` is the skip, and its legend says so', () => {
    it('`Which provider?` of the first run reads `Esc skip for now · [Ctrl+C] close`; the key step it leads to says `Esc back`; a step back finds the skip again', async () => {
      const r = rig();
      const running = r.coordinator.run('automatic');
      await r.until((s) => s.message === 'Which provider?');
      expect(FIRST_STEP_ESCAPE_VERB).toBe('skip for now');
      expect(r.snapshot().popup?.escapeVerb).toBe(FIRST_STEP_ESCAPE_VERB);
      expect(legendOf(r.snapshot())).toBe(SKIP_LEGEND);
      await r.choose('openai');
      await r.until((s) => s.kind === 'password');
      expect(r.snapshot().popup?.escapeVerb).toBeUndefined();
      expect(legendOf(r.snapshot())).toBe('Enter check · Esc back · [Ctrl+C] close');
      r.esc();
      await r.until((s) => s.message === 'Which provider?');
      expect(legendOf(r.snapshot())).toBe(SKIP_LEGEND);
      r.channel.flow.cancel();
      await running;
      r.close();
    });

    it('the environment-key consent of the first run says the skip; the key step it leads to says `Esc back` and returns to it, which says the skip again', async () => {
      const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-7701' } });
      const running = r.coordinator.run('automatic');
      await r.until((s) => s.kind === 'select' && s.options.some((o) => o.value === 'use'));
      expect(legendOf(r.snapshot())).toBe(SKIP_LEGEND);
      await r.choose('manual');
      await r.until((s) => s.kind === 'password');
      expect(legendOf(r.snapshot())).toBe('Enter check · Esc back · [Ctrl+C] close');
      r.esc();
      await r.until((s) => s.kind === 'select' && s.options.some((o) => o.value === 'use'));
      expect(legendOf(r.snapshot())).toBe(SKIP_LEGEND);
      r.channel.flow.cancel();
      await running;
      r.close();
    });

    it('the keychain step of the first run says the skip', async () => {
      const r = rig({ keychainDown: true });
      const running = r.coordinator.run('automatic');
      await r.until((s) => s.options.some((o) => o.value === 'retry'));
      expect(legendOf(r.snapshot())).toBe(SKIP_LEGEND);
      r.channel.flow.cancel();
      await running;
      r.close();
    });

    it('where `Esc` returns to another step it says `back`: a consent reached from the explicit list (whose own `Esc` closes), and the consent `Retry keychain` led to on the first run, whose `Esc` returns to the keychain step', async () => {
      const explicit = rig({ env: { OPENAI_API_KEY: 'synthetic-env-7702' } });
      const listed = explicit.coordinator.run('explicit');
      await explicit.until((s) => s.message === 'Which provider?');
      expect(legendOf(explicit.snapshot())).toBe('↑/↓ select · Enter choose · Esc close');
      await explicit.choose('openai');
      await explicit.until((s) => s.options.some((o) => o.value === 'use'));
      expect(legendOf(explicit.snapshot())).toBe(BACK_LEGEND);
      explicit.channel.flow.cancel();
      await listed;
      explicit.close();

      let recovered = false;
      const r = rig({
        resolver: sampled((id) => {
          if (!recovered) return { status: 'unavailable', keychainHealth: 'unavailable' };
          return id === 'openai'
            ? {
                status: 'present-standard-not-allowed',
                source: { kind: 'standard-env', name: 'OPENAI_API_KEY' },
                keychainHealth: 'available',
              }
            : { status: 'missing', keychainHealth: 'available' };
        }),
      });
      const running = r.coordinator.run('automatic');
      await r.until((s) => s.options.some((o) => o.value === 'retry'));
      expect(legendOf(r.snapshot())).toBe(SKIP_LEGEND);
      recovered = true;
      await r.choose('retry');
      await r.until((s) => s.options.some((o) => o.value === 'use'));
      expect(legendOf(r.snapshot()), 'its Esc returns to the keychain step').toBe(BACK_LEGEND);
      r.esc();
      await r.until((s) => s.options.some((o) => o.value === 'retry'));
      expect(legendOf(r.snapshot())).toBe(SKIP_LEGEND);
      expect(existsSync(r.path), 'a step back skips nothing').toBe(false);
      r.channel.flow.cancel();
      await running;
      r.close();
    });

    it('a key asked for first (a custom endpoint refuses the environment key) says the skip and its `Esc` IS the skip; the choices after a failed check say `Esc back` and return to it', async () => {
      const r = rig({
        validate: () => Promise.resolve(NETWORK),
        resolver: sampled((id) =>
          id === 'openai'
            ? {
                status: 'ineligible-custom-endpoint',
                source: { kind: 'standard-env', name: 'OPENAI_API_KEY' },
                keychainHealth: 'available',
              }
            : { status: 'missing', keychainHealth: 'available' },
        ),
      });
      const running = r.coordinator.run('automatic');
      await r.until((s) => s.kind === 'password');
      expect(legendOf(r.snapshot())).toBe('Enter check · Esc skip for now · [Ctrl+C] close');
      await r.paste(SECRET);
      r.key(ENTER, '\r');
      await r.until((s) => s.options.some((o) => o.value === 'recheck'));
      expect(legendOf(r.snapshot())).toBe(BACK_LEGEND);
      r.esc();
      await r.until((s) => s.kind === 'password');
      expect(legendOf(r.snapshot())).toBe('Enter check · Esc skip for now · [Ctrl+C] close');
      r.esc();
      expect((await running).notice).toBe(setupSkippedNotice('home'));
      expect(readFileSync(r.path, 'utf8')).toContain('first_run_setup_skipped = true');
      r.close();
    });

    it('the words are a product constant drawn through the channel’s sanitiser, never data', () => {
      const channel = createNativePromptChannel({ now: () => 0 });
      channel.flow.begin();
      channel.flow.popup?.({
        title: '/providers',
        origin: 'home',
        stepIndex: 0,
        stepCount: 3,
        exitLabel: 'close',
        escapeVerb: 'skip\u001b[31m for‮ now',
        depth: 1,
      });
      expect(channel.ui.getSnapshot().popup?.escapeVerb).toBe('skip for now');
      channel.ui.dispose();
    });
  });

  describe('item 4: an `Esc` that arrived before the popup’s first frame is a close, never the skip', () => {
    it('before the first frame: nothing is written, and the one line says it opens again next launch', async () => {
      const r = rig();
      const running = r.coordinator.run('automatic');
      await r.until((s) => s.message === 'Which provider?');
      expect(r.snapshot().escape).toBe('back');
      r.key(ESC); // no frame was acknowledged: the key was on its way before the popup appeared
      const outcome = await running;
      expect(outcome.notice).toBe(setupClosedNotice('home'));
      expect(existsSync(r.path), 'no remembered skip').toBe(false);
      r.close();
    });

    it('at the very moment the frame appeared it is a close too (a key already on its way); a moment after it, it is the skip', async () => {
      const r = rig();
      const running = r.coordinator.run('automatic');
      await r.until((s) => s.message === 'Which provider?');
      r.show();
      r.key(ESC);
      expect((await running).notice).toBe(setupClosedNotice('home'));
      expect(existsSync(r.path)).toBe(false);
      r.close();

      const later = rig();
      const skipped = later.coordinator.run('automatic');
      await later.until((s) => s.message === 'Which provider?');
      later.esc();
      expect((await skipped).notice).toBe(setupSkippedNotice('home'));
      expect(readFileSync(later.path, 'utf8')).toContain('first_run_setup_skipped = true');
      later.close();
    });
  });

  describe('item 2 (O6): `Esc` during the key check goes back to the key step', () => {
    /** A check that answers only when the test says, and records the signal it was given. */
    function slowChecks() {
      const calls: {
        signal: AbortSignal | undefined;
        answer: (v: ProviderKeyValidation) => void;
      }[] = [];
      return {
        calls,
        validate: (_id: string, _key: string, signal?: AbortSignal) =>
          new Promise<ProviderKeyValidation>((answer) => {
            calls.push({ signal, answer });
          }),
      };
    }

    it('the field is empty, the check is aborted, its late success stores nothing, and the next key is checked once', async () => {
      const checks = slowChecks();
      const r = rig({ validate: checks.validate });
      const running = r.coordinator.run('automatic');
      await r.choose('openai');
      await r.paste(SECRET);
      r.key(ENTER, '\r');
      await r.until((s) => s.kind === 'busy' && s.message.startsWith('Checking your OpenAI key'));
      expect(r.snapshot().escape, 'the wait steps back').toBe('back');
      expect(legendOf(r.snapshot())).toBe('Esc back · [Ctrl+C] cancels it');
      r.esc();
      await r.until((s) => s.kind === 'password');
      expect(r.snapshot().display, 'the key step again, empty').toBe('');
      expect(r.snapshot().popup?.stepIndex).toBe(1);
      expect(checks.calls).toHaveLength(1);
      expect(checks.calls[0]?.signal?.aborted, 'the check was aborted').toBe(true);
      expect(r.channel.ui.signal()?.aborted, 'the flow was not').toBe(false);
      checks.calls[0]?.answer(OK); // the aborted check answers late
      await r.flush();
      expect(r.snapshot().kind).toBe('password');
      expect(r.keychain.stored.size, 'a late success stores nothing').toBe(0);
      expect(r.written).toEqual([]);
      await r.paste(SECRET);
      r.key(ENTER, '\r');
      await r.until((s) => s.kind === 'busy' && s.message.startsWith('Checking'));
      expect(checks.calls).toHaveLength(2);
      checks.calls[1]?.answer(OK);
      await r.until((s) => s.final === 'ok');
      expect(checks.calls).toHaveLength(2);
      expect(r.keychain.stored.get(keychainAccount('openai'))).toBe(SECRET);
      await r.closeDone('esc');
      expect((await running).status).toBe('ready');
      r.close();
    });

    it('`Ctrl+C` during the check leaves the setup: the check is aborted, nothing is stored or written', async () => {
      const checks = slowChecks();
      const r = rig({ validate: checks.validate });
      const running = r.coordinator.run('automatic');
      await r.choose('openai');
      await r.paste(SECRET);
      r.key(ENTER, '\r');
      await r.until((s) => s.kind === 'busy' && s.message.startsWith('Checking'));
      r.key({ ...NONE, ctrl: true }, 'c');
      const outcome = await running;
      expect(outcome.notice).toBe(setupClosedNotice('home'));
      expect(checks.calls[0]?.signal?.aborted).toBe(true);
      checks.calls[0]?.answer(OK);
      await r.flush();
      expect(r.keychain.stored.size).toBe(0);
      expect(r.written).toEqual([]);
      expect(existsSync(r.path)).toBe(false);
      r.close();
    });

    const HELD_RATES = [30, 100, 300] as const;
    /** How long the `Esc` is held down: well past the step-back lockout, which every refused repeat restarts. */
    const HELD_MS = 6000;
    it.each(
      HELD_RATES.flatMap((rate) =>
        (['plain', 'kitty'] as const).map((kind) => [rate, kind] as const),
      ),
    )(
      'a held `Esc` (a repeat every %i ms, %s) walks back ONE step: the key step stays open and nothing is skipped; one patient `Esc` after it steps back to the list',
      async (rate, kind) => {
        const checks = slowChecks();
        const r = rig({ validate: checks.validate });
        const running = r.coordinator.run('automatic');
        await r.choose('openai');
        await r.paste(SECRET);
        r.key(ENTER, '\r');
        await r.until((s) => s.kind === 'busy' && s.message.startsWith('Checking'));
        r.esc(); // pressed, and held from here
        await r.until((s) => s.kind === 'password');
        for (let at = 0; at <= HELD_MS; at += rate) {
          r.advance(rate);
          r.show();
          r.key(kind === 'kitty' ? { ...ESC, eventType: 'repeat' } : ESC);
          await r.flush();
        }
        expect(r.snapshot().kind, 'still on the key step').toBe('password');
        expect(existsSync(r.path), 'nothing skipped').toBe(false);
        expect(checks.calls).toHaveLength(1);
        r.advance(APPROVAL_LOCKOUT_MS + 100);
        r.key(ESC);
        await r.until((s) => s.message === 'Which provider?');
        r.channel.flow.cancel();
        await running;
        r.close();
      },
    );
  });

  describe('item 3: the rail does not tick a step that never happened', () => {
    it('a granted environment key ends on `✓ Provider ╌╌ ○ Key ╌╌ ◉ Done` (plain `ok Provider .. o Key .. @ Done`), still `step 3 of 3`', async () => {
      const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-7703' } });
      const running = r.coordinator.run('automatic');
      await r.choose('use');
      await r.until((s) => s.final === 'ok');
      expect(r.snapshot().popup?.skipped).toEqual([1]);
      expect(railRow(r.snapshot(), true)).toBe('✓ Provider ╌╌ ○ Key ╌╌ ◉ Done');
      expect(railRow(r.snapshot(), false)).toBe('ok Provider .. o Key .. @ Done');
      await r.closeDone('esc');
      await running;
      r.close();
    });

    it('`Remember this and continue without a key` ends on the same rail', async () => {
      const r = rig({ keychainDown: true });
      const running = r.coordinator.run('automatic');
      await r.choose('ack');
      await r.until((s) => s.final === 'ok');
      expect(railRow(r.snapshot(), true)).toBe('✓ Provider ╌╌ ○ Key ╌╌ ◉ Done');
      expect(railRow(r.snapshot(), false)).toBe('ok Provider .. o Key .. @ Done');
      await r.closeDone('esc');
      await running;
      r.close();
    });

    it('a key that was entered ticks the key step, checked or saved without a check (`Save it anyway`)', async () => {
      for (const check of [OK, NETWORK]) {
        const r = rig({ validate: () => Promise.resolve(check) });
        const running = r.coordinator.run('automatic');
        await r.choose('openai');
        await r.paste(SECRET);
        r.key(ENTER, '\r');
        if (!check.ok) await r.choose('continue');
        await r.until((s) => s.final === 'ok');
        expect(r.snapshot().popup?.skipped).toBeUndefined();
        expect(railRow(r.snapshot(), true)).toBe('✓ Provider ╌╌ ✓ Key ╌╌ ◉ Done');
        expect(railRow(r.snapshot(), false)).toBe('ok Provider .. ok Key .. @ Done');
        await r.closeDone('esc');
        await running;
        r.close();
      }
    });
  });

  describe('item 5: a write onto the file this run created is no rewrite', () => {
    it('with no config, the starter default written after a granted consent draws no rewrite notice: the run created the file and nobody changed it', async () => {
      const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-7704' }, hostStarter: true });
      const running = r.coordinator.run('automatic');
      await r.choose('use');
      await r.until((s) => s.final === 'ok');
      expect(r.rewrites, 'the consent created it; the starter rewrote only it').toEqual([
        false,
        false,
      ]);
      const text = readFileSync(r.path, 'utf8');
      expect(text).toContain('OPENAI_API_KEY');
      expect(text).toContain('default_model');
      await r.closeDone('esc');
      await running;
      r.close();
    });

    it('a config that existed before the run keeps the notice on every write', async () => {
      const r = rig({
        env: { OPENAI_API_KEY: 'synthetic-env-7705' },
        hostStarter: true,
        config: 'hand-made',
      });
      const running = r.coordinator.run('automatic');
      await r.choose('use');
      await r.until((s) => s.final === 'ok');
      expect(r.rewrites).toEqual([true, true]);
      await r.closeDone('esc');
      await running;
      r.close();
    });

    it('a config the run created and another writer changed before its next write was prepared keeps the notice', async () => {
      const r = rig({
        env: { OPENAI_API_KEY: 'synthetic-env-7706' },
        hostStarter: true,
        beforeStarter: (path) => {
          writeFileSync(path, `# a person's note\n${readFileSync(path, 'utf8')}`);
        },
      });
      const running = r.coordinator.run('automatic');
      await r.choose('use');
      await r.until((s) => s.final === 'ok');
      expect(r.rewrites).toEqual([false, true]);
      await r.closeDone('esc');
      await running;
      r.close();
    });

    it('one changed after the starter was prepared without the notice is not rewritten: the write is refused, the person’s change stays, and the Done step says the default was not saved', async () => {
      const r = rig({
        env: { OPENAI_API_KEY: 'synthetic-env-7707' },
        hostStarter: true,
        beforePublish: (index, path) => {
          if (index === 1) writeFileSync(path, `# a person's note\n${readFileSync(path, 'utf8')}`);
        },
      });
      const running = r.coordinator.run('automatic');
      await r.choose('use');
      await r.until((s) => s.final === 'ok');
      expect(r.rewrites).toEqual([false, false]);
      const text = readFileSync(r.path, 'utf8');
      expect(text).toContain("# a person's note");
      expect(text).not.toContain('default_model');
      expect(r.snapshot().details).toContain(
        'The starter default could not be saved; select a model with /models.',
      );
      await r.closeDone('esc');
      await running;
      r.close();
    });
  });

  describe('item 6: the key prompt’s validator (the legend-shaped `requireKey` is gone)', () => {
    it('a key that is only white space is refused on the field, with the field’s own sentence, and nothing is checked', async () => {
      let checks = 0;
      const r = rig({
        validate: () => {
          checks += 1;
          return Promise.resolve(OK);
        },
      });
      const running = r.coordinator.run('automatic');
      await r.choose('openai');
      await r.paste('   ');
      r.key(ENTER, '\r');
      await r.flush();
      expect(r.snapshot().kind).toBe('password');
      expect(r.snapshot().error).toBe('A valid value is required.');
      expect(checks).toBe(0);
      r.channel.flow.cancel();
      await running;
      r.close();
    });
  });
});
