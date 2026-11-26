import type { ProviderId } from '@relavium/llm';
import type { GlobalConfig } from '@relavium/shared';

import { ConfigError } from '../config/errors.js';
import {
  ConfigWriteRefusedError,
  globalConfigPath,
  prepareFirstRunSetupSkipped,
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
  type ProviderKeyAvailability,
  type ProviderResolver,
} from '../engine/providers.js';
import type { StandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  runNativeSetup,
  scrubSetupText,
  type NativeSetupResult,
  type OnboardingDeps,
  type SetupPrompts,
} from '../onboarding/wizard.js';
import {
  SETUP_NEXT_STEP,
  SETUP_SKIP_NOT_SAVED,
  setupSkippedNotice,
  type SetupSurface,
} from '../onboarding/setup-notes.js';
import {
  NATIVE_PROMPT_BACK,
  type NativePromptEscape,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { framedFlow, type FramedDone, type FramedFlow } from './framed-flow.js';

export interface ProviderSetupDeps {
  readonly configReadObserver?: ConfigReadObserver;
  readonly flow: NativePromptFlow;
  readonly credentialSurface?: SetupSurface;
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
  /**
   * Draw the setup as the Home's `/providers` POPUP (ADR-0148 §1, ADR-0146 §6): the rail `Provider · Key · Done`, `Esc` steps back, a persistent
   * Done step, the environment-key consent's `Use it` guarded, the words of the popup. Absent ⇒ the CARD: the stand-alone chat's pre-chat mount,
   * which has no popup slot (a framed prompt would draw nothing there and every key would be dropped as unseen), keeps its card and its words.
   */
  readonly popup?: boolean;
  /**
   * Remember a skip of the AUTOMATIC first run beyond the process (ADR-0146 §6, ruled 2026-11-24): the Home's. The stand-alone chat never
   * writes one (it opens its setup only when no provider is usable, and a chat cannot start without one).
   */
  readonly rememberSkip?: boolean;
}

export interface ProviderSetupOutcome {
  readonly status: 'ready' | 'cancelled' | 'deferred' | 'incomplete';
  readonly changed: boolean;
  /**
   * What the host says once the setup has closed: on a card the notice it keeps; in the popup ONE notification (a skip, a setup that could not
   * show its Done step), never a Home notice or a transcript line (ADR-0148 §6). Absent when the setup said everything itself.
   */
  readonly notice?: string;
}

interface Observation {
  readonly id: ProviderId;
  readonly availability: ProviderKeyAvailability;
}
const cancelled: ProviderSetupOutcome = { status: 'cancelled', changed: false };
const SAVED_UNCONFIRMED = 'Saved, but persistence after a crash is unconfirmed.';
/** A step back from a step that has one before it: the caller asks its own prompt again. */
type Back = typeof NATIVE_PROMPT_BACK;

/** The popup's top edge: the command's name (the automatic first run is the same popup, ADR-0146 §6 "one first screen, not two"). */
export const PROVIDERS_POPUP_TITLE = '/providers';
/** The popup's rail (ADR-0146 §6: `Provider · Key · Done`, `step 2 of 3`). */
export const PROVIDER_STEP_NAMES: readonly string[] = ['Provider', 'Key', 'Done'];

/**
 * The environment-key consent of the popup (ADR-0146 §6, G15): it names the variable, the provider and (on a first run, where a default is
 * chosen) the model, and that the choice is saved to the global config. Every value is scrubbed by the caller.
 */
export function consentMessage(variable: string, provider: string, model?: string): string {
  const use = model === undefined ? 'Use it?' : `Use it, with ${model} as your default model?`;
  return `${variable} is set for ${provider}. ${use} Saved to your global config; the variable stays yours.`;
}

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
   * `intro` is a note for the card itself (a host's reason for opening it): shown from the first row of the setup, where a person who is looking
   * at the setup can read it, and replaced by the notes of the steps that follow.
   */
  readonly run: (mode: 'automatic' | 'explicit', intro?: string) => Promise<ProviderSetupOutcome>;
} {
  let acknowledged = deps.globalConfig?.preferences?.keychain_unavailable_acknowledged === true;
  const isDefault =
    deps.globalConfigIsDefault ?? deps.globalConfigPath === globalConfigPath(deps.home);
  const targetPath = isDefault ? undefined : deps.globalConfigPath;

  const surface = deps.credentialSurface ?? 'home';
  const popup = deps.popup === true;

  /** The popup frame of one run (the rail, the way back in the run's words, the Done step), or none for a card. */
  const frameFor = (exitLabel: string): FramedFlow | undefined =>
    popup
      ? framedFlow(deps.flow, {
          title: PROVIDERS_POPUP_TITLE,
          origin: 'home',
          stepNames: PROVIDER_STEP_NAMES,
          progress: 'manual',
          exitLabel,
        })
      : undefined;

  /**
   * Remember the skip (ADR-0146 §6) after the setup's own flow has ended. A person with no config gets the file with no card; a hand-made config
   * is rewritten only behind its disclosure, drawn in the popup again by the Home's visible-publication path, and that popup ends in a Done step
   * that says so. A write that fails is one notification, and the offer returns next launch. Returns the line for the host, or `undefined` when
   * the Done step said it.
   */
  async function rememberSkip(): Promise<string | undefined> {
    let prepared: PreparedConfigWrite;
    try {
      deps.assertAdmitting();
      prepared = prepareFirstRunSetupSkipped(deps.home, targetPath, deps.configReadObserver);
      if (!prepared.rewriteNeeded) {
        prepared.publish(deps.assertAdmitting);
        return setupSkippedNotice(surface);
      }
    } catch (err) {
      if (err instanceof ConfigError || err instanceof ConfigWriteRefusedError)
        return SETUP_SKIP_NOT_SAVED;
      throw err;
    }
    const again = frameFor('close');
    const flow: NativePromptFlow = again ?? deps.flow;
    const signal = flow.begin();
    const admit = (): void => {
      deps.assertAdmitting();
      signal.throwIfAborted();
    };
    try {
      const result = await deps.publishPreference(prepared, admit);
      await again?.done({
        message: 'Setup skipped',
        lines: [
          'It will not open by itself again. /providers connects a provider any time.',
          ...(result.durability === 'unconfirmed' ? [SAVED_UNCONFIRMED] : []),
        ],
      });
      return again === undefined ? setupSkippedNotice(surface) : undefined;
    } catch (err) {
      if (signal.aborted && err === signal.reason) return SETUP_SKIP_NOT_SAVED;
      if (err instanceof ConfigError || err instanceof ConfigWriteRefusedError)
        return SETUP_SKIP_NOT_SAVED;
      throw err;
    } finally {
      await flow.end();
    }
  }

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
    /** The automatic first run: its first step's way out is `skip for now`, and a skip of it is remembered (ADR-0146 §6). */
    const firstRun = mode === 'automatic' && firstUsable;
    const framed = frameFor(firstRun ? 'skip for now' : 'close');
    const flow: NativePromptFlow = framed ?? deps.flow;
    /** The entry prompt of the `Provider` step: on a first run its `Esc` (and `Ctrl+C`, which the channel cannot tell from it) skips. */
    const entry: SetupPrompts = framed?.at(0) ?? deps.flow;
    /** A later prompt of the `Provider` step (a recovery, an action): its way out closes. */
    const later: SetupPrompts = framed?.at(0, { exitLabel: 'close' }) ?? deps.flow;
    /** The popup's `/providers` list: a prompt reached from the list steps back to it with `Esc`. A card has no step back. */
    const fromList: NativePromptEscape =
      framed !== undefined && mode === 'explicit' ? 'back' : 'cancel';
    const signal = flow.begin();
    if (intro !== undefined) flow.note(intro);
    const assertAdmitting = (): void => {
      deps.assertAdmitting();
      signal.throwIfAborted();
    };
    /** The person skipped the automatic first run (its first step's `Esc`, or `Skip setup`): remembered after the flow, for the Home. */
    let personSkipped = false;
    /**
     * A first run that ended with no key and no word of its own (`Esc`, `Ctrl+C`, a `Not now`, `Skip setup`) says that it was skipped and how
     * to come back (ADR-0146 §6). Every cancel is a skip only when nothing worked before: closing the list of a Home that already has a key
     * skips nothing.
     */
    const skipped = (outcome: ProviderSetupOutcome): ProviderSetupOutcome =>
      firstUsable &&
      outcome.notice === undefined &&
      (outcome.status === 'cancelled' || personSkipped)
        ? { ...outcome, notice: setupSkippedNotice(surface) }
        : outcome;
    /**
     * A key typed while the keychain is down would be checked against the provider and then lost (G19), so every road to the key prompt
     * stops at the keychain card instead. The health is the keychain's, not one provider's, so the gate is here and not on one card: the
     * env-consent card, the usable card and the custom-endpoint note all reach the prompt through `manual`.
     */
    const keychainDown = (): boolean =>
      observations.some(({ availability }) => availability.keychainHealth === 'unavailable');

    /** The popup's last step, or (when the flow was already cancelled) the line the host shows instead; a card keeps its notice. */
    const finish = async (
      outcome: ProviderSetupOutcome,
      done: FramedDone,
      interrupted: string,
    ): Promise<ProviderSetupOutcome> => {
      if (framed === undefined) return outcome;
      if (signal.aborted)
        return { status: outcome.status, changed: outcome.changed, notice: interrupted };
      await framed.done(done);
      return { status: outcome.status, changed: outcome.changed };
    };

    const manual = async (id?: ProviderId): Promise<ProviderSetupOutcome | Back> => {
      assertAdmitting();
      if (keychainDown()) {
        const target =
          id ??
          observations.find(({ availability }) => availability.keychainHealth === 'unavailable')
            ?.id;
        if (target !== undefined) return unavailable(target, fromList);
      }
      let committedNotice: string | undefined;
      const captured: NativePromptFlow = {
        ...flow,
        committedNote: (message, title) => {
          committedNotice = title === undefined ? message : `${title}: ${message}`;
          if (flow.committedNote !== undefined) flow.committedNote(message, title);
          else flow.note(message, title);
        },
      };
      const result: NativeSetupResult = await runNativeSetup(
        {
          ...deps.wizard,
          resolver: deps.resolver,
          ...(id === undefined ? {} : { initialProvider: id }),
        },
        {
          flow: captured,
          signal,
          assertAdmitting,
          endpointContext: deps.endpointContext,
          selectStarterDefault: firstUsable,
          surface,
          ...(framed === undefined
            ? {}
            : {
                stages: {
                  provider: entry,
                  key: framed.at(1, { exitLabel: 'close' }),
                  done: (done: FramedDone) => framed.done(done),
                },
              }),
        },
      );
      if (result.kind === 'back') return NATIVE_PROMPT_BACK;
      if (result.kind === 'skipped' && firstRun) personSkipped = true;
      if (committedNotice !== undefined)
        return { status: 'ready', changed: true, notice: committedNotice };
      if (result.kind === 'finished' && result.stored)
        return {
          status: 'ready',
          changed: true,
          ...(result.notice === undefined ? {} : { notice: result.notice }),
        };
      return { status: signal.aborted ? 'cancelled' : 'incomplete', changed: true };
    };
    const publish = async (prepared: PreparedConfigWrite): Promise<ConfigWriteResult> =>
      deps.publishPreference(prepared, assertAdmitting);

    /** The starter default after a granted source, and what the setup says about both. */
    async function grantOutcome(
      id: ProviderId,
      source: string,
      granted: 'saved' | 'unconfirmed' | 'once',
    ): Promise<ProviderSetupOutcome> {
      const notice =
        granted === 'once'
          ? 'Source allowed for this invocation only.'
          : granted === 'unconfirmed'
            ? SAVED_UNCONFIRMED
            : 'Source consent saved.';
      const name = scrubSetupText(KNOWN_PROVIDERS[id].displayName);
      const variable = scrubSetupText(source);
      const model = scrubSetupText(KNOWN_PROVIDERS[id].starterModel);
      const head = `Using ${variable} · ${name}`;
      const sourceLines: readonly string[] =
        granted === 'once'
          ? ['Allowed for this invocation only; nothing was saved.']
          : [
              'Saved to your global config; the variable stays yours.',
              ...(granted === 'unconfirmed' ? [SAVED_UNCONFIRMED] : []),
            ];
      const interrupted = `${variable} allowed · the default was not saved`;
      const done = (withModel: boolean, lines: readonly string[]): FramedDone => ({
        message: withModel ? `${head} · ${model}` : head,
        lines: [...sourceLines, ...lines],
      });
      if (!firstUsable || signal.aborted)
        return finish({ status: 'ready', changed: true, notice }, done(false, []), interrupted);
      try {
        assertAdmitting();
        const result: unknown = await deps.wizard.writeDefaultModel(
          KNOWN_PROVIDERS[id].starterModel,
          id,
          assertAdmitting,
        );
        if (typeof result === 'object' && result !== null && 'kind' in result) {
          if (result.kind === 'ephemeral')
            return finish(
              {
                status: 'ready',
                changed: true,
                notice: `${notice} Starter model selected for this invocation only.`,
              },
              done(true, [
                `${model} is selected for this invocation only; the default was not saved.`,
              ]),
              interrupted,
            );
          if (result.kind === 'cancelled')
            return finish(
              {
                status: 'ready',
                changed: true,
                notice: `${notice} Starter default was not saved.`,
              },
              done(false, ['The starter default was not saved. Choose a model with /models.']),
              interrupted,
            );
          if (result.kind === 'saved' && 'durability' in result)
            return finish(
              {
                status: 'ready',
                changed: true,
                notice: `${notice} Starter default saved${result.durability === 'unconfirmed' ? '; crash persistence is unconfirmed' : ''}. Project settings may override it.`,
              },
              done(true, [
                ...(result.durability === 'unconfirmed'
                  ? ['The default model was saved, but persistence after a crash is unconfirmed.']
                  : []),
                SETUP_NEXT_STEP,
              ]),
              interrupted,
            );
        }
        return finish(
          {
            status: 'ready',
            changed: true,
            notice: `${notice} Check the starter model with /models.`,
          },
          done(false, ['Check the starter model with /models.']),
          interrupted,
        );
      } catch (err) {
        if (signal.aborted && err !== signal.reason) throw err;
        if (
          !signal.aborted &&
          !(err instanceof ConfigError) &&
          !(err instanceof ConfigWriteRefusedError)
        )
          throw err;
        return finish(
          {
            status: 'ready',
            changed: true,
            notice: `${notice} Starter default could not be saved; select a model with /models.`,
          },
          done(false, ['The starter default could not be saved; select a model with /models.']),
          interrupted,
        );
      }
    }

    /**
     * An environment key that is present and not yet allowed: a consent (ADR-0146 §6). The card opens on `Not now`, the LAST row, so an `Enter`
     * already on its way never grants a source of credentials; in the popup `Use it` is also GUARDED (the approval card's input layers, ADR-0148
     * §3): `Enter` on it counts only from a frame the person was shown, after the lockout that runs from the moment the select appeared.
     */
    async function consent(
      id: ProviderId,
      source: string,
      prompts: SetupPrompts,
      escape: NativePromptEscape,
    ): Promise<ProviderSetupOutcome | Back> {
      for (;;) {
        const answer = await prompts.select({
          message: popup
            ? consentMessage(
                scrubSetupText(source),
                scrubSetupText(KNOWN_PROVIDERS[id].displayName),
                firstUsable ? scrubSetupText(KNOWN_PROVIDERS[id].starterModel) : undefined,
              )
            : `${source} is available for ${KNOWN_PROVIDERS[id].displayName}. Allow this source?`,
          initialValue: 'defer',
          options: [
            { value: 'use', label: 'Use it', ...(popup ? { guarded: true as const } : {}) },
            // A key typed while the keychain is down would be checked against the provider and then lost (G19), so it is not offered.
            ...(keychainDown() ? [] : [{ value: 'manual', label: 'Enter a different key' }]),
            { value: 'defer', label: 'Not now' },
          ],
          escape,
        });
        if (answer === NATIVE_PROMPT_BACK) return NATIVE_PROMPT_BACK;
        if (typeof answer !== 'string' || signal.aborted) {
          deps.policy.defer(id);
          if (firstRun && prompts === entry) personSkipped = true;
          return cancelled;
        }
        if (answer === 'manual') {
          const keyed = await manual(id);
          // `Esc` from the key step: back to this consent on a first run; back to the list from `/providers`.
          if (keyed === NATIVE_PROMPT_BACK && escape !== 'back') continue;
          return keyed;
        }
        if (answer !== 'use') {
          deps.policy.defer(id);
          return {
            status: 'deferred',
            changed: false,
            ...(firstUsable ? { notice: setupSkippedNotice(surface) } : {}),
          };
        }
        return await publishConsent(id, source);
      }
    }

    /** Publish a granted consent; a write failure keeps the recovery choices it always had. */
    async function publishConsent(id: ProviderId, source: string): Promise<ProviderSetupOutcome> {
      for (;;) {
        try {
          assertAdmitting();
          const result = await publish(
            prepareStandardEnvKeyConsent(id, deps.home, targetPath, deps.configReadObserver),
          );
          // The publisher resolves only after rename. Do not recheck cancellation after publication.
          deps.policy.allowForInvocation(id);
          return await grantOutcome(
            id,
            source,
            result.durability === 'unconfirmed' ? 'unconfirmed' : 'saved',
          );
        } catch (err) {
          if (signal.aborted) {
            if (err !== signal.reason) throw err;
            deps.policy.defer(id);
            return cancelled;
          }
          if (!(err instanceof ConfigError) && !(err instanceof ConfigWriteRefusedError)) throw err;
          const refused = err instanceof ConfigWriteRefusedError;
          flow.note(
            refused
              ? 'Config is a symbolic link. Edit it manually or replace the link with a regular file.'
              : 'Could not save source consent.',
          );
          const recovery = await later.select({
            message: 'How would you like to continue?',
            options: [
              ...(refused ? [] : [{ value: 'retry', label: 'Retry saving' }]),
              // One spelling for the two recovery cards that can follow each other, each naming what it uses: this one the source (the
              // variable), the starter-default card the model. Without `Retry saving` it is the FIRST row, which a held `Enter` that answered
              // `Use it` would answer next: in the popup it is guarded too (6.1 security sitting).
              {
                value: 'once',
                label: `Use ${source} for this invocation only`,
                ...(popup && refused ? { guarded: true as const } : {}),
              },
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
            return await grantOutcome(id, source, 'once');
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
    async function unavailable(
      id: ProviderId,
      escape: NativePromptEscape,
    ): Promise<ProviderSetupOutcome | Back> {
      const prompts = escape === 'back' ? later : entry;
      for (;;) {
        const answer = await prompts.select({
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
          escape,
        });
        if (answer === NATIVE_PROMPT_BACK) return NATIVE_PROMPT_BACK;
        if (typeof answer !== 'string' || signal.aborted) {
          if (firstRun && prompts === entry) personSkipped = true;
          return cancelled;
        }
        if (answer === 'cancel') return cancelled;
        if (answer === 'retry') {
          const retried = await retryKeychain(id, prompts, escape);
          if (retried !== undefined) return retried;
          continue;
        }
        if (answer !== 'ack' || acknowledged) return cancelled;
        const remembered = await rememberKeychain();
        if (remembered !== undefined) return remembered;
      }
    }

    /** `Retry keychain`: sample again; what the keychain card does next, or `undefined` to ask it again. */
    async function retryKeychain(
      id: ProviderId,
      prompts: SetupPrompts,
      escape: NativePromptEscape,
    ): Promise<ProviderSetupOutcome | Back | undefined> {
      assertAdmitting();
      observations = sampleProviderSetup(deps.resolver);
      if (observations.some(({ availability }) => availability.status === 'usable'))
        return { status: 'ready', changed: false };
      const pending = observations.find(
        ({ availability }) => availability.status === 'present-standard-not-allowed',
      );
      if (pending?.availability.status === 'present-standard-not-allowed') {
        const decided = await consent(
          pending.id,
          pending.availability.source.name,
          prompts,
          escape,
        );
        return decided === NATIVE_PROMPT_BACK && escape !== 'back' ? undefined : decided;
      }
      if (!keychainDown()) {
        const keyed = await manual(id);
        return keyed === NATIVE_PROMPT_BACK && escape !== 'back' ? undefined : keyed;
      }
      flow.note('The keychain is still unavailable.');
      return undefined;
    }

    /** Publish the keychain reminder; `undefined` when it failed in a way the keychain card is asked again for. */
    async function rememberKeychain(): Promise<ProviderSetupOutcome | undefined> {
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
        const notice =
          result.durability === 'unconfirmed' ? SAVED_UNCONFIRMED : 'Keychain reminder saved.';
        return await finish(
          { status: 'deferred', changed: true, notice },
          {
            message: 'Remembered · the OS keychain is unavailable',
            lines: [
              'Saved to your global config; setup will not ask about it again by itself.',
              ...(result.durability === 'unconfirmed' ? [SAVED_UNCONFIRMED] : []),
              '/providers retries the keychain any time.',
            ],
          },
          'Keychain reminder saved',
        );
      } catch (err) {
        if (signal.aborted) {
          if (err !== signal.reason) throw err;
          return cancelled;
        }
        if (!(err instanceof ConfigError) && !(err instanceof ConfigWriteRefusedError)) throw err;
        flow.note(
          err instanceof ConfigWriteRefusedError
            ? 'Config is a symbolic link. Edit it manually or replace the link with a regular file.'
            : 'Could not save the keychain reminder.',
        );
        if (err instanceof ConfigWriteRefusedError) return { status: 'incomplete', changed: false };
        return undefined;
      }
    }

    /** The row the person picked in the explicit list; `undefined` when they closed it, or the row is gone. */
    const pickFromList = async (): Promise<Observation | undefined> => {
      const selected = await entry.select({
        // The popup's list reads as the first run's first screen (ADR-0146 §6, "one first screen, not two"); a card keeps its title.
        message: popup ? 'Which provider?' : 'Providers',
        options: observations.map(({ id, availability }) => ({
          value: id,
          label: KNOWN_PROVIDERS[id].displayName,
          hint: providerRowHint(availability),
        })),
      });
      if (typeof selected !== 'string' || signal.aborted) return undefined;
      return observations.find(({ id }) => id === selected);
    };

    /** An environment source that is present and not yet allowed, by whether the person already said `Not now` to it this process. */
    const standardSources = (deferred: boolean): Observation[] =>
      observations.filter(
        ({ id, availability }) =>
          availability.status === 'present-standard-not-allowed' &&
          deps.policy.isDeferred(id) === deferred,
      );

    /** The row the automatic offer works on: a source awaiting consent, else the first that needs a word said about it, else the first. */
    const firstNeedingAttention = (): Observation | undefined =>
      standardSources(false)[0] ??
      observations.find(
        ({ availability }) => availability.status === 'ineligible-custom-endpoint',
      ) ??
      observations.find(({ availability }) => availability.status === 'unavailable') ??
      observations[0];

    /** A keychain that is down: the automatic offer of a person who already acknowledged it only says how to retry; any other asks. */
    const settleKeychainDown = async (id: ProviderId): Promise<ProviderSetupOutcome | Back> => {
      if (mode === 'automatic' && acknowledged)
        return {
          status: 'deferred',
          changed: false,
          notice:
            deps.credentialSurface === 'standalone-chat'
              ? 'Keychain is unavailable. Restart this chat to retry setup.'
              : 'Keychain is unavailable. Open /providers to retry.',
        };
      return await unavailable(id, fromList);
    };

    /** A key that already works: say so, and offer to replace it. */
    const settleUsable = async (
      id: ProviderId,
      availability: Parameters<typeof providerKeyAvailabilityMessage>[1],
    ): Promise<ProviderSetupOutcome | Back> => {
      flow.note(
        `${KNOWN_PROVIDERS[id].displayName}: ${providerKeyAvailabilityMessage(id, availability, deps.credentialSurface ?? 'home')} ${scrubSetupText(deps.endpointContext(id))}`,
      );
      const answer = await later.select({
        message: 'Provider action',
        options: [
          ...(keychainDown() ? [] : [{ value: 'manual', label: 'Enter a different key' }]),
          { value: 'cancel', label: 'Done' },
        ],
        escape: fromList,
      });
      if (answer === NATIVE_PROMPT_BACK) return NATIVE_PROMPT_BACK;
      return answer === 'manual' && !signal.aborted ? await manual(id) : cancelled;
    };

    /** What the setup does for one chosen row, by what its key is. */
    const settle = async ({
      id,
      availability,
    }: Observation): Promise<ProviderSetupOutcome | Back> => {
      if (availability.status === 'present-standard-not-allowed')
        return await consent(
          id,
          availability.source.name,
          mode === 'explicit' ? later : entry,
          fromList,
        );
      if (availability.status === 'ineligible-custom-endpoint') {
        flow.note(
          `${availability.source.name} cannot be used with the configured custom endpoint. ${scrubSetupText(deps.endpointContext(id))}`,
        );
        return await manual(id);
      }
      if (availability.status === 'unavailable') return await settleKeychainDown(id);
      if (availability.status === 'usable') return await settleUsable(id, availability);
      return await manual(mode === 'automatic' ? undefined : id);
    };

    const attempt = async (): Promise<ProviderSetupOutcome> => {
      // The automatic offer has nothing to ask when every source it could consent to was already declined in this process.
      if (
        mode === 'automatic' &&
        standardSources(false).length === 0 &&
        standardSources(true).length > 0
      )
        return { status: 'deferred', changed: false };
      if (mode === 'explicit') {
        for (;;) {
          const chosen = await pickFromList();
          if (chosen === undefined) return cancelled;
          const outcome = await settle(chosen);
          if (outcome !== NATIVE_PROMPT_BACK) return outcome;
        }
      }
      const chosen = firstNeedingAttention();
      if (chosen === undefined) return cancelled;
      const outcome = await settle(chosen);
      if (outcome !== NATIVE_PROMPT_BACK) return outcome;
      // A step back from a key step that had no step before it (a custom endpoint's key, asked first): the setup is left, as a skip.
      if (firstRun) personSkipped = true;
      return cancelled;
    };
    let outcome: ProviderSetupOutcome;
    try {
      outcome = skipped(await attempt());
    } catch (err) {
      if (!(signal.aborted && err === signal.reason)) throw err;
      outcome = skipped(cancelled);
    } finally {
      await flow.end();
    }
    if (!(personSkipped && deps.rememberSkip === true && outcome.status !== 'ready'))
      return outcome;
    const said = await rememberSkip();
    return {
      status: outcome.status,
      changed: outcome.changed,
      ...(said === undefined ? {} : { notice: said }),
    };
  }
  return { run };
}
