import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import type { Key } from 'ink';

import { globalConfigPath } from '../../../../config/write.js';
import {
  createProviderResolver,
  providerEndpointContext,
  type ProviderKeyValidation,
} from '../../../../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../../../../engine/standard-env-policy.js';
import { createProviderSetupCoordinator } from '../../../../home/provider-setup.js';
import {
  nativePopupFrameLines,
  nativePopupGeometry,
  PopupFrameView,
} from '../../../../popups/popup-slot.js';
import { KeychainUnavailableError, type KeychainStore } from '../../../../secrets/keychain.js';
import { captureIo } from '../../../../test-support.js';
import {
  createNativePromptChannel,
  type NativePromptSnapshot,
} from '../../native-prompt-channel.js';
import { legendStates } from '../frames.js';
import { label, type Producer, type Recorder, type StateRows } from '../golden.js';

/**
 * The legend rows and sentences of the Home's `/providers` popup and its first run (MVP-11 unit 6, 6.2; ADR-0146 §6, ADR-0148 §1, §3, §6),
 * as the overlay draws them at 80×24: every step the real provider setup coordinator draws on a channel with a manual clock (so the words are
 * the coordinator's and the wizard's, not a copy), in each journey that reaches a different step: a key checked and stored, a key saved without
 * a check, a refused key, an environment key's consent granted, a keychain that is down, and the first run skipped on a hand-made config (which
 * is not remembered, so it draws no step after the first: a skip never rewrites a config that exists).
 */
export const PROVIDERS_FLOW_PRODUCERS: readonly Producer[] = [
  {
    id: 'provider-setup-popup',
    file: 'home/provider-setup.ts',
    describe:
      'the /providers popup and the first-run setup (MVP-11 unit 6): `Which provider?` (on a first run titled `Connect a provider`, its `Esc` the skip and `[Ctrl+C]` close), the key step (`Esc back · [Ctrl+C] close`) and what it says about the key, the choices after a failed check, the environment-key consent, the keychain step, and the Done steps (`Enter / Esc close`)',
  },
];

