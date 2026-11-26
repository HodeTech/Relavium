import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createProviderStore, runMigrations } from '@relavium/db';

import { globalConfigPath } from '../../../config/write.js';
import {
  createProviderResolver,
  providerEndpointContext,
  type ProviderKeyValidation,
  type ProviderResolver,
} from '../../../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../../../engine/standard-env-policy.js';
import { createProviderSetupCoordinator } from '../../../home/provider-setup.js';
import { POPUP_SELECT_SETTLE_MS } from '../../../popups/opening-guard.js';
import { KeychainUnavailableError, type KeychainStore } from '../../../secrets/keychain.js';
import { captureIo } from '../../../test-support.js';
import { bracketed } from '../harness-util.js';
import { KEYS, type HomeMount, type NativePromptChannel } from './home-host.js';
import { pinnedNativePopupBox, recordNativePopups } from './native-popup-recorder.js';
import { recordBaseline } from './popup-fixture.js';
import type { PopupBox } from './properties.js';
import type { HomeSurface } from './surface-types.js';
import type { Variant } from './variants.js';

/**
 * The Home's `/providers` POPUP and its first run (MVP-11 unit 6, 6.2; ADR-0146 §6, ADR-0148 §1), in each of its states: the first run's first
 * step (`skip for now`), the explicit list, the key step under a long custom endpoint, the consent to an environment key, the card of an
 * unavailable keychain, the choices after a refused key, and the Done step. Each is the REAL provider setup coordinator, drawn as the popup the
 * Home draws (`popup: true`), on the channel the Home wires, over a scripted resolver, keychain and key check (nothing leaves the machine, and
 * nothing is written outside a temporary directory). Each is checked as every popup is: its box from the slot's own geometry over the snapshot
 * the channel shows NOW, the overlay layer, the dimmed backdrop, and its legend row whole on one row.
 */

/** The channel of the cell that is open now: the popup box is computed from what it shows (cells run one after another). */
let current: NativePromptChannel | undefined;

function channelOf(m: HomeMount): NativePromptChannel {
  if (m.channel === undefined) throw new Error('the surface needs a native prompt channel');
  current = m.channel;
  recordNativePopups(m.channel);
  return m.channel;
}

/** Whether the prompt on the channel now is the frame on the terminal, measured and flushed. */
function shownOn(channel: NativePromptChannel): boolean {
  try {
    channel.ui.assertVisible(channel.ui.getSnapshot());
    return true;
  } catch {
    return false;
  }
}

/** A flow left running: the matrix never finishes it, and a rejection when the channel is disposed must not be unhandled. */
const leave = (running: Promise<unknown>): void => {
  running.catch(() => undefined);
};

/** Past the popup's opening settle (real time: the channel's clock is the process's), so an answer counts. */
const settled = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, POPUP_SELECT_SETTLE_MS + 100));

/** Where the framed prompt the channel shows now is drawn in a cell, and its rows: the slot's own geometry and frame lines over it, pinned as the flow's earlier steps left it (`native-popup-recorder.ts`). */
export function liveProviderPopupBox(variant: Variant): PopupBox {
  if (current === undefined) throw new Error('no flow is open');
  return pinnedNativePopupBox(current, current.ui.getSnapshot(), variant);
}

const EMPTY_KEYCHAIN: KeychainStore = { get: () => null, set: () => {}, delete: () => false };
const DOWN_KEYCHAIN: KeychainStore = {
  ...EMPTY_KEYCHAIN,
  get: () => {
    throw new KeychainUnavailableError('the keychain is unavailable');
  },
};
const REFUSED: ProviderKeyValidation = {
  ok: false,
  reason: 'auth',
  detail: 'key test failed — the provider refused the key',
};
const CHECKED: ProviderKeyValidation = { ok: true, reason: 'ok', detail: 'key works' };
/** A stored custom endpoint whose origin is long: the key step's disclosure wraps whole, never cut (ADR-0146 §6). */
const LONG_ORIGIN = 'https://inference-gateway.eu-central-1.example-enterprise-cloud.internal:8443';

