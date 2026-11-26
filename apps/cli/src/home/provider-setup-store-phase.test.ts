/**
 * The store phase of the Home's provider setup popup (MVP-11 unit 6, review round 2: SE-L1, CO-1), on the REAL native channel with an injected
 * clock, the real coordinator, wizard and config writers, and a `publishPreference` that does what the Home's does (`home/drive-home.tsx`):
 * with a popup open it draws the rewrite disclosure as a note (a rewrite) or a `Saving preferences…` wait (none), waits for that frame to be
 * flushed (here: until the test releases it), then publishes with the flow's admission and the frame's visibility. Only the key check, the
 * keychain and the provider store are fakes.
 *
 * SE-L1: once the key check has answered, no wait that steps back remains: `Esc` while the key is stored or the starter default is written
 * cancels (the write is refused, the config byte for byte as it was), and the screen says what runs then, never `Checking…`.
 * CO-1: when a write of the setup actually rewrote a global config that existed (and was not the run's own), the Done step keeps ONE line that
 * says so; a config the run created, a write refused or never made, carries none.
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

import {
  globalConfigPath,
  prepareGlobalPreferences,
  type ConfigWriteResult,
  type PreparedConfigWrite,
} from '../config/write.js';
import {
  createProviderResolver,
  providerEndpointContext,
  type ProviderKeyValidation,
} from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  CONFIG_REWRITTEN_LINE,
  keyCheckText,
  keySavingText,
  SETUP_NEXT_STEP,
  STARTER_SAVING_TEXT,
} from '../onboarding/setup-notes.js';
import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import { CliError } from '../process/errors.js';
import {
  createNativePromptChannel,
  NativePromptVisibilityRefusedError,
  type NativePromptSnapshot,
} from '../render/tui/native-prompt-channel.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import type { KeychainStore } from '../secrets/keychain.js';
import { captureIo } from '../test-support.js';
import { createProviderSetupCoordinator } from './provider-setup.js';

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
const SECRET = 'synthetic-store-phase-credential-7713';
const OK: ProviderKeyValidation = { ok: true, reason: 'ok', detail: 'ok' };
const HAND_MADE = '# hand-made, keep this comment\n[preferences]\ntheme = "dark"\n';
/** The Home's disclosure of a rewrite (`home/drive-home.tsx` `publishPreference`). */
const REWRITE_NOTICE =
  'Saving preferences rewrites the global config and removes its comments and ordering.';
/** The wait the Home draws for a write that rewrites nothing (`home/drive-home.tsx` `publishPreference`). */
const SAVING_PREFERENCES = 'Saving preferences…';
/** What the key check's wait says for Anthropic (the resolver pins the official origin). */
const ANTHROPIC_CHECK = keyCheckText('Anthropic', 'https://api.anthropic.com');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Rig {
  readonly path: string;
  readonly snapshot: () => NativePromptSnapshot;
  /** What the popup showed when each config write's disclosure frame was being flushed, in order. */
  readonly flushing: readonly NativePromptSnapshot[];
  /** What the popup showed when the key reached the keychain. */
  readonly atKeychain: () => NativePromptSnapshot | undefined;
  readonly stored: Map<string, string>;
  readonly run: ReturnType<ReturnType<typeof createProviderSetupCoordinator>['run']>;
  until: (predicate: (s: NativePromptSnapshot) => boolean) => Promise<void>;
  choose: (value: string) => Promise<void>;
  submitKey: () => Promise<void>;
  /** A deliberate key on the frame on screen: shown, a moment later. */
  press: (key: Key, input?: string) => void;
  /** The flushed frame of the held disclosure is on screen: the Home's publication goes on. */
  release: () => void;
  /** Close the Done step if one is open (Enter after the settle), then wait for the run. */
  finish: () => Promise<Awaited<Rig['run']>>;
  close: () => void;
}

