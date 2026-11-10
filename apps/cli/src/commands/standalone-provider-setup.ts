import type { Db, ProviderStore } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';
import { render } from 'ink';
import { createElement } from 'react';

import type { SessionChatLifetime } from '../chat/session-chat-lifetime.js';
import { SessionInkInput } from '../chat/session-ink-input.js';
import { SessionInkMount } from '../chat/session-ink-mount.js';
import { SessionTerminalOwner } from '../chat/session-terminal-owner.js';
import type { LoadedConfig } from '../config/load.js';
import { applyInvocationDefault } from '../config/invocation-default.js';
import { ConfigError } from '../config/errors.js';
import {
  ConfigWriteRefusedError,
  prepareGlobalPreferences,
  type PreparedConfigWrite,
  type ConfigWriteResult,
} from '../config/write.js';
import type { NoticeFlush } from '../engine/effect-retention.js';
import type { ProviderResolver } from '../engine/providers.js';
import type { StandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  createProviderSetupCoordinator,
  sampleProviderSetup,
  type ProviderSetupOutcome,
} from '../home/provider-setup.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { resolveRenderMode } from '../render/render-mode.js';
import {
  defaultJobControlLifecycle,
  suspendFullScreen,
  wireJobControl,
  type JobControlBinding,
  type JobControlLifecycle,
} from '../render/suspend.js';
import {
  createNativePromptChannel,
  NativePromptVisibilityRefusedError,
} from '../render/tui/native-prompt-channel.js';
import { NativePromptHost } from '../render/tui/native-prompt-host.js';
import type { KeychainStore } from '../secrets/keychain.js';

export interface StandaloneProviderSetupResult extends ProviderSetupOutcome {
  readonly ephemeralDefault?: { readonly model: string; readonly provider: ProviderId };
}
export type PrepareStandaloneProviders = (
  lifetime?: SessionChatLifetime,
  liveDb?: Db,
) => Promise<StandaloneProviderSetupResult>;

