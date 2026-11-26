/**
 * The consent and keychain steps of the provider setup (MVP-11 unit 6, A3): the environment-key consent and its publication, the starter default
 * a granted source chooses, and the keychain step (retry, the remembered reminder). They were closures of the coordinator's one long `run`,
 * sharing its state silently; here every step reads one explicit {@link SetupRun}, which the coordinator builds per run, so what a step may read
 * and change is named in one place. The coordinator (`provider-setup.ts`) keeps the list, the order of the steps, the key step and the endings.
 */

import type { ProviderId } from '@relavium/llm';

import { ConfigError } from '../config/errors.js';
import {
  ConfigWriteRefusedError,
  type ConfigWriteResult,
  type PreparedConfigWrite,
} from '../config/write.js';
import {
  KNOWN_PROVIDERS,
  providerKeyEnvVar,
  type ProviderKeyAvailability,
} from '../engine/providers.js';
import type { StandardEnvKeyPolicy } from '../engine/standard-env-policy.js';
import { scrubSetupText, type OnboardingDeps, type SetupPrompts } from '../onboarding/wizard.js';
import {
  SAVED_UNCONFIRMED,
  SETUP_NEXT_STEP,
  setupClosedNotice,
  type SetupSurface,
} from '../onboarding/setup-notes.js';
import {
  NATIVE_PROMPT_BACK,
  type NativePromptEscape,
  type NativePromptFlow,
  type NativePromptOption,
} from '../render/tui/native-prompt-channel.js';
import type { FramedDone } from './framed-flow.js';

export interface ProviderSetupOutcome {
  readonly status: 'ready' | 'cancelled' | 'deferred' | 'incomplete';
  readonly changed: boolean;
  /**
   * What the host says once the setup has closed: on a card the notice it keeps; in the popup ONE notification (a skip, a setup that could not
   * show its Done step), never a Home notice or a transcript line (ADR-0148 §6). Absent when the setup said everything itself.
   */
  readonly notice?: string;
}

/** One provider's key, as the setup sampled it. */
export interface Observation {
  readonly id: ProviderId;
  readonly availability: ProviderKeyAvailability;
}

/** A step back from a step that has one before it: the caller asks its own prompt again. */
export type Back = typeof NATIVE_PROMPT_BACK;

/**
 * How `Esc` leaves a step of the setup: `skip` on the automatic first run's step that has nothing before it (its step back IS the skip, and its
 * legend says `Esc skip for now`: ADR-0146 §6), `back` on a step reached from another (it returns there), `cancel` on a card (`Esc` leaves the
 * setup, as it always did).
 */
export type StepExit = 'skip' | 'back' | 'cancel';

/** The channel's `escape` of a step left by `exit`: the skip is a step back the caller reads as the skip. */
function escapeOf(exit: StepExit): NativePromptEscape {
  return exit === 'cancel' ? 'cancel' : 'back';
}

/** The prompts of a step left by `exit`: the first run's skip says so on its legend. */
function promptsOf(run: SetupRun, exit: StepExit): SetupPrompts {
  return exit === 'skip' ? run.skipPrompts : run.prompts;
}

/** The person left the setup (or it was stopped) with nothing granted. */
export const CANCELLED: ProviderSetupOutcome = { status: 'cancelled', changed: false };

/** What the setup says when a config cannot be written because it is a symbolic link (no writer follows one). */
const SYMLINK_NOTE =
  'Config is a symbolic link. Edit it manually or replace the link with a regular file.';

