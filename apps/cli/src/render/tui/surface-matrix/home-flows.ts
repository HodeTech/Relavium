import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderStore, SessionPage } from '@relavium/db';

import { runModeSettings } from '../../../chat/mode-settings.js';
import { createStartingModeRuntime } from '../../../chat/starting-mode.js';
import { loadResolvedConfig } from '../../../config/load.js';
import { globalConfigPath } from '../../../config/write.js';
import { createProviderResolver, type ProviderKeyValidation } from '../../../engine/providers.js';
import { createStandardEnvKeyPolicy } from '../../../engine/standard-env-policy.js';
import { runHomeProjectInit } from '../../../home/project-init.js';
import { createProviderSetupCoordinator } from '../../../home/provider-setup.js';
import { runSessionPicker } from '../../../home/session-picker.js';
import { displayRoots } from '../../display-roots.js';
import { KeychainUnavailableError, type KeychainStore } from '../../../secrets/keychain.js';
import { captureIo } from '../../../test-support.js';
import { runExportCard, type ExportPort } from '../export-card.js';
import { runImportCard, type ImportPort } from '../import-card.js';
import { runPricingCard, type PricingPort } from '../pricing-card.js';
import type { HomeMount, NativePromptChannel } from './home-host.js';

/**
 * The real flows the Home asks its native prompt channel for, run over the channel the matrix mounted, with scripted ports (nothing is
 * written outside a temporary directory, nothing reaches a network or the keychain). The card a person sees is the card the flow draws.
 */

/** What a flow needs of the host it runs over: the channel, and a place to register what to close afterwards. Both chat hosts and the Home have it. */
export interface FlowHost {
  readonly channel: NativePromptChannel | undefined;
  defer: (cleanup: () => void) => void;
}

function channelOf(m: FlowHost): NativePromptChannel {
  if (m.channel === undefined) throw new Error('the surface needs a native prompt channel');
  return m.channel;
}

/** A temporary operator home and project directory, removed when the cell ends. */
function temporaryHome(m: FlowHost): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'relavium-matrix-'));
  const home = join(root, 'home');
  const cwd = join(home, 'project');
  mkdirSync(cwd, { recursive: true });
  m.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return { home, cwd };
}

/** A flow left running: the matrix never awaits it, so a rejection (the channel is disposed at the end) must not be unhandled. */
const leave = (running: Promise<unknown>): void => {
  running.catch(() => undefined);
};

/** `/init`: the note of what will be created and the question that asks. */
export function openInitCard(m: HomeMount): void {
  const { home, cwd } = temporaryHome(m);
  const channel = channelOf(m);
  leave(
    runHomeProjectInit({
      cwd,
      home,
      flow: channel.flow,
      ui: channel.ui,
      flushVisible: () => Promise.resolve(),
      assertAdmitting: () => {},
    }),
  );
}

/** `/mode`: the startup-default flow's first question, over a temporary home and a real config read. */
export function openModeFlow(m: FlowHost): void {
  const { home, cwd } = temporaryHome(m);
  const runtime = createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true);
  leave(
    runModeSettings({
      runtime,
      cwd,
      interactive: true,
      flow: channelOf(m).flow,
      notice: () => {},
      assertAdmitting: () => {},
      publish: (prepared, assertAdmitting) => prepared.publish(assertAdmitting),
    }),
  );
}

const IMPORT_PORT: ImportPort = {
  pathIssue: () => undefined,
  prepare: () => ({
    ok: true,
    offer: {
      kind: 'workflow',
      slug: 'nightly-report',
      source: 'shared/nightly-report.yaml',
      destination: '.relavium/workflows/nightly-report.yaml',
      bytes: 2048,
      warnings: ['The file names an http endpoint literally: check it before you run it.'],
    },
    commit: () => ({ ok: true, written: 'Imported nightly-report.' }),
  }),
};

/** `/import`: the path field, answered, and then the chord card that shows what would be written. */
export function openImportCard(m: HomeMount): { answer: () => void } {
  leave(runImportCard({ flow: channelOf(m).flow, port: IMPORT_PORT }));
  return {
    answer: () => {
      m.key('\u001b[200~shared/nightly-report.yaml\u001b[201~');
      m.key('\r');
    },
  };
}

const EXPORT_PORT: ExportPort = {
  prepare: (slug) => ({
    ok: true,
    offer: {
      kind: 'workflow',
      slug,
      destination: `./${slug}.yaml`,
      bytes: 4096,
    },
    commit: () => ({ ok: true, written: `Wrote ./${slug}.yaml.` }),
  }),
};