/** This mount precedes the normal chat host and borrows no ambient stream or Clack input owner. */
export async function runStandaloneProviderSetup(deps: {
  readonly lifetime: SessionChatLifetime;
  readonly loaded: LoadedConfig;
  readonly global: GlobalOptions;
  readonly io: CliIo;
  readonly resolver: ProviderResolver;
  readonly policy: StandardEnvKeyPolicy;
  readonly store: ProviderStore;
  readonly keychain: KeychainStore;
  readonly jobControlLifecycle?: JobControlLifecycle;
}): Promise<StandaloneProviderSetupResult> {
  if (
    sampleProviderSetup(deps.resolver).some(({ availability }) => availability.status === 'usable')
  )
    return { status: 'ready', changed: false };
  const { lifetime, io } = deps;
  const owner = lifetime.surface.work;
  owner.assertAdmitting();
  if (
    io.nativeStdin === undefined ||
    io.nativeStdout === undefined ||
    io.nativeStderr === undefined
  )
    throw new CliError('cli_internal', '');
  const stdin = io.nativeStdin;
  const stdout = io.nativeStdout;
  const stderr = io.nativeStderr;
  const native = createNativePromptChannel();
  const ui = native.ui;
  let setupSignal: AbortSignal | undefined;
  let finalNote: string | undefined;
  const flow = {
    ...native.flow,
    begin: () => {
      setupSignal = native.flow.begin();
      return setupSignal;
    },
    end: async () => {
      finalNote = ui.getSnapshot().note;
      await native.flow.end();
    },
  };
  let sealed = false;
  let flushVisible: NoticeFlush | undefined;
  let acknowledgeReady: () => void = () => undefined;
  let rejectReady: (cause: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    acknowledgeReady = resolve;
    rejectReady = reject;
  });
  // A renderer can fail synchronously during acquisition, before the await below is reached.
  void ready.catch(() => undefined);
  const fail = (cause: unknown): void => {
    owner.failure(cause);
    flow.cancel();
    rejectReady(cause);
  };
  const stop = (): void => {
    sealed = true;
    flow.cancel();
    try {
      owner.assertAdmitting();
    } catch (cause) {
      rejectReady(cause);
    }
  };
  const cancelled = (): void => flow.cancel();
  owner.signal.addEventListener('abort', stop, { once: true });
  const removeInterrupt = lifetime.subscribeInterrupt(cancelled);
  let mount: SessionInkMount | undefined;
  let jobOwner: SessionTerminalOwner | undefined;
  let ephemeralDefault: StandaloneProviderSetupResult['ephemeralDefault'];
  let defaultNotice: string | undefined;
  let result: ProviderSetupOutcome;
  try {
    const alternateScreen =
      resolveRenderMode({
        outputMode: 'tui',
        noAltScreenFlag: deps.global.noAltScreen === true,
        configAltScreen: deps.loaded.config.altScreen,
      }) === 'alt';
    const jobNative: { binding?: JobControlBinding } = {};
    jobOwner = new SessionTerminalOwner(lifetime.surface.invocation, owner.assertAdmitting, fail);
    const job = jobOwner.acquire((creation) => {
      creation.adopt({
        seal: () => jobNative.binding?.dispose(),
        release: () => {
          if (jobNative.binding === undefined) throw new CliError('cli_internal', '');
          return jobNative.binding.finish();
        },
      });
      return wireJobControl({
        suspendPort: lifetime.suspendPort,
        lifecycle: deps.jobControlLifecycle ?? defaultJobControlLifecycle,
        adopt: (binding) => {
          jobNative.binding = binding;
        },
        onFailure: owner.cleanupUncertain,
        run: (suspendTerminal, waitForContinue) =>
          suspendFullScreen(
            {
              suspendTerminal,
              writeControl: (text) => io.writeOutAcknowledged(text),
              inkOwnsAltScreen: true,
              altActive: alternateScreen,
              mouseActive: false,
            },
            waitForContinue,
          ),
      });
    });
    mount = new SessionInkMount({
      invocation: lifetime.surface.invocation,
      assertEntering: owner.assertAdmitting,
      failure: fail,
      suspendPort: lifetime.suspendPort,
      stopInput: () => {
        sealed = true;
        flow.cancel();
      },
      drainNative: job.finish,
      input: new SessionInkInput({
        input: stdin,
        invocation: lifetime.surface.invocation,
        failure: fail,
        acknowledge: (text) => io.writeOutAcknowledged(text),
      }),
    });
    mount.acquire(() =>
      render(
        createElement(NativePromptHost, {
          ui,
          color: deps.global.color,
          inputEnabled: () => !sealed,
          suspendPort: mount?.port,
          onSuspend: job.requestSuspend,
          onRendererReady: (flush: NoticeFlush) => {
            flushVisible = flush;
            acknowledgeReady();
          },
          onRendererError: (cause) => fail(new CliError('output_unavailable', '', { cause })),
        }),
        {
          stdin,
          stdout,
          stderr,
          interactive: true,
          alternateScreen,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      ),
    );
    void mount.exited.then(() => {
      if (!sealed) fail(new CliError('cli_internal', ''));
    }, fail);
    await ready;
    owner.assertAdmitting();
    const publish = async (
      prepared: PreparedConfigWrite,
      assertAdmitting: () => void,
    ): Promise<ConfigWriteResult> => {
      assertAdmitting();
      if (!prepared.rewriteNeeded) return prepared.publish(assertAdmitting);
      flow.note(
        'Saving preferences rewrites the global config and removes its comments and ordering.',
      );
      const notice = ui.getSnapshot();
      if (flushVisible === undefined) throw new CliError('cli_internal', '');
      for (;;) {
        try {
          await flushVisible();
        } catch (cause) {
          // Geometry/visibility waits abort with the setup flow; cancellation is not output failure.
          setupSignal?.throwIfAborted();
          throw new CliError('output_unavailable', '', { cause });
        }
        const assertPublication = (): void => {
          assertAdmitting();
          ui.assertVisible(notice);
        };
        try {
          // The writer repeats this exact-card check immediately before rename as well as entry.
          return prepared.publish(assertPublication);
        } catch (cause) {
          if (!(cause instanceof NativePromptVisibilityRefusedError)) throw cause;
          assertAdmitting();
          // A resize/suspend race invalidated the ACK. Wait for the same card to become visible again.
        }
      }
    };
    const coordinator = createProviderSetupCoordinator({
      flow,
      resolver: deps.resolver,
      policy: deps.policy,
      globalConfig: deps.loaded.globalConfig,
      globalConfigPath: deps.loaded.globalConfigPath,
      globalConfigIsDefault: deps.global.configPath === undefined,
      home: deps.loaded.homeDir,
      assertAdmitting: owner.assertAdmitting,
      credentialSurface: 'standalone-chat',
      endpointContext: (id) =>
        deps.resolver.endpointKind?.(id) === 'custom'
          ? 'This key will be sent to the configured custom endpoint.'
          : 'This key will be sent to the official provider endpoint.',
      publishPreference: publish,
      wizard: {
        store: deps.store,
        keychain: deps.keychain,
        io,
        workOwner: owner,
        writeDefaultModel: async (model, provider, admit) => {
          const assertAdmitting = (): void => {
            owner.assertAdmitting();
            setupSignal?.throwIfAborted();
            admit?.();
          };
          for (;;) {
            try {
              assertAdmitting();
              const saved = await publish(
                prepareGlobalPreferences(
                  { defaultModel: model, defaultProvider: provider },
                  deps.loaded.homeDir,
                  deps.global.configPath === undefined ? undefined : deps.loaded.globalConfigPath,
                ),
                assertAdmitting,
              );
              defaultNotice =
                saved.durability === 'unconfirmed'
                  ? 'Default saved, but persistence after a crash is unconfirmed.'
                  : 'Starter default saved. Project settings may override it.';
              return { kind: 'saved', durability: saved.durability };
            } catch (cause) {
              assertAdmitting();
              if (!(cause instanceof ConfigError) && !(cause instanceof ConfigWriteRefusedError))
                throw cause;
              const refused = cause instanceof ConfigWriteRefusedError;
              flow.note(
                refused
                  ? 'Config is a symbolic link. Edit it manually or replace it with a regular file.'
                  : 'Provider source is ready, but the default could not be saved.',
              );
              const choice = await flow.select({
                message: 'How would you like to continue?',
                options: [
                  ...(refused ? [] : [{ value: 'retry', label: 'Retry saving' }]),
                  { value: 'once', label: 'Use this model for this invocation only' },
                  { value: 'cancel', label: 'Cancel' },
                ],
              });
              if (choice === 'retry') continue;
              if (choice === 'once') {
                assertAdmitting();
                ephemeralDefault = { model, provider };
                defaultNotice = 'Default applies to this invocation only; it was not saved.';
                flow.note(defaultNotice);
                return { kind: 'ephemeral' };
              }
              flow.cancel();
              return { kind: 'cancelled' };
            }
          }
        },
      },
    });
    result = await coordinator.run('automatic');
  } finally {
    sealed = true;
    flow.cancel();
    const closing = [mount?.close() ?? Promise.resolve(), jobOwner?.close() ?? Promise.resolve()];
    await Promise.all(closing);
    ui.dispose();
    removeInterrupt();
    owner.signal.removeEventListener('abort', stop);
  }
  const notice = [
    ...new Set(
      [result.notice, defaultNotice, finalNote].filter((part) => part !== undefined && part !== ''),
    ),
  ].join(' ');
  if (notice !== '') {
    owner.assertAdmitting();
    await io.writeErrAcknowledged(`${notice}\n`);
  }
  return { ...result, ...(ephemeralDefault === undefined ? {} : { ephemeralDefault }) };
}

/** Shared model precedence with Home; provider-source authority is independent. */
export const applyStandaloneDefault = applyInvocationDefault;