/** One run of the provider setup, as its consent and keychain steps read it: built by the coordinator for each run. */
export interface SetupRun {
  /** `automatic`: the first run that opened by itself; `explicit`: a `/providers` the person opened. */
  readonly mode: 'automatic' | 'explicit';
  /** No source was usable before this run: a granted source chooses the starter default. */
  readonly firstUsable: boolean;
  /** The automatic first run: the one that says how it ended (`Not now` says it opens again). */
  readonly firstRun: boolean;
  /** Drawn as the Home's popup (the guarded `Use it`, the popup's words); a card otherwise. */
  readonly popup: boolean;
  readonly surface: SetupSurface;
  /** The run's flow signal: aborted once the person left it or the host stopped it. */
  readonly signal: AbortSignal;
  /** The run's flow, for the notes of a step. */
  readonly flow: Pick<NativePromptFlow, 'note'>;
  /** The prompts of the popup's `Provider` step (the card's own flow on a card). */
  readonly prompts: SetupPrompts;
  /**
   * The same step's prompts where its `Esc` is the skip of the automatic first run ({@link StepExit} `skip`): their legend says `Esc skip for
   * now` (ADR-0146 §6). The card's own flow on a card, where they are never asked for.
   */
  readonly skipPrompts: SetupPrompts;
  /** The host's admission and the flow's signal: throws once the host stopped admitting or the flow was cancelled. */
  readonly admit: () => void;
  readonly policy: StandardEnvKeyPolicy;
  /** The global config writes of these steps, prepared against the host's target and published through the host's visible path. */
  readonly writes: {
    readonly consent: (id: ProviderId) => PreparedConfigWrite;
    readonly keychainAcknowledged: () => PreparedConfigWrite;
    readonly publish: (prepared: PreparedConfigWrite) => Promise<ConfigWriteResult>;
    readonly writeDefaultModel: OnboardingDeps['writeDefaultModel'];
  };
  /**
   * The popup's Done step of a run that ends with NO key entered (a source granted, a keychain remembered): its rail draws the `Key` step as
   * not done. When the flow was already cancelled, the line the host shows instead; a card keeps its notice.
   */
  readonly finish: (
    outcome: ProviderSetupOutcome,
    done: FramedDone,
    interrupted: string,
  ) => Promise<ProviderSetupOutcome>;
  /** The key step (the native setup), for one provider or the list; `exit` is how the step it opens is left (default: back to this one). */
  readonly manual: (id?: ProviderId, exit?: StepExit) => Promise<ProviderSetupOutcome | Back>;
  /** Whether the keychain was found unavailable in the latest sample. */
  readonly keychainDown: () => boolean;
  /** Sample every provider's key again (`Retry keychain`), and keep the sample for the run. */
  readonly resample: () => readonly Observation[];
  /** The remembered keychain reminder, shared by every run of the coordinator. */
  readonly reminder: { acknowledged: boolean };
}

/**
 * The environment-key consent of the popup (ADR-0146 §6, G15): it names the variable, the provider and (on a first run, where a default is
 * chosen) the model, and that the choice is saved to the global config. Every value is scrubbed by the caller.
 */
export function consentMessage(variable: string, provider: string, model?: string): string {
  const use = model === undefined ? 'Use it?' : `Use it, with ${model} as your default model?`;
  return `${variable} is set for ${provider}. ${use} Saved to your global config; the variable stays yours.`;
}

/** What the consent asks: the popup's sentence of scrubbed parts (naming the model only where one will be chosen), or the card's question. */
function consentText(run: SetupRun, id: ProviderId, source: string): string {
  if (!run.popup)
    return `${source} is available for ${KNOWN_PROVIDERS[id].displayName}. Allow this source?`;
  const model = run.firstUsable ? scrubSetupText(KNOWN_PROVIDERS[id].starterModel) : undefined;
  return consentMessage(
    scrubSetupText(source),
    scrubSetupText(KNOWN_PROVIDERS[id].displayName),
    model,
  );
}

/**
 * An environment key that is present and not yet allowed: a consent (ADR-0146 §6). The card opens on `Not now`, the LAST row, so an `Enter`
 * already on its way never grants a source of credentials; in the popup `Use it` is also GUARDED (the approval card's input layers, ADR-0148
 * §3): `Enter` on it counts only from a frame the person was shown, after the lockout that runs from the moment the select appeared.
 */
export async function consent(
  run: SetupRun,
  id: ProviderId,
  source: string,
  exit: StepExit,
): Promise<ProviderSetupOutcome | Back> {
  for (;;) {
    const answer = await promptsOf(run, exit).select({
      message: consentText(run, id, source),
      initialValue: 'defer',
      options: [
        { value: 'use', label: 'Use it', ...(run.popup ? { guarded: true as const } : {}) },
        // A key typed while the keychain is down would be checked against the provider and then lost (G19), so it is not offered.
        ...(run.keychainDown() ? [] : [{ value: 'manual', label: 'Enter a different key' }]),
        { value: 'defer', label: 'Not now' },
      ],
      escape: escapeOf(exit),
    });
    if (answer === 'manual' && !run.signal.aborted) {
      const keyed = await run.manual(id);
      // `Esc` from the key step: back to this consent on a first run; back to the list from `/providers`.
      if (keyed === NATIVE_PROMPT_BACK && run.mode === 'automatic') continue;
      return keyed;
    }
    return await settleConsent(run, id, source, answer);
  }
}