interface ProviderScript {
  /** `explicit` is `/providers`; `automatic` is the first-run setup. */
  readonly mode: 'explicit' | 'automatic';
  readonly env?: Readonly<Record<string, string>>;
  readonly keychain?: 'empty' | 'unavailable';
  readonly check?: ProviderKeyValidation;
  /** Every provider's adapter pinned to {@link LONG_ORIGIN} (a stored custom endpoint). */
  readonly customEndpoint?: boolean;
}

/** Open the setup popup over the channel, over a temporary operator home that is removed when the cell ends. */
function openProviders(m: HomeMount, script: ProviderScript): NativePromptChannel {
  const channel = channelOf(m);
  const home = mkdtempSync(join(tmpdir(), 'relavium-matrix-providers-'));
  const db = createClient(':memory:');
  runMigrations(db.db);
  m.defer(() => {
    db.sqlite.close();
    rmSync(home, { recursive: true, force: true });
  });
  const policy = createStandardEnvKeyPolicy();
  const keychain = script.keychain === 'unavailable' ? DOWN_KEYCHAIN : EMPTY_KEYCHAIN;
  const base = createProviderResolver({ ...script.env }, keychain, { standardEnvPolicy: policy });
  const resolver: ProviderResolver =
    script.customEndpoint === true
      ? { ...base, endpointContext: () => `Custom endpoint: ${LONG_ORIGIN}` }
      : base;
  const coordinator = createProviderSetupCoordinator({
    flow: channel.flow,
    resolver,
    policy,
    globalConfig: undefined,
    globalConfigPath: globalConfigPath(home),
    home,
    assertAdmitting: () => {},
    endpointContext: (id) => providerEndpointContext(resolver, id),
    publishPreference: (prepared, assertAdmitting) =>
      Promise.resolve(prepared.publish(assertAdmitting)),
    popup: true,
    rememberSkip: true,
    wizard: {
      store: createProviderStore(db.db, { uuid: () => 'matrix-provider', now: () => 1 }),
      keychain,
      io: captureIo().io,
      writeDefaultModel: () => ({ kind: 'saved', durability: 'confirmed' }),
      validate: () => Promise.resolve(script.check ?? CHECKED),
    },
  });
  leave(coordinator.run(script.mode));
  return channel;
}

/** Answer the open prompt with `Enter` once its frame is on screen and the flow's opening settle has passed. */
async function enterWhenShown(m: HomeMount, channel: NativePromptChannel): Promise<boolean> {
  // Below the floor the prompt is never on screen: the notice stays, and nothing is answered on a frame nobody sees.
  if (!(await m.until(() => shownOn(channel)))) return false;
  await settled();
  m.key(KEYS.enter);
  return true;
}

/** The key step of the first provider, its frame on screen (the key is never typed into a field nobody sees). */
async function toKeyStep(
  m: HomeMount,
  script: ProviderScript,
): Promise<NativePromptChannel | undefined> {
  const channel = openProviders(m, script);
  if (!(await enterWhenShown(m, channel))) return undefined;
  if (!(await m.until(() => channel.ui.getSnapshot().kind === 'password' && shownOn(channel))))
    return undefined;
  return channel;
}

/** A key pasted into the key step and submitted, the check answered by the script. */
async function submitKey(m: HomeMount, channel: NativePromptChannel): Promise<void> {
  m.key(bracketed('sk-ant-matrix-0000000000000000000000'));
  await m.until(() => channel.ui.getSnapshot().display !== '');
  m.key(KEYS.enter);
}

const NATIVE = { nativePrompt: true } as const;
const NOTES =
  'the body behind the popup: the empty, keyed landing; the setup is the real coordinator drawn as the Home draws it, over a scripted resolver';
const BELOW = /too small for this popup/iu;