const none: Key = {
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
const ENTER: Key = { ...none, return: true };
const ESC: Key = { ...none, escape: true };
const UP: Key = { ...none, upArrow: true };
const DOWN: Key = { ...none, downArrow: true };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The rows of one framed prompt as the overlay draws it at 80×24. */
function framedRows(snapshot: NativePromptSnapshot, color: boolean) {
  const { geometry, layout } = nativePopupGeometry(
    snapshot,
    'overlay',
    { cols: 80, rows: 24 },
    color,
  );
  if (!geometry.fits || layout === undefined || !layout.fits) throw new Error('refused');
  return nativePopupFrameLines(snapshot, geometry, layout, color);
}

function framedStates(state: string, snapshot: NativePromptSnapshot) {
  return legendStates(
    state,
    (color) => (
      <PopupFrameView
        lines={framedRows(snapshot, color)}
        color={color}
        placement="replace"
        left={0}
        top={0}
        contentRef={() => undefined}
      />
    ),
    { columns: 80 },
  );
}

type Journey = 'stored' | 'unverified' | 'refused' | 'consent' | 'keychain' | 'skipped';

const OK: ProviderKeyValidation = { ok: true, reason: 'ok', detail: 'ok' };
const NETWORK: ProviderKeyValidation = { ok: false, reason: 'network', detail: 'timeout' };
const REFUSED: ProviderKeyValidation = { ok: false, reason: 'auth', detail: 'refused' };

/** What a person answers at each step of `journey` (by what the step offers), or `undefined` when the journey ends there. */
function answerOf(journey: Journey, snapshot: NativePromptSnapshot): string | undefined {
  const offers = (value: string): boolean => snapshot.options.some((o) => o.value === value);
  if (snapshot.message === 'Which provider?') return 'anthropic';
  if (offers('use')) return 'use';
  if (offers('ack')) return 'ack';
  if (offers('recheck')) return journey === 'unverified' ? 'continue' : undefined;
  if (offers('continue')) return undefined;
  return undefined;
}

/** The keychain of a journey: one whose backend is down, or an empty one. */
function journeyKeychain(journey: Journey): KeychainStore {
  if (journey !== 'keychain') return { get: () => null, set: () => {}, delete: () => false };
  return {
    get: () => {
      throw new KeychainUnavailableError('down');
    },
    set: () => {},
    delete: () => false,
  };
}

/** What the key check of a journey answers. */
const CHECKS: Partial<Record<Journey, ProviderKeyValidation>> = {
  unverified: NETWORK,
  refused: REFUSED,
};

/** The real coordinator of a journey, over `channel`, with its home, its keychain, its environment and its check. */
function journeyCoordinator(
  journey: Journey,
  channel: ReturnType<typeof createNativePromptChannel>,
  home: string,
  db: ReturnType<typeof createClient>,
) {
  if (journey === 'skipped') {
    mkdirSync(join(home, '.relavium'), { recursive: true });
    writeFileSync(globalConfigPath(home), '# hand-made\n[preferences]\ntheme = "dark"\n');
  }
  const policy = createStandardEnvKeyPolicy();
  const resolver = createProviderResolver(
    journey === 'consent' ? { ANTHROPIC_API_KEY: 'golden-env' } : {},
    journeyKeychain(journey),
    { standardEnvPolicy: policy },
  );
  const check = CHECKS[journey] ?? OK;
  return createProviderSetupCoordinator({
    flow: channel.flow,
    resolver,
    policy,
    globalConfig: undefined,
    globalConfigPath: globalConfigPath(home),
    home,
    assertAdmitting: () => {},
    endpointContext: (id) => providerEndpointContext(resolver, id),
    publishPreference: (prepared, admit) => Promise.resolve(prepared.publish(admit)),
    popup: true,
    rememberSkip: true,
    wizard: {
      store: createProviderStore(db.db, { uuid: () => 'golden', now: () => 1 }),
      keychain: { get: () => null, set: () => {}, delete: () => false },
      io: captureIo().io,
      writeDefaultModel: () => ({ kind: 'saved', durability: 'confirmed' }),
      validate: () => Promise.resolve(check),
    },
  });
}

/** Answer the step on screen as `journey` does; `false` when the journey ends there (the flow is cancelled). */
function answerStep(
  channel: ReturnType<typeof createNativePromptChannel>,
  journey: Journey,
  now: NativePromptSnapshot,
  advance: () => void,
): boolean {
  // A Done step closes with `Esc`, and so does the skipped journey's first step (the skip itself).
  if (now.final !== undefined || journey === 'skipped') {
    channel.ui.input('', ESC);
    return true;
  }
  if (now.kind === 'password') {
    channel.ui.paste('golden-synthetic-key');
    channel.ui.input('', ENTER);
    return true;
  }
  const answer = answerOf(journey, now);
  if (answer === undefined) {
    channel.flow.cancel();
    return false;
  }
  const target = now.options.findIndex((o) => o.value === answer);
  while (channel.ui.getSnapshot().selected !== target) {
    channel.ui.input('', channel.ui.getSnapshot().selected < target ? DOWN : UP);
    channel.ui.shown(channel.ui.getSnapshot());
  }
  advance();
  channel.ui.input('', ENTER);
  return true;
}

/** Run `journey` on a channel with a manual clock, and capture each distinct step it draws (by its rail step and what it is). */
async function capture(journey: Journey): Promise<Map<string, NativePromptSnapshot>> {
  let clock = 10_000;
  const advance = (): void => {
    clock += 3000;
  };
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility(() => true);
  const home = mkdtempSync(join(tmpdir(), 'relavium-golden-providers-'));
  const db = createClient(':memory:');
  runMigrations(db.db);
  const seen = new Map<string, NativePromptSnapshot>();
  const running = journeyCoordinator(journey, channel, home, db).run('automatic');
  try {
    for (let step = 0; step < 24; step += 1) {
      await flush();
      const now = channel.ui.getSnapshot();
      if (!now.active) break;
      if (now.kind === 'busy') continue;
      const key = `${String(now.popup?.stepIndex ?? 0)} ${now.final === undefined ? now.kind : 'done'}`;
      if (!seen.has(key)) seen.set(key, now);
      channel.ui.shown(now);
      advance();
      if (!answerStep(channel, journey, now, advance)) break;
    }
    await running;
  } finally {
    channel.ui.dispose();
    db.sqlite.close();
    rmSync(home, { recursive: true, force: true });
  }
  return seen;
}

const recordProviderSetup: Recorder = async (): Promise<StateRows> => {
  const states: Record<string, readonly string[]> = {};
  for (const journey of [
    'stored',
    'unverified',
    'refused',
    'consent',
    'keychain',
    'skipped',
  ] as const)
    for (const [step, snapshot] of await capture(journey))
      Object.assign(states, framedStates(label({ journey, step }), snapshot));
  return states;
};

export const PROVIDERS_FLOW_RECORDERS: Readonly<Record<string, Recorder>> = {
  'provider-setup-popup': recordProviderSetup,
};