/** Every answer to the consent but `Enter a different key`: a step back, a way out, `Not now`, or `Use it`. */
async function settleConsent(
  run: SetupRun,
  id: ProviderId,
  source: string,
  answer: string | symbol,
): Promise<ProviderSetupOutcome | Back> {
  if (answer === NATIVE_PROMPT_BACK) {
    // On the first run this step back is the skip: the source is declined for the process, as any way out of the consent declines it.
    if (run.mode === 'automatic') run.policy.defer(id);
    return NATIVE_PROMPT_BACK;
  }
  if (typeof answer !== 'string' || run.signal.aborted) {
    run.policy.defer(id);
    return CANCELLED;
  }
  if (answer !== 'use') {
    run.policy.defer(id);
    // `Not now` is remembered for the process only (OD-23): the automatic first run says it opens again next launch.
    return {
      status: 'deferred',
      changed: false,
      ...(run.firstRun ? { notice: setupClosedNotice(run.surface) } : {}),
    };
  }
  return await publishConsent(run, id, source);
}

/** The config write failed in a way the person can be asked about (an unreadable or unwritable config, or a symbolic link). */
function isConfigFault(err: unknown): err is ConfigError | ConfigWriteRefusedError {
  return err instanceof ConfigError || err instanceof ConfigWriteRefusedError;
}

/** Publish a granted consent; a write failure keeps the recovery choices it always had. */
async function publishConsent(
  run: SetupRun,
  id: ProviderId,
  source: string,
): Promise<ProviderSetupOutcome> {
  for (;;) {
    try {
      run.admit();
      const result = await run.writes.publish(run.writes.consent(id));
      // The publisher resolves only after rename. Do not recheck cancellation after publication.
      run.policy.allowForInvocation(id);
      return await grantOutcome(
        run,
        id,
        source,
        result.durability === 'unconfirmed' ? 'unconfirmed' : 'saved',
      );
    } catch (err) {
      const recovered = await recoverConsent(run, id, source, err);
      if (recovered !== 'retry') return recovered;
    }
  }
}

/** The consent's publication threw: a cancellation declines the source; a config fault asks how to continue; anything else is rethrown. */
async function recoverConsent(
  run: SetupRun,
  id: ProviderId,
  source: string,
  err: unknown,
): Promise<ProviderSetupOutcome | 'retry'> {
  if (run.signal.aborted) {
    if (err !== run.signal.reason) throw err;
    run.policy.defer(id);
    return CANCELLED;
  }
  if (!isConfigFault(err)) throw err;
  const refused = err instanceof ConfigWriteRefusedError;
  run.flow.note(refused ? SYMLINK_NOTE : 'Could not save source consent.');
  const recovery = await run.prompts.select({
    message: 'How would you like to continue?',
    options: [
      ...(refused ? [] : [{ value: 'retry', label: 'Retry saving' }]),
      // One spelling for the two recovery cards that can follow each other, each naming what it uses: this one the source (the variable), the
      // starter-default card the model. Without `Retry saving` it is the FIRST row, which a held `Enter` that answered `Use it` would answer
      // next: in the popup it is guarded too (6.1 security sitting).
      {
        value: 'once',
        label: `Use ${source} for this invocation only`,
        ...(run.popup && refused ? { guarded: true as const } : {}),
      },
      { value: 'cancel', label: 'Cancel' },
    ],
  });
  return await afterRecovery(run, id, source, recovery);
}

/** The answer to the recovery after a failed consent write: decline, the source for this invocation only, or try the write again. */
async function afterRecovery(
  run: SetupRun,
  id: ProviderId,
  source: string,
  recovery: string | symbol,
): Promise<ProviderSetupOutcome | 'retry'> {
  if (typeof recovery !== 'string' || run.signal.aborted || recovery === 'cancel') {
    run.policy.defer(id);
    return CANCELLED;
  }
  if (recovery === 'once') {
    run.admit();
    run.policy.allowForInvocation(id);
    return await grantOutcome(run, id, source, 'once');
  }
  return recovery === 'retry' ? 'retry' : CANCELLED;
}

/** How a source was granted: saved to the global config (its durability confirmed or not), or for this invocation only. */
type Granted = 'saved' | 'unconfirmed' | 'once';