export const PROVIDER_FLOW_SURFACES: readonly HomeSurface[] = [
  {
    host: 'home',
    id: 'home.provider-first-run',
    title: 'The first-run setup popup’s first step (Which provider?, Esc skip for now)',
    exitKey: 'Esc',
    landmark: 'Which provider?',
    selectedRow: 'Anthropic',
    legendRow: '↑/↓ select · Enter choose · Esc back · [Ctrl+C] close',
    belowFloor: BELOW,
    popup: liveProviderPopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      const channel = openProviders(m, { mode: 'automatic' });
      await m.until(() => shownOn(channel));
    },
  },
  {
    host: 'home',
    id: 'home.native-provider-list',
    title: 'The /providers popup’s list of providers',
    exitKey: 'Esc',
    landmark: 'Which provider?',
    selectedRow: 'Anthropic',
    legendRow: '↑/↓ select · Enter choose · Esc close',
    belowFloor: BELOW,
    popup: liveProviderPopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      const channel = openProviders(m, { mode: 'explicit' });
      await m.until(() => shownOn(channel));
    },
  },
  {
    host: 'home',
    id: 'home.native-key-step',
    title:
      'The setup popup’s key step (a masked field), under a long custom endpoint that wraps whole',
    exitKey: 'Esc',
    landmark: 'Stored in your OS keychain',
    legendRow: 'Enter check · Esc back · [Ctrl+C] close',
    belowFloor: BELOW,
    popup: liveProviderPopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      await toKeyStep(m, { mode: 'automatic', customEndpoint: true });
    },
  },
  {
    host: 'home',
    id: 'home.native-env-consent',
    title:
      'The setup popup’s consent to use a key found in the environment (Use it guarded, on Not now)',
    exitKey: 'Esc',
    landmark: 'OPENAI_API_KEY is set for OpenAI.',
    selectedRow: 'Not now',
    legendRow: '↑/↓ select · Enter choose · Esc back · [Ctrl+C] close',
    belowFloor: BELOW,
    popup: liveProviderPopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      const channel = openProviders(m, {
        mode: 'automatic',
        env: { OPENAI_API_KEY: 'sk-matrix-0000' },
      });
      await m.until(() => shownOn(channel));
    },
  },
  {
    host: 'home',
    id: 'home.native-keychain-card',
    title: 'The setup popup’s step for an unavailable keychain (the variable named once)',
    exitKey: 'Esc',
    landmark: 'Retry keychain',
    selectedRow: 'Retry keychain',
    legendRow: '↑/↓ select · Enter choose · Esc back · [Ctrl+C] close',
    belowFloor: BELOW,
    popup: liveProviderPopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      const channel = openProviders(m, { mode: 'automatic', keychain: 'unavailable' });
      await m.until(() => shownOn(channel));
    },
  },
  {
    host: 'home',
    id: 'home.native-failed-check-card',
    title:
      'The setup popup’s choices after a key the provider refused (Save it anyway never pre-selected)',
    exitKey: 'Esc',
    landmark: "Couldn't verify your Anthropic key",
    selectedRow: 'Enter a different key',
    legendRow: '↑/↓ select · Enter choose · Esc back · [Ctrl+C] close',
    belowFloor: BELOW,
    popup: liveProviderPopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      const channel = await toKeyStep(m, { mode: 'automatic', check: REFUSED });
      if (channel === undefined) return;
      await submitKey(m, channel);
      await m.until(() => channel.ui.getSnapshot().kind === 'select' && shownOn(channel));
    },
  },
  {
    host: 'home',
    id: 'home.provider-done',
    title:
      'The setup popup’s Done step (Connected · the provider · the starter model · the next step)',
    exitKey: 'Esc',
    landmark: 'Connected · Anthropic · claude-haiku-5-5',
    legendRow: 'Enter / Esc close',
    belowFloor: BELOW,
    popup: liveProviderPopupBox,
    setup: NATIVE,
    notes: NOTES,
    open: async (m) => {
      recordBaseline(m);
      const channel = await toKeyStep(m, { mode: 'automatic' });
      if (channel === undefined) return;
      await submitKey(m, channel);
      await m.until(() => channel.ui.getSnapshot().final !== undefined && shownOn(channel));
    },
  },
];