function rig(options: {
  readonly config: 'none' | 'hand-made' | 'symlink';
  readonly env?: Record<string, string>;
  /** Hold every disclosure frame until the test releases it (the window `Esc` must be able to reach). */
  readonly hold?: boolean;
  /** Called as publication `index` (from 0) is about to publish: another writer may change the file there. */
  readonly beforePublish?: (index: number, path: string) => void;
}): Rig {
  let clock = 10_000;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility((expected) => channel.ui.getSnapshot() === expected);
  const home = mkdtempSync(join(tmpdir(), 'relavium-store-phase-'));
  roots.push(home);
  const path = globalConfigPath(home);
  if (options.config !== 'none') {
    mkdirSync(join(home, '.relavium'), { recursive: true });
    if (options.config === 'hand-made') writeFileSync(path, HAND_MADE);
    else {
      writeFileSync(join(home, 'real.toml'), HAND_MADE);
      symlinkSync(join(home, 'real.toml'), path);
    }
  }
  const policy = createStandardEnvKeyPolicy();
  const stored = new Map<string, string>();
  let atKeychain: NativePromptSnapshot | undefined;
  const keychain: KeychainStore = {
    get: (account) => stored.get(account) ?? null,
    set: (account, value) => {
      atKeychain = channel.ui.getSnapshot();
      stored.set(account, value);
    },
    delete: (account) => stored.delete(account),
  };
  const resolver = createProviderResolver(options.env ?? {}, keychain, {
    standardEnvPolicy: policy,
  });
  const db = createClient(':memory:');
  runMigrations(db.db);
  const flushing: NativePromptSnapshot[] = [];
  let publications = 0;
  let release: () => void = () => {};
  /** The Home's `publishPreference` (`home/drive-home.tsx`), its `flushVisible` a frame flush the test can hold. */
  const publishPreference = async (
    prepared: PreparedConfigWrite,
    assertAdmitting: () => void,
  ): Promise<ConfigWriteResult> => {
    assertAdmitting();
    const native = channel.ui.getSnapshot().active;
    if (prepared.rewriteNeeded || native) {
      if (!native)
        throw new CliError(
          'output_unavailable',
          'The config rewrite notice could not be displayed.',
        );
      if (prepared.rewriteNeeded) channel.flow.note(REWRITE_NOTICE);
      else channel.flow.busy(SAVING_PREFERENCES);
      flushing.push(channel.ui.getSnapshot());
      if (options.hold === true)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    }
    const snapshot = native ? channel.ui.getSnapshot() : undefined;
    options.beforePublish?.(publications, path);
    publications += 1;
    try {
      return prepared.publish(() => {
        assertAdmitting();
        if (snapshot !== undefined) channel.ui.assertVisible(snapshot);
      });
    } catch (cause) {
      if (cause instanceof NativePromptVisibilityRefusedError) throw new Error('not visible');
      throw cause;
    }
  };
  const coordinator = createProviderSetupCoordinator({
    flow: channel.flow,
    resolver,
    policy,
    globalConfig: undefined,
    globalConfigPath: path,
    home,
    assertAdmitting: () => {},
    endpointContext: (id) => providerEndpointContext(resolver, id),
    publishPreference,
    popup: true,
    rememberSkip: true,
    wizard: {
      store: createProviderStore(db.db, { uuid: () => 'provider-id', now: () => 1 }),
      keychain,
      io: captureIo().io,
      // The Home's `writeStarterDefault`: prepared against the target, passed through the run's view of its own writes, published.
      writeDefaultModel: async (model, provider, admit, runWrite) => {
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
      validate: () => Promise.resolve(OK),
    },
  });
  const snapshot = (): NativePromptSnapshot => channel.ui.getSnapshot();
  const flush = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((r) => setImmediate(r));
  };
  const show = (): void => channel.ui.shown(channel.ui.getSnapshot());
  const run = coordinator.run('automatic');
  let settled = false;
  void run.then(
    () => (settled = true),
    () => (settled = true),
  );
  const until = async (predicate: (s: NativePromptSnapshot) => boolean): Promise<void> => {
    for (let turn = 0; turn < 400; turn += 1) {
      if (predicate(snapshot())) return;
      await new Promise<void>((r) => setImmediate(r));
    }
    throw new Error(`the popup never reached the expected state: ${JSON.stringify(snapshot())}`);
  };
  return {
    path,
    snapshot,
    flushing,
    atKeychain: () => atKeychain,
    stored,
    run,
    until,
    async choose(value) {
      await until((s) => s.kind === 'select' && s.options.some((o) => o.value === value));
      show();
      clock += POPUP_SELECT_SETTLE_MS;
      const target = snapshot().options.findIndex((o) => o.value === value);
      while (snapshot().selected !== target) {
        channel.ui.input('', snapshot().selected < target ? DOWN : UP);
        show();
      }
      clock += snapshot().options[target]?.guarded === true ? APPROVAL_LOCKOUT_MS + 100 : 10;
      channel.ui.input('\r', ENTER);
      await flush();
    },
    async submitKey() {
      await until((s) => s.kind === 'password');
      show();
      clock += POPUP_SELECT_SETTLE_MS;
      channel.ui.paste(SECRET);
      channel.ui.input('\r', ENTER);
      await flush();
    },
    press(key, input = '') {
      show();
      clock += 1;
      channel.ui.input(input, key);
    },
    release: () => release(),
    async finish() {
      for (let turn = 0; turn < 400 && !settled && snapshot().final === undefined; turn += 1)
        await new Promise<void>((r) => setImmediate(r));
      if (!settled && snapshot().final !== undefined) {
        show();
        clock += POPUP_SELECT_SETTLE_MS;
        channel.ui.input('\r', ENTER);
      }
      return await run;
    },
    close: () => db.sqlite.close(),
  };
}

