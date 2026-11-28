/**
 * SE-L2 (MVP-11 unit 6, review round 2): the setup run remembers the bytes ITS OWN write produced, never what a concurrent writer left in the
 * file right after that write's rename. Driven on the real coordinator, the real config writers and the real native channel; the one hook is
 * the file system's `renameSync`, which lets "another writer" (an editor saving at that instant) replace the config the moment after the
 * run's rename and before the run reads it back. The run's next write onto that file must then keep its rewrite disclosure.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Called after every `renameSync` of the code under test, with the destination; set by a test, cleared after it. */
const afterRename = vi.hoisted(() => ({ hook: undefined as ((to: string) => void) | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    renameSync: (from: Fs.PathLike, to: Fs.PathLike): void => {
      actual.renameSync(from, to);
      afterRename.hook?.(String(to));
    },
  };
});

import {
  globalConfigPath,
  prepareGlobalPreferences,
  type ConfigWriteResult,
  type PreparedConfigWrite,
} from '../config/write.js';
import { createProviderResolver, providerEndpointContext } from '../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
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
const OTHER_WRITER = '# saved by an editor at that very instant\n[preferences]\ntheme = "light"\n';

const roots: string[] = [];
afterEach(() => {
  afterRename.hook = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The environment-key consent's two writes on a first run with no config: the consent CREATES the global config, then the starter default is
 * written onto it. `race` makes another writer land right after the first write's rename. Returns whether each write reached the host needing
 * the rewrite disclosure, and the file at the end.
 */
async function consentWrites(race: boolean): Promise<{
  readonly rewrites: readonly boolean[];
  readonly file: string;
}> {
  let clock = 10_000;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility((expected) => channel.ui.getSnapshot() === expected);
  const home = mkdtempSync(join(tmpdir(), 'relavium-run-writes-'));
  roots.push(home);
  const path = globalConfigPath(home);
  const policy = createStandardEnvKeyPolicy();
  const keychain = {
    get: () => null,
    set: () => undefined,
    delete: () => false,
  };
  const resolver = createProviderResolver({ ANTHROPIC_API_KEY: 'synthetic-env-3301' }, keychain, {
    standardEnvPolicy: policy,
  });
  const db = createClient(':memory:');
  runMigrations(db.db);
  const rewrites: boolean[] = [];
  let renames = 0;
  if (race)
    afterRename.hook = (to) => {
      if (to !== path) return;
      renames += 1;
      // Only the FIRST write (the consent, which created the file) is raced.
      if (renames === 1) writeFileSync(path, OTHER_WRITER);
    };
  const publishPreference = (
    prepared: PreparedConfigWrite,
    admit: () => void,
  ): Promise<ConfigWriteResult> => {
    rewrites.push(prepared.rewriteNeeded);
    return Promise.resolve(prepared.publish(admit));
  };
  const running = createProviderSetupCoordinator({
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
      validate: () => Promise.resolve({ ok: true, reason: 'ok', detail: 'ok' }),
    },
  }).run('automatic');
  const turn = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
  for (let at = 0; at < 400 && channel.ui.getSnapshot().kind !== 'select'; at += 1) await turn();
  // The consent opens on `Not now`; `Use it` is the guarded first row: highlighted, shown, past its lockout, `Enter` once.
  channel.ui.shown(channel.ui.getSnapshot());
  clock += POPUP_SELECT_SETTLE_MS;
  while (channel.ui.getSnapshot().selected > 0) {
    channel.ui.input('', { ...NONE, upArrow: true });
    channel.ui.shown(channel.ui.getSnapshot());
  }
  clock += APPROVAL_LOCKOUT_MS + 100;
  channel.ui.input('\r', { ...NONE, return: true });
  for (let at = 0; at < 400 && channel.ui.getSnapshot().final === undefined; at += 1) await turn();
  channel.ui.shown(channel.ui.getSnapshot());
  clock += POPUP_SELECT_SETTLE_MS;
  channel.ui.input('\r', { ...NONE, return: true });
  await running;
  db.sqlite.close();
  return { rewrites, file: readFileSync(path, 'utf8') };
}

describe('SE-L2: the run remembers the bytes its own write produced', () => {
  it('a config the run created and nobody touched: its later write draws no rewrite disclosure (the run’s own file)', async () => {
    const { rewrites } = await consentWrites(false);
    expect(rewrites).toEqual([false, false]);
  });

  it('another writer landing between the run’s rename and its read-back is never adopted as the run’s own: the next write keeps the disclosure', async () => {
    const { rewrites, file } = await consentWrites(true);
    expect(rewrites, 'the starter default onto a file someone else wrote is disclosed').toEqual([
      false,
      true,
    ]);
    expect(file).toContain('default_model');
  });
});
