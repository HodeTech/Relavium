import type { Db, ProviderStore } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';
import type { SessionChatLifetime } from '../chat/session-chat-lifetime.js';
import type { LoadedConfig } from '../config/load.js';
import { applyInvocationDefault } from '../config/invocation-default.js';
import { ConfigError } from '../config/errors.js';
import {
  ConfigWriteRefusedError,
  prepareGlobalPreferences,
  type PreparedConfigWrite,
  type ConfigWriteResult,
} from '../config/write.js';
import { providerEndpointContext, type ProviderResolver } from '../engine/providers.js';
import type { StandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  createProviderSetupCoordinator,
  sampleProviderSetup,
  type ProviderSetupOutcome,
} from '../home/provider-setup.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { JobControlLifecycle } from '../render/suspend.js';
import { NativePromptVisibilityRefusedError } from '../render/tui/native-prompt-channel.js';
import type { KeychainStore } from '../secrets/keychain.js';
import { runStandaloneNativeFlow } from './standalone-native-flow.js';

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
  const { lifetime, io } = deps;
  const owner = lifetime.surface.work;
  owner.assertAdmitting();
  if (
    sampleProviderSetup(deps.resolver).some(({ availability }) => availability.status === 'usable')
  )
    return { status: 'ready', changed: false };
  let setupSignal: AbortSignal | undefined;
  let finalNote: string | undefined;
  let ephemeralDefault: StandaloneProviderSetupResult['ephemeralDefault'];
  let defaultNotice: string | undefined;
  const result = await runStandaloneNativeFlow(
    {
      lifetime,
      io,
      global: deps.global,
      altScreen: deps.loaded.config.altScreen,
      ...(deps.jobControlLifecycle === undefined
        ? {}
        : { jobControlLifecycle: deps.jobControlLifecycle }),
    },
    async ({ ui, flow: nativeFlow, flushVisible }) => {
      const flow = {
        ...nativeFlow,
        begin: () => {
          setupSignal = nativeFlow.begin();
          return setupSignal;
        },
        end: async () => {
          finalNote = ui.getSnapshot().note;
          await nativeFlow.end();
        },
      };
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
        endpointContext: (id) => providerEndpointContext(deps.resolver, id),
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
      return await coordinator.run('automatic');
    },
  );
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