describe('SE-L1: once the key check has answered, no wait steps back out of it', () => {
  it('while the key is stored the wait says so (never `Checking…`) and `Esc` there cancels, as a wait’s `Esc` always did', async () => {
    const r = rig({ config: 'none' });
    await r.choose('anthropic');
    await r.submitKey();
    const atKeychain = r.atKeychain();
    expect(atKeychain?.kind).toBe('busy');
    expect(atKeychain?.message).toBe(keySavingText('Anthropic'));
    expect(atKeychain?.message).not.toBe(ANTHROPIC_CHECK);
    expect(atKeychain?.escape, 'the stale step back of the check is gone').toBe('cancel');
    await r.finish();
    r.close();
  });

  it('a starter default that REWRITES an existing config: `Esc` while its disclosure is drawn cancels, the write is refused and the config is byte for byte as it was', async () => {
    const r = rig({ config: 'hand-made', hold: true });
    await r.choose('anthropic');
    await r.submitKey();
    await r.until(() => r.flushing.length === 1);
    const during = r.snapshot();
    expect(during.note).toBe(REWRITE_NOTICE);
    expect(during.kind).toBe('busy');
    expect(during.message, 'the screen says what runs now').toBe(STARTER_SAVING_TEXT);
    expect(during.message).not.toBe(ANTHROPIC_CHECK);
    expect(during.escape, 'Esc cancels the write it discloses').toBe('cancel');
    r.press(ESC);
    expect(r.snapshot().escape).toBe('cancel');
    r.release();
    const outcome = await r.finish();
    expect(readFileSync(r.path, 'utf8'), 'nothing was rewritten').toBe(HAND_MADE);
    // The key had been stored before the `Esc`: the host says so in its one line; nothing claims a saved default.
    expect(r.stored.size).toBe(1);
    expect(outcome).toEqual({
      status: 'ready',
      changed: true,
      notice: 'Anthropic key stored · the default was not saved',
    });
    r.close();
  });

  it('a starter default that rewrites nothing (no config yet): `Esc` during its wait cancels too, and no config is created', async () => {
    const r = rig({ config: 'none', hold: true });
    await r.choose('anthropic');
    await r.submitKey();
    await r.until(() => r.flushing.length === 1);
    expect(r.snapshot().message).toBe(SAVING_PREFERENCES);
    expect(r.snapshot().escape).toBe('cancel');
    r.press(ESC);
    r.release();
    const outcome = await r.finish();
    expect(existsSync(r.path), 'no config was created').toBe(false);
    expect(outcome.notice).toBe('Anthropic key stored · the default was not saved');
    r.close();
  });
});