/** The Defined tab's `x`: the chord card that shows where a workflow would be written. */
export function openExportCard(m: HomeMount): void {
  leave(runExportCard({ flow: channelOf(m).flow, port: EXPORT_PORT }, 'nightly-report'));
}

const PRICING_PORT: PricingPort = {
  models: () => [
    { modelId: 'claude-sonnet-4-5', provider: 'anthropic', hint: 'catalog: $3 / $15 per M' },
    { modelId: 'gpt-5', provider: 'openai', hint: 'no price' },
  ],
  providers: () => ['anthropic', 'openai'],
  providerName: (slug) => (slug === 'openai' ? 'OpenAI' : 'Anthropic'),
  prepare: () => ({ ok: false, reason: 'The matrix writes nothing.' }),
};

/** `/pricing`: the form's first question. */
export function openPricingCard(m: HomeMount): void {
  leave(runPricingCard({ flow: channelOf(m).flow, port: PRICING_PORT }));
}

/** `/resume`: the session picker over a store that holds a few conversations. */
export function openResumePicker(m: HomeMount): void {
  const page: SessionPage = {
    sessions: [
      {
        id: 's1',
        title: 'Fix the flaky test',
        agentSlug: 'chat',
        updatedAt: '2026-11-23T00:00:00.000Z',
        workingDir: '/work/project',
      },
      {
        id: 's2',
        agentSlug: 'reviewer',
        updatedAt: '2026-11-22T00:00:00.000Z',
        workingDir: '/work/project',
      },
    ],
  };
  leave(
    runSessionPicker({
      store: { listSessionPage: () => page },
      cwd: '/work/project',
      paths: displayRoots('/work/project', '/home/ada'),
      now: () => Date.parse('2026-11-23T01:00:00.000Z'),
      assertAdmitting: () => {},
      runRead: (operation) => operation(),
      flow: channelOf(m).flow,
    }),
  );
}

// ---- the provider setup (the real coordinator over a scripted resolver, keychain and validator) ----

const NO_STORE: ProviderStore = {
  list: () => [],
  get: () => undefined,
  upsert: () => {
    throw new Error('the matrix writes no provider');
  },
  setKeychainRef: () => {},
  clearKeychainRef: () => {},
};
const EMPTY_KEYCHAIN: KeychainStore = { get: () => null, set: () => {}, delete: () => false };
const DOWN_KEYCHAIN: KeychainStore = {
  ...EMPTY_KEYCHAIN,
  get: () => {
    throw new KeychainUnavailableError('the keychain is unavailable');
  },
};
const REJECTED_KEY: ProviderKeyValidation = {
  ok: false,
  reason: 'auth',
  detail: 'key test failed — the provider refused the key',
};

export interface ProviderSetupScript {
  readonly env?: Readonly<Record<string, string>>;
  readonly keychain?: 'empty' | 'unavailable';
  /** `explicit` is `/providers`; `automatic` is the first-run setup. */
  readonly mode: 'explicit' | 'automatic';
  /** A key check that fails (the failed-check card) instead of the real probe. */
  readonly rejectKeys?: boolean;
}

/** Open the provider setup over the channel: the first card is the provider list, the env-source consent or the keychain card. */
export function openProviderSetup(m: HomeMount, script: ProviderSetupScript): void {
  const { home } = temporaryHome(m);
  const policy = createStandardEnvKeyPolicy();
  const keychain = script.keychain === 'unavailable' ? DOWN_KEYCHAIN : EMPTY_KEYCHAIN;
  const resolver = createProviderResolver({ ...script.env }, keychain, {
    standardEnvPolicy: policy,
  });
  const coordinator = createProviderSetupCoordinator({
    flow: channelOf(m).flow,
    resolver,
    policy,
    globalConfig: undefined,
    globalConfigPath: globalConfigPath(home),
    home,
    assertAdmitting: () => {},
    endpointContext: () => 'Official endpoint',
    publishPreference: (prepared, assertAdmitting) =>
      Promise.resolve(prepared.publish(assertAdmitting)),
    wizard: {
      store: NO_STORE,
      keychain,
      io: captureIo().io,
      writeDefaultModel: () => {},
      ...(script.rejectKeys === true ? { validate: () => Promise.resolve(REJECTED_KEY) } : {}),
    },
  });
  leave(coordinator.run(script.mode));
}