/** What the grant says: the card's notice, and the Done step's lines about the source. */
const GRANT_WORDS: Record<Granted, { readonly notice: string; readonly lines: readonly string[] }> =
  {
    saved: {
      notice: 'Source consent saved.',
      lines: ['Saved to your global config; the variable stays yours.'],
    },
    unconfirmed: {
      notice: SAVED_UNCONFIRMED,
      lines: ['Saved to your global config; the variable stays yours.', SAVED_UNCONFIRMED],
    },
    once: {
      notice: 'Source allowed for this invocation only.',
      lines: ['Allowed for this invocation only; the consent was not saved.'],
    },
  };

/** What the starter default's write came to, as one word the table below is keyed by. */
type StarterWrite = 'saved' | 'unconfirmed' | 'ephemeral' | 'cancelled' | 'unknown';

function starterWrite(result: unknown): StarterWrite {
  if (typeof result !== 'object' || result === null || !('kind' in result)) return 'unknown';
  if (result.kind === 'ephemeral' || result.kind === 'cancelled') return result.kind;
  if (result.kind !== 'saved' || !('durability' in result)) return 'unknown';
  return result.durability === 'unconfirmed' ? 'unconfirmed' : 'saved';
}

/**
 * What the card's notice adds and what the Done step says about the starter default, by its write (`named`: the Done sentence names the model).
 * `failed` is a write that threw a config fault (or was cancelled).
 */
const STARTER_GRANT: Record<
  StarterWrite | 'failed',
  (model: string) => {
    readonly notice: string;
    readonly named: boolean;
    readonly lines: readonly string[];
  }
> = {
  saved: () => ({
    notice: 'Starter default saved. Project settings may override it.',
    named: true,
    lines: [SETUP_NEXT_STEP],
  }),
  unconfirmed: () => ({
    notice:
      'Starter default saved; crash persistence is unconfirmed. Project settings may override it.',
    named: true,
    lines: [
      'The default model was saved, but persistence after a crash is unconfirmed.',
      SETUP_NEXT_STEP,
    ],
  }),
  ephemeral: (model) => ({
    notice: 'Starter model selected for this invocation only.',
    named: true,
    lines: [`${model} is selected for this invocation only; the default was not saved.`],
  }),
  cancelled: () => ({
    notice: 'Starter default was not saved.',
    named: false,
    lines: ['The starter default was not saved. Choose a model with /models.'],
  }),
  unknown: () => ({
    notice: 'Check the starter model with /models.',
    named: false,
    lines: ['Check the starter model with /models.'],
  }),
  failed: () => ({
    notice: 'Starter default could not be saved; select a model with /models.',
    named: false,
    lines: ['The starter default could not be saved; select a model with /models.'],
  }),
};

/** The starter default after a granted source, and what the setup says about both. */
async function grantOutcome(
  run: SetupRun,
  id: ProviderId,
  source: string,
  granted: Granted,
): Promise<ProviderSetupOutcome> {
  const words = GRANT_WORDS[granted];
  const variable = scrubSetupText(source);
  const model = scrubSetupText(KNOWN_PROVIDERS[id].starterModel);
  const head = `Using ${variable} · ${scrubSetupText(KNOWN_PROVIDERS[id].displayName)}`;
  const interrupted = `${variable} allowed · the default was not saved`;
  const end = (starter?: StarterWrite | 'failed'): Promise<ProviderSetupOutcome> => {
    const said = starter === undefined ? undefined : STARTER_GRANT[starter](model);
    return run.finish(
      {
        status: 'ready',
        changed: true,
        notice: said === undefined ? words.notice : `${words.notice} ${said.notice}`,
      },
      {
        message: said?.named === true ? `${head} · ${model}` : head,
        lines: [...words.lines, ...(said?.lines ?? [])],
      },
      interrupted,
    );
  };
  if (!run.firstUsable || run.signal.aborted) return end();
  try {
    run.admit();
    const result: unknown = await run.writes.writeDefaultModel(
      KNOWN_PROVIDERS[id].starterModel,
      id,
      run.admit,
    );
    return await end(starterWrite(result));
  } catch (err) {
    if (run.signal.aborted ? err !== run.signal.reason : !isConfigFault(err)) throw err;
    return await end('failed');
  }
}

/**
 * The keychain is known to be unavailable, so a key typed now would be checked against the provider and then lost: `Enter a key` is not
 * offered (ADR-0146 §6). The way to use a key anyway is the environment variable, named once as a variable name, and what `Remember this`
 * remembers is said where it is offered.
 */