describe('CO-1: the Done step keeps one line when a write rewrote a config that existed', () => {
  it('a hand-made config the key setup’s starter default rewrote: the Done step says so, once, before the next step', async () => {
    const r = rig({ config: 'hand-made' });
    await r.choose('anthropic');
    await r.submitKey();
    await r.until((s) => s.final === 'ok');
    expect(r.snapshot().details).toEqual([CONFIG_REWRITTEN_LINE, SETUP_NEXT_STEP]);
    expect(readFileSync(r.path, 'utf8')).not.toContain('# hand-made');
    await r.finish();
    r.close();
  });

  it('a hand-made config the environment-key consent rewrote: one line, though two writes rewrote it', async () => {
    const r = rig({ config: 'hand-made', env: { ANTHROPIC_API_KEY: 'synthetic-env-5521' } });
    await r.choose('use');
    await r.until((s) => s.final === 'ok');
    expect(r.flushing.map((s) => s.note)).toEqual([REWRITE_NOTICE, REWRITE_NOTICE]);
    const details = r.snapshot().details;
    expect(details.filter((line) => line === CONFIG_REWRITTEN_LINE)).toHaveLength(1);
    expect(details.at(-1)).toBe(SETUP_NEXT_STEP);
    expect(details.indexOf(CONFIG_REWRITTEN_LINE)).toBe(details.length - 2);
    await r.finish();
    r.close();
  });

  it('a config this run created carries no line (the consent created it; the starter default wrote onto the run’s own file)', async () => {
    const r = rig({ config: 'none', env: { ANTHROPIC_API_KEY: 'synthetic-env-5522' } });
    await r.choose('use');
    await r.until((s) => s.final === 'ok');
    expect(r.flushing.map((s) => s.message)).toEqual([SAVING_PREFERENCES, SAVING_PREFERENCES]);
    expect(r.snapshot().details).not.toContain(CONFIG_REWRITTEN_LINE);
    await r.finish();
    r.close();
  });

  it('a rewrite whose publication failed claims nothing: the consent’s write was refused (the file changed under it), the source was allowed for this invocation, and the Done step has no line', async () => {
    const r = rig({
      config: 'hand-made',
      env: { ANTHROPIC_API_KEY: 'synthetic-env-5523' },
      // The consent's write (a rewrite of the hand-made file) finds the file gone when it publishes: a config fault, nothing written.
      beforePublish: (index, path) => {
        if (index === 0) rmSync(path);
      },
    });
    await r.choose('use');
    await r.choose('once');
    await r.until((s) => s.final === 'ok');
    expect(r.flushing[0]?.note, 'the first write was a disclosed rewrite').toBe(REWRITE_NOTICE);
    expect(r.snapshot().details).toContain(
      'Allowed for this invocation only; the consent was not saved.',
    );
    expect(r.snapshot().details).not.toContain(CONFIG_REWRITTEN_LINE);
    await r.finish();
    r.close();
  });

  it('a write that was refused (a symbolic link) rewrote nothing: no line', async () => {
    const r = rig({ config: 'symlink' });
    await r.choose('anthropic');
    await r.submitKey();
    await r.until((s) => s.final === 'ok');
    expect(r.snapshot().details).not.toContain(CONFIG_REWRITTEN_LINE);
    expect(readFileSync(r.path, 'utf8')).toBe(HAND_MADE);
    await r.finish();
    r.close();
  });

  it('the line fits one row of the popup at 80 columns (its inner width, 66)', () => {
    expect(CONFIG_REWRITTEN_LINE.length).toBeLessThanOrEqual(66);
  });
});
