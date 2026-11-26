/**
 * The `/providers` POPUP of the Home and its first run (MVP-11 unit 6, 6.2; ADR-0146 §6, ADR-0148 §1, §3, §6), driven on the REAL native channel
 * with an injected clock and the real provider setup coordinator, wizard and config writers (only the key check, the keychain and the store are
 * fakes): the rail and its words, `Esc` back and `skip for now`, the Done step, the remembered skip, the guarded consent that a held `Enter`
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

import { globalConfigPath } from '../config/write.js';
import {
  createProviderResolver,
  providerEndpointContext,
  type ProviderKeyValidation,
  type ProviderResolver,
} from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  keyCheckText,
  keyStepNote,
  SETUP_SKIP_NOT_SAVED,
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
import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import { scrubPopupText } from '../popups/popup-text.js';
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
  PROVIDER_STEP_NAMES,
  PROVIDERS_POPUP_TITLE,
  type ProviderSetupOutcome,
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
    readonly validate?: () => Promise<ProviderKeyValidation>;
    readonly keychainDown?: boolean;
    readonly resolver?: (resolver: ProviderResolver) => ProviderResolver;
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
  const keychain = memoryKeychain(options.keychainDown === true);
  const base = createProviderResolver(options.env ?? {}, keychain, { standardEnvPolicy: policy });
  const resolver = options.resolver?.(base) ?? base;
  const db = createClient(':memory:');
  runMigrations(db.db);
  const written: Array<readonly [string, string]> = [];
  const coordinator = createProviderSetupCoordinator({
    flow: channel.flow,
    resolver,
    policy,
    globalConfig: undefined,
    globalConfigPath: path,
    home,
    assertAdmitting: () => {},
    endpointContext: (id) => providerEndpointContext(resolver, id),
    publishPreference: (prepared, admit) => Promise.resolve(prepared.publish(admit)),
    popup: true,
    rememberSkip: true,
    wizard: {
      store: createProviderStore(db.db, { uuid: () => 'provider-id', now: () => 1 }),
      keychain,
      io: captureIo().io,
      writeDefaultModel: (model, provider) => {
        written.push([model, provider]);
        return { kind: 'saved', durability: 'confirmed' };
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
    published,
    snapshot,
    flush,
    advance: (ms: number): void => {
      clock += ms;
    },
    /** The frame on screen now was measured and flushed (the live host's acknowledgement). */
    show: (): void => channel.ui.shown(channel.ui.getSnapshot()),
    key: (key: Key, input = ''): boolean => channel.ui.input(input, key),
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
  it('the automatic first run is the `/providers` popup, from the Home, on `Provider · Key · Done`, its first step’s way back `skip for now`', async () => {
    const r = rig();
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.message === 'Which provider?');
    expect(r.snapshot().popup).toEqual({
      title: PROVIDERS_POPUP_TITLE,
      origin: 'home',
      stepIndex: 0,
      stepCount: 3,
      stepNames: PROVIDER_STEP_NAMES,
      exitLabel: 'skip for now',
      depth: 1,
    });
    expect(PROVIDER_STEP_NAMES).toEqual(['Provider', 'Key', 'Done']);
    expect(r.snapshot().escape, 'Esc on the first step is the way out').toBe('cancel');
    r.channel.flow.cancel();
    await running;
    r.close();
  });

  it('an explicit `/providers` closes with `close`, and `Esc` on a prompt reached from its list steps back to the list', async () => {
    const r = rig({ env: { OPENAI_API_KEY: 'synthetic-env-1101' } });
    const running = r.coordinator.run('explicit');
    await r.until((s) => s.message === 'Which provider?');
    expect(r.snapshot().popup?.exitLabel).toBe('close');
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
});

describe('the key step (ADR-0146 §6, G20) and its secret, inside the frame', () => {
  it('says where the key is kept and where it goes, discloses the check, never shows the key, clears it on a resize and on a step back, and ends in Done', async () => {
    const r = rig();
    const running = r.coordinator.run('automatic');
    await r.choose('openai');
    await r.until((s) => s.kind === 'password');
    expect(r.snapshot().popup).toMatchObject({ stepIndex: 1, exitLabel: 'close' });
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

describe('a skip of the first run is remembered (ADR-0146 §6, ruled 2026-11-24)', () => {
  it('with no config: `Esc` on the first step writes the skip with no card, and the host says it in one notification', async () => {
    const r = rig();
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.message === 'Which provider?');
    r.key(ESC);
    const outcome = await running;
    expect(outcome).toMatchObject({ status: 'cancelled', notice: setupSkippedNotice('home') });
    expect(readFileSync(r.path, 'utf8')).toBe('[preferences]\nfirst_run_setup_skipped = true\n');
    expect(setupSkippedNotice('home').length, 'a notification fits 54 columns').toBeLessThanOrEqual(
      54,
    );
    r.close();
  });

  it('on a hand-made config: the popup opens again with the rewrite disclosure, publishes, and ends in a Done step instead of a notification', async () => {
    const r = rig({ config: 'hand-made' });
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.message === 'Which provider?');
    r.key(ESC);
    await r.until((s) => s.final === 'ok' && s.message === 'Setup skipped');
    expect(readFileSync(r.path, 'utf8')).toContain('first_run_setup_skipped = true');
    expect(r.snapshot().details).toEqual([
      'It will not open by itself again. /providers connects a provider any time.',
    ]);
    await r.closeDone('esc');
    const outcome: ProviderSetupOutcome = await running;
    expect(outcome.notice, 'the Done step said it').toBeUndefined();
    r.close();
  });

  it('a skip whose write is refused (a symbolic link) is the one “not saved” notification, and nothing is written through the link', async () => {
    const r = rig({ config: 'symlink' });
    const running = r.coordinator.run('automatic');
    await r.until((s) => s.message === 'Which provider?');
    r.key(ESC);
    expect((await running).notice).toBe(SETUP_SKIP_NOT_SAVED);
    expect(SETUP_SKIP_NOT_SAVED.length).toBeLessThanOrEqual(54);
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

  it('`Ctrl+C` at the key step is a cancel: not remembered, though a keyless first run still says it was skipped', async () => {
    const r = rig();
    const running = r.coordinator.run('automatic');
    await r.choose('deepseek');
    await r.paste(SECRET);
    r.key({ ...NONE, ctrl: true }, 'c');
    expect((await running).notice).toBe(setupSkippedNotice('home'));
    expect(existsSync(r.path)).toBe(false);
    r.close();
  });

  it('an explicit `/providers` closed while keyless is no remembered skip', async () => {
    const r = rig();
    const running = r.coordinator.run('explicit');
    await r.until((s) => s.message === 'Which provider?');
    r.key(ESC);
    expect((await running).notice).toBe(setupSkippedNotice('home'));
    expect(existsSync(r.path)).toBe(false);
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
    expect(consent.popup?.exitLabel).toBe('skip for now');
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
    expect(card.popup).toMatchObject({ stepIndex: 0, exitLabel: 'skip for now' });
    await r.choose('ack');
    await r.until((s) => s.final === 'ok');
    expect(r.snapshot().message).toBe('Remembered · the OS keychain is unavailable');
    await r.closeDone('esc');
    expect((await running).status).toBe('deferred');
    expect(readFileSync(r.path, 'utf8')).toContain('keychain_unavailable_acknowledged = true');
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
