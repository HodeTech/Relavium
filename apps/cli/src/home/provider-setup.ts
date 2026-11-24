import type { ProviderId } from '@relavium/llm';
import type { GlobalConfig } from '@relavium/shared';

import { ConfigError } from '../config/errors.js';
import {
  ConfigWriteRefusedError,
  globalConfigPath,
  prepareKeychainUnavailableAcknowledged,
  prepareStandardEnvKeyConsent,
  type ConfigWriteResult,
  type PreparedConfigWrite,
  type ConfigReadObserver,
} from '../config/write.js';
import {
  KNOWN_PROVIDER_IDS,
  KNOWN_PROVIDERS,
  providerKeyAvailability,
  providerKeyAvailabilityMessage,
  providerKeyEnvVar,
  providerRowHint,
  type CredentialSurface,
  type ProviderKeyAvailability,
  type ProviderResolver,
} from '../engine/providers.js';
import type { StandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import { runOnboardingWizard, type OnboardingDeps } from '../onboarding/wizard.js';
import { setupSkippedNotice } from '../onboarding/setup-notes.js';
import type { NativePromptFlow } from '../render/tui/native-prompt-channel.js';

export interface ProviderSetupDeps {
  readonly configReadObserver?: ConfigReadObserver;
  readonly flow: NativePromptFlow;
  readonly credentialSurface?: Extract<CredentialSurface, 'home' | 'standalone-chat'>;
  readonly resolver: ProviderResolver;
  readonly policy: StandardEnvKeyPolicy;
  readonly globalConfig: GlobalConfig | undefined;
  readonly globalConfigPath: string;
  /** False for an explicit --config, even when its spelling equals the canonical path. */
  readonly globalConfigIsDefault?: boolean;
  readonly home: string;
  readonly assertAdmitting: () => void;
  readonly endpointContext: (id: ProviderId) => string;
  /** Paint any rewrite notice before calling publish; return its result even after a late cancellation. */
  readonly publishPreference: (
    prepared: PreparedConfigWrite,
    assertAdmitting: () => void,
  ) => Promise<ConfigWriteResult>;
  readonly wizard: Omit<OnboardingDeps, 'native' | 'resolver' | 'initialProvider'>;
}

export interface ProviderSetupOutcome {
  readonly status: 'ready' | 'cancelled' | 'deferred' | 'incomplete';
  readonly changed: boolean;
  readonly notice?: string;
}

interface Observation {
  readonly id: ProviderId;
  readonly availability: ProviderKeyAvailability;
}
const cancelled: ProviderSetupOutcome = { status: 'cancelled', changed: false };
const SAVED_UNCONFIRMED = 'Saved, but persistence after a crash is unconfirmed.';

/** Sample only when setup opens or a user requests a retry; never poll during rendering. */
export function sampleProviderSetup(resolver: ProviderResolver): readonly Observation[] {
  return KNOWN_PROVIDER_IDS.map((id) => ({
    id,
    availability: providerKeyAvailability(resolver, id),
  }));
}

/** One coordinator per invocation; the policy and acknowledged state survive Home rebuilds. */
export function createProviderSetupCoordinator(deps: ProviderSetupDeps): {
  /**
   * `intro` is a note for the card itself (the Home passes the reason a typed draft was not kept): shown from the first row of the setup, where
   * a person who is looking at the setup can read it, and replaced by the notes of the steps that follow.
   */
  readonly run: (mode: 'automatic' | 'explicit', intro?: string) => Promise<ProviderSetupOutcome>;
} {
  let acknowledged = deps.globalConfig?.preferences?.keychain_unavailable_acknowledged === true;
  const isDefault =
    deps.globalConfigIsDefault ?? deps.globalConfigPath === globalConfigPath(deps.home);
  const targetPath = isDefault ? undefined : deps.globalConfigPath;

  const surface = deps.credentialSurface ?? 'home';

  async function run(
    mode: 'automatic' | 'explicit',
    intro?: string,
  ): Promise<ProviderSetupOutcome> {
    deps.assertAdmitting();
    let observations = sampleProviderSetup(deps.resolver);
    if (
      mode === 'automatic' &&
      observations.some(({ availability }) => availability.status === 'usable')
    ) {
      return { status: 'ready', changed: false };
    }
    const firstUsable = !observations.some(({ availability }) => availability.status === 'usable');
    const signal = deps.flow.begin();
    if (intro !== undefined) deps.flow.note(intro);
    const assertAdmitting = (): void => {
      deps.assertAdmitting();
      signal.throwIfAborted();
    };
    /**
     * A first run that ended with no key and no word of its own (`Esc`, `Ctrl+C`, a `Not now`) says that it was skipped and how to come back
     * (ADR-0146 §6). Every cancel is a skip only when nothing worked before: closing the list of a Home that already has a key skips nothing.
     */
    const skipped = (outcome: ProviderSetupOutcome): ProviderSetupOutcome =>
      firstUsable && outcome.status === 'cancelled' && outcome.notice === undefined
        ? { ...outcome, notice: setupSkippedNotice(surface) }
        : outcome;
    /**
     * A key typed while the keychain is down would be checked against the provider and then lost (G19), so every road to the key prompt
     * stops at the keychain card instead. The health is the keychain's, not one provider's, so the gate is here and not on one card: the
     * env-consent card, the usable card and the custom-endpoint note all reach the prompt through `manual`.
     */
    const keychainDown = (): boolean =>
      observations.some(({ availability }) => availability.keychainHealth === 'unavailable');
    const manual = async (id?: ProviderId): Promise<ProviderSetupOutcome> => {
      assertAdmitting();
      if (keychainDown()) {
        const target =
          id ??
          observations.find(({ availability }) => availability.keychainHealth === 'unavailable')
            ?.id;
        if (target !== undefined) return unavailable(target);
      }
      let committedNotice: string | undefined;
      const flow: NativePromptFlow = {
        ...deps.flow,
        committedNote: (message, title) => {
          committedNotice = title === undefined ? message : `${title}: ${message}`;
          if (deps.flow.committedNote !== undefined) deps.flow.committedNote(message, title);
          else deps.flow.note(message, title);
        },
      };
      await runOnboardingWizard({
        ...deps.wizard,
        resolver: deps.resolver,
        ...(id === undefined ? {} : { initialProvider: id }),
        native: {
          flow,
          signal,
          assertAdmitting,
          endpointContext: deps.endpointContext,
          selectStarterDefault: firstUsable,
          surface: deps.credentialSurface ?? 'home',
        },
      });
      if (committedNotice !== undefined)
        return { status: 'ready', changed: true, notice: committedNotice };
      return { status: signal.aborted ? 'cancelled' : 'incomplete', changed: true };
    };
    const publish = async (prepared: PreparedConfigWrite): Promise<ConfigWriteResult> =>
      deps.publishPreference(prepared, assertAdmitting);

    async function grantOutcome(id: ProviderId, notice: string): Promise<ProviderSetupOutcome> {
      if (!firstUsable || signal.aborted) return { status: 'ready', changed: true, notice };
      try {
        assertAdmitting();
        const result: unknown = await deps.wizard.writeDefaultModel(
          KNOWN_PROVIDERS[id].testModel,
          id,
          assertAdmitting,
        );
        if (typeof result === 'object' && result !== null && 'kind' in result) {
          if (result.kind === 'ephemeral')
            return {
              status: 'ready',
              changed: true,
              notice: `${notice} Starter model selected for this invocation only.`,
            };
          if (result.kind === 'cancelled')
            return {
              status: 'ready',
              changed: true,
              notice: `${notice} Starter default was not saved.`,
            };
          if (result.kind === 'saved' && 'durability' in result)
            return {
              status: 'ready',
              changed: true,
              notice: `${notice} Starter default saved${result.durability === 'unconfirmed' ? '; crash persistence is unconfirmed' : ''}. Project settings may override it.`,
            };
        }
        return {
          status: 'ready',
          changed: true,
          notice: `${notice} Check the starter model with /models.`,
        };
      } catch (err) {
        if (signal.aborted && err !== signal.reason) throw err;
        if (
          !signal.aborted &&
          !(err instanceof ConfigError) &&
          !(err instanceof ConfigWriteRefusedError)
        )
          throw err;
        return {
          status: 'ready',
          changed: true,
          notice: `${notice} Starter default could not be saved; select a model with /models.`,
        };
      }
    }

    async function consent(id: ProviderId, source: string): Promise<ProviderSetupOutcome> {
      const answer = await deps.flow.select({
        message: `${source} is available for ${KNOWN_PROVIDERS[id].displayName}. Allow this source?`,
        // The card opens on `Not now`: an Enter that was already on its way (a typed message, then Enter, then Enter again) must not grant a
        // source of credentials. The input guards that make a grant deliberate are Step 6's (ADR-0146 §6); until then the safe answer is first.
        initialValue: 'defer',
        options: [
          { value: 'use', label: 'Use it' },
          // A key typed while the keychain is down would be checked against the provider and then lost (G19), so it is not offered.
          ...(keychainDown() ? [] : [{ value: 'manual', label: 'Enter a different key' }]),
          { value: 'defer', label: 'Not now' },
        ],
      });
      if (typeof answer !== 'string' || signal.aborted) {
        deps.policy.defer(id);
        return cancelled;
      }
      if (answer === 'manual') return manual(id);
      if (answer !== 'use') {
        deps.policy.defer(id);
        return {
          status: 'deferred',
          changed: false,
          ...(firstUsable ? { notice: setupSkippedNotice(surface) } : {}),
        };
      }
      for (;;) {
        try {
          assertAdmitting();
          const result = await publish(
            prepareStandardEnvKeyConsent(id, deps.home, targetPath, deps.configReadObserver),
          );
          // The publisher resolves only after rename. Do not recheck cancellation after publication.
          deps.policy.allowForInvocation(id);
          return grantOutcome(
            id,
            result.durability === 'unconfirmed' ? SAVED_UNCONFIRMED : 'Source consent saved.',
          );
        } catch (err) {
          if (signal.aborted) {
            if (err !== signal.reason) throw err;
            deps.policy.defer(id);
            return cancelled;
          }
          if (!(err instanceof ConfigError) && !(err instanceof ConfigWriteRefusedError)) throw err;
          const refused = err instanceof ConfigWriteRefusedError;
          deps.flow.note(
            refused
              ? 'Config is a symbolic link. Edit it manually or replace the link with a regular file.'
              : 'Could not save source consent.',
          );
          const recovery = await deps.flow.select({
            message: 'How would you like to continue?',
            options: [
              ...(refused ? [] : [{ value: 'retry', label: 'Retry saving' }]),
              { value: 'once', label: 'Use for this invocation only' },
              { value: 'cancel', label: 'Cancel' },
            ],
          });
          if (typeof recovery !== 'string' || signal.aborted || recovery === 'cancel') {
            deps.policy.defer(id);
            return cancelled;
          }
          if (recovery === 'once') {
            assertAdmitting();
            deps.policy.allowForInvocation(id);
            return grantOutcome(id, 'Source allowed for this invocation only.');
          }
          if (recovery !== 'retry') return cancelled;
        }
      }
    }

    /**
     * The keychain is known to be unavailable, so a key typed now would be checked against the provider and then lost: `Enter a key` is not
     * offered (ADR-0146 §6). The way to use a key anyway is the environment variable, named once as a variable name, and what `Remember
     * this` remembers is said where it is offered.
     */
    async function unavailable(id: ProviderId): Promise<ProviderSetupOutcome> {
      for (;;) {
        const answer = await deps.flow.select({
          message:
            'The OS keychain is unavailable, so a key cannot be stored. ' +
            `To use one anyway, set ${providerKeyEnvVar(id)} in the environment before starting Relavium.`,
          options: [
            { value: 'retry', label: 'Retry keychain' },
            ...(!acknowledged
              ? [
                  {
                    value: 'ack',
                    label: 'Remember this and continue without a key',
                    hint: 'remembers in your global config that the OS keychain is unavailable',
                  },
                ]
              : []),
            { value: 'cancel', label: 'Not now' },
          ],
        });
        if (typeof answer !== 'string' || signal.aborted || answer === 'cancel') return cancelled;
        if (answer === 'retry') {
          assertAdmitting();
          observations = sampleProviderSetup(deps.resolver);
          if (observations.some(({ availability }) => availability.status === 'usable'))
            return { status: 'ready', changed: false };
          const pending = observations.find(
            ({ availability }) => availability.status === 'present-standard-not-allowed',
          );
          if (pending?.availability.status === 'present-standard-not-allowed')
            return consent(pending.id, pending.availability.source.name);
          if (!keychainDown()) return manual(id);
          deps.flow.note('The keychain is still unavailable.');
          continue;
        }
        if (answer !== 'ack' || acknowledged) return cancelled;
        try {
          assertAdmitting();
          const result = await publish(
            prepareKeychainUnavailableAcknowledged(
              true,
              deps.home,
              targetPath,
              deps.configReadObserver,
            ),
          );
          acknowledged = true;
          return {
            status: 'deferred',
            changed: true,
            notice:
              result.durability === 'unconfirmed' ? SAVED_UNCONFIRMED : 'Keychain reminder saved.',
          };
        } catch (err) {
          if (signal.aborted) {
            if (err !== signal.reason) throw err;
            return cancelled;
          }
          if (!(err instanceof ConfigError) && !(err instanceof ConfigWriteRefusedError)) throw err;
          deps.flow.note(
            err instanceof ConfigWriteRefusedError
              ? 'Config is a symbolic link. Edit it manually or replace the link with a regular file.'
              : 'Could not save the keychain reminder.',
          );
          if (err instanceof ConfigWriteRefusedError)
            return { status: 'incomplete', changed: false };
        }
      }
    }

    const attempt = async (): Promise<ProviderSetupOutcome> => {
      let chosen: Observation | undefined;
      if (mode === 'explicit') {
        const selected = await deps.flow.select({
          message: 'Providers',
          options: observations.map(({ id, availability }) => ({
            value: id,
            label: KNOWN_PROVIDERS[id].displayName,
            hint: providerRowHint(availability),
          })),
        });
        if (typeof selected !== 'string' || signal.aborted) return cancelled;
        chosen = observations.find(({ id }) => id === selected);
      } else {
        chosen = observations.find(
          ({ id, availability }) =>
            availability.status === 'present-standard-not-allowed' && !deps.policy.isDeferred(id),
        );
        if (
          chosen === undefined &&
          observations.some(
            ({ id, availability }) =>
              availability.status === 'present-standard-not-allowed' && deps.policy.isDeferred(id),
          )
        ) {
          return { status: 'deferred', changed: false };
        }
        chosen ??= observations.find(
          ({ availability }) => availability.status === 'ineligible-custom-endpoint',
        );
        chosen ??= observations.find(({ availability }) => availability.status === 'unavailable');
        chosen ??= observations[0];
      }
      if (chosen === undefined) return cancelled;
      const { id, availability } = chosen;
      if (availability.status === 'present-standard-not-allowed')
        return await consent(id, availability.source.name);
      if (availability.status === 'ineligible-custom-endpoint') {
        deps.flow.note(
          `${availability.source.name} cannot be used with the configured custom endpoint. ${deps.endpointContext(id)}`,
        );
        return await manual(id);
      }
      if (availability.status === 'unavailable') {
        if (mode === 'automatic' && acknowledged)
          return {
            status: 'deferred',
            changed: false,
            notice:
              deps.credentialSurface === 'standalone-chat'
                ? 'Keychain is unavailable. Restart this chat to retry setup.'
                : 'Keychain is unavailable. Open /providers to retry.',
          };
        return await unavailable(id);
      }
      if (availability.status === 'usable') {
        deps.flow.note(
          `${KNOWN_PROVIDERS[id].displayName}: ${providerKeyAvailabilityMessage(id, availability, deps.credentialSurface ?? 'home')} ${deps.endpointContext(id)}`,
        );
        const answer = await deps.flow.select({
          message: 'Provider action',
          options: [
            ...(keychainDown() ? [] : [{ value: 'manual', label: 'Enter a different key' }]),
            { value: 'cancel', label: 'Done' },
          ],
        });
        return answer === 'manual' && !signal.aborted ? await manual(id) : cancelled;
      }
      return await manual(mode === 'automatic' ? undefined : id);
    };
    try {
      return skipped(await attempt());
    } catch (err) {
      if (signal.aborted && err === signal.reason) return skipped(cancelled);
      throw err;
    } finally {
      await deps.flow.end();
    }
  }
  return { run };
}
