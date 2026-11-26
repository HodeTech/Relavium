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
  providerRowHint,
  type ProviderResolver,
} from '../engine/providers.js';
import type { StandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import {
  runNativeSetup,
  scrubSetupText,
  type NativeSetupResult,
  type OnboardingDeps,
  type SetupPrompts,
  type SetupStages,
} from '../onboarding/wizard.js';
import {
  SETUP_SKIP_NOT_SAVED,
  setupClosedNotice,
  setupSkippedNotice,
  type SetupSurface,
} from '../onboarding/setup-notes.js';
import {
  NATIVE_PROMPT_BACK,
  type NativePromptEscape,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';
import { framedFlow, type FramedDone, type FramedFlow } from './framed-flow.js';
import {
  CANCELLED,
  consent,
  unavailable,
  type Back,
  type Observation,
  type ProviderSetupOutcome,
  type SetupRun,
} from './provider-setup-steps.js';

export { consentMessage, type ProviderSetupOutcome } from './provider-setup-steps.js';

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
  readonly wizard: Omit<OnboardingDeps, 'resolver' | 'initialProvider'>;
  /**
   * Draw the setup as the Home's `/providers` POPUP (ADR-0148 §1, ADR-0146 §6): the rail `Provider · Key · Done`, `Esc` steps back, a persistent
   * Done step, the environment-key consent's `Use it` guarded, the words of the popup. Absent ⇒ the CARD: the stand-alone chat's pre-chat mount,
   * which has no popup slot (a framed prompt would draw nothing there and every key would be dropped as unseen), keeps its card and its words.
   */
  readonly popup?: boolean;
  /**
   * Remember an `Esc` skip of the AUTOMATIC first run beyond the process (ADR-0146 §6, ruled 2026-11-24): the Home's. The stand-alone chat
   * never writes one (it opens its setup only when no provider is usable, and a chat cannot start without one).
   */
  readonly rememberSkip?: boolean;
}

/** The popup's top edge when the person opened it: the command's name. */
export const PROVIDERS_POPUP_TITLE = '/providers';
/**
 * The top edge of the automatic first run (ADR-0146 §6, the frame of MVP-11 §4.12): what it is for, since nobody typed a command. It is the
 * same flow and the same words as `/providers` otherwise ("one first screen, not two").
 */
export const FIRST_RUN_POPUP_TITLE = 'Connect a provider';
/** What the key prompt's legend says `Enter` does (O9): it checks the key with the provider. A product constant. */
export const KEY_STEP_ENTER_VERB = 'check';
/** The popup's rail (ADR-0146 §6: `Provider · Key · Done`, `step 2 of 3`). */
export const PROVIDER_STEP_NAMES: readonly string[] = ['Provider', 'Key', 'Done'];

/** Sample only when setup opens or a user requests a retry; never poll during rendering. */
export function sampleProviderSetup(resolver: ProviderResolver): readonly Observation[] {
  return KNOWN_PROVIDER_IDS.map((id) => ({
    id,
    availability: providerKeyAvailability(resolver, id),
  }));
}

/** The popup's steps for the key setup (the `Provider` step's prompts, the `Key` step's, the Done step), or none on a card. */
function setupStages(
  framed: FramedFlow | undefined,
  provider: SetupPrompts,
): { readonly stages?: SetupStages } {
  if (framed === undefined) return {};
  return {
    stages: {
      provider,
      // The key prompt's `Enter` sends the key to the provider (once, to check it): the legend says so (ADR-0145 §3: the verb states the effect).
      key: framed.at(1, { exitLabel: 'close', enterVerb: KEY_STEP_ENTER_VERB }),
      done: (done: FramedDone) => framed.done(done),
    },
  };
}

/** The flow handed to the key setup, which records the note it COMMITTED (a fact, kept as the host's notice), as well as drawing it. */
function capturingCommitted(flow: NativePromptFlow): {
  readonly flow: NativePromptFlow;
  readonly committed: () => string | undefined;
} {
  let committed: string | undefined;
  return {
    flow: {
      ...flow,
      committedNote: (message, title) => {
        committed = title === undefined ? message : `${title}: ${message}`;
        if (flow.committedNote !== undefined) flow.committedNote(message, title);
        else flow.note(message, title);
      },
    },
    committed: () => committed,
  };
}

/** What the key setup came to, as the coordinator's outcome (`Back` when it stepped back with no step before it in the setup). */
function keyedOutcome(
  result: NativeSetupResult,
  committed: string | undefined,
  aborted: boolean,
): ProviderSetupOutcome | Back {
  if (result.kind === 'back') return NATIVE_PROMPT_BACK;
  if (committed !== undefined) return { status: 'ready', changed: true, notice: committed };
  if (result.kind === 'finished' && result.stored)
    return {
      status: 'ready',
      changed: true,
      ...(result.notice === undefined ? {} : { notice: result.notice }),
    };
  // A skip (the first step's `Esc`, `Skip setup`) is the person leaving, as a cancel is; anything else that stored nothing is incomplete.
  return {
    status: aborted || result.kind === 'skipped' ? 'cancelled' : 'incomplete',
    changed: true,
  };
}

/** One coordinator per invocation; the policy and acknowledged state survive Home rebuilds. */
export function createProviderSetupCoordinator(deps: ProviderSetupDeps): {
  /**
   * `intro` is a note for the card itself (a host's reason for opening it): shown from the first row of the setup, where a person who is looking
   * at the setup can read it, and replaced by the notes of the steps that follow.
   */
  readonly run: (mode: 'automatic' | 'explicit', intro?: string) => Promise<ProviderSetupOutcome>;
} {
  const reminder = {
    acknowledged: deps.globalConfig?.preferences?.keychain_unavailable_acknowledged === true,
  };
  const isDefault =
    deps.globalConfigIsDefault ?? deps.globalConfigPath === globalConfigPath(deps.home);
  const targetPath = isDefault ? undefined : deps.globalConfigPath;

  const surface = deps.credentialSurface ?? 'home';
  const popup = deps.popup === true;

  /** The popup frame of one run (its title, the rail, the Done step), or none for a card. Every step's `Ctrl+C` closes it. */
  const frameFor = (title: string): FramedFlow | undefined =>
    popup
      ? framedFlow(deps.flow, {
          title,
          origin: 'home',
          stepNames: PROVIDER_STEP_NAMES,
          progress: 'manual',
          exitLabel: 'close',
        })
      : undefined;

  /**
   * Remember an `Esc` skip (ADR-0146 §6) after the setup's own flow has ended, as the one line the host shows. Only a person with NO global
   * config is remembered: the file is created with the one key, and nothing else is lost. A config that exists is never rewritten for a skip
   * (C-F3: a hand-made one would lose its comments and its order, with no way to decline): the skip is not remembered, the config stays as it
   * is, byte for byte, and the line says the popup opens again next launch, as for a write that fails.
   */
  function rememberSkip(): string {
    try {
      deps.assertAdmitting();
      const prepared = prepareFirstRunSetupSkipped(deps.home, targetPath, deps.configReadObserver);
      if (prepared.rewriteNeeded) return SETUP_SKIP_NOT_SAVED;
      prepared.publish(deps.assertAdmitting);
      return setupSkippedNotice(surface);
    } catch (err) {
      if (err instanceof ConfigError || err instanceof ConfigWriteRefusedError)
        return SETUP_SKIP_NOT_SAVED;
      throw err;
    }
  }

  /** The global config writes of the consent and keychain steps, against the host's target. */
  const writes = (assertAdmitting: () => void): SetupRun['writes'] => ({
    consent: (id) =>
      prepareStandardEnvKeyConsent(id, deps.home, targetPath, deps.configReadObserver),
    keychainAcknowledged: () =>
      prepareKeychainUnavailableAcknowledged(true, deps.home, targetPath, deps.configReadObserver),
    publish: (prepared) => deps.publishPreference(prepared, assertAdmitting),
    writeDefaultModel: deps.wizard.writeDefaultModel,
  });

  async function run(
    mode: 'automatic' | 'explicit',
    intro?: string,
  ): Promise<ProviderSetupOutcome> {
    deps.assertAdmitting();
    let observations = sampleProviderSetup(deps.resolver);
    const firstUsable = !observations.some(({ availability }) => availability.status === 'usable');
    if (mode === 'automatic' && !firstUsable) return { status: 'ready', changed: false };
    /**
     * The automatic first run (ADR-0146 §6): titled for what it is, its first step's `Esc` is the skip (remembered on the Home), and only it
     * announces how it ended.
     */
    const firstRun = mode === 'automatic' && firstUsable;
    const framed = frameFor(firstRun ? FIRST_RUN_POPUP_TITLE : PROVIDERS_POPUP_TITLE);
    const flow: NativePromptFlow = framed ?? deps.flow;
    /** The prompts of the `Provider` step: the list, the consent, the keychain step, a recovery, an action. */
    const entry: SetupPrompts = framed?.at(0) ?? deps.flow;
    /**
     * What `Esc` does on a prompt of the popup's first step other than the explicit list, and on the prompts reached from that list: it steps
     * back, so the channel tells it from `Ctrl+C`, which leaves. Reached from the list it returns there; on the automatic first run, where
     * there is nothing before it, the step back is the SKIP (S3: `Ctrl+C` there leaves with nothing remembered). A card has no step back.
     */
    const fromList: NativePromptEscape = framed === undefined ? 'cancel' : 'back';
    const signal = flow.begin();
    if (intro !== undefined) flow.note(intro);
    const assertAdmitting = (): void => {
      deps.assertAdmitting();
      signal.throwIfAborted();
    };
    /** The person skipped the automatic first run (its first step's `Esc`, or `Skip setup`): remembered after the flow, for the Home. */
    let personSkipped = false;
    /**
     * The one line the host shows after an automatic first run that ended with no key and no word of its own (ADR-0146 §6): a skip says
     * whether it was remembered ({@link rememberSkip}); a run that was left (`Ctrl+C`, a `Not now`, the keychain step's `Not now`) says it opens
     * again next launch, because nothing was written. Only the first run that opened BY ITSELF speaks: closing a `/providers` the person
     * opened (or the one the doctor handed off to) says nothing (O13, the residue rule).
     */
    const closing = (outcome: ProviderSetupOutcome): ProviderSetupOutcome => {
      if (!firstRun || outcome.status === 'ready') return outcome;
      if (personSkipped)
        return {
          status: outcome.status,
          changed: outcome.changed,
          notice: deps.rememberSkip === true ? rememberSkip() : setupClosedNotice(surface),
        };
      if (outcome.notice !== undefined || outcome.status !== 'cancelled') return outcome;
      return { ...outcome, notice: setupClosedNotice(surface) };
    };
    /**
     * A key typed while the keychain is down would be checked against the provider and then lost (G19), so every road to the key prompt
     * stops at the keychain card instead. The health is the keychain's, not one provider's, so the gate is here and not on one card: the
     * env-consent card, the usable card and the custom-endpoint note all reach the prompt through `manual`.
     */
    const keychainDown = (): boolean =>
      observations.some(({ availability }) => availability.keychainHealth === 'unavailable');

    /** The key step (the native setup) for `id`, or the provider list when none is given. */
    async function manual(id?: ProviderId): Promise<ProviderSetupOutcome | Back> {
      assertAdmitting();
      const down = keychainDown()
        ? (id ??
          observations.find(({ availability }) => availability.keychainHealth === 'unavailable')
            ?.id)
        : undefined;
      if (down !== undefined) return unavailable(steps, down, fromList);
      const capture = capturingCommitted(flow);
      const result = await runNativeSetup(
        {
          ...deps.wizard,
          resolver: deps.resolver,
          ...(id === undefined ? {} : { initialProvider: id }),
        },
        {
          flow: capture.flow,
          signal,
          assertAdmitting,
          endpointContext: deps.endpointContext,
          selectStarterDefault: firstUsable,
          surface,
          ...setupStages(framed, entry),
        },
      );
      if (result.kind === 'skipped' && firstRun) personSkipped = true;
      return keyedOutcome(result, capture.committed(), signal.aborted);
    }

    /** The run as the consent and keychain steps read it (`provider-setup-steps.ts`). */
    const steps: SetupRun = {
      mode,
      firstUsable,
      firstRun,
      popup,
      surface,
      signal,
      flow,
      prompts: entry,
      admit: assertAdmitting,
      policy: deps.policy,
      writes: writes(assertAdmitting),
      finish: async (outcome, done, interrupted) => {
        if (framed === undefined) return outcome;
        if (signal.aborted)
          return { status: outcome.status, changed: outcome.changed, notice: interrupted };
        await framed.done(done);
        return { status: outcome.status, changed: outcome.changed };
      },
      manual,
      keychainDown,
      resample: () => {
        observations = sampleProviderSetup(deps.resolver);
        return observations;
      },
      reminder,
    };

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
      if (mode === 'automatic' && reminder.acknowledged)
        return {
          status: 'deferred',
          changed: false,
          notice:
            deps.credentialSurface === 'standalone-chat'
              ? 'Keychain is unavailable. Restart this chat to retry setup.'
              : 'Keychain is unavailable. Open /providers to retry.',
        };
      return await unavailable(steps, id, fromList);
    };

    /** A key that already works: say so, and offer to replace it. */
    const settleUsable = async (
      id: ProviderId,
      availability: Parameters<typeof providerKeyAvailabilityMessage>[1],
    ): Promise<ProviderSetupOutcome | Back> => {
      flow.note(
        `${KNOWN_PROVIDERS[id].displayName}: ${providerKeyAvailabilityMessage(id, availability, deps.credentialSurface ?? 'home')} ${scrubSetupText(deps.endpointContext(id))}`,
      );
      const answer = await entry.select({
        message: 'Provider action',
        options: [
          ...(keychainDown() ? [] : [{ value: 'manual', label: 'Enter a different key' }]),
          { value: 'cancel', label: 'Done' },
        ],
        escape: fromList,
      });
      if (answer === NATIVE_PROMPT_BACK) return NATIVE_PROMPT_BACK;
      return answer === 'manual' && !signal.aborted ? await manual(id) : CANCELLED;
    };

    /** What the setup does for one chosen row, by what its key is. */
    const settle = async ({
      id,
      availability,
    }: Observation): Promise<ProviderSetupOutcome | Back> => {
      if (availability.status === 'present-standard-not-allowed')
        return await consent(steps, id, availability.source.name, fromList);
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

    /** The explicit list: a row's step, and back to the list when that step steps back. */
    const fromTheList = async (): Promise<ProviderSetupOutcome> => {
      for (;;) {
        const chosen = await pickFromList();
        if (chosen === undefined) return CANCELLED;
        const outcome = await settle(chosen);
        if (outcome !== NATIVE_PROMPT_BACK) return outcome;
      }
    };

    const attempt = async (): Promise<ProviderSetupOutcome> => {
      // The automatic offer has nothing to ask when every source it could consent to was already declined in this process.
      if (
        mode === 'automatic' &&
        standardSources(false).length === 0 &&
        standardSources(true).length > 0
      )
        return { status: 'deferred', changed: false };
      if (mode === 'explicit') return await fromTheList();
      const chosen = firstNeedingAttention();
      if (chosen === undefined) return CANCELLED;
      const outcome = await settle(chosen);
      if (outcome !== NATIVE_PROMPT_BACK) return outcome;
      // A step back from the first step, where there is nothing before it (the consent, the keychain step, or a custom endpoint's key asked
      // first): the setup is left, as a skip.
      if (firstRun) personSkipped = true;
      return CANCELLED;
    };
    let outcome: ProviderSetupOutcome;
    try {
      outcome = await attempt();
    } catch (err) {
      if (!(signal.aborted && err === signal.reason)) throw err;
      outcome = CANCELLED;
    } finally {
      await flow.end();
    }
    // After the popup has closed: a remembered skip is written now, and the host shows the one line.
    return closing(outcome);
  }
  return { run };
}