export async function unavailable(
  run: SetupRun,
  id: ProviderId,
  exit: StepExit,
): Promise<ProviderSetupOutcome | Back> {
  for (;;) {
    const answer = await promptsOf(run, exit).select({
      message:
        'The OS keychain is unavailable, so a key cannot be stored. ' +
        `To use one anyway, set ${providerKeyEnvVar(id)} in the environment before starting Relavium.`,
      options: keychainOptions(run.reminder.acknowledged),
      escape: escapeOf(exit),
    });
    const next = await afterKeychainAnswer(run, id, answer, exit);
    if (next !== undefined) return next;
  }
}

/** The keychain step's rows: `Retry keychain`, the reminder (until it is remembered), `Not now`. */
function keychainOptions(acknowledged: boolean): readonly NativePromptOption[] {
  return [
    { value: 'retry', label: 'Retry keychain' },
    ...(acknowledged
      ? []
      : [
          {
            value: 'ack',
            label: 'Remember this and continue without a key',
            hint: 'remembers in your global config that the OS keychain is unavailable',
          },
        ]),
    { value: 'cancel', label: 'Not now' },
  ];
}

/** What one answer to the keychain step comes to; `undefined` to ask it again. */
async function afterKeychainAnswer(
  run: SetupRun,
  id: ProviderId,
  answer: string | symbol,
  exit: StepExit,
): Promise<ProviderSetupOutcome | Back | undefined> {
  if (answer === NATIVE_PROMPT_BACK) return NATIVE_PROMPT_BACK;
  if (typeof answer !== 'string' || run.signal.aborted || answer === 'cancel') return CANCELLED;
  if (answer === 'retry') return await retryKeychain(run, id, exit);
  if (answer !== 'ack' || run.reminder.acknowledged) return CANCELLED;
  return await rememberKeychain(run);
}

/** `Retry keychain`: sample again; what the keychain step does next, or `undefined` to ask it again. */
async function retryKeychain(
  run: SetupRun,
  id: ProviderId,
  exit: StepExit,
): Promise<ProviderSetupOutcome | Back | undefined> {
  run.admit();
  const observations = run.resample();
  if (observations.some(({ availability }) => availability.status === 'usable'))
    return { status: 'ready', changed: false };
  const pending = observations.find(
    ({ availability }) => availability.status === 'present-standard-not-allowed',
  );
  // A step back from what follows returns to the keychain step on a first run, and to the list from `/providers`.
  const stepBack = (
    outcome: ProviderSetupOutcome | Back,
  ): ProviderSetupOutcome | Back | undefined =>
    outcome === NATIVE_PROMPT_BACK && run.mode === 'automatic' ? undefined : outcome;
  // What follows is reached from the keychain step, so its `Esc` returns there: never the skip, even on the first run.
  const onward: StepExit = exit === 'cancel' ? 'cancel' : 'back';
  if (pending?.availability.status === 'present-standard-not-allowed')
    return stepBack(await consent(run, pending.id, pending.availability.source.name, onward));
  if (!run.keychainDown()) return stepBack(await run.manual(id));
  run.flow.note('The keychain is still unavailable.');
  return undefined;
}

/** Publish the keychain reminder; `undefined` when it failed in a way the keychain step is asked again for. */
async function rememberKeychain(run: SetupRun): Promise<ProviderSetupOutcome | undefined> {
  try {
    run.admit();
    const result = await run.writes.publish(run.writes.keychainAcknowledged());
    run.reminder.acknowledged = true;
    const unconfirmed = result.durability === 'unconfirmed';
    return await run.finish(
      {
        status: 'deferred',
        changed: true,
        notice: unconfirmed ? SAVED_UNCONFIRMED : 'Keychain reminder saved.',
      },
      {
        message: 'Remembered · the OS keychain is unavailable',
        lines: [
          'Saved to your global config; setup will not ask about it again by itself.',
          ...(unconfirmed ? [SAVED_UNCONFIRMED] : []),
          '/providers retries the keychain any time.',
        ],
      },
      'Keychain reminder saved',
    );
  } catch (err) {
    if (run.signal.aborted) {
      if (err !== run.signal.reason) throw err;
      return CANCELLED;
    }
    if (!isConfigFault(err)) throw err;
    const refused = err instanceof ConfigWriteRefusedError;
    run.flow.note(refused ? SYMLINK_NOTE : 'Could not save the keychain reminder.');
    return refused ? { status: 'incomplete', changed: false } : undefined;
  }
}
